import { getFeedCards } from "@/lib/db/query";
import { FeedLaneTrend } from "@/components/feed/feed-lane-trend";
import { FeedLaneClassic } from "@/components/feed/feed-lane-classic";
import { CollectPanel } from "@/components/feed/collect-panel";
import { OperatorPanel } from "@/components/admin/operator-panel";
import { Separator } from "@/components/ui/separator";
import { adminControlsEnabled, getIngestCooldown } from "@/app/actions";

// 収集トリガーの Server Action はこのページのルート関数上で実行される。
// 巡回・要約に最大60秒ほどかかるため、Vercel の既定タイムアウトでは
// 本番で打ち切られてしまう。
export const maxDuration = 60;

export default async function Home() {
  const [trendCards, classicCards, adminEnabled, { cooldownUntil }] = await Promise.all([
    getFeedCards({ sourceType: "sns", limit: 12 }),
    getFeedCards({ sourceType: "blog", limit: 12 }),
    adminControlsEnabled(),
    getIngestCooldown(),
  ]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-10 px-4 py-6 sm:px-6 sm:py-10">
      <h1 className="sr-only">ウエディング・トレンド＆リアルフィード</h1>
      <p className="max-w-2xl text-[13px] leading-jp-body tracking-jp-body text-[var(--color-muted-foreground)]">
        「今」のトレンドと「リアル」な体験談を1分で俯瞰できる、結婚式準備のキュレーションフィードです。すべてのカードは元投稿のAI要約で、原文には各カードのボタンから移動できます。
      </p>

      <CollectPanel cooldownUntil={cooldownUntil} />

      <FeedLaneTrend cards={trendCards} adminEnabled={adminEnabled} cooldownUntil={cooldownUntil} />

      <Separator />

      <FeedLaneClassic cards={classicCards} cooldownUntil={cooldownUntil} />

      {adminEnabled && (
        <>
          <Separator />
          <OperatorPanel />
        </>
      )}
    </div>
  );
}
