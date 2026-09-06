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
import { extractDiscoveryArticle } from "./discovery-extraction";
import {
  RETRY_MAX_ATTEMPTS,
  STALE_NON_TERMINAL_HOURS,
  YIELD_BASELINE_MIN_DAYS,
  YIELD_DEVIATION_FACTOR,
} from "@/lib/constants";
import { HOST_ALLOWLIST_HOSTS, isAllowedArticleUrl } from "@/lib/sources/host-allowlist";
import {
  completeRetry,
  dueRetries,
  expireRetries,
  getDiscoveryUrlsByStatus,
  getHostMetricsBaseline,
  getPostsByUrls,
  hashUrl,
  isRemoved,
  reapStaleNonTerminal,
  recordHostMetrics,
  recordEvidenceObservation,
  setDiscoverySeenStatus,
} from "@/lib/db/repository";
import { curateSingle } from "@/lib/llm/batch";
import { checkDiscoveryRateCap, jstDayKey } from "@/lib/pipeline/discovery-rate-cap";
import {
  dropPost,
  publishPost,
  retryOrGiveUp,
  type RetryContext,
} from "@/lib/pipeline/discovery-persistence";
import { disciplinedFetch } from "@/lib/sources/access-discipline";
import { filterTitle } from "@/lib/publish/gate";
export { revalidatePublishedPosts, type RevalidationStats } from "./discovery-revalidation";

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

export { bodyHashSimilarity, computeBodyHash, computeContainerBodyHash } from "./body-hash";

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
  const extraction = extractDiscoveryArticle(html, host);
  if (extraction.kind === "no_title") {
    // 元タイトルが取れないページは逐語表示の前提が崩れるため保存せず打ち切り。
    // ページの性質そのもの（title タグ無し）は再取得しても変わらないため
    // 再試行対象にはしない。
    if (retryCtx) await completeRetry(retryCtx.urlHash);
    await setDiscoverySeenStatus(host, url, "skipped");
    stats.skippedNoTitle++;
    return { abortedByKillGate: false, abortedByBudget: false, abortedByRetryAfter: false };
  }

  if (extraction.kind === "container_not_found") {
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
    await dropPost(host, url, extraction.title, "extraction_insufficient", now, [
      "container_not_found",
    ]);
    await setDiscoverySeenStatus(host, url, "fetched");
    stats.extractionInsufficientDropped++;
    stats.extractionFailedByContainer++;
    return { abortedByKillGate: false, abortedByBudget: false, abortedByRetryAfter: false };
  }

  if (extraction.kind === "extraction_insufficient") {
    const { failedConditions, signals } = extraction;
    console.warn(
      `[discovery-ingest] extraction_insufficient for ${url}: failedConditions=${JSON.stringify(
        failedConditions,
      )} textLength=${signals.textLength} linkDensity=${signals.linkDensity.toFixed(
        3,
      )} paragraphCount=${signals.paragraphCount}`,
    );
    for (const condition of failedConditions) {
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
      failedConditions: failedConditions.join(","),
      observedAt: now,
    });
    await dropPost(host, url, extraction.title, "extraction_insufficient", now, failedConditions);
    await setDiscoverySeenStatus(host, url, "fetched");
    stats.extractionInsufficientDropped++;
    return { abortedByKillGate: false, abortedByBudget: false, abortedByRetryAfter: false };
  }

  const { title: originalTitle, signals, judgmentSlice, bodyHash } = extraction;
  const curation = await curateSingle({ title: originalTitle, excerpt: judgmentSlice });
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
  const rateCap = await checkDiscoveryRateCap(now);
  if (rateCap.capped) {
    await retryOrGiveUp(host, url, "rate_capped", now, retryCtx);
    await setDiscoverySeenStatus(host, url, "fetched");
    stats.rateCapped++;
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
  _opts?: { budgetMs?: number },
): Promise<DiscoveryIngestStats> {
  const stats = emptyStats();

  // Q3: allowlist が最初の関門。未登録ホストは一切処理しない。
  if (!HOST_ALLOWLIST_HOSTS.includes(host)) {
    console.warn(`[discovery-ingest] host not in HOST_ALLOWLIST, refusing to process: ${host}`);
    stats.hostNotAllowed = true;
    return stats;
  }

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
      await dropPost(
        entry.host,
        entry.url,
        null,
        "retry_exhausted",
        now,
        undefined,
        `${entry.reason}:attempts=${entry.attempts}`,
      );
      await setDiscoverySeenStatus(entry.host, entry.url, "skipped");
      stats.retryExhausted++;
    }

    const due = await dueRetries(now, RETRY_PROCESS_LIMIT);
    for (const entry of due) {
      if (entry.lane !== "discovery" || entry.host !== host) continue;

      // TTL 超過分は上の `expireRetries` ループで既に終端化・削除済みのため、
      // ここに来る時点で `entry.expiresAt <= now` は基本的に起こらない
      // （安全側の防御として条件には残す）。ここでの主目的は最大試行数超過の判定。
      if (entry.expiresAt <= now || entry.attempts >= RETRY_MAX_ATTEMPTS) {
        // TTL 超過または最大試行超過 → 終端棄却（§7・contract: DropReason "retry_exhausted"）。
        stats.processed++;
        await dropPost(
          host,
          entry.url,
          null,
          "retry_exhausted",
          now,
          undefined,
          `${entry.reason}:attempts=${entry.attempts}`,
        );
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

    const pendingUrls = await getDiscoveryUrlsByStatus(host, "pending");
    for (const url of pendingUrls) {
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
