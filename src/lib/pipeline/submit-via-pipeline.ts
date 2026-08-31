/**
 * Purpose: Thin wrapper adapting `runPipeline`/`runPipelineOnCandidates` (core,
 * lane-agnostic) to the `SubmitOutcome` contract that `/api/submit-url` and
 * `submitSnsUrl` (Server Action) depend on. Introduced in S2 (shared_plan/17)
 * to switch the submit lane's production path onto the unified pipeline core
 * while `runSubmitUrl` (legacy) remains the implementation used by the
 * rss/evergreen/submit retry-queue consumer in `ingest.ts` (untouched here).
 */

import {
  DAILY_PUBLISH_CAP,
  RETRY_BACKOFF_HOURS,
  RETRY_MAX_ATTEMPTS,
  RETRY_TTL_HOURS,
} from "@/lib/constants";
import { runPipelineOnCandidates } from "@/lib/pipeline/run-pipeline";
import { SubmitAdapter } from "@/lib/pipeline/adapters/submit-adapter";
import type { SubmitOutcome } from "@/lib/pipeline/submit-url";
import { computeCurationSignature } from "@/lib/llm/signature";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `now` を含む JST の暦日の開始時刻（UTC ISO 文字列）。旧 `submit-url.ts` の同名関数と同一実装。 */
function jstDayStartIso(nowIso: string): string {
  const jstMs = Date.parse(nowIso) + JST_OFFSET_MS;
  const jst = new Date(jstMs);
  const startOfDayJstMs = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return new Date(startOfDayJstMs - JST_OFFSET_MS).toISOString();
}

/**
 * `runPipeline`（コア）経由で単一 URL の SNS 投稿を取り込み、旧
 * `runSubmitUrl`（`@/lib/pipeline/submit-url`）と同一契約の `SubmitOutcome`
 * を返す。`/api/submit-url` の Route Handler と `submitSnsUrl` Server Action
 * から呼ばれる新しい本番経路（S2 配線）。
 *
 * `ingest.ts` の再試行キュー消費ループ（rss/evergreen/submit 共通）は、
 * まだ旧 `runSubmitUrl` / `terminateSubmitRetry` を呼び続けており、
 * この関数の対象外（今回は初回投入経路のみを切り替える）。
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
