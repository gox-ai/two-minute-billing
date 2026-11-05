"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { money, moneyCompact } from "@/lib/format";
import {
  reportValue,
  type BreakdownRow,
  type ReportPayload,
} from "@/components/reports/report-format";

/**
 * A sortable column head.
 *
 * Sorting is client-side and deliberately so: a report answer arrives whole — twelve
 * periods, a dozen buckets, a cohort grid — so re-asking the engine for the same numbers in
 * another order would be a round trip to rearrange rows already in the browser.
 *
 * Three states, not two: the third is the order the payload arrived in, which is itself an
 * answer (a breakdown comes back largest-first, a waterfall newest-first). A two-state sort
 * would make that order unreachable once you clicked.
 */
type Sort = { col: string; dir: "asc" | "desc" } | null;

function SortHead({
  col,
  sort,
  onSort,
  align = "left",
  className = "",
  children,
}: {
  col: string;
  sort: Sort;
  onSort: (col: string) => void;
  align?: "left" | "right";
  className?: string;
  children: React.ReactNode;
}) {
  const active = sort?.col === col;
  const Icon = !active ? ChevronsUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(col)}
        aria-label={`Sort by ${typeof children === "string" ? children : col}`}
        className={
          "touch-target relative -mx-1 flex w-full items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-foreground " +
          (align === "right" ? "justify-end" : "") +
          (active ? " text-foreground" : "")
        }
      >
        {align === "right" ? null : <span>{children}</span>}
        <Icon className={"size-3 " + (active ? "" : "opacity-40")} />
        {align === "right" ? <span>{children}</span> : null}
      </button>
    </TableHead>
  );
}

/** Cycles a column through descending → ascending → the payload's own order. */
function useSort() {
  const [sort, setSort] = React.useState<Sort>(null);
  const onSort = (col: string) =>
    setSort((s) =>
      s?.col !== col ? { col, dir: "desc" } : s.dir === "desc" ? { col, dir: "asc" } : null,
    );
  return { sort, onSort };
}

/**
 * Order by a key, keeping nulls last in BOTH directions.
 *
 * A null is "this period has not happened", not a small number — floating those to the top
 * of an ascending sort would bury the rows that have figures under the rows that cannot.
 */
function sorted<T>(rows: T[], sort: Sort, key: (r: T) => number | string | null): T[] {
  if (!sort) return rows;
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "string" || typeof y === "string")
      return String(x).localeCompare(String(y)) * dir;
    return (x - y) * dir;
  });
}

/**
 * A cohort grid: intake period down, periods-since across.
 *
 * Cells are a share of the cohort's opening figure, shaded so the decay is legible without
 * reading every number. The shade is the brand hue at low alpha and caps well short of
 * solid, because a cell dark enough to need white text is a cell whose figure you cannot
 * read. A null is an em-dash — the period has not happened, which is not 0.
 *
 * Every column sorts, including a single period-since: "which intake was still here at M3"
 * is the question a cohort table is opened to answer, and reading it down a column by eye
 * is what it replaces.
 */
export function CohortGrid({
  matrix,
  currency,
}: {
  matrix: NonNullable<ReportPayload["matrix"]>;
  currency: string;
}) {
  const { sort, onSort } = useSort();

  // Fixed ladder rather than an interpolated alpha: an arbitrary `bg-primary/[37%]` is a
  // value Tailwind has to generate per cell, and six steps read as six steps.
  //
  // ⚠️ The steps are BUNCHED AT THE TOP because that is where retention lives. Spread
  // evenly from 0 they gave the whole 75–100% band two shades, so a healthy cohort and a
  // quietly decaying one painted the same and the diagonal — the thing the grid exists to
  // show — was invisible. Nothing above the top step: a cohort that expanded past 100% is
  // real, and capping the shade is the only clamping this renderer does.
  const shade = (bps: number) => {
    if (bps >= 9500) return "bg-primary/30";
    if (bps >= 8500) return "bg-primary/25";
    if (bps >= 7500) return "bg-primary/20";
    if (bps >= 6000) return "bg-primary/15";
    if (bps >= 4000) return "bg-primary/10";
    if (bps > 0) return "bg-primary/5";
    return "";
  };

  const rows = sorted(matrix.rows, sort, (r) =>
    sort?.col === "group"
      ? r.group
      : sort?.col === "base"
        ? r.base
        : (r.values[Number(sort?.col ?? -1)] ?? null),
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortHead
            col="group"
            sort={sort}
            onSort={onSort}
            className="sticky left-0 z-20 bg-card whitespace-nowrap"
          >
            Cohort
          </SortHead>
          <SortHead
            col="base"
            sort={sort}
            onSort={onSort}
            align="right"
            className="text-right whitespace-nowrap"
          >
            Starting
          </SortHead>
          {matrix.columns.map((c, i) => (
            <SortHead
              key={c}
              col={String(i)}
              sort={sort}
              onSort={onSort}
              align="right"
              className="px-2 text-right whitespace-nowrap"
            >
              {c}
            </SortHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.group}>
            <TableCell className="sticky left-0 z-10 bg-card font-medium whitespace-nowrap">
              {r.group}
            </TableCell>
            {/* Compact, with the exact figure on hover — twelve offset columns plus an
                opening like `$98,450.08` measured 946px in a 908px pane, and the column
                that fell off the end was M11, the deepest retention the grid has. */}
            <TableCell
              className="text-right tabular-nums"
              title={
                matrix.base_kind === "money" ? money(r.base, currency) : r.base.toLocaleString("en")
              }
            >
              {matrix.base_kind === "money"
                ? moneyCompact(r.base, currency)
                : r.base.toLocaleString("en")}
            </TableCell>
            {r.values.map((v, i) => (
              <TableCell
                key={i}
                // Whole percents fit twelve columns; the tenth is on hover, so a cell
                // reading 100% can be told from one that is 99.6% and rounded up.
                title={
                  v == null
                    ? "Not measured. This month has not started."
                    : `${(v / 100).toFixed(1)}%`
                }
                className={
                  "px-2 text-right tabular-nums " +
                  (v == null ? "text-muted-foreground/60" : shade(v))
                }
              >
                {v == null ? "—" : `${(v / 100).toFixed(0)}%`}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * A breakdown: one row per group, with each group's share of the total.
 *
 * The share is drawn as well as stated, because the question a breakdown answers is "which
 * of these matters" and a column of numbers makes that a subtraction exercise. Shares are
 * computed from the POSITIVE total only: a table mixing signs has no meaningful
 * denominator, so it gets no bars rather than misleading ones.
 *
 * A group links onward only when the caller resolved a destination for it (see
 * `breakdownLinks`). A figure that looks clickable and goes nowhere is worse than plain
 * text, and a row with no single filter value — "No plan", "Unknown" — has no honest
 * destination at all.
 */
export function BreakdownTable({
  rows,
  kind,
  currency,
  groupLabel,
  valueLabel,
  funnel = false,
}: {
  rows: BreakdownRow[];
  kind: ReportPayload["kind"];
  currency: string;
  groupLabel: string;
  valueLabel: string;
  /** Nested steps: each share is of the first row, since the sum counts a buyer five times. */
  funnel?: boolean;
}) {
  const { sort, onSort } = useSort();
  const signed = rows.some((r) => r.value < 0) && rows.some((r) => r.value > 0);
  const total = funnel
    ? Math.abs(rows[0]?.value ?? 0)
    : rows.reduce((a, r) => a + Math.abs(r.value), 0);
  const shareOf = (v: number) => (total > 0 ? Math.abs(v) / total : 0);
  // Share and value order identically, so the share head sorts the value rather than
  // pretending to be a column of its own.
  const ordered = sorted(rows, sort, (r) => (sort?.col === "group" ? r.group : r.value));

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortHead col="group" sort={sort} onSort={onSort} className="whitespace-nowrap">
            {groupLabel}
          </SortHead>
          <SortHead
            col="value"
            sort={sort}
            onSort={onSort}
            align="right"
            className="text-right whitespace-nowrap"
          >
            {valueLabel}
          </SortHead>
          {signed ? null : (
            <SortHead
              col="value"
              sort={sort}
              onSort={onSort}
              align="right"
              className="w-40 text-right"
            >
              {funnel && rows[0] ? `Of ${rows[0].group.toLowerCase()}` : "Share"}
            </SortHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {ordered.map((r) => (
          <TableRow key={r.group_id ?? r.group}>
            <TableCell className="font-medium">
              {r.href ? (
                <Link href={r.href} className="text-primary hover:underline">
                  {r.group}
                </Link>
              ) : (
                r.group
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {reportValue(r.value, kind, currency)}
            </TableCell>
            {signed ? null : (
              <TableCell>
                <div className="flex items-center justify-end gap-2">
                  <div className="h-1.5 w-24 overflow-hidden rounded-md bg-muted">
                    <div
                      className="anim-grow h-full rounded-md bg-primary"
                      style={{ width: `${(shareOf(r.value) * 100).toFixed(1)}%` }}
                    />
                  </div>
                  <span className="w-10 text-right text-xs text-muted-foreground tabular-nums">
                    {`${(shareOf(r.value) * 100).toFixed(0)}%`}
                  </span>
                </div>
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * A waterfall: one row per period, opening and closing as STOCKS with what moved between
 * them in the middle.
 *
 * The columns reconcile across the row — that is the entire point of the shape and the
 * reason it is not seven separate charts — so the two stock columns are marked as a
 * different kind of number from the movement they bracket: they sit in a well, they are
 * emphasised, and they are ruled off from the movement columns. A zero movement is a dash,
 * because a grid of emphatic zeros hides the month that actually moved.
 *
 * Columns come from the payload, never from a list here: when the engine splits upgrade
 * from expansion, or resumed from reactivation, those columns appear with no change on this
 * side. Only the two things that cannot be read off a number are named below — which keys
 * are stocks, and which are subtractions.
 *
 * ⚠️ A loss arrives as a MAGNITUDE, not as a negative number: the payload reports churn as
 * $40,292.80, and only the net column is signed. So the direction cannot be read off the
 * sign — the column says it. Losses are rendered as the subtractions they are, which is
 * also what makes the row visibly add up: opening + new − churn = closing.
 *
 * Money is COMPACT here, and that is a width decision rather than a taste one: nine columns
 * of `$770,492.43` measured 961px against the 860px this panel gets at a 1600px viewport, so
 * the closing figure — the one the row exists to reach — sat off the right edge behind a
 * scrollbar. Each cell carries the exact figure as its title, and the CSV is exact.
 *
 * The column set widened to fourteen the moment the engine split upgrade, resumed and
 * paused out, and no amount of formatting fits that in 860px. So the two ends of the
 * sentence are PINNED: the period on the left and the closing figure on the right stay put
 * while the movement scrolls between them — a row you can still read after scrolling is
 * worth more than one that fits by hiding its conclusion. Below md the pins are off: on a
 * phone they would leave a sliver for the columns between them. A pinned cell paints the card's
 * own ground, fully opaque: the half-strength well the other stock column wears would let
 * the movement columns show through it as they scroll underneath.
 */
const STOCKS = new Set(["opening", "closing"]);
const SUBTRACTS = new Set(["churn", "contraction", "cancellation", "downgrade", "paused", "pause"]);

export function WaterfallTable({
  table,
  kind,
  currency,
}: {
  table: NonNullable<ReportPayload["table"]>;
  kind: ReportPayload["kind"];
  currency: string;
}) {
  const { sort, onSort } = useSort();
  const exact = (v: number) =>
    kind === "money" ? money(v, currency) : reportValue(v, kind, currency);
  const compact = (v: number) =>
    kind === "money" ? moneyCompact(v, currency) : reportValue(v, kind, currency);

  const rows = sorted(table.rows, sort, (r) =>
    sort?.col === "period" ? r.period : (r.values[Number(sort?.col ?? -1)] ?? null),
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {/* Period and Closing are PINNED. With every movement split out, the table is
              wider than the pane, and the column the row exists to reach — Closing — sat
              behind a horizontal scroll (measured: 1429px of table in an 860px pane). The
              anchor and the answer stay put; the movements between them scroll.
              A pinned cell must paint an OPAQUE ground or the scrolling columns show
              through it. `bg-muted` rather than `bg-card` so Closing still reads as the
              same kind of thing as Opening — both are the book's level, and a pinned column
              that changed colour would look like a different measure. */}
          <SortHead
            col="period"
            sort={sort}
            onSort={onSort}
            className="z-20 bg-card whitespace-nowrap md:sticky md:left-0"
          >
            Period
          </SortHead>
          {table.columns.map((c, i) => (
            <SortHead
              key={c.key}
              col={String(i)}
              sort={sort}
              onSort={onSort}
              align="right"
              className={
                "text-right whitespace-nowrap " +
                (c.key === "closing"
                  ? "md:sticky md:right-0 z-20 bg-muted border-l "
                  : STOCKS.has(c.key)
                    ? "bg-muted/50 "
                    : "") +
                (i === 1 ? " border-l" : "")
              }
            >
              {c.label}
            </SortHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.period}>
            <TableCell className="z-10 bg-card font-medium whitespace-nowrap md:sticky md:left-0">
              {r.period}
            </TableCell>
            {r.values.map((v, i) => {
              const col = table.columns[i];
              const key = col?.key ?? String(i);
              const stock = STOCKS.has(key);
              const loss = SUBTRACTS.has(key) ? v !== 0 : v < 0;
              const tone = stock
                ? "font-medium"
                : v === 0
                  ? "text-muted-foreground"
                  : loss
                    ? "text-destructive"
                    : "text-foreground";
              return (
                <TableCell
                  key={key}
                  title={exact(v)}
                  className={
                    "text-right tabular-nums " +
                    tone +
                    (key === "closing"
                      ? " md:sticky md:right-0 z-10 bg-muted border-l"
                      : stock
                        ? " bg-muted/50"
                        : "") +
                    (i === 1 ? " border-l" : "")
                  }
                >
                  {/* A movement of exactly nothing is stated as a dash: "0" and "no
                      movement" look the same in a column of figures, and the dash is the
                      one you can skim past. */}
                  {!stock && v === 0
                    ? "—"
                    : SUBTRACTS.has(key) && v > 0
                      ? `−${compact(v)}`
                      : compact(v)}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
