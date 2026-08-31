/**
 * Purpose: Unit tests for the shared rss/evergreen/submit retry-queue runner
 * (Stage 6 S2 Commit 3, shared_plan/17). This is the safety net for the
 * table-driven lane→adapter registry and the shared-limit due-retry pass,
 * since tests/pipeline-ingest.test.ts exercises this only through runIngest.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const { dueRetriesMock, expireRetriesMock } = vi.hoisted(() => ({
  dueRetriesMock: vi.fn(),
  expireRetriesMock: vi.fn(),
}));

vi.mock("@/lib/db/publication", () => ({
  dueRetries: dueRetriesMock,
  expireRetries: expireRetriesMock,
}));

const { terminateRetryMock, runPipelineOnCandidatesMock } = vi.hoisted(() => ({
  terminateRetryMock: vi.fn().mockResolvedValue(undefined),
  runPipelineOnCandidatesMock: vi.fn().mockResolvedValue({ errors: [] }),
}));

vi.mock("@/lib/pipeline/run-pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pipeline/run-pipeline")>();
  return {
    ...actual,
    terminateRetry: terminateRetryMock,
    runPipelineOnCandidates: runPipelineOnCandidatesMock,
  };
});

const {
  rssBuildRetryCandidateMock,
  evergreenBuildRetryCandidateMock,
  submitBuildRetryCandidateMock,
} = vi.hoisted(() => ({
  rssBuildRetryCandidateMock: vi.fn(),
  evergreenBuildRetryCandidateMock: vi.fn(),
  submitBuildRetryCandidateMock: vi.fn(),
}));

vi.mock("@/lib/pipeline/adapters/rss-adapter", () => ({
  RssAdapter: vi.fn().mockImplementation(function RssAdapter(this: Record<string, unknown>) {
    this.__lane = "rss";
    this.buildRetryCandidate = rssBuildRetryCandidateMock;
  }),
}));
vi.mock("@/lib/pipeline/adapters/evergreen-adapter", () => ({
  EvergreenAdapter: vi
    .fn()
    .mockImplementation(function EvergreenAdapter(this: Record<string, unknown>) {
      this.__lane = "evergreen";
      this.buildRetryCandidate = evergreenBuildRetryCandidateMock;
    }),
}));
vi.mock("@/lib/pipeline/adapters/submit-adapter", () => ({
  SubmitAdapter: vi.fn().mockImplementation(function SubmitAdapter(this: Record<string, unknown>) {
    this.__lane = "submit";
    this.buildRetryCandidate = submitBuildRetryCandidateMock;
  }),
}));

import { processDueAndExpiredRetries } from "@/lib/pipeline/retry-runner";
import type { RetryQueueEntry } from "@/lib/types";

function makeEntry(overrides: Partial<RetryQueueEntry> = {}): RetryQueueEntry {
  return {
    urlHash: "hash-1",
    url: "https://example.com/post",
    host: "example.com",
    lane: "rss",
    reason: "llm_transient",
    attempts: 1,
    firstQueuedAt: "2026-08-30T00:00:00Z",
    nextAttemptAt: "2026-08-31T00:00:00Z",
    expiresAt: "2026-09-05T00:00:00Z",
    ...overrides,
  };
}

const NOW = "2026-08-31T00:00:00Z";

describe("processDueAndExpiredRetries (src/lib/pipeline/retry-runner.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dueRetriesMock.mockResolvedValue([]);
    expireRetriesMock.mockResolvedValue([]);
    rssBuildRetryCandidateMock.mockResolvedValue(null);
    evergreenBuildRetryCandidateMock.mockResolvedValue(null);
    submitBuildRetryCandidateMock.mockResolvedValue(null);
    runPipelineOnCandidatesMock.mockResolvedValue({ errors: [] });
  });

  it("calls expireRetries before dueRetries (TTL termination must not be reprocessed as due)", async () => {
    const callOrder: string[] = [];
    expireRetriesMock.mockImplementation(async () => {
      callOrder.push("expire");
      return [];
    });
    dueRetriesMock.mockImplementation(async () => {
      callOrder.push("due");
      return [];
    });

    await processDueAndExpiredRetries(NOW);

    expect(callOrder).toEqual(["expire", "due"]);
  });

  it("requests dueRetries once with the shared RETRY_PROCESS_LIMIT across all lanes (not a per-lane budget)", async () => {
    dueRetriesMock.mockResolvedValue([
      makeEntry({ lane: "rss", urlHash: "h1", url: "https://example.com/1" }),
      makeEntry({ lane: "evergreen", urlHash: "h2", url: "https://example.com/2" }),
      makeEntry({ lane: "submit", urlHash: "h3", url: "https://example.com/3" }),
    ]);
    rssBuildRetryCandidateMock.mockResolvedValue({ url: "https://example.com/1" });
    evergreenBuildRetryCandidateMock.mockResolvedValue({ url: "https://example.com/2" });
    submitBuildRetryCandidateMock.mockResolvedValue({ url: "https://example.com/3" });

    await processDueAndExpiredRetries(NOW);

    expect(dueRetriesMock).toHaveBeenCalledTimes(1);
    expect(dueRetriesMock).toHaveBeenCalledWith(NOW, 50);
    // Each lane's adapter should only see its own entries.
    expect(rssBuildRetryCandidateMock).toHaveBeenCalledTimes(1);
    expect(evergreenBuildRetryCandidateMock).toHaveBeenCalledTimes(1);
    expect(submitBuildRetryCandidateMock).toHaveBeenCalledTimes(1);
    // runPipelineOnCandidates should be invoked once per lane that has entries.
    expect(runPipelineOnCandidatesMock).toHaveBeenCalledTimes(3);
  });

  it("does not touch discovery-lane entries returned by dueRetries or expireRetries", async () => {
    dueRetriesMock.mockResolvedValue([
      makeEntry({ lane: "discovery", urlHash: "d1", url: "https://example.com/d1" }),
    ]);
    expireRetriesMock.mockResolvedValue([
      makeEntry({ lane: "discovery", urlHash: "d2", url: "https://example.com/d2" }),
    ]);

    await processDueAndExpiredRetries(NOW);

    expect(rssBuildRetryCandidateMock).not.toHaveBeenCalled();
    expect(evergreenBuildRetryCandidateMock).not.toHaveBeenCalled();
    expect(submitBuildRetryCandidateMock).not.toHaveBeenCalled();
    expect(terminateRetryMock).not.toHaveBeenCalled();
    expect(runPipelineOnCandidatesMock).not.toHaveBeenCalled();
  });

  it("continues processing other due entries when one entry's candidate-building throws, and records the error", async () => {
    dueRetriesMock.mockResolvedValue([
      makeEntry({ lane: "rss", urlHash: "h1", url: "https://example.com/1" }),
      makeEntry({ lane: "rss", urlHash: "h2", url: "https://example.com/2" }),
    ]);
    rssBuildRetryCandidateMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ url: "https://example.com/2" });

    const { errors } = await processDueAndExpiredRetries(NOW);

    expect(rssBuildRetryCandidateMock).toHaveBeenCalledTimes(2);
    expect(errors.some((e) => e.includes("boom"))).toBe(true);
    // The surviving candidate still reaches the pipeline core.
    expect(runPipelineOnCandidatesMock).toHaveBeenCalledTimes(1);
    const [candidatesArg] = runPipelineOnCandidatesMock.mock.calls[0];
    expect(candidatesArg).toEqual([{ url: "https://example.com/2" }]);
  });

  it("continues processing other expired entries when one entry's termination throws, and records the error", async () => {
    expireRetriesMock.mockResolvedValue([
      makeEntry({ lane: "rss", urlHash: "h1", url: "https://example.com/1" }),
      makeEntry({ lane: "evergreen", urlHash: "h2", url: "https://example.com/2" }),
    ]);
    terminateRetryMock
      .mockRejectedValueOnce(new Error("terminate boom"))
      .mockResolvedValueOnce(undefined);

    const { errors } = await processDueAndExpiredRetries(NOW);

    expect(terminateRetryMock).toHaveBeenCalledTimes(2);
    expect(errors.some((e) => e.includes("terminate boom"))).toBe(true);
  });
});
