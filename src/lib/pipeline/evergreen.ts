import {
  DAILY_PUBLISH_CAP,
  EVERGREEN_SOURCE_ID,
  HOST_DAILY_SHARE_MAX,
  LLM_MODEL,
  RATIONALE_PROMPT_VERSION,
  RETRY_BACKOFF_HOURS,
  RETRY_MAX_ATTEMPTS,
  RETRY_TTL_HOURS,
} from "@/lib/constants";
import {
  completeRetry,
  countPublishedSince,
  countPublishedSinceByHost,
  enqueueRetry,
  getPostsByUrls,
  hashUrl,
  isRemoved,
  markCurated,
  markDropped,
  recordPublication,
  upsertPosts,
} from "@/lib/db/repository";
import { curateSingle, type CurationResult } from "@/lib/llm/batch";
import { computeContentHash, computeCurationSignature } from "@/lib/llm/signature";
import { checkAnchorGrounding, filterTitle } from "@/lib/publish/gate";
import { fetchOgpMetadata, type OgpMetadata } from "@/lib/sources/ogp";
import type { DropReason, FeedCard, RetryContext, RetryReason, TrendTag } from "@/lib/types";
import { canonicalizeUrl } from "@/lib/url";

/**
 * `reason` の主な値:
 * - 失敗（`ok:false`）: `"invalid_url"` | `"no_metadata"` | `"no_source_name"` | `"save_failed"`
 * - 終端棄却（`ok:true`・plan 07 §7）: `"extraction_insufficient"` | `"title_filter"`
 * - 撤回済み（`ok:true`・sticky）: `"removed"`
 * - 一時的失敗を再試行キューへ繰り延べ（`ok:true`）: `"queued_for_retry"` | `"rate_limited"`
 * - 成功: `null`
 */
export type EvergreenOutcome = { ok: boolean; reason: string | null; card: FeedCard | null };

/**
 * 情報源名（クレジット）の解決。spec.md §10-2 の「著者名・情報源名を必ず表示する」
 * 要件を満たすため、実在しない媒体名は絶対に生成しない。
 * 解決順: 手動指定 (opts.sourceName) → og:site_name → URL の登録可能ドメイン。
 * いずれも得られない場合は null を返し、呼び出し側で保存を拒否する
 * （捏造したクレジットを出すくらいなら取り込まない）。
 */
export function resolveSourceName(
  canonical: string,
  meta: OgpMetadata,
  opts?: { sourceName?: string },
): string | null {
  const explicit = opts?.sourceName?.trim();
  if (explicit) return explicit;
  const siteName = meta.siteName?.trim();
  if (siteName) return siteName;
  return registrableDomain(canonical);
}

/** URL から登録可能ドメイン（www. 等のサブドメインを除いたホスト名）を取り出す。事実であり捏造にあたらない。 */
export function registrableDomain(canonical: string): string | null {
  try {
    const hostname = new URL(canonical).hostname;
    if (!hostname) return null;
    return hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// plan 07: TTL 付き再試行キュー・レート上限のヘルパ（evergreen レーン）
// ─────────────────────────────────────────────────────────────

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `now` を含む JST の暦日の開始時刻（UTC ISO 文字列）。Q4 の集計基準。 */
function jstDayStartIso(nowIso: string): string {
  const jstMs = Date.parse(nowIso) + JST_OFFSET_MS;
  const jst = new Date(jstMs);
  const startOfDayJstMs = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return new Date(startOfDayJstMs - JST_OFFSET_MS).toISOString();
}

function addHoursIso(baseIso: string, hours: number): string {
  return new Date(Date.parse(baseIso) + hours * 60 * 60 * 1000).toISOString();
}

/** Q4: 1ホストが当日の公開のうち占めてよい最大件数。 */
function hostShareCapCount(): number {
  return Math.max(1, Math.floor(DAILY_PUBLISH_CAP * HOST_DAILY_SHARE_MAX));
}

async function isRateCapped(canonical: string, now: string): Promise<boolean> {
  let host = "";
  try {
    host = new URL(canonical).host;
  } catch {
    // 正規化済みのはずだが念のため。host 不明時はグローバル上限のみで判定する。
  }
  const sinceIso = jstDayStartIso(now);
  const [total, byHost] = await Promise.all([
    countPublishedSince(sinceIso),
    countPublishedSinceByHost(sinceIso),
  ]);
  const hostCount = byHost[host] ?? 0;
  return total >= DAILY_PUBLISH_CAP || hostCount >= hostShareCapCount();
}

function backoffHoursFor(attempts: number): number {
  const idx = Math.min(attempts, RETRY_BACKOFF_HOURS.length - 1);
  return RETRY_BACKOFF_HOURS[idx] ?? RETRY_BACKOFF_HOURS[RETRY_BACKOFF_HOURS.length - 1];
}

/**
 * 一時的失敗（LLM 呼び出し失敗・Q4 レート上限繰り延べ）を再試行キューに積む、
 * または最大試行数超過なら諦める（plan 07 §7・D5 是正）。
 *
 * `ctx` が渡された場合（`ingest.ts` の消費ループが再試行キューから取り出して
 * 再処理している場合）は既存の attempts / firstQueuedAt を引き継いで
 * インクリメントする。`null`（初回失敗）の場合は attempts=0 から開始する
 * （discovery-ingest.ts の `retryOrGiveUp` と同じ方針）。
 * 諦めた場合（最大試行数超過）は `true` を返す。
 */
async function enqueueEvergreenRetry(
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

  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    // 不正 URL は host 空文字のまま積む（lane="evergreen" で識別できる）。
  }
  await enqueueRetry({
    urlHash: ctx?.urlHash ?? hashUrl(url),
    url,
    host,
    lane: "evergreen",
    reason,
    attempts: nextAttempts,
    firstQueuedAt,
    nextAttemptAt: addHoursIso(now, backoffHoursFor(attempts)),
    expiresAt: addHoursIso(firstQueuedAt, RETRY_TTL_HOURS),
  });
  return false;
}

// ─────────────────────────────────────────────────────────────
// posts 行の書き込みヘルパ
// ─────────────────────────────────────────────────────────────

/**
 * posts テーブルへクロール由来フィールドを upsert し、解決した `posts.id` を
 * 返す（失敗時は null）。`status` は指定しない＝スキーマ既定の "published" の
 * まま挿入されるが、この関数の呼び出し元は必ず直後に `markDropped` /
 * `markCurated` のいずれかで実際の終端ステータスを確定させる。
 */
async function upsertEvergreenRow(
  canonical: string,
  title: string,
  meta: OgpMetadata,
  sourceName: string,
): Promise<number | null> {
  const upsertResult = await upsertPosts([
    {
      url: canonical,
      sourceType: "blog",
      sourceId: EVERGREEN_SOURCE_ID,
      sourceName,
      originalTitle: title,
      originalExcerpt: meta.description,
      author: meta.author ?? null,
      thumbnailUrl: meta.image ?? null,
      publishedAt: meta.datePublished ?? null,
    },
  ]);
  if (upsertResult.failed.length > 0) return null;
  const states = await getPostsByUrls([canonical]);
  return states.get(canonical)?.id ?? null;
}

/**
 * TTL 超過（retry_exhausted）による終端棄却専用のエントリポイント
 * （plan 07 D5）。`ingest.ts` の消費ループが `expireRetries` で削除された
 * evergreen レーンのエントリに対して呼ぶ。この時点では再試行キューの行が
 * 既に削除されており OGP メタデータを持たないため、`fetchOgpMetadata` を
 * 再度叩かず、捏造せず URL のみを origin として post 行を作成し終端棄却する。
 */
export async function terminateEvergreenRetry(url: string, now: string): Promise<void> {
  const canonical = canonicalizeUrl(url) ?? url;
  let host = "";
  try {
    host = new URL(canonical).host;
  } catch {
    // 不正 URL は host 空文字のまま扱う。
  }
  const sourceName = registrableDomain(canonical) ?? (host || "unknown");
  const upsertResult = await upsertPosts([
    {
      url: canonical,
      sourceType: "blog",
      sourceId: EVERGREEN_SOURCE_ID,
      sourceName,
      originalTitle: canonical,
      originalExcerpt: null,
      author: null,
      thumbnailUrl: null,
      publishedAt: null,
    },
  ]);
  if (upsertResult.failed.length > 0) return;
  const states = await getPostsByUrls([canonical]);
  const postId = states.get(canonical)?.id;
  if (postId == null) return;
  await markDropped(postId, "retry_exhausted", now);
}

/** §7: 終端棄却。post 行を作成したうえで `markDropped` を呼ぶ。 */
async function dropEvergreen(
  canonical: string,
  title: string,
  meta: OgpMetadata,
  sourceName: string,
  reason: DropReason,
  now: string,
): Promise<EvergreenOutcome> {
  const postId = await upsertEvergreenRow(canonical, title, meta, sourceName);
  if (postId === null) return { ok: false, reason: "save_failed", card: null };
  await markDropped(postId, reason, now);
  return { ok: true, reason, card: null };
}

/** published として保存し、判定根拠（rationale）・公開記録も行う。 */
async function publishEvergreen(
  canonical: string,
  sourceTitle: string,
  excerpt: string,
  meta: OgpMetadata,
  sourceName: string,
  curation: CurationResult,
  now: string,
): Promise<EvergreenOutcome> {
  const postId = await upsertEvergreenRow(canonical, sourceTitle, meta, sourceName);
  if (postId === null) return { ok: false, reason: "save_failed", card: null };

  // M1-3: 撤回済み（sticky）投稿は公開しない（自動復帰しない。§5-M4）。
  if (await isRemoved(postId)) {
    return { ok: true, reason: "removed", card: null };
  }

  const markResult = await markCurated([
    {
      url: canonical,
      aiSummary: curation.summary,
      category: curation.category,
      tag: "classic" as TrendTag,
      contentHash: computeContentHash(sourceTitle, excerpt),
      curationSignature: computeCurationSignature(),
      status: "published",
      usefulness: {
        postId,
        criteria: {
          firsthand: curation.firsthand,
          ceremonyDecision: curation.ceremonyDecision,
          specific: curation.specific,
          weddingDayContent: curation.weddingDayContent,
          promotional: curation.promotional,
          preDecisionOrPhotoShoot: curation.preDecisionOrPhotoShoot,
        },
        modelId: LLM_MODEL,
      },
      // Q1 相当ゲート（原文テキストの有無）を通過した時点で evidenceSufficient は
      // 真であることが保証されているため、LLM の自己申告ではなく固定で true を渡す。
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
  if (markResult.failed.length > 0) {
    console.warn(`[evergreen] markCurated failed for ${canonical}`);
    return { ok: false, reason: "save_failed", card: null };
  }

  // §5 公開の記録。bodyHash は本来「判定に使った正規化本文」のハッシュだが、
  // evergreen レーンは `fetchOgpMetadata()` が og:description のみを返し、
  // 呼び出し元は記事本文全体の HTML を保持していない（内部で取得した HTML は
  // 呼び出し元に返らない設計）。そのため判定に使った唯一のテキスト
  // （タイトル+抜粋）のハッシュを代替フィンガープリントとして使う。
  // ⚠️ M4（本文ハッシュドリフトによる自動撤回）にこの値を使う場合はこの
  // 前提（本文全体ではない）を踏まえること。完了報告で明示する。
  const bodyHash = computeContentHash(sourceTitle, excerpt);
  // evergreen レーンは記事本文を取得せず og:description を持つのみのため、
  // bodyHash は本文フィンガープリントではない代替値。"surrogate" として明示する
  // （plan 07 D3: M4 の本文ドリフト判定に使わせないため）。
  await recordPublication(postId, now, bodyHash, "surrogate");

  const card: FeedCard = {
    id: postId,
    sourceType: "blog",
    sourceId: EVERGREEN_SOURCE_ID,
    sourceName,
    url: canonical,
    originalTitle: sourceTitle,
    author: meta.author ?? null,
    publishedAt: meta.datePublished ?? null,
    thumbnailUrl: meta.image ?? null,
    aiSummary: curation.summary,
    category: curation.category,
    tag: "classic" as TrendTag,
    embedProvider: "none",
    embedHtml: null,
    topicAnchor: curation.topicAnchor,
    rationaleText: curation.rationaleText,
    usefulness: null,
  };
  return { ok: true, reason: null, card };
}

export async function curateEvergreenUrl(
  url: string,
  opts?: { sourceName?: string },
  /**
   * 再試行キューからの再処理時に渡す文脈（plan 07 D5）。`ingest.ts` の
   * 消費ループがこれを渡すことで attempts / TTL の会計を実行をまたいで
   * 継続できる。管理者操作からの初回呼び出しは省略（`undefined`）でよい。
   */
  ctx?: RetryContext | null,
): Promise<EvergreenOutcome> {
  const canonical = canonicalizeUrl(url);
  if (!canonical) return { ok: false, reason: "invalid_url", card: null };

  const meta = await fetchOgpMetadata(canonical);
  if (!meta || !meta.title) return { ok: false, reason: "no_metadata", card: null };

  // P2: クレジットを解決。解決不能なら捏造せずに拒否する。
  const sourceName = resolveSourceName(canonical, meta, opts);
  if (sourceName === null) return { ok: false, reason: "no_source_name", card: null };

  const sourceTitle = meta.title;
  const excerpt = meta.description;
  const now = new Date().toISOString();

  // Q1 相当（簡易版）: evergreen レーンは記事本文の HTML を取得するが
  // （`fetchOgpMetadata` 内部）、呼び出し元に返るのは OGP メタデータのみで
  // 生 HTML は保持されない。そのため `computeEvidenceSignals()`（リンク密度・
  // 段落数・定型行率）は原理的に適用できず、既存の「原文テキスト
  // （og:description）の有無」チェックを唯一の決定的ゲートとして維持する
  // （LLM 呼び出し前に判定し、無ければ LLM を呼ばず終端棄却する）。
  if (!excerpt || !excerpt.trim()) {
    return dropEvergreen(canonical, sourceTitle, meta, sourceName, "extraction_insufficient", now);
  }

  const curationResult = await curateSingle({ title: sourceTitle, excerpt });
  if (curationResult === null) {
    // LLM 呼び出し失敗（一時的技術障害）→ 再試行キューへ。post 行はまだ
    // 作らない（discovery-ingest.ts の retryOrGiveUp と同じ方針: 終端が
    // 確定するまで posts テーブルへは書かない）。最大試行数を超えていれば
    // 諦めて retry_exhausted で終端棄却する（plan 07 D5）。
    const gaveUp = await enqueueEvergreenRetry(canonical, "llm_transient", now, ctx ?? null);
    if (gaveUp) {
      return dropEvergreen(canonical, sourceTitle, meta, sourceName, "retry_exhausted", now);
    }
    return { ok: true, reason: "queued_for_retry", card: null };
  }

  // M1-1: タイトル公開フィルタ（第三者が書いた逐語タイトルの無検閲公開を防ぐ）。
  const titleGate = filterTitle(sourceTitle);
  if (!titleGate.ok) {
    return dropEvergreen(canonical, sourceTitle, meta, sourceName, "title_filter", now);
  }

  // M1-2: topicAnchor の語彙的接地（plan 07 D4 是正）。evergreen レーンは
  // 記事本文全体を保持しない（`fetchOgpMetadata` が og:description のみ返す）
  // ため「取得本文」への接地は検証できないが、比較対象は本文である必要は
  // ない。LLM に実際に渡した入力（タイトル+og:description、curateSingle() へ
  // の入力そのもの）に対して検証すれば、プロンプトインジェクションと幻覚の
  // 両方に対する関門として機能する。
  const anchorGate = checkAnchorGrounding(curationResult.topicAnchor, `${sourceTitle}\n${excerpt}`);
  if (!anchorGate.ok) {
    console.warn(
      `[evergreen] anchor ungrounded for ${canonical}: missingTerms=${JSON.stringify(
        anchorGate.missingTerms ?? [],
      )}`,
    );
    return dropEvergreen(canonical, sourceTitle, meta, sourceName, "anchor_ungrounded", now);
  }

  // TODO(plan07-Q3): evergreen は管理者が手動投入した任意ホストの URL から
  // OGP メタデータを取得する（HTML 自体は取得している）。HOST_ALLOWLIST
  // （現状 www.mwed.jp のみ）を適用すると、それ以外のホストへの手動
  // キュレーションが全て止まる（shared_plan/05-evergreen-automation.md の
  // 「ホスト昇格」前提と矛盾する）。この判断は保留し、実装せず完了報告で
  // エスカレーションする。

  // Q4: 公開レート上限（日次上限・ホストシェア上限）。上限到達は終端棄却では
  // なく再試行キューへの繰り延べ（良い記事を上限で捨てない）。ただし最大
  // 試行数を超えていれば諦めて retry_exhausted で終端棄却する（plan 07 D5）。
  if (await isRateCapped(canonical, now)) {
    const gaveUp = await enqueueEvergreenRetry(canonical, "rate_capped", now, ctx ?? null);
    if (gaveUp) {
      return dropEvergreen(canonical, sourceTitle, meta, sourceName, "retry_exhausted", now);
    }
    return { ok: true, reason: "rate_limited", card: null };
  }

  return publishEvergreen(canonical, sourceTitle, excerpt, meta, sourceName, curationResult, now);
}
