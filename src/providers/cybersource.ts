/**
 * CyberSource adapter, over the REST API with HTTP Signature auth (no SDK).
 *
 * Cards and bank accounts live in the Token Management Service (TMS): one TMS customer per
 * customer, one payment instrument per card or bank account. `providerCustomerId` is the TMS
 * customer id and `providerPaymentMethodId` the payment instrument id. CyberSource's own
 * Recurring Billing is never used: the engine owns subscription state.
 *
 * Buyer flow (`mode: 'sdk'`): the browser loads Microform with a capture context we create
 * (`/microform/v2/sessions`) and gets back a transient token (valid 15 minutes).
 * `submitClientResult` turns a card token into a stored instrument with a zero-amount
 * authorization (the customer-initiated transaction that starts the stored credential), or
 * authorizes a payment with it. A bank-account token pays once by eCheck (WEB).
 *
 * Idempotency: no header exists on `/pts/v2/payments`. Every money call sends our reference
 * as `clientReferenceInformation.code` and `.transactionId`; a repeat answers 400
 * DUPLICATE_REQUEST (measured 2026-10-25) and the original is found with Transaction Search.
 *
 * Measured on the sandbox (2026-10-25): `v-c-merchant-id` must be the Organization ID; the
 * webhook API wants `securityType: "key"` (lowercase); a webhook URL with a query string is
 * accepted (stored with `:443` added); a new digital signature key gets a new key id each time.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { decimalToMinor, minorToDecimalString } from "@/platform/currency";
import { createLogger } from "@/platform/logger";
import { normalizeCybersourceDecline, type DeclineSignal } from "./decline-codes";
import { boundedProviderKey, providerFetch } from "./http";
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
  type InitiateVaultSetupInput,
  type IntentPurpose,
  type IntentRef,
  type NormalizeWebhookInput,
  type NormalizedProviderEvent,
  type PaymentProvider,
  type ProviderCapabilities,
  type ProviderCustomerRef,
  type ProviderPaymentMethodRef,
  type ProvisionedWebhook,
  type RefundInput,
  type RefundResult,
  type VaultPaymentMethodInput,
  type VaultSetupRef,
  type VoidIntentInput,
  type VoidIntentResult,
} from "./types";
import { headerValue, webhookEventId } from "./webhook-event-id";

const log = createLogger("cybersource");

export const CYBERSOURCE_SANDBOX_HOST = "https://apitest.cybersource.com";
export const CYBERSOURCE_LIVE_HOST = "https://api.cybersource.com";
/** Microform's script and iframes (sandbox measured; live per CyberSource's docs). */
export const CYBERSOURCE_FLEX_ORIGINS = [
  "https://testflex.cybersource.com",
  "https://flex.cybersource.com",
] as const;

/** `clientReferenceInformation.transactionId` caps at 30; the code shares the value. */
const REFERENCE_LEN = 30;
const OUR_REFERENCE = /^tm[0-9a-f]{28}$/;
const SYNTHETIC_PREFIX = "csi_";
const VAULTED_PREFIX = "pi:";
const ACH_PREFIX = "ach:";

/** The events we subscribe to, per webhook product, when the account has them unencrypted. */
export const CYBERSOURCE_WEBHOOK_EVENTS: Record<string, readonly string[]> = {
  tokenManagement: ["tms.networktoken.updated"],
  decisionManager: [
    "risk.casemanagement.decision.accept",
    "risk.casemanagement.decision.reject",
    "risk.profile.decision.reject",
  ],
  fraudManagementEssentials: [
    "risk.casemanagement.decision.accept",
    "risk.casemanagement.decision.reject",
    "risk.profile.decision.reject",
    "risk.profile.decision.review",
  ],
  // eCheck outcomes, including late returns. Needs the eCheck service.
  eCheck: [
    "payments.payments.accepted",
    "payments.payments.failed",
    "payments.credits.accepted",
    "payments.credits.failed",
  ],
};

// ── Transport ──────────────────────────────────────────────────────────────

export interface CybersourceAuth {
  organizationId: string;
  keyId: string;
  /** Base64, as the Business Center shows it. */
  sharedSecret: string;
}

/**
 * HTTP Signature headers for one request: HMAC-SHA256 over `host`, `date`, `request-target`,
 * `digest` (with a body) and `v-c-merchant-id`, keyed with the base64-decoded secret.
 */
export function signCybersourceRequest(
  auth: CybersourceAuth,
  req: { host: string; method: string; path: string; body?: string; date: string },
): Record<string, string> {
  const names = ["host", "date", "request-target"];
  const lines = [
    `host: ${req.host}`,
    `date: ${req.date}`,
    `request-target: ${req.method.toLowerCase()} ${req.path}`,
  ];
  const headers: Record<string, string> = {
    host: req.host,
    date: req.date,
    "v-c-merchant-id": auth.organizationId,
  };
  if (req.body !== undefined) {
    const digest = `SHA-256=${createHash("sha256").update(req.body).digest("base64")}`;
    headers.digest = digest;
    names.push("digest");
    lines.push(`digest: ${digest}`);
  }
  names.push("v-c-merchant-id");
  lines.push(`v-c-merchant-id: ${auth.organizationId}`);
  const sig = createHmac("sha256", Buffer.from(auth.sharedSecret, "base64"))
    .update(lines.join("\n"))
    .digest("base64");
  headers.signature = `keyid="${auth.keyId}", algorithm="HmacSHA256", headers="${names.join(" ")}", signature="${sig}"`;
  return headers;
}

/** Our 30-char reference for an idempotency key: same key, same reference. */
export function cybersourceReference(idempotencyKey: string): string {
  return `tm${createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, REFERENCE_LEN - 2)}`;
}

const toMinor = (v: string | number | undefined | null, currency: string): bigint | undefined =>
  v == null || v === "" ? undefined : decimalToMinor(String(v), currency);

// ── Stored credentials ─────────────────────────────────────────────────────

export interface CybersourceProcessing {
  commerceIndicator: string;
  authorizationOptions: {
    initiator: {
      type: "customer" | "merchant";
      storedCredentialUsed: true;
      merchantInitiatedTransaction?: { reason: string };
    };
  };
}

const MIT_REASON_BRANDS = new Set(["amex", "discover", "mastercard"]);

/**
 * Card-on-file fields for a charge on a stored TMS instrument, per CyberSource's credentialed
 * transactions guide. TMS keeps the original network transaction id, so no
 * `previousTransactionId` is sent.
 *  - merchant + recurring → `recurring` (reason 7 for Mastercard).
 *  - merchant, not recurring, or unknown → unscheduled card on file: `internet`, reason 10
 *    for American Express, Discover and Mastercard.
 *  - customer → `internet`, the buyer uses a stored card.
 */
export function cybersourceStoredCredential(
  initiator: ChargeInitiator | undefined,
  brand?: string | null,
): CybersourceProcessing {
  const b = (brand ?? "").toLowerCase();
  if (initiator?.by === "customer")
    return {
      commerceIndicator: "internet",
      authorizationOptions: { initiator: { type: "customer", storedCredentialUsed: true } },
    };
  if (initiator?.recurring)
    return {
      commerceIndicator: "recurring",
      authorizationOptions: {
        initiator: {
          type: "merchant",
          storedCredentialUsed: true,
          ...(b === "mastercard" ? { merchantInitiatedTransaction: { reason: "7" } } : {}),
        },
      },
    };
  return {
    commerceIndicator: "internet",
    authorizationOptions: {
      initiator: {
        type: "merchant",
        storedCredentialUsed: true,
        ...(MIT_REASON_BRANDS.has(b) ? { merchantInitiatedTransaction: { reason: "10" } } : {}),
      },
    },
  };
}

/**
 * eCheck fields. The payer authorizes online, so personal accounts debit as WEB (one-time or
 * recurring); a business checking account as CCD. PPD needs a written authorization.
 */
export function cybersourceEcheckProcessing(
  initiator: ChargeInitiator | undefined,
  accountType?: string | null,
): { commerceIndicator: string; bankTransferOptions: { secCode: "WEB" | "CCD" } } {
  const business = /corporate/i.test(accountType ?? "") || accountType === "X";
  return {
    commerceIndicator: initiator?.recurring ? "recurring" : "internet",
    bankTransferOptions: { secCode: business ? "CCD" : "WEB" },
  };
}

// ── Outcomes ───────────────────────────────────────────────────────────────

const BRAND: Record<string, string> = {
  "001": "visa",
  "002": "mastercard",
  "003": "amex",
  "004": "discover",
  "005": "diners",
  "007": "jcb",
  "036": "cartes_bancaires",
  "042": "maestro",
  "062": "unionpay",
};
export const cybersourceBrand = (type?: string | null) =>
  type ? (BRAND[type] ?? type.toLowerCase()) : null;

export interface CsPaymentResponse {
  id?: string;
  status?: string;
  reason?: string;
  message?: string;
  details?: Array<{ field?: string; reason?: string }>;
  submitTimeUtc?: string;
  clientReferenceInformation?: { code?: string };
  errorInformation?: {
    reason?: string;
    message?: string;
    details?: Array<{ field?: string; reason?: string }>;
  };
  processorInformation?: {
    responseCode?: string;
    networkTransactionId?: string;
    merchantAdvice?: { code?: string };
  };
  paymentInformation?: { card?: { type?: string }; tokenizedCard?: { type?: string } };
  orderInformation?: {
    amountDetails?: { totalAmount?: string; authorizedAmount?: string; currency?: string };
  };
  tokenInformation?: {
    customer?: { id?: string };
    paymentInstrument?: { id?: string };
    instrumentIdentifier?: { id?: string };
  };
  [k: string]: unknown;
}

export function cybersourceDeclineSignal(r: CsPaymentResponse): DeclineSignal {
  const reason = r.errorInformation?.reason ?? r.reason;
  const details = r.errorInformation?.details ?? r.details;
  return {
    code: reason ?? null,
    declineCode: details?.[0]?.field ?? null,
    message: r.errorInformation?.message ?? r.message ?? null,
    // The first field CyberSource names (e.g. `tokenInformation.jti`, measured); rules read it.
    category: details?.[0]?.field ?? null,
    networkMessage: r.processorInformation?.responseCode ?? null,
    recommendationCode: r.processorInformation?.merchantAdvice?.code ?? null,
    cardBrand: cybersourceBrand(
      r.paymentInformation?.card?.type ?? r.paymentInformation?.tokenizedCard?.type,
    ),
  };
}

export function cybersourceFailure(sig: DeclineSignal): NonNullable<ChargeResult["failure"]> {
  const f = normalizeCybersourceDecline(sig);
  return {
    code: f.code,
    ...(sig.code ? { providerCode: sig.code } : {}),
    message: f.message ?? sig.message ?? "CyberSource declined this payment.",
    retriable: f.retriable,
    ...(f.retryAfterMs ? { retryAfterMs: f.retryAfterMs } : {}),
    ...(f.ruleId ? { ruleId: f.ruleId } : {}),
  };
}

export type PaymentKind = "sale" | "authorization" | "echeck";

/**
 * A `/pts/v2/payments` answer as a charge outcome; `duplicate` (look the original up),
 * or `lookup` (SERVER_ERROR: read the transaction before deciding).
 */
export function readPaymentResponse(
  httpStatus: number,
  r: CsPaymentResponse,
  kind: PaymentKind,
): { result: ChargeResult } | { duplicate: true } | { lookup: string } {
  const id = r.id ?? "";
  const reason = r.errorInformation?.reason ?? r.reason;
  if (r.status === "INVALID_REQUEST" && reason === "DUPLICATE_REQUEST") return { duplicate: true };
  if (httpStatus >= 500 || r.status === "SERVER_ERROR") return { lookup: id };
  const failed = (): { result: ChargeResult } => ({
    result: {
      status: "failed",
      providerChargeId: id,
      failure: cybersourceFailure(cybersourceDeclineSignal(r)),
      raw: r,
    },
  });
  switch (r.status) {
    case "AUTHORIZED":
      return { result: { status: "succeeded", providerChargeId: id, raw: r } };
    // eCheck accepted, or a capture queued: the money is not collected yet.
    case "PENDING":
    case "TRANSMITTED":
      return {
        result: {
          status: kind === "echeck" ? "pending" : "succeeded",
          providerChargeId: id,
          raw: r,
        },
      };
    // Held for the merchant's fraud review: a decision event or a poll settles it.
    case "AUTHORIZED_PENDING_REVIEW":
    case "PENDING_REVIEW":
      return { result: { status: "pending", providerChargeId: id, raw: r } };
    case "PENDING_AUTHENTICATION":
      return {
        result: {
          status: "failed",
          providerChargeId: id,
          failure: cybersourceFailure({
            ...cybersourceDeclineSignal(r),
            code: "PENDING_AUTHENTICATION",
          }),
          raw: r,
        },
      };
    case "PARTIAL_AUTHORIZED":
      return {
        result: {
          status: "failed",
          providerChargeId: id,
          failure: cybersourceFailure({
            ...cybersourceDeclineSignal(r),
            code: "PARTIAL_AUTHORIZED",
          }),
          raw: r,
        },
      };
    default:
      return failed();
  }
}

/** One application of a Transaction Search record (`ics_auth`, `ics_bill`, `ics_ecp_debit`…). */
export interface CsApplication {
  name?: string;
  rCode?: string | number;
  rFlag?: string;
  rMessage?: string;
  reasonCode?: string | number;
}

/** A Transaction Search record, the fields we read (detail and search summary shapes). */
export interface CsTransaction {
  id: string;
  submitTimeUTC?: string;
  submitTimeUtc?: string;
  clientReferenceInformation?: { code?: string };
  applicationInformation?: {
    rCode?: string | number;
    rFlag?: string;
    reasonCode?: string | number;
    applications?: CsApplication[];
  };
  orderInformation?: {
    amountDetails?: { totalAmount?: string; authorizedAmount?: string; currency?: string };
  };
  paymentInformation?: {
    card?: { type?: string; suffix?: string };
    paymentType?: { name?: string; type?: string; method?: string };
  };
  processorInformation?: { responseCode?: string };
  errorInformation?: { reason?: string; message?: string };
}

type AppState = "ok" | "declined" | "error" | "timeout" | "absent";

function appState(tx: CsTransaction, name: string): AppState {
  const a = tx.applicationInformation?.applications?.find((x) => x.name === name);
  if (!a || a.rCode == null || a.rCode === "") return "absent";
  const code = String(a.rCode);
  if (code === "1") return "ok";
  if (code === "0") return "declined";
  return /TIMEOUT/i.test(a.rFlag ?? "") ? "timeout" : "error";
}

const appOf = (tx: CsTransaction, name: string) =>
  tx.applicationInformation?.applications?.find((x) => x.name === name);

function txFailure(tx: CsTransaction, app?: CsApplication): NonNullable<ChargeResult["failure"]> {
  return cybersourceFailure({
    code: app?.rFlag ?? tx.applicationInformation?.rFlag ?? tx.errorInformation?.reason ?? null,
    message: app?.rMessage ?? tx.errorInformation?.message ?? null,
    networkMessage: tx.processorInformation?.responseCode ?? null,
    cardBrand: cybersourceBrand(tx.paymentInformation?.card?.type),
  });
}

export const isEcheckTransaction = (tx: CsTransaction) =>
  Boolean(appOf(tx, "ics_ecp_debit")) ||
  /check/i.test(tx.paymentInformation?.paymentType?.name ?? "");

/** A transaction read back, as a charge outcome. `authorization` = an auth-only payment. */
export function chargeResultFromTransaction(
  tx: CsTransaction,
  opts: { authorization?: boolean } = {},
): ChargeResult {
  const base = { providerChargeId: tx.id, raw: tx };
  if (appOf(tx, "ics_ecp_debit")) {
    const s = appState(tx, "ics_ecp_debit");
    if (s === "ok") return { ...base, status: "pending" };
    if (s === "declined" || s === "error")
      return { ...base, status: "failed", failure: txFailure(tx, appOf(tx, "ics_ecp_debit")) };
    return { ...base, status: "pending" };
  }
  const auth = appState(tx, "ics_auth");
  if (auth === "declined" || auth === "error")
    return { ...base, status: "failed", failure: txFailure(tx, appOf(tx, "ics_auth")) };
  if (auth !== "ok") return { ...base, status: "pending" };
  if (appState(tx, "ics_auth_reversal") === "ok" || appState(tx, "ics_void") === "ok")
    return {
      ...base,
      status: "failed",
      failure: { code: "processing_error", message: "The payment was reversed.", retriable: true },
    };
  if (opts.authorization) return { ...base, status: "succeeded" };
  const bill = appState(tx, "ics_bill");
  if (bill === "ok") return { ...base, status: "succeeded" };
  if (bill === "declined" || bill === "error")
    return { ...base, status: "failed", failure: txFailure(tx, appOf(tx, "ics_bill")) };
  // A fraud review holds the capture, or the record has not caught up.
  return { ...base, status: "pending" };
}

/** A refund (credit) read back. A card credit is final when accepted; an eCheck credit settles later. */
export function refundResultFromTransaction(tx: CsTransaction): RefundResult {
  const base = { providerRefundId: tx.id, raw: tx };
  if (appOf(tx, "ics_ecp_credit")) {
    const s = appState(tx, "ics_ecp_credit");
    return { ...base, status: s === "declined" || s === "error" ? "failed" : "pending" };
  }
  const s = appState(tx, "ics_credit");
  if (s === "ok") return { ...base, status: "succeeded" };
  if (s === "declined" || s === "error") return { ...base, status: "failed" };
  if (appState(tx, "ics_void") === "ok") return { ...base, status: "succeeded" };
  return { ...base, status: "pending" };
}

// ── Instruments ────────────────────────────────────────────────────────────

export interface CsPaymentInstrument {
  id?: string;
  default?: boolean;
  state?: string;
  card?: { expirationMonth?: string; expirationYear?: string; type?: string };
  bankAccount?: { type?: string };
  instrumentIdentifier?: { id?: string };
  _embedded?: {
    instrumentIdentifier?: {
      id?: string;
      card?: { number?: string };
      bankAccount?: { number?: string; routingNumber?: string };
    };
  };
}

export function describeCybersourceInstrument(
  pi: CsPaymentInstrument,
): ProviderPaymentMethodRef["display"] {
  const ii = pi._embedded?.instrumentIdentifier;
  if (pi.bankAccount || ii?.bankAccount) {
    const last4 = ii?.bankAccount?.number?.replace(/\D/g, "").slice(-4);
    return { type: "us_bank_account", ...(last4 ? { last4 } : {}) };
  }
  const last4 = ii?.card?.number?.replace(/\D/g, "").slice(-4);
  const brand = cybersourceBrand(pi.card?.type);
  const m = Number(pi.card?.expirationMonth);
  const y = Number(pi.card?.expirationYear);
  return {
    type: "card",
    ...(brand ? { brand } : {}),
    ...(last4 ? { last4 } : {}),
    ...(m >= 1 && m <= 12 && y > 2000 ? { expMonth: m, expYear: y } : {}),
  };
}

const vaultedIntentId = (c: string, pi: string) => `${VAULTED_PREFIX}${c}:${pi}`;
function parseVaultedIntentId(id: string): { c: string; pi: string } | null {
  const m = /^pi:([0-9A-Fa-f]{32}):([0-9A-Fa-f]{32})$/.exec(id);
  return m ? { c: m[1]!, pi: m[2]! } : null;
}

// ── Synthetic intents ──────────────────────────────────────────────────────

/** A not-yet-used challenge. Adapters are stateless, so it rides the id. */
interface SyntheticIntent {
  p: IntentPurpose;
  /** TMS customer id. */
  c?: string;
  /** Amount in minor units (payment). */
  a?: string;
  cur: string;
  /** Our ownership ref. */
  r?: string;
  /** Short hash of the idempotency key, so two intents never share an id. */
  k: string;
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

/** The JWT body, unverified: CyberSource re-checks the token on use. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A transient token's kind, from its masked contents: a bank account or a card. */
export function transientTokenKind(jwt: string): "card" | "check" | null {
  const p = decodeJwtPayload(jwt);
  const pi = (p?.content as { paymentInformation?: Record<string, unknown> } | undefined)
    ?.paymentInformation;
  if (!pi) return null;
  if (pi.bank) return "check";
  if (pi.card) return "card";
  return null;
}

// ── Webhooks ───────────────────────────────────────────────────────────────

/** `webhook_secret` holds `<keyId>:<base64 key>`, as `provisionWebhookEndpoint` stores it. */
export function parseCybersourceWebhookSecret(s: string): { keyId?: string; key: string } {
  const i = s.indexOf(":");
  return i > 0 ? { keyId: s.slice(0, i), key: s.slice(i + 1) } : { key: s };
}

/** `t=…;keyId=…;sig=…`, quotes tolerated (CyberSource's own example carries a stray one). */
export function parseCybersourceSignatureHeader(
  header: string,
): { t: string; keyId?: string; sig: string } | null {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim().replace(/^"/, "").toLowerCase()] = part
      .slice(i + 1)
      .trim()
      .replace(/^"|"$/g, "");
  }
  if (!out.t || !out.sig) return null;
  return { t: out.t, sig: out.sig, ...(out.keyid ? { keyId: out.keyid } : {}) };
}

/**
 * Check `v-c-signature`: base64 HMAC-SHA256 of `<t>.<raw body>`, keyed with the
 * base64-decoded digital signature key (CyberSource's webhook guide). No age limit: the
 * guide does not say whether `t` is the signing time.
 */
export function verifyCybersourceSignature(
  secret: string,
  header: string | undefined,
  rawBody: string | Buffer,
): void {
  if (!header) throw new Error("CyberSource webhook has no v-c-signature header");
  const parsed = parseCybersourceSignatureHeader(header);
  if (!parsed) throw new Error("CyberSource webhook signature header is not t=…;keyId=…;sig=…");
  const { keyId, key } = parseCybersourceWebhookSecret(secret);
  if (keyId && parsed.keyId && parsed.keyId !== keyId)
    throw new Error(
      "CyberSource webhook is signed with another digital signature key. A newer key replaced ours: provision the webhook again",
    );
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const want = createHmac("sha256", Buffer.from(key, "base64"))
    .update(Buffer.concat([Buffer.from(`${parsed.t}.`, "utf8"), body]))
    .digest();
  const given = Buffer.from(parsed.sig, "base64");
  if (want.length !== given.length || !timingSafeEqual(want, given))
    throw new Error("CyberSource webhook signature does not match the payload");
}

/** Sign a body the way CyberSource's guide says it does. For tests and fixtures. */
export function signCybersourceWebhook(secret: string, t: string, body: string): string {
  const { keyId, key } = parseCybersourceWebhookSecret(secret);
  const sig = createHmac("sha256", Buffer.from(key, "base64"))
    .update(`${t}.${body}`)
    .digest("base64");
  return `t=${t};keyId=${keyId ?? ""};sig=${sig}`;
}

export interface CybersourceNotification {
  eventType?: string;
  webhookId?: string;
  productId?: string;
  organizationId?: string;
  eventDate?: string;
  transactionTraceId?: string;
  retryNumber?: number | string;
  requestType?: string;
  payload?: unknown;
}

/**
 * The id a delivery dedupes on. `transactionTraceId` changes on every retry, so it is a
 * digest of what a retry repeats: subscription, event, event date and the payload.
 */
export function cybersourceEventId(n: CybersourceNotification): string | undefined {
  if (!n.eventType || !n.eventDate) return undefined;
  const digest = createHash("sha256")
    .update(
      `${n.webhookId ?? ""}|${n.eventType}|${n.eventDate}|${JSON.stringify(n.payload ?? null)}`,
    )
    .digest("hex");
  return `cybs_${digest.slice(0, 40)}`;
}

const TX_ID = /^\d{18,26}$/;
const HREF_TX =
  /\/(?:pts\/v2\/(?:payments|captures|refunds|credits)|tss\/v2\/transactions)\/(\d{18,26})/;
const HREF_PI = /\/(?:tms\/v1\/paymentinstruments|payment-instruments)\/([0-9A-Fa-f]{32})/g;

/** A transaction id in a notification payload, wherever this event type puts it. */
export function transactionIdOf(payload: unknown): string | null {
  const seen: unknown[] = [payload];
  for (let i = 0; i < seen.length && i < 200; i++) {
    const v = seen[i];
    if (!v || typeof v !== "object") continue;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (typeof x === "string") {
        const h = HREF_TX.exec(x);
        if (h) return h[1]!;
        if (/^(id|transactionId|requestId)$/i.test(k) && TX_ID.test(x)) return x;
      } else if (x && typeof x === "object") seen.push(x);
    }
  }
  return null;
}

/** Payment instrument ids a TMS event links to. */
export function paymentInstrumentIdsOf(payload: unknown): string[] {
  const out = new Set<string>();
  for (const m of JSON.stringify(payload ?? null).matchAll(HREF_PI)) out.add(m[1]!);
  return [...out];
}

const dateOf = (s: string | undefined) => {
  if (!s) return undefined;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

function ownershipOf(tx: CsTransaction | null) {
  if (!tx) return { ownership: "unknown" as const };
  const created = dateOf(tx.submitTimeUtc ?? tx.submitTimeUTC);
  return {
    ownership: OUR_REFERENCE.test(tx.clientReferenceInformation?.code ?? "")
      ? ("ours" as const)
      : ("foreign" as const),
    ...(created ? { providerObjectCreatedAt: created } : {}),
  };
}

function failureFields(f: NonNullable<ChargeResult["failure"]>) {
  return {
    failureCode: f.code,
    failureRetriable: f.retriable,
    ...(f.providerCode ? { providerFailureCode: f.providerCode } : {}),
    failureMessage: f.message,
  };
}

/** ACH return code in an eCheck event payload (`R01`…), if it carries one. */
export function achReturnCodeOf(payload: unknown): string | null {
  const m = /"(?:returnCode|reasonCode|code)"\s*:\s*"(R\d{2})"/.exec(
    JSON.stringify(payload ?? null),
  );
  return m ? m[1]! : null;
}

/**
 * Translate one verified notification. `tx` is the transaction read back with Transaction
 * Search (payloads name it but do not describe it); `instruments` the payment instruments a
 * TMS event links to.
 */
export function normalizeCybersourceNotification(
  n: CybersourceNotification,
  eventId: string,
  raw: unknown,
  ctx: { tx?: CsTransaction | null; instruments?: CsPaymentInstrument[] } = {},
): NormalizedProviderEvent[] {
  const occurredAt = dateOf(n.eventDate) ?? new Date();
  const base = { providerEventId: eventId, occurredAt, raw };
  const tx = ctx.tx ?? null;
  const own = ownershipOf(tx);
  const id = tx?.id ?? transactionIdOf(n.payload);
  const charge = (): NormalizedProviderEvent[] => {
    if (!id) return [];
    if (!tx) return [{ ...base, ...own, type: "charge.pending", providerChargeId: id }];
    const r = chargeResultFromTransaction(tx);
    if (r.status === "succeeded")
      return [{ ...base, ...own, type: "charge.succeeded", providerChargeId: id }];
    if (r.status === "failed")
      return [
        {
          ...base,
          ...own,
          type: "charge.failed",
          providerChargeId: id,
          ...(r.failure ? failureFields(r.failure) : {}),
        },
      ];
    return [{ ...base, ...own, type: "charge.pending", providerChargeId: id }];
  };

  switch (n.eventType) {
    case "tms.networktoken.updated": {
      const out: NormalizedProviderEvent[] = [];
      for (const pi of ctx.instruments ?? []) {
        if (!pi.id || pi.bankAccount) continue;
        const d = describeCybersourceInstrument(pi);
        out.push({
          ...base,
          providerEventId: `${eventId}:${pi.id}`,
          type: "payment_method.updated",
          providerPaymentMethodId: pi.id,
          card: {
            brand: d.brand ?? null,
            last4: d.last4 ?? null,
            expMonth: d.expMonth ?? null,
            expYear: d.expYear ?? null,
          },
        });
      }
      if (out.length) return out;
      break;
    }
    case "risk.profile.decision.review": {
      if (!id) break;
      return [{ ...base, ...own, type: "review.opened", providerChargeId: id }];
    }
    case "risk.casemanagement.decision.accept":
    case "risk.casemanagement.decision.reject": {
      if (!id) break;
      const closed = { ...base, ...own, type: "review.closed" as const, providerChargeId: id };
      if (n.eventType.endsWith("reject") && !tx)
        return [closed, { ...base, ...own, type: "charge.failed", providerChargeId: id }];
      return [closed, ...charge()];
    }
    case "risk.profile.decision.reject": {
      if (!id) break;
      if (!tx) return [{ ...base, ...own, type: "charge.failed", providerChargeId: id }];
      return charge();
    }
    case "payments.payments.accepted": {
      // The debit was accepted; the money is collected only when no return follows.
      if (!id) break;
      return [{ ...base, ...own, type: "charge.pending", providerChargeId: id }];
    }
    case "payments.payments.failed": {
      // A rejected or RETURNED eCheck debit, possibly days after it looked accepted.
      if (!id) break;
      const rc = achReturnCodeOf(n.payload);
      const f = rc
        ? cybersourceFailure({ code: rc })
        : tx
          ? (chargeResultFromTransaction(tx).failure ??
            cybersourceFailure({ code: "DECLINED_CHECK" }))
          : cybersourceFailure({ code: "DECLINED_CHECK" });
      return [
        { ...base, ...own, type: "charge.failed", providerChargeId: id, ...failureFields(f) },
      ];
    }
    case "payments.credits.failed": {
      if (!id) break;
      return [{ ...base, ...own, type: "refund.failed", providerRefundId: id }];
    }
    case "payments.credits.accepted": {
      if (!id) break;
      return [{ ...base, ...own, type: "refund.pending", providerRefundId: id }];
    }
  }
  return [{ ...base, type: "unknown" }];
}

/** The subscription products: what we read, limited to what the account has unencrypted. */
export function selectWebhookProducts(
  enabled: Array<{
    productId?: string;
    eventTypes?: Array<{ eventName?: string; payloadEncryption?: boolean }>;
  }>,
): Array<{ productId: string; eventTypes: string[] }> {
  const out: Array<{ productId: string; eventTypes: string[] }> = [];
  const taken = new Set<string>();
  for (const p of enabled) {
    const wanted = CYBERSOURCE_WEBHOOK_EVENTS[p.productId ?? ""];
    if (!p.productId || !wanted) continue;
    const ok = new Set(
      (p.eventTypes ?? [])
        .filter((e) => e.eventName && e.payloadEncryption !== true)
        .map((e) => e.eventName!),
    );
    // One product per risk event: Decision Manager and Fraud Management Essentials share names.
    const events = wanted.filter((e) => ok.has(e) && !taken.has(e));
    for (const e of events) taken.add(e);
    if (events.length) out.push({ productId: p.productId, eventTypes: events });
  }
  return out;
}

/** CyberSource stores `https://host:443/path`; compare without the default port. */
export const normalizeWebhookUrl = (u: string) =>
  u.replace(/^(https:\/\/[^/:]+):443(?=\/|$)/i, "$1");

// ── The adapter ────────────────────────────────────────────────────────────

export interface CybersourceOptions extends CybersourceAuth {
  livemode: boolean;
  /** `<keyId>:<key>`, minted by `provisionWebhookEndpoint`. */
  webhookSecret?: string;
  /** Page origins Microform may run on when an intent names no return URL. */
  defaultOrigins?: string[];
  /** Host override (tests). Defaults from `livemode`. */
  apiHost?: string;
  /**
   * Waits before each read of a just-made transaction. Transaction Search lags the payment:
   * measured 2026-10-25, a search finds it after ~4.7 s and a read after ~6.1 s.
   */
  lookupDelaysMs?: number[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Res {
  status: number;
  json: unknown;
}

const CARD_NETWORKS = ["VISA", "MASTERCARD", "AMEX", "DISCOVER", "DINERSCLUB", "JCB"];

export class CybersourceProvider implements PaymentProvider {
  readonly key = "cybersource" as const;
  readonly capabilities: ProviderCapabilities;
  private readonly base: string;
  private readonly host: string;

  constructor(private readonly opts: CybersourceOptions) {
    this.base = (
      opts.apiHost ?? (opts.livemode ? CYBERSOURCE_LIVE_HOST : CYBERSOURCE_SANDBOX_HOST)
    ).replace(/\/+$/, "");
    this.host = new URL(this.base).host;
    this.capabilities = {
      refunds: true,
      partialRefunds: true,
      // The account's own processor setup decides; the account's `currencies` routes it.
      currencies: [],
      // eCheck needs the eCheck service on the account; it settles days later.
      methods: ["card", "us_bank_account"],
      intents: true,
      intentPurposes: ["payment", "setup"],
      // A card authorization is reversed; an eCheck debit is voided before it is sent.
      intentVoid: true,
      mandates: false,
      perDebitMandateReference: false,
      // No dispute webhook or API: an operator records chargebacks.
      disputeFeed: false,
    };
  }

  // ── transport ──

  /** One signed call. A transport failure throws `ProviderIndeterminateError`. */
  private async call(
    operation: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Res> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers = signCybersourceRequest(this.opts, {
      host: this.host,
      method,
      path,
      date: new Date().toUTCString(),
      ...(text !== undefined ? { body: text } : {}),
    });
    let res;
    try {
      res = await providerFetch({
        gatewayKey: this.key,
        operation,
        method,
        url: this.base + path,
        headers: {
          ...headers,
          Accept: "application/hal+json;charset=utf-8, application/json",
          ...(text !== undefined ? { "Content-Type": "application/json;charset=utf-8" } : {}),
        },
        ...(text !== undefined ? { body: text } : {}),
      });
    } catch {
      throw new ProviderIndeterminateError(
        `We could not reach CyberSource for ${operation}, so we do not know whether it completed. Retry later.`,
      );
    }
    if (res.status === 401)
      throw new Error(
        `CyberSource refused the Organization ID, Key or Shared Secret on ${operation} (HTTP 401)`,
      );
    let json: unknown = null;
    if (res.text.trim()) {
      try {
        json = JSON.parse(res.text);
      } catch {
        json = res.text;
      }
    }
    return { status: res.status, json };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const r = await this.call(
      "list_webhook_products",
      "GET",
      `/notification-subscriptions/v2/products/${encodeURIComponent(this.opts.organizationId)}`,
    );
    return { ok: r.status === 200, detail: String(r.status) };
  }

  // ── customers ──

  async ensureCustomer(input: EnsureCustomerInput): Promise<ProviderCustomerRef> {
    const r = await this.call("create_customer", "POST", "/tms/v2/customers", {
      buyerInformation: {
        merchantCustomerID: boundedProviderKey(input.customerRef, 100),
        ...(input.email ? { email: input.email.slice(0, 255) } : {}),
      },
      clientReferenceInformation: { code: boundedProviderKey(input.customerRef, 50) },
    });
    const id = (r.json as { id?: string } | null)?.id;
    if (r.status >= 300 || !id)
      throw new Error(`CyberSource could not create a TMS customer (HTTP ${r.status})`);
    return { providerKey: this.key, providerCustomerId: id };
  }

  async updateCustomer(ref: ProviderCustomerRef, input: EnsureCustomerInput): Promise<void> {
    const r = await this.call(
      "update_customer",
      "PATCH",
      `/tms/v2/customers/${encodeURIComponent(ref.providerCustomerId)}`,
      {
        buyerInformation: {
          merchantCustomerID: boundedProviderKey(input.customerRef, 100),
          ...(input.email ? { email: input.email.slice(0, 255) } : {}),
        },
      },
    );
    if (r.status >= 300)
      throw new Error(`CyberSource could not update TMS customer (HTTP ${r.status})`);
  }

  // ── vault ──

  /** A customer's payment instrument, or null when TMS no longer has it (404/410, measured). */
  async readInstrument(customerId: string, piId: string): Promise<CsPaymentInstrument | null> {
    const r = await this.call(
      "get_payment_instrument",
      "GET",
      `/tms/v2/customers/${encodeURIComponent(customerId)}/payment-instruments/${encodeURIComponent(piId)}`,
    );
    if (r.status === 404 || r.status === 410) return null;
    if (r.status !== 200)
      throw new Error(`CyberSource could not read payment instrument ${piId} (HTTP ${r.status})`);
    return r.json as CsPaymentInstrument;
  }

  private refOf(
    customerId: string,
    pi: CsPaymentInstrument & { id: string },
  ): ProviderPaymentMethodRef {
    return {
      providerKey: this.key,
      providerPaymentMethodId: pi.id,
      providerCustomerId: customerId,
      display: describeCybersourceInstrument(pi),
    };
  }

  async vaultPaymentMethod(_input: VaultPaymentMethodInput): Promise<ProviderPaymentMethodRef> {
    throw new ProviderRefusalError(
      "CyberSource saves a card only through its card form. Use the add-card flow.",
    );
  }

  async fetchPaymentMethodDisplay(input: {
    providerPaymentMethodId: string;
    providerCustomerId?: string;
  }): Promise<ProviderPaymentMethodRef["display"] | null> {
    if (!input.providerCustomerId) return null;
    const pi = await this.readInstrument(input.providerCustomerId, input.providerPaymentMethodId);
    return pi ? describeCybersourceInstrument(pi) : null;
  }

  async fetchVaultedPaymentMethod(input: {
    providerCustomerId: string;
    providerPaymentMethodId: string;
  }): Promise<ProviderPaymentMethodRef | null> {
    const pi = await this.readInstrument(input.providerCustomerId, input.providerPaymentMethodId);
    if (!pi || (pi.state && pi.state !== "ACTIVE")) return null;
    return this.refOf(input.providerCustomerId, { ...pi, id: input.providerPaymentMethodId });
  }

  /**
   * TMS refuses to delete the customer's default instrument while another exists (409,
   * measured): the default moves to a sibling first. The last one deletes as is.
   */
  async deletePaymentMethod(input: {
    customer: ProviderCustomerRef;
    paymentMethod: ProviderPaymentMethodRef;
  }): Promise<void> {
    const piId = input.paymentMethod.providerPaymentMethodId;
    const customerId = input.paymentMethod.providerCustomerId ?? input.customer.providerCustomerId;
    const del = () =>
      this.call(
        "delete_payment_instrument",
        "DELETE",
        `/tms/v1/paymentinstruments/${encodeURIComponent(piId)}`,
      );
    let r = await del();
    if (r.status === 409) {
      const list = await this.call(
        "list_payment_instruments",
        "GET",
        `/tms/v2/customers/${encodeURIComponent(customerId)}/payment-instruments`,
      );
      const other = (
        (list.json as { _embedded?: { paymentInstruments?: CsPaymentInstrument[] } } | null)
          ?._embedded?.paymentInstruments ?? []
      ).find((p) => p.id && p.id !== piId);
      if (other?.id) {
        await this.call(
          "set_default_payment_instrument",
          "PATCH",
          `/tms/v2/customers/${encodeURIComponent(customerId)}`,
          {
            defaultPaymentInstrument: { id: other.id },
          },
        );
        r = await del();
      }
    }
    if (r.status === 204 || r.status === 200 || r.status === 404 || r.status === 410) {
      if (r.status !== 204 && r.status !== 200)
        log.info("gateway delete skipped — the instrument was already gone at CyberSource", {
          event: "cybersource_delete_already_gone",
        });
      return;
    }
    throw new Error(`CyberSource could not delete payment instrument (HTTP ${r.status})`);
  }

  // ── money ──

  async readTransaction(id: string): Promise<CsTransaction | null> {
    const r = await this.call(
      "get_transaction",
      "GET",
      `/tss/v2/transactions/${encodeURIComponent(id)}`,
    );
    if (r.status === 404) return null;
    if (r.status !== 200)
      throw new ProviderIndeterminateError(
        `CyberSource could not read transaction ${id} (HTTP ${r.status}). Retry later.`,
      );
    return r.json as CsTransaction;
  }

  /** Transactions carrying our reference, newest first (Transaction Search). */
  async findByReference(reference: string): Promise<CsTransaction[]> {
    const r = await this.call("search_transactions", "POST", "/tss/v2/searches", {
      save: false,
      name: "tmbilling reference lookup",
      timezone: "UTC",
      query: `clientReferenceInformation.code:${reference}`,
      offset: 0,
      limit: 20,
      sort: "submitTimeUtc:desc",
    });
    if (r.status >= 300)
      throw new ProviderIndeterminateError(
        `CyberSource could not search transactions (HTTP ${r.status}). Retry later.`,
      );
    return (
      (r.json as { _embedded?: { transactionSummaries?: CsTransaction[] } } | null)?._embedded
        ?.transactionSummaries ?? []
    );
  }

  private get delays() {
    return this.opts.lookupDelaysMs ?? [0, 2000, 3000, 4000];
  }

  /** The original of a repeated or unanswered money call: the newest record that did something. */
  private async original(reference: string, appNames: string[]): Promise<CsTransaction | null> {
    for (const wait of this.delays) {
      if (wait) await sleep(wait);
      const found = await this.findByReference(reference);
      // A refused repeat is recorded too, as rFlag DDUPLICATE (measured): never the original.
      const hit = found.find((t) => {
        const apps = t.applicationInformation?.applications ?? [];
        return (
          !apps.some((a) => a.rFlag === "DDUPLICATE") &&
          apps.some((a) => appNames.includes(a.name ?? "") && a.rCode != null && a.rCode !== "")
        );
      });
      if (hit) return (await this.readTransaction(hit.id).catch(() => null)) ?? hit;
    }
    return null;
  }

  /** A transaction we were just told about, once Transaction Search has it. */
  private async readSoon(id: string): Promise<CsTransaction | null> {
    for (const wait of this.delays) {
      if (wait) await sleep(wait);
      const tx = await this.readTransaction(id).catch(() => null);
      if (tx) return tx;
    }
    return null;
  }

  /**
   * One money call on `/pts/v2/payments`. A duplicate or an unanswered call is looked up by
   * our reference; a SERVER_ERROR answer is read back by its id. Unknown stays unknown.
   */
  private async pay(
    operation: string,
    reference: string,
    body: Record<string, unknown>,
    kind: PaymentKind,
  ): Promise<{ result: ChargeResult; json: CsPaymentResponse | null }> {
    const apps = kind === "echeck" ? ["ics_ecp_debit"] : ["ics_auth"];
    const opts = { authorization: kind === "authorization" };
    let r: Res;
    try {
      r = await this.call(operation, "POST", "/pts/v2/payments", {
        ...body,
        clientReferenceInformation: { code: reference, transactionId: reference },
      });
    } catch (e) {
      if (!(e instanceof ProviderIndeterminateError)) throw e;
      const tx = await this.original(reference, apps).catch(() => null);
      if (tx) return { result: chargeResultFromTransaction(tx, opts), json: null };
      throw e;
    }
    if (r.status === 429 || (r.status >= 500 && !(r.json as CsPaymentResponse | null)?.id))
      throw new ProviderIndeterminateError(
        `CyberSource answered ${operation} with HTTP ${r.status}. We could not confirm the outcome.`,
      );
    const json = (r.json ?? {}) as CsPaymentResponse;
    const out = readPaymentResponse(r.status, json, kind);
    if ("result" in out) return { result: await this.missingInstrument(out.result, body), json };
    if ("duplicate" in out) {
      const tx = await this.original(reference, apps);
      if (!tx)
        throw new ProviderIndeterminateError(
          `CyberSource reports ${operation} as a repeat, and we could not find the original yet. Retry later.`,
        );
      return { result: chargeResultFromTransaction(tx, opts), json };
    }
    // SERVER_ERROR: the record says whether the processor ever saw it (measured: ESYSTEM).
    const tx = out.lookup ? await this.readSoon(out.lookup) : null;
    if (tx) {
      const result = chargeResultFromTransaction(tx, opts);
      if (result.status !== "pending") return { result, json };
    }
    throw new ProviderIndeterminateError(
      `CyberSource answered ${operation} with ${json.reason ?? "SERVER_ERROR"}. We could not confirm the outcome. Retry later.`,
    );
  }

  /** INVALID_DATA on a stored instrument: say so when the instrument is gone (measured: no detail). */
  private async missingInstrument(
    result: ChargeResult,
    body: Record<string, unknown>,
  ): Promise<ChargeResult> {
    if (result.status !== "failed" || result.failure?.code !== "gateway_request_rejected")
      return result;
    const pin = (body.paymentInformation ?? {}) as {
      customer?: { id?: string };
      paymentInstrument?: { id?: string };
    };
    if (!pin.customer?.id || !pin.paymentInstrument?.id) return result;
    const pi = await this.readInstrument(pin.customer.id, pin.paymentInstrument.id).catch(
      () => undefined,
    );
    if (pi !== null) return result;
    return {
      ...result,
      failure: cybersourceFailure({ code: "PAYMENT_INSTRUMENT_NOT_FOUND" }),
    };
  }

  private orderOf(amountMinor: bigint, currency: string, billTo?: Record<string, string>) {
    const cur = currency.toUpperCase();
    return {
      amountDetails: { totalAmount: minorToDecimalString(amountMinor, cur), currency: cur },
      ...(billTo && Object.keys(billTo).length ? { billTo } : {}),
    };
  }

  private storedPaymentInformation(customer: ProviderCustomerRef, pm: ProviderPaymentMethodRef) {
    return {
      customer: { id: pm.providerCustomerId ?? customer.providerCustomerId },
      paymentInstrument: { id: pm.providerPaymentMethodId },
      ...(pm.display.type === "us_bank_account" ? { paymentType: { name: "check" } } : {}),
    };
  }

  private async bankAccountType(customer: ProviderCustomerRef, pm: ProviderPaymentMethodRef) {
    const pi = await this.readInstrument(
      pm.providerCustomerId ?? customer.providerCustomerId,
      pm.providerPaymentMethodId,
    ).catch(() => null);
    return pi?.bankAccount?.type ?? null;
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    const reference = cybersourceReference(input.idempotencyKey);
    const order = this.orderOf(input.amountMinor, input.currency);
    if (input.paymentMethod.display.type === "us_bank_account") {
      const ach = cybersourceEcheckProcessing(
        input.initiator,
        await this.bankAccountType(input.customer, input.paymentMethod),
      );
      return (
        await this.pay(
          "echeck_debit_instrument",
          reference,
          {
            processingInformation: ach,
            paymentInformation: this.storedPaymentInformation(input.customer, input.paymentMethod),
            orderInformation: order,
          },
          "echeck",
        )
      ).result;
    }
    return (
      await this.pay(
        "charge_instrument",
        reference,
        {
          processingInformation: {
            capture: true,
            ...cybersourceStoredCredential(input.initiator, input.paymentMethod.display.brand),
          },
          paymentInformation: this.storedPaymentInformation(input.customer, input.paymentMethod),
          orderInformation: order,
        },
        "sale",
      )
    ).result;
  }

  async fetchChargeStatus(input: { providerChargeId: string }): Promise<ChargeResult> {
    const tx = await this.readTransaction(input.providerChargeId);
    if (!tx) return { status: "pending", providerChargeId: input.providerChargeId };
    return chargeResultFromTransaction(tx);
  }

  /** A follow-on call (`/captures`, `/refunds`, `/reversals`, `/voids`) on a payment. */
  private async followOn(
    operation: string,
    path: string,
    reference: string,
    body: Record<string, unknown>,
    apps: string[],
  ): Promise<{ status: number; json: CsPaymentResponse; original?: CsTransaction }> {
    let r: Res;
    try {
      r = await this.call(operation, "POST", path, {
        ...body,
        clientReferenceInformation: { code: reference, transactionId: reference },
      });
    } catch (e) {
      if (!(e instanceof ProviderIndeterminateError)) throw e;
      const tx = await this.original(reference, apps).catch(() => null);
      if (tx) return { status: 201, json: { id: tx.id }, original: tx };
      throw e;
    }
    const json = (r.json ?? {}) as CsPaymentResponse;
    const reason = json.errorInformation?.reason ?? json.reason;
    if (reason === "DUPLICATE_REQUEST") {
      const tx = await this.original(reference, apps);
      if (!tx)
        throw new ProviderIndeterminateError(
          `CyberSource reports ${operation} as a repeat, and we could not find the original yet. Retry later.`,
        );
      return { status: 201, json: { id: tx.id }, original: tx };
    }
    if (r.status >= 500 || json.status === "SERVER_ERROR")
      throw new ProviderIndeterminateError(
        `CyberSource answered ${operation} with ${reason ?? `HTTP ${r.status}`}. We could not confirm the outcome. Retry later.`,
      );
    return { status: r.status, json };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const tx = await this.readTransaction(input.providerChargeId);
    if (!tx)
      throw new ProviderRefusalError(
        `CyberSource has no payment ${input.providerChargeId}. We could not refund it.`,
      );
    const currency = (
      input.currency ??
      tx.orderInformation?.amountDetails?.currency ??
      "USD"
    ).toUpperCase();
    const charged =
      toMinor(
        tx.orderInformation?.amountDetails?.totalAmount ??
          tx.orderInformation?.amountDetails?.authorizedAmount,
        currency,
      ) ?? 0n;
    const amount = input.amountMinor ?? charged;
    const echeck = isEcheckTransaction(tx);
    const r = await this.followOn(
      "refund_payment",
      `/pts/v2/payments/${encodeURIComponent(tx.id)}/refunds`,
      cybersourceReference(input.idempotencyKey),
      { orderInformation: this.orderOf(amount, currency) },
      [echeck ? "ics_ecp_credit" : "ics_credit"],
    );
    if (r.original) return refundResultFromTransaction(r.original);
    const id = r.json.id ?? "";
    if (r.json.status === "PENDING")
      // A card credit is accepted for the next batch; an eCheck credit settles days later.
      return { status: echeck ? "pending" : "succeeded", providerRefundId: id, raw: r.json };
    if (r.json.status === "INVALID_REQUEST")
      throw new ProviderRefusalError(
        `CyberSource refused the refund: ${r.json.message ?? r.json.reason ?? "invalid request"}.`,
      );
    const why = r.json.errorInformation?.message ?? r.json.message ?? r.json.reason;
    return {
      status: "failed",
      providerRefundId: id,
      failureMessage: `CyberSource refused the refund (${r.json.status ?? "no status"}).${why ? ` ${why}` : ""}`,
      raw: r.json,
    };
  }

  async fetchRefundStatus(input: { providerRefundId: string }): Promise<RefundResult> {
    const tx = await this.readTransaction(input.providerRefundId);
    if (!tx) return { status: "pending", providerRefundId: input.providerRefundId };
    return refundResultFromTransaction(tx);
  }

  // ── intents ──

  /** Microform's capture context for these page origins (valid 15 minutes). */
  async captureContext(origins: string[], paymentTypes: Array<"CARD" | "CHECK">): Promise<string> {
    const r = await this.call("create_capture_context", "POST", "/microform/v2/sessions", {
      clientVersion: "v2",
      targetOrigins: origins,
      allowedCardNetworks: CARD_NETWORKS,
      allowedPaymentTypes: paymentTypes,
    });
    if (r.status >= 300 || typeof r.json !== "string")
      throw new Error(`CyberSource could not create a Microform session (HTTP ${r.status})`);
    return r.json;
  }

  private originsFor(returnUrl?: string): string[] {
    const out = new Set<string>();
    for (const u of [returnUrl, ...(this.opts.defaultOrigins ?? [])]) {
      if (!u) continue;
      try {
        out.add(new URL(u).origin);
      } catch {
        // Not a URL: skipped.
      }
    }
    if (!out.size)
      throw new ProviderRefusalError(
        "We could not open the CyberSource card form: no page address is configured for it.",
      );
    return [...out];
  }

  private async sdkChallenge(
    purpose: IntentPurpose,
    returnUrl: string | undefined,
    methodTypes: string[] | undefined,
    amount?: { amountMinor: bigint; currency: string },
  ): Promise<BuyerAuthorization> {
    // A bank account pays once by eCheck; it cannot be saved without a payment (see report).
    const bank =
      purpose === "payment" &&
      (amount?.currency ?? "").toUpperCase() === "USD" &&
      (!methodTypes || methodTypes.includes("us_bank_account"));
    const paymentTypes: Array<"CARD" | "CHECK"> = bank ? ["CARD", "CHECK"] : ["CARD"];
    const ctx = await this.captureContext(this.originsFor(returnUrl), paymentTypes);
    const data = (
      decodeJwtPayload(ctx)?.ctx as Array<{ data?: Record<string, unknown> }> | undefined
    )?.[0]?.data;
    return {
      mode: "sdk",
      sdk: {
        provider: this.key,
        params: {
          captureContext: ctx,
          clientLibrary: data?.clientLibrary ?? null,
          clientLibraryIntegrity: data?.clientLibraryIntegrity ?? null,
          paymentTypes,
          // NACHA: a bank debit needs the payer's authorization on the same page.
          ...(bank ? { achAuthorizationRequired: true } : {}),
          environment: this.opts.livemode ? "production" : "sandbox",
          purpose,
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
    const setupTokenId = encodeSyntheticIntent({
      p: "setup",
      c: input.customer.providerCustomerId,
      cur: (input.currency ?? "USD").toUpperCase(),
      ...(input.ownershipRef ? { r: input.ownershipRef } : {}),
      k: createHash("sha256")
        .update(input.ownershipRef ?? input.returnUrl)
        .digest("hex")
        .slice(0, 12),
    });
    return {
      setupTokenId,
      ...(await this.sdkChallenge("setup", input.returnUrl, input.methodTypes)),
    };
  }

  async createIntent(input: CreateIntentInput): Promise<IntentRef> {
    const currency = input.currency.toUpperCase();
    if (input.purpose === "payment" && input.paymentMethod) {
      const pm = input.paymentMethod;
      const initiator: ChargeInitiator = {
        by: input.session === "on_session" ? "customer" : "merchant",
        recurring: false,
      };
      const reference = cybersourceReference(input.idempotencyKey);
      const paymentInformation = this.storedPaymentInformation(input.customer, pm);
      const order = this.orderOf(input.amountMinor ?? 0n, currency);
      const bank = pm.display.type === "us_bank_account";
      const { result } = bank
        ? await this.pay(
            "echeck_debit_instrument",
            reference,
            {
              processingInformation: cybersourceEcheckProcessing(
                initiator,
                await this.bankAccountType(input.customer, pm),
              ),
              paymentInformation,
              orderInformation: order,
            },
            "echeck",
          )
        : await this.pay(
            "authorize_instrument",
            reference,
            {
              processingInformation: {
                capture: false,
                ...cybersourceStoredCredential(initiator, pm.display.brand),
              },
              paymentInformation,
              orderInformation: order,
            },
            "authorization",
          );
      const intentId =
        bank && result.providerChargeId
          ? `${ACH_PREFIX}${result.providerChargeId}`
          : result.providerChargeId;
      if (result.status === "failed")
        return {
          intentId,
          status: "inited",
          ...(result.failure ? { failure: result.failure } : {}),
          raw: result.raw,
        };
      return {
        intentId,
        // An accepted eCheck debit stands in for the hold; consuming reads its outcome.
        status: result.status === "pending" && !bank ? "inited" : "authorized",
        raw: result.raw,
      };
    }
    const synthetic: SyntheticIntent = {
      p: input.purpose,
      ...(input.purpose === "setup" ? { c: input.customer.providerCustomerId } : {}),
      ...(input.purpose === "payment"
        ? { c: input.customer.providerCustomerId, a: String(input.amountMinor ?? 0n) }
        : {}),
      cur: currency,
      ...(input.ownershipRef ? { r: input.ownershipRef } : {}),
      k: createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 12),
    };
    return {
      intentId: encodeSyntheticIntent(synthetic),
      status: "requires_action",
      authorization: await this.sdkChallenge(
        input.purpose,
        input.returnUrl,
        input.methodTypes,
        input.purpose === "payment"
          ? { amountMinor: input.amountMinor ?? 0n, currency }
          : undefined,
      ),
    };
  }

  /** The billing address the card form collected. CyberSource requires it unless relaxed. */
  private billToOf(cr: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    const fields: Array<[string, number]> = [
      ["firstName", 60],
      ["lastName", 60],
      ["address1", 60],
      ["locality", 50],
      ["administrativeArea", 20],
      ["postalCode", 10],
      ["country", 2],
      ["email", 255],
      ["phoneNumber", 15],
    ];
    for (const [k, max] of fields) {
      const v = (cr[k] ?? "").trim();
      if (v)
        out[k] = (k === "country" || k === "administrativeArea" ? v.toUpperCase() : v).slice(
          0,
          max,
        );
    }
    return out;
  }

  /** The Microform token: save it (setup), authorize with it (card) or debit with it (bank). */
  async submitClientResult(input: {
    intentId: string;
    purpose: IntentPurpose;
    clientResult: Record<string, string>;
    idempotencyKey: string;
  }): Promise<FetchedIntent> {
    const s = decodeSyntheticIntent(input.intentId);
    if (!s) return this.intentState(input.intentId);
    const cr = input.clientResult;
    const token = (cr.transientToken ?? cr.transient_token ?? "").trim();
    const kind = token.split(".").length === 3 ? transientTokenKind(token) : null;
    if (!kind)
      return {
        intentId: input.intentId,
        status: "failed",
        failure: {
          code: "invalid_client_result",
          message: "The payment details from the browser are not valid.",
        },
      };
    const billTo = this.billToOf(cr);
    const reference = cybersourceReference(input.idempotencyKey);
    if (s.p === "setup") {
      if (kind !== "card")
        return {
          intentId: input.intentId,
          status: "failed",
          failure: {
            code: "payment_method_not_supported",
            message: "We can save a card only. Pay with the bank account to use it.",
          },
        };
      if (!s.c) throw new Error("This CyberSource setup has no TMS customer");
      const { result, json } = await this.pay(
        "verify_and_save_card",
        reference,
        {
          processingInformation: {
            actionList: ["TOKEN_CREATE"],
            actionTokenTypes: ["paymentInstrument", "instrumentIdentifier"],
            commerceIndicator: "internet",
            authorizationOptions: { initiator: { type: "customer", credentialStoredOnFile: true } },
          },
          paymentInformation: { customer: { id: s.c } },
          tokenInformation: { transientTokenJwt: token },
          orderInformation: this.orderOf(0n, s.cur, billTo),
        },
        "authorization",
      );
      const piId = json?.tokenInformation?.paymentInstrument?.id;
      if (result.status === "succeeded" && piId)
        return {
          intentId: input.intentId,
          status: "authorized",
          gatewayIntentId: vaultedIntentId(s.c, piId),
        };
      if (result.status === "failed")
        return {
          intentId: input.intentId,
          status: "failed",
          failure: { code: result.failure!.code, message: result.failure!.message },
          raw: result.raw,
        };
      // Approved without a token (a repeat read back), or held for review: not saved yet.
      return { intentId: input.intentId, status: "requires_action", raw: result.raw };
    }
    const amountMinor = BigInt(s.a ?? "0");
    const order = this.orderOf(amountMinor, s.cur, billTo);
    if (kind === "check") {
      if (s.cur !== "USD")
        return {
          intentId: input.intentId,
          status: "failed",
          failure: {
            code: "payment_method_not_supported",
            message: "A bank account can pay in US dollars only.",
          },
        };
      const { result } = await this.pay(
        "echeck_debit_token",
        reference,
        {
          processingInformation: cybersourceEcheckProcessing(undefined, cr.accountType),
          paymentInformation: { paymentType: { name: "check" } },
          tokenInformation: { transientTokenJwt: token },
          orderInformation: order,
        },
        "echeck",
      );
      if (result.status === "failed")
        return {
          intentId: input.intentId,
          status: "failed",
          ...(result.providerChargeId ? { providerChargeId: result.providerChargeId } : {}),
          failure: { code: result.failure!.code, message: result.failure!.message },
          raw: result.raw,
        };
      return {
        intentId: input.intentId,
        status: "authorized",
        gatewayIntentId: `${ACH_PREFIX}${result.providerChargeId}`,
        providerChargeId: result.providerChargeId,
        amountMinor,
        currency: s.cur,
        raw: result.raw,
      };
    }
    const { result } = await this.pay(
      "authorize_token",
      reference,
      {
        processingInformation: { capture: false, commerceIndicator: "internet" },
        tokenInformation: { transientTokenJwt: token },
        orderInformation: order,
      },
      "authorization",
    );
    if (result.status === "failed")
      return {
        intentId: input.intentId,
        status: "failed",
        ...(result.providerChargeId ? { providerChargeId: result.providerChargeId } : {}),
        failure: { code: result.failure!.code, message: result.failure!.message },
        raw: result.raw,
      };
    return {
      intentId: input.intentId,
      status: result.status === "pending" ? "requires_action" : "authorized",
      gatewayIntentId: result.providerChargeId,
      providerChargeId: result.providerChargeId,
      amountMinor,
      currency: s.cur,
      raw: result.raw,
    };
  }

  /** Where an authorization or an eCheck debit stands, in `FetchedIntent` words. */
  private async intentState(id: string): Promise<FetchedIntent> {
    const ach = id.startsWith(ACH_PREFIX);
    const tx = await this.readTransaction(ach ? id.slice(ACH_PREFIX.length) : id).catch(() => null);
    if (!tx) return { intentId: id, status: "unknown" };
    let status: FetchedIntent["status"];
    if (ach) {
      const s = appState(tx, "ics_ecp_debit");
      status =
        appState(tx, "ics_void") === "ok"
          ? "voided"
          : s === "ok"
            ? "authorized"
            : s === "absent" || s === "timeout"
              ? "unknown"
              : "failed";
    } else {
      const a = appState(tx, "ics_auth");
      status =
        appState(tx, "ics_auth_reversal") === "ok" || appState(tx, "ics_void") === "ok"
          ? "voided"
          : appState(tx, "ics_bill") === "ok"
            ? "consumed"
            : a === "ok"
              ? "authorized"
              : a === "declined" || a === "error"
                ? "failed"
                : "unknown";
    }
    const cur = tx.orderInformation?.amountDetails?.currency ?? "USD";
    const amount = toMinor(
      tx.orderInformation?.amountDetails?.authorizedAmount ??
        tx.orderInformation?.amountDetails?.totalAmount,
      cur,
    );
    return {
      intentId: id,
      status,
      providerChargeId: tx.id,
      ...(amount != null ? { amountMinor: amount, currency: cur } : {}),
      raw: tx,
    };
  }

  async consumeIntent(input: ConsumeIntentInput): Promise<ConsumeIntentResult> {
    if (decodeSyntheticIntent(input.intentId))
      throw new Error(
        "This CyberSource intent has no card from the browser yet. Submit the client result first",
      );
    if (input.purpose === "setup") {
      const v = parseVaultedIntentId(input.intentId);
      const pi = v ? await this.readInstrument(v.c, v.pi) : null;
      if (!v || !pi) throw new Error(`CyberSource knows no payment instrument ${input.intentId}`);
      return { purpose: "setup", paymentMethod: this.refOf(v.c, { ...pi, id: v.pi }) };
    }
    // An eCheck debit already ran: its outcome is the charge.
    if (input.intentId.startsWith(ACH_PREFIX)) {
      const id = input.intentId.slice(ACH_PREFIX.length);
      const tx = await this.readTransaction(id).catch(() => null);
      return {
        purpose: "payment",
        charge: {
          ...(tx
            ? chargeResultFromTransaction(tx)
            : { status: "pending" as const, providerChargeId: id }),
          methodUsed: "us_bank_account",
        },
      };
    }
    let amountMinor = input.amountMinor;
    let currency = input.currency?.toUpperCase();
    if (amountMinor == null || !currency) {
      const st = await this.intentState(input.intentId);
      amountMinor ??= st.amountMinor;
      currency ??= st.currency;
    }
    if (amountMinor == null || !currency)
      throw new ProviderIndeterminateError(
        `We could not read the authorized amount of CyberSource payment ${input.intentId}. Retry later.`,
      );
    const r = await this.followOn(
      "capture_authorization",
      `/pts/v2/payments/${encodeURIComponent(input.intentId)}/captures`,
      cybersourceReference(input.idempotencyKey),
      { orderInformation: this.orderOf(amountMinor, currency) },
      ["ics_bill"],
    );
    if (r.original || r.json.status === "PENDING" || r.json.status === "TRANSMITTED")
      return {
        purpose: "payment",
        charge: {
          status: "succeeded",
          providerChargeId: input.intentId,
          methodUsed: "card",
          raw: r.json,
        },
      };
    return {
      purpose: "payment",
      charge: {
        status: "failed",
        providerChargeId: input.intentId,
        failure: cybersourceFailure(cybersourceDeclineSignal(r.json)),
        raw: r.json,
      },
    };
  }

  async voidIntent(input: VoidIntentInput): Promise<VoidIntentResult> {
    // An unused challenge or a saved card holds no money.
    if (decodeSyntheticIntent(input.intentId) || parseVaultedIntentId(input.intentId))
      return { voided: true, held: false };
    const reference = cybersourceReference(input.idempotencyKey);
    if (input.intentId.startsWith(ACH_PREFIX)) {
      const id = input.intentId.slice(ACH_PREFIX.length);
      const r = await this.followOn(
        "void_echeck_debit",
        `/pts/v2/payments/${encodeURIComponent(id)}/voids`,
        reference,
        {},
        ["ics_void"],
      );
      const voided =
        Boolean(r.original) || r.json.status === "VOIDED" || r.json.status === "CANCELLED";
      return { voided, providerTransactionId: r.json.id ?? id, held: false };
    }
    const st = await this.intentState(input.intentId);
    if (st.status === "voided")
      return { voided: true, providerTransactionId: input.intentId, held: false };
    if (st.status === "failed") return { voided: true, held: false };
    if (st.amountMinor == null || !st.currency)
      throw new ProviderIndeterminateError(
        `We could not read CyberSource payment ${input.intentId}, so we could not confirm whether the hold was released. Retry later.`,
      );
    const r = await this.followOn(
      "reverse_authorization",
      `/pts/v2/payments/${encodeURIComponent(input.intentId)}/reversals`,
      reference,
      {
        reversalInformation: {
          amountDetails: { totalAmount: minorToDecimalString(st.amountMinor, st.currency) },
        },
      },
      ["ics_auth_reversal"],
    );
    const voided = Boolean(r.original) || r.json.status === "REVERSED";
    return {
      voided,
      providerTransactionId: r.json.id ?? input.intentId,
      ...(st.status === "authorized" ? { held: true } : {}),
    };
  }

  // ── webhooks ──

  async listWebhooks(): Promise<
    Array<{
      webhookId: string;
      webhookUrl?: string;
      status?: string;
      products?: Array<{ productId?: string; eventTypes?: string[] }>;
    }>
  > {
    const r = await this.call(
      "webhooks_list",
      "GET",
      `/notification-subscriptions/v2/webhooks?organizationId=${encodeURIComponent(this.opts.organizationId)}`,
    );
    // No subscription at all answers 404 (measured).
    if (r.status === 404) return [];
    if (r.status !== 200 || !Array.isArray(r.json))
      throw new Error(`CyberSource could not list webhook subscriptions (HTTP ${r.status})`);
    return r.json as Awaited<ReturnType<CybersourceProvider["listWebhooks"]>>;
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    const r = await this.call(
      "webhooks_delete",
      "DELETE",
      `/notification-subscriptions/v2/webhooks/${encodeURIComponent(webhookId)}`,
    );
    if (r.status !== 200 && r.status !== 204 && r.status !== 404)
      throw new Error(`CyberSource could not delete webhook ${webhookId} (HTTP ${r.status})`);
  }

  /** A new digital signature key. Each call mints a new key and key id (measured). */
  async createSignatureKey(): Promise<{ keyId: string; key: string }> {
    const org = this.opts.organizationId;
    const r = await this.call("webhooks_create_key", "POST", "/kms/egress/v2/keys-sym", {
      clientRequestAction: "CREATE",
      keyInformation: {
        provider: "nrtd",
        tenant: org,
        keyType: "sharedSecret",
        organizationId: org,
        expiryDuration: "365",
      },
    });
    const k = (r.json as { keyInformation?: { keyId?: string; key?: string } } | null)
      ?.keyInformation;
    if (r.status >= 300 || !k?.keyId || !k.key)
      throw new Error(`CyberSource could not create a digital signature key (HTTP ${r.status})`);
    return { keyId: k.keyId, key: k.key };
  }

  /**
   * Subscribe our URL to the events we read that this account has unencrypted, then mint the
   * digital signature key that signs them. CyberSource reviews a new URL (PENDING_REVIEW,
   * measured) before it delivers.
   */
  async provisionWebhookEndpoint(input: { url: string }): Promise<ProvisionedWebhook> {
    const org = this.opts.organizationId;
    const pr = await this.call(
      "webhooks_list_products",
      "GET",
      `/notification-subscriptions/v2/products/${encodeURIComponent(org)}`,
    );
    if (pr.status !== 200 || !Array.isArray(pr.json))
      throw new Error(`CyberSource could not list webhook products (HTTP ${pr.status})`);
    const products = selectWebhookProducts(pr.json as Parameters<typeof selectWebhookProducts>[0]);
    if (!products.length)
      throw new Error(
        "This CyberSource account has none of the webhook events we read (token updates, fraud decisions, eCheck results)",
      );
    const want = normalizeWebhookUrl(input.url);
    const existing = (await this.listWebhooks()).find(
      (w) => w.webhookUrl && normalizeWebhookUrl(w.webhookUrl) === want,
    );
    let webhookId: string;
    if (existing) {
      webhookId = existing.webhookId;
      const same =
        JSON.stringify(
          (existing.products ?? []).map((p) => [p.productId, [...(p.eventTypes ?? [])].sort()]),
        ) === JSON.stringify(products.map((p) => [p.productId, [...p.eventTypes].sort()]));
      if (!same) {
        // PATCH needs the organization id beside the change (measured).
        const r = await this.call(
          "webhooks_update",
          "PATCH",
          `/notification-subscriptions/v2/webhooks/${encodeURIComponent(webhookId)}`,
          { organizationId: org, products },
        );
        if (r.status >= 300)
          throw new Error(`CyberSource could not update webhook ${webhookId} (HTTP ${r.status})`);
      }
      // Refused while PENDING_REVIEW or BLOCKED (measured); best effort after the review.
      if (existing.status === "INACTIVE" || existing.status === "SUSPENDED")
        await this.call(
          "webhooks_activate",
          "PUT",
          `/notification-subscriptions/v2/webhooks/${encodeURIComponent(webhookId)}/status`,
          { status: "ACTIVE" },
        ).catch(() => undefined);
    } else {
      const r = await this.call(
        "webhooks_create",
        "POST",
        "/notification-subscriptions/v2/webhooks",
        {
          name: "tmbilling",
          description: "tmbilling payment events",
          organizationId: org,
          products,
          webhookUrl: input.url,
          notificationScope: "SELF",
          // Lowercase: "KEY" is refused although the guide spells it so (measured).
          securityPolicy: { securityType: "key" },
        },
      );
      const j = r.json as { webhookId?: string; errorDescription?: string } | null;
      if (r.status >= 300 || !j?.webhookId)
        throw new Error(
          `CyberSource refused the webhook subscription (HTTP ${r.status})${j?.errorDescription ? `: ${j.errorDescription}` : ""}`,
        );
      webhookId = j.webhookId;
    }
    const key = await this.createSignatureKey();
    log.info("cybersource webhook subscription ready", {
      event: "cybersource_webhook_provisioned",
      reused: Boolean(existing),
      products: products.map((p) => p.productId).join(","),
    });
    return { webhookSecret: `${key.keyId}:${key.key}`, providerEndpointId: webhookId };
  }

  webhookEventId(input: NormalizeWebhookInput): string {
    let n: CybersourceNotification | null = null;
    try {
      n = JSON.parse(input.payload.toString()) as CybersourceNotification;
    } catch {
      n = null;
    }
    return webhookEventId([n ? cybersourceEventId(n) : undefined], input.payload);
  }

  async normalizeWebhook(input: NormalizeWebhookInput): Promise<NormalizedProviderEvent[]> {
    if (!this.opts.webhookSecret)
      throw new Error(
        "This CyberSource account has no digital signature key. Provision its webhook",
      );
    verifyCybersourceSignature(
      this.opts.webhookSecret,
      headerValue(input.headers, "v-c-signature"),
      input.payload,
    );
    const n = JSON.parse(input.payload.toString()) as CybersourceNotification;
    const type = n.eventType ?? "";
    const eventId = this.webhookEventId(input);
    let tx: CsTransaction | null = null;
    const instruments: CsPaymentInstrument[] = [];
    if (type.startsWith("risk.") || type.startsWith("payments.")) {
      const id = transactionIdOf(n.payload);
      tx = id ? await this.readTransaction(id) : null;
    } else if (type === "tms.networktoken.updated") {
      for (const id of paymentInstrumentIdsOf(n.payload).slice(0, 10)) {
        const r = await this.call(
          "get_payment_instrument",
          "GET",
          `/tms/v1/paymentinstruments/${id}`,
        );
        if (r.status === 200) instruments.push(r.json as CsPaymentInstrument);
      }
    }
    return normalizeCybersourceNotification(n, eventId, n, { tx, instruments });
  }
}
