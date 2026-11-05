// Typed helpers for the Invoices surface. The frozen '@/lib/api' already owns
// the core `Invoice`/`InvoiceLine` types and the `listInvoices`/`getInvoice`
// fetchers; this module adds the invoice-lifecycle knowledge the UI needs
// (status semantics, dunning state, which ops are legal for a given status).
// Never imports a provider SDK or edits lib/api.ts.
//
// Backend: src/api/invoice-routes.ts + src/modules/invoicing/{status,pending,ops}.ts
//
// Status machine (src/modules/invoicing/status.ts):
//   pending → posted → paid
//   posted → payment_due → paid | not_paid
//   payment_due|not_paid → voided
// OPEN = posted | payment_due | not_paid (a balance can be collected).
// `written_off` is a flag on top of an open→terminal transition; `voided`
// invoices for a subscription period can be regenerated.

import type { Invoice, InvoiceLine } from "@/lib/api";

export type InvoiceStatus = "pending" | "posted" | "payment_due" | "not_paid" | "paid" | "voided";
/**
 * `parked` was missing here, and the engine has been writing it since smart
 * dunning shipped: a hard-but-recoverable decline leaves the invoice open with
 * dunning PARKED and no auto-retry, recovered when the customer updates their
 * card (`src/modules/invoicing/service.ts`, the 'parked' branch). Anything that
 * switches on this union was therefore blind to a live state.
 */
export type DunningStatus = "in_progress" | "parked" | "succeeded" | "exhausted" | "stopped";

/** Statuses with a collectible balance (mirrors OPEN_INVOICE_STATUSES). */
export const OPEN_INVOICE_STATUSES: InvoiceStatus[] = ["posted", "payment_due", "not_paid"];

export function isOpenStatus(status: string): boolean {
  return (OPEN_INVOICE_STATUSES as string[]).includes(status);
}

/**
 * Fields the backend serializes that the frozen `Invoice` type does not yet
 * name. Optional so this stays assignable from a plain `Invoice`.
 *
 * Names must match `serializeInvoice` (src/modules/invoicing/serialize.ts)
 * EXACTLY — this interface used to declare `applied_credit_minor`, which the API
 * has never emitted (it emits `credits_applied_minor`), so the detail page's
 * "Credits applied" row was unreachable from the day it was written. An optional
 * field that is never populated fails silently; keep these in step with the
 * serializer.
 */
export interface InvoiceExtras {
  due_date?: string | null;
  written_off?: boolean;
  dunning_status?: DunningStatus | null;
  /**
   * Engine-computed end of this invoice's dunning period (`dunningPeriodEndsAt`); null when
   * the business sets none. RETRIEVE-only — the list route does not compute it, so treat
   * `undefined` as "not known here", never as "there is no period": once the retry offsets
   * are spent, a period still in the future buys one more attempt at the deadline.
   */
  dunning_period_ends_at?: string | null;
  /**
   * A debit is already working on this invoice. RETRIEVE-only — the list route
   * does not compute it, so treat `undefined` as "not known here", never as false
   * meaning "nothing in flight".
   */
  payment_in_flight?: boolean;
  /** That in-flight debit is waiting on the CUSTOMER's bank approval, not on us. */
  awaiting_authentication?: boolean;
  /**
   * POST-tax customer-balance credit consumed at generation: refundable + excess.
   * The promotional bucket is NOT here — it is applied pre-tax and reported as
   * `promotional_discount_minor`, already inside `total_minor`.
   */
  credits_applied_minor?: number | null;
  /**
   * The promotional-credit slice, applied BEFORE tax and reported as a discount —
   * `discounts[].entity_type = "promotional_credits"`. Already subtracted
   * from `total_minor`, so it belongs ABOVE the Total in a totals ladder, never below.
   */
  promotional_discount_minor?: number | null;
  /** Credit grants applied before tax (promotional, taxed at purchase); already off `total_minor`. */
  grant_credits_pre_tax_minor?: number | null;
  /** Credit grants taxed at use, applied after tax; also inside `credits_applied_minor`. */
  grant_credits_post_tax_minor?: number | null;
  /** Cash actually collected (sum of succeeded payments) — NOT derivable from status. */
  amount_paid_minor?: number | null;
  /** When the invoice was voided ("Voided On"). */
  voided_at?: string | null;
  /** Buyer's purchase-order reference ("Update PO Number"). */
  po_number?: string | null;
  /**
   * Collections FORECAST — deliberately not `due_date`. Nothing in the engine
   * reads it, so it never moves a dunning date.
   */
  expected_payment_date?: string | null;
  /** Provenance at creation: api | dashboard | system | import. */
  channel?: string | null;
  /** Snapshot if one was taken, else the customer's current address. */
  billing_address?: InvoiceAddress | null;
  shipping_address?: InvoiceAddress | null;
  /** False ⇒ the address above is the customer's, not a per-invoice snapshot. */
  billing_address_is_snapshot?: boolean;
  shipping_address_is_snapshot?: boolean;
  customer_name?: string | null;
  customer_email?: string | null;
}

/** Address shape shared by the invoice snapshot and the customer fallback. */
export interface InvoiceAddress {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  line1?: string | null;
  line2?: string | null;
  line3?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

/** Address lines in display order, empties dropped. */
export function addressLines(a: InvoiceAddress | null | undefined): string[] {
  if (!a) return [];
  const s = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
  const cityLine = [s(a.city), s(a.state), s(a.postal_code)].filter(Boolean).join(", ");
  return [s(a.line1), s(a.line2), s(a.line3), cityLine || null, s(a.country)].filter(
    (l): l is string => !!l,
  );
}

/**
 * "First Last" / company — whatever the address actually carries.
 *
 * Now one line of `lib/names.ts`, which mirrors the engine's `names.ts`. It kept its
 * old name here so the operator invoice page's import does not move; new callers
 * should reach for `addressContactName` directly and pick the right chain for their
 * surface (an address contact is NOT the same answer as "who is this customer").
 */
export { addressContactName as addressName } from "@/lib/names";

export type InvoiceDetail = Invoice & InvoiceExtras;

/**
 * Which lifecycle ops are legal for an invoice, computed once from its status +
 * dunning state (guards mirror the backend `InvoiceOpsError` throws so the UI
 * never offers an op the API will reject). Archival = settled imported invoice:
 * reference-only, no ops.
 */
export interface InvoiceCapabilities {
  archival: boolean;
  /** Balance can be collected / paid / voided / written off. */
  open: boolean;
  /** Pending, awaiting Close (finalize). */
  pending: boolean;
  /** Terminal paid/voided (no balance to act on). */
  settled: boolean;
  canClose: boolean;
  canCollect: boolean;
  canRecordPayment: boolean;
  canVoid: boolean;
  canWriteOff: boolean;
  canRegenerate: boolean;
  canStopDunning: boolean;
  canPauseDunning: boolean;
  canRetry: boolean;
}

export function invoiceCapabilities(inv: InvoiceDetail): InvoiceCapabilities {
  const status = inv.status;
  const open = isOpenStatus(status);
  const pending = status === "pending";
  const settled = status === "paid" || status === "voided";
  const inDunning = status === "payment_due";
  // Imported + settled = archival history from the source system; no ops.
  const archival = Boolean(inv.imported) && !open;
  /**
   * A live attempt blocks a NEW one. The engine will not charge over a pending
   * payment, so both Collect now and Retry now are inert while one is in flight —
   * and inert in the worst way: `POST …/collect` returned **200 with the invoice
   * unchanged**, so the operator saw a success and nothing happened (measured
   * 2026-08-17 against an AFA-pending debit; no second charge, `attempt_count`
   * unmoved). Recording a payment by hand is still legal — that is the operator
   * telling us money arrived out of band, not asking the gateway for more.
   */
  const inFlight = Boolean(inv.payment_in_flight);

  return {
    archival,
    open: open && !archival,
    pending,
    settled,
    // Only a pending invoice with a subscription can be closed; the backend
    // rejects the rest, but pending + no-subscription is rare, so we surface
    // Close on pending and let the API guard the edge.
    canClose: pending && !archival,
    canCollect: open && !archival && !inFlight,
    canRecordPayment: open && !archival,
    // The engine refuses a void with money on the invoice (`voidBlocker`): a payment,
    // one in flight, or tax withheld. Offering it would only produce that refusal.
    canVoid:
      open &&
      !archival &&
      !inFlight &&
      !(inv.amount_paid_minor ?? 0) &&
      !(inv.withholding_minor ?? 0),
    canWriteOff: open && !archival && !inv.written_off,
    // Regenerate is only legal on a voided subscription invoice.
    canRegenerate: status === "voided" && Boolean(inv.subscription) && !archival,
    /**
     * Dunning ops need dunning to actually be RUNNING, and `status` alone cannot
     * say whether it is. Measured 2026-08-21 on a payment_due invoice with
     * `dunning_status` null and a PENDING debit (the engine parks an unresolved
     * first attempt without arming a ladder): the card offered both buttons with
     * no dunning to act on, and neither was inert —
     *   - Stop would have flipped a still-settling invoice to not_paid/stopped;
     *   - Pause would have SET `dunning_status: 'in_progress'` and a retry date,
     *     i.e. started dunning, over a live debit.
     * So this is gated on `dunning_status`, not on status. `parked` may be
     * stopped (the operator giving up on a card that was never fixed) but not
     * paused — pausing writes `in_progress` + a retry, which un-parks it and
     * schedules exactly the retry the park exists to prevent.
     *
     * `inDunning` stays in the condition because the backend guard is on status
     * (`stopDunning`/`pauseDunning` reject anything but payment_due), and an
     * absent `dunning_status` hides the buttons rather than showing them — the
     * safe direction for a field a list route may not serialize.
     */
    canStopDunning:
      inDunning &&
      !archival &&
      (inv.dunning_status === "in_progress" || inv.dunning_status === "parked"),
    canPauseDunning: inDunning && !archival && inv.dunning_status === "in_progress",
    canRetry: inDunning && !archival && !inFlight,
  };
}

/** Deep-link to pre-fill the credit-note create form for this invoice. */
export function newCreditNoteHref(biz: string, invoiceId: string): string {
  return `/businesses/${biz}/credit_notes/new?invoice=${encodeURIComponent(invoiceId)}`;
}

/**
 * Line kinds the engine inserts as SYNTHETIC adjustment lines rather than things
 * the customer bought (src/modules/invoicing/service.ts): a named tax line per
 * rate ("IGST (18.00%)"), a discount line per consumed coupon period, and a
 * round-off delta. They belong in the totals block, not the items table.
 *
 * Order is display order under Subtotal — discounts reduce the taxable base, so
 * they precede tax; the round-off is last because it trues up everything above.
 */
const ADJUSTMENT_KINDS = ["discount", "tax", "rounding"] as const;

export interface InvoiceTotalsRow {
  id: string;
  /** The engine's own line description — already carries the rate name and percent. */
  label: string;
  amountMinor: number;
}

/**
 * Split an invoice's lines into what was billed and what adjusted it.
 *
 * `total = subtotal + Σ adjustments` still holds, but **`subtotal_minor` is not the gross
 * sum of the item rows** — ITEM-level discounts are already inside it, while
 * document-level ones are the `discount` adjustment rows below it (see the backend's
 * 0169). Two consequences for this page:
 *
 *  - Σ `items[].amount_minor` can EXCEED `subtotal_minor`, by the item-level discount.
 *    Rendering the items table and then a Subtotal row that is smaller looks like an
 *    arithmetic error unless the per-line `discount_minor` column is shown too — which is
 *    exactly how the line table reads (Items · Price · Discount · Amount).
 *  - An item-level-discounted invoice has NO `discount` adjustment row. The discount is
 *    not missing; it is inside Subtotal and attributed per line.
 *
 * (History: the page used to render every line in the items table AND print
 * `total − subtotal` as a row labelled "Tax", double-displaying each adjustment and
 * mislabelling all of them — a discounted invoice showed "Tax −$64.90". Bucketing by
 * `kind` gives one correctly-named row per adjustment.)
 *
 * Inclusive tax produces no tax line (it is inside the product amounts), so
 * `adjustments` is simply empty for it — nothing to reconcile, nothing to show.
 */
export function splitInvoiceLines(lines: readonly InvoiceLine[] | undefined | null): {
  items: InvoiceLine[];
  adjustments: InvoiceTotalsRow[];
  /** Any item row carries an ITEM-level discount → show the Discount column. */
  hasLineDiscounts: boolean;
} {
  const all = lines ?? [];
  const items = all.filter((l) => !(ADJUSTMENT_KINDS as readonly string[]).includes(l.kind));
  const adjustments = ADJUSTMENT_KINDS.flatMap((kind) =>
    all
      .filter((l) => l.kind === kind)
      .map((l) => ({ id: l.id, label: l.description, amountMinor: l.amount_minor })),
  );
  // Keyed on the ITEM-level part only: that is the money inside `subtotal_minor` and the
  // only part that needs explaining beside the lines. A document-level discount already
  // has its own adjustment row, so surfacing it per line as well would double-display it.
  return {
    items,
    adjustments,
    hasLineDiscounts: items.some((l) => (l.item_level_discount_minor ?? 0) !== 0),
  };
}
