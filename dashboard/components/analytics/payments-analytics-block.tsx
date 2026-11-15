"use client";

import * as React from "react";
import { sentenceCase } from "@/lib/labels";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, ChevronDown, Info } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, CardContent } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { fmtDateTime, fmtRange } from "@/lib/format-date";
import { Delta } from "@/components/analytics/delta";
import { TrendChart } from "@/components/analytics/trend-chart";
import { Headline, type HeadlineChange } from "@/components/analytics/home/parts";
import { Grid } from "@/components/analytics/layout";
import { changePct } from "@/components/analytics/format";
import {
  BreakdownTable,
  type BreakdownColumn,
  type BreakdownRow,
} from "@/components/analytics/breakdown-table";
import {
  SERIES_HINTS,
  SERIES_POLARITY,
  seriesHeadline,
} from "@/components/analytics/series-format";
// From the client-safe SHAPE module, not the fetcher: this is a 'use client' file and
// the two range constants are runtime values, so importing them from `./analytics`
// would pull that module's server-only `@/lib/api` (and `next/headers`) into the
// browser bundle. See the header of `lib/api/analytics-shape.ts`.
import {
  PAYMENTS_ANALYTICS_RANGES,
  PAYMENTS_ANALYTICS_RANGE_LABELS,
  type PaymentsAnalytics,
  type PaymentsAnalyticsOption,
  type PaymentsAnalyticsSeries,
} from "@/lib/api/analytics-shape";

/**
 * Which of the ten series and three breakdowns a page shows. This is the ONLY
 * difference between the /transactions and /payment_intents dashboards — one
 * block serves both screens.
 */
export interface PaymentsAnalyticsConfig {
  /** The headline measure: a wide card with the full trend chart. */
  lead: string;
  /** Four supporting KPI tiles (value + delta + sparkline). */
  tiles: string[];
  /** Extra full-width trend charts, e.g. the payment-intents Failure Trend. */
  charts?: Array<{ key: string; label?: string }>;
  breakdowns: Array<"error_details" | "payment_methods" | "gateways">;
  /**
   * Presentation-only label overrides. The SAME measure is named differently per
   * screen ("Gross volume" on transactions, "Total revenue" on payment intents);
   * the number behind it is identical.
   */
  labels?: Record<string, string>;
  /** One line under the filters: what the figures count, where the page title could mislead. */
  note?: string;
}

const BREAKDOWN_META = {
  error_details: {
    title: "Error details",
    dimensionHeader: "Cause",
    emptyTitle: "No failures in this period",
    emptyDescription: "Nothing was declined, so there are no errors to show.",
    hint: "Declined attempts grouped by the reason the gateway gave.",
  },
  payment_methods: {
    title: "Payment method breakdown",
    dimensionHeader: "Payment method",
    emptyTitle: "No transactions in this period",
    emptyDescription: "Nothing was attempted, so there are no payment methods to show.",
    hint: "Every gateway attempt grouped by the payment method used.",
  },
  gateways: {
    title: "Gateway breakdown",
    dimensionHeader: "Gateway",
    emptyTitle: "No transactions in this period",
    emptyDescription: "Nothing was attempted, so there are no gateways to show.",
    hint: "Every gateway attempt grouped by the gateway that handled it.",
  },
} as const;

/**
 * Sentence case for a label the API sends in title case: "Failure Rate" → "Failure rate".
 * A word with two capitals ("MRR", "TM") is an acronym or a name and keeps its case.
 */
function sentence(label: string): string {
  return label
    .split(" ")
    .map((w, i) => (i === 0 || /[A-Z].*[A-Z]/.test(w) ? w : w.toLowerCase()))
    .join(" ");
}

/** The same, inside a sentence: "vs last month". */
const inline = (label: string) =>
  sentence(label).replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());

/** A labelled filter dropdown: `Duration: This month`. */
function ScopeMenu({
  label,
  value,
  options,
  onSelect,
}: {
  label: string;
  value: string;
  options: Array<{ key: string; label: string }>;
  onSelect: (key: string) => void;
}) {
  const current = options.find((o) => o.key === value) ?? options[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        className="inline-flex h-8 items-center gap-2 rounded-md border bg-card px-3 text-xs font-medium hover:bg-accent"
      >
        <span className="text-muted-foreground">{label}:</span>
        {current?.label ?? "—"}
        <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        {options.map((o) => (
          <DropdownMenuItem key={o.key} onClick={() => onSelect(o.key)} className="justify-between">
            {o.label}
            {o.key === value ? <Check className="size-3.5" aria-hidden /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The payments-analytics block behind the "Dashboard" tab on /transactions and
 * /payment_intents.
 *
 * Every control refetches for real: Duration / Gateway / Payment Method each write
 * a search param and push, so the server component re-reads
 * `GET /v1/businesses/:biz/payments_analytics` and every figure below moves
 * together. While that lands, the content holds its previous render at reduced
 * opacity — no skeleton flash, no layout jump.
 */
export function PaymentsAnalyticsBlock({
  data,
  config,
}: {
  data: PaymentsAnalytics;
  config: PaymentsAnalyticsConfig;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = React.useTransition();

  const go = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  };

  const byKey = React.useMemo(() => {
    const m = new Map<string, PaymentsAnalyticsSeries>();
    for (const s of data.series) m.set(s.key, s);
    return m;
  }, [data.series]);

  // The period runs to its end ("1 Nov – 30 Nov"), but nothing has happened after `as_of`:
  // those buckets are not zeros, so the series stops at now rather than drawing a flat line.
  const asOf = Date.parse(data.as_of);
  const toNow = (s: PaymentsAnalyticsSeries): PaymentsAnalyticsSeries => ({
    ...s,
    points: s.points.filter((p) => Date.parse(p.t) <= asOf),
  });

  /** Labelled per config, else the label the API gave the series; cut at `as_of`. */
  const labelled = (s: PaymentsAnalyticsSeries): PaymentsAnalyticsSeries =>
    toNow({ ...s, label: sentenceCase(config.labels?.[s.key] ?? s.label) });

  const lead = byKey.get(config.lead);
  const tiles = config.tiles
    .map((k) => byKey.get(k))
    .filter((s): s is PaymentsAnalyticsSeries => !!s);
  const charts = (config.charts ?? [])
    .map((c) => {
      const s = byKey.get(c.key);
      return s ? labelled(c.label ? { ...s, label: c.label } : s) : null;
    })
    .filter((s): s is PaymentsAnalyticsSeries => !!s);

  // Option menus are scoped to the selected period, so the value a user picked can
  // vanish from its own list when they narrow the range. Keep it visible — a
  // control that stops showing its own state looks broken.
  const withSelected = (
    options: PaymentsAnalyticsOption[],
    selected: string | null,
    allLabel: string,
  ) => {
    const rows = [
      { key: "", label: allLabel },
      ...options.map((o) => ({ key: o.key, label: o.label })),
    ];
    if (selected && !options.some((o) => o.key === selected))
      rows.push({ key: selected, label: selected });
    return rows;
  };

  // `period.end` is the EXCLUSIVE next boundary, so rendering it raw shows the
  // first day of the following month. Step back an instant for the caption.
  const spanOf = (p: { start: string; end: string }) =>
    fmtRange(p.start, new Date(Date.parse(p.end) - 1).toISOString(), data.timezone);
  const spanLabel = spanOf(data.period);
  const previousSpan = spanOf(data.previous_period);

  const errorRows: BreakdownRow[] = data.breakdowns.error_details.map((r) => ({
    key: r.error_code,
    label: r.label,
    cells: [
      { v: r.count, prev: r.prev_count },
      { v: r.amount_minor, prev: r.prev_amount_minor },
    ],
    share_bps: r.share_bps,
  }));
  const errorColumns: BreakdownColumn[] = [
    { header: "Failures", kind: "count" },
    { header: "Amount", kind: "money" },
  ];
  const dimColumns: BreakdownColumn[] = [
    { header: "Transactions", kind: "count" },
    { header: "Amount", kind: "money" },
    { header: "Failed", kind: "count" },
  ];
  const dimRows = (key: "payment_methods" | "gateways"): BreakdownRow[] =>
    data.breakdowns[key].map((r) => ({
      key: r.key,
      label: r.label,
      cells: [
        { v: r.count, prev: r.prev_count },
        { v: r.amount_minor, prev: r.prev_amount_minor },
        { v: r.failed_count, prev: r.prev_failed_count },
      ],
      share_bps: r.share_bps,
    }));

  return (
    <div className="mb-8">
      {/* One filter row, above everything it scopes. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <ScopeMenu
          label="Duration"
          value={data.range}
          options={PAYMENTS_ANALYTICS_RANGES.map((r) => ({
            key: r,
            label: sentence(PAYMENTS_ANALYTICS_RANGE_LABELS[r]),
          }))}
          onSelect={(key) => go({ range: key })}
        />
        <ScopeMenu
          label="Gateway"
          value={data.filters.gateway ?? ""}
          options={withSelected(data.options.gateways, data.filters.gateway, "All gateways")}
          onSelect={(key) => go({ gateway: key || null })}
        />
        <ScopeMenu
          label="Payment method"
          value={data.filters.payment_method ?? ""}
          options={withSelected(
            data.options.payment_methods,
            data.filters.payment_method,
            "All payment methods",
          )}
          onSelect={(key) => go({ payment_method: key || null })}
        />
        <span className="text-xs text-muted-foreground">{spanLabel}</span>
      </div>
      {config.note ? (
        <p className="-mt-1 mb-4 text-sm text-muted-foreground">{config.note}</p>
      ) : null}

      {/* A currency with no exchange rate is excluded from BOTH the money and the
          counts — and from all three sources the read sums (transactions, disputes,
          payment intents), so name them rather than saying "transactions". The
          figures below really do omit money; a total that quietly under-reports is
          worse than no total. */}
      {data.missing_rates.length > 0 ? (
        <Alert tone="warning" className="mb-4" title="Some money is missing from these figures">
          There is no exchange rate for {data.missing_rates.join(", ")}. Every figure below excludes
          the payments, refunds, chargebacks and payment intents in{" "}
          {data.missing_rates.length === 1 ? "that currency" : "those currencies"}. This applies to
          counts and amounts. To include {data.missing_rates.length === 1 ? "it" : "them"}, set a
          rate in{" "}
          <Link href={`/businesses/${data.business}/settings/currencies`}>
            Settings → Currencies
          </Link>
          .
        </Alert>
      ) : null}

      <div
        // "Refetch keeps the frame": hold the previous render while the new slice
        // loads instead of flashing a skeleton.
        className={cn("space-y-4 transition-opacity", pending && "opacity-60")}
        aria-busy={pending}
      >
        {lead ? <LeadCard series={labelled(lead)} currency={data.currency} /> : null}

        {tiles.length > 0 ? (
          // The KPI card every analytics screen uses (Home, Metrics), not a fourth style.
          // Two by two on a phone: each tile holds a figure, a chip and one stat.
          <Grid className="gap-4 max-lg:*:col-span-6">
            {tiles.map((s) => (
              <KpiCard key={s.key} series={labelled(s)} currency={data.currency} />
            ))}
          </Grid>
        ) : null}

        {charts.map((s) => (
          <LeadCard key={s.key} series={s} currency={data.currency} />
        ))}

        {config.breakdowns.map((b) =>
          b === "error_details" ? (
            <BreakdownTable
              key={b}
              {...BREAKDOWN_META.error_details}
              columns={errorColumns}
              rows={errorRows}
              currency={data.currency}
              previousSpan={previousSpan}
              shareHeader="Share of failures"
            />
          ) : (
            <BreakdownTable
              key={b}
              {...BREAKDOWN_META[b]}
              columns={dimColumns}
              rows={dimRows(b)}
              currency={data.currency}
              previousSpan={previousSpan}
            />
          ),
        )}
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        {sentence(data.period.label)} · {spanLabel} ({data.timezone}) · as of{" "}
        {fmtDateTime(data.as_of, data.timezone)} ·{" "}
        {data.converted
          ? `money converted into ${data.currency} at the rates in Settings → Currencies`
          : `all figures in ${data.currency}`}
      </p>
    </div>
  );
}

/**
 * A supporting measure as a `Headline`: figure, change chip, and the previous period in the
 * stat row. No sparkline: beside one, the chip's context wrapped in a quarter-width card, and
 * the lead chart above already draws the trend.
 */
function KpiCard({ series, currency }: { series: PaymentsAnalyticsSeries; currency: string }) {
  const { headline } = series;
  const polarity = SERIES_POLARITY[series.key] ?? "neutral";
  const hint = SERIES_HINTS[series.key];
  const bps = headline.change_bps;
  const down = bps != null && bps < 0;
  const good = polarity === "neutral" ? null : polarity === "up_good" ? !down : down;
  const change: HeadlineChange | null =
    bps != null && headline.prev_label != null
      ? {
          value: changePct(Math.abs(bps)),
          direction: bps === 0 ? "flat" : down ? "down" : "up",
          tone: good == null || bps === 0 ? "neutral" : good ? "good" : "bad",
          context: `vs ${inline(headline.prev_label)}`,
        }
      : null;
  return (
    <Headline
      span={3}
      label={series.label}
      info={hint ? { text: hint } : undefined}
      value={seriesHeadline(headline.value, headline.kind, currency)}
      // No note when there is no change: the chip sits beside the figure, so a note under it
      // would drop that card's figure out of line with the rest of the row.
      change={change}
      stats={
        headline.prev_label != null
          ? [
              {
                label: sentence(headline.prev_label),
                value:
                  headline.prev_value != null
                    ? seriesHeadline(headline.prev_value, headline.kind, currency)
                    : "—",
              },
            ]
          : []
      }
    />
  );
}

/**
 * The headline measure: value, delta vs the named previous period, and the full
 * trend chart with axes, crosshair and table twin.
 */
function LeadCard({ series, currency }: { series: PaymentsAnalyticsSeries; currency: string }) {
  const { headline } = series;
  const polarity = SERIES_POLARITY[series.key] ?? "neutral";
  const hint = SERIES_HINTS[series.key];
  return (
    <Card>
      <CardContent>
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-sm font-semibold">{series.label}</h2>
          {hint ? (
            <span title={hint} className="shrink-0 text-muted-foreground">
              <Info className="size-3.5" aria-hidden />
              <span className="sr-only">{hint}</span>
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-3xl font-semibold tracking-tight">
            {seriesHeadline(headline.value, headline.kind, currency)}
          </span>
          {headline.change_bps != null ? (
            <Delta bps={headline.change_bps} polarity={polarity} size="md" />
          ) : null}
          {headline.prev_label != null && headline.prev_value != null ? (
            <span className="text-xs text-muted-foreground">
              vs {inline(headline.prev_label)}{" "}
              {seriesHeadline(headline.prev_value, headline.kind, currency)}
            </span>
          ) : null}
        </div>
        <div className="mt-3">
          <TrendChart
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
