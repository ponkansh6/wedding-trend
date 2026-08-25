import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.mock ファクトリより先に評価される必要があるため vi.hoisted() で宣言する
// （通常の const 宣言だと vi.mock 側の巻き上げより後に実行され参照エラーになる）。
const { fetchOEmbedMock, detectEmbedProviderMock, curateSingleMock } = vi.hoisted(() => ({
  fetchOEmbedMock: vi.fn(),
  detectEmbedProviderMock: vi.fn(),
  curateSingleMock: vi.fn(),
}));
const {
  upsertPostsMock,
  markCuratedMock,
  saveEmbedMock,
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
  saveEmbedMock: vi.fn(),
  getPostsByUrlsMock: vi.fn(),
  markDroppedMock: vi.fn(),
  isRemovedMock: vi.fn(),
  enqueueRetryMock: vi.fn(),
  recordPublicationMock: vi.fn(),
  countPublishedSinceMock: vi.fn(),
  countPublishedSinceByHostMock: vi.fn(),
  hashUrlMock: vi.fn((url: string) => `hash:${url}`),
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
  markDropped: markDroppedMock,
  isRemoved: isRemovedMock,
  enqueueRetry: enqueueRetryMock,
  recordPublication: recordPublicationMock,
  countPublishedSince: countPublishedSinceMock,
  countPublishedSinceByHost: countPublishedSinceByHostMock,
  hashUrl: hashUrlMock,
}));

import { runSubmitUrl } from "@/lib/pipeline/submit-url";
import { DAILY_PUBLISH_CAP } from "@/lib/constants";

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
    // M1-2 の語彙的接地（plan 07 D4）を通すため、topicAnchor は呼び出し引数の
    // title（= LLM への実入力の一部）をそのまま使う（静的な固定値だとテスト
    // ケースごとに異なる title/excerpt と一致せず誤って anchor_ungrounded に
    // なるため、mockImplementation で動的に生成する）。
    curateSingleMock.mockImplementation(
      async (input: { title: string; excerpt: string | null }) => ({
        title: "AI Curated Title",
        summary: "AI Curated Summary",
        category: "その他",
        tag: "classic",
        firsthand: true,
        ceremonyDecision: true,
        specific: true,
        tradeoff: false,
        promotional: false,
        preDecisionOrPhotoShoot: false,
        topicAnchor: input.title,
        rationaleText:
          "実際の体験に基づく会場選びや進行プロセスにおける具体的な工夫と背景についての客観的な振り返りを行う非常に有用な記事内容である",
      }),
    );
    upsertPostsMock.mockResolvedValue({
      succeeded: ["https://www.instagram.com/p/ABC123"],
      failed: [],
    });
    markCuratedMock.mockResolvedValue({
      succeeded: ["https://www.instagram.com/p/ABC123"],
      failed: [],
    });
    saveEmbedMock.mockResolvedValue(true);
    // canonicalizeUrl は末尾スラッシュを除去するため、実装が引くキーは
    // 正規化後の URL になる。どの URL で問い合わせても解決できるよう、
    // クエリされた URL をそのままキーにして返す。
    getPostsByUrlsMock.mockImplementation((urls: string[]) =>
      Promise.resolve(
        new Map(
          urls.map((url) => [
            url,
            {
              id: 42,
              url,
              originalTitle: "IG Title",
              originalExcerpt: null,
              aiTitle: "AI Curated Title",
              contentHash: "hash",
              curationSignature: "sig",
              status: "published",
              publishedAt: null,
              createdAt: "2024-01-01T00:00:00.000Z",
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

  it('returns reason "invalid_url" and does not touch the DB or LLM for a syntactically invalid URL', async () => {
    const outcome = await runSubmitUrl("not-a-url");

    expect(outcome).toEqual({ ok: false, reason: "invalid_url", card: null });
    expect(fetchOEmbedMock).not.toHaveBeenCalled();
    expect(upsertPostsMock).not.toHaveBeenCalled();
  });

  it("happy path: builds a FeedCard from oEmbed + LLM curation and records publication", async () => {
    const outcome = await runSubmitUrl("https://www.instagram.com/p/ABC123/?utm_source=ig");

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBeNull();
    expect(outcome.card?.originalTitle).toBe("IG Title");
    expect(outcome.card?.embedProvider).toBe("instagram");
    expect(outcome.card?.id).toBe(42);
    expect(saveEmbedMock).toHaveBeenCalledTimes(1);
    expect(markCuratedMock).toHaveBeenCalledWith([
      expect.objectContaining({ status: "published" }),
    ]);
    expect(recordPublicationMock).toHaveBeenCalledWith(
      42,
      expect.any(String),
      expect.any(String),
      "surrogate",
    );
  });

  // D4: M1-2 の語彙的接地は submit-url レーンでも、LLM に実際に渡した入力
  // （oEmbed キャプション/タイトル+運営メモ）に対して適用される。
  it("D4: drops as anchor_ungrounded when the LLM's topicAnchor contains a term absent from the source text", async () => {
    curateSingleMock.mockResolvedValueOnce({
      title: "AI Curated Title",
      summary: "AI Curated Summary",
      category: "その他",
      tag: "classic",
      firsthand: true,
      ceremonyDecision: true,
      specific: true,
      tradeoff: false,
      promotional: false,
      preDecisionOrPhotoShoot: false,
      // sourceTitle="IG Title" には一切現れない語（プロンプトインジェクション/
      // 幻覚を模擬）。
      topicAnchor: "架空の温泉旅行特集",
      rationaleText:
        "実際の体験に基づく会場選びや進行プロセスにおける具体的な工夫と背景についての客観的な振り返りを行う非常に有用な記事内容である",
    });

    const outcome = await runSubmitUrl("https://www.instagram.com/p/ABC123/?utm_source=ig");

    expect(outcome.reason).toBe("anchor_ungrounded");
    expect(outcome.card).toBeNull();
    expect(markCuratedMock).not.toHaveBeenCalled();
    expect(recordPublicationMock).not.toHaveBeenCalled();
  });

  // §7: LLM 呼び出し失敗は一時的技術障害として再試行キューへ（終端棄却しない）。
  it("queues a retry (does not touch posts/embed) when LLM curation fails", async () => {
    curateSingleMock.mockResolvedValue(null);

    const outcome = await runSubmitUrl("https://www.instagram.com/p/ABC123/");

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe("queued_for_retry");
    expect(outcome.card).toBeNull();
    expect(upsertPostsMock).not.toHaveBeenCalled();
    expect(markCuratedMock).not.toHaveBeenCalled();
    expect(saveEmbedMock).not.toHaveBeenCalled();
    expect(enqueueRetryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://www.instagram.com/p/ABC123",
        lane: "submit",
        reason: "llm_transient",
      }),
    );
  });

  it('returns reason "save_failed" when upsertPosts fails, without throwing', async () => {
    upsertPostsMock.mockResolvedValue({
      succeeded: [],
      failed: ["https://www.instagram.com/p/ABC123"],
    });

    const outcome = await runSubmitUrl("https://www.instagram.com/p/ABC123/");

    expect(outcome).toEqual({ ok: false, reason: "save_failed", card: null });
    expect(markCuratedMock).not.toHaveBeenCalled();
  });

  // M1-1: 逐語タイトルの無検閲公開フィルタ。恒久棄却（再試行しない）。
  it("M1: an oEmbed caption carrying an ad marker is terminally dropped as title_filter and never published", async () => {
    fetchOEmbedMock.mockResolvedValue({
      provider: "instagram",
      html: "<blockquote>ig</blockquote>",
      thumbnailUrl: null,
      authorName: null,
      title: "【PR】キャンペーン投稿",
    });

    const outcome = await runSubmitUrl("https://www.instagram.com/p/ABC123/");

    expect(outcome).toEqual({ ok: true, reason: "title_filter", card: null });
    expect(markDroppedMock).toHaveBeenCalledWith(42, "title_filter", expect.any(String));
    expect(markCuratedMock).not.toHaveBeenCalled();
    expect(enqueueRetryMock).not.toHaveBeenCalled();
  });

  // M1-3: 撤回済み（sticky）投稿は公開しない。
  it("M1: a post already recorded as removed (retracted/dropped) is never republished", async () => {
    isRemovedMock.mockResolvedValueOnce(true);

    const outcome = await runSubmitUrl("https://www.instagram.com/p/ABC123/");

    expect(outcome).toEqual({ ok: true, reason: "removed", card: null });
    expect(markCuratedMock).not.toHaveBeenCalled();
    expect(recordPublicationMock).not.toHaveBeenCalled();
  });

  // Q4: 日次公開上限に達したら公開せず、再試行キューへ繰り延べる（終端棄却しない）。
  it("Q4: when the daily publish cap is reached, does not publish and enqueues a rate_capped retry instead", async () => {
    countPublishedSinceMock.mockResolvedValueOnce(DAILY_PUBLISH_CAP);

    const outcome = await runSubmitUrl("https://www.instagram.com/p/ABC123/");

    expect(outcome).toEqual({ ok: true, reason: "rate_limited", card: null });
    expect(markCuratedMock).not.toHaveBeenCalled();
    expect(markDroppedMock).not.toHaveBeenCalled();
    expect(enqueueRetryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://www.instagram.com/p/ABC123",
        lane: "submit",
        reason: "rate_capped",
      }),
    );
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

    it("never calls curateSingle, terminally drops as extraction_insufficient, still saves the embed", async () => {
      const outcome = await runSubmitUrl("https://www.instagram.com/p/ABC123/");

      expect(curateSingleMock).not.toHaveBeenCalled();
      expect(upsertPostsMock).toHaveBeenCalledWith([
        expect.objectContaining({
          url: "https://www.instagram.com/p/ABC123",
        }),
      ]);
      // upsertPosts の入力には aiTitle/aiSummary というフィールド自体が存在しない
      // （スキーマ既定で null になる）ため、意図的に渡していないことを確認する。
      const upsertArg = upsertPostsMock.mock.calls[0]?.[0]?.[0];
      expect(upsertArg).not.toHaveProperty("aiTitle");
      expect(upsertArg).not.toHaveProperty("aiSummary");
      expect(markDroppedMock).toHaveBeenCalledWith(
        42,
        "extraction_insufficient",
        expect.any(String),
      );
      expect(markCuratedMock).not.toHaveBeenCalled();
      expect(saveEmbedMock).toHaveBeenCalledTimes(1);
      expect(saveEmbedMock).toHaveBeenCalledWith(
        "https://www.instagram.com/p/ABC123",
        expect.objectContaining({
          embedProvider: "instagram",
          embedHtml: "<blockquote>ig</blockquote>",
        }),
      );
      expect(outcome.reason).toBe("extraction_insufficient");
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
      expect(markCuratedMock).toHaveBeenCalledWith([
        expect.objectContaining({ status: "published" }),
      ]);
      expect(outcome.ok).toBe(true);
      expect(outcome.reason).toBeNull();
      expect(outcome.card).not.toBeNull();
    });

    it("treats a whitespace-only note as absent and still returns extraction_insufficient", async () => {
      const outcome = await runSubmitUrl("https://www.instagram.com/p/ABC123/", "   ");

      expect(curateSingleMock).not.toHaveBeenCalled();
      expect(outcome.reason).toBe("extraction_insufficient");
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
