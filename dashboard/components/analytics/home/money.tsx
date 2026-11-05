import * as React from "react";
import { OUTCOME_FILLS } from "@/components/reports/recovery/dunning-outcomes";
import Link from "next/link";
import { Grid, Stack, Block, BlockLink } from "@/components/analytics/layout";
import { measureValueCompact } from "@/components/analytics/format";
import { money, moneyCompact, pctFromBps } from "@/lib/format";
import { cn } from "@/lib/utils";
import { explain } from "@/components/analytics/card-info";
import { G } from "@/components/analytics/glossary";
import type { ReportResult } from "@/lib/api";
import type { BatchEntry } from "@/lib/analytics-api";
import { AttemptsChart } from "./charts";
import {
  BarList,
  Line,
  Lines,
  SegmentBar,
  Tile,
  daysIn,
  disputeNote,
  localYmd,
  pick,
  readableKey,
  slice,
  signedMoney,
  slices,
  type Basis,
  betweenFilter,
  exploreHref,
  type LinkWindow,
} from "./parts";

type Rung = { label: string; short: string; amount: number; bucket: string | null };

/**
 * The ageing ladder read at four rungs: not yet due, the first two months late, then
 * everything older. The collapsed rung covers several report rows and no single filter value
 * expresses it, so it states its amount and does not link.
 */
function ladder(rows: ReportResult["rows"]): Rung[] {
  const get = (g: string) => rows?.find((r) => r.group === g)?.value ?? 0;
  const named = ["Current", "1–30 days", "31–60 days"];
  const rest = (rows ?? []).filter((r) => !named.includes(r.group));
  return [
    { label: "Not yet due", short: "Not yet due", amount: get("Current"), bucket: "Current" },
    { label: "1–30 days late", short: "1–30 late", amount: get("1–30 days"), bucket: "1–30 days" },
    { label: "31–60 days late", short: "31–60", amount: get("31–60 days"), bucket: "31–60 days" },
    {
      label: "Over 60 days late",
      short: "60+",
      amount: rest.reduce((s, r) => s + r.value, 0),
      bucket: null,
    },
  ];
}

const DUNNING_STATES = OUTCOME_FILLS;

/**
 * Collections, as two zones. Current: today against yesterday, what is owed and how late,
 * where dunning stands, the cards, and the renewal cash already due. Performance: collected
 * against billed, why payments failed, what the cash paid for, and the adjustments.
 */
export function collectionsZones({
  biz,
  basis,
  batch,
  aging,
  nextDeadline,
  linkWindow,
}: {
  biz: string;
  basis: Basis;
  /** Every semantic-layer answer this view shows, from the one batched POST. */
  batch: BatchEntry[];
  /** The receivables ageing report; null when it could not be read. */
  aging: ReportResult | null;
  /** Soonest open dispute evidence deadline (ISO), from the disputes list. */
  nextDeadline?: string | null;
  /** The dates each card's link filters to. */
  linkWindow?: LinkWindow;
}): { current: React.ReactNode; performance: React.ReactNode } {
  const cur = basis.currency;
  const tz = basis.tz;
  const count = (n: number) => n.toLocaleString("en");
  const minor = (key: string) => pick(batch, key)?.total ?? null;
  const moneyOrDash = (n: number | null) => (n == null ? "—" : moneyCompact(n, cur));

  /* ------------------------------------------------------------- current */

  const days = [
    { id: "today", label: "Today" },
    { id: "yest", label: "Yesterday" },
  ] as const;
  const dayOf = (id: string) => pick(batch, `w_${id}_cash`)?.range.start ?? null;
  const on = (id: string, field: string) => {
    const d = dayOf(id);
    return d ? `${field}[on]=${localYmd(d, tz)}` : null;
  };
  const todayRows: Array<{
    label: string;
    key: string;
    fmt: (n: number) => string;
    href: (id: string) => string | null;
  }> = [
    {
      label: "Billed",
      key: "billed",
      fmt: (n) => moneyCompact(n, cur),
      href: (id) => {
        const d = dayOf(id);
        return d
          ? `/businesses/${biz}/invoices?filter=created_at:on:${localYmd(d, tz)}&filter=status:not_in:draft,voided`
          : null;
      },
    },
    {
      label: "Collected",
      key: "cash",
      fmt: (n) => moneyCompact(n, cur),
      href: (id) => {
        const q = on(id, "occurred_at");
        return q ? `/businesses/${biz}/transactions?type=payment&status=success&${q}` : null;
      },
    },
    {
      label: "New accounts",
      key: "signups",
      fmt: count,
      href: (id) => {
        const q = on(id, "created_at");
        return q ? `/businesses/${biz}/customers?${q}` : null;
      },
    },
  ];

  const receivables = minor("recv_amount");
  const openInvoices = minor("recv_count");
  const rungs = ladder(aging?.rows);
  const agingCur = aging?.currency ?? cur;
  const rungFill = ["bg-muted-foreground/40", "bg-warning", "bg-destructive", "bg-destructive"];

  const dunning = pick(batch, "dunning");
  const state = (k: string) => slice(dunning, k) ?? 0;
  const stateLabel = (k: string) =>
    readableKey(dunning?.split?.series.find((s) => s.key === k)?.label ?? k);
  // Recovered over what collections finished with; an invoice still being chased has no outcome.
  const finished = state("succeeded") + state("exhausted") + state("stopped");
  const recoveryRate = finished > 0 ? state("succeeded") / finished : null;
  const dunningStates = DUNNING_STATES.filter((s) => state(s.key) > 0);

  const disputesOpen = minor("disputes_open");
  const disputesAmount = pick(batch, "disputes_amount");
  // Provisional slot: a fifth card only once the engine answers it with something open. Five do
  // not fit one row, so they go three and two.
  const disputes = !!disputesOpen && !!disputesAmount?.total;
  const top = disputes ? 4 : 3;
  const tail = disputes ? 6 : 3;

  // The forward book: renewals due within 30 days, plus any whose date passed unbilled.
  const expected = pick(batch, "expected_cash");
  const expectedCur = expected?.currency ?? cur;
  const dueSoon = slice(expected, "1_30");
  const pastDue = slice(expected, "overdue");
  const toBill = dueSoon == null && pastDue == null ? null : (dueSoon ?? 0) + (pastDue ?? 0);
  const billedLast30 = minor("h_billed");

  const current = (
    <Stack>
      <Grid>
        <Block span={top} title="Today so far" info={G.todaySoFar}>
          <div className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-6 text-sm">
            <span />
            {days.map((d) => (
              <span key={d.id} className="text-right text-xs font-semibold text-muted-foreground">
                {d.label}
              </span>
            ))}
            {todayRows.map((r) => (
              <React.Fragment key={r.label}>
                <span className="border-t py-2.5 text-muted-foreground">{r.label}</span>
                {days.map((d) => {
                  const v = minor(`w_${d.id}_${r.key}`);
                  const href = r.href(d.id);
                  const text = v == null ? "—" : r.fmt(v);
                  return (
                    <span
                      key={d.id}
                      className={cn(
                        "border-t py-2.5 text-right tabular-nums",
                        d.id === "today" ? "font-semibold" : "text-muted-foreground",
                      )}
                    >
                      {href && v != null ? (
                        <Link href={href} className="hover:underline">
                          {text}
                        </Link>
                      ) : (
                        text
                      )}
                    </span>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </Block>

        <Block
          span={top}
          title="Receivables"
          info={G.receivables}
          action={
            <BlockLink href={`/businesses/${biz}/invoices?segment=unpaid`}>
              {openInvoices == null ? "Open invoices" : `${count(openInvoices)} open invoices`}
            </BlockLink>
          }
        >
          <span
            className="text-2xl font-semibold tabular-nums"
            title={receivables == null ? undefined : money(receivables, cur)}
          >
            {receivables == null ? "—" : money(receivables, cur)}
          </span>
          {aging ? (
            <div className="mt-4 flex flex-col gap-3">
              <SegmentBar
                label="Receivables by age"
                parts={rungs.map((r, i) => ({ key: r.label, value: r.amount, fill: rungFill[i]! }))}
              />
              <div className="grid grid-cols-2 gap-x-2 gap-y-3 @xs:grid-cols-4">
                {rungs.map((r, i) => {
                  const body = (
                    <>
                      <span
                        className={cn(
                          "block text-sm font-semibold tabular-nums",
                          i > 0 && r.amount > 0 && "text-destructive",
                        )}
                        title={money(r.amount, agingCur)}
                      >
                        {moneyCompact(r.amount, agingCur)}
                      </span>
                      <span className="block text-xs text-muted-foreground">{r.short}</span>
                    </>
                  );
                  return r.bucket ? (
                    <Link
                      key={r.label}
                      // Still owed only: the ageing bucket of a PAID invoice is not receivables.
                      href={`/businesses/${biz}/invoices?filter=${encodeURIComponent("status:in:posted,payment_due,not_paid")}&filter=${encodeURIComponent(`ar_bucket:is:${r.bucket}`)}`}
                      className="min-w-0 hover:underline"
                      title={r.label}
                    >
                      {body}
                    </Link>
                  ) : (
                    <span key={r.label} className="min-w-0" title={r.label}>
                      {body}
                    </span>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              We could not read the aging ladder.
            </p>
          )}
        </Block>

        <Block
          span={top}
          title="Dunning"
          info={G.dunning}
          action={<BlockLink href={`/businesses/${biz}/retries`}>Retries</BlockLink>}
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-2xl font-semibold tabular-nums">
              {recoveryRate == null ? "—" : pctFromBps(Math.round(recoveryRate * 10000), 0)}
            </span>
            {recoveryRate != null ? (
              <span className="text-sm text-muted-foreground tabular-nums">
                recovered · {count(state("succeeded"))} of {count(finished)}
              </span>
            ) : null}
          </div>
          {dunningStates.length > 0 ? (
            <div className="mt-4 flex flex-col gap-3">
              <SegmentBar
                label="Invoices by dunning state"
                parts={dunningStates.map((s) => ({
                  key: s.key,
                  value: state(s.key),
                  fill: s.fill,
                }))}
              />
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {dunningStates.map((s) => (
                  <span key={s.key} className="min-w-0">
                    <span className="block text-sm font-semibold tabular-nums">
                      {count(state(s.key))}
                    </span>
                    <span className="block text-xs text-muted-foreground">{stateLabel(s.key)}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </Block>

        <Block
          span={tail}
          title="To be billed"
          info={G.toBeBilled}
          action={
            linkWindow ? (
              <BlockLink
                href={`/businesses/${biz}/subscriptions?filter=status:is:active&filter=next_billing_at:between:${linkWindow.next30.from},${linkWindow.next30.to}`}
              >
                Subscriptions
              </BlockLink>
            ) : undefined
          }
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span
              className="text-2xl font-semibold tabular-nums"
              title={toBill == null ? undefined : money(toBill, expectedCur)}
            >
              {toBill == null ? "—" : moneyCompact(toBill, expectedCur)}
            </span>
            <span className="text-sm whitespace-nowrap text-muted-foreground">next 30 days</span>
          </div>
          {billedLast30 != null ? (
            <p className="mt-1 text-sm text-muted-foreground tabular-nums">
              vs {moneyCompact(billedLast30, cur)} billed in the last 30 days
            </p>
          ) : null}
          <p className="mt-3 text-xs text-muted-foreground">
            Scheduled renewals. Excludes tax and usage.
          </p>
          {pastDue ? (
            <p className="mt-3 border-t pt-3 text-sm text-warning tabular-nums">
              {moneyCompact(pastDue, expectedCur)} past its renewal date, not yet billed
            </p>
          ) : null}
        </Block>

        {disputes ? (
          <Block
            span={tail}
            title="Disputes"
            info={G.disputesOpen}
            action={<BlockLink href={`/businesses/${biz}/disputes`}>Disputes</BlockLink>}
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span
                className="text-2xl font-semibold tabular-nums"
                title={money(disputesAmount!.total!, disputesAmount!.currency ?? cur)}
              >
                {moneyCompact(disputesAmount!.total!, disputesAmount!.currency ?? cur)}
              </span>
              <span className="text-sm text-muted-foreground tabular-nums">
                {disputeNote(pick(batch, "disputes_open"), disputesOpen!, nextDeadline, tz)}
              </span>
            </div>
          </Block>
        ) : null}
      </Grid>
    </Stack>
  );

  /* --------------------------------------------------------- performance */

  const cash = minor("p_cash");
  const billed = minor("p_billed");
  const period = pick(batch, "p_billed") ?? pick(batch, "p_cash");
  const periodDays = period
    ? daysIn(localYmd(period.range.start, tz), localYmd(period.range.end, tz))
    : null;
  const collectionRate = cash != null && billed != null && billed > 0 ? cash / billed : null;
  // Receivables over the period's average daily billing.
  const dso =
    receivables != null && billed != null && billed > 0 && periodDays
      ? receivables / (billed / periodDays)
      : null;
  const recovered = pick(batch, "recovered");

  const attempts = minor("gw_attempts");
  const failures = minor("gw_failures");
  const reasons = [
    ...slices(pick(batch, "gw_failures"))
      .reduce((acc, d) => {
        // Two raw codes can name one refusal; the engine labels them alike.
        const row = acc.get(d.label);
        acc.set(d.label, row ? { ...row, total: row.total + d.total } : d);
        return acc;
      }, new Map<string, ReturnType<typeof slices>[number]>())
      .values(),
  ].sort((a, b) => b.total - a.total);
  const TOP = 8;
  const shownReasons = reasons.length > TOP + 1 ? reasons.slice(0, TOP) : reasons;
  const rest = reasons.slice(shownReasons.length);
  const truncated =
    pick(batch, "gw_failures")?.split?.series.find((s) => s.kind === "truncated")?.total ?? 0;
  const otherTotal = rest.reduce((s, r) => s + r.total, 0) + (truncated ?? 0);
  const reasonRows = [
    ...shownReasons.map((r) => ({
      key: r.key,
      label: readableKey(r.label),
      total: r.total,
      other: false,
    })),
    ...(otherTotal > 0
      ? [
          {
            key: "__other",
            label: truncated ? "Other reasons" : `${rest.length} other reasons`,
            total: otherTotal,
            other: true,
          },
        ]
      : []),
  ];
  const reasonWidest = Math.max(...reasonRows.map((r) => r.total), 1);

  const cashParts = [
    { key: "recurring", label: "Recurring", minor: minor("cash_recurring"), fill: "bg-chart-1" },
    {
      key: "non_recurring",
      label: "Non-recurring",
      minor: minor("cash_non_recurring"),
      fill: "bg-chart-4",
    },
    { key: "usage", label: "Usage", minor: minor("cash_usage"), fill: "bg-chart-2" },
  ].filter((p): p is typeof p & { minor: number } => p.minor != null);
  const cashWhole = cashParts.reduce((s, p) => s + Math.max(0, p.minor), 0);
  const refunds = minor("refunds");
  const creditNotes = minor("cn");
  const netRecurring = minor("cash_recurring_net");

  const discount = minor("discount_given");
  const grossBilling = billed;
  const tax = pick(batch, "tax_charged");
  const taxable = minor("taxable_base");
  const exempt = minor("exempt_base");
  const voided = minor("voided");
  const writtenOff = minor("written_off");

  // Payment success per bucket: attempts, the failures among them, and the rate between.
  const attSeries = pick(batch, "att_series");
  const failSeries = pick(batch, "fail_series");
  const attLabels = (attSeries?.series ?? []).map((p) => p.label);
  const failAt = new Map((failSeries?.series ?? []).map((p) => [p.label, p.value ?? null]));
  const successRate =
    attempts != null && failures != null && attempts > 0 ? 1 - failures / attempts : null;

  // Success by gateway. Provisional dimension: nothing renders until the engine splits by it.
  const gwFailures = new Map(slices(pick(batch, "gw_fail_by")).map((r) => [r.key, r.total]));
  const gateways = slices(pick(batch, "gw_att_by"))
    .filter((r) => r.total > 0)
    .map((r) => ({
      key: r.key,
      label: readableKey(r.label),
      attempts: r.total,
      rate: 1 - (gwFailures.get(r.key) ?? 0) / r.total,
    }));

  // What dunning finished with in the period: recovered against given up on.
  const lost = minor("lost");
  const recoveredMinor = recovered?.total ?? null;
  const recoveredN = minor("recovered_n");
  const lostN = minor("lost_n");
  const outcome = recoveredMinor != null || lost != null;
  const net = outcome ? (recoveredMinor ?? 0) - (lost ?? 0) : null;
  const invoices = (n: number | null) =>
    n == null ? null : `${count(n)} ${n === 1 ? "invoice" : "invoices"}`;

  // The period's disputes: opened, and those decided either way. Nothing renders at zero.
  const disputeFlows = [
    { key: "opened", label: "Opened", n: minor("disp_opened"), amt: minor("disp_opened_amt") },
    { key: "won", label: "Won", n: minor("disp_won"), amt: minor("disp_won_amt") },
    { key: "lost", label: "Lost", n: minor("disp_lost"), amt: minor("disp_lost_amt") },
  ];
  const disputeActivity = disputeFlows.some((d) => (d.n ?? 0) > 0);

  // Paid invoices by how late they were, in the engine's own rung order.
  const paidLate = pick(batch, "paid_late");
  const LATENESS = ["on_time", "1_30", "31_60", "60_plus"];
  const lateness = slices(paidLate)
    .filter((r) => r.total > 0)
    .sort((a, z) => LATENESS.indexOf(a.key) - LATENESS.indexOf(z.key));
  // The row's cards share it evenly, so a missing one leaves no hole.
  const lowerN = [outcome, lateness.length > 0, disputeActivity].filter(Boolean).length;
  const lowerSpan = lowerN === 3 ? 4 : lowerN === 2 ? 6 : 12;

  const performance = (
    <Stack>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
        <Tile
          label="Collected"
          info={G.collected}
          value={moneyOrDash(cash)}
          title={cash == null ? undefined : money(cash, cur)}
          note={billed == null ? undefined : `of ${moneyCompact(billed, cur)} billed`}
        />
        <Tile
          label="Collection rate"
          info={G.collectionRate}
          value={collectionRate == null ? "—" : pctFromBps(Math.round(collectionRate * 10000), 1)}
          note="collected ÷ billed"
        />
        <Tile
          label="Days sales outstanding"
          info={G.dso}
          value={dso == null ? "—" : `${dso.toFixed(1)} days`}
          note="receivables ÷ daily billing"
        />
        <Tile
          label="Recovered by dunning"
          info={G.recoveredByDunning}
          value={
            recovered
              ? measureValueCompact(recovered.total, recovered.unit, recovered.currency ?? cur)
              : "—"
          }
          title={
            recovered?.total == null ? undefined : money(recovered.total, recovered.currency ?? cur)
          }
        />
      </div>

      <Grid>
        <Block
          span={8}
          title="Why payments failed"
          info={G.whyFailed}
          chip={
            failures != null && attempts != null && attempts > 0
              ? `${count(failures)} of ${count(attempts)} · ${pctFromBps(Math.round((failures / attempts) * 10000), 1)}`
              : undefined
          }
        >
          {reasonRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No failed payments in this period.</p>
          ) : (
            <div className="grid grid-cols-[minmax(0,max-content)_minmax(3rem,1fr)_auto] items-center gap-x-4 gap-y-2.5 text-sm">
              {reasonRows.map((r) => (
                <React.Fragment key={r.key}>
                  {r.other ? (
                    <span className="wrap-break-word text-muted-foreground">{r.label}</span>
                  ) : (
                    <Link
                      href={`/businesses/${biz}/transactions?filter=type:is:payment&filter=status:is:failure${betweenFilter("occurred_at", linkWindow)}`}
                      className="wrap-break-word hover:underline"
                    >
                      {r.label}
                    </Link>
                  )}
                  <span className="h-2 rounded-md bg-muted" aria-hidden>
                    <span
                      className={cn(
                        "anim-grow block h-full rounded-md",
                        r.other ? "bg-muted-foreground/40" : "bg-warning",
                      )}
                      style={{ width: `${(r.total / reasonWidest) * 100}%` }}
                    />
                  </span>
                  <span className="w-12 text-right tabular-nums">{count(r.total)}</span>
                </React.Fragment>
              ))}
            </div>
          )}
        </Block>

        <Block
          span={4}
          title="Where the cash came from"
          info={explain(G.cashSources, G.refunds, G.creditNotes, G.netRecurringCash)}
          footer={
            <BlockLink
              href={exploreHref(
                biz,
                ["cash_recurring", "cash_non_recurring", "cash_usage", "refunds_issued"],
                linkWindow,
              )}
            >
              Analyse collections variance
            </BlockLink>
          }
        >
          {cashParts.length > 0 ? (
            <div className="flex flex-col gap-2">
              <SegmentBar
                label="Cash by revenue type"
                parts={cashParts.map((p) => ({ key: p.key, value: p.minor, fill: p.fill }))}
              />
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
                {cashParts
                  .filter((p) => p.minor !== 0)
                  .map((p) => (
                    <span key={p.key} className="flex items-center gap-1.5">
                      <span className={cn("size-2 rounded-sm", p.fill)} aria-hidden />
                      {p.label}{" "}
                      {cashWhole > 0
                        ? pctFromBps(Math.round((p.minor / cashWhole) * 10000), 0)
                        : ""}{" "}
                      · {money(p.minor, cur)}
                    </span>
                  ))}
              </div>
            </div>
          ) : null}
          <div className={cn(cashParts.length > 0 && "mt-4 border-t pt-4")}>
            <Lines>
              <Line
                label="Refunds issued"
                value={
                  refunds == null
                    ? "—"
                    : refunds === 0
                      ? moneyCompact(0, cur)
                      : `−${moneyCompact(refunds, cur)}`
                }
              />
              <Line label="Credit notes raised" value={moneyOrDash(creditNotes)} />
              <Line label="Net recurring cash" value={moneyOrDash(netRecurring)} strong />
            </Lines>
          </div>
        </Block>
      </Grid>

      {attLabels.length > 0 ? (
        <Grid>
          <Block
            span={gateways.length > 0 ? 8 : 12}
            title="Payment success"
            info={G.paymentSuccess}
            chip={
              successRate == null
                ? undefined
                : `${pctFromBps(Math.round(successRate * 10000), 1)} succeeded`
            }
          >
            <AttemptsChart
              labels={attLabels}
              attempts={(attSeries?.series ?? []).map((p) => p.value ?? null)}
              failures={attLabels.map((l) => failAt.get(l) ?? null)}
            />
            <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
              {[
                { label: "Attempts", mark: "size-2 rounded-sm bg-chart-4" },
                { label: "Failed", mark: "size-2 rounded-sm bg-chart-5" },
                { label: "Success rate", mark: "h-0.5 w-3 bg-foreground" },
              ].map((l) => (
                <span key={l.label} className="flex items-center gap-1.5">
                  <span className={l.mark} aria-hidden />
                  {l.label}
                </span>
              ))}
            </div>
          </Block>
          {gateways.length > 0 ? (
            <Block span={4} title="Success by gateway" info={G.successByGateway}>
              <Lines>
                {gateways.map((g) => (
                  <Line
                    key={g.key}
                    label={g.label}
                    note={`${count(g.attempts)} attempts`}
                    value={pctFromBps(Math.round(g.rate * 10000), 1)}
                  />
                ))}
              </Lines>
            </Block>
          ) : null}
        </Grid>
      ) : null}

      {lowerN > 0 ? (
        <Grid>
          {outcome ? (
            <Block
              span={lowerSpan}
              title="Dunning outcome"
              info={G.dunningOutcome}
              action={<BlockLink href={`/businesses/${biz}/retries`}>Retries</BlockLink>}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span
                  className={cn(
                    "text-2xl font-semibold tabular-nums",
                    net != null && net < 0 && "text-destructive",
                  )}
                  title={net == null ? undefined : money(net, cur)}
                >
                  {signedMoney(net, cur)}
                </span>
                <span className="text-sm text-muted-foreground">net</span>
              </div>
              <div className="mt-4 flex flex-col gap-3">
                <SegmentBar
                  label="Recovered against lost to collections"
                  parts={[
                    { key: "recovered", value: recoveredMinor ?? 0, fill: "bg-success" },
                    { key: "lost", value: lost ?? 0, fill: "bg-destructive" },
                  ]}
                />
                <div className="grid grid-cols-2 gap-4">
                  {[
                    { key: "r", label: "Recovered", minor: recoveredMinor, n: recoveredN },
                    { key: "l", label: "Lost to collections", minor: lost, n: lostN },
                  ].map((x) => (
                    <span key={x.key} className="min-w-0">
                      <span
                        className="block text-sm font-semibold tabular-nums"
                        title={x.minor == null ? undefined : money(x.minor, cur)}
                      >
                        {moneyOrDash(x.minor)}
                      </span>
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {[x.label, invoices(x.n)].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            </Block>
          ) : null}
          {lateness.length > 0 ? (
            <Block span={lowerSpan} title="Days to pay" info={G.daysToPay}>
              <BarList
                rows={lateness.map((r) => ({
                  ...r,
                  title: money(r.total, paidLate?.currency ?? cur),
                }))}
                format={(n) => moneyCompact(n, paidLate?.currency ?? cur)}
              />
            </Block>
          ) : null}
          {disputeActivity ? (
            <Block
              span={lowerSpan}
              title="Disputes"
              info={G.disputesPeriod}
              action={<BlockLink href={`/businesses/${biz}/disputes`}>Disputes</BlockLink>}
            >
              <Lines>
                {disputeFlows.map((d) => (
                  <Line
                    key={d.key}
                    label={d.label}
                    note={d.n == null ? undefined : count(d.n)}
                    value={moneyOrDash(d.amt)}
                    title={d.amt == null ? undefined : money(d.amt, cur)}
                  />
                ))}
              </Lines>
            </Block>
          ) : null}
        </Grid>
      ) : null}

      <Grid>
        <Tile
          label="Discounts"
          info={G.discounts}
          value={discount == null ? "—" : moneyCompact(discount, cur)}
          title={discount == null ? undefined : money(discount, cur)}
          note={
            // Billing is already net of the discount, so the share is of the pre-discount price.
            discount != null && grossBilling != null && grossBilling + discount > 0
              ? `${pctFromBps(Math.round((discount / (grossBilling + discount)) * 10000), 1)} of billing before discount`
              : undefined
          }
          span={4}
        />
        <Tile
          label="Tax charged"
          info={G.tax}
          value={tax ? measureValueCompact(tax.total, tax.unit, tax.currency ?? cur) : "—"}
          note={
            // `exempt_base` is the whole value of any invoice with an exempt line — part of the
            // taxable base, not a second half of it.
            [
              taxable != null ? `on ${moneyCompact(taxable, cur)} billed before tax` : null,
              exempt != null && exempt > 0
                ? `${moneyCompact(exempt, cur)} exempt or zero-rated`
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || undefined
          }
          span={4}
        />
        <Tile
          label="Voided · written off"
          info={G.voidedWrittenOff}
          value={
            voided == null && writtenOff == null
              ? "—"
              : `${moneyCompact(voided ?? 0, cur)} · ${moneyCompact(writtenOff ?? 0, cur)}`
          }
          span={4}
        />
      </Grid>
    </Stack>
  );

  return { current, performance };
}
