/**
 * What an invoice's detail read carries beyond its own row: the tax breakdown, the credit
 * notes raised against it, credit applied to it from elsewhere, and every money movement
 * on it. Detail only — each is a query, and a list page would pay them per row.
 */
import { and, asc, eq, lt, ne, notInArray, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import {
  appliedTaxes,
  creditNoteAllocations,
  creditNotes,
  invoices,
  transactions,
} from "@db/schema";
import { lineCreditableAmounts } from "@/modules/credit-notes/line-cap";

export interface InvoiceRelations {
  /** One row per tax component (CGST, SGST, IGST, VAT…) and rate. */
  taxes: Array<{ name: string; rateBps: number; amountMinor: bigint }>;
  /** Per line: tax charged on it, and why it was not taxed when it was not. */
  lineTaxes: Map<string, { amountMinor: bigint; reasons: string[] }>;
  /** Per line public id: what a credit note may still credit against it. */
  lineCreditable: Map<string, bigint>;
  creditNotes: Array<typeof creditNotes.$inferSelect>;
  /** Refundable credit drawn from OTHER notes onto this invoice. */
  appliedCredits: Array<{
    creditNote: typeof creditNotes.$inferSelect;
    amountMinor: bigint;
    appliedAt: Date;
  }>;
  /** Every attempt, success, failure and refund — the full money log, oldest first. */
  transactions: Array<typeof transactions.$inferSelect>;
  /** First non-voided invoice of its subscription, or of its customer when not recurring. */
  firstInvoice: boolean;
}

export async function loadInvoiceRelations(
  tx: Tx,
  inv: typeof invoices.$inferSelect,
): Promise<InvoiceRelations> {
  const taxRows = await tx
    .select({
      name: appliedTaxes.name,
      rateBps: appliedTaxes.rateBps,
      amountMinor: sql<string>`sum(${appliedTaxes.amountMinor})`,
    })
    .from(appliedTaxes)
    .where(eq(appliedTaxes.invoiceId, inv.id))
    .groupBy(appliedTaxes.name, appliedTaxes.rateBps)
    .orderBy(appliedTaxes.name);
  const lineRows = await tx
    .select({
      lineId: appliedTaxes.invoiceLineItemId,
      amountMinor: sql<string>`sum(${appliedTaxes.amountMinor})`,
      reasons: sql<string[]>`array_agg(distinct ${appliedTaxes.taxabilityReason})`,
    })
    .from(appliedTaxes)
    .where(eq(appliedTaxes.invoiceId, inv.id))
    .groupBy(appliedTaxes.invoiceLineItemId);
  const notes = await tx
    .select()
    .from(creditNotes)
    .where(eq(creditNotes.invoiceId, inv.id))
    .orderBy(asc(creditNotes.createdAt));
  const applied = await tx
    .select({
      creditNote: creditNotes,
      amountMinor: creditNoteAllocations.amountMinor,
      appliedAt: creditNoteAllocations.createdAt,
    })
    .from(creditNoteAllocations)
    .innerJoin(creditNotes, eq(creditNotes.id, creditNoteAllocations.creditNoteId))
    .where(and(eq(creditNoteAllocations.invoiceId, inv.id), ne(creditNotes.invoiceId, inv.id)))
    .orderBy(asc(creditNoteAllocations.createdAt));
  const txns = await tx
    .select()
    .from(transactions)
    .where(eq(transactions.invoiceId, inv.id))
    .orderBy(asc(transactions.createdAt));
  const [earlier] = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        inv.subscriptionId
          ? eq(invoices.subscriptionId, inv.subscriptionId)
          : and(eq(invoices.customerId, inv.customerId), sql`${invoices.subscriptionId} is null`),
        notInArray(invoices.status, ["voided", "pending"]),
        lt(invoices.createdAt, inv.createdAt),
      ),
    )
    .limit(1);
  return {
    taxes: taxRows.map((t) => ({
      name: t.name,
      rateBps: t.rateBps,
      amountMinor: BigInt(t.amountMinor),
    })),
    lineTaxes: new Map(
      lineRows
        .filter((r) => r.lineId != null)
        .map((r) => [
          r.lineId!,
          { amountMinor: BigInt(r.amountMinor), reasons: r.reasons.filter(Boolean) },
        ]),
    ),
    lineCreditable: new Map(
      [...(await lineCreditableAmounts(tx, inv)).values()].map((l) => [
        l.publicId,
        l.remainingMinor,
      ]),
    ),
    creditNotes: notes,
    appliedCredits: applied,
    transactions: txns,
    firstInvoice: !earlier && inv.status !== "voided" && inv.status !== "pending",
  };
}
