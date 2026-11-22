import { and, eq, gte, inArray, lt, ne, or, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { creditNoteDiscounts, creditNoteItems, creditNotes } from "@db/schema";
import {
  allocateProRata,
  billedRevenueByInvoice,
  revenueLineInfo,
  type RevenueType,
} from "@/modules/payments/attribution";
import { TAX_REVERSAL_DESCRIPTION } from "@/modules/credit-notes/tax-items";
import { reportableCustomer } from "../reportable";

/** Discounts on a note that went back to a FREE balance: never revenue, so not reversed. */
const FREE_RETURNS = ["promotional_credits", "credit_grants"];

export interface CreditNoteSlice {
  type: RevenueType;
  productId: string | null;
  meterId: string | null;
  amountMinor: bigint;
}

export interface CreditNoteRevenue {
  currency: string;
  /** The revenue the note reverses: pre-tax, net of what it returned to free balances. */
  amountMinor: bigint;
  /** By the credited lines' type and product. Σ = `amountMinor`. */
  slices: CreditNoteSlice[];
}

export interface CreditNoteRevenueInput {
  id: string;
  currency: string;
  invoiceId: string | null;
  subtotalMinor: bigint | null;
  totalMinor: bigint;
}

/** The reporting-window read. The note rule itself is shared with customer/subscription totals. */
export async function creditNoteRevenue(
  tx: Tx,
  businessId: string,
  from: Date,
  toExclusive: Date,
): Promise<CreditNoteRevenue[]> {
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
        reportableCustomer(creditNotes.customerId),
        gte(creditNotes.createdAt, from),
        lt(creditNotes.createdAt, toExclusive),
        ne(creditNotes.status, "voided"),
        or(isNull(creditNotes.reasonCode), ne(creditNotes.reasonCode, "write_off")),
      ),
    );
  return creditNoteRevenueFor(tx, notes);
}

/**
 * The `credit_note` revenue deduction. The caller chooses the notes; its own issue date decides
 * the reporting period. The amount is the note's pre-tax reversal less what it returned to
 * promotional credit or to grants, so a full note on a promo-funded invoice reverses exactly the
 * invoice's net (1000 − 300 = 700, not 1000). It is split over the credited lines by the items'
 * amounts; a note whose items name no revenue line is split like its invoice's net revenue, and a
 * note with neither is one-time.
 */
export async function creditNoteRevenueFor(
  tx: Tx,
  notes: readonly CreditNoteRevenueInput[],
): Promise<CreditNoteRevenue[]> {
  if (notes.length === 0) return [];
  const ids = notes.map((n) => n.id);

  const items = await tx
    .select({
      noteId: creditNoteItems.creditNoteId,
      kind: creditNoteItems.kind,
      description: creditNoteItems.description,
      amountMinor: creditNoteItems.amountMinor,
      lineId: creditNoteItems.invoiceLineItemId,
    })
    .from(creditNoteItems)
    .where(inArray(creditNoteItems.creditNoteId, ids));
  const freeRows = await tx
    .select({
      noteId: creditNoteDiscounts.creditNoteId,
      amount: sql<string>`sum(${creditNoteDiscounts.amountMinor})`,
    })
    .from(creditNoteDiscounts)
    .where(
      and(
        inArray(creditNoteDiscounts.creditNoteId, ids),
        inArray(creditNoteDiscounts.type, FREE_RETURNS),
      ),
    )
    .groupBy(creditNoteDiscounts.creditNoteId);
  const freeOf = new Map(freeRows.map((r) => [r.noteId, BigInt(r.amount ?? 0)]));

  const isTax = (it: (typeof items)[number]) =>
    it.kind === "tax" ||
    (it.kind === null && it.lineId === null && it.description === TAX_REVERSAL_DESCRIPTION);
  const itemsOf = new Map<string, typeof items>();
  for (const it of items) itemsOf.set(it.noteId, [...(itemsOf.get(it.noteId) ?? []), it]);

  const info = await revenueLineInfo(
    tx,
    items.filter((it) => it.lineId && !isTax(it)).map((it) => it.lineId!),
  );
  const invoiceIds = [...new Set(notes.map((n) => n.invoiceId).filter((v): v is string => !!v))];
  const invoiceRevenue = await billedRevenueByInvoice(tx, invoiceIds);

  const out: CreditNoteRevenue[] = [];
  for (const n of notes) {
    const mine = itemsOf.get(n.id) ?? [];
    const preTax =
      n.subtotalMinor ??
      n.totalMinor - mine.filter(isTax).reduce((s, it) => s + it.amountMinor, 0n);
    const amount = preTax - (n.subtotalMinor === null ? 0n : (freeOf.get(n.id) ?? 0n));

    let parts: Array<Omit<CreditNoteSlice, "amountMinor"> & { w: bigint }> = mine
      .filter((it) => it.lineId && !isTax(it) && info.has(it.lineId))
      .map((it) => ({ ...info.get(it.lineId!)!, w: it.amountMinor }));
    if (parts.length === 0 || parts.every((p) => p.w === 0n)) {
      parts = (n.invoiceId ? (invoiceRevenue.get(n.invoiceId)?.lines ?? []) : []).map((l) => ({
        type: l.type,
        productId: l.productId,
        meterId: l.meterId,
        w: l.amountMinor,
      }));
    }
    const total = parts.reduce((s, p) => s + p.w, 0n);
    const slices: CreditNoteSlice[] =
      parts.length === 0 || total === 0n
        ? [{ type: "one_time", productId: null, meterId: null, amountMinor: amount }]
        : allocateProRata(
            amount,
            parts.map((p) => p.w),
          ).map((v, i) => ({
            type: parts[i]!.type,
            productId: parts[i]!.productId,
            meterId: parts[i]!.meterId,
            amountMinor: v,
          }));
    out.push({ currency: n.currency.toUpperCase(), amountMinor: amount, slices });
  }
  return out;
}
