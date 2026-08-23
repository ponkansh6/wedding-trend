import {
  AI_SUMMARY_VALIDATE_MAX_CHARS,
  AI_TITLE_MAX_CHARS,
  EVERGREEN_SOURCE_ID,
  LLM_MODEL,
} from "@/lib/constants";
import { getPostsByUrls, markCurated, upsertPosts } from "@/lib/db/repository";
import { curateSingle, type CurationResult } from "@/lib/llm/batch";
import { computeContentHash, computeCurationSignature } from "@/lib/llm/signature";
import { fetchOgpMetadata, type OgpMetadata } from "@/lib/sources/ogp";
import type { Category, FeedCard, TrendTag } from "@/lib/types";
import { canonicalizeUrl } from "@/lib/url";

export type EvergreenOutcome = { ok: boolean; reason: string | null; card: FeedCard | null };

/**
 * 情報源名（クレジット）の解決。spec.md §10-2 の「著者名・情報源名を必ず表示する」
 * 要件を満たすため、実在しない媒体名は絶対に生成しない。
 * 解決順: 手動指定 (opts.sourceName) → og:site_name → URL の登録可能ドメイン。
 * いずれも得られない場合は null を返し、呼び出し側で保存を拒否する
 * （捏造したクレジットを出すくらいなら取り込まない）。
 */
export function resolveSourceName(
  canonical: string,
  meta: OgpMetadata,
  opts?: { sourceName?: string },
): string | null {
  const explicit = opts?.sourceName?.trim();
  if (explicit) return explicit;
  const siteName = meta.siteName?.trim();
  if (siteName) return siteName;
  return registrableDomain(canonical);
}

/** URL から登録可能ドメイン（www. 等のサブドメインを除いたホスト名）を取り出す。事実であり捏造にあたらない。 */
export function registrableDomain(canonical: string): string | null {
  try {
    const hostname = new URL(canonical).hostname;
    if (!hostname) return null;
    return hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

function buildFallbackCuration(title: string, excerpt: string): CurationResult {
  const fallbackTitle =
    title.length > AI_TITLE_MAX_CHARS ? title.slice(0, AI_TITLE_MAX_CHARS) : title;
  // P1-4: excerpt は hasSourceText ガード通過済み（非 null）のためそのまま要約枠に使う。
  // title へのフォールバックは行わない（§10-4 違反になるため）。
  const fallbackSummary =
    excerpt.length > AI_SUMMARY_VALIDATE_MAX_CHARS
      ? excerpt.slice(0, AI_SUMMARY_VALIDATE_MAX_CHARS)
      : excerpt;
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

/**
 * 原文テキストが存在しない場合の保存経路（spec.md §10-4 準拠）。
 * LLM は一切呼ばず、fetch 済みのメタデータ（再取得コストの回避）と url のみを
 * `status: "pending"` で保存する。aiTitle/aiSummary は null のままなので
 * `getFeedCards`（src/lib/db/query.ts）の対象外となり、運営が補足を添えて
 * 再投入するまでフィードには表示されない（意図した挙動）。
 */
async function saveEvergreenWithoutSourceText(
  canonical: string,
  title: string,
  meta: OgpMetadata,
  sourceName: string,
): Promise<EvergreenOutcome> {
  const upsertResult = await upsertPosts([
    {
      url: canonical,
      sourceType: "blog",
      sourceId: EVERGREEN_SOURCE_ID,
      sourceName,
      originalTitle: title,
      originalExcerpt: meta.description, // null
      author: meta.author ?? null,
      thumbnailUrl: meta.image ?? null,
      publishedAt: meta.datePublished ?? null,
      status: "pending",
    },
  ]);
  if (upsertResult.failed.length > 0) {
    return { ok: false, reason: "save_failed", card: null };
  }
  return { ok: true, reason: "needs_source_text", card: null };
}

export async function curateEvergreenUrl(
  url: string,
  opts?: { sourceName?: string },
): Promise<EvergreenOutcome> {
  const canonical = canonicalizeUrl(url);
  if (!canonical) return { ok: false, reason: "invalid_url", card: null };

  const meta = await fetchOgpMetadata(canonical);
  if (!meta || !meta.title) return { ok: false, reason: "no_metadata", card: null };

  // P2: クレジットを解決。解決不能なら捏造せずに拒否する。
  const sourceName = resolveSourceName(canonical, meta, opts);
  if (sourceName === null) return { ok: false, reason: "no_source_name", card: null };

  const sourceTitle = meta.title;
  const excerpt = meta.description;

  // P1: 原文テキスト（og:description）が無い場合は LLM を呼ばず pending で保存し、
  // 要約生成を防ぐ。title はラベルであり要約の材料にしない。
  if (!excerpt || !excerpt.trim()) {
    return saveEvergreenWithoutSourceText(canonical, sourceTitle, meta, sourceName);
  }

  const curationResult = await curateSingle({ title: sourceTitle, excerpt });
  const needsReview = curationResult === null;
  const finalCuration = curationResult ?? buildFallbackCuration(sourceTitle, excerpt);

  const upsertResult = await upsertPosts([
    {
      url: canonical,
      sourceType: "blog",
      sourceId: EVERGREEN_SOURCE_ID,
      sourceName,
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
    sourceName,
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
