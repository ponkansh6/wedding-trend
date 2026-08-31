/**
 * Purpose: Diff test comparing legacy curateEvergreenUrl vs runPipeline(EvergreenAdapter).
 * When called: Vitest suite execution.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { setupTestDb } from "../../tests/helpers/test-db";
import { curateEvergreenUrl } from "@/lib/pipeline/evergreen";
import { runPipelineOnCandidates } from "@/lib/pipeline/run-pipeline";
import { EvergreenAdapter } from "@/lib/pipeline/adapters/evergreen-adapter";
import { db } from "@/lib/db";
import { posts, postPublications, postRetryQueue, postRemovals } from "@/lib/db/schema";
import { computeCurationSignature } from "@/lib/llm/signature";
import { hashUrl } from "@/lib/db/repository";
import { RETRY_MAX_ATTEMPTS } from "@/lib/constants";

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
        tag: "classic",
        firsthand: 2,
        ceremonyDecision: 2,
        specific: 2,
        weddingDayContent: 1,
        promotional: 0,
        topicAnchor: input.title,
        rationaleText: "十分な体験に基づく具体的な考察が含まれており有用であると判断される",
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
            tag: "classic",
            firsthand: 2,
            ceremonyDecision: 2,
            specific: 2,
            weddingDayContent: 1,
            promotional: 0,
            topicAnchor: input.title,
            rationaleText: "十分な体験に基づく具体的な考察が含まれており有用であると判断される",
            evidenceSufficient: true,
          };
        }),
        geminiCalls: 1,
      }),
    ),
  };
});

const normalize = (rows: any[]) =>
  rows
    .map((r) => {
      const c = { ...r };
      delete c.id;
      delete c.postId;
      delete c.createdAt;
      delete c.updatedAt;
      delete c.publishedAtEpoch;
      return c;
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

function ogpFor(url: string): any {
  if (url.includes("no-excerpt")) {
    return {
      title: "No Excerpt Title",
      description: null,
      siteName: "Example",
      author: null,
      image: null,
      datePublished: null,
    };
  }
  if (url.includes("title-filter")) {
    return {
      title: "！！！！ 違法 非合法",
      description: "Excerpt for filter",
      siteName: "Example",
      author: "Author Filter",
      image: null,
      datePublished: "2024-01-01T00:00:00.000Z",
    };
  }
  const map: Record<string, any> = {
    "https://example.com/ever1": {
      title: "Evergreen One",
      description: "Excerpt Ever One",
      siteName: "Example Ever",
      author: "Author Ever1",
      image: "https://example.com/thumb1.jpg",
      datePublished: "2024-01-01T00:00:00.000Z",
    },
    "https://example.com/ever2": {
      title: "Evergreen Two",
      description: "Excerpt Ever Two",
      siteName: "Example Ever",
      author: "Author Ever2",
      image: null,
      datePublished: "2024-01-02T00:00:00.000Z",
    },
    "https://example.com/retry-ever": {
      title: "Retry Ever",
      description: "Excerpt Retry",
      siteName: "Example Ever",
      author: null,
      image: null,
      datePublished: "2024-01-01T00:00:00.000Z",
    },
    "https://example.com/fail-llm": {
      title: "FAIL_LLM Title",
      description: "Excerpt fail llm",
      siteName: "Example",
      author: null,
      image: null,
      datePublished: null,
    },
  };
  if (map[url]) return map[url];
  // default fallback: title from url
  return {
    title: `Title for ${url}`,
    description: `Excerpt for ${url}`,
    siteName: "Example",
    author: null,
    image: null,
    datePublished: null,
  };
}

describe("Evergreen Diff Test: legacy curateEvergreenUrl vs runPipeline", () => {
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

  it("happy path fresh (2 URLs)", async () => {
    const urls = ["https://example.com/ever1", "https://example.com/ever2"];

    for (const u of urls) await curateEvergreenUrl(u);
    const postsA = await db.select().from(posts);
    const pubsA = await db.select().from(postPublications);
    const retryA = await db.select().from(postRetryQueue);
    const removalsA = await db.select().from(postRemovals);

    await setupTestDb();
    fetchOgpMetadataMock.mockImplementation((url: string) => Promise.resolve(ogpFor(url)));

    const adapter = new EvergreenAdapter();
    const candidates = await adapter.buildCandidates(urls);
    await runPipelineOnCandidates(candidates, adapter, {
      curationBudget: 10,
      dailyPublishCap: 150,
      jstDayStartIso: "2024-01-01T00:00:00.000Z",
      curationSignature: computeCurationSignature(),
      retryMaxAttempts: RETRY_MAX_ATTEMPTS,
      retryBackoffHours: [1, 6, 24],
      retryTtlHours: 72,
      lane: "evergreen",
      enforceRemovedFilter: true,
      enforceRateCap: true,
    });

    const postsB = await db.select().from(posts);
    const pubsB = await db.select().from(postPublications);
    const retryB = await db.select().from(postRetryQueue);
    const removalsB = await db.select().from(postRemovals);

    expect(normalize(postsB)).toEqual(normalize(postsA));
    expect(normalize(pubsB)).toEqual(normalize(pubsA));
    expect(normalize(retryB)).toEqual(normalize(retryA));
    expect(normalize(removalsB)).toEqual(normalize(removalsA));
  });

  it("retry giveUp parity (llm_transient exceeds max attempts)", async () => {
    const url = "https://example.com/fail-llm";
    // Seed retry queue at max attempts
    await db.insert(postRetryQueue).values({
      urlHash: hashUrl(url),
      url,
      host: "example.com",
      lane: "evergreen",
      reason: "llm_transient",
      attempts: RETRY_MAX_ATTEMPTS,
      firstQueuedAt: "2023-12-31T00:00:00.000Z",
      nextAttemptAt: "2023-12-31T12:00:00.000Z",
      expiresAt: "2024-01-31T00:00:00.000Z",
    });

    // Legacy drain: ctx with max attempts
    await curateEvergreenUrl(url, undefined, {
      urlHash: hashUrl(url),
      attempts: RETRY_MAX_ATTEMPTS,
      firstQueuedAt: "2023-12-31T00:00:00.000Z",
    });
    const postsA = await db.select().from(posts);
    const pubsA = await db.select().from(postPublications);
    const retryA = await db.select().from(postRetryQueue);
    const removalsA = await db.select().from(postRemovals);

    await setupTestDb();
    fetchOgpMetadataMock.mockImplementation((u: string) => Promise.resolve(ogpFor(u)));
    await db.insert(postRetryQueue).values({
      urlHash: hashUrl(url),
      url,
      host: "example.com",
      lane: "evergreen",
      reason: "llm_transient",
      attempts: RETRY_MAX_ATTEMPTS,
      firstQueuedAt: "2023-12-31T00:00:00.000Z",
      nextAttemptAt: "2023-12-31T12:00:00.000Z",
      expiresAt: "2024-01-31T00:00:00.000Z",
    });

    const adapter = new EvergreenAdapter();
    const candidates = await adapter.fetchDueRetries("2024-01-01T00:00:00.000Z");
    expect(candidates.length).toBe(1);
    expect(candidates[0].retry?.attempts).toBe(RETRY_MAX_ATTEMPTS);

    await runPipelineOnCandidates(candidates, adapter, {
      curationBudget: 10,
      dailyPublishCap: 150,
      jstDayStartIso: "2024-01-01T00:00:00.000Z",
      curationSignature: computeCurationSignature(),
      retryMaxAttempts: RETRY_MAX_ATTEMPTS,
      retryBackoffHours: [1, 6, 24],
      retryTtlHours: 72,
      lane: "evergreen",
      enforceRemovedFilter: true,
      enforceRateCap: true,
    });

    const postsB = await db.select().from(posts);
    const pubsB = await db.select().from(postPublications);
    const retryB = await db.select().from(postRetryQueue);
    const removalsB = await db.select().from(postRemovals);

    expect(normalize(postsB)).toEqual(normalize(postsA));
    expect(normalize(pubsB)).toEqual(normalize(pubsA));
    expect(normalize(retryB)).toEqual(normalize(retryA));
    expect(normalize(removalsB)).toEqual(normalize(removalsA));
  });

  it("title_filter gate parity", async () => {
    const url = "https://example.com/title-filter";

    await curateEvergreenUrl(url);
    const postsA = await db.select().from(posts);
    const pubsA = await db.select().from(postPublications);
    const retryA = await db.select().from(postRetryQueue);
    const removalsA = await db.select().from(postRemovals);

    await setupTestDb();
    fetchOgpMetadataMock.mockImplementation((u: string) => Promise.resolve(ogpFor(u)));

    const adapter = new EvergreenAdapter();
    const candidates = await adapter.buildCandidates([url]);
    await runPipelineOnCandidates(candidates, adapter, {
      curationBudget: 10,
      dailyPublishCap: 150,
      jstDayStartIso: "2024-01-01T00:00:00.000Z",
      curationSignature: computeCurationSignature(),
      retryMaxAttempts: RETRY_MAX_ATTEMPTS,
      retryBackoffHours: [1, 6, 24],
      retryTtlHours: 72,
      lane: "evergreen",
      enforceRemovedFilter: true,
      enforceRateCap: true,
    });

    const postsB = await db.select().from(posts);
    const pubsB = await db.select().from(postPublications);
    const retryB = await db.select().from(postRetryQueue);
    const removalsB = await db.select().from(postRemovals);

    expect(normalize(postsB)).toEqual(normalize(postsA));
    expect(normalize(pubsB)).toEqual(normalize(pubsA));
    expect(normalize(retryB)).toEqual(normalize(retryA));
    expect(normalize(removalsB)).toEqual(normalize(removalsA));
  });

  it("extraction_insufficient parity", async () => {
    const url = "https://example.com/no-excerpt";

    await curateEvergreenUrl(url);
    const postsA = await db.select().from(posts);
    const pubsA = await db.select().from(postPublications);
    const retryA = await db.select().from(postRetryQueue);
    const removalsA = await db.select().from(postRemovals);

    await setupTestDb();
    fetchOgpMetadataMock.mockImplementation((u: string) => Promise.resolve(ogpFor(u)));

    const adapter = new EvergreenAdapter();
    const candidates = await adapter.buildCandidates([url]);
    await runPipelineOnCandidates(candidates, adapter, {
      curationBudget: 10,
      dailyPublishCap: 150,
      jstDayStartIso: "2024-01-01T00:00:00.000Z",
      curationSignature: computeCurationSignature(),
      retryMaxAttempts: RETRY_MAX_ATTEMPTS,
      retryBackoffHours: [1, 6, 24],
      retryTtlHours: 72,
      lane: "evergreen",
      enforceRemovedFilter: true,
      enforceRateCap: true,
    });

    const postsB = await db.select().from(posts);
    const pubsB = await db.select().from(postPublications);
    const retryB = await db.select().from(postRetryQueue);
    const removalsB = await db.select().from(postRemovals);

    expect(normalize(postsB)).toEqual(normalize(postsA));
    expect(normalize(pubsB)).toEqual(normalize(pubsA));
    expect(normalize(retryB)).toEqual(normalize(retryA));
    expect(normalize(removalsB)).toEqual(normalize(removalsA));
  });
});
