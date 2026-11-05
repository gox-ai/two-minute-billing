import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Grid, Stack } from "@/components/analytics/layout";
import { Busy, PageHeaderBones } from "@/components/reports/skeletons";

/** A header-strip card: title and meta over its body. */
function CardBones({ children, flush }: { children: React.ReactNode; flush?: boolean }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-3 border-b px-5 py-3.5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-24" />
      </div>
      <div className={flush ? undefined : "px-5 py-4"}>{children}</div>
    </div>
  );
}

function TableBones({ rows }: { rows: number }) {
  return (
    <div>
      <div className="flex gap-6 border-b px-5 py-3">
        <Skeleton className="h-3 flex-1" />
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-16" />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-6 border-b px-5 py-3.5 last:border-0">
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}

export function CancellationsSkeleton() {
  return (
    <Busy label="cancellations" className="flex flex-col gap-4">
      <Grid className="gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="col-span-12 rounded-xl border bg-card p-6 lg:col-span-6 2xl:col-span-3"
          >
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-2.5 h-7 w-28" />
            <Skeleton className="mt-2.5 h-3 w-32" />
          </div>
        ))}
      </Grid>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <CardBones>
          <div className="flex items-end gap-1.5" style={{ height: 220 }}>
            {[40, 65, 50, 80, 55, 70, 45, 60, 75, 50, 65, 55].map((h, i) => (
              <Skeleton key={i} className="grow rounded-md" style={{ height: `${h}%` }} />
            ))}
          </div>
        </CardBones>
        <CardBones>
          <div className="space-y-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-2 w-full" />
              </div>
            ))}
          </div>
        </CardBones>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CardBones flush>
          <TableBones rows={4} />
        </CardBones>
        <CardBones flush>
          <TableBones rows={4} />
        </CardBones>
      </div>
      <CardBones flush>
        <TableBones rows={5} />
      </CardBones>
    </Busy>
  );
}

export function CancellationsLoading() {
  return (
    <div>
      <PageHeaderBones description />
      <Stack>
        <div className="flex items-center gap-3">
          <Skeleton className="size-4" />
          <Skeleton className="h-4.5 w-28" />
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-8 w-40" />
          <div className="h-px flex-1 bg-border" />
        </div>
        <CancellationsSkeleton />
      </Stack>
    </div>
  );
}
