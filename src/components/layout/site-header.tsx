import Link from "next/link";
import { ThemeToggle } from "@/components/layout/theme-toggle";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-border)] bg-[var(--color-background)]/85 backdrop-blur-sm">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link
          href="/"
          className="flex items-baseline gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background)]"
        >
          <span className="font-display text-[17px] font-semibold leading-none tracking-jp-heading text-[var(--color-foreground)] sm:text-[19px]">
            ウエディング・トレンド
          </span>
          <span className="text-[12px] text-[var(--color-muted-foreground)] sm:text-[13px]">
            ＆リアルフィード
          </span>
        </Link>
        <ThemeToggle />
      </div>
    </header>
  );
}
