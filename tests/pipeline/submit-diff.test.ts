/**
 * Purpose: Diff test comparing legacy runSubmitUrl vs runPipeline(SubmitAdapter).
 * When called: Vitest suite execution.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { setupTestDb } from "../../tests/helpers/test-db";
import { runSubmitUrl } from "@/lib/pipeline/submit-url";
import { runPipelineOnCandidates } from "@/lib/pipeline/run-pipeline";
import { SubmitAdapter } from "@/lib/pipeline/adapters/submit-adapter";
import { db } from "@/lib/db";
import { posts, postPublications, postRetryQueue, postRemovals } from "@/lib/db/schema";
import { computeCurationSignature } from "@/lib/llm/signature";
import { hashUrl } from "@/lib/db/repository";
import { RETRY_MAX_ATTEMPTS } from "@/lib/constants";

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

function oembedFor(url: string): any {
  if (url.includes("no-source")) {
    return null;
  }
  if (url.includes("title-filter")) {
    return {
      provider: "none" as const,
      title: "！！！！ 違法",
      authorName: "Author",
      thumbnailUrl: null,
      html: null,
    };
  }
  if (url.includes("fail-llm")) {
    return {
      provider: "youtube" as const,
      title: "FAIL_LLM Video",
      authorName: "Author Fail",
      thumbnailUrl: null,
      html: "<iframe></iframe>",
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

describe("Submit Diff Test: legacy runSubmitUrl vs runPipeline", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    await setupTestDb();
    fetchOEmbedMock.mockImplementation((url: string) => Promise.resolve(oembedFor(url)));
  });

  afterEach(() => vi.useRealTimers());

  it("happy path (youtube url)", async () => {
    const url = "https://www.youtube.com/watch?v=abc123";

    await runSubmitUrl(url);
    const postsA = await db.select().from(posts);
    const pubsA = await db.select().from(postPublications);
    const retryA = await db.select().from(postRetryQueue);
    const removalsA = await db.select().from(postRemovals);

    await setupTestDb();
    fetchOEmbedMock.mockImplementation((u: string) => Promise.resolve(oembedFor(u)));

    const adapter = new SubmitAdapter();
    const candidates = await adapter.buildCandidates([url]);
    await runPipelineOnCandidates(candidates, adapter, {
      curationBudget: 10,
      dailyPublishCap: 150,
      jstDayStartIso: "2024-01-01T00:00:00.000Z",
      curationSignature: computeCurationSignature(),
      retryMaxAttempts: RETRY_MAX_ATTEMPTS,
      retryBackoffHours: [1, 6, 24],
      retryTtlHours: 72,
      lane: "submit",
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

  it("extraction_insufficient (no source text)", async () => {
    const url = "https://example.com/no-source";

    await runSubmitUrl(url);
    const postsA = await db.select().from(posts);
    const pubsA = await db.select().from(postPublications);
    const retryA = await db.select().from(postRetryQueue);
    const removalsA = await db.select().from(postRemovals);

    await setupTestDb();
    fetchOEmbedMock.mockImplementation((u: string) => Promise.resolve(oembedFor(u)));

    const adapter = new SubmitAdapter();
    const candidates = await adapter.buildCandidates([url]);
    await runPipelineOnCandidates(candidates, adapter, {
      curationBudget: 10,
      dailyPublishCap: 150,
      jstDayStartIso: "2024-01-01T00:00:00.000Z",
      curationSignature: computeCurationSignature(),
      retryMaxAttempts: RETRY_MAX_ATTEMPTS,
      retryBackoffHours: [1, 6, 24],
      retryTtlHours: 72,
      lane: "submit",
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
    const url = "https://www.youtube.com/watch?v=fail-llm";

    await db.insert(postRetryQueue).values({
      urlHash: hashUrl(url),
      url,
      host: "www.youtube.com",
      lane: "submit",
      reason: "llm_transient",
      attempts: RETRY_MAX_ATTEMPTS,
      firstQueuedAt: "2023-12-31T00:00:00.000Z",
      nextAttemptAt: "2023-12-31T12:00:00.000Z",
      expiresAt: "2024-01-31T00:00:00.000Z",
    });

    await runSubmitUrl(url, undefined, {
      urlHash: hashUrl(url),
      attempts: RETRY_MAX_ATTEMPTS,
      firstQueuedAt: "2023-12-31T00:00:00.000Z",
    });
    const postsA = await db.select().from(posts);
    const pubsA = await db.select().from(postPublications);
    const retryA = await db.select().from(postRetryQueue);
    const removalsA = await db.select().from(postRemovals);

    await setupTestDb();
    fetchOEmbedMock.mockImplementation((u: string) => Promise.resolve(oembedFor(u)));
    await db.insert(postRetryQueue).values({
      urlHash: hashUrl(url),
      url,
      host: "www.youtube.com",
      lane: "submit",
      reason: "llm_transient",
      attempts: RETRY_MAX_ATTEMPTS,
      firstQueuedAt: "2023-12-31T00:00:00.000Z",
      nextAttemptAt: "2023-12-31T12:00:00.000Z",
      expiresAt: "2024-01-31T00:00:00.000Z",
    });

    const adapter = new SubmitAdapter();
    const candidates = await adapter.fetchDueRetries("2024-01-01T00:00:00.000Z");
    expect(candidates.length).toBe(1);

    await runPipelineOnCandidates(candidates, adapter, {
      curationBudget: 10,
      dailyPublishCap: 150,
      jstDayStartIso: "2024-01-01T00:00:00.000Z",
      curationSignature: computeCurationSignature(),
      retryMaxAttempts: RETRY_MAX_ATTEMPTS,
      retryBackoffHours: [1, 6, 24],
      retryTtlHours: 72,
      lane: "submit",
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

    await runSubmitUrl(url);
    const postsA = await db.select().from(posts);
    const pubsA = await db.select().from(postPublications);
    const retryA = await db.select().from(postRetryQueue);
    const removalsA = await db.select().from(postRemovals);

    await setupTestDb();
    fetchOEmbedMock.mockImplementation((u: string) => Promise.resolve(oembedFor(u)));

    const adapter = new SubmitAdapter();
    const candidates = await adapter.buildCandidates([url]);
    await runPipelineOnCandidates(candidates, adapter, {
      curationBudget: 10,
      dailyPublishCap: 150,
      jstDayStartIso: "2024-01-01T00:00:00.000Z",
      curationSignature: computeCurationSignature(),
      retryMaxAttempts: RETRY_MAX_ATTEMPTS,
      retryBackoffHours: [1, 6, 24],
      retryTtlHours: 72,
      lane: "submit",
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
