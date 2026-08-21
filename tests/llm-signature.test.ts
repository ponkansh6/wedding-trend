import { describe, expect, it } from "vitest";
import { computeContentHash, computeCurationSignature } from "@/lib/llm/signature";

describe("computeContentHash", () => {
  it("is deterministic for the same title/excerpt", () => {
    const a = computeContentHash("タイトル", "本文");
    const b = computeContentHash("タイトル", "本文");
    expect(a).toBe(b);
  });

  it("changes when the title changes", () => {
    const a = computeContentHash("タイトルA", "本文");
    const b = computeContentHash("タイトルB", "本文");
    expect(a).not.toBe(b);
  });

  it("changes when the excerpt changes", () => {
    const a = computeContentHash("タイトル", "本文A");
    const b = computeContentHash("タイトル", "本文B");
    expect(a).not.toBe(b);
  });

  it("treats null and empty-string excerpt the same way", () => {
    const a = computeContentHash("タイトル", null);
    const b = computeContentHash("タイトル", "");
    expect(a).toBe(b);
  });
});

describe("computeCurationSignature", () => {
  it("is deterministic across calls (same prompt version + model)", () => {
    expect(computeCurationSignature()).toBe(computeCurationSignature());
  });
});

describe("skip logic (content hash + signature match)", () => {
  function shouldSkip(
    stored: { contentHash: string | null; curationSignature: string | null; aiTitle: string | null },
    freshHash: string,
    currentSignature: string,
  ): boolean {
    if (!stored.aiTitle) return false;
    return stored.contentHash === freshHash && stored.curationSignature === currentSignature;
  }

  it("skips when content hash and signature both match", () => {
    const hash = computeContentHash("タイトル", "本文");
    const signature = computeCurationSignature();
    expect(
      shouldSkip({ aiTitle: "既存タイトル", contentHash: hash, curationSignature: signature }, hash, signature),
    ).toBe(true);
  });

  it("does not skip when content changed", () => {
    const oldHash = computeContentHash("タイトル", "旧本文");
    const newHash = computeContentHash("タイトル", "新本文");
    const signature = computeCurationSignature();
    expect(
      shouldSkip(
        { aiTitle: "既存タイトル", contentHash: oldHash, curationSignature: signature },
        newHash,
        signature,
      ),
    ).toBe(false);
  });

  it("does not skip when never curated (aiTitle is null)", () => {
    const hash = computeContentHash("タイトル", "本文");
    const signature = computeCurationSignature();
    expect(shouldSkip({ aiTitle: null, contentHash: null, curationSignature: null }, hash, signature)).toBe(
      false,
    );
  });
});
