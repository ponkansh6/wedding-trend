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
  firsthand: true,
  ceremonyDecision: true,
  specific: false,
  weddingDayContent: false,
  promotional: "none",
  preDecisionOrPhotoShoot: false,
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
    expect(results[0]?.firsthand).toBe(true);
    expect(results[1]?.category).toBe("衣装・ドレス");
    // plan 07 §6-Q5: rationaleText はもはや LLM の出力ではなく、
    // topicAnchor + 6 boolean からの決定的テンプレートで付与される。
    expect(results[0]?.rationaleText).toContain("投稿の本文を知る理由を比べる");
    expect(results[0]?.rationaleText).not.toMatch(/[0-9０-９]/);
  });

  it("falls back to single-item curation when the batch response is invalid JSON", async () => {
    mockGenerateContent
      .mockResolvedValueOnce(textResponse("not json"))
      .mockResolvedValueOnce(textResponse("still not json"))
      .mockResolvedValueOnce(textResponse("nope"))
      .mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            title: "個別1",
            summary: "あ".repeat(80),
            category: "その他",
            tag: "trend",
            ...USEFULNESS_FIELDS,
            ...RATIONALE_FIELDS,
          }),
        ),
      )
      .mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            title: "個別2",
            summary: "い".repeat(80),
            category: "その他",
            tag: "classic",
            ...USEFULNESS_FIELDS,
            ...RATIONALE_FIELDS,
          }),
        ),
      );

    const results = await curateBatch([
      { title: "投稿1", excerpt: null },
      { title: "投稿2", excerpt: null },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]?.title).toBe("個別1");
    expect(results[1]?.title).toBe("個別2");
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

  it("counts a Gemini call even when the batch response is unusable and it falls back to single-item curation", async () => {
    // バッチ呼び出し 1 回（失敗）+ 単体フォールバック 2 回 = 合計 3 回。
    mockGenerateContent
      .mockResolvedValueOnce(textResponse("not json"))
      .mockResolvedValueOnce(textResponse("still not json"))
      .mockResolvedValueOnce(textResponse("nope"))
      .mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            title: "個別1",
            summary: "あ".repeat(80),
            category: "その他",
            tag: "trend",
            ...USEFULNESS_FIELDS,
            ...RATIONALE_FIELDS,
          }),
        ),
      )
      .mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            title: "個別2",
            summary: "い".repeat(80),
            category: "その他",
            tag: "classic",
            ...USEFULNESS_FIELDS,
            ...RATIONALE_FIELDS,
          }),
        ),
      );

    const { results, geminiCalls } = await curatePosts([
      { title: "投稿1", excerpt: null },
      { title: "投稿2", excerpt: null },
    ]);

    expect(results[0]?.title).toBe("個別1");
    expect(results[1]?.title).toBe("個別2");
    expect(geminiCalls).toBe(5);
  });

  describe("curateAnchorWithRetry (plan D5: degrade-to-null on anchor failure with 1 retry)", () => {
    const baseItem = {
      title: "ウェディングドレスの選び方",
      summary: "す".repeat(80),
      category: "衣装・ドレス" as const,
      tag: "trend" as const,
      ...USEFULNESS_FIELDS,
      promotional: "none" as const,
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

      expect(res.topicAnchor).toBe("会場選びの理由と実際の工夫");
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

      expect(res.topicAnchor).toBe("会場選びの理由と実際の工夫");
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

      expect(res.topicAnchor).toBeNull();
      expect(res.summary).toBe(baseItem.summary);
      expect(res.category).toBe("衣装・ドレス");
      expect(generate).toHaveBeenCalledTimes(2);
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

  it("degrades to null when batch anchor fails gate and retry also fails", async () => {
    // batch returns invalid anchor "短" -> retry via curateSingle also returns invalid
    mockGenerateContent
      .mockResolvedValueOnce(
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
      )
      .mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            title: "リトライ1",
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
            title: "リトライ2",
            summary: "て".repeat(80),
            category: "その他",
            tag: "trend",
            ...USEFULNESS_FIELDS,
            topicAnchor: "短",
          }),
        ),
      );
    const results = await curateBatch([{ title: "投稿1", excerpt: "本文1" }]);
    expect(results).toHaveLength(1);
    expect(results[0]?.topicAnchor).toBeNull();
    expect(results[0]?.rationaleText).toBeNull();
    expect(results[0]?.title).toBe("バッチ1");
  });

  it("recovers with retry anchor when retry passes gate", async () => {
    mockGenerateContent
      .mockResolvedValueOnce(
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
      )
      .mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            title: "リトライ成功タイトル",
            summary: "て".repeat(80),
            category: "その他",
            tag: "trend",
            ...USEFULNESS_FIELDS,
            ...RATIONALE_FIELDS,
          }),
        ),
      );
    const results = await curateBatch([{ title: "投稿1", excerpt: "本文1" }]);
    expect(results).toHaveLength(1);
    expect(results[0]?.topicAnchor).toBe(RATIONALE_FIELDS.topicAnchor);
    expect(results[0]?.title).toBe("リトライ成功タイトル");
    expect(results[0]?.rationaleText).toContain(RATIONALE_FIELDS.topicAnchor);
  });
});
