"use server";

import { NO_SESSION } from "@/lib/checkout-strings";
import {
  checkoutAddCoupon,
  checkoutRemoveCoupon,
  checkoutSetItem,
  checkoutRecordView,
  checkoutSetCustomer,
  checkoutBeginSetup,
  checkoutComplete,
  checkoutGateways,
  checkoutListPaymentMethods,
  checkoutInvoiceState,
  type CheckoutPaymentMethod,
  type CheckoutVaultSetup,
  type CheckoutConsentPost,
  type CheckoutCustomerInput,
  type CheckoutGatewayList,
  type CheckoutComplete,
  type CheckoutCompletion,
  type CheckoutActionRequired,
  type CheckoutInvoiceState,
} from "@/lib/checkout-api";
import { readStorefrontToken } from "@/lib/storefront-session";

/**
 * Hosted-checkout server actions (#10d).
 *
 * Every action reads the checkout token from the HttpOnly session cookie (W1) rather
 * than taking it as an argument from the client. Auth is still the token itself —
 * there is no operator session and no org key anywhere on this surface — but the
 * browser no longer holds it, so nothing running on the page can take it. Mirrors the
 * portal actions.
 */

/** One path for the whole surface now that the token is out of the URL. */
const CHECKOUT_PATH = "/checkout";

/** The message a buyer sees when the cookie is gone — expired, cleared, or never set. */

/** The page was shown. Best effort: a failure here must never get in the buyer's way. */
export async function checkoutRecordViewAction(
  layout: "steps" | "one_page",
  deviceClass: "mobile" | "tablet" | "desktop",
): Promise<void> {
  const token = await readStorefrontToken("checkout");
  if (!token) return;
  await checkoutRecordView(token, { layout, device_class: deviceClass }).catch(() => undefined);
}

export async function checkoutSetCustomerAction(
  input: CheckoutCustomerInput,
): Promise<{ ok: boolean; billingComplete?: boolean; error?: string }> {
  const token = await readStorefrontToken("checkout");
  if (!token) return { ok: false, error: NO_SESSION };
  const res = await checkoutSetCustomer(token, input);
  if (!res.ok || !res.data)
    return { ok: false, error: res.error ?? "We could not save your details." };
  return { ok: true, billingComplete: res.data.billing_details_complete };
}

/**
 * The gateways this buyer may pay through, and the facts the rail choice depends on.
 *
 * Read on the client after mount rather than in the page's server render: the payment
 * step only exists once billing details are saved, and a create-mode session has no
 * customer — so no currency to filter gateways by — until then.
 */
/**
 * Poll the invoice a completed checkout left behind.
 *
 * Only ever called while the completion reported `state: 'processing'` — an attempt is
 * live at the gateway and its outcome arrives by webhook. The done screen waits on this
 * for a few seconds instead of publishing the completion's snapshot as a verdict.
 */
export async function checkoutInvoiceStateAction(
  invoice: string,
): Promise<{ ok: true; invoice: CheckoutInvoiceState } | { ok: false; error: string }> {
  const token = await readStorefrontToken("checkout");
  if (!token) return { ok: false, error: NO_SESSION };
  const res = await checkoutInvoiceState(token, invoice);
  if (!res.ok || !res.data)
    return { ok: false, error: res.error ?? "We could not check the payment status." };
  return { ok: true, invoice: res.data };
}

/** The instruments the buyer already holds, for the card step's "Manage cards" panel. */
export async function checkoutPaymentMethodsAction(): Promise<
  { ok: true; methods: CheckoutPaymentMethod[] } | { ok: false; error: string }
> {
  const token = await readStorefrontToken("checkout");
  if (!token) return { ok: false, error: NO_SESSION };
  const res = await checkoutListPaymentMethods(token);
  if (!res.ok || !res.data)
    return { ok: false, error: res.error ?? "We could not load your payment methods." };
  return { ok: true, methods: res.data.data };
}

export async function checkoutGatewaysAction(): Promise<
  { ok: true; gateways: CheckoutGatewayList } | { ok: false; error: string }
> {
  const token = await readStorefrontToken("checkout");
  if (!token) return { ok: false, error: NO_SESSION };
  const res = await checkoutGateways(token);
  if (!res.ok || !res.data)
    return { ok: false, error: res.error ?? "We could not load the payment options." };
  return { ok: true, gateways: res.data };
}

/**
 * Begin an add-card flow. Returns the provider setup descriptor to the client.
 *
 * `gatewayAccount` and `methodType` are what the buyer picked. Both were absent until
 * 2026-08-27, so the API defaulted the rail to `card` and this surface could not offer
 * UPI Autopay or a netbanking e-mandate at all.
 */
export async function checkoutBeginSetupAction(
  origin: string,
  gatewayAccount?: string,
  methodType?: string,
  consent?: CheckoutConsentPost,
): Promise<{ ok: true; setup: CheckoutVaultSetup } | { ok: false; error: string }> {
  const token = await readStorefrontToken("checkout");
  if (!token) return { ok: false, error: NO_SESSION };
  const base = `${origin}${CHECKOUT_PATH}`;
  const res = await checkoutBeginSetup(
    token,
    `${base}?setup=return`,
    `${base}?setup=cancel`,
    gatewayAccount,
    methodType,
    consent,
  );
  if (!res.ok || !res.data)
    return { ok: false, error: res.error ?? "We could not start the card setup." };
  return { ok: true, setup: res.data };
}

/**
 * Complete checkout with the provider token (pm_… / approved setup token / test
 * token). `providerToken` may be omitted for a change-mode checkout that reuses
 * the card already on file — the API rejects that in create mode.
 */
export async function checkoutCompleteAction(
  /**
   * How to complete the card step: the setup intent (preferred — it is the claim the
   * gateway's webhook harvest also contends for, so the instrument is vaulted once) or
   * the raw provider token. Omitted entirely by a change-mode checkout reusing the card
   * already on file. `paymentIntent` is the second leg of an authentication challenge and
   * rides ALONGSIDE the instrument — see `CheckoutCompletion`.
   */
  completion: CheckoutCompletion = {},
  /**
   * The gateway the buyer picked, so the raw token is exchanged on the SAME account the
   * setup ran on. Masked whenever a setup intent is present (the intent already names its
   * gateway), which is why its absence stayed invisible: it only bites a provider with no
   * setup intent, and there it is a silent vault failure. The portal has always passed it.
   */
  gatewayAccount?: string,
  /**
   * `window.location.origin`, so the engine can tell a redirect-mode gateway where to send
   * the buyer back — `/checkout?pay=return`, the charge-side twin of the `?setup=return`
   * the vault leg already uses.
   *
   * Passed in rather than read here: a server action has no window, and the checkout is
   * served from whatever host the merchant's link used. Same argument, same reason, as
   * `checkoutBeginSetupAction`.
   *
   * OMITTED by a caller that cannot receive the buyer back (see `usePaymentChallenge`'s
   * new-tab fallback), and then no `return_url` is sent at all.
   */
  origin?: string,
): Promise<{
  ok: boolean;
  subscriptionId?: string;
  /** A purchase's paid invoice. */
  invoiceId?: string;
  error?: string;
  /**
   * Carried through even on success, because it IS the success case: the plan changed and
   * its invoice did not collect. Dropping it here is how the buyer got a green "Plan
   * updated" over a parked invoice.
   */
  unpaidInvoice?: CheckoutComplete["unpaid_invoice"];
  /** Same for a signup whose capture was refused after the subscription existed. */
  paymentError?: CheckoutComplete["payment_error"];
  /**
   * The gateway wants the buyer to authenticate (402). NOT a failure: nothing was
   * created, the session is open again, and the caller puts `nextAction` in front of the
   * buyer and then re-posts this same completion with `paymentIntent`.
   */
  actionRequired?: CheckoutActionRequired;
  /** The engine asks for a Turnstile check before it takes this payment. */
  botCheck?: boolean;
}> {
  const token = await readStorefrontToken("checkout");
  if (!token) return { ok: false, error: NO_SESSION };
  const base = origin ? `${origin}${CHECKOUT_PATH}` : null;
  const res = await checkoutComplete(
    token,
    completion,
    gatewayAccount,
    base ? { returnUrl: `${base}?pay=return`, cancelUrl: `${base}?pay=cancel` } : undefined,
  );
  if (!res.ok) {
    return {
      ok: false,
      error: res.error,
      ...(res.actionRequired ? { actionRequired: res.actionRequired } : {}),
      ...("botCheck" in res && res.botCheck ? { botCheck: true } : {}),
    };
  }
  return {
    ok: true,
    ...(res.data.subscription_id ? { subscriptionId: res.data.subscription_id } : {}),
    ...(res.data.invoice_id ? { invoiceId: res.data.invoice_id } : {}),
    ...(res.data.unpaid_invoice ? { unpaidInvoice: res.data.unpaid_invoice } : {}),
    ...(res.data.payment_error ? { paymentError: res.data.payment_error } : {}),
  };
}

/**
 * The buyer's own coupon box (0238) — apply and remove.
 *
 * Both return the RE-PRICED view rather than `{ok: true}`: the only reason to type a code is
 * to see the new total, and handing the caller the view means the page never renders a stale
 * one between the write and a refetch.
 *
 * The engine's own sentence is passed straight through on failure ("No such coupon: FOO",
 * "Coupon BAR has expired"). A buyer has no operator to ask and no log to read, so a
 * generic "could not apply" would leave them with nothing to act on.
 */
export async function checkoutApplyCouponAction(
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  const token = await readStorefrontToken("checkout");
  if (!token) return { ok: false, error: NO_SESSION };
  const res = await checkoutAddCoupon(token, code);
  if (!res.ok) return { ok: false, error: res.error ?? "We could not apply that code." };
  return { ok: true };
}

export async function checkoutRemoveCouponAction(
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  const token = await readStorefrontToken("checkout");
  if (!token) return { ok: false, error: NO_SESSION };
  const res = await checkoutRemoveCoupon(token, code);
  if (!res.ok) return { ok: false, error: res.error ?? "We could not remove that code." };
  return { ok: true };
}

/** The buyer changes a line of a payment-link checkout; the page re-reads the total after. */
export async function checkoutSetItemAction(
  price: string,
  quantity: number,
): Promise<{ ok: boolean; error?: string }> {
  const token = await readStorefrontToken("checkout");
  if (!token) return { ok: false, error: NO_SESSION };
  const res = await checkoutSetItem(token, price, quantity);
  if (!res.ok) return { ok: false, error: res.error ?? "We could not change your order." };
  return { ok: true };
}
