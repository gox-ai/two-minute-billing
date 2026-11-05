import * as React from "react";
import { ChevronRight } from "lucide-react";
import { SeriesChart } from "@/components/charts/series-chart";
import { measurePolarity } from "@/components/analytics/series-format";
import { EmptyState } from "@/components/states";
import { BarRow, KPI_LABEL } from "@/components/analytics/layout";
import { RecordCard } from "@/components/patterns/record-page";
import { Chip } from "@/components/patterns/chip";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { measureValue, chartKindFor } from "@/components/analytics/format";
import type { AnalyticsResult } from "@/lib/analytics-api";
import { isReading, isRate, type ExploreQuery, type MeasureMeta } from "./query";
import { resultFor, type Answers } from "./answers";

/**
 * The result: one chart and one table, both answered by the same batch.
 *
 * Several measures are COLUMNS of that table and the chosen dimension is its rows — which is
 * the whole reason this beats a page per measure. Nothing here computes a figure the engine
 * did not publish: the total row is the engine's own `total`, so a distinct count comes back
 * null across a multi-period window rather than as a plausible sum of its buckets, and a rate
 * is the window's own arithmetic rather than the mean of its parts. Refusals and every other
 * warning are the page's Needs attention band, not this card's.
 */

interface Cell {
  value: number | null;
  denominator?: number | null;
}

interface ResultRow {
  key: string;
  label: string;
  cells: Cell[];
}

/** How a column's total was arrived at, stated rather than implied. */
function basisOf(m: MeasureMeta, r: AnalyticsResult | null): string {
  if (isReading(m)) {
    return "read at the instant it was computed. Earlier periods have no figure";
  }
  if (m.aggregate === "none") {
    return "a distinct count. Only a window of one period has a total, because a sum of buckets counts a returning account twice";
  }
  if (m.aggregate === "ratio") return "the window's own arithmetic, not the mean of its periods";
  if (r?.total_basis === "value_at_end") return "the value at the end of the window";
  return "every period in the window added up";
}

/** The rows, whichever way the table is cut. Period rows come from the series; dimension rows
 *  from each measure's split, keyed so a row missing from one column still reads. */
function buildRows(q: ExploreQuery, answers: Answers): ResultRow[] {
  const results = q.measures.map((m) => resultFor(answers, m.id));

  if (!q.dimension) {
    const spine = results.find((r) => (r?.series.length ?? 0) > 0)?.series ?? [];
    return spine.map((p, i) => ({
      key: p.t,
      label: p.label,
      cells: results.map((r) => {
        const point = r?.series.find((s) => s.t === p.t) ?? r?.series[i];
        return { value: point?.value ?? null, denominator: point?.denominator };
      }),
    }));
  }

  const order: string[] = [];
  const labels = new Map<string, string>();
  for (const r of results) {
    for (const s of r?.split?.series ?? []) {
      if (!labels.has(s.key)) {
        labels.set(s.key, s.label);
        order.push(s.key);
      }
    }
  }
  return order.map((key) => ({
    key,
    label: labels.get(key) ?? key,
    cells: results.map((r) => ({
      value: r?.split?.series.find((s) => s.key === key)?.total ?? null,
    })),
  }));
}

export function ExploreResult({
  query,
  answers,
  reportedIn,
  title,
  chip,
  rowsLabel,
  footer,
}: {
  query: ExploreQuery;
  answers: Answers;
  reportedIn: string | null;
  title: string;
  chip: string;
  /** The first column's heading: the dimension, or "Period". */
  rowsLabel: string;
  /** What was asked and how — the card's last line. */
  footer?: React.ReactNode;
}) {
  const { measures } = query;
  const results = measures.map((m) => resultFor(answers, m.id));
  const rows = buildRows(query, answers);

  // ONE measure is charted, and the title says which. A second series would either share an
  // axis with a different unit or need a second one, and a dual-axis chart is the single worst
  // chart mistake — the table underneath carries every column at full precision instead.
  const chartIndex = query.dimension
    ? measures.findIndex((m) => !isRate(m))
    : measures.findIndex((m) => !isReading(m));
  const chartMeasure = chartIndex >= 0 ? measures[chartIndex] : undefined;
  const chartResult = chartIndex >= 0 ? results[chartIndex] : undefined;

  const widest = chartMeasure
    ? Math.max(1, ...rows.map((r) => Math.abs(r.cells[chartIndex]?.value ?? 0)))
    : 1;

  const footnotes = measures.map((m, i) => {
    const r = results[i];
    return {
      id: m.id,
      name: m.name,
      basis: basisOf(m, r ?? null),
      // The engine's own sentence, attached to the measure it describes — never to the page,
      // where it sat under figures it said nothing about.
      coverage: r?.coverage?.note ?? null,
      truncated: r?.split?.truncated
        ? `top ${r.split.limit} rows, the rest combined in Other`
        : null,
      mismatch: rowSumMismatch(m, r ?? null, reportedIn),
    };
  });

  return (
    <RecordCard
      title={title}
      meta={<Chip>{chip}</Chip>}
      flush
      footer={
        footer ? <span className="text-xs text-muted-foreground tabular-nums">{footer}</span> : null
      }
    >
      {rows.length === 0 ? (
        <div className="px-5 py-4">
          <EmptyState
            title="Nothing in this window"
            description="No period in the window has a figure for these measures."
          />
        </div>
      ) : (
        <>
          {chartMeasure && chartResult ? (
            <div className="flex flex-col gap-3 px-5 pt-4 pb-5">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <span className={KPI_LABEL}>Charted</span>
                <span className="text-sm font-medium">{chartMeasure.name}</span>
                <span className="text-xs text-muted-foreground">
                  every measure is a column below
                </span>
              </div>
              {query.dimension ? (
                <div>
                  {rows.map((r, i) => (
                    <BarRow
                      key={r.key}
                      label={r.label}
                      fraction={Math.abs(r.cells[chartIndex]?.value ?? 0) / widest}
                      value={measureValue(
                        r.cells[chartIndex]?.value ?? null,
                        chartMeasure.unit,
                        reportedIn,
                      )}
                      last={i === rows.length - 1}
                    />
                  ))}
                </div>
              ) : (
                <SeriesChart
                  data={rows.map((r) => ({
                    // `null` is an unmeasured period, not a zero — the chart draws a break.
                    label: r.label,
                    value: r.cells[chartIndex]?.value ?? null,
                  }))}
                  flow={chartMeasure.kind === "flow" && chartMeasure.unit !== "ratio"}
                  polarity={measurePolarity(chartMeasure.id)}
                  seriesLabel={chartMeasure.name}
                  height={220}
                  kind={chartKindFor(chartMeasure.unit)}
                  currency={reportedIn ?? "USD"}
                />
              )}
            </div>
          ) : (
            <p className="px-5 py-4 text-sm text-muted-foreground">
              These measures do not show as a series. They are read at an instant and have no
              history.
            </p>
          )}

          <Table>
            <TableHeader className="bg-muted/40">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5">{rowsLabel}</TableHead>
                {measures.map((m) => (
                  <TableHead key={m.id} className="text-right last:pr-5" title={m.description}>
                    {m.name}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="pl-5">{r.label}</TableCell>
                  {measures.map((m, i) => (
                    <TableCell key={m.id} className="text-right tabular-nums last:pr-5">
                      {measureValue(
                        r.cells[i]?.value ?? null,
                        m.unit,
                        reportedIn,
                        r.cells[i]?.denominator,
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
            <TableFooter className="bg-transparent font-semibold">
              <TableRow className="border-b-0 hover:bg-transparent">
                <TableCell className="pl-5">Total</TableCell>
                {measures.map((m, i) => (
                  <TableCell key={m.id} className="text-right tabular-nums last:pr-5">
                    {measureValue(results[i]?.total ?? null, m.unit, reportedIn)}
                  </TableCell>
                ))}
              </TableRow>
            </TableFooter>
          </Table>

          <details className="group border-t">
            <summary className="flex cursor-pointer list-none items-center gap-2.5 px-5 py-3 text-sm font-medium hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
              <ChevronRight
                aria-hidden
                className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90"
              />
              How each total is read
              <Chip>{footnotes.length}</Chip>
            </summary>
            <div className="flex flex-col gap-1.5 px-5 pb-3.5 text-xs text-muted-foreground">
              {footnotes.map((f) => (
                <p key={f.id}>
                  <span className="font-medium text-foreground">{f.name}</span>: {f.basis}
                  {f.truncated ? ` · ${f.truncated}` : ""}
                  {f.mismatch ? ` · ${f.mismatch}` : ""}
                  {f.coverage ? ` · ${f.coverage}` : ""}
                </p>
              ))}
            </div>
          </details>
        </>
      )}
    </RecordCard>
  );
}

/**
 * Where the rows of an ADDITIVE column do not add to the window total the engine published.
 *
 * Both figures are the engine's; neither is replaced. Saying nothing would leave a total row
 * reading smaller than every row above it, which looks like this table's arithmetic and is
 * not. A distinct count and a ratio are exempt — their rows never add to their total by
 * design — and so is a truncated split, where the remainder is already stated.
 */
function rowSumMismatch(
  m: MeasureMeta,
  r: AnalyticsResult | null,
  currency: string | null,
): string | null {
  if (!r?.split || r.split.truncated) return null;
  if (m.aggregate !== "sum" && m.aggregate !== "last") return null;
  if (r.total == null) return null;
  const rows = r.split.series;
  if (rows.some((s) => s.total == null)) return null;
  const sum = rows.reduce((a, s) => a + (s.total ?? 0), 0);
  if (Math.abs(sum - r.total) <= 1) return null;
  return `the rows add to ${measureValue(sum, m.unit, currency)}, which is not the window total beside them`;
}
