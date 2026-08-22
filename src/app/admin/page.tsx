import { IngestStatusPanel } from "@/components/admin/ingest-status-panel";
import { OperatorPanel } from "@/components/admin/operator-panel";
import { Separator } from "@/components/ui/separator";
import { getIngestCooldown, getIngestStatus } from "@/app/actions";

/**
 * 収集トリガー（`triggerIngest`）の Server Action はこのページのルート関数上で
 * 実行される。巡回・要約に最大60秒ほどかかるため、Vercel の既定タイムアウトでは
 * 本番で打ち切られてしまう（収集ボタンの移動に合わせて元 `src/app/page.tsx` の
 * 設定をこちらへ引き継いだ）。
 */
export const maxDuration = 60;

/**
 * 管理画面はキャッシュしてはならない。オーナーが `/admin` で収集を実行した
 * 直後に、クールダウン状態・直近ラン結果（`last_run_summary`）を必ず最新の
 * DB 状態で確認できる必要があるため。
 */
export const dynamic = "force-dynamic";

/**
 * オーナー限定の管理画面。`src/middleware.ts` が matcher `/admin/:path*` で
 * Basic 認証を強制する（`ADMIN_BASIC_AUTH_USER` / `ADMIN_BASIC_AUTH_PASSWORD`
 * 未設定時、本番は 503）。ここに置かれる Server Action
 * （`triggerIngest` / `submitSnsUrl`）はミドルウェアに加えて自身でも
 * Basic 認証を再検証する多層防御（`src/lib/auth.ts` の `isBasicAuthorized`）。
 */
export default async function AdminPage() {
  const [{ cooldownUntil }, lastRunSummary] = await Promise.all([
    getIngestCooldown(),
    getIngestStatus(),
  ]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-[20px] font-semibold text-[var(--color-foreground)]">
          管理
        </h1>
        <p className="text-[13px] text-[var(--color-muted-foreground)]">
          収集トリガーとSNS投稿の追加は、この画面からのみ操作できます。
        </p>
      </header>

      <IngestStatusPanel summary={lastRunSummary} cooldownUntil={cooldownUntil} />

      <Separator />

      <OperatorPanel />
    </div>
  );
}
