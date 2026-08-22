import { CURATION_BUDGET, SOURCE_ITEM_LIMIT } from "@/lib/constants";
import {
  getPostsByUrls,
  markCurated,
  readLastRunSummary,
  saveLastRunSummary,
  upsertPosts,
  type PostUpsertInput,
} from "@/lib/db/repository";
import { curatePosts } from "@/lib/llm/batch";
import { computeContentHash, computeCurationSignature } from "@/lib/llm/signature";
import { SOURCE_IDS, SOURCE_REGISTRY, type SourceAdapter } from "@/lib/sources/registry";
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
  //    予算内で選定する（新しい publishedAt を優先）。
  const currentSignature = computeCurationSignature();
  const states = await getPostsByUrls(upsertResult.succeeded);

  const candidates = deduped.filter((post) => {
    const state = states.get(post.url);
    if (!state) return true; // 状態が読めなければ安全側で対象に含める
    if (!state.aiTitle) return true;
    const freshHash = computeContentHash(state.originalTitle, state.originalExcerpt);
    const isUnchanged =
      state.contentHash === freshHash && state.curationSignature === currentSignature;
    return !isUnchanged;
  });

  candidates.sort((a, b) => {
    const aTime = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const bTime = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return bTime - aTime;
  });

  const toCurate = candidates.slice(0, CURATION_BUDGET);
  const skipped = deduped.length - toCurate.length;

  // 5. LLM キュレーション → 結果を保存
  let curated = 0;
  let geminiCalls = 0;
  if (toCurate.length > 0) {
    try {
      const { results, geminiCalls: calls } = await curatePosts(
        toCurate.map((post) => ({ title: post.originalTitle, excerpt: post.originalExcerpt })),
      );
      geminiCalls = calls;

      const updates = toCurate
        .map((post, i) => {
          const result = results[i];
          if (!result) return null;
          return {
            url: post.url,
            aiTitle: result.title,
            aiSummary: result.summary,
            category: result.category,
            tag: result.tag,
            contentHash: computeContentHash(post.originalTitle, post.originalExcerpt),
            curationSignature: currentSignature,
          };
        })
        .filter((u): u is NonNullable<typeof u> => u !== null);

      const markResult = await markCurated(updates);
      curated = markResult.succeeded.length;
      if (markResult.failed.length > 0) {
        errors.push(`markCurated failed for ${markResult.failed.length} posts`);
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
