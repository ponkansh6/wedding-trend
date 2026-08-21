import type { Metadata } from "next";
import { Fraunces } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { SiteHeader } from "@/components/layout/site-header";
import { Toaster } from "@/components/layout/toaster";
import "./globals.css";

/**
 * 見出しや数字・英字の装飾に使う欧文ディスプレイ書体。
 * Fraunces は日本語グリフを持たないため、和文は自動的に
 * フォールバック（游明朝・ヒラギノ明朝など）で表示される。
 * 日本語 Web フォントを別途同梱する必要がなく、軽量なまま
 * 欧文・数字だけに個性を出せる。
 */
const fraunces = Fraunces({
  subsets: ["latin"],
  axes: ["opsz"],
  style: ["normal", "italic"],
  variable: "--font-fraunces",
  display: "swap",
});

const SITE_NAME = "ウエディング・トレンド＆リアルフィード";
const SITE_DESCRIPTION =
  "結婚式準備の「今」のトレンドと「リアル」な体験談を、AI要約と元投稿へのリンクで1分で俯瞰できるキュレーションフィードです。";

export const metadata: Metadata = {
  title: {
    default: SITE_NAME,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  openGraph: {
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    locale: "ja_JP",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ja"
      className={`${fraunces.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col bg-[var(--color-background)] font-sans text-[var(--color-foreground)] antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <SiteHeader />
          <main className="flex-1">{children}</main>
          <footer className="border-t border-[var(--color-border)] px-4 py-6 text-center text-[12px] leading-jp-body text-[var(--color-muted-foreground)] sm:px-6">
            本サイトは各SNS・ブログ投稿のAI要約と紹介のみを行う、独立したキュレーションサービスです。詳しい内容は元投稿でご確認ください。
          </footer>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
