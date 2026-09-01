import { FeedCard } from "@/components/feed/feed-card";
import { EmptyState } from "@/components/feed/empty-state";
import type { FeedCard as FeedCardData } from "@/lib/types";

type FeedLaneClassicProps = {
  cards: FeedCardData[];
};

/**
 * 結婚式の体験ブログ記事を、密度高めの縦リストで落ち着いて読ませる単一レーン。
 * plan 19 でトレンド速報レーンを廃止し単一レーン化した後、
 * plan 21 Stage 3 で「定番」という対比語彙のヘッダをレーン単体の語彙に置き換えた。
 * このレーンを埋める収集は Vercel Cron による自動巡回（1日1回。詳細は
 * spec.md §6.1）と、オーナーが `/admin` から行う手動トリガーの 2 経路のみで、
 * 訪問者が操作できる導線は存在しない。
 */
export function FeedLaneClassic({ cards }: FeedLaneClassicProps) {
  return (
    <section aria-labelledby="lane-classic-heading" className="flex flex-col gap-4">
      <header className="flex flex-col gap-1.5">
        <h2
          id="lane-classic-heading"
          className="font-display text-lane-heading font-semibold text-[var(--color-foreground)] sm:text-lane-heading-lg"
        >
          結婚式の体験ブログ
        </h2>
        <p className="text-meta leading-jp-body tracking-jp-body text-[var(--color-muted-foreground)]">
          実際に結婚式を挙げた方の体験ブログを集めています。記事本文は元のサイトでお読みください。
        </p>
        <p className="text-meta text-[var(--color-muted-foreground)]">
          見出しは元記事のまま。カテゴリ・トピックはAIが自動判定しており、誤りを含む場合があります。
        </p>
      </header>

      {cards.length === 0 ? (
        <EmptyState
          title="定番の体験談はまだありません"
          description="登録している卒花ブログの新着記事は、まだ取り込まれていません。新着は自動で定期的に確認されます。"
        />
      ) : (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
          {cards.map((card, i) => (
            <FeedCard key={card.id} card={card} index={i} />
          ))}
        </div>
      )}
    </section>
  );
}
