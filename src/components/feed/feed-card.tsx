import { ExternalLink, Flame, Landmark, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import type { FeedCard as FeedCardData } from "@/lib/types";
import { PublishedTime } from "@/components/feed/relative-time";

type FeedCardVariant = "visual" | "editorial";

type FeedCardProps = {
  card: FeedCardData;
  /**
   * "visual"   = 上段（速報）: テキスト主体の縦積みカード
   * "editorial" = 下段（王道・定番）: 密なテキスト行
   */
  variant: FeedCardVariant;
  /** 出現アニメーションの遅延に使う表示順（任意）。 */
  index?: number;
};

export function FeedCard({ card, variant, index = 0 }: FeedCardProps) {
  const isVisual = variant === "visual";

  return (
    <Card
      as="article"
      className={cn(
        "flex h-full flex-col gap-3 p-4 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500 motion-safe:fill-mode-both",
        isVisual ? "gap-3.5 p-3.5" : "gap-2.5 p-4",
      )}
      style={{ animationDelay: `${Math.min(index, 8) * 70}ms` }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="category">{card.category}</Badge>
        {card.tag === "trend" ? (
          <Badge variant="trend">
            <Flame className="size-3" aria-hidden />
            トレンド
          </Badge>
        ) : (
          <Badge variant="classic">
            <Landmark className="size-3" aria-hidden />
            定番
          </Badge>
        )}
      </div>

      <Title card={card} variant={variant} />

      {card.topicAnchor && (
        <div className="flex flex-col gap-2">
          <p className="line-clamp-1 text-[14px] leading-snug text-[var(--color-muted-foreground)]">
            {card.topicAnchor}
          </p>
          <Badge
            variant="ai"
            className="w-fit"
            title="このアンカー・特徴ラベルはAIが自動判定しており、誤りを含むことがあります"
          >
            <Sparkles className="size-2.5" aria-hidden />
            AI判定
          </Badge>
        </div>
      )}

      {card.usefulness && (
        <div className="flex flex-wrap gap-1.5">
          {card.usefulness.firsthand && <Badge variant="category">当事者本人</Badge>}
          {card.usefulness.ceremonyDecision && <Badge variant="category">意思決定に効く</Badge>}
          {card.usefulness.specific && <Badge variant="category">具体的</Badge>}
          {card.usefulness.weddingDayContent && <Badge variant="category">結婚式当日の内容</Badge>}
        </div>
      )}

      <Footer card={card} variant={variant} />
    </Card>
  );
}

function Title({ card, variant }: { card: FeedCardData; variant: FeedCardVariant }) {
  return (
    <h3
      className={cn(
        "font-display leading-jp-heading tracking-jp-heading text-balance text-[var(--color-foreground)]",
        variant === "visual" ? "text-[17px] font-semibold" : "text-[15px] font-semibold",
        "line-clamp-3",
      )}
    >
      {card.originalTitle}
    </h3>
  );
}

function Footer({ card, variant }: { card: FeedCardData; variant: FeedCardVariant }) {
  const isVisual = variant === "visual";
  return (
    <footer
      className={cn(
        "mt-auto flex flex-col gap-2.5 border-t border-[var(--color-border)] pt-3",
        !isVisual && "sm:flex-row sm:items-center sm:justify-between",
      )}
    >
      <p className="min-w-0 truncate text-[12px] text-[var(--color-muted-foreground)]">
        {card.sourceName}
        {card.author && <> ・ {card.author}</>}
        {" ・ "}
        <PublishedTime iso={card.publishedAt} />
      </p>
      <Button
        asChild
        variant={isVisual ? "trend" : "classic"}
        size="sm"
        className="w-full shrink-0 sm:w-auto"
      >
        <a href={card.url} target="_blank" rel="noopener noreferrer">
          {isVisual ? "投稿を見る" : "原文を読む"}
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </Button>
    </footer>
  );
}
