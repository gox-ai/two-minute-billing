import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ROW_UNIT_PX, spanClass, type TileUnits } from "@/components/analytics/board/span";
import { Busy, PageHeaderBones } from "@/components/reports/skeletons";

/** A board of a typical first dashboard: a wide trend, two figures, a wide table. */
const GENERIC: TileUnits[] = [
  { width: 6, height: 4 },
  { width: 3, height: 2 },
  { width: 3, height: 2 },
  { width: 12, height: 4 },
];

/**
 * `BoardGrid`'s grid with `TileCard`'s anatomy. Pass the open board's tile units and the shimmer
 * lands where each tile will; without them it draws a generic board.
 */
export function BoardSkeleton({ tiles = GENERIC }: { tiles?: TileUnits[] }) {
  return (
    <Busy label="dashboard">
      <div className="grid grid-cols-1 gap-5 md:grid-cols-6 xl:grid-cols-12">
        {tiles.map((u, i) => (
          <div
            key={i}
            className={"flex min-w-0 flex-col rounded-xl border bg-card " + spanClass(u.width)}
            style={{ minHeight: u.height * ROW_UNIT_PX }}
          >
            <div className="flex items-start justify-between gap-2 border-b px-5 py-3.5">
              <div className="space-y-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-3 w-12" />
            </div>
            <div className="flex flex-1 flex-col px-5 py-4">
              <Skeleton className="h-6 w-24" />
              {u.height > 2 ? <Skeleton className="mt-4 w-full flex-1 rounded-lg" /> : null}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex justify-between gap-4">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-3 w-40" />
      </div>
    </Busy>
  );
}

/** Route skeleton: header, the dashboard tabs, the period / grain / actions row, then the board. */
export function DashboardsLoading() {
  return (
    <div>
      <PageHeaderBones description actions={["w-24", "w-12", "w-28"]} />
      <div className="mb-5 flex h-11 items-center gap-5 border-b">
        {["w-32", "w-28", "w-24", "w-28"].map((w, i) => (
          <Skeleton key={i} className={"h-3.5 " + w} />
        ))}
        <Skeleton className="ml-auto hidden h-3.5 w-28 sm:block" />
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-8 w-64" />
        <div className="ml-auto flex flex-wrap gap-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-28" />
        </div>
      </div>
      <BoardSkeleton />
    </div>
  );
}
