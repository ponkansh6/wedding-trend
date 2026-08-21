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
 */
export function computeCurationSignature(): string {
  return createHash("sha256")
    .update(`v${CURATION_PROMPT_VERSION}\0${LLM_MODEL}`)
    .digest("hex")
    .slice(0, 16);
}
