import type { ReactNode } from "react";
import { Landmark } from "lucide-react";
import { cn } from "@/lib/cn";

type EmptyStateProps = {
  variant?: "visual" | "editorial";
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
 * 各レーンの初期状態（DB 未投入時）用の空状態。
 * レーンごとのリズムに合わせて見せ方を変え、単なる
 * 「データがありません」で終わらせない。
 */
export function EmptyState({ title, description, action }: EmptyStateProps) {
  const Icon = Landmark;
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)]/60 px-6 py-12 text-center w-full",
      )}
    >
      <div
        className={cn(
          "flex size-11 items-center justify-center rounded-full bg-[linear-gradient(155deg,var(--color-classic-tint-a),var(--color-classic-tint-b))]",
        )}
      >
        <Icon className="size-5 text-[var(--color-foreground)]/50" aria-hidden />
      </div>
      <p className="font-display text-[15px] font-semibold text-[var(--color-foreground)]">
        {title}
      </p>
      <p className="max-w-sm text-[13px] leading-jp-body tracking-jp-body text-[var(--color-muted-foreground)]">
        {description}
      </p>
      {action && <div className="mt-1 w-full max-w-sm">{action}</div>}
    </div>
  );
}
