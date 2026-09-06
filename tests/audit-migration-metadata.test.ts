import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

describe("audit-migration-metadata script negative test", () => {
  it("detects missing journal entries or files using temp fixture tree", () => {
    // Create a temporary directory structure mimicking src/lib/db/migrations
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-audit-"));
    const migrationsDir = path.join(tmpDir, "src", "lib", "db", "migrations");
    const metaDir = path.join(migrationsDir, "meta");
    fs.mkdirSync(metaDir, { recursive: true });

    // Create a dummy migration .sql file
    fs.writeFileSync(path.join(migrationsDir, "0000_init.sql"), "SELECT 1;\n");
    // Create a snapshot json
    fs.writeFileSync(path.join(metaDir, "0000_init.json"), "{}");
    // Create _journal.json WITHOUT the entry for 0000_init, introducing drift/missing journal entry
    const journal = {
      version: "7",
      dialect: "sqlite",
      entries: [],
    };
    fs.writeFileSync(path.join(metaDir, "_journal.json"), JSON.stringify(journal));

    // Path to the audit script
    const scriptPath = path.resolve("scripts/gates/audit-migration-metadata.mjs");

    // The script hardcodes const migrationsDir = path.resolve("src/lib/db/migrations");
    // So to test it using fixtures, we run it with cwd set to tmpDir.
    let errorCaught = false;
    try {
      execFileSync(process.execPath, [scriptPath], {
        cwd: tmpDir,
        encoding: "utf8",
      });
    } catch (err: any) {
      errorCaught = true;
      expect(err.status).toBe(1);
      expect(err.stdout).toContain("0000_init.sql");
      expect(err.stdout).toContain("MISSING");
    }
    expect(errorCaught).toBe(true);
  });

  it("succeeds with exit 0 when migration metadata is fully consistent", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-audit-ok-"));
    const migrationsDir = path.join(tmpDir, "src", "lib", "db", "migrations");
    const metaDir = path.join(migrationsDir, "meta");
    fs.mkdirSync(metaDir, { recursive: true });

    fs.writeFileSync(path.join(migrationsDir, "0000_init.sql"), "SELECT 1;\n");
    fs.writeFileSync(path.join(metaDir, "0000_init.json"), "{}");
    const journal = {
      version: "7",
      dialect: "sqlite",
      entries: [
        {
          idx: 0,
          version: "0000",
          when: 0,
          tag: "0000_init",
          breakpoints: true,
        },
      ],
    };
    fs.writeFileSync(path.join(metaDir, "_journal.json"), JSON.stringify(journal));

    const scriptPath = path.resolve("scripts/gates/audit-migration-metadata.mjs");
    const result = execFileSync(process.execPath, [scriptPath], {
      cwd: tmpDir,
      encoding: "utf8",
    });

    expect(result).toContain("0000_init.sql");
    expect(result).not.toContain("MISSING");
  });
});
