import {
  CURATION_BUDGET,
  DAILY_PUBLISH_CAP,
  RATIONALE_PROMPT_VERSION,
  RETRY_BACKOFF_HOURS,
  RETRY_MAX_ATTEMPTS,
  RETRY_TTL_HOURS,
} from "@/lib/constants";
import {
  completeRetry,
  dueRetries,
  enqueueRetry,
  expireRetries,
  getPostsByUrls,
  hashUrl,
  markCurated,
  markDropped,
  readLastRunSummary,
  recordPublication,
  saveLastRunSummary,
} from "@/lib/db/repository";
import { curatePosts } from "@/lib/llm/batch";
import { LLM_MODEL } from "@/lib/llm/client";
import { computeContentHash, computeCurationSignature } from "@/lib/llm/signature";
import { filterTitle } from "@/lib/publish/gate";
import { curateEvergreenUrl, terminateEvergreenRetry } from "@/lib/pipeline/evergreen";
import { isDailyPublishCapReached } from "@/lib/pipeline/rate-cap";
import { RssAdapter } from "@/lib/pipeline/adapters/rss-adapter";
import { runPipeline } from "@/lib/pipeline/run-pipeline";
import { runSubmitUrl, terminateSubmitRetry } from "@/lib/pipeline/submit-url";
import type { PostStatus, RetryContext, RetryLane, RetryReason } from "@/lib/types";

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
 * RSS 巡回 → 重複排除 → upsert → LLM キュレーション → フィードキャッシュ失効までの
 * 一連のパイプラインを実行する。`/api/ingest` の Route Handler（curl / Vercel Cron）と
 * `triggerIngest` Server Action（UI の取得ボタン）の両方から呼ばれる唯一の実装。
 *
 * `trigger` はテレメトリ（`last_run_summary`）に残すためだけの値で、
 * パイプラインの挙動そのものは変えない。呼び出し元を指定しない場合は
 * `"manual"`（UI ボタン経路）を既定値とする。
 */
export async function runIngest(trigger: IngestTrigger = "manual"): Promise<IngestSummary> {
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") {
    console.log(`Ingest skipped in VERCEL_ENV=${process.env.VERCEL_ENV}`);
    return {
      fetched: 0,
      inserted: 0,
      curated: 0,
      skipped: 0,
      errors: [],
      geminiCalls: 0,
    };
  }

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

  // 1-6. RSS 巡回 → 重複排除 → upsert → LLM キュレーション → 決定的ゲート
  // （Q1 相当・M1・Q4）→ 保存。plan17 shared_plan/17 S2: 段階 3-7 を
  // 共通コア `runPipeline(new RssAdapter(), options)` に置き換える
  // （段階 0/1/2/10 はここでは変更しない）。
  const currentSignature = computeCurationSignature();
  const now = new Date().toISOString();
  const rssAdapter = new RssAdapter();
  const pipelineSummary = await runPipeline(rssAdapter, {
    curationBudget: CURATION_BUDGET,
    dailyPublishCap: DAILY_PUBLISH_CAP,
    jstDayStartIso: jstDayStartIso(now),
    curationSignature: currentSignature,
    retryMaxAttempts: RETRY_MAX_ATTEMPTS,
    retryBackoffHours: [...RETRY_BACKOFF_HOURS],
    retryTtlHours: RETRY_TTL_HOURS,
    lane: "rss",
    // Q1 相当（撤回済み post の再キュレーション除外）はコア側の共通ゲート
    // （旧 filterRemoved 呼び出しと同一挙動）に委ねる。
    enforceRemovedFilter: true,
    // Q4: 日次公開サーキットブレーカーを有効化する（旧 isDailyPublishCapReached 相当）。
    enforceRateCap: true,
  });
  errors.push(...rssAdapter.lastFetchErrors, ...pipelineSummary.errors);

  // IngestSummary の各フィールドは PipelineSummary と意味が一致しないものが
  // あるため、単純な名前対応ではなく個別に写像する（詳細は runIngest の
  // JSDoc および委譲時の報告を参照）。
  //
  // - fetched: 旧実装は「今回の巡回で全ソースから取得できた生アイテム数
  //   （重複排除・キュレーション要否フィルタ適用前）」＝ rawPosts.length。
  //   PipelineSummary.fetched は adapter.fetchCandidates() が返した後の
  //   候補数（重複排除・要キュレーションフィルタ適用済み）であり意味が違う
  //   ため使わない。RssAdapter に生アイテム数を副産物として持たせ
  //   （lastRawFetchedCount）、そちらを使う。
  const fetched = rssAdapter.lastRawFetchedCount;
  // - inserted: 旧実装は「重複排除後の全件」を upsert していたが、コアは
  //   adapter.fetchCandidates() が返した候補（= 要キュレーションのみ）だけを
  //   upsert する。fetchCandidates が既にキュレーション要否でフィルタして
  //   いるため、この差は解消できない（既知の残差。委譲報告を参照）。
  //   PipelineSummary.inserted をそのまま使う。
  const inserted = pipelineSummary.inserted;
  // - curated: 旧新とも markCurated の成功件数で同じ計算。そのまま使う。
  const curated = pipelineSummary.curated;
  // - skipped: 旧実装は「deduped.length - includedFreshCount」
  //   （今回取得した投稿のうち今回キュレーションされなかった件数、stale
  //   backfill は含めない）。PipelineSummary.skipped は
  //   「deduped(=fetchCandidates 後の候補) - toCurate」であり、fetchCandidates
  //   が既にキュレーション要否でフィルタ済みのため常に 0 に近づく（inserted
  //   と同じ既知の残差）。他に同値の値を再構成する材料がコアの戻り値には
  //   無いため、PipelineSummary.skipped をそのまま使う。
  const skipped = pipelineSummary.skipped;
  // - geminiCalls: 旧新とも curatePosts() が返す calls をそのまま伝播する
  //   同一の計算。cooldown 判定に直結するため特に確認済み。そのまま使う。
  const geminiCalls = pipelineSummary.geminiCalls;

  const summary: IngestSummary = {
    fetched,
    inserted,
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
