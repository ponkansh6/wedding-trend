import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full font-medium leading-none whitespace-nowrap",
  {
    variants: {
      variant: {
        /** カテゴリバッジ: 主張を抑えた脇役バッジ */
        category:
          "border border-[var(--color-border)] text-[var(--color-muted-foreground)] bg-transparent px-2.5 py-1 text-xs",
        /** トピックチップ: カテゴリより一段控えめな、地色に馴染む脇役チップ。
         *  非クリッカブルなためリンク然とした反応は付けない（hover/focus装飾なし）。 */
        topic:
          "border border-[var(--color-topic-border)] bg-[var(--color-topic-chip)] text-[var(--color-muted-foreground)] px-2 py-0.5",
      },
    },
    defaultVariants: {
      variant: "category",
    },
  },
);

type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}

export { Badge, badgeVariants };
