import * as React from "react";
import { cn } from "@/lib/utils";
import { RecordCard } from "@/components/patterns/record-page";
import { BlockLink, KPI_LABEL } from "@/components/analytics/layout";
import { InfoTip } from "@/components/analytics/info-tip";
import { G } from "@/components/analytics/glossary";
import { SegmentBar } from "@/components/charts/segment-bar";
import { ByOutcomeTable } from "@/components/reports/recovery/by-outcome-table";
import type { BreakdownRow } from "@/components/reports/report-format";
import { pctFromBps } from "@/lib/format";
import { outcomeLabel, type RecoveryTotals } from "@/components/reports/recovery/dunning-outcomes";

/** A flush table inside a header-strip card: its outer cells line up with the card's 20px edge. */
export const TABLE_EDGE =
  "[&_td:first-child]:pl-5 [&_th:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:last-child]:pr-5";

const count = (n: number) => n.toLocaleString("en");

function Side({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-t pt-4 @xl:border-t-0 @xl:border-l @xl:pt-0 @xl:pl-6">
      <span className={KPI_LABEL}>{label}</span>
      <span className="pt-1 text-lg font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{note}</span>
    </div>
  );
}

/** The as-of-now outcome summary: the rate, the population it divides, and the split. */
export function DunningOutcomesCard({
  biz,
  totals,
  parts,
}: {
  biz: string;
  totals: RecoveryTotals;
  parts: Array<{ key: string; fill: string; value: number }>;
}) {
  return (
    <RecordCard
      title="Dunning outcomes"
      meta={`${count(totals.everEntered)} invoice${totals.everEntered === 1 ? "" : "s"}`}
      actions={<BlockLink href={`/businesses/${biz}/retries`}>Retries</BlockLink>}
      footer={
        <span className="text-xs text-muted-foreground">
          A dunning state is a fact about now. The engine keeps no history of it. So these figures
          cannot show as a trend, and they do not change with the period below.
        </span>
      }
    >
      <div className="@container flex flex-col gap-6 py-1">
        {/* Three across only once the card itself is wide enough (a container query, since the
            card's width depends on the nav rail and the row, not on the viewport). */}
        <div className="grid grid-cols-1 gap-4 @xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)] @xl:gap-6">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="flex items-center gap-1">
              <span className={KPI_LABEL}>Recovery rate</span>
              <InfoTip label="Recovery rate" info={G.recoveryRate} />
            </span>
            <span className="text-2xl font-semibold tabular-nums">
              {pctFromBps(totals.rateBps, 1)}
            </span>
            <span className="text-xs text-muted-foreground">
              <span className="tabular-nums">{count(totals.recovered)}</span> recovered ÷{" "}
              <span className="tabular-nums">{count(totals.everEntered)}</span> taken in.
              {totals.undecided > 0 ? (
                <>
                  {" "}
                  <span className="tabular-nums">{count(totals.undecided)}</span> are still in
                  progress, so this rate can only rise.
                </>
              ) : null}
            </span>
          </div>
          <Side
            label="Invoices in collections"
            value={count(totals.everEntered)}
            note="Every invoice that entered dunning. The rate divides by this number."
          />
          <Side
            label="Recovered"
            value={count(totals.recovered)}
            note="Invoices that entered collections and were then paid."
          />
        </div>

        {parts.length > 0 ? (
          <div className="flex flex-col gap-3">
            <SegmentBar label="Invoices by dunning outcome" parts={parts} />
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {parts.map((p) => (
                <span key={p.key} className="flex min-w-0 items-start gap-2">
                  <span className={cn("mt-1.5 size-2 shrink-0 rounded-sm", p.fill)} aria-hidden />
                  <span>
                    <span className="block text-sm font-semibold tabular-nums">
                      {count(p.value)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {outcomeLabel(p.key)}
                    </span>
                  </span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </RecordCard>
  );
}

/** Each outcome with its count and share; a row opens that outcome's invoices. */
export function ByOutcomeCard({ rows }: { rows: BreakdownRow[] }) {
  return (
    <RecordCard title="By outcome" meta="opens the invoices" flush>
      <div className={TABLE_EDGE}>
        <ByOutcomeTable rows={rows} />
      </div>
    </RecordCard>
  );
}
