/**
 * Hosted-checkout API client (#10d). Authenticates with the price-scoped
 * checkout token ONLY — this module must never import lib/api.ts (which injects
 * the org API key). Used exclusively by app/(storefront)/checkout/[token]/*.
 * Mirrors lib/portal-api.ts.
 */
import type { RazorpayCheckoutDescriptor } from "./razorpay-checkout";
import type { FormPostDescriptor, GatewaySdkDescriptor } from "./gateway-sdk";
import { forwardedFor } from "./forwarded-for";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

/** Proration preview for a plan change (#10b) — integer minor units. */
/**
 * One destination of a term credit, with the credit TYPE that destination implies.
 * `adjustment` cancels a debt on a named invoice; `refundable` is spendable value
 * (`this_invoice` offsets the proration invoice, `balance` is kept); `bucket_restore` goes
 * back to the promotional / excess bucket and is never cashable; `stranded` reaches nobody.
 *
 * ⚠ Do not infer the kind from which amount is non-zero — one change can raise BOTH an
 * adjustment and a refundable note, which is precisely the case an inference mislabels.
 */
export interface CreditDestination {
  kind: "adjustment" | "refundable" | "bucket_restore" | "stranded";
  destination: "open_invoice" | "this_invoice" | "balance" | "payment_method" | "buckets" | "none";
  amount_minor: number;
  /** The printed invoice number an `adjustment` cancelled. */
  invoice?: string;
}

export interface CheckoutChangePreview {
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  /**
   * `taxMinor` split into the rows the INVOICE will print — CGST + SGST intra-state, one
   * IGST row inter-state, a single row elsewhere. Sums exactly to `taxMinor`; empty when
   * there is no tax to name, in which case the page falls back to one "Tax" row.
   */
  taxLines: Array<{ label: string; amountMinor: number }>;
  /**
   * The money that actually moves: `(invoice total) − (credit note total)`. NEGATIVE when
   * the buyer is credited.
   *
   * ⚠ `subtotalMinor + taxMinor` does NOT equal this on a change that credits anything —
   * `subtotalMinor` is net of the credit's PRE-tax amount while `taxMinor` is the invoice's
   * tax, gross of it. The footer ladder closes that gap with an explicit "tax reversed" row.
   */
  totalMinor: number;
  amountDueMinor: number;
  /** POST-tax balance applied (refundable + excess). */
  creditsAppliedMinor: number;
  /** Pre-tax promotional discount, already inside `totalMinor`. Render above tax. */
  promotionalDiscountMinor: number;
  /** Face value of the credit note the confirm issues — credited time plus the tax it
   *  reverses. (This used to warn that `totalMinor` was "the UNTAXED net, 18% short of
   *  this"; that was the 2026-08-30 defect, not a convention — `totalMinor` is now tax-
   *  correct and a pure removal equals exactly minus this.) */
  creditNoteTotalMinor?: number;
  /** The part of that note the invoice cannot absorb — it lands on the buyer's balance and
   *  is spent at their NEXT renewal, so the "From your next payment" figure must net it.
   *  `nextPayment` itself cannot see it: that is priced against the balance as it stands
   *  before this change creates the credit. */
  refundableCreditAddedMinor?: number;
  /**
   * The slice of the credit note spent cancelling what the buyer STILL OWES on the term's own
   * invoices, before any of it can reach their balance. Their debt goes away rather than being
   * refunded, so this is value received — just not spendable balance.
   *
   * ⚠ DO NOT compute the invoice's credit as `creditNoteTotalMinor − this`. That subtraction
   * is right only where every other leg is zero — which is true of the unpaid-term shape this
   * page was debugged against (₹88,664.44 − ₹22,098.13 = ₹66,566.31) and false as soon as a
   * downgrade overflows to the balance, a bucket-funded invoice returns slices, or either
   * router strands a residue. Use `creditAppliedToThisInvoiceMinor`, which the engine reports
   * from the routing itself.
   *
   * Absent on a fully-paid term, which is every shape that existed before.
   *
   * ⚠ NO CONSUMER, on either side, as of 2026-08-31 (f343eabc). The storefront read it for the
   * `Cleared your unpaid invoice` add-back row and the operator surfaces for `Cleared unpaid
   * invoices`; all three ladders are now NET and the slice is narrated from
   * `creditDestinations[]` instead, which carries its KIND and the printed invoice number.
   * Still emitted and still asserted by `verify:estimates` — it is part of the public estimate
   * contract and a real number, not dead weight — but if you are reaching for it to render
   * something, reach for `creditDestinations` and read `lib/credit-legs.ts` first.
   */
  creditAppliedToOpenInvoicesMinor?: number;
  /**
   * The slice of the note that offsets THIS invoice — the row the ladder subtracts:
   *
   *     Invoice total   71,654.32
   *     Credit applied −66,566.31   ← this
   *     Total due now    5,088.01   ← `amountDueMinor`
   *
   * The GROSS credit leaves the ladder and becomes the note beneath it ("₹88,664.44 credited
   * for unused time; ₹22,098.13 of it cleared your unpaid invoice"): `amountDueMinor` is
   * already net of the applied credit, with the gross carried separately.
   *
   * Distinct from `creditsAppliedMinor` — that is PRE-EXISTING balance and keeps its own row.
   */
  creditAppliedToThisInvoiceMinor?: number;
  /** The invoice's OWN total — the ladder's top figure. ⚠ Not `subtotalMinor + taxMinor`:
   *  that subtotal is net of the credit lines and goes negative on a downgrade. */
  invoiceTotalMinor?: number;
  /** The invoice's PRE-TAX subtotal — the row above tax in a pure charges table. ⚠ Not
   *  `invoiceTotalMinor − taxMinor`: equal only while `promotionalDiscountMinor` is 0. */
  invoiceSubtotalMinor?: number;
  /** Where every slice of the note went, typed, for the prose Credits section. Sums to
   *  `creditNoteTotalMinor`, so the prose cannot leave an unnamed remainder. */
  creditDestinations?: CreditDestination[];
  /** The unused window the credit is FOR, ISO instants. */
  creditedPeriodStart?: string;
  creditedPeriodEnd?: string;
  /** Returned to the promotional / excess buckets: real value, but a bucket balance that
   *  cannot offset this invoice. */
  creditReturnedToBucketsMinor?: number;
  /** The slice that reaches nobody. Carried so the note can account for 100% of the gross
   *  rather than leaving an unnamed remainder. */
  creditStrandedMinor?: number;
  /** The post-change renewal total as `estimateChange` prices it. The `nextPayment` strip is
   *  priced by a DIFFERENT calculator (`estimateNewSubscription`); `verify:checkout` asserts
   *  the two agree rather than merging them — see the field's note in checkout/service.ts. */
  nextRenewalTotalMinor?: number;
  immediateCharge: boolean;
  /**
   * Inside a trial: the ISO instant of the trial-end invoice, and nothing is
   * collected today. `immediateCharge: false` on its own does NOT mean a credit —
   * see the field's doc in `src/modules/checkout/service.ts`.
   */
  dueAtTrialEnd: string | null;
  termReset: boolean;
  newPeriodEnd: string | null;
  lines: Array<{ description: string; amountMinor: number }>;
}

/**
 * What the composition costs per billing period, WITH tax — the checkout's answer to the
 * portal's "Next payment · ₹67,993.96 · includes CGST (9.00%)…" strip. Integer minor
 * units. ABSENT when the engine cannot state it honestly (no customer yet, so no address
 * and no tax; no recurring line; an estimator refusal) — absence means say nothing, never
 * render a zero.
 */
export interface CheckoutNextPayment {
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  taxLines: Array<{ label: string; amountMinor: number }>;
  totalMinor: number;
  amountDueMinor: number;
  /** A metered line is in there, so this is the fixed-charge floor. */
  excludesUsage: boolean;
  /** Covers items this page does not list — everything already on the subscription. */
  includesExistingItems: boolean;
}

/** One displayed line of the checkout. */
export interface CheckoutItemView {
  name: string;
  amount: string;
  currency: string;
  quantity: number;
  /** plan | addon | charge */
  kind: string;
  /** The product's picture, or null. Absent on older engines. */
  image_url?: string | null;
}

export interface CheckoutView {
  object: "checkout_view";
  /**
   * The checkout session's public id (`cs_…`) — NOT its token. Used as the non-secret
   * scope key for the redirect-leg stash (`lib/pending-vault-setup.ts`).
   */
  id: string;
  /** Brand Styles (0185) — the same brand the portal and billing email render. */
  business: {
    name: string;
    /** `live` | `test`. Absent on older engines. */
    livemode?: string;
    logo_url: string | null;
    icon_url: string | null;
    favicon_url: string | null;
    brand_color: string | null;
    /** IANA zone for dates the buyer reads. Pass it to `fmtDate`; null falls back to UTC. */
    timezone: string | null;
  };
  items: CheckoutItemView[];
  /** Coupon codes applied on completion. */
  coupons: string[];
  /**
   * May the buyer add or remove those codes? `businesses.allow_customer_coupons` (0238),
   * off by default. The promo box renders only when this is true — the routes behind it
   * 403 otherwise, and a box that refuses is worse than no box.
   */
  allow_coupons: boolean;
  /** Code → why completion would refuse it; those codes are left out of every figure. */
  coupon_refusals?: Record<string, string>;
  /**
   * The business's checkout field matrix (0245), keyed `customer.phone`, `billing.line2`…
   * Hidden fields are not rendered; required ones are required on the page too.
   */
  field_config?: Partial<Record<string, "show" | "hide" | "mandatory">>;
  /** Render a PO number field (Hosted pages → collect PO number). */
  collect_po_number?: boolean;
  /** Per-period cost incl. tax — see `CheckoutNextPayment`. */
  nextPayment?: CheckoutNextPayment;
  status: "open" | "completed" | "expired" | string;
  /**
   * 'change' = this link upgrades/downgrades an existing subscription (#10b).
   * 'purchase' = one-time items, paid once, no subscription.
   */
  mode: "create" | "change" | "purchase";
  /** mode='purchase' only: what is due today and the payment-method choice. */
  purchase?: CheckoutPurchase;
  /** Opened from a payment link: each line and what the buyer may change about it. */
  offer?: { lines: CheckoutOfferLine[] };
  /** mode='create': the first invoice, one-time items and tax included. `trial` = nothing today. */
  dueToday?: {
    currency: string;
    trial: boolean;
    totalMinor: number;
    taxMinor: number;
    amountDueMinor: number;
  };
  change?: {
    subscriptionId: string;
    currentPlan: { name: string; amount: string } | null;
    /** Items this change drops. Struck-through rows — a removal must be visible. */
    removedItems?: Array<{ name: string; amount: string; quantity: number }>;
    preview?: CheckoutChangePreview;
    hasPaymentMethod: boolean;
    /** The instrument this change will be billed to, so the page can NAME it. */
    paymentMethod?: {
      type: string;
      brand: string | null;
      last4: string | null;
      mandateRail: string | null;
    };
    /**
     * The mandate this change needs. **Absent when there is nothing to say** — no
     * instrument, or one on no mandate rail (every international card) — and presence is
     * the only gate this page applies. Do NOT reintroduce a country or currency check
     * here: an Indian buyer paying USD has no mandate to speak of, and a SEPA customer
     * has one, so the engine's answer is the only correct test.
     */
    mandate?: CheckoutChangeMandate;
    /**
     * Present when completing this session REACTIVATES a cancelled subscription. `preview`
     * is then the fresh term's invoice (no proration) and `currentPlan` the plan it was on.
     * `startsAt` is the backdated term start (ISO); null = the term starts on completion.
     */
    reactivation?: { startsAt: string | null };
  };
  /** Where to send the buyer after a clean completion (http/https, operator-supplied). */
  redirect_url: string | null;
  /** Where the buyer's "Cancel" link goes. */
  cancel_url: string | null;
  /**
   * The billing details already on this session's customer, for the details step to
   * PREFILL from. Absent until the session has a customer (a create-mode buyer who has not
   * submitted the details step yet).
   *
   * Not a nicety: `checkoutSetCustomerAction` REPLACES the address, so a blank form that
   * the buyer partly fills nulls the rest of it on the real customer row — see the engine's
   * `CheckoutView.customer` note for the full reasoning and the security scoping.
   */
  customer?: CheckoutCustomerDetails;
  /** Hosted checkout layout. Absent on an older engine = steps. */
  layout?: "steps" | "one_page";
  wallets_first?: boolean;
  /** What the buyer must agree to before paying (storefront settings). */
  consent?: {
    recurring_text: string | null;
    terms_url: string | null;
    privacy_url: string | null;
    terms_required: boolean;
    marketing_offered: boolean;
  };
}

/** What the details step prefills from — see `CheckoutView.customer`. */
export interface CheckoutCustomerDetails {
  /** Create mode only: a change link's customer is pinned and its email uneditable. */
  email?: string | null;
  /**
   * snake_case, the shape `AddressFields` reads and this form posts back. Spelled out
   * rather than imported from the component, matching `PortalMe['customer'].address` —
   * a lib client should not reach into components/ for a type, and structural typing
   * makes it assignable to `AddressValue` anyway.
   */
  address: CheckoutAddressDetails | null;
  tax_registration_number: string | null;
  /** The default ship-to. Absent when this checkout does not collect one. */
  shipping_address?: CheckoutAddressDetails | null;
}

export interface CheckoutAddressDetails {
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
}

/** Sizing for the mandate a change checkout needs — see `resolveSessionMandateRequirement`. */
export interface CheckoutChangeMandate {
  currency: string;
  /** What the buyer is asked to authorise if they (re-)register in this session. */
  requiredCeilingMinor: number;
  /** The largest single debit this change leads to — what that ceiling is sized from. */
  largestDebitMinor: number;
  /** The ceiling on the instrument that would be charged; null when it rides no mandate. */
  currentCeilingMinor: number | null;
  currentRail: string | null;
  /**
   * The card on file would REFUSE this change (`mandateRefusal` says so before any
   * gateway call). No rail lets a ceiling be raised, so the only remedy is a fresh
   * authorisation — which is why the card step stops being optional when this is true.
   */
  reauthorizationRequired: boolean;
  /** Rails that cannot be registered this high at all (NPCI caps UPI Autopay at ₹1,00,000). */
  railsOverCap: string[];
}

/**
 * An instrument the buyer already holds, offered on the card step so they can pick one
 * instead of being pushed into adding another. Mirrors the portal's shape — same engine
 * serializer — including the MANDATE, which is the field that matters here: a buyer whose
 * plan outgrew one card can see that another already covers it.
 */
export interface CheckoutPaymentMethod {
  id: string;
  type: string;
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  status: string | null;
  is_default: boolean;
  mandate?: {
    rail: string | null;
    status: string | null;
    max_amount_minor: number | null;
    currency: string | null;
  } | null;
}

export interface CheckoutCustomer {
  object: "checkout_customer";
  id: string;
  email: string | null;
  name: string | null;
  billing_details_complete: boolean;
}

export const checkoutListPaymentMethods = (token: string) =>
  checkoutFetch<{ object: "list"; data: CheckoutPaymentMethod[] }>(
    token,
    "/checkout/v1/payment_methods",
  );

export interface CheckoutVaultSetup {
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
   * The zero-amount `pi_…` this add-card was recorded as. COMPLETE WITH THIS, not with
   * the provider token: the gateway's webhook harvests the same setup intent for the
   * buyer who never comes back, and only going through it makes the two one atomic
   * claim instead of two `payment_methods` rows.
   */
  payment_intent?: string;
}

/** One line of a payment-link checkout and the buyer's room to change it. */
export interface CheckoutOfferLine {
  price: string;
  name: string;
  amount: string;
  /** In the order now; 0 = an optional line not chosen. */
  quantity: number;
  adjustable: boolean;
  min: number;
  max: number;
  optional: boolean;
  /** The product's picture, or null. */
  image_url?: string | null;
}

/** A one-time purchase: what is due today, and whether the method is kept. */
export interface CheckoutPurchase {
  save_payment_method: "never" | "always" | "ask";
  /** The link names a known customer: their email is fixed. */
  customer_pinned: boolean;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  tax_lines: Array<{ label: string; amount_minor: number }>;
  total_minor: number;
  amount_due_minor: number;
  /** False until the buyer's address is known; the figures then exclude tax. */
  tax_known: boolean;
}

export interface CheckoutComplete {
  object: "checkout_complete";
  /** Absent on a purchase, which creates no subscription. */
  subscription_id?: string;
  /** mode='purchase': the paid invoice. */
  invoice_id?: string;
  customer_id: string;
  /** The `pi_…` that settled the first invoice, when one was consumed. */
  payment_intent?: string;
  /** A signup whose intent capture was refused AFTER the subscription was created. */
  payment_error?: { code: string; message: string };
  /**
   * CHANGE mode: the plan really did change, but the invoice it raised was not collected
   * — a decline, a mandate ceiling, or no instrument to collect against. The completion
   * is still a success (the items moved), so this is reported ALONGSIDE it rather than as
   * an error; the page has to say both things or the buyer walks away holding an unpayable
   * invoice they were told nothing about.
   */
  unpaid_invoice?: {
    id: string;
    amount_due_minor: number;
    currency: string;
    /**
     * WHY it is open, and the page must say a different sentence for each.
     *
     * `processing` = an attempt is LIVE at the gateway — an Indian mandate debit (UPI
     * Autopay, an e-mandate presentation) settles by webhook seconds to days later, and
     * the engine books it `in_progress` while it waits. Nobody was refused. The page
     * used to fold this into "we could not collect", which told a buyer their live
     * payment had failed — usually seconds before it succeeded.
     *
     * `outstanding` = nothing is in flight: either a real refusal (`failure` is set) or
     * no attempt was ever made (auto-collection off / no instrument, `failure` absent).
     */
    state: "processing" | "outstanding";
    failure?: { code: string; message: string };
  };
}

/**
 * The provider-side challenge a buyer has to complete, in the three shapes every
 * storefront surface already handles. Identical to `PortalNextAction` and to the
 * engine's `BuyerAuthorization` (src/providers/types.ts) — one descriptor, because a
 * 3DS challenge on a charge and a mandate approval on a vault setup are the same
 * handshake.
 */
export interface CheckoutNextAction {
  mode: "redirect" | "checkout" | "client_secret" | "sdk" | "form_post";
  approvalUrl?: string;
  clientSecret?: string;
  publishableKey?: string;
  checkout?: RazorpayCheckoutDescriptor;
  sdk?: GatewaySdkDescriptor;
  formPost?: FormPostDescriptor;
}

/**
 * `POST /checkout/v1/complete` answered **402**: the gateway wants the buyer to
 * authenticate before the subscription can be created.
 *
 * Nothing was created — the engine discards the provisional subscription and releases
 * the session claim (see `CheckoutActionRequiredError`) — so this is not an error to
 * report, it is the middle of a two-leg flow. The buyer completes `nextAction`, then the
 * SAME completion is re-posted carrying `paymentIntentId`, which settles the first
 * invoice by consuming that authorization instead of charging the card again.
 *
 * ⚠️ `paymentIntentId` is OUR `pi_…`, not whatever the provider's SDK hands back. The
 * engine consumes its own intent; the gateway's reference means nothing to it.
 */
export interface CheckoutActionRequired {
  paymentIntentId: string;
  nextAction: CheckoutNextAction;
  /** The engine's own sentence, kept for the branch that cannot render the challenge. */
  message: string;
}

/** The live state of one checkout's invoice — polled while `state` is `processing`. */
export interface CheckoutInvoiceState {
  object: "checkout_invoice";
  id: string;
  status: string;
  amount_due_minor: number;
  currency: string;
  state: "paid" | "processing" | "outstanding";
  failure?: { code: string; message: string };
}

export interface CheckoutCustomerInput {
  /**
   * OPTIONAL because a CHANGE checkout has none to give: its customer — and therefore their
   * email — is pinned to the target subscription's owner at mint time, and a public link must
   * not repoint it. Create mode still requires one; the engine enforces that where it knows the
   * session's mode.
   */
  email?: string;
  name?: string;
  address?: CheckoutAddressInput;
  /**
   * Under `field_config["shipping.address"]` show or mandatory. Omitted on a details post
   * under `show` = the buyer has no shipping address.
   */
  shipping_address?: CheckoutAddressInput;
  /** The buyer's own registration number (GSTIN for India). Prints on their invoices. */
  tax_registration_number?: string;
}

export interface CheckoutAddressInput {
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
}

async function checkoutFetch<T>(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  /**
   * The parsed body of a NON-2xx response, when there was one.
   *
   * Every caller but one wants the folded `error` string and nothing else. The exception
   * is `/checkout/v1/complete`'s **402**, which is not a failure at all: it carries the
   * payment intent and the challenge the buyer has to complete, and folding it into a
   * message is precisely how the checkout dead-ended on 3DS. Read it only where the
   * status says it means something — never as a general-purpose escape hatch.
   */
  payload?: unknown;
}> {
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
      Authorization: `Bearer ${token}`,
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
  /**
   * Fold `details` into the message.
   *
   * A zod rejection puts the field-level reasons in `error.details` (see `badRequest` in
   * src/api/helpers.ts). Its `message` carries them too now, but this predates that and
   * reads `details` so each reason keeps its field name. On a PUBLIC checkout there is no
   * operator to ask, so the page has to say which field it means.
   *
   * Field name included, because "is not a valid state code for India" is only
   * actionable if you know it is talking about the state and not the country.
   */
  const payload = (
    json as
      | { error?: { message?: string; details?: Record<string, string[] | undefined> } }
      | undefined
  )?.error;
  const fieldErrors = Object.entries(payload?.details ?? {}).flatMap(([field, msgs]) =>
    (msgs ?? []).map((m) => `${field}: ${m}`),
  );
  const error = fieldErrors.length ? fieldErrors.join("; ") : (payload?.message ?? res.statusText);
  return { ok: false, status: res.status, error, payload: json };
}

export const checkoutSession = (token: string) =>
  checkoutFetch<CheckoutView>(token, "/checkout/v1/session");

export const checkoutSetCustomer = (token: string, body: CheckoutCustomerInput) =>
  checkoutFetch<CheckoutCustomer>(token, "/checkout/v1/customer", { method: "POST", body });

/**
 * Add / remove a coupon code the BUYER typed. Both answer with the RE-PRICED view, so the
 * page shows the new total from one round trip instead of posting and then re-reading.
 */
export const checkoutAddCoupon = (token: string, code: string) =>
  checkoutFetch<CheckoutView>(token, "/checkout/v1/coupon", { method: "POST", body: { code } });

export const checkoutRemoveCoupon = (token: string, code: string) =>
  checkoutFetch<CheckoutView>(token, `/checkout/v1/coupon?code=${encodeURIComponent(code)}`, {
    method: "DELETE",
  });

/**
 * The gateways this checkout may pay through, plus the facts the rail choice depends on.
 *
 * `unattended_debit_limit_minor` is null for a non-INR buyer — the RBI rule does not
 * apply, so there is nothing to advise. `expected_debit_minor` is 0 for a brand-new
 * signup, because it reads existing subscriptions; treat 0 as "unknown", not "free".
 */
export interface CheckoutGateway {
  id: string;
  gateway_key: string;
  label: string;
  /** What the gateway actually supports. Null = the engine did not narrow it. */
  method_types: string[] | null;
  /** Our bank debit authorization, shown before a bank account is saved here. */
  ach_authorization?: AchAuthorizationText | null;
  /** The most one debit may be on a rail at this gateway (PayU UPI: ₹15,000), minor units. */
  mandate_ceiling_cap_minor?: Partial<Record<string, number>>;
}

/** The engine's ACH authorization text (`src/modules/payment-methods/ach-authorization.ts`). */
export interface AchAuthorizationText {
  version: string;
  title: string;
  paragraphs: string[];
  agreement: string;
}

export interface CheckoutGatewayList {
  object: "list";
  data: CheckoutGateway[];
  expected_debit_minor: number;
  unattended_debit_limit_minor: number | null;
  /**
   * The ceiling the mandate will be registered with if the buyer sets one up here — sized
   * from THIS session (plan + add-ons + tax, plus headroom), not from what they already
   * have. Null when the session could not be priced.
   */
  required_mandate_ceiling_minor: number | null;
  /** Rails that cannot be registered that high (NPCI caps UPI Autopay at ₹1,00,000). */
  rails_over_cap: string[];
  /** The currency the figures above are in; null when none could be resolved. */
  debit_currency: string | null;
}

export const checkoutGateways = (token: string) =>
  checkoutFetch<CheckoutGatewayList>(token, "/checkout/v1/gateways");

/**
 * Re-read the invoice a completed checkout left behind.
 *
 * The completion is a snapshot of a race: an async debit is `processing` at that
 * instant and very often `paid` a few seconds later. Polling this is what lets the
 * done screen wait for the real answer instead of publishing the snapshot as a verdict.
 */
export const checkoutInvoiceState = (token: string, invoice: string) =>
  checkoutFetch<CheckoutInvoiceState>(
    token,
    `/checkout/v1/invoice?invoice=${encodeURIComponent(invoice)}`,
  );

/** The consent boxes as posted, with the exact recurring sentence the buyer agreed to. */
export type CheckoutConsentPost = {
  recurring: boolean;
  terms: boolean;
  marketing: boolean;
  recurring_text?: string;
};

/** `methodType` is the RAIL — card / UPI Autopay / netbanking e-mandate. Omitted, the
 *  API defaults to `card`, which is why the checkout could only ever add a card. */
export const checkoutBeginSetup = (
  token: string,
  returnUrl: string,
  cancelUrl: string,
  gatewayAccount?: string,
  methodType?: string,
  /** The consent boxes: a checkout the gateway webhook completes is checked against these. */
  consent?: CheckoutConsentPost,
) =>
  checkoutFetch<CheckoutVaultSetup>(token, "/checkout/v1/setup", {
    method: "POST",
    body: {
      return_url: returnUrl,
      cancel_url: cancelUrl,
      ...(gatewayAccount ? { gateway_account: gatewayAccount } : {}),
      ...(methodType ? { method_type: methodType } : {}),
      ...(consent ? { consent } : {}),
    },
  });

/**
 * How to complete the card step.
 *
 * The instrument fields are all optional, for two different reasons: a change-mode
 * checkout reuses the card already on file (the API requires an instrument only in
 * create mode), and `setupIntent` vs `providerToken` is the same preference the portal
 * makes — the intent when the add-card was recorded as one, the raw token only for a
 * provider that has no intent. See `payment_intent` on `CheckoutVaultSetup`.
 *
 * `paymentIntent` is the SECOND LEG and rides ALONGSIDE the instrument, never instead of
 * it: create mode still refuses a completion with no instrument
 * (`completeCheckout` → "A payment method token is required"), and re-posting the same
 * `setupIntent` is safe because `completeVaultFromIntent` resolves the row the already
 * consumed intent names rather than vaulting a second one.
 */
export interface CheckoutCompletion {
  setupIntent?: string;
  providerToken?: string;
  /** A `pm_…` the buyer already holds, picked from "Manage cards". */
  paymentMethod?: string;
  /** OUR `pi_…`, echoed back from a 402 — see `CheckoutActionRequired`. */
  paymentIntent?: string;
  /** The buyer's PO number, when the business collects one. */
  poNumber?: string;
  /** What the buyer ticked; the engine checks it against the page's consent block. */
  consent?: CheckoutConsentPost;
  /** Turnstile token, sent once the engine has asked for a bot check. */
  botCheckToken?: string;
  /**
   * What a `mode: 'sdk'` client returned. It belongs to `paymentIntent` when that is set,
   * else to `setupIntent`. Never repeated onto a later leg.
   */
  clientResult?: Record<string, string>;
  /** The version of the bank debit authorization the buyer accepted (with `setupIntent`). */
  achAuthorizationVersion?: string;
}

/** What `POST /checkout/v1/complete` can answer. 402 is a STAGE, not a failure. */
export type CheckoutCompleteResult =
  | { ok: true; status: number; data: CheckoutComplete }
  | { ok: false; status: number; error: string; actionRequired: CheckoutActionRequired }
  | { ok: false; status: number; error: string; actionRequired?: undefined };

/**
 * Complete the checkout.
 *
 * A **402** is decoded rather than folded into `error`: it carries the intent the buyer
 * must authenticate and the challenge to put in front of them, and the caller re-posts
 * the same completion with `paymentIntent` afterwards. Folding it — which is what this
 * did until now — is what left a challenged buyer holding a red toast and no way forward.
 */
export const checkoutComplete = async (
  token: string,
  completion: CheckoutCompletion = {},
  gatewayAccount?: string,
  /**
   * Where a REDIRECT-mode challenge on the first charge returns the buyer.
   *
   * Sent on leg 1, because that is the call that mints the intent — by the time the 402
   * comes back the PayPal order already exists and its `experience_context` is fixed.
   * Sending it on leg 2 as well costs nothing and keeps the two legs byte-identical apart
   * from `payment_intent`, which is what `usePaymentChallenge` promises.
   *
   * Optional here as it is on the route: a caller with no way to receive a redirect back
   * omits it and gets the old behaviour rather than a URL that lies.
   */
  redirect?: { returnUrl: string; cancelUrl: string },
): Promise<CheckoutCompleteResult> => {
  const res = await checkoutFetch<CheckoutComplete>(token, "/checkout/v1/complete", {
    method: "POST",
    body: {
      ...(completion.setupIntent
        ? { setup_intent: completion.setupIntent }
        : completion.providerToken
          ? { token: completion.providerToken }
          : completion.paymentMethod
            ? { payment_method: completion.paymentMethod }
            : {}),
      ...(completion.paymentIntent ? { payment_intent: completion.paymentIntent } : {}),
      ...(completion.poNumber ? { po_number: completion.poNumber } : {}),
      ...(completion.consent ? { consent: completion.consent } : {}),
      ...(completion.botCheckToken ? { bot_check_token: completion.botCheckToken } : {}),
      ...(completion.clientResult ? { client_result: completion.clientResult } : {}),
      ...(completion.achAuthorizationVersion
        ? {
            ach_authorization: {
              text_version: completion.achAuthorizationVersion,
              accepted: true,
            },
          }
        : {}),
      ...(gatewayAccount ? { gateway_account: gatewayAccount } : {}),
      ...(redirect ? { return_url: redirect.returnUrl, cancel_url: redirect.cancelUrl } : {}),
    },
  });
  if (res.ok && res.data) return { ok: true, status: res.status, data: res.data };
  const error = res.error ?? "We could not complete the checkout.";
  if (res.status === 402) {
    const body = res.payload as
      | { payment_intent?: { id?: string }; next_action?: CheckoutNextAction | null }
      | undefined;
    const id = body?.payment_intent?.id;
    // Both halves or neither: an intent with no challenge is nothing the buyer can act
    // on, and a challenge with no intent has nothing to re-post. Either way the honest
    // answer is the plain error below, not a half-built challenge screen.
    if (id && body?.next_action) {
      return {
        ok: false,
        status: res.status,
        error,
        actionRequired: { paymentIntentId: id, nextAction: body.next_action, message: error },
      };
    }
  }
  // The engine asks for a bot check by code; the page shows the widget and tries again.
  const code = (res.payload as { error?: { code?: string } } | undefined)?.error?.code;
  return {
    ok: false,
    status: res.status,
    error,
    ...(code === "bot_check_required" || code === "bot_check_failed" ? { botCheck: true } : {}),
  };
};

/** A public payment link opened: the fresh checkout session it minted for this visitor. */
export async function openPaymentLink(
  link: string,
): Promise<{ ok: true; token: string } | { ok: false; status: number; error: string }> {
  const res = await fetch(`${BASE}/checkout/v1/links/${encodeURIComponent(link)}/open`, {
    method: "POST",
    // The buyer's address chain, so the engine limits per buyer and not per this server.
    headers: { ...(await forwardedFor()) },
    cache: "no-store",
  });
  let json: { token?: string; error?: { message?: string } } = {};
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  if (res.ok && json.token) return { ok: true, token: json.token };
  return {
    ok: false,
    status: res.status,
    error: json.error?.message ?? "This payment link is not available",
  };
}

/** One card on a business's public pricing page. */
export interface PricingPageLink {
  id: string;
  name: string;
  mode: "create" | "purchase";
  description: string | null;
  /** That product's picture, or null. */
  image_url?: string | null;
  price: { amount: string; interval: string | null; interval_count: number };
}

export interface PricingPage {
  object: "pricing_page";
  business: { name: string; livemode: string; logo_url: string | null; brand_color: string | null };
  links: PricingPageLink[];
}

/** A business's public pricing page: the payment links it marked for it. */
export async function getPricingPage(biz: string): Promise<PricingPage | null> {
  const res = await fetch(`${BASE}/checkout/v1/pricing/${encodeURIComponent(biz)}`, {
    headers: { ...(await forwardedFor()) },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as PricingPage;
}

/** Change one line of a payment-link checkout (0 removes an optional line). */
export const checkoutSetItem = (token: string, price: string, quantity: number) =>
  checkoutFetch<{ object: "checkout_items"; updated: boolean }>(token, "/checkout/v1/items", {
    method: "POST",
    body: { price, quantity },
  });

/** Record that the page was shown, with its layout and the buyer's device class. */
export const checkoutRecordView = (
  token: string,
  body: { layout: "steps" | "one_page"; device_class: "mobile" | "tablet" | "desktop" },
) =>
  checkoutFetch<{ object: "checkout_view"; recorded: boolean }>(token, "/checkout/v1/viewed", {
    method: "POST",
    body,
  });
