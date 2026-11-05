/**
 * Adyen adapter, over the Checkout API (v71) and the Management API (v3), plain HTTP (no SDK).
 *
 * Adyen has no customer object: `shopperReference` is our customer ref, and a stored card
 * (`storedPaymentMethodId`) is only chargeable with the shopperReference it was stored under,
 * so the vaulted ref carries it as `providerCustomerId`.
 *
 * Buyer flow (`mode: 'sdk'`): `createIntent` opens a Checkout session; the browser's Drop-in
 * runs the card form and 3D Secure itself and hands back `sessionResult`; `submitClientResult`
 * reads the session (`GET /sessions/{id}?sessionResult=`), which carries the stored token and
 * the payment's pspReference. Card details never touch our servers (SAQ-A).
 *
 * Ids: `providerChargeId` and `providerRefundId` are pspReferences. Checkout has no GET for a
 * payment or a modification, so there is no `fetchChargeStatus` / `fetchRefundStatus`: card
 * authorisations answer synchronously, and refunds settle by webhook only. A lost charge answer
 * is found by resending the create under the same key (`locateCharge`, `locateByReplay`).
 *
 * SEPA Direct Debit (EUR) rides the same token flow. Adyen answers a debit at submission; a
 * bank return arrives later as a `CHARGEBACK` with a SEPA reason code. Bank returns reopen the
 * invoice (late failure); a payer's own claim (MD01, MD06) is a dispute Adyen never defends.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { currencyExponent, minorToDecimalString } from "@/platform/currency";
import { createLogger } from "@/platform/logger";
import { adyenAdviceCode, normalizeAdyenDecline, type DeclineSignal } from "./decline-codes";
import { classifyGatewayHttp } from "./gateway-http-class";
import { boundedProviderKey, providerFetch, type ProviderFetchResult } from "./http";
import {
  ProviderIndeterminateError,
  ProviderRefusalError,
  type BuyerAuthorization,
  type ChargeInitiator,
  type ChargeInput,
  type ChargeResult,
  type ConsumeIntentInput,
  type ConsumeIntentResult,
  type CreateIntentInput,
  type EnsureCustomerInput,
  type FetchedIntent,
  type HealthCheckInput,
  type HealthCheckItem,
  type HealthCheckResult,
  type InitiateVaultSetupInput,
  type IntentPurpose,
  type IntentRef,
  type NormalizeWebhookInput,
  type NormalizedProviderEvent,
  type PaymentProvider,
  type ProviderCapabilities,
  type ProviderContact,
  type ProviderCustomerRef,
  type ProviderPaymentMethodRef,
  type ProvisionedWebhook,
  type WebhookRemoval,
  type RefundInput,
  type RefundResult,
  type VaultPaymentMethodInput,
  type VaultSetupRef,
  type VoidIntentInput,
  type VoidIntentResult,
} from "./types";
import { webhookEventId } from "./webhook-event-id";

const log = createLogger("adyen");

/** Pinned. Change it only with a re-run of `verify:adyen-live`. */
export const ADYEN_CHECKOUT_VERSION = "v71";
export const ADYEN_TEST_CHECKOUT_URL = `https://checkout-test.adyen.com/${ADYEN_CHECKOUT_VERSION}`;
export const ADYEN_TEST_MANAGEMENT_URL = "https://management-test.adyen.com/v3";
export const ADYEN_LIVE_MANAGEMENT_URL = "https://management-live.adyen.com/v3";

export function adyenLiveCheckoutUrl(prefix: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(prefix))
    throw new Error(`Adyen live URL prefix "${prefix}" is not valid`);
  return `https://${prefix}-checkout-live.adyenpayments.com/checkout/${ADYEN_CHECKOUT_VERSION}`;
}

/** `reference` cap (Checkout API). */
const REFERENCE_MAX = 80;
/** `Idempotency-Key` cap (Adyen API idempotency). */
const IDEMPOTENCY_MAX = 64;
export const ADYEN_OWNERSHIP_KEY = "tmbilling_ref";
const SESSION_PREFIX = "adyses_";
/** A payment link (`PL…`): the buyer pays on Adyen's own page. */
export const ADYEN_LINK_PREFIX = "adypl_";
const STORED_PREFIX = "adypm_";

/**
 * Reference prefixes. They say what we created and that it is ours, and they come back on
 * every webhook as `merchantReference` (which the HMAC covers).
 */
export const ADYEN_REF = {
  charge: "tmc:",
  intent: "tmp:",
  setup: "tms:",
  refund: "tmf:",
  capture: "tmk:",
  cancel: "tmv:",
  /** A pay-now payment link (hosted Apple Pay). */
  hosted: "tmh:",
} as const;

export function adyenReference(prefix: string, ref: string): string {
  return prefix + boundedProviderKey(ref, REFERENCE_MAX - prefix.length);
}

export function adyenOwnership(
  merchantReference: string | undefined,
  metadataRef?: string,
): Pick<NormalizedProviderEvent, "ownership" | "ownershipRef"> {
  if (metadataRef) return { ownership: "ours", ownershipRef: metadataRef };
  const prefix = Object.values(ADYEN_REF).find((p) => merchantReference?.startsWith(p));
  if (prefix && merchantReference)
    return { ownership: "ours", ownershipRef: merchantReference.slice(prefix.length) };
  // Every object we create carries a prefixed reference.
  return { ownership: merchantReference ? "foreign" : "unknown" };
}

// ── Amounts ─────────────────────────────────────────────────────────────────

/**
 * Where Adyen's decimals differ from ISO 4217; every other currency matches ours.
 * https://docs.adyen.com/development-resources/currency-codes
 */
const ADYEN_EXPONENT: Record<string, number> = { CLP: 2, CVE: 0, IDR: 0, ISK: 2 };

export function adyenExponent(currency: string): number {
  const c = currency.toUpperCase();
  return ADYEN_EXPONENT[c] ?? currencyExponent(c);
}

/** Our minor units → Adyen's `value`. IDR, for example, is 2 decimals for us and 0 there. */
export function toAdyenValue(amountMinor: bigint, currency: string): number {
  const c = currency.toUpperCase();
  const diff = adyenExponent(c) - currencyExponent(c);
  let v = amountMinor;
  if (diff >= 0) v = amountMinor * 10n ** BigInt(diff);
  else {
    const f = 10n ** BigInt(-diff);
    if (amountMinor % f !== 0n)
      throw new ProviderRefusalError(
        `Adyen cannot take ${minorToDecimalString(amountMinor, c)} ${c}: it takes this currency to ${adyenExponent(c)} decimal places.`,
      );
    v = amountMinor / f;
  }
  if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`Amount ${amountMinor} ${c} is outside what Adyen accepts`);
  return Number(v);
}

/** Adyen's `value` → our minor units (half-up when Adyen's unit is finer). */
export function fromAdyenValue(value: number, currency: string): bigint {
  const c = currency.toUpperCase();
  const diff = adyenExponent(c) - currencyExponent(c);
  const v = BigInt(Math.round(value));
  if (diff <= 0) return v * 10n ** BigInt(-diff);
  const f = 10n ** BigInt(diff);
  return (v + f / 2n) / f;
}

/** A notification's or session's amount in our minor units, or undefined. */
const minorOf = (a: { value?: number; currency?: string } | undefined): bigint | undefined =>
  typeof a?.value === "number" && a.currency ? fromAdyenValue(a.value, a.currency) : undefined;

// ── Stored-credential flags ─────────────────────────────────────────────────

export interface AdyenStoredCredential {
  shopperInteraction: "ContAuth";
  recurringProcessingModel: "Subscription" | "UnscheduledCardOnFile";
}

/**
 * Flags for a server-side charge on a stored card. Always `ContAuth`: Adyen refuses a stored
 * card sent as `Ecommerce` (or as `CardOnFile`) without the CVC (measured, 14_029), and we
 * never hold one. The buyer-present first payment is the Drop-in session (`Ecommerce` +
 * `Subscription`). Absent initiator = unscheduled, the safest merchant-initiated claim.
 */
export function adyenStoredCredential(
  initiator: ChargeInitiator | undefined,
): AdyenStoredCredential {
  return {
    shopperInteraction: "ContAuth",
    recurringProcessingModel: initiator?.recurring ? "Subscription" : "UnscheduledCardOnFile",
  };
}

// ── Ids ─────────────────────────────────────────────────────────────────────

/**
 * A setup's result: the token, the shopperReference it is chargeable under, and the setup's
 * pspReference. For SEPA that pspReference is the mandate id
 * (`sepadirectdebit.mandateId`, Checkout v71 `ResponseAdditionalDataSepa`).
 */
export function encodeStoredMethod(
  shopperReference: string,
  token: string,
  setupPsp?: string,
): string {
  const v = setupPsp ? [shopperReference, token, setupPsp] : [shopperReference, token];
  return STORED_PREFIX + Buffer.from(JSON.stringify(v)).toString("base64url");
}

export function decodeStoredMethod(
  id: string,
): { shopperReference: string; token: string; setupPsp?: string } | null {
  if (!id.startsWith(STORED_PREFIX)) return null;
  try {
    const v: unknown = JSON.parse(
      Buffer.from(id.slice(STORED_PREFIX.length), "base64url").toString(),
    );
    if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string")
      return {
        shopperReference: v[0],
        token: v[1],
        ...(typeof v[2] === "string" && v[2] ? { setupPsp: v[2] } : {}),
      };
  } catch {
    // Not one of ours.
  }
  return null;
}

/** Our method type → Adyen's `paymentMethod.type` for a stored-token payment. */
export function adyenTxVariant(methodType: string | undefined | null): string {
  return methodType === "sepa_debit" ? "sepadirectdebit" : "scheme";
}

/** Adyen supports the SEPA Core scheme only (payment-methods/sepa-direct-debit). */
export const ADYEN_SEPA_RAIL = "sepa_core";

const sessionIdOf = (intentId: string) =>
  intentId.startsWith(SESSION_PREFIX) ? intentId.slice(SESSION_PREFIX.length) : null;

// ── Payments ────────────────────────────────────────────────────────────────

export interface AdyenPaymentResponse {
  pspReference?: string;
  resultCode?: string;
  refusalReason?: string;
  refusalReasonCode?: string;
  merchantReference?: string;
  amount?: { value?: number; currency?: string };
  paymentMethod?: { brand?: string; type?: string };
  action?: { type?: string; url?: string };
  additionalData?: Record<string, string>;
}

const AUTHORISED = "Authorised";
/** A setup whose payment reads one of these has its token stored already (SEPA). */
const SETUP_STORED_RESULTS = new Set(["Received", "Pending"]);

/**
 * `allowedPaymentMethods` of a setup session: cards, plus SEPA Direct Debit in EUR when the
 * account offers it. Absent `methodTypes` = cards only.
 */
export function adyenSetupMethods(methodTypes: string[] | undefined, currency: string): string[] {
  const wanted = methodTypes?.length ? methodTypes : ["card"];
  const out: string[] = [];
  if (wanted.includes("card")) out.push("scheme");
  if (wanted.includes("sepa_debit") && currency.toUpperCase() === "EUR")
    out.push("sepadirectdebit");
  if (out.length === 0)
    throw new ProviderRefusalError(
      wanted.includes("sepa_debit")
        ? `Adyen sets up SEPA Direct Debit in EUR only, and this setup is in ${currency.toUpperCase()}.`
        : `Adyen cannot set up automatic payments with ${wanted.join(", ")}. Use a card or SEPA Direct Debit.`,
    );
  return out;
}
const REFUSED_RESULTS = new Set(["Refused", "Error", "Cancelled"]);
const ACTION_RESULTS = new Set(["RedirectShopper", "IdentifyShopper", "ChallengeShopper"]);

const BRAND: Record<string, string> = {
  mc: "mastercard",
  visa: "visa",
  amex: "amex",
  discover: "discover",
  jcb: "jcb",
  diners: "diners",
  cup: "unionpay",
  maestro: "maestro",
  rupay: "rupay",
};
export const adyenBrand = (b: string | undefined | null) =>
  b ? (BRAND[b.toLowerCase()] ?? b.toLowerCase()) : undefined;

/** Adyen's refusal-reason texts → refusal codes, for a webhook that carries only the text. */
const REASON_CODE: Record<string, string> = {
  refused: "2",
  referral: "3",
  "acquirer error": "4",
  "blocked card": "5",
  "expired card": "6",
  "invalid amount": "7",
  "invalid card number": "8",
  "issuer unavailable": "9",
  "not supported": "10",
  "3d not authenticated": "11",
  "not enough balance": "12",
  "acquirer fraud": "14",
  cancelled: "15",
  "shopper cancelled": "16",
  fraud: "20",
  "not submitted": "21",
  "fraud-cancelled": "22",
  "transaction not permitted": "23",
  "cvc declined": "24",
  "restricted card": "25",
  "revocation of auth": "26",
  "declined non generic": "27",
  "withdrawal amount exceeded": "28",
  "withdrawal count exceeded": "29",
  "issuer suspected fraud": "31",
  "avs declined": "32",
  "authentication required": "38",
  "3ds authentication error": "42",
  "transaction blocked by adyen to prevent excessive retry fees": "46",
  "token revoked": "50",
};

/** What the decline rules may read off a refusal. */
export function adyenDeclineSignal(p: {
  refusalReasonCode?: string | null;
  refusalReason?: string | null;
  resultCode?: string | null;
  additionalData?: Record<string, string> | null;
  brand?: string | null;
}): DeclineSignal {
  const reason = p.refusalReason?.trim() ?? null;
  return {
    code:
      p.refusalReasonCode ??
      p.additionalData?.refusalReasonCode ??
      (reason ? REASON_CODE[reason.toLowerCase()] : undefined) ??
      null,
    message: reason,
    category: p.resultCode ?? null,
    recommendationCode: adyenAdviceCode(p.additionalData?.merchantAdviceCode),
    cardBrand: adyenBrand(p.brand ?? p.additionalData?.paymentMethod) ?? null,
  };
}

function failureOf(sig: DeclineSignal): NonNullable<ChargeResult["failure"]> {
  const f = normalizeAdyenDecline(sig);
  return {
    code: f.code,
    ...(sig.code ? { providerCode: sig.code } : {}),
    message:
      f.message ?? sig.message ?? `Adyen reports this payment as ${sig.category ?? "refused"}`,
    retriable: f.retriable,
    ...(f.retryAfterMs ? { retryAfterMs: f.retryAfterMs } : {}),
    ...(f.ruleId ? { ruleId: f.ruleId } : {}),
  };
}

/**
 * `paymentMethod.type` → our method type (`ChargeResult.methodUsed`). Adyen returns it only
 * on an `Authorised` result (Checkout API v69+, `PaymentResponse.paymentMethod`).
 */
const ADYEN_METHOD_USED: Readonly<Record<string, string>> = {
  scheme: "card",
  applepay: "apple_pay",
  googlepay: "google_pay",
  paywithgoogle: "google_pay",
  ach: "us_bank_account",
  sepadirectdebit: "sepa_debit",
  directdebit_GB: "bacs_debit",
  paypal: "paypal",
};

export function adyenMethodUsed(type: string | undefined): { methodUsed?: string } {
  const m = type ? ADYEN_METHOD_USED[type] : undefined;
  return m ? { methodUsed: m } : {};
}

export function chargeResultFromPayment(res: AdyenPaymentResponse): ChargeResult {
  const providerChargeId = res.pspReference ?? "";
  const rc = res.resultCode ?? "";
  const used = adyenMethodUsed(res.paymentMethod?.type);
  if (rc === AUTHORISED) return { status: "succeeded", providerChargeId, ...used, raw: res };
  if (REFUSED_RESULTS.has(rc))
    return {
      status: "failed",
      providerChargeId,
      failure: failureOf(adyenDeclineSignal({ ...res, brand: res.paymentMethod?.brand ?? null })),
      ...used,
      raw: res,
    };
  if (ACTION_RESULTS.has(rc))
    return {
      status: "requires_action",
      providerChargeId,
      nextAction: { type: res.action?.type ?? rc, data: { approvalRequired: true } },
      ...used,
      raw: res,
    };
  // Received / Pending / PresentToShopper: the verdict arrives by webhook.
  return { status: "pending", providerChargeId, ...used, raw: res };
}

// ── Stored cards ────────────────────────────────────────────────────────────

export interface AdyenStoredMethod {
  id: string;
  type?: string;
  brand?: string;
  lastFour?: string;
  expiryMonth?: string;
  expiryYear?: string;
  supportedRecurringProcessingModels?: string[];
  /** SEPA: the IBAN (masked by Adyen or not; we keep only its last four). */
  iban?: string;
}

const isSepa = (m: Pick<AdyenStoredMethod, "type">) => m.type === "sepadirectdebit";

export function describeAdyenStoredMethod(
  m: AdyenStoredMethod,
): ProviderPaymentMethodRef["display"] {
  const recurring = m.supportedRecurringProcessingModels
    ? { supportsRecurring: m.supportedRecurringProcessingModels.includes("Subscription") }
    : {};
  if (isSepa(m)) {
    const last4 = m.iban?.replace(/\s/g, "").slice(-4);
    return { type: "sepa_debit", ...(last4 ? { last4 } : {}), ...recurring };
  }
  const yy = m.expiryYear ? Number(m.expiryYear) : undefined;
  return {
    type: "card",
    ...(adyenBrand(m.brand) ? { brand: adyenBrand(m.brand) } : {}),
    ...(m.lastFour ? { last4: m.lastFour } : {}),
    ...(m.expiryMonth ? { expMonth: Number(m.expiryMonth) } : {}),
    // Measured: Adyen reports the year as two digits ("30").
    ...(yy != null && Number.isFinite(yy) ? { expYear: yy < 100 ? 2000 + yy : yy } : {}),
    ...recurring,
  };
}

// ── Transport ───────────────────────────────────────────────────────────────

/** A 4xx answer from Adyen: `{status, errorCode, message, errorType}`. */
export class AdyenApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly errorCode: string | undefined,
    readonly detail: string,
    readonly errorType: string | undefined,
  ) {
    super(`Adyen ${operation}: ${detail} (HTTP ${status}${errorCode ? `, ${errorCode}` : ""})`);
    this.name = "AdyenApiError";
  }
  /** What the decline rules read for an API refusal. */
  get signalCode(): string | undefined {
    return this.errorCode ? `api:${this.errorCode}` : undefined;
  }
}

// ── Webhooks ────────────────────────────────────────────────────────────────

export interface AdyenNotificationItem {
  additionalData?: Record<string, string>;
  amount?: { value?: number; currency?: string };
  eventCode?: string;
  eventDate?: string;
  merchantAccountCode?: string;
  merchantReference?: string;
  originalReference?: string;
  pspReference?: string;
  reason?: string;
  success?: string;
  paymentMethod?: string;
}

/** The signed string: Adyen's documented field order, `:`-joined, absent fields empty. */
export function adyenHmacPayload(i: AdyenNotificationItem): string {
  return [
    i.pspReference ?? "",
    i.originalReference ?? "",
    i.merchantAccountCode ?? "",
    i.merchantReference ?? "",
    i.amount?.value ?? "",
    i.amount?.currency ?? "",
    i.eventCode ?? "",
    i.success ?? "",
  ].join(":");
}

function hmacKeyBytes(hexKey: string): Buffer {
  const k = hexKey.trim();
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(k))
    throw new Error("The Adyen HMAC key is not a hexadecimal string");
  return Buffer.from(k, "hex");
}

/** Base64(HMAC-SHA256(hex-decoded key, payload)). Matches Adyen's published test vector. */
export function signAdyenItem(hexKey: string, item: AdyenNotificationItem): string {
  return createHmac("sha256", hmacKeyBytes(hexKey))
    .update(adyenHmacPayload(item), "utf8")
    .digest("base64");
}

export function verifyAdyenItem(hexKey: string, item: AdyenNotificationItem): boolean {
  const given = item.additionalData?.hmacSignature;
  if (!given) return false;
  const a = Buffer.from(signAdyenItem(hexKey, item));
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseAdyenNotification(payload: string | Buffer): AdyenNotificationItem[] {
  const body = JSON.parse(payload.toString()) as {
    notificationItems?: Array<{ NotificationRequestItem?: AdyenNotificationItem }>;
  };
  return (body.notificationItems ?? [])
    .map((x) => x.NotificationRequestItem)
    .filter((x): x is AdyenNotificationItem => !!x);
}

/** Adyen: a duplicate has the same eventCode and pspReference. Standard webhooks carry no event id. */
export const adyenItemEventId = (i: AdyenNotificationItem) =>
  `${i.pspReference ?? ""}:${i.eventCode ?? ""}:${i.success ?? ""}`;

const dateOf = (s: string | undefined) => {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

const DISPUTE_LOST = new Set(["Lost", "Accepted"]);

/**
 * Events that come after CHARGEBACK_REVERSED: pre-arbitration opens "on a previously
 * defended dispute", and a second chargeback debits the reinstated amount again.
 * https://docs.adyen.com/risk-management/understanding-disputes/dispute-process-and-flow
 */
const SECOND_CYCLE = new Set([
  "SECOND_CHARGEBACK",
  "PREARBITRATION_OPEN",
  "PREARBITRATION_WON",
  "PREARBITRATION_LOST",
  "PREARBITRATION_ISSUER_WITHDRAWN",
  "SCHEME_ARBITRATION_WON",
  "SCHEME_ARBITRATION_LOST",
]);
export const SECOND_CYCLE_SUFFIX = ":second";

/**
 * SEPA chargebacks that are the payer's own claim: "Refund Request By End Customer" (MD06, 8 weeks,
 * no reason needed) and "No Mandate" (MD01, unauthorised, 13 months). A dispute, lost at once:
 * "You cannot defend SEPA chargebacks." Every other SEPA code is a bank return (insufficient
 * funds, closed or blocked account, technical): the debit failed and the invoice is owed again.
 * https://docs.adyen.com/risk-management/understanding-disputes/dispute-reason-codes (SEPA),
 * https://docs.adyen.com/payment-methods/sepa-direct-debit, read 2026-10-28.
 */
const SEPA_PAYER_CLAIMS = new Set(["MD01", "MD06"]);
const SEPA_RETURNS = new Set([
  "AC01",
  "AC04",
  "AC06",
  "AC13",
  "AG01",
  "AG02",
  "AM04",
  "AM05",
  "BE05",
  "CNOR",
  "DNOR",
  "ED05",
  "FF01",
  "MD02",
  "MD07",
  "MS02",
  "MS03",
  "RC01",
  "RR01",
  "RR02",
  "RR03",
  "RR04",
  "SL01",
]);

/** A SEPA chargeback's reason code and kind, or null when the item is not a SEPA chargeback. */
export function adyenSepaChargeback(
  item: AdyenNotificationItem,
): { code: string; kind: "return" | "claim" } | null {
  const ad = item.additionalData ?? {};
  if (item.paymentMethod !== "sepadirectdebit" && ad.chargebackSchemeCode !== "sepadirectdebit")
    return null;
  // `reason` reads "AC01:IncorrectAccountNumber" when the code field is absent.
  const code = (ad.chargebackReasonCode || item.reason?.split(":")[0] || "").trim().toUpperCase();
  // An unknown code stays a dispute: never re-debit a payer who may have claimed the money back.
  return {
    code,
    kind: SEPA_RETURNS.has(code) && !SEPA_PAYER_CLAIMS.has(code) ? "return" : "claim",
  };
}

/** Translate one verified notification item into our vocabulary. */
export function normalizeAdyenItem(
  item: AdyenNotificationItem,
  eventId: string,
): NormalizedProviderEvent[] {
  const ad = item.additionalData ?? {};
  const ok = item.success === "true";
  const ref = item.merchantReference ?? "";
  const base: NormalizedProviderEvent = {
    providerEventId: eventId,
    type: "unknown",
    occurredAt: dateOf(item.eventDate) ?? new Date(),
    raw: item,
    ...adyenOwnership(item.merchantReference, ad[`metadata.${ADYEN_OWNERSHIP_KEY}`]),
  };
  const psp = item.pspReference;
  const original = item.originalReference || undefined;
  const decline = () => {
    const sig = adyenDeclineSignal({
      refusalReason: item.reason ?? null,
      resultCode: "Refused",
      additionalData: ad,
      brand: item.paymentMethod ?? null,
    });
    const f = normalizeAdyenDecline(sig);
    return {
      failureCode: f.code,
      failureRetriable: f.retriable,
      ...(sig.code ? { providerFailureCode: sig.code } : {}),
      ...((f.message ?? item.reason) ? { failureMessage: f.message ?? item.reason } : {}),
    };
  };
  const disputeAmount = minorOf(item.amount);
  const dispute = () => ({
    // After CHARGEBACK_REVERSED the money is back and the case is booked won; what follows
    // (a second chargeback, pre-arbitration, scheme arbitration) is a second case on it.
    providerDisputeId:
      psp && SECOND_CYCLE.has(item.eventCode ?? "") ? `${psp}${SECOND_CYCLE_SUFFIX}` : psp,
    providerChargeId: original,
    disputeReason: ad.chargebackReasonCode ?? item.reason ?? null,
    disputeStatus: ad.disputeStatus ?? null,
    ...(disputeAmount != null ? { disputeAmountMinor: disputeAmount } : {}),
    disputeCurrency: item.amount?.currency ?? null,
    evidenceDueBy: dateOf(ad.defensePeriodEndsAt) ?? null,
  });
  const withdrawn = (ev: NormalizedProviderEvent): NormalizedProviderEvent => ({
    ...ev,
    providerEventId: `${eventId}:funds_withdrawn`,
    type: "dispute.funds_withdrawn",
  });
  /** One refund at its own amount; never a full refund by default. */
  const refunded = (): NormalizedProviderEvent[] => {
    const amountMinor = minorOf(item.amount);
    if (amountMinor == null || !psp) return [base];
    const own = ref.startsWith(ADYEN_REF.refund) ? ref.slice(ADYEN_REF.refund.length) : undefined;
    return [
      {
        ...base,
        type: "charge.refunded",
        providerChargeId: original,
        providerRefundId: psp,
        refunds: [
          {
            providerRefundId: psp,
            amountMinor,
            status: "succeeded",
            ...(own ? { ownershipRef: own } : {}),
          },
        ],
      },
    ];
  };
  const won = ad.disputeStatus === "Won";

  switch (item.eventCode) {
    case "AUTHORISATION": {
      const created = dateOf(item.eventDate);
      const obj = { ...base, ...(created ? { providerObjectCreatedAt: created } : {}) };
      // A payment made on a payment link names the link, which is the intent we stored.
      // https://docs.adyen.com/unified-commerce/pay-by-link/create-payment-links/api
      const linkId = ad.paymentLinkId;
      if (linkId) {
        // Refused: the link stays open for another try until it expires, so nothing closes.
        if (!ok || !psp) return [obj];
        return [
          {
            ...obj,
            type: "intent.authorized",
            providerIntentId: ADYEN_LINK_PREFIX + linkId,
            providerChargeId: psp,
            gatewayIntentId: psp,
          },
        ];
      }
      if (ref.startsWith(ADYEN_REF.setup)) {
        const token =
          ad["tokenization.storedPaymentMethodId"] ?? ad["recurring.recurringDetailReference"];
        const shopper = ad["tokenization.shopperReference"] ?? ad["recurring.shopperReference"];
        if (ok && token && shopper)
          return [
            {
              ...obj,
              type: "intent.setup_succeeded",
              // Same id as the session result: both carry the setup's pspReference.
              providerIntentId: encodeStoredMethod(shopper, token, psp),
            },
          ];
        return [obj];
      }
      if (ref.startsWith(ADYEN_REF.intent))
        return [
          ok
            ? { ...obj, type: "intent.authorized", providerIntentId: psp }
            : { ...obj, type: "intent.failed", providerIntentId: psp, ...decline() },
        ];
      return [
        ok
          ? {
              ...obj,
              type: "charge.succeeded",
              providerChargeId: psp,
              // Only our charges are captured with the authorisation (`captureDelayHours: 0`).
              ...(ref.startsWith(ADYEN_REF.charge) ? amountOf(item) : {}),
            }
          : { ...obj, type: "charge.failed", providerChargeId: psp, ...decline() },
      ];
    }
    case "CAPTURE":
      if (ok)
        return [
          {
            ...base,
            type: "charge.succeeded",
            providerChargeId: original,
            // A capture made in the Customer Area names the authorisation it captures.
            ...(original ? { providerIntentId: original } : {}),
            ...amountOf(item),
          },
        ];
      return [captureFailed(base, original, item)];
    case "CAPTURE_FAILED":
      return [captureFailed(base, original, item)];
    case "CANCELLATION":
      return ok ? [{ ...base, type: "intent.voided", providerIntentId: original }] : [base];
    case "EXPIRE":
      // An uncaptured authorisation lapsed: the hold is gone.
      return ok ? [{ ...base, type: "intent.voided", providerIntentId: original ?? psp }] : [base];
    case "SETTLED_REVERSED":
      // Adyen did not receive the captured funds and debits them back.
      return ok
        ? [
            {
              ...base,
              type: "charge.reversed",
              providerChargeId: original ?? psp,
              lateReversal: true,
            },
          ]
        : [base];
    case "CANCEL_OR_REFUND":
      if (!ok) return [base];
      // Our refund of a debit not yet collected (SEPA) is done by cancelling it: the payer is
      // never debited, which is the refund's money outcome.
      return ad["modification.action"] === "refund" || ref.startsWith(ADYEN_REF.refund)
        ? refunded()
        : [{ ...base, type: "intent.voided", providerIntentId: original }];
    case "REFUND":
      return ok
        ? refunded()
        : [{ ...base, type: "refund.failed", providerChargeId: original, providerRefundId: psp }];
    case "REFUND_FAILED":
    case "REFUNDED_REVERSED":
      return [
        { ...base, type: "refund.failed", providerChargeId: original, providerRefundId: psp },
      ];
    case "NOTIFICATION_OF_CHARGEBACK":
    case "REQUEST_FOR_INFORMATION":
    case "PREARBITRATION_OPEN":
      return [{ ...base, ...dispute(), type: "dispute.created" }];
    case "CHARGEBACK": {
      const sepa = adyenSepaChargeback(item);
      if (sepa?.kind === "return") return [sepaReturned(base, original, item, sepa.code)];
      // Adyen debits the amount when the chargeback is booked.
      const ev: NormalizedProviderEvent = { ...base, ...dispute(), type: "dispute.created" };
      const out = [ev, withdrawn(ev)];
      // A SEPA claim cannot be defended, whatever disputeStatus says.
      if (sepa || DISPUTE_LOST.has(ad.disputeStatus ?? ""))
        out.push({ ...ev, providerEventId: `${eventId}:lost`, type: "dispute.lost" });
      return out;
    }
    case "SECOND_CHARGEBACK": {
      // The reinstated amount is debited again, and the case is lost.
      const ev: NormalizedProviderEvent = { ...base, ...dispute(), type: "dispute.lost" };
      return [withdrawn(ev), ev];
    }
    case "CHARGEBACK_REVERSED": {
      const ev: NormalizedProviderEvent = {
        ...base,
        ...dispute(),
        type: "dispute.funds_reinstated",
      };
      return won ? [ev, { ...ev, providerEventId: `${eventId}:won`, type: "dispute.won" }] : [ev];
    }
    case "PREARBITRATION_WON":
    case "SCHEME_ARBITRATION_WON":
    case "ISSUER_RESPONSE_TIMEFRAME_EXPIRED":
      return [{ ...base, ...dispute(), type: "dispute.won" }];
    case "PREARBITRATION_ISSUER_WITHDRAWN":
      // Pending: the issuer may open a new pre-arbitration.
      return won ? [{ ...base, ...dispute(), type: "dispute.won" }] : [base];
    case "PREARBITRATION_LOST":
    case "SCHEME_ARBITRATION_LOST":
      return [{ ...base, ...dispute(), type: "dispute.lost" }];
    case "DISPUTE_DEFENSE_PERIOD_ENDED":
      // Undefended, Lost or Accepted: no defence is coming. Accepting in the Customer Area
      // sends nothing else.
      return [{ ...base, ...dispute(), type: "dispute.lost" }];
    case "MANUAL_REVIEW_ACCEPT":
    case "MANUAL_REVIEW_REJECT":
      return [{ ...base, type: "review.closed", providerChargeId: psp }];
    default:
      // RECURRING_CONTRACT, REPORT_AVAILABLE, OFFER_CLOSED, payouts, and anything newer.
      return [base];
  }
}

/** The item's amount as `capturedAmountMinor`, in our minor units. */
const amountOf = (i: AdyenNotificationItem): { capturedAmountMinor?: bigint } => {
  const m = minorOf(i.amount);
  return m != null ? { capturedAmountMinor: m } : {};
};

/**
 * A SEPA bank return: the debit failed after Adyen answered it. Flagged as a reversal, so a
 * booked payment is reopened and dunning may retry; a debit still pending simply fails.
 */
function sepaReturned(
  base: NormalizedProviderEvent,
  original: string | undefined,
  item: AdyenNotificationItem,
  code: string,
): NormalizedProviderEvent {
  const f = normalizeAdyenDecline({ code: `sepa:${code}`, message: item.reason ?? null });
  return {
    ...base,
    type: "charge.failed",
    providerChargeId: original,
    failureCode: f.code,
    failureRetriable: f.retriable,
    providerFailureCode: code,
    failureMessage: f.message ?? item.reason ?? `SEPA return ${code}`,
    lateReversal: true,
    raw: { ...item, data: { reversal: true, retriable: f.retriable } },
  };
}

/** A capture that did not happen: flagged as a reversal, so a booked payment is reopened. */
function captureFailed(
  base: NormalizedProviderEvent,
  original: string | undefined,
  item: AdyenNotificationItem,
): NormalizedProviderEvent {
  const f = normalizeAdyenDecline({ message: item.reason ?? null, category: item.eventCode });
  return {
    ...base,
    type: "charge.failed",
    providerChargeId: original,
    failureCode: f.code,
    failureRetriable: f.retriable,
    ...(item.reason ? { failureMessage: item.reason } : {}),
    lateReversal: true,
    raw: { ...item, data: { reversal: true, retriable: f.retriable } },
  };
}

// ── Allowed origins ─────────────────────────────────────────────────────────

/** `scheme://host[:port]`, lower case, or null when it is not a URL. */
export function adyenOrigin(value: string): string | null {
  try {
    const o = new URL(value.trim()).origin;
    return o === "null" ? null : o.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Drop-in loads only on an origin in the API credential's Allowed origins; elsewhere the
 * buyer sees only "We could not open the card form". `allowed: null` = not read.
 */
export function adyenAllowedOriginsCheck(p: {
  allowed: string[] | null;
  storefront: string[];
  livemode: boolean;
  credential?: string;
  error?: string;
}): HealthCheckItem {
  const key = "allowed_origins";
  if (p.allowed === null)
    return {
      key,
      status: "unchecked",
      message:
        p.error === "no_role"
          ? "We could not read the Allowed origins of this API credential. The credential has no Management API role."
          : "We could not read the Allowed origins of this API credential. Try again later.",
      steps:
        p.error === "no_role"
          ? [
              'Give the API credential a Management API role, for example "Management API — Webhooks read and write". Webhook setup also uses this role.',
              "Select Check credentials again.",
            ]
          : ["Select Check credentials again."],
    };
  const storefront = [...new Set(p.storefront.map(adyenOrigin).filter((o): o is string => !!o))];
  if (storefront.length === 0)
    return {
      key,
      status: "unchecked",
      message:
        "We did not check Allowed origins. This deployment has no storefront address (PORTAL_BASE_URL).",
    };
  const allowed = new Set(p.allowed.map(adyenOrigin).filter(Boolean));
  const missing = storefront.filter((o) => !allowed.has(o));
  if (missing.length === 0)
    return { key, status: "ok", message: `Allowed origins includes ${storefront.join(", ")}.` };
  const area = p.livemode ? "https://ca-live.adyen.com" : "https://ca-test.adyen.com";
  return {
    key,
    status: "failed",
    message: `Allowed origins of the API credential does not include ${missing.join(", ")}. Buyers cannot open the card form on ${missing.length === 1 ? "this address" : "these addresses"}.`,
    steps: [
      `Sign in to the Adyen Customer Area at ${area}.`,
      `Go to Developers > API credentials, then open ${p.credential ? `the credential ${p.credential}` : "the API credential of this account"}.`,
      ...missing.map(
        (o) => `Under Client settings > Allowed origins, enter ${o}, then select Add.`,
      ),
      "Select Save changes.",
      // Measured: Adyen's reads show a change after up to ~4 s.
      "Wait one minute. Then select Check credentials again.",
    ],
  };
}

// ── The adapter ─────────────────────────────────────────────────────────────

export interface AdyenOptions {
  apiKey: string;
  clientKey: string;
  merchantAccount: string;
  livemode: boolean;
  /** Required in live mode: Customer Area → Developers → API URLs → Prefix. */
  liveUrlPrefix?: string;
  /** The standard webhook's HMAC key (hex). */
  hmacKey?: string;
  /** Overrides, for tests. */
  checkoutUrl?: string;
  managementUrl?: string;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How long after the attempt `locateCharge` may resend it. Keys are "valid for a period of 7 to
 * 14 days after first submission" (https://docs.adyen.com/development-resources/api-idempotency,
 * read 2026-10-27): six days keeps a day of margin under the shortest.
 */
export const ADYEN_REPLAY_WINDOW_MS = 6 * 86_400_000;

type LocateChargeInput = Parameters<NonNullable<PaymentProvider["locateCharge"]>>[0];

/** Tries of one money call under one key, and the backoff between them. */
const MONEY_ATTEMPTS = 3;
const RETRY_WAIT_MS = 500;
const RETRY_WAIT_MAX_MS = 5_000;

const adyenErrorCode = (text: string): string | undefined => {
  try {
    const code = (JSON.parse(text) as { errorCode?: unknown }).errorCode;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
};

interface AdyenSession {
  id: string;
  sessionData?: string;
  expiresAt?: string;
}

interface AdyenSessionResult {
  id?: string;
  status?: string;
  reference?: string;
  payments?: Array<{
    pspReference?: string;
    resultCode?: string;
    amount?: { value?: number; currency?: string };
    /** On an `Authorised` payment only. */
    paymentMethod?: { brand?: string; type?: string };
  }>;
  additionalData?: Record<string, string>;
}

export class AdyenProvider implements PaymentProvider {
  readonly key = "adyen" as const;
  readonly capabilities: ProviderCapabilities;
  private readonly checkoutUrl: string;
  private readonly managementUrl: string;

  constructor(private readonly opts: AdyenOptions) {
    if (opts.livemode) {
      const prefix = opts.liveUrlPrefix?.trim();
      if (!prefix || prefix.toLowerCase() === "test")
        throw new Error(
          "An Adyen live account needs its live URL prefix (Customer Area → Developers → API URLs → Prefix)",
        );
      if (opts.clientKey.startsWith("test_"))
        throw new Error("This Adyen client key is a test key. A live account needs a live_ key");
    } else if (opts.clientKey.startsWith("live_")) {
      throw new Error("This Adyen client key is a live key. A test account needs a test_ key");
    }
    this.checkoutUrl =
      opts.checkoutUrl ??
      (opts.livemode ? adyenLiveCheckoutUrl(opts.liveUrlPrefix!.trim()) : ADYEN_TEST_CHECKOUT_URL);
    this.managementUrl =
      opts.managementUrl ?? (opts.livemode ? ADYEN_LIVE_MANAGEMENT_URL : ADYEN_TEST_MANAGEMENT_URL);
    this.capabilities = {
      refunds: true,
      partialRefunds: true,
      mandateCurrencyAuthoritative: ["sepa_debit"],
      // The merchant account settles what Adyen enables for it; an unsupported one is refused.
      currencies: [],
      // SEPA Direct Debit is EUR only (`currencyBoundMethods` in the catalogue).
      methods: ["card", "sepa_debit"],
      intents: true,
      intentPurposes: ["payment", "setup"],
      // An authorisation is cancelled without moving money.
      intentVoid: true,
      // No per-debit ceiling on a stored card or a SEPA mandate (India e-mandates are not
      // offered here). SEPA's own cap is Adyen's per-debit limit, not a mandate field.
      mandates: false,
      locateByReplay: { keyValidMs: ADYEN_REPLAY_WINDOW_MS },
    };
  }

  // ── transport ──

  private send(
    operation: string,
    method: string,
    url: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<ProviderFetchResult> {
    return providerFetch({
      gatewayKey: this.key,
      operation,
      method,
      url,
      headers: {
        "X-API-Key": this.opts.apiKey,
        "Content-Type": "application/json",
        ...(idempotencyKey
          ? { "Idempotency-Key": boundedProviderKey(idempotencyKey, IDEMPOTENCY_MAX) }
          : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  private async http(
    operation: string,
    method: string,
    url: string,
    body?: unknown,
    idempotencyKey?: string,
  ) {
    return this.read(operation, await this.send(operation, method, url, body, idempotencyKey));
  }

  private read(operation: string, res: ProviderFetchResult): Record<string, unknown> {
    if (res.status >= 500 || res.status === 429)
      throw new ProviderIndeterminateError(
        `Adyen answered ${operation} with HTTP ${res.status}. We could not confirm the outcome.`,
      );
    if (res.status === 401 || res.status === 403)
      throw new Error(`Adyen refused the API key (HTTP ${res.status}) on ${operation}`);
    let json: Record<string, unknown> = {};
    if (res.text) {
      try {
        json = JSON.parse(res.text) as Record<string, unknown>;
      } catch {
        throw new ProviderIndeterminateError(
          `We could not read Adyen's answer to ${operation} (HTTP ${res.status}).`,
        );
      }
    }
    if (res.status >= 400)
      throw new AdyenApiError(
        operation,
        res.status,
        typeof json.errorCode === "string" ? json.errorCode : undefined,
        typeof json.message === "string" ? json.message : res.text.slice(0, 200),
        typeof json.errorType === "string" ? json.errorType : undefined,
      );
    return json;
  }

  /**
   * A money call. A lost answer, 408, 409, 429, 5xx or `transient-error: true` is retried
   * under the SAME key, which answers the original. Error 704 ("request already processed
   * or in progress") is never a definite failure. Retries exhausted = indeterminate.
   * https://docs.adyen.com/development-resources/api-idempotency
   */
  private async money<T>(
    operation: string,
    path: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<T> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 1; ; attempt++) {
      let res: ProviderFetchResult | null = null;
      try {
        res = await this.send(operation, "POST", this.checkoutUrl + path, body, idempotencyKey);
      } catch {
        // No answer: the request may have been processed.
      }
      const cls = classifyGatewayHttp({
        status: res?.status ?? null,
        networkError: !res,
        retryAfter: res?.headers.get("retry-after") ?? null,
      });
      const failed = res && res.status >= 400 ? res : null;
      const transient = failed?.headers.get("transient-error")?.toLowerCase() === "true";
      const inFlight = !!failed && adyenErrorCode(failed.text) === "704";
      const retry = cls.kind === "retry_same_key" || transient;
      if (res && !retry && !inFlight) return this.read(operation, res) as T;
      const wait =
        (cls.kind === "retry_same_key" ? cls.retryAfterMs : null) ??
        RETRY_WAIT_MS * 2 ** (attempt - 1);
      if (!retry || attempt >= MONEY_ATTEMPTS || wait > RETRY_WAIT_MAX_MS)
        throw new ProviderIndeterminateError(
          inFlight
            ? `Adyen is still processing an earlier ${operation} request with this key (error 704). We do not know whether it completed.`
            : res
              ? `Adyen answered ${operation} with HTTP ${res.status}. We could not confirm the outcome.`
              : `We could not reach Adyen for ${operation}, so we do not know whether it completed. Retry later.`,
        );
      await sleep(wait);
    }
  }

  private amount(amountMinor: bigint, currency: string) {
    return { value: toAdyenValue(amountMinor, currency), currency: currency.toUpperCase() };
  }

  /** A refusal the decline rules recognise, or undefined (then the caller throws). */
  private classifiedApiFailure(err: AdyenApiError): ChargeResult["failure"] | undefined {
    const code = err.signalCode;
    const f = normalizeAdyenDecline({ code, message: err.detail });
    if (!f.ruleId) return undefined;
    return {
      code: f.code,
      ...(code ? { providerCode: code } : {}),
      message: f.message ?? err.detail,
      retriable: f.retriable,
      ruleId: f.ruleId,
    };
  }

  private async pay(operation: string, body: Record<string, unknown>, idempotencyKey: string) {
    try {
      return chargeResultFromPayment(
        await this.money<AdyenPaymentResponse>(operation, "/payments", body, idempotencyKey),
      );
    } catch (e) {
      if (!(e instanceof AdyenApiError)) throw e;
      const failure = this.classifiedApiFailure(e);
      if (failure)
        return {
          status: "failed" as const,
          providerChargeId: "",
          failure,
          raw: { error: e.message },
        };
      throw e;
    }
  }

  async healthCheck(input?: HealthCheckInput): Promise<HealthCheckResult> {
    await this.http("payment_methods", "POST", `${this.checkoutUrl}/paymentMethods`, {
      merchantAccount: this.opts.merchantAccount,
    });
    const origins = adyenAllowedOriginsCheck({
      ...(await this.readAllowedOrigins()),
      storefront: input?.storefrontOrigins ?? [],
      livemode: this.opts.livemode,
    });
    const failed = origins.status === "failed";
    return {
      ok: !failed,
      detail: failed ? origins.message : `merchantAccount=${this.opts.merchantAccount}`,
      checks: [origins],
    };
  }

  /** The credential's Allowed origins (any Management API role reads them), or why not. */
  private async readAllowedOrigins(): Promise<{
    allowed: string[] | null;
    credential?: string;
    error?: string;
  }> {
    try {
      const [list, me] = await Promise.all([
        this.http("list_allowed_origins", "GET", `${this.managementUrl}/me/allowedOrigins`),
        this.http("read_api_credential", "GET", `${this.managementUrl}/me`).catch(() => null),
      ]);
      const data = (list.data as Array<{ domain?: string }> | undefined) ?? [];
      const credential = typeof me?.username === "string" ? me.username : undefined;
      return {
        allowed: data.map((o) => o.domain ?? "").filter(Boolean),
        ...(credential ? { credential } : {}),
      };
    } catch (e) {
      const refused = e instanceof Error && /^Adyen refused the API key/.test(e.message);
      return { allowed: null, error: refused ? "no_role" : "unread" };
    }
  }

  // ── customers ──

  /** No customer object: our customer ref is the shopperReference. */
  async ensureCustomer(input: EnsureCustomerInput): Promise<ProviderCustomerRef> {
    return { providerKey: this.key, providerCustomerId: input.customerRef };
  }

  // ── stored cards ──

  private async listStored(shopperReference: string): Promise<AdyenStoredMethod[]> {
    const q = new URLSearchParams({ merchantAccount: this.opts.merchantAccount, shopperReference });
    const json = await this.http(
      "stored_payment_methods",
      "GET",
      `${this.checkoutUrl}/storedPaymentMethods?${q.toString()}`,
    );
    return (json.storedPaymentMethods as AdyenStoredMethod[] | undefined) ?? [];
  }

  private async readStored(shopperReference: string, token: string) {
    return (await this.listStored(shopperReference)).find((m) => m.id === token) ?? null;
  }

  private storedRef(
    shopperReference: string,
    m: AdyenStoredMethod,
    setupPsp?: string,
  ): ProviderPaymentMethodRef {
    return {
      providerKey: this.key,
      providerPaymentMethodId: m.id,
      providerCustomerId: shopperReference,
      display: describeAdyenStoredMethod(m),
      // A SEPA mandate rail makes the engine send the payer our pre-debit notice, which the
      // SEPA rulebook requires from the merchant before each debit.
      ...(isSepa(m)
        ? {
            mandate: {
              rail: ADYEN_SEPA_RAIL,
              currency: "EUR",
              status: "active",
              ...(setupPsp ? { reference: setupPsp } : {}),
            },
          }
        : {}),
    };
  }

  /** `token` is a setup result (`adypm_…`) or a bare storedPaymentMethodId of this customer. */
  async vaultPaymentMethod(input: VaultPaymentMethodInput): Promise<ProviderPaymentMethodRef> {
    const decoded = decodeStoredMethod(input.token);
    const shopper = decoded?.shopperReference ?? input.customer.providerCustomerId;
    const token = decoded?.token ?? input.token;
    const m = await this.readStored(shopper, token);
    if (!m)
      throw new ProviderRefusalError(
        "We could not save this payment method. Adyen has no stored payment method with this reference for this customer.",
      );
    return this.storedRef(shopper, m, decoded?.setupPsp);
  }

  async fetchVaultedPaymentMethod(input: {
    providerCustomerId: string;
    providerPaymentMethodId: string;
  }): Promise<ProviderPaymentMethodRef | null> {
    const m = await this.readStored(input.providerCustomerId, input.providerPaymentMethodId);
    return m ? this.storedRef(input.providerCustomerId, m) : null;
  }

  async fetchPaymentMethodDisplay(input: {
    providerPaymentMethodId: string;
    providerCustomerId?: string;
  }): Promise<ProviderPaymentMethodRef["display"] | null> {
    const decoded = decodeStoredMethod(input.providerPaymentMethodId);
    const shopper = decoded?.shopperReference ?? input.providerCustomerId;
    if (!shopper) return null;
    const m = await this.readStored(shopper, decoded?.token ?? input.providerPaymentMethodId);
    return m ? describeAdyenStoredMethod(m) : null;
  }

  async deletePaymentMethod(input: {
    customer: ProviderCustomerRef;
    paymentMethod: ProviderPaymentMethodRef;
  }): Promise<void> {
    const shopper = input.paymentMethod.providerCustomerId ?? input.customer.providerCustomerId;
    const q = new URLSearchParams({
      merchantAccount: this.opts.merchantAccount,
      shopperReference: shopper,
    });
    try {
      await this.http(
        "delete_stored_payment_method",
        "DELETE",
        `${this.checkoutUrl}/storedPaymentMethods/${encodeURIComponent(input.paymentMethod.providerPaymentMethodId)}?${q.toString()}`,
      );
    } catch (e) {
      if (e instanceof AdyenApiError && /not found/i.test(e.detail)) {
        log.info("gateway delete skipped — the card was already gone at Adyen", {
          event: "adyen_delete_already_gone",
        });
        return;
      }
      throw e;
    }
  }

  // ── money ──

  /** The `/payments` body of a stored-card charge. `locateCharge` rebuilds it to replay. */
  private chargeBody(p: {
    ref: string;
    amountMinor: bigint;
    currency: string;
    providerPaymentMethodId: string;
    providerCustomerId: string | null | undefined;
    /** Our method type; SEPA sends `sepadirectdebit`, everything else `scheme`. */
    methodType?: string | null;
    initiator?: ChargeInitiator;
    email?: string;
  }): Record<string, unknown> {
    const decoded = decodeStoredMethod(p.providerPaymentMethodId);
    if (p.methodType === "sepa_debit" && p.currency.toUpperCase() !== "EUR")
      throw new ProviderRefusalError(
        `Adyen takes SEPA Direct Debit in EUR only, and this charge is in ${p.currency.toUpperCase()}.`,
      );
    return {
      merchantAccount: this.opts.merchantAccount,
      amount: this.amount(p.amountMinor, p.currency),
      reference: adyenReference(ADYEN_REF.charge, p.ref),
      paymentMethod: {
        type: adyenTxVariant(p.methodType),
        storedPaymentMethodId: decoded?.token ?? p.providerPaymentMethodId,
      },
      shopperReference: decoded?.shopperReference ?? p.providerCustomerId,
      ...adyenStoredCredential(p.initiator),
      // Capture with the authorisation, whatever the merchant account's default.
      captureDelayHours: 0,
      metadata: { [ADYEN_OWNERSHIP_KEY]: p.ref },
      ...(p.email ? { shopperEmail: p.email } : {}),
    };
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    return this.pay(
      "charge",
      this.chargeBody({
        ref: input.ownershipRef ?? input.idempotencyKey,
        amountMinor: input.amountMinor,
        currency: input.currency,
        providerPaymentMethodId: input.paymentMethod.providerPaymentMethodId,
        providerCustomerId:
          input.paymentMethod.providerCustomerId ?? input.customer.providerCustomerId,
        methodType: input.paymentMethod.display?.type ?? null,
        ...(input.initiator ? { initiator: input.initiator } : {}),
        ...(input.email ? { email: input.email } : {}),
      }),
      input.idempotencyKey,
    );
  }

  /**
   * Checkout has no payment lookup, so the lost create is resent under its own key: Adyen
   * answers a processed request with its first response "without duplication", and makes a
   * request it never received now — which is why the engine sets `replay` only while the
   * money is still owed. Never returns null: an answer that names no payment throws, and
   * so do 704 (still in flight), any 4xx and an unreachable API.
   * https://docs.adyen.com/development-resources/api-idempotency
   */
  async locateCharge(input: LocateChargeInput): Promise<ChargeResult | null> {
    if (!input.replay)
      throw new Error(
        "Adyen has no payment lookup; only a same-key replay can find this charge, and none was allowed",
      );
    if (!input.paymentMethod)
      throw new Error("We cannot rebuild the Adyen charge: the payment method is not known");
    if (Date.now() - input.createdAfter.getTime() > ADYEN_REPLAY_WINDOW_MS)
      throw new Error(
        "The Adyen idempotency key may have expired, so a replay could charge again. Check the Customer Area by merchant reference.",
      );
    const body = this.chargeBody({
      ref: input.ownershipRef,
      amountMinor: input.amountMinor,
      currency: input.currency,
      providerPaymentMethodId: input.paymentMethod.providerPaymentMethodId,
      providerCustomerId: input.paymentMethod.providerCustomerId,
      methodType: input.paymentMethod.type ?? null,
      ...input.replay,
    });
    const res = await this.money<AdyenPaymentResponse>(
      "charge_replay",
      "/payments",
      body,
      input.idempotencyKey,
    );
    const amount = minorOf(res.amount);
    if (
      !res.pspReference ||
      (res.merchantReference && res.merchantReference !== body.reference) ||
      (amount !== undefined && amount !== input.amountMinor) ||
      (res.amount?.currency && res.amount.currency.toUpperCase() !== input.currency.toUpperCase())
    )
      throw new ProviderIndeterminateError(
        "Adyen's answer to the replayed charge does not name this payment. We could not confirm the outcome.",
      );
    return chargeResultFromPayment(res);
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const ref = adyenReference(ADYEN_REF.refund, input.ownershipRef ?? input.idempotencyKey);
    const psp = encodeURIComponent(input.providerChargeId);
    if (input.amountMinor != null && !input.currency)
      throw new Error("A partial Adyen refund needs the charge currency");
    // Full: `reversals` cancels an uncaptured payment or refunds a captured one.
    const [path, body] =
      input.amountMinor == null
        ? [
            `/payments/${psp}/reversals`,
            { merchantAccount: this.opts.merchantAccount, reference: ref },
          ]
        : [
            `/payments/${psp}/refunds`,
            {
              merchantAccount: this.opts.merchantAccount,
              amount: this.amount(input.amountMinor, input.currency!),
              reference: ref,
            },
          ];
    let res: { pspReference?: string; status?: string };
    try {
      res = await this.money("refund", path, body, input.idempotencyKey);
    } catch (e) {
      if (e instanceof AdyenApiError && e.status === 422)
        throw new ProviderRefusalError(`Adyen refused the refund: ${e.detail}`);
      throw e;
    }
    // Accepted ("received"); REFUND / CANCEL_OR_REFUND webhooks give the verdict.
    return { status: "pending", providerRefundId: res.pspReference ?? "", raw: res };
  }

  // ── intents ──

  private environment(): string {
    return this.opts.livemode ? "live" : "test";
  }

  private async openSession(p: {
    purpose: IntentPurpose;
    amountMinor: bigint;
    currency: string;
    shopperReference: string;
    ref: string;
    returnUrl: string | undefined;
    idempotencyKey: string;
    contact?: ProviderContact;
    methodTypes?: string[];
  }): Promise<{ intentId: string; authorization: BuyerAuthorization }> {
    if (!p.returnUrl) throw new Error("An Adyen payment session needs a return URL");
    const currency = p.currency.toUpperCase();
    const allowed =
      p.purpose === "setup"
        ? adyenSetupMethods(p.methodTypes, currency)
        : // Google Pay on pay-now only: its token rides the card rail (authorise, capture,
          // refund). We do not save a wallet for renewals.
          ["scheme", "googlepay"];
    const session = (await this.http(
      p.purpose === "setup" ? "create_setup_session" : "create_payment_session",
      "POST",
      `${this.checkoutUrl}/sessions`,
      {
        merchantAccount: this.opts.merchantAccount,
        amount: this.amount(p.amountMinor, currency),
        reference: adyenReference(
          p.purpose === "setup" ? ADYEN_REF.setup : ADYEN_REF.intent,
          p.ref,
        ),
        returnUrl: p.returnUrl,
        shopperReference: p.shopperReference,
        shopperInteraction: "Ecommerce",
        allowedPaymentMethods: allowed,
        metadata: { [ADYEN_OWNERSHIP_KEY]: p.ref },
        ...(p.contact?.email ? { shopperEmail: p.contact.email } : {}),
        // Drop-in 6 refuses to start without a country (measured 2026-10-25).
        ...(p.contact?.country ? { countryCode: p.contact.country.toUpperCase() } : {}),
        ...(p.purpose === "setup"
          ? { storePaymentMethodMode: "enabled", recurringProcessingModel: "Subscription" }
          : // A hold that `consumeIntent` captures or `voidIntent` cancels.
            { additionalData: { manualCapture: "true" } }),
      },
      p.idempotencyKey,
    )) as unknown as AdyenSession;
    return {
      intentId: SESSION_PREFIX + session.id,
      authorization: {
        mode: "sdk",
        sdk: {
          provider: this.key,
          params: {
            clientKey: this.opts.clientKey,
            environment: this.environment(),
            sessionId: session.id,
            sessionData: session.sessionData ?? "",
            ...(p.contact?.country ? { countryCode: p.contact.country.toUpperCase() } : {}),
            purpose: p.purpose,
            // The dialog's title and text name what the buyer enters.
            methods: allowed.join(","),
            ...(p.purpose === "payment"
              ? { amount: minorToDecimalString(p.amountMinor, currency), currency }
              : {}),
          },
        },
      },
    };
  }

  async initiateVaultSetup(input: InitiateVaultSetupInput): Promise<VaultSetupRef> {
    const ref = input.ownershipRef ?? input.returnUrl;
    const s = await this.openSession({
      purpose: "setup",
      amountMinor: 0n,
      currency: input.currency ?? "USD",
      shopperReference: input.customer.providerCustomerId,
      ref,
      returnUrl: input.returnUrl,
      idempotencyKey: `vs_${createHash("sha256").update(ref).digest("hex").slice(0, 24)}`,
      ...(input.contact ? { contact: input.contact } : {}),
      ...(input.methodTypes ? { methodTypes: input.methodTypes } : {}),
    });
    return { setupTokenId: s.intentId, ...s.authorization };
  }

  /**
   * Pay-now Apple Pay on a payment link: Adyen's page and certificate, so no domain of ours
   * is verified. Held like a Drop-in pay-now; the AUTHORISATION webhook names the payment.
   * https://docs.adyen.com/unified-commerce/pay-by-link/create-payment-links/api
   */
  private async hostedApplePay(input: CreateIntentInput, ref: string): Promise<IntentRef> {
    if (!input.returnUrl) throw new Error("An Adyen payment link needs a return URL");
    const currency = input.currency.toUpperCase();
    const link = (await this.http(
      "create_payment_link",
      "POST",
      `${this.checkoutUrl}/paymentLinks`,
      {
        merchantAccount: this.opts.merchantAccount,
        amount: this.amount(input.amountMinor ?? 0n, currency),
        reference: adyenReference(ADYEN_REF.hosted, ref),
        // Shown as a Continue button after the payment.
        returnUrl: input.returnUrl,
        allowedPaymentMethods: ["applepay"],
        reusable: false,
        manualCapture: true,
        shopperReference: input.customer.providerCustomerId,
        metadata: { [ADYEN_OWNERSHIP_KEY]: ref },
        ...(input.expiresAt ? { expiresAt: input.expiresAt.toISOString() } : {}),
        ...(input.contact?.email ? { shopperEmail: input.contact.email } : {}),
        ...(input.contact?.country ? { countryCode: input.contact.country.toUpperCase() } : {}),
      },
      input.idempotencyKey,
    ).catch((e: unknown) => {
      if (e instanceof AdyenApiError && e.status === 422)
        throw new ProviderRefusalError(
          `Adyen refused the Apple Pay payment link: ${e.detail.replace(/\.+$/, "")}. Check that Apple Pay is on the merchant account.`,
        );
      throw e;
    })) as { id?: string; url?: string; status?: string };
    if (!link.id || !link.url)
      throw new Error("Adyen created the payment link without an id or a URL");
    return {
      intentId: ADYEN_LINK_PREFIX + link.id,
      status: "requires_action",
      authorization: { mode: "redirect", approvalUrl: link.url },
      raw: link,
    };
  }

  async createIntent(input: CreateIntentInput): Promise<IntentRef> {
    const ref = input.ownershipRef ?? input.idempotencyKey;
    if (input.hostedWallet === "apple_pay" && input.purpose === "payment" && !input.paymentMethod)
      return this.hostedApplePay(input, ref);
    if (input.purpose === "payment" && input.paymentMethod) {
      // A stored card: authorise now, capture on consume.
      const decoded = decodeStoredMethod(input.paymentMethod.providerPaymentMethodId);
      const charge = await this.pay(
        "authorize",
        {
          merchantAccount: this.opts.merchantAccount,
          amount: this.amount(input.amountMinor ?? 0n, input.currency),
          reference: adyenReference(ADYEN_REF.intent, ref),
          paymentMethod: {
            type: adyenTxVariant(input.paymentMethod.display?.type),
            storedPaymentMethodId: decoded?.token ?? input.paymentMethod.providerPaymentMethodId,
          },
          shopperReference:
            decoded?.shopperReference ??
            input.paymentMethod.providerCustomerId ??
            input.customer.providerCustomerId,
          ...adyenStoredCredential({ by: "merchant", recurring: false }),
          additionalData: { manualCapture: "true" },
          metadata: { [ADYEN_OWNERSHIP_KEY]: ref },
        },
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
        status: charge.status === "succeeded" ? "authorized" : "inited",
        raw: charge.raw,
      };
    }
    const s = await this.openSession({
      purpose: input.purpose,
      amountMinor: input.purpose === "setup" ? 0n : (input.amountMinor ?? 0n),
      currency: input.currency,
      shopperReference: input.customer.providerCustomerId,
      ref,
      returnUrl: input.returnUrl ?? input.cancelUrl,
      idempotencyKey: input.idempotencyKey,
      ...(input.contact ? { contact: input.contact } : {}),
      ...(input.methodTypes ? { methodTypes: input.methodTypes } : {}),
    });
    return { intentId: s.intentId, status: "requires_action", authorization: s.authorization };
  }

  /** The browser's `sessionResult`: read the session and what it produced. */
  async submitClientResult(input: {
    intentId: string;
    purpose: IntentPurpose;
    clientResult: Record<string, string>;
    idempotencyKey: string;
  }): Promise<FetchedIntent> {
    const sessionId = sessionIdOf(input.intentId);
    if (!sessionId) return { intentId: input.intentId, status: "unknown" };
    const invalid = (): FetchedIntent => ({
      intentId: input.intentId,
      status: "failed",
      failure: {
        code: "invalid_client_result",
        message: "The payment details from the browser are not valid. Enter them again.",
      },
    });
    const sessionResult = input.clientResult.sessionResult?.trim();
    const claimed = input.clientResult.sessionId?.trim();
    if (!sessionResult || (claimed && claimed !== sessionId)) return invalid();
    let s: AdyenSessionResult;
    try {
      s = (await this.http(
        "read_session",
        "GET",
        `${this.checkoutUrl}/sessions/${encodeURIComponent(sessionId)}?sessionResult=${encodeURIComponent(sessionResult)}`,
      )) as AdyenSessionResult;
    } catch (e) {
      if (e instanceof AdyenApiError && e.status === 422) return invalid();
      throw e;
    }
    return this.sessionState(input.intentId, input.purpose, s);
  }

  private sessionState(
    intentId: string,
    purpose: IntentPurpose,
    s: AdyenSessionResult,
  ): FetchedIntent {
    const payments = s.payments ?? [];
    const paid = payments.find((p) => p.resultCode === AUTHORISED) ?? payments.at(-1);
    const ad = s.additionalData ?? {};
    // A SEPA setup stores the IBAN at submission; its payment may still read Received.
    if (purpose === "setup" && (s.status === "completed" || s.status === "paymentPending")) {
      const stored =
        paid?.resultCode === AUTHORISED || SETUP_STORED_RESULTS.has(paid?.resultCode ?? "");
      const token =
        ad["tokenization.storedPaymentMethodId"] ?? ad["recurring.recurringDetailReference"];
      const shopper = ad["tokenization.shopperReference"] ?? ad["recurring.shopperReference"];
      if (stored && token && shopper)
        return {
          intentId,
          status: "authorized",
          gatewayIntentId: encodeStoredMethod(shopper, token, paid?.pspReference),
          raw: s,
        };
      if (s.status === "paymentPending" || stored)
        return { intentId, status: "requires_action", raw: s };
    }
    switch (s.status) {
      case "completed": {
        if (paid?.resultCode !== AUTHORISED || purpose === "setup") break;
        const amountMinor = minorOf(paid.amount);
        return {
          intentId,
          status: "authorized",
          ...(paid.pspReference
            ? { gatewayIntentId: paid.pspReference, providerChargeId: paid.pspReference }
            : {}),
          ...(amountMinor != null ? { amountMinor, currency: paid.amount!.currency! } : {}),
          ...adyenMethodUsed(paid.paymentMethod?.type),
          raw: s,
        };
      }
      case "refused":
        return {
          intentId,
          status: "failed",
          ...(paid?.pspReference ? { providerChargeId: paid.pspReference } : {}),
          failure: {
            code: "card_declined",
            message: "The card was refused. Use a different card, or contact your bank.",
          },
          raw: s,
        };
      case "canceled":
        return {
          intentId,
          status: "failed",
          failure: { code: "authorization_failed", message: "The payment was cancelled." },
          raw: s,
        };
      case "expired":
        return {
          intentId,
          status: "failed",
          failure: { code: "intent_expired", message: "The payment form expired. Start again." },
          raw: s,
        };
    }
    // active / paymentPending / anything newer: not decided yet.
    return { intentId, status: "requires_action", raw: s };
  }

  async consumeIntent(input: ConsumeIntentInput): Promise<ConsumeIntentResult> {
    if (sessionIdOf(input.intentId))
      throw new Error(
        "This Adyen intent has no result from the browser yet. Submit the client result first",
      );
    if (input.intentId.startsWith(ADYEN_LINK_PREFIX))
      throw new Error(
        "This Adyen payment link names no payment yet. Its AUTHORISATION webhook gives the pspReference",
      );
    if (input.purpose === "setup") {
      const d = decodeStoredMethod(input.intentId);
      if (!d) throw new Error(`Not an Adyen setup result: ${input.intentId}`);
      const m = await this.readStored(d.shopperReference, d.token);
      if (!m) throw new Error(`Adyen has no stored payment method ${d.token} for this shopper`);
      return {
        purpose: "setup",
        paymentMethod: this.storedRef(d.shopperReference, m, d.setupPsp),
      };
    }
    if (input.amountMinor == null || !input.currency)
      throw new Error("An Adyen capture needs the amount and the currency");
    const res = await this.money<{ pspReference?: string; status?: string }>(
      "capture",
      `/payments/${encodeURIComponent(input.intentId)}/captures`,
      {
        merchantAccount: this.opts.merchantAccount,
        amount: this.amount(input.amountMinor, input.currency),
        reference: adyenReference(ADYEN_REF.capture, input.idempotencyKey),
      },
      input.idempotencyKey,
    );
    // Accepted; a later CAPTURE_FAILED reopens it as a reversal.
    return {
      purpose: "payment",
      charge: { status: "succeeded", providerChargeId: input.intentId, raw: res },
    };
  }

  async voidIntent(input: VoidIntentInput): Promise<VoidIntentResult> {
    // A zero-amount setup holds nothing.
    if (decodeStoredMethod(input.intentId)) return { voided: true, held: false };
    // An unused session has nothing to cancel; one the buyer paid without returning is not
    // addressable without its pspReference, so we cannot say whether money is held.
    if (sessionIdOf(input.intentId)) return { voided: true };
    if (input.intentId.startsWith(ADYEN_LINK_PREFIX)) return this.expireLink(input.intentId);
    const res = await this.money<{ pspReference?: string; status?: string }>(
      "cancel",
      `/payments/${encodeURIComponent(input.intentId)}/cancels`,
      {
        merchantAccount: this.opts.merchantAccount,
        reference: adyenReference(ADYEN_REF.cancel, input.idempotencyKey),
      },
      input.idempotencyKey,
    );
    // Accepted; CANCELLATION confirms it.
    return {
      voided: res.status === "received",
      ...(res.pspReference ? { providerTransactionId: res.pspReference } : {}),
    };
  }

  /** Close an unpaid link. A paid one is not addressable here: its webhook names the payment. */
  private async expireLink(intentId: string): Promise<VoidIntentResult> {
    const url = `${this.checkoutUrl}/paymentLinks/${encodeURIComponent(intentId.slice(ADYEN_LINK_PREFIX.length))}`;
    const link = (await this.http("read_payment_link", "GET", url)) as { status?: string };
    if (link.status === "expired") return { voided: true, held: false };
    if (link.status !== "active") return { voided: true };
    const after = (await this.http("expire_payment_link", "PATCH", url, {
      status: "expired",
    })) as { status?: string };
    return after.status === "expired" ? { voided: true, held: false } : { voided: true };
  }

  // ── webhook endpoint ──

  /**
   * Register (or reuse) a standard webhook for `url` and mint its HMAC key. Needs the
   * credential role "Management API — Webhooks read and write".
   */
  async provisionWebhookEndpoint(input: { url: string }): Promise<ProvisionedWebhook> {
    const base = `${this.managementUrl}/merchants/${encodeURIComponent(this.opts.merchantAccount)}/webhooks`;
    let list: { data?: Array<{ id?: string; url?: string; type?: string; active?: boolean }> };
    try {
      list = (await this.http("list_webhooks", "GET", `${base}?pageSize=100`)) as typeof list;
    } catch (e) {
      if (e instanceof Error && /^Adyen refused the API key/.test(e.message))
        throw new Error(
          'The Adyen API credential cannot manage webhooks. Add the role "Management API — Webhooks read and write" to it, then try again.',
        );
      throw e;
    }
    const existing = (list.data ?? []).find((w) => w.type === "standard" && w.url === input.url);
    let id = existing?.id;
    if (!id) {
      const created = (await this.http("create_webhook", "POST", base, {
        type: "standard",
        url: input.url,
        active: true,
        communicationFormat: "json",
        description: "tmbilling",
        // Chargeback reversals then name the payment they reverse.
        additionalSettings: { properties: { includeOriginalReferenceForChargebackReversed: true } },
      })) as { id?: string };
      id = created.id;
    } else if (existing?.active === false) {
      await this.http("activate_webhook", "PATCH", `${base}/${encodeURIComponent(id)}`, {
        active: true,
      });
    }
    if (!id) throw new Error("Adyen created the webhook but returned no id");
    const hmac = (await this.http(
      "generate_webhook_hmac",
      "POST",
      `${base}/${encodeURIComponent(id)}/generateHmac`,
    )) as { hmacKey?: string };
    if (!hmac.hmacKey) throw new Error("Adyen returned no HMAC key for the webhook");
    return { webhookSecret: hmac.hmacKey, providerEndpointId: id };
  }

  async removeWebhookEndpoint(input: { url: string }): Promise<WebhookRemoval> {
    const base = `${this.managementUrl}/merchants/${encodeURIComponent(this.opts.merchantAccount)}/webhooks`;
    const list = (await this.http("list_webhooks", "GET", `${base}?pageSize=100`)) as {
      data?: Array<{ id?: string; url?: string }>;
    };
    let removed = false;
    for (const w of list.data ?? []) {
      if (!w.id || w.url !== input.url) continue;
      await this.http("delete_webhook", "DELETE", `${base}/${encodeURIComponent(w.id)}`);
      removed = true;
    }
    return { removed };
  }

  // ── webhooks ──

  /** One item: its own id. Several: a hash of their ids (each event keeps its own id). */
  webhookEventId(input: NormalizeWebhookInput): string {
    let ids: string[] = [];
    try {
      ids = parseAdyenNotification(input.payload).map(adyenItemEventId);
    } catch {
      // Not JSON: the body hash below.
    }
    if (ids.length === 1) return ids[0]!;
    if (ids.length > 1)
      return `adybatch:${createHash("sha256")
        .update([...ids].sort().join(","))
        .digest("hex")}`;
    return webhookEventId([], input.payload);
  }

  /** Every item must carry a valid HMAC signature; one bad item rejects the delivery. */
  async normalizeWebhook(input: NormalizeWebhookInput): Promise<NormalizedProviderEvent[]> {
    if (!this.opts.hmacKey)
      throw new Error(
        "The Adyen webhook HMAC key is not configured. Register the webhook on the gateway account's webhook card.",
      );
    const items = parseAdyenNotification(input.payload);
    for (const item of items)
      if (!verifyAdyenItem(this.opts.hmacKey, item))
        throw new Error(
          `Adyen webhook HMAC signature verification failed (${item.eventCode ?? "?"} ${item.pspReference ?? "?"})`,
        );
    return items.flatMap((item) => normalizeAdyenItem(item, adyenItemEventId(item)));
  }
}
