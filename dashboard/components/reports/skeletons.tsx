import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Bones shared by the Reports pages' route skeletons: the page opener and its control row. */

/** `PageHeader`'s own shape: crumb, title, optional description, optional actions. */
export function PageHeaderBones({
  description = false,
  actions = [],
  className,
}: {
  description?: boolean;
  /** One width class per action on the header's right. */
  actions?: string[];
  className?: string;
}) {
  return (
    <div className={cn("mb-8 space-y-2.5", className)}>
      <Skeleton className="h-3 w-24" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          {description ? <Skeleton className="h-3.5 w-full max-w-96" /> : null}
        </div>
        {actions.length > 0 ? (
          <div className="flex shrink-0 gap-2">
            {actions.map((w, i) => (
              <Skeleton key={i} className={cn("h-8", w)} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A row of 32px controls, one width class each. */
export function ControlRowBones({ widths, className }: { widths: string[]; className?: string }) {
  return (
    <div className={cn("mb-6 flex flex-wrap items-center gap-3", className)}>
      {widths.map((w, i) => (
        <Skeleton key={i} className={cn("h-8", w)} />
      ))}
    </div>
  );
}

export function Busy({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div aria-busy="true" aria-label={`Loading ${label}`} className={className}>
      {children}
    </div>
  );
}

/** A table on its own card, as `Table` inside `rounded-xl border bg-card` renders it. */
export function TableCardBones({
  rows = 6,
  cols = 5,
  footer = false,
  className,
}: {
  rows?: number;
  cols?: number;
  footer?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("overflow-hidden rounded-xl border bg-card", className)}>
      <div className="flex gap-6 border-b px-4 py-3">
        {Array.from({ length: cols }).map((_, c) => (
          <Skeleton key={c} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-6 border-b px-4 py-3.5 last:border-0">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-3.5 flex-1" />
          ))}
        </div>
      ))}
      {footer ? (
        <div className="flex justify-between gap-4 border-t px-4 py-3">
          <Skeleton className="h-3 w-72" />
          <Skeleton className="h-3 w-16" />
        </div>
      ) : null}
    </div>
  );
}

/** A figure card: tracked label, 26px value, qualifier. */
export function FigureCardBones({ className }: { className?: string }) {
  return (
    <div className={cn("rounded-xl border bg-card p-6", className)}>
      <Skeleton className="h-3 w-28" />
      <Skeleton className="mt-2.5 h-7 w-24" />
      <Skeleton className="mt-2.5 h-3 w-full max-w-64" />
    </div>
  );
}

/** A report's headline figure, its window chip and (optionally) its 300px chart. */
export function ReportFigureBones({ chart = true }: { chart?: boolean }) {
  return (
    <Busy label="report">
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-6 w-36" />
      </div>
      {chart ? <Skeleton className="mt-5 h-[300px] w-full rounded-lg" /> : null}
    </Busy>
  );
}

/** A header-strip card (title, meta) over table rows. */
export function ReportCardBones({ rows = 6 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card" aria-hidden>
      <div className="flex items-center gap-3 border-b px-5 py-3.5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-16" />
      </div>
      <div className="flex gap-6 border-b px-5 py-3">
        <Skeleton className="h-3 flex-1" />
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-32" />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-6 border-b px-5 py-3.5 last:border-0">
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3.5 w-32" />
        </div>
      ))}
    </div>
  );
}

/**
 * Route skeleton for one stat. Two top-level elements, header then body, like the page —
 * the stats layout places them beside its rail.
 */
export function StatLoading() {
  return (
    <>
      <PageHeaderBones description actions={["w-16", "w-36"]} className="mb-0" />
      <Busy label="report" className="flex min-w-0 flex-col gap-5">
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-wrap gap-x-6 gap-y-3 border-b bg-muted/40 px-5 py-3">
            <Skeleton className="h-8 w-full max-w-80" />
            <Skeleton className="h-8 w-full max-w-60" />
          </div>
          <div className="px-5 py-5">
            <div className="flex flex-wrap items-center gap-3">
              <Skeleton className="h-9 w-40" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-6 w-36" />
            </div>
            <Skeleton className="mt-5 h-[300px] w-full rounded-lg" />
          </div>
          <div className="border-t px-5 py-3">
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
        </div>
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center gap-3 border-b px-5 py-3.5">
            <Skeleton className="h-4 w-48" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-2 px-5 py-4">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-6 w-20" />
                <Skeleton className="h-3.5 w-12" />
              </div>
            ))}
          </div>
        </div>
      </Busy>
    </>
  );
}

/**
 * Route skeleton for the stats library: header, then the "Find a stat" card and two family
 * cards. Two top-level elements, like the page.
 */
export function StatsLibraryLoading() {
  return (
    <>
      <PageHeaderBones description actions={["w-28"]} className="mb-0" />
      <Busy label="stats" className="flex min-w-0 flex-col gap-5">
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-wrap items-center gap-3 px-5 py-4">
            <Skeleton className="h-9 w-full sm:w-72" />
            <Skeleton className="h-8 w-full max-w-md" />
          </div>
          <div className="flex flex-wrap gap-6 border-t bg-muted/40 px-5 py-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-56 max-w-full" />
            ))}
          </div>
        </div>
        {[6, 5].map((rows, s) => (
          <div key={s} className="overflow-hidden rounded-xl border bg-card">
            <div className="flex items-center gap-3 border-b px-5 py-3.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-8" />
            </div>
            {Array.from({ length: rows }).map((_, i) => (
              <div key={i} className="flex h-11 items-center gap-4 border-b px-5 last:border-0">
                <Skeleton className="h-3.5 w-1/4" />
                <Skeleton className="hidden h-3 flex-1 md:block" />
                <Skeleton className="h-5 w-16" />
              </div>
            ))}
          </div>
        ))}
      </Busy>
    </>
  );
}
