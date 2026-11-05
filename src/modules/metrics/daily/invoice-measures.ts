import { reportableCustomer } from "../reportable";
import { and, eq, gte, lt, sql, inArray, isNotNull } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import {
  appliedTaxes,
  creditNotes,
  invoiceLineItems,
  invoices,
  payments,
  subscriptions,
} from "@db/schema";
import { billedRevenueByInvoice, REVENUE_TYPES } from "@/modules/payments/attribution";
import type { DimensionId } from "./measures";
import type { MetricDailyRow } from "./write";

/**
 * The invoice and receivables measures (Phase 7, group 2).
 *
 * Kept out of `compute.ts` because none of it shares that file's shape: the facts are
 * documents rather than a ledger of deltas, and the answers hang off FOUR different dates —
 * the invoice's issue date, the day it was voided, the day it was paid, and "now".
 *
 * ── THE WINDOW IS THE MEASURE ─────────────────────────────────────────────────────────
 * Each figure below is dated by the same column the report that already publishes it uses,
 * because materialising a figure under a different window silently changes what it meant.
 * Two consequences are written down rather than smoothed over:
 *
 *  - A WRITE-OFF is dated by the invoice's ISSUE date. There is no `written_off_at`; the
 *    column is a boolean. So this measure answers "which billing went uncollected", not
 *    "when did we give up". Dating it by `created_at` is the only honest option available.
 *  - RECEIVABLES and the DUNNING counts have no history at all. An invoice carries what is
 *    owed now and what state collections has it in now; nothing records either as at a past
 *    instant. They are therefore written ONLY for the period containing the compute run, and
 *    a past period is left with no row — which the reader states as unknown. A row
 *    backfilled with today's answer would be an invented history, and a zero would be a
 *    claim nobody can defend. History therefore ACCUMULATES FORWARD: the intraday pass
 *    leaves each day its last observed figure, the nightly close leaves that row alone
 *    because the day is now past, and a day before the measure shipped simply has none.
 */

/** Invoice statuses that represent money actually billed — a draft is not billing. */
const BILLED_STATUSES = ["posted", "payment_due", "not_paid", "paid"] as const;
/** …and the subset still owed. */
const UNPAID_STATUSES = ["posted", "payment_due", "not_paid"] as const;

/**
 * How late an invoice was when it was paid. A closed set, stored as KEYS rather than as the
 * sentence a screen prints: a dimension value is a contract with an integrator, and a label
 * is free to be reworded.
 */
export const LATENESS_BANDS = ["on_time", "1_30", "31_60", "60_plus"] as const;

/** The stored slices each measure emits — paired against the registry's declaration. */
export const INVOICE_MEASURE_DIMS: Record<string, readonly DimensionId[]> = {
  billing_gross: [],
  billing_net: [],
  credit_notes_issued: [],
  billing_non_recurring: [],
  revenue_billed: ["revenue_type", "product", "meter"],
  billed_customers: [],
  revenue_per_customer: [],
  tax_charged: [],
  taxable_base: [],
  exempt_base: [],
  discount_given: [],
  invoice_voided: [],
  invoice_written_off: [],
  amount_recovered: [],
  amount_exhausted: [],
  dunning_recovered_invoices: [],
  dunning_exhausted_invoices: [],
  recovery_paid_late: ["lateness_band"],
  receivables_outstanding: [],
  receivables_invoices: [],
  dunning_invoices: ["dunning_status"],
  dunning_recovery_rate: [],
  dunning_subscriptions: ["dunning_status"],
  mrr_at_risk: [],
};

/** The sixteen dated by a window, as opposed to the four that can only describe "now". */
export const INVOICE_FLOW_MEASURES = [
  "billing_gross",
  "billing_net",
  "credit_notes_issued",
  "billing_non_recurring",
  "revenue_billed",
  "tax_charged",
  "taxable_base",
  "exempt_base",
  "discount_given",
  "invoice_voided",
  "invoice_written_off",
  "amount_recovered",
  "amount_exhausted",
  "dunning_recovered_invoices",
  "dunning_exhausted_invoices",
  "recovery_paid_late",
] as const;

/**
 * The one stored as TWO HALVES and divided at read.
 *
 * Here rather than in `ratio-measures.ts` — which owns the ratios derived from the MRR
 * ledger — because both halves are invoice facts and they come off the SAME grouped read
 * below. That is this file's rule: two figures that must agree about which invoices they
 * saw are read once. A rate assembled in another file from two separately-queried measures
 * is exactly the "two answers" shape the group was built to avoid.
 */
export const INVOICE_RATIO_MEASURES = ["dunning_recovery_rate"] as const;

/** Distinct customers billed, and revenue per one: computed at every grain, never summed. */
export const INVOICE_PER_GRAIN_MEASURES = ["billed_customers", "revenue_per_customer"] as const;

/** The five that are the live book, not a period. */
export const INVOICE_NOW_MEASURES = [
  "receivables_outstanding",
  "receivables_invoices",
  "dunning_invoices",
  "dunning_subscriptions",
  "mrr_at_risk",
] as const;

const n = (v: string | number | null | undefined): bigint => BigInt(v ?? 0);

export async function computeInvoiceMeasures(input: {
  tx: Tx;
  businessId: string;
  /** `[from, toExclusive)` — the period's window, half-open exactly as the flows above. */
  from: Date;
  toExclusive: Date;
  /** The instant the compute is running at. Decides whether the live figures apply here. */
  now: Date;
}): Promise<MetricDailyRow[]> {
  const { tx, businessId, from, toExclusive, now } = input;
  const rows: MetricDailyRow[] = [];
  const push = (
    measure: string,
    dim: string,
    dimValue: string,
    currency: string,
    value: bigint,
    /** Only for the ratio: its other half, stored beside the numerator and divided at read. */
    denominator?: bigint,
  ) =>
    rows.push({
      measure,
      dim,
      dimValue,
      currency,
      value,
      ...(denominator != null ? { denominator } : {}),
    });

  const mine = and(eq(invoices.businessId, businessId), reportableCustomer(invoices.customerId));
  /**
   * The window's edges as SQL. The driver will not bind a `Date` inside a raw fragment —
   * only the column mappers behind `gte`/`lt` know how to serialise one — so the instants
   * are handed over as ISO text with their type stated.
   */
  const startsAt = sql`${from.toISOString()}::timestamptz`;
  const endsAt = sql`${toExclusive.toISOString()}::timestamptz`;
  const issued = sql`${invoices.createdAt} >= ${startsAt} and ${invoices.createdAt} < ${endsAt}`;
  const billed = inArray(invoices.status, [...BILLED_STATUSES]);
  const billedInWindow = sql`${billed} and ${issued}`;

  /**
   * WHAT IS STILL OWED ON AN INVOICE — cash subtracted, floored at zero.
   *
   * `amount_due_minor` is the ISSUE-TIME collectible, net of credits only; it is
   * deliberately never decremented by payments (`serializeInvoice` subtracts the paid total
   * for display, so decrementing the column would double-count). Summing it raw counts a
   * settled invoice as still owing — measured on the local book, that overstated receivables
   * by 121.8% on USD. The one rule lives in `invoiceOutstanding`/`paidTotals`; this is the
   * same arithmetic, set-based, because a per-invoice round trip inside a nightly pass is its
   * own defect.
   *
   * Floored at zero: an overpayment is not negative receivables.
   */
  const paidOnInvoice = sql`coalesce((
    select sum(${payments.amountMinor}) from ${payments}
    where ${payments.invoiceId} = ${invoices.id} and ${payments.status} = 'succeeded'
  ), 0)`;
  const remaining = sql`greatest(coalesce(${invoices.amountDueMinor}, ${invoices.totalMinor}) - ${paidOnInvoice}, 0)`;
  const stillOwed = sql`${inArray(invoices.status, [...UNPAID_STATUSES])} and not ${invoices.writtenOff}`;

  // ── One pass over the documents ───────────────────────────────────────────────────────
  // Every invoice-level figure comes off ONE grouped read, so two of them cannot disagree
  // about which invoices they saw.
  const docs = await tx
    .select({
      currency: invoices.currency,
      held: sql<string>`count(*) filter (where ${invoices.createdAt} < ${endsAt})`.as("held"),
      billedTotal:
        sql<string>`coalesce(sum(${invoices.totalMinor}) filter (where ${billedInWindow}), 0)`.as(
          "billed_total",
        ),
      voided:
        sql<string>`coalesce(sum(${invoices.totalMinor}) filter (where ${invoices.voidedAt} >= ${startsAt} and ${invoices.voidedAt} < ${endsAt}), 0)`.as(
          "voided",
        ),
      writtenOff:
        sql<string>`coalesce(sum(${invoices.totalMinor}) filter (where ${invoices.writtenOff} and ${issued}), 0)`.as(
          "written_off",
        ),
      recovered:
        sql<string>`coalesce(sum(${invoices.totalMinor}) filter (where ${invoices.dunningStatus} = 'succeeded' and ${invoices.paidAt} >= ${startsAt} and ${invoices.paidAt} < ${endsAt}), 0)`.as(
          "recovered",
        ),
      /**
       * THE OTHER HALF OF THE SAME QUESTION — what collections lost, dated.
       *
       * `amount_recovered` above has always been able to say what dunning saved, because a
       * recovered invoice carries `paid_at`. What it gave up on carried no instant at all
       * until 0282, so the two could never be put in the same period and there was no rate
       * — only `dunning_invoices`, a stock that can describe today and no earlier day.
       *
       * ⚠️ WINDOWED ON `dunning_exhausted_at` AND NOT ON THE STATUS. An invoice exhausted
       * before 0282 has the status and no date, so it is absent here rather than counted
       * into whatever period happens to be open. The series therefore begins at that
       * migration and is honestly short, which is the choice the column documents: a
       * backfilled `now()` would have drawn every exhaustion in our history as one spike
       * on the deploy date.
       */
      exhausted:
        sql<string>`coalesce(sum(${invoices.totalMinor}) filter (where ${invoices.dunningExhaustedAt} >= ${startsAt} and ${invoices.dunningExhaustedAt} < ${endsAt}), 0)`.as(
          "exhausted",
        ),
      /**
       * The same two populations as COUNTS.
       *
       * Not redundant with the amounts: a recovery rate by value and a recovery rate by
       * invoice answer different questions, and they come apart exactly where it matters —
       * one large renewal recovered among many small failures reads as a triumph by value
       * and a disaster by count. Dunning is tuned on both, so both are stored.
       */
      recoveredInvoices:
        sql<string>`count(*) filter (where ${invoices.dunningStatus} = 'succeeded' and ${invoices.paidAt} >= ${startsAt} and ${invoices.paidAt} < ${endsAt})`.as(
          "recovered_invoices",
        ),
      exhaustedInvoices:
        sql<string>`count(*) filter (where ${invoices.dunningExhaustedAt} >= ${startsAt} and ${invoices.dunningExhaustedAt} < ${endsAt})`.as(
          "exhausted_invoices",
        ),
      paidInWindow:
        sql<string>`coalesce(sum(${invoices.totalMinor}) filter (where ${invoices.status} = 'paid' and ${invoices.paidAt} >= ${startsAt} and ${invoices.paidAt} < ${endsAt}), 0)`.as(
          "paid_in_window",
        ),
      // The live figures. See `remaining` above for why cash is subtracted here.
      outstanding: sql<string>`coalesce(sum(${remaining}) filter (where ${stillOwed}), 0)`.as(
        "outstanding",
      ),
      // Invoices with something still on them. An invoice whose balance is settled is not
      // receivable however its status row still reads, so the count follows the money.
      openInvoices: sql<string>`count(*) filter (where ${stillOwed} and ${remaining} > 0)`.as(
        "open_invoices",
      ),
    })
    .from(invoices)
    .where(mine)
    .groupBy(invoices.currency);

  // ── The lines: the one-off part, and what discount took off ───────────────────────────
  const lines = await tx
    .select({
      currency: invoices.currency,
      nonRecurring:
        sql<string>`coalesce(sum(${invoiceLineItems.amountMinor}) filter (where ${invoiceLineItems.kind} = 'one_time'), 0)`.as(
          "non_recurring",
        ),
      // Not on an invoice a discount took to zero (a 100%-off trial): nothing was given up there.
      discount:
        sql<string>`coalesce(sum(coalesce(${invoiceLineItems.discountMinor}, 0)) filter (where ${invoices.totalMinor} > 0), 0)`.as(
          "discount",
        ),
    })
    .from(invoiceLineItems)
    .innerJoin(invoices, eq(invoices.id, invoiceLineItems.invoiceId))
    .where(
      and(
        eq(invoiceLineItems.businessId, businessId),
        billedInWindow,
        reportableCustomer(invoices.customerId),
      ),
    )
    .groupBy(invoices.currency);

  const taxes = await tx
    .select({
      currency: invoices.currency,
      charged: sql<string>`coalesce(sum(${appliedTaxes.amountMinor}), 0)`.as("charged"),
    })
    .from(appliedTaxes)
    .innerJoin(invoices, eq(invoices.id, appliedTaxes.invoiceId))
    .where(
      and(
        eq(appliedTaxes.businessId, businessId),
        billedInWindow,
        reportableCustomer(invoices.customerId),
      ),
    )
    .groupBy(invoices.currency);

  /**
   * The exempt base: the line value of every invoice carrying at least one line that was
   * not standard-rated.
   *
   * ⚠️ The WHOLE invoice's lines, not the exempt ones — a part-exempt document contributes
   * in full. That is what the published figure has always meant, and a measure that quietly
   * narrowed it would restate history the day it shipped. Stated here so the next reader
   * does not "fix" it into a different number.
   */
  const exempt = await tx
    .select({
      currency: invoices.currency,
      amount: sql<string>`coalesce(sum(${invoiceLineItems.amountMinor}), 0)`.as("amount"),
    })
    .from(invoiceLineItems)
    .innerJoin(invoices, eq(invoices.id, invoiceLineItems.invoiceId))
    .where(
      and(
        eq(invoiceLineItems.businessId, businessId),
        billedInWindow,
        reportableCustomer(invoices.customerId),
        sql`exists (select 1 from applied_taxes t where t.invoice_id = ${invoices.id} and t.taxability_reason <> 'standard_rated')`,
      ),
    )
    .groupBy(invoices.currency);

  // Credit notes are dated by their OWN issue date and carry their own currency.
  const credits = await tx
    .select({
      currency: creditNotes.currency,
      total: sql<string>`coalesce(sum(${creditNotes.totalMinor}), 0)`.as("total"),
    })
    .from(creditNotes)
    .where(
      and(
        and(eq(creditNotes.businessId, businessId), reportableCustomer(creditNotes.customerId)),
        gte(creditNotes.createdAt, from),
        lt(creditNotes.createdAt, toExclusive),
      ),
    )
    .groupBy(creditNotes.currency);

  // Paid in the window, by how late. Bands from the due date: an invoice with 30-day terms
  // is not late on the day it was raised, and one with no due date was due on issue.
  const band = sql<string>`case
    when ${invoices.dueDate} is null then 'on_time'
    when floor(extract(epoch from (${invoices.paidAt} - ${invoices.dueDate})) / 86400) <= 0 then 'on_time'
    when floor(extract(epoch from (${invoices.paidAt} - ${invoices.dueDate})) / 86400) <= 30 then '1_30'
    when floor(extract(epoch from (${invoices.paidAt} - ${invoices.dueDate})) / 86400) <= 60 then '31_60'
    else '60_plus' end`;
  const lateness = await tx
    .select({
      currency: invoices.currency,
      band: band.as("band"),
      total: sql<string>`coalesce(sum(${invoices.totalMinor}), 0)`.as("total"),
    })
    .from(invoices)
    .where(
      and(
        mine,
        eq(invoices.status, "paid"),
        gte(invoices.paidAt, from),
        lt(invoices.paidAt, toExclusive),
      ),
    )
    .groupBy(invoices.currency, band);

  // Revenue billed: the same billed-in-window invoices, line by line, by type and product.
  const billedDocs = await tx
    .select({ id: invoices.id, currency: invoices.currency, customerId: invoices.customerId })
    .from(invoices)
    .where(and(mine, billedInWindow));
  const folded = await billedRevenueByInvoice(
    tx,
    billedDocs.map((d) => d.id),
  );
  const customersBy = new Map<string, Set<string>>();
  for (const d of billedDocs) {
    const cur = d.currency.toUpperCase();
    const set = customersBy.get(cur) ?? new Set<string>();
    set.add(d.customerId);
    customersBy.set(cur, set);
  }
  const revenueBy = new Map<
    string,
    {
      total: bigint;
      byType: Map<string, bigint>;
      byProduct: Map<string, bigint>;
      byMeter: Map<string, bigint>;
    }
  >();
  for (const d of billedDocs) {
    const f = folded.get(d.id);
    if (!f) continue;
    const cur = d.currency.toUpperCase();
    const acc = revenueBy.get(cur) ?? {
      total: 0n,
      byType: new Map(),
      byProduct: new Map(),
      byMeter: new Map(),
    };
    for (const l of f.lines) {
      acc.total += l.amountMinor;
      acc.byType.set(l.type, (acc.byType.get(l.type) ?? 0n) + l.amountMinor);
      const product = l.productId ?? "none";
      acc.byProduct.set(product, (acc.byProduct.get(product) ?? 0n) + l.amountMinor);
      if (l.type === "usage") {
        const meter = l.meterId ?? "none";
        acc.byMeter.set(meter, (acc.byMeter.get(meter) ?? 0n) + l.amountMinor);
      }
    }
    revenueBy.set(cur, acc);
  }

  const byCurrency = <T extends { currency: string }>(list: readonly T[]) =>
    new Map(list.map((r) => [r.currency.toUpperCase(), r]));
  const lineBy = byCurrency(lines);
  const taxBy = byCurrency(taxes);
  const exemptBy = byCurrency(exempt);
  const creditBy = byCurrency(credits);

  /**
   * Which currencies get a row.
   *
   * A currency the business had raised no document in by this period writes NOTHING — the
   * same rule the book stocks follow, and for the same reason: a row of zeros claims the
   * question was asked and answered. Once a currency exists, every measure writes its
   * figure INCLUDING zero, because a measured zero and a missing row are different facts.
   */
  const held = new Set<string>();
  for (const d of docs) if (n(d.held) > 0n) held.add(d.currency.toUpperCase());
  for (const c of credits) held.add(c.currency.toUpperCase());

  for (const currency of held) {
    const d = docs.find((r) => r.currency.toUpperCase() === currency);
    const billedTotal = n(d?.billedTotal);
    const charged = n(taxBy.get(currency)?.charged);
    push("billing_gross", "", "", currency, billedTotal);
    const credited = n(creditBy.get(currency)?.total);
    push("billing_net", "", "", currency, billedTotal - credited);
    push("credit_notes_issued", "", "", currency, credited);
    push("billing_non_recurring", "", "", currency, n(lineBy.get(currency)?.nonRecurring));
    // Every type is written, zero included: the set is closed, so a zero is measured.
    const revenue = revenueBy.get(currency);
    push("revenue_billed", "", "", currency, revenue?.total ?? 0n);
    for (const t of REVENUE_TYPES) {
      push("revenue_billed", "revenue_type", t, currency, revenue?.byType.get(t) ?? 0n);
    }
    for (const [product, v] of revenue?.byProduct ?? []) {
      push("revenue_billed", "product", product, currency, v);
    }
    for (const [meter, v] of revenue?.byMeter ?? []) {
      push("revenue_billed", "meter", meter, currency, v);
    }
    const billedCustomers = BigInt(customersBy.get(currency)?.size ?? 0);
    push("billed_customers", "", "", currency, billedCustomers);
    push("revenue_per_customer", "", "", currency, revenue?.total ?? 0n, billedCustomers);
    push("tax_charged", "", "", currency, charged);
    push("taxable_base", "", "", currency, billedTotal - charged);
    push("exempt_base", "", "", currency, n(exemptBy.get(currency)?.amount));
    push("discount_given", "", "", currency, n(lineBy.get(currency)?.discount));
    push("invoice_voided", "", "", currency, n(d?.voided));
    push("invoice_written_off", "", "", currency, n(d?.writtenOff));
    push("amount_recovered", "", "", currency, n(d?.recovered));
    push("amount_exhausted", "", "", currency, n(d?.exhausted));
    push("dunning_recovered_invoices", "", "", currency, n(d?.recoveredInvoices));
    push("dunning_exhausted_invoices", "", "", currency, n(d?.exhaustedInvoices));
    /**
     * WHAT SHARE OF THE MONEY COLLECTIONS FINISHED WITH DID IT GET BACK.
     *
     * Denominator is recovered PLUS exhausted — everything dunning CLOSED in the period —
     * and deliberately not everything it attempted. An invoice still being retried has no
     * outcome yet, and counting it as a loss would make the rate a function of how much is
     * currently in flight: a business that raised a lot of new failures on the last day of
     * the month would read as having collapsed.
     *
     * Both halves are flows, so the fold is `sum`/`sum` and a quarter is its own
     * arithmetic rather than the mean of its months. A period where collections finished
     * NOTHING stores 0/0 and publishes null, not 0% — `ratioValue` refuses that division
     * once, centrally: 0% would claim everything was lost, which is a different and false
     * statement about a period that simply has no rate.
     */
    push(
      "dunning_recovery_rate",
      "",
      "",
      currency,
      n(d?.recovered),
      n(d?.recovered) + n(d?.exhausted),
    );
    push("recovery_paid_late", "", "", currency, n(d?.paidInWindow));
  }

  // The bands are only written where there is something in them: a band is a slice, and a
  // slice that never happened is absent exactly as an unused plan is.
  for (const r of lateness) {
    push("recovery_paid_late", "lateness_band", r.band, r.currency.toUpperCase(), n(r.total));
  }

  // ── The live book — only for the period that contains this run ────────────────────────
  if (now >= from && now < toExclusive) {
    for (const currency of held) {
      const d = docs.find((r) => r.currency.toUpperCase() === currency);
      push("receivables_outstanding", "", "", currency, n(d?.outstanding));
      push("receivables_invoices", "", "", currency, n(d?.openInvoices));
    }

    const dunning = await tx
      .select({
        currency: invoices.currency,
        status: invoices.dunningStatus,
        count: sql<string>`count(*)`.as("count"),
      })
      .from(invoices)
      .where(and(mine, isNotNull(invoices.dunningStatus)))
      .groupBy(invoices.currency, invoices.dunningStatus);

    const totals = new Map<string, bigint>();
    for (const r of dunning) {
      const currency = r.currency.toUpperCase();
      push("dunning_invoices", "dunning_status", r.status!, currency, n(r.count));
      totals.set(currency, (totals.get(currency) ?? 0n) + n(r.count));
    }
    for (const currency of held) {
      push("dunning_invoices", "", "", currency, totals.get(currency) ?? 0n);
    }

    /**
     * Subscriptions in dunning: only an invoice still OWED counts. `dunning_invoices` above keeps
     * every state an invoice was ever left in (recovered, stopped), which is its breakdown but
     * would never shrink as a headline. The total is the live chase — scheduled or paused — and
     * `exhausted` is a slice of its own: out of retries, still unpaid, needs a person.
     */
    const owed = and(
      mine,
      inArray(invoices.status, [...UNPAID_STATUSES]),
      isNotNull(invoices.subscriptionId),
    );
    const bySubState = await tx
      .select({
        currency: invoices.currency,
        status: invoices.dunningStatus,
        count: sql<string>`count(distinct ${invoices.subscriptionId})`.as("count"),
      })
      .from(invoices)
      .where(and(owed, inArray(invoices.dunningStatus, ["in_progress", "parked", "exhausted"])))
      .groupBy(invoices.currency, invoices.dunningStatus);
    for (const r of bySubState) {
      push(
        "dunning_subscriptions",
        "dunning_status",
        r.status!,
        r.currency.toUpperCase(),
        n(r.count),
      );
    }
    const chased = await tx
      .select({
        currency: invoices.currency,
        count: sql<string>`count(distinct ${invoices.subscriptionId})`.as("count"),
      })
      .from(invoices)
      .where(and(owed, inArray(invoices.dunningStatus, ["in_progress", "parked"])))
      .groupBy(invoices.currency);
    for (const currency of held) {
      const c = chased.find((r) => r.currency.toUpperCase() === currency);
      push("dunning_subscriptions", "", "", currency, n(c?.count));
    }

    // The revenue on exactly those subscriptions, each once at its current rate — the rate
    // is the present one because the figure is about the present.
    const chasedSubs = tx
      .select({ id: invoices.subscriptionId })
      .from(invoices)
      .where(and(owed, inArray(invoices.dunningStatus, ["in_progress", "parked"])));
    const atRisk = await tx
      .select({
        currency: subscriptions.currency,
        mrr: sql<string>`coalesce(sum(${subscriptions.mrr}), 0)`.as("mrr"),
      })
      .from(subscriptions)
      .where(
        and(
          and(
            eq(subscriptions.businessId, businessId),
            reportableCustomer(subscriptions.customerId),
          ),
          inArray(subscriptions.id, chasedSubs),
        ),
      )
      .groupBy(subscriptions.currency);
    const riskBy = new Map<string, bigint>();
    for (const r of atRisk) {
      const c = r.currency.toUpperCase();
      riskBy.set(c, (riskBy.get(c) ?? 0n) + n(r.mrr));
    }
    for (const currency of new Set([...held, ...riskBy.keys()])) {
      push("mrr_at_risk", "", "", currency, riskBy.get(currency) ?? 0n);
    }
  }

  return rows;
}
