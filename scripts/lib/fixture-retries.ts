import { and, eq, isNotNull } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { invoices } from "@db/schema";
import { voidInvoice } from "@/modules/invoicing/ops";
import { refreshDueWork } from "@/modules/ops/due-work";

/**
 * Retire the retry-state invoices a suite leaves behind.
 *
 * A fixture invoice that is `payment_due` with a `next_attempt_at` is REAL work by every
 * definition the system has: `due_work`'s `dunning_retry` source claims it, so it lands on
 * /ops/due-work and stays there — the diary retracts a row only when the source stops
 * claiming it, and a fixture nobody collects is payment_due forever. One suite run leaves
 * one permanently-overdue page entry; thirty runs leave thirty, and the screen that is
 * supposed to show a stalled clock shows test debris instead.
 *
 * Deleting the fixture org is not the fix available here: `ledger_entries` holds the only
 * RESTRICT reference to `organizations`, and clearing it would mean deleting ledger rows.
 * Voiding is the honest retirement anyway — it is what an operator does to an invoice that
 * will never be collected, it clears `next_attempt_at` and ends the chase through the real
 * path, and it posts its own compensating entry.
 *
 * Call it after the assertions, before `closeDb()`.
 */
export async function retireFixtureRetries(orgIds: string[]): Promise<number> {
  let voided = 0;
  for (const orgId of orgIds) {
    const open = await withTenant(orgId, (tx) =>
      tx
        .select({
          publicId: invoices.publicId,
          businessId: invoices.businessId,
        })
        .from(invoices)
        .where(and(eq(invoices.status, "payment_due"), isNotNull(invoices.nextAttemptAt))),
    );
    for (const inv of open) {
      await voidInvoice(orgId, inv.businessId, inv.publicId);
      voided++;
    }
  }
  // The diary is a projection, so the void alone does not retract the row — the next
  // refresh does, and a suite that cleans up only on the scheduler's timetable has not
  // cleaned up.
  if (voided > 0) await refreshDueWork();
  return voided;
}
