import { CommitmentError, getCommitment, setCommitment } from "@/modules/subscriptions/commitment";
import {
  missingReason,
  resolveBillingRulesConfig,
  PLAN_CREDIT_CANCEL_AT_PERIOD_ENDS,
  PLAN_CREDIT_PAUSES,
  SPECIFIC_DATE_FINAL_PERIODS,
  type AllowanceUpgrade,
  type PlanCreditUpgrade,
} from "@/modules/subscriptions/billing-rules-config";
import type { ResetOverrides } from "@/modules/credits/reset-settings";
import { ShippingAddressError } from "@/modules/customers/addresses";
import { resolveStoredErrorId } from "@/providers/decline-codes";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  directionOfItemEdit,
  nowNotAllowedMessage,
  prorateFor,
  resolveChangePolicy,
  planMovesInEdit,
  resetTermForPolicy,
  type ChangeDirection,
  type ChangeSource,
  type ChangeTiming,
} from "@/modules/subscriptions/change-policy";
import { resolveDunningConfig } from "@/modules/subscriptions/dunning-schedule";
import {
  lockedOverrideMessage,
  lockedOverrides,
  resolvePauseConfig,
} from "@/modules/subscriptions/pause-config";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { invoiceLineItems, invoices, paymentMethods, subscriptions } from "@db/schema";
import { CollectionDeferredError, CollectionInFlightError } from "@/modules/invoicing/service";
import { nextRetryAt, addUtcDays } from "@/modules/subscriptions/dunning-schedule";
import { z } from "zod";
import { LIMITS, clientResultField, metadataField } from "./limits";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { businessWallClock } from "@/platform/clock";
import { getCustomerByPublicId, getCustomerById } from "@/modules/customers/service";
import { getPriceByPublicId } from "@/modules/catalog/service";
import { computeLineAmount, type PriceSnapshot } from "@/modules/catalog/pricing";
import {
  createSubscription,
  deferFirstPeriodToUnbilledCharges,
  deleteProvisionalSubscription,
  listSubscriptionsPage,
  countSubscriptions,
  subscriptionCustomFieldFilterSet,
  SUBSCRIPTION_FILTER_KINDS,
  SUBSCRIPTION_FILTER_OPS,
  SUBSCRIPTION_SORT_FIELDS,
  getSubscriptionDetail,
  updateSubscriptionSettings,
  SubscriptionError,
  type SubscriptionItemInput,
} from "@/modules/subscriptions/service";
import {
  billSubscriptionPeriod,
  planSubscriptionPeriodInvoice,
  commitSubscriptionPeriodInvoice,
  getInvoiceWithLines,
  ChargeAmountMismatchError,
  isAutoCollectOn,
} from "@/modules/invoicing/service";
import {
  chargeBeforeSubscriptionInvoice,
  refundPreInvoiceCharge,
  type CompletedCharge,
} from "@/modules/invoicing/collection";
import {
  applyClientResult,
  captureRefused,
  consumePaymentIntent,
  getPaymentIntent,
  serializePaymentIntent,
  PaymentIntentConflictError,
  PaymentIntentError,
} from "@/modules/payment-intents/service";
import { inclusivePeriodEnd } from "@/modules/invoicing/serialize";
import { flushDeferredEvents, type DeferredEvents } from "@/modules/events/emit";
import {
  assertChargeableForAutoCollect,
  NoChargeablePaymentMethodError,
} from "@/modules/payment-methods/service";
import {
  changeSubscription,
  ProrationError,
  ProrationConflictError,
  defaultInvoiceImmediately,
  type ItemAdd,
  type ItemChange,
} from "@/modules/subscriptions/proration";
import {
  loadLiveItems,
  planItemOperations,
  applyItemOperations,
  resolveDesiredItems,
  ItemReconcileError,
} from "@/modules/subscriptions/reconcile";
import {
  estimateCancel,
  estimateChange,
  estimateNewSubscription,
  estimateReactivate,
  estimateRenewal,
} from "@/modules/subscriptions/estimate";
import {
  QUOTE_MOVED_MESSAGE,
  estimateQuote,
  quotedInstant,
} from "@/modules/subscriptions/price-quote";
import {
  scheduleChange,
  listScheduledChanges,
  cancelScheduledChange,
} from "@/modules/subscriptions/scheduled-changes";
import {
  addSubscriptionItem,
  removeSubscriptionItem,
  addAdHocCharge,
  addAdHocCharges,
  listUnbilledCharges,
  triggerAttachedItemCharge,
  type AdHocChargeInput,
} from "@/modules/subscriptions/items";
import { resolveUnbilledChargesConfig } from "@/modules/subscriptions/unbilled-charges-config";
import {
  resolveBackdatingConfig,
  isBackdateAllowed,
} from "@/modules/subscriptions/backdating-config";
import {
  getSubscriptionByPublicId,
  getSubscriptionItems,
  cancelSubscription,
  cancelSubscriptionWithOptions,
  deleteSubscription,
  pauseSubscriptionWithOptions,
  resumeSubscriptionWithOptions,
  reactivateSubscription,
  reactivateSubscriptionWithOptions,
  removeScheduledCancellation,
  changeTermEnd,
  editTrialEnd,
  scheduleResumeSubscription,
  subscriptionDues,
  recurringAmountForSubscription,
} from "@/modules/subscriptions/service";
import {
  recordUsage,
  UsageIdempotencyConflictError,
  UsageOutsideWindowError,
  UsageRuleError,
} from "@/modules/metering/service";
import { assertMetadataAllowed } from "@/modules/metadata-rules/service";
import { CustomFieldError, filterDefinitions } from "@/modules/custom-fields/service";
import {
  applyManualDiscount,
  applyCouponToSubscription,
  removeDiscount,
  CouponError,
} from "@/modules/coupons/service";
import {
  serializeSubscription,
  serializeScheduledChange,
  type TermEndConvention,
} from "@/modules/subscriptions/serialize";
import {
  resolveBusiness,
  badRequest,
  conflict,
  notFound,
  parseListQuery,
  listFilterError,
  listResponse,
  requirePerm,
} from "./helpers";
import { createLogger } from "@/platform/logger";
import {
  handUncollectedInvoiceToDunning,
  reactivateAndBill,
} from "@/modules/subscriptions/reactivate";
import {
  resolveLifecycleConfig,
  type PlanChangeCoupons,
} from "@/modules/subscriptions/lifecycle-config";
import { creditHandlingFor } from "@/modules/subscriptions/downgrade-credit";
import { cfKeys, parseRequest } from "./strict-params";
import { collectedRevenue } from "@/modules/payments/revenue";
import { currentEventContext } from "@/platform/event-context";
import {
  listRenewalSkips,
  listUpcomingRenewals,
  renewalSkipViews,
  serializeRenewalSkip,
  skipRenewal,
  unskipRenewal,
  type SkipSource,
} from "@/modules/subscriptions/renewal-skips";

/** One subscription's skip view, for `next_billing_at` and `skipped_renewals`. */
const skipViewOf = async (
  organizationId: string,
  sub: Parameters<typeof renewalSkipViews>[1][number],
) => (await renewalSkipViews(organizationId, [sub])).get(sub.id);

const log = createLogger("subscriptions");

/**
 * A money field arriving as a JSON number → the `bigint` the schema stores, preserving
 * the three-way distinction the caller made: `undefined` = not sent (leave alone),
 * `null` = clear it, a number = set it. `?? null` would collapse the first two and turn
 * every unrelated PATCH into a cap-clearing one.
 */
const bigintOrNull = (v: number | null | undefined): bigint | null | undefined =>
  v === undefined ? undefined : v === null ? null : BigInt(v);

const createSubBody = z
  .object({
    /**
     * Caller-supplied subscription id, named at signup. Omit it and you get a fresh
     * `sub_<nano>`. Unique per BUSINESS
     * (`subscriptions_biz_public_id_uq`), so it lives in the caller's own namespace and
     * a collision is reported as a 400 rather than surfacing a constraint violation.
     * Charset is deliberately conservative: these ids appear in URLs and invoice PDFs.
     * Exists mainly so a migration can keep its existing subscription ids.
     */
    id: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, "id may contain only letters, digits, _ and -")
      .optional(),
    items: z
      .array(
        z.object({
          price: z.string().max(LIMITS.id).min(1),
          quantity: z.number().int().positive().max(LIMITS.quantity).default(1),
          unit_price_minor: z.number().int().nonnegative().optional(), // custom price override (flat/per-unit)
          free_quantity: z.number().int().nonnegative().optional(),
          billing_cycles: z.number().int().positive().optional(),
          metadata: metadataField().optional(),
        }),
      )
      .max(LIMITS.lineItems)
      .min(1),
    // 0 = explicit no-trial (disable the plan's default trial);
    // >0 = trial of N days; omitted = auto-apply the plan price's trial_period.
    trial_days: z.number().int().nonnegative().optional(),
    /** An exact trial end, in place of `trial_days`. */
    trial_end: z.string().datetime({ offset: true }).optional(),
    start_date: z.string().datetime().optional(), // backdate/future-date the period start
    billing_anchor: z.string().datetime().optional(), // calendar billing anchor
    auto_collection: z.enum(["on", "off"]).optional(), // CP-1 (overrides customer)
    create_pending_invoices: z.boolean().optional(), // E2 (overrides business default)
    // Default: the plan price's.
    bill_usage_monthly: z.boolean().optional(),
    commitment_amount_minor: z.number().int().positive().nullable().optional(),
    /**
     * SIGNUP-time invoicing — a true|false choice, default true. `true`/omitted
     * raises and (with
     * auto-collection on) collects the first invoice now. `false` queues the first
     * period's recurring charge as a pending UNBILLED CHARGE instead, so it rides on
     * the next invoice — nothing is invoiced or collected at signup.
     *
     * NOT the same field as `create_pending_invoices`, which governs how every
     * RENEWAL is invoiced. Moot for a trial or a future-dated start (neither raises
     * an invoice now anyway) — accepted and ignored on those paths.
     * Not persisted: it describes what to do at signup, not durable subscription
     * state, which is also why `businesses.default_invoice_immediately` is NOT
     * consulted here — that default governs change/term-change proration.
     */
    invoice_immediately: z.boolean().optional(),
    net_term_days: z.number().int().min(0).max(365).optional(),
    /**
     * Credits Flexibility (0219), subscription half — the billing overrides
     * `max_refundable_credits_usage` / `max_excess_payment_usage`,
     * flattened like every other commercial field on this body. Integer MINOR UNITS: the
     * most of that bucket that may be AUTO-applied to one invoice for this subscription.
     * Omitted / null = no subscription cap (today's behaviour); `0` = never auto-apply to
     * this subscription. Narrows the business's `credits_flexibility`, never widens it.
     */
    max_refundable_credits_usage_minor: z.number().int().min(0).nullable().optional(),
    max_excess_payment_usage_minor: z.number().int().min(0).nullable().optional(),
    po_number: z.string().max(100).optional(),
    /** Ship-to: an `addr_…` id from the customer's address book. Absent = their default. */
    shipping_address_id: z.string().min(1).max(64).optional(),
    invoice_notes: z.string().max(2000).optional(),
    coupon_ids: z.array(z.string().min(1)).optional(), // coupons applied AT SIGNUP (discount the first invoice)
    /**
     * A manual discount applied AT SIGNUP — a %/amount reduction with no catalog coupon
     * behind it, the same thing `POST …/manual_discount` applies to an existing
     * subscription. Like `coupon_ids`, it discounts the FIRST invoice.
     *
     * Applied immediately, not from the next renewal.
     *
     * Before this existed the dashboard created the subscription (which raises and collects
     * the first invoice inside that call) and THEN issued a second
     * `POST …/manual_discount` — so the discount an operator set at signup landed on the
     * NEXT renewal, and a failure surfaced only as a warning beside a success banner.
     *
     * SINGULAR, never an array: our engine allows one discount per subscription
     * (`applyManualDiscount` refuses a second, coupon-sourced or not — pinned by
     * verify:coupons). An array would imply a stacking this engine does not do.
     */
    discount: z
      .object({
        type: z.enum(["percent", "amount"]),
        value: z.number().positive(),
        duration: z.enum(["one_time", "forever"]),
        note: z.string().max(500).optional(),
      })
      .refine((d) => d.type !== "percent" || (d.value >= 1 && d.value <= 100), {
        message: "value must be between 1 and 100 for a percent discount",
      })
      .optional(),
    /**
     * An intent the buyer has ALREADY authorized (`pi_…`, purpose `payment`). Present
     * = settle the first invoice by CONSUMING it instead of issuing a bare charge —
     * which is how a signup that needed 3DS finishes: the first attempt answers 402
     * `requires_action` with an intent, the buyer completes the challenge, and the
     * same request is re-sent carrying `payment_intent`.
     *
     * Must belong to this business and this customer, be `authorized`, and its amount
     * + currency must equal the first invoice's amount due (the engine re-checks the
     * amount against the committed invoice — this route just fails earlier and more
     * clearly).
     */
    payment_intent: z.string().max(LIMITS.id).min(1).optional(),
    /** What the buyer's browser SDK returned for `payment_intent`'s `mode: 'sdk'` challenge. */
    client_result: clientResultField().optional(),
    /**
     * Declares that a BUYER is at the other end of this request (a checkout page, a
     * buyer-facing SPA) and can complete an authentication challenge. Default false —
     * a server-to-server signup is off-session, where `requires_action` is a refusal
     * exactly as it has always been. Never inferred from anything.
     */
    on_session: z.boolean().optional(),
    /**
     * A failed first charge (auto-collection on, charged at create). `refuse` (default):
     * nothing is created, 402. `dun`: created active, the invoice stays open for dunning.
     */
    on_charge_failure: z.enum(["refuse", "dun"]).optional(),
    /**
     * `payment_method` — one of this customer's saved payment methods (`pm_…`) to pin
     * to the subscription. Collection charges it first (then the customer's backups), the
     * same pin a checkout sets. Omitted: the customer's primary, as before.
     */
    payment_method: z.string().max(LIMITS.id).min(1).optional(),
    metadata: metadataField().optional(),
    custom_fields: metadataField().optional(), // SET-4 (or top-level cf_* on the body)
  })
  .catchall(cfKeys); // top-level cf_<name> custom fields

/**
 * A customer's payment method by public id, usable for charging — the check behind every
 * `payment_method`. Returns the row, or the reason it cannot be pinned.
 */
async function pinnablePaymentMethod(
  organizationId: string,
  customerId: string,
  pmPublicId: string,
): Promise<{ id: string } | { error: string }> {
  const [pm] = await withTenant(organizationId, (tx) =>
    tx
      .select({ id: paymentMethods.id, status: paymentMethods.status })
      .from(paymentMethods)
      .where(
        and(eq(paymentMethods.customerId, customerId), eq(paymentMethods.publicId, pmPublicId)),
      )
      .limit(1),
  );
  if (!pm)
    return { error: `We could not find the payment method ${pmPublicId} for this customer.` };
  if (pm.status === "expired" || pm.status === "invalid")
    return { error: `Payment method ${pmPublicId} is ${pm.status} and cannot be charged` };
  return { id: pm.id };
}

/**
 * `reactivate_from` — the guard a checkout's `reactivate_from` applies, for the operator
 * route and its estimate: a cancelled subscription, a past instant no earlier than the
 * cancellation, inside the business's backdating window. Null when allowed.
 */
function reactivateFromProblem(
  business: Parameters<typeof resolveBackdatingConfig>[0] & { timezone?: string | null },
  sub: { status: string; canceledAt: Date | null },
  at: Date,
  now: Date,
): string | null {
  if (sub.status !== "cancelled")
    return `reactivate_from applies only to a cancelled subscription. This subscription is ${sub.status}.`;
  if (at > now) return "reactivate_from cannot be in the future";
  if (sub.canceledAt && at < sub.canceledAt)
    return "reactivate_from cannot be before the subscription was cancelled";
  const verdict = isBackdateAllowed({
    config: resolveBackdatingConfig(business),
    action: "reactivate",
    target: at,
    now,
    businessTimezone: business?.timezone ?? null,
    raisesPastDatedInvoice: true,
  });
  return verdict.allowed ? null : verdict.message;
}

/** Collect top-level `cf_<name>` params + merge with nested `custom_fields`. */
function collectCustomFields(
  rawBody: unknown,
  nested: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  const out: Record<string, unknown> = {};
  if (rawBody && typeof rawBody === "object") {
    for (const [k, v] of Object.entries(rawBody as Record<string, unknown>)) {
      if (k.startsWith("cf_")) out[k] = v;
    }
  }
  if (nested && typeof nested === "object") Object.assign(out, nested);
  if (nested === null && Object.keys(out).length === 0) return null;
  return Object.keys(out).length ? out : undefined;
}

const usageBody = z.object({
  item: z.string().max(LIMITS.id).min(1), // subscription item id (si_…) for a usage-model price
  // Negative only for a recurring sum or a weighted_sum price (`usageEventIssue`).
  quantity: z.number().int().min(-LIMITS.amountMinor).max(LIMITS.amountMinor),
  unique_key: z.string().min(1).max(256).optional(), // for `unique` aggregation (e.g. distinct user id)
  operation: z.enum(["add", "remove"]).optional(),
  timestamp: z.string().datetime().optional(),
  idempotency_key: z.string().max(LIMITS.id).min(1).optional(),
  note: z.string().min(1).max(500).optional(), // operator note; never on a customer document
});

/**
 * Lets a body `idempotency_key` stand in for a missing `Idempotency-Key` header, so callers
 * that send only the body key keep working. Scoped to the item, like the usage table's own
 * unique key, so one key string reused across items does not collide.
 */
async function usageBodyKeyAsHeader(req: FastifyRequest): Promise<void> {
  if (req.headers["idempotency-key"]) return;
  const b = req.body as { item?: unknown; idempotency_key?: unknown } | null | undefined;
  if (typeof b?.item === "string" && typeof b.idempotency_key === "string" && b.idempotency_key)
    req.headers["idempotency-key"] = `usage:${b.item}:${b.idempotency_key}`;
}

/**
 * A scheduled `change` carries the SAME three lists as `/change` — `changes`, `adds`,
 * `removes` — because a deferred composition edit is the same edit, applied later. It
 * took `changes` only until now, which is what made the change screen refuse to defer
 * any edit that added or removed a line; see `scheduleChange`'s field docs for why
 * nothing below the API required that.
 *
 * Shapes are copied field-for-field from `changeSubBody` rather than shared, for the
 * reason `estimateSubBody` duplicates them too: these three bodies must stay identical,
 * and a divergence is easier to see side by side than behind a helper.
 */
const scheduleBody = z
  .object({
    type: z.enum(["cancel", "pause", "resume", "change"]),
    effective_at: z.string().datetime(),
    changes: z
      .array(
        z.object({
          item: z.string().max(LIMITS.id).min(1),
          price: z.string().max(LIMITS.id).min(1).optional(),
          quantity: z.number().int().positive().max(LIMITS.quantity).optional(),
          unit_price_minor: z.number().int().nonnegative().optional(),
        }),
      )
      .optional(),
    adds: z
      .array(
        z.object({
          price: z.string().max(LIMITS.id).min(1),
          quantity: z.number().int().positive().max(LIMITS.quantity).optional(),
          unit_price_minor: z.number().int().nonnegative().optional(),
        }),
      )
      .optional(),
    removes: z.array(z.string().min(1)).optional(), // subscription item ids (si_…)
  })
  .refine(
    (v) =>
      v.type !== "change" ||
      (v.changes?.length ?? 0) + (v.adds?.length ?? 0) + (v.removes?.length ?? 0) > 0,
    {
      message: "change requires at least one of changes[], adds[] or removes[]",
      path: ["changes"],
    },
  );

const changeLine = z
  .object({
    item: z.string().max(LIMITS.id).min(1), // subscription item id (si_…)
    price: z.string().max(LIMITS.id).min(1).optional(), // new price (plan change)
    quantity: z.number().int().positive().max(LIMITS.quantity).optional(),
    unit_price_minor: z.number().int().nonnegative().optional(), // custom price override (flat/per-unit)
  })
  .refine((c) => c.price != null || c.quantity != null || c.unit_price_minor != null, {
    message: "each change needs one or more of these: a new price, a quantity, a unit_price_minor",
  });

/**
 * The three lists of ONE composition edit. `adds` and `removes` mirror
 * `estimateSubBody`'s shapes exactly — the estimate has always had to describe all three
 * at once, and a preview whose request shape differs from the booking's is how a preview
 * comes to quote something the booking cannot do.
 *
 * They are applied in ONE transaction and folded into ONE invoice / credit note. Before
 * 2026-08-24 this route took `changes` only, so the dashboard sent a single operator edit
 * as four requests and got five documents — an invoice billing a full year of lines the
 * next request removed, two credit notes handing them back, a second invoice for the
 * added line, and the unused-term credit. The net was right; it could not be COLLECTED,
 * because the second invoice alone exceeded the customer's per-debit e-mandate ceiling.
 * See `changeSubscription`.
 */
/** Shared by `/change` and `/estimate`: one screen sends one body shape to both. */
const pendingDiscountFields = {
  coupon_code: z.string().max(LIMITS.id).optional(),
  /** `coupon_ids[]` — at most ONE coupon (one discount per subscription); see `singleCouponCode`. */
  coupon_ids: z.array(z.string().max(LIMITS.id).min(1)).optional(),
  manual_discount: z
    .object({
      type: z.enum(["percent", "amount"]),
      value: z.number().positive(),
      duration: z.enum(["one_time", "forever"]).optional(),
    })
    .refine((b) => b.type !== "percent" || (b.value >= 1 && b.value <= 100), {
      message: "value must be between 1 and 100 for a percent discount",
    })
    .optional(),
};

/**
 * Business rules a change may override for itself. Omitted = the business rule.
 * `coupons` and `downgrade_credit` change the money, so `/estimate` takes them too.
 */
const changeRuleFields = {
  coupons: z.enum(["keep", "drop", "keep_if_valid"]).optional(),
  downgrade_credit: z.enum(["credit_balance", "refund"]).optional(),
};
const changeOnlyRuleFields = {
  on_charge_failure: z.enum(["start_dunning", "next_renewal"]).optional(),
  plan_credits: z.enum(["full", "prorated", "next_window"]).optional(),
  allowances: z.enum(["new_window", "keep_used", "prorated"]).optional(),
};

/**
 * `/change` and `/estimate` only (reactivation has no live discount to remove): drop the
 * active discount (coupon or manual) inside the same transaction, before billing. With
 * `coupon_code`/`manual_discount` it swaps the discount in one edit.
 */
const removeDiscountField = { remove_discount: z.boolean().optional() };

/**
 * `coupon_ids[]` folded into the single `coupon_code` the engine takes. More than one is
 * refused rather than truncated: a subscription carries one discount at a time.
 */
function singleCouponCode(d: {
  coupon_code?: string;
  coupon_ids?: string[];
}): { ok: true; code: string | undefined } | { ok: false; message: string } {
  const ids = d.coupon_ids ?? [];
  if (ids.length > 1)
    return {
      ok: false,
      message:
        "coupon_ids takes at most one coupon. A subscription has only one discount at a time.",
    };
  if (ids.length === 1 && d.coupon_code && d.coupon_code !== ids[0])
    return {
      ok: false,
      message: "coupon_code and coupon_ids name different coupons. Send only one of them.",
    };
  return { ok: true, code: ids[0] ?? d.coupon_code };
}

/** `manual_discount` as the engine takes it — percent → bps, amount → minor units. */
const toEngineManualDiscount = (
  m: { type: "percent" | "amount"; value: number; duration?: "one_time" | "forever" } | undefined,
):
  | {
      kind: "percentage" | "fixed_amount";
      percentOffBps?: number;
      amountOffMinor?: number;
      durationType: "once" | "forever";
    }
  | undefined =>
  m
    ? {
        kind: (m.type === "percent" ? "percentage" : "fixed_amount") as
          | "percentage"
          | "fixed_amount",
        ...(m.type === "percent"
          ? { percentOffBps: Math.round(m.value * 100) }
          : { amountOffMinor: Math.round(m.value) }),
        durationType: (m.duration === "one_time" ? "once" : "forever") as "once" | "forever",
      }
    : undefined;

const changeSubBody = z
  .object({
    ...pendingDiscountFields,
    ...removeDiscountField,
    ...changeRuleFields,
    ...changeOnlyRuleFields,
    // `.min(1)` is gone (it was here before adds/removes existed): an adds-only or
    // removes-only edit is a legal call, and the refine below is what keeps an empty body
    // a 400. Same rule, and the same message shape, as `estimateSubBody`.
    changes: z.array(changeLine).default([]),
    adds: z
      .array(
        z.object({
          price: z.string().max(LIMITS.id).min(1),
          quantity: z.number().int().positive().max(LIMITS.quantity).optional(),
          unit_price_minor: z.number().int().nonnegative().optional(),
        }),
      )
      .default([]),
    removes: z.array(z.string().min(1)).default([]),
    at: z.string().datetime().optional(), // backdate the change (proration as of this instant)
    reset_term: z.boolean().optional(), // force a term reset (a cadence change resets regardless)
    /**
     * `prorate`. False suppresses the PRORATED credit and charge; on a term reset the
     * full new-term charge survives and only the unused-time credit is dropped.
     * See `changeSubscription`'s field doc.
     */
    prorate: z.boolean().optional(),
    /**
     * `now` applies the change; `end_of_term` schedules it for the current term end.
     * Omitted = the business rule for the change's direction (`billing_rules_config`
     * `upgrade_timing` / `downgrade_timing`); unset, that is `now`. A timing the rule
     * does not allow is refused.
     */
    timing: z.enum(["now", "end_of_term"]).optional(),
    /**
     * The **Invoicing Options** on the change screen: `true` raises the
     * proration invoice now and collects it; `false` queues the same lines as
     * `unbilled_charges`, folded into the next renewal.
     *
     * OPTIONAL, and still not `.default(false)` — but for a different reason than
     * before. Omitting it now resolves `businesses.default_invoice_immediately`
     * (2026-08-19 ruling), so a zod default here would shadow the business setting and
     * make the API the only surface that ignores it. The resolution lives in
     * `changeSubscription`, which is also where `changeTermEnd` resolves the same
     * column — one rule, one place.
     *
     * The column ships false, so an omitting caller now gets unbilled charges rather
     * than an invoice. Callers that mean "invoice now" regardless of the business
     * preference must say so, and ours do: the dashboard's change page always sends it
     * explicitly, the scheduled-change applier sends `true` (the change page promises a
     * landed change invoices), and hosted checkout sends `true` (the buyer is at a payment
     * page that quoted them a figure).
     */
    invoice_immediately: z.boolean().optional(),
    /**
     * `metadata` — REPLACED wholesale, applied inside this change's own transaction.
     *
     * For an edit where the items and a flag are one decision: a destination switch bills
     * for one thing and serves what this says, so landing them separately means paying for
     * one destination and receiving another. Sending them here makes it both or neither.
     * `null` clears; omitted leaves the subscription's metadata untouched.
     */
    metadata: metadataField().nullable().optional(),
    /**
     * From `POST …/estimate`, for a change applied now (no `at`). `priced_at` (with
     * `quote`) books at the estimate's instant when it is at most 15 minutes old; `quote`
     * refuses (409, `param: "quote"`) when the amounts moved. Neither = priced at the call.
     */
    priced_at: z.string().datetime().optional(),
    quote: z.string().max(64).optional(),
  })
  .refine((b) => b.changes.length + b.adds.length + b.removes.length > 0, {
    message: "a change needs at least one of changes, adds or removes",
  });

/**
 * The ESTIMATE body and `changeSubBody` now describe the SAME request: all three lists,
 * every one defaulting to empty, at least one non-empty. It was wider until 2026-08-24,
 * because `/change` could not carry adds or removes and a preview had to cover the three
 * calls a composition edit was applied as. Kept as its own schema because the two differ
 * in what they may say about INVOICING — an estimate has no `invoice_immediately`, since
 * it books nothing.
 */
const estimateSubBody = z
  .object({
    changes: z.array(changeLine).default([]),
    adds: z
      .array(
        z.object({
          price: z.string().max(LIMITS.id).min(1),
          quantity: z.number().int().positive().max(LIMITS.quantity).optional(),
          unit_price_minor: z.number().int().nonnegative().optional(),
        }),
      )
      .default([]),
    removes: z.array(z.string().min(1)).default([]),
    at: z.string().datetime().optional(),
    reset_term: z.boolean().optional(),
    /**
     * A coupon / manual discount the caller is about to apply but has not yet — the
     * change screen's `Add Coupon` and `Add manual discount`, which the dashboard posts
     * as their OWN calls (`POST …/discount`, `POST …/manual_discount`) after the change,
     * exactly as it posts `adds`/`removes` separately.
     *
     * ⚠ Zod strips unknown keys silently, so omitting these here is not "the estimate
     * ignores them" — it is the request arriving without them and no error anywhere.
     * That is what happened until 2026-08-30: the operator added a coupon, the preview
     * did not move, and the confirm charged a different number.
     *
     * Same shapes as `POST …/manual_discount` takes, so one screen sends one body shape
     * to the preview and the booking.
     */
    ...pendingDiscountFields,
    ...removeDiscountField,
    ...changeRuleFields,
    /**
     * Mirrors `changeSubBody.prorate`, which `estimateChange` has always accepted and
     * honoured (its own `prorate` param, default true) — this zod was the only thing
     * stopping a caller from reaching it. Without it the change screen's now-editable
     * "Apply prorated credits and charges" checkbox previewed a PRORATED figure and
     * then booked an unprorated one: the same preview-vs-apply divergence the cadence
     * guard fix closed on 2026-08-24, reintroduced through the estimate's front door.
     */
    prorate: z.boolean().optional(),
    /**
     * `change_option=specific_date` + `changes_scheduled_at`: preview the edit as
     * `POST …/schedule` would apply it on that date (inside the current term).
     */
    // `end_of_term`: preview the edit as the scheduled change books it at the term end
    // (the trial end in a trial): as of that instant, with the business's proration.
    change_option: z.enum(["immediately", "specific_date", "end_of_term"]).optional(),
    changes_scheduled_at: z.string().datetime().optional(),
  })
  // A DISCOUNT ALONE IS A LEGAL EDIT. Adding a coupon and touching no line is something
  // the change screen offers, and the booking accepts (`POST …/discount` stands on its
  // own), so refusing to preview it would leave the one shape whose whole effect IS the
  // discount unpreviewable.
  .refine(
    (b) =>
      b.changes.length + b.adds.length + b.removes.length > 0 ||
      !!b.coupon_code ||
      (b.coupon_ids?.length ?? 0) > 0 ||
      !!b.manual_discount ||
      b.remove_discount === true,
    {
      message:
        "estimate needs at least one of changes, adds, removes, coupon_code, manual_discount or remove_discount",
    },
  );

/** `plan_credits` on a cancel: overrides the business rule for this cancel only. */
const cancelPlanCredits = z
  .object({ on_cancel_at_period_end: z.enum(PLAN_CREDIT_CANCEL_AT_PERIOD_ENDS).optional() })
  .optional();

/**
 * The CANCEL-ESTIMATE body mirrors `cancelBody` field for field, minus the two that
 * describe intent rather than money (`cancel_reason`, `cancel_reason_code`) — a preview
 * has no reason to record. Every option is optional and the service resolves omissions
 * from the business defaults, exactly as the cancel does, so `POST` with `{}` previews
 * the cancellation you get by pressing Cancel with nothing selected.
 */
const cancelEstimateBody = z.object({
  cancel_option: z
    .enum(["immediately", "end_of_term", "specific_date", "end_of_billing_term"])
    .optional(),
  cancel_at: z.string().datetime().optional(),
  credit_option_for_current_term_charges: z.enum(["none", "prorate", "full"]).optional(),
  unbilled_charges_option: z.enum(["invoice", "delete"]).optional(),
  account_receivables_handling: z
    .enum(["no_action", "schedule_payment_collection", "write_off", "void"])
    .optional(),
  refundable_credits_handling: z.enum(["no_action", "schedule_refund"]).optional(),
  // Same shorthand the cancel route honours, so a caller can preview what it will send.
  at_period_end: z.boolean().optional(),
  include_cancellation_day_in_billing: z.boolean().optional(),
  final_period: z.enum(SPECIFIC_DATE_FINAL_PERIODS).optional(),
  plan_credits: cancelPlanCredits,
});

/**
 * `end_of_billing_term` ends at the close of the billed term. With no advance invoicing a
 * billed term IS the current one, so it is `end_of_term`.
 */
/** Who is changing: the dashboard's own session, or an API key. */
const changeSource = (): ChangeSource =>
  currentEventContext()?.source === "dashboard" ? "dashboard" : "api";

/** The direction of an item edit and the business's policy for it, read in one transaction. */
async function changePolicyFor(
  organizationId: string,
  business: { billingRulesConfig?: unknown; storefrontConfig?: unknown },
  subscription: typeof subscriptions.$inferSelect,
  edit: { changes: ItemChange[]; adds?: ItemAdd[]; removes?: string[] },
) {
  return withTenant(organizationId, async (tx) => {
    const direction = await directionOfItemEdit(tx, subscription, edit);
    const policy = await resolveChangePolicy({
      business,
      subscription,
      direction,
      source: changeSource(),
      tx,
    });
    const planMoves = await planMovesInEdit(tx, subscription.id, edit.changes);
    return { direction, policy, planMoves };
  });
}

/**
 * The change estimate both `/estimate` and `/change` price, so a quote taken from one
 * re-prices identically on the other.
 */
function priceEdit(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  now: Date;
  edit: { changes: ItemChange[]; adds?: ItemAdd[]; removes?: string[] };
  resetTerm?: boolean;
  prorate: boolean;
  couponCode?: string;
  manualDiscount?: { type: "percent" | "amount"; value: number; duration?: "one_time" | "forever" };
  removeDiscount?: boolean;
  coupons?: PlanChangeCoupons;
  downgradeCredit?: "credit_balance" | "refund";
}) {
  const m = toEngineManualDiscount(input.manualDiscount);
  return estimateChange({
    organizationId: input.organizationId,
    businessId: input.businessId,
    subscriptionId: input.subscriptionId,
    now: input.now,
    ...input.edit,
    changes: input.edit.changes,
    resetTerm: input.resetTerm,
    prorate: input.prorate,
    couponCodes: input.couponCode ? [input.couponCode] : undefined,
    removeDiscount: input.removeDiscount === true,
    ...(input.coupons ? { planChangeCoupons: input.coupons } : {}),
    ...(input.downgradeCredit ? { downgradeCredit: input.downgradeCredit } : {}),
    manualDiscount: m
      ? {
          kind: m.kind,
          percentOffBps: m.percentOffBps,
          amountOffMinor: m.amountOffMinor != null ? BigInt(m.amountOffMinor) : undefined,
        }
      : undefined,
  });
}

/** 409 for a quote that moved; `param: "quote"` tells it apart from other conflicts. */
const quoteMovedReply = (reply: FastifyReply) =>
  reply
    .code(409)
    .send({ error: { type: "conflict_error", param: "quote", message: QUOTE_MOVED_MESSAGE } });

const blockedReply = (reply: FastifyReply, b: { code: string; message: string }) =>
  reply.code(409).send({ error: { type: "conflict_error", code: b.code, message: b.message } });

/**
 * For routes that can only apply a change NOW: refuse a gated change (409) or one the
 * timing rule sends to the term end (400). Null = already answered.
 */
async function immediateChangeGuard(
  reply: FastifyReply,
  organizationId: string,
  business: { billingRulesConfig?: unknown; storefrontConfig?: unknown },
  subscription: typeof subscriptions.$inferSelect,
  edit: { changes: ItemChange[]; adds?: ItemAdd[]; removes?: string[] },
) {
  const r = await changePolicyFor(organizationId, business, subscription, edit);
  if (r.policy.blocked) {
    await blockedReply(reply, r.policy.blocked);
    return null;
  }
  if (!r.policy.timings.includes("now")) {
    await badRequest(reply, nowNotAllowedMessage(changeSource(), r.direction));
    return null;
  }
  return r;
}

/** `plan_credits` / `allowances` for this change, or the 400 for one a downgrade cannot take. */
function resetOverridesFor(
  direction: ChangeDirection,
  d: { plan_credits?: PlanCreditUpgrade; allowances?: AllowanceUpgrade },
): { ok: true; overrides?: ResetOverrides } | { ok: false; message: string } {
  if (direction === "downgrade" && d.plan_credits === "prorated")
    return {
      ok: false,
      message:
        "We could not apply the change. A downgrade cannot prorate plan credits. Send plan_credits: full or next_window.",
    };
  if (direction === "downgrade" && d.allowances)
    return {
      ok: false,
      message:
        "We could not apply the change. allowances applies only to an upgrade. Remove allowances.",
    };
  if (!d.plan_credits && !d.allowances) return { ok: true };
  const pc = d.plan_credits;
  return {
    ok: true,
    overrides: {
      ...(pc
        ? { planCredits: { onUpgrade: pc, ...(pc !== "prorated" ? { onDowngrade: pc } : {}) } }
        : {}),
      ...(d.allowances ? { allowances: { onUpgrade: d.allowances } } : {}),
    },
  };
}

/** The 400 for a timing the business rule does not allow for this direction. */
function timingRefusal(direction: ChangeDirection, allowed: ChangeTiming[]): string {
  const what = direction === "downgrade" ? "a downgrade" : "an upgrade";
  return allowed.includes("now")
    ? `We could not schedule the change. This business applies ${what} now. Send timing: now.`
    : `We could not apply the change now. This business applies ${what} at the end of the term. Send timing: end_of_term.`;
}

const resolveCancelOption = (d: {
  at_period_end?: boolean;
  cancel_option?: "immediately" | "end_of_term" | "specific_date" | "end_of_billing_term";
}) =>
  d.at_period_end === true || d.cancel_option === "end_of_billing_term"
    ? ("end_of_term" as const)
    : d.cancel_option;

export async function registerSubscriptionRoutes(app: FastifyInstance) {
  app.post(
    "/v1/businesses/:biz/customers/:cus/subscriptions",
    {
      preHandler: [authenticate, requirePerm("subscriptions:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!customer) {
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the customer ${cusId}.`,
          },
        });
      }
      const parsed = parseRequest(createSubBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      /** A declined first charge creates the subscription and hands the invoice to dunning. */
      const dunOnFailure = parsed.data.on_charge_failure === "dun";
      // A buyer-present charge is taken before the subscription exists; `dun` has no place there.
      if (dunOnFailure && (parsed.data.payment_intent || parsed.data.on_session === true)) {
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            code: "on_charge_failure_conflict",
            param: "on_charge_failure",
            message:
              "We could not create the subscription. With on_session or payment_intent, the buyer pays before the subscription exists, so on_charge_failure must be refuse. Send on_charge_failure=refuse, or remove on_session and payment_intent.",
          },
        });
      }
      let pinnedPmId: string | undefined;
      if (parsed.data.payment_method) {
        const pm = await pinnablePaymentMethod(
          req.organization!.id,
          customer.id,
          parsed.data.payment_method,
        );
        if ("error" in pm) return badRequest(reply, pm.error);
        pinnedPmId = pm.id;
      }

      const resolved: SubscriptionItemInput[] = [];
      for (const it of parsed.data.items) {
        const price = await getPriceByPublicId(req.organization!.id, business.id, it.price);
        if (!price) {
          return reply.code(404).send({
            error: {
              type: "invalid_request_error",
              message: `We could not find the price ${it.price}.`,
            },
          });
        }
        resolved.push({
          price,
          quantity: it.quantity,
          customAmountMinor: it.unit_price_minor,
          freeQuantity: it.free_quantity,
          billingCycles: it.billing_cycles,
          metadata: it.metadata,
        });
      }

      // Events the auto-collect-ON path withholds until its first charge lands
      // (see below). Empty — and therefore inert — on every other path.
      const deferred: DeferredEvents = [];
      let deferredEmitted = false;

      try {
        // API-boundary simulated time (finale review): a time-travelled test
        // business anchors API-created subscriptions at its SIMULATED instant;
        // real businesses get wall-clock (one indexed lookup).
        const apiNow = await businessWallClock(business.id);

        // Creating with auto-collection ON and an IMMEDIATE
        // first charge requires a usable card up front — no card / a card that
        // fails gateway verification refuses the creation outright (nothing is
        // created). Trials and future-dated starts don't charge now, so they
        // are exempt (card can be added before the first real charge). A trial
        // may come from an explicit trial_days OR the plan price's configured
        // trial_period (auto-applied by createSubscription), so exempt both.
        const startsNow = !parsed.data.start_date || new Date(parsed.data.start_date) <= apiNow;
        const planTrialPeriod =
          resolved.find((r) => r.price.type === "recurring")?.price?.trialPeriod ?? 0;
        // Mirror createSubscription's trial resolution: explicit 0 = no trial;
        // >0 = trial; omitted = plan's configured trial_period.
        const hasTrial = parsed.data.trial_end
          ? true
          : parsed.data.trial_days === undefined
            ? planTrialPeriod > 0
            : parsed.data.trial_days > 0;
        // `invoice_immediately: false` defers the first period to an unbilled charge,
        // so there is no invoice at signup and therefore nothing to collect — it must
        // exempt the card requirement exactly like a trial does, or a card-less signup
        // that charges nothing would still be refused.
        // 0242: omitted now resolves `unbilled_charges_config.on_create`, whose default
        // is invoice_immediately — the same answer `!== false` gave. An explicit false
        // still wins, so a caller deferring the first period is unaffected.
        const invoiceFirstPeriodNow =
          parsed.data.invoice_immediately ??
          resolveUnbilledChargesConfig(business).onCreate === "invoice_immediately";
        // 0242 — BACKDATING WINDOW. Enforced here, after `hasTrial` and
        // `invoiceFirstPeriodNow` are known, because whether a past-dated signup also
        // raises a past-dated INVOICE is a separate consent on the config. Defaults are
        // fully permissive, so an unconfigured business is refused nothing.
        if (parsed.data.start_date) {
          const verdict = isBackdateAllowed({
            config: resolveBackdatingConfig(business),
            action: "create",
            target: new Date(parsed.data.start_date),
            now: apiNow,
            businessTimezone: business.timezone,
            raisesPastDatedInvoice: invoiceFirstPeriodNow && !hasTrial,
          });
          if (!verdict.allowed) return badRequest(reply, verdict.message);
        }
        const chargesNow =
          isAutoCollectOn(parsed.data.auto_collection ?? null, customer.autoCollection) &&
          !hasTrial &&
          startsNow &&
          invoiceFirstPeriodNow;
        if (chargesNow) {
          await assertChargeableForAutoCollect({
            organizationId: req.organization!.id,
            businessId: business.id,
            customer,
          });
        }
        // A `payment_intent` on a signup that collects nothing now (trial,
        // future-dated start, auto-collection off, `invoice_immediately: false`) has
        // nowhere to be consumed. Refuse rather than silently ignore an
        // authorization the buyer already gave — it would be left to expire.
        if (parsed.data.payment_intent && !chargesNow) {
          return reply.code(400).send({
            error: {
              type: "invalid_request_error",
              code: "payment_intent_not_collectible",
              message:
                "You supplied payment_intent, but this signup does not collect a first payment now",
            },
          });
        }

        // With auto-collection ON the subscription is only PROVISIONAL until the
        // first charge clears — the signup is refused leaving nothing behind. So its
        // lifecycle events are buffered rather than emitted:
        // a webhook the outbox already delivered cannot be unsent, and rows deleted
        // afterwards would still have told the integration to provision access.
        const { subscription, items } = await createSubscription({
          organizationId: req.organization!.id,
          businessId: business.id,
          customerId: customer.id,
          now: apiNow,
          publicId: parsed.data.id,
          items: resolved,
          trialDays: parsed.data.trial_days,
          ...(parsed.data.trial_end ? { trialEnd: new Date(parsed.data.trial_end) } : {}),
          startDate: parsed.data.start_date ? new Date(parsed.data.start_date) : undefined,
          billingAnchor: parsed.data.billing_anchor
            ? new Date(parsed.data.billing_anchor)
            : undefined,
          autoCollection: parsed.data.auto_collection,
          createPendingInvoices: parsed.data.create_pending_invoices,
          billUsageMonthly: parsed.data.bill_usage_monthly,
          ...(parsed.data.commitment_amount_minor !== undefined
            ? { commitmentAmountMinor: bigintOrNull(parsed.data.commitment_amount_minor) }
            : {}),
          netTermDays: parsed.data.net_term_days,
          maxRefundableCreditsUsageMinor: bigintOrNull(
            parsed.data.max_refundable_credits_usage_minor,
          ),
          maxExcessPaymentUsageMinor: bigintOrNull(parsed.data.max_excess_payment_usage_minor),
          poNumber: parsed.data.po_number,
          shippingAddressPublicId: parsed.data.shipping_address_id,
          invoiceNotes: parsed.data.invoice_notes,
          ...(pinnedPmId ? { defaultPaymentMethodId: pinnedPmId } : {}),
          metadata: parsed.data.metadata,
          customFields: collectCustomFields(req.body, parsed.data.custom_fields),
          deferEventsTo: chargesNow ? deferred : undefined,
        });
        /** Undo a provisional (never-billed, never-announced) subscription. */
        const discardProvisional = async () =>
          deleteProvisionalSubscription({
            organizationId: req.organization!.id,
            businessId: business.id,
            subscriptionId: subscription.id,
          });
        // Coupons applied AT SIGNUP discount the FIRST invoice.
        // Applied after the subscription exists and BEFORE the first invoice is
        // planned, so peekDiscounts picks them up for it.
        for (const code of parsed.data.coupon_ids ?? []) {
          try {
            await applyCouponToSubscription({
              organizationId: req.organization!.id,
              businessId: business.id,
              subscriptionId: subscription.id,
              code,
              now: apiNow,
              atSignup: true,
              deferEventsTo: chargesNow ? deferred : undefined,
            });
          } catch (e) {
            if (e instanceof CouponError) {
              // A provisional subscription has announced nothing yet — a bad coupon
              // refuses the whole signup rather than leaving a silent orphan.
              if (chargesNow) {
                // Delete FIRST, clear the buffer only once it succeeded. If the
                // delete throws, the subscription survives — and it must still get
                // its events from the outer catch, or it would exist with no webhook
                // ever announcing it. Clearing first would strand it silently.
                await discardProvisional();
                deferred.length = 0;
              }
              return reply
                .code(400)
                .send({ error: { type: "invalid_request_error", message: e.message } });
            }
            throw e;
          }
        }
        // A signup manual discount, applied in the SAME place and for the same reason as
        // the coupons above: before the first invoice is planned, so `peekDiscounts`
        // picks it up for that invoice (see `discount` on createSubBody). It used to
        // be a SECOND HTTP call the dashboard
        // made after this one returned, by which point the first invoice was already
        // raised and collected, so the discount silently slipped to the next renewal.
        if (parsed.data.discount) {
          const d = parsed.data.discount;
          try {
            await applyManualDiscount({
              organizationId: req.organization!.id,
              businessId: business.id,
              subscriptionId: subscription.id,
              kind: d.type === "percent" ? "percentage" : "fixed_amount",
              percentOffBps: d.type === "percent" ? Math.round(d.value * 100) : undefined,
              amountOffMinor: d.type === "amount" ? Math.round(d.value) : undefined,
              currency: subscription.currency,
              durationType: d.duration === "one_time" ? "once" : "forever",
              note: d.note,
              now: apiNow,
            });
          } catch (e) {
            // Same refusal semantics as a bad coupon: a provisional subscription has
            // announced nothing, so refuse the whole signup rather than leave one
            // created without the discount the operator asked for.
            if (e instanceof CouponError) {
              if (chargesNow) {
                await discardProvisional();
                deferred.length = 0;
              }
              return reply
                .code(400)
                .send({ error: { type: "invalid_request_error", message: e.message } });
            }
            throw e;
          }
        }
        // Report what was PERSISTED, not what was requested. Two reasons the old
        // index-into-`resolved` form was wrong: the engine appends the plan's
        // mandatory add-ons, so `items` is longer than `resolved` and the tail
        // indexed past the end; and the engine resolves plan-scoped differentials
        // (a catalog-0 add-on priced per plan), which the request never carried —
        // so a create response claimed a 0 unit price for an item billing 475.00.
        const itemView = items.map((si) => {
          const snap = si.priceSnapshot as PriceSnapshot | null;
          const req = resolved.find((r) => r.price.id === si.priceId);
          return {
            id: si.publicId,
            price: snap?.publicId ?? req?.price.publicId ?? "",
            quantity: si.quantity,
            unit_price_minor:
              snap?.amountMinor ??
              (req?.price.amountMinor != null ? Number(req.price.amountMinor) : null),
            unit_price_overridden: snap?.amountOverridden === true,
          };
        });

        // Bill in advance: an active subscription is charged for its first period
        // immediately. Trials are billed at trial end (renewal via billing clock).
        let invoiceView: { id: string; status: string; total_minor: number } | undefined;
        /** Set instead of `invoiceView` when `invoice_immediately: false` defers the period. */
        let unbilledView: { id: string; amount_minor: number } | undefined;
        /** Set when the first invoice was settled by consuming `payment_intent`. */
        let paymentIntentView: ReturnType<typeof serializePaymentIntent> | undefined;
        /** Set when that consume reached the gateway and the capture was refused. */
        let paymentIntentError: { code: string; message: string } | undefined;
        /** `on_charge_failure: dun` and the first collection failed. */
        let chargeError: { code: string; message: string } | undefined;
        if (subscription.status === "active") {
          // `active` implies a TERM. Only a trialling subscription has none (2026-08-25),
          // and the status guard above already excludes it — but state the invariant rather
          // than assert it away with `!`, so a future path that reaches here without a term
          // fails loudly at the boundary instead of on a null date deep inside invoice
          // planning.
          const termStart = subscription.currentPeriodStart;
          const termEnd = subscription.currentPeriodEnd;
          if (!termStart || !termEnd) {
            throw new Error(`subscription ${subscription.publicId} is active with no billing term`);
          }
          const billInput = {
            organizationId: req.organization!.id,
            businessId: business.id,
            subscription,
            periodStart: termStart,
            periodEnd: termEnd,
          };
          let invoice: Awaited<ReturnType<typeof billSubscriptionPeriod>>["invoice"] | undefined;
          if (!invoiceFirstPeriodNow) {
            // `invoice_immediately: false` — queue the first period as a pending
            // unbilled charge rather than invoicing it, so it rides on the next
            // invoice this subscription raises. No invoice, no collection, no card
            // requirement (`chargesNow` is already false on this path).
            const deferredCharge = await deferFirstPeriodToUnbilledCharges({
              organizationId: req.organization!.id,
              businessId: business.id,
              subscription,
              now: apiNow,
            });
            if (deferredCharge.chargeId) {
              unbilledView = {
                id: deferredCharge.chargeId,
                amount_minor: Number(deferredCharge.amountMinor),
              };
            }
          } else if (chargesNow) {
            // CHARGE FIRST. Plan the invoice read-only, take
            // the money, and only then persist anything: a decline leaves NO
            // subscription, NO invoice and NO events — instead of the cancelled sub
            // + voided invoice + six webhooks that
            // compensating after the fact produced.
            const plan = await planSubscriptionPeriodInvoice(billInput);
            const plannedDue = plan.mode === "finalize" ? plan.money.amountDue : 0n;
            let charge: CompletedCharge | undefined;

            // ── Settle by CONSUMING an already-authorized intent ────────────────
            // The charge-first order is inverted here, and it has to be: an intent is
            // consumed INTO an invoice (that is what carries the amount check, the
            // atomic claim and the booking), so the invoice must exist first. It is
            // committed with `collect: false` so nothing charges it behind our back.
            if (parsed.data.payment_intent && plannedDue > 0n) {
              const piId = parsed.data.payment_intent;
              let intent = await getPaymentIntent(req.organization!.id, business.id, piId);
              // Everything checkable BEFORE anything is written, so a mismatched
              // intent refuses the signup with nothing left behind — exactly like a
              // declined first charge does.
              const reject = async (
                code: string,
                message: string,
                status: 400 | 402 | 404 = 400,
              ) => {
                await discardProvisional();
                deferred.length = 0;
                return reply
                  .code(status)
                  .send({ error: { type: "invalid_request_error", code, message } });
              };
              if (!intent)
                return reject(
                  "payment_intent_not_found",
                  `We could not find the payment intent ${piId}.`,
                  404,
                );
              if (intent.customerId !== customer.id)
                return reject(
                  "payment_intent_customer_mismatch",
                  `Payment intent ${piId} belongs to a different customer`,
                );
              if ((intent.purpose ?? "payment") !== "payment")
                return reject(
                  "payment_intent_wrong_purpose",
                  `Payment intent ${piId} is a ${intent.purpose} intent. It cannot pay an invoice.`,
                );
              if (intent.currency !== subscription.currency)
                return reject(
                  "payment_intent_currency_mismatch",
                  `Payment intent ${piId} is in ${intent.currency}, but the subscription bills in ${subscription.currency}`,
                );
              if (intent.amountMinor !== plannedDue)
                return reject(
                  "payment_intent_amount_mismatch",
                  `Payment intent ${piId} authorized ${intent.amountMinor} but the first invoice is ${plannedDue}`,
                );
              // The browser SDK's result is the authorization itself on a nonce gateway,
              // so it is handed over before the `authorized` check below.
              if (parsed.data.client_result) {
                let applied;
                try {
                  applied = await applyClientResult(
                    req.organization!.id,
                    business.id,
                    piId,
                    parsed.data.client_result,
                  );
                } catch (e) {
                  if (e instanceof PaymentIntentError)
                    return reject(e.code ?? "client_result_refused", e.message);
                  throw e;
                }
                if (applied?.outcome === "failed") {
                  // The same answer as a declined first charge.
                  await discardProvisional();
                  deferred.length = 0;
                  return reply.code(402).send({
                    error: {
                      type: "payment_error",
                      code: applied.failure!.code,
                      message: `We did not create the subscription. The first payment failed: ${applied.failure!.message}`,
                    },
                  });
                }
                intent =
                  (await getPaymentIntent(req.organization!.id, business.id, piId)) ?? intent;
              }
              if (intent.status !== "authorized")
                return reject(
                  "payment_intent_not_authorized",
                  `Payment intent ${piId} is ${intent.status}. The buyer must complete it first.`,
                );

              const committed = await commitSubscriptionPeriodInvoice(plan, {
                preEvents: deferred,
                collect: false,
              });
              deferredEmitted = true;
              invoice = committed.invoice;
              try {
                const consumed = await consumePaymentIntent(
                  req.organization!.id,
                  business.id,
                  piId,
                  invoice.publicId,
                );
                if (captureRefused(consumed?.charge)) {
                  // The capture was refused AFTER the buyer authorized it. The
                  // subscription and its invoice legitimately exist (they were
                  // committed), so this is not a "leave nothing behind" case —
                  // the invoice is simply still open. Report it as created, with the
                  // capture failure attached.
                  paymentIntentError = {
                    code: consumed.charge.failure?.code ?? "capture_failed",
                    message:
                      consumed.charge.failure?.message ?? "We could not capture the payment.",
                  };
                  // Committed uncollected, so nothing else would ever retry it.
                  await handUncollectedInvoiceToDunning({
                    organizationId: req.organization!.id,
                    businessId: business.id,
                    customerId: subscription.customerId,
                    subscriptionId: subscription.id,
                    invoiceId: invoice.id,
                    paymentMethodId: subscription.defaultPaymentMethodId,
                    now: apiNow,
                  });
                }
                if (consumed) paymentIntentView = serializePaymentIntent(consumed.intent);
                // Re-read: the consume is what settled the invoice, so the row we
                // committed a moment ago still says `payment_due`. Reporting that as
                // `latest_invoice.status` would call a paid signup unpaid.
                const settled = await getInvoiceWithLines(
                  req.organization!.id,
                  business.id,
                  invoice.publicId,
                );
                if (settled) invoice = settled.invoice;
              } catch (e) {
                if (e instanceof PaymentIntentConflictError) {
                  return reply.code(409).send({
                    error: {
                      type: "conflict_error",
                      code: "payment_intent_conflict",
                      message: e.message,
                    },
                  });
                }
                if (e instanceof PaymentIntentError) {
                  return reply.code(400).send({
                    error: {
                      type: "invalid_request_error",
                      code: "payment_intent_unusable",
                      message: e.message,
                    },
                  });
                }
                throw e;
              }
            } else if (plannedDue > 0n && !dunOnFailure) {
              // `dun` skips this: the commit below collects as a renewal does, so a
              // decline leaves an open invoice that dunning owns.
              const outcome = await chargeBeforeSubscriptionInvoice({
                organizationId: req.organization!.id,
                businessId: business.id,
                customerId: customer.id,
                subscription,
                amountMinor: plannedDue,
                currency: subscription.currency,
                // On-session ONLY when the caller says the buyer is present.
                ...(parsed.data.on_session ? { session: "on_session" as const } : {}),
              });
              if (outcome.kind === "action_required") {
                // Not a decline: the buyer has a challenge to complete. Nothing was
                // recorded and the provisional subscription is discarded exactly as
                // for a decline — the buyer completes `next_action` and re-sends this
                // request with `payment_intent`, which consumes the intent above.
                await discardProvisional();
                deferred.length = 0;
                const view = serializePaymentIntent(outcome.intent);
                return reply.code(402).send({
                  error: {
                    type: "payment_error",
                    code: "requires_action",
                    message:
                      "We did not create the subscription yet. The buyer must authenticate this payment. Then retry with payment_intent.",
                  },
                  payment_intent: view,
                  next_action: view.next_action,
                });
              }
              if (outcome.kind === "declined") {
                // Delete FIRST, clear the buffer only once it succeeded. If the
                // delete throws, the subscription survives — and it must still get
                // its events from the outer catch, or it would exist with no webhook
                // ever announcing it. Clearing first would strand it silently.
                await discardProvisional();
                deferred.length = 0;
                return reply.code(402).send({
                  error: {
                    type: "payment_error",
                    code: outcome.failureCode,
                    message: `We did not create the subscription. The first payment failed: ${outcome.failureMessage}`,
                  },
                });
              }
              // A pending/unknown gateway outcome is NOT a refusal: the money may
              // well have moved, so the signup stands and the reconciler settles it.
              // `deferred` (a notice rail): the commit below collects through the notice gate.
              if (outcome.kind === "charged") charge = outcome.charge;
            }
            // The intent path above already committed (it had to, to have an invoice
            // to consume into) — `invoice` set is the marker that it did.
            try {
              if (!invoice) {
                const committed = await commitSubscriptionPeriodInvoice(plan, {
                  preEvents: deferred,
                  charge,
                });
                deferredEmitted = true;
                invoice = committed.invoice;
                // Created with the invoice still open (`dun`): say why, for the operator.
                if (committed.payment?.status === "failed")
                  chargeError = {
                    code: committed.payment.failureCode ?? "charge_failed",
                    message: committed.payment.failureMessage ?? "the card was declined",
                  };
              }
            } catch (e) {
              if (e instanceof ChargeAmountMismatchError && charge) {
                // The customer's credit balance moved between planning and
                // committing, so the invoice would bill an amount we did not
                // charge. Nothing was written or emitted (the commit tx rolled
                // back) — put the money straight back and refuse loudly.
                const refund = await refundPreInvoiceCharge({
                  organizationId: req.organization!.id,
                  businessId: business.id,
                  charge,
                  currency: subscription.currency,
                  reason: "invoice_amount_mismatch",
                });
                // Delete FIRST, clear the buffer only once it succeeded. If the
                // delete throws, the subscription survives — and it must still get
                // its events from the outer catch, or it would exist with no webhook
                // ever announcing it. Clearing first would strand it silently.
                await discardProvisional();
                deferred.length = 0;
                if (!refund.refunded) {
                  log.error(
                    "refund FAILED for a pre-invoice charge — manual intervention required",
                    {
                      event: "preinvoice_refund_failed",
                      providerChargeId: charge.result.providerChargeId,
                      amountMinor: charge.amountMinor,
                      currency: subscription.currency,
                      error: refund.error ?? "unknown",
                    },
                  );
                }
                return reply.code(409).send({
                  error: {
                    type: "payment_error",
                    code: "charge_amount_mismatch",
                    message:
                      `We did not create the subscription. The amount due changed while we took the first payment. ` +
                      (refund.refunded
                        ? "We refunded the charge. "
                        : "We could NOT refund the charge automatically. Contact support. ") +
                      "Retry the request.",
                  },
                });
              }
              throw e;
            }
          } else {
            // Auto-collection OFF / nothing to charge now: unchanged path.
            invoice = (await billSubscriptionPeriod(billInput)).invoice;
          }
          if (invoice) {
            invoiceView = {
              id: invoice.publicId,
              status: invoice.status,
              total_minor: Number(invoice.totalMinor),
            };
          }
          // TL-4/CAT-4: a created-active subscription is activating now — fire its
          // charge_on_event='activation' attached items once.
          const { fireActivationCharges } = await import("@/modules/subscriptions/items");
          await fireActivationCharges({
            organizationId: req.organization!.id,
            businessId: business.id,
            subscriptionId: subscription.id,
            now: apiNow,
          });
        }

        // Any path that deferred but never reached the invoice commit (a trial or
        // future-dated sub that `chargesNow` predicted would charge, a zero-amount
        // first invoice on a draft plan) still owes its events.
        if (!deferredEmitted && deferred.length > 0) {
          await flushDeferredEvents(req.organization!.id, deferred);
          deferredEmitted = true;
        }

        // Same shape as GET (customer, full item view incl. auto-attached items, dues), so a
        // caller can store the create response as the subscription; top-level values still
        // come from the row this request wrote.
        const detail = await getSubscriptionDetail(
          req.organization!.id,
          business.id,
          subscription.publicId,
        );
        const view = detail
          ? serializeSubscription(subscription, business, {
              items: detail.items,
              customer: detail.customerPublicId,
              default_payment_method: detail.defaultPaymentMethodPublicId,
              ship_to: detail,
              discount: detail.discount,
              dues: await subscriptionDues(req.organization!.id, subscription.id),
              recurring_amount_minor: await recurringAmountForSubscription(
                req.organization!.id,
                subscription,
              ),
            })
          : serializeSubscription(subscription, business, { items: itemView });
        // `deferred_charge` is the honest counterpart of `latest_invoice`: with
        // `invoice_immediately: false` there IS no invoice, and a caller that only
        // ever saw `latest_invoice` would have no way to tell that money is owed.
        return reply.code(201).send({
          ...view,
          ...(invoiceView ? { latest_invoice: invoiceView } : {}),
          ...(unbilledView ? { deferred_charge: unbilledView } : {}),
          // The intent that paid (or tried to pay) the first invoice. `latest_invoice.status`
          // stays the truth about whether the money landed — `payment_error` says why not.
          ...(paymentIntentView ? { payment_intent: paymentIntentView } : {}),
          ...(paymentIntentError || chargeError
            ? { payment_error: paymentIntentError ?? chargeError }
            : {}),
        });
      } catch (e) {
        // An unexpected failure after the subscription was written leaves it in
        // place (as it always did) — so its events must still be emitted, or the
        // row would exist with no webhook ever announcing it.
        if (!deferredEmitted && deferred.length > 0) {
          deferredEmitted = true;
          try {
            await flushDeferredEvents(req.organization!.id, deferred);
          } catch (flushErr) {
            log.error(flushErr, { event: "deferred_subscription_events_flush_failed" });
          }
        }
        if (
          e instanceof SubscriptionError ||
          e instanceof CustomFieldError ||
          e instanceof ShippingAddressError
        ) {
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        }
        if (e instanceof NoChargeablePaymentMethodError) {
          return reply.code(400).send({
            error: {
              type: "payment_error",
              code: "no_chargeable_payment_method",
              message: e.message,
            },
          });
        }
        throw e;
      }
    },
  );

  /**
   * List subscriptions — paginated, filtered and sorted server-side (§3.4 of
   * docs/GUIDE.md). The filterable fields are `SUBSCRIPTION_FILTER_OPS` and the
   * sortable ones `SUBSCRIPTION_SORT_FIELDS` (both in `subscriptions/service.ts`) —
   * enumerating them here as well is how the two drifted, and a 400 already names the
   * whole set. Every filter compares the value the response PRINTS for that field, so
   * `status[is]=non_renewing` and a `current_period_end` day match the row on screen;
   * `plan` and `addon` are virtual (EXISTS over the subscription's items).
   *
   * `?customer=cus_a` scopes to one customer; `?customer=cus_a,cus_b` to a set —
   * that's how a paginated customers list hydrates its Subscription Info column
   * for the rows on screen instead of reading every subscription.
   *
   * The business's own custom fields filter as `?cf_<api_name>[<op>]=` (e.g.
   * `?cf_plan_tier[is]=gold`), merged over the static maps per request because they are
   * admin-defined at runtime.
   */
  /**
   * Exact counts for several filter sets in one request — a breakdown screen asks a dozen
   * "how many" questions, and each used to be a full list read queued behind the others.
   * Same fields, operators and semantics as the list's `<field>[<op>]` filters, so a count
   * and the list its drill-down opens agree. A read: no `Idempotency-Key`.
   */
  app.post(
    "/v1/businesses/:biz/subscriptions/count",
    { preHandler: [authenticate, requirePerm("subscriptions:count")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const body = parseRequest(
        z.object({
          queries: z
            .array(
              z.object({
                key: z.string().min(1).max(64),
                filters: z
                  .array(
                    z.object({
                      field: z.string().max(64),
                      op: z.string().max(32),
                      value: z.string().max(500),
                    }),
                  )
                  .max(20),
              }),
            )
            .min(1)
            .max(48),
        }),
        req.body,
      );
      if (!body.success) return badRequest(reply, body.error);
      const customFieldDefs = await filterDefinitions(
        req.organization!.id,
        business.id,
        "subscription",
      );
      const cf = subscriptionCustomFieldFilterSet(customFieldDefs);
      const allow = {
        filterOps: { ...SUBSCRIPTION_FILTER_OPS, ...cf.ops },
        filterKinds: { ...SUBSCRIPTION_FILTER_KINDS, ...cf.kinds },
      };
      for (const q of body.data.queries) {
        for (const f of q.filters) {
          const problem = listFilterError(f, allow);
          if (problem) return badRequest(reply, `${q.key}: ${problem}`);
        }
      }
      const counts = await countSubscriptions(
        req.organization!.id,
        business.id,
        body.data.queries,
        customFieldDefs,
      );
      return { object: "subscription_counts", counts };
    },
  );

  app.get(
    "/v1/businesses/:biz/subscriptions",
    { preHandler: [authenticate, requirePerm("subscriptions:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      // ONE definitions read per request: the ops/kinds are needed HERE, before parsing
      // can accept a `cf_*` filter, and the SQL specs inside the list query — so the rows
      // travel down to the service instead of being read there a second time, which could
      // disagree if a definition were created between the two reads.
      const customFieldDefs = await filterDefinitions(
        req.organization!.id,
        business.id,
        "subscription",
      );
      const cf = subscriptionCustomFieldFilterSet(customFieldDefs);
      const q = parseListQuery(req, reply, {
        includeDeleted: "honoured",
        // Merged over the static maps, never replacing them: those are also what saved
        // views validate against (modules/list-views/entities.ts).
        filterOps: { ...SUBSCRIPTION_FILTER_OPS, ...cf.ops },
        // The VALUE's shape too, so `mrr[between]=1000` or a dd/mm/yyyy date answers 400
        // naming the shape rather than reaching the Postgres cast as a 500.
        filterKinds: { ...SUBSCRIPTION_FILTER_KINDS, ...cf.kinds },
        sortFields: SUBSCRIPTION_SORT_FIELDS,
        // `?customer=` is a real, actively-used bare param — the dashboard sends it from the
        // customer detail page, the customers list's Subscription Info hydration and /api/search
        // (comma-separated). It must be declared here or the shared allow-list 400s all three.
        bareParams: ["customer"],
      });
      if (!q) return;

      const wanted = ((req.query as { customer?: string }).customer ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      let customerId: string | undefined;
      let customerIds: string[] | undefined;
      if (wanted.length > 0) {
        const found = await Promise.all(
          wanted.map((pid) => getCustomerByPublicId(req.organization!.id, business.id, pid)),
        );
        const ids = found.filter((c) => c != null).map((c) => c!.id);
        // No such customer → an empty page, not the whole business.
        if (ids.length === 0)
          return { object: "list", data: [], has_more: false, next_cursor: null, total: 0 };
        if (wanted.length === 1) customerId = ids[0];
        else customerIds = ids;
      }

      const page = await listSubscriptionsPage(req.organization!.id, business.id, {
        ...q,
        customerId,
        customerIds,
        customFieldDefs,
      });
      const skipViews = await renewalSkipViews(
        req.organization!.id,
        page.data.map((r) => r.subscription),
      );
      return listResponse(page, (r) => ({
        ...serializeSubscription(r.subscription, business, {
          customer: r.customerPublicId,
          recurring_amount_minor: r.recurringAmountMinor ?? null,
          renewalSkips: skipViews.get(r.subscription.id),
        }),
        customer_email: r.customerEmail,
        customer_name: r.customerName,
        customer_company: r.customerCompany,
        customer_phone: r.customerPhone,
        items: r.items,
        // Only reachable with `include_deleted=true`; every other row is unchanged.
        ...(r.subscription.deletedAt ? { deleted: true } : {}),
      }));
    },
  );

  // Retrieve one subscription with its items, customer, and active discount.
  /**
   * One-time charge lines billed on this subscription, newest invoices first — in two
   * queries. The detail screen fetched every invoice in full to read these, one request
   * per invoice. Bounded at the newest 100 invoices; `has_more` says when that cut.
   */
  app.get(
    "/v1/businesses/:biz/subscriptions/:sub/one_time_charges",
    { preHandler: [authenticate, requirePerm("subscriptions:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const LIMIT = 100;
      const result = await withTenant(req.organization!.id, async (tx) => {
        const [sub] = await tx
          .select({ id: subscriptions.id })
          .from(subscriptions)
          .where(and(eq(subscriptions.businessId, business.id), eq(subscriptions.publicId, subId)))
          .limit(1);
        if (!sub) return null;
        const recent = await tx
          .select({
            id: invoices.id,
            publicId: invoices.publicId,
            number: invoices.number,
            status: invoices.status,
            createdAt: invoices.createdAt,
          })
          .from(invoices)
          .where(and(eq(invoices.businessId, business.id), eq(invoices.subscriptionId, sub.id)))
          .orderBy(desc(invoices.createdAt), desc(invoices.publicId))
          .limit(LIMIT + 1);
        const hasMore = recent.length > LIMIT;
        // `pending` is not finalized and `voided` was cancelled — neither was ever charged.
        const billed = recent
          .slice(0, LIMIT)
          .filter((i) => i.status !== "pending" && i.status !== "voided");
        if (billed.length === 0) return { hasMore, rows: [] };
        const byId = new Map(billed.map((i) => [i.id, i]));
        const lines = await tx
          .select({
            invoiceId: invoiceLineItems.invoiceId,
            publicId: invoiceLineItems.publicId,
            description: invoiceLineItems.description,
            amountMinor: invoiceLineItems.amountMinor,
          })
          .from(invoiceLineItems)
          .where(
            and(
              inArray(invoiceLineItems.invoiceId, [...byId.keys()]),
              eq(invoiceLineItems.kind, "one_time"),
            ),
          )
          .orderBy(invoiceLineItems.createdAt, invoiceLineItems.publicId);
        const order = new Map(billed.map((i, n) => [i.id, n]));
        lines.sort((a, b) => order.get(a.invoiceId)! - order.get(b.invoiceId)!);
        return {
          hasMore,
          rows: lines.map((l) => {
            const inv = byId.get(l.invoiceId)!;
            return {
              id: l.publicId,
              description: l.description,
              amount_minor: Number(l.amountMinor),
              invoice: inv.publicId,
              invoice_number: inv.number ?? null,
              invoice_status: inv.status,
              invoice_created_at: inv.createdAt.toISOString(),
            };
          }),
        };
      });
      if (!result) {
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      }
      return { object: "list", data: result.rows, has_more: result.hasMore };
    },
  );

  app.get(
    "/v1/businesses/:biz/subscriptions/:sub",
    { preHandler: [authenticate, requirePerm("subscriptions:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const detail = await getSubscriptionDetail(req.organization!.id, business.id, subId);
      if (!detail) {
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      }
      const [dues, recurring, revenue, skips] = await Promise.all([
        subscriptionDues(req.organization!.id, detail.subscription.id),
        recurringAmountForSubscription(req.organization!.id, detail.subscription),
        collectedRevenue(req.organization!.id, { subscriptionId: detail.subscription.id }),
        skipViewOf(req.organization!.id, detail.subscription),
      ]);
      // One currency per subscription, so at most one row; none = nothing collected yet.
      const collected = revenue.find((r) => r.currency === detail.subscription.currency);
      return serializeSubscription(detail.subscription, business, {
        items: detail.items,
        customer: detail.customerPublicId,
        default_payment_method: detail.defaultPaymentMethodPublicId,
        ship_to: detail,
        discount: detail.discount,
        dues,
        recurring_amount_minor: recurring,
        revenue: collected ?? { amount_minor: 0, paid_invoices_count: 0, first_paid_at: null },
        renewalSkips: skips,
      });
    },
  );

  // Update collection/commercial settings (CP-1 inline auto-collection change).
  app.patch(
    "/v1/businesses/:biz/subscriptions/:sub",
    {
      preHandler: [authenticate, requirePerm("subscriptions:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const body = parseRequest(
        z
          .object({
            auto_collection: z.enum(["on", "off"]).nullable().optional(),
            po_number: z.string().max(100).nullable().optional(),
            /** An `addr_…` id from the customer's address book; `null` = ship to the default. */
            shipping_address_id: z.string().min(1).max(64).nullable().optional(),
            invoice_notes: z.string().max(2000).nullable().optional(),
            /** Credits Flexibility (0219) — see the create body. `null` clears the cap. */
            max_refundable_credits_usage_minor: z.number().int().min(0).nullable().optional(),
            max_excess_payment_usage_minor: z.number().int().min(0).nullable().optional(),
            /**
             * Cycles remaining AFTER the current one. `null` clears the cap (renews
             * forever); `0` makes this term the last, so the subscription reads
             * `non_renewing` and cancels at term end. NOT a total — it is the same
             * counter `renewal.ts` decrements, and the create path already seeds it from
             * the item's `billing_cycles` (full cap during a trial, cap − 1 otherwise,
             * because a non-trial's current period is billed at create).
             */
            remaining_billing_cycles: z.number().int().nonnegative().nullable().optional(),
            /** Net-D for invoices raised from now on. `null` inherits the customer's / business's. */
            net_term_days: z.number().int().min(0).max(365).nullable().optional(),
            /**
             * `payment_method`: the customer's payment method this
             * subscription charges. `null` unpins it — collection uses the customer's primary.
             */
            payment_method: z.string().max(LIMITS.id).min(1).nullable().optional(),
            /**
             * `metadata` — REPLACED wholesale, not merged. For the metadata-only
             * change; a change that also moves items belongs on a checkout session, which
             * applies both together or neither.
             */
            metadata: metadataField().nullable().optional(),
            custom_fields: metadataField().nullable().optional(),
          })
          .catchall(cfKeys),
        req.body,
      );
      if (!body.success) return badRequest(reply, body.error);
      const customFields = collectCustomFields(req.body, body.data.custom_fields);
      const hasSetting =
        body.data.auto_collection !== undefined ||
        body.data.po_number !== undefined ||
        body.data.shipping_address_id !== undefined ||
        body.data.invoice_notes !== undefined ||
        body.data.remaining_billing_cycles !== undefined ||
        body.data.max_refundable_credits_usage_minor !== undefined ||
        body.data.max_excess_payment_usage_minor !== undefined ||
        body.data.metadata !== undefined ||
        body.data.net_term_days !== undefined ||
        body.data.payment_method !== undefined;
      if (!hasSetting && customFields === undefined) {
        return badRequest(
          reply,
          "Provide at least one of: auto_collection, po_number, shipping_address_id, invoice_notes, remaining_billing_cycles, max_refundable_credits_usage_minor, max_excess_payment_usage_minor, net_term_days, payment_method, metadata, custom_fields (cf_*)",
        );
      }
      let pinnedPm: { id: string; publicId: string } | null | undefined;
      if (body.data.payment_method !== undefined) {
        const target = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
        if (!target) {
          return reply.code(404).send({
            error: {
              type: "invalid_request_error",
              message: `We could not find the subscription ${subId}.`,
            },
          });
        }
        if (body.data.payment_method === null) pinnedPm = null;
        else {
          const pm = await pinnablePaymentMethod(
            req.organization!.id,
            target.customerId,
            body.data.payment_method,
          );
          if ("error" in pm) return badRequest(reply, pm.error);
          pinnedPm = { id: pm.id, publicId: body.data.payment_method };
        }
      }
      let updated;
      try {
        updated = await updateSubscriptionSettings({
          organizationId: req.organization!.id,
          businessId: business.id,
          subscriptionPublicId: subId,
          autoCollection: body.data.auto_collection,
          poNumber: body.data.po_number,
          shippingAddressPublicId: body.data.shipping_address_id,
          invoiceNotes: body.data.invoice_notes,
          remainingBillingCycles: body.data.remaining_billing_cycles,
          maxRefundableCreditsUsageMinor: bigintOrNull(
            body.data.max_refundable_credits_usage_minor,
          ),
          maxExcessPaymentUsageMinor: bigintOrNull(body.data.max_excess_payment_usage_minor),
          netTermDays: body.data.net_term_days,
          ...(pinnedPm !== undefined ? { defaultPaymentMethodId: pinnedPm?.id ?? null } : {}),
          metadata: body.data.metadata,
          customFields,
        });
      } catch (e) {
        if (e instanceof CustomFieldError || e instanceof ShippingAddressError)
          return badRequest(reply, e.message);
        throw e;
      }
      if (!updated) {
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      }
      // The pin is echoed only when this request set it; other PATCHes keep their shape.
      const shipTo =
        body.data.shipping_address_id !== undefined
          ? await getSubscriptionDetail(req.organization!.id, business.id, updated.publicId)
          : null;
      return serializeSubscription(updated, business, {
        ...(pinnedPm !== undefined ? { default_payment_method: pinnedPm?.publicId ?? null } : {}),
        ...(shipTo ? { ship_to: shipTo } : {}),
        renewalSkips: await skipViewOf(req.organization!.id, updated),
      });
    },
  );

  // Change a subscription's items (plan/quantity) with immediate proration.
  app.post(
    "/v1/businesses/:biz/subscriptions/:sub/change",
    {
      preHandler: [authenticate, requirePerm("subscriptions:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const subscription = await getSubscriptionByPublicId(
        req.organization!.id,
        business.id,
        subId,
      );
      if (!subscription) {
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      }
      const parsed = parseRequest(changeSubBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const coupon = singleCouponCode(parsed.data);
      if (!coupon.ok) return badRequest(reply, coupon.message);
      const edit = {
        changes: parsed.data.changes.map((c) => ({
          itemId: c.item,
          newPriceId: c.price,
          newQuantity: c.quantity,
          customAmountMinor: c.unit_price_minor,
        })),
        // The same mapping `/estimate` does, onto the same engine parameters — one
        // request in, one invoice out.
        adds: parsed.data.adds.map((a) => ({
          priceId: a.price,
          quantity: a.quantity,
          customAmountMinor: a.unit_price_minor,
        })),
        removes: parsed.data.removes,
      };
      // Billing rules: the gate, the timing and the proration for this direction.
      const { direction, policy, planMoves } = await changePolicyFor(
        req.organization!.id,
        business,
        subscription,
        edit,
      );
      if (policy.blocked) return blockedReply(reply, policy.blocked);
      // Fields only an immediate change can carry. Sent without a timing, they mean
      // "now" (an existing caller's request stays immediate) wherever the rule allows it.
      const d = parsed.data;
      const nowOnly = [
        d.at ? "at" : null,
        d.reset_term !== undefined ? "reset_term" : null,
        d.prorate !== undefined ? "prorate" : null,
        d.invoice_immediately !== undefined ? "invoice_immediately" : null,
        d.metadata !== undefined ? "metadata" : null,
        coupon.code ? "coupon_code" : null,
        d.manual_discount ? "manual_discount" : null,
        d.remove_discount ? "remove_discount" : null,
        // Applied by this call only: a scheduled change follows the rules when it lands.
        d.on_charge_failure ? "on_charge_failure" : null,
        d.coupons ? "coupons" : null,
        d.downgrade_credit ? "downgrade_credit" : null,
        d.plan_credits ? "plan_credits" : null,
        d.allowances ? "allowances" : null,
      ].filter((f): f is string => f !== null);
      const timing: ChangeTiming =
        d.timing ??
        (nowOnly.length > 0 && policy.timings.includes("now") ? "now" : policy.defaultTiming);
      if (!policy.timings.includes(timing))
        return badRequest(reply, timingRefusal(direction, policy.timings));
      // A quote pins the amounts of a change booked NOW; nothing else can honour it.
      if (d.priced_at !== undefined && d.quote === undefined)
        return badRequest(reply, "We could not apply the change. Send priced_at with quote.");
      if (d.quote !== undefined && (timing !== "now" || d.at))
        return badRequest(
          reply,
          `We could not apply the change. quote and priced_at apply only to a change applied now, without at. ${
            d.at ? "Remove at" : "Send timing: now"
          }, or remove quote and priced_at.`,
        );
      if (timing === "end_of_term") {
        if (nowOnly.length > 0)
          return badRequest(
            reply,
            `We could not schedule the change. ${
              d.timing
                ? "A change at the end of the term"
                : `This business applies ${direction === "downgrade" ? "a downgrade" : "an upgrade"} at the end of the term, and a change at the end of the term`
            } cannot carry ${nowOnly.join(", ")}. Remove ${nowOnly.length > 1 ? "these fields" : "this field"}${
              policy.timings.includes("now") ? ", or send timing: now" : ""
            }.`,
          );
        // In a trial the term end is the activation.
        const effectiveAt = subscription.currentPeriodEnd ?? subscription.trialEnd;
        if (!effectiveAt)
          return badRequest(
            reply,
            "We could not schedule the change. This subscription has no term end. Send timing: now.",
          );
        try {
          const row = await scheduleChange({
            organizationId: req.organization!.id,
            businessId: business.id,
            subscriptionId: subscription.id,
            type: "change",
            effectiveAt,
            ...edit,
          });
          return reply.code(200).send({
            object: "subscription_change",
            subscription: subscription.publicId,
            timing,
            proration_invoice: null,
            credit_note: null,
            unbilled_charges: null,
            scheduled_change: serializeScheduledChange(row),
          });
        } catch (e) {
          if (e instanceof SubscriptionError) return badRequest(reply, e.message);
          throw e;
        }
      }

      const reset = resetOverridesFor(direction, d);
      if (!reset.ok) return badRequest(reply, reset.message);

      try {
        // 0242 — backdating window. `at` in the past is a backdated change; whether it
        // raises the proration invoice now decides which consent flag applies.
        if (parsed.data.at) {
          const verdict = isBackdateAllowed({
            config: resolveBackdatingConfig(business),
            action: "change",
            target: new Date(parsed.data.at),
            now: await businessWallClock(business.id),
            businessTimezone: business.timezone,
            raisesPastDatedInvoice:
              parsed.data.invoice_immediately ??
              resolveUnbilledChargesConfig(business).onChange === "invoice_immediately",
          });
          if (!verdict.allowed) return badRequest(reply, verdict.message);
        }
        // An estimate's `priced_at` (≤ 15 min old) is the booking instant, so the
        // unused-time credit is the one the estimate showed.
        const wallNow = await businessWallClock(business.id);
        const bookAt = parsed.data.at
          ? new Date(parsed.data.at)
          : (quotedInstant(d.priced_at, wallNow) ?? wallNow);
        const prorate = prorateFor(policy, direction, parsed.data.prorate);
        // The call's own `reset_term` wins, else the business rule for a plan change.
        const resetTerm = resetTermForPolicy(policy, direction, planMoves, parsed.data.reset_term);
        if (d.quote !== undefined) {
          // A renewal since the estimate: its term is gone, so the amounts are too.
          const start = subscription.currentPeriodStart;
          if (start && bookAt < start) return quoteMovedReply(reply);
          const est = await priceEdit({
            organizationId: req.organization!.id,
            businessId: business.id,
            subscriptionId: subscription.id,
            now: bookAt,
            edit,
            resetTerm,
            prorate,
            couponCode: coupon.code,
            manualDiscount: d.manual_discount,
            removeDiscount: d.remove_discount,
            coupons: d.coupons,
            downgradeCredit: d.downgrade_credit,
          });
          if (estimateQuote(est) !== d.quote) return quoteMovedReply(reply);
        }
        const {
          prorationInvoice,
          creditNote,
          unbilledCharges: booked,
          creditRefunds,
        } = await changeSubscription({
          organizationId: req.organization!.id,
          businessId: business.id,
          subscriptionId: subscription.id,
          now: bookAt,
          ...edit,
          resetTerm,
          // The call's own `prorate` wins for whichever direction this change is.
          prorate,
          invoiceImmediately: parsed.data.invoice_immediately,
          // Applied INSIDE the change's transaction, before its proration invoice — so a
          // coupon added on the change screen discounts that proration. The dashboard
          // used to post these as a separate call
          // AFTER `/change`, which billed the proration at list price.
          couponCode: coupon.code,
          manualDiscount: toEngineManualDiscount(parsed.data.manual_discount),
          removeDiscount: parsed.data.remove_discount === true,
          // Omitted stays omitted: `metadata: undefined` leaves the column alone, where
          // `metadata: null` clears it. The route must not collapse the two.
          ...(parsed.data.metadata !== undefined ? { metadata: parsed.data.metadata } : {}),
          // This call's own rules; each omitted one is the business rule.
          ...(d.on_charge_failure ? { failedChangeCharge: d.on_charge_failure } : {}),
          ...(d.coupons ? { planChangeCoupons: d.coupons } : {}),
          ...(d.downgrade_credit ? { downgradeCredit: d.downgrade_credit } : {}),
          ...(reset.overrides ? { resetOverrides: reset.overrides } : {}),
        });
        return reply.code(200).send({
          object: "subscription_change",
          subscription: subscription.publicId,
          timing,
          // Upgrade → a proration invoice; downgrade → a credit note (never a
          // negative "credited" invoice).
          proration_invoice: prorationInvoice
            ? {
                id: prorationInvoice.publicId,
                status: prorationInvoice.status,
                total_minor: Number(prorationInvoice.totalMinor),
              }
            : null,
          credit_note: creditNote
            ? {
                id: creditNote.publicId,
                total_minor: Number(creditNote.totalMinor),
                status: creditNote.status,
              }
            : null,
          // Deferred (`invoice_immediately: false`): the proration was queued, not
          // billed. Reported for the same reason signup's `deferred_charge` is — a
          // caller that only reads `proration_invoice` would otherwise see null and
          // conclude the change cost nothing.
          unbilled_charges: booked
            ? booked.map((c) => ({
                id: c.publicId,
                description: c.description,
                amount_minor: Number(c.amountMinor),
                currency: c.currency,
                entity_type: c.entityType,
              }))
            : null,
          // `downgrade_credit: refund`: the credit paid back, or why it stayed as credit.
          ...(creditRefunds
            ? {
                credit_refunds: creditRefunds.map((x) => ({
                  credit_note: x.creditNote,
                  refunded_minor: x.refundedMinor,
                  kept_minor: x.keptMinor,
                  ...(x.reason ? { reason: x.reason } : {}),
                })),
              }
            : {}),
          scheduled_change: null,
        });
      } catch (e) {
        // A concurrent write invalidated the proration we computed — nothing was
        // applied and nothing was billed, so this is a retryable 409, not a 400.
        if (e instanceof ProrationConflictError) return conflict(reply, e.message);
        if (e instanceof ProrationError) {
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        }
        // The quote check's estimate can refuse a coupon.
        if (e instanceof CouponError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Dry-run estimate of a subscription change (proration + tax) — no writes.
  app.post(
    "/v1/businesses/:biz/subscriptions/:sub/estimate",
    { preHandler: [authenticate, requirePerm("subscriptions:estimate")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const subscription = await getSubscriptionByPublicId(
        req.organization!.id,
        business.id,
        subId,
      );
      if (!subscription)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      const parsed = parseRequest(estimateSubBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const coupon = singleCouponCode(parsed.data);
      if (!coupon.ok) return badRequest(reply, coupon.message);
      const wallNow = await businessWallClock(business.id);
      let estimateAt = wallNow;
      if (parsed.data.change_option === "specific_date") {
        const d = parsed.data;
        if (!d.changes_scheduled_at)
          return badRequest(reply, "change_option=specific_date requires changes_scheduled_at");
        // Only what `POST …/schedule` can carry: a scheduled change has no discount,
        // no proration switch and no term reset of its own.
        if (d.coupon_code || d.coupon_ids?.length || d.manual_discount || d.remove_discount)
          return badRequest(
            reply,
            "a scheduled change cannot add or remove a coupon or manual discount",
          );
        if (d.prorate !== undefined || d.reset_term !== undefined)
          return badRequest(reply, "a scheduled change cannot set prorate or reset_term");
        if (d.coupons || d.downgrade_credit)
          return badRequest(reply, "a scheduled change cannot set coupons or downgrade_credit");
        const at = new Date(d.changes_scheduled_at);
        const termEnd = subscription.currentPeriodEnd;
        if (at <= wallNow) return badRequest(reply, "changes_scheduled_at must be in the future");
        if (!termEnd || at >= termEnd)
          return badRequest(reply, "changes_scheduled_at must fall inside the current term");
        estimateAt = at;
      } else if (parsed.data.changes_scheduled_at) {
        return badRequest(reply, "changes_scheduled_at needs change_option=specific_date");
      } else if (parsed.data.change_option === "end_of_term") {
        // Same input the scheduled-change applier uses: `now` = the effective instant,
        // no proration or term-reset switch of its own. Discounts stay: the dashboard
        // applies them now, so they reach the renewal this previews.
        if (parsed.data.prorate !== undefined || parsed.data.reset_term !== undefined)
          return badRequest(
            reply,
            "a change at the end of the term cannot set prorate or reset_term",
          );
        if (parsed.data.coupons || parsed.data.downgrade_credit)
          return badRequest(
            reply,
            "a change at the end of the term cannot set coupons or downgrade_credit",
          );
        const termEnd = subscription.currentPeriodEnd ?? subscription.trialEnd;
        if (!termEnd) return badRequest(reply, "This subscription has no term end.");
        estimateAt = termEnd;
      }
      const edit = {
        changes: parsed.data.changes.map((c) => ({
          itemId: c.item,
          newPriceId: c.price,
          newQuantity: c.quantity,
          customAmountMinor: c.unit_price_minor,
        })),
        adds: parsed.data.adds.map((a) => ({
          priceId: a.price,
          quantity: a.quantity,
          customAmountMinor: a.unit_price_minor,
        })),
        removes: parsed.data.removes,
      };
      // The same policy `/change` resolves, so the preview prorates as the apply will.
      const { direction, policy, planMoves } = await changePolicyFor(
        req.organization!.id,
        business,
        subscription,
        edit,
      );
      const prorate = prorateFor(policy, direction, parsed.data.prorate);
      // A scheduled change keeps the anchor, as its applier does.
      const resetTerm =
        estimateAt === wallNow
          ? resetTermForPolicy(policy, direction, planMoves, parsed.data.reset_term)
          : undefined;
      try {
        const est = await priceEdit({
          organizationId: req.organization!.id,
          businessId: business.id,
          subscriptionId: subscription.id,
          now: estimateAt,
          edit,
          resetTerm,
          prorate,
          couponCode: coupon.code,
          manualDiscount: parsed.data.manual_discount,
          removeDiscount: parsed.data.remove_discount,
          coupons: parsed.data.coupons,
          downgradeCredit: parsed.data.downgrade_credit,
        });
        const rules = resolveBillingRulesConfig(business);
        const scope = await withTenant(req.organization!.id, async (tx) => {
          const { planChangeResetScope } = await import("@/modules/credits/credit-clock");
          return planChangeResetScope(tx, subscription.id, edit.changes);
        });
        return {
          ...est,
          // Send both back on `/change`: it books at this instant and refuses moved amounts.
          priced_at: estimateAt.toISOString(),
          quote: estimateQuote(est),
          change_policy: {
            direction,
            timings: policy.timings,
            default_timing: policy.defaultTiming,
            blocked: policy.blocked,
            prorate,
            // Whether this change restarts the term: the call's `reset_term`, else the rule.
            reset_term: resetTerm === true,
            // Where a credit from this change goes: the request's `downgrade_credit`, else the rule.
            credit_handling:
              parsed.data.downgrade_credit ??
              creditHandlingFor(resolveLifecycleConfig(business).downgradeCredit),
            // The rules a `/change` without its own field uses.
            coupons: parsed.data.coupons ?? resolveLifecycleConfig(business).planChangeCoupons,
            on_charge_failure: rules.failedChangeCharge,
            // Null when the change moves no plan that grants credits or a meter allowance.
            plan_credits: scope.planCredits
              ? direction === "downgrade"
                ? rules.planCredits.onDowngrade
                : rules.planCredits.onUpgrade
              : null,
            allowances:
              scope.allowances && direction !== "downgrade" ? rules.allowances.onUpgrade : null,
            // The business rule a `/change` without `invoice_immediately` uses.
            invoice_immediately:
              policy.invoiceImmediately ??
              (await defaultInvoiceImmediately(req.organization!.id, business.id)),
          },
        };
      } catch (e) {
        if (e instanceof ProrationError) return badRequest(reply, e.message);
        if (e instanceof CouponError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Dry-run estimate of the NEXT RENEWAL invoice — the "Next Billing Amount".
  // No body and no writes, so GET. Returns `null` in `estimate` when the
  // subscription has no next term (cancelling, non-renewing, cycle cap reached).
  app.get(
    "/v1/businesses/:biz/subscriptions/:sub/renewal_estimate",
    { preHandler: [authenticate, requirePerm("subscriptions:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const subscription = await getSubscriptionByPublicId(
        req.organization!.id,
        business.id,
        subId,
      );
      if (!subscription)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      const flag = z
        .enum(["true", "false"])
        .transform((v) => v === "true")
        .optional();
      const q = parseRequest(
        z.object({
          ignore_scheduled_cancellation: flag,
          ignore_scheduled_changes: flag,
          include_delayed_charges: flag,
          use_existing_balances: flag,
          include_usage_so_far: flag,
        }),
        req.query ?? {},
      );
      if (!q.success) return badRequest(reply, q.error);
      try {
        let unpriced: { id: string; type: string; effective_at: string } | null = null;
        const estimate = await estimateRenewal({
          organizationId: req.organization!.id,
          businessId: business.id,
          subscriptionId: subscription.id,
          ignoreScheduledCancellation: q.data.ignore_scheduled_cancellation,
          ignoreScheduledChanges: q.data.ignore_scheduled_changes,
          includeDelayedCharges: q.data.include_delayed_charges,
          useExistingBalances: q.data.use_existing_balances,
          includeUsageSoFar: q.data.include_usage_so_far,
          onUnpriced: (c) => {
            unpriced = c;
          },
        });
        return {
          object: "renewal_estimate",
          subscription: subscription.publicId,
          estimate,
          // Why `estimate` is null when a scheduled change or pause it cannot price comes first.
          unpriced_scheduled_change: unpriced,
        };
      } catch (e) {
        if (e instanceof ProrationError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Dry-run estimate of a NEW subscription's first invoice — no writes.
  app.post(
    "/v1/businesses/:biz/customers/:cus/subscription_estimate",
    { preHandler: [authenticate, requirePerm("subscriptions:estimate")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!customer)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the customer ${cusId}.`,
          },
        });
      const parsed = parseRequest(createSubBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const resolved: SubscriptionItemInput[] = [];
      for (const it of parsed.data.items) {
        const price = await getPriceByPublicId(req.organization!.id, business.id, it.price);
        if (!price)
          return reply.code(404).send({
            error: {
              type: "invalid_request_error",
              message: `We could not find the price ${it.price}.`,
            },
          });
        resolved.push({
          price,
          quantity: it.quantity,
          customAmountMinor: it.unit_price_minor,
          freeQuantity: it.free_quantity,
        });
      }
      try {
        return await estimateNewSubscription({
          organizationId: req.organization!.id,
          businessId: business.id,
          customerId: customer.id,
          items: resolved,
          // Forwarded, not dropped. This route parses the FULL `createSubBody` so the
          // preview refuses whatever the create would refuse — but it used to pass only
          // `items`, so `coupon_ids` was validated and then thrown away and every
          // discounted signup previewed at list price.
          couponCodes: parsed.data.coupon_ids,
          // Same for the signup manual discount: it now applies to the first invoice, so
          // the preview of that invoice has to include it.
          manualDiscount: parsed.data.discount
            ? {
                kind: parsed.data.discount.type === "percent" ? "percentage" : "fixed_amount",
                percentOffBps:
                  parsed.data.discount.type === "percent"
                    ? Math.round(parsed.data.discount.value * 100)
                    : undefined,
                amountOffMinor:
                  parsed.data.discount.type === "amount"
                    ? BigInt(Math.round(parsed.data.discount.value))
                    : undefined,
              }
            : undefined,
          now: await businessWallClock(business.id),
        });
      } catch (e) {
        if (e instanceof ProrationError) return badRequest(reply, e.message);
        if (e instanceof CouponError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Dry-run estimate of REACTIVATING a cancelled subscription onto a fresh term — no
  // writes. A POST-shaped READ (the item set does not fit a query string), so no
  // `idempotency` preHandler: there is nothing to deduplicate.
  //
  // Separate from `…/subscriptions/:sub/estimate`, which is `estimateChange` and prorates
  // against a CURRENT TERM a cancelled subscription does not have. See
  // `estimateReactivate` for why `…/customers/:cus/subscription_estimate` could not be
  // reused either (it resolves credit ceilings with no subscription, and auto-includes
  // mandatory add-ons the reactivation will not book).
  app.post(
    "/v1/businesses/:biz/subscriptions/:sub/reactivate_estimate",
    { preHandler: [authenticate, requirePerm("subscriptions:manage")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const subscription = await getSubscriptionByPublicId(
        req.organization!.id,
        business.id,
        subId,
      );
      if (!subscription)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      // The money-bearing subset of the reactivate body. `billing_cycles` and
      // `charges_handling` are deliberately NOT accepted: neither changes the first
      // invoice's composition (a cycle cap bites at the SECOND cycle, and
      // `charges_handling` decides whether that composition is invoiced or parked as an
      // unbilled charge — the caller's decision, exactly as `invoice_immediately` is on
      // the change screen). `free_quantity` IS accepted: it lowers every rated period.
      const parsed = parseRequest(
        z.object({
          items: z
            .array(
              z.object({
                price: z.string().max(LIMITS.id).min(1),
                quantity: z.number().int().positive().max(LIMITS.quantity).optional(),
                unit_price_minor: z.number().int().nonnegative().nullish(),
                free_quantity: z.number().int().nonnegative().nullish(),
              }),
            )
            .max(LIMITS.lineItems)
            .min(1),
          trial_end: z.string().datetime().optional(),
          term: z.enum(["continue", "new"]).optional(),
          on_charge_failure: z.enum(["refuse", "dun"]).optional(),
          /** Price the term a backdated reactivation would open (same guard as the booking). */
          reactivate_from: z.string().datetime({ offset: true }).optional(),
          // What the reactivation will apply before it bills — so the preview is its invoice.
          ...pendingDiscountFields,
        }),
        req.body ?? {},
      );
      if (!parsed.success)
        return badRequest(reply, parsed.error.issues[0]?.message ?? "Invalid estimate body");
      const coupon = singleCouponCode(parsed.data);
      if (!coupon.ok) return badRequest(reply, coupon.message);
      const estNow = await businessWallClock(business.id);
      let termStart = estNow;
      if (parsed.data.reactivate_from) {
        const at = new Date(parsed.data.reactivate_from);
        const problem = reactivateFromProblem(business, subscription, at, estNow);
        if (problem) return badRequest(reply, problem);
        if (parsed.data.trial_end && at > new Date(parsed.data.trial_end))
          return badRequest(reply, "reactivate_from cannot be after trial_end");
        termStart = at;
      }
      const md = toEngineManualDiscount(parsed.data.manual_discount);
      try {
        return await estimateReactivate({
          organizationId: req.organization!.id,
          businessId: business.id,
          subscriptionId: subscription.id,
          items: parsed.data.items.map((i) => ({
            price: i.price,
            quantity: i.quantity,
            unitPriceMinor: i.unit_price_minor,
            freeQuantity: i.free_quantity,
          })),
          trialEnd: parsed.data.trial_end ? new Date(parsed.data.trial_end) : null,
          now: termStart,
          backdated: !!parsed.data.reactivate_from,
          ...(parsed.data.term ? { term: parsed.data.term } : {}),
          ...(parsed.data.on_charge_failure
            ? { onChargeFailure: parsed.data.on_charge_failure }
            : {}),
          ...(coupon.code ? { couponCodes: [coupon.code] } : {}),
          ...(md
            ? {
                manualDiscount: {
                  kind: md.kind,
                  percentOffBps: md.percentOffBps,
                  amountOffMinor: md.amountOffMinor != null ? BigInt(md.amountOffMinor) : undefined,
                },
              }
            : {}),
        });
      } catch (e) {
        if (e instanceof ProrationError) return badRequest(reply, e.message);
        if (e instanceof CouponError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Dry-run estimate of a CANCELLATION's money effects
  // (`cancel_subscription_estimate`). A POST-shaped READ (an option set does not fit a
  // query string), so no `idempotency` preHandler: it writes nothing to deduplicate.
  app.post(
    "/v1/businesses/:biz/subscriptions/:sub/cancel_estimate",
    { preHandler: [authenticate, requirePerm("subscriptions:estimate")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const subscription = await getSubscriptionByPublicId(
        req.organization!.id,
        business.id,
        subId,
      );
      if (!subscription)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      const parsed = parseRequest(cancelEstimateBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const d = parsed.data;
      try {
        return await estimateCancel({
          organizationId: req.organization!.id,
          businessId: business.id,
          subscriptionId: subscription.id,
          now: await businessWallClock(business.id),
          // Identical shorthand resolution to the cancel route — a preview that read
          // `at_period_end` differently would price a different cancellation.
          cancelOption: resolveCancelOption(d),
          cancelAt: d.cancel_at ? new Date(d.cancel_at) : undefined,
          creditOptionForCurrentTermCharges: d.credit_option_for_current_term_charges,
          unbilledChargesOption: d.unbilled_charges_option,
          accountReceivablesHandling: d.account_receivables_handling,
          refundableCreditsHandling: d.refundable_credits_handling,
          includeCancellationDayInBilling: d.include_cancellation_day_in_billing,
          finalPeriod: d.final_period,
          planCreditsOnCancelAtPeriodEnd: d.plan_credits?.on_cancel_at_period_end,
        });
      } catch (e) {
        if (e instanceof ProrationError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Record a metered usage event against a subscription item.
  app.post(
    "/v1/businesses/:biz/subscriptions/:sub/usage",
    {
      preHandler: [authenticate, requirePerm("usage:manage"), usageBodyKeyAsHeader, idempotency],
      onSend: idempotencyOnSend,
      // High volume; the usage record keeps the body. The request log keeps it on errors only.
      config: { requestLog: "meta" },
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const subscription = await getSubscriptionByPublicId(
        req.organization!.id,
        business.id,
        subId,
      );
      if (!subscription) {
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      }
      const parsed = parseRequest(usageBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);

      const items = await getSubscriptionItems(req.organization!.id, subscription.id);
      const item = items.find((i) => i.publicId === parsed.data.item);
      if (!item) {
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription item ${parsed.data.item}.`,
          },
        });
      }

      let rec: Awaited<ReturnType<typeof recordUsage>>;
      try {
        rec = await recordUsage({
          organizationId: req.organization!.id,
          businessId: business.id,
          subscriptionItemId: item.id,
          quantity: parsed.data.quantity,
          uniqueKey: parsed.data.unique_key,
          operation: parsed.data.operation,
          timestamp: parsed.data.timestamp ? new Date(parsed.data.timestamp) : undefined,
          idempotencyKey: parsed.data.idempotency_key,
          note: parsed.data.note,
          checkWindow: true,
        });
      } catch (e) {
        if (e instanceof UsageOutsideWindowError || e instanceof UsageRuleError)
          return badRequest(reply, e.message);
        if (e instanceof UsageIdempotencyConflictError)
          return reply.code(409).send({ error: { type: "idempotency_error", message: e.message } });
        throw e;
      }
      return reply.code(201).send({
        object: "usage_record",
        id: rec.publicId,
        item: parsed.data.item,
        quantity: Number(rec.quantity),
        timestamp: rec.timestamp,
        // Only for a remove, so an add answers exactly as before.
        ...(rec.operation !== "add" ? { operation: rec.operation } : {}),
        // Only when set, so a note-less record answers exactly as before.
        ...(rec.note != null ? { note: rec.note } : {}),
      });
    },
  );

  // --- Lifecycle: resolve the sub, run the op, serialize ---
  const withSub = (
    path: string,
    // `business` (not just its id) is passed through because serializing a subscription
    // needs the business's term-end convention — see serializeSubscription.
    run: (ctx: {
      orgId: string;
      bizId: string;
      business: TermEndConvention & { billingRulesConfig?: unknown; pauseConfig?: unknown };
      sub: typeof subscriptions.$inferSelect;
      body: unknown;
      reply: import("fastify").FastifyReply;
      originToken: string | null;
    }) => Promise<unknown>,
  ) =>
    // Finale review blocker: the full idempotency middleware (fingerprint on
    // method+path+body, 409 on key reuse with a different payload, cached
    // response replay) must front these money-moving ops — origin_token alone
    // let a cross-subscription key reuse ride another op's invoice.
    app.post(
      path,
      {
        preHandler: [authenticate, requirePerm("subscriptions:lifecycle"), idempotency],
        onSend: idempotencyOnSend,
      },
      async (req, reply) => {
        const business = await resolveBusiness(req, reply);
        if (!business) return;
        const subId = (req.params as { sub: string }).sub;
        const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
        if (!sub) {
          return reply.code(404).send({
            error: {
              type: "invalid_request_error",
              message: `We could not find the subscription ${subId}.`,
            },
          });
        }
        // Post-H (#5): expose the request Idempotency-Key as a per-operation token so
        // delta ops (change_term_end) dedup a crash-retry without false-matching a
        // distinct later operation to the same boundary.
        const idemKey = req.headers["idempotency-key"];
        const originToken = typeof idemKey === "string" && idemKey.length > 0 ? idemKey : null;
        try {
          return await run({
            orgId: req.organization!.id,
            bizId: business.id,
            business,
            sub,
            body: req.body,
            reply,
            originToken,
          });
        } catch (e) {
          if (e instanceof SubscriptionError) return badRequest(reply, e.message);
          if (e instanceof CouponError) return badRequest(reply, e.message);
          throw e;
        }
      },
    );

  // Cancel with the full option set (SUB-5/SUB-8).
  const cancelBody = z.object({
    // Omit → the business default_cancel_option (H1/SET-1) is applied by the service.
    cancel_option: z
      .enum(["immediately", "end_of_term", "specific_date", "end_of_billing_term"])
      .optional(),
    cancel_at: z.string().datetime().optional(),
    credit_option_for_current_term_charges: z.enum(["none", "prorate", "full"]).optional(),
    unbilled_charges_option: z.enum(["invoice", "delete"]).optional(),
    account_receivables_handling: z
      .enum(["no_action", "schedule_payment_collection", "write_off", "void"])
      .optional(),
    refundable_credits_handling: z.enum(["no_action", "schedule_refund"]).optional(),
    cancel_reason_code: z.string().max(200).optional(),
    // Back-compat: at_period_end shorthand maps to cancel_option=end_of_term.
    at_period_end: z.boolean().optional(),
    cancel_reason: z.string().max(200).optional(),
    /** Whole-day proration: bill (true) or credit (false) the cancellation day. */
    include_cancellation_day_in_billing: z.boolean().optional(),
    /** specific_date only: the last term's credit. Omitted = the business rule. */
    final_period: z.enum(SPECIFIC_DATE_FINAL_PERIODS).optional(),
    plan_credits: cancelPlanCredits,
  });
  withSub(
    "/v1/businesses/:biz/subscriptions/:sub/cancel",
    async ({ orgId, bizId, business, sub, body, reply }) => {
      const p = parseRequest(cancelBody, body ?? {});
      if (!p.success) return badRequest(reply, p.error);
      const d = p.data;
      const noReason = missingReason(business, "cancel_subscription", d.cancel_reason_code);
      if (noReason) return badRequest(reply, noReason);
      const cancelOption = resolveCancelOption(d); // undefined → service applies the business default
      const { subscription, creditNote, scheduledChange, warnings } =
        await cancelSubscriptionWithOptions({
          organizationId: orgId,
          businessId: bizId,
          subscriptionId: sub.id,
          now: await businessWallClock(bizId),
          cancelOption,
          cancelAt: d.cancel_at ? new Date(d.cancel_at) : undefined,
          creditOptionForCurrentTermCharges: d.credit_option_for_current_term_charges,
          unbilledChargesOption: d.unbilled_charges_option,
          accountReceivablesHandling: d.account_receivables_handling,
          refundableCreditsHandling: d.refundable_credits_handling,
          cancelReasonCode: d.cancel_reason_code,
          cancelReason: d.cancel_reason,
          includeCancellationDayInBilling: d.include_cancellation_day_in_billing,
          finalPeriod: d.final_period,
          planCreditsOnCancelAtPeriodEnd: d.plan_credits?.on_cancel_at_period_end,
        });
      // `warnings` is present only when a side-effect of an immediate cancel did not
      // complete (see cancelSubscriptionWithOptions). The cancellation itself succeeded,
      // so this is a 200 — but omitting the field entirely would hide, say, a
      // cancellation credit that was never issued behind an apparently clean response.
      return reply.code(200).send({
        ...serializeSubscription(subscription, business),
        credit_note: creditNote,
        scheduled_change: scheduledChange,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    },
  );

  /**
   * Reconcile a subscription against a DESIRED item list (`update_for_items`).
   *
   * `/change` already edits items, but it speaks in DELTAS against item ids the caller
   * must already know. An integrator that holds a desired configuration ("plan X plus
   * two of add-on Y") would have to read the subscription, diff it, and emit the right
   * mix of change/add/remove calls — re-implementing, client-side and slightly
   * differently each time, logic the engine can do correctly once.
   *
   * Non-interactive by design: this is the API sibling of the change-mode checkout, for
   * a caller acting on the customer's behalf rather than a buyer standing at a page. It
   * takes no payment, so `invoice_immediately` and `prorate` are the caller's to choose
   * — the case that motivated it is a TRIAL upgrade, where both must be off because
   * nothing should be charged before the trial converts.
   */
  /**
   * `meta_data` for the reconcile — see the handler for the ordering guarantee, which is
   * weaker than `/change`'s and deliberately stated rather than implied.
   */
  const updateForItemsMetadata = z.record(z.string(), z.unknown()).nullable().optional();
  const updateForItemsBody = z.object({
    metadata: updateForItemsMetadata,
    items: z
      .array(
        z.object({
          price: z.string().max(LIMITS.id).min(1),
          quantity: z.number().int().positive().max(LIMITS.quantity).optional(),
        }),
      )
      .max(LIMITS.lineItems)
      .min(1),
    /** `replace_items_list`: the list is exhaustive — drop unlisted non-plan items. */
    replace_items_list: z.boolean().optional(),
    /** `mandatory_items_to_remove`: drop these PRICE ids whatever the mode. */
    mandatory_items_to_remove: z.array(z.string().min(1)).optional(),
    /**
     * `prorate`. False suppresses the PRORATED credit and charge a mid-term change
     * would raise. Omitted → normal proration.
     *
     * On a term RESET (a cadence change, or `reset_term`) the full new-term charge is
     * NOT a prorated artefact and still happens — only the unused-time credit is
     * dropped. See `changeSubscription`.
     */
    prorate: z.boolean().optional(),
    invoice_immediately: z.boolean().optional(),
    reset_term: z.boolean().optional(),
  });
  withSub(
    "/v1/businesses/:biz/subscriptions/:sub/update_for_items",
    async ({ orgId, bizId, business, sub, body, reply }) => {
      const p = parseRequest(updateForItemsBody, body ?? {});
      if (!p.success) return badRequest(reply, p.error);
      const d = p.data;
      try {
        // Refused here, before any item moves: the metadata write below runs after the items
        // and cannot undo them.
        await assertMetadataAllowed(orgId, bizId, "subscription", d.metadata, {
          mode: "update",
          existing: (sub.metadata as Record<string, unknown> | null) ?? null,
        });
        const desired = await resolveDesiredItems(orgId, bizId, d.items);
        const live = await loadLiveItems(orgId, sub.id);
        const ops = planItemOperations(live, desired, {
          replaceItemsList: d.replace_items_list,
          explicitRemovals: d.mandatory_items_to_remove,
        });
        // Billing rules: gate, timing (this route applies now) and proration per direction.
        const guard = await immediateChangeGuard(reply, orgId, business, sub, {
          changes: ops.changes,
          adds: ops.additions.map((a) => ({ priceId: a.price.publicId, quantity: a.quantity })),
          removes: ops.removals.map((r) => r.itemPublicId),
        });
        if (!guard) return reply;
        await applyItemOperations({
          organizationId: orgId,
          businessId: bizId,
          subscriptionId: sub.id,
          now: await businessWallClock(bizId),
          ops,
          resetTerm: resetTermForPolicy(
            guard.policy,
            guard.direction,
            guard.planMoves,
            d.reset_term,
          ),
          // Passed through, not collapsed into `invoiceImmediately: false`. That old
          // mapping DEFERRED the money instead of suppressing it — the proration lines
          // were still computed and booked as unbilled charges, so a caller asking for
          // no proration was still charged, just on the next invoice. The engine has a
          // real no-proration mode now. Omitted = the business rule for the direction.
          prorate: prorateFor(guard.policy, guard.direction, d.prorate),
          invoiceImmediately: d.invoice_immediately,
          metadata: d.metadata,
        });
        /**
         * Metadata AFTER the item operations, and only if every one of them succeeded:
         * `applyItemOperations` writes it in its summary transaction, so the one
         * `subscription_changed` carries it.
         *
         * ── THE GUARANTEE, AND ITS LIMIT ───────────────────────────────────────────────
         * `applyItemOperations` is deliberately multi-step (one `changeSubscription`, then
         * an add per addition, then a remove per removal — each its own transaction, so
         * each folds its own proration correctly). It is therefore NOT one atomic unit,
         * and no metadata placement here can make it one.
         *
         * So the order is chosen for which failure is survivable. Metadata last means a
         * refused item operation writes NO metadata — the subscription is never flagged
         * for something the customer was not billed for. The residual is the mirror case:
         * items applied, then this write fails, leaving them disagreed. That is why it is
         * a single-row UPDATE with only the event after it.
         *
         * A caller that needs true atomicity has two better surfaces, and should use them:
         * `POST …/change` applies items and metadata in ONE transaction (adds and removes
         * included), and a checkout session carries metadata that is applied only on
         * completion. This endpoint is the convenience reconcile — it takes a desired list
         * and works out the operations — and that convenience is what costs the atomicity.
         */
        /**
         * Answers with the FULL subscription — items, customer, discount and payment
         * method — identical to `GET /subscriptions/:sub`.
         *
         * This used to serialize a bare `getSubscriptionByPublicId` row with no `extra`,
         * and `serializeSubscription` emits `items`, `customer`, `discount` and
         * `default_payment_method` only when it is handed them (items are a separate
         * table; one subscription row cannot carry them). So the response to an
         * ITEM-RECONCILE endpoint omitted the items — the one thing the caller just
         * changed and the one thing it needs to confirm the change.
         *
         * That is not merely unhelpful, it broke a consumer that maps this response
         * through its own adapter, which reads `items` to find the plan line, and an
         * absent key became an empty item list. Its `plan_maps` lookup then ran with
         * `vendorPlanId=undefined` and threw, AFTER the items here had already been
         * applied — so the change succeeded in billing and failed in the product.
         * Observed in production 2026-09-07.
         *
         * A caller cannot reasonably work around it either: the fallback is a second
         * round trip to the detail route for state this handler has already loaded.
         * Reconcile endpoints should return what they reconciled.
         *
         * `getSubscriptionDetail` rather than `getSubscriptionByPublicId` for exactly
         * that reason — same loader, same extras, same shape as the GET, so the two
         * cannot drift.
         */
        const detail = await getSubscriptionDetail(orgId, bizId, sub.publicId);
        const dues = await subscriptionDues(orgId, detail!.subscription.id);
        return reply.code(200).send({
          ...serializeSubscription(detail!.subscription, business, {
            items: detail!.items,
            customer: detail!.customerPublicId,
            default_payment_method: detail!.defaultPaymentMethodPublicId,
            ship_to: detail!,
            discount: detail!.discount,
            dues,
            renewalSkips: await skipViewOf(orgId, detail!.subscription),
          }),
          // Reported so a caller can assert what actually happened rather than diffing
          // the subscription itself — a removal that the CAT-3 mandatory guard refused
          // would otherwise be indistinguishable from one that was never requested.
          applied: {
            changed: ops.changes.length,
            added: ops.additions.length,
            removed: ops.removals.map((r) => r.pricePublicId),
          },
        });
      } catch (e) {
        if (e instanceof ItemReconcileError) return badRequest(reply, e.message);
        if (e instanceof SubscriptionError) return badRequest(reply, e.message);
        if (e instanceof ProrationConflictError) return conflict(reply, e.message);
        if (e instanceof ProrationError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Pause with the full option set (SUB-6).
  const pauseBody = z.object({
    // OPTIONAL, not `.default("immediately")` (0242): a zod default is indistinguishable
    // from a caller's explicit choice, so it masked `pause_config.pause_option` and the
    // business default could never apply. The service now resolves the default.
    pause_option: z
      .enum(["immediately", "end_of_term", "specific_date", "billing_cycles"])
      .optional(),
    pause_date: z.string().datetime().optional(),
    skip_billing_cycles: z.number().int().positive().optional(),
    // `no_action` keeps pending charges for the resumption invoice, overriding the default.
    unbilled_charges_handling: z.enum(["invoice", "delete", "no_action"]).optional(),
    dunning_handling: z.enum(["continue", "stop"]).optional(),
    /** Schedule the resume for this instant. */
    resume_date: z.string().datetime().optional(),
    /** Overrides `plan_credits.on_pause` for this pause only. Omitted = the business rule. */
    plan_credits: z.object({ on_pause: z.enum(PLAN_CREDIT_PAUSES).optional() }).optional(),
  });
  withSub(
    "/v1/businesses/:biz/subscriptions/:sub/pause",
    async ({ orgId, bizId, business, sub, body, reply }) => {
      const p = parseRequest(pauseBody, body ?? {});
      if (!p.success) return badRequest(reply, p.error);
      const d = p.data;
      const locked = lockedOverrides(resolvePauseConfig(business), d);
      if (locked.length) return badRequest(reply, lockedOverrideMessage("pause", locked));
      const { subscription, resumeScheduledAt, scheduledChange } =
        await pauseSubscriptionWithOptions({
          organizationId: orgId,
          businessId: bizId,
          subscriptionId: sub.id,
          now: await businessWallClock(bizId),
          pauseOption: d.pause_option,
          pauseDate: d.pause_date ? new Date(d.pause_date) : undefined,
          skipBillingCycles: d.skip_billing_cycles,
          unbilledChargesHandling: d.unbilled_charges_handling,
          dunningHandling: d.dunning_handling,
          ...(d.resume_date ? { resumeDate: new Date(d.resume_date) } : {}),
          ...(d.plan_credits?.on_pause ? { planCreditsOnPause: d.plan_credits.on_pause } : {}),
        });
      return reply.code(200).send({
        ...serializeSubscription(subscription, business),
        resume_scheduled_at: resumeScheduledAt,
        scheduled_change: scheduledChange,
      });
    },
  );

  // Resume with the full option set (SUB-6).
  const resumeBody = z.object({
    charges_handling: z.enum(["invoice_immediately", "add_to_unbilled_charges"]).optional(),
    unpaid_invoices_handling: z.enum(["no_action", "schedule_payment_collection"]).optional(),
    /** `specific_date` schedules the resume for `resume_date`; omitted = now. */
    resume_option: z.enum(["immediately", "specific_date"]).optional(),
    resume_date: z.string().datetime().optional(),
  });
  withSub(
    "/v1/businesses/:biz/subscriptions/:sub/resume",
    async ({ orgId, bizId, business, sub, body, reply }) => {
      const p = parseRequest(resumeBody, body ?? {});
      if (!p.success) return badRequest(reply, p.error);
      const locked = lockedOverrides(resolvePauseConfig(business), p.data);
      if (locked.length) return badRequest(reply, lockedOverrideMessage("resume", locked));
      if (p.data.resume_option === "specific_date") {
        if (!p.data.resume_date)
          return badRequest(reply, "resume_option=specific_date requires resume_date");
        const { subscription, scheduledChange } = await scheduleResumeSubscription({
          organizationId: orgId,
          businessId: bizId,
          subscriptionId: sub.id,
          now: await businessWallClock(bizId),
          resumeDate: new Date(p.data.resume_date),
          chargesHandling: p.data.charges_handling,
          unpaidInvoicesHandling: p.data.unpaid_invoices_handling,
        });
        return reply.code(200).send({
          ...serializeSubscription(subscription, business),
          resume_scheduled_at: new Date(p.data.resume_date),
          scheduled_change: scheduledChange,
        });
      }
      if (p.data.resume_date)
        return badRequest(reply, "resume_date needs resume_option=specific_date");
      const { subscription, invoice } = await resumeSubscriptionWithOptions({
        organizationId: orgId,
        businessId: bizId,
        subscriptionId: sub.id,
        now: await businessWallClock(bizId),
        chargesHandling: p.data.charges_handling,
        unpaidInvoicesHandling: p.data.unpaid_invoices_handling,
      });
      return reply.code(200).send({
        ...serializeSubscription(subscription, business, {
          renewalSkips: await skipViewOf(orgId, subscription),
        }),
        latest_invoice: invoice,
      });
    },
  );

  // Remove a scheduled cancellation (SUB-2).
  withSub(
    "/v1/businesses/:biz/subscriptions/:sub/remove_scheduled_cancellation",
    async ({ orgId, bizId, business, sub, body, reply }) => {
      const p = parseRequest(
        z.object({
          /** Cycles to run after the current one; omitted renews forever. */
          billing_cycles: z.number().int().positive().optional(),
        }),
        body && typeof body === "object" ? body : {},
      );
      if (!p.success) return badRequest(reply, p.error);
      const updated = await removeScheduledCancellation({
        organizationId: orgId,
        businessId: bizId,
        subscriptionId: sub.id,
        ...(p.data.billing_cycles !== undefined ? { billingCycles: p.data.billing_cycles } : {}),
      });
      return reply.code(200).send(
        serializeSubscription(updated, business, {
          renewalSkips: await skipViewOf(orgId, updated),
        }),
      );
    },
  );

  // Change the current term's end boundary (SUB-9).
  const changeTermBody = z.object({
    term_ends_at: z.string().datetime(),
    prorate: z.boolean().optional(),
    invoice_immediately: z.boolean().optional(),
  });
  withSub(
    "/v1/businesses/:biz/subscriptions/:sub/change_term_end",
    async ({ orgId, bizId, business, sub, body, reply, originToken }) => {
      const p = parseRequest(changeTermBody, body ?? {});
      if (!p.success) return badRequest(reply, p.error);
      const { subscription, prorationInvoice } = await changeTermEnd({
        organizationId: orgId,
        businessId: bizId,
        subscriptionId: sub.id,
        now: await businessWallClock(bizId),
        termEndsAt: new Date(p.data.term_ends_at),
        prorate: p.data.prorate,
        invoiceImmediately: p.data.invoice_immediately,
        originToken,
      });
      return reply.code(200).send({
        ...serializeSubscription(subscription, business, {
          renewalSkips: await skipViewOf(orgId, subscription),
        }),
        proration_invoice: prorationInvoice,
      });
    },
  );

  // Edit the trial end date of an in-trial subscription.
  const editTrialEndBody = z
    .object({
      trial_end: z.string().datetime().optional(),
      immediately: z.boolean().optional(),
    })
    .refine((b) => (b.immediately === true) !== (b.trial_end != null), {
      message: "Provide exactly one of trial_end or immediately",
    });
  withSub(
    "/v1/businesses/:biz/subscriptions/:sub/edit_trial_end",
    async ({ orgId, bizId, business, sub, body, reply }) => {
      const p = parseRequest(editTrialEndBody, body ?? {});
      if (!p.success) return badRequest(reply, p.error);
      const { subscription } = await editTrialEnd({
        organizationId: orgId,
        businessId: bizId,
        subscriptionId: sub.id,
        now: await businessWallClock(bizId),
        trialEnd: p.data.trial_end ? new Date(p.data.trial_end) : undefined,
        immediately: p.data.immediately,
      });
      return reply.code(200).send(serializeSubscription(subscription, business));
    },
  );

  // Manual discount: %/amount discount applied directly to
  // a subscription without a coupon object. Shares storage + removal with the
  // coupon-discount model (`applied_coupons.source = 'manual'`) — removal
  // reuses the existing DELETE .../discount endpoint (coupon-routes.ts).
  const manualDiscountBody = z
    .object({
      type: z.enum(["percent", "amount"]),
      value: z.number().positive(),
      duration: z.enum(["one_time", "forever"]),
      note: z.string().max(500).optional(),
    })
    .refine((b) => b.type !== "percent" || (b.value >= 1 && b.value <= 100), {
      message: "value must be between 1 and 100 for a percent discount",
    });
  withSub(
    "/v1/businesses/:biz/subscriptions/:sub/manual_discount",
    async ({ orgId, bizId, business, sub, body, reply }) => {
      const p = parseRequest(manualDiscountBody, body ?? {});
      if (!p.success) return badRequest(reply, p.error);
      const applied = await applyManualDiscount({
        organizationId: orgId,
        businessId: bizId,
        subscriptionId: sub.id,
        kind: p.data.type === "percent" ? "percentage" : "fixed_amount",
        percentOffBps: p.data.type === "percent" ? Math.round(p.data.value * 100) : undefined,
        amountOffMinor: p.data.type === "amount" ? Math.round(p.data.value) : undefined,
        currency: sub.currency,
        durationType: p.data.duration === "one_time" ? "once" : "forever",
        note: p.data.note,
        now: await businessWallClock(bizId),
      });
      return reply.code(201).send({
        object: "discount",
        id: applied.publicId,
        subscription: sub.publicId,
        source: "manual",
        status: applied.status,
        remaining_periods: applied.remainingPeriods,
      });
    },
  );

  // --- Add/remove items (add-ons) + ad-hoc charges ---
  //
  // BOTH item routes are MONEY writes — the add raises a proration charge, the remove
  // issues a credit note — so both carry the full idempotency pair (locked decision #5):
  // `idempotency` as a preHandler AND `idempotencyOnSend` as an onSend hook. One
  // without the other is worse than neither: the preHandler alone leaves the
  // in-progress row un-finalized, so the key 409s forever and a legitimate retry can
  // never land; the onSend alone finalizes a record nothing ever created.
  // Until 2026-08-03 these were the ONLY subscription write routes without them, and
  // `subscription_items` has only a PARTIAL unique index (auto-included mandatory
  // items), so a retried POST double-added AND double-charged with nothing to stop it.
  // Locked down by `pnpm verify:idempotency-race` § C.
  app.post(
    "/v1/businesses/:biz/subscriptions/:sub/items",
    {
      preHandler: [authenticate, requirePerm("subscriptions:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
      if (!sub)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      const parsed = parseRequest(
        z.object({
          price: z.string().max(LIMITS.id).min(1),
          quantity: z.number().int().positive().max(LIMITS.quantity).default(1),
          unit_price_minor: z.number().int().nonnegative().optional(),
          /**
           * Same Invoicing Option `/change` carries, and resolved from the same business
           * default when omitted — the two are halves of one composition edit, and until
           * this existed the ADD half always invoiced, so a deferred change could not
           * include one. Not `.default(...)`: a zod default here would shadow
           * `businesses.default_invoice_immediately`.
           */
          invoice_immediately: z.boolean().optional(),
        }),
        req.body,
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      const price = await getPriceByPublicId(req.organization!.id, business.id, parsed.data.price);
      if (!price)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the price ${parsed.data.price}.`,
          },
        });
      // Billing rules: gate and timing. An added item is always prorated (no rule applies).
      const guard = await immediateChangeGuard(reply, req.organization!.id, business, sub, {
        changes: [],
        adds: [
          {
            priceId: price.publicId,
            quantity: parsed.data.quantity,
            customAmountMinor: parsed.data.unit_price_minor,
          },
        ],
      });
      if (!guard) return reply;
      try {
        const {
          item,
          invoice,
          unbilledCharges: queued,
        } = await addSubscriptionItem({
          organizationId: req.organization!.id,
          businessId: business.id,
          subscriptionId: sub.id,
          price,
          quantity: parsed.data.quantity,
          customAmountMinor: parsed.data.unit_price_minor,
          invoiceImmediately: parsed.data.invoice_immediately,
          now: await businessWallClock(business.id),
        });
        return reply.code(201).send({
          object: "subscription_item",
          id: item.publicId,
          price: price.publicId,
          quantity: item.quantity,
          proration_invoice: invoice
            ? {
                id: invoice.publicId,
                status: invoice.status,
                total_minor: Number(invoice.totalMinor),
              }
            : null,
          // Present only when the charge was DEFERRED, mirroring `/change`'s shape — a
          // caller that reads `proration_invoice: null` has to be able to tell "queued"
          // from "nothing was owed".
          ...(queued?.length
            ? {
                unbilled_charges: queued.map((c) => ({
                  id: c.publicId,
                  amount_minor: Number(c.amountMinor),
                })),
              }
            : {}),
        });
      } catch (e) {
        if (e instanceof SubscriptionError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.delete(
    "/v1/businesses/:biz/subscriptions/:sub/items/:item",
    {
      preHandler: [authenticate, requirePerm("subscriptions:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { sub: subId, item } = req.params as { sub: string; item: string };
      const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
      if (!sub)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      // Billing rules: gate and timing. A removed item is always credited (no rule applies).
      const guard = await immediateChangeGuard(reply, req.organization!.id, business, sub, {
        changes: [],
        removes: [item],
      });
      if (!guard) return reply;
      try {
        const { creditNote, creditNotes } = await removeSubscriptionItem({
          organizationId: req.organization!.id,
          businessId: business.id,
          subscriptionId: sub.id,
          itemPublicId: item,
          now: await businessWallClock(business.id),
        });
        const asJson = (cn: (typeof creditNotes)[number]) => ({
          id: cn.publicId,
          total_minor: Number(cn.totalMinor),
          status: cn.status,
        });
        // `credit_notes` carries ALL of them: an item billed across several invoices is
        // credited once per invoice (see issueCurrentTermCredit.targetPriceIds), and
        // reporting only one would understate what the customer got. `credit_note` stays
        // as the single, largest note for callers written before the split existed.
        return {
          object: "subscription_item",
          id: item,
          removed: true,
          credit_note: creditNote ? asJson(creditNote) : null,
          credit_notes: creditNotes.map(asJson),
        };
      } catch (e) {
        if (e instanceof SubscriptionError) return badRequest(reply, e.message);
        // A concurrent write invalidated the credit this removal priced — the item was
        // NOT deleted and nothing was credited, so this is a retryable 409, not a 400.
        // Must be tested BEFORE ProrationError: ProrationConflictError is a subclass,
        // and the 400 branch below would otherwise swallow it and tell an honest client
        // its request was invalid. Same ordering as /change.
        if (e instanceof ProrationConflictError) return conflict(reply, e.message);
        // A removal owes the unused time on the item, and that credit can be REFUSED
        // (the refundable cap on the item's own charge invoice). `removeSubscriptionItem`
        // rolls the deletion back and re-raises it as a ProrationError, exactly as
        // `/change` does — so the caller gets 400 with the real reason instead of the
        // 500 that used to accompany an already-deleted item. Same mapping as /change.
        if (e instanceof ProrationError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.post(
    "/v1/businesses/:biz/subscriptions/:sub/charges",
    {
      preHandler: [authenticate, requirePerm("subscriptions:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
      if (!sub)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      // One charge per line. `price` set → a catalog charge-item (`charge_items[]`),
      // amount optional and rated from the price; unset → ad-hoc (`charges[]`).
      // `period_start`/`period_end` are the line's `date_from`/`date_to`.
      const chargeLine = z
        .object({
          description: z.string().min(1).max(500).optional(),
          amount_minor: z.number().int().positive().optional(),
          quantity: z.number().int().positive().max(LIMITS.quantity).optional(),
          price: z.string().max(LIMITS.id).min(1).optional(),
          period_start: z.string().datetime().optional(),
          period_end: z.string().datetime().optional(),
        })
        .refine((b) => b.price != null || (b.description != null && b.amount_minor != null), {
          message: "Provide either `price`, or both `description` and `amount_minor`",
        });
      // Accepts either a single charge (the original shape — kept so existing callers
      // and the SDK keep working) or `charges[]`, which the repeater produces and
      // which bills as ONE invoice rather than one per charge.
      const parsed = parseRequest(
        z.union([
          z.object({
            charges: z.array(chargeLine).min(1),
            invoice_now: z.boolean().default(false),
          }),
          chargeLine.and(z.object({ invoice_now: z.boolean().default(false) })),
        ]),
        req.body,
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      const body = parsed.data;
      const rawLines = "charges" in body ? body.charges : [body];

      const lines: AdHocChargeInput[] = [];
      for (const d of rawLines) {
        const periodStart = d.period_start ? new Date(d.period_start) : null;
        const periodEnd = d.period_end ? new Date(d.period_end) : null;
        if (periodStart && periodEnd && periodEnd < periodStart) {
          return badRequest(reply, "period_end cannot be before period_start");
        }
        let description = d.description;
        let amountMinor = d.amount_minor;
        let priceId: string | null = null;
        const quantity = d.quantity ?? 1;
        if (d.price != null) {
          const price = await getPriceByPublicId(req.organization!.id, business.id, d.price);
          if (!price) return notFound(reply, `We could not find the price ${d.price}.`);
          if (price.currency !== sub.currency) {
            return badRequest(
              reply,
              `Price ${d.price} is in ${price.currency}, not the subscription currency ${sub.currency}`,
            );
          }
          priceId = price.id;
          description ??= price.name ?? d.price;
          // An explicit amount still wins: a charge-item's price may be overridden.
          amountMinor ??= Number(computeLineAmount(price, quantity));
        }
        if (amountMinor == null || amountMinor <= 0) {
          return badRequest(
            reply,
            "The charge amount must be positive. The catalog price rated to zero.",
          );
        }
        lines.push({
          description: description!,
          amountMinor,
          quantity,
          priceId,
          periodStart,
          periodEnd,
        });
      }

      const result = await addAdHocCharges({
        organizationId: req.organization!.id,
        businessId: business.id,
        subscriptionId: sub.id,
        lines,
        invoiceNow: body.invoice_now,
        now: await businessWallClock(business.id),
      });
      if (result.object === "invoice") {
        return reply.code(201).send({
          object: "charge",
          invoiced: true,
          invoice: {
            id: result.invoice.publicId,
            status: result.invoice.status,
            total_minor: Number(result.invoice.totalMinor),
          },
        });
      }
      const serializeUnbilled = (c: (typeof result.charges)[number]) => ({
        object: "unbilled_charge",
        id: c.publicId,
        description: c.description,
        amount_minor: Number(c.amountMinor),
        currency: c.currency,
        status: c.status,
        quantity: c.quantity,
        entity_type: c.entityType,
        period_start: c.periodStart?.toISOString() ?? null,
        // Same convention as the invoice line this charge becomes once it is billed —
        // otherwise the identical stored instant reads one way here and another from
        // `GET /v1/invoices/:id`. A caller-chosen non-midnight period is untouched by
        // `inclusivePeriodEnd`, so this only ever moves a real day boundary.
        period_end: inclusivePeriodEnd(c.periodEnd ?? null, business)?.toISOString() ?? null,
      });
      // An array body gets a list back; the single-charge body keeps its original
      // single-object response so existing callers don't have to change.
      if ("charges" in body) {
        return reply
          .code(201)
          .send({ object: "list", data: result.charges.map(serializeUnbilled) });
      }
      // Echo the same shape the list endpoint returns — a caller that just created a
      // charge shouldn't have to re-list to see the period it asked for.
      return reply.code(201).send(serializeUnbilled(result.charges[0]!));
    },
  );

  // CAT-4: trigger an on_demand attached item's charge now.
  app.post(
    "/v1/businesses/:biz/subscriptions/:sub/trigger_charge",
    {
      preHandler: [authenticate, requirePerm("subscriptions:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
      if (!sub)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      const parsed = parseRequest(
        z.object({
          attached_item: z.string().max(LIMITS.id).min(1),
          quantity: z.number().int().positive().max(LIMITS.quantity).optional(),
        }),
        req.body,
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const { invoice, payment } = await triggerAttachedItemCharge({
          organizationId: req.organization!.id,
          businessId: business.id,
          subscriptionId: sub.id,
          itemPublicId: parsed.data.attached_item,
          quantity: parsed.data.quantity,
          now: await businessWallClock(business.id),
        });
        return reply.code(201).send({
          object: "charge",
          invoice: {
            id: invoice.publicId,
            status: invoice.status,
            total_minor: Number(invoice.totalMinor),
          },
          paid: payment?.status === "succeeded",
        });
      } catch (e) {
        if (e instanceof SubscriptionError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/subscriptions/:sub/unbilled_charges",
    { preHandler: [authenticate, requirePerm("usage:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
      if (!sub)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      const rows = await listUnbilledCharges(req.organization!.id, sub.id);
      return {
        object: "list",
        data: rows.map((c) => ({
          object: "unbilled_charge",
          id: c.publicId,
          description: c.description,
          amount_minor: Number(c.amountMinor),
          currency: c.currency,
          status: c.status,
          quantity: c.quantity,
          entity_type: c.entityType,
          period_start: c.periodStart?.toISOString() ?? null,
          period_end: c.periodEnd?.toISOString() ?? null,
        })),
      };
    },
  );

  // --- Minimum commitment ---
  const serializeCommitment = (
    sub: { commitmentAmountMinor: bigint | null; currency: string },
    c: Awaited<ReturnType<typeof getCommitment>>,
  ) => ({
    object: "commitment",
    amount_minor: sub.commitmentAmountMinor != null ? Number(sub.commitmentAmountMinor) : null,
    currency: sub.currency,
    segments: c.segments.map((g) => ({ from: g.from, amount_minor: Number(g.amount_minor) })),
    prorated_minor: Number(c.proratedMinor),
    counted_minor: Number(c.countedMinor),
    shortfall_minor: Number(c.shortfallMinor),
    term: c.term ? { start: c.term.start.toISOString(), end: c.term.end.toISOString() } : null,
  });

  app.get(
    "/v1/businesses/:biz/subscriptions/:sub/commitment",
    { preHandler: [authenticate, requirePerm("subscriptions:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
      if (!sub)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      return serializeCommitment(sub, await getCommitment(req.organization!.id, sub));
    },
  );

  app.post(
    "/v1/businesses/:biz/subscriptions/:sub/commitment",
    {
      preHandler: [authenticate, requirePerm("subscriptions:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
      if (!sub)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      const parsed = parseRequest(
        z.object({ amount_minor: z.number().int().positive().nullable() }),
        req.body,
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const updated = await setCommitment({
          organizationId: req.organization!.id,
          businessId: business.id,
          sub,
          amountMinor: parsed.data.amount_minor != null ? BigInt(parsed.data.amount_minor) : null,
          now: await businessWallClock(business.id),
        });
        return serializeCommitment(updated, await getCommitment(req.organization!.id, updated));
      } catch (e) {
        if (e instanceof CommitmentError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // --- Scheduled (future-dated) changes ---
  app.post(
    "/v1/businesses/:biz/subscriptions/:sub/schedule",
    {
      preHandler: [authenticate, requirePerm("subscriptions:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
      if (!sub)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      const parsed = parseRequest(scheduleBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      if (parsed.data.type === "change") {
        // A scheduled change is gated and timed now; the applier does not ask again.
        const { direction, policy } = await changePolicyFor(req.organization!.id, business, sub, {
          changes: (parsed.data.changes ?? []).map((c) => ({
            itemId: c.item,
            newPriceId: c.price,
            newQuantity: c.quantity,
            customAmountMinor: c.unit_price_minor,
          })),
          adds: (parsed.data.adds ?? []).map((a) => ({
            priceId: a.price,
            quantity: a.quantity,
            customAmountMinor: a.unit_price_minor,
          })),
          removes: parsed.data.removes,
        });
        if (policy.blocked) return blockedReply(reply, policy.blocked);
        if (!policy.timings.includes("end_of_term"))
          return badRequest(reply, timingRefusal(direction, policy.timings));
      }
      try {
        const row = await scheduleChange({
          organizationId: req.organization!.id,
          businessId: business.id,
          subscriptionId: sub.id,
          type: parsed.data.type,
          effectiveAt: new Date(parsed.data.effective_at),
          changes: parsed.data.changes?.map((c) => ({
            itemId: c.item,
            newPriceId: c.price,
            newQuantity: c.quantity,
            customAmountMinor: c.unit_price_minor,
          })),
          adds: parsed.data.adds?.map((a) => ({
            priceId: a.price,
            quantity: a.quantity,
            customAmountMinor: a.unit_price_minor,
          })),
          removes: parsed.data.removes,
        });
        return reply.code(201).send(serializeScheduledChange(row));
      } catch (e) {
        if (e instanceof SubscriptionError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // ── Skipped renewals ─────────────────────────────────────────────────────────
  // A skip names one upcoming renewal; at it the clock advances the period without
  // charging the recurring items, and a fixed term does not count it.
  const renewalAtBody = z.object({ renewal_at: z.string().datetime({ offset: true }) });
  const skipSource = (): SkipSource =>
    currentEventContext()?.source === "dashboard" ? "dashboard" : "api";

  withSub(
    "/v1/businesses/:biz/subscriptions/:sub/skip_renewal",
    async ({ orgId, bizId, business, sub, body, reply }) => {
      const p = parseRequest(renewalAtBody, body ?? {});
      if (!p.success) return badRequest(reply, p.error);
      const { subscription, skip } = await skipRenewal({
        organizationId: orgId,
        businessId: bizId,
        subscriptionId: sub.id,
        renewalAt: new Date(p.data.renewal_at),
        source: skipSource(),
        now: await businessWallClock(bizId),
      });
      return reply.code(200).send({
        ...serializeSubscription(subscription, business, {
          renewalSkips: await skipViewOf(orgId, subscription),
        }),
        renewal_skip: serializeRenewalSkip(skip, subscription.publicId),
      });
    },
  );

  withSub(
    "/v1/businesses/:biz/subscriptions/:sub/unskip_renewal",
    async ({ orgId, bizId, business, sub, body, reply }) => {
      const p = parseRequest(renewalAtBody, body ?? {});
      if (!p.success) return badRequest(reply, p.error);
      const { subscription, skip } = await unskipRenewal({
        organizationId: orgId,
        subscriptionId: sub.id,
        renewalAt: new Date(p.data.renewal_at),
        now: await businessWallClock(bizId),
      });
      return reply.code(200).send({
        ...serializeSubscription(subscription, business, {
          renewalSkips: await skipViewOf(orgId, subscription),
        }),
        renewal_skip: serializeRenewalSkip(skip, subscription.publicId),
      });
    },
  );

  app.get(
    "/v1/businesses/:biz/subscriptions/:sub/upcoming_renewals",
    { preHandler: [authenticate, requirePerm("subscriptions:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
      if (!sub)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      const rows = await listUpcomingRenewals(
        req.organization!.id,
        sub.id,
        await businessWallClock(business.id),
      );
      return {
        object: "list",
        data: rows.map((r) => ({
          object: "upcoming_renewal",
          renewal_at: r.renewalAt,
          skipped: r.skip != null,
          renewal_skip: r.skip?.publicId ?? null,
          changeable: r.locked == null,
        })),
      };
    },
  );

  app.get(
    "/v1/businesses/:biz/subscriptions/:sub/renewal_skips",
    { preHandler: [authenticate, requirePerm("subscriptions:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
      if (!sub)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      const rows = await listRenewalSkips(req.organization!.id, sub.id);
      return { object: "list", data: rows.map((r) => serializeRenewalSkip(r, sub.publicId)) };
    },
  );

  app.get(
    "/v1/businesses/:biz/subscriptions/:sub/scheduled_changes",
    { preHandler: [authenticate, requirePerm("subscriptions:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
      if (!sub)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      const rows = await listScheduledChanges(req.organization!.id, sub.id);
      return { object: "list", data: rows.map(serializeScheduledChange) };
    },
  );

  /**
   * Delete a subscription — soft, and available in ANY status.
   *
   * It is not cancel-then-delete: deleting an active subscription stops billing it with no
   * cancellation, no final invoice and no credit, which is the point (see
   * `deleteSubscription`). Its invoices, payments and ledger entries are untouched and stay
   * on the customer, and an unpaid invoice stays payable.
   *
   * 404 for an id that is already deleted, for the same reason every other read of one
   * 404s: to the API it no longer exists.
   */
  app.delete(
    "/v1/businesses/:biz/subscriptions/:sub",
    {
      preHandler: [authenticate, requirePerm("subscriptions:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
      if (!sub)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      // The return value is deliberately unused: `null` only means a concurrent delete won
      // the race, which is the caller's intended outcome either way.
      await deleteSubscription({
        organizationId: req.organization!.id,
        businessId: business.id,
        subscriptionId: sub.id,
        now: await businessWallClock(business.id),
      });
      return reply.code(200).send({ object: "subscription", id: subId, deleted: true });
    },
  );

  app.delete(
    "/v1/businesses/:biz/scheduled_changes/:sch",
    {
      preHandler: [authenticate, requirePerm("subscriptions:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { sch } = req.params as { sch: string };
      const row = await cancelScheduledChange(req.organization!.id, business.id, sch);
      if (!row) return badRequest(reply, `No pending scheduled change: ${sch}`);
      return serializeScheduledChange(row);
    },
  );

  // Reactivate: clear a pending cancel, or restart a canceled sub (bills the new term).
  app.post(
    "/v1/businesses/:biz/subscriptions/:sub/reactivate",
    {
      preHandler: [authenticate, requirePerm("subscriptions:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
      if (!sub)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the subscription ${subId}.`,
          },
        });
      // Optional body: editing a cancelled sub = reactivation with a
      // fresh item set + billing cycles / trial / invoicing option. An empty body
      // keeps the original plain reactivate (detail-page action rail).
      const reBody = parseRequest(
        z.object({
          items: z
            .array(
              z.object({
                price: z.string().max(LIMITS.id).min(1),
                quantity: z.number().int().positive().max(LIMITS.quantity).optional(),
                unit_price_minor: z.number().int().nonnegative().nullish(),
                free_quantity: z.number().int().nonnegative().nullish(),
                billing_cycles: z.number().int().positive().nullish(),
              }),
            )
            .max(LIMITS.lineItems)
            .optional(),
          billing_cycles: z.number().int().positive().nullish(),
          trial_end: z.string().datetime().optional(),
          charges_handling: z.enum(["invoice_immediately", "add_to_unbilled_charges"]).optional(),
          /** Omitted: continue the current term when eligible (`findInTermReactivation`). */
          term: z.enum(["continue", "new"]).optional(),
          /** Backdate the fresh term's start (a cancelled subscription, backdating policy). */
          reactivate_from: z.string().datetime({ offset: true }).optional(),
          /** An intent the buyer authorized for the fresh term's amount due — consumed into it. */
          payment_intent: z.string().max(LIMITS.id).min(1).optional(),
          /** `customer` = the buyer is present (on-session); `merchant` = off-session, the default. */
          payment_initiator: z.enum(["customer", "merchant"]).optional(),
          /** A failed charge: `refuse` keeps it cancelled, `dun` reactivates. Omitted = business rule. */
          on_charge_failure: z.enum(["refuse", "dun"]).optional(),
          // Applied to the reactivated subscription BEFORE its invoice is raised.
          ...pendingDiscountFields,
        }),
        req.body ?? {},
      );
      if (!reBody.success)
        return badRequest(reply, reBody.error.issues[0]?.message ?? "Invalid reactivate body");
      const rb = reBody.data;
      const reCoupon = singleCouponCode(rb);
      if (!reCoupon.ok) return badRequest(reply, reCoupon.message);
      const couponCode = reCoupon.code;
      // Omitted: the business rule (`reactivation_charges`) for a cancelled subscription,
      // which starts a new term. Undoing a pending cancel bills nothing, so no rule applies.
      const chargesHandling =
        rb.charges_handling ??
        (sub.status === "cancelled" &&
        resolveLifecycleConfig(business).reactivationCharges === "add_to_unbilled_charges"
          ? ("add_to_unbilled_charges" as const)
          : undefined);
      const withOptions = !!(
        rb.items?.length ||
        rb.billing_cycles != null ||
        rb.trial_end ||
        chargesHandling ||
        couponCode ||
        rb.manual_discount
      );
      const reManual = toEngineManualDiscount(rb.manual_discount);
      /** What this request applied, so a refused charge can take it back off. */
      let appliedCoupon: string | null = null;
      let appliedManual = false;
      const reNow = await businessWallClock(business.id);
      let termStart: Date | undefined;
      if (rb.reactivate_from) {
        const at = new Date(rb.reactivate_from);
        const problem = reactivateFromProblem(business, sub, at, reNow);
        if (problem) return badRequest(reply, problem);
        if (rb.trial_end && at > new Date(rb.trial_end))
          return badRequest(reply, "reactivate_from cannot be after trial_end");
        termStart = at;
      }
      // Only restarting a cancelled subscription raises a charge to authenticate or settle.
      if (
        (rb.payment_intent || rb.payment_initiator === "customer") &&
        sub.status !== "cancelled"
      ) {
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            code: "payment_intent_not_collectible",
            message: `This reactivation collects no payment. The subscription is ${sub.status}, not cancelled.`,
          },
        });
      }
      try {
        // Refusal on a failed charge, the stranded-invoice repair and activation charges all
        // live in `reactivateAndBill`, shared with a reactivating checkout.
        const result = await reactivateAndBill({
          organizationId: req.organization!.id,
          businessId: business.id,
          business,
          subscription: sub,
          now: reNow,
          term: rb.term ?? "auto",
          ...(termStart ? { termStart } : {}),
          ...(rb.payment_initiator === "customer" ? { session: "on_session" as const } : {}),
          ...(rb.payment_intent ? { paymentIntent: rb.payment_intent } : {}),
          ...(rb.on_charge_failure ? { onChargeFailure: rb.on_charge_failure } : {}),
          withOptions,
          items: rb.items?.map((i) => ({
            price: i.price,
            quantity: i.quantity,
            unitPriceMinor: i.unit_price_minor,
            freeQuantity: i.free_quantity,
            billingCycles: i.billing_cycles,
          })),
          billingCycles: rb.billing_cycles ?? null,
          trialEnd: rb.trial_end ? new Date(rb.trial_end) : null,
          chargesHandling,
          // What `beforeBill` adds, so a charge taken first is priced with it.
          quote: {
            ...(couponCode ? { couponCodes: [couponCode] } : {}),
            ...(reManual
              ? {
                  manualDiscount: {
                    kind: reManual.kind,
                    ...(reManual.percentOffBps != null
                      ? { percentOffBps: reManual.percentOffBps }
                      : {}),
                    ...(reManual.amountOffMinor != null
                      ? { amountOffMinor: BigInt(reManual.amountOffMinor) }
                      : {}),
                  },
                }
              : {}),
          },
          // On the live subscription, before the invoice: the first term is billed discounted.
          beforeBill: async () => {
            if (couponCode) {
              await applyCouponToSubscription({
                organizationId: req.organization!.id,
                businessId: business.id,
                subscriptionId: sub.id,
                code: couponCode,
                now: reNow,
                suppressSubscriptionChanged: true,
              });
              appliedCoupon = couponCode;
            }
            if (reManual) {
              await applyManualDiscount({
                organizationId: req.organization!.id,
                businessId: business.id,
                subscriptionId: sub.id,
                kind: reManual.kind,
                percentOffBps: reManual.percentOffBps,
                amountOffMinor: reManual.amountOffMinor,
                durationType: reManual.durationType,
                now: reNow,
              });
              appliedManual = true;
            }
          },
        });
        if (result.actionRequired) {
          // Nothing was written: the buyer completes `next_action`, then re-sends with
          // `payment_intent` — the signup's 3DS loop.
          const piView = serializePaymentIntent(result.actionRequired.intent);
          return reply.code(402).send({
            error: {
              type: "payment_error",
              code: "requires_action",
              message:
                "We did not reactivate the subscription yet. The buyer must authenticate this payment. Then retry with payment_intent.",
            },
            payment_intent: piView,
            next_action: piView.next_action,
          });
        }
        if (result.refused) {
          // Cancelled again: take off what this request put on, so a retry starts clean. A
          // manual discount can only be applied with no other discount active, so "all" is it.
          // Undoing this request's own apply: no `subscription_changed` for it.
          if (appliedCoupon)
            await removeDiscount(req.organization!.id, sub.id, appliedCoupon, {
              suppressSubscriptionChanged: true,
            });
          if (appliedManual)
            await removeDiscount(req.organization!.id, sub.id, undefined, {
              suppressSubscriptionChanged: true,
            });
          const invalid = result.refused.status === 400;
          return reply.code(invalid ? 400 : 402).send({
            error: {
              type: invalid ? "invalid_request_error" : "payment_error",
              code: result.refused.code,
              message: result.refused.message,
            },
          });
        }
        const view = serializeSubscription(result.subscription, business, {
          renewalSkips: await skipViewOf(req.organization!.id, result.subscription),
        });
        return reply.code(200).send(
          result.invoice
            ? {
                ...view,
                latest_invoice: {
                  id: result.invoice.publicId,
                  status: result.invoice.status,
                  total_minor: Number(result.invoice.totalMinor),
                },
                ...(result.paymentIntent
                  ? { payment_intent: serializePaymentIntent(result.paymentIntent) }
                  : {}),
                ...(result.paymentError ? { payment_error: result.paymentError } : {}),
              }
            : view,
        );
      } catch (e) {
        // A collection already in flight is EXPECTED: the claim is taken before any charge, so
        // the gateway was never contacted. The reactivation stands; 409 says retry.
        if (e instanceof CollectionDeferredError) {
          return reply.code(409).send({
            error: {
              type: "invalid_request_error",
              code: "collection_deferred",
              message: `We reactivated the subscription and raised its invoice. ${e.message}`,
            },
          });
        }
        if (e instanceof CollectionInFlightError) {
          return reply.code(409).send({
            error: {
              type: "invalid_request_error",
              code: "collection_in_flight",
              message:
                "We reactivated the subscription and raised its invoice. But a collection " +
                "for that invoice was already in progress, so this request did not charge it. " +
                "The invoice is in dunning. Retry the collection after the current attempt settles.",
            },
          });
        }
        if (e instanceof SubscriptionError) return badRequest(reply, e.message);
        if (e instanceof CouponError) return badRequest(reply, e.message);
        if (e instanceof NoChargeablePaymentMethodError) {
          return reply.code(400).send({
            error: {
              type: "payment_error",
              code: "no_chargeable_payment_method",
              message: e.message,
            },
          });
        }
        throw e;
      }
    },
  );
}
