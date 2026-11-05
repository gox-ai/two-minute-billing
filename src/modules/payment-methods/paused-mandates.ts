/**
 * Re-ask the gateway about mandates we marked dead by PAUSE.
 *
 * ── Why a poll, and only for this one case ───────────────────────────────────────
 * RazorPay delivers `token.paused`, which lands in `DEAD_MANDATE_STATUSES` and makes the
 * instrument `invalid` — correct, and what moves collection to the backup card. It will not
 * deliver `token.resumed`: the API answers **400 "Invalid event name/names"** for that name,
 * measured and recorded in `scripts/probe-razorpay-event-names.ts`. The handler for it
 * exists and is mapped; the event simply never arrives.
 *
 * So a mandate that pauses and later resumes is dead in our books FOREVER. The customer can
 * pay and we have stopped asking. Nothing else re-reads a dead mandate, and a webhook the
 * gateway refuses to send cannot be waited for — the general form of the rule that a
 * time-critical fact is polled, never awaited.
 *
 * ── Scope, deliberately narrow ──────────────────────────────────────────────────
 * ONLY `paused`. `cancelled` and `rejected` are also dead, and neither comes back: a
 * cancelled mandate is gone at the rail and a rejected one never existed. Polling them would
 * burn gateway calls on states that cannot change, so the sweep asks about the one dead
 * status that is reversible.
 *
 * It applies the SAME policy the webhook does (`applyMandateStatus`), rather than writing a
 * second one. `reconcileAbandonedCapture` says why: "a sweep constructing a fake event to
 * satisfy a signature is how the second implementation starts."
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { scanBusinessFilter } from "@/platform/clock";
import { paymentMethods, gatewayAccounts } from "@db/schema";
import { resolveAdapter } from "@/providers/registry";
import { createLogger } from "@/platform/logger";
import { applyMandateStatus } from "@/modules/webhooks/inbound";

const log = createLogger("payment-methods.paused-mandates");

/** The one dead status a gateway can take back. See the module docblock. */
export const REVIVABLE_MANDATE_STATUS = "paused";

export interface PausedMandateSweepResult {
  /** Rows we asked the gateway about. */
  rechecked: number;
  /** Rows whose mandate the gateway now reports as something other than paused. */
  changed: number;
  /** Rows we could not ask about — no gateway account, or the adapter cannot poll. */
  skipped: number;
}

export async function recheckPausedMandates(limit = 200): Promise<PausedMandateSweepResult> {
  const rows = await systemDb
    .select({
      pm: paymentMethods,
      account: gatewayAccounts,
    })
    .from(paymentMethods)
    .leftJoin(gatewayAccounts, eq(gatewayAccounts.id, paymentMethods.gatewayAccountId))
    .where(
      and(
        eq(paymentMethods.mandateStatus, REVIVABLE_MANDATE_STATUS),
        isNotNull(paymentMethods.gatewayAccountId),
        // A travel step asks only about its own business; a real tick skips travelled ones.
        // Unscoped, every travel step re-polled every paused mandate in the database.
        scanBusinessFilter(paymentMethods.businessId),
      ),
    )
    .limit(limit);

  const out: PausedMandateSweepResult = { rechecked: 0, changed: 0, skipped: 0 };

  for (const { pm, account } of rows) {
    if (!account) {
      out.skipped++;
      continue;
    }
    let adapter;
    try {
      adapter = resolveAdapter(account);
    } catch (e) {
      // Undecryptable credentials must not stop the sweep reaching the next row — the
      // same reasoning `serializeGatewayAccount` uses when it defaults to `false`.
      log.error(e, { event: "paused_mandate_adapter_unresolved", paymentMethod: pm.publicId });
      out.skipped++;
      continue;
    }
    if (!adapter.fetchMandate) {
      out.skipped++;
      continue;
    }

    try {
      out.rechecked++;
      const mandate = await adapter.fetchMandate({
        providerCustomerId: pm.providerCustomerId,
        token: pm.providerPaymentMethodId,
      });
      // Null is "the gateway has no mandate for this token" — NOT a status change, and
      // reading it as one would invent a transition the gateway never reported.
      if (!mandate?.status) continue;
      if (mandate.status.toLowerCase() === REVIVABLE_MANDATE_STATUS) continue;

      const result = await applyMandateStatus(pm, { ...mandate, status: mandate.status });
      out.changed++;
      log.warn("a paused mandate changed state at the gateway — no webhook could tell us", {
        event: "paused_mandate_repolled",
        paymentMethod: pm.publicId,
        status: mandate.status,
        outcome: result,
      });
    } catch (e) {
      // One unreachable gateway must not strand every other paused mandate.
      log.error(e, { event: "paused_mandate_recheck_failed", paymentMethod: pm.publicId });
    }
  }
  return out;
}
