import { methodTypeOf } from "@/modules/payments/method-type";
import { and, eq } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { postEntries } from "@/modules/ledger/service";
import {
  bucketBalancesForCurrency,
  PROMOTIONAL_CREDIT,
  EXCESS_PAYMENT,
  emitPromotionalCreditMovement,
} from "@/modules/customers/balances";
import {
  chargeOrder,
  chargeWithMethod,
  resolveChargeCandidates,
  shouldTryBackup,
  tmtestOutcome,
  lostChargeHandle,
  type ChargeAttempt,
  type LostChargeHandle,
  type Pm,
} from "@/modules/invoicing/collection";
import { PAYMENT_PURPOSE_KEY } from "@/modules/invoicing/pre-debit";
import { GatewayRouterError } from "@/modules/gateway/router";
import { settlePaymentFailed, settlePaymentSucceeded } from "@/modules/payments/settlement";
import { recordTransaction } from "@/modules/transactions/service";
import { ProviderIndeterminateError, strandedObjectId } from "@/providers/types";
import { emitEvent } from "@/modules/events/emit";
import { checkGrantLimit, recordLargeGrant } from "@/modules/credits/grant-limits";
import { buildEventData } from "@/modules/events/registry";
import { walletTopups, payments, customers } from "@db/schema";
import { createLogger } from "@/platform/logger";

const log = createLogger("wallet");

export class WalletError extends Error {
  constructor(
    message: string,
    /** Set when the charge waits on a gateway pre-debit notice: retry after this. */
    readonly retryAfter?: Date,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

/**
 * The customer's spendable prepaid balance from wallet top-ups (D1 balance split):
 * granted → promotional bucket, paid → excess bucket. (Legacy wallet API — being
 * removed once the dashboard migrates to the balances API.)
 */
export async function walletBalance(
  organizationId: string,
  customerId: string,
  currency: string,
): Promise<bigint> {
  const b = await bucketBalancesForCurrency(organizationId, customerId, currency);
  return b.promotional + b.excess;
}

/**
 * Add prepaid credit to a customer's wallet (D1 balance split folds this in):
 *  - 'granted': promotional — no charge. Ledger: promotional_credit (expense) debit,
 *    promotional_credit_balance credit.
 *  - 'paid':    charges the customer's card. Ledger: cash debit, excess_payment_balance credit.
 * Both grow a credit bucket that invoice billing draws down automatically — so the
 * top-up reduces the next invoice. `walletTopups` stays as
 * the paid-vs-granted audit trail.
 */
export async function topUpWallet(input: {
  organizationId: string;
  businessId: string;
  customer: typeof customers.$inferSelect;
  amountMinor: number;
  currency: string;
  type: "paid" | "granted";
}): Promise<typeof walletTopups.$inferSelect> {
  const { organizationId, businessId, customer } = input;
  const amount = BigInt(input.amountMinor);
  const currency = input.currency.toUpperCase();
  if (amount <= 0n) throw new WalletError("Top-up amount must be positive");
  // Money entering a wallet — logged at info because a `granted` top-up has no
  // gateway record anywhere else, and both kinds change what the customer can spend.
  log.log("wallet top-up starting", {
    customer: customer.publicId,
    businessId: businessId,
    amountMinor: amount.toString(),
    currency,
    type: input.type,
  });

  if (input.type === "paid")
    return paidTopUp({ organizationId, businessId, customer, amount, currency });

  return withTenant(organizationId, async (tx) => {
    // Free credit: the business's per-grant maximum and alert threshold (0495).
    const alert = await checkGrantLimit(
      tx,
      { businessId, currency, amountMinor: amount, kind: "wallet_topup" },
      (m) => new WalletError(m),
    );
    const topup = await creditTopUp(tx, {
      organizationId,
      businessId,
      customerId: customer.id,
      customerPublicId: customer.publicId,
      amount,
      currency,
      type: "granted",
      paymentId: null,
    });
    if (alert)
      await recordLargeGrant(tx, {
        organizationId,
        businessId,
        customerId: customer.id,
        kind: "wallet_topup",
        reference: topup.publicId,
        amountMinor: amount,
        currency,
        alertAboveMinor: alert.alertAboveMinor,
      });
    return topup;
  });
}

/** Marks a `payments` row as the charge behind a paid top-up, so settlement credits the wallet. */
const TOPUP_PAYMENT_KEY = "wallet_topup";

const NO_METHOD =
  "We could not charge the top-up. The customer has no payment method that we can charge. Add a payment method, then try again.";
const IN_PROGRESS =
  "We could not add the top-up credit yet. The payment is still in progress. We add the credit when the payment completes.";
const GATEWAY_UNAVAILABLE =
  "We could not charge the top-up. The payment gateway for this payment method is not available. Enable the gateway account, then try again.";
const GATEWAY_FAULT =
  "We could not charge the top-up. The payment gateway did not complete the request. Try again later.";
const noticeSent = (until: Date) =>
  `We could not charge the top-up yet. The customer's bank must get advance notice of this payment. We sent the notice. Try again with the same amount after ${until.toISOString()}.`;
const declined = (code: string | undefined) =>
  `We could not charge the top-up. The payment was declined (${code ?? "card_declined"}). Ask the customer to update the payment method, then try again.`;

/**
 * Charge a paid top-up the way invoice collection charges: same candidates (primary, then
 * chargeable backups), same adapter routing, same `chargeWithMethod`. Each attempt is
 * booked `pending` BEFORE the gateway call, so a throw or a lost write still leaves a
 * row; the wallet is credited only by the pending → succeeded claim, once.
 *
 * On a pre-debit notice rail the first debit waits out the notice: nothing is booked, and
 * the caller is told when to retry. A backup that must wait yields to the next one.
 */
async function paidTopUp(input: {
  organizationId: string;
  businessId: string;
  customer: typeof customers.$inferSelect;
  amount: bigint;
  currency: string;
}): Promise<typeof walletTopups.$inferSelect> {
  const { organizationId, businessId, customer, amount, currency } = input;
  const candidates = chargeOrder(
    await resolveChargeCandidates({ organizationId, customerId: customer.id, currency }),
  );
  if (candidates.length === 0) throw new WalletError(NO_METHOD);
  const contact = {
    autoCollection: customer.autoCollection,
    email: customer.email,
    phone: customer.phone,
  };

  let lastDecline: string | undefined;
  for (const pm of candidates) {
    const payId = publicId("pay");
    let booked: typeof payments.$inferSelect | null = null;
    const book = async () =>
      (booked ??= await bookPendingAttempt({
        organizationId,
        businessId,
        customer,
        pm,
        amount,
        currency,
        publicId: payId,
      }));
    let a: ChargeAttempt;
    try {
      a = await chargeWithMethod({
        organizationId,
        businessId,
        currency,
        pm,
        amountMinor: amount,
        idempotencyKey: payId,
        ownershipRef: payId,
        description: "Wallet top-up",
        contact,
        preDebit: { purpose: "wallet_topup" },
        initiator: { by: "merchant", recurring: false },
        beforeGatewayCall: async () => {
          await book();
        },
      });
    } catch (e) {
      const pay = await book();
      const attempt = { organizationId, businessId, customer, pm, pay, amount, currency };
      if (e instanceof GatewayRouterError) {
        await settleAttempt(
          attempt,
          failedAttempt(pm, "gateway_account_unavailable", e.message, false),
        );
        throw new WalletError(GATEWAY_UNAVAILABLE);
      }
      // Money may have moved: stays pending, for the reconcile path to decide.
      if (e instanceof ProviderIndeterminateError) {
        log.error(e, { event: "wallet_topup_charge_indeterminate", payment: pay.publicId });
        const lost = lostChargeHandle(e);
        await settleAttempt(
          attempt,
          {
            result: { status: "pending", providerChargeId: strandedObjectId(e) ?? "" },
            account: lost?.account ?? null,
            gatewayKey: lost?.gatewayKey ?? pm.providerKey,
          },
          "timeout",
          lost,
        );
        throw new WalletError(IN_PROGRESS);
      }
      log.error(e as Error, { event: "wallet_topup_charge_threw", payment: pay.publicId });
      await settleAttempt(
        attempt,
        failedAttempt(pm, "gateway_error", e instanceof Error ? e.message : String(e), true),
      );
      throw new WalletError(GATEWAY_FAULT);
    }

    if (a.deferredUntil) {
      if (pm === candidates[0]) throw new WalletError(noticeSent(a.deferredUntil), a.deferredUntil);
      continue;
    }
    const pay = await book();
    const attempt = { organizationId, businessId, customer, pm, pay, amount, currency };
    const outcome = tmtestOutcome(a.result);
    if (a.result.status === "succeeded") {
      const topup = await settleAttempt(attempt, a);
      if (!topup)
        throw new Error(`top-up payment ${pay.publicId} settled but no wallet credit exists`);
      return topup;
    }
    if (a.result.status !== "failed") {
      // Same order as collection: tmtest's timeout instrument also answers `pending`.
      const status =
        outcome === "timeout"
          ? "timeout"
          : outcome === "needs_attention"
            ? "needs_attention"
            : "in_progress";
      await settleAttempt(attempt, a, status);
      throw new WalletError(IN_PROGRESS);
    }
    await settleAttempt(attempt, a);
    lastDecline = a.result.failure?.code;
    if (!shouldTryBackup(a.result)) break;
  }
  throw new WalletError(declined(lastDecline));
}

const failedAttempt = (
  pm: Pm,
  code: string,
  message: string,
  retriable: boolean,
): ChargeAttempt => ({
  result: { status: "failed", providerChargeId: "", failure: { code, message, retriable } },
  account: null,
  gatewayKey: pm.providerKey,
});

async function bookPendingAttempt(input: {
  organizationId: string;
  businessId: string;
  customer: typeof customers.$inferSelect;
  pm: Pm;
  amount: bigint;
  currency: string;
  publicId: string;
}): Promise<typeof payments.$inferSelect> {
  return withTenant(input.organizationId, async (tx) => {
    const [pay] = await tx
      .insert(payments)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.customer.id,
        invoiceId: null,
        paymentMethodId: input.pm.id,
        publicId: input.publicId,
        status: "pending",
        amountMinor: input.amount,
        currency: input.currency,
        providerKey: input.pm.providerKey,
        methodType: methodTypeOf(null, input.pm),
        // The notice purpose too: a credit top-up payment must not count as this debit.
        metadata: { [TOPUP_PAYMENT_KEY]: true, [PAYMENT_PURPOSE_KEY]: "wallet_topup" },
      })
      .returning();
    return pay!;
  });
}

/**
 * Record the gateway's answer on the pending attempt, in one transaction. Success and
 * failure settle through `payments/settlement`, the same code a webhook or the
 * stale-pending sweep uses, so a top-up credited now and one credited later are identical.
 * An unresolved answer leaves the payment pending with an open transaction.
 */
async function settleAttempt(
  input: {
    organizationId: string;
    businessId: string;
    customer: typeof customers.$inferSelect;
    pm: Pm;
    pay: typeof payments.$inferSelect;
    amount: bigint;
    currency: string;
  },
  a: ChargeAttempt,
  pendingStatus?: "in_progress" | "timeout" | "needs_attention",
  /** A lost answer: what the gateway can find the charge by. */
  lost?: LostChargeHandle | null,
): Promise<typeof walletTopups.$inferSelect | null> {
  const { organizationId, businessId, pay } = input;
  const chargeId = a.result.providerChargeId || null;
  const r = a.result;
  const txnStatus = pendingStatus ?? (r.status === "succeeded" ? "succeeded" : "failed");
  return withTenant(organizationId, async (tx) => {
    await tx
      .update(payments)
      .set({ providerKey: a.gatewayKey, providerChargeId: chargeId })
      .where(eq(payments.id, pay.id));
    await recordTransaction(
      {
        organizationId,
        businessId,
        customerId: input.customer.id,
        type: "payment",
        status: txnStatus,
        amountMinor: input.amount,
        currency: input.currency,
        gatewayAccountId: a.account?.id ?? null,
        gatewayKey: a.gatewayKey,
        idAtGateway: chargeId,
        ...(lost ? { ownershipRef: lost.ownershipRef, idempotencyKey: lost.idempotencyKey } : {}),
        paymentMethodId: input.pm.id,
        paymentId: pay.id,
        errorCode: r.failure?.code ?? null,
        errorText: r.failure?.message ?? null,
        retriable: r.failure?.retriable ?? null,
      },
      tx,
    );
    if (pendingStatus) return null;
    if (r.status === "succeeded") {
      await settlePaymentSucceeded(tx, { organizationId, businessId, paymentId: pay.id });
      const [topup] = await tx
        .select()
        .from(walletTopups)
        .where(eq(walletTopups.paymentId, pay.id))
        .limit(1);
      return topup ?? null;
    }
    await settlePaymentFailed(tx, {
      organizationId,
      businessId,
      paymentId: pay.id,
      errorCode: r.failure?.code ?? "card_declined",
      errorText: r.failure?.message ?? null,
      retriable: r.failure?.retriable ?? true,
    });
    return null;
  });
}

/**
 * Credit the wallet for a top-up payment that just moved pending → succeeded. Called by
 * `settlePaymentSucceeded` inside its claim, so it runs once per payment. Returns false
 * for a payment that is not a top-up charge.
 */
export async function creditSettledTopUp(
  tx: Tx,
  pay: typeof payments.$inferSelect,
): Promise<boolean> {
  const meta = (pay.metadata ?? {}) as Record<string, unknown>;
  if (pay.invoiceId || meta[TOPUP_PAYMENT_KEY] !== true) return false;
  const [existing] = await tx
    .select({ id: walletTopups.id })
    .from(walletTopups)
    .where(and(eq(walletTopups.paymentId, pay.id), eq(walletTopups.creditType, "paid")))
    .limit(1);
  if (existing) return true;
  const [cus] = await tx
    .select({ publicId: customers.publicId })
    .from(customers)
    .where(eq(customers.id, pay.customerId))
    .limit(1);
  await creditTopUp(tx, {
    organizationId: pay.organizationId,
    businessId: pay.businessId,
    customerId: pay.customerId,
    customerPublicId: cus?.publicId ?? null,
    amount: pay.amountMinor,
    currency: pay.currency,
    type: "paid",
    paymentId: pay.id,
  });
  return true;
}

async function creditTopUp(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    customerPublicId: string | null;
    amount: bigint;
    currency: string;
    type: "paid" | "granted";
    paymentId: string | null;
  },
): Promise<typeof walletTopups.$inferSelect> {
  const { organizationId, businessId, customerId, amount, currency } = input;
  const [topup] = await tx
    .insert(walletTopups)
    .values({
      organizationId,
      businessId,
      customerId,
      publicId: publicId("wt"),
      creditType: input.type,
      amountMinor: amount,
      currency,
      paymentId: input.paymentId,
    })
    .returning();

  // Credit the right bucket: paid → excess (funded by cash), granted →
  // promotional (funded by the promotional_credit marketing expense).
  await postEntries(
    {
      organizationId,
      businessId,
      customerId,
      sourceType: "wallet_topup",
      sourceId: topup!.publicId,
      lines: [
        {
          account: input.type === "paid" ? "cash" : "promotional_credit",
          direction: "debit",
          amountMinor: amount,
          currency,
        },
        {
          account: input.type === "paid" ? EXCESS_PAYMENT : PROMOTIONAL_CREDIT,
          direction: "credit",
          amountMinor: amount,
          currency,
        },
      ],
    },
    tx,
  );
  await emitEvent(tx, {
    organizationId,
    businessId,
    type: "wallet_topped_up",
    data: buildEventData("wallet_topped_up", {
      id: topup!.publicId,
      customer: input.customerPublicId,
      credit_type: input.type,
      amount_minor: Number(amount),
      currency,
    }),
  });
  // A `granted` top-up credits the promotional bucket, so it is a promotional-credit
  // movement and needs the same `_added` event the manual grant emits — `wallet_topped_up`
  // is a wallet-level record and the parity harness does not map it to the promo balance.
  // ADDITIONALLY, not instead: both events describe the one ledger movement.
  // A `paid` top-up credits `excess_payment_balance` and deliberately gets no twin —
  // there is no per-bucket event type for excess, and `customer_excess_payment_recorded`
  // means money RECEIVED offline, which is a different thing (2026-08-24).
  if (input.type === "granted") {
    await emitPromotionalCreditMovement(tx, {
      organizationId,
      businessId,
      customerId,
      amountMinor: amount,
      currency,
      direction: "added",
      description: `Wallet top-up ${topup!.publicId}`,
    });
  }
  return topup!;
}
