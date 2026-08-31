#!/usr/bin/env tsx
/**
 * `post_rationales.rationale_text` の再生成用の使い捨てバックフィルスクリプト。
 *
 * 背景（2026-08-26）: `renderRationaleText()`（src/lib/publish/gate.ts）から
 * `promotional` の否定的ラベル「特定のサービス・会場への誘導を含む可能性がある」
 * を削除した（spec.md §10-3「否定的評価は公開画面に一切出さない」への準拠）。
 * しかし DB に既に保存済みの rationale_text にはこの文言が残っているため、
 * コード修正だけでは公開画面から消えない。このスクリプトで既存行を
 * renderRationaleText() の現行実装で再生成し、文言を除去する。
 *
 * ロジックは複製しない: 文面生成は src/lib/publish/gate.ts の
 * renderRationaleText() を、promotional の正規化は
 * src/lib/scoring/usefulness.ts の normalizePromotional() を、そのまま import
 * して使う。
 *
 * 使い方（pnpm 経由。npx/npm は使わない）:
 *   pnpm exec tsx scripts/ops/backfill-rationale-text.mjs          # dry-run（既定・書き込みなし）
 *   pnpm exec tsx scripts/ops/backfill-rationale-text.mjs --apply  # 実際に DB を更新する
 *
 * 対象: rationale_text に削除対象文言を含む post_rationales 行のみ。
 * 文言を含まない行は対象外になるため、二度実行しても安全（冪等）。
 */
import { existsSync, readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");

// .env.local の簡易パーサ（scripts/ops/apply-migrations-remote.mjs と同じ作法）。
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

// env を設定した後に import する（src/lib/db/index.ts はモジュール読み込み時に
// process.env を読んで接続を作るため）。
const { db } = await import("../../src/lib/db/index.ts");
const { postRationales, postUsefulnessCriteria } = await import("../../src/lib/db/schema.ts");
const { eq, like } = await import("drizzle-orm");
const { renderRationaleText } = await import("../../src/lib/publish/gate.ts");
const { normalizePromotional } = await import("../../src/lib/scoring/usefulness.ts");
const { RATIONALE_TEXT_MIN_CHARS, RATIONALE_TEXT_MAX_CHARS } =
  await import("../../src/lib/constants.ts");

const REMOVED_LABEL = "特定のサービス・会場への誘導を含む可能性がある";

console.log(`接続先スキーム: ${(process.env.TURSO_DATABASE_URL ?? "local sqlite").split(":")[0]}`);
console.log(APPLY ? "モード: --apply（DB を更新します）" : "モード: dry-run（書き込みなし）");

const targets = await db
  .select({
    postId: postRationales.postId,
    topicAnchor: postRationales.topicAnchor,
    rationaleText: postRationales.rationaleText,
  })
  .from(postRationales)
  .where(like(postRationales.rationaleText, `%${REMOVED_LABEL}%`));

console.log(`対象件数（削除対象文言を含む行）: ${targets.length}`);

let updated = 0;
let skipped = 0;
let errored = 0;
const warnings = [];

for (const row of targets) {
  const criteriaRow = await db
    .select({ criteriaJson: postUsefulnessCriteria.criteriaJson })
    .from(postUsefulnessCriteria)
    .where(eq(postUsefulnessCriteria.postId, row.postId))
    .limit(1);

  const criteriaJson = criteriaRow[0]?.criteriaJson;
  if (!criteriaJson) {
    skipped++;
    warnings.push(`post_id=${row.postId}: post_usefulness_criteria が見つからず skip`);
    continue;
  }

  let criteria;
  try {
    criteria = JSON.parse(criteriaJson);
  } catch (err) {
    skipped++;
    warnings.push(`post_id=${row.postId}: criteria_json のパースに失敗し skip (${err.message})`);
    continue;
  }

  let newText;
  try {
    newText = renderRationaleText({
      topicAnchor: row.topicAnchor,
      usefulness: {
        firsthand: Boolean(criteria.firsthand),
        ceremonyDecision: Boolean(criteria.ceremonyDecision),
        specific: Boolean(criteria.specific),
        tradeoff: Boolean(criteria.tradeoff),
        promotional: normalizePromotional(criteria.promotional),
        preDecisionOrPhotoShoot: Boolean(criteria.preDecisionOrPhotoShoot),
      },
    });
  } catch (err) {
    errored++;
    warnings.push(`post_id=${row.postId}: renderRationaleText() が例外 (${err.message})`);
    continue;
  }

  if (newText.length < RATIONALE_TEXT_MIN_CHARS || newText.length > RATIONALE_TEXT_MAX_CHARS) {
    errored++;
    warnings.push(
      `post_id=${row.postId}: 再生成後の長さ ${newText.length} が許容範囲外 ` +
        `(${RATIONALE_TEXT_MIN_CHARS}〜${RATIONALE_TEXT_MAX_CHARS}) のため skip`,
    );
    continue;
  }

  console.log(`\n--- post_id=${row.postId} ---`);
  console.log(`変更前: ${row.rationaleText}`);
  console.log(`変更後: ${newText}`);

  if (APPLY) {
    await db
      .update(postRationales)
      .set({ rationaleText: newText })
      .where(eq(postRationales.postId, row.postId));
  }
  updated++;
}

console.log("\n=== サマリ ===");
console.log(`対象: ${targets.length} 件`);
console.log(
  `更新: ${APPLY ? updated : 0} 件${APPLY ? "" : `（dry-run のため実際は 0、更新見込みは ${updated} 件）`}`,
);
console.log(`スキップ: ${skipped} 件`);
console.log(`エラー: ${errored} 件`);

if (warnings.length > 0) {
  console.log("\n--- 警告 ---");
  for (const w of warnings) console.log(`  - ${w}`);
}

if (!APPLY) {
  console.log("\ndry-run です。実際に DB を更新するには --apply を付けて再実行してください。");
}
