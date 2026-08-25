import { describe, expect, it, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { posts, postUsefulnessCriteria } from "@/lib/db/schema";
import {
  upsertPosts,
  getPostsByUrls,
  markCurated,
  saveEmbed,
  getStaleCurationCandidates,
  savePostRationale,
  getRationaleByPostId,
  markRetracted,
  markDropped,
  isRemoved,
  filterRemoved,
  recordPublication,
  listPublishedForRevalidation,
  reapStaleNonTerminal,
  enqueueRetry,
  dueRetries,
  completeRetry,
  expireRetries,
  countPublishedSince,
  countPublishedSinceByHost,
  findPostByUrlForRetraction,
  listPublishedByHostForRetraction,
} from "@/lib/db/repository";
import { postRemovals } from "@/lib/db/schema";
import type { RetryQueueEntry } from "@/lib/types";
import { getFeedCards } from "@/lib/db/query";
import { setupTestDb } from "./helpers/test-db";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: any) => fn,
  revalidateTag: vi.fn(),
}));

/** テストで使い回す標準的な blog 投稿の upsert 入力。 */
function blogPostInput(url: string, publishedAt: string | null) {
  return {
    url,
    sourceType: "blog" as const,
    sourceId: "note",
    sourceName: "note",
    originalTitle: `Title ${url}`,
    originalExcerpt: "excerpt",
    author: "Author",
    thumbnailUrl: null,
    publishedAt,
  };
}

describe("Database Repository and Queries", () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  // Run migration once before all tests in this suite
  it("applies migration and tests upsert and queries", async () => {
    await setupTestDb();

    // 1. Test empty inputs
    expect(await upsertPosts([])).toEqual({ succeeded: [], failed: [] });
    expect(await getPostsByUrls([])).toEqual(new Map());
    expect(await markCurated([])).toEqual({ succeeded: [], failed: [] });

    // 2. Test upsertPosts (insert new)
    const upsertRes = await upsertPosts([
      {
        url: "https://example.com/post1",
        sourceType: "blog",
        sourceId: "hatena",
        sourceName: "Hatena",
        originalTitle: "Original Title 1",
        originalExcerpt: "Excerpt 1",
        author: "Author 1",
        thumbnailUrl: "https://example.com/t1.jpg",
        publishedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);
    expect(upsertRes.succeeded).toContain("https://example.com/post1");
    expect(upsertRes.failed).toHaveLength(0);

    // 3. Test getPostsByUrls
    const stateMap = await getPostsByUrls([
      "https://example.com/post1",
      "https://example.com/nonexistent",
    ]);
    expect(stateMap.size).toBe(1);
    const postState = stateMap.get("https://example.com/post1");
    expect(postState?.originalTitle).toBe("Original Title 1");
    expect(postState?.aiTitle).toBeNull();
    const postId = postState!.id;

    // 4. Test markCurated（post_usefulness も同一トランザクションで書き込まれることを確認）
    const markRes = await markCurated([
      {
        url: "https://example.com/post1",
        aiTitle: "AI Title 1",
        aiSummary: "AI Summary 1",
        category: "その他",
        tag: "trend",
        contentHash: "hash1",
        curationSignature: "sig1",
        usefulness: {
          postId,
          modelId: "test-model",
          criteria: {
            firsthand: true,
            ceremonyDecision: true,
            specific: true,
            tradeoff: false,
            promotional: false,
            preDecisionOrPhotoShoot: false,
          },
        },
      },
    ]);
    expect(markRes.succeeded).toContain("https://example.com/post1");

    const usefulnessRows = await db
      .select()
      .from(postUsefulnessCriteria)
      .where(eq(postUsefulnessCriteria.postId, postId));
    expect(usefulnessRows).toHaveLength(1);
    expect(usefulnessRows[0].postId).toBe(postId);
    expect(JSON.parse(usefulnessRows[0].criteriaJson)).toEqual({
      firsthand: true,
      ceremonyDecision: true,
      specific: true,
      tradeoff: false,
      promotional: false,
      preDecisionOrPhotoShoot: false,
    });
    expect(usefulnessRows[0].signature).toBe("sig1");
    expect(usefulnessRows[0].modelId).toBe("test-model");

    // 5. Test saveEmbed
    const embedRes = await saveEmbed("https://example.com/post1", {
      embedProvider: "instagram",
      embedHtml: "<div>embed</div>",
      embedFetchedAt: "2024-01-01T00:00:00.000Z",
    });
    expect(embedRes).toBe(true);

    // 6. Test getFeedCards (query published & curated posts)
    const feedCards = await getFeedCards({ sourceType: "blog", limit: 10 });
    expect(feedCards.length).toBe(1);
    expect(feedCards[0].originalTitle).toBe("Original Title 1");
    expect(feedCards[0].embedProvider).toBe("instagram");

    // 7. Test upsertPosts (update existing crawl fields)
    const updateRes = await upsertPosts([
      {
        url: "https://example.com/post1",
        sourceType: "blog",
        sourceId: "hatena",
        sourceName: "Hatena Updated",
        originalTitle: "Original Title 1 Updated",
        originalExcerpt: "Excerpt 1 Updated",
        author: "Author 1",
        thumbnailUrl: null,
        publishedAt: null,
      },
    ]);
    expect(updateRes.succeeded).toContain("https://example.com/post1");
  });

  it("markCurated without `usefulness` updates posts but writes no post_usefulness row (SNS single curation path)", async () => {
    await upsertPosts([
      {
        url: "https://example.com/sns1",
        sourceType: "sns",
        sourceId: "instagram",
        sourceName: "Instagram",
        originalTitle: "SNS post",
        originalExcerpt: null,
        author: "Author",
        thumbnailUrl: null,
        publishedAt: null,
      },
    ]);

    const markRes = await markCurated([
      {
        url: "https://example.com/sns1",
        aiTitle: "AI Title",
        aiSummary: "AI Summary",
        category: "その他",
        tag: "trend",
        contentHash: "hash",
        curationSignature: "sig",
      },
    ]);
    expect(markRes.succeeded).toContain("https://example.com/sns1");

    const usefulnessRows = await db.select().from(postUsefulnessCriteria);
    expect(usefulnessRows).toHaveLength(0);
  });

  it("T3: getFeedCards excludes posts whose aiSummary is null even when curated otherwise", async () => {
    await upsertPosts([
      {
        url: "https://example.com/summary-null",
        sourceType: "blog",
        sourceId: "evergreen",
        sourceName: "Example",
        originalTitle: "T3 Title",
        originalExcerpt: "excerpt",
        author: null,
        thumbnailUrl: null,
        publishedAt: null,
      },
    ]);
    await markCurated([
      {
        url: "https://example.com/summary-null",
        aiTitle: "AI Title",
        aiSummary: "AI Summary",
        category: "その他",
        tag: "classic",
        contentHash: "hash",
        curationSignature: "sig",
        status: "published",
      },
    ]);
    // 異常系: aiSummary のみ欠落した部分データ破損を直接作る。
    // aiTitle / category / tag が揃っていても、aiSummary が無い投稿はフィードに出てはならない。
    await db
      .update(posts)
      .set({ aiSummary: null })
      .where(eq(posts.url, "https://example.com/summary-null"));

    const cards = await getFeedCards({ sourceType: "blog", limit: 10 });
    expect(cards.find((c) => c.url === "https://example.com/summary-null")).toBeUndefined();
  });

  it("P5: evergreen posts (sourceId 'evergreen') are included in the blog feed lane via sourceId", async () => {
    await upsertPosts([
      {
        url: "https://example.com/evergreen-feed",
        sourceType: "blog",
        sourceId: "evergreen",
        sourceName: "Example",
        originalTitle: "Evergreen Title",
        originalExcerpt: "excerpt",
        author: "Author",
        thumbnailUrl: null,
        publishedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    await markCurated([
      {
        url: "https://example.com/evergreen-feed",
        aiTitle: "AI Title",
        aiSummary: "AI Summary",
        category: "その他",
        tag: "classic",
        contentHash: "hash",
        curationSignature: "sig",
        status: "published",
      },
    ]);
    const cards = await getFeedCards({ sourceType: "blog", limit: 10 });
    expect(cards.find((c) => c.url === "https://example.com/evergreen-feed")).toBeDefined();
  });

  it("handles database errors and fail-soft fallbacks gracefully", async () => {
    // Drop table to cause query errors
    await db.run(sql.raw("DROP TABLE posts;"));

    // getPostsByUrls should catch error and return empty map
    const urlsMap = await getPostsByUrls(["https://example.com/post1"]);
    expect(urlsMap.size).toBe(0);

    // getFeedCards should catch error and return []
    const cards = await getFeedCards({ sourceType: "blog", limit: 10 });
    expect(cards).toEqual([]);

    // getStaleCurationCandidates should catch error and return []
    const candidates = await getStaleCurationCandidates({ currentSignature: "x", limit: 10 });
    expect(candidates).toEqual([]);

    // saveEmbed should catch error and return false
    const embedOk = await saveEmbed("https://example.com/post1", {
      embedProvider: "none",
      embedHtml: null,
      embedFetchedAt: "2024-01-01T00:00:00Z",
    });
    expect(embedOk).toBe(false);

    // upsertPosts and markCurated should fail fallback when table doesn't exist
    const upsertRes = await upsertPosts([
      {
        url: "https://example.com/fail",
        sourceType: "blog",
        sourceId: "x",
        sourceName: "x",
        originalTitle: "t",
        originalExcerpt: null,
        author: null,
        thumbnailUrl: null,
        publishedAt: null,
      },
    ]);
    expect(upsertRes.failed).toContain("https://example.com/fail");

    const markRes = await markCurated([
      {
        url: "https://example.com/fail",
        aiTitle: "a",
        aiSummary: "s",
        category: "その他",
        tag: "trend",
        contentHash: "h",
        curationSignature: "s",
      },
    ]);
    expect(markRes.failed).toContain("https://example.com/fail");
  });

  describe("getStaleCurationCandidates", () => {
    it("returns [] immediately for limit <= 0 without querying", async () => {
      const candidates = await getStaleCurationCandidates({ currentSignature: "sig", limit: 0 });
      expect(candidates).toEqual([]);
    });

    it("selects blog posts with a missing/mismatched curationSignature, ordered by publishedAt desc, excluding sns posts and up-to-date posts", async () => {
      await upsertPosts([
        blogPostInput("https://example.com/never-curated", "2024-01-01T00:00:00.000Z"),
        blogPostInput("https://example.com/up-to-date", "2024-01-05T00:00:00.000Z"),
        blogPostInput("https://example.com/stale-signature", "2024-01-10T00:00:00.000Z"),
        {
          url: "https://example.com/sns-post",
          sourceType: "sns",
          sourceId: "instagram",
          sourceName: "Instagram",
          originalTitle: "SNS",
          originalExcerpt: null,
          author: null,
          thumbnailUrl: null,
          publishedAt: "2024-01-20T00:00:00.000Z",
        },
      ]);

      await markCurated([
        {
          url: "https://example.com/up-to-date",
          aiTitle: "AI",
          aiSummary: "Summary",
          category: "その他",
          tag: "trend",
          contentHash: "hash",
          curationSignature: "current",
        },
        {
          url: "https://example.com/stale-signature",
          aiTitle: "AI",
          aiSummary: "Summary",
          category: "その他",
          tag: "trend",
          contentHash: "hash",
          curationSignature: "old",
        },
        {
          // sourceType が sns の投稿は、たとえ signature が古くても対象外
          // （有用度スコアは体験談レーンにしか使わないため）。
          url: "https://example.com/sns-post",
          aiTitle: "AI",
          aiSummary: "Summary",
          category: "その他",
          tag: "trend",
          contentHash: "hash",
          curationSignature: "old",
        },
      ]);

      const candidates = await getStaleCurationCandidates({
        currentSignature: "current",
        limit: 10,
      });
      expect(candidates.map((c) => c.url)).toEqual([
        "https://example.com/stale-signature",
        "https://example.com/never-curated",
      ]);
    });

    it("returns [] on query error (fail-soft)", async () => {
      await db.run(sql.raw("DROP TABLE posts;"));
      const candidates = await getStaleCurationCandidates({ currentSignature: "x", limit: 10 });
      expect(candidates).toEqual([]);
    });
  });

  describe("getFeedCards ordering", () => {
    it("blog lane: orders by weighted usefulness score desc, then publishedAt desc; unscored posts use UNSCORED_USEFULNESS_SCORE", async () => {
      await upsertPosts([
        blogPostInput("https://example.com/a", "2024-01-01T00:00:00.000Z"),
        blogPostInput("https://example.com/b", "2024-01-02T00:00:00.000Z"),
        blogPostInput("https://example.com/b2", "2024-01-05T00:00:00.000Z"),
        blogPostInput("https://example.com/d", "2024-01-03T00:00:00.000Z"),
        blogPostInput("https://example.com/p", "2024-01-06T00:00:00.000Z"),
        blogPostInput("https://example.com/c", "2024-01-10T00:00:00.000Z"),
      ]);

      const states = await getPostsByUrls([
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/b2",
        "https://example.com/d",
        "https://example.com/p",
        "https://example.com/c",
      ]);

      const buildUpdate = (
        url: string,
        criteria: {
          firsthand: boolean;
          ceremonyDecision: boolean;
          specific: boolean;
          tradeoff: boolean;
          promotional: boolean;
          preDecisionOrPhotoShoot: boolean;
        } | null,
      ) => ({
        url,
        aiTitle: `AI ${url}`,
        aiSummary: "AI Summary text long enough for the fixture",
        category: "その他" as const,
        tag: "trend" as const,
        contentHash: "hash",
        curationSignature: "sig",
        ...(criteria
          ? {
              usefulness: {
                postId: states.get(url)!.id,
                modelId: "test-model",
                criteria,
              },
            }
          : {}),
      });

      await markCurated([
        // score = 12(gate) + 3(firsthand) + 2(specific) + 2(tradeoff) = 19
        buildUpdate("https://example.com/a", {
          firsthand: true,
          ceremonyDecision: true,
          specific: true,
          tradeoff: true,
          promotional: false,
          preDecisionOrPhotoShoot: false,
        }),
        // score = 12(gate) = 12
        buildUpdate("https://example.com/b", {
          firsthand: false,
          ceremonyDecision: true,
          specific: false,
          tradeoff: false,
          promotional: false,
          preDecisionOrPhotoShoot: false,
        }),
        // score = 12(gate) = 12（b と同点。publishedAt が新しい方が先）
        buildUpdate("https://example.com/b2", {
          firsthand: false,
          ceremonyDecision: true,
          specific: false,
          tradeoff: false,
          promotional: false,
          preDecisionOrPhotoShoot: false,
        }),
        // ceremonyDecision=false のためゲート不通過: 3+2+2 = 7 に留まる
        // （preDecisionOrPhotoShoot=false なので独立減点も無し）
        buildUpdate("https://example.com/d", {
          firsthand: true,
          ceremonyDecision: false,
          specific: true,
          tradeoff: true,
          promotional: false,
          preDecisionOrPhotoShoot: false,
        }),
        // preDecisionOrPhotoShoot=true のためゲート不通過かつ独立減点も乗る:
        // 3+2+2-3(preDecisionPenalty) = 4。publishedAt は 01-06 で d(01-03) より
        // 新しいが、独立減点により d(7) より下に沈む（今回の仕様変更の核心）。
        buildUpdate("https://example.com/p", {
          firsthand: true,
          ceremonyDecision: true,
          specific: true,
          tradeoff: true,
          promotional: false,
          preDecisionOrPhotoShoot: true,
        }),
        // 有用度未スコア（post_usefulness 行なし）: UNSCORED_USEFULNESS_SCORE(3) 扱い
        buildUpdate("https://example.com/c", null),
      ]);

      const feedCards = await getFeedCards({ sourceType: "blog", limit: 10 });
      expect(feedCards.map((c) => c.url)).toEqual([
        "https://example.com/a",
        "https://example.com/b2",
        "https://example.com/b",
        "https://example.com/d",
        "https://example.com/p",
        "https://example.com/c",
      ]);
    });

    it("sns lane: ignores usefulness and keeps createdAt (newest-first) order", async () => {
      await upsertPosts([
        {
          url: "https://example.com/sns-old",
          sourceType: "sns",
          sourceId: "instagram",
          sourceName: "Instagram",
          originalTitle: "old",
          originalExcerpt: null,
          author: null,
          thumbnailUrl: null,
          publishedAt: null,
        },
      ]);
      // createdAt はミリ秒未満での逆転を避けるため、2件目を明示的に後で挿入する。
      await new Promise((resolve) => setTimeout(resolve, 5));
      await upsertPosts([
        {
          url: "https://example.com/sns-new",
          sourceType: "sns",
          sourceId: "instagram",
          sourceName: "Instagram",
          originalTitle: "new",
          originalExcerpt: null,
          author: null,
          thumbnailUrl: null,
          publishedAt: null,
        },
      ]);

      await markCurated([
        {
          url: "https://example.com/sns-old",
          aiTitle: "old",
          aiSummary: "old summary",
          category: "その他",
          tag: "trend",
          contentHash: "hash",
          curationSignature: "sig",
        },
        {
          url: "https://example.com/sns-new",
          aiTitle: "new",
          aiSummary: "new summary",
          category: "その他",
          tag: "trend",
          contentHash: "hash",
          curationSignature: "sig",
        },
      ]);

      const feedCards = await getFeedCards({ sourceType: "sns", limit: 10 });
      expect(feedCards.map((c) => c.url)).toEqual([
        "https://example.com/sns-new",
        "https://example.com/sns-old",
      ]);
    });
  });

  describe("Post rationales and evidenceSufficient gating", () => {
    it("saves and retrieves post rationale with roundtrip and idempotent overwrite", async () => {
      await setupTestDb();
      await upsertPosts([
        {
          url: "https://example.com/rat1",
          sourceType: "blog",
          sourceId: "note",
          sourceName: "note",
          originalTitle: "Title 1",
          originalExcerpt: "Excerpt 1",
          author: null,
          thumbnailUrl: null,
          publishedAt: null,
        },
      ]);
      const states = await getPostsByUrls(["https://example.com/rat1"]);
      const postId = states.get("https://example.com/rat1")?.id;
      expect(postId).toBeDefined();

      await savePostRationale(postId!, {
        topicAnchor: "トピックA",
        rationaleText:
          "実際の体験に基づく会場選びや進行プロセスにおける具体的な工夫と背景についての客観的な振り返りを行う非常に有用な記事内容である",
        evidenceSufficient: true,
        modelId: "gemini-3.1-flash-lite",
        promptVersion: "rationale-v1",
      });

      let rationale = await getRationaleByPostId(postId!);
      expect(rationale).not.toBeNull();
      expect(rationale?.topicAnchor).toBe("トピックA");
      expect(rationale?.evidenceSufficient).toBe(true);
      expect(rationale?.modelId).toBe("gemini-3.1-flash-lite");
      expect(rationale?.promptVersion).toBe("rationale-v1");

      // Idempotent overwrite
      await savePostRationale(postId!, {
        topicAnchor: "トピックB",
        rationaleText:
          "実際の体験に基づく会場選びや進行プロセスにおける具体的な工夫と背景についての客観的な振り返りを行う非常に有用な記事内容である",
        evidenceSufficient: true,
        modelId: "gemini-3.1-flash-lite",
        promptVersion: "rationale-v1",
      });

      rationale = await getRationaleByPostId(postId!);
      expect(rationale?.topicAnchor).toBe("トピックB");
    });

    it("evidenceSufficient=false leaves post as rejected (not visible via getFeedCards) and saves no rationale", async () => {
      await setupTestDb();
      await upsertPosts([
        {
          url: "https://example.com/rat2",
          sourceType: "blog",
          sourceId: "note",
          sourceName: "note",
          originalTitle: "Title 2",
          originalExcerpt: "Excerpt 2",
          author: null,
          thumbnailUrl: null,
          publishedAt: null,
          status: "rejected",
        },
      ]);
      const states = await getPostsByUrls(["https://example.com/rat2"]);
      const postId = states.get("https://example.com/rat2")?.id;

      await markCurated([
        {
          url: "https://example.com/rat2",
          aiSummary: "summary 2",
          category: "その他",
          tag: "classic",
          contentHash: "hash2",
          curationSignature: "sig2",
          status: "rejected",
        },
      ]);

      const rationale = await getRationaleByPostId(postId!);
      expect(rationale).toBeNull();

      const feedCards = await getFeedCards({ sourceType: "blog", limit: 10 });
      expect(feedCards.some((c) => c.url === "https://example.com/rat2")).toBe(false);
    });

    it("getFeedCards returns rationale and usefulness data when present, and nulls when absent", async () => {
      await setupTestDb();
      await upsertPosts([
        {
          url: "https://example.com/full-card",
          sourceType: "blog",
          sourceId: "note",
          sourceName: "note",
          originalTitle: "Full Card Title",
          originalExcerpt: "excerpt",
          author: "Author",
          thumbnailUrl: null,
          publishedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          url: "https://example.com/empty-card",
          sourceType: "blog",
          sourceId: "note",
          sourceName: "note",
          originalTitle: "Empty Card Title",
          originalExcerpt: "excerpt",
          author: "Author",
          thumbnailUrl: null,
          publishedAt: "2024-01-01T00:00:00.000Z",
        },
      ]);

      const stateMap = await getPostsByUrls([
        "https://example.com/full-card",
        "https://example.com/empty-card",
      ]);
      const fullId = stateMap.get("https://example.com/full-card")!.id;

      await markCurated([
        {
          url: "https://example.com/full-card",
          aiTitle: "AI Full",
          aiSummary: "Summary Full",
          category: "演出・進行",
          tag: "trend",
          contentHash: "h1",
          curationSignature: "sig1",
          usefulness: {
            postId: fullId,
            modelId: "m1",
            criteria: {
              firsthand: true,
              ceremonyDecision: true,
              specific: false,
              tradeoff: true,
              promotional: false,
              preDecisionOrPhotoShoot: false,
            },
          },
        },
        {
          url: "https://example.com/empty-card",
          aiTitle: "AI Empty",
          aiSummary: "Summary Empty",
          category: "演出・進行",
          tag: "trend",
          contentHash: "h2",
          curationSignature: "sig2",
        },
      ]);

      await savePostRationale(fullId, {
        topicAnchor: "アンカー1",
        rationaleText: "これは判定根拠のテスト文章です。",
        evidenceSufficient: true,
        modelId: "m1",
        promptVersion: "v1",
      });

      const cards = await getFeedCards({ sourceType: "blog", limit: 10 });
      expect(cards.length).toBe(2);

      const fullCard = cards.find((c) => c.url === "https://example.com/full-card");
      const emptyCard = cards.find((c) => c.url === "https://example.com/empty-card");

      expect(fullCard).toBeDefined();
      expect(fullCard?.topicAnchor).toBe("アンカー1");
      expect(fullCard?.rationaleText).toBe("これは判定根拠のテスト文章です。");
      expect(fullCard?.usefulness).toEqual({
        firsthand: true,
        ceremonyDecision: true,
        specific: false,
        tradeoff: true,
        promotional: false,
        preDecisionOrPhotoShoot: false,
      });

      expect(emptyCard).toBeDefined();
      expect(emptyCard?.topicAnchor).toBeNull();
      expect(emptyCard?.rationaleText).toBeNull();
      expect(emptyCard?.usefulness).toBeNull();
    });
  });

  describe("feed visibility phases", () => {
    it("filters posts correctly according to phase1 and phase2 rules", async () => {
      // 1. legacy post: aiTitle & aiSummary populated, NO rationale
      const r1 = await upsertPosts([
        blogPostInput("https://example.com/legacy", "2024-01-01T00:00:00.000Z"),
      ]);
      const legacyId = (await getPostsByUrls(["https://example.com/legacy"])).get(
        "https://example.com/legacy",
      )!.id;
      await markCurated([
        {
          url: "https://example.com/legacy",
          aiTitle: "Legacy Title",
          aiSummary: "Legacy Summary",
          category: "その他",
          tag: "trend",
          contentHash: "h-legacy",
          curationSignature: "sig",
        },
      ]);

      // 2. rationale-only post: aiTitle/aiSummary NULL, WITH rationale row
      await upsertPosts([
        blogPostInput("https://example.com/rationale-only", "2024-01-02T00:00:00.000Z"),
      ]);
      const ratOnlyId = (await getPostsByUrls(["https://example.com/rationale-only"])).get(
        "https://example.com/rationale-only",
      )!.id;
      await db
        .update(posts)
        .set({
          status: "published",
          publishedAt: "2024-01-02T00:00:00.000Z",
          aiTitle: null,
          aiSummary: null,
          category: "その他",
          tag: "trend",
        })
        .where(eq(posts.id, ratOnlyId));
      await savePostRationale(ratOnlyId, {
        topicAnchor: "Anchor",
        rationaleText: "Rationale text",
        evidenceSufficient: true,
        modelId: "m1",
        promptVersion: "v1",
      });

      // 3. bare post: neither pair nor rationale
      await upsertPosts([blogPostInput("https://example.com/bare", "2024-01-03T00:00:00.000Z")]);
      const bareId = (await getPostsByUrls(["https://example.com/bare"])).get(
        "https://example.com/bare",
      )!.id;
      await db
        .update(posts)
        .set({ status: "published", publishedAt: "2024-01-03T00:00:00.000Z" })
        .where(eq(posts.id, bareId));

      // Phase 1: shows legacy + rationale-only, hides bare
      const p1Cards = await getFeedCards({ sourceType: "blog", limit: 10, phase: "phase1" });
      const p1Urls = p1Cards.map((c) => c.url);
      expect(p1Urls).toContain("https://example.com/legacy");
      expect(p1Urls).toContain("https://example.com/rationale-only");
      expect(p1Urls).not.toContain("https://example.com/bare");

      // Phase 2: shows only rationale-only, hides legacy and bare
      const p2Cards = await getFeedCards({ sourceType: "blog", limit: 10, phase: "phase2" });
      const p2Urls = p2Cards.map((c) => c.url);
      expect(p2Urls).not.toContain("https://example.com/legacy");
      expect(p2Urls).toContain("https://example.com/rationale-only");
      expect(p2Urls).not.toContain("https://example.com/bare");
    });
  });

  describe("plan 07: unattended-operation data layer (§5-M4 / §7 / Q4, 副表方式)", () => {
    async function insertPublished(url: string) {
      await upsertPosts([blogPostInput(url, "2026-01-01T00:00:00.000Z")]);
      const states = await getPostsByUrls([url]);
      const id = states.get(url)!.id;
      await db.update(posts).set({ status: "published" }).where(eq(posts.id, id));
      return id;
    }

    it("markRetracted writes post_removals(kind=retracted) and syncs posts.status, and is sticky against upsertPosts/markCurated re-writes", async () => {
      const url = "https://retract.example.com/a";
      const id = await insertPublished(url);

      await markRetracted(id, "source_gone", "2026-01-06T00:00:00.000Z");

      let row = (await db.select().from(posts).where(eq(posts.id, id)))[0];
      expect(row.status).toBe("retracted");
      let removal = (await db.select().from(postRemovals).where(eq(postRemovals.postId, id)))[0];
      expect(removal.kind).toBe("retracted");
      expect(removal.reason).toBe("source_gone");
      expect(removal.removedAt).toBe("2026-01-06T00:00:00.000Z");

      // 再クロール（既存 URL の upsert）が status を published に戻さないこと（sticky）。
      await upsertPosts([blogPostInput(url, "2026-01-01T00:00:00.000Z")]);
      row = (await db.select().from(posts).where(eq(posts.id, id)))[0];
      expect(row.status).toBe("retracted");

      // markCurated が status: "published" を渡しても、除去済み post には反映されないこと
      // （sticky 性の保証点。markCurated 内の removal ガード）。
      await markCurated([
        {
          url,
          aiSummary: "summary",
          category: "その他",
          tag: "classic",
          contentHash: "h",
          curationSignature: "s",
          status: "published",
        },
      ]);
      row = (await db.select().from(posts).where(eq(posts.id, id)))[0];
      expect(row.status).toBe("retracted");
    });

    it("markDropped is idempotent: calling it twice with different reasons keeps the first reason (irreversibility)", async () => {
      await upsertPosts([blogPostInput("https://drop.example.com/a", null)]);
      const states = await getPostsByUrls(["https://drop.example.com/a"]);
      const id = states.get("https://drop.example.com/a")!.id;

      await markDropped(id, "extraction_insufficient", "2026-01-02T00:00:00.000Z");
      await markDropped(id, "not_useful", "2026-01-03T00:00:00.000Z");

      const row = (await db.select().from(posts).where(eq(posts.id, id)))[0];
      expect(row.status).toBe("rejected");

      const removals = await db.select().from(postRemovals).where(eq(postRemovals.postId, id));
      expect(removals).toHaveLength(1);
      expect(removals[0]?.reason).toBe("extraction_insufficient");
      expect(removals[0]?.removedAt).toBe("2026-01-02T00:00:00.000Z");
    });

    it("a post cannot hold both a dropped and a retracted removal (PK-enforced exclusivity)", async () => {
      await upsertPosts([blogPostInput("https://exclusive.example.com/a", null)]);
      const states = await getPostsByUrls(["https://exclusive.example.com/a"]);
      const id = states.get("https://exclusive.example.com/a")!.id;

      await markDropped(id, "not_useful", "2026-01-02T00:00:00.000Z");
      // 同じ post に対する後発の markRetracted は無視される（PK により 1 post = 1 行）。
      await markRetracted(id, "source_gone", "2026-01-03T00:00:00.000Z");

      const removals = await db.select().from(postRemovals).where(eq(postRemovals.postId, id));
      expect(removals).toHaveLength(1);
      expect(removals[0]?.kind).toBe("dropped");

      // posts.status も最初に勝った kind（dropped→rejected）のままであること。
      const row = (await db.select().from(posts).where(eq(posts.id, id)))[0];
      expect(row.status).toBe("rejected");
    });

    it("isRemoved / filterRemoved reflect post_removals membership", async () => {
      await upsertPosts([blogPostInput("https://guard.example.com/a", null)]);
      await upsertPosts([blogPostInput("https://guard.example.com/b", null)]);
      const states = await getPostsByUrls([
        "https://guard.example.com/a",
        "https://guard.example.com/b",
      ]);
      const idA = states.get("https://guard.example.com/a")!.id;
      const idB = states.get("https://guard.example.com/b")!.id;

      expect(await isRemoved(idA)).toBe(false);
      await markDropped(idA, "not_useful", "2026-01-02T00:00:00.000Z");
      expect(await isRemoved(idA)).toBe(true);
      expect(await isRemoved(idB)).toBe(false);

      const removedSet = await filterRemoved([idA, idB]);
      expect(removedSet.has(idA)).toBe(true);
      expect(removedSet.has(idB)).toBe(false);
    });

    it("listPublishedForRevalidation returns published rows with host derived from url, including posts with no post_publications row (self-heal seed path)", async () => {
      const seededId = await insertPublished("https://revalidate.example.com/seeded");
      await recordPublication(seededId, "2026-01-05T00:00:00.000Z", "hash-a", "surrogate", 0, 0, 0);

      const unseededId = await insertPublished("https://revalidate.example.com/unseeded");

      const rows = await listPublishedForRevalidation(10);

      const seededRow = rows.find((r) => r.id === seededId);
      expect(seededRow).toBeDefined();
      expect(seededRow?.host).toBe("revalidate.example.com");
      expect(seededRow?.bodyHash).toBe("hash-a");

      const unseededRow = rows.find((r) => r.id === unseededId);
      expect(unseededRow).toBeDefined();
      expect(unseededRow?.bodyHash).toBeNull();
    });

    describe("retraction lookup helpers (scripts/retract.mjs)", () => {
      it("findPostByUrlForRetraction resolves an existing url and returns null for an unknown one", async () => {
        const id = await insertPublished("https://retract-lookup.example.com/a");

        const found = await findPostByUrlForRetraction("https://retract-lookup.example.com/a");
        expect(found).toEqual({
          id,
          url: "https://retract-lookup.example.com/a",
          host: "retract-lookup.example.com",
          originalTitle: expect.any(String),
          status: "published",
        });

        expect(
          await findPostByUrlForRetraction("https://retract-lookup.example.com/missing"),
        ).toBeNull();
      });

      it("listPublishedByHostForRetraction returns only published posts for the given host, excluding other hosts and non-published statuses", async () => {
        const idA = await insertPublished("https://retract-host.example.com/a");
        const idB = await insertPublished("https://retract-host.example.com/b");
        const otherHostId = await insertPublished("https://other-host.example.com/a");
        // 公開中でない post（rejected）は対象外。
        const rejectedUrl = "https://retract-host.example.com/rejected";
        await upsertPosts([blogPostInput(rejectedUrl, null)]);
        const rejectedId = (await getPostsByUrls([rejectedUrl])).get(rejectedUrl)!.id;
        await markDropped(rejectedId, "not_useful", "2026-01-02T00:00:00.000Z");

        const rows = await listPublishedByHostForRetraction("retract-host.example.com");
        const ids = rows.map((r) => r.id).sort((a, b) => a - b);
        expect(ids).toEqual([idA, idB].sort((a, b) => a - b));
        expect(rows.every((r) => r.host === "retract-host.example.com")).toBe(true);
        expect(rows.some((r) => r.id === otherHostId)).toBe(false);
        expect(rows.some((r) => r.id === rejectedId)).toBe(false);
      });

      it("markRetracted followed by a second markRetracted with a different reason keeps the first reason (idempotent sticky re-run)", async () => {
        const url = "https://retract-idempotent.example.com/a";
        const id = await insertPublished(url);

        await markRetracted(id, "source_gone", "2026-01-06T00:00:00.000Z");
        expect(await isRemoved(id)).toBe(true);

        // 既に撤回済みの post に対する再実行（CLI の冪等性要件）。理由は上書きされない。
        await markRetracted(id, "robots_disallowed", "2026-01-07T00:00:00.000Z");

        const removal = (
          await db.select().from(postRemovals).where(eq(postRemovals.postId, id))
        )[0];
        expect(removal.reason).toBe("source_gone");
        expect(removal.removedAt).toBe("2026-01-06T00:00:00.000Z");
        expect(await isRemoved(id)).toBe(true);
      });

      it("markRetracted with reason=takedown_request writes post_removals(kind=retracted, reason=takedown_request) and syncs posts.status", async () => {
        const url = "https://retract-takedown.example.com/a";
        const id = await insertPublished(url);

        await markRetracted(id, "takedown_request", "2026-01-08T00:00:00.000Z");

        const removal = (
          await db.select().from(postRemovals).where(eq(postRemovals.postId, id))
        )[0];
        expect(removal.kind).toBe("retracted");
        expect(removal.reason).toBe("takedown_request");
        expect(removal.removedAt).toBe("2026-01-08T00:00:00.000Z");

        const post = (await db.select().from(posts).where(eq(posts.id, id)))[0];
        expect(post.status).toBe("retracted");
        expect(await isRemoved(id)).toBe(true);
      });

      it("markRetracted with reason=takedown_request is sticky: a later objective-trigger markRetracted keeps takedown_request", async () => {
        const url = "https://retract-sticky-takedown.example.com/a";
        const id = await insertPublished(url);

        await markRetracted(id, "takedown_request", "2026-01-08T00:00:00.000Z");
        // 削除要請で下げた後、自動処理（客観トリガ）が後から走っても理由は上書きされない。
        await markRetracted(id, "source_gone", "2026-01-09T00:00:00.000Z");

        const removal = (
          await db.select().from(postRemovals).where(eq(postRemovals.postId, id))
        )[0];
        expect(removal.reason).toBe("takedown_request");
        expect(removal.removedAt).toBe("2026-01-08T00:00:00.000Z");
      });

      it("markRetracted with an objective trigger is sticky against a later takedown_request markRetracted", async () => {
        const url = "https://retract-sticky-objective.example.com/a";
        const id = await insertPublished(url);

        await markRetracted(id, "source_gone", "2026-01-08T00:00:00.000Z");
        // 自動処理で下げた後、人間が削除要請コードで再実行しても理由は上書きされない。
        await markRetracted(id, "takedown_request", "2026-01-09T00:00:00.000Z");

        const removal = (
          await db.select().from(postRemovals).where(eq(postRemovals.postId, id))
        )[0];
        expect(removal.reason).toBe("source_gone");
        expect(removal.removedAt).toBe("2026-01-08T00:00:00.000Z");
      });
    });

    it("reapStaleNonTerminal only touches non-terminal rows past the TTL, and terminates legacy 'pending' rows with reason=stale_pending", async () => {
      // 既知の終端状態（published/rejected/retracted）はどれだけ古くても触らない。
      const publishedUrl = "https://reap.example.com/published";
      await upsertPosts([blogPostInput(publishedUrl, null)]);
      const publishedId = (await getPostsByUrls([publishedUrl])).get(publishedUrl)!.id;
      await db
        .update(posts)
        .set({ status: "published", createdAt: "2020-01-01T00:00:00.000Z" })
        .where(eq(posts.id, publishedId));

      // 非終端状態（レガシー 'pending' 相当）かつ古い: 対象。
      const staleUrl = "https://reap.example.com/stale-pending";
      await upsertPosts([blogPostInput(staleUrl, null)]);
      const staleId = (await getPostsByUrls([staleUrl])).get(staleUrl)!.id;
      // "pending" は PostStatus から除去済みの値のため、TS の enum を経由せず raw SQL で設定する
      // （レガシー行の再現。実運用でも DB に CHECK 制約が無いため起こりうる状態）。
      await db.run(
        sql`UPDATE posts SET status = 'pending', created_at = '2020-01-01T00:00:00.000Z' WHERE id = ${staleId}`,
      );

      // 非終端状態だが TTL 内: 対象外。
      const freshUrl = "https://reap.example.com/fresh-pending";
      await upsertPosts([blogPostInput(freshUrl, null)]);
      const freshId = (await getPostsByUrls([freshUrl])).get(freshUrl)!.id;
      await db.run(
        sql`UPDATE posts SET status = 'pending', created_at = '2026-01-01T00:00:00.000Z' WHERE id = ${freshId}`,
      );

      const now = "2026-01-02T00:00:00.000Z";
      const reaped = await reapStaleNonTerminal(now, 72);
      expect(reaped).toBe(1);

      const publishedRow = (await db.select().from(posts).where(eq(posts.id, publishedId)))[0];
      expect(publishedRow.status).toBe("published");
      expect(await isRemoved(publishedId)).toBe(false);

      const staleRow = (await db.select().from(posts).where(eq(posts.id, staleId)))[0];
      expect(staleRow.status).toBe("rejected");
      const staleRemoval = (
        await db.select().from(postRemovals).where(eq(postRemovals.postId, staleId))
      )[0];
      expect(staleRemoval.kind).toBe("dropped");
      expect(staleRemoval.reason).toBe("stale_pending");

      const freshRow = (await db.select().from(posts).where(eq(posts.id, freshId)))[0];
      expect(freshRow.status).toBe("pending");
      expect(await isRemoved(freshId)).toBe(false);
    });

    it("retry queue: enqueueRetry / dueRetries / completeRetry roundtrip", async () => {
      const entry: RetryQueueEntry = {
        urlHash: "hash-retry-1",
        url: "https://retry.example.com/a",
        host: "retry.example.com",
        lane: "discovery",
        reason: "fetch_transient",
        attempts: 0,
        firstQueuedAt: "2026-01-01T00:00:00.000Z",
        nextAttemptAt: "2026-01-01T01:00:00.000Z",
        expiresAt: "2026-01-04T00:00:00.000Z",
      };
      await enqueueRetry(entry);

      // 到来前は対象外
      const notYet = await dueRetries("2026-01-01T00:30:00.000Z", 10);
      expect(notYet.find((e) => e.urlHash === entry.urlHash)).toBeUndefined();

      // 到来後は対象
      const due = await dueRetries("2026-01-01T02:00:00.000Z", 10);
      const found = due.find((e) => e.urlHash === entry.urlHash);
      expect(found).toBeDefined();
      expect(found?.reason).toBe("fetch_transient");

      // 再 enqueue で attempts が更新される（upsert）
      await enqueueRetry({ ...entry, attempts: 1, nextAttemptAt: "2026-01-01T07:00:00.000Z" });
      const dueAfterRetry = await dueRetries("2026-01-01T08:00:00.000Z", 10);
      expect(dueAfterRetry.find((e) => e.urlHash === entry.urlHash)?.attempts).toBe(1);

      await completeRetry(entry.urlHash);
      const afterComplete = await dueRetries("2026-01-02T00:00:00.000Z", 10);
      expect(afterComplete.find((e) => e.urlHash === entry.urlHash)).toBeUndefined();
    });

    it("expireRetries returns and deletes only TTL-exceeded entries (full RetryQueueEntry, not just urlHash — plan 07 D2)", async () => {
      const expired: RetryQueueEntry = {
        urlHash: "hash-expired",
        url: "https://retry.example.com/expired",
        host: "retry.example.com",
        lane: "rss",
        reason: "llm_transient",
        attempts: 3,
        firstQueuedAt: "2026-01-01T00:00:00.000Z",
        nextAttemptAt: "2026-01-01T01:00:00.000Z",
        expiresAt: "2026-01-02T00:00:00.000Z",
      };
      const fresh: RetryQueueEntry = {
        urlHash: "hash-fresh",
        url: "https://retry.example.com/fresh",
        host: "retry.example.com",
        lane: "rss",
        reason: "rate_capped",
        attempts: 0,
        firstQueuedAt: "2026-01-03T00:00:00.000Z",
        nextAttemptAt: "2026-01-03T01:00:00.000Z",
        expiresAt: "2026-01-10T00:00:00.000Z",
      };
      await enqueueRetry(expired);
      await enqueueRetry(fresh);

      const expiredEntries = await expireRetries("2026-01-05T00:00:00.000Z");
      expect(expiredEntries.map((e) => e.urlHash)).toEqual(["hash-expired"]);
      // 呼び出し元が「どの post を終端させるか」を解決できるよう、url/host/lane
      // を含む完全な行が返ること（旧契約は urlHash のみで、これが D2 の欠陥の原因だった）。
      expect(expiredEntries[0]).toMatchObject({
        url: "https://retry.example.com/expired",
        host: "retry.example.com",
        lane: "rss",
        reason: "llm_transient",
      });

      const remainingDue = await dueRetries("2026-01-05T00:00:00.000Z", 10);
      expect(remainingDue.map((e) => e.urlHash)).toEqual(["hash-fresh"]);
      expect(remainingDue.map((e) => e.urlHash)).not.toContain("hash-expired");
    });

    it("countPublishedSince / countPublishedSinceByHost aggregate from post_publications.published_at", async () => {
      const idA = await insertPublished("https://cap.example.com/a");
      await recordPublication(idA, "2026-01-05T00:00:00.000Z", "hash-a", "surrogate", 0, 0, 0);
      const idB = await insertPublished("https://cap.example.com/b");
      await recordPublication(idB, "2026-01-06T00:00:00.000Z", "hash-b", "surrogate", 0, 0, 0);
      const idC = await insertPublished("https://other.example.com/c");
      await recordPublication(idC, "2026-01-06T00:00:00.000Z", "hash-c", "surrogate", 0, 0, 0);
      // sinceIso より前: 対象外
      const idD = await insertPublished("https://cap.example.com/d");
      await recordPublication(idD, "2025-12-01T00:00:00.000Z", "hash-d", "surrogate", 0, 0, 0);
      // post_publications に行が無い（未シード）: 対象外
      await insertPublished("https://cap.example.com/e");

      const since = "2026-01-01T00:00:00.000Z";
      const total = await countPublishedSince(since);
      expect(total).toBe(3);

      const byHost = await countPublishedSinceByHost(since);
      expect(byHost["cap.example.com"]).toBe(2);
      expect(byHost["other.example.com"]).toBe(1);
    });
  });
});
