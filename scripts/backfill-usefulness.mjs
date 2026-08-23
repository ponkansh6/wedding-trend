#!/usr/bin/env tsx
/**
 * 有用度スコア（post_usefulness_criteria）の全件バックフィル用の使い捨てスクリプト。
 *
 * CURATION_PROMPT_VERSION を bump した直後は、通常の ingest（新着優先 +
 * 余った予算でのバックフィル、src/lib/pipeline/ingest.ts 参照）でも数回の
 * cron 実行で全件へ波及するが、すぐに全件を揃えたい場合はこのスクリプトで
 * ローカルから直接 Turso に繋いで一括処理する。
 *
 * ロジックは複製しない: 候補選定は src/lib/db/repository.ts の
 * getStaleCurationCandidates()、キュレーション本体は src/lib/llm/batch.ts の
 * curatePosts() をそのまま呼ぶ薄いラッパー。Vercel の maxDuration や
 * CURATION_DEADLINE_MS（ソフト締切）はローカル実行には無関係なので、
 * 予算を上げ・締切なしで一括処理する。
 *
 * 使い方（pnpm 経由。npx/npm は使わない）:
 *   pnpm exec tsx scripts/backfill-usefulness.mjs          # dry-run（対象件数のみ表示）
 *   pnpm exec tsx scripts/backfill-usefulness.mjs --apply  # 実際に実行（Gemini 課金が発生する）
 */
import { existsSync, readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");

// .env.local の簡易パーサ（scripts/apply-migrations-remote.mjs と同じ作法）。
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

// 秘密情報を出力しないよう、接続先はスキームのみ表示する。
console.log(`接続先スキーム: ${process.env.TURSO_DATABASE_URL.split(":")[0]}`);

// env を設定した後に import する（src/lib/db/index.ts はモジュール読み込み時に
// process.env を読んで接続を作るため）。
const { getStaleCurationCandidates, markCurated } = await import("../src/lib/db/repository.ts");
const { curatePosts } = await import("../src/lib/llm/batch.ts");
const { computeContentHash, computeCurationSignature } =
  await import("../src/lib/llm/signature.ts");
const { LLM_MODEL } = await import("../src/lib/llm/client.ts");

// 本番の対象件数（数十件想定）を十分に上回る上限。無限に伸びないための保険。
const BACKFILL_LIMIT = 1000;

const currentSignature = computeCurationSignature();
console.log(`対象シグネチャ: ${currentSignature} / モデル: ${LLM_MODEL}`);

const candidates = await getStaleCurationCandidates({
  currentSignature,
  limit: BACKFILL_LIMIT,
});
console.log(`バックフィル対象: ${candidates.length} 件`);

if (!APPLY) {
  console.log(
    "dry-run です。実行するには --apply を付けて再実行してください（Gemini 課金が発生します）。",
  );
  process.exit(0);
}
if (candidates.length === 0) {
  console.log("対象なし。終了します。");
  process.exit(0);
}

console.log("Gemini によるキュレーションを開始します...");
const { results, geminiCalls } = await curatePosts(
  candidates.map((c) => ({ title: c.originalTitle, excerpt: c.originalExcerpt })),
);

const updates = candidates
  .map((c, i) => {
    const result = results[i];
    if (!result) return null;
    return {
      url: c.url,
      aiTitle: result.title,
      aiSummary: result.summary,
      category: result.category,
      tag: result.tag,
      contentHash: computeContentHash(c.originalTitle, c.originalExcerpt),
      curationSignature: currentSignature,
      usefulness:
        c.id !== null
          ? {
              postId: c.id,
              modelId: LLM_MODEL,
              criteria: {
                firsthand: result.firsthand,
                ceremonyDecision: result.ceremonyDecision,
                specific: result.specific,
                tradeoff: result.tradeoff,
                promotional: result.promotional,
                preDecisionOrPhotoShoot: result.preDecisionOrPhotoShoot,
              },
            }
          : undefined,
    };
  })
  .filter((u) => u !== null);

const markResult = await markCurated(updates);

console.log(`Gemini 呼び出し回数: ${geminiCalls}`);
console.log(`更新成功: ${markResult.succeeded.length} 件 / 失敗: ${markResult.failed.length} 件`);
if (markResult.failed.length > 0) {
  console.log("失敗した URL:", markResult.failed.join(", "));
}
console.log("完了しました。");
