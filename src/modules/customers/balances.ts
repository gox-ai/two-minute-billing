/**
 * Customer balance split (CUST-2 / plan §D1) — the three credit buckets that
 * replace the old unified `customer_balance` account.
 *
 * All three are credit-normal liabilities (money we hold for / owe the customer);
 * available balance = Σcredits − Σdebits, floored at 0. Balances are DERIVED from
 * the append-only ledger — never stored on the customer row.
 *
 *  - `promotional_credit_balance` — merchant-granted marketing credit. Applied
 *    PRE-tax on an invoice (reduces the taxable base), capped at the discounted
 *    subtotal. Non-refundable. (Wallet "granted" top-ups land here.)
 *  - `refundable_credit_balance`  — credit from refundable credit notes, downgrade
 *    prorations, and credit memos. Applied POST-tax; can be refunded.
 *  - `excess_payment_balance`     — overpayments / offline excess money received.
 *    Applied POST-tax. (Wallet "paid" top-ups land here.)
 *
 * Invoice application order (implemented in invoicing/service.ts):
 *   discounts → promotional (pre-tax, capped at discounted subtotal) → tax →
 *   refundable → excess → charge the remainder.
 */
import { eq } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { postEntries } from "@/modules/ledger/service";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { currentEventContext } from "@/platform/event-context";
import { customers, promotionalCreditMovements, type PromotionalCreditType } from "@db/schema";
import { recordTransaction } from "@/modules/transactions/service";
import {
  PROMOTIONAL_CREDIT,
  REFUNDABLE_CREDIT,
  EXCESS_PAYMENT,
  lockCustomerBalances,
  bucketBalance,
  bucketBalancesForCurrency,
  customerCreditBalance,
  getCustomerBalances,
  type CreditBucket,
  type CustomerBalances,
} from "@/modules/customers/balances-read";
import type { CreditApplicationLimits } from "@/modules/customers/credits-flexibility";

import { createLogger } from "@/platform/logger";

/**
 * Customer balance movements — promotional credit granted, clawed back, set, and
 * excess payment received. All four move money on a customer's account.
 *
 * They were evented and ledgered but never LOGGED, so the operational answer to
 * "where did this customer's ₹10,000 of promotional credit go" lived only in the
 * ledger. These lines carry the post-movement balance, which is the number the
 * question is really about.
 */
const log = createLogger("customers");

// Re-exported for back-compat: every existing importer of `balances.ts` keeps
// working unchanged. Pure reads now live in `balances-read.ts` (no emitEvent
// import there) so `customers/serialize.ts` can pull them in for event
// snapshots without closing the balances → events/emit → events/content →
// serialize cycle.
export {
  PROMOTIONAL_CREDIT,
  REFUNDABLE_CREDIT,
  EXCESS_PAYMENT,
  lockCustomerBalances,
  bucketBalance,
  bucketBalancesForCurrency,
  customerCreditBalance,
  getCustomerBalances,
  type CreditBucket,
  type CustomerBalances,
};

export class BalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BalanceError";
  }
}

/**
 * Grant promotional credit to a customer (merchant marketing credit). Posts the
 * marketing expense (`promotional_credit`) against the `promotional_credit_balance`
 * liability. Emits `customer.promotional_credits_added`.
 */
/**
 * Whenever a customer's credit balance moves, `customer_changed` ALSO fires — the
 * customer object embeds the credit-balance summary, so any bucket movement is a change
 * to the customer. tmbilling's balances are ledger-derived, so the canonical
 * `customer_changed` is emitted here, alongside the specific
 * `customer_promotional_credits_*` / `customer_excess_payment_recorded` event.
 *
 * Added 2026-08-25: every step that moved a bucket (grant, consume, refund,
 * cancel-credit) emitted only the specific event, never this one.
 * The credit-note primitives already did this via their own copy of this helper;
 * this is that helper, shared, with the copy in credit-notes/service.ts now importing it.
 *
 * Deliberately NOT emitted from `planCreditApplication` or any pure read — only from a
 * primitive that actually posts a ledger movement, or the caller reporting one it posted.
 */
/**
 * ONE per operation, not one per bucket: a single `customer_changed` for the API call
 * that moved money, however many buckets it touched. A single change here can move
 * promotional AND refundable AND excess, and the credit-note primitives emit for their
 * own movement too. Emitting per movement traded five missing events for three
 * duplicated ones — no better, just wrong in the other direction.
 *
 * The operation boundary is the request: `EventContext` is bound once per request in
 * the Fastify preHandler (`enterEventContext`) and is a stable object for that whole
 * async subtree, so it is the right key. Outside any request — the billing clock,
 * verify scripts, seeds — there is no context and every call emits, exactly as before.
 */
const emittedCustomerChanged = new WeakMap<object, Set<string>>();

export async function emitCustomerChanged(
  tx: Tx,
  args: { organizationId: string; businessId: string; customerId: string },
): Promise<void> {
  const ctx = currentEventContext();
  if (ctx) {
    let seen = emittedCustomerChanged.get(ctx);
    if (!seen) {
      seen = new Set();
      emittedCustomerChanged.set(ctx, seen);
    }
    if (seen.has(args.customerId)) return;
    seen.add(args.customerId);
  }
  const [c] = await tx
    .select({
      publicId: customers.publicId,
      email: customers.email,
      resourceVersion: customers.resourceVersion,
    })
    .from(customers)
    .where(eq(customers.id, args.customerId))
    .limit(1);
  if (!c) return;
  await emitEvent(tx, {
    organizationId: args.organizationId,
    businessId: args.businessId,
    type: "customer_updated",
    data: buildEventData("customer_updated", { id: c.publicId, email: c.email }, c.resourceVersion),
  });
}

/** Caller annotations on a manual promotional-credit movement (0312). */
export interface PromotionalCreditAnnotation {
  creditType?: PromotionalCreditType;
  reference?: string;
}

/** Record `credit_type` + `reference` against the ledger transaction that moved the bucket. */
async function annotatePromotionalMovement(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    ledgerTransactionId: string;
  } & PromotionalCreditAnnotation,
): Promise<void> {
  await tx.insert(promotionalCreditMovements).values({
    organizationId: input.organizationId,
    businessId: input.businessId,
    customerId: input.customerId,
    ledgerTransactionId: input.ledgerTransactionId,
    creditType: input.creditType ?? "general",
    reference: input.reference ?? null,
  });
}

export async function addPromotionalCredits(
  input: {
    organizationId: string;
    businessId: string;
    customer: typeof customers.$inferSelect;
    amountMinor: number;
    currency: string;
    description?: string;
  } & PromotionalCreditAnnotation,
): Promise<{ balance: bigint; movementId: string | null }> {
  const amount = BigInt(input.amountMinor);
  const currency = input.currency.toUpperCase();
  if (amount <= 0n) throw new BalanceError("Promotional credit amount must be positive");
  return withTenant(input.organizationId, async (tx) => {
    // Free credit: the business's per-grant maximum and alert threshold (0495).
    const { checkGrantLimit, recordLargeGrant } = await import("@/modules/credits/grant-limits");
    const alert = await checkGrantLimit(
      tx,
      {
        businessId: input.businessId,
        currency,
        amountMinor: amount,
        kind: "promotional_credit",
      },
      (m) => new BalanceError(m),
    );
    const { transactionId } = await postEntries(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.customer.id,
        sourceType: "promotional_credit",
        sourceId: input.customer.publicId,
        lines: [
          {
            account: "promotional_credit",
            direction: "debit",
            amountMinor: amount,
            currency,
            memo: input.description ?? undefined,
          },
          {
            account: PROMOTIONAL_CREDIT,
            direction: "credit",
            amountMinor: amount,
            currency,
            memo: input.description ?? undefined,
          },
        ],
      },
      tx,
    );
    await annotatePromotionalMovement(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: input.customer.id,
      ledgerTransactionId: transactionId,
      creditType: input.creditType,
      reference: input.reference,
    });
    if (alert)
      await recordLargeGrant(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.customer.id,
        kind: "promotional_credit",
        reference: transactionId,
        amountMinor: amount,
        currency,
        alertAboveMinor: alert.alertAboveMinor,
      });
    const balance = await bucketBalance(tx, input.customer.id, PROMOTIONAL_CREDIT, currency);
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "customer_promotional_credits_added",
      data: buildEventData("customer_promotional_credits_added", {
        id: input.customer.publicId,
        amount_minor: input.amountMinor,
        currency,
        balance_minor: Number(balance),
        description: input.description ?? null,
      }),
    });
    await emitCustomerChanged(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: input.customer.id,
    });
    log.info("promotional credit granted", {
      event: "promotional_credit_added",
      customer: input.customer.publicId,
      amountMinor: String(amount),
      balanceMinor: String(balance),
      currency,
      description: input.description ?? null,
    });
    return { balance, movementId: transactionId };
  });
}

/**
 * Deduct promotional credit (reverse of a grant — merchant claws back unused
 * marketing credit). Capped at the available balance. Emits
 * `customer.promotional_credits_deducted`.
 */
export async function deductPromotionalCredits(
  input: {
    organizationId: string;
    businessId: string;
    customer: typeof customers.$inferSelect;
    amountMinor: number;
    currency: string;
    description?: string;
  } & PromotionalCreditAnnotation,
): Promise<{ balance: bigint; deductedMinor: bigint; movementId: string | null }> {
  const requested = BigInt(input.amountMinor);
  const currency = input.currency.toUpperCase();
  if (requested <= 0n) throw new BalanceError("Deduction amount must be positive");
  return withTenant(input.organizationId, async (tx) => {
    await lockCustomerBalances(tx, input.customer.id);
    const available = await bucketBalance(tx, input.customer.id, PROMOTIONAL_CREDIT, currency);
    const amount = requested < available ? requested : available;
    let movementId: string | null = null;
    if (amount > 0n) {
      const { transactionId } = await postEntries(
        {
          organizationId: input.organizationId,
          businessId: input.businessId,
          customerId: input.customer.id,
          sourceType: "promotional_credit_deduction",
          sourceId: input.customer.publicId,
          lines: [
            {
              account: PROMOTIONAL_CREDIT,
              direction: "debit",
              amountMinor: amount,
              currency,
              memo: input.description ?? undefined,
            },
            {
              account: "promotional_credit",
              direction: "credit",
              amountMinor: amount,
              currency,
              memo: input.description ?? undefined,
            },
          ],
        },
        tx,
      );
      await annotatePromotionalMovement(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.customer.id,
        ledgerTransactionId: transactionId,
        creditType: input.creditType,
        reference: input.reference,
      });
      movementId = transactionId;
    }
    const balance = await bucketBalance(tx, input.customer.id, PROMOTIONAL_CREDIT, currency);
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "customer_promotional_credits_deducted",
      data: buildEventData("customer_promotional_credits_deducted", {
        id: input.customer.publicId,
        amount_minor: Number(amount),
        currency,
        balance_minor: Number(balance),
        description: input.description ?? null,
      }),
    });
    await emitCustomerChanged(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: input.customer.id,
    });
    log.info("promotional credit deducted", {
      event: "promotional_credit_deducted",
      customer: input.customer.publicId,
      amountMinor: String(amount),
      balanceMinor: String(balance),
      currency,
    });
    return { balance, deductedMinor: amount, movementId };
  });
}

/**
 * Set the promotional credit balance to an exact amount (computes the delta and
 * adds or deducts). Emits the corresponding added/deducted event.
 */
export async function setPromotionalCredits(
  input: {
    organizationId: string;
    businessId: string;
    customer: typeof customers.$inferSelect;
    amountMinor: number;
    currency: string;
    description?: string;
  } & PromotionalCreditAnnotation,
): Promise<{ balance: bigint; movementId: string | null }> {
  const target = BigInt(input.amountMinor);
  const currency = input.currency.toUpperCase();
  if (target < 0n) throw new BalanceError("Target balance cannot be negative");
  // Read + post in ONE locked transaction — a concurrent draw between the read
  // and the delta posting would otherwise set the wrong absolute value.
  return withTenant(input.organizationId, async (tx) => {
    await lockCustomerBalances(tx, input.customer.id);
    const current = await bucketBalance(tx, input.customer.id, PROMOTIONAL_CREDIT, currency);
    const delta = target - current;
    let movementId: string | null = null;
    if (delta !== 0n) {
      const grant = delta > 0n;
      const amount = grant ? delta : -delta;
      const { transactionId } = await postEntries(
        {
          organizationId: input.organizationId,
          businessId: input.businessId,
          customerId: input.customer.id,
          sourceType: grant ? "promotional_credit" : "promotional_credit_deduction",
          sourceId: input.customer.publicId,
          lines: grant
            ? [
                {
                  account: "promotional_credit",
                  direction: "debit",
                  amountMinor: amount,
                  currency,
                  memo: input.description ?? undefined,
                },
                {
                  account: PROMOTIONAL_CREDIT,
                  direction: "credit",
                  amountMinor: amount,
                  currency,
                  memo: input.description ?? undefined,
                },
              ]
            : [
                {
                  account: PROMOTIONAL_CREDIT,
                  direction: "debit",
                  amountMinor: amount,
                  currency,
                  memo: input.description ?? undefined,
                },
                {
                  account: "promotional_credit",
                  direction: "credit",
                  amountMinor: amount,
                  currency,
                  memo: input.description ?? undefined,
                },
              ],
        },
        tx,
      );
      await annotatePromotionalMovement(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.customer.id,
        ledgerTransactionId: transactionId,
        creditType: input.creditType,
        reference: input.reference,
      });
      movementId = transactionId;
      await emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: grant
          ? "customer_promotional_credits_added"
          : "customer_promotional_credits_deducted",
        data: buildEventData(
          grant ? "customer_promotional_credits_added" : "customer_promotional_credits_deducted",
          {
            id: input.customer.publicId,
            amount_minor: Number(amount),
            currency,
            balance_minor: Number(target),
            description: input.description ?? null,
          },
        ),
      });
      await emitCustomerChanged(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.customer.id,
      });
    }
    log.info("promotional credit set to an absolute figure", {
      event: "promotional_credit_set",
      customer: input.customer.publicId,
      balanceMinor: String(target),
      currency,
    });
    return { balance: target, movementId };
  });
}

/**
 * Record an offline excess payment (money received outside a gateway that isn't
 * applied to any invoice yet). Posts cash against the `excess_payment_balance`
 * liability. Emits `customer.excess_payment_recorded`.
 */
export async function recordExcessPayment(input: {
  organizationId: string;
  businessId: string;
  customer: typeof customers.$inferSelect;
  amountMinor: number;
  currency: string;
  description?: string;
  /**
   * How the money arrived. When given, the receipt is also written to the money log as a
   * `payment` transaction — `gateway_key: offline_<method>`, the reference in
   * `id_at_gateway`, `occurred_at` = `date` — the shape an offline invoice payment
   * records. Omitted: ledger only, as before.
   */
  transaction?: { date?: Date; paymentMethod: string; referenceNumber?: string };
}): Promise<{ balance: bigint; transactionPublicId: string | null }> {
  const amount = BigInt(input.amountMinor);
  const currency = input.currency.toUpperCase();
  if (amount <= 0n) throw new BalanceError("Excess payment amount must be positive");
  if (input.transaction?.date && input.transaction.date.getTime() > Date.now())
    throw new BalanceError("transaction[date] cannot be in the future");
  return withTenant(input.organizationId, async (tx) => {
    await postEntries(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.customer.id,
        sourceType: "excess_payment",
        sourceId: input.customer.publicId,
        lines: [
          {
            account: "cash",
            direction: "debit",
            amountMinor: amount,
            currency,
            memo: input.description ?? undefined,
          },
          {
            account: EXCESS_PAYMENT,
            direction: "credit",
            amountMinor: amount,
            currency,
            memo: input.description ?? undefined,
          },
        ],
      },
      tx,
    );
    const txn = input.transaction
      ? await recordTransaction(
          {
            organizationId: input.organizationId,
            businessId: input.businessId,
            customerId: input.customer.id,
            type: "payment",
            status: "succeeded",
            amountMinor: amount,
            currency,
            gatewayKey: `offline_${input.transaction.paymentMethod}`,
            idAtGateway: input.transaction.referenceNumber ?? null,
            occurredAt: input.transaction.date,
          },
          tx,
        )
      : null;
    const balance = await bucketBalance(tx, input.customer.id, EXCESS_PAYMENT, currency);
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "customer_excess_payment_recorded",
      data: buildEventData("customer_excess_payment_recorded", {
        id: input.customer.publicId,
        amount_minor: input.amountMinor,
        currency,
        balance_minor: Number(balance),
        description: input.description ?? null,
      }),
    });
    await emitCustomerChanged(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: input.customer.id,
    });
    // Money received with no invoice to apply it to — it sits on the customer until
    // the next one draws it down, so "the payer is in credit and nobody knows" is
    // exactly the state this line exists to make visible.
    log.info("excess payment recorded to the customer balance", {
      event: "excess_payment_recorded",
      customer: input.customer.publicId,
      amountMinor: String(amount),
      balanceMinor: String(balance),
      currency,
    });
    return { balance, transactionPublicId: txn?.publicId ?? null };
  });
}

/**
 * Emit the promotional-credit movement event for an AUTOMATIC movement — the two
 * ways the bucket changes without anyone calling the promotional-credits API.
 *
 * The manual grant/deduct/set paths above emit `customer_promotional_credits_added`
 * / `_deducted` inline, but the automatic movements post their ledger entries
 * straight from the flow that owns them: an invoice DRAWS the bucket
 * (`postCreditApplications` in invoicing/service.ts) and a credit note RESTORES a
 * funded slice (`restoreBucketFundedSlices` in subscriptions/cancellation-credit.ts).
 * Neither said so, so a webhook consumer tracking the balance saw two of the four
 * movements (fixed 2026-08-24). This helper is the ONE place that turns a bucket
 * movement into the event, so the payload cannot drift between the manual and
 * automatic paths.
 *
 * Shape is byte-identical to the manual paths (`id` / `amount_minor` / `currency` /
 * `balance_minor` / `description`) plus a top-level `invoice` pointing at the
 * document that caused the movement, so a consumer can reconcile it.
 *
 * Reads the resulting balance from the ledger — call it INSIDE the transaction that
 * posted the entries, after posting, so `balance_minor` is the post-movement figure
 * the manual paths also report.
 */
export async function emitPromotionalCreditMovement(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    /** Always positive — `direction` says which way it moved. */
    amountMinor: bigint;
    currency: string;
    direction: "added" | "deducted";
    description?: string | null;
    /** The invoice the movement is attributed to (drawn by / restored from). */
    invoicePublicId?: string | null;
  },
): Promise<void> {
  if (input.amountMinor <= 0n) return;
  const currency = input.currency.toUpperCase();
  const [cust] = await tx
    .select({ publicId: customers.publicId })
    .from(customers)
    .where(eq(customers.id, input.customerId))
    .limit(1);
  // Defensive: every caller holds a real customer row, but an event with no
  // resource id is worse than no event (emit derives `resource.id` from it).
  if (!cust) return;
  const balance = await bucketBalance(tx, input.customerId, PROMOTIONAL_CREDIT, currency);
  const type =
    input.direction === "added"
      ? ("customer_promotional_credits_added" as const)
      : ("customer_promotional_credits_deducted" as const);
  await emitEvent(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    type,
    data: buildEventData(
      type,
      {
        id: cust.publicId,
        amount_minor: Number(input.amountMinor),
        currency,
        balance_minor: Number(balance),
        description: input.description ?? null,
      },
      null,
      input.invoicePublicId ? { invoice: input.invoicePublicId } : undefined,
    ),
  });
  await emitCustomerChanged(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    customerId: input.customerId,
  });
}

/**
 * Plan the ordered application of the three balances against an invoice.
 * Promotional is capped at the discounted subtotal (it is applied PRE-tax by the
 * caller, which recomputes tax on the reduced base); refundable then excess are
 * applied POST-tax against whatever remains collectible.
 *
 * PURE, and it must stay pure: the preview path (`subscriptions/estimate.ts`) and the
 * booking path (`invoicing/service.ts`) both call it, and a preview that resolved config
 * differently from the booking is a preview that lies. That is why `limits` is passed IN
 * rather than read here — see `modules/customers/credits-flexibility.ts`.
 */
export function planCreditApplication(input: {
  balances: CustomerBalances;
  /** subtotal − coupon discount (the cap for promotional credit). */
  discountedSubtotal: bigint;
  /** what's collectible after tax + promo + withholding (promo already removed). */
  postTaxRemaining: bigint;
  /**
   * Credits Flexibility ceilings for THIS invoice, already resolved from the business
   * config, the invoice class and the subscription's own maxima
   * (`creditApplicationLimits`). Per bucket: `null` = unlimited, `0n` = do not
   * auto-apply, positive = at most that many minor units.
   *
   * **Optional, and omitting it means unlimited** — which is exactly what this function
   * did before the ceilings existed. Kept optional on purpose: the three call sites in
   * `estimate.ts` are threaded separately, and an unthreaded caller must keep behaving
   * as it always did rather than silently applying nothing. Promotional credit is NOT
   * subject to it — the setting covers refundable + excess only.
   */
  limits?: CreditApplicationLimits;
}): { promotional: bigint; refundable: bigint; excess: bigint } {
  const cap = input.discountedSubtotal > 0n ? input.discountedSubtotal : 0n;
  const promotional = min(input.balances.promotional, cap);
  const remaining = input.postTaxRemaining > 0n ? input.postTaxRemaining : 0n;
  // A ceiling narrows what the BUCKET can contribute; the invoice's own remaining
  // collectible still bounds it. Excess is measured against what is left after
  // refundable, so capping refundable lets excess fill the gap — the same
  // refundable-then-excess order applied above, with each kind honouring its own
  // setting independently.
  const refundableAvail = ceil(input.balances.refundable, input.limits?.refundable);
  const refundable = min(refundableAvail, remaining);
  const excessAvail = ceil(input.balances.excess, input.limits?.excess);
  const excess = min(excessAvail, remaining - refundable);
  return { promotional, refundable, excess };
}

/** A bucket's balance narrowed by its ceiling; `null`/`undefined` = no ceiling. */
function ceil(balance: bigint, limit: bigint | null | undefined): bigint {
  return limit === null || limit === undefined ? balance : min(balance, limit);
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
