import { describe, expect, it } from "vitest";
import { CurationBatchResponseSchema, CurationItemSchema } from "@/lib/llm/schemas";
import { AI_TITLE_MAX_CHARS } from "@/lib/constants";
import { buildSingleCurationPrompt } from "@/lib/llm/prompts";

const validSummary =
  "結婚式の準備における費用感や演出のポイントについて、実際の体験に基づいた内容がまとめられています。会場選びやゲスト対応など具体的な工夫点が紹介されています。";

/** 有用度判定 6 項目（promotional のみ enum、他はブール値）。テストのデフォルト値として使い回す。 */
const validUsefulness = {
  firsthand: true,
  ceremonyDecision: true,
  specific: true,
  tradeoff: false,
  promotional: "none",
  preDecisionOrPhotoShoot: false,
};

const validRationaleFields = {
  topicAnchor: "会場選びのコツ",
};

describe("CurationItemSchema", () => {
  it("accepts a valid item", () => {
    const result = CurationItemSchema.safeParse({
      index: 1,
      title: "結婚式準備の費用まとめ",
      summary: validSummary,
      category: "費用・節約",
      tag: "trend",
      ...validUsefulness,
      ...validRationaleFields,
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
      ...validUsefulness,
      ...validRationaleFields,
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
      ...validUsefulness,
      ...validRationaleFields,
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
      ...validUsefulness,
      ...validRationaleFields,
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
      ...validUsefulness,
      ...validRationaleFields,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an item missing one of the usefulness boolean fields", () => {
    const { tradeoff: _tradeoff, ...rest } = validUsefulness;
    const result = CurationItemSchema.safeParse({
      index: 1,
      title: "テスト",
      summary: validSummary,
      category: "その他",
      tag: "trend",
      ...rest,
      ...validRationaleFields,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an item where a boolean usefulness field is a string instead of a boolean", () => {
    const result = CurationItemSchema.safeParse({
      index: 1,
      title: "テスト",
      summary: validSummary,
      category: "その他",
      tag: "trend",
      ...validUsefulness,
      ...validRationaleFields,
      tradeoff: "false",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an item where promotional is not one of the enum values", () => {
    const result = CurationItemSchema.safeParse({
      index: 1,
      title: "テスト",
      summary: validSummary,
      category: "その他",
      tag: "trend",
      ...validUsefulness,
      ...validRationaleFields,
      promotional: "false",
    });
    expect(result.success).toBe(false);
  });

  it("accepts all three promotional enum values", () => {
    for (const promotional of ["none", "light", "heavy"] as const) {
      const result = CurationItemSchema.safeParse({
        index: 1,
        title: "テスト",
        summary: validSummary,
        category: "その他",
        tag: "trend",
        ...validUsefulness,
        ...validRationaleFields,
        promotional,
      });
      expect(result.success).toBe(true);
    }
  });

  it("does not accept a numeric score in place of the boolean criteria", () => {
    const result = CurationItemSchema.safeParse({
      index: 1,
      title: "テスト",
      summary: validSummary,
      category: "その他",
      tag: "trend",
      ...validUsefulness,
      ...validRationaleFields,
      firsthand: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe("topicAnchor validation (plan 07 §5-M1 / §6-Q1,Q5: rationaleText / evidenceSufficient removed from LLM output)", () => {
  it("rejects topicAnchor longer than 40 characters", () => {
    const result = CurationItemSchema.safeParse({
      index: 1,
      title: "テスト",
      summary: validSummary,
      category: "その他",
      tag: "trend",
      ...validUsefulness,
      topicAnchor: "あ".repeat(45),
    });
    expect(result.success).toBe(false);
  });

  it("rejects item missing topicAnchor", () => {
    const result = CurationItemSchema.safeParse({
      index: 1,
      title: "テスト",
      summary: validSummary,
      category: "その他",
      tag: "trend",
      ...validUsefulness,
    });
    expect(result.success).toBe(false);
  });

  it("does not accept a rationaleText field even when supplied (schema no longer defines it, so zod just ignores/strips it rather than rejecting)", () => {
    const result = CurationItemSchema.safeParse({
      index: 1,
      title: "テスト",
      summary: validSummary,
      category: "その他",
      tag: "trend",
      ...validUsefulness,
      ...validRationaleFields,
      rationaleText: "LLM が生成した自由文（もはやスキーマに存在しないフィールド）",
      evidenceSufficient: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("rationaleText");
      expect(result.data).not.toHaveProperty("evidenceSufficient");
    }
  });

  it("asserts prompt no longer instructs the LLM to generate rationaleText / evidenceSufficient", () => {
    const prompt = buildSingleCurationPrompt({ title: "テスト", excerpt: "テスト本文" });
    expect(prompt).toContain("結論のアンカー");
    expect(prompt).not.toContain("rationaleText");
    expect(prompt).not.toContain("evidenceSufficient");
  });
});

describe("CurationBatchResponseSchema", () => {
  it("accepts a well-formed batch response", () => {
    const result = CurationBatchResponseSchema.safeParse({
      items: [
        {
          index: 1,
          title: "A",
          summary: validSummary,
          category: "その他",
          tag: "trend",
          ...validUsefulness,
          ...validRationaleFields,
        },
        {
          index: 2,
          title: "B",
          summary: validSummary,
          category: "その他",
          tag: "classic",
          ...validUsefulness,
          ...validRationaleFields,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a response missing the items array", () => {
    const result = CurationBatchResponseSchema.safeParse({ results: [] });
    expect(result.success).toBe(false);
  });
});
