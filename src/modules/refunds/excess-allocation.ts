/**
 * Which payments still hold a customer's excess credit.
 *
 * The excess bucket is one pooled balance per customer and currency: an invoice draw
 * (`credit_applied`, keyed by the INVOICE) does not say whose money it took. Each payment's
 * credit is a lot, and every draw that is not a payment's own row is taken from the oldest
 * lot first. The engine draws the pool with no per-payment order, so oldest-first is the
 * rule here. A draw never makes the remaining amounts sum to more than the bucket: they sum
 * to it exactly.
 *
 * Pure, so the allocation is unit-tested without a database.
 */

/** Ledger sources that move ONE payment's excess, keyed by the payment's public id. */
export const PAYMENT_OWN_SOURCES = new Set([
  "excess_payment",
  "excess_refund_reserve",
  "excess_refund_release",
  "excess_payment_reversal",
]);

export interface ExcessEntry {
  /** Ledger entry id (uuid v7: its text order is the real clock, also under Time Travel). */
  id: string;
  direction: "credit" | "debit";
  amountMinor: bigint;
  currency: string;
  sourceType: string;
  sourceId: string;
}

export interface PaymentExcess {
  paymentPublicId: string;
  currency: string;
  /** What the payment put on the bucket, less its own refunds and reversals. */
  ownMinor: bigint;
  /** What is still on the bucket from this payment after the draws, oldest lot first. */
  remainingMinor: bigint;
}

/**
 * @param payments public ids of this business's payments; a credit from any other source
 *   is a lot with no payment row (it still takes its turn in the queue).
 * @param absorbEntries ledger entry id → payment public id: an overpayment's recorded absorb,
 *   the draw its own invoice took. It comes off that payment's lot, not the oldest one.
 */
export function allocateExcess(
  entries: readonly ExcessEntry[],
  payments: ReadonlySet<string>,
  absorbEntries: ReadonlyMap<string, string> = new Map(),
): PaymentExcess[] {
  type Lot = { key: string; payment: string | null; currency: string; order: string; net: bigint };
  const lots = new Map<string, Lot>();
  const drawn = new Map<string, bigint>();
  const lot = (key: string, payment: string | null, e: ExcessEntry) => {
    let l = lots.get(key);
    if (!l) {
      l = { key, payment, currency: e.currency, order: e.id, net: 0n };
      lots.set(key, l);
    }
    if (e.id < l.order) l.order = e.id;
    return l;
  };
  for (const e of entries) {
    const signed = e.direction === "credit" ? e.amountMinor : -e.amountMinor;
    const absorbedBy = absorbEntries.get(e.id);
    if (absorbedBy && payments.has(absorbedBy) && e.direction === "debit") {
      lot(`${e.currency}:${absorbedBy}`, absorbedBy, e).net += signed;
    } else if (PAYMENT_OWN_SOURCES.has(e.sourceType) && payments.has(e.sourceId)) {
      lot(`${e.currency}:${e.sourceId}`, e.sourceId, e).net += signed;
    } else if (e.direction === "credit") {
      lot(`${e.currency}:entry:${e.id}`, null, e).net += signed;
    } else {
      drawn.set(e.currency, (drawn.get(e.currency) ?? 0n) + e.amountMinor);
    }
  }
  // A lot's order is its first entry; an absorb or a refund always follows its own credit.
  const ordered = [...lots.values()].sort((a, b) => (a.order < b.order ? -1 : 1));
  const out: PaymentExcess[] = [];
  for (const l of ordered) {
    const own = l.net > 0n ? l.net : 0n;
    const left = drawn.get(l.currency) ?? 0n;
    const take = left < own ? left : own;
    drawn.set(l.currency, left - take);
    if (l.payment)
      out.push({
        paymentPublicId: l.payment,
        currency: l.currency,
        ownMinor: own,
        remainingMinor: own - take,
      });
  }
  return out;
}
