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
  payments,
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
  /** Credit pack lines only: what a note can credit with `pack_refund: full`. */
  lineFullCreditable: Map<string, bigint>;
  creditNotes: Array<typeof creditNotes.$inferSelect>;
  /** Refundable credit drawn from OTHER notes onto this invoice. */
  appliedCredits: Array<{
    creditNote: typeof creditNotes.$inferSelect;
    amountMinor: bigint;
    appliedAt: Date;
  }>;
  /**
   * Every attempt, success, failure and refund — the full money log, oldest first.
   * `paymentPublicId` is the `pay_…` a refund call takes (for a refund, the one it reverses).
   */
  transactions: Array<typeof transactions.$inferSelect & { paymentPublicId: string | null }>;
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
    .select({ txn: transactions, paymentPublicId: payments.publicId })
    .from(transactions)
    .leftJoin(payments, eq(payments.id, transactions.paymentId))
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
    ...(await creditableMaps(tx, inv)),
    creditNotes: notes,
    appliedCredits: applied,
    transactions: txns.map((r) => ({ ...r.txn, paymentPublicId: r.paymentPublicId })),
    firstInvoice: !earlier && inv.status !== "voided" && inv.status !== "pending",
  };
}

/** What each line can still take; for a credit pack line also the full-refund maximum. */
async function creditableMaps(
  tx: Parameters<typeof lineCreditableAmounts>[0],
  inv: Parameters<typeof lineCreditableAmounts>[1],
) {
  const caps = [...(await lineCreditableAmounts(tx, inv)).values()];
  const packs = caps.filter((l) => l.pack);
  const full = packs.length
    ? await lineCreditableAmounts(
        tx,
        inv,
        packs.map((l) => l.publicId),
        undefined,
        { packRefund: "full" },
      )
    : new Map();
  return {
    lineCreditable: new Map(caps.map((l) => [l.publicId, l.remainingMinor])),
    lineFullCreditable: new Map(
      [...full.values()].map((l) => [l.publicId, l.remainingMinor] as [string, bigint]),
    ),
  };
}
