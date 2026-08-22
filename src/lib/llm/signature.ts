import { createHash } from "node:crypto";
import { CURATION_PROMPT_VERSION } from "@/lib/constants";
import { LLM_MODEL } from "./client";

/**
 * sha256(`${title}\0${excerpt ?? ""}`) の先頭16文字。
 * 元投稿の内容が変わっていないかを判定するためのハッシュ。
 */
export function computeContentHash(title: string, excerpt: string | null): string {
  return createHash("sha256")
    .update(`${title}\0${excerpt ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * sha256(`v${CURATION_PROMPT_VERSION}\0${LLM_MODEL}`) の先頭16文字。
 * プロンプト本文や使用モデルが変わったら再キュレーションが必要になる
 * ことを検知するためのシグネチャ。
 *
 * ⚠️ 有用度スコアの重み定数（`USEFULNESS_GATE_BONUS` 等、`src/lib/constants.ts`）
 * は**意図的にここへ含めない**。このシグネチャは「LLM にもう一度判定させる
 * 必要があるか（＝ブール値そのものが変わり得るか）」だけを表す。重みは
 * ブール値から表示用スコアを計算する段階（`src/lib/scoring/usefulness.ts` の
 * `computeUsefulnessScore()`、表示時に毎回その場で計算）でのみ使われ、
 * ブール値の決まり方（プロンプト・モデル）には一切影響しない。もし重みを
 * ここに含めてしまうと、重みを1つ調整するたびに全投稿の signature が
 * 変わって不要な再キュレーション（＝ Gemini への再課金）が走ってしまい、
 * 「重み調整はコード変更のみで再課金ゼロ」という設計そのものが無効になる。
 */
export function computeCurationSignature(): string {
  return createHash("sha256")
    .update(`v${CURATION_PROMPT_VERSION}\0${LLM_MODEL}`)
    .digest("hex")
    .slice(0, 16);
}
