import { describe, expect, it, vi, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { readFileSync } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { POST, GET } from "@/app/api/ingest/route";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: any) => fn,
  revalidateTag: vi.fn(),
}));

const migrationSql = readFileSync(
  path.resolve(__dirname, "../src/lib/db/migrations/0000_stormy_harrier.sql"),
  "utf-8",
);

async function setupTestDb() {
  try {
    await db.run(sql.raw("DROP TABLE IF EXISTS posts;"));
  } catch {}
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await db.run(sql.raw(stmt));
  }
}

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
});
