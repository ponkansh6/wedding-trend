import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import type { FeedCard as FeedCardData } from "@/lib/types";
import { PublishedTime } from "@/components/feed/relative-time";

type FeedCardProps = {
  card: FeedCardData;
  /** 出現アニメーションの遅延に使う表示順（任意）。 */
  index?: number;
};

export function FeedCard({ card, index = 0 }: FeedCardProps) {
  return (
    <Card
      as="article"
      className="flex h-full flex-col gap-2.5 p-4 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500 motion-safe:fill-mode-both"
      style={{ animationDelay: `${Math.min(index, 8) * 70}ms` }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="category" className="text-badge">
          {card.category}
        </Badge>
      </div>

      <Title originalTitle={card.originalTitle} url={card.url} />

      {card.topicAnchor && (
        <p className="line-clamp-1 text-anchor text-[var(--color-muted-foreground)]">
          {card.topicAnchor}
        </p>
      )}

      {card.topics && card.topics.length > 0 && (
        <ul
          role="list"
          className="flex flex-wrap items-center gap-x-2 gap-y-1"
          aria-label="AIが自動選定したトピック"
          title="AI による自動判定。誤りを含む場合があります"
        >
          {card.topics.map((topic) => (
            <li
              key={topic}
              className="cursor-default text-badge text-[var(--color-muted-foreground)] before:mr-0.5 before:content-['#']"
            >
              {topic}
            </li>
          ))}
        </ul>
      )}

      <Footer card={card} />
    </Card>
  );
}

/**
 * originalTitle は元記事の逐語タイトル（法務不変・plan 21 §6-3）。
 * このコンポーネントは originalTitle をそのまま表示する以外の文字列加工
 * （.replace() 等による言い換え・要約・装飾的な改変）を一切行ってはならない。
 * line-clamp による視覚上の省略は文字列そのものの改変ではないため許容する。
 */
function Title({
  originalTitle,
  url,
}: {
  originalTitle: FeedCardData["originalTitle"];
  url: string;
}) {
  return (
    <h3 className="text-title font-display font-semibold text-pretty text-[var(--color-foreground)]">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="line-clamp-2 rounded-sm underline decoration-transparent underline-offset-2 transition-colors duration-150 hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]"
      >
        {originalTitle}
      </a>
    </h3>
  );
}

function Footer({ card }: { card: FeedCardData }) {
  return (
    <footer
      className={cn(
        "mt-auto flex flex-col gap-2.5 border-t border-[var(--color-border)] pt-3",
        "sm:flex-row sm:items-center sm:justify-between",
      )}
    >
      <p className="min-w-0 truncate text-meta text-[var(--color-muted-foreground)]">
        {card.sourceName}
        {card.author && <> ・ {card.author}</>}
        {" ・ "}
        <PublishedTime iso={card.publishedAt} />
      </p>
      <Button asChild variant="accent" size="sm" className="w-full shrink-0 sm:w-auto">
        <a href={card.url} target="_blank" rel="noopener noreferrer">
          原文を読む
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </Button>
    </footer>
  );
}
