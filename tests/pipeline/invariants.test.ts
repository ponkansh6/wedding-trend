/**
 * Purpose: Stage 6 (S2) Commit 1 の安全網。`src/lib/publish/invariants.ts` の
 * INVARIANTS レジストリに列挙された各 id を、`runPipelineOnCandidates`
 * （INV-4 は構造上パイプラインを通せないため対象関数を直接）を通した
 * 「境界」で検証する。`filterTitle` 等のヘルパを直接呼ぶのではなく、公開
 * されるかどうか・drop reason が期待値かどうかという境界の結果でアサート
 * することで、ヘルパのリファクタで強制が薄れてもテストが赤くなるようにする。
 *
 * 既存 tests/pipeline/run-pipeline.test.ts と異なり、`@/lib/llm/batch` は
 * モックしない（実体を通す）。かわりに `@/lib/llm/client` の `callGemini` を
 * モックして Gemini 応答 JSON を差し替える。これにより topicAnchor の
 * gate（`validateTopicAnchor` = INV-2/INV-3）が実際に発火する経路をテストできる
 * （旧来のように curatePosts そのものをモックすると、gate ロジックがテストを
 * 一切通らずに常にグリーンになってしまうため）。
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  runPipelineOnCandidates,
  type PipelineAdapter,
  type PipelineCandidate,
  type PipelineOptions,
} from "@/lib/pipeline/run-pipeline";
import { renderRationaleText } from "@/lib/publish/gate";
import { RATIONALE_TEXT_MAX_CHARS, RATIONALE_TEXT_MIN_CHARS } from "@/lib/constants";
import { INVARIANTS } from "@/lib/publish/invariants";
import { assertNoSliceLeak } from "../../scripts/lib/mwed-anchor-backfill.mjs";

// scripts/lib/mwed-anchor-backfill.mjs は素の JS（.mjs）。テスト内だけの最小 shape。
type TestUpdate = Record<string, unknown> & { url: string };

const {
  upsertPostsMock,
  markCuratedMock,
  getPostsByUrlsMock,
  markDroppedMock,
  filterRemovedMock,
  enqueueRetryMock,
  recordPublicationMock,
  countPublishedSinceMock,
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
  hashUrl: (url: string) => `hash:${url}`,
  saveEmbed: vi.fn(),
  withDropReasonDetail: (base: string, detail?: string | null) =>
    detail ? `${base}:${detail}` : base,
}));

// 実体の curatePosts/curateBatch/validateTopicAnchor を通し、Gemini 呼び出しだけ
// 差し替える（INV-2/INV-3 は curatePosts 内部の gate 発火なので、curatePosts
// 自体をモックすると検証にならない）。
vi.mock("@/lib/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/client")>();
  return {
    ...actual,
    callGemini: callGeminiMock,
  };
});

/** CurationBatchResponseSchema を満たす最小限の1件応答 JSON を組み立てる。 */
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

function makeCandidate(overrides: Partial<PipelineCandidate> = {}): PipelineCandidate {
  return {
    url: "https://example.com/post-1",
    originalTitle: "テストタイトル",
    originalExcerpt: "本文抜粋テキストです。",
    sourceType: "blog",
    sourceId: "src-1",
    sourceName: "Source 1",
    publishedAt: "2026-08-31T00:00:00Z",
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

// ─────────────────────────────────────────────────────────────
// メタテスト: INVARIANTS の全 id に対応する describe が存在すること
// ─────────────────────────────────────────────────────────────

const testedInvariantIds = new Set<string>();

/** `describe(id + ": ...")` の代わりにこれを使い、テスト済み id を記録する。 */
function describeInvariant(id: string, title: string, fn: () => void) {
  testedInvariantIds.add(id);
  describe(`${id}: ${title}`, fn);
}

describe("INVARIANTS メタテスト", () => {
  it("レジストリの全 id に対応する describe(INV-N: ...) が本ファイルに存在する", () => {
    // このテスト自体が実行される時点で、下の describeInvariant 呼び出しは
    // すべてモジュール読み込み時に評価済み（describe はコレクションフェーズで
    // 同期実行される）ため、ここで比較できる。
    const registryIds = INVARIANTS.map((inv) => inv.id).sort();
    const testedIds = Array.from(testedInvariantIds).sort();
    expect(testedIds).toEqual(registryIds);
  });
});

// ─────────────────────────────────────────────────────────────
// INV-1: タイトルの機械的フィルタ
// ─────────────────────────────────────────────────────────────

describeInvariant("INV-1", "タイトルの機械的フィルタ", () => {
  it("同一記号3連続のタイトルは公開される（ぎりぎり通る）", async () => {
    const candidate = makeCandidate({
      url: "https://example.com/inv1-pass",
      originalTitle: "！！！ 違法",
    });
    getPostsByUrlsMock.mockResolvedValue(stateFor(201, candidate));
    callGeminiMock.mockResolvedValue(geminiResponse("結婚式当日の進行と演出の工夫"));

    const summary = await runPipelineOnCandidates([candidate], makeAdapter(), makeOptions());

    expect(summary.stageCounts.titleGatePassed).toBe(1);
    expect(summary.stageCounts.published).toBe(1);
    expect(summary.stageCounts.dropped["title_filter"]).toBeUndefined();
  });

  it("同一記号4連続のタイトルは title_filter で非公開になる（ぎりぎり落ちる）", async () => {
    const candidate = makeCandidate({
      url: "https://example.com/inv1-fail",
      originalTitle: "！！！！ 違法",
    });
    getPostsByUrlsMock.mockResolvedValue(stateFor(202, candidate));
    callGeminiMock.mockResolvedValue(geminiResponse("結婚式当日の進行と演出の工夫"));

    const summary = await runPipelineOnCandidates([candidate], makeAdapter(), makeOptions());

    expect(summary.stageCounts.titleGatePassed).toBe(0);
    expect(summary.stageCounts.published).toBe(0);
    expect(summary.stageCounts.dropped["title_filter"]).toBe(1);
    expect(markDroppedMock).toHaveBeenCalledWith(202, "title_filter", expect.any(String));
  });

  it("絵文字10個のタイトルは公開される、11個は title_filter で非公開になる", async () => {
    // 同一記号連打ゲート（4連続以上, INV-1 の別ケース）と混線しないよう、
    // 絵文字は3個ずつ異なる文字を混ぜて構成する（同一文字の4連続は作らない）。
    const emojiVariants = ["🎉", "💐", "👰", "🤵", "💍", "🎊", "🥂", "📸", "💒", "🎁", "💐"];
    const passCandidate = makeCandidate({
      url: "https://example.com/inv1-emoji-pass",
      originalTitle: `結婚式レポ${emojiVariants.slice(0, 10).join("")}`,
    });
    getPostsByUrlsMock.mockResolvedValue(stateFor(203, passCandidate));
    callGeminiMock.mockResolvedValue(geminiResponse("結婚式当日の進行と演出の工夫"));
    const passSummary = await runPipelineOnCandidates(
      [passCandidate],
      makeAdapter(),
      makeOptions(),
    );
    expect(passSummary.stageCounts.titleGatePassed).toBe(1);

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

    const failCandidate = makeCandidate({
      url: "https://example.com/inv1-emoji-fail",
      originalTitle: `結婚式レポ${emojiVariants.slice(0, 11).join("")}`,
    });
    getPostsByUrlsMock.mockResolvedValue(stateFor(204, failCandidate));
    callGeminiMock.mockResolvedValue(geminiResponse("結婚式当日の進行と演出の工夫"));
    const failSummary = await runPipelineOnCandidates(
      [failCandidate],
      makeAdapter(),
      makeOptions(),
    );
    expect(failSummary.stageCounts.dropped["title_filter"]).toBe(1);
    expect(markDroppedMock).toHaveBeenCalledWith(204, "title_filter", expect.any(String));
  });

  it("2字以上のタイトルは公開される、1字のタイトルは title_filter で非公開になる", async () => {
    const passCandidate = makeCandidate({
      url: "https://example.com/inv1-len-pass",
      originalTitle: "式レ",
    });
    getPostsByUrlsMock.mockResolvedValue(stateFor(205, passCandidate));
    callGeminiMock.mockResolvedValue(geminiResponse("結婚式当日の進行と演出の工夫"));
    const passSummary = await runPipelineOnCandidates(
      [passCandidate],
      makeAdapter(),
      makeOptions(),
    );
    expect(passSummary.stageCounts.titleGatePassed).toBe(1);

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

    const failCandidate = makeCandidate({
      url: "https://example.com/inv1-len-fail",
      originalTitle: "式",
    });
    getPostsByUrlsMock.mockResolvedValue(stateFor(206, failCandidate));
    callGeminiMock.mockResolvedValue(geminiResponse("結婚式当日の進行と演出の工夫"));
    const failSummary = await runPipelineOnCandidates(
      [failCandidate],
      makeAdapter(),
      makeOptions(),
    );
    expect(failSummary.stageCounts.dropped["title_filter"]).toBe(1);
    expect(markDroppedMock).toHaveBeenCalledWith(206, "title_filter", expect.any(String));
  });
});

// ─────────────────────────────────────────────────────────────
// INV-2: topicAnchor の長さ下限
// ─────────────────────────────────────────────────────────────

describeInvariant("INV-2", "topicAnchor の長さ下限（degrade）", () => {
  it("6字のアンカーは通り post_rationales が作られる、5字は degrade して rationale なしで公開される", async () => {
    const passCandidate = makeCandidate({ url: "https://example.com/inv2-pass" });
    getPostsByUrlsMock.mockResolvedValue(stateFor(301, passCandidate));
    // 6字ちょうど、denylist に触れない語。
    callGeminiMock.mockResolvedValue(geminiResponse("進行演出工夫話"));

    const passSummary = await runPipelineOnCandidates(
      [passCandidate],
      makeAdapter(),
      makeOptions(),
    );
    expect(passSummary.stageCounts.published).toBe(1);
    const passUpdate = markCuratedMock.mock.calls[0][0][0];
    expect(passUpdate.rationale).toBeDefined();
    expect(passUpdate.rationale.topicAnchor).toBe("進行演出工夫話");

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

    const failCandidate = makeCandidate({ url: "https://example.com/inv2-fail" });
    getPostsByUrlsMock.mockResolvedValue(stateFor(302, failCandidate));
    // 5字（6字未満）。
    callGeminiMock.mockResolvedValue(geminiResponse("進行演出工"));

    const failSummary = await runPipelineOnCandidates(
      [failCandidate],
      makeAdapter(),
      makeOptions(),
    );
    // degrade しても投稿自体は公開される（drop ではない）。
    expect(failSummary.stageCounts.published).toBe(1);
    const failUpdate = markCuratedMock.mock.calls[0][0][0];
    expect(failUpdate.rationale.topicAnchor).toBeNull();
    expect(failUpdate.rationale.rationaleText).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// INV-3: topicAnchor の個人識別情報 denylist
// ─────────────────────────────────────────────────────────────

describeInvariant("INV-3", "topicAnchor の個人識別情報 denylist（degrade）", () => {
  it("敬称付き人名を含まないアンカーは通る、含むアンカーは degrade する", async () => {
    const passCandidate = makeCandidate({ url: "https://example.com/inv3-pass" });
    getPostsByUrlsMock.mockResolvedValue(stateFor(401, passCandidate));
    callGeminiMock.mockResolvedValue(geminiResponse("結婚式演出の工夫話"));

    const passSummary = await runPipelineOnCandidates(
      [passCandidate],
      makeAdapter(),
      makeOptions(),
    );
    expect(passSummary.stageCounts.published).toBe(1);
    const passUpdate = markCuratedMock.mock.calls[0][0][0];
    expect(passUpdate.rationale.topicAnchor).not.toBeNull();

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

    const failCandidate = makeCandidate({ url: "https://example.com/inv3-fail" });
    getPostsByUrlsMock.mockResolvedValue(stateFor(402, failCandidate));
    // 敬称付き人名（HONORIFIC_SAFE_PREFIXES に含まれない候補）を含むアンカー。
    callGeminiMock.mockResolvedValue(geminiResponse("田中花子さんの演出話"));

    const failSummary = await runPipelineOnCandidates(
      [failCandidate],
      makeAdapter(),
      makeOptions(),
    );
    expect(failSummary.stageCounts.published).toBe(1);
    const failUpdate = markCuratedMock.mock.calls[0][0][0];
    expect(failUpdate.rationale.topicAnchor).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// INV-4: renderRationaleText の字数上限・下限
// ─────────────────────────────────────────────────────────────
// runPipelineOnCandidates を経由させると LLM 応答を細かく制御しづらく境界を
// 再現しにくいため、renderRationaleText を直接呼ぶ（タスク仕様で明示的に
// 認められた例外）。

describeInvariant("INV-4", "renderRationaleText の字数境界", () => {
  it("通常の入力は 38〜210 字に収まる", () => {
    const text = renderRationaleText({
      topicAnchor: "結婚式当日の進行演出の工夫",
      usefulness: {
        firsthand: 9,
        ceremonyDecision: 9,
        specific: 9,
        weddingDayContent: 9,
        promotional: 0,
      },
    });
    expect(text.length).toBeGreaterThanOrEqual(RATIONALE_TEXT_MIN_CHARS);
    expect(text.length).toBeLessThanOrEqual(RATIONALE_TEXT_MAX_CHARS);
  });

  it("ラベルが1つも立たない場合でも下限を満たす固定文が返る", () => {
    const text = renderRationaleText({
      topicAnchor: "結婚式当日の進行演出の工夫",
      usefulness: {
        firsthand: 0,
        ceremonyDecision: 0,
        specific: 0,
        weddingDayContent: 0,
        promotional: 0,
      },
    });
    expect(text.length).toBeGreaterThanOrEqual(RATIONALE_TEXT_MIN_CHARS);
    expect(text.length).toBeLessThanOrEqual(RATIONALE_TEXT_MAX_CHARS);
  });

  it("スキーマ上限(40字)いっぱいの topicAnchor でも 210 字を超えず throw しない", () => {
    const anchor = "あ".repeat(40);
    expect(() =>
      renderRationaleText({
        topicAnchor: anchor,
        usefulness: {
          firsthand: 9,
          ceremonyDecision: 9,
          specific: 9,
          weddingDayContent: 9,
          promotional: 0,
        },
      }),
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// INV-5: 判定材料（抜粋）が無い候補は LLM を呼ばずに drop
// ─────────────────────────────────────────────────────────────

describeInvariant("INV-5", "抜粋なしは LLM を呼ばず extraction_insufficient で drop", () => {
  it("抜粋ありは curated される（ぎりぎり通る）", async () => {
    const candidate = makeCandidate({
      url: "https://example.com/inv5-pass",
      originalExcerpt: "一文字以上の抜粋。",
    });
    getPostsByUrlsMock.mockResolvedValue(stateFor(501, candidate));
    callGeminiMock.mockResolvedValue(geminiResponse("結婚式当日の進行と演出の工夫"));

    const summary = await runPipelineOnCandidates([candidate], makeAdapter(), makeOptions());
    expect(summary.stageCounts.evidenceGatePassed).toBe(1);
    expect(summary.stageCounts.published).toBe(1);
    expect(callGeminiMock).toHaveBeenCalled();
  });

  it("抜粋が空文字なら drop され LLM は呼ばれない（ぎりぎり落ちる）", async () => {
    const candidate = makeCandidate({
      url: "https://example.com/inv5-fail",
      originalExcerpt: "",
    });
    getPostsByUrlsMock.mockResolvedValue(stateFor(502, candidate));

    const summary = await runPipelineOnCandidates([candidate], makeAdapter(), makeOptions());
    expect(summary.stageCounts.evidenceGatePassed).toBe(0);
    expect(summary.stageCounts.dropped["extraction_insufficient"]).toBe(1);
    expect(markDroppedMock).toHaveBeenCalledWith(
      502,
      "extraction_insufficient:no_excerpt",
      expect.any(String),
    );
    expect(callGeminiMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// INV-6: 日次公開上限のサーキットブレーカー
// ─────────────────────────────────────────────────────────────

describeInvariant("INV-6", "日次公開上限のサーキットブレーカー", () => {
  it("既発行149件なら公開される、150件（上限到達）なら公開されず rate_capped で再試行に回る", async () => {
    const passCandidate = makeCandidate({ url: "https://example.com/inv6-pass" });
    getPostsByUrlsMock.mockResolvedValue(stateFor(601, passCandidate));
    callGeminiMock.mockResolvedValue(geminiResponse("結婚式当日の進行と演出の工夫"));
    countPublishedSinceMock.mockResolvedValue(149);

    const passSummary = await runPipelineOnCandidates(
      [passCandidate],
      makeAdapter(),
      makeOptions({ dailyPublishCap: 150 }),
    );
    expect(passSummary.stageCounts.rateCapPassed).toBe(1);
    expect(passSummary.stageCounts.published).toBe(1);

    vi.clearAllMocks();
    upsertPostsMock.mockImplementation(async (inputs: { url: string }[]) => ({
      succeeded: inputs.map((i) => i.url),
      failed: [],
    }));
    filterRemovedMock.mockResolvedValue(new Set());
    markCuratedMock.mockImplementation(async (updates: { url: string }[]) => ({
      succeeded: updates.map((u) => u.url),
      failed: [],
    }));

    const failCandidate = makeCandidate({ url: "https://example.com/inv6-fail" });
    getPostsByUrlsMock.mockResolvedValue(stateFor(602, failCandidate));
    callGeminiMock.mockResolvedValue(geminiResponse("結婚式当日の進行と演出の工夫"));
    countPublishedSinceMock.mockResolvedValue(150);

    const failSummary = await runPipelineOnCandidates(
      [failCandidate],
      makeAdapter(),
      makeOptions({ dailyPublishCap: 150 }),
    );
    expect(failSummary.stageCounts.rateCapPassed).toBe(0);
    expect(failSummary.stageCounts.published).toBe(0);
    expect(failSummary.stageCounts.retried).toBe(1);
    expect(enqueueRetryMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "rate_capped" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────
// 逐語タイトル（aiTitle は常に null）— shared_plan/20 P4 で旧 INV-7 を
// INVARIANTS レジストリ（機械強制の索引）から外したが、逐語タイトルは
// spec.md §10 の法務要件であり、その実装的強制（aiTitle 全経路 null）の
// 回帰テストとしてここに残す。
// ─────────────────────────────────────────────────────────────

describe("逐語タイトル: 公開時に aiTitle を渡さず originalTitle は逐語一致", () => {
  it("公開時に markCurated へ渡す update は aiTitle を含まず、originalTitle は入力と逐語一致する", async () => {
    const verbatimTitle = "これは元サイトが書いた逐語タイトルです";
    const candidate = makeCandidate({
      url: "https://example.com/inv7",
      originalTitle: verbatimTitle,
    });
    getPostsByUrlsMock.mockResolvedValue(stateFor(701, candidate));
    // LLM が別タイトル（"AI生成タイトル"）を返しても、公開されるのは
    // originalTitle の方であるべき。
    callGeminiMock.mockResolvedValue(geminiResponse("結婚式当日の進行と演出の工夫"));

    const summary = await runPipelineOnCandidates([candidate], makeAdapter(), makeOptions());
    expect(summary.stageCounts.published).toBe(1);

    const update = markCuratedMock.mock.calls[0][0][0];
    expect(update.aiTitle).toBeUndefined();
    expect(upsertPostsMock.mock.calls[0][0][0].originalTitle).toBe(verbatimTitle);
  });
});

// ─────────────────────────────────────────────────────────────
// discovery 経路の抽出本文（判定スライス）を DB に永続化しない —
// shared_plan/20 P4 で旧 INV-8 を INVARIANTS レジストリから外したが、
// 非永続化は spec.md §10-5 の法務要件であり、その実装的強制
// （assertNoSliceLeak の許可リスト方式）の回帰テストとしてここに残す。
// ─────────────────────────────────────────────────────────────

describe("discovery 判定スライスの非永続化: assertNoSliceLeak", () => {
  it("assertNoSliceLeak は許可リスト外のキー（本文リーク）を throw で弾く（ぎりぎり落ちる）", () => {
    expect(() =>
      assertNoSliceLeak([
        {
          url: "https://example.com/x",
          aiSummary: "s",
          originalExcerpt: "抜き出した本文スライス",
        } as TestUpdate,
      ]),
    ).toThrow(/§10-5/);
  });

  it("assertNoSliceLeak は許可リストのみの update は通す（ぎりぎり通る）", () => {
    expect(() =>
      assertNoSliceLeak([
        {
          url: "https://example.com/x",
          aiSummary: "s",
          category: "c",
          tag: "t",
          contentHash: "h",
          curationSignature: "sig",
        } as TestUpdate,
      ]),
    ).not.toThrow();
  });
});
