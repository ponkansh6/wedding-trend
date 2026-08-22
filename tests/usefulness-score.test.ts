import { describe, expect, it } from "vitest";
import {
  computeUsefulnessScore,
  UNSCORED_USEFULNESS_SCORE,
  type UsefulnessCriteria,
} from "@/lib/scoring/usefulness";

/** 全項目 false のベースライン。個々のテストで必要な項目だけ true に上書きする。 */
const ALL_FALSE: UsefulnessCriteria = {
  firsthand: false,
  ceremonyDecision: false,
  specific: false,
  tradeoff: false,
  promotional: false,
};

describe("computeUsefulnessScore", () => {
  it("gates on ceremonyDecision: failing the gate outscored by nothing, even with all other criteria true", () => {
    // オーナーの意図の核心: 「衣装だけの記事だが実体験・具体的・トレードオフ
    // あり」が「式の中身に触れているが浅い記事」を上回ってはならない。
    const richButOffTopic = computeUsefulnessScore({
      ...ALL_FALSE,
      firsthand: true,
      specific: true,
      tradeoff: true,
      promotional: true,
    });
    const shallowButOnTopic = computeUsefulnessScore({
      ...ALL_FALSE,
      ceremonyDecision: true,
    });

    expect(richButOffTopic).toBeLessThan(shallowButOnTopic);
  });

  it("boundary: all criteria false scores 0", () => {
    expect(computeUsefulnessScore(ALL_FALSE)).toBe(0);
  });

  it("boundary: all criteria true scores the sum of every weight minus the penalty", () => {
    const allTrue: UsefulnessCriteria = {
      firsthand: true,
      ceremonyDecision: true,
      specific: true,
      tradeoff: true,
      promotional: true,
    };
    // 10 (gate) + 3 (firsthand) + 2 (specific) + 2 (tradeoff) - 4 (promotional)
    expect(computeUsefulnessScore(allTrue)).toBe(13);
  });

  it("each positive criterion adds its own weight independently of the others", () => {
    const gateOnly = computeUsefulnessScore({ ...ALL_FALSE, ceremonyDecision: true });

    expect(
      computeUsefulnessScore({ ...ALL_FALSE, ceremonyDecision: true, firsthand: true }) - gateOnly,
    ).toBe(3);
    expect(
      computeUsefulnessScore({ ...ALL_FALSE, ceremonyDecision: true, specific: true }) - gateOnly,
    ).toBe(2);
    expect(
      computeUsefulnessScore({ ...ALL_FALSE, ceremonyDecision: true, tradeoff: true }) - gateOnly,
    ).toBe(2);
  });

  it("promotional subtracts its own weight independently, regardless of the other criteria", () => {
    const gateOnly = computeUsefulnessScore({ ...ALL_FALSE, ceremonyDecision: true });
    const gateAndPromotional = computeUsefulnessScore({
      ...ALL_FALSE,
      ceremonyDecision: true,
      promotional: true,
    });

    expect(gateOnly - gateAndPromotional).toBe(4);
  });

  it("promotional pulls a gate-passing article down to about the same level as a non-gate-passing article", () => {
    // ゲートを通過しているだけの記事（他は全部 false）が宣伝目的だった場合、
    // ゲートを通過していないが中身の濃い記事（宣伝目的ではない）を下回る。
    const barelyQualifyingButPromotional = computeUsefulnessScore({
      ...ALL_FALSE,
      ceremonyDecision: true,
      promotional: true,
    });
    const richestNonGatePassing = computeUsefulnessScore({
      ...ALL_FALSE,
      firsthand: true,
      specific: true,
      tradeoff: true,
    });

    expect(barelyQualifyingButPromotional).toBeLessThan(richestNonGatePassing);
  });

  it("UNSCORED_USEFULNESS_SCORE sits in the gate-not-passed band: below the gate-passing floor, above the gate-not-passed floor", () => {
    const gatePassingFloor = computeUsefulnessScore({ ...ALL_FALSE, ceremonyDecision: true });
    const nonGatePassingFloor = computeUsefulnessScore(ALL_FALSE);

    expect(UNSCORED_USEFULNESS_SCORE).toBeLessThan(gatePassingFloor);
    expect(UNSCORED_USEFULNESS_SCORE).toBeGreaterThan(nonGatePassingFloor);
  });
});
