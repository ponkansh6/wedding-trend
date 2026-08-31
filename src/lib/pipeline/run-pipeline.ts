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
  upsertPosts,
  type CurationUpdate,
  type PostUpsertInput,
} from "@/lib/db/repository";
import { curatePosts, type CurationResult } from "@/lib/llm/batch";
import { LLM_MODEL } from "@/lib/llm/client";
import { computeContentHash } from "@/lib/llm/signature";
import { filterTitle } from "@/lib/publish/gate";
import type { FeedCard, PostStatus, RetryContext, RetryLane, RetryReason } from "@/lib/types";
import { canonicalizeUrl } from "@/lib/url";

function addHoursIso(baseIso: string, hours: number): string {
  return new Date(Date.parse(baseIso) + hours * 60 * 60 * 1000).toISOString();
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
  note?: string | null;
  /** 既存の再試行キューエントリ（再処理時のみ）。初回候補では undefined。 */
  retry?: RetryContext | null;
}

export interface PipelineAdapter {
  fetchCandidates(limit: number): Promise<PipelineCandidate[]>;
  onTransientFailure(
    candidate: PipelineCandidate,
    reason: "llm_transient" | "rate_capped",
    ctx: RetryContext | null,
  ): Promise<void>;
  onTerminalDrop(candidate: PipelineCandidate, reason: string, now: string): Promise<void>;
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
}

export async function runPipeline(
  adapter: PipelineAdapter,
  options: PipelineOptions,
): Promise<PipelineSummary> {
  const errors: string[] = [];
  const droppedCounts: Record<string, number> = {};

  function addDrop(reason: string) {
    droppedCounts[reason] = (droppedCounts[reason] || 0) + 1;
  }

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

  const workingCandidates = toCurate.filter((c) => {
    const id = states.get(c.url)?.id ?? null;
    if (id !== null && removedIds.has(id)) {
      addDrop("removed");
      return false;
    }
    return true;
  });

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
          await adapter.onTerminalDrop(c, "extraction_insufficient", now);
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
              await adapter.onTerminalDrop(post, "retry_exhausted", now);
              addDrop("retry_exhausted");
            }
            continue;
          }

          // Title Gate (M1-1)
          const titleGate = filterTitle(post.originalTitle);
          if (!titleGate.ok) {
            if (postId !== null) {
              await markDropped(postId, "title_filter", now);
              await adapter.onTerminalDrop(post, "title_filter", now);
            }
            addDrop("title_filter");
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
              await adapter.onTerminalDrop(post, "retry_exhausted", now);
              addDrop("retry_exhausted");
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
          }

          for (const rec of publishedRecords) {
            if (markResult.succeeded.includes(rec.candidate.url)) {
              await recordPublication(rec.postId, now, rec.bodyHash, "surrogate");
              await adapter.buildFeedCard(rec.candidate, rec.result, rec.postId, rec.bodyHash, now);
              publishedCount++;
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

  if (options.onComplete) {
    await options.onComplete({
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
    });
  }

  return {
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
  };
}
