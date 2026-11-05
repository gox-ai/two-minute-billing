import * as React from "react";
import Link from "next/link";
import {
  Activity,
  CircleDollarSign,
  Coins,
  Hourglass,
  ShoppingBag,
  TrendingDown,
  Users,
} from "lucide-react";
import { AreaChart } from "@/components/charts/area-chart";
import { Alert } from "@/components/ui/alert";
import { CompareDelta } from "@/components/analytics/compare-delta";
import { measurePolarity, stockPoints } from "@/components/analytics/series-format";
import { chartKindFor } from "@/components/analytics/format";
import { Grid, Block, BlockLink, Stack, spanClass } from "@/components/analytics/layout";
import { money, moneyCompact, pctFromBps } from "@/lib/format";
import { cn } from "@/lib/utils";
import { InfoTip } from "@/components/analytics/info-tip";
import { explain, type CardInfo } from "@/components/analytics/card-info";
import { G } from "@/components/analytics/glossary";
import type { BatchEntry, AnalyticsResult } from "@/lib/analytics-api";
import { BucketBars } from "./charts";
import {
  AttentionStrip,
  Headline,
  Lead,
  Meter,
  TrialsFunnel,
  trialHalves,
  betweenFilter,
  type LinkWindow,
  Line,
  Lines,
  SegmentBar,
  daysIn,
  localYmd,
  netNewParts,
  pick,
  sameCoverage,
  slice,
  seriesChange,
  readMovement,
  readableKey,
  signedMoney,
  slices,
  type AttentionItem,
  type Basis,
} from "./parts";

/** The engine's own refusal, shown as it wrote it, plus the currencies it CAN answer for. */
export function Refusal({ entry, biz }: { entry: BatchEntry; biz: string }) {
  if (entry.object !== "analytics_error") return null;
  const { message, param, options } = entry.error;
  return (
    <Alert tone="warning" title="Not available at this currency setting">
      <p>{message}</p>
      {param === "currency" && options && options.length > 0 ? (
        <p className="mt-2 flex flex-wrap gap-2">
          {options.map((c) => (
            <Link
              key={c}
              href={`/businesses/${biz}?currency=${encodeURIComponent(c)}`}
              className="rounded-md border bg-card px-2 py-0.5 text-xs font-medium hover:bg-accent"
            >
              {c}
            </Link>
          ))}
        </p>
      ) : null}
    </Alert>
  );
}

/** A series' points, gaps kept as gaps. */
const points = (r: AnalyticsResult | null) => ({
  labels: (r?.series ?? []).map((p) => p.label),
  values: (r?.series ?? []).map((p) => p.value ?? null),
});

/**
 * Overview, as two zones. Current: the queues that want a person and the book as it stands.
 * Performance: how MRR, accounts, churn, cash and payments moved over the period.
 */
export function overviewZones({
  biz,
  basis,
  batch,
  unchargeable,
  queues = [],
  linkWindow,
  windowLabel,
  modelLed = null,
}: {
  biz: string;
  basis: Basis;
  /** Every semantic-layer answer this view shows, from the one batched POST. */
  batch: BatchEntry[];
  /** Active, auto-collecting customers with no working payment method (customers list count). */
  unchargeable?: { total: number; noMethod: number; expiring: number } | null;
  /** Conditional strip cells, already filtered to the non-empty ones (`queueItems`). */
  queues?: AttentionItem[];
  /** The dates each card's link filters its list to. */
  linkWindow?: LinkWindow;
  /** The Performance window's name, printed under the rates so a 30-day rate is not read as a year's. */
  windowLabel?: string;
  /**
   * No subscriptions, but these models: the headline leads with revenue of every kind and one
   * card per model, and the MRR trend and churn are not drawn. Null: today's headline.
   */
  modelLed?: ReadonlyArray<"credits" | "usage" | "sales"> | null;
}): { current: React.ReactNode; performance: React.ReactNode } {
  const cur = basis.currency;
  const tz = basis.tz;
  const count = (n: number) => n.toLocaleString("en");
  const countOrDash = (n: number | null | undefined) => (n == null ? "—" : count(n));
  const moneyOrDash = (n: number | null | undefined) => (n == null ? "—" : moneyCompact(n, cur));
  const total = (key: string) => pick(batch, key)?.total ?? null;

  /* ------------------------------------------------------------- current */

  const mrrNow = total("mrr_now");
  const arr = total("arr");
  const cmrr = total("cmrr");
  const arpa = pick(batch, "arpa");
  const payingNow = total("cust_paying_now");
  const payingSubs = total("subs_paying");
  const renewingSubs = total("subs_renewing");
  // The headline row reads a fixed 30 days, independent of the Performance period.
  const mrrChange = seriesChange(pick(batch, "h_mrr"), "30 days");
  const payingChange = seriesChange(pick(batch, "h_paying"), "30 days", "count");
  const hCustChurn = pick(batch, "h_cust_churn");
  const hMrrChurn = pick(batch, "h_mrr_churn");
  const hChurned = total("h_churned");
  const hTrial = trialHalves(pick(batch, "h_trial_conv"));
  const hTrialConv = total("h_trial_conv");
  const hMrrNew = total("h_mrr_new");
  // Each sparkline is the same 30-day series its card's change is measured across.
  const mrrSpark = (pick(batch, "h_mrr")?.series ?? []).map((p) => p.value ?? null);
  const payingSpark = (pick(batch, "h_paying")?.series ?? []).map((p) => p.value ?? null);
  const churnOf30 =
    hCustChurn?.total_basis === "window" &&
    hCustChurn.total_numerator != null &&
    hCustChurn.total_denominator != null
      ? `${count(hCustChurn.total_numerator)} of ${count(hCustChurn.total_denominator)} customers`
      : null;

  // Paying customers holding an expiring card — the list's count, not the measure's card count.
  const cardsExpiring = unchargeable?.expiring ?? null;
  const atRisk = pick(batch, "mrr_at_risk");
  const inDunning = total("dunning_subs");
  // Every band, not just the next 30 days: Committed subtracts them all, and the link lists them all.
  const cancelling = pick(batch, "sched_cancel")?.total ?? null;
  const cancelCur = pick(batch, "sched_cancel")?.currency ?? cur;

  // Three core queues always, none of them a figure the tiles above already show; an empty one
  // reads a quiet zero so the strip keeps its shape. Up to three more appear only while
  // non-empty. Receivables live on the Money tab: they mix tax, one-offs and debt on cancelled
  // subscriptions, so they are not a queue.
  const atRiskMinor = atRisk?.total ?? 0;
  const stuck = unchargeable?.total ?? 0;
  const badCard = stuck - (unchargeable?.noMethod ?? 0);
  const stuckNote = [
    badCard > 0 ? `${count(badCard)} expired or invalid` : null,
    unchargeable?.noMethod ? `${count(unchargeable.noMethod)} no method` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const allAttention: AttentionItem[] = [
    {
      key: "at_risk",
      label: "MRR at risk",
      value: money(atRiskMinor, atRisk?.currency ?? cur),
      note: inDunning ? `${count(inDunning)} in dunning` : undefined,
      href: `/businesses/${biz}/retries`,
      tone: atRiskMinor > 0 ? "attention" : "neutral",
      info: G.mrrAtRisk,
    },
    {
      key: "cannot_charge",
      label: "Cannot be charged",
      value: unchargeable ? count(stuck) : "—",
      note: stuckNote || undefined,
      href: `/businesses/${biz}/customers?filter=cannot_be_charged:is:true`,
      tone: stuck > 0 ? "attention" : "neutral",
      info: G.cantBeCharged,
    },
    {
      key: "cards",
      label: "Cards expiring",
      value: cardsExpiring == null ? "—" : count(cardsExpiring),
      note: "next 90 days",
      href: `/businesses/${biz}/customers?filter=payment_method_expiring:is:true&filter=renewing:is:true`,
      tone: cardsExpiring ? "warning" : "neutral",
      info: G.cardsExpiring,
    },
    ...queues,
  ];
  // MRR at risk and expiring cards on renewing subscriptions mean nothing without subscriptions.
  const attention = allAttention.filter(
    (item) => !modelLed || (item.key !== "at_risk" && item.key !== "cards"),
  );

  const subsHref = `/businesses/${biz}/subscriptions`;
  const modelSpan = (modelLed ? ([12, 6, 4, 3] as const)[Math.min(modelLed.length, 3)] : 3) as
    | 12
    | 6
    | 4
    | 3;
  const hmRev = pick(batch, "hm_rev");
  const tabHref = (t: string) => `/businesses/${biz}?tab=${t}`;
  const modelHeadline = modelLed ? (
    <Grid>
      <Headline
        span={modelSpan}
        label="Revenue, 30 days"
        icon={CircleDollarSign}
        info={explain(G.revenueMix)}
        spark={(pick(batch, "hm_rev_series")?.series ?? []).map((p) => p.value ?? null)}
        value={moneyOrDash(hmRev?.total)}
        title={hmRev?.total == null ? undefined : money(hmRev.total, cur)}
        note="billed, before tax"
        stats={[
          {
            label: "Collected",
            value: total("hm_collected") == null ? null : moneyCompact(total("hm_collected")!, cur),
          },
          {
            label: "Customers",
            value: total("hm_customers") == null ? null : count(total("hm_customers")!),
          },
          {
            label: "Per customer",
            value:
              total("hm_per_customer") == null
                ? null
                : moneyCompact(total("hm_per_customer")!, cur),
          },
        ]}
      />
      {modelLed.includes("credits") ? (
        <Headline
          span={modelSpan}
          label="Credit balance"
          icon={Coins}
          info={explain(G.creditBalance, G.creditLiability)}
          value={moneyOrDash(total("pr_credit"))}
          note="face value"
          stats={[
            {
              label: "Liability",
              value:
                total("hm_liability") == null ? null : moneyCompact(total("hm_liability")!, cur),
            },
            {
              label: "Used, 30 days",
              value: total("hm_used") == null ? null : moneyCompact(total("hm_used")!, cur),
            },
            { label: "Credits", value: "View", href: tabHref("credits") },
          ]}
        />
      ) : null}
      {modelLed.includes("usage") ? (
        <Headline
          span={modelSpan}
          label="Usage revenue, 30 days"
          icon={Activity}
          info={G.usageRevenue}
          value={moneyOrDash(slice(hmRev, "usage"))}
          stats={[
            {
              label: "Events",
              value: total("hm_events") == null ? null : count(total("hm_events")!),
            },
            { label: "Usage", value: "View", href: tabHref("usage") },
          ]}
        />
      ) : null}
      {modelLed.includes("sales") ? (
        <Headline
          span={modelSpan}
          label="Orders, 30 days"
          icon={ShoppingBag}
          info={G.orders}
          value={countOrDash(total("hm_orders"))}
          stats={[
            {
              label: "Average order",
              value: total("hm_aov") == null ? null : moneyCompact(total("hm_aov")!, cur),
            },
            { label: "One-time sales", value: "View", href: tabHref("sales") },
          ]}
        />
      ) : null}
    </Grid>
  ) : null;
  const current = (
    <Stack>
      {modelHeadline ?? (
        <Grid>
          <Headline
            span={3}
            label="MRR"
            icon={CircleDollarSign}
            info={explain(G.mrr, G.arr, G.cmrr, G.cancelling)}
            change={mrrChange}
            spark={mrrSpark}
            value={moneyOrDash(mrrNow)}
            title={mrrNow == null ? undefined : money(mrrNow, cur)}
            stats={[
              {
                label: "ARR",
                value: arr == null ? null : moneyCompact(arr, cur),
                title: arr == null ? undefined : money(arr, cur),
              },
              {
                label: "Committed",
                value: cmrr == null ? null : moneyCompact(cmrr, cur),
                title: cmrr == null ? undefined : money(cmrr, cur),
              },
              {
                label: "Cancelling",
                value: cancelling == null ? null : moneyCompact(cancelling, cancelCur),
                title:
                  cancelling == null
                    ? undefined
                    : `${money(cancelling, cancelCur)} of MRR booked to cancel`,
                href: `/businesses/${biz}/subscriptions?status=non_renewing`,
              },
            ]}
          />
          <Headline
            span={3}
            label="Paying customers"
            icon={Users}
            info={explain(G.payingCustomers, G.arpa, G.payingSubs, G.renewing)}
            change={payingChange}
            spark={payingSpark}
            value={countOrDash(payingNow)}
            stats={[
              {
                label: "ARPC",
                value:
                  arpa?.total == null ? null : money(Math.round(arpa.total), arpa.currency ?? cur),
              },
              // Paying includes subscriptions booked to stop at term end; renewing excludes them.
              {
                label: "Paying subs",
                value: payingSubs == null ? null : count(payingSubs),
                href: `${subsHref}?filter=status:in:active,non_renewing&filter=mrr:gt:0`,
              },
              {
                label: "Renewing",
                value: renewingSubs == null ? null : count(renewingSubs),
                href: `${subsHref}?filter=status:is:active&filter=mrr:gt:0`,
              },
            ]}
          />
          <Headline
            span={3}
            label="Churn, 30 days"
            icon={TrendingDown}
            info={explain(G.customerChurn, G.churned, G.mrrChurnRate, G.mrrLost)}
            value={hCustChurn?.total == null ? "—" : pctFromBps(hCustChurn.total, 1)}
            note={churnOf30}
            stats={[
              {
                label: "Churned",
                value:
                  hCustChurn?.total_basis === "window" && hCustChurn.total_numerator != null
                    ? count(hCustChurn.total_numerator)
                    : null,
              },
              {
                label: "MRR churn",
                value: hMrrChurn?.total == null ? null : pctFromBps(hMrrChurn.total, 1),
              },
              {
                label: "MRR lost",
                value: hChurned == null ? null : moneyCompact(hChurned, cur),
                title: hChurned == null ? undefined : money(hChurned, cur),
                href: `/businesses/${biz}/reports/cancellations`,
              },
            ]}
          />
          <Headline
            span={3}
            label="Trial conversion, 30 days"
            icon={Hourglass}
            featured
            info={explain(G.trialConversion, G.trialsConverted, G.trialsEnded, G.newMrr30)}
            value={hTrialConv == null ? "—" : pctFromBps(hTrialConv, 1)}
            note={
              hTrial.converted != null && hTrial.ended
                ? `${count(hTrial.converted)} of ${count(hTrial.ended)} ended trials converted`
                : null
            }
            stats={[
              {
                label: "Converted",
                value: hTrial.converted == null ? null : count(hTrial.converted),
              },
              {
                label: "Ended",
                value: hTrial.ended == null ? null : count(hTrial.ended),
              },
              {
                label: "New MRR",
                value: hMrrNew == null ? null : moneyCompact(hMrrNew, cur),
                title: hMrrNew == null ? undefined : money(hMrrNew, cur),
                href: `/businesses/${biz}?tab=recurring`,
              },
            ]}
          />
        </Grid>
      )}
      <AttentionStrip items={attention} />
    </Stack>
  );

  /* --------------------------------------------------------- performance */

  const mrrEntry = batch.find((e) => e.key === "mrr");
  const mrr = pick(batch, "mrr");
  const move = readMovement(batch);
  const netNew = total("m_net");
  const netComparable = sameCoverage(
    ["m_net", "m_new", "m_expansion", "m_reactivation", "m_contraction", "m_churn", "m_paused"].map(
      (k) => pick(batch, k),
    ),
  );

  const custChurn = pick(batch, "cust_churn_rate");
  const churnOf =
    custChurn?.total_basis === "window" &&
    custChurn.total_numerator != null &&
    custChurn.total_denominator != null
      ? `${count(custChurn.total_numerator)} of ${count(custChurn.total_denominator)}`
      : null;

  const created = pick(batch, "created_series");
  const newPayingSeries = pick(batch, "new_paying_series");
  const createdPts = points(created);
  const createdTotal = created?.total ?? null;
  const windowDays = created
    ? daysIn(localYmd(created.range.start, tz), localYmd(created.range.end, tz))
    : null;

  const churnSeries = pick(batch, "churn_series");
  const churnPts = points(churnSeries);
  const churnedMrr = churnSeries?.total ?? null;
  const churnedCustomers = total("cust_churned");

  const newPaying = total("cust_new");
  const netPaying =
    newPaying != null && churnedCustomers != null ? newPaying - churnedCustomers : null;
  const barMax = Math.max(newPaying ?? 0, churnedCustomers ?? 0, 1);

  const cash = total("p_cash");
  const billed = total("p_billed");
  const collectionRate = cash != null && billed != null && billed > 0 ? cash / billed : null;

  const attempts = total("gw_attempts");
  const failures = total("gw_failures");
  const reasons = [
    ...slices(pick(batch, "gw_failures"))
      .reduce((acc, d) => {
        const row = acc.get(d.label);
        acc.set(d.label, row ? { ...row, total: row.total + d.total } : d);
        return acc;
      }, new Map<string, ReturnType<typeof slices>[number]>())
      .values(),
  ]
    .sort((a, b) => b.total - a.total)
    .slice(0, 3);

  // Churn by kind: drawn only once the engine attributes it, never from the unattributed rest.
  const kindOf = (k: string) => slices(pick(batch, "churn_kind")).find((r) => r.key === k) ?? null;
  const churnKinds = [
    { key: "voluntary", label: "Voluntary", row: kindOf("voluntary"), fill: "bg-muted-foreground" },
    { key: "involuntary", label: "Involuntary", row: kindOf("involuntary"), fill: "bg-chart-5" },
  ].filter((k) => k.row != null && k.row.total > 0);
  // The same split per bucket, matched to the churn bars by bucket start.
  const involuntaryAt = new Map(
    (
      pick(batch, "churn_kind")?.split?.series.find((r) => r.key === "involuntary")?.points ?? []
    ).map((p) => [p.t, p.value ?? 0]),
  );
  const churnInvoluntary =
    churnKinds.length > 0
      ? (churnSeries?.series ?? []).map((p) => involuntaryAt.get(p.t) ?? 0)
      : undefined;

  // Trials started, and those that converted out of the ones that ended, in the period.
  const trialsStarted = pick(batch, "trials_started");
  const trialRate = pick(batch, "trial_conv");
  const funnel = trialsStarted?.total != null;

  const quick = move.quickRatio;
  const pct = (bps: number | null) => (bps == null ? "—" : pctFromBps(bps, 1));
  const rate = (
    label: string,
    value: string,
    note?: React.ReactNode,
    warn?: boolean,
    info?: CardInfo,
  ) => (
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
      <span className={cn("text-2xl font-medium tabular-nums", warn && "text-warning")}>
        {value}
      </span>
    </div>
  );

  // Revenue mix: what each revenue type billed and collected in the period.
  const MIX = [
    { key: "recurring", fill: "bg-chart-1" },
    { key: "usage", fill: "bg-chart-2" },
    { key: "one_time", fill: "bg-chart-4" },
    { key: "credit_pack", fill: "bg-chart-3" },
  ];
  const mixBilled = pick(batch, "rev_mix");
  const mixCash = pick(batch, "rev_mix_cash");
  const mixRows = MIX.map((m) => {
    const row = slices(mixBilled).find((r) => r.key === m.key);
    return row ? { ...m, label: row.label, billed: row.total, cash: slice(mixCash, m.key) } : null;
  }).filter((r) => r != null);
  // A subscription-only business has nothing to compare, so the card is not drawn.
  const showMix = mixRows.some((r) => r.key !== "recurring");
  const mixTotal = mixBilled?.total ?? null;
  const mixWidest = Math.max(...mixRows.map((r) => Math.abs(r.billed)), 1);

  const performance = (
    <Stack>
      {modelLed ? null : (
        <Grid>
          {mrr ? (
            <Block
              span={8}
              flat
              title="MRR trend"
              info={explain(
                G.mrrTrend,
                G.netNewMrr,
                G.newMrr,
                G.expansionReactivation,
                G.churnContraction,
              )}
              fill
              action={<BlockLink href={`/businesses/${biz}?tab=recurring`}>MRR movement</BlockLink>}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground tabular-nums">
                {mrr.compare?.previous_total != null ? (
                  <span>
                    {moneyCompact(mrr.compare.previous_total, mrr.currency ?? cur)} →{" "}
                    {moneyCompact(mrr.total, mrr.currency ?? cur)}
                  </span>
                ) : (
                  <span>{moneyCompact(mrr.total, mrr.currency ?? cur)}</span>
                )}
                {mrr.compare ? (
                  <CompareDelta
                    compare={mrr.compare}
                    polarity={measurePolarity(mrr.measure)}
                    quiet
                  />
                ) : null}
              </div>
              <div className="mt-2 flex-1">
                <AreaChart
                  data={stockPoints(mrr)}
                  height={220}
                  kind={chartKindFor(mrr.unit)}
                  currency={mrr.currency ?? cur}
                  emphasizeLast
                  fitRange
                  fill
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 border-t pt-4 text-sm tabular-nums">
                {[
                  { label: "Net new MRR", v: netNew, strong: true, hint: undefined },
                  ...netNewParts(move, netNew, netComparable).map((x) => ({
                    ...x,
                    v: x.value,
                    strong: false,
                  })),
                ].map((x) => (
                  <span key={x.label} className="text-muted-foreground" title={x.hint}>
                    {x.label}{" "}
                    <b
                      className={cn(
                        "font-semibold text-foreground",
                        x.strong && x.v != null && x.v < 0 && "text-destructive",
                      )}
                      title={x.v == null ? undefined : money(x.v, cur)}
                    >
                      {signedMoney(x.v, cur)}
                    </b>
                  </span>
                ))}
              </div>
            </Block>
          ) : mrrEntry ? (
            <div className="col-span-12 xl:col-span-8">
              <Refusal entry={mrrEntry} biz={biz} />
            </div>
          ) : null}
          <div className={cn(spanClass(4), "flex flex-col gap-6")}>
            <Block
              span={12}
              className="flex-1"
              footer={windowLabel ? `Period: ${windowLabel}` : undefined}
            >
              <div className="flex flex-col divide-y">
                {rate(
                  "Quick ratio",
                  quick == null ? "—" : `${quick.toFixed(2)}×`,
                  quick != null && quick < 1 ? "below 1 = shrinking" : undefined,
                  quick != null && quick < 1,
                  G.quickRatio,
                )}
                {rate("Gross revenue retention", pct(move.grossBps), undefined, false, G.grr)}
                {rate("Net revenue retention", pct(move.netBps), undefined, false, G.nrr)}
                {rate(
                  "Customer churn",
                  pct(custChurn?.total ?? null),
                  churnOf,
                  false,
                  G.customerChurn,
                )}
              </div>
            </Block>
            {funnel ? (
              <Block
                span={12}
                flat
                title="Trials"
                info={G.trials}
                action={
                  <BlockLink href={`/businesses/${biz}/subscriptions?status=in_trial`}>
                    In trial
                  </BlockLink>
                }
              >
                <TrialsFunnel started={trialsStarted?.total ?? null} rate={trialRate} />
              </Block>
            ) : null}
          </div>
        </Grid>
      )}

      <Grid>
        <Block
          span={modelLed ? 12 : 6}
          title="New accounts"
          info={explain(G.newAccounts, G.newPaying)}
          action={
            <BlockLink
              href={`/businesses/${biz}/customers?${betweenFilter("created_at", linkWindow).slice(1)}`}
            >
              Customers
            </BlockLink>
          }
        >
          <Lead
            value={countOrDash(createdTotal)}
            note={
              createdTotal != null && windowDays
                ? `${(createdTotal / windowDays).toFixed(createdTotal / windowDays < 10 ? 1 : 0)} a day`
                : undefined
            }
          />
          <div className="mt-3">
            <BucketBars
              labels={createdPts.labels}
              values={createdPts.values}
              markers={points(newPayingSeries).values}
              markerLabel="New paying"
              seriesLabel="New accounts"
              tone="brand"
              kind="count"
            />
          </div>
          {newPayingSeries ? (
            <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-sm bg-chart-1" aria-hidden />
                New accounts
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-foreground" aria-hidden />
                New paying
              </span>
            </div>
          ) : null}
        </Block>
        {modelLed ? null : (
          <Block
            span={6}
            title="Churn"
            info={explain(G.churnCard, churnKinds.length > 0 && G.churnKind, G.churnedCustomers)}
            action={
              <BlockLink href={`/businesses/${biz}/reports/cancellations`}>
                Cancellations report
              </BlockLink>
            }
          >
            <Lead
              value={
                churnedMrr == null
                  ? "—"
                  : churnedMrr === 0
                    ? moneyCompact(0, cur)
                    : `−${moneyCompact(churnedMrr, cur)}`
              }
              title={churnedMrr == null ? undefined : money(churnedMrr, cur)}
              tone={churnedMrr ? "loss" : undefined}
              note={
                churnedCustomers == null
                  ? undefined
                  : `${count(churnedCustomers)} ${churnedCustomers === 1 ? "customer" : "customers"}`
              }
            />
            <div className="mt-3">
              <BucketBars
                labels={churnPts.labels}
                values={churnPts.values}
                seriesLabel="Churned MRR"
                part={
                  churnInvoluntary ? { label: "Involuntary", values: churnInvoluntary } : undefined
                }
                tone="loss"
                kind="money"
                currency={churnSeries?.currency ?? cur}
              />
            </div>
            {churnKinds.length > 0 ? (
              <div className="mt-4 flex flex-col gap-2 border-t pt-4">
                <SegmentBar
                  label="Churned MRR by kind"
                  parts={churnKinds.map((k) => ({ key: k.key, value: k.row!.total, fill: k.fill }))}
                />
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
                  {churnKinds.map((k) => (
                    <span key={k.key} className="flex items-center gap-1.5">
                      <span className={cn("size-2 rounded-sm", k.fill)} aria-hidden />
                      {k.label} {moneyCompact(k.row!.total, cur)}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </Block>
        )}
      </Grid>

      {showMix ? (
        <Grid>
          <Block
            span={12}
            title="Revenue mix"
            info={G.revenueMix}
            action={
              <BlockLink
                href={`/businesses/${biz}/reports/explore?m=revenue_billed&m=revenue_collected&dim=revenue_type`}
              >
                Explore
              </BlockLink>
            }
          >
            <Lead
              value={moneyOrDash(mixTotal)}
              title={mixTotal == null ? undefined : money(mixTotal, cur)}
              note="billed, before tax"
            />
            <div className="mt-4">
              <SegmentBar
                label="Revenue billed by type"
                parts={mixRows
                  .filter((r) => r.billed > 0)
                  .map((r) => ({ key: r.key, value: r.billed, fill: r.fill }))}
              />
            </div>
            <div className="mt-4 flex flex-col divide-y border-t">
              {mixRows.map((r) => (
                <div
                  key={r.key}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-sm last:pb-0"
                >
                  <span className="flex min-w-0 flex-[1_1_10rem] items-center gap-2">
                    <span className={cn("size-2 shrink-0 rounded-sm", r.fill)} aria-hidden />
                    {r.label}
                  </span>
                  <span className="w-24 shrink-0">
                    <Meter fraction={Math.max(0, r.billed) / mixWidest} fill={r.fill} />
                  </span>
                  <span className="w-24 shrink-0 text-right font-medium tabular-nums">
                    {moneyCompact(r.billed, cur)}
                  </span>
                  <span className="w-32 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                    {r.cash == null ? "—" : `${moneyCompact(r.cash, cur)} collected`}
                  </span>
                </div>
              ))}
            </div>
          </Block>
        </Grid>
      ) : null}

      <Grid>
        {modelLed ? null : (
          <Block
            span={4}
            title="Paying customers"
            info={explain(G.netPaying, G.newPaying, G.churnedCustomers, G.newAccounts)}
            action={
              <BlockLink href={`/businesses/${biz}/customers?filter=paying:is:true`}>
                Customers
              </BlockLink>
            }
          >
            <Lead
              value={
                netPaying == null
                  ? "—"
                  : netPaying > 0
                    ? `+${count(netPaying)}`
                    : netPaying < 0
                      ? `−${count(-netPaying)}`
                      : "0"
              }
              tone={netPaying != null && netPaying < 0 ? "loss" : undefined}
              note={payingNow == null ? "net" : `net, now ${count(payingNow)}`}
            />
            {newPaying != null && churnedCustomers != null ? (
              <div className="mt-4 flex flex-col gap-2 text-xs text-muted-foreground tabular-nums">
                {[
                  { label: `${count(newPaying)} new paying`, v: newPaying, fill: "bg-chart-1" },
                  {
                    label: `${count(churnedCustomers)} left`,
                    v: churnedCustomers,
                    fill: "bg-muted-foreground",
                  },
                ].map((b) => (
                  <div key={b.label} className="flex items-center gap-3">
                    <span className="min-w-0 flex-1">
                      <Meter fraction={b.v / barMax} fill={b.fill} />
                    </span>
                    <span className="shrink-0 whitespace-nowrap">{b.label}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="mt-4 border-t pt-4">
              <Lines>
                <Line label="New accounts" value={countOrDash(createdTotal)} />
              </Lines>
            </div>
          </Block>
        )}
        <Block
          span={modelLed ? 6 : 4}
          title="Cash"
          info={explain(G.cashCard, G.recoveredByDunning, G.refunds)}
          action={
            <BlockLink
              href={`/businesses/${biz}/transactions?filter=type:is:payment&filter=status:is:success${betweenFilter("occurred_at", linkWindow)}`}
            >
              Payments
            </BlockLink>
          }
        >
          <Lead
            value={moneyOrDash(cash)}
            title={cash == null ? undefined : money(cash, cur)}
            note="collected"
          />
          {collectionRate != null ? (
            <div className="mt-4 flex flex-col gap-2">
              <Meter fraction={collectionRate} />
              <span className="text-xs text-muted-foreground tabular-nums">
                {pctFromBps(Math.round(collectionRate * 10000), 1)} of {moneyCompact(billed!, cur)}{" "}
                billed
              </span>
            </div>
          ) : null}
          <div className="mt-4 border-t pt-4">
            <Lines>
              <Line label="Recovered by dunning" value={moneyOrDash(total("recovered"))} />
              <Line label="Refunds" value={moneyOrDash(total("refunds"))} />
            </Lines>
          </div>
        </Block>
        <Block
          span={modelLed ? 6 : 4}
          title="Failed payments"
          info={G.failedPayments}
          action={
            <BlockLink href={`/businesses/${biz}?tab=collections`}>Why they failed</BlockLink>
          }
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
            // Each reason's share of the failures, as a bar beside its count.
            <div className="mt-4 flex flex-col divide-y border-t">
              {reasons.map((r) => (
                <div key={r.key} className="flex items-center gap-3 py-2.5 text-sm last:pb-0">
                  <span className="min-w-0 flex-1 text-muted-foreground">
                    {readableKey(r.label)}
                  </span>
                  <span className="w-16 shrink-0">
                    <Meter fraction={failures ? r.total / failures : 0} fill="bg-destructive" />
                  </span>
                  <span className="w-10 shrink-0 text-right font-medium tabular-nums">
                    {count(r.total)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </Block>
      </Grid>
    </Stack>
  );

  return { current, performance };
}
