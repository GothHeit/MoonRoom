import { HeroSplit } from "@/components/ui/HeroSplit";
import { Skeleton } from "@/components/ui/Skeleton";

/** Stands in for the hero and rows while /home loads. */
export function HomeSkeleton() {
  return (
    <div aria-hidden="true">
      {/* Same split as the home hero: text beside the art side, which is a flat panel until the picture loads. */}
      <section className="pt-16 sm:pt-20 short:pt-12">
        <HeroSplit>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-4 h-14 w-3/4 md:h-20" />
          <Skeleton className="mt-3 h-14 w-1/2 md:h-20" />
          <Skeleton className="mt-6 h-4 w-48" />
          <Skeleton className="mt-4 h-16 w-full max-w-lg" />
          <Skeleton className="mt-7 h-11 w-36 rounded-full" />
        </HeroSplit>
      </section>
      <div className="space-y-8 py-6">
        {[0, 1].map((r) => (
          <div key={r}>
            <Skeleton className="mx-4 mb-3 h-6 w-48 sm:mx-8" />
            <div className="flex gap-3 overflow-hidden px-4 sm:px-8">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="aspect-[2/3] w-36 shrink-0 sm:w-44" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
