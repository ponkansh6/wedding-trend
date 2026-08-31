/**
 * Purpose: Submit (SNS) adapter implementing PipelineAdapter for the unified runPipeline.
 * When called: Part of S2 pipeline unification (Phase 5).
 */

import type {
  PipelineAdapter,
  PipelineCandidate,
  TerminalReason,
} from "@/lib/pipeline/run-pipeline";
import type { FeedCard, RetryContext } from "@/lib/types";
import type { CurationResult } from "@/lib/llm/batch";
import { canonicalizeUrl } from "@/lib/url";
import { dueRetries } from "@/lib/db/publication";
import { fetchOEmbed } from "@/lib/embed/oembed";
import { detectEmbedProvider } from "@/lib/embed/providers";
import { getPostsByUrls, upsertPosts } from "@/lib/db/repository";
import type { EmbedProvider } from "@/lib/types";

const PROVIDER_DISPLAY_NAME: Record<EmbedProvider, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  none: "SNS",
};

export class SubmitAdapter implements PipelineAdapter {
  /**
   * Build candidates from explicit URL list (optionally with a note).
   * Mirrors runSubmitUrl source-text handling for parity.
   */
  async buildCandidates(urls: string[], note?: string): Promise<PipelineCandidate[]> {
    const trimmedNote = note?.trim();
    const normalizedNote = trimmedNote && trimmedNote !== "" ? trimmedNote : null;
    const candidates: PipelineCandidate[] = [];

    for (const url of urls) {
      const canonical = canonicalizeUrl(url);
      if (!canonical) continue;
      const provider = detectEmbedProvider(canonical);
      const embed = await fetchOEmbed(canonical);
      const embedTitle = embed?.title && embed.title.trim() !== "" ? embed.title.trim() : null;
      const hasSourceText = embedTitle !== null || normalizedNote !== null;

      if (!hasSourceText) {
        candidates.push({
          url: canonical,
          originalTitle: "SNS 投稿",
          originalExcerpt: null,
          sourceType: "sns",
          sourceId: provider === "none" ? "sns" : provider,
          sourceName: PROVIDER_DISPLAY_NAME[provider],
          publishedAt: null,
          author: embed?.authorName ?? null,
          thumbnailUrl: embed?.thumbnailUrl ?? null,
          embedProvider: embed?.provider ?? "none",
          embedHtml: embed?.html ?? null,
          embedFetched: embed !== null,
          note: normalizedNote,
        });
        continue;
      }

      const sourceTitle = embedTitle ?? normalizedNote ?? "SNS 投稿";
      const excerptParts = [embedTitle, normalizedNote].filter((v): v is string => v !== null);
      const excerpt = excerptParts.length > 0 ? excerptParts.join("\n") : null;

      candidates.push({
        url: canonical,
        originalTitle: sourceTitle,
        originalExcerpt: excerpt,
        sourceType: "sns",
        sourceId: provider === "none" ? "sns" : provider,
        sourceName: PROVIDER_DISPLAY_NAME[provider],
        publishedAt: null,
        author: embed?.authorName ?? null,
        thumbnailUrl: embed?.thumbnailUrl ?? null,
        embedProvider: embed?.provider ?? "none",
        embedHtml: embed?.html ?? null,
        embedFetched: embed !== null,
        note: normalizedNote,
      });
    }
    return candidates;
  }

  async fetchCandidates(_limit: number): Promise<PipelineCandidate[]> {
    return [];
  }

  async fetchDueRetries(now: string): Promise<PipelineCandidate[]> {
    const due = await dueRetries(now, 50);
    const submitDue = due.filter((e) => e.lane === "submit");
    const candidates: PipelineCandidate[] = [];
    for (const entry of submitDue) {
      const canonical = canonicalizeUrl(entry.url) ?? entry.url;
      const provider = detectEmbedProvider(canonical);
      const embed = await fetchOEmbed(canonical);
      const embedTitle = embed?.title && embed.title.trim() !== "" ? embed.title.trim() : null;
      // Note is not persisted in retry queue (known constraint) -> treat as null on retry
      const hasSourceText = embedTitle !== null;
      let originalTitle: string;
      let originalExcerpt: string | null;
      if (!hasSourceText) {
        originalTitle = "SNS 投稿";
        originalExcerpt = null;
      } else {
        originalTitle = embedTitle!;
        originalExcerpt = embedTitle;
      }

      candidates.push({
        url: canonical,
        originalTitle,
        originalExcerpt,
        sourceType: "sns",
        sourceId: provider === "none" ? "sns" : provider,
        sourceName: PROVIDER_DISPLAY_NAME[provider],
        publishedAt: null,
        author: embed?.authorName ?? null,
        thumbnailUrl: embed?.thumbnailUrl ?? null,
        embedProvider: embed?.provider ?? "none",
        embedHtml: embed?.html ?? null,
        embedFetched: embed !== null,
        retry: {
          urlHash: entry.urlHash,
          attempts: entry.attempts,
          firstQueuedAt: entry.firstQueuedAt,
        } satisfies RetryContext,
      });
    }
    return candidates;
  }

  /**
   * 既存 post 行があればその id を返し（**フィールドは一切上書きしない**。
   * 旧 `terminateSubmitRetry` は `upsertSubmitRow`（内部で `upsertPosts`）を
   * 無条件に呼ぶため、既存の正常な `originalTitle` を URL 文字列で上書き
   * するバグを持っていた。まず取得を試み、無い場合にのみ作成する）。
   * 無ければ canonical URL と embed provider から最小行を作成する。
   * oEmbed を再取得しない（旧実装と同じ）。
   */
  async ensureTombstonePost(url: string): Promise<number | null> {
    const canonical = canonicalizeUrl(url) ?? url;
    const existing = await getPostsByUrls([canonical]);
    const existingId = existing.get(canonical)?.id;
    if (existingId != null) return existingId;

    const provider = detectEmbedProvider(canonical);
    const upsertResult = await upsertPosts([
      {
        url: canonical,
        sourceType: "sns",
        sourceId: provider === "none" ? "sns" : provider,
        sourceName: PROVIDER_DISPLAY_NAME[provider],
        originalTitle: canonical,
        originalExcerpt: null,
        author: null,
        thumbnailUrl: null,
        publishedAt: null,
      },
    ]);
    if (upsertResult.failed.length > 0) return null;
    const states = await getPostsByUrls([canonical]);
    return states.get(canonical)?.id ?? null;
  }

  async onTransientFailure(
    _candidate: PipelineCandidate,
    _reason: "llm_transient" | "rate_capped",
    _ctx: RetryContext | null,
  ): Promise<void> {}

  async onTerminalDrop(
    _candidate: PipelineCandidate,
    _reason: TerminalReason,
    _now: string,
  ): Promise<void> {}

  async buildFeedCard(
    candidate: PipelineCandidate,
    curation: CurationResult,
    postId: number,
    _bodyHash: string,
    _now: string,
  ): Promise<FeedCard> {
    return {
      id: postId,
      sourceType: "sns",
      sourceId: candidate.sourceId,
      sourceName: candidate.sourceName,
      url: candidate.url,
      originalTitle: candidate.originalTitle,
      author: candidate.author ?? null,
      publishedAt: null,
      thumbnailUrl: candidate.thumbnailUrl ?? null,
      aiSummary: curation.summary,
      category: curation.category,
      tag: curation.tag,
      embedProvider: (candidate.embedProvider as FeedCard["embedProvider"]) ?? "none",
      embedHtml: candidate.embedHtml ?? null,
      topicAnchor: null,
      rationaleText: null,
      usefulness: null,
    };
  }
}
