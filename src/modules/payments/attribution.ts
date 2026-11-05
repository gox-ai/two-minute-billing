/**
 * Payment → line-item attribution: how much of the CASH we collected was recurring.
 *
 * ── The hole this closes ──────────────────────────────────────────────────────────────
 * `payments` and `transactions` are INVOICE-level. One invoice routinely mixes a plan
 * renewal with a setup fee, an ad-hoc charge and a proration, and one payment settles the
 * document as a whole. So the billing side could answer "how much did we BILL as recurring"
 * (`invoice_line_items.kind`) while the cash side could answer nothing at all: a payment row
 * knows only its invoice and its amount.
 *
 * ── DECISION: attribution is DERIVED, and nothing is stored ───────────────────────────
 * The three candidates were a `payment_line_allocations` table, a denormalised
 * recurring/non-recurring/tax split on the payment row, and deriving at read time. Derive
 * won, on four counts:
 *
 *  1. **Write-site coverage.** There are thirteen `insert(payments)` sites, in invoicing
 *     (service/ops/collection), payments (settlement), payment-intents, wallet and the
 *     archival importer. A stored split has to be written by EVERY one of them or it is
 *     silently short — and the intent path is the buyer's own checkout, i.e. exactly the
 *     payments a revenue report must not miss. A derivation covers all thirteen the day it
 *     ships, and covers the fourteenth for free.
 *  2. **Nothing is lost by not storing it.** The decomposition is already an enforced
 *     identity: `ops/invariants.ts:invoice_total_consistent` holds
 *     `total = Σ line.amount_minor − Σ item-level discounts`, critical severity. So every
 *     line's signed contribution to the total is a fact on disk, and the split of a payment
 *     across them is arithmetic over facts, not a new observation.
 *  3. **A stored row goes stale and has no fixer.** `regenerateInvoice` replaces an
 *     invoice's lines and `voidInvoice` reverses the document; stored allocations would
 *     then describe lines that no longer exist, with no writer anywhere responsible for
 *     repairing them. A derivation cannot disagree with the lines, because it IS the lines.
 *  4. **The read is already being paid for.** The report layer already selects every
 *     `invoice_line_items` row for a business to answer the billing-side one-off metric, so
 *     the join added here is not a new scan.
 *
 * What storing WOULD have bought — an operator overriding an allocation by hand — is not a
 * feature anybody asked for, and would need its own audited surface rather than three
 * columns. A table nobody needs is worse than a query.
 *
 * ── The allocation rule: PRO-RATA, not a priority ─────────────────────────────────────
 * A partial payment is split across the invoice's lines in proportion to each line's signed
 * contribution to the invoice total. No line has seniority, and inventing one would be
 * worse than arbitrary:
 *   · nothing in this engine treats one line of an invoice as senior to another — there is
 *     no per-line dunning, no per-line write-off, and a payment carries no instruction;
 *   · a priority rule ("recurring first", "tax first") makes the recurring share of a
 *     half-paid invoice 100% until the plan line is covered, which OVERSTATES recurring
 *     cash on precisely the dunning-stressed invoices a revenue report is asked about;
 *   · pro-rata composes. Two partial payments attribute the same as one payment of their
 *     sum (up to the one-unit remainder), so an invoice settled in instalments and one
 *     settled at once tell the same story. A priority rule breaks that.
 *
 * ── Rounding: largest remainder, and who absorbs it ───────────────────────────────────
 * Money is integer minor units, so a pro-rata share is almost never exact. Each line takes
 * `floor`-toward-zero of its exact share, then the leftover units — strictly fewer than the
 * number of lines — are handed out ONE AT A TIME to the lines with the largest absolute
 * fractional remainder, ties broken by document order (`seq`). So the remainder is absorbed
 * by the line that was owed most of it, never by a fixed bucket and never by tax.
 * **Σ allocations = the payment amount, exactly.** That is the invariant, it holds by
 * construction rather than by convention, and `scripts/verify-payment-allocation.ts` asserts
 * it on a full payment, a partial payment, a mixed multi-line invoice and a refund.
 *
 * ── Tax inside a tax-INCLUSIVE price ─────────────────────────────────────────────────
 * On an inclusive-priced line the tax is inside the line's own amount and the document
 * carries no `kind='tax'` line for it, so the tax would land in the revenue bucket and
 * `recurring`/`one_time` cash would read high by the tax inside it. That tax is backed out
 * here: the line contributes TWO weights — its amount net of tax under its own bucket, and
 * the tax under `tax`. Money moves between buckets and none is created, so Σ still equals
 * the payment exactly, and a partial payment's share of an inclusive line is split the same
 * way its cash was.
 *
 * `applied_taxes` is the authority for the amount: it is the per-line breakdown the total was
 * actually computed from, already backed out of ONE combined rate per component pool (backing
 * each component out separately overstates the tax, because each component's gross contains
 * the others'). Recomputing a rate here would be a second, weaker answer to a question the
 * document already records. The inclusive part of a document is what `applied_taxes` charged
 * less what the tax LINES printed — zero on an exclusive document, which is therefore
 * untouched — and it is placed on the lines priced inclusive, the same discriminator
 * `ops/invariants.ts:tax_lines_match_applied_taxes` uses to carve those documents out.
 *
 * KNOWN GAP: an imported invoice has tax lines and no `applied_taxes`, so nothing is backed
 * out of it; and a line priced inclusive by a region-level override rather than by its own
 * price is only recovered when it is the whole document's tax (the residual then has no
 * flagged line to sit on and is spread over the taxed lines). Neither is guessed at.
 *
 * ── Refunds ──────────────────────────────────────────────────────────────────────────
 * A refund is attributed by running the SAME allocator over the SAME weights for the amount
 * refunded, reported as a `refund` row with negated buckets. One allocator, so a net figure
 * (payments − refunds) cannot be assembled from two rules that disagree; and a fully
 * refunded payment nets to exactly zero in every bucket.
 */
import { reportableCustomer, reportablePayment } from "@/modules/metrics/reportable";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { withTenantTx, type Tx } from "@/platform/db";
import {
  appliedTaxes,
  invoiceLineDiscounts,
  invoiceLineItems,
  invoices,
  payments,
  prices,
  refunds,
} from "@db/schema";

/**
 * Where one invoice line's money lands. Mirrors `invoice_line_items.kind` one-for-one plus
 * `other` (an unrecognised kind is reported, never silently folded into revenue) and
 * `unattributed` (cash we cannot place against a line — see `attributeOne`).
 */
export type PaymentBucket =
  | "recurring"
  | "proration"
  | "usage"
  | "one_time"
  | "discount"
  | "tax"
  | "rounding"
  | "other"
  | "unattributed";

export const PAYMENT_BUCKETS: readonly PaymentBucket[] = [
  "recurring",
  "proration",
  "usage",
  "one_time",
  "discount",
  "tax",
  "rounding",
  "other",
  "unattributed",
] as const;

export type BucketTotals = Record<PaymentBucket, bigint>;

export const zeroBuckets = (): BucketTotals =>
  Object.fromEntries(PAYMENT_BUCKETS.map((b) => [b, 0n])) as BucketTotals;

/** `invoice_line_items.kind` → bucket. An unknown kind is `other`, never revenue. */
export function bucketOfLineKind(kind: string): PaymentBucket {
  switch (kind) {
    case "recurring":
    case "proration":
    case "usage":
    case "one_time":
    case "discount":
    case "tax":
    case "rounding":
      return kind;
    default:
      return "other";
  }
}

/**
 * Split `amountMinor` across `weights` in proportion, in integer minor units, losing and
 * inventing nothing: **Σ result === amountMinor**, always.
 *
 * Weights may be negative (a document-level discount line, an "Unused time" credit, a
 * net-negative tax component) and the arithmetic is sign-safe: BigInt division truncates
 * toward zero, so each share is at most one unit short in magnitude and the shortfall is
 * redistributed by largest absolute remainder, ties to the lowest index (which callers pass
 * in document order). A zero total weight allocates nothing — the caller decides what to do
 * with cash that has no weight to sit on.
 */
export function allocateProRata(amountMinor: bigint, weights: readonly bigint[]): bigint[] {
  const n = weights.length;
  if (n === 0) return [];
  let total = 0n;
  for (const w of weights) total += w;
  if (total === 0n) return weights.map(() => 0n);

  const share = new Array<bigint>(n);
  const remainder = new Array<bigint>(n);
  let allocated = 0n;
  for (let i = 0; i < n; i++) {
    const exact = amountMinor * weights[i]!;
    const q = exact / total; // truncates toward zero
    share[i] = q;
    remainder[i] = exact - q * total;
    allocated += q;
  }

  let deficit = amountMinor - allocated; // |deficit| < n, by construction
  if (deficit !== 0n) {
    const step = deficit > 0n ? 1n : -1n;
    const abs = (v: bigint) => (v < 0n ? -v : v);
    const order = [...share.keys()].sort((a, b) => {
      const ra = abs(remainder[a]!);
      const rb = abs(remainder[b]!);
      if (ra !== rb) return ra > rb ? -1 : 1;
      return a - b; // document order
    });
    for (let k = 0; deficit !== 0n; k = (k + 1) % n) {
      share[order[k]!] = share[order[k]!]! + step;
      deficit -= step;
    }
  }
  return share;
}

/**
 * One line's signed contribution to its invoice's total, with the bucket it belongs to.
 *
 * A tax-inclusive line yields TWO of these, sharing a `lineItemId`: the amount net of the
 * tax inside it under the line's own bucket, and that tax under `tax`.
 */
export interface LineWeight {
  lineItemId: string;
  kind: string;
  bucket: PaymentBucket;
  /** `amount_minor − item-level discount shares`. The term of `invoice_total_consistent`. */
  weightMinor: bigint;
}

/** One payment (or refund) with its cash placed on the invoice's lines. */
export interface PaymentAttribution {
  /** `payments.id` — the payment whose cash this row places (the refund's parent). */
  paymentId: string;
  /** `payments.public_id` / `refunds.public_id`. */
  publicId: string;
  /** `payment` = cash in, buckets positive. `refund` = cash out, buckets negated. */
  direction: "payment" | "refund";
  invoiceId: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  currency: string;
  /** Signed: positive for a payment, NEGATIVE for a refund. */
  signedAmountMinor: bigint;
  occurredAt: Date;
  /** Archival row imported from an external system — no ledger postings behind it. */
  imported: boolean;
  buckets: BucketTotals;
  /** `recurring + proration` — the subscription fee, whole periods and partial ones. */
  recurringMinor: bigint;
  /**
   * `one_time` only, deliberately: it is the same convention the billing-side one-off
   * metric already uses, so the cash figure and the billed figure are comparable. Metered
   * `usage` is NOT folded in here — it is its own bucket, because it recurs without being a
   * fixed fee and neither answer is right for every reader.
   */
  nonRecurringMinor: bigint;
  usageMinor: bigint;
  taxMinor: bigint;
  /**
   * Per-line allocations, document order. Σ === `signedAmountMinor`. A tax-inclusive line
   * appears twice — its revenue share and the tax that was inside it.
   */
  lines: Array<{ lineItemId: string; bucket: PaymentBucket; amountMinor: bigint }>;
}

/** Ids bound per statement; Postgres refuses more than 65,534 parameters. */
const ID_CHUNK = 5000;

/** The line weights of one invoice, in document order. */
async function lineWeightsFor(tx: Tx, invoiceIds: string[]): Promise<Map<string, LineWeight[]>> {
  const out = new Map<string, LineWeight[]>();
  if (invoiceIds.length === 0) return out;

  const lines = await tx
    .select({
      id: invoiceLineItems.id,
      invoiceId: invoiceLineItems.invoiceId,
      kind: invoiceLineItems.kind,
      amountMinor: invoiceLineItems.amountMinor,
      seq: invoiceLineItems.seq,
      priceId: invoiceLineItems.priceId,
    })
    .from(invoiceLineItems)
    .where(inArray(invoiceLineItems.invoiceId, invoiceIds))
    .orderBy(invoiceLineItems.seq);

  // ITEM-level discount only. The document-level stage already carries its own negative
  // `kind='discount'` line, so subtracting it here too would double-count it — 0169's
  // "two sign conventions for one concept" trap, and the reason `invoice_total_consistent`
  // subtracts exactly this one stage.
  const itemDiscounts = await tx
    .select({
      lineItemId: invoiceLineDiscounts.invoiceLineItemId,
      amountMinor: invoiceLineDiscounts.amountMinor,
    })
    .from(invoiceLineDiscounts)
    .where(
      and(
        inArray(invoiceLineDiscounts.invoiceId, invoiceIds),
        eq(invoiceLineDiscounts.scope, "item_level"),
      ),
    );
  const discountByLine = new Map<string, bigint>();
  for (const d of itemDiscounts) {
    discountByLine.set(d.lineItemId, (discountByLine.get(d.lineItemId) ?? 0n) + d.amountMinor);
  }

  const inclusiveTax = await inclusiveTaxByLine(tx, invoiceIds, lines);

  for (const l of lines) {
    const list = out.get(l.invoiceId) ?? [];
    const weightMinor = l.amountMinor - (discountByLine.get(l.id) ?? 0n);
    const base = { lineItemId: l.id, kind: l.kind, bucket: bucketOfLineKind(l.kind) };
    const t = inclusiveTax.get(l.id) ?? 0n;
    // Only split when the tax genuinely sits inside this weight: same sign, and no bigger.
    const splits =
      t !== 0n && t > 0n === weightMinor > 0n && (t > 0n ? t <= weightMinor : t >= weightMinor)
        ? [
            { ...base, weightMinor: weightMinor - t },
            { ...base, bucket: "tax" as const, weightMinor: t },
          ]
        : [{ ...base, weightMinor }];
    list.push(...splits);
    out.set(l.invoiceId, list);
  }
  return out;
}

/**
 * The tax sitting INSIDE each line, for lines priced tax-inclusive. Empty for every
 * exclusive document, which is how those stay untouched.
 *
 * The amount comes from `applied_taxes` — what was actually charged on the line. A
 * document's inclusive tax is its applied tax less what its `kind='tax'` lines printed,
 * since exclusive tax is exactly the part that became a line. That residual is placed on the
 * lines whose price is tax-inclusive; when those do not account for it (a region-level
 * inclusive override leaves no flag on the price) it is spread pro-rata over the taxed lines
 * instead, so it is never attributed to a line that carried no tax at all.
 */
async function inclusiveTaxByLine(
  tx: Tx,
  invoiceIds: string[],
  lines: Array<{
    id: string;
    invoiceId: string;
    kind: string;
    amountMinor: bigint;
    priceId: string | null;
  }>,
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();

  const applied = await tx
    .select({
      invoiceId: appliedTaxes.invoiceId,
      lineItemId: appliedTaxes.invoiceLineItemId,
      amountMinor: appliedTaxes.amountMinor,
    })
    .from(appliedTaxes)
    .where(inArray(appliedTaxes.invoiceId, invoiceIds));
  if (applied.length === 0) return out;

  const appliedByLine = new Map<string, bigint>();
  const appliedByInvoice = new Map<string, bigint>();
  for (const a of applied) {
    appliedByLine.set(a.lineItemId, (appliedByLine.get(a.lineItemId) ?? 0n) + a.amountMinor);
    appliedByInvoice.set(a.invoiceId, (appliedByInvoice.get(a.invoiceId) ?? 0n) + a.amountMinor);
  }

  const priceIds = [...new Set(lines.map((l) => l.priceId).filter((id): id is string => !!id))];
  const inclusivePrices = new Set<string>();
  if (priceIds.length > 0) {
    const rows = await tx
      .select({ id: prices.id, taxBehavior: prices.taxBehavior })
      .from(prices)
      .where(inArray(prices.id, priceIds));
    for (const r of rows) if (r.taxBehavior === "inclusive") inclusivePrices.add(r.id);
  }

  const byInvoice = new Map<string, typeof lines>();
  for (const l of lines) byInvoice.set(l.invoiceId, [...(byInvoice.get(l.invoiceId) ?? []), l]);

  for (const [invoiceId, invLines] of byInvoice) {
    const taxLineTotal = invLines
      .filter((l) => l.kind === "tax")
      .reduce((s, l) => s + l.amountMinor, 0n);
    const residual = (appliedByInvoice.get(invoiceId) ?? 0n) - taxLineTotal;
    if (residual <= 0n) continue; // exclusive, or an import with no breakdown to read

    const taxed = invLines.filter(
      (l) => l.kind !== "tax" && (appliedByLine.get(l.id) ?? 0n) !== 0n,
    );
    const flagged = taxed.filter((l) => l.priceId && inclusivePrices.has(l.priceId));
    const flaggedTotal = flagged.reduce((s, l) => s + (appliedByLine.get(l.id) ?? 0n), 0n);

    if (flaggedTotal === residual) {
      for (const l of flagged) out.set(l.id, appliedByLine.get(l.id)!);
      continue;
    }
    const targets = flagged.length > 0 ? flagged : taxed;
    if (targets.length === 0) continue;
    const shares = allocateProRata(
      residual,
      targets.map((l) => appliedByLine.get(l.id)!),
    );
    targets.forEach((l, i) => out.set(l.id, shares[i]!));
  }
  return out;
}

/**
 * Place one signed amount on one invoice's lines.
 *
 * Cash lands in `unattributed` — never guessed at, never dropped — in the three cases where
 * there is nothing to place it on: the payment names no invoice (an excess payment banked
 * against the customer), the invoice has no lines, or the weights sum to zero (a document
 * whose charges and credits cancel). The invariant holds in all three.
 */
export function attributeOne(signedAmountMinor: bigint, weights: readonly LineWeight[]) {
  const buckets = zeroBuckets();
  const lines: PaymentAttribution["lines"] = [];
  const totalWeight = weights.reduce((s, w) => s + w.weightMinor, 0n);
  if (weights.length === 0 || totalWeight === 0n) {
    buckets.unattributed = signedAmountMinor;
    return { buckets, lines };
  }
  const shares = allocateProRata(
    signedAmountMinor,
    weights.map((w) => w.weightMinor),
  );
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]!;
    const amountMinor = shares[i]!;
    buckets[w.bucket] += amountMinor;
    lines.push({ lineItemId: w.lineItemId, bucket: w.bucket, amountMinor });
  }
  return { buckets, lines };
}

const derived = (buckets: BucketTotals) => ({
  recurringMinor: buckets.recurring + buckets.proration,
  nonRecurringMinor: buckets.one_time,
  usageMinor: buckets.usage,
  taxMinor: buckets.tax,
});

export interface AttributionQuery {
  organizationId: string;
  businessId: string;
  /** Inclusive lower bound on `created_at`. Omit for all time. */
  from?: Date;
  /** Inclusive upper bound on `created_at`. Omit for all time. */
  to?: Date;
  /** Payment statuses that count as cash. Default `['succeeded']`. */
  statuses?: string[];
  /** Include `refund` rows (negated buckets). Default true — a net figure needs them. */
  includeRefunds?: boolean;
  /** Reuse an open transaction (a report already inside `withTenant`). */
  tx?: Tx;
}

/**
 * THE ENTRY POINT a report resolver calls: every payment and refund of a business in a
 * window, each with its cash placed on the invoice lines it settled.
 *
 * One row per payment and one per refund, ungrouped and un-converted: grouping, windowing
 * by report granularity and FX are the report layer's own, and it already has a converter.
 * Currency is on every row so a mixed-currency business cannot be summed by accident.
 */
export async function attributePaymentsForBusiness(
  q: AttributionQuery,
): Promise<PaymentAttribution[]> {
  const statuses = q.statuses ?? ["succeeded"];
  const includeRefunds = q.includeRefunds ?? true;

  return withTenantTx(q.organizationId, q.tx, async (tx) => {
    const payRows = await tx
      .select({
        id: payments.id,
        publicId: payments.publicId,
        invoiceId: payments.invoiceId,
        customerId: payments.customerId,
        currency: payments.currency,
        amountMinor: payments.amountMinor,
        status: payments.status,
        imported: payments.imported,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .where(
        and(
          eq(payments.businessId, q.businessId),
          // A reporting read: a customer excluded from reporting (0482) is left out.
          reportableCustomer(payments.customerId),
          inArray(payments.status, statuses),
          ...(q.from ? [gte(payments.createdAt, q.from)] : []),
          ...(q.to ? [lte(payments.createdAt, q.to)] : []),
        ),
      );

    const refundRows = includeRefunds
      ? await tx
          .select({
            id: refunds.id,
            publicId: refunds.publicId,
            paymentId: refunds.paymentId,
            currency: refunds.currency,
            amountMinor: refunds.amountMinor,
            imported: refunds.imported,
            createdAt: refunds.createdAt,
          })
          .from(refunds)
          .where(
            and(
              eq(refunds.businessId, q.businessId),
              reportablePayment(refunds.paymentId),
              eq(refunds.status, "succeeded"),
              ...(q.from ? [gte(refunds.createdAt, q.from)] : []),
              ...(q.to ? [lte(refunds.createdAt, q.to)] : []),
            ),
          )
      : [];

    // A refund's parent payment may sit outside the window — the refund still has to know
    // which invoice it is giving money back on, so parents are fetched by id rather than
    // looked up in `payRows`.
    const parentIds = [...new Set(refundRows.map((r) => r.paymentId))].filter(
      (id) => !payRows.some((p) => p.id === id),
    );
    const parents = parentIds.length
      ? await tx
          .select({
            id: payments.id,
            invoiceId: payments.invoiceId,
            customerId: payments.customerId,
          })
          .from(payments)
          .where(inArray(payments.id, parentIds))
      : [];
    const invoiceOfPayment = new Map<string, { invoiceId: string | null; customerId: string }>();
    for (const p of payRows) invoiceOfPayment.set(p.id, p);
    const customerOfPayment = new Map<string, string | null>();
    for (const p of payRows) customerOfPayment.set(p.id, p.customerId);
    for (const p of parents) {
      invoiceOfPayment.set(p.id, { invoiceId: p.invoiceId, customerId: p.customerId });
      customerOfPayment.set(p.id, p.customerId);
    }

    const invoiceIds = [
      ...new Set(
        [...invoiceOfPayment.values()].map((v) => v.invoiceId).filter((id): id is string => !!id),
      ),
    ];
    // In chunks: a day's payments can name more invoices than one statement may bind
    // (65,534 parameters — a 1M-customer renewal day, D4 load test).
    const weightsByInvoice = new Map<string, LineWeight[]>();
    const subscriptionOfInvoice = new Map<string, string | null>();
    for (let i = 0; i < invoiceIds.length; i += ID_CHUNK) {
      const chunk = invoiceIds.slice(i, i + ID_CHUNK);
      for (const [k, v] of await lineWeightsFor(tx, chunk)) weightsByInvoice.set(k, v);
      for (const [k, v] of await subscriptionsOf(tx, chunk)) subscriptionOfInvoice.set(k, v);
    }

    const out: PaymentAttribution[] = [];
    for (const p of payRows) {
      const weights = p.invoiceId ? (weightsByInvoice.get(p.invoiceId) ?? []) : [];
      const { buckets, lines } = attributeOne(p.amountMinor, weights);
      out.push({
        paymentId: p.id,
        publicId: p.publicId,
        direction: "payment",
        invoiceId: p.invoiceId,
        customerId: p.customerId,
        subscriptionId: p.invoiceId ? (subscriptionOfInvoice.get(p.invoiceId) ?? null) : null,
        currency: p.currency,
        signedAmountMinor: p.amountMinor,
        occurredAt: p.createdAt,
        imported: p.imported,
        buckets,
        ...derived(buckets),
        lines,
      });
    }
    for (const r of refundRows) {
      const parent = invoiceOfPayment.get(r.paymentId);
      const invoiceId = parent?.invoiceId ?? null;
      const weights = invoiceId ? (weightsByInvoice.get(invoiceId) ?? []) : [];
      const signed = -r.amountMinor;
      const { buckets, lines } = attributeOne(signed, weights);
      out.push({
        paymentId: r.paymentId,
        publicId: r.publicId,
        direction: "refund",
        invoiceId,
        customerId: customerOfPayment.get(r.paymentId) ?? null,
        subscriptionId: invoiceId ? (subscriptionOfInvoice.get(invoiceId) ?? null) : null,
        currency: r.currency,
        signedAmountMinor: signed,
        occurredAt: r.createdAt,
        imported: r.imported,
        buckets,
        ...derived(buckets),
        lines,
      });
    }
    out.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    return out;
  });
}

/** The subscription each invoice belongs to, so a report can group cash by plan. */
async function subscriptionsOf(tx: Tx, invoiceIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (invoiceIds.length === 0) return out;
  const rows = await tx
    .select({ id: invoices.id, subscriptionId: invoices.subscriptionId })
    .from(invoices)
    .where(inArray(invoices.id, invoiceIds));
  for (const r of rows) out.set(r.id, r.subscriptionId);
  return out;
}

/**
 * The same attribution for ONE invoice's cash — the invoice page's "what did this money pay
 * for", and the cheap path when a caller already knows the invoice.
 */
export async function attributeInvoicePayments(input: {
  organizationId: string;
  invoiceId: string;
  statuses?: string[];
  includeRefunds?: boolean;
  tx?: Tx;
}): Promise<PaymentAttribution[]> {
  const statuses = input.statuses ?? ["succeeded"];
  return withTenantTx(input.organizationId, input.tx, async (tx) => {
    const payRows = await tx
      .select({
        id: payments.id,
        publicId: payments.publicId,
        businessId: payments.businessId,
        customerId: payments.customerId,
        currency: payments.currency,
        amountMinor: payments.amountMinor,
        imported: payments.imported,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .where(and(eq(payments.invoiceId, input.invoiceId), inArray(payments.status, statuses)));
    if (payRows.length === 0) return [];
    const weights = (await lineWeightsFor(tx, [input.invoiceId])).get(input.invoiceId) ?? [];
    const subscriptionId =
      (await subscriptionsOf(tx, [input.invoiceId])).get(input.invoiceId) ?? null;

    const out: PaymentAttribution[] = [];
    for (const p of payRows) {
      const { buckets, lines } = attributeOne(p.amountMinor, weights);
      out.push({
        paymentId: p.id,
        publicId: p.publicId,
        direction: "payment",
        invoiceId: input.invoiceId,
        customerId: p.customerId,
        subscriptionId,
        currency: p.currency,
        signedAmountMinor: p.amountMinor,
        occurredAt: p.createdAt,
        imported: p.imported,
        buckets,
        ...derived(buckets),
        lines,
      });
    }
    if (input.includeRefunds ?? true) {
      const refundRows = await tx
        .select({
          id: refunds.id,
          publicId: refunds.publicId,
          paymentId: refunds.paymentId,
          currency: refunds.currency,
          amountMinor: refunds.amountMinor,
          imported: refunds.imported,
          createdAt: refunds.createdAt,
        })
        .from(refunds)
        .where(
          and(
            inArray(
              refunds.paymentId,
              payRows.map((p) => p.id),
            ),
            eq(refunds.status, "succeeded"),
          ),
        );
      for (const r of refundRows) {
        const signed = -r.amountMinor;
        const { buckets, lines } = attributeOne(signed, weights);
        out.push({
          paymentId: r.paymentId,
          publicId: r.publicId,
          direction: "refund",
          invoiceId: input.invoiceId,
          customerId: payRows.find((p) => p.id === r.paymentId)?.customerId ?? null,
          subscriptionId,
          currency: r.currency,
          signedAmountMinor: signed,
          occurredAt: r.createdAt,
          imported: r.imported,
          buckets,
          ...derived(buckets),
          lines,
        });
      }
    }
    out.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    return out;
  });
}

/** Sum a set of attributions into one bucket vector per currency. */
export function totalsByCurrency(rows: PaymentAttribution[]): Map<string, BucketTotals> {
  const out = new Map<string, BucketTotals>();
  for (const r of rows) {
    const acc = out.get(r.currency) ?? zeroBuckets();
    for (const b of PAYMENT_BUCKETS) acc[b] += r.buckets[b];
    out.set(r.currency, acc);
  }
  return out;
}

// ── The revenue mix ──────────────────────────────────────────────────────────────────────

/**
 * What a line earned as. A closed set, stored as the `revenue_type` metric key. Proration is
 * part of `recurring`; a one-time line whose price grants a credit pack is `credit_pack`, so
 * product sales and credit top-ups are never one figure.
 */
export const REVENUE_TYPES = ["recurring", "usage", "one_time", "credit_pack"] as const;
export type RevenueType = (typeof REVENUE_TYPES)[number];

export interface RevenueLineInfo {
  type: RevenueType;
  productId: string | null;
  /** A usage line's meter (row id), from its rating. */
  meterId: string | null;
}

const REVENUE_BUCKETS: ReadonlySet<PaymentBucket> = new Set([
  "recurring",
  "proration",
  "usage",
  "one_time",
]);

function typeOfBucket(bucket: PaymentBucket): RevenueType {
  return bucket === "proration" ? "recurring" : (bucket as RevenueType);
}

/** Type and product of each revenue line. Tax, discount, rounding and unknown kinds are absent. */
export async function revenueLineInfo(
  tx: Tx,
  lineIds: readonly string[],
): Promise<Map<string, RevenueLineInfo>> {
  const out = new Map<string, RevenueLineInfo>();
  const ids = [...new Set(lineIds)];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const rows = await tx
      .select({
        id: invoiceLineItems.id,
        kind: invoiceLineItems.kind,
        productId: prices.productId,
        grantsCredit: prices.grantsCredit,
        meterId: sql<string | null>`${invoiceLineItems.rating} ->> 'meter'`,
      })
      .from(invoiceLineItems)
      .leftJoin(prices, eq(prices.id, invoiceLineItems.priceId))
      .where(
        and(
          inArray(invoiceLineItems.id, ids.slice(i, i + ID_CHUNK)),
          inArray(invoiceLineItems.kind, ["recurring", "proration", "usage", "one_time"]),
        ),
      );
    for (const r of rows) {
      const type: RevenueType =
        r.kind === "one_time" && r.grantsCredit?.kind === "pack"
          ? "credit_pack"
          : typeOfBucket(bucketOfLineKind(r.kind));
      out.set(r.id, { type, productId: r.productId, meterId: r.meterId });
    }
  }
  return out;
}

export interface FoldedRevenue {
  /** One entry per revenue line, document discount included. */
  lines: Array<{
    type: RevenueType;
    productId: string | null;
    meterId: string | null;
    amountMinor: bigint;
  }>;
  /** Document discount with no revenue to sit on (the revenue lines net to zero). */
  unallocatedMinor: bigint;
}

/**
 * Signed line amounts → revenue per line. The document-level discount (`discount` bucket) is
 * shared over the revenue lines pro rata, so every partition of the result (by type, by
 * product) sums to the same total. Tax, rounding, `other` and `unattributed` are left out.
 */
export function foldRevenue(
  entries: ReadonlyArray<{ lineItemId: string; bucket: PaymentBucket; amountMinor: bigint }>,
  info: ReadonlyMap<string, RevenueLineInfo>,
): FoldedRevenue {
  const revenue = entries.filter((e) => REVENUE_BUCKETS.has(e.bucket));
  const discount = entries
    .filter((e) => e.bucket === "discount")
    .reduce((s, e) => s + e.amountMinor, 0n);
  const weights = revenue.map((e) => e.amountMinor);
  const total = weights.reduce((s, w) => s + w, 0n);
  const shares =
    discount !== 0n && total !== 0n ? allocateProRata(discount, weights) : weights.map(() => 0n);
  return {
    lines: revenue.map((e, i) => {
      const meta = info.get(e.lineItemId);
      return {
        type: meta?.type ?? typeOfBucket(e.bucket),
        productId: meta?.productId ?? null,
        meterId: meta?.meterId ?? null,
        amountMinor: e.amountMinor + shares[i]!,
      };
    }),
    unallocatedMinor: total === 0n ? discount : 0n,
  };
}

/**
 * Billed revenue per invoice: each line's share of the total (item discounts and inclusive
 * tax already out, `lineWeightsFor`), folded by `foldRevenue`.
 */
export async function billedRevenueByInvoice(
  tx: Tx,
  invoiceIds: readonly string[],
): Promise<Map<string, FoldedRevenue>> {
  const out = new Map<string, FoldedRevenue>();
  for (let i = 0; i < invoiceIds.length; i += ID_CHUNK) {
    const weights = await lineWeightsFor(tx, invoiceIds.slice(i, i + ID_CHUNK));
    const info = await revenueLineInfo(
      tx,
      [...weights.values()].flat().map((w) => w.lineItemId),
    );
    for (const [invoiceId, list] of weights) {
      out.set(
        invoiceId,
        foldRevenue(
          list.map((w) => ({
            lineItemId: w.lineItemId,
            bucket: w.bucket,
            amountMinor: w.weightMinor,
          })),
          info,
        ),
      );
    }
  }
  return out;
}
