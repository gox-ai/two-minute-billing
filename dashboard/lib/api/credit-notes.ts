// Typed data-access for the Credit Notes surface. Uses the generic apiGet /
// apiWrite from '@/lib/api'; never imports a provider SDK or touches lib/api.ts.
//
// Backend shape (see src/api/credit-note-routes.ts::serializeCreditNote):
//   GET  /v1/businesses/:biz/credit_notes          (list; ?invoice= only)
//   GET  /v1/businesses/:biz/credit_notes/:cn      (detail + refunds/allocations timeline)
//   POST /v1/businesses/:biz/credit_notes          (create)
//   POST /v1/businesses/:biz/credit_notes/:cn/refund
//   POST /v1/businesses/:biz/credit_notes/:cn/record_refund   (offline: cash/check/bank)
//   POST /v1/businesses/:biz/credit_notes/:cn/void

import { apiGet, apiWrite, listQuery, type ListParams, type PagedList } from "@/lib/api";

export type CreditNoteKind = "adjustment" | "refundable";
export type CreditNoteStatus = "adjusted" | "refund_due" | "refunded" | "voided" | string;
export type CreditNoteReasonCode =
  | "write_off"
  | "subscription_change"
  | "subscription_cancellation"
  | "chargeback"
  | "other";

export interface CreditNoteItem {
  id: string;
  description: string;
  amount_minor: number;
  /** Service period credited, inherited from the invoice line; printed on the note. */
  period_start: string | null;
  period_end: string | null;
}

/** Full serializer shape returned by the list endpoint. */
export interface CreditNote {
  object: "credit_note";
  id: string;
  number: string | null;
  invoice: string;
  invoice_number: string | null;
  kind: CreditNoteKind;
  status: CreditNoteStatus;
  /** On a `refunded` note: what used it up. `allocation` = applied to invoices, no cash back. */
  settled_by?: "refund" | "allocation" | "mixed" | null;
  reason_code: CreditNoteReasonCode | null;
  /**
   * The GROSS reversal this note documents, PRE-TAX and before any slice was routed
   * back to a credit bucket: `total_minor = subtotal_minor − Σ discounts[].amount_minor
   * + tax` (src/modules/credit-notes/serialize.ts).
   *
   * **Never null.** The column is nullable — NULL means "gross not recorded; it equals
   * total_minor", the pre-0186 convention and the state of every backfilled historical
   * row — but the serializer resolves it to `total_minor`, so a consumer always gets an
   * integer. Which is why `subtotal_minor === total_minor` with no discounts is the
   * COMMON case, not a curiosity: it means the note records no gross of its own, and a
   * "Sub Total" line identical to "Total" would be noise on it.
   */
  subtotal_minor: number;
  total_minor: number;
  allocated_minor: number;
  refunded_minor: number;
  available_minor: number;
  /** A payout refund the gateway could not confirm; an operator resolves it. */
  payout_unconfirmed_minor?: number;
  /** Returned as credit, then confirmed paid out: the customer has it twice. */
  payout_duplicated_minor?: number;
  /** The gateway reported a refund failed, then paid: out-of-order answers. */
  payout_out_of_order_minor?: number;
  currency: string;
  reason: string | null;
  imported: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
  /** When it was voided — the "Voided On" column. */
  voided_at: string | null;
  /** Provenance at creation: api | dashboard | system | import. */
  channel: string | null;
  /** The payer. Present on the detail read (the list does not join customers). */
  customer?: string | null;
  customer_name?: string | null;
  customer_email?: string | null;
  items: CreditNoteItem[];
}

export type OfflineRefundMethod = "cash" | "check" | "bank_transfer" | "other";

export interface CreditNoteAllocation {
  object: "credit_note_allocation";
  invoice: string;
  amount_minor: number;
  allocated_at: string;
}

/** One refund transaction on the CN timeline — gateway payout or offline record. */
export interface CreditNoteRefund {
  object: "credit_note_refund";
  transaction: string;
  status: string;
  amount_minor: number;
  currency: string;
  offline: boolean;
  method: OfflineRefundMethod | null;
  gateway_key: string | null;
  reference: string | null;
  id_at_gateway: string | null;
  /** Gateway failure reason (failed payout attempts only). */
  error_text: string | null;
  occurred_at: string;
}

/**
 * One slice of `subtotal_minor` that went back to a CREDIT BUCKET instead of to the
 * customer — `credit_note.discounts[]`. `amount_minor` is always POSITIVE (the
 * amount taken off the gross); the renderers negate it for display, as the PDF does.
 */
export interface CreditNoteDiscount {
  object: "credit_note_discount";
  /** promotional_credits | excess_payments | item_level_coupon | document_level_coupon | prorated_credits */
  type: string;
  amount_minor: number;
  /** e.g. "Promotional Credits Returned". Null on an imported row that carried none. */
  description: string | null;
}

/**
 * One NAMED tax row on the note's ladder — e.g. `IGST @ 18%`.
 *
 * A credit note stores neither the tax nor the component names. The engine derives the
 * amount from `total_minor − subtotal_minor + Σ discounts[]` and takes the names from the
 * CREDITED INVOICE's tax snapshot, splitting the derived total in the proportion that
 * invoice booked them (src/modules/credit-notes/document.ts). Σ `amount_minor` is exactly
 * that derived total, so the ladder still adds up.
 *
 * `description` is a single unnamed "Tax" when the credited invoice recorded no per-line
 * tax — a row predating it, or an untaxed business.
 */
export interface CreditNoteTax {
  object: "credit_note_tax";
  /** e.g. "IGST (18.00%)" — the same spelling the invoice prints. */
  description: string;
  amount_minor: number;
}

/** Detail shape: list fields + the Refunds & Allocations timeline. */
export interface CreditNoteDetail extends CreditNote {
  /**
   * DETAIL-ONLY (its own table read; the invoice read draws the same line). Together
   * with `subtotal_minor` it makes the note's arithmetic checkable without the PDF.
   */
  discounts: CreditNoteDiscount[];
  /**
   * DETAIL-ONLY, and OPTIONAL only so a page written against an older engine still
   * compiles — the current engine always sends it (an empty array on a note with no tax).
   */
  taxes?: CreditNoteTax[];
  allocations: CreditNoteAllocation[];
  refunds: CreditNoteRefund[];
  /**
   * Cash still reversible THROUGH A GATEWAY on this note's invoice — every
   * succeeded payment on it less refunds already accepted. Detail-only (the list
   * does not join payments).
   *
   * `0` means a gateway refund cannot work no matter what `available_minor` says:
   * the invoice was settled by applied credit, or its payments are already fully
   * refunded. Gate the gateway-refund control on this, not on `available_minor` —
   * the two diverge precisely on cancellation credits, which are issued against
   * recycled credit rather than cash.
   */
  gateway_refundable_minor: number;
}

interface List<T> {
  object: "list";
  data: T[];
}

/**
 * One page of credit notes, optionally scoped to one invoice or customer.
 * **Paginated** (docs/GUIDE.md §3.4) — pass `limit` if you need more than the
 * engine's default 50, and read `has_more` before assuming you have them all.
 */
export function listCreditNotes(
  biz: string,
  opts?: { invoice?: string; customer?: string } & ListParams,
): Promise<PagedList<CreditNote>> {
  const { invoice, customer, ...list } = opts ?? {};
  const q = listQuery({ ...list, scope: { ...list.scope, invoice, customer } });
  return apiGet<PagedList<CreditNote>>(`/v1/businesses/${biz}/credit_notes${q ? `?${q}` : ""}`);
}

/** Fetch a single credit note with its refunds & allocations timeline. */
export async function getCreditNote(biz: string, cn: string): Promise<CreditNoteDetail | null> {
  try {
    return await apiGet<CreditNoteDetail>(`/v1/businesses/${biz}/credit_notes/${cn}`);
  } catch {
    return null;
  }
}

// ── Write payloads ────────────────────────────────────────────────────────────

export interface CreateCreditNoteInput {
  invoice: string;
  kind: CreditNoteKind;
  reason_code?: CreditNoteReasonCode;
  reason?: string;
  /** `invoice_line_item` names the credited line; the engine caps the item at its maximum. */
  items: Array<{ description: string; amount_minor: number; invoice_line_item?: string }>;
}

export interface CreatedCreditNote {
  object: "credit_note";
  id: string;
  invoice: string;
  kind: CreditNoteKind;
  status: CreditNoteStatus;
  subtotal_minor: number;
  total_minor: number;
  currency: string;
}

export function createCreditNote(biz: string, body: CreateCreditNoteInput) {
  return apiWrite(`/v1/businesses/${biz}/credit_notes`, body, "POST");
}

export function refundCreditNote(
  biz: string,
  cn: string,
  body: { amount_minor?: number; reason?: string },
) {
  return apiWrite(`/v1/businesses/${biz}/credit_notes/${cn}/refund`, body, "POST");
}

/** Record an offline refund (cash/check/bank transfer) against a refundable CN. */
export function recordOfflineCnRefund(
  biz: string,
  cn: string,
  body: {
    amount_minor?: number;
    method: OfflineRefundMethod;
    reference?: string;
    date?: string;
    reason?: string;
  },
) {
  return apiWrite(`/v1/businesses/${biz}/credit_notes/${cn}/record_refund`, body, "POST");
}

export function resolveCreditNotePayout(
  biz: string,
  cn: string,
  resolution: "return_as_credit" | "mark_paid",
) {
  return apiWrite(
    `/v1/businesses/${biz}/credit_notes/${cn}/resolve_payout`,
    { resolution },
    "POST",
  );
}

export function voidCreditNote(biz: string, cn: string) {
  return apiWrite(`/v1/businesses/${biz}/credit_notes/${cn}/void`, {}, "POST");
}
