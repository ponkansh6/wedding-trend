import { Flame, Landmark } from "lucide-react";
import { cn } from "@/lib/cn";

type EmptyStateProps = {
  variant: "visual" | "editorial";
  title: string;
  description: string;
};

/**
 * 各レーンの初期状態（DB 未投入時）用の空状態。
 * レーンごとのリズムに合わせて見せ方を変え、単なる
 * 「データがありません」で終わらせない。
 */
export function EmptyState({ variant, title, description }: EmptyStateProps) {
  const Icon = variant === "visual" ? Flame : Landmark;
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)]/60 px-6 py-12 text-center",
        variant === "visual" ? "w-full" : "w-full",
      )}
    >
      <div
        className={cn(
          "flex size-11 items-center justify-center rounded-full",
          variant === "visual"
            ? "bg-[linear-gradient(155deg,var(--color-trend-tint-a),var(--color-trend-tint-b))]"
            : "bg-[linear-gradient(155deg,var(--color-classic-tint-a),var(--color-classic-tint-b))]",
        )}
      >
        <Icon className="size-5 text-[var(--color-foreground)]/50" aria-hidden />
      </div>
      <p className="font-display text-[15px] font-semibold text-[var(--color-foreground)]">
        {title}
      </p>
      <p className="max-w-sm text-[13px] leading-jp-body tracking-jp-body text-[var(--color-muted-foreground)]">
        {description}
      </p>
    </div>
  );
}
