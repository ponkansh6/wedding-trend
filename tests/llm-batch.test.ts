import { beforeEach, describe, expect, it, vi } from "vitest";
import { curateBatch, curatePosts, curateAnchorWithRetry, curateSingle } from "@/lib/llm/batch";
import { LLM_BATCH_SIZE } from "@/lib/constants";

const { mockGenerateContent } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
}));

vi.mock("@google/generative-ai", () => {
  return {
    GoogleGenerativeAI: class {
      getGenerativeModel = vi.fn().mockReturnValue({
        generateContent: mockGenerateContent,
      });
    },
  };
});

function textResponse(text: string) {
  return { response: { text: () => text } };
}

/** 有用度判定 6 項目のデフォルト値（テストの主眼ではないため固定値で埋める）。 */
const USEFULNESS_FIELDS = {
  firsthand: 2,
  ceremonyDecision: 2,
  specific: 0,
  weddingDayContent: 0,
  promotional: 0,
};

// すべてのテストコーパス（タイトル「投稿N」＋抜粋「本文N」/「（本文抜粋なし）」）に
// 接地するアンカー。内容語「投稿」「本文」は各コーパスに出現し、「理由」は接続語
// 許可リスト（非接地チェック免除）、残りはひらがな（免除）。長さ 12 字以上、数字・
// 禁止語を含まず、タイトル「投稿N」に無い語（投稿）を含むため新規性も満たす。
const RATIONALE_FIELDS = {
  topicAnchor: "投稿の本文を知る理由を比べる",
};

function batchJson(items: Array<{ index: number; title: string }>) {
  return JSON.stringify({
    items: items.map((it) => ({
      index: it.index,
      title: it.title,
      summary: "て".repeat(80),
      category: "その他",
      tag: "trend",
      ...USEFULNESS_FIELDS,
      ...RATIONALE_FIELDS,
    })),
  });
}

describe("curateBatch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.GOOGLE_API_KEY = "test-api-key";
    // 指数バックオフの待機をスキップしてテストを高速化する。
    vi.stubGlobal(
      "setTimeout",
      vi.fn((cb: () => void) => {
        cb();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }),
    );
  });

  it("returns aligned results on a well-formed batch response", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          items: [
            {
              index: 1,
              title: "式場レポート",
              summary: "し".repeat(80),
              category: "その他",
              tag: "trend",
              ...USEFULNESS_FIELDS,
              ...RATIONALE_FIELDS,
            },
            {
              index: 2,
              title: "衣装選びのコツ",
              summary: "い".repeat(80),
              category: "衣装・ドレス",
              tag: "classic",
              ...USEFULNESS_FIELDS,
              ...RATIONALE_FIELDS,
            },
          ],
        }),
      ),
    );

    const results = await curateBatch([
      { title: "投稿1", excerpt: "本文1" },
      { title: "投稿2", excerpt: "本文2" },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]?.title).toBe("式場レポート");
    expect(results[0]?.tag).toBe("trend");
    expect(results[0]?.firsthand).toBe(2);
    expect(results[1]?.category).toBe("衣装・ドレス");
    // plan 07 §6-Q5: rationaleText はもはや LLM の出力ではなく、
    // topicAnchor + 6 boolean からの決定的テンプレートで付与される。
    expect(results[0]?.rationaleText).toContain("投稿の本文を知る理由を比べる");
    expect(results[0]?.rationaleText).not.toMatch(/[0-9０-９]/);
  });

  it("returns null array when the batch response is invalid JSON instead of falling back", async () => {
    mockGenerateContent
      .mockResolvedValueOnce(textResponse("not json"))
      .mockResolvedValueOnce(textResponse("still not json"))
      .mockResolvedValueOnce(textResponse("nope"));

    const results = await curateBatch([
      { title: "投稿1", excerpt: null },
      { title: "投稿2", excerpt: null },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]).toBeNull();
    expect(results[1]).toBeNull();
  });

  it("aligns results by index even when the LLM returns them out of order", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          items: [
            {
              index: 2,
              title: "二番目",
              summary: "に".repeat(80),
              category: "その他",
              tag: "classic",
              ...USEFULNESS_FIELDS,
              ...RATIONALE_FIELDS,
            },
            {
              index: 1,
              title: "一番目",
              summary: "い".repeat(80),
              category: "その他",
              tag: "trend",
              ...USEFULNESS_FIELDS,
              ...RATIONALE_FIELDS,
            },
          ],
        }),
      ),
    );

    const results = await curateBatch([
      { title: "投稿A", excerpt: null },
      { title: "投稿B", excerpt: null },
    ]);

    expect(results[0]?.title).toBe("一番目");
    expect(results[1]?.title).toBe("二番目");
  });

  it("returns nulls for items missing from the batch response without throwing", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(batchJson([{ index: 1, title: "唯一の結果" }])),
    );

    const results = await curateBatch([
      { title: "投稿1", excerpt: null },
      { title: "投稿2", excerpt: null },
    ]);

    expect(results[0]?.title).toBe("唯一の結果");
    expect(results[1]).toBeNull();
  });
});

describe("curatePosts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.GOOGLE_API_KEY = "test-api-key";
    vi.stubGlobal(
      "setTimeout",
      vi.fn((cb: () => void) => {
        cb();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }),
    );
  });

  it("splits inputs across multiple batches and preserves overall order", async () => {
    const total = LLM_BATCH_SIZE + 1;
    const inputs = Array.from({ length: total }, (_, i) => ({
      title: `投稿${i + 1}`,
      excerpt: null,
    }));

    const firstBatchItems = Array.from({ length: LLM_BATCH_SIZE }, (_, i) => ({
      index: i + 1,
      title: `結果${i + 1}`,
    }));
    const secondBatchItems = [{ index: 1, title: `結果${total}` }];

    mockGenerateContent
      .mockResolvedValueOnce(textResponse(batchJson(firstBatchItems)))
      .mockResolvedValueOnce(textResponse(batchJson(secondBatchItems)));

    const { results, geminiCalls } = await curatePosts(inputs);

    expect(results).toHaveLength(total);
    expect(results[0]?.title).toBe("結果1");
    expect(results[LLM_BATCH_SIZE - 1]?.title).toBe(`結果${LLM_BATCH_SIZE}`);
    expect(results[LLM_BATCH_SIZE]?.title).toBe(`結果${total}`);
    // 2 バッチに分割されているため、実際に Gemini を呼んだ回数も 2。
    expect(geminiCalls).toBe(2);
  });

  it("returns an empty array and geminiCalls: 0 for empty input without calling the LLM", async () => {
    const { results, geminiCalls } = await curatePosts([]);
    expect(results).toEqual([]);
    expect(geminiCalls).toBe(0);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("returns null results and counts gemini calls when the batch response is unusable", async () => {
    // バッチ呼び出し 1 回（失敗、リトライ3回含む）で null 配列を返す。フォールバックしないため単体呼び出しは発生しない。
    mockGenerateContent
      .mockResolvedValueOnce(textResponse("not json"))
      .mockResolvedValueOnce(textResponse("still not json"))
      .mockResolvedValueOnce(textResponse("nope"));

    const { results, geminiCalls } = await curatePosts([
      { title: "投稿1", excerpt: null },
      { title: "投稿2", excerpt: null },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]).toBeNull();
    expect(results[1]).toBeNull();
    expect(geminiCalls).toBe(3);
  });

  describe("curateAnchorWithRetry (plan D5: degrade-to-null on anchor failure with 1 retry)", () => {
    const baseItem = {
      title: "ウェディングドレスの選び方",
      summary: "す".repeat(80),
      category: "衣装・ドレス" as const,
      tag: "trend" as const,
      ...USEFULNESS_FIELDS,
    };

    it("keeps anchor if passing on first try", async () => {
      const generate = vi.fn().mockResolvedValueOnce({
        ...baseItem,
        topicAnchor: "会場選びの理由と実際の工夫",
      });

      const res = await curateAnchorWithRetry(generate, {
        title: "ウェディングドレスの選び方",
        excerpt: "会場選びの理由と実際の工夫についての詳細な記事です。ウェディングドレス。",
      });

      expect(res).not.toBeNull();
      expect(res?.topicAnchor).toBe("会場選びの理由と実際の工夫");
      expect(res?.degradeReason).toBeNull();
      expect(generate).toHaveBeenCalledTimes(1);
    });

    it("retries once with feedback and keeps anchor if passing on retry", async () => {
      const generate = vi
        .fn()
        .mockResolvedValueOnce({
          ...baseItem,
          topicAnchor: "短すぎ", // fails length (<12)
        })
        .mockResolvedValueOnce({
          ...baseItem,
          topicAnchor: "会場選びの理由と実際の工夫", // passes
        });

      const res = await curateAnchorWithRetry(generate, {
        title: "ウェディングドレスの選び方",
        excerpt: "会場選びの理由と実際の工夫についての詳細な記事です。ウェディングドレス。",
      });

      expect(res).not.toBeNull();
      expect(res?.topicAnchor).toBe("会場選びの理由と実際の工夫");
      // gate は1回目落ちてリトライで通ったので、最終的な degradeReason は null だが
      // firstAttemptReason には1回目の理由が残る（欠陥2対応）。
      expect(res?.degradeReason).toBeNull();
      expect(res?.firstAttemptReason).toBe("anchor_too_short");
      // 追加の可視化対応: 却下された1回目のアンカー文言そのものも伝播していること。
      expect(res?.firstAttemptAnchor).toBe("短すぎ");
      expect(generate).toHaveBeenCalledTimes(2);
      expect(generate.mock.calls[1][1]).toContain("このアンカーは検証に失敗しました");
    });

    it("degrades topicAnchor to null if failing twice, but keeps post/curation data intact", async () => {
      const generate = vi.fn().mockResolvedValue({
        ...baseItem,
        topicAnchor: "短すぎ",
      });

      const res = await curateAnchorWithRetry(generate, {
        title: "ウェディングドレスの選び方",
        excerpt: "ウェディングドレスの選び方についての詳細な記事です。",
      });

      expect(res).not.toBeNull();
      expect(res?.topicAnchor).toBeNull();
      expect(res?.summary).toBe(baseItem.summary);
      expect(res?.category).toBe("衣装・ドレス");
      // 欠陥2対応: なぜ degrade したかの理由コードが伝播していること。
      expect(res?.degradeReason).toBe("anchor_too_short");
      expect(res?.firstAttemptReason).toBe("anchor_too_short");
      expect(res?.retryAttemptReason).toBe("anchor_too_short");
      // 追加の可視化対応: 却下された1回目・リトライの文言が両方とも伝播していること
      // （1回目とリトライで同じ文言でも、両方の attempt に残す）。
      expect(res?.firstAttemptAnchor).toBe("短すぎ");
      expect(res?.retryAttemptAnchor).toBe("短すぎ");
      expect(generate).toHaveBeenCalledTimes(2);
    });

    // 旧「anchor_ungrounded で落ちた場合の missingTerms 伝播」テストは、
    // 2026-08-29 に語彙的接地検証（コーパス許可制度）を validateTopicAnchor から
    // 撤廃したことで到達不能になったため削除した（checkAnchorGrounding 関数自体の
    // 単体テストは tests/publish-gate.test.ts に残る）。

    it("追加の可視化対応: anchor_prohibited_term で落ちた場合、gate の matchedTerms がそのまま伝播する", async () => {
      const generate = vi.fn().mockResolvedValue({
        ...baseItem,
        // 2026-08-29 第2段: denylist は個人識別情報のみ。敬称付き人名で
        // anchor_prohibited_term を再現する。
        topicAnchor: "マイさんが会場選びで悩んだ理由と工夫",
      });

      const res = await curateAnchorWithRetry(generate, {
        title: "ウェディングドレスの選び方",
        excerpt:
          "新婦マイさんが会場選びの理由と実際の工夫について語った詳細な記事です。ウェディングドレス。",
      });

      expect(res).not.toBeNull();
      expect(res?.topicAnchor).toBeNull();
      expect(res?.degradeReason).toBe("anchor_prohibited_term");
      expect(res?.firstAttemptMatchedTerms).toEqual(["personal_info_honorific"]);
    });

    it("欠陥3の回帰防止: generate() が null を返す（LLM 呼び出し失敗）場合、捏造したプレースホルダではなく null を返す", async () => {
      const generate = vi.fn().mockResolvedValue(null);

      const res = await curateAnchorWithRetry(generate, {
        title: "ウェディングドレスの選び方",
        excerpt: "ウェディングドレスの選び方についての詳細な記事です。",
      });

      expect(res).toBeNull();
      expect(generate).toHaveBeenCalledTimes(1);
    });
  });
});

describe("curateSingle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.GOOGLE_API_KEY = "test-api-key";
    vi.stubGlobal(
      "setTimeout",
      vi.fn((cb: () => void) => {
        cb();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }),
    );
  });

  it("curates a single post and attaches rationale via template", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          title: "単体タイトル",
          summary: "て".repeat(80),
          category: "その他",
          tag: "trend",
          ...USEFULNESS_FIELDS,
          ...RATIONALE_FIELDS,
        }),
      ),
    );
    const { curateSingle: cs } = await import("@/lib/llm/batch");
    const res = await cs({ title: "投稿1", excerpt: "本文1" });
    expect(res).not.toBeNull();
    expect(res?.title).toBe("単体タイトル");
    expect(res?.topicAnchor).toBe(RATIONALE_FIELDS.topicAnchor);
    expect(res?.rationaleText).toContain(RATIONALE_FIELDS.topicAnchor);
  });

  it("degrades topicAnchor to null when single curation fails gate twice", async () => {
    mockGenerateContent
      .mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            title: "単体タイトル",
            summary: "て".repeat(80),
            category: "その他",
            tag: "trend",
            ...USEFULNESS_FIELDS,
            topicAnchor: "短",
          }),
        ),
      )
      .mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            title: "単体タイトル2",
            summary: "て".repeat(80),
            category: "その他",
            tag: "trend",
            ...USEFULNESS_FIELDS,
            topicAnchor: "短",
          }),
        ),
      );
    const { curateSingle: cs } = await import("@/lib/llm/batch");
    const res = await cs({ title: "投稿1", excerpt: "本文1" });
    expect(res).not.toBeNull();
    expect(res?.topicAnchor).toBeNull();
    expect(res?.rationaleText).toBeNull();
  });
});

describe("curateBatch gate integration (D5 degrade)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.GOOGLE_API_KEY = "test-api-key";
    vi.stubGlobal(
      "setTimeout",
      vi.fn((cb: () => void) => {
        cb();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }),
    );
  });

  it("degrades to null when batch anchor fails gate without retry", async () => {
    // batch returns invalid anchor "短" -> since retry is abolished, it immediately degrades to null
    mockGenerateContent.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          items: [
            {
              index: 1,
              title: "バッチ1",
              summary: "て".repeat(80),
              category: "その他",
              tag: "trend",
              ...USEFULNESS_FIELDS,
              topicAnchor: "短",
            },
          ],
        }),
      ),
    );
    const results = await curateBatch([{ title: "投稿1", excerpt: "本文1" }]);
    expect(results).toHaveLength(1);
    expect(results[0]?.topicAnchor).toBeNull();
    expect(results[0]?.rationaleText).toBeNull();
    expect(results[0]?.title).toBe("バッチ1");
    expect(results[0]?.degradeReason).toBe("anchor_too_short");
  });

  it("欠陥3の回帰防止: バッチ・単体フォールバックとも LLM 呼び出しが尽きて失敗したら、捏造したカテゴリ等を持つ結果ではなく null を返す", async () => {
    // batch 全体のパースが最後まで失敗し（LLM_MAX_PARSE_RETRIES 回とも不正 JSON）、
    // 単体フォールバック（curateSingle）も同様に失敗するケース。
    mockGenerateContent.mockResolvedValue(textResponse("これは不正なJSONです"));

    const results = await curateBatch([{ title: "投稿1", excerpt: "本文1" }]);

    expect(results).toHaveLength(1);
    // 捏造されたプレースホルダ（category: "準備・段取り" 等）を返してはならない。
    // 正しい実装では LLM 失敗をそのまま伝播し、結果は null になる。
    expect(results[0]).toBeNull();
  });
});
