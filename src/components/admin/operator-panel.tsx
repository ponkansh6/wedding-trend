import { ChevronDown, Settings2 } from "lucide-react";
import { IngestTrigger } from "@/components/admin/ingest-trigger";
import { SubmitUrlForm } from "@/components/admin/submit-url-form";

/**
 * 運用者向けコントロール（収集トリガー・SNS URL 投入）をまとめた折りたたみ
 * パネル。読者向けの導線とは切り離し、ページ最下部に控えめに配置することで
 * フィード自体の視線誘導を妨げない。ネイティブ <details> なので JS 不要で
 * 開閉でき、開閉状態を持つのはここだけ（中身は各コンポーネントが
 * "use client" として自律的にペンディング状態を扱う）。
 */
export function OperatorPanel() {
  return (
    <details className="group rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)]/60 open:bg-[var(--color-surface)]">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-2xl px-4 py-3 text-[13px] font-medium text-[var(--color-muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background)] group-open:rounded-b-none [&::-webkit-details-marker]:hidden">
        <Settings2 className="size-4" aria-hidden />
        運用ツール
        <span className="text-[11px] text-[var(--color-muted-foreground)]/70">
          収集トリガー・SNS投稿の追加
        </span>
        <ChevronDown
          className="ml-auto size-4 shrink-0 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
          aria-hidden
        />
      </summary>
      <div className="flex flex-col gap-5 border-t border-[var(--color-border)] px-4 py-4 sm:flex-row sm:gap-6">
        <div className="flex flex-1 flex-col gap-2">
          <p className="text-[12px] font-semibold text-[var(--color-foreground)]">
            定番アーカイブを更新
          </p>
          <p className="text-[12px] leading-jp-body tracking-jp-body text-[var(--color-muted-foreground)]">
            登録済みのRSS取得元を巡回し、新着記事をAIが要約します。
          </p>
          <IngestTrigger />
        </div>
        <div className="hidden w-px shrink-0 bg-[var(--color-border)] sm:block" aria-hidden />
        <div className="flex flex-1 flex-col gap-2">
          <p className="text-[12px] font-semibold text-[var(--color-foreground)]">
            速報レーンにSNS投稿を追加
          </p>
          <SubmitUrlForm />
        </div>
      </div>
    </details>
  );
}
