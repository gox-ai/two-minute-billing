/**
 * Payment settlement (Phase C review fix, 2026-07-03).
 *
 * A charge attempt with an UNKNOWN outcome (gateway timeout / 500 / in-flight
 * async capture) is booked as a `pending` payment + an unsettled transaction and
 * the invoice is parked. When the outcome finally arrives — inbound gateway
 * webhook (C8) or operator reconcile (C5) — the money must be settled here, in
 * ONE place, so the ledger can never diverge from the payment/invoice statuses:
 *
 *  - succeeded → cash/AR ledger posting (same shape as the synchronous
 *    `bookSuccess` path), invoice → paid, `payment.succeeded` + `invoice.paid`.
 *  - failed    → payment → failed, invoice re-enters dunning (retry scheduled
 *    from the business's retry offsets; exhaustion → uncollectible), with the
 *    same events the synchronous failure path emits.
 *
 * Both are idempotent: a payment that is no longer `pending` is left alone.
 */
import { activatePaidCreditGrants } from "@/modules/credits/packs";
import { resolveBillingRulesConfig } from "@/modules/subscriptions/billing-rules-config";
import { methodTypeFor } from "./method-type";
import {
  loadEffectiveDunningConfig,
  priorFailedMethods,
} from "@/modules/dunning-policies/effective";
import { stampNow } from "@/platform/clock";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { afterCommit, type Tx } from "@/platform/db";
import { resolvePaymentApplication } from "./application-config";
import { publicId } from "@/platform/ids";
import { postEntries } from "@/modules/ledger/service";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import {
  planFailureRearm,
  heldRetry,
  nextParkedReminderAt,
  retryDaysForMethod,
  dunningAppliesTo,
  dunningPeriodEndsAt,
  dunningAnchor,
} from "@/modules/subscriptions/dunning-schedule";
import { isAutoCollectOn, invoiceOutstanding, dunningHoldFor } from "@/modules/invoicing/service";
import {
  OPEN_INVOICE_STATUSES,
  dunningFieldsOnSettle,
  isLiveDunning,
} from "@/modules/invoicing/status";
import { EXCESS_PAYMENT, bucketBalance } from "@/modules/customers/balances-read";
import { emitCustomerChanged } from "@/modules/customers/balances";
import {
  payments,
  invoices,
  businesses,
  customers,
  subscriptions,
  paymentMethods,
  transactions,
  countries,
  paymentRequests,
  ledgerEntries,
} from "@db/schema";

import { createLogger } from "@/platform/logger";
import { storedPayerDeclineMessage } from "@/modules/subscriptions/decline-overrides";
import { UNAPPLIED_CAPTURE_KEY } from "./unapplied-capture-key";

/**
 * The two lines below record the resolution of an UNKNOWN outcome — a charge whose
 * result we did not have when the request ended, settled later by an inbound webhook
 * or an operator reconcile. That is the one money event with no request behind it and
 * no operator watching, so it is exactly the one that has to leave a trace: until it
 * lands the invoice is parked and the cash is neither ours nor the customer's.
 */
const log = createLogger("payments");

/**
 * The marker `ops/alerts.ts` reads to find GATEWAY MONEY THAT ENDED UP APPLIED TO NOTHING.
 *
 * Every place that detaches a succeeded gateway payment from its invoice stamps this, under
 * one key, because the alert needs one predicate and a path nobody marked is a path nobody
 * sees. `invoice_id IS NULL` alone cannot serve: an ordinary excess-payment balance looks
 * identical and is a legitimate steady state that funds the customer's next invoice — 197
 * such rows on the dev database, which made the first cut of that alert read PAGE
 * permanently, and an always-red alert is one nobody reads.
 *
 * The `reason` says which surprise it was: an async settlement the invoice could not absorb,
 * a debit the buyer had abandoned and then authorised after all, a duplicate checkout, or an
 * authorization that outlived our own clock.
 *
 * ⚠️ Stamped even where the caller REFUNDS the money straight back
 * (`reconcileAbandonedCapture` does). That refund can fail, and when it does the money stays
 * as customer credit behind a swallowed log line — the exact case that must reach a human.
 * The alert excludes rows whose refunds cover them, so the happy path goes quiet by
 * arithmetic rather than by someone remembering to unmark it.
 *
 * MERGED, never assigned: `metadata` belongs to the caller too, and reconciling a payment is
 * no reason to drop what was already recorded on it.
 */
export { UNAPPLIED_CAPTURE_KEY };
/** `payments.metadata`: what an overpayment's invoice absorbed (minor units, string). */
export const OVERPAY_ABSORBED_KEY = "overpay_absorbed_minor";
/** …and the id of that absorb's ledger entry (its `credit_applied` draw on the bucket). */
export const OVERPAY_ABSORB_ENTRY_KEY = "overpay_absorb_entry";
function markUnapplied(reason: "async_overpay" | "abandoned_debit") {
  /**
   * DEFAULTS ON THE LEFT, existing metadata on the RIGHT — because in jsonb `a || b` lets
   * b win, and this must never overwrite a cause a CALLER already recorded.
   *
   * Measured the moment the end-to-end case ran (`verify:stale-pending` § P): a duplicate
   * checkout inserted its row as `second_checkout`, then delegating to
   * `settleAbandonedCapture` merged `abandoned_debit` over the top, and the alert reported
   * the generic cause for a specific one. The row is still marked either way, so nothing
   * about the money changed — but the reason an operator reads was wrong, and the more
   * specific caller is always the better witness.
   */
  return sql`${JSON.stringify({ [UNAPPLIED_CAPTURE_KEY]: reason })}::jsonb || coalesce(${payments.metadata}, '{}'::jsonb)`;
}

/**
 * The refs a payment event must carry so a consumer can PLACE the money.
 *
 * `buildEventContent` enriches a payment event with its invoice, customer and subscription
 * by reading `data.payment.invoice` (and `data.payment.customer` when there is no invoice).
 * It cannot recover them any other way: the event's resource id is a `pay_…`, and
 * `loadTransactionSnapshot` matches `transactions.public_id`, so that lookup always misses.
 *
 * An event carrying neither ref therefore ships as a bare `{id, status, amount_minor,
 * currency}` — an amount with nobody to attribute it to. A consumer drops exactly those
 * ("payment_succeeded names no resolvable invoice"), so a renewal that settled at the
 * gateway never reaches the product. Four such payments went unrecorded between
 * 2026-09-09 and 2026-09-13; a 200 is returned, so they are not redelivered.
 *
 * Both refs, because the detached branches below have no invoice by construction and must
 * still say WHO the money belonged to — the same pairing `invoicing/collection.ts` emits.
 */
async function paymentEventRefs(
  tx: Tx,
  ids: { invoiceId?: string | null; customerId: string; paymentRequestId?: string | null },
): Promise<{ invoice: string | null; customer: string | null; payment_request?: string }> {
  const [cus] = await tx
    .select({ publicId: customers.publicId })
    .from(customers)
    .where(eq(customers.id, ids.customerId))
    .limit(1);
  let invoice: string | null = null;
  if (ids.invoiceId) {
    // Any status, not just OPEN: the ref says which invoice this money was for, and by
    // the time a settlement emits, that invoice is usually already `paid`.
    const [inv] = await tx
      .select({ publicId: invoices.publicId })
      .from(invoices)
      .where(eq(invoices.id, ids.invoiceId))
      .limit(1);
    invoice = inv?.publicId ?? null;
  }
  // A payment-request child names its request, so a consumer (and the receipt mail) can
  // tell one slice of a grouped charge from a standalone payment.
  if (ids.paymentRequestId) {
    const [preq] = await tx
      .select({ publicId: paymentRequests.publicId })
      .from(paymentRequests)
      .where(eq(paymentRequests.id, ids.paymentRequestId))
      .limit(1);
    if (preq) return { invoice, customer: cus?.publicId ?? null, payment_request: preq.publicId };
  }
  return { invoice, customer: cus?.publicId ?? null };
}

export interface SettleInput {
  organizationId: string;
  businessId: string;
  paymentId: string;
  occurredAt?: Date;
}

/**
 * The payment a gateway charge ALREADY books, if any — the question anything about to
 * insert one has to ask first (#20).
 *
 * The predicate mirrors `payments_provider_charge_uq` ROW FOR ROW, on both sides, and
 * every clause is load-bearing:
 *  - NULL / `''`: outside the index, so they are not identities. An attempt that never
 *    reached a gateway has no id and RazorPay/PayPal return `''` on some failures —
 *    matching on either would hand back somebody else's payment.
 *  - `provider_key = 'offline'`: `recordPayment` stores the METHOD NAME here (`cash`,
 *    `cheque`), so a business's cash payments all repeat the value. Those rows are
 *    outside the index too, which means a new non-offline row with the same text CANNOT
 *    collide with them — so excluding them is not caution, it is the same rule the
 *    database is applying.
 *
 * `settleUnmatchedGatewayCapture` below has always done this lookup; this is the same
 * question in one place so the two can never disagree about what "already booked" means.
 */
export async function bookedPaymentForCharge(
  tx: Tx,
  input: {
    businessId: string;
    providerChargeId?: string | null;
    providerKey?: string | null;
  },
): Promise<typeof payments.$inferSelect | null> {
  const chargeId = input.providerChargeId?.trim();
  if (!chargeId || input.providerKey === "offline") return null;
  const [row] = await tx
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.businessId, input.businessId),
        eq(payments.providerChargeId, chargeId),
        sql`${payments.providerKey} <> 'offline'`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Settle a transaction that has NO engine payment row yet (e.g. a synthetic /
 * externally-recorded gateway transaction): create the payment record first,
 * then settle it through the normal path so ledger + invoice + events stay
 * consistent no matter how the attempt was recorded.
 */
export async function settleTransactionOutcome(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    outcome: "succeeded" | "failed";
    occurredAt?: Date;
    /**
     * Whether retrying this instrument could succeed. Defaults to true — the
     * historical behaviour, and the safe one: treating an unclassified async failure
     * as hard would mark a working payment method `invalid` and burn the backup.
     */
    retriable?: boolean;
    txn: {
      /** The transaction's own id; a payment-request settlement books its receipt on it. */
      id?: string;
      paymentId: string | null;
      invoiceId: string | null;
      /** Set when this is a payment request's one charge (0388): the request settles. */
      paymentRequestId?: string | null;
      customerId?: string | null;
      paymentMethodId?: string | null;
      amountMinor: bigint;
      currency: string;
      gatewayKey?: string | null;
      idAtGateway?: string | null;
      errorCode?: string | null;
      errorText?: string | null;
    };
  },
): Promise<void> {
  // A payment request's charge has no payment of its own: it spreads over the request's
  // child payments. Every resolver that names only the charge reaches the request here.
  if (input.txn.paymentRequestId) {
    const { settleRequestTransaction } = await import("@/modules/payment-requests/service");
    const done = await settleRequestTransaction(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      outcome: input.outcome,
      occurredAt: input.occurredAt,
      retriable: input.retriable,
      txn: { ...input.txn, paymentRequestId: input.txn.paymentRequestId },
    });
    if (!done)
      log.warn("a payment request outcome arrived for a request that is not processing", {
        event: "payment_request_settlement_dropped",
        transaction: input.txn.id ?? null,
        outcome: input.outcome,
        gatewayCharge: input.txn.idAtGateway ?? null,
      });
    return;
  }
  let paymentId = input.txn.paymentId;
  if (!paymentId) {
    /**
     * ── #20: THE CHARGE MAY ALREADY BOOK A PAYMENT ─────────────────────────────
     *
     * This function used to go straight to the insert below, carrying
     * `providerChargeId: input.txn.idAtGateway` — and `payments_provider_charge_uq`
     * ("one gateway charge books at most one payment") then rejected it. The whole
     * settlement died as an unhandled unique violation: measured 2026-09-03, an operator
     * `failed` verdict on such a row answered **500**, so "mark this failed" was
     * unavailable on exactly the rows most likely to need it, and it failed as a server
     * error rather than as anything a person could act on.
     *
     * A transaction naming a charge that a payment already holds is not a corrupt state,
     * it is the ORDINARY one: post-#17 the late-authorization path stamps `id_at_gateway`
     * on the `authorization_unappliable` row it raises, while the capture that produced
     * that charge was already booked by `settleUnmatchedGatewayCapture` or by the collect
     * path's `bookPending`. Two records, one charge — which is what the unique index is
     * for. So the outcome belongs to the payment that EXISTS: it carries the ledger
     * postings, the invoice link and the refunds, and a second row for the same money
     * would be exactly the double-booking 0162 was written to stop.
     *
     * Reuse is safe for both outcomes because the claims downstream are the arbiter:
     * `settlePaymentSucceeded` / `settlePaymentFailed` each take only a `pending` row, so
     * settling an already-settled payment posts nothing. The one thing reuse must NOT be
     * allowed to do is stand behind a contradiction — a `failed` verdict over a
     * `succeeded` payment posts nothing here but would still leave the transaction
     * terminal and false. That is refused one layer up, in `reconcileTransaction`, where
     * an operator can be told why; a GATEWAY verdict arriving by webhook is not refused,
     * because throwing there only turns into an endless redelivery.
     */
    const booked = await bookedPaymentForCharge(tx, {
      businessId: input.businessId,
      providerChargeId: input.txn.idAtGateway,
      providerKey: input.txn.gatewayKey,
    });
    if (booked) {
      paymentId = booked.id;
      /**
       * The money follows the PAYMENT's invoice, not the transaction's — `settlePayment*`
       * reads `pay.invoice_id`. Worth a line when they differ, because the pair is then
       * telling two stories about where one charge belongs, and nothing else would say so.
       */
      if (input.txn.invoiceId && booked.invoiceId !== input.txn.invoiceId)
        log.warn("a transaction and the payment holding its charge name different invoices", {
          event: "settlement_reused_payment_invoice_mismatch",
          payment: booked.publicId,
          paymentInvoice: booked.invoiceId,
          transactionInvoice: input.txn.invoiceId,
          gatewayCharge: input.txn.idAtGateway,
        });
    }
  }
  /**
   * No payment anywhere for this attempt, so record one. A SECOND `if` rather than an
   * `else`, because the early return below ("nothing to settle against") must keep
   * returning from THIS function — inside a nested helper it would fall through with no
   * payment id and settle against nothing.
   */
  if (!paymentId) {
    let customerId = input.txn.customerId ?? null;
    if (!customerId && input.txn.invoiceId) {
      const [inv] = await tx
        .select({ customerId: invoices.customerId })
        .from(invoices)
        .where(eq(invoices.id, input.txn.invoiceId))
        .limit(1);
      customerId = inv?.customerId ?? null;
    }
    if (!customerId) return; // nothing to settle against
    const [pay] = await tx
      .insert(payments)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId,
        invoiceId: input.txn.invoiceId,
        paymentMethodId: input.txn.paymentMethodId ?? null,
        publicId: publicId("pay"),
        status: "pending",
        amountMinor: input.txn.amountMinor,
        currency: input.txn.currency,
        providerKey: input.txn.gatewayKey ?? "unknown",
        providerChargeId: input.txn.idAtGateway ?? null,
        methodType: await methodTypeFor(tx, null, input.txn.paymentMethodId),
      })
      .returning();
    paymentId = pay!.id;
  }
  const base = {
    organizationId: input.organizationId,
    businessId: input.businessId,
    paymentId,
    occurredAt: input.occurredAt,
  };
  if (input.outcome === "succeeded") {
    /**
     * A success we could NOT book, because the payment is no longer `pending`.
     *
     * Ordinarily a race the atomic claim is meant to swallow — two settlers, one wins.
     * But there is one case where it means real money went missing from our books: a
     * debit that was abandoned (the stale sweep's AFA overrule, or the buyer's own
     * "I won't authorise this" in the portal) and then captured at the gateway anyway.
     * The claim declines it, nothing is posted, and the customer has paid twice while
     * we recorded one payment.
     *
     * It cannot be auto-resolved here — booking cash against a failed payment would
     * corrupt the very invariant the claim protects — but it must never be SILENT,
     * which is what ignoring this boolean made it. An operator reconciles from this line.
     */
    const booked = await settlePaymentSucceeded(tx, base);
    if (!booked) {
      log.error(
        "a gateway SUCCESS arrived for a payment that is no longer pending — money may be unbooked",
        {
          event: "settlement_dropped_not_pending",
          payment: paymentId,
          invoice: input.txn.invoiceId,
          gatewayCharge: input.txn.idAtGateway,
          amountMinor: String(input.txn.amountMinor),
          currency: input.txn.currency,
        },
      );
    }
  } else {
    const failed = await settlePaymentFailed(tx, {
      ...base,
      errorCode: input.txn.errorCode,
      errorText: input.txn.errorText,
      ...(input.retriable != null ? { retriable: input.retriable } : {}),
    });
    /**
     * The mirror of the line above, and newly reachable since #20 made the reuse branch
     * exist: `settlePaymentFailed` claims a `pending` row only, so a failure verdict on a
     * payment that has moved on posts nothing and changes nothing. `succeeded` there is
     * refused before this point for an operator verdict, but the other non-pending states
     * (`requires_action`, an already-`failed` redelivery) reach here and must not be
     * silent — the transaction is about to read `failure` on the strength of a settlement
     * that did not happen.
     */
    if (!failed)
      log.warn("a FAILED outcome was settled against a payment that is no longer pending", {
        event: "settlement_failure_dropped_not_pending",
        payment: paymentId,
        invoice: input.txn.invoiceId,
        gatewayCharge: input.txn.idAtGateway,
        errorCode: input.txn.errorCode,
      });
  }
}

/**
 * Settle a pending payment as SUCCEEDED: flip the payment, post cash/AR for its
 * amount, mark the linked invoice paid, emit events. No-op (returns false) if
 * the payment isn't `pending` anymore — safe under webhook/reconcile races.
 */
export async function settlePaymentSucceeded(tx: Tx, input: SettleInput): Promise<boolean> {
  const now = input.occurredAt ?? stampNow();

  /**
   * WHAT THE INVOICE CAN STILL ABSORB — read BEFORE the claim, and locked.
   *
   * An in-flight attempt is sized against the balance as it stood when the gateway call
   * left. The invoice can MOVE while it is out there: an add-on removed mid-dunning
   * issues an adjustment note, and `issueAdjustmentCreditNote` sizes that note against
   * `invoiceOutstanding`, which counts SUCCEEDED payments only — so a pending attempt is
   * invisible to it. Both sides are individually correct and the pair overpays.
   *
   * Measured by `scripts/probe-inflight-adjustment.ts`, the reported PRO + 5 connections
   * + 1 GDS shape: invoice 3628400 in dunning, attempt in flight for the full amount,
   * buyer removes the GDS → adjustment 460600, due falls to 3167800 — and this function
   * then booked the whole 3628400 and marked the invoice `paid`. The customer was
   * **4606.00 over**, with no error and no warning anywhere.
   *
   * Reading BEFORE the claim is load-bearing for the reason `settleAbandonedCapture`
   * spells out below: `invoiceOutstanding` derives what is due from succeeded
   * invoice-linked payments, so flipping this row first makes it count itself and every
   * untouched invoice reads `remaining = 0`. `FOR UPDATE` so two settlers cannot both
   * read the same balance.
   */
  const [candidate] = await tx
    .select()
    .from(payments)
    .where(eq(payments.id, input.paymentId))
    .limit(1);
  if (!candidate || candidate.status !== "pending") return false;
  let open: typeof invoices.$inferSelect | null = null;
  let due = 0n;
  if (candidate.invoiceId) {
    const [locked] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, candidate.invoiceId))
      .for("update")
      .limit(1);
    if (locked && (OPEN_INVOICE_STATUSES as readonly string[]).includes(locked.status)) {
      open = locked;
      due = (await invoiceOutstanding(tx, locked)).remainingMinor;
    }
  }

  // Atomic claim: only ONE settler can move pending → succeeded.
  const [pay] = await tx
    .update(payments)
    .set({ status: "succeeded" })
    .where(and(eq(payments.id, input.paymentId), eq(payments.status, "pending")))
    .returning();
  if (!pay) return false;

  // A paid wallet top-up: the money is customer credit (cash / excess), never AR. Settled
  // here so a top-up charged now and one settled later by webhook or sweep post the same.
  if (!pay.invoiceId) {
    const { creditSettledTopUp } = await import("@/modules/wallet/service");
    if (await creditSettledTopUp(tx, pay)) {
      const refs = await paymentEventRefs(tx, { customerId: pay.customerId });
      await emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "payment_succeeded",
        data: buildEventData("payment_succeeded", {
          id: pay.publicId,
          status: "succeeded",
          amount_minor: Number(pay.amountMinor),
          currency: pay.currency,
          customer: refs.customer,
        }),
      });
      return true;
    }
  }

  // ── THE INVOICE CANNOT SWALLOW IT WHOLE ─────────────────────────────────────────
  // Only when there IS an invoice: a payment with no `invoice_id` was never measured
  // against one and keeps its ordinary posting below.
  if (pay.invoiceId && (open == null || due < pay.amountMinor)) {
    const absorb = due > 0n ? due : 0n;
    // DETACH FIRST. `paidTotals` sums invoice-linked succeeded payments into the
    // invoice's `amount_paid`, so leaving the link credits the invoice with money that
    // was not applied to it — the same over-credit `settleAbandonedCapture` details.
    await tx
      .update(payments)
      .set({
        invoiceId: null,
        // What the invoice takes of it below: the rest is this payment's own leftover.
        metadata: sql`${JSON.stringify({ [OVERPAY_ABSORBED_KEY]: absorb.toString() })}::jsonb || ${markUnapplied("async_overpay")}`,
      })
      .where(eq(payments.id, pay.id));
    await postEntries(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: pay.customerId,
        sourceType: "excess_payment",
        sourceId: pay.publicId,
        lines: [
          {
            account: "cash",
            direction: "debit",
            amountMinor: pay.amountMinor,
            currency: pay.currency,
            memo: "Settled for more than the invoice owed",
          },
          {
            account: EXCESS_PAYMENT,
            direction: "credit",
            amountMinor: pay.amountMinor,
            currency: pay.currency,
            memo: "Settled for more than the invoice owed",
          },
        ],
      },
      tx,
    );
    // Detached above, so there is no invoice ref to give — this money became customer
    // credit. Name the customer instead, or the event says nothing about whose it is.
    const overpayRefs = await paymentEventRefs(tx, {
      customerId: pay.customerId,
      paymentRequestId: pay.paymentRequestId,
    });
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "payment_succeeded",
      data: buildEventData(
        "payment_succeeded",
        {
          id: pay.publicId,
          status: "succeeded",
          amount_minor: Number(pay.amountMinor),
          currency: pay.currency,
          customer: overpayRefs.customer,
          ...(overpayRefs.payment_request ? { payment_request: overpayRefs.payment_request } : {}),
        },
        null,
        { settled_async: true },
      ),
    });

    // …then pay the invoice out of that credit. Holding the money and leaving the
    // invoice open is NOT enough on its own: `collectInvoice` does not draw customer
    // credit, so the next dunning retry would charge the card a SECOND time — turning
    // an overpayment into a double charge, which is worse than the bug being fixed.
    // Applying it here settles the invoice and leaves only the true remainder as the
    // customer's excess balance.
    if (open && absorb > 0n) {
      const { postCreditApplications } = await import("@/modules/invoicing/service");
      await postCreditApplications(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: pay.customerId,
        invoicePublicId: open.publicId,
        currency: pay.currency,
        promotional: 0n,
        refundable: 0n,
        excess: absorb,
      });
      // The absorb's own ledger entry: refund math leaves out exactly this draw.
      const [absorbEntry] = await tx
        .select({ id: ledgerEntries.id })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.account, EXCESS_PAYMENT),
            eq(ledgerEntries.sourceType, "credit_applied"),
            eq(ledgerEntries.sourceId, open.publicId),
            eq(ledgerEntries.direction, "debit"),
          ),
        )
        .orderBy(desc(ledgerEntries.id))
        .limit(1);
      if (absorbEntry)
        await tx
          .update(payments)
          .set({
            metadata: sql`coalesce(${payments.metadata}, '{}'::jsonb) || ${JSON.stringify({ [OVERPAY_ABSORB_ENTRY_KEY]: absorbEntry.id })}::jsonb`,
          })
          .where(eq(payments.id, pay.id));
      /**
       * ── THE COLUMNS, NOT ONLY THE LEDGER (D1, 2026-09-01) ──────────────────────
       *
       * `postCreditApplications` posts LEDGER ENTRIES. It does not touch the invoice's
       * own tallies, and this was the only one of THREE writers of an excess application
       * that did not maintain them — `invoicing/ops.ts` and `customers/collect.ts` both
       * set `amount_due_minor` and `excess_payments_applied_minor` explicitly, each with a
       * comment saying why.
       *
       * Measured by `verify:credit-chain-gateway` §6: ₹18,142.58 absorbed here, and the
       * invoice then read `excess_payments_applied_minor = 0` with `amount_due_minor`
       * unchanged at ₹21,468.39 while its status said `paid`. No cash was lost — the
       * ledger was right — but the omission is not cosmetic:
       *
       *   · `creditAcrossInvoices` builds `recycled` from these very columns, so the next
       *     plan change credited this invoice **₹18,142.58 short**, and the estimate
       *     reported exactly that figure as `credit_stranded_minor`;
       *   · `serialize.ts` reported `credits_applied_minor = 0` for an invoice ₹18,142.58
       *     of credit had settled, so `amount_paid + credits_applied` no longer
       *     reconciled to the total;
       *   · `amount_due_minor` broke the contract its own schema docblock states.
       *
       * Third instance in one night of one shape: a money figure that exists in the ledger
       * but not in the column later arithmetic reads. See also the `recycled` term that
       * ignored issued notes (M1) and `unplacedMinor` being dropped rather than owed (M6).
       *
       * `amount_due_minor` is the issue-time collectible NET OF CREDITS ONLY — cash is
       * subtracted at serialization — so it moves by the credit applied and by nothing
       * else, exactly as `invoicing/ops.ts` documents at its own write.
       */
      const storedDue = (open.amountDueMinor ?? open.totalMinor) - absorb;
      await tx
        .update(invoices)
        .set({
          status: "paid",
          paidAt: now,
          nextAttemptAt: null,
          amountDueMinor: storedDue > 0n ? storedDue : 0n,
          excessPaymentsAppliedMinor: (open.excessPaymentsAppliedMinor ?? 0n) + absorb,
          ...dunningFieldsOnSettle(open),
        })
        .where(and(eq(invoices.id, open.id), inArray(invoices.status, [...OPEN_INVOICE_STATUSES])));
      await emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "invoice_paid",
        data: buildEventData(
          "invoice_paid",
          { id: open.publicId, amount_minor: Number(open.totalMinor), currency: open.currency },
          null,
          { settled_async: true },
        ),
      });
      await activatePaidCreditGrants(tx, {
        organizationId: input.organizationId,
        invoiceId: open.id,
      });
    }
    log.error("an in-flight payment settled for more than its invoice still owed", {
      event: "payment_settled_overshoot",
      payment: pay.publicId,
      invoice: open?.publicId ?? null,
      amountMinor: String(pay.amountMinor),
      invoiceOwed: String(due),
      heldAsExcessMinor: String(pay.amountMinor - absorb),
      currency: pay.currency,
    });
    await refundOvershootIfSet(tx, input, pay, pay.amountMinor - absorb);
    return true;
  }

  // The money movement the synchronous bookSuccess path posts at charge time.
  await postEntries(
    {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: pay.customerId,
      sourceType: "payment",
      sourceId: pay.publicId,
      lines: [
        {
          account: "cash",
          direction: "debit",
          amountMinor: pay.amountMinor,
          currency: pay.currency,
        },
        {
          account: "accounts_receivable",
          direction: "credit",
          amountMinor: pay.amountMinor,
          currency: pay.currency,
        },
      ],
    },
    tx,
  );

  const settledRefs = await paymentEventRefs(tx, {
    invoiceId: pay.invoiceId,
    customerId: pay.customerId,
    paymentRequestId: pay.paymentRequestId,
  });
  await emitEvent(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    type: "payment_succeeded",
    data: buildEventData(
      "payment_succeeded",
      {
        id: pay.publicId,
        status: "succeeded",
        amount_minor: Number(pay.amountMinor),
        currency: pay.currency,
        invoice: settledRefs.invoice,
        customer: settledRefs.customer,
        ...(settledRefs.payment_request ? { payment_request: settledRefs.payment_request } : {}),
      },
      null,
      { settled_async: true },
    ),
  });

  let settledInvoice: string | null = null;
  if (pay.invoiceId) {
    // Read the dunning state BEFORE the update — `.returning()` hands back the row as it is
    // AFTER, so it can no longer say whether this invoice was being chased.
    const [beforeSettle] = await tx
      .select({ attemptCount: invoices.attemptCount, dunningStatus: invoices.dunningStatus })
      .from(invoices)
      .where(eq(invoices.id, pay.invoiceId))
      .limit(1);
    const [inv] = await tx
      .update(invoices)
      .set({
        status: "paid",
        paidAt: now,
        nextAttemptAt: null,
        ...(beforeSettle ? dunningFieldsOnSettle(beforeSettle) : {}),
      })
      .where(
        and(eq(invoices.id, pay.invoiceId), inArray(invoices.status, [...OPEN_INVOICE_STATUSES])),
      )
      .returning();
    settledInvoice = inv?.publicId ?? null;
    if (inv) {
      await emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "invoice_paid",
        data: buildEventData(
          "invoice_paid",
          { id: inv.publicId, amount_minor: Number(inv.totalMinor), currency: inv.currency },
          null,
          { settled_async: true },
        ),
      });
      await activatePaidCreditGrants(tx, {
        organizationId: input.organizationId,
        invoiceId: inv.id,
      });
    }
  }
  log.info("in-flight payment settled as SUCCEEDED", {
    event: "payment_settled_succeeded",
    payment: pay.publicId,
    invoice: settledInvoice,
    amountMinor: String(pay.amountMinor),
    currency: pay.currency,
  });
  return true;
}

/**
 * Excess payment (2.69): with `payment_application.excess_payment = refund`, the part of an
 * overpayment no invoice took goes back to the payer once this transaction commits, by the
 * shared `refundUnappliedExcess` (a bank debit is still held as credit). Otherwise it stays
 * the customer's credit, as before the setting.
 */
async function refundOvershootIfSet(
  tx: Tx,
  input: SettleInput,
  pay: { publicId: string; currency: string },
  leftoverMinor: bigint,
): Promise<void> {
  if (leftoverMinor <= 0n) return;
  const [biz] = await tx
    .select({ billingRulesConfig: businesses.billingRulesConfig })
    .from(businesses)
    .where(eq(businesses.id, input.businessId))
    .limit(1);
  if (resolvePaymentApplication(biz).excessPayment !== "refund") return;
  const { refundUnappliedExcess } = await import("@/modules/refunds/excess");
  const run = () =>
    refundUnappliedExcess(
      { organizationId: input.organizationId, businessId: input.businessId },
      { paymentPublicId: pay.publicId, amountMinor: leftoverMinor, currency: pay.currency },
      "Payment settled for more than the invoice owed",
      { ownLeftoverOnly: true },
    );
  if (!afterCommit(run)) await run();
}

/**
 * Book a capture that arrived for a debit we had already ABANDONED.
 *
 * ── The hole this fills ───────────────────────────────────────────────────────
 * An AFA debit can be given up on while it is still live at the gateway — by the
 * 72-hour sweep, or by the buyer saying "I won't approve this" in the portal — and
 * RazorPay cannot void a `created` recurring payment, so "abandoned" is a statement
 * about OUR records, not about the gateway's. If the buyer then approves it after
 * all, the capture is real money.
 *
 * Until now that money was thrown away. `reconcileChargeSucceeded` gated on
 * `['in_progress','timeout','needs_attention']` and returned `'ignored'` for anything
 * else — the same result code as "a CLI test event that isn't ours" — so a customer
 * who paid in the portal and then approved their bank's request was charged twice,
 * with no ledger entry, no event and no line anywhere. The engine already models the
 * mirror case (`late_failure`: the gateway retracting a success we booked); it had no
 * model at all for the gateway CONFIRMING a failure we booked.
 *
 * ── Where the money goes ──────────────────────────────────────────────────────
 * Decided by what the invoice can still absorb, and deliberately ALL-OR-NOTHING:
 *
 *  - the invoice is open and still owes AT LEAST this much → apply it. Very often
 *    there is no double payment at all: the buyer abandoned, never got round to
 *    paying, and the debit simply landed late. Throwing it away meant dunning them
 *    for money they had paid.
 *  - anything else (invoice paid/voided, or it owes LESS than the capture) → the
 *    whole capture becomes `excess_payment_balance`, money we hold for the customer,
 *    and the caller refunds it.
 *
 * No partial split, and that is a correctness decision rather than laziness.
 * `invoiceOutstanding` derives what is still due from the SUM OF INVOICE-LINKED
 * PAYMENT ROWS (`paidTotals`), so an invoice-linked payment row must never carry more
 * than the invoice absorbed — `recordOfflinePayment` splits by creating a row for the
 * applied part only. We cannot do that here: there is ONE gateway charge, `refundPayment`
 * refunds against ONE row and caps at its `amountMinor`, and a row shrunk to the applied
 * slice could no longer refund the rest. So a capture the invoice cannot swallow whole
 * goes to the customer intact — conservative with someone else's money, which is the
 * right bias, and the leftover invoice stays collectible by ordinary means.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────────
 * The `failed → succeeded` UPDATE is the claim, and it is the ONLY one: webhooks
 * redeliver, and a second delivery finds no row in `failed` and books nothing. The
 * caller must therefore not write anything before calling this.
 *
 * ⚠️ Reachable only from the inbound webhook. The stale-pending sweep selects
 * `in_progress` rows, so an abandoned debit is never re-polled — if the capture
 * happens AND its webhook never arrives, nothing here fires. That is the same class
 * of gap the sweep itself exists to cover, one layer along, and it is not covered.
 */
/**
 * Money the gateway reports that we have NO PAYMENT ROW FOR — book it, or say why not.
 *
 * ── The hole this closes ──────────────────────────────────────────────────────
 * `settleAbandonedCapture` (below) resolves a capture for a debit we had already
 * recorded as `failed`. It cannot help when there is no row at all, and there are two
 * routine ways to reach that state:
 *
 *  1. **A second checkout on one invoice.** Measured on production data 2026-08-31,
 *     INV-5510: the buyer pressed portal "Pay now" twice, our own route minted a SECOND
 *     RazorPay order (`order_XXXXXXXXXXXX02`) while the first was still live, and both
 *     were paid. The first was captured and settled the invoice. The second —
 *     `pay_XXXXXXXXXXXX01`, real money — produced NO `payments` row, NO `transactions`
 *     row and no ledger entry: `harvestInvoiceIntent` found nothing left to collect,
 *     logged "could not be captured yet", and returned `ignored`. RazorPay had told us
 *     twice (`intent.authorized`, then `charge.succeeded` twice). The money was invisible
 *     to the engine, to the Transactions log and to the refund path — so nobody could
 *     even give it back, which is the part that makes it unacceptable rather than untidy.
 *  2. **An authorization arriving after our own TTL.** `scripts/probe-late-authorization.ts`
 *     scenario A: the intent expires on our one-hour clock, the bank authorizes later, and
 *     the event is dropped by the webhook's terminal guard with the hold live at the gateway.
 *
 * ── What it does ──────────────────────────────────────────────────────────────
 * It materialises the missing `payments` row and then hands it to
 * `settleAbandonedCapture`, so there is exactly ONE implementation of the question
 * "where does this money go?" — apply it to the invoice if that invoice can still absorb
 * the whole amount, otherwise detach it and hold it as the customer's excess-payment
 * credit, which `refundPayment({ contraAccount: 'excess_payment_balance' })` can then
 * hand back. Reusing that function rather than copying its rules is deliberate: it reads
 * the outstanding balance BEFORE claiming (so the payment cannot count itself), locks the
 * invoice `FOR UPDATE`, and detaches on the excess branch so `paidTotals` never credits an
 * invoice with money that was not applied to it. Every one of those is a bug someone
 * already paid for.
 *
 * The row is inserted `failed` and flipped inside the CALLER'S transaction, so no observer
 * ever sees the intermediate state, and the flip stays the single atomic claim.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────────
 * `payments_provider_charge_uq` (business + `provider_charge_id`) is the guard, and
 * webhooks redeliver constantly. On conflict we do not insert: we look the existing row up
 * and, if it is still `failed`, settle THAT — which is the abandoned-capture case arriving
 * by this door. An already-`succeeded` row means a previous delivery did the work.
 *
 * ⚠️ Requires a real gateway charge id. The unique index excludes NULL, `''` and
 * `provider_key = 'offline'`, so without one there is no dedup and a redelivery would book
 * the money twice — we refuse instead.
 */
export async function settleUnmatchedGatewayCapture(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    /** The invoice this money was raised for, if any — the applied/excess decision reads it. */
    invoiceId?: string | null;
    currency: string;
    amountMinor: bigint;
    providerKey: string;
    /** The gateway's own charge handle. Also the idempotency key — see above. */
    providerChargeId: string;
    paymentMethodId?: string | null;
    /** Why this money had no row of its own; goes into the log line. */
    reason: "second_checkout" | "late_authorization";
    occurredAt: Date;
  },
): Promise<
  | { booked: false; reason: "no_charge_id" | "already_recorded" | "not_claimable" }
  | {
      booked: true;
      paymentPublicId: string;
      disposition: "applied" | "excess";
      amountMinor: bigint;
      currency: string;
    }
> {
  const { organizationId, businessId } = input;
  const chargeId = input.providerChargeId?.trim();
  if (!chargeId || input.providerKey === "offline")
    return { booked: false, reason: "no_charge_id" };
  if (input.amountMinor <= 0n) return { booked: false, reason: "no_charge_id" };

  const settleExisting = async (row: typeof payments.$inferSelect) => {
    if (row.status !== "failed")
      return { booked: false as const, reason: "already_recorded" as const };
    const res = await settleAbandonedCapture(tx, {
      organizationId,
      businessId,
      paymentId: row.id,
      occurredAt: input.occurredAt,
    });
    return res.booked ? res : { booked: false as const, reason: "not_claimable" as const };
  };

  const [existing] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.businessId, businessId), eq(payments.providerChargeId, chargeId)))
    .limit(1);
  if (existing) return settleExisting(existing);

  // A payment request holds this charge (0388). In flight: the capture settles the request.
  // Otherwise its children are closed, so the money lands as customer credit, never on an
  // invoice the request already paid or released.
  const [preq] = await tx
    .select({ id: paymentRequests.id, status: paymentRequests.status })
    .from(paymentRequests)
    .where(
      and(
        eq(paymentRequests.businessId, businessId),
        eq(paymentRequests.providerChargeId, chargeId),
      ),
    )
    .limit(1);
  if (preq?.status === "processing") {
    const [txn] = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.paymentRequestId, preq.id))
      .orderBy(sql`${transactions.createdAt} desc`)
      .limit(1);
    const { settleRequestSucceeded } = await import("@/modules/payment-requests/service");
    if (txn)
      await settleRequestSucceeded(tx, {
        organizationId,
        businessId,
        requestId: preq.id,
        transactionId: txn.id,
        chargeId,
        occurredAt: input.occurredAt,
      });
    return { booked: false, reason: "already_recorded" };
  }
  const invoiceId = preq ? null : (input.invoiceId ?? null);

  const [inserted] = await tx
    .insert(payments)
    .values({
      organizationId,
      businessId,
      customerId: input.customerId,
      invoiceId,
      paymentMethodId: input.paymentMethodId ?? null,
      publicId: publicId("pay"),
      // `failed` for exactly as long as this transaction takes: the flip below is the
      // claim `settleAbandonedCapture` documents, and it must remain the only one.
      status: "failed",
      amountMinor: input.amountMinor,
      currency: input.currency.toUpperCase(),
      providerKey: input.providerKey,
      providerChargeId: chargeId,
      methodType: await methodTypeFor(tx, null, input.paymentMethodId),
      failureCode: "unmatched_gateway_capture",
      failureMessage: "The gateway reported money we had no record of; being booked now",
      /**
       * A DURABLE marker, because `settleAbandonedCapture` clears `failure_code` when it
       * claims the row — so without this there is nothing left afterwards to say this money
       * arrived unexpectedly.
       *
       * `ops/alerts.ts` needs exactly that distinction. An excess-payment balance is a
       * perfectly normal steady state (it funds the customer's next invoice), so alerting on
       * every detached payment would be permanently red and therefore ignored — measured on
       * the dev database, which carries 197 of them from fixtures. What deserves a human is
       * money that turned up with no record behind it: a duplicate checkout, or an
       * authorization that outlived our own clock.
       */
      metadata: { [UNAPPLIED_CAPTURE_KEY]: input.reason },
      createdAt: input.occurredAt,
    })
    .onConflictDoNothing()
    .returning();

  if (!inserted) {
    // Lost the insert race to a concurrent delivery of the same charge.
    const [row] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.businessId, businessId), eq(payments.providerChargeId, chargeId)))
      .limit(1);
    return row ? settleExisting(row) : { booked: false, reason: "already_recorded" };
  }

  const res = await settleAbandonedCapture(tx, {
    organizationId,
    businessId,
    paymentId: inserted.id,
    occurredAt: input.occurredAt,
  });
  if (!res.booked) return { booked: false, reason: "not_claimable" };
  log.warn("gateway money arrived with no payment row of its own — recorded", {
    event: "unmatched_gateway_capture_booked",
    payment: res.paymentPublicId,
    disposition: res.disposition,
    cause: input.reason,
    charge: chargeId,
    amountMinor: String(res.amountMinor),
    currency: res.currency,
  });
  return res;
}

export async function settleAbandonedCapture(
  tx: Tx,
  input: { organizationId: string; businessId: string; paymentId: string; occurredAt: Date },
): Promise<
  | { booked: false }
  | {
      booked: true;
      paymentPublicId: string;
      disposition: "applied" | "excess";
      amountMinor: bigint;
      currency: string;
    }
> {
  const { organizationId, businessId } = input;
  const [candidate] = await tx
    .select()
    .from(payments)
    .where(eq(payments.id, input.paymentId))
    .limit(1);
  if (!candidate || candidate.status !== "failed") return { booked: false };

  /**
   * What this money can still be FOR — measured BEFORE the claim, and that ordering
   * is load-bearing.
   *
   * `invoiceOutstanding` derives what is due as `amount_due − paidTotals`, and
   * `paidTotals` sums SUCCEEDED invoice-linked payments. Flip this payment to
   * `succeeded` first and it counts itself: an untouched open invoice reads as
   * `remaining = 0`, `due >= amount` is false, and the capture is routed to excess
   * and refunded instead of paying the invoice it was raised for. Reading first —
   * while the row is still `failed`, so it is excluded — is what makes the question
   * "can the invoice absorb this?" mean what it says.
   *
   * `FOR UPDATE` for the same reason `recordOfflinePayment` locks: two settlers must
   * not both read the same outstanding balance and both apply against it.
   */
  let open: typeof invoices.$inferSelect | null = null;
  let due = 0n;
  if (candidate.invoiceId) {
    const [locked] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, candidate.invoiceId))
      .for("update")
      .limit(1);
    if (locked && (OPEN_INVOICE_STATUSES as readonly string[]).includes(locked.status)) {
      open = locked;
      due = (await invoiceOutstanding(tx, locked)).remainingMinor;
    }
  }

  /**
   * The gateway reference, backfilled here or the money can never be handed back.
   *
   * A debit that came back `requires_action` has no charge yet, so the payment row was
   * written with `provider_charge_id` NULL — and this path books it succeeded WITHOUT
   * filling it in, which the normal settle path does (`providerChargeId:
   * input.txn.idAtGateway`). The result: `refundPayment` throws "Payment has no provider
   * charge to refund", `refundUnappliedExcess` swallows it into a log line, and the money
   * lands in excess-payment credit that NOTHING can refund — not the automatic path, not
   * an operator in the dashboard. The one path built to recover a stranded capture made
   * the recovered money unreturnable. Measured 2026-09-05: two revived AFA captures,
   * ₹35,472.22, both with a NULL charge id.
   *
   * `id_at_gateway` is the right value, not the event's `ch_…`: Stripe's refund takes
   * `payment_intent`, and for an off-session India debit that is exactly what the
   * transaction holds. Read from the transaction so the SWEEP gets it too — it has no
   * event to carry a charge id.
   */
  const [linked] = await tx
    .select({ idAtGateway: transactions.idAtGateway })
    .from(transactions)
    .where(eq(transactions.paymentId, input.paymentId))
    .limit(1);

  // THE claim, and the only one: webhooks redeliver, and a second delivery finds no
  // row in `failed` and books nothing. Nothing above this line writes.
  const [pay] = await tx
    .update(payments)
    .set({
      status: "succeeded",
      failureCode: null,
      failureMessage: null,
      // Never overwrite a reference we already have; only fill the gap.
      ...(candidate.providerChargeId == null && linked?.idAtGateway
        ? { providerChargeId: linked.idAtGateway }
        : {}),
    })
    .where(and(eq(payments.id, input.paymentId), eq(payments.status, "failed")))
    .returning();
  if (!pay) return { booked: false };

  const appliesToInvoice = open != null && due >= pay.amountMinor;

  if (appliesToInvoice) {
    const appliedRefs = await paymentEventRefs(tx, { customerId: pay.customerId });
    await postEntries(
      {
        organizationId,
        businessId,
        customerId: pay.customerId,
        sourceType: "payment",
        sourceId: pay.publicId,
        lines: [
          {
            account: "cash",
            direction: "debit",
            amountMinor: pay.amountMinor,
            currency: pay.currency,
          },
          {
            account: "accounts_receivable",
            direction: "credit",
            amountMinor: pay.amountMinor,
            currency: pay.currency,
          },
        ],
      },
      tx,
    );
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "payment_succeeded",
      data: buildEventData(
        "payment_succeeded",
        {
          id: pay.publicId,
          status: "succeeded",
          amount_minor: Number(pay.amountMinor),
          currency: pay.currency,
          // `appliesToInvoice` is true here, so `open` is the invoice this paid.
          invoice: open!.publicId,
          customer: appliedRefs.customer,
        },
        null,
        { settled_async: true, late_capture: true },
      ),
    });
    // Only when it CLEARS the balance. A capture smaller than the outstanding amount
    // is an ordinary part payment: the invoice stays open and `invoiceOutstanding`
    // now reports the remainder, because this row counts toward `paidTotals`.
    if (due === pay.amountMinor) {
      await tx
        .update(invoices)
        .set({
          status: "paid",
          paidAt: input.occurredAt,
          nextAttemptAt: null,
          ...dunningFieldsOnSettle(open!),
        })
        .where(
          and(eq(invoices.id, open!.id), inArray(invoices.status, [...OPEN_INVOICE_STATUSES])),
        );
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "invoice_paid",
        data: buildEventData(
          "invoice_paid",
          {
            id: open!.publicId,
            amount_minor: Number(open!.totalMinor),
            currency: open!.currency,
          },
          null,
          { settled_async: true, late_capture: true },
        ),
      });
      await activatePaidCreditGrants(tx, { organizationId, invoiceId: open!.id });
    }
    log.info("a capture arrived for an abandoned debit and its invoice absorbed it", {
      event: "abandoned_capture_applied",
      payment: pay.publicId,
      invoice: open!.publicId,
      amountMinor: String(pay.amountMinor),
      currency: pay.currency,
    });
    return {
      booked: true,
      paymentPublicId: pay.publicId,
      disposition: "applied",
      amountMinor: pay.amountMinor,
      currency: pay.currency,
    };
  }

  /**
   * DETACHED from the invoice, and this line is load-bearing: `paidTotals` sums
   * invoice-linked succeeded payments into the invoice's `amount_paid`, so leaving the
   * link would credit the invoice with money that was NOT applied to it — the exact
   * over-credit that made INV-2309 collect twice (see `recordOfflinePayment`).
   *
   * Marked for the alert on the way out — see `markUnapplied`. This is the branch whose
   * caller usually refunds the money immediately, and whose refund failing is the thing
   * nobody could see before.
   */
  await tx
    .update(payments)
    .set({ invoiceId: null, metadata: markUnapplied("abandoned_debit") })
    .where(eq(payments.id, pay.id));
  // Same posting as `recordExcessPayment`: cash against the customer-dimensioned
  // liability, so the bucket read picks it up.
  await postEntries(
    {
      organizationId,
      businessId,
      customerId: pay.customerId,
      sourceType: "excess_payment",
      sourceId: pay.publicId,
      lines: [
        {
          account: "cash",
          direction: "debit",
          amountMinor: pay.amountMinor,
          currency: pay.currency,
          memo: "Capture of an abandoned debit",
        },
        {
          account: EXCESS_PAYMENT,
          direction: "credit",
          amountMinor: pay.amountMinor,
          currency: pay.currency,
          memo: "Capture of an abandoned debit",
        },
      ],
    },
    tx,
  );
  // Read BEFORE the event, not after: detached above, so the customer is the only ref
  // this event can carry, and the excess-payment event below wants the same id.
  const [cus] = await tx
    .select({ publicId: customers.publicId })
    .from(customers)
    .where(eq(customers.id, pay.customerId))
    .limit(1);
  await emitEvent(tx, {
    organizationId,
    businessId,
    type: "payment_succeeded",
    data: buildEventData(
      "payment_succeeded",
      {
        id: pay.publicId,
        status: "succeeded",
        amount_minor: Number(pay.amountMinor),
        currency: pay.currency,
        customer: cus?.publicId ?? null,
      },
      null,
      { settled_async: true, late_capture: true, unapplied: true },
    ),
  });
  const balance = await bucketBalance(tx, pay.customerId, EXCESS_PAYMENT, pay.currency);
  // The same event the manual and offline excess paths emit, so a webhook consumer
  // and the customer timeline see the credit however it arose.
  await emitEvent(tx, {
    organizationId,
    businessId,
    type: "customer_excess_payment_recorded",
    data: buildEventData("customer_excess_payment_recorded", {
      id: cus?.publicId ?? pay.customerId,
      amount_minor: Number(pay.amountMinor),
      currency: pay.currency,
      balance_minor: Number(balance),
      description: "Capture of a debit the customer had abandoned",
    }),
  });
  await emitCustomerChanged(tx, { organizationId, businessId, customerId: pay.customerId });
  log.warn(
    "a capture arrived for an abandoned debit with no invoice to take it — held as customer credit",
    {
      event: "abandoned_capture_unapplied",
      payment: pay.publicId,
      amountMinor: String(pay.amountMinor),
      currency: pay.currency,
      balanceMinor: String(balance),
    },
  );
  return {
    booked: true,
    paymentPublicId: pay.publicId,
    disposition: "excess",
    amountMinor: pay.amountMinor,
    currency: pay.currency,
  };
}

/**
 * Settle a pending payment as FAILED: flip the payment and put the linked
 * invoice (back) into dunning — retry scheduled from the business's offsets
 * using the invoice's attempt count (bumped when the attempt was parked), or
 * `uncollectible` when exhausted. Mirrors the synchronous failure path's events.
 * No-op (returns false) if the payment isn't `pending` anymore.
 */
export async function settlePaymentFailed(
  tx: Tx,
  input: SettleInput & {
    errorCode?: string | null;
    errorText?: string | null;
    retriable?: boolean;
    /**
     * False when a person stopped the debit (`cancelPendingDebit`): the caller decides what
     * the invoice does next, so no retry is scheduled and no dunning event fires.
     */
    rearmDunning?: boolean;
  },
): Promise<boolean> {
  // Unknown → retriable, which is both the historical behaviour and the safe one:
  // a hard verdict here marks the instrument `invalid` and moves the customer onto
  // their backup card, which is too much to conclude from a failure the adapter
  // could not classify.
  const retriable = input.retriable ?? true;
  const now = input.occurredAt ?? stampNow();
  const [pay] = await tx
    .update(payments)
    .set({
      status: "failed",
      failureCode: input.errorCode ?? "reconciled_failed",
      failureMessage: input.errorText ?? "Attempt resolved as failed",
    })
    .where(and(eq(payments.id, input.paymentId), eq(payments.status, "pending")))
    .returning();
  if (!pay) return false;

  const failedRefs = await paymentEventRefs(tx, {
    invoiceId: pay.invoiceId,
    customerId: pay.customerId,
  });
  await emitEvent(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    type: "payment_failed",
    // Same amount/status contract as the synchronous failure in invoicing/service.ts:
    // a consumer must be able to read how much failed straight off the webhook.
    data: buildEventData(
      "payment_failed",
      {
        id: pay.publicId,
        status: "failed",
        amount_minor: Number(pay.amountMinor),
        currency: pay.currency,
        code: pay.failureCode,
        // Payer-facing (`declineMessage`); the raw text stays on the payment row.
        message: await storedPayerDeclineMessage(
          tx,
          { businessId: input.businessId, code: pay.failureCode, message: pay.failureMessage },
          "We could not complete the payment.",
        ),
        retriable,
        invoice: failedRefs.invoice,
        customer: failedRefs.customer,
      },
      null,
      { settled_async: true },
    ),
  });

  let failedInvoice: string | null = null;
  if (pay.invoiceId && input.rearmDunning !== false) {
    const [inv] = await tx
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.id, pay.invoiceId),
          inArray(invoices.status, [...OPEN_INVOICE_STATUSES]),
          // An automatic top-up's purchase is never dunned: its run voids it on a decline.
          sql`${invoices.purpose} is distinct from 'credit_purchase'`,
        ),
      )
      .limit(1);
    failedInvoice = inv?.publicId ?? null;
    if (inv) {
      const [biz] = await tx
        .select({
          retryDays: businesses.dunningRetryDays,
          dunningConfig: businesses.dunningConfig,
          timezone: businesses.timezone,
          billingRulesConfig: businesses.billingRulesConfig,
        })
        .from(businesses)
        .where(eq(businesses.id, input.businessId))
        .limit(1);
      // Respect a merchant stop/pause and offline (auto-collect-off) invoices —
      // a settled-async failure must not clobber those (review fix).
      const [cust] = await tx
        .select({ ac: customers.autoCollection })
        .from(customers)
        .where(eq(customers.id, inv.customerId))
        .limit(1);
      const sub = inv.subscriptionId
        ? ((
            await tx
              .select({ ac: subscriptions.autoCollection, status: subscriptions.status })
              .from(subscriptions)
              .where(eq(subscriptions.id, inv.subscriptionId))
              .limit(1)
          )[0] ?? null)
        : null;
      // attemptCount already counts the parked attempt (bumped when it went pending).
      const dunningCfg = await loadEffectiveDunningConfig(tx, {
        businessId: input.businessId,
        customerId: inv.customerId,
        subscriptionId: inv.subscriptionId,
      });
      // Exclusion and the minimum stop dunning from STARTING; one already running keeps
      // its schedule and the passes hold it.
      const startHeld =
        inv.dunningStatus == null && (await dunningHoldFor(tx, inv, dunningCfg)) !== null;
      const [railRow] = pay.paymentMethodId
        ? await tx
            .select({
              rail: paymentMethods.mandateRail,
              type: paymentMethods.type,
              issuerZones: countries.timezones,
            })
            .from(paymentMethods)
            .leftJoin(countries, eq(countries.code, paymentMethods.issuerCountry))
            .where(eq(paymentMethods.id, pay.paymentMethodId))
            .limit(1)
        : [];
      const mandateRailForPayment = railRow?.rail ?? null;
      const plan = planFailureRearm({
        dunningStatus: inv.dunningStatus,
        currentNextAttemptAt: inv.nextAttemptAt,
        autoCollectOn: isAutoCollectOn(sub?.ac ?? null, cust?.ac),
        retriable,
        newAttemptCount: inv.attemptCount,
        retryDays: dunningCfg.retryDays,
        now,
        mode: dunningCfg.mode,
        skipRetriesForHardFailures: dunningCfg.skipRetriesForHardFailures,
        parkHardDeclines: dunningCfg.parkHardDeclines,
        // Normalized decline code from the async-settled charge failure.
        declineCode: input.errorCode,
        // Master switch + the trial/future and one-time-invoice scope toggles.
        dunningApplies:
          !startHeld &&
          dunningAppliesTo(dunningCfg, {
            hasSubscription: inv.subscriptionId != null,
            subscriptionStatus: sub?.status ?? null,
          }),
        periodEndsAt: dunningPeriodEndsAt(dunningCfg, dunningAnchor(inv)),
        dueDate: dunningAnchor(inv),
        // NPCI caps presentations per RAIL (3 retries on UPI / e-NACH), and the
        // merchant's schedule is per business — so the instrument decides how much
        // of that schedule can actually run. Null for a card or a non-mandate
        // instrument, which are uncapped.
        mandateRail: mandateRailForPayment,
        adaptiveTiming: dunningCfg.adaptiveTiming,
        timezone: biz?.timezone ?? null,
        mandateRevoked: resolveBillingRulesConfig(biz).mandateRevoked,
        issuerZones: railRow?.issuerZones ?? null,
        methodType: railRow?.type ?? null,
        retriesByMethod: dunningCfg.retriesByMethod,
        adaptiveCadence: dunningCfg.adaptiveCadence,
        priorMethods: await priorFailedMethods(tx, inv.id, pay.id),
      });
      // The instant actually written, a change-charge hold included.
      const nextAttempt =
        plan.action === "retry"
          ? heldRetry(plan.nextAttempt, inv.retryHoldUntil).nextAttemptAt
          : null;
      const terminal = plan.action === "exhausted";
      if (plan.action === "retry") {
        await tx
          .update(invoices)
          .set({
            ...heldRetry(plan.nextAttempt, inv.retryHoldUntil),
            status: "payment_due" as const,
            dunningStatus: "in_progress" as const,
          })
          .where(eq(invoices.id, inv.id));
      } else if (plan.action === "parked") {
        // Smart mode, hard-recoverable decline: keep the invoice open, park dunning,
        // no auto-retry; the subscription is NOT cancelled.
        await tx
          .update(invoices)
          .set({
            nextAttemptAt: null,
            status: "payment_due" as const,
            dunningStatus: "parked" as const,
            // The anchor and the ladder are set ON THE WAY IN, once. Re-parking an
            // already-parked invoice must not restart its window — see the note at the
            // same branch in `invoicing/service.ts`.
            ...(inv.dunningStatus === "parked"
              ? {}
              : {
                  dunningParkedAt: now,
                  dunningNextReminderAt: nextParkedReminderAt(
                    dunningCfg,
                    now,
                    now,
                    retryDaysForMethod(dunningCfg, railRow?.type, railRow?.rail),
                  ),
                }),
          })
          .where(eq(invoices.id, inv.id));
      } else if (plan.action === "exhausted") {
        await tx
          .update(invoices)
          .set({
            nextAttemptAt: null,
            status: "not_paid" as const,
            dunningStatus: "exhausted" as const,
            // When dunning gave up (0282) — the dated half of the recovery rate.
            dunningExhaustedAt: now,
            dunningExhaustedCode: pay.failureCode,
          })
          .where(eq(invoices.id, inv.id));
        // A revoked mandate's subscription action, as the sync path applies it.
        const { scheduleRevokedMandateAction } = await import("@/modules/subscriptions/dunning");
        scheduleRevokedMandateAction({
          organizationId: input.organizationId,
          businessId: input.businessId,
          invoicePublicId: inv.publicId,
          subscriptionId: inv.subscriptionId,
          code: pay.failureCode,
          rule: resolveBillingRulesConfig(biz).mandateRevoked,
          config: dunningCfg,
        });
      } else if (plan.action === "offline") {
        await tx
          .update(invoices)
          .set({
            nextAttemptAt: null,
            status: "not_paid" as const,
            ...(isLiveDunning(inv.dunningStatus) ? { dunningStatus: null } : {}),
          })
          .where(eq(invoices.id, inv.id));
      }
      // 'stopped' / 'paused' → leave the invoice's dunning schedule untouched.
      if (terminal) {
        await emitEvent(tx, {
          organizationId: input.organizationId,
          businessId: input.businessId,
          type: "invoice_dunning_exhausted",
          data: buildEventData("invoice_dunning_exhausted", {
            id: inv.publicId,
            attempts: inv.attemptCount,
          }),
        });
        await emitEvent(tx, {
          organizationId: input.organizationId,
          businessId: input.businessId,
          type: "invoice_not_paid",
          data: buildEventData("invoice_not_paid", { id: inv.publicId }),
        });
      } else if (plan.action === "offline") {
        await emitEvent(tx, {
          organizationId: input.organizationId,
          businessId: input.businessId,
          type: "invoice_not_paid",
          data: buildEventData("invoice_not_paid", { id: inv.publicId }),
        });
      } else if (plan.action === "parked") {
        // Parked (smart mode): invoice stays open, subscription retained. Emit
        // invoice_payment_due (not exhausted/not_paid) so downstream still fires.
        await emitEvent(tx, {
          organizationId: input.organizationId,
          businessId: input.businessId,
          type: "invoice_payment_due",
          data: buildEventData(
            "invoice_payment_due",
            { id: inv.publicId, next_attempt_at: null },
            null,
            { dunning: "parked" },
          ),
        });
      } else if (plan.action === "retry") {
        await emitEvent(tx, {
          organizationId: input.organizationId,
          businessId: input.businessId,
          type: "invoice_payment_due",
          data: buildEventData("invoice_payment_due", {
            id: inv.publicId,
            next_attempt_at: nextAttempt,
          }),
        });
        if (inv.attemptCount === 1) {
          await emitEvent(tx, {
            organizationId: input.organizationId,
            businessId: input.businessId,
            type: "invoice_dunning_started",
            data: buildEventData("invoice_dunning_started", { id: inv.publicId }),
          });
        }
      }
      // 'stopped' / 'paused' emit no dunning event — the schedule is preserved.
    }
  }
  if (input.rearmDunning !== false)
    log.warn("in-flight payment settled as FAILED — the invoice re-enters dunning", {
      event: "payment_settled_failed",
      payment: pay.publicId,
      invoice: failedInvoice,
      amountMinor: String(pay.amountMinor),
      currency: pay.currency,
    });
  return true;
}
