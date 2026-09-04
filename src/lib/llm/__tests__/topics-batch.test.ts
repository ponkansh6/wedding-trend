import { describe, it, expect, vi } from "vitest";
import { curateTopicsBatch, shadowEvaluateTopics } from "../topics-batch";

const { callGeminiMock } = vi.hoisted(() => ({
  callGeminiMock: vi.fn().mockResolvedValue(
    JSON.stringify({
      items: [
        { id: "1", topics: ["準備", "衣装"] },
        { id: "2", topics: ["式場"] },
      ],
    }),
  ),
}));

vi.mock("../client", () => ({
  callGemini: callGeminiMock,
  backoffMs: vi.fn(() => 0),
}));

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
    expect(evaluation.matchRate).toBe(1);
    expect(evaluation.details).toEqual([
      { id: "1", current: ["準備", "衣装"], candidate: ["準備", "衣装"] },
      { id: "2", current: ["式場"], candidate: ["式場"] },
    ]);
    expect(callGeminiMock).toHaveBeenCalledOnce();
  });
});
