/**
 * 発見ランナー（plan 06 §5.1/§5.2、P7b / plan 07 §5〜§7・無人運転の統制）。
 *
 * sitemap 差分発見（`discoverNewUrls`）が seed した `discovery_seen` の
 * `pending` URL、および TTL 付き再試行キュー（`post_retry_queue`）の due な
 * エントリを、アクセス規律レイヤー（`disciplinedFetch`）経由で取得し、
 * 本文テキストを抽出して LLM キュレーションに渡す。
 *
 * ⚠️ CRITICAL LEGAL CONSTRAINTS（plan 06 §5.3 / spec §10 / §11）:
 * - 抽出した本文テキスト（判定スライス・全文とも）は LLM 入力および M4 本文
 *   ドリフト検知のフィンガープリント計算にのみ使い、DB のいかなるカラムにも
 *   生テキストとして永続化しない。`originalExcerpt` は常に null。`bodyHash` は
 *   simhash によるフィンガープリントであり原文を復元できない。
 * - 元タイトルは `<title>` タグから逐語で取得する（OGP 無しサイトの代替源）。
 *
 * plan 07 の無人運転統制の結線（本ファイルの責務）:
 * - Q3: ホスト allowlist が最初の関門（新規ホストの自動追加を構造的に禁止）
 * - Q1: 決定的抽出品質ゲート（LLM 呼び出し前。LLM の自己申告を廃止）
 * - M1: 公開直前ゲート（タイトルフィルタ・topicAnchor 語彙的接地・sticky removal）
 * - Q4: 日次公開サーキットブレーカー（上限到達は終端棄却ではなく再試行キューへ。ホスト別シェア上限は廃止）
 * - §7: `pending` 廃止 → TTL 付き再試行キュー＋理由コード付き終端棄却
 * - Q2: ホスト単位 yield 崩壊検知（ベースライン比較・小標本は判定しない）
 * - M4: 客観トリガによる自動撤回（`revalidatePublishedPosts`、run-discovery.mjs の第3段階）
 */
import { createHash } from "node:crypto";
import {
  BODY_DRIFT_SIMILARITY_MIN,
  DISCOVERY_INGEST_TIME_BUDGET_MS,
  EVERGREEN_SOURCE_ID,
  HOST_ALLOWLIST_HOSTS,
  isAllowedArticleUrl,
  LLM_MODEL,
  RATIONALE_PROMPT_VERSION,
  RETRY_BACKOFF_HOURS,
  RETRY_MAX_ATTEMPTS,
  RETRY_TTL_HOURS,
  STALE_NON_TERMINAL_HOURS,
  YIELD_BASELINE_MIN_DAYS,
  YIELD_DEVIATION_FACTOR,
} from "@/lib/constants";
import {
  completeRetry,
  dueRetries,
  enqueueRetry,
  expireRetries,
  filterRemoved,
  getDiscoveryUrlsByStatus,
  getHostMetricsBaseline,
  getPostsByUrls,
  hashUrl,
  isRemoved,
  listPublishedForRevalidation,
  markCurated,
  markDropped,
  markRetracted,
  reapStaleNonTerminal,
  recordHostMetrics,
  recordPublication,
  recordEvidenceObservation,
  setDiscoverySeenStatus,
  upsertPosts,
} from "@/lib/db/repository";
import { curateSingle } from "@/lib/llm/batch";
import type { CurationResult } from "@/lib/llm/batch";
import { computeContentHash, computeCurationSignature } from "@/lib/llm/signature";
import { registrableDomain } from "@/lib/pipeline/source-name";
import { isDailyPublishCapReached } from "@/lib/pipeline/rate-cap";
import { checkTermsOfServiceChange, disciplinedFetch } from "@/lib/sources/access-discipline";
import {
  computeEvidenceSignals,
  computeEvidenceSufficiency,
  extractArticleContainer,
  extractArticleHeadline,
  extractHtmlTitle,
  extractVisibleText,
  selectJudgmentSlice,
  type EvidenceFailedCondition,
} from "@/lib/sources/article-text";
import { filterTitle } from "@/lib/publish/gate";
import type { DropReason, RetryQueueEntry, RetryReason, TrendTag } from "@/lib/types";

/** `ingestDiscoveredUrls()` の実行統計。run-discovery.mjs のログ出力と Actions 監視に使う。 */
export interface DiscoveryIngestStats {
  /** 処理を試みた URL 数（予算枯渇で未処理のものは含まない）。 */
  processed: number;
  /** 公開になった数。 */
  published: number;
  /** Q1 決定的ゲート不合格（LLM を呼ばず終端棄却）。 */
  extractionInsufficientDropped: number;
  /**
   * Q1 の条件別棄却内訳。`extractionInsufficientDropped` は複数条件が同時に
   * 不合格になった1件を1件として数えるため、これらの合計は
   * `extractionInsufficientDropped` 以上になりうる。
   */
  extractionFailedByTextLength: number;
  extractionFailedByLinkDensity: number;
  extractionFailedByParagraphCount: number;
  /**
   * `extractArticleContainer()` がホストの `articleContainerSelectors` の
   * いずれにも一致せず `null` を返した件数（テンプレート変更による破損
   * シグナル）。この場合 Q1 の他の指標は計算せず即座に終端棄却する。
   */
  extractionFailedByContainer: number;
  /** M1 タイトルフィルタで終端棄却。 */
  titleFilterDropped: number;
  /** M1 topicAnchor 接地失敗で終端棄却。 */
  anchorUngroundedDropped: number;
  /** Q4 日次公開上限またはホストシェア上限により再試行キューへ繰り延べ（終端棄却ではない）。 */
  rateCapped: number;
  /**
   * 記事パスのホワイトリスト（`isAllowedArticleUrl`）不一致のため取得前に
   * 終端棄却（discovery_seen を skipped に。ネットワーク I/O ゼロ）。
   */
  skippedPathNotAllowed: number;
  /** robots.txt により不許可（discovery_seen を skipped に）。 */
  skippedRobots: number;
  /** 404/410（discovery_seen を skipped に）。 */
  skippedGone: number;
  /** 取得サイズ上限（512KB）超過（discovery_seen を skipped に）。 */
  skippedTooLarge: number;
  /** `<title>` が取れない等の病的ページ（保存せず skipped・再試行しない）。 */
  skippedNoTitle: number;
  /** 一時的失敗（fetch/LLM）で再試行キューに投入した件数。 */
  enqueuedRetries: number;
  /** 再試行の TTL 超過・最大試行超過により `retry_exhausted` で終端棄却した件数。 */
  retryExhausted: number;
  /** M1-3: 既に撤回済み（sticky removal）のため公開を拒否した件数。 */
  stickyRemovedBlocked: number;
  /**
   * `expireRetries(now, ["discovery"])` がキューから削除した件数（discovery
   * レーンのみ、plan 07 D5 のレーン絞り込み後）。全件 `retryExhausted` として
   * 個別に終端棄却済み（`retryExpiredRaw === retryExhausted` が常に成立する）。
   */
  retryExpiredRaw: number;
  /** `reapStaleNonTerminal()` が定常収束させた件数。 */
  staleReaped: number;
  /** kill gate（K1〜K6・異常検知・人手解除要）発火でランを中断した。 */
  abortedByKillGate: boolean;
  /** B1（日次リクエスト予算消化・soft stop・UTC 日次自動リセット）でランを中断した。 */
  abortedByBudget: boolean;
  /** Retry-After 指定でランを中断した。 */
  abortedByRetryAfter: boolean;
  /** 時間予算枯渇で中断した。 */
  budgetExhausted: boolean;
  /** Q3: allowlist 外ホストのため何も処理しなかった。 */
  hostNotAllowed: boolean;
  /** Q2: yield 崩壊を検知した（呼び出し元はホスト収集の停止・警告を検討すること）。 */
  yieldCollapseDetected: boolean;
}

function emptyStats(): DiscoveryIngestStats {
  return {
    processed: 0,
    published: 0,
    extractionInsufficientDropped: 0,
    extractionFailedByTextLength: 0,
    extractionFailedByLinkDensity: 0,
    extractionFailedByParagraphCount: 0,
    extractionFailedByContainer: 0,
    titleFilterDropped: 0,
    anchorUngroundedDropped: 0,
    rateCapped: 0,
    skippedPathNotAllowed: 0,
    skippedRobots: 0,
    skippedGone: 0,
    skippedTooLarge: 0,
    skippedNoTitle: 0,
    enqueuedRetries: 0,
    retryExhausted: 0,
    stickyRemovedBlocked: 0,
    retryExpiredRaw: 0,
    staleReaped: 0,
    abortedByKillGate: false,
    abortedByBudget: false,
    abortedByRetryAfter: false,
    budgetExhausted: false,
    hostNotAllowed: false,
    yieldCollapseDetected: false,
  };
}

// ─────────────────────────────────────────────────────────────
// 本文フィンガープリント（M4 本文ドリフト検知用）
// ─────────────────────────────────────────────────────────────

const SIMHASH_BITS = 64;
/** 64bit を BigInt を使わず 32bit の word 2 つで扱う（tsconfig target=ES2017 対応）。 */
const WORD_BITS = 32;
const SHINGLE_SIZE = 4;

function shingles(text: string): string[] {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < SHINGLE_SIZE) return compact.length > 0 ? [compact] : [];
  const out: string[] = [];
  for (let i = 0; i <= compact.length - SHINGLE_SIZE; i++) {
    out.push(compact.slice(i, i + SHINGLE_SIZE));
  }
  return out;
}

/** sha256 digest の先頭 8 バイトを 32bit word 2 つ（符号なし）に変換する。 */
function tokenFingerprintWords(token: string): [number, number] {
  const digest = createHash("sha256").update(token).digest();
  const w0 = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  const w1 = ((digest[4] << 24) | (digest[5] << 16) | (digest[6] << 8) | digest[7]) >>> 0;
  return [w0, w1];
}

/**
 * 正規化済み本文テキストから 64bit simhash を計算する（16桁 hex 文字列、
 * 上位32bit + 下位32bit の word 2 つとして計算する）。原文を復元できない
 * フィンガープリントであり、`post_publications.body_hash` に永続化してよい
 * （§5.3 の「本文の非保存」制約に抵触しない）。ハミング距離ベースで近似
 * 類似度を測れるため、M4 の本文ドリフト検知に使う。
 */
/**
 * ページ全体 HTML からコンテナ（ナビ・フッター・第三者コンテンツを排した
 * 記事本文サブツリー）を切り出し、そのコンテナ HTML 基準で本文ハッシュを
 * 計算する。`processUrl()`（初回公開）と `revalidatePublishedPosts()`
 * （M4 再検証）の両方がこの関数を経由することで、保存済みハッシュと
 * 再検証時のハッシュの算出基盤を一致させる（コンテナ基準 vs ページ全体
 * 基準の不一致は M4 の誤発火を招く）。
 *
 * `extractArticleContainer()` がホストのセレクタに一致せず `null` を返した
 * 場合、この関数も `null` を返す。呼び出し側はページ全体へフォールバック
 * してはならない（それは本来のコンテナ基準ハッシュと構造的に食い違う値を
 * 生成し、以後の全比較を破壊する）。
 */
export function computeContainerBodyHash(html: string, host: string): string | null {
  const containerHtml = extractArticleContainer(html, host);
  if (containerHtml === null) return null;
  return computeBodyHash(extractVisibleText(containerHtml));
}

export function computeBodyHash(text: string): string {
  const tokens = shingles(text);
  if (tokens.length === 0) return "0".repeat(16);

  const weights0 = new Array<number>(WORD_BITS).fill(0);
  const weights1 = new Array<number>(WORD_BITS).fill(0);
  for (const token of tokens) {
    const [w0, w1] = tokenFingerprintWords(token);
    for (let bit = 0; bit < WORD_BITS; bit++) {
      weights0[bit] += ((w0 >>> bit) & 1) === 1 ? 1 : -1;
      weights1[bit] += ((w1 >>> bit) & 1) === 1 ? 1 : -1;
    }
  }

  let r0 = 0;
  let r1 = 0;
  for (let bit = 0; bit < WORD_BITS; bit++) {
    if (weights0[bit] > 0) r0 |= 1 << bit;
    if (weights1[bit] > 0) r1 |= 1 << bit;
  }
  return (r0 >>> 0).toString(16).padStart(8, "0") + (r1 >>> 0).toString(16).padStart(8, "0");
}

function popcount32(value: number): number {
  let v = value >>> 0;
  let count = 0;
  while (v) {
    count += v & 1;
    v >>>= 1;
  }
  return count;
}

/** 2つの simhash（16桁 hex）間の近似類似度（0〜1）。ハミング距離が小さいほど 1 に近い。 */
export function bodyHashSimilarity(a: string, b: string): number {
  if (
    a.length !== 16 ||
    b.length !== 16 ||
    !/^[0-9a-f]{16}$/i.test(a) ||
    !/^[0-9a-f]{16}$/i.test(b)
  ) {
    // 不正な hex（旧データ等）は最も安全側（=別物扱い）に倒す。
    return 0;
  }
  const a0 = Number.parseInt(a.slice(0, 8), 16);
  const a1 = Number.parseInt(a.slice(8, 16), 16);
  const b0 = Number.parseInt(b.slice(0, 8), 16);
  const b1 = Number.parseInt(b.slice(8, 16), 16);
  const distance = popcount32(a0 ^ b0) + popcount32(a1 ^ b1);
  return 1 - distance / SIMHASH_BITS;
}

// ─────────────────────────────────────────────────────────────
// JST 日次境界（Q4 レート上限・Q2 テレメトリの集計単位）
// ─────────────────────────────────────────────────────────────

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `now` を含む JST の暦日の開始時刻（UTC ISO 文字列）。Q4 の集計基準。 */
function jstDayStartIso(nowIso: string): string {
  const jstMs = Date.parse(nowIso) + JST_OFFSET_MS;
  const jst = new Date(jstMs);
  const startOfDayJstMs = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return new Date(startOfDayJstMs - JST_OFFSET_MS).toISOString();
}

/** `now` を含む JST の暦日キー（YYYY-MM-DD）。Q2 `discovery_host_metrics` の day カラムに使う。 */
function jstDayKey(nowIso: string): string {
  const jstMs = Date.parse(nowIso) + JST_OFFSET_MS;
  return new Date(jstMs).toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────
// posts 行の書き込みヘルパ
// ─────────────────────────────────────────────────────────────

/**
 * posts テーブルに行を upsert する。
 * ⚠️ `originalExcerpt` は常に null（§5.3: 抽出本文の永続化禁止）。
 */
async function upsertPostRow(
  host: string,
  url: string,
  title: string,
  status: "published" | "rejected",
): Promise<boolean> {
  const sourceName = registrableDomain(url) ?? host;
  const result = await upsertPosts([
    {
      url,
      sourceType: "blog",
      sourceId: EVERGREEN_SOURCE_ID,
      sourceName,
      originalTitle: title,
      originalExcerpt: null,
      author: null,
      thumbnailUrl: null,
      publishedAt: null,
      status,
    },
  ]);
  if (result.failed.length > 0) {
    console.warn(`[discovery-ingest] upsert failed for ${url}`);
    return false;
  }
  return true;
}

function criteriaOf(curation: CurationResult) {
  return {
    firsthand: curation.firsthand,
    ceremonyDecision: curation.ceremonyDecision,
    specific: curation.specific,
    weddingDayContent: curation.weddingDayContent,
    promotional: curation.promotional,
  };
}

/**
 * §7: 終端棄却。post 行を（まだ無ければ）作成したうえで `markDropped` を呼ぶ。
 * `title` が未取得（fetch 段階の一時的失敗が TTL 超過した場合等）のときは
 * URL 自体をプレースホルダーとして使う（棄却済み投稿は表示経路に乗らないため
 * 実害はない）。
 */
async function dropPost(
  host: string,
  url: string,
  title: string | null,
  reason: DropReason,
  now: string,
  failedConditions?: EvidenceFailedCondition[],
) {
  if (!(await upsertPostRow(host, url, title ?? url, "rejected"))) return;
  const states = await getPostsByUrls([url]);
  const postId = states.get(url)?.id;
  if (postId == null) {
    console.warn(`[discovery-ingest] post id lookup failed while dropping ${url}`);
    return;
  }
  let finalReason: string = reason;
  if (reason === "extraction_insufficient") {
    if (failedConditions && failedConditions.length > 0) {
      finalReason = `extraction_insufficient:${failedConditions.join(",")}`;
    } else {
      finalReason = "extraction_insufficient:unknown";
    }
  }
  await markDropped(postId, finalReason as DropReason, now);
}

/** published として保存し、判定根拠（rationale）・公開記録も行う。 */
async function publishPost(
  host: string,
  url: string,
  title: string,
  curation: CurationResult,
  bodyHash: string,
  now: string,
  signals: { textLength: number; linkDensity: number; paragraphCount: number },
): Promise<boolean> {
  if (!(await upsertPostRow(host, url, title, "published"))) return false;

  const states = await getPostsByUrls([url]);
  const postId = states.get(url)?.id;
  if (postId == null) {
    console.warn(`[discovery-ingest] post id lookup failed for ${url}`);
    return false;
  }

  const mark = await markCurated([
    {
      url,
      aiSummary: curation.summary,
      category: curation.category,
      tag: "classic" as TrendTag,
      contentHash: computeContentHash(title, null),
      curationSignature: computeCurationSignature(),
      status: "published",
      usefulness: {
        postId,
        criteria: criteriaOf(curation),
        modelId: LLM_MODEL,
      },
      rationale: {
        postId,
        topicAnchor: curation.topicAnchor,
        rationaleText: curation.rationaleText,
        evidenceSufficient: true,
        modelId: LLM_MODEL,
        promptVersion: RATIONALE_PROMPT_VERSION,
      },
    },
  ]);
  if (mark.failed.length > 0) {
    console.warn(`[discovery-ingest] markCurated failed for ${url}`);
    return false;
  }

  // discovery レーンは HOST_ALLOWLIST のホストの記事本文を実際に取得して
  // 判定するため、bodyHash は実本文フィンガープリント。"body" として明示する
  // （plan 07 D3: M4 の本文ドリフト判定の対象はこの種別のみ）。
  await recordPublication(
    postId,
    now,
    bodyHash,
    "body",
    signals.textLength,
    signals.linkDensity,
    signals.paragraphCount,
  );
  return true;
}

// ─────────────────────────────────────────────────────────────
// §7: TTL 付き再試行キューのヘルパ
// ─────────────────────────────────────────────────────────────

function backoffHoursFor(attempts: number): number {
  const idx = Math.min(attempts, RETRY_BACKOFF_HOURS.length - 1);
  return RETRY_BACKOFF_HOURS[idx] ?? RETRY_BACKOFF_HOURS[RETRY_BACKOFF_HOURS.length - 1];
}

function addHoursIso(baseIso: string, hours: number): string {
  return new Date(Date.parse(baseIso) + hours * 60 * 60 * 1000).toISOString();
}

interface RetryContext {
  urlHash: string;
  attempts: number;
  firstQueuedAt: string;
}

/**
 * 一時的失敗（§7・§10: 抽出不足・接地失敗・判定不一致の再試行は明示的に禁止。
 * 対象は fetch/LLM の技術的失敗と Q4 のレート上限繰り延べのみ）を再試行
 * キューに積む、または最大試行数超過なら諦めて（=post を作らず）打ち切る。
 * 諦めた場合は `true`（終端＝再試行しない）を返す。
 */
async function retryOrGiveUp(
  host: string,
  url: string,
  reason: RetryReason,
  now: string,
  ctx: RetryContext | null,
): Promise<boolean> {
  const attempts = ctx?.attempts ?? 0;
  const nextAttempts = attempts + 1;
  const firstQueuedAt = ctx?.firstQueuedAt ?? now;

  if (nextAttempts > RETRY_MAX_ATTEMPTS) {
    if (ctx) await completeRetry(ctx.urlHash);
    return true;
  }

  const entry: RetryQueueEntry = {
    urlHash: ctx?.urlHash ?? hashUrl(url),
    url,
    host,
    lane: "discovery",
    reason,
    attempts: nextAttempts,
    firstQueuedAt,
    nextAttemptAt: addHoursIso(now, backoffHoursFor(attempts)),
    expiresAt: addHoursIso(firstQueuedAt, RETRY_TTL_HOURS),
  };
  await enqueueRetry(entry);
  return false;
}

// ─────────────────────────────────────────────────────────────
// Q4: 公開レート上限
// ─────────────────────────────────────────────────────────────

async function checkRateCap(now: string): Promise<{ capped: boolean }> {
  // spec §11 項4: 日次公開サーキットブレーカーのみ（ホスト別シェア上限は廃止）。
  return { capped: await isDailyPublishCapReached(jstDayStartIso(now)) };
}

// ─────────────────────────────────────────────────────────────
// 1 URL の処理
// ─────────────────────────────────────────────────────────────

async function processUrl(
  host: string,
  url: string,
  stats: DiscoveryIngestStats,
  now: string,
  retryCtx: RetryContext | null,
): Promise<{ abortedByKillGate: boolean; abortedByBudget: boolean; abortedByRetryAfter: boolean }> {
  stats.processed++;

  // Q3 深化: ホスト単位の allowlist に加え、記事パスのホワイトリストにも
  // 一致しない URL は取得前に終端棄却する（ネットワーク I/O ゼロ）。同一
  // ホスト配下でも口コミ投稿ページ等の UGC を構造的に混入させないための
  // 最終防衛線（seed 段階のフィルタが変わっても必ずここで守られる）。
  if (!isAllowedArticleUrl(url)) {
    if (retryCtx) await completeRetry(retryCtx.urlHash);
    await setDiscoverySeenStatus(host, url, "skipped");
    stats.skippedPathNotAllowed++;
    return { abortedByKillGate: false, abortedByBudget: false, abortedByRetryAfter: false };
  }

  const verdict = await disciplinedFetch(url, { purpose: "article" });

  switch (verdict.kind) {
    case "kill_gate": {
      // K1〜K6: 異常検知。stateKind を永続化済みで人手解除を要する（hard stop）。
      console.warn(`[discovery-ingest] kill gate ${verdict.gate}: ${verdict.detail}`);
      return { abortedByKillGate: true, abortedByBudget: false, abortedByRetryAfter: false };
    }
    case "budget_exhausted": {
      // B1: 日次リクエスト予算を消化した（soft stop）。積み残しがある限り
      // 毎日発火するのが正常な定常状態であり、異常ではない。
      console.log(
        `[discovery-ingest] 日次リクエスト予算(${verdict.gate})を消化したため本日の巡回を終了: ${verdict.detail}`,
      );
      return { abortedByKillGate: false, abortedByBudget: true, abortedByRetryAfter: false };
    }
    case "retry_after": {
      console.warn(`[discovery-ingest] retry-after until ${verdict.retryAtISO}, aborting run`);
      return { abortedByKillGate: false, abortedByBudget: false, abortedByRetryAfter: true };
    }
    case "blocked_robots": {
      if (retryCtx) await completeRetry(retryCtx.urlHash);
      await setDiscoverySeenStatus(host, url, "skipped");
      stats.skippedRobots++;
      return { abortedByKillGate: false, abortedByBudget: false, abortedByRetryAfter: false };
    }
    case "http_error": {
      if (verdict.status === 404 || verdict.status === 410) {
        if (retryCtx) await completeRetry(retryCtx.urlHash);
        await setDiscoverySeenStatus(host, url, "skipped");
        stats.skippedGone++;
      } else {
        const gaveUp = await retryOrGiveUp(host, url, "fetch_transient", now, retryCtx);
        await setDiscoverySeenStatus(host, url, "fetched");
        if (gaveUp) {
          stats.retryExhausted++;
        } else {
          stats.enqueuedRetries++;
        }
      }
      return { abortedByKillGate: false, abortedByBudget: false, abortedByRetryAfter: false };
    }
    case "not_modified": {
      if (retryCtx) await completeRetry(retryCtx.urlHash);
      await setDiscoverySeenStatus(host, url, "fetched");
      return { abortedByKillGate: false, abortedByBudget: false, abortedByRetryAfter: false };
    }
    case "too_large": {
      // 取得サイズ上限超過（plan 06 §5.2）。相手のエラーではないが、ページの
      // サイズは基本的に変わらないため再取得しても同じ結果になりやすく、
      // 再試行対象にはしない。
      if (retryCtx) await completeRetry(retryCtx.urlHash);
      await setDiscoverySeenStatus(host, url, "skipped");
      stats.skippedTooLarge++;
      return { abortedByKillGate: false, abortedByBudget: false, abortedByRetryAfter: false };
    }
    case "ok":
      break;
  }

  const html = await verdict.response.text();
  const title = extractHtmlTitle(html);
  if (!title) {
    // 元タイトルが取れないページは逐語表示の前提が崩れるため保存せず打ち切り。
    // ページの性質そのもの（title タグ無し）は再取得しても変わらないため
    // 再試行対象にはしない。
    if (retryCtx) await completeRetry(retryCtx.urlHash);
    await setDiscoverySeenStatus(host, url, "skipped");
    stats.skippedNoTitle++;
    return { abortedByKillGate: false, abortedByBudget: false, abortedByRetryAfter: false };
  }

  // コンテナ抽出: ナビ・フッター・第三者コンテンツ（口コミ等）を排したサブ
  // ツリーを切り出す。どのセレクタにも一致しなければテンプレート変更等に
  // よる破損とみなし、Q1 の他指標を計算せず即座に終端棄却する。
  const containerHtml = extractArticleContainer(html, host);
  if (containerHtml === null) {
    console.warn(`[discovery-ingest] container_not_found for ${url}`);
    if (retryCtx) await completeRetry(retryCtx.urlHash);
    await recordEvidenceObservation({
      urlHash: retryCtx?.urlHash ?? hashUrl(url),
      host,
      textLength: 0,
      linkDensity: 1.0,
      paragraphCount: 0,
      passedGate: false,
      failedConditions: "container_not_found",
      observedAt: now,
    });
    await dropPost(host, url, title, "extraction_insufficient", now, ["container_not_found"]);
    await setDiscoverySeenStatus(host, url, "fetched");
    stats.extractionInsufficientDropped++;
    stats.extractionFailedByContainer++;
    return { abortedByKillGate: false, abortedByBudget: false, abortedByRetryAfter: false };
  }

  // originalTitle: コンテナ内 h1（記事見出しそのもの）を第一候補とし、
  // 取れなければ従来の <title> タグ由来の値へフォールバックする
  // （h1 の有無はテンプレート差異で起こりうるため、フォールバックを必ず残す）。
  const originalTitle = extractArticleHeadline(containerHtml) ?? title;

  // Q1: 決定的抽出品質ゲート（LLM 呼び出しの前）。コンテナ HTML 基準で計算する。
  const signals = computeEvidenceSignals(containerHtml);
  const evidenceGate = computeEvidenceSufficiency(signals);
  if (!evidenceGate.ok) {
    console.warn(
      `[discovery-ingest] extraction_insufficient for ${url}: failedConditions=${JSON.stringify(
        evidenceGate.failedConditions,
      )} textLength=${signals.textLength} linkDensity=${signals.linkDensity.toFixed(
        3,
      )} paragraphCount=${signals.paragraphCount}`,
    );
    for (const condition of evidenceGate.failedConditions) {
      switch (condition) {
        case "text_length":
          stats.extractionFailedByTextLength++;
          break;
        case "link_density":
          stats.extractionFailedByLinkDensity++;
          break;
        case "paragraph_count":
          stats.extractionFailedByParagraphCount++;
          break;
        case "container_not_found":
          // container_not_found はこの分岐に到達する前に既に処理済み
          // （extractArticleContainer が null を返した場合は上で早期 return
          // している）。computeEvidenceSufficiency() はこの条件を返さない。
          break;
      }
    }
    if (retryCtx) await completeRetry(retryCtx.urlHash);
    await recordEvidenceObservation({
      urlHash: retryCtx?.urlHash ?? hashUrl(url),
      host,
      textLength: signals.textLength,
      linkDensity: signals.linkDensity,
      paragraphCount: signals.paragraphCount,
      passedGate: false,
      failedConditions: evidenceGate.failedConditions.join(","),
      observedAt: now,
    });
    await dropPost(
      host,
      url,
      originalTitle,
      "extraction_insufficient",
      now,
      evidenceGate.failedConditions,
    );
    await setDiscoverySeenStatus(host, url, "fetched");
    stats.extractionInsufficientDropped++;
    return { abortedByKillGate: false, abortedByBudget: false, abortedByRetryAfter: false };
  }

  const bodyText = extractVisibleText(containerHtml);
  const slice = selectJudgmentSlice(bodyText);
  const curation = await curateSingle({ title: originalTitle, excerpt: slice });
  if (curation === null) {
    const gaveUp = await retryOrGiveUp(host, url, "llm_transient", now, retryCtx);
    await setDiscoverySeenStatus(host, url, "fetched");
    if (gaveUp) {
      stats.retryExhausted++;
    } else {
      stats.enqueuedRetries++;
    }
    return { abortedByKillGate: false, abortedByBudget: false, abortedByRetryAfter: false };
  }

  // M1-1: タイトル公開フィルタ。
  const titleGate = filterTitle(originalTitle);
  if (!titleGate.ok) {
    if (retryCtx) await completeRetry(retryCtx.urlHash);
    await dropPost(host, url, originalTitle, "title_filter", now);
    await setDiscoverySeenStatus(host, url, "fetched");
    stats.titleFilterDropped++;
    return { abortedByKillGate: false, abortedByBudget: false, abortedByRetryAfter: false };
  }

  // D5 (shared_plan/16): topicAnchor の検証・再生成・degrade は curateSingle 内で行われる。失敗時は null で公開し、棄却しない。

  // M1-3: sticky removal。同一 URL が過去に自動撤回（retracted）済みなら、
  // 再発見されても公開しない（撤回は自動・復帰は人間。ここで上書きしない）。
  const existing = (await getPostsByUrls([url])).get(url);
  if (existing && (await isRemoved(existing.id))) {
    console.warn(`[discovery-ingest] refusing to publish sticky-removed post: ${url}`);
    if (retryCtx) await completeRetry(retryCtx.urlHash);
    await setDiscoverySeenStatus(host, url, "fetched");
    stats.stickyRemovedBlocked++;
    return { abortedByKillGate: false, abortedByBudget: false, abortedByRetryAfter: false };
  }

  // Q4: 日次公開サーキットブレーカー。上限到達は終端棄却ではなく再試行キューへの
  // 繰り延べ（良い記事を上限で捨てない）。ホスト別シェア上限は廃止（spec §11 項4）。
  const rateCap = await checkRateCap(now);
  if (rateCap.capped) {
    await retryOrGiveUp(host, url, "rate_capped", now, retryCtx);
    await setDiscoverySeenStatus(host, url, "fetched");
    stats.rateCapped++;
    return { abortedByKillGate: false, abortedByBudget: false, abortedByRetryAfter: false };
  }

  // processUrl 到達時点で containerHtml は非 null であることを確認済み
  // （上の container_not_found 早期 return を通過している）ため、ここでの
  // computeContainerBodyHash() は null を返さない。revalidatePublishedPosts()
  // と完全に同一の算出基盤（コンテナ抽出 → 可視テキスト化 → simhash）を
  // 経由させることで、保存時と再検証時のハッシュの不一致を構造的に防ぐ。
  const bodyHash = computeContainerBodyHash(html, host);
  if (bodyHash === null) {
    // 到達しないはずだが、型上は string | null なので安全側で扱う。
    if (retryCtx) await completeRetry(retryCtx.urlHash);
    await recordEvidenceObservation({
      urlHash: retryCtx?.urlHash ?? hashUrl(url),
      host,
      textLength: signals.textLength,
      linkDensity: signals.linkDensity,
      paragraphCount: signals.paragraphCount,
      passedGate: false,
      failedConditions: "body_hash_null",
      observedAt: now,
    });
    await dropPost(host, url, originalTitle, "extraction_insufficient", now, []);
    await setDiscoverySeenStatus(host, url, "fetched");
    stats.extractionInsufficientDropped++;
    stats.extractionFailedByContainer++;
    return { abortedByKillGate: false, abortedByBudget: false, abortedByRetryAfter: false };
  }
  await recordEvidenceObservation({
    urlHash: retryCtx?.urlHash ?? hashUrl(url),
    host,
    textLength: signals.textLength,
    linkDensity: signals.linkDensity,
    paragraphCount: signals.paragraphCount,
    passedGate: true,
    failedConditions: null,
    observedAt: now,
  });
  const published = await publishPost(host, url, originalTitle, curation, bodyHash, now, signals);
  if (!published) {
    // markCurated/upsert 失敗は DB 側の一時的な問題として再試行に回す。
    const gaveUp = await retryOrGiveUp(host, url, "fetch_transient", now, retryCtx);
    await setDiscoverySeenStatus(host, url, "fetched");
    if (gaveUp) {
      stats.retryExhausted++;
    } else {
      stats.enqueuedRetries++;
    }
    return { abortedByKillGate: false, abortedByBudget: false, abortedByRetryAfter: false };
  }

  if (retryCtx) await completeRetry(retryCtx.urlHash);
  await setDiscoverySeenStatus(host, url, "fetched");
  stats.published++;
  return { abortedByKillGate: false, abortedByBudget: false, abortedByRetryAfter: false };
}

// ─────────────────────────────────────────────────────────────
// メインエントリポイント
// ─────────────────────────────────────────────────────────────

/** 1回の discovery ラン内で処理する再試行キューエントリ数の上限。 */
const RETRY_PROCESS_LIMIT = 50;

/**
 * 指定ホストの `pending` URL と、当該ホストの due な再試行キューエントリを
 * 処理する。
 *
 * - Q3: ホストが `HOST_ALLOWLIST` に無ければネットワーク I/O ゼロで即終了する
 *   （新規ホストが自動的に収集対象へ加わる経路を無くす）。
 * - kill gate 発火 / Retry-After 指定時は即座にランを中断する
 *   （kill gate 後のホストは以降の取得が拒否されるため継続は無意味かつ無礼）。
 * - 時間予算（デフォルト 15 分、§5.5）を超えたら残りを次回ランに委ねる。
 */
export async function ingestDiscoveredUrls(
  host: string,
  opts?: { budgetMs?: number },
): Promise<DiscoveryIngestStats> {
  const stats = emptyStats();

  // Q3: allowlist が最初の関門。未登録ホストは一切処理しない。
  if (!HOST_ALLOWLIST_HOSTS.includes(host)) {
    console.warn(`[discovery-ingest] host not in HOST_ALLOWLIST, refusing to process: ${host}`);
    stats.hostNotAllowed = true;
    return stats;
  }

  const budgetMs = opts?.budgetMs ?? DISCOVERY_INGEST_TIME_BUDGET_MS;
  const startedAtMs = Date.now();
  const now = new Date().toISOString();

  // plan 07 §6-Q2: kill gate 中断・予期しない例外を含むどの経路でも
  // 「そこまでに処理した分」の日次テレメトリが正確に1回だけ記録されるよう、
  // per-host 処理の本体全体を try/finally で包む。early return（kill gate /
  // Retry-After 中断）で関数を抜ける場合も finally は必ず実行される。
  // recordHostMetrics() は内部で例外を捕捉するため finally 内で新たな例外を
  // 誘発しない。kill gate 以外の例外はここでは捕捉せず、テレメトリ記録後に
  // そのまま呼び出し元へ再送出する。
  try {
    // §7: 非終端のまま滞留した post を定常収束させる。
    stats.staleReaped = await reapStaleNonTerminal(now, STALE_NON_TERMINAL_HOURS);

    // §7: discovery レーンの TTL 超過分のキュー削除。
    // plan 07 D2 是正: `expireRetries` は完全な `RetryQueueEntry[]` を返す契約に
    // なったため、discovery レーンのエントリはここで直接
    // `retry_exhausted` として終端棄却する（旧実装は urlHash しか受け取れず、
    // 行がここで削除された時点で対応する post を二度と解決できなかった —
    // 結果として `stats.retryExhausted` が常に 0 になっていた）。
    // plan 07 D5: rss/evergreen/submit レーンには一切触れない（`lanes` 指定）。
    // それらは `ingest.ts` 側の消費者が独立したトリガ（RSS cron）で処理する。
    // `lanes: ["discovery"]` を渡し、rss/evergreen/submit レーンの期限切れ行には
    // 触れない（`ingest.ts` 側の消費者がそれらを担当する。plan 07 D5）。
    const expired = await expireRetries(now, ["discovery"]);
    stats.retryExpiredRaw = expired.length;
    for (const entry of expired) {
      stats.processed++;
      await dropPost(entry.host, entry.url, null, "retry_exhausted", now);
      await setDiscoverySeenStatus(entry.host, entry.url, "skipped");
      stats.retryExhausted++;
    }

    if (Date.now() - startedAtMs < budgetMs) {
      const due = await dueRetries(now, RETRY_PROCESS_LIMIT);
      for (const entry of due) {
        if (entry.lane !== "discovery" || entry.host !== host) continue;
        if (Date.now() - startedAtMs >= budgetMs) {
          stats.budgetExhausted = true;
          break;
        }

        // TTL 超過分は上の `expireRetries` ループで既に終端化・削除済みのため、
        // ここに来る時点で `entry.expiresAt <= now` は基本的に起こらない
        // （安全側の防御として条件には残す）。ここでの主目的は最大試行数超過の判定。
        if (entry.expiresAt <= now || entry.attempts >= RETRY_MAX_ATTEMPTS) {
          // TTL 超過または最大試行超過 → 終端棄却（§7・contract: DropReason "retry_exhausted"）。
          stats.processed++;
          await dropPost(host, entry.url, null, "retry_exhausted", now);
          await setDiscoverySeenStatus(host, entry.url, "skipped");
          await completeRetry(entry.urlHash);
          stats.retryExhausted++;
          continue;
        }

        const outcome = await processUrl(host, entry.url, stats, now, {
          urlHash: entry.urlHash,
          attempts: entry.attempts,
          firstQueuedAt: entry.firstQueuedAt,
        });
        if (outcome.abortedByKillGate) {
          stats.abortedByKillGate = true;
          return stats;
        }
        if (outcome.abortedByBudget) {
          stats.abortedByBudget = true;
          return stats;
        }
        if (outcome.abortedByRetryAfter) {
          stats.abortedByRetryAfter = true;
          return stats;
        }
      }
    }

    const pendingUrls = await getDiscoveryUrlsByStatus(host, "pending");
    for (const url of pendingUrls) {
      if (Date.now() - startedAtMs >= budgetMs) {
        stats.budgetExhausted = true;
        break;
      }

      const outcome = await processUrl(host, url, stats, now, null);
      if (outcome.abortedByKillGate) {
        stats.abortedByKillGate = true;
        return stats;
      }
      if (outcome.abortedByBudget) {
        stats.abortedByBudget = true;
        return stats;
      }
      if (outcome.abortedByRetryAfter) {
        stats.abortedByRetryAfter = true;
        return stats;
      }
    }
  } finally {
    const day = jstDayKey(now);
    const droppedTotal =
      stats.extractionInsufficientDropped +
      stats.titleFilterDropped +
      stats.anchorUngroundedDropped +
      stats.retryExhausted;
    await recordHostMetrics(host, day, {
      processed: stats.processed,
      published: stats.published,
      dropped: droppedTotal,
      // TODO(plan10-I4): promotional は LLM の判定結果（curation.promotional）から
      // 計上すべきだが、現時点では stats に追跡されていない。正確な値が記録できる
      // までは 0 として扱い、誤ったデータがベースラインに混入することを防ぐ。
      promotional: 0,
      // TODO(plan10-I4): authorPresent も post_publications.authors から
      // 計上すべきだが、現時点では未追跡。
      authorPresent: 0,
    });
  }

  const baseline = await getHostMetricsBaseline(host, YIELD_BASELINE_MIN_DAYS);
  if (baseline && baseline.days >= YIELD_BASELINE_MIN_DAYS && stats.processed > 0) {
    const currentRate = stats.published / stats.processed;
    if (baseline.publishRate > 0 && currentRate < baseline.publishRate * YIELD_DEVIATION_FACTOR) {
      stats.yieldCollapseDetected = true;
      console.warn(
        `[discovery-ingest] yield collapse detected for host=${host}: current=${currentRate.toFixed(
          3,
        )} baseline=${baseline.publishRate.toFixed(3)} (${baseline.days}d) — 収集を止めて確認してください。`,
      );
    }
  }

  return stats;
}

// ─────────────────────────────────────────────────────────────
// M4: 客観トリガによる自動撤回（再検証フェーズ）
// ─────────────────────────────────────────────────────────────

/** 1回の再検証ランで確認する公開済み投稿数の上限。 */
const REVALIDATION_LIMIT = 20;

export interface RevalidationStats {
  /** 再検証を試みた件数。 */
  checked: number;
  /** `post_publications` に行が無かった（シード対象）件数。撤回判定はしない。 */
  seeded: number;
  /** 元記事 404/410 による撤回。 */
  retractedSourceGone: number;
  /** robots.txt 不許可への変化による撤回。 */
  retractedRobotsDisallowed: number;
  /** K2（規約変更）/ K3（401/451）発火による撤回。 */
  retractedTosChanged: number;
  /** 本文ハッシュの大幅な変化による撤回。 */
  retractedBodyChanged: number;
  /**
   * `extractArticleContainer()` がホストのセレクタに一致せず本文ハッシュ
   * ドリフト判定をスキップした件数（テンプレート変更の疑いはあるが、単独の
   * 客観的証拠だけでは撤回しない。撤回済みハッシュは維持し次回以降に再判定
   * する）。撤回ではないため retracted* には含まれない。
   */
  containerNotFoundSkipped: number;
  /** 問題なし（正常確認）。 */
  ok: number;
}

function emptyRevalidationStats(): RevalidationStats {
  return {
    checked: 0,
    seeded: 0,
    retractedSourceGone: 0,
    retractedRobotsDisallowed: 0,
    retractedTosChanged: 0,
    retractedBodyChanged: 0,
    containerNotFoundSkipped: 0,
    ok: 0,
  };
}

/**
 * M4: 公開済み投稿の客観トリガによる自動撤回（plan 07 §5-M4）。
 *
 * - 撤回は自動、復帰は人間（`markRetracted` は sticky。ここから "published" に
 *   戻す経路は一切作らない）。
 * - `bodyHash` が null（この仕組み導入前に公開された post）はシード経路として
 *   扱う: フィンガープリントを計算して `recordPublication` で記録するのみで、
 *   その回はドリフト判定をしない。`publishedAt` のシード値は元記事の
 *   `publishedAt` ではなく `posts.created_at` を使う（現在時刻を入れると Q4
 *   のレート上限が偽のバーストを見てしまうため）。
 * - 本文ハッシュドリフト判定（`body_changed`）は `HOST_ALLOWLIST` のホスト
 *   （discovery レーンが実際に本文を取得して判定する対象）に限る（plan 07
 *   D3）。rss/evergreen/submit レーンは本文を取得せず `bodyHash` に
 *   `computeContentHash(title, excerpt)` の代替値（"surrogate"）しか持たない
 *   ため、これらの post を対象にすると保存値と再取得ハッシュが構造的に一致
 *   せず全件誤って撤回される。404/410・robots 不許可・K2/K3 はステータスのみ
 *   で判定できるため全ホスト共通で適用する。allowlist 外ホストの本文は
 *   （既存アクセス規律違反にもなるため）一切 GET しない。
 * - 既存のアクセス規律（`disciplinedFetch`・最小間隔・robots・kill gate）の
 *   枠内で行う。1回の実行で確認する件数には上限を設ける。
 */
export async function revalidatePublishedPosts(opts?: {
  limit?: number;
}): Promise<RevalidationStats> {
  const limit = opts?.limit ?? REVALIDATION_LIMIT;
  const stats = emptyRevalidationStats();
  const now = new Date().toISOString();

  const candidates = await listPublishedForRevalidation(limit);
  if (candidates.length === 0) return stats;

  const removedIds = await filterRemoved(candidates.map((c) => c.id));

  for (const post of candidates) {
    if (!post.host) continue; // 不正 URL は対象外。
    if (removedIds.has(post.id)) continue; // 既に sticky removal 済み（防御的）。
    stats.checked++;

    // K2: 規約変更検知（ホスト単位・1日1回内部でレート制限される）。
    const tosVerdict = await checkTermsOfServiceChange(post.host);
    if (tosVerdict && tosVerdict.kind === "kill_gate") {
      if (tosVerdict.gate === "K2" || tosVerdict.gate === "K3") {
        await markRetracted(post.id, "tos_changed", now);
        stats.retractedTosChanged++;
      }
      // 他の gate（K1/K4/K5/K6 等）はホスト全体の一時停止であり、この
      // post 個別の客観トリガではないため撤回しない（次回以降に再確認）。
      continue;
    }
    if (tosVerdict && tosVerdict.kind === "budget_exhausted") {
      // B1: 日次リクエスト予算消化（soft stop・異常ではない）。この post
      // 個別の客観トリガではないため撤回しない（次回以降に再確認）。
      continue;
    }

    const verdict = await disciplinedFetch(post.url, { purpose: "article" });
    switch (verdict.kind) {
      case "kill_gate": {
        if (verdict.gate === "K2" || verdict.gate === "K3") {
          await markRetracted(post.id, "tos_changed", now);
          stats.retractedTosChanged++;
        }
        continue;
      }
      case "budget_exhausted":
        continue; // B1: 日次リクエスト予算消化（soft stop）。異常ではないため撤回しない。
      case "retry_after":
        continue; // 相手都合の一時停止。次回ランに委ねる。
      case "blocked_robots": {
        await markRetracted(post.id, "robots_disallowed", now);
        stats.retractedRobotsDisallowed++;
        continue;
      }
      case "http_error": {
        if (verdict.status === 404 || verdict.status === 410) {
          await markRetracted(post.id, "source_gone", now);
          stats.retractedSourceGone++;
        }
        continue;
      }
      case "not_modified": {
        // 条件付き GET 未使用のためここには基本来ないが、安全側で「変化なし」扱い。
        stats.ok++;
        continue;
      }
      case "too_large": {
        // ドリフト判定不能。誤って撤回しない（false negative 側に倒す）。
        stats.ok++;
        continue;
      }
      case "ok":
        break;
    }

    // ここまでの分岐（404/410・robots 不許可・K2/K3）はステータス/ヘッダのみで
    // 判定可能で、全ホスト共通で適用済み。本文ハッシュドリフト（body_changed）
    // はこれとは別で、実際に取得した本文のハッシュを保存しているレーンに
    // しか意味を持たない（plan 07 D3）。`HOST_ALLOWLIST` のホスト（discovery
    // レーンが本文を取得して判定する対象）だけに限定する——note.com 等の
    // allowlist 外ホストの本文をここで GET しにいくこと自体もアクセス規律
    // 違反になるため、以下の分岐に入らない限り `verdict.response` の本文は
    // 一切読まない。
    if (!HOST_ALLOWLIST_HOSTS.includes(post.host)) {
      if (post.bodyHash == null || post.hashKind !== "surrogate") {
        // シード/再タグ経路: 本文を取得しないレーンの post に「surrogate」の
        // フィンガープリントを記録する（本文 GET は行わない）。既存の
        // bodyHash・publishedAt は破棄せず、無ければ判定に使ったのと同じ
        // 材料（タイトル+抜粋）から computeContentHash で作り直す。
        // publishedAt は元の値（既に記録済みならそれ）を維持し、無ければ
        // posts.created_at を使う（Q4 の偽バースト防止、既存シード経路と同じ方針）。
        const states = await getPostsByUrls([post.url]);
        const state = states.get(post.url);
        const seededPublishedAt = post.publishedAt ?? state?.createdAt ?? now;
        const surrogateHash =
          post.bodyHash ??
          computeContentHash(state?.originalTitle ?? "", state?.originalExcerpt ?? null);
        await recordPublication(post.id, seededPublishedAt, surrogateHash, "surrogate", 0, 0, 0);
        stats.seeded++;
        continue;
      }
      stats.ok++;
      continue;
    }

    const html = await verdict.response.text();
    // processUrl() と完全に同一の算出基盤（コンテナ抽出 → 可視テキスト化 →
    // simhash）で計算する。ページ全体 HTML へのフォールバックは行わない
    // （保存済みハッシュと基盤が食い違い、M4 が全件誤発火する）。
    const newHash = computeContainerBodyHash(html, post.host);
    if (newHash === null) {
      // コンテナが取れない = テンプレート変更等の疑いはあるが、これ単独は
      // 客観的な本文変化の証拠ではない（撤回理由コードに該当するものが無い）。
      // 既存の bodyHash は維持し、比較をスキップして次回以降に再判定する。
      console.warn(`[discovery-ingest] revalidate container_not_found for post ${post.id}`);
      stats.containerNotFoundSkipped++;
      continue;
    }

    if (post.bodyHash == null) {
      // シード経路: この post は post_publications 導入前に公開されたもの。
      // publishedAt は posts.created_at を使う（Q4 の偽バースト防止）。
      const states = await getPostsByUrls([post.url]);
      const seededPublishedAt = states.get(post.url)?.createdAt ?? now;
      await recordPublication(post.id, seededPublishedAt, newHash, "body", 0, 0, 0);
      stats.seeded++;
      continue;
    }

    const similarity = bodyHashSimilarity(post.bodyHash, newHash);
    if (similarity < BODY_DRIFT_SIMILARITY_MIN) {
      await markRetracted(post.id, "body_changed", now);
      stats.retractedBodyChanged++;
      continue;
    }

    stats.ok++;
  }

  return stats;
}
