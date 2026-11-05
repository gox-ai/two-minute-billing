import { and, eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { formatFixed12, tryParseFixed12 } from "@/platform/fixed";
import { subscriptionItems, subscriptions } from "@db/schema";
import {
  billsFromList,
  sellingRateIssues,
  type PriceSnapshot,
  type SellingOverride,
} from "@/modules/catalog/pricing";
import { auditSubscription, subscriptionSnapshot } from "./audit";

/**
 * A customer's own selling price on a `model_price_list` item (design G1b § 3.4, B4): a markup
 * for every model and per-combination rows (fixed rate or markup). It lives in the item's
 * snapshot and wins over the price's rates and markup. A catalog edit never moves it.
 */

export class SellingPriceError extends Error {
  readonly statusCode = 400;
  constructor(
    message: string,
    readonly param?: string,
  ) {
    super(message);
    this.name = "SellingPriceError";
  }
}

export interface SellingPriceInput {
  /** undefined = keep; null = remove. */
  markupPercent?: string | null;
  /** undefined = keep; null or [] = remove every row. */
  rates?: Array<{
    match: Record<string, string>;
    unitAmountDecimal?: string | null;
    markupPercent?: string | null;
  }> | null;
}

const canon = (v: string | null | undefined) => {
  if (v == null) return null;
  const f = tryParseFixed12(v);
  return f == null ? v : formatFixed12(f);
};

/** Check and normalize an override against the item's meter. Throws `SellingPriceError`. */
export function checkSellingOverride(snap: PriceSnapshot, next: SellingOverride): SellingOverride {
  if (!billsFromList(snap.amountSource) || !snap.meter)
    throw new SellingPriceError(
      "We could not set the price. A customer price applies only to a price that bills from the model price list.",
      "price",
    );
  if (next.markupPercent != null) {
    const f = tryParseFixed12(next.markupPercent);
    if (f == null || f < 0n || (next.markupPercent.split(".")[1]?.length ?? 0) > 6)
      throw new SellingPriceError(
        "The markup must be a number of 0 or more with at most 6 decimal places, with no exponent.",
        "markup_percent",
      );
  }
  const issue = sellingRateIssues(next.rates, snap.meter.groupBy, "rates")[0];
  if (issue) throw new SellingPriceError(issue.message, issue.field);
  return {
    markupPercent: canon(next.markupPercent),
    rates: next.rates.map((r) => ({
      match: r.match,
      unitAmountDecimal: canon(r.unitAmountDecimal),
      markupPercent: canon(r.markupPercent),
    })),
  };
}

/** Set, change or remove the override on one item. Audited on the subscription. */
export async function setItemSellingPrice(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  itemPublicId: string;
  change: SellingPriceInput;
}): Promise<{
  item: typeof subscriptionItems.$inferSelect;
  override: SellingOverride | null;
} | null> {
  return withTenant(input.organizationId, async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.id, input.subscriptionId),
          eq(subscriptions.businessId, input.businessId),
        ),
      )
      .for("update")
      .limit(1);
    if (!sub) return null;
    const [item] = await tx
      .select()
      .from(subscriptionItems)
      .where(
        and(
          eq(subscriptionItems.subscriptionId, sub.id),
          eq(subscriptionItems.publicId, input.itemPublicId),
        ),
      )
      .limit(1);
    if (!item) return null;
    const snap = item.priceSnapshot as PriceSnapshot | null;
    if (!snap)
      throw new SellingPriceError(
        "We could not set the price. The item has no price snapshot.",
        "item",
      );
    const cur = snap.sellingOverride;
    const merged: SellingOverride = {
      markupPercent:
        input.change.markupPercent !== undefined
          ? input.change.markupPercent
          : (cur?.markupPercent ?? null),
      rates:
        input.change.rates !== undefined
          ? (input.change.rates ?? []).map((r) => ({
              match: r.match,
              unitAmountDecimal: r.unitAmountDecimal ?? null,
              markupPercent: r.markupPercent ?? null,
            }))
          : (cur?.rates ?? []),
    };
    const next = checkSellingOverride(snap, merged);
    const empty = next.markupPercent == null && next.rates.length === 0;
    const { sellingOverride: _old, ...rest } = snap;
    const before = await subscriptionSnapshot(tx, sub);
    const [updated] = await tx
      .update(subscriptionItems)
      .set({ priceSnapshot: empty ? rest : { ...rest, sellingOverride: next } })
      .where(eq(subscriptionItems.id, item.id))
      .returning();
    await auditSubscription(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: "subscription.selling_price_change",
      before,
      after: sub,
    });
    return { item: updated!, override: empty ? null : next };
  });
}

export function serializeSellingOverride(o: SellingOverride | null | undefined) {
  if (!o) return null;
  return {
    markup_percent: o.markupPercent,
    rates: o.rates.map((r) => ({
      match: r.match,
      unit_amount_decimal: r.unitAmountDecimal,
      markup_percent: r.markupPercent,
    })),
  };
}
