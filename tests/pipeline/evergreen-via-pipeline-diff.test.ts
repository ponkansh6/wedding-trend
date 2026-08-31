/**
 * Purpose: Diff test comparing legacy curateEvergreenUrl vs the new
 * production wrapper curateEvergreenUrlViaPipeline (S2 wiring,
 * shared_plan/17 Stage 6). Verifies the three EvergreenOutcome fields
 * (ok / reason / card) match for the same seeded DB across happy path,
 * invalid_url, no_metadata, and title_filter rejection. `no_source_name` is
 * omitted: for any URL that survives `canonicalizeUrl` (http/https), the
 * hostname is always non-empty, so `registrableDomain()`'s fallback in
 * `resolveSourceName()` always succeeds and this reason is unreachable
 * through the real flow (see completion report for detail).
 * When called: Vitest suite execution.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { setupTestDb } from "../../tests/helpers/test-db";
import { curateEvergreenUrl } from "@/lib/pipeline/evergreen";
import { curateEvergreenUrlViaPipeline } from "@/lib/pipeline/evergreen-via-pipeline";

const { fetchOgpMetadataMock } = vi.hoisted(() => ({
  fetchOgpMetadataMock: vi.fn(),
}));

vi.mock("@/lib/sources/ogp", () => ({
  fetchOgpMetadata: fetchOgpMetadataMock,
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

function ogpFor(url: string): any {
  if (url.includes("no-metadata")) {
    return null;
  }
  if (url.includes("no-source")) {
    return {
      title: `Title for ${url}`,
      description: `Excerpt for ${url}`,
      siteName: null,
      image: null,
      author: null,
      datePublished: null,
    };
  }
  if (url.includes("title-filter")) {
    return {
      // SYMBOL_REPEAT_RE（gate.ts）は同一記号の4連続以上を要求する。
      // 「！！！」のような3連続では発火しないため、4連続にして
      // title_filter を実際に発火させる。
      title: "！！！！ 違法",
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

describe("Evergreen-via-pipeline diff: legacy curateEvergreenUrl vs curateEvergreenUrlViaPipeline", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    await setupTestDb();
    fetchOgpMetadataMock.mockImplementation((url: string) => Promise.resolve(ogpFor(url)));
  });

  afterEach(() => vi.useRealTimers());

  it("happy path yields identical EvergreenOutcome", async () => {
    const url = "https://example.com/happy-diffwrap1";

    const legacy = await curateEvergreenUrl(url);

    await setupTestDb();
    fetchOgpMetadataMock.mockImplementation((u: string) => Promise.resolve(ogpFor(u)));

    const wrapped = await curateEvergreenUrlViaPipeline(url);

    expect(wrapped.ok).toBe(legacy.ok);
    expect(wrapped.reason).toBe(legacy.reason);
    expect(wrapped.card).toEqual(legacy.card);
    expect(wrapped.ok).toBe(true);
    expect(wrapped.reason).toBeNull();
    expect(wrapped.card).not.toBeNull();
  });

  it("invalid_url yields identical EvergreenOutcome", async () => {
    const url = "not-a-valid-url";

    const legacy = await curateEvergreenUrl(url);
    const wrapped = await curateEvergreenUrlViaPipeline(url);

    expect(wrapped).toEqual(legacy);
    expect(wrapped.ok).toBe(false);
    expect(wrapped.reason).toBe("invalid_url");
    expect(wrapped.card).toBeNull();
  });

  it("no_metadata yields identical EvergreenOutcome", async () => {
    const url = "https://example.com/no-metadata-diffwrap";

    const legacy = await curateEvergreenUrl(url);

    await setupTestDb();
    fetchOgpMetadataMock.mockImplementation((u: string) => Promise.resolve(ogpFor(u)));

    const wrapped = await curateEvergreenUrlViaPipeline(url);

    expect(wrapped).toEqual(legacy);
    expect(wrapped.ok).toBe(false);
    expect(wrapped.reason).toBe("no_metadata");
    expect(wrapped.card).toBeNull();
  });

  it("title_filter rejection yields identical EvergreenOutcome", async () => {
    const url = "https://example.com/title-filter-diffwrap";

    const legacy = await curateEvergreenUrl(url);

    await setupTestDb();
    fetchOgpMetadataMock.mockImplementation((u: string) => Promise.resolve(ogpFor(u)));

    const wrapped = await curateEvergreenUrlViaPipeline(url);

    expect(wrapped.ok).toBe(legacy.ok);
    expect(wrapped.reason).toBe(legacy.reason);
    expect(wrapped.card).toEqual(legacy.card);
    expect(wrapped.ok).toBe(true);
    expect(wrapped.reason).toBe("title_filter");
    expect(wrapped.card).toBeNull();
  });
});
