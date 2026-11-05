"use client";

import { Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/states";
import { pctFromBps } from "@/lib/format";
import { seriesValue } from "@/components/analytics/series-format";
import type { PaymentsSeriesKind } from "@/lib/api/analytics";

export interface BreakdownColumn {
  header: string;
  kind: PaymentsSeriesKind;
}

export interface BreakdownRow {
  key: string;
  label: string;
  /** One entry per column, each carrying this period and the previous period. */
  cells: Array<{ v: number; prev: number }>;
  share_bps: number;
}

/**
 * A dimension breakdown — failures by cause, volume by payment method, volume by
 * gateway. A table rather than a chart on purpose: these dimensions routinely
 * carry more classes than colour can separate, and a table is the form that stays
 * readable at eight gateways. The share column adds the one visual channel that
 * earns its space — a same-hue meter, so the eye finds the dominant row without
 * eight competing hues.
 *
 * Every cell shows BOTH periods because the API returns both, so the comparison
 * costs no extra request.
 */
export function BreakdownTable({
  title,
  dimensionHeader,
  columns,
  rows,
  currency,
  previousSpan,
  shareHeader = "Share",
  emptyTitle,
  emptyDescription,
  hint,
}: {
  title: string;
  dimensionHeader: string;
  columns: BreakdownColumn[];
  rows: BreakdownRow[];
  currency: string;
  /** The dates `prev` covers, as the caption names the current span. */
  previousSpan: string;
  shareHeader?: string;
  emptyTitle: string;
  emptyDescription?: string;
  hint?: string;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-foreground/80">{title}</h2>
        {hint ? (
          <span title={hint} className="text-muted-foreground">
            <Info className="size-3.5" aria-hidden />
            <span className="sr-only">{hint}</span>
          </span>
        ) : null}
      </div>
      <Card>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <EmptyState title={emptyTitle} description={emptyDescription} />
          ) : (
            <>
              <div className="w-full overflow-x-auto">
                <table className="w-full text-sm">
                  {/* Sentence-case heads, to match `ui/table`'s TableHead (settled 2026-09-09).
                      This is a hand-rolled table, so it does not inherit that decision — it set
                      `uppercase` itself, which is why this table and the intents list beside it
                      on /payment_intents showed two different conventions on one screen. */}
                  <thead>
                    <tr className="border-b">
                      <th
                        scope="col"
                        className="px-4 py-2.5 text-left text-xs font-medium tracking-wide text-muted-foreground"
                      >
                        {dimensionHeader}
                      </th>
                      {columns.map((c) => (
                        <th
                          key={c.header}
                          scope="col"
                          className="px-4 py-2.5 text-right text-xs font-medium tracking-wide text-muted-foreground"
                        >
                          {c.header}
                        </th>
                      ))}
                      <th
                        scope="col"
                        className="w-40 px-4 py-2.5 text-left text-xs font-medium tracking-wide text-muted-foreground"
                      >
                        {shareHeader}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key} className="border-b last:border-0">
                        <th scope="row" className="px-4 py-2.5 text-left font-normal">
                          {r.label}
                        </th>
                        {r.cells.map((cell, i) => {
                          const col = columns[i];
                          if (!col) return null;
                          return (
                            <td key={col.header} className="px-4 py-2.5 text-right align-top">
                              <div>{seriesValue(cell.v, col.kind, currency)}</div>
                              <div className="text-xs text-muted-foreground">
                                prev {seriesValue(cell.prev, col.kind, currency)}
                              </div>
                            </td>
                          );
                        })}
                        <td className="px-4 py-2.5 align-top">
                          <div className="flex items-center gap-2">
                            {/* Meter: the fill and its track are the same hue, so
                                the whole bar reads as one scale. */}
                            <div
                              className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-chart-1/15"
                              role="img"
                              aria-label={`${pctFromBps(r.share_bps, 1)} of the total`}
                            >
                              <div
                                className="h-full rounded-full bg-chart-1"
                                style={{
                                  width: `${Math.min(100, Math.max(0, r.share_bps / 100))}%`,
                                }}
                              />
                            </div>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {pctFromBps(r.share_bps, 1)}
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="border-t px-4 py-2 text-xs text-muted-foreground">
                Each figure is this period; <span className="font-medium">prev</span> is the same
                measure over {previousSpan}.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
