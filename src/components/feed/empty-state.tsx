import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";

type EmptyStateProps = {
  title: string;
  description: string;
  /**
   * 運用者向け操作（収集トリガー・SNS URL 投入フォームなど）。
   * 空状態こそ、そのレーンを埋める手段を最も欲しがっている瞬間なので、
   * 渡されていれば説明文の下にそのまま差し込む。
   */
  action?: ReactNode;
};

/**
 * フィードの初期状態（DB 未投入時）用の空状態。
 * plan 19 の単一レーン化に伴い、レーンごとに見せ方を変える分岐は廃止した。
 */
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex w-full flex-col items-center gap-3 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface-hover)] px-6 py-12 text-center",
      )}
    >
      <div className="flex size-11 items-center justify-center rounded-full bg-[var(--color-surface)]">
        <Sparkles className="size-5 text-[var(--color-foreground)]/50" aria-hidden />
      </div>
      <p className="font-display text-title font-semibold text-[var(--color-foreground)]">
        {title}
      </p>
      <p className="max-w-sm text-meta leading-jp-body tracking-jp-body text-[var(--color-muted-foreground)]">
        {description}
      </p>
      {action && <div className="mt-1 w-full max-w-sm">{action}</div>}
    </div>
  );
}
