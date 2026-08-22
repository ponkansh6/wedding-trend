import { getFeedCards } from "@/lib/db/query";
import { FeedLaneTrend } from "@/components/feed/feed-lane-trend";
import { FeedLaneClassic } from "@/components/feed/feed-lane-classic";
import { Separator } from "@/components/ui/separator";

/**
 * 動的レンダリングを強制する。以前は ISR（revalidate 5分、`unstable_cache` +
 * `revalidateTag`）だったが、デプロイをまたいで残った stale なキャッシュ
 * エントリが stale-while-revalidate で配信され続け、「体験談 0 件なのに更新
 * 制限」という誤解を招く報告につながった（実測では収集自体は成功していた）。
 *
 * このページのトラフィックはほぼゼロで、`getFeedCards()` のクエリも最大12件×
 * 2レーンの単純な SELECT に過ぎない。ISR の利得（DB 負荷の軽減）より、
 * 「オーナーが `/admin` から収集した直後に結果をここで確認できない」ことの
 * 損失の方が大きいと判断し、キャッシュ層ごと撤去した
 * （`src/lib/db/query.ts` の `getFeedCards` も参照）。収集トリガーの Server
 * Action は `/admin`（Basic 認証配下）に移ったため、このページ自体の
 * `maxDuration` 引き上げは不要になった。
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  const [trendCards, classicCards] = await Promise.all([
    getFeedCards({ sourceType: "sns", limit: 12 }),
    getFeedCards({ sourceType: "blog", limit: 12 }),
  ]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-10 px-4 py-6 sm:px-6 sm:py-10">
      <h1 className="sr-only">ウエディング・トレンド＆リアルフィード</h1>
      <p className="max-w-2xl text-[13px] leading-jp-body tracking-jp-body text-[var(--color-muted-foreground)]">
        「今」のトレンドと「リアル」な体験談を1分で俯瞰できる、結婚式準備のキュレーションフィードです。すべてのカードは元投稿のAI要約で、原文には各カードのボタンから移動できます。
      </p>

      <FeedLaneTrend cards={trendCards} />

      <Separator />

      <FeedLaneClassic cards={classicCards} />
    </div>
  );
}
