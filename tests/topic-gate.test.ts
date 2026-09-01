import { describe, it, expect } from "vitest";
import { CurationItemSchema } from "@/lib/llm/schemas";
import { validateTopics } from "@/lib/publish/gate";

describe("Topic Tag Validation & Gate", () => {
  it("filters out topics containing digits via schema transform rather than failing", () => {
    const result = CurationItemSchema.safeParse({
      index: 1,
      title: "テストタイトル",
      summary:
        "これはテスト用の要約文です。60文字を超える十分な長さを持たせるために、この文章は長めに書いています。これでスキーマの検証を通過できます。",
      category: "準備・段取り",
      tag: "trend",
      firsthand: 5,
      ceremonyDecision: 5,
      specific: 5,
      weddingDayContent: 5,
      promotional: 0,
      topicAnchor: "テストアンカーの文言です",
      topics: ["準備3万円", "心構え"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.topics).toEqual(["心構え"]);
    }
  });

  it("filters out topics longer than 10 characters via schema transform rather than failing", () => {
    const result = CurationItemSchema.safeParse({
      index: 1,
      title: "テストタイトル",
      summary:
        "これはテスト用の要約文です。60文字を超える十分な長さを持たせるために、この文章は長めに書いています。これでスキーマの検証を通過できます。",
      category: "準備・段取り",
      tag: "trend",
      firsthand: 5,
      ceremonyDecision: 5,
      specific: 5,
      weddingDayContent: 5,
      promotional: 0,
      topicAnchor: "テストアンカーの文言です",
      topics: ["十文字を超える長すぎるトピックタグ", "心構え"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.topics).toEqual(["心構え"]);
    }
  });

  it("slices topics to max 4 items when 5 or more are returned", () => {
    const result = CurationItemSchema.safeParse({
      index: 1,
      title: "テストタイトル",
      summary:
        "これはテスト用の要約文です。60文字を超える十分な長さを持たせるために、この文章は長めに書いています。これでスキーマの検証を通過できます。",
      category: "準備・段取り",
      tag: "trend",
      firsthand: 5,
      ceremonyDecision: 5,
      specific: 5,
      weddingDayContent: 5,
      promotional: 0,
      topicAnchor: "テストアンカーの文言です",
      topics: ["トピック一", "トピック二", "トピック三", "トピック四", "トピック五"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.topics.length).toBe(4);
      expect(result.data.topics).toEqual(["トピック一", "トピック二", "トピック三", "トピック四"]);
    }
  });

  it("allows 1 item or empty array without schema failure", () => {
    const result = CurationItemSchema.safeParse({
      index: 1,
      title: "テストタイトル",
      summary:
        "これはテスト用の要約文です。60文字を超える十分な長さを持たせるために、この文章は長めに書いています。これでスキーマの検証を通過できます。",
      category: "準備・段取り",
      tag: "trend",
      firsthand: 5,
      ceremonyDecision: 5,
      specific: 5,
      weddingDayContent: 5,
      promotional: 0,
      topicAnchor: "テストアンカーの文言です",
      topics: ["心構え"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.topics).toEqual(["心構え"]);
    }
  });

  it("drops ungrounded proper nouns in validateTopics", () => {
    const title = "結婚式準備の基本";
    const topics = ["ハレの日会場名", "準備"];
    const res = validateTopics(topics, title);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.topics).not.toContain("ハレの日会場名");
    }
  });

  it("removes duplicate topics and normalizes", () => {
    const title = "結婚式準備の基本について";
    const topics = ["準備の進め方", "準備の進め方", "心構え"];
    const res = validateTopics(topics, title);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.topics.filter((t) => t === "準備の進め方").length).toBe(1);
    }
  });
});
