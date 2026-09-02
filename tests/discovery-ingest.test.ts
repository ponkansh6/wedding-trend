import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { setupTestDb } from "./helpers/test-db";
import { db } from "@/lib/db";
import {
  discoveryHostMetrics,
  postPublications,
  postRemovals,
  postRetryQueue,
} from "@/lib/db/schema";
import {
  countDiscoverySeenByStatus,
  countPublishedSince,
  getHostGateState,
  getPostsByUrls,
  getRationaleByPostId,
  isRemoved,
  markRetracted,
  recordPublication,
  saveHostGateState,
  seedDiscoverySeen,
  upsertPosts,
} from "@/lib/db/repository";
import {
  bodyHashSimilarity,
  computeBodyHash,
  computeContainerBodyHash,
  ingestDiscoveredUrls,
  revalidatePublishedPosts,
} from "@/lib/pipeline/discovery-ingest";
import { curateSingle } from "@/lib/llm/batch";
import type { CurationResult } from "@/lib/llm/batch";
import { __resetStateForTests, __setSleepForTests } from "@/lib/sources/access-discipline";
import { DAILY_PUBLISH_CAP, DAILY_REQUEST_CAP_PER_HOST, RETRY_MAX_ATTEMPTS } from "@/lib/constants";

vi.mock("@/lib/llm/batch", () => ({
  curateSingle: vi.fn(),
}));

vi.mock("@/lib/db/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/repository")>();
  return {
    ...actual,
    countPublishedSince: vi.fn(),
  };
});

const mockedCurate = vi.mocked(curateSingle);
const mockedCountPublishedSince = vi.mocked(countPublishedSince);

const HOST = "www.mwed.jp";
const DISALLOWED_HOST = "not-on-the-allowlist.example.com";

/** スキーマ（SingleCurationSchema = CurationItemSchema.omit({index})）に適合する十分な判定。 */
function sufficientCuration(overrides: Partial<CurationResult> = {}): CurationResult {
  return {
    title: "演出の予算配分で失敗しなかった話",
    summary: "式後の費用内訳と演出選択のトレードオフを当事者が具体的に語る体験談のサマリーです。",
    category: "費用・節約",
    tag: "classic",
    firsthand: 2,
    ceremonyDecision: 2,
    specific: 2,
    weddingDayContent: 2,
    promotional: 0,
    topicAnchor: "演出の予算配分",
    topics: ["演出予算", "予算配分"],
    rationaleText:
      "当事者の体験談として、式後の費用内訳と演出選択における具体的な判断材料が豊富に含まれている。",
    ...overrides,
  };
}

interface MockResponseInit {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

function resp({ status, body = "", headers = {} }: MockResponseInit) {
  // 実際の Headers と同様にキーを大文字小文字区別なしで引けるよう正規化する。
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: (name: string) => normalized[name.toLowerCase()] ?? null },
  };
}

const ALLOW_ALL_ROBOTS = "";
const DISALLOW_ALL_ROBOTS = "User-agent: *\nDisallow: /\n";

/**
 * 語彙的接地（`checkAnchorGrounding`）を通す本文。段落数・リンク密度・
 * 定型行率の Q1 ゲートも一緒に満たすよう、複数の `<p>` 段落と十分な文字数を
 * 持たせる。topicAnchor の特徴語（デフォルト「演出の予算配分」）を本文に
 * 逐語で含める。
 */
/**
 * HOST（www.mwed.jp）の `articleContainerSelectors` に一致する
 * `div.story-detail` でラップする。コンテナ抽出導入後、これでラップしないと
 * `extractArticleContainer()` が null を返し `container_not_found` として
 * 棄却されてしまうため、既存の全フィクスチャがこれに依存する。
 */
function articleHtml(
  title: string | null,
  opts: { bodyChars?: number; includeAnchor?: boolean } = {},
): string {
  const head = title ? `<head><title>${title}</title></head>` : "<head></head>";
  const bodyChars = opts.bodyChars ?? 2000;
  const anchorSentence =
    opts.includeAnchor === false ? "" : "演出の予算配分について詳しく書きます。";
  const filler = "あ".repeat(Math.max(0, bodyChars - anchorSentence.length));
  return `<html>${head}<body><div class="story-detail">${anchorSentence}<p>${filler}</p><p>準備の記録です。</p><p>当日の様子です。</p></div></body></html>`;
}

async function seedPending(host: string, url: string): Promise<void> {
  await seedDiscoverySeen(host, [{ url }]);
}

describe("discovery-ingest: computeBodyHash / bodyHashSimilarity", () => {
  it("同一入力は同一ハッシュになる（決定的）", () => {
    const text = "同じ本文です。".repeat(20);
    expect(computeBodyHash(text)).toBe(computeBodyHash(text));
  });

  it("同一ハッシュ同士の類似度は1", () => {
    const h = computeBodyHash("何らかの本文テキストです。".repeat(10));
    expect(bodyHashSimilarity(h, h)).toBe(1);
  });

  it("大きく異なる本文は類似度が閾値未満になる", () => {
    const a = computeBodyHash("結婚式の準備について書きます。".repeat(30));
    const b = computeBodyHash("全く関係のないプログラミングの話題です。".repeat(30));
    expect(bodyHashSimilarity(a, b)).toBeLessThan(0.7);
  });
});

describe("ingestDiscoveredUrls", () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    __resetStateForTests();
    // 既定では実時間を待たない。
    __setSleepForTests(async () => {});
    mockedCurate.mockReset();
    mockedCountPublishedSince.mockResolvedValue(0);
  });

  it("Q3: allowlist 外ホストはネットワーク I/O ゼロで一切処理しない", async () => {
    const url = `https://${DISALLOWED_HOST}/article-a`;
    await seedPending(DISALLOWED_HOST, url);
    const fetchMock = vi.fn(async () => {
      throw new Error("network must not be touched for a non-allowlisted host");
    });
    vi.stubGlobal("fetch", fetchMock);

    const stats = await ingestDiscoveredUrls(DISALLOWED_HOST);

    expect(stats.hostNotAllowed).toBe(true);
    expect(stats.processed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockedCurate).not.toHaveBeenCalled();
    expect((await getPostsByUrls([url])).size).toBe(0);
  });

  it("Q3深化: allowlist ホストでも記事パス外（口コミ投稿ページ）はネットワーク I/O ゼロで棄却する", async () => {
    const url = `https://${HOST}/hall/16479/rev/12345/`;
    await seedPending(HOST, url);
    const fetchMock = vi.fn(async () => {
      throw new Error("network must not be touched for a non-whitelisted article path");
    });
    vi.stubGlobal("fetch", fetchMock);

    const stats = await ingestDiscoveredUrls(HOST);

    expect(stats.skippedPathNotAllowed).toBe(1);
    expect(stats.processed).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockedCurate).not.toHaveBeenCalled();
    expect((await getPostsByUrls([url])).size).toBe(0);

    const counts = await countDiscoverySeenByStatus(HOST);
    expect(counts).toEqual({ pending: 0, fetched: 0, skipped: 1 });
  });

  it("境界: /hall/{id}/rev/story/{id}/ は許可され /hall/{id}/rev/{id}/ は許可されない", async () => {
    const allowedUrl = `https://${HOST}/hall/16479/rev/story/83/`;
    const disallowedUrl = `https://${HOST}/hall/16479/rev/83/`;
    await seedPending(HOST, allowedUrl);
    await seedPending(HOST, disallowedUrl);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === allowedUrl)
          return resp({ status: 200, body: articleHtml("式場レビュー配下の体験談") });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    mockedCurate.mockResolvedValue(sufficientCuration());

    const stats = await ingestDiscoveredUrls(HOST);

    expect(stats.published).toBe(1);
    expect(stats.skippedPathNotAllowed).toBe(1);
    expect((await getPostsByUrls([allowedUrl])).get(allowedUrl)?.status).toBe("published");
    expect((await getPostsByUrls([disallowedUrl])).size).toBe(0);
  });

  it("published: 抽出本文は excerpt に入れず rationale と本文ハッシュを記録する（§5.3/§11/Q4）", async () => {
    const url = `https://${HOST}/story/cases/article-a`;
    await seedPending(HOST, url);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url)
          return resp({ status: 200, body: articleHtml("演出の予算配分で失敗しなかった話") });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    mockedCurate.mockResolvedValue(sufficientCuration());

    const stats = await ingestDiscoveredUrls(HOST);

    expect(stats.processed).toBe(1);
    expect(stats.published).toBe(1);

    const post = (await getPostsByUrls([url])).get(url);
    expect(post).toBeDefined();
    expect(post?.status).toBe("published");
    // ⚠️ §11 受入基準: 抽出本文は originalExcerpt に絶対に入らない
    expect(post?.originalExcerpt).toBeNull();

    expect(mockedCurate).toHaveBeenCalledTimes(1);
    const curationInput = mockedCurate.mock.calls[0]?.[0];
    expect(curationInput?.excerpt).not.toContain("演出の予算配分で失敗しなかった話");

    const postId = post?.id;
    if (postId == null) throw new Error("post id should exist");
    const rationale = await getRationaleByPostId(postId);
    expect(rationale?.topicAnchor).toBe("演出の予算配分");

    // Q4 の計測に使う publication 記録（bodyHash 込み）。
    const pub = await db.select().from(postPublications).where(eq(postPublications.postId, postId));
    expect(pub).toHaveLength(1);
    expect(pub[0]?.bodyHash).toMatch(/^[0-9a-f]{16}$/);

    const counts = await countDiscoverySeenByStatus(HOST);
    expect(counts).toEqual({ pending: 0, fetched: 1, skipped: 0 });
  });

  it("originalTitle: コンテナ内に h1 があれば <title> ではなく h1 のテキストを使う", async () => {
    const url = `https://${HOST}/story/cases/with-h1`;
    await seedPending(HOST, url);
    const htmlTitle =
      "ゲストの方との縁を伝えたロイヤルクラシックな結婚式 - ウェスティンホテル東京の事例 | みんなのウェディング";
    const h1Text = "ゲストの方との縁を伝えたロイヤルクラシックな結婚式";
    const bodyChars = 2000;
    const anchorSentence = "演出の予算配分について詳しく書きます。";
    const filler = "あ".repeat(Math.max(0, bodyChars - anchorSentence.length));
    const html = `<html><head><title>${htmlTitle}</title></head><body><div class="story-detail"><article class="story-detail-main-visual"><div class="story-detail-main-visual-header"><h1 class="story-detail-main-visual-header__title">${h1Text}</h1></div></article>${anchorSentence}<p>${filler}</p><p>準備の記録です。</p><p>当日の様子です。</p></div></body></html>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url) return resp({ status: 200, body: html });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    mockedCurate.mockResolvedValue(sufficientCuration());

    const stats = await ingestDiscoveredUrls(HOST);
    expect(stats.published).toBe(1);

    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.originalTitle).toBe(h1Text);
    expect(post?.originalTitle).not.toBe(htmlTitle);
  });

  it("originalTitle: h1 が無いページは従来どおり <title> にフォールバックする（回帰防止）", async () => {
    const url = `https://${HOST}/story/cases/no-h1`;
    await seedPending(HOST, url);
    const htmlTitle = "h1 の無いページのタイトル";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        // articleHtml() のコンテナ（div.story-detail）は <h1> を含まない。
        if (u === url) return resp({ status: 200, body: articleHtml(htmlTitle) });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    mockedCurate.mockResolvedValue(sufficientCuration());

    const stats = await ingestDiscoveredUrls(HOST);
    expect(stats.published).toBe(1);

    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.originalTitle).toBe(htmlTitle);
  });

  it("Q1: 本文が薄い場合は LLM を呼ばず extraction_insufficient で終端棄却する", async () => {
    const url = `https://${HOST}/story/cases/thin`;
    await seedPending(HOST, url);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        // MIN_EVIDENCE_INPUT_CHARS=30（2026-08-29 緩和）未満にするため極端に短くする。
        if (u === url)
          return resp({
            status: 200,
            body: articleHtml("短い話", { bodyChars: 5, includeAnchor: false }),
          });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );

    const stats = await ingestDiscoveredUrls(HOST);

    expect(stats.extractionInsufficientDropped).toBe(1);
    expect(stats.published).toBe(0);
    // Q1: 決定的ゲート不合格時は LLM を一切呼ばない（自己申告の廃止）。
    expect(mockedCurate).not.toHaveBeenCalled();
    // 条件別カウンタ: 本文が短いだけで段落数・リンク密度・定型行率は満たすため
    // text_length のみが計上され、他の内訳は増えない。
    expect(stats.extractionFailedByTextLength).toBe(1);
    expect(stats.extractionFailedByLinkDensity).toBe(0);
    expect(stats.extractionFailedByParagraphCount).toBe(0);
    expect(stats.extractionFailedByContainer).toBe(0);

    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.status).toBe("rejected");
    expect(post?.originalExcerpt).toBeNull();
    if (post?.id == null) throw new Error("post id should exist");
    const removal = await db.select().from(postRemovals).where(eq(postRemovals.postId, post.id));
    expect(removal[0]?.kind).toBe("dropped");
    expect(removal[0]?.reason).toBe("extraction_insufficient:text_length");

    const counts = await countDiscoverySeenByStatus(HOST);
    expect(counts.fetched).toBe(1);
  });

  it("Q1: div ベース（<p> タグなし）の実サイト構造は paragraph_count 条件で棄却され内訳カウンタに計上される", async () => {
    // 本番（www.mwed.jp 初回 discovery）で processed=50/published=0 となった
    // 事象の再現フィクスチャ。div ベースのページは既存の articleHtml() が
    // 常に <p> を3つ含んでいたため、この失敗モードがテストで検知できなかった。
    const url = `https://${HOST}/story/cases/div-based`;
    await seedPending(HOST, url);
    const divBody = "実際に結婚式を挙げた新婦が会場選びについて詳しく振り返った体験談です。".repeat(
      20,
    );
    const divHtml = `<html><head><title>体験談タイトル</title></head><body><div class="story-detail"><div class="content">${divBody}</div></div></body></html>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url) return resp({ status: 200, body: divHtml });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );

    const stats = await ingestDiscoveredUrls(HOST);

    expect(stats.extractionInsufficientDropped).toBe(1);
    expect(mockedCurate).not.toHaveBeenCalled();
    expect(stats.extractionFailedByParagraphCount).toBe(1);
    expect(stats.extractionFailedByTextLength).toBe(0);
  });

  it("コンテナ抽出: articleContainerSelectors のいずれにも一致しないページは container_not_found で終端棄却し、LLM を呼ばない", async () => {
    const url = `https://${HOST}/story/cases/no-container`;
    await seedPending(HOST, url);
    // div.story-detail / div.produce-story-detail のどちらにも一致しない
    // レイアウト（テンプレート変更のシミュレーション）。中身自体は Q1 の
    // 他条件（文字数・段落数・リンク密度）を満たす分量にしてあるが、
    // コンテナが見つからない時点で他の指標は一切計算されず即座に棄却される。
    const noContainerHtml = `<html><head><title>体験談タイトル</title></head><body>
      <div class="totally-different-layout">
        <p>実際に結婚式を挙げた新婦が会場選びについて詳しく振り返り、持ち込み料の交渉や式場探しの体験を丁寧に説明しています。</p>
        <p>披露宴の演出やスピーチ依頼についても具体的な工夫を紹介しており読者にとって参考になる内容が多く含まれています。</p>
        <p>装花や引出物の選び方についても触れられており当日の段取りをどう組み立てたかが具体的に書かれています。</p>
      </div>
    </body></html>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url) return resp({ status: 200, body: noContainerHtml });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );

    const stats = await ingestDiscoveredUrls(HOST);

    expect(stats.extractionInsufficientDropped).toBe(1);
    expect(stats.extractionFailedByContainer).toBe(1);
    expect(stats.extractionFailedByTextLength).toBe(0);
    expect(stats.extractionFailedByLinkDensity).toBe(0);
    expect(stats.extractionFailedByParagraphCount).toBe(0);
    expect(mockedCurate).not.toHaveBeenCalled();

    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.status).toBe("rejected");
    if (post?.id == null) throw new Error("post id should exist");
    const removal = await db.select().from(postRemovals).where(eq(postRemovals.postId, post.id));
    expect(removal[0]?.kind).toBe("dropped");
    expect(removal[0]?.reason).toBe("extraction_insufficient:container_not_found");
  });

  it("M1: タイトルフィルタ不合格（記号連打）は title_filter で終端棄却する", async () => {
    // 2026-08-29: 広告マーカー（【PR】等）は棄却対象外。表示が壊れるケースのみ棄却。
    const url = `https://${HOST}/story/cases/broken-title`;
    await seedPending(HOST, url);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url)
          return resp({ status: 200, body: articleHtml("演出の予算配分の話！！！！") });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    mockedCurate.mockResolvedValue(sufficientCuration());

    const stats = await ingestDiscoveredUrls(HOST);

    expect(stats.titleFilterDropped).toBe(1);
    expect(stats.published).toBe(0);
    // タイトルフィルタは LLM 呼び出し後（curation 結果の topicAnchor を使う訳ではないが）
    // タイトルはフェッチ直後に確定するため、実装は呼ぶ・呼ばないどちらもあり得る。
    // ここでは終端理由のみを検証する。

    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.status).toBe("rejected");
    if (post?.id == null) throw new Error("post id should exist");
    const removal = await db.select().from(postRemovals).where(eq(postRemovals.postId, post.id));
    expect(removal[0]?.reason).toBe("title_filter");
  });

  it("M1/D5: topicAnchor が本文に接地しない場合は anchor_ungrounded で棄却せず、topicAnchor=null で公開する", async () => {
    const url = `https://${HOST}/story/cases/ungrounded`;
    await seedPending(HOST, url);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        // 本文には topicAnchor の特徴語（後述の "架空の特徴語" 系）を含めない。
        if (u === url)
          return resp({
            status: 200,
            body: articleHtml("式後の振り返り", { includeAnchor: false }),
          });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    // D5 (plan 16): LLM が 2 回目も接地しない場合、curateSingle が topicAnchor を null に
    // degrade する。ここではその結果（null）を模擬して呼び出し側の公開挙動を検証する。
    mockedCurate.mockResolvedValue(sufficientCuration({ topicAnchor: null }));

    const stats = await ingestDiscoveredUrls(HOST);

    // D5: 棄却せず公開する。
    expect(stats.anchorUngroundedDropped).toBe(0);
    expect(stats.published).toBe(1);

    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.status).toBe("published");
    if (post?.id == null) throw new Error("post id should exist");
    const removal = await db.select().from(postRemovals).where(eq(postRemovals.postId, post.id));
    expect(removal).toHaveLength(0);
    // topicAnchor が null のため、rationale 行は書き込まれない（markCurated がスキップ）。
    const rationale = await getRationaleByPostId(post.id);
    expect(rationale).toBeNull();
  });

  it("Q4: 日次公開上限に達したら公開せず rate_capped として再試行キューに入る（終端棄却しない）", async () => {
    // 実 DB への DAILY_PUBLISH_CAP 件シードでも再現できるが、他の値変更に
    // 追随しやすいよう、カウント関数のモックで上限到達を再現する。
    // （pipeline-evergreen / pipeline-submit-url の Q4 と同じパターン）。
    mockedCountPublishedSince.mockResolvedValue(DAILY_PUBLISH_CAP);

    const url = `https://${HOST}/story/cases/over-cap`;
    await seedPending(HOST, url);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url) return resp({ status: 200, body: articleHtml("上限超過の話") });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    mockedCurate.mockResolvedValue(sufficientCuration());

    const stats = await ingestDiscoveredUrls(HOST);

    expect(stats.rateCapped).toBe(1);
    expect(stats.published).toBe(0);

    // 終端棄却されていない: post 行は作られない（次回以降の再判定に委ねる）。
    expect((await getPostsByUrls([url])).size).toBe(0);

    const queued = await db.select().from(postRetryQueue).where(eq(postRetryQueue.url, url));
    expect(queued).toHaveLength(1);
    expect(queued[0]?.reason).toBe("rate_capped");
  });

  it("Q4: ホスト別シェア上限は廃止されている（2026-08-29 の方針転換。spec §11 項4）。同一ホストが同日に多数公開済みでも公開される", async () => {
    // 旧仕様では単一ホストが日次上限×0.5 件に達すると rate_capped にしていた。
    // 廃止後は日次サーキットブレーカー（150）にのみ従う。日次総数が上限未満
    // である限り、同一ホストの何件目でも公開される。
    mockedCountPublishedSince.mockResolvedValue(100);

    const url = `https://${HOST}/story/cases/no-host-share-cap`;
    await seedPending(HOST, url);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url) return resp({ status: 200, body: articleHtml("ホスト偏りを気にしない話") });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    mockedCurate.mockResolvedValue(sufficientCuration());

    const stats = await ingestDiscoveredUrls(HOST);

    expect(stats.rateCapped).toBe(0);
    expect(stats.published).toBe(1);
  });

  // 以下 2 件は上のテストと異なり、DAILY_PUBLISH_CAP から動的に期待値を
  // 導出せず、具体的な数値をリテラルで固定する。定数の値が変わった場合に
  // テストが自動追随せず落ちることが目的（AGENTS.md「ゲートが緑であること
  // と機能していることは別」／ plan 07 §14 の回帰）。

  it("Q4: 日次公開サーキットブレーカーは 150 件に固定されている（供給スロットルではなく暴走検知。spec §11 項4）", () => {
    // 値を変えたい場合は openspec/specs/wedding-trend/spec.md §11.4 と
    // shared_plan/10-publication-policy-review.md を更新したうえで、このテストの
    // リテラル値も合わせて更新すること。
    expect(DAILY_PUBLISH_CAP).toBe(150);
  });

  it("Q4: 境界値 — 当日 149 件公開済みなら 150 件目は公開され、150 件公開済みなら 151 件目は rate_capped になる（off-by-one固定）", async () => {
    // 149 件済み（リテラル 149）→ 150 件目は上限未到達として公開される。
    mockedCountPublishedSince.mockResolvedValue(149);

    const urlOk = `https://${HOST}/story/cases/boundary-ok`;
    await seedPending(HOST, urlOk);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === urlOk) return resp({ status: 200, body: articleHtml("境界値ちょうど手前の話") });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    mockedCurate.mockResolvedValue(sufficientCuration());

    const statsOk = await ingestDiscoveredUrls(HOST);
    expect(statsOk.rateCapped).toBe(0);
    expect(statsOk.published).toBe(1);

    // 150 件済み（リテラル 150）→ 151 件目は上限到達として rate_capped。
    mockedCountPublishedSince.mockResolvedValue(150);

    const urlOver = `https://${HOST}/story/cases/boundary-over`;
    await seedPending(HOST, urlOver);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === urlOver) return resp({ status: 200, body: articleHtml("境界値ちょうどの話") });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );

    const statsOver = await ingestDiscoveredUrls(HOST);
    expect(statsOver.rateCapped).toBe(1);
    expect(statsOver.published).toBe(0);
  });

  it("§7: 一時的失敗（5xx）は再試行キューに積み、TTL 超過分は retry_exhausted で終端棄却する", async () => {
    const url = `https://${HOST}/story/cases/boom`;
    await seedPending(HOST, url);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url) return resp({ status: 500 });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );

    const firstRun = await ingestDiscoveredUrls(HOST);
    expect(firstRun.enqueuedRetries).toBe(1);
    expect((await getPostsByUrls([url])).size).toBe(0);

    const queuedBefore = await db.select().from(postRetryQueue).where(eq(postRetryQueue.url, url));
    expect(queuedBefore).toHaveLength(1);
    expect(queuedBefore[0]?.reason).toBe("fetch_transient");

    // TTL を過去に押し戻して次回ランで期限切れとして扱われるようにする。
    await db
      .update(postRetryQueue)
      .set({
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        nextAttemptAt: new Date(Date.now() - 60_000).toISOString(),
      })
      .where(eq(postRetryQueue.url, url));

    const secondRun = await ingestDiscoveredUrls(HOST);
    expect(secondRun.retryExhausted).toBe(1);

    const queuedAfter = await db.select().from(postRetryQueue).where(eq(postRetryQueue.url, url));
    expect(queuedAfter).toHaveLength(0);

    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.status).toBe("rejected");
    if (post?.id == null) throw new Error("post id should exist");
    const removal = await db.select().from(postRemovals).where(eq(postRemovals.postId, post.id));
    // 終端理由には再試行キューが保持していた元の失敗理由（fetch_transient）が残る。
    expect(removal[0]?.reason).toBe("retry_exhausted:fetch_transient:attempts=1");
  });

  it("§7: 最大試行回数超過（TTL 内）で終端棄却した場合もキューの理由が残る", async () => {
    const url = `https://${HOST}/story/cases/max-attempts`;
    const now = new Date().toISOString();
    // discovery レーンの due エントリを、最大試行数に達した状態で直接シードする
    // （TTL はまだ切れていないため、TTL 超過ループではなく最大試行超過の判定に入る）。
    await db.insert(postRetryQueue).values({
      urlHash: "max-attempts-hash",
      url,
      host: HOST,
      lane: "discovery",
      reason: "llm_transient",
      attempts: RETRY_MAX_ATTEMPTS,
      firstQueuedAt: now,
      nextAttemptAt: now,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    const stats = await ingestDiscoveredUrls(HOST);
    expect(stats.retryExhausted).toBe(1);

    const remaining = await db.select().from(postRetryQueue).where(eq(postRetryQueue.url, url));
    expect(remaining).toHaveLength(0);

    const post = (await getPostsByUrls([url])).get(url);
    if (post?.id == null) throw new Error("post id should exist");
    expect(post.status).toBe("rejected");
    const removal = await db.select().from(postRemovals).where(eq(postRemovals.postId, post.id));
    // 最大試行超過の経路（due ループ内）でも、キューが保持していた元の失敗理由
    // （llm_transient）と試行回数が終端理由に残る。
    expect(removal[0]?.reason).toBe(`retry_exhausted:llm_transient:attempts=${RETRY_MAX_ATTEMPTS}`);
  });

  it("M1: 既に自動撤回（retracted）済みの post は sticky で再公開しない", async () => {
    const url = `https://${HOST}/story/cases/already-retracted`;
    const upsertResult = await upsertPosts([
      {
        url,
        sourceType: "blog",
        sourceId: "evergreen",
        sourceName: "mwed",
        originalTitle: "撤回済みの記事",
        originalExcerpt: null,
        author: null,
        thumbnailUrl: null,
        publishedAt: null,
        status: "published",
      },
    ]);
    expect(upsertResult.failed).toEqual([]);
    const existing = (await getPostsByUrls([url])).get(url);
    if (existing?.id == null) throw new Error("post id should exist");
    await markRetracted(existing.id, "source_gone", new Date().toISOString());
    expect(await isRemoved(existing.id)).toBe(true);

    await seedPending(HOST, url);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url) return resp({ status: 200, body: articleHtml("撤回済みの記事") });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    mockedCurate.mockResolvedValue(sufficientCuration());

    const stats = await ingestDiscoveredUrls(HOST);

    expect(stats.stickyRemovedBlocked).toBe(1);
    expect(stats.published).toBe(0);

    const post = (await getPostsByUrls([url])).get(url);
    // sticky: retracted のまま。published に戻っていない。
    expect(post?.status).toBe("retracted");
  });

  it("robots 不許可: 記事を取得せず skipped にする", async () => {
    const url = `https://${HOST}/story/cases/blocked`;
    await seedPending(HOST, url);
    const fetchMock = vi.fn(async (input: string | URL) => {
      const u = String(input);
      if (u.endsWith("/robots.txt")) return resp({ status: 200, body: DISALLOW_ALL_ROBOTS });
      return resp({ status: 200, body: articleHtml("取得されるべきでない話") });
    });
    vi.stubGlobal("fetch", fetchMock);

    const stats = await ingestDiscoveredUrls(HOST);

    expect(stats.skippedRobots).toBe(1);
    const articleCalls = fetchMock.mock.calls.filter((c) => !String(c[0]).endsWith("/robots.txt"));
    expect(articleCalls.length).toBe(0);
    expect((await getPostsByUrls([url])).size).toBe(0);

    const counts = await countDiscoverySeenByStatus(HOST);
    expect(counts.skipped).toBe(1);
  });

  it("404 は skipped、post 行は作られない", async () => {
    const goneUrl = `https://${HOST}/story/cases/gone`;
    await seedDiscoverySeen(HOST, [{ url: goneUrl }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === goneUrl) return resp({ status: 404 });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );

    const stats = await ingestDiscoveredUrls(HOST);

    expect(stats.skippedGone).toBe(1);
    const counts = await countDiscoverySeenByStatus(HOST);
    expect(counts).toEqual({ pending: 0, fetched: 0, skipped: 1 });
    expect((await getPostsByUrls([goneUrl])).size).toBe(0);
  });

  it("kill gate 発火でランを中断する（K3: 451）", async () => {
    const forbiddenUrl = `https://${HOST}/story/cases/forbidden`;
    await seedPending(HOST, forbiddenUrl);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === forbiddenUrl) return resp({ status: 451 });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );

    const stats = await ingestDiscoveredUrls(HOST);

    expect(stats.abortedByKillGate).toBe(true);
    expect(stats.processed).toBe(1);

    const counts = await countDiscoverySeenByStatus(HOST);
    expect(counts.pending).toBe(1);

    const state = await getHostGateState(HOST);
    expect(state?.stateKind).toBe("permanent");
    expect(state?.gateId).toBe("K3");
  });

  it("恒久停止ホストの次ランはネットワーク I/O ゼロで拒否される", async () => {
    await saveHostGateState({
      host: HOST,
      gateId: "K3",
      stateKind: "permanent",
      untilAt: null,
      k4Strikes: 0,
      last429At: null,
      countDay: new Date().toISOString().slice(0, 10),
      countValue: 0,
    });
    const laterUrl = `https://${HOST}/story/cases/later`;
    await seedPending(HOST, laterUrl);
    const fetchMock = vi.fn(async () => {
      throw new Error("network must not be touched");
    });
    vi.stubGlobal("fetch", fetchMock);

    const stats = await ingestDiscoveredUrls(HOST);

    expect(stats.abortedByKillGate).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockedCurate).not.toHaveBeenCalled();
  });

  // 2026-09-02: time budget撤廃によりテスト削除またはスキップ。
  it.skip("時間予算 0 なら何も処理せず budgetExhausted を返す", async () => {
    const url = `https://${HOST}/story/cases/unreached`;
    await seedPending(HOST, url);
    const fetchMock = vi.fn(async (input: string | URL) => {
      const u = String(input);
      if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
      return resp({ status: 200, body: articleHtml("予算切れの話") });
    });
    vi.stubGlobal("fetch", fetchMock);

    const stats = await ingestDiscoveredUrls(HOST, { budgetMs: 0 });

    expect(stats.budgetExhausted).toBe(true);
    expect(stats.processed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockedCurate).not.toHaveBeenCalled();

    const counts = await countDiscoverySeenByStatus(HOST);
    expect(counts.pending).toBe(1);
  });

  it("<title> が取れないページ: 保存せず skippedNoTitle で打ち切り", async () => {
    const url = `https://${HOST}/story/cases/no-title`;
    await seedPending(HOST, url);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url) return resp({ status: 200, body: articleHtml(null) });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );

    const stats = await ingestDiscoveredUrls(HOST);

    expect(stats.skippedNoTitle).toBe(1);
    expect((await getPostsByUrls([url])).size).toBe(0);

    const counts = await countDiscoverySeenByStatus(HOST);
    expect(counts.skipped).toBe(1);
  });

  it("取得サイズ上限超過: skippedTooLarge にしてランを中断せず次の URL へ進む", async () => {
    const hugeUrl = `https://${HOST}/story/cases/huge`;
    const nextUrl = `https://${HOST}/story/cases/next`;
    await seedDiscoverySeen(HOST, [{ url: hugeUrl }, { url: nextUrl }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === hugeUrl)
          return resp({
            status: 200,
            body: "",
            headers: { "content-length": String(512 * 1024 + 1) },
          });
        if (u === nextUrl) return resp({ status: 200, body: articleHtml("次の記事") });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    mockedCurate.mockResolvedValue(sufficientCuration());

    const stats = await ingestDiscoveredUrls(HOST);

    expect(stats.skippedTooLarge).toBe(1);
    expect(stats.abortedByKillGate).toBe(false);
    expect(stats.abortedByRetryAfter).toBe(false);
    expect(stats.published).toBe(1);
    expect((await getPostsByUrls([hugeUrl])).size).toBe(0);

    const counts = await countDiscoverySeenByStatus(HOST);
    expect(counts.skipped).toBe(1);
    expect(counts.fetched).toBe(1);
  });

  describe("Q2: recordHostMetrics のテレメトリはどの終了経路でも正確に1回記録される", () => {
    async function readHostMetricsRow(host: string, day: string) {
      const rows = await db
        .select()
        .from(discoveryHostMetrics)
        .where(and(eq(discoveryHostMetrics.host, host), eq(discoveryHostMetrics.day, day)));
      return rows[0];
    }

    /** jstDayKey() と同じ JST 暦日キーを返すテストヘルパー。 */
    function jstToday(): string {
      const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
      const jstMs = Date.now() + JST_OFFSET_MS;
      return new Date(jstMs).toISOString().slice(0, 10);
    }

    it("B1（日次リクエスト予算）で中断したとき、中断前に処理した件数が discovery_host_metrics に記録される（0でも満数でもない）", async () => {
      // saveHostGateState の countDay は access-discipline.ts の todayUTC()
      // （＝UTC の暦日）と比較されるため UTC で渡す必要がある。
      // 一方、discovery_host_metrics の day 列は discovery-ingest.ts の
      // jstDayKey()（＝JST の暦日）で書き込まれるため、metrics 行の参照
      // には jstToday() を使う。2 つは UTC/JST の境目で 1 日ずれることがある。
      const utcToday = new Date().toISOString().slice(0, 10);
      const today = jstToday();
      // B1 の閾値ちょうど手前まで既に消費させておく。robots.txt の取得自体も
      // 日次カウントを1消費する（disciplinedFetch は robots 取得後にも
      // capRecheck を行う）ため、1件目の URL 処理だけで robots+article の
      // 2リクエスト分を消費する。よって「1件目は通り、2件目の直前で B1 に
      // 到達する」状態を作るには CAP - 2 から開始する必要がある
      // （本番の processed=50/50 中断の再現）。
      await saveHostGateState({
        host: HOST,
        gateId: null,
        stateKind: "none",
        untilAt: null,
        k4Strikes: 0,
        last429At: null,
        countDay: utcToday,
        countValue: DAILY_REQUEST_CAP_PER_HOST - 2,
      });

      const okUrl = `https://${HOST}/story/cases/before-b1`;
      const blockedUrl = `https://${HOST}/story/cases/after-b1`;
      await seedDiscoverySeen(HOST, [{ url: okUrl }, { url: blockedUrl }]);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL) => {
          const u = String(input);
          if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
          if (u === okUrl) return resp({ status: 200, body: articleHtml("上限直前の記事") });
          throw new Error(`unexpected fetch: ${u} (B1 must block network I/O for this URL)`);
        }),
      );
      mockedCurate.mockResolvedValue(sufficientCuration());

      const stats = await ingestDiscoveredUrls(HOST);

      // B1（soft stop）は abortedByBudget のみを立て、abortedByKillGate は
      // false のままにする（両者が同時に true になってはならない）。
      expect(stats.abortedByBudget).toBe(true);
      expect(stats.abortedByKillGate).toBe(false);
      // `processUrl()` は `stats.processed++` を関数の先頭・kill_gate 判定より
      // 前で行う（disciplinedFetch の戻り値を見る前）ため、B1 でネットワーク
      // I/O ゼロのまま中断された2件目もカウントされる。これは
      // `DiscoveryIngestStats.processed` 自身のドキュメントコメント
      // 「処理を試みた URL 数」（＝attempted、succeeded ではない）と整合する
      // 挙動であり、コードを直接確認して固定した値。
      // 本テストの本体は「0（テレメトリ行が作られない旧実装）でも
      // 全件処理完了時の満数でもない、中断前の実測 stats がそのまま
      // 記録されること」であり、その意図はこの値でも保たれている。
      expect(stats.processed).toBe(2);
      expect(stats.published).toBe(1);

      // B1 発火では host_gate_state に stateKind/gateId/untilAt が書かれない
      // （永続停止にならない = 人手解除不要）。
      const gate = await getHostGateState(HOST);
      expect(gate?.stateKind ?? null).not.toBe("stopped");
      expect(gate?.stateKind ?? null).not.toBe("permanent");
      expect(gate?.stateKind ?? null).not.toBe("cooloff");
      expect(gate?.gateId).toBeNull();
      expect(gate?.untilAt).toBeNull();

      const row = await readHostMetricsRow(HOST, today);
      expect(row).toBeDefined();
      expect(row?.processed).toBe(stats.processed);
      expect(row?.published).toBe(stats.published);
    });

    it("1回の呼び出しにつき discovery_host_metrics への加算はちょうど1回である（ループ側との二重記録が無い）", async () => {
      const today = jstToday();
      const urlA = `https://${HOST}/story/cases/dup-a`;
      const urlB = `https://${HOST}/story/cases/dup-b`;
      await seedDiscoverySeen(HOST, [{ url: urlA }, { url: urlB }]);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL) => {
          const u = String(input);
          if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
          return resp({ status: 200, body: articleHtml("正常完了記事") });
        }),
      );
      mockedCurate.mockResolvedValue(sufficientCuration());

      const stats = await ingestDiscoveredUrls(HOST);

      expect(stats.abortedByKillGate).toBe(false);
      const row = await readHostMetricsRow(HOST, today);
      expect(row).toBeDefined();
      // 二重記録（ループ内 + finally の両方で加算）なら processed は
      // stats.processed の2倍になってしまう。ちょうど1回なら一致する。
      expect(row?.processed).toBe(stats.processed);
      expect(row?.published).toBe(stats.published);
    });

    it("正常完了時の挙動は従来と変わらない（回帰防止）", async () => {
      const today = jstToday();
      const url = `https://${HOST}/story/cases/normal-complete`;
      await seedPending(HOST, url);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL) => {
          const u = String(input);
          if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
          if (u === url) return resp({ status: 200, body: articleHtml("通常完了の記事") });
          throw new Error(`unexpected fetch: ${u}`);
        }),
      );
      mockedCurate.mockResolvedValue(sufficientCuration());

      const stats = await ingestDiscoveredUrls(HOST);

      expect(stats.abortedByKillGate).toBe(false);
      expect(stats.published).toBe(1);
      const row = await readHostMetricsRow(HOST, today);
      expect(row?.processed).toBe(1);
      expect(row?.published).toBe(1);
    });

    it("kill gate 以外の予期しない例外がループ中に飛んだ場合、部分的なテレメトリは記録され、かつ例外は呼び出し元へ伝播する", async () => {
      // ⚠️ fetch 自体が投げる例外は `performFetch()`（access-discipline.ts）が
      // 意図的に catch し `http_error(status:0)` → 再試行キューへ、という
      // 正常系のフェイルセーフ経路になる（実測: enqueuedRetries が増えるだけで
      // 例外は伝播しない）。これは仕様であり、本テストが検証したい「本当に
      // 未捕捉のまま上がってくる例外」の再現には使えない。discovery-ingest.ts
      // 内で try/catch されずに直接 await されている `curateSingle()`
      // （抽出ゲート通過後、Q1 の後段で呼ばれる LLM 呼び出し）が投げるケースを
      // 使うことで、実際に未捕捉のまま呼び出し元へ抜ける例外を再現する。
      const today = jstToday();
      const okUrl = `https://${HOST}/story/cases/before-crash`;
      const crashUrl = `https://${HOST}/story/cases/crash`;
      await seedDiscoverySeen(HOST, [{ url: okUrl }, { url: crashUrl }]);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL) => {
          const u = String(input);
          if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
          if (u === okUrl) return resp({ status: 200, body: articleHtml("クラッシュ前の記事") });
          if (u === crashUrl)
            return resp({ status: 200, body: articleHtml("クラッシュ対象の記事") });
          throw new Error(`unexpected fetch: ${u}`);
        }),
      );
      mockedCurate
        .mockResolvedValueOnce(sufficientCuration())
        .mockRejectedValueOnce(new Error("simulated unexpected llm client failure"));

      await expect(ingestDiscoveredUrls(HOST)).rejects.toThrow(
        "simulated unexpected llm client failure",
      );

      const row = await readHostMetricsRow(HOST, today);
      expect(row).toBeDefined();
      // 1件目（正常処理）分のテレメトリは記録されている。例外そのものは
      // 呼び出し元へ伝播済みなので、ここでは finally が記録した値のみ検証する。
      expect(row?.processed).toBeGreaterThanOrEqual(1);
      expect(row?.published).toBe(1);
    });
  });
});

describe("revalidatePublishedPosts (M4)", () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.restoreAllMocks();
    __resetStateForTests();
    __setSleepForTests(async () => {});
  });

  async function seedPublished(url: string, title = "既存の公開記事"): Promise<number> {
    await upsertPosts([
      {
        url,
        sourceType: "blog",
        sourceId: "evergreen",
        sourceName: "mwed",
        originalTitle: title,
        originalExcerpt: null,
        author: null,
        thumbnailUrl: null,
        publishedAt: null,
        status: "published",
      },
    ]);
    const post = (await getPostsByUrls([url])).get(url);
    if (post?.id == null) throw new Error("post id should exist");
    return post.id;
  }

  it("bodyHash が null の post はシード扱いになり、その回は撤回しない", async () => {
    const url = `https://${HOST}/story/cases/legacy-published`;
    const postId = await seedPublished(url);

    // post_publications にまだ行が無いことを確認（シード対象の前提）。
    const before = await db
      .select()
      .from(postPublications)
      .where(eq(postPublications.postId, postId));
    expect(before).toHaveLength(0);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url) return resp({ status: 200, body: articleHtml("既存の公開記事") });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );

    const stats = await revalidatePublishedPosts();

    expect(stats.seeded).toBe(1);
    expect(stats.retractedBodyChanged).toBe(0);

    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.status).toBe("published");

    const after = await db
      .select()
      .from(postPublications)
      .where(eq(postPublications.postId, postId));
    expect(after).toHaveLength(1);
    expect(after[0]?.bodyHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("D3: 本文ハッシュを持たないレーン（surrogate）由来の post は body_changed で撤回されない", async () => {
    // rss/evergreen/submit レーンをシミュレート: HOST_ALLOWLIST に無いホストの
    // post を、bodyHash = computeContentHash(title, excerpt) 相当の代替値・
    // hashKind = "surrogate" で公開する（本文は一切取得していない）。
    const url = `https://${DISALLOWED_HOST}/blog/entry-1`;
    const postId = await seedPublished(url, "既存の公開記事（RSS 由来）");
    await recordPublication(
      postId,
      new Date().toISOString(),
      computeBodyHash("既存の公開記事（RSS 由来） 抜粋テキスト"),
      "surrogate",
      0,
      0,
      0,
    );

    // 再検証が本文を取得しに行った場合、この内容とは一致しないハッシュになる
    // （= 修正前の実装なら body_changed で誤って撤回される）。
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url)
          return resp({
            status: 200,
            body: articleHtml("全く別の実際の記事本文です", { includeAnchor: false }),
          });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );

    const stats = await revalidatePublishedPosts();

    expect(stats.retractedBodyChanged).toBe(0);
    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.status).toBe("published");
  });

  it("D3: allowlist 外ホストの再検証は記事本文を GET しない（ステータス確認のみ）", async () => {
    const url = `https://${DISALLOWED_HOST}/blog/entry-2`;
    const postId = await seedPublished(url, "既存の公開記事（RSS 由来）");
    await recordPublication(
      postId,
      new Date().toISOString(),
      computeBodyHash("既存の公開記事（RSS 由来） 抜粋テキスト"),
      "surrogate",
      0,
      0,
      0,
    );

    let articleFetched = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url) {
          articleFetched = true;
          return resp({ status: 200, body: articleHtml("本文") });
        }
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );

    const stats = await revalidatePublishedPosts();

    // 存在確認（ステータス）のための GET 自体は disciplinedFetch の既存契約上
    // 発生するが、レスポンス本文は読まれない（.text() を呼ばない）ため
    // ドリフト判定・ハッシュ再計算は一切行われない。
    expect(articleFetched).toBe(true);
    expect(stats.retractedBodyChanged).toBe(0);
    expect(stats.ok).toBe(1);
    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.status).toBe("published");
  });

  it("404/410 に転じた post は source_gone で自動撤回する", async () => {
    const url = `https://${HOST}/story/cases/now-gone`;
    const postId = await seedPublished(url);
    await recordPublication(
      postId,
      new Date().toISOString(),
      computeBodyHash("元の本文です。"),
      "body",
      0,
      0,
      0,
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url) return resp({ status: 404 });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );

    const stats = await revalidatePublishedPosts();

    expect(stats.retractedSourceGone).toBe(1);
    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.status).toBe("retracted");
  });

  it("robots.txt が不許可に転じた post は robots_disallowed で自動撤回する", async () => {
    const url = `https://${HOST}/story/cases/now-disallowed`;
    const postId = await seedPublished(url);
    await recordPublication(
      postId,
      new Date().toISOString(),
      computeBodyHash("元の本文です。"),
      "body",
      0,
      0,
      0,
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: DISALLOW_ALL_ROBOTS });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );

    const stats = await revalidatePublishedPosts();

    expect(stats.retractedRobotsDisallowed).toBe(1);
    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.status).toBe("retracted");
  });

  it("本文ハッシュの類似度が閾値未満なら body_changed で自動撤回する", async () => {
    const url = `https://${HOST}/story/cases/drifted`;
    const postId = await seedPublished(url);
    const originalHash = computeBodyHash(
      "結婚式の準備について詳しく書いた元々の記事本文です。".repeat(10),
    );
    await recordPublication(postId, new Date().toISOString(), originalHash, "body", 0, 0, 0);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url)
          return resp({
            status: 200,
            body: `<html><head><title>差し替え後</title></head><body><div class="story-detail">${"全く無関係なプログラミング入門講座の内容に差し替わっています。".repeat(10)}</div></body></html>`,
          });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );

    const stats = await revalidatePublishedPosts();

    expect(stats.retractedBodyChanged).toBe(1);
    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.status).toBe("retracted");
  });

  it("撤回済み（sticky）の post は自動で published に戻さない", async () => {
    const url = `https://${HOST}/story/cases/stays-retracted`;
    const postId = await seedPublished(url);
    await markRetracted(postId, "source_gone", new Date().toISOString());

    // 撤回後は listPublishedForRevalidation の対象外（status != "published"）。
    const stats = await revalidatePublishedPosts();
    expect(stats.checked).toBe(0);

    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.status).toBe("retracted");
  });

  it("B1（日次リクエスト予算消化）で中断した post は soft stop として撤回しない", async () => {
    const url = `https://${HOST}/story/cases/budget-during-revalidate`;
    const postId = await seedPublished(url);
    await recordPublication(
      postId,
      new Date().toISOString(),
      computeBodyHash("元の本文です。"),
      "body",
      0,
      0,
      0,
    );
    const utcToday = new Date().toISOString().slice(0, 10);
    await saveHostGateState({
      host: HOST,
      gateId: null,
      stateKind: "none",
      untilAt: null,
      k4Strikes: 0,
      last429At: null,
      countDay: utcToday,
      countValue: DAILY_REQUEST_CAP_PER_HOST,
    });
    const fetchMock = vi.fn(async () => {
      throw new Error("B1 must block network I/O entirely (soft stop before robots fetch)");
    });
    vi.stubGlobal("fetch", fetchMock);

    const stats = await revalidatePublishedPosts();

    // budget_exhausted は個別 post の客観的なトリガではないため撤回しない。
    expect(stats.retractedSourceGone).toBe(0);
    expect(stats.retractedRobotsDisallowed).toBe(0);
    expect(stats.retractedBodyChanged).toBe(0);
    expect(stats.retractedTosChanged).toBe(0);
    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.status).toBe("published");
  });

  it("computeContainerBodyHash() は同一 HTML に対して安定したハッシュを返す（processUrl() の保存値との単体整合性）", async () => {
    // 注意: このテストは computeContainerBodyHash() を直接呼び出しているだけで、
    // revalidatePublishedPosts() の内部呼び出し経路を経由しない。そのため
    // revalidatePublishedPosts() 内部の算出基盤がページ全体基準に差し替わっても
    // このテストは検知できない（意図的破壊検証で確認済み）。M4 誤発火の再発防止は
    // 下記の「E2E回帰」テストが担う。
    const url = `https://${HOST}/story/cases/hash-basis-parity`;
    await seedPending(HOST, url);
    const html = articleHtml("ハッシュ基盤の一致を確認する記事");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url) return resp({ status: 200, body: html });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    mockedCurate.mockResolvedValue(sufficientCuration());

    const ingestStats = await ingestDiscoveredUrls(HOST);
    expect(ingestStats.published).toBe(1);

    const postId = (await getPostsByUrls([url])).get(url)?.id;
    if (postId == null) throw new Error("post id should exist");
    const pub = await db.select().from(postPublications).where(eq(postPublications.postId, postId));
    const storedHash = pub[0]?.bodyHash;
    expect(storedHash).toMatch(/^[0-9a-f]{16}$/);

    // revalidatePublishedPosts() 内部と同じ関数を、同じ生 HTML に対して直接
    // 呼び出す（呼び出し箇所は discovery-ingest.ts 側で共有済み）。
    const revalidateHash = computeContainerBodyHash(html, HOST);
    expect(revalidateHash).toBe(storedHash);
  });

  it("E2E回帰: 本文が変わっていない記事は revalidatePublishedPosts() 経由で再検証しても撤回されない（M4 誤発火の再発防止）", async () => {
    // processUrl() 経由で公開 → post_publications.body_hash を保存 →
    // 同一 HTML のまま revalidatePublishedPosts() を実際に実行する、という
    // パイプライン経由の経路をそのまま通す。関数を直接呼んで値を比較するのではなく、
    // 「同一コンテンツを再検査しても撤回されない」というエンドツーエンドの
    // 不変条件として検証する。revalidatePublishedPosts() 内部のハッシュ算出を
    // ページ全体基準（旧実装）に戻すと、コンテナ抽出のみが除外するナビ・口コミ等の
    // 差分によりハッシュが不一致になり、このテストは必ず落ちる。
    const url = `https://${HOST}/story/cases/no-drift-e2e`;
    await seedPending(HOST, url);
    const html = articleHtml("同一本文の再検証で撤回されないことを確認する記事");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url) return resp({ status: 200, body: html });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    mockedCurate.mockResolvedValue(sufficientCuration());

    const ingestStats = await ingestDiscoveredUrls(HOST);
    expect(ingestStats.published).toBe(1);

    const postId = (await getPostsByUrls([url])).get(url)?.id;
    if (postId == null) throw new Error("post id should exist");
    const before = await db
      .select()
      .from(postPublications)
      .where(eq(postPublications.postId, postId));
    expect(before).toHaveLength(1);

    // 本文（HTML）は変えず、そのままパイプラインの再検証を実行する。
    const stats = await revalidatePublishedPosts();

    expect(stats.retractedBodyChanged).toBe(0);
    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.status).toBe("published");
  });

  it("コンテナ未検出（セレクタ未マッチ）の HTML を再検証しても誤ってドリフト撤回しない", async () => {
    const url = `https://${HOST}/story/cases/container-missing-on-revalidate`;
    const postId = await seedPublished(url);
    const originalHash = computeBodyHash(
      "結婚式の準備について詳しく書いた元々の記事本文です。".repeat(10),
    );
    await recordPublication(postId, new Date().toISOString(), originalHash, "body", 0, 0, 0);

    // div.story-detail / div.produce-story-detail のどちらにも一致しない HTML
    // （テンプレート変更等でセレクタが外れたケースを模す）。
    const noContainerHtml =
      "<html><head><title>コンテナが見つからないページ</title></head>" +
      '<body><div class="unrelated-wrapper"><p>何らかの本文らしきもの</p></div></body></html>';

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url) return resp({ status: 200, body: noContainerHtml });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );

    const stats = await revalidatePublishedPosts();

    expect(stats.containerNotFoundSkipped).toBe(1);
    expect(stats.retractedBodyChanged).toBe(0);

    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.status).toBe("published");

    // 既存のハッシュは維持される（比較不能のまま上書きしない）。
    const pub = await db.select().from(postPublications).where(eq(postPublications.postId, postId));
    expect(pub[0]?.bodyHash).toBe(originalHash);
  });

  it("保護機能の確認: 本文が実際に変わった場合は従来どおり body_changed で撤回する", async () => {
    const url = `https://${HOST}/story/cases/real-drift-still-detected`;
    const postId = await seedPublished(url);
    const originalHash = computeBodyHash(
      "結婚式の準備について詳しく書いた元々の記事本文です。".repeat(10),
    );
    await recordPublication(postId, new Date().toISOString(), originalHash, "body", 0, 0, 0);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url)
          return resp({
            status: 200,
            body: articleHtml("全く無関係な内容に差し替わっている実際の記事本文です", {
              includeAnchor: false,
              bodyChars: 4000,
            }),
          });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );

    const stats = await revalidatePublishedPosts();

    expect(stats.retractedBodyChanged).toBe(1);
    expect(stats.containerNotFoundSkipped).toBe(0);
    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.status).toBe("retracted");
  });

  it("観測性: 成功した抽出/ゲート通過時、post_publications に text_length, link_density, paragraph_count が正しく記録される", async () => {
    const url = `https://${HOST}/story/cases/signals-recorded-on-success`;
    await seedPending(HOST, url);
    const html = articleHtml("ウェディングの費用対効果に関する具体的な体験談です。".repeat(15));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url) return resp({ status: 200, body: html });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    mockedCurate.mockResolvedValue(sufficientCuration());

    const ingestStats = await ingestDiscoveredUrls(HOST);
    expect(ingestStats.published).toBe(1);

    const postId = (await getPostsByUrls([url])).get(url)?.id;
    if (postId == null) throw new Error("post id should exist");

    const pub = await db.select().from(postPublications).where(eq(postPublications.postId, postId));
    expect(pub).toHaveLength(1);

    const record = pub[0];
    expect(record).toBeDefined();
    expect(typeof record?.textLength).toBe("number");
    expect(record?.textLength).toBeGreaterThan(0);

    expect(typeof record?.paragraphCount).toBe("number");
    expect(record?.paragraphCount).toBeGreaterThanOrEqual(1);

    expect(typeof record?.linkDensity).toBe("number");
    expect(record?.linkDensity).toBeGreaterThanOrEqual(0);
    expect(record?.linkDensity).toBeLessThanOrEqual(1);
  });
});
