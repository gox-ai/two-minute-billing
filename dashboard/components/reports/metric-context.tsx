import { getReport } from "@/lib/api";
import { RecordCard } from "@/components/patterns/record-page";
import { cn } from "@/lib/utils";
import { BarList } from "@/components/analytics/home/parts";
import { Delta } from "@/components/analytics/delta";
import {
  reportPolarity,
  reportValue,
  type ReportPayload,
} from "@/components/reports/report-format";
import { GrowthBars } from "@/components/reports/growth-bars";
import { WaterfallTable } from "@/components/reports/report-shapes";

/**
 * The three things a metric page needs beyond its own chart: where the figure has BEEN,
 * what MOVED it, and which plans it sits in.
 *
 * ⚠️ EACH SECTION RENDERS ONLY WHERE THE REPORT SUPPORTS IT. A plans table on a report with
 * no `plan` dimension, or a movement breakout on a report that is not recurring revenue,
 * would be a heading over an empty box — and an empty box reads as "nothing happened"
 * rather than "this question does not apply here". The report's own declaration decides.
 *
 * Fetched in one parallel batch beside the report itself, so the page is not three
 * sequential round trips.
 */

/** Reports whose level a movement waterfall actually explains. */
const HAS_MOVEMENT = new Set(["total_mrr", "total_arr", "total_cmrr"]);

interface HistoryPoint {
  label: string;
  value: number | null;
  changeBps: number | null;
}

/**
 * The same figure 1, 3, 6 and 12 months ago, off one monthly series.
 *
 * ⚠️ NOT 24 MONTHS. The report API's longest range is 12, so a two-year comparison would
 * mean inventing a figure or quietly showing a one-year one under a two-year label. It is
 * left out until the range exists.
 */
function history(points: ReportPayload["points"]): HistoryPoint[] {
  const n = points.length;
  if (n < 2) return [];
  const now = points[n - 1]?.v ?? null;
  // The present leads the strip: every figure behind it is a comparison against THIS one,
  // and a row of past values with nothing to measure them against is a quiz.
  const current: HistoryPoint = { label: "Current", value: now, changeBps: null };
  return [current].concat(
    [1, 3, 6, 12]
      .filter((back) => n - 1 - back >= 0)
      .map((back) => {
        const then = points[n - 1 - back]!;
        const changeBps =
          now != null && then.v !== 0
            ? Math.round(((now - then.v) / Math.abs(then.v)) * 10000)
            : null;
        return { label: `${back} month${back === 1 ? "" : "s"} ago`, value: then.v, changeBps };
      }),
  );
}

export async function MetricContext({
  biz,
  report,
  currency,
}: {
  biz: string;
  report: ReportPayload;
  currency?: string;
}) {
  const wantsPlans = (report.dimensions ?? []).includes("plan");
  const wantsMovement = HAS_MOVEMENT.has(report.key);

  // A failure here loses a SECTION, never the page: the report above it is already
  // rendered and correct, and a metric page that 500s because its context could not load
  // is a worse answer than one without the context.
  const [plans, movement, longRun] = await Promise.all([
    wantsPlans
      ? (getReport(biz, report.key, { range: report.range, currency, groupBy: "plan" }).catch(
          () => null,
        ) as Promise<ReportPayload | null>)
      : Promise.resolve(null),
    wantsMovement
      ? (getReport(biz, "mrr_movement_summary", { range: "12m", currency }).catch(
          () => null,
        ) as Promise<ReportPayload | null>)
      : Promise.resolve(null),
    getReport(biz, report.key, { range: "12m", currency, granularity: "month" }).catch(
      () => null,
    ) as Promise<ReportPayload | null>,
  ]);

  const past = longRun ? history(longRun.points) : [];

  // A waterfall of nothing but zeros is this book saying "I have no movement ledger
  // for these months", not "nothing moved" — and rendered under a heading the reader
  // cannot tell the two apart. Suppress it; the chart above already states the level.
  const movementTable = movement?.table;
  const movementIsEmpty =
    !movementTable || movementTable.rows.every((r) => r.values.every((v) => v == null || v === 0));
  const planRows = (plans?.rows ?? []).slice(0, 12);
  const planTotal = planRows.reduce((sum, r) => sum + Math.abs(r.value ?? 0), 0);
  const table = movementIsEmpty ? null : movementTable;

  // Bars need at least two points to state a change; below that there is nothing to draw
  // and `GrowthBars` returns null on its own.
  const growth = (longRun?.points ?? []).map((p) => ({ label: p.label, v: p.v }));

  if (past.length <= 1 && planRows.length === 0 && !table && growth.length < 2) return null;

  // Columns follow the strip's length so none sits empty; two per row on a phone.
  // Two per row until xl: beside the rail a fifth of the row is narrower than a full
  // money figure. One row at xl, sized to the strip so no column sits empty.
  const stripCols =
    past.length >= 5
      ? "xl:grid-cols-5"
      : past.length === 4
        ? "xl:grid-cols-4"
        : past.length === 3
          ? "xl:grid-cols-3"
          : "";

  return (
    <>
      {/* Today first, then the same figure at each step back — side by side, at one size,
          because the comparison is between the figures. */}
      {past.length > 1 ? (
        <RecordCard title="Compared with earlier months" meta="change is from then to now" flush>
          {/* Row rules on every cell, clipped off the last row by the card; column rules
              only once the strip is one row. */}
          <dl className={cn("-mb-px grid grid-cols-2", stripCols)}>
            {past.map((p, i) => (
              <div
                key={p.label}
                className={cn(
                  "flex min-w-0 flex-col gap-1.5 border-b px-5 py-4",
                  i % 2 === 1 && "border-l",
                  i > 0 && "xl:border-l",
                )}
              >
                <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {p.label}
                </dt>
                <dd className="text-lg font-semibold wrap-anywhere tabular-nums">
                  {reportValue(p.value, report.kind, report.currency)}
                </dd>
                {/* No base, no percentage; the present compares against nothing. */}
                <dd className="text-sm">
                  {p.changeBps != null ? (
                    <Delta bps={p.changeBps} polarity={reportPolarity(report.key)} />
                  ) : (
                    <span className="text-muted-foreground">{i === 0 ? "now" : "—"}</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </RecordCard>
      ) : null}

      {growth.length >= 2 && longRun ? (
        <GrowthBars
          points={growth}
          kind={longRun.kind}
          currency={longRun.currency}
          polarity={reportPolarity(report.key)}
        />
      ) : null}

      {/*
        EVERY row, not a slice and not a scroll box: the payload does not say which end is
        newest, so a slice can quietly describe last year.
      */}
      {table ? (
        <RecordCard
          title="What moved it"
          meta={`${table.rows.length} periods`}
          flush
          footer={
            <span className="text-xs text-muted-foreground">
              The columns divide the movement. The opening value plus these columns equals the
              closing value.
            </span>
          }
        >
          <div className="[&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
            <WaterfallTable table={table} kind={movement!.kind} currency={movement!.currency} />
          </div>
        </RecordCard>
      ) : null}

      {planRows.length > 0 ? (
        <RecordCard
          title="By plan"
          meta={`${planRows.length} plan${planRows.length === 1 ? "" : "s"}`}
        >
          {/* Ranked bars when every plan adds to the figure; a signed breakdown (net growth
              can be negative) keeps the table, as a bar of a negative is not a share. */}
          {planRows.every((r) => (r.value ?? 0) >= 0) ? (
            <BarList
              rows={planRows.map((r) => ({
                key: r.group_id ?? r.group,
                label: r.group,
                total: r.value ?? 0,
              }))}
              format={(n) => reportValue(n, plans!.kind, plans!.currency)}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <tbody>
                  {planRows.map((r) => {
                    /* Share of the plans SHOWN (capped at twelve): a percentage of a hidden
                       total is a figure no one can check. */
                    const share = planTotal > 0 ? (r.value ?? 0) / planTotal : null;
                    return (
                      <tr key={r.group_id ?? r.group}>
                        <td className="border-b py-2 pr-2 text-sm">{r.group}</td>
                        <td className="w-32 border-b px-2 py-2">
                          {share != null ? (
                            <span className="block h-1.5 rounded-full bg-muted" aria-hidden>
                              <span
                                className="block h-full rounded-full bg-chart-1"
                                style={{ width: `${Math.max(share * 100, 1)}%` }}
                              />
                            </span>
                          ) : null}
                        </td>
                        <td className="w-16 border-b py-2 text-right text-sm text-muted-foreground tabular-nums">
                          {share != null ? `${(share * 100).toFixed(1)}%` : "—"}
                        </td>
                        <td className="border-b py-2 pl-2 text-right text-sm tabular-nums">
                          {reportValue(r.value, plans!.kind, plans!.currency)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </RecordCard>
      ) : null}
    </>
  );
}
