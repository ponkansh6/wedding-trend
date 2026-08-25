import { z } from "zod";
import { CATEGORIES } from "@/lib/types";
import {
  AI_SUMMARY_VALIDATE_MAX_CHARS,
  AI_SUMMARY_VALIDATE_MIN_CHARS,
  AI_TITLE_MAX_CHARS,
} from "@/lib/constants";

/** LLM に渡す投稿 1 件分の入力（プロンプト組み立て用）。 */
export interface CurationInput {
  title: string;
  excerpt: string | null;
}

/**
 * タイトルの上限文字数チェックは「軽い over-rejection 回避」のため、
 * ハードな max() で弾かず、ここでは緩めの妥当性チェック（空でない・
 * 常識的な長さ）のみ行い、実際の 30 文字への丸めは transform で行う。
 * LLM が多少長いタイトルを返してもバリデーション全体を失敗させない。
 */
const TITLE_SANITY_MAX_CHARS = AI_TITLE_MAX_CHARS * 4;

const TitleSchema = z
  .string()
  .min(1)
  .max(TITLE_SANITY_MAX_CHARS)
  .transform((title) =>
    title.length > AI_TITLE_MAX_CHARS ? title.slice(0, AI_TITLE_MAX_CHARS) : title,
  );

/**
 * 有用度判定 6 項目。点数（重み）は一切ここに含めない —— LLM にはブール値
 * だけを出させ、重み付けは `src/lib/scoring/usefulness.ts` の
 * `computeUsefulnessScore()` がコード側で行う（定義は
 * openspec/specs/wedding-trend/spec.md §9.3 を参照。プロンプト側の指示文は
 * `src/lib/llm/prompts.ts` の `USEFULNESS_CRITERIA_RULES` を参照）。
 */
export const CurationItemSchema = z.object({
  index: z.number().int(),
  title: TitleSchema,
  summary: z.string().min(AI_SUMMARY_VALIDATE_MIN_CHARS).max(AI_SUMMARY_VALIDATE_MAX_CHARS),
  category: z.enum(CATEGORIES),
  tag: z.enum(["trend", "classic"]),
  firsthand: z.boolean(),
  ceremonyDecision: z.boolean(),
  specific: z.boolean(),
  tradeoff: z.boolean(),
  promotional: z.boolean(),
  preDecisionOrPhotoShoot: z.boolean(),
  /**
   * 記事の主題となるトピックのアンカー（40字以内）。
   * plan 07 §5-M1: 公開前に `src/lib/publish/gate.ts` の
   * `checkAnchorGrounding()` で取得本文への語彙的接地を検証すること
   * （このスキーマ自体は接地を検証しない —— 本文はここには無いため）。
   */
  topicAnchor: z.string().min(1).max(40),
  // rationaleText と evidenceSufficient は plan 07 §6-Q1/Q5 によりここでは
  // 受け取らない。根拠文は `renderRationaleText()`（`src/lib/publish/gate.ts`）
  // が topicAnchor + 上記 boolean から決定的に生成し、evidenceSufficient は
  // `computeEvidenceSufficiency()`（`src/lib/sources/article-text.ts`）が
  // 取得 HTML から決定的に計算する。どちらも LLM の自己申告に依存しない。
});

export type CurationItem = z.infer<typeof CurationItemSchema>;

/** バッチ応答の想定形。Gemini には常にこの `{ items: [...] }` 形式を出力させる。 */
export const CurationBatchResponseSchema = z.object({
  items: z.array(CurationItemSchema),
});

export type CurationBatchResponse = z.infer<typeof CurationBatchResponseSchema>;
