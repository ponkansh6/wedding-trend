import { describe, it, expect } from "vitest";
import { assertNoSliceLeak } from "../scripts/lib/content-topic-backfill.mjs";

describe("topics slice non-persistence check", () => {
  it("rejects updates containing prohibited topics judgement slice keys", () => {
    const leakedUpdate = {
      postId: "test-post-1",
      topics: ["fashion", "venue"],
      promptVersion: "v1",
      slice: "Prohibited judgement slice containing raw text or prompt residue",
    };

    expect(() => assertNoSliceLeak(leakedUpdate)).toThrowError();
  });

  it("passes clean topics updates without any leaked slice keys", () => {
    const cleanUpdate = {
      postId: "test-post-1",
      topics: ["fashion", "venue"],
      promptVersion: "v1",
    };

    expect(() => assertNoSliceLeak(cleanUpdate)).not.toThrow();
  });
});
