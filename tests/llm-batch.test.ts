import { beforeEach, describe, expect, it, vi } from "vitest";
import { curateBatch, curatePosts } from "@/lib/llm/batch";
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
  tradeoff: false,
  promotional: "none",
  preDecisionOrPhotoShoot: false,
};

const RATIONALE_FIELDS = {
  topicAnchor: "トピックアンカー",
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
    expect(results[0]?.rationaleText).toContain("トピックアンカー");
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
});
