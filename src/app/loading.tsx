import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";

/**
 * 実カードと同じく、カテゴリ・トピック・アンカーはデータがあるときだけ
 * 表示される。ローディング中はその有無を仮定せず、タイトルとフッターだけを
 * 固定骨格として見せる。
 */
function FeedCardSkeleton() {
  return (
    <Card as="article" className="flex h-full flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <Skeleton className="h-5 w-20 rounded-full" />
        <Skeleton className="h-5 w-14 rounded-full" />
        <Skeleton className="h-5 w-12 rounded-full" />
      </div>
      <div className="mt-1 flex flex-col gap-1.5">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-3/4" />
      </div>
      <div className="mt-auto flex items-center gap-2.5 border-t border-[var(--color-border)] pt-3">
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="ml-auto h-3.5 w-16" />
      </div>
    </Card>
  );
}

export default function Loading() {
  return (
    <div
      className="mx-auto flex max-w-5xl flex-col gap-10 px-4 py-6 sm:px-6 sm:py-10"
      role="status"
    >
      <span className="sr-only">記事を読み込んでいます</span>

      <section aria-hidden="true" className="flex flex-col gap-4">
        <header className="flex flex-col gap-1.5">
          <Skeleton className="h-8 w-52" />
          <Skeleton className="h-4 w-full max-w-xl" />
          <Skeleton className="h-4 w-full max-w-lg" />
        </header>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <FeedCardSkeleton key={i} />
          ))}
        </div>
      </section>
    </div>
  );
}
