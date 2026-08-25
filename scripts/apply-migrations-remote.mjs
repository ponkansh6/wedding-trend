/**
 * リモート DB（Turso）へマイグレーションを **追加専用** で適用する。
 *
 * `drizzle-kit push` を使わない理由:
 * push はスキーマ定義に存在しないテーブル・カラムを削除対象として扱う。
 * この DB は他プロジェクト（news-watch）と共有しているため、push すると
 * 相手のテーブルが丸ごと削除される。実際に共有先には articles / knowledge
 * など 9 テーブル・数百行のデータが存在する。
 *
 * そのため本スクリプトは安全装置として、所有権ベースの検査を行う
 * （`scripts/migrations-additive.mjs` 参照）:
 *   - CREATE TABLE / CREATE INDEX / 所有テーブルへの単純な ALTER TABLE ...
 *     ADD COLUMN 以外の文を実行拒否する
 *   - denylist（news-watch 所有と判明しているテーブル）と衝突する
 *     CREATE TABLE / CREATE INDEX / ALTER TABLE は事前検査で拒否する
 *   - 自プロジェクト所有テーブルの再作成（適用済みマイグレーションの
 *     再実行）は "already exists" として読み飛ばす
 * を守る。DROP / DELETE / UPDATE、denylist テーブルへの操作、非所有
 * テーブルへの CREATE/ALTER を含む文が現れた時点で異常終了する。
 *
 * 使い方:
 *   node scripts/apply-migrations-remote.mjs          # dry-run（実行計画のみ表示）
 *   node scripts/apply-migrations-remote.mjs --apply  # 実際に適用
 */
import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import {
  loadMigrationStatements,
  findNonAdditiveStatements,
  extractCreatedName,
  loadOwnedTables,
  EXTERNAL_DENYLIST,
} from "./migrations-additive.mjs";

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

const ownedTables = loadOwnedTables();
const entries = loadMigrationStatements();
const violations = findNonAdditiveStatements(entries, ownedTables);
if (violations.length > 0) {
  const { file, statement, verdict } = violations[0];
  console.error(
    `\n❌ 所有権を守らない文を検出しました。中止します。\n   ファイル: ${file}\n   理由: ${verdict.reason}\n   文: ${statement.slice(0, 200)}`,
  );
  process.exit(1);
}
const plan = entries;

console.log(`接続先スキーム: ${url.split(":")[0]}`);
console.log(`実行計画（${plan.length} 文、すべて所有権を満たす）:`);
for (const { file, label } of plan) console.log(`  [${file}] ${label}`);

const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

// --- 名前衝突の事前検査（所有権ベース・厳格化） ---
// 本番 DB は他プロジェクト（news-watch）と単一のスキーマ名前空間（テーブル名・
// インデックス名）を共有している。applier は既存オブジェクトを "already exists"
// として黙って読み飛ばすため、事前に denylist（news-watch 所有と判明している
// テーブル）と衝突する CREATE/ALTER が計画に含まれていないかを検査する。
// これは通常 findNonAdditiveStatements の所有権検査で既に弾かれているはずだが、
// 「適用直前の本番 DB の実態」との突き合わせとして二重に検査する
// （schema.ts のみからの静的判定と、実際の sqlite_master の状態は独立した
// 情報源であるため、片方の見落としがもう片方で拾えることがある）。
//
// 自プロジェクト所有テーブルとの同名衝突（= 適用済みマイグレーションの
// 再実行）は、既存のとおり "already exists" として読み飛ばしてよい。
const existing = await client.execute(
  "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
);
const existingNames = new Set(
  existing.rows.filter((r) => r.type === "table" || r.type === "index").map((r) => String(r.name)),
);

const denylistCollisions = [];
for (const { file, statement } of plan) {
  const created = extractCreatedName(statement);
  if (created && EXTERNAL_DENYLIST.has(created.name) && existingNames.has(created.name)) {
    denylistCollisions.push({ file, ...created });
  }
}

if (denylistCollisions.length > 0) {
  console.error(
    `\n❌ 本番 DB に存在する他プロジェクト（news-watch）所有のオブジェクトと衝突しています（${denylistCollisions.length} 件）。中止します。`,
  );
  for (const { file, type, name } of denylistCollisions) {
    console.error(`   [${file}] ${type}: ${name}`);
  }
  process.exit(1);
}

if (!APPLY) {
  console.log("\ndry-run です。適用するには --apply を付けて再実行してください。");
  process.exit(0);
}

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
    if (/already exists|duplicate column name/i.test(message)) {
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
