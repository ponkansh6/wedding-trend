import { Landmark } from "lucide-react";
import { FeedCard } from "@/components/feed/feed-card";
import { EmptyState } from "@/components/feed/empty-state";
import type { FeedCard as FeedCardData } from "@/lib/types";

type FeedLaneClassicProps = {
  cards: FeedCardData[];
};

/**
 * 下段: 満足度の高い王道・定番（sourceType: "blog"）。
 * 卒花ブログのレポート記事を、密度高めの縦リストで落ち着いて読ませる。
 * 上段の「速い」リズムと対比する「じっくり」のリズム。
 * このレーンを埋める収集は Vercel Cron による自動巡回（1日1回。詳細は
 * spec.md §6.1）と、オーナーが `/admin` から行う手動トリガーの 2 経路のみで、
 * 訪問者が操作できる導線は存在しない。
 */
export function FeedLaneClassic({ cards }: FeedLaneClassicProps) {
  return (
    <section aria-labelledby="lane-classic-heading" className="flex flex-col gap-4">
      <header className="flex flex-col gap-1.5">
        <span className="inline-flex w-fit items-center gap-1.5 text-[12px] font-semibold tracking-wide text-[var(--color-classic)]">
          <Landmark className="size-3.5" aria-hidden />
          定番アーカイブ
        </span>
        <h2
          id="lane-classic-heading"
          className="font-display text-[22px] font-semibold leading-jp-heading tracking-jp-heading text-[var(--color-foreground)] sm:text-[26px]"
        >
          満足度の高い王道・定番
        </h2>
        <p className="text-[13px] leading-jp-body tracking-jp-body text-[var(--color-muted-foreground)]">
          実際に結婚式を挙げた方の体験ブログを紹介します。読み応えのある元記事をぜひご覧ください。
        </p>
        <p className="text-xs text-muted-foreground">
          カテゴリ・トピックはAIが自動判定しています。誤りを含む場合があります
        </p>
      </header>

      {cards.length === 0 ? (
        <EmptyState
          variant="editorial"
          title="定番の体験談はまだありません"
          description="登録している卒花ブログの新着記事は、まだ取り込まれていません。新着は自動で定期的に確認されます。"
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {cards.map((card, i) => (
            <FeedCard key={card.id} card={card} variant="editorial" index={i} />
          ))}
        </div>
      )}
    </section>
  );
}
