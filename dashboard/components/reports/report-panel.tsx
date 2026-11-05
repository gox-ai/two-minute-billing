import * as React from "react";
import { BarChart3, CalendarRange, Table2 } from "lucide-react";
import { RecordCard } from "@/components/patterns/record-page";
import { PendingContent } from "@/components/navigation/nav-pending";
import { PendingLink } from "@/components/reports/pending-link";
import { ReportCardBones, ReportFigureBones } from "@/components/reports/skeletons";
import { EmptyState } from "@/components/states";
import { SeriesChart } from "@/components/charts/series-chart";
import { fmtDateTime, type AnalyticsRange } from "@/lib/api";
import { Delta } from "@/components/analytics/delta";
import {
  breakdownLinks,
  coverageLabel,
  dimensionLabel,
  reportHeadline,
  reportIsEmpty,
  reportPolarity,
  seriesChangeBps,
  type ReportPayload,
} from "@/components/reports/report-format";
import { BreakdownTable, CohortGrid, WaterfallTable } from "@/components/reports/report-shapes";

export const REPORT_RANGES: AnalyticsRange[] = ["daily", "3m", "6m", "12m"];
const RANGE_LABEL: Record<AnalyticsRange, string> = {
  daily: "Daily",
  "3m": "3 months",
  "6m": "6 months",
  "12m": "12 months",
};

/**
 * How finely the series is cut, which is a different question from how far back it reaches.
 * The options come from the payload, never from this list — a report with no series to
 * re-cut sends none and the control is not rendered at all.
 */
const GRANULARITY_LABEL: Record<string, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

/** A segmented control as links, so the URL stays the state. Wraps on a narrow screen. */
function Segments({
  label,
  items,
  current,
  hrefFor,
  icons,
}: {
  label: string;
  items: Array<{ id: string; label: string }>;
  current: string;
  hrefFor: (id: string) => string;
  icons?: Record<string, React.ReactNode>;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div
        role="group"
        aria-label={label}
        className="flex min-w-0 flex-wrap items-center rounded-md border bg-card p-0.5"
      >
        {items.map((it) => {
          const on = it.id === current;
          return (
            <PendingLink
              key={it.id}
              href={hrefFor(it.id)}
              source="report-toolbar"
              icon={icons?.[it.id]}
              aria-current={on ? "true" : undefined}
              className={
                "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors sm:h-7 " +
                (on
                  ? "bg-primary/10 font-semibold text-primary"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {it.label}
            </PendingLink>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One report, rendered from its answer alone.
 *
 * This component knows nothing about which report it is showing: the envelope carries the
 * name, the unit, the shape and the dimensions, so a report added to the registry tomorrow
 * renders here without a line of code. That is the return on declaring reports as data,
 * and it holds only while this refuses to special-case a key.
 *
 * Links come in as a function so the route owns its URL shape. The page header carries the
 * title, description and CSV; this is the answer card plus the grids that belong to it.
 */
export function ReportPanel({
  report,
  biz,
  hrefFor,
  groupBy,
  view,
  tz,
}: {
  report: ReportPayload;
  biz: string;
  /** `{range}` / `{group_by}` / `{view}` overrides → a URL for this route. `''` clears a key. */
  hrefFor: (over: Record<string, string>) => string;
  groupBy: string | null;
  /** `chart` or `table`, from the URL; ignored unless the report has both. */
  view: string | null;
  tz: string | null;
}) {
  const dimensions = report.dimensions ?? [];
  const granularities = report.granularities ?? [];
  const hasSeries = report.points.length > 0;
  const breakdown = report.rows && report.rows.length > 0 ? report.rows : null;
  const empty = reportIsEmpty(report);
  const coverage = coverageLabel(report);
  // Off the very points the chart draws, so the number and the shape cannot disagree.
  const changeBps = seriesChangeBps(report.points);

  /*
    Chart or table, offered ONLY when both exist. Asking for a breakdown is asking for the
    rows, so `group_by` lands on the table; without one the trend is the answer.
  */
  const canSwitch = hasSeries && breakdown != null;
  const mode: "chart" | "table" = !canSwitch
    ? "chart"
    : view === "chart" || view === "table"
      ? view
      : groupBy
        ? "table"
        : "chart";
  const showChart = hasSeries && (!canSwitch || mode === "chart");
  const showBreakdown = breakdown != null && (!canSwitch || mode === "table");

  // Only the controls this report answers to; one the engine would refuse does nothing.
  const controls = (
    <>
      {hasSeries ? (
        <Segments
          label="Period"
          items={REPORT_RANGES.map((r) => ({ id: r, label: RANGE_LABEL[r] }))}
          current={report.range}
          hrefFor={(id) => hrefFor({ range: id })}
        />
      ) : null}
      {/* "The last three months, by day" — offered only where the payload says the engine
          honours it. */}
      {hasSeries && granularities.length > 1 ? (
        <Segments
          label="Cut by"
          items={granularities.map((g) => ({ id: g, label: GRANULARITY_LABEL[g] ?? g }))}
          current={report.granularity}
          hrefFor={(id) => hrefFor({ granularity: id })}
        />
      ) : null}
      {dimensions.length > 0 ? (
        <Segments
          label="Split by"
          items={[
            { id: "", label: "None" },
            ...dimensions.map((d) => ({ id: d, label: dimensionLabel(d) })),
          ]}
          current={groupBy ?? ""}
          hrefFor={(id) => hrefFor({ group_by: id })}
        />
      ) : null}
      {canSwitch ? (
        <Segments
          label="Show as"
          items={[
            { id: "chart", label: "Chart" },
            { id: "table", label: "Table" },
          ]}
          current={mode}
          hrefFor={(id) => hrefFor({ view: id })}
          icons={{
            chart: <BarChart3 className="size-3.5" />,
            table: <Table2 className="size-3.5" />,
          }}
        />
      ) : null}
    </>
  );
  const hasControls = hasSeries || dimensions.length > 0;

  const asOf = (
    <span className="text-xs text-muted-foreground tabular-nums">
      As of {fmtDateTime(report.as_of, tz)} ·{" "}
      {report.converted
        ? `money converted into ${report.currency} at the rates in Settings → Currencies`
        : `all figures in ${report.currency}`}
    </span>
  );
  // The as-of line closes the LAST card of the answer, so it reads under everything it covers.
  const hasGrids = !!report.table || !!report.matrix || (showBreakdown && breakdown != null);
  const lastGrid =
    showBreakdown && breakdown
      ? "breakdown"
      : report.matrix
        ? "matrix"
        : report.table
          ? "table"
          : null;

  // Edge-to-edge tables get the card's own 20px gutter on their outer columns.
  const flushTable =
    "[&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5";

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section
        aria-label={report.name}
        className="anim-rise flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card"
      >
        {hasControls ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b bg-muted/40 px-5 py-3">
            {controls}
          </div>
        ) : null}

        <div className="min-w-0 px-5 py-5">
          <PendingContent skeleton={<ReportFigureBones chart={showChart || empty} />}>
            {empty ? (
              <EmptyState
                title="Nothing to report yet"
                description="This report has no figures for the selected period. Figures show when this business has activity that the report measures."
              />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="text-3xl font-semibold tabular-nums">
                    {reportHeadline(report)}
                  </span>
                  {/* Tone is direction × polarity, so a rise in churn never reads as a win. */}
                  {changeBps != null ? (
                    <span className="flex items-center gap-1.5">
                      <Delta bps={changeBps} polarity={reportPolarity(report.key)} size="md" />
                      <span className="text-sm text-muted-foreground">in this period</span>
                    </span>
                  ) : null}
                  {/* Some reports quote the last COMPLETE period rather than the range, so the
                      window travels beside the number. */}
                  {coverage ? (
                    <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground tabular-nums">
                      <CalendarRange className="size-3.5" aria-hidden />
                      {coverage}
                    </span>
                  ) : null}
                  {report.matrix ? (
                    <span className="text-sm text-muted-foreground">
                      Latest cohort&apos;s starting size
                    </span>
                  ) : null}
                </div>

                {/* A derived rate has no series; an empty chart would imply a flat one. */}
                {showChart ? (
                  <div className="mt-5 min-w-0">
                    <SeriesChart
                      height={300}
                      flow={report.shape === "flow" && report.kind !== "ratio"}
                      polarity={reportPolarity(report.key)}
                      seriesLabel={report.name}
                      data={report.points.map((p) => ({ label: p.label, value: p.v }))}
                      kind={
                        report.kind === "money"
                          ? "money"
                          : report.kind === "rate"
                            ? "percent"
                            : "count"
                      }
                      currency={report.currency}
                    />
                  </div>
                ) : null}
              </>
            )}
          </PendingContent>
        </div>

        {hasGrids ? null : <div className="border-t px-5 py-2.5">{asOf}</div>}
      </section>

      {hasGrids ? (
        <PendingContent
          skeleton={
            <>
              {report.table ? <ReportCardBones /> : null}
              {report.matrix ? <ReportCardBones /> : null}
              {showBreakdown && breakdown ? <ReportCardBones /> : null}
            </>
          }
        >
          {report.table ? (
            <RecordCard
              title="Movement by period"
              meta={`${report.table.rows.length} periods`}
              flush
              footer={lastGrid === "table" ? asOf : undefined}
            >
              <div className={flushTable}>
                <WaterfallTable
                  table={report.table}
                  kind={report.kind}
                  currency={report.currency}
                />
              </div>
            </RecordCard>
          ) : null}

          {report.matrix ? (
            <RecordCard
              title="Retention by cohort"
              meta={`${report.matrix.rows.length} cohorts`}
              flush
              footer={lastGrid === "matrix" ? asOf : undefined}
            >
              <div className={flushTable}>
                <CohortGrid matrix={report.matrix} currency={report.currency} />
              </div>
            </RecordCard>
          ) : null}

          {showBreakdown && breakdown ? (
            <RecordCard
              // The rows are whatever the report breaks down BY; the heading follows the request.
              title={groupBy ? `By ${dimensionLabel(groupBy).toLowerCase()}` : "Breakdown"}
              meta={`${breakdown.length} row${breakdown.length === 1 ? "" : "s"}`}
              flush
              footer={lastGrid === "breakdown" ? asOf : undefined}
            >
              <div className={flushTable}>
                <BreakdownTable
                  rows={breakdownLinks(breakdown, groupBy, biz, report)}
                  funnel={report.funnel === true && !groupBy}
                  kind={report.kind}
                  currency={report.currency}
                  groupLabel={
                    groupBy
                      ? dimensionLabel(groupBy)
                      : report.funnel
                        ? "Step"
                        : report.shape === "buckets"
                          ? "Bucket"
                          : "Group"
                  }
                  // The unit, not the report's name — a head that repeats the title says nothing.
                  valueLabel={
                    report.kind === "money"
                      ? "Amount"
                      : report.kind === "count"
                        ? "Count"
                        : report.kind === "rate"
                          ? "Rate"
                          : "Ratio"
                  }
                />
              </div>
            </RecordCard>
          ) : null}
        </PendingContent>
      ) : null}
    </div>
  );
}
