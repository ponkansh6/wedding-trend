/**
 * Purpose: Plan 17 S2 fixup. `runPipelineOnCandidates` の終端棄却パス
 * （removed / extraction_insufficient / title_filter）が、再試行キュー由来の
 * 候補（`candidate.retry` あり）に対して `completeRetry` を呼び、キュー行を
 * 削除することを検証する。呼ばないと `attempts`/`nextAttemptAt` が更新
 * されないまま due が恒久化し、cron のたびに無駄な再処理（title_filter は
 * LLM 呼び出し後に落ちるため特に高コスト）が発生するゾンビ行になる
 * （`src/lib/pipeline/run-pipeline.ts` の `completeRetryIfQueued`）。
 *
 * `tests/pipeline/invariants.test.ts` の実体注入パターン（curatePosts は
 * モックしない。`@/lib/llm/client` の `callGemini` のみ差し替える）を踏襲する。
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  runPipelineOnCandidates,
  type PipelineAdapter,
  type PipelineCandidate,
  type PipelineOptions,
} from "@/lib/pipeline/run-pipeline";
import type { RetryContext } from "@/lib/types";

const {
  upsertPostsMock,
  markCuratedMock,
  getPostsByUrlsMock,
  markDroppedMock,
  filterRemovedMock,
  enqueueRetryMock,
  recordPublicationMock,
  countPublishedSinceMock,
  completeRetryMock,
  callGeminiMock,
} = vi.hoisted(() => ({
  upsertPostsMock: vi.fn(),
  markCuratedMock: vi.fn(),
  getPostsByUrlsMock: vi.fn(),
  markDroppedMock: vi.fn(),
  filterRemovedMock: vi.fn(),
  enqueueRetryMock: vi.fn(),
  recordPublicationMock: vi.fn(),
  countPublishedSinceMock: vi.fn(),
  completeRetryMock: vi.fn(),
  callGeminiMock: vi.fn(),
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
  completeRetry: completeRetryMock,
  hashUrl: (url: string) => `hash:${url}`,
  saveEmbed: vi.fn(),
  withDropReasonDetail: (base: string, detail?: string | null) =>
    detail ? `${base}:${detail}` : base,
}));

vi.mock("@/lib/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/client")>();
  return {
    ...actual,
    callGemini: callGeminiMock,
  };
});

function geminiResponse(topicAnchor: string, overrides: Partial<Record<string, unknown>> = {}) {
  return JSON.stringify({
    items: [
      {
        index: 1,
        title: "AI生成タイトル",
        summary:
          "十分な文字数を満たすダミーの要約文です。テストのためだけに用意した固定文言であり内容に意味はありません。文字数を稼ぐための追加文もここに付け足します。",
        category: "演出・進行",
        tag: "classic",
        firsthand: 9,
        ceremonyDecision: 9,
        specific: 9,
        weddingDayContent: 0,
        promotional: 0,
        topicAnchor,
        topics: ["トピック1", "トピック2"],
        ...overrides,
      },
    ],
  });
}

function makeRetryContext(overrides: Partial<RetryContext> = {}): RetryContext {
  return {
    urlHash: "hash:retry-candidate",
    attempts: 1,
    firstQueuedAt: "2026-08-25T00:00:00Z",
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<PipelineCandidate> = {}): PipelineCandidate {
  return {
    url: "https://example.com/retry-candidate",
    originalTitle: "テストタイトル",
    originalExcerpt: "本文抜粋テキストです。",
    sourceType: "blog",
    sourceId: "src-1",
    sourceName: "Source 1",
    publishedAt: "2026-08-31T00:00:00Z",
    retry: makeRetryContext(),
    ...overrides,
  };
}

function makeAdapter(): PipelineAdapter {
  return {
    fetchCandidates: vi.fn().mockResolvedValue([]),
    fetchDueRetries: vi.fn().mockResolvedValue([]),
    buildRetryCandidate: vi.fn().mockResolvedValue(null),
    onTransientFailure: vi.fn().mockResolvedValue(false),
    ensureTombstonePost: vi.fn().mockResolvedValue(null),
    onTerminalDrop: vi.fn().mockResolvedValue(undefined),
    buildFeedCard: vi.fn().mockResolvedValue({}),
  };
}

function makeOptions(overrides: Partial<PipelineOptions> = {}): PipelineOptions {
  return {
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
    ...overrides,
  };
}

function stateFor(id: number, candidate: PipelineCandidate) {
  return new Map([
    [
      candidate.url,
      {
        id,
        originalTitle: candidate.originalTitle,
        originalExcerpt: candidate.originalExcerpt,
        contentHash: "old-hash",
        curationSignature: "old-sig",
        aiTitle: null,
      },
    ],
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  upsertPostsMock.mockImplementation(async (inputs: { url: string }[]) => ({
    succeeded: inputs.map((i) => i.url),
    failed: [],
  }));
  filterRemovedMock.mockResolvedValue(new Set());
  countPublishedSinceMock.mockResolvedValue(0);
  markCuratedMock.mockImplementation(async (updates: { url: string }[]) => ({
    succeeded: updates.map((u) => u.url),
    failed: [],
  }));
});

describe("再試行キュー由来候補の終端棄却でキュー行が削除される", () => {
  it("title_filter: completeRetry が候補の urlHash で呼ばれる", async () => {
    const candidate = makeCandidate({
      url: "https://example.com/retry-title-filter",
      originalTitle: "！！！！ 違法", // INV-1 の同一記号4連続で title_filter に落ちる
      retry: makeRetryContext({ urlHash: "hash:retry-title-filter", attempts: 2 }),
    });
    getPostsByUrlsMock.mockResolvedValue(stateFor(301, candidate));
    callGeminiMock.mockResolvedValue(geminiResponse("結婚式当日の進行と演出の工夫"));

    const summary = await runPipelineOnCandidates([candidate], makeAdapter(), makeOptions());

    expect(summary.stageCounts.dropped["title_filter"]).toBe(1);
    expect(completeRetryMock).toHaveBeenCalledWith("hash:retry-title-filter");
    // enqueueRetry（バックオフの再登録）は呼ばれてはならない: 終端棄却であって
    // 一時失敗の再試行ではないため。
    expect(enqueueRetryMock).not.toHaveBeenCalled();
  });

  it("extraction_insufficient: completeRetry が候補の urlHash で呼ばれる", async () => {
    const candidate = makeCandidate({
      url: "https://example.com/retry-extraction",
      originalExcerpt: "", // evidence gate で落ちる
      retry: makeRetryContext({ urlHash: "hash:retry-extraction", attempts: 1 }),
    });
    getPostsByUrlsMock.mockResolvedValue(stateFor(302, candidate));

    const summary = await runPipelineOnCandidates([candidate], makeAdapter(), makeOptions());

    expect(summary.stageCounts.dropped["extraction_insufficient"]).toBe(1);
    expect(completeRetryMock).toHaveBeenCalledWith("hash:retry-extraction");
    expect(enqueueRetryMock).not.toHaveBeenCalled();
    // evidence gate は originalExcerpt のみで判定するため Gemini は一度も呼ばれない。
    expect(callGeminiMock).not.toHaveBeenCalled();
  });

  it("removed: completeRetry が候補の urlHash で呼ばれる", async () => {
    const candidate = makeCandidate({
      url: "https://example.com/retry-removed",
      retry: makeRetryContext({ urlHash: "hash:retry-removed", attempts: 3 }),
    });
    getPostsByUrlsMock.mockResolvedValue(stateFor(303, candidate));
    filterRemovedMock.mockResolvedValue(new Set([303]));

    const summary = await runPipelineOnCandidates([candidate], makeAdapter(), makeOptions());

    expect(summary.stageCounts.dropped["removed"]).toBe(1);
    expect(completeRetryMock).toHaveBeenCalledWith("hash:retry-removed");
    expect(enqueueRetryMock).not.toHaveBeenCalled();
    expect(callGeminiMock).not.toHaveBeenCalled();
  });

  // レーン横断の回帰テスト。掃除がコア（レーン非依存）で行われることを固定する。
  // 実際に修正したバグは「RSS だけ掃除され、evergreen / submit にゾンビが残る」
  // というレーン限定の欠陥だった。lane を固定したテストだけでは、同型の退行を
  // 入れても1件も落ちないことを変異テストで確認したため、3レーンを回す。
  it.each(["rss", "evergreen"] as const)(
    "%s レーン: title_filter の終端棄却でキュー行が掃除される（レーン非依存）",
    async (lane) => {
      const candidate = makeCandidate({
        url: `https://example.com/retry-lane-${lane}`,
        originalTitle: "！！！！ 違法",
        retry: makeRetryContext({ urlHash: `hash:lane-${lane}`, attempts: 2 }),
      });
      getPostsByUrlsMock.mockResolvedValue(stateFor(401, candidate));
      callGeminiMock.mockResolvedValue(geminiResponse("結婚式当日の進行と演出の工夫"));

      const summary = await runPipelineOnCandidates(
        [candidate],
        makeAdapter(),
        makeOptions({ lane }),
      );

      expect(summary.stageCounts.dropped["title_filter"]).toBe(1);
      expect(completeRetryMock).toHaveBeenCalledWith(`hash:lane-${lane}`);
      expect(enqueueRetryMock).not.toHaveBeenCalled();
    },
  );

  it("初回候補（candidate.retry が undefined）では completeRetry は呼ばれない", async () => {
    const candidate = makeCandidate({
      url: "https://example.com/fresh-title-filter",
      originalTitle: "！！！！ 違法",
      retry: undefined,
    });
    getPostsByUrlsMock.mockResolvedValue(stateFor(304, candidate));
    callGeminiMock.mockResolvedValue(geminiResponse("結婚式当日の進行と演出の工夫"));

    const summary = await runPipelineOnCandidates([candidate], makeAdapter(), makeOptions());

    expect(summary.stageCounts.dropped["title_filter"]).toBe(1);
    expect(completeRetryMock).not.toHaveBeenCalled();
  });
});
