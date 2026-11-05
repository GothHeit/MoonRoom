import { Skeleton } from "@/components/ui/Skeleton";

/** A row's place while it loads: title and a few posters, same sizes as the real thing. */
export function TvRowSkeleton({ wide = false }: { wide?: boolean }) {
  return (
    <div aria-hidden="true" className="py-2">
      <Skeleton className="mx-[var(--tv-x)] h-12 w-80" />
      <div className="flex gap-8 overflow-hidden px-[var(--tv-x)] py-8">
        {Array.from({ length: wide ? 4 : 7 }, (_, i) => (
          <Skeleton key={i} className={wide ? "aspect-video w-[26rem] shrink-0" : "aspect-[2/3] w-60 shrink-0"} />
        ))}
      </div>
    </div>
  );
}

export function TvHomeSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="grid min-h-[37rem] grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="flex flex-col justify-center gap-6 pl-[var(--tv-x)] pr-14">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-4/5" />
          <Skeleton className="h-[4.5rem] w-60 rounded-full" />
        </div>
        <Skeleton className="rounded-none rounded-bl-ui" />
      </div>
      <div className="pt-6">
        <TvRowSkeleton wide />
        <TvRowSkeleton />
      </div>
    </div>
  );
}

export function TvGridSkeleton() {
  return (
    <div aria-hidden="true" className="grid grid-cols-6 gap-x-8 gap-y-10 px-[var(--tv-x)] py-6">
      {Array.from({ length: 12 }, (_, i) => (
        <Skeleton key={i} className="aspect-[2/3] w-full" />
      ))}
    </div>
  );
}
