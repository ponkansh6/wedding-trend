#!/usr/bin/env tsx
/**
 * `posts.original_title` および `posts.ai_title` のタイトル正規化バックフィルスクリプト。
 *
 * 背景:
 * タイトル内の不要な改行や空白をデータ取得段階で正規化するため `normalizeTitle()`
 * （src/lib/sources/base/feed-parser.ts）が導入されたが、既存の DB 行には
 * 過去に収集・生成された未正規化のタイトルが残っている可能性がある。
 * このスクリプトは既存行のタイトルを `normalizeTitle()` で再処理し、
 * 差分がある行を更新する。
 *
 * ロジックは複製しない:
 * タイトル正規化は src/lib/sources/base/feed-parser.ts の `normalizeTitle()` を
 * そのまま importして使う。
 *
 * 対象カラム:
 * - `posts.original_title`
 * - `posts.ai_title` (存在する場合)
 *
 * 使い方:
 *   pnpm exec tsx scripts/ops/backfill-title-normalization.mjs          # dry-run（既定・書き込みなし）
 *   pnpm exec tsx scripts/ops/backfill-title-normalization.mjs --apply  # 実際に DB を更新する
 *
 * 冪等性:
 * 既に正規化済みの行（`normalizeTitle(val) === val`）は対象外になるため、
 * 再実行しても何も変更されない。
 */
import { existsSync, readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");

// .env.local の簡易パーサ
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

const { db } = await import("../../src/lib/db/index.ts");
const { posts } = await import("../../src/lib/db/schema.ts");
const { eq } = await import("drizzle-orm");
const { normalizeTitle } = await import("../../src/lib/sources/base/feed-parser.ts");

console.log(`接続先スキーム: ${(process.env.TURSO_DATABASE_URL ?? "local sqlite").split(":")[0]}`);
console.log(APPLY ? "モード: --apply（DB を更新します）" : "モード: dry-run（書き込みなし）");

// 全件取得または対象絞り込み
// posts テーブルの id, original_title, ai_title を取得
const allPosts = await db
  .select({
    id: posts.id,
    originalTitle: posts.originalTitle,
    aiTitle: posts.aiTitle,
  })
  .from(posts);

console.log(`総投稿件数: ${allPosts.length}`);

let updatedOriginalCount = 0;
let updatedAiCount = 0;
let skippedCount = 0;

for (const row of allPosts) {
  let needsUpdate = false;
  const updates = {};

  // 1. originalTitle のチェック
  if (row.originalTitle != null) {
    const normalizedOriginal = normalizeTitle(row.originalTitle);
    if (normalizedOriginal !== row.originalTitle) {
      updates.originalTitle = normalizedOriginal;
      needsUpdate = true;
      updatedOriginalCount++;
      console.log(`\n[originalTitle 差分検出] post_id=${row.id}`);
      console.log(`  変更前: JSON.stringify(${JSON.stringify(row.originalTitle)})`);
      console.log(`  変更後: JSON.stringify(${JSON.stringify(normalizedOriginal)})`);
    }
  }

  // 2. aiTitle のチェック（null でない場合のみ）
  if (row.aiTitle != null) {
    const normalizedAi = normalizeTitle(row.aiTitle);
    if (normalizedAi !== row.aiTitle) {
      updates.aiTitle = normalizedAi;
      needsUpdate = true;
      updatedAiCount++;
      console.log(`\n[aiTitle 差分検出] post_id=${row.id}`);
      console.log(`  変更前: JSON.stringify(${JSON.stringify(row.aiTitle)})`);
      console.log(`  変更後: JSON.stringify(${JSON.stringify(normalizedAi)})`);
    }
  }

  if (needsUpdate) {
    if (APPLY) {
      await db.update(posts).set(updates).where(eq(posts.id, row.id));
    }
  } else {
    skippedCount++;
  }
}

console.log("\n=== サマリ ===");
console.log(`総投稿件数: ${allPosts.length} 件`);
console.log(`original_title 更新見込み: ${updatedOriginalCount} 件`);
console.log(`ai_title 更新見込み: ${updatedAiCount} 件`);
console.log(`変更なし（スキップ）: ${skippedCount} 件`);
console.log(
  `実行モード: ${APPLY ? "適用済み (--apply)" : "dry-run（実際には書き込んでいません）"}`,
);

if (!APPLY) {
  console.log("\ndry-run です。実際に DB を更新するには --apply を付けて再実行してください。");
}
