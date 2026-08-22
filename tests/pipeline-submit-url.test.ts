import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: any) => fn,
  revalidateTag: vi.fn(),
}));

// vi.mock ファクトリより先に評価される必要があるため vi.hoisted() で宣言する
// （通常の const 宣言だと vi.mock 側の巻き上げより後に実行され参照エラーになる）。
const { fetchOEmbedMock, detectEmbedProviderMock, curateSingleMock } = vi.hoisted(() => ({
  fetchOEmbedMock: vi.fn(),
  detectEmbedProviderMock: vi.fn(),
  curateSingleMock: vi.fn(),
}));
const { upsertPostsMock, markCuratedMock, saveEmbedMock, getPostsByUrlsMock } = vi.hoisted(() => ({
  upsertPostsMock: vi.fn(),
  markCuratedMock: vi.fn(),
  saveEmbedMock: vi.fn(),
  getPostsByUrlsMock: vi.fn(),
}));

vi.mock("@/lib/embed/oembed", () => ({
  fetchOEmbed: fetchOEmbedMock,
}));

vi.mock("@/lib/embed/providers", () => ({
  detectEmbedProvider: detectEmbedProviderMock,
}));

vi.mock("@/lib/llm/batch", () => ({
  curateSingle: curateSingleMock,
}));

vi.mock("@/lib/db/repository", () => ({
  upsertPosts: upsertPostsMock,
  markCurated: markCuratedMock,
  saveEmbed: saveEmbedMock,
  getPostsByUrls: getPostsByUrlsMock,
}));

import { revalidateTag } from "next/cache";
import { runSubmitUrl } from "@/lib/pipeline/submit-url";

describe("runSubmitUrl (src/lib/pipeline/submit-url.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detectEmbedProviderMock.mockReturnValue("instagram");
    fetchOEmbedMock.mockResolvedValue({
      provider: "instagram",
      html: "<blockquote>ig</blockquote>",
      thumbnailUrl: "https://example.com/ig.jpg",
      authorName: "IG Author",
      title: "IG Title",
    });
    curateSingleMock.mockResolvedValue({
      title: "AI Curated Title",
      summary: "AI Curated Summary",
      category: "その他",
      tag: "classic",
    });
    upsertPostsMock.mockResolvedValue({
      succeeded: ["https://www.instagram.com/p/ABC123"],
      failed: [],
    });
    markCuratedMock.mockResolvedValue({
      succeeded: ["https://www.instagram.com/p/ABC123"],
      failed: [],
    });
    saveEmbedMock.mockResolvedValue(true);
    getPostsByUrlsMock.mockResolvedValue(
      new Map([
        // canonicalizeUrl は末尾スラッシュを除去するため、実装が引く
        // キーは正規化後の URL になる。
        [
          "https://www.instagram.com/p/ABC123",
          {
            id: 42,
            url: "https://www.instagram.com/p/ABC123",
            originalTitle: "IG Title",
            originalExcerpt: null,
            aiTitle: "AI Curated Title",
            contentHash: "hash",
            curationSignature: "sig",
            status: "published",
            publishedAt: null,
            createdAt: "2024-01-01T00:00:00.000Z",
          },
        ],
      ]),
    );
  });

  it('returns reason "invalid_url" and does not touch the DB or LLM for a syntactically invalid URL', async () => {
    const outcome = await runSubmitUrl("not-a-url");

    expect(outcome).toEqual({ ok: false, reason: "invalid_url", card: null });
    expect(fetchOEmbedMock).not.toHaveBeenCalled();
    expect(upsertPostsMock).not.toHaveBeenCalled();
  });

  it("happy path: builds a FeedCard from oEmbed + LLM curation and revalidates the feed cache", async () => {
    const outcome = await runSubmitUrl("https://www.instagram.com/p/ABC123/?utm_source=ig");

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBeNull();
    expect(outcome.card?.aiTitle).toBe("AI Curated Title");
    expect(outcome.card?.embedProvider).toBe("instagram");
    expect(outcome.card?.id).toBe(42);
    expect(revalidateTag).toHaveBeenCalledWith("feed-cards", { expire: 0 });
    expect(saveEmbedMock).toHaveBeenCalledTimes(1);
  });

  it('returns reason "needs_review" (still ok:true) when LLM curation fails and a fallback is used', async () => {
    curateSingleMock.mockResolvedValue(null);

    const outcome = await runSubmitUrl("https://www.instagram.com/p/ABC123/");

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe("needs_review");
    expect(outcome.card).not.toBeNull();
    expect(markCuratedMock).toHaveBeenCalledWith([expect.objectContaining({ status: "pending" })]);
  });

  it('returns reason "save_failed" when upsertPosts fails, without throwing', async () => {
    upsertPostsMock.mockResolvedValue({
      succeeded: [],
      failed: ["https://www.instagram.com/p/ABC123"],
    });

    const outcome = await runSubmitUrl("https://www.instagram.com/p/ABC123/");

    expect(outcome).toEqual({ ok: false, reason: "save_failed", card: null });
    expect(markCuratedMock).not.toHaveBeenCalled();
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("uses the optional note as supplementary excerpt text when oEmbed returns no title", async () => {
    fetchOEmbedMock.mockResolvedValue({
      provider: "instagram",
      html: null,
      thumbnailUrl: null,
      authorName: null,
      title: null,
    });

    await runSubmitUrl("https://www.instagram.com/p/ABC123/", "会場の装花がとても綺麗でした");

    expect(curateSingleMock).toHaveBeenCalledWith({
      title: "会場の装花がとても綺麗でした",
      excerpt: "会場の装花がとても綺麗でした",
    });
  });

  describe("no source text (Instagram keyless oEmbed with no caption)", () => {
    beforeEach(() => {
      // Instagram のキーなし oEmbed の実挙動: html はあるが title は返らない。
      fetchOEmbedMock.mockResolvedValue({
        provider: "instagram",
        html: "<blockquote>ig</blockquote>",
        thumbnailUrl: null,
        authorName: null,
        title: null,
      });
    });

    it("never calls curateSingle, saves as pending with null aiTitle/aiSummary, still saves the embed, and returns needs_source_text", async () => {
      const outcome = await runSubmitUrl("https://www.instagram.com/p/ABC123/");

      expect(curateSingleMock).not.toHaveBeenCalled();
      expect(upsertPostsMock).toHaveBeenCalledWith([
        expect.objectContaining({
          url: "https://www.instagram.com/p/ABC123",
          status: "pending",
        }),
      ]);
      // upsertPosts の入力には aiTitle/aiSummary というフィールド自体が存在しない
      // （スキーマ既定で null になる）ため、意図的に渡していないことを確認する。
      const upsertArg = upsertPostsMock.mock.calls[0]?.[0]?.[0];
      expect(upsertArg).not.toHaveProperty("aiTitle");
      expect(upsertArg).not.toHaveProperty("aiSummary");
      expect(markCuratedMock).not.toHaveBeenCalled();
      expect(saveEmbedMock).toHaveBeenCalledTimes(1);
      expect(saveEmbedMock).toHaveBeenCalledWith(
        "https://www.instagram.com/p/ABC123",
        expect.objectContaining({
          embedProvider: "instagram",
          embedHtml: "<blockquote>ig</blockquote>",
        }),
      );
      expect(outcome.reason).toBe("needs_source_text");
      expect(outcome.card).toBeNull();
    });

    it("proceeds with normal curation and publishes when a note is supplied", async () => {
      const outcome = await runSubmitUrl(
        "https://www.instagram.com/p/ABC123/",
        "会場の装花がとても綺麗でした",
      );

      expect(curateSingleMock).toHaveBeenCalledWith({
        title: "会場の装花がとても綺麗でした",
        excerpt: "会場の装花がとても綺麗でした",
      });
      expect(upsertPostsMock).toHaveBeenCalledWith([
        expect.objectContaining({ status: "published" }),
      ]);
      expect(outcome.ok).toBe(true);
      expect(outcome.reason).toBeNull();
      expect(outcome.card).not.toBeNull();
    });

    it("treats a whitespace-only note as absent and still returns needs_source_text", async () => {
      const outcome = await runSubmitUrl("https://www.instagram.com/p/ABC123/", "   ");

      expect(curateSingleMock).not.toHaveBeenCalled();
      expect(outcome.reason).toBe("needs_source_text");
    });
  });

  it("proceeds with normal curation when oEmbed returns a title (YouTube-like) and no note is supplied", async () => {
    fetchOEmbedMock.mockResolvedValue({
      provider: "youtube",
      html: "<iframe>yt</iframe>",
      thumbnailUrl: "https://example.com/yt.jpg",
      authorName: "YT Author",
      title: "YouTube Video Title",
    });

    const outcome = await runSubmitUrl("https://www.instagram.com/p/ABC123/");

    expect(curateSingleMock).toHaveBeenCalledWith({
      title: "YouTube Video Title",
      excerpt: "YouTube Video Title",
    });
    expect(outcome.reason).toBeNull();
    expect(outcome.card).not.toBeNull();
  });
});
