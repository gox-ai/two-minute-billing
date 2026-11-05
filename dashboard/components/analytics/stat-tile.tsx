"use client";

import { Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { TrendChart } from "@/components/analytics/trend-chart";
import { Delta } from "@/components/analytics/delta";
import { SERIES_POLARITY, seriesHeadline } from "@/components/analytics/series-format";
import type { PaymentsAnalyticsSeries } from "@/lib/api/analytics";

/**
 * What each measure actually counts — including the caveats the backend recorded
 * rather than approximating. A tile that quietly means something narrower than its
 * label is worse than no tile, so the ⓘ says so.
 */
export const SERIES_HINTS: Record<string, string> = {
  gross_volume: "Successful payment volume in this period, before refunds and chargebacks.",
  refunds: "Refunds successfully issued in this period.",
  chargebacks: "Amounts disputed against you in this period, from the disputes log.",
  net_volume: "Gross volume less refunds and chargebacks.",
  transaction_count: "Every gateway attempt in this period, whatever its outcome.",
  successful_payments: "Payment attempts the gateway approved in this period.",
  failed_transactions:
    "Declined attempts in this period. This metric counts TRANSACTIONS from the transaction log, not payment attempts. A retried intent counts once for each declined transaction, not once per intent.",
  failed_amount:
    "The amount of the declined attempts in this period. It counts transactions, for the same reason as Failed Transactions.",
  failure_rate:
    "Declined ÷ (declined + approved). The denominator excludes voided attempts and attempts with an unknown outcome, such as a timeout or a wait for an operator decision. To count them as declines would make the rate too high. They still count in Transactions.",
  pending_payment_intents:
    "Intents still pending, counted over intents CREATED in this period. An older intent that is still pending does not count.",
};

/**
 * One KPI tile: label · value · delta vs the named previous period · sparkline.
 *
 * The value uses the font's PROPORTIONAL figures — `tabular-nums` gives every
 * digit the width of a `0`, which makes a number like `121` look loose at display
 * size. Tabular figures are for columns that align vertically (the tables below).
 */
export function StatTile({
  series,
  currency,
}: {
  series: PaymentsAnalyticsSeries;
  currency: string;
}) {
  const { headline } = series;
  const polarity = SERIES_POLARITY[series.key] ?? "neutral";
  const hint = SERIES_HINTS[series.key];

  return (
    <Card>
      <CardContent className="flex h-full flex-col">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm text-muted-foreground">{series.label}</h3>
          {hint ? (
            <span title={hint} className="shrink-0 text-muted-foreground">
              <Info className="size-3.5" aria-hidden />
              <span className="sr-only">{hint}</span>
            </span>
          ) : null}
        </div>

        <div className="mt-1.5 text-2xl font-semibold tracking-tight">
          {seriesHeadline(headline.value, headline.kind, currency)}
        </div>

        <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-xs">
          {headline.change_bps != null ? (
            <Delta bps={headline.change_bps} polarity={polarity} />
          ) : null}
          {headline.prev_label != null && headline.prev_value != null ? (
            <span className="text-muted-foreground">
              vs {headline.prev_label}{" "}
              {seriesHeadline(headline.prev_value, headline.kind, currency)}
            </span>
          ) : null}
        </div>

        <div className="mt-3">
          <TrendChart
            variant="spark"
            points={series.points}
            kind={series.kind}
            currency={currency}
            label={series.label}
          />
        </div>
      </CardContent>
    </Card>
  );
}
