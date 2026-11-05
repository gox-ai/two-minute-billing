import { and, eq, gte, isNull } from "drizzle-orm";
import { loadEffectiveDunningConfig } from "@/modules/dunning-policies/effective";
import { withTenant } from "@/platform/db";
import { invoices, paymentMethods, prices, subscriptionItems, subscriptions } from "@db/schema";
import { createLogger } from "@/platform/logger";
import { resolveStoredErrorId } from "@/providers/decline-codes";
import {
  billSubscriptionPeriod,
  isAutoCollectOn,
  planSubscriptionPeriodInvoice,
  commitSubscriptionPeriodInvoice,
  ChargeAmountMismatchError,
  collectInvoice,
} from "@/modules/invoicing/service";
import {
  findInTermReactivation,
  sameItemSet,
  IN_TERM_REFUSAL,
  type InTermReactivation,
  type ReactivationTerm,
  type ChargeFailureChoice,
  requiresChargeOnReactivation,
} from "./in-term-reactivation";
import {
  chargeBeforeSubscriptionInvoice,
  refundPreInvoiceCharge,
  type CompletedCharge,
} from "@/modules/invoicing/collection";
import { estimateReactivate } from "./estimate";
import {
  captureRefused,
  consumePaymentIntent,
  getPaymentIntent,
  type PaymentIntent,
} from "@/modules/payment-intents/service";
import { getCustomerById } from "@/modules/customers/service";
import { assertChargeableForAutoCollect } from "@/modules/payment-methods/service";
import {
  resolveDunningConfig,
  nextRetryAt,
  addUtcDays,
  retryDaysForMethod,
  type DunningConfig,
} from "./dunning-schedule";

/** The schedule for the payment method a reactivation charges (2.48). */
async function methodRetryDays(
  organizationId: string,
  cfg: DunningConfig,
  paymentMethodId: string | null | undefined,
): Promise<number[]> {
  if (!paymentMethodId) return cfg.retryDays;
  const [pm] = await withTenant(organizationId, (tx) =>
    tx
      .select({ type: paymentMethods.type, rail: paymentMethods.mandateRail })
      .from(paymentMethods)
      .where(eq(paymentMethods.id, paymentMethodId))
      .limit(1),
  );
  return retryDaysForMethod(cfg, pm?.type, pm?.rail);
}

/**
 * An invoice committed with `collect: false` whose intent capture was refused: nothing else
 * retries it, so dunning takes it from the first retry day.
 */
export async function handUncollectedInvoiceToDunning(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  subscriptionId: string;
  invoiceId: string;
  paymentMethodId: string | null | undefined;
  now: Date;
}): Promise<void> {
  const cfg = await withTenant(input.organizationId, (tx) =>
    loadEffectiveDunningConfig(tx, {
      businessId: input.businessId,
      customerId: input.customerId,
      subscriptionId: input.subscriptionId,
    }),
  );
  const days = await methodRetryDays(input.organizationId, cfg, input.paymentMethodId);
  await withTenant(input.organizationId, (tx) =>
    tx
      .update(invoices)
      .set({
        dunningStatus: "in_progress" as const,
        nextAttemptAt: nextRetryAt(1, input.now, days) ?? addUtcDays(input.now, 1),
      })
      .where(and(eq(invoices.id, input.invoiceId), isNull(invoices.dunningStatus))),
  );
}
import {
  reactivateSubscription,
  reactivateSubscriptionWithOptions,
  reactivateSubscriptionInTerm,
  cancelSubscription,
  SubscriptionError,
  type ReactivationItemInput,
} from "./service";

const log = createLogger("subscriptions.reactivate");

type Sub = Awaited<ReturnType<typeof reactivateSubscription>>["subscription"];

export interface ReactivateAndBillResult {
  subscription: Sub;
  /** The fresh term's invoice, when one was raised now. */
  invoice?: { publicId: string; status: string; totalMinor: bigint };
  /**
   * Set when the charge failed and the business requires a successful charge to reactivate:
   * the invoice was voided and the subscription cancelled again. Nothing else to undo.
   * `status` 400 marks a refusal of the request itself (an unusable `paymentIntent`).
   */
  refused?: { code: string; message: string; status?: 400 };
  /**
   * On-session pre-charge wants the buyer to authenticate. Nothing was written; the buyer
   * completes the intent and the request is re-sent with `paymentIntent`.
   */
  actionRequired?: { intent: PaymentIntent };
  /** `paymentIntent` was consumed into the fresh term's invoice. */
  paymentIntent?: PaymentIntent;
  /** The charge or intent capture was refused, and the invoice was left open for dunning. */
  paymentError?: { code: string; message: string };
  /** Reactivated into its current term: no invoice raised, the term's invoice kept as is. */
  inTerm?: { invoice: typeof invoices.$inferSelect; outstandingMinor: bigint };
}

/**
 * Reactivate a subscription and bill its fresh term — the one implementation behind the
 * operator route and a reactivating checkout.
 *
 * `now` is the wall clock (it bounds the stranded-invoice repair and dates a refusal's
 * re-cancel). `termStart` is when the new term begins: `now`, or a past instant for a
 * backdated reactivation — the caller has already cleared it against the backdating policy.
 *
 * With auto-collection on, a usable payment method is required up front, and a failed charge
 * voids the invoice and cancels again when `requireSuccessfulChargeOnReactivation` holds. A
 * THROWN charge never does: the gateway may have taken the money, so the invoice is handed to
 * dunning instead and the error rethrown.
 *
 * `beforeBill` runs after the subscription is live and before its invoice is raised — where a
 * checkout applies its coupons, so the invoice the buyer consented to carries them.
 */
export async function reactivateAndBill(input: {
  organizationId: string;
  businessId: string;
  /** The business row — its dunning config decides whether a failed charge refuses. */
  business: Parameters<typeof resolveDunningConfig>[0];
  /** Overrides the business rule for this call only. Omitted = the business rule. */
  onChargeFailure?: ChargeFailureChoice;
  subscription: { id: string; publicId: string; customerId: string; autoCollection: string | null };
  now: Date;
  termStart?: Date;
  /** Take the options path (item rebuild / cycles / trial). A plain call clears a pending cancel too. */
  withOptions: boolean;
  /**
   * `auto` continues the current term when `findInTermReactivation` allows it, else opens a
   * fresh one; `continue` refuses when it does not; `new` always opens a fresh term.
   * Omitted = `new`: a reactivating checkout quoted a fresh term.
   */
  term?: ReactivationTerm;
  items?: ReactivationItemInput[];
  billingCycles?: number | null;
  trialEnd?: Date | null;
  chargesHandling?: "invoice_immediately" | "add_to_unbilled_charges";
  /**
   * `on_session`: the buyer is present, so an authentication challenge on the pre-charge is
   * handed back (`actionRequired`) instead of refusing. Only the pre-charge path can do
   * that, so it is refused when the charge would be taken off-session inside the invoice.
   */
  session?: "on_session";
  /**
   * An intent the buyer already authorized (`pi_…`) for the fresh term's amount due. It is
   * consumed INTO the invoice in place of a charge, as a signup consumes one.
   */
  paymentIntent?: string;
  beforeBill?: (subscription: Sub) => Promise<void>;
  /**
   * The discounts `beforeBill` will add, so the charge can be priced before anything is
   * committed. Discounts already on the subscription are priced without being listed.
   */
  quote?: {
    couponCodes?: string[];
    manualDiscount?: {
      kind: "percentage" | "fixed_amount";
      percentOffBps?: number;
      amountOffMinor?: bigint;
    };
  };
}): Promise<ReactivateAndBillResult> {
  const { organizationId, businessId, now } = input;
  const termStart = input.termStart ?? now;
  const sub = input.subscription;
  // A charge taken up front and not yet booked on an invoice — refunded if anything throws.
  const preCharge: { current?: CompletedCharge; currency?: string } = {};
  // A dunning-cancelled subscription still inside its term continues that term, unbilled.
  // Backdating, a trial, a buyer-present charge or a new line set each ask for a fresh term.
  const term = input.term ?? "new";
  if (term !== "new") {
    const plain = !input.termStart && !input.trialEnd && !input.paymentIntent && !input.session;
    const inTerm = !plain
      ? null
      : await withTenant(organizationId, async (tx) => {
          const [row] = await tx
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.id, sub.id))
            .limit(1);
          if (!row) return null;
          const found = await findInTermReactivation(tx, row, now);
          return found && (await sameItemSet(tx, sub.id, input.items)) ? { row, found } : null;
        });
    if (inTerm) return reactivateInCurrentTerm(input, inTerm.row, inTerm.found);
    if (term === "continue") throw new SubscriptionError(IN_TERM_REFUSAL);
  }
  // Only a cancelled subscription starts a new term to bill; undoing a pending cancel bills
  // nothing, and pricing it as a fresh term threw (a 500).
  const [current] = await withTenant(organizationId, (tx) =>
    tx
      .select({ status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.id, sub.id))
      .limit(1),
  );
  try {
    // Trials and add-to-unbilled defer the charge, so only a charge NOW needs a card.
    const willBillNow =
      current?.status === "cancelled" &&
      !input.trialEnd &&
      input.chargesHandling !== "add_to_unbilled_charges";
    const customer = await getCustomerById(organizationId, sub.customerId);
    const chargesNow =
      willBillNow && isAutoCollectOn(sub.autoCollection ?? null, customer?.autoCollection ?? null);
    if (chargesNow && customer) {
      await assertChargeableForAutoCollect({ organizationId, businessId, customer });
    }

    // Refusing on a failed charge: take the charge FIRST, so a decline leaves the
    // subscription exactly as it was — still cancelled, no invoice, nothing announced.
    // Only the failed payment is recorded. (Reactivating then undoing raised and voided an
    // invoice and mailed the customer three times per attempt.)
    const cfg = await loadReactivationConfig(input, sub.customerId);
    if (input.paymentIntent || input.session === "on_session") {
      if (!chargesNow)
        throw new SubscriptionError(
          input.paymentIntent
            ? "You supplied payment_intent, but this reactivation does not collect a payment now"
            : "You supplied payment_initiator=customer, but this reactivation does not collect a payment now",
        );
      if (!input.paymentIntent && !cfg.requireSuccessfulChargeOnReactivation)
        throw new SubscriptionError(
          "payment_initiator=customer takes the charge before the reactivation, so it needs on_charge_failure=refuse. Set on_charge_failure=refuse, or authorize a payment intent and pass payment_intent.",
        );
    }
    // A supplied intent must match the fresh term before anything is written.
    let intentId: string | null = null;
    if (input.paymentIntent) {
      const check = await checkReactivationIntent({
        organizationId,
        businessId,
        subscriptionId: sub.id,
        customerId: sub.customerId,
        items: input.items,
        termStart,
        quote: input.quote,
        paymentIntent: input.paymentIntent,
      });
      if (check) return { subscription: check.subscription, refused: check.refused };
      intentId = input.paymentIntent;
    } else if (chargesNow && cfg.requireSuccessfulChargeOnReactivation) {
      const pre = await chargeReactivationFirst({
        organizationId,
        businessId,
        subscriptionId: sub.id,
        items: input.items,
        termStart,
        quote: input.quote,
        ...(input.session ? { session: input.session } : {}),
      });
      if (pre.kind === "refused") return { subscription: pre.subscription, refused: pre.refused };
      if (pre.kind === "action_required")
        return { subscription: pre.subscription, actionRequired: { intent: pre.intent } };
      if (pre.kind === "charged") {
        preCharge.current = pre.charge;
        preCharge.currency = pre.currency;
      }
    }

    const { subscription, billable } = input.withOptions
      ? await reactivateSubscriptionWithOptions({
          organizationId,
          businessId,
          subscriptionId: sub.id,
          now: termStart,
          items: input.items,
          billingCycles: input.billingCycles ?? null,
          trialEnd: input.trialEnd ?? null,
        })
      : await reactivateSubscription({
          organizationId,
          businessId,
          subscriptionId: sub.id,
          now: termStart,
        });

    if (input.beforeBill) {
      try {
        await input.beforeBill(subscription);
      } catch (e) {
        // Nothing is billed yet; a refused coupon must not leave it live and unbilled.
        await cancelSubscription({
          organizationId,
          businessId,
          subscriptionId: subscription.id,
          atPeriodEnd: false,
          now,
        });
        throw e;
      }
    }

    let invoiceView: ReactivateAndBillResult["invoice"];
    let chargeError: ReactivateAndBillResult["paymentError"];
    if (billable && input.chargesHandling === "add_to_unbilled_charges") {
      // Defer the fresh period to an unbilled charge. Rate the FULL recurring charge from item
      // snapshots, not the monthly-normalised MRR.
      const { addAdHocCharge, recurringChargeMinor } = await import("./items");
      const amount = await recurringChargeMinor(organizationId, subscription.id);
      if (amount > 0n) {
        await addAdHocCharge({
          organizationId,
          businessId,
          subscriptionId: subscription.id,
          description: "Reactivated period charge",
          amountMinor: Number(amount),
          invoiceNow: false,
          now,
        });
      }
    } else if (billable) {
      // Reactivated INTO a trial has no term and is not `billable`; anything else has one.
      const start = subscription.currentPeriodStart;
      const end = subscription.currentPeriodEnd;
      if (!start || !end)
        throw new Error(`subscription ${subscription.publicId} is billable with no term`);
      if (intentId) {
        return await billWithIntent({
          organizationId,
          businessId,
          subscription,
          periodStart: start,
          periodEnd: end,
          intentId,
          now,
          refuseOnFailure: cfg.requireSuccessfulChargeOnReactivation,
        });
      }
      let billed: Awaited<ReturnType<typeof billSubscriptionPeriod>>;
      try {
        const charge = preCharge.current;
        billed = charge
          ? await commitSubscriptionPeriodInvoice(
              await planSubscriptionPeriodInvoice({
                organizationId,
                businessId,
                subscription,
                periodStart: start,
                periodEnd: end,
              }),
              { charge },
            )
          : await billSubscriptionPeriod({
              organizationId,
              businessId,
              subscription,
              periodStart: start,
              periodEnd: end,
            });
      } catch (e) {
        if (!(preCharge.current && e instanceof ChargeAmountMismatchError)) throw e;
        // The invoice came out at a different amount than the charge (a discount or
        // balance moved in between). Nothing was invoiced; give the money back and undo.
        const taken = preCharge.current;
        preCharge.current = undefined;
        await refundPreInvoiceCharge({
          organizationId,
          businessId,
          charge: taken,
          currency: preCharge.currency ?? subscription.currency,
          reason: "invoice_amount_mismatch",
        }).then((r) => {
          if (!r.refunded)
            log.error(
              "refund FAILED for a reactivation pre-charge — manual intervention required",
              {
                event: "reactivation_precharge_refund_failed",
                subscription: subscription.publicId,
                amountMinor: taken.amountMinor,
                error: r.error ?? "unknown",
              },
            );
        });
        await cancelSubscription({
          organizationId,
          businessId,
          subscriptionId: subscription.id,
          atPeriodEnd: false,
          now,
          cancelReason: "not_paid",
        });
        return {
          subscription,
          refused: {
            code: "amount_changed",
            message:
              "We did not reactivate the subscription. The amount due changed while we took the payment. We refunded the charge. Try again.",
          },
        };
      }
      preCharge.current = undefined; // booked on the invoice
      const { invoice, payment } = billed;
      // Logged every time, so a refusal — or a charge that stood — is always attributable.
      log.info("reactivation charge outcome", {
        event: "reactivation_charge_outcome",
        subscription: subscription.publicId,
        invoice: invoice.publicId,
        charges_now: chargesNow,
        payment: payment?.publicId ?? null,
        payment_status: payment?.status ?? null,
        failure_code: payment?.failureCode ?? null,
        failure_error_id: payment?.failureCode
          ? resolveStoredErrorId(payment.failureCode).id
          : null,
        collect_on_pm_update: cfg.collectOnPaymentMethodUpdate,
        require_charge_on_reactivation: cfg.requireSuccessfulChargeOnReactivation,
        will_refuse:
          chargesNow && payment?.status === "failed" && cfg.requireSuccessfulChargeOnReactivation,
      });
      if (
        chargesNow &&
        payment &&
        payment.status === "failed" &&
        cfg.requireSuccessfulChargeOnReactivation
      ) {
        const { voidInvoice } = await import("@/modules/invoicing/ops");
        try {
          await voidInvoice(organizationId, businessId, invoice.publicId);
        } catch (undoErr) {
          log.error(undoErr, {
            event: "reactivation_invoice_void_failed",
            invoice: invoice.publicId,
          });
        }
        await cancelSubscription({
          organizationId,
          businessId,
          subscriptionId: subscription.id,
          atPeriodEnd: false,
          now,
          cancelReason: "not_paid",
        });
        return {
          subscription,
          refused: {
            code: payment.failureCode ?? "charge_failed",
            message: paymentFailedMessage(
              payment.failureCode ?? "charge_failed",
              payment.failureMessage ?? "the card was declined",
            ),
          },
        };
      }
      invoiceView = {
        publicId: invoice.publicId,
        status: invoice.status,
        totalMinor: invoice.totalMinor,
      };
      // Reactivated with an unpaid invoice: say why, so the caller can tell the operator.
      if (chargesNow && payment?.status === "failed")
        chargeError = {
          code: payment.failureCode ?? "charge_failed",
          message: payment.failureMessage ?? "the card was declined",
        };
    }
    // Reactivation is an ACTIVATION: repeatable activation-attached items fire again.
    const { fireActivationCharges } = await import("./items");
    await fireActivationCharges({
      organizationId,
      businessId,
      subscriptionId: subscription.id,
      now,
    });
    return {
      subscription,
      ...(invoiceView ? { invoice: invoiceView } : {}),
      ...(chargeError ? { paymentError: chargeError } : {}),
    };
  } catch (e) {
    // Charged up front but failed before the invoice booked it: the customer paid for
    // nothing, so refund it. (Once booked, `charge` is cleared above.)
    if (preCharge.current) {
      await refundPreInvoiceCharge({
        organizationId,
        businessId,
        charge: preCharge.current,
        currency: preCharge.currency ?? "",
        reason: "reactivation_failed",
      }).catch((refundErr) =>
        log.error(refundErr, {
          event: "reactivation_precharge_refund_failed",
          subscription: sub.publicId,
        }),
      );
    }
    // A thrown charge leaves an invoice with no owner (no dunning status, no retry). Hand an
    // invoice THIS call raised to dunning; never void it — the money may have moved.
    try {
      const cfg = await withTenant(organizationId, (tx) =>
        loadEffectiveDunningConfig(tx, {
          businessId,
          customerId: sub.customerId,
          subscriptionId: sub.id,
        }),
      );
      const [pmRow] = await withTenant(organizationId, (tx) =>
        tx
          .select({ pm: subscriptions.defaultPaymentMethodId })
          .from(subscriptions)
          .where(eq(subscriptions.id, sub.id))
          .limit(1),
      );
      const days = await methodRetryDays(organizationId, cfg, pmRow?.pm);
      const adopted = await withTenant(organizationId, async (tx) => {
        const [stranded] = await tx
          .select({ id: invoices.id, publicId: invoices.publicId })
          .from(invoices)
          .where(
            and(
              eq(invoices.subscriptionId, sub.id),
              eq(invoices.status, "payment_due"),
              isNull(invoices.dunningStatus),
              isNull(invoices.nextAttemptAt),
              gte(invoices.createdAt, now),
            ),
          )
          .limit(1);
        if (!stranded) return null;
        await tx
          .update(invoices)
          .set({
            dunningStatus: "in_progress" as const,
            // One notional attempt: the charge was made, its outcome is unknown.
            nextAttemptAt: nextRetryAt(1, now, days) ?? addUtcDays(now, 1),
          })
          .where(eq(invoices.id, stranded.id));
        return stranded.publicId;
      });
      if (adopted)
        log.warn("a thrown reactivation charge left an invoice unowned; handed to dunning", {
          event: "reactivation_stranded_invoice_adopted",
          subscription: sub.publicId,
          invoice: adopted,
        });
    } catch (adoptErr) {
      // Never mask the original failure with a repair failure.
      log.error(adoptErr, {
        event: "reactivation_stranded_adopt_failed",
        subscription: sub.publicId,
      });
    }
    throw e;
  }
}

/** The effective dunning config, with this call's `onChargeFailure` applied. */
async function loadReactivationConfig(
  input: Parameters<typeof reactivateAndBill>[0],
  customerId: string,
) {
  const cfg = await withTenant(input.organizationId, (tx) =>
    loadEffectiveDunningConfig(tx, {
      businessId: input.businessId,
      customerId,
      subscriptionId: input.subscription.id,
    }),
  );
  return {
    ...cfg,
    requireSuccessfulChargeOnReactivation: requiresChargeOnReactivation(
      cfg.requireSuccessfulChargeOnReactivation,
      input.onChargeFailure,
    ),
  };
}

/**
 * Price the fresh term exactly as the invoice will (`estimateReactivate`), then take that
 * charge before anything is committed. A decline records only the failed payment.
 */
async function chargeReactivationFirst(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  items?: ReactivationItemInput[];
  termStart: Date;
  quote?: ReactivateQuote;
  session?: "on_session";
}): Promise<
  | { kind: "charged"; charge: CompletedCharge; currency: string }
  | { kind: "nothing_due" }
  | { kind: "refused"; subscription: Sub; refused: { code: string; message: string } }
  | { kind: "action_required"; subscription: Sub; intent: PaymentIntent }
> {
  const { organizationId, businessId } = input;
  const row = await withTenant(organizationId, async (tx) => {
    const [r] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, input.subscriptionId))
      .limit(1);
    return r;
  });
  if (!row) throw new Error("Subscription not found");
  const items = input.items ?? (await currentItems(organizationId, input.subscriptionId));
  const est = await estimateReactivate({
    organizationId,
    businessId,
    subscriptionId: input.subscriptionId,
    items,
    now: input.termStart,
    ...(input.quote?.couponCodes?.length ? { couponCodes: input.quote.couponCodes } : {}),
    ...(input.quote?.manualDiscount ? { manualDiscount: input.quote.manualDiscount } : {}),
  });
  const due = BigInt(est.amount_due_minor ?? est.total_minor);
  if (due <= 0n) return { kind: "nothing_due" };
  const outcome = await chargeBeforeSubscriptionInvoice({
    organizationId,
    businessId,
    customerId: row.customerId,
    subscription: row,
    amountMinor: due,
    currency: est.currency,
    flow: "reactivation",
    // One key per reactivation attempt: a replayed request stays one charge, a later
    // attempt is a new one, and neither collides with the signup's first charge.
    idempotencyScope: `reactivation_${input.termStart.getTime()}`,
    ...(input.session ? { session: input.session } : {}),
  });
  if (outcome.kind === "charged")
    return { kind: "charged", charge: outcome.charge, currency: est.currency };
  if (outcome.kind === "action_required" && input.session === "on_session")
    return { kind: "action_required", subscription: row as unknown as Sub, intent: outcome.intent };
  const reason =
    outcome.kind === "declined"
      ? outcome.failureMessage
      : outcome.kind === "deferred"
        ? "This payment method needs an advance notice to the bank before each payment, so it cannot pay a reactivation at once. Use a different payment method, or start a new subscription through a checkout link."
        : "the payment needs the customer's authentication";
  log.info("reactivation refused before anything was committed", {
    event: "reactivation_refused_precharge",
    subscription: row.publicId,
    amount_minor: due,
    failure_code: outcome.kind === "declined" ? outcome.failureCode : outcome.kind,
  });
  const code =
    outcome.kind === "declined"
      ? outcome.failureCode
      : outcome.kind === "deferred"
        ? "pre_debit_notice_required"
        : "authentication_required";
  return {
    kind: "refused",
    subscription: row as unknown as Sub,
    refused: { code, message: paymentFailedMessage(code, reason) },
  };
}

/**
 * The in-term branch of `reactivateAndBill`. Raises no invoice. When the business requires
 * a successful charge to reactivate and the term's invoice is still open on auto-collection,
 * that invoice is collected once first; a failure leaves the subscription cancelled.
 */
async function reactivateInCurrentTerm(
  input: Parameters<typeof reactivateAndBill>[0],
  row: typeof subscriptions.$inferSelect,
  found: InTermReactivation,
): Promise<ReactivateAndBillResult> {
  const { organizationId, businessId, now } = input;
  const cfg = await loadReactivationConfig(input, row.customerId);
  if (cfg.requireSuccessfulChargeOnReactivation && found.outstandingMinor > 0n) {
    const customer = await getCustomerById(organizationId, row.customerId);
    if (customer && isAutoCollectOn(row.autoCollection, customer.autoCollection)) {
      await assertChargeableForAutoCollect({ organizationId, businessId, customer });
      const payment = await collectInvoice({
        organizationId,
        businessId,
        invoice: found.invoice,
        subscription: row,
        manualAttempt: true,
      });
      if (payment.status === "failed") {
        const code = payment.failureCode ?? "charge_failed";
        return {
          subscription: row as unknown as Sub,
          refused: {
            code,
            message: paymentFailedMessage(
              code,
              payment.failureMessage ?? `We could not collect invoice ${found.invoice.publicId}.`,
            ),
          },
        };
      }
    }
  }
  const { subscription } = await reactivateSubscriptionInTerm({
    organizationId,
    businessId,
    subscriptionId: row.id,
    now,
    billingCycles: input.billingCycles ?? null,
  });
  // Coupons land on the subscription and discount the next renewal.
  if (input.beforeBill) await input.beforeBill(subscription);
  log.info("reactivated in the current term", {
    event: "reactivation_in_term",
    subscription: row.publicId,
    term_invoice: found.invoice.publicId,
    outstanding_minor: String(found.outstandingMinor),
  });
  return {
    subscription,
    inTerm: { invoice: found.invoice, outstandingMinor: found.outstandingMinor },
  };
}

/**
 * The refusal sentence. The normalized code leads: the text is often the gateway's
 * generic buyer copy ("a temporary issue") and says less than the code does.
 */
function paymentFailedMessage(code: string, text: string): string {
  const reason = /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
  return `We did not reactivate the subscription. The payment failed (${code}): ${reason} The subscription stays cancelled.`;
}

type ReactivateQuote = NonNullable<Parameters<typeof reactivateAndBill>[0]["quote"]>;

/**
 * Refuse an intent that cannot pay the fresh term — the same checks a signup makes, against
 * the same estimate the pre-charge prices from. Null when it is usable.
 */
async function checkReactivationIntent(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  customerId: string;
  items?: ReactivationItemInput[];
  termStart: Date;
  quote?: ReactivateQuote;
  paymentIntent: string;
}): Promise<{
  subscription: Sub;
  refused: NonNullable<ReactivateAndBillResult["refused"]>;
} | null> {
  const { organizationId, businessId } = input;
  const row = await withTenant(organizationId, async (tx) => {
    const [r] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, input.subscriptionId))
      .limit(1);
    return r;
  });
  if (!row) throw new Error("Subscription not found");
  const refuse = (code: string, message: string) => ({
    subscription: row as unknown as Sub,
    refused: { code, message, status: 400 as const },
  });
  const piId = input.paymentIntent;
  const intent = await getPaymentIntent(organizationId, businessId, piId);
  if (!intent)
    return refuse("payment_intent_not_found", `We could not find the payment intent ${piId}.`);
  if (intent.customerId !== input.customerId)
    return refuse(
      "payment_intent_customer_mismatch",
      `Payment intent ${piId} belongs to a different customer`,
    );
  if ((intent.purpose ?? "payment") !== "payment")
    return refuse(
      "payment_intent_wrong_purpose",
      `Payment intent ${piId} is a ${intent.purpose} intent. It cannot pay an invoice.`,
    );
  if (intent.currency !== row.currency)
    return refuse(
      "payment_intent_currency_mismatch",
      `Payment intent ${piId} is in ${intent.currency}, but the subscription bills in ${row.currency}`,
    );
  if (intent.status !== "authorized")
    return refuse(
      "payment_intent_not_authorized",
      `Payment intent ${piId} is ${intent.status}. The buyer must complete it first.`,
    );
  const items = input.items ?? (await currentItems(organizationId, input.subscriptionId));
  const est = await estimateReactivate({
    organizationId,
    businessId,
    subscriptionId: input.subscriptionId,
    items,
    now: input.termStart,
    ...(input.quote?.couponCodes?.length ? { couponCodes: input.quote.couponCodes } : {}),
    ...(input.quote?.manualDiscount ? { manualDiscount: input.quote.manualDiscount } : {}),
  });
  const due = BigInt(est.amount_due_minor ?? est.total_minor);
  if (intent.amountMinor !== due)
    return refuse(
      "payment_intent_amount_mismatch",
      `Payment intent ${piId} authorized ${intent.amountMinor} but the reactivation invoice is ${due}`,
    );
  return null;
}

/**
 * Raise the fresh term's invoice uncollected and settle it by consuming the intent. A plan
 * that no longer matches the intent undoes the reactivation (nothing was invoiced). A refused
 * capture leaves an open invoice: voided and re-cancelled when the business requires a
 * successful charge, otherwise handed to dunning so it is never left unowned.
 */
async function billWithIntent(input: {
  organizationId: string;
  businessId: string;
  subscription: Sub;
  periodStart: Date;
  periodEnd: Date;
  intentId: string;
  now: Date;
  refuseOnFailure: boolean;
}): Promise<ReactivateAndBillResult> {
  const { organizationId, businessId, subscription, now } = input;
  const intent = await getPaymentIntent(organizationId, businessId, input.intentId);
  const plan = await planSubscriptionPeriodInvoice({
    organizationId,
    businessId,
    subscription,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
  });
  const plannedDue = plan.mode === "finalize" ? plan.money.amountDue : 0n;
  if (!intent || intent.amountMinor !== plannedDue) {
    await cancelSubscription({
      organizationId,
      businessId,
      subscriptionId: subscription.id,
      atPeriodEnd: false,
      now,
      cancelReason: "not_paid",
    });
    return {
      subscription,
      refused: {
        code: "payment_intent_amount_mismatch",
        status: 400,
        message: `We did not reactivate the subscription. The amount due changed to ${plannedDue} while we processed the request. We charged nothing. Authorize a new intent and retry.`,
      },
    };
  }
  const committed = await commitSubscriptionPeriodInvoice(plan, { collect: false });
  const consumed = await consumePaymentIntent(
    organizationId,
    businessId,
    input.intentId,
    committed.invoice.publicId,
  );
  const failed = !consumed || captureRefused(consumed.charge);
  const paymentError = failed
    ? {
        code: consumed?.charge?.failure?.code ?? "capture_failed",
        message: consumed?.charge?.failure?.message ?? "We could not capture the payment.",
      }
    : undefined;
  if (failed && input.refuseOnFailure) {
    const { voidInvoice } = await import("@/modules/invoicing/ops");
    try {
      await voidInvoice(organizationId, businessId, committed.invoice.publicId);
    } catch (undoErr) {
      log.error(undoErr, {
        event: "reactivation_invoice_void_failed",
        invoice: committed.invoice.publicId,
      });
    }
    await cancelSubscription({
      organizationId,
      businessId,
      subscriptionId: subscription.id,
      atPeriodEnd: false,
      now,
      cancelReason: "not_paid",
    });
    return {
      subscription,
      refused: {
        code: paymentError!.code,
        message: paymentFailedMessage(paymentError!.code, paymentError!.message),
      },
    };
  }
  if (failed)
    await handUncollectedInvoiceToDunning({
      organizationId,
      businessId,
      customerId: subscription.customerId,
      subscriptionId: subscription.id,
      invoiceId: committed.invoice.id,
      paymentMethodId: subscription.defaultPaymentMethodId,
      now,
    });
  const invoice = await withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, committed.invoice.id))
      .limit(1);
    return row ?? committed.invoice;
  });
  const { fireActivationCharges } = await import("./items");
  await fireActivationCharges({ organizationId, businessId, subscriptionId: subscription.id, now });
  return {
    subscription,
    invoice: { publicId: invoice.publicId, status: invoice.status, totalMinor: invoice.totalMinor },
    ...(consumed ? { paymentIntent: consumed.intent } : {}),
    ...(paymentError ? { paymentError } : {}),
  };
}

/** The subscription's own lines, as a reactivation that changes nothing rebuilds them. */
async function currentItems(
  organizationId: string,
  subscriptionId: string,
): Promise<ReactivationItemInput[]> {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({
        price: prices.publicId,
        quantity: subscriptionItems.quantity,
        snapshot: subscriptionItems.priceSnapshot,
        freeQuantity: subscriptionItems.freeQuantity,
      })
      .from(subscriptionItems)
      .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
      .where(eq(subscriptionItems.subscriptionId, subscriptionId)),
  );
  return rows.map((r) => {
    const snap = (r.snapshot ?? null) as {
      amountOverridden?: boolean;
      amountMinor?: number | null;
    } | null;
    return {
      price: r.price,
      quantity: r.quantity,
      unitPriceMinor: snap?.amountOverridden && snap.amountMinor != null ? snap.amountMinor : null,
      freeQuantity: r.freeQuantity,
    };
  });
}
