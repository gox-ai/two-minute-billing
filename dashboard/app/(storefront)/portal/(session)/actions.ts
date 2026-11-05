"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  portalApplyCoupon,
  portalRemoveCoupon,
  portalSkipRenewal,
  portalChangeOptions,
  portalChangePreview,
  portalChangeApply,
  portalCancelScheduledChange,
  type PortalChangeOptions,
  type PortalChangePreview,
  type PortalChangeRequest,
  type PortalChangeResult,
  portalSubscriptionLifecycle,
  portalCancelFlow,
  portalTakeRetentionOffer,
  type PortalCancelFlow,
  type PortalRetentionOffer,
  type PortalLifecycleAction,
  portalBeginSetup,
  portalCompleteVault,
  portalRemove,
  portalSetDefault,
  portalSetRole,
  portalUpdateMe,
  portalCollectInvoice,
  portalGetInvoice,
  portalAbandonAuthentication,
  portalLogout,
  portalListGateways,
  portalPayRequest,
  portalCreateShippingAddress,
  portalUpdateShippingAddress,
  portalArchiveShippingAddress,
  portalSetSubscriptionShipTo,
  type PortalShippingAddressInput,
  type PortalGateway,
  type PortalVaultSetup,
  type PortalInvoice,
  type PortalInvoiceCollection,
  type PortalAuthenticationAbandoned,
  portalLoginRequest,
  portalLoginVerify,
} from "@/lib/portal-api";
import {
  readStorefrontToken,
  clearStorefrontToken,
  rememberPortalBusiness,
  setStorefrontToken,
} from "@/lib/storefront-session";
import { actionOk, actionError } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-result";

/**
 * Buyer-portal server actions (P14).
 *
 * Every action reads the portal token from the HttpOnly session cookie (W1). It used
 * to arrive as a hidden `token` form field or a first argument from a client
 * component, which meant the credential was in the rendered HTML and reachable from
 * page script. Now it is not: the browser never holds it, so an injection on this
 * surface has nothing to take. Auth is still the token itself — there is no operator
 * session and no org key anywhere here.
 */

/** One path for the whole surface now that the token is out of the URL. */
const PORTAL_PATH = "/portal";

/** The message a buyer sees when the cookie is gone — expired, cleared, or never set. */
const NO_SESSION = "Your billing session is expired. Ask for a new link.";

export async function portalSetDefaultAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const token = await readStorefrontToken("portal");
  const pm = String(formData.get("pm") ?? "");
  if (!token) return actionError(NO_SESSION);
  if (!pm) return actionError("The payment method ID is missing. Reload the page.");
  const res = await portalSetDefault(token, pm);
  revalidatePath(PORTAL_PATH);
  // The function names keep `Default` because that is the API route they call
  // (`…/payment_methods/:pm/default`); the buyer-facing word is `primary` everywhere.
  return res.ok
    ? actionOk("Primary payment method changed")
    : actionError(res.error ?? "We could not change your primary payment method.");
}

/**
 * Designate the BACKUP — the instrument collection falls back to before dunning begins.
 *
 * The portal had no way to set this. A buyer could see which card pays first and change
 * it, but the second slot was operator-only, invisible, and could be emptied by accident:
 * promoting the backup used to demote the old primary to no role at all. Both halves are
 * fixed together — `assignPaymentMethodRole` now SWAPS the two, and this is the control
 * that lets the person who owns the cards fill the slot in the first place.
 */
export async function portalSetBackupAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const token = await readStorefrontToken("portal");
  const pm = String(formData.get("pm") ?? "");
  if (!token) return actionError(NO_SESSION);
  if (!pm) return actionError("The payment method ID is missing. Reload the page.");
  const res = await portalSetRole(token, pm, "backup");
  revalidatePath(PORTAL_PATH);
  return res.ok
    ? actionOk("Backup payment method changed")
    : actionError(res.error ?? "We could not change your backup payment method.");
}

/** Take a backup out of automatic collection; the card stays saved. */
export async function portalRemoveBackupAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const token = await readStorefrontToken("portal");
  const pm = String(formData.get("pm") ?? "");
  if (!token) return actionError(NO_SESSION);
  if (!pm) return actionError("The payment method ID is missing. Reload the page.");
  const res = await portalSetRole(token, pm, "none");
  revalidatePath(PORTAL_PATH);
  return res.ok
    ? actionOk("Backup removed")
    : actionError(res.error ?? "We could not remove the backup payment method.");
}

export async function portalRemoveAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const token = await readStorefrontToken("portal");
  const pm = String(formData.get("pm") ?? "");
  if (!token) return actionError(NO_SESSION);
  if (!pm) return actionError("The payment method ID is missing. Reload the page.");
  const res = await portalRemove(token, pm);
  revalidatePath(PORTAL_PATH);
  return res.ok
    ? actionOk("Payment method removed")
    : actionError(res.error ?? "We could not remove the payment method.");
}

/**
 * End the buyer's session (F-22 / portal logout).
 *
 * Revoking at the engine is best-effort — `.catch` swallows it, because a buyer
 * choosing to sign out on a slow network must not be stuck mid-click waiting on a
 * remote call. The cookie is always cleared regardless, since that half is entirely
 * ours to guarantee. Redirects to `?signed_out=1` rather than the bare path so the
 * landing page can tell an intentional sign-out apart from a genuinely expired link
 * (see `ExpiredCard` / `SignedOutCard` in page.tsx) — same empty state underneath,
 * different word for why it's empty.
 */
export async function portalLogoutAction(): Promise<void> {
  const token = await readStorefrontToken("portal");
  const res = token ? await portalLogout(token).catch(() => null) : null;
  await clearStorefrontToken("portal");
  // The operator's `redirect_url` from mint, when the link carried one.
  const back = res?.ok ? res.data?.redirect_url : undefined;
  redirect(back && /^https?:\/\//i.test(back) ? back : `${PORTAL_PATH}?signed_out=1`);
}

/** Begin an add-card flow. Returns the provider setup descriptor to the client component. */
export async function portalBeginSetupAction(
  origin: string,
  gatewayAccount?: string,
  methodType?: string,
): Promise<{ ok: true; setup: PortalVaultSetup } | { ok: false; error: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: NO_SESSION };
  const base = `${origin}${PORTAL_PATH}`;
  const res = await portalBeginSetup(
    token,
    `${base}?setup=return`,
    `${base}?setup=cancel`,
    gatewayAccount,
    methodType,
  );
  if (!res.ok || !res.data)
    return { ok: false, error: res.error ?? "We could not start the card setup." };
  return { ok: true, setup: res.data };
}

/** Complete an add-card flow with the provider token (pm_… / approved setup token / test token). */
export async function portalCompleteVaultAction(
  /**
   * How to complete: the setup intent (preferred — it is the claim the gateway's webhook
   * harvest also contends for, so the instrument is vaulted once) or, for a provider
   * with no intent, the raw provider token.
   */
  completion: {
    paymentIntent?: string;
    providerToken?: string;
    clientResult?: Record<string, string>;
    achAuthorizationVersion?: string;
  },
  gatewayAccount?: string,
): Promise<{ ok: boolean; error?: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: NO_SESSION };
  if (!(completion.paymentIntent ?? completion.providerToken)) {
    return { ok: false, error: "We could not save your card. Try again." };
  }
  const res = await portalCompleteVault(token, completion, gatewayAccount);
  revalidatePath(PORTAL_PATH);
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? "We could not save your card." };
}

/**
 * "Pay now" on one invoice. Thin passthrough: the CHALLENGE is handled client-side by
 * the same code the add-card flow uses, so this only carries the two legs.
 */
export async function portalPayInvoiceAction(
  invoice: string,
  origin: string,
  paymentIntent?: string,
  /** gwa_… — the provider the buyer picked, when more than one can take this invoice. */
  gatewayAccount?: string,
  /** What a `mode: 'sdk'` client returned for `paymentIntent`. */
  clientResult?: Record<string, string>,
  /** Pay with Apple Pay on the gateway's own page. */
  wallet?: "apple_pay",
): Promise<{ ok: true; result: PortalInvoiceCollection } | { ok: false; error: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: NO_SESSION };
  if (!invoice) return { ok: false, error: "The invoice ID is missing. Reload the page." };
  const base = `${origin}${PORTAL_PATH}`;
  const res = await portalCollectInvoice(token, invoice, {
    ...(paymentIntent ? { payment_intent: paymentIntent } : {}),
    ...(paymentIntent && clientResult ? { client_result: clientResult } : {}),
    ...(gatewayAccount ? { gateway_account: gatewayAccount } : {}),
    ...(wallet && !paymentIntent ? { wallet } : {}),
    return_url: `${base}?pay=return`,
    cancel_url: `${base}?pay=cancel`,
  });
  if (!res.ok || !res.data)
    return { ok: false, error: res.error ?? "We could not take the payment." };
  revalidatePath(PORTAL_PATH);
  return { ok: true, result: res.data };
}

/** Where a just-approved payment stands. Read-only, so no revalidate. */
export async function portalInvoiceStateAction(
  invoice: string,
): Promise<{ ok: true; invoice: PortalInvoice } | { ok: false; error: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: NO_SESSION };
  const res = await portalGetInvoice(token, invoice);
  if (!res.ok || !res.data)
    return { ok: false, error: res.error ?? "We could not load the invoice." };
  return { ok: true, invoice: res.data };
}

/**
 * The providers that can take THIS invoice, for the Pay now chooser.
 *
 * Fetched on click rather than with the page: it is per-invoice (its own currency) and
 * most buyers never need it, because one matching provider is not a choice.
 */
export async function portalPayGatewaysAction(
  currency: string,
): Promise<{ ok: true; gateways: PortalGateway[] } | { ok: false; error: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: NO_SESSION };
  const res = await portalListGateways(token, currency, "payment");
  if (!res.ok || !res.data)
    return { ok: false, error: res.error ?? "We could not load the payment providers." };
  return { ok: true, gateways: res.data.data };
}

/**
 * The buyer declines to complete their bank's authentication for an in-flight debit.
 *
 * Deliberately NOT modelled as "cancel the payment": we cannot cancel it at the
 * gateway (RazorPay refuses to void a `created` recurring payment), and saying so
 * would promise something we do not do. What this really does is release OUR hold on
 * the invoice so they can pay another way — which the copy at the call site says.
 */
export async function portalAbandonAuthenticationAction(
  invoice: string,
): Promise<{ ok: true; result: PortalAuthenticationAbandoned } | { ok: false; error: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: NO_SESSION };
  if (!invoice) return { ok: false, error: "The invoice ID is missing. Reload the page." };
  const res = await portalAbandonAuthentication(token, invoice);
  if (!res.ok || !res.data)
    return { ok: false, error: res.error ?? "We could not release this payment." };
  revalidatePath(PORTAL_PATH);
  return { ok: true, result: res.data };
}

/**
 * Save the buyer's billing identity (contact + address) before card setup.
 *
 * The required name is the ADDRESS CONTACT's `first_name`, not `customers.name`: that
 * column is our own invention, no document prints it, and the form no longer offers a
 * field for it — so requiring it here returned `{errors: {name: 'Required'}}` keyed to
 * an input that does not exist, which renders as a form that refuses to submit and
 * says nothing. Company alone is accepted too: a business buyer whose invoices are
 * addressed to the entity has a perfectly good billing name.
 */
export async function portalUpdateMeAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const token = await readStorefrontToken("portal");
  const firstName = String(formData.get("first_name") ?? "").trim();
  const company = String(formData.get("company") ?? "").trim();
  const line1 = String(formData.get("line1") ?? "").trim();
  const country = String(formData.get("country") ?? "")
    .trim()
    .toUpperCase();
  // Empty clears it (matches `updateCheckoutCustomerDetails`'s `?.trim() || null`),
  // rather than being treated as "not provided" and left untouched — a buyer who
  // blanks the field out is asking us to forget the number, not to keep the old one.
  const taxRegistrationNumberRaw = formData.get("tax_registration_number");
  const taxRegistrationNumber =
    taxRegistrationNumberRaw === null ? undefined : String(taxRegistrationNumberRaw).trim() || null;
  if (!token) return actionError(NO_SESSION);
  if (!firstName && !company && !String(formData.get("last_name") ?? "").trim()) {
    return actionError("Enter the name to show on your invoices", {
      errors: { first_name: "Required" },
    });
  }
  // Which fields are required is the business's portal rule; the engine enforces it.
  if (country && !/^[A-Z]{2}$/.test(country))
    return actionError("Enter a 2-letter country code", {
      errors: { country: "For example IN or US" },
    });
  const opt = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? undefined : v;
  };
  const res = await portalUpdateMe(token, {
    // `name` is deliberately NOT sent: nothing on this form collects it, and posting
    // an empty string would blank a value an operator or the importer had set.
    ...(taxRegistrationNumber !== undefined
      ? { tax_registration_number: taxRegistrationNumber }
      : {}),
    address: {
      line1: line1 || undefined,
      line2: opt("line2"),
      line3: opt("line3"),
      city: opt("city"),
      state: opt("state"),
      state_code: opt("state_code"),
      postal_code: opt("postal_code"),
      country: country || undefined,
      first_name: opt("first_name"),
      last_name: opt("last_name"),
      company: opt("company"),
      phone: opt("phone"),
    },
  });
  revalidatePath(PORTAL_PATH);
  return res.ok
    ? actionOk("Billing details saved")
    : actionError(
        res.error
          ? `We could not save your billing details. ${res.error}`
          : "We could not save your billing details.",
      );
}

/**
 * The customer applies a coupon to their own subscription (0238).
 *
 * Not an `ActionForm` action: the portal's coupon box is a client component that needs the
 * engine's own sentence back to show beside the field ("No such coupon: FOO", "Coupon has
 * reached its redemption limit"). A buyer has no operator to ask and no log to read, so a
 * generic failure would leave them stuck.
 *
 * Authorisation is entirely server-side and NOT here: the route scopes the subscription to
 * the session's own customer, so a `sub` id from the client cannot reach anyone else's.
 */
export async function portalApplyCouponAction(
  sub: string,
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: "This link is expired. Ask for a new link." };
  const res = await portalApplyCoupon(token, sub, code);
  if (!res.ok) return { ok: false, error: res.error ?? "We could not apply that code." };
  return { ok: true };
}

/** Take the applied coupon back off. Coupon-sourced discounts only — the route refuses the rest. */
export async function portalRemoveCouponAction(
  sub: string,
  code?: string,
): Promise<{ ok: boolean; error?: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: "This link is expired. Ask for a new link." };
  const res = await portalRemoveCoupon(token, sub, code);
  if (!res.ok) return { ok: false, error: res.error ?? "We could not remove that discount." };
  return { ok: true };
}

/** Skip one upcoming renewal, or undo that skip. */
export async function portalSkipRenewalAction(
  sub: string,
  renewalAt: string,
  undo: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: "This link is expired. Ask for a new link." };
  const res = await portalSkipRenewal(
    token,
    sub,
    renewalAt,
    undo ? "unskip_renewal" : "skip_renewal",
  );
  revalidatePath(PORTAL_PATH);
  if (!res.ok)
    return {
      ok: false,
      error: res.error ?? (undo ? "We could not undo the skip." : "We could not skip the renewal."),
    };
  return { ok: true };
}

/**
 * Pay a payment request's whole live total with a SAVED payment method (the default
 * one when none is posted). A decline is a 2xx with the error on the request.
 */
export async function portalPayRequestAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const token = await readStorefrontToken("portal");
  if (!token) return actionError(NO_SESSION);
  const preq = String(formData.get("preq") ?? "").trim();
  if (!preq) return actionError("The payment request ID is missing. Reload the page.");
  const pm = String(formData.get("payment_method") ?? "").trim();
  const res = await portalPayRequest(token, preq, pm ? { payment_method: pm } : {});
  revalidatePath(PORTAL_PATH);
  if (!res.ok || !res.data) return actionError(res.error ?? "We could not take the payment.");
  const r = res.data;
  if (r.status === "paid") return actionOk("Payment received. Thank you.");
  if (r.status === "processing")
    return actionOk("Payment started. It can take some time to complete.");
  return actionError(
    `We could not take the payment. ${r.last_payment_error?.message ?? "Your bank declined it."} Select a different payment method, or pay each invoice below.`,
  );
}

// ── Shipping addresses (0360) ─────────────────────────────────────────────────

const SHIPPING_FIELDS = [
  "label",
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
 * Add (no `addr`) or edit (`addr` set) a shipping address. An edit posts every field, so a
 * blank one clears its column; an add leaves blanks out.
 */
export async function portalSaveShippingAddressAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const token = await readStorefrontToken("portal");
  if (!token) return actionError(NO_SESSION);
  const addr = String(formData.get("addr") ?? "").trim();
  const body: PortalShippingAddressInput = {};
  for (const k of SHIPPING_FIELDS) {
    const raw = formData.get(k);
    if (raw === null) continue;
    const v = String(raw).trim();
    const value = k === "country" ? v.toUpperCase() : v;
    if (value) body[k] = value;
    else if (addr) body[k] = null;
  }
  if (formData.get("is_default") === "on") body.is_default = true;
  const res = addr
    ? await portalUpdateShippingAddress(token, addr, body)
    : await portalCreateShippingAddress(token, body);
  revalidatePath(PORTAL_PATH);
  if (res.ok) return actionOk(addr ? "Shipping address saved." : "Shipping address added.");
  const verb = addr ? "save" : "add";
  return actionError(
    res.error
      ? `We could not ${verb} the shipping address. ${res.error}`
      : `We could not ${verb} the shipping address.`,
  );
}

export async function portalMakeDefaultShippingAction(
  addr: string,
): Promise<{ ok: boolean; error?: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: NO_SESSION };
  const res = await portalUpdateShippingAddress(token, addr, { is_default: true });
  revalidatePath(PORTAL_PATH);
  return res.ok
    ? { ok: true }
    : { ok: false, error: res.error ?? "We could not change your default address." };
}

/** "Remove" in the portal = the engine's archive. 409 (with the engine's message) while a live subscription ships to it. */
export async function portalArchiveShippingAction(
  addr: string,
): Promise<{ ok: boolean; error?: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: NO_SESSION };
  const res = await portalArchiveShippingAddress(token, addr);
  revalidatePath(PORTAL_PATH);
  return res.ok
    ? { ok: true }
    : { ok: false, error: res.error ?? "We could not remove the address." };
}

/** `addressId: null` = ship to the customer's default. */
export async function portalSetShipToAction(
  sub: string,
  addressId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: NO_SESSION };
  const res = await portalSetSubscriptionShipTo(token, sub, addressId);
  revalidatePath(PORTAL_PATH);
  return res.ok
    ? { ok: true }
    : {
        ok: false,
        error: res.error
          ? `We could not change the shipping address. ${res.error}`
          : "We could not change the shipping address.",
      };
}

const EXPIRED = "This link is expired. Ask for a new link.";

export async function portalChangeOptionsAction(
  sub: string,
): Promise<{ ok: boolean; data?: PortalChangeOptions; error?: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: EXPIRED };
  const res = await portalChangeOptions(token, sub);
  return res.ok && res.data
    ? { ok: true, data: res.data }
    : { ok: false, error: res.error ?? "We could not load the plan options." };
}

export async function portalChangePreviewAction(
  sub: string,
  request: PortalChangeRequest,
): Promise<{ ok: boolean; data?: PortalChangePreview; error?: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: EXPIRED };
  const res = await portalChangePreview(token, sub, request);
  return res.ok && res.data
    ? { ok: true, data: res.data }
    : { ok: false, error: res.error ?? "We could not price this change." };
}

export async function portalChangeApplyAction(
  sub: string,
  request: PortalChangeRequest,
  expectedTotalMinor: number,
  quoted?: { pricedAt: string; quote: string },
): Promise<{ ok: boolean; data?: PortalChangeResult; error?: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: EXPIRED };
  const res = await portalChangeApply(token, sub, {
    ...request,
    expected_total_minor: expectedTotalMinor,
    ...(quoted ? { priced_at: quoted.pricedAt, quote: quoted.quote } : {}),
  });
  revalidatePath(PORTAL_PATH);
  return res.ok && res.data
    ? { ok: true, data: res.data }
    : { ok: false, error: res.error ?? "We could not change your plan." };
}

export async function portalCancelScheduledChangeAction(
  sub: string,
): Promise<{ ok: boolean; error?: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: EXPIRED };
  const res = await portalCancelScheduledChange(token, sub);
  revalidatePath(PORTAL_PATH);
  return res.ok
    ? { ok: true }
    : { ok: false, error: res.error ?? "We could not withdraw the change." };
}

const LIFECYCLE_FAILED: Record<PortalLifecycleAction, string> = {
  cancel: "We could not cancel the subscription.",
  pause: "We could not pause the subscription.",
  resume: "We could not resume the subscription.",
  reactivate: "We could not keep the subscription.",
};

/** Cancel, pause, resume or reactivate. The engine checks the business's switch again. */
export async function portalSubscriptionLifecycleAction(
  sub: string,
  action: PortalLifecycleAction,
  reasonCode?: string,
  offersShown?: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: "This link is expired. Ask for a new link." };
  const res = await portalSubscriptionLifecycle(
    token,
    sub,
    action,
    action === "cancel"
      ? {
          ...(reasonCode ? { reason_code: reasonCode } : {}),
          ...(offersShown ? { offers_shown: true } : {}),
        }
      : {},
  );
  revalidatePath(PORTAL_PATH);
  if (!res.ok) return { ok: false, error: res.error ?? LIFECYCLE_FAILED[action] };
  return { ok: true };
}

export async function portalCancelFlowAction(
  sub: string,
): Promise<{ ok: boolean; data?: PortalCancelFlow; error?: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: EXPIRED };
  const res = await portalCancelFlow(token, sub);
  return res.ok && res.data
    ? { ok: true, data: res.data }
    : { ok: false, error: res.error ?? "We could not load the cancel options." };
}

export async function portalTakeRetentionOfferAction(
  sub: string,
  offer: PortalRetentionOffer["offer"],
  months?: number,
  reasonCode?: string,
): Promise<{ ok: boolean; url?: string; starts?: string; error?: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: EXPIRED };
  const res = await portalTakeRetentionOffer(token, sub, {
    offer,
    ...(months !== undefined ? { months } : {}),
    ...(reasonCode ? { reason_code: reasonCode } : {}),
  });
  revalidatePath(PORTAL_PATH);
  return res.ok && res.data
    ? {
        ok: true,
        ...(res.data.url ? { url: res.data.url } : {}),
        ...(res.data.starts ? { starts: res.data.starts } : {}),
      }
    : { ok: false, error: res.error ?? "We could not apply the offer." };
}

/** Sign-in by email code, step 1. The answer never says whether the email has an account. */
export async function portalLoginRequestAction(
  business: string,
  email: string,
  botCheckToken?: string,
): Promise<{ ok: boolean; error?: string; botCheck?: boolean }> {
  const res = await portalLoginRequest({
    business,
    email,
    ...(botCheckToken ? { bot_check_token: botCheckToken } : {}),
  });
  if (res.ok) return { ok: true };
  return {
    ok: false,
    error: res.error,
    botCheck: res.code === "bot_check_required" || res.code === "bot_check_failed",
  };
}

/**
 * Sign-in by email code, step 2. On success the session goes into the HttpOnly cookie, as
 * a link's exchange does; with several accounts on the email, the list comes back.
 */
export async function portalLoginVerifyAction(
  business: string,
  email: string,
  code: string,
  customer?: string,
): Promise<{
  ok: boolean;
  error?: string;
  choose?: Array<{ id: string; name: string }>;
}> {
  const res = await portalLoginVerify({ business, email, code, ...(customer ? { customer } : {}) });
  if (!res.ok) return { ok: false, error: res.error };
  if (res.data.object === "portal_login_choice") return { ok: true, choose: res.data.customers };
  await rememberPortalBusiness(business);
  await setStorefrontToken("portal", res.data.token);
  revalidatePath(PORTAL_PATH);
  return { ok: true };
}
