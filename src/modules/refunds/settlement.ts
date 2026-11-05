/**
 * Resolving an ACCEPTED refund — the two outcomes, in one place.
 *
 * A refund the provider accepted is recorded `pending` with its ledger pair already
 * booked (see `refundPayment`: acceptance is the commit point, because the reverse below
 * exists). Two things can then happen to it, and each can arrive by two routes: the
 * provider's webhook, or the stale-pending sweep polling when that webhook never came.
 *
 * Both routes call these functions, for the same reason `payments/settlement.ts` exists:
 * a swept outcome and a webhook outcome must be byte-identical in the ledger. A second
 * copy of "flip the row, post the reversal, emit the event" is a second thing to keep in
 * step on the money path, and the copies would diverge exactly once.
 *
 * Every write here is a CONDITIONAL update keyed on the status it expects to find, so a
 * redelivered webhook, a racing sweep, or both at once resolve the refund exactly once —
 * the loser updates zero rows and returns false without posting anything.
 */
import { stampNow } from "@/platform/clock";
import { createLogger } from "@/platform/logger";
import { lockCustomerBalances } from "@/modules/customers/balances-read";
import { and, eq, ne, sql } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { postEntries } from "@/modules/ledger/service";
import {
  EXCESS_PAYMENT,
  EXCESS_REFUND_PENDING,
  REFUNDABLE_CREDIT,
} from "@/modules/customers/balances-read";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { setTransactionStatus } from "@/modules/transactions/service";
import {
  businesses,
  creditNotes,
  ledgerEntries,
  refunds,
  payments,
  transactions,
} from "@db/schema";
import {
  resolveCollectionRulesConfig,
  type DeclinedRefundOutcome,
} from "@/modules/subscriptions/collection-rules-config";

const log = createLogger("refunds.settlement");

type RefundRow = typeof refunds.$inferSelect;

/**
 * The refund landed. Status flip, transaction reconcile, confirmation event — no ledger
 * work, because acceptance already booked it. Booking again here would double the refund.
 *
 * @returns true if THIS call settled it; false if it was already resolved.
 */
export async function settleRefund(ref: RefundRow, now = stampNow()): Promise<boolean> {
  return withTenant(ref.organizationId, async (tx) => {
    const claimed = await tx
      .update(refunds)
      .set({ status: "succeeded" })
      .where(and(eq(refunds.id, ref.id), eq(refunds.status, "pending")))
      .returning({ id: refunds.id });
    if (claimed.length === 0) return false;

    // Recorded `in_progress` at acceptance; it is now money in hand.
    const [txn] = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.refundId, ref.id))
      .limit(1);
    if (txn)
      await setTransactionStatus(tx, ref.organizationId, txn.id, "succeeded", { settledAt: now });

    // Distinct from `refund_created`, which fired on acceptance: re-emitting that type
    // would put two identical events on one refund and leave subscribers unable to tell
    // the instruction from the confirmation. This is what triggers the `refund_issued`
    // email, completing the pair whose first half is `refund_initiated`.
    await emitEvent(tx, {
      organizationId: ref.organizationId,
      businessId: ref.businessId,
      type: "refund_settled",
      data: buildEventData("refund_settled", {
        id: ref.publicId,
        status: "succeeded",
        amount_minor: Number(ref.amountMinor),
        currency: ref.currency,
      }),
    });
    return true;
  });
}

/**
 * The refund did NOT land — refused at the rail, or reversed by the bank. Undo the booking
 * and say so.
 *
 * Reversible from `pending` as well as `succeeded`: a refund books its ledger pair on
 * acceptance, so an accepted-then-refused refund has lines to undo exactly like a settled
 * one. Only `failed` is already done.
 *
 * @returns true if THIS call reversed it; false if it was already failed.
 */
export async function reverseRefund(
  ref: RefundRow,
  opts: {
    failureCode?: string | null;
    /**
     * The gateway itself reported the refund failed (its webhook, or a poll that found it
     * failed). Only then may `declined_refund = issue_credit` give credit: a refund we merely
     * could not find may still have paid out.
     */
    gatewayConfirmed?: boolean;
    /** Claim only a `pending` refund (the not-found sweep): a settled one is left alone. */
    onlyPending?: boolean;
  } = {},
): Promise<boolean> {
  // `refunds` carries no customer; the payment it belongs to does, and the ledger wants it
  // for the customer-scoped balance.
  const [pay] = await systemDb
    .select()
    .from(payments)
    .where(eq(payments.id, ref.paymentId))
    .limit(1);

  // A payout refund flagged as not found, now confirmed failed: decided under the lock on its
  // state now (open → credit; credited → nothing; paid → the normal reversal below).
  if (opts.gatewayConfirmed) {
    const { answerUnconfirmedRefundTx } = await import("@/modules/credit-notes/service");
    const answered = await withTenant(ref.organizationId, (tx) =>
      answerUnconfirmedRefundTx(tx, ref.id, "failure"),
    );
    if (answered !== "proceed") return answered === "done";
  }

  return withTenant(ref.organizationId, async (tx) => {
    const claimed = await tx
      .update(refunds)
      .set({ status: "failed" })
      .where(
        and(
          eq(refunds.id, ref.id),
          opts.onlyPending ? eq(refunds.status, "pending") : ne(refunds.status, "failed"),
        ),
      )
      .returning({ id: refunds.id });
    if (claimed.length === 0) return false;

    // The money never left, so the transaction that was in flight did not succeed.
    const [txn] = await tx
      .select({ id: transactions.id, creditNoteId: transactions.creditNoteId })
      .from(transactions)
      .where(eq(transactions.refundId, ref.id))
      .limit(1);
    if (txn) {
      await setTransactionStatus(tx, ref.organizationId, txn.id, "failed", {
        errorCode: opts.failureCode ?? "refund_failed",
      });
    }

    // Mirror image of the refund's OWN posting: cash comes back, and whichever account the
    // payout debited is credited again. Always crediting `refunds` was right only for a
    // revenue refund — a credit-note payout debits `refunds_payable`, an excess refund an
    // excess account, and undoing either as contra-revenue left the liability cleared.
    const [booked] = await tx
      .select({ account: ledgerEntries.account })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.sourceType, "refund"),
          eq(ledgerEntries.sourceId, ref.publicId),
          eq(ledgerEntries.direction, "debit"),
        ),
      )
      .limit(1);
    const contra = booked?.account ?? "refunds";
    await postEntries(
      {
        organizationId: ref.organizationId,
        businessId: ref.businessId,
        ...(pay?.customerId ? { customerId: pay.customerId } : {}),
        sourceType: "refund_reversal",
        sourceId: ref.publicId,
        lines: [
          {
            account: "cash",
            direction: "debit",
            amountMinor: ref.amountMinor,
            currency: ref.currency,
          },
          {
            account: contra,
            direction: "credit",
            amountMinor: ref.amountMinor,
            currency: ref.currency,
          },
        ],
      },
      tx,
    );
    // A credit-note payout the gateway reports failed: the note counted it as paid out; give
    // that amount back to the note as credit, once. Not for a refund we merely could not find
    // (it may have paid out): that stays as `refunds_payable` for a person to resolve, as a
    // declined revenue refund does. Only `refunds_payable` here and only `refunds` below, so a
    // failure is never given back twice.
    if (contra === "refunds_payable" && txn?.creditNoteId && !opts.gatewayConfirmed) {
      // Flag it on the refund and the note: the credit note page asks a person to mark it
      // paid or return it, and a later answer from the gateway settles it.
      const [note] = await tx
        .select({ customerId: creditNotes.customerId })
        .from(creditNotes)
        .where(eq(creditNotes.id, txn.creditNoteId))
        .limit(1);
      if (note) await lockCustomerBalances(tx, note.customerId);
      await tx.update(refunds).set({ notFoundState: "open" }).where(eq(refunds.id, ref.id));
      await tx
        .update(creditNotes)
        .set({
          payoutUnconfirmedMinor: sql`${creditNotes.payoutUnconfirmedMinor} + ${ref.amountMinor}`,
        })
        .where(eq(creditNotes.id, txn.creditNoteId));
      log.error("credit-note payout refund not found at the gateway — flagged on the note", {
        event: "cn_payout_refund_unconfirmed",
        refund: ref.publicId,
      });
    }
    if (contra === "refunds_payable" && txn?.creditNoteId && opts.gatewayConfirmed) {
      const { releaseFailedCnPayoutTx } = await import("@/modules/credit-notes/service");
      await releaseFailedCnPayoutTx(tx, {
        organizationId: ref.organizationId,
        businessId: ref.businessId,
        cnId: txn.creditNoteId,
        amountMinor: ref.amountMinor,
        reason: opts.failureCode ?? "refund_failed",
      });
    }
    // An excess refund that did not land goes back to the customer's credit, where it was.
    if (contra === EXCESS_REFUND_PENDING && pay) {
      await postEntries(
        {
          organizationId: ref.organizationId,
          businessId: ref.businessId,
          ...(pay.customerId ? { customerId: pay.customerId } : {}),
          sourceType: "excess_refund_release",
          sourceId: pay.publicId,
          lines: [
            {
              account: EXCESS_REFUND_PENDING,
              direction: "debit",
              amountMinor: ref.amountMinor,
              currency: ref.currency,
            },
            {
              account: EXCESS_PAYMENT,
              direction: "credit",
              amountMinor: ref.amountMinor,
              currency: ref.currency,
            },
          ],
        },
        tx,
      );
    }
    // 2.15 "issue credit": a declined revenue refund still goes back to the customer, as
    // refundable credit. The credit note that documented the refund becomes an open
    // refundable note, so it pays their next invoices, can be refunded again, and claims
    // the invoice's refund capacity (no second payout of the same money).
    let creditedMinor = 0n;
    let creditNote: string | null = null;
    if (opts.gatewayConfirmed && contra === "refunds" && pay?.customerId && pay.invoiceId) {
      if ((await declineOutcome(tx, ref)) === "issue_credit") {
        const [doc] = await tx
          .select({ id: creditNotes.id, publicId: creditNotes.publicId })
          .from(creditNotes)
          .where(
            and(
              eq(creditNotes.refundId, ref.id),
              eq(creditNotes.status, "refunded"),
              eq(creditNotes.totalMinor, ref.amountMinor),
            ),
          )
          .limit(1);
        if (doc) {
          await tx
            .update(creditNotes)
            .set({
              status: "refund_due",
              creditMethod: "balance",
              refundedMinor: 0n,
              paidOutMinor: 0n,
              reasonCode: "refund_declined",
            })
            .where(eq(creditNotes.id, doc.id));
          await postEntries(
            {
              organizationId: ref.organizationId,
              businessId: ref.businessId,
              customerId: pay.customerId,
              sourceType: "credit_note",
              sourceId: doc.publicId,
              lines: [
                {
                  account: "refunds",
                  direction: "debit",
                  amountMinor: ref.amountMinor,
                  currency: ref.currency,
                  memo: `Declined refund ${ref.publicId} issued as credit`,
                },
                {
                  account: REFUNDABLE_CREDIT,
                  direction: "credit",
                  amountMinor: ref.amountMinor,
                  currency: ref.currency,
                  memo: `Declined refund ${ref.publicId} issued as credit`,
                },
              ],
            },
            tx,
          );
          creditedMinor = ref.amountMinor;
          creditNote = doc.publicId;
        }
      }
    }
    await emitEvent(tx, {
      organizationId: ref.organizationId,
      businessId: ref.businessId,
      type: "refund_failed",
      data: buildEventData("refund_failed", {
        id: ref.publicId,
        status: "failed",
        amount_minor: Number(ref.amountMinor),
        currency: ref.currency,
        reason: opts.failureCode ?? null,
        ...(creditedMinor > 0n
          ? { credited_minor: Number(creditedMinor), credit_note: creditNote }
          : {}),
      }),
    });
    return true;
  });
}

/** The refund's own `on_decline`, else the business rule. */
async function declineOutcome(
  tx: Tx,
  ref: Pick<RefundRow, "businessId" | "onDecline">,
): Promise<DeclinedRefundOutcome> {
  if (ref.onDecline === "block" || ref.onDecline === "issue_credit") return ref.onDecline;
  const [biz] = await tx
    .select({ billingRulesConfig: businesses.billingRulesConfig })
    .from(businesses)
    .where(eq(businesses.id, ref.businessId))
    .limit(1);
  return resolveCollectionRulesConfig(biz).declinedRefund;
}
