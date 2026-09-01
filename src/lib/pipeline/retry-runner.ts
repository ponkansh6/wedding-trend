/**
 * Purpose: Shared due/expired retry-queue consumer for the rss/evergreen/submit
 * lanes (Stage 6 S2 Commit 3, shared_plan/17). Replaces the old per-lane
 * skeletons' last production call site (`processDueAndExpiredRetries` in
 * `ingest.ts`) by driving `terminateRetry` + `runPipelineOnCandidates` (the
 * new core) through each lane's `PipelineAdapter`.
 *
 * discovery レーンは discovery-ingest.ts が `lanes: ["discovery"]` で独立に
 * 処理するため、ここでは一切触れない。
 */

import {
  DAILY_PUBLISH_CAP,
  RETRY_BACKOFF_HOURS,
  RETRY_MAX_ATTEMPTS,
  RETRY_TTL_HOURS,
} from "@/lib/constants";
import { dueRetries, expireRetries } from "@/lib/db/publication";
import { computeCurationSignature } from "@/lib/llm/signature";
import type { RetryLane, RetryQueueEntry } from "@/lib/types";
import {
  runPipelineOnCandidates,
  terminateRetry,
  type PipelineAdapter,
} from "@/lib/pipeline/run-pipeline";
import { RssAdapter } from "@/lib/pipeline/adapters/rss-adapter";
import { EvergreenAdapter } from "@/lib/pipeline/adapters/evergreen-adapter";

/** rss/evergreen/submit 共有の due 取得件数上限（旧 `processDueAndExpiredRetries` と同値）。 */
const RETRY_PROCESS_LIMIT = 50;

/** discovery を除く、このランナーが処理するレーン一覧。 */
const RSS_ADJACENT_LANES: RetryLane[] = ["rss", "evergreen"];

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `now` を含む JST の暦日の開始時刻（UTC ISO 文字列）。他の呼び出し元と同一実装。 */
function jstDayStartIso(nowIso: string): string {
  const jstMs = Date.parse(nowIso) + JST_OFFSET_MS;
  const jst = new Date(jstMs);
  const startOfDayJstMs = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return new Date(startOfDayJstMs - JST_OFFSET_MS).toISOString();
}

/**
 * レーン → アダプタの対応表。レーンごとの分岐（`switch`/`if (lane === ...)`）
 * はこのファイル中どこにも書かず、常にこのテーブルを介して解決する。
 */
const ADAPTERS: Record<"rss" | "evergreen", () => PipelineAdapter> = {
  rss: () => new RssAdapter(),
  evergreen: () => new EvergreenAdapter(),
};

function isRssAdjacentLane(lane: RetryLane): lane is "rss" | "evergreen" {
  return lane === "rss" || lane === "evergreen";
}

/**
 * rss/evergreen/submit レーン分の再試行キューの消費者（旧 `ingest.ts` の
 * `processDueAndExpiredRetries` を置き換える）。
 *
 * 呼び出し順序は仕様: `expireRetries` → `dueRetries`。逆にすると、今回の
 * ランで TTL 超過したエントリが due 側でもう一度処理されてしまう。
 */
export async function processDueAndExpiredRetries(now: string): Promise<{ errors: string[] }> {
  const errors: string[] = [];

  // TTL 超過分の終端棄却。
  const expired = await expireRetries(now, RSS_ADJACENT_LANES);
  for (const entry of expired) {
    if (!isRssAdjacentLane(entry.lane)) continue; // expireRetries(lanes) により実質発生しない防御。
    try {
      const adapter = ADAPTERS[entry.lane]();
      await terminateRetry(adapter, entry.url, now);
    } catch (err) {
      errors.push(
        `retry-expire[${entry.lane}] ${entry.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // due（nextAttemptAt <= now、まだ TTL 内）分の実際の再処理。
  // 旧実装と同じく `dueRetries` は 1 回だけ呼び、その結果を 3 レーンで
  // 共有の上限として消費する（レーンごとに別枠にしない）。
  const due = await dueRetries(now, RETRY_PROCESS_LIMIT);
  const byLane = new Map<"rss" | "evergreen", RetryQueueEntry[]>();
  for (const entry of due) {
    if (!isRssAdjacentLane(entry.lane)) continue; // discovery レーンは discovery-ingest.ts が処理する。
    const bucket = byLane.get(entry.lane);
    if (bucket) bucket.push(entry);
    else byLane.set(entry.lane, [entry]);
  }

  const currentSignature = computeCurationSignature();
  const jstStart = jstDayStartIso(now);

  for (const [lane, entries] of byLane) {
    const adapter = ADAPTERS[lane]();
    const candidates = [];
    for (const entry of entries) {
      try {
        const candidate = await adapter.buildRetryCandidate(entry);
        if (candidate) candidates.push(candidate);
      } catch (err) {
        errors.push(
          `retry-due[${lane}] ${entry.url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (candidates.length === 0) continue;

    const summary = await runPipelineOnCandidates(candidates, adapter, {
      curationBudget: candidates.length,
      dailyPublishCap: DAILY_PUBLISH_CAP,
      jstDayStartIso: jstStart,
      curationSignature: currentSignature,
      retryMaxAttempts: RETRY_MAX_ATTEMPTS,
      retryBackoffHours: [...RETRY_BACKOFF_HOURS],
      retryTtlHours: RETRY_TTL_HOURS,
      lane,
      enforceRemovedFilter: true,
      enforceRateCap: true,
    });
    errors.push(...summary.errors);
  }

  return { errors };
}
