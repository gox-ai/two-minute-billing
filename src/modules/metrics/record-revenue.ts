import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { creditNotes, invoices } from "@db/schema";
import { creditNoteRevenueFor } from "@/modules/metrics/daily/credit-note-revenue";
import { revenueTotalsByInvoice } from "@/modules/metrics/daily/revenue-totals";

const BILLED_STATUSES = ["posted", "payment_due", "not_paid", "paid"];

export type RecordRevenueScope = { customerId: string } | { subscriptionId: string };
export interface RecordRevenue {
  currency: string;
  amount_minor: number;
}

/**
 * Lifetime `revenue_billed` for one customer or subscription: net, before tax, with credit notes
 * deducted. Unlike the daily measures, a record page includes a customer excluded from reporting.
 */
export async function billedRevenueForRecord(
  organizationId: string,
  businessId: string,
  scope: RecordRevenueScope,
): Promise<RecordRevenue[]> {
  return withTenant(organizationId, async (tx) => {
    const invoiceScope =
      "customerId" in scope
        ? eq(invoices.customerId, scope.customerId)
        : eq(invoices.subscriptionId, scope.subscriptionId);
    const docs = await tx
      .select({ id: invoices.id, currency: invoices.currency })
      .from(invoices)
      .where(
        and(
          eq(invoices.businessId, businessId),
          invoiceScope,
          inArray(invoices.status, BILLED_STATUSES),
        ),
      );
    const totals = await revenueTotalsByInvoice(
      tx,
      docs.map((d) => d.id),
    );
    const byCurrency = new Map<string, bigint>();
    for (const doc of docs) {
      const currency = doc.currency.toUpperCase();
      byCurrency.set(currency, (byCurrency.get(currency) ?? 0n) + (totals.get(doc.id) ?? 0n));
    }

    const noteScope =
      "customerId" in scope
        ? eq(creditNotes.customerId, scope.customerId)
        : sql`exists (
            select 1 from invoices i
            where i.id = ${creditNotes.invoiceId}
              and i.business_id = ${businessId}
              and i.subscription_id = ${scope.subscriptionId}
          )`;
    const notes = await tx
      .select({
        id: creditNotes.id,
        currency: creditNotes.currency,
        invoiceId: creditNotes.invoiceId,
        subtotalMinor: creditNotes.subtotalMinor,
        totalMinor: creditNotes.totalMinor,
      })
      .from(creditNotes)
      .where(
        and(
          eq(creditNotes.businessId, businessId),
          noteScope,
          ne(creditNotes.status, "voided"),
          or(isNull(creditNotes.reasonCode), ne(creditNotes.reasonCode, "write_off")),
        ),
      );
    for (const note of await creditNoteRevenueFor(tx, notes)) {
      byCurrency.set(note.currency, (byCurrency.get(note.currency) ?? 0n) - note.amountMinor);
    }

    return [...byCurrency]
      .map(([currency, amount]) => ({ currency, amount_minor: Number(amount) }))
      .sort((a, b) => b.amount_minor - a.amount_minor || a.currency.localeCompare(b.currency));
  });
}
