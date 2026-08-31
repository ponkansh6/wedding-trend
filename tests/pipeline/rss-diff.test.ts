/**
 * Purpose: Diff test comparing legacy runIngest vs runPipeline(rssAdapter).
 * When called: Vitest suite execution.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { setupTestDb } from "../../tests/helpers/test-db";
import { runIngest } from "@/lib/pipeline/ingest";
import { runPipeline, runPipelineOnCandidates } from "@/lib/pipeline/run-pipeline";
import { RssAdapter } from "@/lib/pipeline/adapters/rss-adapter";
import { db } from "@/lib/db";
import { posts, postPublications, postRetryQueue, postRemovals } from "@/lib/db/schema";
import { computeCurationSignature, computeContentHash } from "@/lib/llm/signature";
import { hashUrl } from "@/lib/db/repository";

const { hatenaFetch, hatenaToPost, googleNewsFetch, googleNewsToPost } = vi.hoisted(() => ({
  hatenaFetch: vi.fn(),
  hatenaToPost: vi.fn(),
  googleNewsFetch: vi.fn(),
  googleNewsToPost: vi.fn(),
}));

vi.mock("@/lib/sources/registry", () => ({
  SOURCE_IDS: ["hatena-bookmark", "google-news"],
  SOURCE_REGISTRY: {
    "hatena-bookmark": {
      fetch: hatenaFetch,
      toPost: hatenaToPost,
    },
    "google-news": {
      fetch: googleNewsFetch,
      toPost: googleNewsToPost,
    },
  },
}));

vi.mock("@/lib/llm/batch", () => ({
  curatePosts: vi.fn((inputs: Array<{ title: string; excerpt: string | null }>) =>
    Promise.resolve({
      results: inputs.map((input) => ({
        title: `AI: ${input.title}`,
        summary: `AI summary for ${input.title}`,
        category: "その他",
        tag: "trend",
        firsthand: 2,
        ceremonyDecision: 2,
        specific: 2,
        weddingDayContent: 0,
        promotional: 0,
        topicAnchor: input.title,
        rationaleText: "十分な体験に基づく具体的な考察が含まれており有用であると判断される",
        evidenceSufficient: true,
      })),
      geminiCalls: 1,
    }),
  ),
}));

describe("RSS Ingest Diff Test: legacy runIngest vs runPipeline", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // 両実行（legacy / runPipeline）の壁時計を同一に固定し、
    // publishedAt 等のタイムスタンプ比較を決定的にする
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    await setupTestDb();

    hatenaFetch.mockResolvedValue([{ title: "Blog Post 1", link: "https://example.com/blog1" }]);
    hatenaToPost.mockReturnValue({
      url: "https://example.com/blog1",
      sourceType: "blog",
      sourceId: "hatena-bookmark",
      sourceName: "はてなブックマーク",
      originalTitle: "Blog Post 1",
      originalExcerpt: "Excerpt 1",
      author: "Author 1",
      thumbnailUrl: null,
      publishedAt: "2024-01-01T00:00:00.000Z",
    });

    googleNewsFetch.mockResolvedValue([{ title: "News 1", link: "https://example.com/news1" }]);
    googleNewsToPost.mockReturnValue({
      url: "https://example.com/news1",
      sourceType: "blog",
      sourceId: "google-news",
      sourceName: "Google ニュース",
      originalTitle: "News 1",
      originalExcerpt: "Excerpt 2",
      author: "Author 2",
      thumbnailUrl: null,
      publishedAt: "2024-01-02T00:00:00.000Z",
    });
  });

  it("produces identical DB states between legacy runIngest and runPipeline(rssAdapter)", async () => {
    // Run (a): legacy runIngest
    await runIngest("manual");
    const postsA = await db.select().from(posts);
    const pubsA = await db.select().from(postPublications);
    const retryA = await db.select().from(postRetryQueue);
    const removalsA = await db.select().from(postRemovals);

    // Reset DB and run (b): runPipeline with RssAdapter
    await setupTestDb();

    const adapter = new RssAdapter();
    await runPipeline(adapter, {
      curationBudget: 10,
      dailyPublishCap: 150,
      jstDayStartIso: "2024-01-01T00:00:00.000Z",
      curationSignature: computeCurationSignature(),
      retryMaxAttempts: 3,
      retryBackoffHours: [1, 2, 4],
      retryTtlHours: 24,
      lane: "rss",
      enforceRemovedFilter: true,
      enforceRateCap: true,
    });

    const postsB = await db.select().from(posts);
    const pubsB = await db.select().from(postPublications);
    const retryB = await db.select().from(postRetryQueue);
    const removalsB = await db.select().from(postRemovals);

    // Compare omitting dynamic fields like id/timestamps if needed, or strict deep equal
    const normalizeForComparison = (rows: any[]) =>
      rows
        .map((r) => {
          const copy = { ...r };
          delete copy.id;
          // postId は posts.id への参照。挿入順の artifact（リトライ時の
          // rowid 焼却・upsert 順の違い）で legacy と新経路で値がずれるため、
          // 公開レコードは bodyHash（候補コンテンツの surrogate ハッシュ）と
          // publishedAt の集合として等価検証する。
          delete copy.postId;
          delete copy.createdAt;
          delete copy.updatedAt;
          delete copy.publishedAtEpoch;
          return copy;
        })
        // テーブル行の並び順は挿入順の artifact（upsert 順が legacy と
        // 新経路で異なるため）。内容が同一集合なら等価と見なす。
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    expect(normalizeForComparison(postsB)).toEqual(normalizeForComparison(postsA));
    expect(normalizeForComparison(pubsB)).toEqual(normalizeForComparison(pubsA));
    expect(normalizeForComparison(retryB)).toEqual(normalizeForComparison(retryA));
    expect(normalizeForComparison(removalsB)).toEqual(normalizeForComparison(removalsA));
  });

  it("produces identical DB states for stale backfill parity", async () => {
    hatenaFetch.mockResolvedValue([]);
    googleNewsFetch.mockResolvedValue([]);

    await db.insert(posts).values({
      url: "https://example.com/stale1",
      sourceType: "blog",
      sourceId: "hatena-bookmark",
      sourceName: "はてなブックマーク",
      originalTitle: "Old Post",
      originalExcerpt: "Old Excerpt",
      author: "Old Author",
      thumbnailUrl: null,
      publishedAt: "2023-12-15T00:00:00.000Z",
      aiTitle: "Old AI Title",
      contentHash: computeContentHash("Old Post", "Old Excerpt"),
      curationSignature: "v0-old-signature",
      status: "published",
    });

    await runIngest("manual");
    const postsA = await db.select().from(posts);
    const pubsA = await db.select().from(postPublications);
    const retryA = await db.select().from(postRetryQueue);
    const removalsA = await db.select().from(postRemovals);

    await setupTestDb();
    await db.insert(posts).values({
      url: "https://example.com/stale1",
      sourceType: "blog",
      sourceId: "hatena-bookmark",
      sourceName: "はてなブックマーク",
      originalTitle: "Old Post",
      originalExcerpt: "Old Excerpt",
      author: "Old Author",
      thumbnailUrl: null,
      publishedAt: "2023-12-15T00:00:00.000Z",
      aiTitle: "Old AI Title",
      contentHash: computeContentHash("Old Post", "Old Excerpt"),
      curationSignature: "v0-old-signature",
      status: "published",
    });

    const adapter = new RssAdapter();
    await runPipeline(adapter, {
      curationBudget: 10,
      dailyPublishCap: 150,
      jstDayStartIso: "2024-01-01T00:00:00.000Z",
      curationSignature: computeCurationSignature(),
      retryMaxAttempts: 3,
      retryBackoffHours: [1, 2, 4],
      retryTtlHours: 24,
      lane: "rss",
      enforceRemovedFilter: true,
      enforceRateCap: true,
    });

    const postsB = await db.select().from(posts);
    const pubsB = await db.select().from(postPublications);
    const retryB = await db.select().from(postRetryQueue);
    const removalsB = await db.select().from(postRemovals);

    const normalizeForComparison = (rows: any[]) =>
      rows
        .map((r) => {
          const copy = { ...r };
          delete copy.id;
          // postId は posts.id への参照。挿入順の artifact（リトライ時の
          // rowid 焼却・upsert 順の違い）で legacy と新経路で値がずれるため、
          // 公開レコードは bodyHash（候補コンテンツの surrogate ハッシュ）と
          // publishedAt の集合として等価検証する。
          delete copy.postId;
          delete copy.createdAt;
          delete copy.updatedAt;
          delete copy.publishedAtEpoch;
          return copy;
        })
        // テーブル行の並び順は挿入順の artifact（upsert 順が legacy と
        // 新経路で異なるため）。内容が同一集合なら等価と見なす。
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    expect(normalizeForComparison(postsB)).toEqual(normalizeForComparison(postsA));
    expect(normalizeForComparison(pubsB)).toEqual(normalizeForComparison(pubsA));
    expect(normalizeForComparison(retryB)).toEqual(normalizeForComparison(retryA));
    expect(normalizeForComparison(removalsB)).toEqual(normalizeForComparison(removalsA));
  });

  it("produces identical DB states for retry-due consumption parity", async () => {
    await db.insert(posts).values({
      url: "https://example.com/retry1",
      sourceType: "blog",
      sourceId: "hatena-bookmark",
      sourceName: "はてなブックマーク",
      originalTitle: "Retry Post",
      originalExcerpt: "Retry Excerpt",
      author: null,
      thumbnailUrl: null,
      publishedAt: "2023-12-20T00:00:00.000Z",
      aiTitle: null,
      contentHash: null,
      curationSignature: null,
      status: "published",
    });
    await db.insert(postRetryQueue).values({
      urlHash: hashUrl("https://example.com/retry1"),
      url: "https://example.com/retry1",
      host: "example.com",
      lane: "rss",
      reason: "rate_capped",
      attempts: 1,
      firstQueuedAt: "2023-12-31T00:00:00.000Z",
      nextAttemptAt: "2023-12-31T12:00:00.000Z",
      expiresAt: "2024-01-31T00:00:00.000Z",
    });

    await runIngest("manual");
    const postsA = await db.select().from(posts);
    const pubsA = await db.select().from(postPublications);
    const retryA = await db.select().from(postRetryQueue);
    const removalsA = await db.select().from(postRemovals);

    await setupTestDb();
    await db.insert(posts).values({
      url: "https://example.com/retry1",
      sourceType: "blog",
      sourceId: "hatena-bookmark",
      sourceName: "はてなブックマーク",
      originalTitle: "Retry Post",
      originalExcerpt: "Retry Excerpt",
      author: null,
      thumbnailUrl: null,
      publishedAt: "2023-12-20T00:00:00.000Z",
      aiTitle: null,
      contentHash: null,
      curationSignature: null,
      status: "published",
    });
    await db.insert(postRetryQueue).values({
      urlHash: hashUrl("https://example.com/retry1"),
      url: "https://example.com/retry1",
      host: "example.com",
      lane: "rss",
      reason: "rate_capped",
      attempts: 1,
      firstQueuedAt: "2023-12-31T00:00:00.000Z",
      nextAttemptAt: "2023-12-31T12:00:00.000Z",
      expiresAt: "2024-01-31T00:00:00.000Z",
    });

    const adapter = new RssAdapter();
    const options = {
      curationBudget: 10,
      dailyPublishCap: 150,
      jstDayStartIso: "2024-01-01T00:00:00.000Z",
      curationSignature: computeCurationSignature(),
      retryMaxAttempts: 3,
      retryBackoffHours: [1, 2, 4],
      retryTtlHours: 24,
      lane: "rss" as const,
      enforceRemovedFilter: true,
      enforceRateCap: true,
    };

    const retryCandidates = await adapter.fetchDueRetries("2024-01-01T00:00:00.000Z");
    expect(retryCandidates.length).toBe(1);
    expect(retryCandidates[0].retry?.attempts).toBe(1);

    await runPipelineOnCandidates(retryCandidates, adapter, options);
    await runPipeline(adapter, options);

    const postsB = await db.select().from(posts);
    const pubsB = await db.select().from(postPublications);
    const retryB = await db.select().from(postRetryQueue);
    const removalsB = await db.select().from(postRemovals);

    const normalizeForComparison = (rows: any[]) =>
      rows
        .map((r) => {
          const copy = { ...r };
          delete copy.id;
          // postId は posts.id への参照。挿入順の artifact（リトライ時の
          // rowid 焼却・upsert 順の違い）で legacy と新経路で値がずれるため、
          // 公開レコードは bodyHash（候補コンテンツの surrogate ハッシュ）と
          // publishedAt の集合として等価検証する。
          delete copy.postId;
          delete copy.createdAt;
          delete copy.updatedAt;
          delete copy.publishedAtEpoch;
          return copy;
        })
        // テーブル行の並び順は挿入順の artifact（upsert 順が legacy と
        // 新経路で異なるため）。内容が同一集合なら等価と見なす。
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    expect(normalizeForComparison(postsB)).toEqual(normalizeForComparison(postsA));
    expect(normalizeForComparison(pubsB)).toEqual(normalizeForComparison(pubsA));
    expect(normalizeForComparison(retryB)).toEqual(normalizeForComparison(retryA));
    expect(normalizeForComparison(removalsB)).toEqual(normalizeForComparison(removalsA));
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
