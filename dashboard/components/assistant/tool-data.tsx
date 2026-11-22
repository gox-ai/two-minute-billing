"use client";

import * as React from "react";
import Link from "next/link";
import { Check, CircleAlert, CreditCard, Mail, Zap, type LucideIcon } from "lucide-react";
import {
  groupKeyText,
  metricLabel,
  openDisputesText,
  paymentSplitText,
  paysWithText,
  priceText,
  sentence,
  timelineText,
  words,
} from "./tool-data-helpers";
import { StatusChip } from "@/components/patterns/chip";
import { AreaChart } from "@/components/charts/area-chart";
import { money, pctFromBps } from "@/lib/format";
import { MiddleEllipsis } from "@/components/patterns/id-text";
import { cn } from "@/lib/utils";
import { fmtDate, fmtRange } from "@/lib/format-date";
import { recordHref } from "@/lib/assistant";

/**
 * Lookup results as record cards instead of raw JSON: one record is a card (name as a link,
 * status, key amount, one line of context), several are a compact list with "Show N more",
 * and figures are a stat row. Each renderer reads the shape of one tool's result and returns
 * null when the data does not have that shape; nothing is drawn then.
 */

export interface ToolDataItem {
  id: string;
  name?: string;
  label: string;
  data: unknown;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rows = (v: unknown): Rec[] | null => {
  const list = Array.isArray(v) ? v : rec(v)?.data;
  return Array.isArray(list) ? (list.map(rec).filter(Boolean) as Rec[]) : null;
};

interface Ctx {
  biz: string;
  tz: string;
}

/** `route`: the folder of the record shown (`customers`), for an imported id with no prefix. */
function IdLink({
  id,
  label,
  ctx,
  route,
}: {
  id: string;
  label?: string | null;
  ctx: Ctx;
  route: string;
}) {
  const href = recordHref(ctx.biz, id, route);
  // An id alone shortens in the middle and stays on one line.
  const text = label || <MiddleEllipsis value={id} className="text-xs" />;
  return href ? (
    <Link href={href} className="text-primary hover:underline">
      {text}
    </Link>
  ) : (
    <span>{text}</span>
  );
}

const amount = (minor: unknown, currency: unknown) => {
  const n = num(minor);
  const c = str(currency);
  return n !== null && c ? money(n, c) : null;
};

type Line = {
  key: string;
  title: React.ReactNode;
  status?: string | null;
  amount?: string | null;
  /** One line under the title: dates, the customer, a reason. Empty parts are left out. */
  context: Array<React.ReactNode | null | undefined | false>;
};

/** One record: its name as a link, its status and key amount, one line of context. */
function RecordLine({ title, status, amount: total, context }: Omit<Line, "key">) {
  const parts = context.filter((c) => c !== null && c !== undefined && c !== false && c !== "");
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {status ? <StatusChip status={status} /> : null}
        {total ? (
          <span className="shrink-0 text-sm font-medium whitespace-nowrap tabular-nums">
            {total}
          </span>
        ) : null}
      </div>
      {parts.length ? (
        <p className="m-0 truncate text-xs text-muted-foreground tabular-nums">
          {parts.map((p, i) => (
            <React.Fragment key={i}>
              {i ? " · " : null}
              {p}
            </React.Fragment>
          ))}
        </p>
      ) : null}
    </div>
  );
}

function RecordCard(line: Omit<Line, "key">) {
  return (
    <div className="rounded-xl border bg-card px-3 py-2">
      <RecordLine {...line} />
    </div>
  );
}

/** Rows shown before "Show N more". */
const LIST_FIRST = 3;

/** Several records: a compact list in one card, the first few shown. */
function RecordList({ label, lines }: { label: string; lines: Line[] }) {
  const [all, setAll] = React.useState(false);
  if (!lines.length) return null;
  const hidden = Math.max(0, lines.length - LIST_FIRST);
  const shown = all ? lines : lines.slice(0, LIST_FIRST);
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex h-8 items-center justify-between gap-2 bg-muted/40 px-3 text-xs font-medium text-muted-foreground">
        <span className="truncate">{label}</span>
        <span className="tabular-nums">{lines.length}</span>
      </div>
      <ul className="m-0 list-none p-0">
        {shown.map(({ key, ...line }) => (
          <li key={key} className="border-t px-3 py-2">
            <RecordLine {...line} />
          </li>
        ))}
      </ul>
      {hidden ? (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll((a) => !a)}
          className="flex h-8 w-full items-center justify-center border-t text-xs font-medium text-primary transition-colors hover:bg-muted/40"
        >
          {all ? "Show fewer" : `Show ${hidden} more`}
        </button>
      ) : null}
    </div>
  );
}

export type Stat = {
  label: string;
  value: string;
  change?: { text: string; tone: "up" | "down" | "flat" } | null;
};
const TONE = { up: "text-success", down: "text-destructive", flat: "text-muted-foreground" };

/**
 * Figures side by side: label, value, the change when there is one. Cells wrap with a 1px
 * gap that draws the rules, so a narrow panel stacks them without a cramped column.
 */
export function StatRow({ stats, bare }: { stats: Stat[]; bare?: boolean }) {
  return (
    <dl
      className={cn(
        "m-0 flex flex-wrap gap-px bg-border",
        bare ? "border-t" : "overflow-hidden rounded-xl border",
      )}
    >
      {stats.map((s) => (
        <div key={s.label} className="flex min-w-0 flex-[1_1_7rem] flex-col bg-card px-3 py-2">
          <dt className="truncate text-xs text-muted-foreground">{s.label}</dt>
          <dd className="m-0 text-base font-semibold whitespace-nowrap tabular-nums">{s.value}</dd>
          {s.change ? (
            <dd className={cn("m-0 text-xs whitespace-nowrap tabular-nums", TONE[s.change.tone])}>
              {s.change.text}
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}

const customerName = (c: Rec) =>
  str(c.name) ??
  ([str(c.first_name), str(c.last_name)].filter(Boolean).join(" ") || null) ??
  str(c.company) ??
  str(c.email);

const dateIn = (iso: unknown, ctx: Ctx) => (str(iso) ? fmtDate(str(iso), ctx.tz) : null);

/** The payer block the list tools return when asked: name for the title, method for context. */
const payerName = (r: Rec): string | null => {
  const p = rec(r.payer);
  return p ? (str(p.name) ?? str(p.company) ?? str(p.email)) : null;
};
const payerPays = (r: Rec): string | null => {
  const w = rec(rec(r.payer)?.pays_with);
  return w ? paysWithText(w) : null;
};

function invoiceLines(list: Rec[], ctx: Ctx): Line[] {
  return list
    .filter((i) => str(i.id))
    .map((i) => {
      const due = num(i.amount_due_minor);
      return {
        key: str(i.id)!,
        title: <IdLink id={str(i.id)!} label={str(i.number)} ctx={ctx} route="invoices" />,
        status: str(i.status),
        amount: amount(i.total_minor, i.currency),
        context: [
          str(i.customer_name) ?? payerName(i),
          dateIn(i.due_date, ctx) ? `Due ${dateIn(i.due_date, ctx)}` : null,
          due ? `${amount(due, i.currency)} due` : null,
          payerPays(i),
        ],
      };
    });
}

function getInvoice(d: unknown, ctx: Ctx) {
  const inv = rec(rec(d)?.invoice);
  const id = str(inv?.id);
  if (!inv || !id) return null;
  const due = num(inv.amount_due_minor);
  return (
    <RecordCard
      title={<IdLink id={id} label={str(inv.number)} ctx={ctx} route="invoices" />}
      status={str(inv.status)}
      amount={amount(inv.total_minor, inv.currency)}
      context={[
        str(inv.customer) ? (
          <IdLink
            key="c"
            id={str(inv.customer)!}
            label={str(inv.customer_name)}
            ctx={ctx}
            route="customers"
          />
        ) : null,
        dateIn(inv.due_date, ctx) ? `Due ${dateIn(inv.due_date, ctx)}` : null,
        due ? `${amount(due, inv.currency)} due` : null,
      ]}
    />
  );
}

function getCustomer(d: unknown, ctx: Ctx) {
  const r = rec(d);
  const c = rec(r?.customer);
  const id = str(c?.id);
  if (!r || !c || !id) return null;
  const subs = rows(r.subscriptions) ?? [];
  const invoices = rows(r.recent_invoices) ?? [];
  const disputes = rows(r.open_disputes) ?? [];
  const respondBy = disputes
    .map((x) => str(x.evidence_due_by))
    .filter((x): x is string => !!x)
    .sort()[0];
  return (
    <div className="flex flex-col gap-2">
      <RecordCard
        title={<IdLink id={id} label={customerName(c)} ctx={ctx} route="customers" />}
        context={[
          str(c.email),
          str(c.company) !== customerName(c) ? str(c.company) : null,
          subs.length
            ? `${subs.length} ${subs.length === 1 ? "subscription" : "subscriptions"}`
            : null,
        ]}
      />
      {disputes.length ? (
        <p className="m-0 px-1 text-xs text-warning">
          {openDisputesText(disputes.length)}
          {respondBy ? ` · respond by ${dateIn(respondBy, ctx)}` : ""}
        </p>
      ) : null}
      <RecordList label="Recent invoices" lines={invoiceLines(invoices, ctx)} />
    </div>
  );
}

function subscriptionLines(list: Rec[], ctx: Ctx): Line[] {
  return list
    .filter((s) => str(s.id))
    .map((s) => ({
      key: str(s.id)!,
      title: (
        <IdLink
          id={str(s.id)!}
          label={str(s.customer_name) ?? payerName(s) ?? str(s.customer_email)}
          ctx={ctx}
          route="subscriptions"
        />
      ),
      status: str(s.status),
      amount: amount(s.mrr, s.currency),
      context: [
        amount(s.mrr, s.currency) ? "MRR" : null,
        dateIn(s.next_billing_at, ctx) ? `Renews ${dateIn(s.next_billing_at, ctx)}` : null,
        payerPays(s),
      ],
    }));
}

function getSubscription(d: unknown, ctx: Ctx) {
  const r = rec(d);
  const s = rec(r?.subscription);
  const id = str(s?.id);
  if (!r || !s || !id) return null;
  return (
    <RecordCard
      title={<IdLink id={id} ctx={ctx} route="subscriptions" />}
      status={str(s.status)}
      amount={amount(s.mrr, s.currency) ? `${amount(s.mrr, s.currency)} MRR` : null}
      context={[
        str(s.customer) ? (
          <IdLink
            key="c"
            id={str(s.customer)!}
            label={str(s.customer_name)}
            ctx={ctx}
            route="customers"
          />
        ) : null,
        dateIn(s.next_billing_at, ctx) ? `Renews ${dateIn(s.next_billing_at, ctx)}` : null,
        dateIn(s.current_period_end, ctx) ? `Term ends ${dateIn(s.current_period_end, ctx)}` : null,
      ]}
    />
  );
}

const typeLabel = (t: unknown) => {
  const s = (str(t) ?? "payment").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function listPayments(d: unknown, ctx: Ctx) {
  const list = rows(d);
  if (!list) return null;
  return (
    <RecordList
      label="Payments"
      lines={list
        .filter((t) => str(t.id))
        .map((t) => ({
          key: str(t.id)!,
          title: (
            <IdLink id={str(t.id)!} label={typeLabel(t.type)} ctx={ctx} route="transactions" />
          ),
          status: str(t.status),
          amount: amount(t.amount_minor, t.currency),
          context: [dateIn(str(t.occurred_at) ?? str(t.created_at), ctx), str(t.customer_name)],
        }))}
    />
  );
}

function searchCustomers(d: unknown, ctx: Ctx) {
  const list = rows(d);
  if (!list) return null;
  return (
    <RecordList
      label="Customers"
      lines={list
        .filter((c) => str(c.id))
        .map((c) => ({
          key: str(c.id)!,
          title: <IdLink id={str(c.id)!} label={customerName(c)} ctx={ctx} route="customers" />,
          context: [str(c.email), str(c.company) !== customerName(c) ? str(c.company) : null],
        }))}
    />
  );
}

function paymentAttempts(d: unknown, ctx: Ctx) {
  const list = rows(d);
  if (!list) return null;
  return (
    <RecordList
      label="Payment attempts"
      lines={list.map((a, i) => ({
        key: str(a.id) ?? String(i),
        title: `Attempt ${num(a.attempt_number) ?? i + 1}`,
        status: str(a.status),
        context: [dateIn(a.created_at, ctx), str(a.error_text) ?? str(a.error_code)],
      }))}
    />
  );
}

const LADDER: Array<[string, string, boolean?]> = [
  ["subtotal_minor", "Subtotal"],
  ["document_level_discount_minor", "Discounts", true],
  ["tax_minor", "Tax"],
  ["rounding_minor", "Rounding"],
  ["total_minor", "Total"],
  ["credits_applied_minor", "Credits applied", true],
  ["amount_paid_minor", "Paid", true],
  ["withholding_minor", "Withholding", true],
  ["amount_due_minor", "Amount due"],
];

function explainInvoice(d: unknown, ctx: Ctx) {
  const r = rec(d);
  const t = rec(r?.totals);
  const cur = str(r?.currency);
  if (!r || !t || !cur) return null;
  const shown = LADDER.filter(
    ([k, , minus]) => num(t[k]) !== null && ((!minus && k !== "rounding_minor") || num(t[k]) !== 0),
  );
  const id = str(r.invoice);
  return (
    <div className="rounded-xl border bg-card text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <span className="min-w-0 flex-[1_1_8rem] truncate font-medium">
          {id ? <IdLink id={id} label={str(r.number)} ctx={ctx} route="invoices" /> : "Totals"}
        </span>
        {typeof t.holds === "boolean" ? (
          <span
            className={
              t.holds
                ? "inline-flex items-center gap-1 text-xs text-success"
                : "inline-flex items-center gap-1 text-xs text-warning"
            }
          >
            {t.holds ? (
              <Check className="size-3.5" aria-hidden />
            ) : (
              <CircleAlert className="size-3.5" aria-hidden />
            )}
            {t.holds ? "The totals add up" : "The totals do not add up"}
          </span>
        ) : null}
      </div>
      <dl className="m-0 flex flex-col border-t px-3 py-2 text-xs tabular-nums">
        {shown.map(([k, label, minus]) => (
          <div
            key={k}
            className={
              k === "total_minor" || k === "amount_due_minor"
                ? "flex justify-between gap-3 py-0.5 font-medium"
                : "flex justify-between gap-3 py-0.5"
            }
          >
            <dt
              className={
                k === "total_minor" || k === "amount_due_minor"
                  ? undefined
                  : "text-muted-foreground"
              }
            >
              {label}
            </dt>
            <dd className="m-0">
              {minus ? "−" : ""}
              {money(num(t[k])!, cur)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** "New subscriptions", "Churn", …: the bridge's reasons in plain words. */
const MRR_REASONS: Record<string, string> = {
  new: "New subscriptions",
  expansion: "Expansion",
  reactivation: "Reactivations",
  resume: "Resumes",
  contraction: "Contraction",
  pause: "Pauses",
  churn: "Churn",
};

/** A signed amount: "+$1,352.83", "−$3,913.82". */
const signed = (minor: number, cur: string) =>
  `${minor > 0 ? "+" : minor < 0 ? "−" : ""}${money(Math.abs(minor), cur)}`;
const toneOf = (n: number): "up" | "down" | "flat" => (n > 0 ? "up" : n < 0 ? "down" : "flat");
const signTone = (minor: number) => TONE[toneOf(minor)];

/**
 * explain_mrr_change: opening → closing, the change by reason, and each reason's largest
 * movements. Subscription and customer links are built from the field, not the id's prefix:
 * imported records keep ids with no prefix.
 */
function explainMrrChange(d: unknown, ctx: Ctx) {
  const r = rec(d);
  const cur = str(r?.currency);
  const opening = num(r?.opening_mrr_minor);
  const closing = num(r?.closing_mrr_minor);
  const change = num(r?.change_minor);
  const reasons = rows(r?.reasons);
  if (!r || r.object !== "mrr_bridge" || !cur || opening === null || closing === null || !reasons)
    return null;
  const moved = reasons.filter((x) => (num(x.movements) ?? 0) > 0);
  const page = (kind: "subscriptions" | "customers", id: string | null) =>
    id ? `/businesses/${ctx.biz}/${kind}/${encodeURIComponent(id)}` : null;
  const start = str(r.start);
  const end = str(r.end);
  return (
    <div className="overflow-hidden rounded-xl border bg-card text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2">
        <span className="font-medium">MRR change</span>
        {start && end ? (
          <span className="text-xs text-muted-foreground">{fmtRange(start, end, ctx.tz)}</span>
        ) : null}
      </div>
      <StatRow
        bare
        stats={[
          { label: "Opening", value: money(opening, cur) },
          {
            label: "Closing",
            value: money(closing, cur),
            change: change !== null ? { text: signed(change, cur), tone: toneOf(change) } : null,
          },
        ]}
      />
      <ul className="m-0 list-none border-t p-0 text-xs">
        {moved.map((x) => {
          const delta = num(x.mrr_delta_minor) ?? 0;
          const largest = rows(x.largest) ?? [];
          const label = MRR_REASONS[str(x.reason) ?? ""] ?? str(x.reason) ?? "Other";
          return (
            <li key={str(x.reason) ?? label} className="border-t first:border-t-0">
              <details>
                <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 tabular-nums hover:bg-muted/40">
                  <span className="flex-1">{label}</span>
                  <span className="text-muted-foreground">{num(x.movements)}</span>
                  <span className={`w-24 text-right font-medium ${signTone(delta)}`}>
                    {signed(delta, cur)}
                  </span>
                </summary>
                {largest.length ? (
                  <ul className="m-0 list-none bg-muted/30 px-3 py-1.5">
                    {largest.map((m, i) => {
                      const md = num(m.mrr_delta_minor) ?? 0;
                      const cus = page("customers", str(m.customer));
                      const sub = page("subscriptions", str(m.subscription));
                      const who = str(m.customer_name) ?? str(m.customer) ?? "Customer";
                      return (
                        <li key={i} className="flex flex-wrap items-center gap-x-2 py-0.5">
                          {cus ? (
                            <Link href={cus} className="text-primary hover:underline">
                              {who}
                            </Link>
                          ) : (
                            <span>{who}</span>
                          )}
                          {str(rec(m.plan)?.name) ? (
                            <span className="text-muted-foreground">{str(rec(m.plan)?.name)}</span>
                          ) : null}
                          <span className="flex-1" />
                          {sub ? (
                            <Link href={sub} className="text-muted-foreground hover:underline">
                              Subscription
                            </Link>
                          ) : null}
                          <span className={`w-20 text-right tabular-nums ${signTone(md)}`}>
                            {signed(md, cur)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function getMetrics(d: unknown) {
  const series = rows(rec(rec(d)?.series)?.series);
  if (!series?.length) return null;
  const s = series.find((x) => x.key === "mrr") ?? series[0]!;
  const points = rows(s.points);
  const kind = s.kind === "money" || s.kind === "percent" ? s.kind : "count";
  const currency = str(rec(rec(d)?.series)?.currency) ?? "USD";
  if (!points?.length) return null;
  const values = points.map((p) => num(p.v)).filter((v): v is number => v !== null);
  const first = values[0];
  const last = values[values.length - 1];
  const fmt = (v: number) =>
    kind === "money"
      ? money(Math.round(v), currency)
      : kind === "percent"
        ? pctFromBps(Math.round(v))
        : Math.round(v).toLocaleString("en-US");
  const since = str(points[0]!.label);
  const delta = first !== undefined && last !== undefined ? last - first : null;
  const sign = delta === null ? "" : delta > 0 ? "+" : delta < 0 ? "−" : "";
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {last !== undefined ? (
        <StatRow
          stats={[
            {
              label: str(s.label) ?? "Trend",
              value: fmt(last),
              change:
                delta !== null && values.length > 1
                  ? {
                      text: `${sign}${fmt(Math.abs(delta))}${since ? ` since ${since}` : ""}`,
                      tone: toneOf(delta),
                    }
                  : null,
            },
          ]}
          bare
        />
      ) : null}
      <div className="border-t px-3 py-2">
        <AreaChart
          data={points.map((p) => ({ label: str(p.label) ?? "", value: num(p.v) }))}
          height={140}
          kind={kind}
          currency={currency}
          emphasizeLast
        />
      </div>
    </div>
  );
}

const GROUP = "flex flex-col gap-2";

function getCatalog(d: unknown) {
  const r = rec(d);
  if (!r) return null;
  const products = rows(r.products) ?? [];
  const prices = rows(r.prices) ?? [];
  const coupons = rows(r.coupons) ?? [];
  if (!products.length && !prices.length && !coupons.length) return null;
  return (
    <div className={GROUP}>
      <RecordList
        label="Products"
        lines={products
          .filter((p) => str(p.id))
          .map((p) => ({
            key: str(p.id)!,
            title: str(p.name) ?? str(p.id)!,
            status: str(p.status),
            context: [str(p.kind)],
          }))}
      />
      <RecordList
        label="Prices"
        lines={prices
          .filter((p) => str(p.id))
          .map((p) => ({
            key: str(p.id)!,
            title: priceText(str(p.name), amount(p.amount_minor, p.currency), str(p.interval)),
            context: [str(p.type), str(p.model)],
          }))}
      />
      <RecordList
        label="Coupons"
        lines={coupons
          .filter((c) => str(c.id))
          .map((c) => {
            const bps = num(c.percent_off_bps);
            return {
              key: str(c.id)!,
              title: str(c.code) ?? str(c.name) ?? str(c.id)!,
              status: str(c.status),
              amount:
                bps !== null && bps > 0
                  ? `${pctFromBps(bps)} off`
                  : amount(c.amount_off_minor, c.currency),
              context: [str(c.name) !== str(c.code) ? str(c.name) : null, str(c.duration_type)],
            };
          })}
      />
    </div>
  );
}

function getUpcomingCharges(d: unknown, ctx: Ctx) {
  const r = rec(d);
  // The tool answers `data` at the top; `subscriptions` was its first shape.
  const subs = rows(r?.data) ?? rows(rec(r?.subscriptions));
  const totals = rows(r?.totals);
  if (!r || (!subs && !totals)) return null;
  return (
    <div className={GROUP}>
      {totals?.length ? (
        <StatRow
          stats={totals
            .filter((t) => amount(t.amount_minor, t.currency))
            .map((t) => ({
              label: `${num(t.count) ?? 0} ${num(t.count) === 1 ? "charge" : "charges"}${
                str(t.currency) ? ` · ${str(t.currency)}` : ""
              }`,
              value: amount(t.amount_minor, t.currency)!,
              change: (() => {
                const cur = str(t.currency);
                const split = paymentSplitText(rec(t.by_payment_type), (m) =>
                  cur ? money(m, cur) : String(m),
                );
                return split ? { text: split, tone: "flat" as const } : null;
              })(),
            }))}
        />
      ) : null}
      {r.estimate === true ? (
        <p className="m-0 px-1 text-xs text-muted-foreground">
          An estimate. Final amounts can differ.
        </p>
      ) : null}
      {subs ? <RecordList label="Upcoming" lines={subscriptionLines(subs, ctx)} /> : null}
    </div>
  );
}

function explainPayment(d: unknown, ctx: Ctx) {
  const card = getInvoice(d, ctx);
  const attempts = rows(rec(d)?.attempts);
  if (!card && !attempts?.length) return null;
  return (
    <div className={GROUP}>
      {card}
      {attempts?.length ? (
        <RecordList
          label="Payment attempts"
          lines={attempts.map((a, i) => ({
            key: String(i),
            title: `Attempt ${num(a.attempt_number) ?? i + 1}`,
            status: str(a.status),
            context: [dateIn(a.created_at, ctx), str(a.error_text) ?? str(a.error_code)],
          }))}
        />
      ) : null}
    </div>
  );
}

/** Balance rows of one section: a list, `{data}`, `{balances}`, or the body itself. */
function balanceRows(v: unknown): Rec[] {
  const r = rec(v);
  if (!r || r.unavailable) return [];
  return rows(r.balances) ?? rows(r.data) ?? rows(v) ?? [r];
}

function explainBalance(d: unknown) {
  const r = rec(d);
  if (!r) return null;
  const sections: Array<[string, unknown, string[]]> = [
    [
      "Promotional credits",
      r.promotional_credits,
      ["promotional_credits", "balance_minor", "balance"],
    ],
    ["Excess payments", r.excess_payments, ["excess_payments", "balance_minor", "balance"]],
    ["Wallet", r.wallet, ["balance_minor", "balance"]],
  ];
  const stats: Stat[] = [];
  for (const [label, body, keys] of sections) {
    for (const row of balanceRows(body)) {
      const k = keys.find((x) => num(row[x]) !== null);
      const cur = str(row.currency) ?? str(rec(body)?.currency);
      const value = k && cur ? money(num(row[k])!, cur) : null;
      if (value) stats.push({ label: cur ? `${label} · ${cur}` : label, value });
    }
  }
  return stats.length ? <StatRow stats={stats} /> : null;
}

const KIND_ICON: Record<string, LucideIcon> = { event: Zap, email: Mail, payment: CreditCard };

function getTimeline(d: unknown, ctx: Ctx) {
  const entries = rows(rec(d)?.entries);
  if (!entries?.length) return null;
  return (
    <RecordList
      label="Timeline"
      lines={entries.map((e, i) => {
        const Icon = KIND_ICON[str(e.kind) ?? ""] ?? Zap;
        return {
          key: `${str(e.id) ?? ""}:${i}`,
          title: (
            <span className="inline-flex items-center gap-1.5">
              <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{timelineText(e)}</span>
            </span>
          ),
          status: str(e.status),
          context: [dateIn(e.at, ctx)],
        };
      })}
    />
  );
}

function getCollectionsQueue(d: unknown, ctx: Ctx) {
  const r = rec(d);
  const list = rows(r?.data) ?? rows(r?.invoices);
  const totals = rows(r?.total_due);
  if (!r || !list) return null;
  return (
    <div className={GROUP}>
      {totals?.length ? (
        <StatRow
          stats={totals
            .filter((t) => amount(t.amount_minor, t.currency))
            .map((t) => ({
              label: `Total due · ${str(t.currency)}`,
              value: amount(t.amount_minor, t.currency)!,
              change: { text: `${num(t.count) ?? 0} invoices`, tone: "flat" as const },
            }))}
        />
      ) : null}
      <RecordList
        label="Collections queue"
        lines={list
          .filter((i) => str(i.id))
          .map((i) => ({
            key: str(i.id)!,
            title: <IdLink id={str(i.id)!} label={str(i.number)} ctx={ctx} route="invoices" />,
            status: str(i.dunning_status),
            amount: amount(i.amount_due_minor, i.currency),
            context: [
              str(i.customer_name),
              dateIn(i.due_date, ctx) ? `Due ${dateIn(i.due_date, ctx)}` : null,
              dateIn(i.next_attempt_at, ctx)
                ? `Next retry ${dateIn(i.next_attempt_at, ctx)}`
                : null,
            ],
          }))}
      />
    </div>
  );
}

/**
 * query_records: the totals as a stat row, then one line per group. A `_minor` metric is money
 * when the group (or the whole query) names one currency; otherwise a plain number.
 */
function queryRecords(d: unknown, ctx: Ctx) {
  const r = rec(d);
  const totals = rec(r?.totals);
  const groups = rows(r?.groups);
  if (!r || !totals) return null;
  const groupBy = Array.isArray(r.group_by) ? (r.group_by as string[]) : [];
  const currencyOf = (key: Rec | null) =>
    str(key?.currency) ?? str(rec(rows(r.sample)?.[0])?.currency) ?? null;
  const fmt = (name: string, v: unknown, cur: string | null) =>
    typeof v !== "number"
      ? "—"
      : /_minor$/.test(name) && cur
        ? money(v, cur)
        : v.toLocaleString("en-US");
  const metricNames = Object.keys(totals).filter((k) => k !== "count");
  const single = groups?.length === 1 || !groupBy.includes("currency") ? currencyOf(null) : null;
  const stats: Stat[] = [
    {
      label: str(r.resource) ? `${sentence(words(str(r.resource)!))} matched` : "Matched",
      value: fmt("count", totals.count, null),
    },
    ...metricNames.map((k) => ({ label: metricLabel(k), value: fmt(k, totals[k], single) })),
  ];
  const partial = r.complete === false;
  return (
    <div className={GROUP}>
      <StatRow stats={stats} />
      {partial ? (
        <p className="m-0 text-xs text-warning">
          Read {num(r.rows_read) ?? 0} rows, not all of them. The figures cover those rows.
        </p>
      ) : null}
      {groups?.length && groupBy.length ? (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex h-8 items-center justify-between gap-2 bg-muted/40 px-3 text-xs font-medium text-muted-foreground">
            <span className="truncate">By {groupBy.map((g) => words(g)).join(", ")}</span>
            <span className="tabular-nums">{groups.length}</span>
          </div>
          <table className="w-full border-collapse text-sm tabular-nums">
            <tbody>
              {groups.slice(0, 12).map((g, i) => {
                const key = rec(g.key) ?? {};
                const cur = currencyOf(key);
                return (
                  <tr key={i} className="border-t">
                    <td className="px-3 py-1.5 wrap-break-word">{groupKeyText(key)}</td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap text-muted-foreground">
                      {fmt("count", g.count, null)}
                    </td>
                    {metricNames.map((k) => (
                      <td key={k} className="px-3 py-1.5 text-right whitespace-nowrap">
                        {fmt(k, g[k], cur)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {groups.length > 12 ? (
            <p className="m-0 border-t px-3 py-1.5 text-xs text-muted-foreground">
              {groups.length - 12} more groups in the answer.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const RENDERERS: Record<string, (d: unknown, ctx: Ctx) => React.ReactNode | null> = {
  query_records: queryRecords,
  get_invoice: getInvoice,
  get_customer: getCustomer,
  get_subscription: getSubscription,
  list_invoices: (d, ctx) => {
    const list = rows(d);
    return list ? <RecordList label="Invoices" lines={invoiceLines(list, ctx)} /> : null;
  },
  list_subscriptions: (d, ctx) => {
    const list = rows(d);
    return list ? <RecordList label="Subscriptions" lines={subscriptionLines(list, ctx)} /> : null;
  },
  list_payments: listPayments,
  search_customers: searchCustomers,
  get_payment_attempts: paymentAttempts,
  explain_invoice: explainInvoice,
  explain_mrr_change: explainMrrChange,
  get_metrics: (d) => getMetrics(d),
  get_catalog: (d) => getCatalog(d),
  get_upcoming_charges: getUpcomingCharges,
  explain_payment: explainPayment,
  explain_balance: (d) => explainBalance(d),
  get_timeline: getTimeline,
  get_collections_queue: getCollectionsQueue,
};

/** Record cards for known lookups. Nothing else is drawn: raw tool output is not for members. */
export function ToolData({ items, biz, tz }: { items: ToolDataItem[]; biz: string; tz: string }) {
  const ctx = { biz, tz };
  const rich: Array<{ id: string; node: React.ReactNode }> = [];
  for (const it of items) {
    const render = it.name ? RENDERERS[it.name] : undefined;
    let node: React.ReactNode | null = null;
    try {
      node = render ? render(it.data, ctx) : null;
    } catch {
      node = null;
    }
    if (node) rich.push({ id: it.id, node });
  }
  if (!rich.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {rich.map((r) => (
        <div key={r.id} className="min-w-0">
          {r.node}
        </div>
      ))}
    </div>
  );
}
