import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";

/**
 * plan 21 §6-9: topicAnchor・topics は欠損時に非表示という実カードの挙動と
 * 一致させるため、スケルトンはタイトル2行分 + メタ情報1行分のみを描く。
 * 「必ず要約とタグが出る」という誤った期待をローディング中に生まないための判断。
 */
function FeedCardSkeleton() {
  return (
    <Card className="flex flex-col gap-2.5 p-4">
      <Skeleton className="h-5 w-20 rounded-full" />
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <div className="mt-auto flex items-center justify-between gap-2.5 border-t border-[var(--color-border)] pt-3">
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="h-9 w-24 shrink-0 rounded-full" />
      </div>
    </Card>
  );
}

export default function Loading() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-10 px-4 py-6 sm:px-6 sm:py-10">
      <Skeleton className="h-4 w-full max-w-2xl" />

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="h-3.5 w-full max-w-sm" />
        </div>
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <FeedCardSkeleton key={i} />
          ))}
        </div>
      </section>
    </div>
  );
}
