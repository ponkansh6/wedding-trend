import { describe, expect, it, vi, beforeEach } from "vitest";

const { fetchOgpMetadataMock } = vi.hoisted(() => ({
  fetchOgpMetadataMock: vi.fn(),
}));
const { curateSingleMock } = vi.hoisted(() => ({
  curateSingleMock: vi.fn(),
}));
const {
  upsertPostsMock,
  markCuratedMock,
  getPostsByUrlsMock,
  markDroppedMock,
  isRemovedMock,
  enqueueRetryMock,
  recordPublicationMock,
  countPublishedSinceMock,
  countPublishedSinceByHostMock,
  hashUrlMock,
} = vi.hoisted(() => ({
  upsertPostsMock: vi.fn(),
  markCuratedMock: vi.fn(),
  getPostsByUrlsMock: vi.fn(),
  markDroppedMock: vi.fn(),
  isRemovedMock: vi.fn(),
  enqueueRetryMock: vi.fn(),
  recordPublicationMock: vi.fn(),
  countPublishedSinceMock: vi.fn(),
  countPublishedSinceByHostMock: vi.fn(),
  hashUrlMock: vi.fn((url: string) => `hash:${url}`),
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
  markDropped: markDroppedMock,
  isRemoved: isRemovedMock,
  enqueueRetry: enqueueRetryMock,
  recordPublication: recordPublicationMock,
  countPublishedSince: countPublishedSinceMock,
  countPublishedSinceByHost: countPublishedSinceByHostMock,
  hashUrl: hashUrlMock,
}));

vi.mock("@/lib/url", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/url")>();
  return {
    ...mod,
    canonicalizeUrl: canonicalizeUrlMock.mockImplementation((u: string) => mod.canonicalizeUrl(u)),
  };
});

import { curateEvergreenUrl, resolveSourceName, registrableDomain } from "@/lib/pipeline/evergreen";
import { DAILY_PUBLISH_CAP, LLM_MODEL } from "@/lib/constants";

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
    // M1-2 の語彙的接地（plan 07 D4）を通すため、topicAnchor は呼び出し引数の
    // title（= LLM への実入力の一部）をそのまま使う（静的な固定値だとテスト
    // ケースごとに異なる title/description と一致せず誤って anchor_ungrounded
    // になるため、mockImplementation で動的に生成する）。
    curateSingleMock.mockImplementation(
      async (input: { title: string; excerpt: string | null }) => ({
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
        topicAnchor: input.title,
        rationaleText:
          "実際の体験に基づく会場選びや進行プロセスにおける具体的な工夫と背景についての客観的な振り返りを行う非常に有用な記事内容である",
      }),
    );
    upsertPostsMock.mockResolvedValue({
      succeeded: ["https://example.com/article"],
      failed: [],
    });
    markCuratedMock.mockResolvedValue({
      succeeded: ["https://example.com/article"],
      failed: [],
    });
    getPostsByUrlsMock.mockImplementation((urls: string[]) =>
      Promise.resolve(
        new Map(
          urls.map((url) => [
            url,
            {
              id: 7,
              url,
              originalTitle: "Evergreen Article Title",
              originalExcerpt: "Evergreen Article Description",
              aiTitle: "AI Curated Title",
              contentHash: "hash",
              curationSignature: "sig",
              status: "published",
              publishedAt: "2026-01-01T00:00:00.000Z",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ]),
        ),
      ),
    );
    markDroppedMock.mockResolvedValue(undefined);
    isRemovedMock.mockResolvedValue(false);
    enqueueRetryMock.mockResolvedValue(undefined);
    recordPublicationMock.mockResolvedValue(undefined);
    countPublishedSinceMock.mockResolvedValue(0);
    countPublishedSinceByHostMock.mockResolvedValue({});
  });

  it("returns reason 'invalid_url' and does not touch DB or LLM for an invalid URL", async () => {
    const outcome = await curateEvergreenUrl("not-a-url");
    expect(outcome).toEqual({ ok: false, reason: "invalid_url", card: null });
    expect(fetchOgpMetadataMock).not.toHaveBeenCalled();
    expect(upsertPostsMock).not.toHaveBeenCalled();
  });

  it("happy path: fetches OGP, curates via LLM, saves to DB with classic tag, usefulness criteria, and records publication", async () => {
    const outcome = await curateEvergreenUrl("https://example.com/article");

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBeNull();
    expect(outcome.card?.originalTitle).toBe("Evergreen Article Title");
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
        rationale: expect.objectContaining({
          postId: 7,
          evidenceSufficient: true,
        }),
      }),
    ]);

    // §5: 公開の記録。
    expect(recordPublicationMock).toHaveBeenCalledWith(
      7,
      expect.any(String),
      expect.any(String),
      "surrogate",
    );
  });

  // D4: M1-2 の語彙的接地は evergreen レーンでも、LLM に実際に渡した入力
  // （title + og:description）に対して適用される。
  it("D4: drops as anchor_ungrounded when the LLM's topicAnchor contains a term absent from title+og:description", async () => {
    curateSingleMock.mockResolvedValueOnce({
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
      // BASE_META の title/description には一切現れない語（プロンプト
      // インジェクション/幻覚を模擬）。
      topicAnchor: "架空の温泉旅行特集",
      rationaleText:
        "実際の体験に基づく会場選びや進行プロセスにおける具体的な工夫と背景についての客観的な振り返りを行う非常に有用な記事内容である",
    });

    const outcome = await curateEvergreenUrl("https://example.com/article");

    expect(outcome.reason).toBe("anchor_ungrounded");
    expect(outcome.card).toBeNull();
    expect(markCuratedMock).not.toHaveBeenCalled();
    expect(recordPublicationMock).not.toHaveBeenCalled();
  });

  it("returns reason 'no_metadata' if fetchOgpMetadata returns null or no title", async () => {
    fetchOgpMetadataMock.mockResolvedValueOnce(null);
    const outcome = await curateEvergreenUrl("https://example.com/article");

    expect(outcome).toEqual({ ok: false, reason: "no_metadata", card: null });
    expect(curateSingleMock).not.toHaveBeenCalled();
    expect(upsertPostsMock).not.toHaveBeenCalled();
  });

  // Q1相当（簡易）: og:description が無いと LLM を呼ばず即終端棄却する。
  it("Q1: when og:description is null, does NOT call curateSingle and terminally drops as extraction_insufficient", async () => {
    fetchOgpMetadataMock.mockResolvedValueOnce({
      ...BASE_META,
      description: null,
    });

    const outcome = await curateEvergreenUrl("https://example.com/article");

    expect(curateSingleMock).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe("extraction_insufficient");
    expect(outcome.card).toBeNull();

    expect(upsertPostsMock).toHaveBeenCalledTimes(1);
    expect(upsertPostsMock).toHaveBeenCalledWith([
      expect.objectContaining({
        url: "https://example.com/article",
        sourceName: "Example Wedding Site",
        originalExcerpt: null,
      }),
    ]);
    expect(markDroppedMock).toHaveBeenCalledWith(7, "extraction_insufficient", expect.any(String));
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

  // §7: LLM 呼び出し失敗は一時的技術障害として再試行キューへ（終端棄却しない）。
  it("queues a retry (does not terminally drop, does not touch posts) when curateSingle fails", async () => {
    curateSingleMock.mockResolvedValueOnce(null);

    const outcome = await curateEvergreenUrl("https://example.com/article");

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe("queued_for_retry");
    expect(outcome.card).toBeNull();

    expect(upsertPostsMock).not.toHaveBeenCalled();
    expect(markCuratedMock).not.toHaveBeenCalled();
    expect(markDroppedMock).not.toHaveBeenCalled();
    expect(enqueueRetryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/article",
        lane: "evergreen",
        reason: "llm_transient",
      }),
    );
  });

  // M1-1: 逐語タイトルの無検閲公開フィルタ。恒久棄却（再試行しない）。
  it("M1: title carrying an ad marker is terminally dropped as title_filter and never published", async () => {
    fetchOgpMetadataMock.mockResolvedValueOnce({
      ...BASE_META,
      title: "【PR】Evergreen Article Title",
    });

    const outcome = await curateEvergreenUrl("https://example.com/article");

    expect(outcome).toEqual({ ok: true, reason: "title_filter", card: null });
    expect(markDroppedMock).toHaveBeenCalledWith(7, "title_filter", expect.any(String));
    expect(markCuratedMock).not.toHaveBeenCalled();
    expect(enqueueRetryMock).not.toHaveBeenCalled();
  });

  // M1-3: 撤回済み（sticky）投稿は公開しない。
  it("M1: a post already recorded as removed (retracted/dropped) is never republished", async () => {
    isRemovedMock.mockResolvedValueOnce(true);

    const outcome = await curateEvergreenUrl("https://example.com/article");

    expect(outcome).toEqual({ ok: true, reason: "removed", card: null });
    expect(markCuratedMock).not.toHaveBeenCalled();
    expect(recordPublicationMock).not.toHaveBeenCalled();
  });

  // Q4: 日次公開上限に達したら公開せず、再試行キューへ繰り延べる（終端棄却しない）。
  it("Q4: when the daily publish cap is reached, does not publish and enqueues a rate_capped retry instead", async () => {
    countPublishedSinceMock.mockResolvedValueOnce(DAILY_PUBLISH_CAP);

    const outcome = await curateEvergreenUrl("https://example.com/article");

    expect(outcome).toEqual({ ok: true, reason: "rate_limited", card: null });
    expect(markCuratedMock).not.toHaveBeenCalled();
    expect(markDroppedMock).not.toHaveBeenCalled();
    expect(enqueueRetryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/article",
        lane: "evergreen",
        reason: "rate_capped",
      }),
    );
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
