/**
 * Square adapter, over REST v2 (no SDK — the engine never imports one).
 *
 * One Square account works per LOCATION, and a location has one currency: `location_id` is a
 * credential and fixes what this account can charge. Saved cards are Cards API cards on a
 * Square customer (`ccof:…`); renewals charge them with `POST /v2/payments`. Square
 * Subscriptions are never used: the engine owns subscription state.
 *
 * Buyer flow (`mode: 'sdk'`): the Web Payments SDK returns a single-use token. Saving a card
 * takes a card token only (`cnon:`); pay-now also takes Apple Pay, Google Pay, Cash App Pay,
 * Afterpay and ACH. Cards and wallets are authorized (`autocomplete: false`) and captured on
 * consume; ACH must complete at once, so its token is held until consume and then settles by
 * webhook (PENDING → COMPLETED/FAILED).
 *
 * Idempotency: Square takes `idempotency_key` on every create and answers a repeat with the
 * ORIGINAL object (measured). A lost answer is replayed once with the same key, then looked
 * up by our `reference_id` in the location's recent payments; failing both, it is
 * indeterminate and `locateCharge` finds it later. `reference_id` carries our ownership ref
 * (Square payments have no metadata), so a webhook can name the attempt.
 *
 * Webhooks: a subscription per account, created through the API; Square mints its signature
 * key. Signature = base64 HMAC-SHA256 of (notification URL + raw body), keyed with the key
 * text. Measured 2026-10-25 on the sandbox: query strings are accepted in the URL, HTTP is
 * refused (HTTPS_ONLY), retrieve returns the key and list does not.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { minorToDecimalString } from "@/platform/currency";
import { createLogger } from "@/platform/logger";
import { SQUARE_CODE_TABLE, normalizeSquareDecline, type DeclineSignal } from "./decline-codes";
import { classifyGatewayHttp } from "./gateway-http-class";
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
  type WebhookRemoval,
  type RefundInput,
  type RefundResult,
  type VaultPaymentMethodInput,
  type VaultSetupRef,
  type VoidIntentInput,
  type VoidIntentResult,
} from "./types";
import { headerValue, webhookEventId } from "./webhook-event-id";

const log = createLogger("square");

export const SQUARE_SANDBOX_HOST = "https://connect.squareupsandbox.com";
export const SQUARE_LIVE_HOST = "https://connect.squareup.com";
/** The API version we send and register webhooks at (accepted by the sandbox 2026-10-25). */
export const SQUARE_VERSION = "2026-09-16";
/** `reference_id` caps at 40 characters, `idempotency_key` at 45. */
const REFERENCE_MAX = 40;
const IDEMPOTENCY_MAX = 45;
/** Our `reference_id` with no ownership ref: `tm` + 38 hex. */
const OUR_REFERENCE = /^tm[0-9a-f]{38}$/;
/** Our `reference_id` with one: `tm-<ownership ref>-<hex of the key>`. */
const TAGGED_REFERENCE = /^tm-([A-Za-z0-9_]{1,30})-[0-9a-f]{6,}$/;
/** The fewest hex characters that keep two attempts on one ownership ref apart. */
const TAG_HASH_MIN = 6;
/** Our hosted payment link's order `reference_id`: `th-<ownership ref>-<hex of the key>`. */
const HOSTED_REFERENCE = /^th-([A-Za-z0-9_]{1,30})-[0-9a-f]{6,}$/;
const SYNTHETIC_PREFIX = "sqi_";
/** A pay-now payment link, addressed by the order Square made for it (`sqh_<order id>`). */
export const SQUARE_HOSTED_PREFIX = "sqh_";
const BANK_PREFIX = "sqb_";
export const SQUARE_SIGNATURE_HEADER = "x-square-hmacsha256-signature";

/** The webhook events we register. Customer and Square Subscriptions events are not used. */
export const SQUARE_WEBHOOK_EVENTS = [
  "payment.created",
  "payment.updated",
  "refund.created",
  "refund.updated",
  "dispute.created",
  "dispute.state.updated",
  "card.automatically_updated",
  "card.updated",
  "card.disabled",
  "card.forgotten",
] as const;

/**
 * What pay-now may offer. Saving a card offers cards only: nothing else is reusable. Apple Pay
 * goes through a Square payment link instead (`hostedWallet`): in the SDK it needs Square's
 * domain file, and our storefront domain serves another gateway's.
 */
export const SQUARE_PAY_NOW_METHODS = [
  "card",
  "google_pay",
  "cash_app_pay",
  "afterpay",
  "ach",
] as const;
export type SquarePayNowMethod = (typeof SQUARE_PAY_NOW_METHODS)[number];

// ── Small helpers ──────────────────────────────────────────────────────────

/**
 * Our `reference_id` for an idempotency key: same key, same reference. With an ownership ref
 * that fits, the reference carries it, so an event names the attempt; else `tm` + 38 hex.
 */
export function squareReference(idempotencyKey: string, ownershipRef?: string): string {
  const hex = createHash("sha256").update(idempotencyKey).digest("hex");
  const room = REFERENCE_MAX - 4 - (ownershipRef?.length ?? 0);
  if (ownershipRef && /^[A-Za-z0-9_]+$/.test(ownershipRef) && room >= TAG_HASH_MIN)
    return `tm-${ownershipRef}-${hex.slice(0, room)}`;
  return `tm${hex.slice(0, REFERENCE_MAX - 2)}`;
}

/** The order `reference_id` of a hosted pay-now link. Same shape, `th-` prefix. */
export function squareHostedReference(idempotencyKey: string, ownershipRef: string): string {
  return `th${squareReference(idempotencyKey, ownershipRef).slice(2)}`;
}

/** The ownership ref inside a hosted link's order reference, or null when it is not one. */
export function squareHostedRef(reference: string | undefined): string | null {
  return HOSTED_REFERENCE.exec(reference ?? "")?.[1] ?? null;
}

/** A Square idempotency key for one operation on one of our keys. */
export function squareIdempotencyKey(scope: string, key: string): string {
  return boundedProviderKey(`${scope}_${key}`, IDEMPOTENCY_MAX);
}

const money = (amountMinor: bigint, currency: string) => ({
  amount: Number(amountMinor),
  currency: currency.toUpperCase(),
});

const toMinor = (m: { amount?: number } | undefined | null): bigint | undefined =>
  m?.amount == null ? undefined : BigInt(m.amount);

const dateOf = (s: string | undefined | null) => {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

export interface SquareError {
  category?: string;
  code?: string;
  detail?: string;
  field?: string;
}

/** A refusal with no payment behind it. */
export class SquareApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly errors: SquareError[],
  ) {
    const e = errors[0];
    super(`Square ${operation}: ${e?.detail ?? "error"} (${e?.code ?? status})`);
    this.name = "SquareApiError";
  }
  get code() {
    return this.errors[0]?.code;
  }
}

// ── Objects ────────────────────────────────────────────────────────────────

export interface SquareCard {
  id?: string;
  card_brand?: string;
  last_4?: string;
  exp_month?: number;
  exp_year?: number;
  fingerprint?: string;
  card_type?: string;
  prepaid_type?: string;
  customer_id?: string;
  reference_id?: string;
  enabled?: boolean;
  created_at?: string;
}

export interface SquarePayment {
  id: string;
  status?: string;
  location_id?: string;
  source_type?: string;
  created_at?: string;
  amount_money?: { amount?: number; currency?: string };
  total_money?: { amount?: number; currency?: string };
  approved_money?: { amount?: number; currency?: string };
  refunded_money?: { amount?: number; currency?: string };
  reference_id?: string;
  order_id?: string;
  customer_id?: string;
  version_token?: string;
  card_details?: {
    status?: string;
    card?: SquareCard;
    errors?: SquareError[];
  };
  wallet_details?: { status?: string; brand?: string };
  buy_now_pay_later_details?: { brand?: string };
  bank_account_details?: { transfer_type?: string; errors?: SquareError[] };
}

export interface SquareOrder {
  id?: string;
  reference_id?: string;
  state?: string;
  tenders?: Array<{ id?: string; payment_id?: string }>;
}

export interface SquareRefund {
  id: string;
  status?: string;
  payment_id?: string;
  amount_money?: { amount?: number; currency?: string };
  created_at?: string;
}

export interface SquareDispute {
  id?: string;
  dispute_id?: string;
  state?: string;
  reason?: string;
  amount_money?: { amount?: number; currency?: string };
  due_at?: string;
  disputed_payment?: { payment_id?: string };
  created_at?: string;
}

const BRAND: Record<string, string> = {
  VISA: "visa",
  MASTERCARD: "mastercard",
  AMERICAN_EXPRESS: "amex",
  DISCOVER: "discover",
  DISCOVER_DINERS: "diners",
  JCB: "jcb",
  CHINA_UNIONPAY: "unionpay",
  INTERAC: "interac",
  EFTPOS: "eftpos",
  FELICA: "felica",
  EBT: "ebt",
};
const brandOf = (b: string | undefined) => (b ? (BRAND[b] ?? b.toLowerCase()) : undefined);

export function describeSquareCard(c: SquareCard): ProviderPaymentMethodRef["display"] {
  return {
    type: "card",
    ...(c.card_brand ? { brand: brandOf(c.card_brand) } : {}),
    ...(c.last_4 ? { last4: c.last_4 } : {}),
    ...(c.exp_month ? { expMonth: c.exp_month } : {}),
    ...(c.exp_year ? { expYear: c.exp_year } : {}),
    ...(c.card_type ? { instrumentFunding: c.card_type.toLowerCase() } : {}),
    ...(c.fingerprint ? { instrumentFingerprint: c.fingerprint } : {}),
  };
}

/**
 * What paid, from Square's own `source_type`. A card token from a wallet button is a CARD to
 * Square, so the browser's claim (`apple_pay`, `google_pay`) is kept only for CARD sources.
 */
export function squareMethodUsed(p: SquarePayment, claimed?: string): string | undefined {
  switch (p.source_type) {
    case "CARD":
      return claimed === "apple_pay" || claimed === "google_pay" ? claimed : "card";
    case "WALLET":
      return p.wallet_details?.brand === "CASH_APP" ? "cash_app_pay" : "wallet";
    case "BUY_NOW_PAY_LATER":
      return "afterpay";
    case "BANK_ACCOUNT":
      return "us_bank_account";
  }
  return undefined;
}

// ── Declines ───────────────────────────────────────────────────────────────

/** A Square error as a decline signal. Currency refusals arrive as `INVALID_VALUE` on the amount. */
export function squareDeclineSignal(e: SquareError | undefined, cardBrand?: string): DeclineSignal {
  const currency = e?.code === "INVALID_VALUE" && e.field === "amount_money.currency";
  return {
    code: currency ? "CURRENCY_MISMATCH" : (e?.code ?? null),
    message: e?.detail ?? null,
    category: e?.category ?? null,
    cardBrand: brandOf(cardBrand) ?? null,
  };
}

/** A refusal we can classify as a decline, rather than a request we got wrong. */
const isDecline = (e: SquareError | undefined, f: { ruleId?: string }) =>
  Boolean(f.ruleId) ||
  e?.category === "PAYMENT_METHOD_ERROR" ||
  Object.hasOwn(SQUARE_CODE_TABLE, e?.code ?? "");

export function squareFailure(sig: DeclineSignal): NonNullable<ChargeResult["failure"]> {
  const f = normalizeSquareDecline(sig);
  return {
    code: f.code,
    ...(sig.code ? { providerCode: sig.code } : {}),
    message: f.message ?? sig.message ?? "Square declined this payment.",
    retriable: f.retriable,
    ...(f.retryAfterMs ? { retryAfterMs: f.retryAfterMs } : {}),
    ...(f.ruleId ? { ruleId: f.ruleId } : {}),
  };
}

// A failed ACH debit names its reason under the bank account (measured: INSUFFICIENT_FUNDS).
const paymentError = (p: SquarePayment, top?: SquareError[]) =>
  p.card_details?.errors?.[0] ?? p.bank_account_details?.errors?.[0] ?? top?.[0];

/** A payment read back (or answered), as a charge outcome. */
export function chargeResultFromPayment(
  p: SquarePayment,
  opts: { authorization?: boolean; claimed?: string; errors?: SquareError[] } = {},
): ChargeResult {
  const methodUsed = squareMethodUsed(p, opts.claimed);
  const base = { providerChargeId: p.id, raw: p, ...(methodUsed ? { methodUsed } : {}) };
  switch (p.status) {
    case "COMPLETED":
      return { status: "succeeded", ...base };
    case "APPROVED":
      return { status: opts.authorization ? "succeeded" : "pending", ...base };
    case "FAILED":
      return {
        status: "failed",
        ...base,
        failure: squareFailure(
          squareDeclineSignal(paymentError(p, opts.errors), p.card_details?.card?.card_brand),
        ),
      };
    case "CANCELED":
      return {
        status: "failed",
        ...base,
        failure: {
          code: "processing_error",
          message: "Square canceled this payment before it was captured.",
          retriable: true,
        },
      };
  }
  // PENDING: an ACH debit in flight. Anything newer is not a verdict either.
  return { status: "pending", ...base };
}

/** Customer-initiated flags. Square has no recurring indicator. Unknown = merchant-initiated. */
export function squareCustomerDetails(initiator: ChargeInitiator | undefined) {
  return { customer_initiated: initiator?.by === "customer", seller_keyed_in: false };
}

// ── Synthetic intents ──────────────────────────────────────────────────────

/** A challenge not yet used. Adapters are stateless, so what submit needs rides the id. */
interface SyntheticIntent {
  p: IntentPurpose;
  /** Square customer id. */
  c?: string;
  /** Amount in minor units (payment). */
  a?: string;
  cur: string;
  /** Our ownership ref. */
  r?: string;
  k: string;
}

/** An ACH token waiting for consume: nothing is held until the payment is created. */
interface BankIntent {
  t: string;
  a: string;
  cur: string;
  c?: string;
  k: string;
}

const encode = (prefix: string, v: unknown) =>
  prefix + Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
function decode<T>(prefix: string, id: string): T | null {
  if (!id.startsWith(prefix)) return null;
  try {
    const v = JSON.parse(Buffer.from(id.slice(prefix.length), "base64url").toString());
    return v && typeof v === "object" ? (v as T) : null;
  } catch {
    return null;
  }
}
export const encodeSquareIntent = (s: SyntheticIntent) => encode(SYNTHETIC_PREFIX, s);
export function decodeSquareIntent(id: string): SyntheticIntent | null {
  const v = decode<SyntheticIntent>(SYNTHETIC_PREFIX, id);
  return v && (v.p === "setup" || v.p === "payment") ? v : null;
}
const decodeBankIntent = (id: string) => {
  const v = decode<BankIntent>(BANK_PREFIX, id);
  return v && typeof v.t === "string" && v.t ? v : null;
};

// ── Webhooks ───────────────────────────────────────────────────────────────

/** Sign a body the way Square does: base64 HMAC-SHA256 of URL + body, keyed with the key text. */
export function signSquarePayload(signatureKey: string, url: string, body: string): string {
  return createHmac("sha256", signatureKey)
    .update(url + body)
    .digest("base64");
}

/** Check `x-square-hmacsha256-signature` against each candidate URL. Returns the one that signed. */
export function verifySquareSignature(
  signatureKey: string,
  header: string | undefined,
  urls: readonly string[],
  rawBody: string | Buffer,
): string {
  if (!header) throw new Error("Square webhook has no x-square-hmacsha256-signature header");
  if (!urls.length)
    throw new Error("Square webhook cannot be checked without its notification URL");
  const given = Buffer.from(header.trim(), "base64");
  if (given.length !== 32) throw new Error("Square webhook signature is not an HMAC-SHA256 digest");
  const body = rawBody.toString();
  for (const url of urls) {
    const want = Buffer.from(signSquarePayload(signatureKey, url, body), "base64");
    if (timingSafeEqual(want, given)) return url;
  }
  throw new Error("Square webhook signature does not match the payload and notification URL");
}

export interface SquareNotification {
  merchant_id?: string;
  type?: string;
  event_id?: string;
  created_at?: string;
  data?: {
    type?: string;
    id?: string;
    object?: {
      payment?: SquarePayment;
      refund?: SquareRefund;
      dispute?: SquareDispute;
      card?: SquareCard;
    };
  };
}

/** A payment at another location of the seller belongs to whoever runs that location. */
function ownershipOf(
  p: { reference_id?: string; created_at?: string; location_id?: string },
  locationId?: string,
) {
  const created = dateOf(p.created_at);
  const at = created ? { providerObjectCreatedAt: created } : {};
  const ref = p.reference_id ?? "";
  const tagged = TAGGED_REFERENCE.exec(ref);
  const here = !locationId || !p.location_id || p.location_id === locationId;
  if (!here || !(tagged || OUR_REFERENCE.test(ref)))
    return { ownership: "foreign" as const, ...at };
  return { ownership: "ours" as const, ...(tagged ? { ownershipRef: tagged[1] } : {}), ...at };
}

/** Dispute states that end the case. Everything else is an open case, upserted. */
const DISPUTE_FINAL: Record<string, NormalizedProviderEvent["type"]> = {
  WON: "dispute.won",
  LOST: "dispute.lost",
  // The seller accepted the chargeback: the money stays with the buyer.
  ACCEPTED: "dispute.lost",
  INQUIRY_CLOSED: "dispute.closed",
};

/** Translate one verified notification. Payloads carry the whole object, so nothing is read back. */
export function normalizeSquareNotification(
  n: SquareNotification,
  eventId: string,
  raw: unknown,
  /** `hostedRef`: the payment's order is one of our hosted links, carrying this ownership ref. */
  opts: { locationId?: string; hostedRef?: string } = {},
): NormalizedProviderEvent[] {
  const occurredAt = dateOf(n.created_at) ?? new Date();
  const base = { providerEventId: eventId, occurredAt, raw };
  const type = n.type ?? "";
  const obj = n.data?.object ?? {};

  if ((type === "payment.created" || type === "payment.updated") && obj.payment?.id) {
    const p = obj.payment;
    // A payment link completes at once: the intent books it, then the charge finds the row.
    // A link paid after its intent closed still books through the charge (as late money).
    const hosted = opts.hostedRef ?? squareHostedRef(p.reference_id);
    if (hosted && p.order_id && p.status === "COMPLETED") {
      const m = p.total_money ?? p.amount_money;
      const at = dateOf(p.created_at);
      const common = {
        ...base,
        ownership: "ours" as const,
        ownershipRef: hosted,
        ...(at ? { providerObjectCreatedAt: at } : {}),
        providerIntentId: SQUARE_HOSTED_PREFIX + p.order_id,
        providerChargeId: p.id,
        ...(typeof m?.amount === "number" ? { capturedAmountMinor: BigInt(m.amount) } : {}),
      };
      return [
        { ...common, type: "intent.authorized", gatewayIntentId: p.id, captureState: "succeeded" },
        { ...common, type: "charge.succeeded" },
      ];
    }
    // Another try on the same link may still pay it.
    if (hosted && p.order_id) return [{ ...base, type: "unknown" }];
    // The payment id is also the intent id (`submitClientResult`).
    const amount = toMinor(p.amount_money);
    const own = {
      ...ownershipOf(p, opts.locationId),
      providerIntentId: p.id,
      ...(amount != null ? { amountMinor: amount } : {}),
    };
    switch (p.status) {
      case "COMPLETED": {
        // `total_money` is what a completed payment took (amount plus any tip).
        const m = p.total_money ?? p.amount_money;
        return [
          {
            ...base,
            ...own,
            type: "charge.succeeded",
            providerChargeId: p.id,
            ...(typeof m?.amount === "number" ? { capturedAmountMinor: BigInt(m.amount) } : {}),
          },
        ];
      }
      case "APPROVED":
        return [{ ...base, ...own, type: "intent.authorized" }];
      case "PENDING":
        return [{ ...base, ...own, type: "charge.pending", providerChargeId: p.id }];
      case "CANCELED":
        return [{ ...base, ...own, type: "intent.voided" }];
      case "FAILED": {
        const sig = squareDeclineSignal(paymentError(p), p.card_details?.card?.card_brand);
        const f = squareFailure(sig);
        return [
          {
            ...base,
            ...own,
            type: "charge.failed",
            providerChargeId: p.id,
            failureCode: f.code,
            failureRetriable: f.retriable,
            ...(sig.code ? { providerFailureCode: sig.code } : {}),
            failureMessage: f.message,
          },
        ];
      }
    }
  }

  if ((type === "refund.created" || type === "refund.updated") && obj.refund?.id) {
    const r = obj.refund;
    const created = dateOf(r.created_at);
    const at = created ? { providerObjectCreatedAt: created } : {};
    const amount = toMinor(r.amount_money);
    // Each event carries one refund's own amount, never the payment's running total.
    if (r.status === "COMPLETED" && r.payment_id && amount != null) {
      return [
        {
          ...base,
          ...at,
          type: "charge.refunded",
          providerChargeId: r.payment_id,
          providerRefundId: r.id,
          refunds: [{ providerRefundId: r.id, amountMinor: amount, status: "succeeded" }],
        },
      ];
    }
    if (r.status === "REJECTED" || r.status === "FAILED")
      return [{ ...base, ...at, type: "refund.failed", providerRefundId: r.id }];
    if (r.status === "PENDING")
      return [
        {
          ...base,
          ...at,
          type: "refund.pending",
          providerRefundId: r.id,
          ...(r.payment_id ? { providerChargeId: r.payment_id } : {}),
        },
      ];
  }

  if ((type === "dispute.created" || type === "dispute.state.updated") && obj.dispute) {
    const d = obj.dispute;
    const id = d.id ?? d.dispute_id ?? n.data?.id;
    if (id) {
      const amount = toMinor(d.amount_money);
      const fields = {
        providerDisputeId: id,
        ...(d.disputed_payment?.payment_id
          ? { providerChargeId: d.disputed_payment.payment_id }
          : {}),
        disputeReason: d.reason ?? null,
        disputeStatus: d.state ?? null,
        ...(amount != null ? { disputeAmountMinor: amount } : {}),
        disputeCurrency: d.amount_money?.currency ?? null,
        evidenceDueBy: dateOf(d.due_at) ?? null,
      };
      const final = DISPUTE_FINAL[d.state ?? ""];
      if (final) return [{ ...base, ...fields, type: final }];
      const opened = { ...base, ...fields, type: "dispute.created" as const };
      // Square withholds the disputed amount while a chargeback is open; an inquiry moves no money.
      if (d.state && !d.state.startsWith("INQUIRY_"))
        return [opened, { ...opened, type: "dispute.funds_withdrawn" as const }];
      return [opened];
    }
  }

  if (type.startsWith("card.") && obj.card?.id) {
    const c = obj.card;
    if (type === "card.disabled" || type === "card.forgotten" || c.enabled === false)
      return [{ ...base, type: "payment_method.detached", providerPaymentMethodId: c.id! }];
    if (type === "card.automatically_updated" || type === "card.updated")
      return [
        {
          ...base,
          type: "payment_method.updated",
          providerPaymentMethodId: c.id!,
          card: {
            brand: brandOf(c.card_brand) ?? null,
            last4: c.last_4 ?? null,
            expMonth: c.exp_month ?? null,
            expYear: c.exp_year ?? null,
          },
        },
      ];
  }
  return [{ ...base, type: "unknown" }];
}

// ── The adapter ────────────────────────────────────────────────────────────

export interface SquareOptions {
  accessToken: string;
  /** `sandbox-sq0idb-…` on the sandbox, `sq0idp-…` live. The browser SDK needs it. */
  applicationId: string;
  locationId: string;
  /** The subscription's signature key (stored as `webhook_secret`). */
  signatureKey?: string;
  /** A notification URL to check signatures against besides the one the route passes. */
  notificationUrl?: string;
  livemode: boolean;
  /** Host override (tests). Defaults from `livemode`. */
  apiHost?: string;
}

interface SquareLocation {
  id?: string;
  country?: string;
  currency?: string;
  status?: string;
  capabilities?: string[];
}

interface Call {
  status: number;
  json: Record<string, unknown> & { errors?: SquareError[] };
}

export class SquareProvider implements PaymentProvider {
  readonly key = "square" as const;
  readonly capabilities: ProviderCapabilities;
  private readonly host: string;
  private location_: Promise<SquareLocation> | null = null;

  constructor(private readonly opts: SquareOptions) {
    this.host = (opts.apiHost ?? (opts.livemode ? SQUARE_LIVE_HOST : SQUARE_SANDBOX_HOST)).replace(
      /\/+$/,
      "",
    );
    this.capabilities = {
      refunds: true,
      partialRefunds: true,
      // One currency per location; Square refuses any other (measured: INVALID_VALUE).
      currencies: [],
      // Renewals charge saved cards only. Pay-now's wallets, Afterpay and ACH are not stored.
      methods: ["card"],
      intents: true,
      intentPurposes: ["payment", "setup"],
      intentVoid: true,
      mandates: false,
      perDebitMandateReference: false,
    };
  }

  // ── transport ──

  private async call(
    operation: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Call> {
    let res;
    try {
      res = await providerFetch({
        gatewayKey: this.key,
        operation,
        method,
        url: this.host + path,
        headers: {
          Authorization: `Bearer ${this.opts.accessToken}`,
          "Square-Version": SQUARE_VERSION,
          "Content-Type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ProviderIndeterminateError(
        `We could not reach Square for ${operation}, so we do not know whether it completed. Retry later.`,
      );
    }
    // 408, 409, 429 and 5xx: Square may have done the work. Callers replay with the same key.
    const cls = classifyGatewayHttp({
      status: res.status,
      retryAfter: res.headers.get("retry-after"),
    });
    if (cls.kind === "retry_same_key")
      throw new ProviderIndeterminateError(
        `Square answered ${operation} with HTTP ${res.status}. We could not confirm the outcome.`,
      );
    let json: Call["json"];
    try {
      json = res.text.trim() ? JSON.parse(res.text) : {};
    } catch {
      throw new ProviderIndeterminateError(
        `We could not read Square's answer to ${operation} (HTTP ${res.status}).`,
      );
    }
    if (res.status === 401) throw new Error(`Square refused the access token on ${operation}`);
    return { status: res.status, json };
  }

  /** A read or a non-money write: any error throws. */
  private async request<T>(operation: string, method: string, path: string, body?: unknown) {
    const r = await this.call(operation, method, path, body);
    if (r.status >= 400 || r.json.errors?.length)
      throw new SquareApiError(operation, r.status, r.json.errors ?? []);
    return r.json as T;
  }

  /** The location: its currency and country drive the browser SDK. Read once per adapter. */
  location(): Promise<SquareLocation> {
    this.location_ ??= this.request<{ location?: SquareLocation }>(
      "get_location",
      "GET",
      `/v2/locations/${encodeURIComponent(this.opts.locationId)}`,
    ).then((r) => r.location ?? {});
    return this.location_.catch((e) => {
      this.location_ = null;
      throw e;
    });
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const l = await this.location();
    const ok = l.status === "ACTIVE" && (l.capabilities ?? []).includes("CREDIT_CARD_PROCESSING");
    return { ok, detail: `${l.status ?? "?"} ${l.currency ?? ""}`.trim() };
  }

  // ── customers ──

  private customerBody(input: EnsureCustomerInput) {
    const name = (input.name ?? "").trim();
    const at = name.indexOf(" ");
    const a = input.address;
    return {
      ...(name ? { given_name: (at > 0 ? name.slice(0, at) : name).slice(0, 300) } : {}),
      ...(at > 0 ? { family_name: name.slice(at + 1).slice(0, 300) } : {}),
      ...(input.email ? { email_address: input.email.slice(0, 254) } : {}),
      // Square validates phone numbers; only an international one is sent.
      ...(input.phone?.startsWith("+") ? { phone_number: input.phone } : {}),
      ...(a && (a.line1 || a.postalCode || a.country)
        ? {
            address: {
              ...(a.line1 ? { address_line_1: a.line1 } : {}),
              ...(a.line2 ? { address_line_2: a.line2 } : {}),
              ...(a.city ? { locality: a.city } : {}),
              ...(a.state ? { administrative_district_level_1: a.state } : {}),
              ...(a.postalCode ? { postal_code: a.postalCode } : {}),
              ...(a.country ? { country: a.country.toUpperCase() } : {}),
            },
          }
        : {}),
      reference_id: input.customerRef,
    };
  }

  async ensureCustomer(input: EnsureCustomerInput): Promise<ProviderCustomerRef> {
    const hit = await this.findCustomer(input.customerRef);
    if (hit) return { providerKey: this.key, providerCustomerId: hit };
    const r = await this.call("create_customer", "POST", "/v2/customers", {
      idempotency_key: squareIdempotencyKey("cus", input.customerRef),
      ...this.customerBody(input),
    });
    const id = (r.json as { customer?: { id: string } }).customer?.id;
    if (id) return { providerKey: this.key, providerCustomerId: id };
    // The key made this customer with other details, and search lags a new customer by
    // seconds (measured): read it again before giving up.
    if (r.json.errors?.[0]?.code === "IDEMPOTENCY_KEY_REUSED")
      for (let i = 0; i < 4; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        const again = await this.findCustomer(input.customerRef);
        if (again) return { providerKey: this.key, providerCustomerId: again };
      }
    throw new SquareApiError("create_customer", r.status, r.json.errors ?? []);
  }

  private async findCustomer(customerRef: string): Promise<string | undefined> {
    const found = await this.request<{ customers?: Array<{ id: string }> }>(
      "search_customer",
      "POST",
      "/v2/customers/search",
      { query: { filter: { reference_id: { exact: customerRef } } }, limit: 1 },
    );
    return found.customers?.[0]?.id;
  }

  async updateCustomer(ref: ProviderCustomerRef, input: EnsureCustomerInput): Promise<void> {
    await this.request(
      "update_customer",
      "PUT",
      `/v2/customers/${encodeURIComponent(ref.providerCustomerId)}`,
      this.customerBody(input),
    );
  }

  // ── vault ──

  private refOf(card: SquareCard & { id: string }): ProviderPaymentMethodRef {
    return {
      providerKey: this.key,
      providerPaymentMethodId: card.id,
      ...(card.customer_id ? { providerCustomerId: card.customer_id } : {}),
      display: describeSquareCard(card),
    };
  }

  /** Save a card token as a card on file. A refused card comes back as a failure. */
  async createCard(input: {
    customerId: string;
    token: string;
    verificationToken?: string;
    idempotencyKey: string;
    reference?: string;
  }): Promise<{ ref?: ProviderPaymentMethodRef; failure?: NonNullable<ChargeResult["failure"]> }> {
    if (!input.token.startsWith("cnon:"))
      return {
        failure: {
          code: "invalid_client_result",
          message: "Square saves cards only. Enter a card.",
          retriable: false,
        },
      };
    const r = await this.call("create_card", "POST", "/v2/cards", {
      idempotency_key: squareIdempotencyKey("card", input.idempotencyKey),
      source_id: input.token,
      ...(input.verificationToken ? { verification_token: input.verificationToken } : {}),
      card: {
        customer_id: input.customerId,
        ...(input.reference ? { reference_id: input.reference.slice(0, 128) } : {}),
      },
    });
    const card = (r.json as { card?: SquareCard }).card;
    if (r.status < 400 && card?.id) return { ref: this.refOf({ ...card, id: card.id }) };
    const f = squareFailure(squareDeclineSignal(r.json.errors?.[0]));
    // Measured: a refused card answers 400 INVALID_CARD_DATA on source_id.
    if (isDecline(r.json.errors?.[0], f)) return { failure: f };
    throw new SquareApiError("create_card", r.status, r.json.errors ?? []);
  }

  async vaultPaymentMethod(input: VaultPaymentMethodInput): Promise<ProviderPaymentMethodRef> {
    const out = await this.createCard({
      customerId: input.customer.providerCustomerId,
      token: input.token.trim(),
      idempotencyKey: input.token.trim(),
      ...(input.customerRef ? { reference: input.customerRef } : {}),
    });
    if (out.ref) return out.ref;
    throw new ProviderRefusalError(`We could not save this card. ${out.failure!.message}`);
  }

  private async readCard(id: string): Promise<SquareCard | null> {
    const r = await this.call("get_card", "GET", `/v2/cards/${encodeURIComponent(id)}`);
    if (r.status === 404) return null;
    if (r.status >= 400) throw new SquareApiError("get_card", r.status, r.json.errors ?? []);
    return (r.json as { card?: SquareCard }).card ?? null;
  }

  async fetchPaymentMethodDisplay(input: {
    providerPaymentMethodId: string;
    providerCustomerId?: string;
  }): Promise<ProviderPaymentMethodRef["display"] | null> {
    const c = await this.readCard(input.providerPaymentMethodId);
    if (!c || c.enabled === false) return null;
    if (input.providerCustomerId && c.customer_id !== input.providerCustomerId) return null;
    return describeSquareCard(c);
  }

  async fetchVaultedPaymentMethod(input: {
    providerCustomerId: string;
    providerPaymentMethodId: string;
  }): Promise<ProviderPaymentMethodRef | null> {
    const c = await this.readCard(input.providerPaymentMethodId);
    if (!c?.id || c.enabled === false || c.customer_id !== input.providerCustomerId) return null;
    return this.refOf({ ...c, id: c.id });
  }

  /** Square cannot delete a card; disabling it stops every future charge (measured idempotent). */
  async deletePaymentMethod(input: {
    customer: ProviderCustomerRef;
    paymentMethod: ProviderPaymentMethodRef;
  }): Promise<void> {
    const id = input.paymentMethod.providerPaymentMethodId;
    const r = await this.call(
      "disable_card",
      "POST",
      `/v2/cards/${encodeURIComponent(id)}/disable`,
      {},
    );
    if (r.status === 404) {
      log.info("gateway delete skipped — the card was already gone at Square", {
        event: "square_delete_already_gone",
      });
      return;
    }
    if (r.status >= 400) throw new SquareApiError("disable_card", r.status, r.json.errors ?? []);
  }

  // ── wallets ──

  // ── money ──

  async readPayment(id: string): Promise<SquarePayment | null> {
    // An empty id would read `GET /v2/payments/`, which is the list.
    if (!id) return null;
    const r = await this.call("get_payment", "GET", `/v2/payments/${encodeURIComponent(id)}`);
    if (r.status === 404) return null;
    if (r.status >= 400) throw new SquareApiError("get_payment", r.status, r.json.errors ?? []);
    return (r.json as { payment?: SquarePayment }).payment ?? null;
  }

  /**
   * The newest payment in this location carrying our reference, or null. Searches the last day,
   * or from `since` for two hours. The list lags a new payment by seconds (measured), so a
   * miss is not proof of absence; a window too large to read in full throws.
   */
  async findByReference(
    reference: string,
    window: { since?: Date; totalMinor?: bigint } = {},
  ): Promise<SquarePayment | null> {
    const since = window.since ?? new Date(Date.now() - 24 * 3600_000);
    const until = window.since ? new Date(since.getTime() + 2 * 3600_000) : null;
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({
        location_id: this.opts.locationId,
        begin_time: since.toISOString(),
        ...(until ? { end_time: until.toISOString() } : {}),
        ...(window.totalMinor != null ? { total: String(window.totalMinor) } : {}),
        sort_order: "DESC",
        limit: "100",
        ...(cursor ? { cursor } : {}),
      });
      const r = await this.request<{ payments?: SquarePayment[]; cursor?: string }>(
        "find_payment_by_reference",
        "GET",
        `/v2/payments?${q}`,
      );
      const hit = (r.payments ?? []).find((p) => p.reference_id === reference);
      if (hit) return hit;
      if (!r.cursor) return null;
      cursor = r.cursor;
    }
    throw new Error("Square listed more payments than we read: we could not search them all");
  }

  /** A charge whose answer was lost, by the reference `charge()` derived from the same key. */
  async locateCharge(input: {
    ownershipRef: string;
    idempotencyKey: string;
    amountMinor: bigint;
    currency: string;
    createdAfter: Date;
  }): Promise<ChargeResult | null> {
    const found = await this.findByReference(
      squareReference(input.idempotencyKey, input.ownershipRef),
      { since: input.createdAfter, totalMinor: input.amountMinor },
    );
    return found ? chargeResultFromPayment(found) : null;
  }

  /**
   * One `CreatePayment`. A repeat of the same key returns the original payment, so a lost
   * answer is replayed once, then looked up by reference; failing both, the outcome is unknown.
   */
  private async createPayment(
    operation: string,
    body: Record<string, unknown> & { reference_id: string },
    opts: { authorization?: boolean; claimed?: string } = {},
  ): Promise<ChargeResult> {
    let r: Call;
    try {
      r = await this.call(operation, "POST", "/v2/payments", body);
    } catch (e) {
      if (!(e instanceof ProviderIndeterminateError)) throw e;
      try {
        r = await this.call(`${operation}_replay`, "POST", "/v2/payments", body);
      } catch (e2) {
        if (!(e2 instanceof ProviderIndeterminateError)) throw e2;
        const found = await this.findByReference(body.reference_id).catch(() => null);
        if (found) return chargeResultFromPayment(found, opts);
        throw e2;
      }
    }
    const payment = (r.json as { payment?: SquarePayment }).payment;
    if (payment?.id) return chargeResultFromPayment(payment, { ...opts, errors: r.json.errors });
    const err = r.json.errors?.[0];
    // The key already made a payment: answer with it, never fail into a new key.
    if (err?.code === "IDEMPOTENCY_KEY_REUSED") {
      const found = await this.findByReference(body.reference_id).catch(() => null);
      if (found) return chargeResultFromPayment(found, opts);
      throw new ProviderIndeterminateError(
        `Square says a payment exists for this ${operation} key, and we could not find it yet.`,
      );
    }
    const f = squareFailure(squareDeclineSignal(err));
    if (isDecline(err, f))
      return { status: "failed", providerChargeId: "", failure: f, raw: r.json };
    throw new SquareApiError(operation, r.status, r.json.errors ?? []);
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    return this.createPayment("charge_card", {
      idempotency_key: squareIdempotencyKey("pay", input.idempotencyKey),
      source_id: input.paymentMethod.providerPaymentMethodId,
      customer_id: input.paymentMethod.providerCustomerId ?? input.customer.providerCustomerId,
      location_id: this.opts.locationId,
      amount_money: money(input.amountMinor, input.currency),
      autocomplete: true,
      reference_id: squareReference(input.idempotencyKey, input.ownershipRef),
      ...(input.description ? { note: input.description.slice(0, 500) } : {}),
      ...(input.email ? { buyer_email_address: input.email.slice(0, 255) } : {}),
      customer_details: squareCustomerDetails(input.initiator),
    });
  }

  async fetchChargeStatus(input: { providerChargeId: string }): Promise<ChargeResult> {
    const p = input.providerChargeId ? await this.readPayment(input.providerChargeId) : null;
    if (!p) return { status: "pending", providerChargeId: input.providerChargeId };
    return chargeResultFromPayment(p);
  }

  /**
   * A captured payment is refunded by amount (any amount up to what is left). An authorized
   * one has no money to refund: a full refund cancels it, a partial one is refused.
   */
  async refund(input: RefundInput): Promise<RefundResult> {
    const p = await this.readPayment(input.providerChargeId);
    if (!p)
      throw new ProviderRefusalError(
        `Square has no payment ${input.providerChargeId}. We could not refund it.`,
      );
    const total = toMinor(p.total_money ?? p.amount_money) ?? 0n;
    const left = total - (toMinor(p.refunded_money) ?? 0n);
    const currency = (
      p.total_money?.currency ??
      p.amount_money?.currency ??
      input.currency ??
      "USD"
    ).toUpperCase();
    if (p.status === "APPROVED") {
      if (input.amountMinor != null && input.amountMinor < total)
        throw new ProviderRefusalError(
          "Square cannot refund part of a payment that is not captured. Refund the full amount, which cancels the payment.",
        );
      const c = await this.request<{ payment?: SquarePayment }>(
        "cancel_payment",
        "POST",
        `/v2/payments/${encodeURIComponent(p.id)}/cancel`,
        {},
      ).catch((e) => {
        throw refundRefusal(e);
      });
      return {
        status: c.payment?.status === "CANCELED" ? "succeeded" : "pending",
        providerRefundId: p.id,
        raw: c,
      };
    }
    if (p.status !== "COMPLETED")
      throw new ProviderRefusalError(
        `This payment is ${p.status?.toLowerCase() ?? "in an unknown state"} at Square. There is no money to refund yet.`,
      );
    const amount = input.amountMinor ?? left;
    const r = await this.call("refund_payment", "POST", "/v2/refunds", {
      idempotency_key: squareIdempotencyKey("rf", input.idempotencyKey),
      payment_id: p.id,
      amount_money: money(amount, currency),
      ...(input.reason ? { reason: input.reason.slice(0, 192) } : {}),
    });
    const refund = (r.json as { refund?: SquareRefund }).refund;
    if (refund?.id) return { ...refundResultOf(refund), raw: refund };
    throw refundRefusal(new SquareApiError("refund_payment", r.status, r.json.errors ?? []));
  }

  async fetchRefundStatus(input: { providerRefundId: string }): Promise<RefundResult> {
    const id = input.providerRefundId;
    // A full refund of an uncaptured payment is the cancel of that payment: its own id.
    if (!id.includes("_")) {
      const p = await this.readPayment(id);
      return { status: p?.status === "CANCELED" ? "succeeded" : "pending", providerRefundId: id };
    }
    const r = await this.call("get_refund", "GET", `/v2/refunds/${encodeURIComponent(id)}`);
    const refund = (r.json as { refund?: SquareRefund }).refund;
    if (!refund) return { status: "pending", providerRefundId: id };
    return refundResultOf(refund);
  }

  // ── intents ──

  private async sdkChallenge(
    purpose: IntentPurpose,
    amount?: { amountMinor: bigint; currency: string },
  ): Promise<BuyerAuthorization> {
    const loc = await this.location();
    const currency = (amount?.currency ?? loc.currency ?? "USD").toUpperCase();
    return {
      mode: "sdk",
      sdk: {
        provider: this.key,
        params: {
          applicationId: this.opts.applicationId,
          locationId: this.opts.locationId,
          environment: this.opts.livemode ? "production" : "sandbox",
          purpose,
          countryCode: loc.country ?? "US",
          currency,
          ...(amount ? { amount: minorToDecimalString(amount.amountMinor, currency) } : {}),
          methods: purpose === "setup" ? ["card"] : [...SQUARE_PAY_NOW_METHODS],
        },
      },
    };
  }

  async initiateVaultSetup(input: InitiateVaultSetupInput): Promise<VaultSetupRef> {
    const setupTokenId = encodeSquareIntent({
      p: "setup",
      c: input.customer.providerCustomerId,
      cur: (input.currency ?? "USD").toUpperCase(),
      ...(input.ownershipRef ? { r: input.ownershipRef } : {}),
      k: createHash("sha256")
        .update(input.ownershipRef ?? input.returnUrl)
        .digest("hex")
        .slice(0, 12),
    });
    return { setupTokenId, ...(await this.sdkChallenge("setup")) };
  }

  /**
   * Pay-now Apple Pay on a Square payment link: Square's own checkout page, so no domain of
   * ours is registered. The page also takes cards (a link cannot hide them), and the payment
   * completes at once. Its order carries our reference; the payment carries the order id.
   * https://developer.squareup.com/docs/checkout-api/guidelines-and-limitations
   */
  private async hostedApplePay(input: CreateIntentInput): Promise<IntentRef> {
    if (!input.returnUrl) throw new Error("A Square payment link needs a return URL");
    const currency = input.currency.toUpperCase();
    const amount = money(input.amountMinor ?? 0n, currency);
    const r = await this.call("create_payment_link", "POST", "/v2/online-checkout/payment-links", {
      idempotency_key: squareIdempotencyKey("link", input.idempotencyKey),
      order: {
        location_id: this.opts.locationId,
        reference_id: squareHostedReference(
          input.idempotencyKey,
          input.ownershipRef ?? input.idempotencyKey,
        ),
        line_items: [
          {
            name: (input.description ?? "Invoice payment").slice(0, 255),
            quantity: "1",
            base_price_money: amount,
          },
        ],
      },
      checkout_options: {
        redirect_url: input.returnUrl,
        allow_tipping: false,
        ask_for_shipping_address: false,
        accepted_payment_methods: {
          apple_pay: true,
          google_pay: false,
          cash_app_pay: false,
          afterpay_clearpay: false,
        },
      },
      // No `pre_populated_data.buyer_email`: Square refuses the whole link on an address it
      // will not take (measured on the Sandbox with an example.com address).
      ...(input.description ? { payment_note: input.description.slice(0, 500) } : {}),
    });
    const link = (r.json as { payment_link?: { id?: string; url?: string; order_id?: string } })
      .payment_link;
    if (r.status >= 400 || !link?.url || !link.order_id) {
      if (r.status >= 400 && r.status < 500)
        throw new ProviderRefusalError(
          `Square could not make the Apple Pay checkout page: ${r.json.errors?.[0]?.detail ?? `HTTP ${r.status}`}`,
        );
      throw new SquareApiError("create_payment_link", r.status, r.json.errors ?? []);
    }
    return {
      intentId: SQUARE_HOSTED_PREFIX + link.order_id,
      status: "requires_action",
      authorization: { mode: "redirect", approvalUrl: link.url },
      raw: link,
    };
  }

  async createIntent(input: CreateIntentInput): Promise<IntentRef> {
    const currency = input.currency.toUpperCase();
    if (input.hostedWallet === "apple_pay" && input.purpose === "payment" && !input.paymentMethod)
      return this.hostedApplePay(input);
    if (input.purpose === "payment" && input.paymentMethod) {
      const charge = await this.createPayment(
        "authorize_card",
        {
          idempotency_key: squareIdempotencyKey("auth", input.idempotencyKey),
          source_id: input.paymentMethod.providerPaymentMethodId,
          customer_id: input.paymentMethod.providerCustomerId ?? input.customer.providerCustomerId,
          location_id: this.opts.locationId,
          amount_money: money(input.amountMinor ?? 0n, currency),
          autocomplete: false,
          reference_id: squareReference(input.idempotencyKey, input.ownershipRef),
          ...(input.description ? { note: input.description.slice(0, 500) } : {}),
          customer_details: squareCustomerDetails({
            by: input.session === "on_session" ? "customer" : "merchant",
            recurring: false,
          }),
        },
        { authorization: true },
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
    const synthetic: SyntheticIntent = {
      p: input.purpose,
      c: input.customer.providerCustomerId,
      ...(input.purpose === "payment" ? { a: String(input.amountMinor ?? 0n) } : {}),
      cur: currency,
      ...(input.ownershipRef ? { r: input.ownershipRef } : {}),
      k: createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 12),
    };
    return {
      intentId: encodeSquareIntent(synthetic),
      status: "requires_action",
      authorization: await this.sdkChallenge(
        input.purpose,
        input.purpose === "payment"
          ? { amountMinor: input.amountMinor ?? 0n, currency }
          : undefined,
      ),
    };
  }

  /**
   * The Web Payments SDK's token. Setup saves a card. Payment authorizes a card, wallet or
   * Afterpay token; an ACH token is kept for consume, because Square completes ACH at once.
   */
  async submitClientResult(input: {
    intentId: string;
    purpose: IntentPurpose;
    clientResult: Record<string, string>;
    idempotencyKey: string;
  }): Promise<FetchedIntent> {
    const s = decodeSquareIntent(input.intentId);
    if (!s) return this.intentState(input.intentId);
    const token = (input.clientResult.token ?? input.clientResult.nonce ?? "").trim();
    const verificationToken = input.clientResult.verificationToken?.trim() || undefined;
    const claimed = input.clientResult.method;
    if (!/^(cnon|wnon|bnon|bauth):\S+$/.test(token))
      return {
        intentId: input.intentId,
        status: "failed",
        failure: {
          code: "invalid_client_result",
          message: "The payment details from the browser are not valid.",
        },
      };
    if (s.p === "setup") {
      if (!s.c) throw new Error("This Square setup has no customer");
      const out = await this.createCard({
        customerId: s.c,
        token,
        ...(verificationToken ? { verificationToken } : {}),
        idempotencyKey: input.idempotencyKey,
        ...(s.r ? { reference: s.r } : {}),
      });
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
    if (token.startsWith("bnon:") || token.startsWith("bauth:")) {
      // Nothing is held: the debit is created, and settles by webhook, at consume.
      return {
        intentId: input.intentId,
        status: "authorized",
        gatewayIntentId: encode(BANK_PREFIX, {
          t: token,
          a: String(amountMinor),
          cur: s.cur,
          ...(s.c ? { c: s.c } : {}),
          k: squareReference(input.idempotencyKey, s.r),
        } satisfies BankIntent),
        amountMinor,
        currency: s.cur,
      };
    }
    const charge = await this.createPayment(
      "authorize_token",
      {
        idempotency_key: squareIdempotencyKey("auth", input.idempotencyKey),
        source_id: token,
        ...(verificationToken ? { verification_token: verificationToken } : {}),
        ...(s.c ? { customer_id: s.c } : {}),
        location_id: this.opts.locationId,
        amount_money: money(amountMinor, s.cur),
        autocomplete: false,
        reference_id: squareReference(input.idempotencyKey, s.r),
        customer_details: { customer_initiated: true, seller_keyed_in: false },
      },
      { authorization: true, ...(claimed ? { claimed } : {}) },
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

  private async intentState(id: string): Promise<FetchedIntent> {
    if (decodeBankIntent(id)) return { intentId: id, status: "authorized" };
    const p = await this.readPayment(id).catch(() => null);
    if (!p) return { intentId: id, status: "unknown" };
    const status: FetchedIntent["status"] =
      p.status === "APPROVED"
        ? "authorized"
        : p.status === "COMPLETED"
          ? "consumed"
          : p.status === "CANCELED"
            ? "voided"
            : p.status === "FAILED"
              ? "failed"
              : "unknown";
    const amount = toMinor(p.approved_money ?? p.amount_money);
    return {
      intentId: id,
      status,
      providerChargeId: p.id,
      ...(amount != null ? { amountMinor: amount } : {}),
      raw: p,
    };
  }

  async consumeIntent(input: ConsumeIntentInput): Promise<ConsumeIntentResult> {
    if (input.intentId.startsWith(SQUARE_HOSTED_PREFIX)) {
      // Normally re-pointed to the payment by its webhook; else read it off the order.
      const order = await this.readOrder(input.intentId.slice(SQUARE_HOSTED_PREFIX.length));
      const t = order?.tenders?.find((x) => x.payment_id ?? x.id);
      const p = t ? await this.readPayment(t.payment_id ?? t.id!) : null;
      if (!p) throw new Error(`Square has no payment on the order of ${input.intentId}`);
      return { purpose: "payment", charge: chargeResultFromPayment(p) };
    }
    if (decodeSquareIntent(input.intentId))
      throw new Error(
        "This Square intent has no token from the browser yet. Submit the client result first",
      );
    if (input.purpose === "setup") {
      const c = await this.readCard(input.intentId);
      if (!c?.id || c.enabled === false) throw new Error(`Square knows no card ${input.intentId}`);
      return { purpose: "setup", paymentMethod: this.refOf({ ...c, id: c.id }) };
    }
    const bank = decodeBankIntent(input.intentId);
    if (bank) {
      const amount = input.amountMinor ?? BigInt(bank.a);
      const charge = await this.createPayment("charge_bank", {
        idempotency_key: squareIdempotencyKey("ach", bank.k),
        source_id: bank.t,
        ...(bank.c ? { customer_id: bank.c } : {}),
        location_id: this.opts.locationId,
        amount_money: money(amount, input.currency ?? bank.cur),
        // Measured: "autocomplete must be true for source_id … of type BANK_ACCOUNT".
        autocomplete: true,
        reference_id: bank.k,
        customer_details: { customer_initiated: true, seller_keyed_in: false },
      });
      return { purpose: "payment", charge };
    }
    const p = await this.readPayment(input.intentId);
    if (!p) throw new Error(`Square has no payment ${input.intentId}`);
    // Completed, or past capturing (an authorization cancels itself after 7 days): its result.
    if (p.status === "COMPLETED" || p.status === "CANCELED" || p.status === "FAILED")
      return { purpose: "payment", charge: chargeResultFromPayment(p) };
    let version = p.version_token;
    const approved = toMinor(p.amount_money) ?? 0n;
    if (p.status === "APPROVED" && input.amountMinor != null && input.amountMinor < approved) {
      // Partial capture: lower the amount first (measured: allowed down, captured as lowered).
      const u = await this.request<{ payment?: SquarePayment }>(
        "lower_payment",
        "PUT",
        `/v2/payments/${encodeURIComponent(p.id)}`,
        {
          idempotency_key: squareIdempotencyKey("low", input.idempotencyKey),
          payment: {
            amount_money: money(
              input.amountMinor,
              p.amount_money?.currency ?? input.currency ?? "USD",
            ),
            ...(version ? { version_token: version } : {}),
          },
        },
      );
      version = u.payment?.version_token ?? version;
    }
    // Completing a completed payment answers 200 with it (measured), so a repeat is safe.
    const r = await this.call(
      "capture_payment",
      "POST",
      `/v2/payments/${encodeURIComponent(p.id)}/complete`,
      {
        ...(version ? { version_token: version } : {}),
      },
    );
    const done = (r.json as { payment?: SquarePayment }).payment;
    if (done?.id)
      return {
        purpose: "payment",
        charge: chargeResultFromPayment(done, { errors: r.json.errors }),
      };
    const after = await this.readPayment(p.id);
    if (after?.status === "COMPLETED")
      return { purpose: "payment", charge: chargeResultFromPayment(after) };
    throw new SquareApiError("capture_payment", r.status, r.json.errors ?? []);
  }

  async voidIntent(input: VoidIntentInput): Promise<VoidIntentResult> {
    // An unused challenge, a saved card or a held ACH token holds no money. Nor does a
    // payment link: its payment completes at once, and one made later books as late money.
    if (
      input.intentId.startsWith(SQUARE_HOSTED_PREFIX) ||
      decodeSquareIntent(input.intentId) ||
      decodeBankIntent(input.intentId) ||
      input.intentId.startsWith("ccof:")
    )
      return { voided: true, held: false };
    const pre = await this.readPayment(input.intentId).catch(() => null);
    if (pre?.status === "CANCELED")
      return { voided: true, providerTransactionId: pre.id, held: false };
    const held = pre?.status === "APPROVED" ? true : pre?.status === "FAILED" ? false : undefined;
    // Cancel is idempotent: a repeat answers 200 CANCELED (measured).
    const r = await this.call(
      "cancel_payment",
      "POST",
      `/v2/payments/${encodeURIComponent(input.intentId)}/cancel`,
      {},
    );
    const p = (r.json as { payment?: SquarePayment }).payment;
    if (!p && r.status >= 400)
      throw new SquareApiError("cancel_payment", r.status, r.json.errors ?? []);
    return {
      voided: p?.status === "CANCELED",
      providerTransactionId: input.intentId,
      ...(held !== undefined ? { held } : {}),
    };
  }

  // ── webhooks ──

  async listWebhookSubscriptions(): Promise<
    Array<{
      id: string;
      notification_url?: string;
      enabled?: boolean;
      event_types?: string[];
      api_version?: string;
    }>
  > {
    const out: Array<{
      id: string;
      notification_url?: string;
      enabled?: boolean;
      event_types?: string[];
      api_version?: string;
    }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.request<{ subscriptions?: typeof out; cursor?: string }>(
        "list_webhook_subscriptions",
        "GET",
        `/v2/webhooks/subscriptions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      out.push(...(r.subscriptions ?? []));
      if (!r.cursor) break;
      cursor = r.cursor;
    }
    return out;
  }

  async deleteWebhookSubscription(id: string): Promise<void> {
    const r = await this.call(
      "delete_webhook_subscription",
      "DELETE",
      `/v2/webhooks/subscriptions/${encodeURIComponent(id)}`,
    );
    if (r.status >= 400 && r.status !== 404)
      throw new SquareApiError("delete_webhook_subscription", r.status, r.json.errors ?? []);
  }

  async removeWebhookEndpoint(input: { url: string }): Promise<WebhookRemoval> {
    let removed = false;
    for (const s of await this.listWebhookSubscriptions()) {
      if (s.notification_url !== input.url) continue;
      await this.deleteWebhookSubscription(s.id);
      removed = true;
    }
    return { removed };
  }

  /**
   * Register our URL for the events we read, or bring an existing subscription of the same URL
   * up to date. The signature key Square minted is returned and stored as `webhook_secret`.
   */
  async provisionWebhookEndpoint(input: { url: string }): Promise<ProvisionedWebhook> {
    if (!input.url.startsWith("https://"))
      throw new Error(
        "Square accepts only HTTPS notification URLs. Set WEBHOOK_BASE_URL to an HTTPS URL.",
      );
    const events = [...SQUARE_WEBHOOK_EVENTS];
    type Sub = { id?: string; signature_key?: string; enabled?: boolean; event_types?: string[] };
    const existing = (await this.listWebhookSubscriptions()).find(
      (s) => s.notification_url === input.url,
    );
    if (existing) {
      // Payloads arrive at the subscription's version, so it must be ours.
      const same =
        existing.enabled !== false &&
        existing.api_version === SQUARE_VERSION &&
        events.every((e) => existing.event_types?.includes(e)) &&
        existing.event_types?.length === events.length;
      if (!same)
        await this.request(
          "update_webhook_subscription",
          "PUT",
          `/v2/webhooks/subscriptions/${encodeURIComponent(existing.id)}`,
          {
            subscription: { enabled: true, event_types: events, api_version: SQUARE_VERSION },
          },
        );
      // List omits the key; retrieve returns it (measured).
      const got = await this.request<{ subscription?: Sub }>(
        "get_webhook_subscription",
        "GET",
        `/v2/webhooks/subscriptions/${encodeURIComponent(existing.id)}`,
      );
      if (!got.subscription?.signature_key)
        throw new Error("Square returned no signature key for the webhook subscription");
      return { webhookSecret: got.subscription.signature_key, providerEndpointId: existing.id };
    }
    const r = await this.request<{ subscription?: Sub }>(
      "create_webhook_subscription",
      "POST",
      "/v2/webhooks/subscriptions",
      {
        idempotency_key: randomUUID(),
        subscription: {
          name: "tmbilling",
          event_types: events,
          notification_url: input.url,
          api_version: SQUARE_VERSION,
        },
      },
    );
    const sub = r.subscription;
    if (!sub?.id || !sub.signature_key) throw new Error("Square created no webhook subscription");
    return { webhookSecret: sub.signature_key, providerEndpointId: sub.id };
  }

  /** `event_id` is the same on every retry of one event. */
  webhookEventId(input: NormalizeWebhookInput): string {
    let id: unknown;
    try {
      id = (JSON.parse(input.payload.toString()) as SquareNotification).event_id;
    } catch {
      id = undefined;
    }
    return webhookEventId([typeof id === "string" && id ? `sq_${id}` : undefined], input.payload);
  }

  /**
   * A completed payment with no reference of ours may be a hosted link's: the link's order
   * carries our reference, and the payment carries only the order id. One order read.
   */
  private async hostedRefOf(n: SquareNotification): Promise<string | null> {
    const p = n.data?.object?.payment;
    if (!p?.order_id || p.status !== "COMPLETED") return null;
    if (p.location_id && p.location_id !== this.opts.locationId) return null;
    const ref = p.reference_id ?? "";
    if (OUR_REFERENCE.test(ref) || TAGGED_REFERENCE.test(ref)) return null;
    return (
      squareHostedRef(ref) ?? squareHostedRef((await this.readOrder(p.order_id))?.reference_id)
    );
  }

  private async readOrder(id: string): Promise<SquareOrder | null> {
    const r = await this.call("get_order", "GET", `/v2/orders/${encodeURIComponent(id)}`);
    if (r.status === 404) return null;
    if (r.status >= 400) throw new SquareApiError("get_order", r.status, r.json.errors ?? []);
    return (r.json as { order?: SquareOrder }).order ?? null;
  }

  async normalizeWebhook(input: NormalizeWebhookInput): Promise<NormalizedProviderEvent[]> {
    if (!this.opts.signatureKey)
      throw new Error(
        "This Square account has no webhook signature key. Register the webhook first.",
      );
    const urls = [input.notificationUrl, this.opts.notificationUrl].filter(
      (u, i, a): u is string => !!u && a.indexOf(u) === i,
    );
    verifySquareSignature(
      this.opts.signatureKey,
      headerValue(input.headers, SQUARE_SIGNATURE_HEADER),
      urls,
      input.payload,
    );
    const n = JSON.parse(input.payload.toString()) as SquareNotification;
    const hostedRef = await this.hostedRefOf(n);
    return normalizeSquareNotification(n, this.webhookEventId(input), n, {
      locationId: this.opts.locationId,
      ...(hostedRef ? { hostedRef } : {}),
    });
  }
}

/** A definite 4xx on a refund created nothing: a refusal, so the engine releases the reservation. */
function refundRefusal(e: unknown): unknown {
  if (!(e instanceof SquareApiError) || e.status < 400 || e.status >= 500) return e;
  const err = e.errors[0];
  return new ProviderRefusalError(
    `Square refused the refund. ${err?.detail ?? err?.code ?? `HTTP ${e.status}`}`.trim(),
  );
}

function refundResultOf(r: SquareRefund): RefundResult {
  return {
    status:
      r.status === "COMPLETED"
        ? "succeeded"
        : r.status === "REJECTED" || r.status === "FAILED"
          ? "failed"
          : "pending",
    providerRefundId: r.id,
  };
}
