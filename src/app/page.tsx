import { getFeedCards } from "@/lib/db/query";
import { FeedLaneTrend } from "@/components/feed/feed-lane-trend";
import { FeedLaneClassic } from "@/components/feed/feed-lane-classic";
import { OperatorPanel } from "@/components/admin/operator-panel";
import { Separator } from "@/components/ui/separator";
import { adminControlsEnabled } from "@/app/actions";

export default async function Home() {
  const [trendCards, classicCards, adminEnabled] = await Promise.all([
    getFeedCards({ sourceType: "sns", limit: 12 }),
    getFeedCards({ sourceType: "blog", limit: 12 }),
    adminControlsEnabled(),
  ]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-10 px-4 py-6 sm:px-6 sm:py-10">
      <h1 className="sr-only">ウエディング・トレンド＆リアルフィード</h1>
      <p className="max-w-2xl text-[13px] leading-jp-body tracking-jp-body text-[var(--color-muted-foreground)]">
        「今」のトレンドと「リアル」な体験談を1分で俯瞰できる、結婚式準備のキュレーションフィードです。すべてのカードは元投稿のAI要約で、原文には各カードのボタンから移動できます。
      </p>

      <FeedLaneTrend cards={trendCards} adminEnabled={adminEnabled} />

      <Separator />

      <FeedLaneClassic cards={classicCards} adminEnabled={adminEnabled} />

      {adminEnabled && (
        <>
          <Separator />
          <OperatorPanel />
        </>
      )}
    </div>
  );
}
