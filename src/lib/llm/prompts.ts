import { CATEGORIES } from "@/lib/types";
import {
  AI_SUMMARY_TARGET_MAX_CHARS,
  AI_SUMMARY_TARGET_MIN_CHARS,
  AI_TITLE_MAX_CHARS,
} from "@/lib/constants";
import type { CurationInput } from "./schemas";

const CATEGORIES_LIST = CATEGORIES.join("、");

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
- 出力は JSON のみ。マークダウン・前置き・説明文は一切含めない。`;

function formatInput(input: CurationInput): string {
  return `タイトル: ${input.title}\n本文抜粋: ${input.excerpt ?? "（本文抜粋なし）"}`;
}

/** 単体キュレーション用プロンプト（バッチ失敗時のフォールバック、および SNS 単発投稿）。 */
export function buildSingleCurationPrompt(input: CurationInput): string {
  return `あなたはウエディング（結婚式）関連の SNS/ブログ投稿を、中立的な立場で要約するキュレーターです。
以下の投稿1件について、JSON のみを出力してください。

${formatInput(input)}

${SHARED_RULES}

出力形式:
{"title":"...","summary":"...","category":"...","tag":"trend"}
`;
}

/** バッチキュレーション用プロンプト。index は入力の 1 始まり番号と一致させる。 */
export function buildBatchCurationPrompt(inputs: CurationInput[]): string {
  const itemsBlock = inputs.map((input, i) => `${i + 1}.\n${formatInput(input)}`).join("\n\n");

  return `あなたはウエディング（結婚式）関連の SNS/ブログ投稿を、中立的な立場で要約するキュレーターです。
以下の ${inputs.length} 件の投稿それぞれについて要約してください。

${itemsBlock}

${SHARED_RULES}
- index は入力の番号（1始まり）と必ず一致させること。
- 出力は JSON オブジェクトのみ。1件につき1オブジェクト、入力と同じ件数で漏れなく出力すること。

出力形式:
{"items":[{"index":1,"title":"...","summary":"...","category":"...","tag":"trend"}, ...]}
`;
}
