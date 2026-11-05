import { CARD_LIMIT_CODE, CARD_LIMIT_MESSAGE } from "@/modules/invoicing/card-limit";
import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { enforceMetadataRules } from "@/modules/metadata-rules/service";
import { and, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { customerCouponCapMessage } from "@/modules/coupons/customer-cap";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { notDeleted } from "@/modules/subscriptions/deleted-sql";
import { publicId } from "@/platform/ids";
import { config } from "@/platform/config";
import { formatMoney } from "@/platform/currency";
import { gatewayDefinition } from "@/providers/gateway-catalog";
import {
  checkoutSessions,
  checkoutSessionItems,
  customers,
  businesses,
  prices,
  products,
  subscriptions,
  subscriptionItems,
  paymentMethods,
  invoices,
  transactions,
  appliedCoupons,
  coupons,
  invoiceLineItems,
  payments,
  refunds,
  paymentLinkItems,
  paymentIntents,
  gatewayAccounts,
} from "@db/schema";
import { OPEN_INVOICE_STATUSES } from "@/modules/invoicing/status";
import { getPriceByPublicId } from "@/modules/catalog/service";
import { createCustomer, getCustomerById, updateCustomer } from "@/modules/customers/service";
import { billingAddress } from "@/modules/customers/serialize";
import { archiveShippingAddress, listShippingAddresses } from "@/modules/customers/addresses";
import { vaultPaymentMethod, assignPaymentMethodRole } from "@/modules/payment-methods/service";
import {
  createSubscription,
  deleteProvisionalSubscription,
  type SubscriptionItemInput,
  type ReactivationItemInput,
  requireTerm,
} from "@/modules/subscriptions/service";
import {
  loadLiveItems,
  planItemOperations,
  applyItemOperations,
} from "@/modules/subscriptions/reconcile";
import {
  directionOfItemEdit,
  nowNotAllowedMessage,
  prorateFor,
  resolveChangePolicy,
  planMovesInEdit,
  resetTermForPolicy,
} from "@/modules/subscriptions/change-policy";
import { reactivateAndBill } from "@/modules/subscriptions/reactivate";
import {
  isBackdateAllowed,
  resolveBackdatingConfig,
} from "@/modules/subscriptions/backdating-config";
import {
  estimateChange,
  estimateNewSubscription,
  estimateReactivate,
  type CreditDestination,
} from "@/modules/subscriptions/estimate";
import { resolveDifferentialAgainstPlanTx } from "@/modules/subscriptions/items";
import { computeLineAmount, type PriceSnapshot } from "@/modules/catalog/pricing";
import {
  railsOverCeilingCap,
  resolveMandateHeadroomConfig,
  withMandateHeadroom,
} from "@/modules/payment-methods/service";
import { mandateRefusal } from "@/modules/invoicing/collection";
import {
  applyCouponToSubscription,
  customerLimitRefusal,
  couponUsableRefusal,
  findCouponByCode,
  removeDiscount,
} from "@/modules/coupons/service";
import {
  isRetentionCouponCode,
  RETENTION_COUPON_REFUSAL,
} from "@/modules/customer-portal/retention-coupon";
import { resolveStorefrontConfig } from "@/modules/checkout/storefront-config";
import { resolveAdapter } from "@/providers/registry";
import type { PaymentProvider } from "@/providers/types";
import { claimFirstCharge, releaseFirstCharge } from "@/modules/payment-intents/first-charge-claim";
import { nudgeSetupAuthRefund } from "@/modules/payment-methods/setup-auth-refund";
import { storedPayerDeclineMessage } from "@/modules/subscriptions/decline-overrides";
import {
  resolveCheckoutFieldConfig,
  type CheckoutFieldConfig,
} from "@/modules/checkout/field-config";
import {
  addressFieldLocksFor,
  withAddressFieldLocks,
} from "@/modules/checkout/address-field-rules";
import { liveTaxRegimesTx } from "@/modules/tax/service";
import {
  billSubscriptionPeriod,
  planSubscriptionPeriodInvoice,
  commitSubscriptionPeriodInvoice,
  ChargeAmountMismatchError,
  isAutoCollectOn,
  previewInvoiceFromLines,
  type InvoiceLineInput,
} from "@/modules/invoicing/service";
import {
  chargeBeforeSubscriptionInvoice,
  runChargingChosenCardOnly,
  refundPreInvoiceCharge,
  type CompletedCharge,
} from "@/modules/invoicing/collection";
import {
  applyClientResult,
  authorizeFromGateway,
  captureRefused,
  consumePaymentIntent,
  createPaymentIntent,
  getPaymentIntent,
  serializePaymentIntent,
  PaymentIntentError,
  type PaymentAttempt,
  type PaymentIntent,
} from "@/modules/payment-intents/service";
import { createManualInvoice, voidInvoice } from "@/modules/invoicing/ops";
import { getBusinessById } from "@/modules/tenancy/service";
import { emitEvent, flushDeferredEvents, type DeferredEvents } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { businessWallClock } from "@/platform/clock";
import type { CustomerAddress } from "@/modules/customers/service";
import { createLogger } from "@/platform/logger";

const log = createLogger("checkout");

/**
 * Hosted checkout (#10d). An operator (or the API) mints a short-lived,
 * price-scoped bearer token; a buyer opens /checkout/s/<token> — which moves the
 * token into an HttpOnly cookie and redirects to a clean /checkout (W1) — enters their
 * details, adds a card, and a subscription is created — all through the
 * /checkout/v1/* routes, which authenticate with THIS token only (the org API
 * key never reaches the buyer's browser).
 *
 * Mirrors the customer-portal session model (customer-portal/service.ts): the
 * token is returned once and only its SHA-256 hash is stored.
 */

/**
 * How long a checkout link stays usable (W10). Default 24h, down from 72.
 *
 * ── THE DECISION, SO IT IS NOT RE-OPENED BY ACCIDENT ────────────────────────────
 * The portal link became SHORT-LIVED AND SINGLE-USE in 0193. The obvious next question
 * was whether checkout should follow. It should not: the two links are worth different
 * things and are used differently:
 *
 *   • A PORTAL link is a session over an existing customer's whole account — invoices,
 *     payment methods, billing details. Leaked, it is account access.
 *   • A CHECKOUT link is scoped to a price and a business. Before anyone identifies
 *     themselves it grants only the ability to buy something, which costs the buyer
 *     money rather than us. Its post-identification value is the customer's own name and
 *     email, entered on that page moments earlier.
 *
 * And abandoning a checkout and coming back is ordinary, expected behaviour that is worth
 * real money. Making the link one-time would convert a recoverable abandoned cart into a
 * lost sale, to defend a credential that grants materially less than the portal's.
 *
 * So: reusable, but no longer for three days. 24h because our link is COPYABLE — an
 * operator mints one and hands it over, often by email. A buyer who was sent a link this
 * morning should still be able to use it tonight; nobody needs it next week.
 *
 * Configurable so a deployment that shares links differently can choose differently.
 */
const CHECKOUT_SESSION_TTL_MS = config.CHECKOUT_SESSION_TTL_HOURS * 3600_000;
/** How long the setup-intent webhook leaves a checkout to a buyer who may be on the page. */
const BUYER_GRACE_MS = 5_000;

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * A product shown on the business's pricing page ONLY (`metadata.pricing_page = "display_only"`):
 * a plan the business offers outside checkout, such as a free plan reached by signing up. Its
 * prices are never sold through a checkout session or a payment link.
 */
export function isDisplayOnly(metadata: unknown): boolean {
  return (metadata as { pricing_page?: unknown } | null)?.pricing_page === "display_only";
}

/** The business's plan-change rules for a change-mode session's item operations. */
async function checkoutChangePolicy(
  ctx: { organizationId: string; businessId: string },
  subscriptionId: string,
  ops: ReturnType<typeof planItemOperations>,
) {
  return withTenant(ctx.organizationId, async (tx) => {
    const [biz] = await tx.select().from(businesses).where(eq(businesses.id, ctx.businessId));
    const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId));
    if (!sub) throw new CheckoutError("This subscription no longer exists");
    const direction = await directionOfItemEdit(
      tx,
      { id: subscriptionId, businessId: ctx.businessId },
      {
        changes: ops.changes,
        adds: ops.additions.map((a) => ({ priceId: a.price.publicId, quantity: a.quantity })),
        removes: ops.removals.map((r) => r.itemPublicId),
      },
    );
    const policy = await resolveChangePolicy({
      business: biz ?? {},
      subscription: sub,
      direction,
      source: "checkout",
      tx,
    });
    const planMoves = await planMovesInEdit(tx, subscriptionId, ops.changes);
    return { direction, policy, planMoves };
  });
}

/**
 * The session's `reset_term` (stored false when not sent), else the business rule for a
 * plan change.
 */
const checkoutResetTerm = (
  ctx: { resetTerm: boolean },
  rules: Awaited<ReturnType<typeof checkoutChangePolicy>>,
) => (ctx.resetTerm ? true : resetTermForPolicy(rules.policy, rules.direction, rules.planMoves));

/** The refusal a change-mode confirm gives under the plan-change rules, or null. */
function planChangeRefusal(
  rules: Awaited<ReturnType<typeof checkoutChangePolicy>>,
): { code: string; message: string } | null {
  if (rules.policy.blocked) return rules.policy.blocked;
  if (!rules.policy.timings.includes("now"))
    return { code: "change_timing", message: nowNotAllowedMessage("checkout", rules.direction) };
  return null;
}

/** The plan-change rules for a change-mode session as it stands; throws the refusal. */
async function assertPlanChangeAllowed(ctx: CheckoutContext) {
  const target = ctx.subscriptionId;
  if (!target) throw new CheckoutError("This checkout has no target subscription");
  const live = await loadLiveItems(ctx.organizationId, target);
  const desired = await resolveContextItems(ctx);
  const ops = planItemOperations(live, desired, { replaceItemsList: ctx.replaceItemsList });
  const rules = await checkoutChangePolicy(ctx, target, ops);
  const refusal = planChangeRefusal(rules);
  if (refusal) throw new CheckoutError(refusal.message);
  return { ops, rules };
}

export class CheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutError";
  }
}

/** The gateway refused the money. Still a `CheckoutError` (a 400); counted as a failed attempt. */
export class CheckoutPaymentRefusedError extends CheckoutError {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutPaymentRefusedError";
  }
}

export interface CheckoutSessionRef {
  publicId: string;
  /** Bearer token — returned exactly once at mint time, never stored. */
  token: string;
  url?: string;
  expiresAt: Date;
}

/**
 * What completing a session does: subscribe someone new, change an existing sub, or sell
 * one-time items with no subscription (`purchase` — a paid invoice and nothing else).
 */
export type CheckoutMode = "create" | "change" | "purchase";

/** One line of a checkout session's item list (price PUBLIC id + quantity). */
export interface CheckoutItemInput {
  price: string; // price_… public id
  quantity?: number;
}

/**
 * Mint a checkout session. Runs tenant-scoped (RLS).
 *
 * Items are a list of price public ids with quantities.
 * `priceId`/`quantity` remain as single-item sugar (that's what
 * the operator dashboard's per-price "Hosted checkout" link sends).
 *
 * `mode: 'change'` (#10b) targets an EXISTING subscription (`subscriptionId`, a
 * sub_… public id) and on completion upserts the item list onto it + applies the
 * coupons. In that mode the customer is
 * pinned to the subscription's own customer AT MINT TIME, so the buyer opening
 * the link can never bind a different customer (see setCheckoutCustomer).
 *
 * Everything is validated HERE, at mint — a bogus price or coupon 404s when the
 * page is created rather than failing the buyer mid-flow. A change session may
 * carry NO items when it only applies coupons; a create session must have at
 * least one.
 */
/** The pack lines of a purchase inside `credit_config.top_up_limits`; a refusal is a CheckoutError. */
async function assertPurchaseTopUpLimits(
  organizationId: string,
  businessId: string,
  lines: ReadonlyArray<{ price: typeof prices.$inferSelect; quantity: number }>,
): Promise<void> {
  if (!lines.some((l) => l.price.grantsCredit?.kind === "pack")) return;
  const { assertTopUpLimits, TopUpLimitError } = await import("@/modules/credits/packs");
  try {
    await withTenant(organizationId, (tx) =>
      assertTopUpLimits(tx, {
        businessId,
        currency: lines[0]!.price.currency,
        lines: lines.map((l) => ({
          priceId: l.price.id,
          amountMinor: BigInt(l.price.amountMinor ?? 0) * BigInt(l.quantity),
        })),
      }),
    );
  } catch (e) {
    if (e instanceof TopUpLimitError) throw new CheckoutError(e.message);
    throw e;
  }
}

export async function createCheckoutSession(input: {
  organizationId: string;
  businessId: string;
  /** Single-item sugar; equivalent to `items: [{price: priceId, quantity}]`. */
  priceId?: string;
  quantity?: number;
  /** Full item list. Takes precedence over priceId. */
  items?: CheckoutItemInput[];
  /** Coupon codes to apply on completion. */
  coupons?: string[];
  mode?: CheckoutMode;
  /** Required when mode='change': sub_… public id of the subscription to change. */
  subscriptionId?: string;
  /**
   * mode='change'. Default false = upsert (listed items applied, unlisted left
   * alone). True declares the item list EXHAUSTIVE: unlisted
   * non-plan items are removed on completion.
   *
   * Opt-in because it is the destructive reading of the same list. A caller that
   * means "add a seat" and a caller that means "here is the buyer's whole new
   * configuration" post identical bodies; only this flag separates them.
   */
  replaceItemsList?: boolean;
  /**
   * Metadata to write onto the resulting subscription when this checkout completes —
   * Valid in BOTH modes: create-mode passes it through to the new subscription,
   * change-mode applies it to the existing one after its item operations succeed.
   *
   * Omit to say nothing about metadata. `{}` explicitly sets it to empty — the two are
   * not the same and are not collapsed anywhere along this path.
   */
  metadata?: Record<string, unknown>;
  /** mode='change' — restart the term at the change date. */
  resetTerm?: boolean;
  /** mode='change' — the target is CANCELLED and completing reactivates it. */
  reactivate?: boolean;
  /** With `reactivate`: when the new term starts. Past only, and not before the cancellation. */
  reactivateFrom?: Date;
  /** mode='change' — the session's coupons replace the subscription's rather than add. */
  replaceCouponList?: boolean;
  /** Where the hosted page sends the buyer after completing, and on cancel (http/https). */
  redirectUrl?: string;
  cancelUrl?: string;
  /** Caller context stored with the session and returned on retrieve. */
  passThruContent?: string;
  /** Create mode: details-step defaults (see `CheckoutPrefill`). */
  prefill?: CheckoutPrefill;
  /**
   * mode='purchase': a KNOWN customer (cus_… public id) buying more — an existing
   * subscriber's credit pack. Pinned at mint, exactly like a change session's customer.
   */
  customerId?: string;
  /** The payment link this session was opened from (internal id). */
  paymentLinkId?: string;
  /** API key public id that minted the session (audit trail). */
  createdBy?: string;
}): Promise<CheckoutSessionRef> {
  const mode: CheckoutMode = input.mode ?? "create";
  if (mode === "create" && input.subscriptionId) {
    throw new CheckoutError('Omit subscription when mode is "create"');
  }
  if (mode === "change" && !input.subscriptionId) {
    throw new CheckoutError('subscription is required when mode is "change"');
  }
  // Both are change-mode semantics. Silently ignoring them on a create page would let a
  // caller believe it had asked for a term reset that never happened.
  if (mode !== "change" && (input.replaceItemsList || input.resetTerm)) {
    throw new CheckoutError(
      'replace_items_list and reset_term are only valid when mode is "change"',
    );
  }
  if (mode !== "change" && (input.reactivate || input.replaceCouponList)) {
    throw new CheckoutError(
      'reactivate and replace_coupon_list are only valid when mode is "change"',
    );
  }
  if (input.reactivateFrom && !input.reactivate) {
    throw new CheckoutError("reactivate_from needs reactivate: true");
  }
  if (input.customerId && mode !== "purchase") {
    throw new CheckoutError('customer is only valid when mode is "purchase"');
  }
  if (mode === "purchase") {
    if (input.subscriptionId) throw new CheckoutError('Omit subscription when mode is "purchase"');
    // A purchase raises one invoice; nothing applies an invoice-level coupon yet.
    if ((input.coupons ?? []).length > 0)
      throw new CheckoutError("You cannot use a coupon on a one-time purchase.");
    // Metadata lands on a subscription, and a purchase creates none.
    if (input.metadata !== undefined)
      throw new CheckoutError('metadata is not valid when mode is "purchase"');
  }
  for (const [field, url] of [
    ["redirect_url", input.redirectUrl],
    ["cancel_url", input.cancelUrl],
  ] as const) {
    if (url == null) continue;
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      throw new CheckoutError(`${field} must be an http(s) URL`);
    }
  }

  // Normalize the requested lines (explicit list wins over the single-price sugar).
  const requested: CheckoutItemInput[] =
    input.items && input.items.length > 0
      ? input.items
      : input.priceId
        ? [{ price: input.priceId, quantity: input.quantity }]
        : [];
  const coupons = input.coupons ?? [];

  // An EXHAUSTIVE list of nothing would strip every add-on off the subscription. That is
  // a reachable intent, but it is far more often a caller that set the flag and forgot
  // the items — and the two are indistinguishable from here, while the outcomes differ
  // by the buyer's whole add-on set. A caller that really means it says so by listing
  // the plan alone, which is unambiguous.
  if (input.replaceItemsList && requested.length === 0) {
    throw new CheckoutError(
      "replace_items_list needs an item list. To remove every add-on, pass only the plan.",
    );
  }

  // A page that would do nothing is a caller error, not an empty checkout.
  // A reactivation of the subscription as it stood is a real page with nothing listed.
  if (requested.length === 0 && coupons.length === 0 && !input.reactivate) {
    throw new CheckoutError("A checkout session needs at least one item or coupon");
  }
  if ((mode === "create" || mode === "purchase") && requested.length === 0) {
    throw new CheckoutError(`A ${mode}-mode checkout session needs at least one item`);
  }
  // One line per price — a repeated price is a quantity, not two lines.
  const dupe = requested.map((i) => i.price).find((p, idx, all) => all.indexOf(p) !== idx);
  if (dupe)
    throw new CheckoutError(`The checkout session has the same item price two times: ${dupe}`);

  // Resolve every price up front — validated at page creation, not mid-flow.
  const resolved: Array<{ price: typeof prices.$inferSelect; quantity: number }> = [];
  for (const line of requested) {
    const price = await getPriceByPublicId(input.organizationId, input.businessId, line.price);
    if (!price) throw new CheckoutError(`No such price: ${line.price}`);
    if (line.quantity != null && (!Number.isInteger(line.quantity) || line.quantity < 1)) {
      throw new CheckoutError(`The quantity for ${line.price} must be a positive integer`);
    }
    resolved.push({ price, quantity: line.quantity ?? 1 });
  }
  // A display-only plan is never sold, however the request was made.
  if (resolved.length > 0) {
    const shown = await withTenant(input.organizationId, (tx) =>
      tx
        .select({ id: products.id, metadata: products.metadata })
        .from(products)
        .where(
          inArray(
            products.id,
            resolved.map((r) => r.price.productId),
          ),
        ),
    );
    const displayOnly = new Set(shown.filter((p) => isDisplayOnly(p.metadata)).map((p) => p.id));
    const hit = resolved.find((r) => displayOnly.has(r.price.productId));
    if (hit)
      throw new CheckoutError(
        `${hit.price.publicId} is shown on the pricing page only. It cannot be sold through checkout.`,
      );
  }
  // A purchase sells one-time items only: a recurring price needs a subscription to bill it.
  if (mode === "purchase") {
    const kinds = await withTenant(input.organizationId, (tx) =>
      tx
        .select({ id: products.id, kind: products.kind })
        .from(products)
        .where(
          inArray(
            products.id,
            resolved.map((r) => r.price.productId),
          ),
        ),
    );
    const kindOf = new Map(kinds.map((k) => [k.id, k.kind]));
    for (const { price } of resolved) {
      if (price.type !== "one_time" || kindOf.get(price.productId) === "plan") {
        throw new CheckoutError(
          `${price.publicId} is not a one-time price. A purchase sells one-time prices only.`,
        );
      }
    }
  }
  // Credit packs stay inside the business's top-up limits (design G3 §3.6), at mint and complete.
  if (mode === "purchase")
    await assertPurchaseTopUpLimits(input.organizationId, input.businessId, resolved);
  // All lines must share one currency (the engine requires it of a subscription).
  const currencies = [...new Set(resolved.map((r) => r.price.currency))];
  if (currencies.length > 1) {
    throw new CheckoutError(
      `All checkout items must use one currency. The items use: ${currencies.join(", ")}.`,
    );
  }
  const itemCurrency = currencies[0] ?? null;

  // mode='change': resolve + validate the target, and pin its customer now.
  let targetSubId: string | null = null;
  let pinnedCustomerId: string | null = null;
  let targetCurrency: string | null = null;
  let targetMetadata: Record<string, unknown> | null = null;
  if (mode === "change") {
    const target = await withTenant(input.organizationId, async (tx) => {
      const [sub] = await tx
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.publicId, input.subscriptionId!),
            eq(subscriptions.businessId, input.businessId),
            notDeleted(),
          ),
        )
        .limit(1);
      return sub ?? null;
    });
    if (!target) throw new CheckoutError(`No such subscription: ${input.subscriptionId}`);
    // A cancelled subscription can only be reactivated, and only a cancelled one can be —
    // refused at mint rather than handing the buyer a link that must fail.
    if (target.status === "cancelled" && !input.reactivate) {
      throw new CheckoutError(
        "This subscription is cancelled. To reactivate it through checkout, pass reactivate: true.",
      );
    }
    if (input.reactivate && target.status !== "cancelled") {
      throw new CheckoutError(
        `reactivate applies only to a cancelled subscription. This subscription is ${target.status}.`,
      );
    }
    if (input.reactivateFrom) {
      const [biz] = await withTenant(input.organizationId, (tx) =>
        tx.select().from(businesses).where(eq(businesses.id, input.businessId)).limit(1),
      );
      const now = await businessWallClock(input.businessId);
      if (input.reactivateFrom > now) {
        throw new CheckoutError("reactivate_from cannot be in the future");
      }
      if (target.canceledAt && input.reactivateFrom < target.canceledAt) {
        throw new CheckoutError("reactivate_from cannot be before the subscription was cancelled");
      }
      // A backdated term is billed now, for a period that has partly passed.
      const verdict = isBackdateAllowed({
        config: resolveBackdatingConfig(biz),
        action: "reactivate",
        target: input.reactivateFrom,
        now,
        businessTimezone: biz?.timezone ?? null,
        raisesPastDatedInvoice: true,
      });
      if (!verdict.allowed) throw new CheckoutError(verdict.message);
    }
    if (itemCurrency && target.currency !== itemCurrency) {
      throw new CheckoutError(
        `You cannot change subscription ${input.subscriptionId} (${target.currency}) to a ${itemCurrency} price`,
      );
    }
    targetSubId = target.id;
    pinnedCustomerId = target.customerId;
    targetCurrency = target.currency;
    targetMetadata = (target.metadata as Record<string, unknown> | null) ?? null;
  }

  if (mode === "purchase" && input.customerId) {
    const [cus] = await withTenant(input.organizationId, (tx) =>
      tx
        .select({ id: customers.id })
        .from(customers)
        .where(
          and(
            eq(customers.publicId, input.customerId!),
            eq(customers.businessId, input.businessId),
          ),
        )
        .limit(1),
    );
    if (!cus) throw new CheckoutError(`No such customer: ${input.customerId}`);
    pinnedCustomerId = cus.id;
  }

  const effectiveCurrency = targetCurrency ?? itemCurrency;
  for (const code of coupons) {
    await assertCouponUsableAtCheckout({
      organizationId: input.organizationId,
      businessId: input.businessId,
      code,
      currency: effectiveCurrency,
      customerId: pinnedCustomerId,
    });
  }

  const token = `cstk_${randomBytes(32).toString("base64url")}`;
  const cosessId = publicId("cosess");
  const expiresAt = new Date(Date.now() + CHECKOUT_SESSION_TTL_MS);
  await withTenant(input.organizationId, async (tx) => {
    // Checked when the operator mints the link, since the buyer cannot fix it at completion.
    // Types only: the buyer's signup cannot supply required keys, and strict is the API's.
    await enforceMetadataRules(tx, input.businessId, "subscription", input.metadata, {
      mode: mode === "change" ? "update" : "create",
      existing: targetMetadata,
      scope: "supplied_only",
    });
    const [session] = await tx
      .insert(checkoutSessions)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        mode,
        couponCodes: coupons,
        subscriptionId: targetSubId,
        replaceItemsList: input.replaceItemsList ?? false,
        resetTerm: input.resetTerm ?? false,
        reactivate: input.reactivate ?? false,
        reactivateFrom: input.reactivateFrom ?? null,
        replaceCouponList: input.replaceCouponList ?? false,
        redirectUrl: input.redirectUrl ?? null,
        cancelUrl: input.cancelUrl ?? null,
        passThruContent: input.passThruContent ?? null,
        prefill: input.prefill ?? null,
        // `?? null` rather than a spread-if-present: absent must persist as SQL NULL
        // ("no opinion"), which is what the completion path checks to decide whether to
        // touch the subscription's metadata at all.
        metadata: input.metadata ?? null,
        // Pinned up-front in change mode; the buyer never gets to choose it.
        resultingCustomerId: pinnedCustomerId,
        customerPinned: pinnedCustomerId != null,
        paymentLinkId: input.paymentLinkId ?? null,
        publicId: cosessId,
        tokenHash: tokenHash(token),
        createdBy: input.createdBy ?? null,
        expiresAt,
      })
      .returning({ id: checkoutSessions.id });
    if (resolved.length > 0) {
      await tx.insert(checkoutSessionItems).values(
        resolved.map((r, position) => ({
          organizationId: input.organizationId,
          businessId: input.businessId,
          checkoutSessionId: session!.id,
          priceId: r.price.id,
          quantity: r.quantity,
          position,
        })),
      );
    }
  });
  const base = config.PORTAL_BASE_URL?.replace(/\/$/, "");
  return {
    publicId: cosessId,
    token,
    // The EXCHANGE route (W1), not the checkout page — see the note on the portal's
    // equivalent in customer-portal/service.ts.
    ...(base ? { url: `${base}/checkout/s/${token}` } : {}),
    expiresAt,
  };
}

/** A session as the operator API retrieves it — ids public, no token (it is never stored). */
export interface CheckoutSessionRecord {
  id: string;
  mode: CheckoutMode;
  /** `open` · `completing` · `completed`, or `revoked` / `expired` when either applies. */
  status: string;
  subscription: string | null;
  resultingSubscription: string | null;
  customer: string | null;
  /** mode='purchase': the invoice the purchase raised (inv_…). */
  invoice: string | null;
  items: Array<{ price: string; quantity: number }>;
  coupons: string[];
  replaceItemsList: boolean;
  replaceCouponList: boolean;
  resetTerm: boolean;
  reactivate: boolean;
  reactivateFrom: Date | null;
  redirectUrl: string | null;
  cancelUrl: string | null;
  passThruContent: string | null;
  metadata: Record<string, unknown> | null;
  prefill: CheckoutPrefill | null;
  createdAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
  revokedAt: Date | null;
}

/** Retrieve one of this business's sessions by `cosess_…` id, or null. */
export async function getCheckoutSession(input: {
  organizationId: string;
  businessId: string;
  sessionPublicId: string;
}): Promise<CheckoutSessionRecord | null> {
  return withTenant(input.organizationId, async (tx) => {
    const [s] = await tx
      .select()
      .from(checkoutSessions)
      .where(
        and(
          eq(checkoutSessions.publicId, input.sessionPublicId),
          eq(checkoutSessions.businessId, input.businessId),
        ),
      )
      .limit(1);
    if (!s) return null;
    const items = await tx
      .select({ price: prices.publicId, quantity: checkoutSessionItems.quantity })
      .from(checkoutSessionItems)
      .innerJoin(prices, eq(prices.id, checkoutSessionItems.priceId))
      .where(eq(checkoutSessionItems.checkoutSessionId, s.id))
      .orderBy(checkoutSessionItems.position);
    const subIds = [s.subscriptionId, s.resultingSubscriptionId].filter((v): v is string => !!v);
    const subs = subIds.length
      ? await tx
          .select({ id: subscriptions.id, publicId: subscriptions.publicId })
          .from(subscriptions)
          .where(inArray(subscriptions.id, subIds))
      : [];
    const subPublic = (id: string | null) => subs.find((r) => r.id === id)?.publicId ?? null;
    const [cus] = s.resultingCustomerId
      ? await tx
          .select({ publicId: customers.publicId })
          .from(customers)
          .where(eq(customers.id, s.resultingCustomerId))
          .limit(1)
      : [];
    const [inv] = s.resultingInvoiceId
      ? await tx
          .select({ publicId: invoices.publicId })
          .from(invoices)
          .where(eq(invoices.id, s.resultingInvoiceId))
          .limit(1)
      : [];
    const status = s.revokedAt
      ? "revoked"
      : s.status !== "completed" && s.expiresAt < new Date()
        ? "expired"
        : s.status;
    return {
      id: s.publicId,
      mode: (s.mode === "change" || s.mode === "purchase" ? s.mode : "create") as CheckoutMode,
      status,
      subscription: subPublic(s.subscriptionId),
      resultingSubscription: subPublic(s.resultingSubscriptionId),
      customer: cus?.publicId ?? null,
      invoice: inv?.publicId ?? null,
      items,
      coupons: s.couponCodes ?? [],
      replaceItemsList: s.replaceItemsList,
      replaceCouponList: s.replaceCouponList,
      resetTerm: s.resetTerm,
      reactivate: s.reactivate,
      reactivateFrom: s.reactivateFrom,
      redirectUrl: s.redirectUrl,
      cancelUrl: s.cancelUrl,
      passThruContent: s.passThruContent,
      metadata: (s.metadata as Record<string, unknown> | null) ?? null,
      prefill: (s.prefill as CheckoutPrefill | null) ?? null,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      completedAt: s.completedAt,
      revokedAt: s.revokedAt,
    };
  });
}

/** What a revoke reports back: enough to render the outcome, no credential. */
export interface RevokedCheckoutSession {
  publicId: string;
  /** Untouched by revocation — `revoked_at` is orthogonal to the lifecycle status. */
  status: string;
  revokedAt: Date;
}

/**
 * Kill a checkout link (W-revoke). Runs tenant-scoped (RLS).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
 * `revoked_at` has been on this table — and honoured by `resolveCheckoutSession` —
 * since the column was added, with NOTHING in the product writing it. That is two
 * problems in one: an operator whose checkout link has leaked had no lever at all, and
 * a guard no code path exercises is a guard nobody would notice breaking. This is the
 * writer; `verify:checkout` is the exercise.
 *
 * A hosted checkout link is PUBLIC by construction — minted by an operator, mailed to a
 * buyer, forwarded, and then sitting in an inbox for the rest of
 * `CHECKOUT_SESSION_TTL_HOURS`. Waiting out the TTL is not a remedy.
 *
 * ── REVOKED IS NOT SPENT ───────────────────────────────────────────────────────
 * Deliberately independent of `status`, and of the `isSpent` 409 gate on the buyer
 * surface (checkout-routes.ts):
 *
 *  - `isSpent` refuses the MUTATING buyer routes on a `completed` session (409) while
 *    keeping `/session` and `/invoice` answering, because the hosted page has to be able
 *    to read "this checkout is already complete" and poll the invoice it just paid.
 *  - Revocation is upstream of all of that: the resolver returns null, so
 *    `authenticateCheckout` never authenticates the request at all and EVERY route —
 *    readable ones included — answers 401.
 *
 * So a COMPLETED session is revocable on purpose, and that is the most valuable case:
 * completed sessions stay resolvable so `/complete` can replay its stored result
 * idempotently, which is precisely the reach that had to be taken away from a leaked
 * spent link. Revoking ends the replay too.
 *
 * Idempotent, like `revokeApiKey`: revoking an already-revoked session reports the SAME
 * success with the ORIGINAL timestamp (a second call must not move the moment the link
 * died), and only a session that isn't in this business answers null → the route's 404.
 * A session from another organization is invisible under `withTenant`, so it takes the
 * same null path as an unknown id — an operator learns nothing about another tenant's ids.
 */
export async function revokeCheckoutSession(input: {
  organizationId: string;
  businessId: string;
  /** `cosess_…` public id. */
  sessionPublicId: string;
}): Promise<RevokedCheckoutSession | null> {
  const now = new Date();
  const cols = {
    publicId: checkoutSessions.publicId,
    status: checkoutSessions.status,
    revokedAt: checkoutSessions.revokedAt,
  };
  // Scoped by BUSINESS as well as by the RLS org: `checkout_sessions` belongs to one
  // business's catalog, and the operator reached this through that business's path.
  const scope = and(
    eq(checkoutSessions.publicId, input.sessionPublicId),
    eq(checkoutSessions.businessId, input.businessId),
  );
  const [revoked] = await withTenant(input.organizationId, (tx) =>
    tx
      .update(checkoutSessions)
      // No `bump_row_version` trigger on this table — the service stamps `updated_at`
      // itself, as `resolveCheckoutSession` does for `last_used_at`.
      .set({ revokedAt: now, updatedAt: now })
      .where(and(scope, isNull(checkoutSessions.revokedAt)))
      .returning(cols),
  );
  if (revoked?.revokedAt) {
    // A credential going away explains every 401 that follows it.
    log.warn("checkout session revoked — its link is dead", {
      event: "checkout_session_revoked",
      session: revoked.publicId,
      status: revoked.status,
      organizationId: input.organizationId,
    });
    return { publicId: revoked.publicId, status: revoked.status, revokedAt: revoked.revokedAt };
  }
  // Nothing updated: either already revoked (report it unchanged) or not ours (null).
  const [existing] = await withTenant(input.organizationId, (tx) =>
    tx.select(cols).from(checkoutSessions).where(scope).limit(1),
  );
  if (!existing) return null;
  // `revoked_at` is never cleared anywhere, so a row the guarded UPDATE missed is by
  // definition already revoked; the `?? now` only satisfies the column's nullability.
  return {
    publicId: existing.publicId,
    status: existing.status,
    revokedAt: existing.revokedAt ?? now,
  };
}

/** A resolved session line: internal price id + quantity, in operator order. */
/**
 * Can this coupon be put on a checkout page at all? An unknown coupon 404s at mint, and
 * this is now shared with the BUYER-facing route so a code the merchant
 * could not have attached is refused with the same words when a buyer types it.
 *
 * Read-only on purpose: `findCouponByCode` never CLAIMS a single-use coupon-set code, which
 * is why `applyCouponToSubscription` cannot be used to pre-check — it would burn the code on
 * a page the buyer may abandon. The claim happens on completion.
 *
 * Validity (`couponUsableRefusal`: active, valid-from, redeem-by, max redemptions) is checked
 * on the business clock, and the per-customer cap whenever the page knows its payer. CAT-2
 * item constraints are enforced where the discount is applied; completion re-runs all of it.
 */
export async function assertCouponUsableAtCheckout(input: {
  organizationId: string;
  businessId: string;
  code: string;
  /** What this checkout will bill in, when known — a fixed coupon must match it. */
  currency?: string | null;
  /** The payer, when the page already has one — a code they have used up is refused. */
  customerId?: string | null;
}): Promise<void> {
  const coupon = await findCouponByCode({
    organizationId: input.organizationId,
    businessId: input.businessId,
    code: input.code,
  });
  if (!coupon) throw new CheckoutError(`No such coupon: ${input.code}`);
  // Only the cancel flow's accepted offer applies the retention coupon.
  if (await isRetentionCouponCode(input)) throw new CheckoutError(RETENTION_COUPON_REFUSAL);
  const unusable = couponUsableRefusal(coupon, await businessWallClock(input.businessId));
  if (unusable) throw new CheckoutError(unusable);
  // A fixed-amount coupon is denominated, so it must match what we'll bill in.
  if (
    coupon.kind === "fixed_amount" &&
    coupon.currency &&
    input.currency &&
    coupon.currency !== input.currency
  ) {
    throw new CheckoutError(
      `Coupon ${input.code} is ${coupon.currency} but this checkout bills in ${input.currency}`,
    );
  }
  // A new-customer page has no payer yet, so nothing to count; completion's apply checks.
  if (input.customerId) {
    const refusal = await withTenant(input.organizationId, (tx) =>
      customerLimitRefusal(tx, coupon, input.customerId!),
    );
    if (refusal) throw new CheckoutError(refusal);
  }
}

export interface CheckoutContextItem {
  priceId: string; // internal price id
  quantity: number;
}

export interface CheckoutContext {
  sessionId: string;
  sessionPublicId: string;
  organizationId: string;
  businessId: string;
  mode: CheckoutMode;
  /** The session's items, in the order the operator specified. May be empty
   *  in change mode (a coupon-only page is valid). */
  items: CheckoutContextItem[];
  couponCodes: string[];
  /** The codes in `couponCodes` the buyer entered on the page (0495). */
  customerCouponCodes: string[];
  /** mode='change': internal id of the subscription being changed. */
  subscriptionId: string | null;
  /** mode='change': the item list is exhaustive — remove unlisted non-plan items. */
  replaceItemsList: boolean;
  /** mode='change': restart the billing term at the change date. */
  resetTerm: boolean;
  /** mode='change' on a cancelled subscription: completing reactivates it. */
  reactivate: boolean;
  /** When the reactivated term starts; null = at completion. */
  reactivateFrom: Date | null;
  /** mode='change': the session's coupons replace the subscription's. */
  replaceCouponList: boolean;
  /** Where the hosted page sends the buyer after completing, and on cancel. */
  redirectUrl: string | null;
  cancelUrl: string | null;
  /**
   * Metadata to write onto the resulting subscription on completion, or null when this
   * session has no opinion. Null and `{}` mean different things — see the column comment.
   */
  metadata: Record<string, unknown> | null;
  /** Create mode: details-step defaults set at mint, or null. */
  prefill?: CheckoutPrefill | null;
  status: string;
  resultingCustomerId: string | null;
  resultingSubscriptionId: string | null;
  /** mode='purchase': the invoice raised for this purchase, while it is being paid or once paid. */
  resultingInvoiceId: string | null;
  /** The customer was fixed at mint (change mode, or a purchase for a known customer). */
  customerPinned: boolean;
  /** The payment link this session was opened from: it sets what the buyer may change (E3). */
  paymentLinkId: string | null;
}

/**
 * Details-step defaults an operator sets at mint. Shown on the page as editable values
 * until the buyer submits; the buyer's submit is the only thing that writes a customer.
 */
export interface CheckoutPrefill {
  email?: string;
  tax_registration_number?: string;
  /** Same snake_case keys as the view's `customer.address`. */
  address?: Record<string, string>;
}

/**
 * Resolve a checkout token → context, or null. Like API-key / portal-token
 * resolution this spans organizations, so it uses `systemDb` (the org isn't
 * known until the token is found); everything downstream goes through
 * withTenant.
 *
 * Rejects an expired or revoked session. A **completed** session deliberately still
 * resolves: `/complete` has to be able to replay its stored result idempotently, which is
 * the whole reason the completed state is readable at all. The mutating buyer routes gate
 * on `isSpent` instead (409), and revocation — which IS refused here — is what ends the
 * replay on a leaked spent link.
 */
export async function resolveCheckoutSession(token: string): Promise<CheckoutContext | null> {
  if (!token.startsWith("cstk_")) return null;
  const [s] = await systemDb
    .select()
    .from(checkoutSessions)
    .where(
      and(
        // The link's own token, or the one a reminder email carried (E6).
        or(
          eq(checkoutSessions.tokenHash, tokenHash(token)),
          eq(checkoutSessions.resumeTokenHash, tokenHash(token)),
        ),
        gt(checkoutSessions.expiresAt, new Date()),
        isNull(checkoutSessions.revokedAt),
      ),
    )
    .limit(1);
  if (!s) return null;
  // Touch last_used_at (no bump_row_version trigger — the service stamps updated_at).
  await systemDb
    .update(checkoutSessions)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(checkoutSessions.id, s.id));
  // Same base-`db` reasoning as above: the org isn't established until the token
  // resolves, so the item read can't go through withTenant yet. Scoped by the
  // session id, which is itself only reachable via the (hashed) token.
  const itemRows = await systemDb
    .select({ priceId: checkoutSessionItems.priceId, quantity: checkoutSessionItems.quantity })
    .from(checkoutSessionItems)
    .where(eq(checkoutSessionItems.checkoutSessionId, s.id))
    .orderBy(checkoutSessionItems.position);
  return contextFromSessionRow(s, itemRows);
}

/**
 * The context a session row denotes, without a token.
 *
 * Split out of `resolveCheckoutSession` for the WEBHOOK path: `completeCheckoutForSetupIntent`
 * reaches a session by the setup intent it began, not by a bearer token, and re-deriving this
 * shape there would be a second definition of what a checkout session means.
 */
function contextFromSessionRow(
  s: typeof checkoutSessions.$inferSelect,
  itemRows: Array<{ priceId: string; quantity: number }>,
): CheckoutContext {
  return {
    sessionId: s.id,
    sessionPublicId: s.publicId,
    organizationId: s.organizationId,
    businessId: s.businessId,
    mode: (s.mode === "change" || s.mode === "purchase" ? s.mode : "create") as CheckoutMode,
    items: itemRows.map((r) => ({ priceId: r.priceId, quantity: r.quantity })),
    replaceItemsList: s.replaceItemsList,
    resetTerm: s.resetTerm,
    reactivate: s.reactivate,
    reactivateFrom: s.reactivateFrom,
    replaceCouponList: s.replaceCouponList,
    redirectUrl: s.redirectUrl,
    cancelUrl: s.cancelUrl,
    metadata: (s.metadata as Record<string, unknown> | null) ?? null,
    prefill: (s.prefill as CheckoutPrefill | null) ?? null,
    couponCodes: s.couponCodes ?? [],
    customerCouponCodes: s.customerCouponCodes ?? [],
    subscriptionId: s.subscriptionId,
    status: s.status,
    resultingCustomerId: s.resultingCustomerId,
    resultingSubscriptionId: s.resultingSubscriptionId,
    resultingInvoiceId: s.resultingInvoiceId,
    customerPinned: s.mode === "change" || s.customerPinned,
    paymentLinkId: s.paymentLinkId,
  };
}

/** Remember which setup intent this session is waiting on (see the column's own note). */
export async function recordCheckoutSetupIntent(
  ctx: CheckoutContext,
  intentPublicId: string,
): Promise<void> {
  await withTenant(ctx.organizationId, (tx) =>
    tx
      .update(checkoutSessions)
      .set({ setupPaymentIntent: intentPublicId, updatedAt: new Date() })
      .where(eq(checkoutSessions.id, ctx.sessionId)),
  );
}

/** Stamp the first time the buyer reached the payment step — the funnel's third step. */
export async function markCheckoutPaymentStarted(ctx: CheckoutContext): Promise<void> {
  await withTenant(ctx.organizationId, (tx) =>
    tx
      .update(checkoutSessions)
      .set({ paymentStartedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(checkoutSessions.id, ctx.sessionId), isNull(checkoutSessions.paymentStartedAt)),
      ),
  );
}

export interface CheckoutConsentAnswer {
  recurring?: boolean;
  /** The sentence the page showed. When sent, it must equal the current sentence. */
  recurring_text?: string;
  terms?: boolean;
  marketing?: boolean;
}

export interface CheckoutConsentRecord {
  recurringText: string | null;
  termsAccepted: boolean;
  /** Null when the page did not offer the opt-in. */
  marketing: boolean | null;
}

/**
 * Check the buyer's answers against what the page asks for, from the same view the page
 * rendered, and return what to record. Refuses a missing required box.
 */
export async function resolveCheckoutConsent(
  ctx: CheckoutContext,
  answer: CheckoutConsentAnswer | undefined,
): Promise<CheckoutConsentRecord> {
  const consent = (await getCheckoutView(ctx))?.consent;
  if (!consent) return { recurringText: null, termsAccepted: false, marketing: null };
  if (consent.recurring_text && answer?.recurring !== true)
    throw new CheckoutError("Select the box to agree to the recurring charge.");
  // The record must be the sentence the buyer read: a price or tax change since the page
  // loaded makes them read and agree again.
  if (
    consent.recurring_text &&
    answer?.recurring_text !== undefined &&
    answer.recurring_text !== consent.recurring_text
  )
    // The storefront matches this text (usePaymentChallenge); reword both together.
    throw new CheckoutError(
      "The amount changed after you agreed. Read the new amount and select the box again.",
    );
  if (consent.terms_required && answer?.terms !== true)
    throw new CheckoutError("Select the box to accept the terms.");
  return {
    recurringText: consent.recurring_text,
    termsAccepted: consent.terms_required && answer?.terms === true,
    marketing: consent.marketing_offered ? answer?.marketing === true : null,
  };
}

/**
 * Keep the answers sent with `/setup`, checked, for a checkout the webhook completes. Null
 * clears an earlier call's answers. Throws `CheckoutError` on a missing required box.
 */
export async function recordCheckoutSetupConsent(
  ctx: CheckoutContext,
  answer: CheckoutConsentAnswer | undefined,
  ip: string | null,
): Promise<void> {
  if (answer) await resolveCheckoutConsent(ctx, answer);
  await withTenant(ctx.organizationId, (tx) =>
    tx
      .update(checkoutSessions)
      .set({
        setupConsent: answer ? { answer, ip, at: new Date().toISOString() } : null,
        updatedAt: new Date(),
      })
      .where(eq(checkoutSessions.id, ctx.sessionId)),
  );
}

/** Record the consent of a completed checkout: on the session, and the opt-in on the customer. */
export async function recordCheckoutConsent(
  ctx: CheckoutContext,
  record: CheckoutConsentRecord,
  ip: string | null,
  /** When the buyer agreed, if earlier than now (consent sent with `/setup`). */
  at?: Date,
): Promise<void> {
  const now = at ?? new Date();
  const agreed = record.recurringText !== null || record.termsAccepted;
  await withTenant(ctx.organizationId, async (tx) => {
    if (agreed)
      await tx
        .update(checkoutSessions)
        .set({
          recurringConsentText: record.recurringText,
          consentedAt: now,
          termsAcceptedAt: record.termsAccepted ? now : null,
          consentIp: ip,
          updatedAt: now,
        })
        .where(eq(checkoutSessions.id, ctx.sessionId));
    const [row] = await tx
      .select({ customerId: checkoutSessions.resultingCustomerId })
      .from(checkoutSessions)
      .where(eq(checkoutSessions.id, ctx.sessionId));
    if (record.marketing !== null && row?.customerId)
      await tx
        .update(customers)
        .set({ marketingOptIn: record.marketing, marketingOptInAt: now, updatedAt: now })
        .where(eq(customers.id, row.customerId));
  });
}

export type CheckoutLayout = "steps" | "one_page";
export type CheckoutDeviceClass = "mobile" | "tablet" | "desktop";

/**
 * The page was shown. Stamps the first view, and the layout and device of that first view —
 * a buyer who opens the link on a phone and pays on a laptop counts as a phone visit.
 */
export async function markCheckoutViewed(
  ctx: CheckoutContext,
  seen: { layout: CheckoutLayout; deviceClass: CheckoutDeviceClass },
): Promise<void> {
  const now = new Date();
  await withTenant(ctx.organizationId, (tx) =>
    tx
      .update(checkoutSessions)
      .set({
        firstViewedAt: now,
        layout: seen.layout,
        deviceClass: seen.deviceClass,
        updatedAt: now,
      })
      .where(and(eq(checkoutSessions.id, ctx.sessionId), isNull(checkoutSessions.firstViewedAt))),
  );
}

/** The buyer sent their details for the first time. */
export async function markCheckoutDetailsSubmitted(ctx: CheckoutContext): Promise<void> {
  const now = new Date();
  await withTenant(ctx.organizationId, (tx) =>
    tx
      .update(checkoutSessions)
      .set({ detailsSubmittedAt: now, updatedAt: now })
      .where(
        and(eq(checkoutSessions.id, ctx.sessionId), isNull(checkoutSessions.detailsSubmittedAt)),
      ),
  );
}

/**
 * Count one completion attempt. `failure` is set when the attempt ended without the money
 * (a decline, a refused card, a payment left unpaid); a challenge the buyer still has to
 * answer is neither a success nor a failure, so the caller does not record it.
 */
export async function recordCheckoutPaymentAttempt(
  ctx: CheckoutContext,
  failure: string | null,
): Promise<void> {
  const now = new Date();
  await withTenant(ctx.organizationId, (tx) =>
    tx
      .update(checkoutSessions)
      .set({
        paymentAttemptCount: sql`${checkoutSessions.paymentAttemptCount} + 1`,
        ...(failure !== null
          ? {
              paymentFailureCount: sql`${checkoutSessions.paymentFailureCount} + 1`,
              lastPaymentFailure: failure.slice(0, 500),
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(checkoutSessions.id, ctx.sessionId)),
  );
}

/**
 * Finish a checkout whose buyer is never coming back.
 *
 * Called by `harvestSetupIntent` (webhooks/inbound.ts) once the gateway's own event has been
 * turned into a vaulted instrument. The rail that needs it is the netbanking e-mandate:
 * RazorPay's `subscription_registration/auth_links` ignores `callback_url`, so the payer ends
 * on RazorPay's "MANDATE REGISTRATION COMPLETED" screen and `/checkout/v1/complete` is never
 * posted. Before this, that buyer authorised an auto-debit and got **no subscription** — the
 * mandate was vaulted, the session sat open until it expired, and nothing said so.
 *
 * Safe against the buyer who DOES come back: `completeCheckout` claims the session with an
 * atomic `open → completing` compare-and-set and replays a completed one, so whichever of the
 * two arrives second is a no-op rather than a second subscription. That is the same guard the
 * browser and the webhook already contend on for the instrument itself.
 *
 * Never throws. A webhook that errors makes the gateway redeliver the whole event, which would
 * re-run the vault half; a checkout that legitimately refuses (a declined first charge, a
 * coupon that expired meanwhile) must not cause that. The outcome is logged either way.
 */
export async function completeCheckoutForSetupIntent(input: {
  organizationId: string;
  businessId: string;
  intentPublicId: string;
  paymentMethodId: string;
}): Promise<"completed" | "skipped" | "failed"> {
  const [s] = await withTenant(input.organizationId, (tx) =>
    tx
      .select()
      .from(checkoutSessions)
      .where(
        and(
          eq(checkoutSessions.businessId, input.businessId),
          eq(checkoutSessions.setupPaymentIntent, input.intentPublicId),
        ),
      )
      .limit(1),
  );
  if (!s) return "skipped";
  // Only a session still waiting. `completing` means a browser is mid-flight and holds the
  // claim; `completed`/`expired` are done with. Checked before the work rather than relying on
  // the CAS alone, so the ordinary case logs as `skipped` instead of an exception.
  if (s.status !== "open") return "skipped";
  if (s.expiresAt <= new Date() || s.revokedAt) return "skipped";
  // A buyer still on the page posts /complete right after this harvest. Let them claim
  // first: only their request can show a 3DS challenge, and the loser of the claim is
  // refused. Any change to the session means the buyer is active, so leave it to them.
  for (const until = Date.now() + BUYER_GRACE_MS; Date.now() < until;) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const [now] = await withTenant(input.organizationId, (tx) =>
      tx
        .select({ status: checkoutSessions.status, updatedAt: checkoutSessions.updatedAt })
        .from(checkoutSessions)
        .where(eq(checkoutSessions.id, s.id))
        .limit(1),
    );
    if (now?.status !== "open" || now.updatedAt.getTime() !== s.updatedAt.getTime())
      return "skipped";
  }

  const itemRows = await withTenant(input.organizationId, (tx) =>
    tx
      .select({ priceId: checkoutSessionItems.priceId, quantity: checkoutSessionItems.quantity })
      .from(checkoutSessionItems)
      .where(eq(checkoutSessionItems.checkoutSessionId, s.id))
      .orderBy(checkoutSessionItems.position),
  );
  const ctx = contextFromSessionRow(s, itemRows);
  // The same consent check `/complete` runs, on the answers the buyer sent with `/setup`.
  let consent: CheckoutConsentRecord;
  try {
    consent = await resolveCheckoutConsent(ctx, s.setupConsent?.answer);
  } catch (e) {
    log.warn("checkout not completed from its setup intent: no consent", {
      event: "checkout_webhook_consent_missing",
      session: s.publicId,
      intent: input.intentPublicId,
      error: (e as Error)?.message,
    });
    return "failed";
  }
  try {
    const result = await completeCheckout(ctx, { paymentMethodId: input.paymentMethodId });
    if (s.setupConsent)
      await recordCheckoutConsent(ctx, consent, s.setupConsent.ip, new Date(s.setupConsent.at));
    log.log("checkout completed from its setup intent — the buyer never came back", {
      event: "checkout_completed_by_webhook",
      session: s.publicId,
      intent: input.intentPublicId,
      subscription: result.subscriptionId,
      // The change applied but its invoice did not collect — the same thing the buyer's own
      // completion reports on screen. Recorded here because on this path nobody is watching.
      unpaidInvoice: result.unpaidInvoice?.id ?? null,
    });
    return "completed";
  } catch (e) {
    log.warn("checkout could not be completed from its setup intent", {
      event: "checkout_webhook_completion_failed",
      session: s.publicId,
      intent: input.intentPublicId,
      error: (e as Error)?.message,
    });
    return "failed";
  }
}

/** Resolve a context's item lines to full price rows + product kind. */
async function resolveContextItems(
  ctx: CheckoutContext,
): Promise<
  Array<{ price: typeof prices.$inferSelect; quantity: number; kind: string; productName: string }>
> {
  return withTenant(ctx.organizationId, async (tx) => {
    const out: Array<{
      price: typeof prices.$inferSelect;
      quantity: number;
      kind: string;
      productName: string;
    }> = [];
    for (const line of ctx.items) {
      const [row] = await tx
        .select({
          price: prices,
          kind: products.kind,
          productName: sql<string>`coalesce(${products.externalName}, ${products.name})`,
        })
        .from(prices)
        .innerJoin(products, eq(products.id, prices.productId))
        .where(eq(prices.id, line.priceId))
        .limit(1);
      if (!row) throw new CheckoutError("A price on this checkout no longer exists");
      out.push({
        price: row.price,
        quantity: line.quantity,
        kind: row.kind,
        productName: row.productName,
      });
    }
    return out;
  });
}

/**
 * A short human-readable summary of a price's amount (e.g. "$50.00 / month").
 *
 * `effectiveAmountMinor` overrides the catalog figure, and must be passed for any
 * DIFFERENTIAL add-on. A differential price carries `amount_minor = 0` in the catalog and
 * gets its real rate per plan+currency+interval (CAT-7), so reading the column rendered
 * **₹0.00 / month** for an add-on the very next panel priced at ₹3,760 — the buyer was
 * shown a free item and then billed for it.
 */
function priceAmountSummary(
  price: typeof prices.$inferSelect,
  effectiveAmountMinor?: bigint | null,
): string {
  const effective = effectiveAmountMinor ?? price.amountMinor;
  return amountSummary({
    model: price.model,
    type: price.type,
    currency: price.currency,
    amountMinor: effective != null ? Number(effective) : null,
    interval: price.interval,
    intervalCount: price.intervalCount,
    percentageBps: price.percentageBps,
  });
}

/**
 * The rate an item on a LIVE subscription is actually billed at.
 *
 * `subscription_items.price_snapshot` is the immutable rating record frozen at
 * create/change (db/schema/subscriptions.ts) — billing rates from it, so editing a catalog
 * price never re-rates a live subscription. Reading the catalog instead quotes a price the
 * customer is not paying, right beside a credit computed from the invoice lines that DID use
 * the snapshot: two numbers, two sources, one card that cannot be made to reconcile.
 *
 * The whole snapshot is rendered, not just its amount, because `alignSnapshotToCycle` may
 * have re-expressed the item on the SUBSCRIPTION's cadence (a ₹475/month add-on on a yearly
 * plan is stored as ₹5,700 / year). Taking the amount from the snapshot and the interval
 * from the catalog row would print ₹5,700 / month — a 12× lie in place of the ₹0.00 one.
 */
function snapshotAmountSummary(snap: PriceSnapshot): string {
  return amountSummary({
    model: snap.model,
    type: snap.type,
    currency: snap.currency,
    amountMinor: snap.amountMinor,
    interval: snap.interval,
    intervalCount: snap.intervalCount,
    percentageBps: snap.percentageBps,
  });
}

/** The rating fields a summary needs — a catalog price and a frozen snapshot both supply them. */
interface RatingSummaryShape {
  model: string;
  type: string;
  currency: string;
  amountMinor: number | null;
  interval: string | null;
  intervalCount: number;
  percentageBps: number | null;
}

function amountSummary(shape: RatingSummaryShape): string {
  if (shape.model === "percentage" && shape.percentageBps != null) {
    return `${(shape.percentageBps / 100).toFixed(2)}%`;
  }
  if (shape.amountMinor == null) return shape.model; // usage/tiered/etc. — no single flat amount
  // Via the platform helper, NOT a local `/100`: the divisor is the currency's
  // exponent, so a ¥1000 plan reads ¥1,000 rather than JPY 10.00 — a 100× misquote on
  // the page a buyer agrees a price on. It also renders symbol-first and grouped, the
  // same shape the portal uses, so the two surfaces stop looking like two products.
  const money = formatMoney(shape.amountMinor, shape.currency);
  if (shape.type === "one_time" || !shape.interval) return money;
  const every =
    shape.intervalCount > 1 ? `${shape.intervalCount} ${shape.interval}s` : shape.interval;
  return `${money} / ${every}`;
}

/** `price_snapshot` is jsonb, so it arrives as `unknown` — take it only if it can rate. */
function asPriceSnapshot(raw: unknown): PriceSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const snap = raw as Partial<PriceSnapshot>;
  return typeof snap.model === "string" && typeof snap.currency === "string"
    ? (snap as PriceSnapshot)
    : null;
}

/** One displayed line of the checkout. */
export interface CheckoutItemView {
  name: string;
  amount: string;
  currency: string;
  quantity: number;
  /** plan | addon | charge — lets the page group the plan apart from add-ons. */
  kind: string;
  /** The product's picture, or null. */
  image_url: string | null;
}

export interface CheckoutView {
  business: {
    name: string;
    /** 'test' marks a test-mode checkout, so the buyer knows no real payment happens. */
    livemode: string;
    /** Brand Styles (0185) — same brand the portal and billing email render. */
    logo_url: string | null;
    icon_url: string | null;
    favicon_url: string | null;
    brand_color: string | null;
    /**
     * IANA zone for every date the buyer reads here (today: the renewal date in the
     * change preview). The checkout page lives outside the dashboard tree, so it has
     * no `BusinessTzProvider` — without this field it fell back to UTC and quoted a
     * renewal date that could be a day off the one the operator sees. Null is normal.
     */
    timezone: string | null;
  };
  /** Every line on this checkout, in operator order (item 0 = the primary/plan). */
  items: CheckoutItemView[];
  /** Coupon codes that will be applied on completion. */
  coupons: string[];
  /**
   * May the buyer add or remove those codes here? `businesses.allow_customer_coupons`
   * (0238), off by default. On the wire so the hosted page renders the promo box only when
   * the routes behind it will answer — a box that 403s is worse than no box.
   */
  allow_coupons: boolean;
  /**
   * Code → why completion would refuse it (expired, not yet valid, used up…), for codes
   * still to be applied. Those codes are left out of every figure on the page, so the
   * quote never includes a discount the confirm will not give.
   */
  coupon_refusals: Record<string, string>;
  /** The business's resolved checkout field matrix (0245) — what the details step shows and requires. */
  field_config: CheckoutFieldConfig;
  /** `storefront_config.collect_po_number` (0243): render the PO number field. */
  collect_po_number: boolean;
  status: string;
  mode: CheckoutMode;
  /** Where the page sends the buyer after completing / on cancel; null = stay here. */
  redirect_url: string | null;
  cancel_url: string | null;
  /**
   * What this composition costs per billing period, WITH tax — see
   * `projectRecurringPayment`. Absent whenever it cannot be stated honestly (no customer
   * yet, no recurring line, an estimator refusal), which is why the page must treat its
   * absence as "say nothing" rather than "zero".
   */
  nextPayment?: CheckoutNextPayment;
  /** mode='change' only — what the buyer is moving away from, and what it costs. */
  change?: CheckoutChangeView;
  /** mode='purchase' only — what is due today and how the payment method is handled. */
  purchase?: CheckoutPurchaseView;
  /** Opened from a payment link: each line and what the buyer may change about it (E3). */
  offer?: CheckoutOfferView;
  /**
   * mode='create': the first invoice — one-time items and attached charges included, tax
   * included. `trial` = the plan starts with a trial, so nothing is charged today.
   */
  dueToday?: CheckoutDueToday;
  /** What the buyer must agree to before paying (storefront settings). */
  consent?: CheckoutConsentView;
  /** Hosted checkout layout (storefront settings). */
  layout: "steps" | "one_page";
  /** Put Apple Pay / Google Pay above the form where the gateway supports them. */
  wallets_first: boolean;
  /**
   * The billing details already on the session's customer, so the details step can PREFILL
   * rather than present a blank form.
   *
   * ⚠ This is why it has to be here, and it is a data-loss fix, not a convenience. The
   * details step writes through `POST /checkout/v1/customer`, and that write REPLACES the
   * address (`applyAddress` sets every column to `?? null` — see the note on
   * `setCheckoutCustomer`). With nothing to prefill from, a buyer who reached the form by
   * "Edit billing details" and filled only the required fields silently NULLED their
   * company, address lines 2/3, state, last name and tax registration number on the real
   * customer row. For an Indian B2B buyer that is their GSTIN gone, and every later invoice
   * loses the input tax credit the field exists for. A form that can overwrite what it
   * cannot show is the bug; showing it is the fix.
   *
   * SECURITY — this widens a PUBLIC link, deliberately and narrowly:
   *  - It is ALWAYS the session's own `resulting_customer_id`. Never a lookup, by email or
   *    anything else, so it adds no enumeration and cannot echo a stranger's record — the
   *    two properties `setCheckoutCustomer`'s note is protecting.
   *  - The link already has WRITE access to exactly this row (that is what
   *    `updateCheckoutCustomerDetails` exists for: a buyer mid-change has to be able to
   *    supply the phone number RazorPay refuses to vault a card without).
   *  - `email` is create-mode only. A change link's customer predates the link and its
   *    email is pinned and uneditable, so the form does not render the field and there is
   *    no reason to put the address on the wire.
   * The residual, stated plainly: a leaked change link now discloses the buyer's billing
   * address, phone and tax registration number, where before it disclosed the plan only.
   * `POST /v1/businesses/:biz/checkout_sessions/:id/revoke` is the lever when that happens.
   */
  customer?: {
    /** Create mode only — see above. Nullable because the column is. */
    email?: string | null;
    /** snake_case, from `billingAddress` — the shape `AddressFields` reads. */
    address: Record<string, string | null> | null;
    tax_registration_number: string | null;
    /** Create mode, session-created customer only: the default ship-to, snake_case. */
    shipping_address?: Record<string, string | null> | null;
  };
}

export interface CheckoutConsentView {
  /**
   * The exact sentence the buyer agrees to; recorded word for word on completion. Null when
   * the business does not ask, or the checkout has no recurring item.
   */
  recurring_text: string | null;
  terms_url: string | null;
  privacy_url: string | null;
  /** The buyer must accept the terms (and privacy policy when set). */
  terms_required: boolean;
  /** Offer the optional marketing opt-in. */
  marketing_offered: boolean;
}

/** The billing period of the checkout's recurring plan ("month", "3 months"), or null. */
function recurringPeriod(
  rows: Array<{
    kind: string;
    price: { type: string; interval: string | null; intervalCount: number };
  }>,
): string | null {
  const r =
    rows.find((x) => x.kind === "plan" && x.price.type === "recurring" && x.price.interval) ??
    rows.find((x) => x.price.type === "recurring" && x.price.interval);
  if (!r?.price.interval) return null;
  return r.price.intervalCount > 1
    ? `${r.price.intervalCount} ${r.price.interval}s`
    : r.price.interval;
}

/** The recurring-charge sentence, with the taxed amount when it is known. */
export function recurringConsentText(
  businessName: string,
  period: string,
  next: { totalMinor: number; currency: string; excludesUsage: boolean } | null | undefined,
): string {
  const usage = next?.excludesUsage ? ", plus usage," : "";
  return next
    ? `I agree that ${businessName} charges me ${formatMoney(next.totalMinor, next.currency)}${usage} every ${period} until I cancel.`
    : `I agree that ${businessName} charges me for this subscription every ${period} until I cancel.`;
}

export interface CheckoutDueToday {
  currency: string;
  trial: boolean;
  totalMinor: number;
  taxMinor: number;
  /** After account credit. */
  amountDueMinor: number;
}

export interface CheckoutOfferLine {
  /** price public id — what `POST /checkout/v1/items` names. */
  price: string;
  name: string;
  amount: string;
  /** In the cart now; 0 = an optional line not chosen. */
  quantity: number;
  /** The buyer may choose any quantity from `min` to `max`. */
  adjustable: boolean;
  min: number;
  max: number;
  /** The buyer may remove it, or add it. */
  optional: boolean;
  /** The product's picture, or null. */
  image_url: string | null;
}

export interface CheckoutOfferView {
  lines: CheckoutOfferLine[];
}

export interface CheckoutPurchaseView {
  /** `storefront_config.one_time_save_payment_method` — whether to keep the method. */
  save_payment_method: "never" | "always" | "ask";
  /** The link names a known customer; the details step edits their address only. */
  customer_pinned: boolean;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  tax_lines: Array<{ label: string; amount_minor: number }>;
  total_minor: number;
  /** What the buyer pays now, after any account credit. */
  amount_due_minor: number;
  /** False until the buyer's address is known: the figures then exclude tax. */
  tax_known: boolean;
}

/**
 * The recurring cost of what the buyer is signing up to or moving to, itemised the way
 * the INVOICE will itemise it — so the quote on this page and the document that follows
 * can be read against each other. Integer minor units throughout.
 */
export interface CheckoutNextPayment {
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  /** CGST + SGST intra-state, one IGST row inter-state, one row elsewhere. Sums to `taxMinor`. */
  taxLines: Array<{ label: string; amountMinor: number }>;
  totalMinor: number;
  /** What is actually collected once account credit is applied. */
  amountDueMinor: number;
  /** A metered line is in the composition, so this figure is the fixed-charge floor. */
  excludesUsage: boolean;
  /**
   * The figure covers items the page does NOT list — a change session shows the lines it
   * touches, while this prices the WHOLE subscription it leaves behind. Without saying so,
   * a buyer adding one ₹4,606 add-on to a ₹56,118 plan reads "₹72,763.52" over two lines
   * that sum to ₹60,724 and cannot account for the difference (measured: an untouched
   * add-on, 2026-08-28).
   */
  includesExistingItems: boolean;
}

/**
 * Resolve an instrument the buyer PICKED — from the checkout's "Manage cards" panel — to
 * an internal id, or refuse.
 *
 * Lives here rather than in the route because it is a session invariant, not request
 * plumbing: this is a PUBLIC link, so a `pm_…` arriving in a body must be proved to belong
 * to the session's pinned customer before anything is charged against it. The same reason
 * `setCheckoutCustomer` refuses to reassign the customer in change mode.
 *
 * An `invalid` instrument is refused too. It would be refused later by collection, and
 * finding out then means the change has already been applied.
 */
export async function resolveHeldPaymentMethod(
  ctx: CheckoutContext,
  paymentMethodPublicId: string,
): Promise<string> {
  if (!ctx.resultingCustomerId) {
    throw new CheckoutError("Set customer details before choosing a payment method");
  }
  const [held] = await withTenant(ctx.organizationId, (tx) =>
    tx
      .select({ id: paymentMethods.id, status: paymentMethods.status })
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.customerId, ctx.resultingCustomerId!),
          eq(paymentMethods.publicId, paymentMethodPublicId),
        ),
      )
      .limit(1),
  );
  // Deliberately the same answer for "does not exist" and "belongs to someone else": a
  // public link must not become an oracle for which payment-method ids are real.
  if (!held) throw new CheckoutError("No such payment method on this account");
  if (held.status !== "valid") {
    throw new CheckoutError(
      "We can no longer charge that payment method. Select a different one, or add one.",
    );
  }
  return held.id;
}

/**
 * Swap catalog HANDLES out of buyer-facing proration line text.
 *
 * The engine builds those descriptions from a price's internal handle on purpose — it is a
 * stable machine-readable token, and `dashboard/lib/estimate-lines.ts` already substitutes
 * it for a display name on the OPERATOR screens, calling the leak by its name: "leaking a
 * catalog slug onto a confirmation screen an operator reads to a customer is the defect this
 * module closes, frontend-only". The word to notice there is *frontend-only*: the buyer
 * surfaces never got the same treatment, so a hosted checkout quoted a payer
 * "Remaining time on platform-business-v202607-INR-Monthly ×1" (seen 2026-08-27).
 *
 * Done HERE rather than in the storefront because the storefront has no catalog: it is
 * buyer-authed and cannot read prices. The engine can, and in this function already holds
 * exactly the two sets a proration line can name — the subscription's LIVE items (the plan
 * being left) and the session's DESIRED items (the plan being taken).
 *
 * Substitution only, never invention: a handle we cannot resolve is left byte-for-byte, the
 * same contract the dashboard formatter keeps.
 */
function humanizeLineDescriptions(
  lines: Array<{ description: string; amountMinor: number }>,
  known: Array<{ publicId: string; externalName: string | null; name: string | null }>,
): Array<{ description: string; amountMinor: number }> {
  const byHandle = new Map<string, string>();
  for (const p of known) {
    const display = p.externalName ?? p.name ?? null;
    // Only when the catalog actually carries a friendlier name than the handle.
    if (display && display !== p.publicId) byHandle.set(p.publicId, display);
  }
  if (byHandle.size === 0) return lines;
  // Longest handle first: one public id can be a prefix of another
  // (`platform-pro-v202607-INR-Monthly` vs `…-INR-Monthly-BF`), and replacing the short one
  // first would leave the suffix stranded mid-sentence.
  const handles = [...byHandle.keys()].sort((a, b) => b.length - a.length);
  return lines.map((l) => {
    let description = l.description;
    for (const h of handles) {
      if (description.includes(h)) description = description.split(h).join(byHandle.get(h)!);
    }
    // A fresh term's line is `<price model> (<price>) ×N`; the model ("flat", "per_unit") is the
    // catalog's word, not the buyer's. Dropped once the price has a name to stand on its own.
    const fresh = /^[a-z_]+ \((.+)\)( ×\d+)?$/.exec(description);
    if (fresh && description !== l.description) description = `${fresh[1]}${fresh[2] ?? ""}`;
    return { ...l, description };
  });
}

/**
 * The mandate this session needs, and whether the instrument on file can carry it.
 *
 * Buyer-facing and deliberately small: the ceiling to register, the debit it was sized
 * from, and whether a fresh authorisation is REQUIRED here rather than merely advisable.
 */
export interface CheckoutMandateRequirement {
  currency: string;
  /** Ceiling to register if the buyer (re-)authorises in this session, minor units. */
  requiredCeilingMinor: bigint;
  /** The largest single debit this session leads to — what the ceiling is sized from. */
  largestDebitMinor: bigint;
  /** The mandate on the instrument that would be charged, when it rides one. */
  current: { ceilingMinor: bigint; rail: string | null } | null;
  /**
   * The instrument on file CANNOT carry this session's debit: its mandate would refuse
   * the charge before the gateway is called. The card step stops being optional.
   */
  reauthorizationRequired: boolean;
  /** Rails that cannot be registered this high at all (NPCI caps UPI Autopay). */
  railsOverCap: string[];
}

/**
 * The composition the subscription will END UP with, as `{price, quantity}` rows the
 * estimator can rate.
 *
 * ⚠️ NOT the session's items. For a change session `ctx.items` is the set the buyer is
 * TOUCHING, not the whole subscription: without `replace_items_list` an untouched add-on
 * stays attached and keeps billing. Sizing a mandate from `ctx.items` alone would miss it
 * and register a ceiling below the renewal it has to carry.
 *
 * The keep/replace rules mirror `planItemOperations` exactly — matched by internal price
 * id, a desired plan replacing the live plan, and a live add-on dropped only under
 * `replace_items_list` — because the composition this predicts is the one that call books.
 */
async function projectedComposition(
  ctx: CheckoutContext,
  desired: Array<{ price: typeof prices.$inferSelect; quantity: number; kind: string }>,
): Promise<Array<{ price: typeof prices.$inferSelect; quantity: number }>> {
  const out = desired.map((d) => ({ price: d.price, quantity: d.quantity }));
  if (ctx.mode !== "change" || !ctx.subscriptionId) return out;
  const live = await loadLiveItems(ctx.organizationId, ctx.subscriptionId);
  const desiredPriceIds = new Set(desired.map((d) => d.price.id));
  const desiredHasPlan = desired.some((d) => d.kind === "plan");
  const keep = live.filter((l) => {
    if (desiredPriceIds.has(l.priceId)) return false; // the desired line already speaks for it
    if (l.kind === "plan") return !desiredHasPlan; // swapped out by the desired plan
    return ctx.replaceItemsList !== true; // an untouched add-on survives unless the list is replaced
  });
  if (keep.length === 0) return out;
  const rows = await withTenant(ctx.organizationId, (tx) =>
    tx
      .select()
      .from(prices)
      .where(
        inArray(
          prices.id,
          keep.map((k) => k.priceId),
        ),
      ),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const k of keep) {
    const price = byId.get(k.priceId);
    if (price) out.push({ price, quantity: k.quantity });
  }
  return out;
}

/**
 * What this session's composition costs EVERY BILLING PERIOD, tax included — the same
 * fact the portal's plan card states ("Next payment · ₹67,993.96 · includes CGST…"), and
 * the one this page could not state at all.
 *
 * The checkout listed per-item catalog prices and stopped: no sum, no tax, no total. The
 * old note said "a total we cannot compute is not a total", which was true of those
 * pre-formatted strings — but the number was already being computed one function below,
 * for mandate sizing, and thrown away. This returns it to the buyer.
 *
 * Two deliberate differences from the mandate sizer, which calls the same estimator:
 *  - **Coupons are priced in.** A ceiling must outlive a coupon (see its docstring); a
 *    QUOTE must match what the card is actually charged, so this passes the session's
 *    codes.
 *  - **Recurring lines only.** A one-time fee is collected once, by the immediate
 *    invoice; repeating it in a per-period figure would overstate every renewal.
 *
 * Null — never a zero, never a guess — when there is nothing honest to say: no customer
 * yet (a signup before the details step, where there is no address and so no tax), no
 * recurring line, or an estimator that refused the composition. `excludesUsage` is the
 * one caveat that travels with a real figure: metered lines cannot be projected for a
 * period that has not happened, exactly as `estimateRenewal` documents.
 */
async function projectRecurringPayment(ctx: CheckoutContext): Promise<CheckoutNextPayment | null> {
  const customerId = ctx.resultingCustomerId;
  if (!customerId) return null;
  try {
    const desired = await resolveContextItems(ctx);
    if (desired.length === 0) return null;
    const composition = await projectedComposition(ctx, desired);
    const recurring = composition.filter((c) => c.price.type === "recurring");
    if (recurring.length === 0) return null;
    const now = await businessWallClock(ctx.businessId);
    // A change keeps the coupons already on the subscription (less any the session's
    // replace list drops); they are priced as invoicing prices them, never re-checked.
    const attached =
      ctx.mode === "change" && ctx.subscriptionId
        ? (await attachedCouponCodes(ctx, ctx.subscriptionId)).filter(
            (c) => !ctx.replaceCouponList || ctx.couponCodes.includes(c),
          )
        : [];
    const est = await estimateNewSubscription({
      organizationId: ctx.organizationId,
      businessId: ctx.businessId,
      customerId,
      items: recurring,
      now,
      couponCodes: [...attached, ...ctx.couponCodes.filter((c) => !attached.includes(c))],
      attachedCouponCodes: attached,
    });
    return {
      currency: est.currency,
      subtotalMinor: est.subtotal_minor,
      taxMinor: est.tax_minor,
      taxLines: (est.tax_lines ?? []).map((t) => ({ label: t.label, amountMinor: t.amount_minor })),
      totalMinor: est.total_minor,
      amountDueMinor: est.amount_due_minor ?? est.total_minor,
      excludesUsage: recurring.some((r) => r.price.model === "usage"),
      // Anything in the projection that this session's own line list does not mention.
      includesExistingItems: composition.length > desired.length,
    };
  } catch (e) {
    // A quote is a nicety, not a gate: a buyer who cannot see their plan because an
    // estimate failed is worse off than one shown the item list alone.
    log.warn("checkout recurring projection failed", { error: (e as Error)?.message });
    return null;
  }
}

/**
 * What a signup charges TODAY: the first invoice, one-time items and attached charges
 * included, tax included. Null without a customer (no address, so no tax) or when the
 * estimator refuses — "say nothing" rather than a guess, like the per-period figure.
 */
async function projectFirstPayment(ctx: CheckoutContext): Promise<CheckoutDueToday | null> {
  const customerId = ctx.resultingCustomerId;
  if (!customerId) return null;
  try {
    const desired = await resolveContextItems(ctx);
    if (desired.length === 0) return null;
    const currency = desired[0]!.price.currency;
    const trialPeriod = desired.find((d) => d.price.type === "recurring")?.price.trialPeriod ?? 0;
    if (trialPeriod > 0)
      return { currency, trial: true, totalMinor: 0, taxMinor: 0, amountDueMinor: 0 };
    const est = await estimateNewSubscription({
      organizationId: ctx.organizationId,
      businessId: ctx.businessId,
      customerId,
      items: desired.map((d) => ({ price: d.price, quantity: d.quantity })),
      now: await businessWallClock(ctx.businessId),
      couponCodes: ctx.couponCodes,
    });
    return {
      currency: est.currency,
      trial: false,
      totalMinor: est.total_minor,
      taxMinor: est.tax_minor,
      amountDueMinor: est.amount_due_minor ?? est.total_minor,
    };
  } catch (e) {
    log.warn("checkout first-payment projection failed", { error: (e as Error)?.message });
    return null;
  }
}

/**
 * What a signup's mandate registration can collect as the first invoice's payment (PayU's
 * consent transaction as the first billing cycle): the projected amount due, create mode
 * only. Null when there is nothing to collect now.
 */
export async function checkoutFirstChargeMinor(ctx: CheckoutContext): Promise<bigint | null> {
  if (ctx.mode !== "create") return null;
  const due = await projectFirstPayment(ctx);
  return due && !due.trial && due.amountDueMinor > 0 ? BigInt(due.amountDueMinor) : null;
}

/**
 * The first charge a signup's registration already collected, when it can pay this invoice:
 * the session's setup intent, consumed into `pm`, the amount PayU captured equal to the
 * amount due, no refund on it, and the intent's first-charge claim taken as `booked` (the
 * setup refund takes the same claim, so only one of them acts). Booked as the pre-invoice
 * charge, so the invoice commits paid. The caller releases the claim if the commit fails.
 */
async function registrationFirstCharge(
  ctx: CheckoutContext,
  pm: { id: string } | null,
  amountDueMinor: bigint,
): Promise<{ charge: CompletedCharge; intentId: string } | null> {
  if (!pm) return null;
  const [row] = await withTenant(ctx.organizationId, (tx) =>
    tx
      .select({
        intent: paymentIntents,
        account: gatewayAccounts,
      })
      .from(checkoutSessions)
      .innerJoin(paymentIntents, eq(paymentIntents.publicId, checkoutSessions.setupPaymentIntent))
      .leftJoin(gatewayAccounts, eq(gatewayAccounts.id, paymentIntents.gatewayAccountId))
      .where(eq(checkoutSessions.id, ctx.sessionId))
      .limit(1),
  );
  const pi = row?.intent;
  if (
    !pi ||
    pi.purpose !== "setup" ||
    pi.status !== "consumed" ||
    pi.paymentMethodId !== pm.id ||
    !pi.firstChargeMinor ||
    !pi.intentAtGateway
  )
    return null;
  if (!row.account) return null;
  // What the gateway holds now, not only what we asked for.
  let state: Awaited<ReturnType<NonNullable<PaymentProvider["setupChargeState"]>>> = null;
  try {
    state = (await resolveAdapter(row.account).setupChargeState?.(pi.intentAtGateway)) ?? null;
  } catch (e) {
    log.warn("the registration's first charge could not be read; it is not booked", {
      event: "registration_first_charge_unread",
      intent: pi.publicId,
      error: (e as Error)?.message,
    });
    return null;
  }
  if (!state || state.refunded || state.capturedMinor !== amountDueMinor) {
    log.warn(
      "the registration's first charge cannot pay this invoice; its setup refund returns it",
      {
        event: "registration_first_charge_mismatch",
        intent: pi.publicId,
        requested_minor: String(pi.firstChargeMinor),
        captured_minor: state ? String(state.capturedMinor) : null,
        refunded: state?.refunded ?? null,
        due_minor: String(amountDueMinor),
      },
    );
    return null;
  }
  const [method] = await withTenant(ctx.organizationId, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.id, pm.id)).limit(1),
  );
  if (!method) return null;
  if (!(await claimFirstCharge(ctx.organizationId, pi.id, "booked"))) return null;
  return {
    intentId: pi.id,
    charge: {
      pm: method,
      account: row.account,
      gatewayKey: row.account.gatewayKey,
      result: { status: "succeeded", providerChargeId: pi.intentAtGateway },
      amountMinor: state.capturedMinor,
      outcome: "succeeded",
    },
  };
}

/**
 * Size the mandate this session's outcome needs, and compare it with the instrument on
 * file. Shared by the change VIEW (which gates the confirm step on it) and
 * `POST /checkout/v1/setup` (which registers with it) — one number, or the page would
 * recommend a ceiling different from the one the gateway is asked for.
 *
 * The ceiling covers the larger of two debits, because one mandate carries both:
 *  1. what is collected NOW — the proration for a change, the first invoice for a signup;
 *  2. every RENEWAL after it, projected over the post-change composition.
 *
 * ⚠️ Sized on the STICKER composition — `estimateNewSubscription` is called with no coupon
 * codes. A coupon is temporary and the mandate has to outlive it: a 30%-off code expiring
 * would otherwise take the renewal straight past a ceiling sized under it, and a 100%-off
 * first month would size the mandate at zero. The cost is a ceiling above what a
 * permanently-discounted buyer is actually debited, which is the safe direction and still
 * nowhere near the ×3 this replaced.
 *
 * Returns null when nothing can be sized (no items, or the estimator refuses the
 * composition) — callers then leave the ceiling to `deriveMandateCeiling`, which is the
 * pre-session behaviour rather than a guess.
 */
/**
 * The currency this session bills in: its items' price currency. Null when it has no
 * priceable item. The storefront offers gateways, and a setup registers its mandate, in
 * this currency — not the customer's or the business default.
 */
export async function resolveSessionCurrency(ctx: CheckoutContext): Promise<string | null> {
  const desired = await resolveContextItems(ctx);
  return desired[0]?.price.currency.toUpperCase() ?? null;
}

export async function resolveSessionMandateRequirement(
  ctx: CheckoutContext,
  /**
   * The immediate debit, when the caller has already priced it. `getCheckoutView` has
   * just run `estimateChange` for the buyer's preview; letting this re-run it would
   * plan the same proration twice on one page load.
   */
  opts: { immediateDebitMinor?: bigint } = {},
): Promise<CheckoutMandateRequirement | null> {
  // A purchase is paid once and leaves nothing to debit later, so it sizes no mandate.
  if (ctx.mode === "purchase") return null;
  const desired = await resolveContextItems(ctx);
  if (desired.length === 0) return null;
  const currency = desired[0]!.price.currency;
  const customerId = ctx.resultingCustomerId;
  if (!customerId) return null;

  const now = await businessWallClock(ctx.businessId);
  let largestDebit = 0n;

  // (1) What this session collects immediately.
  if (opts.immediateDebitMinor != null) {
    if (opts.immediateDebitMinor > largestDebit) largestDebit = opts.immediateDebitMinor;
  } else if (ctx.mode === "change" && ctx.subscriptionId) {
    try {
      const live = await loadLiveItems(ctx.organizationId, ctx.subscriptionId);
      const { changes } = planItemOperations(live, desired, {
        replaceItemsList: ctx.replaceItemsList,
      });
      if (changes.length > 0) {
        const rules = await checkoutChangePolicy(ctx, ctx.subscriptionId, {
          changes,
          additions: [],
          removals: [],
        });
        const est = await estimateChange({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          subscriptionId: ctx.subscriptionId,
          now,
          changes,
          resetTerm: checkoutResetTerm(ctx, rules),
        });
        // `total_minor`, not `amount_due_minor`: credit balance is a one-off, and a
        // mandate sized against a credit-funded charge is refused on the next one.
        const total = BigInt(est.total_minor);
        if (total > largestDebit) largestDebit = total;
      }
    } catch (e) {
      // A preview that cannot be produced must not block the card step — the renewal
      // projection below still sizes the recurring half, which is the repeating risk.
      log.warn("mandate sizing: change preview failed", { error: (e as Error)?.message });
    }
  }

  // (2) Every renewal after it. Recurring lines only — a one-time fee is collected once,
  // by (1), and counting it here would inflate every future ceiling for a single charge.
  const composition = await projectedComposition(ctx, desired);
  const recurring = composition.filter((c) => c.price.type === "recurring");
  if (recurring.length > 0) {
    try {
      const est = await estimateNewSubscription({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        customerId,
        items: recurring,
        now,
      });
      const total = BigInt(est.total_minor);
      if (total > largestDebit) largestDebit = total;
    } catch (e) {
      log.warn("mandate sizing: renewal projection failed", { error: (e as Error)?.message });
    }
  }
  // A signup with only one-time lines, or an estimator that refused everything.
  if (largestDebit <= 0n && ctx.mode === "create") {
    try {
      const est = await estimateNewSubscription({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        customerId,
        items: composition,
        now,
      });
      largestDebit = BigInt(est.total_minor);
    } catch (e) {
      log.warn("mandate sizing: signup estimate failed", { error: (e as Error)?.message });
    }
  }
  if (largestDebit <= 0n) return null;

  // The business's own headroom, the same one `deriveMandateCeiling` applies.
  const [biz] = await withTenant(ctx.organizationId, (tx) =>
    tx
      .select({ mandateConfig: businesses.mandateConfig })
      .from(businesses)
      .where(eq(businesses.id, ctx.businessId))
      .limit(1),
  );
  const requiredCeilingMinor = withMandateHeadroom(
    largestDebit,
    resolveMandateHeadroomConfig(biz ?? null),
  );

  // The instrument that would actually be charged — the subscription's default, falling
  // back to the customer's newest valid one, exactly as `resolveChargeCandidates` and
  // `mandateShortfallFor` resolve it. Warning about a ceiling on a card we would not
  // charge is noise.
  const pm = await withTenant(ctx.organizationId, async (tx) => {
    if (ctx.mode === "change" && ctx.subscriptionId) {
      const [sub] = await tx
        .select({ pmId: subscriptions.defaultPaymentMethodId })
        .from(subscriptions)
        .where(eq(subscriptions.id, ctx.subscriptionId))
        .limit(1);
      if (sub?.pmId) {
        const [row] = await tx
          .select()
          .from(paymentMethods)
          .where(eq(paymentMethods.id, sub.pmId))
          .limit(1);
        if (row) return row;
      }
    }
    const [primary] = await tx
      .select()
      .from(paymentMethods)
      .where(and(eq(paymentMethods.customerId, customerId), eq(paymentMethods.status, "valid")))
      .orderBy(desc(paymentMethods.createdAt))
      .limit(1);
    return primary ?? null;
  });

  // `mandateRefusal` rather than a fresh comparison: it is the function that will decide
  // at debit time (null ceiling → unknown, not unlimited; currency mismatch → skipped),
  // and a second copy of that rule is how the page starts promising what collection
  // refuses. It is also what keeps this gated on the DATA — an instrument with no mandate
  // has no ceiling, so an international buyer never reaches any of this.
  const refused = pm ? mandateRefusal(pm, largestDebit, currency) : null;

  return {
    currency,
    requiredCeilingMinor,
    largestDebitMinor: largestDebit,
    current:
      pm?.mandateMaxAmountMinor != null
        ? { ceilingMinor: pm.mandateMaxAmountMinor, rail: pm.mandateRail }
        : null,
    reauthorizationRequired: refused != null,
    // The SESSION's currency, not an assumption. `MANDATE_RAIL_MAX_CEILING_MINOR` is an
    // NPCI table denominated in INR paise, and this ceiling is in whatever the session
    // bills in — so without the third argument a large non-INR session compared rupee
    // caps against dollars and told the buyer "UPI Autopay cannot be approved for $X per
    // charge — your bank caps it lower", for a rail their business does not have.
    // `railsOverCeilingCap` answers [] on a mismatch rather than guessing, the same
    // skip-don't-guess rule `mandateRefusal` applies to a mandate in another currency.
    railsOverCap: railsOverCeilingCap(requiredCeilingMinor, ["card", "upi", "emandate"], currency),
  };
}

/**
 * A gateway's own per-debit cap for a method, below the network's (PayU UPI: ₹15,000), in
 * INR minor units (`GatewayDefinition.mandateCeilingCapMinor`). Null when the gateway sets
 * none or the currency is not INR. The checkout hides a method whose debit is above it and
 * clamps the ceiling it shows and asks for.
 */
export function gatewayRailCapMinor(
  gatewayKey: string,
  method: string,
  currency?: string | null,
): bigint | null {
  if (currency && currency.toUpperCase() !== "INR") return null;
  const caps = gatewayDefinition(gatewayKey)?.mandateCeilingCapMinor as
    | Readonly<Record<string, number>>
    | undefined;
  const v = caps?.[method];
  return v == null ? null : BigInt(v);
}

/**
 * Proration preview for a plan swap, straight from `estimateChange` (the same
 * simulation the operator-facing estimate endpoint returns, so the buyer sees
 * exactly what the operator would). All money is integer minor units.
 */
export interface CheckoutChangePreview {
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  /** total − credits applied, floored at 0: what would actually be collected now. */
  amountDueMinor: number;
  /** POST-tax balance applied (refundable + excess). The promotional bucket is pre-tax
   *  and is `promotionalDiscountMinor`, already netted out of `totalMinor`. */
  creditsAppliedMinor: number;
  /** Promotional credit funding this change — a PRE-TAX discount, so it renders above
   *  the tax line and is already inside `totalMinor` (30fcbd6). */
  promotionalDiscountMinor: number;
  /**
   * Face value of the credit note the confirm issues — the credited time AND the tax
   * originally charged on it. Undefined when nothing is credited.
   *
   * ⚠ This doc used to say `totalMinor` "nets the untaxed credit lines (a pure removal
   * previews −4606)" and warned that rendering it as the refund short-changes the buyer by
   * 18%. That stopped being true on 2026-08-30: `estimateChange.total_minor` is now
   * `(invoice total) − (credit note total)`, so a pure removal previews −543508 and equals
   * exactly minus this field. The gap the warning described was the defect, not a
   * convention — it also made a downgrade preview as a CHARGE, which this page rendered as
   * "Due today" (see `previewOutcome`, whose `totalMinor < 0` branch could never fire).
   *
   * Still worth carrying: it names the DOCUMENT, where `totalMinor` names the net cash, and
   * the two differ whenever an invoice absorbs part of the note. The tax the note reverses
   * is `creditNoteTotalMinor − Σ(negative lines)`, which is what makes the storefront's
   * footer ladder add up.
   */
  creditNoteTotalMinor?: number;
  /**
   * The slice of that note the proration invoice cannot absorb, which lands on the buyer's
   * balance and is therefore SPENT AT THEIR NEXT RENEWAL.
   *
   * Carried so the "From your next payment" strip can net it. That strip is priced by
   * `estimateNewSubscription`, which reads the balance as it stands NOW — and this credit
   * does not exist yet, because the very change being previewed creates it. So the strip
   * quoted the gross recurring figure while the card beneath it announced the credit:
   * ₹90,732.56 to the buyer against ₹89,845.20 on the operator's screen, for one
   * subscription at one instant, differing by exactly the ₹887.36 named on both.
   */
  refundableCreditAddedMinor?: number;
  /**
   * The slice of the credit note spent relieving what the buyer STILL OWES on the term's own
   * invoices, before any of it can reach their balance — `estimateChange`'s
   * `credit_applied_to_open_invoices_minor`.
   *
   * Carried because without it the buyer's ladder does not add up. The page shows the new
   * invoice's total and the credit for unused time; on an UNPAID term those two no longer
   * explain the figure at the bottom, because part of the credit went to the old invoice.
   * That gap is exactly what let this page announce "₹17,010.12 credited to your balance"
   * against an apply that credited ₹0 and still wanted ₹5,088.01 (2026-08-31).
   *
   * Absent on a fully-paid term, which is every shape that existed before.
   */
  creditAppliedToOpenInvoicesMinor?: number;
  /**
   * The slice of the note that offsets THIS proration invoice — `credits_applied` on the
   * invoice estimate, and the one row the ladder subtracts:
   * `Invoice total → Credit applied → Total due now`.
   *
   * ⚠ Do NOT derive this as `creditNoteTotalMinor − creditAppliedToOpenInvoicesMinor`. That
   * subtraction is exactly right on the unpaid-term shape this page was debugged against and
   * wrong everywhere the other legs are non-zero — and two of those legs (the routing's
   * stranded residue and the distribution's unplaced one) are not on this interface at all,
   * so the page cannot do it correctly even in principle. See
   * `estimate.ts` § `credit_applied_to_this_invoice_minor`.
   *
   * Distinct from `creditsAppliedMinor`, which is PRE-EXISTING balance applied to the same
   * invoice and keeps its own row.
   */
  creditAppliedToThisInvoiceMinor?: number;
  /**
   * The proration invoice's OWN total — the ladder's top figure, before any credit touches it.
   *
   * ⚠ NOT `subtotalMinor + taxMinor`: `subtotalMinor` is the NET of charge and credit lines
   * and goes NEGATIVE on a downgrade, and `totalMinor` is already net of the credit applied.
   * Neither answers "what would this invoice have been", so the engine reports it.
   */
  invoiceTotalMinor?: number;
  /** The invoice's PRE-TAX subtotal — the row above the tax rows, so a pure charges table
   *  reads `lines → subtotal → tax → invoice total` with nothing derived. ⚠ Not
   *  `invoiceTotalMinor − taxMinor`: equal only while `promotionalDiscountMinor` is 0. */
  invoiceSubtotalMinor?: number;
  /**
   * Where every slice of the note went, each LABELLED WITH ITS CREDIT TYPE, for the prose
   * "Credits" section ("An unpaid invoice #58 is present … Prorated Adjustment Credits
   * (525,00 €) will be created for the unused period … and will be adjusted against the
   * due amount").
   *
   * ⚠ The type is NOT inferable from which amount is non-zero — one change can raise BOTH an
   * adjustment and a refundable note (the partially-paid shape), so a consumer guessing from
   * the non-zero leg mislabels exactly the mixed case. Entries sum to `creditNoteTotalMinor`,
   * so prose built from them cannot leave an unnamed remainder.
   */
  creditDestinations?: CreditDestination[];
  /** The unused window the credit is FOR, ISO instants. The prose states it twice in one
   *  sentence; it is what lets a customer match the sentence to a document. */
  creditedPeriodStart?: string;
  creditedPeriodEnd?: string;
  /** Returned to the promotional / excess buckets: real money, but a bucket balance that
   *  cannot offset this invoice. */
  creditReturnedToBucketsMinor?: number;
  /** The slice that reaches nobody (routing `stranded` + distribution `unplaced`). Carried so
   *  the note can account for 100% of the gross instead of leaving an unnamed remainder. */
  creditStrandedMinor?: number;
  /**
   * The NEXT RENEWAL as `estimateChange` prices it — the same block the operator's rail
   * reads for its "Next invoice of …" sentence.
   *
   * ⚠ TWO CALCULATORS ANSWER THIS QUESTION AND THEY MUST NOT DRIFT. The view's
   * `nextPayment` strip is priced by `projectRecurringPayment` → `estimateNewSubscription`,
   * which also serves SIGNUP mode and carries `excludesUsage` / `includesExistingItems`
   * that this block has no equivalent for — so the two are not merged. They are compared
   * instead: `verify:checkout` asserts they agree on a change session, which is the failure
   * that actually matters. One question with two implementations is the pattern this whole
   * area has been unpicking; where a merge costs more than it buys, the next best thing is
   * a test that fails the moment they disagree.
   */
  nextRenewalTotalMinor?: number;
  /** `totalMinor` > 0 → charged now; < 0 → credited to the customer's balance. */
  immediateCharge: boolean;
  /**
   * Set ONLY when the change happens inside a trial: the ISO instant of the
   * trial-end invoice. Then nothing moves today — `amountDueMinor` is 0 and
   * `totalMinor` is what that future invoice will be, at full price.
   *
   * Carried because `immediateCharge: false` alone is ambiguous: it is a CREDIT on
   * a downgrade and a DEFERRED CHARGE here, which is opposite news for the buyer.
   * Without this the storefront read the flag alone and told a trialing upgrader
   * they had been "credited" the new plan's full price.
   */
  dueAtTrialEnd: string | null;
  /**
   * `taxMinor` broken into the rows the invoice will print — CGST + SGST intra-state, one
   * IGST row inter-state, a single row elsewhere. Sums exactly to `taxMinor`.
   *
   * Empty when there is no tax to name. The page renders one "Tax" row only as a fallback:
   * an Indian buyer quoted a lump "Tax" here and sent CGST and SGST lines later has nothing
   * connecting the two, which is the whole reason the invoice itemises them.
   */
  taxLines: Array<{ label: string; amountMinor: number }>;
  /** Whether the swap triggers a full term reset. */
  termReset: boolean;
  newPeriodEnd: string | null;
  lines: Array<{ description: string; amountMinor: number }>;
}

export interface CheckoutChangeView {
  subscriptionId: string; // sub_… public id
  /** Set when completing REACTIVATES a cancelled subscription: its new term's start (null = on completion). */
  reactivation?: { startsAt: string | null };
  currentPlan: { name: string; amount: string } | null;
  /** Items this change DROPS. Rendered as struck-through rows so a removal is visible;
   *  without it an unchecked add-on vanished with no sign anything had happened. */
  removedItems?: Array<{ name: string; amount: string; quantity: number }>;
  /** Omitted if the estimate can't be produced — the page must still render. */
  preview?: CheckoutChangePreview;
  /**
   * Set when Confirm will refuse this change under the business's plan-change rules:
   * `invoices_unpaid` (the gate) or `change_timing` (the rule sends it to the term end).
   * `message` is the buyer's text, the same one the refusal carries.
   */
  blocked?: { code: string; message: string } | null;
  /** Whether the customer already has a usable card (→ no card step needed). */
  hasPaymentMethod: boolean;
  /**
   * The instrument this change will actually be BILLED TO — the subscription's default,
   * falling back to the customer's newest valid one, exactly as `resolveChargeCandidates`
   * picks it at charge time.
   *
   * The page used to say only "billed to the card already on file", which names nothing: a
   * buyer with two cards, or one who has forgotten which they used, had no way to know what
   * was about to be charged before pressing the button that charges it.
   */
  paymentMethod?: {
    type: string;
    brand: string | null;
    last4: string | null;
    /** Set when it rides a mandate — the label then names the rail instead of a card. */
    mandateRail: string | null;
  };
  /**
   * The mandate this change needs, and whether the instrument on file can carry it.
   *
   * ABSENT when there is nothing to say: no instrument, an instrument on no mandate rail
   * (every international card), or a composition the estimator could not price. Presence
   * is the gate — no surface computes "is this buyer Indian" for itself, because that is
   * the wrong test in both directions (an Indian buyer paying USD has no mandate; a SEPA
   * customer has one).
   */
  mandate?: {
    currency: string;
    /** Ceiling the buyer authorises if they (re-)register here. */
    requiredCeilingMinor: number;
    /** The largest single debit this change leads to — what that ceiling is sized from. */
    largestDebitMinor: number;
    /** The mandate on the instrument that would be charged; null when it rides none. */
    currentCeilingMinor: number | null;
    currentRail: string | null;
    /** The card on file would REFUSE this change. The card step stops being optional. */
    reauthorizationRequired: boolean;
    /** Rails that cannot be registered this high at all (NPCI caps UPI Autopay). */
    railsOverCap: string[];
  };
}

/**
 * Display info for the checkout page: business name + the plan being bought.
 * In change mode it also carries the current plan, a proration preview, and
 * whether a card is already on file — everything the buyer needs to consent to
 * an upgrade/downgrade.
 */
/**
 * Add a coupon code the BUYER typed on the hosted page.
 *
 * Writes `checkout_sessions.coupon_codes` — until 0238 that list was set at mint and never
 * again, so the merchant was the only one who could discount a page. Everything downstream
 * already reads it: `getCheckoutView` prices the estimate from these codes and
 * `completeCheckout` applies them, so there is no second application path to keep in step.
 *
 * The caller (`POST /checkout/v1/coupon`) owns the two gates that are not this function's
 * business: the business must allow buyer entry, and the session must not be spent. What IS
 * here is idempotence — re-entering a code already on the page is a no-op rather than a
 * second entry, because a buyer who double-clicks must not stack a discount.
 *
 * Returns the new list, so the route can answer with the re-priced view in one round trip.
 */
export async function addCheckoutCoupon(ctx: CheckoutContext, code: string): Promise<string[]> {
  const trimmed = code.trim();
  if (!trimmed) throw new CheckoutError("Enter a coupon code");
  // Case-insensitive against what is already on the page: codes are case-PRESERVING, but a
  // buyer retyping one rarely matches the case, and two spellings of one code would price
  // the discount twice.
  const already = ctx.couponCodes.some((c) => c.toLowerCase() === trimmed.toLowerCase());
  if (already) return ctx.couponCodes;

  await assertCouponUsableAtCheckout({
    organizationId: ctx.organizationId,
    businessId: ctx.businessId,
    code: trimmed,
    currency: await checkoutCurrency(ctx),
    customerId: ctx.resultingCustomerId,
  });

  const next = [...ctx.couponCodes, trimmed];
  await withTenant(ctx.organizationId, async (tx) => {
    // The buyer's cap (0495). Read at the write, and checked in the update, so two adds at
    // once cannot both pass. Codes the merchant put on the session do not count.
    const [biz] = await tx
      .select({ cap: businesses.maxCustomerCouponCodes })
      .from(businesses)
      .where(eq(businesses.id, ctx.businessId))
      .limit(1);
    const cap = biz?.cap ?? 1;
    const updated = await tx
      .update(checkoutSessions)
      .set({
        couponCodes: next,
        customerCouponCodes: sql`${checkoutSessions.customerCouponCodes} || ${JSON.stringify([trimmed])}::jsonb`,
      })
      .where(
        and(
          eq(checkoutSessions.id, ctx.sessionId),
          sql`jsonb_array_length(${checkoutSessions.customerCouponCodes}) < ${cap}`,
        ),
      )
      .returning({ id: checkoutSessions.id });
    if (updated.length === 0) throw new CheckoutError(customerCouponCapMessage(cap));
  });
  return next;
}

/**
 * Remove a code from the page. Matched case-insensitively so a buyer can undo what they
 * typed, and a code that is not there is a no-op rather than a 404 — the intent ("this
 * should not be on my page") is already satisfied.
 *
 * A merchant-supplied code is removable too. That is a real choice: the alternative is
 * recording who added each code, and a buyer who deletes a granted discount can re-add it
 * from the same box. Worth revisiting if a merchant ever needs a sticky discount.
 */
export async function removeCheckoutCoupon(ctx: CheckoutContext, code: string): Promise<string[]> {
  const trimmed = code.trim().toLowerCase();
  const next = ctx.couponCodes.filter((c) => c.toLowerCase() !== trimmed);
  if (next.length === ctx.couponCodes.length) return ctx.couponCodes;
  await withTenant(ctx.organizationId, async (tx) => {
    await tx
      .update(checkoutSessions)
      .set({
        couponCodes: next,
        // Frees the buyer's slot (0495).
        customerCouponCodes: sql`coalesce((select jsonb_agg(c) from jsonb_array_elements_text(${checkoutSessions.customerCouponCodes}) c where lower(c) <> ${trimmed}), '[]'::jsonb)`,
      })
      .where(eq(checkoutSessions.id, ctx.sessionId));
  });
  return next;
}

/** An estimate as the review page shows it. Handles → names, against the prices involved. */
function changePreviewFromEstimate(
  est: Awaited<ReturnType<typeof estimateChange>>,
  knownPrices: Array<typeof prices.$inferSelect>,
): CheckoutChangePreview {
  return {
    currency: est.currency,
    subtotalMinor: est.subtotal_minor,
    taxMinor: est.tax_minor,
    taxLines: (est.tax_lines ?? []).map((t) => ({
      label: t.label,
      amountMinor: t.amount_minor,
    })),
    totalMinor: est.total_minor,
    // amount_due_minor is optional on Estimate; fall back to the total.
    amountDueMinor: est.amount_due_minor ?? est.total_minor,
    creditsAppliedMinor: est.credits_applied_minor ?? 0,
    promotionalDiscountMinor: est.promotional_discount_minor ?? 0,
    ...(est.credit_note_total_minor ? { creditNoteTotalMinor: est.credit_note_total_minor } : {}),
    ...(est.refundable_credit_added_minor
      ? { refundableCreditAddedMinor: est.refundable_credit_added_minor }
      : {}),
    ...(est.credit_applied_to_open_invoices_minor
      ? { creditAppliedToOpenInvoicesMinor: est.credit_applied_to_open_invoices_minor }
      : {}),
    ...(est.credit_applied_to_this_invoice_minor
      ? { creditAppliedToThisInvoiceMinor: est.credit_applied_to_this_invoice_minor }
      : {}),
    ...(est.invoice_total_minor != null ? { invoiceTotalMinor: est.invoice_total_minor } : {}),
    ...(est.invoice_subtotal_minor != null
      ? { invoiceSubtotalMinor: est.invoice_subtotal_minor }
      : {}),
    ...(est.credit_destinations ? { creditDestinations: est.credit_destinations } : {}),
    ...(est.credited_period_start && est.credited_period_end
      ? {
          creditedPeriodStart: est.credited_period_start,
          creditedPeriodEnd: est.credited_period_end,
        }
      : {}),
    ...(est.credit_returned_to_buckets_minor
      ? { creditReturnedToBucketsMinor: est.credit_returned_to_buckets_minor }
      : {}),
    ...(est.credit_stranded_minor ? { creditStrandedMinor: est.credit_stranded_minor } : {}),
    ...(est.next_renewal ? { nextRenewalTotalMinor: est.next_renewal.total_minor } : {}),
    immediateCharge: est.immediate_charge,
    dueAtTrialEnd: est.due_at_trial_end ?? null,
    termReset: est.term_reset,
    newPeriodEnd: est.new_period_end,
    // Handles → display names, against the plan being LEFT and the plan being TAKEN.
    lines: humanizeLineDescriptions(
      est.lines.map((l) => ({ description: l.description, amountMinor: l.amount_minor })),
      knownPrices,
    ),
  };
}

/**
 * The currency this checkout will bill in, for the fixed-amount coupon check. The session's
 * first item decides it; a change session with no items falls back to the subscription's.
 * Null when neither says (a coupon-only page on a currency-less subscription), and the
 * check then skips the comparison rather than guessing.
 */
/** Why completion would refuse each session code still to be applied — see `coupon_refusals`. */
async function sessionCouponRefusals(ctx: CheckoutContext): Promise<Record<string, string>> {
  if (ctx.couponCodes.length === 0) return {};
  const pending =
    ctx.mode === "change" && ctx.subscriptionId
      ? await couponsToApply(ctx, ctx.subscriptionId)
      : ctx.couponCodes;
  if (pending.length === 0) return {};
  const currency = await checkoutCurrency(ctx);
  const out: Record<string, string> = {};
  for (const code of pending) {
    try {
      await assertCouponUsableAtCheckout({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        code,
        currency,
        customerId: ctx.resultingCustomerId,
      });
    } catch (e) {
      if (!(e instanceof CheckoutError)) throw e;
      out[code] = e.message;
    }
  }
  return out;
}

async function checkoutCurrency(ctx: CheckoutContext): Promise<string | null> {
  return withTenant(ctx.organizationId, async (tx) => {
    if (ctx.items.length > 0) {
      const [row] = await tx
        .select({ currency: prices.currency })
        .from(prices)
        .where(eq(prices.id, ctx.items[0]!.priceId))
        .limit(1);
      if (row?.currency) return row.currency;
    }
    if (ctx.subscriptionId) {
      const [sub] = await tx
        .select({ currency: subscriptions.currency })
        .from(subscriptions)
        .where(eq(subscriptions.id, ctx.subscriptionId))
        .limit(1);
      return sub?.currency ?? null;
    }
    return null;
  });
}

/** One payment-link line's rules, as `checkoutOffer` and `setCheckoutItemQuantity` read them. */
interface OfferRule {
  priceId: string;
  pricePublicId: string;
  kind: string;
  name: string;
  amount: string;
  linkQuantity: number;
  min: number | null;
  max: number | null;
  optional: boolean;
  imageUrl: string | null;
}

async function offerRules(ctx: CheckoutContext): Promise<OfferRule[]> {
  if (!ctx.paymentLinkId) return [];
  const rows = await withTenant(ctx.organizationId, (tx) =>
    tx
      .select({ item: paymentLinkItems, price: prices, kind: products.kind, product: products })
      .from(paymentLinkItems)
      .innerJoin(prices, eq(prices.id, paymentLinkItems.priceId))
      .innerJoin(products, eq(products.id, prices.productId))
      .where(eq(paymentLinkItems.paymentLinkId, ctx.paymentLinkId!))
      .orderBy(paymentLinkItems.position),
  );
  return rows.map((r) => ({
    priceId: r.price.id,
    pricePublicId: r.price.publicId,
    kind: r.kind,
    name: r.price.externalName ?? r.product.externalName ?? r.product.name,
    amount: priceAmountSummary(r.price, null),
    linkQuantity: r.item.quantity,
    min: r.item.minQuantity,
    max: r.item.maxQuantity,
    optional: r.item.optional,
    imageUrl: r.product.imageUrl,
  }));
}

/** The quantities a buyer may choose for one line. Fixed lines allow only the link's own. */
function allowedRange(rule: OfferRule): { adjustable: boolean; min: number; max: number } {
  const adjustable = rule.min != null || rule.max != null;
  // A fixed optional line offered at 0 is added at 1.
  const fixed = Math.max(rule.linkQuantity, 1);
  if (!adjustable) return { adjustable, min: fixed, max: fixed };
  // A plan is never below one: a subscription without one is broken, not smaller.
  const floor = rule.kind === "plan" ? 1 : 0;
  return { adjustable, min: Math.max(rule.min ?? 1, floor), max: rule.max ?? 9999 };
}

/** What the buyer may change on a payment-link checkout, line by line (E3). */
async function checkoutOffer(ctx: CheckoutContext): Promise<CheckoutOfferView | null> {
  const rules = await offerRules(ctx);
  if (rules.length === 0) return null;
  const inCart = new Map(ctx.items.map((i) => [i.priceId, i.quantity]));
  return {
    lines: rules.map((r) => {
      const range = allowedRange(r);
      return {
        price: r.pricePublicId,
        name: r.name,
        amount: r.amount,
        quantity: inCart.get(r.priceId) ?? 0,
        adjustable: range.adjustable,
        min: range.min,
        max: range.max,
        optional: r.optional,
        image_url: r.imageUrl,
      };
    }),
  };
}

/**
 * The buyer changes one line of a payment-link checkout: a new quantity, or 0 to remove an
 * optional line, or a quantity on an optional line not yet chosen to add it. Only what the
 * link allows — the buyer can never add a price the link does not list.
 */
export async function setCheckoutItemQuantity(
  ctx: CheckoutContext,
  pricePublicId: string,
  quantity: number,
): Promise<void> {
  if (ctx.status !== "open") throw new CheckoutError("This checkout is already complete.");
  if (ctx.mode === "change" || !ctx.paymentLinkId)
    throw new CheckoutError("You cannot change the items on this checkout.");
  if (!Number.isInteger(quantity) || quantity < 0)
    throw new CheckoutError("Enter a whole number for the quantity.");
  const rules = await offerRules(ctx);
  const rule = rules.find((r) => r.pricePublicId === pricePublicId);
  if (!rule) throw new CheckoutError("This item is not part of this offer.");
  const range = allowedRange(rule);
  if (quantity === 0) {
    if (!rule.optional) throw new CheckoutError("You cannot remove this item.");
  } else if (quantity < range.min || quantity > range.max) {
    throw new CheckoutError(
      range.adjustable
        ? `Select a quantity from ${range.min} to ${range.max}.`
        : "You cannot change the quantity of this item.",
    );
  }
  const left = ctx.items.filter((i) => i.priceId !== rule.priceId).length + (quantity > 0 ? 1 : 0);
  if (left === 0) throw new CheckoutError("Your order needs at least one item.");
  await withTenant(ctx.organizationId, async (tx) => {
    await tx
      .delete(checkoutSessionItems)
      .where(
        and(
          eq(checkoutSessionItems.checkoutSessionId, ctx.sessionId),
          eq(checkoutSessionItems.priceId, rule.priceId),
        ),
      );
    if (quantity > 0) {
      await tx.insert(checkoutSessionItems).values({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        checkoutSessionId: ctx.sessionId,
        priceId: rule.priceId,
        quantity,
        position: rules.indexOf(rule),
      });
    }
    await tx
      .update(checkoutSessions)
      .set({ updatedAt: new Date() })
      .where(eq(checkoutSessions.id, ctx.sessionId));
  });
}

/** A purchase's invoice lines, rated from the session's one-time prices. */
async function purchaseLines(ctx: CheckoutContext): Promise<{
  currency: string;
  lines: InvoiceLineInput[];
} | null> {
  const desired = await resolveContextItems(ctx);
  if (desired.length === 0) return null;
  return {
    currency: desired[0]!.price.currency,
    lines: desired.map((d) => ({
      // What the buyer bought: the price's own customer-facing name, else the product's.
      description: d.price.externalName ?? d.productName,
      amountMinor: computeLineAmount(d.price, d.quantity),
      priceId: d.price.id,
      quantity: d.quantity,
      kind: "one_time",
    })),
  };
}

/** What a purchase costs today. Tax needs the buyer's address, so it waits for the details step. */
async function purchaseView(ctx: CheckoutContext): Promise<CheckoutPurchaseView | null> {
  const built = await purchaseLines(ctx);
  if (!built) return null;
  const biz = await withTenant(ctx.organizationId, (tx) =>
    tx.select().from(businesses).where(eq(businesses.id, ctx.businessId)).limit(1),
  ).then((r) => r[0] ?? null);
  const common = {
    save_payment_method: resolveStorefrontConfig(biz).oneTimeSavePaymentMethod,
    customer_pinned: ctx.customerPinned,
    currency: built.currency,
  };
  const subtotal = built.lines.reduce((n, l) => n + l.amountMinor, 0n);
  if (ctx.resultingCustomerId) {
    try {
      const p = await previewInvoiceFromLines({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        customerId: ctx.resultingCustomerId,
        currency: built.currency,
        lines: built.lines,
      });
      return {
        ...common,
        subtotal_minor: Number(p.subtotalMinor),
        tax_minor: Number(p.taxMinor),
        tax_lines: p.taxLines.map((t) => ({
          label: t.description,
          amount_minor: Number(t.amountMinor),
        })),
        total_minor: Number(p.totalMinor),
        amount_due_minor: Number(p.amountDueMinor),
        tax_known: true,
      };
    } catch (e) {
      log.warn("checkout purchase preview failed", { error: (e as Error)?.message });
    }
  }
  return {
    ...common,
    subtotal_minor: Number(subtotal),
    tax_minor: 0,
    tax_lines: [],
    total_minor: Number(subtotal),
    amount_due_minor: Number(subtotal),
    tax_known: false,
  };
}

export async function getCheckoutView(sessionCtx: CheckoutContext): Promise<CheckoutView | null> {
  const refusals = await sessionCouponRefusals(sessionCtx);
  // Every figure below is priced without the refused codes; `coupons` still lists them.
  const ctx =
    Object.keys(refusals).length > 0
      ? { ...sessionCtx, couponCodes: sessionCtx.couponCodes.filter((c) => !(c in refusals)) }
      : sessionCtx;
  const base = await withTenant(ctx.organizationId, async (tx) => {
    const [biz] = await tx
      .select()
      .from(businesses)
      .where(eq(businesses.id, ctx.businessId))
      .limit(1);
    if (!biz) return null;
    const rows: Array<{
      price: typeof prices.$inferSelect;
      kind: string;
      quantity: number;
      productName: string;
      imageUrl: string | null;
      redirectUrl: string | null;
    }> = [];
    for (const line of ctx.items) {
      const [row] = await tx
        .select({
          price: prices,
          kind: products.kind,
          productName: sql<string>`coalesce(${products.externalName}, ${products.name})`,
          imageUrl: products.imageUrl,
          redirectUrl: products.redirectUrl,
        })
        .from(prices)
        .innerJoin(products, eq(products.id, prices.productId))
        .where(eq(prices.id, line.priceId))
        .limit(1);
      if (!row) return null; // a price vanished — the session is no longer honorable
      rows.push({
        price: row.price,
        kind: row.kind,
        quantity: line.quantity,
        productName: row.productName,
        imageUrl: row.imageUrl,
        redirectUrl: row.redirectUrl,
      });
    }

    /**
     * The plan a differential add-on is priced AGAINST.
     *
     * The session's own plan line wins, because that is the plan the subscription will have
     * once this checkout completes — resolving against the current one is right only while
     * the same call leaves the plan alone (the distinction `resolveDifferentialAgainstPlanTx`
     * was split out for). A change session that touches only add-ons has no plan line, so it
     * falls back to the subscription's.
     */
    let planProductId = rows.find((r) => r.kind === "plan")?.price.productId ?? null;
    if (!planProductId && ctx.mode === "change" && ctx.subscriptionId) {
      const [live] = await tx
        .select({ productId: products.id })
        .from(subscriptionItems)
        .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
        .innerJoin(products, eq(products.id, prices.productId))
        .where(
          and(eq(subscriptionItems.subscriptionId, ctx.subscriptionId), eq(products.kind, "plan")),
        )
        .limit(1);
      planProductId = live?.productId ?? null;
    }

    // 0243 — the checkout half of `storefront_config.hide_zero_value_lines`; the portal's
    // twin lives in `GET /portal/v1/subscriptions` and the printed-document twin in
    // `invoice_customization` (see storefront-config.ts's docblock for why they're separate).
    const storefrontConfig = resolveStorefrontConfig(biz);

    const itemViews: CheckoutItemView[] = [];
    for (const r of rows) {
      // Differentials apply to add-ons priced against a plan; a plan prices itself, and a
      // tiered differential has no single rate to quote (the summary falls back to naming
      // the model, which at least does not claim "free").
      let effective: bigint | null = null;
      if (r.kind !== "plan" && planProductId) {
        const diff = await resolveDifferentialAgainstPlanTx(tx, planProductId, r.price);
        if (diff?.amountMinor != null) effective = diff.amountMinor;
      }
      // The SAME final amount `priceAmountSummary` will render — a real 0 is a zero-value
      // line; `null` (usage/tiered, no single rate) is NOT zero and always stays shown.
      const finalAmount = effective ?? r.price.amountMinor;
      if (storefrontConfig.hideZeroValueLines && finalAmount === 0n) continue;
      itemViews.push({
        // A price with no name of its own is shown by its product's, never its code.
        name: r.price.externalName ?? r.price.name ?? r.productName,
        amount: priceAmountSummary(r.price, effective),
        currency: r.price.currency,
        quantity: r.quantity,
        kind: r.kind,
        image_url: r.imageUrl,
      });
    }
    return {
      business: {
        name: biz.name,
        livemode: biz.livemode,
        logo_url: biz.logoUrl,
        icon_url: biz.iconUrl,
        favicon_url: biz.faviconUrl,
        brand_color: biz.brandColor,
        timezone: biz.timezone,
      },
      items: itemViews,
      coupons: sessionCtx.couponCodes,
      // A purchase has no coupon path yet (see `createCheckoutSession`).
      allow_coupons: ctx.mode === "purchase" ? false : biz.allowCustomerCoupons,
      coupon_refusals: refusals,
      // Effective: tax-locked keys already `mandatory` (0334). A customer the session did
      // not create keeps their own address book: no shipping section (see the customer route).
      field_config: {
        ...withAddressFieldLocks(
          resolveCheckoutFieldConfig(biz),
          addressFieldLocksFor((await liveTaxRegimesTx(tx, [biz.id])).get(biz.id) ?? []),
        ),
        ...(ctx.customerPinned ? { "shipping.address": "hide" as const } : {}),
      },
      collect_po_number: storefrontConfig.collectPoNumber,
      layout: storefrontConfig.checkoutLayout,
      wallets_first: storefrontConfig.walletsFirst,
      consentBase: {
        period:
          ctx.mode === "create" && storefrontConfig.recurringConsent ? recurringPeriod(rows) : null,
        termsUrl: storefrontConfig.termsUrl,
        privacyUrl: storefrontConfig.privacyUrl,
        termsRequired: storefrontConfig.requireTerms && ctx.mode !== "change",
        marketingOffered: storefrontConfig.marketingConsent && ctx.mode !== "change",
      },
      status: ctx.status,
      mode: ctx.mode,
      // The session's own redirect wins; else the product's after-payment page — the plan's,
      // or the first line's. Only an http(s) URL: older rows predate the field's validation.
      redirect_url:
        ctx.redirectUrl ??
        [(rows.find((r) => r.kind === "plan") ?? rows[0])?.redirectUrl].find(
          (u): u is string => !!u && /^https?:\/\//i.test(u),
        ) ??
        null,
      cancel_url: ctx.cancelUrl,
    };
  });
  if (!base) return null;
  // Both modes: a signup needs the taxed total as much as a change does, and it is the
  // same composition arithmetic either way.
  const nextPayment = await projectRecurringPayment(ctx);
  const offer = ctx.paymentLinkId ? await checkoutOffer(ctx) : null;
  const dueToday = ctx.mode === "create" ? await projectFirstPayment(ctx) : null;
  const { consentBase, ...baseView } = base;
  const consent: CheckoutConsentView = {
    recurring_text: consentBase.period
      ? recurringConsentText(baseView.business.name, consentBase.period, nextPayment)
      : null,
    terms_url: consentBase.termsUrl,
    privacy_url: consentBase.privacyUrl,
    terms_required: consentBase.termsRequired,
    marketing_offered: consentBase.marketingOffered,
  };
  const withOffer = {
    ...baseView,
    consent,
    ...(offer ? { offer } : {}),
    ...(dueToday ? { dueToday } : {}),
  };
  const withPayment = nextPayment ? { ...withOffer, nextPayment } : withOffer;
  /**
   * What the details step prefills from — see `CheckoutView.customer` for why this is on a
   * public link and what is deliberately left off it.
   *
   * Absent until the session HAS a customer: a create-mode buyer who has not submitted the
   * details step yet has nothing to prefill, and an absent key says that honestly. The
   * address goes through the same `billingAddress` serializer the operator and portal
   * surfaces use, rather than a second hand-rolled mapping that could drift from the
   * `address` body this very form posts back.
   */
  const pinnedCustomer = ctx.resultingCustomerId
    ? await getCustomerById(ctx.organizationId, ctx.resultingCustomerId)
    : null;
  // No customer yet: the operator's mint-time defaults, if any, prefill instead.
  const view = pinnedCustomer
    ? {
        ...withPayment,
        customer: {
          ...(ctx.customerPinned ? {} : { email: pinnedCustomer.email }),
          address: billingAddress(pinnedCustomer),
          tax_registration_number: pinnedCustomer.taxRegistrationNumber,
          // The default book entry's mirror, so "Edit details" round-trips the ship-to.
          ...(ctx.customerPinned
            ? {}
            : {
                shipping_address:
                  (pinnedCustomer.shippingAddress as Record<string, string | null> | null) ?? null,
              }),
        },
      }
    : ctx.prefill && ctx.mode !== "change"
      ? {
          ...withPayment,
          customer: {
            email: ctx.prefill.email ?? null,
            address: ctx.prefill.address ?? null,
            tax_registration_number: ctx.prefill.tax_registration_number ?? null,
          },
        }
      : withPayment;
  if (ctx.mode === "purchase") {
    const purchase = await purchaseView(ctx);
    return purchase ? { ...view, purchase } : view;
  }
  if (ctx.mode !== "change" || !ctx.subscriptionId) return view;

  const target = ctx.subscriptionId;
  const detail = await withTenant(ctx.organizationId, async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.id, target), notDeleted()))
      .limit(1);
    if (!sub) return null;
    const planRows = await tx
      .select({
        price: prices,
        kind: products.kind,
        itemPublicId: subscriptionItems.publicId,
        snapshot: subscriptionItems.priceSnapshot,
      })
      .from(subscriptionItems)
      .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
      .innerJoin(products, eq(products.id, prices.productId))
      .where(eq(subscriptionItems.subscriptionId, target));
    const planRow = planRows.find((r) => r.kind === "plan") ?? null;
    const planPrice = planRow?.price ?? null;
    // Auto-collection is always on, so a change with no card on file would fail
    // at charge time — the page needs to know whether to ask for one, and WHICH one it
    // would use. Ordered newest-first so the fallback matches `resolveChargeCandidates`.
    const pms = await tx
      .select({
        id: paymentMethods.id,
        type: paymentMethods.type,
        brand: paymentMethods.brand,
        last4: paymentMethods.last4,
        mandateRail: paymentMethods.mandateRail,
      })
      .from(paymentMethods)
      .where(and(eq(paymentMethods.customerId, sub.customerId), eq(paymentMethods.status, "valid")))
      .orderBy(desc(paymentMethods.createdAt));
    const charged =
      (sub.defaultPaymentMethodId
        ? pms.find((p) => p.id === sub.defaultPaymentMethodId)
        : undefined) ??
      pms[0] ??
      null;
    // The live prices are carried out as well — the proration lines name the plan being
    // LEFT, so humanizing them needs it.
    return {
      sub,
      planPrice,
      // The rate each live item is BILLED at, keyed by ITEM (not price): the mandatory-item
      // index permits a manual item at the same price, so a price-keyed map could hand one
      // item's frozen rate to the other. See `snapshotAmountSummary`.
      planSnapshot: asPriceSnapshot(planRow?.snapshot),
      snapshotByItem: new Map(
        planRows.map((r) => [r.itemPublicId, asPriceSnapshot(r.snapshot)] as const),
      ),
      livePrices: planRows.map((r) => r.price),
      hasPaymentMethod: pms.length > 0,
      charged,
    };
  });
  if (!detail) return view;

  let preview: CheckoutChangePreview | undefined;
  let blocked: { code: string; message: string } | null = null;
  /**
   * Items this operation DROPS, so the review page can say so.
   *
   * A removal is an absence, and an absence renders as nothing: the list draws the DESIRED
   * items plus the current plan, so unchecking an add-on simply made it disappear with no
   * mention that anything was removed or that money was coming back. Reported by a buyer,
   * not caught by a test (PROGRESS :306).
   *
   * Names come from `detail.livePrices` because `LiveItem` carries only ids — the removed
   * price is by definition still on the subscription at preview time, so it is in that set.
   */
  let removedItems: Array<{ name: string; amount: string; quantity: number }> = [];
  if (ctx.reactivate) {
    // A cancelled subscription has no term to prorate: the quote is the fresh term the
    // completion bills, over the same merged item set, from the same start.
    try {
      const desired = await resolveContextItems(ctx);
      const base = await reactivationBase(ctx.organizationId, target);
      const items =
        mergeReactivationItems(base, desired, ctx.replaceItemsList) ??
        base.map((b) => ({
          price: b.pricePublicId,
          quantity: b.quantity,
          unitPriceMinor: b.unitPriceMinor,
          freeQuantity: b.freeQuantity,
        }));
      const est = await estimateReactivate({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        subscriptionId: target,
        items,
        now: ctx.reactivateFrom ?? (await businessWallClock(ctx.businessId)),
      });
      preview = changePreviewFromEstimate(est, [
        ...detail.livePrices,
        ...desired.map((d) => d.price),
      ]);
    } catch (e) {
      log.warn("checkout reactivation estimate failed", { error: (e as Error)?.message });
    }
  } else
    try {
      const live = await loadLiveItems(ctx.organizationId, target);
      const desired = await resolveContextItems(ctx);
      const { changes, additions, removals } = planItemOperations(live, desired, {
        replaceItemsList: ctx.replaceItemsList,
      });
      /**
       * A removal is quoted from the item's `price_snapshot`, not the catalog — the same
       * figure the credit beneath the row is rated from, so the card cannot show a composition
       * that fails to add up to its own credit. `snapshotAmountSummary` carries the rest.
       *
       * ⚠️ WORDING CORRECTED 2026-09-01. This used to call the snapshot "the rate it was BILLED
       * at". It is not: it is the rate the item bills at NOW, and a plan change re-prices it
       * (F-17), so after a differential add-on moves ₹752 → ₹470 the snapshot reads ₹470 while
       * every past invoice line still reads ₹752. PROGRESS read that as a defect — a credit
       * rated at ₹470 against invoices raised at ₹752 — and proposed rating both this row and
       * the engine's credit off the newest billed line instead.
       *
       * MEASURED, and the proposal is wrong: `scripts/verify-rerate-accounting.ts` holds
       * twelve change shapes against the invariant *net booked == owed for the time actually
       * held*, and eleven close TO THE PAISA on the snapshot. They close because the change
       * ACCOUNTS for its own re-rate (it credits the old term at ₹752 and re-charges forward at
       * ₹470, or queues both halves when deferred), so the snapshot is exactly what the customer
       * still holds. Rating this quote off the ₹752 billed line would over-state the removal's
       * value by ₹16,920 on that fixture. The premise is right; only the sentence describing it
       * was.
       *
       * The differential lookup is the FALLBACK, for an item with no usable snapshot (one
       * predating the column, or a hand-inserted row). It resolves against the plan the
       * subscription has NOW — deliberately NOT the `planProductId` computed for the items
       * list above, which prefers the session's new plan line because an item being ADDED is
       * priced against the plan the subscription will have after the change. Without either,
       * a differential add-on reads its catalog column — `amount_minor = 0` (CAT-7) — and the
       * row renders "₹0.00 / month" struck through, above a four-figure credit for that same
       * line.
       */
      const currentPlanProductId = detail.planPrice?.productId ?? null;
      removedItems = await withTenant(ctx.organizationId, (tx) =>
        Promise.all(
          removals.map(async (r) => {
            const price = detail.livePrices.find((p) => p.publicId === r.pricePublicId);
            if (!price) return { name: r.pricePublicId, amount: "", quantity: r.quantity };
            const name = price.externalName ?? price.name ?? price.publicId;
            const snap = detail.snapshotByItem.get(r.itemPublicId);
            if (snap) return { name, amount: snapshotAmountSummary(snap), quantity: r.quantity };
            // Non-addons resolve to null inside the helper, so the plan line needs no guard.
            let effective: bigint | null = null;
            if (currentPlanProductId) {
              const diff = await resolveDifferentialAgainstPlanTx(tx, currentPlanProductId, price);
              if (diff?.amountMinor != null) effective = diff.amountMinor;
            }
            return { name, amount: priceAmountSummary(price, effective), quantity: r.quantity };
          }),
        ),
      );
      /**
       * The WHOLE operation is priced, not just the swap.
       *
       * This used to run only `changes` and gate the preview on `changes.length > 0`, from
       * when `estimateChange` could simulate nothing else. It grew `adds`/`removes` for the
       * dashboard's composition editor and this caller was left behind — so an add-on-only
       * change (the ordinary "add two seats" link) produced NO preview at all: the buyer
       * confirmed a purchase whose subtotal, TAX and amount due were never shown, having
       * seen only catalog per-month prices. A swap that also added an item showed a total
       * that excluded the addition, with a footnote admitting it.
       *
       * One estimate for the operation the confirm will actually apply, so the quote and
       * the invoice come from the same arithmetic (`verify:estimates` asserts estimate ==
       * applied booking).
       */
      // A COUPON-ONLY CHANGE IS A REAL SESSION. `CheckoutContext.items` says so in its own
      // comment ("may be empty in change mode — a coupon-only page is a valid flow"), and
      // `completeCheckout` applies those codes whether or not any line moved.
      // Gating the preview on the three item lists left that session's buyer confirming
      // with no quote at all — the same guard that had to come off the dashboard's
      // estimate route and server action.
      if (
        changes.length > 0 ||
        additions.length > 0 ||
        removals.length > 0 ||
        ctx.couponCodes.length > 0
      ) {
        const now = await businessWallClock(ctx.businessId);
        // The proration the confirm will use (the business rule for the direction), and
        // its refusal, so the page can warn before Confirm.
        const rules = await checkoutChangePolicy(ctx, target, { changes, additions, removals });
        blocked = planChangeRefusal(rules);
        const est = await estimateChange({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          subscriptionId: target,
          now,
          changes,
          adds: additions.map((a) => ({ priceId: a.price.publicId, quantity: a.quantity })),
          removes: removals.map((r) => r.itemPublicId),
          resetTerm: checkoutResetTerm(ctx, rules),
          prorate: prorateFor(rules.policy, rules.direction),
          // PENDING, exactly as on the dashboard: `completeCheckout` applies the item
          // operations first and these codes after, so they cannot discount the proration
          // this previews — they land on `next_renewal`. Passing them is what stops the
          // preview and the confirm disagreeing about the term that follows. Codes already
          // attached are the subscription's own discounts, which the estimate reads itself.
          couponCodes: await couponsToApply(ctx, target),
        });
        preview = changePreviewFromEstimate(est, [
          ...detail.livePrices,
          ...desired.map((d) => d.price),
        ]);
      }
    } catch (e) {
      // A preview is a nicety, not a gate — never block the page on it. Logged at warn
      // because a preview that fails for everyone is a broken estimate endpoint.
      log.warn("checkout preview estimate failed", { error: (e as Error)?.message });
    }

  /**
   * Sized here, on the page that gates the confirm button on it — and with the preview's
   * own figure handed over, so the proration is priced once rather than twice.
   *
   * Never allowed to break the page: a buyer who cannot see their plan change because a
   * mandate could not be sized is strictly worse off than one who is asked to
   * re-authorise a step later.
   */
  let mandate: CheckoutMandateRequirement | null = null;
  try {
    mandate = await resolveSessionMandateRequirement(ctx, {
      ...(preview ? { immediateDebitMinor: BigInt(preview.totalMinor) } : {}),
    });
  } catch (e) {
    log.warn("checkout mandate sizing failed", { error: (e as Error)?.message });
  }

  return {
    ...view,
    change: {
      subscriptionId: detail.sub.publicId,
      ...(ctx.reactivate
        ? { reactivation: { startsAt: ctx.reactivateFrom?.toISOString() ?? null } }
        : {}),
      currentPlan: detail.planPrice
        ? {
            name:
              detail.planPrice.externalName ?? detail.planPrice.name ?? detail.planPrice.publicId,
            // Same catalog-vs-snapshot trap as the removed rows, one row up. A plan is never
            // differential so it never read ₹0, but a grandfathered subscription — the
            // ordinary case for any catalog price that has moved since signup — was quoted
            // today's list price beside a credit computed from what it actually pays.
            amount: detail.planSnapshot
              ? snapshotAmountSummary(detail.planSnapshot)
              : priceAmountSummary(detail.planPrice),
          }
        : null,
      ...(preview ? { preview } : {}),
      ...(ctx.reactivate ? {} : { blocked }),
      ...(removedItems.length > 0 ? { removedItems } : {}),
      hasPaymentMethod: detail.hasPaymentMethod,
      ...(detail.charged
        ? {
            paymentMethod: {
              type: detail.charged.type,
              brand: detail.charged.brand,
              last4: detail.charged.last4,
              mandateRail: detail.charged.mandateRail,
            },
          }
        : {}),
      ...(mandate
        ? {
            mandate: {
              currency: mandate.currency,
              requiredCeilingMinor: Number(mandate.requiredCeilingMinor),
              largestDebitMinor: Number(mandate.largestDebitMinor),
              currentCeilingMinor: mandate.current ? Number(mandate.current.ceilingMinor) : null,
              currentRail: mandate.current?.rail ?? null,
              reauthorizationRequired: mandate.reauthorizationRequired,
              railsOverCap: mandate.railsOverCap,
            },
          }
        : {}),
    },
  };
}

export interface CheckoutCustomerInput {
  email: string;
  address?: CustomerAddress;
  /**
   * The buyer's OWN registration number (GSTIN for India) — `customers.tax_registration_number`,
   * NOT `vat_number` (the EU VIES id, a different column with its own validation lifecycle).
   * It prints on every invoice this checkout goes on to raise and is what the buyer's
   * finance team claims input tax credit against, so a B2B self-serve signup that cannot
   * supply it produces invoices they cannot use.
   */
  taxRegistrationNumber?: string;
  /**
   * The ship-to (0360), snake_case like the body. Becomes the customer's default book
   * entry. `undefined` = leave the book alone (section hidden); `null` = clear it.
   */
  shippingAddress?: Record<string, string | null | undefined> | null;
}

/**
 * Update the billing details of the customer this checkout is ALREADY bound to.
 *
 * Deliberately a different operation from `setCheckoutCustomer` below, because the security
 * boundary is not "billing details are untouchable" — it is "a public link must not decide WHICH
 * customer this checkout is about". That is the repointing risk the note below describes, and it
 * stays closed: this never creates a customer, never accepts an email, and refuses outright
 * unless the session already resolves to one.
 *
 * What it does grant is what a buyer legitimately owns and needs mid-checkout: their address,
 * phone and tax registration number. Without it a plan-change checkout was a dead end the moment
 * the gateway wanted something the details hold — RazorPay refuses to vault a card for recurring
 * payments with no phone number, and told the BUYER to "add a phone number to the customer",
 * which is an operator action they cannot perform.
 *
 * `email` is accepted ONLY in create mode, where `setCheckoutCustomer` delegates here on a
 * re-submitted details step (see its body). In change mode it is hard-refused: the email is the
 * pinned customer's identity, editing it would redirect their invoices, and this function is the
 * one a change link can reach.
 *
 * ⚠ RESIDUAL RISK, stated rather than hidden: whoever holds the link can edit that customer's
 * address and phone. Address feeds place-of-supply, so it can move tax. On a change link it
 * cannot redirect the invoice — email is refused there — and on neither mode can it point the
 * subscription at anyone else.
 */
export async function updateCheckoutCustomerDetails(
  ctx: CheckoutContext,
  input: {
    email?: string;
    address?: CustomerAddress | null;
    taxRegistrationNumber?: string | null;
    /** Create mode only: see `CheckoutCustomerInput.shippingAddress`. */
    shippingAddress?: Record<string, string | null | undefined> | null;
  },
): Promise<typeof customers.$inferSelect> {
  // A pinned customer's address book is theirs: the buyer changes it in the portal.
  if (input.shippingAddress !== undefined && ctx.customerPinned) {
    throw new CheckoutError(
      "This checkout is for an existing customer. You cannot change their shipping address here.",
    );
  }
  // SECURITY: see the note above — the pinned customer's email is not a change link's to edit.
  if (input.email !== undefined && ctx.customerPinned) {
    throw new CheckoutError(
      ctx.mode === "change"
        ? "This checkout changes an existing subscription. You cannot change the email of its customer."
        : "This checkout is for an existing customer. You cannot change their email.",
    );
  }
  if (!ctx.resultingCustomerId) {
    throw new CheckoutError("This checkout session has no customer");
  }
  const existing = await getCustomerById(ctx.organizationId, ctx.resultingCustomerId);
  if (!existing) throw new CheckoutError("The customer of this checkout session no longer exists");

  await updateCustomer({
    organizationId: ctx.organizationId,
    businessId: ctx.businessId,
    customerPublicId: existing.publicId,
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.address !== undefined ? { address: input.address } : {}),
    ...(input.taxRegistrationNumber !== undefined
      ? { taxRegistrationNumber: input.taxRegistrationNumber?.trim() || null }
      : {}),
    // Replaces the default book entry's fields, so a re-post never adds a second row.
    ...(input.shippingAddress ? { shippingAddress: input.shippingAddress } : {}),
  });
  if (input.shippingAddress === null) {
    // Archive rather than un-default: a later re-add then leaves no stray live row.
    const book = await listShippingAddresses(ctx.organizationId, existing.id);
    const def = book.find((a) => a.isDefault);
    if (def) {
      await archiveShippingAddress({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        customerId: existing.id,
        addressPublicId: def.publicId,
      });
    }
  }
  const fresh = await getCustomerById(ctx.organizationId, ctx.resultingCustomerId);
  if (!fresh) throw new CheckoutError("The customer of this checkout session no longer exists");
  return fresh;
}

/**
 * Bind this checkout to its customer: create a fresh one the FIRST time (never reuse by
 * email — public link; see the SECURITY note in the body), store `resulting_customer_id`
 * on the session, and return the customer row. A later call on the same session UPDATES
 * that same customer rather than minting another (see the note in the body).
 */
export async function setCheckoutCustomer(
  ctx: CheckoutContext,
  input: CheckoutCustomerInput,
): Promise<typeof customers.$inferSelect> {
  // SECURITY: in change mode the customer is pinned to the target subscription's
  // owner at mint time. Letting this PUBLIC link rewrite it would mean anyone
  // holding the link could repoint an existing subscription at a customer they
  // control, or overwrite the real customer's name/address. The buyer's identity
  // is not theirs to set here.
  if (ctx.customerPinned) {
    throw new CheckoutError(
      ctx.mode === "change"
        ? "This checkout changes an existing subscription. You cannot change its customer."
        : "This checkout is for an existing customer. You cannot change the customer.",
    );
  }
  const email = input.email.trim();
  if (!email) throw new CheckoutError("email is required");

  /**
   * SECOND AND LATER CALLS UPDATE THE CUSTOMER THIS SESSION ALREADY MINTED.
   *
   * This used to create unconditionally, so every re-post of the details step minted
   * another customer and repointed `resulting_customer_id` at it. That is ordinary
   * traffic, not an edge case: the card step's "Edit billing details" returns the buyer
   * to the details step, and the storefront client sends a fresh random Idempotency-Key
   * per call (correctly — see `dashboard/lib/checkout-api.ts`), so nothing deduped it.
   * Each edit orphaned a row carrying the buyer's email and address, and — worse — a card
   * already vaulted stayed attached to the ORPHAN, so completing through the setup intent
   * consumed an intent minted for one customer against a different one.
   *
   * SECURITY: this is not a relaxation of either rule below. We never LOOK UP a customer
   * by email (no enumeration, no PII echo, no grafting a card onto a stranger's record),
   * and we never repoint WHICH customer the session is about — the row we update is the
   * one this very session created. Updating it is a third act, distinct from both.
   *
   * The email IS updatable here, unlike change mode. Create mode already lets the link set
   * an arbitrary email on the first post, so re-posting a different one grants no new
   * capability — while refusing it would leave a buyer who typo'd their address with
   * invoices they can never receive and no way to fix it. Change mode refuses it, because
   * there the customer predates the link.
   *
   * Details are replaced, not merged (`?? null`), so the row ends up exactly as a fresh
   * create with this input would have left it — a cleared address clears.
   */
  if (ctx.resultingCustomerId) {
    const pinned = await getCustomerById(ctx.organizationId, ctx.resultingCustomerId);
    // A pinned customer deleted out-of-band falls through and mints a new one; the
    // alternative is a create-mode session that can never be completed.
    if (pinned) {
      return updateCheckoutCustomerDetails(ctx, {
        email,
        address: input.address ?? null,
        taxRegistrationNumber: input.taxRegistrationNumber ?? null,
        shippingAddress: input.shippingAddress,
      });
    }
  }

  // SECURITY: hosted checkout is a PUBLIC link, so we must NOT match/reuse an
  // existing customer by email — doing so would (a) leak whether an email is an
  // existing customer and echo their stored name (enumeration + PII harvest) and
  // (b) let anyone graft a card + subscription onto a stranger's customer record.
  // Always create a fresh customer; operators can dedupe by email out-of-band.
  const customer = await createCustomer({
    organizationId: ctx.organizationId,
    businessId: ctx.businessId,
    email,
    address: input.address ?? null,
    taxRegistrationNumber: input.taxRegistrationNumber?.trim() || null,
    // Lands in the address book as the default.
    shippingAddress: input.shippingAddress ?? null,
    // Hosted checkout collects no custom fields; Required applies to dashboard/API creates.
    skipRequiredCustomFields: true,
    // Nor metadata: the buyer cannot supply a business's required keys.
    metadataRules: "supplied_only",
  });

  await withTenant(ctx.organizationId, (tx) =>
    tx
      .update(checkoutSessions)
      .set({ resultingCustomerId: customer.id, updatedAt: new Date() })
      .where(eq(checkoutSessions.id, ctx.sessionId)),
  );
  ctx.resultingCustomerId = customer.id;
  return customer;
}

export interface CheckoutCompleteInput {
  /**
   * Provider token for the buyer's card. Optional ONLY in change mode when the
   * customer already has a usable card on file — an upgrade shouldn't force
   * re-entering a card that's already vaulted. Required in create mode.
   */
  paymentMethodToken?: string;
  /**
   * An instrument the CALLER already vaulted — the route resolved it by consuming the
   * setup intent this checkout began (`completeVaultFromIntent`), so there is no token
   * left to exchange. Takes precedence over `paymentMethodToken`; re-vaulting here would
   * be exactly the second write that path exists to avoid.
   */
  paymentMethodId?: string;
  gatewayAccountId?: string;
  /**
   * An intent the buyer already authorized (`pi_…`), returned by a previous
   * /complete that answered `CheckoutActionRequiredError`. Present = settle the
   * first invoice by CONSUMING it rather than charging the card again — the card
   * has already been authorized for exactly this amount.
   */
  paymentIntentId?: string;
  /** What the browser SDK returned for `paymentIntentId`'s `mode: 'sdk'` challenge. */
  clientResult?: Record<string, string>;
  /**
   * Where the gateway returns the buyer after a REDIRECT-mode challenge on the first
   * charge, and where it sends them if they back out.
   *
   * Reaches exactly one place: `chargeBeforeSubscriptionInvoice`, which forwards it to the
   * on-session intent it mints for a `requires_action` charge. Nothing else reads it — the
   * consume path is settling an authorization the buyer has already completed, and the
   * replay path answers before any of this runs.
   *
   * Absent = today's behaviour: a PayPal order with no `experience_context`, from which
   * there is no way back. `CheckoutActionRequiredError` still carries the approval URL, so
   * a client that can hold the buyer itself (a tab that stays open) still works — it just
   * has to do the holding.
   */
  returnUrl?: string;
  cancelUrl?: string;
  /**
   * 0243 — collected on the storefront only when `storefront_config.collect_po_number` is
   * on. Lands on `subscriptions.po_number`: `createSubscription` on create mode, a direct
   * update alongside the payment-method repoint on change mode (see the two call sites).
   */
  poNumber?: string;
}

export interface CheckoutResult {
  /** sub_… public id. Absent on a purchase, which creates no subscription. */
  subscriptionId?: string;
  /** mode='purchase': the inv_… the purchase raised. */
  invoiceId?: string;
  customerId: string; // cus_… public id
  /** The intent that settled the first invoice, when one was consumed. */
  paymentIntentId?: string;
  /** Set when that consume reached the gateway and the capture was refused. */
  paymentError?: { code: string; message: string };
  /**
   * CHANGE mode: the change was APPLIED but the invoice it raised was not collected.
   *
   * A change is not provisional the way a signup is — `completePlanChange` moves the
   * items, raises the proration invoice and collects, and a refused collection does not
   * throw: the invoice simply stays open and dunning parks it. So the completion used to
   * return plain success and the buyer was told "Plan updated" while holding an unpayable
   * invoice (measured 2026-08-18 for a mandate ceiling; a decline for any other reason
   * reads identically). Reported rather than raised, because the plan really did change —
   * telling the buyer it failed would be its own lie.
   */
  unpaidInvoice?: {
    /** `inv_…` — the buyer can settle it from the portal. */
    id: string;
    amountDueMinor: number;
    currency: string;
    /**
     * WHY it is open — see `collectionOutcomeFor`. `processing` means an attempt is
     * live at the gateway (an async mandate debit) and nobody has been refused; the
     * buyer's page must poll rather than announce a failure that has not happened.
     */
    state: "processing" | "outstanding";
    /** The gateway's (or the pre-flight's) own reason, when a failure was recorded. */
    failure?: { code: string; message: string };
  };
}

/**
 * The buyer must authenticate before the checkout can be completed (3DS, a UPI
 * mandate approval, a PayPal redirect).
 *
 * Only ever thrown for a hosted checkout, because that is the one flow where the
 * buyer is present BY CONSTRUCTION — no flag, no inference. Nothing was created:
 * the provisional subscription is discarded and the session claim released, so the
 * buyer completes `nextAction` and re-posts /complete with `payment_intent`.
 */
export class CheckoutActionRequiredError extends Error {
  constructor(
    readonly intent: PaymentIntent,
    readonly attempt: PaymentAttempt | null,
    message = "This payment needs your authentication before we can create the subscription",
  ) {
    super(message);
    this.name = "CheckoutActionRequiredError";
  }
}

/**
 * Apply a change session to its target subscription (#10b) — the
 * upgrade/downgrade/add-items/apply-coupons half of hosted checkout.
 *
 * Order matters and mirrors the operator create route's rationale: **coupons
 * first**, then item changes. `peekDiscounts` picks up the ACTIVE coupons when an
 * invoice is raised, so a coupon applied after the change would miss the very
 * proration invoice the buyer just consented to.
 *
 * All proration, credit-note issuing, tax reversal and collection stay in the
 * engine — checkout only orchestrates, exactly as create mode does.
 *
 * If a new card was vaulted it becomes the subscription's default payment method
 * BEFORE anything bills, so the resulting invoice is collected against the card
 * the buyer just entered rather than a stale one.
 */
/** One line of a subscription as a reactivation rebuilds it — its custom terms carried. */
interface ReactivationLine {
  priceId: string;
  pricePublicId: string;
  kind: string;
  quantity: number;
  unitPriceMinor: number | null;
  freeQuantity: number | null;
  billingCycles: number | null;
}

/** The subscription's items, with a custom unit price read off each item's snapshot. */
async function reactivationBase(
  organizationId: string,
  subscriptionId: string,
): Promise<ReactivationLine[]> {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({
        priceId: prices.id,
        pricePublicId: prices.publicId,
        kind: products.kind,
        quantity: subscriptionItems.quantity,
        freeQuantity: subscriptionItems.freeQuantity,
        billingCycles: subscriptionItems.billingCycles,
        snapshot: subscriptionItems.priceSnapshot,
      })
      .from(subscriptionItems)
      .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
      .innerJoin(products, eq(products.id, prices.productId))
      .where(eq(subscriptionItems.subscriptionId, subscriptionId)),
  );
  return rows.map((r) => {
    const snap = asPriceSnapshot(r.snapshot);
    return {
      priceId: r.priceId,
      pricePublicId: r.pricePublicId,
      kind: r.kind,
      quantity: r.quantity,
      unitPriceMinor: snap?.amountOverridden && snap.amountMinor != null ? snap.amountMinor : null,
      freeQuantity: r.freeQuantity ?? null,
      billingCycles: r.billingCycles ?? null,
    };
  });
}

/**
 * The item set a reactivation rebuilds, under the same rules as a change: a listed price
 * already on the subscription is a quantity; a listed plan replaces the plan; anything else is
 * added; `replace` drops unlisted non-plan lines. A line kept at its own price keeps its custom
 * rate. Undefined when nothing moves — the engine then keeps the items exactly as they are.
 */
export function mergeReactivationItems(
  base: ReactivationLine[],
  desired: Array<{ price: typeof prices.$inferSelect; quantity: number; kind: string }>,
  replace: boolean,
): ReactivationItemInput[] | undefined {
  if (desired.length === 0 && !replace) return undefined;
  const byPrice = new Map(base.map((b) => [b.priceId, b]));
  const lines: ReactivationLine[] = replace ? [] : base.map((b) => ({ ...b }));
  for (const d of desired) {
    const same = lines.find((l) => l.priceId === d.price.id);
    if (same) {
      same.quantity = d.quantity;
      continue;
    }
    if (d.kind === "plan") {
      const at = lines.findIndex((l) => l.kind === "plan");
      if (at >= 0) lines.splice(at, 1);
    }
    const kept = byPrice.get(d.price.id);
    lines.push(
      kept
        ? { ...kept, quantity: d.quantity }
        : {
            priceId: d.price.id,
            pricePublicId: d.price.publicId,
            kind: d.kind,
            quantity: d.quantity,
            unitPriceMinor: null,
            freeQuantity: null,
            billingCycles: null,
          },
    );
  }
  // A plan is never removed by omission, exactly as in a change.
  if (!lines.some((l) => l.kind === "plan")) {
    const plan = base.find((b) => b.kind === "plan");
    if (plan) lines.push({ ...plan });
  }
  lines.sort((a, b) => (a.kind === "plan" ? 0 : 1) - (b.kind === "plan" ? 0 : 1));
  return lines.map((l) => ({
    price: l.pricePublicId,
    quantity: l.quantity,
    unitPriceMinor: l.unitPriceMinor,
    freeQuantity: l.freeQuantity,
    billingCycles: l.billingCycles,
  }));
}

/**
 * The session's coupons onto a live subscription. `replaceCouponList` first removes the coupons
 * it does not name; a code already active is skipped, so a retried checkout does not stack it.
 */
/** Codes of the coupons active on the subscription. */
async function attachedCouponCodes(ctx: CheckoutContext, target: string): Promise<string[]> {
  const active = await withTenant(ctx.organizationId, (tx) =>
    tx
      .select({ code: coupons.code })
      .from(appliedCoupons)
      .innerJoin(coupons, eq(coupons.id, appliedCoupons.couponId))
      .where(and(eq(appliedCoupons.subscriptionId, target), eq(appliedCoupons.status, "active"))),
  );
  return active.map((a) => a.code);
}

/** The session's coupons that are not already active on the subscription. */
async function couponsToApply(ctx: CheckoutContext, target: string): Promise<string[]> {
  const activeCodes = new Set(await attachedCouponCodes(ctx, target));
  return ctx.couponCodes.filter((c) => !activeCodes.has(c));
}

async function applySessionCoupons(
  ctx: CheckoutContext,
  target: string,
  now: Date,
  opts: { suppressAll: boolean; itemsWillAnnounce?: boolean },
): Promise<void> {
  const active = await withTenant(ctx.organizationId, (tx) =>
    tx
      .select({ code: coupons.code })
      .from(appliedCoupons)
      .innerJoin(coupons, eq(coupons.id, appliedCoupons.couponId))
      .where(and(eq(appliedCoupons.subscriptionId, target), eq(appliedCoupons.status, "active"))),
  );
  const activeCodes = new Set(active.map((a) => a.code));
  const toApply = ctx.couponCodes.filter((c) => !activeCodes.has(c));
  if (ctx.replaceCouponList) {
    const wanted = new Set(ctx.couponCodes);
    const toRemove = [...activeCodes].filter((code) => !wanted.has(code));
    // A removal announces only when nothing later in this edit will: no items moving, no
    // coupon applied after it, and only the last one.
    for (const [i, code] of toRemove.entries()) {
      await removeDiscount(ctx.organizationId, target, code, {
        suppressSubscriptionChanged:
          opts.suppressAll ||
          !!opts.itemsWillAnnounce ||
          toApply.length > 0 ||
          i < toRemove.length - 1,
      });
    }
  }
  // One `subscription_changed` per edit: the item legs announce it when they move, else the
  // LAST coupon does. A reactivation announces itself, so it suppresses them all.
  for (const [i, code] of toApply.entries()) {
    await applyCouponToSubscription({
      organizationId: ctx.organizationId,
      businessId: ctx.businessId,
      subscriptionId: target,
      code,
      now,
      suppressSubscriptionChanged:
        opts.suppressAll || !!opts.itemsWillAnnounce || i < toApply.length - 1,
    });
  }
}

/**
 * Completion of a reactivating session: the cancelled subscription is rebuilt with the
 * session's items, its coupons applied, and its fresh term billed — through the same
 * `reactivateAndBill` as the operator route, so a failed charge refuses exactly as it does
 * there (the subscription is cancelled again and the session reopens for another card).
 */
async function completeReactivation(
  ctx: CheckoutContext,
  args: { now: Date; newPmId: string | null; poNumber?: string },
): Promise<CheckoutResult> {
  const target = ctx.subscriptionId;
  if (!target) throw new CheckoutError("This checkout has no target subscription");
  const [sub] = await withTenant(ctx.organizationId, (tx) =>
    tx
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.id, target), notDeleted()))
      .limit(1),
  );
  if (!sub) throw new CheckoutError("This subscription no longer exists");
  if (sub.status !== "cancelled") {
    throw new CheckoutError(
      "This subscription is no longer cancelled, so there is nothing to reactivate",
    );
  }
  // Re-checked here as well as at mint: a later cancellation moves the floor.
  if (ctx.reactivateFrom && sub.canceledAt && ctx.reactivateFrom < sub.canceledAt) {
    throw new CheckoutError("reactivate_from is before this subscription was cancelled");
  }
  if (args.newPmId || args.poNumber) {
    await withTenant(ctx.organizationId, (tx) =>
      tx
        .update(subscriptions)
        .set({
          ...(args.newPmId ? { defaultPaymentMethodId: args.newPmId } : {}),
          ...(args.poNumber ? { poNumber: args.poNumber } : {}),
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, target)),
    );
  }
  const items = mergeReactivationItems(
    await reactivationBase(ctx.organizationId, target),
    await resolveContextItems(ctx),
    ctx.replaceItemsList,
  );
  const [business] = await withTenant(ctx.organizationId, (tx) =>
    tx.select().from(businesses).where(eq(businesses.id, ctx.businessId)).limit(1),
  );
  const billedFrom = new Date();
  const result = await reactivateAndBill({
    organizationId: ctx.organizationId,
    businessId: ctx.businessId,
    business: business ?? null,
    subscription: sub,
    now: args.now,
    ...(ctx.reactivateFrom ? { termStart: ctx.reactivateFrom } : {}),
    withOptions: true,
    items,
    // The session's coupons not already on the subscription, so a charge taken first is
    // priced with them (the ones already on it are priced from the subscription).
    quote: { couponCodes: await couponsToApply(ctx, target) },
    // Coupons land on the live subscription before its invoice is raised.
    beforeBill: () => applySessionCoupons(ctx, target, args.now, { suppressAll: true }),
  });
  if (result.refused) throw new CheckoutError(result.refused.message);
  return finishChangeResult(ctx, target, billedFrom);
}

async function completePlanChange(
  ctx: CheckoutContext,
  args: { now: Date; newPmId: string | null; poNumber?: string },
): Promise<CheckoutResult> {
  const target = ctx.subscriptionId;
  if (!target) throw new CheckoutError("This checkout has no target subscription");

  // Re-checked at COMPLETION, not only at mint: a change link outlives the subscription it
  // points at, and every write below — the payment-method repoint, the items, the coupons —
  // would edit and re-bill a subscription that was deleted while the buyer held the link.
  const stillLive = await withTenant(
    ctx.organizationId,
    async (tx) =>
      (
        await tx
          .select({ id: subscriptions.id, metadata: subscriptions.metadata })
          .from(subscriptions)
          .where(and(eq(subscriptions.id, target), notDeleted()))
          .limit(1)
      )[0] ?? null,
  );
  if (!stillLive) throw new CheckoutError("This subscription no longer exists");

  // Billing rules (checked again here: `completeCheckout` checked them before vaulting).
  const { ops, rules } = await assertPlanChangeAllowed(ctx);

  if (args.newPmId) {
    await withTenant(ctx.organizationId, (tx) =>
      tx
        .update(subscriptions)
        .set({ defaultPaymentMethodId: args.newPmId, updatedAt: new Date() })
        .where(eq(subscriptions.id, target)),
    );
  }
  // 0243 — same shape as the payment-method repoint above: a direct, narrow write, not a
  // detour through `createSubscription` (create-mode only) or the invoicing module.
  if (args.poNumber) {
    await withTenant(ctx.organizationId, (tx) =>
      tx
        .update(subscriptions)
        .set({ poNumber: args.poNumber, updatedAt: new Date() })
        .where(eq(subscriptions.id, target)),
    );
  }

  // `ops` (planned above, before any write) decides who emits the one
  // `subscription_changed` for this edit.
  // The session's metadata is written by `applyItemOperations` below, and a change to it is
  // announced there too, so it counts as the item legs announcing.
  const metadataWillChange =
    ctx.metadata !== null && !isDeepStrictEqual(stillLive.metadata ?? null, ctx.metadata);
  const itemsWillAnnounce =
    ops.changes.length + ops.additions.length + ops.removals.length > 0 || metadataWillChange;

  /**
   * Coupons BEFORE the change, so the change's own invoice is discounted. atSignup:false →
   * `applyCouponToSubscription` emits `subscription_changed` for a standalone apply.
   *
   * ⚠️ EXACTLY ONE of those summaries survives a composite edit. Every coupon used to emit
   * its own, on top of the one `applyItemOperations` emits for the item legs: measured
   * 2026-08-27, one press of "Confirm change" with two coupons and a plan swap fired THREE
   * `subscription_changed` events, and a coupon-only change fired two. Same defect the item
   * legs were fixed for hours earlier, one path along.
   *
   * So: suppress the coupon summary when the item operations will announce the edit, and
   * otherwise let the LAST coupon carry it. Suppressing all of them would trade duplicates
   * for a MISSING event on a coupon-only change, which is the worse failure — a consumer can
   * ignore a repeat, but it cannot react to silence. `coupon_applied` still fires per coupon
   * either way.
   */
  await applySessionCoupons(ctx, target, args.now, { suppressAll: false, itemsWillAnnounce });

  /**
   * The instant before anything is billed, so the invoice check below can tell the
   * document THIS call raised from one that was already sitting open. A buyer with an
   * older unpaid invoice must not be told their plan change failed to collect.
   */
  const billedFrom = new Date();

  await applyItemOperations({
    organizationId: ctx.organizationId,
    businessId: ctx.businessId,
    subscriptionId: target,
    now: args.now,
    ops,
    resetTerm: checkoutResetTerm(ctx, rules),
    // Explicit, not the business default: the buyer is standing at a payment page
    // that quoted them a figure for this change. Deferring the proration into
    // unbilled charges (which an omission would now do for a business with
    // `default_invoice_immediately` off) would complete the checkout having
    // collected nothing for what it just quoted.
    invoiceImmediately: true,
    prorate: prorateFor(rules.policy, rules.direction),
    // Metadata last, once the change is billed — see `finishChangeResult`.
    ...(ctx.metadata !== null ? { metadata: ctx.metadata } : {}),
  });

  return finishChangeResult(ctx, target, billedFrom, { metadataWritten: true });
}

/**
 * The close of a change or reactivation: write the session's metadata (only now that the
 * change has happened and been billed) and report whether its invoice is still owed.
 */
async function finishChangeResult(
  ctx: CheckoutContext,
  target: string,
  billedFrom: Date,
  opts: { metadataWritten?: boolean } = {},
): Promise<CheckoutResult> {
  return withTenant(ctx.organizationId, async (tx) => {
    /**
     * Metadata LAST, and that ordering is the whole reason this is on the session.
     *
     * Everything above can refuse — the coupon, the item operations, the proration
     * invoice the buyer is paying. Writing the metadata here means it is written only
     * once the change it describes has actually happened and been billed. Reverse the
     * order and a refused charge leaves a subscription flagged for a destination the
     * customer never bought; skip it and the items move while the flag does not, which
     * bills for one thing and serves another. Both are reasons a core-destination
     * switch would refuse other vendors outright.
     *
     * `!== null` rather than a truthiness check: `{}` is a legitimate instruction to
     * clear the metadata, and `!ctx.metadata` would silently ignore it.
     */
    if (ctx.metadata !== null && !opts.metadataWritten) {
      const [cur] = await tx
        .select({ metadata: subscriptions.metadata })
        .from(subscriptions)
        .where(eq(subscriptions.id, target))
        .limit(1);
      if (cur && !isDeepStrictEqual(cur.metadata ?? null, ctx.metadata)) {
        const [row] = await tx
          .update(subscriptions)
          .set({ metadata: ctx.metadata, updatedAt: new Date() })
          .where(eq(subscriptions.id, target))
          .returning();
        // The reactivation announced itself before this write; the metadata change is its
        // own fact, so it gets its own `subscription_changed` carrying the new value.
        await emitEvent(tx, {
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          type: "subscription_changed",
          data: buildEventData(
            "subscription_changed",
            { id: row!.publicId, status: row!.status },
            row!.resourceVersion,
            { settings_only: true },
          ),
        });
      }
    }
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, target))
      .limit(1);
    const [cus] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, sub!.customerId))
      .limit(1);
    /**
     * Did the money actually move? `changeSubscription` raises the proration invoice and
     * collects inside the engine, and a refused collection is not an exception — so this
     * is the only place the buyer's own outcome can be read.
     *
     * Newest invoice for this subscription raised since `billedFrom` that is still OPEN
     * with something due. `posted` counts: an invoice that was never collected at all
     * (auto-collection off, no instrument) leaves the buyer just as much on the hook as a
     * decline does.
     */
    const [open] = await tx
      .select({
        id: invoices.id,
        publicId: invoices.publicId,
        due: invoices.amountDueMinor,
        cur: invoices.currency,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.subscriptionId, target),
          gte(invoices.createdAt, billedFrom),
          inArray(invoices.status, [...OPEN_INVOICE_STATUSES]),
          gt(invoices.amountDueMinor, 0n),
        ),
      )
      .orderBy(desc(invoices.createdAt))
      .limit(1);
    if (!open) return { subscriptionId: sub!.publicId, customerId: cus!.publicId };
    const outcome = await collectionOutcomeFor(tx, open.id);
    return {
      subscriptionId: sub!.publicId,
      customerId: cus!.publicId,
      unpaidInvoice: {
        id: open.publicId,
        amountDueMinor: Number(open.due),
        currency: open.cur,
        state: outcome.state,
        ...(outcome.failure ? { failure: outcome.failure } : {}),
      },
    };
  });
}

/**
 * Transaction statuses that mean the attempt is STILL LIVE at the gateway: nobody
 * has been refused, the outcome simply is not known yet. `in_progress` is an async
 * debit that settles by webhook (UPI Autopay, an e-mandate/NACH presentation, ACH,
 * SEPA); `timeout` and `needs_attention` are unknown outcomes the inbound
 * reconciler resolves. All three are booked by `collectInvoice`'s `bookPending`,
 * which deliberately leaves the invoice OPEN while it waits.
 */
const UNSETTLED_TRANSACTION_STATUSES: readonly string[] = [
  "in_progress",
  "timeout",
  "needs_attention",
];

/**
 * Why one open invoice is still open — read from its NEWEST payment transaction.
 *
 * "Open with money due" answers only that the balance stands; it does not say
 * whether anyone refused it. Three different things land in that same state and the
 * buyer is owed a different sentence for each:
 *
 *  - `processing` — an attempt is in flight. An Indian mandate debit is the common
 *    case: RazorPay answers `created`, the engine books `in_progress`, and the money
 *    arrives by webhook seconds-to-days later. Telling this buyer "we could not
 *    collect" is simply false — the debit is live, and it may well already have
 *    succeeded by the time they read it.
 *  - `outstanding` WITH a failure — a real refusal (a decline, a mandate ceiling).
 *    `mandate_ceiling_exceeded` lands here too: the pre-flight refusal is written as
 *    a failed transaction against the account that would have taken it, precisely so
 *    it is visible as a real attempt.
 *  - `outstanding` with NO failure — nothing was ever attempted (auto-collection
 *    off, no instrument on file). Money is due; nobody refused it.
 *
 * The NEWEST transaction decides, not "is there any failure anywhere": an invoice
 * that failed, was retried and is now mid-retry must read `processing`, and one
 * whose live attempt later failed must read the failure. Asking two independent
 * questions let those two disagree.
 */
async function collectionOutcomeFor(
  tx: Tx,
  invoiceId: string,
): Promise<{ state: "processing" | "outstanding"; failure?: { code: string; message: string } }> {
  const [latest] = await tx
    .select({
      status: transactions.status,
      code: transactions.errorCode,
      text: transactions.errorText,
      businessId: transactions.businessId,
    })
    .from(transactions)
    .where(and(eq(transactions.invoiceId, invoiceId), eq(transactions.type, "payment")))
    // `occurred_at` is the gateway's own clock and two attempts can share it (a
    // same-second retry), so `created_at` breaks the tie by insertion order.
    .orderBy(desc(transactions.occurredAt), desc(transactions.createdAt))
    .limit(1);
  if (!latest) return { state: "outstanding" };
  if (UNSETTLED_TRANSACTION_STATUSES.includes(latest.status)) return { state: "processing" };
  if (latest.status === "failed" || latest.status === "late_failed") {
    return {
      state: "outstanding",
      failure: {
        code: latest.code ?? "payment_failed",
        // The buyer reads this; the raw text stays on the transaction.
        message: await storedPayerDeclineMessage(
          tx,
          { businessId: latest.businessId, code: latest.code, message: latest.text },
          "The payment was not completed.",
        ),
      },
    };
  }
  // A success that did not clear the balance (a part payment, or a later charge on
  // the same invoice). Money is due and nothing is in flight.
  return { state: "outstanding" };
}

/**
 * The live state of the invoice a completed checkout left behind — the poll behind
 * the buyer's "payment is processing" screen.
 *
 * Scoped to the session's own customer, which is the whole ownership check: a public
 * checkout link must never become a way to read a stranger's invoice by id.
 * Returns null when the invoice is not this session's to see.
 */
export async function readCheckoutInvoiceState(
  ctx: CheckoutContext,
  invoicePublicId: string,
): Promise<null | {
  id: string;
  status: string;
  amountDueMinor: number;
  currency: string;
  state: "paid" | "processing" | "outstanding";
  failure?: { code: string; message: string };
}> {
  if (!ctx.resultingCustomerId) return null;
  return withTenant(ctx.organizationId, async (tx) => {
    const [inv] = await tx
      .select({
        id: invoices.id,
        publicId: invoices.publicId,
        status: invoices.status,
        due: invoices.amountDueMinor,
        cur: invoices.currency,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.publicId, invoicePublicId),
          eq(invoices.customerId, ctx.resultingCustomerId!),
        ),
      )
      .limit(1);
    if (!inv) return null;
    // Nullable in the schema; an invoice with no recorded balance owes nothing.
    const due = inv.due ?? 0n;
    // Settled is settled — `paid` (or voided/credited away) needs no transaction read.
    if (inv.status === "paid" || due <= 0n) {
      return {
        id: inv.publicId,
        status: inv.status,
        amountDueMinor: Number(due),
        currency: inv.cur,
        state: "paid" as const,
      };
    }
    const outcome = await collectionOutcomeFor(tx, inv.id);
    return {
      id: inv.publicId,
      status: inv.status,
      amountDueMinor: Number(due),
      currency: inv.cur,
      state: outcome.state,
      ...(outcome.failure ? { failure: outcome.failure } : {}),
    };
  });
}

/**
 * The result a COMPLETED session replays — the ids it produced, **plus the invoice it left
 * unpaid.**
 *
 * ONE builder, because `completeCheckout` reaches this state through two doors and they had
 * already drifted: the entry check replayed the invoice while the compare-and-set LOSER —
 * the second of two concurrent /complete posts, which is exactly the double-submit this is
 * for — returned the two bare ids and so reported a green success over an open invoice. That
 * is the same misreport `unpaidInvoice` exists to end, through a third door. Two copies of
 * this logic is how it came back; there is now one.
 *
 * Bounded by `completed_at`, which is what makes it precise rather than a guess: the invoice
 * this checkout raised was created DURING the completion, so it is the newest open one at or
 * before that stamp. A renewal raised days later is newer than the stamp and correctly
 * ignored — without the bound a replay would eventually start reporting an unrelated invoice
 * as the one this checkout failed to collect. A row with no `completed_at` (older sessions)
 * reports nothing rather than guessing.
 *
 * The state is read LIVE, not remembered: a buyer who has since paid in the portal gets the
 * success they have earned, and one whose async debit has since failed gets the real reason.
 * That is strictly better than the fresh path's snapshot.
 */
async function completedCheckoutResult(
  organizationId: string,
  session: {
    id: string;
    completedAt: Date | null;
    resultingSubscriptionId: string;
    resultingCustomerId: string;
  },
): Promise<CheckoutResult> {
  return withTenant(organizationId, async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, session.resultingSubscriptionId))
      .limit(1);
    const [cus] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, session.resultingCustomerId))
      .limit(1);
    const base = { subscriptionId: sub!.publicId, customerId: cus!.publicId };
    if (!session.completedAt) return base;
    const [open] = await tx
      .select({
        id: invoices.id,
        publicId: invoices.publicId,
        due: invoices.amountDueMinor,
        cur: invoices.currency,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.subscriptionId, session.resultingSubscriptionId),
          lte(invoices.createdAt, session.completedAt),
          inArray(invoices.status, [...OPEN_INVOICE_STATUSES]),
          gt(invoices.amountDueMinor, 0n),
        ),
      )
      .orderBy(desc(invoices.createdAt))
      .limit(1);
    if (!open) return base;
    const outcome = await collectionOutcomeFor(tx, open.id);
    return {
      ...base,
      unpaidInvoice: {
        id: open.publicId,
        amountDueMinor: Number(open.due),
        currency: open.cur,
        state: outcome.state,
        ...(outcome.failure ? { failure: outcome.failure } : {}),
      },
    };
  });
}

/** One purchase as the customer portal lists it. */
export interface CustomerPurchase {
  invoiceId: string;
  number: string | null;
  status: string;
  currency: string;
  totalMinor: number;
  createdAt: Date;
  paidAt: Date | null;
  items: Array<{ description: string; quantity: number; imageUrl: string | null }>;
  /** Money returned on this purchase so far. */
  refundedMinor: number;
}

/**
 * The customer's one-time purchases, newest first: invoices a purchase checkout raised and
 * completed. An operator's one-off invoice is not here — the customer did not buy it.
 */
export async function listCustomerPurchases(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  limit: number;
}): Promise<{ data: CustomerPurchase[]; hasMore: boolean }> {
  return withTenant(input.organizationId, async (tx) => {
    const rows = await tx
      .select({ inv: invoices })
      .from(checkoutSessions)
      .innerJoin(invoices, eq(invoices.id, checkoutSessions.resultingInvoiceId))
      .where(
        and(
          eq(checkoutSessions.businessId, input.businessId),
          eq(checkoutSessions.mode, "purchase"),
          eq(checkoutSessions.status, "completed"),
          eq(invoices.customerId, input.customerId),
        ),
      )
      .orderBy(desc(invoices.createdAt))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit).map((r) => r.inv);
    const ids = page.map((i) => i.id);
    const lines = ids.length
      ? await tx
          .select({
            invoiceId: invoiceLineItems.invoiceId,
            description: invoiceLineItems.description,
            quantity: invoiceLineItems.quantity,
            kind: invoiceLineItems.kind,
            // Through the line's price: the picture the product has NOW.
            imageUrl: products.imageUrl,
          })
          .from(invoiceLineItems)
          .leftJoin(prices, eq(prices.id, invoiceLineItems.priceId))
          .leftJoin(products, eq(products.id, prices.productId))
          .where(inArray(invoiceLineItems.invoiceId, ids))
      : [];
    const returned = ids.length
      ? await tx
          .select({ invoiceId: payments.invoiceId, amount: refunds.amountMinor })
          .from(refunds)
          .innerJoin(payments, eq(payments.id, refunds.paymentId))
          .where(and(inArray(payments.invoiceId, ids), eq(refunds.status, "succeeded")))
      : [];
    return {
      data: page.map((inv) => ({
        invoiceId: inv.publicId,
        number: inv.number,
        status: inv.status,
        currency: inv.currency,
        totalMinor: Number(inv.totalMinor),
        createdAt: inv.createdAt,
        paidAt: inv.paidAt,
        // Tax and discount rows are the invoice's arithmetic, not things that were bought.
        items: lines
          .filter(
            (l) => l.invoiceId === inv.id && !["tax", "discount", "rounding"].includes(l.kind),
          )
          .map((l) => ({
            description: l.description,
            quantity: l.quantity ?? 1,
            imageUrl: l.imageUrl ?? null,
          })),
        refundedMinor: returned
          .filter((r) => r.invoiceId === inv.id)
          .reduce((n, r) => n + Number(r.amount), 0),
      })),
      hasMore: rows.length > input.limit,
    };
  });
}

/** A completed purchase replayed: its ids, plus the invoice's live state if still unpaid. */
async function completedPurchaseResult(
  ctx: CheckoutContext,
  invoiceId: string,
): Promise<CheckoutResult> {
  const [row] = await withTenant(ctx.organizationId, (tx) =>
    tx
      .select({ publicId: invoices.publicId, customer: customers.publicId })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(eq(invoices.id, invoiceId))
      .limit(1),
  );
  if (!row) throw new CheckoutError("The invoice of this purchase no longer exists");
  const state = await readCheckoutInvoiceState(ctx, row.publicId);
  return {
    customerId: row.customer,
    invoiceId: row.publicId,
    ...(state && state.state !== "paid"
      ? {
          unpaidInvoice: {
            id: state.id,
            amountDueMinor: state.amountDueMinor,
            currency: state.currency,
            state: state.state,
            ...(state.failure ? { failure: state.failure } : {}),
          },
        }
      : {}),
  };
}

const PURCHASE_ACTION_MESSAGE = "This payment needs your authentication before we can complete it";

/**
 * Complete a one-time purchase.
 *
 * The money is authorised BEFORE any invoice exists: an intent for the amount due, on the
 * saved method when the buyer kept one, otherwise on whatever they pick in the gateway's
 * own sheet. Only an authorised intent gets an invoice, which it is then consumed into. So
 * an abandoned or declined attempt leaves nothing behind — no invoice, no email, no dunning.
 * A capture that still fails voids the invoice it was raised for.
 */
/**
 * Hand the browser SDK's result (`next_action.mode: 'sdk'`) to the gateway, before the
 * callers' `authorized` check, and answer the intent as it now stands. A refusal throws
 * a `CheckoutError` in the buyer's words.
 */
async function applyCheckoutClientResult(
  ctx: CheckoutContext,
  piId: string,
  clientResult: Record<string, string>,
): Promise<PaymentIntent | null> {
  let applied;
  try {
    applied = await applyClientResult(ctx.organizationId, ctx.businessId, piId, clientResult);
  } catch (e) {
    if (e instanceof PaymentIntentError) throw new CheckoutError(e.message);
    throw e;
  }
  if (applied?.outcome === "failed")
    throw new CheckoutError(
      `We could not take your payment. ${applied.failure!.message} We did not charge you. Try again, or use a different payment method.`,
    );
  return getPaymentIntent(ctx.organizationId, ctx.businessId, piId);
}

/**
 * The buyer-facing refusals `createPaymentIntent` can raise on a purchase, as the buyer's
 * `CheckoutError`. Only the card limit today: every other `PaymentIntentError` there is a
 * configuration fault (a gateway without intents, a bad pinned account) and must stay a 5xx.
 */
export function purchaseIntentRefusal(e: unknown): CheckoutError | null {
  return e instanceof PaymentIntentError && e.code === CARD_LIMIT_CODE
    ? new CheckoutError(CARD_LIMIT_MESSAGE)
    : null;
}

async function completePurchase(
  ctx: CheckoutContext,
  customer: typeof customers.$inferSelect,
  input: {
    pmId: string | null;
    paymentIntentId?: string;
    clientResult?: Record<string, string>;
    returnUrl?: string;
    cancelUrl?: string;
    poNumber?: string;
  },
): Promise<CheckoutResult> {
  const built = await purchaseLines(ctx);
  if (!built) throw new CheckoutError("This checkout has nothing to buy");
  {
    const { assertTopUpLimits, TopUpLimitError } = await import("@/modules/credits/packs");
    try {
      await withTenant(ctx.organizationId, (tx) =>
        assertTopUpLimits(tx, {
          businessId: ctx.businessId,
          currency: built.currency,
          lines: built.lines,
        }),
      );
    } catch (e) {
      if (e instanceof TopUpLimitError) throw new CheckoutError(e.message);
      throw e;
    }
  }
  const biz = await getBusinessById(ctx.organizationId, ctx.businessId);
  if (input.pmId && resolveStorefrontConfig(biz).oneTimeSavePaymentMethod === "never") {
    throw new CheckoutError("This business does not save payment methods for one-time purchases.");
  }
  const preview = await previewInvoiceFromLines({
    organizationId: ctx.organizationId,
    businessId: ctx.businessId,
    customerId: customer.id,
    currency: built.currency,
    lines: built.lines,
  });
  const dueMinor = preview.amountDueMinor;

  const raiseInvoice = () =>
    createManualInvoice({
      organizationId: ctx.organizationId,
      businessId: ctx.businessId,
      customerId: customer.id,
      currency: built.currency,
      lines: built.lines,
      applyTax: true,
      collect: false,
      ...(input.poNumber ? { poNumber: input.poNumber } : {}),
    }).then((r) => r.invoice);

  const settle = async (invoice: { id: string; publicId: string }): Promise<CheckoutResult> => {
    await withTenant(ctx.organizationId, (tx) =>
      tx
        .update(checkoutSessions)
        .set({
          status: "completed",
          resultingInvoiceId: invoice.id,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(checkoutSessions.id, ctx.sessionId)),
    );
    ctx.status = "completed";
    ctx.resultingInvoiceId = invoice.id;
    const state = await readCheckoutInvoiceState(ctx, invoice.publicId);
    return {
      customerId: customer.publicId,
      invoiceId: invoice.publicId,
      ...(state && state.state !== "paid"
        ? {
            unpaidInvoice: {
              id: state.id,
              amountDueMinor: state.amountDueMinor,
              currency: state.currency,
              state: state.state,
              ...(state.failure ? { failure: state.failure } : {}),
            },
          }
        : {}),
    };
  };

  const refused = (reason: string) =>
    new CheckoutPaymentRefusedError(
      `We could not take your payment. ${reason} We did not charge you. Try again, or use a different payment method.`,
    );

  /** Raise the invoice and consume the authorised intent into it. */
  const finish = async (intentPublicId: string): Promise<CheckoutResult> => {
    const invoice = await raiseInvoice();
    let failure: string | null = null;
    try {
      const consumed = await consumePaymentIntent(
        ctx.organizationId,
        ctx.businessId,
        intentPublicId,
        invoice.publicId,
      );
      if (!consumed) failure = "The payment is no longer available.";
      else if (captureRefused(consumed.charge))
        failure = consumed.charge?.failure?.message ?? "Your bank refused the payment.";
    } catch (e) {
      if (!(e instanceof PaymentIntentError)) throw e;
      failure = e.message;
    }
    if (failure) {
      try {
        await voidInvoice(ctx.organizationId, ctx.businessId, invoice.publicId, {
          comment: "Checkout payment was not completed",
        });
      } catch (e) {
        log.error(e, { event: "checkout_purchase_void_failed", invoice: invoice.publicId });
      }
      throw refused(failure);
    }
    return settle(invoice);
  };

  // Leg 2: the buyer completed the gateway's step for an intent this checkout started.
  if (input.paymentIntentId) {
    let intent = await getPaymentIntent(ctx.organizationId, ctx.businessId, input.paymentIntentId);
    // Same answer for "unknown" and "someone else's": a public link is not an oracle.
    if (!intent || intent.customerId !== customer.id)
      throw new CheckoutError(`No such payment intent: ${input.paymentIntentId}`);
    if (intent.amountMinor == null || BigInt(intent.amountMinor) !== dueMinor)
      throw new CheckoutError("The amount due changed after you started the payment. Start again.");
    if (input.clientResult)
      intent =
        (await applyCheckoutClientResult(ctx, intent.publicId, input.clientResult)) ?? intent;
    // Our row waits on the gateway's webhook; ask the gateway rather than wait for it.
    const ready = await authorizeFromGateway(ctx.organizationId, ctx.businessId, intent);
    if (!ready)
      // The storefront matches this text to retry a return that beat the gateway's webhook.
      throw new CheckoutError("Complete the payment step first.");
    return finish(ready.publicId);
  }

  // Nothing to collect (account credit covers it): the invoice settles on its own.
  if (dueMinor <= 0n) return settle(await raiseInvoice());

  const pmPublicId = input.pmId
    ? await withTenant(ctx.organizationId, (tx) =>
        tx
          .select({ publicId: paymentMethods.publicId })
          .from(paymentMethods)
          .where(eq(paymentMethods.id, input.pmId!))
          .limit(1),
      ).then((r) => r[0]?.publicId)
    : undefined;
  // The card limit is the buyer's answer; any other refusal is ours and stays a 500.
  const minted = await createPaymentIntent({
    organizationId: ctx.organizationId,
    businessId: ctx.businessId,
    purpose: "payment",
    flow: "one_time_purchase",
    customerPublicId: customer.publicId,
    ...(pmPublicId ? { paymentMethodPublicId: pmPublicId } : { letBuyerChooseMethod: true }),
    amountMinor: Number(dueMinor),
    currency: built.currency,
    session: "on_session",
    ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
    ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
  }).catch((e: unknown) => {
    throw purchaseIntentRefusal(e) ?? e;
  });
  const { intent, attempt } = minted;
  if (serializePaymentIntent(intent).next_action) {
    throw new CheckoutActionRequiredError(intent, attempt, PURCHASE_ACTION_MESSAGE);
  }
  if (intent.status !== "authorized") {
    throw refused("Your bank refused the payment.");
  }
  return finish(intent.publicId);
}

/**
 * Complete the checkout: vault the buyer's card for the stored customer, then
 * create a subscription for the session's price + quantity with that card as
 * the default payment method. Marks the session `completed` and records the
 * resulting subscription. Idempotent-ish: a second call on a completed session
 * returns the already-stored ids without re-charging.
 */
export async function completeCheckout(
  ctx: CheckoutContext,
  input: CheckoutCompleteInput,
): Promise<CheckoutResult> {
  // A card entered or picked on this page is the one charged — no fallback to older ones.
  const buyerChoseCard = Boolean(input.paymentMethodId || input.paymentMethodToken);
  return buyerChoseCard
    ? runChargingChosenCardOnly(() => completeCheckoutInner(ctx, input))
    : completeCheckoutInner(ctx, input);
}

async function completeCheckoutInner(
  ctx: CheckoutContext,
  input: CheckoutCompleteInput,
): Promise<CheckoutResult> {
  /**
   * Already completed? Replay the stored result (no re-charge) — including the invoice it
   * left unpaid. `completedCheckoutResult` says why that matters and how it is bounded.
   *
   * `completed_at` is re-read from the row rather than taken from `ctx`, which does not
   * carry it.
   */
  if (ctx.status === "completed" && ctx.mode === "purchase" && ctx.resultingInvoiceId) {
    return completedPurchaseResult(ctx, ctx.resultingInvoiceId);
  }
  if (ctx.status === "completed" && ctx.resultingSubscriptionId && ctx.resultingCustomerId) {
    const [sess] = await withTenant(ctx.organizationId, (tx) =>
      tx
        .select({ completedAt: checkoutSessions.completedAt })
        .from(checkoutSessions)
        .where(eq(checkoutSessions.id, ctx.sessionId))
        .limit(1),
    );
    return completedCheckoutResult(ctx.organizationId, {
      id: ctx.sessionId,
      completedAt: sess?.completedAt ?? null,
      resultingSubscriptionId: ctx.resultingSubscriptionId,
      resultingCustomerId: ctx.resultingCustomerId,
    });
  }

  if (!ctx.resultingCustomerId) {
    throw new CheckoutError("This checkout session has no customer");
  }
  const customer = await getCustomerById(ctx.organizationId, ctx.resultingCustomerId);
  if (!customer) throw new CheckoutError("The customer of this checkout session no longer exists");

  // A required ship-to holds at completion too: an API client can post the email alone.
  // A customer the session did not create is exempt (no shipping section for them).
  if (!ctx.customerPinned) {
    const biz = await getBusinessById(ctx.organizationId, ctx.businessId);
    if (resolveCheckoutFieldConfig(biz)["shipping.address"] === "mandatory") {
      const book = await listShippingAddresses(ctx.organizationId, customer.id);
      if (!book.some((a) => a.isDefault)) {
        throw new CheckoutError(
          "We could not complete the checkout. A shipping address is required. Add a shipping address and try again.",
        );
      }
    }
  }

  // Atomically claim the session (open → completing) BEFORE any charge. Only one
  // concurrent /complete can win the compare-and-set, so two parallel calls can
  // never both vault a card + create a subscription (double-charge). The loser
  // replays the completed result or is told it's in progress.
  const claimed = await withTenant(ctx.organizationId, (tx) =>
    tx
      .update(checkoutSessions)
      .set({ status: "completing", updatedAt: new Date() })
      .where(and(eq(checkoutSessions.id, ctx.sessionId), eq(checkoutSessions.status, "open")))
      .returning({ id: checkoutSessions.id }),
  );
  if (claimed.length === 0) {
    const [s] = await withTenant(ctx.organizationId, (tx) =>
      tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, ctx.sessionId)).limit(1),
    );
    // The SAME replay the entry check above serves, through the same builder. This branch
    // is reached by the loser of two concurrent /complete posts — a double-submit — so it
    // is exactly the case that must not report a green success over an unpaid invoice.
    if (s?.status === "completed" && s.mode === "purchase" && s.resultingInvoiceId) {
      return completedPurchaseResult(ctx, s.resultingInvoiceId);
    }
    if (s?.status === "completed" && s.resultingSubscriptionId && s.resultingCustomerId) {
      return completedCheckoutResult(ctx.organizationId, {
        id: s.id,
        completedAt: s.completedAt,
        resultingSubscriptionId: s.resultingSubscriptionId,
        resultingCustomerId: s.resultingCustomerId,
      });
    }
    throw new CheckoutError("Another request is already completing this checkout");
  }

  // Events the auto-collect-ON create path withholds until its first charge lands
  // (see below). Empty — and therefore inert — on change mode and every other path.
  const deferred: DeferredEvents = [];
  let deferredEmitted = false;
  /** Set when the first invoice was settled by consuming `input.paymentIntentId`. */
  let consumedIntentId: string | undefined;
  /** Set when that consume reached the gateway and the capture was refused. */
  let consumedPaymentError: { code: string; message: string } | undefined;

  try {
    // A plan change the business's rules refuse is refused before ANY write: no card is
    // vaulted or made primary for a change that will not happen.
    if (ctx.mode === "change" && !ctx.reactivate) await assertPlanChangeAllowed(ctx);

    // Vault the buyer's card (raw card never touches us — PCI SAQ-A). In change
    // mode a token is optional: reuse the card already on file if none is given.
    let pmId: string | null = null;
    if (input.paymentMethodId) {
      // Already vaulted, through the setup intent — see `CheckoutCompleteInput`.
      pmId = input.paymentMethodId;
    } else if (input.paymentMethodToken && !(ctx.mode === "purchase" && input.paymentIntentId)) {
      // A purchase's second leg re-sends the first leg's token; the intent already holds
      // the money, so saving the method again would only add a duplicate.
      const pm = await vaultPaymentMethod({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        customer,
        token: input.paymentMethodToken,
        gatewayAccountId: input.gatewayAccountId,
      });
      pmId = pm.id;
    } else if (ctx.mode === "create") {
      throw new CheckoutError("A payment method token is required to complete this checkout");
    }

    // API-boundary simulated time (mirror the operator create route).
    const now = await businessWallClock(ctx.businessId);

    /**
     * THE INSTRUMENT THIS CHECKOUT WILL BILL BECOMES THE CUSTOMER'S DEFAULT.
     *
     * Whether the buyer added it or picked it from "Manage cards", they chose it on a
     * PAYMENT step in order to pay for this subscription — so leaving collection pointed at
     * an older instrument contradicts the only thing they were asked. It matters most in the
     * case that sent them here: they re-authorised because the card on file could not carry
     * the plan, and the new mandate is registered at the higher ceiling. A subscription
     * default alone would not do it — another subscription, a dunning retry or an ad-hoc
     * collection all resolve through the CUSTOMER's primary.
     *
     * Through `assignPaymentMethodRole` rather than a bare column write: it demotes the
     * previous primary in the same transaction and writes the audit row, because this is a
     * deliberate re-pointing of where the money comes from and someone will ask later.
     *
     * The old instrument is NOT removed. Its mandate is smaller, not broken, so it remains a
     * legitimate backup for smaller invoices — which is exactly what `isHardDecline` relies
     * on when a ceiling refusal moves on to the next candidate.
     */
    if (pmId) {
      const [row] = await withTenant(ctx.organizationId, (tx) =>
        tx
          .select({ publicId: paymentMethods.publicId })
          .from(paymentMethods)
          .where(eq(paymentMethods.id, pmId!))
          .limit(1),
      );
      if (row) {
        await assignPaymentMethodRole(ctx.organizationId, customer.id, row.publicId, "primary");
      }
    }

    if (ctx.mode === "purchase") {
      return await completePurchase(ctx, customer, {
        pmId,
        ...(input.paymentIntentId ? { paymentIntentId: input.paymentIntentId } : {}),
        ...(input.clientResult ? { clientResult: input.clientResult } : {}),
        ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
        ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
        ...(input.poNumber ? { poNumber: input.poNumber } : {}),
      });
    }

    if (ctx.mode === "change") {
      const result = await (ctx.reactivate ? completeReactivation : completePlanChange)(ctx, {
        now,
        newPmId: pmId,
        ...(input.poNumber ? { poNumber: input.poNumber } : {}),
      });
      await withTenant(ctx.organizationId, (tx) =>
        tx
          .update(checkoutSessions)
          .set({
            status: "completed",
            resultingSubscriptionId: ctx.subscriptionId,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(checkoutSessions.id, ctx.sessionId)),
      );
      ctx.status = "completed";
      ctx.resultingSubscriptionId = ctx.subscriptionId;
      return result;
    }

    // Resolve the session's items → SubscriptionItemInput (mirror subscription-routes.ts).
    const desired = await resolveContextItems(ctx);
    if (desired.length === 0) throw new CheckoutError("This checkout has no items to subscribe to");
    const items: SubscriptionItemInput[] = desired.map((d) => ({
      price: d.price,
      quantity: d.quantity,
    }));

    // Mirrors the operator create route (src/api/subscription-routes.ts): with
    // auto-collection ON the subscription is only PROVISIONAL until the first charge
    // clears — the hosted page refuses the signup leaving NOTHING behind. So its
    // lifecycle events are
    // buffered rather than emitted: a webhook the outbox already delivered
    // cannot be unsent, and rows deleted afterwards would still have told the
    // integration to provision access.
    //
    // A checkout never sets trial_days or a future start_date, so the only
    // reasons nothing is charged now are the plan price's configured
    // trial_period (auto-applied by createSubscription) and an
    // auto-collection-OFF buyer. Both keep the old, un-deferred path.
    const planTrialPeriod =
      desired.find((d) => d.price.type === "recurring")?.price?.trialPeriod ?? 0;
    const chargesNow = isAutoCollectOn(null, customer.autoCollection) && planTrialPeriod <= 0;

    // Pin the ship-to the buyer entered here. A customer the session did not create is
    // not pinned: null ships to whatever default they keep in the portal.
    const shipToPublicId = ctx.customerPinned
      ? null
      : ((await listShippingAddresses(ctx.organizationId, customer.id)).find((a) => a.isDefault)
          ?.publicId ?? null);

    const { subscription } = await createSubscription({
      organizationId: ctx.organizationId,
      businessId: ctx.businessId,
      customerId: customer.id,
      now,
      items,
      defaultPaymentMethodId: pmId!,
      deferEventsTo: chargesNow ? deferred : undefined,
      skipRequiredCustomFields: true,
      // Checked against the rules when the operator minted the session.
      metadataRules: "off",
      // Straight through on create — no ordering hazard here, because the subscription
      // does not exist until this call and is provisional until its first charge clears
      // (`discardProvisional` below removes it if that charge is refused). So metadata
      // cannot outlive a failed signup the way it could outlive a failed CHANGE.
      ...(ctx.metadata !== null ? { metadata: ctx.metadata } : {}),
      // 0243 — collected on the storefront's details/complete step when this business has
      // `storefront_config.collect_po_number` on. Lands straight on the new row's own
      // `po_number` column.
      ...(input.poNumber ? { poNumber: input.poNumber } : {}),
      ...(shipToPublicId ? { shippingAddressPublicId: shipToPublicId } : {}),
    });
    /** Undo a provisional (never-billed, never-announced) subscription. */
    const discardProvisional = async () =>
      deleteProvisionalSubscription({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        subscriptionId: subscription.id,
      });

    // Coupons applied AT SIGNUP discount the FIRST invoice, so they must land after
    // the subscription exists but BEFORE it is billed — the invoice plan's peekDiscounts
    // reads the active coupons. atSignup:true folds these into subscription_created (no
    // subscription_changed), matching the operator create route exactly.
    for (const code of ctx.couponCodes) {
      try {
        await applyCouponToSubscription({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          subscriptionId: subscription.id,
          code,
          now,
          atSignup: true,
          deferEventsTo: chargesNow ? deferred : undefined,
          // Counts toward the portal's cap on this subscription later (0495).
          enteredByCustomer: ctx.customerCouponCodes.some(
            (c) => c.toLowerCase() === code.toLowerCase(),
          ),
        });
      } catch (e) {
        // A provisional subscription has announced nothing yet — a coupon that
        // no longer applies refuses the whole checkout rather than leaving a
        // silent orphan. (Codes are validated at mint, so this is the rare
        // "it expired / ran out between mint and complete" case.)
        // Delete FIRST, drop the buffer only once the row is really gone: if the
        // delete fails the subscription survives, and the outer catch must still
        // flush its events rather than leave it existing-but-unannounced.
        if (chargesNow) {
          await discardProvisional();
          deferred.length = 0;
        }
        throw e;
      }
    }

    // BILL THE FIRST PERIOD. The hosted page collects on the spot — the
    // subscription is created BY a successful payment. Until this was added,
    // completing a checkout produced an ACTIVE subscription with no invoice and no
    // charge, i.e. the buyer got the product free until the next renewal tick.
    // Mirrors the operator create route (subscription-routes.ts): bill in advance
    // for an active sub; a trial is billed at trial end by the billing clock.
    if (subscription.status === "active") {
      // Checkout only bills a subscription that is ACTIVE, and only an active one has a
      // term (a trial has none since 2026-08-25). Stated rather than asserted.
      const coTerm = requireTerm(subscription);
      const billInput = {
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        subscription,
        periodStart: coTerm.start,
        periodEnd: coTerm.end,
      };
      // Re-derive the gate from the PERSISTED row: `isAutoCollectOn` gives the
      // subscription's own setting precedence over the customer's, and only the
      // created row knows what it resolved to. Charging first is taken only when
      // the pre-creation prediction agrees, because that prediction is what
      // decided to withhold the events this path has to commit — if it said "no
      // charge", the events are already out and a decline must not delete an
      // announced subscription.
      const collectsNow = isAutoCollectOn(subscription.autoCollection, customer.autoCollection);
      if (chargesNow && collectsNow) {
        // CHARGE FIRST. Plan the invoice read-only, take
        // the money, and only then persist anything: a decline leaves NO
        // subscription, NO invoice and NO events — instead of the cancelled sub +
        // voided invoice + full webhook trail that compensating after the fact
        // produced.
        const plan = await planSubscriptionPeriodInvoice(billInput);
        const plannedDue = plan.mode === "finalize" ? plan.money.amountDue : 0n;
        let charge: CompletedCharge | undefined;
        // Set when the registration's own payment pays this invoice (first-charge claim held).
        let registration: { charge: CompletedCharge; intentId: string } | null = null;

        // The buyer authenticated on a previous /complete and came back with the
        // intent: CONSUME it instead of charging the card a second time. The invoice
        // has to exist first (an intent is consumed INTO one), so it is committed
        // with `collect: false` and settled by the consume.
        if (input.paymentIntentId && plannedDue > 0n) {
          const piId = input.paymentIntentId;
          let intent = await getPaymentIntent(ctx.organizationId, ctx.businessId, piId);
          const refuse = async (message: string): Promise<never> => {
            await discardProvisional();
            deferred.length = 0;
            throw new CheckoutError(message);
          };
          if (!intent) await refuse(`No such payment intent: ${piId}`);
          else if (intent.customerId !== customer.id)
            await refuse(`Payment intent ${piId} belongs to a different customer`);
          else if (intent.currency !== subscription.currency)
            await refuse(
              `Payment intent ${piId} is in ${intent.currency}, but this subscription bills in ${subscription.currency}`,
            );
          else if (intent.amountMinor !== plannedDue)
            await refuse(
              `Payment intent ${piId} authorized ${intent.amountMinor}, but the amount due is ${plannedDue}`,
            );
          else if (input.clientResult) {
            try {
              intent = await applyCheckoutClientResult(ctx, piId, input.clientResult);
            } catch (e) {
              if (e instanceof CheckoutError) await refuse(e.message);
              throw e;
            }
          }
          // Ask the gateway before refusing: our row waits on its webhook. The storefront
          // matches "Complete the authentication first" to retry a return that beat it.
          if (intent && !(await authorizeFromGateway(ctx.organizationId, ctx.businessId, intent)))
            await refuse(
              `Payment intent ${piId} is ${intent.status}. Complete the authentication first.`,
            );

          const committed = await commitSubscriptionPeriodInvoice(plan, {
            preEvents: deferred,
            collect: false,
          });
          deferredEmitted = true;
          try {
            const consumed = await consumePaymentIntent(
              ctx.organizationId,
              ctx.businessId,
              piId,
              committed.invoice.publicId,
            );
            if (captureRefused(consumed?.charge)) {
              consumedPaymentError = {
                code: consumed.charge.failure?.code ?? "capture_failed",
                message: consumed.charge.failure?.message ?? "We could not capture the payment.",
              };
            }
            consumedIntentId = consumed?.intent.publicId;
          } catch (e) {
            // The subscription + invoice are already committed here, so this is NOT a
            // "leave nothing behind" case: the checkout completed, the invoice is
            // simply still open. Surface the reason and let it stand.
            if (e instanceof PaymentIntentError) {
              consumedPaymentError = { code: "payment_intent_unusable", message: e.message };
            } else throw e;
          }
        } else if (
          plannedDue > 0n &&
          (registration = await registrationFirstCharge(
            ctx,
            pmId ? { id: pmId } : null,
            plannedDue,
          ))
        ) {
          charge = registration.charge;
          // The mandate registration already collected the first invoice: book it, charge
          // nothing. Its delayed setup refund then finds it booked and stands down.
        } else if (plannedDue > 0n) {
          const outcome = await chargeBeforeSubscriptionInvoice({
            organizationId: ctx.organizationId,
            businessId: ctx.businessId,
            customerId: customer.id,
            subscription,
            amountMinor: plannedDue,
            currency: subscription.currency,
            // A hosted checkout IS on-session: the buyer is on the page that made
            // this request. Nothing to declare and nothing to infer.
            session: "on_session",
            // …and on-session is precisely when a redirect challenge has somewhere to
            // return TO. Only the redirect arm consumes these (PayPal's
            // `experience_context`); Stripe's client_secret and RazorPay's checkout
            // challenge both complete in the buyer's current page and ignore them.
            ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
            ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
          });
          if (outcome.kind === "action_required") {
            // Not a decline — the buyer has a challenge to complete. Same cleanup as
            // a decline (nothing created, nothing announced); the outer catch
            // releases the session claim so /complete can be re-posted with the
            // intent once the challenge is done.
            await discardProvisional();
            deferred.length = 0;
            throw new CheckoutActionRequiredError(outcome.intent, outcome.attempt);
          }
          if (outcome.kind === "declined") {
            // Delete first, then drop the buffer (see the coupon path above):
            // a subscription that outlives a failed delete must still be
            // announced by the outer catch.
            await discardProvisional();
            deferred.length = 0;
            // The outer catch releases the session claim, so the buyer can try
            // another card on the same link.
            throw new CheckoutPaymentRefusedError(
              `Your payment was declined, so we did not create the subscription: ${outcome.payerMessage}`,
            );
          }
          // A pending/unknown gateway outcome is NOT a refusal: the money may
          // well have moved, so the signup stands and the reconciler settles it.
          // `deferred` (a notice rail): the commit below collects through the notice gate.
          if (outcome.kind === "charged") charge = outcome.charge;
        }
        try {
          // The intent path already committed (it needed an invoice to consume
          // into) — `deferredEmitted` is what records that it did.
          if (!deferredEmitted) {
            await commitSubscriptionPeriodInvoice(plan, { preEvents: deferred, charge });
            deferredEmitted = true;
          }
        } catch (e) {
          if (registration) {
            // Not booked after all: hand the payment to its setup refund, now.
            await releaseFirstCharge(ctx.organizationId, registration.intentId, null);
            await nudgeSetupAuthRefund(
              registration.charge.gatewayKey,
              registration.charge.result.providerChargeId,
            );
            if (e instanceof ChargeAmountMismatchError) {
              await discardProvisional();
              deferred.length = 0;
              throw new CheckoutError(
                "The amount due changed while we took your payment, so we did not create the subscription. " +
                  "We will refund the payment. Try again.",
              );
            }
            throw e;
          }
          if (e instanceof ChargeAmountMismatchError && charge) {
            // The customer's credit balance moved between planning and
            // committing, so the invoice would bill an amount we did not
            // charge. Nothing was written or emitted (the commit tx rolled
            // back) — put the money straight back and refuse loudly.
            const refund = await refundPreInvoiceCharge({
              organizationId: ctx.organizationId,
              businessId: ctx.businessId,
              charge,
              currency: subscription.currency,
              reason: "invoice_amount_mismatch",
            });
            await discardProvisional();
            deferred.length = 0;
            if (!refund.refunded) {
              log.error("refund FAILED for a pre-invoice charge — manual intervention required", {
                event: "preinvoice_refund_failed",
                providerChargeId: charge.result.providerChargeId,
                amountMinor: charge.amountMinor,
                currency: subscription.currency,
                error: refund.error ?? "unknown",
              });
            }
            throw new CheckoutError(
              "The amount due changed while we took your payment, so we did not create the subscription. " +
                (refund.refunded
                  ? "We refunded the charge. "
                  : "We could NOT refund the charge automatically. Contact support. ") +
                "Try again.",
            );
          }
          throw e;
        }
      } else {
        // Auto-collection OFF / nothing to charge now: unchanged path.
        await billSubscriptionPeriod(billInput);
      }
    }

    // Any path that deferred but never reached the invoice commit (a trial the
    // `chargesNow` prediction did not see, a zero-amount first invoice) still
    // owes its events — the subscription survives, so it must be announced.
    if (!deferredEmitted && deferred.length > 0) {
      await flushDeferredEvents(ctx.organizationId, deferred);
      deferredEmitted = true;
    }

    await withTenant(ctx.organizationId, (tx) =>
      tx
        .update(checkoutSessions)
        .set({
          status: "completed",
          resultingSubscriptionId: subscription.id,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(checkoutSessions.id, ctx.sessionId)),
    );
    ctx.status = "completed";
    ctx.resultingSubscriptionId = subscription.id;

    return {
      subscriptionId: subscription.publicId,
      customerId: customer.publicId,
      ...(consumedIntentId ? { paymentIntentId: consumedIntentId } : {}),
      ...(consumedPaymentError ? { paymentError: consumedPaymentError } : {}),
    };
  } catch (e) {
    // An unexpected failure after the subscription was written leaves it in
    // place (as it always did) — so its events must still be emitted, or the row
    // would exist with no webhook ever announcing it. The refusal paths above
    // clear the buffer first, so this is inert for them.
    if (!deferredEmitted && deferred.length > 0) {
      deferredEmitted = true;
      try {
        await flushDeferredEvents(ctx.organizationId, deferred);
      } catch (flushErr) {
        log.error(flushErr, { event: "deferred_checkout_events_flush_failed" });
      }
    }
    // Release the claim so the buyer can retry (e.g. card declined, transient error).
    await withTenant(ctx.organizationId, (tx) =>
      tx
        .update(checkoutSessions)
        .set({ status: "open", updatedAt: new Date() })
        .where(
          and(eq(checkoutSessions.id, ctx.sessionId), eq(checkoutSessions.status, "completing")),
        ),
    );
    ctx.status = "open";
    throw e;
  }
}
