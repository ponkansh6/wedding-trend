/**
 * discovery 記事 HTML の決定的な抽出・Q1 判定。
 *
 * ネットワーク、DB、LLM には依存しない。一時的な `judgmentSlice` だけを
 * ready 結果に含め、HTML や本文全体は結果オブジェクトへ露出しない。
 */
import { computeBodyHash } from "./body-hash";
import {
  computeEvidenceSignals,
  computeEvidenceSufficiency,
  extractArticleContainer,
  extractArticleHeadline,
  extractHtmlTitle,
  extractVisibleText,
  selectJudgmentSlice,
  type EvidenceFailedCondition,
  type EvidenceSignals,
} from "@/lib/sources/article-text";

export type DiscoveryExtraction =
  | { kind: "no_title" }
  | { kind: "container_not_found"; title: string }
  | {
      kind: "extraction_insufficient";
      title: string;
      signals: EvidenceSignals;
      failedConditions: EvidenceFailedCondition[];
    }
  | {
      kind: "ready";
      title: string;
      signals: EvidenceSignals;
      /** LLM 呼び出し中だけ使う非永続化の判断入力。 */
      judgmentSlice: string;
      bodyHash: string;
    };

/** HTML のタイトル、本文コンテナ、Q1、LLM用判定入力を現在の順序で導出する。 */
export function extractDiscoveryArticle(html: string, host: string): DiscoveryExtraction {
  const htmlTitle = extractHtmlTitle(html);
  if (!htmlTitle) return { kind: "no_title" };

  const containerHtml = extractArticleContainer(html, host);
  if (containerHtml === null) return { kind: "container_not_found", title: htmlTitle };

  const title = extractArticleHeadline(containerHtml) ?? htmlTitle;
  const signals = computeEvidenceSignals(containerHtml);
  const evidenceGate = computeEvidenceSufficiency(signals);
  if (!evidenceGate.ok) {
    return {
      kind: "extraction_insufficient",
      title,
      signals,
      failedConditions: evidenceGate.failedConditions,
    };
  }

  const visibleText = extractVisibleText(containerHtml);
  return {
    kind: "ready",
    title,
    signals,
    judgmentSlice: selectJudgmentSlice(visibleText),
    bodyHash: computeBodyHash(visibleText),
  };
}
