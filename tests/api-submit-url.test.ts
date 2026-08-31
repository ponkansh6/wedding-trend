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
  // 本番経路が runSubmitUrlViaPipeline (run-pipeline.ts) に切り替わり、
  // curateSingle ではなく curatePosts が呼ばれるようになったため、
  // curatePosts をモックする（M1-2 の語彙的接地を通すための値は変更なし）。
  curatePosts: vi.fn().mockResolvedValue({
    results: [
      {
        title: "AI Curated SNS Title",
        summary: "AI Curated SNS Summary",
        category: "その他",
        tag: "classic",
        firsthand: true,
        ceremonyDecision: true,
        specific: true,
        weddingDayContent: false,
        promotional: "none",
        preDecisionOrPhotoShoot: false,
        // M1-2 の語彙的接地（plan 07 D4）を通すため、LLM への実入力
        // （sourceTitle = "IG Title"）に逐語で含まれる語にする。
        topicAnchor: "IG Title",
        rationaleText:
          "実際の体験に基づく会場選びや進行プロセスにおける具体的な工夫と背景についての客観的な振り返りを行う非常に有用な記事内容である",
      },
    ],
    geminiCalls: 1,
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
    expect(json.card.originalTitle).toBe("IG Title");
    expect(json.card.embedProvider).toBe("instagram");
  });
});
