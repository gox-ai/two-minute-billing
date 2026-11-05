// Side effect: registers the usage-controls event sink. A settled payment may reach a limit
// tier (design G5 §3.3); a grant change marks the customer dirty so balance alerts see it.
import { and, eq } from "drizzle-orm";
import { registerEventSink, type EventRow } from "@/modules/events/emit";
import type { Tx } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { creditGrants, payments } from "@db/schema";
import { markDirty, usageControlsActive } from "./dirty";
import { evaluateTiers } from "./limits";

const log = createLogger("usage-controls.sink");

const GRANT_EVENTS = new Set([
  "credit_grant_created",
  "credit_grant_activated",
  "credit_grant_expired",
  "credit_grant_voided",
  "credit_grant_restored",
  "credit_grant_applied",
]);

export async function usageControlsSink(tx: Tx, ev: EventRow): Promise<void> {
  if (!ev.businessId || !ev.resourceId) return;
  if (ev.type !== "payment_succeeded" && !GRANT_EVENTS.has(ev.type)) return;
  if (!(await usageControlsActive(tx, ev.businessId))) return;
  if (ev.type === "payment_succeeded") {
    const [p] = await tx
      .select({
        customerId: payments.customerId,
        currency: payments.currency,
        status: payments.status,
      })
      .from(payments)
      .where(and(eq(payments.businessId, ev.businessId), eq(payments.publicId, ev.resourceId)))
      .limit(1);
    if (!p?.customerId || p.status !== "succeeded") return;
    try {
      // A savepoint: a tier failure must never undo the payment it rides on.
      await tx.transaction((sp) =>
        evaluateTiers(sp, {
          organizationId: ev.organizationId,
          businessId: ev.businessId!,
          customerId: p.customerId!,
          currency: p.currency,
        }),
      );
    } catch (e) {
      log.error(e, { event: "usage_tier_evaluate_failed", payment: ev.resourceId });
    }
    return;
  }
  const [g] = await tx
    .select({ customerId: creditGrants.customerId })
    .from(creditGrants)
    .where(
      and(eq(creditGrants.businessId, ev.businessId), eq(creditGrants.publicId, ev.resourceId)),
    )
    .limit(1);
  if (g) await markDirty(tx, { businessId: ev.businessId, customerIds: [g.customerId] });
}

registerEventSink(usageControlsSink);
