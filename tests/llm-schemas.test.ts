import { describe, expect, it } from "vitest";
import { CurationBatchResponseSchema, CurationItemSchema } from "@/lib/llm/schemas";
import { AI_TITLE_MAX_CHARS } from "@/lib/constants";

const validSummary =
  "結婚式の準備における費用感や演出のポイントについて、実際の体験に基づいた内容がまとめられています。会場選びやゲスト対応など具体的な工夫点が紹介されています。";

describe("CurationItemSchema", () => {
  it("accepts a valid item", () => {
    const result = CurationItemSchema.safeParse({
      index: 1,
      title: "結婚式準備の費用まとめ",
      summary: validSummary,
      category: "費用・節約",
      tag: "trend",
    });
    expect(result.success).toBe(true);
  });

  it("truncates an over-length title instead of rejecting it", () => {
    const longTitle = "あ".repeat(AI_TITLE_MAX_CHARS + 10);
    const result = CurationItemSchema.safeParse({
      index: 1,
      title: longTitle,
      summary: validSummary,
      category: "その他",
      tag: "classic",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toHaveLength(AI_TITLE_MAX_CHARS);
      expect(result.data.title).toBe("あ".repeat(AI_TITLE_MAX_CHARS));
    }
  });

  it("rejects an invalid category", () => {
    const result = CurationItemSchema.safeParse({
      index: 1,
      title: "テスト",
      summary: validSummary,
      category: "存在しないカテゴリ",
      tag: "trend",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid tag", () => {
    const result = CurationItemSchema.safeParse({
      index: 1,
      title: "テスト",
      summary: validSummary,
      category: "その他",
      tag: "invalid-tag",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a summary shorter than the validation minimum", () => {
    const result = CurationItemSchema.safeParse({
      index: 1,
      title: "テスト",
      summary: "短すぎる要約",
      category: "その他",
      tag: "trend",
    });
    expect(result.success).toBe(false);
  });
});

describe("CurationBatchResponseSchema", () => {
  it("accepts a well-formed batch response", () => {
    const result = CurationBatchResponseSchema.safeParse({
      items: [
        { index: 1, title: "A", summary: validSummary, category: "その他", tag: "trend" },
        { index: 2, title: "B", summary: validSummary, category: "その他", tag: "classic" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a response missing the items array", () => {
    const result = CurationBatchResponseSchema.safeParse({ results: [] });
    expect(result.success).toBe(false);
  });
});
