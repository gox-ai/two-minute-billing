/**
 * The payment provider adapter contract.
 *
 * This is the ONLY surface through which the billing engine talks to Stripe,
 * RazorPay, PayPal, etc. Note what is deliberately ABSENT: no plans, no
 * subscriptions, no invoices, no proration. Those belong to our engine
 * (BLUEPRINT ADR-001). A provider does exactly two jobs:
 *   1. execute money movement (charge / refund) against a vaulted method, and
 *   2. vault payment methods + tell us when money events happen (webhooks).
 *
 * Adding a new provider = implementing this interface. The engine never imports
 * a provider SDK directly — only the adapter under src/providers/<name>/ does.
 */

import type { MethodType } from "./method-types";

// 'tmtest' (the TM Test Gateway) is the in-process test provider used to
// build/verify the engine before real provider credentials exist (BLUEPRINT
// ADR-001 — the engine owns state, providers are swappable). The old 'mock'
// test double has been removed in favor of it.
export type ProviderKey =
  | "stripe"
  | "razorpay"
  | "paypal"
  | "gocardless"
  | "braintree"
  | "cashfree"
  | "adyen"
  | "checkoutcom"
  | "authorizenet"
  | "square"
  | "mollie"
  | "payu"
  | "cybersource"
  | "tmtest";

export interface ProviderCapabilities {
  /** Supports issuing refunds via API. */
  refunds: boolean;
  /** Supports partial refunds. */
  partialRefunds: boolean;
  /** Currencies this provider/account can charge, ISO 4217 (empty = any). */
  currencies: string[];
  /**
   * Instruments this gateway account can vault and charge (`./method-types`). Bank
   * debits settle asynchronously — the charge returns pending and the real outcome
   * arrives by webhook days later, so they require the inbound webhook path.
   */
  methods: MethodType[];
  /**
   * Above the MANDATE'S OWN MAXIMUM, this gateway offers the buyer a link to authorise
   * the debit anyway, instead of simply refusing it.
   *
   * Stripe's India recurring-payments page: *"if the payment amount is above 15,000 INR
   * **or the mandate's maximum amount**, the pre-debit notification contains a link to
   * perform AFA (3DS) to authorise the payment."* We modelled only the ₹15,000 half, so
   * `mandateRefusal` refused over-ceiling debits locally and the buyer never saw the link
   * — they were told to re-register the mandate, a re-registration in place of one tap,
   * for a payment Stripe says was recoverable.
   *
   * Absent means "no such link", which is the safe default and is RazorPay's and PayPal's
   * true answer: there the local refusal is strictly better, because a gateway ceiling
   * refusal is indistinguishable from a decline and dunning would burn the schedule and
   * the customer's backup instrument on a debit that can never succeed (measured:
   * ₹66,025 against a ₹41,610 mandate).
   *
   * ⚠️ Read ONLY by the collection pre-flight. The checkout gate keeps refusing whatever
   * this says — see `mandateRefusal`'s fourth parameter.
   */
  afaLinkAboveMandateMax?: boolean;
  /**
   * The gateway sends the buyer back with a form POST, not a GET redirect. The engine then
   * wraps every return URL it hands the adapter in the storefront's `/gateway-return`
   * bounce, which answers the POST with a 303 to the real page. The POSTed fields are
   * dropped: completion asks the gateway for the outcome instead.
   */
  buyerReturnByPost?: boolean;
  /**
   * Rails on which every debit needs a notice sent THROUGH this gateway first (India
   * e-mandates on PayU, PhonePe, Paytm, Adyen): the bank notifies the payer after our
   * `notifyUpcomingDebit` call, and the debit is legal only inside the notice's window.
   * The engine sends the notice, holds the charge until `minLeadHours` have passed, and
   * passes the notice to `charge` as `preDebitNotice`. Our own notice email is skipped.
   */
  preDebitNotice?: {
    methods: MethodType[];
    /** Hours between a sent notice and the earliest legal debit. */
    minLeadHours: number;
    /** Hours after sending that a notice stops covering a debit. Absent = until used up. */
    validForHours?: number;
    /** Debits (first try + retries) one notice covers. */
    maxDebitsPerNotice: number;
    /** The debit must equal the notified amount; a different amount needs a new notice. */
    exactAmount: boolean;
    /**
     * Rails where the gateway keeps ONE notice open per mandate until it is debited or
     * withdrawn (PayU UPI). The engine withdraws an unused notice before it sends another
     * (`withdrawPreDebitNotice`), and a debit waits while another debit's notice is open.
     */
    oneOpenPerMandate?: MethodType[];
    /** Per-rail lead time and debits per notice where a rail differs (read via `preDebitRule`). */
    byMethod?: Partial<Record<MethodType, { minLeadHours?: number; maxDebitsPerNotice?: number }>>;
  };
  /**
   * The most one debit may be on a rail at this gateway, in INR minor units, where it is
   * lower than the network's own cap (PayU UPI: ₹15,000 `billingAmount`). The ceiling the
   * checkout shows and asks for is clamped to it, and a rail whose debit is above it is
   * not offered. Mirrored in `GatewayDefinition.mandateCeilingCapMinor`.
   */
  mandateCeilingCapMinor?: Partial<Record<MethodType, bigint>>;
  /**
   * Methods whose mandate registration can collect a real first payment
   * (`CreateIntentInput.firstChargeMinor`): PayU's consent transaction as the first billing
   * cycle. A hosted-checkout signup then pays once, at registration.
   */
  setupCollectsFirstCharge?: MethodType[];
  /**
   * Rails on which the GATEWAY tells the payer about each debit itself (GoCardless
   * advance notices, Cashfree's default flow). Our own pre-debit email is skipped there,
   * so the payer does not get two notices with possibly different figures.
   */
  gatewayNotifiesPayer?: MethodType[];
  /**
   * The currencies in which the gateway's own notice (`gatewayNotifiesPayer`) is confirmed.
   * In any other currency we send our own pre-debit email. Absent = every currency.
   */
  gatewayNotifiesPayerCurrencies?: readonly string[];
  /**
   * Methods whose stored mandate currency (`ProviderMandate.currency`) is the one currency the
   * gateway debits them in. For these the engine refuses a debit in another currency before
   * the gateway is called, and skips them when it selects a method for that currency.
   * Unlisted: the stored currency is a label only and the gateway decides (RazorPay cards,
   * whose mandates register in the order's currency but were stored as INR).
   * Mirrored in `GatewayDefinition.mandateCurrencyAuthoritative`.
   */
  mandateCurrencyAuthoritative?: readonly MethodType[];
  /**
   * The gateway reports some outcomes only in a settlement report, never by webhook
   * (Authorize.net eCheck returns). The clock calls `pollSettlements` every
   * `intervalMinutes`, from the account's cursor in `gateway_settlement_cursors`.
   */
  settlementReport?: { intervalMinutes: number; maxWindowHours: number };
  /** Contract v2 (C3): supports a payment-method verification probe (verifyPaymentMethod). */
  verify?: boolean;
  /** Contract v2 (C3): supports on-session/off-session intents (createIntent/consumeIntent). */
  intents?: boolean;
  /**
   * Which intent purposes this gateway can create. A gateway may support
   * zero-amount `setup` intents (vault a card behind a 3DS challenge) without
   * supporting priced `payment` intents, or vice-versa. Empty/absent with
   * `intents: true` means both.
   */
  intentPurposes?: IntentPurpose[];
  /**
   * Can release an authorized-but-unconsumed intent without moving money
   * (Stripe `paymentIntents.cancel`, PayPal authorization void). **RazorPay
   * cannot** — an authorized payment is either captured or left to lapse, and
   * faking a void with a refund would post real money movement for a payment
   * that never settled. Surfaces in the UI so we don't offer a control that
   * can't work.
   */
  intentVoid?: boolean;
  /**
   * Can this gateway be ASKED what became of an intent (`fetchIntent`)?
   *
   * Read exactly like `intentVoid` — the caller checks the flag and the method
   * together, so an adapter cannot advertise a probe it does not implement. Absent
   * means UNKNOWN and callers must treat it as "cannot be asked": an engine that
   * assumed otherwise would conclude "nothing is held" from a call it never made,
   * which is the whole of defect #15.
   *
   * Declared TRUE on razorpay, tmtest and stripe. RazorPay is the gateway where a
   * lost/late callback strands real money with no release call to fall back on
   * (measured 2026-09-03 — ₹22,184.00 held for 21 minutes with the invoice unpaid and
   * the buyer blocked); tmtest carries it so the path is verifiable offline.
   *
   * Stripe joined 2026-10-25: a pay-now intent captures bank debits and redirect methods
   * at the buyer's confirm, which sends no authorization webhook at all, so the buyer's
   * second leg must ASK. PayPal still leaves it undefined.
   */
  intentStatus?: boolean;
  /**
   * Does this gateway have a MANDATE MODEL at all — i.e. can it register an
   * instrument under a per-debit ceiling and report that ceiling back?
   *
   * This distinguishes two states the engine could not previously tell apart,
   * because both collapse to a NULL `payment_methods.mandate_max_amount_minor`:
   *
   *   - `true`  — the gateway would have told us. A null ceiling on such an
   *     instrument means UNKNOWN (a plain card-on-file with no mandate rail, a
   *     row vaulted before the readback existed, or a rail whose ceiling the
   *     gateway does not denominate). RazorPay and Stripe are `true`: RazorPay
   *     reports `token.max_amount`, Stripe reports `Mandate.multi_use.amount`
   *     / `Mandate.payment_method_details.upi.amount`.
   *   - `false` — the gateway has NO per-debit ceiling concept on the flow we
   *     use, so a null ceiling is not missing data and no amount of extra
   *     plumbing will ever populate it. PayPal is `false`: a `usage_type:
   *     MERCHANT` billing agreement authorizes merchant-initiated debits with
   *     no upper bound per debit, and there is nothing to read back.
   *
   * Absent means UNKNOWN — the same conservative reading `ProviderMandate`'s
   * optional fields take. It is deliberately NOT defaulted to `true`, so a new
   * adapter that forgets to declare it is never reported to an operator as a
   * gateway that enforces limits it does not enforce.
   *
   * ⚠️ Never let a `false` here be read as "unlimited by agreement". It says the
   * GATEWAY does not model a ceiling; the buyer's card issuer, bank or PayPal
   * account may still refuse a large debit for reasons of its own.
   */
  mandates?: boolean;

  /**
   * Does an OFF-SESSION debit on this gateway need the mandate's own reference passed
   * with it, over and above the vaulted instrument?
   *
   * Stripe is the only `true` today: its India recurring confirm takes a `mandate`
   * parameter, and without it the confirm is refused — AFTER the PaymentIntent has been
   * created, which is what leaves an orphan behind. RazorPay debits with the recurring
   * TOKEN alone, PayPal with the billing agreement, so for them a missing reference is
   * not a missing authorization and must not be refused as one.
   *
   * Read by `mandateMissingRefusal`: it is the difference between "our row is missing a
   * field this gateway needs" and "our row is missing a field nothing reads". Absent
   * means UNKNOWN and is treated as NOT required, deliberately the opposite reading from
   * `mandates` above — a new adapter that forgets to declare it must not start refusing
   * every renewal it can no longer prove is authorized.
   */
  perDebitMandateReference?: boolean;

  /**
   * Does this gateway tell us about chargebacks (`dispute.*` events)?
   *
   * `false` = it has no dispute webhook or API, so a card chargeback takes the money back
   * and our books never learn of it. An operator then records the dispute by hand from the
   * processor's notice (`recordOperatorDispute`). Absent means the gateway reports disputes,
   * and the hand-recorded path is refused, so one chargeback is never booked twice.
   * Mirrored on `GatewayDefinition.disputeFeed`, pinned by `test/unit/dispute-feed.test.ts`.
   */
  disputeFeed?: boolean;

  /**
   * Can stop a debit the gateway accepted but has not collected yet (`cancelPendingCharge`).
   * Read with the method, like `intentVoid`. Mirrored on `GatewayDefinition.pendingDebitCancel`,
   * pinned by `test/unit/pending-debit-cancel.test.ts`. The gateway still decides per debit:
   * past its window the answer is `not_cancelable`.
   */
  pendingDebitCancel?: boolean;

  /**
   * `locateCharge` cannot look a charge up: it resends the create under the SAME key, and a
   * create the gateway never received is made then. The engine calls it only with `replay`
   * set, within `keyValidMs` of the attempt (the gateway's key lifetime, less a margin);
   * otherwise the row is left for an operator.
   */
  locateByReplay?: { keyValidMs: number };
}

/** Opaque reference to the provider's mirror of our customer (if it keeps one). */
/**
 * The provider REFUSES this combination, and no retry will change that — a human has
 * to alter the request or the account (a domestic-only rail asked for a foreign
 * currency, a wallet asked to carry a mandate, an INR mandate with no rail pinned).
 *
 * Typed so the API layer can answer 400 with the adapter's own explanation. A plain
 * `Error` here becomes a 500: measured 2026-08-14, a buyer pressing "Pay now" on a USD
 * invoice routed at an INR-only RazorPay account saw "Internal server error", while the
 * adapter had produced a precise sentence naming the fix. The one person who can do
 * nothing about it got the least useful message we produce.
 */
/**
 * A debit under a pre-debit notice that the gateway refused only because it is too early
 * (the notice period, or a time window the network blocks). The notice is still good:
 * the engine gives the debit back to it and waits `failure.retryAfterMs`.
 */
export const PRE_DEBIT_NOT_DUE_CODE = "pre_debit_not_due";

export class ProviderRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRefusalError";
  }
}

/**
 * We cannot ESTABLISH the fact the operation turns on — nobody did anything wrong, and
 * retrying is the right answer. The deliberate mirror of `ProviderRefusalError`: a
 * refusal is a request a human must change (→ 400), this is knowledge we do not have
 * yet (→ 502 via `badGateway`, whose body carries `retriable: true`).
 *
 * INDETERMINACY, not unavailability. The condition includes the case where the gateway
 * answered perfectly well and we still could not establish which authorization to void
 * (PayPal: an order read that came back with no authorization we can point at). "The
 * gateway is down" is only one of the ways to get here, and never the definition.
 *
 * This carries EXACTLY the meaning `VoidIntentResult.held === undefined` carries one
 * layer down — "cannot say", never "nothing was held" — and it is thrown by the same
 * adapters for the same reason. Reading either of them as a fact about the money is
 * defect #21 with the sign flipped.
 *
 * ⚠️ So the MESSAGE must describe our KNOWLEDGE, not the money. "We could not confirm
 * whether the hold was released" is the sentence; "the hold was not released" is a
 * claim about a buyer's funds that nothing here has established, and putting it in an
 * error channel re-introduces #21 through a different door. A plain `Error` here
 * becomes a 500 — the measured lesson written up on `ProviderRefusalError` above.
 */
export class ProviderIndeterminateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderIndeterminateError";
  }
}

/**
 * THE OBJECT A REJECTED REQUEST LEFT BEHIND AT THE GATEWAY.
 *
 * An adapter has two honest answers to a refusal: return it as data (a decline the caller
 * books), or throw (our bug — the caller must see it). The second is right far more often
 * than it looks, and every adapter's catch deliberately narrows recovery to the shapes it
 * understands. But THROWING ALSO THREW AWAY THE ID, and those are separable concerns.
 *
 * Stripe creates the PaymentIntent and then fails the inline confirm, so a refusal it
 * rethrows leaves a live `pi_…` carrying our ownership tag. Nothing local named it, so
 * `orphaned_gateway_intents` reported it as money armed at a gateway we could not explain
 * — the class of failure that produced both alert rows on 2026-09-06/07, and one the
 * narrow recovery branches will never cover completely, because the whole point of the
 * rethrow is that we did not anticipate the error.
 *
 * So: keep throwing, stop losing the id. An adapter stamps whatever the gateway kept and
 * rethrows unchanged; the caller records it and the object stops being unexplained. The
 * marker is deliberately not a new Error CLASS — it rides errors the adapters do not own
 * (Stripe's SDK types, a bare `Error`), and a subclass could not.
 */
export interface GatewayStrandedObject {
  /** The gateway's own id for the object the refused request created, if any. */
  strandedObjectId?: string;
}

/** True when the gateway itself notifies the payer of a debit on `method` in `currency`. */
export function gatewayNotifiesPayerOf(
  caps: Pick<ProviderCapabilities, "gatewayNotifiesPayer" | "gatewayNotifiesPayerCurrencies">,
  method: string,
  currency: string | null | undefined,
): boolean {
  if (!(caps.gatewayNotifiesPayer as string[] | undefined)?.includes(method)) return false;
  const list = caps.gatewayNotifiesPayerCurrencies;
  return !list || (!!currency && list.includes(currency.toUpperCase()));
}

/** Stamp the object a rejected request left behind, then rethrow the error unchanged. */
export function markStrandedObject<E>(err: E, objectId: string | null | undefined): E {
  if (err && typeof err === "object" && objectId) {
    (err as GatewayStrandedObject).strandedObjectId = objectId;
  }
  return err;
}

/**
 * The id a thrown error is carrying, or null.
 *
 * Reads defensively rather than trusting the shape: the value rides errors from three
 * SDKs and could be anything by the time it reaches a caller.
 */
export function strandedObjectId(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const id = (err as GatewayStrandedObject).strandedObjectId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export interface ProviderCustomerRef {
  providerKey: ProviderKey;
  providerCustomerId: string;
}

/**
 * The mandate a vaulted instrument was actually registered under, as the PROVIDER
 * reports it — not as we requested it.
 *
 * A mandate rail (RazorPay e-mandate/UPI Autopay/card, Stripe's India e-mandate,
 * SEPA, ACH) binds the instrument to a per-debit CEILING agreed with the buyer at
 * registration, and enforces it at debit time. We asked for one number
 * (`deriveMandateCeiling`); the provider may have registered a different one — both
 * RazorPay caps (`MAX_UPI_MANDATE_MAX_AMOUNT` is ₹1,00,000, well under what an
 * expensive plan derives) and the buyer's bank can lower it. Storing what we
 * *asked* for would make the engine confidently wrong about the one number that
 * decides whether a renewal can be collected.
 *
 * Every field is optional because a provider may not report it. **Absent means
 * unknown, never unlimited** — callers must not infer a ceiling from a null
 * `maxAmountMinor`.
 */
export interface ProviderMandate {
  /**
   * Ceiling for any single debit, in minor units of `currency`. A debit above this
   * is refused by the provider, so the engine checks it before spending a gateway
   * call and a dunning attempt on a charge that cannot succeed.
   */
  maxAmountMinor?: bigint;
  /** Currency the ceiling is denominated in (ISO 4217). */
  currency?: string;
  /**
   * The provider-native rail the mandate rides, in the PROVIDER's vocabulary
   * (RazorPay: `upi` | `card` | `emandate` | `nach`). Kept raw rather than mapped
   * to our method types because the debit-time behaviour that matters — settlement
   * lag, authentication rules — is a property of the rail, not of our display type.
   */
  rail?: string;
  /**
   * Provider-reported mandate state (RazorPay `recurring_details.status`:
   * `initiated` | `confirmed` | `rejected` | `cancelled` | `paused`). `confirmed`
   * is the only one that can be debited off-session.
   */
  status?: string;
  /** When the mandate lapses and must be re-registered. */
  expiresAt?: Date;
  /** The provider's own mandate/reference id, for support tickets and reconciliation. */
  reference?: string;
}

/** Opaque reference to a vaulted payment method living at the provider. */
export interface ProviderPaymentMethodRef {
  providerKey: ProviderKey;
  providerPaymentMethodId: string;
  /**
   * Set when the pm is bound to a specific provider customer that is NOT the
   * one passed to vaultPaymentMethod (e.g. a Stripe pm confirmed via
   * SetupIntent is already attached to the setup call's customer). Callers
   * must store/charge with THIS customer id when present.
   */
  providerCustomerId?: string;
  /** Non-secret display info we can safely store/show. */
  display: {
    type: ProviderCapabilities["methods"][number];
    brand?: string; // e.g. visa
    last4?: string;
    expMonth?: number;
    expYear?: number;
    /**
     * What the gateway said about the billing address / CVC (0245), verbatim and
     * lowercased at most (e.g. `pass` | `fail` | `unavailable` | `unchecked` —
     * spelled differently per rail). Undefined means the rail doesn't report this
     * — Stripe only today — never coerce that into a value like "unchecked".
     */
    /**
     * Where the card was ISSUED (ISO-3166-1 alpha-2). Stripe reports it as
     * `card.country`; RazorPay carries an `international` flag we map to IN/non-IN.
     *
     * Here because RBI's e-mandate and AFA rules bind INDIAN-issued cards, and the engine
     * was deciding that from the debit's CURRENCY — which is only a proxy. Undefined means
     * the gateway did not say, and must never be read as "not India".
     */
    issuerCountry?: string;
    /**
     * ⚠️ Whether the instrument may be used INTERNATIONALLY — a capability, not an origin.
     * RazorPay's `card.international`; do not read it as "issued abroad".
     */
    supportsInternational?: boolean;
    /** `consumer` | `business`, verbatim from the gateway. */
    instrumentSubType?: string;
    /** Whether recurring is enabled on this card (RazorPay `card.flows.recurring`). */
    supportsRecurring?: boolean;
    /** `credit` | `debit` | `prepaid` | `unknown`, verbatim from the gateway. */
    instrumentFunding?: string;
    /** The issuing bank as the gateway names it — Stripe spells it out, RazorPay codes it. */
    issuerName?: string;
    /** The same underlying instrument across customers/accounts (Stripe fingerprints). */
    instrumentFingerprint?: string;
    /** Whether the card supports 3DS at all — how every India AFA challenge is carried. */
    threeDSecureSupported?: boolean;
    avsLine1Check?: string;
    avsPostalCheck?: string;
    cvcCheck?: string;
    /** When the verdicts above were captured; unset iff none were reported. */
    avsCheckedAt?: Date;
  };
  /**
   * Present only when the instrument was vaulted behind a MANDATE (see
   * `ProviderMandate`). Absent for a plain card-on-file with no mandate rail —
   * which is every Stripe non-India vault today.
   */
  mandate?: ProviderMandate;
  /**
   * A registration payment the gateway CAPTURED to register this instrument (a mandate's
   * auth amount). No invoice owns it and it is never booked, so the engine refunds it
   * (`refund_setup_auth` job). Absent when registration took no money.
   */
  setupAuthCharge?: {
    providerChargeId: string;
    amountMinor: bigint;
    currency: string;
    /**
     * The registration collected `CreateIntentInput.firstChargeMinor`: it pays a first
     * invoice when the setup completes a signup, and is refunded only if nothing books it.
     */
    firstCharge?: boolean;
  };
}

export interface ProviderAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string; // ISO 3166-1 alpha-2
}

/** Payer contact details an adapter may need on a mandate or an order. */
export interface ProviderContact {
  email?: string;
  phone?: string;
  name?: string;
  /** Billing country, ISO 3166-1 alpha-2. */
  country?: string;
}

export interface EnsureCustomerInput {
  /** Our internal/public customer id, for provider-side metadata correlation. */
  customerRef: string;
  email?: string;
  name?: string;
  /** The customer's company, when it is one. */
  company?: string;
  /** Phone/contact — required by some providers for recurring mandates (RazorPay). */
  phone?: string;
  /** Some providers require name + address for compliance (e.g. India exports). */
  address?: ProviderAddress;
  metadata?: Record<string, string>;
}

export interface VaultPaymentMethodInput {
  customer: ProviderCustomerRef;
  /** Provider-specific token from the client (hosted fields / SDK). */
  token: string;
  /**
   * Our stable customer public id (cus_…). Lets an adapter verify that a
   * pre-attached pm (SetupIntent flow) belongs to a provider customer we
   * created for THIS customer (ensureCustomer stamps it in metadata).
   */
  customerRef?: string;
  metadata?: Record<string, string>;
}

export interface InitiateVaultSetupInput {
  /**
   * What a person sees beside this AUTHORIZATION in the gateway's own dashboard.
   *
   * A vault object is not money, which is why it went without one — but it is the row a
   * support person opens when a renewal later fails on "the card they saved", and Stripe
   * showed it with no description at all. RazorPay was the only adapter sending anything,
   * and only its own generic default ("Authorize recurring payments"), which names neither
   * the customer nor the terms being agreed.
   */
  description?: string;
  /**
   * OUR id for this vault attempt (#31). Without it this input carries no identifier of
   * ours at all — only the gateway's customer id and two URLs — so the SetupIntent it
   * creates was untaggable by construction.
   */
  ownershipRef?: string;
  /**
   * The payer's contact, for gateways that take it on the mandate itself rather than on a
   * customer object they keep (Cashfree subscriptions require email and phone).
   */
  contact?: ProviderContact;
  customer: ProviderCustomerRef;
  /** Where the provider redirects after the buyer approves / cancels. */
  returnUrl: string;
  cancelUrl: string;
  /**
   * Which instruments the buyer may set up, in our canonical vocabulary
   * (`card`, `us_bank_account`, `sepa_debit`, `upi`, …). Adapters map these to
   * their own names and ignore any they don't support. Defaults to `['card']`.
   * This is how a business offers ACH/SEPA, toggled per gateway.
   */
  methodTypes?: string[];
  /**
   * Currency the resulting mandate will be DEBITED in (ISO-4217). Optional; a
   * gateway that vaults currency-agnostically (Stripe, PayPal) ignores it.
   *
   * RazorPay does not: a mandate is registered against an order in a specific
   * currency, and its rails disagree about which are legal — cards accept
   * USD/EUR/etc, while UPI Autopay and netbanking e-mandate are domestic-only
   * and rejected outright ("The currency should be INR when method is upi").
   * Passing this lets the adapter register the mandate in the currency the
   * subscription will actually be charged in, instead of assuming INR and
   * silently binding a USD customer to an INR mandate.
   */
  currency?: string;
  /**
   * Ceiling for any single debit under the mandate, in minor units of
   * `currency`. Mandate rails require an upper bound up front, and a debit above
   * it fails at charge time — so this should be derived from the subscription
   * amount with headroom, not left to a constant that silently caps what a
   * business can bill.
   */
  maxAmountMinor?: bigint;
}

/**
 * How a buyer completes an authorization challenge at the gateway.
 *
 * Shared by vault setup AND payment intents because they are the SAME handshake:
 * a Stripe SetupIntent's `client_secret`, a PayPal approval redirect and a
 * RazorPay checkout are what the buyer sees whether we are vaulting a card or
 * clearing 3DS on a charge. Both are modelled as one `payment_intent` object
 * (zero-amount `seti_…` rows are vault setups) — see `IntentPurpose`. Keeping
 * one descriptor means the hosted checkout and the
 * customer portal render a challenge without caring which flow produced it.
 */
export interface BuyerAuthorization {
  /**
   * How the buyer authorizes:
   *  - 'redirect': visit `approvalUrl` (PayPal hosted approval, 3DS redirect).
   *  - 'checkout': open the provider's embedded checkout with `checkout` params (RazorPay).
   *  - 'client_secret': confirm buyer-side with the provider's JS SDK using
   *    `clientSecret` (Stripe SetupIntent/PaymentIntent + Elements).
   *  - 'sdk': run the provider's browser SDK with the opaque `sdk.params`. What the SDK
   *    hands back is posted with the completion and reaches `submitClientResult`.
   *  - 'form_post': submit `formPost` as a top-level POST form (signed-field gateways).
   */
  mode: "redirect" | "checkout" | "client_secret" | "sdk" | "form_post";
  /**
   * For `mode: 'sdk'`. `params` is the adapter's to shape and the storefront's per-gateway
   * loader's to read; nothing in between interprets it. Never a secret the buyer must not see.
   */
  sdk?: { provider: ProviderKey; params: Record<string, unknown> };
  /** For `mode: 'form_post'`: the gateway's endpoint and the signed fields to POST to it. */
  formPost?: { action: string; fields: Record<string, string> };
  approvalUrl?: string;
  /** Secret the buyer's browser uses to confirm the setup (Stripe SetupIntent). */
  clientSecret?: string;
  /** Publishable key that initializes the provider's browser SDK (Stripe.js). */
  publishableKey?: string;
  /** Params the client passes to the provider's embedded checkout (RazorPay). */
  checkout?: {
    provider: ProviderKey;
    keyId: string;
    orderId: string;
    customerId: string;
    recurring: boolean;
    /**
     * Provider-native method the checkout should preselect, when the mandate rail
     * is chosen server-side (RazorPay: `upi` for UPI Autopay, `emandate` for a
     * netbanking mandate). The auth order is already bound to this rail, so the
     * client must not offer a different one.
     */
    method?: string;
  };
}

/** A pending vault setup: the buyer's challenge plus the provider's setup-token ref. */
export interface VaultSetupRef extends BuyerAuthorization {
  /** Provider ref for the pending setup — PayPal setup-token id / RazorPay order id. */
  setupTokenId: string;
}

export interface ChargeInput {
  /**
   * OUR id for this operation, stamped on the gateway object — see
   * `CreateIntentInput.ownershipRef` for why (#31). The adapter reads it back VERBATIM as
   * the event's `ownershipRef`: a charge whose answer was lost is matched by it.
   *
   * ⚠ Added 2026-09-04 because G1a measured that WITHOUT it the tag cannot be stamped
   * here at all, and the consequence is worse than an absent tag: `charge()` is the path
   * every off-session RENEWAL takes, and an untagged `charge.succeeded` arriving with
   * `metadata: {}` would classify as **foreign** — a false "not ours" on the busiest
   * money path in the system. Neither call site (`invoicing/collection.ts`,
   * `wallet/service.ts`) passes metadata today, so until they pass this the adapters fall
   * back to the idempotency key as a witness, which the contract already defines as
   * mapping 1:1 to a tmbilling payment attempt. The fallback is a bridge, not the design:
   * pass the real public id and it can be deleted.
   */
  ownershipRef?: string;
  /** Integer minor units (cents/paise). */
  amountMinor: bigint;
  currency: string;
  customer: ProviderCustomerRef;
  paymentMethod: ProviderPaymentMethodRef;
  /**
   * The MANDATE this debit runs under, as the provider knows it — our
   * `payment_methods.mandate_reference`.
   *
   * ⚠ Added 2026-09-05 for #63, and the omission cost a real charge. Stripe India
   * REQUIRES `mandate` on an off-session recurring card confirm; without it the
   * PaymentIntent is rejected with a 400 `invalid_request_error`, "The parameter
   * `mandate` is not provided or invalid". We had the id on our own row the whole time
   * (`mandate_1UC2…`, status `confirmed`) and did not send it, so the request could
   * never have succeeded. Measured on `gateway_request_logs` at 19:51:13Z.
   *
   * It stayed hidden because our own ceiling pre-flight (`mandateRefusal`) refused
   * every earlier attempt BEFORE the gateway was called — raise the ceiling and the
   * charge reaches Stripe for the first time and hits this.
   *
   * Optional and provider-shaped on purpose: only the adapter that minted the
   * reference may interpret it. RazorPay's is a token id and means nothing to Stripe,
   * which is why this is passed through rather than translated.
   */
  mandateReference?: string | null;
  /** Maps 1:1 to a tmbilling payment attempt; the provider must dedupe on this. */
  idempotencyKey: string;
  description?: string;
  metadata?: Record<string, string>;
  /**
   * Buyer contact details, for gateways that demand them on the charge call
   * itself rather than reading them off the vaulted customer. RazorPay's
   * off-session `POST /payments/create/recurring` rejects a charge without them
   * ("The contact field is required."), so the engine threads the customer's
   * email/phone through instead of making the adapter re-fetch them per charge.
   * Optional — gateways that charge purely against a vaulted token ignore both.
   */
  email?: string;
  phone?: string;
  /**
   * The pre-debit notice this debit runs under, on a `capabilities.preDebitNotice` rail.
   * The engine sends it only when the notice is sent, inside its window, not used up and
   * (when `exactAmount`) for exactly `amountMinor`.
   */
  preDebitNotice?: { notificationRef: string; amountMinor: bigint; debitNumber: number };
  /**
   * Who started this debit, for gateways that flag stored-credential use (card-network
   * CIT/MIT rules). `by: customer` = the buyer is present; `recurring` = it runs under the
   * subscription's standing agreement. Absent = unknown; the adapter picks its safest default.
   */
  initiator?: ChargeInitiator;
  /**
   * The due date of the invoice this debit collects, as a calendar day (`YYYY-MM-DD`) in the
   * business's timezone. A gateway that schedules debits may collect on that day instead of
   * now (GoCardless `charge_date`); the others ignore it. Absent = as soon as possible.
   */
  invoiceDueDate?: string;
}

export interface ChargeInitiator {
  by: "customer" | "merchant";
  recurring: boolean;
}

export type ChargeStatus = "succeeded" | "failed" | "pending" | "requires_action";

export interface ChargeResult {
  status: ChargeStatus;
  providerChargeId: string;
  /** Present when status === 'failed' — normalized for our dunning logic. */
  failure?: {
    code: string; // normalized: card_declined | insufficient_funds | expired_card | ...
    providerCode?: string;
    message: string;
    /** Whether a retry could plausibly succeed (drives dunning). */
    retriable: boolean;
    /**
     * WHICH decline rule decided this, when one did (#69 stage 3).
     *
     * A merchant can override a rule's hardness and its wording, and only the module
     * layer can apply that: `providers/` may not import from `modules/`, and an adapter
     * has no tenant. So the adapter reports what matched and the business's own answer is
     * layered on where the business is known. Absent means the legacy table or the
     * passthrough answered, and there is nothing to override.
     */
    ruleId?: string;
    /**
     * Whether the payer may read `message` — set ONLY by a merchant override
     * (`applyDeclineOverride`); adapters leave it absent, which means the built-in answer.
     * Read it through `payerDeclineMessage`.
     */
    exposedToPayer?: boolean;
    /**
     * Minimum wait before re-presenting, when the network or gateway stated one
     * (`NormalizedDecline.retryAfterMs`). Dunning floors the next attempt at it.
     */
    retryAfterMs?: number;
  };
  /**
   * For requires_action flows (3DS, UPI collect, etc.).
   *
   * `data` is open, but two keys are part of the contract when an adapter can supply
   * them, because the engine reads them:
   *
   *  - `approvalRequired: boolean` — the gateway STATING whether a person must act.
   *    Absent means it said nothing, which is NOT the same as `false`: `requires_action`
   *    alone is too coarse to decide, and India is why. Stripe parks every e-mandate
   *    debit at `requires_action` to serve the pre-debit notification whether or not
   *    anyone must authenticate it, so an engine that reads the status alone tells the
   *    buyer to approve a payment that will settle by itself
   *    (`AUTHENTICATION_NOT_REQUIRED_CODE`).
   *  - `chargeAttemptAt: number` — unix seconds, when the gateway will present the debit.
   */
  nextAction?: { type: string; data: Record<string, unknown> };
  /**
   * What the payer actually paid with, as the gateway reports it: a `METHOD_TYPES` value
   * where one fits, else the finest name the adapter knows (`apple_pay`, `cash_app_pay`,
   * `ideal`). Absent = the gateway did not say. `payments.method_type` stores it through
   * `methodTypeOf` (payments/method-type.ts), which maps it onto the vocabulary.
   */
  methodUsed?: string;
  raw?: unknown;
}

export interface RefundInput {
  /**
   * OUR id for this refund (#31). A Refund is its OWN gateway object and does NOT
   * inherit the PaymentIntent's metadata — measured by G1a — so `refund.failed`
   * describes an object nothing tags unless we tag it here.
   */
  ownershipRef?: string;
  providerChargeId: string;
  /** Omit for a full refund. Integer minor units. */
  amountMinor?: bigint;
  /**
   * ISO-4217 code of the original charge. Required for partial refunds on
   * gateways that echo the amount (PayPal); ignored by gateways that refund
   * against the stored charge (Stripe/RazorPay). Always pass it when known.
   */
  currency?: string;
  idempotencyKey: string;
  reason?: string;
}

export interface RefundResult {
  status: "succeeded" | "failed" | "pending";
  providerRefundId: string;
  /** With `failed`: the gateway's reason, for the operator. Absent = the gateway gave none. */
  failureMessage?: string;
  raw?: unknown;
}

/** One gateway refund as an inbound event reports it. */
export interface ProviderRefundRecord {
  providerRefundId: string;
  /** This refund's own amount in minor units, never the charge's running total. */
  amountMinor: bigint;
  /** `failed` covers every terminal not-landed state (failed, cancelled, returned). */
  status: "succeeded" | "pending" | "failed";
  /** Our tag on the refund (#31). Set means one of our own refund paths issued it. */
  ownershipRef?: string;
}

/** A provider webhook, normalized into our internal vocabulary. */
export interface NormalizedProviderEvent {
  /**
   * Stable provider event id — used to dedupe replays, per (gateway, business). Normally the
   * adapter's `webhookEventId(input)`. A gateway that batches several events per delivery,
   * where one event can reappear in a different batch, sets each event's own id instead.
   */
  providerEventId: string;
  type:
    | "charge.succeeded"
    | "charge.failed"
    | "charge.refunded"
    /**
     * Money is IN FLIGHT: the gateway accepted the charge and the rail has not
     * answered yet (Stripe `charge.pending` on a delayed method, PayPal
     * `PAYMENT.CAPTURE.PENDING` / `PAYMENT.SALE.PENDING` on a capture PayPal has put
     * into review).
     *
     * Its own term because every existing one would be a lie: `charge.succeeded`
     * settles a transaction and its invoice for money the bank has not moved, and
     * `charge.failed` fails an attempt that is still alive and re-arms dunning
     * against a buyer who did nothing wrong. `intent.authorized` is wrong too — a
     * pending capture is not a hold; the capture was requested and the funds are
     * moving.
     *
     * **Persist-only, deliberately.** The verdict still arrives on its own
     * (`charge.succeeded` / `charge.failed`, or the stale-pending sweep's poll), so a
     * handler here could only duplicate what already works. What this buys is a NAME:
     * the case that needs it most is a capture that went pending with NO synchronous
     * answer — a timed-out call, a webhook-first flow — where the `unknown` row was
     * the only trace and nothing could find it. On PayPal it is also the one delivery
     * observed live carrying `custom_id`, so #31's classifier could not see the tag
     * on the only event known to carry it (#33).
     */
    | "charge.pending"
    /**
     * A capture we ALREADY BOOKED was taken back by the gateway (PayPal
     * `PAYMENT.CAPTURE.REVERSED` / `PAYMENT.SALE.REVERSED`). Money moving against us.
     *
     * ⚠️ NOT `charge.refunded`: a refund is something WE issued, booked with a credit
     * note against the customer's invoice. A reversal is the gateway unwinding a
     * settlement for its own reasons.
     *
     * Booked by `applyChargeReversal` (webhooks/inbound.ts): as the dispute's
     * `funds_withdrawn` when a dispute on the charge is open, else through the same
     * late-failure reversal `charge.failed` uses (cash out, AR and the invoice reopen).
     * A reversal that matches no payment is persisted and alerted only.
     */
    | "charge.reversed"
    /**
     * A charge OBJECT changed (Stripe `charge.updated`) — 4,830 delivered and dropped
     * as `unknown` before this existed.
     *
     * Stripe: "Occurs whenever a charge description or metadata is updated, or upon an
     * asynchronous capture." Two very different things under one name, which is exactly
     * why this may never be a money term: mapping it to `charge.succeeded` would settle
     * a transaction because somebody retitled a charge in the Stripe dashboard.
     *
     * **Persist-only.** It is named so the row is findable, and because it is the event
     * that carries `balance_transaction` — the handle the gateway's own fee hangs off
     * (#18). ⚠️ That is a REFERENCE (`txn_…`), not the fee: the amount requires a
     * `balanceTransactions.retrieve`, so nothing here reports `feeMinor` and absence
     * still means unknown, never zero.
     */
    | "charge.updated"
    | "payment_method.detached"
    // Automatic card updater: the network reissued the card (new expiry / last4).
    | "payment_method.updated"
    // The MANDATE behind a vaulted instrument changed state at the provider —
    // confirmed, rejected, cancelled or paused (RazorPay `token.*`).
    //
    // Deliberately NOT `payment_method.updated`: that event carries refreshed CARD
    // fields and the card-updater path writes brand/last4/expiry from it, so a
    // mandate event routed there would blank a stored instrument with a card-less
    // payload — the same trap already documented for `setup_intent.*` above.
    //
    // It matters most on the rails that confirm LATE. A netbanking e-mandate token
    // is `initiated` when the buyer finishes at their bank and only confirms T+1
    // (HDFC/SBI), so without this the engine never learns the mandate went live. In
    // the other direction, a buyer revoking a UPI Autopay mandate in their UPI app
    // is the ONLY notice we get — miss it and every renewal fails against a mandate
    // that no longer exists.
    | "payment_method.mandate_updated"
    // A gateway PAYOUT reached the bank (RazorPay `settlement.processed`).
    //
    // Deliberately NOT a `charge.*` term: no customer's money moves here. This is the
    // gateway remitting what it already collected, netted and batched — one credit
    // covering many payments minus MDR, GST on MDR, refunds and adjustments. It books
    // nothing against an invoice and must never be mistaken for revenue; it exists so
    // the bank balance can be reconciled against collections at all.
    | "settlement.processed"
    // Chargeback / dispute lifecycle.
    | "dispute.created"
    // An open case changed (evidence due, now under review). Status refresh only: no
    // money moves and no verdict. `disputeStatus` carries our open status when known.
    | "dispute.updated"
    | "dispute.funds_withdrawn"
    | "dispute.funds_reinstated"
    | "dispute.won"
    | "dispute.lost"
    | "dispute.closed"
    /**
     * The outcome of a pre-debit notice we sent through the gateway arrived late (Paytm's
     * Pre-Notify callback, PhonePe's notify status). Carries `preDebitNotice`.
     */
    | "pre_debit_notice.updated"
    // Payment-intent lifecycle (C7). These are DELIBERATELY separate from the
    // `charge.*` terms: an intent authorization is a HOLD, not settled money.
    // Mapping `amount_capturable_updated` onto `charge.succeeded` would book cash
    // against a hold; mapping a cancel onto `charge.failed` would reverse cash
    // that was never booked and re-arm dunning; and routing `setup_intent.*`
    // through `payment_method.updated` would hand the card-updater a card-less
    // payload and blank a stored instrument. Correlate these on
    // `payment_intents.intent_at_gateway` — an unconsumed intent has no
    // `transactions` row, so the charge-path lookup cannot reach it.
    | "intent.authorized"
    | "intent.failed"
    | "intent.voided"
    | "intent.setup_succeeded"
    | "intent.setup_failed"
    /**
     * The buyer must AUTHENTICATE before this intent can go anywhere — 3DS on a
     * card, or an RBI pre-debit approval on an India e-mandate debit.
     *
     * Distinct from every term above because none of them is true yet: nothing is
     * authorized (no hold exists), nothing failed (the attempt is alive), and
     * nothing was voided. Borrowing `intent.failed` would fail an attempt the buyer
     * can still complete and re-arm dunning against a live challenge.
     *
     * It arrives ASYNCHRONOUSLY, which is the whole reason it exists as an event:
     * the synchronous `charge()` / `createIntent()` path already returns
     * `status: 'requires_action'` when the requirement is known at call time, but
     * Stripe also raises it *after* the call — dynamic 3DS, an issuer soft-decline
     * upgraded to a challenge, and (the load-bearing case) an India off-session
     * debit above ₹15,000 or above the mandate ceiling, where the challenge link
     * rides the bank's pre-debit notification up to 26 hours later.
     *
     * `actionDeadline` is what makes it actionable rather than a notice: past it the
     * gateway stops waiting, so it is the last moment a reminder can still save the
     * payment.
     */
    | "intent.requires_action"
    /**
     * The gateway MINTED an intent. Nothing has happened to it yet, and nothing may act
     * on this inline.
     *
     * It is the only signal that exists when an intent was created at the gateway but our
     * request path never recorded it — a timeout, or a crash between the gateway's
     * response and our commit. That leaves money armed with no local row, and no other
     * event ever mentions it: a charge that follows correlates on a transaction we do not
     * have, and the unapplied-money alert counts tagged PAYMENTS, of which there are none.
     *
     * ⚠️ It arrives BEFORE our own transaction commits, so "no local row" is momentarily
     * true of nearly every payment we make. Orphanhood is a question only a sweep may
     * ask, after a grace period — see `sweepOrphanedIntents`.
     */
    | "intent.created"
    /**
     * A refund we booked did NOT land — reversed by the bank, or refused at the
     * network (closed account, stale ACH details).
     *
     * Its own term rather than `charge.failed`: the charge succeeded and must stay
     * succeeded. Pointing a refund failure at the charge path looks up the ORIGINAL
     * payment's `id_at_gateway` and, on a transaction still open, would fail a
     * settled payment and re-arm dunning for money the customer already paid.
     * Correlate on `providerRefundId`.
     */
    | "refund.failed"
    /**
     * A refund EXISTS at the gateway and has not landed yet — Stripe `refund.created`,
     * RazorPay `refund.created`, PayPal `PAYMENT.REFUND.PENDING`.
     *
     * One term for "created" and "pending" on purpose: the engine's question is not
     * which of the two the gateway said, it is *"money is on its way out and our books
     * do not know about it"*. The case that matters is a refund a human raised in the
     * gateway's own dashboard — invisible to us until it processes, which on an eCheck
     * rail is days later. Stripe's own `charge.refunded` doc points at it: "Listen to
     * `refund.created` for information about the refund".
     *
     * ⚠️ NOT `charge.refunded`: nothing has left yet, and a refund that then failed
     * would leave a booking for money that never moved. (A Stripe refund created
     * already `succeeded` is reported as `charge.refunded` with `refunds` set, which
     * books per refund id, so the `charge.refunded` for the same refund cannot double it.)
     *
     * **Persist-only.** `refund.processed` / `charge.refunded` still does the booking,
     * and `refund.failed` still does the reversal; this exists so the window between
     * them is not silence.
     */
    | "refund.pending"
    /**
     * The gateway is WITHHOLDING our funds (Stripe `reserve.hold.created` /
     * `.updated`). Not a customer's money at all — ours, held back out of what would
     * otherwise settle to the bank.
     *
     * One term for created and updated, because a hold is a single object moving
     * through states and the engine takes no different action on either.
     *
     * ⚠️ NOT `settlement.*`, even though it is measured in the same units and shows up
     * in the same place: a settlement is money that MOVED, and a reader who treats a
     * reserve hold as a payout will reconcile the bank against a credit that never
     * arrived. It does borrow the `settlement*` FIELDS — id / amount / currency /
     * status — for the reason that block already gives: `provider_events.normalized`
     * makes them queryable with no new storage, and a reserve is exactly the deduction
     * that explains a payout's gap from gross.
     *
     * **Persist + alert, never booked.** See `charge.reversed` for why the booking is
     * not decided here.
     */
    | "reserve.hold.updated"
    /**
     * The RAIL is down, or is back — RazorPay's `payment.downtime.*`.
     *
     * OBSERVABILITY ONLY, and that boundary is the whole design. Nothing in the
     * collection path reads these: no pre-flight skip, no deferral, no effect on
     * `attempt_count` or `next_attempt_at`. They exist so an operator looking at a burst
     * of failures can see it was the gateway rather than the cards.
     *
     * ⚠️ Deliberately NOT wired into dunning, though the case for it is real (a retry
     * spent during an outage is spent on a certainty). Doing so needs a stored window
     * that collection consults, and a window that never receives its `.resolved` event
     * would then freeze collection — the `graphile` stranded-lock failure again, whose
     * lesson was that the expiry has to be designed in rather than aged out afterwards.
     * As a derived alert it is self-clearing: a stale `.started` simply ages out of the
     * report's window and can stop nothing.
     */
    | "gateway.downtime_started"
    | "gateway.downtime_resolved"
    /**
     * A gateway PAYOUT was attempted and failed (Stripe `payout.failed`). Persisted
     * for reconciliation alongside `settlement.processed`; no engine handler, because
     * a failed payout moves nothing on a customer's account — it is a bank-side
     * problem between the gateway and the merchant.
     */
    | "settlement.failed"
    /**
     * The network told the gateway a charge is probably fraudulent BEFORE any dispute
     * exists (Stripe `radar.early_fraud_warning.created`). Persist-only: refunding on
     * a warning is the merchant's commercial call, not something the engine may do on
     * its own, and a dispute that follows arrives as `dispute.created` anyway.
     */
    | "fraud_warning.created"
    /**
     * The gateway put a payment under MANUAL review, or closed that review (Stripe
     * Radar `review.opened` / `review.closed`). Persist-only: the payment's own
     * outcome still arrives as `charge.succeeded` / `charge.failed`, so acting here
     * would double-book. Recorded because an open review is why a charge is sitting
     * in limbo, and that is otherwise invisible to whoever is looking.
     */
    | "review.opened"
    | "review.closed"
    | "unknown";
  /** Correlates back to one of our objects when determinable. */
  providerChargeId?: string;
  providerRefundId?: string;
  /**
   * The gateway's INTENT id, when the event is about an intent rather than a
   * charge. Required as its own field because the two are not interchangeable:
   * a RazorPay intent is keyed by the ORDER id while the payment webhook carries
   * a PAYMENT id, so correlating intents through `providerChargeId` would look up
   * the wrong object (or nothing). Resolve against
   * `payment_intents.intent_at_gateway`.
   */
  providerIntentId?: string;
  /**
   * On an `intent.authorized` only: the id the attempt is addressed by from now on, when the
   * gateway's page minted the payment under a different id than the intent's (Adyen's
   * pspReference behind a payment link). The engine re-points the current attempt to it, the
   * same way `FetchedIntent.gatewayIntentId` does for a browser result.
   */
  gatewayIntentId?: string;
  /**
   * On an `intent.authorized` only: the gateway took the money at the buyer's confirm
   * (automatic capture), so there is no hold. `succeeded` = the money arrived;
   * `processing` = a bank debit is in flight. Absent = an ordinary authorization hold.
   */
  captureState?: "succeeded" | "processing";
  /**
   * Is the object this event is about OURS? — the three-way answer #31 needs.
   *
   *  · `ours`    — the gateway object carries our `ownershipRef`. Set only when the
   *                adapter actually READ the tag, never inferred from a local match.
   *  · `foreign` — the adapter read the object's tags and ours was absent. A sibling
   *                product on a shared gateway account. Countable, and never a page.
   *  · `unknown` — the adapter could not tell (no tag field, an older object created
   *                before tagging, or it did not look). **The default, and it must NOT
   *                be treated as `foreign`.** Reading silence as "not ours" would turn
   *                a tagging regression into invisible money loss the day a deploy stops
   *                stamping refs — the same error as reading a missing poll answer as
   *                "nothing held" (see `VoidIntentResult.held`).
   *
   * Tags are FORWARD-ONLY: objects created before this shipped answer `unknown`
   * forever, so the classifier has to stay useful without them.
   */
  ownership?: "ours" | "foreign" | "unknown";
  /** The `ownershipRef` read back off the gateway object, when `ownership` is `ours`. */
  ownershipRef?: string;
  /**
   * When the GATEWAY created the object this event is about — not when the event fired.
   *
   * The classifier's rule is "created after tagging shipped and carries no tag ⇒ provably
   * not ours", and `occurredAt` cannot answer it: a capture that happens today may belong
   * to an order created weeks before tagging existed, and reading the event time as the
   * object's age would mark that historical object foreign on no evidence at all.
   * Every provider carries this (RazorPay `created_at`, Stripe `created`, PayPal
   * `create_time`), so the adapter reports it and the engine compares.
   */
  providerObjectCreatedAt?: Date;
  /**
   * `intent.requires_action`: WHAT the buyer has to do, in the gateway's own
   * vocabulary (Stripe `next_action.type` — `redirect_to_url`, `use_stripe_sdk`, …),
   * or `pre_debit_notification` for an RBI approval that happens entirely at the
   * bank with no URL for us to send anyone to. Kept raw because the handling that
   * matters differs per action type and normalizing would erase exactly that.
   */
  actionType?: string;
  /**
   * `intent.requires_action`: the moment the gateway stops waiting for the buyer.
   * On an India off-session debit this is
   * `processing.card.customer_notification.completes_at` — the end of the 26-hour
   * pre-debit window, after which the debit is attempted (or refused) without them.
   *
   * Absent = the gateway named no deadline; callers must not invent one.
   */
  actionDeadline?: Date | null;
  /**
   * `charge.refunded`: the charge's RUNNING total across all its refunds (minor units), and
   * only when the gateway itself states that total. Never this refund's own amount: the
   * engine books `total − recorded`, so a per-refund amount here under-books or drops the
   * second out-of-band refund. A gateway whose refund events carry one refund's amount sends
   * `refunds` instead. Absent with no `refunds` = a full refund.
   */
  amountRefundedMinor?: bigint;
  /** `charge.*`: the charge's own amount in minor units, when the payload carries it. */
  amountMinor?: bigint;
  /**
   * `charge.succeeded`: the amount the gateway captured, in minor units of the charge's
   * currency, when the event carries it. Absent = unknown, never zero.
   */
  capturedAmountMinor?: bigint;
  /**
   * `charge.refunded`: every refund the event names, each with its OWN id and amount. The
   * provider-agnostic path, and the one to use when a refund event carries one refund's
   * amount (not a running total). When set, `amountRefundedMinor` is ignored and the engine,
   * per refund id, under the payment's row lock:
   *  - books an out-of-band refund once, when it is `succeeded`, capped at what is left;
   *  - settles our own `pending` refund (matched by id, or by `ownershipRef` when our create
   *    answer was lost);
   *  - reverses what that id booked when it is `failed`.
   * Redelivery and several events naming one refund book nothing twice.
   */
  refunds?: ProviderRefundRecord[];
  /**
   * `charge.failed`: the decline in the SAME normalized vocabulary a synchronous
   * `ChargeResult.failure` uses, so smart dunning classifies an async decline
   * exactly as it would a synchronous one.
   *
   * This exists because the two halves of the engine used to disagree. A card
   * declined during `charge()` is normalized and reaches `classifyDecline`, which
   * can park or terminate. The identical decline arriving minutes later as a
   * webhook — the ONLY way UPI Autopay and netbanking e-mandate ever report an
   * outcome, since their debits are asynchronous — carried no code at all, so the
   * settlement path passed a placeholder and smart dunning silently degraded to
   * fixed retries on precisely the rails where it matters most.
   *
   * ⚠️ Set it by running the adapter's own `normalize*Decline` — never by copying
   * the raw gateway string in. The invariant that matters is not that the value is
   * always canonical (an unmapped code passes through both normalizers unchanged,
   * and `classifyDecline` then falls to its liberal `retry` default) but that it is
   * *the same value the synchronous path would have produced for this decline*.
   * That is what makes the two classify identically.
   *
   * Absent = the adapter could not classify the failure; callers keep their old
   * behaviour rather than guessing.
   */
  failureCode?: string;
  /** The gateway's own code alongside the normalized one — lossy normalization, so keep both. */
  providerFailureCode?: string;
  /** Our sentence for the failure when a decline rule wrote one, else the gateway's text. */
  failureMessage?: string;
  /**
   * Whether retrying this instrument could ever succeed. Absent = unknown, and
   * callers must default to retriable: treating an unclassified async failure as
   * hard would mark a working payment method `invalid`.
   */
  failureRetriable?: boolean;
  /**
   * `charge.failed`: the gateway withdrew a charge it had already reported settled
   * (PayPal `PAYMENT.CAPTURE.DENIED` after COMPLETED, a SEPA or ACH return, a settlement
   * decline). On a succeeded transaction the engine books it as a late-failure reversal;
   * on any other it is an ordinary failure. THE way to ask for a reversal: set this, not
   * `raw.data.reversal`, which is still honoured for older adapters but deprecated.
   */
  lateReversal?: boolean;
  /**
   * A late reversal or `charge.reversed`: the amount the gateway says it took back, in minor
   * units of the charge's currency. Absent = what the payment still holds (paid less refunds
   * and dispute withdrawals). Capped at that either way.
   */
  reversalAmountMinor?: bigint;
  /** payment_method.updated: the provider payment-method id + refreshed card fields. */
  providerPaymentMethodId?: string;
  card?: {
    brand?: string | null;
    last4?: string | null;
    expMonth?: number | null;
    expYear?: number | null;
  };
  /**
   * payment_method.mandate_updated: the mandate's new state, correlated by
   * `providerPaymentMethodId`. Only the fields the event actually reports are set —
   * a partial update, never a full replacement, so an event that says nothing about
   * the ceiling must not erase the stored one.
   */
  mandate?: ProviderMandate;
  /**
   * `payment_method.mandate_updated`: the gateway replaced the mandate with a new one (a
   * GoCardless `replaced` mandate). The engine moves the stored method to this id;
   * `mandate` and `paymentMethodDisplay` then describe the new mandate.
   */
  replacementPaymentMethodId?: string;
  /** `payment_method.mandate_updated`: the instrument's current bank display, when it changed. */
  paymentMethodDisplay?: ProviderPaymentMethodRef["display"];
  /**
   * `settlement.processed`: the payout, parsed into the numbers that reconcile it.
   *
   * Carried on the normalized event rather than a dedicated table because
   * `provider_events` already persists both `payload` (raw) and `normalized` for every
   * inbound webhook — so these are queryable without new storage, and a reconciliation
   * report can be built on them when one exists. `settlementAmountMinor` is NET (what
   * reached the bank); gross = amount + fees + tax.
   */
  settlementId?: string;
  settlementAmountMinor?: bigint;
  settlementFeesMinor?: bigint;
  settlementTaxMinor?: bigint;
  settlementCurrency?: string | null;
  settlementStatus?: string | null;
  /** Bank reference — the only field that ties a payout to a statement line. */
  settlementUtr?: string | null;
  /**
   * What the GATEWAY charged US for this one charge — its own cut, in minor units of
   * the charge's currency, inclusive of {@link feeTaxMinor}.
   *
   * ⚠️ Not the same number as `settlementFeesMinor`, and the distinction is the point.
   * That one is a PAYOUT's netted total across many payments; this is the fee on the
   * single charge this event is about, which is the only granularity at which the cost
   * of one round trip can be known. Both existing at once is not duplication — a payout
   * fee cannot be attributed to a charge, and a charge fee cannot reconcile a bank line.
   *
   * Surfaced here rather than read from the raw payload downstream because that is what
   * the adapter boundary is for (CLAUDE.md: the engine never reaches past it). RazorPay
   * puts it on the payment entity of every event that carries one — measured 2026-09-03
   * on a live payment: `fee: 43192`, `tax: 6588` (₹431.92, of which ₹65.88 GST),
   * present identically on `payment.captured`, `order.paid` AND `refund.processed`. The
   * fee is NOT returned when the charge is: that capture-and-refund round trip cost
   * ₹431.92 that our books record as zero.
   *
   * Absent = the gateway did not report one (Stripe/PayPal name no per-charge fee on
   * these events; a `payment.failed` carries none). **Absent means unknown, never
   * zero** — the same rule every optional field here follows.
   *
   * ⚠️ Deliberately NOT accounted for anywhere yet: there is no fee column, no fee
   * ledger account and no fee posting, and adding one is a real feature with a real
   * design (which side of the ledger, whose currency, how it reconciles against the
   * payout that nets it). This makes the number AVAILABLE and reportable; it does not
   * book it.
   */
  feeMinor?: bigint;
  /**
   * The tax component INSIDE {@link feeMinor} — GST on the gateway's fee, in RazorPay's
   * case. Carried separately because it is separately recoverable by the merchant and
   * so is not interchangeable with the fee itself.
   */
  feeTaxMinor?: bigint;
  /** dispute.*: the provider dispute id + normalized details (correlate via providerChargeId). */
  providerDisputeId?: string;
  disputeReason?: string | null;
  disputeStatus?: string | null;
  disputeAmountMinor?: bigint;
  /**
   * `dispute.won` / `dispute.funds_reinstated`: the amount the merchant won back, when the
   * gateway says it may be less than the disputed amount (Braintree `amountWon`). Only that
   * much is reinstated or credited back; the rest stays a loss. Absent = all of it.
   */
  disputeAmountWonMinor?: bigint;
  disputeCurrency?: string | null;
  evidenceDueBy?: Date | null;
  /** `intent.setup_failed`: a refused registration that still took money; the engine refunds it. */
  setupAuthCharge?: ProviderPaymentMethodRef["setupAuthCharge"];
  /** For `pre_debit_notice.updated`: the notice by its gateway ref, and its new state. */
  preDebitNotice?: {
    notificationRef: string;
    status: "sent" | "failed";
    executableAfter?: Date;
    failureCode?: string;
    failureMessage?: string;
  };
  occurredAt: Date;
  /**
   * The adapter could not read the object this event is about, so the event carries
   * no money fields. The handler books nothing and records `error`, and the gateway
   * delivers the event again.
   */
  unresolved?: string;
  raw: unknown;
}

/** What `removeWebhookEndpoint` did at the gateway. */
export interface WebhookRemoval {
  removed: boolean;
  /** The gateway cannot delete, so the registration was switched off instead. */
  deactivatedOnly?: boolean;
}

/** What a provider hands back when we register our notification URL with it. */
export interface ProvisionedWebhook {
  /** Provider-generated signing secret (Stripe `whsec_…`). */
  webhookSecret?: string;
  /** Provider-side endpoint id, used with a verify API instead of a secret (PayPal). */
  webhookId?: string;
  /** Provider's id for the endpoint object, for later update/delete. */
  providerEndpointId?: string;
}

export interface NormalizeWebhookInput {
  /** Raw request body (verbatim, for signature verification). */
  payload: string | Buffer;
  headers: Record<string, string | string[] | undefined>;
  /**
   * The notification URL registered for this account (`buildNotificationUrl`). Square signs
   * the URL together with the body, so its check needs the exact string.
   */
  notificationUrl?: string;
  /**
   * Which of these provider event ids this delivery's scope has already settled. An adapter
   * that reads the gateway to map an event skips the read for those: the engine dedups them
   * anyway, and the gateway's answer deadline is short. Absent = unknown, map everything.
   */
  settledEventIds?: (ids: string[]) => Promise<ReadonlySet<string>>;
}

/** Contract v2 (C3): result of a payment-method verification probe. */
export interface VerifyResult {
  verified: boolean;
  /** Normalized method status after the probe. */
  status?: "valid" | "invalid" | "expired";
  detail?: string;
}

export interface VerifyPaymentMethodInput {
  customer: ProviderCustomerRef;
  paymentMethod: ProviderPaymentMethodRef;
}

/**
 * What an intent is FOR.
 *
 *  - `payment` — a priced authorization captured into an invoice.
 *  - `setup`   — a ZERO-amount authorization whose product is a vaulted
 *    instrument, not money. This is the common case in practice: most real
 *    intents are $0.00 Stripe SetupIntents (`seti_…`) taken to vault a card
 *    behind a 3DS challenge at signup or portal add-card. Our old model
 *    required a positive amount and so could not represent them at all.
 *
 * One object covers both — see the `purpose` column on `payment_intents`.
 */
export type IntentPurpose = "payment" | "setup";

/**
 * The one reading of `ProviderCapabilities.intentPurposes`: absent or empty means both
 * purposes. Routing, the vault list and the intent guard all use it.
 */
export function allowsIntentPurpose(
  purposes: readonly IntentPurpose[] | null | undefined,
  purpose: IntentPurpose,
): boolean {
  return !purposes?.length || purposes.includes(purpose);
}

/**
 * The one reading of `preDebitNotice` for a rail: its `byMethod` entry over the defaults.
 * No rail (a notice update that does not name it): the longest lead any rail needs.
 */
export function preDebitRule(
  cap: NonNullable<ProviderCapabilities["preDebitNotice"]>,
  method?: string | null,
): { minLeadHours: number; maxDebitsPerNotice: number } {
  if (!method) {
    const leads = Object.values(cap.byMethod ?? {}).map((r) => r?.minLeadHours ?? 0);
    return {
      minLeadHours: Math.max(cap.minLeadHours, ...leads),
      maxDebitsPerNotice: cap.maxDebitsPerNotice,
    };
  }
  const r = cap.byMethod?.[method as MethodType];
  return {
    minLeadHours: r?.minLeadHours ?? cap.minLeadHours,
    maxDebitsPerNotice: r?.maxDebitsPerNotice ?? cap.maxDebitsPerNotice,
  };
}

/** Contract v2 (C3/C7): a payment intent for on-session (3DS) / off-session flows. */
export interface CreateIntentInput {
  purpose: IntentPurpose;
  /** Same as `InitiateVaultSetupInput.contact`. */
  contact?: ProviderContact;
  /**
   * The buyer picks the method in the gateway's sheet and the intent pays an invoice
   * that already exists. A gateway may then capture a method that cannot be held at the
   * buyer's confirm — consume books that money against the invoice. Never set without an
   * invoice: money captured with nothing to apply it to has no home.
   */
  captureOnConfirm?: boolean;
  /**
   * OUR id for the thing being created, stamped onto the gateway object so a capture
   * can later be proved ours — or proved NOT ours.
   *
   * ── Why this exists (#31, 2026-09-04) ───────────────────────────────────────
   * A gateway account can serve several products: the RazorPay account here is shared
   * with another product, so this engine receives capture webhooks for payments it never created —
   * 124 such events had already arrived when this was written. Money was never at risk,
   * because booking requires matching our own intent or transaction and the engine
   * refuses to guess a customer. What WAS broken is that "another product's charge"
   * (normal, should be silent) and "our capture we failed to attribute" (a money
   * incident) produced the SAME log line, so the second could never be alerted on.
   *
   * The adapter maps this to its provider's own field — Stripe `metadata.tmbilling_ref`,
   * RazorPay `notes.tmbilling_ref`, PayPal `custom_id` — so the engine never touches
   * provider JSON (CLAUDE.md). Two precedents already existed and neither reached a
   * MONEY object: `stripe.ts`'s `ensureCustomer` stamps and verifies this on customers,
   * and RazorPay's e-mandate path verifies a receipt prefix.
   *
   * ⚠ NOT a substitute for matching. Matching still goes through the ids we store
   * (`intent_at_gateway`, `provider_charge_id`); the tag exists for the one case ids
   * cannot cover — the gateway object was created but our row was never written, since
   * `createIntent` reaches the network BEFORE the insert.
   */
  ownershipRef?: string;
  /**
   * Integer minor units. Omitted (or 0n) for `setup` — a card-verification
   * intent moves no money, and demanding a positive amount here is precisely
   * what made setup intents unrepresentable before.
   */
  amountMinor?: bigint;
  currency: string;
  customer: ProviderCustomerRef;
  /**
   * The instrument to authorize. Absent on a `setup` intent, where the buyer
   * supplies the instrument DURING the challenge — there is nothing vaulted yet.
   */
  paymentMethod?: ProviderPaymentMethodRef;
  idempotencyKey: string;
  /** on_session buyers can complete a challenge; off_session cannot. */
  session?: "on_session" | "off_session";
  /** Where the gateway returns the buyer after a redirect challenge. */
  returnUrl?: string;
  cancelUrl?: string;
  /**
   * Instruments the buyer may use, in our canonical vocabulary (`card`,
   * `us_bank_account`, `upi`, …) — same meaning as on `InitiateVaultSetupInput`.
   */
  methodTypes?: string[];
  /**
   * Ceiling for any single future debit under a mandate set up by a `setup`
   * intent, in minor units of `currency` — same meaning as on
   * `InitiateVaultSetupInput`, and carried here for the same reason: mandate
   * rails demand an upper bound up front, a debit above it fails at charge time,
   * and letting the adapter fall back to a constant silently caps what a
   * business can bill. Ignored for `purpose: 'payment'`.
   */
  maxAmountMinor?: bigint;
  /**
   * `setup` only, on a method in `capabilities.setupCollectsFirstCharge`: the registration
   * collects this amount (the first invoice) instead of a token auth amount.
   */
  firstChargeMinor?: bigint;
  description?: string;
  metadata?: Record<string, string>;
  /** When our intent expires. A gateway whose payment page outlives it can close at the same time. */
  expiresAt?: Date;
  /**
   * A pay-now intent for a wallet the buyer pays with on the GATEWAY's hosted page
   * (`GatewayDefinition.applePayHosted`). Apple Pay on the web needs the page's domain verified
   * with the gateway's own file; our one storefront domain already serves another gateway's,
   * so the buyer pays on the gateway's domain and returns. Answer `mode: 'redirect'`.
   */
  hostedWallet?: "apple_pay";
}

export interface IntentRef {
  /** The gateway's own id — Stripe `pi_`/`seti_`, PayPal order id, RazorPay order id. */
  intentId: string;
  status: "inited" | "requires_action" | "authorized";
  /**
   * Present when status === 'requires_action': how the buyer completes the
   * challenge. Deliberately the SAME descriptor `initiateVaultSetup` returns,
   * so one client-side renderer handles both flows.
   */
  authorization?: BuyerAuthorization;
  /**
   * Set when the gateway REFUSED the authorization (declined card, failed
   * mandate). A decline is an ordinary outcome of creating an intent, not an
   * exceptional one — it must land on the attempt row as `failed` with a
   * normalized code so dunning and retry can reason about it. Adapters must
   * populate this rather than throwing; same shape as `ChargeResult.failure`.
   */
  failure?: ChargeResult["failure"];
  raw?: unknown;
}

export interface ConsumeIntentInput {
  intentId: string;
  idempotencyKey: string;
  /** Decides what consuming MEANS — capture money, or harvest the vaulted instrument. */
  purpose: IntentPurpose;
  /** Capture amount (minor units). Omit to capture the full authorized amount. */
  amountMinor?: bigint;
  currency?: string;
}

/**
 * Consuming a `payment` intent produces a charge; consuming a `setup` intent
 * produces a vaulted instrument and no money movement. A single ChargeResult
 * return type could only express the first, which is why setup intents had
 * nowhere to land.
 */
export type ConsumeIntentResult =
  | { purpose: "payment"; charge: ChargeResult }
  /**
   * Exactly ONE of `paymentMethod` / `failure` is present. A refused setup (3DS
   * declined on the vault, mandate rejected) is an ordinary outcome and must
   * land on the attempt row as `failed` with a normalized code — the same way a
   * refused payment does through `ChargeResult.failure`. Without this arm the
   * setup path could only throw, which would make failure exceptional rather
   * than data and leave the attempts model blind precisely where failed and
   * expired intents must show.
   */
  | {
      purpose: "setup";
      paymentMethod?: ProviderPaymentMethodRef;
      failure?: ChargeResult["failure"];
      /** A refused registration that still took money (PayU E755): the engine refunds it. */
      setupAuthCharge?: ProviderPaymentMethodRef["setupAuthCharge"];
    };

export interface CancelPendingChargeInput {
  /** The id `charge()` returned — what the engine stores as `id_at_gateway`. */
  providerChargeId: string;
  /** Stable per debit, so a retried cancel cannot do anything twice. */
  idempotencyKey: string;
}

/**
 * The OBSERVED result of asking the gateway to stop a pending debit.
 *
 * `cancelled` only when the gateway itself reports the debit cancelled — never because the
 * call returned 2xx. A cancel the adapter cannot confirm is `not_cancelable`: the debit may
 * still collect, and the engine must not book it as stopped.
 */
export interface CancelPendingChargeResult {
  status: "cancelled" | "not_cancelable" | "already_final";
  /** For `already_final`: the outcome, in the shape `fetchChargeStatus` returns. */
  charge?: ChargeResult;
  /** The gateway's own words for a refusal, for the log. */
  reason?: string;
  raw?: unknown;
}

export interface VoidIntentInput {
  intentId: string;
  idempotencyKey: string;
}

export interface VoidIntentResult {
  voided: boolean;
  /** The gateway's reversal/void id, when it mints one — shown on the intent timeline. */
  providerTransactionId?: string;
  /**
   * Was the buyer's money ACTUALLY held when this void happened?
   *
   * ── Why the adapter has to answer, and the engine must not guess ─────────────
   * A void books a `payment_reversal`, and booking one for a hold that never existed
   * invents a release of money the bank never took. Measured 2026-09-03: **63 of the
   * 102 intent reversals** in the dev database are exactly that shape, because
   * `voidPaymentIntent` refuses only `consumed`/`voided`/`expired` and so reaches the
   * gateway on an `in_progress` checkout the buyer never completed (#21).
   *
   * `undefined` means the adapter cannot say — NOT "nothing was held". The caller keeps
   * its previous behaviour there, because reading silence as "no hold" is the same
   * mistake one rung down: it would silently stop booking reversals that are real.
   *
   * Every provider can answer this from what it ALREADY returns, so no poll is needed
   * (researched against vendor docs 2026-09-04):
   *  · **Stripe** — `requires_capture` / `amount_capturable > 0` IS the discriminator,
   *    and the cancel response returns both. Their docs: "For PaymentIntents with a
   *    `status` of `requires_capture`, the remaining `amount_capturable` is
   *    automatically refunded." A cancel from `requires_action` releases nothing.
   *  · **PayPal** — the void endpoint takes an AUTHORIZATION id
   *    (`POST /v2/payments/authorizations/{id}/void`), and an authorization means a hold
   *    was placed. So possession of one is the answer; `Prefer: return=representation`
   *    returns the object rather than a bare 204 if the amount is wanted too.
   *  · **RazorPay** — already answered, via the `fetchIntent` poll `heldBeforeVoid` uses.
   */
  held?: boolean;
}

/**
 * What the GATEWAY says about an intent right now — the answer our own
 * `payment_intents.status` cannot give once a callback is late.
 *
 * ── Why this is not an `IntentRef` ────────────────────────────────────────────
 * `IntentRef` is what CREATING an intent returns, and its status union stops at
 * `authorized` because that is as far as a create can get. A poll has to be able to
 * say the two things that come after — captured, and refused — or its caller learns
 * nothing from asking. It is the same relationship `fetchChargeStatus` has to
 * `charge()`, one step further back in the flow.
 *
 * ⚠️ `unknown` is a first-class answer and must never be read as "nothing is held".
 * A gateway that has not heard of an id (or a rail whose id shape this adapter cannot
 * query) has told us nothing, and the caller's correct move is to keep the behaviour
 * it had before it asked — see `releaseHoldBeforeExpiry`, which logs and leaves the
 * hold alone rather than inventing a verdict either way.
 */
export interface FetchedIntent {
  /** Echoed back, so a caller batching polls can pair answers with questions. */
  intentId: string;
  /**
   * Ownership, when the caller asked for it with `resolveOwnership` — same three-way
   * meaning as on `NormalizedProviderEvent`, and `unknown` is still not `foreign`.
   *
   * ⚠ These are here because reading the tag is NOT free, which corrected the plan:
   * RazorPay's `fetchIntent` calls `GET /orders/{id}/payments` and gets PAYMENT entities
   * back, so the ORDER's `notes` and `created_at` are simply not in that response —
   * measured by G1b on 2026-09-04, against a brief that assumed the order was already
   * being fetched. Resolving ownership costs a SECOND call (`GET /orders/{id}`), which is
   * why it is opt-in per call rather than always-on: the happy path must stay at one GET.
   */
  ownership?: "ours" | "foreign" | "unknown";
  ownershipRef?: string;
  providerObjectCreatedAt?: Date;
  /**
   * Normalized intent state:
   *  - `inited` / `requires_action` — nothing is authorized yet; no money is held.
   *  - `authorized` — the gateway is HOLDING the buyer's funds. The one answer that
   *    means "there is something to release".
   *  - `consumed` — captured (or captured and since refunded): the money moved, so
   *    this is not a hold, and a caller chasing holds must leave it to the charge path.
   *  - `voided` / `failed` — terminal with nothing held.
   *  - `unknown` — we could not find out. See the warning above.
   */
  status:
    | "unknown"
    | "inited"
    | "requires_action"
    | "authorized"
    | "consumed"
    | "voided"
    | "failed";
  /**
   * The CHARGE id behind the intent, when the gateway names one.
   *
   * Load-bearing on RazorPay, and the reason this field exists rather than being left
   * to the caller: `payment_intents.intent_at_gateway` holds the ORDER id
   * (`order_…`), while the money handle is the PAYMENT id
   * (`pay_…`) — measured 2026-09-03, our side had the pair in exactly one
   * place, inside a `provider_events.normalized` blob. So the poll is keyed on what we
   * store (the order) and hands back the id an operator actually needs to reconcile or
   * refund with.
   */
  providerChargeId?: string;
  /**
   * The gateway took the money when the BUYER confirmed (automatic capture), not on a
   * capture call of ours. Set with `consumed` only. The engine books such an intent
   * through consume, whose adapter reads the captured result instead of capturing.
   * Absent, `consumed` keeps its old meaning: money moved that consume did not move.
   */
  capturedOnConfirm?: boolean;
  /** Authorized/captured amount as the GATEWAY reports it, in minor units. */
  amountMinor?: bigint;
  currency?: string;
  /**
   * `submitClientResult` only: the id the gateway knows this intent by from now on (the
   * vaulted token, the authorized transaction). The engine stores it on the attempt, so
   * `consumeIntent` receives it as `intentId` — adapters stay stateless.
   */
  gatewayIntentId?: string;
  /** `submitClientResult` only, with `status: 'failed'`: the refusal, normalized. */
  failure?: { code: string; message: string };
  /**
   * `submitClientResult` only: the method that paid (`ChargeResult.methodUsed` vocabulary).
   * The engine keeps it on the attempt for a capture that names no method.
   */
  methodUsed?: string;
  raw?: unknown;
}

/**
 * What a provider says about one storefront domain's wallet support.
 *
 * `enabled` is the provider's own flag for the domain as a whole; `wallets` carries the
 * per-wallet verdict, because Apple Pay can be inactive on a domain where Google Pay is
 * fine (they verify differently). `detail` is the provider's explanation when a wallet is
 * inactive — surfaced verbatim rather than reworded, since it names the actual cause
 * (usually that the association file is not reachable).
 */
export interface WalletDomainStatus {
  domain: string;
  enabled: boolean;
  wallets: Array<{ wallet: string; active: boolean; detail?: string }>;
}

export interface PaymentProvider {
  readonly key: ProviderKey;
  readonly capabilities: ProviderCapabilities;

  /** Create/fetch the provider-side customer mirror, if the provider needs one. */
  ensureCustomer(input: EnsureCustomerInput): Promise<ProviderCustomerRef>;

  /**
   * Push current identity details (name/email/address) onto an EXISTING
   * provider customer (reused via the provider_customers mapping). Optional —
   * providers without a customer-update API just skip it.
   */
  updateCustomer?(ref: ProviderCustomerRef, input: EnsureCustomerInput): Promise<void>;

  vaultPaymentMethod(input: VaultPaymentMethodInput): Promise<ProviderPaymentMethodRef>;

  /**
   * Optional: begin a buyer-approval vault flow (off-session mandate). Providers
   * that can vault a server-side token (e.g. Stripe via tok_/pm_) don't implement
   * this; PayPal/RazorPay do, returning an approval URL the buyer must visit.
   * After approval, the returned setupTokenId is passed to vaultPaymentMethod().
   */
  initiateVaultSetup?(input: InitiateVaultSetupInput): Promise<VaultSetupRef>;

  /** Contract v2 (C3): a $0-auth / micro-deposit probe that the method is chargeable. */
  verifyPaymentMethod?(input: VerifyPaymentMethodInput): Promise<VerifyResult>;

  charge(input: ChargeInput): Promise<ChargeResult>;

  /**
   * Ask the gateway what actually became of a charge we already placed.
   *
   * Optional, and NOT part of the ordinary money path — settlement arrives by
   * webhook, and polling for it would be both slower and less reliable. This
   * exists for the one case a webhook cannot cover: a webhook that never came.
   *
   * An async debit is booked `pending` + `in_progress` and the invoice is parked
   * with `next_attempt_at = null`, waiting for the callback. If that callback is
   * lost — mis-provisioned endpoint, an outage on either side, a tunnel that was
   * down — nothing else in the engine ever revisits it: the money may well have
   * moved, and the invoice sits open forever with dunning halted. That was
   * survivable while the async rails were a minority; it is not once INR
   * subscriptions renew over UPI Autopay (settles in minutes-to-hours) and
   * netbanking e-mandate (up to 2 working days), where a long pending window is
   * the normal case rather than a symptom.
   *
   * Returns the same `ChargeResult` shape `charge()` does, so the sweep can hand
   * the verdict to exactly the settlement path a webhook would have taken. A
   * `pending` answer means the gateway is still working and the sweep leaves it
   * alone. Adapters without this are simply never swept — the sweep says so rather
   * than inventing an outcome.
   */
  fetchChargeStatus?(input: { providerChargeId: string }): Promise<ChargeResult>;

  /**
   * Find a charge whose create answer was lost — `charge()` threw `ProviderIndeterminateError`
   * and left no gateway id — by what we sent: the `ownershipRef` stamped on the gateway
   * object and the `idempotencyKey`. The charge-side twin of {@link locateRefund}.
   *
   * Returns the charge as `charge()` would have (with its gateway id), or `null` when the
   * gateway has no charge created after `createdAfter` with that ref or key — a DEFINITE
   * answer. Throws when the gateway could not be asked. Must search at least from
   * `createdAfter`, and must not create anything (no replay of the charge) — except an
   * adapter with `capabilities.locateByReplay`, and only when `replay` is set.
   *
   * The lost-answer sweep asks after a grace period and keeps asking; only a `null` given
   * 24 hours after the attempt fails it (`gateway_charge_not_created`) and lets dunning
   * retry. An adapter without this method leaves the row for an operator.
   */
  locateCharge?(input: {
    ownershipRef: string;
    idempotencyKey: string;
    amountMinor: bigint;
    currency: string;
    createdAfter: Date;
    /**
     * The instrument charged, when known: a gateway may scope its charges by it (Cashfree), or
     * rebuild the create from it (Adyen sends the method type).
     */
    paymentMethod?: {
      providerPaymentMethodId: string;
      providerCustomerId?: string | null;
      type?: string | null;
    };
    /** The id the attempt already holds (a stranded handle), when it holds one. */
    providerChargeId?: string;
    /**
     * Set only when the engine checked that the money is still owed and holds the invoice's
     * collection claim: what `charge()` was given that the row does not keep. Absent = the
     * adapter must not create anything.
     */
    replay?: { initiator?: ChargeInitiator; email?: string };
  }): Promise<ChargeResult | null>;

  /**
   * Register a storefront domain so WALLET buttons may render on it, and report back what
   * the provider actually thinks of it.
   *
   * Optional because it is a Stripe-shaped requirement: Apple Pay will not paint its button
   * on an unregistered domain, and — this is the whole problem — it does so SILENTLY. No
   * error, no console warning, no failed request; the button is simply absent, which reads
   * as "we do not support Apple Pay" to everyone including us. Apple Pay otherwise needs no
   * code of ours: an Apple Pay token IS a card credential to Stripe, `PaymentElement`
   * surfaces the button on its own, and `describeStripePaymentMethod` already reads
   * `card.wallet.type` back so the saved instrument says "Apple Pay" and not a bare brand.
   *
   * The returned status is the PROVIDER's verdict, never ours: it is also the only honest
   * check that the domain-association file is actually being served, because the provider
   * fetches it as part of validating.
   */
  registerWalletDomain?(input: { domain: string }): Promise<WalletDomainStatus>;

  /**
   * Re-read a vaulted mandate's CURRENT state from the gateway.
   *
   * Exists because one gateway will not tell us when a mandate comes back. RazorPay
   * delivers `token.paused` — which marks the instrument dead — but answers 400 "Invalid
   * event name/names" for `token.resumed`, so the revival can never arrive as a webhook.
   * Nothing else polls a dead mandate, so the customer's mandate works again and our books
   * say it does not, permanently.
   *
   * The general form: a webhook is not a reliable carrier for time-critical state — poll
   * instead. A signal the gateway refuses to send cannot be waited for.
   *
   * Returns null when the gateway has no mandate for this token — which is NOT the same as
   * a dead one, and callers must not read it as a status change.
   */
  fetchMandate?(input: {
    providerCustomerId: string;
    token: string;
  }): Promise<ProviderMandate | null>;

  /**
   * Re-read a vaulted instrument's DISPLAY facts from the gateway.
   *
   * The same shape `vaultPaymentMethod` returns, for a card we already hold. It exists
   * because those facts arrive exactly once — at vault time — and the set we capture grew
   * (0250, 0251: issuer country, funding, issuing bank, fingerprint, 3DS support). Every
   * row vaulted before then has nulls that no ordinary path will ever fill, including the
   * migrated methods, and the gateway is the only place the answers exist.
   *
   * OPTIONAL: a gateway that cannot re-read an instrument simply omits it, and
   * `backfill-payment-method-card-details.ts` reports those rows as unfillable rather than
   * inventing values. Returns null when the gateway no longer knows this instrument —
   * detached, deleted, or belonging to another account — which is NOT an error and must
   * not be written as "no card details".
   */
  fetchPaymentMethodDisplay?(input: {
    providerPaymentMethodId: string;
    /**
     * Required by RazorPay, ignored by Stripe. Their token read is customer-scoped
     * (`GET /customers/:c/tokens/:t`) — which is also the ownership guard, so it is not
     * an inconvenience to route around. An adapter that needs it and does not get it
     * returns null rather than reading an unscoped object.
     */
    providerCustomerId?: string;
  }): Promise<ProviderPaymentMethodRef["display"] | null>;

  /**
   * Read an instrument ALREADY vaulted at this gateway, confirming it belongs to that
   * gateway customer — the check behind attaching a permanent token we did not vault.
   * Returns null when the gateway does not know it, or knows it under another customer.
   * Optional: a gateway without it cannot take a permanent token.
   *
   * `requiresPerDebitMandate` is true when this ACCOUNT's off-session debits need a
   * mandate reference the permanent token does not carry (Stripe India); the engine
   * refuses the attach then.
   */
  fetchVaultedPaymentMethod?(input: {
    providerCustomerId: string;
    providerPaymentMethodId: string;
  }): Promise<(ProviderPaymentMethodRef & { requiresPerDebitMandate?: boolean }) | null>;

  /**
   * Issue a refund. Three outcomes, and the engine treats each differently:
   *  - an answer (`succeeded` / `pending` / `failed`) is booked as such;
   *  - `ProviderRefusalError` when the gateway definitely created nothing (a validation 4xx,
   *    a refund limit, a state it refuses in): the reservation is released and the operator
   *    sees the reason;
   *  - `ProviderIndeterminateError` when it may have created one (timeout, 408/409/429/5xx):
   *    the reservation stays, and `locateRefund` finds it later.
   * A plain `Error` is neither, and keeps the reservation with nothing to resolve it.
   */
  refund(input: RefundInput): Promise<RefundResult>;

  /**
   * Ask the gateway what became of a refund it ACCEPTED but had not settled.
   *
   * The refund-side twin of {@link fetchChargeStatus}, and it exists for the same reason:
   * a refund is accepted `pending` and only the provider's settlement webhook ever
   * resolves it, so a webhook that never arrives strands the refund — the money is out on
   * the rail, the ledger has booked it, and nothing in the engine ever revisits the row.
   * On cards that window is 5–10 working days, which is long enough for a missed callback
   * to look exactly like a slow one.
   *
   * Returns the same `RefundResult` shape `refund()` does, so `sweepStalePendingRefunds`
   * can hand the verdict to the same `settleRefund` / `reverseRefund` path a webhook takes
   * and a swept outcome is byte-identical to a delivered one. A `pending` answer means the
   * gateway is still working and the sweep leaves it alone — however old the refund is, the
   * engine's opinion is worth less than the gateway's. Adapters without this are never
   * swept; the sweep counts them rather than inventing an outcome.
   */
  fetchRefundStatus?(input: {
    providerRefundId: string;
    /** The refunded charge, for a gateway that reads refunds under their payment. */
    providerChargeId?: string;
    /** When we asked for it: a gateway that lists refunds late answers `pending` until then. */
    requestedAt?: Date;
  }): Promise<RefundResult>;

  /**
   * What a registration payment (`setupAuthCharge`) holds at the gateway now: the amount it
   * captured, and whether any refund exists on it. Read before such a payment is booked as a
   * first invoice. Null when the gateway has no such payment.
   */
  setupChargeState?(providerChargeId: string): Promise<{
    capturedMinor: bigint;
    refunded: boolean;
  } | null>;

  /**
   * Find a refund whose create answer was lost, by the `ownershipRef` `refund()` stamped on
   * it. Returns the refund (with its gateway id) or null when the charge carries no refund
   * with that tag — a definite answer. Throws when the gateway could not be asked.
   *
   * Only for an adapter whose `refund()` throws `ProviderIndeterminateError`: the engine
   * books such a refund pending with no gateway id, and this is how it gets one.
   */
  locateRefund?(input: {
    providerChargeId: string;
    ownershipRef: string;
  }): Promise<RefundResult | null>;

  /**
   * Contract v2 (C7): begin an on-/off-session intent (3DS challenge).
   *
   * For `purpose: 'setup'` this is the same gateway call `initiateVaultSetup`
   * already makes (Stripe `setupIntents.create`, PayPal `/v3/vault/setup-tokens`,
   * RazorPay mandate order) — the difference is that the engine now RECORDS it as
   * an intent with attempts, instead of leaving it untracked.
   */
  createIntent?(input: CreateIntentInput): Promise<IntentRef>;
  /**
   * Contract v2 (C7): consume an authorized intent — capture the money for a
   * `payment` intent, or return the newly vaulted instrument for a `setup` one.
   */
  consumeIntent?(input: ConsumeIntentInput): Promise<ConsumeIntentResult>;
  /**
   * Contract v2 (C7): release an authorized intent that will not be consumed, so
   * the hold on the buyer's funds is dropped. Optional — a gateway without a true
   * void (RazorPay) must NOT implement this and must report
   * `capabilities.intentVoid: false` rather than substituting a refund, which
   * would post real money movement for a payment that never settled.
   */
  voidIntent?(input: VoidIntentInput): Promise<VoidIntentResult>;
  /**
   * Stop a debit that `charge()` left `pending` (a bank debit the gateway has not submitted
   * or collected yet), so no money moves. Declare `capabilities.pendingDebitCancel` with it.
   * Must be idempotent on `idempotencyKey`: a second call on a cancelled debit answers
   * `cancelled` again.
   */
  cancelPendingCharge?(input: CancelPendingChargeInput): Promise<CancelPendingChargeResult>;

  /**
   * Send a pre-debit notice through the gateway (`capabilities.preDebitNotice`). The engine
   * stores the answer and times the debit itself: `executableAfter` / `expiresAt` are
   * honoured only when the gateway states them, otherwise the capability's hours apply.
   * `pending` = the gateway answers later (`pre_debit_notice.updated`). Must be idempotent
   * on `idempotencyKey`.
   */
  notifyUpcomingDebit?(input: {
    customer: ProviderCustomerRef;
    paymentMethod: ProviderPaymentMethodRef;
    mandateReference?: string | null;
    amountMinor: bigint;
    currency: string;
    debitAt: Date;
    idempotencyKey: string;
    ownershipRef?: string;
    /** What the payer reads on the notice: an invoice number or "Wallet top-up". */
    description?: string;
    email?: string;
    phone?: string;
  }): Promise<{
    status: "sent" | "pending" | "failed";
    notificationRef: string;
    executableAfter?: Date;
    expiresAt?: Date;
    /**
     * `final`: the bank or the network refused it as dead. The gateway's own mandate status
     * may still read active, so the engine does not ask it again.
     */
    failure?: { code: string; message: string; retriable: boolean; final?: boolean };
  }>;

  /**
   * Withdraw a sent notice that will not be used (its amount changed, or its debit day
   * passed), on a `preDebitNotice.oneOpenPerMandate` rail, so the gateway takes the next
   * one. `not_needed` = this rail keeps no open notice; `failed` = the gateway refused or
   * could not be asked (logged; the next notice may then be refused as still open).
   */
  withdrawPreDebitNotice?(input: {
    paymentMethod: ProviderPaymentMethodRef;
    mandateReference?: string | null;
    notificationRef: string;
    /** The notice's own amount and debit time (PayU asks for both on a withdrawal). */
    amountMinor: bigint;
    debitAt: Date;
  }): Promise<"withdrawn" | "not_needed" | "failed">;

  /**
   * Re-read a sent notice at the gateway right before the debit it covers. The engine
   * asks before it counts the debit against the notice: `pending`, or `sent` with an
   * `executableAfter` later than `now`, defers the debit; `failed` retires the notice.
   * `now` is the business clock. A throw is not an answer: the debit goes ahead.
   */
  checkPreDebitNotice?(input: {
    paymentMethod: ProviderPaymentMethodRef;
    notificationRef: string;
    now: Date;
  }): Promise<{
    status: "sent" | "pending" | "failed";
    executableAfter?: Date;
    failureCode?: string;
    failureMessage?: string;
  }>;

  /**
   * Read the gateway's settlement report for `[since, until)` and translate it into
   * ordinary events (`charge.succeeded`, `charge.failed` for a late return,
   * `dispute.created` …), for gateways that never send those by webhook
   * (`capabilities.settlementReport`). Events go through the same dedupe and handlers as
   * webhooks, so ids must be stable across overlapping windows. Read-only at the gateway.
   */
  pollSettlements?(input: { since: Date; until: Date }): Promise<NormalizedProviderEvent[]>;

  /**
   * Hand the gateway what the buyer's browser SDK returned for a `mode: 'sdk'` challenge,
   * on gateways where that result IS the authorization (a payment-method nonce): nothing is
   * held until our server uses it. Answers the intent's new state, as `fetchIntent` does;
   * `authorized` then goes through the same writer as an `intent.authorized` webhook.
   *
   * `clientResult` is untrusted browser input. Must be idempotent on `idempotencyKey`.
   */
  submitClientResult?(input: {
    intentId: string;
    purpose: IntentPurpose;
    clientResult: Record<string, string>;
    idempotencyKey: string;
  }): Promise<FetchedIntent>;

  /**
   * Ask the gateway what became of an intent — the intent-side twin of
   * {@link fetchChargeStatus}, and it exists for the same reason as its two siblings:
   * a callback that never came, or came late.
   *
   * ⚠️ NOT part of the ordinary intent path. Authorization arrives by webhook
   * (`intent.authorized`) and polling for it would be slower and less reliable. This is
   * for the case the webhook cannot cover, and defect #15 is what it was built from:
   * measured 2026-09-03, RazorPay authorized ₹22,184.00 and delivered
   * `payment.authorized` **21 minutes late** — after the capture and after our own
   * refund. For those 21 minutes our row said `in_progress`, the invoice read unpaid,
   * the buyer was blocked from paying with their own money held, and every fallback
   * missed it: `releaseHoldBeforeExpiry` opened with `if (pi.status !== 'authorized')`
   * and so trusted the one field a late callback leaves stale, and the
   * `unapplied_gateway_money` alert counts transactions, which a late callback never
   * produces. Nothing anywhere reported it.
   *
   * Implement it ONLY where it earns its keep and declare
   * `capabilities.intentStatus` to match — see that flag for which adapters do and why
   * PayPal leaves this `undefined`.
   *
   * `intentId` is whatever the engine stored in `payment_intents.intent_at_gateway`,
   * which on RazorPay is an ORDER id; adapters resolve their own id shapes and answer
   * `unknown` for one they cannot query rather than throwing (a throw here would strand
   * every other tenant's row behind one gateway's bad day — see rule 2 on
   * `releaseHoldBeforeExpiry`).
   */
  fetchIntent?(input: {
    intentId: string;
    purpose?: IntentPurpose;
    /**
     * Also resolve who the object belongs to (#31). OFF by default and deliberately so:
     * on RazorPay it costs an extra `GET /orders/{id}`, and the paths that poll for a
     * HOLD do not need to know whose object it is. Only the unmatched-capture classifier
     * asks, and only when a local match has already failed.
     */
    resolveOwnership?: boolean;
  }): Promise<FetchedIntent>;

  /**
   * Optional (CUST-7 GDPR clear): delete a vaulted instrument at the gateway so
   * no card reference survives after `clear_personal_data`. Best-effort — adapters
   * without a delete API simply don't implement it (the engine still detaches the
   * local row). Must be idempotent (already-gone → resolve).
   */
  deletePaymentMethod?(input: {
    customer: ProviderCustomerRef;
    paymentMethod: ProviderPaymentMethodRef;
  }): Promise<void>;

  /**
   * Optional: register OUR notification URL with the provider so inbound webhooks
   * start flowing without the operator copying secrets by hand — nobody should be asked
   * for a signing secret we can own or derive ourselves.
   *
   * Return whichever verification material the provider mints:
   *   - `webhookSecret` — a signing secret the provider generates (Stripe `whsec_…`),
   *     or the `secret` we supplied echoed back once the provider accepted it.
   *   - `webhookId`     — an endpoint id used with a verify API (PayPal).
   *
   * `secret` is a signing key WE generated, for gateways that let the caller choose
   * one instead of minting their own (RazorPay). Adapters whose provider mints the
   * secret itself (Stripe) ignore it. Adapters whose provider has no endpoint API at
   * all simply don't implement this; the caller then falls back to displaying a
   * locally-generated secret for the operator to paste.
   * Must be idempotent-ish: re-provisioning the same URL should not error.
   */
  provisionWebhookEndpoint?(input: { url: string; secret?: string }): Promise<ProvisionedWebhook>;

  /**
   * Optional: remove the registration whose URL is exactly `url` (the deleted account's
   * notification URL). Never touch any other endpoint: one gateway account may serve other
   * systems. Resolves `{ removed: false }` when no registration has that URL.
   */
  removeWebhookEndpoint?(input: { url: string }): Promise<WebhookRemoval>;

  /**
   * Verify signature + translate to our event vocabulary. May fan out to many. Each event
   * carries `webhookEventId(input)` as its `providerEventId`, or its own event id on a
   * batching gateway (see `NormalizedProviderEvent.providerEventId`).
   */
  normalizeWebhook(input: NormalizeWebhookInput): Promise<NormalizedProviderEvent[]>;

  /**
   * The id this delivery is deduped by: the gateway's own event id, the same on every
   * retry and different for every event. Build it with `webhookEventId()` from
   * `./webhook-event-id`. Pure — no signature check, no I/O. `pnpm verify:webhook-dedup`
   * holds every adapter to it.
   */
  webhookEventId(input: NormalizeWebhookInput): string;

  /**
   * Contract v2 (C1/C3): a cheap, read-only probe confirming the stored
   * credentials are usable. Optional — adapters without a probe are treated as
   * healthy. Return may carry extra provider-specific fields.
   */
  healthCheck?(input?: HealthCheckInput): Promise<HealthCheckResult>;

  /**
   * The merchant's balance held AT the gateway — the money a refund is paid from on a
   * gateway that refunds out of balance (PayPal). Read-only and optional: adapters
   * without it have no balance to show. `currency` narrows the answer to one currency.
   */
  fetchBalance?(input?: { currency?: string }): Promise<GatewayBalanceResult>;
}

/** What the engine knows that a health probe may check against. */
export interface HealthCheckInput {
  /** Origins buyers pay from (`https://portal.example.com`), from `PORTAL_BASE_URL`. */
  storefrontOrigins?: string[];
  /**
   * This account's latest webhook deliveries, newest first (redacted headers, raw payload).
   * Empty = none arrived; absent = not read. For checks on what the gateway sends.
   */
  recentWebhooks?: { headers: Record<string, string>; payload: unknown }[];
}

/** One named check inside a health probe, for the dashboard to list. */
export interface HealthCheckItem {
  /** Stable id, e.g. `allowed_origins`. */
  key: string;
  /** `unchecked`: we could not run the check; it does not fail the account. */
  status: "ok" | "failed" | "unchecked";
  message: string;
  /** What the operator does to correct it, in order. */
  steps?: string[];
}

/** One currency's balance at the gateway, in minor units. */
export interface GatewayBalance {
  currency: string;
  /** Money the merchant can use now — what a refund draws from. */
  availableMinor: bigint;
  /** Money the gateway holds back (reserves, disputes). */
  withheldMinor: bigint;
  totalMinor: bigint;
}

export type GatewayBalanceResult =
  | {
      ok: true;
      balances: GatewayBalance[];
      /** When the gateway last refreshed the figures; null when it does not say. */
      asOf: Date | null;
    }
  | {
      ok: false;
      /** `not_permitted`: the credentials lack the permission to read the balance. */
      reason: "not_permitted" | "unavailable";
      /** Operator-facing: what went wrong and how to correct it. */
      message: string;
    };

export interface HealthCheckResult {
  ok: boolean;
  detail?: string;
  checks?: HealthCheckItem[];
}

/** Plan-fidelity alias — the contract-v2 name for `PaymentProvider`. */
export type GatewayAdapter = PaymentProvider;
