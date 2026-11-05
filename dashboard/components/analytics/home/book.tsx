import * as React from "react";
import Link from "next/link";
import { Grid, Stack, Block, BlockLink } from "@/components/analytics/layout";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { measureValue } from "@/components/analytics/format";
import { money, moneyCompact, pctFromBps } from "@/lib/format";
import { cn } from "@/lib/utils";
import { InfoTip } from "@/components/analytics/info-tip";
import type { CardInfo } from "@/components/analytics/card-info";
import { G } from "@/components/analytics/glossary";
import type { AnalyticsResult, BatchEntry } from "@/lib/analytics-api";
import type { ReportResult } from "@/lib/api";
import { MovementBars } from "./charts";
import {
  BarList,
  Line,
  Lines,
  MovementWaterfall,
  ScheduledChanges,
  pick,
  readMovement,
  scheduledRows,
  slices,
  countryName,
  exploreHref,
  type Basis,
  type LinkWindow,
} from "./parts";

/** A flow's series by bucket label, so five flows line up on one axis. */
function byLabel(r: AnalyticsResult | null): Map<string, number | null> {
  return new Map((r?.series ?? []).map((p) => [p.label, p.value ?? null]));
}

/**
 * Recurring revenue, as two zones. Current: MRR by plan and the changes already booked.
 * Performance: the period's movement, the rates that divide out of it, the movement per
 * bucket and per plan, and what a subscription and a customer are worth.
 *
 * Every rate is folded once by the engine on its own numerator and denominator — never the
 * mean of a set of rates, and never averaged across plans.
 */
export function recurringZones({
  biz,
  basis,
  batch,
  topCustomers,
  linkWindow,
}: {
  biz: string;
  basis: Basis;
  /** Every semantic-layer answer this view shows, from the one batched POST. */
  batch: BatchEntry[];
  /** Live MRR per customer, largest first; its tail row ("All other accounts") has no id. */
  topCustomers?: ReportResult | null;
  /** The dates each card's link filters to. */
  linkWindow?: LinkWindow;
}): { current: React.ReactNode; performance: React.ReactNode } {
  const cur = basis.currency;
  const move = readMovement(batch);

  // The split is keyed by the product's internal id, which the subscriptions `plan` filter does
  // not accept (it matches public id or name) — so link by the name it does match. The rows are
  // the ones earning that MRR: non-renewing subscriptions still carry it.
  const planHref = (planKey: string, name: string) =>
    planKey === "none"
      ? null
      : `/businesses/${biz}/subscriptions?plan=${encodeURIComponent(name)}&filter=status:in:active,non_renewing&filter=mrr:gt:0`;

  /* ------------------------------------------------------------- current */

  const mrrByPlan = pick(batch, "mrr_by_plan");
  const composition = slices(mrrByPlan);
  const mrrCur = mrrByPlan?.currency ?? cur;

  const intervals = slices(pick(batch, "mrr_by_interval"));
  const countries = slices(pick(batch, "mrr_by_country")).filter((r) => r.key !== "none");
  const top10Entry = pick(batch, "mrr_top10");
  // A share of nothing is no reading: zero renders nothing, like a refusal.
  const top10 = top10Entry?.total ? top10Entry : null;
  const fmtMrr = (n: number) => moneyCompact(n, mrrCur);
  const topRows = (topCustomers?.rows ?? [])
    .filter((r) => r.group_id != null)
    .slice(0, 10)
    .map((r) => ({
      key: r.group_id!,
      label: r.group,
      total: r.value,
      href: `/businesses/${biz}/customers/${encodeURIComponent(r.group_id!)}`,
    }));
  // Short cards share the top row, the two long ranked lists the next; no row carries a hole.
  const shortCards = 1 + (intervals.length > 0 ? 1 : 0) + (countries.length > 0 ? 1 : 0);
  const shortSpan = shortCards === 3 ? 4 : shortCards === 2 ? 6 : 12;
  const listSpan = top10 ? 6 : 12;

  const current = (
    <Stack>
      <Grid>
        <ScheduledChanges span={shortSpan} currency={cur} rows={scheduledRows(batch)} />
        {intervals.length > 0 ? (
          <Block span={shortSpan} title="MRR by billing interval" info={G.mrrByInterval}>
            <BarList rows={intervals} format={fmtMrr} />
          </Block>
        ) : null}
        {countries.length > 0 ? (
          <Block span={shortSpan} title="MRR by country" info={G.mrrByCountry}>
            <BarList
              rows={countries.map((r) => ({ ...r, label: countryName(r.label) }))}
              format={fmtMrr}
            />
          </Block>
        ) : null}
      </Grid>
      <Grid>
        <Block
          span={listSpan}
          title="MRR by plan"
          info={G.mrrByPlan}
          chip={`top ${mrrByPlan?.split?.limit ?? 12}`}
        >
          {composition.length > 0 ? (
            <BarList
              rows={composition.map((r) => {
                const href = planHref(r.key, r.label);
                return {
                  key: r.key,
                  label: href ? r.label : <span className="text-muted-foreground">{r.label}</span>,
                  total: r.total,
                  href,
                };
              })}
              format={fmtMrr}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              There is no stored MRR to split by plan yet.
            </p>
          )}
        </Block>
        {top10 ? (
          <Block span={listSpan} title="Revenue concentration" info={G.concentration}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-2xl font-semibold tabular-nums">
                {pctFromBps(top10.total!, 1)}
              </span>
              <span className="text-sm text-muted-foreground">of MRR · top 10 customers</span>
            </div>
            {topRows.length > 0 ? (
              <div className="mt-4">
                {/* A share of these ten alone would restate the headline wrongly; amounts only. */}
                <BarList
                  rows={topRows}
                  format={(n) => moneyCompact(n, topCustomers?.currency ?? mrrCur)}
                  share={false}
                />
              </div>
            ) : null}
          </Block>
        ) : null}
      </Grid>
    </Stack>
  );

  /* --------------------------------------------------------- performance */

  const pct = (bps: number | null) => (bps == null ? "—" : pctFromBps(bps, 1));
  const rates: Array<{ label: string; value: string; warn?: boolean; info: CardInfo }> = [
    { label: "Gross revenue retention", value: pct(move.grossBps), info: G.grr },
    { label: "Net revenue retention", value: pct(move.netBps), info: G.nrr },
    { label: "Gross MRR churn", value: pct(move.churnRateBps), info: G.mrrChurnRate },
    {
      label: "Quick ratio",
      info: G.quickRatio,
      value: move.quickRatio == null ? "—" : `${move.quickRatio.toFixed(2)}×`,
      warn: move.quickRatio != null && move.quickRatio < 1,
    },
    { label: "Net MRR growth", value: pct(move.netGrowthBps), info: G.netMrrGrowth },
  ];

  // The movement per bucket, on the axis the net-new series answered over.
  const trendAxis = pick(batch, "t_net") ?? pick(batch, "t_new");
  const labels = (trendAxis?.series ?? []).map((p) => p.label);
  const flows = {
    newMrr: byLabel(pick(batch, "t_new")),
    expansion: byLabel(pick(batch, "t_expansion")),
    reactivation: byLabel(pick(batch, "t_reactivation")),
    contraction: byLabel(pick(batch, "t_contraction")),
    churn: byLabel(pick(batch, "t_churn")),
    net: byLabel(pick(batch, "t_net")),
  };
  const add = (a: Map<string, number | null>, b: Map<string, number | null>, l: string) => {
    const x = a.get(l) ?? null;
    const y = b.get(l) ?? null;
    return x == null && y == null ? null : (x ?? 0) + (y ?? 0);
  };
  const grainWord = trendAxis?.grain === "month" ? "month" : "day";

  /**
   * The period's movement per plan, from the five flows' own splits — grouped on the plan the
   * MOVEMENT was filed under, so a churn from a retired plan is not booked to its successor.
   */
  const planLabels = new Map<string, string>();
  const flowByPlan = (key: string) => {
    const rows = new Map<string, number>();
    for (const r of slices(pick(batch, key))) {
      rows.set(r.key, r.total);
      planLabels.set(r.key, r.label);
    }
    return rows;
  };
  const byPlan = {
    new: flowByPlan("p_new"),
    expansion: flowByPlan("p_expansion"),
    reactivation: flowByPlan("p_reactivation"),
    contraction: flowByPlan("p_contraction"),
    churn: flowByPlan("p_churn"),
  };
  const planMovement = [...planLabels.entries()]
    .map(([id, label]) => {
      const at = (m: Map<string, number>) => m.get(id) ?? 0;
      const gained = at(byPlan.new) + at(byPlan.expansion) + at(byPlan.reactivation);
      const lost = at(byPlan.contraction) + at(byPlan.churn);
      return { id, label, gained, lost, net: gained - lost };
    })
    .sort((a, z) => Math.abs(z.net) - Math.abs(a.net));

  const unit = (key: string) => {
    const r = pick(batch, key);
    return r ? measureValue(r.total, r.unit, r.currency ?? cur) : "—";
  };
  const lifetime = pick(batch, "ue_life");
  // Milliseconds; a thirty-day month is the engine's own unit. Under a month reads in days.
  const lifetimeLabel = (() => {
    if (lifetime?.total == null) return "—";
    const months = lifetime.total / 2_592_000_000;
    return months >= 1 ? `${months.toFixed(1)} months` : `${(months * 30).toFixed(1)} days`;
  })();
  const economics = [
    { label: "Revenue per new subscription", value: unit("ue_new"), info: G.revenuePerNewSub },
    {
      label: "Revenue lost per churned subscription",
      value: unit("ue_churned"),
      info: G.revenueLostPerChurnedSub,
    },
    { label: "Customer lifetime value", value: unit("ue_clv"), info: G.clv },
    { label: "Average customer lifetime", value: lifetimeLabel, info: G.customerLifetime },
    {
      label: "Subscriptions per customer",
      value: unit("ue_subs_per_cust"),
      info: G.subsPerCustomer,
    },
  ];

  const performance = (
    <Stack>
      <Grid>
        <Block
          span={8}
          title="MRR movement"
          info={G.mrrMovement}
          action={
            <div className="flex items-center gap-4">
              {/* The same movement, month by month, opening to closing. */}
              <BlockLink href={`/businesses/${biz}/reports/stats/mrr_movement_summary`}>
                Monthly summary
              </BlockLink>
              <BlockLink
                href={exploreHref(
                  biz,
                  ["mrr_new", "mrr_expansion", "mrr_reactivation", "mrr_contraction", "mrr_churn"],
                  linkWindow,
                )}
              >
                Analyse this movement
              </BlockLink>
            </div>
          }
        >
          <MovementWaterfall movement={move} currency={cur} />
        </Block>
        <Block span={4}>
          <div className="flex flex-col divide-y">
            {rates.map((r) => (
              <div key={r.label} className="flex items-baseline gap-4 py-4 first:pt-0 last:pb-0">
                <span className="min-w-0 flex-1 text-sm text-muted-foreground">
                  {r.label}
                  <span className="ml-1 inline-flex align-middle">
                    <InfoTip label={r.label} info={r.info} />
                  </span>
                </span>
                <span
                  className={cn("text-2xl font-semibold tabular-nums", r.warn && "text-warning")}
                >
                  {r.value}
                </span>
              </div>
            ))}
          </div>
        </Block>
      </Grid>

      {labels.length > 0 ? (
        <Grid>
          <Block span={12} title={`Movement by ${grainWord}`} info={G.movementByGrain}>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {[
                { label: "New", fill: "bg-chart-1" },
                { label: "Expansion + reactivation", fill: "bg-chart-4" },
                { label: "Churn + contraction", fill: "bg-chart-5" },
              ].map((l) => (
                <span key={l.label} className="flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-sm", l.fill)} aria-hidden />
                  {l.label}
                </span>
              ))}
              <span className="flex items-center gap-1.5">
                <span className="h-0.5 w-3 bg-foreground" aria-hidden />
                Net new MRR
              </span>
            </div>
            <div className="mt-2">
              <MovementBars
                labels={labels}
                newMrr={labels.map((l) => flows.newMrr.get(l) ?? null)}
                expansion={labels.map((l) => add(flows.expansion, flows.reactivation, l))}
                losses={labels.map((l) => add(flows.churn, flows.contraction, l))}
                net={labels.map((l) => flows.net.get(l) ?? null)}
                currency={trendAxis?.currency ?? cur}
              />
            </div>
          </Block>
        </Grid>
      ) : null}

      <Grid>
        <Block span={6} title="Movement by plan" info={G.movementByPlan} chip="largest net first">
          {planMovement.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing moved in this period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-0">Plan</TableHead>
                  <TableHead className="text-right">Gained</TableHead>
                  <TableHead className="text-right">Lost</TableHead>
                  <TableHead className="pr-0 text-right">Net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {planMovement.map((r) => {
                  const href = planHref(r.id, r.label);
                  return (
                    <TableRow key={r.id} className="hover:bg-transparent">
                      <TableCell className="pl-0 wrap-break-word whitespace-normal">
                        {href ? (
                          <Link href={href} className="hover:underline">
                            {r.label}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">{r.label}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">{moneyCompact(r.gained, cur)}</TableCell>
                      <TableCell className="text-right">{moneyCompact(r.lost, cur)}</TableCell>
                      <TableCell
                        className={cn(
                          "pr-0 text-right font-medium",
                          r.net < 0 ? "text-destructive" : r.net > 0 ? "text-success" : "",
                        )}
                        title={money(r.net, cur)}
                      >
                        {r.net < 0 ? "−" : r.net > 0 ? "+" : ""}
                        {moneyCompact(Math.abs(r.net), cur)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Block>
        <Block span={6} title="Unit economics">
          <Lines>
            {economics.map((e) => (
              <Line key={e.label} label={e.label} value={e.value} info={e.info} />
            ))}
          </Lines>
        </Block>
      </Grid>
    </Stack>
  );

  return { current, performance };
}
