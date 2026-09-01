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
          {/* サイト名は全角の日本語のみで構成されるため、--font-display の
              先頭書体 Fraunces（日本語グリフなし）自体は発動しない。ただし
              フォールバック先が "Hiragino Mincho ProN" / "Yu Mincho" という
              明朝体であるため、本文の和文ゴシック（font-sans）とは異なる
              エディトリアルな明朝ロゴタイプとして実際に描画されている
              （plan A で確認・意図を明文化。純粋な死んだ指定ではなかった）。
              本文と字形の異なる書体を保つのがこの見出しの意図のため、
              font-display の指定はそのまま維持する。 */}
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
