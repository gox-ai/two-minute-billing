// Begin an add-card flow — and RECORD it as a zero-amount `setup` payment intent.
//
// Why this file exists: three routes (hosted checkout, customer portal, the
// operator add-card API) each began a vault setup and returned a bare
// `setup_token` + challenge. Nothing recorded that a buyer had been sent to a
// gateway, so `payment_intents` held only real payments — no zero-amount setup
// intent per add-card, and no attempts under it. Routing
// the same gateway call through `createPaymentIntent({ purpose: 'setup' })` gives
// us that row and its attempt; the adapters were refactored so both entry points
// make the SAME underlying gateway call, so the request bytes are unchanged.
//
// ── The two blockers that used to force the legacy path (both now gone) ────────
//  1. A PINNED gateway account. The portal/checkout let the buyer choose which
//     gateway to add a card through, and the completion step vaults on that same
//     account; `createPaymentIntent` used to route `setup` straight through
//     `selectGatewayAccount` with no override. `CreatePaymentIntentInput.gatewayAccountId`
//     now pins it, validated the way the consume path validates the account it
//     captures on (business-owned, active, livemode-matched).
//  2. RAZORPAY's mandate ceiling. A RazorPay mandate carries a per-debit ceiling
//     (`deriveMandateCeiling`), and the engine hard-zeroes a setup intent's amount —
//     which used to be the field the adapter read as that ceiling, so the mandate
//     silently fell back to ₹10,000. The adapter now reads
//     `CreateIntentInput.maxAmountMinor`, the engine carries it, and 0174 PERSISTS it
//     so a retry re-registers with the same number instead of the default.
//
// ── What still falls back, and why ────────────────────────────────────────────
//  • `legacyProviderKey` — the operator API's `provider` param names an ENV-configured
//    provider, which has NO `gateway_accounts` row. The intent engine knows only
//    gateway accounts, so there is nothing to pin. Kept as-is: the intent path is taken
//    only when the router independently lands on an account of that same gateway.
//  • No resolvable currency (customer and business both without one). A mandate is
//    registered in a currency and `createPaymentIntent` requires one; the legacy call
//    tolerates its absence.
//  • The gateway cannot represent setup intents at all, or returns one with no buyer
//    challenge. The legacy call is the same gateway request and still works, so
//    add-card keeps working rather than handing back a half-usable response.
//
// The response is identical either way — `intent` is simply absent when the legacy
// path was taken.
//
// ⚠️ The preconditions (gateway active, RazorPay contact, both method-type allow-lists,
// and settlement reachability on a live async-settlement account) are checked HERE too,
// because the intent path no longer goes through `initiateVaultSetupForBusiness` and a
// buyer must get the same actionable 400 on either path — not a gateway 500. They are
// one SHARED function (`assertVaultPreconditions`), not a copy of that list: the copy
// that used to live here was missing the settlement check, which is the only one of the
// four with real money behind it.

import { withTenant } from "@/platform/db";
import { selectGatewayAccount, GatewayRouterError } from "@/modules/gateway/router";
import {
  resolveDefaultAccountForBusiness,
  getGatewayAccount,
  type GatewayAccount,
} from "@/modules/gateway/service";
import {
  assertVaultPreconditions,
  initiateVaultSetup,
  initiateVaultSetupForBusiness,
  listPaymentMethods,
  PaymentMethodConfigError,
} from "@/modules/payment-methods/service";
// The ceiling is a billing PROJECTION (the next renewal's tax-inclusive total plus
// headroom), so it is sized by the estimator rather than by a price-column sum — see
// the note where it used to live in payment-methods/service.ts.
import { deriveMandateCeiling } from "@/modules/subscriptions/estimate";
import {
  createPaymentIntent,
  getPaymentIntent,
  applyClientResult,
  authorizePaymentIntent,
  consumePaymentIntent,
  PaymentIntentError,
  PaymentIntentConflictError,
  type PaymentIntent,
} from "@/modules/payment-intents/service";
import { getCustomerById, resolveCustomerCurrency } from "@/modules/customers/service";
import { accountHolderName } from "@/modules/customers/names";
import {
  achAuthorizationEvidence,
  achAuthorizationText,
  type AchAuthorizationAcceptance,
  type AchAuthorizationParties,
  type AchAuthorizationText,
} from "@/modules/payment-methods/ach-authorization";
import {
  achAuthorizationIsOurs,
  gatewayAllowsPurpose,
  gatewayDefinition,
} from "@/providers/gateway-catalog";
import { createLogger } from "@/platform/logger";
import {
  ProviderRefusalError,
  type BuyerAuthorization,
  type VaultSetupRef,
} from "@/providers/types";
import { businesses, type customers, type paymentMethods } from "@db/schema";
import { eq } from "drizzle-orm";

const log = createLogger("vault-setup");

/** The longest a buyer's add-card waits for another completer that holds the intent. */
const CLAIMED_ELSEWHERE_WAIT_MS = 10_000;

type Customer = typeof customers.$inferSelect;

export interface VaultSetupOutcome {
  /** Gateway the buyer is being sent to (`stripe` / `razorpay` / `paypal`). */
  providerKey: string;
  /** The setup-token ref + the buyer's challenge, exactly as the routes returned before. */
  setup: VaultSetupRef;
  /** The `payment_intents` row this add-card was recorded as, when it could be. */
  intent?: PaymentIntent;
}

export interface BeginVaultSetupInput {
  organizationId: string;
  businessId: string;
  customer: Customer;
  returnUrl: string;
  cancelUrl: string;
  /** Buyer's gateway pick (`gwa_…`) — portal/checkout only. */
  gatewayAccountId?: string;
  /**
   * The operator API's explicit `provider` param, which selects an ENV-configured
   * provider rather than a `gateway_accounts` row (legacy, test-mode only). The
   * intent engine only knows gateway accounts, so this is honoured by the legacy
   * call unless the router independently lands on an account of the same gateway.
   */
  legacyProviderKey?: string;
  methodTypes?: string[];
  /**
   * Per-debit ceiling to register, in minor units of the resolved currency — overriding
   * the derivation from the customer's CURRENT subscriptions.
   *
   * For the one caller that legitimately knows better: a change-mode checkout, where the
   * mandate has to carry the plan the buyer is moving to. Deriving from live
   * subscriptions there registers a ceiling sized for the plan they are leaving, and the
   * proration invoice that follows is refused by the mandate the buyer just authorised.
   */
  maxAmountMinor?: bigint;
  /**
   * The currency the mandate is for, when the caller knows it (a checkout session bills in
   * its plan's currency). Absent: the customer's, else the business default.
   */
  currency?: string;
  /** The registration also collects this first payment, where the gateway can (create-mode checkout). */
  firstChargeMinor?: bigint;
}

/**
 * The currency a mandate registered now would be debited in.
 *
 * `customers.currency` is usually null, so this used to fall straight to the BUSINESS
 * default — which on a multi-currency business registers the mandate in a currency the
 * buyer owes nothing in. Measured 2026-08-14: an INR customer on a USD-default business
 * was shown "US$1 now, up to US$1,000/month" by RazorPay Checkout on an INR-only
 * account, and the ceiling fell to the currency-blind constant because
 * `deriveMandateCeiling` filters prices by this currency and found no USD subscriptions.
 *
 * `resolveCustomerCurrency` consults the customer's live subscriptions in between, which
 * is what the portal's gateway list and `effective_currency` already do.
 */
async function resolveCurrency(input: BeginVaultSetupInput): Promise<string | undefined> {
  if (input.currency) return input.currency.toUpperCase();
  const fromCustomer = await resolveCustomerCurrency(input.organizationId, input.customer);
  if (fromCustomer) return fromCustomer;
  const [biz] = await withTenant(input.organizationId, (tx) =>
    tx
      .select({ cur: businesses.defaultCurrency })
      .from(businesses)
      .where(eq(businesses.id, input.businessId))
      .limit(1),
  );
  return biz?.cur ?? undefined;
}

/**
 * The gateway account the intent will be PINNED to — the buyer's own pick, else the
 * business default, resolved exactly as `initiateVaultSetupForBusiness` resolves it so
 * both paths land on the same account.
 *
 * Returns null when the intent path cannot be taken at all; the legacy call then runs
 * and raises its own (better-worded) error for a missing or disabled account.
 */
async function intentAccount(
  input: BeginVaultSetupInput,
  currency: string | undefined,
): Promise<GatewayAccount | null> {
  if (input.legacyProviderKey) {
    // An ENV-configured provider has no `gateway_accounts` row, so there is nothing to
    // pin. Take the intent path only when the router independently lands on an account
    // of that same gateway — otherwise the legacy call is the only thing that can honour
    // the caller's explicit `provider`.
    if (!currency) return null;
    try {
      const routed = await withTenant(input.organizationId, (tx) =>
        selectGatewayAccount(tx, {
          businessId: input.businessId,
          currency,
          methodType: input.methodTypes?.[0] ?? "card",
          purpose: "setup",
        }),
      );
      return routed.gatewayKey === input.legacyProviderKey ? routed : null;
    } catch (e) {
      // No account handles this currency/method, or the choice is ambiguous. The
      // caller turns this into a 4xx, which the global handler does not log — so the
      // reason a vault could not start lives here or nowhere.
      log.debug("no gateway account resolved for vault setup", {
        currency,
        methodType: input.methodTypes?.[0] ?? "card",
        error: (e as Error)?.message,
      });
      return null;
    }
  }
  const acc = input.gatewayAccountId
    ? await getGatewayAccount(input.organizationId, input.businessId, input.gatewayAccountId)
    : await resolveDefaultAccountForBusiness(input.organizationId, input.businessId, currency);
  // A missing/disabled account is the legacy path's error to raise, by name.
  return acc && acc.status === "active" ? acc : null;
}

/**
 * The preconditions an add-card must satisfy, applied to the intent path.
 *
 * This used to be a HAND-COPIED subset of `initiateVaultSetupForBusiness`'s list —
 * gateway active, RazorPay contact, method-type allow-list — and the copy was missing
 * the fourth: `assertSettlementReachable`, which refuses to register a mandate on a LIVE
 * async-settlement account that has no webhook endpoint. That is the check with real
 * money behind it (the buyer authorizes, the gateway debits, and nothing ever marks an
 * invoice paid), and it therefore only ever ran on the LEGACY path — while both buyer
 * surfaces, portal and hosted checkout, take THIS one. There is now one list, in
 * `payment-methods/service.ts`, and this is a call into it rather than a copy of it.
 *
 * Returns the method types to actually request: the caller's, or the account's own
 * allow-list when the caller named none.
 */
function assertVaultable(
  acc: GatewayAccount,
  input: BeginVaultSetupInput,
): Promise<string[] | undefined> {
  return assertVaultPreconditions({
    account: acc,
    customer: input.customer,
    ...(input.methodTypes ? { methodTypes: input.methodTypes } : {}),
  });
}

export async function beginVaultSetup(input: BeginVaultSetupInput): Promise<VaultSetupOutcome> {
  const currency = await resolveCurrency(input);
  const acc = await intentAccount(input, currency);
  // A gateway that saves methods in other currencies only (Cashfree mandates are INR) is
  // refused by name, before a mandate is opened in the wrong currency.
  if (acc && currency && !gatewayAllowsPurpose(acc.gatewayKey, "setup", currency))
    throw new GatewayRouterError(
      "no_gateway_for_currency",
      `${gatewayDefinition(acc.gatewayKey)?.displayName ?? acc.gatewayKey} cannot save a payment method in ${currency}. Select another payment provider.`,
    );

  /**
   * The per-debit ceiling of the mandate this add-card registers, derived ONCE for both
   * paths below.
   *
   * It used to be derived inside each of them, which is how they could disagree: the
   * legacy call resolved its own currency (customer → business, without consulting live
   * subscriptions) and derived against that, so the same buyer could be sent to the
   * gateway with a different ceiling depending on which path served them. Deriving here
   * — and passing this currency down with it — makes that impossible.
   *
   * `input.maxAmountMinor` wins when the caller knows better than the customer's current
   * subscriptions do: a change-mode checkout is registering a mandate for the plan the
   * buyer is MOVING TO, which the derivation cannot see until the change is applied.
   */
  const maxAmountMinor = currency
    ? (input.maxAmountMinor ??
      (await deriveMandateCeiling(
        input.organizationId,
        input.businessId,
        input.customer.id,
        currency,
      )))
    : undefined;

  if (acc && currency) {
    try {
      const methodTypes = await assertVaultable(acc, input);
      const { intent } = await createPaymentIntent({
        organizationId: input.organizationId,
        businessId: input.businessId,
        purpose: "setup",
        customerPublicId: input.customer.publicId,
        currency,
        // The buyer's own gateway pick (or the business default) — never re-routed.
        gatewayAccountId: acc.publicId,
        ...(maxAmountMinor != null ? { maxAmountMinor: Number(maxAmountMinor) } : {}),
        ...(input.firstChargeMinor ? { firstChargeMinor: Number(input.firstChargeMinor) } : {}),
        returnUrl: input.returnUrl,
        cancelUrl: input.cancelUrl,
        session: "on_session", // an add-card is by definition a buyer at a keyboard
        ...(methodTypes ? { methodTypes } : {}),
      });
      const authorization = intent.nextAction as BuyerAuthorization | null;
      if (intent.intentAtGateway && authorization?.mode) {
        return {
          providerKey: acc.gatewayKey,
          setup: { setupTokenId: intent.intentAtGateway, ...authorization },
          intent,
        };
      }
      // A setup intent with no challenge is not something a buyer can complete;
      // rather than hand back a half-usable response, fall through to the legacy
      // call (which is the same gateway request) and keep the flow working.
      log.error(
        "setup intent came back with no buyer authorization — falling back to the direct vault setup",
        {
          event: "setup_intent_unauthorized",
          intent: intent.publicId,
        },
      );
    } catch (e) {
      // A misconfiguration is the caller's to fix and must NOT be papered over by a
      // second attempt down another path — the legacy call would raise the same error
      // one step later. Anything else (a gateway that cannot represent setup intents,
      // an engine-side refusal) must not break add-card.
      if (e instanceof PaymentMethodConfigError) throw e;
      // A ROUTING refusal is the same kind of answer, and it arrives here now that
      // `resolvePinnedAccount` re-enters the router: a buyer-supplied `gateway_account`
      // that cannot handle this currency or method is refused BY NAME. Swallowing it
      // sent the buyer down the legacy path to a worse-worded failure one gateway
      // round-trip later — the exact outcome this file's own docstring promises against
      // ("the same actionable 400 on either path — not a gateway 500"). Both buyer
      // routes already map `GatewayRouterError` to a 400.
      if (e instanceof GatewayRouterError) throw e;
      // The gateway refused this request: the legacy path would send it again and be refused again.
      if (e instanceof ProviderRefusalError) throw e;
      log.error(e, { event: "setup_intent_record_failed", fallback: "direct_vault_setup" });
    }
  }

  if (input.legacyProviderKey) {
    const setup = await initiateVaultSetup({
      organizationId: input.organizationId,
      customer: input.customer,
      provider: input.legacyProviderKey,
      returnUrl: input.returnUrl,
      cancelUrl: input.cancelUrl,
    });
    return { providerKey: input.legacyProviderKey, setup };
  }
  const { setup, providerKey } = await initiateVaultSetupForBusiness({
    organizationId: input.organizationId,
    businessId: input.businessId,
    customer: input.customer,
    returnUrl: input.returnUrl,
    cancelUrl: input.cancelUrl,
    // Both resolved above, and both passed: the ceiling is denominated in this currency,
    // so letting the callee re-resolve the currency on its own could bind an INR mandate
    // to a ceiling sized for USD.
    ...(currency ? { currency } : {}),
    ...(maxAmountMinor != null ? { maxAmountMinor } : {}),
    ...(input.gatewayAccountId ? { gatewayAccountId: input.gatewayAccountId } : {}),
    ...(input.methodTypes ? { methodTypes: input.methodTypes } : {}),
  });
  return { providerKey, setup };
}

/** The `vault_setup` response body all three add-card routes return. */
export function serializeVaultSetup(outcome: VaultSetupOutcome) {
  const { setup, intent } = outcome;
  return {
    object: "vault_setup",
    provider: outcome.providerKey,
    setup_token: setup.setupTokenId,
    mode: setup.mode,
    ...(setup.approvalUrl ? { approval_url: setup.approvalUrl } : {}),
    ...(setup.checkout ? { checkout: setup.checkout } : {}),
    ...(setup.clientSecret ? { client_secret: setup.clientSecret } : {}),
    ...(setup.publishableKey ? { publishable_key: setup.publishableKey } : {}),
    ...(setup.sdk ? { sdk: setup.sdk } : {}),
    ...(setup.formPost ? { form_post: setup.formPost } : {}),
    // ADDITIVE. Every field above is unchanged; these two are what make an
    // add-card visible as a payment intent (and give the client one descriptor to
    // render the challenge from, whatever the gateway).
    ...(intent ? { payment_intent: intent.publicId, next_action: intent.nextAction ?? null } : {}),
  };
}

// ── The COMPLETE half ────────────────────────────────────────────────────────

/**
 * A completion that cannot be honoured. `status` is what the route replies with:
 * 404 for an intent that does not exist, 400 for one that exists and cannot finish
 * this add-card (another customer's, not a `setup`, or a challenge genuinely
 * unfinished).
 */
export class VaultSetupIntentError extends Error {
  readonly status: 400 | 404;
  /** The provider/engine's own words, for the log rather than the buyer. */
  readonly detail: string | null;
  constructor(message: string, status: 400 | 404, detail: string | null = null) {
    super(message);
    this.name = "VaultSetupIntentError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Finish an add-card by CONSUMING the setup intent it began, rather than by handing
 * the provider's token to `vaultPaymentMethod`.
 *
 * ── Why this exists at all ───────────────────────────────────────────────────
 * The same instrument is also vaulted by `harvestSetupIntent`
 * (`modules/webhooks/inbound.ts`) when the gateway's `authorized` webhook lands —
 * that exists for the buyer who approves and never comes back, and it is safe against
 * the buyer's own completion only because `consumePaymentIntent`'s
 * `authorized -> consumed` transition is an atomic claim. Handing the raw token to
 * `vaultPaymentMethod` skips the claim, so both sides wrote: measured 2026-08-21,
 * one RazorPay UPI mandate produced two `payment_methods` rows 15
 * seconds apart and the portal listed one mandate twice.
 *
 * Lives HERE, beside `beginVaultSetup`, because the same two buyer surfaces (portal and
 * hosted checkout) share both halves — and one of them having its own copy of this
 * reasoning is how the halves drift apart.
 *
 * ── Why authorizing on the client's word is safe ─────────────────────────────
 * Only for `setup`. The buyer has just finished the challenge in the gateway's UI, and
 * the intent reaches `authorized` on its own only if the webhook beat them back here —
 * usually it has not. The consume that follows reads the outcome from the GATEWAY
 * (RazorPay resolves the order, finds the authorized payment on it, and refuses when
 * there is none), so a client that lies gets an error, not a payment method. A
 * `payment` intent is refused outright: capturing money into an invoice is the collect
 * route's job, and it names the invoice.
 */
export async function completeVaultFromIntent(input: {
  organizationId: string;
  businessId: string;
  /** The customer the caller is authorized to act for. The intent must match it. */
  customerId: string;
  /** `pi_…` from the setup response. */
  paymentIntentPublicId: string;
  /** What the buyer's browser SDK returned for a `mode: 'sdk'` setup. */
  clientResult?: Record<string, string>;
  /** The buyer accepted our ACH authorization text (`achAuthorization: "ours"` gateways). */
  achAuthorization?: AchAuthorizationAcceptance;
}): Promise<typeof paymentMethods.$inferSelect> {
  const piId = input.paymentIntentPublicId;
  // Rendered before the gateway call, so a stale text version is refused with nothing saved.
  const achEvidence = input.achAuthorization
    ? achAuthorizationEvidence(
        input.achAuthorization,
        await achAuthorizationParties(input.organizationId, input.businessId, input.customerId),
      )
    : undefined;
  const intent = await getPaymentIntent(input.organizationId, input.businessId, piId);
  if (!intent) throw new VaultSetupIntentError(`No such payment intent: ${piId}`, 404);
  // An intent that belongs to someone else must never mint an instrument on this
  // customer — the same guard the collect route makes, and it matters more on a buyer
  // surface because the caller IS the buyer.
  if (intent.customerId && intent.customerId !== input.customerId) {
    throw new VaultSetupIntentError(`Payment intent ${piId} belongs to a different customer`, 400);
  }
  if (intent.purpose !== "setup") {
    throw new VaultSetupIntentError(
      `Payment intent ${piId} is not an add-card (purpose=${intent.purpose})`,
      400,
    );
  }

  let row: typeof paymentMethods.$inferSelect | null = null;
  let refusal: string | null = null;
  try {
    // A browser result is the authorization itself on nonce gateways, so it goes first;
    // on success the intent is `authorized` and the self-authorize below is skipped.
    const applied = input.clientResult
      ? await applyClientResult(input.organizationId, input.businessId, piId, input.clientResult)
      : null;
    if (applied?.outcome === "failed" || applied?.outcome === "pending")
      throw new VaultSetupIntentError(
        applied.outcome === "failed"
          ? `We could not save this payment method. ${applied.failure!.message}`
          : "The gateway did not confirm this payment method yet. Try again in a few minutes.",
        400,
        applied.failure?.code ?? null,
      );
    if (!applied && (intent.status === "in_progress" || intent.status === "requires_action")) {
      await authorizePaymentIntent(input.organizationId, input.businessId, piId);
    }
    const consumed =
      intent.status === "consumed"
        ? null
        : await consumePaymentIntent(
            input.organizationId,
            input.businessId,
            piId,
            undefined,
            achEvidence ? { achAuthorization: achEvidence } : undefined,
          );
    row = consumed?.paymentMethod ?? null;
  } catch (e) {
    // Lost the claim to the webhook harvest, or it finished between our read and our
    // consume ("Intent already consumed"). Either way the instrument IS recorded, which
    // is the outcome this function exists to produce — resolve the row the intent names
    // instead of calling it a failure.
    if (!(e instanceof PaymentIntentConflictError || e instanceof PaymentIntentError)) throw e;
    refusal = (e as Error).message;
  }
  // Consumed with no method yet = another completer holds the claim and is still working.
  let claimedElsewhere = false;
  const rowTheIntentNames = async (): Promise<typeof paymentMethods.$inferSelect | null> => {
    const fresh = await getPaymentIntent(input.organizationId, input.businessId, piId);
    claimedElsewhere = fresh?.status === "consumed" && !fresh.paymentMethodId;
    if (!fresh?.paymentMethodId) return null;
    const methods = await listPaymentMethods(input.organizationId, input.customerId);
    return methods.find((m) => m.id === fresh.paymentMethodId) ?? null;
  };
  if (!row) row = await rowTheIntentNames();
  /*
   * Nothing yet — so WAIT briefly before calling a saved card a failure.
   *
   * The other completer (the gateway's own webhook harvesting the same intent) claims
   * the intent FIRST and writes `payment_method_id` LAST, with a gateway round-trip in
   * between: measured 2026-08-21 on a Stripe sandbox with a live tunnel, ~400ms between
   * the payment-method row and the intent's final update, and up to ~800ms from the
   * claim. A single read lands inside that window routinely — `setup_intent.succeeded`
   * beat the buyer's own browser on SIX consecutive 3DS add-card attempts (`audit_logs`
   * attributes them to `actor=system`, the buyer's leg only to `psess_…`). Every one of
   * those cards WAS vaulted while the buyer was told "we could not confirm that payment
   * method", so they added it again — which is how one card becomes four.
   *
   * NOT gated on having lost the claim, and that was the first fix's bug: when our very
   * first read ALREADY sees `consumed`, the consume above is skipped and no error is
   * raised, so `refusal` is null on exactly the path that needs the wait most. The three
   * ways another writer can be in flight — we lost the claim, the intent was already
   * consumed, or it was consumed between our two reads — are indistinguishable here and
   * all resolve the same way, so this waits on all of them.
   *
   * Bounded at ~2s because it runs inside the buyer's request. It also covers the
   * RazorPay/PayPal return legs, where the same harvest race exists; a genuinely
   * unfinished challenge just pays 2s before the honest error below.
   *
   * While the intent stays consumed with no method, the other completer is still at work,
   * so the wait extends to ~10s. A Mollie webhook makes 5 API calls before it writes the
   * method (measured ~7s from India).
   */
  if (!row) {
    const started = Date.now();
    for (let attempt = 0; !row; attempt++) {
      const waited = Date.now() - started;
      if (attempt >= 8 && !(claimedElsewhere && waited < CLAIMED_ELSEWHERE_WAIT_MS)) break;
      await new Promise((resolve) => setTimeout(resolve, attempt < 8 ? 250 : 500));
      row = await rowTheIntentNames();
    }
    if (row)
      log.info("add-card resolved after waiting for a concurrent completer", {
        intent: piId,
        refusal,
      });
  }
  if (!row) {
    // The intent produced nothing and names nothing: a genuinely unfinished challenge —
    // expired, abandoned, or a gateway that has not authorized yet. Actionable words for
    // the buyer; the engine's own reason goes to the caller's log via `detail`.
    log.warn("add-card could not be completed from its setup intent", { intent: piId, refusal });
    throw new VaultSetupIntentError(
      "We could not confirm that payment method yet. If your bank or UPI app is still " +
        "processing the approval, wait a moment and refresh the page. If not, try again.",
      400,
      refusal,
    );
  }
  return row;
}

/** Who the ACH authorization names: the business, its contact address and the payer. */
export async function achAuthorizationParties(
  organizationId: string,
  businessId: string,
  customerId: string,
): Promise<AchAuthorizationParties> {
  const [biz] = await withTenant(organizationId, (tx) =>
    tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1),
  );
  const customer = await getCustomerById(organizationId, customerId);
  return {
    businessName: biz?.name ?? "",
    businessEmail: biz?.supportEmail ?? biz?.contactEmail ?? null,
    payerName: (customer ? accountHolderName(customer) : null) ?? "",
    payerEmail: customer?.email ?? null,
  };
}

/**
 * The text a storefront shows before a bank account is saved on this gateway, or null when
 * the gateway shows its own (or offers no ACH debit).
 */
export async function achAuthorizationTextFor(
  gatewayKey: string,
  methodTypes: readonly string[],
  parties: () => Promise<AchAuthorizationParties>,
): Promise<AchAuthorizationText | null> {
  if (!achAuthorizationIsOurs(gatewayKey) || !methodTypes.includes("us_bank_account")) return null;
  return achAuthorizationText(await parties());
}
