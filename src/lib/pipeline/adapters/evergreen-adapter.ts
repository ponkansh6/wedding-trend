/**
 * Purpose: Evergreen adapter implementing PipelineAdapter for the unified runPipeline.
 * When called: Part of S2 pipeline unification (Phase 4).
 */

import { EVERGREEN_SOURCE_ID } from "@/lib/constants";
import type {
  PipelineAdapter,
  PipelineCandidate,
  TerminalReason,
} from "@/lib/pipeline/run-pipeline";
import type { FeedCard, RetryContext } from "@/lib/types";
import type { CurationResult } from "@/lib/llm/batch";
import { canonicalizeUrl } from "@/lib/url";
import { dueRetries } from "@/lib/db/publication";
import { fetchOgpMetadata } from "@/lib/sources/ogp";
import { resolveSourceName } from "@/lib/pipeline/evergreen";

export class EvergreenAdapter implements PipelineAdapter {
  /**
   * Build candidates from an explicit URL list (event-driven fresh lane).
   * Fetches OGP metadata, resolves sourceName, skips invalid/no_metadata/no_source_name.
   * Includes excerpt-null entries so core can drop extraction_insufficient with post row.
   */
  async buildCandidates(urls: string[], sourceName?: string): Promise<PipelineCandidate[]> {
    const candidates: PipelineCandidate[] = [];
    for (const url of urls) {
      const canonical = canonicalizeUrl(url);
      if (!canonical) continue;
      const meta = await fetchOgpMetadata(canonical);
      if (!meta || !meta.title) continue;
      const resolved = resolveSourceName(canonical, meta, sourceName ? { sourceName } : undefined);
      if (!resolved) continue;
      candidates.push({
        url: canonical,
        originalTitle: meta.title,
        originalExcerpt: meta.description ?? null,
        sourceType: "blog",
        sourceId: EVERGREEN_SOURCE_ID,
        sourceName: resolved,
        publishedAt: meta.datePublished ?? null,
        author: meta.author ?? null,
        thumbnailUrl: meta.image ?? null,
      });
    }
    return candidates;
  }

  async fetchCandidates(_limit: number): Promise<PipelineCandidate[]> {
    // Event-driven lane: fresh submissions enter via buildCandidates + runPipelineOnCandidates directly.
    return [];
  }

  async fetchDueRetries(now: string): Promise<PipelineCandidate[]> {
    const due = await dueRetries(now, 50);
    const everDue = due.filter((e) => e.lane === "evergreen");
    const candidates: PipelineCandidate[] = [];
    for (const entry of everDue) {
      const canonical = canonicalizeUrl(entry.url) ?? entry.url;
      const meta = await fetchOgpMetadata(canonical);
      if (!meta || !meta.title) continue;
      const resolved = resolveSourceName(canonical, meta);
      if (!resolved) continue;
      candidates.push({
        url: canonical,
        originalTitle: meta.title,
        originalExcerpt: meta.description ?? null,
        sourceType: "blog",
        sourceId: EVERGREEN_SOURCE_ID,
        sourceName: resolved,
        publishedAt: meta.datePublished ?? null,
        author: meta.author ?? null,
        thumbnailUrl: meta.image ?? null,
        retry: {
          urlHash: entry.urlHash,
          attempts: entry.attempts,
          firstQueuedAt: entry.firstQueuedAt,
        } satisfies RetryContext,
      });
    }
    return candidates;
  }

  async onTransientFailure(
    _candidate: PipelineCandidate,
    _reason: "llm_transient" | "rate_capped",
    _ctx: RetryContext | null,
  ): Promise<void> {
    // core already enqueued; no adapter-specific side effect
  }

  async onTerminalDrop(
    _candidate: PipelineCandidate,
    _reason: TerminalReason,
    _now: string,
  ): Promise<void> {
    // Evergreen legacy leaves retry queue zombie on non-giveUp terminals; preserve parity.
  }

  async buildFeedCard(
    candidate: PipelineCandidate,
    curation: CurationResult,
    postId: number,
    _bodyHash: string,
    _now: string,
  ): Promise<FeedCard> {
    return {
      id: postId,
      sourceType: "blog",
      sourceId: EVERGREEN_SOURCE_ID,
      sourceName: candidate.sourceName,
      url: candidate.url,
      originalTitle: candidate.originalTitle,
      author: candidate.author ?? null,
      publishedAt: candidate.publishedAt ?? null,
      thumbnailUrl: candidate.thumbnailUrl ?? null,
      aiSummary: curation.summary,
      category: curation.category,
      tag: "classic",
      embedProvider: "none",
      embedHtml: null,
      topicAnchor: curation.topicAnchor,
      rationaleText: curation.rationaleText,
      usefulness: null,
    };
  }
}
