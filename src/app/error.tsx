"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center sm:px-6">
      <div className="flex size-12 items-center justify-center rounded-full bg-[var(--color-ai-chip)]">
        <AlertTriangle className="size-6 text-[var(--color-on-ai-chip)]" aria-hidden />
      </div>
      <h1 className="font-display text-[19px] font-semibold leading-jp-heading text-[var(--color-foreground)]">
        フィードの読み込みに失敗しました
      </h1>
      <p className="text-[13px] leading-jp-body tracking-jp-body text-[var(--color-muted-foreground)]">
        一時的な問題が発生した可能性があります。もう一度お試しください。
      </p>
      <Button variant="outline" onClick={() => retry()}>
        <RefreshCcw className="size-4" aria-hidden />
        もう一度試す
      </Button>
    </div>
  );
}
