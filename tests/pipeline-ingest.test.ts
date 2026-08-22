import { describe, expect, it, vi, beforeEach } from "vitest";
import { setupTestDb } from "./helpers/test-db";

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

// title/excerpt から機械的に結果を組み立てる。入力件数に関わらず 1 件も
// 取りこぼさないことをテストするため、固定件数の応答ではなく入力に追従する形にする。
vi.mock("@/lib/llm/batch", () => ({
  curatePosts: vi.fn((inputs: Array<{ title: string; excerpt: string | null }>) =>
    Promise.resolve({
      results: inputs.map((input) => ({
        title: `AI: ${input.title}`,
        summary: `AI summary for ${input.title}`,
        category: "その他",
        tag: "trend",
        firsthand: true,
        ceremonyDecision: true,
        specific: true,
        tradeoff: false,
        promotional: false,
      })),
      geminiCalls: 1,
    }),
  ),
}));

import { curatePosts } from "@/lib/llm/batch";
import { computeCurationSignature } from "@/lib/llm/signature";
import {
  getPostsByUrls,
  getStaleCurationCandidates,
  markCurated,
  upsertPosts,
} from "@/lib/db/repository";
import { db } from "@/lib/db";
import { postUsefulness } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { runIngest } from "@/lib/pipeline/ingest";

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

  it("happy path: fetches from every adapter, upserts, and curates", async () => {
    const summary = await runIngest();

    expect(summary.fetched).toBe(2);
    expect(summary.inserted).toBe(2);
    expect(summary.curated).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(summary.geminiCalls).toBe(1);
    expect(curatePosts).toHaveBeenCalledTimes(1);
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
  });

  it("happy path: also writes post_usefulness for every curated post", async () => {
    await runIngest();

    const rows = await db.select().from(postUsefulness);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.firsthand).toBe(1);
      expect(row.ceremonyDecision).toBe(1);
    }
  });

  it("backfill: fills the remaining budget with stale DB candidates (signature mismatch) once fresh candidates are exhausted, and the backfilled post no longer appears as stale afterwards", async () => {
    // 今回の RSS ウィンドウには入らない「古い」体験談投稿を、以前のプロンプト
    // バージョンの signature で curation 済みとして事前に用意しておく。
    await upsertPosts([
      {
        url: "https://example.com/stale-blog-post",
        sourceType: "blog",
        sourceId: "note",
        sourceName: "note",
        originalTitle: "Stale Blog Post",
        originalExcerpt: "Old excerpt",
        author: "Author",
        thumbnailUrl: null,
        publishedAt: "2023-01-01T00:00:00.000Z",
      },
    ]);
    await markCurated([
      {
        url: "https://example.com/stale-blog-post",
        aiTitle: "Old AI Title",
        aiSummary: "Old AI Summary",
        category: "その他",
        tag: "classic",
        contentHash: "old-hash",
        curationSignature: "outdated-signature",
      },
    ]);

    const summary = await runIngest();

    // 2 件の新着（fresh）+ 1 件のバックフィル（stale）= 3 件がキュレーション対象になる。
    expect(curatePosts).toHaveBeenCalledTimes(1);
    const calledWith = (curatePosts as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as Array<{ title: string }>;
    expect(calledWith).toHaveLength(3);
    expect(calledWith.some((i) => i.title === "Stale Blog Post")).toBe(true);
    expect(summary.curated).toBe(3);
    // fresh 側の skipped 判定には影響しない（stale はそもそも deduped 由来ではない）。
    expect(summary.skipped).toBe(0);

    // 再キュレーション後は最新 signature になっているため、もう stale 候補として検出されない。
    const stillStale = await getStaleCurationCandidates({
      currentSignature: computeCurationSignature(),
      limit: 10,
    });
    expect(stillStale.map((c) => c.url)).not.toContain("https://example.com/stale-blog-post");

    // post_usefulness も新しい signature・値で upsert されている。
    const states = await getPostsByUrls(["https://example.com/stale-blog-post"]);
    const postId = states.get("https://example.com/stale-blog-post")!.id;
    const rows = await db.select().from(postUsefulness).where(eq(postUsefulness.postId, postId));
    expect(rows).toHaveLength(1);
    expect(rows[0].signature).toBe(computeCurationSignature());
  });
});
