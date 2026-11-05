/**
 * Stop a debit that is still in flight, so an invoice can be settled another way without the
 * payer paying twice.
 *
 * Bank debits (GoCardless, Mollie SEPA, Cashfree Raise-a-Charge, Stripe bank debits) sit
 * `pending` for days. Recording an offline payment, applying credit or voiding the invoice in
 * that window used to leave the debit live, and it collected on top. Every one of those
 * actions now calls `clearPendingDebits` first: the gateway cancels the debit, or the action
 * is refused.
 *
 * The gateway's answer is the only verdict. A debit is booked as stopped only when the
 * adapter OBSERVED it cancelled; a debit the gateway already settled is booked as settled.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { stampNow } from "@/platform/clock";
import { formatMoney } from "@/platform/currency";
import { createLogger } from "@/platform/logger";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { setTransactionStatus } from "@/modules/transactions/service";
import { gatewayDefinition } from "@/providers/gateway-catalog";
import { OPEN_INVOICE_STATUSES } from "@/modules/invoicing/status";
import { invoices, payments, transactions } from "@db/schema";
import { settlePaymentFailed, settleTransactionOutcome } from "./settlement";
import { adapterForTransaction } from "./transaction-adapter";

const log = createLogger("payments");

/** `payments.failure_code` / `transactions.error_code` of a debit we cancelled at the gateway. */
export const DEBIT_CANCELLED_CODE = "debit_cancelled";
const DEBIT_CANCELLED_TEXT =
  "We cancelled this debit before the bank collected it. No money moved.";
const GATEWAY_CANCELLED_TEXT =
  "The payment gateway cancelled this debit before the bank collected it. No money moved.";

/** Who stopped the debit: our operator, an action it cleared the way for, or the gateway. */
type CancelPurpose = "operator" | BlockedAction | "gateway";

export type PendingDebitResult =
  /** The gateway cancelled it. Booked failed; no money moved. */
  | { outcome: "cancelled" }
  /** The gateway had already collected it. Booked as paid. */
  | { outcome: "settled" }
  /** The gateway had already failed it. Booked with the gateway's reason. */
  | { outcome: "failed_at_gateway" }
  /** Still live, and the gateway refused or could not be reached. Nothing was booked. */
  | { outcome: "not_cancelable"; reason?: string }
  /** The gateway has no cancel for a pending debit. Nothing was booked. */
  | { outcome: "unsupported" }
  /** The payment is not pending (settled meanwhile, or never was). */
  | { outcome: "not_pending" };

type Payment = typeof payments.$inferSelect;
type Txn = typeof transactions.$inferSelect;

/** Why a refusal names the gateway: the operator needs to know who said no. */
function gatewayName(key: string | null | undefined): string {
  return gatewayDefinition(key)?.displayName ?? "The payment gateway";
}

/**
 * Ask the gateway to stop one pending payment, and book its answer.
 *
 * On `cancelled` the invoice stops automatic collection (`dunning_status: stopped`, no next
 * attempt; a `posted` invoice becomes `payment_due`), because otherwise the due pass or the
 * stranded-retry sweep would debit it again on the next tick. The caller settles it next, or a
 * person collects it by hand.
 */
export async function cancelPendingDebit(input: {
  organizationId: string;
  businessId: string;
  /** Internal payment id. */
  paymentId: string;
  /** Why: the operator's own "Cancel pending debit", or the action it clears the way for. */
  purpose: "operator" | BlockedAction;
  now?: Date;
}): Promise<PendingDebitResult> {
  const now = input.now ?? stampNow(input.businessId);
  const found = await withTenant(input.organizationId, async (tx) => {
    const [pay] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.businessId, input.businessId), eq(payments.id, input.paymentId)))
      .limit(1);
    if (!pay) return null;
    const [txn] = await tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.businessId, input.businessId),
          eq(transactions.paymentId, pay.id),
          eq(transactions.type, "payment"),
        ),
      )
      .orderBy(desc(transactions.createdAt))
      .limit(1);
    return { pay, txn: txn ?? null };
  });
  if (!found || found.pay.status !== "pending") return { outcome: "not_pending" };
  const { pay, txn } = found;
  const chargeId = txn?.idAtGateway || pay.providerChargeId;
  // A payment request's charge spreads over several invoices: out of scope here.
  if (!txn || !chargeId || txn.paymentRequestId) return { outcome: "unsupported" };

  let adapter;
  try {
    adapter = await adapterForTransaction(txn);
  } catch {
    return { outcome: "unsupported" };
  }
  if (!adapter?.capabilities.pendingDebitCancel || !adapter.cancelPendingCharge)
    return { outcome: "unsupported" };

  let res;
  try {
    res = await adapter.cancelPendingCharge({
      providerChargeId: chargeId,
      idempotencyKey: `cancel-debit-${pay.publicId}`,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    log.warn("could not reach the gateway to cancel a pending debit", {
      event: "pending_debit_cancel_error",
      payment: pay.publicId,
      gateway: txn.gatewayKey,
      error: reason,
    });
    return { outcome: "not_cancelable", reason };
  }

  if (res.status === "cancelled") {
    await bookCancelled(input.organizationId, input.businessId, pay, txn, now, input.purpose);
    log.info("pending debit cancelled at the gateway", {
      event: "pending_debit_cancelled",
      payment: pay.publicId,
      invoice: pay.invoiceId,
      gateway: txn.gatewayKey,
      amountMinor: String(pay.amountMinor),
      currency: pay.currency,
    });
    return { outcome: "cancelled" };
  }

  // Already decided at the gateway: book that, exactly as the stale-pending sweep would.
  const verdict = res.status === "already_final" ? res.charge : undefined;
  if (verdict?.status === "succeeded" || verdict?.status === "failed") {
    const ok = verdict.status === "succeeded";
    const errorCode = ok ? null : (verdict.failure?.code ?? "async_failed");
    const retriable = verdict.failure?.retriable ?? true;
    await withTenant(input.organizationId, async (tx) => {
      await setTransactionStatus(
        tx,
        input.organizationId,
        txn.id,
        ok ? "succeeded" : "failed",
        ok ? {} : { errorCode, retriable },
      );
      await settleTransactionOutcome(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        outcome: ok ? "succeeded" : "failed",
        occurredAt: now,
        txn: {
          ...txn,
          ...(ok
            ? {}
            : {
                errorCode,
                ...(verdict.failure?.message ? { errorText: verdict.failure.message } : {}),
              }),
        },
        ...(ok ? {} : { retriable }),
      });
    });
    return ok ? { outcome: "settled" } : { outcome: "failed_at_gateway" };
  }

  log.info("the gateway would not cancel a pending debit", {
    event: "pending_debit_not_cancelable",
    payment: pay.publicId,
    gateway: txn.gatewayKey,
    reason: res.reason ?? null,
  });
  return { outcome: "not_cancelable", ...(res.reason ? { reason: res.reason } : {}) };
}

/**
 * The gateway reports a pending debit cancelled that we did not cancel (a void in the gateway's
 * own dashboard), by webhook or to the stale-pending sweep. Booked exactly like
 * `cancelPendingDebit`'s `cancelled`: no money moved, so no refund and no ledger posting.
 * False when the payment is no longer pending.
 */
export async function bookDebitCancelledAtGateway(input: {
  organizationId: string;
  businessId: string;
  /** Internal transaction id. */
  transactionId: string;
  now: Date;
}): Promise<boolean> {
  return withTenant(input.organizationId, async (tx) => {
    const [txn] = await tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.businessId, input.businessId),
          eq(transactions.id, input.transactionId),
        ),
      )
      .limit(1);
    return txn ? bookDebitCancelledIn(tx, txn, input.now) : false;
  });
}

/** `bookDebitCancelledAtGateway` in the caller's transaction. */
export async function bookDebitCancelledIn(tx: Tx, txn: Txn, now: Date): Promise<boolean> {
  if (!txn.paymentId || txn.paymentRequestId) return false;
  const [pay] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.businessId, txn.businessId), eq(payments.id, txn.paymentId)))
    .for("update")
    .limit(1);
  if (pay?.status !== "pending") return false;
  await bookCancelledIn(tx, txn.organizationId, txn.businessId, pay, txn, now, "gateway");
  log.info("pending debit cancelled at the gateway by someone else", {
    event: "pending_debit_cancelled_externally",
    payment: pay.publicId,
    invoice: pay.invoiceId,
    gateway: txn.gatewayKey,
  });
  return true;
}

async function bookCancelled(
  organizationId: string,
  businessId: string,
  pay: Payment,
  txn: Txn,
  now: Date,
  purpose: CancelPurpose,
): Promise<void> {
  await withTenant(organizationId, (tx) =>
    bookCancelledIn(tx, organizationId, businessId, pay, txn, now, purpose),
  );
}

async function bookCancelledIn(
  tx: Tx,
  organizationId: string,
  businessId: string,
  pay: Payment,
  txn: Txn,
  now: Date,
  purpose: CancelPurpose,
): Promise<void> {
  const errorText = purpose === "gateway" ? GATEWAY_CANCELLED_TEXT : DEBIT_CANCELLED_TEXT;
  // Who stopped real money, and why — in the same transaction as the booking.
  const { writeAuditLog } = await import("@/modules/audit/service");
  await writeAuditLog(
    {
      organizationId,
      businessId,
      action: "payment.cancel_pending_debit",
      resourceType: "payment",
      resourceId: pay.publicId,
      before: { status: "pending", amount_minor: Number(pay.amountMinor) },
      after: {
        status: "failed",
        failure_code: DEBIT_CANCELLED_CODE,
        gateway: txn.gatewayKey,
        purpose,
      },
    },
    tx,
  );
  await setTransactionStatus(tx, organizationId, txn.id, "failed", {
    errorCode: DEBIT_CANCELLED_CODE,
    errorText,
    retriable: false,
  });
  // `pending` → `failed`, the payment_failed event, no ledger posting: a pending debit
  // never posted cash. Dunning is not re-armed — the next step is the caller's.
  await settlePaymentFailed(tx, {
    organizationId,
    businessId,
    paymentId: pay.id,
    occurredAt: now,
    errorCode: DEBIT_CANCELLED_CODE,
    errorText,
    retriable: false,
    rearmDunning: false,
  });
  if (!pay.invoiceId) return;
  const [inv] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.id, pay.invoiceId))
    .for("update")
    .limit(1);
  if (!inv || !(OPEN_INVOICE_STATUSES as readonly string[]).includes(inv.status)) return;
  // `exhausted` / `success` / `stopped` are finished stories and stay as they are.
  const live =
    inv.dunningStatus == null ||
    inv.dunningStatus === "in_progress" ||
    inv.dunningStatus === "parked" ||
    inv.dunningStatus === "paused";
  await tx
    .update(invoices)
    .set({
      nextAttemptAt: null,
      ...(inv.status === "posted" ? { status: "payment_due" as const } : {}),
      ...(live ? { dunningStatus: "stopped" as const } : {}),
    })
    .where(eq(invoices.id, inv.id));
  if (live)
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "invoice_dunning_stopped",
      data: buildEventData("invoice_dunning_stopped", { id: inv.publicId }),
    });
}

/** What an operator was doing when a live debit stopped them. Feeds the refusal sentence. */
export type BlockedAction = "record_payment" | "apply_credits" | "void";

const ACTION_TEXT: Record<BlockedAction, string> = {
  record_payment: "record a payment on this invoice",
  apply_credits: "apply credit to this invoice",
  void: "void this invoice",
};

/** A debit is still live on the invoice and the gateway did not stop it. */
export class DebitInProgressError extends Error {
  readonly code = "debit_in_progress";
  constructor(message: string) {
    super(message);
    this.name = "DebitInProgressError";
  }
}

/** The refusal an operator reads. Exported for the verify suite. */
export function debitInProgressMessage(
  action: BlockedAction,
  pay: Pick<Payment, "amountMinor" | "currency" | "providerKey">,
  outcome: "not_cancelable" | "unsupported" | "started",
): string {
  const gw = gatewayName(pay.providerKey);
  const why =
    outcome === "unsupported"
      ? `${gw} cannot cancel a debit that is in progress`
      : outcome === "started"
        ? "it started while we processed your request"
        : `${gw} did not cancel it`;
  return (
    `We could not ${ACTION_TEXT[action]}. ` +
    `A debit of ${formatMoney(pay.amountMinor, pay.currency)} is in progress on this invoice, and ${why}. ` +
    "Try again after the debit succeeds or fails. Most debits get a result in 2 to 5 working days."
  );
}

/**
 * Same condition as `paymentInFlightCondition` (invoicing/service.ts), less payment-request
 * children: their charge spans several invoices, and a child whose invoice is paid meanwhile
 * settles as customer credit (`settleRequestTransaction`).
 */
function pendingOn(businessId: string, invoiceId: string) {
  return and(
    eq(payments.businessId, businessId),
    eq(payments.invoiceId, invoiceId),
    eq(payments.status, "pending"),
    isNull(payments.paymentRequestId),
  );
}

/** True when a debit is in flight on the invoice. */
export async function hasPendingDebit(
  organizationId: string,
  businessId: string,
  invoiceId: string,
): Promise<boolean> {
  const [row] = await withTenant(organizationId, (tx) =>
    tx.select({ id: payments.id }).from(payments).where(pendingOn(businessId, invoiceId)).limit(1),
  );
  return Boolean(row);
}

/**
 * The in-transaction re-check, under the caller's invoice lock: a debit that started after
 * `clearPendingDebits` returned refuses the action rather than racing it.
 */
export async function assertNoPendingDebit(
  tx: Tx,
  invoice: Pick<typeof invoices.$inferSelect, "id" | "businessId">,
  action: BlockedAction,
): Promise<void> {
  const [pay] = await tx
    .select()
    .from(payments)
    .where(pendingOn(invoice.businessId, invoice.id))
    .limit(1);
  if (pay) throw new DebitInProgressError(debitInProgressMessage(action, pay, "started"));
}

/** The refusal for the operator's own "Cancel pending debit". */
export function cancelRefusedMessage(
  pay: Pick<Payment, "providerKey">,
  outcome: "not_cancelable" | "unsupported",
): string {
  const gw = gatewayName(pay.providerKey);
  return outcome === "unsupported"
    ? `We could not cancel this debit. ${gw} cannot cancel a debit that is in progress.`
    : `We could not cancel this debit. ${gw} did not cancel it. ` +
        "The debit continues, and the invoice shows the result when the debit succeeds or fails.";
}

/**
 * Cancel every pending debit on the invoice before an operator settles it another way.
 * Throws `DebitInProgressError` for the first debit the gateway does not stop. Returns how
 * many debits the gateway reported settled, so the caller re-reads the invoice when > 0.
 */
export async function clearPendingDebits(input: {
  organizationId: string;
  businessId: string;
  invoiceId: string;
  action: BlockedAction;
}): Promise<{ cancelled: number; settled: number }> {
  const pending = await withTenant(input.organizationId, (tx) =>
    tx.select().from(payments).where(pendingOn(input.businessId, input.invoiceId)),
  );
  let cancelled = 0;
  let settled = 0;
  for (const pay of pending) {
    const res = await cancelPendingDebit({
      organizationId: input.organizationId,
      businessId: input.businessId,
      paymentId: pay.id,
      purpose: input.action,
    });
    if (res.outcome === "cancelled") cancelled++;
    else if (res.outcome === "settled") settled++;
    else if (res.outcome === "not_cancelable" || res.outcome === "unsupported")
      throw new DebitInProgressError(debitInProgressMessage(input.action, pay, res.outcome));
  }
  return { cancelled, settled };
}
