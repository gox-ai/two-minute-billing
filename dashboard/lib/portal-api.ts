/**
 * Buyer-portal API client (P14). Authenticates with the customer-scoped portal
 * token ONLY — this module must never import lib/api.ts (which injects the org
 * API key). Used exclusively by app/portal/[token]/* server code.
 */
import type { RazorpayCheckoutDescriptor } from "./razorpay-checkout";
import type { AchAuthorizationText } from "./checkout-api";
import type { FormPostDescriptor, GatewaySdkDescriptor } from "./gateway-sdk";
import { forwardedFor } from "./forwarded-for";
import { storefrontErrorText } from "./storefront-error";
import type { CurrentUsage } from "./api/current-usage";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

export interface PortalMe {
  object: "portal_me";
  /** `psess_…`: this session. The page names it in `?s=`. Absent on older engines. */
  session?: string;
  /** Phase 4b: where "Back to <business>" goes. Null = no link. Absent on older engines. */
  return_url?: string | null;
  /** The one website that may frame this session (embedded portal), or null. */
  embed_origin?: string | null;
  customer: {
    id: string;
    /**
     * Our own display fallback, last in every precedence chain in `lib/names.ts`.
     * No buyer form writes it; read it through the helpers.
     */
    name: string | null;
    /** The ACCOUNT HOLDER — who this person is, not who is billed. */
    first_name: string | null;
    last_name: string | null;
    company: string | null;
    email: string | null;
    phone: string | null;
    /**
     * GSTIN (or other jurisdiction's equivalent) — F-23. The hosted checkout collects
     * this and tells the buyer it "must be on your invoice to claim input tax credit";
     * the portal is the only self-serve surface for a customer created without one
     * (API, import, or a checkout run before it existed) to add it later.
     */
    tax_registration_number: string | null;
    address: {
      line1: string | null;
      line2: string | null;
      line3: string | null;
      city: string | null;
      state: string | null;
      state_code: string | null;
      postal_code: string | null;
      country: string | null;
      first_name: string | null;
      last_name: string | null;
      company: string | null;
      phone: string | null;
    };
    /**
     * False until the customer has SOME billing name (address contact, account holder
     * or legacy `name` — `hasBillingName` on the engine side) plus every address field this
     * portal requires. Collect billing details before card setup (India-exports).
     */
    billing_details_complete: boolean;
    /** The address fields still empty, by name (`first_name`, `postal_code`…). Absent on older engines. */
    billing_details_missing?: string[];
  };
  /** Brand Styles (0185) — what this business shows ITS customers. All nullable. */
  business: {
    /** Public id (`biz_…`). Absent on older engines. */
    id?: string;
    name: string;
    /** `live` | `test`. Absent on older engines. */
    livemode?: string;
    logo_url: string | null;
    icon_url: string | null;
    favicon_url: string | null;
    brand_color: string | null;
    button_text_color?: string | null;
    /** Where the buyer asks for help. Null or absent: show nothing. */
    support_email?: string | null;
    website?: string | null;
    /** The business has a public pricing page at `/pricing/<id>`. */
    has_pricing_page?: boolean;
    /**
     * 0238 — may this customer apply a coupon code to their own subscription? The box
     * renders only when true; `POST /portal/v1/subscriptions/:sub/coupon` 403s otherwise.
     */
    allow_customer_coupons: boolean;
    /** Ask why when the buyer deletes their last payment method. Absent on an older API. */
    ask_delete_reason?: boolean;
    /**
     * IANA zone for rendering dates. The storefront sits outside the `(dashboard)`
     * tree so there is no `BusinessTzProvider` to read — pass this to `fmtDate`
     * explicitly on every date the buyer sees. Null falls back to UTC.
     */
    timezone: string | null;
    /** 0360 — the business collects a ship-to. Absent on older engines. */
    collects_shipping_address?: boolean;
  };
  /**
   * The business's portal field matrix, resolved (every key present), keyed like
   * `billing.line1`. The engine ignores posted values for `hide` and `read_only` keys.
   * Absent from an older engine: the form then keeps its built-in rules.
   */
  field_config?: Partial<Record<string, "show" | "hide" | "mandatory" | "read_only">>;
}

export interface PortalMeUpdate {
  name?: string;
  /** `null` clears it; `undefined` leaves it untouched — matches `updateCustomer`. */
  tax_registration_number?: string | null;
  address?: {
    line1?: string;
    line2?: string;
    line3?: string;
    city?: string;
    state?: string;
    state_code?: string;
    postal_code?: string;
    country?: string;
    first_name?: string;
    last_name?: string;
    company?: string;
    phone?: string;
  };
}

/** Mirrors serializePaymentMethod (src/modules/payment-methods/serialize.ts). */
export interface PortalPaymentMethod {
  object: "payment_method";
  id: string;
  provider: string;
  type: string;
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  status: string | null;
  role: string | null;
  is_default: boolean;
  /**
   * The mandate this instrument rides, when it rides one (RazorPay UPI Autopay /
   * netbanking e-mandate / card mandate). Already on the wire — the portal shares
   * `serializePaymentMethod` with the dashboard — it just was not declared here.
   */
  mandate?: {
    rail: string | null;
    status: string | null;
    max_amount_minor: number | null;
    currency: string | null;
    expires_at: string | null;
    reference: string | null;
  } | null;
  created_at: string;
}

export interface PortalVaultSetup {
  object: "vault_setup";
  provider: string;
  setup_token: string;
  mode: "redirect" | "checkout" | "client_secret" | "sdk" | "form_post";
  approval_url?: string;
  client_secret?: string;
  publishable_key?: string;
  /** mode: 'checkout' — params for the provider's embedded modal (RazorPay). */
  checkout?: RazorpayCheckoutDescriptor;
  /** mode: 'sdk' — the gateway's browser SDK, opened through `openGatewaySdk`. */
  sdk?: GatewaySdkDescriptor;
  /** mode: 'form_post' — a top-level POST to the gateway (`submitFormPost`). */
  form_post?: FormPostDescriptor;
  /**
   * The `pi_…` this add-card was recorded as, when it could be (every gateway-account
   * path; absent only for a legacy ENV-configured provider). COMPLETE WITH THIS, not
   * with the provider token: the gateway's own webhook harvests the same intent, and
   * only going through it makes the two the same atomic claim instead of two rows.
   */
  payment_intent?: string;
}

/**
 * Answer to "Pay now". Either the settled invoice, or `action_required` carrying the
 * challenge the buyer has to complete before the call is repeated with the intent id.
 */
export type PortalInvoiceCollection =
  | (PortalInvoice & {
      payment?: { id: string; status: string } | null;
      payment_error?: { code: string; message: string };
      /** A mandate that needs a pre-debit notice: the notice went out, the debit follows. */
      collection_scheduled?: { at: string; message: string };
      /** Pay and save: the method the payment also kept. */
      saved_payment_method?: {
        id: string;
        type: string;
        brand: string | null;
        last4: string | null;
      };
      /** Pay and save: the money was taken but the method could not be kept. */
      save_failed?: boolean;
    })
  | {
      object: "invoice_collection";
      invoice: string;
      status: "action_required";
      payment_intent: { id: string; next_action?: PortalNextAction | null };
      next_action?: PortalNextAction | null;
    };

/** The provider-side challenge, in the same shapes the add-card flow already handles. */
export interface PortalNextAction {
  mode: "redirect" | "checkout" | "client_secret" | "sdk" | "form_post";
  approvalUrl?: string;
  clientSecret?: string;
  publishableKey?: string;
  checkout?: RazorpayCheckoutDescriptor;
  sdk?: GatewaySdkDescriptor;
  formPost?: FormPostDescriptor;
}

export interface PortalGateway {
  id: string; // gwa_…
  gateway_key: string; // tmtest | stripe | paypal | razorpay
  label: string;
  method_types?: string[] | null;
  /** Our bank debit authorization, shown before a bank account is saved here. */
  ach_authorization?: AchAuthorizationText | null;
  /** Pay now can take Apple Pay on this gateway's own page. Absent on an older API. */
  apple_pay_hosted?: boolean;
}

/** Mirrors serializeInvoice (src/modules/invoicing/serialize.ts) — buyer view. */
export interface PortalInvoice {
  object: "invoice";
  id: string;
  number: string | null;
  status: string;
  currency: string;
  total_minor: number;
  amount_paid_minor: number;
  amount_due_minor: number;
  due_date: string | null;
  paid_at: string | null;
  created_at: string;
  /**
   * An async debit (UPI, netbanking, a card mandate) is already working on this invoice
   * and will settle by webhook. Nothing else on the row shows it — the status stays
   * `payment_due` and the full amount stays due — so without this the portal offers a
   * "Pay now" the engine will refuse.
   */
  payment_in_flight?: boolean;
  /** Above the business's card limit: no Pay now, the buyer pays another way (0482). */
  over_card_limit?: boolean;
  /** The next automatic retry, when one is scheduled. */
  next_attempt_at?: string | null;
  /**
   * The latest charge on this invoice, when it failed: the saved method that was refused
   * (null when it is gone) and the gateway's code.
   */
  last_payment_error?: {
    payment_method: string | null;
    code: string | null;
    at: string;
    /** Our payer sentence for the code; null when there is no reason to give. */
    message?: string | null;
    /** The same method cannot succeed: lead with adding another one. */
    new_method_needed?: boolean;
  } | null;
  /**
   * That in-flight debit is paused for the payer's OWN bank approval (RBI/NPCI, over
   * ₹15,000), not for a settlement network. Only meaningful alongside
   * `payment_in_flight`; it changes who the buyer is waiting for, and therefore
   * whether "Payment processing…" is a true thing to tell them.
   */
  awaiting_authentication?: boolean;
  /**
   * Which gateway holds the in-flight debit, when one does. Drives whether the release
   * dialog can PROMISE the bank's request is cancelled or must say it will try: Stripe
   * cancels an India e-mandate debit cleanly from `requires_action` (measured
   * 2026-09-10), RazorPay declares `intentVoid: false` and cannot. Absent/null =
   * unknown, and the cautious wording wins.
   */
  in_flight_gateway?: string | null;
  /** A held renewal invoice (usage grace window, `pending`): when it finalizes. */
  usage_closes_at?: string | null;
  /** A debit announced to the payer's bank (pre-debit notice), not made yet: when. */
  collection_scheduled_at?: string | null;
}

/**
 * A portal token, or a token with the session (`psess_…`) the page shows. With the session
 * the API refuses a token that opens any other one (two tabs, one cookie).
 */
export type PortalAuth = string | { token: string; session: string };

/** `Authorization`, plus `X-Portal-Session` when the caller named its session. */
export const portalAuthHeaders = (auth: PortalAuth): Record<string, string> =>
  typeof auth === "string"
    ? { Authorization: `Bearer ${auth}` }
    : { Authorization: `Bearer ${auth.token}`, "X-Portal-Session": auth.session };

async function portalFetch<T>(
  token: PortalAuth,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      // Every buyer write carries one (audit L6). The engine requires it on mutating routes,
      // and the storefront's clients sent none — so requiring it without this would have
      // broken checkout and portal payment, the two paths where a failure costs money.
      //
      // Per-call and RANDOM, deliberately. A stable key derived from the invoice would dedupe
      // a double-tap but would also refuse the legitimate second attempt after a decline: the
      // engine replays the stored FAILURE for a reused key and tells the caller to use a new
      // one. So this dedupes network-level retries of one request, which is what the engine's
      // idempotency is for, and double-submit protection stays a UI concern.
      ...(init?.method && init.method !== "GET" ? { "Idempotency-Key": crypto.randomUUID() } : {}),
      ...portalAuthHeaders(token),
      // The buyer's forwarded chain, untouched — see `lib/forwarded-for.ts`.
      ...(await forwardedFor()),
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    cache: "no-store",
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  if (res.ok) return { ok: true, status: res.status, data: json as T };
  // The field reasons without their keys, as `api.ts` does: each reason names its field
  // ("… is not a valid phone number"), and a buyer has no use for `address.phone`.
  const error = storefrontErrorText(res.status, json, false);
  return { ok: false, status: res.status, ...(error ? { error } : {}) };
}

export const portalMe = (token: PortalAuth) => portalFetch<PortalMe>(token, "/portal/v1/me");

export const portalUpdateMe = (token: PortalAuth, body: PortalMeUpdate) =>
  portalFetch<PortalMe>(token, "/portal/v1/me", { method: "PATCH", body });

export const portalListPaymentMethods = (token: PortalAuth) =>
  portalFetch<{ object: "list"; data: PortalPaymentMethod[] }>(token, "/portal/v1/payment_methods");

/**
 * Spend the single-use entry credential from `/portal/s/<token>` for a session token
 * (0193). Server-side only — the buyer's browser holds neither value.
 *
 * Null on ANY failure: expired, already spent, revoked, unknown. The API answers one
 * shape for all of them on purpose, and the page renders the same "ask for a new link"
 * card, so there is nothing here to tell apart.
 */
export type PortalExchangeResult =
  | {
      ok: true;
      token: string;
      /** `psess_…`: the session this token opens. */
      session: string | null;
      expiresAt: string;
      forwardUrl: string | null;
      business: string | null;
    }
  /** `business` is set when the link was real but dead — whose message to show. */
  | { ok: false; business: string | null };

export interface PortalLinkPeek {
  link_kind: "api" | "email";
  task: "pay_invoice" | "update_card" | "change_plan" | "cancel_subscription" | null;
  business: PortalLinkNotice["business"] | null;
}

/**
 * The peek with its failure told apart: `dead` is a link the engine refused (expired,
 * spent, revoked), with whose it was when known; `unknown` is a rate limit or an error,
 * where only the POST can decide.
 */
export async function portalPeekLink(
  accessToken: string,
): Promise<
  | { kind: "live"; peek: PortalLinkPeek }
  | { kind: "dead"; business: string | null }
  | { kind: "unknown" }
> {
  try {
    const res = await fetch(`${BASE}/portal/v1/session/peek`, {
      headers: { Authorization: `Bearer ${accessToken}`, ...(await forwardedFor()) },
      cache: "no-store",
    });
    if (res.ok) return { kind: "live", peek: (await res.json()) as PortalLinkPeek };
    if (res.status === 401) {
      const j = (await res.json().catch(() => ({}))) as { business?: string };
      return { kind: "dead", business: j.business ?? null };
    }
    return { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
}

/** What a link opens, without spending it (Phase 4b). Null for a dead link. */
export async function portalPeek(accessToken: string): Promise<PortalLinkPeek | null> {
  try {
    const res = await fetch(`${BASE}/portal/v1/session/peek`, {
      headers: { Authorization: `Bearer ${accessToken}`, ...(await forwardedFor()) },
      cache: "no-store",
    });
    return res.ok ? ((await res.json()) as PortalLinkPeek) : null;
  } catch {
    return null;
  }
}

/**
 * Where a SPENT link may still go: its own page, when this browser's session was minted
 * from that link. Null otherwise (another browser, an ended session), and the caller shows
 * the expired card as before.
 */
export async function portalResume(
  accessToken: string,
  sessionToken: string | null,
): Promise<string | null> {
  if (!sessionToken) return null;
  try {
    const res = await fetch(`${BASE}/portal/v1/session/resume`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json",
        ...(await forwardedFor()),
      },
      body: JSON.stringify({ link: accessToken }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => ({}))) as { forward_url?: string | null };
    // One of the engine's closed set of `/portal…` paths, never off-site.
    return json.forward_url?.startsWith("/portal") ? json.forward_url : "/portal";
  } catch {
    return null;
  }
}

export async function portalExchange(accessToken: string): Promise<PortalExchangeResult> {
  try {
    const res = await fetch(`${BASE}/portal/v1/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, ...(await forwardedFor()) },
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      token?: string;
      expires_at?: string;
      forward_url?: string;
      business?: string;
    };
    const business = json.business ?? null;
    if (!res.ok || !json.token) return { ok: false, business };
    return {
      ok: true,
      token: json.token,
      session: json.id ?? null,
      expiresAt: json.expires_at ?? "",
      forwardUrl: json.forward_url ?? null,
      business,
    };
  } catch {
    return { ok: false, business: null };
  }
}

export interface PortalLinkNotice {
  business: {
    name: string;
    /** `live` | `test`. Absent on older engines. */
    livemode?: string;
    logo_url: string | null;
    icon_url: string | null;
    favicon_url: string | null;
    brand_color: string | null;
    button_text_color?: string | null;
    support_email?: string | null;
    website?: string | null;
  };
  /** The business has a public pricing page. Absent on older engines. */
  pricing_page?: boolean;
  /** Sanitised by the engine; still render through `<SafeHtml>`. Null = default copy. */
  message_html: string | null;
  /** Phase 4: the business offers sign-in by email code. Absent on older engines. */
  email_code?: boolean;
}

/** An unauthenticated portal POST (sign-in by code): the parsed body, or the error text. */
async function publicPortalPost<T>(
  path: string,
  body: object,
): Promise<{ ok: true; data: T } | { ok: false; error: string; code?: string }> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await forwardedFor()) },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const json = (await res.json().catch(() => null)) as
      | (T & { error?: { message?: string; code?: string } })
      | null;
    if (res.ok && json) return { ok: true, data: json };
    return {
      ok: false,
      error: storefrontErrorText(res.status, json, false) ?? "We could not do this now. Try again.",
      ...(json?.error?.code ? { code: json.error.code } : {}),
    };
  } catch {
    return { ok: false, error: "We could not do this now. Try again." };
  }
}

/** Ask for a sign-in code. Answers the same whether or not the email has an account. */
export const portalLoginRequest = (body: {
  business: string;
  email: string;
  bot_check_token?: string;
}) =>
  publicPortalPost<{ object: "portal_login_request"; sent: true }>(
    "/portal/v1/login/request",
    body,
  );

export type PortalLoginVerifyResult =
  | { object: "portal_login"; id?: string; token: string; expires_at: string }
  | { object: "portal_login_choice"; customers: Array<{ id: string; name: string }> };

/** Check a sign-in code: a session token, or the accounts to select from. */
export const portalLoginVerify = (body: {
  business: string;
  email: string;
  code: string;
  customer?: string;
}) => publicPortalPost<PortalLoginVerifyResult>("/portal/v1/login/verify", body);

/** The brand and message for a buyer who cannot get in. Null on any failure. */
export async function portalLinkNotice(businessId: string): Promise<PortalLinkNotice | null> {
  try {
    const res = await fetch(`${BASE}/portal/v1/link_notice/${encodeURIComponent(businessId)}`, {
      headers: { ...(await forwardedFor()) },
      cache: "no-store",
    });
    return res.ok ? ((await res.json()) as PortalLinkNotice) : null;
  } catch {
    return null;
  }
}

/** End the buyer's session. */
export const portalLogout = (token: PortalAuth) =>
  portalFetch<{ object: "portal_logout"; ok: true; redirect_url?: string }>(
    token,
    "/portal/v1/logout",
    {
      method: "POST",
    },
  );

/**
 * The buyer's invoices, newest first, BOUNDED by `limit`.
 *
 * `has_more` is in the type even though it would be easy to leave out: a wrapper that
 * types a paginated endpoint as a plain list is how `listGatewayRequests` hid 61 of 111
 * rows with a clean compile (docs/PROGRESS.md). The caller decides what to do with it;
 * the type makes ignoring it a choice rather than an accident.
 */
export const portalListInvoices = (token: PortalAuth, limit?: number) =>
  portalFetch<{ object: "list"; data: PortalInvoice[]; has_more: boolean }>(
    token,
    `/portal/v1/invoices${limit === undefined ? "" : `?limit=${limit}`}`,
  );

/** A one-time purchase: an invoice a purchase checkout raised. */
export interface PortalPurchase {
  object: "purchase";
  /** inv_… — the receipt is this invoice's PDF. */
  invoice: string;
  number: string | null;
  status: string;
  currency: string;
  total_minor: number;
  /** Money returned on this purchase so far. */
  refunded_minor: number;
  created_at: string;
  paid_at: string | null;
  items: Array<{ description: string; quantity: number; image_url?: string | null }>;
}

/** The buyer's one-time purchases, newest first, bounded like the invoice list. */
export const portalListPurchases = (token: PortalAuth, limit?: number) =>
  portalFetch<{ object: "list"; data: PortalPurchase[]; has_more: boolean }>(
    token,
    `/portal/v1/purchases${limit === undefined ? "" : `?limit=${limit}`}`,
  );

/**
 * What the buyer is subscribed to, and what will be collected next.
 *
 * The portal had none of this: it opened with a balance and an invoice list, so a customer
 * who had just signed up could not see their plan, their add-ons, the amount or the date.
 */
export interface PortalSubscriptionItem {
  name: string;
  /** plan | addon | charge — lets the page separate the plan from what is attached to it. */
  kind: string;
  quantity: number;
  /** Per-unit rate in the item's own cadence, from the item's FROZEN price snapshot. */
  unit_amount_minor: number | null;
  /** unit × quantity. Null for a pricing model with no single rate (tiered, metered). */
  amount_minor: number | null;
  interval: string | null;
  interval_count: number;
  /** Billed per unit used: `unit_amount_minor` is a per-unit rate. */
  metered?: boolean;
}

export interface PortalSubscription {
  object: "subscription";
  id: string;
  /** Includes the derived `non_renewing` — an active subscription that will not renew. */
  status: string;
  currency: string;
  items: PortalSubscriptionItem[];
  /** The page asks for usage only for these subscriptions. */
  has_metered_items?: boolean;
  has_credit_usage?: boolean;
  /** Σ line amounts, PRE-tax. What the plan costs, not what we will charge. */
  recurring_subtotal_minor: number;
  current_period_end: string | null;
  /** When a cancelled subscription ended. */
  ended_at?: string | null;
  /**
   * The oldest live discount, or null. `removable` is false for an operator's manual
   * discount — that one is not the buyer's to lift.
   */
  discount: PortalDiscount | null;
  /** Every live discount (0495). */
  discounts?: PortalDiscount[];
  /** How many more codes the buyer can enter here (0495). The box hides at 0. */
  coupon_codes_left?: number;
  /** Its own ship-to (`addr_…`); null = ships to the customer's default. */
  shipping_address_id?: string | null;
  /** Where it ships now: its own address, else the default, else null. */
  shipping_address?: PortalShippingAddress | null;
  trial_end: string | null;
  cancel_at_period_end: boolean;
  cancels_at: string | null;
  /**
   * The next invoice, tax included, as the document will state it. **Null when there will
   * not be one** — a cancelling subscription, or one whose billing-cycle cap is spent — so
   * the page must not invent a date for it.
   */
  next_payment: {
    at: string | null;
    total_minor: number;
    /** After the customer's credit balance: what we would actually collect. */
    amount_due_minor: number;
    currency: string;
    /** Named as the invoice names them — "IGST (18.00%)", "CGST (9.00%)". */
    tax_lines: Array<{ label: string; amount_minor: number }>;
    /**
     * The discounts behind this figure, named — a coupon code, "Manual discount", or
     * "Promotional Credits". Sums to the gap between the plan lines above and this total,
     * which is exactly why it exists: without it the portal showed a discounted next
     * payment under undiscounted line items and explained neither.
     */
    discount_lines?: Array<{ label: string; amount_minor: number }>;
    /** Priced after a scheduled plan change (the items the change leaves). */
    after_scheduled_change?: boolean;
    /**
     * Metered subscriptions only. `total_minor` above is the fixed charge; this says
     * whether usage is billed with this payment and, if so, the total with usage so far.
     */
    usage_so_far?:
      | { billed: "with_this_payment"; total_minor: number | null; amount_due_minor: number | null }
      | { billed: "separately" }
      | null;
  } | null;
  /** No `next_payment` because a scheduled change or pause comes first and cannot be priced. */
  next_payment_unpriced?: { type: "change" | "pause"; at: string } | null;
  /**
   * Lifecycle actions the business offers on THIS subscription in its current state. A
   * missing block (an older engine) means none.
   */
  actions?: {
    cancel: {
      timing: "immediately" | "end_of_term";
      reasons: Array<{ code: string; label: string }>;
    } | null;
    pause: boolean;
    resume: boolean;
    reactivate: boolean;
    /**
     * What a pause from the portal does (`pause_config`): it starts now or at the term
     * end, has no end date, and an out-of-term resume bills the new term now or on the
     * next invoice.
     */
    pause_terms?: {
      starts: "now" | "end_of_term";
      resume_charge: "now" | "next_invoice";
    } | null;
    /** With `reactivate`: the renewal that Keep restores, priced. Null when it cannot be priced. */
    keep_payment?: { amount_due_minor: number; currency: string } | null;
  };
  /**
   * Null when the business does not offer skipping. `upcoming` is empty when this
   * subscription cannot skip (trial, paused, cancelling); `changeable` is false within 48
   * hours of a renewal.
   */
  /** Set while paused: when a scheduled resume brings it back, or null for no end date. */
  paused?: { resumes_at: string | null } | null;
  /**
   * Ended subscriptions, when the business offers restarts: whether this one can restart
   * here, and if not, why (`message` is ready to show). Null otherwise.
   */
  restart?: {
    allowed: boolean;
    reason: string | null;
    message: string | null;
    open_invoices: string[];
    closes_at: string | null;
    /**
     * The new term the restart checkout bills: its length and the items at the restart
     * price (`restart_price`), before tax and discounts.
     */
    term?: {
      interval: string;
      interval_count: number;
      subtotal_minor: number;
      currency: string;
    } | null;
  } | null;
  /** Plan changes (Phase 2): offered on this subscription, and a change scheduled for the term end. */
  plan_change?: {
    allowed: boolean;
    scheduled: { id: string; effective_at: string; can_cancel: boolean } | null;
  };
  skip_renewal: {
    /** Most renewals the buyer may skip in 12 months. */
    limit_per_year: number;
    upcoming: PortalUpcomingRenewal[];
  } | null;
  /**
   * Present only when the stored mandate ceiling cannot carry that next payment — the
   * "unless necessary" case, and it arrives free on the estimate above.
   */
  mandate_shortfall?: {
    /** WHICH card the verdict is about — a customer can hold several and only one be short. */
    payment_method: string;
    ceiling_minor: number;
    amount_minor: number;
    currency: string;
    rail: string | null;
    reauthorized_ceiling_minor: number;
    needs_authentication_even_if_raised: boolean;
  };
}

export interface PortalUpcomingRenewal {
  renewal_at: string;
  skipped: boolean;
  changeable: boolean;
}

export interface PortalRenewalSkipResult {
  object: "portal_renewal_skip";
  subscription: string;
  renewal_at: string;
  skipped: boolean;
  next_payment_at: string | null;
}

/**
 * Skip, or undo a skip of, one upcoming renewal. `renewal_at` must be an instant from
 * `skip_renewal.upcoming`. 403 when the business does not allow it; 400 with a message
 * on a refusal (limit reached, less than 48 hours to go).
 */
export const portalSkipRenewal = (
  token: PortalAuth,
  sub: string,
  renewalAt: string,
  action: "skip_renewal" | "unskip_renewal",
) =>
  portalFetch<PortalRenewalSkipResult>(
    token,
    `/portal/v1/subscriptions/${encodeURIComponent(sub)}/${action}`,
    { method: "POST", body: { renewal_at: renewalAt } },
  );

/** Open a checkout that restarts an ended subscription once the buyer pays the new term. */
export const portalRestartSubscription = (
  token: PortalAuth,
  sub: string,
  returnUrl: string,
  cancelUrl: string,
) =>
  portalFetch<{
    object: "portal_subscription_restart";
    id: string;
    url: string;
    expires_at: string;
  }>(token, `/portal/v1/subscriptions/${encodeURIComponent(sub)}/restart`, {
    method: "POST",
    body: { return_url: returnUrl, cancel_url: cancelUrl },
  });

export type PortalLifecycleAction = "cancel" | "pause" | "resume" | "reactivate";

/** Cancel, pause, resume or reactivate the buyer's own subscription. */
export const portalSubscriptionLifecycle = (
  token: PortalAuth,
  sub: string,
  action: PortalLifecycleAction,
  body: { reason_code?: string; reason?: string; offers_shown?: boolean } = {},
) =>
  portalFetch<{
    object: string;
    status: string;
    cancels_at?: string | null;
    cancel_at_period_end?: boolean;
    resume_scheduled_at?: string | null;
  }>(token, `/portal/v1/subscriptions/${encodeURIComponent(sub)}/${action}`, {
    method: "POST",
    body,
  });

/** One entry of the buyer's shipping address book (0360). */
export interface PortalShippingAddress {
  object: "shipping_address";
  id: string;
  label: string | null;
  line1: string | null;
  line2: string | null;
  line3: string | null;
  city: string | null;
  state: string | null;
  state_code: string | null;
  postal_code: string | null;
  country: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  phone: string | null;
  is_default: boolean;
  archived: boolean;
}

/** `null` clears a field; `undefined` leaves it. */
export type PortalShippingAddressInput = Partial<
  Omit<PortalShippingAddress, "object" | "id" | "is_default" | "archived">
> & { is_default?: boolean };

export const portalListShippingAddresses = (token: PortalAuth) =>
  portalFetch<{ object: "list"; data: PortalShippingAddress[] }>(
    token,
    "/portal/v1/shipping_addresses",
  );

export const portalCreateShippingAddress = (token: PortalAuth, body: PortalShippingAddressInput) =>
  portalFetch<PortalShippingAddress>(token, "/portal/v1/shipping_addresses", {
    method: "POST",
    body,
  });

export const portalUpdateShippingAddress = (
  token: PortalAuth,
  addr: string,
  body: PortalShippingAddressInput,
) =>
  portalFetch<PortalShippingAddress>(
    token,
    `/portal/v1/shipping_addresses/${encodeURIComponent(addr)}`,
    { method: "PATCH", body },
  );

/** 409 with the engine's message while a live subscription ships to it. */
export const portalArchiveShippingAddress = (token: PortalAuth, addr: string) =>
  portalFetch<PortalShippingAddress>(
    token,
    `/portal/v1/shipping_addresses/${encodeURIComponent(addr)}/archive`,
    { method: "POST" },
  );

/** `addressId: null` = ship to the customer's default. */
export const portalSetSubscriptionShipTo = (
  token: PortalAuth,
  sub: string,
  addressId: string | null,
) =>
  portalFetch<{
    object: "portal_subscription_shipping_address";
    id: string;
    shipping_address_id: string | null;
    shipping_address: PortalShippingAddress | null;
  }>(token, `/portal/v1/subscriptions/${encodeURIComponent(sub)}/shipping_address`, {
    method: "POST",
    body: { address_id: addressId },
  });

export const portalListSubscriptions = (token: PortalAuth) =>
  portalFetch<{ object: "list"; data: PortalSubscription[] }>(token, "/portal/v1/subscriptions");

/** Usage so far on one subscription. 404 when the business hides usage in the portal. */
export const portalSubscriptionUsage = (token: PortalAuth, sub: string) =>
  portalFetch<CurrentUsage>(token, `/portal/v1/subscriptions/${encodeURIComponent(sub)}/usage`);

/** Usage by day in the open period, by meter and group (never cost). 404 when hidden. */
export const portalSubscriptionUsageDaily = (token: PortalAuth, sub: string) =>
  portalFetch<{
    object: "usage_history";
    time_zone: string;
    /** Instants: [from, to). */
    from: string;
    to: string;
    data: Array<{ date: string; meter: string; group: Record<string, string>; quantity: string }>;
  }>(token, `/portal/v1/subscriptions/${encodeURIComponent(sub)}/usage/daily`);

/**
 * Apply a coupon the CUSTOMER typed to their own subscription (0238). Add only — removing a
 * discount stays an operator action, because a buyer cannot tell a code they entered from
 * one the merchant granted — and one at a time: the route refuses a code when the
 * subscription already carries a discount (`has_discount`).
 *
 * Answers with the re-estimated next payment, so the portal can state the new figure rather
 * than just saying "applied".
 */
export const portalApplyCoupon = (token: PortalAuth, sub: string, code: string) =>
  portalFetch<{
    object: "discount";
    subscription: string;
    coupon: string;
    next_payment: { total_minor: number; currency: string } | null;
  }>(token, `/portal/v1/subscriptions/${encodeURIComponent(sub)}/coupon`, {
    method: "POST",
    body: { code },
  });

/**
 * Take the buyer's coupon back off (0238). Only a COUPON-sourced discount can be lifted
 * from the portal — an operator's manual discount answers 403 — and the same
 * `allow_customer_coupons` switch gates it as the apply call.
 */
export type PortalDiscount = {
  id: string;
  coupon: string | null;
  source: string;
  removable: boolean;
};

export const portalRemoveCoupon = (token: PortalAuth, sub: string, code?: string) =>
  portalFetch<{
    object: "discount";
    subscription: string;
    coupon: string;
    removed: true;
    next_payment: { total_minor: number; currency: string } | null;
  }>(
    token,
    `/portal/v1/subscriptions/${encodeURIComponent(sub)}/coupon${code ? `?code=${encodeURIComponent(code)}` : ""}`,
    { method: "DELETE" },
  );

/** Raw PDF passthrough for the storefront proxy route — returns the upstream Response. */
export const portalInvoicePdfResponse = async (token: PortalAuth, inv: string) =>
  fetch(`${BASE}/portal/v1/invoices/${encodeURIComponent(inv)}/pdf`, {
    headers: { ...portalAuthHeaders(token), ...(await forwardedFor()) },
    cache: "no-store",
  });

function gatewayQuery(currency?: string, purpose?: "payment" | "setup"): string {
  const q = new URLSearchParams();
  if (currency) q.set("currency", currency);
  if (purpose) q.set("purpose", purpose);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const portalListGateways = (
  token: PortalAuth,
  currency?: string,
  /** `payment` lists only the accounts that take a payment now (the Pay now chooser). */
  purpose?: "payment" | "setup",
) =>
  portalFetch<{
    object: "list";
    data: PortalGateway[];
    /**
     * What this buyer's plan will actually debit, and the amount above which the RAIL
     * they choose starts asking them to authenticate every time (null outside INR,
     * where the RBI/NPCI rule does not apply). Facts, not a recommendation — the
     * portal decides how to word it.
     */
    expected_debit_minor?: number;
    /** One row per rail for Add a payment method, each on the account that takes it. */
    method_routes?: { method: string; gateway_account: string }[];
    unattended_debit_limit_minor?: number | null;
  }>(
    token,
    // Pay now asks for the INVOICE's currency; add-card omits it and gets the
    // customer-derived one. Offering a gateway that cannot take the invoice would be a
    // control that does nothing.
    `/portal/v1/payment_methods/gateways${gatewayQuery(currency, purpose)}`,
  );

export const portalBeginSetup = (
  token: PortalAuth,
  returnUrl: string,
  cancelUrl: string,
  gatewayAccount?: string,
  methodType?: string,
) =>
  portalFetch<PortalVaultSetup>(token, "/portal/v1/payment_methods/setup", {
    method: "POST",
    body: {
      return_url: returnUrl,
      cancel_url: cancelUrl,
      ...(gatewayAccount ? { gateway_account: gatewayAccount } : {}),
      ...(methodType ? { method_type: methodType } : {}),
    },
  });

/** One open invoice the new method was charged for, and how that charge ended. */
export interface PortalCollectedInvoice {
  invoice: string;
  /** `succeeded` | `pending` | `requires_action` | `failed` | `paid_with_credit` | `scheduled`. */
  status: string;
  amount_minor: number;
  currency: string;
  /** `scheduled` only: when the debit is due. */
  scheduled_at?: string;
}

/** The saved method, plus what adding it did to the open invoices. */
export type PortalVaultedMethod = PortalPaymentMethod & {
  collected?: PortalCollectedInvoice[];
  /** False: the business does not charge open invoices when a method is added. */
  collection_enabled?: boolean;
};

export const portalCompleteVault = (
  token: PortalAuth,
  completion: {
    paymentIntent?: string;
    providerToken?: string;
    /** What a `mode: 'sdk'` client returned; sent only with `paymentIntent`. */
    clientResult?: Record<string, string>;
    /** The version of the bank debit authorization the buyer accepted. */
    achAuthorizationVersion?: string;
  },
  gatewayAccount?: string,
) =>
  portalFetch<PortalVaultedMethod>(token, "/portal/v1/payment_methods", {
    method: "POST",
    body: {
      // The intent when we have one, the raw provider token only when we don't. The
      // server accepts both and prefers the intent — see `payment_intent` on
      // `PortalVaultSetup` for why that distinction is the whole fix.
      ...(completion.paymentIntent
        ? {
            payment_intent: completion.paymentIntent,
            ...(completion.clientResult ? { client_result: completion.clientResult } : {}),
            ...(completion.achAuthorizationVersion
              ? {
                  ach_authorization: {
                    text_version: completion.achAuthorizationVersion,
                    accepted: true,
                  },
                }
              : {}),
          }
        : { token: completion.providerToken }),
      ...(gatewayAccount ? { gateway_account: gatewayAccount } : {}),
    },
  });

/**
 * "Pay now" on one invoice. Two-legged like the operator collect: the first call may
 * answer `status: 'action_required'` with a `next_action` for the buyer to complete,
 * after which the same call is repeated carrying `payment_intent`.
 */
export const portalCollectInvoice = (
  token: PortalAuth,
  invoice: string,
  body: {
    payment_intent?: string;
    /** What a `mode: 'sdk'` client returned; sent only with `payment_intent`. */
    client_result?: Record<string, string>;
    return_url?: string;
    cancel_url?: string;
    /** gwa_… — the buyer's chosen provider, when more than one can take this invoice. */
    gateway_account?: string;
    /** Pay with this wallet on the gateway's own page. */
    wallet?: "apple_pay";
    /** pm_… — pay with a method the buyer already holds. */
    payment_method?: string;
    /** Pay and save: keep the new method, with the consent text version the buyer saw. */
    save_method?: boolean;
    save_text_version?: string;
    /** The rail of the selected new-method row (`new_methods[].method`). */
    method_type?: string;
  } = {},
) =>
  portalFetch<PortalInvoiceCollection>(token, `/portal/v1/invoices/${invoice}/collect`, {
    method: "POST",
    body,
  });

/** A saved method in Pay now's step 1 (`savedPayOption` on the engine). */
export interface PortalSavedPayOption {
  payment_method: string;
  type: string;
  brand: string | null;
  last4: string | null;
  mandate_rail: string | null;
  primary: boolean;
  /** `now`: charged with the buyer present. `debit`: through its mandate, settles later. */
  kind: "now" | "debit";
  available: boolean;
  reason: string | null;
  hint: string | null;
}

/** Pay now's step 1 for one invoice: saved methods, and new ones with the gateway picked. */
export interface PortalPayOptions {
  object: "pay_options";
  invoice: string;
  amount_due_minor: number;
  saved: PortalSavedPayOption[];
  new_methods: Array<{
    gateway_account: string;
    method: string;
    method_types: string[] | null;
    /** Pay and save: `offer` = a box, `always` = saved with the text shown. Null = not saved. */
    save: {
      mode: "offer" | "always";
      checked: boolean;
      text: string;
      text_version: string;
    } | null;
  }>;
}

export const portalPayOptions = (token: PortalAuth, invoice: string, avoidGateway?: string) =>
  portalFetch<PortalPayOptions>(
    token,
    `/portal/v1/invoices/${encodeURIComponent(invoice)}/pay_options${
      avoidGateway ? `?avoid=${encodeURIComponent(avoidGateway)}` : ""
    }`,
  );

/** One invoice, with `payment_in_flight` — what the payment return leg polls. */
export const portalGetInvoice = (token: PortalAuth, invoice: string) =>
  portalFetch<PortalInvoice>(token, `/portal/v1/invoices/${encodeURIComponent(invoice)}`);

/**
 * "I won't authorise this — let me pay another way."
 *
 * Releases the authentication-pending debit blocking one invoice, so Pay now works
 * immediately instead of after the bank's link has run its full window. The engine
 * asks the gateway before it believes the buyer, so `outcome: 'settled'` is a real
 * possibility here: the debit had already landed and they were about to pay twice.
 */
export const portalAbandonAuthentication = (token: PortalAuth, invoice: string) =>
  portalFetch<PortalAuthenticationAbandoned>(
    token,
    `/portal/v1/invoices/${invoice}/abandon_authentication`,
    { method: "POST", body: {} },
  );

export interface PortalAuthenticationAbandoned {
  object: "invoice_authentication_abandoned";
  invoice: string;
  /**
   * `released` — the debit is abandoned and the invoice is payable again.
   * `settled` — it had actually gone through; the invoice is PAID, say so.
   * `failed_at_gateway` — the gateway had already failed it; also payable again.
   */
  outcome: "released" | "settled" | "failed_at_gateway";
  failure_code?: string;
  /**
   * Present on `released`: whether the debit was really cancelled at the gateway.
   *
   * `false` means it is still live and the buyer must be told to decline their bank's
   * request if it arrives, or they can be charged twice — RazorPay can never cancel one,
   * and Stripe cannot inside an India e-mandate's 26-hour pre-debit window. `true` means
   * the intent is dead and that warning would be a lie.
   */
  voided_at_gateway?: boolean;
}

export const portalSetDefault = (token: PortalAuth, pm: string) =>
  portalFetch<PortalPaymentMethod>(token, `/portal/v1/payment_methods/${pm}/default`, {
    method: "POST",
  });

/**
 * Assign a collection role. `primary` is what `portalSetDefault` above already does;
 * `backup` adds a card to the fallback list and `none` removes it. The route refuses to
 * demote the primary (409).
 */
export const portalSetRole = (token: PortalAuth, pm: string, role: "primary" | "backup" | "none") =>
  portalFetch<PortalPaymentMethod>(token, `/portal/v1/payment_methods/${pm}/role`, {
    method: "POST",
    body: { role },
  });

export const portalRemove = (
  token: PortalAuth,
  pm: string,
  /** Why the buyer deleted their last method, when the business asks. */
  why?: { reason: string; reason_text?: string },
) =>
  portalFetch<{ deleted: boolean }>(token, `/portal/v1/payment_methods/${pm}`, {
    method: "DELETE",
    ...(why ? { body: why } : {}),
  });

/** Mirrors `serializeReceipt` (src/modules/receipts/service.ts). The portal lists numbered ones only. */
export interface PortalReceipt {
  object: "receipt";
  id: string;
  number: string | null;
  customer: string | null;
  payment: string | null;
  payment_request: string | null;
  amount_minor: number;
  currency: string;
  paid_at: string;
  /** Frozen words: "Visa ···4242", "Cash". */
  method: string;
  allocations: Array<{
    invoice: string | null;
    invoice_number: string | null;
    amount_minor: number;
  }>;
  created_at: string;
}

/** The buyer's numbered receipts, newest first. Cursor-paginated. */
export const portalListReceipts = (token: PortalAuth, limit?: number) =>
  portalFetch<{
    object: "list";
    data: PortalReceipt[];
    has_more: boolean;
    next_cursor: string | null;
  }>(token, `/portal/v1/receipts${limit === undefined ? "" : `?limit=${limit}`}`);

/** Raw PDF passthrough for the storefront proxy route — returns the upstream Response. */
export const portalReceiptPdfResponse = async (token: PortalAuth, rcpt: string) =>
  fetch(`${BASE}/portal/v1/receipts/${encodeURIComponent(rcpt)}/pdf`, {
    headers: { ...portalAuthHeaders(token), ...(await forwardedFor()) },
    cache: "no-store",
  });

/** Mirrors `serializePaymentRequest` (src/modules/payment-requests/service.ts). */
export interface PortalPaymentRequest {
  object: "payment_request";
  id: string;
  status: "open" | "processing" | "paid" | "canceled" | "expired";
  mode: "charge" | "link";
  currency: string;
  /** The LIVE total still due. */
  amount_minor: number;
  payment_method: string | null;
  last_payment_error: { code: string | null; message: string | null } | null;
  expires_at: string | null;
  lines: Array<{
    invoice: string;
    invoice_number: string | null;
    due_date: string | null;
    position: number;
    state: "open" | "paid" | "settled_elsewhere" | "removed";
    amount_due_minor: number;
  }>;
  created_at: string;
}

/** The buyer's open and processing payment requests. */
export const portalListRequests = (token: PortalAuth) =>
  portalFetch<{ object: "list"; data: PortalPaymentRequest[]; has_more: boolean }>(
    token,
    "/portal/v1/requests",
  );

/** Pay a request's whole live total with a SAVED payment method, as the buyer. */
export const portalPayRequest = (
  token: PortalAuth,
  preq: string,
  body: { payment_method?: string },
) =>
  portalFetch<PortalPaymentRequest>(token, `/portal/v1/requests/${encodeURIComponent(preq)}/pay`, {
    method: "POST",
    body,
  });

// ── Credits (design G3 § 7) ─────────────────────────────────────────────────────

export interface PortalCreditUnitBalance {
  /** Credit unit key; null = money. */
  unit: string | null;
  name: string;
  plural_name: string;
  decimals: number;
  /** False = the unit has no money value. Absent on an older API = true. */
  rated?: boolean;
  /** In the unit's smallest step. */
  available_amount: number;
  /** A unit with no money rate: reserved by open holds, and used but not settled yet. */
  held_amount?: number;
  unsettled_amount?: number;
}

/** An automatic top-up of a credit unit with no money value, as the buyer sees it. */
export interface PortalAutoTopup {
  unit: string;
  unit_name: string;
  unit_plural_name: string;
  decimals: number;
  currency: string;
  trigger: "threshold" | "schedule";
  /** In the unit's smallest step. */
  threshold_amount: number | null;
  target_amount: number | null;
  pack_name: string;
  /** One purchase: its credits (smallest step) and its price before tax. */
  pack_credits_amount: number;
  pack_amount_minor: number;
  /** Packs one purchase buys (1 for a target top-up). Absent on an older API. */
  pack_quantity?: number;
  /** False: a run has no payment method that we can charge. Absent on an older API. */
  has_payment_method?: boolean;
  status: "active" | "disabled";
  disabled_reason: string | null;
}

export interface PortalCredits {
  object: "portal_credits";
  /** Empty unless the business lets the buyer manage automatic top-up. Absent on an older API. */
  auto_topups?: PortalAutoTopup[];
  balances: Array<{
    currency: string;
    balance_minor: number;
    available_minor: number;
    units: PortalCreditUnitBalance[];
  }>;
  grants: Array<{
    id: string;
    currency: string;
    unit: string | null;
    unit_name: string;
    unit_plural_name: string;
    decimals: number;
    /** False = the unit has no money value. Absent on an older API = true. */
    unit_rated?: boolean;
    remaining_amount: number;
    remaining_face_minor: number;
    category: "paid" | "promotional";
    expires_at: string | null;
    /** Plan credits: when this window renews. */
    renews_at?: string | null;
  }>;
  /** The last 50, newest first. */
  transactions: Array<{
    id: string;
    kind: string;
    currency: string;
    face_minor: number;
    /** The movement in the unit's smallest step, signed. Absent on an older API. */
    units?: number;
    unit?: string | null;
    unit_name?: string;
    unit_plural_name?: string;
    decimals?: number;
    /** False = a unit with no money value: `face_minor` is 0, show `units`. */
    unit_rated?: boolean;
    created_at: string;
    invoice_number?: string | null;
    /** True = a draw that paid for usage, with no invoice. Absent on an older API. */
    for_usage?: boolean;
  }>;
  /** The business's active credit-pack prices. */
  packs: Array<{
    price: string;
    name: string;
    currency: string;
    amount_minor: number;
    /** The credit unit's key; null for money (then `credit_amount` is in minor units). */
    unit: string | null;
    unit_name: string;
    unit_plural_name: string;
    decimals: number;
    /** Credit per pack, in the unit's smallest step. */
    credit_amount: number;
  }>;
  top_up_limits: Record<string, { min_minor?: number | null; max_minor?: number | null }>;
  /** The buyer may enter a coupon code on Buy. */
  allow_coupons?: boolean;
}

/** One pack purchase priced as the invoice will raise it, with the buyer's coupon. */
export interface PortalCreditPackQuote {
  object: "credit_pack_quote";
  price: string;
  quantity: number;
  currency: string;
  coupon: string | null;
  /** Before the discount. */
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
  amount_due_minor: number;
}

export const portalQuoteCredits = (
  token: PortalAuth,
  price: string,
  quantity: number,
  coupon?: string,
) =>
  portalFetch<PortalCreditPackQuote>(token, "/portal/v1/credits/quote", {
    method: "POST",
    body: { price, quantity, ...(coupon ? { coupon } : {}) },
  });

export const portalGetCredits = (token: PortalAuth) =>
  portalFetch<PortalCredits>(token, "/portal/v1/credits");

/** The buyer enables or disables an automatic top-up of a unit. */
export const portalSetAutoTopup = (token: PortalAuth, unit: string, enabled: boolean) =>
  portalFetch<PortalAutoTopup>(token, "/portal/v1/credits/auto_topup", {
    method: "POST",
    body: { unit, enabled },
  });

/** Opens a purchase checkout for a credit pack, pinned to this customer. */
export const portalBuyCredits = (
  token: PortalAuth,
  price: string,
  quantity: number,
  coupon?: string,
) =>
  portalFetch<{ url: string }>(token, "/portal/v1/credits/purchase", {
    method: "POST",
    body: { price, quantity, ...(coupon ? { coupon } : {}) },
  });

// ── Usage controls (design G5 § 5): spend limits and credit runway ─────────────────────

export interface PortalSpendLimit {
  object: "spend_limit";
  id: string;
  scope: "customer" | "property";
  property_key: string | null;
  /** null = each value gets the amount. */
  property_value: string | null;
  interval: "day" | "week" | "month" | "period";
  amount_minor: number;
  /** The amount that applies: a provider's customer limit raised by a reached tier. */
  effective_amount_minor: number;
  currency: string;
  mode: "hard";
  set_by: "operator" | "customer";
  /** The buyer's own row: it may lower or delete it. Provider rows are read-only. */
  editable: boolean;
  /** Spent so far in the current interval, when the engine can measure it. */
  spent_minor?: number | null;
  reached?: boolean | null;
  resets_at?: string | null;
}

export const portalListSpendLimits = (token: PortalAuth) =>
  portalFetch<{ object: "list"; data: PortalSpendLimit[]; can_add?: boolean }>(
    token,
    "/portal/v1/spend_limits",
  );
export const portalCreateSpendLimit = (
  token: PortalAuth,
  body: {
    scope: "customer" | "property";
    property_key?: string;
    property_value?: string | null;
    interval: PortalSpendLimit["interval"];
    amount_minor: number;
    currency: string;
  },
) => portalFetch<PortalSpendLimit>(token, "/portal/v1/spend_limits", { method: "POST", body });
export const portalUpdateSpendLimit = (token: PortalAuth, id: string, amountMinor: number) =>
  portalFetch<PortalSpendLimit>(token, `/portal/v1/spend_limits/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { amount_minor: amountMinor },
  });
export const portalDeleteSpendLimit = (token: PortalAuth, id: string) =>
  portalFetch<{ deleted: true }>(token, `/portal/v1/spend_limits/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

export interface PortalCreditRunway {
  object: "credit_runway";
  currency: string;
  runway_days: number | null;
  runs_out_at: string | null;
  balance_minor: number;
  burn_minor_per_day: number | null;
  auto_topup_minor: number;
}

export const portalGetCreditRunway = (token: PortalAuth) =>
  portalFetch<PortalCreditRunway>(token, "/portal/v1/credit_runway");

// ——— Plan changes (storefront Phase 2) ——————————————————————————————————————
export type PortalChangeTiming = "now" | "end_of_term";
export type PortalChangeDirection = "upgrade" | "downgrade" | "same";

export interface PortalAddonRule {
  mandatory: boolean;
  min: number | null;
  max: number | null;
  step: number;
  can_change_quantity: boolean;
  default_quantity: number;
}

export interface PortalChangeOptions {
  object: "portal_change_options";
  allowed: boolean;
  unavailable_reason: string | null;
  currency: string;
  current_period_end: string | null;
  /** Set while the subscription is in trial: every change applies now, billed when it ends. */
  trial_end: string | null;
  plans: Array<{
    price: string;
    name: string;
    description: string | null;
    amount_minor: number | null;
    model: string;
    interval: string | null;
    interval_count: number;
    current: boolean;
    /** Null when either price has no single rate: the list price cannot say which way it moves. */
    direction: PortalChangeDirection | null;
    /** The price's own name ("Pro Team"): tells two prices of one product apart. */
    price_name?: string | null;
    /** Billed for what the buyer uses. */
    metered?: boolean;
  }>;
  seats: {
    item: string;
    current: number;
    min: number;
    max: number | null;
    /** Seat limits per per-unit plan price, for a plan switch. */
    by_plan: Record<string, { min: number; max: number | null }>;
    decrease_allowed: boolean;
  } | null;
  addons: Array<{
    price: string;
    name: string;
    amount_minor: number | null;
    interval: string | null;
    interval_count: number;
    quantity: number;
    item: string | null;
    /** Per plan price. Absent = the add-on is not available on that plan. */
    rules: Record<string, PortalAddonRule>;
    /** Held but no longer offered here: the customer may remove it, not change its quantity. */
    remove_only?: boolean;
    /** Pricing model (`flat`, `per_unit`, `usage`, …). */
    model?: string;
    /** Billed for what the buyer uses: `amount_minor` is a per-unit rate. */
    metered?: boolean;
    /** The price's own name ("Per 1k calls"). */
    price_name?: string | null;
  }>;
  timing: Record<
    "upgrade" | "downgrade",
    {
      options: PortalChangeTiming[];
      default: PortalChangeTiming;
      blocked: { code: string; message: string } | null;
    }
  >;
  scheduled_change: { id: string; effective_at: string; can_cancel: boolean } | null;
}

export interface PortalChangeRequest {
  plan?: string;
  seats?: number;
  addons?: Array<{ price: string; quantity: number }>;
  timing?: PortalChangeTiming;
}

export interface PortalChangePreview {
  object: "portal_change_preview";
  /** Send both back on apply: it books at this instant and only these amounts. */
  priced_at: string;
  quote: string;
  direction: PortalChangeDirection;
  timing: PortalChangeTiming;
  timing_options: PortalChangeTiming[];
  /** Whether a change now prorates, for this direction. */
  prorate: boolean;
  /** Whether a change now is invoiced today (true) or added to the next invoice. */
  invoice_immediately: boolean;
  /** The change adds / removes an item; those are always prorated. */
  adds_items: boolean;
  removes_items: boolean;
  currency: string;
  trial_end: string | null;
  due_today: {
    lines: Array<{ description: string; amount_minor: number }>;
    tax_minor: number;
    total_minor: number;
    amount_due_minor: number;
    credit_minor: number;
    immediate_charge: boolean;
    added_to_next_invoice: boolean;
    /** Part of the credit paid back to the card or bank (`downgrade_credit: refund`). */
    refunded_minor?: number;
    /** When `added_to_next_invoice`: the date of that invoice. */
    next_invoice_at?: string | null;
    /** Coupons and other discounts inside `total_minor`. */
    discount_minor?: number;
    /** The unused period the credit lines cover. */
    credited_period_start?: string | null;
    credited_period_end?: string | null;
  } | null;
  /** What the buyer is asked to pay now; echoed back on apply. */
  total_minor: number;
  effective_at: string | null;
  next_recurring: { monthly_minor: number; currency: string };
  /** The change restarts the term today (`plan_change_term`). */
  reset_term?: boolean;
  /** The new term end, when this change starts a new term. */
  new_period_end?: string | null;
  /** The first renewal after the change, as the engine prices it (tax and discounts in). */
  next_renewal?: { at: string | null; total_minor: number } | null;
}

export interface PortalChangeResult {
  object: "portal_change";
  timing: PortalChangeTiming;
  scheduled_change: { id: string; effective_at: string } | null;
  invoice: { id: string; status: string; amount_due_minor: number; currency: string } | null;
}

const changePath = (sub: string, rest: string) =>
  `/portal/v1/subscriptions/${encodeURIComponent(sub)}/${rest}`;

export const portalChangeOptions = (token: PortalAuth, sub: string) =>
  portalFetch<PortalChangeOptions>(token, changePath(sub, "change_options"));

export const portalChangePreview = (token: PortalAuth, sub: string, body: PortalChangeRequest) =>
  portalFetch<PortalChangePreview>(token, changePath(sub, "change/preview"), {
    method: "POST",
    body,
  });

export const portalChangeApply = (
  token: PortalAuth,
  sub: string,
  body: PortalChangeRequest & { expected_total_minor: number; priced_at?: string; quote?: string },
) => portalFetch<PortalChangeResult>(token, changePath(sub, "change"), { method: "POST", body });

export const portalCancelScheduledChange = (token: PortalAuth, sub: string) =>
  portalFetch<{ object: string; id: string; canceled: boolean }>(
    token,
    changePath(sub, "scheduled_change"),
    { method: "DELETE" },
  );

// ——— Cancel flow with offers (storefront Phase 3) ———————————————————————————
export type PortalRetentionOffer =
  | { offer: "pause"; months: number | null; customer_chooses: boolean }
  | {
      offer: "downgrade";
      plan: string;
      /** The plan plus the mandatory add-ons it brings. */
      amount_minor: number;
      /** Names of the mandatory add-ons included in `amount_minor`. */
      includes: string[];
      interval: string | null;
      interval_count: number;
      starts: "now" | "end_of_term";
      starts_at: string | null;
    }
  | { offer: "discount"; summary: string }
  | { offer: "contact"; url: string };

export interface PortalCancelFlow {
  object: "portal_cancel_flow";
  currency: string;
  reason: "off" | "optional" | "required";
  reasons: Array<{ code: string; label: string }>;
  offers: PortalRetentionOffer[];
  timing: "immediately" | "end_of_term";
  period_end: string | null;
  status: string;
  /** "You can undo this until then" is true only when the business lets customers undo. */
  can_undo: boolean;
}

export const portalCancelFlow = (token: PortalAuth, sub: string) =>
  portalFetch<PortalCancelFlow>(
    token,
    `/portal/v1/subscriptions/${encodeURIComponent(sub)}/cancel_flow`,
  );

export const portalTakeRetentionOffer = (
  token: PortalAuth,
  sub: string,
  body: { offer: PortalRetentionOffer["offer"]; months?: number; reason_code?: string },
) =>
  portalFetch<{ object: string; offer: string; url?: string; starts?: string }>(
    token,
    `/portal/v1/subscriptions/${encodeURIComponent(sub)}/retention_offer`,
    { method: "POST", body },
  );
