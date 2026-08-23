import { describe, expect, it, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { postUsefulnessCriteria } from "@/lib/db/schema";
import {
  upsertPosts,
  getPostsByUrls,
  markCurated,
  saveEmbed,
  getStaleCurationCandidates,
} from "@/lib/db/repository";
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
    expect(feedCards[0].aiTitle).toBe("AI Title 1");
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
        // score = 10(gate) + 3(firsthand) + 2(specific) + 2(tradeoff) = 17
        buildUpdate("https://example.com/a", {
          firsthand: true,
          ceremonyDecision: true,
          specific: true,
          tradeoff: true,
          promotional: false,
          preDecisionOrPhotoShoot: false,
        }),
        // score = 10(gate) = 10
        buildUpdate("https://example.com/b", {
          firsthand: false,
          ceremonyDecision: true,
          specific: false,
          tradeoff: false,
          promotional: false,
          preDecisionOrPhotoShoot: false,
        }),
        // score = 10(gate) = 10（b と同点。publishedAt が新しい方が先）
        buildUpdate("https://example.com/b2", {
          firsthand: false,
          ceremonyDecision: true,
          specific: false,
          tradeoff: false,
          promotional: false,
          preDecisionOrPhotoShoot: false,
        }),
        // ceremonyDecision=false のためゲート不通過: 3+2+2 = 7 に留まる
        buildUpdate("https://example.com/d", {
          firsthand: true,
          ceremonyDecision: false,
          specific: true,
          tradeoff: true,
          promotional: false,
          preDecisionOrPhotoShoot: false,
        }),
        // preDecisionOrPhotoShoot=true のためゲート不通過: 3+2+2 = 7 に留まる（publishedAt が 01-06 で d(01-03) より新しい）
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
        "https://example.com/p",
        "https://example.com/d",
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
});
