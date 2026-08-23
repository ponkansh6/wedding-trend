import { describe, expect, it } from "vitest";
import {
  USEFULNESS_GATE_BONUS,
  USEFULNESS_WEIGHT_FIRSTHAND,
  USEFULNESS_WEIGHT_PRE_DECISION_PENALTY,
  USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY,
  USEFULNESS_WEIGHT_SPECIFIC,
  USEFULNESS_WEIGHT_TRADEOFF,
} from "@/lib/constants";
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

  it("boundary: all criteria true fails the gate (preDecisionOrPhotoShoot=true) and pays both the promotional and pre-decision penalties", () => {
    const allTrue: UsefulnessCriteria = {
      firsthand: true,
      ceremonyDecision: true,
      specific: true,
      tradeoff: true,
      promotional: true,
      preDecisionOrPhotoShoot: true,
    };
    // preDecisionOrPhotoShoot: true によりゲート不通過となるため、ゲート分は 0。
    // 残りは firsthand(3) + specific(2) + tradeoff(2) - promotional(4) -
    // preDecisionPenalty(3) = 0。定数から組み立てて検証する。
    const expected =
      USEFULNESS_WEIGHT_FIRSTHAND +
      USEFULNESS_WEIGHT_SPECIFIC +
      USEFULNESS_WEIGHT_TRADEOFF -
      USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY -
      USEFULNESS_WEIGHT_PRE_DECISION_PENALTY;
    expect(computeUsefulnessScore(allTrue)).toBe(expected);
  });

  it("each positive criterion adds its own weight independently of the others", () => {
    const gateOnly = computeUsefulnessScore({ ...ALL_FALSE, ceremonyDecision: true });

    expect(
      computeUsefulnessScore({ ...ALL_FALSE, ceremonyDecision: true, firsthand: true }) - gateOnly,
    ).toBe(USEFULNESS_WEIGHT_FIRSTHAND);
    expect(
      computeUsefulnessScore({ ...ALL_FALSE, ceremonyDecision: true, specific: true }) - gateOnly,
    ).toBe(USEFULNESS_WEIGHT_SPECIFIC);
    expect(
      computeUsefulnessScore({ ...ALL_FALSE, ceremonyDecision: true, tradeoff: true }) - gateOnly,
    ).toBe(USEFULNESS_WEIGHT_TRADEOFF);
  });

  it("promotional subtracts its own weight independently, regardless of the other criteria", () => {
    const gateOnly = computeUsefulnessScore({ ...ALL_FALSE, ceremonyDecision: true });
    const gateAndPromotional = computeUsefulnessScore({
      ...ALL_FALSE,
      ceremonyDecision: true,
      promotional: true,
    });

    expect(gateOnly - gateAndPromotional).toBe(USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY);
  });

  it("preDecisionOrPhotoShoot subtracts its own weight independently of ceremonyDecision", () => {
    // ゲートの AND 条件（ceremonyDecision && !preDecisionOrPhotoShoot）とは別に、
    // preDecisionOrPhotoShoot は単独の減点としても効く。ceremonyDecision の
    // 値に関わらず、この減点だけが差分になる。
    const withoutPreDecision = computeUsefulnessScore({
      ...ALL_FALSE,
      firsthand: true,
      specific: true,
    });
    const withPreDecision = computeUsefulnessScore({
      ...ALL_FALSE,
      firsthand: true,
      specific: true,
      preDecisionOrPhotoShoot: true,
    });

    expect(withoutPreDecision - withPreDecision).toBe(USEFULNESS_WEIGHT_PRE_DECISION_PENALTY);
  });

  it("even a promotional gate-passing article still outranks the richest possible gate-failing article (strong domination, 10→12 の理由そのもの)", () => {
    // 10 のままだと、ゲートを通過したが宣伝判定を受けた記事（10-4=6）が、
    // ゲート不通過だが他の加点項目を総取りした記事（3+2+2=7）に負けていた。
    // GATE_BONUS を 12 に引き上げたことで、この逆転が構造的に起きなくなる
    // ことを確認する（オーナー判断の核心）。
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

    expect(barelyQualifyingButPromotional).toBeGreaterThan(richestNonGatePassing);
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
    // ゲート不通過 → firsthand(3)+specific(2)+tradeoff(2) - preDecisionPenalty(3)。
    // ceremonyDecision のみの USEFULNESS_GATE_BONUS より下。
    const expected =
      USEFULNESS_WEIGHT_FIRSTHAND +
      USEFULNESS_WEIGHT_SPECIFIC +
      USEFULNESS_WEIGHT_TRADEOFF -
      USEFULNESS_WEIGHT_PRE_DECISION_PENALTY;
    expect(photoShoot).toBe(expected);
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
    }); // ゲート不通過 → 3+2+2-3(preDecisionPenalty) = 4
    const canvaDiy = computeUsefulnessScore({
      ...ALL_FALSE,
      firsthand: true,
      ceremonyDecision: true,
      specific: true,
    }); // ゲート通過 → 12+3+2 = 17
    expect(photoWedding).toBeLessThan(canvaDiy);
  });

  it("preDecisionOrPhotoShoot now pays both the lost gate and the independent penalty (double effect, not double-avoided)", () => {
    // 以前は preDecisionOrPhotoShoot はゲートの AND 条件でしか効かず、独立減点が
    // 無かったため「宣伝記事より上に留まる」挙動だった。今回オーナー判断で
    // 独立減点を追加したため、この関係は反転しうる——ここではその反転を
    // 固定する（意図した仕様変更であることの記録）。
    const preShoot = computeUsefulnessScore({
      ...ALL_FALSE,
      firsthand: true,
      ceremonyDecision: true,
      specific: true,
      tradeoff: true,
      preDecisionOrPhotoShoot: true,
    }); // 3+2+2-3 = 4
    const promotional = computeUsefulnessScore({
      ...ALL_FALSE,
      ceremonyDecision: true,
      promotional: true,
    }); // 12-4 = 8
    expect(preShoot).toBeLessThan(promotional);
  });

  it("invariant: gate-passing always outranks gate-failing, even a promotional gate-passer against the richest possible gate-failer", () => {
    // 強支配（strong domination）不変条件。定数から式を組み立てて検証するため、
    // USEFULNESS_GATE_BONUS や合計値をここに直書きしない——定数を変えて
    // この不変条件が破れたら、このテストが落ちる。
    const worstGatePassing = computeUsefulnessScore({
      ...ALL_FALSE,
      ceremonyDecision: true,
      promotional: true,
    });
    const bestGateFailing = computeUsefulnessScore({
      ...ALL_FALSE,
      firsthand: true,
      specific: true,
      tradeoff: true,
    });

    expect(worstGatePassing).toBeGreaterThan(bestGateFailing);
    expect(USEFULNESS_GATE_BONUS - USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY).toBeGreaterThan(
      USEFULNESS_WEIGHT_FIRSTHAND + USEFULNESS_WEIGHT_SPECIFIC + USEFULNESS_WEIGHT_TRADEOFF,
    );
  });
});
