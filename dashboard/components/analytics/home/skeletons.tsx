import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Grid, Stack, spanClass, type Span } from "@/components/analytics/layout";
import { cn } from "@/lib/utils";

/**
 * Business Home's body skeletons, one per tab, built from the same grid, spans and card padding
 * as the blocks they stand in for — so the shimmer sits where each block will land.
 */

function Box({
  span,
  title = true,
  children,
}: {
  span: Span;
  title?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col rounded-xl border bg-card p-6", spanClass(span))}>
      {title ? <Skeleton className="h-4 w-40" /> : null}
      <div className={cn("min-w-0", title && "mt-4")}>{children}</div>
    </div>
  );
}

/** A 26px figure: label, value, note. */
function FigureBones() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-6 w-28" />
      <Skeleton className="h-2.5 w-20" />
    </div>
  );
}

function RowBones({ rows = 5 }: { rows?: number }) {
  return (
    <div>
      <div className="flex gap-6 border-b pb-2">
        <Skeleton className="h-3 flex-1" />
        <Skeleton className="h-3 w-20" />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-6 border-b py-3 last:border-0">
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3.5 w-20" />
        </div>
      ))}
    </div>
  );
}

function LineBones({ lines = 5 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="flex items-center gap-2">
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}

function Busy({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div aria-busy="true" aria-label={`Loading ${label}`}>
      {children}
    </div>
  );
}

function TileBones({ count, cols }: { count: number; cols: string }) {
  return (
    <div className={cn("grid gap-6", cols)}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="space-y-2 rounded-xl border bg-card p-6">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-2.5 w-16" />
        </div>
      ))}
    </div>
  );
}

function ChartBones({ height }: { height: number }) {
  return (
    <div className="space-y-3">
      <Skeleton className="h-6 w-32" />
      <Skeleton className="w-full rounded-lg" style={{ height }} />
    </div>
  );
}

/** A zone heading's shape, for the route-level loading screen. */
function ZoneBones({ picker }: { picker?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <Skeleton className="size-4 rounded-full" />
      <Skeleton className="h-4 w-24" />
      {picker ? <Skeleton className="h-8 w-32" /> : null}
      <Skeleton className="h-3 w-28" />
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

export function OverviewCurrentSkeleton() {
  return (
    <Busy label="overview">
      <Stack>
        <Grid>
          {Array.from({ length: 3 }).map((_, i) => (
            <Box key={i} span={4} title={false}>
              <FigureBones />
            </Box>
          ))}
        </Grid>
        <div className="grid grid-cols-1 divide-y rounded-xl border bg-card lg:grid-cols-4 lg:divide-x lg:divide-y-0">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-2 px-5 py-3">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </Stack>
    </Busy>
  );
}

export function OverviewPerformanceSkeleton() {
  return (
    <Busy label="overview performance">
      <Stack>
        <Grid>
          <Box span={8}>
            <ChartBones height={220 + 48} />
          </Box>
          <div className={cn(spanClass(4), "flex flex-col gap-6")}>
            <Box span={12} title={false}>
              <LineBones lines={4} />
            </Box>
            <Box span={12}>
              <div className="flex gap-6">
                <FigureBones />
                <FigureBones />
                <FigureBones />
              </div>
            </Box>
          </div>
        </Grid>
        <Grid>
          <Box span={6}>
            <ChartBones height={180} />
          </Box>
          <Box span={6}>
            <ChartBones height={180} />
          </Box>
        </Grid>
        <Grid>
          {Array.from({ length: 3 }).map((_, i) => (
            <Box key={i} span={4}>
              <Skeleton className="h-6 w-28" />
              <div className="mt-5">
                <LineBones lines={3} />
              </div>
            </Box>
          ))}
        </Grid>
      </Stack>
    </Busy>
  );
}

export function RecurringCurrentSkeleton() {
  return (
    <Busy label="recurring revenue">
      <Stack>
        <Grid>
          <Box span={6}>
            <LineBones lines={8} />
          </Box>
          <Box span={6}>
            <RowBones rows={4} />
          </Box>
        </Grid>
        <Grid>
          <Box span={6}>
            <LineBones lines={2} />
          </Box>
          <Box span={6}>
            <LineBones lines={3} />
          </Box>
        </Grid>
      </Stack>
    </Busy>
  );
}

export function RecurringPerformanceSkeleton() {
  return (
    <Busy label="recurring revenue performance">
      <Stack>
        <Grid>
          <Box span={8}>
            <Skeleton className="h-[180px] w-full rounded-lg" />
            <div className="mt-3 flex justify-between gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-3 w-14" />
              ))}
            </div>
          </Box>
          <Box span={4} title={false}>
            <LineBones lines={5} />
          </Box>
        </Grid>
        <Grid>
          <Box span={12}>
            <Skeleton className="h-[240px] w-full rounded-lg" />
          </Box>
        </Grid>
        <Grid>
          <Box span={6}>
            <RowBones rows={6} />
          </Box>
          <Box span={6}>
            <LineBones lines={5} />
          </Box>
        </Grid>
      </Stack>
    </Busy>
  );
}

export function CollectionsCurrentSkeleton() {
  return (
    <Busy label="collections">
      <Stack>
        <Grid>
          <Box span={4}>
            <RowBones rows={3} />
          </Box>
          <Box span={4}>
            <Skeleton className="h-6 w-28" />
            <Skeleton className="mt-4 h-2 w-full" />
            <div className="mt-3 flex justify-between">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-6 w-12" />
              ))}
            </div>
          </Box>
          <Box span={4}>
            <Skeleton className="h-6 w-28" />
            <Skeleton className="mt-4 h-2 w-full" />
            <div className="mt-3 flex justify-between">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-6 w-10" />
              ))}
            </div>
          </Box>
        </Grid>
      </Stack>
    </Busy>
  );
}

export function CollectionsPerformanceSkeleton() {
  return (
    <Busy label="collections performance">
      <Stack>
        <TileBones count={4} cols="grid-cols-1 md:grid-cols-2 xl:grid-cols-4" />
        <Grid>
          <Box span={8}>
            <LineBones lines={8} />
          </Box>
          <Box span={4}>
            <Skeleton className="h-2 w-full" />
            <div className="mt-5">
              <LineBones lines={3} />
            </div>
          </Box>
        </Grid>
        <Grid>
          <Box span={12}>
            <Skeleton className="h-[220px] w-full rounded-lg" />
          </Box>
        </Grid>
        <Grid>
          <Box span={6}>
            <Skeleton className="h-6 w-28" />
            <Skeleton className="mt-4 h-2 w-full" />
            <div className="mt-3 grid grid-cols-2 gap-4">
              <FigureBones />
              <FigureBones />
            </div>
          </Box>
          <Box span={6}>
            <LineBones lines={2} />
          </Box>
        </Grid>
        <TileBones count={3} cols="grid-cols-1 xl:grid-cols-3" />
      </Stack>
    </Busy>
  );
}

/** The header, the view tabs and the Overview body — what the route's own `loading.tsx` shows. */
export function BusinessHomeLoading() {
  return (
    <div>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div className="space-y-2.5">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-7 w-56" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-8 w-32" />
        </div>
      </div>
      <div className="mb-6 flex gap-6 border-b pb-3">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-20" />
      </div>
      <Stack>
        <OverviewCurrentSkeleton />
        <ZoneBones picker />
        <OverviewPerformanceSkeleton />
      </Stack>
    </div>
  );
}
