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
 *
 * ⚠️ コンテナ抽出（2026-08 の見直し）:
 * かつて `computeEvidenceSignals()` はページ全体を測っており、ナビ・フッター・
 * 第三者コンテンツ（口コミ等）を含んだ値で Q1 ゲートを判定していた（結果、
 * www.mwed.jp で本番 24 件中 24 件が誤って棄却された）。実 HTML の構造ダンプで
 * 記事本体と口コミが別サブツリーの兄弟であることが確定したため、
 * `extractArticleContainer()` でホストごとのセレクタに一致する最小の
 * サブツリーを切り出し、以降の指標・判定燃料はすべてそのコンテナ HTML を
 * 基準に計算する。JSON-LD 等の構造化データは存在しないため（実測 0 件）、
 * DOM セレクタによる抽出が唯一の経路。
 */

import { parseHTML } from "linkedom";
import {
  MIN_EVIDENCE_INPUT_CHARS,
  MAX_LINK_DENSITY,
  MIN_PARAGRAPH_COUNT,
  HOST_ALLOWLIST,
} from "@/lib/constants";
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
 * HTML から可視レンダリング対象外の領域（<script>, <style>, <noscript> 要素と
 * その中身、および HTML コメント）を除去する。タグ自体は除去しない
 * （呼び出し元がタグ除去前提のものと、タグ構造を保ったまま使うもの —
 * `computeLinkTextLength()` の `<a>` 抽出など — の双方から共有するため）。
 *
 * `extractVisibleText()` と `computeEvidenceSignals()`（分母・分子）が
 * この前処理を共有することで、除去対象の不一致による指標のずれを防ぐ。
 */
function stripNonRenderedRegions(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * ホストの `articleContainerSelectors`（優先順）を順に試し、最初にマッチした
 * 要素の innerHTML を記事本文コンテナとして返す。どのセレクタにも一致しない
 * 場合、または `host` が allowlist に無い場合は `null`（＝テンプレート変更や
 * 未知ホストによる破損シグナル。ページ全体へサイレントにフォールバックしない）。
 *
 * HTML パーサ（linkedom）を使う——正規表現では入れ子タグを平衡できないため、
 * 兄弟サブツリー（口コミ等）を確実に除外するにはこの方法が必須。
 */
export function extractArticleContainer(html: string, host: string): string | null {
  const entry = HOST_ALLOWLIST.find((h) => h.host === host);
  if (!entry) return null;

  const { document } = parseHTML(html);
  for (const selector of entry.articleContainerSelectors) {
    let element: Element | null;
    try {
      element = document.querySelector(selector);
    } catch {
      // 不正なセレクタ（本来コミット時に混入しないはずだが、防御的に無視して次を試す）。
      continue;
    }
    if (element) return element.innerHTML;
  }
  return null;
}

/**
 * HTML から <script>, <style>, <noscript> 要素・HTML コメントを中身ごと削除し、
 * タグを除去して可視テキストを抽出・整形する。
 */
export function extractVisibleText(html: string): string {
  // script, style, noscript 要素・コメントの削除
  const cleanedHtml = stripNonRenderedRegions(html);

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
 * コンテナ本文の先頭から最大 1,500 字を判断燃料として抽出する。
 *
 * 旧実装は「ナビ等のヘッダー部分（先頭 1,200 字）をスキップ」する固定
 * オフセットを持っていたが、これはページ全体を対象にしていた時代の名残で
 * あり、入力が既に `extractArticleContainer()` で本文サブツリーに絞られた
 * 現在はナビをスキップする理由がない（スキップするとむしろ本文冒頭を
 * 読み捨てるだけになる）。
 */
export function selectJudgmentSlice(visibleText: string): string {
  const takeChars = 1500;
  return visibleText.slice(0, takeChars);
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
 * を使うこと（リンク密度・段落数も検証する、より厳格なゲート）。
 */
export function hasSufficientEvidence(text: string): boolean {
  return text.length >= MIN_EVIDENCE_INPUT_CHARS;
}

/**
 * Q1: 抽出品質の決定的ゲート（plan 07 §6-Q1）に使う3シグナル。
 * すべて `extractArticleContainer()` が切り出したコンテナ HTML を基準に
 * 計算する（ページ全体ではない）。
 */
export type EvidenceSignals = {
  /** コンテナ内の可視テキストの総長（空白除去後）。 */
  textLength: number;
  /** コンテナ内のリンクテキスト総長 / 可視テキスト総長（0〜1）。ナビ誤認の主要シグナル。 */
  linkDensity: number;
  /** コンテナ内で本文と判定できる段落（生 HTML の `<p>` タグ数）。 */
  paragraphCount: number;
};

/**
 * `<a>...</a>` の中身（タグ除去・エンティティデコード・空白除去後）の
 * 合計文字数を、生 HTML から直接算出する。
 *
 * ⚠️ `extractVisibleText()` はタグを除去してしまうため、除去後のテキストから
 * リンク長を復元することはできない。必ず生 HTML に対して行うこと。
 * ただし「生 HTML」とは `extractVisibleText()` が除去する領域
 * （`<script>` / `<style>` / `<noscript>` とその中身、HTML コメント）を
 * 呼び出し元で事前に取り除いた HTML を指す。そうしないと script 内や
 * コメント内の `<a>` まで数えてしまい、分子（リンク長）と分母（可視テキスト長）
 * の対象が食い違う（実際に本番でこの不一致により linkDensity が常に 1.000 に
 * 丸められる不具合が発生した）。
 *
 * 既知の限界: `<a>` の入れ子はネストを認識しない。非貪欲マッチのため
 * 「最初の `<a>` から最初に出現する `</a>`（＝内側の閉じタグ）まで」しか
 * 1つの一致として消費せず、外側の閉じタグ以降のテキストが一致から漏れて
 * 数えられない（二重計上ではなく under-count）。HTML 仕様上は不正だが
 * 実在しうる形。稀なケースであり、正しい対処（スタックベースのパーサー）
 * は本モジュールの正規表現ベースの軽量実装の範囲を超えるため、
 * 既知の限界として許容し、挙動をテストで固定する。
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

/**
 * コンテナ HTML から Q1 の3シグナルを算出する（plan 07 §6-Q1）。
 * リンク密度の算出は生 HTML の `<a>` タグから行う必要があるため、
 * このモジュールが HTML → シグナルの唯一の変換点になる。
 *
 * `html` は呼び出し元があらかじめ `extractArticleContainer()` で切り出した
 * コンテナ HTML を渡すこと（ページ全体を渡すとナビ・フッター・第三者
 * コンテンツが指標に混入する）。
 */
export function computeEvidenceSignals(html: string): EvidenceSignals {
  const visibleText = extractVisibleText(html);
  const textLength = visibleText.replace(/\s+/g, "").length;
  // 分子（リンク長）と分母（可視テキスト長）の除去対象を一致させるため、
  // extractVisibleText() と同じ前処理（script/style/noscript・コメント除去）を
  // 適用した HTML から算出する。タグ構造は `<a>` 抽出のために保持する。
  const strippedHtml = stripNonRenderedRegions(html);
  const linkTextLength = computeLinkTextLength(strippedHtml);
  const rawLinkDensity = textLength > 0 ? linkTextLength / textLength : 1;
  if (rawLinkDensity > 1) {
    // 分子と分母の対象を揃えてもなお比率が1を超える場合、入れ子アンカー等に
    // よる二重計上が疑われる。Math.min() で静かに丸めると異常が観測不能に
    // なるため、警告として残す（丸め自体は下流ゲートの契約を維持するため行う）。
    console.warn(
      `[article-text] linkDensity raw value exceeded 1 (${rawLinkDensity.toFixed(3)}); ` +
        "clamped to 1. Likely nested <a> double-counting.",
    );
  }
  const linkDensity = Math.min(rawLinkDensity, 1);
  const paragraphCount = countParagraphTags(html);

  return { textLength, linkDensity, paragraphCount };
}

/**
 * Q1の条件のうち、不合格になった条件を指す識別子。棄却理由の事後観測
 * （どの条件で・どの実測値で落ちたか）のために `computeEvidenceSufficiency()`
 * の戻り値に含める。`container_not_found` は `extractArticleContainer()` が
 * `null` を返した場合（Q1 の各種シグナル計算自体を行えない）に discovery-ingest
 * 側が直接付与する。
 */
export type EvidenceFailedCondition =
  | "container_not_found"
  | "text_length"
  | "link_density"
  | "paragraph_count";

/**
 * `computeEvidenceSufficiency()` の戻り値。`GateResult`（`{ok:true}` /
 * `{ok:false; reason}` の流儀）に合わせつつ、不合格時にどの条件が落ちたかを
 * `failedConditions` にすべて含める（1つ目で打ち切らない）。
 */
export type EvidenceGateResult =
  | { ok: true }
  | { ok: false; reason: "extraction_insufficient"; failedConditions: EvidenceFailedCondition[] };

/**
 * Q1: `evidenceSufficient` の決定的計算（plan 07 §6-Q1）。LLM の自己申告に
 * 依存せず、抽出シグナルのみから合否を判定する。`hasSufficientEvidence()` の
 * 実質的な後継。
 *
 * 不合格の場合、同時に不合格となったすべての条件を `failedConditions` に
 * 含める（原因分析には全条件の状態が要るため、最初の不合格で打ち切らない）。
 *
 * `container_not_found` はこの関数の対象外（`extractArticleContainer()` が
 * `null` を返した時点でシグナル自体を計算できないため、呼び出し元
 * ——discovery-ingest.ts—— が別途処理する）。
 */
export function computeEvidenceSufficiency(signals: EvidenceSignals): EvidenceGateResult {
  const failedConditions: EvidenceFailedCondition[] = [];

  if (signals.textLength < MIN_EVIDENCE_INPUT_CHARS) failedConditions.push("text_length");
  if (signals.linkDensity > MAX_LINK_DENSITY) failedConditions.push("link_density");
  if (signals.paragraphCount < MIN_PARAGRAPH_COUNT) failedConditions.push("paragraph_count");

  if (failedConditions.length > 0) {
    return { ok: false, reason: "extraction_insufficient", failedConditions };
  }
  return { ok: true };
}

/**
 * コンテナ HTML（`extractArticleContainer()` が切り出した記事本文サブツリー）
 * の中から最初の `<h1>` のテキストを抽出する。spec §10-3「元記事タイトルの
 * 逐語表示」に対し、`<title>` タグ（サイト名・定型句が付与されがち）より
 * 記事見出しそのものの方が忠実なため、`originalTitle` の第一候補として使う
 * （実 HTML 調査: www.mwed.jp の
 * `div.story-detail-main-visual-header__title` が該当）。
 *
 * コンテナに `<h1>` が無ければ `null`（呼び出し元は `<title>` へフォールバック
 * すること。h1 の有無はテンプレート差異で起こりうるため、フォールバックを
 * 必ず残す）。
 */
export function extractArticleHeadline(containerHtml: string): string | null {
  const { document } = parseHTML(containerHtml);
  const h1 = document.querySelector("h1");
  if (!h1) return null;
  const text = decodeHtmlEntities(h1.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text : null;
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
