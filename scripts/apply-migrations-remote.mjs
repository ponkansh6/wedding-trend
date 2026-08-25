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
import { readFileSync, existsSync } from "node:fs";
import {
  loadMigrationStatements,
  findNonAdditiveStatements,
  extractCreatedName,
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

const entries = loadMigrationStatements();
const violations = findNonAdditiveStatements(entries);
if (violations.length > 0) {
  const { file, statement } = violations[0];
  console.error(
    `\n❌ 追加専用ではない文を検出しました。中止します。\n   ファイル: ${file}\n   文: ${statement.slice(0, 200)}`,
  );
  process.exit(1);
}
const plan = entries;

console.log(`接続先スキーム: ${url.split(":")[0]}`);
console.log(`実行計画（${plan.length} 文、すべて追加専用）:`);
for (const { file, label } of plan) console.log(`  [${file}] ${label}`);

const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

// --- 名前衝突の事前検査 ---
// 本番 DB は他プロジェクト（news-watch）と単一のスキーマ名前空間（テーブル名・
// インデックス名）を共有している。applier は既存オブジェクトを "already exists"
// として黙って読み飛ばすため、同名オブジェクトが既に存在する場合、それが
// 「このプロジェクトが過去に作ったもの」なのか「他プロジェクトのもの」なのかを
// 見分けずに読み飛ばしてしまうと、意図せず他プロジェクトのテーブル/インデックスを
// 読み書きし始める危険がある。
//
// 限界: 名前だけでは「自分が過去に作ったもの」と「他プロジェクトのもの」を
// 判別できない（両者は sqlite_master 上で区別不能）。したがって、ここでは
// 自動判定して中止する、という強い制御はしない。衝突候補を列挙して人間の目視
// 確認を促すに留める。誤って自動 skip 実装に倒すと、確認なしに他プロジェクトの
// テーブルへ書き込む事故を防げなくなる。
const existing = await client.execute(
  "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
);
const existingNames = new Set(
  existing.rows.filter((r) => r.type === "table" || r.type === "index").map((r) => String(r.name)),
);

const collisions = [];
for (const { file, statement } of plan) {
  const created = extractCreatedName(statement);
  if (created && existingNames.has(created.name)) {
    collisions.push({ file, ...created });
  }
}

if (collisions.length > 0) {
  console.log(
    `\n⚠️  本番 DB に同名の ${collisions[0].type === "table" ? "テーブル/インデックス" : "オブジェクト"}が既に存在します（衝突候補、${collisions.length} 件）:`,
  );
  for (const { file, type, name } of collisions) {
    console.log(`  [${file}] ${type}: ${name}`);
  }
  console.log(
    "   → このプロジェクトが過去に作成したものか、news-watch など他プロジェクトのものかを名前だけでは判別できません。\n" +
      "     適用前に必ず目視で確認してください（このスクリプトは自動判定しません）。",
  );
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
