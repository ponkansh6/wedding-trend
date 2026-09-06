import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve("scripts/gates/audit-migration-metadata.mjs");
const temporaryDirectories: string[] = [];
const hash = (content: string) => createHash("sha256").update(content).digest("hex");

function fixture(mutate?: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "migration-audit-"));
  temporaryDirectories.push(root);
  const migrations = path.join(root, "src/lib/db/migrations");
  const meta = path.join(migrations, "meta");
  fs.mkdirSync(meta, { recursive: true });
  const manual = "CREATE TABLE manual (id integer);\n";
  fs.writeFileSync(path.join(migrations, "0000_init.sql"), "CREATE TABLE managed (id integer);\n");
  fs.writeFileSync(path.join(migrations, "0001_manual.sql"), manual);
  fs.writeFileSync(path.join(meta, "0000_snapshot.json"), "{}");
  fs.writeFileSync(
    path.join(meta, "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: [{ idx: 0, version: "6", when: 0, tag: "0000_init", breakpoints: true }],
    }),
  );
  fs.writeFileSync(
    path.join(meta, "manual-migrations.json"),
    JSON.stringify({
      version: 1,
      migrations: [{ file: "0001_manual.sql", sha256: hash(manual), reason: "manual-additive" }],
    }),
  );
  mutate?.(root);
  return root;
}

function audit(root: string, cwd = root) {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, [script, "--root", root], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error: any) {
    return { status: error.status, output: `${error.stdout}${error.stderr}` };
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("audit-migration-metadata", () => {
  it("accepts a managed/manual hybrid", () => expect(audit(fixture()).status).toBe(0));
  it("uses --root independently of the current directory", () =>
    expect(audit(fixture(), os.tmpdir()).status).toBe(0));
  it("audits the repository from another current directory", () =>
    expect(audit(path.resolve("."), os.tmpdir()).status).toBe(0));
  it.each([
    [
      "unclassified migration",
      (root: string) =>
        fs.writeFileSync(path.join(root, "src/lib/db/migrations/0002_new.sql"), "SELECT 1;\n"),
    ],
    [
      "checksum change",
      (root: string) =>
        fs.appendFileSync(path.join(root, "src/lib/db/migrations/0001_manual.sql"), "-- changed\n"),
    ],
    [
      "malformed manifest",
      (root: string) =>
        fs.writeFileSync(path.join(root, "src/lib/db/migrations/meta/manual-migrations.json"), "{"),
    ],
    [
      "duplicate manifest entries",
      (root: string) => {
        const file = path.join(root, "src/lib/db/migrations/meta/manual-migrations.json");
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        data.migrations.push(data.migrations[0]);
        fs.writeFileSync(file, JSON.stringify(data));
      },
    ],
    [
      "unknown manifest field",
      (root: string) => {
        const file = path.join(root, "src/lib/db/migrations/meta/manual-migrations.json");
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        data.extra = true;
        fs.writeFileSync(file, JSON.stringify(data));
      },
    ],
    [
      "unknown manifest entry field",
      (root: string) => {
        const file = path.join(root, "src/lib/db/migrations/meta/manual-migrations.json");
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        data.migrations[0].extra = true;
        fs.writeFileSync(file, JSON.stringify(data));
      },
    ],
    [
      "missing manual SQL",
      (root: string) => fs.rmSync(path.join(root, "src/lib/db/migrations/0001_manual.sql")),
    ],
    [
      "double classification",
      (root: string) => {
        const file = path.join(root, "src/lib/db/migrations/meta/_journal.json");
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        data.entries.push({ tag: "0001_manual" });
        fs.writeFileSync(file, JSON.stringify(data));
      },
    ],
    [
      "managed snapshot missing",
      (root: string) => fs.rmSync(path.join(root, "src/lib/db/migrations/meta/0000_snapshot.json")),
    ],
    [
      "manual unexpected snapshot",
      (root: string) =>
        fs.writeFileSync(path.join(root, "src/lib/db/migrations/meta/0001_snapshot.json"), "{}"),
    ],
    [
      "journal unknown field",
      (root: string) => {
        const file = path.join(root, "src/lib/db/migrations/meta/_journal.json");
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        data.extra = true;
        fs.writeFileSync(file, JSON.stringify(data));
      },
    ],
    [
      "journal idx gap",
      (root: string) => {
        const file = path.join(root, "src/lib/db/migrations/meta/_journal.json");
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        data.entries[0].idx = 1;
        fs.writeFileSync(file, JSON.stringify(data));
      },
    ],
    [
      "misnamed snapshot",
      (root: string) => {
        const meta = path.join(root, "src/lib/db/migrations/meta");
        fs.renameSync(path.join(meta, "0000_snapshot.json"), path.join(meta, "0000_wrong.json"));
      },
    ],
    [
      "managed entry beyond the approved boundary",
      (root: string) => {
        const migrations = path.join(root, "src/lib/db/migrations");
        const meta = path.join(root, "src/lib/db/migrations/meta");
        const file = path.join(meta, "_journal.json");
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        const manifestFile = path.join(meta, "manual-migrations.json");
        const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
        const middle = "CREATE TABLE middle (id integer);\n";
        const tail = "CREATE TABLE tail (id integer);\n";
        fs.writeFileSync(path.join(migrations, "0002_middle.sql"), middle);
        fs.writeFileSync(path.join(migrations, "0003_tail.sql"), tail);
        manifest.migrations.push(
          { file: "0002_middle.sql", sha256: hash(middle), reason: "manual-additive" },
          { file: "0003_tail.sql", sha256: hash(tail), reason: "manual-additive" },
        );
        fs.writeFileSync(manifestFile, JSON.stringify(manifest));
        data.entries.push({
          idx: 1,
          version: "6",
          when: 1,
          tag: "0003_tail",
          breakpoints: true,
        });
        fs.writeFileSync(file, JSON.stringify(data));
        fs.writeFileSync(path.join(meta, "0003_snapshot.json"), "{}");
      },
    ],
  ])("rejects %s", (_label, mutate) => expect(audit(fixture(mutate)).status).toBe(1));
});
