import { Flame } from "lucide-react";
import { FeedCard } from "@/components/feed/feed-card";
import { EmptyState } from "@/components/feed/empty-state";
import { SubmitUrlForm } from "@/components/admin/submit-url-form";
import { IngestTrigger } from "@/components/feed/ingest-trigger";
import type { FeedCard as FeedCardData } from "@/lib/types";

type FeedLaneTrendProps = {
  cards: FeedCardData[];
  /** 運用者向け操作（SNS URL 投入フォーム）を表示するか（本番では既定で false）。 */
  adminEnabled?: boolean;
  /** サーバー時点でのクールダウン終了時刻（ISO8601）。null なら実行可能。 */
  cooldownUntil: string | null;
};

/**
 * 上段: 最新トレンド速報（sourceType: "sns"）。
 * モバイルでは横スクロールの「速報レール」、デスクトップではグリッドに
 * 切り替え、視覚優先・高速なリズムを演出する。
 */
export function FeedLaneTrend({ cards, adminEnabled = false, cooldownUntil }: FeedLaneTrendProps) {
  return (
    <section aria-labelledby="lane-trend-heading" className="flex flex-col gap-4">
      <header className="flex flex-col gap-1.5">
        <span className="inline-flex w-fit items-center gap-1.5 text-[12px] font-semibold tracking-wide text-[var(--color-trend)]">
          <Flame className="size-3.5" aria-hidden />
          LATEST
        </span>
        <h2
          id="lane-trend-heading"
          className="font-display text-[22px] font-semibold leading-jp-heading tracking-jp-heading text-[var(--color-foreground)] sm:text-[26px]"
        >
          最新トレンド速報
        </h2>
        <p className="text-[13px] leading-jp-body tracking-jp-body text-[var(--color-muted-foreground)]">
          SNS で見つかった「今」の投稿を、AI要約と元投稿へのリンクでまとめました。
        </p>
      </header>

      {cards.length === 0 ? (
        <EmptyState
          variant="visual"
          title="速報はまだありません"
          description={
            adminEnabled
              ? "このレーンはSNS投稿URLの追加でのみ埋まります。下のフォームにURLを貼り付けてください。"
              : "SNSの投稿は、個別に登録されたものだけが並びます。下のボタンで確認できるのは、ブログの新着記事です。"
          }
          action={
            adminEnabled ? (
              <SubmitUrlForm compact />
            ) : (
              <IngestTrigger compact cooldownUntil={cooldownUntil} />
            )
          }
        />
      ) : (
        <div
          role="region"
          aria-label="最新トレンド速報の投稿一覧"
          tabIndex={0}
          className="flex gap-4 overflow-x-auto rounded-2xl pb-2 snap-x snap-mandatory scroll-smooth motion-reduce:scroll-auto [-ms-overflow-style:none] [scrollbar-width:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background)] [&::-webkit-scrollbar]:hidden sm:grid sm:grid-cols-2 sm:overflow-visible sm:rounded-none sm:focus-visible:ring-0 sm:focus-visible:ring-offset-0 lg:grid-cols-3"
        >
          {cards.map((card, i) => (
            <div
              key={card.id}
              className="w-[80%] max-w-[320px] shrink-0 snap-start sm:w-auto sm:max-w-none"
            >
              <FeedCard card={card} variant="visual" index={i} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
