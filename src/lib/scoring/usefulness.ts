import {
  USEFULNESS_WEIGHT_FIRSTHAND,
  USEFULNESS_WEIGHT_CEREMONY_DECISION,
  USEFULNESS_WEIGHT_SPECIFIC,
  USEFULNESS_WEIGHT_WEDDING_DAY,
  USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY,
  USEFULNESS_GATE_BONUS,
} from "@/lib/constants";

/**
 * LLM から受け取る判定項目 5 つ。すべて 0〜9 の整数（degree）。LLM には
 * この整数だけを出させ、点数（重み付け合計）は一切出させない。重み付け
 * （`computeUsefulnessScore`）をコード側に閉じ込めることで、重み調整が
 * 再課金ゼロのコード変更だけで完結する。
 *
 * 定義は `openspec/specs/wedding-trend/spec.md` の編集方針セクション（§9.3）を
 * 唯一の参照先とする（ここでは重複記載しない）。
 *
 * 2026-08-30: 旧仕様（5 boolean + `promotional` の3段階 enum）から全項目
 * 0/1/2 の整数へ変更、さらに同日 0〜9 の整数へ拡張（小モデルの degree 解像度向上）。
 * 旧 `preDecisionOrPhotoShoot` は廃止し `weddingDayContent` に吸収した
 * （`weddingDayContent = 0` が「厳密な挙式・披露宴当日の実施内容ではない＝
 * フォト婚・前撮り・式場探し・準備段階・後日談のみ」を意味する）。
 */
/** 判定値のレンジ。2026-08-30 に 0-2 から 0-9 へ拡張（小モデルの degree 解像度向上の試み）。 */
export const CRITERION_MAX = 9;
export type CriterionLevel = number;

/**
 * 判定値を 0〜9 に正規化する。新レコードは整数、旧レコードの boolean / 0-2 は
 * 読み取り時にここで吸収する（DB マイグレーションは行わない）。
 * `true → 9`、`false → 0`、旧 0-2 の整数はそのまま（1/2 は下位帯として扱われる）。
 * bump + 全件再キュレーションで旧レコードは速やかに置き換わるため、この吸収は移行期のみ。
 */
export function normalizeCriterion(value: unknown): CriterionLevel {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(CRITERION_MAX, Math.floor(value)));
  }
  if (value === true) return CRITERION_MAX;
  return 0;
}

/**
 * `criteria_json` の `promotional` を 0〜9 に正規化する。新レコードは整数、
 * 旧レコードの文字列 enum（`none/light/heavy`）と boolean をここで吸収する。
 * 旧 `heavy → 9`、旧 `light → 4`、旧 `none → 0`。旧 boolean `true → 4`
 * （旧「宣伝要素あり」は減点対象＝7 以上ではなく中位に降格）。
 */
export function normalizePromotional(value: unknown): CriterionLevel {
  if (value === "heavy") return CRITERION_MAX;
  if (value === "light") return 4;
  if (value === "none") return 0;
  if (value === true) return 4;
  return normalizeCriterion(value);
}

export interface UsefulnessCriteria {
  /** 書き手自身または近しい当事者が実際に挙式・披露宴を経験した立場から書かれている度合い（0-9）。 */
  firsthand: CriterionLevel;
  /** 挙式・披露宴の「中身」の意思決定に効く度合い（0-9）。`>= 1` かつ `weddingDayContent >= 1` でゲート通過。 */
  ceremonyDecision: CriterionLevel;
  /** 当日の実施内容の具体性（固有の選択・数値・実際にやったこと/やらなかった理由の濃さ）（0-9）。 */
  specific: CriterionLevel;
  /** 厳密に挙式・披露宴の当日の実施内容を扱っている度合い（0-9）。`0` はフォト婚・前撮り・準備段階・後日談のみ。 */
  weddingDayContent: CriterionLevel;
  /** 事業者による集客・自社サービスへの誘導の度合い（0-9。`>= 7` のときのみ減点）。 */
  promotional: CriterionLevel;
}

/**
 * スコア未付与（キュレーション失敗、原文抽出不可等）の投稿に使う固定値。
 *
 * 現在の式では、ゲート通過帯の下限（`USEFULNESS_GATE_BONUS = 70`）より下、
 * かつ全項目 0（0点）より上の「楽観的な中位」に意図的に置く。無条件で最下位に
 * 落とすと、一時的な LLM 失敗で新着の良記事が静かに埋もれてしまう。次回 ingest で
 * `signature` 不一致として再スコアされれば自然に正しい位置へ移動する。
 */
export const UNSCORED_USEFULNESS_SCORE = 20;

/**
 * 5 つの 0〜9 判定から有用度スコアを計算する純関数
 * （2026-08-30 に boolean → 0-2 → 0-9 と改訂）。
 *
 * ```
 * gate  = (ceremonyDecision >= 1 && weddingDayContent >= 1) ? USEFULNESS_GATE_BONUS : 0
 * score = gate
 *       + USEFULNESS_WEIGHT_CEREMONY_DECISION * ceremonyDecision   (0-9)
 *       + USEFULNESS_WEIGHT_FIRSTHAND         * firsthand          (0-9)
 *       + USEFULNESS_WEIGHT_SPECIFIC          * specific           (0-9)
 *       + USEFULNESS_WEIGHT_WEDDING_DAY       * weddingDayContent  (0-9)
 *       - USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY * (promotional >= 7 ? 1 : 0)
 * ```
 *
 * **ゲート**: `ceremonyDecision` と `weddingDayContent` はそれぞれ加点項でありつつ、
 * 両方 `>= 1` のときだけ `USEFULNESS_GATE_BONUS` を付ける関門でもある。フォト婚・
 * 前撮り・準備段階のみの記事は `weddingDayContent = 0` となりゲート不通過帯に沈む
 * （旧 `preDecisionOrPhotoShoot` の吸収）。
 *
 * **強支配不変条件**（「ゲート通過帯は常にゲート不通過帯に優先する」）:
 * ゲート不通過の最大 = `9×(W_FIRSTHAND + W_SPECIFIC + W_WEDDING_DAY)` = 9×7 = 63
 * （`ceremonyDecision = 0`、他が最大。`weddingDayContent = 0` かつ `ceremonyDecision = 9`
 * の場合も `9×(W_CEREMONY + W_FIRSTHAND + W_SPECIFIC)` = 63）。
 * ゲート通過の最小 = `GATE_BONUS + W_CEREMONY×1 + W_WEDDING_DAY×1 - PROMO_PENALTY`
 * （`cd=1, wdc=1, firsthand=0, specific=0, promotional=9`）= `70 + 2 + 2 - 4` = 70 > 63。
 * → `GATE_BONUS + W_CEREMONY + W_WEDDING_DAY - PROMO_PENALTY > 9×(W_FIRSTHAND + W_SPECIFIC + W_WEDDING_DAY)`
 * を `tests/usefulness-score.test.ts` で定数から式を組んで固定している。
 *
 * **重み**: firsthand（3）> ceremonyDecision / specific / weddingDayContent（各 2）。
 * `promotional` の減点（4）は `promotional >= 7`（過剰かつ明確な誘導）のときのみ発火する。
 */
export function computeUsefulnessScore(criteria: UsefulnessCriteria): number {
  const gate =
    criteria.ceremonyDecision >= 1 && criteria.weddingDayContent >= 1 ? USEFULNESS_GATE_BONUS : 0;
  const ceremonyDecision = USEFULNESS_WEIGHT_CEREMONY_DECISION * criteria.ceremonyDecision;
  const firsthand = USEFULNESS_WEIGHT_FIRSTHAND * criteria.firsthand;
  const specific = USEFULNESS_WEIGHT_SPECIFIC * criteria.specific;
  const weddingDayContent = USEFULNESS_WEIGHT_WEDDING_DAY * criteria.weddingDayContent;
  const promotionalPenalty = criteria.promotional >= 7 ? USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY : 0;

  return gate + ceremonyDecision + firsthand + specific + weddingDayContent - promotionalPenalty;
}
