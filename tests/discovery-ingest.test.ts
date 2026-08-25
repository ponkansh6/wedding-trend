import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb } from "./helpers/test-db";
import { db } from "@/lib/db";
import { postPublications, postRemovals, postRetryQueue } from "@/lib/db/schema";
import {
  countDiscoverySeenByStatus,
  countPublishedSince,
  countPublishedSinceByHost,
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
  ingestDiscoveredUrls,
  revalidatePublishedPosts,
} from "@/lib/pipeline/discovery-ingest";
import { curateSingle } from "@/lib/llm/batch";
import type { CurationResult } from "@/lib/llm/batch";
import { __resetStateForTests, __setSleepForTests } from "@/lib/sources/access-discipline";
import { DAILY_PUBLISH_CAP, HOST_DAILY_SHARE_MAX } from "@/lib/constants";

vi.mock("@/lib/llm/batch", () => ({
  curateSingle: vi.fn(),
}));

vi.mock("@/lib/db/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/repository")>();
  return {
    ...actual,
    countPublishedSince: vi.fn(),
    countPublishedSinceByHost: vi.fn(),
  };
});

const mockedCurate = vi.mocked(curateSingle);
const mockedCountPublishedSince = vi.mocked(countPublishedSince);
const mockedCountPublishedSinceByHost = vi.mocked(countPublishedSinceByHost);

const HOST = "www.mwed.jp";
const DISALLOWED_HOST = "not-on-the-allowlist.example.com";

/** スキーマ（SingleCurationSchema = CurationItemSchema.omit({index})）に適合する十分な判定。 */
function sufficientCuration(overrides: Partial<CurationResult> = {}): CurationResult {
  return {
    title: "演出の予算配分で失敗しなかった話",
    summary: "式後の費用内訳と演出選択のトレードオフを当事者が具体的に語る体験談のサマリーです。",
    category: "費用・節約",
    tag: "classic",
    firsthand: true,
    ceremonyDecision: true,
    specific: true,
    tradeoff: true,
    promotional: false,
    preDecisionOrPhotoShoot: false,
    topicAnchor: "演出の予算配分",
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
function articleHtml(
  title: string | null,
  opts: { bodyChars?: number; includeAnchor?: boolean } = {},
): string {
  const head = title ? `<head><title>${title}</title></head>` : "<head></head>";
  const bodyChars = opts.bodyChars ?? 2000;
  const anchorSentence =
    opts.includeAnchor === false ? "" : "演出の予算配分について詳しく書きます。";
  const filler = "あ".repeat(Math.max(0, bodyChars - anchorSentence.length));
  return `<html>${head}<body>${anchorSentence}<p>${filler}</p><p>準備の記録です。</p><p>当日の様子です。</p></body></html>`;
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
    mockedCountPublishedSinceByHost.mockResolvedValue({});
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

  it("Q1: 本文が薄い場合は LLM を呼ばず extraction_insufficient で終端棄却する", async () => {
    const url = `https://${HOST}/story/cases/thin`;
    await seedPending(HOST, url);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url) return resp({ status: 200, body: articleHtml("短い話", { bodyChars: 30 }) });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );

    const stats = await ingestDiscoveredUrls(HOST);

    expect(stats.extractionInsufficientDropped).toBe(1);
    expect(stats.published).toBe(0);
    // Q1: 決定的ゲート不合格時は LLM を一切呼ばない（自己申告の廃止）。
    expect(mockedCurate).not.toHaveBeenCalled();

    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.status).toBe("rejected");
    expect(post?.originalExcerpt).toBeNull();
    if (post?.id == null) throw new Error("post id should exist");
    const removal = await db.select().from(postRemovals).where(eq(postRemovals.postId, post.id));
    expect(removal[0]?.kind).toBe("dropped");
    expect(removal[0]?.reason).toBe("extraction_insufficient");

    const counts = await countDiscoverySeenByStatus(HOST);
    expect(counts.fetched).toBe(1);
  });

  it("M1: タイトルフィルタ不合格は title_filter で終端棄却する", async () => {
    const url = `https://${HOST}/story/cases/ad-title`;
    await seedPending(HOST, url);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url) return resp({ status: 200, body: articleHtml("【PR】演出の予算配分の話") });
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

  it("M1: topicAnchor が本文に接地しない場合は anchor_ungrounded で終端棄却する", async () => {
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
    // topicAnchor に本文中に存在しない特徴語を返させる（プロンプトインジェクション対策の想定シナリオ）。
    mockedCurate.mockResolvedValue(sufficientCuration({ topicAnchor: "架空の海外挙式レポート" }));

    const stats = await ingestDiscoveredUrls(HOST);

    expect(stats.anchorUngroundedDropped).toBe(1);
    expect(stats.published).toBe(0);

    const post = (await getPostsByUrls([url])).get(url);
    expect(post?.status).toBe("rejected");
    if (post?.id == null) throw new Error("post id should exist");
    const removal = await db.select().from(postRemovals).where(eq(postRemovals.postId, post.id));
    expect(removal[0]?.reason).toBe("anchor_ungrounded");
    // rationale は保存されない（評価未成立のため公開経路に乗らない）。
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

  it("Q4: ホストシェア上限に達したら公開せず rate_capped として再試行キューに入る", async () => {
    // 日次上限ではなくホストシェアのみ到達させるため、total は上限未満を返す。
    // byHost[HOST] = hostCap でホストシェア上限到達を再現する。
    const hostCap = Math.floor(DAILY_PUBLISH_CAP * HOST_DAILY_SHARE_MAX);
    mockedCountPublishedSince.mockResolvedValue(hostCap - 1);
    mockedCountPublishedSinceByHost.mockResolvedValue({ [HOST]: hostCap });

    const url = `https://${HOST}/story/cases/over-host-share`;
    await seedPending(HOST, url);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url) return resp({ status: 200, body: articleHtml("ホストシェア超過の話") });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    mockedCurate.mockResolvedValue(sufficientCuration());

    const stats = await ingestDiscoveredUrls(HOST);

    expect(stats.rateCapped).toBe(1);
    expect(stats.published).toBe(0);
  });

  // 以下 3 件は上の2件と異なり、DAILY_PUBLISH_CAP / HOST_DAILY_SHARE_MAX から
  // 動的に期待値を導出せず、具体的な数値をリテラルで固定する。定数の値が
  // 変わった場合にテストが自動追随せず落ちることが目的（AGENTS.md「ゲートが
  // 緑であることと機能していることは別」）。

  it("Q4: 日次公開上限は 10 件に固定されている（plan 07 §9 Stage 2: 監督付き自動運転の被害半径限定）", () => {
    // 値を変えたい場合は shared_plan/07-unattended-operation.md と
    // openspec/specs/wedding-trend/spec.md を更新したうえで、このテストの
    // リテラル値も合わせて更新すること。
    expect(DAILY_PUBLISH_CAP).toBe(10);
  });

  it("Q4: 境界値 — 当日 9 件公開済みなら 10 件目は公開され、10 件公開済みなら 11 件目は rate_capped になる（off-by-one固定）", async () => {
    // 9 件済み（リテラル 9）→ 10 件目は上限未到達として公開される。
    mockedCountPublishedSince.mockResolvedValue(9);
    mockedCountPublishedSinceByHost.mockResolvedValue({});

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

    // 10 件済み（リテラル 10）→ 11 件目は上限到達として rate_capped。
    mockedCountPublishedSince.mockResolvedValue(10);
    mockedCountPublishedSinceByHost.mockResolvedValue({});

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

  it("Q4: ホストシェア上限は 5 件に固定されている（DAILY_PUBLISH_CAP=10 × HOST_DAILY_SHARE_MAX=0.5）。単一ホスト 6 件目は抑止される", async () => {
    // HOST_DAILY_SHARE_MAX が 0.5 であることも合わせて固定する。
    expect(HOST_DAILY_SHARE_MAX).toBe(0.5);
    // hostShareCapCount() の実装（floor(10*0.5)=5）を式からではなくリテラル
    // 5/6 で直接検証する。
    mockedCountPublishedSince.mockResolvedValue(5);
    mockedCountPublishedSinceByHost.mockResolvedValue({ [HOST]: 5 });

    const url = `https://${HOST}/story/cases/host-share-literal-6`;
    await seedPending(HOST, url);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url) return resp({ status: 200, body: articleHtml("6件目の話") });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    mockedCurate.mockResolvedValue(sufficientCuration());

    const stats = await ingestDiscoveredUrls(HOST);
    expect(stats.rateCapped).toBe(1);
    expect(stats.published).toBe(0);
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
    expect(removal[0]?.reason).toBe("retry_exhausted");
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

  it("時間予算 0 なら何も処理せず budgetExhausted を返す", async () => {
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
    await recordPublication(postId, new Date().toISOString(), originalHash, "body");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: ALLOW_ALL_ROBOTS });
        if (u === url)
          return resp({
            status: 200,
            body: `<html><head><title>差し替え後</title></head><body>${"全く無関係なプログラミング入門講座の内容に差し替わっています。".repeat(10)}</body></html>`,
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
});
