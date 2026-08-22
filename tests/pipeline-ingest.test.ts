import { describe, expect, it, vi, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { readFileSync } from "fs";
import path from "path";
import { db } from "@/lib/db";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: any) => fn,
  revalidateTag: vi.fn(),
}));

// vi.mock ファクトリより先に評価される必要があるため vi.hoisted() で宣言する
// （通常の const 宣言だと vi.mock 側の巻き上げより後に実行され参照エラーになる）。
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
  curatePosts: vi.fn().mockResolvedValue([
    { title: "AI Curated Title", summary: "AI Summary", category: "その他", tag: "trend" },
    { title: "AI Curated Title 2", summary: "AI Summary 2", category: "その他", tag: "classic" },
  ]),
}));

import { curatePosts } from "@/lib/llm/batch";
import { revalidateTag } from "next/cache";
import { runIngest } from "@/lib/pipeline/ingest";

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

describe("runIngest (src/lib/pipeline/ingest.ts)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setupTestDb();

    hatenaFetch.mockResolvedValue([{ title: "Blog Post 1", link: "https://example.com/blog1" }]);
    hatenaToPost.mockReturnValue({
      url: "https://example.com/blog1",
      sourceType: "blog",
      sourceId: "hatena-bookmark",
      sourceName: "はてなブックマーク",
      originalTitle: "Blog Post 1",
      originalExcerpt: "Excerpt",
      author: "Author",
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

  it("happy path: fetches from every adapter, upserts, curates, and revalidates the feed cache", async () => {
    const summary = await runIngest();

    expect(summary.fetched).toBe(2);
    expect(summary.inserted).toBe(2);
    expect(summary.curated).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(curatePosts).toHaveBeenCalledTimes(1);
    expect(revalidateTag).toHaveBeenCalledWith("feed-cards", { expire: 0 });
  });

  it("resilience: one adapter throwing does not stop ingestion from the other sources, and no error is thrown", async () => {
    hatenaFetch.mockRejectedValue(new Error("RSS feed unreachable"));

    const summary = await runIngest();

    // google-news 側は正常に取り込まれ、hatena-bookmark 側のみエラーとして記録される。
    expect(summary.fetched).toBe(1);
    expect(summary.inserted).toBe(1);
    expect(summary.curated).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain("hatena-bookmark");
    expect(summary.errors[0]).toContain("RSS feed unreachable");
    // 1 ソースの失敗があってもキャッシュ失効は必ず実行される。
    expect(revalidateTag).toHaveBeenCalledWith("feed-cards", { expire: 0 });
  });
});
