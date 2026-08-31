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
import { getPostsByUrls, upsertPosts } from "@/lib/db/repository";
import { registrableDomain } from "@/lib/pipeline/evergreen";
import { fetchOgpMetadata } from "@/lib/sources/ogp";
import { resolveSourceName } from "@/lib/pipeline/evergreen";

export class EvergreenAdapter implements PipelineAdapter {
  /**
   * Build candidates from an explicit URL list (event-driven fresh lane).
   * Fetches OGP metadata, resolves sourceName, skips invalid/no_metadata/no_source_name.
   * Includes excerpt-null entries so core can drop extraction_insufficient with post row.
   */
  async buildCandidates(urls: string[], sourceName?: string): Promise<PipelineCandidate[]> {
    const { candidates } = await this.buildCandidatesWithRejections(urls, sourceName);
    return candidates;
  }

  /**
   * `buildCandidates` と同じ選定ロジックだが、スキップした URL の理由
   * （旧 `curateEvergreenUrl` が返していた `invalid_url` / `no_metadata` /
   * `no_source_name`）も失わずに返す。管理者向け CLI
   * （`scripts/ops/submit-evergreen.mjs`）が URL ごとの結果を報告するために
   * 使う（S2 配線・shared_plan/17 Stage 6）。
   */
  async buildCandidatesWithRejections(
    urls: string[],
    sourceName?: string,
  ): Promise<{
    candidates: PipelineCandidate[];
    rejections: Array<{ url: string; reason: string }>;
  }> {
    const candidates: PipelineCandidate[] = [];
    const rejections: Array<{ url: string; reason: string }> = [];
    for (const url of urls) {
      const canonical = canonicalizeUrl(url);
      if (!canonical) {
        rejections.push({ url, reason: "invalid_url" });
        continue;
      }
      const meta = await fetchOgpMetadata(canonical);
      if (!meta || !meta.title) {
        rejections.push({ url, reason: "no_metadata" });
        continue;
      }
      const resolved = resolveSourceName(canonical, meta, sourceName ? { sourceName } : undefined);
      if (!resolved) {
        rejections.push({ url, reason: "no_source_name" });
        continue;
      }
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
    return { candidates, rejections };
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

  /**
   * 再試行キューの TTL 超過時に、終端棄却の記帳先となる post 行の id を返す。
   * 既存行があればその id をそのまま返し、**既存のカラムを一切上書きしない**。
   * 旧 `terminateEvergreenRetry` は無条件に `upsertPosts` を呼んでおり、
   * `updatableCrawlFields` が `originalTitle` を無条件上書きするため、
   * 既存の正常なタイトルを URL 文字列で潰していた（spec §10-3 の逐語タイトルに反する）。
   * ここでは「まず取得し、無い場合のみ作る」ことでその穴を塞いでいる。
   * OGP は再取得しない（失われた元データを補わない、という旧来の設計方針は維持）。
   */
  async ensureTombstonePost(url: string): Promise<number | null> {
    const canonical = canonicalizeUrl(url) ?? url;
    const existing = await getPostsByUrls([canonical]);
    const existingId = existing.get(canonical)?.id;
    if (existingId != null) return existingId;

    let host = "";
    try {
      host = new URL(canonical).host;
    } catch {
      // 不正 URL は host 空文字のまま扱う。
    }
    const sourceName = registrableDomain(canonical) ?? (host || "unknown");
    const upsertResult = await upsertPosts([
      {
        url: canonical,
        sourceType: "blog",
        sourceId: EVERGREEN_SOURCE_ID,
        sourceName,
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
