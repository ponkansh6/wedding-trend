import {
  USEFULNESS_WEIGHT_FIRSTHAND,
  USEFULNESS_WEIGHT_CEREMONY_DECISION,
  USEFULNESS_WEIGHT_SPECIFIC,
  USEFULNESS_WEIGHT_WEDDING_DAY,
  USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY,
  USEFULNESS_GATE_BONUS,
} from "@/lib/constants";

/**
 * LLM から受け取る判定項目 5 つ。すべて 0/1/2 の三段階（degree）。LLM には
 * この整数だけを出させ、点数（重み付け合計）は一切出させない。重み付け
 * （`computeUsefulnessScore`）をコード側に閉じ込めることで、重み調整が
 * 再課金ゼロのコード変更だけで完結する。
 *
 * 定義は `openspec/specs/wedding-trend/spec.md` の編集方針セクション（§9.3）を
 * 唯一の参照先とする（ここでは重複記載しない）。
 *
 * 2026-08-30: 旧仕様（5 boolean + `promotional` の3段階 enum）から、全項目
 * 0/1/2 の整数へ変更。旧 `preDecisionOrPhotoShoot` は廃止し `weddingDayContent`
 * に吸収した（`weddingDayContent = 0` が「フルパッケージ結婚式の当日内容では
 * ない＝フォト婚・前撮り・式場探し・準備段階のみ」を意味する）。
 */
export type CriterionLevel = 0 | 1 | 2;

/**
 * 判定値を 0/1/2 に正規化する。新レコードは整数、旧レコードの boolean は
 * 読み取り時にここで吸収する（DB マイグレーションは行わない）。
 * `true → 2`（旧仕様で「該当する」と判定されたものは最上位相当）、`false → 0`。
 * bump + 全件再キュレーションで旧レコードは速やかに整数へ置き換わるため、
 * この吸収は移行期の短期間のみ効く。
 */
export function normalizeCriterion(value: unknown): CriterionLevel {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 2) return 2;
    if (value >= 1) return 1;
    return 0;
  }
  if (value === true) return 2;
  return 0;
}

/**
 * `criteria_json` の `promotional` を 0/1/2 に正規化する。新レコードは整数、
 * 旧レコードの文字列 enum（`none/light/heavy`）と boolean をここで吸収する。
 * 旧 `heavy → 2`、旧 `light → 1`、旧 `none → 0`。旧 boolean `true → 1`
 * （旧「宣伝要素あり」は新仕様の減点対象＝2 ではなく light 相当に降格）。
 */
export function normalizePromotional(value: unknown): CriterionLevel {
  if (value === "heavy") return 2;
  if (value === "light") return 1;
  if (value === "none") return 0;
  if (value === true) return 1;
  return normalizeCriterion(value);
}

export interface UsefulnessCriteria {
  /** 書き手自身または近しい当事者が実際に挙式・披露宴を経験した立場から書かれているか（0-2）。 */
  firsthand: CriterionLevel;
  /** 挙式・披露宴の「中身」の意思決定に効く内容か（0-2）。`>= 1` かつ `weddingDayContent >= 1` でゲート通過。 */
  ceremonyDecision: CriterionLevel;
  /** 当日の実施内容の具体性（固有の選択・数値・実際にやったこと/やらなかった理由の明確さ）（0-2）。 */
  specific: CriterionLevel;
  /** フルパッケージ結婚式（挙式＋披露宴）の当日内容を扱っているか（0-2）。`0` はフォト婚・前撮り・式場探し・準備段階のみ。 */
  weddingDayContent: CriterionLevel;
  /** 事業者による集客・自社サービスへの誘導の度合い（0-2。`2` のときのみ減点）。 */
  promotional: CriterionLevel;
}

/**
 * スコア未付与（キュレーション失敗、原文抽出不可等）の投稿に使う固定値。
 *
 * 現在の式では、ゲート通過帯の下限（`USEFULNESS_GATE_BONUS` のみ = 12）より
 * 下、かつ全項目 false（0点）より上の「楽観的な中位」に意図的に置く。
 * 無条件で最下位に落とすと、一時的な LLM 失敗で新着の良記事が静かに埋もれて
 * しまう。次回 ingest で `signature` 不一致として再スコアされれば、自然に
 * 正しい位置へ移動する——それまでの間だけ「判定保留」として中位に留め置く
 * 値である（ゲート帯 `USEFULNESS_GATE_BONUS = 16` 未満・全項目 0（0点）より上）。
 */
export const UNSCORED_USEFULNESS_SCORE = 4;

/**
 * 5 つの 0/1/2 判定から有用度スコアを計算する純関数（2026-08-30 に boolean 版から改訂）。
 *
 * ```
 * gate  = (ceremonyDecision >= 1 && weddingDayContent >= 1) ? USEFULNESS_GATE_BONUS : 0
 * score = gate
 *       + USEFULNESS_WEIGHT_CEREMONY_DECISION * ceremonyDecision
 *       + USEFULNESS_WEIGHT_FIRSTHAND         * firsthand
 *       + USEFULNESS_WEIGHT_SPECIFIC          * specific
 *       + USEFULNESS_WEIGHT_WEDDING_DAY       * weddingDayContent
 *       - USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY * (promotional === 2 ? 1 : 0)
 * ```
 *
 * **ゲート**: `ceremonyDecision` と `weddingDayContent` はそれぞれ加点項でありつつ、
 * 両方 `>= 1` のときだけ `USEFULNESS_GATE_BONUS` を付ける関門でもある。もし
 * 単純な加点項だけにすると「衣装だけの記事だが firsthand=2・specific=2・
 * weddingDayContent=2」が「式の中身に効くが浅い記事」を上回り、オーナーの
 * 意図（これから式の中身を決める読者に効く記事を優先）が反転する。旧
 * `preDecisionOrPhotoShoot`（式決定前/別撮影の話題）は `weddingDayContent = 0`
 * に吸収済み——フォト婚・前撮り・式場探し・準備段階のみの記事は
 * `weddingDayContent = 0` となりゲート不通過帯に沈む。
 *
 * **強支配不変条件**（「ゲート通過帯は常にゲート不通過帯に優先する」）:
 * ゲート不通過の最大 = `2×(W_FIRSTHAND + W_SPECIFIC + W_WEDDING_DAY)` = 14
 * （`ceremonyDecision = 0`、他が最大の場合。`weddingDayContent = 0` かつ
 * `ceremonyDecision = 2` の場合も `2×(W_CEREMONY + W_FIRSTHAND + W_SPECIFIC)` = 14）。
 * ゲート通過の最小 = `GATE_BONUS + W_CEREMONY×1 + W_WEDDING_DAY×1 - PROMO_PENALTY`
 * （`cd=1, wdc=1, firsthand=0, specific=0, promotional=2`）= `16 + 2 + 2 - 4` = 16 > 14。
 * → `GATE_BONUS + W_CEREMONY + W_WEDDING_DAY - PROMO_PENALTY > 2×(W_FIRSTHAND + W_SPECIFIC + W_WEDDING_DAY)`
 * を `tests/usefulness-score.test.ts` で定数から式を組んで固定している。
 *
 * **重み**: firsthand（3）> ceremonyDecision / specific / weddingDayContent（各 2）は、
 * 抜粋（記事冒頭）からの判定しやすさに比例させたもの。`promotional` の減点（4）は
 * ゲート通過記事でも宣伝目的記事を上位に出さない編集方針の強さを反映し、
 * `promotional === 2`（過剰かつ明確な誘導）のときのみ発火する。
 */
export function computeUsefulnessScore(criteria: UsefulnessCriteria): number {
  const gate =
    criteria.ceremonyDecision >= 1 && criteria.weddingDayContent >= 1 ? USEFULNESS_GATE_BONUS : 0;
  const ceremonyDecision = USEFULNESS_WEIGHT_CEREMONY_DECISION * criteria.ceremonyDecision;
  const firsthand = USEFULNESS_WEIGHT_FIRSTHAND * criteria.firsthand;
  const specific = USEFULNESS_WEIGHT_SPECIFIC * criteria.specific;
  const weddingDayContent = USEFULNESS_WEIGHT_WEDDING_DAY * criteria.weddingDayContent;
  const promotionalPenalty = criteria.promotional >= 2 ? USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY : 0;

  return gate + ceremonyDecision + firsthand + specific + weddingDayContent - promotionalPenalty;
}
