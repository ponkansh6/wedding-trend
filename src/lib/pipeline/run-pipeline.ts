import {
  RATIONALE_PROMPT_VERSION,
  RETRY_BACKOFF_HOURS,
  RETRY_MAX_ATTEMPTS,
  RETRY_TTL_HOURS,
} from "@/lib/constants";
import {
  completeRetry,
  countPublishedSince,
  enqueueRetry,
  filterRemoved,
  getPostsByUrls,
  hashUrl,
  markCurated,
  markDropped,
  recordPublication,
  saveEmbed,
  upsertPosts,
  type CurationUpdate,
  type PostUpsertInput,
} from "@/lib/db/repository";
import { curatePosts, type CurationResult } from "@/lib/llm/batch";
import { LLM_MODEL } from "@/lib/llm/client";
import { computeContentHash } from "@/lib/llm/signature";
import { filterTitle } from "@/lib/publish/gate";
import type {
  EmbedProvider,
  FeedCard,
  PostStatus,
  RetryContext,
  RetryLane,
  RetryQueueEntry,
  RetryReason,
} from "@/lib/types";
import { canonicalizeUrl } from "@/lib/url";

function addHoursIso(baseIso: string, hours: number): string {
  return new Date(Date.parse(baseIso) + hours * 60 * 60 * 1000).toISOString();
}

/**
 * `candidate.embedFetched` が true の場合のみ embed 情報を永続化する
 * （旧 `runSubmitUrl` の `saveEmbedIfPresent` 相当）。RSS/evergreen 等
 * embed を試行しないレーンの候補は `embedFetched` が未指定のため無処理。
 */
async function saveEmbedIfFetched(candidate: PipelineCandidate, now: string): Promise<void> {
  if (!candidate.embedFetched) return;
  await saveEmbed(candidate.url, {
    embedProvider: (candidate.embedProvider ?? "none") as EmbedProvider,
    embedHtml: candidate.embedHtml ?? null,
    embedFetchedAt: now,
  });
}

/**
 * 終端棄却（公開に至らない確定的な却下）で候補が再試行キュー由来
 * （`candidate.retry` が存在する）の場合にキュー行を削除する。
 * 呼ばないと `attempts`/`nextAttemptAt` が更新されないまま due が
 * 恒久化し、cron のたびに無駄な再処理（LLM 呼び出し含む）が発生する
 * ゾンビ行になる（レーン非依存。分岐を持ち込まないこと）。
 */
async function completeRetryIfQueued(candidate: PipelineCandidate): Promise<void> {
  if (candidate.retry) {
    await completeRetry(candidate.retry.urlHash);
  }
}

function backoffHoursFor(attempts: number, customBackoff?: number[]): number {
  const backoffArray =
    customBackoff && customBackoff.length > 0 ? customBackoff : RETRY_BACKOFF_HOURS;
  const idx = Math.min(attempts, backoffArray.length - 1);
  return backoffArray[idx] ?? backoffArray[backoffArray.length - 1];
}

async function handleTransientFailure(
  adapter: PipelineAdapter,
  candidate: PipelineCandidate,
  reason: RetryReason,
  now: string,
  ctx: RetryContext | null,
  options: PipelineOptions,
): Promise<boolean> {
  const attempts = ctx?.attempts ?? 0;
  const nextAttempts = attempts + 1;
  const firstQueuedAt = ctx?.firstQueuedAt ?? now;
  const maxAttempts = options.retryMaxAttempts ?? RETRY_MAX_ATTEMPTS;

  if (nextAttempts > maxAttempts) {
    if (ctx) await completeRetry(ctx.urlHash);
    await adapter.onTransientFailure(
      candidate,
      reason === "rate_capped" ? "rate_capped" : "llm_transient",
      ctx,
    );
    return true;
  }

  let host = "";
  try {
    host = new URL(candidate.url).host;
  } catch {
    // ignore
  }

  await enqueueRetry({
    urlHash: ctx?.urlHash ?? hashUrl(candidate.url),
    url: candidate.url,
    host,
    lane: options.lane,
    reason,
    attempts: nextAttempts,
    firstQueuedAt,
    nextAttemptAt: addHoursIso(now, backoffHoursFor(attempts, options.retryBackoffHours)),
    expiresAt: addHoursIso(firstQueuedAt, options.retryTtlHours ?? RETRY_TTL_HOURS),
  });

  await adapter.onTransientFailure(
    candidate,
    reason === "rate_capped" ? "rate_capped" : "llm_transient",
    ctx,
  );
  return false;
}

export type TerminalReason =
  | "extraction_insufficient"
  | "title_filter"
  | "retry_exhausted"
  | "ttl_expired";

export interface PipelineCandidate {
  url: string;
  originalTitle: string;
  originalExcerpt: string | null;
  sourceType: "sns" | "blog";
  sourceId: string;
  sourceName: string;
  publishedAt: string | null;
  author?: string | null;
  thumbnailUrl?: string | null;
  embedProvider?: string | null;
  embedHtml?: string | null;
  /**
   * oEmbed 等の埋め込み取得を試行し、結果（成否問わず非 null）を得たことを示す。
   * true の場合、コアは終端棄却／公開が確定した時点で `embedProvider`/`embedHtml`
   * を `saveEmbed` により `embedFetchedAt` とともに永続化する（旧 `runSubmitUrl`
   * の `saveEmbedIfPresent` 相当）。レーン名分岐ではなく候補データで表現するため
   * のフィールド（RSS/evergreen は常に undefined のまま = 従来どおり非呼び出し）。
   */
  embedFetched?: boolean;
  note?: string | null;
  /** 既存の再試行キューエントリ（再処理時のみ）。初回候補では undefined。 */
  retry?: RetryContext | null;
}

export interface PipelineAdapter {
  fetchCandidates(limit: number): Promise<PipelineCandidate[]>;
  fetchDueRetries(now: string): Promise<PipelineCandidate[]>;
  /**
   * 1件の再試行キューエントリ（`dueRetries` の戻り値の1要素）を、
   * 再処理可能な候補1件に変換する。取得元データが失われている等で
   * 候補化できない場合は null を返す（呼び出し側はそのエントリをスキップする）。
   * `retry-runner.ts` が `dueRetries(now, RETRY_PROCESS_LIMIT)` を1回だけ呼び、
   * その結果をレーンでグルーピングして各エントリをこのメソッドで候補化する
   * ため、`fetchDueRetries` のように内部で `dueRetries` を呼び直さない
   * （3レーン共有の上限を守るため）。
   */
  buildRetryCandidate(entry: RetryQueueEntry): Promise<PipelineCandidate | null>;
  onTransientFailure(
    candidate: PipelineCandidate,
    reason: "llm_transient" | "rate_capped",
    ctx: RetryContext | null,
  ): Promise<void>;
  onTerminalDrop(candidate: PipelineCandidate, reason: TerminalReason, now: string): Promise<void>;
  /**
   * TTL 超過（retry_exhausted）による終端棄却専用。LLM/OGP/oEmbed を再取得
   * せず、URL のみから「終端棄却済みの post 行」の id を確保する（墓標）。
   * 既存 post 行があればそれを返し、**フィールドを一切上書きしない**
   * （旧 `terminate*Retry` は `upsertPosts` 経由で `originalTitle` 等を
   * URL 由来の値で上書きしてしまうバグを持つ。この関数はそれを踏まない）。
   * 既存行が無い場合のみ、捏造せず URL から得られる情報のみで最小行を
   * 作成して id を返す。post 行を作れない／特定できない場合は null。
   * 呼び出し側（`terminateRetry`）は id が null なら何もしない。
   */
  ensureTombstonePost(url: string): Promise<number | null>;
  buildFeedCard(
    candidate: PipelineCandidate,
    curation: CurationResult,
    postId: number,
    bodyHash: string,
    now: string,
  ): Promise<FeedCard>;
}

export interface PipelineOptions {
  curationBudget: number;
  dailyPublishCap: number;
  jstDayStartIso: string;
  curationSignature: string;
  retryMaxAttempts: number;
  retryBackoffHours: number[];
  retryTtlHours: number;
  lane: RetryLane;
  enforceRemovedFilter?: boolean;
  enforceRateCap?: boolean;
  onComplete?: (summary: PipelineSummary) => Promise<void>;
  /**
   * opt-in: true の場合、候補ごとの結果（公開成功時の FeedCard を含む）を
   * `PipelineSummary.outcomes` に収集する。既定 false（未指定時は
   * `outcomes` を undefined のままにし、既存呼び出し元（/api/ingest 等）の
   * レスポンス形状を変えない）。単一 URL 投入（submit レーン）が公開結果
   * （card）を取得するための経路として S2 で追加。
   */
  collectOutcomes?: boolean;
}

/**
 * `collectOutcomes: true` のときに `PipelineSummary.outcomes` へ積まれる、
 * 候補（正規化前の入力 URL 単位）ごとの結果。旧 `runSubmitUrl` の
 * `SubmitOutcome` と互換な形にするための最小限の形。
 */
export interface CandidateOutcome {
  url: string;
  ok: boolean;
  reason: string | null;
  card: FeedCard | null;
}

export interface PipelineSummary {
  fetched: number;
  inserted: number;
  curated: number;
  skipped: number;
  errors: string[];
  geminiCalls: number;
  stageCounts: {
    deduped: number;
    evidenceGatePassed: number;
    titleGatePassed: number;
    rateCapPassed: number;
    published: number;
    dropped: Record<string, number>;
    retried: number;
  };
  outcomes?: CandidateOutcome[];
}

export async function runPipeline(
  adapter: PipelineAdapter,
  options: PipelineOptions,
): Promise<PipelineSummary> {
  const errors: string[] = [];
  const droppedCounts: Record<string, number> = {};

  // 1. Fetch candidates
  let rawCandidates: PipelineCandidate[] = [];
  try {
    rawCandidates = await adapter.fetchCandidates(options.curationBudget);
  } catch (err) {
    errors.push(`fetchCandidates failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      fetched: 0,
      inserted: 0,
      curated: 0,
      skipped: 0,
      errors,
      geminiCalls: 0,
      stageCounts: {
        deduped: 0,
        evidenceGatePassed: 0,
        titleGatePassed: 0,
        rateCapPassed: 0,
        published: 0,
        dropped: droppedCounts,
        retried: 0,
      },
    };
  }

  return runPipelineOnCandidates(rawCandidates, adapter, options);
}

export async function runPipelineOnCandidates(
  rawCandidates: PipelineCandidate[],
  adapter: PipelineAdapter,
  options: PipelineOptions,
): Promise<PipelineSummary> {
  const errors: string[] = [];
  const droppedCounts: Record<string, number> = {};

  function addDrop(reason: string) {
    droppedCounts[reason] = (droppedCounts[reason] || 0) + 1;
  }

  // collectOutcomes: 候補 URL（正規化後）ごとの結果を積む opt-in マップ。
  // 未指定時は null のままにし、以下のあらゆる箇所での set 呼び出しを no-op にする。
  const outcomeMap = options.collectOutcomes ? new Map<string, CandidateOutcome>() : null;
  function setOutcome(url: string, outcome: CandidateOutcome) {
    outcomeMap?.set(url, outcome);
  }

  // 2. Deduplicate by canonical URL
  const seen = new Set<string>();
  const deduped: PipelineCandidate[] = [];
  for (const c of rawCandidates) {
    const canonical = canonicalizeUrl(c.url);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    deduped.push({ ...c, url: canonical });
  }

  // 3. Upsert posts
  const upsertInputs: PostUpsertInput[] = deduped.map((c) => ({
    url: c.url,
    sourceType: c.sourceType,
    sourceId: c.sourceId,
    sourceName: c.sourceName,
    originalTitle: c.originalTitle,
    originalExcerpt: c.originalExcerpt,
    author: c.author ?? null,
    thumbnailUrl: c.thumbnailUrl ?? null,
    publishedAt: c.publishedAt ?? null,
  }));

  const upsertResult = await upsertPosts(upsertInputs);
  if (upsertResult.failed.length > 0) {
    errors.push(`upsert failed for ${upsertResult.failed.length} posts`);
    for (const url of upsertResult.failed) {
      setOutcome(url, { url, ok: false, reason: "save_failed", card: null });
    }
  }

  // 4. Check removed / curation freshness
  const states = await getPostsByUrls(upsertResult.succeeded);
  const freshCandidates: PipelineCandidate[] = [];
  for (const c of deduped) {
    const state = states.get(c.url);
    const needsCuration = (() => {
      if (!state) return true;
      if (!state.aiTitle) return true;
      const freshHash = computeContentHash(state.originalTitle, state.originalExcerpt);
      const isUnchanged =
        state.contentHash === freshHash && state.curationSignature === options.curationSignature;
      return !isUnchanged;
    })();
    if (needsCuration) {
      freshCandidates.push(c);
    }
  }

  const toCurate = freshCandidates.slice(0, options.curationBudget);
  const skipped = deduped.length - toCurate.length;

  const candidateIds = toCurate
    .map((c) => states.get(c.url)?.id ?? null)
    .filter((id): id is number => id !== null);
  const removedIds =
    options.enforceRemovedFilter !== false ? await filterRemoved(candidateIds) : new Set<number>();

  const workingCandidates: PipelineCandidate[] = [];
  for (const c of toCurate) {
    const id = states.get(c.url)?.id ?? null;
    if (id !== null && removedIds.has(id)) {
      addDrop("removed");
      await completeRetryIfQueued(c);
      setOutcome(c.url, { url: c.url, ok: true, reason: "removed", card: null });
      continue;
    }
    workingCandidates.push(c);
  }

  let curated = 0;
  let geminiCalls = 0;
  let evidenceGatePassed = 0;
  let titleGatePassed = 0;
  let rateCapPassed = 0;
  let publishedCount = 0;
  let retriedCount = 0;
  const now = new Date().toISOString();

  if (workingCandidates.length > 0) {
    try {
      // Evidence Gate (Q1 equivalent)
      const evidenceOk: PipelineCandidate[] = [];
      for (const c of workingCandidates) {
        const hasExcerpt = !!c.originalExcerpt && c.originalExcerpt.trim() !== "";
        if (hasExcerpt) {
          evidenceOk.push(c);
          evidenceGatePassed++;
        } else {
          addDrop("extraction_insufficient");
          const state = states.get(c.url);
          if (state?.id != null) {
            await markDropped(state.id, "extraction_insufficient", now);
          }
          await saveEmbedIfFetched(c, now);
          await adapter.onTerminalDrop(c, "extraction_insufficient", now);
          await completeRetryIfQueued(c);
          setOutcome(c.url, {
            url: c.url,
            ok: true,
            reason: "extraction_insufficient",
            card: null,
          });
        }
      }

      if (evidenceOk.length > 0) {
        const { results, geminiCalls: calls } = await curatePosts(
          evidenceOk.map((c) => ({ title: c.originalTitle, excerpt: c.originalExcerpt })),
        );
        geminiCalls = calls;

        let totalPublishedToday =
          options.enforceRateCap !== false ? await countPublishedSince(options.jstDayStartIso) : 0;
        const updates: CurationUpdate[] = [];
        const publishedRecords: Array<{
          candidate: PipelineCandidate;
          postId: number;
          bodyHash: string;
          result: CurationResult;
        }> = [];

        for (let i = 0; i < evidenceOk.length; i++) {
          const post = evidenceOk[i];
          const result = results[i];
          const state = states.get(post.url);
          const postId = state?.id ?? null;

          if (!result) {
            const gaveUp = await handleTransientFailure(
              adapter,
              post,
              "llm_transient",
              now,
              post.retry ?? null,
              options,
            );
            retriedCount++;
            if (gaveUp && postId !== null) {
              await markDropped(postId, "retry_exhausted", now);
              await saveEmbedIfFetched(post, now);
              await adapter.onTerminalDrop(post, "retry_exhausted", now);
              addDrop("retry_exhausted");
              setOutcome(post.url, {
                url: post.url,
                ok: true,
                reason: "retry_exhausted",
                card: null,
              });
            } else {
              setOutcome(post.url, {
                url: post.url,
                ok: true,
                reason: "queued_for_retry",
                card: null,
              });
            }
            continue;
          }

          // Title Gate (M1-1)
          const titleGate = filterTitle(post.originalTitle);
          if (!titleGate.ok) {
            if (postId !== null) {
              await markDropped(postId, "title_filter", now);
              await saveEmbedIfFetched(post, now);
              await adapter.onTerminalDrop(post, "title_filter", now);
            }
            await completeRetryIfQueued(post);
            addDrop("title_filter");
            setOutcome(post.url, { url: post.url, ok: true, reason: "title_filter", card: null });
            continue;
          }
          titleGatePassed++;

          // Rate Cap (Q4)
          if (options.enforceRateCap !== false && totalPublishedToday >= options.dailyPublishCap) {
            const gaveUp = await handleTransientFailure(
              adapter,
              post,
              "rate_capped",
              now,
              post.retry ?? null,
              options,
            );
            retriedCount++;
            if (gaveUp && postId !== null) {
              await markDropped(postId, "retry_exhausted", now);
              await saveEmbedIfFetched(post, now);
              await adapter.onTerminalDrop(post, "retry_exhausted", now);
              addDrop("retry_exhausted");
              setOutcome(post.url, {
                url: post.url,
                ok: true,
                reason: "retry_exhausted",
                card: null,
              });
            } else {
              setOutcome(post.url, { url: post.url, ok: true, reason: "rate_limited", card: null });
            }
            continue;
          }
          rateCapPassed++;

          const bodyHash = computeContentHash(post.originalTitle, post.originalExcerpt);
          updates.push({
            url: post.url,
            aiSummary: result.summary,
            category: result.category,
            tag: result.tag,
            contentHash: bodyHash,
            curationSignature: options.curationSignature,
            status: "published" as PostStatus,
            usefulness:
              postId !== null
                ? {
                    postId,
                    modelId: LLM_MODEL,
                    criteria: {
                      firsthand: result.firsthand,
                      ceremonyDecision: result.ceremonyDecision,
                      specific: result.specific,
                      weddingDayContent: result.weddingDayContent,
                      promotional: result.promotional,
                    },
                  }
                : undefined,
            rationale:
              postId !== null
                ? {
                    postId,
                    topicAnchor: result.topicAnchor,
                    rationaleText: result.rationaleText,
                    evidenceSufficient: true,
                    modelId: LLM_MODEL,
                    promptVersion: RATIONALE_PROMPT_VERSION,
                  }
                : undefined,
            topics: result.topics,
            promptVersion: options.curationSignature,
          });

          if (postId !== null) {
            publishedRecords.push({ candidate: post, postId, bodyHash, result });
          }
          totalPublishedToday++;
        }

        if (updates.length > 0) {
          const markResult = await markCurated(updates);
          curated = markResult.succeeded.length;
          if (markResult.failed.length > 0) {
            errors.push(`markCurated failed for ${markResult.failed.length} posts`);
            for (const url of markResult.failed) {
              setOutcome(url, { url, ok: false, reason: "save_failed", card: null });
            }
          }

          for (const rec of publishedRecords) {
            if (markResult.succeeded.includes(rec.candidate.url)) {
              await recordPublication(rec.postId, now, rec.bodyHash, "surrogate");
              await saveEmbedIfFetched(rec.candidate, now);
              const card = await adapter.buildFeedCard(
                rec.candidate,
                rec.result,
                rec.postId,
                rec.bodyHash,
                now,
              );
              publishedCount++;
              setOutcome(rec.candidate.url, {
                url: rec.candidate.url,
                ok: true,
                reason: null,
                card,
              });
            }
          }
        }
      }
    } catch (err) {
      errors.push(
        `pipeline processing failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // collectOutcomes: rawCandidates（入力順）に対応する結果配列を組み立てる。
  // outcomeMap は正規化後 URL をキーに持つため canonicalizeUrl で引く。
  const outcomes: CandidateOutcome[] | undefined = outcomeMap
    ? rawCandidates.map((c) => {
        const canonical = canonicalizeUrl(c.url);
        const found = canonical ? outcomeMap.get(canonical) : undefined;
        return found ?? { url: c.url, ok: false, reason: "invalid_url", card: null };
      })
    : undefined;

  const summary: PipelineSummary = {
    fetched: rawCandidates.length,
    inserted: upsertResult.succeeded.length,
    curated,
    skipped,
    errors,
    geminiCalls,
    stageCounts: {
      deduped: deduped.length,
      evidenceGatePassed,
      titleGatePassed,
      rateCapPassed,
      published: publishedCount,
      dropped: droppedCounts,
      retried: retriedCount,
    },
    ...(outcomes ? { outcomes } : {}),
  };

  if (options.onComplete) {
    await options.onComplete(summary);
  }

  return summary;
}

/**
 * TTL 超過（retry_exhausted）による終端棄却の共有ルーチン（Stage 6 S2 Commit 2）。
 * パイプラインではない: ゲートを通らず、LLM を呼ばず、公開もしない。
 * 再試行台帳のライフサイクル終端に墓標を立てる記帳操作。
 *
 * レーン固有性は `adapter.ensureTombstonePost` にのみ宿り、ここではレーン名
 * による分岐を一切書かない（「post 行を作る／取得する」＝アダプタ、
 * 「棄却理由・冪等性・呼び出し順序」＝共有側、という oracle レビュー済みの分割線）。
 *
 * 現時点では未使用（次コミットで旧 `terminate*Retry` / `processDueAndExpiredRetries`
 * の消費ループから配線する）。
 */
export async function terminateRetry(
  adapter: PipelineAdapter,
  url: string,
  now: string,
): Promise<void> {
  const id = await adapter.ensureTombstonePost(url);
  if (id != null) await markDropped(id, "retry_exhausted", now);
}
