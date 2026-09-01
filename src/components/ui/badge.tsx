import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full font-medium leading-none whitespace-nowrap",
  {
    variants: {
      variant: {
        /** カテゴリバッジ: 主張を抑えた脇役バッジ。ただしトピックチップとは
         *  色相・彩度が同一で、枠線の有無以外に判別材料がなかった
         *  （plan A で是正）。朱をごく薄く効かせた枠線 + 文字色を
         *  --foreground に上げ、太字にすることで、色だけに依存しない
         *  差（濃さ・太さ）で区別できるようにする。CTAボタンの主張を
         *  上回らない範囲（--category-border は --accent 28% 混色）に留める。 */
        category:
          "border border-[var(--color-category-border)] text-[var(--color-foreground)] bg-transparent px-2.5 py-1 text-xs font-semibold tracking-wide",
        /** トピックチップ: カテゴリより一段控えめな、地色に馴染む脇役チップ。
         *  非クリッカブルなためリンク然とした反応は付けない（hover/focus装飾なし）。 */
        topic:
          "border border-[var(--color-topic-border)] bg-[var(--color-topic-chip)] text-[var(--color-muted-foreground)] px-2 py-0.5 shadow-[inset_0_1px_0_var(--color-topic-chip-highlight),inset_0_-1px_1px_var(--color-topic-chip-shadow)]",
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
