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
  preDecisionOrPhotoShoot: false,
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
      preDecisionOrPhotoShoot: true,
    };
    // preDecisionOrPhotoShoot: true によりゲート不通過となるため、ゲートの 10 が消え、
    // 残りの和 3 (firsthand) + 2 (specific) + 2 (tradeoff) - 4 (promotional) = 3 となる。
    expect(computeUsefulnessScore(allTrue)).toBe(3);
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

  it("preDecisionOrPhotoShoot true blocks the gate even when ceremonyDecision is true", () => {
    const photoShoot = computeUsefulnessScore({
      ...ALL_FALSE,
      ceremonyDecision: true,
      preDecisionOrPhotoShoot: true,
      firsthand: true,
      specific: true,
      tradeoff: true,
    });
    // ゲート不通過 → 3+2+2 = 7（ゲート不通過帯）。ceremonyDecision のみの 10 より下。
    expect(photoShoot).toBe(7);
    expect(photoShoot).toBeLessThan(
      computeUsefulnessScore({ ...ALL_FALSE, ceremonyDecision: true }),
    );
  });

  it("photo-wedding equivalent scores lower than a Canva-DIY equivalent (core change of plan 02)", () => {
    const photoWedding = computeUsefulnessScore({
      ...ALL_FALSE,
      firsthand: true,
      ceremonyDecision: true,
      specific: true,
      tradeoff: true,
      preDecisionOrPhotoShoot: true,
    }); // ゲート不通過 → 7
    const canvaDiy = computeUsefulnessScore({
      ...ALL_FALSE,
      firsthand: true,
      ceremonyDecision: true,
      specific: true,
    }); // 15
    expect(photoWedding).toBeLessThan(canvaDiy);
  });

  it("preDecisionOrPhotoShoot article stays above a gate-passing promotional article (no double penalty)", () => {
    const preShoot = computeUsefulnessScore({
      ...ALL_FALSE,
      firsthand: true,
      ceremonyDecision: true,
      specific: true,
      tradeoff: true,
      preDecisionOrPhotoShoot: true,
    }); // 7
    const promotional = computeUsefulnessScore({
      ...ALL_FALSE,
      ceremonyDecision: true,
      promotional: true,
    }); // 6
    // 独立減点（-8）にしていないため、宣伝記事より上に留まる（二重計上していないことの確認）。
    expect(preShoot).toBeGreaterThan(promotional);
  });
});
