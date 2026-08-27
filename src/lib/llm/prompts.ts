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
 * 有用度判定 6 項目の指示。定義は spec.md §9.2〜§9.4 と同一の内容。
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
const USEFULNESS_CRITERIA_RULES = `# 有用度判定（5つのブール値 + promotional は3段階。点数は絶対に出力しないこと）
上の想定読者にとって役に立つ投稿かどうかを、以下の項目それぞれについて判定すること。
※ weddingDayContent は ceremonyDecision と別軸です：ceremonyDecision は「その話題が式の意思決定に役立つか（トピック適合）」、weddingDayContent は「当日の実施事実が具体的に描写されているか（実況の深度）」を判定します。
- firsthand: 書き手自身または近しい当事者が実際に挙式・披露宴を経験した立場から書かれている。新婦本人に限らず、新郎・両家家族、およびプランナー・司会者・カメラマン・装花担当など式に立ち会う職能者が実務経験に基づいて書いたものを含む。
- ceremonyDecision: 挙式・披露宴の中身の意思決定に効く（進行・タイムライン・演出・席次・席札・余興・スピーチ・BGM・装花・料理・引出物・ペーパーアイテム・挙式当日の写真・映像（スナップ・記録映像・エンドロール）・ゲストの過ごしやすさ・当日段取り）。
- specific: 具体を含む（固有の選択・数字・実際にやったこと / やらなかった理由）。心構えのみは false。
- weddingDayContent: 記事が結婚式当日の**実施内容・実況・当日の展開**を具体的に記述しているか。進行タイムライン・演出の実際の様子・余興の実施内容・料理の提供状況・装花・衣装の着用感・BGMの選曲意図と当日の流れ・ゲストの反応・当日発生したトラブルとその対応など、**「当日に何が起きたか・どう進んだか・現場でどう感じたか」**が読み取れるかを問う。準備段階（業者選定・見積り・スケジュール調整・式場探し・規模や形式の合意形成）のみで、当日の実施描写に至らない記事は false。**「当日」「進行」等の単語の有無ではなく、当日の実施事実が描写されている実質で判定すること。**
- promotional: 事業者による集客・自社サービスへの誘導の度合いを "none" / "light" / "heavy" の3段階で判定すること。判別基準は「読者が別の会場・別の業者で式を挙げる場合にも役立つか」。
  - "none": 事業者の集客要素が実質的にない。
  - "light": 自社サービスへの言及や導線はあるが、記事の主目的は情報提供であり、読者が別の会場・別の業者で式を挙げる場合にも役立つ。特定の式場・事業者の実例紹介であっても、過剰な誘導がなく他式場でも活用できる情報（予算感・演出のアイデア等）を含むなら "light" とし、"heavy" は安易に付けないこと。
  - "heavy": 文章中で過剰に、かつ明確に自社サービス・特定の式場等への誘導を行っているもののみを "heavy" とする。単なる事例・実例の紹介や、自社への言及があっても誘導が過剰でなければ "heavy" にせず、主目的が情報提供であれば "light" とする。
- preDecisionOrPhotoShoot: 内容が次のいずれかに限られる場合に true とする。(a) フォトウェディング・前撮り・後撮りなど、挙式・披露宴とは別に行う撮影そのものの話題。(b) 式場探し・式場見学・見積もり比較・日取り決定など、挙式する会場や日程を決めるまでの段階の話題。(c) 挙式するか否か、どのような規模や形式で行うかを夫婦や両家で決めるまでの段階の話題。※(c)は挙式そのものの実施有無・規模・形式という「メタ判断」に限る。挙式の中身（席次・演出・装花・料理・BGM等）の具体的検討は含まない。挙式当日の写真・映像（スナップ撮影、記録映像、エンドロール）は (a) に含めない——これは挙式・披露宴の中身である。式が既に決まっている前提で書かれた記事、あるいはどちらとも判断できない記事は false とすること。ただし、(c) の判定にかかわらず、記事の中心的なテーマが挙式・披露宴の中身（進行・演出・席次・余興・スピーチ・BGM・装花・料理など）の判断材料に関する場合は false とする。

「卒花」「花嫁レポ」「#プレ花嫁」等の語がタイトル・本文に含まれること自体は加点材料ではない。逆にこれらの語が一切無くても、実際の挙式・披露宴の経験に基づく知見であれば同等に扱うこと。

判断材料が本文抜粋に無い場合、各項目は true ではなく false とせよ。本文にあるだろうと推測して true にしてはならない。`;

const RATIONALE_RULES = `# topicAnchor のルール（必ず守ること）
- topicAnchor: 記事の主題となるトピックのアンカー（40字以内）。結論のアンカーや具体的な数字を含めないこと。
- 記事固有の具体数値（半角/全角数字・金額・日付など）、および人物の氏名・ニックネーム・SNS アカウント名（ハンドル名等）・個人と結びつく固有の会場名・店舗名は一切禁止。
- 記事固有のアンカーは最大1つ、かつ結論のアンカーであってはならない（例: 可「持ち込み料の交渉について書いている」/ 不可「持ち込み料3万円が交渉で免除された」）。
- topicAnchor は本文抜粋に実際に書かれている語句のみで構成すること。本文に無い語句を創作してはならない（公開前に本文との逐語一致を機械的に検証するため、本文に無い語を含めると投稿自体が非公開になる）。`;

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
- firsthand / ceremonyDecision / specific / weddingDayContent / preDecisionOrPhotoShoot は必ず true/false の boolean で出力すること（数値・文字列は不可）。
- promotional は必ず "none" / "light" / "heavy" のいずれかの文字列で出力すること（boolean・数値は不可）。
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

${RATIONALE_RULES}

出力形式:
{"title":"...","summary":"...","category":"...","tag":"trend","firsthand":false,"ceremonyDecision":false,"specific":false,"weddingDayContent":false,"promotional":"none","preDecisionOrPhotoShoot":false,"topicAnchor":"..."}
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

${RATIONALE_RULES}

出力形式:
{"items":[{"index":1,"title":"...","summary":"...","category":"...","tag":"trend","firsthand":false,"ceremonyDecision":false,"specific":false,"weddingDayContent":false,"promotional":"none","preDecisionOrPhotoShoot":false,"topicAnchor":"..."}, ...]}
`;
}
