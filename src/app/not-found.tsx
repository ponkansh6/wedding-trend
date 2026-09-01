import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center sm:px-6">
      <div className="flex size-12 items-center justify-center rounded-full bg-[var(--color-surface-hover)]">
        <SearchX className="size-6 text-[var(--color-foreground)]/60" aria-hidden />
      </div>
      <h1 className="font-display text-[19px] font-semibold leading-jp-heading text-[var(--color-foreground)]">
        ページが見つかりません
      </h1>
      <p className="text-[13px] leading-jp-body tracking-jp-body text-[var(--color-muted-foreground)]">
        お探しのページは移動または削除された可能性があります。
      </p>
      <Button asChild variant="outline">
        <Link href="/">トップに戻る</Link>
      </Button>
    </div>
  );
}
