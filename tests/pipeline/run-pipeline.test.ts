/**
 * Purpose: Unit tests for the unified runPipeline orchestrator.
 * When called: Vitest execution suite.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  runPipeline,
  type PipelineAdapter,
  type PipelineOptions,
} from "@/lib/pipeline/run-pipeline";

const {
  upsertPostsMock,
  markCuratedMock,
  getPostsByUrlsMock,
  markDroppedMock,
  filterRemovedMock,
  enqueueRetryMock,
  recordPublicationMock,
  countPublishedSinceMock,
  curatePostsMock,
} = vi.hoisted(() => ({
  upsertPostsMock: vi.fn(),
  markCuratedMock: vi.fn(),
  getPostsByUrlsMock: vi.fn(),
  markDroppedMock: vi.fn(),
  filterRemovedMock: vi.fn(),
  enqueueRetryMock: vi.fn(),
  recordPublicationMock: vi.fn(),
  countPublishedSinceMock: vi.fn(),
  curatePostsMock: vi.fn(),
}));

vi.mock("@/lib/db/repository", () => ({
  upsertPosts: upsertPostsMock,
  markCurated: markCuratedMock,
  getPostsByUrls: getPostsByUrlsMock,
  markDropped: markDroppedMock,
  filterRemoved: filterRemovedMock,
  enqueueRetry: enqueueRetryMock,
  recordPublication: recordPublicationMock,
  countPublishedSince: countPublishedSinceMock,
  hashUrl: (url: string) => `hash:${url}`,
}));

vi.mock("@/lib/llm/batch", () => ({
  curatePosts: curatePostsMock,
}));

describe("runPipeline (src/lib/pipeline/run-pipeline.ts)", () => {
  let adapter: PipelineAdapter;
  let options: PipelineOptions;

  beforeEach(() => {
    vi.clearAllMocks();

    adapter = {
      fetchCandidates: vi.fn().mockResolvedValue([
        {
          url: "https://example.com/post-1",
          originalTitle: "Test Title 1",
          originalExcerpt: "Test Excerpt 1",
          sourceType: "blog",
          sourceId: "src-1",
          sourceName: "Source 1",
          publishedAt: "2026-08-31T00:00:00Z",
        },
      ]),
      fetchDueRetries: vi.fn().mockResolvedValue([]),
      onTransientFailure: vi.fn().mockResolvedValue(false),
      onTerminalDrop: vi.fn().mockResolvedValue(undefined),
      buildFeedCard: vi.fn().mockResolvedValue({}),
    };

    options = {
      curationBudget: 10,
      dailyPublishCap: 150,
      jstDayStartIso: "2026-08-30T15:00:00Z",
      curationSignature: "sig-test",
      retryMaxAttempts: 3,
      retryBackoffHours: [1, 2, 4],
      retryTtlHours: 24,
      lane: "rss",
      enforceRemovedFilter: true,
      enforceRateCap: true,
      onComplete: vi.fn().mockResolvedValue(undefined),
    };

    upsertPostsMock.mockResolvedValue({
      succeeded: ["https://example.com/post-1"],
      failed: [],
    });

    getPostsByUrlsMock.mockResolvedValue(
      new Map([
        [
          "https://example.com/post-1",
          {
            id: 101,
            originalTitle: "Test Title 1",
            originalExcerpt: "Test Excerpt 1",
            contentHash: "old-hash",
            curationSignature: "old-sig",
            aiTitle: null,
          },
        ],
      ]),
    );

    filterRemovedMock.mockResolvedValue(new Set());
    countPublishedSinceMock.mockResolvedValue(0);

    curatePostsMock.mockResolvedValue({
      results: [
        {
          title: "AI Title",
          summary: "AI Summary",
          category: "会場・費用",
          tag: "classic",
          firsthand: true,
          ceremonyDecision: true,
          specific: true,
          weddingDayContent: false,
          promotional: "none",
          topicAnchor: "Test Title 1",
          rationaleText: "十分な体験に基づく具体的な考察が含まれており有用であると判断される",
        },
      ],
      geminiCalls: 1,
    });

    markCuratedMock.mockResolvedValue({
      succeeded: ["https://example.com/post-1"],
      failed: [],
    });
  });

  it("successfully runs happy path: fetch, dedupe, upsert, curate, gates, publication", async () => {
    const summary = await runPipeline(adapter, options);

    expect(summary.fetched).toBe(1);
    expect(summary.inserted).toBe(1);
    expect(summary.curated).toBe(1);
    expect(summary.geminiCalls).toBe(1);
    expect(summary.stageCounts.published).toBe(1);
    expect(summary.stageCounts.evidenceGatePassed).toBe(1);
    expect(summary.stageCounts.titleGatePassed).toBe(1);
    expect(summary.stageCounts.rateCapPassed).toBe(1);

    expect(recordPublicationMock).toHaveBeenCalledWith(
      101,
      expect.any(String),
      expect.any(String),
      "surrogate",
    );
  });

  it("handles duplicate URLs via canonicalization and deduplication", async () => {
    (adapter.fetchCandidates as any).mockResolvedValue([
      {
        url: "https://example.com/post-1?utm_source=test",
        originalTitle: "Test Title 1",
        originalExcerpt: "Test Excerpt 1",
        sourceType: "blog",
        sourceId: "src-1",
        sourceName: "Source 1",
        publishedAt: null,
      },
      {
        url: "https://example.com/post-1",
        originalTitle: "Test Title 1",
        originalExcerpt: "Test Excerpt 1",
        sourceType: "blog",
        sourceId: "src-1",
        sourceName: "Source 1",
        publishedAt: null,
      },
    ]);

    const summary = await runPipeline(adapter, options);
    expect(summary.fetched).toBe(2);
    expect(summary.stageCounts.deduped).toBe(1);
  });

  it("drops candidates with insufficient excerpt (Evidence Gate / Q1)", async () => {
    (adapter.fetchCandidates as any).mockResolvedValue([
      {
        url: "https://example.com/post-no-excerpt",
        originalTitle: "No Excerpt",
        originalExcerpt: "",
        sourceType: "blog",
        sourceId: "src-1",
        sourceName: "Source 1",
        publishedAt: null,
      },
    ]);

    getPostsByUrlsMock.mockResolvedValue(
      new Map([
        [
          "https://example.com/post-no-excerpt",
          {
            id: 101,
            originalTitle: "No Excerpt",
            originalExcerpt: "",
            contentHash: "old",
            curationSignature: "old",
            aiTitle: null,
          },
        ],
      ]),
    );

    const summary = await runPipeline(adapter, options);
    expect(summary.curated).toBe(0);
    expect(summary.stageCounts.evidenceGatePassed).toBe(0);
    expect(summary.stageCounts.dropped["extraction_insufficient"]).toBe(1);
    expect(markDroppedMock).toHaveBeenCalledWith(
      101,
      "extraction_insufficient",
      expect.any(String),
    );
    expect(adapter.onTerminalDrop).toHaveBeenCalled();
  });

  it("drops candidates failing Title Gate (M1-1)", async () => {
    const badTitle = "!!!!!!!!!"; // triggers SYMBOL_REPEAT_RE
    (adapter.fetchCandidates as any).mockResolvedValue([
      {
        url: "https://example.com/post-bad-title",
        originalTitle: badTitle,
        originalExcerpt: "Excerpt here",
        sourceType: "blog",
        sourceId: "src-1",
        sourceName: "Source 1",
        publishedAt: null,
      },
    ]);

    getPostsByUrlsMock.mockResolvedValue(
      new Map([
        [
          "https://example.com/post-bad-title",
          {
            id: 102,
            originalTitle: badTitle,
            originalExcerpt: "Excerpt here",
            contentHash: "old",
            curationSignature: "old",
            aiTitle: null,
          },
        ],
      ]),
    );

    upsertPostsMock.mockResolvedValue({
      succeeded: ["https://example.com/post-bad-title"],
      failed: [],
    });

    curatePostsMock.mockResolvedValue({
      results: [
        {
          title: "AI Title",
          summary: "AI Summary",
          category: "会場・費用",
          tag: "classic",
          firsthand: true,
          ceremonyDecision: true,
          specific: true,
          weddingDayContent: false,
          promotional: "none",
          topicAnchor: badTitle,
          rationaleText: "十分な体験に基づく具体的な考察が含まれており有用であると判断される",
        },
      ],
      geminiCalls: 1,
    });

    const summary = await runPipeline(adapter, options);
    expect(summary.curated).toBe(0);
    expect(summary.stageCounts.titleGatePassed).toBe(0);
    expect(summary.stageCounts.dropped["title_filter"]).toBe(1);
    expect(markDroppedMock).toHaveBeenCalledWith(102, "title_filter", expect.any(String));
  });

  it("enqueues retry when LLM call fails temporarily (Transient Failure)", async () => {
    curatePostsMock.mockResolvedValue({
      results: [null],
      geminiCalls: 0,
    });

    const summary = await runPipeline(adapter, options);
    expect(summary.curated).toBe(0);
    expect(summary.stageCounts.retried).toBe(1);
    expect(enqueueRetryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: "rss",
        reason: "llm_transient",
        attempts: 1,
      }),
    );

    // TTL は hours 単位で足し上げる（legacy ingest.ts:201 の
    // addHoursIso(firstQueuedAt, RETRY_TTL_HOURS) と同規則）
    const entry = enqueueRetryMock.mock.calls[0][0];
    expect(entry.urlHash).toBe(`hash:${entry.url}`);
    expect(Date.parse(entry.nextAttemptAt) - Date.parse(entry.firstQueuedAt)).toBeLessThanOrEqual(
      options.retryBackoffHours[0] * 3600 * 1000,
    );
    expect(Date.parse(entry.expiresAt) - Date.parse(entry.firstQueuedAt)).toBe(
      options.retryTtlHours * 3600 * 1000,
    );
  });

  it("respects daily publish cap (Rate Cap / Q4)", async () => {
    countPublishedSinceMock.mockResolvedValue(150);
    const summary = await runPipeline(adapter, options);

    expect(summary.curated).toBe(0);
    expect(summary.stageCounts.rateCapPassed).toBe(0);
    expect(summary.stageCounts.retried).toBe(1);
    expect(enqueueRetryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: "rss",
        reason: "rate_capped",
        attempts: 1,
      }),
    );
  });

  it("calls onComplete with summary", async () => {
    await runPipeline(adapter, options);
    expect(options.onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        fetched: 1,
        curated: 1,
      }),
    );
  });
});
