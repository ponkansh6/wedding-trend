import { CATEGORIES } from "@/lib/types";
import {
  AI_SUMMARY_TARGET_MAX_CHARS,
  AI_SUMMARY_TARGET_MIN_CHARS,
  AI_TITLE_MAX_CHARS,
} from "@/lib/constants";
import type { CurationInput } from "./schemas";

const CATEGORIES_LIST = CATEGORIES.join("、");

/**
 * 想定読者の定義。openspec/specs/wedding-trend/spec.md §9.1 と**同一の文面**
 * （プロンプトと spec.md とで定義が乖離しないよう意図的に揃えている。変更する
 * 場合は両方を同時に更新すること）。
 *
 * この読者像を要約生成にも読ませることで、要約自体もこの読者が知りたい部分を
 * 残したものになる。これが、有用度判定（下記 USEFULNESS_CRITERIA_RULES）を
 * 採点専用の2パス目にせず、既存のキュレーション呼び出しと同一コールに乗せて
 * いる理由でもある。
 */
const READER_PERSONA = `# 想定読者
想定読者は、挙式日・会場が決まっており、衣装（ドレス・和装）もおおむね決まっている。これから決めるのは挙式・披露宴の中身である —— 進行とタイムライン、演出、席次と席札、余興、スピーチや余興の依頼、BGM、装花、料理、引出物、ペーパーアイテム、写真と映像、ゲストの過ごしやすさ、当日の段取り。この読者が求めているのは「何が人気か」ではなく「実際に式を挙げた人が、何を、なぜそう判断したか」である。`;

/**
 * 有用度判定 5 項目の指示。定義は spec.md §9.2〜§9.4 と同一の内容。
 *
 * 点数（重み付け）は絶対に出力させない。点数は `src/lib/scoring/usefulness.ts`
 * の `computeUsefulnessScore()` がコード側で計算する設計であり、LLM に点数を
 * 出させた瞬間に「重み調整を再課金ゼロのコード変更で完結させる」という設計
 * 全体が無効になる。
 *
 * 意図的に書いていないこと: 「衣装・ドレスの記事を減点せよ」という指示。
 * 衣装のみの記事は `ceremonyDecision` ゲート（コード側の
 * `computeUsefulnessScore`）で構造的に沈む設計のため、ここに二重で書く必要は
 * なく、「衣装のみではない」のような二重否定のブール項目を LLM に判定させると
 * 最も不安定になる。
 */
const USEFULNESS_CRITERIA_RULES = `# 有用度判定（5つのブール値。点数は絶対に出力しないこと）
上記の想定読者にとって役に立つ投稿かどうかを、以下の5項目それぞれについて true/false で判定すること。
- firsthand: 書き手自身または近しい当事者が実際に挙式・披露宴を経験した立場から書かれている。新婦本人に限らず、新郎・両家家族、およびプランナー・司会者・カメラマン・装花担当など式に立ち会う職能者が実務経験に基づいて書いたものを含む。
- ceremonyDecision: 挙式・披露宴の中身の意思決定に効く（進行・タイムライン・演出・席次・席札・余興・スピーチ・BGM・装花・料理・引出物・ペーパーアイテム・挙式当日の写真・映像（スナップ・記録映像・エンドロール）・ゲストの過ごしやすさ・当日段取り）。
- specific: 具体を含む（固有の選択・数字・実際にやったこと / やらなかった理由）。心構えのみは false。
- tradeoff: 判断の理由・後悔・「やってよかった / 要らなかった」の評価が述べられている。
- promotional: 事業者による集客・自社サービスへの誘導が主目的なら true。職能者による記事でも、特定の自社サービス・自社会場・特定商品への誘導が主眼なら true とすること。判別基準は「読者が別の会場・別の業者で式を挙げる場合にも役立つか」。
- preDecisionOrPhotoShoot: 内容が次のいずれかに限られる場合に true とする。(a) フォトウェディング・前撮り・後撮りなど、挙式・披露宴とは別に行う撮影そのものの話題。(b) 式場探し・式場見学・見積もり比較・日取り決定など、挙式する会場や日程を決めるまでの段階の話題。挙式当日の写真・映像（スナップ撮影、記録映像、エンドロール）は (a) に含めない——これは挙式・披露宴の中身である。式が既に決まっている前提で書かれた記事、あるいはどちらとも判断できない記事は false とすること。

「卒花」「花嫁レポ」「#プレ花嫁」等の語がタイトル・本文に含まれること自体は加点材料ではない。逆にこれらの語が一切無くても、実際の挙式・披露宴の経験に基づく知見であれば同等に扱うこと。

判断材料が本文抜粋に無い場合、各項目は true ではなく false とせよ。本文にあるだろうと推測して true にしてはならない。`;

/**
 * すべてのプロンプトに共通する制約。著作権・事実性の観点で特に重要な指示：
 * - 原文の言い回し・文体をそのまま再現しない（要約は事実抽出であり創作的表現の複製ではない）
 * - 原文に無い事実（金額・会場名・日付等）を推測で補わない
 */
const SHARED_RULES = `# 制約（必ず守ること）
- タイトルは${AI_TITLE_MAX_CHARS}文字以内のニュース見出し調。誇張・煽り禁止。
- 要約は${AI_SUMMARY_TARGET_MIN_CHARS}〜${AI_SUMMARY_TARGET_MAX_CHARS}文字程度。投稿の要点・費用感・特徴を客観的に。
- 原文の独自の言い回し・文体をそのまま再現しないこと（著作権上の要件。要約は事実と要点の抽出であって、創作的表現の複製ではない）。
- 推測で事実（金額・会場名・日付など）を補完しない。原文に無い情報は書かない。
- カテゴリは以下の列挙から必ず1つ選ぶ: ${CATEGORIES_LIST}
- tag は、新しい/流行りの演出・アイテムなら "trend"、長年支持される王道・定番なら "classic"。
- firsthand / ceremonyDecision / specific / tradeoff / promotional / preDecisionOrPhotoShoot は必ず true/false の boolean で出力すること（数値・文字列は不可）。
- 出力は JSON のみ。マークダウン・前置き・説明文は一切含めない。`;

function formatInput(input: CurationInput): string {
  return `タイトル: ${input.title}\n本文抜粋: ${input.excerpt ?? "（本文抜粋なし）"}`;
}

/** 単体キュレーション用プロンプト（バッチ失敗時のフォールバック、および SNS 単発投稿）。 */
export function buildSingleCurationPrompt(input: CurationInput): string {
  return `あなたはウエディング（結婚式）関連の SNS/ブログ投稿を、中立的な立場で要約するキュレーターです。
以下の投稿1件について、JSON のみを出力してください。

${READER_PERSONA}

${formatInput(input)}

${SHARED_RULES}

${USEFULNESS_CRITERIA_RULES}

出力形式:
{"title":"...","summary":"...","category":"...","tag":"trend","firsthand":false,"ceremonyDecision":false,"specific":false,"tradeoff":false,"promotional":false,"preDecisionOrPhotoShoot":false}
`;
}

/** バッチキュレーション用プロンプト。index は入力の 1 始まり番号と一致させる。 */
export function buildBatchCurationPrompt(inputs: CurationInput[]): string {
  const itemsBlock = inputs.map((input, i) => `${i + 1}.\n${formatInput(input)}`).join("\n\n");

  return `あなたはウエディング（結婚式）関連の SNS/ブログ投稿を、中立的な立場で要約するキュレーターです。
以下の ${inputs.length} 件の投稿それぞれについて要約してください。

${READER_PERSONA}

${itemsBlock}

${SHARED_RULES}
- index は入力の番号（1始まり）と必ず一致させること。
- 出力は JSON オブジェクトのみ。1件につき1オブジェクト、入力と同じ件数で漏れなく出力すること。

${USEFULNESS_CRITERIA_RULES}

出力形式:
{"items":[{"index":1,"title":"...","summary":"...","category":"...","tag":"trend","firsthand":false,"ceremonyDecision":false,"specific":false,"tradeoff":false,"promotional":false,"preDecisionOrPhotoShoot":false}, ...]}
`;
}
