/**
 * Serializer + event-snapshot loader for transactions. Split out of
 * `./service` (BLUEPRINT §11 Part B) so `events/content.ts` can load a full
 * transaction snapshot without importing `transactions/service.ts` — that
 * file imports `emitEvent`, which would close the
 * serialize → service → events/emit → events/content → serialize cycle.
 * `./service` re-exports `serializeTransaction` for back-compat.
 */
import { eq } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { transactions, invoices } from "@db/schema";
// From the LEAF module, never from `payment-methods/service` — that file imports
// `events/emit`, which reaches back here via events/content and would close the very
// cycle this file was split out to break.
import { debitAwaitsBuyerAuthentication } from "@/modules/payment-methods/mandate-afa";

type Transaction = typeof transactions.$inferSelect;

export interface TransactionSerializeExtra {
  invoicePublicId?: string | null;
  customerPublicId?: string | null;
  customerEmail?: string | null;
  /** Already resolved by the caller's query (`accountHolderName`), never `customers.name`. */
  customerName?: string | null;
  creditNotePublicId?: string | null;
  subscriptionPublicId?: string | null;
  pmBrand?: string | null;
  pmLast4?: string | null;
  /** The instrument's mandate rail + type — decides `awaiting_authentication`. */
  pmMandateRail?: string | null;
  pmType?: string | null;
  gatewayAccountPublicId?: string | null;
  gatewayAccountName?: string | null;
  refPaymentPublicId?: string | null;
  refPaymentMethodType?: string | null;
  /** The on-session intent this charge came out of; renewals have none. */
  paymentIntentPublicId?: string | null;
  /** `markUnapplied`'s cause when the payment was detached from its invoice. */
  unappliedReason?: string | null;
  /** Newest gateway fraud/manual-review callback for this charge. */
  fraudSignal?: { type: string; providerKey: string; receivedAt: Date } | null;
  /**
   * The settled refund against the money this row would book (#17). Loaded by
   * `getTransactionDetailed` for a reconcilable row and absent everywhere else — the
   * serializer reports absence as `null`, which means "nothing came back that we can see",
   * not "nothing came back".
   */
  settledReturn?: {
    chargeAtGateway: string;
    paymentPublicId: string | null;
    refundPublicId: string | null;
    providerRefundId: string | null;
    refundedMinor: bigint;
    fullyReturned: boolean;
    currency: string | null;
  } | null;
  /**
   * When the clock last asked the gateway about this in-progress charge and when it will
   * ask next. Present only on the single read of an `in_progress` row; `null` means no
   * poll is scheduled, not that none will happen — a row the pass has never deferred is
   * picked up on age alone.
   */
  pollSchedule?: { nextAt: Date; lastPolledAt: Date; attempts: number } | null;
  /** Set when a person may record a chargeback on this payment (single read only). */
  disputeRecording?: { paymentPublicId: string; availableMinor: bigint } | null;
  /** Set when a person may ask the gateway to cancel this debit (single read only). */
  pendingDebitCancel?: { paymentPublicId: string } | null;
}

export function serializeTransaction(t: Transaction, extra?: TransactionSerializeExtra) {
  return {
    object: "transaction",
    id: t.publicId,
    type: t.type,
    status: t.status,
    amount_minor: Number(t.amountMinor),
    currency: t.currency,
    gateway_key: t.gatewayKey,
    id_at_gateway: t.idAtGateway,
    /**
     * WHICH gateway account, and WHAT this reverses.
     *
     * `gateway_key` alone says "razorpay"; a business can have several accounts on one
     * provider and reconciliation happens per ACCOUNT. `reference_payment` is the payment a
     * refund reverses — the first thing anyone asks of a refund, and the link that turns
     * "did this reach the provider?" into a two-click answer instead of a database query.
     * Both were already stored on nearly every refund and simply never served.
     */
    gateway_account: extra?.gatewayAccountPublicId
      ? { id: extra.gatewayAccountPublicId, name: extra.gatewayAccountName ?? null }
      : null,
    reference_payment: extra?.refPaymentPublicId ?? null,
    /**
     * Set when this payment settled after its invoice could take it, so it went to the
     * customer's excess balance instead. The row keeps `invoice`; this says it did not
     * pay it. `null` on every payment that was applied, and on refunds: a refund joins
     * the same payment row, so without the type check the flag would leak onto it.
     */
    unapplied_reason: t.type === "payment" ? (extra?.unappliedReason ?? null) : null,
    /**
     * The key that reaches `gateway_request_logs` — what we actually sent the gateway and what
     * it sent back. That log is platform-global with no FK, so this is the only join there is.
     * Null on historic rows; a trace cannot be reconstructed after the fact.
     */
    trace_id: t.traceId ?? null,
    span_id: t.spanId ?? null,
    error_code: t.errorCode,
    error_text: t.errorText,
    /**
     * THE MONEY ON THIS ROW HAS ALREADY GONE BACK — the one fact the operator Reconcile
     * panel was missing (#17).
     *
     * `txn_XXXXXXXXXXXXXXXXXXXXXX06` rendered "The gateway outcome is unknown" with
     * "Succeeded — money was captured" pre-selected, six minutes after we refunded that
     * exact charge (`rfnd_XXXXXXXXXXXX01`). The outcome was not unknown; we held the
     * gateway's own refund id for it. This is that id, so the panel can state what IS
     * known instead of guessing, and so it stops offering a verdict the engine refuses.
     *
     * Present only on the single-transaction read of a reconcilable row (the only place a
     * verdict is offered); `null` everywhere else.
     */
    settled_refund: extra?.settledReturn
      ? {
          charge_at_gateway: extra.settledReturn.chargeAtGateway,
          payment: extra.settledReturn.paymentPublicId,
          refund: extra.settledReturn.refundPublicId,
          provider_refund_id: extra.settledReturn.providerRefundId,
          refunded_minor: Number(extra.settledReturn.refundedMinor),
          fully_returned: extra.settledReturn.fullyReturned,
          currency: extra.settledReturn.currency,
        }
      : null,
    /**
     * The clock's own schedule for this charge, so the screen can say when it last asked
     * and when it will ask again rather than leaving "in progress" looking like nothing is
     * happening. `attempts` is how many times it has already asked and learned nothing.
     */
    settlement_poll: extra?.pollSchedule
      ? {
          last_polled_at: extra.pollSchedule.lastPolledAt.toISOString(),
          next_poll_at: extra.pollSchedule.nextAt.toISOString(),
          attempts: extra.pollSchedule.attempts,
        }
      : null,
    /**
     * The gateway sends no dispute events, so a person records a chargeback here. `null`
     * when that is not offered (another gateway, not a succeeded payment, or the gateway
     * already reported a dispute). `available_minor` is the most a new dispute may claim.
     */
    dispute_recording: extra?.disputeRecording
      ? {
          payment: extra.disputeRecording.paymentPublicId,
          available_minor: Number(extra.disputeRecording.availableMinor),
        }
      : null,
    /**
     * The debit is in flight on a gateway that can cancel it, so a person may ask it to
     * (`POST /v1/businesses/{biz}/payments/{pay}/cancel_pending_debit`). `null` when not offered.
     */
    pending_debit_cancel: extra?.pendingDebitCancel
      ? { payment: extra.pendingDebitCancel.paymentPublicId }
      : null,
    /**
     * What the gateway said about FRAUD on this charge — kept off `status` on purpose
     * so a flag cannot erase whether the money settled. Single read only; `null` means
     * nothing was reported.
     */
    fraud_signal: extra?.fraudSignal
      ? {
          type: extra.fraudSignal.type,
          gateway_key: extra.fraudSignal.providerKey,
          received_at: extra.fraudSignal.receivedAt.toISOString(),
        }
      : null,
    // null = not a failure (or predates the column); true/false = the gateway's
    // own retriable classification. Drives the Retries screen's Hard/Soft column.
    retriable: t.retriable,
    // NOTE: kept as the raw stored value (t.invoiceId) for back-compat with the
    // existing API response shape — pass `extra.invoicePublicId` to override
    // with the invoice's public id (used by the event-snapshot loader below).
    invoice: extra && "invoicePublicId" in extra ? (extra.invoicePublicId ?? null) : t.invoiceId,
    customer: extra?.customerPublicId ?? null,
    customer_email: extra?.customerEmail ?? null,
    customer_name: extra?.customerName ?? null,
    credit_note: extra?.creditNotePublicId ?? null,
    subscription: extra?.subscriptionPublicId ?? null,
    /**
     * The authorization ceremony behind this charge, walkable from here (the forward hop
     * already worked). `null` is the NORMAL case, not a missing link: an intent exists only
     * where a buyer was present to answer a challenge, so every renewal has none. An id
     * rather than a bare `three_d_secure` boolean: the same fact, minus the guesswork about
     * which intent.
     */
    payment_intent: extra?.paymentIntentPublicId ?? null,
    payment_method:
      extra && (extra.pmBrand != null || extra.pmLast4 != null)
        ? { brand: extra.pmBrand ?? null, last4: extra.pmLast4 ?? null }
        : null,
    /** The instrument class (`card`, `upi`, …) and its mandate rail — brand alone is not the type. */
    instrument:
      extra && (extra.pmType != null || extra.pmMandateRail != null)
        ? { type: extra.pmType ?? null, mandate_rail: extra.pmMandateRail ?? null }
        : null,
    /** Which method type paid, from the payment row: the gateway's answer, not the saved method. */
    method_type: extra?.refPaymentMethodType ?? null,
    /**
     * This attempt is not slow — it is waiting for the CUSTOMER, who has to approve it
     * with their bank. True when the gateway SAID so, or (for a rail that states
     * nothing) when the RBI/NPCI amount rule predicts it. Not amount-gated: an issuer
     * can challenge any figure, and one challenged ₹885 in production.
     *
     * Only ever true while `in_progress`: once the attempt resolves, what happened to
     * it is the answer, not what it was waiting on. An operator reading "in progress"
     * for three days otherwise has no way to know the difference between a netbanking
     * debit that is fine and a card debit that will expire unapproved — and the second
     * one needs them to call the customer.
     */
    awaiting_authentication:
      t.status === "in_progress" &&
      debitAwaitsBuyerAuthentication(
        t,
        { mandateRail: extra?.pmMandateRail ?? null, type: extra?.pmType ?? null },
        t.currency,
        t.amountMinor,
      ),
    occurred_at: t.occurredAt,
    settled_at: t.settledAt,
    /**
     * When the row reached a terminal status — the question `settled_at` cannot answer,
     * since it means cash moved and is null on every failure. Null for `in_progress` and
     * for the two reconcilable statuses, and null on rows that finalised before migration
     * 0230, which is why a client must treat its absence as "unknown", not "unfinished".
     */
    finalised_at: t.finalisedAt,
    created_at: t.createdAt,
    resource_version: t.resourceVersion,
  };
}

/**
 * Full-snapshot loader for event content (BLUEPRINT §11 Part B). Loads a
 * transaction by public id (+ its invoice's public id, if linked), returning
 * the serialized object, or null if not found. `tx` must be the caller's
 * RLS-scoped transaction.
 */
export async function loadTransactionSnapshot(
  tx: Tx,
  txnPublicId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await tx
    .select({ txn: transactions, invPid: invoices.publicId })
    .from(transactions)
    .leftJoin(invoices, eq(transactions.invoiceId, invoices.id))
    .where(eq(transactions.publicId, txnPublicId))
    .limit(1);
  if (!row) return null;
  return serializeTransaction(row.txn, { invoicePublicId: row.invPid ?? null });
}
