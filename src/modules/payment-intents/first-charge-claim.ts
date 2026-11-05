/**
 * One owner for a registration payment that may pay a first invoice
 * (`payment_intents.first_charge_minor`): the signup that books it, or the setup refund that
 * gives it back. Claimed atomically on the setup intent row, so the two can never both act.
 */
import { and, eq, isNull } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { gatewayAccounts, paymentIntents } from "@db/schema";

export type FirstChargeClaim = "booked" | "refunded";

/** Take the payment for `claim`. True when this caller now holds it. */
export async function claimFirstCharge(
  organizationId: string,
  intentId: string,
  claim: FirstChargeClaim,
): Promise<boolean> {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .update(paymentIntents)
      .set({ firstChargeClaim: claim })
      .where(and(eq(paymentIntents.id, intentId), isNull(paymentIntents.firstChargeClaim)))
      .returning({ id: paymentIntents.id }),
  );
  return rows.length === 1;
}

/** Give a `booked` claim back (the commit did not happen), or move it to `refunded`. */
export async function releaseFirstCharge(
  organizationId: string,
  intentId: string,
  to: null | "refunded",
): Promise<void> {
  await withTenant(organizationId, (tx) =>
    tx
      .update(paymentIntents)
      .set({ firstChargeClaim: to })
      .where(and(eq(paymentIntents.id, intentId), eq(paymentIntents.firstChargeClaim, "booked"))),
  );
}

/**
 * The setup refund's side, by the gateway charge id. `none`: no first-charge intent names
 * it (an ordinary auth amount), so the refund goes ahead as before.
 */
export async function claimFirstChargeForRefund(
  providerKey: string,
  providerChargeId: string,
): Promise<"claimed" | "booked" | "refunded" | "none"> {
  const [row] = await systemDb
    .select({ id: paymentIntents.id, claim: paymentIntents.firstChargeClaim })
    .from(paymentIntents)
    .innerJoin(gatewayAccounts, eq(gatewayAccounts.id, paymentIntents.gatewayAccountId))
    .where(
      and(
        eq(gatewayAccounts.gatewayKey, providerKey),
        eq(paymentIntents.intentAtGateway, providerChargeId),
        eq(paymentIntents.purpose, "setup"),
      ),
    )
    .limit(1);
  if (!row) return "none";
  if (row.claim === "refunded") return "claimed";
  if (row.claim === "booked") return "booked";
  const won = await systemDb
    .update(paymentIntents)
    .set({ firstChargeClaim: "refunded" })
    .where(and(eq(paymentIntents.id, row.id), isNull(paymentIntents.firstChargeClaim)))
    .returning({ id: paymentIntents.id });
  return won.length === 1 ? "claimed" : "booked";
}
