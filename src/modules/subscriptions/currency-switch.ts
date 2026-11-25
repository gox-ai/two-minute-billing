import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import {
  appliedCoupons,
  coupons,
  invoices,
  prices,
  subscriptionItems,
  unbilledCharges,
} from "@db/schema";
import { OPEN_INVOICE_STATUSES } from "@/modules/invoicing/status";

/**
 * A subscription bills in ONE currency, and may move to another only where nothing has to
 * be netted across the two: a reactivation (a fresh term, no proration) or a change that
 * lands at the term end (the renewal then bills the new term wholly in the new currency).
 * Mid-term, a credit in one currency cannot net against a charge in another.
 */

/** What still holds money in the old currency, as words for the refusal. */
async function oldCurrencyBlockers(tx: Tx, subscriptionId: string): Promise<string[]> {
  const blockers: string[] = [];
  const [charge] = await tx
    .select({ id: unbilledCharges.id })
    .from(unbilledCharges)
    .where(
      and(
        eq(unbilledCharges.subscriptionId, subscriptionId),
        eq(unbilledCharges.status, "pending"),
      ),
    )
    .limit(1);
  if (charge) blockers.push("unbilled charges");
  const [open] = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.subscriptionId, subscriptionId),
        inArray(invoices.status, [...OPEN_INVOICE_STATUSES]),
        sql`coalesce(${invoices.amountDueMinor}, 0) > 0`,
      ),
    )
    .limit(1);
  if (open) blockers.push("an unpaid invoice");
  const [fixed] = await tx
    .select({ id: appliedCoupons.id })
    .from(appliedCoupons)
    .innerJoin(coupons, eq(coupons.id, appliedCoupons.couponId))
    .where(
      and(
        eq(appliedCoupons.subscriptionId, subscriptionId),
        eq(appliedCoupons.status, "active"),
        eq(coupons.kind, "fixed_amount"),
        isNotNull(coupons.amountOffMinor),
      ),
    )
    .limit(1);
  if (fixed) blockers.push("a fixed-amount coupon");
  return blockers;
}

function refusal(from: string, to: string, blockers: string[]): string {
  return (
    `We could not change the currency from ${from} to ${to}. ` +
    `The subscription has ${blockers.join(", ")} in ${from}. ` +
    `Settle or remove them, then try again.`
  );
}

/**
 * The currency a reactivation's new line set bills in. Returns the currency to bill in;
 * throws `makeError(message)` when the move is refused.
 */
export async function reactivationCurrency(
  tx: Tx,
  sub: { id: string; currency: string },
  priceCurrencies: string[],
  makeError: (message: string) => Error,
): Promise<string> {
  const wanted = [...new Set(priceCurrencies)];
  if (wanted.length > 1) {
    throw makeError("All prices of a subscription must use the same currency.");
  }
  const target = wanted[0];
  if (!target || target === sub.currency) return sub.currency;
  const blockers = await oldCurrencyBlockers(tx, sub.id);
  if (blockers.length > 0) throw makeError(refusal(sub.currency, target, blockers));
  return target;
}

/**
 * The currency an item edit leaves the subscription in. Unchanged when every new price is
 * in the subscription's currency. Otherwise the edit must land at the term end (`now` at or
 * past it), move EVERY item to one new currency, and leave nothing owed or metered in the
 * old one (metered usage of the closing term is billed at the renewal).
 */
export async function changeCurrency(
  tx: Tx,
  sub: {
    id: string;
    businessId: string;
    currency: string;
    currentPeriodEnd: Date | null;
    trialEnd: Date | null;
  },
  edit: {
    changes?: Array<{ itemId: string; newPriceId?: string }>;
    adds?: Array<{ priceId: string }>;
    removes?: string[];
  },
  now: Date,
  makeError: (message: string) => Error,
): Promise<string> {
  const newPriceIds = [
    ...(edit.changes ?? []).flatMap((c) => (c.newPriceId ? [c.newPriceId] : [])),
    ...(edit.adds ?? []).map((a) => a.priceId),
  ];
  if (newPriceIds.length === 0) return sub.currency;
  const rows = await tx
    .select({ currency: prices.currency })
    .from(prices)
    .where(and(eq(prices.businessId, sub.businessId), inArray(prices.publicId, newPriceIds)));
  const wanted = [...new Set(rows.map((r) => r.currency))];
  if (!wanted.some((c) => c !== sub.currency)) return sub.currency;
  if (wanted.length > 1) {
    throw makeError("All prices of a subscription must use the same currency.");
  }
  const target = wanted[0]!;

  const termEnd = sub.currentPeriodEnd ?? sub.trialEnd;
  if (!termEnd || now.getTime() < termEnd.getTime()) {
    throw makeError(
      `You can change the currency from ${sub.currency} to ${target} only at the end of the term. Apply the change at the next renewal.`,
    );
  }

  const repriced = new Set((edit.changes ?? []).filter((c) => c.newPriceId).map((c) => c.itemId));
  const removed = new Set(edit.removes ?? []);
  const items = await tx
    .select({
      publicId: subscriptionItems.publicId,
      currency: prices.currency,
      metered: sql<boolean>`(${prices.usageAggregation} is not null or ${prices.meterId} is not null)`,
    })
    .from(subscriptionItems)
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .where(eq(subscriptionItems.subscriptionId, sub.id));
  const left = items.filter(
    (i) => !removed.has(i.publicId) && !repriced.has(i.publicId) && i.currency !== target,
  );
  if (left.length > 0) {
    throw makeError(
      `We could not change the currency to ${target}. ${left.length} item(s) stay in ${sub.currency}. Change or remove every item so that all of them are in ${target}.`,
    );
  }

  const blockers = await oldCurrencyBlockers(tx, sub.id);
  if (items.some((i) => i.metered)) blockers.push("metered items");
  if (blockers.length > 0) throw makeError(refusal(sub.currency, target, blockers));
  return target;
}
