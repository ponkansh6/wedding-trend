import {
  completeRetry,
  enqueueRetry,
  getPostsByUrls,
  hashUrl,
  markCurated,
  markDropped,
  recordPublication,
  upsertPosts,
  withDropReasonDetail,
} from "@/lib/db/repository";
import type { CurationResult } from "@/lib/llm/batch";
import { computeContentHash, computeCurationSignature } from "@/lib/llm/signature";
import { decideDiscoveryRetry } from "@/lib/pipeline/discovery-retry";
import { registrableDomain } from "@/lib/pipeline/source-name";
import { EVERGREEN_SOURCE_ID, LLM_MODEL, RATIONALE_PROMPT_VERSION } from "@/lib/constants";
import type {
  DropReason,
  DropReasonBase,
  RetryQueueEntry,
  RetryReason,
  TrendTag,
} from "@/lib/types";
import type { EvidenceFailedCondition } from "@/lib/sources/article-text";

export interface RetryContext {
  urlHash: string;
  attempts: number;
  firstQueuedAt: string;
}

async function upsertPostRow(
  host: string,
  url: string,
  title: string,
  status: "published" | "rejected",
): Promise<boolean> {
  const sourceName = registrableDomain(url) ?? host;
  const result = await upsertPosts([
    {
      url,
      sourceType: "blog",
      sourceId: EVERGREEN_SOURCE_ID,
      sourceName,
      originalTitle: title,
      originalExcerpt: null,
      author: null,
      thumbnailUrl: null,
      publishedAt: null,
      status,
    },
  ]);
  if (result.failed.length > 0) {
    console.warn(`[discovery-ingest] upsert failed for ${url}`);
    return false;
  }
  return true;
}

function criteriaOf(curation: CurationResult) {
  return {
    firsthand: curation.firsthand,
    ceremonyDecision: curation.ceremonyDecision,
    specific: curation.specific,
    weddingDayContent: curation.weddingDayContent,
    promotional: curation.promotional,
  };
}

export async function dropPost(
  host: string,
  url: string,
  title: string | null,
  reason: DropReasonBase,
  now: string,
  failedConditions?: EvidenceFailedCondition[],
  detail?: string | null,
) {
  if (!(await upsertPostRow(host, url, title ?? url, "rejected"))) return;
  const states = await getPostsByUrls([url]);
  const postId = states.get(url)?.id;
  if (postId == null) {
    console.warn(`[discovery-ingest] post id lookup failed while dropping ${url}`);
    return;
  }
  let finalReason: DropReason = reason;
  if (reason === "extraction_insufficient") {
    if (failedConditions && failedConditions.length > 0) {
      finalReason = withDropReasonDetail(reason, failedConditions.join(","));
    } else {
      finalReason = withDropReasonDetail(reason, "unknown");
    }
  } else if (detail) {
    finalReason = withDropReasonDetail(reason, detail);
  }
  await markDropped(postId, finalReason, now);
}

export async function publishPost(
  host: string,
  url: string,
  title: string,
  curation: CurationResult,
  bodyHash: string,
  now: string,
  signals: { textLength: number; linkDensity: number; paragraphCount: number },
): Promise<boolean> {
  if (!(await upsertPostRow(host, url, title, "published"))) return false;

  const states = await getPostsByUrls([url]);
  const postId = states.get(url)?.id;
  if (postId == null) {
    console.warn(`[discovery-ingest] post id lookup failed for ${url}`);
    return false;
  }

  const mark = await markCurated([
    {
      url,
      aiSummary: curation.summary,
      category: curation.category,
      tag: "classic" as TrendTag,
      contentHash: computeContentHash(title, null),
      curationSignature: computeCurationSignature(),
      status: "published",
      usefulness: {
        postId,
        criteria: criteriaOf(curation),
        modelId: LLM_MODEL,
      },
      rationale: {
        postId,
        topicAnchor: curation.topicAnchor,
        rationaleText: curation.rationaleText,
        evidenceSufficient: true,
        modelId: LLM_MODEL,
        promptVersion: RATIONALE_PROMPT_VERSION,
      },
      topics: curation.topics,
      promptVersion: computeCurationSignature(),
    },
  ]);
  if (mark.failed.length > 0) {
    console.warn(`[discovery-ingest] markCurated failed for ${url}`);
    return false;
  }

  await recordPublication(
    postId,
    now,
    bodyHash,
    "body",
    signals.textLength,
    signals.linkDensity,
    signals.paragraphCount,
  );
  return true;
}

export async function retryOrGiveUp(
  host: string,
  url: string,
  reason: RetryReason,
  now: string,
  ctx: RetryContext | null,
): Promise<boolean> {
  const attempts = ctx?.attempts ?? 0;
  const decision = decideDiscoveryRetry({
    nowIso: now,
    attempts,
    firstQueuedAt: ctx?.firstQueuedAt ?? null,
  });

  if (decision.kind === "terminal") {
    if (ctx) await completeRetry(ctx.urlHash);
    return true;
  }

  const entry: RetryQueueEntry = {
    urlHash: ctx?.urlHash ?? hashUrl(url),
    url,
    host,
    lane: "discovery",
    reason,
    attempts: decision.attempts,
    firstQueuedAt: decision.firstQueuedAt,
    nextAttemptAt: decision.nextAttemptAt,
    expiresAt: decision.expiresAt,
  };
  await enqueueRetry(entry);
  return false;
}
