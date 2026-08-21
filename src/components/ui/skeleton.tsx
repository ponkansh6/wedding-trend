import * as React from "react";
import { cn } from "@/lib/cn";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-pulse motion-reduce:animate-none rounded-lg bg-[var(--color-skeleton)]",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
