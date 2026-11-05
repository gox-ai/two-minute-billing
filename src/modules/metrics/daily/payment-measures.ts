import { reportableCustomer, reportablePayment } from "../reportable";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { businesses, payments, refunds, transactions } from "@db/schema";
import {
  attributePaymentsForBusiness,
  foldRevenue,
  PAYMENT_BUCKETS,
  REVENUE_TYPES,
  revenueLineInfo,
  type PaymentBucket,
} from "@/modules/payments/attribution";
import type { DimensionId } from "./measures";
import type { MetricDailyRow } from "./write";

/**
 * The money-movement measures (Phase 7, group 3): the gateway log, and the cash split by
 * what it paid for.
 *
 * ── TWO SOURCES, ON PURPOSE ───────────────────────────────────────────────────────────
 * `payments_captured` and friends sum `transactions` — one row per attempt against a
 * gateway. `cash_collected` and friends sum `payments` — the engine's applied cash, placed
 * on the invoice LINES it settled.
 *
 * ⚠️ THEY DO NOT RECONCILE AND MUST NOT BE MADE TO. They agree on a book this engine billed
 * itself and diverge on a payment with no transaction row and on an imported transaction
 * that settled several invoices, where the importer stores the applied amount on the payment
 * and the full amount on the transaction. Each is right about its own question; neither is a
 * check on the other. So they are two `source`s, two SQL reads and two measure families, and
 * nothing here ever subtracts one from the other. `payments_net` nets captures against
 * refunds INSIDE the gateway log; `cash_recurring_net` nets inside the applied cash. There
 * is deliberately no measure that crosses the line.
 *
 * ── THE WINDOW, PER FAMILY ────────────────────────────────────────────────────────────
 *  - A gateway figure is dated by `transactions.occurred_at`. Not `settled_at`: that is null
 *    on every failure, and half this family is about failures, so it cannot window them.
 *    Not `finalised_at` either — an attempt still `in_progress` has none, and it would move
 *    a row between periods as it resolved.
 *  - A cash figure is dated by `payments.created_at` / `refunds.created_at`, which is the
 *    only date either row carries. A refund therefore reduces the period the refund
 *    happened in, never the period of the payment it reverses.
 */

/** The two transaction types these measures are about. `authorization` moves no money. */
const MONEY_TYPES = ["payment", "refund"] as const;

/**
 * The reason a failed attempt carries when the gateway named none. A key, not a sentence:
 * the reasons must still sum to the failure count, so an unnamed failure gets a bucket
 * rather than being dropped.
 */
export const UNSPECIFIED_FAILURE = "unspecified";

/** The stored slices each measure emits — paired against the registry's declaration. */
export const PAYMENT_MEASURE_DIMS: Record<string, readonly DimensionId[]> = {
  payments_captured: [],
  refunds_issued: [],
  payments_net: [],
  payment_attempts: ["transaction_status", "gateway"],
  refund_attempts: ["transaction_status"],
  payment_failures: ["failure_reason", "gateway"],
  refund_failures: ["failure_reason"],
  cash_collected: ["cash_bucket", "gateway"],
  cash_recurring: [],
  cash_non_recurring: [],
  cash_usage: [],
  cash_recurring_net: [],
  revenue_collected: ["revenue_type"],
};

/** The gateway-log measures. */
export const TRANSACTION_MEASURES = [
  "payments_captured",
  "refunds_issued",
  "payments_net",
  "payment_attempts",
  "refund_attempts",
  "payment_failures",
  "refund_failures",
] as const;

/** The applied-cash measures. */
export const CASH_MEASURES = [
  "cash_collected",
  "cash_recurring",
  "cash_non_recurring",
  "cash_usage",
  "cash_recurring_net",
  "revenue_collected",
] as const;

const n = (v: string | number | null | undefined): bigint => BigInt(v ?? 0);

export async function computePaymentMeasures(input: {
  tx: Tx;
  businessId: string;
  /** `[from, toExclusive)` — half-open, exactly as every other flow. */
  from: Date;
  toExclusive: Date;
}): Promise<MetricDailyRow[]> {
  const { tx, businessId, from, toExclusive } = input;
  const rows: MetricDailyRow[] = [];
  const push = (measure: string, dim: string, dimValue: string, currency: string, value: bigint) =>
    rows.push({ measure, dim, dimValue, currency, value });

  const startsAt = sql`${from.toISOString()}::timestamptz`;
  const endsAt = sql`${toExclusive.toISOString()}::timestamptz`;
  const inWindow = sql`${transactions.occurredAt} >= ${startsAt} and ${transactions.occurredAt} < ${endsAt}`;

  // ── The gateway log, one grouped read ─────────────────────────────────────────────────
  // Type × status × currency answers all seven: the money figures are the `succeeded` rows,
  // the attempt counts are every row, and the failures are the rest.
  const gateway = await tx
    .select({
      currency: transactions.currency,
      type: transactions.type,
      status: transactions.status,
      gateway: transactions.gatewayKey,
      attempts: sql<string>`count(*) filter (where ${inWindow})`.as("attempts"),
      amount:
        sql<string>`coalesce(sum(${transactions.amountMinor}) filter (where ${inWindow}), 0)`.as(
          "amount",
        ),
      ever: sql<string>`count(*) filter (where ${transactions.occurredAt} < ${endsAt})`.as("ever"),
    })
    .from(transactions)
    .where(
      and(
        and(eq(transactions.businessId, businessId), reportableCustomer(transactions.customerId)),
        inArray(transactions.type, [...MONEY_TYPES]),
      ),
    )
    .groupBy(
      transactions.currency,
      transactions.type,
      transactions.status,
      transactions.gatewayKey,
    );

  const failures = await tx
    .select({
      currency: transactions.currency,
      type: transactions.type,
      reason: transactions.errorCode,
      count: sql<string>`count(*)`.as("count"),
    })
    .from(transactions)
    .where(
      and(
        and(eq(transactions.businessId, businessId), reportableCustomer(transactions.customerId)),
        inArray(transactions.type, [...MONEY_TYPES]),
        sql`${transactions.status} <> 'succeeded'`,
        inWindow,
      ),
    )
    .groupBy(transactions.currency, transactions.type, transactions.errorCode);

  // ── The applied cash ──────────────────────────────────────────────────────────────────
  // ONE allocator, the same one the published reports call, so a gross figure and its net
  // twin cannot disagree about what a recurring line is. Refunds are fetched here and
  // filtered out of the gross figures by direction, which is exactly what the gross report
  // path does by not fetching them.
  const [biz] = await tx
    .select({ organizationId: businesses.organizationId })
    .from(businesses)
    .where(eq(businesses.id, businessId));
  const attributed = biz
    ? await attributePaymentsForBusiness({
        organizationId: biz.organizationId,
        businessId,
        tx,
        from,
        // The query bound is INCLUSIVE and the period's is not, so the last instant of the
        // window would otherwise pull in a payment this period does not own.
        to: new Date(toExclusive.getTime() - 1),
        includeRefunds: true,
      })
    : [];

  /**
   * Which currencies get a row.
   *
   * The UNION of every currency the business had moved money in BY THE END OF THIS PERIOD,
   * on either source — and the union rather than each family's own set, because the whole
   * point of keeping the two apart is that a reader compares them, and a currency present
   * on one side and absent on the other would read as a gap rather than as the difference
   * it is. A currency the business had not transacted in yet writes NOTHING: a row of zeros
   * claims the question was asked and answered. Once a currency exists every measure writes
   * its figure INCLUDING zero, because a measured zero and a missing row are different facts.
   */
  const seenPayments = await tx
    .select({ currency: payments.currency })
    .from(payments)
    .where(
      and(
        and(eq(payments.businessId, businessId), reportableCustomer(payments.customerId)),
        sql`${payments.createdAt} < ${endsAt}`,
      ),
    )
    .groupBy(payments.currency);
  const seenRefunds = await tx
    .select({ currency: refunds.currency })
    .from(refunds)
    .where(
      and(
        and(eq(refunds.businessId, businessId), reportablePayment(refunds.paymentId)),
        sql`${refunds.createdAt} < ${endsAt}`,
      ),
    )
    .groupBy(refunds.currency);

  const held = new Set<string>();
  for (const g of gateway) if (n(g.ever) > 0n) held.add(g.currency.toUpperCase());
  for (const r of [...seenPayments, ...seenRefunds]) held.add(r.currency.toUpperCase());

  type Totals = {
    captured: bigint;
    refunded: bigint;
    paymentAttempts: bigint;
    refundAttempts: bigint;
    paymentFailures: bigint;
    refundFailures: bigint;
  };
  const zero = (): Totals => ({
    captured: 0n,
    refunded: 0n,
    paymentAttempts: 0n,
    refundAttempts: 0n,
    paymentFailures: 0n,
    refundFailures: 0n,
  });
  const totals = new Map<string, Totals>();
  for (const currency of held) totals.set(currency, zero());

  const slices = new Map<string, bigint>();
  const fold = (measure: string, dim: string, dimValue: string, currency: string, v: bigint) => {
    const k = [measure, dim, dimValue, currency].join("\u0000");
    slices.set(k, (slices.get(k) ?? 0n) + v);
  };
  for (const g of gateway) {
    const currency = g.currency.toUpperCase();
    const t = totals.get(currency);
    if (!t) continue;
    const attempts = n(g.attempts);
    const payment = g.type === "payment";
    if (payment) t.paymentAttempts += attempts;
    else t.refundAttempts += attempts;
    if (g.status === "succeeded") {
      if (payment) t.captured += n(g.amount);
      else t.refunded += n(g.amount);
    } else if (payment) t.paymentFailures += attempts;
    else t.refundFailures += attempts;

    // The outcome and gateway slices. Written only where the window actually held an
    // attempt — a slice that never happened is absent exactly as an unused plan is. Folded,
    // because one status now spans a row per gateway.
    if (attempts > 0n) {
      const measure = payment ? "payment_attempts" : "refund_attempts";
      fold(measure, "transaction_status", g.status, currency, attempts);
      if (payment) {
        const gw = g.gateway ?? "none";
        fold("payment_attempts", "gateway", gw, currency, attempts);
        if (g.status !== "succeeded") fold("payment_failures", "gateway", gw, currency, attempts);
      }
    }
  }
  for (const [k, value] of slices) {
    const [measure, dim, dimValue, currency] = k.split("\u0000") as [
      string,
      string,
      string,
      string,
    ];
    push(measure, dim, dimValue, currency, value);
  }

  // An attempt the gateway gave no code for is bucketed, never dropped: the reasons have to
  // keep summing to the failure count. Grouped here rather than in SQL so a null and an
  // empty string land in one bucket instead of two.
  const byReason = new Map<string, bigint>();
  for (const f of failures) {
    const reason = f.reason == null || f.reason === "" ? UNSPECIFIED_FAILURE : f.reason;
    const currency = f.currency.toUpperCase();
    if (!totals.has(currency)) continue;
    const measure = f.type === "payment" ? "payment_failures" : "refund_failures";
    const k = `${measure}\u0000${reason}\u0000${currency}`;
    byReason.set(k, (byReason.get(k) ?? 0n) + n(f.count));
  }
  for (const [k, value] of byReason) {
    const [measure, reason, currency] = k.split("\u0000") as [string, string, string];
    push(measure, "failure_reason", reason, currency, value);
  }

  for (const currency of held) {
    const t = totals.get(currency)!;
    push("payments_captured", "", "", currency, t.captured);
    push("refunds_issued", "", "", currency, t.refunded);
    push("payments_net", "", "", currency, t.captured - t.refunded);
    push("payment_attempts", "", "", currency, t.paymentAttempts);
    push("refund_attempts", "", "", currency, t.refundAttempts);
    push("payment_failures", "", "", currency, t.paymentFailures);
    push("refund_failures", "", "", currency, t.refundFailures);
  }

  // ── The cash, bucketed ────────────────────────────────────────────────────────────────
  type Cash = {
    collected: bigint;
    recurring: bigint;
    nonRecurring: bigint;
    usage: bigint;
    recurringNet: bigint;
    buckets: Map<PaymentBucket, bigint>;
  };
  const cash = new Map<string, Cash>();
  for (const currency of held) {
    cash.set(currency, {
      collected: 0n,
      recurring: 0n,
      nonRecurring: 0n,
      usage: 0n,
      recurringNet: 0n,
      buckets: new Map(),
    });
  }
  for (const r of attributed) {
    const c = cash.get(r.currency.toUpperCase());
    if (!c) continue;
    // Net is the only figure a refund reaches. Everything else is money IN, and a refund
    // folded into a figure named "collected" would net silently.
    c.recurringNet += r.recurringMinor;
    if (r.direction !== "payment") continue;
    c.collected += r.signedAmountMinor;
    c.recurring += r.recurringMinor;
    c.nonRecurring += r.nonRecurringMinor;
    c.usage += r.usageMinor;
    for (const b of PAYMENT_BUCKETS) {
      const v = r.buckets[b];
      if (v === 0n) continue;
      c.buckets.set(b, (c.buckets.get(b) ?? 0n) + v);
    }
  }
  // The gateway slice: each applied payment under its payment's provider, so the slices sum to
  // the collected figure. One lookup over the payments this window applied.
  const payIds = [
    ...new Set(attributed.filter((r) => r.direction === "payment").map((r) => r.paymentId)),
  ];
  const providerOf = new Map<string, string>();
  for (let i = 0; i < payIds.length; i += 500) {
    const chunk = await tx
      .select({ id: payments.id, provider: payments.providerKey })
      .from(payments)
      .where(inArray(payments.id, payIds.slice(i, i + 500)));
    for (const p of chunk) providerOf.set(p.id, p.provider ?? "none");
  }
  const byGateway = new Map<string, bigint>();
  for (const r of attributed) {
    if (r.direction !== "payment" || !cash.has(r.currency.toUpperCase())) continue;
    const k = `${r.currency.toUpperCase()}\u0000${providerOf.get(r.paymentId) ?? "none"}`;
    byGateway.set(k, (byGateway.get(k) ?? 0n) + r.signedAmountMinor);
  }
  for (const [k, value] of byGateway) {
    const [currency, gw] = k.split("\u0000") as [string, string];
    push("cash_collected", "gateway", gw, currency, value);
  }

  // Revenue collected: each payment's line shares regrouped by revenue type, with the share
  // that paid a document discount spread back over its revenue lines (`foldRevenue`).
  const paid = attributed.filter(
    (r) => r.direction === "payment" && cash.has(r.currency.toUpperCase()),
  );
  const lineInfo = await revenueLineInfo(
    tx,
    paid.flatMap((r) => r.lines.map((l) => l.lineItemId)),
  );
  const revenueBy = new Map<string, Map<string, bigint>>();
  for (const r of paid) {
    const cur = r.currency.toUpperCase();
    const acc = revenueBy.get(cur) ?? new Map<string, bigint>();
    for (const l of foldRevenue(r.lines, lineInfo).lines) {
      acc.set(l.type, (acc.get(l.type) ?? 0n) + l.amountMinor);
    }
    revenueBy.set(cur, acc);
  }

  for (const [currency, c] of cash) {
    const byType = revenueBy.get(currency);
    let revenueTotal = 0n;
    for (const t of REVENUE_TYPES) {
      const v = byType?.get(t) ?? 0n;
      revenueTotal += v;
      push("revenue_collected", "revenue_type", t, currency, v);
    }
    push("revenue_collected", "", "", currency, revenueTotal);
    push("cash_collected", "", "", currency, c.collected);
    push("cash_recurring", "", "", currency, c.recurring);
    push("cash_non_recurring", "", "", currency, c.nonRecurring);
    push("cash_usage", "", "", currency, c.usage);
    push("cash_recurring_net", "", "", currency, c.recurringNet);
    for (const [bucket, value] of c.buckets) {
      push("cash_collected", "cash_bucket", bucket, currency, value);
    }
  }

  return rows;
}
