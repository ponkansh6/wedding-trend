/**
 * Purpose: RSS adapter implementing PipelineAdapter for the unified runPipeline.
 * When called: Part of S2 pipeline unification.
 */

import { SOURCE_IDS, SOURCE_REGISTRY, type SourceAdapter } from "@/lib/sources/registry";
import type {
  PipelineAdapter,
  PipelineCandidate,
  TerminalReason,
} from "@/lib/pipeline/run-pipeline";
import type { FeedCard, RetryContext } from "@/lib/types";
import { RETRY_MAX_ATTEMPTS } from "@/lib/constants";
import { completeRetry, getPostsByUrls, type PostUpsertInput } from "@/lib/db/repository";
import type { CurationResult } from "@/lib/llm/batch";
import { canonicalizeUrl } from "@/lib/url";
import { dueRetries } from "@/lib/db/publication";
import { getStaleCurationCandidates } from "@/lib/db/ingest";
import { computeContentHash, computeCurationSignature } from "@/lib/llm/signature";
import { db } from "@/lib/db";
import { posts } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";

const SOURCE_ITEM_LIMIT = 30;

async function fetchAndNormalize(id: (typeof SOURCE_IDS)[number]): Promise<PostUpsertInput[]> {
  const adapter = SOURCE_REGISTRY[id] as unknown as SourceAdapter<unknown>;
  try {
    const items = await adapter.fetch(SOURCE_ITEM_LIMIT);
    return items.map((item) => adapter.toPost(item));
  } catch (err) {
    console.error(`[rss-adapter] source "${id}" failed:`, err);
    throw err;
  }
}

async function fetchPostSources(urls: string[]): Promise<
  Map<
    string,
    {
      sourceType: "blog" | "sns";
      sourceId: string;
      sourceName: string;
      author: string | null;
      thumbnailUrl: string | null;
    }
  >
> {
  if (urls.length === 0) return new Map();
  const rows = await db
    .select({
      url: posts.url,
      sourceType: posts.sourceType,
      sourceId: posts.sourceId,
      sourceName: posts.sourceName,
      author: posts.author,
      thumbnailUrl: posts.thumbnailUrl,
    })
    .from(posts)
    .where(inArray(posts.url, urls));
  const map = new Map<
    string,
    {
      sourceType: "blog" | "sns";
      sourceId: string;
      sourceName: string;
      author: string | null;
      thumbnailUrl: string | null;
    }
  >();
  for (const row of rows) {
    map.set(row.url, {
      sourceType: (row.sourceType === "sns" ? "sns" : "blog") as "blog" | "sns",
      sourceId: row.sourceId,
      sourceName: row.sourceName,
      author: row.author,
      thumbnailUrl: row.thumbnailUrl,
    });
  }
  return map;
}

export class RssAdapter implements PipelineAdapter {
  /**
   * 直近の `fetchCandidates()` 呼び出しで、全ソースから取得できた生アイテム数
   * （重複排除・キュレーション要否フィルタ適用前）。旧 `runIngest` の
   * `IngestSummary.fetched`（= `rawPosts.length`）と同じ意味の値を
   * 呼び出し元（`ingest.ts`）が読み出せるようにするための副産物フィールド。
   * `PipelineSummary.fetched`（= `rawCandidates.length` = フィルタ後の候補数）
   * とは意味が異なるため、こちらを別途公開する。
   */
  lastRawFetchedCount = 0;

  /**
   * 直近の `fetchCandidates()` 呼び出しで発生したソース取得エラー
   * （旧 `runIngest` の `errors.push(\`${id}: ...\`)` と同一メッセージ形式）。
   * `PipelineSummary.errors` には現れない（コアの `fetchCandidates()` 呼び出しは
   * try/catch で丸ごと失敗をハンドルする設計のため、アダプタ内部で個別ソース
   * ごとに catch した失敗はコアへ伝播しない）ので、呼び出し元（`ingest.ts`）が
   * これを読み出して `errors` に合流させる。
   */
  lastFetchErrors: string[] = [];

  async fetchCandidates(limit: number): Promise<PipelineCandidate[]> {
    this.lastFetchErrors = [];
    const perSource = await Promise.all(
      SOURCE_IDS.map(async (id) => {
        try {
          return await fetchAndNormalize(id);
        } catch (err) {
          this.lastFetchErrors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
          return [] as PostUpsertInput[];
        }
      }),
    );
    const rawPosts = perSource.flat();
    this.lastRawFetchedCount = rawPosts.length;

    const seen = new Set<string>();
    const deduplicated: PostUpsertInput[] = [];
    for (const p of rawPosts) {
      const canonical = canonicalizeUrl(p.url);
      if (!canonical || seen.has(canonical)) continue;
      seen.add(canonical);
      // legacy runIngest と同一: URL を正規化後の値に置き換えてから使用する
      deduplicated.push({ ...p, url: canonical });
    }

    deduplicated.sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    });

    const urls = deduplicated.map((p) => p.url);
    const statesMap = await getPostsByUrls(urls);
    const currentSignature = computeCurationSignature();

    const freshCandidates: PipelineCandidate[] = [];
    for (const post of deduplicated) {
      const state = statesMap.get(post.url);
      const contentHash = computeContentHash(post.originalTitle, post.originalExcerpt ?? "");
      const needsCuration =
        !state ||
        !state.aiTitle ||
        state.contentHash !== contentHash ||
        state.curationSignature !== currentSignature;

      if (needsCuration) {
        freshCandidates.push({
          url: post.url,
          originalTitle: post.originalTitle,
          originalExcerpt: post.originalExcerpt,
          sourceType: post.sourceType,
          sourceId: post.sourceId,
          sourceName: post.sourceName,
          publishedAt: post.publishedAt,
          author: post.author,
          thumbnailUrl: post.thumbnailUrl,
        });
      }
    }

    const remainingBudget = Math.max(0, limit - freshCandidates.length);
    let staleCandidates: PipelineCandidate[] = [];
    if (remainingBudget > 0) {
      const staleRaw = await getStaleCurationCandidates({
        currentSignature,
        limit: remainingBudget + freshCandidates.length,
      });
      const freshUrls = new Set(freshCandidates.map((c) => c.url));
      const filteredStale = staleRaw.filter((c) => !freshUrls.has(c.url)).slice(0, remainingBudget);

      if (filteredStale.length > 0) {
        const staleUrls = filteredStale.map((c) => c.url);
        const sourceMap = await fetchPostSources(staleUrls);
        staleCandidates = filteredStale.map((s) => {
          const src = sourceMap.get(s.url);
          return {
            url: s.url,
            originalTitle: s.originalTitle,
            originalExcerpt: s.originalExcerpt,
            sourceType: src?.sourceType ?? "blog",
            sourceId: src?.sourceId ?? "hatena-bookmark",
            sourceName: src?.sourceName ?? "はてなブックマーク",
            publishedAt: s.publishedAt,
            author: src?.author ?? null,
            thumbnailUrl: src?.thumbnailUrl ?? null,
          };
        });
      }
    }

    return [...freshCandidates, ...staleCandidates].slice(0, limit);
  }

  async fetchDueRetries(_now: string): Promise<PipelineCandidate[]> {
    const due = await dueRetries(_now, 50);
    const rssDue = due.filter((e) => e.lane === "rss");
    const candidates: PipelineCandidate[] = [];

    for (const entry of rssDue) {
      const statesMap = await getPostsByUrls([entry.url]);
      const state = statesMap.get(entry.url);
      if (!state || state.id == null) {
        await completeRetry(entry.urlHash);
        continue;
      }
      const sourceMap = await fetchPostSources([entry.url]);
      const src = sourceMap.get(entry.url);

      candidates.push({
        url: entry.url,
        originalTitle: state.originalTitle,
        originalExcerpt: state.originalExcerpt,
        sourceType: src?.sourceType ?? "blog",
        sourceId: src?.sourceId ?? "hatena-bookmark",
        sourceName: src?.sourceName ?? "はてなブックマーク",
        publishedAt: state.publishedAt,
        author: src?.author ?? null,
        thumbnailUrl: src?.thumbnailUrl ?? null,
        retry: {
          urlHash: entry.urlHash,
          attempts: entry.attempts,
          firstQueuedAt: entry.firstQueuedAt,
        },
      });
    }

    return candidates;
  }

  /**
   * RSS レーンは post 行を新規作成しない（post 行が既に存在する前提）。
   * 既存行があればその id を返し、無ければ null（旧
   * `processDueAndExpiredRetries` の rss 分岐と同じ「行が無ければ何もしない」）。
   */
  async ensureTombstonePost(url: string): Promise<number | null> {
    const canonical = canonicalizeUrl(url) ?? url;
    const states = await getPostsByUrls([canonical]);
    return states.get(canonical)?.id ?? null;
  }

  async onTransientFailure(
    candidate: PipelineCandidate,
    reason: "llm_transient" | "rate_capped",
    ctx: RetryContext | null,
  ): Promise<void> {
    const attempts = ctx?.attempts ?? 0;
    const nextAttempts = attempts + 1;
    if (nextAttempts > RETRY_MAX_ATTEMPTS) {
      if (ctx) {
        await completeRetry(ctx.urlHash);
      }
    }
    if (reason === "rate_capped") {
      // ログ等の付加処理があればここに記載
    }
  }

  async onTerminalDrop(
    candidate: PipelineCandidate,
    _reason: TerminalReason,
    _now: string,
  ): Promise<void> {
    if (candidate.retry) {
      await completeRetry(candidate.retry.urlHash);
    }
  }

  async buildFeedCard(
    candidate: PipelineCandidate,
    curation: CurationResult,
    postId: number,
    _bodyHash: string,
    _now: string,
  ): Promise<FeedCard> {
    if (candidate.retry) {
      await completeRetry(candidate.retry.urlHash);
    }
    return {
      id: postId,
      sourceType: candidate.sourceType,
      sourceId: candidate.sourceId,
      sourceName: candidate.sourceName,
      url: candidate.url,
      originalTitle: candidate.originalTitle,
      author: candidate.author ?? null,
      publishedAt: candidate.publishedAt ?? null,
      thumbnailUrl: candidate.thumbnailUrl ?? null,
      aiSummary: curation.summary,
      category: curation.category,
      tag: curation.tag,
      embedProvider: "none",
      embedHtml: null,
      topicAnchor: curation.topicAnchor,
      rationaleText: curation.rationaleText,
      usefulness: null,
    };
  }
}
