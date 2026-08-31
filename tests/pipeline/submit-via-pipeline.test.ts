/**
 * Purpose: `runSubmitUrlViaPipeline`（`@/lib/pipeline/submit-via-pipeline`）
 * の単体テスト。もとは `tests/pipeline-submit-url.test.ts`（旧骨格
 * `runSubmitUrl` 向け）にあったが、旧骨格の削除（Stage 6 S2 Commit 4）に
 * 伴い、本番で今も真である外形的挙動（`SubmitOutcome` 契約）のケースを
 * 新ラッパーへ向け直した。旧骨格の内部実装（中間状態・呼び出し順序）に
 * 依存したケースは含めていない。
 *
 * 旧テストが `@/lib/db/repository` を直接モックしていたのに対し、こちらは
 * `tests/pipeline/*-diff.test.ts`（削除済み）が採っていたパターンを踏襲し、
 * 実インメモリ DB（`setupTestDb`）を使う。ラッパーの本体（`runPipeline` コア）
 * は `tests/pipeline/run-pipeline.test.ts` が別途モックベースで網羅している
 * ため、ここでは「wrapper が正しい入出力契約を守っているか」に焦点を絞る。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb } from "../helpers/test-db";
import { db } from "@/lib/db";
import { posts, postPublications, postRemovals } from "@/lib/db/schema";
import { runSubmitUrlViaPipeline } from "@/lib/pipeline/submit-via-pipeline";
import { DAILY_PUBLISH_CAP } from "@/lib/constants";

const { fetchOEmbedMock } = vi.hoisted(() => ({
  fetchOEmbedMock: vi.fn(),
}));

vi.mock("@/lib/embed/oembed", () => ({
  fetchOEmbed: fetchOEmbedMock,
}));

vi.mock("@/lib/llm/batch", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    curatePosts: vi.fn((inputs: Array<{ title: string; excerpt: string | null }>) =>
      Promise.resolve({
        results: inputs.map((input) => {
          if (input.title.includes("FAIL_LLM")) return null;
          return {
            title: `AI: ${input.title}`,
            summary: `AI summary for ${input.title}`,
            category: "その他",
            tag: "trend",
            firsthand: true,
            ceremonyDecision: true,
            specific: true,
            weddingDayContent: false,
            promotional: "none",
            // M1-2（語彙的接地）を通すため、topicAnchor は実入力の title を使う。
            topicAnchor: input.title,
            rationaleText:
              "実際の体験に基づく会場選びや進行プロセスにおける具体的な工夫と背景についての客観的な振り返り",
          };
        }),
        geminiCalls: 1,
      }),
    ),
  };
});

function oembedFor(url: string): {
  provider: "instagram" | "youtube" | "none";
  title: string | null;
  authorName: string | null;
  thumbnailUrl: string | null;
  html: string | null;
} | null {
  if (url.includes("no-caption")) {
    return {
      provider: "instagram",
      title: null,
      authorName: null,
      thumbnailUrl: null,
      html: "<blockquote>ig</blockquote>",
    };
  }
  if (url.includes("title-filter")) {
    // SYMBOL_REPEAT_RE（gate.ts）は同一記号の4連続以上を要求する。
    return {
      provider: "none",
      title: "！！！！ 違法",
      authorName: "Author",
      thumbnailUrl: null,
      html: null,
    };
  }
  if (url.includes("youtube.com")) {
    return {
      provider: "youtube",
      title: `YouTube Title for ${url}`,
      authorName: "YT Author",
      thumbnailUrl: "https://img.youtube.com/thumb.jpg",
      html: "<iframe></iframe>",
    };
  }
  return {
    provider: "none",
    title: `Title for ${url}`,
    authorName: null,
    thumbnailUrl: null,
    html: null,
  };
}

describe("runSubmitUrlViaPipeline (src/lib/pipeline/submit-via-pipeline.ts)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    await setupTestDb();
    fetchOEmbedMock.mockImplementation((url: string) => Promise.resolve(oembedFor(url)));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns reason "invalid_url" and does not touch the DB or LLM for a syntactically invalid URL', async () => {
    const outcome = await runSubmitUrlViaPipeline("not-a-url");

    expect(outcome).toEqual({ ok: false, reason: "invalid_url", card: null });
    expect(fetchOEmbedMock).not.toHaveBeenCalled();
    const rows = await db.select().from(posts);
    expect(rows).toHaveLength(0);
  });

  it("happy path: builds a FeedCard from oEmbed + LLM curation and records publication", async () => {
    const url = "https://www.youtube.com/watch?v=submitwrap1";

    const outcome = await runSubmitUrlViaPipeline(url);

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBeNull();
    expect(outcome.card?.embedProvider).toBe("youtube");
    expect(outcome.card).not.toBeNull();

    const [publication] = await db
      .select()
      .from(postPublications)
      .where(eq(postPublications.postId, outcome.card!.id));
    expect(publication).toBeDefined();
  });

  // §7: LLM 呼び出し失敗は一時的技術障害として再試行キューへ（終端棄却しない）。
  // 新コア（run-pipeline.ts）は候補を curate 前に一律 upsert するため、旧
  // `runSubmitUrl`（終端が確定するまで post 行を作らない）とは異なり post 行
  // 自体は作られる。ここでの不変条件は「未キュレーションのまま（aiTitle が
  // null）で、公開記録（post_publications）が残らないこと」。
  it("queues a retry (does not publish) when LLM curation fails", async () => {
    const url = "https://example.com/FAIL_LLM-submitwrap";

    const outcome = await runSubmitUrlViaPipeline(url);

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe("queued_for_retry");
    expect(outcome.card).toBeNull();
    const [row] = await db.select().from(posts).where(eq(posts.url, url));
    expect(row?.aiTitle).toBeNull();
    const publications = await db.select().from(postPublications);
    expect(publications).toHaveLength(0);
  });

  // M1-1: 逐語タイトルの無検閲公開フィルタ。恒久棄却（再試行しない）。
  it("M1: a structurally broken caption (symbol spam) is terminally dropped as title_filter and never published", async () => {
    const url = "https://example.com/title-filter-submitwrap";

    const outcome = await runSubmitUrlViaPipeline(url);

    expect(outcome).toEqual({ ok: true, reason: "title_filter", card: null });
    const [row] = await db.select().from(posts).where(eq(posts.url, url));
    expect(row?.status).toBe("rejected");
  });

  // M1-3: 撤回済み（sticky）投稿は公開しない。
  it("M1: a post already recorded as removed (retracted/dropped) is never republished", async () => {
    const url = "https://www.youtube.com/watch?v=submitwrap-removed";
    const [inserted] = await db
      .insert(posts)
      .values({
        url,
        sourceType: "sns",
        sourceId: "youtube",
        sourceName: "YouTube",
        originalTitle: "Old title",
        originalExcerpt: null,
      })
      .returning();
    await db.insert(postRemovals).values({
      postId: inserted.id,
      kind: "retracted",
      reason: "user_request",
      removedAt: "2023-12-01T00:00:00.000Z",
    });

    const outcome = await runSubmitUrlViaPipeline(url);

    expect(outcome).toEqual({ ok: true, reason: "removed", card: null });
    const [row] = await db.select().from(posts).where(eq(posts.url, url));
    // sticky: 撤回済み投稿は再キュレーションされない（aiTitle が付かない）。
    expect(row?.aiTitle).toBeNull();
    const publications = await db.select().from(postPublications);
    expect(publications).toHaveLength(0);
  });

  // Q4: 日次公開上限に達したら公開せず、再試行キューへ繰り延べる（終端棄却しない）。
  it("Q4: when the daily publish cap is reached, does not publish and enqueues a rate_capped retry instead", async () => {
    // 上限を先に埋める: post_publications に DAILY_PUBLISH_CAP 件を直接投入する。
    const seedRows = Array.from({ length: DAILY_PUBLISH_CAP }, (_, i) => ({
      url: `https://example.com/rate-cap-seed-${i}`,
      sourceType: "blog" as const,
      sourceId: "seed",
      sourceName: "Seed",
      originalTitle: `Seed ${i}`,
      status: "published" as const,
    }));
    const insertedSeeds = await db.insert(posts).values(seedRows).returning();
    await db.insert(postPublications).values(
      insertedSeeds.map((row) => ({
        postId: row.id,
        publishedAt: "2024-01-01T00:00:00.000Z",
        bodyHash: "seed-hash",
      })),
    );

    const url = "https://www.youtube.com/watch?v=submitwrap-ratecap";
    const outcome = await runSubmitUrlViaPipeline(url);

    expect(outcome).toEqual({ ok: true, reason: "rate_limited", card: null });
    const [row] = await db.select().from(posts).where(eq(posts.url, url));
    expect(row?.aiTitle).toBeNull();
    const publications = await db
      .select()
      .from(postPublications)
      .where(eq(postPublications.postId, row!.id));
    expect(publications).toHaveLength(0);
  });

  it("uses the optional note as supplementary excerpt text when oEmbed returns no title", async () => {
    const url = "https://www.instagram.com/p/no-caption-abc/";

    const outcome = await runSubmitUrlViaPipeline(url, "会場の装花がとても綺麗でした");

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBeNull();
    expect(outcome.card).not.toBeNull();
  });

  describe("no source text (Instagram keyless oEmbed with no caption)", () => {
    it("never calls the LLM, terminally drops as extraction_insufficient, still saves the embed", async () => {
      // canonicalizeUrl は末尾スラッシュを除去して保存するため、クエリも
      // 正規化後の URL（末尾スラッシュ無し）で行う。
      const url = "https://www.instagram.com/p/no-caption-def";

      const outcome = await runSubmitUrlViaPipeline(`${url}/`);

      expect(outcome.reason).toBe("extraction_insufficient");
      expect(outcome.card).toBeNull();
      const [row] = await db.select().from(posts).where(eq(posts.url, url));
      expect(row?.status).toBe("rejected");
      expect(row?.embedHtml).toBe("<blockquote>ig</blockquote>");
    });

    it("treats a whitespace-only note as absent and still returns extraction_insufficient", async () => {
      const url = "https://www.instagram.com/p/no-caption-ghi/";

      const outcome = await runSubmitUrlViaPipeline(url, "   ");

      expect(outcome.reason).toBe("extraction_insufficient");
    });
  });
});
