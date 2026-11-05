import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Busy, PageHeaderBones } from "@/components/reports/skeletons";

/** The segment card's heading, which changes with the rail selection. */
export function SegmentTitleSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-3.5 w-64" />
    </div>
  );
}

/** The population table (customer, country, subscriptions, MRR, signed up, status). */
export function SegmentBodySkeleton() {
  return (
    <Busy label="customers">
      <div className="flex gap-6 border-b px-5 py-3">
        {Array.from({ length: 6 }).map((_, c) => (
          <Skeleton key={c} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: 8 }).map((_, r) => (
        <div key={r} className="flex items-center gap-6 border-b px-5 py-3.5 last:border-0">
          {Array.from({ length: 6 }).map((_, c) => (
            <Skeleton key={c} className="h-3.5 flex-1" />
          ))}
        </div>
      ))}
    </Busy>
  );
}

/** A header-strip card: title row, then its body. */
function CardBones({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-3 border-b px-5 py-3.5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-20" />
      </div>
      {children}
    </div>
  );
}

/** Route skeleton: header, the segment card, then the table beside the segment rail. */
export function CustomerSegmentsLoading() {
  return (
    <div>
      <PageHeaderBones description />
      <div className="flex flex-col gap-5">
        <div className="overflow-hidden rounded-xl border bg-card" aria-hidden>
          <div className="flex flex-col gap-x-8 gap-y-4 px-6 py-5 md:flex-row md:items-start">
            <div className="flex-1">
              <SegmentTitleSkeleton />
            </div>
            <div className="flex gap-10">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-7 w-16" />
              </div>
              <div className="flex flex-col gap-2">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-7 w-32" />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 border-t px-6 py-3">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-7 w-40 rounded-full" />
            <Skeleton className="h-8 w-28" />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <CardBones>
            <SegmentBodySkeleton />
          </CardBones>
          <CardBones>
            <div className="flex flex-col gap-2 p-3" aria-hidden>
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-7 w-full" />
              ))}
            </div>
          </CardBones>
        </div>
      </div>
    </div>
  );
}
