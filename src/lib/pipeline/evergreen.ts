import {
  AI_SUMMARY_VALIDATE_MAX_CHARS,
  AI_TITLE_MAX_CHARS,
  EVERGREEN_SOURCE_ID,
  LLM_MODEL,
} from "@/lib/constants";
import { getPostsByUrls, markCurated, upsertPosts } from "@/lib/db/repository";
import { curateSingle, type CurationResult } from "@/lib/llm/batch";
import { computeContentHash, computeCurationSignature } from "@/lib/llm/signature";
import { fetchOgpMetadata } from "@/lib/sources/ogp";
import type { Category, FeedCard, TrendTag } from "@/lib/types";
import { canonicalizeUrl } from "@/lib/url";

export type EvergreenOutcome = { ok: boolean; reason: string | null; card: FeedCard | null };

function buildFallbackCuration(title: string, excerpt: string | null): CurationResult {
  const fallbackTitle =
    title.length > AI_TITLE_MAX_CHARS ? title.slice(0, AI_TITLE_MAX_CHARS) : title;
  const summarySource = excerpt && excerpt.trim() !== "" ? excerpt : title;
  const fallbackSummary =
    summarySource.length > AI_SUMMARY_VALIDATE_MAX_CHARS
      ? summarySource.slice(0, AI_SUMMARY_VALIDATE_MAX_CHARS)
      : summarySource;
  return {
    title: fallbackTitle,
    summary: fallbackSummary,
    category: "その他" as Category,
    tag: "classic" as TrendTag,
    firsthand: false,
    ceremonyDecision: false,
    specific: false,
    tradeoff: false,
    promotional: false,
    preDecisionOrPhotoShoot: false,
  };
}

export async function curateEvergreenUrl(
  url: string,
  opts?: { sourceName?: string },
): Promise<EvergreenOutcome> {
  const canonical = canonicalizeUrl(url);
  if (!canonical) return { ok: false, reason: "invalid_url", card: null };

  const meta = await fetchOgpMetadata(canonical);
  if (!meta || !meta.title) return { ok: false, reason: "no_metadata", card: null };

  const sourceTitle = meta.title;
  const excerpt = meta.description;

  const curationResult = await curateSingle({ title: sourceTitle, excerpt });
  const needsReview = curationResult === null;
  const finalCuration = curationResult ?? buildFallbackCuration(sourceTitle, excerpt);

  const upsertResult = await upsertPosts([
    {
      url: canonical,
      sourceType: "blog",
      sourceId: EVERGREEN_SOURCE_ID,
      sourceName: opts?.sourceName ?? meta.siteName ?? "エバーグリーン",
      originalTitle: sourceTitle,
      originalExcerpt: excerpt,
      author: meta.author ?? null,
      thumbnailUrl: meta.image ?? null,
      publishedAt: meta.datePublished ?? null,
      status: needsReview ? "pending" : "published",
    },
  ]);
  if (upsertResult.failed.length > 0) return { ok: false, reason: "save_failed", card: null };

  const states = await getPostsByUrls([canonical]);
  const postId = states.get(canonical)?.id;

  const markResult = await markCurated([
    {
      url: canonical,
      aiTitle: finalCuration.title,
      aiSummary: finalCuration.summary,
      category: finalCuration.category,
      tag: "classic" as TrendTag,
      contentHash: computeContentHash(sourceTitle, excerpt),
      curationSignature: computeCurationSignature(),
      status: needsReview ? "pending" : "published",
      usefulness:
        postId != null
          ? {
              postId,
              criteria: {
                firsthand: finalCuration.firsthand,
                ceremonyDecision: finalCuration.ceremonyDecision,
                specific: finalCuration.specific,
                tradeoff: finalCuration.tradeoff,
                promotional: finalCuration.promotional,
                preDecisionOrPhotoShoot: finalCuration.preDecisionOrPhotoShoot,
              },
              modelId: LLM_MODEL,
            }
          : undefined,
    },
  ]);
  if (markResult.failed.length > 0) console.warn(`[evergreen] markCurated failed for ${canonical}`);

  const card: FeedCard = {
    id: postId ?? 0,
    sourceType: "blog",
    sourceId: EVERGREEN_SOURCE_ID,
    sourceName: opts?.sourceName ?? meta.siteName ?? "エバーグリーン",
    url: canonical,
    author: meta.author ?? null,
    publishedAt: meta.datePublished ?? null,
    thumbnailUrl: meta.image ?? null,
    aiTitle: finalCuration.title,
    aiSummary: finalCuration.summary,
    category: finalCuration.category,
    tag: "classic" as TrendTag,
    embedProvider: "none",
    embedHtml: null,
  };
  return { ok: true, reason: needsReview ? "needs_review" : null, card };
}
