import * as React from "react";
import Link from "next/link";
import { Block, BlockLink, Grid } from "@/components/analytics/layout";
import { BarList, Headline, Lead, Meter, SegmentBar } from "@/components/analytics/home/parts";
import { money, moneyCompact, pctFromBps } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AnalyticsQuery, BatchEntry } from "@/lib/analytics-api";
import {
  ok,
  splitByKey,
  windowChangeBps,
  type SplitRow,
} from "@/components/analytics/org/conversion";

/**
 * The organization's portfolio: what only the whole organization can answer — where the MRR
 * is, how exposed it is to each currency, who is growing, and a scorecard of every business.
 *
 * Money and counts are split by business in one question each. Retention and churn rates are
 * NOT additive, so the engine refuses to combine them; the scorecard asks for them one business
 * at a time and never averages them.
 */

const READING = { grain: "day", range: "7d" } as const;

export interface Biz {
  id: string;
  name: string;
  currency: string | null;
}

/** The organization-scope questions. `period` is the Performance zone's window. */
export function portfolioQueries(opts: {
  period: { range: string; grain: "day" | "month" };
  businessCount: number;
  currencies: string[];
  scoped: boolean;
}): AnalyticsQuery[] {
  const byBiz = { split: "business", split_limit: Math.max(opts.businessCount, 1) };
  const P = { ...opts.period, shape: "totals" as const };
  return [
    // Current
    { key: "mrr", measure: "mrr", grain: "day", range: "30d", compare: "previous" },
    { key: "arr", measure: "arr", ...READING },
    { key: "mrr_biz", measure: "mrr", ...byBiz, ...READING, shape: "totals" },
    { key: "paying_biz", measure: "paying_customers", ...byBiz, ...READING, shape: "totals" },
    { key: "recv_biz", measure: "receivables_outstanding", ...byBiz, ...READING, shape: "totals" },
    { key: "recv_n", measure: "receivables_invoices", ...READING },
    { key: "dunning_biz", measure: "dunning_subscriptions", ...byBiz, ...READING, shape: "totals" },
    ...(opts.scoped
      ? []
      : [
          {
            key: "mrr_cur",
            measure: "mrr",
            split: "currency",
            ...READING,
            shape: "totals" as const,
          },
          ...opts.currencies.map((c) => ({
            key: `own_${c}`,
            measure: "mrr",
            currency: c,
            ...READING,
          })),
        ]),
    // Performance
    { key: "new_biz", measure: "mrr_new", ...byBiz, ...P },
    { key: "churn_biz", measure: "mrr_churn", ...byBiz, ...P },
    { key: "net_biz", measure: "net_new_mrr", ...byBiz, ...P },
    { key: "quick", measure: "quick_ratio", ...P },
    { key: "cash_biz", measure: "cash_collected", ...byBiz, ...P },
    { key: "billed_biz", measure: "billing_gross", ...byBiz, ...P },
    { key: "att_biz", measure: "payment_attempts", ...byBiz, ...P },
    { key: "fail_biz", measure: "payment_failures", ...byBiz, ...P },
    { key: "mrr_move", measure: "mrr", ...byBiz, ...opts.period },
  ];
}

/** Per-business rates: one question per business, never combined across them. */
export function rateQueries(businesses: Biz[], period: { range: string }): AnalyticsQuery[] {
  return businesses.flatMap((b) => [
    {
      key: `nrr_${b.id}`,
      measure: "net_revenue_retention",
      business: b.id,
      range: period.range,
      grain: "month",
    },
    {
      key: `cchurn_${b.id}`,
      measure: "customer_churn_rate",
      business: b.id,
      range: period.range,
      grain: "month",
    },
  ]);
}

type Answers = Map<string, BatchEntry>;

const rows = (a: Answers, key: string) => splitByKey(ok(a.get(key)));
const total = (a: Answers, key: string) => ok(a.get(key))?.total ?? null;
const valueOf = (m: Map<string, SplitRow>, id: string) => m.get(id)?.total ?? null;
const count = (n: number) => n.toLocaleString("en");

/* ------------------------------------------------------------------ current */

export function PortfolioCurrent({ answers, businesses }: { answers: Answers; businesses: Biz[] }) {
  const mrr = ok(answers.get("mrr"));
  const cur = mrr?.currency ?? "USD";
  const arr = total(answers, "arr");
  const mrrBiz = rows(answers, "mrr_biz");
  const paying = rows(answers, "paying_biz");
  const recv = rows(answers, "recv_biz");
  const dunning = rows(answers, "dunning_biz");
  const n = businesses.length;

  const positive = (m: Map<string, SplitRow>) =>
    businesses.filter((b) => (valueOf(m, b.id) ?? 0) > 0);
  const payingTotal = [...paying.values()].reduce((s, r) => s + (r.total ?? 0), 0);
  const largestPaying = Math.max(0, ...[...paying.values()].map((r) => r.total ?? 0));
  const recvTotal = total(answers, "recv_biz");
  const dunningTotal = [...dunning.values()].reduce((s, r) => s + (r.total ?? 0), 0);

  return (
    <>
      <Grid>
        <Headline
          span={3}
          label="Consolidated MRR"
          value={mrr?.total != null ? moneyCompact(mrr.total, cur) : "—"}
          title={mrr?.total != null ? money(mrr.total, cur) : undefined}
          stats={[
            { label: "ARR", value: arr != null ? moneyCompact(arr, cur) : null },
            {
              label: "30 days ago",
              value:
                mrr?.compare?.previous_total != null
                  ? moneyCompact(mrr.compare.previous_total, cur)
                  : null,
            },
          ]}
        />
        <Headline
          span={3}
          label="Paying customers"
          value={count(payingTotal)}
          stats={[
            { label: "Earning", value: `${positive(mrrBiz).length} of ${n}` },
            { label: "Largest", value: largestPaying > 0 ? count(largestPaying) : null },
          ]}
        />
        <Headline
          span={3}
          label="Receivables"
          value={recvTotal != null ? moneyCompact(recvTotal, cur) : "—"}
          stats={[
            {
              label: "Unpaid invoices",
              value: total(answers, "recv_n") != null ? count(total(answers, "recv_n")!) : null,
            },
            { label: "Businesses", value: count(positive(recv).length) },
          ]}
        />
        <Headline
          span={3}
          label="Subscriptions in dunning"
          value={count(dunningTotal)}
          stats={[{ label: "Businesses", value: count(positive(dunning).length) }]}
        />
      </Grid>
      <Grid>
        <WhereTheMrrIs answers={answers} businesses={businesses} currency={cur} />
        <CurrencyExposure answers={answers} currency={cur} />
      </Grid>
    </>
  );
}

/** Top rows by business, the tail folded into one "N others" row. */
function WhereTheMrrIs({
  answers,
  businesses,
  currency,
}: {
  answers: Answers;
  businesses: Biz[];
  currency: string;
}) {
  const mrrBiz = rows(answers, "mrr_biz");
  const ranked = businesses
    .map((b) => ({ b, v: valueOf(mrrBiz, b.id) ?? 0 }))
    .filter((r) => r.v > 0)
    .sort((a, z) => z.v - a.v);
  const whole = ranked.reduce((s, r) => s + r.v, 0);
  const idle = businesses.length - ranked.length;
  const SHOWN = 4;
  const head = ranked.length > SHOWN + 1 ? ranked.slice(0, SHOWN) : ranked;
  const tail = ranked.slice(head.length);
  const top = ranked[0];
  const topShare = top && whole > 0 ? top.v / whole : 0;

  return (
    <Block
      span={ranked.length > 0 ? 8 : 12}
      title="Where the MRR is"
      action={<BlockLink href="/#businesses">All businesses</BlockLink>}
      footer={idle > 0 ? `${idle} with no recurring revenue yet` : undefined}
    >
      {ranked.length === 0 ? (
        <p className="text-sm text-muted-foreground">No business has recurring revenue yet.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Concentration is the fact a portfolio owner needs first; said only when it holds. */}
          {top && topShare >= 0.5 && ranked.length > 1 ? (
            <div className="flex items-center gap-3 rounded-md bg-warning-soft px-3.5 py-2.5 text-sm">
              <span className="size-2 shrink-0 rounded-full bg-warning" aria-hidden />
              <span>
                <b>
                  {topShare >= 0.995 ? "One business holds" : `${top.b.name} holds`}{" "}
                  {pctFromBps(Math.round(topShare * 10000), 1)} of MRR.
                </b>
              </span>
            </div>
          ) : null}
          <SegmentBar
            label="MRR by business"
            parts={ranked.map((r, i) => ({
              key: r.b.id,
              value: r.v,
              fill: i === 0 ? "bg-chart-1" : "bg-chart-4",
            }))}
          />
          <BarList
            rows={[
              ...head.map((r) => ({
                key: r.b.id,
                label: r.b.name,
                total: r.v,
                href: `/businesses/${r.b.id}`,
              })),
              ...(tail.length > 0
                ? [
                    {
                      key: "others",
                      label: `${tail.length} others with MRR`,
                      total: tail.reduce((s, r) => s + r.v, 0),
                    },
                  ]
                : []),
            ]}
            format={(v) => moneyCompact(v, currency)}
          />
        </div>
      )}
    </Block>
  );
}

const CURRENCY_FILLS = [
  "bg-chart-1",
  "bg-chart-4",
  "bg-muted-foreground/30",
  "bg-chart-2",
  "bg-chart-3",
];

/** MRR by the currency it is billed in, converted, beside what it is in its own currency. */
function CurrencyExposure({ answers, currency }: { answers: Answers; currency: string }) {
  const byCur = rows(answers, "mrr_cur");
  const ranked = [...byCur.values()]
    .filter((r) => (r.total ?? 0) > 0)
    .sort((a, z) => (z.total ?? 0) - (a.total ?? 0));
  if (ranked.length === 0) return null;
  const whole = ranked.reduce((s, r) => s + (r.total ?? 0), 0);

  return (
    <Block span={4} title="Currency exposure">
      <div className="flex flex-col gap-4">
        <SegmentBar
          label="MRR by billing currency"
          parts={ranked.map((r, i) => ({
            key: r.key,
            value: r.total ?? 0,
            fill: CURRENCY_FILLS[i % CURRENCY_FILLS.length]!,
          }))}
        />
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-2.5 text-sm">
          {ranked.map((r, i) => {
            const own = total(answers, `own_${r.key}`);
            return (
              <React.Fragment key={r.key}>
                <span className="flex items-center gap-2 font-semibold">
                  <span
                    className={cn("size-2 rounded-sm", CURRENCY_FILLS[i % CURRENCY_FILLS.length])}
                    aria-hidden
                  />
                  {r.key}
                </span>
                <span className="truncate text-muted-foreground">
                  {r.key !== currency && own != null ? moneyCompact(own, r.key) : ""}
                </span>
                <span className="text-right font-medium tabular-nums">
                  {moneyCompact(r.total ?? 0, currency)}
                </span>
                <span className="w-12 text-right text-muted-foreground tabular-nums">
                  {pctFromBps(Math.round(((r.total ?? 0) / whole) * 10000), 1)}
                </span>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </Block>
  );
}

/* -------------------------------------------------------------- performance */

export function PortfolioPerformance({
  answers,
  rates,
  businesses,
  currency,
}: {
  answers: Answers;
  rates: Answers;
  businesses: Biz[];
  currency: string;
}) {
  return (
    <>
      <Grid>
        <GrowthByBusiness answers={answers} businesses={businesses} currency={currency} />
        <CashAcrossBusinesses answers={answers} businesses={businesses} currency={currency} />
      </Grid>
      <Grid>
        <Scorecard answers={answers} rates={rates} businesses={businesses} currency={currency} />
      </Grid>
    </>
  );
}

function GrowthByBusiness({
  answers,
  businesses,
  currency,
}: {
  answers: Answers;
  businesses: Biz[];
  currency: string;
}) {
  const nu = rows(answers, "new_biz");
  const ch = rows(answers, "churn_biz");
  const net = rows(answers, "net_biz");
  const moved = businesses
    .map((b) => ({
      b,
      nu: valueOf(nu, b.id) ?? 0,
      ch: valueOf(ch, b.id) ?? 0,
      net: valueOf(net, b.id),
    }))
    .filter((r) => r.nu !== 0 || r.ch !== 0)
    .sort((a, z) => z.nu + z.ch - (a.nu + a.ch));
  const widest = Math.max(1, ...moved.map((r) => Math.max(r.nu, r.ch)));
  const still = businesses.length - moved.length;
  const netTotal = total(answers, "net_biz");
  const quick = total(answers, "quick");
  const signed = (v: number) =>
    `${v > 0 ? "+" : v < 0 ? "−" : ""}${moneyCompact(Math.abs(v), currency)}`;

  return (
    <Block span={8} title="Growth by business">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground tabular-nums">
        <span>
          Net new MRR{" "}
          <b
            className={cn(
              "font-semibold",
              (netTotal ?? 0) < 0 ? "text-destructive" : "text-foreground",
            )}
          >
            {netTotal != null ? signed(netTotal) : "—"}
          </b>
        </span>
        <span>
          New{" "}
          <b className="font-semibold text-foreground">
            +
            {moneyCompact(
              [...nu.values()].reduce((s, r) => s + (r.total ?? 0), 0),
              currency,
            )}
          </b>
        </span>
        <span>
          Churn{" "}
          <b className="font-semibold text-foreground">
            −
            {moneyCompact(
              [...ch.values()].reduce((s, r) => s + (r.total ?? 0), 0),
              currency,
            )}
          </b>
        </span>
        {quick != null ? (
          <span>
            Quick ratio <b className="font-semibold text-foreground">{quick.toFixed(2)}×</b>
          </span>
        ) : null}
      </div>
      {moved.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No business moved MRR in this period.</p>
      ) : (
        <div className="mt-4 grid grid-cols-[minmax(0,12rem)_minmax(6rem,1fr)_auto_auto_auto] items-center gap-x-4 gap-y-3 text-sm tabular-nums">
          <span className="text-xs text-muted-foreground">Business</span>
          <span aria-hidden />
          <span className="text-right text-xs text-muted-foreground">New</span>
          <span className="text-right text-xs text-muted-foreground">Churn</span>
          <span className="text-right text-xs text-muted-foreground">Net</span>
          {moved.map((r) => (
            <React.Fragment key={r.b.id}>
              <Link
                href={`/businesses/${r.b.id}?tab=recurring`}
                className="truncate font-medium hover:underline"
              >
                {r.b.name}
              </Link>
              <span className="flex h-3.5 items-center" aria-hidden>
                <span className="flex flex-1 justify-end">
                  <span
                    className="anim-grow h-3.5 rounded-l-sm bg-chart-5"
                    style={{ width: `${(r.ch / widest) * 100}%` }}
                  />
                </span>
                <span className="h-5 w-px bg-muted-foreground/50" />
                <span className="flex-1">
                  <span
                    className="anim-grow block h-3.5 rounded-r-sm bg-chart-1"
                    style={{ width: `${(r.nu / widest) * 100}%` }}
                  />
                </span>
              </span>
              <span className="text-right text-primary">+{moneyCompact(r.nu, currency)}</span>
              <span className="text-right text-destructive">−{moneyCompact(r.ch, currency)}</span>
              <span
                className={cn(
                  "text-right font-semibold",
                  (r.net ?? 0) < 0 ? "text-destructive" : (r.net ?? 0) > 0 ? "text-success" : "",
                )}
              >
                {r.net != null ? signed(r.net) : "—"}
              </span>
            </React.Fragment>
          ))}
          {still > 0 ? (
            <span className="col-span-5 text-xs text-muted-foreground">
              {still} {still === 1 ? "other" : "others"} with no movement
            </span>
          ) : null}
        </div>
      )}
    </Block>
  );
}

function CashAcrossBusinesses({
  answers,
  businesses,
  currency,
}: {
  answers: Answers;
  businesses: Biz[];
  currency: string;
}) {
  const cash = total(answers, "cash_biz");
  const billed = total(answers, "billed_biz");
  const attempts = total(answers, "att_biz");
  const failures = total(answers, "fail_biz");
  const recv = rows(answers, "recv_biz");
  const owed = businesses
    .map((b) => ({ b, v: valueOf(recv, b.id) ?? 0 }))
    .filter((r) => r.v > 0)
    .sort((a, z) => z.v - a.v);
  const recvTotal = owed.reduce((s, r) => s + r.v, 0);

  return (
    <Block
      span={4}
      className="self-start"
      title="Cash across businesses"
      action={<BlockLink href="/metrics?measure=cash_collected#compare">Compare</BlockLink>}
    >
      <Lead value={cash != null ? moneyCompact(cash, currency) : "—"} note="collected" />
      {cash != null && billed ? (
        <div className="mt-4 flex flex-col gap-2">
          <Meter fraction={cash / billed} />
          <span className="text-xs text-muted-foreground tabular-nums">
            {pctFromBps(Math.round((cash / billed) * 10000), 1)} of {moneyCompact(billed, currency)}{" "}
            billed
          </span>
        </div>
      ) : null}
      <div className="mt-4 flex flex-col divide-y border-t text-sm tabular-nums [&>*]:py-2.5">
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Failed payments</span>
          <span>
            <b>{failures != null ? count(failures) : "—"}</b>
            {attempts ? (
              <span className="text-muted-foreground">
                {" "}
                of {count(attempts)} ·{" "}
                {pctFromBps(Math.round(((failures ?? 0) / attempts) * 10000), 1)}
              </span>
            ) : null}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Receivables</span>
          <b>{moneyCompact(recvTotal, currency)}</b>
        </div>
        {owed.length > 0 ? (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Where it sits</span>
            <span className="truncate">
              {owed.length === 1 ? `all in ${owed[0]!.b.name}` : `mostly ${owed[0]!.b.name}`}
            </span>
          </div>
        ) : null}
      </div>
    </Block>
  );
}

/* ---------------------------------------------------------------- scorecard */

type Flag = "loss" | "warn" | null;

function Cell({
  children,
  flag,
  muted,
  title,
}: {
  children: React.ReactNode;
  flag?: Flag;
  muted?: boolean;
  title?: string;
}) {
  return (
    <span className={cn("text-right", muted && "text-muted-foreground")} title={title}>
      {flag ? (
        <span
          className={cn(
            "rounded-md px-1.5 py-0.5",
            flag === "loss"
              ? "bg-destructive-soft text-destructive"
              : "bg-warning-soft text-warning",
          )}
        >
          {children}
        </span>
      ) : (
        children
      )}
    </span>
  );
}

/** Thresholds that flag a scorecard cell. */
const COLLECTION_FLOOR = 0.9;
const FAILURE_CEILING = 0.1;

function Scorecard({
  answers,
  rates,
  businesses,
  currency,
}: {
  answers: Answers;
  rates: Answers;
  businesses: Biz[];
  currency: string;
}) {
  const mrr = rows(answers, "mrr_biz");
  const move = rows(answers, "mrr_move");
  const net = rows(answers, "net_biz");
  const cash = rows(answers, "cash_biz");
  const billed = rows(answers, "billed_biz");
  const att = rows(answers, "att_biz");
  const fail = rows(answers, "fail_biz");
  const recv = rows(answers, "recv_biz");
  const dunning = rows(answers, "dunning_biz");
  const rate = (key: string) => {
    const r = ok(rates.get(key));
    return r?.total ?? null;
  };

  const ordered = [...businesses].sort(
    (a, z) =>
      (valueOf(mrr, z.id) ?? -1) - (valueOf(mrr, a.id) ?? -1) || a.name.localeCompare(z.name),
  );

  return (
    <Block span={12} title="Business scorecard">
      <div className="-mx-6 overflow-x-auto px-6">
        <div className="grid min-w-[60rem] grid-cols-[minmax(12rem,2fr)_repeat(9,minmax(0,1fr))_1rem] items-center gap-x-3 text-sm tabular-nums">
          {[
            "Business",
            "MRR",
            "Change",
            "Net new",
            "NRR",
            "Customer churn",
            "Collected",
            "Failed",
            "Receivables",
            "Dunning",
            "",
          ].map((h, i) => (
            <span
              key={h || i}
              className={cn(
                "border-b pb-2 text-xs font-medium text-muted-foreground",
                i > 0 && "text-right",
              )}
            >
              {h}
            </span>
          ))}
          {ordered.map((b) => {
            const m = valueOf(mrr, b.id);
            const pts = (move.get(b.id)?.points ?? []).filter((p) => p.value != null);
            // A business that opened the window with next to no MRR has a percentage that is
            // true and meaningless (+1,000,000%); call it new instead.
            const isNew =
              pts.length > 1 &&
              pts[pts.length - 1]!.value! > 0 &&
              pts[0]!.value! <= pts[pts.length - 1]!.value! * 0.01;
            const change = isNew
              ? null
              : move.get(b.id)
                ? windowChangeBps(move.get(b.id)!.points)
                : null;
            const nn = valueOf(net, b.id);
            const nrr = rate(`nrr_${b.id}`);
            const churn = rate(`cchurn_${b.id}`);
            const c = valueOf(cash, b.id) ?? 0;
            const bl = valueOf(billed, b.id) ?? 0;
            const collected = bl > 0 ? c / bl : null;
            const a = valueOf(att, b.id) ?? 0;
            const failed = a > 0 ? (valueOf(fail, b.id) ?? 0) / a : null;
            const rv = valueOf(recv, b.id) ?? 0;
            const dn = valueOf(dunning, b.id) ?? 0;
            return (
              <Link
                key={b.id}
                href={`/businesses/${b.id}`}
                className="col-span-11 grid grid-cols-subgrid items-center border-b py-3 last:border-0 hover:bg-muted/50"
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold" title={b.name}>
                    {b.name}
                  </span>
                  {b.currency ? (
                    <span className="block text-xs text-muted-foreground">{b.currency}</span>
                  ) : null}
                </span>
                <Cell muted={!m}>{m ? moneyCompact(m, currency) : "—"}</Cell>
                <span
                  className={cn(
                    "text-right",
                    isNew
                      ? "text-success"
                      : change == null
                        ? "text-muted-foreground"
                        : change > 0
                          ? "text-success"
                          : change < 0
                            ? "text-destructive"
                            : "text-muted-foreground",
                  )}
                >
                  {isNew
                    ? "new"
                    : change == null
                      ? "—"
                      : `${change > 0 ? "+" : ""}${pctFromBps(change, 1)}`}
                </span>
                <span
                  className={cn(
                    "text-right",
                    nn == null || nn === 0
                      ? "text-muted-foreground"
                      : nn < 0
                        ? "text-destructive"
                        : "text-success",
                  )}
                >
                  {nn == null
                    ? "—"
                    : nn === 0
                      ? "$0"
                      : `${nn > 0 ? "+" : "−"}${moneyCompact(Math.abs(nn), currency)}`}
                </span>
                <Cell
                  muted={nrr == null}
                  title={
                    nrr == null && m
                      ? "No recurring revenue at the start of this window, so there is nothing to measure it against"
                      : undefined
                  }
                >
                  {nrr == null ? "—" : pctFromBps(nrr, 1)}
                </Cell>
                <Cell
                  muted={churn == null}
                  title={
                    churn == null && m
                      ? "No recurring revenue at the start of this window, so there is nothing to measure it against"
                      : undefined
                  }
                >
                  {churn == null ? "—" : pctFromBps(churn, 1)}
                </Cell>
                <Cell
                  muted={collected == null}
                  flag={collected != null && collected < COLLECTION_FLOOR ? "warn" : null}
                  title={
                    collected != null && collected < COLLECTION_FLOOR
                      ? `Under ${COLLECTION_FLOOR * 100}% of billing collected`
                      : undefined
                  }
                >
                  {collected == null ? "—" : pctFromBps(Math.round(collected * 10000), 1)}
                </Cell>
                <Cell
                  muted={failed == null}
                  flag={failed != null && failed > FAILURE_CEILING ? "loss" : null}
                  title={
                    failed != null && failed > FAILURE_CEILING
                      ? `Over ${FAILURE_CEILING * 100}% of payment attempts failed`
                      : undefined
                  }
                >
                  {failed == null ? "—" : pctFromBps(Math.round(failed * 10000), 1)}
                </Cell>
                <Cell muted={rv === 0}>{rv === 0 ? "$0" : moneyCompact(rv, currency)}</Cell>
                <Cell
                  muted={dn === 0}
                  flag={dn > 0 ? "loss" : null}
                  title={dn > 0 ? "Subscriptions in dunning" : undefined}
                >
                  {count(dn)}
                </Cell>
                <span className="text-right text-muted-foreground" aria-hidden>
                  ›
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </Block>
  );
}
