import { describe, expect, it } from "vitest";
import {
  USEFULNESS_GATE_BONUS,
  USEFULNESS_WEIGHT_CEREMONY_DECISION,
  USEFULNESS_WEIGHT_FIRSTHAND,
  USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY,
  USEFULNESS_WEIGHT_SPECIFIC,
  USEFULNESS_WEIGHT_WEDDING_DAY,
} from "@/lib/constants";
import {
  computeUsefulnessScore,
  normalizeCriterion,
  normalizePromotional,
  UNSCORED_USEFULNESS_SCORE,
  type UsefulnessCriteria,
} from "@/lib/scoring/usefulness";

/** 全項目 0 のベースライン。個々のテストで必要な項目だけ上書きする。 */
const ALL_ZERO: UsefulnessCriteria = {
  firsthand: 0,
  ceremonyDecision: 0,
  specific: 0,
  weddingDayContent: 0,
  promotional: 0,
};

/** リテラル 0/1/2 が `number` へ広がるのを避けつつ部分上書きするヘルパ。 */
const score = (over: Partial<Record<keyof UsefulnessCriteria, number>>) =>
  computeUsefulnessScore({ ...ALL_ZERO, ...over } as UsefulnessCriteria);

describe("computeUsefulnessScore (0-2 三段階)", () => {
  it("boundary: 全項目 0 は 0 点", () => {
    expect(computeUsefulnessScore(ALL_ZERO)).toBe(0);
  });

  it("ゲート: ceremonyDecision>=1 かつ weddingDayContent>=1 で GATE_BONUS が付く", () => {
    expect(score({ ceremonyDecision: 1 })).toBe(USEFULNESS_WEIGHT_CEREMONY_DECISION * 1); // weddingDayContent=0 なのでゲート不通過
    expect(score({ ceremonyDecision: 1, weddingDayContent: 1 })).toBe(
      USEFULNESS_GATE_BONUS +
        USEFULNESS_WEIGHT_CEREMONY_DECISION * 1 +
        USEFULNESS_WEIGHT_WEDDING_DAY * 1,
    );
  });

  it("各項目は自分の重み × 値（0/1/2）を独立に加算する", () => {
    const gate = { ceremonyDecision: 2, weddingDayContent: 2 };
    const base = score(gate);
    expect(score({ ...gate, firsthand: 1 }) - base).toBe(USEFULNESS_WEIGHT_FIRSTHAND);
    expect(score({ ...gate, firsthand: 2 }) - base).toBe(2 * USEFULNESS_WEIGHT_FIRSTHAND);
    expect(score({ ...gate, specific: 2 }) - base).toBe(2 * USEFULNESS_WEIGHT_SPECIFIC);
  });

  it("promotional は 2（heavy）のときのみ減点。0/1 は無罰則", () => {
    const gate = { ceremonyDecision: 2, weddingDayContent: 2 };
    const base = score(gate);
    expect(score({ ...gate, promotional: 1 })).toBe(base);
    expect(base - score({ ...gate, promotional: 2 })).toBe(USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY);
  });

  it("フォト婚相当（weddingDayContent=0）はゲート不通過帯に沈む（旧 preDecisionOrPhotoShoot の吸収）", () => {
    const photoWedding = score({
      firsthand: 2,
      ceremonyDecision: 2,
      specific: 2,
      weddingDayContent: 0, // フォト婚・前撮り・準備段階のみ
    });
    const realWeddingDay = score({
      firsthand: 2,
      ceremonyDecision: 2,
      specific: 2,
      weddingDayContent: 2,
    });
    expect(photoWedding).toBeLessThan(realWeddingDay);
    expect(photoWedding).toBeLessThan(USEFULNESS_GATE_BONUS);
  });

  it("UNSCORED はゲート通過帯の下限未満・0 超の中位に置かれる", () => {
    const gatePassingFloor = score({ ceremonyDecision: 1, weddingDayContent: 1, promotional: 2 });
    expect(UNSCORED_USEFULNESS_SCORE).toBeLessThan(gatePassingFloor);
    expect(UNSCORED_USEFULNESS_SCORE).toBeGreaterThan(computeUsefulnessScore(ALL_ZERO));
  });

  it("強支配不変条件: どんなゲート通過記事も、あらゆるゲート不通過記事に勝つ（定数から式を組んで固定）", () => {
    // ゲート通過の最小（cd=1, wdc=1, 他0, promotional=2）
    const worstGatePassing = score({ ceremonyDecision: 1, weddingDayContent: 1, promotional: 2 });
    // ゲート不通過の最大: ceremonyDecision=0 で他を総取り
    const bestGateFailingA = score({ firsthand: 2, specific: 2, weddingDayContent: 2 });
    // ゲート不通過の最大: weddingDayContent=0 で ceremonyDecision=2
    const bestGateFailingB = score({ ceremonyDecision: 2, firsthand: 2, specific: 2 });

    expect(worstGatePassing).toBeGreaterThan(bestGateFailingA);
    expect(worstGatePassing).toBeGreaterThan(bestGateFailingB);

    // 定数レベルの不変条件（重みを変えて破れたらここが落ちる）
    expect(
      USEFULNESS_GATE_BONUS +
        USEFULNESS_WEIGHT_CEREMONY_DECISION +
        USEFULNESS_WEIGHT_WEDDING_DAY -
        USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY,
    ).toBeGreaterThan(
      2 *
        (USEFULNESS_WEIGHT_FIRSTHAND + USEFULNESS_WEIGHT_SPECIFIC + USEFULNESS_WEIGHT_WEDDING_DAY),
    );
    expect(
      USEFULNESS_GATE_BONUS +
        USEFULNESS_WEIGHT_CEREMONY_DECISION +
        USEFULNESS_WEIGHT_WEDDING_DAY -
        USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY,
    ).toBeGreaterThan(
      2 *
        (USEFULNESS_WEIGHT_CEREMONY_DECISION +
          USEFULNESS_WEIGHT_FIRSTHAND +
          USEFULNESS_WEIGHT_SPECIFIC),
    );
  });
});

describe("normalizeCriterion", () => {
  it("整数 0/1/2 はそのまま", () => {
    expect(normalizeCriterion(0)).toBe(0);
    expect(normalizeCriterion(1)).toBe(1);
    expect(normalizeCriterion(2)).toBe(2);
  });
  it("範囲外の数値は clamp", () => {
    expect(normalizeCriterion(3)).toBe(2);
    expect(normalizeCriterion(-1)).toBe(0);
    expect(normalizeCriterion(1.7)).toBe(1);
  });
  it("旧 boolean を吸収（true→2 / false→0）", () => {
    expect(normalizeCriterion(true)).toBe(2);
    expect(normalizeCriterion(false)).toBe(0);
  });
  it("その他は 0", () => {
    expect(normalizeCriterion(undefined)).toBe(0);
    expect(normalizeCriterion(null)).toBe(0);
    expect(normalizeCriterion("2")).toBe(0);
    expect(normalizeCriterion(NaN)).toBe(0);
  });
});

describe("normalizePromotional", () => {
  it("新 0/1/2 はそのまま", () => {
    expect(normalizePromotional(0)).toBe(0);
    expect(normalizePromotional(1)).toBe(1);
    expect(normalizePromotional(2)).toBe(2);
  });
  it("旧文字列 enum を吸収（none→0 / light→1 / heavy→2）", () => {
    expect(normalizePromotional("none")).toBe(0);
    expect(normalizePromotional("light")).toBe(1);
    expect(normalizePromotional("heavy")).toBe(2);
  });
  it("旧 boolean を吸収（true→1（減点対象の 2 には昇格しない）/ false→0）", () => {
    expect(normalizePromotional(true)).toBe(1);
    expect(normalizePromotional(false)).toBe(0);
  });
  it("その他は 0", () => {
    expect(normalizePromotional(undefined)).toBe(0);
    expect(normalizePromotional(null)).toBe(0);
    expect(normalizePromotional("HEAVY")).toBe(0);
  });
});
