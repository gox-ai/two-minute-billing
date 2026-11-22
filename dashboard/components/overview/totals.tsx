import type * as React from "react";

import { Grid } from "@/components/analytics/layout";
import { Headline, seriesChange, trialHalves } from "@/components/analytics/home/parts";
import { CurrentCards } from "@/components/analytics/home/current-cards";
import { ok, splitByKey } from "@/components/analytics/org/conversion";
import { orgPerformanceQueries } from "@/components/analytics/org/performance";
import { explain } from "@/components/analytics/card-info";
import { G } from "@/components/analytics/glossary";
import { EMPTY_FIGURE } from "@/components/patterns/record-page";
import { money, moneyCompact, pctFromBps } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SegmentBar } from "@/components/charts/segment-bar";
import type { AnalyticsQuery, AnalyticsResult, BatchEntry } from "@/lib/analytics-api";

/** The as-at reading Metrics' Current zone uses: the last point of a 7-day daily window. */
const READING = { grain: "day", range: "7d" } as const;

/**
 * The current totals: the same questions, windows and conversion as the Current zone on
 * `/metrics` (`portfolioQueries`), so the two pages show the same figures. Money is converted
 * into the organization's base currency unless the batch names one.
 */
const CARD_KEYS = new Set(["p_churn", "p_trial_conv", "p_new"]);

/**
 * Revenue types in the order the card names them: the engine's keys, our words, their colour.
 * The colours are Business Home's revenue mix, so a type is one colour on every page.
 */
const REVENUE_TYPES: ReadonlyArray<readonly [string, string, string]> = [
  ["recurring", "Subscriptions", "bg-chart-1"],
  ["one_time", "One-time", "bg-chart-4"],
  ["usage", "Usage", "bg-chart-2"],
  ["credit_pack", "Credit packs", "bg-chart-3"],
];

export function totalsQueries(businessCount: number): AnalyticsQuery[] {
  const byBiz = { split: "business", split_limit: Math.max(businessCount, 1) };
  return [
    { key: "mrr", measure: "mrr", grain: "day", range: "30d", compare: "previous" },
    { key: "arr", measure: "arr", ...READING },
    { key: "mrr_biz", measure: "mrr", ...byBiz, ...READING, shape: "totals" },
    { key: "paying_biz", measure: "paying_customers", ...byBiz, ...READING, shape: "totals" },
    { key: "recv_biz", measure: "receivables_outstanding", ...byBiz, ...READING, shape: "totals" },
    { key: "recv_n", measure: "receivables_invoices", ...READING },
    { key: "dunning_biz", measure: "dunning_subscriptions", ...byBiz, ...READING, shape: "totals" },
  ];
}

/**
 * The 30-day questions: movement chips, the churn and trial cards, MRR at risk, cancellations,
 * the per-business movement and the Performance section. Sent on the batch's 30-day daily
 * window, each money question in the reporting currency when one is selected.
 */
export function windowQueries(opts: {
  businessCount: number;
  currency?: string;
}): AnalyticsQuery[] {
  const reporting = opts.currency ? { currency: opts.currency } : {};
  const byBiz = { split: "business", split_limit: Math.max(opts.businessCount, 1) };
  return [
    { key: "mrr", measure: "mrr", compare: "previous", ...reporting },
    { key: "cmrr", measure: "cmrr", ...reporting },
    { key: "arpc", measure: "revenue_per_paying_customer", ...reporting },
    // Customer churn leads the churn card, as on a business Home. Its halves are counts of
    // customers, which add up across businesses at month grain.
    { key: "cust_churn", measure: "customer_churn_rate", range: "30d", grain: "month" as const },
    // Every billing model: what was invoiced, by type and by business, and who paid.
    { key: "rev", measure: "revenue_billed", compare: "previous", ...reporting },
    {
      key: "rev_type",
      measure: "revenue_billed",
      split: "revenue_type",
      split_limit: 4,
      shape: "totals",
      ...reporting,
    },
    { key: "rev_biz", measure: "revenue_billed", ...byBiz, shape: "totals", ...reporting },
    { key: "paying_all", measure: "paying_customers_all", compare: "previous" },
    // What each business sells, for its card: one reading per model.
    { key: "orders_biz", measure: "orders", ...byBiz, shape: "totals" },
    { key: "aov_biz", measure: "average_order_value", ...byBiz, shape: "totals", ...reporting },
    { key: "usage_biz", measure: "usage_events", ...byBiz, shape: "totals" },
    { key: "credits_biz", measure: "credits_used", ...byBiz, shape: "totals", ...reporting },
    { key: "paying_customers", measure: "paying_customers" },
    { key: "paying", measure: "paying_subscriptions" },
    { key: "renewing", measure: "renewing_subscriptions" },
    // Only the three the cards read; the Performance blocks themselves are on Metrics.
    ...orgPerformanceQueries(reporting).filter((q) => CARD_KEYS.has(q.key ?? "")),
    // The churn card's rate. The page read this key before it was ever asked for.
    { key: "p_churn_rate", measure: "gross_mrr_churn_rate", range: "30d", grain: "month" },
    { key: "cancel_mrr", measure: "scheduled_cancellation_mrr", split: "horizon", ...reporting },
    { key: "paying_by_biz", measure: "paying_subscriptions", ...byBiz },
    { key: "mrr_by_biz", measure: "mrr", ...byBiz, ...reporting },
  ];
}

export type Answers = Map<string, BatchEntry>;

const count = (n: number) => n.toLocaleString("en-US");

/**
 * The organization's totals. With subscriptions: the four cards at the head of Business Home
 * (MRR, Paying customers, Churn, Trial conversion), then Revenue of every type in a row of
 * its own. Without: Revenue and everyone who paid, as a business without subscriptions shows.
 */
export function OrgTotals({
  answers,
  window: w,
  soleBusiness,
  hasSubscriptions,
  bare = false,
  revenueRow = true,
}: {
  /** The Metrics-basis totals (`totalsQueries`). */
  answers: Answers;
  /** The 30-day answers (`windowQueries`). */
  window: Answers;
  /** With one business its figures link into its lists. */
  soleBusiness: string | null;
  /** Some business has subscriptions: MRR and churn mean nothing without any. */
  hasSubscriptions: boolean;
  /** Cells inside a surface that already draws the card: the one-business panel. */
  bare?: boolean;
  /** Draw the Revenue row under the four cards. The panel's page draws it itself. */
  revenueRow?: boolean;
}) {
  const wr = (key: string) => ok(w.get(key));
  const wt = (key: string) => wr(key)?.total ?? null;
  const mrr = ok(answers.get("mrr"));
  const wMrr = wr("mrr");
  const cur = mrr?.currency ?? wMrr?.currency ?? null;
  const sole = soleBusiness;
  const subsHref = sole ? `/businesses/${sole}/subscriptions` : null;
  const cancelResult = wr("cancel_mrr");
  const paying = wr("paying_customers");
  const series = (r: ReturnType<typeof wr>) => (r?.series ?? []).map((p) => p.value ?? null);

  if (!hasSubscriptions) {
    // Everyone who paid, for any kind of revenue. Each business's customer is its own account,
    // so the counts add.
    const payingAll = wt("paying_all");
    const half = { span: bare ? null : (6 as const), bare };
    return (
      <Cells bare={bare}>
        <RevenueCard window={w} {...half} />
        <Headline
          {...half}
          label="Paying customers"
          info={explain(G.customersWhoPaid)}
          change={seriesChange(wr("paying_all") as unknown as AnalyticsResult, "30 days", "count")}
          value={payingAll != null ? count(payingAll) : EMPTY_FIGURE}
        />
      </Cells>
    );
  }

  const cards = (
    <CurrentCards
      span={bare ? null : 3}
      bare={bare}
      data={{
        cur,
        mrr: mrr?.total ?? null,
        mrrChange: seriesChange(wMrr as unknown as AnalyticsResult, "30 days"),
        mrrSpark: series(wMrr),
        arr: ok(answers.get("arr"))?.total ?? null,
        cmrr: wt("cmrr"),
        // Every band, not just the next 30 days: the link lists them all.
        cancelling: cancelResult?.total ?? null,
        cancelCur: cancelResult?.currency ?? cur,
        paying: paying?.total ?? null,
        payingChange: seriesChange(paying as unknown as AnalyticsResult, "30 days", "count"),
        payingSpark: series(paying),
        arpc: wr("arpc"),
        payingSubs: wt("paying"),
        renewingSubs: wt("renewing"),
        custChurn: wr("cust_churn"),
        mrrChurn: wr("p_churn_rate"),
        mrrLost: wt("p_churn"),
        trial: trialHalves(wr("p_trial_conv")),
        trialConv: wt("p_trial_conv"),
        mrrNew: wt("p_new"),
        links: subsHref
          ? {
              cancelling: `${subsHref}?status=non_renewing`,
              payingSubs: `${subsHref}?filter=status:in:active,non_renewing&filter=mrr:gt:0`,
              renewing: `${subsHref}?filter=status:is:active&filter=mrr:gt:0`,
              mrrLost: `/businesses/${sole}/reports/cancellations`,
              newMrr: `/businesses/${sole}?tab=recurring`,
            }
          : undefined,
      }}
    />
  );
  return (
    <>
      <Cells bare={bare}>{cards}</Cells>
      {revenueRow ? <OrgRevenueRow window={w} /> : null}
    </>
  );
}

/** Revenue of every type in its own row, under the four cards. */
export function OrgRevenueRow({ window: w }: { window: Answers }) {
  return (
    <Grid>
      <RevenueCard window={w} span={12} />
    </Grid>
  );
}

/** What was invoiced in 30 days, whatever the billing model, split by type. */
function RevenueCard({
  window: w,
  span,
  bare = false,
}: {
  window: Answers;
  span: 6 | 12 | null;
  bare?: boolean;
}) {
  const rev = ok(w.get("rev"));
  const revCur = rev?.currency ?? ok(w.get("mrr"))?.currency ?? null;
  const revByType = new Map(
    [...splitByKey(ok(w.get("rev_type"))).values()].map((r) => [r.key, r.total]),
  );
  const revChange = rev?.compare?.change_bps;
  // A refused or uncomputed figure is unknown: a dash, never a zero.
  const known = rev?.total != null && revCur;
  // A row of its own: the trend and the share of each type fill the width.
  const wide = span === 12 && !bare;
  return (
    <Headline
      span={span}
      bare={bare}
      wide={wide}
      spark={wide ? (rev?.series ?? []).map((p) => p.value ?? null) : undefined}
      aside={
        wide && revCur ? (
          <RevenueMix
            cur={revCur}
            parts={REVENUE_TYPES.map(([key, label, swatch]) => ({
              label,
              swatch,
              value: revByType.get(key) ?? null,
            }))}
          />
        ) : undefined
      }
      label="Revenue, 30 days"
      info={explain(G.revenueBilled)}
      change={
        revChange == null
          ? null
          : {
              value: pctFromBps(Math.abs(revChange), 1),
              direction: revChange > 0 ? "up" : revChange < 0 ? "down" : "flat",
              tone: revChange > 0 ? "good" : revChange < 0 ? "bad" : "neutral",
              context: "vs the 30 days before",
            }
      }
      value={known ? moneyCompact(rev.total!, revCur) : EMPTY_FIGURE}
      title={known ? money(rev.total!, revCur) : undefined}
      stats={REVENUE_TYPES.map(([key, label]) => {
        const v = revByType.get(key);
        return {
          label,
          value: v != null && v > 0 && revCur ? moneyCompact(v, revCur) : null,
          title: v != null && v > 0 && revCur ? money(v, revCur) : undefined,
        };
      })}
    />
  );
}

/**
 * Each type's share of the revenue: one bar, then a labelled row per type. The bar shows
 * only when every part is positive; a credit note can take a type below zero, and a share
 * of a negative total means nothing.
 */
function RevenueMix({
  cur,
  parts,
}: {
  cur: string;
  parts: Array<{ label: string; swatch: string; value: number | null }>;
}) {
  const shown = parts.filter((p) => p.value != null && p.value !== 0) as Array<{
    label: string;
    swatch: string;
    value: number;
  }>;
  if (shown.length === 0) return null;
  const sum = shown.reduce((s, p) => s + p.value, 0);
  const bar = sum > 0 && shown.every((p) => p.value > 0);
  const pct = (v: number) => {
    const p = (v / sum) * 100;
    return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
  };
  return (
    <div className="flex flex-col gap-3">
      {bar ? (
        <SegmentBar
          label="Revenue by type"
          parts={shown.map((p) => ({ key: p.label, value: p.value, fill: p.swatch }))}
        />
      ) : null}
      <dl className="flex flex-col gap-1.5 text-sm">
        {shown.map((p) => (
          <div key={p.label} className="flex items-center gap-2">
            <span className={cn("size-2 shrink-0 rounded-full", p.swatch)} aria-hidden />
            <dt className="min-w-0 flex-1 truncate text-muted-foreground">{p.label}</dt>
            <dd className="font-medium whitespace-nowrap tabular-nums">
              {moneyCompact(p.value, cur)}
            </dd>
            {bar ? (
              <dd className="w-10 text-end text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                {pct(p.value)}
              </dd>
            ) : null}
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The card grid, or nothing around the cells when the panel draws the grid. */
function Cells({ bare, children }: { bare: boolean; children: React.ReactNode }) {
  return bare ? (
    <>{children}</>
  ) : (
    <Grid className="max-lg:gap-4 max-lg:*:col-span-6 max-sm:*:col-span-12">{children}</Grid>
  );
}
