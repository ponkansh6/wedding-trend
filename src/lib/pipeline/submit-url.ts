import {
  RATIONALE_PROMPT_VERSION,
  RETRY_BACKOFF_HOURS,
  RETRY_MAX_ATTEMPTS,
  RETRY_TTL_HOURS,
} from "@/lib/constants";
import {
  completeRetry,
  enqueueRetry,
  getPostsByUrls,
  hashUrl,
  isRemoved,
  markCurated,
  markDropped,
  recordPublication,
  saveEmbed,
  upsertPosts,
} from "@/lib/db/repository";
import { detectEmbedProvider } from "@/lib/embed/providers";
import { fetchOEmbed, type OEmbedResult } from "@/lib/embed/oembed";
import { curateSingle, type CurationResult } from "@/lib/llm/batch";
import { LLM_MODEL } from "@/lib/llm/client";
import { computeContentHash, computeCurationSignature } from "@/lib/llm/signature";
import { isDailyPublishCapReached } from "@/lib/pipeline/rate-cap";
import { filterTitle } from "@/lib/publish/gate";
import type { DropReason, EmbedProvider, FeedCard, RetryContext, RetryReason } from "@/lib/types";
import { canonicalizeUrl } from "@/lib/url";

/**
 * SNS 単発投稿の取り込み結果。
 * `reason` は表示用文言そのものではなく、呼び出し側（Route Handler / Server Action）が
 * HTTP ステータスや日本語メッセージへ変換するための安定した内部コード。
 * - 失敗時（`ok:false`）: `"invalid_url"` | `"save_failed"`
 * - 終端棄却（`ok:true`・plan 07 §7）: `"extraction_insufficient"`（要約対象の
 *   原文テキストが存在しない） | `"title_filter"`
 * - 撤回済み（`ok:true`・sticky）: `"removed"`
 * - 一時的失敗を再試行キューへ繰り延べ（`ok:true`）: `"queued_for_retry"` | `"rate_limited"`
 * - 成功: `null`
 */
export type SubmitOutcome = {
  ok: boolean;
  reason: string | null;
  card: FeedCard | null;
};

const PROVIDER_DISPLAY_NAME: Record<EmbedProvider, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  none: "SNS",
};

// ─────────────────────────────────────────────────────────────
// plan 07: TTL 付き再試行キュー・レート上限のヘルパ（submit-url レーン）
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

async function isRateCapped(_canonical: string, now: string): Promise<boolean> {
  // spec §11 項4: 日次公開サーキットブレーカーのみ（ホスト別シェア上限は廃止）。
  return isDailyPublishCapReached(jstDayStartIso(now));
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
 * インクリメントする。`null`（初回失敗）の場合は attempts=0 から開始する。
 * 諦めた場合（最大試行数超過）は `true` を返す。
 *
 * ⚠️ 既知の制約: 再試行キューは URL / host / lane / reason のみを保持し、
 * 管理者が投稿時に添えた任意の補足メモ（`note`）は永続化しない
 * （スキーマは §7 導入時に固定済みで、追加専用のマイグレーション制約上
 * カラムを後から足せない）。そのため再試行時の再処理（`ingest.ts` の
 * 消費ループ）は `note` 無しで `runSubmitUrl` を呼び直す。oEmbed が
 * キャプション/タイトルを返すホスト（YouTube・TikTok・多くの Instagram
 * 投稿）では実質的に無害だが、oEmbed が何も返さず `note` だけが唯一の
 * 原文テキストだったケース（例: キャプション無しの Instagram 投稿）では、
 * 初回は `note` により公開できたはずの投稿が、再試行時には
 * `extraction_insufficient` で終端棄却される可能性がある。これは
 * データを捏造しない安全側の劣化（機能追加ではなく既存の「原文が無ければ
 * 公開しない」方針の帰結）であり、意図的にこの制約を許容している。
 */
async function enqueueSubmitRetry(
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
    // 不正 URL は host 空文字のまま積む（lane="submit" で識別できる）。
  }
  await enqueueRetry({
    urlHash: ctx?.urlHash ?? hashUrl(url),
    url,
    host,
    lane: "submit",
    reason,
    attempts: nextAttempts,
    firstQueuedAt,
    nextAttemptAt: addHoursIso(now, backoffHoursFor(attempts)),
    expiresAt: addHoursIso(firstQueuedAt, RETRY_TTL_HOURS),
  });
  return false;
}

// ─────────────────────────────────────────────────────────────
// posts 行 / embed の書き込みヘルパ
// ─────────────────────────────────────────────────────────────

/**
 * posts テーブルへクロール由来フィールドを upsert し、解決した `posts.id` を
 * 返す（失敗時は null）。`status` は指定しない＝スキーマ既定の "published" の
 * まま挿入されるが、呼び出し元は必ず直後に `markDropped` / `markCurated` の
 * いずれかで実際の終端ステータスを確定させる。
 */
async function upsertSubmitRow(
  canonical: string,
  provider: EmbedProvider,
  title: string,
  excerpt: string | null,
  embed: OEmbedResult | null,
): Promise<number | null> {
  const upsertResult = await upsertPosts([
    {
      url: canonical,
      sourceType: "sns",
      sourceId: provider === "none" ? "sns" : provider,
      sourceName: PROVIDER_DISPLAY_NAME[provider],
      originalTitle: title,
      originalExcerpt: excerpt,
      author: embed?.authorName ?? null,
      thumbnailUrl: embed?.thumbnailUrl ?? null,
      // oEmbed は投稿日時を返さないため不明扱い。
      publishedAt: null,
    },
  ]);
  if (upsertResult.failed.length > 0) return null;
  const states = await getPostsByUrls([canonical]);
  return states.get(canonical)?.id ?? null;
}

/**
 * TTL 超過（retry_exhausted）による終端棄却専用のエントリポイント
 * （plan 07 D5）。`ingest.ts` の消費ループが `expireRetries` で削除された
 * submit レーンのエントリに対して呼ぶ。この時点では再試行キューの行が
 * 既に削除されており、元の oEmbed/note は失われているため、捏造せず
 * URL のみを origin として post 行を作成し終端棄却する。
 */
export async function terminateSubmitRetry(url: string, now: string): Promise<void> {
  const canonical = canonicalizeUrl(url) ?? url;
  const provider = detectEmbedProvider(canonical);
  const postId = await upsertSubmitRow(canonical, provider, canonical, null, null);
  if (postId === null) return;
  await markDropped(postId, "retry_exhausted", now);
}

async function saveEmbedIfPresent(
  canonical: string,
  embed: OEmbedResult | null,
  now: string,
): Promise<void> {
  if (!embed) return;
  await saveEmbed(canonical, {
    embedProvider: embed.provider,
    embedHtml: embed.html,
    embedFetchedAt: now,
  });
}

/** §7: 終端棄却。post 行を作成・embed を保存したうえで `markDropped` を呼ぶ。 */
async function dropSubmit(
  canonical: string,
  provider: EmbedProvider,
  embed: OEmbedResult | null,
  title: string,
  excerpt: string | null,
  reason: DropReason,
  now: string,
): Promise<SubmitOutcome> {
  const postId = await upsertSubmitRow(canonical, provider, title, excerpt, embed);
  if (postId === null) return { ok: false, reason: "save_failed", card: null };
  await saveEmbedIfPresent(canonical, embed, now);
  await markDropped(postId, reason, now);
  return { ok: true, reason, card: null };
}

/** published として保存し、判定根拠（rationale）・embed・公開記録も行う。 */
async function publishSubmit(
  canonical: string,
  provider: EmbedProvider,
  embed: OEmbedResult | null,
  sourceTitle: string,
  excerpt: string | null,
  curation: CurationResult,
  now: string,
): Promise<SubmitOutcome> {
  const postId = await upsertSubmitRow(canonical, provider, sourceTitle, excerpt, embed);
  if (postId === null) return { ok: false, reason: "save_failed", card: null };

  // M1-3: 撤回済み（sticky）投稿は公開しない（自動復帰しない。§5-M4）。
  if (await isRemoved(postId)) {
    await saveEmbedIfPresent(canonical, embed, now);
    return { ok: true, reason: "removed", card: null };
  }

  const markResult = await markCurated([
    {
      url: canonical,
      aiSummary: curation.summary,
      category: curation.category,
      tag: curation.tag,
      contentHash: computeContentHash(sourceTitle, excerpt),
      curationSignature: computeCurationSignature(),
      status: "published",
      // post_usefulness は体験談レーン（sourceType: "blog"）専用のため、
      // SNS 単発投稿ではこれまでどおり渡さない。
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
    console.warn(`[submit-url] markCurated failed for ${canonical}`);
    return { ok: false, reason: "save_failed", card: null };
  }

  await saveEmbedIfPresent(canonical, embed, now);

  // §5 公開の記録。bodyHash は本来「判定に使った正規化本文」のハッシュだが、
  // submit-url レーンは記事本文を一切取得せず、oEmbed のキャプション＋運営の
  // 補足メモしか判定材料を持たない。そのため判定に使った唯一のテキスト
  // （タイトル+抜粋）のハッシュを代替フィンガープリントとして使う。
  const bodyHash = computeContentHash(sourceTitle, excerpt);
  // submit-url レーンは oEmbed キャプション等しか持たず記事本文を取得しないため、
  // bodyHash は本文フィンガープリントではない代替値。"surrogate" として明示する
  // （plan 07 D3: M4 の本文ドリフト判定に使わせないため）。
  await recordPublication(postId, now, bodyHash, "surrogate");

  const card: FeedCard = {
    id: postId,
    sourceType: "sns",
    sourceId: provider === "none" ? "sns" : provider,
    sourceName: PROVIDER_DISPLAY_NAME[provider],
    url: canonical,
    originalTitle: sourceTitle,
    author: embed?.authorName ?? null,
    publishedAt: null,
    thumbnailUrl: embed?.thumbnailUrl ?? null,
    aiSummary: curation.summary,
    category: curation.category,
    tag: curation.tag,
    embedProvider: embed?.provider ?? "none",
    embedHtml: embed?.html ?? null,
    // 既存挙動を踏襲: SNS レーンは topicAnchor/rationaleText を表示に使わない
    // （anchor grounding を検証できないこのレーンでは特に、根拠 UI を出さない
    // 既存の判断を維持する）。
    topicAnchor: null,
    rationaleText: null,
    usefulness: null,
  };

  return { ok: true, reason: null, card };
}

/**
 * SNS 投稿 URL を 1 件取り込む（oEmbed 取得 → LLM キュレーション → 決定的
 * ゲート → 保存）まで一気通貫で行う。`/api/submit-url` の Route Handler
 * （curl / 管理者投入）と `submitSnsUrl` Server Action（UI）の両方から呼ばれる
 * 唯一の実装。
 *
 * `note` は管理者が添えた補足であり原文ではないため、事実の補完には使わず
 * 追加コンテキストとして併記するに留める（UI からは渡されない想定・省略可）。
 *
 * Instagram のキーなし oEmbed は `title`（キャプション）を一切返さない
 * （2026-08-21 に実リクエストで確認済み）。embed にも note にも実体テキストが
 * 無い状態で LLM に要約させると、原文に存在しない内容を捏造してしまい
 * spec.md §9（法務制約: AI 要約は原文に無い内容を創作しない）に反する。
 * そのため「要約対象の原文テキストが存在するか」を LLM 呼び出しの前に判定し
 * （Q1 相当・簡易版: このレーンは記事本文の HTML を一切取得しないため
 * `computeEvidenceSignals()` は適用できず、原文テキストの有無のみを唯一の
 * 決定的ゲートとして使う）、存在しない場合は `curateSingle` を呼ばずに
 * 終端棄却する（embed 自体は保存し、再取得コストを避ける）。
 *
 * Q3（ホスト allowlist）は適用しない: このレーンは oEmbed（Instagram /
 * TikTok / YouTube の公式エンドポイント）のみを情報源とし、記事本文を
 * 任意ホストからスクレイピングしない（プロバイダ自体が固定の allowlist と
 * して機能する）。
 */
export async function runSubmitUrl(
  url: string,
  note?: string,
  /**
   * 再試行キューからの再処理時に渡す文脈（plan 07 D5）。`ingest.ts` の
   * 消費ループがこれを渡すことで attempts / TTL の会計を実行をまたいで
   * 継続できる。管理者/API からの初回呼び出しは省略（`undefined`）でよい。
   */
  ctx?: RetryContext | null,
): Promise<SubmitOutcome> {
  const canonical = canonicalizeUrl(url);
  if (!canonical) {
    return { ok: false, reason: "invalid_url", card: null };
  }

  const provider = detectEmbedProvider(canonical);
  const embed = await fetchOEmbed(canonical);

  // 空白のみの note は「補足なし」として扱う。
  const trimmedNote = note?.trim();
  const normalizedNote = trimmedNote && trimmedNote !== "" ? trimmedNote : null;

  const embedTitle = embed?.title && embed.title.trim() !== "" ? embed.title.trim() : null;

  // 原文由来のテキスト = oEmbed のキャプション（提供されれば）+ 運営が添えた補足メモ。
  // どちらも無ければ、LLM に渡せる実体テキストが存在しない。
  const hasSourceText = embedTitle !== null || normalizedNote !== null;

  const now = new Date().toISOString();

  if (!hasSourceText) {
    // ラベルであり要約ではないため、原文が無くても捏造にはあたらない。
    return dropSubmit(canonical, provider, embed, "SNS 投稿", null, "extraction_insufficient", now);
  }

  // oEmbed のタイトル/キャプションと補足メモを「原文由来のテキスト」として LLM に渡す。
  const sourceTitle = embedTitle ?? normalizedNote ?? "SNS 投稿";
  const excerptParts = [embedTitle, normalizedNote].filter((v): v is string => v !== null);
  const excerpt = excerptParts.length > 0 ? excerptParts.join("\n") : null;

  const curationResult = await curateSingle({ title: sourceTitle, excerpt });
  if (curationResult === null) {
    // LLM 呼び出し失敗（一時的技術障害）→ 再試行キューへ。post 行はまだ
    // 作らない（discovery-ingest.ts の retryOrGiveUp と同じ方針: 終端が
    // 確定するまで posts テーブルへは書かない）。最大試行数を超えていれば
    // 諦めて retry_exhausted で終端棄却する（plan 07 D5）。
    const gaveUp = await enqueueSubmitRetry(canonical, "llm_transient", now, ctx ?? null);
    if (gaveUp) {
      return dropSubmit(canonical, provider, embed, sourceTitle, excerpt, "retry_exhausted", now);
    }
    return { ok: true, reason: "queued_for_retry", card: null };
  }

  // M1-1: タイトル公開フィルタ（第三者が書いた逐語タイトルの無検閲公開を防ぐ）。
  const titleGate = filterTitle(sourceTitle);
  if (!titleGate.ok) {
    return dropSubmit(canonical, provider, embed, sourceTitle, excerpt, "title_filter", now);
  }

  // D5 (shared_plan/16): topicAnchor の検証・再生成・degrade は curateSingle 内で行われる。失敗時は null で公開し、棄却しない。

  // Q4: 公開レート上限（日次上限・ホストシェア上限）。上限到達は終端棄却では
  // なく再試行キューへの繰り延べ（良い記事を上限で捨てない）。ただし最大
  // 試行数を超えていれば諦めて retry_exhausted で終端棄却する（plan 07 D5）。
  if (await isRateCapped(canonical, now)) {
    const gaveUp = await enqueueSubmitRetry(canonical, "rate_capped", now, ctx ?? null);
    if (gaveUp) {
      return dropSubmit(canonical, provider, embed, sourceTitle, excerpt, "retry_exhausted", now);
    }
    return { ok: true, reason: "rate_limited", card: null };
  }

  return publishSubmit(canonical, provider, embed, sourceTitle, excerpt, curationResult, now);
}
