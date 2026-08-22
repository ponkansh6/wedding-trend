import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "./index";
import { posts, postUsefulness } from "./schema";
import {
  USEFULNESS_GATE_BONUS,
  USEFULNESS_WEIGHT_FIRSTHAND,
  USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY,
  USEFULNESS_WEIGHT_SPECIFIC,
  USEFULNESS_WEIGHT_TRADEOFF,
} from "@/lib/constants";
import { UNSCORED_USEFULNESS_SCORE } from "@/lib/scoring/usefulness";
import type { Category, FeedCard, SourceType, TrendTag } from "@/lib/types";

/**
 * `getFeedCards` が両レーンで共通して取得するカラム。`leftJoin` の有無に
 * かかわらず常にこの形（テーブル名でネストしない、フラットな行）で返す
 * ようにするため、`.select()` を使わず明示的にフィールドを列挙する。
 */
const FEED_ROW_FIELDS = {
  id: posts.id,
  sourceType: posts.sourceType,
  sourceId: posts.sourceId,
  sourceName: posts.sourceName,
  url: posts.url,
  author: posts.author,
  publishedAt: posts.publishedAt,
  thumbnailUrl: posts.thumbnailUrl,
  aiTitle: posts.aiTitle,
  aiSummary: posts.aiSummary,
  category: posts.category,
  tag: posts.tag,
  embedProvider: posts.embedProvider,
  embedHtml: posts.embedHtml,
} as const;

/**
 * 体験談レーン専用の並び順キー。`post_usefulness` の 5 つのブール値から
 * `src/lib/scoring/usefulness.ts` の `computeUsefulnessScore()` と**同じ重み**
 * を使ってスコアを SQL 上で組み立てる（重みを SQL 側に数値として直書きせず、
 * `src/lib/constants.ts` の定数から式を組み立てることで、重みを変更したときに
 * ここを個別に修正し忘れる事故を防ぐ）。
 *
 * `post_usefulness` に対応行が無い（＝未スコア。LLM キュレーション未実行、
 * または一時的な失敗）場合は `UNSCORED_USEFULNESS_SCORE`（ゲート不通過帯の
 * 中位）を使う。`leftJoin` なので未スコア行は `post_usefulness.post_id` が
 * NULL になる。
 */
const USEFULNESS_SCORE_SQL = sql<number>`CASE WHEN ${postUsefulness.postId} IS NULL THEN ${UNSCORED_USEFULNESS_SCORE} ELSE
  (CASE WHEN ${postUsefulness.ceremonyDecision} = 1 THEN ${USEFULNESS_GATE_BONUS} ELSE 0 END)
  + ${USEFULNESS_WEIGHT_FIRSTHAND} * ${postUsefulness.firsthand}
  + ${USEFULNESS_WEIGHT_SPECIFIC} * ${postUsefulness.specific}
  + ${USEFULNESS_WEIGHT_TRADEOFF} * ${postUsefulness.tradeoff}
  - ${USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY} * ${postUsefulness.promotional}
END`;

/**
 * 公開済みフィードカードを取得する。
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
 * 掲載順（openspec/specs/wedding-trend/spec.md §9.6）:
 * - 体験談レーン（`sourceType: "blog"`）: 有用度スコア（`USEFULNESS_SCORE_SQL`）
 *   降順 → `publishedAt` 降順。`publishedAt` は元記事側の情報が欠けている場合に
 *   null になりうる。SQLite の ORDER BY ... DESC は NULL を最後に並べるため、
 *   同スコア内では公開日が判明している投稿を優先し、公開日不明の投稿は
 *   その次点に回る（意図した挙動であり、追加のハンドリングはしていない）。
 * - 速報レーン（`sourceType: "sns"`）: 従来通り `createdAt`（取り込み順）の
 *   新着順を維持する。速報性そのものが価値であることに加え、SNS 投稿には
 *   体験談レーンのような本文抜粋が無く同じルーブリックで採点できないため
 *   （スコアリング対象外。§9.6）。
 *
 * UI はこのシグネチャのみに依存する。DB 未接続・空でも例外を投げず [] を返す
 * （fail-soft 契約はキャッシュ撤去後も維持する）。
 */
export async function getFeedCards(params: {
  sourceType: SourceType;
  limit: number;
}): Promise<FeedCard[]> {
  try {
    const whereClause = and(
      eq(posts.sourceType, params.sourceType),
      eq(posts.status, "published"),
      isNotNull(posts.aiTitle),
      isNotNull(posts.aiSummary),
    );

    const rows =
      params.sourceType === "blog"
        ? await db
            .select(FEED_ROW_FIELDS)
            .from(posts)
            .leftJoin(postUsefulness, eq(posts.id, postUsefulness.postId))
            .where(whereClause)
            .orderBy(desc(USEFULNESS_SCORE_SQL), desc(posts.publishedAt))
            .limit(params.limit)
        : await db
            .select(FEED_ROW_FIELDS)
            .from(posts)
            .where(whereClause)
            // createdAt（取り込み順）を新着基準にする。publishedAt は元記事側の
            // 情報が欠けている場合に null になりうるため、並び順の基準には使わない。
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
