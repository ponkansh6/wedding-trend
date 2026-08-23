import { AI_SUMMARY_VALIDATE_MAX_CHARS, AI_TITLE_MAX_CHARS } from "@/lib/constants";
import { getPostsByUrls, markCurated, saveEmbed, upsertPosts } from "@/lib/db/repository";
import { detectEmbedProvider } from "@/lib/embed/providers";
import { fetchOEmbed, type OEmbedResult } from "@/lib/embed/oembed";
import { curateSingle, type CurationResult } from "@/lib/llm/batch";
import { computeContentHash, computeCurationSignature } from "@/lib/llm/signature";
import type { Category, EmbedProvider, FeedCard, TrendTag } from "@/lib/types";
import { canonicalizeUrl } from "@/lib/url";

/**
 * SNS 単発投稿の取り込み結果。
 * `reason` は表示用文言そのものではなく、呼び出し側（Route Handler / Server Action）が
 * HTTP ステータスや日本語メッセージへ変換するための安定した内部コード。
 * - 失敗時: `"invalid_url"` | `"save_failed"`
 * - 成功時: `null`（特記事項なし）| `"needs_review"`（LLM キュレーションが
 *   失敗しフォールバック文言で保存された。エラーではなく要確認フラグ）|
 *   `"needs_source_text"`（要約対象となる原文テキストが存在せず、LLM を
 *   呼ばずに `status: "pending"` のまま保存した。card は null）
 */
export type SubmitOutcome = {
  ok: boolean;
  reason: string | null;
  card: FeedCard | null;
};

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
    // LLM が呼べていない（判定材料が無い）ため、5項目とも false に倒す
    // （spec.md §9.4 の「判断材料が無ければ false」と同じ方針）。
    firsthand: false,
    ceremonyDecision: false,
    specific: false,
    tradeoff: false,
    promotional: false,
    preDecisionOrPhotoShoot: false,
  };
}

/**
 * 要約対象となる原文テキストが存在しない場合の保存経路。
 * LLM は一切呼ばず、fetch 済みの embed（再取得コストの回避）と url のみを
 * `status: "pending"` で保存する。aiTitle/aiSummary は null のままなので
 * `getFeedCards`（src/lib/db/query.ts）の対象外となり、運営が「補足メモ」を
 * 追加して再投入するまでフィードには表示されない（意図した挙動）。
 */
async function submitWithoutSourceText(
  canonical: string,
  provider: EmbedProvider,
  embed: OEmbedResult | null,
): Promise<SubmitOutcome> {
  const now = new Date().toISOString();
  // ラベルであり要約ではないため、原文が無くても捏造にはあたらない。
  const placeholderTitle = "SNS 投稿";

  const upsertResult = await upsertPosts([
    {
      url: canonical,
      sourceType: "sns",
      sourceId: provider === "none" ? "sns" : provider,
      sourceName: PROVIDER_DISPLAY_NAME[provider],
      originalTitle: placeholderTitle,
      originalExcerpt: null,
      author: embed?.authorName ?? null,
      thumbnailUrl: embed?.thumbnailUrl ?? null,
      publishedAt: null,
      status: "pending",
    },
  ]);

  if (upsertResult.failed.length > 0) {
    return { ok: false, reason: "save_failed", card: null };
  }

  if (embed) {
    await saveEmbed(canonical, {
      embedProvider: embed.provider,
      embedHtml: embed.html,
      embedFetchedAt: now,
    });
  }

  // 保存自体は成功しているため ok: true。card は aiTitle/aiSummary が無く
  // FeedCard を構成できないため null（呼び出し側で「要確認」の文言に変換する）。
  return { ok: true, reason: "needs_source_text", card: null };
}

/**
 * SNS 投稿 URL を 1 件取り込む（oEmbed 取得 → LLM キュレーション → 保存 →
 * フィードキャッシュ失効）まで一気通貫で行う。`/api/submit-url` の Route Handler
 * （curl / 管理者投入）と `submitSnsUrl` Server Action（UI）の両方から呼ばれる
 * 唯一の実装。
 *
 * `note` は管理者が添えた補足であり原文ではないため、事実の補完には使わず
 * 追加コンテキストとして併記するに留める（UI からは渡されない想定・省略可）。
 *
 * Instagram のキーなし oEmbed は `title`（キャプション）を一切返さない
 * （2026-08-21 に実リクエストで確認済み）。embed にも note にも実体テキストが
 * 無い状態で LLM に要約させると、原文に存在しない内容を捏造してしまい
 * spec.md §9（法務制約: AI 要約は原文に無い内容を創作しない）に反する。
 * そのため「要約対象の原文テキストが存在するか」を LLM 呼び出しの前に判定し、
 * 存在しない場合は `curateSingle` を呼ばずに `status: "pending"` のまま保存する
 * （embed 自体は保存し、再取得コストを避ける）。
 */
export async function runSubmitUrl(url: string, note?: string): Promise<SubmitOutcome> {
  const canonical = canonicalizeUrl(url);
  if (!canonical) {
    return { ok: false, reason: "invalid_url", card: null };
  }

  const provider = detectEmbedProvider(canonical);
  const embed = await fetchOEmbed(canonical);

  // 空白のみの note は「補足なし」として扱う。
  const trimmedNote = note?.trim();
  const normalizedNote = trimmedNote && trimmedNote !== "" ? trimmedNote : null;

  const embedTitle = embed?.title && embed.title.trim() !== "" ? embed.title.trim() : null;

  // 原文由来のテキスト = oEmbed のキャプション（提供されれば）+ 運営が添えた補足メモ。
  // どちらも無ければ、LLM に渡せる実体テキストが存在しない。
  const hasSourceText = embedTitle !== null || normalizedNote !== null;

  if (!hasSourceText) {
    return submitWithoutSourceText(canonical, provider, embed);
  }

  // oEmbed のタイトル/キャプションと補足メモを「原文由来のテキスト」として LLM に渡す。
  const sourceTitle = embedTitle ?? normalizedNote ?? "SNS 投稿";
  const excerptParts = [embedTitle, normalizedNote].filter((v): v is string => v !== null);
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
    return { ok: false, reason: "save_failed", card: null };
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

  // `/` は force-dynamic（`src/app/page.tsx`）でキャッシュを経由しないため、
  // 以前ここにあったフィードキャッシュの明示的失効（revalidateTag）は不要になった。

  // 直前に確定させた値からそのまま FeedCard を組み立てる（再クエリせず、
  // キャッシュの反映タイミングに依存しない）。id のみ DB から取得する。
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

  return { ok: true, reason: needsReview ? "needs_review" : null, card };
}
