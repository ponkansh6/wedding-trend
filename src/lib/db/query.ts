import { and, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import { db } from "./index";
import { posts, postUsefulnessCriteria, postRationales } from "./schema";
import {
  RATIONALE_DISPLAY_PHASE,
  USEFULNESS_GATE_BONUS,
  USEFULNESS_WEIGHT_CEREMONY_DECISION,
  USEFULNESS_WEIGHT_FIRSTHAND,
  USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY,
  USEFULNESS_WEIGHT_SPECIFIC,
  USEFULNESS_WEIGHT_WEDDING_DAY,
  type RationaleDisplayPhase,
} from "@/lib/constants";
import {
  UNSCORED_USEFULNESS_SCORE,
  normalizeCriterion,
  normalizePromotional,
} from "@/lib/scoring/usefulness";
import type { Category, FeedCard, SourceType, TrendTag } from "@/lib/types";
import type { UsefulnessCriteria } from "@/lib/scoring/usefulness";

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
  originalTitle: posts.originalTitle,
  author: posts.author,
  publishedAt: posts.publishedAt,
  thumbnailUrl: posts.thumbnailUrl,
  aiTitle: posts.aiTitle,
  aiSummary: posts.aiSummary,
  category: posts.category,
  tag: posts.tag,
  embedProvider: posts.embedProvider,
  embedHtml: posts.embedHtml,
  topicAnchor: postRationales.topicAnchor,
  rationaleText: postRationales.rationaleText,
  criteriaJson: postUsefulnessCriteria.criteriaJson,
} as const;

/**
 * 体験談レーン専用の並び順キー。`post_usefulness_criteria` の `criteria_json`
 * カラムから `json_extract` を使って各判定項目を取り出し、
 * `src/lib/scoring/usefulness.ts` の `computeUsefulnessScore()` と**同じ重み**
 * およびゲート条件 `(ceremonyDecision >= 1 && weddingDayContent >= 1)` を使って
 * スコアを SQL 上で組み立てる（重みを SQL 側に数値として直書きせず、
 * `src/lib/constants.ts` の定数から式を組み立てることで、重みを変更したときに
 * ここを個別に修正し忘れる事故を防ぐ）。この式と純関数の一致は
 * `tests/feed-order-parity.test.ts` が全 3^5 = 243 通りの判定組み合わせで検証する。
 *
 * `post_usefulness_criteria` に対応行が無い（＝未スコア。LLM キュレーション未実行、
 * または一時的な失敗）場合は `UNSCORED_USEFULNESS_SCORE`（ゲート不通過帯の
 * 中位）を使う。`leftJoin` なので未スコア行は `post_usefulness_criteria.post_id` が
 * NULL になる。
 *
 * `criteria_json` が不正 JSON（壊れた値が何らかの理由で書き込まれた場合）の
 * 行も、`json_valid(...)` で検出して同じ `UNSCORED_USEFULNESS_SCORE` に
 * フォールバックさせる。`json_extract` は不正 JSON に対して SQL レベルの
 * runtime error を投げ、これを CASE 式の中で無防備に呼ぶと**そのクエリ全体**
 * が失敗する。`getFeedCards()` は fail-soft（`try/catch` + `[]` を返す）なので、
 * 1行の JSON 破損が体験談レーン全体を消してしまう——ページの1セクションが
 * 丸ごと空になるという実害の大きい故障モードだった（実際に発生を確認済み）。
 * `json_valid` の判定を `json_extract` より手前の WHEN 節に置くことで、SQLite
 * の CASE は最初に一致した WHEN のみを評価し以降の節（`json_extract` を含む
 * ELSE 節）を評価しないため、不正 JSON の行では `json_extract` 自体が
 * 呼ばれない。これにより「その行だけ未採点扱いで中位に置かれ、他の行は
 * 正常にスコアされる」という単一行フォールバックになる。破損した行は次回
 * ingest で signature 不一致として再スコア対象に検出され、自然に正しい
 * 位置へ復帰する（`post_usefulness_criteria` に行が無い場合と同じ意味論）。
 *
 * 各 `json_extract(...)` を必ず `COALESCE(..., 0)` で包むこと。
 * `criteria_json` は 5 キーの JSON（2026-08-30 に 6→5、全項目 0-2 の整数へ）
 * だが、旧バックフィル分の行はキーの構成・型が異なる（`promotional` は
 * 文字列 enum、5 項目は boolean、`preDecisionOrPhotoShoot` キーが余分）。
 * `json_extract` は JSON の `true`/`false` を SQL の `1`/`0` に変換するため
 * 旧 boolean 行は自然に 0/1 として読める（新しい 2 との差は bump + 全件
 * 再キュレーションが速やかに解消する）。
 * `json_extract` は存在しないキーに対して SQL の `NULL` を返し、
 * `3 * NULL` は `NULL` になり、`NULL` は算術式全体に伝播する ——
 * つまりキーが1つ欠けているだけで加算式全体が `NULL` になり、
 * `ORDER BY ... DESC` はエラーを出さず黙ってその行を最下位に沈める
 * （in-memory libsql で再現確認済み）。`COALESCE(x, 0)` で
 * 「未知の判定項目は加点も減点もしない」に意味論を統一し、この静かな
 * 全滅を防ぐ。
 *
 * **`json_extract(x, '$.k')` を `x -> '$.k'` に書き換えないこと。**
 * SQLite の `->` 演算子は JSON 型の結果（真偽値なら JSON テキストの
 * `'true'`/`'false'`）を返すため、`= 1` という比較は常に false になり、
 * ゲート条件が黙って常に不通過になる（`->>` なら `json_extract` と等価だが、
 * ここでは実績のある `json_extract` に統一する）。
 */
const USEFULNESS_SCORE_SQL = sql<number>`CASE
  WHEN ${postUsefulnessCriteria.postId} IS NULL THEN ${UNSCORED_USEFULNESS_SCORE}
  WHEN NOT json_valid(${postUsefulnessCriteria.criteriaJson}) THEN ${UNSCORED_USEFULNESS_SCORE}
  ELSE
  (CASE WHEN COALESCE(json_extract(${postUsefulnessCriteria.criteriaJson}, '$.ceremonyDecision'), 0) >= 1 AND COALESCE(json_extract(${postUsefulnessCriteria.criteriaJson}, '$.weddingDayContent'), 0) >= 1 THEN ${USEFULNESS_GATE_BONUS} ELSE 0 END)
  + ${USEFULNESS_WEIGHT_CEREMONY_DECISION} * COALESCE(json_extract(${postUsefulnessCriteria.criteriaJson}, '$.ceremonyDecision'), 0)
  + ${USEFULNESS_WEIGHT_FIRSTHAND} * COALESCE(json_extract(${postUsefulnessCriteria.criteriaJson}, '$.firsthand'), 0)
  + ${USEFULNESS_WEIGHT_SPECIFIC} * COALESCE(json_extract(${postUsefulnessCriteria.criteriaJson}, '$.specific'), 0)
  + ${USEFULNESS_WEIGHT_WEDDING_DAY} * COALESCE(json_extract(${postUsefulnessCriteria.criteriaJson}, '$.weddingDayContent'), 0)
  - ${USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY} * (CASE WHEN json_extract(${postUsefulnessCriteria.criteriaJson}, '$.promotional') = 'heavy' OR (json_extract(${postUsefulnessCriteria.criteriaJson}, '$.promotional') + 0) >= 7 THEN 1 ELSE 0 END)
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
 *   降順 → `publishedAt` 降順 → `posts.id` 降順。`publishedAt` は元記事側の情報が
 *   欠けている場合に null になりうる。SQLite の ORDER BY ... DESC は NULL を
 *   最後に並べるため、同スコア内では公開日が判明している投稿を優先し、公開日
 *   不明の投稿はその次点に回る（意図した挙動であり、追加のハンドリングは
 *   していない）。最後の `posts.id` 降順は、スコアも `publishedAt`（null 同士を
 *   含む）も同値になったときの最終タイブレーク。これが無いと SQLite の
 *   ORDER BY は同値行の順序を保証せず、`limit()` によるページングのたびに
 *   順序が入れ替わって重複・欠落が起こりうる。
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
  phase?: RationaleDisplayPhase;
}): Promise<FeedCard[]> {
  try {
    const phase = params.phase ?? RATIONALE_DISPLAY_PHASE;
    const visibilityCondition =
      phase === "phase2"
        ? isNotNull(postRationales.postId)
        : or(
            and(isNotNull(posts.aiTitle), isNotNull(posts.aiSummary)),
            isNotNull(postRationales.postId),
          );

    const whereClause = and(
      eq(posts.sourceType, params.sourceType),
      eq(posts.status, "published"),
      visibilityCondition,
    );

    const rows =
      params.sourceType === "blog"
        ? await db
            .select(FEED_ROW_FIELDS)
            .from(posts)
            .leftJoin(postRationales, eq(posts.id, postRationales.postId))
            .leftJoin(postUsefulnessCriteria, eq(posts.id, postUsefulnessCriteria.postId))
            .where(whereClause)
            .orderBy(desc(USEFULNESS_SCORE_SQL), desc(posts.publishedAt), desc(posts.id))
            .limit(params.limit)
        : await db
            .select(FEED_ROW_FIELDS)
            .from(posts)
            .leftJoin(postRationales, eq(posts.id, postRationales.postId))
            .leftJoin(postUsefulnessCriteria, eq(posts.id, postUsefulnessCriteria.postId))
            .where(whereClause)
            // createdAt（取り込み順）を新着基準にする。publishedAt は元記事側の
            // 情報が欠けている場合に null になりうるため、並び順の基準には使わない。
            .orderBy(desc(posts.createdAt))
            .limit(params.limit);

    // category / tag / aiTitle / aiSummary は SQL 条件で non-null のはずだが、
    // 型安全のため念のため防御的にフィルタする。
    return rows.flatMap((row): FeedCard[] => {
      if (!row.category || !row.tag) return [];
      // category / tag があっても、表示フェーズの条件を満たさない行は除外
      if (!row.rationaleText && (!row.aiTitle || !row.aiSummary)) return [];

      let parsedUsefulness: UsefulnessCriteria | null = null;
      if (row.criteriaJson) {
        try {
          const parsed = JSON.parse(row.criteriaJson);
          // 新レコードは 0〜9 の整数、旧レコードは boolean / 0-2（`promotional` は文字列）。
          // `normalizeCriterion` / `normalizePromotional` が両方を 0-9 に吸収する。
          const isScorable = (v: unknown) =>
            typeof v === "number" || typeof v === "boolean" || typeof v === "string";
          if (
            parsed &&
            typeof parsed === "object" &&
            isScorable(parsed.firsthand) &&
            isScorable(parsed.ceremonyDecision) &&
            isScorable(parsed.specific) &&
            isScorable(parsed.weddingDayContent) &&
            isScorable(parsed.promotional)
          ) {
            parsedUsefulness = {
              firsthand: normalizeCriterion(parsed.firsthand),
              ceremonyDecision: normalizeCriterion(parsed.ceremonyDecision),
              specific: normalizeCriterion(parsed.specific),
              weddingDayContent: normalizeCriterion(parsed.weddingDayContent),
              promotional: normalizePromotional(parsed.promotional),
            };
          }
        } catch {
          parsedUsefulness = null;
        }
      }

      return [
        {
          id: row.id,
          sourceType: row.sourceType,
          sourceId: row.sourceId,
          sourceName: row.sourceName,
          url: row.url,
          originalTitle: row.originalTitle,
          author: row.author,
          publishedAt: row.publishedAt,
          thumbnailUrl: row.thumbnailUrl,
          aiTitle: row.aiTitle ?? undefined,
          aiSummary: row.aiSummary,
          category: row.category as Category,
          tag: row.tag as TrendTag,
          embedProvider: row.embedProvider,
          embedHtml: row.embedHtml,
          topicAnchor: row.topicAnchor ?? null,
          rationaleText: row.rationaleText ?? null,
          usefulness: parsedUsefulness,
        },
      ];
    });
  } catch (err) {
    console.warn("[db] getFeedCards query error:", err);
    return [];
  }
}
