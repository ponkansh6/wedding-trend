import { revalidateTag } from "next/cache";
import { CURATION_BUDGET, FEED_CACHE_TAG, SOURCE_ITEM_LIMIT } from "@/lib/constants";
import {
  getPostsByUrls,
  markCurated,
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
 */
export type IngestSummary = {
  fetched: number;
  inserted: number;
  curated: number;
  skipped: number;
  errors: string[];
};

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
 */
export async function runIngest(): Promise<IngestSummary> {
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
  if (toCurate.length > 0) {
    try {
      const results = await curatePosts(
        toCurate.map((post) => ({ title: post.originalTitle, excerpt: post.originalExcerpt })),
      );

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

  // 6. フィードキャッシュを即時失効させる（外部トリガー・UI ボタンいずれの呼び出しでも
  //    即時反映が必要なため、Next.js 16 の revalidateTag では { expire: 0 } を明示する）。
  revalidateTag(FEED_CACHE_TAG, { expire: 0 });

  return {
    fetched: rawPosts.length,
    inserted: upsertResult.succeeded.length,
    curated,
    skipped,
    errors,
  };
}
