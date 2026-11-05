import { eq } from "drizzle-orm";
import { type Tx } from "@/platform/db";
import { publicMetadata } from "@/platform/public-metadata";
import { creditNotes, creditNoteItems, invoices, businesses } from "@db/schema";
import { inclusivePeriodEnd, type PeriodConvention } from "@/modules/invoicing/serialize";

type CreditNote = typeof creditNotes.$inferSelect;

// `creditNoteAvailable`/`CreditNoteView` moved HERE (from `./service`) so
// `events/content.ts` can build a full credit-note snapshot without importing
// `credit-notes/service.ts` — that file imports `emitEvent`, which would close
// the serialize → service → events/emit → events/content → serialize cycle.
// `./service` re-exports both for back-compat.

/** available = total − allocated − refunded (never negative under correct ops). */
export function creditNoteAvailable(
  cn: Pick<CreditNote, "totalMinor" | "allocatedMinor" | "refundedMinor">,
): bigint {
  return cn.totalMinor - cn.allocatedMinor - cn.refundedMinor;
}

/**
 * What a note can still refund or fund. A `refunded` note has nothing left whatever its
 * amounts say: the engine sets `refunded` only once a note is fully consumed, but notes
 * imported already settled can arrive `refunded` with allocated + refunded short of the
 * total. `creditNoteAvailable` stays the raw invariant term.
 */
export function creditNoteSpendable(
  cn: Pick<CreditNote, "status" | "totalMinor" | "allocatedMinor" | "refundedMinor">,
): bigint {
  if (cn.status === "refunded") return 0n;
  const left = creditNoteAvailable(cn);
  return left > 0n ? left : 0n;
}

/**
 * What settled a `refunded` note. The status means "nothing left", and a note fully
 * applied to invoices gets it with `refunded_minor` 0. Null on any other status, and on
 * an imported note that arrived settled with neither amount.
 */
export function creditNoteSettledBy(
  cn: Pick<CreditNote, "status" | "allocatedMinor" | "refundedMinor">,
): "refund" | "allocation" | "mixed" | null {
  if (cn.status !== "refunded") return null;
  const allocated = cn.allocatedMinor > 0n;
  const refunded = cn.refundedMinor > 0n;
  return allocated && refunded ? "mixed" : refunded ? "refund" : allocated ? "allocation" : null;
}

export interface CreditNoteView {
  note: CreditNote;
  invoicePublicId: string;
  /** The invoice's human-readable number ("INV-42"); null on rows that never got one. */
  invoiceNumber: string | null;
  items: Array<typeof creditNoteItems.$inferSelect>;
  /**
   * The payer. `credit_notes.customer_id` has always existed but was never
   * serialized, so neither the detail header nor the list could show who the
   * credit belongs to. Optional so the list path (which does not join
   * customers) stays assignable.
   *
   * ⚠️ `customerName` is the RESOLVED account-holder name (`customers/names.ts`),
   * never a bare `customers.name`. Undefined still means "not loaded" and null means
   * "loaded, no name at all" — the spread below keeps those distinct, and callers
   * read them differently.
   */
  customerPublicId?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  /**
   * Decides the item period-end convention. An item credits a slice of the same term the
   * invoice billed, so the two must print the same period — see `periodEnd` in
   * `invoicing/serialize.ts`. Omit only where no business row is at hand; the raw
   * exclusive instant is then reported, which is the pre-existing behaviour.
   */
  biz?: PeriodConvention | null;
}

export function serializeCreditNote(v: CreditNoteView) {
  return {
    object: "credit_note",
    id: v.note.publicId,
    number: v.note.number ?? null, // Post-H (#12): human-readable sequential number
    invoice: v.invoicePublicId,
    invoice_number: v.invoiceNumber,
    kind: v.note.kind,
    status: v.note.status,
    settled_by: creditNoteSettledBy(v.note),
    reason_code: v.note.reasonCode,
    /**
     * `sub_total` (0186): the GROSS reversal this note documents, PRE-TAX and
     * before any slice was routed back to a credit bucket — so `total_minor =
     * subtotal_minor − Σ discounts[].amount_minor + tax`.
     *
     * Reported on the LIST as well as the detail: it is a column on the row the list
     * already selects, it costs nothing, and a list row that shows only `total_minor`
     * is exactly the misstatement 0186 exists to end (a wholly bucket-funded note
     * reads as a credit note for zero). `discounts[]` is detail-only — it needs its
     * own table read, and the invoice does the same with `discounts` (openapi.ts:
     * "Present on the single-invoice read only").
     *
     * A NULL column means "gross not recorded; it equals total_minor" (the pre-0186
     * convention, and every backfilled historical row), so the resolved integer is
     * reported rather than a null: the identity above then holds for EVERY row a
     * consumer sees, with no discounts and no tax, instead of handing them a money
     * field that is sometimes absent.
     */
    subtotal_minor: Number(v.note.subtotalMinor ?? v.note.totalMinor),
    total_minor: Number(v.note.totalMinor),
    allocated_minor: Number(v.note.allocatedMinor),
    refunded_minor: Number(v.note.refundedMinor),
    available_minor: Number(creditNoteSpendable(v.note)),
    /** A payout refund the gateway could not confirm; resolve it with `…/resolve_payout`. */
    payout_unconfirmed_minor: Number(v.note.payoutUnconfirmedMinor ?? 0n),
    /** Returned as credit, then confirmed paid out by the gateway: the customer has it twice. */
    payout_duplicated_minor: Number(v.note.payoutDuplicatedMinor ?? 0n),
    /** The gateway reported a refund failed (credit returned) and then paid it. */
    payout_out_of_order_minor: Number(v.note.payoutOutOfOrderMinor ?? 0n),
    currency: v.note.currency,
    /**
     * FX SNAPSHOT (0228), INHERITED from the invoice this note credits — so the note
     * and its invoice convert at the same rate and net to zero in a converted book.
     * String, not a number, for the same exactness reason as the invoice's; null when
     * the credited invoice carried no rate.
     */
    exchange_rate: v.note.exchangeRate ?? null,
    exchange_rate_base: v.note.exchangeRateBase ?? null,
    reason: v.note.reason,
    customer_notes: v.note.customerNotes ?? null,
    voided_at: v.note.voidedAt,
    channel: v.note.channel,
    imported: v.note.imported,
    metadata: publicMetadata(v.note.metadata),
    created_at: v.note.createdAt,
    ...(v.customerPublicId !== undefined ? { customer: v.customerPublicId } : {}),
    ...(v.customerName !== undefined ? { customer_name: v.customerName } : {}),
    ...(v.customerEmail !== undefined ? { customer_email: v.customerEmail } : {}),
    items: v.items.map((it) => ({
      id: it.publicId,
      description: it.description,
      amount_minor: Number(it.amountMinor),
      // The credited service period prints under each item; without it a
      // prorated credit gave no clue which period it reversed.
      period_start: it.periodStart,
      period_end: inclusivePeriodEnd(it.periodEnd, v.biz),
    })),
  };
}

/**
 * Full-snapshot loader for event content (BLUEPRINT §11 Part B). Loads a
 * credit note + its items + its invoice's public id, returning the serialized
 * object, or null if not found. `tx` must be the caller's RLS-scoped
 * transaction.
 */
export async function loadCreditNoteSnapshot(
  tx: Tx,
  cnPublicId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await tx
    .select({ cn: creditNotes, invPid: invoices.publicId, invNumber: invoices.number })
    .from(creditNotes)
    .innerJoin(invoices, eq(creditNotes.invoiceId, invoices.id))
    .where(eq(creditNotes.publicId, cnPublicId))
    .limit(1);
  if (!row) return null;
  const items = await tx
    .select()
    .from(creditNoteItems)
    .where(eq(creditNoteItems.creditNoteId, row.cn.id));
  // Same reason the invoice snapshot loads it: the webhook payload must state the period
  // exactly as the REST read does.
  const [biz] = await tx
    .select({ anchorGranularity: businesses.anchorGranularity, timezone: businesses.timezone })
    .from(businesses)
    .where(eq(businesses.id, row.cn.businessId))
    .limit(1);
  return serializeCreditNote({
    note: row.cn,
    invoicePublicId: row.invPid,
    invoiceNumber: row.invNumber,
    items,
    biz: biz ?? null,
  });
}
