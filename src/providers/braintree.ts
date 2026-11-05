/**
 * Braintree adapter, over Braintree's GraphQL API (no SDK — the engine never imports one).
 *
 * Braintree does two jobs here, as every gateway does: vault cards and move money. Its own
 * subscriptions are never used; the engine owns subscription state.
 *
 * Ids: `providerCustomerId` and `providerPaymentMethodId` are GraphQL global ids (what every
 * mutation takes). `providerChargeId` / `providerRefundId` are LEGACY transaction ids — what
 * webhooks, disputes and the Control Panel carry — and are turned back into global ids for a
 * mutation (`base64("transaction_<id>")`, verified against the sandbox).
 *
 * Buyer flow (`mode: 'sdk'`): `createIntent` mints a client token; the browser's Drop-in turns
 * a card, a PayPal account or a Venmo account into a single-use nonce; `submitClientResult`
 * reads the nonce (its type and 3D Secure result), then vaults it (setup) or authorizes with
 * it (payment). Nothing is held until our server uses the nonce.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { decimalToMinor, minorToDecimalString } from "@/platform/currency";
import { createLogger } from "@/platform/logger";
import { normalizeBraintreeDecline, type DeclineSignal } from "./decline-codes";
import { classifyGatewayHttp } from "./gateway-http-class";
import { boundedProviderKey, providerFetch } from "./http";
import {
  ProviderIndeterminateError,
  ProviderRefusalError,
  markStrandedObject,
  type BuyerAuthorization,
  type ChargeInitiator,
  type ChargeInput,
  type ChargeResult,
  type ConsumeIntentInput,
  type ConsumeIntentResult,
  type CreateIntentInput,
  type EnsureCustomerInput,
  type FetchedIntent,
  type InitiateVaultSetupInput,
  type IntentPurpose,
  type IntentRef,
  type NormalizeWebhookInput,
  type ProviderContact,
  type NormalizedProviderEvent,
  type PaymentProvider,
  type ProviderCapabilities,
  type ProviderCustomerRef,
  type ProviderPaymentMethodRef,
  type ProviderRefundRecord,
  type RefundInput,
  type RefundResult,
  type VaultPaymentMethodInput,
  type VaultSetupRef,
  type VoidIntentInput,
  type VoidIntentResult,
} from "./types";
import { webhookEventId } from "./webhook-event-id";

const log = createLogger("braintree");

/** Pinned schema date (`Braintree-Version`). Change it only with a re-run of the live suite. */
export const BRAINTREE_VERSION = "2019-01-01";
export const BRAINTREE_SANDBOX_URL = "https://payments.sandbox.braintree-api.com/graphql";
export const BRAINTREE_LIVE_URL = "https://payments.braintree-api.com/graphql";
/** `orderId` prefix that marks a Braintree transaction as ours (#31) — PayPal's convention. */
export const BRAINTREE_OWNERSHIP_PREFIX = "tmbilling_ref:";
/** "Maximum 255 characters or 127 for PayPal transactions" (`orderId`, schema). */
const ORDER_ID_MAX = 127;
/** Undocumented cap; keep `apiRequestKey` short like every other gateway reference. */
const REQUEST_KEY_MAX = 64;
const SYNTHETIC_PREFIX = "btci_";

// ── Currency → merchant account ─────────────────────────────────────────────

/** `null` = the merchant's default merchant account. */
export type MerchantAccountMap = Map<string, string | null>;

/**
 * `"USD"` (the default account's currency) or `"USD=fernhill_usd, EUR=fernhill_eur"`. A bare currency
 * maps to the default account. Empty = USD on the default account.
 */
export function parseMerchantAccounts(raw: string | undefined | null): MerchantAccountMap {
  const out: MerchantAccountMap = new Map();
  for (const part of (raw ?? "").split(/[,\n;]/)) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    const currency = (eq < 0 ? item : item.slice(0, eq)).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency))
      throw new Error(`Braintree merchant_accounts: "${item}" does not start with a currency code`);
    const account = eq < 0 ? null : item.slice(eq + 1).trim() || null;
    out.set(currency, account);
  }
  if (out.size === 0) out.set("USD", null);
  return out;
}

// ── Charge initiator ────────────────────────────────────────────────────────

export type BraintreePaymentInitiator = "RECURRING" | "RECURRING_FIRST" | "UNSCHEDULED";

/**
 * Stored-credential flag for a debit. Absent initiator = UNSCHEDULED: every engine charge
 * uses a stored card, and an unknown merchant-initiated debit is the safest claim.
 * Customer-present, non-recurring = no flag (an ordinary customer-initiated payment).
 */
export function braintreePaymentInitiator(
  initiator: ChargeInitiator | undefined,
): BraintreePaymentInitiator | undefined {
  if (!initiator) return "UNSCHEDULED";
  if (initiator.by === "customer") return initiator.recurring ? "RECURRING_FIRST" : undefined;
  return initiator.recurring ? "RECURRING" : "UNSCHEDULED";
}

// ── Ids ─────────────────────────────────────────────────────────────────────

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/=+$/, "");
export const transactionGlobalId = (legacyId: string) => b64(`transaction_${legacyId}`);
export const refundGlobalId = (legacyId: string) => b64(`refund_${legacyId}`);

function decodesTo(id: string, prefix: string): boolean {
  if (!/^[A-Za-z0-9+/]+$/.test(id)) return false;
  return Buffer.from(id, "base64").toString("utf8").startsWith(prefix);
}

/** What a not-yet-used challenge needs at submit time. Adapters are stateless, so it rides the id. */
interface SyntheticIntent {
  p: IntentPurpose;
  /** Braintree customer (global id). */
  c?: string;
  /** Merchant account; absent = default. */
  m?: string;
  /** Amount in minor units, as a string (payment only). */
  a?: string;
  cur: string;
  /** Our ownership ref. */
  r?: string;
  /** Short hash of the idempotency key, so two intents never share an id. */
  k: string;
  /** Method types the buyer may use. Absent = cards only (intents made before PayPal). */
  t?: string[];
}

export function encodeSyntheticIntent(s: SyntheticIntent): string {
  return SYNTHETIC_PREFIX + Buffer.from(JSON.stringify(s), "utf8").toString("base64url");
}

export function decodeSyntheticIntent(id: string): SyntheticIntent | null {
  if (!id.startsWith(SYNTHETIC_PREFIX)) return null;
  try {
    const v = JSON.parse(Buffer.from(id.slice(SYNTHETIC_PREFIX.length), "base64url").toString());
    return v && typeof v === "object" && (v.p === "setup" || v.p === "payment") ? v : null;
  } catch {
    return null;
  }
}

// ── Transactions ────────────────────────────────────────────────────────────

interface BtProcessorResponse {
  legacyCode?: string | null;
  message?: string | null;
  cvvResponse?: string | null;
  avsPostalCodeResponse?: string | null;
  avsStreetAddressResponse?: string | null;
}

interface BtStatusEvent {
  __typename?: string;
  status?: string;
  declineType?: string | null;
  gatewayRejectionReason?: string | null;
  processorResponse?: BtProcessorResponse | null;
  networkResponse?: { code?: string | null; message?: string | null } | null;
  merchantAdviceCodeResponse?: { code?: string | null; message?: string | null } | null;
}

export interface BtTransaction {
  id: string;
  legacyId: string;
  status?: string;
  orderId?: string | null;
  merchantAccountId?: string | null;
  createdAt?: string | null;
  amount?: { value?: string | null; currencyCode?: string | null } | null;
  paymentMethodSnapshot?: {
    __typename?: string;
    creditCard?: { brandCode?: string | null } | null;
  } | null;
  processorAuthorizationResponse?: BtProcessorResponse | null;
  processorSettlementResponse?: { legacyCode?: string | null; message?: string | null } | null;
  statusHistory?: BtStatusEvent[] | null;
}

interface BtRefundRef {
  legacyId: string;
  status?: string;
  orderId?: string | null;
  amount?: { value?: string | null; currencyCode?: string | null } | null;
}
interface BtSaleRefunds {
  legacyId: string;
  amount?: { value?: string | null; currencyCode?: string | null } | null;
  refunds?: BtRefundRef[] | null;
}

const TX_FIELDS = `id legacyId status orderId merchantAccountId createdAt
  amount { value currencyCode }
  paymentMethodSnapshot { __typename ... on CreditCardTransactionDetails { creditCard { brandCode } } }
  processorAuthorizationResponse { legacyCode message }
  processorSettlementResponse { legacyCode message }
  statusHistory { __typename status
    ... on ProcessorDeclinedEvent { declineType processorResponse { legacyCode message } networkResponse { code message } merchantAdviceCodeResponse { code message } }
    ... on GatewayRejectedEvent { gatewayRejectionReason processorResponse { legacyCode message } }
    ... on FailedEvent { processorResponse { legacyCode message } networkResponse { code message } }
    ... on SettlementDeclinedEvent { status }
  }`;

/** A refund as the settlement poll's search reads it. */
export interface BtRefundNode {
  legacyId: string;
  status?: string;
  orderId?: string | null;
  createdAt?: string | null;
  amount?: { value?: string | null; currencyCode?: string | null } | null;
  /** Absent when the refunded sale is not on this gateway account (schema, `Refund`). */
  refundedTransaction?: { legacyId: string; orderId?: string | null } | null;
}
const REFUND_FIELDS = `legacyId status orderId createdAt amount { value currencyCode }
  refundedTransaction { legacyId orderId }`;
/** "By default, the API returns the maximum results per page, 50" (search guide, read 2026-10-27). */
const SEARCH_PAGE = 50;
/** Pages one search of the settlement poll reads before it gives up (it then throws). */
const SEARCH_MAX_PAGES = 40;
/**
 * A refund voided or declined at settlement, or a sale declined at settlement, is searched
 * by status this far back by creation: no search field holds the time of those changes.
 */
const LATE_STATUS_LOOKBACK_MS = 7 * 86_400_000;

/** Money captured (card sales settle in a nightly batch; the authorization is the verdict). */
const CAPTURED = new Set([
  "SUBMITTED_FOR_SETTLEMENT",
  "SETTLING",
  "SETTLED",
  "SETTLEMENT_PENDING",
  "SETTLEMENT_CONFIRMED",
]);
const REFUSED = new Set([
  "PROCESSOR_DECLINED",
  "GATEWAY_REJECTED",
  "FAILED",
  "SETTLEMENT_DECLINED",
  "VOIDED",
  "AUTHORIZATION_EXPIRED",
]);

/** What the decline rules may read off a refused transaction. Newest status event first. */
export function braintreeDeclineSignal(tx: BtTransaction): DeclineSignal {
  const ev = (tx.statusHistory ?? []).find((e) => e.status && REFUSED.has(e.status));
  const settlement = tx.status === "SETTLEMENT_DECLINED" ? tx.processorSettlementResponse : null;
  const proc = ev?.processorResponse ?? tx.processorAuthorizationResponse;
  return {
    code: ev?.gatewayRejectionReason ?? settlement?.legacyCode ?? proc?.legacyCode ?? null,
    message: settlement?.message ?? proc?.message ?? null,
    category: tx.status ?? null,
    networkMessage: ev?.networkResponse?.code ?? null,
    recommendationCode: ev?.merchantAdviceCodeResponse?.code ?? null,
    cardBrand: tx.paymentMethodSnapshot?.creditCard?.brandCode?.toLowerCase() ?? null,
  };
}

function failureOf(tx: BtTransaction): NonNullable<ChargeResult["failure"]> {
  const sig = braintreeDeclineSignal(tx);
  const f = normalizeBraintreeDecline(sig);
  return {
    code: f.code,
    ...(sig.code ? { providerCode: sig.code } : {}),
    message: f.message ?? sig.message ?? `Braintree reports this payment as ${tx.status}`,
    retriable: f.retriable,
    ...(f.retryAfterMs ? { retryAfterMs: f.retryAfterMs } : {}),
    ...(f.ruleId ? { ruleId: f.ruleId } : {}),
  };
}

/**
 * `paymentMethodSnapshot.__typename` → our method type (`ChargeResult.methodUsed`).
 * Members of the `PaymentMethodSnapshot` union in Braintree's GraphQL schema.
 */
const BT_METHOD_USED: Readonly<Record<string, string>> = {
  CreditCardTransactionDetails: "card",
  CreditCardDetails: "card",
  PayPalTransactionDetails: "paypal",
  VenmoAccountDetails: "venmo",
  UsBankAccountDetails: "us_bank_account",
  UsBankAccountTransactionDetails: "us_bank_account",
  SEPADirectDebitTransactionDetails: "sepa_debit",
};

/** `PaymentMethodDetails.__typename` → our method type: what we vault. */
const BT_VAULT_METHOD: Readonly<Record<string, string>> = {
  CreditCardDetails: "card",
  PayPalAccountDetails: "paypal",
  VenmoAccountDetails: "venmo",
};
export const BRAINTREE_METHODS = ["card", "paypal", "venmo"] as const;

/** What the buyer may use: the requested types we support, else cards. */
export function braintreeOfferedMethods(requested: string[] | undefined): string[] {
  const ok = (requested ?? []).filter((m) => (BRAINTREE_METHODS as readonly string[]).includes(m));
  return ok.length ? [...new Set(ok)] : ["card"];
}

/** A 3D Secure authentication as Braintree reports it on a card nonce. */
export interface BtThreeDSecure {
  liabilityShifted?: boolean | null;
  liabilityShiftPossible?: boolean | null;
  authenticationStatus?: string | null;
}

/**
 * 3D Secure statuses Braintree rejects when 3D Secure is required ("Reject if 3DS is
 * required: Yes", 3DS status codes, applying-3ds-to-transactions-and-verifications, read
 * 2026-10-28). Required is its default for a 3D Secure nonce, and it recommends keeping it.
 */
const THREE_DS_REJECTED = new Set([
  "AUTHENTICATE_ERROR",
  "AUTHENTICATE_FAILED",
  "AUTHENTICATE_UNABLE_TO_AUTHENTICATE",
  "CHALLENGE_REQUIRED",
  "AUTHENTICATE_REJECTED",
  "AUTHENTICATE_FRICTIONLESS_FAILED",
  "AUTHENTICATE_FAILED_ACS_ERROR",
  "LOOKUP_CARD_ERROR",
  "LOOKUP_SERVER_ERROR",
]);

/**
 * Our 3D Secure policy, the same for a saved card and a payment: refuse what Braintree
 * itself rejects when 3D Secure is required, and any card that could shift liability and
 * did not. Proceed when the card cannot take part (not enrolled, bypassed, unavailable,
 * exempt) or no 3D Secure ran. The buyer is present and can try again.
 */
export function braintreeThreeDSecureFailure(
  auth: BtThreeDSecure | null | undefined,
): NonNullable<ChargeResult["failure"]> | null {
  if (!auth) return null;
  const status = auth.authenticationStatus?.toUpperCase() ?? "";
  const refused =
    THREE_DS_REJECTED.has(status) || (!!auth.liabilityShiftPossible && !auth.liabilityShifted);
  if (!refused) return null;
  const f = normalizeBraintreeDecline({
    code: auth.authenticationStatus ?? null,
    category: "THREE_D_SECURE_NOT_SHIFTED",
  });
  return {
    code: f.code,
    ...(auth.authenticationStatus ? { providerCode: auth.authenticationStatus } : {}),
    message: f.message ?? "3D Secure did not confirm this card.",
    retriable: f.retriable,
    ...(f.ruleId ? { ruleId: f.ruleId } : {}),
  };
}

export function braintreeMethodUsed(tx: Pick<BtTransaction, "paymentMethodSnapshot">): {
  methodUsed?: string;
} {
  const t = tx.paymentMethodSnapshot?.__typename;
  const m = t ? BT_METHOD_USED[t] : undefined;
  return m ? { methodUsed: m } : {};
}

/** `authorization: true` = an authorize-only call, where AUTHORIZED is the success. */
export function chargeResultFromTransaction(
  tx: BtTransaction,
  opts: { authorization?: boolean } = {},
): ChargeResult {
  const status = tx.status ?? "";
  const used = braintreeMethodUsed(tx);
  if (CAPTURED.has(status) || (opts.authorization && status === "AUTHORIZED"))
    return { status: "succeeded", providerChargeId: tx.legacyId, ...used, raw: tx };
  if (REFUSED.has(status))
    return {
      status: "failed",
      providerChargeId: tx.legacyId,
      failure: failureOf(tx),
      ...used,
      raw: tx,
    };
  // AUTHORIZED / AUTHORIZING / anything newer: the money is not settled either way.
  return { status: "pending", providerChargeId: tx.legacyId, ...used, raw: tx };
}

/**
 * A void of the SALE is the full refund before settlement (succeeded). A VOIDED Refund
 * means "the customer will not receive the funds" (schema, `PaymentStatus.VOIDED`).
 */
function refundStatusOf(
  status: string | undefined,
  object: "refund" | "sale" = "refund",
): RefundResult["status"] {
  if (status === "VOIDED") return object === "sale" ? "succeeded" : "failed";
  if (status && CAPTURED.has(status)) return "succeeded";
  if (status && REFUSED.has(status)) return "failed";
  return "pending";
}

function ownershipOrderId(ref: string): string {
  return (BRAINTREE_OWNERSHIP_PREFIX + ref).slice(0, ORDER_ID_MAX);
}

function ownershipOf(orderId: string | null | undefined, present: boolean) {
  if (orderId?.startsWith(BRAINTREE_OWNERSHIP_PREFIX))
    return {
      ownership: "ours" as const,
      ownershipRef: orderId.slice(BRAINTREE_OWNERSHIP_PREFIX.length),
    };
  // Every transaction we create carries an orderId; a read one without ours is not ours.
  return { ownership: present ? ("foreign" as const) : ("unknown" as const) };
}

// ── Payment methods ─────────────────────────────────────────────────────────

const BRAND: Record<string, string> = {
  VISA: "visa",
  MASTERCARD: "mastercard",
  AMERICAN_EXPRESS: "amex",
  DISCOVER: "discover",
  JCB: "jcb",
  DINERS: "diners",
  UNION_PAY: "unionpay",
  INTERNATIONAL_MAESTRO: "maestro",
  UK_MAESTRO: "maestro",
};

interface BtPaymentMethod {
  id: string;
  legacyId?: string;
  customer?: { id?: string | null } | null;
  details?: {
    __typename?: string;
    brandCode?: string | null;
    last4?: string | null;
    expirationMonth?: string | null;
    expirationYear?: string | null;
    uniqueNumberIdentifier?: string | null;
    binData?: {
      countryOfIssuance?: string | null;
      issuingBank?: string | null;
      debit?: string | null;
      prepaid?: string | null;
      commercial?: string | null;
    } | null;
    email?: string | null;
  } | null;
}

const PM_FIELDS = `id legacyId customer { id }
  details { __typename
    ... on CreditCardDetails { brandCode last4 expirationMonth expirationYear uniqueNumberIdentifier
      binData { countryOfIssuance issuingBank debit prepaid commercial } }
    ... on PayPalAccountDetails { email }
    ... on VenmoAccountDetails { username } }`;

export function describeBraintreePaymentMethod(
  pm: BtPaymentMethod,
  verification?: { processorResponse?: BtProcessorResponse | null } | null,
): ProviderPaymentMethodRef["display"] {
  const d = pm.details ?? {};
  if (d.__typename === "PayPalAccountDetails") return { type: "paypal" };
  if (d.__typename === "VenmoAccountDetails") return { type: "venmo" };
  const bin = d.binData;
  const funding =
    bin?.prepaid === "YES"
      ? "prepaid"
      : bin?.debit === "YES"
        ? "debit"
        : bin?.debit === "NO"
          ? "credit"
          : undefined;
  const country = bin?.countryOfIssuance;
  const pr = verification?.processorResponse;
  const lc = (v: string | null | undefined) => (v ? v.toLowerCase() : undefined);
  const checks = {
    ...(lc(pr?.cvvResponse) ? { cvcCheck: lc(pr?.cvvResponse) } : {}),
    ...(lc(pr?.avsPostalCodeResponse) ? { avsPostalCheck: lc(pr?.avsPostalCodeResponse) } : {}),
    ...(lc(pr?.avsStreetAddressResponse)
      ? { avsLine1Check: lc(pr?.avsStreetAddressResponse) }
      : {}),
  };
  return {
    type: "card",
    ...(d.brandCode
      ? { brand: BRAND[d.brandCode.toUpperCase()] ?? d.brandCode.toLowerCase() }
      : {}),
    ...(d.last4 ? { last4: d.last4 } : {}),
    ...(d.expirationMonth ? { expMonth: Number(d.expirationMonth) } : {}),
    ...(d.expirationYear ? { expYear: Number(d.expirationYear) } : {}),
    // Only an alpha-2 code fits the column; Braintree may report alpha-3.
    ...(country && /^[A-Z]{2}$/.test(country) ? { issuerCountry: country } : {}),
    ...(funding ? { instrumentFunding: funding } : {}),
    ...(bin?.commercial === "YES" ? { instrumentSubType: "business" } : {}),
    ...(bin?.issuingBank ? { issuerName: bin.issuingBank } : {}),
    ...(d.uniqueNumberIdentifier ? { instrumentFingerprint: d.uniqueNumberIdentifier } : {}),
    ...checks,
    ...(Object.keys(checks).length ? { avsCheckedAt: new Date() } : {}),
  };
}

// ── GraphQL transport ───────────────────────────────────────────────────────

export interface GqlError {
  message: string;
  path?: string[];
  extensions?: {
    errorClass?: string;
    legacyCode?: string;
    inputPath?: string[];
    atMostOnceProcessing?: { id?: string; legacyId?: string; __typename?: string };
  };
}

/** A GraphQL answer that carried errors and no usable data. */
export class BraintreeApiError extends Error {
  constructor(
    readonly operation: string,
    readonly errors: GqlError[],
  ) {
    super(
      `Braintree ${operation}: ${errors.map((e) => `${e.message} (${e.extensions?.legacyCode ?? e.extensions?.errorClass ?? "?"})`).join("; ")}`,
    );
    this.name = "BraintreeApiError";
  }
  get first(): GqlError | undefined {
    return this.errors[0];
  }
  /** What the decline rules read for an API-level refusal: the legacy code, or class:field. */
  get signalCode(): string | undefined {
    const e = this.first?.extensions;
    if (!e) return undefined;
    if (e.legacyCode) return e.legacyCode;
    return e.errorClass ? `${e.errorClass}:${e.inputPath?.at(-1) ?? ""}` : undefined;
  }
}

/** How far back the search for a refused transaction the answer left out reaches. */
const REFUSED_LOOKUP_MS = 15 * 60 * 1000;

/** Idempotency refusals (Braintree's at-most-once processing). */
const REQUEST_IN_FLIGHT = "915233";
/** Same-key replays of a mutation whose outcome is unknown, before it is indeterminate. */
const MUTATION_REPLAYS = 2;
const REPLAY_BACKOFF_MS = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5_000)));

type GqlBody<T> = { data?: T | null; errors?: GqlError[] };
type PostResult<T> = { status: number; retryAfter: string | null; body: GqlBody<T> | null };

/** Error classes that, per Braintree's docs, created nothing. */
const DEFINITE_CLASSES = new Set([
  "VALIDATION",
  "NOT_FOUND",
  "UNSUPPORTED_CLIENT",
  "NOT_IMPLEMENTED",
  "AUTHENTICATION",
  "AUTHORIZATION",
  "RESOURCE_LIMIT",
]);

/** The HTTP status an `errorClass` stands for (Braintree answers 200 with errors). */
function httpTwin(status: number, ext: GqlError["extensions"] | undefined): number {
  if (status !== 200 || !ext) return status;
  if (ext.legacyCode === REQUEST_IN_FLIGHT) return 409;
  if (ext.errorClass === "INTERNAL" || ext.errorClass === "SERVICE_AVAILABILITY") return 503;
  if (ext.errorClass === "RESOURCE_LIMIT") return 429;
  return status;
}

/**
 * A charge refused by an error class that created nothing, which no decline rule names.
 * RESOURCE_LIMIT "created no transaction" (schema, `apiRequestKey`): retriable.
 */
function unclassifiedApiFailure(err: BraintreeApiError): ChargeResult["failure"] | undefined {
  const c = err.first?.extensions?.errorClass;
  if (!c || !DEFINITE_CLASSES.has(c)) return undefined;
  return {
    code: c === "RESOURCE_LIMIT" ? "processing_error" : "gateway_error",
    providerCode: err.signalCode ?? c,
    message: err.first?.message ?? err.message,
    retriable: true,
  };
}

const NOT_A_CARD = {
  code: "payment_method_not_supported",
  message: "This payment method is not a card. Enter a credit or debit card.",
  retriable: false,
};
const NOT_OFFERED = {
  code: "payment_method_not_supported",
  message: "This payment method is not available here. Use a different payment method.",
  retriable: false,
};
const notOffered = (allowed: string[]) =>
  allowed.length === 1 && allowed[0] === "card" ? NOT_A_CARD : NOT_OFFERED;
/** The nonce could not be read: nothing moved, so the buyer can try again. */
const NOT_CHECKED = {
  code: "processing_error",
  message: "We could not check the payment details. Try again.",
  retriable: true,
};

/** An error on a refund, reverse or void that created nothing: the engine releases the hold. */
function isDefiniteRefusal(err: BraintreeApiError | undefined): boolean {
  const c = err?.first?.extensions?.errorClass;
  return !!c && DEFINITE_CLASSES.has(c);
}

// ── Webhooks ────────────────────────────────────────────────────────────────

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(
          e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10),
        )
      : (ENTITY[e] ?? m),
  );

/** Minimal XML reader for webhook payloads: elements, attributes, text. No DTDs, no CDATA. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const tag =
    /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(xml))) {
    const top = stack[stack.length - 1]!;
    top.text += xml.slice(last, m.index);
    last = tag.lastIndex;
    if (!m[2]) continue; // declaration or comment
    if (m[1]) {
      if (top.name !== m[2]) throw new Error(`Malformed XML: </${m[2]}> closes <${top.name}>`);
      top.text = decodeEntities(top.text.trim());
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? "").matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
      attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? "");
    const node: XmlNode = { name: m[2], attrs, children: [], text: "" };
    top.children.push(node);
    if (!m[4]) stack.push(node);
  }
  if (stack.length !== 1) throw new Error("Malformed XML: unclosed element");
  const doc = root.children[0];
  if (!doc) throw new Error("Malformed XML: no root element");
  return doc;
}

export const xmlChild = (n: XmlNode | undefined, name: string) =>
  n?.children.find((c) => c.name === name);
/** Text of a descendant path, or undefined when absent or `nil="true"`. */
export function xmlText(n: XmlNode | undefined, ...path: string[]): string | undefined {
  let cur = n;
  for (const p of path) cur = xmlChild(cur, p);
  if (!cur || cur.attrs.nil === "true") return undefined;
  return cur.text === "" ? undefined : cur.text;
}

export interface BraintreeNotification {
  kind: string;
  timestamp?: string;
  subject?: XmlNode;
}

function formField(payload: string | Buffer, name: string): string | undefined {
  return new URLSearchParams(payload.toString()).get(name) ?? undefined;
}

/** Decode `bt_payload` (base64 XML) WITHOUT checking the signature. */
export function decodeBraintreeNotification(btPayload: string): BraintreeNotification {
  const doc = parseXml(Buffer.from(btPayload, "base64").toString("utf8"));
  return {
    kind: xmlText(doc, "kind") ?? "",
    timestamp: xmlText(doc, "timestamp"),
    subject: xmlChild(doc, "subject")?.children[0],
  };
}

/** HMAC-SHA1 keyed by SHA1(private key), hex — Braintree's webhook signature. */
export function braintreeWebhookDigest(privateKey: string, data: string): string {
  const key = createHash("sha1").update(privateKey, "utf8").digest();
  return createHmac("sha1", key).update(data, "utf8").digest("hex");
}

/** Sign a payload the way Braintree does: `public_key|hex`. For tests and fixtures. */
export function signBraintreePayload(publicKey: string, privateKey: string, btPayload: string) {
  return `${publicKey}|${braintreeWebhookDigest(privateKey, btPayload)}`;
}

/** Throws unless `signature` holds a pair for `publicKey` whose digest matches the payload. */
export function verifyBraintreeSignature(
  publicKey: string,
  privateKey: string,
  signature: string,
  btPayload: string,
): void {
  if (/[^A-Za-z0-9+=/\n]/.test(btPayload))
    throw new Error("Braintree webhook payload contains illegal characters");
  const pair = signature
    .split("&")
    .filter((p) => p.includes("|"))
    .map((p) => p.split("|"))
    .find(([pk]) => pk === publicKey);
  if (!pair?.[1]) throw new Error("Braintree webhook signature has no pair for this public key");
  const given = Buffer.from(pair[1], "utf8");
  const matches = [btPayload, `${btPayload}\n`].some((data) => {
    const want = Buffer.from(braintreeWebhookDigest(privateKey, data), "utf8");
    return want.length === given.length && timingSafeEqual(want, given);
  });
  if (!matches) throw new Error("Braintree webhook signature does not match the payload");
}

const DISPUTE_TYPE: Record<string, NormalizedProviderEvent["type"]> = {
  dispute_opened: "dispute.created",
  // Status moves on a case we already hold: upserted as `dispute.created`.
  dispute_under_review: "dispute.created",
  dispute_disputed: "dispute.created",
  dispute_won: "dispute.won",
  dispute_lost: "dispute.lost",
  // Accepting a dispute, or missing its deadline, loses it.
  dispute_accepted: "dispute.lost",
  dispute_auto_accepted: "dispute.lost",
  dispute_expired: "dispute.lost",
};

const RETRIEVAL_TERMINAL = new Set([
  "dispute_won",
  "dispute_lost",
  "dispute_accepted",
  "dispute_auto_accepted",
  "dispute_expired",
]);

const dateOf = (s: string | undefined) => {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/**
 * The payer cancelled a PayPal billing agreement or removed their Venmo connection, or
 * Venmo suspended the account (payment method webhooks, read 2026-10-28). A grant we hold
 * that its owner revoked is dead the same way.
 */
const REVOKED_KINDS = new Set([
  "payment_method_revoked_by_customer",
  "granted_payment_method_revoked",
]);

/** Translate one verified notification into our vocabulary. */
export function normalizeBraintreeNotification(
  n: BraintreeNotification,
  eventId: string,
  raw: unknown,
  /** Vault token → global id, for a revoked method whose payload has no `global-id`. */
  globalIds?: ReadonlyMap<string, string>,
): NormalizedProviderEvent[] {
  const occurredAt = dateOf(n.timestamp) ?? new Date();
  const base = { providerEventId: eventId, occurredAt, raw };
  const s = n.subject;
  if (REVOKED_KINDS.has(n.kind) && s) {
    const token = xmlText(s, "token");
    const id = xmlText(s, "global-id") ?? (token ? globalIds?.get(token) : undefined);
    // Without an id nothing can be matched; recorded, not acted on.
    if (!id) return [{ ...base, type: "unknown" }];
    return [{ ...base, type: "payment_method.detached", providerPaymentMethodId: id }];
  }
  const disputeType = DISPUTE_TYPE[n.kind];
  if (disputeType && s?.name === "dispute") {
    const currency = xmlText(s, "currency-iso-code")?.toUpperCase();
    const amount = xmlText(s, "amount-disputed") ?? xmlText(s, "amount");
    const ev: NormalizedProviderEvent = {
      ...base,
      type: disputeType,
      providerDisputeId: xmlText(s, "id"),
      providerChargeId: xmlText(s, "transaction", "id"),
      disputeReason: xmlText(s, "reason") ?? null,
      disputeStatus: xmlText(s, "status") ?? null,
      ...(amount && currency ? { disputeAmountMinor: decimalToMinor(amount, currency) } : {}),
      disputeCurrency: currency ?? null,
      evidenceDueBy: dateOf(xmlText(s, "reply-by-date")) ?? null,
      ownership: "unknown",
    };
    const kind = xmlText(s, "kind");
    // A retrieval never moves money, so however it ends it books no loss.
    if (kind === "retrieval" && RETRIEVAL_TERMINAL.has(n.kind))
      return [{ ...ev, type: "dispute.closed" }];
    const won = xmlText(s, "amount-won");
    if (disputeType === "dispute.won" && won && currency)
      ev.disputeAmountWonMinor = decimalToMinor(won, currency);
    // A chargeback or pre-arbitration takes the money when it opens; a retrieval does not.
    if (n.kind === "dispute_opened" && (kind === "chargeback" || kind === "pre_arbitration"))
      return [ev, { ...ev, type: "dispute.funds_withdrawn" }];
    return [ev];
  }
  if (s?.name === "transaction") {
    const id = xmlText(s, "id");
    const refund = xmlText(s, "type") === "credit" || xmlText(s, "refunded-transaction-id");
    const own = {
      ...ownershipOf(xmlText(s, "order-id"), xmlChild(s, "order-id") != null),
      ...(dateOf(xmlText(s, "created-at"))
        ? { providerObjectCreatedAt: dateOf(xmlText(s, "created-at"))! }
        : {}),
    };
    if (n.kind === "refund_failed" || (refund && n.kind === "transaction_settlement_declined"))
      return [{ ...base, ...own, type: "refund.failed", providerRefundId: id }];
    // A settled credit: the refund landed. It may be one made in the Control Panel.
    const sale = xmlText(s, "refunded-transaction-id");
    if (n.kind === "transaction_settled" && refund && id && sale) {
      const amount = xmlText(s, "amount");
      const currency = xmlText(s, "currency-iso-code")?.toUpperCase();
      return [
        {
          ...base,
          type: "charge.refunded",
          providerChargeId: sale,
          ownership: "unknown",
          refunds:
            amount && currency
              ? [
                  {
                    providerRefundId: id,
                    amountMinor: decimalToMinor(amount, currency),
                    status: "succeeded",
                    ...(own.ownershipRef ? { ownershipRef: own.ownershipRef } : {}),
                  },
                ]
              : [],
        },
      ];
    }
    if (n.kind === "transaction_settled" && !refund) {
      const amount = xmlText(s, "amount");
      const currency = xmlText(s, "currency-iso-code")?.toUpperCase();
      return [
        {
          ...base,
          ...own,
          type: "charge.succeeded",
          providerChargeId: id,
          ...(amount && currency ? { capturedAmountMinor: decimalToMinor(amount, currency) } : {}),
        },
      ];
    }
    if (n.kind === "transaction_settlement_declined") {
      const code = xmlText(s, "processor-settlement-response-code");
      const message = xmlText(s, "processor-settlement-response-text");
      const f = normalizeBraintreeDecline({ code, message, category: "SETTLEMENT_DECLINED" });
      return [
        {
          ...base,
          ...own,
          type: "charge.failed",
          providerChargeId: id,
          // Settlement can be declined after the sale was booked as collected.
          lateReversal: true,
          failureCode: f.code,
          failureRetriable: f.retriable,
          ...(code ? { providerFailureCode: code } : {}),
          ...((f.message ?? message) ? { failureMessage: f.message ?? message } : {}),
        },
      ];
    }
  }
  if (n.kind === "transaction_reviewed" && s)
    return [{ ...base, type: "review.closed", providerChargeId: xmlText(s, "transaction-id") }];
  // `check`, disbursements, Braintree subscriptions (never used) and anything newer.
  return [{ ...base, type: "unknown" }];
}

/**
 * A refund found by the settlement poll, on a sale of ours, as the webhook path books one:
 * `charge.refunded` on the sale with the refund's own record. The id is stable per refund and
 * status; the engine books by refund id, so a webhook for the same refund is not booked twice.
 */
export function braintreePolledRefund(r: BtRefundNode): NormalizedProviderEvent[] {
  const sale = r.refundedTransaction;
  if (!sale?.legacyId || ownershipOf(sale.orderId, true).ownership !== "ours") return [];
  const value = r.amount?.value;
  const cur = r.amount?.currencyCode?.toUpperCase();
  const status = refundStatusOf(r.status);
  if (!value || !cur || status === "pending") return [];
  const own = ownershipOf(r.orderId, true);
  return [
    {
      providerEventId: `bt_poll_refund_${r.legacyId}_${r.status}`,
      occurredAt: dateOf(r.createdAt ?? undefined) ?? new Date(),
      raw: r,
      type: "charge.refunded",
      providerChargeId: sale.legacyId,
      ownership: "ours",
      refunds: [
        {
          providerRefundId: r.legacyId,
          amountMinor: decimalToMinor(value, cur),
          status,
          ...(own.ownershipRef ? { ownershipRef: own.ownershipRef } : {}),
        },
      ],
    },
  ];
}

/** A sale of ours declined at settlement, found by the poll: a late reversal, as the webhook. */
export function braintreePolledSettlementDecline(tx: BtTransaction): NormalizedProviderEvent[] {
  if (tx.status !== "SETTLEMENT_DECLINED") return [];
  const own = ownershipOf(tx.orderId, true);
  if (own.ownership !== "ours") return [];
  const f = failureOf(tx);
  return [
    {
      providerEventId: `bt_poll_sale_${tx.legacyId}_SETTLEMENT_DECLINED`,
      occurredAt: new Date(),
      raw: tx,
      ...own,
      ...(dateOf(tx.createdAt ?? undefined)
        ? { providerObjectCreatedAt: dateOf(tx.createdAt ?? undefined)! }
        : {}),
      type: "charge.failed",
      providerChargeId: tx.legacyId,
      lateReversal: true,
      failureCode: f.code,
      failureRetriable: f.retriable,
      ...(f.providerCode ? { providerFailureCode: f.providerCode } : {}),
      failureMessage: f.message,
    },
  ];
}

// ── Account updater ─────────────────────────────────────────────────────────

/** "Min: 1 Max: 50 IDs" (schema, `idsFromLegacyIds`). */
const ID_BATCH = 50;
/** The update types that change a vaulted card (account updater guide, read 2026-10-28). */
const CARD_CHANGED = new Set(["new account number", "new expiry date"]);

/** RFC 4180 rows: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/**
 * Tokens of the cards the daily report says changed. The webhook report names the event
 * in `update_type`; the token column is the one whose header names a token.
 */
export function changedCardTokens(csv: string): string[] {
  const [header, ...rows] = parseCsv(csv.replace(/^\uFEFF/, ""));
  if (!header) return [];
  const names = header.map((h) => h.trim().toLowerCase());
  const type = names.indexOf("update_type");
  const token = names.findIndex((h) => /token/.test(h));
  if (type < 0 || token < 0)
    throw new Error(
      `Braintree account updater report has no update_type or token column (${names.join(", ")})`,
    );
  const out = new Set<string>();
  for (const r of rows) {
    const t = r[token]?.trim();
    if (t && CARD_CHANGED.has((r[type] ?? "").trim().toLowerCase())) out.add(t);
  }
  return [...out];
}

// ── The adapter ─────────────────────────────────────────────────────────────

export interface BraintreeOptions {
  merchantId: string;
  publicKey: string;
  privateKey: string;
  livemode: boolean;
  /** See `parseMerchantAccounts`. */
  merchantAccounts?: string;
}

export class BraintreeProvider implements PaymentProvider {
  readonly key = "braintree" as const;
  readonly capabilities: ProviderCapabilities;
  private readonly url: string;
  private readonly auth: string;
  private readonly accounts: MerchantAccountMap;

  constructor(private readonly opts: BraintreeOptions) {
    this.url = opts.livemode ? BRAINTREE_LIVE_URL : BRAINTREE_SANDBOX_URL;
    this.auth = `Basic ${Buffer.from(`${opts.publicKey}:${opts.privateKey}`).toString("base64")}`;
    this.accounts = parseMerchantAccounts(opts.merchantAccounts);
    this.capabilities = {
      refunds: true,
      // Partial refunds need a settled sale; before settlement only a full void is possible.
      partialRefunds: true,
      // One currency per merchant account. Never "any": the default account would charge a
      // EUR amount as USD.
      currencies: [...this.accounts.keys()],
      // Venmo is US-only (USD): the catalogue binds it to USD.
      methods: [...BRAINTREE_METHODS],
      intents: true,
      intentPurposes: ["payment", "setup"],
      // An authorization is voided without moving money.
      intentVoid: true,
      // No per-debit ceiling on a vaulted card.
      mandates: false,
      // Transaction webhooks cover ACH and SEPA only, so a card refund made in the Control
      // Panel, or a card sale declined at settlement, is found by search. Three searches
      // per hour, one page each in the common case.
      settlementReport: { intervalMinutes: 60, maxWindowHours: 24 },
    };
  }

  // ── transport ──

  /** One POST. Throws only for refused keys; everything else is classified by the caller. */
  private async post<T>(
    operation: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<PostResult<T>> {
    const res = await providerFetch({
      gatewayKey: this.key,
      operation,
      method: "POST",
      url: this.url,
      headers: {
        Authorization: this.auth,
        "Braintree-Version": BRAINTREE_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    // Before the parse: a 401 or 403 body need not be JSON.
    if (res.status === 401 || res.status === 403)
      throw new Error(`Braintree refused the API keys (HTTP ${res.status}) on ${operation}`);
    let body: GqlBody<T> | null;
    try {
      body = JSON.parse(res.text);
    } catch {
      body = null;
    }
    return { status: res.status, retryAfter: res.headers.get("retry-after"), body };
  }

  private async gql<T>(
    operation: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<{ data: T | null; errors: GqlError[] }> {
    const res = await this.post<T>(operation, query, variables);
    const cls = classifyGatewayHttp({ status: res.status });
    if (!res.body || cls.kind === "retry_same_key")
      throw new ProviderIndeterminateError(
        `Braintree answered ${operation} with HTTP ${res.status}. We could not confirm the outcome.`,
      );
    return { data: res.body.data ?? null, errors: res.body.errors ?? [] };
  }

  /**
   * A money mutation. Braintree answers HTTP 200 with an `errorClass`, so each class is read
   * as its HTTP twin: INTERNAL and SERVICE_AVAILABILITY leave the outcome uncertain (5xx),
   * a request still in flight is a 409, RESOURCE_LIMIT is a 429 that created nothing. Those
   * are replayed with the same `apiRequestKey`, which answers the original transaction.
   * An idempotency conflict stamps the transaction it names and throws.
   */
  private async mutate<T>(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ data: T | null; error?: BraintreeApiError }> {
    const keyed =
      typeof (variables.input as { apiRequestKey?: unknown })?.apiRequestKey === "string";
    for (let attempt = 0; ; attempt++) {
      let res: PostResult<T> | null = null;
      try {
        res = await this.post<T>(operation, query, variables);
      } catch (e) {
        if (e instanceof Error && /^Braintree refused the API keys/.test(e.message)) throw e;
      }
      const errors = res?.body?.errors ?? [];
      const ext = errors[0]?.extensions;
      const cls = classifyGatewayHttp({
        status: !res ? null : !res.body && res.status < 400 ? 502 : httpTwin(res.status, ext),
        networkError: !res,
        retryAfter: res?.retryAfter ?? null,
        rateLimitCreatesNothing: true,
      });
      if (cls.kind === "retry_same_key") {
        if (keyed && attempt < MUTATION_REPLAYS) {
          await sleep(cls.retryAfterMs ?? REPLAY_BACKOFF_MS * 2 ** attempt);
          continue;
        }
        if (cls.whenExhausted === "indeterminate")
          throw new ProviderIndeterminateError(
            cls.reason === "conflict"
              ? `Braintree is still processing an earlier ${operation} request for this payment. Retry later.`
              : `We could not confirm whether Braintree completed ${operation}. Retry later.`,
          );
      }
      if (!res?.body)
        throw new ProviderIndeterminateError(
          `We could not read Braintree's answer to ${operation} (HTTP ${res?.status ?? "none"}).`,
        );
      if (errors.length === 0) return { data: res.body.data ?? null };
      const error = new BraintreeApiError(operation, errors);
      if (ext?.atMostOnceProcessing)
        throw markStrandedObject(
          error,
          ext.atMostOnceProcessing.legacyId ?? ext.atMostOnceProcessing.id ?? null,
        );
      if (ext?.errorClass === "AUTHENTICATION" || ext?.errorClass === "AUTHORIZATION") throw error;
      return { data: res.body.data ?? null, error };
    }
  }

  private async query<T>(
    operation: string,
    q: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const { data, errors } = await this.gql<T>(operation, q, variables);
    if (errors.length && !data) throw new BraintreeApiError(operation, errors);
    return data as T;
  }

  private merchantAccountFor(currency: string): string | null {
    const c = currency.toUpperCase();
    if (!this.accounts.has(c))
      throw new ProviderRefusalError(
        `This Braintree account has no merchant account for ${c}. Add one under "Currencies and merchant accounts", or use a gateway that accepts ${c}.`,
      );
    return this.accounts.get(c) ?? null;
  }

  /** A capture or void with no object back: refused when nothing was made, else unknown. */
  private unsettledMutation(operation: string, error: BraintreeApiError | undefined): Error {
    if (isDefiniteRefusal(error))
      return new ProviderRefusalError(
        `Braintree refused ${operation}: ${error!.first?.message ?? error!.message}`,
      );
    return new ProviderIndeterminateError(
      `Braintree answered ${operation} with nothing${error ? ` (${error.message})` : ""}. We could not confirm the outcome.`,
    );
  }

  /** A failure the decline rules recognise, or undefined (then the caller throws). */
  private classifiedApiFailure(err: BraintreeApiError): ChargeResult["failure"] | undefined {
    const code = err.signalCode;
    const f = normalizeBraintreeDecline({ code, message: err.first?.message ?? null });
    if (!f.ruleId) return undefined;
    return {
      code: f.code,
      ...(code ? { providerCode: code } : {}),
      message: f.message ?? err.first?.message ?? err.message,
      retriable: f.retriable,
      ruleId: f.ruleId,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const data = await this.query<{ ping: string }>("ping", "query { ping }");
    return { ok: data.ping === "pong", detail: `merchant=${this.opts.merchantId}` };
  }

  // ── customers ──

  private customerInput(input: EnsureCustomerInput) {
    const [first, ...rest] = (input.name ?? "").trim().split(/\s+/);
    return {
      ...(input.email ? { email: input.email } : {}),
      ...(first ? { firstName: first } : {}),
      ...(rest.length ? { lastName: rest.join(" ") } : {}),
      ...(input.phone ? { phoneNumber: input.phone } : {}),
    };
  }

  async ensureCustomer(input: EnsureCustomerInput): Promise<ProviderCustomerRef> {
    const data = await this.query<{ createCustomer: { customer: { id: string } } }>(
      "create_customer",
      `mutation($input: CreateCustomerInput!) { createCustomer(input: $input) { customer { id } } }`,
      { input: { customer: this.customerInput(input) } },
    );
    return { providerKey: this.key, providerCustomerId: data.createCustomer.customer.id };
  }

  async updateCustomer(ref: ProviderCustomerRef, input: EnsureCustomerInput): Promise<void> {
    await this.query(
      "update_customer",
      `mutation($input: UpdateCustomerInput!) { updateCustomer(input: $input) { customer { id } } }`,
      { input: { customerId: ref.providerCustomerId, customer: this.customerInput(input) } },
    );
  }

  // ── vault ──

  private async vaultNonce(
    nonce: string,
    customerId: string | undefined,
    merchantAccountId: string | null | undefined,
    allowed: string[] = ["card"],
  ): Promise<{ ref?: ProviderPaymentMethodRef; failure?: NonNullable<ChargeResult["failure"]> }> {
    const { data, error } = await this.mutate<{
      vaultPaymentMethod: {
        paymentMethod: BtPaymentMethod | null;
        verification: {
          status?: string;
          gatewayRejectionReason?: string | null;
          processorResponse?: BtProcessorResponse | null;
        } | null;
      } | null;
    }>(
      "vault_payment_method",
      `mutation($input: VaultPaymentMethodInput!) { vaultPaymentMethod(input: $input) {
        paymentMethod { ${PM_FIELDS} }
        verification { status gatewayRejectionReason
          processorResponse { legacyCode message cvvResponse avsPostalCodeResponse avsStreetAddressResponse } } } }`,
      {
        input: {
          paymentMethodId: nonce,
          ...(customerId ? { customerId } : {}),
          // Verify before saving: a card that cannot be charged is not saved. PayPal and
          // Venmo accounts take no verification; Braintree skips it for them.
          verification: merchantAccountId ? { merchantAccountId } : {},
        },
      },
    );
    const v = data?.vaultPaymentMethod?.verification;
    const pm = data?.vaultPaymentMethod?.paymentMethod;
    // The nonce is browser input and can be any type: keep only what this intent offered.
    if (pm && !allowed.includes(BT_VAULT_METHOD[pm.details?.__typename ?? ""] ?? "")) {
      await this.removeVaulted(pm.id);
      return { failure: notOffered(allowed) };
    }
    if (pm && (!v?.status || v.status === "VERIFIED"))
      return {
        ref: {
          providerKey: this.key,
          providerPaymentMethodId: pm.id,
          ...(pm.customer?.id ? { providerCustomerId: pm.customer.id } : {}),
          display: describeBraintreePaymentMethod(pm, v),
        },
      };
    if (v?.status) {
      const tx: BtTransaction = {
        id: "",
        legacyId: "",
        status: v.status === "GATEWAY_REJECTED" ? "GATEWAY_REJECTED" : "PROCESSOR_DECLINED",
        processorAuthorizationResponse: v.processorResponse ?? null,
        statusHistory: [
          {
            status: v.status === "GATEWAY_REJECTED" ? "GATEWAY_REJECTED" : "PROCESSOR_DECLINED",
            gatewayRejectionReason: v.gatewayRejectionReason ?? null,
            processorResponse: v.processorResponse ?? null,
          },
        ],
      };
      return { failure: failureOf(tx) };
    }
    if (error) {
      const failure = this.classifiedApiFailure(error);
      if (failure) return { failure };
      throw error;
    }
    throw new Error("Braintree vaultPaymentMethod returned no payment method");
  }

  /** Best effort: a vaulted method we refused must not stay on the customer. */
  private async removeVaulted(paymentMethodId: string) {
    await this.gql(
      "delete_payment_method",
      `mutation($input: DeletePaymentMethodFromVaultInput!) { deletePaymentMethodFromVault(input: $input) { clientMutationId } }`,
      { input: { paymentMethodId } },
    ).catch((e) =>
      log.warn("could not remove a refused payment method from the vault", { error: String(e) }),
    );
  }

  async vaultPaymentMethod(input: VaultPaymentMethodInput): Promise<ProviderPaymentMethodRef> {
    const allowed = [...this.capabilities.methods];
    const refused = await this.checkNonce(input.token, allowed);
    const out = refused
      ? { failure: refused }
      : await this.vaultNonce(
          input.token,
          input.customer.providerCustomerId,
          [...this.accounts.values()][0],
          allowed,
        );
    if (out.ref) return out.ref;
    throw new ProviderRefusalError(
      `We could not save this payment method. ${out.failure!.message}`,
    );
  }

  /**
   * Read a nonce before it is used: its type must be one this intent offered, and a card
   * that went through 3D Secure must pass our policy (`braintreeThreeDSecureFailure`).
   * No answer about the nonce (an unknown one) leaves the decision to the vault or the
   * authorization, which refuse it themselves.
   */
  private async checkNonce(
    nonce: string,
    allowed: string[],
  ): Promise<NonNullable<ChargeResult["failure"]> | undefined> {
    type Read = {
      node: {
        details?: {
          __typename?: string;
          threeDSecure?: { authentication?: BtThreeDSecure | null } | null;
        } | null;
      } | null;
    };
    let data: Read | null;
    try {
      ({ data } = await this.gql<Read>(
        "read_nonce",
        `query($id: ID!) { node(id: $id) { ... on PaymentMethod { details { __typename
          ... on CreditCardDetails { threeDSecure { authentication {
            liabilityShifted liabilityShiftPossible authenticationStatus } } } } } } }`,
        { id: nonce },
      ));
    } catch (e) {
      log.warn("could not read a nonce before using it", { error: String(e) });
      return NOT_CHECKED;
    }
    const d = data?.node?.details;
    if (!d?.__typename) return undefined;
    if (!allowed.includes(BT_VAULT_METHOD[d.__typename] ?? "")) return notOffered(allowed);
    return braintreeThreeDSecureFailure(d.threeDSecure?.authentication) ?? undefined;
  }

  async fetchPaymentMethodDisplay(input: {
    providerPaymentMethodId: string;
  }): Promise<ProviderPaymentMethodRef["display"] | null> {
    const pm = await this.readPaymentMethod(input.providerPaymentMethodId);
    return pm ? describeBraintreePaymentMethod(pm) : null;
  }

  private async readPaymentMethod(id: string): Promise<BtPaymentMethod | null> {
    const { data } = await this.gql<{ node: BtPaymentMethod | null }>(
      "read_payment_method",
      `query($id: ID!) { node(id: $id) { ... on PaymentMethod { ${PM_FIELDS} } } }`,
      { id },
    );
    return data?.node?.id ? data.node : null;
  }

  async deletePaymentMethod(input: {
    customer: ProviderCustomerRef;
    paymentMethod: ProviderPaymentMethodRef;
  }): Promise<void> {
    const { errors } = await this.gql(
      "delete_payment_method",
      `mutation($input: DeletePaymentMethodFromVaultInput!) { deletePaymentMethodFromVault(input: $input) { clientMutationId } }`,
      { input: { paymentMethodId: input.paymentMethod.providerPaymentMethodId } },
    );
    const err = errors[0];
    if (!err) return;
    if (err.extensions?.errorClass === "NOT_FOUND") {
      log.info("gateway delete skipped — the card was already gone at Braintree", {
        event: "braintree_delete_already_gone",
      });
      return;
    }
    throw new BraintreeApiError("delete_payment_method", errors);
  }

  // ── money ──

  private transactionInput(p: {
    amountMinor: bigint;
    currency: string;
    ref: string;
    initiator?: BraintreePaymentInitiator;
  }) {
    const account = this.merchantAccountFor(p.currency);
    return {
      amount: minorToDecimalString(p.amountMinor, p.currency.toUpperCase()),
      ...(account ? { merchantAccountId: account } : {}),
      orderId: ownershipOrderId(p.ref),
      ...(p.initiator ? { paymentInitiator: p.initiator } : {}),
    };
  }

  private async transact(
    operation: "charge_payment_method" | "authorize_payment_method",
    paymentMethodId: string,
    transaction: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<ChargeResult> {
    const field =
      operation === "charge_payment_method" ? "chargePaymentMethod" : "authorizePaymentMethod";
    const inputType =
      operation === "charge_payment_method"
        ? "ChargePaymentMethodInput"
        : "AuthorizePaymentMethodInput";
    const { data, error } = await this.mutate<
      Record<string, { transaction: BtTransaction | null }>
    >(
      operation,
      `mutation($input: ${inputType}!) { ${field}(input: $input) { transaction { ${TX_FIELDS} } } }`,
      {
        input: {
          apiRequestKey: boundedProviderKey(idempotencyKey, REQUEST_KEY_MAX),
          paymentMethodId,
          transaction,
        },
      },
    );
    const tx = data?.[field]?.transaction;
    if (tx)
      return chargeResultFromTransaction(tx, {
        authorization: operation === "authorize_payment_method",
      });
    if (error) {
      const failure = this.classifiedApiFailure(error) ?? unclassifiedApiFailure(error);
      if (failure) {
        const made = await this.refusedTransactionId(transaction, error);
        return { status: "failed", providerChargeId: made ?? "", failure, raw: error.errors };
      }
    }
    // No transaction and no class we know created nothing: the outcome is unknown.
    throw new ProviderIndeterminateError(
      `Braintree answered ${operation} with no transaction${error ? ` (${error.message})` : ""}.`,
    );
  }

  /**
   * A processor response code (2000–3999) on an error means Braintree made a transaction and
   * refused it, but the answer did not carry it. Find it by our `orderId`, so the refusal keeps
   * the gateway's id. Best effort: null when the search fails or finds nothing refused.
   */
  private async refusedTransactionId(
    transaction: Record<string, unknown>,
    error: BraintreeApiError,
  ): Promise<string | null> {
    const code = error.first?.extensions?.legacyCode ?? "";
    const orderId = transaction.orderId;
    if (!/^[23]\d{3}$/.test(code) || typeof orderId !== "string") return null;
    try {
      const data = await this.query<{
        search: { transactions: { edges: { node: BtTransaction | null }[] | null } | null } | null;
      }>(
        "search_refused_transaction",
        `query($input: TransactionSearchInput!) { search { transactions(input: $input, first: 10) {
          edges { node { ${TX_FIELDS} } } } } }`,
        {
          input: {
            orderId: { is: orderId },
            createdAt: {
              greaterThanOrEqualTo: new Date(Date.now() - REFUSED_LOOKUP_MS).toISOString(),
            },
          },
        },
      );
      const refused = (data.search?.transactions?.edges ?? [])
        .map((e) => e.node)
        .filter((t): t is BtTransaction => !!t?.legacyId && REFUSED.has(t.status ?? ""))
        .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
      return refused[0]?.legacyId ?? null;
    } catch {
      return null;
    }
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    return this.transact(
      "charge_payment_method",
      input.paymentMethod.providerPaymentMethodId,
      this.transactionInput({
        amountMinor: input.amountMinor,
        currency: input.currency,
        ref: input.ownershipRef ?? input.idempotencyKey,
        initiator: braintreePaymentInitiator(input.initiator),
      }),
      input.idempotencyKey,
    );
  }

  private async readTransaction(legacyId: string): Promise<BtTransaction | null> {
    const data = await this.query<{ node: BtTransaction | null }>(
      "read_transaction",
      `query($id: ID!) { node(id: $id) { ... on Transaction { ${TX_FIELDS} } } }`,
      { id: transactionGlobalId(legacyId) },
    );
    return data.node?.id ? data.node : null;
  }

  async fetchChargeStatus(input: { providerChargeId: string }): Promise<ChargeResult> {
    const tx = await this.readTransaction(input.providerChargeId);
    if (!tx) return { status: "pending", providerChargeId: input.providerChargeId };
    // AUTHORIZED on the charge path is a sale Braintree has not yet submitted: still pending.
    return chargeResultFromTransaction(tx);
  }

  /** Sales carrying our `orderId`, by search. Read-only: never replays the charge. */
  async locateCharge(input: {
    ownershipRef: string;
    idempotencyKey: string;
    amountMinor: bigint;
    currency: string;
    createdAfter: Date;
  }): Promise<ChargeResult | null> {
    const data = await this.query<{
      search: { transactions: { edges: { node: BtTransaction | null }[] | null } | null } | null;
    }>(
      "search_transactions",
      `query($input: TransactionSearchInput!) { search { transactions(input: $input, first: 50) {
        edges { node { ${TX_FIELDS} } } } } }`,
      {
        input: {
          orderId: { is: ownershipOrderId(input.ownershipRef) },
          createdAt: { greaterThanOrEqualTo: input.createdAfter.toISOString() },
        },
      },
    );
    const found = (data.search?.transactions?.edges ?? [])
      .map((e) => e.node)
      .filter((t): t is BtTransaction => !!t?.legacyId);
    if (!found.length) return null;
    // A captured sale wins over a refused one (a duplicate-check rejection of a retry).
    const rank = (t: BtTransaction) =>
      CAPTURED.has(t.status ?? "") ? 0 : REFUSED.has(t.status ?? "") ? 2 : 1;
    found.sort((a, b) => rank(a) - rank(b));
    return chargeResultFromTransaction(found[0]!);
  }

  /**
   * The settlement poll's read. Refunds created in the window (a Control Panel refund sends
   * no webhook), refunds that failed and sales of ours declined at settlement in the last
   * {@link LATE_STATUS_LOOKBACK_MS}. Only what touches a sale of ours becomes an event.
   */
  async pollSettlements(input: { since: Date; until: Date }): Promise<NormalizedProviderEvent[]> {
    const until = input.until.toISOString();
    const lookback = new Date(input.since.getTime() - LATE_STATUS_LOOKBACK_MS).toISOString();
    const out: NormalizedProviderEvent[] = [];
    for await (const r of this.searchAll<BtRefundNode>("settlement_refunds", "refunds", {
      createdAt: { greaterThanOrEqualTo: input.since.toISOString(), lessThanOrEqualTo: until },
    }))
      out.push(...braintreePolledRefund(r));
    for await (const r of this.searchAll<BtRefundNode>("settlement_failed_refunds", "refunds", {
      status: { in: [...REFUSED] },
      createdAt: { greaterThanOrEqualTo: lookback, lessThanOrEqualTo: until },
    }))
      out.push(...braintreePolledRefund(r));
    for await (const t of this.searchAll<BtTransaction>(
      "settlement_declined_sales",
      "transactions",
      {
        status: { is: "SETTLEMENT_DECLINED" },
        orderId: { startsWith: BRAINTREE_OWNERSHIP_PREFIX },
        createdAt: { greaterThanOrEqualTo: lookback, lessThanOrEqualTo: until },
      },
    ))
      out.push(...braintreePolledSettlementDecline(t));
    return out;
  }

  /** Every page of one search. Past {@link SEARCH_MAX_PAGES} it throws: a cut list is not "none". */
  private async *searchAll<T>(
    operation: string,
    field: "refunds" | "transactions",
    input: Record<string, unknown>,
  ): AsyncGenerator<T> {
    const type = field === "refunds" ? "RefundSearchInput" : "TransactionSearchInput";
    const fields = field === "refunds" ? REFUND_FIELDS : TX_FIELDS;
    let after: string | null = null;
    for (let page = 0; page < SEARCH_MAX_PAGES; page++) {
      type Conn = {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
        edges?: { node: T | null }[] | null;
      };
      const data: { search: Record<string, Conn | null> | null } = await this.query(
        operation,
        `query($input: ${type}!, $after: String) { search { ${field}(input: $input, first: ${SEARCH_PAGE}, after: $after) {
          pageInfo { hasNextPage endCursor } edges { node { ${fields} } } } } }`,
        { input, after },
      );
      const conn = data.search?.[field];
      for (const e of conn?.edges ?? []) if (e.node) yield e.node;
      if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) return;
      after = conn.pageInfo.endCursor;
    }
    throw new Error(`Braintree ${operation}: more than ${SEARCH_MAX_PAGES * SEARCH_PAGE} results`);
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const transactionId = transactionGlobalId(input.providerChargeId);
    const apiRequestKey = boundedProviderKey(input.idempotencyKey, REQUEST_KEY_MAX);
    // Full: a void before settlement, a refund after. Braintree decides.
    if (input.amountMinor == null) return this.reverse(transactionId, apiRequestKey);
    if (!input.currency)
      throw new Error("A partial Braintree refund needs the charge currency to format the amount");
    const { data, error } = await this.mutate<{
      refundTransaction: {
        refund: { id: string; legacyId: string; status?: string } | null;
      } | null;
    }>(
      "refund_transaction",
      `mutation($input: RefundTransactionInput!) { refundTransaction(input: $input) { refund { id legacyId status } } }`,
      {
        input: {
          apiRequestKey,
          transactionId,
          refund: {
            amount: minorToDecimalString(input.amountMinor, input.currency.toUpperCase()),
            orderId: ownershipOrderId(input.ownershipRef ?? input.idempotencyKey),
          },
        },
      },
    );
    const r = data?.refundTransaction?.refund;
    if (r) return { status: refundStatusOf(r.status), providerRefundId: r.legacyId, raw: r };
    if (error?.first?.extensions?.inputPath?.at(-1) === "transactionId") {
      // The engine always sends an amount. The whole amount of an unsettled sale is a void.
      const tx = await this.readTransaction(input.providerChargeId).catch(() => null);
      const whole = minorToDecimalString(input.amountMinor, input.currency.toUpperCase());
      if (tx?.amount?.value != null && Number(tx.amount.value) === Number(whole))
        return this.reverse(
          transactionId,
          boundedProviderKey(`${input.idempotencyKey}:void`, REQUEST_KEY_MAX),
        );
      throw new ProviderRefusalError(
        `Braintree cannot refund part of this payment yet: ${error.first.message} Refund the full amount, or wait until the payment settles (usually within one day).`,
      );
    }
    if (isDefiniteRefusal(error))
      throw new ProviderRefusalError(
        await this.refundRefusalMessage(input.providerChargeId, error!),
      );
    throw new ProviderIndeterminateError(
      `Braintree answered refund_transaction with no refund${error ? ` (${error.message})` : ""}. We could not confirm the outcome.`,
    );
  }

  /** 91521 / 91512 usually mean a Control Panel refund took the money: say how much is left. */
  private async refundRefusalMessage(saleLegacyId: string, error: BraintreeApiError) {
    const generic = `We could not refund this payment. Braintree refused it: ${error.first?.message ?? error.message}`;
    if (!["91521", "91512"].includes(error.first?.extensions?.legacyCode ?? "")) return generic;
    const sale = await this.readSaleRefunds(saleLegacyId).catch(() => null);
    const cur = sale?.amount?.currencyCode;
    if (!sale?.amount?.value || !cur) return generic;
    const refunded = (sale.refunds ?? [])
      .filter((r) => refundStatusOf(r.status) !== "failed" && r.amount?.value)
      .reduce((n, r) => n + decimalToMinor(r.amount!.value!, cur), 0n);
    const left = decimalToMinor(sale.amount.value, cur) - refunded;
    const fmt = (m: bigint) => `${minorToDecimalString(m > 0n ? m : 0n, cur)} ${cur}`;
    return `We could not refund this amount. Braintree shows ${fmt(refunded)} already refunded on this payment, so ${fmt(left)} is left. Refund ${fmt(left)} or less.`;
  }

  /** The sale and every refund Braintree holds against it (the Control Panel's too). */
  private async readSaleRefunds(saleLegacyId: string): Promise<BtSaleRefunds | null> {
    const data = await this.query<{ node: BtSaleRefunds | null }>(
      "read_transaction_refunds",
      `query($id: ID!) { node(id: $id) { ... on Transaction { legacyId amount { value currencyCode }
        refunds { legacyId status orderId amount { value currencyCode } } } } }`,
      { id: transactionGlobalId(saleLegacyId) },
    );
    return data.node?.legacyId ? data.node : null;
  }

  private async reverse(transactionId: string, apiRequestKey: string): Promise<RefundResult> {
    const { data, error } = await this.mutate<{
      reverseTransaction: {
        reversal: { __typename: string; id: string; legacyId: string; status?: string } | null;
      } | null;
    }>(
      "reverse_transaction",
      `mutation($input: ReverseTransactionInput!) { reverseTransaction(input: $input) {
        reversal { __typename ... on Transaction { id legacyId status } ... on Refund { id legacyId status } } } }`,
      { input: { apiRequestKey, transactionId } },
    );
    const r = data?.reverseTransaction?.reversal;
    if (r)
      return {
        status: refundStatusOf(r.status, r.__typename === "Transaction" ? "sale" : "refund"),
        providerRefundId: r.legacyId,
        raw: r,
      };
    // 91504 / 91574: a sale Braintree can neither void nor refund in its current status.
    if (isDefiniteRefusal(error))
      throw new ProviderRefusalError(
        `We could not refund this payment. Braintree refused it: ${error!.first?.message ?? error!.message}`,
      );
    throw new ProviderIndeterminateError(
      `Braintree answered reverse_transaction with no reversal${error ? ` (${error.message})` : ""}. We could not confirm the outcome.`,
    );
  }

  async fetchRefundStatus(input: { providerRefundId: string }): Promise<RefundResult> {
    const id = input.providerRefundId;
    const data = await this.query<{ node: { id?: string; status?: string } | null }>(
      "read_refund",
      `query($id: ID!) { node(id: $id) { ... on Refund { id status } } }`,
      { id: refundGlobalId(id) },
    ).catch(() => ({ node: null }));
    if (data.node?.id) return { status: refundStatusOf(data.node.status), providerRefundId: id };
    // A full refund before settlement is a void of the sale itself.
    const tx = await this.readTransaction(id);
    if (tx?.status === "VOIDED")
      return { status: refundStatusOf("VOIDED", "sale"), providerRefundId: id };
    return { status: "pending", providerRefundId: id };
  }

  // ── intents ──

  private async clientToken(merchantAccountId: string | null): Promise<string> {
    // No customer id: Drop-in would then vault cards itself, past our verification.
    const data = await this.query<{ createClientToken: { clientToken: string } }>(
      "create_client_token",
      `mutation($input: CreateClientTokenInput!) { createClientToken(input: $input) { clientToken } }`,
      { input: { clientToken: merchantAccountId ? { merchantAccountId } : {} } },
    );
    return data.createClientToken.clientToken;
  }

  private sdkChallenge(
    clientToken: string,
    purpose: IntentPurpose,
    methods: string[],
    contact: ProviderContact | undefined,
    amount?: { amountMinor: bigint; currency: string },
    currency?: string,
  ): BuyerAuthorization {
    return {
      mode: "sdk",
      sdk: {
        provider: this.key,
        params: {
          clientToken,
          purpose,
          // What Drop-in shows. A card also runs 3D Secure when the merchant has it on.
          methods,
          // 3D Secure 2 sends these to the issuer; they help a frictionless approval.
          ...(contact?.email ? { email: contact.email } : {}),
          ...(contact?.country ? { billingCountry: contact.country } : {}),
          // 3D Secure needs an amount; a saved card is checked at zero.
          ...(purpose === "setup" && currency
            ? { amount: minorToDecimalString(0n, currency), currency }
            : {}),
          ...(amount
            ? {
                amount: minorToDecimalString(amount.amountMinor, amount.currency.toUpperCase()),
                currency: amount.currency.toUpperCase(),
              }
            : {}),
        },
      },
    };
  }

  async initiateVaultSetup(input: InitiateVaultSetupInput): Promise<VaultSetupRef> {
    const currency = (input.currency ?? [...this.accounts.keys()][0]!).toUpperCase();
    const m = this.merchantAccountFor(currency);
    const methods = braintreeOfferedMethods(input.methodTypes);
    const setupTokenId = encodeSyntheticIntent({
      p: "setup",
      c: input.customer.providerCustomerId,
      ...(m ? { m } : {}),
      cur: currency,
      ...(input.ownershipRef ? { r: input.ownershipRef } : {}),
      k: createHash("sha256")
        .update(input.ownershipRef ?? input.returnUrl)
        .digest("hex")
        .slice(0, 12),
      t: methods,
    });
    return {
      setupTokenId,
      ...this.sdkChallenge(
        await this.clientToken(m),
        "setup",
        methods,
        input.contact,
        undefined,
        currency,
      ),
    };
  }

  async createIntent(input: CreateIntentInput): Promise<IntentRef> {
    const currency = input.currency.toUpperCase();
    const m = this.merchantAccountFor(currency);
    const k = createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 12);
    if (input.purpose === "payment" && input.paymentMethod) {
      const charge = await this.transact(
        "authorize_payment_method",
        input.paymentMethod.providerPaymentMethodId,
        this.transactionInput({
          amountMinor: input.amountMinor ?? 0n,
          currency,
          ref: input.ownershipRef ?? input.idempotencyKey,
          initiator: braintreePaymentInitiator({
            by: input.session === "on_session" ? "customer" : "merchant",
            recurring: false,
          }),
        }),
        input.idempotencyKey,
      );
      if (charge.status === "failed")
        return {
          intentId: charge.providerChargeId,
          status: "inited",
          ...(charge.failure ? { failure: charge.failure } : {}),
          raw: charge.raw,
        };
      return {
        intentId: charge.providerChargeId,
        status: charge.status === "pending" ? "inited" : "authorized",
        raw: charge.raw,
      };
    }
    const methods = braintreeOfferedMethods(input.methodTypes);
    const synthetic: SyntheticIntent = {
      p: input.purpose,
      ...(input.purpose === "setup" ? { c: input.customer.providerCustomerId } : {}),
      ...(m ? { m } : {}),
      ...(input.purpose === "payment" ? { a: String(input.amountMinor ?? 0n) } : {}),
      cur: currency,
      ...(input.ownershipRef ? { r: input.ownershipRef } : {}),
      k,
      t: methods,
    };
    return {
      intentId: encodeSyntheticIntent(synthetic),
      status: "requires_action",
      authorization: this.sdkChallenge(
        await this.clientToken(m),
        input.purpose,
        methods,
        input.contact,
        input.purpose === "payment"
          ? { amountMinor: input.amountMinor ?? 0n, currency }
          : undefined,
        currency,
      ),
    };
  }

  /** The browser's nonce: vault it (setup) or authorize with it (payment). */
  async submitClientResult(input: {
    intentId: string;
    purpose: IntentPurpose;
    clientResult: Record<string, string>;
    idempotencyKey: string;
  }): Promise<FetchedIntent> {
    const s = decodeSyntheticIntent(input.intentId);
    if (!s) return this.intentState(input.intentId);
    const nonce = input.clientResult.nonce?.trim();
    if (!nonce)
      return {
        intentId: input.intentId,
        status: "failed",
        failure: {
          code: "invalid_client_result",
          message: "The payment details from the browser are not valid.",
        },
      };
    try {
      return await this.useNonce(input, s, nonce);
    } catch (e) {
      // A nonce the browser made up, reused or let expire: the buyer can try again.
      if (
        e instanceof BraintreeApiError &&
        e.first?.extensions?.inputPath?.at(-1) === "paymentMethodId"
      )
        return {
          intentId: input.intentId,
          status: "failed",
          failure: {
            code: "invalid_client_result",
            message: "The payment details from the browser are not valid. Enter them again.",
          },
        };
      throw e;
    }
  }

  private async useNonce(
    input: { intentId: string; idempotencyKey: string },
    s: SyntheticIntent,
    nonce: string,
  ): Promise<FetchedIntent> {
    const allowed = s.t?.length ? s.t : ["card"];
    const refused = await this.checkNonce(nonce, allowed);
    if (refused)
      return {
        intentId: input.intentId,
        status: "failed",
        failure: { code: refused.code, message: refused.message },
      };
    if (s.p === "setup") {
      const out = await this.vaultNonce(nonce, s.c, s.m ?? null, allowed);
      if (out.ref)
        return {
          intentId: input.intentId,
          status: "authorized",
          gatewayIntentId: out.ref.providerPaymentMethodId,
        };
      return {
        intentId: input.intentId,
        status: "failed",
        failure: { code: out.failure!.code, message: out.failure!.message },
      };
    }
    const amountMinor = BigInt(s.a ?? "0");
    const charge = await this.transact(
      "authorize_payment_method",
      nonce,
      this.transactionInput({
        amountMinor,
        currency: s.cur,
        ref: s.r ?? input.idempotencyKey,
        // The buyer is in the session and pays with what they just entered.
        initiator: braintreePaymentInitiator({ by: "customer", recurring: false }),
      }),
      input.idempotencyKey,
    );
    const snap = (charge.raw as BtTransaction | undefined)?.paymentMethodSnapshot?.__typename;
    if (charge.status !== "failed" && snap && !allowed.includes(BT_METHOD_USED[snap] ?? "")) {
      // Not a method this intent offered: release the hold before refusing it.
      await this.voidIntent({
        intentId: charge.providerChargeId,
        idempotencyKey: `${input.idempotencyKey}:not_card`,
      });
      return { intentId: input.intentId, status: "failed", failure: notOffered(allowed) };
    }
    if (charge.status === "failed")
      return {
        intentId: input.intentId,
        status: "failed",
        ...(charge.providerChargeId ? { providerChargeId: charge.providerChargeId } : {}),
        failure: { code: charge.failure!.code, message: charge.failure!.message },
        raw: charge.raw,
      };
    return {
      intentId: input.intentId,
      status: charge.status === "pending" ? "requires_action" : "authorized",
      gatewayIntentId: charge.providerChargeId,
      providerChargeId: charge.providerChargeId,
      amountMinor,
      currency: s.cur,
      raw: charge.raw,
    };
  }

  /** Where an authorized transaction stands, in `FetchedIntent` words. */
  private async intentState(legacyId: string): Promise<FetchedIntent> {
    const tx = await this.readTransaction(legacyId).catch(() => null);
    if (!tx) return { intentId: legacyId, status: "unknown" };
    const st = tx.status ?? "";
    const status: FetchedIntent["status"] =
      st === "AUTHORIZED"
        ? "authorized"
        : CAPTURED.has(st)
          ? "consumed"
          : st === "VOIDED" || st === "AUTHORIZATION_EXPIRED"
            ? "voided"
            : REFUSED.has(st)
              ? "failed"
              : "unknown";
    return {
      intentId: legacyId,
      status,
      providerChargeId: tx.legacyId,
      ...(tx.amount?.value && tx.amount.currencyCode
        ? {
            amountMinor: decimalToMinor(tx.amount.value, tx.amount.currencyCode),
            currency: tx.amount.currencyCode,
          }
        : {}),
      raw: tx,
    };
  }

  async consumeIntent(input: ConsumeIntentInput): Promise<ConsumeIntentResult> {
    if (decodeSyntheticIntent(input.intentId))
      throw new Error(
        "This Braintree intent has no card from the browser yet. Submit the client result first",
      );
    if (input.purpose === "setup") {
      const pm = await this.readPaymentMethod(input.intentId);
      if (!pm) throw new Error(`Braintree knows no payment method ${input.intentId}`);
      return {
        purpose: "setup",
        paymentMethod: {
          providerKey: this.key,
          providerPaymentMethodId: pm.id,
          ...(pm.customer?.id ? { providerCustomerId: pm.customer.id } : {}),
          display: describeBraintreePaymentMethod(pm),
        },
      };
    }
    const { data, error } = await this.mutate<{
      captureTransaction: { transaction: BtTransaction | null } | null;
    }>(
      "capture_transaction",
      `mutation($input: CaptureTransactionInput!) { captureTransaction(input: $input) { transaction { ${TX_FIELDS} } } }`,
      {
        input: {
          apiRequestKey: boundedProviderKey(input.idempotencyKey, REQUEST_KEY_MAX),
          transactionId: transactionGlobalId(input.intentId),
          ...(input.amountMinor != null && input.currency
            ? {
                transaction: {
                  amount: minorToDecimalString(input.amountMinor, input.currency.toUpperCase()),
                },
              }
            : {}),
        },
      },
    );
    const tx = data?.captureTransaction?.transaction;
    if (tx) return { purpose: "payment", charge: chargeResultFromTransaction(tx) };
    throw this.unsettledMutation("capture_transaction", error);
  }

  async voidIntent(input: VoidIntentInput): Promise<VoidIntentResult> {
    // An unused challenge or a vaulted card holds no money.
    if (decodeSyntheticIntent(input.intentId) || decodesTo(input.intentId, "paymentmethod_"))
      return { voided: true, held: false };
    let held: boolean | undefined;
    const pre = await this.readTransaction(input.intentId).catch(() => null);
    if (pre?.status === "VOIDED") return { voided: true, providerTransactionId: pre.legacyId };
    if (pre?.status === "AUTHORIZED") held = true;
    else if (pre?.status && REFUSED.has(pre.status)) held = false;
    const { data, error } = await this.mutate<{
      voidTransaction: { transaction: { legacyId: string; status?: string } | null } | null;
    }>(
      "void_transaction",
      `mutation($input: VoidTransactionInput!) { voidTransaction(input: $input) { transaction { legacyId status } } }`,
      {
        input: {
          apiRequestKey: boundedProviderKey(input.idempotencyKey, REQUEST_KEY_MAX),
          transactionId: transactionGlobalId(input.intentId),
        },
      },
    );
    const tx = data?.voidTransaction?.transaction;
    if (!tx) throw this.unsettledMutation("void_transaction", error);
    return {
      voided: tx.status === "VOIDED",
      providerTransactionId: tx.legacyId,
      ...(held !== undefined ? { held } : {}),
    };
  }

  // ── webhooks ──

  /** Braintree sends no event id: kind + subject id + timestamp, else a hash of the payload. */
  webhookEventId(input: NormalizeWebhookInput): string {
    const btPayload = formField(input.payload, "bt_payload") ?? "";
    let candidate: string | undefined;
    try {
      const n = decodeBraintreeNotification(btPayload);
      const id =
        xmlText(n.subject, "id") ??
        xmlText(n.subject, "transaction-id") ??
        xmlText(n.subject, "token") ??
        xmlText(n.subject, "report-date");
      if (n.kind && id && n.timestamp) candidate = `bt_${n.kind}_${id}_${n.timestamp}`;
    } catch {
      candidate = undefined;
    }
    return webhookEventId([candidate], btPayload || input.payload);
  }

  async normalizeWebhook(input: NormalizeWebhookInput): Promise<NormalizedProviderEvent[]> {
    const signature = formField(input.payload, "bt_signature");
    const btPayload = formField(input.payload, "bt_payload");
    if (!signature || !btPayload)
      throw new Error("Braintree webhook is missing bt_signature or bt_payload");
    verifyBraintreeSignature(this.opts.publicKey, this.opts.privateKey, signature, btPayload);
    const n = decodeBraintreeNotification(btPayload);
    const raw = {
      provider_key: this.key,
      kind: n.kind,
      timestamp: n.timestamp ?? null,
      bt_payload: btPayload,
    };
    const eventId = this.webhookEventId(input);
    if (n.kind === "account_updater_daily_report")
      return this.accountUpdaterEvents(n, eventId, raw);
    const token = REVOKED_KINDS.has(n.kind) ? xmlText(n.subject, "token") : undefined;
    const globalIds =
      token && !xmlText(n.subject, "global-id") ? await this.globalIds([token]) : undefined;
    const events = normalizeBraintreeNotification(n, eventId, raw, globalIds);
    for (const ev of events)
      if (ev.type === "charge.refunded" && ev.providerChargeId)
        ev.refunds = await this.saleRefundRecords(ev.providerChargeId, ev.refunds ?? []);
    return events;
  }

  /** Vault tokens → GraphQL ids (50 a call). A token Braintree cannot resolve is left out. */
  private async globalIds(tokens: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let i = 0; i < tokens.length; i += ID_BATCH) {
      const part = tokens.slice(i, i + ID_BATCH);
      const data = await this.query<{ idsFromLegacyIds: (string | null)[] }>(
        "ids_from_legacy_ids",
        `query($input: IdsFromLegacyIdsInput!) { idsFromLegacyIds(input: $input) }`,
        { input: { ids: part.map((legacyId) => ({ legacyId, type: "PAYMENT_METHOD" })) } },
      );
      part.forEach((t, j) => {
        const id = data.idsFromLegacyIds?.[j];
        if (id) out.set(t, id);
      });
    }
    return out;
  }

  /**
   * The account updater's daily report: a CSV of every vaulted card it changed in the last
   * 24 hours (the link expires after one week). A new number or expiry keeps the token, so
   * each changed card is read back and sent as `payment_method.updated`. The other update
   * types change nothing we hold; a closed account fails at the next charge and is
   * classified there.
   */
  private async accountUpdaterEvents(
    n: BraintreeNotification,
    eventId: string,
    raw: Record<string, unknown>,
  ): Promise<NormalizedProviderEvent[]> {
    const url = xmlText(n.subject, "report-url");
    if (!url || !/^https:\/\//.test(url))
      throw new Error("Braintree account updater report has no https report-url");
    const res = await providerFetch({
      gatewayKey: this.key,
      operation: "account_updater_report",
      method: "GET",
      url,
      headers: { Accept: "text/csv" },
    });
    // Thrown, so the route answers an error and Braintree delivers the report again.
    if (res.status < 200 || res.status >= 300)
      throw new Error(`Braintree account updater report answered HTTP ${res.status}`);
    const tokens = changedCardTokens(res.text);
    const ids = await this.globalIds(tokens);
    const occurredAt = dateOf(n.timestamp) ?? new Date();
    const out: NormalizedProviderEvent[] = [];
    for (const token of tokens) {
      const id = ids.get(token);
      if (!id) continue; // deleted from the vault since
      const pm = await this.readPaymentMethod(id);
      if (!pm) continue;
      const d = describeBraintreePaymentMethod(pm);
      out.push({
        providerEventId: `${eventId}_${token}`,
        occurredAt,
        raw,
        type: "payment_method.updated",
        providerPaymentMethodId: id,
        card: {
          brand: d.brand ?? null,
          last4: d.last4 ?? null,
          expMonth: d.expMonth ?? null,
          expYear: d.expYear ?? null,
        },
      });
    }
    if (!out.length) return [{ providerEventId: eventId, occurredAt, raw, type: "unknown" }];
    return out;
  }

  /**
   * Every refund on the sale, as records. Card refunds send no webhook, so this read is how
   * one made in the Control Panel is learned. A failed read keeps what the payload named.
   */
  private async saleRefundRecords(
    saleLegacyId: string,
    named: ProviderRefundRecord[],
  ): Promise<ProviderRefundRecord[]> {
    const sale = await this.readSaleRefunds(saleLegacyId).catch((e) => {
      log.warn("could not read the sale's refunds; booking only the refund the webhook named", {
        provider_charge_id: saleLegacyId,
        error: String(e),
      });
      return null;
    });
    const byId = new Map(named.map((r) => [r.providerRefundId, r]));
    for (const r of sale?.refunds ?? []) {
      const cur = r.amount?.currencyCode ?? sale?.amount?.currencyCode;
      if (!r.legacyId || !r.amount?.value || !cur) continue;
      const own = ownershipOf(r.orderId, true);
      byId.set(r.legacyId, {
        providerRefundId: r.legacyId,
        amountMinor: decimalToMinor(r.amount.value, cur),
        status: refundStatusOf(r.status),
        ...(own.ownershipRef ? { ownershipRef: own.ownershipRef } : {}),
      });
    }
    return [...byId.values()];
  }
}
