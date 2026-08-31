/**
 * Purpose: Thin wrapper adapting `runPipeline`/`runPipelineOnCandidates` (core,
 * lane-agnostic) to the `SubmitOutcome` contract that `/api/submit-url` and
 * `submitSnsUrl` (Server Action) depend on. Introduced in S2 (shared_plan/17)
 * to switch the submit lane's production path onto the unified pipeline core.
 * The legacy skeleton (`runSubmitUrl`, formerly `@/lib/pipeline/submit-url.ts`)
 * was removed in Stage 6 S2 Commit 4 once the rss/evergreen/submit
 * retry-queue consumer moved onto `retry-runner.ts`; this wrapper (and its
 * `SubmitOutcome` contract, moved here from the deleted legacy module) is
 * now the sole production implementation for this lane.
 */

import {
  DAILY_PUBLISH_CAP,
  RETRY_BACKOFF_HOURS,
  RETRY_MAX_ATTEMPTS,
  RETRY_TTL_HOURS,
} from "@/lib/constants";
import { runPipelineOnCandidates } from "@/lib/pipeline/run-pipeline";
import { SubmitAdapter } from "@/lib/pipeline/adapters/submit-adapter";
import type { FeedCard } from "@/lib/types";
import { computeCurationSignature } from "@/lib/llm/signature";

/**
 * SNS 単発投稿の取り込み結果。
 * `reason` は表示用文言そのものではなく、呼び出し側（Route Handler / Server Action）が
 * HTTP ステータスや日本語メッセージへ変換するための安定した内部コード。
 * - 失敗時（`ok:false`）: `"invalid_url"` | `"save_failed"`
 * - 終端棄却（`ok:true`・plan 07 §7）: `"extraction_insufficient"`（要約対象の
 *   原文テキストが存在しない） | `"title_filter"`
 * - 撤回済み（`ok:true`・sticky）: `"removed"`
 * - 一時的失敗を再試行キューへ繰り延べ（`ok:true`）: `"queued_for_retry"` | `"rate_limited"`
 * - 成功: `null`
 */
export type SubmitOutcome = {
  ok: boolean;
  reason: string | null;
  card: FeedCard | null;
};

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `now` を含む JST の暦日の開始時刻（UTC ISO 文字列）。旧 `submit-url.ts` の同名関数と同一実装。 */
function jstDayStartIso(nowIso: string): string {
  const jstMs = Date.parse(nowIso) + JST_OFFSET_MS;
  const jst = new Date(jstMs);
  const startOfDayJstMs = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return new Date(startOfDayJstMs - JST_OFFSET_MS).toISOString();
}

/**
 * `runPipeline`（コア）経由で単一 URL の SNS 投稿を取り込み、`SubmitOutcome`
 * を返す。`/api/submit-url` の Route Handler と `submitSnsUrl` Server Action
 * から呼ばれる本番経路。
 *
 * `ingest.ts` の再試行キュー消費ループ（rss/evergreen/submit 共通）は
 * `retry-runner.ts`（同じく `runPipelineOnCandidates` 経由）に配線されており、
 * この関数とは別経路（初回投入 vs 再試行キュー消費）。
 */
export async function runSubmitUrlViaPipeline(url: string, note?: string): Promise<SubmitOutcome> {
  const adapter = new SubmitAdapter();
  const candidates = await adapter.buildCandidates([url], note);

  if (candidates.length === 0) {
    // buildCandidates は canonicalizeUrl が失敗した URL を候補に含めない
    // （旧 runSubmitUrl の `if (!canonical) return { ok:false, reason:"invalid_url" }` 相当）。
    return { ok: false, reason: "invalid_url", card: null };
  }

  const now = new Date().toISOString();

  const summary = await runPipelineOnCandidates(candidates, adapter, {
    curationBudget: candidates.length,
    dailyPublishCap: DAILY_PUBLISH_CAP,
    jstDayStartIso: jstDayStartIso(now),
    curationSignature: computeCurationSignature(),
    retryMaxAttempts: RETRY_MAX_ATTEMPTS,
    retryBackoffHours: [...RETRY_BACKOFF_HOURS],
    retryTtlHours: RETRY_TTL_HOURS,
    lane: "submit",
    enforceRemovedFilter: true,
    enforceRateCap: true,
    collectOutcomes: true,
  });

  const outcome = summary.outcomes?.[0];
  if (!outcome) {
    return { ok: false, reason: "save_failed", card: null };
  }
  return { ok: outcome.ok, reason: outcome.reason, card: outcome.card };
}
