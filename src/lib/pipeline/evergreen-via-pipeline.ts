/**
 * Purpose: Thin wrapper adapting `runPipeline`/`runPipelineOnCandidates` (core,
 * lane-agnostic) to the `EvergreenOutcome` contract that
 * `scripts/ops/submit-evergreen.mjs` (manual admin CLI) depends on.
 * Introduced in S2 (shared_plan/17) to switch the evergreen lane's manual
 * ingestion path onto the unified pipeline core while `curateEvergreenUrl`
 * (legacy, `@/lib/pipeline/evergreen.ts`) remains the implementation used by
 * the retry-queue consumer in `ingest.ts` (untouched here).
 */

import {
  DAILY_PUBLISH_CAP,
  RETRY_BACKOFF_HOURS,
  RETRY_MAX_ATTEMPTS,
  RETRY_TTL_HOURS,
} from "@/lib/constants";
import { runPipelineOnCandidates } from "@/lib/pipeline/run-pipeline";
import { EvergreenAdapter } from "@/lib/pipeline/adapters/evergreen-adapter";
import type { EvergreenOutcome } from "@/lib/pipeline/evergreen";
import { computeCurationSignature } from "@/lib/llm/signature";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `now` を含む JST の暦日の開始時刻（UTC ISO 文字列）。旧 `evergreen.ts` の同名関数と同一実装。 */
function jstDayStartIso(nowIso: string): string {
  const jstMs = Date.parse(nowIso) + JST_OFFSET_MS;
  const jst = new Date(jstMs);
  const startOfDayJstMs = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return new Date(startOfDayJstMs - JST_OFFSET_MS).toISOString();
}

/**
 * `runPipeline`（コア）経由で単一 URL のエバーグリーン記事を取り込み、旧
 * `curateEvergreenUrl`（`@/lib/pipeline/evergreen`）と同一契約の
 * `EvergreenOutcome` を返す。`scripts/ops/submit-evergreen.mjs`（管理者手動
 * CLI）から呼ばれる新しい本番経路（S2 配線）。
 *
 * `ingest.ts` の再試行キュー消費ループ（rss/evergreen/submit 共通）は、
 * まだ旧 `curateEvergreenUrl` / `terminateEvergreenRetry` を呼び続けており、
 * この関数の対象外（今回は初回投入経路のみを切り替える）。
 */
export async function curateEvergreenUrlViaPipeline(
  url: string,
  opts?: { sourceName?: string },
): Promise<EvergreenOutcome> {
  const adapter = new EvergreenAdapter();
  const { candidates, rejections } = await adapter.buildCandidatesWithRejections(
    [url],
    opts?.sourceName,
  );

  if (rejections.length > 0) {
    return { ok: false, reason: rejections[0].reason, card: null };
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
    lane: "evergreen",
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
