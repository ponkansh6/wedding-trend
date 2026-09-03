import type { Metadata } from "next";
import { Fraunces } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { SiteShell } from "@/components/layout/site-shell";
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
  "実際に結婚式を挙げた方の体験ブログを集めたキュレーションフィードです。見出しは元記事のまま、記事本文は元のサイトでお読みいただけます。";

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={`${fraunces.variable} h-full`} suppressHydrationWarning>
      <body className="flex min-h-full flex-col bg-[var(--color-background)] font-sans text-[var(--color-foreground)] antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <SiteShell>{children}</SiteShell>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
