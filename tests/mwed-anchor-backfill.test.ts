import { describe, it, expect } from "vitest";
import {
  classifyMwedOutcomes,
  buildMwedUpdates,
  assertNoSliceLeak,
  ALLOWED_UPDATE_KEYS,
} from "../scripts/lib/mwed-anchor-backfill.mjs";

// scripts/lib/mwed-anchor-backfill.mjs は素の JS（.mjs）。テスト内だけの最小 shape。
type TestCandidate = {
  id: number | null;
  url: string;
  originalTitle: string;
  originalExcerpt: string | null;
  publishedAt: string | null;
};
type TestResult = Record<string, unknown> | null;
type TestOutcome = {
  candidate: TestCandidate;
  kind: "llm_failed" | "gate_degrade" | "updated";
  result: TestResult;
  finalTopicAnchor: string | null;
  gateReason: string | null;
};
type TestUpdate = Record<string, unknown> & { url: string };

const classify = classifyMwedOutcomes as (
  entries: Array<{ candidate: TestCandidate; result: TestResult }>,
) => TestOutcome[];
const build = buildMwedUpdates as (
  outcomes: TestOutcome[],
  deps: {
    computeContentHash: (t: string, e: string | null) => string;
    currentSignature: string;
    modelId: string;
    rationalePromptVersion: string;
  },
) => {
  updates: TestUpdate[];
  summary: { llmFailed: number; gateDegrade: number; updated: number };
  degradeReasonCounts: Map<string, number>;
};

const DEPS = {
  computeContentHash: (t: string, e: string | null) => `hash(${t}|${e})`,
  currentSignature: "sig-latest",
  modelId: "gemini-test",
  rationalePromptVersion: "rationale-v2",
};

function candidate(over: Partial<TestCandidate> = {}): TestCandidate {
  return {
    id: 1,
    url: "https://www.mwed.jp/story/cases/1/",
    originalTitle: "タイトル1",
    originalExcerpt: null,
    publishedAt: null,
    ...over,
  };
}

function goodResult(over: Record<string, unknown> = {}) {
  return {
    title: "AIタイトル",
    summary: "AI要約テキスト",
    topicAnchor: "ゲストにどう楽しんでもらうか",
    category: "reception",
    tag: "trend",
    rationaleText: "根拠テキスト",
    firsthand: true,
    ceremonyDecision: true,
    specific: true,
    weddingDayContent: true,
    promotional: false,
    preDecisionOrPhotoShoot: false,
    ...over,
  };
}

describe("classifyMwedOutcomes", () => {
  it("result が null なら llm_failed", () => {
    const [o] = classify([{ candidate: candidate(), result: null }]);
    expect(o.kind).toBe("llm_failed");
    expect(o.finalTopicAnchor).toBeNull();
  });

  it("result.topicAnchor が null なら gate_degrade（degradeReason を拾う）", () => {
    const [o] = classify([
      {
        candidate: candidate(),
        result: goodResult({ topicAnchor: null, degradeReason: "anchor_ungrounded" }),
      },
    ]);
    expect(o.kind).toBe("gate_degrade");
    expect(o.gateReason).toBe("anchor_ungrounded");
    expect(o.finalTopicAnchor).toBeNull();
  });

  it("topicAnchor があれば updated", () => {
    const [o] = classify([{ candidate: candidate(), result: goodResult() }]);
    expect(o.kind).toBe("updated");
    expect(o.finalTopicAnchor).toBe("ゲストにどう楽しんでもらうか");
  });
});

describe("buildMwedUpdates", () => {
  it("llm_failed は updates に一切現れない（署名据え置き・再開可能性）", () => {
    const outcomes = classify([{ candidate: candidate(), result: null }]);
    const { updates, summary } = build(outcomes, DEPS);
    expect(updates).toHaveLength(0);
    expect(summary.llmFailed).toBe(1);
  });

  it("updated は全フィールド + 署名前進 + rationale/usefulness", () => {
    const outcomes = classify([{ candidate: candidate(), result: goodResult() }]);
    const { updates } = build(outcomes, DEPS);
    expect(updates).toHaveLength(1);
    const u = updates[0];
    expect(u.aiSummary).toBe("AI要約テキスト");
    expect(u.category).toBe("reception");
    expect(u.tag).toBe("trend");
    expect(u.curationSignature).toBe("sig-latest");
    expect(u.contentHash).toBe("hash(タイトル1|null)");
    expect((u.rationale as Record<string, unknown>).topicAnchor).toBe(
      "ゲストにどう楽しんでもらうか",
    );
    expect((u.rationale as Record<string, unknown>).promptVersion).toBe("rationale-v2");
    expect((u.usefulness as Record<string, unknown>).postId).toBe(1);
  });

  it("gate_degrade は aiSummary/category/tag のみ。署名・contentHash・rationale・usefulness を含めない", () => {
    const outcomes = classify([
      {
        candidate: candidate(),
        result: goodResult({ topicAnchor: null, degradeReason: "anchor_prohibited_term" }),
      },
    ]);
    const { updates, summary, degradeReasonCounts } = build(outcomes, DEPS);
    expect(summary.gateDegrade).toBe(1);
    expect(degradeReasonCounts.get("anchor_prohibited_term")).toBe(1);
    const u = updates[0];
    expect(u.aiSummary).toBe("AI要約テキスト");
    expect(u.category).toBe("reception");
    expect(u.tag).toBe("trend");
    expect(u).not.toHaveProperty("curationSignature");
    expect(u).not.toHaveProperty("contentHash");
    expect(u).not.toHaveProperty("rationale");
    expect(u).not.toHaveProperty("usefulness");
  });

  it("§10-5: update のキーは ALLOWED_UPDATE_KEYS のみ（判定スライスを運ぶキーは無い）", () => {
    const SLICE =
      "これは記事本文から機械抽出した判定スライスであり DB に絶対に書いてはいけない文字列";
    // candidate に slice を紛れ込ませても（万一の実装ミスを模す）、build は
    // candidate.originalExcerpt/originalTitle しか参照しないため slice は伝播しない。
    const contaminated = { ...candidate(), _slice: SLICE, judgmentSlice: SLICE } as TestCandidate;
    const outcomes = classify([{ candidate: contaminated, result: goodResult({ _slice: SLICE }) }]);
    const { updates } = build(outcomes, DEPS);
    const serialized = JSON.stringify(updates);
    expect(serialized).not.toContain(SLICE);
    for (const u of updates) {
      for (const key of Object.keys(u)) {
        expect(ALLOWED_UPDATE_KEYS).toContain(key);
      }
    }
    expect(() => assertNoSliceLeak(updates)).not.toThrow();
  });
});

describe("assertNoSliceLeak", () => {
  it("許可リスト外のキーがあれば throw する", () => {
    expect(() =>
      assertNoSliceLeak([
        { url: "u", aiSummary: "s", originalExcerpt: "本文リーク" } as TestUpdate,
      ]),
    ).toThrow(/§10-5/);
  });

  it("許可リストのみなら通す", () => {
    expect(() =>
      assertNoSliceLeak([
        {
          url: "u",
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
