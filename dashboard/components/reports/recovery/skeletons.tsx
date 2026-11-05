import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Grid, Stack } from "@/components/analytics/layout";
import { Busy, PageHeaderBones } from "@/components/reports/skeletons";

/** The same span classes the page's figure tiles take. */
function TileBones({ span }: { span: "4" | "6" }) {
  return (
    <div
      className={
        (span === "4" ? "col-span-12 md:col-span-6 xl:col-span-4" : "col-span-12 xl:col-span-6") +
        " rounded-xl border bg-card p-6"
      }
    >
      <Skeleton className="h-3 w-28" />
      <Skeleton className="mt-2.5 h-7 w-24" />
      <Skeleton className="mt-2.5 h-3 w-full max-w-64" />
    </div>
  );
}

/** A header-strip card (`RecordCard`): title and meta over a hairline, then rows. */
function StripBones({
  rows,
  figures = false,
  className,
}: {
  rows: number;
  figures?: boolean;
  className?: string;
}) {
  return (
    <div className={"overflow-hidden rounded-xl border bg-card " + (className ?? "")}>
      <div className="flex items-center gap-3 border-b px-5 py-3.5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-16" />
        <Skeleton className="ml-auto h-3.5 w-16" />
      </div>
      <div className="px-5 py-4">
        {figures ? (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-6">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
            <Skeleton className="mt-6 h-2.5 w-full" />
          </>
        ) : null}
        <div className={figures ? "mt-4 space-y-3" : "space-y-3"}>
          {Array.from({ length: rows }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

function ZoneBones({ picker = false }: { picker?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <Skeleton className="size-4" />
      <Skeleton className="h-4.5 w-24" />
      {picker ? <Skeleton className="h-8 w-32" /> : null}
      <Skeleton className="h-3.5 w-32" />
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

export function RecoveryCurrentSkeleton() {
  return (
    <Busy label="recovery" className="flex flex-col gap-6">
      <ZoneBones />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <StripBones rows={1} figures />
        <StripBones rows={5} />
      </div>
      <StripBones rows={6} />
    </Busy>
  );
}

export function RecoveryPerformanceSkeleton() {
  return (
    <Busy label="recovery period" className="flex flex-col gap-6">
      <Grid>
        <TileBones span="6" />
        <TileBones span="6" />
      </Grid>
    </Busy>
  );
}

export function RecoveryLoading() {
  return (
    <div>
      <PageHeaderBones description actions={["w-36"]} />
      <Stack>
        <RecoveryCurrentSkeleton />
        <ZoneBones picker />
        <RecoveryPerformanceSkeleton />
      </Stack>
    </div>
  );
}
