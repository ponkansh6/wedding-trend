import * as React from "react";
import { cn } from "@/lib/cn";

type CardProps = React.HTMLAttributes<HTMLElement> & {
  /** 既定は div。フィードカードなど独立したコンテンツには "article" を使う。 */
  as?: "div" | "article";
};

function Card({ as: Comp = "div", className, ...props }: CardProps) {
  return (
    <Comp
      className={cn(
        "rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]",
        className,
      )}
      {...props}
    />
  );
}

export { Card };
