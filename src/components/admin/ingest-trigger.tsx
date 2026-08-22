"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { triggerIngest } from "@/app/actions";

/**
 * 収集は最大60秒ほどかかるため、経過に応じてメッセージを切り替え、
 * 「止まっているのではなく進んでいる」ことを伝える。実際の進捗は
 * サーバー側から取得できないため、平均的な所要時間から見た目上の
 * 目安として段階を進める（正確な進捗率ではない）。
 */
const PROGRESS_STEPS = [
  "取得元のRSSを巡回しています…",
  "新着記事を選別しています…",
  "AIが要約を生成しています…",
  "もうしばらくお待ちください…",
] as const;

const STEP_INTERVAL_MS = 9_000;

type IngestTriggerProps = {
  className?: string;
  /** 空状態などの控えめな文脈で使う場合に true。ボタンを一段小さくする。 */
  compact?: boolean;
};

export function IngestTrigger({ className, compact = false }: IngestTriggerProps) {
  const [isPending, startTransition] = useTransition();
  const [stepIndex, setStepIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const router = useRouter();

  // 進捗表示のリセットは「実行を開始したイベント」側で行う（handleClick）。
  // effect 内で同期的に setState するとカスケードレンダリングになるため。
  useEffect(() => {
    if (!isPending) return;

    const stepTimer = setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, PROGRESS_STEPS.length - 1));
    }, STEP_INTERVAL_MS);
    const clock = setInterval(() => setElapsed((s) => s + 1), 1000);

    return () => {
      clearInterval(stepTimer);
      clearInterval(clock);
    };
  }, [isPending]);

  const handleClick = () => {
    if (isPending) return;
    setStepIndex(0);
    setElapsed(0);
    startTransition(async () => {
      const result = await triggerIngest();
      if (result.ok) {
        toast.success(
          `取得 ${result.fetched}件・新規 ${result.inserted}件・要約済み ${result.curated}件・スキップ ${result.skipped}件`,
          {
            description:
              result.errors.length > 0
                ? `一部で失敗がありました: ${result.errors.join(" / ")}`
                : undefined,
          },
        );
        router.refresh();
      } else {
        toast.error("収集に失敗しました", {
          description:
            result.errors.length > 0 ? result.errors.join(" / ") : "詳細不明のエラーです。",
        });
      }
    });
  };

  return (
    <div className={cn("flex flex-col items-start gap-2 text-left", className)}>
      <Button
        type="button"
        variant="trend"
        size={compact ? "sm" : "default"}
        onClick={handleClick}
        disabled={isPending}
        aria-describedby="ingest-trigger-status"
        className="w-fit"
      >
        {isPending ? (
          <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
        ) : (
          <RefreshCw className="size-4" aria-hidden />
        )}
        {isPending ? "収集中…" : "投稿を収集する"}
      </Button>
      <p
        id="ingest-trigger-status"
        role="status"
        aria-live="polite"
        aria-busy={isPending}
        className={cn(
          "text-[12px] leading-jp-body tracking-jp-body text-[var(--color-muted-foreground)]",
          !isPending && "sr-only",
        )}
      >
        {isPending
          ? `${PROGRESS_STEPS[stepIndex]}（${elapsed}秒経過・最大60秒ほどかかります）`
          : ""}
      </p>
    </div>
  );
}
