import { Skeleton } from "@/components/ui/skeleton";

/**
 * Local, not a seventh entry in `patterns/route-loading.tsx`: this page is prose in cards, which
 * is none of the six archetypes, and one route does not justify a shared shape. It mirrors
 * exactly what `page.tsx` renders — meta row, card, title, paragraph lines.
 */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading release notes">
      <div className="mb-8 space-y-2.5">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_14rem]">
        <div className="max-w-[760px] space-y-8">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="flex gap-2">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-4 w-20 rounded-full" />
              </div>
              <div className="space-y-4 rounded-xl border bg-card p-6">
                <Skeleton className="h-6 w-2/3" />
                <div className="space-y-2">
                  <Skeleton className="h-3.5 w-full" />
                  <Skeleton className="h-3.5 w-full" />
                  <Skeleton className="h-3.5 w-4/5" />
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="space-y-2 max-lg:hidden">
          <Skeleton className="h-3 w-20" />
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
