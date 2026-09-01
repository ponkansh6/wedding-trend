import { getFeedCards } from "@/lib/db/query";
import { FeedLaneClassic } from "@/components/feed/feed-lane-classic";

/**
 * 動的レンダリングを強制する。以前は ISR（revalidate 5分、`unstable_cache` +
 * `revalidateTag`）だったが、デプロイをまたいで残った stale なキャッシュ
 * エントリが stale-while-revalidate で配信され続け、「体験談 0 件なのに更新
 * 制限」という誤解を招く報告につながった（実測では収集自体は成功していた）。
 *
 * このページのトラフィックはほぼゼロで、`getFeedCards()` のクエリも最大12件の
 * 単純な SELECT に過ぎない。ISR の利得（DB 負荷の軽減）より、
 * 「オーナーが `/admin` から収集した直後に結果をここで確認できない」ことの
 * 損失の方が大きいと判断し、キャッシュ層ごと撤去した
 * （クルーシアルな変更：トレンドレーンを廃止し単一レーン化）。
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  const classicCards = await getFeedCards({ sourceType: "blog", limit: 12 });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-10 px-4 py-6 sm:px-6 sm:py-10">
      <h1 className="sr-only">ウエディング・トレンド＆リアルフィード</h1>

      <FeedLaneClassic cards={classicCards} />
    </div>
  );
}
