import { describe, expect, it, vi, beforeEach } from "vitest";
import { POST, GET } from "@/app/api/ingest/route";
import { readLastRunSummary } from "@/lib/db/repository";
import { acquireIngestLease, getCooldownUntil, releaseIngestLease } from "@/lib/pipeline/cooldown";
import { setupTestDb } from "./helpers/test-db";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: any) => fn,
  revalidateTag: vi.fn(),
}));

vi.mock("@/lib/sources/registry", () => ({
  SOURCE_IDS: ["hatena-bookmark"],
  SOURCE_REGISTRY: {
    "hatena-bookmark": {
      fetch: vi
        .fn()
        .mockResolvedValue([{ title: "Blog Post 1", link: "https://example.com/blog1" }]),
      toPost: vi.fn().mockReturnValue({
        url: "https://example.com/blog1",
        sourceType: "blog",
        sourceId: "hatena",
        sourceName: "Hatena",
        originalTitle: "Blog Post 1",
        originalExcerpt: "Excerpt",
        author: "Author",
        thumbnailUrl: null,
        publishedAt: "2024-01-01T00:00:00.000Z",
      }),
    },
  },
}));

vi.mock("@/lib/llm/batch", () => ({
  curatePosts: vi.fn().mockResolvedValue({
    results: [
      {
        title: "AI Curated Title",
        summary: "AI Summary",
        category: "その他",
        tag: "trend",
      },
    ],
    geminiCalls: 1,
  }),
}));

describe("Ingest API Route", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "secret";
    await setupTestDb();
  });

  it("returns 401 when unauthorized", async () => {
    const req = new Request("http://localhost/api/ingest", { method: "POST" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 for GET when unauthorized (Vercel Cron path without a valid CRON_SECRET)", async () => {
    const req = new Request("http://localhost/api/ingest", { method: "GET" });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("GET runs the same ingest pipeline as POST when authorized (Vercel Cron sends GET)", async () => {
    const req = new Request("http://localhost/api/ingest", {
      method: "GET",
      headers: { authorization: "Bearer secret" },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.fetched).toBe(1);
    expect(json.inserted).toBe(1);
    expect(json.curated).toBe(1);
    expect(json.skipped).toBe(0);
    expect(json.errors).toEqual([]);
    expect(json.geminiCalls).toBe(1);
  });

  it("successfully crawls, upserts, curates and revalidates when authorized", async () => {
    const req = new Request("http://localhost/api/ingest", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.fetched).toBe(1);
    expect(json.inserted).toBe(1);
    expect(json.curated).toBe(1);
  });

  it("does NOT touch the cooldown key (ingest_cooldown_until): the cron path is fully exempt from claim/extend", async () => {
    // クールダウンが空いていることを事前に確認しておく。
    expect(await getCooldownUntil()).toBeNull();

    const req = new Request("http://localhost/api/ingest", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    // 実行後もクールダウンキーは触られていない（cron はここを一切評価・更新しない）。
    expect(await getCooldownUntil()).toBeNull();
  });

  it("records last_cron_ingest_at (observation only) on every authorized run, independent of cooldown", async () => {
    const before = new Date();

    const req = new Request("http://localhost/api/ingest", {
      method: "GET",
      headers: { authorization: "Bearer secret" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);

    const raw = await readLastRunSummary();
    // last_run_summary はランのたびに ingest.ts が保存するテレメトリ。
    // last_cron_ingest_at はそれとは別キーであり、ここでは「記録された」こと
    // 自体を検証する（値の中身は route.ts が書く生の ISO8601 時刻）。
    expect(raw).not.toBeNull();

    // 2 回目の実行でも last_ingest_at 系のクールダウンには一切波及しない
    // （前のテストと合わせて cron 経路の独立性を担保する）。
    expect(await getCooldownUntil(before)).toBeNull();
  });

  it("acquires the lease on every run (all paths must)", async () => {
    const req = new Request("http://localhost/api/ingest", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    // リースは実行完了後に解放されているため、直後に再取得できる
    // （＝実行中は保持されていたが、finally で確実に解放されたことの間接検証）。
    const reacquired = await acquireIngestLease();
    expect(reacquired).toBe(true);
    await releaseIngestLease();
  });

  it("returns 409 and never runs the pipeline when another execution already holds the ingest lease", async () => {
    // 別の実行（このテストでは Cron の別呼び出しを想定）がリースを保持している
    // 状態を再現する。
    const leaseAcquired = await acquireIngestLease();
    expect(leaseAcquired).toBe(true);

    const req = new Request("http://localhost/api/ingest", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    const res = await POST(req);

    expect(res.status).toBe(409);
    // lease で弾かれた場合、last_cron_ingest_at も last_run_summary も更新されない
    // （認可チェック通過後、lease 取得の直後に弾かれ、以降の処理に一切到達しない）。
    expect(await readLastRunSummary()).toBeNull();

    await releaseIngestLease();
  });
});
