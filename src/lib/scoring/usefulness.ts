import {
  USEFULNESS_WEIGHT_FIRSTHAND,
  USEFULNESS_WEIGHT_SPECIFIC,
  USEFULNESS_WEIGHT_TRADEOFF,
  USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY,
  USEFULNESS_WEIGHT_PRE_DECISION_PENALTY,
  USEFULNESS_GATE_BONUS,
} from "@/lib/constants";

/**
 * LLM から受け取る判定項目 6 つ。LLM にはこのブール値だけを出させ、点数は
 * 一切出させない。重み付け（`computeUsefulnessScore`）をコード側に閉じ込める
 * ことで、重み調整が再課金ゼロのコード変更だけで完結する。
 *
 * 定義は `openspec/specs/wedding-trend/spec.md` の編集方針セクションを
 * 唯一の参照先とする（ここでは重複記載しない）。
 */
export interface UsefulnessCriteria {
  /** 書き手自身または近しい当事者が実際に挙式・披露宴を経験した立場から書かれている。 */
  firsthand: boolean;
  /** 挙式・披露宴の「中身」の意思決定に効く内容か。 */
  ceremonyDecision: boolean;
  /** 具体（固有の選択・数字・実際にやったこと/やらなかった理由）を含むか。 */
  specific: boolean;
  /** 判断の理由・後悔・「やってよかった/要らなかった」の評価が述べられているか。 */
  tradeoff: boolean;
  /** 事業者による集客・自社サービスへの誘導が主目的か（該当すれば減点）。 */
  promotional: boolean;
  /** 内容がフォトウェディング・前撮り・式場探し等、式決定前/別撮影の話題に限られるか（true ならゲート不通過）。 */
  preDecisionOrPhotoShoot: boolean;
}

/**
 * スコア未付与（キュレーション失敗、原文抽出不可等）の投稿に使う固定値。
 *
 * 現在の式では、ゲート通過帯の下限（`USEFULNESS_GATE_BONUS` のみ = 12）より
 * 下、かつ全項目 false（0点）より上の「楽観的な中位」に意図的に置く。
 * 無条件で最下位に落とすと、一時的な LLM 失敗で新着の良記事が静かに埋もれて
 * しまう。次回 ingest で `signature` 不一致として再スコアされれば、自然に
 * 正しい位置へ移動する——それまでの間だけ「判定保留」として中位に留め置く
 * 値である。`preDecisionOrPhotoShoot` の独立減点により理論上の下限は負の値
 * まで下がりうるが、この定数はあくまで 0 を基準にした中位に据え置く
 * （判定保留を過度に悲観視しないため）。
 */
export const UNSCORED_USEFULNESS_SCORE = 3;

/**
 * 6 つのブール判定から有用度スコアを計算する純関数。
 *
 * ```
 * score = (ceremonyDecision && !preDecisionOrPhotoShoot ? USEFULNESS_GATE_BONUS : 0)
 *       + USEFULNESS_WEIGHT_FIRSTHAND   * firsthand
 *       + USEFULNESS_WEIGHT_SPECIFIC    * specific
 *       + USEFULNESS_WEIGHT_TRADEOFF    * tradeoff
 *       - USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY * promotional
 *       - USEFULNESS_WEIGHT_PRE_DECISION_PENALTY * preDecisionOrPhotoShoot
 * ```
 *
 * `ceremonyDecision` と `preDecisionOrPhotoShoot` は加点項の一つではなく**ゲート**として働く。もし単純な
 * 加点項にすると、「衣装だけの記事だが実体験・具体的・トレードオフあり」
 * （3+2+2=7）が「式の中身に触れているが浅い記事」（12）を上回ってしまい、
 * 「これから式の中身を決める読者に効く記事を優先する」というオーナーの
 * 意図が反転する。挙式・披露宴の中身に関する記事であることを他の加点の
 * 前提条件にしつつ、フォト婚・前撮り・式場探し等の話題（`preDecisionOrPhotoShoot === true`）はゲート不通過（0点）とすることで、この逆転を構造的に防ぐ。
 * この強支配（「ゲート通過帯は常にゲート不通過帯に優先する」）が
 * `promotional` 減点を足しても崩れないことは
 * `USEFULNESS_GATE_BONUS - USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY > firsthand+specific+tradeoff の合計`
 * という不変条件として `src/lib/constants.ts` の `USEFULNESS_GATE_BONUS` の
 * JSDoc に明記し、`tests/usefulness-score.test.ts` で定数から式を組み立てて
 * 固定している。
 *
 * `preDecisionOrPhotoShoot` はゲートの AND 条件（安全網）に加えて、
 * `USEFULNESS_WEIGHT_PRE_DECISION_PENALTY` による**独立した減点**としても
 * 働く。ゲートの AND 条件は `ceremonyDecision=true` かつ
 * `preDecisionOrPhotoShoot=true` という組み合わせでしか発火せず、この2項目の
 * 定義上ほぼ両立しないため実測データ（本番 43 件）では発火が 0 件——つまり
 * ゲート条件だけでは `preDecisionOrPhotoShoot=true` の記事は
 * `ceremonyDecision=false` の記事と常に同点になり、掲載順に一切反映され
 * ない。独立減点により、ゲート不通過帯の中でも「フォト婚・前撮り・式場
 * 探しの話題」を後方へ沈められるようにしている（オーナー方針:
 * 「ゲートというよりは、ソートさえできればよい」）。ゲートの AND 条件自体は
 * 安全網として残しており、**現状ほぼ発火しないことを理由に将来削っては
 * ならない**——`ceremonyDecision` の定義が将来広がった場合に備えた保険である。
 *
 * 各項目の重みは、抜粋（記事冒頭）から LLM が判定できる確信度に比例させて
 * いる。話題（ceremonyDecision）・書き手の立場（firsthand）・宣伝性
 * （promotional）は記事冒頭からでも判定しやすい一方、具体性（specific）や
 * トレードオフ（tradeoff）は本文中盤以降にしか現れないことが多く、抜粋だけ
 * からの判定は firsthand/promotional より確信度が落ちる。そのため
 * firsthand（3）> specific/tradeoff（各 2）という重みにしている。
 * promotional の減点（4）を他の加点より大きくしているのは、ゲートを通過した
 * 記事であっても宣伝目的の記事を上位に出さないという編集方針の強さを反映
 * したもの（詳細は spec.md の編集方針セクションを参照）。
 */
export function computeUsefulnessScore(criteria: UsefulnessCriteria): number {
  const gate =
    criteria.ceremonyDecision && !criteria.preDecisionOrPhotoShoot ? USEFULNESS_GATE_BONUS : 0;
  const firsthand = criteria.firsthand ? USEFULNESS_WEIGHT_FIRSTHAND : 0;
  const specific = criteria.specific ? USEFULNESS_WEIGHT_SPECIFIC : 0;
  const tradeoff = criteria.tradeoff ? USEFULNESS_WEIGHT_TRADEOFF : 0;
  const promotionalPenalty = criteria.promotional ? USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY : 0;
  const preDecisionPenalty = criteria.preDecisionOrPhotoShoot
    ? USEFULNESS_WEIGHT_PRE_DECISION_PENALTY
    : 0;

  return gate + firsthand + specific + tradeoff - promotionalPenalty - preDecisionPenalty;
}
