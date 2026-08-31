#!/usr/bin/env tsx
/**
 * discovery 経路（`posts.original_excerpt` が常に null。spec §10-5）で
 * **公開済み**の blog 投稿のうち、`curationSignature` が最新でないものだけを
 * 対象に、本文を規律付きで再取得 → 判定スライスをメモリ上で復元 →
 * 1 回の Gemini バッチリクエストで再キュレーション → `aiSummary` /
 * `category` / `tag` / `topicAnchor` / 有用度スコア / 署名を更新する
 * 使い捨てスクリプト。
 *
 * なぜ通常のバックフィル（`scripts/backfill-usefulness.mjs`）で直らないか:
 *   通常バックフィルはプレフライト `shouldRegenerateAnchor()` が「本文が無い」
 *   候補を一律スキップする。discovery 経路の投稿は `original_excerpt` が
 *   常に空なので永久にスキップされ、プロンプト/gate を改善しても
 *   旧基準のトピックアンカー（v1 の名詞句形式）のまま固定されてしまう。
 *
 * §10-5（抽出本文の永続化禁止）との関係:
 *   再取得した本文・判定スライスは LLM 入力としてのみ使い、DB・ログ・stdout の
 *   いずれにも書き出さない。`markCurated()` へ渡す前に
 *   `scripts/lib/mwed-anchor-backfill.mjs` の `assertNoSliceLeak()` で
 *   update オブジェクトのキーを許可リスト検証する（違反時は throw して中断）。
 *   プレビュー出力はトピックアンカーの新旧のみで、本文は一切表示しない。
 *
 * 触らないもの: `originalTitle`（spec の「取得済み投稿のタイトルはバックフィル
 *   しない」方針に合わせる）、`post_publications`（bodyHash / M4）、
 *   `discovery_seen`、`discovery_host_metrics`、公開ゲート（撤回判定経路）。
 *   → 公開状態は一切変わらない。
 *
 * 使い方（pnpm 経由。npx/npm は使わない）:
 *   pnpm exec tsx scripts/backfill-mwed-anchors.mjs            # dry-run（Gemini 1 回呼んでプレビュー、DB 未書き込み）
 *   pnpm exec tsx scripts/backfill-mwed-anchors.mjs --apply    # 実際に DB へ書き込む
 *   pnpm exec tsx scripts/backfill-mwed-anchors.mjs --limit 5  # 対象を先頭 5 件に絞る
 *   pnpm exec tsx scripts/backfill-mwed-anchors.mjs --host www.mwed.jp  # 対象ホスト（既定 www.mwed.jp）
 */
import { existsSync, readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const HELP = process.argv.includes("--help") || process.argv.includes("-h");

function readFlagValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

if (HELP) {
  console.log(
    "使い方: pnpm exec tsx scripts/backfill-mwed-anchors.mjs [--apply] [--limit N] [--host www.mwed.jp]",
  );
  process.exit(0);
}

const LIMIT_RAW = readFlagValue("--limit");
const LIMIT = LIMIT_RAW !== undefined ? Number.parseInt(LIMIT_RAW, 10) : undefined;
if (LIMIT_RAW !== undefined && (!Number.isFinite(LIMIT) || LIMIT < 0)) {
  console.error(`--limit の値が不正です: ${LIMIT_RAW}`);
  process.exit(1);
}
const HOST = readFlagValue("--host") ?? "www.mwed.jp";

// バッチ 1 回のプロンプトに載せる上限（トークン予算の安全弁）。これを超える
// 場合は --limit を要求する（分割実行は複数回の再実行で対応する）。
const MAX_BATCH_ITEMS = 25;

// .env.local の簡易パーサ（他スクリプトと同じ作法）。
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

for (const key of ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "GOOGLE_API_KEY"]) {
  if (!process.env[key]) {
    console.error(`${key} が未設定です（.env.local を確認してください）`);
    process.exit(1);
  }
}
console.log(`接続先スキーム: ${process.env.TURSO_DATABASE_URL.split(":")[0]}`);

// env を設定した後に import する（DB 接続がモジュール読み込み時に張られるため）。
const { getPublishedSlicelessCurationCandidates, markCurated, getRationaleByPostId } =
  await import("../src/lib/db/repository.ts");
const { curateBatch } = await import("../src/lib/llm/batch.ts");
const { computeContentHash, computeCurationSignature } =
  await import("../src/lib/llm/signature.ts");
const { LLM_MODEL } = await import("../src/lib/llm/client.ts");
const { RATIONALE_PROMPT_VERSION } = await import("../src/lib/constants.ts");
const { disciplinedFetch } = await import("../src/lib/sources/access-discipline.ts");
const {
  extractArticleContainer,
  extractVisibleText,
  selectJudgmentSlice,
  computeEvidenceSignals,
  computeEvidenceSufficiency,
} = await import("../src/lib/sources/article-text.ts");
const { classifyMwedOutcomes, buildMwedUpdates, assertNoSliceLeak } =
  await import("./lib/mwed-anchor-backfill.mjs");

const currentSignature = computeCurationSignature();
console.log(`対象シグネチャ: ${currentSignature} / モデル: ${LLM_MODEL} / ホスト: ${HOST}`);

const allCandidates = await getPublishedSlicelessCurationCandidates({
  currentSignature,
  limit: 1000,
});
let candidates = allCandidates.filter((c) => c.url.includes(HOST));
if (LIMIT !== undefined) candidates = candidates.slice(0, LIMIT);

console.log(
  `対象候補: ${candidates.length} 件（DB 上の該当プール ${allCandidates.length} 件、うちホスト一致を --limit 適用後）`,
);
if (candidates.length === 0) {
  console.log("対象なし。終了します。");
  process.exit(0);
}
if (candidates.length > MAX_BATCH_ITEMS) {
  console.error(
    `対象が ${candidates.length} 件で、1 バッチの上限 ${MAX_BATCH_ITEMS} 件を超えています。--limit ${MAX_BATCH_ITEMS} を付けて複数回に分けて実行してください。`,
  );
  process.exit(1);
}

// ── 1) 本文の規律付き再取得 → 判定スライスの復元（すべてメモリ上のみ） ──
// slice は candidate に載せず、この配列内だけで保持する（§10-5 漏洩防止の構造的担保）。
console.log("\n[1/3] 本文の規律付き再取得 → 判定スライス復元...");
/** @type {Array<{candidate: object, slice: string}>} */
const prepared = [];
const skipped = [];
for (const c of candidates) {
  const verdict = await disciplinedFetch(c.url, { purpose: "article" });
  if (verdict.kind === "kill_gate") {
    console.error(`  🛑 kill gate 発火（${verdict.gate}）: ${verdict.detail}`);
    console.error("  ホスト停止状態のため処理を中断します。");
    process.exit(1);
  }
  if (verdict.kind !== "ok") {
    skipped.push({ url: c.url, reason: verdict.kind });
    console.log(`  skip ${c.url}（fetch: ${verdict.kind}）`);
    continue;
  }
  const html = await verdict.response.text();
  const containerHtml = extractArticleContainer(html, HOST);
  if (containerHtml === null) {
    skipped.push({ url: c.url, reason: "container_not_found" });
    console.log(`  skip ${c.url}（container_not_found）`);
    continue;
  }
  const signals = computeEvidenceSignals(containerHtml);
  const gate = computeEvidenceSufficiency(signals);
  if (!gate.ok) {
    skipped.push({
      url: c.url,
      reason: `extraction_insufficient:${gate.failedConditions.join(",")}`,
    });
    console.log(`  skip ${c.url}（extraction_insufficient: ${gate.failedConditions.join(",")}）`);
    continue;
  }
  const slice = selectJudgmentSlice(extractVisibleText(containerHtml));
  prepared.push({ candidate: c, slice });
  console.log(`  ok   ${c.url}（slice ${slice.length} 字）`);
}

if (prepared.length === 0) {
  console.log("\n再取得に成功した候補がありません。終了します。");
  process.exit(0);
}

// ── 2) 1 回の Gemini バッチリクエストで再キュレーション ──
console.log(`\n[2/3] Gemini バッチキュレーション（1 リクエスト、${prepared.length} 件）...`);
let geminiRequests = 0;
const curationResults = await curateBatch(
  prepared.map((p) => ({ title: p.candidate.originalTitle, excerpt: p.slice })),
  {
    onGeminiCall: () => {
      geminiRequests += 1;
    },
    maxRequests: 1,
    getCurrentRequests: () => geminiRequests,
  },
);
console.log(`  Gemini リクエスト実測: ${geminiRequests} 回`);

// ── 3) 分類 → updates 構築 → 漏洩検証 → プレビュー / 書き込み ──
const outcomes = classifyMwedOutcomes(
  prepared.map((p, i) => ({ candidate: p.candidate, result: curationResults[i] ?? null })),
);
const { updates, summary, degradeReasonCounts } = buildMwedUpdates(outcomes, {
  computeContentHash,
  currentSignature,
  modelId: LLM_MODEL,
  rationalePromptVersion: RATIONALE_PROMPT_VERSION,
});
assertNoSliceLeak(updates); // §10-5: 許可リスト外キーがあれば throw

// プレビュー: トピックアンカーの新旧のみ。本文・スライスは一切出さない。
const oldAnchorByPostId = new Map();
await Promise.all(
  outcomes
    .filter((o) => o.candidate.id !== null && o.candidate.id !== undefined)
    .map(async (o) => {
      const existing = await getRationaleByPostId(o.candidate.id);
      oldAnchorByPostId.set(o.candidate.id, existing?.topicAnchor ?? null);
    }),
);

console.log("\n── サマリー ──");
console.log(`  再取得成功: ${prepared.length} 件 / 再取得スキップ: ${skipped.length} 件`);
if (skipped.length > 0) {
  for (const s of skipped) console.log(`    - ${s.url}: ${s.reason}`);
}
console.log(`  LLM 失敗（updates 非対象・署名据え置き・次回再対象）: ${summary.llmFailed} 件`);
console.log(
  `  gate degrade（aiSummary/category/tag のみ更新・署名据え置き・旧アンカー温存）: ${summary.gateDegrade} 件`,
);
console.log(`  更新（topicAnchor 含め反映・署名前進）: ${summary.updated} 件`);
if (degradeReasonCounts.size > 0) {
  console.log("  gate degrade 理由内訳:");
  for (const [reason, count] of degradeReasonCounts) console.log(`    - ${reason}: ${count} 件`);
}

console.log("\n── topicAnchor 対比（旧 → 新） ──");
for (const o of outcomes) {
  if (o.kind === "llm_failed") {
    console.log(`  [llm_failed] ${o.candidate.url}`);
    continue;
  }
  const oldAnchor = oldAnchorByPostId.get(o.candidate.id) ?? "(なし)";
  const newAnchor = o.finalTopicAnchor ?? "(null / gate degrade)";
  console.log(`  [${o.kind}] ${o.candidate.url}`);
  console.log(`    旧: ${oldAnchor}`);
  console.log(`    新: ${newAnchor}`);
}

if (!APPLY) {
  console.log(
    "\ndry-run です。問題なければ --apply を付けて再実行してください（Gemini 課金が発生します）。",
  );
  process.exit(0);
}

console.log("\n[3/3] DB へ書き込み中...");
const markResult = await markCurated(updates);
console.log(`更新成功: ${markResult.succeeded.length} 件 / 失敗: ${markResult.failed.length} 件`);
if (markResult.failed.length > 0) console.log("失敗した URL:", markResult.failed.join(", "));
console.log("完了しました。");
