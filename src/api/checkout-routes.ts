import { GatewayRouterError } from "@/modules/gateway/router";
import { ProviderRefusalError } from "@/providers/types";
import { formatMoney } from "@/platform/currency";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  LIMITS,
  achAuthorizationField,
  clientResultField,
  metadataField,
  httpUrl,
  redirectUrl,
} from "./limits";
import { AchAuthorizationError } from "@/modules/payment-methods/ach-authorization";
import { clientIp } from "@/platform/event-context";
import { countEvent, eventCount } from "@/platform/rate-limit";
import { verifyTurnstile, turnstileRefuses } from "@/platform/turnstile";

/** Failed checkout payments per IP, for the bot check (Hosted pages → bot check). */
const FAILURE_SCOPE = "checkout_payment_failure";
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const countFailedPayment = (ip: string | null) =>
  ip
    ? countEvent({ scope: FAILURE_SCOPE, kind: "ip", value: ip, windowMs: FAILURE_WINDOW_MS })
    : undefined;
import { authenticate, authenticateCheckout } from "@/platform/auth";
import { idempotency, idempotencyOnSend, idempotentNoStore } from "@/platform/idempotency";
import {
  addCheckoutCoupon,
  removeCheckoutCoupon,
  createCheckoutSession,
  getCheckoutView,
  setCheckoutCustomer,
  updateCheckoutCustomerDetails,
  completeCheckout,
  resolveSessionMandateRequirement,
  resolveSessionCurrency,
  gatewayRailCapMinor,
  checkoutFirstChargeMinor,
  resolveHeldPaymentMethod,
  recordCheckoutSetupIntent,
  markCheckoutPaymentStarted,
  markCheckoutViewed,
  markCheckoutDetailsSubmitted,
  recordCheckoutPaymentAttempt,
  CheckoutPaymentRefusedError,
  resolveCheckoutConsent,
  recordCheckoutConsent,
  recordCheckoutSetupConsent,
  type CheckoutConsentRecord,
  setCheckoutItemQuantity,
  revokeCheckoutSession,
  getCheckoutSession,
  readCheckoutInvoiceState,
  CheckoutError,
  CheckoutActionRequiredError,
} from "@/modules/checkout/service";
import { serializePaymentIntent } from "@/modules/payment-intents/service";
import { effectiveMethodTypes } from "@/modules/gateway/service";
import { getCustomerById } from "@/modules/customers/service";
import { hasBillingName, holderName } from "@/modules/customers/names";
import {
  PaymentMethodConfigError,
  PaymentMethodVaultError,
  VaultSetupUnsupportedError,
  listVaultGatewaysForBusiness,
  listPaymentMethods,
  INR_AFA_FREE_CEILING_MINOR,
  isPayableOnSession,
} from "@/modules/payment-methods/service";
import { expectedRecurringDebit } from "@/modules/subscriptions/estimate";
import { serializePaymentMethods } from "@/modules/payment-methods/serialize";
import { resolveCustomerCurrency } from "@/modules/customers/service";
import { getBusinessById } from "@/modules/tenancy/service";
import {
  beginVaultSetup,
  serializeVaultSetup,
  completeVaultFromIntent,
  VaultSetupIntentError,
  achAuthorizationParties,
  achAuthorizationTextFor,
} from "./vault-setup";
import { resolveBusiness, badRequest, notFound, requirePerm, refusedByRateLimit } from "./helpers";
import { config } from "@/platform/config";
import { AUTH_WINDOW_MS } from "@/platform/rate-limit";
import { addressRefinement, requirementIssuesError } from "./address-validation";
import {
  resolveStorefrontConfig,
  resolveCheckoutRedirect,
} from "@/modules/checkout/storefront-config";
import {
  resolveCheckoutFieldConfig,
  isRequired,
  SHIPPING_ADDRESS_REQUIREMENTS,
  type CheckoutFieldConfig,
} from "@/modules/checkout/field-config";
import {
  addressFieldLocksFor,
  addressRequirementIssues,
  billingDetailsComplete,
  withAddressFieldLocks,
} from "@/modules/checkout/address-field-rules";
import { liveTaxRegimes } from "@/modules/tax/service";
import { createLogger } from "@/platform/logger";
import { parseRequest } from "./strict-params";
import { BUYER_METHOD_TYPES } from "@/providers/method-types";

const log = createLogger("checkout.routes");

/** Mint-time address defaults: format-checked like the buyer's, completeness left to the buyer's submit. */
const prefillAddress = z
  .object({
    line1: z.string().max(200).optional(),
    line2: z.string().max(200).optional(),
    line3: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    state_code: z.string().max(10).optional(),
    postal_code: z.string().max(20).optional(),
    country: z.string().length(2).optional(),
    first_name: z.string().max(100).optional(),
    last_name: z.string().max(100).optional(),
    company: z.string().max(200).optional(),
    phone: z.string().max(50).optional(),
  })
  .superRefine(addressRefinement);

const mintBody = z
  .object({
    /** Single-item sugar; equivalent to `items: [{price, quantity}]`. */
    price: z.string().max(LIMITS.id).min(1).optional(), // price_… public id
    quantity: z.number().int().positive().max(LIMITS.quantity).optional(),
    /** Full item list. Wins over `price`. */
    items: z
      .array(
        z.object({
          price: z.string().max(LIMITS.id).min(1),
          quantity: z.number().int().positive().max(LIMITS.quantity).optional(),
        }),
      )
      .min(1)
      .optional(),
    /** Coupon codes to apply on completion. */
    coupons: z.array(z.string().min(1)).optional(),
    /**
     * 'create' (default) subscribes a new customer to the items.
     * 'change' applies the items + coupons to an EXISTING subscription.
     * 'purchase' sells one-time items: a paid invoice, no subscription.
     */
    mode: z.enum(["create", "change", "purchase"]).optional(),
    /** mode='purchase': a known customer (cus_…) buying more. Their details stay theirs. */
    customer_id: z.string().max(LIMITS.id).min(1).optional(),
    subscription: z.string().max(LIMITS.id).min(1).optional(), // sub_… — required when mode='change'
    /**
     * mode='change'. Default false = upsert. True declares
     * `items` EXHAUSTIVE: unlisted non-plan items are removed on completion. Needed by
     * any caller whose UI expresses removal by omitting the line.
     */
    replace_items_list: z.boolean().optional(),
    /** mode='change': restart the term at the change date. */
    reset_term: z.boolean().optional(),
    /** mode='change' on a CANCELLED subscription: completing reactivates it. */
    reactivate: z.boolean().optional(),
    /** With `reactivate`: when the new term starts (past only; backdating policy applies). */
    reactivate_from: z.string().datetime({ offset: true }).optional(),
    /** mode='change': the session's coupons replace the subscription's. */
    replace_coupon_list: z.boolean().optional(),
    /** Where the hosted page sends the buyer after completing, and on cancel. */
    redirect_url: redirectUrl().optional(),
    cancel_url: redirectUrl().optional(),
    /** Caller context, returned on retrieve. */
    pass_thru_content: z.string().max(2048).optional(),
    /**
     * Metadata to write onto the resulting subscription on completion. Valid in both
     * modes.
     *
     * Applied only after the checkout actually completes, so a caller whose change moves
     * both items and a flag can send them in ONE call and get both or neither. Sending
     * `{}` clears the subscription's metadata; omitting the key leaves it alone.
     */
    metadata: metadataField().optional(),
    /**
     * Create mode: defaults for the buyer's details step. Shown on the page as editable
     * values; the buyer's own submit creates the customer, exactly as without them.
     */
    customer: z
      .object({
        email: z.string().max(LIMITS.email).email().optional(),
        tax_registration_number: z.string().trim().max(50).optional(),
      })
      .optional(),
    /** Create mode: billing-address defaults for the details step (same shape as the buyer's). */
    billing_address: prefillAddress.optional(),
  })
  .refine((v) => v.mode !== "change" || (!v.customer && !v.billing_address), {
    message:
      'customer and billing_address prefill are only valid when mode is "create". A change checkout uses the subscription\'s customer',
    path: ["customer"],
  })
  .refine((v) => v.mode === "change" || !(v.replace_items_list || v.reset_term), {
    message: 'replace_items_list and reset_term are only valid when mode is "change"',
    path: ["replace_items_list"],
  })
  // Reject the mismatch at the edge with a field-level message, rather than
  // letting it surface as a generic service error.
  .refine((v) => v.mode !== "change" || !!v.subscription, {
    message: 'subscription is required when mode is "change"',
    path: ["subscription"],
  })
  .refine((v) => v.mode === "change" || !v.subscription, {
    message: 'subscription is only valid when mode is "change"',
    path: ["subscription"],
  })
  // A create page must sell something. A CHANGE page may carry only coupons.
  .refine((v) => v.mode === "change" || !!v.price || (v.items?.length ?? 0) > 0, {
    message: "price or items is required",
    path: ["items"],
  })
  .refine(
    (v) => v.reactivate || !!v.price || (v.items?.length ?? 0) > 0 || (v.coupons?.length ?? 0) > 0,
    { message: "a checkout session needs at least one item or coupon", path: ["items"] },
  )
  .refine((v) => v.mode === "purchase" || !v.customer_id, {
    message: 'customer_id is only valid when mode is "purchase"',
    path: ["customer_id"],
  })
  .refine((v) => !(v.customer_id && (v.customer || v.billing_address)), {
    message: "customer_id names an existing customer, so omit customer and billing_address",
    path: ["customer"],
  })
  .refine((v) => !(v.price && v.items), {
    message: "pass either price or items, not both. price is a short form for a single item",
    path: ["items"],
  });

const buyerAddress = z
  .object({
    line1: z.string().max(200).optional(),
    line2: z.string().max(200).optional(),
    line3: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    state_code: z.string().max(10).optional(),
    postal_code: z.string().max(20).optional(),
    country: z.string().length(2).optional(),
    first_name: z.string().max(100).optional(),
    last_name: z.string().max(100).optional(),
    company: z.string().max(200).optional(),
    phone: z.string().max(50).optional(),
  })
  .superRefine(addressRefinement);

const checkoutCustomerBody = z.object({
  // OPTIONAL, because change mode does not accept one: that checkout's customer — and therefore
  // their email — is pinned at mint time, and a public link must not repoint it. Create mode
  // still requires it, enforced in the handler where the session's mode is known.
  email: z.string().max(LIMITS.email).email().optional(),
  // No flat `name`: the buyer is named by the address CONTACT below, which is what
  // prints on their invoices. The portal dropped its equivalent field for the same
  // reason (a buyer typing their name twice, with the second copy winning nothing),
  // and `customers.name` is deprecated as of 2026-08-23 — see `customers/names.ts`.
  // Full billing-address shape — kept in lock-step with the portal edit
  // (portalMeBody in customer-portal-routes.ts).
  // line1 / country carry no hard `.min(1)` / `.length(2)` requiredness of their own any
  // more (0245): whether they are REQUIRED is now the checkout field matrix's call, applied
  // in the handler via `requireMandatoryFields` once the resolved config is in hand. zod
  // still owns every FORMAT check — length caps here, and country-dependent shape in
  // `addressRefinement` below — so a value that IS sent must still look like a real address;
  // whether one has to be sent is `addressRequirementIssues` in the handler (0334).
  address: buyerAddress.optional(),
  // Ship-to (0360). Same shape as `address`; whether it is read at all is the
  // `shipping.address` matrix key, applied in the handler.
  shipping_address: buyerAddress.optional(),
  // The BUYER's own registration number (GSTIN for India). Same shape and length as
  // the operator-facing customer API deliberately — a buyer-path validation stricter
  // than the operator path would reject registrations an operator can save, and the
  // two would disagree about what a valid id is. No format regex: a wrong GSTIN is
  // bad, but a checkout that refuses a valid-but-unusual one loses the sale outright.
  tax_registration_number: z.string().trim().max(50).optional(),
});

const consentAnswer = z.object({
  recurring: z.boolean().optional(),
  // The sentence the page showed; must equal the current one (the price may have moved).
  recurring_text: z.string().max(1000).optional(),
  terms: z.boolean().optional(),
  marketing: z.boolean().optional(),
});

const checkoutSetupBody = z.object({
  // The consent boxes, sent again here: a checkout the gateway webhook completes never
  // posts `/complete`, so completion checks these instead.
  consent: consentAnswer.optional(),
  /**
   * OPTIONAL as of 0243 — falls back to the business's `storefront_config.default_return_url`
   * / `default_cancel_url` (`resolveStorefrontConfig`) when omitted. Neither present anywhere
   * (no argument, no configured default) is refused with a 400 in the handler: a checkout
   * must never mint an add-card flow with nowhere to send the buyer back.
   */
  return_url: redirectUrl().optional(),
  cancel_url: redirectUrl().optional(),
  gateway_account: z.string().max(LIMITS.id).min(1).optional(), // gwa_… — vault through this gateway (buyer's pick)
  /**
   * The rail to vault on. Widened 2026-09-05 alongside the portal's: Stripe's adapter
   * advertises `us_bank_account` and `sepa_debit` in `capabilities.methods` and does the
   * full lifecycle, but this enum capped the vocabulary at the Indian set — so the value
   * `method_types` had just told the buyer was available could not be sent back.
   */
  method_type: z.enum(BUYER_METHOD_TYPES).optional(),
});

const checkoutCompleteBody = z.object({
  // What the buyer ticked. Checked against the page's own consent block; see
  // `resolveCheckoutConsent`.
  consent: consentAnswer.optional(),
  // Turnstile token, required once this IP has failed `bot_check_after_failures` payments.
  bot_check_token: z.string().max(4096).optional(),
  // Provider token from the buyer-side SDK (pm_… / setup token / tmtest magic
  // token). OPTIONAL because a change-mode checkout may reuse the card already on
  // file — the service enforces that create mode still requires one.
  token: z.string().max(LIMITS.id).min(1).optional(),
  gateway_account: z.string().max(LIMITS.id).min(1).optional(), // gwa_… — MUST match the gateway the setup ran on
  /**
   * `pi_…` the buyer just authenticated, echoed back from the 402 this route
   * returns when the gateway asks for a challenge. Settles the first invoice by
   * consuming that authorization instead of charging the card again.
   */
  payment_intent: z.string().max(LIMITS.id).min(1).optional(),
  /**
   * `pi_…` for the zero-amount SETUP intent `/checkout/v1/setup` returned — a
   * different animal from `payment_intent` above, which settles the first invoice.
   *
   * Preferred over `token`: the gateway's own webhook harvests this same setup intent
   * for the buyer who approves and never comes back, and only going through it puts
   * both on one atomic claim. See `completeVaultFromIntent`.
   */
  setup_intent: z.string().max(LIMITS.id).min(1).optional(),
  /**
   * What the browser SDK returned for a `next_action.mode: 'sdk'` challenge. It answers
   * the challenge the buyer just completed: `payment_intent`'s when one is passed, else
   * `setup_intent`'s.
   */
  client_result: clientResultField().optional(),
  /** The payer accepted the bank debit authorization shown for `setup_intent`'s gateway. */
  ach_authorization: achAuthorizationField().optional(),
  /**
   * `pm_…` — an instrument the customer ALREADY holds, chosen from the checkout's own
   * "Manage cards" panel.
   *
   * The change flow used to offer exactly two doors: confirm on whatever the engine picks,
   * or add a NEW card. A buyer holding two cards — one whose mandate cannot carry the new
   * plan, one that can — had no way to say "use that one", and adding a third card was the
   * only route through. Validated against the SESSION's pinned customer, never trusted from
   * the body: this is a public link.
   */
  payment_method: z.string().max(LIMITS.id).min(1).optional(),
  /**
   * Where the gateway sends the buyer back after a REDIRECT-mode challenge on the
   * FIRST CHARGE — the 402 this route answers with `next_action.mode: 'redirect'`.
   *
   * Distinct from the identically-named pair on `/checkout/v1/setup`, which is about
   * vaulting an instrument. This one is about the money: `completeCheckout` hands it to
   * `chargeBeforeSubscriptionInvoice`, which hands it to the on-session intent, which is
   * the only place a PayPal order gets an `experience_context`. Without it PayPal has
   * nowhere to return the buyer, so they approve the payment and land on PayPal's own
   * dead end — the same shape as the netbanking e-mandate rail, except that one is a
   * measured provider defect and this one was simply a field we never sent.
   *
   * OPTIONAL, unlike on `/setup`. Three quarters of the completions that reach this
   * route can never redirect anywhere — a change-mode confirm on a card already on file,
   * a Stripe `client_secret` challenge, a RazorPay embedded sheet, the replay POST that
   * carries an empty body — and requiring a URL from all of them to fix one arm would be
   * a validation error where today there is a sale. A caller that omits it keeps exactly
   * today's behaviour: no `experience_context`, and the client is responsible for holding
   * the buyer (which is what the hosted page's new-tab fallback still does).
   */
  return_url: redirectUrl().optional(),
  cancel_url: redirectUrl().optional(),
  /**
   * 0243 — collected only when the business has `storefront_config.collect_po_number` on
   * (the storefront decides whether to render the field; the API itself does not gate it,
   * matching `checkoutCustomerBody.tax_registration_number` above). Reaches
   * `subscriptions.po_number` on THIS
   * subscription — see `completeCheckout`. Same shape/limit as the operator-facing
   * `po_number` on `subscription-routes.ts`'s update body.
   */
  po_number: z.string().trim().max(100).optional(),
});

/**
 * Hosted checkout (#10d) — the public, buyer-facing subscribe flow.
 *
 * Two surfaces in one file, mirroring customer-portal-routes.ts:
 *  1. An OPERATOR route (org-key authed) that mints a price-scoped checkout
 *     session and returns the copyable /checkout/s/<token> link — the EXCHANGE
 *     route, which hands the token to an HttpOnly cookie and redirects to a clean
 *     /checkout (W1). See dashboard/lib/storefront-session.ts.
 *  2. The BUYER-facing /checkout/v1/* routes, authed ONLY by that checkout
 *     token (authenticateCheckout). The org API key never satisfies these, and
 *     the checkout token never satisfies /v1/* — separate token namespaces.
 *
 * The price + business are always resolved from the token — never from a URL
 * param — so a checkout session can only ever create its own configured plan.
 */
/**
 * A SPENT link is not a live checkout.
 *
 * `resolveCheckoutSession` deliberately keeps a `completed` session RESOLVABLE, for one
 * reason only: `/checkout/v1/complete` has to be able to replay its stored result
 * idempotently, because a network blip on the redirect leg — and the leg's own "Try
 * again" — re-posts it. Nothing else on this surface has that excuse, yet every other
 * route kept accepting the token for the rest of `CHECKOUT_SESSION_TTL_HOURS`. Measured
 * on this branch, 2026-08-28, against a session already marked `completed`:
 *
 *  - `POST /checkout/v1/setup` → 201, then `POST /checkout/v1/complete {setup_intent}`
 *    → 201: a SECOND card was vaulted on the real customer, from a link whose sale was
 *    already over. `vaultPaymentMethod` never demotes an existing primary, so on a
 *    healthy customer that is a spare — but for a customer with no VALID primary it
 *    CLAIMS `role: 'primary'`, and no-valid-primary is precisely the state a hard
 *    decline leaves behind, i.e. when a "your payment failed" mail has put a checkout
 *    link in the buyer's inbox. From there every renewal, dunning retry and ad-hoc
 *    collection resolves through an instrument the buyer never chose.
 *  - `POST /checkout/v1/customer` on a spent CHANGE link → 200, and the customer's
 *    `address_line1` and `tax_registration_number` were overwritten. The residual risk
 *    `updateCheckoutCustomerDetails` documents is for a checkout IN PROGRESS — address
 *    is place-of-supply, so it moves tax — and it does not extend past the sale.
 *  - `POST /checkout/v1/customer` on a spent CREATE link → 200: a fresh customer was
 *    minted and `resulting_customer_id` repointed at it, after which the idempotent
 *    replay answered with the real buyer's `sub_…` under the new `cus_…`.
 *  - `GET /checkout/v1/payment_methods` → the buyer's instruments (brand, last4,
 *    expiry, gateway reference id, mandate).
 *
 * The hosted page already treats `completed` as terminal — it renders "This checkout is
 * already complete" and never mounts the flow — so this takes nothing away from any
 * client. Two routes stay open on a completed session on purpose:
 * `GET /checkout/v1/session`, which is the page READING that status, and
 * `GET /checkout/v1/invoice`, which the buyer's page polls for a few seconds AFTER the
 * completion that marked the session completed.
 *
 * Gated on `completed` specifically, not on "not open": `completing` is a sub-second
 * claim that every failure path releases back to `open` (a decline, a 402 challenge, a
 * transient error), and refusing it would turn a retryable moment into a dead end.
 */
const isSpent = (status: string) => status === "completed";
/**
 * Does this business let a buyer type a coupon code? Read per request rather than carried on
 * the checkout context: the setting can be switched off while a page is open, and the answer
 * that matters is the one at the moment of the write.
 */
async function buyerCouponsAllowed(ctx: { organizationId: string; businessId: string }) {
  const biz = await getBusinessById(ctx.organizationId, ctx.businessId);
  return biz?.allowCustomerCoupons === true;
}

/** This business's EFFECTIVE checkout field matrix: stored (0245) plus the tax locks (0334).
 *  Read per request — a merchant can change the matrix while a checkout is open. */
async function checkoutFieldConfigFor(ctx: {
  organizationId: string;
  businessId: string;
}): Promise<CheckoutFieldConfig> {
  const [biz, regimes] = await Promise.all([
    getBusinessById(ctx.organizationId, ctx.businessId),
    liveTaxRegimes(ctx.organizationId, [ctx.businessId]),
  ]);
  return withAddressFieldLocks(
    resolveCheckoutFieldConfig(biz),
    addressFieldLocksFor(regimes.get(ctx.businessId) ?? []),
  );
}

/** 403, not 404: the route exists, this business has simply not enabled the box. */
const refuseCouponEntry = (reply: FastifyReply) =>
  reply.code(403).send({
    error: {
      type: "invalid_request_error",
      message: "This checkout does not accept coupon codes",
    },
  });
const refuseSpent = (reply: FastifyReply) =>
  reply.code(409).send({
    error: {
      type: "invalid_request_error",
      message: "This checkout is already complete",
    },
  });

export async function registerCheckoutRoutes(app: FastifyInstance) {
  // ——— Operator: mint a checkout link ——————————————————————————————————————
  app.post(
    "/v1/businesses/:biz/checkout_sessions",
    {
      preHandler: [authenticate, requirePerm("checkout_sessions:manage"), idempotency],
      onSend: idempotencyOnSend,
      // Response body is NOT persisted: it carries raw `cstk_…` token AND a url embedding it; `checkout_sessions` stores only `token_hash`.
      // Route stays idempotent (a retry must never mint a second credential); a replay
      // returns 409 `response_not_replayable` with `created: true`. See idempotency.ts.
      config: idempotentNoStore,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(mintBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const session = await createCheckoutSession({
          organizationId: req.organization!.id,
          businessId: business.id,
          priceId: parsed.data.price,
          quantity: parsed.data.quantity,
          items: parsed.data.items,
          coupons: parsed.data.coupons,
          // Spread-if-present, so an omitted key stays `undefined` all the way to the
          // column's SQL NULL rather than arriving as an explicit `{}` clear.
          ...(parsed.data.metadata !== undefined ? { metadata: parsed.data.metadata } : {}),
          mode: parsed.data.mode,
          subscriptionId: parsed.data.subscription,
          ...(parsed.data.customer_id ? { customerId: parsed.data.customer_id } : {}),
          replaceItemsList: parsed.data.replace_items_list,
          resetTerm: parsed.data.reset_term,
          reactivate: parsed.data.reactivate,
          ...(parsed.data.reactivate_from
            ? { reactivateFrom: new Date(parsed.data.reactivate_from) }
            : {}),
          replaceCouponList: parsed.data.replace_coupon_list,
          redirectUrl: parsed.data.redirect_url,
          cancelUrl: parsed.data.cancel_url,
          passThruContent: parsed.data.pass_thru_content,
          ...(parsed.data.customer || parsed.data.billing_address
            ? {
                prefill: {
                  ...(parsed.data.customer?.email ? { email: parsed.data.customer.email } : {}),
                  ...(parsed.data.customer?.tax_registration_number
                    ? { tax_registration_number: parsed.data.customer.tax_registration_number }
                    : {}),
                  ...(parsed.data.billing_address
                    ? {
                        address: Object.fromEntries(
                          Object.entries(parsed.data.billing_address).filter(
                            (e): e is [string, string] => typeof e[1] === "string" && e[1] !== "",
                          ),
                        ),
                      }
                    : {}),
                },
              }
            : {}),
        });
        return reply.code(201).send({
          object: "checkout_session",
          id: session.publicId,
          mode: parsed.data.mode ?? "create",
          ...(parsed.data.subscription ? { subscription_id: parsed.data.subscription } : {}),
          ...(parsed.data.replace_items_list ? { replace_items_list: true } : {}),
          ...(parsed.data.reset_term ? { reset_term: true } : {}),
          ...(parsed.data.reactivate ? { reactivate: true } : {}),
          ...(parsed.data.reactivate_from ? { reactivate_from: parsed.data.reactivate_from } : {}),
          ...(parsed.data.replace_coupon_list ? { replace_coupon_list: true } : {}),
          ...(parsed.data.redirect_url ? { redirect_url: parsed.data.redirect_url } : {}),
          ...(parsed.data.cancel_url ? { cancel_url: parsed.data.cancel_url } : {}),
          ...(parsed.data.coupons?.length ? { coupons: parsed.data.coupons } : {}),
          // The bearer token is returned exactly once, at mint time.
          token: session.token,
          ...(session.url ? { url: session.url } : {}),
          expires_at: session.expiresAt.toISOString(),
        });
      } catch (e) {
        // A bad mode/target pairing is the CALLER's mistake (400), not a missing
        // resource — only genuine "no such price/subscription" is a 404.
        if (e instanceof CheckoutError) {
          return /^No such /.test(e.message)
            ? notFound(reply, e.message)
            : badRequest(reply, e.message);
        }
        throw e;
      }
    },
  );

  // ——— Operator: revoke a checkout link ————————————————————————————————————
  /**
   * The mint's counterpart, and the only lever an operator has when a link leaks.
   *
   * `checkout_sessions.revoked_at` was honoured by `resolveCheckoutSession` with nothing in
   * the product writing it (SECURITY_TODO). This is the writer — see
   * `revokeCheckoutSession` for why revocation is deliberately orthogonal to `isSpent`:
   * revoked answers **401 everywhere**, from the resolver, before `authenticateCheckout`
   * authenticates anything; spent answers **409 on the mutating buyer routes only** and
   * leaves `/session` and `/invoice` readable. Revoking a COMPLETED session is allowed on
   * purpose — that is the leaked-link case, and it ends the `/complete` replay too.
   *
   * `requirePerm('ops')`, matching the MINT above rather than something stricter. The
   * levels have to be read together: `ops` can hand out a link that takes a buyer's money,
   * so `ops` must be able to kill one. Anything higher is a role that can create the
   * exposure and not close it, and revocation is the fail-SAFE direction — the same
   * reasoning `POST /v1/api_keys/:id/revoke` records for why it carries no step-up.
   *
   * Idempotent by the service, and the response carries no credential (unlike the mint,
   * whose body holds the raw `cstk_…`), so the ordinary idempotency store applies — no
   * `idempotentNoStore` here.
   */
  app.post(
    "/v1/businesses/:biz/checkout_sessions/:id/revoke",
    {
      preHandler: [authenticate, requirePerm("checkout_sessions:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const revoked = await revokeCheckoutSession({
        organizationId: req.organization!.id,
        businessId: business.id,
        sessionPublicId: id,
      });
      // One answer for "another tenant's session", "another business's session" and
      // "no such id" — an operator learns nothing about ids that are not theirs.
      if (!revoked) return notFound(reply, `No such checkout session: ${id}`);
      return {
        object: "checkout_session",
        id: revoked.publicId,
        status: revoked.status,
        revoked_at: revoked.revokedAt.toISOString(),
      };
    },
  );

  // Retrieve a session — its outcome, and the context the caller stored with it.
  app.get(
    "/v1/businesses/:biz/checkout_sessions/:id",
    { preHandler: [authenticate, requirePerm("checkout_sessions:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const r = await getCheckoutSession({
        organizationId: req.organization!.id,
        businessId: business.id,
        sessionPublicId: id,
      });
      if (!r) return notFound(reply, `No such checkout session: ${id}`);
      const iso = (d: Date | null) => (d ? d.toISOString() : null);
      return {
        object: "checkout_session",
        id: r.id,
        mode: r.mode,
        status: r.status,
        subscription: r.subscription,
        resulting_subscription: r.resultingSubscription,
        resulting_invoice: r.invoice,
        customer: r.customer,
        items: r.items,
        coupons: r.coupons,
        replace_items_list: r.replaceItemsList,
        replace_coupon_list: r.replaceCouponList,
        reset_term: r.resetTerm,
        reactivate: r.reactivate,
        reactivate_from: iso(r.reactivateFrom),
        redirect_url: r.redirectUrl,
        cancel_url: r.cancelUrl,
        pass_thru_content: r.passThruContent,
        metadata: r.metadata,
        ...(r.prefill
          ? {
              customer_prefill: {
                email: r.prefill.email ?? null,
                tax_registration_number: r.prefill.tax_registration_number ?? null,
              },
              billing_address_prefill: r.prefill.address ?? null,
            }
          : {}),
        created_at: r.createdAt.toISOString(),
        expires_at: r.expiresAt.toISOString(),
        completed_at: iso(r.completedAt),
        revoked_at: iso(r.revokedAt),
      };
    },
  );

  // ——— Buyer: hosted checkout surface (checkout-token auth ONLY) ————————————
  app.get("/checkout/v1/session", { preHandler: authenticateCheckout }, async (req, reply) => {
    const ctx = req.checkoutSession!;
    const view = await getCheckoutView(ctx);
    if (!view) return notFound(reply, "Checkout session target no longer exists");
    // `id` is the session's PUBLIC id (`cs_…`), the same value recorded as the actor on
    // this session's events. It is on the wire so the hosted page has a non-secret,
    // stable key for its per-tab storage — before W1 that key was the session TOKEN,
    // which meant a live credential sat in sessionStorage for the length of a redirect
    // out to a payment provider and back.
    return { object: "checkout_view", id: ctx.sessionPublicId, ...view };
  });

  // Capture the buyer's identity (create-or-reuse by email within the business).
  app.post(
    "/checkout/v1/customer",
    { preHandler: [authenticateCheckout, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.checkoutSession!;
      // A spent link must not write to the customer it produced — see `isSpent`.
      if (isSpent(ctx.status)) return refuseSpent(reply);
      const parsed = parseRequest(checkoutCustomerBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        /**
         * CHANGE MODE UPDATES, CREATE MODE CREATES.
         *
         * The customer of a change checkout is pinned to the target subscription's owner at mint
         * time, and `setCheckoutCustomer` refuses to run there — correctly, because a PUBLIC link
         * must never decide WHICH customer a checkout is about. But that left a buyer mid-change
         * with no way to supply their own billing details, which is a dead end as soon as the
         * gateway needs one: RazorPay will not vault a card for recurring payments without a phone
         * number, and its error tells the BUYER to "add a phone number to the customer" — an
         * operator action they cannot perform.
         *
         * So the two operations are separated rather than the guard being widened: identity
         * (which customer, and their email) stays pinned; the billing details they legitimately
         * own become editable.
         */
        if (!ctx.customerPinned && !parsed.data.email) {
          return badRequest(reply, "email is required to start a checkout");
        }
        /**
         * NOTE: `customer.email` is one of the fifteen matrix keys (default `show`), but
         * this rule above is intentionally untouched by it. Identifying the buyer to
         * CREATE a customer is structural, not a preference — the matrix only decides
         * whether the field RENDERS on the buyer's page, and a merchant setting it to
         * `hide` cannot also make a create-mode checkout skip supplying one. Do not wire
         * this to the matrix without also changing the buyer form to always collect it.
         */
        /**
         * The checkout field matrix (0245) — layered ON TOP of zod's own shape checks,
         * which by design no longer carry `billing.line1`/`billing.country`'s
         * requiredness (see the schema comment above `checkoutCustomerBody.address`).
         * A field this business has set to `mandatory` is refused by name here; a
         * field set to `hide` is simply not checked — and, if the caller sends one
         * anyway, it is accepted and stored like any other value. Hiding a field is a
         * rendering instruction for the buyer's page, not a data-acceptance gate — the
         * same convention `storefront_config.collect_po_number` uses below.
         */
        const fieldConfig = await checkoutFieldConfigFor(ctx);
        // Only an address the caller sent is checked: an early step may set the email alone.
        const missing = parsed.data.address
          ? addressRequirementIssues(fieldConfig, parsed.data.address)
          : [];
        if (missing.length > 0) return badRequest(reply, requirementIssuesError(missing));
        if (
          isRequired(fieldConfig, "customer.tax_registration_number") &&
          !parsed.data.tax_registration_number?.trim()
        ) {
          return badRequest(reply, "tax_registration_number is required");
        }
        /**
         * Ship-to (0360). Hidden → any sent value is ignored. A customer the session did not
         * create (change mode, an existing customer) is never written: the buyer changes
         * their address book in the portal. Like billing, only a details post (one that
         * carries `address`) is held to `mandatory`.
         */
        const shippingState = ctx.customerPinned ? "hide" : fieldConfig["shipping.address"];
        const sentShipping = shippingState === "hide" ? undefined : parsed.data.shipping_address;
        if (sentShipping) {
          const shipMissing = addressRequirementIssues(SHIPPING_ADDRESS_REQUIREMENTS, sentShipping);
          if (shipMissing.length > 0)
            return badRequest(reply, requirementIssuesError(shipMissing, "shipping_address"));
        } else if (shippingState === "mandatory" && parsed.data.address) {
          return badRequest(reply, "shipping_address is required");
        }
        // Sent → the default book entry; a details post without one under `show` clears it.
        const shippingAddress =
          shippingState === "hide"
            ? undefined
            : sentShipping
              ? { ...sentShipping }
              : parsed.data.address
                ? null
                : undefined;
        const address = parsed.data.address
          ? {
              line1: parsed.data.address.line1,
              line2: parsed.data.address.line2,
              line3: parsed.data.address.line3,
              city: parsed.data.address.city,
              state: parsed.data.address.state,
              stateCode: parsed.data.address.state_code,
              postalCode: parsed.data.address.postal_code,
              country: parsed.data.address.country,
              firstName: parsed.data.address.first_name,
              lastName: parsed.data.address.last_name,
              company: parsed.data.address.company,
              phone: parsed.data.address.phone,
            }
          : undefined;
        const customer = ctx.customerPinned
          ? await updateCheckoutCustomerDetails(ctx, {
              address,
              taxRegistrationNumber: parsed.data.tax_registration_number,
            })
          : await setCheckoutCustomer(ctx, {
              email: parsed.data.email!,
              address,
              taxRegistrationNumber: parsed.data.tax_registration_number,
              shippingAddress,
            });
        await markCheckoutDetailsSubmitted(ctx);
        return reply.code(200).send({
          object: "checkout_customer",
          id: customer.publicId,
          email: customer.email,
          // Derived, read-only — same rule as `serializeCustomer`.
          name: holderName(customer),
          // Indian-gateway export rule: card setup needs a name + address up front.
          // Same gate as the portal's (`serializePortalMe`) and it must stay the same:
          // ANY usable billing name counts — the address contact, then the account
          // holder. Testing the old `customer.name` column made our own invention
          // mandatory before a card could be vaulted, which this form cannot satisfy at
          // all: it collects the billing CONTACT, and nothing collects `name`.
          // Line1 and country count only where this checkout requires them (0334).
          billing_details_complete: billingDetailsComplete(fieldConfig, hasBillingName(customer), {
            line1: customer.addressLine1,
            country: customer.country,
          }),
        });
      } catch (e) {
        if (e instanceof CheckoutError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  /**
   * The gateways this buyer may pay through, and the facts the rail choice depends on.
   *
   * Mirrors `/portal/v1/payment_methods/gateways`. It exists because the checkout had no
   * gateway list at all: the payment step offered a single "Add card" button and the
   * setup route then defaulted `methodTypes` to `['card']`, so a buyer arriving through a
   * hosted checkout could not choose UPI Autopay or a netbanking e-mandate — the two
   * rails most Indian buyers want, and the only ones that collect unattended above the
   * RBI ceiling. They could only add them later, from the portal, after signing up.
   *
   * `method_types` is returned here so the options the buyer sees are the ones their
   * gateway actually supports rather than a hardcoded guess in the storefront. The
   * portal's equivalent route used to drop it — leaving `add-card.tsx` on a
   * `['card','upi','bank_transfer']` fallback that could offer UPI or netbanking on an
   * account with neither enabled — and now returns it too. Keep the two in step.
   */
  /**
   * The buyer's own coupon box, gated by a business setting
   * (`businesses.allow_customer_coupons`, 0238, off by default) — a promo box on a signup
   * page is the merchant's conversion decision.
   *
   * Both routes answer with the RE-PRICED view rather than an acknowledgement, because the
   * only reason a buyer types a code is to see the new total: a bare 204 would force the
   * page into a second round trip and show a stale total in between.
   *
   * No `idempotency` preHandler, unlike the mutating routes around them. These are
   * idempotent by construction — adding a code already on the page is a no-op and so is
   * removing one that is not there — and an Idempotency-Key would make a buyer's second,
   * deliberate attempt after fixing a typo replay the first one's failure.
   *
   * Recorded as a documented exemption in `scripts/verify-idempotency-race.ts`, whose
   * coverage check otherwise reports both routes as unprotected writes. The decision above
   * is the reason; the entry there is what stops it reading as an oversight.
   */
  const couponBody = z.object({ code: z.string().min(1).max(LIMITS.code) });

  app.post("/checkout/v1/coupon", { preHandler: authenticateCheckout }, async (req, reply) => {
    const ctx = req.checkoutSession!;
    // A spent link must not re-price what it already sold — see `isSpent`.
    if (isSpent(ctx.status)) return refuseSpent(reply);
    if (!(await buyerCouponsAllowed(ctx))) return refuseCouponEntry(reply);
    const parsed = parseRequest(couponBody, req.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    // Coupon codes can be guessed: limit tries per session and per address.
    if (
      await refusedByRateLimit(
        req,
        reply,
        {
          scope: "checkout_coupon",
          keys: [
            {
              kind: "resource",
              value: ctx.sessionPublicId,
              limit: config.RATE_LIMIT_COUPON_TRIES_PER_SESSION,
            },
            { kind: "ip", value: req.ip, limit: config.RATE_LIMIT_COUPON_TRIES_PER_IP },
          ],
          windowMs: AUTH_WINDOW_MS,
        },
        "You tried too many coupon codes. Wait 15 minutes and try again.",
      )
    )
      return;
    let codes;
    try {
      codes = await addCheckoutCoupon(ctx, parsed.data.code);
    } catch (e) {
      // "No such coupon" is the buyer mistyping, not a server fault: a 400 the page can
      // render beside the field, never a 500.
      if (e instanceof CheckoutError)
        return reply
          .code(400)
          .send({ error: { type: "invalid_request_error", message: e.message } });
      throw e;
    }
    const view = await getCheckoutView({ ...ctx, couponCodes: codes });
    if (!view) return notFound(reply, "Checkout session target no longer exists");
    return { object: "checkout_view", id: ctx.sessionPublicId, ...view };
  });

  app.delete("/checkout/v1/coupon", { preHandler: authenticateCheckout }, async (req, reply) => {
    const ctx = req.checkoutSession!;
    if (isSpent(ctx.status)) return refuseSpent(reply);
    if (!(await buyerCouponsAllowed(ctx))) return refuseCouponEntry(reply);
    const parsed = parseRequest(couponBody, req.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const codes = await removeCheckoutCoupon(ctx, parsed.data.code);
    const view = await getCheckoutView({ ...ctx, couponCodes: codes });
    if (!view) return notFound(reply, "Checkout session target no longer exists");
    return { object: "checkout_view", id: ctx.sessionPublicId, ...view };
  });

  app.get("/checkout/v1/gateways", { preHandler: authenticateCheckout }, async (req, reply) => {
    const ctx = req.checkoutSession!;
    if (isSpent(ctx.status)) return refuseSpent(reply);
    const customer = ctx.resultingCustomerId
      ? await getCustomerById(ctx.organizationId, ctx.resultingCustomerId)
      : null;
    const biz = await getBusinessById(ctx.organizationId, ctx.businessId);
    /**
     * Resolved from the CUSTOMER first, exactly as the portal route does and for the
     * same measured reason: `customers.currency` is usually null, and filtering by the
     * business default then hides the only gateway that can collect. An INR buyer on a
     * USD-default business was offered a list with RazorPay — INR-only — absent.
     */
    // The session's own currency comes first: a USD plan on an INR-default business must
    // not be offered a gateway that saves only in INR.
    const currency =
      (await resolveSessionCurrency(ctx)) ??
      (customer ? await resolveCustomerCurrency(ctx.organizationId, customer) : null) ??
      biz?.defaultCurrency ??
      undefined;
    const gws = await listVaultGatewaysForBusiness(ctx.organizationId, ctx.businessId, currency);
    /**
     * What this buyer will be debited on a recurring basis, and the amount above which
     * the rail they pick starts demanding authentication every time.
     *
     * Facts, not a recommendation — the storefront decides how to phrase it, and a
     * non-INR buyer gets nulls rather than an inapplicable rule.
     *
     * ⚠️ It used to read the customer's EXISTING subscriptions, which is the wrong figure on
     * both surfaces this endpoint serves: on a CHANGE checkout that is the plan the buyer is
     * leaving, and on a SIGNUP there are no subscriptions at all, so `expected_debit_minor`
     * came back 0 and the buyer of a ₹28,215 plan was told nothing about a rail that would
     * stop and ask on every debit. It is now sized from THIS SESSION —
     * `resolveSessionMandateRequirement`, the same resolver the change view and
     * `/checkout/v1/setup` use, so the advice, the recommendation and the mandate actually
     * registered are one number. The old proxy remains the fallback for a session that
     * cannot be priced.
     */
    const mandate = await resolveSessionMandateRequirement(ctx);
    const expectedDebitMinor =
      mandate?.largestDebitMinor ??
      (customer && currency
        ? await expectedRecurringDebit(ctx.organizationId, ctx.businessId, customer.id, currency)
        : 0n);
    const parties = () => achAuthorizationParties(ctx.organizationId, ctx.businessId, customer!.id);
    const capOf = (key: string, m: string) => gatewayRailCapMinor(key, m, currency);
    const data = await Promise.all(
      gws.map(async (g) => {
        // The rails this account can really offer for THIS currency — the operator's
        // list when set, the adapter's capabilities when not, minus the rails the currency
        // rules out. See `effectiveMethodTypes`. A rail the gateway caps below this debit
        // (PayU UPI: ₹15,000) is left out.
        const methodTypes = effectiveMethodTypes(g, currency, "setup").filter((m) => {
          const cap = capOf(g.gatewayKey, m);
          return cap == null || expectedDebitMinor <= cap;
        });
        const caps = Object.fromEntries(
          methodTypes.flatMap((m) => {
            const cap = capOf(g.gatewayKey, m);
            return cap == null ? [] : [[m, Number(cap)]];
          }),
        );
        return {
          id: g.id,
          gateway_key: g.gatewayKey,
          label: g.label,
          method_types: methodTypes,
          // The most one debit may be on a rail at this gateway. The page shows the lower of
          // this and `required_mandate_ceiling_minor`, which is what the mandate registers.
          ...(Object.keys(caps).length ? { mandate_ceiling_cap_minor: caps } : {}),
          // Shown before a bank account is saved, where the gateway shows no text of its own.
          ach_authorization: customer
            ? await achAuthorizationTextFor(g.gatewayKey, methodTypes, parties)
            : null,
        };
      }),
    );
    return {
      object: "list",
      data,
      expected_debit_minor: Number(expectedDebitMinor),
      unattended_debit_limit_minor:
        currency && currency.toUpperCase() === "INR" ? Number(INR_AFA_FREE_CEILING_MINOR) : null,
      /**
       * The ceiling `POST /checkout/v1/setup` will register the mandate with, so the card step
       * can state it BEFORE the provider's own sheet does. Null when the session cannot be
       * priced — the setup route then falls back to `deriveMandateCeiling` and the page says
       * nothing rather than guessing.
       */
      required_mandate_ceiling_minor: mandate ? Number(mandate.requiredCeilingMinor) : null,
      /** Rails that cannot be registered that high at all (NPCI caps UPI Autopay). */
      rails_over_cap: mandate?.railsOverCap ?? [],
      /**
       * The currency every figure above is in. The storefront used to hardcode INR whenever
       * `unattended_debit_limit_minor` was non-null, which was true only by coincidence of
       * that field being INR-only.
       */
      debit_currency: mandate?.currency ?? currency ?? null,
    };
  });

  /**
   * The instruments this buyer already holds, so the card step can offer them rather than
   * insisting on a new one.
   *
   * Same serializer as the portal (`serializePaymentMethods`), which is what carries each
   * one's MANDATE — and the ceiling is the whole point here: with it, a buyer whose plan
   * outgrew card A can see that card B already covers it and just pick B.
   */
  app.get(
    "/checkout/v1/payment_methods",
    { preHandler: authenticateCheckout },
    async (req, reply) => {
      const ctx = req.checkoutSession!;
      // The buyer's vaulted instruments are not readable from a spent link — see `isSpent`.
      if (isSpent(ctx.status)) return refuseSpent(reply);
      if (!ctx.resultingCustomerId) return { object: "list", data: [] };
      const rows = await listPaymentMethods(ctx.organizationId, ctx.resultingCustomerId);
      return {
        object: "list",
        // Only what could actually be charged. An `invalid` instrument (a hard decline)
        // offered as a choice is a control that cannot do what it says.
        //
        // `isPayableOnSession`, not `status === 'valid'`. Checkout is ON-SESSION — the
        // buyer is here, completing the gateway's own sheet — so a lapsed MANDATE says
        // nothing about whether this card can take the payment. Since 2026-09-01 the
        // sweep demotes an instrument to `expired` for a lapsed mandate as well as a dead
        // card (`decidePaymentSourceExpiry`'s `reason`), and reading the conflated column
        // here hid every saved card from a returning buyer and made them retype one.
        data: await serializePaymentMethods(
          ctx.organizationId,
          rows.filter((r) => isPayableOnSession(r)),
        ),
      };
    },
  );

  // The page was shown: first view, layout and device class, for the conversion report.
  app.post(
    "/checkout/v1/viewed",
    { preHandler: [authenticateCheckout, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.checkoutSession!;
      const parsed = parseRequest(
        z.object({
          layout: z.enum(["steps", "one_page"]),
          device_class: z.enum(["mobile", "tablet", "desktop"]),
        }),
        req.body,
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      await markCheckoutViewed(ctx, {
        layout: parsed.data.layout,
        deviceClass: parsed.data.device_class,
      });
      return reply.code(200).send({ object: "checkout_view", recorded: true });
    },
  );

  // The buyer changes one line of a payment-link checkout, within the link's limits (E3).
  app.post(
    "/checkout/v1/items",
    { preHandler: [authenticateCheckout, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.checkoutSession!;
      if (isSpent(ctx.status)) return refuseSpent(reply);
      const parsed = parseRequest(
        z.object({
          price: z.string().max(LIMITS.id).min(1),
          quantity: z.number().int().nonnegative().max(100000),
        }),
        req.body,
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        await setCheckoutItemQuantity(ctx, parsed.data.price, parsed.data.quantity);
        return reply.code(200).send({ object: "checkout_items", updated: true });
      } catch (e) {
        if (e instanceof CheckoutError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Begin an add-card flow for the checkout's customer (must be set first).
  app.post(
    "/checkout/v1/setup",
    { preHandler: [authenticateCheckout, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.checkoutSession!;
      // No new add-card flow may be STARTED on a spent link — see `isSpent`.
      if (isSpent(ctx.status)) return refuseSpent(reply);
      const parsed = parseRequest(checkoutSetupBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      if (!ctx.resultingCustomerId)
        return badRequest(reply, "Set customer details before adding a card");
      const customer = await getCustomerById(ctx.organizationId, ctx.resultingCustomerId);
      if (!customer) return notFound(reply, "Checkout session customer no longer exists");
      /**
       * 0243 — `return_url`/`cancel_url` used to be REQUIRED on every call; now a business
       * default (`storefront_config.default_return_url`/`default_cancel_url`) can stand in
       * for either. The call's own value always wins when present.
       *
       * Both still absent is refused here rather than let through: this is the whole safety
       * property the fallback exists to preserve — an add-card flow must never begin with
       * nowhere to send the buyer back.
       */
      const business = await getBusinessById(ctx.organizationId, ctx.businessId);
      const storefrontConfig = resolveStorefrontConfig(business);
      const redirect = resolveCheckoutRedirect(storefrontConfig, {
        returnUrl: parsed.data.return_url,
        cancelUrl: parsed.data.cancel_url,
      });
      if (!redirect) {
        return badRequest(
          reply,
          "return_url and cancel_url are required. To omit them, configure default_return_url and " +
            "default_cancel_url on this business in Settings → Hosted pages",
        );
      }
      const { returnUrl, cancelUrl } = redirect;
      try {
        await recordCheckoutSetupConsent(ctx, parsed.data.consent, clientIp(req));
      } catch (e) {
        if (e instanceof CheckoutError) return badRequest(reply, e.message);
        throw e;
      }
      await markCheckoutPaymentStarted(ctx);
      try {
        /**
         * The ceiling this session's outcome needs — the SAME number the change page
         * recommended, from the same resolver.
         *
         * Without it the mandate was sized by `deriveMandateCeiling`, which reads the
         * customer's CURRENT subscriptions: on a change checkout that is the plan the buyer
         * is LEAVING, so an upgrade registered a mandate too small for the very proration
         * invoice that followed it — and "Use a different card", the one remedy offered,
         * re-registered it just as small. On a signup it is worse: there are no
         * subscriptions at all, so every INR mandate registered at the ₹15,000 fallback
         * however large the plan was (measured 2026-08-13, a ₹2,595 subscription refused on
         * its first invoice). The session knows what it is selling; it should say so.
         *
         * Null (nothing priceable) deliberately falls through to the derivation rather than
         * to a guess.
         */
        const mandate = await resolveSessionMandateRequirement(ctx);
        // A gateway that caps this rail below the debit cannot carry it (PayU UPI: ₹15,000).
        let ceilingMinor = mandate?.requiredCeilingMinor;
        if (mandate && parsed.data.method_type && parsed.data.gateway_account) {
          const gws = await listVaultGatewaysForBusiness(
            ctx.organizationId,
            ctx.businessId,
            mandate.currency,
          );
          const key = gws.find((g) => g.id === parsed.data.gateway_account)?.gatewayKey;
          const cap = key
            ? gatewayRailCapMinor(key, parsed.data.method_type, mandate.currency)
            : null;
          if (cap != null && mandate.largestDebitMinor > cap)
            return badRequest(
              reply,
              `This payment method can take at most ${formatMoney(cap, mandate.currency)} for each payment. Select a different payment method.`,
            );
          if (cap != null && ceilingMinor != null && ceilingMinor > cap) ceilingMinor = cap;
        }
        // A registration that can collect the first invoice does (PayU): one payment at signup.
        const firstChargeMinor = await checkoutFirstChargeMinor(ctx);
        // Recorded as a zero-amount `setup` payment intent where that changes nothing
        // about the gateway call (see src/api/vault-setup.ts); the response fields are
        // the same either way, with `payment_intent`/`next_action` added.
        const outcome = await beginVaultSetup({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          customer,
          returnUrl,
          cancelUrl,
          gatewayAccountId: parsed.data.gateway_account,
          // The mandate is registered in the currency the session bills in, and sized in it
          // (capped by the rail's per-payment limit where the gateway has one).
          ...(mandate
            ? {
                currency: mandate.currency,
                maxAmountMinor: ceilingMinor ?? mandate.requiredCeilingMinor,
              }
            : await resolveSessionCurrency(ctx).then((c) => (c ? { currency: c } : {}))),
          ...(firstChargeMinor ? { firstChargeMinor } : {}),
          // Buyer-facing card step — ask for the card rail explicitly (see the same
          // note on the portal setup route: RazorPay otherwise mandates netbanking).
          methodTypes: parsed.data.method_type ? [parsed.data.method_type] : ["card"],
        });
        /**
         * Remember which intent this session is waiting on, so the WEBHOOK can finish the
         * checkout for a buyer who cannot come back — the netbanking e-mandate rail, where
         * RazorPay never returns the payer. See `completeCheckoutForSetupIntent`.
         */
        if (outcome.intent) await recordCheckoutSetupIntent(ctx, outcome.intent.publicId);
        return reply.code(201).send(serializeVaultSetup(outcome));
      } catch (e) {
        if (
          e instanceof PaymentMethodConfigError ||
          e instanceof VaultSetupUnsupportedError ||
          e instanceof ProviderRefusalError ||
          // The buyer's gateway pick cannot take this currency or method (`beginVaultSetup`).
          e instanceof GatewayRouterError
        ) {
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        }
        throw e;
      }
    },
  );

  // Complete: vault the confirmed card + create the subscription. Idempotent-ish.
  app.post(
    "/checkout/v1/complete",
    { preHandler: [authenticateCheckout, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.checkoutSession!;
      const parsed = parseRequest(checkoutCompleteBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      await markCheckoutPaymentStarted(ctx);
      // The instrument, resolved BEFORE the checkout runs. Completing through the setup
      // intent is what keeps the buyer's completion and the gateway's webhook harvest on
      // one atomic claim instead of each vaulting the same instrument — the portal's
      // half of this is `POST /portal/v1/payment_methods`.
      let vaultedPmId: string | undefined;
      /**
       * A REPLAY resolves nothing and vaults nothing.
       *
       * `completeCheckout` answers a `completed` session from its stored result without
       * touching an instrument, so both arms below were pure side effect on that path —
       * and `setup_intent` there vaulted a second card on the real customer, which
       * claims the PRIMARY role whenever no valid one is left (measured; see `isSpent`).
       * A legitimate retry re-posts the same
       * body it sent the first time, so this must skip the arms rather than refuse the
       * request: the buyer still gets the ids their first completion produced.
       */
      const replaying = isSpent(ctx.status);
      /**
       * `invoice.po_number` — the one matrix key this route (not `/checkout/v1/customer`)
       * owns. Two switches gate it, and they answer different questions:
       *   - `storefront_config.collect_po_number` (0243) says whether the field is on the
       *     buyer's page AT ALL. This matrix never overrides that — a business that has
       *     not turned collection on gets no enforcement here regardless of what the
       *     matrix says, because the field was never offered for the buyer to fill in.
       *   - `invoice.po_number` on the matrix (default `hide`) says whether, GIVEN
       *     collection is on, the field is required.
       * Skipped on a REPLAY like every other arm below: a stored completion is being
       * re-served, not re-validated.
       */
      if (!replaying) {
        const poBusiness = await getBusinessById(ctx.organizationId, ctx.businessId);
        const collectsPoNumber = resolveStorefrontConfig(poBusiness).collectPoNumber;
        const fieldConfig = resolveCheckoutFieldConfig(poBusiness);
        if (
          collectsPoNumber &&
          isRequired(fieldConfig, "invoice.po_number") &&
          !parsed.data.po_number?.trim()
        ) {
          return badRequest(reply, "po_number is required");
        }
      }
      /**
       * The buyer's own pick from "Manage cards". Resolved to an internal id HERE, against
       * the session's pinned customer — a public link must never let a body name someone
       * else's instrument. `status` is checked too: choosing an invalid card would be
       * refused later by collection, which is a worse place to find out.
       */
      if (parsed.data.payment_method && !replaying) {
        // The ownership rule lives in the service (`resolveHeldPaymentMethod`) — it is a
        // session invariant on a public link, and it is testable there.
        try {
          vaultedPmId = await resolveHeldPaymentMethod(ctx, parsed.data.payment_method);
        } catch (e) {
          if (e instanceof CheckoutError) return badRequest(reply, e.message);
          throw e;
        }
      }
      if (parsed.data.setup_intent && !replaying) {
        if (!ctx.resultingCustomerId)
          return badRequest(reply, "Set customer details before adding a card");
        try {
          const pm = await completeVaultFromIntent({
            organizationId: ctx.organizationId,
            businessId: ctx.businessId,
            customerId: ctx.resultingCustomerId,
            paymentIntentPublicId: parsed.data.setup_intent,
            ...(parsed.data.client_result && !parsed.data.payment_intent
              ? { clientResult: parsed.data.client_result }
              : {}),
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
          vaultedPmId = pm.id;
        } catch (e) {
          if (e instanceof AchAuthorizationError || e instanceof PaymentMethodConfigError)
            return badRequest(reply, e.message);
          if (!(e instanceof VaultSetupIntentError)) throw e;
          log.warn("checkout add-card refused", {
            event: "checkout_add_card_refused",
            intent: parsed.data.setup_intent,
            detail: e.detail,
          });
          return e.status === 404 ? notFound(reply, e.message) : badRequest(reply, e.message);
        }
      }
      // Bot check: after N failed payments from this IP in 24 h, ask for a Turnstile token.
      if (!replaying) {
        const botBiz = await getBusinessById(ctx.organizationId, ctx.businessId);
        const threshold = resolveStorefrontConfig(botBiz).botCheckAfterFailures;
        const ip = clientIp(req);
        if (threshold != null && ip) {
          const failures = await eventCount({
            scope: FAILURE_SCOPE,
            kind: "ip",
            value: ip,
            windowMs: FAILURE_WINDOW_MS,
          });
          if (failures >= threshold) {
            const token = parsed.data.bot_check_token;
            if (turnstileRefuses(await verifyTurnstile(token, ip)))
              return reply.code(400).send({
                error: {
                  type: "invalid_request_error",
                  code: token ? "bot_check_failed" : "bot_check_required",
                  message: token
                    ? "We could not check that you are a person. Try again."
                    : "Complete the check to show that you are a person.",
                },
              });
          }
        }
      }
      // Required boxes are checked before any money moves.
      let consentRecord: CheckoutConsentRecord | null = null;
      if (!replaying) {
        try {
          consentRecord = await resolveCheckoutConsent(ctx, parsed.data.consent);
        } catch (e) {
          if (e instanceof CheckoutError) return badRequest(reply, e.message);
          throw e;
        }
      }
      try {
        const result = await completeCheckout(ctx, {
          paymentMethodToken: parsed.data.token,
          paymentMethodId: vaultedPmId,
          // Vault on the SAME gateway the setup ran on (the buyer's pick).
          gatewayAccountId: parsed.data.gateway_account,
          paymentIntentId: parsed.data.payment_intent,
          ...(parsed.data.client_result && parsed.data.payment_intent
            ? { clientResult: parsed.data.client_result }
            : {}),
          // Only reaches the gateway on the FIRST-CHARGE path, and only when that charge
          // comes back `requires_action` on-session. A replay never gets there (it returns
          // the stored result before the claim), and neither does the consume path.
          ...(parsed.data.return_url ? { returnUrl: parsed.data.return_url } : {}),
          ...(parsed.data.cancel_url ? { cancelUrl: parsed.data.cancel_url } : {}),
          ...(parsed.data.po_number ? { poNumber: parsed.data.po_number } : {}),
        });
        if (!replaying) {
          // `processing`, or outstanding with no recorded failure, is not a refusal.
          const failure =
            result.paymentError?.message ?? result.unpaidInvoice?.failure?.message ?? null;
          await recordCheckoutPaymentAttempt(ctx, failure);
          if (failure !== null) await countFailedPayment(clientIp(req));
          if (consentRecord) await recordCheckoutConsent(ctx, consentRecord, clientIp(req));
        }
        return reply.code(201).send({
          object: "checkout_complete",
          ...(result.subscriptionId ? { subscription_id: result.subscriptionId } : {}),
          ...(result.invoiceId ? { invoice_id: result.invoiceId } : {}),
          customer_id: result.customerId,
          ...(result.paymentIntentId ? { payment_intent: result.paymentIntentId } : {}),
          ...(result.paymentError ? { payment_error: result.paymentError } : {}),
          // The change happened, the money did not. A 201 is still right — the resource
          // was created/changed — and the buyer's page says what is outstanding.
          ...(result.unpaidInvoice
            ? {
                unpaid_invoice: {
                  id: result.unpaidInvoice.id,
                  amount_due_minor: result.unpaidInvoice.amountDueMinor,
                  currency: result.unpaidInvoice.currency,
                  // `processing` ≠ refused: the buyer's page polls GET /checkout/v1/invoice
                  // instead of announcing a failure the gateway has not reported.
                  state: result.unpaidInvoice.state,
                  ...(result.unpaidInvoice.failure
                    ? { failure: result.unpaidInvoice.failure }
                    : {}),
                },
              }
            : {}),
        });
      } catch (e) {
        // The gateway wants the buyer to authenticate. Nothing was created and the
        // session is open again — the buyer completes `next_action` and re-posts
        // this route with `payment_intent`.
        if (e instanceof CheckoutActionRequiredError) {
          const view = serializePaymentIntent(e.intent);
          return reply.code(402).send({
            error: {
              type: "payment_error",
              code: "requires_action",
              message: e.message,
            },
            payment_intent: view,
            next_action: view.next_action,
          });
        }
        if (e instanceof CheckoutPaymentRefusedError) {
          await recordCheckoutPaymentAttempt(ctx, e.message);
          await countFailedPayment(clientIp(req));
          return badRequest(reply, e.message);
        }
        if (e instanceof CheckoutError) return badRequest(reply, e.message);
        // Gateway refused the token (unapproved/expired/spent) — a 400 the buyer
        // can act on, with the provider's own text kept in the log.
        if (e instanceof PaymentMethodVaultError) {
          await recordCheckoutPaymentAttempt(ctx, e.message);
          await countFailedPayment(clientIp(req));
          log.warn("checkout vault rejected by gateway", {
            event: "checkout_vault_rejected",
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

  /**
   * The live state of the invoice a completed checkout left behind.
   *
   * Exists because "the plan changed and the invoice is still open" has three
   * different meanings and only one of them is a refusal (see `collectionOutcomeFor`).
   * When the completion answers `state: 'processing'` — an async mandate debit is in
   * flight — the buyer's page polls this for a few seconds rather than announcing a
   * failure the gateway has not reported, and most of those debits settle inside that
   * window.
   *
   * Session-scoped: the invoice must belong to the session's own customer, so a public
   * checkout link cannot be turned into an invoice reader by guessing ids.
   */
  app.get("/checkout/v1/invoice", { preHandler: authenticateCheckout }, async (req, reply) => {
    const q = parseRequest(z.object({ invoice: z.string().max(LIMITS.id).min(1) }), req.query);
    if (!q.success) return badRequest(reply, q.error);
    const state = await readCheckoutInvoiceState(req.checkoutSession!, q.data.invoice);
    if (!state) return notFound(reply, "Invoice not found");
    return {
      object: "checkout_invoice",
      id: state.id,
      status: state.status,
      amount_due_minor: state.amountDueMinor,
      currency: state.currency,
      state: state.state,
      ...(state.failure ? { failure: state.failure } : {}),
    };
  });
}
