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
  CRITERION_MAX,
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

const MAX = CRITERION_MAX; // 9

/** リテラルが `number` へ広がるのを避けつつ部分上書きするヘルパ。 */
const score = (over: Partial<Record<keyof UsefulnessCriteria, number>>) =>
  computeUsefulnessScore({ ...ALL_ZERO, ...over } as UsefulnessCriteria);

describe("computeUsefulnessScore (0-9)", () => {
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

  it("各項目は自分の重み × 値を独立に加算する", () => {
    const gate = { ceremonyDecision: MAX, weddingDayContent: MAX };
    const base = score(gate);
    expect(score({ ...gate, firsthand: 1 }) - base).toBe(USEFULNESS_WEIGHT_FIRSTHAND);
    expect(score({ ...gate, firsthand: MAX }) - base).toBe(MAX * USEFULNESS_WEIGHT_FIRSTHAND);
    expect(score({ ...gate, specific: MAX }) - base).toBe(MAX * USEFULNESS_WEIGHT_SPECIFIC);
  });

  it("promotional は 7 以上のときのみ減点。0〜6 は無罰則", () => {
    const gate = { ceremonyDecision: MAX, weddingDayContent: MAX };
    const base = score(gate);
    expect(score({ ...gate, promotional: 6 })).toBe(base);
    expect(base - score({ ...gate, promotional: 7 })).toBe(USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY);
    expect(base - score({ ...gate, promotional: MAX })).toBe(USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY);
  });

  it("フォト婚相当（weddingDayContent=0）はゲート不通過帯に沈む（旧 preDecisionOrPhotoShoot の吸収）", () => {
    const photoWedding = score({
      firsthand: MAX,
      ceremonyDecision: MAX,
      specific: MAX,
      weddingDayContent: 0,
    });
    const realWeddingDay = score({
      firsthand: MAX,
      ceremonyDecision: MAX,
      specific: MAX,
      weddingDayContent: MAX,
    });
    expect(photoWedding).toBeLessThan(realWeddingDay);
    expect(photoWedding).toBeLessThan(USEFULNESS_GATE_BONUS);
  });

  it("UNSCORED はゲート通過帯の下限未満・0 超の中位に置かれる", () => {
    const gatePassingFloor = score({ ceremonyDecision: 1, weddingDayContent: 1, promotional: MAX });
    expect(UNSCORED_USEFULNESS_SCORE).toBeLessThan(gatePassingFloor);
    expect(UNSCORED_USEFULNESS_SCORE).toBeGreaterThan(computeUsefulnessScore(ALL_ZERO));
  });

  it("強支配不変条件: どんなゲート通過記事も、あらゆるゲート不通過記事に勝つ（定数から式を組んで固定）", () => {
    // ゲート通過の最小（cd=1, wdc=1, 他0, promotional=MAX）
    const worstGatePassing = score({ ceremonyDecision: 1, weddingDayContent: 1, promotional: MAX });
    // ゲート不通過の最大: ceremonyDecision=0 で他を総取り
    const bestGateFailingA = score({ firsthand: MAX, specific: MAX, weddingDayContent: MAX });
    // ゲート不通過の最大: weddingDayContent=0 で ceremonyDecision=MAX
    const bestGateFailingB = score({ ceremonyDecision: MAX, firsthand: MAX, specific: MAX });

    expect(worstGatePassing).toBeGreaterThan(bestGateFailingA);
    expect(worstGatePassing).toBeGreaterThan(bestGateFailingB);

    // 定数レベルの不変条件（重みを変えて破れたらここが落ちる）
    expect(
      USEFULNESS_GATE_BONUS +
        USEFULNESS_WEIGHT_CEREMONY_DECISION +
        USEFULNESS_WEIGHT_WEDDING_DAY -
        USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY,
    ).toBeGreaterThan(
      MAX *
        (USEFULNESS_WEIGHT_FIRSTHAND + USEFULNESS_WEIGHT_SPECIFIC + USEFULNESS_WEIGHT_WEDDING_DAY),
    );
    expect(
      USEFULNESS_GATE_BONUS +
        USEFULNESS_WEIGHT_CEREMONY_DECISION +
        USEFULNESS_WEIGHT_WEDDING_DAY -
        USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY,
    ).toBeGreaterThan(
      MAX *
        (USEFULNESS_WEIGHT_CEREMONY_DECISION +
          USEFULNESS_WEIGHT_FIRSTHAND +
          USEFULNESS_WEIGHT_SPECIFIC),
    );
  });
});

describe("normalizeCriterion", () => {
  it("整数 0〜9 はそのまま", () => {
    expect(normalizeCriterion(0)).toBe(0);
    expect(normalizeCriterion(1)).toBe(1);
    expect(normalizeCriterion(5)).toBe(5);
    expect(normalizeCriterion(9)).toBe(9);
  });
  it("範囲外の数値は clamp", () => {
    expect(normalizeCriterion(10)).toBe(9);
    expect(normalizeCriterion(-1)).toBe(0);
    expect(normalizeCriterion(1.7)).toBe(1);
  });
  it("旧 boolean を吸収（true→9 / false→0）", () => {
    expect(normalizeCriterion(true)).toBe(9);
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
  it("新 0〜9 はそのまま", () => {
    expect(normalizePromotional(0)).toBe(0);
    expect(normalizePromotional(1)).toBe(1);
    expect(normalizePromotional(9)).toBe(9);
  });
  it("旧文字列 enum を吸収（none→0 / light→4 / heavy→9）", () => {
    expect(normalizePromotional("none")).toBe(0);
    expect(normalizePromotional("light")).toBe(4);
    expect(normalizePromotional("heavy")).toBe(9);
  });
  it("旧 boolean を吸収（true→4（減点対象の 7 には昇格しない）/ false→0）", () => {
    expect(normalizePromotional(true)).toBe(4);
    expect(normalizePromotional(false)).toBe(0);
  });
  it("その他は 0", () => {
    expect(normalizePromotional(undefined)).toBe(0);
    expect(normalizePromotional(null)).toBe(0);
    expect(normalizePromotional("HEAVY")).toBe(0);
  });
});
