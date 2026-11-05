/**
 * Authorize.net adapter, over the JSON API (no SDK — the engine never imports one).
 *
 * Cards and bank accounts (eCheck, `us_bank_account`) live in the Customer Information Manager
 * (CIM): one customer profile per customer, one payment profile per instrument. `providerCustomerId` is the customer profile id and
 * `providerPaymentMethodId` the payment profile id; a charge needs both. Its own recurring
 * billing (ARB) is never used: the engine owns subscription state.
 *
 * Buyer flow (`mode: 'sdk'`): the browser opens Accept's hosted form (AcceptUI.js, PCI SAQ A)
 * with the API Login ID and the Public Client Key, which we read with `getMerchantDetails`.
 * The form returns a single-use nonce (`opaqueData`, valid 15 minutes); `submitClientResult`
 * saves it as a payment profile (setup) or authorizes with it (payment).
 *
 * No idempotency header exists. Every money call sends `invoiceNumber` = `refId` = a 20-char
 * digest of our key and `duplicateWindow` = 8 hours: a repeat inside the window is refused
 * with reason 11 and names the ORIGINAL transaction, which we read back (measured). A call
 * whose answer is lost is looked up by that invoice number before we give up. A repeat after
 * the window is not refused, so a call on a customer profile first looks its reference up.
 *
 * Measured on the sandbox (2026-10-24): every response starts with a UTF-8 BOM; elements
 * must follow the XSD order; a webhook URL with a query string is refused.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { decimalToMinor, minorToDecimalString } from "@/platform/currency";
import { createLogger } from "@/platform/logger";
import { normalizeAuthorizenetDecline, type DeclineSignal } from "./decline-codes";
import { boundedProviderKey, providerFetch } from "./http";
import {
  markStrandedObject,
  ProviderIndeterminateError,
  ProviderRefusalError,
  type BuyerAuthorization,
  type CancelPendingChargeInput,
  type CancelPendingChargeResult,
  type ChargeInitiator,
  type ChargeInput,
  type ChargeResult,
  type ConsumeIntentInput,
  type ConsumeIntentResult,
  type CreateIntentInput,
  type EnsureCustomerInput,
  type FetchedIntent,
  type HealthCheckItem,
  type HealthCheckResult,
  type InitiateVaultSetupInput,
  type IntentPurpose,
  type IntentRef,
  type NormalizeWebhookInput,
  type NormalizedProviderEvent,
  type PaymentProvider,
  type ProviderCapabilities,
  type ProviderCustomerRef,
  type ProviderPaymentMethodRef,
  type ProviderRefundRecord,
  type ProvisionedWebhook,
  type WebhookRemoval,
  type RefundInput,
  type RefundResult,
  type VaultPaymentMethodInput,
  type VaultSetupRef,
  type VoidIntentInput,
  type VoidIntentResult,
} from "./types";
import { headerValue, webhookEventId } from "./webhook-event-id";

const log = createLogger("authorizenet");

export const AUTHORIZENET_SANDBOX_HOST = "https://apitest.authorize.net";
export const AUTHORIZENET_LIVE_HOST = "https://api.authorize.net";
const XML_API_PATH = "/xml/v1/request.api";
const REST_PATH = "/rest/v1";
/** The longest window Authorize.net accepts (8 hours). */
export const AUTHORIZENET_DUPLICATE_WINDOW_S = 28800;
/** `refId`, `invoiceNumber` and `merchantCustomerId` all cap at 20 characters. */
const REFERENCE_MAX = 20;
/** Our `invoiceNumber`/`refId` shape: `tm` + 18 hex. Anything else on a read object is not ours. */
const OUR_REFERENCE = /^tm[0-9a-f]{18}$/;
const SYNTHETIC_PREFIX = "anci_";
const ACCEPT_DESCRIPTOR = "COMMON.ACCEPT.INAPP.PAYMENT";

/** Reason 11: a duplicate inside `duplicateWindow`. The answer names the original. */
const DUPLICATE_TRANSACTION = "11";
/** Not a decline: the record is gone (delete is then already done). */
const RECORD_NOT_FOUND = "E00040";
const DUPLICATE_RECORD = "E00039";
const AUTHENTICATION_FAILED = "E00007";
const INVALID_NONCE = "E00114";
/** A capture repeated on a captured transaction: answered `responseCode 1`, transId 0. */
const ALREADY_CAPTURED = "311";
/**
 * The processor's answer never reached Authorize.net (19, 20: "Repeated attempts … may result
 * in multiple authorizations"), or its own void of such a timed-out call failed (120–122).
 * An authorization may stand, so these are unknown, not declines (DOC responseCodes.json).
 */
const OUTCOME_UNKNOWN_REASONS = new Set(["19", "20", "120", "121", "122"]);
/** List reads: the documented page maximum, and a cap past which a search is incomplete. */
const LIST_PAGE_SIZE = 1000;
const LIST_MAX_PAGES = 25;
const NEWEST_FIRST = { orderBy: "submitTimeUTC", orderDescending: "true" };
/** `getSettledBatchList` takes at most 31 days per request. */
const BATCH_WINDOW_MS = 30 * 86_400_000;
/**
 * The settlement poll re-reads batches settled this long before its window, in case a batch
 * is listed before its transactions' outcome is final (`settlementState` can read
 * `pendingSettlement`: API reference, Get Settled Batch List, read 2026-10-27).
 */
const SETTLEMENT_LOOKBACK_MS = 24 * 3_600_000;
/**
 * Batches one poll reads before it gives up: a few per day (one per payment method and
 * market) in the recent window, plus one eCheck batch per day of the return window.
 */
const SETTLEMENT_MAX_BATCHES = 150;
/**
 * How far back the poll re-reads eCheck batches for returns. A consumer has 60 days from the
 * statement that shows a debit to return it as unauthorized (eCheck User Guide, Appendix B,
 * read 2026-10-28); 70 days covers the statement lag.
 */
const ECHECK_RETURN_WINDOW_MS = 70 * 86_400_000;
/** A settled eCheck is refunded only within 180 days (support article KA-04424, read 2026-10-28). */
const ECHECK_REFUND_WINDOW_MS = 180 * 86_400_000;
const WEBHOOK_NAME = "tmbilling";

/** The webhook events we register. Customer and subscription events are not used. */
export const AUTHORIZENET_WEBHOOK_EVENTS = [
  "net.authorize.payment.authcapture.created",
  "net.authorize.payment.authorization.created",
  "net.authorize.payment.priorAuthCapture.created",
  "net.authorize.payment.refund.created",
  "net.authorize.payment.void.created",
  "net.authorize.payment.fraud.held",
  "net.authorize.payment.fraud.approved",
  "net.authorize.payment.fraud.declined",
  "net.authorize.customer.paymentProfile.updated",
  "net.authorize.customer.paymentProfile.deleted",
] as const;

// ── Transport helpers ──────────────────────────────────────────────────────

/** Parse an Authorize.net body. Every response starts with a UTF-8 BOM (measured). */
export function parseAuthorizenetJson<T = unknown>(text: string): T {
  return JSON.parse(text.replace(/^﻿/, "")) as T;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Authorize.net HTML-encodes its message text ("and&#47;or", measured in the sandbox). Decode
 * it before the text reaches a person or a log.
 */
export function unescapeAuthorizenetText(text: string): string;
export function unescapeAuthorizenetText(text: string | null | undefined): string | undefined;
export function unescapeAuthorizenetText(text: string | null | undefined): string | undefined {
  if (text == null) return undefined;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== "#") return NAMED_ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** Our 20-char reference for an idempotency key: same key, same reference. */
export function authorizenetReference(idempotencyKey: string): string {
  return `tm${createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, REFERENCE_MAX - 2)}`;
}

/**
 * Our ownership ref rides at the end of `order.description`: a transaction read returns no
 * user fields, and `invoiceNumber` (20) holds the idempotency reference.
 */
const OWNERSHIP_TAG = /\[ref:([A-Za-z0-9_-]{1,64})\]$/;
const DESCRIPTION_MAX = 255;

/** `description` with our ref appended, within the 255-char limit. */
export function authorizenetDescription(
  description: string | undefined,
  ownershipRef: string | undefined,
): string | undefined {
  const tag =
    ownershipRef && /^[A-Za-z0-9_-]{1,64}$/.test(ownershipRef) ? `[ref:${ownershipRef}]` : "";
  if (!tag) return description?.slice(0, DESCRIPTION_MAX);
  if (!description) return tag;
  return `${description.slice(0, DESCRIPTION_MAX - tag.length - 1)} ${tag}`;
}

/** All Authorize.net currencies have two decimals. */
const toMinor = (v: number | string | undefined | null): bigint | undefined =>
  v == null || v === "" ? undefined : decimalToMinor(String(v), "USD");

interface AnetMessages {
  resultCode?: string;
  message?: Array<{ code?: string; text?: string }>;
}

export interface AnetTransactionResponse {
  responseCode?: string;
  authCode?: string;
  transId?: string;
  refTransID?: string;
  accountNumber?: string;
  accountType?: string;
  networkTransId?: string;
  messages?: Array<{ code?: string; description?: string }>;
  errors?: Array<{ errorCode?: string; errorText?: string }>;
}

interface AnetResponse {
  messages?: AnetMessages;
  refId?: string;
  transactionResponse?: AnetTransactionResponse;
  [k: string]: unknown;
}

/** `getTransactionDetails`' transaction, the fields we read. */
export interface AnetTransaction {
  transId: string;
  refTransId?: string;
  submitTimeUTC?: string;
  transactionType?: string;
  transactionStatus?: string;
  responseCode?: number | string;
  responseReasonCode?: number | string;
  responseReasonDescription?: string;
  authAmount?: number | string;
  settleAmount?: number | string;
  order?: { invoiceNumber?: string; description?: string };
  payment?: {
    creditCard?: { cardNumber?: string; expirationDate?: string; cardType?: string };
    bankAccount?: {
      accountNumber?: string;
      routingNumber?: string;
      nameOnAccount?: string;
      accountType?: string;
      echeckType?: string;
    };
  };
  profile?: { customerProfileId?: string; customerPaymentProfileId?: string };
  /** eCheck only: the ACH returns (`code` is the NACHA return reason code). */
  returnedItems?: { returnedItem?: AnetReturnedItem | AnetReturnedItem[] } | AnetReturnedItem[];
}

export interface AnetReturnedItem {
  id?: string;
  dateUTC?: string;
  code?: string;
  description?: string;
}

/** The first ACH return on a transaction, or null. */
export function returnOf(tx: AnetTransaction): AnetReturnedItem | null {
  const r = tx.returnedItems;
  const list = Array.isArray(r) ? r : r?.returnedItem;
  const items = Array.isArray(list) ? list : list ? [list] : [];
  return items.find((i) => i.code) ?? null;
}

/** A list row (`transactionSummaryType`), the fields we read. */
interface ListedTransaction {
  transId: string;
  invoiceNumber?: string;
  submitTimeUTC?: string;
  transactionStatus?: string;
  /** A card brand, or `eCheck`. */
  accountType?: string;
  hasReturnedItems?: boolean | string;
}

/** An API-level refusal (no transaction was created). */
export class AuthorizenetApiError extends Error {
  readonly text: string | undefined;
  constructor(
    readonly operation: string,
    readonly code: string | undefined,
    text: string | undefined,
  ) {
    const plain = unescapeAuthorizenetText(text);
    super(`Authorize.net ${operation}: ${plain ?? "error"} (${code ?? "?"})`);
    this.text = plain;
    this.name = "AuthorizenetApiError";
  }
}

const firstMessage = (r: AnetResponse) => r.messages?.message?.[0];

// ── Stored credentials ─────────────────────────────────────────────────────

export interface AuthorizenetStoredCredential {
  processingOptions?: {
    isFirstRecurringPayment?: "true";
    isSubsequentAuth?: "true";
    isStoredCredentials?: "true";
  };
  /** `transactionSettings.recurringBilling`. */
  recurringBilling: boolean;
}

/**
 * Card-on-file flags for a charge against a stored payment profile, per Authorize.net's
 * card-on-file guide. No `subsequentAuthInformation`: the guide says not to send
 * `originalNetworkTransId` with customer profiles (the profile stores it), and `reason`
 * names industry-practice MITs (resubmission, no-show …) we never make.
 *  - merchant + recurring → `recurringBilling` (a standing instruction).
 *  - merchant, not recurring, or unknown → `isSubsequentAuth` (unscheduled card on file).
 *  - customer + recurring → `isFirstRecurringPayment` + `recurringBilling` (signup).
 *  - customer, not recurring → `isStoredCredentials` (the buyer pays with a saved card).
 */
export function authorizenetStoredCredential(
  initiator: ChargeInitiator | undefined,
): AuthorizenetStoredCredential {
  if (!initiator)
    return { processingOptions: { isSubsequentAuth: "true" }, recurringBilling: false };
  if (initiator.by === "merchant")
    return initiator.recurring
      ? { recurringBilling: true }
      : { processingOptions: { isSubsequentAuth: "true" }, recurringBilling: false };
  return initiator.recurring
    ? { processingOptions: { isFirstRecurringPayment: "true" }, recurringBilling: true }
    : { processingOptions: { isStoredCredentials: "true" }, recurringBilling: false };
}

// ── Outcomes ───────────────────────────────────────────────────────────────

/** Card money captured: the batch settles it later, the authorization is the verdict. */
const CAPTURED = new Set([
  "capturedPendingSettlement",
  "settledSuccessfully",
  "pendingSettlement",
  "pendingFinalSettlement",
  "updatingSettlement",
]);
const REFUSED = new Set([
  "declined",
  "expired",
  "generalError",
  "failedReview",
  "settlementError",
  "communicationError",
  "voided",
  "returnedItem",
  "chargeback",
]);
/**
 * A settled charge the processor took back later: a reversal, not a decline. An eCheck
 * comes back as `returnedItem` (an ACH return) or `chargeback` (an unauthorized-debit claim).
 */
const LATE_FAILURE = new Set(["settlementError", "returnedItem", "chargeback"]);
/** An eCheck chargeback reversed: the money came back to the merchant. */
const RETURNED_TO_MERCHANT = "chargebackReversal";
/** Before settlement only a void can take the money back. */
const VOIDABLE = new Set([
  "capturedPendingSettlement",
  "authorizedPendingCapture",
  "FDSPendingReview",
  "FDSAuthorizedPendingReview",
  "underReview",
  "approvedReview",
  "pendingSettlement",
]);

const isBank = (tx: AnetTransaction) => Boolean(tx.payment?.bankAccount);

/** What paid (`ChargeResult.methodUsed`). An eCheck is an ACH debit. */
const methodOfTransaction = (tx: AnetTransaction): { methodUsed?: string } =>
  tx.payment?.bankAccount
    ? { methodUsed: "us_bank_account" }
    : tx.payment?.creditCard
      ? { methodUsed: "card" }
      : {};

/** `transactionResponse.accountType`: a card brand, or `eCheck`. */
export const authorizenetMethodUsed = (accountType: string | undefined): { methodUsed?: string } =>
  !accountType ? {} : { methodUsed: accountType === "eCheck" ? "us_bank_account" : "card" };

export function authorizenetDeclineSignal(p: {
  reasonCode?: string | number | null;
  text?: string | null;
  responseCode?: string | number | null;
  cardType?: string | null;
}): DeclineSignal {
  return {
    code: p.reasonCode != null && p.reasonCode !== "" ? String(p.reasonCode) : null,
    message: unescapeAuthorizenetText(p.text) ?? null,
    category: p.responseCode != null ? String(p.responseCode) : null,
    cardBrand: p.cardType ? (BRAND[p.cardType] ?? p.cardType.toLowerCase()) : null,
  };
}

export function authorizenetFailure(sig: DeclineSignal): NonNullable<ChargeResult["failure"]> {
  const f = normalizeAuthorizenetDecline(sig);
  return {
    code: f.code,
    ...(sig.code ? { providerCode: sig.code } : {}),
    message: f.message ?? sig.message ?? "Authorize.net declined this payment.",
    retriable: f.retriable,
    ...(f.retryAfterMs ? { retryAfterMs: f.retryAfterMs } : {}),
    ...(f.ruleId ? { ruleId: f.ruleId } : {}),
  };
}

/** The engine's `DEBIT_CANCELLED_CODE`: a void before settlement moved no money. */
export const AUTHORIZENET_VOIDED_CODE = "debit_cancelled";

/** Why a transaction failed. A void is final, so it is not retriable. */
function transactionFailure(tx: AnetTransaction): NonNullable<ChargeResult["failure"]> {
  if (tx.transactionStatus === "voided")
    return {
      code: AUTHORIZENET_VOIDED_CODE,
      providerCode: "voided",
      message: "The payment was voided at Authorize.net before it settled. No money moved.",
      retriable: false,
    };
  const ret = returnOf(tx);
  return authorizenetFailure(
    authorizenetDeclineSignal({
      reasonCode: ret?.code ?? tx.responseReasonCode,
      text: ret?.description ?? tx.responseReasonDescription,
      responseCode: tx.responseCode,
      cardType: tx.payment?.creditCard?.cardType,
    }),
  );
}

/** A transaction read back, as a charge outcome. `authorization` = an auth-only call. */
export function chargeResultFromTransaction(
  tx: AnetTransaction,
  opts: { authorization?: boolean } = {},
): ChargeResult {
  const status = tx.transactionStatus ?? "";
  const used = methodOfTransaction(tx);
  // A bank debit is collected days later, and only the settlement says so.
  if (
    status === "settledSuccessfully" ||
    status === RETURNED_TO_MERCHANT ||
    (!isBank(tx) && CAPTURED.has(status))
  )
    return { status: "succeeded", providerChargeId: tx.transId, ...used, raw: tx };
  // The void failed, so the money is still captured.
  if (status === "couldNotVoid" && !isBank(tx) && !opts.authorization)
    return { status: "succeeded", providerChargeId: tx.transId, ...used, raw: tx };
  if (opts.authorization && status === "authorizedPendingCapture")
    return { status: "succeeded", providerChargeId: tx.transId, ...used, raw: tx };
  if (REFUSED.has(status))
    return {
      status: "failed",
      providerChargeId: tx.transId,
      failure: transactionFailure(tx),
      ...used,
      raw: tx,
    };
  // Fraud review, a bank debit in flight, or a status newer than this list.
  return { status: "pending", providerChargeId: tx.transId, ...used, raw: tx };
}

/**
 * A `createTransactionRequest` answer as a charge outcome, or the id of the ORIGINAL
 * transaction when this was a duplicate (the caller reads it back).
 */
export function readTransactionResponse(
  res: AnetResponse,
  opts: { authorization?: boolean } = {},
):
  | { result: ChargeResult }
  | { duplicateOf: string }
  | { outcomeUnknown: { transId: string; reason: string } }
  | { apiError: AuthorizenetApiError } {
  const tr = res.transactionResponse;
  const id = tr?.transId && tr.transId !== "0" ? tr.transId : "";
  const err = tr?.errors?.[0];
  const used = authorizenetMethodUsed(tr?.accountType);
  const sig = () =>
    authorizenetDeclineSignal({
      reasonCode: err?.errorCode,
      text: err?.errorText,
      responseCode: tr?.responseCode,
      cardType: tr?.accountType,
    });
  switch (tr?.responseCode) {
    case "1":
      // eCheck: accepted is not collected.
      return {
        result: {
          status: tr.accountType === "eCheck" && !opts.authorization ? "pending" : "succeeded",
          providerChargeId: id,
          ...used,
          raw: res,
        },
      };
    case "4":
      // Held by the Fraud Detection Suite: `fraud.approved` / `fraud.declined` decide it.
      return { result: { status: "pending", providerChargeId: id, ...used, raw: res } };
    case "2":
      return {
        result: {
          status: "failed",
          providerChargeId: id,
          failure: authorizenetFailure(sig()),
          ...used,
          raw: res,
        },
      };
    case "3":
      if (err?.errorCode === DUPLICATE_TRANSACTION && id) return { duplicateOf: id };
      if (err?.errorCode && OUTCOME_UNKNOWN_REASONS.has(err.errorCode))
        return { outcomeUnknown: { transId: id, reason: err.errorCode } };
      return {
        result: {
          status: "failed",
          providerChargeId: id,
          failure: authorizenetFailure(sig()),
          ...used,
          raw: res,
        },
      };
  }
  const m = firstMessage(res);
  return { apiError: new AuthorizenetApiError("create_transaction", m?.code, m?.text) };
}

// ── Payment profiles ───────────────────────────────────────────────────────

const BRAND: Record<string, string> = {
  Visa: "visa",
  MasterCard: "mastercard",
  AmericanExpress: "amex",
  "American Express": "amex",
  Discover: "discover",
  JCB: "jcb",
  DinersClub: "diners",
  "Diners Club": "diners",
  UnionPay: "unionpay",
};

export interface AnetPaymentProfile {
  customerProfileId?: string;
  customerPaymentProfileId?: string;
  payment?: {
    creditCard?: {
      cardNumber?: string;
      expirationDate?: string;
      cardType?: string;
      issuerNumber?: string;
    };
    bankAccount?: { accountNumber?: string; accountType?: string; echeckType?: string };
  };
}

export function describeAuthorizenetPaymentProfile(
  pp: AnetPaymentProfile,
): ProviderPaymentMethodRef["display"] {
  const bank = pp.payment?.bankAccount;
  if (bank) {
    const last4 = bank.accountNumber?.replace(/\D/g, "").slice(-4);
    return { type: "us_bank_account", ...(last4 ? { last4 } : {}) };
  }
  const c = pp.payment?.creditCard ?? {};
  const last4 = c.cardNumber?.replace(/\D/g, "").slice(-4);
  // `unmaskExpirationDate` answers `YYYY-MM`; masked it is `XXXX`.
  const exp = /^(\d{4})-(\d{2})$/.exec(c.expirationDate ?? "");
  return {
    type: "card",
    ...(c.cardType ? { brand: BRAND[c.cardType] ?? c.cardType.toLowerCase() } : {}),
    ...(last4 ? { last4 } : {}),
    ...(exp ? { expYear: Number(exp[1]), expMonth: Number(exp[2]) } : {}),
  };
}

/** The browser's nonce, as `opaqueData`. A bare value or `{dataDescriptor, dataValue}` JSON. */
export function opaqueDataOf(token: string): { dataDescriptor: string; dataValue: string } | null {
  const t = token.trim();
  if (!t) return null;
  if (t.startsWith("{")) {
    try {
      const v = JSON.parse(t) as { dataDescriptor?: unknown; dataValue?: unknown };
      if (typeof v.dataValue !== "string" || !v.dataValue) return null;
      return {
        dataDescriptor: typeof v.dataDescriptor === "string" ? v.dataDescriptor : ACCEPT_DESCRIPTOR,
        dataValue: v.dataValue,
      };
    } catch {
      return null;
    }
  }
  return { dataDescriptor: ACCEPT_DESCRIPTOR, dataValue: t };
}

/** `order` in XSD order: invoice number, then description. */
const orderOf = (invoiceNumber: string, description: string | undefined) => ({
  invoiceNumber,
  ...(description ? { description } : {}),
});

/** `cp:pp` — a saved card as an intent id, so `consumeIntent` can read it back. */
const vaultedIntentId = (cp: string, pp: string) => `${cp}:${pp}`;
function parseVaultedIntentId(id: string): { cp: string; pp: string } | null {
  const m = /^(\d+):(\d+)$/.exec(id);
  return m ? { cp: m[1]!, pp: m[2]! } : null;
}

// ── Synthetic intents ──────────────────────────────────────────────────────

/** What a not-yet-used challenge needs at submit time. Adapters are stateless, so it rides the id. */
interface SyntheticIntent {
  p: IntentPurpose;
  /** Customer profile id (setup). */
  c?: string;
  /** Amount in minor units (payment). */
  a?: string;
  cur: string;
  /** Our ownership ref. */
  r?: string;
  /** Short hash of the idempotency key, so two intents never share an id. */
  k: string;
  /** `b`: the buyer chose a bank account (eCheck). The form then shows bank fields only. */
  m?: "b";
}

/** A refund to a card: the last four digits and `XXXX` for the expiry. */
function cardRefundPayment(tx: AnetTransaction): Record<string, unknown> | null {
  const last4 = (tx.payment?.creditCard?.cardNumber ?? "").replace(/\D/g, "").slice(-4);
  return last4 ? { creditCard: { cardNumber: last4, expirationDate: "XXXX" } } : null;
}

/**
 * A refund to a bank account: the masked numbers the transaction read returns (`XXXX` + last
 * four), in XSD order. WEB has no refunds, so the credit goes as PPD, or CCD for a business.
 */
export function echeckRefundPayment(
  bank: NonNullable<NonNullable<AnetTransaction["payment"]>["bankAccount"]>,
): Record<string, unknown> | null {
  const masked = (v: string | undefined) => {
    const last4 = (v ?? "").replace(/\D/g, "").slice(-4);
    return last4.length === 4 ? `XXXX${last4}` : null;
  };
  const routingNumber = masked(bank.routingNumber);
  const accountNumber = masked(bank.accountNumber);
  if (!routingNumber || !accountNumber) return null;
  return {
    bankAccount: {
      ...(bank.accountType ? { accountType: bank.accountType } : {}),
      routingNumber,
      accountNumber,
      nameOnAccount: (bank.nameOnAccount ?? "").slice(0, 22),
      echeckType: bank.accountType === "businessChecking" ? "CCD" : "PPD",
    },
  };
}

/** The buyer asked for a bank account (eCheck) and nothing else. */
const wantsBank = (methodTypes: readonly string[] | undefined) =>
  methodTypes?.length === 1 && methodTypes[0] === "us_bank_account";

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

// ── Webhooks ───────────────────────────────────────────────────────────────

/**
 * Check `X-ANET-Signature`: HMAC-SHA512 of the raw body with the Signature Key used as TEXT
 * (measured live 2026-10-27: every delivery failed with the hex-decoded key, which is the
 * form of the OTHER HMAC with this key, the response `transHashSha2`). The Merchant Interface
 * shows the key in upper case, so a key entered in lower case is also tried in upper case.
 * The header's hex case and an optional `sha512=` are read; the digest must still match.
 */
export function verifyAuthorizenetSignature(
  signatureKey: string,
  header: string | undefined,
  rawBody: string | Buffer,
): void {
  if (!header) throw new Error("Authorize.net webhook has no X-ANET-Signature header");
  const given = header
    .trim()
    .replace(/^sha512=/i, "")
    .toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(given))
    throw new Error("Authorize.net webhook signature is not a SHA-512 hex digest");
  if (!/^[0-9a-f]+$/i.test(signatureKey) || signatureKey.length % 2 !== 0)
    throw new Error(
      "The Authorize.net Signature Key is not hex: enter it as the Merchant Interface shows it",
    );
  const got = Buffer.from(given, "hex");
  const keys = [...new Set([signatureKey, signatureKey.toUpperCase()])];
  const signedBy = (k: string) =>
    timingSafeEqual(createHmac("sha512", Buffer.from(k, "utf8")).update(rawBody).digest(), got);
  if (!keys.some(signedBy))
    throw new Error("Authorize.net webhook signature does not match the payload");
}

/** Sign a body the way we read Authorize.net does it. For tests and fixtures. */
export function signAuthorizenetPayload(signatureKey: string, body: string): string {
  return `sha512=${createHmac("sha512", Buffer.from(signatureKey, "utf8")).update(body).digest("hex").toUpperCase()}`;
}

export interface AuthorizenetNotification {
  notificationId?: string;
  eventType?: string;
  eventDate?: string;
  webhookId?: string;
  payload?: {
    id?: string;
    entityName?: string;
    responseCode?: number;
    authAmount?: number;
    merchantReferenceId?: string;
    customerProfileId?: number | string;
  };
}

const dateOf = (s: string | undefined) => {
  if (!s) return undefined;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

function ownershipOf(tx: AnetTransaction | null): {
  ownership: "ours" | "foreign" | "unknown";
  ownershipRef?: string;
  providerObjectCreatedAt?: Date;
} {
  if (!tx) return { ownership: "unknown" };
  const created = dateOf(tx.submitTimeUTC);
  // Every transaction we create carries our reference; a read one without it is not ours.
  const ours = OUR_REFERENCE.test(tx.order?.invoiceNumber ?? "");
  const ref = ours ? OWNERSHIP_TAG.exec(tx.order?.description ?? "")?.[1] : undefined;
  return {
    ownership: ours ? "ours" : "foreign",
    ...(ref ? { ownershipRef: ref } : {}),
    ...(created ? { providerObjectCreatedAt: created } : {}),
  };
}

/** A refund transaction as one `refunds[]` record: its own id and amount. */
function refundRecordOf(tx: AnetTransaction, id: string): ProviderRefundRecord | null {
  const amountMinor = toMinor(tx.settleAmount ?? tx.authAmount);
  if (amountMinor == null) return null;
  const s = tx.transactionStatus ?? "";
  const status =
    s === "refundSettledSuccessfully" || (s === "refundPendingSettlement" && !isBank(tx))
      ? "succeeded"
      : REFUSED.has(s)
        ? "failed"
        : "pending";
  const ref = ownershipOf(tx).ownershipRef;
  return { providerRefundId: id, amountMinor, status, ...(ref ? { ownershipRef: ref } : {}) };
}

/** A captured transaction's amount: `settleAmount`, else `authAmount` (equal on a full capture). */
function capturedOf(tx: AnetTransaction): { capturedAmountMinor?: bigint } {
  const amount = toMinor(tx.settleAmount ?? tx.authAmount);
  return amount != null ? { capturedAmountMinor: amount } : {};
}

function failureFields(tx: AnetTransaction) {
  const f = transactionFailure(tx);
  return {
    failureCode: f.code,
    failureRetriable: f.retriable,
    ...(f.providerCode ? { providerFailureCode: f.providerCode } : {}),
    failureMessage: f.message,
  };
}

/**
 * Translate one verified notification. `tx` is the transaction read back with
 * `getTransactionDetails` (payloads carry no type, currency or original id); null when the
 * event needs none or the read found nothing. `profile` is the payment profile for
 * `paymentProfile.updated`.
 */
export function normalizeAuthorizenetNotification(
  n: AuthorizenetNotification,
  eventId: string,
  raw: unknown,
  tx: AnetTransaction | null,
  profile?: AnetPaymentProfile | null,
): NormalizedProviderEvent[] {
  const occurredAt = dateOf(n.eventDate) ?? new Date();
  const base = { providerEventId: eventId, occurredAt, raw };
  const id = n.payload?.id;
  const type = (n.eventType ?? "").replace(/^net\.authorize\./, "");
  const own = ownershipOf(tx);
  const code = String(n.payload?.responseCode ?? "");
  const authOnly = tx?.transactionType === "authOnlyTransaction";

  switch (type) {
    case "payment.authcapture.created":
    case "payment.priorAuthCapture.created": {
      if (!id) break;
      if (tx) {
        const r = chargeResultFromTransaction(tx);
        if (r.status === "succeeded")
          return [
            { ...base, ...own, type: "charge.succeeded", providerChargeId: id, ...capturedOf(tx) },
          ];
        if (r.status === "failed")
          return [
            {
              ...base,
              ...own,
              type: "charge.failed",
              providerChargeId: id,
              ...failureFields(tx),
              ...(LATE_FAILURE.has(tx.transactionStatus ?? "") ? { lateReversal: true } : {}),
            },
          ];
        return [{ ...base, ...own, type: "charge.pending", providerChargeId: id }];
      }
      // No read: an auth-and-capture's own `authAmount` is what it captured. A prior-auth
      // capture can take less than was held, so it reports nothing.
      const payloadAmount =
        type === "payment.authcapture.created" ? toMinor(n.payload?.authAmount) : undefined;
      if (code === "1")
        return [
          {
            ...base,
            ...own,
            type: "charge.succeeded",
            providerChargeId: id,
            ...(payloadAmount != null ? { capturedAmountMinor: payloadAmount } : {}),
          },
        ];
      if (code === "4") return [{ ...base, ...own, type: "charge.pending", providerChargeId: id }];
      return [{ ...base, ...own, type: "charge.failed", providerChargeId: id }];
    }
    case "payment.authorization.created": {
      if (!id) break;
      if (code === "1")
        return [{ ...base, ...own, type: "intent.authorized", providerIntentId: id }];
      if (code === "4") return [{ ...base, ...own, type: "review.opened", providerIntentId: id }];
      return [{ ...base, ...own, type: "intent.failed", providerIntentId: id }];
    }
    case "payment.refund.created": {
      // One event per refund, carrying that refund's own amount (WH), never a total. Its
      // read names the charge it refunds.
      if (!id || !tx?.refTransId || code !== "1") break;
      const rec = refundRecordOf(tx, id);
      if (!rec) break;
      return [
        {
          ...base,
          ...own,
          type: "charge.refunded",
          providerChargeId: tx.refTransId,
          providerRefundId: id,
          refunds: [rec],
        },
      ];
    }
    case "payment.void.created": {
      // A void keeps the transaction's own id.
      if (!id || !tx) break;
      if (tx.transactionType === "refundTransaction")
        return [{ ...base, ...own, type: "refund.failed", providerRefundId: id }];
      // An eCheck is pending until it settles, and a settled one cannot be voided: the debit
      // was stopped before the bank collected it. No money moved, so nothing is refunded.
      if (isBank(tx) && !authOnly)
        return [
          {
            ...base,
            ...own,
            type: "charge.failed",
            providerChargeId: id,
            ...failureFields({ ...tx, transactionStatus: "voided" }),
          },
        ];
      // The tag on a charge is the charge's, not a refund's: leave it off the record.
      const { ownershipRef: _chargeRef, ...ownNoRef } = own;
      const amount = toMinor(tx.authAmount);
      const refunded: NormalizedProviderEvent = {
        ...base,
        ...ownNoRef,
        type: "charge.refunded",
        providerChargeId: id,
        providerRefundId: id,
        ...(amount != null
          ? { refunds: [{ providerRefundId: id, amountMinor: amount, status: "succeeded" }] }
          : {}),
      };
      // The read cannot tell whether an authorization was captured before the void (its type
      // after a capture is unmeasured). Send both: the engine's own record decides. An open
      // hold has no payment to refund; a captured one has no open intent to void.
      if (authOnly)
        return [{ ...base, ...own, type: "intent.voided", providerIntentId: id }, refunded];
      return [refunded];
    }
    case "payment.fraud.held":
      if (!id) break;
      return [{ ...base, ...own, type: "review.opened", providerChargeId: id }];
    case "payment.fraud.approved": {
      if (!id) break;
      const closed = { ...base, ...own, type: "review.closed" as const, providerChargeId: id };
      // Approval sends a held (252) transaction on to the issuer, which can still decline it:
      // the outcome is the status read back. No read: the stale sweep asks later.
      if (!tx) return [closed];
      const st = tx.transactionStatus ?? "";
      if (authOnly) {
        if (st === "authorizedPendingCapture")
          return [closed, { ...base, ...own, type: "intent.authorized", providerIntentId: id }];
        if (REFUSED.has(st))
          return [closed, { ...base, ...own, type: "intent.failed", providerIntentId: id }];
        return [closed];
      }
      const r = chargeResultFromTransaction(tx);
      if (r.status === "succeeded")
        return [
          closed,
          { ...base, ...own, type: "charge.succeeded", providerChargeId: id, ...capturedOf(tx) },
        ];
      if (r.status === "failed")
        return [
          closed,
          { ...base, ...own, type: "charge.failed", providerChargeId: id, ...failureFields(tx) },
        ];
      return [closed, { ...base, ...own, type: "charge.pending", providerChargeId: id }];
    }
    case "payment.fraud.declined": {
      if (!id) break;
      const closed = { ...base, ...own, type: "review.closed" as const, providerChargeId: id };
      if (authOnly)
        return [closed, { ...base, ...own, type: "intent.failed", providerIntentId: id }];
      return [
        closed,
        {
          ...base,
          ...own,
          type: "charge.failed",
          providerChargeId: id,
          ...(tx ? failureFields(tx) : {}),
        },
      ];
    }
    case "customer.paymentProfile.deleted":
      if (!id) break;
      return [{ ...base, type: "payment_method.detached", providerPaymentMethodId: id }];
    case "customer.paymentProfile.updated": {
      if (!id || !profile?.payment?.creditCard) break;
      const d = describeAuthorizenetPaymentProfile(profile);
      return [
        {
          ...base,
          type: "payment_method.updated",
          providerPaymentMethodId: id,
          card: {
            brand: d.brand ?? null,
            last4: d.last4 ?? null,
            expMonth: d.expMonth ?? null,
            expYear: d.expYear ?? null,
          },
        },
      ];
    }
  }
  // Customer and subscription events (ARB is never used), captureOnly and anything newer.
  return [{ ...base, type: "unknown" }];
}

/**
 * A transaction of ours that a settled batch reports as failed after its capture or refund
 * was booked. No webhook says so. The id is stable per transaction and status, so
 * overlapping windows dedupe.
 */
export function normalizeAuthorizenetSettlement(
  tx: AnetTransaction,
  batch: { batchId?: string; settlementTimeUTC?: string },
): NormalizedProviderEvent[] {
  const status = tx.transactionStatus ?? "";
  const collected =
    isBank(tx) && (status === "settledSuccessfully" || status === RETURNED_TO_MERCHANT);
  const refundSettled = isBank(tx) && status === "refundSettledSuccessfully";
  if (!LATE_FAILURE.has(status) && !collected && !refundSettled) return [];
  const own = ownershipOf(tx);
  if (own.ownership !== "ours") return [];
  const base = {
    providerEventId: `anet_settle_${tx.transId}_${status}`,
    occurredAt: dateOf(returnOf(tx)?.dateUTC) ?? dateOf(batch.settlementTimeUTC) ?? new Date(),
    raw: { batch, transaction: tx },
    ...own,
  };
  if (refundSettled) {
    // An eCheck refund is pending until its batch settles; no webhook follows it.
    const rec = tx.refTransId ? refundRecordOf(tx, tx.transId) : null;
    if (!rec) return [];
    return [
      {
        ...base,
        type: "charge.refunded",
        providerChargeId: tx.refTransId!,
        providerRefundId: tx.transId,
        refunds: [rec],
      },
    ];
  }
  if (collected) {
    // A settled eCheck sale (no webhook says so), or a reversed chargeback: the catalogue's
    // `lateCaptureAfterFailure` books it again on the failed payment.
    if (tx.transactionType === "refundTransaction") return [];
    const amount = toMinor(tx.settleAmount ?? tx.authAmount);
    return [
      {
        ...base,
        type: "charge.succeeded",
        providerChargeId: tx.transId,
        ...capturedOf(tx),
        ...(amount != null ? { amountMinor: amount } : {}),
      },
    ];
  }
  if (tx.transactionType === "refundTransaction")
    return [{ ...base, type: "refund.failed", providerRefundId: tx.transId }];
  return [
    {
      ...base,
      type: "charge.failed",
      providerChargeId: tx.transId,
      ...failureFields(tx),
      lateReversal: true,
    },
  ];
}

/** Events that need the transaction read back before they can be translated. */
const NEEDS_TRANSACTION = new Set([
  "payment.authcapture.created",
  "payment.priorAuthCapture.created",
  "payment.authorization.created",
  "payment.refund.created",
  "payment.void.created",
  "payment.fraud.held",
  "payment.fraud.approved",
  "payment.fraud.declined",
]);

// ── The adapter ────────────────────────────────────────────────────────────

export interface AuthorizenetOptions {
  apiLoginId: string;
  transactionKey: string;
  /** 128 hex characters. Checks webhooks. */
  signatureKey: string;
  livemode: boolean;
  /** Host override (tests). Defaults from `livemode`. */
  apiHost?: string;
}

interface CreateTransactionBody {
  transactionType: string;
  amount?: string;
  currencyCode?: string;
  payment?: Record<string, unknown>;
  profile?: { customerProfileId: string; paymentProfile: { paymentProfileId: string } };
  refTransId?: string;
  order?: { invoiceNumber: string; description?: string };
  billTo?: Record<string, string>;
  transactionSettings?: { setting: Array<{ settingName: string; settingValue: string }> };
  processingOptions?: AuthorizenetStoredCredential["processingOptions"];
}

export class AuthorizenetProvider implements PaymentProvider {
  readonly key = "authorizenet" as const;
  readonly capabilities: ProviderCapabilities;
  private readonly host: string;
  private clientKey: Promise<string> | null = null;

  constructor(private readonly opts: AuthorizenetOptions) {
    this.host = (
      opts.apiHost ?? (opts.livemode ? AUTHORIZENET_LIVE_HOST : AUTHORIZENET_SANDBOX_HOST)
    ).replace(/\/+$/, "");
    this.capabilities = {
      refunds: true,
      // Partial refunds need a settled payment; before settlement only a full void works.
      partialRefunds: true,
      // One currency per merchant account; the account's own `currencies` routes it. A
      // currency the account does not accept is refused as reason 39.
      currencies: [],
      // eCheck is saved first (a setup), then charged: no authorization-only debit.
      methods: ["card", "us_bank_account"],
      intents: true,
      intentPurposes: ["payment", "setup"],
      // An authorization is voided without moving money.
      intentVoid: true,
      // An eCheck (or a held card) is voided before its batch settles (`cancelPendingCharge`).
      pendingDebitCancel: true,
      // No per-debit ceiling on a stored card.
      mandates: false,
      perDebitMandateReference: false,
      // No dispute webhook or API: card chargebacks go through the merchant's processor.
      disputeFeed: false,
      // No webhook follows settlement, so a `settlementError` is only in the batch report.
      // Cards settle in one daily batch: every 6 h finds it the same day, at one batch-list
      // call plus one page per 1000 transactions of each batch in the last ~30 h.
      settlementReport: { intervalMinutes: 360, maxWindowHours: 48 },
    };
  }

  // ── transport ──

  private auth() {
    return { name: this.opts.apiLoginId, transactionKey: this.opts.transactionKey };
  }

  /** One JSON API call. Body keys must follow the XSD order. */
  private async call(
    operation: string,
    root: string,
    body: Record<string, unknown>,
  ): Promise<AnetResponse> {
    let res;
    try {
      res = await providerFetch({
        gatewayKey: this.key,
        operation,
        method: "POST",
        url: this.host + XML_API_PATH,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [root]: { merchantAuthentication: this.auth(), ...body } }),
      });
    } catch {
      throw new ProviderIndeterminateError(
        `We could not reach Authorize.net for ${operation}, so we do not know whether it completed. Retry later.`,
      );
    }
    if (res.status >= 500 || res.status === 429)
      throw new ProviderIndeterminateError(
        `Authorize.net answered ${operation} with HTTP ${res.status}. We could not confirm the outcome.`,
      );
    let json: AnetResponse;
    try {
      json = parseAuthorizenetJson<AnetResponse>(res.text);
    } catch {
      throw new ProviderIndeterminateError(
        `We could not read Authorize.net's answer to ${operation} (HTTP ${res.status}).`,
      );
    }
    if (firstMessage(json)?.code === AUTHENTICATION_FAILED)
      throw new Error(`Authorize.net refused the API Login ID or Transaction Key on ${operation}`);
    return json;
  }

  /** A read or a non-money write: an API error throws. */
  private async request<T extends AnetResponse>(
    operation: string,
    root: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const json = await this.call(operation, root, body);
    if (json.messages?.resultCode === "Error") {
      const m = firstMessage(json);
      throw new AuthorizenetApiError(operation, m?.code, m?.text);
    }
    return json as T;
  }

  private async rest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const res = await providerFetch({
      gatewayKey: this.key,
      operation: `webhooks_${method.toLowerCase()}`,
      method,
      url: this.host + REST_PATH + path,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.opts.apiLoginId}:${this.opts.transactionKey}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json: unknown = null;
    if (res.text.trim()) {
      try {
        json = parseAuthorizenetJson(res.text);
      } catch {
        json = res.text;
      }
    }
    return { status: res.status, json };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const r = await this.call("authenticate_test", "authenticateTestRequest", {});
    if (r.messages?.resultCode !== "Ok") return { ok: false, detail: firstMessage(r)?.code };
    const hooks = await this.webhookStatusCheck();
    return {
      ok: hooks.status !== "failed",
      detail: hooks.status === "failed" ? hooks.message : firstMessage(r)?.code,
      checks: [hooks],
    };
  }

  /** Authorize.net sets a webhook `inactive` after 10 failed deliveries and tells no one (WH). */
  private async webhookStatusCheck(): Promise<HealthCheckItem> {
    const key = "webhook_status";
    let hooks;
    try {
      hooks = await this.listWebhooks();
    } catch {
      return {
        key,
        status: "unchecked",
        message: "We could not read the webhooks of this account.",
      };
    }
    const ours = hooks.filter(
      (w) => w.name === WEBHOOK_NAME || /\/gateway_webhooks\/authorizenet\b/.test(w.url ?? ""),
    );
    const inactive = ours.filter((w) => w.status === "inactive");
    if (inactive.length > 0)
      return {
        key,
        status: "failed",
        message: `Authorize.net set the webhook ${inactive.map((w) => w.url).join(", ")} to inactive, so it sends no events to it. Authorize.net does this after 10 failed deliveries.`,
        steps: [
          "Make sure that the webhook address answers HTTP 200.",
          "Set up the webhook of this gateway account again. This makes it active.",
        ],
      };
    if (ours.length === 0)
      return { key, status: "unchecked", message: "This account has no webhook for us." };
    return { key, status: "ok", message: "The webhook is active." };
  }

  /** The Public Client Key the hosted form needs. Read once per adapter. */
  async publicClientKey(): Promise<string> {
    this.clientKey ??= this.request<AnetResponse & { publicClientKey?: string }>(
      "get_merchant_details",
      "getMerchantDetailsRequest",
      {},
    ).then((r) => {
      if (!r.publicClientKey)
        throw new ProviderRefusalError(
          "This Authorize.net account has no Public Client Key. In the Merchant Interface, go to Account → Settings → Security Settings → Manage Public Client Key and make one. Then try again.",
        );
      return r.publicClientKey;
    });
    try {
      return await this.clientKey;
    } catch (e) {
      this.clientKey = null;
      throw e;
    }
  }

  // ── customers ──

  async ensureCustomer(input: EnsureCustomerInput): Promise<ProviderCustomerRef> {
    const json = await this.call("create_customer_profile", "createCustomerProfileRequest", {
      profile: {
        merchantCustomerId: boundedProviderKey(input.customerRef, REFERENCE_MAX),
        ...(input.name ? { description: input.name.slice(0, 255) } : {}),
        ...(input.email ? { email: input.email.slice(0, 255) } : {}),
      },
    });
    const m = firstMessage(json);
    const id = (json as { customerProfileId?: string }).customerProfileId;
    if (json.messages?.resultCode === "Ok" && id)
      return { providerKey: this.key, providerCustomerId: id };
    // Idempotent: "A duplicate record with ID 900000001 already exists." (measured)
    const dup = m?.code === DUPLICATE_RECORD ? /ID (\d+)/.exec(m.text ?? "") : null;
    if (dup) return { providerKey: this.key, providerCustomerId: dup[1]! };
    throw new AuthorizenetApiError("create_customer_profile", m?.code, m?.text);
  }

  async updateCustomer(ref: ProviderCustomerRef, input: EnsureCustomerInput): Promise<void> {
    await this.request("update_customer_profile", "updateCustomerProfileRequest", {
      profile: {
        merchantCustomerId: boundedProviderKey(input.customerRef, REFERENCE_MAX),
        ...(input.name ? { description: input.name.slice(0, 255) } : {}),
        ...(input.email ? { email: input.email.slice(0, 255) } : {}),
        customerProfileId: ref.providerCustomerId,
      },
    });
  }

  // ── vault ──

  private async readPaymentProfile(cp: string, pp: string): Promise<AnetPaymentProfile | null> {
    try {
      const r = await this.request<AnetResponse & { paymentProfile?: AnetPaymentProfile }>(
        "get_payment_profile",
        "getCustomerPaymentProfileRequest",
        { customerProfileId: cp, customerPaymentProfileId: pp, unmaskExpirationDate: "true" },
      );
      return r.paymentProfile ?? null;
    } catch (e) {
      if (e instanceof AuthorizenetApiError && e.code === RECORD_NOT_FOUND) return null;
      throw e;
    }
  }

  private refOf(
    cp: string,
    pp: AnetPaymentProfile & { customerPaymentProfileId: string },
  ): ProviderPaymentMethodRef {
    return {
      providerKey: this.key,
      providerPaymentMethodId: pp.customerPaymentProfileId,
      providerCustomerId: cp,
      display: describeAuthorizenetPaymentProfile(pp),
    };
  }

  /**
   * Save a nonce as a payment profile, checked first: `liveMode` runs a $0 (or $0.01)
   * authorization on a live account, `testMode` a format check on the sandbox.
   */
  private async savePaymentProfile(
    cp: string,
    opaque: { dataDescriptor: string; dataValue: string },
    names: { firstName?: string; lastName?: string },
    opts: { bank?: boolean } = {},
  ): Promise<{ ref?: ProviderPaymentMethodRef; failure?: NonNullable<ChargeResult["failure"]> }> {
    const billTo = {
      ...(names.firstName ? { firstName: names.firstName.slice(0, 50) } : {}),
      ...(names.lastName ? { lastName: names.lastName.slice(0, 50) } : {}),
    };
    const json = await this.call("create_payment_profile", "createCustomerPaymentProfileRequest", {
      customerProfileId: cp,
      paymentProfile: {
        ...(Object.keys(billTo).length ? { billTo } : {}),
        payment: { opaqueData: opaque },
      },
      validationMode: this.opts.livemode ? "liveMode" : "testMode",
    });
    const m = firstMessage(json);
    const ppId = (json as { customerPaymentProfileId?: string }).customerPaymentProfileId;
    if (ppId && (json.messages?.resultCode === "Ok" || m?.code === DUPLICATE_RECORD)) {
      const pp = await this.readPaymentProfile(cp, ppId);
      if (!pp) throw new Error(`Authorize.net did not return payment profile ${ppId}`);
      if (Boolean(pp.payment?.bankAccount) !== Boolean(opts.bank)) {
        // A bank account needs the payer's authorization, which only the bank flow collects.
        await this.deletePaymentProfile(cp, ppId).catch(() => undefined);
        return {
          failure: {
            code: "invalid_client_result",
            message: opts.bank
              ? "The form returned a card, not a bank account. Select Credit or debit card to add a card."
              : "The form returned a bank account, not a card. Select US bank account to add a bank account.",
            retriable: false,
          },
        };
      }
      return { ref: this.refOf(cp, { ...pp, customerPaymentProfileId: ppId }) };
    }
    if (m?.code === INVALID_NONCE)
      return {
        failure: {
          code: "invalid_client_result",
          message: "The card details expired. Enter them again.",
          retriable: true,
        },
      };
    // The check's own answer: `responseCode,subcode,reasonCode,text,…` (measured).
    const direct = String(
      (json as { validationDirectResponse?: string }).validationDirectResponse ?? "",
    ).split(",");
    if (direct.length > 3)
      return {
        failure: authorizenetFailure(
          authorizenetDeclineSignal({
            reasonCode: direct[2],
            text: direct[3],
            responseCode: direct[0],
          }),
        ),
      };
    const f = authorizenetFailure(
      authorizenetDeclineSignal({ reasonCode: m?.code, text: m?.text }),
    );
    if (f.ruleId) return { failure: f };
    throw new AuthorizenetApiError("create_payment_profile", m?.code, m?.text);
  }

  async vaultPaymentMethod(input: VaultPaymentMethodInput): Promise<ProviderPaymentMethodRef> {
    const opaque = opaqueDataOf(input.token);
    if (!opaque)
      throw new ProviderRefusalError(
        "We could not save this card. The card details from the browser are not valid.",
      );
    const out = await this.savePaymentProfile(input.customer.providerCustomerId, opaque, {});
    if (out.ref) return out.ref;
    throw new ProviderRefusalError(`We could not save this card. ${out.failure!.message}`);
  }

  async fetchPaymentMethodDisplay(input: {
    providerPaymentMethodId: string;
    providerCustomerId?: string;
  }): Promise<ProviderPaymentMethodRef["display"] | null> {
    if (!input.providerCustomerId) return null;
    const pp = await this.readPaymentProfile(
      input.providerCustomerId,
      input.providerPaymentMethodId,
    );
    return pp ? describeAuthorizenetPaymentProfile(pp) : null;
  }

  async fetchVaultedPaymentMethod(input: {
    providerCustomerId: string;
    providerPaymentMethodId: string;
  }): Promise<ProviderPaymentMethodRef | null> {
    const pp = await this.readPaymentProfile(
      input.providerCustomerId,
      input.providerPaymentMethodId,
    );
    if (!pp?.payment?.creditCard && !pp?.payment?.bankAccount) return null;
    return this.refOf(input.providerCustomerId, {
      ...pp,
      customerPaymentProfileId: input.providerPaymentMethodId,
    });
  }

  private async deletePaymentProfile(cp: string, pp: string): Promise<void> {
    const json = await this.call("delete_payment_profile", "deleteCustomerPaymentProfileRequest", {
      customerProfileId: cp,
      customerPaymentProfileId: pp,
    });
    const m = firstMessage(json);
    if (json.messages?.resultCode === "Ok") return;
    if (m?.code === RECORD_NOT_FOUND) {
      log.info("gateway delete skipped — the card was already gone at Authorize.net", {
        event: "authorizenet_delete_already_gone",
      });
      return;
    }
    throw new AuthorizenetApiError("delete_payment_profile", m?.code, m?.text);
  }

  async deletePaymentMethod(input: {
    customer: ProviderCustomerRef;
    paymentMethod: ProviderPaymentMethodRef;
  }): Promise<void> {
    await this.deletePaymentProfile(
      input.paymentMethod.providerCustomerId ?? input.customer.providerCustomerId,
      input.paymentMethod.providerPaymentMethodId,
    );
  }

  // ── money ──

  async readTransaction(transId: string): Promise<AnetTransaction | null> {
    try {
      const r = await this.request<AnetResponse & { transaction?: AnetTransaction }>(
        "get_transaction_details",
        "getTransactionDetailsRequest",
        { transId },
      );
      return r.transaction ?? null;
    } catch (e) {
      if (e instanceof AuthorizenetApiError && e.code === RECORD_NOT_FOUND) return null;
      throw e;
    }
  }

  /**
   * The first listed transaction carrying `reference`, newest first, over every page. A list
   * cut short would answer "not found" for a charge that exists, so past the page cap it
   * throws. `since` stops at the first page that reaches back past it.
   */
  private async scanList(
    operation: string,
    root: string,
    body: Record<string, unknown>,
    reference: string,
    since?: Date,
  ): Promise<ListedTransaction | null> {
    for (let page = 1; page <= LIST_MAX_PAGES; page++) {
      const r = await this.request<AnetResponse & { transactions?: ListedTransaction[] }>(
        operation,
        root,
        {
          ...body,
          sorting: NEWEST_FIRST,
          paging: { limit: String(LIST_PAGE_SIZE), offset: String(page) },
        },
      );
      const rows = r.transactions ?? [];
      const hit = rows.find((t) => t.invoiceNumber === reference);
      if (hit) return hit;
      if (rows.length < LIST_PAGE_SIZE) return null;
      const oldest = dateOf(rows[rows.length - 1]?.submitTimeUTC);
      if (since && oldest && oldest < since) return null;
    }
    throw new Error(
      `Authorize.net ${operation}: more than ${LIST_MAX_PAGES * LIST_PAGE_SIZE} transactions to search`,
    );
  }

  /**
   * The newest transaction carrying our reference, or null. The customer list holds only
   * SETTLED transactions (measured: a charge made seconds earlier is absent), so the
   * merchant's unsettled list is read first.
   */
  async findByReference(
    customerProfileId: string,
    reference: string,
  ): Promise<AnetTransaction | null> {
    const hit =
      (await this.scanList(
        "find_unsettled_by_reference",
        "getUnsettledTransactionListRequest",
        {},
        reference,
      )) ??
      (await this.scanList(
        "find_transaction_by_reference",
        "getTransactionListForCustomerRequest",
        { customerProfileId },
        reference,
      ));
    return hit ? this.readTransaction(hit.transId) : null;
  }

  /** A transaction in a batch settled since `since`, by our reference. */
  private async findSettledSince(
    reference: string,
    since: Date,
  ): Promise<ListedTransaction | null> {
    const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    const now = Date.now();
    for (let from = since.getTime(); from < now; from += BATCH_WINDOW_MS) {
      const r = await this.request<AnetResponse & { batchList?: unknown }>(
        "list_settled_batches",
        "getSettledBatchListRequest",
        {
          firstSettlementDate: iso(from),
          lastSettlementDate: iso(Math.min(from + BATCH_WINDOW_MS, now)),
        },
      );
      const list = r.batchList as { batch?: unknown } | unknown[] | undefined;
      const batches = (
        Array.isArray(list) ? list : ((list?.batch as unknown[] | undefined) ?? [])
      ) as Array<{
        batchId?: string;
      }>;
      for (const b of batches) {
        if (!b.batchId) continue;
        const hit = await this.scanList(
          "find_in_batch_by_reference",
          "getTransactionListRequest",
          { batchId: b.batchId },
          reference,
        );
        if (hit) return hit;
      }
    }
    return null;
  }

  /**
   * A charge whose answer was lost, by the reference we sent (`invoiceNumber`): the unsettled
   * list back to `createdAfter`, then every batch settled since. Null is definite.
   */
  async locateCharge(input: {
    ownershipRef: string;
    idempotencyKey: string;
    createdAfter: Date;
  }): Promise<ChargeResult | null> {
    const ref = authorizenetReference(input.idempotencyKey);
    const hit =
      (await this.scanList(
        "locate_unsettled",
        "getUnsettledTransactionListRequest",
        {},
        ref,
        input.createdAfter,
      )) ?? (await this.findSettledSince(ref, input.createdAfter));
    if (!hit) return null;
    const tx = await this.readTransaction(hit.transId);
    if (!tx) throw new Error(`Authorize.net lists transaction ${hit.transId} but cannot read it`);
    return chargeResultFromTransaction(tx);
  }

  /**
   * The settlement report, run by the settlement-report poll: batches settled in the window
   * (and {@link SETTLEMENT_LOOKBACK_MS} before it), each batch's transactions, and a details
   * read only for a transaction of ours with news: a late failure, or a settled eCheck sale
   * or refund. eCheck batches are read back {@link ECHECK_RETURN_WINDOW_MS}: an ACH return
   * changes the status of a transaction in an old batch, and no webhook says so. Read-only;
   * a capped list throws, so the window is read again rather than skipped.
   */
  async pollSettlements(input: { since: Date; until: Date }): Promise<NormalizedProviderEvent[]> {
    const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    const until = input.until.getTime();
    const recentFrom = input.since.getTime() - SETTLEMENT_LOOKBACK_MS;
    const out: NormalizedProviderEvent[] = [];
    const seen = new Set<string>();
    for (let from = Math.min(recentFrom, until - ECHECK_RETURN_WINDOW_MS); from < until;) {
      const to = Math.min(from + BATCH_WINDOW_MS, until);
      const r = await this.request<AnetResponse & { batchList?: unknown }>(
        "settlement_batches",
        "getSettledBatchListRequest",
        // `Z` makes both dates UTC; otherwise the merchant's time zone applies (API reference).
        { firstSettlementDate: iso(from), lastSettlementDate: iso(to) },
      );
      const list = r.batchList as { batch?: unknown } | unknown[] | undefined;
      const batches = (
        Array.isArray(list) ? list : ((list?.batch as unknown[] | undefined) ?? [])
      ) as Array<{ batchId?: string; settlementTimeUTC?: string; paymentMethod?: string }>;
      for (const b of batches) {
        // A batch on a window edge is listed twice.
        if (!b.batchId || seen.has(b.batchId)) continue;
        const settledAt = dateOf(b.settlementTimeUTC)?.getTime();
        const recent = settledAt == null || settledAt >= recentFrom;
        const echeck = b.paymentMethod === "eCheck";
        if (!recent && !echeck) continue;
        seen.add(b.batchId);
        if (seen.size > SETTLEMENT_MAX_BATCHES)
          throw new Error(
            `Authorize.net settlement_batches: more than ${SETTLEMENT_MAX_BATCHES} batches to read`,
          );
        for (const row of await this.batchTransactions(b.batchId)) {
          if (!OUR_REFERENCE.test(row.invoiceNumber ?? "")) continue;
          const st = row.transactionStatus ?? "";
          const news =
            LATE_FAILURE.has(st) ||
            (echeck && st === RETURNED_TO_MERCHANT) ||
            (echeck &&
              recent &&
              (st === "settledSuccessfully" || st === "refundSettledSuccessfully"));
          if (!news) continue;
          const tx = await this.readTransaction(row.transId);
          if (!tx)
            throw new Error(`Authorize.net lists transaction ${row.transId} but cannot read it`);
          out.push(...normalizeAuthorizenetSettlement(tx, b));
        }
      }
      from = to;
    }
    return out;
  }

  /** Every transaction of one settled batch, page by page; past the page cap it throws. */
  private async batchTransactions(batchId: string): Promise<ListedTransaction[]> {
    const all: ListedTransaction[] = [];
    for (let page = 1; page <= LIST_MAX_PAGES; page++) {
      const r = await this.request<AnetResponse & { transactions?: ListedTransaction[] }>(
        "settlement_transactions",
        "getTransactionListRequest",
        {
          batchId,
          sorting: { orderBy: "id", orderDescending: "false" },
          paging: { limit: String(LIST_PAGE_SIZE), offset: String(page) },
        },
      );
      const rows = r.transactions ?? [];
      all.push(...rows);
      if (rows.length < LIST_PAGE_SIZE) return all;
    }
    throw new Error(
      `Authorize.net settlement_transactions: batch ${batchId} has more than ${LIST_MAX_PAGES * LIST_PAGE_SIZE} transactions`,
    );
  }

  /**
   * The transaction an earlier call with this reference made, or null. An API refusal (the
   * Transaction Details API is off) lets the call go on under the duplicate window; an
   * unknown answer stops it, because nothing was sent yet.
   */
  private async earlierAttempt(
    operation: string,
    customerProfileId: string,
    ref: string,
  ): Promise<AnetTransaction | null> {
    try {
      return await this.findByReference(customerProfileId, ref);
    } catch (e) {
      if (e instanceof AuthorizenetApiError) {
        log.warn("could not look up an earlier attempt; relying on the duplicate window", {
          event: "authorizenet_reference_lookup_refused",
          operation,
          code: e.code,
        });
        return null;
      }
      throw new Error(
        `We could not check Authorize.net for an earlier attempt of ${operation}, so we did not send it. Retry later.`,
      );
    }
  }

  /**
   * One money call. A duplicate is read back. A lost answer is looked up by our reference on
   * the customer profile; when that finds nothing either, the outcome is unknown.
   */
  private async transact(
    operation: string,
    ref: string,
    req: CreateTransactionBody,
    opts: { authorization?: boolean; customerProfileId?: string } = {},
  ): Promise<ChargeResult> {
    // XSD order inside transactionRequest: type, amount, currency, payment, profile, refTransId,
    // order, billTo, transactionSettings, processingOptions.
    const transactionRequest: CreateTransactionBody = {
      transactionType: req.transactionType,
      ...(req.amount ? { amount: req.amount } : {}),
      ...(req.currencyCode ? { currencyCode: req.currencyCode } : {}),
      ...(req.payment ? { payment: req.payment } : {}),
      ...(req.profile ? { profile: req.profile } : {}),
      ...(req.refTransId ? { refTransId: req.refTransId } : {}),
      order: req.order ?? { invoiceNumber: ref },
      ...(req.billTo ? { billTo: req.billTo } : {}),
      transactionSettings: {
        setting: [
          { settingName: "duplicateWindow", settingValue: String(AUTHORIZENET_DUPLICATE_WINDOW_S) },
          ...(req.transactionSettings?.setting ?? []),
        ],
      },
      ...(req.processingOptions ? { processingOptions: req.processingOptions } : {}),
    };
    // The duplicate window ends after 8 hours; a key re-sent later would charge again.
    if (opts.customerProfileId) {
      const earlier = await this.earlierAttempt(operation, opts.customerProfileId, ref);
      if (earlier) return chargeResultFromTransaction(earlier, opts);
    }
    let json: AnetResponse;
    try {
      json = await this.call(operation, "createTransactionRequest", {
        refId: ref,
        transactionRequest,
      });
    } catch (e) {
      if (!(e instanceof ProviderIndeterminateError) || !opts.customerProfileId) throw e;
      const found = await this.findByReference(opts.customerProfileId, ref).catch(() => null);
      if (found) return chargeResultFromTransaction(found, opts);
      throw e;
    }
    const out = readTransactionResponse(json, opts);
    if ("result" in out) return out.result;
    if ("outcomeUnknown" in out) {
      const { transId, reason } = out.outcomeUnknown;
      const found = opts.customerProfileId
        ? await this.findByReference(opts.customerProfileId, ref).catch(() => null)
        : null;
      if (found) return chargeResultFromTransaction(found, opts);
      throw markStrandedObject(
        new ProviderIndeterminateError(
          `Authorize.net answered ${operation} with reason ${reason}. Its processor did not answer, so we do not know whether it completed.`,
        ),
        transId,
      );
    }
    if ("duplicateOf" in out) {
      const tx = await this.readTransaction(out.duplicateOf);
      if (!tx)
        throw new ProviderIndeterminateError(
          `Authorize.net reports ${operation} as a repeat of transaction ${out.duplicateOf}, which we could not read. Retry later.`,
        );
      return chargeResultFromTransaction(tx, opts);
    }
    const f = authorizenetFailure(
      authorizenetDeclineSignal({ reasonCode: out.apiError.code, text: out.apiError.text }),
    );
    if (f.ruleId) return { status: "failed", providerChargeId: "", failure: f, raw: json };
    throw out.apiError;
  }

  private profileOf(customer: ProviderCustomerRef, pm: ProviderPaymentMethodRef) {
    return {
      customerProfileId: pm.providerCustomerId ?? customer.providerCustomerId,
      paymentProfile: { paymentProfileId: pm.providerPaymentMethodId },
    };
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    const ref = authorizenetReference(input.idempotencyKey);
    // Card-on-file flags are card network rules; an eCheck profile carries its own SEC code.
    const cof: AuthorizenetStoredCredential =
      input.paymentMethod.display?.type === "us_bank_account"
        ? { recurringBilling: false }
        : authorizenetStoredCredential(input.initiator);
    const profile = this.profileOf(input.customer, input.paymentMethod);
    return this.transact(
      "charge_profile",
      ref,
      {
        transactionType: "authCaptureTransaction",
        amount: minorToDecimalString(input.amountMinor, input.currency.toUpperCase()),
        currencyCode: input.currency.toUpperCase(),
        profile,
        order: orderOf(ref, authorizenetDescription(input.description, input.ownershipRef)),
        transactionSettings: {
          setting: cof.recurringBilling
            ? [{ settingName: "recurringBilling", settingValue: "true" }]
            : [],
        },
        ...(cof.processingOptions ? { processingOptions: cof.processingOptions } : {}),
      },
      { customerProfileId: profile.customerProfileId },
    );
  }

  async fetchChargeStatus(input: { providerChargeId: string }): Promise<ChargeResult> {
    const tx = await this.readTransaction(input.providerChargeId);
    if (!tx) return { status: "pending", providerChargeId: input.providerChargeId };
    return chargeResultFromTransaction(tx);
  }

  /**
   * Refundability is decided here, per transaction, from what Authorize.net reports:
   *  - not settled yet → a void, full amount only (a partial amount is refused with the remedy);
   *  - `couldNotVoid` → the void is sent again: the money is still captured, and such a void
   *    "can be resubmitted if the batch is still open" (Transaction Status help);
   *  - settled card → `refundTransaction` with the last four digits and `XXXX` (any amount);
   *  - settled bank debit → `refundTransaction` with the masked account, sent as PPD (CCD for a
   *    business account): WEB has no refunds, and a WEB debit is refunded as PPD or CCD
   *    (eCheck reference + support KA-04424, read 2026-10-28). Within 180 days of settlement.
   */
  async refund(input: RefundInput): Promise<RefundResult> {
    const tx = await this.readTransaction(input.providerChargeId);
    if (!tx)
      throw new ProviderRefusalError(
        `Authorize.net has no payment ${input.providerChargeId}. We could not refund it.`,
      );
    const status = tx.transactionStatus ?? "";
    const charged = toMinor(tx.settleAmount ?? tx.authAmount) ?? 0n;
    const ref = authorizenetReference(input.idempotencyKey);

    const resubmit = status === "couldNotVoid";
    if (VOIDABLE.has(status) || resubmit) {
      if (input.amountMinor != null && input.amountMinor < charged)
        throw new ProviderRefusalError(
          "Authorize.net cannot refund part of this payment before it settles. Refund the full amount, which cancels the payment, or wait until the payment settles (usually within one day).",
        );
      let json: AnetResponse;
      try {
        json = await this.call("void_transaction", "createTransactionRequest", {
          refId: ref,
          transactionRequest: { transactionType: "voidTransaction", refTransId: tx.transId },
        });
      } catch (e) {
        if (!(e instanceof ProviderIndeterminateError)) throw e;
        // A void keeps the charge's id, so the charge itself says whether it happened.
        const after = await this.readTransaction(tx.transId).catch(() => null);
        if (after?.transactionStatus === "voided")
          return { status: "succeeded", providerRefundId: tx.transId, raw: after };
        throw markStrandedObject(e, tx.transId);
      }
      const tr = json.transactionResponse;
      // A repeat answers responseCode 1 with message 310 "already been voided" (measured).
      if (tr?.responseCode === "1")
        return { status: "succeeded", providerRefundId: tx.transId, raw: json };
      if (resubmit)
        throw new ProviderRefusalError(
          "Authorize.net could not void this payment, so the money is still captured. Wait until the payment settles (usually within one day). Then refund it.",
        );
      const err = tr?.errors?.[0];
      return {
        status: "failed",
        providerRefundId: tx.transId,
        failureMessage: `Authorize.net could not void the payment (${err?.errorCode ?? `response ${tr?.responseCode ?? "none"}`}).${err?.errorText ? ` ${unescapeAuthorizenetText(err.errorText)}` : ""}`,
        raw: json,
      };
    }
    if (status !== "settledSuccessfully")
      throw new ProviderRefusalError(
        `This payment is ${status || "in an unknown state"} at Authorize.net. There is no money to refund.`,
      );

    const amount = input.amountMinor ?? charged;
    const bank = tx.payment?.bankAccount;
    if (bank) {
      const submitted = dateOf(tx.submitTimeUTC)?.getTime();
      if (submitted != null && Date.now() - submitted > ECHECK_REFUND_WINDOW_MS)
        throw new ProviderRefusalError(
          "Authorize.net refunds a bank debit only for 180 days after it settles. Refund it outside Authorize.net, and record the refund offline.",
        );
    }
    const payment = bank ? echeckRefundPayment(bank) : cardRefundPayment(tx);
    if (!payment)
      throw new Error(`Authorize.net transaction ${tx.transId} carries no masked account number`);
    const result = await this.transact(
      "refund_transaction",
      ref,
      {
        transactionType: "refundTransaction",
        amount: minorToDecimalString(amount, (input.currency ?? "USD").toUpperCase()),
        payment,
        refTransId: tx.transId,
        order: orderOf(ref, authorizenetDescription(undefined, input.ownershipRef)),
      },
      { customerProfileId: tx.profile?.customerProfileId },
    );
    return {
      status:
        result.status === "succeeded"
          ? "succeeded"
          : result.status === "failed"
            ? "failed"
            : "pending",
      providerRefundId: result.providerChargeId,
      ...(result.status === "failed" && result.failure?.message
        ? { failureMessage: `Authorize.net refused the refund. ${result.failure.message}` }
        : {}),
      raw: result.raw,
    };
  }

  /**
   * Stop a debit that has not settled: a void of the transaction itself. Only a void stops an
   * eCheck before its batch settles (eCheck reference, read 2026-10-28); after that it is final.
   * A captured card is collected, not pending, so it is answered as final and not voided.
   */
  async cancelPendingCharge(input: CancelPendingChargeInput): Promise<CancelPendingChargeResult> {
    const tx = await this.readTransaction(input.providerChargeId);
    if (!tx)
      return {
        status: "not_cancelable",
        reason: `Authorize.net has no transaction ${input.providerChargeId}`,
      };
    const status = tx.transactionStatus ?? "";
    if (status === "voided") return { status: "cancelled", raw: tx };
    const now = chargeResultFromTransaction(tx);
    if (now.status !== "pending") return { status: "already_final", charge: now, raw: tx };
    if (!VOIDABLE.has(status))
      return {
        status: "not_cancelable",
        reason: `The transaction is ${status || "in an unknown state"} at Authorize.net`,
        raw: tx,
      };
    let reason: string | undefined;
    try {
      const json = await this.call("void_transaction", "createTransactionRequest", {
        refId: authorizenetReference(input.idempotencyKey),
        transactionRequest: { transactionType: "voidTransaction", refTransId: tx.transId },
      });
      const tr = json.transactionResponse;
      // A repeat answers responseCode 1 with message 310 "already been voided" (measured).
      if (tr?.responseCode === "1") return { status: "cancelled", raw: json };
      reason = unescapeAuthorizenetText(tr?.errors?.[0]?.errorText ?? firstMessage(json)?.text);
    } catch (e) {
      if (!(e instanceof ProviderIndeterminateError)) throw e;
      reason = e.message;
    }
    // A void keeps the debit's id, so the debit itself says what happened.
    const after = await this.readTransaction(tx.transId);
    if (after?.transactionStatus === "voided") return { status: "cancelled", raw: after };
    const verdict = after ? chargeResultFromTransaction(after) : null;
    if (verdict && verdict.status !== "pending")
      return {
        status: "already_final",
        charge: verdict,
        ...(reason ? { reason } : {}),
        raw: after,
      };
    return {
      status: "not_cancelable",
      reason: reason ?? "Authorize.net did not void the transaction",
      raw: after,
    };
  }

  async fetchRefundStatus(input: { providerRefundId: string }): Promise<RefundResult> {
    const id = input.providerRefundId;
    const tx = await this.readTransaction(id);
    if (!tx) return { status: "pending", providerRefundId: id };
    const s = tx.transactionStatus ?? "";
    // A full refund before settlement is a void of the charge itself.
    if (tx.transactionType !== "refundTransaction")
      return { status: s === "voided" ? "succeeded" : "pending", providerRefundId: id };
    if (s === "refundSettledSuccessfully" || (s === "refundPendingSettlement" && !isBank(tx)))
      return { status: "succeeded", providerRefundId: id };
    if (REFUSED.has(s)) return { status: "failed", providerRefundId: id };
    return { status: "pending", providerRefundId: id };
  }

  // ── intents ──

  private async sdkChallenge(
    purpose: IntentPurpose,
    amount?: { amountMinor: bigint; currency: string },
    bank = false,
  ): Promise<BuyerAuthorization> {
    return {
      mode: "sdk",
      sdk: {
        provider: this.key,
        params: {
          apiLoginId: this.opts.apiLoginId,
          clientKey: await this.publicClientKey(),
          environment: this.opts.livemode ? "production" : "sandbox",
          purpose,
          // The hosted form shows one rail: the one the buyer chose (and, for a bank
          // account, accepted our authorization text for).
          method: bank ? "us_bank_account" : "card",
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
    const bank = wantsBank(input.methodTypes);
    const setupTokenId = encodeSyntheticIntent({
      p: "setup",
      c: input.customer.providerCustomerId,
      cur: (input.currency ?? "USD").toUpperCase(),
      ...(input.ownershipRef ? { r: input.ownershipRef } : {}),
      k: createHash("sha256")
        .update(input.ownershipRef ?? input.returnUrl)
        .digest("hex")
        .slice(0, 12),
      ...(bank ? { m: "b" as const } : {}),
    });
    return { setupTokenId, ...(await this.sdkChallenge("setup", undefined, bank)) };
  }

  async createIntent(input: CreateIntentInput): Promise<IntentRef> {
    const currency = input.currency.toUpperCase();
    if (input.purpose === "payment" && input.paymentMethod) {
      const ref = authorizenetReference(input.idempotencyKey);
      const profile = this.profileOf(input.customer, input.paymentMethod);
      const cof = authorizenetStoredCredential({
        by: input.session === "on_session" ? "customer" : "merchant",
        recurring: false,
      });
      const charge = await this.transact(
        "authorize_profile",
        ref,
        {
          transactionType: "authOnlyTransaction",
          amount: minorToDecimalString(input.amountMinor ?? 0n, currency),
          currencyCode: currency,
          profile,
          order: orderOf(ref, authorizenetDescription(undefined, input.ownershipRef)),
          ...(cof.processingOptions ? { processingOptions: cof.processingOptions } : {}),
        },
        { authorization: true, customerProfileId: profile.customerProfileId },
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
    // An eCheck is never authorized now: it is saved, then charged (`setupOnlyMethods`).
    const bank = input.purpose === "setup" && wantsBank(input.methodTypes);
    const synthetic: SyntheticIntent = {
      p: input.purpose,
      ...(input.purpose === "setup" ? { c: input.customer.providerCustomerId } : {}),
      ...(input.purpose === "payment" ? { a: String(input.amountMinor ?? 0n) } : {}),
      cur: currency,
      ...(input.ownershipRef ? { r: input.ownershipRef } : {}),
      k: createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 12),
      ...(bank ? { m: "b" as const } : {}),
    };
    return {
      intentId: encodeSyntheticIntent(synthetic),
      status: "requires_action",
      authorization: await this.sdkChallenge(
        input.purpose,
        input.purpose === "payment"
          ? { amountMinor: input.amountMinor ?? 0n, currency }
          : undefined,
        bank,
      ),
    };
  }

  /** The hosted form's nonce: save it (setup) or authorize with it (payment). */
  async submitClientResult(input: {
    intentId: string;
    purpose: IntentPurpose;
    clientResult: Record<string, string>;
    idempotencyKey: string;
  }): Promise<FetchedIntent> {
    const s = decodeSyntheticIntent(input.intentId);
    if (!s) return this.intentState(input.intentId);
    const cr = input.clientResult;
    const opaque = cr.dataValue
      ? { dataDescriptor: cr.dataDescriptor || ACCEPT_DESCRIPTOR, dataValue: cr.dataValue }
      : opaqueDataOf(cr.nonce ?? "");
    if (!opaque)
      return {
        intentId: input.intentId,
        status: "failed",
        failure: {
          code: "invalid_client_result",
          message: "The payment details from the browser are not valid.",
        },
      };
    const names = { firstName: cr.firstName, lastName: cr.lastName };
    if (s.p === "setup") {
      if (!s.c) throw new Error("This Authorize.net setup has no customer profile");
      const out = await this.savePaymentProfile(s.c, opaque, names, { bank: s.m === "b" });
      if (out.ref)
        return {
          intentId: input.intentId,
          status: "authorized",
          gatewayIntentId: vaultedIntentId(s.c, out.ref.providerPaymentMethodId),
        };
      return {
        intentId: input.intentId,
        status: "failed",
        failure: { code: out.failure!.code, message: out.failure!.message },
      };
    }
    const amountMinor = BigInt(s.a ?? "0");
    const ref = authorizenetReference(input.idempotencyKey);
    const billTo = {
      ...(names.firstName ? { firstName: names.firstName.slice(0, 50) } : {}),
      ...(names.lastName ? { lastName: names.lastName.slice(0, 50) } : {}),
    };
    const charge = await this.transact(
      "authorize_nonce",
      ref,
      {
        transactionType: "authOnlyTransaction",
        amount: minorToDecimalString(amountMinor, s.cur),
        currencyCode: s.cur,
        payment: { opaqueData: opaque },
        order: orderOf(ref, authorizenetDescription(undefined, s.r)),
        ...(Object.keys(billTo).length ? { billTo } : {}),
      },
      { authorization: true },
    );
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

  /** Where an authorization stands, in `FetchedIntent` words. */
  private async intentState(id: string): Promise<FetchedIntent> {
    const tx = await this.readTransaction(id).catch(() => null);
    if (!tx) return { intentId: id, status: "unknown" };
    const st = tx.transactionStatus ?? "";
    const status: FetchedIntent["status"] =
      st === "authorizedPendingCapture"
        ? "authorized"
        : CAPTURED.has(st)
          ? "consumed"
          : st === "voided" || st === "expired"
            ? "voided"
            : REFUSED.has(st)
              ? "failed"
              : "unknown";
    const amount = toMinor(tx.authAmount);
    return {
      intentId: id,
      status,
      providerChargeId: tx.transId,
      ...(amount != null ? { amountMinor: amount } : {}),
      raw: tx,
    };
  }

  async consumeIntent(input: ConsumeIntentInput): Promise<ConsumeIntentResult> {
    if (decodeSyntheticIntent(input.intentId))
      throw new Error(
        "This Authorize.net intent has no card from the browser yet. Submit the client result first",
      );
    if (input.purpose === "setup") {
      const v = parseVaultedIntentId(input.intentId);
      const pp = v ? await this.readPaymentProfile(v.cp, v.pp) : null;
      if (!v || !pp) throw new Error(`Authorize.net knows no payment profile ${input.intentId}`);
      return {
        purpose: "setup",
        paymentMethod: this.refOf(v.cp, { ...pp, customerPaymentProfileId: v.pp }),
      };
    }
    const json = await this.call("capture_authorization", "createTransactionRequest", {
      refId: authorizenetReference(input.idempotencyKey),
      transactionRequest: {
        transactionType: "priorAuthCaptureTransaction",
        ...(input.amountMinor != null && input.currency
          ? { amount: minorToDecimalString(input.amountMinor, input.currency.toUpperCase()) }
          : {}),
        refTransId: input.intentId,
      },
    });
    const tr = json.transactionResponse;
    // A repeat answers 311 "already been captured" with transId 0 (measured): the original stands.
    if (tr?.responseCode === "1" && tr.messages?.[0]?.code === ALREADY_CAPTURED)
      return {
        purpose: "payment",
        charge: { status: "succeeded", providerChargeId: input.intentId, raw: json },
      };
    const out = readTransactionResponse(json);
    if ("result" in out)
      return {
        purpose: "payment",
        charge: { ...out.result, providerChargeId: out.result.providerChargeId || input.intentId },
      };
    if ("outcomeUnknown" in out)
      throw markStrandedObject(
        new ProviderIndeterminateError(
          `Authorize.net answered the capture with reason ${out.outcomeUnknown.reason}. We could not confirm the outcome.`,
        ),
        input.intentId,
      );
    throw "apiError" in out
      ? out.apiError
      : new Error("Authorize.net capture answered a duplicate");
  }

  async voidIntent(input: VoidIntentInput): Promise<VoidIntentResult> {
    // An unused challenge or a saved card holds no money.
    if (decodeSyntheticIntent(input.intentId) || parseVaultedIntentId(input.intentId))
      return { voided: true, held: false };
    let held: boolean | undefined;
    const pre = await this.readTransaction(input.intentId).catch(() => null);
    if (pre?.transactionStatus === "voided")
      return { voided: true, providerTransactionId: pre.transId };
    if (pre?.transactionStatus === "authorizedPendingCapture") held = true;
    else if (pre?.transactionStatus && REFUSED.has(pre.transactionStatus)) held = false;
    const json = await this.call("void_transaction", "createTransactionRequest", {
      refId: authorizenetReference(input.idempotencyKey),
      transactionRequest: { transactionType: "voidTransaction", refTransId: input.intentId },
    });
    const tr = json.transactionResponse;
    // A repeat answers responseCode 1 with message 310 "already been voided" (measured).
    const voided = tr?.responseCode === "1";
    if (!voided && !tr) {
      const m = firstMessage(json);
      throw new AuthorizenetApiError("void_transaction", m?.code, m?.text);
    }
    return {
      voided,
      providerTransactionId: input.intentId,
      ...(held !== undefined ? { held } : {}),
    };
  }

  // ── webhooks ──

  /** Lists this account's webhooks (REST). */
  async listWebhooks(): Promise<
    Array<{ webhookId: string; name?: string; url: string; status?: string; eventTypes?: string[] }>
  > {
    const r = await this.rest("GET", "/webhooks");
    if (r.status !== 200 || !Array.isArray(r.json))
      throw new Error(`Authorize.net could not list webhooks (HTTP ${r.status})`);
    return r.json as Array<{
      webhookId: string;
      name?: string;
      url: string;
      status?: string;
      eventTypes?: string[];
    }>;
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    const r = await this.rest("DELETE", `/webhooks/${encodeURIComponent(webhookId)}`);
    if (r.status !== 200 && r.status !== 404)
      throw new Error(`Authorize.net could not delete webhook ${webhookId} (HTTP ${r.status})`);
  }

  async removeWebhookEndpoint(input: { url: string }): Promise<WebhookRemoval> {
    let removed = false;
    for (const w of await this.listWebhooks()) {
      if (w.url !== input.url) continue;
      await this.deleteWebhook(w.webhookId);
      removed = true;
    }
    return { removed };
  }

  /**
   * Register our URL for the events we read, or bring an existing registration of the same
   * URL up to date (re-enabled, same events). No secret comes back: the Signature Key the
   * operator entered signs every event.
   */
  async provisionWebhookEndpoint(input: { url: string }): Promise<ProvisionedWebhook> {
    const events = [...AUTHORIZENET_WEBHOOK_EVENTS];
    const existing = (await this.listWebhooks()).find((w) => w.url === input.url);
    if (existing) {
      const same =
        existing.status === "active" &&
        events.every((e) => existing.eventTypes?.includes(e)) &&
        existing.eventTypes?.length === events.length;
      if (!same) {
        const r = await this.rest("PUT", `/webhooks/${encodeURIComponent(existing.webhookId)}`, {
          url: input.url,
          eventTypes: events,
          status: "active",
        });
        if (r.status !== 200)
          throw new Error(
            `Authorize.net could not update webhook ${existing.webhookId} (HTTP ${r.status})`,
          );
      }
      return { providerEndpointId: existing.webhookId };
    }
    const r = await this.rest("POST", "/webhooks", {
      name: WEBHOOK_NAME,
      url: input.url,
      eventTypes: events,
      status: "active",
    });
    const id = (r.json as { webhookId?: string } | null)?.webhookId;
    if (r.status !== 200 || !id) {
      const detail = (r.json as { details?: Array<{ message?: string }> } | null)?.details?.[0]
        ?.message;
      throw new Error(
        `Authorize.net refused the webhook registration (HTTP ${r.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    return { providerEndpointId: id };
  }

  /** `notificationId` is the same on every retry of one notification. */
  webhookEventId(input: NormalizeWebhookInput): string {
    let id: unknown;
    try {
      id = parseAuthorizenetJson<AuthorizenetNotification>(input.payload.toString()).notificationId;
    } catch {
      id = undefined;
    }
    return webhookEventId([typeof id === "string" && id ? `anet_${id}` : undefined], input.payload);
  }

  async normalizeWebhook(input: NormalizeWebhookInput): Promise<NormalizedProviderEvent[]> {
    verifyAuthorizenetSignature(
      this.opts.signatureKey,
      headerValue(input.headers, "x-anet-signature"),
      input.payload,
    );
    const n = parseAuthorizenetJson<AuthorizenetNotification>(input.payload.toString());
    const type = (n.eventType ?? "").replace(/^net\.authorize\./, "");
    const id = n.payload?.id;
    // Payloads carry no transaction type, currency or original id: read the transaction.
    const tx = id && NEEDS_TRANSACTION.has(type) ? await this.readTransaction(id) : null;
    const cp = n.payload?.customerProfileId;
    const profile =
      type === "customer.paymentProfile.updated" && id && cp != null
        ? await this.readPaymentProfile(String(cp), id)
        : null;
    return normalizeAuthorizenetNotification(n, this.webhookEventId(input), n, tx, profile);
  }
}
