import { ChevronDown, Settings2 } from "lucide-react";
import { SubmitUrlForm } from "@/components/admin/submit-url-form";

/**
 * 運用者専用コントロール（SNS URL 投入）をまとめた折りたたみパネル。
 * `/admin`（`src/middleware.ts` の Basic 認証配下）にのみ置かれ、収集トリガー
 * （`IngestStatusPanel`）と同じページに同居する。判断力が要る・濫用防止のため
 * 公開面には出せない操作をここに集約する。ネイティブ <details> なので JS 不要で
 * 開閉でき、開閉状態を持つのはここだけ（中身は SubmitUrlForm が
 * "use client" として自律的にペンディング状態を扱う）。
 */
export function OperatorPanel() {
  return (
    <details className="group rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)]/60 open:bg-[var(--color-surface)]">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-2xl px-4 py-3 text-[13px] font-medium text-[var(--color-muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background)] group-open:rounded-b-none [&::-webkit-details-marker]:hidden">
        <Settings2 className="size-4" aria-hidden />
        運用ツール
        <span className="text-[11px] text-[var(--color-muted-foreground)]/70">SNS投稿の追加</span>
        <ChevronDown
          className="ml-auto size-4 shrink-0 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
          aria-hidden
        />
      </summary>
      <div className="flex flex-col gap-2 border-t border-[var(--color-border)] px-4 py-4">
        <p className="text-[12px] font-semibold text-[var(--color-foreground)]">
          速報レーンにSNS投稿を追加
        </p>
        <SubmitUrlForm />
      </div>
    </details>
  );
}
