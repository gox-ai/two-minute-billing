import { eq } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { customers, invoices, subscriptions } from "@db/schema";

/**
 * An auto-collect-OFF invoice that is still open with money due: nothing will charge it,
 * so the mail carrying it is the customer's prompt to pay. Read at send time, so an
 * invoice settled before the mail went out gets no button.
 */
export async function isPayableOfflineInvoice(
  tx: Tx,
  inv: typeof invoices.$inferSelect,
): Promise<boolean> {
  if (!["posted", "payment_due", "not_paid"].includes(inv.status)) return false;
  if ((inv.amountDueMinor ?? inv.totalMinor) <= 0n) return false;
  const [cust] = await tx
    .select({ ac: customers.autoCollection })
    .from(customers)
    .where(eq(customers.id, inv.customerId))
    .limit(1);
  const [sub] = inv.subscriptionId
    ? await tx
        .select({ ac: subscriptions.autoCollection })
        .from(subscriptions)
        .where(eq(subscriptions.id, inv.subscriptionId))
        .limit(1)
    : [];
  // Same override order as `isAutoCollectOn` (invoicing/service), inlined: that module
  // reaches the emails outbox through invoicing/collection.
  return (sub?.ac ?? cust?.ac ?? "on") === "off";
}
