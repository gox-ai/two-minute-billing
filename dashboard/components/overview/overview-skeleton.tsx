import { Skeleton } from "@/components/ui/skeleton";
import { Grid, Stack } from "@/components/analytics/layout";

/** The overview's shape: the business cards, then the totals, four across. */
export function OverviewSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading organization">
      <Stack>
        <Skeleton className="h-6 w-32" />
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 @min-[56.875rem]/main:grid-cols-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card p-6">
              <div className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-md" />
                <Skeleton className="h-4 w-36" />
              </div>
              <Skeleton className="mt-4 h-6 w-28" />
            </div>
          ))}
        </div>
        <Skeleton className="mt-4 h-6 w-48" />
        <Grid className="max-lg:gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="col-span-6 rounded-xl border bg-card p-4 @min-[56.875rem]/main:col-span-3"
            >
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="mt-4 h-7 w-20" />
            </div>
          ))}
        </Grid>
      </Stack>
    </div>
  );
}

/** Route skeleton: the header, then the page. */
export function OverviewLoading() {
  return (
    <div>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2.5">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-3.5 w-32" />
        </div>
        <Skeleton className="h-8 w-36" />
      </div>
      <OverviewSkeleton />
    </div>
  );
}
