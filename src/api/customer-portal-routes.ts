import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { CARD_LIMIT_CODE, CARD_LIMIT_MESSAGE, overCardLimit } from "@/modules/invoicing/card-limit";
import {
  applyPortalChange,
  cancelPortalScheduledChange,
  getChangeOptions,
  PortalChangeError,
  previewPortalChange,
} from "@/modules/customer-portal/plan-change";
import {
  acceptRetentionOffer,
  getCancelFlow,
  pausedByOffer,
  recordPortalCancellation,
} from "@/modules/customer-portal/retention";
import {
  isRetentionCouponCode,
  RETENTION_COUPON_REFUSAL,
} from "@/modules/customer-portal/retention-coupon";
import { LIMITS, achAuthorizationField, clientResultField, httpUrl, redirectUrl } from "./limits";
import { clientIp } from "@/platform/event-context";
import { AchAuthorizationError } from "@/modules/payment-methods/ach-authorization";
import { authenticate, authenticatePortal } from "@/platform/auth";
import { idempotency, idempotencyOnSend, idempotentNoStore } from "@/platform/idempotency";
import { config } from "@/platform/config";
import { AUTH_WINDOW_MS } from "@/platform/rate-limit";
import { verifyTurnstile, turnstileRefuses } from "@/platform/turnstile";
import {
  PORTAL_ACTIONS,
  PortalActionError,
  resolveActionForward,
} from "@/modules/customer-portal/actions";
import {
  PortalLoginError,
  requestPortalLoginCode,
  verifyPortalLoginCode,
} from "@/modules/customer-portal/login-code";
import { businessWallClock } from "@/platform/clock";
import {
  getCustomerByPublicId,
  updateCustomer,
  resolveCustomerCurrency,
} from "@/modules/customers/service";
import { getBusinessById } from "@/modules/tenancy/service";
import { resolveStorefrontConfig } from "@/modules/checkout/storefront-config";
import { listCustomerPurchases } from "@/modules/checkout/service";
import { resolveOfferedReasons } from "@/modules/reason-codes/service";
import { applyCouponToSubscription, removeDiscount, CouponError } from "@/modules/coupons/service";
import {
  createPortalSession,
  revokePortalSession,
  getPortalCustomer,
  getPortalBusiness,
  exchangePortalAccessToken,
  peekPortalAccessToken,
  businessOfDeadPortalLink,
  getPortalLinkNotice,
  logoutPortalSession,
  getPortalSession,
  PORTAL_FORWARD_PATHS,
  type PortalSessionRow,
} from "@/modules/customer-portal/service";
import {
  vaultPaymentMethod,
  listPaymentMethods,
  setDefaultPaymentMethod,
  assignPaymentMethodRole,
  PrimaryDemotionError,
  detachPaymentMethod,
  listVaultGatewaysForBusiness,
  PaymentMethodConfigError,
  PaymentMethodVaultError,
  VaultSetupUnsupportedError,
  INR_AFA_FREE_CEILING_MINOR,
} from "@/modules/payment-methods/service";
import { expectedRecurringDebit } from "@/modules/subscriptions/estimate";
import {
  serializePaymentMethods,
  serializePaymentMethodWithGateway,
} from "@/modules/payment-methods/serialize";
import { abandonAuthenticationPendingDebit } from "@/modules/payments/stale-pending";
import { invoiceOutstanding } from "@/modules/invoicing/service";
import {
  listInvoices,
  getInvoiceWithLines,
  pendingPaymentForInvoice,
  pendingPaymentsForInvoices,
  collectOutstandingForNewPaymentMethod,
  PaymentActionRequiredError,
  CollectionInFlightError,
} from "@/modules/invoicing/service";
import { InvoiceOpsError } from "@/modules/invoicing/ops";
import {
  captureRefused,
  consumePaymentIntent,
  getPaymentIntent,
  createPaymentIntent,
  hostedWalletMismatch,
  liveIntentForInvoice,
  resumeVerdictFromGateway,
  voidPaymentIntent,
  serializePaymentIntent,
  PaymentIntentError,
  PaymentIntentConflictError,
  type PaymentIntent,
} from "@/modules/payment-intents/service";
import { serializeInvoice } from "@/modules/invoicing/serialize";
import { assembleInvoiceDocument } from "@/modules/invoicing/document";
import { renderInvoicePdf } from "@/modules/invoicing/invoice-pdf";
import {
  beginVaultSetup,
  serializeVaultSetup,
  completeVaultFromIntent,
  VaultSetupIntentError,
  achAuthorizationParties,
  achAuthorizationTextFor,
} from "./vault-setup";
import { GatewayRouterError } from "@/modules/gateway/router";
import { effectiveMethodTypes, hostedApplePayOffered } from "@/modules/gateway/service";
import { ProviderIndeterminateError, ProviderRefusalError } from "@/providers/types";
import {
  resolveBusiness,
  badRequest,
  badGateway,
  conflict,
  notFound,
  refusedByRateLimit,
  requirePerm,
} from "./helpers";
import { addressRefinement, requirementIssuesError } from "./address-validation";
import {
  addressFieldLocksFor,
  addressRequirementIssues,
  billingDetailsComplete,
  isPortalKeyLocked,
  mergePortalAddress,
  resolvePortalFieldConfig,
  withAddressFieldLocks,
  type AddressFieldLocks,
} from "@/modules/checkout/address-field-rules";
import type { AddressMatrixField } from "@/modules/checkout/field-config";
import { liveTaxRegimes } from "@/modules/tax/service";
import { hasBillingName, holderName } from "@/modules/customers/names";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import {
  customerCouponCapMessage,
  liveDiscountCounts,
  portalCouponCodesLeft,
} from "@/modules/coupons/customer-cap";
import { notDeleted } from "@/modules/subscriptions/deleted-sql";
import { withTenant } from "@/platform/db";
import {
  subscriptions,
  subscriptionItems,
  prices,
  products,
  appliedCoupons,
  coupons,
  portalSessions,
} from "@db/schema";
import { estimateRenewal } from "@/modules/subscriptions/estimate";
import { apiSubscriptionStatus } from "@/modules/subscriptions/serialize";
import { isMeteredPrice, snapshotPrice, type PriceSnapshot } from "@/modules/catalog/pricing";
import { currentUsage, serializeCurrentUsage } from "@/modules/subscriptions/current-usage";
import { usageWindowForNextInvoice } from "@/modules/subscriptions/usage-window";
import {
  MAX_HISTORY_DAYS,
  customerUsageHistory,
  serializeUsageHistory,
} from "@/modules/metering/usage-history";
import { createLogger } from "@/platform/logger";
import { parseRequest } from "./strict-params";
import {
  listUpcomingRenewals,
  renewalSkipViews,
  skipRenewal,
  unskipRenewal,
} from "@/modules/subscriptions/renewal-skips";
import { SubscriptionError } from "@/modules/subscriptions/service";
import { ProrationError } from "@/modules/subscriptions/proration";
import { listScheduledChanges } from "@/modules/subscriptions/scheduled-changes";
import { BUYER_METHOD_TYPES } from "@/providers/method-types";
import {
  addressObject,
  archiveShippingAddress,
  createShippingAddress,
  findShippingAddress,
  listShippingAddresses,
  resolveShipTo,
  serializeShippingAddress,
  ShippingAddressError,
  updateShippingAddress,
  type ShippingAddressFields,
} from "@/modules/customers/addresses";
import { resolveCheckoutFieldConfig } from "@/modules/checkout/field-config";

/**
 * `over_card_limit` (0482): the amount due is above the business's card limit, so Pay now is
 * not offered — the gateway's sheet takes cards. The invoice still shows how to pay offline.
 */
function withCardLimit<T extends { currency: string; amount_due_minor: number }>(
  biz: Parameters<typeof overCardLimit>[0],
  view: T,
): T & { over_card_limit: boolean } {
  return {
    ...view,
    over_card_limit: overCardLimit(biz, view.currency, BigInt(Math.max(0, view.amount_due_minor))),
  };
}

const log = createLogger("customer-portal.routes");

/**
 * How many subscriptions the portal prices per page load. Each one plans a whole invoice
 * (`estimateRenewal`), and this runs on a buyer's page load — a customer with a long book
 * would put all of it on the critical path. Newest first, and anything dropped is LOGGED
 * rather than silently missing. Same reasoning as the mandate-sizing cap in estimate.ts.
 */
const PORTAL_SUBSCRIPTION_LIMIT = 10;

/**
 * The discount currently live on a subscription, or null.
 *
 * `applied_coupons` holds both kinds — a coupon (merchant-granted or buyer-entered) and an
 * operator's manual discount — so one query answers for both, and `source` is what the
 * portal needs to tell them apart: a buyer may take off a COUPON, never an operator's
 * manual adjustment, which they never asked for and cannot put back.
 *
 * Only `active` rows count. A "once" discount that has been consumed must not leave the
 * buyer locked out of ever entering another code.
 */
async function portalSubscriptionDiscount(organizationId: string, subscriptionId: string) {
  const [row] = await withTenant(organizationId, (tx) =>
    tx
      .select({
        id: appliedCoupons.publicId,
        source: appliedCoupons.source,
        code: coupons.code,
      })
      .from(appliedCoupons)
      .leftJoin(coupons, eq(coupons.id, appliedCoupons.couponId))
      .where(
        and(eq(appliedCoupons.subscriptionId, subscriptionId), eq(appliedCoupons.status, "active")),
      )
      .limit(1),
  );
  if (!row) return null;
  return {
    id: row.id,
    /** The code the buyer would have typed. Null for a manual discount — there is none. */
    coupon: row.code ?? null,
    source: row.source,
    /** A manual discount is the operator's; the buyer may not lift it here. */
    removable: row.source === "coupon" && row.code != null,
  };
}

/** Every live discount on the subscription, oldest first, and how many codes the buyer may still enter. */
async function portalSubscriptionDiscounts(
  organizationId: string,
  subscriptionId: string,
  cap: number,
) {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({
        id: appliedCoupons.publicId,
        source: appliedCoupons.source,
        code: coupons.code,
        entered: appliedCoupons.enteredByCustomer,
      })
      .from(appliedCoupons)
      .leftJoin(coupons, eq(coupons.id, appliedCoupons.couponId))
      .where(
        and(eq(appliedCoupons.subscriptionId, subscriptionId), eq(appliedCoupons.status, "active")),
      )
      .orderBy(asc(appliedCoupons.createdAt), asc(appliedCoupons.id)),
  );
  const live = { entered: rows.filter((r) => r.entered).length, total: rows.length };
  return {
    discounts: rows.map((r) => ({
      id: r.id,
      coupon: r.code ?? null,
      source: r.source,
      removable: r.source === "coupon" && r.code != null,
    })),
    couponCodesLeft: portalCouponCodesLeft(cap, live),
  };
}

/** A subscription's ship-to: its own book row (id set), else the customer's default (id null). */
async function portalShipTo(
  organizationId: string,
  sub: { customerId: string; shippingAddressId: string | null },
) {
  const row = await withTenant(organizationId, (tx) => resolveShipTo(tx, sub));
  return {
    shipping_address_id:
      sub.shippingAddressId && row?.id === sub.shippingAddressId ? row.publicId : null,
    shipping_address: row ? serializeShippingAddress(row) : null,
  };
}

const portalVaultBody = z
  .object({
    // ONE of these two, `payment_intent` preferred.
    //
    // `payment_intent` completes the add-card THROUGH the setup intent it began, which
    // is the same atomic `authorized → consumed` claim the gateway's own webhook harvest
    // goes through — so whichever of the two arrives second loses the claim instead of
    // vaulting the instrument a second time. `token` is the older shape: it hands the
    // raw provider token straight to the vault call, bypassing the claim, and that is
    // how one RazorPay UPI mandate became two payment methods 15s apart (measured
    // 2026-08-21). Kept because a legacy ENV-configured provider has no intent to
    // consume, and an un-updated client must not break.
    token: z.string().max(LIMITS.id).min(1).optional(), // pm_… / setup token / tmtest magic token
    payment_intent: z.string().max(LIMITS.id).min(1).optional(), // pi_… from POST …/payment_methods/setup
    gateway_account: z.string().max(LIMITS.id).min(1).optional(), // gwa_… — MUST match the gateway the setup ran on
    /** What the browser SDK returned for a `next_action.mode: 'sdk'` setup. With `payment_intent`. */
    client_result: clientResultField().optional(),
    /** The payer accepted the bank debit authorization shown for this gateway. */
    ach_authorization: achAuthorizationField().optional(),
  })
  .refine((b) => Boolean(b.payment_intent ?? b.token), {
    message: "Pass payment_intent or token. Use payment_intent when you can",
  });

const portalSetupBody = z.object({
  return_url: redirectUrl(),
  cancel_url: redirectUrl(),
  gateway_account: z.string().max(LIMITS.id).min(1).optional(), // gwa_… — vault through this gateway (buyer's pick)
  /**
   * The rail to vault on. Widened 2026-09-05 with `us_bank_account` and `sepa_debit`:
   * the Stripe adapter advertises both in `capabilities.methods` and does the full
   * lifecycle, but this enum capped the vocabulary at the Indian set, so a buyer could
   * not even REQUEST a direct debit — the request was rejected before reaching a gateway
   * that supports it. The values are provider-agnostic tokens; each adapter maps them
   * (Stripe's METHOD_TYPE_MAP folds `bank_transfer` onto `us_bank_account`).
   */
  method_type: z.enum(BUYER_METHOD_TYPES).optional(),
});

/** Invoices shown on a buyer's first portal open. Ten covers a year of monthly billing. */
const PORTAL_INVOICE_PAGE = 10;
/** Ceiling on what one request may ask for, so `?limit=` cannot re-create the old behaviour. */
const PORTAL_INVOICE_MAX_LIMIT = 200;

/** The portal's address fields: billing (`portalMeBody`) and shipping share one shape. */
const portalAddressFields = {
  line1: z.string().max(200).nullable().optional(),
  line2: z.string().max(200).nullable().optional(),
  line3: z.string().max(200).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().max(100).nullable().optional(),
  state_code: z.string().max(10).nullable().optional(),
  postal_code: z.string().max(20).nullable().optional(),
  country: z.string().length(2).nullable().optional(),
  first_name: z.string().max(100).nullable().optional(),
  last_name: z.string().max(100).nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
};

const portalMeBody = z
  .object({
    // No `name`: `customers.name` is deprecated (2026-08-23, see
    // `modules/customers/names.ts`) and the buyer form never collected it anyway — the
    // name on a buyer's invoice is the address CONTACT below. A client still
    // sending `name` gets `Unknown parameter: name` (strict-params.ts) rather than
    // having it silently ignored.
    // Full billing-address shape — kept in lock-step with the operator edit
    // (addressBody in customer-routes.ts) so buyer + operator edits are
    // interchangeable and neither clobbers the other's fields (applyAddress
    // REPLACES the whole address on update).
    // Optional sub-fields accept `null` as well as omission (both clear the column)
    // so a client that posts every blank input as null does not 400 — the bug that
    // hit the operator drawer. Which fields are REQUIRED is the business's portal field
    // matrix (0334), checked in the handler against the merged address.
    address: z.object(portalAddressFields).superRefine(addressRefinement).optional(),
    // The BUYER's own registration number (GSTIN for India) — F-23. Same shape as the
    // checkout's `checkoutCustomerBody` (customer-portal-routes.ts) deliberately: a
    // buyer path stricter than the checkout path would reject a registration the
    // checkout accepted. No format regex, same reason as there — a wrong GSTIN is bad,
    // but refusing a valid-but-unusual one is worse. Empty string clears it, matching
    // `updateCheckoutCustomerDetails`'s `?.trim() || null`.
    // `.nullable()` for the same reason every optional sub-field of `address` above
    // carries it: the buyer form posts a blank box as NULL to mean "forget this
    // number", and `optional()` alone rejected that with "Invalid request body" —
    // so a buyer with no GSTIN could not save their address at all, and therefore
    // could not add a payment method, which requires one. The handler below already
    // normalises with `|| null`, so nothing downstream changes.
    tax_registration_number: z.string().trim().max(50).nullable().optional(),
  })
  .refine((b) => b.address !== undefined || b.tax_registration_number !== undefined, {
    message: "Provide an address or a tax registration number",
  });

/** A buyer's shipping address (0360): the billing shape plus a label and the default flag. */
const portalShippingAddressBody = z
  .object({
    ...portalAddressFields,
    label: z.string().max(100).nullable().optional(),
    is_default: z.boolean().optional(),
  })
  .superRefine(addressRefinement);

const SHIPPING_ADDRESS_KEYS = [
  "line1",
  "line2",
  "line3",
  "city",
  "state",
  "state_code",
  "postal_code",
  "country",
  "first_name",
  "last_name",
  "company",
  "phone",
] as const;

/**
 * Where a parcel can go: line1, city and country, plus region and postal code where the
 * country has them. Fixed, not the portal matrix: that matrix governs the billing address.
 */
const SHIPPING_REQUIRED = {
  "billing.line1": "mandatory",
  "billing.city": "mandatory",
  "billing.state_code": "mandatory",
  "billing.postal_code": "mandatory",
  "billing.country": "mandatory",
} as const;

function toPortalShippingFields(
  d: Partial<z.infer<typeof portalShippingAddressBody>>,
): ShippingAddressFields {
  return {
    label: d.label,
    firstName: d.first_name,
    lastName: d.last_name,
    company: d.company,
    phone: d.phone,
    line1: d.line1,
    line2: d.line2,
    line3: d.line3,
    city: d.city,
    state: d.state,
    stateCode: d.state_code,
    postalCode: d.postal_code,
    country: d.country,
  };
}

const portalShipToBody = z.object({
  /** An `addr_…` id from the customer's own book; `null` = ship to the default. */
  address_id: z.string().min(1).max(64).nullable(),
});
// There is deliberately no schema-level "some name is required" rule here: whether the
// update leaves the customer nameless depends on the ROW as much as on the body — an
// address-only patch is perfectly fine for a customer whose account-holder first/last
// is already set. A zod refinement cannot see the row, so that check lives in the PATCH
// handler below, immediately after it loads one.

/**
 * Customer portal (P14 slice) — the BUYER-facing self-serve surface.
 * (Not to be confused with portal-routes.ts, the operator ops-portal reads.)
 *
 * Two surfaces in one file:
 *  1. An OPERATOR route (org-key authed) that mints a customer-scoped portal
 *     session and returns the copyable /portal/s/<token> link — the EXCHANGE
 *     route, which hands the token to an HttpOnly cookie and redirects to a clean
 *     /portal (W1). See dashboard/lib/storefront-session.ts.
 *  2. The BUYER-facing /portal/v1/* routes, authed ONLY by that portal token
 *     (authenticatePortal). The org API key never satisfies these, and the
 *     portal token never satisfies /v1/* — separate token namespaces.
 *
 * The customer is always resolved from the token — never from a URL param —
 * so a portal session can only ever see and mutate its own customer's cards.
 */
export async function registerCustomerPortalRoutes(app: FastifyInstance) {
  /**
   * How long the minted LINK stays openable — not how long the session lasts.
   *
   * `api` (the default, one hour) assumes the shape this route was built for: an
   * integration mints a link and immediately redirects a user it has already
   * authenticated. Nothing waits, so an hour is generous.
   *
   * `email` is for the caller that puts the link in a message a human reads later, and
   * an hour is simply wrong there — a payment-failure mail would carry an
   * already-dead link to every recipient who did not read their mail within the hour,
   * which is most of them. It buys the same five days `emails/outbox.ts` already gives
   * tmbilling's own mail, so a link is a link whoever sends it.
   *
   * ⚠ It does NOT make the link multi-use. The entry credential is spent by the first
   * GET of `/portal/s/<token>`, and mail clients and security scanners PREFETCH links
   * — so an emailed link can arrive already burned. That hazard is the reason
   * `lib/storefront-session.ts` argues single-use is safe for API links specifically,
   * and it applies to every emailed link tmbilling sends today. Widening the window
   * does not address it; it is tracked separately and is not made worse here.
   */
  const portalSessionBody = z.object({
    link_kind: z.enum(["api", "email"]).optional(),
    // Where logout returns the buyer. Absolute http(s) only; set by the operator at mint.
    redirect_url: z
      .string()
      .max(2000)
      .url()
      .refine((u) => /^https?:\/\//i.test(u), "redirect_url must be an http(s) URL")
      .optional(),
    // The portal page the link opens on — a closed set, so a link cannot redirect off-site.
    forward_url: z.enum(PORTAL_FORWARD_PATHS).optional(),
    /** Phase 4b: open the portal on one task. `object` is its invoice or subscription id. */
    action: z.enum(PORTAL_ACTIONS).optional(),
    object: z.string().min(1).max(LIMITS.id).optional(),
  });

  const portalCancelBody = z.object({
    end_of_term: z.boolean().optional(),
    reason_code: z.string().trim().min(1).max(100).optional(),
    /** The buyer's own words, stored as `cancel_reason` (same cap as the operator API). */
    reason: z.string().trim().min(1).max(200).optional(),
    /** The cancel flow showed offers first (the saves report). */
    offers_shown: z.boolean().optional(),
  });

  const serializePortalSession = (s: PortalSessionRow) => ({
    object: "portal_session" as const,
    id: s.publicId,
    status: s.status,
    link_kind: s.accessKind,
    created_at: s.createdAt.toISOString(),
    access_expires_at: s.accessExpiresAt?.toISOString() ?? null,
    expires_at: s.expiresAt.toISOString(),
    login_at: s.loginAt?.toISOString() ?? null,
    logout_at: s.logoutAt?.toISOString() ?? null,
    last_used_at: s.lastUsedAt?.toISOString() ?? null,
    revoked_at: s.revokedAt?.toISOString() ?? null,
    redirect_url: s.redirectUrl,
    forward_url: s.forwardUrl,
  });

  // ——— Operator: mint a portal link ————————————————————————————————————————
  app.post(
    "/v1/businesses/:biz/customers/:cus/portal_sessions",
    {
      preHandler: [authenticate, requirePerm("customers:manage"), idempotency],
      onSend: idempotencyOnSend,
      // Response body is NOT persisted: it carries raw `pstk_…` bearer token AND a url embedding it; `portal_sessions` stores only `token_hash`.
      // Route stays idempotent (a retry must never mint a second credential); a replay
      // returns 409 `response_not_replayable` with `created: true`. See idempotency.ts.
      config: idempotentNoStore,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!customer) return notFound(reply, `No such customer: ${cusId}`);
      const parsedBody = parseRequest(
        portalSessionBody,
        req.body && typeof req.body === "object" ? req.body : {},
      );
      if (!parsedBody.success) return badRequest(reply, parsedBody.error);
      if (parsedBody.data.action && parsedBody.data.forward_url)
        return badRequest(reply, "Send action or forward_url, not both.");
      let forwardUrl: string | null = parsedBody.data.forward_url ?? null;
      if (parsedBody.data.action) {
        try {
          forwardUrl = await resolveActionForward({
            organizationId: req.organization!.id,
            businessId: business.id,
            customerId: customer.id,
            cfg: resolveStorefrontConfig(business),
            action: parsedBody.data.action,
            objectId: parsedBody.data.object ?? null,
          });
        } catch (e) {
          if (e instanceof PortalActionError) return badRequest(reply, e.message);
          throw e;
        }
        // Turned off for this business: the link opens the portal home, as before.
      }
      const session = await createPortalSession({
        organizationId: req.organization!.id,
        businessId: business.id,
        customerId: customer.id,
        // Absent → `createPortalSession`'s own default of 'api'. Left to the service
        // rather than defaulted here so there is one definition of the default.
        ...(parsedBody.data.link_kind ? { kind: parsedBody.data.link_kind } : {}),
        redirectUrl: parsedBody.data.redirect_url ?? null,
        forwardUrl,
      });
      return reply.code(201).send({
        object: "portal_session",
        id: session.publicId,
        status: "created",
        /**
         * The single-use ENTRY credential, returned exactly once at mint (0193). It
         * buys exactly one exchange — `/portal/v1/*` does not accept it — and is good
         * for an hour, or five days when the caller asked for `link_kind: 'email'`.
         * Read `access_expires_at` rather than assuming either: that is the field that
         * says, and it is why it is returned. Once accessed the url cannot be reused,
         * so do not persist it.
         *
         * Still called `token` on the wire because that is the field integrations
         * already read; `access_expires_at` below is what tells them it is short-lived.
         */
        token: session.accessToken,
        ...(config.PORTAL_BASE_URL
          ? { url: `${config.PORTAL_BASE_URL.replace(/\/$/, "")}/portal/s/${session.accessToken}` }
          : {}),
        /** When the LINK stops working — an hour out, or five days for `link_kind: 'email'`. */
        access_expires_at: session.accessExpiresAt.toISOString(),
        /** Ceiling on the session the exchange mints, not on the link. */
        expires_at: session.expiresAt.toISOString(),
        ...(parsedBody.data.redirect_url ? { redirect_url: parsedBody.data.redirect_url } : {}),
        ...(forwardUrl ? { forward_url: forwardUrl } : {}),
      });
    },
  );

  // ——— Operator: read a portal session (no credential) ————————————————————————
  app.get(
    "/v1/businesses/:biz/customers/:cus/portal_sessions/:id",
    { preHandler: [authenticate, requirePerm("customers:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { cus, id } = req.params as { cus: string; id: string };
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cus);
      if (!customer) return notFound(reply, `No such customer: ${cus}`);
      const row = await getPortalSession({
        organizationId: req.organization!.id,
        businessId: business.id,
        customerId: customer.id,
        sessionPublicId: id,
      });
      if (!row) return notFound(reply, `No such portal session: ${id}`);
      return serializePortalSession(row);
    },
  );

  // ——— Operator: revoke a portal link and the session it opened ————————————
  /**
   * The mint's counterpart, and the only lever an operator has when a portal link leaks
   * or a buyer session has to be ended from outside the buyer's browser (F-9).
   *
   * `portal_sessions.revoked_at` was honoured by BOTH readers — `exchangePortalAccessToken`
   * and `resolvePortalSession` — with nothing in the product writing it. `POST
   * /portal/v1/logout` was not the lever: it needs the buyer's own `psst_…`, which lives in
   * the buyer's cookie and nowhere an operator can reach.
   *
   * ONE write kills BOTH credentials, which is where this differs from the checkout
   * equivalent it otherwise mirrors (0193 gave the portal two): a link NEVER OPENED can no
   * longer be exchanged (`POST /portal/v1/session` answers its usual single 401), and a
   * session ALREADY IN FLIGHT stops resolving, so every `/portal/v1/*` route — the readable
   * ones included — answers 401. See `revokePortalSession` for why `token_hash` is
   * deliberately left in place and why `status` is untouched.
   *
   * `requirePerm('ops')`, matching the MINT above rather than something stricter. The levels
   * have to be read together: `ops` can hand out a link that reaches a buyer's stored cards
   * and invoices, so `ops` must be able to kill one. Anything higher is a role that can
   * create the exposure and not close it, and revocation is the fail-SAFE direction — the
   * same reasoning `POST /v1/api_keys/:id/revoke` records for carrying no step-up.
   *
   * Scoped through the CUSTOMER, like the mint: a portal session belongs to exactly one
   * customer and the operator reached this through that customer's path. Idempotent by the
   * service, and the response carries no credential (unlike the mint, whose body holds the
   * raw `pstk_…`), so the ordinary idempotency store applies — no `idempotentNoStore` here.
   */
  app.post(
    "/v1/businesses/:biz/customers/:cus/portal_sessions/:id/revoke",
    {
      preHandler: [authenticate, requirePerm("customers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { cus, id } = req.params as { cus: string; id: string };
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cus);
      if (!customer) return notFound(reply, `No such customer: ${cus}`);
      const revoked = await revokePortalSession({
        organizationId: req.organization!.id,
        businessId: business.id,
        customerId: customer.id,
        sessionPublicId: id,
      });
      // One answer for "another tenant's session", "another business's session",
      // "another customer's session" and "no such id" — an operator learns nothing
      // about ids that are not theirs.
      if (!revoked) return notFound(reply, `No such portal session: ${id}`);
      return {
        object: "portal_session",
        id: revoked.publicId,
        status: revoked.status,
        revoked_at: revoked.revokedAt.toISOString(),
      };
    },
  );

  // ——— Public: spend the entry credential for a session (0193, NO auth) ————
  //
  // Called ONLY by the storefront's `/portal/s/<token>` route handler, server-side. The
  // buyer's browser never sees either credential: it arrives holding a link, and leaves
  // holding a cookie.
  //
  // Unauthenticated by necessity — the caller has no session yet, that being the point.
  // So it is throttled, and it answers one shape for every failure.
  // Phase 4b: what a link opens, without spending it. The click-to-continue page reads this.
  app.get("/portal/v1/session/peek", async (req, reply) => {
    // Mail scanners call this. No side effects (the link is not spent, extended or counted),
    // nothing sensitive (no email, amount or id that opens a session), never cached.
    reply.header("cache-control", "no-store");
    reply.header("referrer-policy", "no-referrer");
    const header = req.headers["authorization"];
    const accessToken =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length).trim()
        : "";
    if (
      await refusedByRateLimit(req, reply, {
        scope: "portal_link_peek",
        // Its own, higher limit: mail scanners share IPs, and a peek reveals only branding.
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP * 10 }],
        windowMs: AUTH_WINDOW_MS,
        failClosed: true,
      })
    )
      return;
    const link = accessToken ? await peekPortalAccessToken(accessToken) : null;
    if (!link)
      return reply.code(401).send({
        error: { type: "authentication_error", message: "This link is not valid or is expired" },
      });
    const notice = await getPortalLinkNotice(link.businessPublicId);
    const f = link.forwardUrl ?? "";
    const task = f.includes("pay_invoice=")
      ? "pay_invoice"
      : f.includes("add_card=1")
        ? "update_card"
        : f.includes("change=")
          ? "change_plan"
          : f.includes("cancel=")
            ? "cancel_subscription"
            : null;
    return {
      object: "portal_link",
      link_kind: link.kind,
      task,
      business: notice
        ? {
            name: notice.name,
            logo_url: notice.logoUrl,
            icon_url: notice.iconUrl,
            favicon_url: notice.faviconUrl,
            brand_color: notice.brandColor,
          }
        : null,
    };
  });

  app.post("/portal/v1/session", async (req, reply) => {
    const header = req.headers["authorization"];
    const accessToken =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length).trim()
        : "";

    // A guessing surface: 32 random bytes is not brute-forceable, but an unthrottled
    // endpoint that says yes-or-no about a credential should not exist regardless, and
    // the limit is also what stops this being used to sweep for live links after a log
    // or an inbox leaks.
    if (
      await refusedByRateLimit(req, reply, {
        scope: "portal_exchange",
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP }],
        windowMs: AUTH_WINDOW_MS,
        // Credential scope: refuse rather than wave through when the counter cannot be
        // written (audit M2). A login that cannot be metered also cannot be verified.
        failClosed: true,
      })
    )
      return;

    const session = accessToken ? await exchangePortalAccessToken(accessToken, req.ip) : null;
    if (!session) {
      // ONE answer for expired, spent, revoked, unknown and malformed. Distinguishing
      // them would tell an attacker which guesses are worth repeating, and tells a
      // legitimate buyer nothing they can act on — the remedy is the same either way.
      // `business` names whose link it was, so the portal can show that business's
      // message; it is present for any dead link and says nothing about why it died.
      const business = accessToken ? await businessOfDeadPortalLink(accessToken) : null;
      return reply.code(401).send({
        error: { type: "authentication_error", message: "This link is not valid or is expired" },
        ...(business ? { business } : {}),
      });
    }
    return reply.code(201).send({
      object: "portal_session",
      id: session.sessionPublicId,
      token: session.token,
      expires_at: session.expiresAt.toISOString(),
      ...(session.businessPublicId ? { business: session.businessPublicId } : {}),
      ...(session.forwardUrl ? { forward_url: session.forwardUrl } : {}),
    });
  });

  // ——— Public: the message a buyer sees when they cannot get in (NO auth) ———————
  //
  // The storefront calls this for a failed link or an ended session, knowing only the
  // business id it remembered. Brand and the merchant's message only — nothing that is
  // not already shown to anyone holding a dead link.
  // ── Sign-in by email code (Phase 4, `storefront_config.portal_email_code`) ──
  // Public routes. The request never says whether the email has an account.
  const loginRequestBody = z.object({
    business: z.string().min(1).max(LIMITS.id),
    email: z.string().trim().email().max(320),
    bot_check_token: z.string().max(4096).optional(),
  });
  app.post("/portal/v1/login/request", async (req, reply) => {
    const body = parseRequest(loginRequestBody, req.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    if (
      await refusedByRateLimit(req, reply, {
        scope: "portal_login_request_ip",
        keys: [{ kind: "ip", value: req.ip, limit: 20 }],
        windowMs: AUTH_WINDOW_MS,
        failClosed: true,
      })
    )
      return;
    if (turnstileRefuses(await verifyTurnstile(body.data.bot_check_token, req.ip)))
      return reply.code(400).send({
        error: {
          type: "invalid_request_error",
          code: body.data.bot_check_token ? "bot_check_failed" : "bot_check_required",
          message: body.data.bot_check_token
            ? "We could not check that you are a person. Try again."
            : "Complete the check to show that you are a person.",
        },
      });
    // At most 5 codes an hour to one address: the route must not be a way to flood an inbox.
    // Counted after the bot check, so requests without a token cannot use up a victim's quota.
    if (
      await refusedByRateLimit(
        req,
        reply,
        {
          scope: "portal_login_request_email",
          keys: [{ kind: "email", value: body.data.email.toLowerCase(), limit: 5 }],
          windowMs: 60 * 60_000,
          failClosed: true,
        },
        "Too many codes. Wait, then ask for a new code.",
      )
    )
      return;
    try {
      await requestPortalLoginCode(body.data.business, body.data.email);
    } catch (e) {
      if (e instanceof PortalLoginError)
        return e.status === 404 ? notFound(reply, e.message) : badRequest(reply, e.message);
      throw e;
    }
    return { object: "portal_login_request", sent: true };
  });

  const loginVerifyBody = z.object({
    business: z.string().min(1).max(LIMITS.id),
    email: z.string().trim().email().max(320),
    code: z.string().trim().max(12),
    customer: z.string().max(LIMITS.id).optional(),
  });
  app.post("/portal/v1/login/verify", async (req, reply) => {
    const body = parseRequest(loginVerifyBody, req.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    if (
      await refusedByRateLimit(req, reply, {
        scope: "portal_login_verify",
        keys: [
          { kind: "ip", value: req.ip, limit: 30 },
          { kind: "email", value: body.data.email.toLowerCase(), limit: 15 },
        ],
        windowMs: AUTH_WINDOW_MS,
        failClosed: true,
      })
    )
      return;
    try {
      const r = await verifyPortalLoginCode({
        businessPublicId: body.data.business,
        email: body.data.email,
        code: body.data.code,
        ...(body.data.customer ? { customer: body.data.customer } : {}),
        ip: req.ip,
      });
      return r.kind === "session"
        ? { object: "portal_login", token: r.token, expires_at: r.expiresAt }
        : { object: "portal_login_choice", customers: r.customers };
    } catch (e) {
      if (e instanceof PortalLoginError)
        return e.status === 404 ? notFound(reply, e.message) : badRequest(reply, e.message);
      throw e;
    }
  });

  app.get("/portal/v1/link_notice/:biz", async (req, reply) => {
    if (
      await refusedByRateLimit(req, reply, {
        scope: "portal_link_notice",
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP }],
        windowMs: AUTH_WINDOW_MS,
      })
    )
      return;
    const { biz } = req.params as { biz: string };
    const notice = await getPortalLinkNotice(biz);
    if (!notice) return notFound(reply, `No such business: ${biz}`);
    return {
      object: "portal_link_notice",
      business: {
        name: notice.name,
        logo_url: notice.logoUrl,
        icon_url: notice.iconUrl,
        favicon_url: notice.faviconUrl,
        brand_color: notice.brandColor,
      },
      message_html: notice.html,
      email_code: notice.emailCode,
    };
  });

  // ——— Buyer: end the session ——————————————————————————————————————————————
  app.post("/portal/v1/logout", { preHandler: authenticatePortal }, async (req, reply) => {
    const header = req.headers["authorization"];
    const token = typeof header === "string" ? header.slice("Bearer ".length).trim() : "";
    const { redirectUrl } = await logoutPortalSession(token, req.ip);
    return reply.code(200).send({
      object: "portal_logout",
      ok: true,
      ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
    });
  });

  // ——— Buyer: portal surface (portal-token auth ONLY) ——————————————————————
  type PortalBusinessRow = NonNullable<Awaited<ReturnType<typeof getPortalBusiness>>>;
  const collectsShipping = (business: PortalBusinessRow) =>
    resolveCheckoutFieldConfig(business)["shipping.address"] !== "hide";
  /** The business's tax locks, from its live tax regions (0334). */
  const portalLocks = async (business: PortalBusinessRow): Promise<AddressFieldLocks> =>
    addressFieldLocksFor(
      (await liveTaxRegimes(business.organizationId, [business.id])).get(business.id) ?? [],
    );
  const serializePortalMe = (
    customer: NonNullable<Awaited<ReturnType<typeof getPortalCustomer>>>,
    business: PortalBusinessRow,
    locks: AddressFieldLocks,
    fieldConfig = withAddressFieldLocks(resolvePortalFieldConfig(business), locks),
  ) => ({
    object: "portal_me" as const,
    /** Effective portal field matrix (0334): stored, with tax-locked keys `mandatory`. */
    field_config: fieldConfig,
    address_field_locks: locks,
    customer: {
      id: customer.publicId,
      // Derived, read-only — same rule as `serializeCustomer`. Kept on the wire so the
      // portal has a flat display string without re-deriving one client-side.
      name: holderName(customer),
      // The ACCOUNT HOLDER, distinct from the billing contact in
      // `address` below. Both are on the wire because the buyer surface needs both
      // chains: it greets the person by THIS name and prints the address contact on
      // the invoice. Without these the portal's only customer-level name was our
      // invented `name` column, so a buyer with first/last set was greeted by email.
      first_name: customer.firstName,
      last_name: customer.lastName,
      company: customer.company,
      email: customer.email,
      // Customer-level phone (distinct from the billing address's). RazorPay's
      // Checkout asks the buyer for a contact when we can't prefill one, so both
      // are exposed and the buyer surface prefers this one.
      phone: customer.phone,
      // GSTIN (or equivalent) — F-23. Same column the checkout writes
      // (`taxRegistrationNumber`); the portal is the only self-serve way to set it
      // once a customer already exists without one.
      tax_registration_number: customer.taxRegistrationNumber,
      address: {
        line1: customer.addressLine1,
        line2: customer.addressLine2,
        line3: customer.addressLine3,
        city: customer.city,
        state: customer.state,
        state_code: customer.stateCode,
        postal_code: customer.postalCode,
        country: customer.country,
        first_name: customer.billingFirstName,
        last_name: customer.billingLastName,
        company: customer.billingCompany,
        phone: customer.billingPhone,
      },
      // Indian-gateway export rule: card setup needs a name + address up front.
      //
      // ANY usable billing name satisfies it — the address contact, then the account
      // holder (`hasBillingName`). This used to test the legacy `customer.name` column
      // alone, which made our own invention a hard requirement for vaulting a card: a
      // buyer who filled in First/Last was told their billing details were incomplete
      // and had no field left to fix it with, because no form asks for `name`.
      // Line1 and country count only where this portal requires them (0334).
      billing_details_complete: billingDetailsComplete(fieldConfig, hasBillingName(customer), {
        line1: customer.addressLine1,
        country: customer.country,
      }),
    },
    // Brand Styles (0185) — without these the hosted portal has no identity but the
    // business NAME, which is why it drew an initials monogram. Falls back
    // logo → icon → monogram on the client; `null` is a normal, common state.
    business: {
      name: business.name,
      // So the buyer sees a test-mode portal is not real billing.
      livemode: business.livemode,
      logo_url: business.logoUrl,
      icon_url: business.iconUrl,
      favicon_url: business.faviconUrl,
      brand_color: business.brandColor,
      /** 0238 — may this customer type a coupon code here? Off by default. */
      allow_customer_coupons: business.allowCustomerCoupons,
      /**
       * The business timezone, so the buyer surface can render a date the way the
       * business's own dashboard does. Without it the portal fell back to UTC and
       * showed a different issue date than the invoice PDF for any business east of
       * Greenwich — a customer-facing discrepancy on the one screen where the
       * customer is reading their own invoice. Null is normal (no timezone set) and
       * the client falls back as it did before.
       */
      timezone: business.timezone,
      /** 0360 — the business collects a ship-to (its checkout `shipping.address` is not hidden). */
      collects_shipping_address: collectsShipping(business),
    },
  });

  app.get("/portal/v1/me", { preHandler: authenticatePortal }, async (req, reply) => {
    const ctx = req.portalSession!;
    const [customer, business] = await Promise.all([
      getPortalCustomer(ctx),
      getPortalBusiness(ctx),
    ]);
    if (!customer || !business) return notFound(reply, "Portal session target no longer exists");
    // Phase 4b: where "Back to <business>" goes. The integration's own redirect_url wins.
    const [sessionRow] = await withTenant(ctx.organizationId, (tx) =>
      tx
        .select({ redirectUrl: portalSessions.redirectUrl })
        .from(portalSessions)
        .where(eq(portalSessions.publicId, ctx.sessionPublicId))
        .limit(1),
    );
    const sf = resolveStorefrontConfig(business);
    return {
      ...serializePortalMe(customer, business, await portalLocks(business)),
      return_url: sessionRow?.redirectUrl ?? sf.portalReturnUrl ?? sf.defaultReturnUrl,
    };
  });

  // Buyer updates their own billing identity (name + billing address) — the
  // self-serve counterpart of the operator's customer edit. Deliberately
  // limited to these fields (no email/currency/collection settings).
  app.patch(
    "/portal/v1/me",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const parsed = parseRequest(portalMeBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const [customer, business] = await Promise.all([
        getPortalCustomer(ctx),
        getPortalBusiness(ctx),
      ]);
      if (!customer || !business) return notFound(reply, "Portal session target no longer exists");
      const locks = await portalLocks(business);
      const fieldConfig = withAddressFieldLocks(resolvePortalFieldConfig(business), locks);
      // `applyAddress` replaces the whole address, so a hidden or read-only key must carry
      // the STORED value through, whatever the body says.
      const stored: Record<AddressMatrixField, string | null> = {
        first_name: customer.billingFirstName,
        last_name: customer.billingLastName,
        company: customer.billingCompany,
        phone: customer.billingPhone,
        line1: customer.addressLine1,
        line2: customer.addressLine2,
        line3: customer.addressLine3,
        city: customer.city,
        state: customer.state,
        state_code: customer.stateCode,
        postal_code: customer.postalCode,
        country: customer.country,
      };
      let address: typeof stored | undefined;
      if (parsed.data.address !== undefined) {
        const merged = mergePortalAddress(fieldConfig, stored, parsed.data.address);
        address = merged.address;
        const keptAny = merged.keptAny;
        const missing = addressRequirementIssues(fieldConfig, address);
        if (missing.length > 0) return badRequest(reply, requirementIssuesError(missing));
        // The body was format-checked alone; a kept value can change what is valid
        // (a read-only country decides the region list).
        if (keptAny) {
          const check = z
            .object({})
            .passthrough()
            .superRefine(addressRefinement)
            .safeParse(address);
          if (!check.success) return badRequest(reply, check.error);
        }
      }
      const taxIdLocked = isPortalKeyLocked(fieldConfig, "customer.tax_registration_number");
      const taxId =
        parsed.data.tax_registration_number === undefined || taxIdLocked
          ? undefined
          : parsed.data.tax_registration_number || null;
      if (
        fieldConfig["customer.tax_registration_number"] === "mandatory" &&
        !(taxId !== undefined ? taxId : customer.taxRegistrationNumber)?.trim()
      ) {
        return badRequest(reply, "Tax registration number is required.");
      }
      // ⚠️ An update must never leave the customer with NO billable name. `address`
      // REPLACES the whole address, so a patch carrying a contact-less address can
      // delete the only name we had — and since `billing_details_complete` accepts the
      // account holder too, the buyer would be told their details are complete while
      // every invoice we print falls through to their email address. Compute the
      // post-update row and test it, rather than testing the body: an address-only
      // patch is legitimate for a customer whose account-holder name is already set.
      const afterUpdate = {
        ...customer,
        ...(address !== undefined
          ? {
              billingFirstName: address.first_name,
              billingLastName: address.last_name,
              billingCompany: address.company,
            }
          : {}),
      };
      if (!hasBillingName(afterUpdate)) {
        return badRequest(
          reply,
          "A billing name is required. Give the contact a first name, a last name or a company name. We print this name on your invoices.",
        );
      }
      const updated = await updateCustomer({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        customerPublicId: customer.publicId,
        // Empty string clears it (matches `updateCheckoutCustomerDetails`'s
        // `?.trim() || null`) rather than being sent through as `""`, which would
        // save an empty string instead of actually clearing the column.
        ...(taxId !== undefined ? { taxRegistrationNumber: taxId } : {}),
        ...(address !== undefined
          ? {
              address: {
                line1: address.line1,
                line2: address.line2,
                line3: address.line3,
                city: address.city,
                state: address.state,
                stateCode: address.state_code,
                postalCode: address.postal_code,
                country: address.country,
                firstName: address.first_name,
                lastName: address.last_name,
                company: address.company,
                phone: address.phone,
              },
            }
          : {}),
      });
      if (!updated) return notFound(reply, "Portal session target no longer exists");
      return serializePortalMe(updated, business, locks, fieldConfig);
    },
  );

  // ——— Buyer: shipping address book (0360) ————————————————————————————————————
  // Always the session's own customer: an `addr_…` of another customer resolves to 404.
  const refuse = (reply: FastifyReply, status: number, message: string) =>
    reply.code(status).send({ error: { type: "invalid_request_error", message } });

  app.get("/portal/v1/shipping_addresses", { preHandler: authenticatePortal }, async (req) => {
    const ctx = req.portalSession!;
    const rows = await listShippingAddresses(ctx.organizationId, ctx.customerId);
    return { object: "list", data: rows.map((r) => serializeShippingAddress(r)) };
  });

  app.post(
    "/portal/v1/shipping_addresses",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const parsed = parseRequest(portalShippingAddressBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const business = await getPortalBusiness(ctx);
      if (!business) return notFound(reply, "Portal session target no longer exists");
      // Open when the business collects a ship-to, or this customer already has a book.
      if (
        !collectsShipping(business) &&
        (await listShippingAddresses(ctx.organizationId, ctx.customerId)).length === 0
      )
        return refuse(reply, 403, "This account does not collect shipping addresses.");
      const missing = addressRequirementIssues(SHIPPING_REQUIRED, parsed.data);
      if (missing.length > 0) return badRequest(reply, requirementIssuesError(missing));
      try {
        const row = await createShippingAddress({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          customerId: ctx.customerId,
          fields: toPortalShippingFields(parsed.data),
          makeDefault: parsed.data.is_default,
        });
        return reply.code(201).send(serializeShippingAddress(row));
      } catch (e) {
        if (e instanceof ShippingAddressError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.patch(
    "/portal/v1/shipping_addresses/:addr",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const { addr } = req.params as { addr: string };
      const parsed = parseRequest(portalShippingAddressBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const current = await withTenant(ctx.organizationId, (tx) =>
        findShippingAddress(tx, ctx.businessId, ctx.customerId, addr),
      );
      if (!current) return notFound(reply, `No such shipping address: ${addr}`);
      // Check the address as it will be after the edit. A default-only change skips it.
      if (SHIPPING_ADDRESS_KEYS.some((k) => parsed.data[k] !== undefined)) {
        const stored = addressObject(current);
        const merged = Object.fromEntries(
          SHIPPING_ADDRESS_KEYS.map((k) => [
            k,
            parsed.data[k] !== undefined ? parsed.data[k] : stored[k],
          ]),
        );
        const missing = addressRequirementIssues(SHIPPING_REQUIRED, merged);
        if (missing.length > 0) return badRequest(reply, requirementIssuesError(missing));
      }
      try {
        const row = await updateShippingAddress({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          customerId: ctx.customerId,
          addressPublicId: addr,
          fields: toPortalShippingFields(parsed.data),
          isDefault: parsed.data.is_default,
        });
        if (!row) return notFound(reply, `No such shipping address: ${addr}`);
        return serializeShippingAddress(row);
      } catch (e) {
        if (e instanceof ShippingAddressError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.post(
    "/portal/v1/shipping_addresses/:addr/archive",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const { addr } = req.params as { addr: string };
      try {
        const row = await archiveShippingAddress({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          customerId: ctx.customerId,
          addressPublicId: addr,
        });
        if (!row) return notFound(reply, `No such shipping address: ${addr}`);
        return serializeShippingAddress(row);
      } catch (e) {
        // 409 while a live subscription ships to it; the message says which one.
        if (e instanceof ShippingAddressError) return refuse(reply, e.status, e.message);
        throw e;
      }
    },
  );

  app.get("/portal/v1/payment_methods", { preHandler: authenticatePortal }, async (req) => {
    const ctx = req.portalSession!;
    const rows = await listPaymentMethods(ctx.organizationId, ctx.customerId);
    return { object: "list", data: await serializePaymentMethods(ctx.organizationId, rows) };
  });

  // List the gateways the buyer can add a card through (active + vault-capable).
  // The portal shows these as a choice before starting the add-card flow.
  app.get(
    "/portal/v1/payment_methods/gateways",
    { preHandler: authenticatePortal },
    async (req) => {
      const ctx = req.portalSession!;
      /**
       * The currency to offer gateways FOR. Pay now passes the invoice's own, which on a
       * multi-currency business is not always the customer's derived one — and offering a
       * gateway that cannot take the invoice is a control that does nothing. Absent, the
       * customer-derived currency below stands, which is what the add-card flow wants.
       */
      // `purpose=payment` is the Pay now chooser: only accounts that take a payment now.
      const askedCurrency = parseRequest(
        z.object({
          currency: z.string().length(3).optional(),
          purpose: z.enum(["payment", "setup"]).optional(),
        }),
        req.query ?? {},
      );
      const purpose = askedCurrency.data?.purpose ?? "setup";
      const [customer, biz] = await Promise.all([getPortalCustomer(ctx), getPortalBusiness(ctx)]);
      // NOT `customer.currency ?? biz.defaultCurrency`: that column is usually null, and
      // the business default then filters the list by a currency this buyer owes nothing
      // in. Measured 2026-08-14 — an INR customer on a USD-default business was offered a
      // gateway list with RazorPay (INR-only) ABSENT, so the only gateway that could
      // collect their ₹66,025 invoice was unreachable from the portal. Shared with the
      // add-card flow's own currency resolution, which had the same bug.
      const currency =
        askedCurrency.data?.currency?.toUpperCase() ??
        (customer ? await resolveCustomerCurrency(ctx.organizationId, customer) : null) ??
        biz?.defaultCurrency ??
        undefined;
      const gws = await listVaultGatewaysForBusiness(
        ctx.organizationId,
        ctx.businessId,
        currency,
        purpose,
      );
      /**
       * What this buyer will actually be debited, and the amount above which the RAIL
       * they pick starts asking them to authenticate every time.
       *
       * The three RazorPay rails all "work", so refusing one would be wrong — but they
       * are not interchangeable above ₹15,000: a card or UPI mandate needs the payer's
       * bank approval on EVERY debit, while a netbanking e-mandate authenticates once
       * at registration and then collects unattended (measured, ₹66,025 on HDFC). A
       * buyer picking "card" for a ₹56,715 plan is choosing an OTP a month without
       * being told, which is the same defect as a control that does nothing.
       *
       * Sent as facts rather than as a recommendation: the portal decides how to say
       * it, and a non-INR customer gets nulls rather than an inapplicable rule.
       */
      const expectedDebitMinor =
        customer && currency
          ? await expectedRecurringDebit(ctx.organizationId, ctx.businessId, customer.id, currency)
          : 0n;
      const parties = () =>
        achAuthorizationParties(ctx.organizationId, ctx.businessId, ctx.customerId);
      const data = await Promise.all(
        gws.map(async (g) => ({
          id: g.id,
          gateway_key: g.gatewayKey,
          label: g.label,
          /**
           * The rails this gateway account actually has enabled — the same field the
           * checkout's equivalent route returns (F-16). It was dropped here, so the
           * storefront's add-card step fell through to a hardcoded
           * `['card','upi','bank_transfer']` guess and could offer a buyer UPI or
           * netbanking on a RazorPay account with neither switched on: a control that
           * does nothing, discovered only at the gateway's own sheet.
           *
           * Null when the account states no restriction, which is not the same as "no
           * methods" — `dashboard/lib/portal-api.ts` types it optional-and-nullable and
           * the caller falls back only on null.
           */
          // The rails this account can really offer for THIS currency — the operator's
          // list when set, the adapter's capabilities when not, minus the rails the
          // currency rules out. See `effectiveMethodTypes`.
          method_types: effectiveMethodTypes(g, currency, purpose),
          // Shown before a bank account is saved, where the gateway shows no text of its own.
          ach_authorization:
            purpose === "setup"
              ? await achAuthorizationTextFor(
                  g.gatewayKey,
                  effectiveMethodTypes(g, currency, purpose),
                  parties,
                )
              : null,
          // Pay now can send the buyer to this gateway's own page for Apple Pay.
          apple_pay_hosted: hostedApplePayOffered(g.gatewayKey),
        })),
      );
      return {
        object: "list",
        data,
        expected_debit_minor: Number(expectedDebitMinor),
        unattended_debit_limit_minor:
          currency && currency.toUpperCase() === "INR" ? Number(INR_AFA_FREE_CEILING_MINOR) : null,
      };
    },
  );

  // Begin an add-card flow. Vaults through the buyer's chosen gateway account
  // (`gateway_account`), or the business default when none is supplied.
  app.post(
    "/portal/v1/payment_methods/setup",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const parsed = parseRequest(portalSetupBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const customer = await getPortalCustomer(ctx);
      if (!customer) return notFound(reply, "Portal session target no longer exists");
      try {
        // Recorded as a zero-amount `setup` payment intent where that changes nothing
        // about the gateway call (see src/api/vault-setup.ts); the response fields are
        // the same either way, with `payment_intent`/`next_action` added.
        const outcome = await beginVaultSetup({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          customer,
          returnUrl: parsed.data.return_url,
          cancelUrl: parsed.data.cancel_url,
          gatewayAccountId: parsed.data.gateway_account,
          // This surface is "add a card", so say so. Without it RazorPay picks the
          // rail from the currency and an INR customer gets a NETBANKING e-mandate —
          // the buyer is shown a bank-login screen and a bank token is vaulted, not a
          // card. No-op for Stripe (already defaults to card) and PayPal (ignores it).
          methodTypes: parsed.data.method_type ? [parsed.data.method_type] : ["card"],
        });
        return reply.code(201).send(serializeVaultSetup(outcome));
      } catch (e) {
        if (
          e instanceof PaymentMethodConfigError ||
          e instanceof VaultSetupUnsupportedError ||
          e instanceof ProviderRefusalError
        ) {
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        }
        throw e;
      }
    },
  );

  // Complete an add-card flow (buyer-confirmed pm_… / approved setup token).
  app.post(
    "/portal/v1/payment_methods",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const parsed = parseRequest(portalVaultBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const customer = await getPortalCustomer(ctx);
      if (!customer) return notFound(reply, "Portal session target no longer exists");
      try {
        let pm: Awaited<ReturnType<typeof vaultPaymentMethod>>;
        if (parsed.data.payment_intent) {
          // Complete through the INTENT, not the token — the shared half of the add-card
          // flow, beside the `beginVaultSetup` this route already uses. See
          // `completeVaultFromIntent` for why the token path could double-vault.
          try {
            pm = await completeVaultFromIntent({
              organizationId: ctx.organizationId,
              businessId: ctx.businessId,
              customerId: ctx.customerId,
              paymentIntentPublicId: parsed.data.payment_intent,
              ...(parsed.data.client_result ? { clientResult: parsed.data.client_result } : {}),
              ...(parsed.data.ach_authorization
                ? {
                    achAuthorization: {
                      textVersion: parsed.data.ach_authorization.text_version,
                      ipAddress: clientIp(req),
                      userAgent: req.headers["user-agent"] ?? null,
                    },
                  }
                : {}),
            });
          } catch (e) {
            if (e instanceof AchAuthorizationError) return badRequest(reply, e.message);
            if (!(e instanceof VaultSetupIntentError)) throw e;
            log.warn("portal add-card refused", {
              event: "portal_add_card_refused",
              intent: parsed.data.payment_intent,
              detail: e.detail,
            });
            return e.status === 404 ? notFound(reply, e.message) : badRequest(reply, e.message);
          }
        } else {
          pm = await vaultPaymentMethod({
            organizationId: ctx.organizationId,
            businessId: ctx.businessId,
            customer,
            // Guaranteed by `portalVaultBody`'s refine: without `payment_intent` there
            // is a `token`.
            token: parsed.data.token!,
            // Vault on the SAME gateway the setup ran on (the buyer's pick). Without
            // this, completion falls back to the business default and looks the pm_
            // up on the wrong gateway account — the add-card silently fails.
            gatewayAccountId: parsed.data.gateway_account,
          });
        }
        /**
         * Billing LogIQ — "Collect open invoices when a payment method is added".
         *
         * The operator add-card route has always done this. The PORTAL did not, which
         * is backwards: this is the surface where customers actually add cards, and the
         * setting is ON by default. Measured 2026-08-17 on identical setups — operator
         * add-card left the invoice `paid`, portal add-card left the same invoice
         * `payment_due` with the full amount owing.
         *
         * It also silently broke the recovery path everything else leans on. A parked
         * invoice (a mandate below the amount due, a merchant-config refusal) is
         * supposed to clear "as soon as the customer fixes their instrument" — and when
         * they fixed it in the portal, nothing happened.
         *
         * Best-effort, exactly like the operator route: a recovery charge that errors
         * must never fail the vault the buyer just completed.
         */
        let collected: Array<{ invoice: string; status: string }> = [];
        try {
          const res = await collectOutstandingForNewPaymentMethod({
            organizationId: ctx.organizationId,
            businessId: ctx.businessId,
            customerId: ctx.customerId,
            paymentMethodPublicId: pm.publicId,
          });
          collected = res.collected;
        } catch (e) {
          log.warn("collect-on-payment-method-update failed after a portal vault", {
            event: "portal_collect_after_vault_failed",
            detail: (e as Error).message,
          });
        }
        return reply.code(201).send({
          ...(await serializePaymentMethodWithGateway(ctx.organizationId, pm)),
          collected,
        });
      } catch (e) {
        // A gateway that refuses the token isn't a server fault: tell the buyer
        // what to do, and keep the provider's own text in the log for operators.
        if (e instanceof PaymentMethodVaultError) {
          log.warn("portal vault rejected by gateway", {
            event: "portal_vault_rejected",
            detail: e.detail,
          });
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        }
        if (e instanceof PaymentMethodConfigError) {
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        }
        throw e;
      }
    },
  );

  app.post(
    "/portal/v1/payment_methods/:pm/default",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const pm = (req.params as { pm: string }).pm;
      const updated = await setDefaultPaymentMethod(ctx.organizationId, ctx.customerId, pm);
      if (!updated) return notFound(reply, `No such payment method: ${pm}`);
      return serializePaymentMethodWithGateway(ctx.organizationId, updated);
    },
  );

  /**
   * The buyer assigns a collection role, from the side that owns the cards.
   *
   * The portal could set `primary` (via `/default` above) and nothing else, so a buyer
   * could see which card pays first but could not designate the one that pays if it
   * fails — while the engine has always had a two-slot model and falls back to the
   * backup before dunning begins. Both roles now reach the buyer.
   *
   * `none` removes a backup from automatic collection. The primary cannot be demoted
   * (409): a buyer wanting a different card first names that card.
   *
   * `/default` stays as it is rather than being folded in: it is the older shape, an
   * un-updated client must not break, and it is exactly `role: 'primary'` — the sugar
   * `setDefaultPaymentMethod` has always been.
   */
  app.post(
    "/portal/v1/payment_methods/:pm/role",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const pm = (req.params as { pm: string }).pm;
      const parsed = parseRequest(
        z.object({ role: z.enum(["primary", "backup", "none"]) }),
        req.body,
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      let updated;
      try {
        updated = await assignPaymentMethodRole(
          ctx.organizationId,
          ctx.customerId,
          pm,
          parsed.data.role,
        );
      } catch (e) {
        if (e instanceof PrimaryDemotionError) return conflict(reply, e.message);
        throw e;
      }
      // Scoped to the session's own customer by `assignPaymentMethodRole`'s own WHERE, so
      // another customer's `pm_…` is indistinguishable from one that does not exist.
      if (!updated) return notFound(reply, `No such payment method: ${pm}`);
      return serializePaymentMethodWithGateway(ctx.organizationId, updated);
    },
  );

  app.delete(
    "/portal/v1/payment_methods/:pm",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      // Portal permission (storefront_config, 2026-09-09). Default ON, so a business that
      // has configured nothing behaves exactly as before. A merchant turns this off when a
      // live mandate depends on the instrument: nothing here refuses the deletion of a card
      // a subscription needs, so this switch is the only thing standing between a buyer and
      // a renewal with nothing to charge.
      {
        const biz = await getBusinessById(ctx.organizationId, ctx.businessId);
        if (!resolveStorefrontConfig(biz).allowRemovePaymentMethod)
          return reply.code(403).send({
            error: {
              type: "invalid_request_error",
              message:
                "This account does not allow removing a payment method here. Contact us to change it.",
            },
          });
      }
      const pm = (req.params as { pm: string }).pm;
      const ok = await detachPaymentMethod(ctx.organizationId, ctx.customerId, pm);
      if (!ok) return notFound(reply, `No such payment method: ${pm}`);
      return { object: "payment_method", id: pm, deleted: true };
    },
  );

  /**
   * The guard every buyer-initiated subscription action shares: find the subscription
   * SCOPED TO THIS BUYER, then check the merchant's permission.
   *
   * Ownership first, and the predicate carries `customerId` as well as the business —
   * without it one buyer could act on another's subscription, which is the shape
   * `verify:bola` pins. The permission check comes second so a 403 can never confirm that
   * a subscription id exists on the business; the 404's wording exists to avoid exactly
   * that, and checking the permission first would undo it.
   *
   * Returns the row on success, or null after having already replied.
   */
  const guardSubscriptionAction = async (
    req: FastifyRequest,
    reply: FastifyReply,
    allowed: (cfg: ReturnType<typeof resolveStorefrontConfig>) => boolean,
    refusal: string,
  ): Promise<{ id: string; status: string } | null> => {
    const ctx = req.portalSession!;
    const { sub } = req.params as { sub: string };
    const [row] = await withTenant(ctx.organizationId, (tx) =>
      tx
        .select({ id: subscriptions.id, status: subscriptions.status })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.publicId, sub),
            eq(subscriptions.businessId, ctx.businessId),
            eq(subscriptions.customerId, ctx.customerId),
            notDeleted(),
          ),
        )
        .limit(1),
    );
    if (!row) {
      notFound(reply, `No such subscription: ${sub}`);
      return null;
    }
    const biz = await getBusinessById(ctx.organizationId, ctx.businessId);
    if (!allowed(resolveStorefrontConfig(biz))) {
      reply.code(403).send({ error: { type: "invalid_request_error", message: refusal } });
      return null;
    }
    return row;
  };

  // ——— Buyer: the cancel flow with offers (storefront Phase 3) ——————————————————
  app.get(
    "/portal/v1/subscriptions/:sub/cancel_flow",
    { preHandler: [authenticatePortal] },
    async (req, reply) => {
      const { sub } = req.params as { sub: string };
      try {
        return await getCancelFlow(portalCtx(req), sub);
      } catch (e) {
        return changeError(reply, e);
      }
    },
  );

  app.post(
    "/portal/v1/subscriptions/:sub/retention_offer",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const { sub } = req.params as { sub: string };
      const body = parseRequest(
        z.object({
          offer: z.enum(["pause", "downgrade", "discount", "contact"]),
          months: z.number().int().min(1).max(12).optional(),
          reason_code: z.string().trim().min(1).max(100).optional(),
        }),
        req.body ?? {},
      );
      if (!body.success) return badRequest(reply, body.error);
      try {
        return await acceptRetentionOffer(portalCtx(req), sub, {
          offer: body.data.offer,
          ...(body.data.months !== undefined ? { months: body.data.months } : {}),
          ...(body.data.reason_code !== undefined ? { reasonCode: body.data.reason_code } : {}),
        });
      } catch (e) {
        if (e instanceof CouponError) return badRequest(reply, e.message);
        return changeError(reply, e);
      }
    },
  );

  // ——— Buyer: plan, seat and add-on changes (storefront Phase 2) ———————————————
  const changeBody = z.object({
    plan: z.string().max(LIMITS.id).min(1).optional(),
    seats: z.number().int().min(1).max(100000).optional(),
    addons: z
      .array(
        z.object({
          price: z.string().max(LIMITS.id).min(1),
          quantity: z.number().int().min(0).max(100000),
        }),
      )
      .max(50)
      .optional(),
    timing: z.enum(["now", "end_of_term"]).optional(),
    // `downgrade_credit: customer_chooses` only; see the preview's `credit_handling_options`.
    credit_handling: z.enum(["credit_balance", "refund"]).optional(),
  });
  const portalCtx = (req: FastifyRequest) => {
    const s = req.portalSession!;
    return { organizationId: s.organizationId, businessId: s.businessId, customerId: s.customerId };
  };
  const changeError = (reply: FastifyReply, e: unknown) => {
    if (e instanceof PortalChangeError)
      return reply
        .code(e.status)
        .send({ error: { type: "invalid_request_error", message: e.message } });
    // Engine refusals (a mandatory add-on, a cancelled subscription) are buyer-safe text.
    if (e instanceof ProrationError || e instanceof SubscriptionError)
      return badRequest(reply, e.message);
    throw e;
  };

  app.get(
    "/portal/v1/subscriptions/:sub/change_options",
    { preHandler: [authenticatePortal] },
    async (req, reply) => {
      const { sub } = req.params as { sub: string };
      try {
        return await getChangeOptions(portalCtx(req), sub);
      } catch (e) {
        return changeError(reply, e);
      }
    },
  );

  app.post(
    "/portal/v1/subscriptions/:sub/change/preview",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const { sub } = req.params as { sub: string };
      const body = parseRequest(changeBody, req.body ?? {});
      if (!body.success) return badRequest(reply, body.error);
      try {
        return await previewPortalChange(portalCtx(req), sub, body.data);
      } catch (e) {
        return changeError(reply, e);
      }
    },
  );

  app.post(
    "/portal/v1/subscriptions/:sub/change",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const { sub } = req.params as { sub: string };
      const body = parseRequest(
        changeBody.extend({
          expected_total_minor: z.number().int().nonnegative(),
          /** From the preview: the instant it priced at, and the quote of its amounts. */
          priced_at: z.string().datetime().optional(),
          quote: z.string().max(64).optional(),
        }),
        req.body ?? {},
      );
      if (!body.success) return badRequest(reply, body.error);
      try {
        const {
          expected_total_minor: expectedTotalMinor,
          priced_at: pricedAt,
          quote,
          ...request
        } = body.data;
        return await applyPortalChange(portalCtx(req), sub, {
          ...request,
          expectedTotalMinor,
          ...(pricedAt ? { pricedAt } : {}),
          ...(quote ? { quote } : {}),
        });
      } catch (e) {
        return changeError(reply, e);
      }
    },
  );

  app.delete(
    "/portal/v1/subscriptions/:sub/scheduled_change",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const { sub } = req.params as { sub: string };
      try {
        return await cancelPortalScheduledChange(portalCtx(req), sub);
      } catch (e) {
        return changeError(reply, e);
      }
    },
  );

  /**
   * Pause and resume, as ONE permission.
   *
   * Pause passes no options, so the business's own 0242 `pause_config` decides unbilled
   * charges and dunning: a buyer pause and an operator pause on one business behave
   * identically, for the same reason cancellation's money handling is not set here.
   */
  app.post(
    "/portal/v1/subscriptions/:sub/pause",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const row = await guardSubscriptionAction(
        req,
        reply,
        (c) => c.allowPauseResume,
        "This account does not offer pausing here. Contact us to pause.",
      );
      if (!row) return;
      if (row.status === "paused")
        return reply.code(409).send({
          error: { type: "invalid_request_error", message: "This subscription is already paused." },
        });

      const { pauseSubscriptionWithOptions } = await import("@/modules/subscriptions/service");
      const r = await pauseSubscriptionWithOptions({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        subscriptionId: row.id,
        now: new Date(),
      });
      return reply.code(200).send({
        object: "portal_subscription_pause",
        id: r.subscription.publicId,
        status: r.subscription.status,
        // A pause can be SCHEDULED rather than immediate, depending on the business's
        // `pause_config`. Reporting it means the portal never says "paused" over a
        // subscription that is still running.
        resume_scheduled_at: r.resumeScheduledAt,
        scheduled_change: r.scheduledChange,
      });
    },
  );

  app.post(
    "/portal/v1/subscriptions/:sub/resume",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const row = await guardSubscriptionAction(
        req,
        reply,
        // Resume is also open to a customer who paused through the cancel flow's offer.
        () => true,
        "This account does not offer resuming here. Contact us to resume.",
      );
      if (!row) return;
      const resumeCfg = resolveStorefrontConfig(
        await getBusinessById(ctx.organizationId, ctx.businessId),
      );
      if (!resumeCfg.allowPauseResume && !(await pausedByOffer(ctx.organizationId, row.id)))
        return reply.code(403).send({
          error: {
            type: "invalid_request_error",
            message: "This account does not offer resuming here. Contact us to resume.",
          },
        });
      if (row.status !== "paused")
        return reply.code(409).send({
          error: { type: "invalid_request_error", message: "This subscription is not paused." },
        });

      // The operator's resume, with no options: the business's `pause_config` decides how
      // an out-of-term resume bills its new term.
      const { resumeSubscriptionWithOptions } = await import("@/modules/subscriptions/service");
      const { subscription: s, invoice } = await resumeSubscriptionWithOptions({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        subscriptionId: row.id,
        now: await businessWallClock(ctx.businessId),
      });
      return reply.code(200).send({
        object: "portal_subscription_resume",
        id: s.publicId,
        status: s.status,
        latest_invoice: invoice,
      });
    },
  );

  /**
   * Undo a pending cancellation.
   *
   * SCOPED to a subscription that is still ACTIVE with `cancel_at_period_end`, which is the
   * half `reactivateSubscription` performs with no money movement. An already-cancelled
   * subscription is refused: restarting one makes it `billable`, so the new period must be
   * charged, which needs the business's charges-handling decision and can fail at the
   * gateway. That is a checkout, not a one-click portal action.
   */
  app.post(
    "/portal/v1/subscriptions/:sub/reactivate",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const row = await guardSubscriptionAction(
        req,
        reply,
        (c) => c.allowReactivate,
        "This account does not offer this here. Contact us to keep your subscription.",
      );
      if (!row) return;
      if (row.status === "cancelled")
        return reply.code(409).send({
          error: {
            type: "invalid_request_error",
            message:
              "This subscription already ended. Contact us to start it again. A restart bills the " +
              "new period, so we will do it with you.",
          },
        });

      const { reactivateSubscription } = await import("@/modules/subscriptions/service");
      const r = await reactivateSubscription({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        subscriptionId: row.id,
        now: new Date(),
      });
      // `billable` is the service telling the caller to charge a new period. The
      // already-cancelled branch above is the only path that sets it, so reaching here
      // with `billable` means that guard has been bypassed — log rather than silently
      // skip the charge, because a subscription running unbilled is worse than a refusal.
      if (r.billable)
        log.error("portal reactivate returned billable — the new period was NOT charged", {
          event: "portal_reactivate_unexpectedly_billable",
          subscription: r.subscription.publicId,
          businessId: ctx.businessId,
        });
      return reply.code(200).send({
        object: "portal_subscription_reactivate",
        id: r.subscription.publicId,
        status: r.subscription.status,
        cancel_at_period_end: r.subscription.cancelAtPeriodEnd,
      });
    },
  );

  /**
   * Buyer-initiated cancellation.
   *
   * ── Two policies, both the MERCHANT's ───────────────────────────────────────
   * `allow_cancel_subscription` decides whether a buyer may do this at all (default OFF —
   * the route is new, and a deploy must not hand every merchant's buyers a cancel button).
   * `cancel_timing` decides WHEN it takes effect, and is deliberately NOT a request
   * parameter: `immediately` decides whether the merchant keeps a term they have already
   * been paid for, which is commercial policy rather than a buyer preference. A buyer who
   * wants a different date has to ask, which is the correct escalation. The optional
   * `end_of_term` body flag only CONFIRMS that policy: a value that contradicts it is a 400,
   * never a switch. `reason_code` must be one the business offers for cancellation.
   *
   * ── Money is not decided here ───────────────────────────────────────────────
   * No AR / refundable-credit / unbilled-charge arguments are passed, so
   * `cancelSubscriptionWithOptions` resolves the business's own 0242 defaults — the same
   * ones an operator cancel resolves. A buyer cancel and an operator cancel on one
   * business therefore settle money identically, which is the only defensible answer: the
   * money policy belongs to the business, not to who pressed the button.
   *
   * ── Ordering ────────────────────────────────────────────────────────────────
   * Ownership first (scoped on `customerId`, the shape `verify:bola` pins), THEN the
   * permission. A 403 before the ownership check would confirm that a subscription id
   * exists on the business, which is exactly what the 404's wording avoids.
   */
  app.post(
    "/portal/v1/subscriptions/:sub/cancel",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const { sub } = req.params as { sub: string };
      const body = parseRequest(
        portalCancelBody,
        req.body && typeof req.body === "object" ? req.body : {},
      );
      if (!body.success) return badRequest(reply, body.error);

      // Scoped on `customerId` as well as the business: without it one buyer could cancel
      // another's subscription. Same predicate as the coupon route above.
      const [row] = await withTenant(ctx.organizationId, (tx) =>
        tx
          .select({ id: subscriptions.id, status: subscriptions.status })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.publicId, sub),
              eq(subscriptions.businessId, ctx.businessId),
              eq(subscriptions.customerId, ctx.customerId),
              notDeleted(),
            ),
          )
          .limit(1),
      );
      if (!row) return notFound(reply, `No such subscription: ${sub}`);

      const biz = await getBusinessById(ctx.organizationId, ctx.businessId);
      const cfg = resolveStorefrontConfig(biz);
      if (!cfg.allowCancelSubscription)
        return reply.code(403).send({
          error: {
            type: "invalid_request_error",
            message: "This account does not offer cancellation here. Contact us to cancel.",
          },
        });

      // Already terminal: say so plainly rather than letting the service throw. A buyer
      // pressing cancel twice is not an error worth a 500, and "already cancelled" is the
      // answer they need either way.
      if (row.status === "cancelled")
        return reply.code(409).send({
          error: {
            type: "invalid_request_error",
            message: "This subscription is already cancelled.",
          },
        });

      const { end_of_term: endOfTerm, reason_code: reasonCode, reason } = body.data;
      if (cfg.cancelReason === "required" && reasonCode === undefined)
        return badRequest(reply, "Select a reason for the cancellation.");
      if (endOfTerm !== undefined && endOfTerm !== (cfg.cancelTiming === "end_of_term"))
        return badRequest(
          reply,
          cfg.cancelTiming === "end_of_term"
            ? "This account cancels at the end of the current term. You cannot cancel immediately here."
            : "This account cancels immediately. You cannot cancel at the end of the term here.",
        );
      if (reasonCode !== undefined) {
        const { reasons } = await resolveOfferedReasons(
          ctx.organizationId,
          ctx.businessId,
          "subscription_cancellation",
        );
        if (!reasons.some((r) => r.code === reasonCode))
          return badRequest(
            reply,
            `Unknown reason_code '${reasonCode}'. Offered: ${reasons.map((r) => r.code).join(", ")}`,
          );
      }

      const { cancelSubscriptionWithOptions } = await import("@/modules/subscriptions/service");
      const result = await cancelSubscriptionWithOptions({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        // The INTERNAL id, not the `sub_…` public id from the path — the service resolves
        // `subscriptions.id`, so a public id here fails as a uuid-cast 500 rather than a
        // clear error. Both are `string`, so the compiler cannot tell them apart; the
        // coupon route above passes `row.id` for the same reason.
        subscriptionId: row.id,
        now: new Date(),
        // A paused subscription has no term end, so it ends now: nothing is billed while paused.
        cancelOption: row.status === "paused" ? "immediately" : cfg.cancelTiming,
        // Attributed to the buyer, so the timeline distinguishes this from an operator
        // cancelling on their behalf — the two mean different things in a churn review.
        // The buyer's words when given; otherwise the attribution as before.
        cancelReason: reason ?? "Cancelled by the customer from the self-serve portal",
        ...(reasonCode !== undefined ? { cancelReasonCode: reasonCode } : {}),
      });

      await recordPortalCancellation(
        {
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          customerId: ctx.customerId,
        },
        row.id,
        {
          ...(reasonCode !== undefined ? { reasonCode } : {}),
          offersShown: body.data.offers_shown === true,
        },
      );
      return reply.code(200).send({
        object: "portal_subscription_cancel",
        id: sub,
        status: result.subscription.status,
        // `end_of_term` schedules rather than cancels, so the buyer must be told which
        // happened — "cancelled" over a subscription that still bills once more would be
        // the portal's own version of a control that lies.
        effective: cfg.cancelTiming,
        /**
         * WHEN it takes effect, read from whichever field actually holds it — the two
         * timings store it in different places, and reporting the wrong one would tell a
         * buyer their subscription ends on a date it does not.
         *   immediately  → `canceled_at`, the instant it ended.
         *   end_of_term  → the scheduled instant if a specific date was set, otherwise the
         *                  current period's end, which is what `cancel_at_period_end` means.
         */
        cancels_at:
          cfg.cancelTiming === "immediately"
            ? (result.subscription.canceledAt ?? null)
            : (result.subscription.cancelScheduledAt ??
              result.subscription.currentPeriodEnd ??
              null),
        // The flag itself, so a client does not have to infer "still billing once more"
        // from a date comparison.
        cancel_at_period_end: result.subscription.cancelAtPeriodEnd,
        scheduled_change: result.scheduledChange,
      });
    },
  );

  // ——— Buyer: invoices (read-only, #10c) ———————————————————————————————————
  // Always scoped to the session's own customer — a buyer can never enumerate
  // or fetch another customer's invoices even by guessing an id.
  /**
   * What the buyer is actually subscribed to, and what we will take next.
   *
   * The portal had NO subscription data at all: it opened with "You're all paid up" over
   * "No invoices yet" and never named the plan, the add-ons, the amount or the date. Those
   * are the two facts a billing portal exists to state, and a customer who has just signed
   * up has no invoice to infer them from.
   *
   * Everything here is derived, never stored twice:
   *  - item amounts come from each item's frozen `price_snapshot`, which is the rate the
   *    invoice will bill — the catalog row is 0 for a differential add-on (the same trap
   *    that rendered "₹0.00 / month" on the checkout until 2026-08-27);
   *  - the next payment is `estimateRenewal`, so its total, its GST split and its date are
   *    the ones the document will carry;
   *  - `mandate_shortfall` rides along on that estimate. It was declined as its own portal
   *    feature on cost — a whole invoice plan per page load to catch a rare state — and the
   *    cost is gone now that the same estimate is loaded for the panel above it.
   */
  /**
   * Skip, or undo a skip of, one upcoming renewal of the buyer's own subscription. Gated on
   * `storefront_config.allow_skip_renewal` and capped by `skip_renewal_limit` per 12 months;
   * the operator's API has no cap.
   */
  const portalSkipBody = z.object({ renewal_at: z.string().datetime({ offset: true }) });
  for (const action of ["skip_renewal", "unskip_renewal"] as const) {
    app.post(
      `/portal/v1/subscriptions/:sub/${action}`,
      { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
      async (req, reply) => {
        const ctx = req.portalSession!;
        const row = await guardSubscriptionAction(
          req,
          reply,
          (c) => c.allowSkipRenewal,
          "This account does not offer skipping a renewal here. Contact us to skip one.",
        );
        if (!row) return;
        const p = portalSkipBody.safeParse(req.body ?? {});
        if (!p.success)
          return reply.code(400).send({
            error: { type: "invalid_request_error", message: "Enter the renewal date to change." },
          });
        const now = await businessWallClock(ctx.businessId);
        const renewalAt = new Date(p.data.renewal_at);
        try {
          const { subscription, skip } =
            action === "skip_renewal"
              ? await skipRenewal({
                  organizationId: ctx.organizationId,
                  businessId: ctx.businessId,
                  subscriptionId: row.id,
                  renewalAt,
                  source: "portal",
                  now,
                  limit: resolveStorefrontConfig(
                    await getBusinessById(ctx.organizationId, ctx.businessId),
                  ).skipRenewalLimit,
                })
              : await unskipRenewal({
                  organizationId: ctx.organizationId,
                  subscriptionId: row.id,
                  renewalAt,
                  now,
                });
          return reply.code(200).send({
            object: "portal_renewal_skip",
            subscription: subscription.publicId,
            renewal_at: skip.renewalAt,
            skipped: skip.status === "scheduled",
            next_payment_at: await nextChargeAt(ctx.organizationId, row.id),
          });
        } catch (e) {
          if (e instanceof SubscriptionError)
            return reply
              .code(400)
              .send({ error: { type: "invalid_request_error", message: e.message } });
          throw e;
        }
      },
    );
  }

  /** When the subscription is next charged: the trial end, else the first renewal not skipped. */
  const nextChargeAt = async (organizationId: string, subscriptionId: string) => {
    const [sub] = await withTenant(organizationId, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).limit(1),
    );
    if (!sub) return null;
    if (sub.status === "in_trial") return sub.trialEnd;
    const view = (await renewalSkipViews(organizationId, [sub])).get(sub.id);
    return view ? view.nextBillingAt : sub.currentPeriodEnd;
  };

  app.get("/portal/v1/subscriptions", { preHandler: authenticatePortal }, async (req) => {
    const ctx = req.portalSession!;
    const hideCancelled = resolveStorefrontConfig(
      await getBusinessById(ctx.organizationId, ctx.businessId),
    ).portalHideCancelledSubscriptions;
    const subs = await withTenant(ctx.organizationId, (tx) =>
      tx
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.businessId, ctx.businessId),
            eq(subscriptions.customerId, ctx.customerId),
            notDeleted(),
            // Portal "hide cancelled subscriptions" (Phase 4), in the query like the rest.
            ...(hideCancelled ? [ne(subscriptions.status, "cancelled")] : []),
          ),
        )
        .orderBy(desc(subscriptions.createdAt))
        .limit(PORTAL_SUBSCRIPTION_LIMIT + 1),
    );
    const shown = subs.slice(0, PORTAL_SUBSCRIPTION_LIMIT);
    if (subs.length > shown.length) {
      log.info("portal subscription list truncated", {
        event: "portal_subscriptions_truncated",
        customerId: ctx.customerId,
        shown: shown.length,
        skipped: subs.length - shown.length,
      });
    }

    // 0243 — the portal half of `storefront_config.hide_zero_value_lines`; the checkout's
    // twin lives in `getCheckoutView` (src/modules/checkout/service.ts).
    const biz = await getBusinessById(ctx.organizationId, ctx.businessId);
    const storefront = resolveStorefrontConfig(biz);
    const { hideZeroValueLines, allowSkipRenewal, skipRenewalLimit } = storefront;
    const now = await businessWallClock(ctx.businessId);
    // Read once, only when cancel is on: every cancelable row offers the same list.
    const cancelReasons = storefront.allowCancelSubscription
      ? (
          await resolveOfferedReasons(
            ctx.organizationId,
            ctx.businessId,
            "subscription_cancellation",
          )
        ).reasons
      : [];

    const data = [];
    for (const sub of shown) {
      const items = await withTenant(ctx.organizationId, (tx) =>
        tx
          .select({
            item: subscriptionItems,
            price: prices,
            kind: products.kind,
            productName: products.name,
          })
          .from(subscriptionItems)
          .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
          .innerJoin(products, eq(products.id, prices.productId))
          .where(eq(subscriptionItems.subscriptionId, sub.id)),
      );

      const itemViews = items.map(({ item, price, kind, productName }) => {
        // The FROZEN snapshot is the rate that will be billed — a differential add-on's
        // catalog `amount_minor` is 0, and a custom price lives only in the snapshot.
        const snap = (item.priceSnapshot as PriceSnapshot | null) ?? null;
        const amountMinor =
          snap?.amountMinor ?? (price.amountMinor != null ? Number(price.amountMinor) : null);
        return {
          name: price.externalName ?? productName ?? price.publicId,
          kind,
          quantity: item.quantity,
          /** Per-unit, in the item's own cadence. Null for a model with no single rate. */
          unit_amount_minor: amountMinor,
          /** What this line contributes to a period, i.e. unit × quantity. */
          amount_minor: amountMinor != null ? amountMinor * item.quantity : null,
          interval: snap?.interval ?? price.interval,
          interval_count: snap?.intervalCount ?? price.intervalCount,
        };
      });

      /**
       * The next invoice, or null when there will not be one — a cancelling subscription
       * must not be shown a "next payment" it will never be sent. `estimateRenewal` returns
       * null in exactly those cases (cancelling, cycle cap reached, not active/in_trial), so
       * the absence is the engine's answer rather than a second rule here.
       */
      let unpriced: { type: string; effective_at: string } | null = null;
      const renewal = await estimateRenewal({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        subscriptionId: sub.id,
        onUnpriced: (c) => {
          unpriced = c;
        },
      });
      const pending = unpriced as { type: string; effective_at: string } | null;

      // Zero-amount lines dropped from what's SHOWN only — the subtotal below still sums
      // the full set (a real 0 contributes nothing to it either way, so the total cannot
      // move). `amount_minor === 0`, never `!amount_minor`: a usage/tiered item has no
      // single rate and reports `null`, which is "unknown", not "free".
      const visibleItems = hideZeroValueLines
        ? itemViews.filter((i) => i.amount_minor !== 0)
        : itemViews;

      data.push({
        object: "subscription",
        id: sub.publicId,
        status: apiSubscriptionStatus(sub),
        currency: sub.currency,
        items: visibleItems,
        /** The page asks `/usage` only for these; the list never computes usage. */
        has_metered_items: items.some(({ item, price }) =>
          isMeteredPrice((item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(price)),
        ),
        /** Σ line amounts, PRE-tax — "your plan", not "what we will charge". */
        recurring_subtotal_minor: itemViews.reduce((t, i) => t + (i.amount_minor ?? 0), 0),
        current_period_end: sub.currentPeriodEnd,
        /** The oldest live discount, or null. `discounts` below has all of them. */
        discount: await portalSubscriptionDiscount(ctx.organizationId, sub.id),
        // Every live discount, and how many more codes the buyer can enter here (0495).
        ...(await portalSubscriptionDiscounts(
          ctx.organizationId,
          sub.id,
          biz?.maxCustomerCouponCodes ?? 1,
        ).then((d) => ({ discounts: d.discounts, coupon_codes_left: d.couponCodesLeft }))),
        // Ship-to (0360): `shipping_address_id` null = ships to the customer's default.
        ...(await portalShipTo(ctx.organizationId, sub)),
        trial_end: sub.trialEnd,
        cancel_at_period_end: sub.cancelAtPeriodEnd,
        cancels_at: sub.cancelScheduledAt,
        next_payment: renewal
          ? {
              // The instant of the charge: the trial end, else the first renewal not skipped.
              // (`new_period_end` is the end of the term that renewal starts, a period later.)
              at: await nextChargeAt(ctx.organizationId, sub.id),
              /** Tax included — the figure the invoice will state. */
              total_minor: renewal.total_minor,
              /** After the customer's credit balance, i.e. what we would actually collect. */
              amount_due_minor: renewal.amount_due_minor ?? renewal.total_minor,
              currency: renewal.currency,
              /** Named as the invoice names them: CGST + SGST, or IGST, or one row. */
              tax_lines: renewal.tax_lines ?? [],
              /**
               * Named discounts, the twin of `tax_lines`. The portal was quoting a next
               * payment already NET of the discount while the plan lines above it summed
               * to the gross — so the two disagreed by the discount, with nothing on the
               * page saying a discount existed at all.
               */
              discount_lines: renewal.discount_lines ?? [],
              /** True when this figure is priced after a scheduled plan change. */
              after_scheduled_change: !!renewal.scheduled_change,
            }
          : null,
        // No figure because a scheduled change or pause comes first and cannot be priced:
        // the date is still known, the amount is not.
        next_payment_unpriced:
          !renewal && pending
            ? {
                type: pending.type,
                at:
                  pending.type === "pause"
                    ? pending.effective_at
                    : ((sub.currentPeriodEnd ?? sub.trialEnd)?.toISOString() ??
                      pending.effective_at),
              }
            : null,
        ...(renewal?.mandate_shortfall ? { mandate_shortfall: renewal.mandate_shortfall } : {}),
        /**
         * Null when the business does not offer skipping. `upcoming` is empty when this
         * subscription cannot skip (trial, paused, cancelling); `changeable` is false within
         * 48 hours of a renewal.
         */
        // Plan changes (Phase 2): whether the plan card offers "Change plan", and a change
        // already scheduled for the term end.
        plan_change: await (async () => {
          const scheduled = (await listScheduledChanges(ctx.organizationId, sub.id)).find(
            (c) => c.type === "change" && c.status === "scheduled",
          );
          return {
            allowed:
              storefront.allowPlanChanges &&
              !sub.cancelAtPeriodEnd &&
              storefront.changeStatuses.includes(sub.status),
            scheduled: scheduled
              ? {
                  id: scheduled.publicId,
                  effective_at: scheduled.effectiveAt,
                  can_cancel: storefront.allowCancelScheduledChange,
                }
              : null,
          };
        })(),
        actions: portalSubscriptionActions(
          storefront,
          sub,
          cancelReasons,
          sub.status === "paused" && (await pausedByOffer(ctx.organizationId, sub.id)),
        ),
        // A paused subscription and when it resumes (a scheduled resume), for the plan card.
        paused:
          sub.status === "paused"
            ? {
                resumes_at:
                  (await listScheduledChanges(ctx.organizationId, sub.id)).find(
                    (c) => c.type === "resume" && c.status === "scheduled",
                  )?.effectiveAt ?? null,
              }
            : null,
        skip_renewal: allowSkipRenewal
          ? {
              limit_per_year: skipRenewalLimit,
              upcoming: (await listUpcomingRenewals(ctx.organizationId, sub.id, now)).map((u) => ({
                renewal_at: u.renewalAt,
                skipped: u.skip != null,
                changeable: u.locked == null,
              })),
            }
          : null,
      });
    }
    return { object: "list", data };
  });

  /** Choose where one of the buyer's own subscriptions ships. `address_id: null` = the default. */
  app.post(
    "/portal/v1/subscriptions/:sub/shipping_address",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const { sub } = req.params as { sub: string };
      const parsed = parseRequest(portalShipToBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const [row] = await withTenant(ctx.organizationId, (tx) =>
        tx
          .select({ id: subscriptions.id, status: subscriptions.status })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.publicId, sub),
              eq(subscriptions.businessId, ctx.businessId),
              eq(subscriptions.customerId, ctx.customerId),
              notDeleted(),
            ),
          )
          .limit(1),
      );
      if (!row) return notFound(reply, `No such subscription: ${sub}`);
      if (row.status === "cancelled")
        return refuse(
          reply,
          409,
          "We could not change the shipping address. This subscription is cancelled.",
        );
      const { updateSubscriptionSettings } = await import("@/modules/subscriptions/service");
      let updated;
      try {
        updated = await updateSubscriptionSettings({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          subscriptionPublicId: sub,
          shippingAddressPublicId: parsed.data.address_id,
        });
      } catch (e) {
        if (e instanceof ShippingAddressError) return badRequest(reply, e.message);
        throw e;
      }
      if (!updated) return notFound(reply, `No such subscription: ${sub}`);
      return {
        object: "portal_subscription_shipping_address",
        id: updated.publicId,
        ...(await portalShipTo(ctx.organizationId, updated)),
      };
    },
  );

  /**
   * Usage so far on the buyer's own subscription. One 404 for every miss: another
   * customer's subscription, an unknown id, or a business that hides usage. The projection
   * follows `portal_show_usage_projection` only; no query parameter can turn it on.
   */
  app.get(
    "/portal/v1/subscriptions/:sub/usage",
    { preHandler: authenticatePortal },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const { sub } = req.params as { sub: string };
      const missing = () => notFound(reply, `No such subscription: ${sub}`);
      const biz = await getBusinessById(ctx.organizationId, ctx.businessId);
      const { portalShowUsage, portalShowUsageProjection } = resolveStorefrontConfig(biz);
      if (!portalShowUsage) return missing();
      const [row] = await withTenant(ctx.organizationId, (tx) =>
        tx
          .select({ id: subscriptions.id })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.publicId, sub),
              eq(subscriptions.businessId, ctx.businessId),
              eq(subscriptions.customerId, ctx.customerId),
              notDeleted(),
            ),
          )
          .limit(1),
      );
      if (!row) return missing();
      const view = await currentUsage({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        subscriptionId: row.id,
        includeProjection: portalShowUsageProjection,
        surface: "portal",
      });
      if (!view) return missing();
      return serializeCurrentUsage(view, { portal: true });
    },
  );

  /**
   * The buyer's usage by day over the window the next invoice bills, in the business's time
   * zone. Quantities only: never cost. Same gate and the same one 404 as `/usage`.
   */
  app.get(
    "/portal/v1/subscriptions/:sub/usage/daily",
    { preHandler: authenticatePortal },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const { sub } = req.params as { sub: string };
      const missing = () => notFound(reply, `No such subscription: ${sub}`);
      const biz = await getBusinessById(ctx.organizationId, ctx.businessId);
      if (!resolveStorefrontConfig(biz).portalShowUsage) return missing();
      const window = await withTenant(ctx.organizationId, async (tx) => {
        const [row] = await tx
          .select()
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.publicId, sub),
              eq(subscriptions.businessId, ctx.businessId),
              eq(subscriptions.customerId, ctx.customerId),
              notDeleted(),
            ),
          )
          .limit(1);
        return row ? await usageWindowForNextInvoice(tx, row) : null;
      });
      if (!window) return missing();
      const asOf = await businessWallClock(ctx.businessId);
      const end = new Date(Math.min(asOf.getTime(), window.end.getTime()));
      const from = new Date(
        Math.max(window.start.getTime(), end.getTime() - MAX_HISTORY_DAYS * 86_400_000),
      );
      const h = await customerUsageHistory({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        customerId: ctx.customerId,
        from,
        to: new Date(Math.max(end.getTime(), from.getTime() + 1)),
      });
      return serializeUsageHistory(h!, { cost: false });
    },
  );

  /**
   * The buyer applies a coupon to their OWN subscription — the portal half of 0238.
   *
   * Gated on `businesses.allow_customer_coupons`, off by default. The risk is worth
   * stating where it lives: a code is only as private as the coupon makes it. Anyone who
   * learns the string can apply it here, and the only limits are the ones ON the coupon —
   * `valid_from`, `redeem_by`, `max_redemptions` and its CAT-2 item constraints. A merchant
   * who needs a code confined to one customer wants a coupon SET (single-use codes), not
   * this flag switched off.
   *
   * Add only. Removing a discount is deliberately not offered: a buyer cannot tell a code
   * they typed from one the merchant granted, so an "X" beside the wrong one throws away
   * something we did not give them. Removal stays an operator action.
   *
   * Capped by `businesses.max_customer_coupon_codes` (0495, default 1). At 1, one discount
   * at a time, operator ones included; above 1, up to that many codes the customer entered.
   */
  app.post(
    "/portal/v1/subscriptions/:sub/coupon",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const biz = await getBusinessById(ctx.organizationId, ctx.businessId);
      if (!biz?.allowCustomerCoupons)
        return reply.code(403).send({
          error: {
            type: "invalid_request_error",
            message: "This account does not accept coupon codes",
          },
        });
      const parsed = parseRequest(z.object({ code: z.string().min(1).max(LIMITS.code) }), req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { sub } = req.params as { sub: string };

      /**
       * Scoped to the SESSION's customer, not just the business — the id comes off the URL,
       * so without `customerId` in the predicate one buyer could discount another's
       * subscription. `verify:bola` is what pins this shape.
       */
      const [row] = await withTenant(ctx.organizationId, (tx) =>
        tx
          .select({ id: subscriptions.id })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.publicId, sub),
              eq(subscriptions.businessId, ctx.businessId),
              eq(subscriptions.customerId, ctx.customerId),
              notDeleted(),
            ),
          )
          .limit(1),
      );
      if (!row) return notFound(reply, `No such subscription: ${sub}`);

      // Only the cancel flow's accepted offer applies the retention coupon.
      if (
        await isRetentionCouponCode({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          code: parsed.data.code,
        })
      )
        return reply.code(400).send({
          error: { type: "invalid_request_error", message: RETENTION_COUPON_REFUSAL },
        });

      // The buyer's cap (0495): at 1, no code while any discount is live, operator ones
      // included. Above 1 only the customer's own codes count. The list reports
      // `coupon_codes_left`, so the box hides rather than refuses.
      const cap = biz.maxCustomerCouponCodes;
      const now = await businessWallClock(ctx.businessId);
      try {
        await withTenant(ctx.organizationId, async (tx) => {
          // Row lock: two codes sent at once cannot both pass the count.
          await tx
            .select({ id: subscriptions.id })
            .from(subscriptions)
            .where(eq(subscriptions.id, row.id))
            .for("update");
          const live = await liveDiscountCounts(tx, row.id);
          if (portalCouponCodesLeft(cap, live) === 0)
            throw new CouponError(
              live.entered > 0
                ? customerCouponCapMessage(cap)
                : "A discount is already applied to this subscription",
            );
          await applyCouponToSubscription({
            organizationId: ctx.organizationId,
            businessId: ctx.businessId,
            subscriptionId: row.id,
            code: parsed.data.code,
            now,
            enteredByCustomer: true,
            tx,
          });
        });
      } catch (e) {
        // A mistyped, expired or exhausted code is the buyer's problem to see, beside the
        // field they typed it into — a 400, never a 500.
        if (e instanceof CouponError)
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        throw e;
      }

      /**
       * The re-estimated next payment, so the page can state the new figure instead of
       * saying "applied" and leaving the buyer to work out what changed. Null when there
       * will not be a next invoice, exactly as the subscription list reports it.
       */
      const renewal = await estimateRenewal({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        subscriptionId: row.id,
      });
      return {
        object: "discount",
        subscription: sub,
        coupon: parsed.data.code,
        next_payment: renewal
          ? {
              at: await nextChargeAt(ctx.organizationId, row.id),
              total_minor: renewal.total_minor,
              amount_due_minor: renewal.amount_due_minor ?? renewal.total_minor,
              currency: renewal.currency,
              tax_lines: renewal.tax_lines ?? [],
              discount_lines: renewal.discount_lines ?? [],
              /** True when this figure is priced after a scheduled plan change. */
              after_scheduled_change: !!renewal.scheduled_change,
            }
          : null,
      };
    },
  );

  /**
   * The buyer takes their coupon back off (0238).
   *
   * Removal used to be operator-only, on the grounds that a buyer cannot tell a code they
   * typed from one the merchant granted them. Two things answer that now: only a
   * COUPON-sourced discount can be lifted here — an operator's manual discount is not the
   * buyer's to touch — and the portal allows one discount at a time, so without a way to
   * take one off a buyer who typed the wrong code has no way back. The residual risk is
   * real and stated rather than designed away: a merchant-granted coupon CAN be removed
   * here, and the buyer needs the code to put it back. A merchant who cannot accept that
   * turns the coupon box off.
   *
   * Gated on the same `allow_customer_coupons` as the apply route, so one switch governs
   * the whole box rather than half of it.
   */
  app.delete(
    "/portal/v1/subscriptions/:sub/coupon",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const biz = await getBusinessById(ctx.organizationId, ctx.businessId);
      if (!biz?.allowCustomerCoupons)
        return reply.code(403).send({
          error: {
            type: "invalid_request_error",
            message: "This account does not accept coupon codes",
          },
        });
      const { sub } = req.params as { sub: string };

      // Scoped to the SESSION's customer, exactly as the apply route is — the id comes off
      // the URL, and without `customerId` one buyer could strip another's discount.
      const [row] = await withTenant(ctx.organizationId, (tx) =>
        tx
          .select({ id: subscriptions.id })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.publicId, sub),
              eq(subscriptions.businessId, ctx.businessId),
              eq(subscriptions.customerId, ctx.customerId),
              notDeleted(),
            ),
          )
          .limit(1),
      );
      if (!row) return notFound(reply, `No such subscription: ${sub}`);

      // `?code=` names the discount when the subscription has more than one (0495).
      const named = String((req.query as { code?: unknown }).code ?? "")
        .trim()
        .toLowerCase()
        .slice(0, LIMITS.code);
      const all = (await portalSubscriptionDiscounts(ctx.organizationId, row.id, 0)).discounts;
      const discount = named
        ? (all.find((d) => d.coupon?.toLowerCase() === named) ?? null)
        : (all.find((d) => d.removable) ?? all[0] ?? null);
      if (!discount)
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: "This subscription has no discount",
          },
        });
      if (!discount.removable || !discount.coupon)
        return reply.code(403).send({
          error: {
            type: "invalid_request_error",
            message: "We applied this discount for you. Contact us to change it.",
          },
        });

      // Named, not "remove everything": `removeDiscount` with no code strips the whole
      // stack, and an operator's manual discount could be sitting beside this one.
      const removed = await removeDiscount(ctx.organizationId, row.id, discount.coupon);
      if (removed === 0)
        return reply.code(409).send({
          error: {
            type: "invalid_request_error",
            message: "That discount is already removed",
          },
        });

      // The re-estimated next payment, for the same reason the apply route answers with
      // one: the figure moved, and the page must state the new one rather than the old.
      const renewal = await estimateRenewal({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        subscriptionId: row.id,
      });
      return reply.code(200).send({
        object: "discount",
        subscription: sub,
        coupon: discount.coupon,
        removed: true,
        next_payment: renewal
          ? {
              at: await nextChargeAt(ctx.organizationId, row.id),
              total_minor: renewal.total_minor,
              amount_due_minor: renewal.amount_due_minor ?? renewal.total_minor,
              currency: renewal.currency,
              tax_lines: renewal.tax_lines ?? [],
              discount_lines: renewal.discount_lines ?? [],
              /** True when this figure is priced after a scheduled plan change. */
              after_scheduled_change: !!renewal.scheduled_change,
            }
          : null,
      });
    },
  );

  /**
   * The buyer's invoices, NEWEST FIRST and BOUNDED.
   *
   * This used to call `listInvoices`, which takes no limit: it selected every invoice the
   * customer had ever had, then ran `paidTotals` and `pendingPaymentsForInvoices` across
   * all of them, and serialized the lot. Nothing was hidden from the buyer — but a
   * long-lived monthly account pays for its whole history on every portal open, and the
   * portal card grew without limit.
   *
   * `limit` is what the caller wants to SHOW, and grows as the buyer asks for more, rather
   * than `starting_after` + client-side accumulation. That is a deliberate departure from
   * the cursor policy for paginated lists, and it is bounded to one customer's own
   * invoices: a growing limit re-renders one server-rendered page with no client state and
   * no duplicated row markup, and the set is small enough that re-reading the first N rows
   * costs nothing. `has_more` is still reported the same way (a limit+1 probe), so a real
   * cursor can replace this without changing the shape the client reads.
   */
  app.get("/portal/v1/invoices", { preHandler: authenticatePortal }, async (req) => {
    const ctx = req.portalSession!;
    const q = req.query as { limit?: string };
    const requested = Number.parseInt(q.limit ?? "", 10);
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 1), PORTAL_INVOICE_MAX_LIMIT)
      : PORTAL_INVOICE_PAGE;
    // One past the page, so `has_more` is a fact rather than a guess from a full page.
    const biz = await getBusinessById(ctx.organizationId, ctx.businessId);
    const hide = resolveStorefrontConfig(biz);
    const probe = await listInvoices(ctx.organizationId, ctx.businessId, {
      customerId: ctx.customerId,
      limit: limit + 1,
      hideVoided: hide.portalHideVoidedInvoices,
      hideZeroTotal: hide.portalHideZeroInvoices,
    });
    const hasMore = probe.length > limit;
    const rows = hasMore ? probe.slice(0, limit) : probe;
    /**
     * `payment_in_flight` — an async debit (UPI, netbanking, a card mandate) is already
     * working on this invoice and will settle by webhook, possibly days later.
     *
     * The buyer needs this because NOTHING else on the invoice shows it: the status
     * stays `payment_due` and the full amount stays due while the money is in motion.
     * Without it the portal renders an enabled "Pay now", the engine refuses the click
     * (it will not charge over a pending attempt), and the buyer gets an error toast for
     * pressing a button we offered them — a control that cannot do what it says.
     *
     * `awaiting_authentication` splits that wait in two, because only one of them is
     * ours to wait out. An RBI/NPCI debit above ₹15,000 is paused for the payer's own
     * bank approval and will sit there until it expires; telling that buyer "Payment
     * processing…" asks them to wait for something that is waiting for them.
     */
    const inFlight = await pendingPaymentsForInvoices(
      ctx.organizationId,
      rows.map((r) => r.invoice.id),
    );
    return {
      object: "list",
      data: rows.map((r) => ({
        ...withCardLimit(
          biz,
          serializeInvoice(r.invoice, {
            biz,
            customer: r.customerPublicId,
            subscription: r.subscriptionPublicId,
            paidMinor: r.paidMinor,
          }),
        ),
        payment_in_flight: inFlight.has(r.invoice.id),
        awaiting_authentication: inFlight.get(r.invoice.id)?.awaitingAuthentication ?? false,
        // WHICH gateway holds the pending debit — the fact, not a verdict. Whether its
        // request can be cancelled differs per gateway (Stripe cancels from
        // `requires_action`, RazorPay declares `intentVoid: false`), and the portal
        // promises the buyer one or the other. Null = unknown; the UI takes the cautious
        // wording rather than guessing.
        in_flight_gateway: inFlight.get(r.invoice.id)?.gatewayKey ?? null,
      })),
      has_more: hasMore,
    };
  });

  /**
   * The customer's one-time purchases (E5): invoices a purchase checkout raised, with what
   * was bought and what has been refunded. The receipt is the invoice PDF route above.
   */
  app.get("/portal/v1/purchases", { preHandler: authenticatePortal }, async (req) => {
    const ctx = req.portalSession!;
    const q = req.query as { limit?: string };
    const requested = Number.parseInt(q.limit ?? "", 10);
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 1), PORTAL_INVOICE_MAX_LIMIT)
      : PORTAL_INVOICE_PAGE;
    const page = await listCustomerPurchases({
      organizationId: ctx.organizationId,
      businessId: ctx.businessId,
      customerId: ctx.customerId,
      limit,
    });
    return {
      object: "list",
      data: page.data.map((p) => ({
        object: "purchase",
        invoice: p.invoiceId,
        number: p.number,
        status: p.status,
        currency: p.currency,
        total_minor: p.totalMinor,
        refunded_minor: p.refundedMinor,
        created_at: p.createdAt.toISOString(),
        paid_at: p.paidAt?.toISOString() ?? null,
        items: p.items.map((i) => ({
          description: i.description,
          quantity: i.quantity,
          image_url: i.imageUrl,
        })),
      })),
      has_more: page.hasMore,
    };
  });

  app.get("/portal/v1/invoices/:inv", { preHandler: authenticatePortal }, async (req, reply) => {
    const ctx = req.portalSession!;
    const invId = (req.params as { inv: string }).inv;
    const found = await getInvoiceWithLines(ctx.organizationId, ctx.businessId, invId);
    // Ownership guard: the invoice must belong to THIS portal session's customer.
    if (!found || found.invoice.customerId !== ctx.customerId)
      return notFound(reply, `No such invoice: ${invId}`);
    const inFlight = await pendingPaymentsForInvoices(ctx.organizationId, [found.invoice.id]);
    const detailBiz = await getBusinessById(ctx.organizationId, ctx.businessId);
    return {
      ...withCardLimit(
        detailBiz,
        serializeInvoice(found.invoice, {
          biz: detailBiz,
          customer: found.customerPublicId,
          subscription: found.subscriptionPublicId,
          lines: found.lines,
          paidMinor: found.paidMinor,
        }),
      ),
      // What the return leg polls while a payment settles; same meaning as the list's.
      payment_in_flight: inFlight.has(found.invoice.id),
    };
  });

  /**
   * "Pay now" — the buyer settles one of their own open invoices.
   *
   * ON-SESSION, always, and that is the whole point of the endpoint rather than an
   * incidental detail. An off-session charge reuses the saved mandate, which in India
   * caps an unattended debit at ₹15,000 (RBI's AFA rule — see
   * `INR_AFA_FREE_CEILING_MINOR`): a Pay-now button built that way would refuse every
   * invoice larger than that, i.e. exactly the ones a buyer most wants to clear by
   * hand. On-session, the buyer is present to authenticate, so the cap does not apply
   * and any amount is payable. It is also the only self-service route out of a
   * `mandate_ceiling_exceeded` park that does not require re-registering the mandate.
   *
   * Two-legged, like the operator's collect: the first POST answers 200 with
   * `status: 'action_required'` and a `next_action` (3DS, RazorPay Checkout, a redirect);
   * the buyer completes it and the SAME request is re-posted carrying `payment_intent`,
   * which is consumed against this invoice.
   *
   * Paying by hand never costs the customer a scheduled dunning retry. Not because of
   * `manualAttempt` any more — this route no longer goes through `collectInvoice` at all
   * — but because the intent path only touches `attempt_count` on the branch where the
   * capture SUCCEEDS and the invoice becomes paid, at which point there are no retries
   * left to spend. A refused capture releases the claim and records the failure without
   * arming or advancing dunning.
   */
  const portalCollectBody = z.object({
    payment_intent: z.string().max(LIMITS.id).min(1).optional(),
    /** What the browser SDK returned for a `next_action.mode: 'sdk'` intent. With `payment_intent`. */
    client_result: clientResultField().optional(),
    return_url: redirectUrl().optional(),
    cancel_url: redirectUrl().optional(),
    /**
     * gwa_… — pay through this gateway (the buyer's pick), exactly as `portalSetupBody`
     * lets them choose where a card is vaulted. Optional: with one matching gateway there
     * is no choice to make and the router resolves it alone.
     *
     * It is also what makes two gateways on one currency workable. The router refuses to
     * guess between them (`ambiguous_gateway` — never a silent fallback) and one
     * business-wide default can only ever settle one currency; a buyer choosing "card" or
     * "PayPal" is not a tie to break, it is the answer.
     */
    gateway_account: z.string().max(LIMITS.id).min(1).optional(),
    /**
     * Pay with this wallet on the gateway's own hosted page (`apple_pay_hosted` on the gateway
     * list). The buyer leaves for that page and returns to `return_url`.
     */
    wallet: z.enum(["apple_pay"]).optional(),
  });
  /**
   * #28a — `GatewayRouterError`, `ProviderRefusalError` and `PaymentMethodConfigError`
   * all name what an OPERATOR must fix ("set a default gateway account", "Selected
   * payment gateway is not active", "Use methodTypes: [\"card\"]…") — words a buyer on
   * this route cannot act on and that name our own internal setup. Unlike
   * `PaymentIntentError` (whose messages on the consume path are deliberately written
   * for the payer — see its docblock in payment-intents/service.ts), these three carry
   * NO such promise: they are shared with the operator-only routes
   * (`payment-intent-routes.ts`, `payment-method-routes.ts`) where the raw text is
   * exactly what should be shown. So the substitution happens here, at the one route
   * a buyer reaches, not at the error's source. The true detail is not discarded — it
   * is logged, structured, right where the substitution happens.
   */
  const reportGatewayConfigErrorToBuyer = (
    reply: FastifyReply,
    e: GatewayRouterError | ProviderRefusalError | PaymentMethodConfigError,
    invId: string,
  ) => {
    log.error(e, {
      event: "portal_collect_gateway_config_error",
      invoice: invId,
      errorType: e.constructor.name,
      code: e instanceof GatewayRouterError ? e.code : undefined,
    });
    return badRequest(
      reply,
      "We cannot complete this payment now because of a problem with the payment configuration " +
        "of this business. We did not charge you. Try again in a few minutes. If the problem " +
        "continues, contact the business.",
    );
  };
  app.post(
    "/portal/v1/invoices/:inv/collect",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const invId = (req.params as { inv: string }).inv;
      const parsed = parseRequest(
        portalCollectBody,
        req.body && typeof req.body === "object" ? req.body : {},
      );
      if (!parsed.success) return badRequest(reply, parsed.error);

      // Ownership first, and phrased as "no such invoice" rather than "forbidden": a
      // portal token must not be able to probe which invoice ids exist on the business.
      const found = await getInvoiceWithLines(ctx.organizationId, ctx.businessId, invId);
      if (!found || found.invoice.customerId !== ctx.customerId)
        return notFound(reply, `No such invoice: ${invId}`);
      const biz = await getBusinessById(ctx.organizationId, ctx.businessId);
      // Portal permission (storefront_config, 2026-09-09). Default ON. AFTER the ownership
      // check on purpose: a 403 on an invoice the buyer does not own would confirm the id
      // exists, which is exactly what the 404 above is worded to avoid.
      //
      // This withdraws the buyer's "Pay now" only. The engine still charges on its own
      // schedule and dunning still runs — a merchant collecting strictly by mandate does
      // not want a second, manual path to the same money.
      if (!resolveStorefrontConfig(biz).allowInvoicePayment)
        return reply.code(403).send({
          error: {
            type: "invalid_request_error",
            message:
              "This account does not accept payments here. We will collect it automatically.",
          },
        });

      /**
       * Leg 2: book `intent` into this invoice through consume. Shared by the buyer's
       * re-post and by a resume that finds the gateway already holding the money.
       */
      const settleIntent = async (intent: PaymentIntent) => {
        const piId = intent.publicId;
        /**
         * The invoice as it stands, with a `payment_error` only when money is still
         * owed. Shared by the ordinary path and the lost-race path below, so the two
         * cannot describe the same invoice differently.
         */
        const reportInvoice = async (
          charge?: {
            status: string;
            failure?: { code?: string; message?: string } | null;
          },
          /**
           * The intent was already consumed INTO THIS INVOICE. That is settlement, stated
           * by the settlement itself, and it cannot lag the way a balance read can — which
           * is the whole reason this flag exists rather than another look at the money.
           */
          settledByIntent = false,
        ) => {
          const fresh = await getInvoiceWithLines(ctx.organizationId, ctx.businessId, invId);
          const inv = fresh?.invoice ?? found.invoice;
          const paidMinor = fresh?.paidMinor ?? found.paidMinor;
          const view = serializeInvoice(inv, { biz, paidMinor });
          /**
           * ⚠️ THE INVOICE'S OWN STATUS OUTRANKS A BALANCE WE MAY HAVE READ TOO EARLY.
           *
           * The no-charge arm used to decide purely from `amount_due_minor > 0`, and told a
           * customer their payment had not settled the invoice when it had — twice, on the
           * real book, both invoices `paid` with one succeeded payment (INV-7849/7850,
           * 3DS-confirmed India cards). The comment below is honest that this arm knows
           * only a balance; what it missed is that the balance can be behind the row.
           *
           * `paid` is not an amount, it is a verdict, and this route re-reads the invoice
           * precisely to get it. Settled means settled — report success and let the
           * arithmetic speak only for an invoice still open.
           */
          const settledNow = inv.status === "paid" || inv.writtenOff || inv.status === "voided";
          const failed = charge
            ? captureRefused(charge)
            : settledByIntent
              ? false
              : !settledNow && view.amount_due_minor > 0;
          return {
            ...view,
            ...(failed
              ? {
                  payment_error: {
                    code: charge?.failure?.code ?? "capture_failed",
                    /**
                     * Two different sentences, because we know two different amounts.
                     * WITH a charge we have the gateway's own reason. WITHOUT one — the
                     * lost-race path — all we know is the balance, and "payment could
                     * not be completed" would be a guess: on a part-paid invoice some
                     * of this money may well have arrived. Say what is certainly true.
                     */
                    message:
                      charge?.failure?.message ??
                      "This payment did not settle the invoice. An amount is still due.",
                  },
                }
              : {}),
          };
        };

        /**
         * ── LOSING THE RACE IS NOT A FAILURE ────────────────────────────────────
         *
         * Two settlers reach for the same intent, by design. The buyer's browser posts
         * this second leg, and `intent.authorized` reaches `harvestInvoiceIntent` in
         * the inbound webhook — which exists precisely because the browser sometimes
         * never comes back (measured 2026-08-14: a ₹20,000 Pay now authorized at
         * RazorPay, the buyer's tab lost, and the money left held at the gateway).
         *
         * The webhook side already handles losing gracefully — a
         * `PaymentIntentConflictError` answers `processed`, a `PaymentIntentError`
         * answers `ignored`. The BUYER's side did not: `consumePaymentIntent` throws
         * `Intent already consumed`, this route mapped `PaymentIntentError` to a 400,
         * and the person who had just paid was shown a red **"Intent already consumed"**
         * for money that had in fact been captured a moment earlier by the webhook.
         *
         * The identical race was found and fixed on the ADD-CARD side (see
         * `vault-setup.ts`: "Lost the claim to the webhook harvest … the instrument IS
         * recorded, which is the outcome this function exists to produce — resolve the
         * row the intent names instead of calling it a failure"). The money side never
         * got the same treatment. This is that treatment: report the OUTCOME the intent
         * produced, not the collision.
         *
         * Checked BEFORE the consume and caught AROUND it, because the race can land on
         * either side of our read — the same two-sided guard the vault path uses.
         */
        const settledElsewhere = async () => {
          // A consumed intent that settled a DIFFERENT invoice is a real error, not a
          // race: nothing here paid this one.
          if (intent.invoiceId && intent.invoiceId !== found.invoice.id) {
            return badRequest(
              reply,
              `Payment intent ${piId} is already used for a different invoice`,
            );
          }
          /**
           * Consumed, and NOT into another invoice — so it was consumed into this one and
           * this invoice is paid. Say so, rather than re-reading a balance that may not
           * have caught up: reproduced twice on the real book while our user recorded a
           * journey (INV-7849, INV-7850 — 3DS India cards, both `paid`/`success` with one
           * succeeded payment each), and both times the buyer was told their payment had
           * not settled the invoice.
           */
          return reportInvoice(undefined, true);
        };
        if (intent.status === "consumed") return settledElsewhere();

        let consumed;
        try {
          consumed = await consumePaymentIntent(
            ctx.organizationId,
            ctx.businessId,
            piId,
            invId,
            parsed.data.client_result ? { clientResult: parsed.data.client_result } : undefined,
          );
        } catch (e) {
          // Only the collision itself. Every other refusal (voided, expired, amount
          // mismatch) is a genuine 400 and still falls through to the outer catch.
          if (e instanceof PaymentIntentConflictError) return settledElsewhere();
          if (e instanceof PaymentIntentError && /already consumed/i.test(e.message))
            return settledElsewhere();
          throw e;
        }
        if (!consumed) return notFound(reply, `No such payment intent: ${piId}`);
        return reportInvoice(consumed.charge ?? undefined);
      };

      try {
        if (parsed.data.payment_intent) {
          const piId = parsed.data.payment_intent;
          const intent = await getPaymentIntent(ctx.organizationId, ctx.businessId, piId);
          if (!intent) return notFound(reply, `No such payment intent: ${piId}`);
          // An intent authorized by another buyer must never settle this invoice —
          // the same guard the operator route makes, which matters more here because
          // the caller is the buyer.
          if (intent.customerId && intent.customerId !== ctx.customerId) {
            return badRequest(reply, `Payment intent ${piId} belongs to a different customer`);
          }
          return await settleIntent(intent);
        }

        /**
         * What is still COLLECTIBLE — never `total_minor`.
         *
         * `total_minor` is the GROSS taxed claim; the collectible is `amount_due_minor`,
         * already net of the promotional slice, the refundable/excess credit applied at
         * generation, and any TDS withheld. Measured 2026-08-28 on a ₹10,000 invoice
         * carrying ₹2,000 of promotional credit: the portal displayed ₹8,000 due and this
         * route minted an intent for ₹10,000 — which `consumePaymentIntent` then REFUSED
         * (`Intent amount 1000000 does not match invoice amount due 800000`). So the
         * buyer completed their bank's challenge and only then hit an error, for an
         * amount no leg of the flow agreed on.
         *
         * The identical lesson is already written down inside `consumePaymentIntent` for
         * the part-paid case — "reading it raw demands the full original amount … not
         * merely wrong but impossible: no amount satisfied both". It was fixed there and
         * never here, so the two legs disagreed for any invoice carrying credit.
         */
        const due = await withTenant(ctx.organizationId, (tx) =>
          invoiceOutstanding(tx, found.invoice),
        ).then((o) => o.remainingMinor);

        /**
         * READ THE LIVE INTENT BEFORE ANY REFUSAL, because one of the refusals depends on
         * it. The lookup used to sit below the `due <= 0n` line, and that ordering was the
         * buyer-facing half of #16: once a credit note zeroed INV-7824 the route answered
         * "This invoice has nothing left to pay" — to the person whose ₹22,184.00 was at
         * that moment held at RazorPay on that exact invoice, 47 seconds after they
         * pressed Pay now. Nothing about the read depends on `due`, so hoisting it costs
         * one query on a path that already does several and changes no other branch.
         *
         * Wall clock, not `businessWallClock`: `expires_at` is STAMPED from the wall clock
         * at create time, so a time-travelled business must be compared against the same
         * clock that wrote it — and it is what `collectInvoice` passes.
         */
        const openIntent = await liveIntentForInvoice(
          ctx.organizationId,
          found.invoice.id,
          new Date(),
        );
        const intentIsLive =
          openIntent != null &&
          (openIntent.status === "in_progress" || openIntent.status === "authorized");

        if (due <= 0n) {
          /**
           * ── NOTHING LEFT TO PAY, AND THEIR MONEY IS STILL MOVING ────────────────
           *
           * The refusal is right — there is nothing to collect and a second checkout
           * would be a second real gateway order — but the flat sentence was not. This
           * buyer did nothing wrong: they pressed Pay now, and an operator's downgrade
           * credited the invoice out from under them while the gateway had their money
           * (measured 2026-09-03, INV-7824, 47 seconds between the two).
           *
           * What it may and may not claim. It says the payment is still with the bank and
           * that it comes back automatically, because that is the MECHANISM and it is
           * real: a capture with no invoice left to pay is booked, detached and handed to
           * `refundUnappliedExcess` — on INV-7824 the refund was issued three seconds
           * after the capture. It does NOT say "we have refunded you", because at the
           * moment this sentence is written no refund exists and the capture may never
           * arrive at all; and if the auto-refund itself fails, the money stays as their
           * customer credit with an alert (`unapplied_gateway_money`) rather than in
           * their account. "Comes back on its own" is true of both endings; "refunded" is
           * true of neither yet.
           */
          if (intentIsLive)
            return badRequest(
              reply,
              "This invoice is already settled, so there is nothing left to pay. But the payment " +
                "that you started is still with your bank. If it goes through, it is returned to " +
                "you automatically. You do not need to do anything. Do not pay again.",
            );
          return badRequest(reply, "This invoice has nothing left to pay");
        }

        /**
         * Someone is already paying this invoice — do not open a second checkout.
         *
         * `collectInvoice` has always refused to charge over a pending attempt, but this
         * route creates its own intent and so bypassed that guard. Measured 2026-08-14:
         * a netbanking mandate debit sat `pending` on INV-2142 (async rails settle by
         * webhook, up to two working days later) and Pay-now returned a fresh
         * `action_required` checkout for the same money. A buyer who completed it would
         * have been charged twice — once by the dunning debit when it settled, once by
         * their own payment — and the invoice over-paid.
         *
         * Refused rather than silently returning the in-flight payment the way
         * `collectInvoice` does: a person just pressed a button and is owed an
         * explanation, not a no-op that looks like nothing happened.
         */
        const inFlight = await pendingPaymentForInvoice(ctx.organizationId, found.invoice.id);
        if (inFlight) {
          return badRequest(
            reply,
            "A payment for this invoice is already being processed. Bank transfers and UPI can take " +
              "some time to confirm. We will send you an email when it completes. Do not pay twice.",
          );
        }

        /**
         * ── THE SAME GUARD, FOR A BUYER WHO IS ALREADY MID-CHECKOUT ─────────────
         *
         * The check above can only see a `payments` row. An intent-only checkout has NO
         * payments row until the intent is consumed, so a second click looked at a
         * perfectly clean invoice and minted a SECOND intent — which is a second real
         * order at the gateway, on money the buyer is already paying.
         *
         * Measured on INV-5510 (INR 32,943.24), and the buyer WAS charged twice:
         *   16:14:18  intent 1 → order 1 → payment 1 — later captured, invoice paid.
         *   16:17:30  intent 2 → a BRAND-NEW order 2 → payment 2 — real money, still
         *             sitting `authorized` at RazorPay, with zero payments/transactions rows on our side.
         * At 16:17:30 the first intent was still `in_progress` and inside its expiry
         * window — it was not consumed until 16:17:46, sixteen seconds later. So the
         * information needed to refuse was in our own database the whole time:
         * `collectInvoice` has consulted `liveIntentForInvoice` for exactly this since
         * INV-2143 (2026-08-14), and this route, which mints its own intent, never asked.
         *
         * RESUME rather than refuse where we can. The buyer is trying to pay, and the
         * intent they already opened carries the gateway's own checkout descriptor in
         * `next_action` (persisted at create time — for RazorPay that is the order id and
         * key id). Handing it back re-opens the sheet they already have instead of
         * cutting them a second order, and the second leg then consumes ONE intent.
         * Serialized exactly as the mint path below serializes its own, so no client
         * needs to know which of the two answered.
         *
         * Scoped to `in_progress`/`authorized` deliberately. A live intent can also sit
         * `inited`, which is where a REFUSED authorization lands (`attemptOutcomeOf`: the
         * intent stays open, its ATTEMPT is marked failed). Nothing is held at the gateway
         * there and there is no sheet to re-open, so counting it as in-flight — as
         * `collectInvoice`'s blunter version of this guard does — would lock a buyer whose
         * card was declined out of their own invoice for the intent's full hour of TTL,
         * punishing them for the gateway's no.
         *
         * No extra ownership check is needed or wanted: the intent is looked up BY the
         * invoice, and this invoice has already been proven to be `ctx.customerId`'s
         * above. Demanding `intent.customerId === ctx.customerId` on top would make an
         * operator-minted intent (which may carry no customer) fall through and mint the
         * second order this guard exists to prevent.
         */
        // Read above, before the zero-due refusal, which needs the same answer — see
        // the note there. `intentIsLive` is that read's `in_progress`/`authorized` test.
        if (openIntent && intentIsLive) {
          /**
           * The amounts must AGREE before we resume. A credit note, a part payment or a
           * TDS deduction landing between the two clicks moves the collectible, and
           * `consumePaymentIntent` refuses an intent whose amount is not exactly the
           * outstanding — so resuming a stale one would walk the buyer through their
           * bank's challenge only to fail at the end, the identical dead end the
           * `amount_due_minor` note above was written for. Both amounts are bigint minor
           * units; `due` is reused rather than re-derived so the two legs cannot disagree.
           */
          if (openIntent.amountMinor == null || openIntent.amountMinor !== due) {
            return badRequest(
              reply,
              "A payment for this invoice is already in progress, and the amount due has changed " +
                "since it started. Close the payment window that you opened. Then reload this page " +
                "to pay the new amount. Do not pay twice.",
            );
          }
          /**
           * Ask the gateway before replaying the stored action. An intent it already
           * authorized or captured cannot be confirmed again, so its form never loads:
           * book it through leg 2 instead. A cancelled one is voided and a new one minted.
           */
          const verdict = await resumeVerdictFromGateway(
            ctx.organizationId,
            ctx.businessId,
            openIntent,
          );
          if (verdict === "settle") return await settleIntent(openIntent);
          // The buyer switched between Apple Pay on the gateway's page and its own form. Close
          // the open one and mint the one asked for; money that still lands books as late money.
          const switched =
            verdict === "open" &&
            (await hostedWalletMismatch(
              ctx.organizationId,
              ctx.businessId,
              openIntent,
              !!parsed.data.wallet,
            ));
          if (switched)
            await voidPaymentIntent(ctx.organizationId, ctx.businessId, openIntent.publicId);
          if (verdict === "open" && !switched) {
            const openView = serializePaymentIntent(openIntent);
            /**
             * Replayable only while the stored `next_action` is still there. It is, for a
             * checkout that is still in progress. It deliberately is NOT once the intent
             * reaches `authorized`: the authorize writer clears the column because the money
             * is then HELD at the gateway and there is nothing left for the buyer to do —
             * the second leg or the webhook harvest settles it. Refuse, rather than answer
             * `action_required` with a null action the client cannot act on, and above all
             * rather than mint a second order over a live hold: that is precisely the
             * 16:17:30 charge above.
             */
            if (!openView.next_action) {
              return badRequest(
                reply,
                "A payment for this invoice is already with your bank and is not complete yet. We " +
                  "will send you an email when it settles. Do not pay twice.",
              );
            }
            return reply.code(200).send({
              object: "invoice_collection",
              invoice: invId,
              status: "action_required",
              payment_intent: openView,
              next_action: openView.next_action,
            });
          }
        }

        /**
         * The customer's DEFAULT instrument, not simply the newest one.
         *
         * `listPaymentMethods` orders `created_at DESC` and this took the first `valid`
         * row, so Pay now silently followed whatever was added last. The portal's own
         * "Set default" writes `role: 'primary'` (`setDefaultPaymentMethod`), so adding a
         * UPI mandate after a card made Pay now stop offering the card the buyer had
         * explicitly chosen — on the same screen that offered them the choice.
         *
         * It matters more than it used to: the rail decides the checkout. Pay now no
         * longer debits the mandate, so `methodTypes: [usable.type]` below turns "the
         * newest instrument" into "the only way you may pay", and a UPI-rail pick hands a
         * card-holding buyer a UPI-only modal.
         *
         * Same rule `resolveChargeCandidates` uses for automatic collection — primary
         * role, else the latest — so the button and the clock agree about which
         * instrument is the customer's. Filtered to `valid` first, which collection does
         * not need to do and a buyer-facing checkout does: an invalid primary must fall
         * through to something payable rather than open a checkout on a dead card.
         */
        // NOT passed to the intent, and deliberately: `letBuyerChooseMethod` withholds
        // the saved instrument from the adapter, so naming one only decided which gateway
        // account to route to — and refused the buyer when their card sat on an account
        // that does not handle the invoice's currency (production, 2026-09-06). The buyer
        // types a fresh card into the gateway's sheet either way, so route on the CURRENCY
        // and let a customer with no saved card pay at all.
        //
        // Renewals are untouched: an off-session debit charges the stored token, and only
        // the gateway holding it can — see `resolveAccountForPm`.
        // Card limit (0482): the gateway's sheet offers cards, so above it there is no
        // checkout to open. A live intent above resumes; only a NEW checkout is refused.
        if (overCardLimit(biz, found.invoice.currency, due))
          return reply.code(400).send({
            error: {
              type: "invalid_request_error",
              code: CARD_LIMIT_CODE,
              message: CARD_LIMIT_MESSAGE,
            },
          });

        const payCustomer = await getPortalCustomer(ctx);
        if (!payCustomer) return notFound(reply, "Portal session target no longer exists");

        /**
         * ── Pay now ALWAYS opens a real-time checkout. It never debits the mandate. ──
         *
         * There used to be a UPI exception here: a saved UPI mandate that could carry the
         * amount was debited directly, because RazorPay's UPI checkout on an account with
         * only `upi: { intent: true }` renders a QR that nothing in TEST MODE can scan,
         * and the mandate was measured collecting ₹66,025 in under two seconds. That
         * optimised the test environment at the buyer's expense: a QR is a perfectly
         * ordinary real-time UPI flow for a person holding a phone.
         *
         * And above ₹15,000 it actively defeated the button. `mandateRefusal` gates on the
         * mandate's CEILING only, so a ₹50,000 invoice on a ₹1,00,000 UPI mandate sailed
         * through it — while `debitNeedsBuyerAuthentication` counts `upi` among the rails
         * needing per-debit AFA over ₹15,000. The debit was therefore booked `in_progress`,
         * `payment_authentication_required` fired, and the buyer's own invoice row flipped
         * to "Waiting for your bank" with Pay now blocked behind the in-flight guard.
         * Someone pressed Pay now and was put into the exact limbo Pay now exists to
         * escape — the limbo the portal's "I won't approve this" had to be built to break.
         *
         * A mandate debit is asynchronous by construction on every rail RazorPay has: it
         * settles by webhook, so the best case is still "Payment processing…" rather than
         * the confirmation someone pressing Pay now is asking for. On-session is the whole
         * point of this endpoint, not an implementation detail of it.
         */
        /**
         * A FRESH authorization, deliberately — NOT `collectInvoiceNow`.
         *
         * Measured 2026-08-14, which is why this is spelled out: routing Pay-now
         * through `collectInvoiceNow({ session: 'on_session' })` charges the SAVED
         * MANDATE, so a ₹66,025 invoice on a ₹41,610 mandate was refused by our own
         * ceiling pre-flight and simply parked — the button did nothing for exactly
         * the invoices it exists to clear. `session: 'on_session'` only governs how a
         * `requires_action` is reported; it does not escape the mandate.
         *
         * A `payment` intent authorizes the amount with the buyer PRESENT, so the
         * mandate (and its RBI ₹15,000 unattended cap) is not involved at all. The
         * buyer completes the challenge and the second leg consumes it against this
         * invoice.
         *
         * The saved instrument is named because `createPaymentIntent({ purpose:
         * 'payment' })` requires one — but naming it does NOT re-introduce the mandate:
         * an intent authorizes through the gateway's own checkout, not through
         * `/payments/create/recurring`, and `mandateRefusal` guards the collection path
         * rather than this one.
         *
         * ⚠️ A customer with NO saved instrument therefore cannot use Pay now yet. The
         * engine has no "charge a brand-new card against this invoice" intent — see the
         * `purpose === 'payment'` guard in payment-intents/service.ts. Tracked below.
         *
         * That limitation is now MORE artificial than it was, and worth restating: since
         * `letBuyerChooseMethod` withholds the instrument from the adapter, the saved
         * method no longer decides anything the buyer sees — it only routes to a gateway
         * account and gets recorded on the intent. The buyer would be typing their card
         * into the sheet either way. Lifting it means making the payment method optional
         * for a `payment` intent and routing through `selectGatewayAccount` the way a
         * setup intent already does; not done here, because it also touches the intent
         * row and the consume path.
         */
        const { intent } = await createPaymentIntent({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          purpose: "payment",
          // Names this in the gateway's own dashboard and on the payer's receipt. NOT
          // "PayNow": `paynow` is a Stripe payment METHOD (Singapore), and a row reading
          // that against a card debit would name a rail nobody used. See `ChargeFlow`.
          flow: "portal_payment",
          /**
           * ── The buyer picks the method, in the gateway's own sheet ────────────────
           *
           * This used to pin `methodTypes: [usable.type]` — the rail of whichever
           * instrument we had resolved. That was one rail, chosen for them, and it made
           * the resolved instrument decide not just what pays but what may be OFFERED: a
           * customer holding a card and a UPI mandate got whichever their default
           * happened to be, with no way to use the other.
           *
           * Pinning was never the goal, it was a workaround. The note it replaces —
           * "without this RazorPay defaults to card for everyone… all three rails
           * answered method=card" (2026-08-14) — was diagnosing a different bug: the
           * adapter falls back to `[paymentMethod.display.type]` when no rail is
           * requested, and `display.type` is HARDCODED to `'card'` in
           * payment-intents/service.ts. So the fallback said "card" whatever the
           * instrument was, and pinning the rail hid it. `letBuyerChooseMethod` withholds
           * `paymentMethod` too, so the broken fallback is never consulted.
           *
           * ⚠️ The hardcode itself is still there and still wrong for any other caller
           * that relies on the fallback. Tracked in PROGRESS.
           */
          letBuyerChooseMethod: true,
          // Required now that no payment method is passed: it is what the intent routes
          // and charges against. The session's own customer is the backstop, since a
          // portal invoice always belongs to the buyer holding the session.
          customerPublicId: found.customerPublicId ?? payCustomer.publicId,
          // The buyer's pick PINS the account. `resolvePinnedAccount` still makes it
          // prove it handles this currency and is active, so a stale pick fails by name
          // rather than quietly charging somewhere else.
          ...(parsed.data.gateway_account ? { gatewayAccountId: parsed.data.gateway_account } : {}),
          amountMinor: Number(due),
          currency: found.invoice.currency,
          invoicePublicId: invId,
          session: "on_session",
          ...(parsed.data.return_url ? { returnUrl: parsed.data.return_url } : {}),
          ...(parsed.data.cancel_url ? { cancelUrl: parsed.data.cancel_url } : {}),
          ...(parsed.data.wallet ? { hostedWallet: parsed.data.wallet } : {}),
        });
        const view = serializePaymentIntent(intent);
        // Already authorized without a challenge (a gateway that needed none): consume
        // it straight away rather than handing the client a no-op action.
        if (!view.next_action) {
          const consumed = await consumePaymentIntent(
            ctx.organizationId,
            ctx.businessId,
            intent.publicId,
            invId,
          );
          const fresh = await getInvoiceWithLines(ctx.organizationId, ctx.businessId, invId);
          return {
            ...serializeInvoice(fresh?.invoice ?? found.invoice, {
              biz,
              paidMinor: fresh?.paidMinor ?? found.paidMinor,
            }),
            ...(captureRefused(consumed?.charge)
              ? {
                  payment_error: {
                    code: consumed.charge.failure?.code ?? "capture_failed",
                    message:
                      consumed.charge.failure?.message ?? "We could not complete the payment",
                  },
                }
              : {}),
          };
        }
        return reply.code(200).send({
          object: "invoice_collection",
          invoice: invId,
          status: "action_required",
          payment_intent: view,
          next_action: view.next_action,
        });
      } catch (e) {
        // Not an error the buyer can act on by retrying — they finish the challenge and
        // the client re-posts with `payment_intent`. 200, because the invoice is
        // untouched and the collection is simply not finished yet.
        if (e instanceof PaymentActionRequiredError) {
          const view = serializePaymentIntent(e.intent);
          return reply.code(200).send({
            object: "invoice_collection",
            invoice: invId,
            status: "action_required",
            payment_intent: view,
            next_action: view.next_action,
          });
        }
        if (e instanceof PaymentIntentConflictError) {
          return reply.code(409).send({
            error: {
              type: "conflict_error",
              code: "payment_intent_conflict",
              message: e.message,
            },
          });
        }
        if (e instanceof PaymentIntentError) return badRequest(reply, e.message);
        // A routing refusal — no gateway account on this business can take this
        // currency/method pair. Measured 2026-08-14: a USD invoice against an INR-only
        // RazorPay account surfaced to the buyer as a bare "Internal server error",
        // because this route caught every OTHER expected failure but not this one. The
        // operator's intent route has always caught it; the portal must too, or the one
        // person who cannot do anything about it gets the least useful message.
        //
        // #28a: caught, but no longer forwarded verbatim — see
        // `reportGatewayConfigErrorToBuyer` above for why these three name what an
        // OPERATOR must fix, not the buyer.
        if (e instanceof GatewayRouterError)
          return reportGatewayConfigErrorToBuyer(reply, e, invId);
        // The adapter refused the combination outright — its sentence names the fix,
        // but the fix is ours to make, not the buyer's.
        if (e instanceof ProviderRefusalError)
          return reportGatewayConfigErrorToBuyer(reply, e, invId);
        if (e instanceof PaymentMethodConfigError)
          return reportGatewayConfigErrorToBuyer(reply, e, invId);
        /**
         * #42 — the buyer's half of the indeterminate case. Not a config error and not
         * substituted for one: the three above name what an OPERATOR must fix, while
         * this one says a fact could not be established and the right move is to try
         * again — which is something the buyer CAN act on. 502 `retriable: true`, in
         * words that describe our knowledge and make no claim about their money.
         *
         * The adapter's own sentence is logged, not shown: it names gateway resources
         * (an authorization id, an order status) that mean nothing to a payer.
         */
        if (e instanceof ProviderIndeterminateError) {
          log.error(e, {
            event: "portal_collect_gateway_indeterminate",
            invoice: invId,
            errorType: e.constructor.name,
          });
          return badGateway(
            reply,
            "We could not confirm the result of this payment with the payment provider. We do " +
              "not know yet if it went through. Wait a few minutes, then check this invoice " +
              "before you try again. If it still shows as unpaid, contact the business.",
          );
        }
        // "Cannot collect a paid invoice", "collection already in flight" — the buyer's
        // own words back to them, not a 500.
        if (e instanceof InvoiceOpsError || e instanceof CollectionInFlightError)
          return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  /**
   * "I won't authorise this — let me pay another way."
   *
   * The buyer releases the authentication-pending debit that is blocking their own
   * invoice, so Pay now works immediately instead of after the bank's link has run its
   * full 72 hours. Only the buyer can make this call, because only the buyer knows the
   * answer: the gateway has no idea whether they intend to approve it.
   *
   * The service asks the gateway before it believes them (see
   * `abandonAuthenticationPendingDebit`) — a debit that has actually landed is settled
   * as paid and reported back as such, never overruled. So every outcome below is a
   * real state, not an acknowledgement.
   *
   * Idempotency-keyed like every other portal write: a double-tap must not turn one
   * abandonment into two gateway polls and two settlement attempts.
   */
  app.post(
    "/portal/v1/invoices/:inv/abandon_authentication",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const invId = (req.params as { inv: string }).inv;
      const found = await getInvoiceWithLines(ctx.organizationId, ctx.businessId, invId);
      // Same ownership guard as every other invoice route on this surface.
      if (!found || found.invoice.customerId !== ctx.customerId)
        return notFound(reply, `No such invoice: ${invId}`);
      const res = await abandonAuthenticationPendingDebit({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        invoiceId: found.invoice.id,
        now: await businessWallClock(ctx.businessId),
        // This surface IS the buyer saying "I won't approve this", so the text booked may
        // say so. Every other caller must not.
        endedBy: "customer",
      });
      // 400 for the two "you are asking the wrong question" cases: there is nothing in
      // flight, or what IS in flight is not waiting on the buyer at all (a netbanking
      // presentation lands on its own, and letting it be abandoned would invite the
      // double payment the guard exists to prevent).
      if (res.outcome === "none_pending") {
        return badRequest(reply, "There is no payment in progress on this invoice");
      }
      if (res.outcome === "not_authentication") {
        return badRequest(
          reply,
          "Your bank is processing this payment. It does not need your approval. It will complete on its own",
        );
      }
      // 503, not 400: nothing is wrong with the request, we simply could not reach the
      // gateway to confirm the debit — and confirming it is not optional.
      if (res.outcome === "unsupported") {
        return reply.code(503).send({
          error: {
            type: "api_error",
            code: "gateway_unreachable",
            message:
              "We could not confirm the status of this payment with the provider. Try again in a few minutes.",
          },
        });
      }
      return {
        object: "invoice_authentication_abandoned",
        invoice: invId,
        // `settled` is the happy surprise: they were about to give up on a payment that
        // had in fact already gone through, and must be told that rather than shown a
        // Pay-now button for money they have paid.
        outcome: res.outcome,
        ...(res.outcome === "failed_at_gateway" && res.code ? { failure_code: res.code } : {}),
        /**
         * Did the gateway actually cancel the debit? It decides whether the buyer is
         * warned that the original could still capture — true where we could not cancel
         * (RazorPay always; Stripe inside the 26-hour India window) and a LIE where we
         * could. Only ever the observed result, so the portal can stop frightening the
         * buyers whose intent is genuinely dead.
         */
        ...(res.outcome === "released" ? { voided_at_gateway: res.voidedAtGateway } : {}),
      };
    },
  );

  app.get(
    "/portal/v1/invoices/:inv/pdf",
    { preHandler: authenticatePortal },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const invId = (req.params as { inv: string }).inv;
      // Confirm ownership before assembling anything (assembleInvoiceDocument is
      // business-scoped, not customer-scoped).
      const found = await getInvoiceWithLines(ctx.organizationId, ctx.businessId, invId);
      if (!found || found.invoice.customerId !== ctx.customerId)
        return notFound(reply, `No such invoice: ${invId}`);
      // Portal permission (storefront_config, 2026-09-09). Default ON. Placed after the
      // ownership check for the same reason as the collect route, and BEFORE the render:
      // `assembleInvoiceDocument` + `renderInvoicePdf` are the expensive part, and there is
      // no reason to build a document we are about to refuse to hand over.
      {
        const biz = await getBusinessById(ctx.organizationId, ctx.businessId);
        if (!resolveStorefrontConfig(biz).allowInvoiceDownload)
          return reply.code(403).send({
            error: {
              type: "invalid_request_error",
              message: "This account does not offer invoice downloads here. Contact us for a copy.",
            },
          });
      }
      const doc = await assembleInvoiceDocument(ctx.organizationId, ctx.businessId, invId);
      if (!doc) return notFound(reply, `No such invoice: ${invId}`);
      const buffer = await renderInvoicePdf(doc);
      const filename = `invoice-${(doc.meta.number || invId).replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
      return reply
        .header("content-type", "application/pdf")
        .header("content-disposition", `attachment; filename="${filename}"`)
        .send(buffer);
    },
  );
  // ── Receipts and payment requests (0387, 0388) ──────────────────────────────

  /** The customer's numbered receipts, newest first. */
  app.get("/portal/v1/receipts", { preHandler: authenticatePortal }, async (req, reply) => {
    const ctx = req.portalSession!;
    const q = req.query as { limit?: string; starting_after?: string };
    const n = Number.parseInt(q.limit ?? "", 10);
    const { listReceiptsPage, serializeReceiptRow } = await import("@/modules/receipts/service");
    const { getCustomerById } = await import("@/modules/customers/service");
    const customer = await getCustomerById(ctx.organizationId, ctx.customerId);
    if (!customer) return notFound(reply, "No such customer");
    const page = await listReceiptsPage(ctx.organizationId, ctx.businessId, {
      customerPublicId: customer.publicId,
      limit: Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 25,
      startingAfter: q.starting_after,
    });
    return {
      object: "list",
      // Only numbered receipts: an unnumbered one is seconds old and not a document yet.
      data: page.data.filter((r) => r.receipt.number).map(serializeReceiptRow),
      has_more: page.hasMore,
      next_cursor: page.nextCursor,
    };
  });

  app.get(
    "/portal/v1/receipts/:rcpt/pdf",
    { preHandler: authenticatePortal },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const { rcpt } = req.params as { rcpt: string };
      const { getReceipt } = await import("@/modules/receipts/service");
      // Ownership in the query: another customer's receipt reads as "no such receipt".
      const row = await getReceipt(ctx.organizationId, ctx.businessId, rcpt, {
        customerId: ctx.customerId,
      });
      if (!row || !row.receipt.number) return notFound(reply, `No such receipt: ${rcpt}`);
      const { renderReceiptPdf } = await import("@/modules/receipts/pdf");
      const buffer = await renderReceiptPdf(row.receipt);
      const name = row.receipt.number.replace(/[^A-Za-z0-9._-]/g, "_");
      return reply
        .header("content-type", "application/pdf")
        .header("content-disposition", `attachment; filename="receipt-${name}.pdf"`)
        .send(buffer);
    },
  );

  /** The customer's open payment requests (what a request email links to). */
  app.get("/portal/v1/requests", { preHandler: authenticatePortal }, async (req) => {
    const ctx = req.portalSession!;
    const { listPaymentRequestsPage, serializePaymentRequest } =
      await import("@/modules/payment-requests/service");
    const page = await listPaymentRequestsPage(ctx.organizationId, ctx.businessId, {
      customerId: ctx.customerId,
      status: "open,processing",
      // The clock's combined retries are not requests the customer was sent.
      excludeOrigin: "dunning",
      limit: 20,
    });
    return { object: "list", data: page.data.map(serializePaymentRequest), has_more: page.hasMore };
  });

  app.get("/portal/v1/requests/:preq", { preHandler: authenticatePortal }, async (req, reply) => {
    const ctx = req.portalSession!;
    const { preq } = req.params as { preq: string };
    const { getPaymentRequest, serializePaymentRequest } =
      await import("@/modules/payment-requests/service");
    const view = await getPaymentRequest(ctx.organizationId, ctx.businessId, preq, {
      customerId: ctx.customerId,
    });
    if (!view) return notFound(reply, `No such payment request: ${preq}`);
    return serializePaymentRequest(view);
  });

  /**
   * Pay a request with a saved payment method, as the customer (`initiator: customer`).
   * Paying with a new card goes through each invoice's own Pay now.
   */
  app.post(
    "/portal/v1/requests/:preq/pay",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const { preq } = req.params as { preq: string };
      const parsed = parseRequest(
        z.object({ payment_method: z.string().min(1).max(64).optional() }),
        req.body && typeof req.body === "object" ? req.body : {},
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { chargePaymentRequest, PaymentRequestError, serializePaymentRequest } =
        await import("@/modules/payment-requests/service");
      try {
        const view = await chargePaymentRequest({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          paymentRequestPublicId: preq,
          paymentMethodPublicId: parsed.data.payment_method,
          initiator: "customer",
          customerId: ctx.customerId,
        });
        return serializePaymentRequest(view);
      } catch (e) {
        if (e instanceof PaymentRequestError)
          return e.code === "not_found"
            ? notFound(reply, `No such payment request: ${preq}`)
            : badRequest(reply, e.message);
        if (e instanceof CollectionInFlightError)
          return conflict(
            reply,
            "We could not take the payment. A payment on one of these invoices is in progress. Try again when it completes.",
          );
        throw e;
      }
    },
  );

  /**
   * Pay several open invoices in one charge with a saved payment method (2.51 / 2.66,
   * `customer_chooses`). No `invoices` = every open invoice of `currency` (Pay all).
   */
  app.post(
    "/portal/v1/pay_invoices",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const parsed = parseRequest(
        z
          .object({
            invoices: z.array(z.string().min(1).max(64)).min(1).max(50).optional(),
            currency: z.string().length(3).optional(),
            payment_method: z.string().min(1).max(64).optional(),
          })
          .strict(),
        req.body && typeof req.body === "object" ? req.body : {},
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      const {
        payInvoicesFromPortal,
        PaymentRequestError,
        PortalPayNotAllowedError,
        serializePaymentRequest,
      } = await import("@/modules/payment-requests/service");
      try {
        const view = await payInvoicesFromPortal({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          customerId: ctx.customerId,
          invoicePublicIds: parsed.data.invoices,
          currency: parsed.data.currency,
          paymentMethodPublicId: parsed.data.payment_method,
        });
        return serializePaymentRequest(view);
      } catch (e) {
        if (e instanceof PortalPayNotAllowedError)
          return reply
            .code(403)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        if (e instanceof PaymentRequestError)
          return e.code === "not_found" ? notFound(reply, e.message) : badRequest(reply, e.message);
        if (e instanceof CollectionInFlightError)
          return conflict(
            reply,
            "We could not take the payment. A payment on one of these invoices is in progress. Try again when it completes.",
          );
        throw e;
      }
    },
  );

  /** Overpayments the customer may take back (2.69 `customer_chooses`); empty otherwise. */
  app.get("/portal/v1/overpayments", { preHandler: authenticatePortal }, async (req) => {
    const ctx = req.portalSession!;
    const { loadPaymentApplication } = await import("@/modules/payments/application-config");
    const cfg = await loadPaymentApplication(ctx.organizationId, ctx.businessId);
    if (cfg.excessPayment !== "customer_chooses") return { object: "list", data: [] };
    const { listCustomerOverpayments } = await import("@/modules/refunds/excess");
    const rows = await listCustomerOverpayments(ctx.organizationId, ctx.businessId, ctx.customerId);
    return {
      object: "list",
      data: rows.map((r) => ({
        object: "overpayment",
        payment: r.paymentPublicId,
        currency: r.currency,
        refundable_minor: Number(r.refundableMinor),
        created_at: r.createdAt,
      })),
    };
  });

  /** Return one overpayment to the payment method it came from (2.69 `customer_chooses`). */
  app.post(
    "/portal/v1/overpayments/:pay/refund",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const { pay } = req.params as { pay: string };
      const { loadPaymentApplication } = await import("@/modules/payments/application-config");
      const cfg = await loadPaymentApplication(ctx.organizationId, ctx.businessId);
      if (cfg.excessPayment !== "customer_chooses")
        return reply.code(403).send({
          error: {
            type: "invalid_request_error",
            message: "This account does not allow refunds here. Contact us to get your money back.",
          },
        });
      const { refundCustomerOverpayment } = await import("@/modules/refunds/excess");
      const { RefundError } = await import("@/modules/refunds/service");
      try {
        const r = await refundCustomerOverpayment({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          customerId: ctx.customerId,
          paymentPublicId: pay,
        });
        return {
          object: "refund",
          id: r.publicId,
          status: r.status,
          amount_minor: Number(r.amountMinor),
          currency: r.currency,
        };
      } catch (e) {
        if (e instanceof RefundError)
          return e.code === "not_found" ? notFound(reply, e.message) : badRequest(reply, e.message);
        throw e;
      }
    },
  );
}

/**
 * Which lifecycle actions the portal offers on one subscription: the business's switch AND
 * a state the matching route accepts. The routes check both again; this only decides which
 * buttons the page draws.
 */
export function portalSubscriptionActions(
  cfg: ReturnType<typeof resolveStorefrontConfig>,
  sub: { status: string; cancelAtPeriodEnd: boolean },
  reasons: Array<{ code: string; label: string }>,
  /** Paused through the cancel flow's pause offer: the customer may resume it. */
  pausedByOffer = false,
): {
  cancel: {
    timing: "immediately" | "end_of_term";
    reasons: Array<{ code: string; label: string }>;
  } | null;
  pause: boolean;
  resume: boolean;
  reactivate: boolean;
} {
  const ended = sub.status === "cancelled";
  return {
    cancel:
      cfg.allowCancelSubscription && !ended && !sub.cancelAtPeriodEnd
        ? { timing: cfg.cancelTiming, reasons }
        : null,
    pause: cfg.allowPauseResume && sub.status === "active" && !sub.cancelAtPeriodEnd,
    resume: (cfg.allowPauseResume || pausedByOffer) && sub.status === "paused",
    reactivate: cfg.allowReactivate && !ended && sub.cancelAtPeriodEnd,
  };
}
