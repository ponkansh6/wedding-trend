import { and, desc, eq, isNotNull } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { db } from "./index";
import { posts } from "./schema";
import { FEED_CACHE_TAG } from "@/lib/constants";
import type { Category, FeedCard, SourceType, TrendTag } from "@/lib/types";

async function fetchFeedCards(sourceType: SourceType, limit: number): Promise<FeedCard[]> {
  try {
    const rows = await db
      .select()
      .from(posts)
      .where(
        and(
          eq(posts.sourceType, sourceType),
          eq(posts.status, "published"),
          isNotNull(posts.aiTitle),
          isNotNull(posts.aiSummary),
        ),
      )
      // createdAt（取り込み順）を新着基準にする。publishedAt は元記事側の情報が
      // 欠けている場合に null になりうるため、並び順の基準には使わない。
      .orderBy(desc(posts.createdAt))
      .limit(limit);

    // category / tag / aiTitle / aiSummary は SQL 条件で non-null のはずだが、
    // 型安全のため念のため防御的にフィルタする。
    return rows.flatMap((row): FeedCard[] => {
      if (!row.aiTitle || !row.aiSummary || !row.category || !row.tag) return [];
      return [
        {
          id: row.id,
          sourceType: row.sourceType,
          sourceId: row.sourceId,
          sourceName: row.sourceName,
          url: row.url,
          author: row.author,
          publishedAt: row.publishedAt,
          thumbnailUrl: row.thumbnailUrl,
          aiTitle: row.aiTitle,
          aiSummary: row.aiSummary,
          category: row.category as Category,
          tag: row.tag as TrendTag,
          embedProvider: row.embedProvider,
          embedHtml: row.embedHtml,
        },
      ];
    });
  } catch (err) {
    console.warn("[db] getFeedCards query error:", err);
    return [];
  }
}

/**
 * next/cache の unstable_cache でラップ。ingest / submit-url 側は
 * revalidateTag(FEED_CACHE_TAG, ...) を呼んで反映させる。
 * NOTE: Next.js 16 では use cache directive が推奨だが、cacheComponents の
 * opt-in が必要なため、この API ルート主体の構成では unstable_cache を採用する。
 */
const getFeedCardsCached = unstable_cache(fetchFeedCards, ["feed-cards"], {
  tags: [FEED_CACHE_TAG],
  revalidate: 300,
});

/**
 * 公開済みフィードカードを新しい順に取得する。
 * NOTE: UI はこのシグネチャのみに依存する。DB 未接続・空でも例外を投げず [] を返す。
 */
export async function getFeedCards(params: {
  sourceType: SourceType;
  limit: number;
}): Promise<FeedCard[]> {
  try {
    return await getFeedCardsCached(params.sourceType, params.limit);
  } catch (err) {
    console.warn("[db] getFeedCards cache error:", err);
    return [];
  }
}
