import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Busy, PageHeaderBones } from "@/components/reports/skeletons";

/** A header-strip card's title row. */
function StripBones({ title, chip }: { title: string; chip?: boolean }) {
  return (
    <div className="flex items-center gap-3 border-b px-5 py-3.5">
      <Skeleton className={`h-4 ${title}`} />
      {chip ? <Skeleton className="h-5 w-32 rounded-full" /> : null}
    </div>
  );
}

/** `ExploreResult`'s card: title strip, charted line + 220px chart, table, fold, facts. */
export function ExploreResultSkeleton() {
  return (
    <Busy label="result">
      <div className="flex flex-col overflow-hidden rounded-xl border bg-card">
        <StripBones title="w-64" chip />
        <div className="flex flex-col gap-3 px-5 pt-4 pb-5">
          <Skeleton className="h-3.5 w-56" />
          <Skeleton className="h-[220px] w-full rounded-lg" />
        </div>
        <div className="flex h-9 items-center gap-4 border-y px-5">
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-30" />
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex h-11 items-center gap-4 border-b px-5">
            <Skeleton className="h-3.5 flex-1" />
            <Skeleton className="h-3.5 w-30" />
          </div>
        ))}
        <div className="flex h-11 items-center gap-4 px-5">
          <Skeleton className="h-3.5 w-16" />
          <div className="flex-1" />
          <Skeleton className="h-3.5 w-30" />
        </div>
        <div className="flex items-center border-t px-5 py-3">
          <Skeleton className="h-3.5 w-44" />
        </div>
        <div className="border-t px-5 py-2.5">
          <Skeleton className="h-3 w-96 max-w-full" />
        </div>
      </div>
    </Busy>
  );
}

/** Route skeleton: header, then the Query card (4) beside the result (8). */
export function ExploreLoading() {
  return (
    <div>
      <PageHeaderBones description />
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-12">
        <div
          className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card xl:col-span-4"
          aria-hidden
        >
          <StripBones title="w-16" />
          {/* Measures, Rows, Period, Filters. */}
          {[8, 6, 3, 1].map((rows, s) => (
            <div key={s} className="flex flex-col gap-3 border-b px-5 py-4 last:border-0">
              <Skeleton className="h-3 w-24" />
              {Array.from({ length: rows }).map((_, i) => (
                <Skeleton key={i} className={s === 2 && i < 2 ? "h-9 w-full" : "h-4 w-full"} />
              ))}
            </div>
          ))}
        </div>
        <div className="min-w-0 xl:col-span-8">
          <ExploreResultSkeleton />
        </div>
      </div>
    </div>
  );
}
