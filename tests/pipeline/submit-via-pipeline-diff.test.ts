/**
 * Purpose: Diff test comparing legacy runSubmitUrl vs the new production
 * wrapper runSubmitUrlViaPipeline (S2 wiring, shared_plan/17 Stage 6).
 * Verifies the three SubmitOutcome fields (ok / reason / card) match for the
 * same seeded DB across happy path, invalid_url, and title_filter rejection.
 * When called: Vitest suite execution.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { setupTestDb } from "../../tests/helpers/test-db";
import { runSubmitUrl } from "@/lib/pipeline/submit-url";
import { runSubmitUrlViaPipeline } from "@/lib/pipeline/submit-via-pipeline";

const { fetchOEmbedMock } = vi.hoisted(() => ({
  fetchOEmbedMock: vi.fn(),
}));

vi.mock("@/lib/embed/oembed", () => ({
  fetchOEmbed: fetchOEmbedMock,
}));

vi.mock("@/lib/llm/batch", async (importOriginal) => {
  const orig = (await importOriginal()) as any;
  return {
    ...orig,
    curateSingle: vi.fn((input: { title: string; excerpt: string | null }) => {
      if (input.title.includes("FAIL_LLM")) return Promise.resolve(null);
      return Promise.resolve({
        title: `AI: ${input.title}`,
        summary: `AI summary for ${input.title}`,
        category: "その他",
        tag: "trend",
        firsthand: 1,
        ceremonyDecision: 1,
        specific: 1,
        weddingDayContent: 1,
        promotional: 0,
        topicAnchor: input.title,
        rationaleText: "十分な体験に基づく具体的な考察",
        evidenceSufficient: true,
      });
    }),
    curatePosts: vi.fn((inputs: Array<{ title: string; excerpt: string | null }>) =>
      Promise.resolve({
        results: inputs.map((input) => {
          if (input.title.includes("FAIL_LLM")) return null;
          return {
            title: `AI: ${input.title}`,
            summary: `AI summary for ${input.title}`,
            category: "その他",
            tag: "trend",
            firsthand: 1,
            ceremonyDecision: 1,
            specific: 1,
            weddingDayContent: 1,
            promotional: 0,
            topicAnchor: input.title,
            rationaleText: "十分な体験に基づく具体的な考察",
            evidenceSufficient: true,
          };
        }),
        geminiCalls: 1,
      }),
    ),
  };
});

function oembedFor(url: string): any {
  if (url.includes("no-source")) {
    return null;
  }
  if (url.includes("title-filter")) {
    return {
      provider: "none" as const,
      // SYMBOL_REPEAT_RE（gate.ts）は同一記号の4連続以上を要求する。
      // 「！！！」のような3連続では発火しないため、4連続にして
      // title_filter を実際に発火させる。
      title: "！！！！ 違法",
      authorName: "Author",
      thumbnailUrl: null,
      html: null,
    };
  }
  if (url.includes("youtube.com")) {
    return {
      provider: "youtube" as const,
      title: `YouTube Title for ${url}`,
      authorName: "YT Author",
      thumbnailUrl: "https://img.youtube.com/thumb.jpg",
      html: "<iframe></iframe>",
    };
  }
  return {
    provider: "none" as const,
    title: `Title for ${url}`,
    authorName: null,
    thumbnailUrl: null,
    html: null,
  };
}

describe("Submit-via-pipeline diff: legacy runSubmitUrl vs runSubmitUrlViaPipeline", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    await setupTestDb();
    fetchOEmbedMock.mockImplementation((url: string) => Promise.resolve(oembedFor(url)));
  });

  afterEach(() => vi.useRealTimers());

  it("happy path (youtube url) yields identical SubmitOutcome", async () => {
    const url = "https://www.youtube.com/watch?v=diffwrap1";

    const legacy = await runSubmitUrl(url);

    await setupTestDb();
    fetchOEmbedMock.mockImplementation((u: string) => Promise.resolve(oembedFor(u)));

    const wrapped = await runSubmitUrlViaPipeline(url);

    expect(wrapped.ok).toBe(legacy.ok);
    expect(wrapped.reason).toBe(legacy.reason);
    expect(wrapped.card).toEqual(legacy.card);
    expect(wrapped.ok).toBe(true);
    expect(wrapped.reason).toBeNull();
    expect(wrapped.card).not.toBeNull();
  });

  it("invalid_url yields identical SubmitOutcome", async () => {
    const url = "not-a-valid-url";

    const legacy = await runSubmitUrl(url);
    const wrapped = await runSubmitUrlViaPipeline(url);

    expect(wrapped).toEqual(legacy);
    expect(wrapped.ok).toBe(false);
    expect(wrapped.reason).toBe("invalid_url");
    expect(wrapped.card).toBeNull();
  });

  it("title_filter rejection yields identical SubmitOutcome", async () => {
    const url = "https://example.com/title-filter-diffwrap";

    const legacy = await runSubmitUrl(url);

    await setupTestDb();
    fetchOEmbedMock.mockImplementation((u: string) => Promise.resolve(oembedFor(u)));

    const wrapped = await runSubmitUrlViaPipeline(url);

    expect(wrapped.ok).toBe(legacy.ok);
    expect(wrapped.reason).toBe(legacy.reason);
    expect(wrapped.card).toEqual(legacy.card);
    expect(wrapped.ok).toBe(true);
    expect(wrapped.reason).toBe("title_filter");
    expect(wrapped.card).toBeNull();
  });
});
