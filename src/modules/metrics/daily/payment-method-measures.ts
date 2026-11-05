import { reportableCustomer } from "../reportable";
import { and, eq } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { paymentMethods } from "@db/schema";
import type { DimensionId } from "./measures";
import type { MetricDailyRow } from "./write";

/**
 * The saved-card measures (Phase 7, group 4).
 *
 * ── THESE HAVE NO HISTORY, AND SAY SO ─────────────────────────────────────────────────
 * Nothing records what a vault looked like last March. `payment_methods.status` is the
 * engine's current verdict with no audit trail behind it, and "expiring" is defined against
 * a horizon measured from NOW — ninety days from last March is not ninety days from today.
 * So both measures carry `asOf: "computed_at"` and are written ONLY for the period that
 * contains the run. A past period gets no row, which a reader states as unknown.
 *
 * Backfilling a past period from the printed expiry dates alone would look plausible and be
 * false twice over: it would ignore every card the engine has since marked expired for a
 * reason other than its date, and it would silently omit every card added since. A
 * fabricated history is worse than a gap.
 *
 * ── THE WINDOW ────────────────────────────────────────────────────────────────────────
 * The card's OWN expiry date, compared against the instant of the run — not the period, and
 * not the day the card was vaulted. A card is good to the last instant of the month it
 * prints, which is how every issuer means it.
 *
 * No currency: a card has none, so both are stored under `XXX`.
 */

/** 90 days, the horizon the published report has always used for "expiring". */
const EXPIRING_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;

/** The stored slices each measure emits — paired against the registry's declaration. */
export const PAYMENT_METHOD_MEASURE_DIMS: Record<string, readonly DimensionId[]> = {
  cards_expired: [],
  cards_expiring: [],
};

/** Both are as-of-the-run stocks; neither is a flow. */
export const PAYMENT_METHOD_MEASURES = ["cards_expired", "cards_expiring"] as const;

/** The last instant of the month a card prints. Null when it prints no date at all. */
export function cardExpiresAt(month: number | null, year: number | null): Date | null {
  if (month == null || year == null) return null;
  return new Date(Date.UTC(year, month, 1) - 1);
}

export async function computePaymentMethodMeasures(input: {
  tx: Tx;
  businessId: string;
  from: Date;
  toExclusive: Date;
  /** The instant the compute is running at. These two measures describe nothing else. */
  now: Date;
}): Promise<MetricDailyRow[]> {
  const { tx, businessId, from, toExclusive, now } = input;
  // A past period cannot be answered, so it is left alone rather than given today's count.
  if (now < from || now >= toExclusive) return [];

  const cards = await tx
    .select({
      status: paymentMethods.status,
      expMonth: paymentMethods.expMonth,
      expYear: paymentMethods.expYear,
    })
    .from(paymentMethods)
    .where(
      and(eq(paymentMethods.businessId, businessId), reportableCustomer(paymentMethods.customerId)),
    );

  // A business that has never vaulted a card writes NOTHING — the same rule the invoice
  // group follows for one holding no documents. A zero would claim a vault was inspected
  // and found sound when there is no vault.
  if (cards.length === 0) return [];

  const horizon = new Date(now.getTime() + EXPIRING_HORIZON_MS);
  let expired = 0n;
  let expiring = 0n;
  for (const c of cards) {
    const at = cardExpiresAt(c.expMonth, c.expYear);
    // The stored status is the engine's own verdict and takes precedence; the printed date
    // is the fallback for a card nothing has re-checked yet.
    if (c.status === "expired" || (at != null && at < now)) expired += 1n;
    // Two INDEPENDENT predicates, not two halves of one. A card the engine has marked
    // expired whose printed date is still in the future counts in both — it is a card you
    // cannot charge and a renewal date you can still chase, and that is the figure the
    // published reports have always given. The overlap is stated, not netted away.
    if (at != null && at >= now && at <= horizon) expiring += 1n;
  }

  return [
    { measure: "cards_expired", dim: "", dimValue: "", currency: "XXX", value: expired },
    { measure: "cards_expiring", dim: "", dimValue: "", currency: "XXX", value: expiring },
  ];
}
