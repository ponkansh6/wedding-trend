import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SQL_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MANAGED_MIGRATION_UPPER_BOUND = 2;
const JOURNAL_FIELDS = new Set(["version", "dialect", "entries"]);
const JOURNAL_ENTRY_FIELDS = new Set(["idx", "version", "when", "tag", "breakpoints"]);
const MANIFEST_FIELDS = new Set(["version", "migrations"]);
const MANIFEST_ENTRY_FIELDS = new Set(["file", "sha256", "reason"]);

function addError(errors, message) {
  errors.push(message);
}

function readJson(file, errors, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    addError(errors, `${label}: ${error.message}`);
    return null;
  }
}

function checksum(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function getRoot() {
  const args = process.argv.slice(2);
  if (args.length === 0) return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  if (args.length === 2 && args[0] === "--root" && args[1]) return path.resolve(args[1]);
  throw new Error("usage: audit-migration-metadata.mjs [--root <repository-root>]");
}

function validateManualManifest(file, errors) {
  const manifest = readJson(file, errors, "manual manifest");
  const manuals = new Map();
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return manuals;
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_FIELDS.has(key)) addError(errors, `manual manifest: unknown field ${key}`);
  }
  if (manifest.version !== 1) addError(errors, "manual manifest: version must be 1");
  if (!Array.isArray(manifest.migrations)) {
    addError(errors, "manual manifest: migrations must be an array");
    return manuals;
  }
  for (const entry of manifest.migrations) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      addError(errors, "manual manifest: migration entry must be an object");
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!MANIFEST_ENTRY_FIELDS.has(key))
        addError(errors, `manual manifest: unknown migration field ${key}`);
    }
    if (typeof entry.file !== "string" || !SQL_NAME.test(entry.file))
      addError(errors, "manual manifest: invalid file");
    if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256))
      addError(errors, `manual manifest: invalid sha256 for ${entry.file}`);
    if (typeof entry.reason !== "string" || !entry.reason.trim())
      addError(errors, `manual manifest: empty reason for ${entry.file}`);
    if (manuals.has(entry.file)) addError(errors, `manual manifest: duplicate entry ${entry.file}`);
    manuals.set(entry.file, entry);
  }
  return manuals;
}

function validateJournal(file, errors) {
  const journal = readJson(file, errors, "journal");
  const managed = new Set();
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) return managed;
  for (const key of Object.keys(journal)) {
    if (!JOURNAL_FIELDS.has(key)) addError(errors, `journal: unknown field ${key}`);
  }
  if (typeof journal.version !== "string") addError(errors, "journal: version must be a string");
  if (typeof journal.dialect !== "string") addError(errors, "journal: dialect must be a string");
  if (!Array.isArray(journal.entries)) {
    addError(errors, "journal: entries must be an array");
    return managed;
  }
  for (let index = 0; index < journal.entries.length; index += 1) {
    const entry = journal.entries[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      addError(errors, "journal: entry must be an object");
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!JOURNAL_ENTRY_FIELDS.has(key)) addError(errors, `journal: unknown entry field ${key}`);
    }
    if (!Number.isInteger(entry.idx) || entry.idx !== index)
      addError(errors, `journal: idx must be contiguous at ${index}`);
    if (typeof entry.version !== "string")
      addError(errors, `journal: version must be a string at ${index}`);
    if (typeof entry.when !== "number")
      addError(errors, `journal: when must be a number at ${index}`);
    if (typeof entry.breakpoints !== "boolean")
      addError(errors, `journal: breakpoints must be a boolean at ${index}`);
    if (typeof entry.tag !== "string" || !SQL_NAME.test(`${entry.tag}.sql`)) {
      addError(errors, `journal: invalid tag at ${index}`);
      continue;
    }
    const file = `${entry.tag}.sql`;
    if (Number(entry.tag.slice(0, 4)) !== index)
      addError(errors, `journal: tag sequence must be contiguous at ${index}`);
    if (Number(entry.tag.slice(0, 4)) > MANAGED_MIGRATION_UPPER_BOUND)
      addError(errors, `journal: managed migration exceeds 0002 ${file}`);
    if (managed.has(file)) addError(errors, `journal: duplicate entry ${file}`);
    managed.add(file);
  }
  return managed;
}

function main() {
  const errors = [];
  let root;
  try {
    root = getRoot();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  const migrationsDir = path.join(root, "src/lib/db/migrations");
  const metaDir = path.join(migrationsDir, "meta");
  const manualPath = path.join(metaDir, "manual-migrations.json");
  const journalPath = path.join(metaDir, "_journal.json");
  if (!fs.existsSync(manualPath)) addError(errors, "manual manifest is missing");
  if (!fs.existsSync(journalPath)) addError(errors, "journal is missing");
  const manuals = fs.existsSync(manualPath)
    ? validateManualManifest(manualPath, errors)
    : new Map();
  const managed = fs.existsSync(journalPath) ? validateJournal(journalPath, errors) : new Set();
  const sqlFiles = fs.existsSync(migrationsDir)
    ? fs
        .readdirSync(migrationsDir)
        .filter((file) => file.endsWith(".sql"))
        .sort()
    : [];
  const sqlByNumber = new Map();
  for (const file of sqlFiles) {
    const match = SQL_NAME.exec(file);
    if (!match) {
      addError(errors, `invalid SQL filename ${file}`);
      continue;
    }
    const number = Number(match[1]);
    if (sqlByNumber.has(number)) addError(errors, `duplicate migration number ${match[1]}`);
    sqlByNumber.set(number, file);
  }
  const numbers = [...sqlByNumber.keys()].sort((a, b) => a - b);
  for (let index = 0; index < numbers.length; index += 1) {
    if (numbers[index] !== index)
      addError(errors, `missing migration number ${String(index).padStart(4, "0")}`);
  }
  const snapshotFiles = fs.existsSync(metaDir)
    ? fs
        .readdirSync(metaDir)
        .filter(
          (file) =>
            file.endsWith(".json") && !["_journal.json", "manual-migrations.json"].includes(file),
        )
    : [];
  const expectedSnapshots = new Set(
    [...managed].map((file) => `${file.slice(0, 4)}_snapshot.json`),
  );
  for (const file of snapshotFiles) {
    if (!expectedSnapshots.has(file)) addError(errors, `unexpected or misnamed snapshot ${file}`);
    readJson(path.join(metaDir, file), errors, `snapshot ${file}`);
  }
  for (const file of expectedSnapshots) {
    if (!snapshotFiles.includes(file))
      addError(errors, `managed migration has no snapshot ${file.slice(0, 4)}`);
  }
  for (const file of managed)
    if (!sqlFiles.includes(file)) addError(errors, `journal entry has no SQL file ${file}`);
  for (const file of sqlFiles) {
    const isManaged = managed.has(file);
    const manual = manuals.get(file);
    if (isManaged === Boolean(manual))
      addError(errors, `migration must have exactly one classification ${file}`);
    if (manual && checksum(path.join(migrationsDir, file)) !== manual.sha256)
      addError(errors, `manual migration checksum mismatch ${file}`);
  }
  for (const file of manuals.keys())
    if (!sqlFiles.includes(file)) addError(errors, `manual migration does not exist ${file}`);
  if (errors.length) {
    console.error("Migration metadata audit failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Migration metadata audit passed (${managed.size} managed, ${manuals.size} manual).`,
    );
  }
}

main();
