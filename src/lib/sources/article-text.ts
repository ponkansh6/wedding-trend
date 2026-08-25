/**
 * 取得済み HTML からのノイズ除去・テキスト抽出を行うモジュール。
 * 取得（フェッチ）自体は `access-discipline.ts` の `disciplinedFetch` を
 * 唯一の経路とする（robots・ホスト間隔・日次キャップ・kill gate・条件付き GET
 * を一元的に守るため）。このモジュールは HTML → テキストの純粋変換のみを担う。
 *
 * ⚠️ CRITICAL LEGAL CONSTRAINT (§5.3 — 最重要):
 * 取得した本文テキストは LLM の有用度判定・要約の入力（判断燃料）としてのみ使用され、
 * **データベースのいかなるカラム（originalExcerpt を含む）にも絶対に永続化してはならない。**
 * キュレーション処理が完了した後は速やかに破棄されること。
 */

import {
  MIN_EVIDENCE_INPUT_CHARS,
  MAX_LINK_DENSITY,
  MIN_PARAGRAPH_COUNT,
  MAX_BOILERPLATE_LINE_RATIO,
} from "@/lib/constants";
import type { GateResult } from "@/lib/publish/gate";

// 閾値は定数の一元管理のため constants.ts にのみ定義し、ここで再公開する。
export { MIN_EVIDENCE_INPUT_CHARS };

/** 簡易的な HTML エンティティのデコード */
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * HTML から <script>, <style>, <noscript> 要素を中身ごと削除し、
 * タグを除去して可視テキストを抽出・整形する。
 */
export function extractVisibleText(html: string): string {
  // script, style, noscript 要素の削除
  const cleanedHtml = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "");

  // タグの除去
  const withoutTags = cleanedHtml.replace(/<[^>]+>/g, " ");

  // エンティティのデコード
  const decoded = decodeHtmlEntities(withoutTags);

  // 空白の正規化（連続する空白や改行をまとめる）
  return decoded
    .replace(/[\r\n]+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * ナビゲーション等のヘッダー部分（最初の約1,200文字）をスキップし、
 * 次の約1,500文字を抽出して判断燃料とする。
 */
export function selectJudgmentSlice(visibleText: string): string {
  const skipChars = 1200;
  const takeChars = 1500;

  const sliceTarget = visibleText.length > skipChars ? visibleText.slice(skipChars) : visibleText;
  return sliceTarget.slice(0, takeChars);
}

/**
 * 判定燃料として十分なテキスト量があるか（plan 06 §8 のゲート）。
 * 閾値未満の薄い入力で「自信ありげな、第三者の著作物についての性質主張」を
 * 生成しないための認識論的ゲート。
 *
 * @deprecated plan 07 §6-Q1: `evidenceSufficient` は LLM の自己申告ではなく
 * 決定的に計算する方針に変わった。テキスト長のみを見るこの関数は後方互換の
 * 薄いラッパとして残す（既存呼び出し元 —— discovery-ingest.ts 等 —— は
 * 別レーンが `computeEvidenceSufficiency()` への置き換えを行う）。
 * 新規コードは `computeEvidenceSignals()` + `computeEvidenceSufficiency()`
 * を使うこと（リンク密度・段落数・定型行率も検証する、より厳格なゲート）。
 */
export function hasSufficientEvidence(text: string): boolean {
  return text.length >= MIN_EVIDENCE_INPUT_CHARS;
}

/** Q1: 抽出品質の決定的ゲート（plan 07 §6-Q1）に使う4シグナル。 */
export type EvidenceSignals = {
  /** 可視テキストの総長（空白除去後）。 */
  textLength: number;
  /** リンクテキストの総長 / 可視テキスト総長（0〜1）。ナビ誤認の主要シグナル。 */
  linkDensity: number;
  /** 本文と判定できる段落（生 HTML の `<p>` タグ数）。 */
  paragraphCount: number;
  /** 定型行（ナビ・フッター等の短い反復行）が全行に占める割合（0〜1）。 */
  boilerplateLineRatio: number;
};

/** 定型行とみなす行の最大文字数（ナビ項目・パンくず等は短い傾向がある）。 */
const BOILERPLATE_LINE_MAX_CHARS = 8;

/**
 * `<a>...</a>` の中身（タグ除去・エンティティデコード・空白除去後）の
 * 合計文字数を、生 HTML から直接算出する。
 *
 * ⚠️ `extractVisibleText()` はタグを除去してしまうため、除去後のテキストから
 * リンク長を復元することはできない。必ず生 HTML に対して行うこと。
 */
function computeLinkTextLength(html: string): number {
  const anchorRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let total = 0;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null) {
    const innerText = decodeHtmlEntities(match[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, "");
    total += innerText.length;
  }
  return total;
}

/** 生 HTML 中の `<p>` 開始タグの数を段落数の近似値として使う。 */
function countParagraphTags(html: string): number {
  const matches = html.match(/<p[\s>]/gi);
  return matches ? matches.length : 0;
}

/** `extractVisibleText()` の出力行のうち、短い（＝定型的な）行の割合。 */
function computeBoilerplateLineRatio(visibleText: string): number {
  const lines = visibleText.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) return 1;
  const boilerplateLines = lines.filter((line) => line.length <= BOILERPLATE_LINE_MAX_CHARS);
  return boilerplateLines.length / lines.length;
}

/**
 * 生 HTML から Q1 の4シグナルを算出する（plan 07 §6-Q1）。
 * リンク密度の算出は生 HTML の `<a>` タグから行う必要があるため、
 * このモジュールが HTML → シグナルの唯一の変換点になる。
 */
export function computeEvidenceSignals(html: string): EvidenceSignals {
  const visibleText = extractVisibleText(html);
  const textLength = visibleText.replace(/\s+/g, "").length;
  const linkTextLength = computeLinkTextLength(html);
  const linkDensity = textLength > 0 ? Math.min(linkTextLength / textLength, 1) : 1;
  const paragraphCount = countParagraphTags(html);
  const boilerplateLineRatio = computeBoilerplateLineRatio(visibleText);

  return { textLength, linkDensity, paragraphCount, boilerplateLineRatio };
}

/**
 * Q1: `evidenceSufficient` の決定的計算（plan 07 §6-Q1）。LLM の自己申告に
 * 依存せず、抽出シグナルのみから合否を判定する。`hasSufficientEvidence()` の
 * 実質的な後継。
 */
export function computeEvidenceSufficiency(signals: EvidenceSignals): GateResult {
  const fail: GateResult = { ok: false, reason: "extraction_insufficient" };

  if (signals.textLength < MIN_EVIDENCE_INPUT_CHARS) return fail;
  if (signals.linkDensity > MAX_LINK_DENSITY) return fail;
  if (signals.paragraphCount < MIN_PARAGRAPH_COUNT) return fail;
  if (signals.boilerplateLineRatio > MAX_BOILERPLATE_LINE_RATIO) return fail;

  return { ok: true };
}

/**
 * HTML の <title> タグ内容を抽出する（OGP 無しサイトにおける元タイトルの源）。
 * タグ除去・エンティティデコード・空白正規化を行い、
 * 見つからない・空の場合は null を返す。
 */
export function extractHtmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  const title = decodeHtmlEntities(match[1])
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return title.length > 0 ? title : null;
}
