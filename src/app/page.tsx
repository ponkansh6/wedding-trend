import { z } from "zod";
import { getFeedCards } from "@/lib/db/query";
import { FeedReadStatusTabs } from "@/components/feed/feed-read-status-tabs";
import { FEED_PAGE_SIZE, FEED_PAGE_SIZE_MAX } from "@/lib/constants";

/**
 * 動的レンダリングを強制する。以前は ISR（revalidate 5分、`unstable_cache` +
 * `revalidateTag`）だったが、デプロイをまたいで残った stale なキャッシュ
 * エントリが stale-while-revalidate で配信され続け、「体験談 0 件なのに更新
 * 制限」という誤解を招く報告につながった（実測では収集自体は成功していた）。
 *
 * このページのトラフィックはほぼゼロで、`getFeedCards()` のクエリも
 * 高々 FEED_PAGE_SIZE_MAX + 1 件の単純な SELECT に過ぎない。ISR の利得（DB 負荷の軽減）より、
 * 「オーナーが `/admin` から収集した直後に結果をここで確認できない」ことの
 * 損失の方が大きいと判断し、キャッシュ層ごと撤去した
 * （クルーシアルな変更：トレンドレーンを廃止し単一レーン化）。
 */
export const dynamic = "force-dynamic";

/**
 * `?count=` の検証・クランプ用スキーマ。「もっと見る」は状態を持たない
 * ただのリンク（`?count=48` のように次の件数を指す）なので、未検証の値が
 * そのまま `getFeedCards()` の `limit` に渡ってしまうと `?count=999999` で
 * 過大なクエリを踏ませられる。整数化し `FEED_PAGE_SIZE_MAX` でクランプ、
 * 不正な値（非数値・0以下・小数など）は既定値 `FEED_PAGE_SIZE` にフォールバックする。
 */
const countParamSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(FEED_PAGE_SIZE_MAX)
  .catch(FEED_PAGE_SIZE);

type PageProps = {
  searchParams: Promise<{ count?: string }>;
};

export default async function Home({ searchParams }: PageProps) {
  const { count: rawCount } = await searchParams;
  const count = countParamSchema.parse(rawCount);

  // 「続きがあるか」を判定するために、表示件数より1件多く取得する。
  // 総件数を別クエリで数えるより1本のクエリで済み、フィルタ後件数の
  // 食い違いも起きない。
  const cards = await getFeedCards({ sourceType: "blog", limit: count + 1 });
  const hasMore = cards.length > count;
  const visibleCards = cards.slice(0, count);
  const nextCount = Math.min(count + FEED_PAGE_SIZE, FEED_PAGE_SIZE_MAX);
  // nextCount が count と同じ = FEED_PAGE_SIZE_MAX に張り付いた状態。
  // このとき「もっと見る」は現在と同じ URL を指すため、押しても1件も増えない
  // 死んだボタンになる。押して何も起きない状態を作らないため描画しない。
  // 裏を返すと FEED_PAGE_SIZE_MAX を超える投稿は現状この画面から到達できない。
  // 到達させるにはオフセット方式のページネーションが必要（現在は未実装）。
  const canLoadMore = hasMore && nextCount > count;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-10 px-4 py-6 sm:px-6 sm:py-10">
      <h1 className="sr-only">ウエディング・トレンド＆リアルフィード</h1>

      <FeedReadStatusTabs cards={visibleCards} nextCount={canLoadMore ? nextCount : null} />
    </div>
  );
}
