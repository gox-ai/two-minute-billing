import type * as React from "react";
import { CircleDollarSign, Hourglass, TrendingDown, Users } from "lucide-react";
import { Grid } from "@/components/analytics/layout";
import { Headline, seriesChange, trialHalves } from "@/components/analytics/home/parts";
import { ok, splitByKey } from "@/components/analytics/org/conversion";
import { orgPerformanceQueries } from "@/components/analytics/org/performance";
import { measureValueCompact } from "@/components/analytics/format";
import { explain } from "@/components/analytics/card-info";
import { G } from "@/components/analytics/glossary";
import { EMPTY_FIGURE } from "@/components/patterns/record-page";
import { money, moneyCompact, pctFromBps } from "@/lib/format";
import type { AnalyticsQuery, AnalyticsResult, BatchEntry } from "@/lib/analytics-api";

/** The as-at reading Metrics' Current zone uses: the last point of a 7-day daily window. */
const READING = { grain: "day", range: "7d" } as const;

/**
 * The four current totals: the same questions, windows and conversion as the Current zone on
 * `/metrics` (`portfolioQueries`), so the two pages show the same figures. Money is converted
 * into the organization's base currency unless the batch names one.
 */
const CARD_KEYS = new Set(["p_churn", "p_new", "p_trial_conv"]);

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
  soleBusiness: string | null;
  currency?: string;
}): AnalyticsQuery[] {
  const reporting = opts.currency ? { currency: opts.currency } : {};
  const byBiz = { split: "business", split_limit: Math.max(opts.businessCount, 1) };
  const sole = opts.soleBusiness;
  return [
    { key: "mrr", measure: "mrr", compare: "previous", ...reporting },
    // One business: ARPC and customer churn name it, because the organization scope refuses them.
    ...(sole
      ? [
          { key: "sole_cmrr", measure: "cmrr", business: sole, ...reporting },
          {
            key: "sole_cust_churn",
            measure: "customer_churn_rate",
            business: sole,
            range: "30d",
            grain: "month" as const,
          },
          {
            key: "sole_arpa",
            measure: "revenue_per_paying_customer",
            business: sole,
            ...reporting,
          },
        ]
      : []),
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
/** A split's total; null only when the question itself was refused or failed. */
const sum = (a: Answers, key: string) => {
  const result = ok(a.get(key));
  if (!result) return null;
  return [...splitByKey(result).values()].reduce((s, r) => s + (r.total ?? 0), 0);
};

/**
 * Four cards: what the book is now and what moved in 30 days. Two by two
 * on a phone, three in a row from a wide column.
 */
export function OrgTotals({
  answers,
  window: w,
  businessCount,
  includedCount,
  soleBusiness,
  bare = false,
}: {
  /** The Metrics-basis totals (`totalsQueries`). */
  answers: Answers;
  /** The 30-day answers (`windowQueries`). */
  window: Answers;
  businessCount: number;
  /** Businesses the conversion could include: the rest have no reporting rate. */
  includedCount: number;
  /** With one business its figures link into its lists, and ARPC and customer churn show. */
  soleBusiness: string | null;
  /** Cells inside a surface that already draws the card: the one-business panel. */
  bare?: boolean;
}) {
  // Four across, as the page always had them.
  const cell = { span: bare ? null : (3 as const), bare };
  const mrr = ok(answers.get("mrr"));
  const arr = ok(answers.get("arr"));
  const payingTotal = sum(answers, "paying_biz");
  // A refused or uncomputed figure is unknown: a dash, never a zero.
  const moneyFigure = (minor: number | null | undefined, cur: string | null | undefined) =>
    minor != null && cur ? moneyCompact(minor, cur) : EMPTY_FIGURE;
  const moneyTitle = (minor: number | null | undefined, cur: string | null | undefined) =>
    minor != null && cur ? money(minor, cur) : undefined;
  const cur = mrr?.currency ?? null;

  const wr = (key: string) => ok(w.get(key));
  const wt = (key: string) => wr(key)?.total ?? null;
  const only = soleBusiness != null;
  const subsHref = only ? `/businesses/${soleBusiness}/subscriptions` : null;
  const wMrr = wr("mrr");
  const soleCmrr = wr("sole_cmrr");
  const soleArpa = wr("sole_arpa");
  const soleCustChurn = wr("sole_cust_churn");
  const cancelResult = wr("cancel_mrr");
  // Every band, not just the next 30 days: the link lists them all.
  const cancelling = cancelResult?.total ?? 0;
  const paying = wr("paying");
  const renewing = wr("renewing");
  const hTrial = trialHalves(wr("p_trial_conv"));
  const hTrialConv = wt("p_trial_conv");
  const hMrrNew = wt("p_new");
  const hChurned = wt("p_churn");
  const hMrrChurn = wr("p_churn_rate");
  const wCur = wMrr?.currency ?? cur;

  const cards = [
    <Headline
      key="mrr"
      {...cell}
      icon={CircleDollarSign}
      label={businessCount > 1 ? "Consolidated MRR" : "MRR"}
      info={
        only
          ? explain(G.mrr, G.arr, G.cmrr, G.cancelling)
          : explain(G.consolidatedMrr, G.businesses, G.cancelling)
      }
      change={seriesChange(wMrr as unknown as AnalyticsResult, "30 days")}
      value={moneyFigure(mrr?.total, cur)}
      title={moneyTitle(mrr?.total, cur)}
      stats={[
        { label: "ARR", value: arr?.total != null && cur ? moneyCompact(arr.total, cur) : null },
        only
          ? {
              label: "Committed",
              value:
                soleCmrr?.total != null
                  ? measureValueCompact(soleCmrr.total, soleCmrr.unit, soleCmrr.currency)
                  : null,
              title:
                soleCmrr?.total != null && soleCmrr.currency
                  ? money(soleCmrr.total, soleCmrr.currency)
                  : undefined,
            }
          : {
              label: "Businesses",
              value: mrr?.total ? `${includedCount} of ${businessCount}` : null,
            },
        {
          label: "Cancelling",
          href: subsHref ? `${subsHref}?status=non_renewing` : undefined,
          value:
            cancelling > 0
              ? measureValueCompact(cancelling, "money", cancelResult?.currency ?? null)
              : null,
          title:
            cancelling > 0 && cancelResult?.currency
              ? `${money(cancelling, cancelResult.currency)} of MRR booked to cancel`
              : undefined,
        },
      ]}
    />,
    /* Customers are the paying unit; subscriptions are the detail beneath. Each business's
        customer is its own account, so the counts add. */
    <Headline
      key="paying"
      {...cell}
      icon={Users}
      label="Paying customers"
      info={explain(G.payingCustomers, only ? G.arpa : null, G.payingSubs, G.renewing)}
      change={seriesChange(
        wr("paying_customers") as unknown as AnalyticsResult,
        "30 days",
        "count",
      )}
      value={payingTotal != null ? count(payingTotal) : EMPTY_FIGURE}
      stats={[
        ...(only
          ? [
              {
                label: "ARPC",
                value:
                  soleArpa?.total != null && soleArpa.currency
                    ? money(Math.round(soleArpa.total), soleArpa.currency)
                    : null,
              },
            ]
          : []),
        {
          label: "Paying subs",
          value: paying?.total ? count(paying.total) : null,
          href: subsHref
            ? `${subsHref}?filter=status:in:active,non_renewing&filter=mrr:gt:0`
            : undefined,
        },
        {
          label: "Renewing",
          value: renewing?.total ? count(renewing.total) : null,
          href: subsHref ? `${subsHref}?filter=status:is:active&filter=mrr:gt:0` : undefined,
        },
      ]}
    />,
    <Headline
      key="trial"
      {...cell}
      icon={Hourglass}
      label="Trial conversion, 30 days"
      info={explain(G.trialConversion, G.trialsConverted, G.trialsEnded, G.newMrr30)}
      value={hTrialConv == null ? EMPTY_FIGURE : pctFromBps(hTrialConv, 1)}
      stats={[
        {
          label: "Converted",
          value: hTrial.converted == null ? null : count(hTrial.converted),
        },
        { label: "Ended", value: hTrial.ended == null ? null : count(hTrial.ended) },
        {
          label: "New MRR",
          value: hMrrNew == null || !wCur ? null : measureValueCompact(hMrrNew, "money", wCur),
          title: hMrrNew == null || !wCur ? undefined : money(hMrrNew, wCur),
        },
      ]}
    />,
    /* Customer churn does not add up across businesses, so with several the card leads
        with MRR churn, which does. */
    <Headline
      key="churn"
      {...cell}
      icon={TrendingDown}
      label={soleCustChurn ? "Churn, 30 days" : "MRR churn, 30 days"}
      info={
        soleCustChurn
          ? explain(G.customerChurn, G.churned, G.mrrChurnRate, G.mrrLost)
          : explain(G.mrrChurnRate, G.mrrLost)
      }
      value={
        soleCustChurn?.total != null
          ? pctFromBps(soleCustChurn.total, 1)
          : hMrrChurn?.total != null
            ? pctFromBps(hMrrChurn.total, 1)
            : EMPTY_FIGURE
      }
      stats={[
        ...(soleCustChurn
          ? [
              {
                label: "Churned",
                value:
                  soleCustChurn.total_basis === "window" && soleCustChurn.total_numerator != null
                    ? count(soleCustChurn.total_numerator)
                    : null,
              },
              {
                label: "MRR churn",
                value: hMrrChurn?.total == null ? null : pctFromBps(hMrrChurn.total, 1),
              },
            ]
          : []),
        {
          label: "MRR lost",
          value: hChurned == null || !wCur ? null : measureValueCompact(hChurned, "money", wCur),
          title: hChurned == null || !wCur ? undefined : money(hChurned, wCur),
        },
      ]}
    />,
  ];

  // Churn before trial conversion: the order the first row always had.
  const ordered = [cards[0], cards[1], cards[3], cards[2]];
  return <Cells bare={bare}>{ordered}</Cells>;
}

/** The card grid, or nothing around the cells when the panel draws the grid. */
function Cells({ bare, children }: { bare: boolean; children: React.ReactNode }) {
  return bare ? (
    <>{children}</>
  ) : (
    <Grid className="max-lg:gap-4 max-lg:*:col-span-6 max-sm:*:col-span-12">{children}</Grid>
  );
}
