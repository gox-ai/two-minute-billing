/**
 * The collection rules a renewal applies (0486): write off a small amount due, or leave a
 * net-terms invoice for the due-date pass (invoicing/due.ts) instead of charging it now.
 * Unset, the renewal never calls this.
 */
import { eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import {
  businesses,
  customers,
  type invoices,
  type payments,
  type subscriptions,
} from "@db/schema";
import { createLogger } from "@/platform/logger";
import { collectPeriodInvoice, isAutoCollectOn } from "@/modules/invoicing/service";
import { writeOffInvoice } from "@/modules/invoicing/ops";
import {
  collectionDecision,
  resolveInvoiceRulesConfig,
  type InvoiceRulesConfig,
} from "@/modules/invoicing/invoice-rules-config";

const log = createLogger("subscriptions.renewal-collection");

type Invoice = typeof invoices.$inferSelect;
type Payment = typeof payments.$inferSelect;
type Sub = typeof subscriptions.$inferSelect;

/** The business rules, and whether auto-collection is on for this subscription. */
export async function loadRenewalCollectionRules(
  organizationId: string,
  sub: Pick<Sub, "customerId" | "autoCollection">,
): Promise<{ cfg: InvoiceRulesConfig; autoCollect: boolean }> {
  const [row] = await withTenant(organizationId, (tx) =>
    tx
      .select({
        invoiceRulesConfig: businesses.invoiceRulesConfig,
        autoCollection: customers.autoCollection,
      })
      .from(customers)
      .innerJoin(businesses, eq(customers.businessId, businesses.id))
      .where(eq(customers.id, sub.customerId))
      .limit(1),
  );
  return {
    cfg: resolveInvoiceRulesConfig(row),
    autoCollect: isAutoCollectOn(sub.autoCollection, row?.autoCollection),
  };
}

/** Collect a renewal invoice committed with `collect: false`, under the collection rules. */
export async function settleCollection(input: {
  organizationId: string;
  businessId: string;
  subscription: Sub;
  invoice: Invoice;
  cfg: InvoiceRulesConfig;
  now: Date;
}): Promise<{ invoice: Invoice; payment: Payment | null }> {
  const { organizationId, businessId, subscription, invoice } = input;
  const decision = collectionDecision(input.cfg, invoice, input.now);
  if (decision === "wait_for_due_date") return { invoice, payment: null };
  if (decision === "write_off") {
    const written = await writeOffInvoice(organizationId, businessId, invoice.publicId);
    log.info("small invoice written off", {
      event: "small_invoice_written_off",
      invoice: invoice.publicId,
      amountMinor: String(invoice.amountDueMinor),
      currency: invoice.currency,
    });
    return { invoice: written, payment: null };
  }
  return collectPeriodInvoice({ organizationId, businessId, subscription, invoice });
}
