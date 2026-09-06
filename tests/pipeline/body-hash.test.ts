import { describe, expect, it } from "vitest";
import { bodyHashSimilarity, computeBodyHash } from "@/lib/pipeline/body-hash";

describe("discovery-ingest: computeBodyHash / bodyHashSimilarity", () => {
  it("同一入力は同一ハッシュになる（決定的）", () => {
    const text = "同じ本文です。".repeat(20);
    expect(computeBodyHash(text)).toBe(computeBodyHash(text));
  });

  it("同一ハッシュ同士の類似度は1", () => {
    const h = computeBodyHash("何らかの本文テキストです。".repeat(10));
    expect(bodyHashSimilarity(h, h)).toBe(1);
  });

  it("大きく異なる本文は類似度が閾値未満になる", () => {
    const a = computeBodyHash("結婚式の準備について書きます。".repeat(30));
    const b = computeBodyHash("全く関係のないプログラミングの話題です。".repeat(30));
    expect(bodyHashSimilarity(a, b)).toBeLessThan(0.7);
  });
});
