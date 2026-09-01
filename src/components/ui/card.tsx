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
        "@container relative rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]",
        "motion-safe:transition-[transform,box-shadow] motion-safe:duration-200 motion-safe:ease-out",
        "motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-[var(--shadow-card)]",
        className,
      )}
      {...props}
    />
  );
}

export { Card };
