/**
 * Purpose: `curateEvergreenUrlViaPipeline`（`@/lib/pipeline/evergreen-via-pipeline`）
 * の単体テスト。もとは `tests/pipeline-evergreen.test.ts`（旧骨格
 * `curateEvergreenUrl` 向け）にあったが、旧骨格の削除（Stage 6 S2 Commit 4）
 * に伴い、本番で今も真である外形的挙動（`EvergreenOutcome` 契約）のケースを
 * 新ラッパーへ向け直した。旧骨格の内部実装（中間状態・呼び出し順序）に
 * 依存したケースは含めていない。`resolveSourceName` / `registrableDomain`
 * 自体のテストは `tests/pipeline/source-name.test.ts` に移設済み。
 *
 * ラッパーの本体（`runPipeline` コア）は `tests/pipeline/run-pipeline.test.ts`
 * が別途モックベースで網羅しているため、ここでは「wrapper が正しい入出力
 * 契約を守っているか」に焦点を絞り、実インメモリ DB（`setupTestDb`）を使う。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb } from "../helpers/test-db";
import { db } from "@/lib/db";
import { posts, postPublications, postRemovals, postUsefulnessCriteria } from "@/lib/db/schema";
import { curateEvergreenUrlViaPipeline } from "@/lib/pipeline/evergreen-via-pipeline";
import { DAILY_PUBLISH_CAP } from "@/lib/constants";

const { fetchOgpMetadataMock } = vi.hoisted(() => ({
  fetchOgpMetadataMock: vi.fn(),
}));

vi.mock("@/lib/sources/ogp", () => ({
  fetchOgpMetadata: fetchOgpMetadataMock,
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
            category: "費用・節約",
            tag: "classic",
            firsthand: true,
            ceremonyDecision: false,
            specific: true,
            weddingDayContent: true,
            promotional: "none",
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

function ogpFor(url: string): {
  title: string;
  description: string | null;
  siteName: string | null;
  image: string | null;
  author: string | null;
  datePublished: string | null;
} | null {
  if (url.includes("no-metadata")) return null;
  if (url.includes("no-excerpt")) {
    return {
      title: `Title for ${url}`,
      description: null,
      siteName: "Example Site",
      image: null,
      author: null,
      datePublished: null,
    };
  }
  if (url.includes("title-filter")) {
    return {
      title: "会場選び〜〜〜〜のポイント",
      description: `Excerpt for ${url}`,
      siteName: "Example Site",
      image: null,
      author: null,
      datePublished: null,
    };
  }
  return {
    title: `Title for ${url}`,
    description: `Excerpt for ${url}`,
    siteName: "Example Site",
    image: null,
    author: null,
    datePublished: null,
  };
}

describe("curateEvergreenUrlViaPipeline (src/lib/pipeline/evergreen-via-pipeline.ts)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    await setupTestDb();
    fetchOgpMetadataMock.mockImplementation((url: string) => Promise.resolve(ogpFor(url)));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns reason 'invalid_url' and does not touch DB or LLM for an invalid URL", async () => {
    const outcome = await curateEvergreenUrlViaPipeline("not-a-url");
    expect(outcome).toEqual({ ok: false, reason: "invalid_url", card: null });
    expect(fetchOgpMetadataMock).not.toHaveBeenCalled();
    const rows = await db.select().from(posts);
    expect(rows).toHaveLength(0);
  });

  it("happy path: fetches OGP, curates via LLM, saves to DB with classic tag, usefulness criteria, and records publication", async () => {
    const url = "https://example.com/evergreenwrap-happy";

    const outcome = await curateEvergreenUrlViaPipeline(url);

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBeNull();
    expect(outcome.card?.tag).toBe("classic");
    expect(outcome.card?.sourceId).toBe("evergreen");
    // P2: 実在しない "エバーグリーン" というクレジットを生成せず og:site_name を使う。
    expect(outcome.card?.sourceName).toBe("Example Site");

    const [publication] = await db
      .select()
      .from(postPublications)
      .where(eq(postPublications.postId, outcome.card!.id));
    expect(publication).toBeDefined();

    const [usefulness] = await db
      .select()
      .from(postUsefulnessCriteria)
      .where(eq(postUsefulnessCriteria.postId, outcome.card!.id));
    expect(usefulness).toBeDefined();
  });

  it("returns reason 'no_metadata' if fetchOgpMetadata returns null or no title", async () => {
    const url = "https://example.com/no-metadata-wrap";

    const outcome = await curateEvergreenUrlViaPipeline(url);

    expect(outcome).toEqual({ ok: false, reason: "no_metadata", card: null });
    const rows = await db.select().from(posts);
    expect(rows).toHaveLength(0);
  });

  // Q1相当（簡易）: og:description が無いと LLM を呼ばず即終端棄却する。
  it("Q1: when og:description is null, does NOT call the LLM and terminally drops as extraction_insufficient", async () => {
    const url = "https://example.com/no-excerpt-wrap";

    const outcome = await curateEvergreenUrlViaPipeline(url);

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe("extraction_insufficient");
    expect(outcome.card).toBeNull();
    const [row] = await db.select().from(posts).where(eq(posts.url, url));
    expect(row?.status).toBe("rejected");
  });

  // §7: LLM 呼び出し失敗は一時的技術障害として再試行キューへ（終端棄却しない）。
  // 新コア（run-pipeline.ts）は候補を curate 前に一律 upsert するため、旧
  // `curateEvergreenUrl`（終端が確定するまで post 行を作らない）とは異なり
  // post 行自体は作られる。不変条件は「未キュレーション（aiTitle が null）
  // のまま、公開記録が残らないこと」。
  it("queues a retry (does not publish) when LLM curation fails", async () => {
    const url = "https://example.com/FAIL_LLM-evergreenwrap";

    const outcome = await curateEvergreenUrlViaPipeline(url);

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe("queued_for_retry");
    expect(outcome.card).toBeNull();
    const [row] = await db.select().from(posts).where(eq(posts.url, url));
    expect(row?.aiTitle).toBeNull();
    const publications = await db.select().from(postPublications);
    expect(publications).toHaveLength(0);
  });

  // M1-1: 逐語タイトルの無検閲公開フィルタ。恒久棄却（再試行しない）。
  it("M1: a structurally broken title (symbol spam) is terminally dropped as title_filter and never published", async () => {
    const url = "https://example.com/title-filter-evergreenwrap";

    const outcome = await curateEvergreenUrlViaPipeline(url);

    expect(outcome).toEqual({ ok: true, reason: "title_filter", card: null });
    const [row] = await db.select().from(posts).where(eq(posts.url, url));
    expect(row?.status).toBe("rejected");
  });

  // M1-3: 撤回済み（sticky）投稿は公開しない。
  it("M1: a post already recorded as removed (retracted/dropped) is never republished", async () => {
    const url = "https://example.com/evergreenwrap-removed";
    const [inserted] = await db
      .insert(posts)
      .values({
        url,
        sourceType: "blog",
        sourceId: "evergreen",
        sourceName: "Example Site",
        originalTitle: "Old title",
        originalExcerpt: "Old excerpt",
      })
      .returning();
    await db.insert(postRemovals).values({
      postId: inserted.id,
      kind: "retracted",
      reason: "user_request",
      removedAt: "2023-12-01T00:00:00.000Z",
    });

    const outcome = await curateEvergreenUrlViaPipeline(url);

    expect(outcome).toEqual({ ok: true, reason: "removed", card: null });
    const [row] = await db.select().from(posts).where(eq(posts.url, url));
    // sticky: 撤回済み投稿は再キュレーションされない（aiTitle が付かない）。
    expect(row?.aiTitle).toBeNull();
    const publications = await db.select().from(postPublications);
    expect(publications).toHaveLength(0);
  });

  // Q4: 日次公開上限に達したら公開せず、再試行キューへ繰り延べる（終端棄却しない）。
  it("Q4: when the daily publish cap is reached, does not publish and enqueues a rate_capped retry instead", async () => {
    const seedRows = Array.from({ length: DAILY_PUBLISH_CAP }, (_, i) => ({
      url: `https://example.com/evergreen-rate-cap-seed-${i}`,
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

    const url = "https://example.com/evergreenwrap-ratecap";
    const outcome = await curateEvergreenUrlViaPipeline(url);

    expect(outcome).toEqual({ ok: true, reason: "rate_limited", card: null });
    const [row] = await db.select().from(posts).where(eq(posts.url, url));
    expect(row?.aiTitle).toBeNull();
    const publications = await db
      .select()
      .from(postPublications)
      .where(eq(postPublications.postId, row!.id));
    expect(publications).toHaveLength(0);
  });

  // P2: og:site_name が無い場合は URL のドメインでクレジットする（捏造しない）
  it("P2: falls back to registrable domain for sourceName when og:site_name is absent", async () => {
    fetchOgpMetadataMock.mockResolvedValueOnce({
      title: "Title",
      description: "Excerpt",
      siteName: null,
      image: null,
      author: null,
      datePublished: null,
    });
    const url = "https://www.zexy.net/evergreenwrap-domain";

    const outcome = await curateEvergreenUrlViaPipeline(url);

    expect(outcome.ok).toBe(true);
    expect(outcome.card?.sourceName).toBe("zexy.net");
  });

  // P2: 手動指定の sourceName を最優先する（前後の空白はトリム）
  it("P2: explicit sourceName takes highest precedence and is trimmed", async () => {
    const url = "https://example.com/evergreenwrap-explicit-source";

    const outcome = await curateEvergreenUrlViaPipeline(url, {
      sourceName: "  手動指定メディア  ",
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.card?.sourceName).toBe("手動指定メディア");
  });
});
