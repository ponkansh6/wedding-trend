import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

function VisualCardSkeleton() {
  return (
    <Card className="flex w-[80%] max-w-[320px] shrink-0 flex-col gap-3.5 p-3.5 sm:w-auto sm:max-w-none">
      <div className="flex gap-1.5">
        <Skeleton className="h-6 w-16 rounded-full" />
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>
      <Skeleton className="aspect-[4/5] w-full rounded-xl" />
      <Skeleton className="h-4 w-4/5" />
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <Skeleton className="h-9 w-full rounded-full" />
    </Card>
  );
}

function EditorialCardSkeleton() {
  return (
    <Card className="flex gap-3 p-4">
      <Skeleton className="size-24 shrink-0 rounded-lg sm:size-28" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex gap-1.5">
          <Skeleton className="h-6 w-16 rounded-full" />
          <Skeleton className="h-6 w-14 rounded-full" />
        </div>
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-4/5" />
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
          <Skeleton className="h-3.5 w-16" />
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
        <div className="flex gap-4 overflow-x-hidden sm:grid sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <VisualCardSkeleton key={i} />
          ))}
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <EditorialCardSkeleton key={i} />
          ))}
        </div>
      </section>
    </div>
  );
}
