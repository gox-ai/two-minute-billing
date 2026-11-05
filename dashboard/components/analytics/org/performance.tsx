import * as React from "react";
import { Grid, Block, BlockLink, spanClass } from "@/components/analytics/layout";
import { measureValueCompact, chartKindFor } from "@/components/analytics/format";
import { AreaChart } from "@/components/charts/area-chart";
import { CompareDelta } from "@/components/analytics/compare-delta";
import { measurePolarity, stockPoints } from "@/components/analytics/series-format";
import type { ConvertedResult } from "./conversion";
import { BucketBars } from "@/components/analytics/home/charts";
import {
  Lead,
  Line,
  Lines,
  Meter,
  TrialsFunnel,
  netNewParts,
  pick,
  sameCoverage,
  readableKey,
  signedMoney,
  slices,
} from "@/components/analytics/home/parts";
import { money, moneyCompact, pctFromBps } from "@/lib/format";
import { cn } from "@/lib/utils";
import { InfoTip } from "@/components/analytics/info-tip";
import { explain, type CardInfo } from "@/components/analytics/card-info";
import { G } from "@/components/analytics/glossary";
import type { AnalyticsQuery, AnalyticsResult, BatchEntry } from "@/lib/analytics-api";

/**
 * The organization's Performance zone over the page's window: the cards Business Home shows,
 * with the same rates. Retention and customer churn are cohort ratios: the engine adds each
 * business's two halves (money halves converted together, at one rate) and divides once, so
 * a large business weighs more than a small one and no percentage is ever averaged.
 */
export function orgPerformanceQueries(reporting: { currency?: string }): AnalyticsQuery[] {
  // Window totals on month buckets (every measure stores them); charts on the batch's days.
  const P = { range: "30d", grain: "month" } as const;
  return [
    { key: "p_net", measure: "net_new_mrr", ...P, ...reporting },
    { key: "p_new", measure: "mrr_new", ...P, ...reporting },
    { key: "p_expansion", measure: "mrr_expansion", ...P, ...reporting },
    { key: "p_reactivation", measure: "mrr_reactivation", ...P, ...reporting },
    { key: "p_contraction", measure: "mrr_contraction", ...P, ...reporting },
    { key: "p_churn", measure: "mrr_churn", ...P, ...reporting },
    { key: "p_paused", measure: "mrr_paused", ...P, ...reporting },
    { key: "p_quick", measure: "quick_ratio", ...P, ...reporting },
    { key: "p_grr", measure: "gross_revenue_retention", ...P, ...reporting },
    { key: "p_nrr", measure: "net_revenue_retention", ...P, ...reporting },
    // A count ratio: nothing to convert, so no reporting currency.
    { key: "p_cust_churn", measure: "customer_churn_rate", ...P },
    { key: "p_trials", measure: "trials_started", ...P },
    { key: "p_trial_conv", measure: "trial_conversion_rate", ...P },
    { key: "p_activations", measure: "activations", ...P },
    { key: "p_cancellations", measure: "subscription_cancellations", ...P },
    { key: "p_cash", measure: "cash_collected", ...P, ...reporting },
    { key: "p_billed", measure: "billing_gross", ...P, ...reporting },
    { key: "p_recovered", measure: "amount_recovered", ...P, ...reporting },
    { key: "p_refunds", measure: "refunds_issued", ...P, ...reporting },
    { key: "p_attempts", measure: "payment_attempts", ...P },
    { key: "p_failures", measure: "payment_failures", split: "failure_reason", ...P },
    { key: "s_created", measure: "customers_created" },
    { key: "s_churn", measure: "mrr_churn", ...reporting },
  ];
}

const points = (r: AnalyticsResult | null) => ({
  labels: (r?.series ?? []).map((p) => p.label),
  values: (r?.series ?? []).map((p) => p.value ?? null),
});

export function OrgPerformance({
  batch,
  currency,
  mrr,
  onlyBiz,
}: {
  batch: BatchEntry[];
  /** The page's reporting currency — what every money figure here is stated in. */
  currency: string;
  mrr: ConvertedResult;
  /** With one business, cards link into its lists; otherwise into Metrics. */
  onlyBiz: string | null;
}) {
  const r = (key: string) => pick(batch, key);
  const t = (key: string) => r(key)?.total ?? null;
  const count = (n: number) => n.toLocaleString("en");
  const countOrDash = (n: number | null) => (n == null ? "—" : count(n));
  const moneyOrDash = (n: number | null) => (n == null ? "—" : moneyCompact(n, currency));
  const metrics = (measure: string) => `/metrics?measure=${measure}&period=30d`;
  const biz = onlyBiz ? `/businesses/${onlyBiz}` : null;

  const netNew = t("p_net");
  const netParts = netNewParts(
    {
      newMrr: t("p_new"),
      expansion: t("p_expansion"),
      reactivation: t("p_reactivation"),
      contraction: t("p_contraction"),
      churn: t("p_churn"),
      paused: t("p_paused"),
    },
    netNew,
    sameCoverage(
      [
        "p_net",
        "p_new",
        "p_expansion",
        "p_reactivation",
        "p_contraction",
        "p_churn",
        "p_paused",
      ].map(r),
    ),
  );

  const quick = t("p_quick");
  // Same formatting as the business card: one decimal.
  const pctOf = (key: string) => pctFromBps(t(key), 1);
  // "44 of 916": the summed churned and opening customers the org rate divides.
  const cust = r("p_cust_churn");
  const churnOf =
    cust?.total_basis === "window" && cust.total_numerator != null && cust.total_denominator != null
      ? `${count(cust.total_numerator)} of ${count(cust.total_denominator)}`
      : undefined;
  const created = r("s_created");
  const churn = r("s_churn");
  const churnedMrr = churn?.total ?? null;

  const cash = t("p_cash");
  const billed = t("p_billed");
  const collectionRate = cash != null && billed != null && billed > 0 ? cash / billed : null;

  const attempts = t("p_attempts");
  const failures = t("p_failures");
  const reasons = [
    ...slices(r("p_failures"))
      .reduce((acc, d) => {
        const row = acc.get(d.label);
        acc.set(d.label, row ? { ...row, total: row.total + d.total } : d);
        return acc;
      }, new Map<string, ReturnType<typeof slices>[number]>())
      .values(),
  ]
    .sort((a, b) => b.total - a.total)
    .slice(0, 3);

  const activations = t("p_activations");
  const cancellations = t("p_cancellations");
  const subMax = Math.max(activations ?? 0, cancellations ?? 0, 1);

  const rate = (label: string, value: string, note?: string, warn?: boolean, info?: CardInfo) => (
    <div className="flex items-baseline gap-4 py-4 first:pt-0 last:pb-0">
      <span className="min-w-0 flex-1 text-sm text-muted-foreground">
        {label}
        {info ? (
          <span className="ml-1 inline-flex align-middle">
            <InfoTip label={label} info={info} />
          </span>
        ) : null}
        {note ? <span className="block text-xs tabular-nums">{note}</span> : null}
      </span>
      <span className={cn("text-2xl font-semibold tabular-nums", warn && "text-warning")}>
        {value}
      </span>
    </div>
  );

  return (
    <>
      <Grid>
        <Block
          span={8}
          title="MRR trend"
          info={explain(
            G.mrrTrend,
            G.netNewMrr,
            G.newMrr,
            G.expansionReactivation,
            G.churnContraction,
          )}
          fill
          action={onlyBiz ? undefined : <BlockLink href="/metrics">Compare businesses</BlockLink>}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground tabular-nums">
            {mrr.compare?.previous_total != null ? (
              <span>
                {measureValueCompact(mrr.compare.previous_total, mrr.unit, mrr.currency)} →{" "}
                {measureValueCompact(mrr.total, mrr.unit, mrr.currency)}
              </span>
            ) : (
              <span>{measureValueCompact(mrr.total, mrr.unit, mrr.currency)}</span>
            )}
            {mrr.compare ? (
              <CompareDelta compare={mrr.compare} polarity={measurePolarity("mrr")} quiet />
            ) : null}
          </div>
          {mrr.series.length > 1 ? (
            <div className="mt-2 flex-1">
              <AreaChart
                data={stockPoints(mrr)}
                height={220}
                kind={chartKindFor(mrr.unit)}
                currency={mrr.currency ?? currency}
                emphasizeLast
                fitRange
                fill
              />
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 border-t pt-4 text-sm tabular-nums">
            {[
              { label: "Net new MRR", v: netNew, strong: true, hint: undefined },
              ...netParts.map((x) => ({ ...x, v: x.value, strong: false })),
            ].map((x) => (
              <span key={x.label} className="text-muted-foreground" title={x.hint}>
                {x.label}{" "}
                <b
                  className={cn(
                    "font-semibold text-foreground",
                    x.strong && x.v != null && x.v < 0 && "text-destructive",
                  )}
                  title={x.v == null ? undefined : money(x.v, currency)}
                >
                  {signedMoney(x.v, currency)}
                </b>
              </span>
            ))}
          </div>
        </Block>
        <div className={cn(spanClass(4), "flex flex-col gap-6")}>
          <Block span={12} className="flex-1" footer="Period: Last 30 days">
            <div className="flex flex-col divide-y">
              {rate(
                "Quick ratio",
                quick == null ? "—" : `${quick.toFixed(2)}×`,
                quick != null && quick < 1 ? "below 1 = shrinking" : undefined,
                quick != null && quick < 1,
                G.quickRatio,
              )}
              {rate("Gross revenue retention", pctOf("p_grr"), undefined, false, G.grr)}
              {rate("Net revenue retention", pctOf("p_nrr"), undefined, false, G.nrr)}
              {rate("Customer churn", pctOf("p_cust_churn"), churnOf, false, G.customerChurn)}
            </div>
          </Block>
          {t("p_trials") != null ? (
            <Block span={12} title="Trials" info={G.trials}>
              <TrialsFunnel started={t("p_trials")} rate={r("p_trial_conv")} />
            </Block>
          ) : null}
        </div>
      </Grid>

      <Grid>
        <Block
          span={6}
          title="New accounts"
          info={G.newAccounts}
          action={
            <BlockLink href={biz ? `${biz}/customers` : metrics("customers_created")}>
              {biz ? "Customers" : "Explore"}
            </BlockLink>
          }
        >
          <Lead
            value={countOrDash(created?.total ?? null)}
            note={
              created?.total != null
                ? `${(created.total / 30).toFixed(created.total / 30 < 10 ? 1 : 0)} a day`
                : undefined
            }
          />
          <div className="mt-3">
            <BucketBars
              labels={points(created).labels}
              values={points(created).values}
              seriesLabel="New accounts"
              tone="soft"
              kind="count"
            />
          </div>
        </Block>
        <Block
          span={6}
          title="Churn"
          info={G.churnCard}
          action={<BlockLink href={metrics("mrr_churn")}>Explore</BlockLink>}
        >
          <Lead
            value={
              churnedMrr == null
                ? "—"
                : churnedMrr === 0
                  ? moneyCompact(0, currency)
                  : `−${moneyCompact(churnedMrr, currency)}`
            }
            title={churnedMrr == null ? undefined : money(churnedMrr, currency)}
            tone={churnedMrr ? "loss" : undefined}
            note="churned MRR"
          />
          <div className="mt-3">
            <BucketBars
              labels={points(churn).labels}
              values={points(churn).values}
              seriesLabel="Churned MRR"
              tone="loss"
              kind="money"
              currency={churn?.currency ?? currency}
            />
          </div>
        </Block>
      </Grid>

      <Grid>
        <Block
          span={4}
          title="Cash"
          info={explain(G.cashCard, G.recoveredByDunning, G.refunds)}
          action={
            <BlockLink
              href={
                biz
                  ? `${biz}/transactions?filter=type:is:payment&filter=status:is:success`
                  : metrics("cash_collected")
              }
            >
              {biz ? "Payments" : "Explore"}
            </BlockLink>
          }
        >
          <Lead
            value={moneyOrDash(cash)}
            title={cash == null ? undefined : money(cash, currency)}
            note="collected"
          />
          {collectionRate != null ? (
            <div className="mt-4 flex flex-col gap-2">
              <Meter fraction={Math.min(collectionRate, 1)} />
              <span className="text-xs text-muted-foreground tabular-nums">
                {pctFromBps(Math.round(collectionRate * 10000), 1)} of{" "}
                {moneyCompact(billed!, currency)} billed
              </span>
            </div>
          ) : null}
          <div className="mt-4 border-t pt-4">
            <Lines>
              <Line label="Recovered by dunning" value={moneyOrDash(t("p_recovered"))} />
              <Line label="Refunds" value={moneyOrDash(t("p_refunds"))} />
            </Lines>
          </div>
        </Block>
        <Block
          span={4}
          title="Failed payments"
          info={G.failedPayments}
          action={<BlockLink href={metrics("payment_failures")}>Explore</BlockLink>}
        >
          <Lead
            value={countOrDash(failures)}
            note={
              failures != null && attempts != null && attempts > 0
                ? `of ${count(attempts)} · ${pctFromBps(Math.round((failures / attempts) * 10000), 1)}`
                : undefined
            }
          />
          {reasons.length > 0 ? (
            <div className="mt-4 border-t pt-4">
              <Lines>
                {reasons.map((x) => (
                  <Line key={x.key} label={readableKey(x.label)} value={count(x.total)} />
                ))}
              </Lines>
            </div>
          ) : null}
        </Block>
        <Block
          span={4}
          title="Subscriptions"
          info={G.orgSubscriptions}
          action={
            <BlockLink href={biz ? `${biz}/subscriptions` : metrics("activations")}>
              {biz ? "Subscriptions" : "Explore"}
            </BlockLink>
          }
        >
          <Lead
            value={
              activations == null || cancellations == null
                ? "—"
                : `${activations - cancellations > 0 ? "+" : activations - cancellations < 0 ? "−" : ""}${count(Math.abs(activations - cancellations))}`
            }
            tone={
              activations != null && cancellations != null && activations < cancellations
                ? "loss"
                : undefined
            }
            note="net"
          />
          {activations != null && cancellations != null ? (
            <div className="mt-4 flex flex-col gap-2 text-xs text-muted-foreground tabular-nums">
              {[
                { label: `${count(activations)} started`, v: activations, fill: "bg-chart-1" },
                {
                  label: `${count(cancellations)} cancelled`,
                  v: cancellations,
                  fill: "bg-chart-5",
                },
              ].map((b) => (
                <div key={b.label} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <Meter fraction={b.v / subMax} fill={b.fill} />
                  </span>
                  <span className="shrink-0 whitespace-nowrap">{b.label}</span>
                </div>
              ))}
            </div>
          ) : null}
        </Block>
      </Grid>
    </>
  );
}
