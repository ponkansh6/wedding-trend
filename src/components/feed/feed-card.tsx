import { ExternalLink, Flame, ImageOff, Landmark, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import type { FeedCard as FeedCardData } from "@/lib/types";
import { PublishedTime } from "@/components/feed/relative-time";
import { SnsEmbed } from "@/components/feed/sns-embed";

type FeedCardVariant = "visual" | "editorial";

type FeedCardProps = {
  card: FeedCardData;
  /**
   * "visual"   = 上段（速報）: 大きなメディア主体の縦積みカード
   * "editorial" = 下段（王道・定番）: 小さなサムネイル＋密なテキスト行
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

      {isVisual ? (
        <Media card={card} variant={variant} />
      ) : (
        <div className="flex gap-3">
          <Thumbnail card={card} variant={variant} />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Title card={card} variant={variant} />
            <Summary card={card} variant={variant} />
          </div>
        </div>
      )}

      {isVisual && (
        <>
          <Title card={card} variant={variant} />
          <Summary card={card} variant={variant} />
        </>
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
        "line-clamp-2",
      )}
    >
      {card.originalTitle}
    </h3>
  );
}

function Summary({ card, variant }: { card: FeedCardData; variant: FeedCardVariant }) {
  const hasRationale = card.topicAnchor !== null || card.usefulness !== null;

  if (hasRationale) {
    return (
      <div className="flex flex-col gap-2">
        <Badge
          variant="ai"
          className="w-fit font-medium"
          title="この判定はAIが自動で行っており、誤りを含むことがあります"
        >
          <Sparkles className="size-3" aria-hidden />
          自動判定
        </Badge>
        {card.topicAnchor && (
          <p className="text-[13px] font-medium text-[var(--color-foreground)]/80">
            {card.topicAnchor}
          </p>
        )}
        {card.rationaleText && (
          <p className="text-[13.5px] leading-relaxed text-[var(--color-foreground)]/85">
            {card.rationaleText}
          </p>
        )}
        {card.usefulness && (
          <div className="flex flex-wrap gap-1.5">
            {card.usefulness.firsthand && (
              <Badge variant="category" className="bg-[var(--color-background)]/50">
                当事者本人
              </Badge>
            )}
            {card.usefulness.ceremonyDecision && (
              <Badge variant="category" className="bg-[var(--color-background)]/50">
                意思決定に効く
              </Badge>
            )}
            {card.usefulness.specific && (
              <Badge variant="category" className="bg-[var(--color-background)]/50">
                具体的
              </Badge>
            )}
            {card.usefulness.tradeoff && (
              <Badge variant="category" className="bg-[var(--color-background)]/50">
                トレードオフ
              </Badge>
            )}
            {card.usefulness.promotional === "heavy" && (
              <Badge
                variant="category"
                className="border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 text-[var(--color-warning)]"
              >
                PR要素あり
              </Badge>
            )}
            {card.usefulness.preDecisionOrPhotoShoot && (
              <Badge variant="category" className="bg-[var(--color-muted)]/10">
                式前・撮影段階
              </Badge>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Badge
        variant="ai"
        className="w-fit font-medium"
        title="この要約はAIが自動で生成しており、誤りを含むことがあります"
      >
        <Sparkles className="size-3" aria-hidden />
        AI要約
      </Badge>
      <p
        className={cn(
          "leading-jp-body tracking-jp-body text-[var(--color-foreground)]/85",
          variant === "visual" ? "text-[13.5px] line-clamp-4" : "text-[13.5px] line-clamp-3",
        )}
      >
        {card.aiSummary}
      </p>
    </div>
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

function Media({ card, variant }: { card: FeedCardData; variant: FeedCardVariant }) {
  if (card.embedProvider !== "none" && card.embedHtml) {
    return (
      <SnsEmbed
        embedProvider={card.embedProvider}
        embedHtml={card.embedHtml}
        fallback={<Thumbnail card={card} variant={variant} />}
      />
    );
  }
  return <Thumbnail card={card} variant={variant} />;
}

function Thumbnail({ card, variant }: { card: FeedCardData; variant: FeedCardVariant }) {
  if (variant === "editorial") {
    if (!card.thumbnailUrl) {
      return (
        <FallbackTile
          card={card}
          iconSize="size-6"
          className="size-24 shrink-0 rounded-lg sm:size-28"
        />
      );
    }
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={card.thumbnailUrl}
        alt=""
        loading="lazy"
        decoding="async"
        className="size-24 shrink-0 rounded-lg object-cover sm:size-28"
      />
    );
  }

  if (!card.thumbnailUrl) {
    return (
      <FallbackTile card={card} iconSize="size-9" className="aspect-[4/5] w-full rounded-xl" />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={card.thumbnailUrl}
      alt=""
      loading="lazy"
      decoding="async"
      className="aspect-[4/5] w-full rounded-xl object-cover"
    />
  );
}

function FallbackTile({
  card,
  className,
  iconSize,
}: {
  card: FeedCardData;
  className?: string;
  iconSize: string;
}) {
  const isTrend = card.tag === "trend";
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden",
        isTrend
          ? "bg-[linear-gradient(155deg,var(--color-trend-tint-a),var(--color-trend-tint-b))]"
          : "bg-[linear-gradient(155deg,var(--color-classic-tint-a),var(--color-classic-tint-b))]",
        className,
      )}
    >
      <ImageOff className={cn("text-[var(--color-foreground)]/30", iconSize)} aria-hidden />
    </div>
  );
}
