import { describe, expect, it, vi, beforeEach } from "vitest";

const { fetchOgpMetadataMock } = vi.hoisted(() => ({
  fetchOgpMetadataMock: vi.fn(),
}));
const { curateSingleMock } = vi.hoisted(() => ({
  curateSingleMock: vi.fn(),
}));
const { upsertPostsMock, markCuratedMock, getPostsByUrlsMock } = vi.hoisted(() => ({
  upsertPostsMock: vi.fn(),
  markCuratedMock: vi.fn(),
  getPostsByUrlsMock: vi.fn(),
}));
const { canonicalizeUrlMock } = vi.hoisted(() => ({
  canonicalizeUrlMock: vi.fn(),
}));

vi.mock("@/lib/sources/ogp", () => ({
  fetchOgpMetadata: fetchOgpMetadataMock,
}));

vi.mock("@/lib/llm/batch", () => ({
  curateSingle: curateSingleMock,
}));

vi.mock("@/lib/db/repository", () => ({
  upsertPosts: upsertPostsMock,
  markCurated: markCuratedMock,
  getPostsByUrls: getPostsByUrlsMock,
}));

vi.mock("@/lib/url", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/url")>();
  return {
    ...mod,
    canonicalizeUrl: canonicalizeUrlMock.mockImplementation((u: string) => mod.canonicalizeUrl(u)),
  };
});

import { curateEvergreenUrl, resolveSourceName, registrableDomain } from "@/lib/pipeline/evergreen";
import { LLM_MODEL } from "@/lib/constants";

const BASE_META = {
  title: "Evergreen Article Title",
  description: "Evergreen Article Description",
  image: "https://example.com/image.jpg",
  siteName: "Example Wedding Site",
  author: "Test Author",
  datePublished: "2026-01-01T00:00:00.000Z",
};

describe("curateEvergreenUrl (src/lib/pipeline/evergreen.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchOgpMetadataMock.mockResolvedValue({ ...BASE_META });
    curateSingleMock.mockResolvedValue({
      title: "AI Curated Title",
      summary: "AI Curated Summary",
      category: "費用・節約",
      tag: "classic",
      firsthand: true,
      ceremonyDecision: false,
      specific: true,
      tradeoff: true,
      promotional: false,
      preDecisionOrPhotoShoot: false,
    });
    upsertPostsMock.mockResolvedValue({
      succeeded: ["https://example.com/article"],
      failed: [],
    });
    markCuratedMock.mockResolvedValue({
      succeeded: ["https://example.com/article"],
      failed: [],
    });
    getPostsByUrlsMock.mockResolvedValue(
      new Map([
        [
          "https://example.com/article",
          {
            id: 7,
            url: "https://example.com/article",
            originalTitle: "Evergreen Article Title",
            originalExcerpt: "Evergreen Article Description",
            aiTitle: "AI Curated Title",
            contentHash: "hash",
            curationSignature: "sig",
            status: "published",
            publishedAt: "2026-01-01T00:00:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      ]),
    );
  });

  it("returns reason 'invalid_url' and does not touch DB or LLM for an invalid URL", async () => {
    const outcome = await curateEvergreenUrl("not-a-url");
    expect(outcome).toEqual({ ok: false, reason: "invalid_url", card: null });
    expect(fetchOgpMetadataMock).not.toHaveBeenCalled();
    expect(upsertPostsMock).not.toHaveBeenCalled();
  });

  it("happy path: fetches OGP, curates via LLM, saves to DB with classic tag and usefulness criteria", async () => {
    const outcome = await curateEvergreenUrl("https://example.com/article");

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBeNull();
    expect(outcome.card?.aiTitle).toBe("AI Curated Title");
    expect(outcome.card?.tag).toBe("classic");
    expect(outcome.card?.sourceId).toBe("evergreen");
    // P2: 実在しない "エバーグリーン" というクレジットを生成していない
    expect(outcome.card?.sourceName).toBe("Example Wedding Site");

    expect(upsertPostsMock).toHaveBeenCalledWith([
      expect.objectContaining({
        url: "https://example.com/article",
        sourceType: "blog",
        sourceId: "evergreen",
        sourceName: "Example Wedding Site",
        status: "published",
      }),
    ]);

    expect(markCuratedMock).toHaveBeenCalledWith([
      expect.objectContaining({
        url: "https://example.com/article",
        tag: "classic",
        status: "published",
        usefulness: expect.objectContaining({
          postId: 7,
          modelId: LLM_MODEL,
          criteria: expect.objectContaining({
            firsthand: true,
            tradeoff: true,
          }),
        }),
      }),
    ]);
  });

  it("returns reason 'no_metadata' if fetchOgpMetadata returns null or no title", async () => {
    fetchOgpMetadataMock.mockResolvedValueOnce(null);
    const outcome = await curateEvergreenUrl("https://example.com/article");

    expect(outcome).toEqual({ ok: false, reason: "no_metadata", card: null });
    expect(curateSingleMock).not.toHaveBeenCalled();
    expect(upsertPostsMock).not.toHaveBeenCalled();
  });

  // T1 + T2: og:description が null のとき、curateSingle を呼ばず pending で保存し、
  // aiTitle/aiSummary は null のまま（§10-4 不変条件）。
  it("T1/T2: when og:description is null, does NOT call curateSingle and saves as pending without aiTitle/aiSummary", async () => {
    fetchOgpMetadataMock.mockResolvedValueOnce({
      ...BASE_META,
      description: null,
    });

    const outcome = await curateEvergreenUrl("https://example.com/article");

    expect(curateSingleMock).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe("needs_source_text");
    expect(outcome.card).toBeNull();

    expect(upsertPostsMock).toHaveBeenCalledTimes(1);
    expect(upsertPostsMock).toHaveBeenCalledWith([
      expect.objectContaining({
        url: "https://example.com/article",
        sourceName: "Example Wedding Site",
        originalExcerpt: null,
        status: "pending",
      }),
    ]);
    // markCurated は呼ばれない（要約が無いのでスコアも付けない）
    expect(markCuratedMock).not.toHaveBeenCalled();
  });

  it("returns 'save_failed' when saving without source text fails", async () => {
    fetchOgpMetadataMock.mockResolvedValueOnce({
      ...BASE_META,
      description: null,
    });
    upsertPostsMock.mockResolvedValueOnce({
      succeeded: [],
      failed: ["https://example.com/article"],
    });
    const outcome = await curateEvergreenUrl("https://example.com/article");
    expect(outcome).toEqual({ ok: false, reason: "save_failed", card: null });
  });

  it("handles LLM failure gracefully by falling back to pending status and false criteria", async () => {
    curateSingleMock.mockResolvedValueOnce(null);

    const outcome = await curateEvergreenUrl("https://example.com/article");

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe("needs_review");
    // フォールバックは title を表示タイトルに、excerpt（原文テキスト）を要約に使う
    expect(outcome.card?.aiTitle).toBe("Evergreen Article Title");
    expect(outcome.card?.aiSummary).toBe("Evergreen Article Description");

    expect(upsertPostsMock).toHaveBeenCalledWith([
      expect.objectContaining({
        status: "pending",
      }),
    ]);

    expect(markCuratedMock).toHaveBeenCalledWith([
      expect.objectContaining({
        status: "pending",
        usefulness: expect.objectContaining({
          criteria: expect.objectContaining({
            firsthand: false,
            tradeoff: false,
          }),
        }),
      }),
    ]);
  });

  it("returns reason 'save_failed' if upsertPosts fails", async () => {
    upsertPostsMock.mockResolvedValueOnce({
      succeeded: [],
      failed: ["https://example.com/article"],
    });

    const outcome = await curateEvergreenUrl("https://example.com/article");

    expect(outcome).toEqual({ ok: false, reason: "save_failed", card: null });
    expect(markCuratedMock).not.toHaveBeenCalled();
  });

  // P2: og:site_name が無い場合は URL のドメインでクレジットする（捏造しない）
  it("P2: falls back to registrable domain for sourceName when og:site_name is absent", async () => {
    fetchOgpMetadataMock.mockResolvedValueOnce({
      ...BASE_META,
      siteName: null,
    });

    const outcome = await curateEvergreenUrl("https://www.zexy.net/article");

    expect(outcome.ok).toBe(true);
    expect(upsertPostsMock).toHaveBeenCalledWith([
      expect.objectContaining({
        url: "https://www.zexy.net/article",
        sourceName: "zexy.net",
      }),
    ]);
    expect(outcome.card?.sourceName).toBe("zexy.net");
  });

  // T4: sourceName が解決できない場合は保存せず拒否する（捏造しない）
  it("T4: when sourceName cannot be resolved, does not save and returns 'no_source_name'", async () => {
    fetchOgpMetadataMock.mockResolvedValueOnce({
      ...BASE_META,
      siteName: null,
    });
    // ホスト名が解決不能な URL に正規化されるよう canonicalizeUrl を一時的に差し替え
    canonicalizeUrlMock.mockReturnValueOnce("not a url");

    const outcome = await curateEvergreenUrl("not a url");

    expect(outcome).toEqual({ ok: false, reason: "no_source_name", card: null });
    expect(upsertPostsMock).not.toHaveBeenCalled();
    expect(markCuratedMock).not.toHaveBeenCalled();
  });

  // P2: 手動指定の sourceName を最優先する（前後の空白はトリム）
  it("P2: explicit --source-name takes highest precedence and is trimmed", async () => {
    await curateEvergreenUrl("https://example.com/article", {
      sourceName: "  手動指定メディア  ",
    });
    expect(upsertPostsMock).toHaveBeenCalledWith([
      expect.objectContaining({ sourceName: "手動指定メディア" }),
    ]);
  });
});

describe("resolveSourceName / registrableDomain (src/lib/pipeline/evergreen.ts)", () => {
  const meta = {
    title: "T",
    description: "D",
    image: null,
    siteName: null,
    author: null,
    datePublished: null,
  };

  it("prefers explicit sourceName (trimmed)", () => {
    expect(resolveSourceName("https://example.com/x", meta, { sourceName: "  Site  " })).toBe(
      "Site",
    );
  });
  it("falls back to og:site_name when no explicit", () => {
    expect(resolveSourceName("https://example.com/x", { ...meta, siteName: "OGSite" }, {})).toBe(
      "OGSite",
    );
  });
  it("falls back to registrable domain when both absent", () => {
    expect(resolveSourceName("https://www.zexy.net/x", meta, {})).toBe("zexy.net");
  });
  it("returns null when nothing resolves (unparseable URL)", () => {
    expect(resolveSourceName("not a url", meta, {})).toBeNull();
  });
  it("registrableDomain strips www. and returns null for empty/unparseable hostname", () => {
    expect(registrableDomain("https://www.example.com/x")).toBe("example.com");
    expect(registrableDomain("http:///")).toBeNull();
    expect(registrableDomain("not a url")).toBeNull();
  });
});
