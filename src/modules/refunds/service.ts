import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { DeclinedRefundOutcome } from "@/modules/subscriptions/collection-rules-config";
import { withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { postEntries } from "@/modules/ledger/service";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { getProvider, resolveAdapter } from "@/providers/registry";
import { recordTransaction } from "@/modules/transactions/service";
import {
  payments,
  refunds,
  paymentMethods,
  gatewayAccounts,
  invoices,
  transactions,
  paymentRequests,
  creditNotes,
} from "@db/schema";
import { formatMoney } from "@/platform/currency";
import { creditNoteSpendable } from "@/modules/credit-notes/serialize";
import type { Tx } from "@/platform/db";
import { lockCustomerBalances } from "@/modules/customers/balances-read";
import { createLogger } from "@/platform/logger";
import { ensureSpan } from "@/platform/trace";
import {
  ProviderIndeterminateError,
  ProviderRefusalError,
  type RefundResult,
} from "@/providers/types";

const log = createLogger("refunds");

const PROVIDER_NAMES: Record<string, string> = {
  stripe: "Stripe",
  paypal: "PayPal",
  razorpay: "Razorpay",
  tmtest: "TM Test",
};

export type Refund = typeof refunds.$inferSelect;

export class RefundError extends Error {
  /**
   * STRUCTURAL discriminator for the one refusal that is not a bad request: the named
   * payment does not exist in this business. Routes map `'not_found'` to 404 and every
   * other `RefundError` to 400 — see `refund-routes.ts`. Deliberately a field rather
   * than a message prefix: `scripts/verify-bola.ts` pins the status of these routes, and
   * a `startsWith('No such')` branch would silently re-break the moment someone
   * rephrased the message.
   *
   * `undefined` (the default) = a genuine bad request. Keep it that way: widening this
   * to cover a validation refusal would turn a 400 into a 404 and destroy the error
   * contract while leaving every gate green.
   */
  readonly code?: "not_found";
  constructor(message: string, code?: "not_found") {
    super(message);
    this.name = "RefundError";
    this.code = code;
  }
}

/**
 * The gateway account a refund of this payment must go through, most specific first:
 * the account stamped on the charge transaction, the payment method's vaulting account,
 * then the business's only active account for the provider. A payment captured without
 * a vaulted method (a one-off intent) or imported without one has no method to follow,
 * and the env-keyed legacy adapter is unset in production. Two active accounts on one
 * provider is ambiguous, so that case returns null rather than guess.
 */
export async function refundGatewayAccount(
  tx: Tx,
  input: {
    businessId: string;
    paymentId: string;
    paymentMethodId: string | null;
    providerKey: string;
  },
): Promise<typeof gatewayAccounts.$inferSelect | null> {
  const byId = async (id: string) =>
    (await tx.select().from(gatewayAccounts).where(eq(gatewayAccounts.id, id)).limit(1))[0] ?? null;

  const [charge] = await tx
    .select({ gwa: transactions.gatewayAccountId })
    .from(transactions)
    .where(
      and(
        eq(transactions.paymentId, input.paymentId),
        eq(transactions.type, "payment"),
        eq(transactions.status, "succeeded"),
        isNotNull(transactions.gatewayAccountId),
      ),
    )
    .limit(1);
  if (charge?.gwa) {
    const acc = await byId(charge.gwa);
    if (acc) return acc;
  }
  // A payment-request child: the account that took the request's one charge (0388).
  const [preq] = await tx
    .select({ gwa: paymentRequests.gatewayAccountId })
    .from(payments)
    .innerJoin(paymentRequests, eq(paymentRequests.id, payments.paymentRequestId))
    .where(eq(payments.id, input.paymentId))
    .limit(1);
  if (preq?.gwa) {
    const acc = await byId(preq.gwa);
    if (acc) return acc;
  }

  if (input.paymentMethodId) {
    const [pm] = await tx
      .select({ gwa: paymentMethods.gatewayAccountId })
      .from(paymentMethods)
      .where(eq(paymentMethods.id, input.paymentMethodId))
      .limit(1);
    if (pm?.gwa) {
      const acc = await byId(pm.gwa);
      if (acc) return acc;
    }
  }

  const candidates = await tx
    .select()
    .from(gatewayAccounts)
    .where(
      and(
        eq(gatewayAccounts.businessId, input.businessId),
        eq(gatewayAccounts.gatewayKey, input.providerKey),
        eq(gatewayAccounts.status, "active"),
      ),
    )
    .limit(2);
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * Refund (part of) a succeeded payment. Defaults to the full remaining amount;
 * pass `amountMinor` for a partial refund. The cumulative refunded amount can
 * never exceed the payment. On success: provider refund + a refunds row +
 * contra-revenue/cash ledger entries + a refund.created event.
 *
 * One span per refund: a clock tick's payout sweep refunds many credit notes under one trace.
 */
export async function refundPayment(input: RefundPaymentInput): Promise<Refund> {
  return ensureSpan(() => refundPaymentInSpan(input));
}

type RefundPaymentInput = Parameters<typeof refundPaymentInSpan>[0];

async function refundPaymentInSpan(input: {
  organizationId: string;
  businessId: string;
  paymentPublicId: string;
  amountMinor?: number;
  reason?: string;
  /**
   * Ledger account debited on settle (credit is always `cash`). Defaults to
   * `refunds` (contra-revenue) for a genuine revenue refund. A refundable
   * credit-note payout passes `refunds_payable`, so the gateway payout CLEARS the
   * liability that `refundCreditNote` booked (the CN's expense was already booked
   * as `credit_adjustments` at issue — re-booking `refunds` would double-count it).
   *
   * `excess_payment_balance` is the same idea for money we hold with no invoice
   * behind it — a capture of a debit the customer had abandoned
   * (`settleAbandonedCapture`). It was booked as a liability to them, never as
   * revenue, so paying it back CLEARS that liability; `refunds` would invent a
   * contra-revenue entry for revenue that was never recognised.
   *
   * `excess_refund_pending` is `refundExcessPayment`'s: the excess was already moved there
   * under the customer lock before the gateway call, so the payout clears that instead.
   */
  contraAccount?:
    | "refunds"
    | "refunds_payable"
    | "excess_payment_balance"
    | "excess_refund_pending";
  /** Internal id of the credit note this payout clears — stamped on the refund transaction for the CN timeline. */
  creditNoteId?: string;
  /**
   * The CALLER is already returning the invoice's bucket-funded slices, so this refund
   * must not return them a second time.
   *
   * `refundInvoiceViaCreditNote` is the case: it refunds the card leg through here and
   * restores the promotional slice itself (it reports `creditRestoredMinor`). With the
   * promotional restore below firing too, an invoice that consumed 2000 promo handed back
   * 2000 plus a proportional slice of the card refund — caught by verify:invoices-v2 R3
   * ("promo back in the promo bucket (2000), refundable stays 0").
   *
   * A flag rather than an inference: `contraAccount` does not separate these, because
   * that path refunds real revenue and correctly passes the default `refunds`. Only the
   * caller knows whether it has already settled the buckets.
   */
  bucketsRestoredByCaller?: boolean;
  /**
   * What a gateway decline of this refund does, stored on the row so an async decline
   * honours it. Omitted = the business rule (`declined_refund`).
   */
  onDecline?: DeclinedRefundOutcome;
}): Promise<Refund> {
  const { organizationId, businessId } = input;

  // 2.15: a declined refund reopened as credit is paid out first, through its credit note,
  // so a retried refund never pays the same money as credit and as cash.
  if ((input.contraAccount ?? "refunds") === "refunds" && !input.creditNoteId) {
    const paidOut = await payOutReopenedCredit(input);
    if (paidOut) return paidOut;
  }

  /**
   * ── EVERY CHECK BELOW HAPPENS UNDER A LOCK, AND RESERVES BEFORE IT SPENDS ──────
   *
   * This block used to be three separate transactions — read the payment, sum prior refunds,
   * check the credit-note claim — followed by a provider call and only THEN a refund row. Two
   * refunders arriving together each read `refunded = 0`, each computed the full amount as
   * remaining, and each called the gateway. **Measured: five concurrent full refunds of a 1500
   * payment asked the gateway for 1500 five times — 7500 of real money out against 1500
   * collected, with the ledger crediting 7500 cash.** `verify:concurrent-refund` is that
   * measurement, kept as a gate.
   *
   * It is the same read-then-act shape as the 0162 double-book on `collectInvoice`, but with
   * neither of that path's defences: the provider idempotency key is this refund's OWN new
   * public id, so two racers build DIFFERENT keys and the gateway cannot deduplicate them, and
   * `refunds` has no `provider_refund_id` uniqueness to mirror `payments_provider_charge_uq`.
   * Money OUT is the worse direction — an over-collection is visible and refundable, an
   * over-refund is cash gone to someone who was not expecting it.
   *
   * Two changes fix it, and the second is a correctness fix independent of concurrency:
   *
   *   1. `FOR UPDATE` on the payment row. Refunds of one payment now serialise; a second
   *      refunder waits and then reads the first one's reservation.
   *   2. In-flight refunds CLAIM capacity. The old sum counted only `status = 'succeeded'`, so
   *      a PENDING refund claimed nothing — meaning even sequentially, against a gateway that
   *      settles asynchronously, a second full refund was allowed while the first was still in
   *      flight. Anything not `failed` now counts.
   *
   * The reservation row is inserted here, before the gateway is called, so it is visible to the
   * next refunder. Every failure path below must mark it `failed` — a reservation left pending
   * would claim capacity forever and block legitimate refunds.
   */
  const pubId = publicId("re");
  const reserved = await withTenant(organizationId, async (tx) => {
    const [pay] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.businessId, businessId), eq(payments.publicId, input.paymentPublicId)))
      .limit(1)
      .for("update");
    if (!pay) return null;

    // Anything not failed claims capacity — see (2) above.
    const prior = await tx.select().from(refunds).where(eq(refunds.paymentId, pay.id));
    const refunded = prior
      .filter((r) => r.status !== "failed")
      .reduce((sum, r) => sum + r.amountMinor, 0n);

    if (pay.status !== "succeeded")
      throw new RefundError("You can refund only a succeeded payment");
    // A payment-request child carries no charge id: it refunds part of the request's charge.
    if (!pay.providerChargeId && pay.paymentRequestId) {
      const { requestChargeForChild } = await import("@/modules/payment-requests/gateway-hooks");
      const charge = await requestChargeForChild(tx, pay);
      if (charge) {
        pay.providerChargeId = charge.providerChargeId;
        if (charge.providerKey) pay.providerKey = charge.providerKey;
      }
    }
    if (!pay.providerChargeId) throw new RefundError("Payment has no provider charge to refund");

    const remaining = pay.amountMinor - refunded;
    const amount = input.amountMinor != null ? BigInt(input.amountMinor) : remaining;
    if (amount <= 0n) throw new RefundError("Refund amount must be positive");
    if (amount > remaining) {
      throw new RefundError(
        `Refund ${amount} exceeds the remaining refundable amount ${remaining}. The payment is ${pay.amountMinor}, and ${refunded} is already refunded.`,
      );
    }

    // A DIRECT revenue refund must also respect what LIVE CREDIT NOTES already claim
    // against the invoice. `remaining` above only knows about refunds on this payment; it does
    // not know the customer already holds an open claim on the same money. Paying out on top of
    // that claim creates refund capacity no cash backs: a 1,000.00 invoice carrying 8.00 paid
    // out plus 997.00 still claimed is 1,005.00 of exposure against 1,000.00 collected, so the
    // call is refused.
    //
    // A CREDIT-NOTE payout is exempt, and is the path to use instead: it DRAWS DOWN
    // that claim (`refunds_payable` / a stamped `creditNoteId`) rather than adding a second one.
    // Keep both halves of the predicate — `refundCreditNote` → `payOutRefundsPayable` re-enters
    // here, and catching it would deadlock the very flow this error recommends.
    //
    // Runs on THIS transaction, so it sees the same locked snapshot as the sum above.
    const isDirectRevenueRefund =
      (input.contraAccount ?? "refunds") === "refunds" && !input.creditNoteId;
    if (isDirectRevenueRefund && pay.invoiceId) {
      const { refundableCapacityForInvoice } = await import("@/modules/credit-notes/service");
      const { available } = await refundableCapacityForInvoice(tx, pay.invoiceId);
      const [inv] = await tx
        .select({ publicId: invoices.publicId })
        .from(invoices)
        .where(eq(invoices.id, pay.invoiceId))
        .limit(1);
      const invoicePublicId = inv?.publicId ?? pay.invoiceId;
      if (available <= 0n) {
        throw new RefundError(
          `The credit notes of invoice ${invoicePublicId} already claim its full amount. ` +
            `Refund the credit note instead of the payment.`,
        );
      }
      if (amount > available) {
        throw new RefundError(
          `Refund ${amount} exceeds the ${available} still unclaimed on invoice ` +
            `${invoicePublicId}. Its credit notes claim the rest. Refund those credit notes instead.`,
        );
      }
    }

    // The reservation. Inserted under the lock so the next refunder's sum sees it.
    const [reservation] = await tx
      .insert(refunds)
      .values({
        organizationId,
        businessId,
        paymentId: pay.id,
        publicId: pubId,
        status: "pending",
        amountMinor: amount,
        currency: pay.currency,
        reason: input.reason ?? null,
        providerKey: pay.providerKey,
        providerRefundId: null,
        onDecline: input.onDecline ?? null,
      })
      .returning();
    // `providerChargeId` is carried out NARROWED. The throw that guarantees it is non-null
    // happens inside this callback, so the narrowing does not survive to the outer scope —
    // and re-checking out there would add an unreachable branch that leaves the reservation
    // pending if it ever fired.
    return { pay, amount, providerChargeId: pay.providerChargeId, reservation: reservation! };
  });
  if (!reserved)
    throw new RefundError(`We could not find the payment ${input.paymentPublicId}.`, "not_found");
  const { pay, amount } = reserved;

  /** Release the reservation so it stops claiming capacity. */
  const failReservation = async () => {
    await withTenant(organizationId, (tx) =>
      tx.update(refunds).set({ status: "failed" }).where(eq(refunds.id, reserved.reservation.id)),
    );
  };

  // Resolve the refund adapter through the gateway account that took the charge, else legacy.
  const account = await withTenant(organizationId, (tx) =>
    refundGatewayAccount(tx, {
      businessId,
      paymentId: pay.id,
      paymentMethodId: pay.paymentMethodId,
      providerKey: pay.providerKey,
    }),
  );
  const gatewayKey = account?.gatewayKey ?? pay.providerKey;

  // Resolving the adapter can itself throw (unconfigured/unknown provider —
  // the removed 'mock' test double used to paper over this by always
  // returning a working adapter). That failure is just as much a refund
  // failure as a provider-side decline, so it must be recorded/emitted the
  // same way rather than surfacing as a bare, unrecorded exception.
  let provider: ReturnType<typeof getProvider>;
  try {
    provider = account ? resolveAdapter(account) : getProvider(pay.providerKey);
  } catch (e) {
    // Shown to the operator: without an account the raw error is the env-keyed adapter's
    // setup hint, which no production operator can act on. The log keeps the raw cause.
    const message = account
      ? e instanceof Error
        ? e.message
        : "We could not find the provider adapter."
      : `No ${PROVIDER_NAMES[pay.providerKey] ?? pay.providerKey} gateway account is connected ` +
        `to this business for this payment. Connect one, or record the refund offline.`;
    // Recorded as a failed refund transaction below — logged too, because this one
    // is a CONFIG failure (no adapter) wearing the costume of a gateway decline.
    log.error(e, {
      event: "refund_provider_unresolved",
      payment: pay.publicId,
      gatewayKey,
      businessId: businessId,
    });
    // Release first: a reservation left pending would claim this payment's refund capacity
    // forever and block a legitimate retry once the adapter is configured.
    await failReservation();
    await recordTransaction({
      organizationId,
      businessId,
      customerId: pay.customerId,
      type: "refund",
      status: "failed",
      amountMinor: amount,
      currency: pay.currency,
      gatewayAccountId: account?.id ?? null,
      gatewayKey,
      idAtGateway: null,
      paymentId: pay.id,
      paymentMethodId: pay.paymentMethodId,
      invoiceId: pay.invoiceId,
      creditNoteId: input.creditNoteId,
      errorCode: "provider_unresolved",
      errorText: message,
    });
    await withTenant(organizationId, (tx) =>
      emitEvent(tx, {
        organizationId,
        businessId,
        type: "refund_failed",
        data: buildEventData("refund_failed", {
          id: pubId,
          payment: pay.publicId,
          amount_minor: Number(amount),
          currency: pay.currency,
        }),
      }),
    );
    throw new RefundError(`We could not refund payment ${pay.publicId}: ${message}`);
  }

  /**
   * A lost answer keeps the reservation pending: the refund may exist, so it must keep
   * claiming capacity. An adapter that can find a refund by our tag (`locateRefund`) books
   * it as ACCEPTED with no gateway id; the webhook (matched by `pubId`) or the stale-refund
   * sweep later adopts the id and settles or reverses it. Without that lookup nothing could
   * resolve a booking, so the error goes back to the caller and an operator reconciles.
   */
  let result: RefundResult;
  try {
    result = await provider.refund({
      providerChargeId: reserved.providerChargeId,
      amountMinor: amount,
      currency: pay.currency,
      idempotencyKey: pubId,
      // #31: a Refund is its OWN gateway object and does NOT inherit the PaymentIntent's
      // metadata, so `refund.failed` describes an object nothing tags unless we tag it
      // here. `pubId` is this refund's public id, reserved before the gateway call (see
      // the reservation note above) — which is exactly why it is available to stamp.
      ownershipRef: pubId,
      reason: input.reason,
    });
  } catch (e) {
    if (e instanceof ProviderIndeterminateError) {
      log.error(e, {
        event: "refund_gateway_indeterminate",
        refund: pubId,
        payment: pay.publicId,
        gatewayKey,
      });
      if (!provider.locateRefund) throw e;
      result = { status: "pending", providerRefundId: "" };
    } else {
      // A definite refusal sent nothing: release the reservation and tell the operator why.
      // Anything else may have reached the gateway, so the reservation stays.
      if (!(e instanceof ProviderRefusalError)) throw e;
      await failReservation();
      await recordTransaction({
        organizationId,
        businessId,
        customerId: pay.customerId,
        type: "refund",
        status: "failed",
        amountMinor: amount,
        currency: pay.currency,
        gatewayAccountId: account?.id ?? null,
        gatewayKey,
        idAtGateway: null,
        paymentId: pay.id,
        paymentMethodId: pay.paymentMethodId,
        invoiceId: pay.invoiceId,
        creditNoteId: input.creditNoteId,
        errorCode: "refund_refused",
        errorText: e.message,
      });
      await withTenant(organizationId, (tx) =>
        emitEvent(tx, {
          organizationId,
          businessId,
          type: "refund_failed",
          data: buildEventData("refund_failed", {
            id: pubId,
            payment: pay.publicId,
            amount_minor: Number(amount),
            currency: pay.currency,
          }),
        }),
      );
      throw new RefundError(`We could not refund payment ${pay.publicId}. ${e.message}`);
    }
  }
  if (result.status === "failed") {
    // Release first, for the same reason as above: the gateway refused, so this reservation
    // must stop claiming capacity or the customer can never be refunded at all.
    await failReservation();
    // Record a failed refund transaction + event, then surface the error.
    await recordTransaction({
      organizationId,
      businessId,
      customerId: pay.customerId,
      type: "refund",
      status: "failed",
      amountMinor: amount,
      currency: pay.currency,
      gatewayAccountId: account?.id ?? null,
      gatewayKey,
      idAtGateway: result.providerRefundId ?? null,
      paymentId: pay.id,
      paymentMethodId: pay.paymentMethodId,
      invoiceId: pay.invoiceId,
      creditNoteId: input.creditNoteId,
      errorCode: "refund_failed",
      errorText: result.failureMessage ?? "The payment gateway refused the refund.",
    });
    await withTenant(organizationId, (tx) =>
      emitEvent(tx, {
        organizationId,
        businessId,
        type: "refund_failed",
        data: buildEventData("refund_failed", {
          id: pubId,
          payment: pay.publicId,
          amount_minor: Number(amount),
          currency: pay.currency,
        }),
      }),
    );
    throw new RefundError(
      `We could not refund payment ${pay.publicId}. ${result.failureMessage ?? "The payment gateway refused the refund."}`,
    );
  }

  // Record refund + ledger + event atomically.
  return withTenant(organizationId, async (tx) => {
    // UPDATE, not insert: the row already exists as the reservation taken under the payment
    // lock above. Inserting here would create a second row and put the capacity accounting
    // back where it started.
    const [refund] = await tx
      .update(refunds)
      .set({
        status: result.status === "succeeded" ? "succeeded" : "pending",
        providerRefundId: result.providerRefundId || null,
      })
      .where(eq(refunds.id, reserved.reservation.id))
      .returning();

    /**
     * ACCEPTED is the commit point, not settled.
     *
     * This used to be `result.status === 'succeeded'`, so a refund the provider had merely
     * accepted booked nothing — and nothing ever settled it, because the webhook that says
     * "it went through" is dropped as a duplicate (see reconcileRefundWebhook). The money
     * was therefore committed on the rail and invisible in the ledger indefinitely, which
     * overstates cash and leaves `remaining refundable` wrong for days.
     *
     * Booking on acceptance is safe precisely because the reverse already exists: a refund
     * that later fails is unwound by the `refund_reversal` posting in the `refund.failed`
     * handler. Deferring instead would mean replaying this entire block at settlement —
     * ledger, promotional restoration and the refunded credit note — from creation-time
     * inputs (`contraAccount`, `creditNoteId`, `bucketsRestoredByCaller`) that the `refunds`
     * row does not store. Settlement is now just a status flip.
     */
    const committed = result.status !== "failed";
    if (committed) {
      // Money returned to the customer: cash credit against either contra-revenue
      // (`refunds`) or, for a credit-note payout, the `refunds_payable` liability
      // the CN already booked.
      const contra = input.contraAccount ?? "refunds";
      await postEntries(
        {
          organizationId,
          businessId,
          customerId: pay.customerId,
          sourceType: "refund",
          sourceId: refund!.publicId,
          lines: [
            { account: contra, direction: "debit", amountMinor: amount, currency: pay.currency },
            { account: "cash", direction: "credit", amountMinor: amount, currency: pay.currency },
          ],
        },
        tx,
      );

      // ── RETURN THE PROMOTIONAL SLICE OF WHAT WAS REFUNDED (2026-08-28) ─────────────
      // An invoice part-funded by promotional credit was paid with a MIX. Handing back
      // only the cash keeps the promo share, so a customer refunded in full ends up
      // poorer than before they subscribed. The credit-note path has always split by
      // funding (`restoreBucketFundedSlices`, via proration.ts) — the CASH REFUND path
      // never did.
      //
      // PROPORTIONAL TO CASH PAID, measured rather than fitted — three refunds against
      // one invoice (promo 1870600 applied, cash 4414616 collected):
      //
      //     refund 220731 → 93530     ratio 0.4237
      //     refund 441462 → 187054    ratio 0.4237
      //     refund 882923 → 374115    ratio 0.4237
      //
      // Constant across an order of magnitude, and equal to promo/cash (0.4237) rather
      // than promo/pre-tax-base (0.5000) — so the denominator is CASH COLLECTED, not the
      // taxable base. That is also the only self-consistent reading: refunding the whole
      // invoice returns exactly the whole grant.
      //
      // Guarded on `promotionalCreditsAppliedMinor > 0`, so an invoice with no promo
      // behind it books nothing extra and every existing fixture stays byte-identical.
      //
      // ONLY a genuine revenue refund (`refunds`). A credit-note PAYOUT
      // (`refunds_payable`) is settling a note whose funding split was already decided
      // when it was issued — returning a promotional slice here would hand the same
      // money back twice. Same for `excess_payment_balance`, which is paying back a
      // liability that never had an invoice's funding mix behind it: a partial payout of
      // a refundable note adds nothing to the promotional balance.
      if (
        pay.invoiceId &&
        (input.contraAccount ?? "refunds") === "refunds" &&
        !input.bucketsRestoredByCaller
      ) {
        const [inv] = await tx
          .select({
            publicId: invoices.publicId,
            promo: invoices.promotionalCreditsAppliedMinor,
            customerId: invoices.customerId,
          })
          .from(invoices)
          .where(eq(invoices.id, pay.invoiceId))
          .limit(1);
        const promoApplied = inv?.promo ?? 0n;
        // ── THE DENOMINATOR IS THE INVOICE'S CASH, NOT THIS PAYMENT'S (fixed 2026-08-28) ──
        // It was `pay.amountMinor`, under a comment claiming that "summing every payment on
        // the invoice would over-return on an invoice settled by more than one". That is
        // backwards, and it contradicted the measured comment fifteen lines above, which
        // this code was supposed to implement: the measured ratio is promo/CASH COLLECTED
        // (0.4237, constant across three refunds an order of magnitude apart), and the whole
        // point of that reading is that "refunding the whole invoice returns exactly the whole
        // grant". Per-payment over-returns; summing does not.
        //
        // The two agreed only because `pay.amountMinor == cash collected` whenever an invoice
        // has ONE payment, as every fixture in the repo did. Measured on a two-payment
        // invoice (promo 2000, cash 4000+4000): each full leg
        // refund returned the entire 2000, so 4000 came back against 2000 ever consumed —
        // spendable promotional credit created from nothing.
        //
        // Two gateway payments on one invoice is a REACHABLE state, not a theoretical one: a
        // late capture smaller than the outstanding amount books a succeeded gateway payment
        // and deliberately leaves the invoice open (`settlement.ts`, "an ordinary part
        // payment"), so the next payment settles the rest.
        //
        // Single-payment invoices are byte-identical — `cashCollected` is then exactly
        // `pay.amountMinor` — so every existing fixture stands.
        const cashCollected = inv
          ? (
              await tx
                .select({ amountMinor: payments.amountMinor })
                .from(payments)
                .where(and(eq(payments.invoiceId, pay.invoiceId), eq(payments.status, "succeeded")))
            ).reduce((sum, p) => sum + p.amountMinor, 0n)
          : 0n;
        if (inv && promoApplied > 0n && cashCollected > 0n) {
          // CAPPED at what the invoice has not already given back. The proportional share is
          // now right for every shape this path can see, but the cap is what makes it robust
          // to the ones it cannot: a repeat refund, integer-division rounding across many
          // legs, or a credit note that already restored part of the pool for this invoice
          // (`creditOneInvoice` caps against the same figure — one rule, one reader).
          // An invoice can never hand back more promotional credit than it took.
          const { restoreBucketFundedSlices, promoRestoredForInvoice } =
            await import("@/modules/subscriptions/cancellation-credit");
          const alreadyRestored = await promoRestoredForInvoice(tx, businessId, inv.publicId);
          const remaining = promoApplied > alreadyRestored ? promoApplied - alreadyRestored : 0n;
          const proportional = (amount * promoApplied) / cashCollected;
          const promoBack = proportional < remaining ? proportional : remaining;
          if (promoBack > 0n) {
            // `restoreBucketFundedSlices`' contract is that the CALLER holds this lock, and
            // this was the one bucket mutation in the codebase that did not take it — the
            // other twelve all do. The `FOR UPDATE` this function takes on the PAYMENT row
            // serialises refunds of one payment; it does nothing about two legs of one
            // invoice, or about a concurrent credit note touching the same customer.
            await lockCustomerBalances(tx, inv.customerId);
            await restoreBucketFundedSlices(tx, {
              organizationId,
              businessId,
              customerId: inv.customerId,
              currency: pay.currency,
              invoicePublicId: inv.publicId,
              promotional: promoBack,
              excess: 0n,
              sourceType: "refund",
              reasonCode: "promotional_credit_returned_on_refund",
            });
          }
        }
        // Credit grants the invoice drew come back in the same proportion (G3), capped at what
        // is still drawn. They are never part of the cash refunded.
        if (inv && cashCollected > 0n) {
          const [g] = await tx
            .select({
              pre: invoices.grantCreditsPreTaxMinor,
              post: invoices.grantCreditsPostTaxMinor,
              id: invoices.id,
            })
            .from(invoices)
            .where(eq(invoices.id, pay.invoiceId))
            .limit(1);
          const grantApplied = (g?.pre ?? 0n) + (g?.post ?? 0n);
          if (g && grantApplied > 0n) {
            const { restoreGrantDraws } = await import("@/modules/credits/service");
            await restoreGrantDraws(tx, {
              organizationId,
              businessId,
              customerId: inv.customerId,
              invoiceId: g.id,
              invoicePublicId: inv.publicId,
              faceMinor: (amount * grantApplied) / cashCollected,
              ledger: true,
              sourceType: "refund",
            });
          }
        }
      }
    }

    await recordTransaction(
      {
        organizationId,
        businessId,
        customerId: pay.customerId,
        type: "refund",
        // `in_progress` for a lost answer too: an operator verdict (`timeout`) settles
        // payments, not refunds; the webhook or the sweep resolves this one.
        status: result.status === "succeeded" ? "succeeded" : "in_progress",
        amountMinor: amount,
        currency: pay.currency,
        gatewayAccountId: account?.id ?? null,
        gatewayKey,
        idAtGateway: result.providerRefundId || null,
        paymentId: pay.id,
        paymentMethodId: pay.paymentMethodId,
        refundId: refund!.id,
        invoiceId: pay.invoiceId,
        creditNoteId: input.creditNoteId,
      },
      tx,
    );
    // The refund payload carries the invoice ref so event enrichment can attach
    // customer/subscription snapshots.
    let invoicePublicId: string | null = null;
    if (pay.invoiceId) {
      const [inv] = await tx
        .select({ publicId: invoices.publicId })
        .from(invoices)
        .where(eq(invoices.id, pay.invoiceId))
        .limit(1);
      invoicePublicId = inv?.publicId ?? null;
    }
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "refund_created",
      data: buildEventData("refund_created", {
        // The REAL status, not a hardcoded 'succeeded'. This literal used to say the refund
        // had settled even when the provider had only accepted it — the row beside it is
        // written `pending` and the transaction `in_progress` — so a customer whose bank
        // refund was days away was emailed "your refund has been issued". Subscribers keyed
        // off this too. `emailTypeForEvent` now splits on it: pending → refund_initiated.
        id: refund!.publicId,
        status: result.status === "succeeded" ? "succeeded" : "pending",
        payment: pay.publicId,
        amount_minor: Number(amount),
        currency: pay.currency,
        ...(invoicePublicId ? { invoice: invoicePublicId } : {}),
      }),
    });

    // A succeeded refund of an INVOICE-LINKED payment issues a `refunded` credit
    // note documenting the money returned (emits
    // `credit_note_created`). Guards, to keep money booked exactly ONCE and avoid a
    // loop with the inverse flow (`refundCreditNote` → payout → refundPayment):
    //  - only genuine revenue refunds (`contraAccount` = 'refunds'); a CN payout uses
    //    'refunds_payable' and the CN it clears already exists.
    //  - only when NOT stamped with a `creditNoteId` (a CN-driven payout).
    // The CN books NO ledger entries of its own — this tx already booked dr `refunds`
    // / cr `cash` above (`createRefundedCreditNote` is document-only).
    const isRevenueRefund = (input.contraAccount ?? "refunds") === "refunds" && !input.creditNoteId;
    // `committed`, not `succeeded`, for the reason given above: the document follows the
    // booking, and the booking now happens on acceptance. Issuing it here keeps the CN and
    // the ledger pair that funds it in ONE transaction — the alternative is re-deriving this
    // call's inputs at settlement from a row that does not carry them.
    if (committed && pay.invoiceId && isRevenueRefund && invoicePublicId) {
      const { createRefundedCreditNote } = await import("@/modules/credit-notes/service");
      await createRefundedCreditNote(tx, {
        organizationId,
        businessId,
        customerId: pay.customerId,
        invoiceId: pay.invoiceId,
        invoicePublicId,
        currency: pay.currency,
        amountMinor: amount,
        reasonCode: "refund",
        reason: input.reason ?? undefined,
        refundId: refund!.id,
      });
    }
    return refund!;
  });
}

/**
 * The refund that paid out a declined refund's reopened credit note, or null when the
 * payment has none. Refuses an amount above that credit: the rest is a separate refund.
 */
async function payOutReopenedCredit(input: {
  organizationId: string;
  businessId: string;
  paymentPublicId: string;
  amountMinor?: number;
  reason?: string;
}): Promise<Refund | null> {
  const notes = await withTenant(input.organizationId, (tx) =>
    tx
      .select({ cn: creditNotes })
      .from(creditNotes)
      .innerJoin(refunds, eq(refunds.id, creditNotes.refundId))
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .where(
        and(
          eq(payments.businessId, input.businessId),
          eq(payments.publicId, input.paymentPublicId),
          eq(refunds.status, "failed"),
          eq(creditNotes.status, "refund_due"),
        ),
      ),
  );
  const open = notes
    .map((n) => ({ cn: n.cn, left: creditNoteSpendable(n.cn) }))
    .filter((n) => n.left > 0n);
  if (!open.length) return null;
  const first = open[0]!;
  const asked = input.amountMinor != null ? BigInt(input.amountMinor) : null;
  if (asked == null || asked > first.left)
    throw new RefundError(
      `We could not refund the payment. ${formatMoney(first.left, first.cn.currency)} of it is credit from a refund that the gateway declined. Refund ${formatMoney(first.left, first.cn.currency)} or less first: we pay out that credit. Then refund the rest.`,
    );
  const invoiceRefunds = () =>
    withTenant(input.organizationId, (tx) =>
      tx
        .select({ r: refunds })
        .from(refunds)
        .innerJoin(payments, eq(payments.id, refunds.paymentId))
        .where(eq(payments.invoiceId, first.cn.invoiceId)),
    );
  const before = new Set((await invoiceRefunds()).map((x) => x.r.id));
  // No lock here: `refundCreditNote` takes the customer-balance lock, re-reads the note and
  // refuses more than it has available, so two racing calls cannot both pay it out.
  const { refundCreditNote } = await import("@/modules/credit-notes/service");
  await refundCreditNote({
    organizationId: input.organizationId,
    businessId: input.businessId,
    creditNotePublicId: first.cn.publicId,
    amountMinor: Number(asked),
    ...(input.reason ? { reason: input.reason } : {}),
  });
  const row = (await invoiceRefunds()).find((x) => !before.has(x.r.id));
  if (!row) throw new RefundError("We could not refund the payment. Try again.");
  return row.r;
}

export async function listRefunds(organizationId: string, paymentId: string): Promise<Refund[]> {
  return withTenant(organizationId, async (tx) =>
    tx.select().from(refunds).where(eq(refunds.paymentId, paymentId)),
  );
}

/** What a gateway charge's money is currently doing on our side. */
export interface ChargeReturnState {
  /** A SUCCEEDED payment exists for this gateway charge id. */
  settled: boolean;
  /** How much of it has come back, counting SUCCEEDED refunds only, in minor units. */
  refundedMinor: bigint;
  /** True when the whole settled amount has been returned. */
  fullyReturned: boolean;
  /** The payment we matched, for the message an operator reads. */
  paymentPublicId: string | null;
  /** The newest succeeded refund — the id to chase at the gateway. */
  refundPublicId: string | null;
  /** The gateway's own refund id, which is what the gateway's dashboard shows. */
  providerRefundId: string | null;
  currency: string | null;
}

/**
 * "Has the money behind this gateway charge already come back?" — one implementation.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Measured 2026-09-03 on INV-7824. RazorPay delivered `payment.authorized` LAST — 21
 * minutes out of order, after `payment.captured` and after our own refund — and the
 * handler treated it as live, because the only staleness test it had was the INTENT's
 * own status (`pi.status === 'consumed' | 'voided'`, `webhooks/inbound.ts`). The intent
 * was neither: the buyer's browser never posted the second leg, so nothing local ever
 * tied the intent to the payment it produced. The late event therefore raised
 * `authorization_unappliable` — "The gateway holds 2218400 INR for this invoice, which
 * now owes 0" — six minutes after we had refunded that exact charge ourselves, and the
 * operator's Reconcile panel offered to book it as a success. See #17 in docs/PROGRESS.md.
 *
 * The fact needed to refuse both of those is the same fact, which is why it lives in one
 * place: two implementations of "already refunded?" that disagreed would be worse than
 * none, because each caller would be individually defensible.
 *
 * ── WHY IT MATCHES ON THE CHARGE ID rather than a foreign key ──────────────────────
 * `payments` has no `payment_intent_id` column, and the capture records no transaction
 * at all (`settleAbandonedCapture` books the payment and the ledger, not a transaction).
 * The gateway's charge id is the ONE identifier every side of this carries: the intent
 * event names it, the payment stores it in `provider_charge_id`, and the refund hangs
 * off that payment. Adding the column would be a schema change and a backfill to learn
 * something already derivable — so this reads what is there. If the column is ever added,
 * this function is the only place that has to change.
 *
 * ⚠ SUCCEEDED refunds only. A `pending` refund is money that has NOT come back, and
 * counting it would let a caller conclude "already returned" while the gateway is still
 * holding the funds — the precise error this exists to prevent, inverted.
 */
export async function chargeAlreadyReturned(
  organizationId: string,
  providerChargeId: string | null | undefined,
): Promise<ChargeReturnState> {
  const none: ChargeReturnState = {
    settled: false,
    refundedMinor: 0n,
    fullyReturned: false,
    paymentPublicId: null,
    refundPublicId: null,
    providerRefundId: null,
    currency: null,
  };
  if (!providerChargeId) return none;
  return withTenant(organizationId, async (tx) => {
    const [pay] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.providerChargeId, providerChargeId), eq(payments.status, "succeeded")))
      .limit(1);
    if (!pay) return requestChargeReturned(tx, providerChargeId, none);
    const rows = await tx.select().from(refunds).where(eq(refunds.paymentId, pay.id));
    const done = rows.filter((r) => r.status === "succeeded");
    const refundedMinor = done.reduce((s, r) => s + r.amountMinor, 0n);
    // Newest first, so the id in the message is the one an operator just saw move.
    const newest = done.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
    return {
      settled: true,
      refundedMinor,
      fullyReturned: refundedMinor >= pay.amountMinor,
      paymentPublicId: pay.publicId,
      refundPublicId: newest?.publicId ?? null,
      providerRefundId: newest?.providerRefundId ?? null,
      currency: pay.currency,
    };
  });
}

/**
 * `chargeAlreadyReturned` for a payment request's charge (0388): the charge has no payment
 * row; its refunds hang off the request's children.
 */
async function requestChargeReturned(
  tx: Tx,
  providerChargeId: string,
  none: ChargeReturnState,
): Promise<ChargeReturnState> {
  const [req] = await tx
    .select({ id: paymentRequests.id, currency: paymentRequests.currency })
    .from(paymentRequests)
    .where(eq(paymentRequests.providerChargeId, providerChargeId))
    .limit(1);
  if (!req) return none;
  const children = await tx
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.paymentRequestId, req.id),
        eq(payments.status, "succeeded"),
        sql`${payments.providerKey} <> 'offline'`,
      ),
    );
  if (!children.length) return none;
  const rows = children.length
    ? await tx
        .select()
        .from(refunds)
        .where(
          inArray(
            refunds.paymentId,
            children.map((c) => c.id),
          ),
        )
    : [];
  const done = rows.filter((r) => r.status === "succeeded");
  const refundedMinor = done.reduce((s, r) => s + r.amountMinor, 0n);
  const total = children.reduce((s, c) => s + c.amountMinor, 0n);
  const newest = done.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
  const newestPay = newest ? children.find((c) => c.id === newest.paymentId) : children[0];
  return {
    settled: true,
    refundedMinor,
    fullyReturned: refundedMinor >= total,
    paymentPublicId: newestPay?.publicId ?? null,
    refundPublicId: newest?.publicId ?? null,
    providerRefundId: newest?.providerRefundId ?? null,
    currency: req.currency,
  };
}
