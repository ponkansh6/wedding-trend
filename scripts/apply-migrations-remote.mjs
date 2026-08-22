/**
 * リモート DB（Turso）へマイグレーションを **追加専用** で適用する。
 *
 * `drizzle-kit push` を使わない理由:
 * push はスキーマ定義に存在しないテーブル・カラムを削除対象として扱う。
 * この DB は他プロジェクト（news-watch）と共有しているため、push すると
 * 相手のテーブルが丸ごと削除される。実際に共有先には articles / knowledge
 * など 9 テーブル・数百行のデータが存在する。
 *
 * そのため本スクリプトは安全装置として、
 *   - CREATE TABLE / CREATE INDEX / CREATE UNIQUE INDEX 以外の文を実行拒否する
 *   - 既存テーブルは "already exists" として読み飛ばす
 * を守る。DROP / ALTER / DELETE / UPDATE を含む文が現れた時点で異常終了する。
 *
 * 使い方:
 *   node scripts/apply-migrations-remote.mjs          # dry-run（実行計画のみ表示）
 *   node scripts/apply-migrations-remote.mjs --apply  # 実際に適用
 */
import { createClient } from "@libsql/client";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const APPLY = process.argv.includes("--apply");

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error("TURSO_DATABASE_URL が未設定です");
  process.exit(1);
}

/** 追加専用として許可する文の形。これ以外は一切実行しない。 */
const ALLOWED = /^CREATE\s+(TABLE|UNIQUE\s+INDEX|INDEX)\b/i;

const dir = "src/lib/db/migrations";
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const plan = [];
for (const file of files) {
  const sql = readFileSync(path.join(dir, file), "utf-8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    if (!ALLOWED.test(statement)) {
      console.error(
        `\n❌ 追加専用ではない文を検出しました。中止します。\n   ファイル: ${file}\n   文: ${statement.slice(0, 200)}`,
      );
      process.exit(1);
    }
    const label = statement.split("\n")[0].slice(0, 90);
    plan.push({ file, statement, label });
  }
}

console.log(`接続先スキーム: ${url.split(":")[0]}`);
console.log(`実行計画（${plan.length} 文、すべて追加専用）:`);
for (const { file, label } of plan) console.log(`  [${file}] ${label}`);

if (!APPLY) {
  console.log("\ndry-run です。適用するには --apply を付けて再実行してください。");
  process.exit(0);
}

const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

const before = await client.execute(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
);
const beforeNames = before.rows.map((r) => String(r.name));
console.log(`\n適用前のテーブル (${beforeNames.length}):`, beforeNames.join(", "));

let applied = 0;
let skipped = 0;
for (const { file, statement, label } of plan) {
  try {
    await client.execute(statement);
    applied += 1;
    console.log(`  ✅ [${file}] ${label}`);
  } catch (err) {
    const message = String(err?.message ?? err);
    if (/already exists/i.test(message)) {
      skipped += 1;
      console.log(`  ⏭️  [${file}] ${label}  （既存のためスキップ）`);
      continue;
    }
    throw err;
  }
}

const after = await client.execute(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
);
const afterNames = after.rows.map((r) => String(r.name));
console.log(`\n適用後のテーブル (${afterNames.length}):`, afterNames.join(", "));

const removed = beforeNames.filter((n) => !afterNames.includes(n));
if (removed.length > 0) {
  console.error("❌ テーブルが消失しました:", removed.join(", "));
  process.exit(1);
}
console.log(`\n適用 ${applied} 文 / スキップ ${skipped} 文。既存テーブルの消失なし。`);
