import { describe, expect, it, vi, beforeEach } from "vitest";
import { POST } from "@/app/api/submit-url/route";
import { setupTestDb } from "./helpers/test-db";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: any) => fn,
  revalidateTag: vi.fn(),
}));

vi.mock("@/lib/embed/oembed", () => ({
  fetchOEmbed: vi.fn().mockResolvedValue({
    provider: "instagram",
    html: "<blockquote>ig</blockquote>",
    thumbnailUrl: "https://example.com/ig.jpg",
    authorName: "IG Author",
    title: "IG Title",
  }),
}));

vi.mock("@/lib/embed/providers", () => ({
  detectEmbedProvider: vi.fn().mockReturnValue("instagram"),
}));

vi.mock("@/lib/llm/batch", () => ({
  curateSingle: vi.fn().mockResolvedValue({
    title: "AI Curated SNS Title",
    summary: "AI Curated SNS Summary",
    category: "その他",
    tag: "classic",
  }),
}));

describe("Submit URL API Route", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "secret";
    await setupTestDb();
  });

  it("returns 401 when unauthorized", async () => {
    const req = new Request("http://localhost/api/submit-url", {
      method: "POST",
      body: JSON.stringify({ url: "https://www.instagram.com/p/ABC123/" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 when body is invalid or url is missing", async () => {
    const req = new Request("http://localhost/api/submit-url", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
      body: JSON.stringify({ note: "missing url" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when url is invalid", async () => {
    const req = new Request("http://localhost/api/submit-url", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
      body: JSON.stringify({ url: "not-a-url" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("successfully submits URL, curates via LLM, saves embed and returns card", async () => {
    const req = new Request("http://localhost/api/submit-url", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
      body: JSON.stringify({ url: "https://www.instagram.com/p/ABC123/?utm_source=ig" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.card.aiTitle).toBe("AI Curated SNS Title");
    expect(json.card.embedProvider).toBe("instagram");
  });
});
