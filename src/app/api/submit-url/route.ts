import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { isBearerAuthorized } from "@/lib/auth";
import { AI_SUMMARY_VALIDATE_MAX_CHARS, AI_TITLE_MAX_CHARS, FEED_CACHE_TAG } from "@/lib/constants";
import { getPostsByUrls, markCurated, saveEmbed, upsertPosts } from "@/lib/db/repository";
import { detectEmbedProvider } from "@/lib/embed/providers";
import { fetchOEmbed } from "@/lib/embed/oembed";
import { curateSingle, type CurationResult } from "@/lib/llm/batch";
import { computeContentHash, computeCurationSignature } from "@/lib/llm/signature";
import type { Category, EmbedProvider, FeedCard, TrendTag } from "@/lib/types";
import { canonicalizeUrl } from "@/lib/url";

interface SubmitUrlBody {
  url: string;
  note?: string;
}

function parseBody(raw: unknown): SubmitUrlBody | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.url !== "string" || body.url.trim() === "") return null;
  return {
    url: body.url,
    note: typeof body.note === "string" && body.note.trim() !== "" ? body.note : undefined,
  };
}

const PROVIDER_DISPLAY_NAME: Record<EmbedProvider, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  none: "SNS",
};

/**
 * LLM キュレーションに失敗した場合のフォールバック。
 * FeedCard は aiTitle/aiSummary/category/tag が非 null 必須のため、原文由来の
 * テキストをそのまま切り詰めて埋める。カテゴリ/タグは安全側の既定値とし、
 * status を "pending" にすることで「要確認」として扱う（表示上のフラグ）。
 */
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
  };
}

export async function POST(request: Request) {
  if (!isBearerAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawBody: unknown = await request.json().catch(() => null);
  const body = parseBody(rawBody);
  if (!body) {
    return NextResponse.json(
      { error: "invalid body: expected { url: string, note?: string }" },
      { status: 400 },
    );
  }

  const canonical = canonicalizeUrl(body.url);
  if (!canonical) {
    return NextResponse.json({ error: "invalid url" }, { status: 400 });
  }

  const provider = detectEmbedProvider(canonical);
  const embed = await fetchOEmbed(canonical);

  // oEmbed のタイトル/キャプションを「原文由来のテキスト」として LLM に渡す。
  // note は管理者が添えた補足であり原文ではないため、事実の補完には使わず
  // 追加コンテキストとして併記するに留める。
  const sourceTitle = embed?.title ?? body.note ?? "SNS 投稿";
  const excerptParts = [embed?.title, body.note].filter(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  const excerpt = excerptParts.length > 0 ? excerptParts.join("\n") : null;

  const curationResult = await curateSingle({ title: sourceTitle, excerpt });
  const needsReview = curationResult === null;
  const finalCuration = curationResult ?? buildFallbackCuration(sourceTitle, excerpt);

  const now = new Date().toISOString();

  const upsertResult = await upsertPosts([
    {
      url: canonical,
      sourceType: "sns",
      sourceId: provider === "none" ? "sns" : provider,
      sourceName: PROVIDER_DISPLAY_NAME[provider],
      originalTitle: sourceTitle,
      originalExcerpt: excerpt,
      author: embed?.authorName ?? null,
      thumbnailUrl: embed?.thumbnailUrl ?? null,
      // oEmbed は投稿日時を返さないため不明扱い。
      publishedAt: null,
      status: needsReview ? "pending" : "published",
    },
  ]);

  if (upsertResult.failed.length > 0) {
    return NextResponse.json({ error: "failed to save post" }, { status: 500 });
  }

  const markResult = await markCurated([
    {
      url: canonical,
      aiTitle: finalCuration.title,
      aiSummary: finalCuration.summary,
      category: finalCuration.category,
      tag: finalCuration.tag,
      contentHash: computeContentHash(sourceTitle, excerpt),
      curationSignature: computeCurationSignature(),
      status: needsReview ? "pending" : "published",
    },
  ]);

  if (markResult.failed.length > 0) {
    console.warn(`[submit-url] markCurated failed for ${canonical}`);
  }

  if (embed) {
    await saveEmbed(canonical, {
      embedProvider: embed.provider,
      embedHtml: embed.html,
      embedFetchedAt: now,
    });
  }

  revalidateTag(FEED_CACHE_TAG, { expire: 0 });

  // 直前に確定させた値からそのまま FeedCard を組み立てる（再クエリせず、
  // キャッシュの反映タイミングに依存しない）。
  const states = await getPostsByUrls([canonical]);
  const state = states.get(canonical);

  const card: FeedCard = {
    id: state?.id ?? 0,
    sourceType: "sns",
    sourceId: provider === "none" ? "sns" : provider,
    sourceName: PROVIDER_DISPLAY_NAME[provider],
    url: canonical,
    author: embed?.authorName ?? null,
    publishedAt: null,
    thumbnailUrl: embed?.thumbnailUrl ?? null,
    aiTitle: finalCuration.title,
    aiSummary: finalCuration.summary,
    category: finalCuration.category,
    tag: finalCuration.tag,
    embedProvider: embed?.provider ?? "none",
    embedHtml: embed?.html ?? null,
  };

  return NextResponse.json({
    ok: true,
    needsReview,
    card,
    createdAt: state?.createdAt ?? now,
  });
}
