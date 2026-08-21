import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full font-medium leading-none whitespace-nowrap",
  {
    variants: {
      variant: {
        /** トレンドバッジ: 速報性・熱量を伝える主役バッジ */
        trend:
          "bg-[var(--color-trend)] text-[var(--color-on-trend)] px-2.5 py-1 text-xs font-semibold tracking-wide",
        /** 定番バッジ: 落ち着いた信頼感を伝える主役バッジ */
        classic:
          "bg-[var(--color-classic)] text-[var(--color-on-classic)] px-2.5 py-1 text-xs font-semibold tracking-wide",
        /** カテゴリバッジ: 主張を抑えた脇役バッジ */
        category:
          "border border-[var(--color-border)] text-[var(--color-muted-foreground)] bg-transparent px-2.5 py-1 text-xs",
        /** AI 生成の明示マーカー */
        ai: "bg-[var(--color-ai-chip)] text-[var(--color-on-ai-chip)] px-2 py-0.5 text-[11px]",
      },
    },
    defaultVariants: {
      variant: "category",
    },
  },
);

type BadgeProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant, className }))} {...props} />
  );
}

export { Badge, badgeVariants };
