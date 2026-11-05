import { pendingInvoiceUsageWindow } from "@/modules/subscriptions/usage-window";
import { activatePaidCreditGrants } from "@/modules/credits/packs";
import { stampNow } from "@/platform/clock";
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { postEntries } from "@/modules/ledger/service";
import { recordTransaction } from "@/modules/transactions/service";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import {
  collectInvoice,
  CollectionDeferredError,
  CollectionInFlightError,
  createInvoiceFromLines,
  billSubscriptionPeriod,
  getInvoiceWithLines,
  invoiceOutstanding,
  postCreditApplications,
  type InvoiceDetail,
  type InvoiceLineInput,
} from "./service";
import { isCustomerPaymentMethod } from "./collection";
import { isOpenInvoiceStatus, OPEN_INVOICE_STATUSES } from "./status";
import { restoreDiscountPeriod } from "@/modules/coupons/service";
// balances-read, not balances: the writers there import events/emit, and ops.ts is
// reached from the event snapshot path — see the cycle note in balances-read.ts.
import {
  EXCESS_PAYMENT,
  REFUNDABLE_CREDIT,
  bucketBalance,
  bucketBalancesForCurrency,
  lockCustomerBalances,
} from "@/modules/customers/balances-read";
import {
  invoices,
  invoiceLineItems,
  creditNotes,
  payments,
  refunds,
  subscriptions,
  customers,
  ledgerEntries,
  businesses,
} from "@db/schema";
import { formatMoney } from "@/platform/currency";
import { createLogger } from "@/platform/logger";
import { dunningFieldsOnSettle, dunningFieldsOnCreditSettle } from "@/modules/invoicing/status";

/**
 * Operator invoice actions — void, write off, reverse, regenerate, collect now,
 * record an offline payment. Every one of them moves money on a HUMAN's say-so.
 *
 * This file had no logging at all. The audit log records them per tenant (that is the
 * customer-facing record), but nothing reached the operational stream — so a support
 * question like "who wrote off this invoice, and did it actually work" could only be
 * answered from the database, and a failure that a caller swallowed into a warnings
 * array (see subscriptions/service.ts § applyCancelMoneyHandling) left no trace at all.
 * These lines are the ops view; the audit rows remain the business record.
 */
const log = createLogger("invoicing");

type Invoice = typeof invoices.$inferSelect;
type Payment = typeof payments.$inferSelect;

export class InvoiceOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceOpsError";
  }
}

async function loadInvoice(
  orgId: string,
  businessId: string,
  invoicePublicId: string,
): Promise<Invoice> {
  const inv = await withTenant(orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, invoicePublicId)))
      .limit(1);
    return row ?? null;
  });
  if (!inv) throw new InvoiceOpsError(`We could not find the invoice ${invoicePublicId}.`);
  return inv;
}

/**
 * Update the operator-editable, NON-FINANCIAL fields on an invoice: the PO number
 * and the address.
 *
 * Deliberately separate from the lifecycle ops in this file: it posts no ledger
 * entries, touches no status, and is legal in ANY status including `paid` and
 * `voided` — correcting a PO number or a typo'd address on a settled invoice must
 * stay possible, since refusing would leave the record permanently wrong.
 * Archival imported rows are the one exception — they are read-only history.
 *
 * `undefined` = leave alone, `null` = clear. That distinction is the whole point:
 * a caller editing only the PO number must not blank the address snapshot.
 */
export async function updateInvoiceFields(
  orgId: string,
  businessId: string,
  invoicePublicId: string,
  fields: {
    poNumber?: string | null;
    expectedPaymentDate?: Date | null;
    billingAddress?: Record<string, unknown> | null;
    shippingAddress?: Record<string, unknown> | null;
  },
): Promise<InvoiceDetail | null> {
  const inv = await loadInvoice(orgId, businessId, invoicePublicId);
  assertNotSettledArchival(inv, "edit");

  const patch: Partial<typeof invoices.$inferInsert> = {};
  if (fields.poNumber !== undefined) patch.poNumber = fields.poNumber;
  if (fields.expectedPaymentDate !== undefined)
    patch.expectedPaymentDate = fields.expectedPaymentDate;
  if (fields.billingAddress !== undefined) patch.billingAddress = fields.billingAddress;
  if (fields.shippingAddress !== undefined) patch.shippingAddress = fields.shippingAddress;
  if (Object.keys(patch).length === 0)
    return getInvoiceWithLines(orgId, businessId, invoicePublicId);

  await withTenant(orgId, async (tx) => {
    await tx.update(invoices).set(patch).where(eq(invoices.id, inv.id));
    // Audited, not evented: this changes no domain state a webhook subscriber
    // could act on, but "who changed the PO number" is exactly what the activity
    // log is for. Diff carries only the fields actually touched.
    const { writeAuditLog } = await import("@/modules/audit/service");
    await writeAuditLog(
      {
        organizationId: orgId,
        businessId,
        action: "invoice.update",
        resourceType: "invoice",
        resourceId: inv.publicId,
        before: Object.fromEntries(
          Object.keys(patch).map((k) => [k, (inv as Record<string, unknown>)[k] ?? null]),
        ),
        after: Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v ?? null])),
      },
      tx,
    );
  });
  return getInvoiceWithLines(orgId, businessId, invoicePublicId);
}

/**
 * Settled imported invoices are ARCHIVAL: they exist for reference only and
 * carry no ledger postings, so lifecycle money ops on them are meaningless
 * (and would corrupt the ledger). Open imported invoices are real AR — allowed.
 */
function assertNotSettledArchival(inv: Invoice, op: string): void {
  if (inv.imported && !isOpenInvoiceStatus(inv.status)) {
    throw new InvoiceOpsError(
      `You cannot ${op} an imported archival invoice. It is settled history from the source system.`,
    );
  }
}

/**
 * Create a manual / one-off invoice for a customer (not tied to a subscription
 * period). `netDays` sets Net-D terms; `collect` attempts immediate charge.
 */
export async function createManualInvoice(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  currency: string;
  lines: InvoiceLineInput[];
  collect?: boolean;
  netDays?: number;
  applyTax?: boolean;
  country?: string | null;
  /** Free-text state NAME. Display only — never used to resolve tax (see `stateCode`). */
  state?: string | null;
  /**
   * ISO-3166-2 subdivision code — the place of supply. This, not `state`, is what the
   * tax engine compares against the seller's own state and against state-scoped rate
   * components. Omitted → the customer's own `state_code`.
   */
  stateCode?: string | null;
  poNumber?: string;
  /** With `collect`: charge this saved method (`pm_…`) only. */
  paymentMethodOverrideId?: string;
  /** Runs last inside the invoice transaction. */
  inTx?: Parameters<typeof createInvoiceFromLines>[0]["inTx"];
}): Promise<{ invoice: Invoice; payment: Payment | null }> {
  if (input.lines.length === 0) throw new InvoiceOpsError("An invoice needs at least one line");
  const dueDate = input.netDays != null ? new Date(Date.now() + input.netDays * 86_400_000) : null;
  log.info("manual invoice requested", {
    event: "manual_invoice_created",
    customer: input.customerId,
    currency: input.currency,
    lines: input.lines.length,
    netDays: input.netDays ?? null,
    collect: input.collect ?? false,
  });
  return createInvoiceFromLines({
    organizationId: input.organizationId,
    businessId: input.businessId,
    customerId: input.customerId,
    currency: input.currency,
    lines: input.lines,
    applyTax: input.applyTax,
    country: input.country,
    state: input.state,
    stateCode: input.stateCode,
    applyCredit: true,
    dueDate,
    collect: input.collect ?? false,
    ...(input.poNumber ? { poNumber: input.poNumber } : {}),
    ...(input.paymentMethodOverrideId
      ? { paymentMethodOverrideId: input.paymentMethodOverrideId }
      : {}),
    ...(input.inTx ? { inTx: input.inTx } : {}),
  });
}

/**
 * Void an unpaid invoice: it's no longer owed. Reverses EXACTLY what generation
 * (and credit application) posted to the ledger by reading those entries back and
 * mirroring them — this is drift-proof (discounts, inclusive tax, withholding,
 * bucket draws all reverse correctly, and the compensating entry is guaranteed
 * balanced because the originals were). Only open/uncollectible.
 *
 * (Previously this re-derived tax as `total − subtotal`, which threw "Unbalanced"
 * on any coupon-discounted invoice and stranded tax_payable on inclusive tax —
 * review finding 2026-07-04.)
 *
 * ⚠️ `businesses.default_credit_note_on_void` (0243, "raise a credit note on void")
 * is DELIBERATELY NOT CONSUMED HERE, though the column/serializer/settings
 * row all exist. The only live credit-note issuance path, `issueAdjustmentCreditNote`
 * (`credit-notes/service.ts`), posts its OWN reversal — it credits
 * `accounts_receivable` for the full amount and debits `bad_debt`/`credit_adjustments`
 * + a proportional `tax_payable` share — which is a SECOND, independent reversal of
 * the exact debt the mirror above already reverses. Calling it after the mirror
 * double-credits AR for one debt; calling it before hits its own
 * `isOpenInvoiceStatus` guard once this function's atomic claim has flipped the
 * invoice to `voided` (and calling it before THAT claim still leaves both reversals
 * live). It also has no notion of the `credit_applied` (D1 bucket-draw) ledger lines
 * this function separately mirrors, so swapping it in for the mirror — rather than
 * layering it on top — would silently stop reversing those. Wiring this flag needs
 * either a new ledger-free/void-aware issuance path or a verified reconciliation
 * that the two mechanisms cannot overlap; neither exists yet. See docs/PROGRESS.md.
 */
/**
 * Why this open invoice may not be voided, or null. Money already on it would be
 * stranded: the void reverses the invoice but not the payment, so the customer's cash
 * sat against a voided invoice with no credit and no refund. So a void needs no net
 * payment (after refunds), none in flight, and no tax withheld.
 */
export async function voidBlocker(
  tx: Tx,
  inv: Pick<Invoice, "id" | "currency" | "withholdingMinor">,
): Promise<string | null> {
  if ((inv.withholdingMinor ?? 0n) > 0n)
    return "Tax was withheld on this invoice, so you cannot void it. Write off the rest instead.";
  const [row] = await tx
    .select({
      paid: sql<string>`coalesce(sum(${payments.amountMinor}) filter (where ${payments.status} = 'succeeded'), 0)`,
      inFlight: sql<number>`count(*) filter (where ${payments.status} in ('pending', 'requires_action'))`,
      refunded: sql<string>`coalesce((select sum(${refunds.amountMinor}) from ${refunds} where ${refunds.paymentId} in (select ${payments.id} from ${payments} where ${payments.invoiceId} = ${inv.id} and ${payments.status} = 'succeeded') and ${refunds.status} = 'succeeded'), 0)`,
    })
    .from(payments)
    .where(eq(payments.invoiceId, inv.id));
  if (Number(row?.inFlight ?? 0) > 0)
    return "A payment is still in progress on this invoice. Wait for it to settle before you void the invoice.";
  const net = BigInt(row?.paid ?? "0") - BigInt(row?.refunded ?? "0");
  if (net > 0n)
    return `${formatMoney(net, inv.currency)} is paid on this invoice. Refund it first, or write off the rest instead.`;
  return null;
}

export async function voidInvoice(
  orgId: string,
  businessId: string,
  invoicePublicId: string,
  /** Omit both and the void is exactly as before. */
  opts: {
    voidReasonCode?: string;
    comment?: string;
    /**
     * An operator's void: ask the gateway to cancel a pending debit first, and refuse with
     * `DebitInProgressError` if it does not. Automated voids keep `voidBlocker`'s refusal.
     */
    cancelPendingDebit?: boolean;
  } = {},
): Promise<Invoice> {
  let inv = await loadInvoice(orgId, businessId, invoicePublicId);
  assertNotSettledArchival(inv, "void");
  if (!isOpenInvoiceStatus(inv.status))
    throw new InvoiceOpsError(`You cannot void a ${inv.status} invoice`);
  if (opts.cancelPendingDebit) {
    const { clearPendingDebits } = await import("@/modules/payments/pending-debit");
    const cleared = await clearPendingDebits({
      organizationId: orgId,
      businessId,
      invoiceId: inv.id,
      action: "void",
    });
    if (cleared.cancelled + cleared.settled > 0) {
      inv = await loadInvoice(orgId, businessId, invoicePublicId);
      if (!isOpenInvoiceStatus(inv.status))
        throw new InvoiceOpsError(`You cannot void a ${inv.status} invoice`);
    }
  }
  const blocked = await withTenant(orgId, (tx) => voidBlocker(tx, inv));
  if (blocked) throw new InvoiceOpsError(blocked);
  return withTenant(orgId, async (tx) => {
    // ATOMIC CLAIM (H review blocker): flip to voided FIRST, guarded on a
    // still-open status — two concurrent voids otherwise both mirror the ledger
    // (double reversal) and both restore the coupon redemption. The loser's whole
    // tx rolls back here.
    const [claimed] = await tx
      .update(invoices)
      // `voided_at` is stamped in the same atomic claim as the status, so the two
      // can never disagree — the invoice list has a "Voided On" column.
      .set({
        status: "voided",
        nextAttemptAt: null,
        voidedAt: stampNow(),
        ...(opts.voidReasonCode ? { voidReasonCode: opts.voidReasonCode } : {}),
        // The chase has to END with the debt (#57, same root as the allocation release
        // below: the void moved the money and left the labels). Clearing only
        // `next_attempt_at` left a voided invoice reading `dunning_status:
        // 'in_progress'` — 41 such rows on the box that found this. The clock cannot act
        // on them (`runDunningPass` needs `next_attempt_at IS NOT NULL`; the offline
        // reminder scan and `sweepStrandedRetries` both require `status = 'payment_due'`,
        // all three checked rather than assumed), but `listRetriesPage`'s UNDER_RETRY is
        // `… or dunning_status is not null` with no status filter, so they DID show on the
        // /retries screen as invoices awaiting collection attention.
        //
        // `stopped` is the value `dunningFieldsOnCreditSettle` already documents for the
        // same question — the balance went away with NO CASH, which is `stopped` and
        // never `success` — but that helper is NOT reused here, and the difference is
        // load-bearing. It rewrites ANY chased invoice, and the commonest void on this box
        // is dunning's own final action, which voids from `not_paid` + `exhausted` (203
        // such rows, 168 of them with a real failed attempt behind them). `exhausted` is
        // already terminal and already true: we tried the whole ladder and got nothing.
        // Replacing it with `stopped` would erase that for the majority of voids and
        // change the dunning-final-action behaviour this fix is required not to touch.
        //
        // So only a LIVE chase is ended here. `in_progress` and `parked` are the two
        // values that claim collection is still pending; every other value (`exhausted`,
        // `success`, `stopped`, null) is a finished story that the void must not restate.
        // An invoice nobody ever chased keeps its null, so a void cannot invent a
        // collections history either.
        ...(inv.dunningStatus === "in_progress" || inv.dunningStatus === "parked"
          ? { dunningStatus: "stopped" as const }
          : {}),
      })
      .where(and(eq(invoices.id, inv.id), inArray(invoices.status, [...OPEN_INVOICE_STATUSES])))
      .returning();
    if (!claimed)
      throw new InvoiceOpsError(
        "The invoice is no longer open. Another request voided or settled it at the same time.",
      );
    // Read every ledger entry generation posted for this invoice: the invoice
    // itself and any credit applications drawn against it. (Payments never happen
    // on an open/uncollectible invoice, so there's nothing else to reverse.)
    const originals = await tx
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.businessId, businessId),
          // 'invoice' = normal generation; 'import' = imported open invoice
          // (AR ↔ opening_balance); 'credit_applied' = the D1 bucket draws.
          inArray(ledgerEntries.sourceType, ["invoice", "import", "credit_applied"]),
          eq(ledgerEntries.sourceId, inv.publicId),
        ),
      );
    // Mirror each original line (debit↔credit) → a balanced compensating entry.
    const lines = originals.map((e) => ({
      account: e.account,
      direction: (e.direction === "debit" ? "credit" : "debit") as "debit" | "credit",
      amountMinor: e.amountMinor,
      currency: e.currency,
    }));
    if (lines.length > 0) {
      await postEntries(
        {
          organizationId: orgId,
          businessId,
          customerId: inv.customerId,
          sourceType: "invoice_void",
          sourceId: inv.publicId,
          lines,
        },
        tx,
      );
    }
    // RELEASE THE CREDIT-NOTE ALLOCATIONS this invoice consumed (#57), in the SAME
    // transaction as the compensating entry above. The ledger reversal hands the credit
    // back to the bucket; without this the note kept claiming it was spent, which read as
    // ₹0 available on an API/UI surface and REFUSED to refund the customer their own
    // money. The two have to move together or they diverge again — see the function's own
    // note for the measurement, the delete-vs-reversal decision, and why only refundable
    // notes are released. Dynamic import for the same reason `writeOffInvoice` below uses
    // one: `invoicing/service` (this file's static dependency) is imported BY
    // credit-notes/service.
    const { releaseAllocationsForVoidedInvoice } = await import("@/modules/credit-notes/service");
    const creditReleasedMinor = await releaseAllocationsForVoidedInvoice(tx, {
      organizationId: orgId,
      businessId,
      customerId: inv.customerId,
      invoiceId: inv.id,
      invoicePublicId: inv.publicId,
    });
    // The released allocation must land back in the refundable bucket. The mirror does that
    // for engine invoices (their `credit_applied` draw is reversed). An imported invoice's
    // credit was netted into its opening AR, so the mirror returns nothing and the note
    // would show credit the customer cannot spend: open the gap from `opening_balance`,
    // as the import does for a note's unused credit.
    const returnedToBucket = lines
      .filter((l) => l.account === REFUNDABLE_CREDIT)
      .reduce((s, l) => s + (l.direction === "credit" ? l.amountMinor : -l.amountMinor), 0n);
    const unfunded = creditReleasedMinor - returnedToBucket;
    if (unfunded > 0n && inv.imported) {
      const memo = "Opening credit (imported refundable credit note, released by invoice void)";
      await postEntries(
        {
          organizationId: orgId,
          businessId,
          customerId: inv.customerId,
          sourceType: "invoice_void",
          sourceId: inv.publicId,
          lines: [
            {
              account: "opening_balance",
              direction: "debit",
              amountMinor: unfunded,
              currency: inv.currency,
              memo,
            },
            {
              account: REFUNDABLE_CREDIT,
              direction: "credit",
              amountMinor: unfunded,
              currency: inv.currency,
              memo,
            },
          ],
        },
        tx,
      );
    } else if (unfunded > 0n) {
      log.error("void released credit-note allocation that the ledger mirror did not return", {
        event: "void_credit_release_unfunded",
        invoice: inv.publicId,
        releasedMinor: String(creditReleasedMinor),
        returnedMinor: String(returnedToBucket),
      });
    }
    // Credit grants (design G3 §3.8): the mirror above reversed the draws' postings; give
    // the units back to their grants, and void any grant this invoice sold but was never paid.
    const credits = await import("@/modules/credits/service");
    await credits.restoreGrantDrawsForVoidedInvoice(tx, {
      organizationId: orgId,
      businessId,
      customerId: inv.customerId,
      invoiceId: inv.id,
      invoicePublicId: inv.publicId,
    });
    await credits.voidPendingGrantsForInvoice(tx, {
      organizationId: orgId,
      businessId,
      invoiceId: inv.id,
      invoicePublicId: inv.publicId,
      reason: "void",
    });
    // Refund each coupon redemption this invoice consumed (G backlog): restore the
    // period so a regenerate re-applies the coupon instead of billing at full price.
    const discountLines = await tx
      .select({ appliedCouponId: invoiceLineItems.appliedCouponId })
      .from(invoiceLineItems)
      .where(and(eq(invoiceLineItems.invoiceId, inv.id), eq(invoiceLineItems.kind, "discount")));
    for (const dl of discountLines) {
      if (dl.appliedCouponId) await restoreDiscountPeriod(tx, dl.appliedCouponId);
    }
    await emitEvent(tx, {
      organizationId: orgId,
      businessId,
      type: "invoice_voided",
      data: buildEventData("invoice_voided", { id: inv.publicId, status: claimed.status }),
    });
    const { writeAuditLog } = await import("@/modules/audit/service");
    await writeAuditLog(
      {
        organizationId: orgId,
        businessId,
        action: "invoice.void",
        resourceType: "invoice",
        resourceId: inv.publicId,
        before: { status: inv.status, dunning_status: inv.dunningStatus },
        after: {
          status: "voided",
          dunning_status: claimed.dunningStatus,
          // What the void gave back to which credit notes is the history that deleting the
          // allocation rows would otherwise leave only in the ledger. Recorded on the path
          // that is already the tenant's business record.
          credit_released_minor: Number(creditReleasedMinor),
          ...(opts.voidReasonCode ? { void_reason_code: opts.voidReasonCode } : {}),
          ...(opts.comment ? { comment: opts.comment } : {}),
        },
      },
      tx,
    );
    log.info("invoice voided", {
      event: "invoice_voided",
      invoice: inv.publicId,
      fromStatus: inv.status,
      totalMinor: String(inv.totalMinor),
      creditReleasedMinor: String(creditReleasedMinor),
      currency: inv.currency,
    });
    return claimed;
  });
}

/**
 * Write off an unpaid invoice as bad debt (INV-4): routed through an ADJUSTMENT
 * credit note (reason `write_off`) which books bad_debt / AR and zeroes the
 * invoice → it reads `paid` + `written_off=true`. The bad-debt ledger posting now
 * lives on the CN path, so write-off and adjustment share one money story.
 */
export async function writeOffInvoice(
  orgId: string,
  businessId: string,
  invoicePublicId: string,
): Promise<Invoice> {
  const inv = await loadInvoice(orgId, businessId, invoicePublicId);
  assertNotSettledArchival(inv, "write off");
  if (!isOpenInvoiceStatus(inv.status))
    throw new InvoiceOpsError(`You cannot write off a ${inv.status} invoice`);
  // What is STILL owed, not what was billed. `amount_due_minor` is the issue-time
  // collectible net of CREDITS ONLY — cash is deliberately never subtracted from it
  // (`invoiceOutstanding` owns that rule and says so). Reading it raw books the customer's
  // own payments as bad debt a second time: measured on a 5000 invoice with 3000 collected,
  // all 5000 went to `bad_debt` while the 3000 sat in the bank, so the books claimed we
  // never received money we hold. Bad debt is what we will never collect, which can only
  // ever be the uncollected part.
  const { remainingMinor: amountDue } = await withTenant(orgId, (tx) =>
    invoiceOutstanding(tx, inv),
  );
  if (amountDue <= 0n)
    throw new InvoiceOpsError("There is nothing to write off. The invoice has no balance due.");
  const { issueAdjustmentCreditNote } = await import("@/modules/credit-notes/service");
  await issueAdjustmentCreditNote({
    organizationId: orgId,
    businessId,
    invoicePublicId,
    items: [{ description: "Write-off (bad debt)", amountMinor: Number(amountDue) }],
    reasonCode: "write_off",
    reason: "Bad debt write-off",
  });
  // invoice.written_off is emitted inside issueAdjustmentCreditNote's tx (outbox
  // invariant — review fix), so nothing to emit here.
  const updated = await loadInvoice(orgId, businessId, invoicePublicId);
  // Bad debt: money we booked as owed and will never collect. Worth an operational
  // line, not only an audit row — a rise in write-offs is an ops signal.
  log.info("invoice written off as bad debt", {
    event: "invoice_written_off",
    invoice: inv.publicId,
    amountMinor: String(amountDue),
    currency: inv.currency,
    status: updated.status,
  });
  return updated;
}

/**
 * "Reverse the Invoice" (Settings → Dunning, final invoice action): drop the debt
 * and settle the invoice as PAID via a full adjustment credit note carrying the
 * `order_cancellation` reason code.
 *
 * Deliberately NOT a write-off, though the machinery is shared: a write-off books
 * `bad_debt` (the customer owed us and defaulted), whereas a reversal books
 * `credit_adjustments` (we cancelled the order, so there was never a debt to lose)
 * and leaves `written_off` false. `issueAdjustmentCreditNote` zeroes the balance
 * and flips the invoice to `paid`.
 */
export async function reverseInvoice(
  orgId: string,
  businessId: string,
  invoicePublicId: string,
): Promise<Invoice> {
  const inv = await loadInvoice(orgId, businessId, invoicePublicId);
  assertNotSettledArchival(inv, "reverse");
  if (!isOpenInvoiceStatus(inv.status))
    throw new InvoiceOpsError(`You cannot reverse a ${inv.status} invoice`);
  // Same rule as `writeOffInvoice`, same reason: the stored column has not had cash taken
  // off it, so a part-paid invoice reversed on the raw figure credits the cash back as
  // though it had never arrived. A reversal drops the DEBT, and the paid part is not debt.
  const { remainingMinor: amountDue } = await withTenant(orgId, (tx) =>
    invoiceOutstanding(tx, inv),
  );
  if (amountDue <= 0n)
    throw new InvoiceOpsError("There is nothing to reverse. The invoice has no balance due.");
  const { issueAdjustmentCreditNote } = await import("@/modules/credit-notes/service");
  await issueAdjustmentCreditNote({
    organizationId: orgId,
    businessId,
    invoicePublicId,
    items: [{ description: "Order cancellation", amountMinor: Number(amountDue) }],
    reasonCode: "order_cancellation",
    reason: "Invoice reversed at the end of the dunning period",
  });
  const reversed = await loadInvoice(orgId, businessId, invoicePublicId);
  log.info("invoice reversed", {
    event: "invoice_reversed",
    invoice: inv.publicId,
    amountMinor: String(amountDue),
    currency: inv.currency,
    status: reversed.status,
  });
  return reversed;
}

/**
 * Regenerate a VOIDED invoice (INV-6): bill the same subscription period afresh —
 * a brand-new invoice (new number/id), leaving the voided one as history. Only
 * subscription invoices can be regenerated (the period + items drive the rebill).
 */
export async function regenerateInvoice(
  orgId: string,
  businessId: string,
  invoicePublicId: string,
): Promise<{ invoice: Invoice; payment: Payment | null }> {
  const inv = await loadInvoice(orgId, businessId, invoicePublicId);
  if (inv.status !== "voided")
    throw new InvoiceOpsError(
      `You can regenerate only a voided invoice. This invoice is ${inv.status}.`,
    );
  if (!inv.subscriptionId)
    throw new InvoiceOpsError("You can regenerate only a subscription invoice");
  if (!inv.periodStart || !inv.periodEnd)
    throw new InvoiceOpsError("Invoice has no billing period to regenerate");
  const sub = await withTenant(
    orgId,
    async (tx) =>
      (
        await tx
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.id, inv.subscriptionId!))
          .limit(1)
      )[0] ?? null,
  );
  if (!sub) throw new InvoiceOpsError("Invoice references a missing subscription");
  // Idempotence guard (review fix): regenerate is otherwise repeatable with a fresh
  // Idempotency-Key, minting N live invoices for one period (and burning a coupon
  // redemption each time). Refuse if a LIVE (non-voided/credited) invoice already
  // covers this (subscription, period) — the caller must void that one first.
  // (Recurring lines re-price off the item's immutable price_snapshot, and the
  // arrears usage window is re-billed for the same period, so the rebill matches.)
  const existingLive = await withTenant(orgId, async (tx) =>
    tx
      .select({ id: invoices.id, publicId: invoices.publicId, status: invoices.status })
      .from(invoices)
      .where(
        and(
          eq(invoices.subscriptionId, inv.subscriptionId!),
          eq(invoices.periodStart, inv.periodStart!),
          eq(invoices.periodEnd, inv.periodEnd!),
        ),
      ),
  );
  const live = existingLive.find((r) => r.status !== "voided");
  if (live)
    throw new InvoiceOpsError(
      `A live invoice (${live.publicId}, ${live.status}) already covers this period. Void it before you regenerate this invoice.`,
    );
  log.info("voided invoice regenerated", {
    event: "invoice_regenerated",
    invoice: inv.publicId,
    subscription: sub.publicId,
    periodStart: inv.periodStart.toISOString(),
    periodEnd: inv.periodEnd.toISOString(),
  });
  // A monthly usage invoice re-bills its own usage window and no fixed charges.
  const subPeriod = (inv.metadata as { sub_period?: unknown } | null)?.sub_period;
  return billSubscriptionPeriod({
    organizationId: orgId,
    businessId,
    subscription: sub,
    periodStart: inv.periodStart,
    periodEnd: inv.periodEnd,
    ...(subPeriod
      ? {
          skipFixed: true,
          usagePeriod: pendingInvoiceUsageWindow(inv),
          metadata: inv.metadata as Record<string, unknown>,
        }
      : {}),
    // P4: audit the regenerate against the VOIDED invoice, not the new one — that
    // is the record the operator was looking at, so that is where the Activity Log
    // must show the decision. The new invoice's own history starts with
    // `invoice_generated`. Diff: the voided row gained a successor it did not have.
    auditWrite: (fresh) => ({
      action: "invoice.regenerate",
      resourceId: inv.publicId,
      before: { regenerated_into: null },
      after: { regenerated_into: fresh.publicId, regenerated_status: fresh.status },
    }),
  });
}

/**
 * Attempt collection now (manual "collect"/"retry now"). Re-reads final status.
 *
 * `opts.session` defaults to off-session: an operator pressing Collect is NOT the
 * buyer, so a `requires_action` stays a dunning failure exactly as before. Only a
 * caller that has the buyer on the line passes `on_session`, and it must be ready
 * for `PaymentActionRequiredError` (which propagates out of here untouched — no
 * audit row, because no collection outcome exists yet).
 */
export async function collectInvoiceNow(
  orgId: string,
  businessId: string,
  invoicePublicId: string,
  opts: {
    session?: "on_session" | "off_session";
    returnUrl?: string;
    cancelUrl?: string;
    /** Charge this card only (the customer's own; no backups). Omitted: the usual order. */
    paymentMethodOverrideId?: string;
    /** Operator note; lands on the audit row. */
    comment?: string;
  } = {},
): Promise<{ invoice: Invoice; payment: Payment | null }> {
  const inv = await loadInvoice(orgId, businessId, invoicePublicId);
  assertNotSettledArchival(inv, "collect");
  if (!isOpenInvoiceStatus(inv.status))
    throw new InvoiceOpsError(`You cannot collect a ${inv.status} invoice`);
  if (
    opts.paymentMethodOverrideId &&
    !(await isCustomerPaymentMethod(orgId, inv.customerId, opts.paymentMethodOverrideId))
  )
    throw new InvoiceOpsError(
      `We could not find the payment method ${opts.paymentMethodOverrideId} for this invoice's customer.`,
    );
  const sub = inv.subscriptionId
    ? await withTenant(
        orgId,
        async (tx) =>
          (
            await tx
              .select()
              .from(subscriptions)
              .where(eq(subscriptions.id, inv.subscriptionId!))
              .limit(1)
          )[0] ?? undefined,
      )
    : undefined;
  // Credit on file is spent before a card, exactly as the customer's Collect payment does.
  // Dynamic import: customers/collect imports invoicing/service, which imports this file.
  const { applyCreditBeforeCharge } = await import("@/modules/customers/collect");
  const credit = await applyCreditBeforeCharge({ organizationId: orgId, businessId, invoice: inv });
  const creditApplied = credit.creditApplied;
  const settledByCredit = credit.settled;
  let payment: Awaited<ReturnType<typeof collectInvoice>> | null = null;
  if (!settledByCredit)
    try {
      payment = await collectInvoice({
        organizationId: orgId,
        businessId,
        invoice: credit.invoice,
        subscription: sub,
        // Every caller of THIS function is a human asking for the charge — the operator's
        // "Collect now" / dunning "Retry now", and the buyer's portal "Pay now". The
        // automatic clock calls `collectInvoice` directly from `runDunningPass`, so this
        // is exactly the manual/automatic boundary. See `collectInvoice.manualAttempt`.
        manualAttempt: true,
        ...(opts.session ? { session: opts.session } : {}),
        ...(opts.returnUrl ? { returnUrl: opts.returnUrl } : {}),
        ...(opts.cancelUrl ? { cancelUrl: opts.cancelUrl } : {}),
        ...(opts.paymentMethodOverrideId
          ? { paymentMethodOverrideId: opts.paymentMethodOverrideId }
          : {}),
      });
    } catch (e) {
      // Surfaced to the operator as a refusal, not a 500: an automated collector is
      // charging this invoice right now, and the honest answer is "try again in a moment"
      // rather than a second charge or a stack trace.
      if (e instanceof CollectionDeferredError) throw new InvoiceOpsError(e.message);
      if (e instanceof CollectionInFlightError) {
        throw new InvoiceOpsError("A collection attempt is already in progress for this invoice");
      }
      throw e;
    }
  const final = await loadInvoice(orgId, businessId, invoicePublicId);
  // P4: audit the OPERATOR-TRIGGERED collection attempt, with its outcome.
  //
  // Deliberately written here, AFTER the attempt, and not inside collectInvoice's
  // transactions — the only place in this sweep that isn't in-tx. `collectInvoice`
  // is shared with the billing clock's dunning pass, so auditing inside it would
  // stamp an audit row on every automated retry and attribute a machine retry to
  // whatever context happened to be ambient. The auditable fact here is "a person
  // pressed Collect", which is complete before the gateway is even called; the
  // money movement itself is already atomic + evented (payment_succeeded /
  // invoice_paid). Worst case on a crash between the two is a missing audit row
  // for an attempt whose outcome the event stream still records — never a row
  // claiming a collection that did not happen.
  const { writeAuditLog } = await import("@/modules/audit/service");
  await writeAuditLog({
    organizationId: orgId,
    businessId,
    action: "invoice.collect",
    resourceType: "invoice",
    resourceId: inv.publicId,
    // The dunning pair is here because `attempt_count` stopped being the field that
    // moves: a manual attempt deliberately holds the counter still (M12), so a "Collect
    // now" that DECLINED changed status/attempt_count/amount by nothing at all and the
    // drill-in showed an operator action with an empty diff. What it really moved is the
    // schedule — dunning armed, next attempt set — which is also the pair
    // `invoice.stop_dunning` / `invoice.pause_dunning` already record, so the Activity
    // Log reads the same way for all three.
    before: {
      status: inv.status,
      attempt_count: inv.attemptCount,
      amount_due_minor: Number(inv.amountDueMinor ?? inv.totalMinor),
      dunning_status: inv.dunningStatus,
      next_attempt_at: inv.nextAttemptAt?.toISOString() ?? null,
    },
    after: {
      status: final.status,
      attempt_count: final.attemptCount,
      amount_due_minor: Number(final.amountDueMinor ?? final.totalMinor),
      dunning_status: final.dunningStatus,
      next_attempt_at: final.nextAttemptAt?.toISOString() ?? null,
      ...(opts.paymentMethodOverrideId ? { payment_method: opts.paymentMethodOverrideId } : {}),
      ...(creditApplied > 0n ? { credit_applied_minor: Number(creditApplied) } : {}),
      ...(opts.comment ? { comment: opts.comment } : {}),
    },
  });
  // The OUTCOME of a human pressing Collect — a refusal here is the most common
  // "why is this still unpaid" question, and the payment id ties it to the gateway log.
  log.info("operator collection attempt completed", {
    event: "invoice_collect_now",
    invoice: inv.publicId,
    fromStatus: inv.status,
    status: final.status,
    amountDueMinor: String(final.amountDueMinor ?? final.totalMinor),
    currency: final.currency,
    payment: payment?.publicId ?? null,
    attempt: final.attemptCount,
  });
  return { invoice: final, payment };
}

/**
 * Record an offline/manual payment (cash, cheque, wire, mark-as-paid) against an
 * invoice. Books cash/AR and marks the invoice paid when the balance is covered.
 *
 * Money received ABOVE the outstanding balance is never applied to the invoice —
 * it lands in the customer's `excess_payment_balance` bucket, exactly as
 * `recordExcessPayment` does for offline excess money, so the next invoice can
 * draw it down. Applying it to the invoice instead (what this did until
 * 2026-08-04) over-credits AR and leaves the payer's money invisible on the
 * customer: INV-2309 collected 2× its total with no credit anywhere.
 * With `excess: refund` that credit is drawn straight back out as an offline refund.
 */
export async function recordOfflinePayment(input: {
  organizationId: string;
  businessId: string;
  invoicePublicId: string;
  amountMinor?: number; // omit → the full outstanding balance
  method?: string; // cash | cheque | wire | other
  /**
   * When the money was received, if not now. The payment row, its transaction, its ledger
   * postings and the invoice's `paid_at` all carry it. Never in the future, never before
   * the invoice was raised.
   */
  occurredAt?: Date;
  /** The payer's reference (cheque number, wire reference) — stored as the transaction's
   *  `id_at_gateway`, as an offline credit-note refund stores its reference. */
  reference?: string;
  /** Operator note; lands on the audit row. */
  comment?: string;
  /**
   * A part payment's shortfall for this call. `write_off` must fit the business limit, else
   * the call is refused; `leave_due` writes nothing off. Omitted = the business rule.
   */
  shortfall?: import("@/modules/subscriptions/collection-rules-config").ShortfallChoice;
  /** Money above the amount due: `credit` (omitted) keeps it, `refund` records it returned. */
  excess?: import("@/modules/payments/application-config").OfflineExcessChoice;
}): Promise<OfflinePaymentResult> {
  const inv = await loadInvoice(input.organizationId, input.businessId, input.invoicePublicId);
  assertNotSettledArchival(inv, "record a payment on");
  if (!isOpenInvoiceStatus(inv.status))
    throw new InvoiceOpsError(`You cannot record a payment on a ${inv.status} invoice`);
  const at = input.occurredAt;
  if (at) {
    if (at.getTime() > stampNow(input.businessId).getTime())
      throw new InvoiceOpsError("Payment date cannot be in the future");
    if (at.getTime() < inv.createdAt.getTime())
      throw new InvoiceOpsError("Payment date cannot be before the invoice date");
  }
  // A live debit would collect on top of this payment: the gateway cancels it, or we refuse.
  const { clearPendingDebits } = await import("@/modules/payments/pending-debit");
  await clearPendingDebits({
    organizationId: input.organizationId,
    businessId: input.businessId,
    invoiceId: inv.id,
    action: "record_payment",
  });
  return withTenant(input.organizationId, (tx) => recordOfflinePaymentInTx(tx, input, inv));
}

export type RecordOfflinePaymentInput = Parameters<typeof recordOfflinePayment>[0];

export interface OfflinePaymentResult {
  invoice: Invoice;
  payment: Payment;
  /** Excess kept as customer credit. */
  excessMinor: number;
  /** Excess recorded as returned to the payer (`excess: refund`). */
  excessRefundedMinor: number;
}

/**
 * The shortfall to write off, decided before anything is written. An explicit `write_off`
 * that the business limit does not allow is refused, never exceeded or dropped.
 */
async function offlineShortfallWriteOff(
  tx: Tx,
  input: RecordOfflinePaymentInput,
  inv: Invoice,
  remainingMinor: bigint,
): Promise<bigint> {
  if (remainingMinor <= 0n || input.shortfall === "leave_due") return 0n;
  const { resolveCollectionRulesConfig, shortfallToWriteOff } =
    await import("@/modules/subscriptions/collection-rules-config");
  const [biz] = await tx
    .select({ billingRulesConfig: businesses.billingRulesConfig })
    .from(businesses)
    .where(eq(businesses.id, input.businessId))
    .limit(1);
  const w = shortfallToWriteOff(resolveCollectionRulesConfig(biz), inv, remainingMinor);
  if (input.shortfall === "write_off" && w === 0n)
    throw new InvoiceOpsError(
      `We could not write off the shortfall of ${formatMoney(remainingMinor, inv.currency)}. It is more than the write-off limit of this business, or the invoice is a credit purchase. Send shortfall=leave_due to leave it due.`,
    );
  return w;
}

/**
 * `recordOfflinePayment` inside the caller's transaction, for an invoice it has just raised
 * (a manual paid credit grant marked paid). Pending gateway debits are not cleared here.
 */
export async function recordOfflinePaymentInTx(
  tx: Tx,
  input: RecordOfflinePaymentInput,
  inv: Invoice,
): Promise<OfflinePaymentResult> {
  const at = input.occurredAt;
  const { assertNoPendingDebit } = await import("@/modules/payments/pending-debit");
  // Lock the invoice row for the read-then-write: two operators recording a
  // payment at the same instant must not both see the same outstanding balance
  // and both apply it (the second would silently become an overpayment).
  const [locked] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.id, inv.id))
    .for("update")
    .limit(1);
  const current = locked ?? inv;
  if (!isOpenInvoiceStatus(current.status))
    throw new InvoiceOpsError(`You cannot record a payment on a ${current.status} invoice`);
  await assertNoPendingDebit(tx, current, "record_payment");

  const { remainingMinor: due } = await invoiceOutstanding(tx, current);
  if (due <= 0n)
    throw new InvoiceOpsError(
      "The invoice has no outstanding balance. Record the money as an excess payment on the customer instead.",
    );
  const amount = input.amountMinor != null ? BigInt(input.amountMinor) : due;
  if (amount <= 0n) throw new InvoiceOpsError("Payment amount must be positive");
  // Split: what the invoice can absorb vs what becomes customer credit.
  const applied = amount > due ? due : amount;
  const excess = amount - applied;
  // 2.12: before any write, so a refused write-off books nothing.
  const writeOff = await offlineShortfallWriteOff(tx, input, current, due - applied);
  const excessRefunded = input.excess === "refund" ? excess : 0n;

  const [pay] = await tx
    .insert(payments)
    .values({
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: inv.customerId,
      invoiceId: inv.id,
      paymentMethodId: null,
      publicId: publicId("pay"),
      status: "succeeded",
      // The invoice-scoped payment is the APPLIED part only — `paidTotals` sums
      // this column into the invoice's amount_paid, which must never exceed what
      // the invoice was for. The excess is booked against the customer below.
      amountMinor: applied,
      currency: inv.currency,
      providerKey: "offline",
      providerChargeId: input.method ?? "offline",
      ...(at ? { createdAt: at } : {}),
    })
    .returning();
  await postEntries(
    {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: pay!.customerId,
      sourceType: "payment",
      sourceId: pay!.publicId,
      occurredAt: at,
      lines: [
        { account: "cash", direction: "debit", amountMinor: applied, currency: inv.currency },
        {
          account: "accounts_receivable",
          direction: "credit",
          amountMinor: applied,
          currency: inv.currency,
        },
      ],
    },
    tx,
  );

  if (excess > 0n) {
    // Same posting as `recordExcessPayment` (cash → excess_payment_balance,
    // customer-dimensioned so the bucket read picks it up), sourced to this
    // payment so the credit is traceable back to the overpayment that made it.
    await postEntries(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: inv.customerId,
        sourceType: "excess_payment",
        sourceId: pay!.publicId,
        occurredAt: at,
        lines: [
          {
            account: "cash",
            direction: "debit",
            amountMinor: excess,
            currency: inv.currency,
            memo: `Excess payment on ${inv.publicId}`,
          },
          {
            account: EXCESS_PAYMENT,
            direction: "credit",
            amountMinor: excess,
            currency: inv.currency,
            memo: `Excess payment on ${inv.publicId}`,
          },
        ],
      },
      tx,
    );
  }
  // Mirror the offline REFUND path (credit-notes/service.ts), which already
  // records a transaction with `gateway_key: offline_<method>`. Without this,
  // `transactions` — the money log the UI and reconciliation read — silently
  // omitted every offline payment, so an invoice paid by cash looked unpaid on
  // the "Payments and credits" timeline while the ledger said otherwise.
  await recordTransaction(
    {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: inv.customerId,
      type: "payment",
      status: "succeeded",
      // The full cash received, applied part + excess — this is the money log, and
      // the money log must equal what actually arrived. The ledger holds the split.
      amountMinor: amount,
      currency: inv.currency,
      gatewayKey: `offline_${input.method ?? "other"}`,
      idAtGateway: input.reference ?? null,
      invoiceId: inv.id,
      paymentId: pay!.id,
      occurredAt: at,
    },
    tx,
  );
  if (excessRefunded > 0n) {
    // Returned to the payer at once: drawn back off the credit it just made. Sourced as this
    // payment's refund draw (`excess_refund_reserve`), so `excessHeldByPayment` and
    // `nonCardHeld` see it net to zero.
    const memo = `Excess on ${inv.publicId} returned (${input.method ?? "other"})`;
    await postEntries(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: inv.customerId,
        sourceType: "excess_refund_reserve",
        sourceId: pay!.publicId,
        occurredAt: at,
        lines: [
          {
            account: EXCESS_PAYMENT,
            direction: "debit",
            amountMinor: excessRefunded,
            currency: inv.currency,
            memo,
          },
          {
            account: "cash",
            direction: "credit",
            amountMinor: excessRefunded,
            currency: inv.currency,
            memo,
          },
        ],
      },
      tx,
    );
    await recordTransaction(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: inv.customerId,
        type: "refund",
        status: "succeeded",
        amountMinor: excessRefunded,
        currency: inv.currency,
        gatewayKey: `offline_${input.method ?? "other"}`,
        idAtGateway: input.reference ?? null,
        invoiceId: inv.id,
        paymentId: pay!.id,
        occurredAt: at,
      },
      tx,
    );
  }
  /**
   * `payment_succeeded`, FOR AN OFFLINE PAYMENT TOO (2026-09-02).
   *
   * `recordTransaction` above emits `payment_initiated` carrying `status: "succeeded"`, and for
   * a long time that was the ONLY payment-shaped event a cash, cheque or bank-transfer
   * settlement produced — `payment_succeeded` existed solely on the gateway paths
   * (`payment-intents/service.ts`, `invoicing/service.ts`). So a webhook consumer keyed on
   * `payment_succeeded` — the obvious choice — never learned that an offline invoice had
   * been paid. `invoice_paid` did fire, so a consumer keyed on the
   * INVOICE was always correct; the gap was specific and quiet.
   *
   * ADDITIVE ON PURPOSE, decided by our user with the risk stated: nothing that fired before
   * stops firing, and outbound delivery is per subscribed event type, so this reaches exactly
   * the consumers already asking for `payment_succeeded`. The `offline: true` marker rides
   * along — the same one `invoice_paid` carries below — so a subscriber that must distinguish
   * cash from a gateway capture still can, rather than having to infer it from the absence of
   * a gateway reference.
   */
  await emitEvent(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    type: "payment_succeeded",
    data: buildEventData(
      "payment_succeeded",
      {
        id: pay!.publicId,
        status: "succeeded",
        /**
         * THE FULL CASH RECEIVED, not `pay.amountMinor` — which is deliberately the APPLIED
         * part only, so an invoice's `amount_paid` can never exceed what it was for. On an
         * OVERPAYMENT those differ, and a payment event that reports the applied part
         * understates the money that actually arrived: with ₹12,759.24 received against a
         * ₹10,759.24 invoice, the first cut of this event reported 1075924 instead of
         * 1275924 — the ₹2,000 of excess simply missing. `recordTransaction` above already uses `amount` for the same reason: the
         * money log must equal what arrived, and the ledger holds the applied/excess split.
         */
        amount_minor: Number(amount),
        currency: inv.currency,
        invoice: inv.publicId,
      },
      null,
      { offline: true },
    ),
  });
  const covered = applied >= due;
  // A partial payment leaves the invoice open — nothing to update (an empty
  // .set() would throw), the AR ledger already reflects the part-payment.
  let updated = current;
  if (covered) {
    const [row] = await tx
      .update(invoices)
      .set({
        status: "paid",
        paidAt: at ?? stampNow(),
        nextAttemptAt: null,
        ...dunningFieldsOnSettle(inv),
      })
      .where(eq(invoices.id, inv.id))
      .returning();
    updated = row ?? current;
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "invoice_paid",
      data: buildEventData(
        "invoice_paid",
        { id: inv.publicId, amount_minor: Number(inv.totalMinor), currency: inv.currency },
        null,
        { offline: true },
      ),
    });
    await activatePaidCreditGrants(tx, { organizationId: input.organizationId, invoiceId: inv.id });
  }
  // 2.12: a shortfall within the business's tolerance is written off and the invoice is paid.
  const writtenOffMinor = covered ? 0n : writeOff;
  if (!covered) {
    if (writtenOffMinor > 0n) {
      const { issueAdjustmentCreditNote } = await import("@/modules/credit-notes/service");
      await issueAdjustmentCreditNote({
        organizationId: input.organizationId,
        businessId: input.businessId,
        invoicePublicId: inv.publicId,
        items: [
          { description: "Payment shortfall written off", amountMinor: Number(writtenOffMinor) },
        ],
        reasonCode: "payment_shortfall",
        reason: "Shortfall within the partial-payment tolerance",
        tx,
      });
      const [row] = await tx.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1);
      updated = row ?? updated;
      if (updated.status === "paid")
        await activatePaidCreditGrants(tx, {
          organizationId: input.organizationId,
          invoiceId: inv.id,
        });
    }
  }
  const excessCredited = excess - excessRefunded;
  if (excessCredited > 0n) {
    // Same event the customer-level "record excess payment" emits, so webhook
    // consumers and the customer timeline see the credit however it arose.
    const [cus] = await tx
      .select({ publicId: customers.publicId })
      .from(customers)
      .where(eq(customers.id, inv.customerId))
      .limit(1);
    const balance = await bucketBalance(tx, inv.customerId, EXCESS_PAYMENT, inv.currency);
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "customer_excess_payment_recorded",
      data: buildEventData("customer_excess_payment_recorded", {
        id: cus?.publicId ?? inv.customerId,
        amount_minor: Number(excessCredited),
        currency: inv.currency,
        balance_minor: Number(balance),
        description: `Excess payment on ${inv.publicId}`,
      }),
    });
  }
  // P4: an offline payment is asserted by a human — no gateway ever confirmed it —
  // so "who marked this paid, from where, and for how much" is the single most
  // valuable audit row on an invoice. Same tx as the payment + ledger postings.
  const { writeAuditLog } = await import("@/modules/audit/service");
  await writeAuditLog(
    {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: "invoice.record_payment",
      resourceType: "invoice",
      resourceId: inv.publicId,
      before: { status: current.status, amount_due_minor: Number(due) },
      after: {
        status: updated.status,
        amount_due_minor: Number(due - applied),
        payment: pay!.publicId,
        paid_minor: Number(applied),
        // What the operator handed over vs what the invoice took — the gap is the
        // customer credit, and that is exactly the fact an auditor needs.
        received_minor: Number(amount),
        excess_credited_minor: Number(excessCredited),
        ...(excessRefunded > 0n ? { excess_refunded_minor: Number(excessRefunded) } : {}),
        ...(writtenOffMinor > 0n ? { shortfall_written_off_minor: Number(writtenOffMinor) } : {}),
        method: input.method ?? "other",
        ...(at ? { date: at.toISOString() } : {}),
        ...(input.reference ? { reference: input.reference } : {}),
        ...(input.comment ? { comment: input.comment } : {}),
      },
    },
    tx,
  );
  // Asserted by a human — no gateway ever confirmed it — so this is the line you
  // want when the books and the bank statement disagree.
  log.info("offline payment recorded", {
    event: "invoice_offline_payment",
    invoice: inv.publicId,
    payment: pay!.publicId,
    receivedMinor: String(amount),
    appliedMinor: String(applied),
    excessCreditedMinor: String(excessCredited),
    excessRefundedMinor: String(excessRefunded),
    currency: inv.currency,
    method: input.method ?? "other",
    status: updated.status,
  });
  return {
    invoice: updated,
    payment: pay!,
    excessMinor: Number(excessCredited),
    excessRefundedMinor: Number(excessRefunded),
  };
}

/**
 * EXPLICIT apply-credits — draw a customer's post-tax credit onto ONE named invoice
 * because an operator said so. Applying credits and applying payments are collapsed
 * into one action because our credit is held in BUCKETS (refundable / excess) rather
 * than as documents and transactions.
 *
 * ── Why this had to exist the moment Credits Flexibility shipped (0219) ───────
 * `planCreditApplication` and `collectPayment` now both obey the business's
 * Credits Flexibility grid, so a merchant who selects "Do not auto-apply" gets exactly
 * what they asked for: nothing draws the bucket on its own. Without this endpoint that
 * merchant had no way to apply credit AT ALL — the setting did not defer automatic
 * application, it abolished application — shipping the switch without an explicit action
 * left customers holding credit the merchant could not spend for them.
 *
 * ── DECISION: an explicit apply IGNORES the Credits Flexibility ceilings ──────
 * Both levels of them — the site grid (`businesses.credits_flexibility`) and the
 * per-subscription maxima (`max_refundable_credits_usage_minor` /
 * `max_excess_payment_usage_minor`) — are not consulted here, and that is deliberate.
 *
 * The grid's own vocabulary settles it: every mode is phrased about AUTO-application
 * ("Do not auto-apply", "Auto-apply", "Auto-apply up to a limit"), and the subscription
 * fields are the maximum up to which refundable credits / excess payments can be
 * **auto-applied**. A ceiling on automatic behaviour is a statement about what the
 * ENGINE may decide unprompted; it is not a statement that the money is unspendable. The
 * operator invoking this route IS the decision the ceiling exists to defer to, so honouring
 * it here would mean a merchant who set "do not auto-apply" could never apply credit by any
 * route — the switch would read as "freeze this customer's credit forever", which is not
 * what any of the three modes say.
 *
 * The mirror-image argument is why `collectPayment` DOES obey them (see the long note in
 * `customers/collect.ts`): there the caller says "settle these invoices" and the engine
 * still picks which buckets to spend, so it is auto-application wearing an operator's hat.
 * Here the caller names the invoice, and may name the exact amount per bucket. The line
 * between the two is who chose the money, and it is drawn on that.
 *
 * What is NOT waived, because none of it is a preference:
 *   · the invoice's own outstanding balance — credit can never over-apply AR;
 *   · the bucket balance — we cannot spend money the customer does not have;
 *   · the currency — buckets are per (customer, currency), read in the invoice's;
 *   · the invoice being open and finalized — `pending` is not yet a claim, `paid` /
 *     `voided` have nothing to absorb;
 *   · tenancy (`withTenant` + RLS) and the customer advisory lock.
 *
 * ── PROMOTIONAL CREDIT IS NOT REACHABLE HERE, and cannot be ──────────────────
 * Promotional credit is applied PRE-tax: it reduces the taxable base, so applying it
 * changes the invoice's tax and its total, not just what is left to collect. That can only
 * be done while the invoice is being computed. A post-issue "apply promotional credit"
 * would either silently mis-state tax or require re-cutting a finalized document. The
 * route refuses the field rather than accepting it and quietly applying it post-tax.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * The route carries the standard `Idempotency-Key` preHandler, so a retried POST replays
 * the stored response instead of drawing the bucket twice. Inside, the read-modify-write
 * runs under `lockCustomerBalances` + a `FOR UPDATE` on the invoice row — the pair
 * `collectPayment` had to learn the hard way (`verify:concurrent-credit-apply`): the
 * advisory lock alone protects the BUCKET, not the invoice's applied-credit columns, and
 * two concurrent appliers deriving from one stale snapshot lose the customer's money in
 * the worst direction (ledger says spent, invoice still says due).
 */
export async function applyCreditsToInvoice(input: {
  organizationId: string;
  businessId: string;
  invoicePublicId: string;
  /** Exact refundable credit to apply. Omit → as much as the invoice and bucket allow. */
  refundableMinor?: number;
  /** Exact excess payment credit to apply. Omit → as much as the invoice and bucket allow. */
  excessMinor?: number;
  /** Overall cap across both buckets, for the "apply up to this much" shape. Cannot be
   *  combined with a per-bucket amount — the two would express the same budget twice and
   *  disagree silently. */
  amountMinor?: number;
  /** Free-text operator note; lands on the audit row. */
  comment?: string;
  /**
   * Draw ONLY from these refundable credit notes (`cn_…`), in this order. Each must be
   * this customer's, in the invoice's currency, not voided, with credit left. Excess
   * payments are not drawn. Combines with `amountMinor` as a cap; not with the
   * per-bucket amounts.
   */
  creditNotePublicIds?: string[];
}): Promise<{
  invoice: Invoice;
  appliedRefundableMinor: bigint;
  appliedExcessMinor: bigint;
  /** The customer's remaining buckets in the invoice's currency, after the draw. */
  balanceAfter: { refundable: bigint; excess: bigint };
}> {
  const explicitBucket = input.refundableMinor != null || input.excessMinor != null;
  if (input.amountMinor != null && explicitBucket)
    throw new InvoiceOpsError("Pass amount_minor OR per-bucket amounts, not both");
  for (const [name, v] of [
    ["refundable_minor", input.refundableMinor],
    ["excess_minor", input.excessMinor],
    ["amount_minor", input.amountMinor],
  ] as const) {
    if (v != null && (!Number.isSafeInteger(v) || v < 0))
      throw new InvoiceOpsError(`${name} must be an integer of minor units, 0 or more`);
  }
  if (input.amountMinor != null && input.amountMinor === 0)
    throw new InvoiceOpsError("amount_minor must be positive");
  if (explicitBucket && (input.refundableMinor ?? 0) + (input.excessMinor ?? 0) === 0)
    throw new InvoiceOpsError(
      "The request asks for no credit. refundable_minor and excess_minor are both 0.",
    );
  const chosenNotes = input.creditNotePublicIds;
  if (chosenNotes) {
    if (explicitBucket)
      throw new InvoiceOpsError("Pass credit_notes OR per-bucket amounts, not both");
    if (chosenNotes.length === 0) throw new InvoiceOpsError("credit_notes cannot be empty");
    if (new Set(chosenNotes).size !== chosenNotes.length)
      throw new InvoiceOpsError("credit_notes lists the same credit note twice");
  }

  let inv = await loadInvoice(input.organizationId, input.businessId, input.invoicePublicId);
  assertNotSettledArchival(inv, "apply credits to");
  if (!isOpenInvoiceStatus(inv.status))
    throw new InvoiceOpsError(`You cannot apply credits to a ${inv.status} invoice`);

  // A live debit would collect on top of the credit: the gateway cancels it, or we refuse.
  // The credit is checked first, so a request that cannot apply never cancels a debit.
  const pendingDebit = await import("@/modules/payments/pending-debit");
  if (await pendingDebit.hasPendingDebit(input.organizationId, input.businessId, inv.id)) {
    const bals = await withTenant(input.organizationId, (tx) =>
      bucketBalancesForCurrency(input.organizationId, inv.customerId, inv.currency, tx),
    );
    if (!chosenNotes && bals.refundable + bals.excess <= 0n)
      throw new InvoiceOpsError(
        `This customer has no refundable or excess credit in ${inv.currency}`,
      );
    if ((input.refundableMinor ?? 0) > Number(bals.refundable))
      throw new InvoiceOpsError(
        `Only ${bals.refundable} minor units of refundable credit are available in ${inv.currency}`,
      );
    if ((input.excessMinor ?? 0) > Number(bals.excess))
      throw new InvoiceOpsError(
        `Only ${bals.excess} minor units of excess payment credit are available in ${inv.currency}`,
      );
    const cleared = await pendingDebit.clearPendingDebits({
      organizationId: input.organizationId,
      businessId: input.businessId,
      invoiceId: inv.id,
      action: "apply_credits",
    });
    if (cleared.settled > 0) {
      inv = await loadInvoice(input.organizationId, input.businessId, input.invoicePublicId);
      if (!isOpenInvoiceStatus(inv.status))
        throw new InvoiceOpsError(`You cannot apply credits to a ${inv.status} invoice`);
    }
  }

  const result = await withTenant(input.organizationId, async (tx) => {
    // BOTH locks, in this order. The advisory lock serializes every read-then-draw of
    // this customer's buckets; the row lock makes the invoice's own applied-credit
    // columns safe to derive from. Taking only the first is the lost update that
    // `verify:concurrent-credit-apply` reproduces.
    await lockCustomerBalances(tx, inv.customerId);
    const [locked] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, inv.id))
      .for("update")
      .limit(1);
    const current = locked ?? inv;
    if (!isOpenInvoiceStatus(current.status))
      throw new InvoiceOpsError(`You cannot apply credits to a ${current.status} invoice`);
    await pendingDebit.assertNoPendingDebit(tx, current, "apply_credits");

    const { remainingMinor: due } = await invoiceOutstanding(tx, current);
    if (due <= 0n)
      throw new InvoiceOpsError(
        "The invoice has no outstanding balance. There is nothing to apply credit to.",
      );

    const bals = await bucketBalancesForCurrency(
      input.organizationId,
      inv.customerId,
      current.currency,
      tx,
    );
    const budget =
      input.amountMinor != null && BigInt(input.amountMinor) < due
        ? BigInt(input.amountMinor)
        : due;

    // An EXPLICIT amount that does not fit is refused, never clamped. The operator named a
    // figure; applying a smaller one and reporting success is the kind of quiet
    // half-execution this codebase treats as worse than an error.
    let refundable: bigint;
    let excess: bigint;
    let chosenNoteIds: string[] | undefined;
    if (chosenNotes) {
      const { creditNoteSpendable } = await import("@/modules/credit-notes/serialize");
      const rows = await tx
        .select()
        .from(creditNotes)
        .where(
          and(
            eq(creditNotes.businessId, input.businessId),
            inArray(creditNotes.publicId, chosenNotes),
          ),
        )
        .for("update");
      const byId = new Map(rows.map((r) => [r.publicId, r]));
      let available = 0n;
      chosenNoteIds = [];
      for (const pid of chosenNotes) {
        const cn = byId.get(pid);
        if (!cn || cn.customerId !== inv.customerId)
          throw new InvoiceOpsError(`We could not find the credit note ${pid} for this customer.`);
        if (cn.kind !== "refundable")
          throw new InvoiceOpsError(`Credit note ${pid} is an adjustment note and holds no credit`);
        if (cn.status === "voided") throw new InvoiceOpsError(`Credit note ${pid} is voided`);
        if (cn.currency !== current.currency)
          throw new InvoiceOpsError(
            `Credit note ${pid} is in ${cn.currency}, not the invoice currency ${current.currency}`,
          );
        const avail = creditNoteSpendable(cn);
        if (avail <= 0n) throw new InvoiceOpsError(`Credit note ${pid} has no credit left`);
        available += avail;
        chosenNoteIds.push(cn.id);
      }
      // The ledger bucket is the spendable truth; the notes only say which to draw.
      if (bals.refundable < available) available = bals.refundable;
      refundable = available < budget ? available : budget;
      excess = 0n;
    } else if (explicitBucket) {
      refundable = BigInt(input.refundableMinor ?? 0);
      excess = BigInt(input.excessMinor ?? 0);
      if (refundable > bals.refundable)
        throw new InvoiceOpsError(
          `Only ${bals.refundable} minor units of refundable credit are available in ${current.currency}`,
        );
      if (excess > bals.excess)
        throw new InvoiceOpsError(
          `Only ${bals.excess} minor units of excess payment credit are available in ${current.currency}`,
        );
      if (refundable + excess > due)
        throw new InvoiceOpsError(
          `Requested ${refundable + excess} exceeds the invoice's outstanding balance of ${due}`,
        );
    } else {
      // Refundable first, then excess — the same order the invoicing and collection paths
      // apply, so "which bucket paid this" does not depend on which route drew it.
      refundable = bals.refundable < budget ? bals.refundable : budget;
      excess = bals.excess < budget - refundable ? bals.excess : budget - refundable;
    }
    const total = refundable + excess;
    if (total <= 0n)
      throw new InvoiceOpsError(
        `This customer has no refundable or excess credit in ${current.currency}`,
      );

    await postCreditApplications(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: inv.customerId,
      invoicePublicId: current.publicId,
      currency: current.currency,
      promotional: 0n,
      refundable,
      excess,
    });
    if (refundable > 0n) {
      // Provenance: attribute the draw to the funding credit notes FIFO, exactly as
      // invoice generation does — otherwise a note stays `refund_due` while its money has
      // already been spent on an invoice. Dynamic import because credit-notes/service
      // pulls in customers/balances' writers, and this file is reached from the event
      // snapshot path (see the balances-read note at the top).
      //
      // `suppressBalanceInvoiceEvents` because we emit `customer_changed` and
      // `invoice_updated` ONCE below, for the whole application. Letting the allocator
      // emit them would fire them only when the draw happened to land on a credit note
      // and never for an excess-only apply — the same event depending on which bucket
      // paid.
      const { allocateRefundableDraw } = await import("@/modules/credit-notes/service");
      await allocateRefundableDraw(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: inv.customerId,
        invoiceId: current.id,
        invoicePublicId: current.publicId,
        currency: current.currency,
        drawMinor: refundable,
        suppressBalanceInvoiceEvents: true,
        ...(chosenNoteIds ? { creditNoteIds: chosenNoteIds } : {}),
      });
    }

    // `amount_due_minor` is the issue-time collectible NET OF CREDITS ONLY — cash is
    // subtracted at serialization — so it moves by the credit applied, while "is it
    // settled" is judged against `due`, which is net of cash too.
    const stored = (current.amountDueMinor ?? current.totalMinor) - total;
    const settled = due - total <= 0n;
    const [updated] = await tx
      .update(invoices)
      .set({
        amountDueMinor: stored,
        refundableCreditsAppliedMinor: (current.refundableCreditsAppliedMinor ?? 0n) + refundable,
        excessPaymentsAppliedMinor: (current.excessPaymentsAppliedMinor ?? 0n) + excess,
        ...(settled
          ? {
              status: "paid" as const,
              paidAt: stampNow(),
              nextAttemptAt: null,
              // NOT `dunningFieldsOnSettle`: no cash arrived. The chase STOPPED, it did
              // not succeed — `dunning_status: stopped` is what an invoice taken to zero
              // without a payment reports (see status.ts).
              ...dunningFieldsOnCreditSettle(current),
            }
          : {}),
      })
      .where(eq(invoices.id, current.id))
      .returning();

    if (settled) {
      await emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "invoice_paid",
        data: buildEventData(
          "invoice_paid",
          {
            id: current.publicId,
            amount_minor: Number(current.totalMinor),
            currency: current.currency,
          },
          null,
          { paid_with_credit: true },
        ),
      });
      await activatePaidCreditGrants(tx, {
        organizationId: input.organizationId,
        invoiceId: current.id,
      });
    }
    // An invoice that gained applied credits is an `invoice_updated`, and the customer's
    // available balance moved, so `customer_changed` too. Once each, whichever bucket paid.
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "invoice_updated",
      data: buildEventData("invoice_updated", { id: current.publicId }),
    });
    const { emitCustomerChanged } = await import("@/modules/customers/balances");
    await emitCustomerChanged(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: inv.customerId,
    });

    const after = await bucketBalancesForCurrency(
      input.organizationId,
      inv.customerId,
      current.currency,
      tx,
    );
    // A human moved the customer's money onto a specific invoice, overriding a setting
    // that says the engine may not do it unasked — which makes "who, how much, from which
    // bucket, and did the ceiling apply" exactly the row an auditor will come looking for.
    const { writeAuditLog } = await import("@/modules/audit/service");
    await writeAuditLog(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        action: "invoice.apply_credits",
        resourceType: "invoice",
        resourceId: current.publicId,
        before: { status: current.status, amount_due_minor: Number(due) },
        after: {
          status: (updated ?? current).status,
          amount_due_minor: Number(due - total),
          refundable_applied_minor: Number(refundable),
          excess_applied_minor: Number(excess),
          currency: current.currency,
          explicit: true,
          comment: input.comment ?? null,
          ...(chosenNotes ? { credit_notes: chosenNotes } : {}),
        },
      },
      tx,
    );
    return {
      invoice: updated ?? current,
      appliedRefundableMinor: refundable,
      appliedExcessMinor: excess,
      balanceAfter: { refundable: after.refundable, excess: after.excess },
    };
  });
  log.info("credit applied to an invoice on an operator's instruction", {
    event: "invoice_apply_credits",
    invoice: input.invoicePublicId,
    refundableMinor: String(result.appliedRefundableMinor),
    excessMinor: String(result.appliedExcessMinor),
    currency: result.invoice.currency,
    status: result.invoice.status,
  });
  return result;
}

/**
 * Render a rich, print-friendly HTML invoice from the SAME assembled document
 * that feeds the PDF renderer — the two views mirror each other section-for-
 * section and can never drift. Inline CSS + `@media print` so it prints cleanly.
 *
 * `opts.print` adds the viewer chrome the dashboard's "View / print" action wants:
 * the document sits on an A4 sheet over a grey backdrop,
 * a screen-only toolbar carries the Print button, and the browser print dialog opens
 * on load. Every rule it adds is `@media screen`, and the sheet's geometry is the
 * same portrait A4 + 12mm the shared `@page` rule prints — so the preview is
 * WYSIWYG and both views put exactly the same ink on paper.
 */
export async function renderInvoiceHtml(
  orgId: string,
  businessId: string,
  invoicePublicId: string,
  opts: { print?: boolean } = {},
): Promise<string | null> {
  const { assembleInvoiceDocument, formatMoney, formatDateInTz, formatDateTimeInTz, lineFigures } =
    await import("./document");
  const doc = await assembleInvoiceDocument(orgId, businessId, invoicePublicId);
  if (!doc) return null;

  const cur = doc.totals.currency;
  const tz = doc.seller.timezone;
  const money = (m: bigint) => formatMoney(m, cur);
  const fmtDate = (d: Date | null) => formatDateInTz(d, tz);
  const esc = escapeHtml;

  const statusChip = (status: string): { label: string; cls: string } => {
    switch (status) {
      case "paid":
        return { label: "PAID", cls: "ok" };
      case "voided":
        return { label: "VOID", cls: "muted" };
      case "pending":
        return { label: "PENDING", cls: "warn" };
      default:
        return { label: "NOT PAID", cls: "due" };
    }
  };
  // Null status draws no chip at all — an empty coloured badge reads as a fault.
  const chip = doc.meta.status ? statusChip(doc.meta.status) : null;

  const sellerLines = doc.seller.addressLines.map((l) => `<div>${esc(l)}</div>`).join("");
  const billLines = doc.billTo.addressLines.map((l) => `<div>${esc(l)}</div>`).join("");
  // SHIPPED TO, under the bill-to block — the same placement as the PDF, so the two
  // outputs can be diffed against each other.
  const shipBlock =
    doc.shipTo.name || doc.shipTo.addressLines.length
      ? `<div class="shipto">
        <div class="label">Shipped To</div>
        ${doc.shipTo.name ? `<div class="name">${esc(doc.shipTo.name)}</div>` : ""}
        <div class="addr">${doc.shipTo.addressLines.map((l) => `<div>${esc(l)}</div>`).join("")}</div>
      </div>`
      : "";
  // At most three rows (capped by the assembler).
  const customFieldsBlock = doc.customFields.length
    ? `<div class="customfields">${doc.customFields
        .map((f) => `<div class="kv"><span>${esc(f.label)}</span><b>${esc(f.value)}</b></div>`)
        .join("")}</div>`
    : "";
  /**
   * Signature. The image is referenced by URL and rendered by the BROWSER here, where the
   * PDF path fetches and embeds it — so a format pdfkit cannot embed (a WEBP, say) shows
   * in the HTML view and not in the PDF. Stated because it is a real asymmetry, and the
   * settings screen names PNG/JPEG for that reason.
   */
  const instructionsBlock = doc.paymentInstructions.length
    ? doc.paymentInstructions
        .map(
          (pi) => `<div class="payinstr">
        <div class="label">${esc(pi.title)}</div>
        ${pi.description ? `<div class="desc">${esc(pi.description)}</div>` : ""}
        ${pi.fields.map((f) => `<div class="kv"><span>${esc(f.label)}</span><b>${esc(f.value)}</b></div>`).join("")}
      </div>`,
        )
        .join("")
    : "";
  // The corner is the merchant's choice. The HTML view is a flowing page rather than a
  // fixed A4 sheet, so "bottom" here means "after the content" — the SIDE is what carries
  // over from the PDF, and that is the part a reader recognises.
  const signatureBlock = doc.signature
    ? `<div class="signature signature--${doc.signature.position === "bottom_left" ? "left" : "right"}">
        ${doc.signature.imageUrl ? `<img class="sigimg" src="${esc(doc.signature.imageUrl)}" alt=""/>` : ""}
        ${doc.signature.caption ? `<div class="sigcap">${esc(doc.signature.caption)}</div>` : ""}
      </div>`
    : "";

  const headerLeft = doc.seller.logoUrl
    ? `<img class="logo" src="${esc(doc.seller.logoUrl)}" alt="${esc(doc.seller.name)}"/>`
    : `<h1>${esc(doc.seller.name)}</h1>`;

  const metaRows = [
    `<tr><th>Invoice #</th><td>${esc(doc.meta.number)}</td></tr>`,
    `<tr><th>Invoice Date</th><td>${fmtDate(doc.meta.issuedDate)}</td></tr>`,
    `<tr><th>Invoice Amount</th><td>${money(doc.totals.totalMinor)}</td></tr>`,
    doc.billTo.id ? `<tr><th>Customer ID</th><td>${esc(doc.billTo.id)}</td></tr>` : "",
    doc.meta.creditNoteNumbers.length
      ? `<tr><th>Credit Note</th><td>${esc(doc.meta.creditNoteNumbers.join(", "))}</td></tr>`
      : "",
    doc.meta.exchangeRate
      ? `<tr><th>Exchange Rate</th><td>${esc(`1 ${doc.meta.exchangeRate.base} = ${doc.meta.exchangeRate.rate} ${doc.meta.exchangeRate.currency}`)}</td></tr>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  // Same rule as the PDF: a band whose every row is toggled off is dropped rather than
  // drawn as a lone "Subscription" heading.
  const subHasContent =
    !!doc.subscription &&
    (!!doc.subscription.id ||
      (!!doc.subscription.periodStart && !!doc.subscription.periodEnd) ||
      !!doc.subscription.nextBillingDate);
  const subBlock =
    doc.subscription && subHasContent
      ? `<div class="sub">
        <div class="label">Subscription</div>
        ${doc.subscription.id ? `<div class="kv"><span>ID</span><b>${esc(doc.subscription.id)}</b></div>` : ""}
        ${doc.subscription.periodStart && doc.subscription.periodEnd ? `<div class="kv"><span>Billing Period</span><b>${fmtDate(doc.subscription.periodStart)} to ${fmtDate(doc.subscription.periodEnd)}</b></div>` : ""}
        ${doc.subscription.nextBillingDate ? `<div class="kv"><span>Next Billing Date</span><b>${fmtDate(doc.subscription.nextBillingDate)}</b></div>` : ""}
      </div>`
      : "<div></div>";

  // Per-line discount column only when some line has one — an undiscounted invoice
  // renders exactly as before (0169). Amount stays GROSS with the discount alongside,
  // so `Σ amount − item-level discounts = Sub Total` stays checkable on the page.
  const anyLineDiscount = doc.chargeLines.some((l) => l.discountMinor !== 0n);
  // HSN/SAC column on the same terms as the discount column: only when some line carries
  // one, so a non-India invoice is byte-identical to what it rendered before. Placed
  // immediately after the description because that is where a GST invoice puts it — the
  // code qualifies the supply, it is not a number in the money columns.
  const anyTaxCode = doc.chargeLines.some((l) => !!l.taxCode);
  const lineRows = doc.chargeLines
    .map((l) => {
      const cells = [`<td>${esc(l.description)}</td>`];
      if (anyTaxCode) cells.push(`<td>${l.taxCode ? esc(l.taxCode) : "—"}</td>`);
      // UNCONDITIONAL, unlike HSN/SAC and Discount — see the same decision and its
      // reasoning in invoice-pdf.ts. `5 × ₹940.00 = ₹4,700.00` is what makes a line
      // legible, and the figures were in the model all along.
      const fig = lineFigures(l, cur);
      cells.push(`<td class="num">${esc(fig.quantity)}</td>`);
      cells.push(`<td class="num">${esc(fig.unitPrice)}</td>`);
      if (anyLineDiscount)
        cells.push(
          `<td class="num">${l.discountMinor === 0n ? "—" : money(-l.discountMinor)}</td>`,
        );
      // NET of the item-level stage, matching the PDF — see the same line
      // in invoice-pdf.ts. The document-level stage stays in the summary below.
      cells.push(`<td class="num">${money(l.amountMinor - l.itemLevelDiscountMinor)}</td>`);
      return `<tr>${cells.join("")}</tr>`;
    })
    .join("");

  const t = doc.totals;
  const sumRows: string[] = [
    `<tr><td>Sub Total</td><td class="num">${money(t.subtotalMinor)}</td></tr>`,
  ];
  for (const d of doc.discountLines)
    sumRows.push(
      `<tr class="muted"><td>${esc(d.description || "Discount")}</td><td class="num">${money(d.amountMinor < 0n ? d.amountMinor : -d.amountMinor)}</td></tr>`,
    );
  for (const tx of doc.taxLines)
    sumRows.push(
      `<tr><td>${esc(tx.label || "Tax")}</td><td class="num">${money(tx.amountMinor)}</td></tr>`,
    );
  if (t.roundingMinor !== 0n)
    sumRows.push(`<tr><td>Rounding</td><td class="num">${money(t.roundingMinor)}</td></tr>`);
  // Total is the gross face amount (withholding is NOT netted out of it — service.ts);
  // withholding is a deduction shown below Total, toward the amount due.
  sumRows.push(`<tr class="grand"><td>Total</td><td class="num">${money(t.totalMinor)}</td></tr>`);
  if (t.withholdingMinor !== 0n)
    sumRows.push(
      `<tr class="muted"><td>Withholding (TDS)</td><td class="num">${money(-t.withholdingMinor)}</td></tr>`,
    );
  // No promotional row here: promotional credit is applied PRE-tax, so it is one of
  // `doc.discountLines` above the Total (2026-08-25). Printing it again below the
  // Total would take the same money off twice.
  if (t.creditsApplied.refundable !== 0n)
    sumRows.push(
      `<tr class="muted"><td>Refundable credits</td><td class="num">${money(-t.creditsApplied.refundable)}</td></tr>`,
    );
  if (t.creditsApplied.excess !== 0n)
    sumRows.push(
      `<tr class="muted"><td>Excess payments</td><td class="num">${money(-t.creditsApplied.excess)}</td></tr>`,
    );
  if (t.amountPaidMinor !== 0n)
    sumRows.push(
      `<tr class="muted"><td>Payments</td><td class="num">${money(-t.amountPaidMinor)}</td></tr>`,
    );
  // Anything between Total and Amount Due that no row above explains. An imported
  // invoice carries no credit application (the importer reads none) while its
  // `amount_due` arrives already net of one, so the page showed an unexplained gap.
  // Arithmetic on stored values only, and no date is claimed — see invoice-pdf.ts.
  const explainedAfterTotal =
    t.withholdingMinor + t.creditsApplied.refundable + t.creditsApplied.excess + t.amountPaidMinor;
  const unexplainedCredit = t.totalMinor - explainedAfterTotal - t.amountDueMinor;
  if (unexplainedCredit > 0n)
    sumRows.push(
      `<tr class="muted"><td>Credits</td><td class="num">${money(-unexplainedCredit)}</td></tr>`,
    );
  sumRows.push(
    `<tr class="grand due"><td>Amount Due (${esc(cur)})</td><td class="num">${money(t.amountDueMinor)}</td></tr>`,
  );
  const creditTotal =
    t.creditsApplied.refundable +
    t.creditsApplied.excess +
    (unexplainedCredit > 0n ? unexplainedCredit : 0n);

  /**
   * The DISCOUNT footer — the HTML twin of the PDF's, same wording and same reason: the
   * Amount column and the summary between them account for every unit of the discount,
   * but neither says which coupon caused it. See invoice-pdf.ts for the full note.
   */
  const discountBlock = doc.discountDetails.length
    ? `<div class="payments">
        <div class="label">Discount</div>
        ${doc.discountDetails
          .map((d) => {
            const base = d.lineNumbers.reduce(
              (sum, n) => sum + (doc.chargeLines[n - 1]?.amountMinor ?? 0n),
              0n,
            );
            const pct =
              base > 0n ? ` (${((Number(d.amountMinor) / Number(base)) * 100).toFixed(2)}%)` : "";
            // See invoice-pdf.ts: the manual default label is the word "Discount".
            const named = d.code ?? (d.label && d.label !== "Discount" ? d.label : null);
            const where =
              d.lineNumbers.length > 0
                ? ` applied on line item${d.lineNumbers.length > 1 ? "s" : ""} ${d.lineNumbers
                    .map((n) => `#${n}`)
                    .join(", ")}`
                : " applied to this invoice";
            const subject =
              d.source === "manual"
                ? named
                  ? `Manual discount ${named}`
                  : "Manual discount"
                : (named ?? "Discount");
            return `<div>${esc(subject)}${esc(where)} − ${money(d.amountMinor)}${pct}.</div>`;
          })
          .join("")}
      </div>`
    : "";

  const creditsBlock =
    creditTotal > 0n
      ? `<div class="payments">
        <div class="label">Credits</div>
        <div>We applied a credit of ${money(creditTotal)} to this invoice.</div>
      </div>`
      : "";

  const paymentsBlock = doc.payments.length
    ? `<div class="payments">
        <div class="label">Payments</div>
        ${doc.payments.map((p) => `<div>We received ${money(p.amountMinor)} on ${esc(formatDateTimeInTz(p.paidAt, tz))} through ${esc(p.method)}.</div>`).join("")}
      </div>`
    : "";

  const contact = [doc.seller.supportEmail, doc.seller.website]
    .filter(Boolean)
    .map((c) => esc(c!))
    .join("  ·  ");

  // Viewer chrome for print mode. Appended AFTER the base <style> so its screen
  // rules win, and every rule is scoped to `@media screen` — the `@media print`
  // block hides the toolbar and flattens the sheet back to a plain page, which is
  // what the base stylesheet already prints.
  const printStyle = opts.print
    ? `<style>
@media screen{
  body{margin:0;background:#f1f2f4}
  .bar{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:16px;background:#fff;border-bottom:1px solid var(--line);padding:10px 20px;font-size:13px}
  .bar .who{color:var(--muted)}
  .bar button{font:inherit;font-weight:600;color:#fff;background:#111;border:0;border-radius:6px;padding:7px 14px;cursor:pointer}
  .sheet{width:210mm;min-height:297mm;margin:24px auto 48px;padding:12mm;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.18),0 8px 24px rgba(0,0,0,.08)}
}
@media print{.bar{display:none}.sheet{width:auto;min-height:0;margin:0;padding:0;box-shadow:none}}
</style>`
    : "";
  // The toolbar's Print button is the manual re-print; the load handler opens the
  // dialog once so the tab lands where the action's name promises. The tiny delay
  // lets a logo finish loading — printing mid-load drops it from the first page.
  //
  // The button carries NO `onclick`. Its handler is bound inside the one script below,
  // which the Content-Security-Policy admits by hash — and an inline event attribute
  // cannot be hashed without `'unsafe-hashes'`, which would re-admit most of what the
  // policy exists to refuse. See `platform/security-headers.ts` § CSP_INVOICE_HTML.
  const printBar = opts.print
    ? `
<div class="bar">
  <span class="who">Invoice ${esc(doc.meta.number)} · ${esc(doc.billTo.name)}</span>
  <button type="button" class="print">Print</button>
</div>
<div class="sheet">`
    : "";
  const printFoot = opts.print ? `\n</div>\n<script>${INVOICE_PRINT_SCRIPT}</script>` : "";

  return `<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${esc(doc.meta.number)}</title>
<style>
:root{--ink:#111;--muted:#666;--line:#e5e5e5;--accent:#1f3a63}
/* Pin the sheet: portrait A4 with a 12mm margin. Without a @page size Chrome prints
   whatever orientation the user last chose — a landscape invoice with the table
   stranded across two thirds of the page. The 12mm here is the ONLY page margin;
   body adds none, or the content box shrinks twice. */
@page{size:A4 portrait;margin:12mm}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:40px;color:var(--ink);font-size:13px;line-height:1.5}
.head{display:flex;justify-content:space-between;align-items:flex-start}
.head .logo{max-height:48px;max-width:200px}
.head h1{font-size:20px;margin:0}
.head .title{font-size:26px;font-weight:700;letter-spacing:1px}
.cols{display:flex;justify-content:space-between;gap:32px;margin:18px 0 8px}
.cols>div{flex:1}
.seller .name{font-weight:700;color:var(--ink);margin-bottom:2px}
.seller .addr,.seller .tax{color:var(--muted);font-size:12px}
table.meta{border-collapse:collapse;margin-left:auto}
table.meta th{text-align:left;color:#888;font-weight:400;padding:2px 24px 2px 0;font-size:12px;white-space:nowrap}
table.meta td{text-align:left;padding:2px 0;font-weight:700}
.status{margin-top:6px;font-weight:700;font-size:13px}
.status.due{color:#cf222e}.status.ok{color:#1a7f37}.status.warn{color:#9a6700}.status.muted{color:#888}
.divider{border-top:1px solid var(--line);margin:12px 0}
.label{font-size:10px;letter-spacing:1px;color:#999;text-transform:uppercase;margin-bottom:6px}
.billto .name{font-weight:700;color:var(--ink)}
.billto .addr,.billto .tax{color:var(--muted);font-size:12px}
.sub .kv{display:flex;gap:8px;font-size:12px;margin:1px 0}
.sub .kv span{color:#888;min-width:120px}
table.lines{width:100%;border-collapse:collapse;margin-top:8px}
table.lines th{text-align:left;font-size:10px;letter-spacing:.5px;color:#666;border-bottom:1px solid #ccc;padding:8px 8px;text-transform:uppercase}
table.lines th.num,table.lines td.num{text-align:right}
table.lines td{padding:12px 8px;border-bottom:1px solid var(--line);font-weight:700}
.num{text-align:right;white-space:nowrap}
.summary{margin-top:16px;display:flex;justify-content:flex-end}
table.sum{border-collapse:collapse;min-width:300px}
table.sum td{padding:5px 8px}
table.sum td.num{text-align:right}
table.sum tr.muted td{color:var(--muted)}
table.sum tr.grand td{font-weight:700;border-top:1px solid #ccc}
table.sum tr.due td{font-size:16px;font-weight:700}
.payments{margin-top:28px;border-top:1px solid var(--line);padding-top:12px;color:#555;font-size:12px}
.shipto{margin-top:14px}
.shipto .name{font-weight:700;color:var(--ink)}
.shipto .addr{color:var(--muted);font-size:12px}
.customfields{margin-top:12px}
.customfields .kv{display:flex;gap:8px;font-size:12px;margin:1px 0}
.customfields .kv span{color:#888;min-width:120px}
.payinstr{margin-top:20px;border-top:1px solid var(--line);padding-top:12px;font-size:12px}
.payinstr .desc{color:#555;margin-bottom:6px}
.payinstr .kv{display:flex;gap:8px;margin:1px 0}
.payinstr .kv span{color:#888;min-width:140px}
.signature{margin-top:24px}
.signature--right{text-align:right}
.signature--left{text-align:left}
/* Bounded so a large upload cannot push the contact line off the page. */
.signature .sigimg{max-height:56px;max-width:220px;display:inline-block}
.signature .sigcap{color:#444;font-size:12px;margin-top:4px}
.contact{text-align:center;margin-top:16px;color:#999;font-size:12px}
@media print{body{margin:0;padding:0}}
</style>${printStyle}</head>
<body>${printBar}
<div class="head">
  <div>${headerLeft}</div>
  <div class="title">${esc(doc.title)}</div>
</div>
<div class="cols">
  <div class="seller">
    <div class="name">${esc(doc.seller.name)}</div>
    <div class="addr">${sellerLines}</div>
    ${doc.seller.taxRegId ? `<div class="tax">${esc(doc.seller.taxRegLabel)} : <b>${esc(doc.seller.taxRegId)}</b></div>` : ""}
  </div>
  <div>
    <table class="meta"><tbody>${metaRows}</tbody></table>
    ${chip ? `<div class="status ${chip.cls}" style="text-align:right">${chip.label}</div>` : ""}
  </div>
</div>
<div class="divider"></div>
<div class="cols">
  <div class="billto">
    <div class="label">Billed To</div>
    <div class="name">${esc(doc.billTo.name)}</div>
    <div class="addr">${billLines}</div>
    ${doc.billTo.email ? `<div class="addr">${esc(doc.billTo.email)}</div>` : ""}
    ${doc.billTo.taxRegId ? `<div class="tax">${esc(doc.billTo.taxRegLabel)} : ${esc(doc.billTo.taxRegId)}</div>` : ""}
    ${shipBlock}
  </div>
  ${subBlock}
</div>
${customFieldsBlock}
<div class="divider"></div>
<table class="lines">
  <thead><tr><th>Description</th>${anyTaxCode ? "<th>HSN/SAC</th>" : ""}<th class="num">Units</th><th class="num">Unit price</th>${anyLineDiscount ? '<th class="num">Discount</th>' : ""}<th class="num">Amount (${esc(cur)})</th></tr></thead>
  <tbody>${lineRows}</tbody>
</table>
<div class="summary"><table class="sum"><tbody>${sumRows.join("")}</tbody></table></div>
${discountBlock}
${creditsBlock}
${paymentsBlock}
${doc.meta.notes ? `<div class="payments">${esc(doc.meta.notes)}</div>` : ""}
${instructionsBlock}
${signatureBlock}
${contact ? `<div class="contact">${contact}</div>` : ""}${printFoot}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

/**
 * The only script the invoice document carries: open the print dialog once on load,
 * and bind the toolbar button for a manual re-print. Served verbatim inside a
 * `<script>` tag by the print branch of `renderInvoiceHtml` above.
 *
 * A module constant rather than an inline template literal because
 * `platform/security-headers.ts` admits it into the page's Content-Security-Policy by
 * SHA-256 hash, and the hash is derived from THIS string. One source, so the policy
 * cannot describe a script other than the one actually shipped: change the code and
 * the hash changes with it in the same commit. Get it wrong and the browser refuses to
 * run it — loudly, in the console, which is the failure you want.
 *
 * Keep it dependency-free and keep it small. It is the whole of the page's trusted
 * script surface.
 */
export const INVOICE_PRINT_SCRIPT =
  "window.addEventListener('load',function(){" +
  "var b=document.querySelector('.bar button.print');" +
  "if(b)b.addEventListener('click',function(){window.print()});" +
  "setTimeout(function(){window.print()},200)})";

/**
 * `'sha256-<base64>'`, ready to drop into a `script-src` directive.
 *
 * Computed at module load from `INVOICE_PRINT_SCRIPT` rather than pasted in as a
 * literal. A pasted hash is a security assumption recorded by hand: a comment asserting a
 * backend sanitizer that does not exist leads engineers to leave render sites
 * unsanitized. Derive the claim, don't assert it.
 */
export const INVOICE_PRINT_SCRIPT_SHA256 = `sha256-${createHash("sha256")
  .update(INVOICE_PRINT_SCRIPT, "utf8")
  .digest("base64")}`;
