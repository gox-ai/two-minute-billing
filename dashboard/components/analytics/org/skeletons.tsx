import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Grid, Stack } from "@/components/analytics/layout";

/**
 * Org Home's and Org Metrics' skeletons, on the same grid and card anatomy as their blocks: a
 * full-width figure-and-chart card, then a full-width table card.
 */

function TableCard({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="col-span-12 rounded-xl border bg-card p-6">
      <Skeleton className="h-4 w-36" />
      <div className="mt-4">
        <div className="flex gap-6 border-b pb-2">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-3 flex-1" />
          ))}
        </div>
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex items-center gap-6 border-b py-3 last:border-0">
            {Array.from({ length: cols }).map((_, c) => (
              <Skeleton key={c} className="h-3.5 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function HeaderBones({ controls }: { controls: number }) {
  return (
    <div className="mb-8 flex items-start justify-between gap-4">
      <div className="space-y-2.5">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-3.5 w-32" />
      </div>
      <div className="flex gap-2">
        {Array.from({ length: controls }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-32" />
        ))}
      </div>
    </div>
  );
}

/** The portfolio card (figure + trend, three readings beside it), then the roster. */
function ZoneBones({ controls = 0 }: { controls?: number }) {
  return (
    <div className="flex items-center gap-3">
      <Skeleton className="size-4" />
      <Skeleton className="h-4.5 w-28" />
      {Array.from({ length: controls }).map((_, i) => (
        <Skeleton key={i} className="h-8 w-28" />
      ))}
      <Skeleton className="h-3.5 w-28" />
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

/** Home's headline tile: label, figure, a labelled stat footer. */
function HeadlineBones() {
  return (
    <div className="col-span-12 rounded-xl border bg-card p-6 md:col-span-6 xl:col-span-3">
      <Skeleton className="h-3 w-32" />
      <Skeleton className="mt-2.5 h-7 w-28" />
      <div className="mt-4 grid grid-cols-3 gap-3 border-t pt-3.5">
        <Skeleton className="h-6 w-16" />
        <Skeleton className="h-6 w-16" />
      </div>
    </div>
  );
}

function CardBones({ span, children }: { span: string; children: React.ReactNode }) {
  return (
    <div className={span + " rounded-xl border bg-card p-6"}>
      <div className="flex items-center justify-between">
        <Skeleton className="h-4.5 w-32" />
        <Skeleton className="h-3.5 w-28" />
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

export function OrgHomeSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading organization">
      <Stack>
        <Grid>
          <HeadlineBones />
          <HeadlineBones />
          <HeadlineBones />
          <HeadlineBones />
        </Grid>
        <Skeleton className="h-16 w-full rounded-xl" />
        <div className="mt-4">
          <ZoneBones />
        </div>
        <Grid>
          <CardBones span="col-span-12 xl:col-span-8">
            <Skeleton className="h-3.5 w-48" />
            <Skeleton className="mt-3 h-[220px] w-full rounded-lg" />
          </CardBones>
          <CardBones span="col-span-12 xl:col-span-4 self-start">
            <Skeleton className="h-7 w-32" />
            <Skeleton className="mt-4 h-2 w-full" />
            <Skeleton className="mt-2 h-3 w-40" />
          </CardBones>
        </Grid>
        <Grid>
          <TableCard rows={4} cols={5} />
        </Grid>
      </Stack>
    </div>
  );
}

export function OrgHomeLoading() {
  return (
    <div>
      <HeaderBones controls={3} />
      <OrgHomeSkeleton />
    </div>
  );
}

/** The headline beside the by-business chart, then the comparison table. */
export function OrgMetricsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading metrics">
      <Stack>
        <Grid>
          <CardBones span="col-span-12">
            <Skeleton className="h-7 w-36" />
            <Skeleton className="mt-2 h-3.5 w-72" />
            <Skeleton className="mt-4 h-[240px] w-full rounded-lg" />
          </CardBones>
        </Grid>
        <Grid>
          <TableCard rows={5} cols={4} />
        </Grid>
      </Stack>
    </div>
  );
}

/** The Metrics Current zone: four headline tiles, then MRR by business beside currency. */
export function PortfolioCurrentSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading portfolio" className="flex flex-col gap-6">
      <Grid>
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="col-span-12 rounded-xl border bg-card p-6 md:col-span-6 xl:col-span-3"
          >
            <Skeleton className="h-3 w-28" />
            <Skeleton className="mt-2.5 h-7 w-24" />
            <div className="mt-4 grid grid-cols-2 gap-3 border-t pt-3.5">
              <Skeleton className="h-6 w-16" />
              <Skeleton className="h-6 w-16" />
            </div>
          </div>
        ))}
      </Grid>
      <Grid>
        <CardBones span="col-span-12 xl:col-span-8">
          <Skeleton className="h-2 w-full" />
          <div className="mt-4 space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        </CardBones>
        <CardBones span="col-span-12 xl:col-span-4">
          <Skeleton className="h-2 w-full" />
          <div className="mt-4 space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        </CardBones>
      </Grid>
    </div>
  );
}

/** The Metrics Performance zone: growth beside cash, then the scorecard. */
export function PortfolioPerformanceSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading performance" className="flex flex-col gap-6">
      <Grid>
        <CardBones span="col-span-12 xl:col-span-8">
          <Skeleton className="h-3.5 w-80" />
          <div className="mt-4 space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        </CardBones>
        <CardBones span="col-span-12 xl:col-span-4 self-start">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="mt-4 h-2 w-full" />
          <Skeleton className="mt-2 h-3 w-40" />
        </CardBones>
      </Grid>
      <Grid>
        <TableCard rows={5} cols={9} />
      </Grid>
    </div>
  );
}

export function OrgMetricsLoading() {
  return (
    <div>
      <HeaderBones controls={2} />
      <Stack>
        <PortfolioCurrentSkeleton />
        <div className="mt-4">
          <ZoneBones controls={1} />
        </div>
        <PortfolioPerformanceSkeleton />
      </Stack>
    </div>
  );
}
