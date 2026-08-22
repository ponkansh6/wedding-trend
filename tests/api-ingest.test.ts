import { describe, expect, it, vi, beforeEach } from "vitest";
import { POST, GET } from "@/app/api/ingest/route";
import { getLastIngestAt } from "@/lib/db/repository";
import { acquireIngestLease, releaseIngestLease } from "@/lib/pipeline/cooldown";
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
  curatePosts: vi.fn().mockResolvedValue([
    {
      title: "AI Curated Title",
      summary: "AI Summary",
      category: "その他",
      tag: "trend",
    },
  ]),
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

  it("Bearer 認証済みなら公開ボタン側のクールダウン中でも実行され、last_ingest_at を更新する", async () => {
    // 直前に公開ボタン経由で実行されたばかり（=クールダウン中）という状態を再現する。
    const recentAuthorizedReq = new Request("http://localhost/api/ingest", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    const first = await POST(recentAuthorizedReq);
    expect(first.status).toBe(200);
    const firstLastIngestAt = await getLastIngestAt();
    expect(firstLastIngestAt).not.toBeNull();

    // クールダウン期間内（4時間未満）にもう一度 Cron 経路で叩く。
    const secondReq = new Request("http://localhost/api/ingest", {
      method: "GET",
      headers: { authorization: "Bearer secret" },
    });
    const second = await GET(secondReq);
    expect(second.status).toBe(200);
    const secondJson = await second.json();
    // クールダウンを迂回してパイプラインが実際に実行されている（要約結果が返る）。
    expect(secondJson.fetched).toBe(1);

    const secondLastIngestAt = await getLastIngestAt();
    expect(secondLastIngestAt).not.toBeNull();
    // 実行のたびに last_ingest_at が更新されている。
    expect(new Date(secondLastIngestAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(firstLastIngestAt!).getTime(),
    );
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
    // lease で弾かれた場合、last_ingest_at は更新されない。
    expect(await getLastIngestAt()).toBeNull();

    await releaseIngestLease();
  });
});
