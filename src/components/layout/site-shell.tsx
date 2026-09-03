import { SiteHeader } from "@/components/layout/site-header";

const GITHUB_ISSUES_URL = "https://github.com/ponkansh6/wedding-trend/issues";

/**
 * Public page chrome shared by RootLayout and the DOM contract smoke test.
 * Keep this server-compatible: client-only providers belong to RootLayout.
 */
export function SiteShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <footer className="flex flex-col items-center gap-1.5 border-t border-[var(--color-border)] px-4 py-6 text-center text-[12px] leading-jp-body text-[var(--color-muted-foreground)] sm:px-6">
        <p>
          本サイトは各SNS・ブログ投稿の紹介のみを行う、独立したキュレーションサービスです。掲載する記事の選定・要約はすべてAIによる自動処理で行っており、誤りを含むことがあります。詳しい内容は元投稿でご確認ください。
        </p>
        <p>
          掲載内容についてのお問い合わせ・削除のご依頼は{" "}
          <a
            href={GITHUB_ISSUES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-[var(--color-foreground)] underline underline-offset-2 hover:no-underline"
          >
            GitHub Issues
          </a>{" "}
          までご連絡ください。
        </p>
      </footer>
    </>
  );
}
