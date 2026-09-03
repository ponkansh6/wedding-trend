import { describe, it, expect, vi } from "vitest";
import { curateTopicsBatch, shadowEvaluateTopics } from "@/lib/llm/topics-batch";

describe("topics-batch pipeline", () => {
  it("handles empty input correctly", async () => {
    const res = await curateTopicsBatch([]);
    expect(res.size).toBe(0);
  });

  it("shadowEvaluateTopics computes match rate correctly", async () => {
    const inputs = [
      { id: "1", title: "Test Title 1", slice: "Test slice text 1" },
      { id: "2", title: "Test Title 2", slice: "Test slice text 2" },
    ];
    const currentMap = new Map<string, string[]>([
      ["1", ["準備", "衣装"]],
      ["2", ["式場"]],
    ]);

    const evaluation = await shadowEvaluateTopics(inputs, currentMap);
    expect(evaluation).toHaveProperty("matchRate");
    expect(evaluation).toHaveProperty("details");
    expect(evaluation.details.length).toBe(2);
  });
});
