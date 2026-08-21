import { describe, expect, it, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { readFileSync } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { upsertPosts, getPostsByUrls, markCurated, saveEmbed } from "@/lib/db/repository";
import { getFeedCards } from "@/lib/db/query";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: any) => fn,
  revalidateTag: vi.fn(),
}));

const migrationSql = readFileSync(
  path.resolve(__dirname, "../src/lib/db/migrations/0000_stormy_harrier.sql"),
  "utf-8",
);

async function setupTestDb() {
  try {
    await db.run(sql.raw("DROP TABLE IF EXISTS posts;"));
  } catch {}
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await db.run(sql.raw(stmt));
  }
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

    // 4. Test markCurated
    const markRes = await markCurated([
      {
        url: "https://example.com/post1",
        aiTitle: "AI Title 1",
        aiSummary: "AI Summary 1",
        category: "その他",
        tag: "trend",
        contentHash: "hash1",
        curationSignature: "sig1",
      },
    ]);
    expect(markRes.succeeded).toContain("https://example.com/post1");

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

  it("handles database errors and fail-soft fallbacks gracefully", async () => {
    // Drop table to cause query errors
    await db.run(sql.raw("DROP TABLE posts;"));

    // getPostsByUrls should catch error and return empty map
    const urlsMap = await getPostsByUrls(["https://example.com/post1"]);
    expect(urlsMap.size).toBe(0);

    // getFeedCards should catch error and return []
    const cards = await getFeedCards({ sourceType: "blog", limit: 10 });
    expect(cards).toEqual([]);

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
});
