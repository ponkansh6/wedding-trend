import {
  CURATION_BUDGET,
  DAILY_PUBLISH_CAP,
  RATIONALE_PROMPT_VERSION,
  RETRY_BACKOFF_HOURS,
  RETRY_MAX_ATTEMPTS,
  RETRY_TTL_HOURS,
  SOURCE_ITEM_LIMIT,
} from "@/lib/constants";
import {
  completeRetry,
  countPublishedSince,
  dueRetries,
  enqueueRetry,
  expireRetries,
  filterRemoved,
  getPostsByUrls,
  getStaleCurationCandidates,
  hashUrl,
  markCurated,
  markDropped,
  readLastRunSummary,
  recordPublication,
  saveLastRunSummary,
  upsertPosts,
  type CurationCandidate,
  type CurationUpdate,
  type PostUpsertInput,
} from "@/lib/db/repository";
import { curatePosts } from "@/lib/llm/batch";
import { LLM_MODEL } from "@/lib/llm/client";
import { computeContentHash, computeCurationSignature } from "@/lib/llm/signature";
import { filterTitle } from "@/lib/publish/gate";
import { curateEvergreenUrl, terminateEvergreenRetry } from "@/lib/pipeline/evergreen";
import { isDailyPublishCapReached } from "@/lib/pipeline/rate-cap";
import { runSubmitUrl, terminateSubmitRetry } from "@/lib/pipeline/submit-url";
import { SOURCE_IDS, SOURCE_REGISTRY, type SourceAdapter } from "@/lib/sources/registry";
import type { PostStatus, RetryContext, RetryLane, RetryReason } from "@/lib/types";
import { canonicalizeUrl } from "@/lib/url";

/**
 * RSS 巡回パイプラインの実行結果。
 * `/api/ingest`（cron / curl）と Server Action（UI ボタン）の両方から
 * 同じ形で結果を受け取れるよう、シリアライズ可能な値のみで構成する。
 *
 * `geminiCalls` は今回のランで実際に Gemini API を呼んだ回数
 * （`curatePosts()` からそのまま伝播する）。0 なら Gemini の課金コストが
 * 一切発生していないことを意味し、呼び出し元はこれを使ってクールダウンを
 * 4 時間へ延長すべきかどうかを判定する（`src/lib/pipeline/cooldown.ts` の
 * `extendIngestCooldownAfterRun` を参照）。
 */
export type IngestSummary = {
  fetched: number;
  inserted: number;
  curated: number;
  skipped: number;
  errors: string[];
  geminiCalls: number;
};

/** `runIngest()` を呼んだ経路。`last_run_summary` のテレメトリに残す。 */
export type IngestTrigger = "manual" | "cron";

/**
 * `config` の `last_run_summary` に保存する直近ラン結果のスキーマ。
 *
 * `finishedAt` はラン開始時に一旦 `null` で保存し、完了時に確定させる
 * （`runIngest()` 冒頭と末尾の 2 回の `saveRunSummarySafely()` 呼び出しを
 * 参照）。そのため、もし `finishedAt` が `null` のレコードが残っていれば、
 * 前回のランが完了しなかった（タイムアウト・クラッシュ等）と判定できる。
 */
export interface LastRunSummary {
  startedAt: string;
  finishedAt: string | null;
  fetched: number;
  inserted: number;
  curated: number;
  geminiCalls: number;
  errorCount: number;
  trigger: IngestTrigger;
}

/**
 * `last_run_summary` の保存はテレメトリであり、本処理（収集ラン）を落として
 * はならない。書き込み経路（`saveLastRunSummary`）自体は既存の設計方針通り
 * fail-closed（例外を投げる）のままにしているため、ここで意図的に catch して
 * 握りつぶす（詳細は `saveLastRunSummary` の JSDoc を参照）。
 */
async function saveRunSummarySafely(summary: LastRunSummary): Promise<void> {
  try {
    await saveLastRunSummary(JSON.stringify(summary), new Date().toISOString());
  } catch (err) {
    console.warn("[ingest] failed to save last_run_summary (telemetry only, continuing):", err);
  }
}

/**
 * 直近の収集ラン結果を返す。UI からの利用は後続タスクが行う。
 *
 * **フェイルソフト**: `last_run_summary` が未保存、パース不能、または
 * 期待する形（`LastRunSummary`）と一致しない場合は `null` を返す
 * （テレメトリの読み取りが例外で他機能を巻き込まないようにするため）。
 */
export async function getLastRunSummary(): Promise<LastRunSummary | null> {
  const raw = await readLastRunSummary();
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn("[ingest] getLastRunSummary: JSON parse failed:", err);
    return null;
  }

  if (!isLastRunSummary(parsed)) {
    console.warn("[ingest] getLastRunSummary: malformed shape, ignoring stored value");
    return null;
  }
  return parsed;
}

function isLastRunSummary(value: unknown): value is LastRunSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.startedAt === "string" &&
    (v.finishedAt === null || typeof v.finishedAt === "string") &&
    typeof v.fetched === "number" &&
    typeof v.inserted === "number" &&
    typeof v.curated === "number" &&
    typeof v.geminiCalls === "number" &&
    typeof v.errorCount === "number" &&
    (v.trigger === "manual" || v.trigger === "cron")
  );
}

// ─────────────────────────────────────────────────────────────
// plan 07: TTL 付き再試行キュー・レート上限のヘルパ（RSS レーン）
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

function backoffHoursFor(attempts: number): number {
  const idx = Math.min(attempts, RETRY_BACKOFF_HOURS.length - 1);
  return RETRY_BACKOFF_HOURS[idx] ?? RETRY_BACKOFF_HOURS[RETRY_BACKOFF_HOURS.length - 1];
}

/**
 * 一時的失敗（LLM 呼び出し失敗・Q4 レート上限繰り延べ）を再試行キューに積む、
 * または最大試行数超過なら諦める（plan 07 §7・D5 是正）。
 *
 * `ctx` が渡された場合（この関数末尾の `processDueRetries` が再試行キューから
 * 取り出して再処理している場合）は既存の attempts / firstQueuedAt を引き継いで
 * インクリメントする。`null`（初回失敗）の場合は attempts=0 から開始する
 * （discovery-ingest.ts の `retryOrGiveUp` と同じ方針）。
 * 諦めた場合（最大試行数超過）は `true` を返す。
 */
async function enqueueRssRetry(
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
    // 正規化済み URL のはずだが念のため。host 空文字のまま積む（lane="rss" で識別できる）。
  }
  await enqueueRetry({
    urlHash: ctx?.urlHash ?? hashUrl(url),
    url,
    host,
    lane: "rss",
    reason,
    attempts: nextAttempts,
    firstQueuedAt,
    nextAttemptAt: addHoursIso(now, backoffHoursFor(attempts)),
    expiresAt: addHoursIso(firstQueuedAt, RETRY_TTL_HOURS),
  });
  return false;
}

/**
 * 再試行キューから取り出した rss レーンのエントリを単発で再処理する
 * （plan 07 D5）。rss レーンの post 行は初回失敗時点で既に upsert 済み
 * （main loop 冒頭の `upsertPosts`）のため、ここでは再クロールではなく、
 * 保存済みの `originalTitle` / `originalExcerpt` を使ってキュレーションを
 * やり直す。main loop の per-item ゲート（M1-1/M1-2/Q4）と同じ順序で適用する。
 */
async function reprocessRssRetry(url: string, ctx: RetryContext, now: string): Promise<void> {
  const states = await getPostsByUrls([url]);
  const state = states.get(url);
  if (state?.id == null) {
    // post 行が見当たらない（何らかの理由で失われた）。キューだけ掃除する。
    await completeRetry(ctx.urlHash);
    return;
  }
  const postId = state.id;
  const title = state.originalTitle;
  const excerpt = state.originalExcerpt;

  const { results } = await curatePosts([{ title, excerpt }]);
  const result = results[0];
  if (!result) {
    const gaveUp = await enqueueRssRetry(url, "llm_transient", now, ctx);
    if (gaveUp) await markDropped(postId, "retry_exhausted", now);
    return;
  }

  const titleGate = filterTitle(title);
  if (!titleGate.ok) {
    await completeRetry(ctx.urlHash);
    await markDropped(postId, "title_filter", now);
    return;
  }

  // D5 (shared_plan/16): topicAnchor の検証・再生成・degrade は curateSingle/curateBatch 内で行われる。失敗時は null で公開し、棄却しない。

  // Q4: 日次公開サーキットブレーカーのみ（ホスト別シェア上限は廃止。spec §11 項4）。
  if (await isDailyPublishCapReached(jstDayStartIso(now))) {
    const gaveUp = await enqueueRssRetry(url, "rate_capped", now, ctx);
    if (gaveUp) await markDropped(postId, "retry_exhausted", now);
    return;
  }

  const bodyHash = computeContentHash(title, excerpt);
  const markResult = await markCurated([
    {
      url,
      aiSummary: result.summary,
      category: result.category,
      tag: result.tag,
      contentHash: bodyHash,
      curationSignature: computeCurationSignature(),
      status: "published" as PostStatus,
      usefulness: {
        postId,
        modelId: LLM_MODEL,
        criteria: {
          firsthand: result.firsthand,
          ceremonyDecision: result.ceremonyDecision,
          specific: result.specific,
          weddingDayContent: result.weddingDayContent,
          promotional: result.promotional,
          preDecisionOrPhotoShoot: result.preDecisionOrPhotoShoot,
        },
      },
      rationale: {
        postId,
        topicAnchor: result.topicAnchor,
        rationaleText: result.rationaleText,
        evidenceSufficient: true,
        modelId: LLM_MODEL,
        promptVersion: RATIONALE_PROMPT_VERSION,
      },
    },
  ]);
  if (markResult.failed.length === 0) {
    await completeRetry(ctx.urlHash);
    // rss レーンは本文を取得しないため bodyHash は代替値。"surrogate" として
    // 明示する（plan 07 D3）。
    await recordPublication(postId, now, bodyHash, "surrogate");
  }
}

const RETRY_PROCESS_LIMIT = 50;
const RSS_ADJACENT_LANES: RetryLane[] = ["rss", "evergreen", "submit"];

/**
 * plan 07 D5: rss/evergreen/submit レーン分の再試行キューの消費者。
 * discovery レーンは discovery-ingest.ts が `lanes: ["discovery"]` で独立に
 * 処理するため、ここでは触れない（双方が互いのエントリを奪い合わない）。
 */
async function processDueAndExpiredRetries(now: string): Promise<{ errors: string[] }> {
  const errors: string[] = [];

  // TTL 超過分の終端棄却。
  const expired = await expireRetries(now, RSS_ADJACENT_LANES);
  for (const entry of expired) {
    try {
      if (entry.lane === "rss") {
        const states = await getPostsByUrls([entry.url]);
        const postId = states.get(entry.url)?.id;
        if (postId != null) await markDropped(postId, "retry_exhausted", now);
      } else if (entry.lane === "evergreen") {
        await terminateEvergreenRetry(entry.url, now);
      } else {
        await terminateSubmitRetry(entry.url, now);
      }
    } catch (err) {
      errors.push(
        `retry-expire[${entry.lane}] ${entry.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // due（nextAttemptAt <= now、まだ TTL 内）分の実際の再処理。
  const due = await dueRetries(now, RETRY_PROCESS_LIMIT);
  for (const entry of due) {
    if (entry.lane === "discovery") continue; // discovery-ingest.ts が処理する。
    const ctx: RetryContext = {
      urlHash: entry.urlHash,
      attempts: entry.attempts,
      firstQueuedAt: entry.firstQueuedAt,
    };
    try {
      if (entry.lane === "rss") {
        await reprocessRssRetry(entry.url, ctx, now);
      } else if (entry.lane === "evergreen") {
        await curateEvergreenUrl(entry.url, undefined, ctx);
      } else {
        await runSubmitUrl(entry.url, undefined, ctx);
      }
    } catch (err) {
      errors.push(
        `retry-due[${entry.lane}] ${entry.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { errors };
}

/**
 * SOURCE_REGISTRY は各アダプタごとに固有のアイテム型 T を持つが、ここではソース
 * ID を横断的にループするため T を型消去して扱う（fetch と toPost は常に対の
 * アダプタから呼ぶので実行時の型不整合は起きない）。
 */
async function fetchAndNormalize(id: (typeof SOURCE_IDS)[number]): Promise<PostUpsertInput[]> {
  const adapter = SOURCE_REGISTRY[id] as unknown as SourceAdapter<unknown>;
  try {
    const items = await adapter.fetch(SOURCE_ITEM_LIMIT);
    return items.map((item) => adapter.toPost(item));
  } catch (err) {
    console.error(`[ingest] source "${id}" failed:`, err);
    throw err;
  }
}

/**
 * RSS 巡回 → 重複排除 → upsert → LLM キュレーション → フィードキャッシュ失効までの
 * 一連のパイプラインを実行する。`/api/ingest` の Route Handler（curl / Vercel Cron）と
 * `triggerIngest` Server Action（UI の取得ボタン）の両方から呼ばれる唯一の実装。
 *
 * `trigger` はテレメトリ（`last_run_summary`）に残すためだけの値で、
 * パイプラインの挙動そのものは変えない。呼び出し元を指定しない場合は
 * `"manual"`（UI ボタン経路）を既定値とする。
 */
export async function runIngest(trigger: IngestTrigger = "manual"): Promise<IngestSummary> {
  const startedAt = new Date().toISOString();
  // ラン開始時点でプレースホルダーを保存しておく。finishedAt が null のまま
  // このレコードが残っていれば、前回のランが完了しなかった（タイムアウト・
  // クラッシュ等）と判定できる（詳細は LastRunSummary の JSDoc を参照）。
  await saveRunSummarySafely({
    startedAt,
    finishedAt: null,
    fetched: 0,
    inserted: 0,
    curated: 0,
    geminiCalls: 0,
    errorCount: 0,
    trigger,
  });

  const errors: string[] = [];

  // 0. plan 07 D5: rss/evergreen/submit レーン分の再試行キューを消費する。
  // RSS cron の入口であるここから毎回呼ぶことで、Q4 の「上限到達分は翌日に
  // 回す」約束・§7 の TTL/最大試行数の会計を実際に機能させる（discovery
  // レーンは discovery-ingest.ts が独立して処理する）。
  const { errors: retryErrors } = await processDueAndExpiredRetries(startedAt);
  errors.push(...retryErrors);

  // 1. 全ブログアダプタを並列取得（1 ソースの失敗が他ソースを止めないよう個別に catch）
  const perSource = await Promise.all(
    SOURCE_IDS.map(async (id) => {
      try {
        return await fetchAndNormalize(id);
      } catch (err) {
        errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
        return [] as PostUpsertInput[];
      }
    }),
  );
  const rawPosts = perSource.flat();

  // 2. 正規化 URL（小文字化・utm_*/fbclid 除去・末尾スラッシュ除去）で重複排除
  const seen = new Set<string>();
  const deduped: PostUpsertInput[] = [];
  for (const post of rawPosts) {
    const canonical = canonicalizeUrl(post.url);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    deduped.push({ ...post, url: canonical });
  }

  // 3. upsert（クロール由来フィールドのみ。既存のキュレーション/埋め込み状態は保持される）
  const upsertResult = await upsertPosts(deduped);
  if (upsertResult.failed.length > 0) {
    errors.push(`upsert failed for ${upsertResult.failed.length} posts`);
  }

  // 4. 未キュレーション、またはプロンプト/モデル変更で再キュレーションが必要な投稿を
  //    予算内で選定する。新着（今回の巡回で取得できた投稿）を優先し、余った予算を
  //    DB 側のバックフィル対象（signature 不一致・未スコア）に回す。
  //
  //    以前は deduped（今回の巡回で取得できた投稿）からしか候補を作っておらず、
  //    CURATION_PROMPT_VERSION を bump しても RSS のウィンドウから落ちた古い投稿は
  //    永久に再判定されなかった（バージョン管理として機能していなかった）。
  //    stale candidates を毎回一定量ずつ混ぜることで、プロンプト変更が数回の
  //    cron 実行で自動的に全件へ波及する。CURATION_DEADLINE_MS で打ち切られて
  //    今回処理できなかった残りは、signature 不一致のまま DB に残るため、
  //    次回 run で再び候補に上がる（自己回復する）。
  const currentSignature = computeCurationSignature();
  const states = await getPostsByUrls(upsertResult.succeeded);

  const freshCandidates: CurationCandidate[] = deduped.flatMap((post): CurationCandidate[] => {
    const state = states.get(post.url);
    const id = state?.id ?? null;
    const needsCuration = ((): boolean => {
      if (!state) return true; // 状態が読めなければ安全側で対象に含める
      if (!state.aiTitle) return true;
      const freshHash = computeContentHash(state.originalTitle, state.originalExcerpt);
      const isUnchanged =
        state.contentHash === freshHash && state.curationSignature === currentSignature;
      return !isUnchanged;
    })();
    if (!needsCuration) return [];
    return [
      {
        id,
        url: post.url,
        originalTitle: post.originalTitle,
        originalExcerpt: post.originalExcerpt,
        publishedAt: post.publishedAt,
      },
    ];
  });

  freshCandidates.sort((a, b) => {
    const aTime = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const bTime = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return bTime - aTime;
  });

  // 新着だけで予算を使い切った場合はバックフィル分の DB 問い合わせ自体を省略する。
  const remainingBudget = Math.max(0, CURATION_BUDGET - freshCandidates.length);
  let staleCandidates: CurationCandidate[] = [];
  if (remainingBudget > 0) {
    const freshIds = new Set(
      freshCandidates.map((c) => c.id).filter((id): id is number => id !== null),
    );
    // fresh candidates と DB 側の stale 判定が重複するケース（今回取り込んだ
    // 投稿がそのまま「未スコア」にも該当する等）を見込み、フィルタ後も
    // remainingBudget を満たせるよう多めに取得しておく。
    const staleRows = await getStaleCurationCandidates({
      currentSignature,
      limit: remainingBudget + freshCandidates.length,
    });
    staleCandidates = staleRows
      .filter((c) => c.id === null || !freshIds.has(c.id))
      .slice(0, remainingBudget);
  }

  const toCurate = [...freshCandidates, ...staleCandidates].slice(0, CURATION_BUDGET);
  // skipped は「今回の巡回で取得できた投稿のうち、今回キュレーションされな
  // かった件数」。stale candidates は deduped 由来ではないためこの数には含めない。
  const includedFreshCount = Math.min(freshCandidates.length, CURATION_BUDGET);
  const skipped = deduped.length - includedFreshCount;

  // plan 07 §7/§5-M4: 一度終端棄却・撤回された post（post_removals にある）は
  // 再キュレーションの対象から除外する（isRemoved の sticky 性を候補選定の
  // 入口で保証する。撤回は自動、復帰は人間。§5-M4 も参照）。
  const candidateIds = toCurate.map((c) => c.id).filter((id): id is number => id !== null);
  const removedIds = await filterRemoved(candidateIds);
  const workingCandidates = toCurate.filter((c) => c.id === null || !removedIds.has(c.id));

  // 5. LLM キュレーション → 決定的ゲート（Q1 相当・M1・Q4）→ 保存
  let curated = 0;
  let geminiCalls = 0;
  const now = new Date().toISOString();

  if (workingCandidates.length > 0) {
    try {
      // Q1 相当（簡易版）: RSS レーンはフィードのメタデータ（タイトル・抜粋）
      // のみを取得し、記事本文の HTML は取得しない。そのため
      // computeEvidenceSignals()（リンク密度・段落数・定型行率）は原理的に
      // 適用できない（生 HTML が無い）。唯一入手可能な決定的シグナルである
      // 「抜粋の有無」のみを LLM 呼び出し前のゲートとして使う（以前は空抜粋
      // でも LLM に投げて自己申告の evidenceSufficient に頼っていたが、その
      // 自己申告フィールドは plan 07 §6-Q1 により CurationResult から削除された）。
      const evidenceOk: CurationCandidate[] = [];
      const evidenceInsufficient: CurationCandidate[] = [];
      for (const c of workingCandidates) {
        const hasExcerpt = !!c.originalExcerpt && c.originalExcerpt.trim() !== "";
        (hasExcerpt ? evidenceOk : evidenceInsufficient).push(c);
      }

      for (const c of evidenceInsufficient) {
        if (c.id !== null) {
          await markDropped(c.id, "extraction_insufficient", now);
        } else {
          console.warn(`[ingest] extraction_insufficient but no postId resolved: ${c.url}`);
        }
      }

      const { results, geminiCalls: calls } = await curatePosts(
        evidenceOk.map((post) => ({ title: post.originalTitle, excerpt: post.originalExcerpt })),
      );
      geminiCalls = calls;

      // Q4: 日次公開サーキットブレーカー（当日 JST 基準）。バッチ内で複数件を
      // 公開判定するため、承認するたびにローカルのカウンタを増やして同一ラン内
      // でも上限を守る。ホスト別シェア上限は廃止（spec §11 項4）。
      const sinceIso = jstDayStartIso(now);
      let totalPublishedToday = await countPublishedSince(sinceIso);

      const updates: CurationUpdate[] = [];
      const publishedByUrl = new Map<string, { postId: number; bodyHash: string }>();

      for (let i = 0; i < evidenceOk.length; i++) {
        const post = evidenceOk[i];
        const result = results[i];

        if (!result) {
          // LLM 呼び出し自体が失敗（timeout / 5xx 相当）。一時的失敗として再試行キューへ。
          // 最大試行数を超えていれば諦めて retry_exhausted で終端棄却する（plan 07 D5）。
          const gaveUp = await enqueueRssRetry(post.url, "llm_transient", now, null);
          if (gaveUp && post.id !== null) {
            await markDropped(post.id, "retry_exhausted", now);
          }
          continue;
        }

        // M1-1: タイトル公開フィルタ（第三者が書いた逐語タイトルの無検閲公開を防ぐ）。
        const titleGate = filterTitle(post.originalTitle);
        if (!titleGate.ok) {
          if (post.id !== null) {
            await markDropped(post.id, "title_filter", now);
          }
          continue;
        }

        // D5 (shared_plan/16): topicAnchor の検証・再生成・degrade は curateSingle/curateBatch 内で行われる。失敗時は null で公開し、棄却しない。

        if (totalPublishedToday >= DAILY_PUBLISH_CAP) {
          // Q4: 上限到達は終端棄却ではなく再試行キューへの繰り延べ。ただし
          // 最大試行数を超えていれば諦めて retry_exhausted で終端棄却する
          // （plan 07 D5）。
          const gaveUp = await enqueueRssRetry(post.url, "rate_capped", now, null);
          if (gaveUp && post.id !== null) {
            await markDropped(post.id, "retry_exhausted", now);
          }
          continue;
        }

        const bodyHash = computeContentHash(post.originalTitle, post.originalExcerpt);
        updates.push({
          url: post.url,
          aiSummary: result.summary,
          category: result.category,
          tag: result.tag,
          contentHash: bodyHash,
          curationSignature: currentSignature,
          status: "published" as PostStatus,
          // postId が解決できなかった投稿（fresh candidates の一部。上記コメント
          // 参照）は post_usefulness / post_rationales への書き込みをスキップし、posts の更新だけ
          // 安全側で行う。
          usefulness:
            post.id !== null
              ? {
                  postId: post.id,
                  modelId: LLM_MODEL,
                  criteria: {
                    firsthand: result.firsthand,
                    ceremonyDecision: result.ceremonyDecision,
                    specific: result.specific,
                    weddingDayContent: result.weddingDayContent,
                    promotional: result.promotional,
                    preDecisionOrPhotoShoot: result.preDecisionOrPhotoShoot,
                  },
                }
              : undefined,
          // Q1 相当ゲートを通過した時点で evidenceSufficient は真であることが
          // 保証されているため、LLM の自己申告ではなく固定で true を渡す。
          rationale:
            post.id !== null
              ? {
                  postId: post.id,
                  topicAnchor: result.topicAnchor,
                  rationaleText: result.rationaleText,
                  evidenceSufficient: true,
                  modelId: LLM_MODEL,
                  promptVersion: RATIONALE_PROMPT_VERSION,
                }
              : undefined,
        });
        if (post.id !== null) {
          publishedByUrl.set(post.url, { postId: post.id, bodyHash });
        }
        totalPublishedToday++;
      }

      if (updates.length > 0) {
        const markResult = await markCurated(updates);
        curated = markResult.succeeded.length;
        if (markResult.failed.length > 0) {
          errors.push(`markCurated failed for ${markResult.failed.length} posts`);
        }
        // §5 公開の記録。bodyHash は本来「判定に使った正規化本文」のハッシュ
        // だが、RSS レーンは記事本文の HTML を一切取得しない（フィードの
        // タイトル・抜粋のみで判定する）ため、判定に使った唯一のテキスト
        // （タイトル+抜粋）のハッシュを代替フィンガープリントとして使う。
        // hashKind="surrogate" として明示する（plan 07 D3 是正）。これにより
        // `revalidatePublishedPosts`（M4）はこの post を本文ドリフト判定
        // （body_changed）の対象から除外する——保存値（タイトル+抜粋由来）と
        // 再取得後の実本文ハッシュは構造的に一致しないため、対象にすると全件
        // 誤って自動撤回される。
        for (const url of markResult.succeeded) {
          const entry = publishedByUrl.get(url);
          if (entry) {
            await recordPublication(entry.postId, now, entry.bodyHash, "surrogate");
          }
        }
      }
    } catch (err) {
      console.error("[ingest] curation failed:", err);
      errors.push(`curation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 6. `/` は force-dynamic（`src/app/page.tsx`）でキャッシュを経由しないため、
  //    以前ここにあったフィードキャッシュの明示的失効（revalidateTag）は不要になった。

  const summary: IngestSummary = {
    fetched: rawPosts.length,
    inserted: upsertResult.succeeded.length,
    curated,
    skipped,
    errors,
    geminiCalls,
  };

  // 7. 完了時点で last_run_summary を全体上書きする（finishedAt を確定させる）。
  await saveRunSummarySafely({
    startedAt,
    finishedAt: new Date().toISOString(),
    fetched: summary.fetched,
    inserted: summary.inserted,
    curated: summary.curated,
    geminiCalls: summary.geminiCalls,
    errorCount: summary.errors.length,
    trigger,
  });

  return summary;
}
