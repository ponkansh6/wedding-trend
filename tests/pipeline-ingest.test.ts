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

// Q4 テストは「上限到達」をカウント関数のモックで再現する（実 DB への
// DAILY_PUBLISH_CAP 件シードは定数値次第で終わらないため）。
vi.mock("@/lib/db/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/repository")>();
  return {
    ...actual,
    countPublishedSince: vi.fn(),
    countPublishedSinceByHost: vi.fn(),
  };
});

const mockedCountPublishedSince = vi.mocked(countPublishedSince);
const mockedCountPublishedSinceByHost = vi.mocked(countPublishedSinceByHost);

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
        promotional: "none",
        preDecisionOrPhotoShoot: false,
        // M1-2 の語彙的接地（plan 07 D4）を通すため、topicAnchor は LLM への
        // 実入力（input.title）に逐語で含まれる語にする（固定値だと入力ごとに
        // 一致せず誤って anchor_ungrounded になる）。
        topicAnchor: input.title,
        rationaleText:
          "実際の体験に基づく会場選びや進行プロセスにおける具体的な工夫と背景についての客観的な振り返りを行う非常に有用な記事内容である",
        evidenceSufficient: true,
      })),
      geminiCalls: 1,
    }),
  ),
}));

import { curatePosts } from "@/lib/llm/batch";
import { computeCurationSignature } from "@/lib/llm/signature";
import {
  enqueueRetry,
  getPostsByUrls,
  getStaleCurationCandidates,
  markCurated,
  markDropped,
  upsertPosts,
  countPublishedSince,
  countPublishedSinceByHost,
} from "@/lib/db/repository";
import { DAILY_PUBLISH_CAP, RETRY_MAX_ATTEMPTS } from "@/lib/constants";
import { db } from "@/lib/db";
import { getFeedCards } from "@/lib/db/query";
import { postRemovals, postRetryQueue, postUsefulnessCriteria, posts } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { runIngest } from "@/lib/pipeline/ingest";

describe("runIngest (src/lib/pipeline/ingest.ts)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    await setupTestDb();

    mockedCountPublishedSince.mockResolvedValue(0);
    mockedCountPublishedSinceByHost.mockResolvedValue({});

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

    const rows = await db.select().from(postUsefulnessCriteria);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const criteria = JSON.parse(row.criteriaJson);
      expect(criteria.firsthand).toBe(true);
      expect(criteria.ceremonyDecision).toBe(true);
      expect(criteria.preDecisionOrPhotoShoot).toBe(false);
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
    const rows = await db
      .select()
      .from(postUsefulnessCriteria)
      .where(eq(postUsefulnessCriteria.postId, postId));
    expect(rows).toHaveLength(1);
    expect(rows[0].signature).toBe(computeCurationSignature());
    expect(JSON.parse(rows[0].criteriaJson).ceremonyDecision).toBe(true);
  });

  // Q1相当（簡易版）: 抜粋が無い投稿は LLM を呼ばず即終端棄却する。
  it("Q1: a post without an excerpt is terminally dropped as extraction_insufficient without calling the LLM", async () => {
    hatenaToPost.mockReturnValue({
      url: "https://example.com/blog1",
      sourceType: "blog",
      sourceId: "hatena-bookmark",
      sourceName: "はてなブックマーク",
      originalTitle: "Blog Post 1",
      originalExcerpt: null,
      author: "Author",
      thumbnailUrl: null,
      publishedAt: "2024-01-01T00:00:00.000Z",
    });

    await runIngest();

    // LLM には google-news の 1 件しか渡らない（blog1 は Q1 で事前に弾かれる）。
    const calledWith = (curatePosts as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as Array<{ title: string }>;
    expect(calledWith).toHaveLength(1);
    expect(calledWith.some((i) => i.title === "Blog Post 1")).toBe(false);

    const row = (
      await db.select().from(posts).where(eq(posts.url, "https://example.com/blog1"))
    )[0];
    expect(row.status).toBe("rejected");
    const removal = (
      await db.select().from(postRemovals).where(eq(postRemovals.postId, row.id))
    )[0];
    expect(removal.reason).toBe("extraction_insufficient");
  });

  // M1-1: 逐語タイトルの無検閲公開フィルタ。恒久棄却（LLM は呼ばれる）。
  it("M1: a title carrying an ad marker is terminally dropped as title_filter and never published", async () => {
    hatenaToPost.mockReturnValue({
      url: "https://example.com/blog1",
      sourceType: "blog",
      sourceId: "hatena-bookmark",
      sourceName: "はてなブックマーク",
      originalTitle: "【PR】Blog Post 1",
      originalExcerpt: "Excerpt",
      author: "Author",
      thumbnailUrl: null,
      publishedAt: "2024-01-01T00:00:00.000Z",
    });

    const summary = await runIngest();

    // フィルタは LLM 呼び出しの後段（M1）で働くため、LLM 自体は両方に対して呼ばれる。
    expect(curatePosts).toHaveBeenCalledTimes(1);
    // 公開されるのは google-news の 1 件のみ。
    expect(summary.curated).toBe(1);

    const row = (
      await db.select().from(posts).where(eq(posts.url, "https://example.com/blog1"))
    )[0];
    expect(row.status).toBe("rejected");
    const removal = (
      await db.select().from(postRemovals).where(eq(postRemovals.postId, row.id))
    )[0];
    expect(removal.reason).toBe("title_filter");
  });

  // M1-3: 撤回済み（sticky）投稿は再キュレーションの対象から除外される。
  it("M1: a post already recorded as removed is excluded from candidate selection and never re-curated", async () => {
    const upserted = await upsertPosts([
      {
        url: "https://example.com/blog1",
        sourceType: "blog",
        sourceId: "hatena-bookmark",
        sourceName: "はてなブックマーク",
        originalTitle: "Blog Post 1",
        originalExcerpt: "Excerpt",
        author: "Author",
        thumbnailUrl: null,
        publishedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);
    expect(upserted.failed).toEqual([]);
    const states = await getPostsByUrls(["https://example.com/blog1"]);
    const postId = states.get("https://example.com/blog1")!.id;
    await markDropped(postId, "not_useful", "2024-01-01T00:00:00.000Z");

    await runIngest();

    const calledWith = (curatePosts as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as Array<{ title: string }>;
    expect(calledWith.some((i) => i.title === "Blog Post 1")).toBe(false);

    const row = (
      await db.select().from(posts).where(eq(posts.url, "https://example.com/blog1"))
    )[0];
    // sticky: 撤回/棄却済みのステータスは書き換わらない。
    expect(row.status).toBe("rejected");
  });

  // §7: LLM 呼び出し失敗は一時的技術障害として再試行キューへ（終端棄却しない）。
  it("queues a retry (does not terminally drop) when the LLM returns null for one item", async () => {
    (
      curatePosts as unknown as { mockImplementationOnce: (fn: unknown) => void }
    ).mockImplementationOnce((inputs: Array<{ title: string; excerpt: string | null }>) =>
      Promise.resolve({
        results: inputs.map((input) =>
          input.title === "Blog Post 1"
            ? null
            : {
                title: `AI: ${input.title}`,
                summary: `AI summary for ${input.title}`,
                category: "その他",
                tag: "trend",
                firsthand: true,
                ceremonyDecision: true,
                specific: true,
                tradeoff: false,
                promotional: "none",
                preDecisionOrPhotoShoot: false,
                topicAnchor: input.title,
                rationaleText:
                  "実際の体験に基づく会場選びや進行プロセスにおける具体的な工夫と背景についての客観的な振り返りを行う非常に有用な記事内容である",
              },
        ),
        geminiCalls: 1,
      }),
    );

    const summary = await runIngest();

    expect(summary.curated).toBe(1);

    const row = (
      await db.select().from(posts).where(eq(posts.url, "https://example.com/blog1"))
    )[0];
    // まだ終端棄却されていない（status は default の "published" のまま。
    // aiTitle が null なのでフィードには表示されない）。
    expect(row.status).toBe("published");
    expect(row.aiTitle).toBeNull();

    const retryRows = await db
      .select()
      .from(postRetryQueue)
      .where(eq(postRetryQueue.url, "https://example.com/blog1"));
    expect(retryRows).toHaveLength(1);
    expect(retryRows[0].reason).toBe("llm_transient");
    expect(retryRows[0].lane).toBe("rss");
  });

  // D4: M1-2 の語彙的接地は RSS レーンでも、LLM に実際に渡した入力
  // （タイトル+抜粋）に対して適用される。
  it("D4: drops a post as anchor_ungrounded when the LLM's topicAnchor contains a term absent from the RSS input (title+excerpt)", async () => {
    (
      curatePosts as unknown as { mockImplementationOnce: (fn: unknown) => void }
    ).mockImplementationOnce((inputs: Array<{ title: string; excerpt: string | null }>) =>
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
          promotional: "none",
          preDecisionOrPhotoShoot: false,
          // Blog Post 1 の入力（title="Blog Post 1", excerpt="Excerpt"）には
          // 一切現れない語（プロンプトインジェクション/幻覚を模擬）。
          topicAnchor: input.title === "Blog Post 1" ? "架空の温泉旅行特集" : input.title,
          rationaleText:
            "実際の体験に基づく会場選びや進行プロセスにおける具体的な工夫と背景についての客観的な振り返りを行う非常に有用な記事内容である",
        })),
        geminiCalls: 1,
      }),
    );

    const summary = await runIngest();

    // News 1 の方は接地するため公開される。Blog Post 1 だけ棄却される。
    expect(summary.curated).toBe(1);

    const blogRow = (
      await db.select().from(posts).where(eq(posts.url, "https://example.com/blog1"))
    )[0];
    expect(blogRow.status).toBe("rejected");

    const removal = (
      await db.select().from(postRemovals).where(eq(postRemovals.postId, blogRow.id))
    )[0];
    expect(removal?.reason).toBe("anchor_ungrounded");

    const newsRow = (
      await db.select().from(posts).where(eq(posts.url, "https://example.com/news1"))
    )[0];
    expect(newsRow.status).toBe("published");
  });

  // D4: 誤棄却が増えすぎないことの固定。LLM が実際に入力から抽出した語を
  // topicAnchor として返す通常のケースでは、RSS レーン（本文非取得）でも
  // 誤って anchor_ungrounded にならない（happy path と同じ既定モックのまま）。
  it("D4: does not falsely reject a well-grounded topicAnchor derived from the RSS input", async () => {
    const summary = await runIngest();

    expect(summary.curated).toBe(2);
    const removals = await db.select().from(postRemovals);
    expect(removals.find((r) => r.reason === "anchor_ungrounded")).toBeUndefined();
  });

  // Q4: 日次公開上限に達したら公開せず、再試行キューへ繰り延べる（終端棄却しない）。
  it("Q4: when the daily publish cap is already reached, does not publish and enqueues a rate_capped retry instead", async () => {
    // 実 DB への DAILY_PUBLISH_CAP 件シードでも再現できるが、他の値変更に
    // 追随しやすいよう、カウント関数のモックで上限到達を再現する
    // （evergreen / submit-url と同じパターン）。
    mockedCountPublishedSince.mockResolvedValue(DAILY_PUBLISH_CAP);

    const summary = await runIngest();

    // 上限到達により新規の 2 件はどちらも公開されない。
    expect(summary.curated).toBe(0);

    const blog1 = (
      await db.select().from(posts).where(eq(posts.url, "https://example.com/blog1"))
    )[0];
    expect(blog1.aiTitle).toBeNull();

    const retryRows = await db.select().from(postRetryQueue);
    const rateCappedUrls = retryRows.filter((r) => r.reason === "rate_capped").map((r) => r.url);
    expect(rateCappedUrls).toContain("https://example.com/blog1");
    expect(rateCappedUrls).toContain("https://example.com/news1");
  });

  // 以下 3 件は上のテストと異なり、DAILY_PUBLISH_CAP / HOST_DAILY_SHARE_MAX
  // から動的に期待値を導出せず、具体的な数値をリテラルで固定する。定数の値
  // が変わった場合にテストが自動追随せず落ちることが目的（AGENTS.md「ゲート
  // が緑であることと機能していることは別」）。

  it("Q4: 日次公開上限は 10 件に固定されている（plan 07 §9 Stage 2: 監督付き自動運転の被害半径限定）", () => {
    // 値を変えたい場合は shared_plan/07-unattended-operation.md と
    // openspec/specs/wedding-trend/spec.md を更新したうえで、このテストの
    // リテラル値も合わせて更新すること。
    expect(DAILY_PUBLISH_CAP).toBe(10);
  });

  it("Q4: 境界値 — 当日 9 件公開済みから開始すると、同一ラン内でカウンタが加算され 2 件中ちょうど 1 件が公開・ちょうど 1 件が rate_capped になる（off-by-one固定、処理順には依存しない）", async () => {
    // 9 件済み（リテラル 9）で開始。同一ラン内でローカルカウンタが加算される
    // ため、2 件のうち 10 件目に当たる方は公開、11 件目に当たる方は
    // rate_capped になる。runIngest の処理順（フィクスチャの並び順やレーンの
    // 取り出し順）はテストが依存してよい保証ではないため、どちらの URL が
    // 先に処理されるかは固定せず、「ちょうど1件公開・ちょうど1件
    // rate_capped・かつ両者が異なる URL」であることのみを固定する。
    //
    // 「公開されたか」を posts.status では判定しない: status は既定値
    // "published" のフェイルセーフ用カラムであり（src/lib/db/schema.ts
    // 53-59 行）、rate_capped で止められた記事も upsert 時点の値のまま
    // status="published" で残る。実際にキュレーションが完了し公開面に出た
    // ことの信号として、getFeedCards() が実際に返すカードで判定する
    // （本番のフィード表示条件そのものに追随する、最も本番に近い検証）。
    mockedCountPublishedSince.mockResolvedValue(9);

    const summary = await runIngest();

    expect(summary.curated).toBe(1);

    const retryRows = await db.select().from(postRetryQueue);
    const rateCappedUrls = retryRows.filter((r) => r.reason === "rate_capped").map((r) => r.url);
    expect(rateCappedUrls).toHaveLength(1);

    const feedCards = await getFeedCards({ sourceType: "blog", limit: 10 });
    const publishedUrls = feedCards
      .map((c) => c.url)
      .filter((u) => u === "https://example.com/blog1" || u === "https://example.com/news1");
    expect(publishedUrls).toHaveLength(1);

    // 公開された URL と rate_capped になった URL は互いに異なる（同じ URL が
    // 両方に現れていない）。
    expect(rateCappedUrls[0]).not.toBe(publishedUrls[0]);
    expect(new Set([...rateCappedUrls, ...publishedUrls])).toEqual(
      new Set(["https://example.com/blog1", "https://example.com/news1"]),
    );
  });

  it("Q4: rate_capped で止められた記事はフィードに現れない（posts.status 経由ではなく getFeedCards() 経由で直接確認）", async () => {
    // 目的: 日次上限で止められた記事が実際に公開面（getFeedCards の戻り値）
    // に出ないことを、posts.status を経由せず公開 API の観測可能な出力で
    // 直接固定する。
    //
    // 実測（このテストの前段で確認済み）: 上限到達時、blog1 / news1 は
    // どちらも posts テーブルに status="published"（既定値のまま。
    // src/lib/db/schema.ts のフェイルセーフ用カラム）・sourceType="blog"・
    // aiTitle=null・aiSummary=null で行として残る。両者の sourceType は
    // 同一（"blog"）なので getFeedCards({ sourceType: "blog" }) のフィルタが
    // 意味を持つ状況になっている。
    //
    // 既知の構造: `src/lib/db/query.ts` の getFeedCards() は同じ可視性判定
    // （rationaleText 存在 OR aiTitle+aiSummary 両方 non-null）を SQL の
    // WHERE 句（visibilityCondition）とマッピング後の JS 側フィルタ
    // （`if (!row.rationaleText && (!row.aiTitle || !row.aiSummary)) return [];`）
    // の二重で行っている（後者は同ファイルのコメントにある「型安全のため
    // 念のため防御的にフィルタする」冗長ガード）。そのため SQL 側の条件だけ
    // を外しても JS 側の防御的フィルタが残っていれば本テストは失敗しない
    // ——これはテストの穴ではなく、実装が意図的に持つ多層防御であり、この
    // テストはその両方を貫通する形の実際の公開面挙動（＝ユーザーに実害が
    // 出るかどうか）を固定している。
    mockedCountPublishedSince.mockResolvedValue(DAILY_PUBLISH_CAP);

    const summary = await runIngest();

    expect(summary.curated).toBe(0);
    const retryRows = await db.select().from(postRetryQueue);
    const rateCappedUrls = retryRows.filter((r) => r.reason === "rate_capped").map((r) => r.url);
    expect(rateCappedUrls).toContain("https://example.com/blog1");
    expect(rateCappedUrls).toContain("https://example.com/news1");

    // 実測の裏付け: rate_capped でも posts 行は削除されず残っている
    // （終端棄却ではなく再試行キューへの繰り延べのため）。
    const persistedRows = await db
      .select()
      .from(posts)
      .where(inArray(posts.url, ["https://example.com/blog1", "https://example.com/news1"]));
    expect(persistedRows).toHaveLength(2);
    for (const row of persistedRows) {
      expect(row.status).toBe("published");
      expect(row.sourceType).toBe("blog");
      expect(row.aiTitle).toBeNull();
      expect(row.aiSummary).toBeNull();
    }

    const feedCards = await getFeedCards({ sourceType: "blog", limit: 10 });
    const feedUrls = feedCards.map((c) => c.url);
    expect(feedUrls).not.toContain("https://example.com/blog1");
    expect(feedUrls).not.toContain("https://example.com/news1");
  });

  it("Q4: ホストシェア上限は 5 件に固定されている（DAILY_PUBLISH_CAP=10 × HOST_DAILY_SHARE_MAX=0.5）。単一ホストが既に 5 件公開済みなら 6 件目は抑止される", async () => {
    // blog1 / news1 は共に example.com ホスト。hostCounts をリテラル 5 に
    // 固定し、hostShareCapCount() の実装（floor(10*0.5)=5）を式からではなく
    // 具体的な数値で検証する。
    mockedCountPublishedSince.mockResolvedValue(0);
    mockedCountPublishedSinceByHost.mockResolvedValue({ "example.com": 5 });

    const summary = await runIngest();

    expect(summary.curated).toBe(0);
    const retryRows = await db.select().from(postRetryQueue);
    const rateCappedUrls = retryRows.filter((r) => r.reason === "rate_capped").map((r) => r.url);
    expect(rateCappedUrls).toContain("https://example.com/blog1");
    expect(rateCappedUrls).toContain("https://example.com/news1");
  });

  // D5: runIngest() の入口に配線した rss/evergreen/submit レーン分の
  // 再試行キュー消費者。
  describe("D5: retry queue consumer (rss lane)", () => {
    const retryUrl = "https://example.com/retry-post";

    /** rss レーンの post 行を、初回失敗時点と同様にキュレーション前の状態で作る。 */
    async function seedUnresolvedRssPost(): Promise<number> {
      const upserted = await upsertPosts([
        {
          url: retryUrl,
          sourceType: "blog",
          sourceId: "hatena-bookmark",
          sourceName: "はてなブックマーク",
          originalTitle: "Retry Post",
          originalExcerpt: "Retry excerpt",
          author: "Author",
          thumbnailUrl: null,
          publishedAt: "2024-01-01T00:00:00.000Z",
        },
      ]);
      expect(upserted.failed).toEqual([]);
      const states = await getPostsByUrls([retryUrl]);
      return states.get(retryUrl)!.id!;
    }

    it("reprocesses a due entry and publishes it once curation succeeds, clearing the queue row", async () => {
      const postId = await seedUnresolvedRssPost();
      const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await enqueueRetry({
        urlHash: "retry-hash-due-success",
        url: retryUrl,
        host: "example.com",
        lane: "rss",
        reason: "llm_transient",
        attempts: 1,
        firstQueuedAt: past,
        nextAttemptAt: past, // due
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 未失効
      });

      await runIngest();

      const remaining = await db
        .select()
        .from(postRetryQueue)
        .where(eq(postRetryQueue.url, retryUrl));
      expect(remaining).toHaveLength(0);

      const row = (await db.select().from(posts).where(eq(posts.id, postId)))[0];
      expect(row.status).toBe("published");
      expect(row.aiSummary).not.toBeNull();
    });

    it("terminally drops a due entry as retry_exhausted once RETRY_MAX_ATTEMPTS is exceeded", async () => {
      const postId = await seedUnresolvedRssPost();
      const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await enqueueRetry({
        urlHash: "retry-hash-due-giveup",
        url: retryUrl,
        host: "example.com",
        lane: "rss",
        reason: "llm_transient",
        attempts: RETRY_MAX_ATTEMPTS, // 次のインクリメントで上限超過
        firstQueuedAt: past,
        nextAttemptAt: past,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      // このアイテムだけ LLM が失敗し続ける状況を模す。
      (
        curatePosts as unknown as { mockImplementationOnce: (fn: unknown) => void }
      ).mockImplementationOnce((inputs: Array<{ title: string; excerpt: string | null }>) =>
        Promise.resolve({
          results: inputs.map(() => null),
          geminiCalls: 1,
        }),
      );

      await runIngest();

      const remaining = await db
        .select()
        .from(postRetryQueue)
        .where(eq(postRetryQueue.url, retryUrl));
      expect(remaining).toHaveLength(0);

      const row = (await db.select().from(posts).where(eq(posts.id, postId)))[0];
      expect(row.status).toBe("rejected");
      const removal = (
        await db.select().from(postRemovals).where(eq(postRemovals.postId, postId))
      )[0];
      expect(removal?.reason).toBe("retry_exhausted");
    });

    it("terminally drops a TTL-expired entry as retry_exhausted without waiting for it to become due", async () => {
      const postId = await seedUnresolvedRssPost();
      const past = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
      await enqueueRetry({
        urlHash: "retry-hash-expired",
        url: retryUrl,
        host: "example.com",
        lane: "rss",
        reason: "llm_transient",
        attempts: 1,
        firstQueuedAt: past,
        nextAttemptAt: past,
        expiresAt: past, // 既に失効済み
      });

      await runIngest();

      const remaining = await db
        .select()
        .from(postRetryQueue)
        .where(eq(postRetryQueue.url, retryUrl));
      expect(remaining).toHaveLength(0);

      const row = (await db.select().from(posts).where(eq(posts.id, postId)))[0];
      expect(row.status).toBe("rejected");
      const removal = (
        await db.select().from(postRemovals).where(eq(postRemovals.postId, postId))
      )[0];
      expect(removal?.reason).toBe("retry_exhausted");
    });

    it("does not touch a discovery-lane queue entry (lane scoping)", async () => {
      const discoveryUrl = "https://www.mwed.jp/story/discovery-owned";
      const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await enqueueRetry({
        urlHash: "retry-hash-discovery-owned",
        url: discoveryUrl,
        host: "www.mwed.jp",
        lane: "discovery",
        reason: "fetch_transient",
        attempts: 1,
        firstQueuedAt: past,
        nextAttemptAt: past,
        expiresAt: past, // 失効済みでも rss 側の consumer は触らないはず
      });

      await runIngest();

      const remaining = await db
        .select()
        .from(postRetryQueue)
        .where(eq(postRetryQueue.url, discoveryUrl));
      expect(remaining).toHaveLength(1);
    });
  });
});
