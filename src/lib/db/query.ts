import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "./index";
import { posts } from "./schema";
import type { Category, FeedCard, SourceType, TrendTag } from "@/lib/types";

/**
 * 公開済みフィードカードを新しい順に取得する。
 *
 * NOTE: 以前は `unstable_cache`（5分・`revalidateTag` 手動失効）でラップして
 * いたが撤去した。理由: `/` は `export const dynamic = "force-dynamic"`
 * （`src/app/page.tsx`）になり、そもそもこの関数の呼び出し自体が
 * リクエストごとに発生する。トラフィックはほぼゼロで、クエリも最大12件×2レーンの
 * 単純な SELECT に過ぎないため、キャッシュ層を維持するコスト（デプロイをまたいで
 * stale なエントリが stale-while-revalidate で配信され続け、収集直後にオーナーが
 * 結果を確認できない）の方が ISR の利得より大きいと判断した。詳細は
 * `src/app/page.tsx` のコメントを参照。
 *
 * UI はこのシグネチャのみに依存する。DB 未接続・空でも例外を投げず [] を返す
 * （fail-soft 契約はキャッシュ撤去後も維持する）。
 */
export async function getFeedCards(params: {
  sourceType: SourceType;
  limit: number;
}): Promise<FeedCard[]> {
  try {
    const rows = await db
      .select()
      .from(posts)
      .where(
        and(
          eq(posts.sourceType, params.sourceType),
          eq(posts.status, "published"),
          isNotNull(posts.aiTitle),
          isNotNull(posts.aiSummary),
        ),
      )
      // createdAt（取り込み順）を新着基準にする。publishedAt は元記事側の情報が
      // 欠けている場合に null になりうるため、並び順の基準には使わない。
      .orderBy(desc(posts.createdAt))
      .limit(params.limit);

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
