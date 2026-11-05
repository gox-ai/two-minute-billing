import Link from "next/link";
import { Block } from "@/components/analytics/layout";
import type { SeriesPolarity } from "@/components/analytics/series-format";
import { pctFromBps } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface CompareRow {
  /** The business's public id — split keys are ids, so the row links to it. */
  key: string;
  label: string;
  /** The figure in the reported currency, formatted; null when it could not be converted. */
  value: string | null;
  /** Why `value` is null, in the operator's words. */
  valueNote?: string;
  /** The same business in each currency it actually bills, one entry per currency. */
  ownCurrency?: string[] | null;
  changeBps: number | null;
  shareBps: number | null;
}

/**
 * The split, as rows: the converted figure, what the business bills in, its movement and its
 * share of the whole — the same single answer the chart above is drawn from.
 *
 * A GRID, not the fixed-height `Row`/`Head` pair: a business billing three currencies needs
 * three lines, and in a 44px row they spilled into the rows around them. Columns size to their
 * content, so a long measure name in the head stays on one line instead of wrapping into cells.
 */
export function CompareTable({
  rows,
  valueHeader,
  showOwnCurrency,
  polarity = "up_good",
  exploreQuery,
}: {
  rows: CompareRow[];
  /** e.g. "MRR, INR" — the reported currency belongs in the column head, not in every cell. */
  valueHeader: string;
  showOwnCurrency: boolean;
  /** Whether a rise in this measure is good news — the change column's colour follows it. */
  polarity?: SeriesPolarity;
  /** `measure=…&range=…` — each row opens that business's Explore on the same question. */
  exploreQuery?: string;
}) {
  const cols = showOwnCurrency
    ? "grid-cols-[minmax(0,1fr)_max-content_max-content_max-content_max-content]"
    : "grid-cols-[minmax(0,1fr)_max-content_max-content_max-content]";
  const tone = (bps: number) => {
    if (bps === 0 || polarity === "neutral") return "text-muted-foreground";
    const good = polarity === "up_good" ? bps > 0 : bps < 0;
    return good ? "text-success" : "text-destructive";
  };

  return (
    <Block span={12} title="By business">
      {/* Rows are SUBGRIDS: each draws one full-width divider, while every row still shares
          the parent's content-sized columns. */}
      {/* Scrolls sideways inside the card on a narrow screen rather than spilling out. */}
      <div className="overflow-x-auto">
        <div className={cn("grid min-w-max gap-x-8 text-sm", cols)}>
          <div className="col-span-full grid grid-cols-subgrid border-b py-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground">
            <span>Business</span>
            <span className="text-right">{valueHeader}</span>
            {showOwnCurrency ? <span className="text-right">Billed in</span> : null}
            <span className="text-right">Change</span>
            <span className="text-right">Share</span>
          </div>
          {rows.map((r, i) => {
            const cell = "";
            return (
              <div
                key={r.key}
                className={cn(
                  "col-span-full grid grid-cols-subgrid items-start py-3",
                  i < rows.length - 1 && "border-b",
                )}
              >
                <Link
                  href={`/businesses/${r.key}/reports/explore${exploreQuery ? `?${exploreQuery}` : ""}`}
                  className={cn(cell, "min-w-0 truncate font-medium text-primary hover:underline")}
                >
                  {r.label}
                </Link>
                <span className={cn(cell, "text-right tabular-nums")}>
                  {r.value ?? <span className="text-warning">{r.valueNote ?? "—"}</span>}
                </span>
                {showOwnCurrency ? (
                  <span
                    className={cn(
                      cell,
                      "flex flex-col items-end text-muted-foreground tabular-nums",
                    )}
                  >
                    {r.ownCurrency && r.ownCurrency.length > 0
                      ? r.ownCurrency.map((c) => <span key={c}>{c}</span>)
                      : "—"}
                  </span>
                ) : null}
                <span className={cn(cell, "text-right tabular-nums")}>
                  {r.changeBps == null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span className={tone(r.changeBps)}>
                      {r.changeBps < 0 ? "−" : r.changeBps > 0 ? "+" : ""}
                      {pctFromBps(Math.abs(r.changeBps), 1)}
                    </span>
                  )}
                </span>
                <span className={cn(cell, "flex items-center justify-end gap-3")}>
                  {r.shareBps == null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <>
                      <span className="block h-1.5 w-24 rounded-full bg-muted" aria-hidden>
                        <span
                          className="block h-full rounded-full bg-chart-1"
                          style={{ width: `${Math.max(1.5, Math.min(100, r.shareBps / 100))}%` }}
                        />
                      </span>
                      <span className="w-12 text-right text-muted-foreground tabular-nums">
                        {pctFromBps(r.shareBps, 1)}
                      </span>
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </Block>
  );
}
