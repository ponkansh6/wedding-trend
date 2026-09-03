import { createHash, createHmac } from "node:crypto";
import {
  CRAWLER_USER_AGENT,
  DAILY_REQUEST_CAP_PER_HOST,
  LLM_MODEL,
  RATIONALE_PROMPT_VERSION,
} from "@/lib/constants";
import { isAllowedArticleUrl, getAllowlistedTosUrl } from "@/lib/sources/host-allowlist";
import { disciplinedFetch, checkTermsOfServiceChange } from "@/lib/sources/access-discipline";
import {
  extractArticleContainer,
  extractHtmlTitle,
  extractVisibleText,
  selectJudgmentSlice,
  computeEvidenceSignals,
  computeEvidenceSufficiency,
} from "@/lib/sources/article-text";
import { curateTopicsBatch } from "@/lib/llm/topics-batch";
import { db } from "@/lib/db";
import { posts, postTopics } from "@/lib/db/schema";
import { eq, and, isNotNull, desc, or, isNull } from "drizzle-orm";

/**
 * Stage 2: Content-specific topic backfill core library (`scripts/lib/content-topic-backfill.mjs`)
 * Implements strict selector, regulated fetch and judgment slice, HMAC dedicated signature,
 * audit allowed fields only with leak assertion, checkpoint/resume, host round-robin fairness.
 */

export const ALLOWED_AUDIT_KEYS = Object.freeze([
  "run",
  "record",
  "sourceHost",
  "sourceId",
  "httpStatus",
  "redirectClassification",
  "gateReason",
  "bytes",
  "timingMs",
  "attempt",
  "digest",
  "signature",
  "version",
  "oldTopicCount",
  "newTopicCount",
  "outcome",
]);

/** Leak assertion to ensure no body, container, visible text, slice, excerpt, raw prompt/response/exception leak. */
export function assertNoSliceLeak(payload, forbiddenSubstrings = []) {
  const json = JSON.stringify(payload);
  const sensitiveTerms = [
    "slice",
    "container",
    "visibleText",
    "excerpt",
    "rawPrompt",
    "rawResponse",
    "exceptionMessage",
    ...forbiddenSubstrings,
  ];
  for (const term of sensitiveTerms) {
    if (term.length > 3 && json.toLowerCase().includes(term.toLowerCase())) {
      throw new Error(
        `[Security Leak] Sensitive term or data leak detected in audit sink: "${term}"`,
      );
    }
  }
}

/** Generic topics denylist — 固定8語 + DB頻度上位の動的回避 */
const GENERIC_TOPIC_DENYLIST = [
  "準備の進め方",
  "心構え",
  "確認ポイント",
  "ポイント",
  "注意点",
  "基本事項",
  "基礎知識",
];

// 直近のDB集計 TOP20（2026-09-03: 演出33, 準備19, 演出の工夫10, 前撮り9, 家族婚9, 美容9, DIY8, 神前式8, 会場選び7, 挙式演出7, 準備の進め方7, ...）
// 出現頻度上位を一律generic扱いすると過剰に刈るため、プロンプト側で生成回避 + selectorでは any一致で再生成対象とする
const FREQUENT_TOPIC_DENYLIST = [
  "演出",
  "準備",
  "演出の工夫",
  "前撮り",
  "家族婚",
  "美容",
  "DIY",
  "神前式",
  "会場選び",
  "挙式演出",
  "準備の進め方",
  "ご祝儀",
  "式場見学",
  "撮影準備",
  "見積もり",
];

const COMBINED_DENYLIST = [...new Set([...GENERIC_TOPIC_DENYLIST, ...FREQUENT_TOPIC_DENYLIST])];

export function isGenericTopics(topics) {
  if (!Array.isArray(topics) || topics.length === 0) return true;
  // 頻度上位回避: 1つでも頻出/固定一般語が含まれれば要再生成（every→someに緩和）
  return topics.some((t) => typeof t === "string" && COMBINED_DENYLIST.includes(t.trim()));
}

export function getFrequentDenylist() {
  return FREQUENT_TOPIC_DENYLIST;
}

export function isLegacySignature(post) {
  return !post.promptVersion || String(post.promptVersion).startsWith("legacy");
}

/**
 * Compute dedicated topic backfill signature using HMAC.
 */
export function computeTopicBackfillSignature(params) {
  const secret =
    params.secretKey || process.env.TOPIC_SIGNATURE_SECRET || "wedding-trend-topic-secret";
  const payload = [
    String(params.recordId),
    params.normalizedUrl,
    params.sourceContentDigest,
    params.extractionVersion,
    params.topicPromptVersion,
    params.schemaVersion,
    params.modelId,
  ].join("|");
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Selector for candidates meeting AND conditions:
 * published, blog, allowlisted, permitted article path, generic or legacy signature, no success signature match.
 */
export async function selectCandidates(dbConn, opts = {}) {
  const limit = opts.limit ?? 100;
  const rows = await dbConn
    .select({
      id: posts.id,
      url: posts.url,
      sourceType: posts.sourceType,
      sourceId: posts.sourceId,
      originalTitle: posts.originalTitle,
      publishedAt: posts.publishedAt,
    })
    .from(posts)
    .where(and(eq(posts.status, "published"), eq(posts.sourceType, "blog")))
    .orderBy(desc(posts.publishedAt))
    .limit(500);

  const filtered = [];
  for (const row of rows) {
    if (opts.host && new URL(row.url).host !== opts.host) continue;
    if (!isAllowedArticleUrl(row.url)) continue;

    const topicRows = await dbConn
      .select({ topic: postTopics.topic, promptVersion: postTopics.promptVersion })
      .from(postTopics)
      .where(eq(postTopics.postId, row.id));

    const topics = topicRows.map((tr) => tr.topic);
    const promptVersion = topicRows[0]?.promptVersion || null;

    const generic = isGenericTopics(topics);
    const legacy = isLegacySignature({ promptVersion });

    if (!generic && !legacy) {
      continue;
    }

    filtered.push({
      ...row,
      topics,
      promptVersion,
    });

    if (filtered.length >= limit) break;
  }

  return filtered;
}

/**
 * Regulated fetch and slice generation using disciplinedFetch, article-text extractContainer, visibleText, selectJudgmentSlice.
 */
export async function regulatedFetchAndSlice(url) {
  const start = Date.now();
  const verdict = await disciplinedFetch(url, { purpose: "article" });
  const timingMs = Date.now() - start;

  if (verdict.kind !== "ok") {
    return { success: false, verdict: verdict.kind, timingMs };
  }

  const html = await verdict.response.text();
  const bytes = Buffer.byteLength(html, "utf-8");
  if (bytes > 512 * 1024) {
    return { success: false, verdict: "too_large", bytes, timingMs };
  }

  const title = extractHtmlTitle(html);
  if (!title) {
    return { success: false, verdict: "no_title", bytes, timingMs };
  }

  const host = new URL(url).host;
  const container = extractArticleContainer(html, host);
  if (!container) {
    return { success: false, verdict: "container_missing", bytes, timingMs };
  }

  const visible = extractVisibleText(container);
  const signals = computeEvidenceSignals(visible);
  const sufficiency = computeEvidenceSufficiency(signals);
  if (!sufficiency.sufficient) {
    return {
      success: false,
      verdict: "evidence_insufficient",
      reason: sufficiency.reason,
      bytes,
      timingMs,
    };
  }

  const slice = selectJudgmentSlice(visible);
  const sourceContentDigest = createHash("sha256").update(slice).digest("hex");

  return {
    success: true,
    title,
    slice,
    sourceContentDigest,
    bytes,
    timingMs,
  };
}
