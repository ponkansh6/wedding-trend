import { Landmark } from "lucide-react";
import { FeedCard } from "@/components/feed/feed-card";
import { EmptyState } from "@/components/feed/empty-state";
import { IngestTrigger } from "@/components/feed/ingest-trigger";
import type { FeedCard as FeedCardData } from "@/lib/types";

type FeedLaneClassicProps = {
  cards: FeedCardData[];
  /** サーバー時点でのクールダウン終了時刻（ISO8601）。null なら実行可能。 */
  cooldownUntil: string | null;
};

/**
 * 下段: 満足度の高い王道・定番（sourceType: "blog"）。
 * 卒花ブログのレポート記事を、密度高めの縦リストで落ち着いて読ませる。
 * 上段の「速い」リズムと対比する「じっくり」のリズム。
 * このレーンを埋める収集操作は adminEnabled に関わらず常に表示する
 * （訪問者にとって唯一の前進手段のため）。
 */
export function FeedLaneClassic({ cards, cooldownUntil }: FeedLaneClassicProps) {
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
          実際に結婚式を挙げた方の体験ブログを、AI要約と元記事へのリンクでまとめました。
        </p>
      </header>

      {cards.length === 0 ? (
        <EmptyState
          variant="editorial"
          title="定番の体験談はまだありません"
          description="登録している卒花ブログの新着記事は、まだ取り込まれていません。下のボタンから確認できます。"
          action={<IngestTrigger compact cooldownUntil={cooldownUntil} />}
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
