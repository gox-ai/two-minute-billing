"use client";

import Link from "next/link";
import { AreaChart } from "@/components/charts/area-chart";
import { EmptyState } from "@/components/states";
import { measureValue, chartKindFor } from "@/components/analytics/format";
import type { AnalyticsResult } from "@/lib/analytics-api";

/**
 * Where a split row's key genuinely goes, given what the engine documents it means —
 * `plan` keys are product ids, `business` keys are business ids. Everything else (and
 * the folded-in `other` row) has no real destination, so it renders as plain text
 * rather than a link that goes nowhere.
 */
function drillHref(dimension: string, key: string, biz: string): string | null {
  if (key === "other" || key === "unattributed") return null;
  if (dimension === "plan") return `/businesses/${biz}/catalog/products/${key}`;
  if (dimension === "business") return `/businesses/${key}/reports/explore`;
  return null;
}

/**
 * A dimension breakdown, rendered as rows (role `rows`) or as a dimension × period
 * matrix (role `hero`, when every row carries its own series). Same data either way
 * — `hero` just draws the per-period columns a `rows` table has no room for.
 */
export function SliceTable({
  result,
  biz,
  onRowClick,
}: {
  result: AnalyticsResult;
  biz: string;
  /** Explore passes this to drill INTO the row as a single-key trend, when the
   * dimension itself has no page of its own to link to (country, currency). */
  onRowClick?: (key: string) => void;
}) {
  const split = result.split;
  if (!split || split.series.length === 0) {
    return (
      <EmptyState
        title="Nothing to report yet"
        description="This split has no rows for the period shown."
      />
    );
  }
  const isMatrix = split.series.some((s) => s.points.length > 0);
  const periods = isMatrix ? result.series.map((p) => p.label) : [];

  return (
    <>
      <div className="-mx-5 overflow-x-auto px-5">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th
                scope="col"
                className="h-8 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
              >
                {split.dimension}
              </th>
              {isMatrix ? (
                periods.map((label) => (
                  <th
                    key={label}
                    scope="col"
                    className="h-8 w-30 text-right text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                  >
                    {label}
                  </th>
                ))
              ) : (
                <>
                  <th
                    scope="col"
                    className="h-8 w-30 text-right text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                  >
                    Total
                  </th>
                  <th
                    scope="col"
                    className="h-8 w-18 text-right text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                  >
                    Share
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {split.series.map((row) => {
              const href = drillHref(split.dimension, row.key, biz);
              const shareBps = result.total
                ? Math.round(((row.total ?? 0) / result.total) * 10_000)
                : null;
              const label = href ? (
                <Link href={href} className="text-primary hover:underline">
                  {row.label}
                </Link>
              ) : onRowClick && (row.kind ?? "dimension") === "dimension" ? (
                <button
                  type="button"
                  onClick={() => onRowClick(row.key)}
                  className="text-primary hover:underline"
                >
                  {row.label}
                </button>
              ) : (
                <span className={row.key === "other" ? "text-muted-foreground" : undefined}>
                  {row.label}
                </span>
              );
              return (
                <tr key={row.key} className="border-b last:border-0">
                  <th scope="row" className="h-11 truncate text-left font-normal">
                    {label}
                  </th>
                  {isMatrix ? (
                    row.points.map((p, i) => (
                      <td key={i} className="h-11 w-30 text-right tabular-nums">
                        {measureValue(p.value, result.unit, result.currency)}
                      </td>
                    ))
                  ) : (
                    <>
                      <td className="h-11 w-30 text-right tabular-nums">
                        {measureValue(row.total, result.unit, result.currency)}
                      </td>
                      <td className="h-11 w-18 text-right text-muted-foreground tabular-nums">
                        {shareBps == null ? "—" : `${(shareBps / 100).toFixed(1)}%`}
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {split.truncated ? (
        <p className="mt-4 border-t pt-3 text-xs text-muted-foreground tabular-nums">
          Showing the top {split.limit} of {split.returned}. The rest are combined in
          &quot;Other&quot;.
        </p>
      ) : null}
      {isMatrix ? (
        <div className="mt-4">
          {/* The total under the matrix. 110px flattened a twelve-month series into a
              sliver beneath a tall table — a chart worth drawing is worth reading. Two
              80px board rows, the same unit a tile is sized in. */}
          <AreaChart
            data={result.series.map((p) => ({
              label: p.label,
              value: (p.value ?? null) as unknown as number,
            }))}
            height={160}
            kind={chartKindFor(result.unit)}
            currency={result.currency ?? "USD"}
          />
        </div>
      ) : null}
    </>
  );
}
