import fs from "node:fs";
import path from "node:path";

const migrationsDir = path.resolve("src/lib/db/migrations");
const metaDir = path.join(migrationsDir, "meta");
const journalPath = path.join(metaDir, "_journal.json");

try {
  const sqlFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let journalEntries = [];
  if (fs.existsSync(journalPath)) {
    const journalData = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    journalEntries = (journalData.entries || []).map((e) => `${e.tag}.sql`);
  }

  const snapshotFiles = fs.existsSync(metaDir)
    ? fs.readdirSync(metaDir).filter((f) => f.endsWith(".json") && f !== "_journal.json")
    : [];

  const allNames = Array.from(new Set([...sqlFiles, ...journalEntries])).sort();

  console.log("Migration Audit Report:");
  console.log("------------------------------------------------------------");
  console.log(
    String("Filename").padEnd(35) +
      String("SQL").padEnd(10) +
      String("Journal").padEnd(10) +
      String("Snapshot"),
  );
  console.log("------------------------------------------------------------");

  let hasError = false;

  for (const name of allNames) {
    const hasSql = sqlFiles.includes(name);
    const hasJournal = journalEntries.includes(name);
    const tag = name.replace(/\.sql$/, "");
    const hasSnapshot = snapshotFiles.some((f) => f.startsWith(tag));

    if (!hasSql || !hasJournal || !hasSnapshot) {
      hasError = true;
    }

    console.log(
      String(name).padEnd(35) +
        String(hasSql ? "YES" : "MISSING").padEnd(10) +
        String(hasJournal ? "YES" : "MISSING").padEnd(10) +
        String(hasSnapshot ? "YES" : "MISSING"),
    );
  }
  console.log("------------------------------------------------------------");
  process.exit(hasError ? 1 : 0);
} catch (err) {
  console.error("IO Error:", err.message);
  process.exit(1);
}
