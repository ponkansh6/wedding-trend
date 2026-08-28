import { describe, it, expect } from "vitest";
import * as backfillPlan from "../scripts/lib/backfill-plan.mjs";

// scripts/lib/backfill-plan.mjs は素の JS（.mjs）のため型情報を持たない。
// テストで戻り値の各種フィールドへアクセスできるよう、このテストファイル内だけで
// 使う最小限の shape を定義してキャストする（`any` は使わない。実装側の正式な
// 型は src/lib/db/repository.ts の CurationUpdate が担う）。
type TestCandidate = {
  id: number | null;
  url: string;
  originalTitle: string;
  originalExcerpt: string | null;
  publishedAt: string | null;
  sourceId?: string;
};
type TestRunnable = { candidate: TestCandidate; originalIndex: number };
type TestRejectedAnchor = {
  attempt: "first" | "retry";
  anchor: string | null;
  reason: string | null;
  missingTerms?: string[];
  matchedTerms?: string[];
};
type TestOutcome = {
  candidate: TestCandidate;
  originalIndex: number;
  kind: "llm_failed" | "gate_degrade" | "updated";
  result: Record<string, unknown> | null;
  finalTopicAnchor: string | null;
  gateReason: string | null;
  rejectedAnchors: TestRejectedAnchor[];
};
type TestUpdate = {
  url: string;
  aiTitle: string;
  aiSummary: string;
  category: string;
  tag: string;
  // gate_degrade では意図的に省略される（オーナー方針決定: 署名を進めない）。
  contentHash?: string;
  curationSignature?: string;
  _kind: string;
  _oldTopicAnchor: string | null;
  _newTopicAnchor: string | null;
  _gateReason?: string | null;
  _rejectedAnchors?: TestRejectedAnchor[];
  usefulness?: { postId: number; modelId: string };
  rationale?: { postId: number; topicAnchor: string };
};

const partitionCandidates = backfillPlan.partitionCandidates as unknown as (
  candidates: TestCandidate[],
  shouldRegenerateAnchor: (input: { title: string; excerpt: string | null }) => boolean,
) => { runnableCandidates: TestRunnable[]; skippedCandidates: TestRunnable[] };
const selectCandidatesForRun = backfillPlan.selectCandidatesForRun as unknown as (
  candidates: TestCandidate[],
  options?: { source?: string; limit?: number },
) => TestCandidate[];
const chunkArray = backfillPlan.chunkArray as unknown as <T>(array: T[], size: number) => T[][];
const classifyBackfillOutcomes = backfillPlan.classifyBackfillOutcomes as unknown as (
  runnableCandidates: TestRunnable[],
  curationResultsByIndex: Map<number, Record<string, unknown>>,
  deps: {
    validateTopicAnchor: (
      anchor: string,
      ctx: unknown,
    ) => { ok: boolean; reason?: string; missingTerms?: string[]; matchedTerms?: string[] };
  },
) => TestOutcome[];
const summarizeBackfillOutcomes = backfillPlan.summarizeBackfillOutcomes as unknown as (
  outcomes: TestOutcome[],
) => { llmFailed: number; gateDegrade: number; updated: number };
const buildBackfillUpdates = backfillPlan.buildBackfillUpdates as unknown as (
  outcomes: TestOutcome[],
  deps: Record<string, unknown>,
) => {
  updates: TestUpdate[];
  degradeReasonCounts: Map<string, number>;
  matchedTermCounts: Map<string, number>;
};
const toMarkCuratedInput = backfillPlan.toMarkCuratedInput as unknown as (
  updates: TestUpdate[],
) => Omit<
  TestUpdate,
  "_oldTopicAnchor" | "_newTopicAnchor" | "_kind" | "_gateReason" | "_rejectedAnchors"
>[];

/**
 * `scripts/backfill-usefulness.mjs` の2つの退行の再発防止テスト:
 *
 * 1. bd346f5: preflight スキップに `null` を渡し、既存の posts フィールドを
 *    NULL 上書きしていた退行。→ 「shouldRegenerateAnchor() が false の候補は
 *    updates に一切現れない」（partitionCandidates / buildBackfillUpdates）。
 * 2. dry-run のサマリと個別プレビューが矛盾した退行（LLM 失敗を gate degrade と
 *    誤ラベルしていた）。→ 「LLM 呼び出し自体が失敗した候補（結果なし）」と
 *    「LLM は成功したが gate に落ちた候補」を区別する（classifyBackfillOutcomes /
 *    summarizeBackfillOutcomes）。
 */

const shouldRegenerateAnchorAlways = () => true;
const shouldRegenerateAnchorByTitle = (input: { title: string; excerpt: string | null }) =>
  input.title !== "スキップ対象";

function candidate(overrides: Partial<TestCandidate> = {}): TestCandidate {
  return {
    id: 1,
    url: "https://example.com/a",
    originalTitle: "タイトル",
    originalExcerpt: "本文抜粋",
    publishedAt: null,
    ...overrides,
  };
}

function curationResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    title: "AI Title",
    summary: "AI Summary",
    category: "その他",
    tag: "trend",
    topicAnchor: "アンカー本文",
    rationaleText: "根拠",
    firsthand: true,
    ceremonyDecision: true,
    specific: true,
    weddingDayContent: false,
    promotional: "none",
    preDecisionOrPhotoShoot: false,
    ...overrides,
  };
}

const okGate = () => ({ ok: true as const });

describe("partitionCandidates", () => {
  it("shouldRegenerateAnchor が false の候補を skippedCandidates に振り分け、runnableCandidates には含めない", () => {
    const candidates = [
      candidate({ url: "https://example.com/run", originalTitle: "通常タイトル" }),
      candidate({ url: "https://example.com/skip", originalTitle: "スキップ対象" }),
    ];

    const { runnableCandidates, skippedCandidates } = partitionCandidates(
      candidates,
      shouldRegenerateAnchorByTitle,
    );

    expect(runnableCandidates.map((rc) => rc.candidate.url)).toEqual(["https://example.com/run"]);
    expect(skippedCandidates.map((rc) => rc.candidate.url)).toEqual(["https://example.com/skip"]);
    // originalIndex は元の candidates 配列でのインデックスを保持する。
    expect(runnableCandidates[0].originalIndex).toBe(0);
    expect(skippedCandidates[0].originalIndex).toBe(1);
  });

  it("全件 runnable なら skippedCandidates は空", () => {
    const candidates = [candidate(), candidate({ url: "https://example.com/b" })];
    const { runnableCandidates, skippedCandidates } = partitionCandidates(
      candidates,
      shouldRegenerateAnchorAlways,
    );
    expect(runnableCandidates).toHaveLength(2);
    expect(skippedCandidates).toHaveLength(0);
  });
});

describe("selectCandidatesForRun", () => {
  it("--limit で先頭 N 件に絞り込む", () => {
    const candidates = [
      candidate({ url: "https://example.com/1" }),
      candidate({ url: "https://example.com/2" }),
      candidate({ url: "https://example.com/3" }),
    ];
    const selected = selectCandidatesForRun(candidates, { limit: 2 });
    expect(selected.map((c) => c.url)).toEqual(["https://example.com/1", "https://example.com/2"]);
  });

  it("--source は sourceId の完全一致を優先する", () => {
    const candidates = [
      candidate({ url: "https://note.com/a", sourceId: "note" }),
      candidate({ url: "https://hatena.com/b", sourceId: "hatena" }),
    ];
    const selected = selectCandidatesForRun(candidates, { source: "note" });
    expect(selected.map((c) => c.url)).toEqual(["https://note.com/a"]);
  });

  it("--source は sourceId が無い候補には url の部分一致でフォールバックする", () => {
    const candidates = [
      candidate({ url: "https://note.com/a" }),
      candidate({ url: "https://hatena.com/b" }),
    ];
    const selected = selectCandidatesForRun(candidates, { source: "note.com" });
    expect(selected.map((c) => c.url)).toEqual(["https://note.com/a"]);
  });

  it("本命の順序保証: --source によるコホート絞り込みを --limit より先に適用する", () => {
    // note 系が2件、他ソースが1件目に混ざっている状況で --source note --limit 1 とすると、
    // 「先に limit してから source」だと1件目（他ソース）が残って0件になってしまう。
    // 正しくは「先に source（note の2件が残る）→ limit 1（先頭の note 1件）」。
    const candidates = [
      candidate({ url: "https://other.com/x", sourceId: "other" }),
      candidate({ url: "https://note.com/a", sourceId: "note" }),
      candidate({ url: "https://note.com/b", sourceId: "note" }),
    ];
    const selected = selectCandidatesForRun(candidates, { source: "note", limit: 1 });
    expect(selected.map((c) => c.url)).toEqual(["https://note.com/a"]);
  });

  it("source / limit いずれも未指定なら全件そのまま返す", () => {
    const candidates = [candidate({ url: "https://example.com/1" })];
    expect(selectCandidatesForRun(candidates, {})).toEqual(candidates);
    expect(selectCandidatesForRun(candidates)).toEqual(candidates);
  });
});

describe("chunkArray", () => {
  it("指定サイズごとに分割する", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("サイズが配列長以上なら1チャンクにまとまる", () => {
    expect(chunkArray([1, 2], 10)).toEqual([[1, 2]]);
  });

  it("サイズ未指定・0以下なら分割しない", () => {
    expect(chunkArray([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
    expect(chunkArray([1, 2, 3], undefined as unknown as number)).toEqual([[1, 2, 3]]);
  });

  it("空配列は空チャンク配列にはならず [[]] を返さない（要素0件なら結果も0件）", () => {
    expect(chunkArray([], 3)).toEqual([]);
  });
});

describe("classifyBackfillOutcomes", () => {
  it("本命の不変条件: LLM 呼び出しに失敗した（結果が無い）候補は kind: 'llm_failed' に分類され、gate_degrade とは取り違えない", () => {
    const candidates = [candidate({ url: "https://example.com/failed" })];
    const { runnableCandidates } = partitionCandidates(candidates, shouldRegenerateAnchorAlways);
    // curationResultsByIndex に何も登録しない = LLM 呼び出しが結果を返さなかった状態を再現。
    const curationResultsByIndex = new Map<number, Record<string, unknown>>();

    const outcomes = classifyBackfillOutcomes(runnableCandidates, curationResultsByIndex, {
      validateTopicAnchor: okGate,
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].kind).toBe("llm_failed");
    // gate_degrade であってはならない（このアサーションが本命）。
    expect(outcomes[0].kind).not.toBe("gate_degrade");
    expect(outcomes[0].finalTopicAnchor).toBeNull();
    expect(outcomes[0].result).toBeNull();

    // サマリでも llmFailed としてカウントされ、gateDegrade は0であること。
    const summary = summarizeBackfillOutcomes(outcomes);
    expect(summary).toEqual({ llmFailed: 1, gateDegrade: 0, updated: 0 });
  });

  it("LLM が成功し gate も通れば kind: 'updated'", () => {
    const candidates = [candidate({ url: "https://example.com/ok" })];
    const { runnableCandidates } = partitionCandidates(candidates, shouldRegenerateAnchorAlways);
    const curationResultsByIndex = new Map([[0, curationResult()]]);

    const outcomes = classifyBackfillOutcomes(runnableCandidates, curationResultsByIndex, {
      validateTopicAnchor: okGate,
    });

    expect(outcomes[0].kind).toBe("updated");
    expect(outcomes[0].finalTopicAnchor).toBe("アンカー本文");
    expect(summarizeBackfillOutcomes(outcomes)).toEqual({
      llmFailed: 0,
      gateDegrade: 0,
      updated: 1,
    });
  });

  it("LLM は成功したが gate に落ちれば kind: 'gate_degrade'（llm_failed とは別）", () => {
    const candidates = [candidate({ url: "https://example.com/degrade" })];
    const { runnableCandidates } = partitionCandidates(candidates, shouldRegenerateAnchorAlways);
    const curationResultsByIndex = new Map([[0, curationResult()]]);
    const failingGate = () => ({
      ok: false as const,
      reason: "anchor_ungrounded",
      missingTerms: ["体型管理", "停滞期"],
    });

    const outcomes = classifyBackfillOutcomes(runnableCandidates, curationResultsByIndex, {
      validateTopicAnchor: failingGate,
    });

    expect(outcomes[0].kind).toBe("gate_degrade");
    expect(outcomes[0].kind).not.toBe("llm_failed");
    expect(outcomes[0].finalTopicAnchor).toBeNull();
    expect(outcomes[0].gateReason).toBe("anchor_ungrounded");
    expect(summarizeBackfillOutcomes(outcomes)).toEqual({
      llmFailed: 0,
      gateDegrade: 1,
      updated: 0,
    });

    // 要件1・2: 却下されたアンカーの実文言と missingTerms が rejectedAnchors に残ること。
    expect(outcomes[0].rejectedAnchors).toHaveLength(1);
    expect(outcomes[0].rejectedAnchors[0].attempt).toBe("first");
    expect(outcomes[0].rejectedAnchors[0].anchor).toBe("アンカー本文");
    expect(outcomes[0].rejectedAnchors[0].missingTerms).toEqual(["体型管理", "停滞期"]);
  });

  it("本命の不変条件（欠陥1）: 上流（src/lib/llm/batch.ts）が既に topicAnchor: null に degrade 済みの結果を 'updated' と分類してはならない", () => {
    // curateAnchorWithRetry / curateBatch は自前で validateTopicAnchor を適用し、
    // 落ちた場合は topicAnchor: null（+ degradeReason）を持つ結果を返してくる。
    // classifyBackfillOutcomes がここで自前の gate（常に ok を返す okGate）だけを
    // 頼りに判定すると、finalTopicAnchor が既に null なので gate は発火せず、
    // 誤って 'updated' に分類されてしまう（ドライランのサマリが嘘をついた実際の退行）。
    const candidates = [candidate({ url: "https://example.com/upstream-degrade" })];
    const { runnableCandidates } = partitionCandidates(candidates, shouldRegenerateAnchorAlways);
    const curationResultsByIndex = new Map([
      [0, curationResult({ topicAnchor: null, degradeReason: "anchor_ungrounded" })],
    ]);

    const outcomes = classifyBackfillOutcomes(runnableCandidates, curationResultsByIndex, {
      validateTopicAnchor: okGate, // 自前の gate は常に ok を返す（＝ここでは検出できない）
    });

    expect(outcomes[0].kind).toBe("gate_degrade");
    expect(outcomes[0].kind).not.toBe("updated");
    expect(outcomes[0].finalTopicAnchor).toBeNull();
    expect(outcomes[0].gateReason).toBe("anchor_ungrounded");
  });

  it("本命の不変条件（要件1・2・3）: 上流 degrade の場合、rejectedAnchors は result の firstAttemptAnchor/retryAttemptAnchor とその missingTerms/matchedTerms からそのまま組み立てられる", () => {
    const candidates = [candidate({ url: "https://example.com/upstream-degrade-detail" })];
    const { runnableCandidates } = partitionCandidates(candidates, shouldRegenerateAnchorAlways);
    const curationResultsByIndex = new Map([
      [
        0,
        curationResult({
          topicAnchor: null,
          degradeReason: "anchor_prohibited_term",
          firstAttemptAnchor: "衝撃の会場選びの理由と工夫について",
          firstAttemptReason: "anchor_prohibited_term",
          firstAttemptMatchedTerms: ["衝撃"],
          retryAttemptAnchor: "驚愕の会場選びの理由と工夫について",
          retryAttemptReason: "anchor_prohibited_term",
          retryAttemptMatchedTerms: ["驚愕"],
        }),
      ],
    ]);

    const outcomes = classifyBackfillOutcomes(runnableCandidates, curationResultsByIndex, {
      validateTopicAnchor: okGate,
    });

    expect(outcomes[0].kind).toBe("gate_degrade");
    expect(outcomes[0].rejectedAnchors).toEqual([
      {
        attempt: "first",
        anchor: "衝撃の会場選びの理由と工夫について",
        reason: "anchor_prohibited_term",
        missingTerms: undefined,
        matchedTerms: ["衝撃"],
      },
      {
        attempt: "retry",
        anchor: "驚愕の会場選びの理由と工夫について",
        reason: "anchor_prohibited_term",
        missingTerms: undefined,
        matchedTerms: ["驚愕"],
      },
    ]);
  });

  it("混在: llm_failed / gate_degrade / updated の合計が runnableCandidates の件数と一致する", () => {
    const candidates = [
      candidate({ url: "https://example.com/failed" }),
      candidate({ url: "https://example.com/degrade" }),
      candidate({ url: "https://example.com/ok" }),
    ];
    const { runnableCandidates } = partitionCandidates(candidates, shouldRegenerateAnchorAlways);
    // index 0 (failed) は結果を登録しない。1 (degrade) と 2 (ok) は結果ありで、
    // gate の合否を呼び出し順で分岐させて区別する。
    const curationResultsByIndex = new Map([
      [1, curationResult()],
      [2, curationResult()],
    ]);
    let callIdx = 0;
    const gate = () => {
      callIdx += 1;
      return callIdx === 1
        ? { ok: false as const, reason: "anchor_too_short" }
        : { ok: true as const };
    };

    const outcomes = classifyBackfillOutcomes(runnableCandidates, curationResultsByIndex, {
      validateTopicAnchor: gate,
    });

    const summary = summarizeBackfillOutcomes(outcomes);
    expect(summary.llmFailed + summary.gateDegrade + summary.updated).toBe(
      runnableCandidates.length,
    );
    expect(summary).toEqual({ llmFailed: 1, gateDegrade: 1, updated: 1 });
  });
});

describe("buildBackfillUpdates", () => {
  const baseDeps = {
    computeContentHash: (title: string, excerpt: string | null) => `hash(${title}|${excerpt})`,
    currentSignature: "sig-current",
    modelId: "test-model",
    rationalePromptVersion: "v1",
  };

  function outcomeFor(
    candidateOverrides: Partial<TestCandidate>,
    kind: TestOutcome["kind"],
    result: Record<string, unknown> | null,
    finalTopicAnchor: string | null,
    gateReason: string | null = null,
    rejectedAnchors: TestRejectedAnchor[] = [],
  ): TestOutcome {
    return {
      candidate: candidate(candidateOverrides),
      originalIndex: 0,
      kind,
      result,
      finalTopicAnchor,
      gateReason,
      rejectedAnchors,
    };
  }

  it("本命の不変条件: kind === 'llm_failed' の outcome は updates に一切現れない", () => {
    const outcomes: TestOutcome[] = [
      outcomeFor({ url: "https://example.com/failed" }, "llm_failed", null, null),
      outcomeFor({ url: "https://example.com/ok" }, "updated", curationResult(), "アンカー本文"),
    ];

    const { updates } = buildBackfillUpdates(outcomes, baseDeps);

    expect(updates.map((u) => u.url)).toEqual(["https://example.com/ok"]);
    const failedInUpdates = updates.find((u) => u.url === "https://example.com/failed");
    expect(failedInUpdates).toBeUndefined();

    // markCurated へ渡す applyUpdates にも一切現れない（＝ posts への UPDATE 文が生成されない）。
    const applyUpdates = toMarkCuratedInput(updates);
    expect(applyUpdates.some((u) => u.url === "https://example.com/failed")).toBe(false);
  });

  it("kind === 'updated' は contentHash / curationSignature を含めて updates に含まれる", () => {
    const outcomes: TestOutcome[] = [
      outcomeFor({ url: "https://example.com/run" }, "updated", curationResult(), "アンカー本文"),
    ];

    const { updates } = buildBackfillUpdates(outcomes, baseDeps);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      url: "https://example.com/run",
      aiTitle: "AI Title",
      aiSummary: "AI Summary",
      category: "その他",
      tag: "trend",
      contentHash: "hash(タイトル|本文抜粋)",
      curationSignature: "sig-current",
      _kind: "updated",
    });
    expect(updates[0].usefulness).toMatchObject({ postId: 1, modelId: "test-model" });
    expect(updates[0].rationale).toMatchObject({ postId: 1, topicAnchor: "アンカー本文" });
  });

  it("kind === 'gate_degrade' は topicAnchor が null になり rationale は渡さないが、aiTitle 等は通常どおり更新する", () => {
    const outcomes: TestOutcome[] = [
      outcomeFor(
        { url: "https://example.com/degrade" },
        "gate_degrade",
        curationResult(),
        null,
        "anchor_ungrounded",
      ),
    ];

    const { updates, degradeReasonCounts } = buildBackfillUpdates(outcomes, baseDeps);

    expect(updates).toHaveLength(1);
    expect(updates[0]._newTopicAnchor).toBeNull();
    expect(updates[0]._kind).toBe("gate_degrade");
    expect(updates[0].rationale).toBeUndefined();
    expect(updates[0].aiTitle).toBe("AI Title");
    expect(updates[0].aiSummary).toBe("AI Summary");
    expect(updates[0].category).toBe("その他");
    expect(updates[0].tag).toBe("trend");
    expect(degradeReasonCounts.get("anchor_ungrounded")).toBe(1);
  });

  it("本命の不変条件（オーナー方針決定）: kind === 'gate_degrade' では contentSignature を updates に含めてはならない（curationSignature を進めると二度と再生成されなくなる）", () => {
    const outcomes: TestOutcome[] = [
      outcomeFor(
        { url: "https://example.com/degrade-signature", id: 42 },
        "gate_degrade",
        curationResult(),
        null,
        "anchor_too_short",
      ),
    ];

    const { updates } = buildBackfillUpdates(outcomes, baseDeps);

    expect(updates).toHaveLength(1);
    // curationSignature / contentHash は一切含めない（undefined のまま）。
    // "sig-current" のような具体値は絶対に入ってはならない
    // （＝ toMarkCuratedInput を経ても posts.curation_signature の UPDATE 文に
    // 現在の署名が乗ってはならない）。
    expect(updates[0]).not.toHaveProperty("curationSignature");
    expect(updates[0]).not.toHaveProperty("contentHash");
    expect(updates[0].curationSignature).toBeUndefined();
    expect(updates[0].contentHash).toBeUndefined();

    // post_usefulness_criteria.signature も posts.curationSignature と必ず一致
    // させる契約があるため、署名を進めない以上 usefulness も書いてはならない。
    expect(updates[0].usefulness).toBeUndefined();

    // markCurated に渡す直前でも同様（toMarkCuratedInput を経ても復活しない）。
    const applyUpdates = toMarkCuratedInput(updates);
    expect(applyUpdates[0]).not.toHaveProperty("curationSignature");
    expect(applyUpdates[0]).not.toHaveProperty("contentHash");
  });

  it("要件4: matchedTermCounts は degrade した候補の rejectedAnchors から denylist 項目ごとに集計する（llm_failed / updated は数えない）", () => {
    const outcomes: TestOutcome[] = [
      outcomeFor(
        { url: "https://example.com/deny-1" },
        "gate_degrade",
        curationResult(),
        null,
        "anchor_prohibited_term",
        [
          {
            attempt: "first",
            anchor: "衝撃のアンカー文言です",
            reason: "anchor_prohibited_term",
            matchedTerms: ["衝撃"],
          },
        ],
      ),
      outcomeFor(
        { url: "https://example.com/deny-2" },
        "gate_degrade",
        curationResult(),
        null,
        "anchor_prohibited_term",
        [
          {
            attempt: "first",
            anchor: "衝撃の別のアンカー文言です",
            reason: "anchor_prohibited_term",
            matchedTerms: ["衝撃"],
          },
        ],
      ),
      outcomeFor(
        { url: "https://example.com/deny-3" },
        "gate_degrade",
        curationResult(),
        null,
        "anchor_prohibited_term",
        [
          {
            attempt: "first",
            anchor: "驚愕のアンカー文言です",
            reason: "anchor_prohibited_term",
            matchedTerms: ["驚愕"],
          },
        ],
      ),
      // llm_failed / updated は matchedTermCounts に一切寄与しない。
      outcomeFor({ url: "https://example.com/failed" }, "llm_failed", null, null),
      outcomeFor(
        { url: "https://example.com/ok" },
        "updated",
        curationResult(),
        "アンカー本文",
        null,
        [],
      ),
    ];

    const { matchedTermCounts } = buildBackfillUpdates(outcomes, baseDeps);

    expect(matchedTermCounts.get("衝撃")).toBe(2);
    expect(matchedTermCounts.get("驚愕")).toBe(1);
    expect(matchedTermCounts.size).toBe(2);
  });

  it("candidate.id が null の場合は usefulness/rationale を付与しない", () => {
    const outcomes: TestOutcome[] = [
      outcomeFor(
        { id: null, url: "https://example.com/no-id" },
        "updated",
        curationResult(),
        "アンカー",
      ),
    ];

    const { updates } = buildBackfillUpdates(outcomes, baseDeps);
    expect(updates[0].usefulness).toBeUndefined();
    expect(updates[0].rationale).toBeUndefined();
  });
});

describe("toMarkCuratedInput", () => {
  it("dry-run 専用フィールド（_oldTopicAnchor / _newTopicAnchor / _kind / _gateReason）を取り除く", () => {
    const updates: TestUpdate[] = [
      {
        url: "https://example.com/x",
        aiTitle: "t",
        aiSummary: "s",
        category: "その他",
        tag: "trend",
        contentHash: "h",
        curationSignature: "sig",
        _kind: "gate_degrade",
        _oldTopicAnchor: "old",
        _newTopicAnchor: "new",
        _gateReason: "anchor_ungrounded",
      },
    ];
    const result = toMarkCuratedInput(updates);
    expect(result[0]).not.toHaveProperty("_oldTopicAnchor");
    expect(result[0]).not.toHaveProperty("_newTopicAnchor");
    expect(result[0]).not.toHaveProperty("_kind");
    expect(result[0]).not.toHaveProperty("_gateReason");
    expect(result[0].url).toBe("https://example.com/x");
  });
});
