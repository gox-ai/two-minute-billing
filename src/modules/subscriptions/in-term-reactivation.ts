import { and, desc, eq, ne } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { invoices, prices, subscriptionItems, subscriptions } from "@db/schema";
import { invoiceOutstanding } from "@/modules/invoicing/service";

/**
 * In-term reactivation: a subscription that DUNNING cancelled, reactivated before its term
 * ends, continues that term. The term already has its invoice, so nothing new is raised —
 * billing a fresh term would charge the customer twice for the same dates. The term's
 * invoice keeps whatever balance it had; reactivating does not collect it (unless the
 * business requires a successful charge, see `reactivateAndBill`).
 *
 * Eligible only when the term's invoice exists and is not voided: a reactivation the
 * engine refused voids its own invoice and cancels again, and must not come back free.
 */
export interface InTermReactivation {
  periodEnd: Date;
  invoice: typeof invoices.$inferSelect;
  /** What the term's invoice still has to collect, net of credits and payments. */
  outstandingMinor: bigint;
}

/** `auto` continues when eligible; `continue` requires it; `new` always opens a fresh term. */
export type ReactivationTerm = "auto" | "continue" | "new";

/**
 * What a failed reactivation charge does: `refuse` leaves the subscription cancelled,
 * `dun` reactivates it and hands the open invoice to dunning.
 */
export type ChargeFailureChoice = "refuse" | "dun";

/** The request's choice, else the business rule (`requireSuccessfulChargeOnReactivation`). */
export function requiresChargeOnReactivation(
  businessRule: boolean,
  choice: ChargeFailureChoice | undefined,
): boolean {
  return choice ? choice === "refuse" : businessRule;
}

export const IN_TERM_REFUSAL =
  "We could not continue the current term. Only a subscription cancelled for non-payment, inside its term, with the same items and no trial, backdate or payment fields, can continue its term. Use term=new to start a new term.";

/** Cancel reasons dunning writes (`dunning.ts`). */
const DUNNING_CANCEL_REASONS = new Set(["no_card", "not_paid"]);

export async function findInTermReactivation(
  tx: Tx,
  sub: typeof subscriptions.$inferSelect,
  now: Date,
): Promise<InTermReactivation | null> {
  if (sub.status !== "cancelled") return null;
  if (!sub.cancelReason || !DUNNING_CANCEL_REASONS.has(sub.cancelReason)) return null;
  const start = sub.currentPeriodStart;
  const end = sub.currentPeriodEnd;
  if (!start || !end || now >= end || now < start) return null;
  if (sub.canceledAt && sub.canceledAt < start) return null;
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.subscriptionId, sub.id),
        eq(invoices.periodStart, start),
        ne(invoices.status, "voided"),
      ),
    )
    .orderBy(desc(invoices.createdAt))
    .limit(1);
  if (!invoice) return null;
  const { remainingMinor } = await invoiceOutstanding(tx, invoice);
  return { periodEnd: end, invoice, outstandingMinor: remainingMinor };
}

/**
 * Whether a requested line set is the one the subscription already has. The edit screen
 * always posts the full line set, so "no change" has to be read off it. An omitted
 * `unitPriceMinor` / `freeQuantity` / `billingCycles` keeps the stored value.
 */
export async function sameItemSet(
  tx: Tx,
  subscriptionId: string,
  items:
    | Array<{
        price: string;
        quantity?: number | null;
        unitPriceMinor?: number | null;
        freeQuantity?: number | null;
        billingCycles?: number | null;
      }>
    | undefined,
): Promise<boolean> {
  if (!items || items.length === 0) return true;
  const rows = await tx
    .select({ item: subscriptionItems, pricePublicId: prices.publicId })
    .from(subscriptionItems)
    .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .where(eq(subscriptionItems.subscriptionId, subscriptionId));
  if (rows.length !== items.length) return false;
  const unmatched = [...rows];
  for (const it of items) {
    const i = unmatched.findIndex(({ item, pricePublicId }) => {
      const snap = item.priceSnapshot as { amountMinor?: number | null } | null;
      return (
        pricePublicId === it.price &&
        item.quantity === (it.quantity ?? 1) &&
        (it.unitPriceMinor == null || snap?.amountMinor === it.unitPriceMinor) &&
        (it.freeQuantity == null || item.freeQuantity === it.freeQuantity) &&
        (it.billingCycles == null || item.billingCycles === it.billingCycles)
      );
    });
    if (i < 0) return false;
    unmatched.splice(i, 1);
  }
  return true;
}
