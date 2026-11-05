import Link from "next/link";
import { Card } from "@/components/ui/card";
import { KPI_LABEL, spanClass, type Span } from "@/components/analytics/layout";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Delta } from "@/components/analytics/delta";
import { BucketBars } from "@/components/charts/bucket-bars";
import { SegmentBar } from "@/components/charts/segment-bar";
import { cn } from "@/lib/utils";
import type { SeriesPolarity } from "@/components/analytics/series-format";
import { fmtDate, money, moneyCompact, pctFromBps } from "@/lib/format";
import type { CancellationAnalytics, CancellationCause } from "@/lib/api/cancellation-analytics";
import { InfoTip } from "@/components/analytics/info-tip";
import type { CardInfo } from "@/components/analytics/card-info";

export const CAUSE_LABELS: Record<CancellationCause, string> = {
  // No payment-related system reason was recorded: a choice, as far as the book knows. An
  // imported cancellation carries no reason at all, so this cannot claim it was voluntary.
  voluntary: "No payment failure recorded",
  payment_failed: "Payment failed",
  no_payment_method: "No payment method",
  chargeback: "Chargeback",
  term_ended: "Fixed term ended",
};

/** Change in basis points, or null when there is nothing to compare against. */
export function changeBps(now: number, before: number | null | undefined): number | null {
  if (before == null || before === 0) return null;
  return Math.round(((now - before) / before) * 10_000);
}

export function Tile({
  label,
  value,
  change,
  polarity = "up_bad",
  note,
  span,
  info,
}: {
  label: string;
  value: string;
  change?: number | null;
  polarity?: SeriesPolarity;
  note?: string;
  span: Span;
  info?: CardInfo;
}) {
  return (
    <Card className={cn("anim-rise flex min-w-0 flex-col gap-0 p-6", spanClass(span))}>
      <span className="flex items-center gap-1">
        <span className={KPI_LABEL}>{label}</span>
        {info ? <InfoTip label={label} info={info} /> : null}
      </span>
      <span className="mt-2 text-2xl font-semibold tabular-nums">{value}</span>
      <span className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-xs">
        {change != null ? <Delta bps={change} polarity={polarity} /> : null}
        {note ? <span className="text-muted-foreground">{note}</span> : null}
      </span>
    </Card>
  );
}

export interface InsightRow {
  key: string;
  label: string;
  count: number;
  mrr_lost_minor: number;
}

/**
 * Count, MRR lost and each row's share of the loss. Rows arrive ordered by loss; the share is
 * of the rows shown, which for every table on this page is the whole paying population.
 */
export function InsightTable({
  rows,
  currency,
  groupLabel,
  showMoney = true,
  compact = false,
}: {
  rows: InsightRow[];
  currency: string;
  groupLabel: string;
  showMoney?: boolean;
  /** Half-width card: the share as a figure only, no bar. */
  compact?: boolean;
}) {
  const lost = rows.reduce((a, r) => a + r.mrr_lost_minor, 0);
  const count = rows.reduce((a, r) => a + r.count, 0);
  return (
    // Compact (half-width) tables fix their number columns so the label wraps instead of
    // pushing Share out of the card.
    <Table className={compact ? "table-fixed" : undefined}>
      <TableHeader>
        <TableRow>
          <TableHead>{groupLabel}</TableHead>
          <TableHead className={cn("text-right", compact && "w-28")}>Cancellations</TableHead>
          {showMoney ? (
            <TableHead className={cn("text-right", compact && "w-36")}>MRR lost</TableHead>
          ) : null}
          <TableHead className={cn("text-right", compact && "w-20")}>Share</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const share =
            showMoney && lost > 0 ? r.mrr_lost_minor / lost : count > 0 ? r.count / count : 0;
          return (
            <TableRow key={r.key}>
              <TableCell>{r.label}</TableCell>
              <TableCell className="text-right whitespace-nowrap">
                {r.count.toLocaleString("en")}
              </TableCell>
              {showMoney ? (
                <TableCell className="text-right whitespace-nowrap">
                  {money(r.mrr_lost_minor, currency)}
                </TableCell>
              ) : null}
              <TableCell className="text-right whitespace-nowrap">
                <div className="flex items-center justify-end gap-2">
                  {compact ? null : (
                    <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
                      <div
                        className="anim-grow h-full rounded-full bg-chart-1"
                        style={{ width: `${Math.round(share * 100)}%` }}
                      />
                    </div>
                  )}
                  <span className="w-12 text-muted-foreground">
                    {pctFromBps(Math.round(share * 10_000), 1)}
                  </span>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** A table run edge to edge in a header-strip card: the outer columns take the card's gutter. */
export const FLUSH_TABLE =
  "[&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5";

/** Each kind of cancellation as a label, its count and share, over a bar scaled to the largest. */
export function KindBars({ rows }: { rows: Array<{ key: string; label: string; count: number }> }) {
  const shown = rows.filter((r) => r.count > 0);
  const widest = Math.max(...shown.map((r) => r.count), 1);
  const whole = shown.reduce((a, r) => a + r.count, 0);
  return (
    <div className="flex flex-col gap-4">
      {shown.map((r) => (
        <div key={r.key} className="flex flex-col gap-1.5">
          <div className="flex items-baseline gap-2 text-sm">
            <span className="min-w-0 wrap-break-word">{r.label}</span>
            <span className="ml-auto font-semibold tabular-nums">
              {r.count.toLocaleString("en")}
            </span>
            <span className="w-12 text-right text-xs text-muted-foreground tabular-nums">
              {whole > 0 ? pctFromBps(Math.round((r.count / whole) * 10_000), 1) : ""}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-md bg-muted" aria-hidden>
            <div
              className="anim-grow h-full rounded-md bg-chart-1"
              style={{ width: `${Math.min(100, (r.count / widest) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export interface MrrBar {
  key: string;
  label: string;
  start: string;
  end: string;
  lost: number;
  involuntary: number;
  paying: number;
}

/**
 * MRR lost per bucket as loss bars, then the window's split by cause as one bar. Involuntary
 * loss is the part a better retry or card update could have kept, so it is the one part given
 * the loss colour.
 */
export function MrrLostTrend({ bars, currency }: { bars: MrrBar[]; currency: string }) {
  const peak = Math.max(...bars.map((b) => b.lost), 0);
  if (bars.length === 0 || peak === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No paying cancellation occurred in this window.
      </p>
    );
  }
  const lost = bars.reduce((a, b) => a + b.lost, 0);
  const involuntary = bars.reduce((a, b) => a + b.involuntary, 0);
  const parts = [
    {
      key: "other",
      label: "No payment failure recorded",
      value: lost - involuntary,
      fill: "bg-muted-foreground",
    },
    { key: "involuntary", label: "Involuntary (payment)", value: involuntary, fill: "bg-chart-5" },
  ].filter((p) => p.value > 0);
  return (
    <div>
      <BucketBars
        labels={bars.map((b) => b.label)}
        values={bars.map((b) => b.lost)}
        part={{ label: "Involuntary (payment)", values: bars.map((b) => b.involuntary) }}
        notes={bars.map((b) => (b.lost > 0 ? `${b.paying.toLocaleString("en")} paying` : null))}
        seriesLabel="MRR lost"
        tone="loss"
        kind="money"
        currency={currency}
        height={220}
        barMaxWidth={bars.length <= 16 ? 32 : 18}
      />
      <div className="mt-4 flex flex-col gap-2 border-t pt-4">
        <SegmentBar label="MRR lost by cause" parts={parts} />
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
          {parts.map((p) => (
            <span key={p.key} className="flex items-center gap-1.5">
              <span className={cn("size-2 rounded-sm", p.fill)} aria-hidden />
              {p.label} {moneyCompact(p.value, currency)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function LargestLosses({
  biz,
  rows,
  currency,
  timezone,
  reasonLabel,
}: {
  biz: string;
  rows: CancellationAnalytics["top_losses"];
  currency: string;
  timezone: string;
  reasonLabel: (code: string | null) => string;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Customer</TableHead>
          <TableHead>Plan</TableHead>
          <TableHead>Cancelled</TableHead>
          <TableHead>Why</TableHead>
          <TableHead className="text-right">MRR lost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.subscription}>
            <TableCell className="max-w-64">
              <Link
                href={`/businesses/${biz}/subscriptions/${r.subscription}`}
                className="block truncate text-primary hover:underline"
              >
                {r.customer_name ?? r.subscription}
              </Link>
            </TableCell>
            <TableCell>{r.plan ?? "—"}</TableCell>
            <TableCell>{fmtDate(r.canceled_at, timezone)}</TableCell>
            <TableCell>
              {CAUSE_LABELS[r.cause]}
              {r.reason ? (
                <span className="text-muted-foreground"> · {reasonLabel(r.reason)}</span>
              ) : null}
            </TableCell>
            <TableCell className="text-right">
              {money(r.mrr_lost_minor, r.currency)}
              {r.currency !== currency && r.converted_mrr_lost_minor != null ? (
                <div className="text-xs text-muted-foreground">
                  ≈ {money(r.converted_mrr_lost_minor, currency)}
                </div>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
