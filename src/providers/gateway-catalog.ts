/**
 * One definition per payment gateway — the only place that knows which gateways exist.
 *
 * Everything that used to branch on a gateway's name (the supported-key lists, the
 * webhook-secret ownership sets, the operator's credential and method lists, the
 * dashboard's setup copy, the API enums) reads it from here. Adding a gateway is an
 * adapter, a `ProviderKey` member, an entry below and a factory in `./gateways.ts`; the
 * `Record<ProviderKey, …>` types make a missing one a compile error.
 *
 * No runtime imports: the API reference loads this with an empty environment (the SDK
 * generator does), so adapters — which read config — are built in `./gateways.ts`.
 * Decline tables are registered in `decline-codes.ts` (`DECLINE_SETS`).
 */
import { allowsIntentPurpose, type IntentPurpose } from "./types";
import type { ProviderCapabilities, ProviderKey } from "./types";

export type MethodType = ProviderCapabilities["methods"][number];

/** An operator-entered credential (write-only; never echoed back). */
export interface CredentialField {
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
  /** The account can be created without it. */
  optional?: boolean;
}

/** A method the operator may enable on an account, as the setup screen shows it. */
export interface MethodOption {
  value: MethodType;
  label: string;
  hint?: string;
}

/**
 * What the operator has to do for an account's inbound webhooks.
 *  - `self_provisioned`: nothing; we registered the endpoint.
 *  - `paste_required`: paste OUR generated secret into the gateway.
 *  - `secret_in`: paste the GATEWAY's secret into us (`operator_pasted`).
 *  - `url_only`: register the URL at the gateway; signatures use the API credentials (`credential`).
 *  - `not_applicable`: no external webhooks.
 */
export type WebhookEndpointMode =
  | "self_provisioned"
  | "paste_required"
  | "secret_in"
  | "url_only"
  | "not_applicable";

export interface GatewayDefinition {
  key: ProviderKey;
  displayName: string;
  /** Extra line for the dashboard's gateway directory. */
  note?: string;
  /** Moves no real money; refused on a live business. */
  simulated?: boolean;
  credentialFields: CredentialField[];
  /** What the gateway can be routed for (`effectiveMethodTypes` intersects the account's list with this). */
  advertisedMethods: readonly string[];
  /** What the setup screen offers. A subset of `advertisedMethods`: only rails worth enabling. */
  methodOptions: MethodOption[];
  /** Methods that settle in exactly one currency on this gateway. */
  currencyBoundMethods?: Readonly<Record<string, string>>;
  /**
   * The currencies the gateway takes for each intent purpose, where it limits them. The router
   * and the storefront offers skip the gateway for any other currency. Absent = no limit.
   */
  intentCurrencies?: Partial<Record<IntentPurpose, readonly string[]>>;
  /**
   * The currencies we offer on this gateway: its documented list, less withdrawn ISO codes,
   * sanctioned markets and codes the adapter cannot convert exactly. An account may route only
   * these (it keeps codes it already held). Absent = no list: any currency.
   */
  currencies?: readonly string[];
  /** What the gateway account needs for those currencies. The setup guide shows it. */
  currencyConditions?: string;
  /**
   * The gateway takes other currencies only after it enables international payments on the
   * merchant's account. Each account then has an "International payments" switch: off, it
   * routes only `domesticCurrency`, to save a method or to pay now.
   */
  internationalSwitch?: { domesticCurrency: string };
  /**
   * The adapter's `capabilities.intentPurposes`, readable without building it (the router
   * filters on it). Absent = both. Pinned to the adapters by `test/unit/dispute-feed.test.ts`.
   */
  intentPurposes?: readonly IntentPurpose[];
  /** Advertised methods that pay now but cannot be saved: left out of a `setup` offer. */
  payNowOnlyMethods?: readonly MethodType[];
  /**
   * The adapter's `capabilities.mandateCeilingCapMinor` (INR minor units per debit), readable
   * without building it. Pinned to the adapters by `test/unit/dispute-feed.test.ts`.
   */
  mandateCeilingCapMinor?: Readonly<Partial<Record<MethodType, number>>>;
  /**
   * The adapter's `capabilities.mandateCurrencyAuthoritative`, readable without building it
   * (candidate selection filters on it). Pinned to the adapters by `test/unit/dispute-feed.test.ts`.
   */
  mandateCurrencyAuthoritative?: readonly MethodType[];
  /** Advertised methods that can only be saved, then charged: left out of a `payment` offer. */
  setupOnlyMethods?: readonly MethodType[];
  /**
   * Who captures the payer's ACH debit authorization (`us_bank_account`).
   *  - `gateway`: the gateway's own form shows and records it. We add no text.
   *  - `ours`: the gateway leaves it to the merchant. The storefront shows our text
   *    (`ACH_AUTHORIZATION_TEXT`) and the evidence goes to `payment_method_authorizations`.
   * Absent: the gateway offers no ACH debit.
   */
  achAuthorization?: "gateway" | "ours";
  webhook: {
    /**
     * Who owns the signing material.
     *  - `provider_minted`: we register the endpoint and store what the gateway returns.
     *  - `shared`: we generate the secret at account creation and try to register it;
     *    without a registered endpoint the operator pastes it by hand.
     *  - `credential`: signed with an API credential the operator already entered, so
     *    there is no webhook secret. The operator registers the URL unless the adapter can.
     *  - `operator_pasted`: the gateway mints the secret in its own dashboard and offers no
     *    API to read it; the operator pastes it into us as `webhook_secret`.
     *  - `none`: no external webhooks.
     */
    secret: "provider_minted" | "shared" | "credential" | "operator_pasted" | "none";
    /** Operator-facing steps for the account's webhook card. */
    instructions(url: string, mode: WebhookEndpointMode): string[];
    /** Steps the dashboard shows when the webhook-endpoint route is unavailable. */
    fallbackInstructions: string[];
    /**
     * The gateway refuses a webhook URL with a query string, so the account id rides in the
     * path: `/v1/gateway_webhooks/<gateway>/<account>` instead of `?id=<account>`.
     */
    accountIdInPath?: boolean;
    /**
     * Steps to delete the registration by hand, for a gateway the operator registered in its
     * own dashboard, or one whose API cannot delete it. Shown when the account is deleted.
     */
    removalInstructions?(url: string): string[];
    /** The status that tells this gateway "bad signature, do not retry". Default 400. */
    rejectedSignatureStatus?: number;
    /**
     * Answer a verified delivery once it is stored, then process it from the stored rows on
     * the job queue (`process_gateway_webhook`). For a gateway that times a delivery out
     * quickly. `body` is the answer it expects.
     */
    processAfterAnswer?: { body: string };
  };
  settlement: {
    /** Recurring debits settle by webhook on every rail (the charge returns pending). */
    alwaysAsync?: boolean;
    /** Rails that settle by webhook on a gateway whose card rail does not. */
    asyncMethods?: readonly string[];
    /**
     * A capture can follow a failure the gateway already reported for the same charge. The
     * engine then books a matching capture on the failed attempt instead of ignoring it.
     */
    lateCaptureAfterFailure?: boolean;
  };
  /** Never mints a customer: `provider_customer_id` holds OUR id, so it is not a gateway reference. */
  noCustomerIds?: boolean;
  /** The adapter registers storefront domains for wallet buttons (`registerWalletDomain`). */
  walletDomains?: boolean;
  /**
   * Pay now offers Apple Pay on the gateway's own hosted page (`CreateIntentInput.hostedWallet`).
   * `only`: the page shows Apple Pay alone, so the payment is recorded as Apple Pay.
   * `with_cards`: the page also shows cards, and the gateway does not say which one paid.
   */
  applePayHosted?: "only" | "with_cards";
  /** Recurring setup fails at the gateway without the payer's phone. */
  recurringNeedsPhone?: boolean;
  /** Recurring setup fails at the gateway without a person's name (an email is refused). */
  recurringNeedsName?: boolean;
  /** What an operator must do about an instrument still chargeable at the gateway. */
  orphanedInstrumentRemedy?: string;
  /** `false`: the adapter's `capabilities.disputeFeed`, readable without building it. */
  disputeFeed?: false;
  /**
   * `false`: the gateway reports a dispute opening but never its outcome (a chargeback it
   * does not let the merchant contest). A person then records the outcome by hand.
   */
  disputeFinalState?: false;
  /**
   * Days the gateway keeps retrying a webhook, signed with the key it was first sent with. A
   * replaced webhook secret stays valid that long (default 24 h).
   */
  webhookRetryDays?: number;
}

/**
 * The Razorpay events a webhook endpoint subscribes to. One list for both paths: the
 * adapter registers exactly these, and the manual setup steps name exactly these.
 * RazorPay has no "all events" wildcard and validates every name, so we subscribe to
 * what we consume (`normalizeWebhook` still filters server-side).
 */
export const RAZORPAY_WEBHOOK_EVENTS = [
  "payment.captured",
  "payment.authorized",
  "order.paid",
  "payment.failed",
  // ⚠️ `subscription.charged` / `subscription.authenticated` are NOT subscribed, and
  // removing them was a correctness fix rather than tidying.
  //
  // They belong to RazorPay's Subscriptions API, which this engine never calls (see
  // RAZORPAY REPORT.md §1 — those objects cannot model mid-cycle add-on quantity
  // changes without cancel-and-recreate, which destroys the mandate). So they can
  // never describe one of OUR subscriptions.
  //
  // What they CAN describe is someone else's. A RazorPay webhook is account-wide, and
  // this account can carry two endpoints — ours and another product's — with every
  // subscribed event delivered to BOTH. That other product does drive Subscriptions
  // objects, so these events arrive here describing its charges.
  //
  // `subscription.authenticated` was mapped to `charge.succeeded`, which is also just
  // wrong: authentication is the ₹0/₹1 mandate-registration transaction, not revenue.
  // Only correlation saved it — `reconcileChargeSucceeded` finds no local transaction
  // for a foreign payment id and returns `ignored`. That is a safety net, not a
  // design.
  "refund.processed",
  "refund.failed",
  // A refund's BIRTH (#35). Without it, a refund a human raises in RazorPay's own
  // dashboard is invisible to us until `refund.processed` — days, on a slow rail —
  // while the customer has already been told they are being repaid.
  //
  // ⚠️ ADDED ON MEASURED EVIDENCE, not on the catalogue. The list is validated as a
  // whole and one bad name loses all of them (see the `token.resumed` note below),
  // so this name was cleared INDIVIDUALLY on its own throwaway endpoint by
  // `scripts/probe-razorpay-event-names.ts` before it was written here:
  //   2026-09-04, a test-mode key → POST /v1/webhooks {events:{refund.created:1}}
  //   → 200, endpoint created (and deleted again). Controls held in the same run:
  //   `payment.captured` accepted, `tmbilling.not.a.real.event` refused with
  //   "Invalid event name/names", so the probe demonstrably tells the two apart.
  //
  // ⚠️ That evidence is from TEST mode, by decision — a 400 against live regresses a
  // real business's endpoint to manual, and that risk is not worth re-taking to
  // confirm what the same validator already answered. Re-run the probe against live
  // before trusting this if a future name is gated on a merchant feature.
  "refund.created",
  "payment.dispute.created",
  "payment.dispute.won",
  "payment.dispute.lost",
  "payment.dispute.closed",
  // `payment.dispute.action_required` — the one that carries a DEADLINE. Without it
  // we learn of a dispute at `created` and then hear nothing until won/lost/closed, so
  // a re-issued evidence deadline is missed entirely and the dispute is lost by
  // default. It maps to `dispute.created`, whose upsert refreshes `reason` +
  // `evidenceDueBy` WITHOUT touching status — so a later deadline lands on the
  // existing row rather than resetting a dispute already under review.
  "payment.dispute.action_required",
  // The sixth documented dispute state (razorpay.com/docs/webhooks/payloads/disputes).
  // We already take the other five; without this one a dispute moving INTO review is the
  // one transition an operator does not see.
  "payment.dispute.under_review",
  "token.confirmed",
  "token.rejected",
  "token.cancelled",
  "token.paused",
  // ⚠️ `token.resumed` and `token.updated` are NOT subscribable — MEASURED, not
  // assumed. Adding them made RazorPay reject the whole registration:
  //   PUT /v1/webhooks → 400 "Invalid event name/names: token.resumed, token.updated"
  // and because a failed registration falls back to `paste_required`, that one 400
  // silently turned an auto-provisioned endpoint into a manual one. RAZORPAY REPORT.md
  // §8 hedges `token.paused` / `token.resumed` with "(where applicable)" — on this
  // account it is not. The event list is validated whole, so ONE bad name loses all
  // of them.
  //
  // The pause problem is real regardless, and is handled without a resume event:
  // `applyMandateUpdate` restores an instrument whose STORED mandate status is
  // `paused` when any live status arrives (`token.confirmed` does), so the mandate
  // reviving is still observed — just through a different event.
  // `settlement.processed` — the payout that makes the books tie out. Domestic
  // settlement is T+2, netted and batched: one bank credit covers many payments minus
  // MDR, GST on MDR, refunds and adjustments, so collections never equal the bank
  // balance and the difference is unexplainable without this. Recorded in
  // `provider_events` (raw payload + normalized numbers); per-payment attribution
  // needs the recon report, which is a separate job. RAZORPAY REPORT.md §11.5.
  "settlement.processed",
] as const;

const RAZORPAY_WEBHOOKS_MENU = "Account & Settings → Website and app settings → Webhooks";

/** The manual Razorpay setup, shared by the paste flow and the fallback card. */
const RAZORPAY_MANUAL_STEPS = [
  `In Razorpay, go to ${RAZORPAY_WEBHOOKS_MENU}. Click Add New Webhook.`,
  "Paste the notification URL and the secret on this page into the URL and Secret fields.",
  `In Active Events, select these events: ${RAZORPAY_WEBHOOK_EVENTS.join(", ")}. Other events are not necessary.`,
  "Click Create Webhook.",
];

/** The Braintree webhook events to select, in both the in-app steps and the fallback. */
const BRAINTREE_WEBHOOK_EVENTS = [
  "Select all Disputes events, the Payment Method Revoked By Customer event and the Account Updater Daily Report event.",
  "If the list shows Refund Failed, select it.",
  "If the list shows Transaction Settled and Transaction Settlement Declined, select them. The list shows them only when ACH or SEPA Direct Debit is enabled on your merchant account.",
];

/** A currency list written as space-separated codes. */
const codes = (list: string): readonly string[] => list.trim().split(/\s+/);

export const GATEWAYS: Record<ProviderKey, GatewayDefinition> = {
  tmtest: {
    key: "tmtest",
    displayName: "TM Test Gateway",
    note: "A simulated gateway for testing. No money moves.",
    simulated: true,
    credentialFields: [],
    advertisedMethods: ["card", "upi"],
    mandateCurrencyAuthoritative: ["card", "upi"],
    methodOptions: [
      { value: "card", label: "Cards" },
      { value: "upi", label: "UPI" },
    ],
    webhook: {
      secret: "none",
      instructions: () => ["This gateway does not use external webhooks."],
      fallbackInstructions: [
        "The TM Test Gateway is simulated. It does not need an external webhook.",
      ],
    },
    settlement: {},
    disputeFeed: false,
  },

  stripe: {
    key: "stripe",
    // The Payment Element shows its own ACH mandate text.
    achAuthorization: "gateway",
    displayName: "Stripe",
    credentialFields: [
      {
        key: "secret_key",
        label: "Secret Key",
        placeholder: "sk_live_…",
        hint: "Stripe Dashboard → Developers → API keys.",
      },
      {
        key: "publishable_key",
        label: "Publishable Key",
        placeholder: "pk_live_…",
        hint: "On the same page.",
      },
      // No webhook_secret: we register the endpoint and store the whsec_ Stripe mints.
    ],
    advertisedMethods: ["card", "us_bank_account", "sepa_debit", "bank_transfer"],
    methodOptions: [
      { value: "card", label: "Cards" },
      {
        value: "us_bank_account",
        label: "Direct Debit (ACH)",
        hint: "US only. The debit settles asynchronously.",
      },
      {
        value: "sepa_debit",
        label: "Direct Debit (SEPA)",
        hint: "EU only. The debit settles asynchronously.",
      },
      // Not `bank_transfer`: the outbound map folds it onto ACH (`METHOD_TYPE_MAP`), so a
      // "Bacs / BECS / PAD" row would configure ACH. Wallet presentations are cards.
    ],
    // `METHOD_TYPE_MAP` folds `bank_transfer` onto `us_bank_account` here.
    currencyBoundMethods: { bank_transfer: "USD" },
    currencies: codes(`
      AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BIF BMD BND BOB BRL BSD BWP BYN
      BZD CAD CDF CHF CLP CNY COP CRC CVE CZK DJF DKK DOP DZD EGP ETB EUR FJD FKP GBP
      GEL GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR ISK JMD JPY KES KGS KHR KMF
      KRW KYD KZT LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MUR MVR MWK MXN MYR
      MZN NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR
      SBD SCR SEK SGD SHP SLE SOS SRD SZL THB TJS TOP TRY TTD TWD TZS UAH UGX USD UYU
      UZS VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW
    `),
    currencyConditions:
      "Your Stripe account's country can limit these. For example, an account in India charges cards issued in India in INR only. Stripe converts a currency that you do not settle in.",
    webhook: {
      secret: "provider_minted",
      instructions: (url) => [
        "No action is necessary. tmbilling registered this endpoint with Stripe for you.",
        `Verify it under Developers → Webhooks in Stripe: ${url}`,
      ],
      fallbackInstructions: [
        "Click “Register with Stripe” on this page. We create the endpoint and keep the signing secret.",
        "Optional: confirm it appears under Developers → Webhooks in Stripe.",
      ],
    },
    // A card renewal settles in the charge call; bank debits arrive only by webhook.
    // Both vocabularies: canonical method types and the request word `ach_debit`.
    settlement: { asyncMethods: ["us_bank_account", "sepa_debit", "bank_transfer", "ach_debit"] },
    walletDomains: true,
  },

  paypal: {
    key: "paypal",
    displayName: "PayPal",
    credentialFields: [
      {
        key: "client_id",
        label: "Client ID",
        placeholder: "AYS…",
        hint: "The Client ID of your PayPal REST API app.",
      },
      {
        key: "client_secret",
        label: "Client Secret",
        hint: "On the same app page, under the Client ID.",
      },
    ],
    // No card rail: see `capabilities.methods` in providers/paypal.ts for what is missing.
    advertisedMethods: ["paypal"],
    methodOptions: [
      {
        value: "paypal",
        label: "PayPal wallet",
        hint: "A billing agreement that the buyer approves.",
      },
    ],
    currencies: codes(`
      AUD BRL CAD CHF CNY CZK DKK EUR GBP HKD HUF ILS JPY MXN MYR NOK NZD PHP PLN RUB
      SEK SGD THB TWD USD
    `),
    currencyConditions:
      "BRL, CNY and MYR need a PayPal account in that country. If your PayPal account does not hold the currency, set your payment receiving preferences in PayPal. If you do not, the payment stays pending.",
    webhook: {
      secret: "provider_minted",
      instructions: (url) => [
        "No action is necessary. tmbilling registered this endpoint with PayPal for you.",
        `Verify it under Developer Dashboard → Webhooks: ${url}`,
      ],
      fallbackInstructions: [
        "Click “Register with PayPal” on this page. We create the webhook and store its ID.",
        "Optional: confirm it under your app's settings → Webhooks.",
      ],
    },
    settlement: {},
    // PayPal charges a vaulted token directly; its adapter stores our customer id.
    noCustomerIds: true,
  },

  razorpay: {
    key: "razorpay",
    displayName: "Razorpay",
    credentialFields: [
      {
        key: "key_id",
        label: "Key ID",
        placeholder: "rzp_live_…",
        hint: "Razorpay Dashboard → Account & Settings → Websites & API keys.",
      },
      {
        key: "key_secret",
        label: "Key Secret",
        hint: "Razorpay shows it once, when you generate the key.",
      },
    ],
    advertisedMethods: ["card", "upi", "wallet", "bank_transfer"],
    // UPI and netbanking mandates are INR only. A card mandate registers in the order's
    // currency, and the token does not say which, so its stored currency is not trusted.
    mandateCurrencyAuthoritative: ["upi", "bank_transfer"],
    methodOptions: [
      { value: "card", label: "Cards" },
      { value: "upi", label: "UPI Autopay", hint: "INR only. The debit settles asynchronously." },
      { value: "bank_transfer", label: "Netbanking (eMandate)", hint: "INR only." },
      // Not `wallet`: no recurring rail, and the adapter refuses it.
    ],
    // Recurring takes cards, UPI Autopay and eMandate only; `selectRail` refuses a wallet mandate.
    payNowOnlyMethods: ["wallet"],
    currencies: codes(`
      AED ALL AMD AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BRL BSD BTN BWP BZD CAD
      CHF CLP CNY COP CRC CVE CZK DJF DKK DOP DZD EGP ETB EUR FJD GBP GHS GIP GMD GNF
      GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD ISK JMD JOD JPY KES KGS KHR KMF KRW KWD
      KYD KZT LAK LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MUR MVR MWK MXN MYR MZN NAD
      NGN NIO NOK NPR NZD OMR PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SCR SEK
      SGD SOS SVC SZL THB TND TRY TTD TWD TZS UAH UGX USD UYU UZS VND VUV XAF XCD XOF
      XPF YER ZAR ZMW
    `),
    currencyConditions:
      "INR is on by default. The other currencies need Razorpay to enable international payments on your account. UPI Autopay and eMandate are INR only. Razorpay settles in INR.",
    internationalSwitch: { domesticCurrency: "INR" },
    webhook: {
      secret: "shared",
      instructions: (url, mode) =>
        mode === "self_provisioned"
          ? [
              "No action is necessary. We registered this endpoint with Razorpay for you.",
              `To check it, find this URL in Razorpay under ${RAZORPAY_WEBHOOKS_MENU}: ${url}`,
            ]
          : [
              "We could not register this endpoint with Razorpay automatically. Add it manually.",
              ...RAZORPAY_MANUAL_STEPS,
            ],
      fallbackInstructions: RAZORPAY_MANUAL_STEPS,
      removalInstructions: (url) => [
        `Razorpay cannot delete a webhook through its API. To delete it, go to ${RAZORPAY_WEBHOOKS_MENU} in Razorpay and delete the webhook with this URL: ${url}`,
      ],
    },
    // UPI Autopay settles in minutes to hours, eMandate over working days, and even a
    // card mandate debit returns `pending` first.
    // `payment.failed` can be followed by `payment.captured` for the same payment (late
    // authorisation; a payer retry on UPI) — Razorpay documents it on its payments webhook page.
    settlement: { alwaysAsync: true, lateCaptureAfterFailure: true },
    // The auth order 500s without a contact ("The contact field is required for recurring links").
    recurringNeedsPhone: true,
    orphanedInstrumentRemedy:
      "We do not cancel Razorpay recurring tokens. Cancel the mandate in the Razorpay dashboard. Or ask the payer to revoke it in their UPI app or bank portal.",
  },

  gocardless: {
    key: "gocardless",
    // GoCardless's hosted page shows and records the mandate.
    achAuthorization: "gateway",
    displayName: "GoCardless",
    note: "Bank Direct Debit in the UK, the euro area, the US, Australia, New Zealand, Canada, Sweden and Denmark. PayTo in Australia.",
    credentialFields: [
      {
        key: "access_token",
        label: "Access Token",
        placeholder: "live_…",
        hint: "GoCardless Dashboard → Developers → Create → Access token. Select read-write access.",
      },
      {
        key: "payto_purpose_code",
        label: "PayTo purpose code",
        placeholder: "retail",
        hint: "Optional. Only for PayTo. The payer's bank shows this category on the agreement. Type one of: mortgage, utility, loan, dependant_support, gambling, retail, salary, personal, government, pension, tax, other. If you leave this field empty, we use retail.",
        optional: true,
      },
      // No webhook_secret here: it is pasted on the webhook card (`operator_pasted`).
    ],
    advertisedMethods: [
      "bacs_debit",
      "sepa_debit",
      "us_bank_account",
      "au_becs_debit",
      "nz_becs_debit",
      "acss_debit",
      "autogiro",
      "betalingsservice",
      "payto",
    ],
    // Each scheme debits in its own currency only (`GOCARDLESS_METHOD_SCHEMES`).
    mandateCurrencyAuthoritative: [
      "bacs_debit",
      "sepa_debit",
      "us_bank_account",
      "au_becs_debit",
      "nz_becs_debit",
      "acss_debit",
      "autogiro",
      "betalingsservice",
      "payto",
    ],
    // A Billing Request authorises a mandate; it never takes a one-off payment.
    intentPurposes: ["setup"],
    methodOptions: [
      {
        value: "bacs_debit",
        label: "Direct Debit (Bacs)",
        hint: "UK only, GBP. The debit settles asynchronously.",
      },
      {
        value: "sepa_debit",
        label: "Direct Debit (SEPA)",
        hint: "EUR only. The debit settles asynchronously.",
      },
      {
        value: "us_bank_account",
        label: "Direct Debit (ACH)",
        hint: "US only, USD. The debit settles asynchronously.",
      },
      {
        value: "au_becs_debit",
        label: "Direct Debit (BECS)",
        hint: "Australia only, AUD. The debit settles asynchronously.",
      },
      {
        value: "nz_becs_debit",
        label: "Direct Debit (BECS NZ)",
        hint: "New Zealand only, NZD. The debit settles asynchronously.",
      },
      {
        value: "acss_debit",
        label: "Pre-authorized debit (PAD)",
        hint: "Canada only, CAD. If the customer has a company name, the mandate is a Business PAD. The debit settles asynchronously.",
      },
      {
        value: "autogiro",
        label: "Direct Debit (Autogiro)",
        hint: "Sweden only, SEK. The payer signs the mandate with BankID. The debit settles asynchronously.",
      },
      {
        value: "betalingsservice",
        label: "Direct Debit (Betalingsservice)",
        hint: "Denmark only, DKK. Betalingsservice collects once each month on a fixed cycle, so a payment can arrive some weeks after the invoice date. The payer gives their CPR or CVR number on the GoCardless page.",
      },
      {
        value: "payto",
        label: "PayTo",
        hint: "Australia only, AUD. The payer approves the agreement in their banking app. The agreement has a maximum amount for each payment. We do not collect an invoice above that amount.",
      },
    ],
    currencies: codes(`
      AUD CAD DKK EUR GBP NZD SEK USD
    `),
    currencyConditions:
      "Each Direct Debit scheme takes the currency of its country. To collect in a currency that is not your own, enable FX in GoCardless or add a payout bank account in that currency.",
    webhook: {
      secret: "operator_pasted",
      instructions: (url) => [
        "In GoCardless: go to Developers → Webhook endpoints → Create.",
        `Enter this URL in the URL field: ${url}`,
        "Click Create. Then copy the secret that GoCardless shows for the endpoint.",
        "Paste the secret on this page and click Save.",
      ],
      fallbackInstructions: [
        "In GoCardless: go to Developers → Webhook endpoints → Create.",
        "Enter the notification URL shown on this page. Then copy the secret that GoCardless shows.",
        "Paste the secret on this page and click Save.",
      ],
      removalInstructions: (url) => [
        `In GoCardless, go to Developers → Webhook endpoints and delete the endpoint with this URL: ${url}`,
      ],
      // GoCardless retries a 400; 498 is its documented "invalid signature" answer.
      rejectedSignatureStatus: 498,
    },
    // Every Direct Debit settles days later, and only by webhook (or the events backstop).
    // A failed payment retried from the GoCardless dashboard is confirmed after our failure.
    settlement: { alwaysAsync: true, lateCaptureAfterFailure: true },
    orphanedInstrumentRemedy:
      "Cancel the mandate in the GoCardless dashboard (Customers → Mandates → Cancel mandate).",
  },
  braintree: {
    key: "braintree",
    displayName: "Braintree",
    // No Apple Pay: Braintree has no hosted payment page, and its Apple Pay on the web needs
    // its own association file at a path our storefront domain serves for another gateway.
    note: "Cards. Braintree has no hosted payment page, so pay now does not offer Apple Pay.",
    credentialFields: [
      {
        key: "merchant_id",
        label: "Merchant ID",
        hint: "Braintree Control Panel → Settings → API.",
      },
      { key: "public_key", label: "Public Key", hint: "On the same page, under API Keys." },
      {
        key: "private_key",
        label: "Private Key",
        hint: "On the same page. Click View in the Private Key column.",
      },
      {
        key: "merchant_accounts",
        label: "Currencies and merchant accounts",
        placeholder: "USD=fernhill_usd, EUR=fernhill_eur",
        hint: "Optional. Each Braintree merchant account settles in one currency. Type the currency of your default merchant account, for example EUR. To charge in more currencies, add CURRENCY=merchant account ID for each one, separated by commas. If you leave this field empty, we charge in USD on your default merchant account.",
        optional: true,
      },
    ],
    advertisedMethods: ["card", "paypal", "venmo"],
    methodOptions: [
      {
        value: "card",
        label: "Cards",
        hint: "If 3D Secure is on in your Braintree account, the buyer confirms the card with the bank.",
      },
      {
        value: "paypal",
        label: "PayPal",
        hint: "Link your PayPal business account in the Braintree Control Panel first.",
      },
      {
        value: "venmo",
        label: "Venmo",
        hint: "US businesses only, USD only. Ask Braintree to turn on Venmo for your merchant account first.",
      },
    ],
    // "You can use Venmo for payments only with United States-based business entities"
    // (Venmo overview, read 2026-10-28).
    currencyBoundMethods: { venmo: "USD" },
    // Transaction webhooks "are available for ACH and SEPA Direct Debit" sales and refunds
    // (https://developer.paypal.com/braintree/docs/reference/general/webhooks/transaction,
    // read 2026-10-28): a card-only merchant's list does not show them (measured in the sandbox).
    // Not LAK: Braintree takes it in whole units, and the adapter sends 2 decimals.
    currencies: codes(`
      AED AMD AOA ARS AUD AWG AZN BAM BBD BDT BIF BMD BND BOB BRL BSD BWP BYN BZD CAD
      CHF CLP CNY COP CRC CVE CZK DJF DKK DOP DZD EGP ETB EUR FJD FKP GBP GEL GHS GIP
      GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR ISK JMD JPY KES KGS KHR KMF KRW KYD
      KZT LBP LKR LRD LSL MAD MDL MKD MNT MOP MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK
      NPR NZD PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SEK SGD SHP
      SOS SRD SVC SZL THB TJS TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST
      XAF XCD XOF XPF YER ZAR
    `),
    currencyConditions:
      "Each merchant account takes one currency. For each other currency, you need a different merchant account.",
    webhook: {
      secret: "credential",
      instructions: (url) => [
        "In the Braintree Control Panel, go to Settings → Webhooks → Create New Webhook.",
        `Paste this notification URL: ${url}`,
        ...BRAINTREE_WEBHOOK_EVENTS,
        "Do not select subscription events. Then click Create Webhook.",
        "Your API keys sign the events. You do not need a webhook secret.",
      ],
      fallbackInstructions: [
        "In the Braintree Control Panel, go to Settings → Webhooks → Create New Webhook.",
        "Paste the notification URL shown on this page.",
        ...BRAINTREE_WEBHOOK_EVENTS,
        "Do not select subscription events. Then click Create Webhook.",
      ],
      removalInstructions: (url) => [
        `In the Braintree Control Panel, go to Settings → Webhooks and delete the webhook with this URL: ${url}`,
      ],
    },
    // A card sale settles in the charge call; settlement webhooks only confirm it.
    settlement: {},
  },
  cashfree: {
    key: "cashfree",
    displayName: "Cashfree",
    note: "India. UPI Autopay, eNACH and card mandates in INR, and card mandates in USD and EUR. Pay now also takes cards in USD, EUR, GBP, AED and JPY.",
    credentialFields: [
      {
        key: "app_id",
        label: "App ID",
        hint: "Cashfree Merchant Dashboard → Developers → API Keys. The business test or live mode selects the Cashfree environment.",
      },
      { key: "secret_key", label: "Secret Key", hint: "On the same page, next to the App ID." },
    ],
    advertisedMethods: ["card", "upi", "bank_transfer"],
    // A subscription plan has one currency, and Cashfree debits it in that currency only.
    mandateCurrencyAuthoritative: ["card", "upi", "bank_transfer"],
    methodOptions: [
      {
        value: "card",
        label: "Cards",
        hint: "Saved cards: INR, USD and EUR. Cashfree sends the debit notice for INR. We send it for USD and EUR. Pay now also takes GBP, AED and JPY. Cashfree must enable international payments on your account.",
      },
      { value: "upi", label: "UPI Autopay", hint: "INR only. The debit settles asynchronously." },
      {
        value: "bank_transfer",
        label: "eNACH",
        hint: "INR only. The bank approves the mandate in 1 to 2 days.",
      },
    ],
    currencyBoundMethods: { upi: "INR", bank_transfer: "INR" },
    // Pinned to `CASHFREE_ORDER_CURRENCIES` and `CASHFREE_MANDATE_CURRENCIES` by verify:cashfree.
    // USD and EUR mandates are card only (`currencyBoundMethods` keeps UPI and eNACH on INR).
    intentCurrencies: {
      setup: ["INR", "USD", "EUR"],
      payment: ["INR", "USD", "EUR", "GBP", "AED", "JPY"],
    },
    // The order currencies proven in the sandbox (`CASHFREE_ORDER_EXPONENTS`).
    currencies: codes(`
      AED EUR GBP INR JPY USD
    `),
    currencyConditions:
      "Currencies other than INR need Cashfree to enable international payments on your account. Cashfree settles in INR.",
    internationalSwitch: { domesticCurrency: "INR" },
    webhook: {
      // The endpoint gets its own Secret Key in Cashfree's dashboard (no API to read it).
      // Without one pasted, webhooks are checked with the account's API Secret Key.
      // Payments tab: version 2025-01-01, as 2026-01-01 does not offer the refund and dispute
      // events yet. Subscriptions tab: 2026-01-01, the version of the controlled debit flow.
      secret: "operator_pasted",
      instructions: (url) => [
        "In Cashfree: go to Developers → Webhooks → Add Webhook Endpoint.",
        `Paste this notification URL: ${url}`,
        "Select webhook version 2025-01-01. Select these events: success payment, failed payment, user dropped payment, instrument active, instrument failed, refund, auto refund, dispute created, dispute updated and dispute closed.",
        "Click Continue and save. Then copy the webhook endpoint's Secret Key (not your API Secret Key), paste it on this page and click Save.",
        "On the Subscriptions tab of the same page, add the same URL. Select webhook version 2026-01-01. Then select all subscription events.",
      ],
      fallbackInstructions: [
        "In Cashfree: go to Developers → Webhooks → Add Webhook Endpoint.",
        "Paste the notification URL shown on this page. Select webhook version 2025-01-01 and the payment, refund and dispute events.",
        "Copy the webhook endpoint's Secret Key (not your API Secret Key), paste it on this page and click Save.",
        "On the Subscriptions tab of the same page, add the same URL. Select webhook version 2026-01-01. Then select all subscription events.",
      ],
      removalInstructions: (url) => [
        `In Cashfree, go to Developers → Webhooks and delete the endpoint with this URL: ${url}`,
        "Do the same on the Subscriptions tab of that page.",
      ],
    },
    // Every mandate debit is scheduled for a later day and reported by webhook. A FAILED
    // payment can be retried in Cashfree under the same payment id and then succeed.
    settlement: { alwaysAsync: true, lateCaptureAfterFailure: true },
    // Subscriptions take the payer inline; there is no customer object to keep.
    noCustomerIds: true,
    // Cashfree refuses a subscription without the payer's phone, or with an email as the
    // name ("customer_name : should be a person name", measured 2026-10-27).
    recurringNeedsPhone: true,
    recurringNeedsName: true,
    orphanedInstrumentRemedy:
      "Cancel the subscription and each of its scheduled payments in the Cashfree dashboard. Or ask the payer to revoke the mandate in their UPI app or bank portal.",
  },
  adyen: {
    key: "adyen",
    displayName: "Adyen",
    note: "Cards, in the currencies that your Adyen merchant account accepts, and SEPA Direct Debit in EUR. Pay now also takes Google Pay and Apple Pay when you add them in Adyen.",
    credentialFields: [
      {
        key: "api_key",
        label: "API Key",
        hint: "Adyen Customer Area → Developers → API credentials. The credential needs the roles Merchant PAL webservice role, Checkout webservice role, Merchant Recurring role, API tokenise payment details and Management API — Webhooks read and write.",
      },
      {
        key: "client_key",
        label: "Client Key",
        placeholder: "test_… or live_…",
        hint: "On the same API credential, under Client settings. Add the origin of your payment pages to Allowed origins. The account health check reads this list.",
      },
      {
        key: "merchant_account",
        label: "Merchant Account",
        placeholder: "YourCompanyECOM",
        hint: "The code of the merchant account that takes the payments.",
      },
      {
        key: "live_url_prefix",
        label: "Live URL Prefix",
        placeholder: "1797a841fbb37ca7-YourCompany",
        hint: "Developers → API URLs → Prefix, for a live account. For a test account, type test.",
      },
    ],
    advertisedMethods: ["card", "sepa_debit"],
    // SEPA debits EUR only. A stored card has no mandate currency.
    mandateCurrencyAuthoritative: ["sepa_debit"],
    methodOptions: [
      {
        value: "card",
        label: "Cards",
        hint: "Pay now also shows Google Pay. Add Google Pay to your merchant account in the Adyen Customer Area. A live account also needs your Google Merchant ID in the live Customer Area. In Safari, pay now also shows Apple Pay, which opens an Adyen payment page. Add Apple Pay to your merchant account in the Customer Area. Apple Pay is not saved for renewals.",
      },
      {
        value: "sepa_debit",
        label: "Direct Debit (SEPA)",
        hint: "EUR only. Add SEPA Direct Debit to your merchant account in the Adyen Customer Area. Adyen limits each debit to EUR 500 until Adyen support raises the limit. We email the payer before each renewal debit. A bank return makes the invoice due again.",
      },
    ],
    currencyBoundMethods: { sepa_debit: "EUR" },
    // Accepting a chargeback in the Customer Area sends no webhook (measured 2026-10-27).
    disputeFinalState: false,
    // Adyen retries a webhook for up to 30 days and never re-signs it with a new HMAC key.
    webhookRetryDays: 30,
    currencies: codes(`
      AED ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BMD BND BOB BRL BSD BWP BYN BZD
      CAD CHF CLP CNY COP CRC CVE CZK DJF DKK DOP DZD EGP ETB EUR FJD FKP GBP GEL GHS
      GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD ISK JMD JOD JPY KES KGS KHR
      KMF KRW KWD KYD KZT LAK LKR LYD MAD MDL MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR
      MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF
      SAR SBD SCR SEK SGD SHP SLE SOS SRD STN SVC SZL THB TND TOP TRY TTD TWD TZS UAH
      UGX USD UYU UZS VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW
    `),
    currencyConditions:
      "Your merchant account takes the currencies that Adyen set up for your account.",
    webhook: {
      // We create the standard webhook with the Management API and keep the HMAC key it mints.
      secret: "provider_minted",
      // Adyen marks a delivery failing after 10 s, so we answer once it is stored.
      processAfterAnswer: { body: "[accepted]" },
      instructions: (url) => [
        "No action is necessary. tmbilling registered this endpoint with Adyen for you.",
        `Check it under Developers → Webhooks in the Adyen Customer Area: ${url}`,
      ],
      fallbackInstructions: [
        "Click “Register with Adyen” on this page. We create the webhook and keep its HMAC key.",
        "The API credential needs the role Management API — Webhooks read and write.",
      ],
    },
    // A card authorisation answers in the charge call; webhooks confirm it. A SEPA debit is
    // answered at submission too, but its return arrives only by webhook.
    settlement: { asyncMethods: ["sepa_debit"] },
    // No customer object: the shopper reference is our customer id.
    noCustomerIds: true,
    // A payment link restricted to `applepay`, on Adyen's own domain and certificate.
    applePayHosted: "only",
  },
  checkoutcom: {
    key: "checkoutcom",
    displayName: "Checkout.com",
    // Apple Pay waits for live proof (`live-proof-pending.json`). Restore its text when it lands.
    note: "Cards. Pay now also takes Google Pay when Checkout.com enables it for your account. Apple Pay is coming soon.",
    credentialFields: [
      {
        key: "secret_key",
        label: "Secret key",
        placeholder: "sk_…",
        hint: "Checkout.com Dashboard → Developers → Keys. Use sk_sbox_ keys for a test business and live keys for a live business.",
      },
      { key: "public_key", label: "Public key", placeholder: "pk_…" },
      {
        key: "processing_channel_id",
        label: "Processing channel ID",
        placeholder: "pc_…",
        hint: "Checkout.com Dashboard → Settings → Processing channels.",
      },
      {
        key: "api_prefix",
        label: "API prefix",
        placeholder: "abcd1234",
        hint: "The 8 characters before .api.checkout.com in your base URL. Find it in Checkout.com Dashboard → Developers → Overview. You can also paste the full base URL.",
      },
      {
        key: "default_country",
        label: "Default billing country",
        placeholder: "US",
        hint: "Checkout.com needs a billing country to open the card form. We use the country of the customer's billing address. If the customer has no billing address, we use this two-letter country code.",
      },
      {
        key: "entity_id",
        label: "Entity ID",
        placeholder: "ent_…",
        hint: "The ID of the Checkout.com entity that owns the processing channel (ent_…). We need it to register the webhook. In the Checkout.com Dashboard, click your account name at the top left, select the entity in the Entity column and click Switch view. Then click the Settings icon and select Account details. You must have the Owner or Admin role.",
      },
    ],
    advertisedMethods: ["card"],
    methodOptions: [
      {
        value: "card",
        label: "Cards",
        hint: "Pay now also shows Google Pay. To enable it, send your Google Pay Merchant ID to your Checkout.com account manager. Apple Pay is coming soon.",
      },
    ],
    currencies: codes(`
      AED AFN ALL AMD AOA AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BRL BSD BTN BWP
      BZD CAD CDF CHF CLP CNY COP CRC CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP
      GBP GEL GIP GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD ISK JMD JOD JPY KES KGS
      KHR KMF KRW KWD KYD KZT LAK LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR
      MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR
      RON RSD RWF SAR SBD SCR SEK SGD SHP SLE SOS SRD STN SVC SZL THB TJS TMT TND TOP
      TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR
      ZMW
    `),
    currencyConditions:
      "Your processing channel takes the currencies that Checkout.com set up for your account.",
    webhook: {
      // We create a workflow with a signature key we choose, and keep the key.
      secret: "provider_minted",
      instructions: (url) => [
        "No action is necessary. tmbilling created a webhook workflow at Checkout.com for you.",
        `See it under Developers → Webhooks in Checkout.com: ${url}`,
      ],
      fallbackInstructions: [
        "Click “Register with Checkout.com” on this page. We create the webhook workflow and keep its signature key.",
        "Optional: make sure that it shows under Developers → Webhooks in Checkout.com.",
      ],
    },
    // A card charge is approved in the call; capture and refund outcomes arrive by webhook.
    settlement: {},
    // A Hosted Payments Page restricted to `applepay`, on Checkout.com's own domain.
    applePayHosted: "only",
  },
  authorizenet: {
    key: "authorizenet",
    // eCheck: the merchant must capture the payer's authorization (NACHA WEB).
    achAuthorization: "ours",
    displayName: "Authorize.net",
    note: "Cards and eCheck (US bank accounts). One currency for each merchant account.",
    credentialFields: [
      {
        key: "api_login_id",
        label: "API Login ID",
        hint: "Authorize.net Merchant Interface → Account → Account and API Settings → API Credentials and Keys. Also turn on the Transaction Details API: we use it to find payments and refunds. The business test or live mode selects the Authorize.net environment.",
      },
      { key: "transaction_key", label: "Transaction Key", hint: "Make it on the same page." },
      {
        key: "signature_key",
        label: "Signature Key",
        hint: "Make it on the same page. It has 128 characters. We use it to check the webhooks from Authorize.net.",
      },
    ],
    advertisedMethods: ["card", "us_bank_account"],
    methodOptions: [
      { value: "card", label: "Cards" },
      {
        value: "us_bank_account",
        label: "eCheck (ACH)",
        hint: "US bank accounts, USD. Turn on eCheck in Authorize.net first. A debit takes up to 7 days to settle. The payer accepts our debit authorization when they save the account.",
      },
    ],
    // An eCheck is saved with the payer's authorization, then charged: never authorized now.
    setupOnlyMethods: ["us_bank_account"],
    currencies: codes(`
      AUD CAD EUR GBP NZD USD
    `),
    currencyConditions:
      "Each gateway account takes one currency, and your processor sets which one. For example: USD or CAD in North America, GBP or EUR in Europe, AUD or NZD in Asia-Pacific.",
    webhook: {
      secret: "credential",
      // Measured 2026-10-24: a URL with a query string is refused ("Invalid Url entered").
      accountIdInPath: true,
      instructions: (url, mode) =>
        mode === "self_provisioned"
          ? [
              "No action is necessary. tmbilling registered this endpoint with Authorize.net for you.",
              `You can see it in the Merchant Interface under Account → Settings → Webhooks: ${url}`,
              "Your Signature Key signs the events. If you make a new Signature Key, enter it on this page too.",
            ]
          : [
              "In the Authorize.net Merchant Interface, go to Account → Settings → Webhooks → Add Endpoint.",
              `Paste this notification URL: ${url}`,
              "Select the payment events: authorization and capture, authorization, prior authorization capture, refund, void and the three fraud events. Also select payment profile updated and payment profile deleted. Set the status to Active and click Save.",
              "Your Signature Key signs the events. You do not need a webhook secret.",
            ],
      fallbackInstructions: [
        "In the Authorize.net Merchant Interface, go to Account → Settings → Webhooks → Add Endpoint.",
        "Paste the notification URL shown on this page. Select the payment events and the payment profile events. Set the status to Active and click Save.",
      ],
    },
    // A card sale settles in the charge call; a fraud hold is decided by webhook. An eCheck
    // settles days later and only the batch report says so (the settlement poll, not a
    // webhook, so no `asyncMethods`). A reversed eCheck chargeback is booked again on the
    // failed payment.
    settlement: { lateCaptureAfterFailure: true },
    // No dispute webhook or API (none of its event types is a chargeback).
    disputeFeed: false,
  },
  square: {
    key: "square",
    // The Web Payments SDK shows its own ACH text, and Square forbids extra text.
    achAuthorization: "gateway",
    displayName: "Square",
    // Apple Pay waits for live proof (`live-proof-pending.json`). Restore its text when it lands.
    note: "Cards on file. Pay now also takes Google Pay, Cash App Pay, Afterpay and ACH. Apple Pay is coming soon. One currency for each location.",
    credentialFields: [
      {
        key: "access_token",
        label: "Access token",
        hint: "Square Developer Console → your application → Credentials. Use the Sandbox access token for a test business and the Production access token for a live business.",
      },
      {
        key: "application_id",
        label: "Application ID",
        placeholder: "sq0idp-…",
        hint: "On the same page. A sandbox Application ID starts with sandbox-sq0idb-.",
      },
      {
        key: "location_id",
        label: "Location ID",
        hint: "Square Developer Console → your application → Locations. Each location charges in one currency: the currency of its country.",
      },
    ],
    advertisedMethods: ["card"],
    methodOptions: [
      {
        value: "card",
        label: "Cards",
        hint: "Apple Pay is coming soon.",
      },
    ],
    currencies: codes(`
      AUD CAD EUR GBP JPY USD
    `),
    currencyConditions: "Each Square location takes one currency: the currency of its country.",
    webhook: {
      // We create a webhook subscription through the API; Square mints its signature key.
      secret: "provider_minted",
      instructions: (url) => [
        "No action is necessary. tmbilling made a webhook subscription at Square for you.",
        `See it in the Square Developer Console under your application → Webhooks → Subscriptions: ${url}`,
      ],
      fallbackInstructions: [
        "Click “Register with Square” on this page. We make the webhook subscription and keep its signature key.",
        "Square accepts only HTTPS notification URLs.",
      ],
    },
    // A card renewal is captured in the charge call. Pay-now ACH settles by webhook.
    settlement: {},
    // No wallet domains: Apple Pay in the Web Payments SDK needs Square's association file at
    // a path our storefront domain already serves for another gateway. It goes hosted instead.
    // A payment link cannot hide cards, and Square does not mark an online Apple Pay payment.
    applePayHosted: "with_cards",
  },
  mollie: {
    key: "mollie",
    displayName: "Mollie",
    note: "Cards, SEPA Direct Debit and PayPal. Pay now also offers every other method that you activate in Mollie.",
    credentialFields: [
      {
        key: "api_key",
        label: "API key",
        placeholder: "live_…",
        hint: "Mollie Dashboard → Developers → API keys. Use the test_ key for a test business and the live_ key for a live business.",
      },
    ],
    advertisedMethods: ["card", "sepa_debit", "paypal"],
    // SEPA debits EUR only. Cards and PayPal have no stored mandate currency.
    mandateCurrencyAuthoritative: ["sepa_debit"],
    methodOptions: [
      { value: "card", label: "Cards", hint: "Also Apple Pay and Google Pay." },
      {
        value: "sepa_debit",
        label: "Direct Debit (SEPA)",
        hint: "EUR only. The payer sets it up with iDEAL, Bancontact, Belfius, KBC, EPS or Pay by Bank and pays EUR 0.01. The debit settles asynchronously.",
      },
      {
        value: "paypal",
        label: "PayPal",
        hint: "Automatic payments need PayPal Reference Transactions on your PayPal business account.",
      },
    ],
    currencyBoundMethods: { sepa_debit: "EUR" },
    // A Mollie chargeback has no status: only `reversedAt` if it is reversed.
    disputeFinalState: false,
    // Not HUF or TWD: on PayPal Mollie rounds them up to whole units, and the adapter does not
    // refuse a fraction.
    currencies: codes(`
      AED AUD BRL CAD CHF CZK DKK EUR GBP HKD ILS ISK JPY MXN MYR NOK NZD PHP PLN RON
      RUB SEK SGD THB UAH USD ZAR
    `),
    currencyConditions:
      "Each payment method takes a subset of these. BRL, MXN, MYR and THB are for PayPal only.",
    webhook: {
      // Mollie posts only a payment id to the URL we send with each payment, unsigned. We
      // read the payment back with the API key, so there is no secret to configure.
      secret: "credential",
      instructions: (url) => [
        "No action is necessary. We send this notification URL to Mollie with each payment.",
        `Mollie sends status changes to: ${url}`,
        "We read each payment back from Mollie with your API key. You do not need a webhook secret.",
      ],
      fallbackInstructions: [
        "No action is necessary. We send the notification URL to Mollie with each payment.",
      ],
    },
    // Recurring payments report their outcome by webhook; SEPA debits settle days later.
    settlement: { alwaysAsync: true },
    orphanedInstrumentRemedy:
      "Revoke the mandate in the Mollie dashboard (Customers → the customer → Mandates → Revoke).",
  },
  payu: {
    key: "payu",
    displayName: "PayU",
    note: "India. Card, UPI Autopay and net banking mandates. One-time payments use every method enabled on your PayU account. INR only. PayU must enable recurring payments (standing instructions) on your account. The connection check cannot see if they did.",
    credentialFields: [
      {
        key: "merchant_key",
        label: "Merchant Key",
        hint: "PayU Dashboard → Developer → API Keys. The business test or live mode selects the PayU environment.",
      },
      {
        key: "merchant_salt",
        label: "Merchant Salt (v1)",
        hint: "On the same page. We use it to sign requests and to check the webhooks from PayU.",
      },
    ],
    advertisedMethods: ["card", "upi", "bank_transfer"],
    // Every PayU mandate registers in INR, the only currency PayU takes here.
    mandateCurrencyAuthoritative: ["card", "upi", "bank_transfer"],
    mandateCeilingCapMinor: { upi: 1_500_000 },
    methodOptions: [
      {
        value: "card",
        label: "Cards",
        hint: "INR only. We send the advance notice through PayU at least 24 hours before each renewal debit.",
      },
      {
        value: "upi",
        label: "UPI Autopay",
        hint: "INR only. At most ₹15,000 for each payment. We send the advance notice through PayU at least 25 hours before each renewal debit. The debit can take some minutes to complete.",
      },
      {
        value: "bank_transfer",
        label: "Net banking (eNACH)",
        hint: "INR only. PayU must enable it on your account. Banks do not accept refunds of these debits.",
      },
    ],
    currencyBoundMethods: { card: "INR", upi: "INR", bank_transfer: "INR" },
    // INR only until PayU enables multi-currency on our account.
    currencies: codes(`
      INR
    `),
    currencyConditions:
      "PayU takes other currencies when it enables cross-border payments on an account. Two Minute Billing does not offer them on PayU yet.",
    webhook: {
      // Payment webhooks carry a reverse hash made with the Merchant Salt.
      secret: "credential",
      // PayU does not say whether a webhook URL may carry a query string; the path form works either way.
      accountIdInPath: true,
      instructions: (url) => [
        "In the PayU Dashboard, go to Developer → Webhooks → Create Webhook.",
        "For Type, select Payments. For Event, select Successful.",
        `Paste this notification URL: ${url}`,
        "Click Create. Then do these steps again for the Failed event and for the Refund event.",
        "Your Merchant Salt signs the payment events. You do not need a webhook secret.",
        "Ask PayU support to send mandate cancellation and modification updates to the same URL.",
      ],
      fallbackInstructions: [
        "In the PayU Dashboard, go to Developer → Webhooks → Create Webhook.",
        "Paste the notification URL shown on this page for the Successful, Failed and Refund payment events.",
      ],
    },
    // Card renewals can settle in the call; UPI and net banking settle by webhook or poll.
    // PayU documents no capture after a failure; if one comes, the money is booked, not dropped.
    settlement: { asyncMethods: ["upi", "bank_transfer"], lateCaptureAfterFailure: true },
    // No customer object at PayU.
    noCustomerIds: true,
    // PayU refuses a checkout without the payer's phone.
    recurringNeedsPhone: true,
    // Dispute webhooks are unsigned and cannot be read back, so none is booked.
    disputeFeed: false,
    orphanedInstrumentRemedy:
      "Revoke the mandate in the PayU dashboard. Or ask the payer to revoke it in their UPI app or bank portal.",
  },
  cybersource: {
    key: "cybersource",
    displayName: "CyberSource",
    note: "Cards. Bank accounts (eCheck) need the eCheck service on the CyberSource account.",
    credentialFields: [
      {
        key: "organization_id",
        label: "Organization ID",
        placeholder: "yourname_1234567890",
        hint: "Your CyberSource Organization ID. In a test account it has the form name_1234567890. Do not enter the user name that you selected at sign-up: CyberSource refuses it. The business test or live mode selects the CyberSource environment.",
      },
      {
        key: "key_id",
        label: "Key",
        placeholder: "00000000-0000-0000-0000-000000000000",
        hint: "In the Business Center, go to Payment Configuration → Key Management → Generate key. Select REST – Shared Secret. Enter the Key value here.",
      },
      {
        key: "shared_secret",
        label: "Shared Secret",
        hint: "The Shared Secret from the same key. It has 44 characters.",
      },
    ],
    advertisedMethods: ["card", "us_bank_account"],
    // Bank accounts are not offered for saving: CyberSource stores one only after a payment.
    methodOptions: [{ value: "card", label: "Cards" }],
    // An eCheck pays once; CyberSource saves the bank account only with that payment.
    payNowOnlyMethods: ["us_bank_account"],
    // No dispute webhook or API.
    disputeFeed: false,
    webhook: {
      secret: "provider_minted",
      instructions: (url) => [
        "You do not copy a secret. tmbilling subscribes this address to CyberSource webhooks and makes the digital signature key that signs the events.",
        `CyberSource reviews a new address before it sends events. This can take 1 to 2 business days. The address is ${url}`,
        "If you make a digital signature key for this organization in another system, it replaces ours. Then click Re-register on this page.",
      ],
      fallbackInstructions: [
        "CyberSource webhooks are set up through its API only. Click “Register with CyberSource” on this page.",
      ],
    },
    // Card charges settle in the call; eCheck debits by webhook or poll, days later.
    settlement: { asyncMethods: ["us_bank_account"] },
  },
};

export const GATEWAY_KEYS = Object.keys(GATEWAYS) as ProviderKey[];

/** Gateways that move real money — the ones a caller may name for a vault or setup. */
export const REAL_GATEWAY_KEYS = GATEWAY_KEYS.filter((k) => !GATEWAYS[k].simulated) as [
  ProviderKey,
  ...ProviderKey[],
];

export function isGatewayKey(key: string | null | undefined): key is ProviderKey {
  return key != null && Object.hasOwn(GATEWAYS, key);
}

/**
 * True when a person may record a dispute on this gateway's payments: the gateway sends no
 * dispute events. An unknown key (`offline`, a retired gateway) answers false.
 */
export function operatorRecordsDisputes(key: string | null | undefined): boolean {
  return gatewayDefinition(key)?.disputeFeed === false;
}

/**
 * True when a person may record the OUTCOME of a dispute this gateway reported: it sends the
 * dispute but never a final state. (Hand-recorded disputes take their outcome by hand anyway.)
 */
export function operatorRecordsDisputeOutcome(key: string | null | undefined): boolean {
  return gatewayDefinition(key)?.disputeFinalState === false;
}

/**
 * Gateways whose adapter declares `capabilities.pendingDebitCancel`, readable without building
 * one. Pinned to the adapters by `test/unit/pending-debit-cancel.test.ts`.
 */
const PENDING_DEBIT_CANCEL: ReadonlySet<ProviderKey> = new Set<ProviderKey>([
  "gocardless",
  "cashfree",
  "mollie",
  "stripe",
  "authorizenet",
  "tmtest",
]);

/** True when the gateway can be asked to stop a pending debit. Unknown keys answer false. */
export function gatewayCancelsPendingDebits(key: string | null | undefined): boolean {
  return isGatewayKey(key) && PENDING_DEBIT_CANCEL.has(key);
}

/**
 * True when the gateway can create an intent for this purpose. An unknown key answers true:
 * routing has nothing to say about it, and resolving its adapter fails later by name.
 */
export function gatewayAllowsPurpose(
  key: string | null | undefined,
  purpose: IntentPurpose,
  currency?: string | null,
): boolean {
  const def = gatewayDefinition(key);
  if (!def) return true;
  if (!allowsIntentPurpose(def.intentPurposes, purpose)) return false;
  const list = def.intentCurrencies?.[purpose];
  return !currency || !list || list.includes(currency.toUpperCase());
}

/**
 * True when the gateway takes `currency` for some purpose (`intentCurrencies`). With no
 * purpose in hand, a currency no purpose takes is the only one ruled out.
 */
export function gatewayTakesCurrency(
  key: string | null | undefined,
  currency: string,
  purpose?: IntentPurpose,
): boolean {
  if (purpose) return gatewayAllowsPurpose(key, purpose, currency);
  const lists = Object.values(gatewayDefinition(key)?.intentCurrencies ?? {});
  return lists.length === 0 || lists.some((l) => l.includes(currency.toUpperCase()));
}

/**
 * False when the account's "International payments" switch is off and `currency` is not the
 * gateway's domestic currency (`internationalSwitch`). True for a gateway without the switch.
 * Only an explicit `false` is off.
 */
export function internationalAllows(
  acc: { gatewayKey: string; internationalEnabled?: boolean | null },
  currency: string,
): boolean {
  const sw = gatewayDefinition(acc.gatewayKey)?.internationalSwitch;
  if (!sw || acc.internationalEnabled !== false) return true;
  return currency.toUpperCase() === sw.domesticCurrency;
}

/** True when `currency` is on the gateway's `currencies` list. No list or an unknown key: true. */
export function gatewaySupportsCurrency(key: string | null | undefined, currency: string): boolean {
  const list = gatewayDefinition(key)?.currencies;
  return !list || list.includes(currency.toUpperCase());
}

/** True when the storefront must show our ACH authorization text for this gateway. */
export function achAuthorizationIsOurs(key: string | null | undefined): boolean {
  return gatewayDefinition(key)?.achAuthorization === "ours";
}

/** The definition for a stored gateway key, or undefined for a key no build knows. */
export function gatewayDefinition(key: string | null | undefined): GatewayDefinition | undefined {
  return isGatewayKey(key) ? GATEWAYS[key] : undefined;
}

/** True when the gateway debits a saved `method` only in the mandate currency we stored for it. */
export function mandateCurrencyIsAuthoritative(
  gatewayKey: string | null | undefined,
  method: string | null | undefined,
): boolean {
  const list = gatewayDefinition(gatewayKey)?.mandateCurrencyAuthoritative as
    | readonly string[]
    | undefined;
  return !!method && !!list?.includes(method);
}

/**
 * The method keys the availability flag can withhold on this gateway
 * (`live-proof-pending.json`): the advertised methods, which leave the buyer lists and new
 * setups, and `apple_pay` where pay now opens the gateway's hosted page for it.
 */
export function withholdableMethods(key: string | null | undefined): string[] {
  const def = gatewayDefinition(key);
  if (!def) return [];
  return [...def.advertisedMethods, ...(def.applePayHosted ? ["apple_pay"] : [])];
}

/** A method's name for messages: the setup screen's label, else a plain name. */
export function methodLabel(key: string | null | undefined, method: string): string {
  const option = gatewayDefinition(key)?.methodOptions.find((m) => m.value === method);
  return option?.label ?? (method === "apple_pay" ? "Apple Pay" : method.replace(/_/g, " "));
}
