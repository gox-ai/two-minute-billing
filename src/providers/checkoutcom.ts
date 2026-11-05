/**
 * Checkout.com adapter, over the Unified Payments API (plain HTTP, no SDK).
 *
 * Every account has its own API host, `https://{prefix}.api[.sandbox].checkout.com`; the
 * generic host answers `base_url_invalid`. The secret key's prefix names the environment
 * (`sk_sbox_` = sandbox) and must match the business's mode.
 *
 * Cards on file: the browser runs Flow on a payment session we create (`mode: 'sdk'`). A
 * setup session is a 0-amount `Recurring` card verification with a 3DS mandate challenge,
 * which stores the card as an instrument (`src_…`) on the customer. Its payment id is the
 * initial customer-initiated transaction, and merchant-initiated debits quote it as
 * `previous_payment_id`. It rides `ProviderMandate.reference` with no rail, so no
 * pre-debit notice or mandate surface reads it.
 *
 * Ids: customer `cus_…`, card `src_…`, charge `pay_…`, refund `act_…` (the refund action).
 * An sdk challenge not yet answered is `ckoi_…` (stateless, it carries the session).
 * Amounts are Checkout.com's own minor units, which differ from ISO for a few currencies.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { currencyExponent, minorToDecimalString } from "@/platform/currency";
import { createLogger } from "@/platform/logger";
import { normalizeCheckoutcomDecline, type DeclineSignal } from "./decline-codes";
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
import { bodyId, headerValue, webhookEventId } from "./webhook-event-id";

const log = createLogger("checkoutcom");

/** Metadata key that marks a Checkout.com object as ours (#31). */
export const CHECKOUTCOM_OWNERSHIP_KEY = "tmbilling_ref";
/** What a payment was created for, so a webhook can tell a hold from a charge. */
const KIND_KEY = "tmbilling_kind";
/** Where the customer's billing country rides on the Checkout.com customer. */
const COUNTRY_KEY = "billing_country";
const SYNTHETIC_PREFIX = "ckoi_";
/** A Hosted Payments Page pay-now, addressed by its payment `reference` (`ckoh_th-…`). */
export const CHECKOUTCOM_HOSTED_PREFIX = "ckoh_";
/**
 * The hosted payment's `reference`: `th-` + our ref, 30 characters at most (the limit for an
 * Amex payment). The webhook rebuilds the intent id from it, so nothing else must match.
 */
export function checkoutcomHostedReference(ref: string): string {
  return `th-${boundedProviderKey(ref, 27)}`;
}
/** `reference` is limited to 80 characters; keep the idempotency key short too. */
const REFERENCE_MAX = 80;
const IDEMPOTENCY_MAX = 64;
/** A charge's idempotency key rides its metadata, so a lost answer is found by it (`locateCharge`). */
const KEY_KEY = "tmbilling_key";
/** A money request: the first send and two replays under the same key. */
const MONEY_ATTEMPTS = 3;
const RETRY_WAIT_MS = 250;
/** A longer `Retry-After` ends the replays: the request is then indeterminate. */
const RETRY_MAX_WAIT_MS = 3000;
/** `GET /payments` returns at most 100 per page. */
const LIST_PAGE = 100;
const LIST_MAX_PAGES = 10;
/** Name prefix of the workflows we create, so a re-provision finds its own. */
export const CHECKOUTCOM_WORKFLOW_PREFIX = "tmbilling webhooks";

/** One workflow per gateway account, named after the account id in the URL. */
function checkoutcomWorkflowName(url: string): string {
  let account = "";
  try {
    const u = new URL(url);
    account = u.searchParams.get("id") ?? "";
  } catch {
    account = "";
  }
  return `${CHECKOUTCOM_WORKFLOW_PREFIX} ${account}`.trim();
}

// ── Credentials ──────────────────────────────────────────────────────────────

/** The account prefix, from the prefix itself or a pasted base URL. Lowercase. */
export function checkoutcomApiPrefix(raw: string): string {
  const v = raw.trim().toLowerCase();
  const fromUrl = /^(?:https?:\/\/)?([a-z0-9]+)\.api\.(?:sandbox\.)?checkout\.com\/?$/.exec(v);
  const prefix = fromUrl ? fromUrl[1]! : v;
  if (!/^[a-z0-9]{8}$/.test(prefix))
    throw new Error(
      "Checkout.com api_prefix must be the 8 characters before .api.checkout.com in your base URL",
    );
  return prefix;
}

export function checkoutcomBaseUrl(prefix: string, livemode: boolean): string {
  return `https://${checkoutcomApiPrefix(prefix)}.api.${livemode ? "" : "sandbox."}checkout.com`;
}

/** Throws unless both keys belong to the environment the business runs in. */
export function assertCheckoutcomKeyMode(
  secretKey: string,
  publicKey: string,
  livemode: boolean,
): void {
  const sandboxSk = secretKey.startsWith("sk_sbox_");
  const sandboxPk = publicKey.startsWith("pk_sbox_");
  if (!secretKey.startsWith("sk_") || !publicKey.startsWith("pk_"))
    throw new Error("Checkout.com keys must start with sk_ (secret) and pk_ (public)");
  if (livemode && (sandboxSk || sandboxPk))
    throw new Error(
      "These are Checkout.com sandbox keys (sk_sbox_ / pk_sbox_). A live business needs live keys",
    );
  if (!livemode && (!sandboxSk || !sandboxPk))
    throw new Error(
      "These are Checkout.com live keys. A test business needs sandbox keys (sk_sbox_ / pk_sbox_)",
    );
}

// ── Amounts ──────────────────────────────────────────────────────────────────

/** Checkout.com sends these as the full amount. */
const CKO_ZERO = new Set([
  "BIF",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VUV",
  "VND",
  "XAF",
  "XOF",
  "XPF",
]);
/** Checkout.com divides these by 1000. Every other currency is divided by 100. */
const CKO_THREE = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function checkoutcomExponent(currency: string): number {
  const c = currency.toUpperCase();
  return CKO_ZERO.has(c) ? 0 : CKO_THREE.has(c) ? 3 : 2;
}

/** "Not contain more than nine digits". */
const CKO_MAX_AMOUNT = 999_999_999n;
/** The amount must end in this many zeros: the last digit for 3-decimal currencies, two for CLP. */
const trailingZeros = (c: string) => (CKO_THREE.has(c) ? 10n : c === "CLP" ? 100n : 1n);

/**
 * Our minor units → Checkout.com's. CLP, for example, is 0 decimals for us and 2 there.
 * An amount Checkout.com documents as invalid is refused here, so it is never sent.
 */
export function toCheckoutcomAmount(amountMinor: bigint, currency: string): number {
  const c = currency.toUpperCase();
  const refuse = (why: string) =>
    new ProviderRefusalError(
      `Checkout.com cannot charge ${minorToDecimalString(amountMinor, c)} ${c}: ${why}.`,
    );
  const diff = checkoutcomExponent(c) - currencyExponent(c);
  let v: bigint;
  if (diff >= 0) v = amountMinor * 10n ** BigInt(diff);
  else {
    const f = 10n ** BigInt(-diff);
    if (amountMinor % f !== 0n)
      throw refuse(`it takes this currency to ${checkoutcomExponent(c)} decimal places`);
    v = amountMinor / f;
  }
  if (v > CKO_MAX_AMOUNT) throw refuse("the amount has more than nine digits");
  if (v % trailingZeros(c) !== 0n)
    throw refuse(
      c === "CLP"
        ? "for this currency the amount must be a whole number"
        : "for this currency the last decimal place must be 0",
    );
  return Number(v);
}

export function fromCheckoutcomAmount(amount: number, currency: string): bigint {
  const diff = checkoutcomExponent(currency) - currencyExponent(currency);
  const v = BigInt(Math.round(amount));
  return diff >= 0 ? v / 10n ** BigInt(diff) : v * 10n ** BigInt(-diff);
}

// ── Stored-credential flags ─────────────────────────────────────────────────

export interface CheckoutcomStoredCredential {
  payment_type: "Regular" | "Recurring" | "Unscheduled";
  merchant_initiated: boolean;
}

/**
 * The stored-credential flags for a debit. Absent initiator = merchant-initiated
 * `Unscheduled`: every engine charge uses a stored card, and that is the safest claim.
 */
export function checkoutcomStoredCredential(
  initiator: ChargeInitiator | undefined,
): CheckoutcomStoredCredential {
  if (!initiator) return { payment_type: "Unscheduled", merchant_initiated: true };
  const payment_type = initiator.recurring
    ? "Recurring"
    : initiator.by === "customer"
      ? "Regular"
      : "Unscheduled";
  return { payment_type, merchant_initiated: initiator.by === "merchant" };
}

// ── Payments ─────────────────────────────────────────────────────────────────

export interface CkoSource {
  id?: string;
  type?: string;
  scheme?: string;
  last4?: string;
  expiry_month?: number;
  expiry_year?: number;
  fingerprint?: string;
  card_type?: string;
  card_category?: string;
  issuer?: string;
  issuer_country?: string;
  cvv_check?: string;
  avs_check?: string;
  /** `googlepay` / `applepay`: a wallet token paid; the source is still `card`. */
  card_wallet_type?: string;
}

export interface CkoPayment {
  id: string;
  action_id?: string;
  status?: string;
  approved?: boolean;
  amount?: number;
  currency?: string;
  reference?: string;
  response_code?: string;
  response_summary?: string;
  payment_type?: string;
  requested_on?: string;
  processed_on?: string;
  source?: CkoSource;
  customer?: { id?: string; email?: string };
  metadata?: Record<string, unknown>;
  processing?: {
    scheme?: string;
    partner_response_code?: string;
    partner_merchant_advice_code?: string;
  };
  _links?: Record<string, { href?: string } | undefined>;
}

/** Statuses where the authorization stands (money taken or held). */
const APPROVED = new Set([
  "Authorized",
  "Card Verified",
  "Captured",
  "Partially Captured",
  "Paid",
  "Partially Refunded",
  "Refunded",
]);
const REFUSED = new Set(["Declined", "Canceled", "Expired", "Voided"]);

export function checkoutcomDeclineSignal(p: CkoPayment): DeclineSignal {
  const brand = (p.processing?.scheme ?? p.source?.scheme ?? "").toLowerCase();
  return {
    code: p.response_code ?? null,
    message: p.response_summary ?? null,
    category: p.status ?? null,
    networkMessage: p.processing?.partner_response_code ?? null,
    recommendationCode: p.processing?.partner_merchant_advice_code ?? null,
    cardBrand: brand === "master card" ? "mastercard" : brand || null,
  };
}

function failureOf(p: CkoPayment): NonNullable<ChargeResult["failure"]> {
  const sig = checkoutcomDeclineSignal(p);
  const f = normalizeCheckoutcomDecline(sig);
  return {
    code: f.code,
    ...(sig.code ? { providerCode: sig.code } : {}),
    message: f.message ?? sig.message ?? `Checkout.com reports this payment as ${p.status}`,
    retriable: f.retriable,
    ...(f.retryAfterMs ? { retryAfterMs: f.retryAfterMs } : {}),
    ...(f.ruleId ? { ruleId: f.ruleId } : {}),
  };
}

/**
 * A payment → our charge result. `Authorized` counts as succeeded on an auto-captured
 * charge: the capture follows within seconds, and a later `payment_capture_declined`
 * arrives as `charge.failed` with `lateReversal`.
 */
export function chargeResultFromPayment(p: CkoPayment): ChargeResult {
  const used = checkoutcomMethodUsed(p.source);
  const redirect = p._links?.redirect?.href;
  if (redirect && p.status === "Pending")
    return {
      status: "requires_action",
      providerChargeId: p.id,
      nextAction: { type: "redirect_to_url", data: { url: redirect, approvalRequired: true } },
      ...used,
      raw: p,
    };
  const status = p.status ?? "";
  if (p.approved !== false && APPROVED.has(status))
    return { status: "succeeded", providerChargeId: p.id, ...used, raw: p };
  if (p.approved === false || REFUSED.has(status))
    return { status: "failed", providerChargeId: p.id, failure: failureOf(p), ...used, raw: p };
  // Pending, Retry Scheduled (never requested) or anything newer.
  return { status: "pending", providerChargeId: p.id, ...used, raw: p };
}

/** A payment's `source.type` → our method type (`ChargeResult.methodUsed`). */
const CKO_METHOD_USED: Readonly<Record<string, string>> = {
  card: "card",
  ach: "us_bank_account",
  sepa: "sepa_debit",
  paypal: "paypal",
};
/** `source.card_wallet_type` on a `card` source. */
const CKO_WALLET_USED: Readonly<Record<string, string>> = {
  googlepay: "google_pay",
  applepay: "apple_pay",
};

export function checkoutcomMethodUsed(
  source: Pick<CkoSource, "type" | "card_wallet_type"> | undefined,
): { methodUsed?: string } {
  const type = source?.type?.toLowerCase();
  const wallet = type === "card" ? source?.card_wallet_type?.toLowerCase() : undefined;
  const m = (wallet && CKO_WALLET_USED[wallet]) || (type ? CKO_METHOD_USED[type] : undefined);
  return m ? { methodUsed: m } : {};
}

function ownershipOf(metadata: Record<string, unknown> | undefined) {
  const ref = metadata?.[CHECKOUTCOM_OWNERSHIP_KEY];
  if (typeof ref === "string" && ref) return { ownership: "ours" as const, ownershipRef: ref };
  // Every payment we create carries the tag; metadata without it is someone else's.
  return { ownership: metadata ? ("foreign" as const) : ("unknown" as const) };
}

const BRAND: Record<string, string> = {
  visa: "visa",
  mastercard: "mastercard",
  "master card": "mastercard",
  "american express": "amex",
  amex: "amex",
  discover: "discover",
  jcb: "jcb",
  "diners club international": "diners",
  diners: "diners",
  "cartes bancaires": "cartes_bancaires",
  "union pay": "unionpay",
  unionpay: "unionpay",
  maestro: "maestro",
  mada: "mada",
};

export function describeCheckoutcomSource(s: CkoSource): ProviderPaymentMethodRef["display"] {
  const scheme = s.scheme?.toLowerCase();
  const funding = s.card_type?.toLowerCase();
  const checks = {
    ...(s.cvv_check ? { cvcCheck: s.cvv_check.toLowerCase() } : {}),
    ...(s.avs_check ? { avsPostalCheck: s.avs_check.toLowerCase() } : {}),
  };
  return {
    type: "card",
    ...(scheme ? { brand: BRAND[scheme] ?? scheme.replace(/\s+/g, "_") } : {}),
    ...(s.last4 ? { last4: s.last4 } : {}),
    ...(s.expiry_month ? { expMonth: s.expiry_month } : {}),
    ...(s.expiry_year ? { expYear: s.expiry_year } : {}),
    ...(s.issuer_country && /^[A-Z]{2}$/.test(s.issuer_country)
      ? { issuerCountry: s.issuer_country }
      : {}),
    ...(funding && ["credit", "debit", "prepaid"].includes(funding)
      ? { instrumentFunding: funding }
      : {}),
    ...(s.card_category
      ? {
          instrumentSubType:
            s.card_category.toUpperCase() === "COMMERCIAL"
              ? "business"
              : s.card_category.toLowerCase(),
        }
      : {}),
    ...(s.issuer ? { issuerName: s.issuer } : {}),
    ...(s.fingerprint ? { instrumentFingerprint: s.fingerprint } : {}),
    ...checks,
    ...(Object.keys(checks).length ? { avsCheckedAt: new Date() } : {}),
  };
}

// ── Synthetic intents ────────────────────────────────────────────────────────

/** A Flow challenge not yet answered. Adapters are stateless, so it rides the id. */
export interface CheckoutcomSyntheticIntent {
  p: IntentPurpose;
  /** Checkout.com customer. */
  c?: string;
  /** Payment session id (`ps_…`). */
  s: string;
  cur: string;
  /** Amount in our minor units, as a string (payment only). */
  a?: string;
  /** Our ownership ref. */
  r?: string;
}

export function encodeCheckoutcomIntent(s: CheckoutcomSyntheticIntent): string {
  return SYNTHETIC_PREFIX + Buffer.from(JSON.stringify(s), "utf8").toString("base64url");
}

export function decodeCheckoutcomIntent(id: string): CheckoutcomSyntheticIntent | null {
  if (!id.startsWith(SYNTHETIC_PREFIX)) return null;
  try {
    const v = JSON.parse(Buffer.from(id.slice(SYNTHETIC_PREFIX.length), "base64url").toString());
    return v &&
      typeof v === "object" &&
      (v.p === "setup" || v.p === "payment") &&
      typeof v.s === "string"
      ? v
      : null;
  } catch {
    return null;
  }
}

// ── Webhooks ─────────────────────────────────────────────────────────────────

/** `Cko-Signature`: HMAC-SHA256 of the raw body with the workflow's signature key, hex. */
export function signCheckoutcomPayload(key: string, body: string | Buffer): string {
  return createHmac("sha256", key).update(body).digest("hex");
}

/**
 * Throws unless `signature` is the HMAC of the raw body. Hex is the documented encoding;
 * base64 of the same digest is accepted too (not measured on a live delivery yet).
 */
export function verifyCheckoutcomSignature(
  key: string,
  signature: string | undefined,
  body: string | Buffer,
): void {
  if (!signature) throw new Error("Checkout.com webhook has no Cko-Signature header");
  const digest = createHmac("sha256", key).update(body).digest();
  const given = signature.trim();
  const candidates = [Buffer.from(digest.toString("hex")), Buffer.from(digest.toString("base64"))];
  const got = Buffer.from(/^[0-9a-f]+$/i.test(given) ? given.toLowerCase() : given);
  if (!candidates.some((c) => c.length === got.length && timingSafeEqual(c, got)))
    throw new Error("Checkout.com webhook signature does not match the payload");
}

/** Every event the workflow subscribes to, by source. */
export const CHECKOUTCOM_WEBHOOK_EVENTS: Record<string, string[]> = {
  gateway: [
    "payment_approved",
    "payment_captured",
    "payment_declined",
    "payment_capture_declined",
    "payment_pending",
    "payment_capture_pending",
    "payment_refunded",
    "payment_refund_pending",
    "payment_refund_declined",
    "payment_voided",
    "payment_returned",
  ],
  dispute: [
    "dispute_received",
    "dispute_evidence_required",
    "dispute_evidence_submitted",
    "dispute_evidence_acknowledged_by_scheme",
    "dispute_arbitration_sent_to_scheme",
    "dispute_arbitration_evidence_submitted",
    "dispute_won",
    "dispute_arbitration_won",
    "dispute_lost",
    "dispute_arbitration_lost",
    "dispute_accepted",
    "dispute_expired",
    "dispute_canceled",
    "dispute_resolved",
  ],
  vault_rtau: ["card_updated"],
};

const DISPUTE_TYPE: Record<string, NormalizedProviderEvent["type"]> = {
  dispute_received: "dispute.created",
  // Status moves on a case we already hold: upserted as `dispute.created`.
  dispute_evidence_required: "dispute.created",
  dispute_evidence_submitted: "dispute.created",
  dispute_evidence_acknowledged_by_scheme: "dispute.created",
  dispute_arbitration_sent_to_scheme: "dispute.created",
  dispute_arbitration_evidence_submitted: "dispute.created",
  dispute_won: "dispute.won",
  dispute_arbitration_won: "dispute.won",
  dispute_lost: "dispute.lost",
  dispute_arbitration_lost: "dispute.lost",
  // Accepting a dispute, or missing its deadline, loses it.
  dispute_accepted: "dispute.lost",
  dispute_expired: "dispute.lost",
  // The issuer withdrew it: "If previously debited, the disputed amount is credited back".
  dispute_canceled: "dispute.won",
  dispute_resolved: "dispute.closed",
};

export interface CheckoutcomEvent {
  id?: string;
  type?: string;
  created_on?: string;
  timestamp?: string;
  data?: Record<string, unknown> & {
    id?: string;
    action_id?: string;
    amount?: number;
    currency?: string;
    metadata?: Record<string, unknown>;
    balances?: { total_refunded?: number };
  };
}

const dateOf = (s: unknown) => {
  if (typeof s !== "string" || !s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
};
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** Translate one verified event into our vocabulary. */
export function normalizeCheckoutcomEvent(
  ev: CheckoutcomEvent,
  eventId: string,
  raw: unknown,
): NormalizedProviderEvent[] {
  const type = ev.type ?? "";
  const d = ev.data ?? {};
  const occurredAt = dateOf(ev.created_on) ?? dateOf(ev.timestamp) ?? new Date();
  const base = { providerEventId: eventId, occurredAt, raw };
  const currency = str(d.currency)?.toUpperCase();
  const amountOf = (v: unknown) =>
    typeof v === "number" && currency ? fromCheckoutcomAmount(v, currency) : undefined;

  const disputeType = DISPUTE_TYPE[type];
  if (disputeType) {
    const amount = amountOf(d.amount);
    const e: NormalizedProviderEvent = {
      ...base,
      type: disputeType,
      providerDisputeId: str(d.id),
      providerChargeId: str(d.payment_id),
      disputeReason: str(d.category) ?? str(d.reason_code) ?? null,
      disputeStatus: type.replace(/^dispute_/, ""),
      ...(amount != null ? { disputeAmountMinor: amount } : {}),
      disputeCurrency: currency ?? null,
      evidenceDueBy: dateOf(d.evidence_required_by) ?? null,
      ownership: "unknown",
    };
    // A chargeback takes the money back when it is received.
    if (type === "dispute_received") return [e, { ...e, type: "dispute.funds_withdrawn" }];
    return [e];
  }

  if (type === "card_updated") {
    const replacement = (d.replacement_card ?? {}) as Record<string, unknown>;
    const reason = str(d.reason_type);
    // A closed card has no replacement to write; the next charge declines on its own.
    if (reason === "card_closed" || !Array.isArray(d.sources))
      return [{ ...base, type: "unknown" }];
    const scheme = str(replacement.scheme)?.toLowerCase();
    const card = {
      ...(scheme ? { brand: BRAND[scheme] ?? scheme } : {}),
      ...(str(replacement.last4) ? { last4: str(replacement.last4)! } : {}),
      ...(typeof replacement.expiry_month === "number"
        ? { expMonth: replacement.expiry_month }
        : {}),
      ...(typeof replacement.expiry_year === "number" ? { expYear: replacement.expiry_year } : {}),
    };
    const out = (d.sources as unknown[])
      .map((s) => str((s as { id?: unknown })?.id))
      .filter((id): id is string => !!id)
      .map((id): NormalizedProviderEvent => ({
        ...base,
        type: "payment_method.updated",
        providerPaymentMethodId: id,
        card,
      }));
    return out.length ? out : [{ ...base, type: "unknown" }];
  }

  const payId = str(d.id);
  const kind = str(d.metadata?.[KIND_KEY]);
  const own = ownershipOf(d.metadata);
  // A Hosted Payments Page hold: the reference names the intent, the payment id is new.
  const reference = str(d.reference);
  if (type === "payment_approved" && payId && reference?.startsWith("th-"))
    return [
      {
        ...base,
        ...own,
        ...(own.ownership === "ours"
          ? {}
          : { ownership: "ours" as const, ownershipRef: reference.slice(3) }),
        type: "intent.authorized",
        providerIntentId: CHECKOUTCOM_HOSTED_PREFIX + reference,
        providerChargeId: payId,
        gatewayIntentId: payId,
      },
    ];
  const declined = (): Partial<NormalizedProviderEvent> => {
    const sig = checkoutcomDeclineSignal(d as unknown as CkoPayment);
    const f = normalizeCheckoutcomDecline(sig);
    return {
      failureCode: f.code,
      failureRetriable: f.retriable,
      ...(sig.code ? { providerFailureCode: sig.code } : {}),
      ...((f.message ?? sig.message) ? { failureMessage: (f.message ?? sig.message)! } : {}),
    };
  };
  switch (type) {
    case "payment_captured": {
      // `amount` is what this capture took.
      const captured = amountOf(d.amount);
      return [
        {
          ...base,
          ...own,
          type: "charge.succeeded",
          providerChargeId: payId,
          ...(captured != null ? { capturedAmountMinor: captured } : {}),
        },
      ];
    }
    case "payment_approved":
      // An authorization. A hold we asked for is an intent; a charge captures right after.
      if (kind === "intent")
        return [{ ...base, ...own, type: "intent.authorized", providerIntentId: payId }];
      if (kind === "charge")
        return [{ ...base, ...own, type: "charge.succeeded", providerChargeId: payId }];
      return [{ ...base, ...own, type: "charge.pending", providerChargeId: payId }];
    case "payment_declined":
      // A hold or a card check is refused in the call that made it; the event adds nothing.
      if (kind === "intent" || kind === "setup") return [{ ...base, ...own, type: "unknown" }];
      return [{ ...base, ...own, type: "charge.failed", providerChargeId: payId, ...declined() }];
    case "payment_capture_declined":
      // We book an approved authorization paid, so a refused capture withdraws that payment.
      return [
        {
          ...base,
          ...own,
          type: "charge.failed",
          providerChargeId: payId,
          ...declined(),
          lateReversal: true,
        },
      ];
    case "payment_pending":
    case "payment_capture_pending":
      return [{ ...base, ...own, type: "charge.pending", providerChargeId: payId }];
    case "payment_refunded": {
      const total = amountOf(d.balances?.total_refunded) ?? amountOf(d.amount);
      return [
        {
          ...base,
          ...own,
          type: "charge.refunded",
          providerChargeId: payId,
          providerRefundId: str(d.action_id),
          ...(total != null ? { amountRefundedMinor: total } : {}),
        },
      ];
    }
    case "payment_refund_pending":
      return [
        {
          ...base,
          ...own,
          type: "refund.pending",
          providerChargeId: payId,
          providerRefundId: str(d.action_id),
        },
      ];
    case "payment_refund_declined":
      return [
        {
          ...base,
          ...own,
          type: "refund.failed",
          providerChargeId: payId,
          providerRefundId: str(d.action_id),
          ...(str(d.response_code) ? { providerFailureCode: str(d.response_code)! } : {}),
          ...(str(d.response_summary) ? { failureMessage: str(d.response_summary)! } : {}),
        },
      ];
    case "payment_voided":
      // A charge is booked paid at authorization; a void (from the dashboard) takes it back.
      if (kind === "charge")
        return [
          {
            ...base,
            ...own,
            type: "charge.failed",
            providerChargeId: payId,
            failureMessage: "The authorization was voided at Checkout.com before capture.",
            lateReversal: true,
          },
        ];
      return [{ ...base, ...own, type: "intent.voided", providerIntentId: payId }];
    case "payment_returned":
      return [{ ...base, ...own, type: "charge.reversed", providerChargeId: payId }];
    default:
      return [{ ...base, type: "unknown" }];
  }
}

// ── The adapter ──────────────────────────────────────────────────────────────

export interface CheckoutcomOptions {
  secretKey: string;
  publicKey: string;
  processingChannelId: string;
  /** See `checkoutcomApiPrefix`. */
  apiPrefix: string;
  /** Billing country for a customer with no billing address (Checkout.com requires one). */
  defaultCountry: string;
  livemode: boolean;
  /** The entity that owns the processing channel (`ent_…`); the Workflows API requires it. */
  entityId: string;
  /** The workflow's signature key (`webhook_secret`). */
  webhookSecret?: string;
}

interface CkoResponse<T> {
  status: number;
  body: T | null;
  errorCodes: string[];
  errorType?: string;
}

export class CheckoutcomProvider implements PaymentProvider {
  readonly key = "checkoutcom" as const;
  readonly capabilities: ProviderCapabilities;
  readonly baseUrl: string;
  private readonly country: string;

  constructor(private readonly opts: CheckoutcomOptions) {
    assertCheckoutcomKeyMode(opts.secretKey, opts.publicKey, opts.livemode);
    if (!opts.processingChannelId.startsWith("pc_"))
      throw new Error("Checkout.com processing_channel_id must start with pc_");
    // Checked here because the Workflows API accepts any ent_ value: a wrong one registers
    // a webhook that never fires.
    if (!/^ent_[a-z0-9]{26}$/.test(opts.entityId.trim()))
      throw new Error(
        "Checkout.com entity_id must look like ent_ followed by 26 letters and digits",
      );
    const country = opts.defaultCountry.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country))
      throw new Error("Checkout.com default_country must be a two-letter country code, e.g. US");
    this.country = country;
    this.baseUrl = checkoutcomBaseUrl(opts.apiPrefix, opts.livemode);
    this.capabilities = {
      refunds: true,
      partialRefunds: true,
      // The processing channel decides; Checkout.com takes most ISO currencies.
      currencies: [],
      methods: ["card"],
      intents: true,
      intentPurposes: ["payment", "setup"],
      // An authorization is voided without moving money.
      intentVoid: true,
      // No per-debit ceiling on a stored card.
      mandates: false,
    };
  }

  // ── transport ──

  /**
   * One request. A money request (`money`) that may have been processed — no answer, 408,
   * 409, 429 or 5xx — is sent again under the same `Cko-Idempotency-Key`, which replays the
   * first answer; when the attempts run out it is indeterminate. `refusable`: the operation
   * documents 403 as "not allowed", so the caller reads it; elsewhere 403 is the key's scope.
   */
  private async call<T>(
    operation: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    opts: { body?: unknown; idempotencyKey?: string; money?: boolean; refusable?: boolean } = {},
  ): Promise<CkoResponse<T>> {
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= MONEY_ATTEMPTS;
      let res;
      try {
        res = await providerFetch({
          gatewayKey: this.key,
          operation,
          method,
          url: `${this.baseUrl}${path}`,
          headers: {
            Authorization: `Bearer ${this.opts.secretKey}`,
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(opts.idempotencyKey
              ? { "Cko-Idempotency-Key": boundedProviderKey(opts.idempotencyKey, IDEMPOTENCY_MAX) }
              : {}),
          },
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        });
      } catch (e) {
        if (!opts.money) throw e;
        if (!last) {
          await this.wait(RETRY_WAIT_MS * attempt);
          continue;
        }
        throw new ProviderIndeterminateError(
          `We could not reach Checkout.com for ${operation}, so we do not know whether it completed. Retry later.`,
        );
      }
      if (res.status === 401 || (res.status === 403 && !opts.refusable))
        throw new Error(
          `Checkout.com refused the secret key (HTTP ${res.status}) on ${operation}. Check the key, its scopes and the API prefix`,
        );
      if (opts.money) {
        // POST /payments documents 429 as "too many requests or duplicate request detected".
        const cls = classifyGatewayHttp({
          status: res.status,
          retryAfter: res.headers?.get("retry-after"),
        });
        if (cls.kind === "retry_same_key") {
          const ms = cls.retryAfterMs ?? RETRY_WAIT_MS * attempt;
          if (!last && ms <= RETRY_MAX_WAIT_MS) {
            await this.wait(ms);
            continue;
          }
          throw new ProviderIndeterminateError(
            `Checkout.com answered ${operation} with HTTP ${res.status}. We could not confirm the outcome.`,
          );
        }
      } else if (res.status >= 500 || res.status === 429)
        throw new ProviderIndeterminateError(
          `Checkout.com answered ${operation} with HTTP ${res.status}. We could not confirm the outcome.`,
        );
      return this.parsed<T>(operation, res, !!opts.money);
    }
  }

  private wait(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  private parsed<T>(
    operation: string,
    res: { status: number; text: string },
    money: boolean,
  ): CkoResponse<T> {
    let body: unknown = null;
    if (res.text) {
      try {
        body = JSON.parse(res.text);
      } catch {
        if (money)
          throw new ProviderIndeterminateError(
            `We could not read Checkout.com's answer to ${operation} (HTTP ${res.status}).`,
          );
      }
    }
    const err = (body ?? {}) as { error_codes?: unknown; error_type?: unknown };
    return {
      status: res.status,
      body: body as T | null,
      errorCodes: Array.isArray(err.error_codes) ? err.error_codes.map(String) : [],
      ...(typeof err.error_type === "string" ? { errorType: err.error_type } : {}),
    };
  }

  private apiError(operation: string, r: CkoResponse<unknown>): Error {
    return new Error(
      `Checkout.com ${operation} failed (HTTP ${r.status}${r.errorCodes.length ? `: ${r.errorCodes.join(", ")}` : ""})`,
    );
  }

  /** A refusal the decline rules recognise, or undefined (then the caller throws). */
  private classifiedApiFailure(r: CkoResponse<unknown>): ChargeResult["failure"] | undefined {
    const code = r.errorCodes[0];
    if (!code) return undefined;
    const f = normalizeCheckoutcomDecline({ code, category: r.errorType ?? null });
    if (!f.ruleId) return undefined;
    return {
      code: f.code,
      providerCode: code,
      message: f.message ?? `Checkout.com refused the payment (${code}).`,
      retriable: f.retriable,
      ruleId: f.ruleId,
    };
  }

  private ref(ownershipRef: string | undefined, idempotencyKey: string): string {
    return boundedProviderKey(ownershipRef ?? idempotencyKey, REFERENCE_MAX);
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    // No ping endpoint: a reference search answers 404 when nothing matches.
    const r = await this.call(
      "health_check",
      "GET",
      "/payments?reference=tmbilling_health&limit=1",
    );
    return {
      ok: r.status === 200 || r.status === 404,
      detail: `environment=${this.opts.livemode ? "production" : "sandbox"}`,
    };
  }

  // ── customers ──

  private customerBody(input: EnsureCustomerInput) {
    const country = input.address?.country?.toUpperCase();
    return {
      ...(input.email ? { email: input.email } : {}),
      ...(input.name ? { name: input.name } : {}),
      metadata: {
        [CHECKOUTCOM_OWNERSHIP_KEY]: input.customerRef,
        ...(country && /^[A-Z]{2}$/.test(country) ? { [COUNTRY_KEY]: country } : {}),
      },
    };
  }

  async ensureCustomer(input: EnsureCustomerInput): Promise<ProviderCustomerRef> {
    if (!input.email)
      throw new ProviderRefusalError(
        "Checkout.com needs the customer's email address to save a card. Add an email address to the customer, then try again.",
      );
    const r = await this.call<{ id?: string }>("create_customer", "POST", "/customers", {
      body: this.customerBody(input),
    });
    if (r.body?.id) return { providerKey: this.key, providerCustomerId: r.body.id };
    // One customer per email on an account: reuse the one that exists.
    if (r.errorCodes.includes("customer_email_already_exists")) {
      const found = await this.call<{ id?: string }>(
        "read_customer",
        "GET",
        `/customers/${encodeURIComponent(input.email)}`,
      );
      if (found.body?.id) {
        log.info("reused the Checkout.com customer that has this email", {
          event: "checkoutcom_customer_reused",
          customer: input.customerRef,
        });
        return { providerKey: this.key, providerCustomerId: found.body.id };
      }
    }
    throw this.apiError("create_customer", r);
  }

  async updateCustomer(ref: ProviderCustomerRef, input: EnsureCustomerInput): Promise<void> {
    const r = await this.call(
      "update_customer",
      "PATCH",
      `/customers/${encodeURIComponent(ref.providerCustomerId)}`,
      { body: this.customerBody(input) },
    );
    if (r.status >= 300) throw this.apiError("update_customer", r);
  }

  private async billingCountry(customerId: string | undefined): Promise<string> {
    if (!customerId) return this.country;
    const r = await this.call<{ metadata?: Record<string, unknown> }>(
      "read_customer",
      "GET",
      `/customers/${encodeURIComponent(customerId)}`,
    ).catch(() => null);
    const c = r?.body?.metadata?.[COUNTRY_KEY];
    return typeof c === "string" && /^[A-Z]{2}$/.test(c) ? c : this.country;
  }

  // ── payments ──

  private async readPayment(id: string): Promise<CkoPayment | null> {
    const r = await this.call<CkoPayment>(
      "read_payment",
      "GET",
      `/payments/${encodeURIComponent(id)}`,
    );
    if (r.status === 404) return null;
    if (r.status >= 300 || !r.body?.id) throw this.apiError("read_payment", r);
    // The details read carries no response code; the newest authorization action does.
    if (!r.body.response_code && r.body.approved === false) {
      const acts = await this.call<
        Array<{ type?: string; response_code?: string; response_summary?: string }>
      >("read_payment_actions", "GET", `/payments/${encodeURIComponent(id)}/actions`).catch(
        () => null,
      );
      const auth = Array.isArray(acts?.body)
        ? acts.body.find((a) => a.type === "Authorization" || a.type === "Card Verification")
        : undefined;
      if (auth?.response_code)
        return {
          ...r.body,
          response_code: auth.response_code,
          ...(auth.response_summary ? { response_summary: auth.response_summary } : {}),
        };
    }
    return r.body;
  }

  /** POST /payments. A refusal the rules know comes back as a failed result. */
  private async requestPayment(
    operation: string,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<ChargeResult> {
    const r = await this.call<CkoPayment>(operation, "POST", "/payments", {
      body,
      idempotencyKey,
      money: true,
    });
    if ((r.status === 201 || r.status === 202) && r.body?.id)
      return chargeResultFromPayment(r.body);
    const failure = this.classifiedApiFailure(r);
    if (failure) return { status: "failed", providerChargeId: "", failure, raw: r.body };
    throw markStrandedObject(this.apiError(operation, r), (r.body as CkoPayment | null)?.id);
  }

  private paymentRef(p: CkoPayment, customerFallback?: string): ProviderPaymentMethodRef {
    if (!p.source?.id) throw new Error(`Checkout.com payment ${p.id} stored no card`);
    const customer = p.customer?.id ?? customerFallback;
    return {
      providerKey: this.key,
      providerPaymentMethodId: p.source.id,
      ...(customer ? { providerCustomerId: customer } : {}),
      display: describeCheckoutcomSource(p.source),
      // The initial customer-initiated payment; merchant-initiated debits quote it.
      mandate: { reference: p.id },
    };
  }

  /** A 0-amount `Recurring` verification that stores a tokenized card on the customer. */
  private async verifyAndStore(
    source: Record<string, unknown>,
    customerId: string,
    currency: string,
    ref: string,
    idempotencyKey: string,
  ): Promise<ChargeResult> {
    return this.requestPayment(
      "verify_card",
      {
        source,
        amount: 0,
        currency,
        payment_type: "Recurring",
        merchant_initiated: false,
        processing_channel_id: this.opts.processingChannelId,
        customer: { id: customerId },
        reference: ref,
        metadata: { [CHECKOUTCOM_OWNERSHIP_KEY]: ref, [KIND_KEY]: "setup" },
      },
      idempotencyKey,
    );
  }

  /**
   * `token` is what the buyer side produced: a Flow payment id (`pay_…`, the 0-amount
   * verification), a card token (`tok_…`, verified and stored here), or an instrument
   * already on this customer (`src_…`).
   */
  async vaultPaymentMethod(input: VaultPaymentMethodInput): Promise<ProviderPaymentMethodRef> {
    const token = input.token.trim();
    const customerId = input.customer.providerCustomerId;
    if (token.startsWith("pay_")) {
      const p = await this.readPayment(token);
      if (!p) throw new ProviderRefusalError("Checkout.com does not know this payment.");
      if (p.customer?.id && p.customer.id !== customerId)
        throw new ProviderRefusalError("This card was saved for a different customer.");
      const res = chargeResultFromPayment(p);
      if (res.status !== "succeeded")
        throw new ProviderRefusalError(
          `We could not save this card. ${res.failure?.message ?? "The card check is not complete."}`,
        );
      return this.paymentRef(p, customerId);
    }
    if (token.startsWith("src_")) {
      const ref = await this.fetchVaultedPaymentMethod({
        providerCustomerId: customerId,
        providerPaymentMethodId: token,
      });
      if (!ref) throw new ProviderRefusalError("This card is not saved for this customer.");
      return ref;
    }
    if (!token.startsWith("tok_"))
      throw new ProviderRefusalError("Checkout.com expects a card token (tok_…) or a payment id.");
    const currency = (input.metadata?.currency ?? "USD").toUpperCase();
    const ref = this.ref(input.customerRef, `vault_${token}`);
    const res = await this.verifyAndStore(
      { type: "token", token },
      customerId,
      currency,
      ref,
      `vault_${token}`,
    );
    if (res.status === "requires_action")
      throw new ProviderRefusalError(
        "This card needs 3D Secure before we can save it. Add it with the card form.",
      );
    if (res.status !== "succeeded")
      throw new ProviderRefusalError(
        `We could not save this card. ${res.failure?.message ?? "The card check is not complete."}`,
      );
    return this.paymentRef(res.raw as CkoPayment, customerId);
  }

  private async readInstrument(id: string) {
    const r = await this.call<CkoSource & { customer?: { id?: string } }>(
      "read_instrument",
      "GET",
      `/instruments/${encodeURIComponent(id)}`,
    );
    if (r.status === 404) return null;
    if (r.status >= 300 || !r.body?.id) throw this.apiError("read_instrument", r);
    return r.body;
  }

  async fetchPaymentMethodDisplay(input: {
    providerPaymentMethodId: string;
  }): Promise<ProviderPaymentMethodRef["display"] | null> {
    const s = await this.readInstrument(input.providerPaymentMethodId);
    return s ? describeCheckoutcomSource(s) : null;
  }

  async fetchVaultedPaymentMethod(input: {
    providerCustomerId: string;
    providerPaymentMethodId: string;
  }): Promise<ProviderPaymentMethodRef | null> {
    const s = await this.readInstrument(input.providerPaymentMethodId);
    if (!s || s.customer?.id !== input.providerCustomerId) return null;
    return {
      providerKey: this.key,
      providerPaymentMethodId: s.id!,
      providerCustomerId: input.providerCustomerId,
      display: describeCheckoutcomSource(s),
    };
  }

  async deletePaymentMethod(input: {
    customer: ProviderCustomerRef;
    paymentMethod: ProviderPaymentMethodRef;
  }): Promise<void> {
    const r = await this.call(
      "delete_instrument",
      "DELETE",
      `/instruments/${encodeURIComponent(input.paymentMethod.providerPaymentMethodId)}`,
    );
    if (r.status === 204 || r.status === 200) return;
    if (r.status === 404) {
      log.info("gateway delete skipped — the card was already gone at Checkout.com", {
        event: "checkoutcom_delete_already_gone",
      });
      return;
    }
    throw this.apiError("delete_instrument", r);
  }

  // ── money ──

  async charge(input: ChargeInput): Promise<ChargeResult> {
    const currency = input.currency.toUpperCase();
    const ref = this.ref(input.ownershipRef, input.idempotencyKey);
    const sc = checkoutcomStoredCredential(input.initiator);
    const previous = input.mandateReference?.startsWith("pay_") ? input.mandateReference : null;
    let amount: number;
    try {
      amount = toCheckoutcomAmount(input.amountMinor, currency);
    } catch (e) {
      // Never sent: a definite refusal, not a gateway error to retry.
      if (!(e instanceof ProviderRefusalError)) throw e;
      return {
        status: "failed",
        providerChargeId: "",
        failure: {
          code: "gateway_request_rejected",
          providerCode: "amount_invalid",
          message: e.message,
          retriable: false,
        },
      };
    }
    return this.requestPayment(
      "charge",
      {
        source: { type: "id", id: input.paymentMethod.providerPaymentMethodId },
        amount,
        currency,
        ...sc,
        // Without it Checkout.com looks the series up itself, which its docs say not to rely on.
        ...(sc.merchant_initiated && previous ? { previous_payment_id: previous } : {}),
        capture: true,
        processing_channel_id: this.opts.processingChannelId,
        customer: { id: input.customer.providerCustomerId },
        reference: ref,
        ...(input.description ? { description: input.description.slice(0, 100) } : {}),
        metadata: {
          [CHECKOUTCOM_OWNERSHIP_KEY]: ref,
          [KIND_KEY]: "charge",
          [KEY_KEY]: boundedProviderKey(input.idempotencyKey, IDEMPOTENCY_MAX),
        },
      },
      input.idempotencyKey,
    );
  }

  /**
   * A charge whose answer was lost, found by its `reference` and then by the idempotency key
   * in its metadata (a reference is shared by every attempt on one invoice). Read only.
   * Search by reference answers 404 when nothing matches.
   */
  async locateCharge(input: {
    ownershipRef: string;
    idempotencyKey: string;
  }): Promise<ChargeResult | null> {
    const ref = this.ref(input.ownershipRef, input.idempotencyKey);
    const key = boundedProviderKey(input.idempotencyKey, IDEMPOTENCY_MAX);
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
      const r = await this.call<{ total_count?: number; data?: CkoPayment[] }>(
        "locate_charge",
        "GET",
        `/payments?reference=${encodeURIComponent(ref)}&limit=${LIST_PAGE}&skip=${page * LIST_PAGE}`,
      );
      if (r.status === 404) return null;
      if (r.status !== 200 || !Array.isArray(r.body?.data)) throw this.apiError("locate_charge", r);
      const hit = r.body.data.find(
        (p) => p.metadata?.[KEY_KEY] === key && p.metadata?.[KIND_KEY] === "charge",
      );
      if (hit) return chargeResultFromPayment(hit);
      const total = r.body.total_count ?? 0;
      if (r.body.data.length < LIST_PAGE || (page + 1) * LIST_PAGE >= total) return null;
    }
    throw new Error(
      `Checkout.com has more than ${LIST_PAGE * LIST_MAX_PAGES} payments with reference ${ref}`,
    );
  }

  async fetchChargeStatus(input: { providerChargeId: string }): Promise<ChargeResult> {
    const p = await this.readPayment(input.providerChargeId);
    if (!p) return { status: "pending", providerChargeId: input.providerChargeId };
    return chargeResultFromPayment(p);
  }

  /**
   * A refund is an action on its payment, so it is read there. No action yet = still pending;
   * `approved: false` = declined.
   */
  async fetchRefundStatus(input: {
    providerRefundId: string;
    providerChargeId?: string;
  }): Promise<RefundResult> {
    const id = input.providerRefundId;
    if (!input.providerChargeId)
      throw new Error(
        "A Checkout.com refund is read under its payment, so the charge id is needed",
      );
    const r = await this.call<
      Array<{ id?: string; type?: string; approved?: boolean; response_code?: string }>
    >("read_refund", "GET", `/payments/${encodeURIComponent(input.providerChargeId)}/actions`);
    if (r.status >= 300 || !Array.isArray(r.body)) throw this.apiError("read_refund", r);
    const act = r.body.find((a) => a.id === id);
    if (!act) return { status: "pending", providerRefundId: id, raw: r.body };
    if (act.approved === false) return { status: "failed", providerRefundId: id, raw: act };
    return {
      status: act.approved === true ? "succeeded" : "pending",
      providerRefundId: id,
      raw: act,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    let currency = input.currency?.toUpperCase();
    if (input.amountMinor != null && !currency)
      currency = (await this.readPayment(input.providerChargeId))?.currency?.toUpperCase();
    if (input.amountMinor != null && !currency)
      throw new Error("A partial Checkout.com refund needs the charge currency");
    const ref = this.ref(input.ownershipRef, input.idempotencyKey);
    const r = await this.call<{ action_id?: string }>(
      "refund",
      "POST",
      `/payments/${encodeURIComponent(input.providerChargeId)}/refunds`,
      {
        body: {
          ...(input.amountMinor != null
            ? { amount: toCheckoutcomAmount(input.amountMinor, currency!) }
            : {}),
          reference: ref,
          metadata: { [CHECKOUTCOM_OWNERSHIP_KEY]: ref },
        },
        idempotencyKey: input.idempotencyKey,
        money: true,
        refusable: true,
      },
    );
    // Accepted, not done: `payment_refunded` or `payment_refund_declined` follows.
    if (r.status === 202 && r.body?.action_id)
      return { status: "pending", providerRefundId: r.body.action_id, raw: r.body };
    // 403 "Refund not allowed", 422 invalid data, 200 "Payment is already refunded": none
    // created a refund.
    if (r.status === 403 || r.status === 422 || r.status === 200)
      throw new ProviderRefusalError(
        r.status === 200
          ? "Checkout.com refused the refund: the payment is already fully refunded."
          : `Checkout.com refused the refund (${r.errorCodes.join(", ") || `HTTP ${r.status}`}).`,
      );
    throw this.apiError("refund", r);
  }

  // ── intents ──

  private async paymentSession(p: {
    purpose: IntentPurpose;
    customerId?: string;
    currency: string;
    amountMinor: bigint;
    ref: string;
    returnUrl: string;
    cancelUrl: string;
    email?: string;
    name?: string;
  }): Promise<{ intentId: string; authorization: BuyerAuthorization }> {
    const setup = p.purpose === "setup";
    const r = await this.call<Record<string, unknown> & { id?: string }>(
      "create_payment_session",
      "POST",
      "/payment-sessions",
      {
        body: {
          amount: setup ? 0 : toCheckoutcomAmount(p.amountMinor, p.currency),
          currency: p.currency,
          // A setup is the initial customer-initiated payment of a stored-card series.
          payment_type: setup ? "Recurring" : "Regular",
          ...(setup ? {} : { capture: false }),
          billing: { address: { country: await this.billingCountry(p.customerId) } },
          ...(p.customerId
            ? { customer: { id: p.customerId } }
            : p.email
              ? { customer: { email: p.email, ...(p.name ? { name: p.name } : {}) } }
              : {}),
          processing_channel_id: this.opts.processingChannelId,
          reference: p.ref,
          metadata: { [CHECKOUTCOM_OWNERSHIP_KEY]: p.ref, [KIND_KEY]: setup ? "setup" : "intent" },
          // Google Pay on pay-now only: a card payment to us (authorise, capture, refund).
          // A setup stays card-only; we do not save a wallet for renewals.
          enabled_payment_methods: setup ? ["card"] : ["card", "googlepay"],
          "3ds": setup
            ? { enabled: true, challenge_indicator: "challenge_requested_mandate" }
            : { enabled: true },
          success_url: p.returnUrl,
          failure_url: p.cancelUrl,
        },
      },
    );
    if (r.status !== 201 || !r.body?.id) {
      if (r.status === 422)
        throw new ProviderRefusalError(
          `Checkout.com could not open the ${setup ? "card" : "payment"} form (${r.errorCodes.join(", ") || "HTTP 422"}).`,
        );
      throw this.apiError("create_payment_session", r);
    }
    const intentId = encodeCheckoutcomIntent({
      p: p.purpose,
      ...(p.customerId ? { c: p.customerId } : {}),
      s: r.body.id,
      cur: p.currency,
      ...(setup ? {} : { a: String(p.amountMinor) }),
      r: p.ref,
    });
    return {
      intentId,
      authorization: {
        mode: "sdk",
        sdk: {
          provider: this.key,
          params: {
            publicKey: this.opts.publicKey,
            environment: this.opts.livemode ? "production" : "sandbox",
            // Flow takes the session response unmodified.
            paymentSession: r.body,
            purpose: p.purpose,
            ...(setup
              ? {}
              : {
                  amount: minorToDecimalString(p.amountMinor, p.currency),
                  currency: p.currency,
                }),
          },
        },
      },
    };
  }

  async initiateVaultSetup(input: InitiateVaultSetupInput): Promise<VaultSetupRef> {
    const s = await this.paymentSession({
      purpose: "setup",
      customerId: input.customer.providerCustomerId,
      currency: (input.currency ?? "USD").toUpperCase(),
      amountMinor: 0n,
      ref: this.ref(input.ownershipRef, input.customer.providerCustomerId),
      returnUrl: input.returnUrl,
      cancelUrl: input.cancelUrl,
    });
    return { setupTokenId: s.intentId, ...s.authorization };
  }

  /**
   * Pay-now Apple Pay on the Hosted Payments Page, held for consume to capture. The page is
   * Checkout.com's, so no domain of ours is verified. `POST /hosted-payments` takes no
   * idempotency key; a lost answer leaves an unused page that expires after 24 hours.
   * https://www.checkout.com/docs/payments/accept-payments/accept-a-payment-on-a-hosted-page
   */
  private async hostedApplePay(input: CreateIntentInput, ref: string): Promise<IntentRef> {
    if (!input.returnUrl) throw new Error("A Checkout.com hosted payment needs a return URL");
    const currency = input.currency.toUpperCase();
    const reference = checkoutcomHostedReference(ref);
    const r = await this.call<{ id?: string; _links?: { redirect?: { href?: string } } }>(
      "create_hosted_payment",
      "POST",
      "/hosted-payments",
      {
        body: {
          amount: toCheckoutcomAmount(input.amountMinor ?? 0n, currency),
          currency,
          payment_type: "Regular",
          capture: false,
          reference,
          ...(input.description ? { description: input.description.slice(0, 100) } : {}),
          billing: {
            address: { country: await this.billingCountry(input.customer.providerCustomerId) },
          },
          ...(input.contact?.email
            ? {
                customer: {
                  email: input.contact.email.slice(0, 255),
                  ...(input.contact.name ? { name: input.contact.name.slice(0, 255) } : {}),
                },
              }
            : {}),
          processing_channel_id: this.opts.processingChannelId,
          metadata: { [CHECKOUTCOM_OWNERSHIP_KEY]: ref, [KIND_KEY]: "intent" },
          allow_payment_methods: ["applepay"],
          "3ds": { enabled: true },
          success_url: input.returnUrl,
          failure_url: input.cancelUrl ?? input.returnUrl,
          cancel_url: input.cancelUrl ?? input.returnUrl,
        },
      },
    );
    const url = r.body?._links?.redirect?.href;
    if (r.status !== 201 || !r.body?.id || !url) {
      if (r.status === 422)
        throw new ProviderRefusalError(
          `Checkout.com could not open the Apple Pay page (${r.errorCodes.join(", ") || "HTTP 422"}). Check that the Hosted Payments Page and Apple Pay are enabled.`,
        );
      throw this.apiError("create_hosted_payment", r);
    }
    return {
      intentId: CHECKOUTCOM_HOSTED_PREFIX + reference,
      status: "requires_action",
      authorization: { mode: "redirect", approvalUrl: url },
      raw: r.body,
    };
  }

  async createIntent(input: CreateIntentInput): Promise<IntentRef> {
    const currency = input.currency.toUpperCase();
    const ref = this.ref(input.ownershipRef, input.idempotencyKey);
    if (input.hostedWallet === "apple_pay" && input.purpose === "payment" && !input.paymentMethod)
      return this.hostedApplePay(input, ref);
    if (input.purpose === "payment" && input.paymentMethod) {
      // A hold on a stored card; consumeIntent captures it.
      const sc = checkoutcomStoredCredential({
        by: input.session === "on_session" ? "customer" : "merchant",
        recurring: false,
      });
      const charge = await this.requestPayment(
        "authorize",
        {
          source: { type: "id", id: input.paymentMethod.providerPaymentMethodId },
          amount: toCheckoutcomAmount(input.amountMinor ?? 0n, currency),
          currency,
          ...sc,
          capture: false,
          processing_channel_id: this.opts.processingChannelId,
          customer: { id: input.customer.providerCustomerId },
          reference: ref,
          metadata: { [CHECKOUTCOM_OWNERSHIP_KEY]: ref, [KIND_KEY]: "intent" },
          ...(input.session === "on_session" && input.returnUrl
            ? {
                "3ds": { enabled: true },
                success_url: input.returnUrl,
                failure_url: input.cancelUrl ?? input.returnUrl,
              }
            : {}),
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
      if (charge.status === "requires_action")
        return {
          intentId: charge.providerChargeId,
          status: "requires_action",
          authorization: {
            mode: "redirect",
            approvalUrl: String(charge.nextAction?.data.url ?? ""),
          },
          raw: charge.raw,
        };
      return {
        intentId: charge.providerChargeId,
        status: charge.status === "pending" ? "inited" : "authorized",
        raw: charge.raw,
      };
    }
    if (!input.returnUrl)
      throw new Error("A Checkout.com card form needs a return URL for 3D Secure");
    const s = await this.paymentSession({
      purpose: input.purpose,
      customerId: input.customer.providerCustomerId,
      currency,
      amountMinor: input.amountMinor ?? 0n,
      ref,
      returnUrl: input.returnUrl,
      cancelUrl: input.cancelUrl ?? input.returnUrl,
      ...(input.contact?.email ? { email: input.contact.email } : {}),
      ...(input.contact?.name ? { name: input.contact.name } : {}),
    });
    return { intentId: s.intentId, status: "requires_action", authorization: s.authorization };
  }

  /**
   * Flow's answer: the payment id it completed. Accepted only for a payment made on this
   * session (or carrying our ref), for this customer and, for a payment, this amount.
   */
  async submitClientResult(input: {
    intentId: string;
    purpose: IntentPurpose;
    clientResult: Record<string, string>;
    idempotencyKey: string;
  }): Promise<FetchedIntent> {
    if (input.intentId.startsWith(CHECKOUTCOM_HOSTED_PREFIX))
      return this.hostedResult(input.intentId, input.clientResult);
    const s = decodeCheckoutcomIntent(input.intentId);
    const invalid = (message: string): FetchedIntent => ({
      intentId: input.intentId,
      status: "failed",
      failure: { code: "invalid_client_result", message },
    });
    if (!s) return invalid("This payment did not start with the Checkout.com card form.");
    const paymentId = (
      input.clientResult.payment_id ?? input.clientResult["cko-payment-id"]
    )?.trim();
    if (!paymentId?.startsWith("pay_"))
      return invalid("The payment details from the browser are not valid.");
    const p = await this.readPayment(paymentId);
    if (!p) return invalid("The payment details from the browser are not valid.");
    const meta = p.metadata ?? {};
    const sameSession =
      meta.cko_payment_session_id === s.s || (!!s.r && meta[CHECKOUTCOM_OWNERSHIP_KEY] === s.r);
    const sameCustomer = !s.c || !p.customer?.id || p.customer.id === s.c;
    const sameMoney =
      s.p === "setup" ||
      (p.currency?.toUpperCase() === s.cur &&
        typeof p.amount === "number" &&
        fromCheckoutcomAmount(p.amount, s.cur) === BigInt(s.a ?? "0"));
    if (!sameSession || !sameCustomer || !sameMoney) {
      log.warn("a browser posted a Checkout.com payment that does not belong to this intent", {
        event: "checkoutcom_client_result_mismatch",
        sameSession,
        sameCustomer,
        sameMoney,
      });
      return invalid("The payment details from the browser do not match this payment.");
    }
    const res = chargeResultFromPayment(p);
    if (res.status === "failed")
      return {
        intentId: input.intentId,
        status: "failed",
        providerChargeId: p.id,
        failure: { code: res.failure!.code, message: res.failure!.message },
        raw: p,
      };
    if (res.status !== "succeeded")
      return { intentId: input.intentId, status: "requires_action", raw: p };
    return {
      intentId: input.intentId,
      status: "authorized",
      gatewayIntentId: p.id,
      ...(s.p === "payment"
        ? {
            providerChargeId: p.id,
            amountMinor: BigInt(s.a ?? "0"),
            currency: s.cur,
            ...(res.methodUsed ? { methodUsed: res.methodUsed } : {}),
          }
        : {}),
      raw: p,
    };
  }

  /**
   * The hosted page's return names the payment (`cko-payment-id`). Accepted only for a payment
   * carrying this intent's reference. https://www.checkout.com/docs/payments/accept-payments/accept-a-payment-on-a-hosted-page/manage-your-hosted-payments-page
   */
  private async hostedResult(
    intentId: string,
    clientResult: Record<string, string>,
  ): Promise<FetchedIntent> {
    const paymentId = (clientResult["cko-payment-id"] ?? clientResult.payment_id)?.trim();
    const reference = intentId.slice(CHECKOUTCOM_HOSTED_PREFIX.length);
    const p = paymentId?.startsWith("pay_") ? await this.readPayment(paymentId) : null;
    if (!p || p.reference !== reference)
      return {
        intentId,
        status: "failed",
        failure: {
          code: "invalid_client_result",
          message: "The payment details from the browser do not match this payment.",
        },
      };
    const res = chargeResultFromPayment(p);
    if (res.status === "failed")
      return {
        intentId,
        status: "failed",
        providerChargeId: p.id,
        failure: { code: res.failure!.code, message: res.failure!.message },
        raw: p,
      };
    if (res.status !== "succeeded") return { intentId, status: "requires_action", raw: p };
    const amountMinor =
      typeof p.amount === "number" && p.currency
        ? fromCheckoutcomAmount(p.amount, p.currency)
        : undefined;
    return {
      intentId,
      status: "authorized",
      gatewayIntentId: p.id,
      providerChargeId: p.id,
      ...(amountMinor != null ? { amountMinor, currency: p.currency!.toUpperCase() } : {}),
      ...(res.methodUsed ? { methodUsed: res.methodUsed } : {}),
      raw: p,
    };
  }

  async consumeIntent(input: ConsumeIntentInput): Promise<ConsumeIntentResult> {
    if (input.intentId.startsWith(CHECKOUTCOM_HOSTED_PREFIX))
      throw new Error(
        "This Checkout.com hosted payment names no payment yet. Its webhook or return gives the payment id",
      );
    if (decodeCheckoutcomIntent(input.intentId))
      throw new Error(
        "This Checkout.com intent has no card from the browser yet. Submit the client result first",
      );
    if (input.purpose === "setup") {
      const p = await this.readPayment(input.intentId);
      if (!p) throw new Error(`Checkout.com knows no payment ${input.intentId}`);
      const res = chargeResultFromPayment(p);
      if (res.status === "failed") return { purpose: "setup", failure: res.failure! };
      return { purpose: "setup", paymentMethod: this.paymentRef(p) };
    }
    let currency = input.currency?.toUpperCase();
    if (input.amountMinor != null && !currency)
      currency = (await this.readPayment(input.intentId))?.currency?.toUpperCase();
    const r = await this.call<{ action_id?: string }>(
      "capture",
      "POST",
      `/payments/${encodeURIComponent(input.intentId)}/captures`,
      {
        body:
          input.amountMinor != null && currency
            ? { amount: toCheckoutcomAmount(input.amountMinor, currency) }
            : {},
        idempotencyKey: input.idempotencyKey,
        money: true,
        refusable: true,
      },
    );
    // Accepted (202) or "already captured" (200): `payment_captured` confirms,
    // `payment_capture_declined` reverses it.
    if (r.status === 202 || r.status === 200)
      return {
        purpose: "payment",
        charge: { status: "succeeded", providerChargeId: input.intentId, raw: r.body },
      };
    // 403 "Capture not allowed", 422 invalid data: nothing was captured.
    if (r.status === 403 || r.status === 422)
      throw new ProviderRefusalError(
        `Checkout.com refused the capture (${r.errorCodes.join(", ") || `HTTP ${r.status}`}).`,
      );
    throw this.apiError("capture", r);
  }

  async voidIntent(input: VoidIntentInput): Promise<VoidIntentResult> {
    // An unanswered challenge holds nothing.
    if (decodeCheckoutcomIntent(input.intentId)) return { voided: true, held: false };
    // A hosted page has no cancel call and expires after 24 hours. A payment made on it
    // carries the page's reference, so a hold is found and voided by its id.
    if (input.intentId.startsWith(CHECKOUTCOM_HOSTED_PREFIX)) {
      const reference = input.intentId.slice(CHECKOUTCOM_HOSTED_PREFIX.length);
      const r = await this.call<{ data?: CkoPayment[] }>(
        "find_hosted_payment",
        "GET",
        `/payments?reference=${encodeURIComponent(reference)}&limit=10`,
      );
      if (r.status !== 404 && (r.status !== 200 || !Array.isArray(r.body?.data)))
        throw this.apiError("find_hosted_payment", r);
      const hit = r.body?.data?.find((p) => p.reference === reference && p.id);
      if (!hit) return { voided: true, held: false };
      return this.voidIntent({ ...input, intentId: hit.id });
    }
    const pre = await this.readPayment(input.intentId).catch(() => null);
    // A card verification moves and holds no money.
    if (pre?.status === "Card Verified") return { voided: true, held: false };
    if (pre?.status === "Voided") return { voided: true, providerTransactionId: pre.id };
    const held =
      pre?.status === "Authorized"
        ? true
        : pre?.status && REFUSED.has(pre.status)
          ? false
          : undefined;
    const r = await this.call<{ action_id?: string }>(
      "void",
      "POST",
      `/payments/${encodeURIComponent(input.intentId)}/voids`,
      { body: {}, idempotencyKey: input.idempotencyKey, money: true, refusable: true },
    );
    // "Already voided": as the `Voided` read above, this void released nothing new.
    if (r.status === 200) return { voided: true };
    // 403 "Void not allowed", 422 invalid data: the hold stands.
    if (r.status === 403 || r.status === 422)
      throw new ProviderRefusalError(
        `Checkout.com refused the void (${r.errorCodes.join(", ") || `HTTP ${r.status}`}).`,
      );
    if (r.status !== 202) throw this.apiError("void", r);
    return {
      voided: true,
      ...(r.body?.action_id ? { providerTransactionId: r.body.action_id } : {}),
      ...(held !== undefined ? { held } : {}),
    };
  }

  // ── webhooks ──

  /**
   * Creates a workflow that posts every event we consume to `url`, signed with a key we
   * choose, scoped to this processing channel. Workflows for the same URL are replaced.
   */
  async provisionWebhookEndpoint(input: {
    url: string;
    secret?: string;
  }): Promise<ProvisionedWebhook> {
    const key = input.secret ?? randomBytes(32).toString("base64url");
    await this.deleteWorkflowsFor(input.url);
    const r = await this.call<{ id?: string }>("create_workflow", "POST", "/workflows", {
      body: {
        name: checkoutcomWorkflowName(input.url),
        active: true,
        conditions: [
          { type: "event", events: CHECKOUTCOM_WEBHOOK_EVENTS },
          // Required by the Workflows API (measured: 422 condition_entity_entity_required).
          { type: "entity", entities: [this.opts.entityId.trim()] },
          { type: "processing_channel", processing_channels: [this.opts.processingChannelId] },
        ],
        actions: [{ type: "webhook", url: input.url, signature: { method: "HMACSHA256", key } }],
      },
    });
    if (r.status !== 201 || !r.body?.id) throw this.apiError("create_workflow", r);
    return { webhookSecret: key, providerEndpointId: r.body.id };
  }

  async removeWebhookEndpoint(input: { url: string }): Promise<WebhookRemoval> {
    return { removed: (await this.deleteWorkflowsFor(input.url)) > 0 };
  }

  /** Deletes our workflows that post to exactly `url`; returns how many. */
  private async deleteWorkflowsFor(url: string): Promise<number> {
    const name = checkoutcomWorkflowName(url);
    const list = await this.call<{ data?: Array<{ id?: string; name?: string }> }>(
      "list_workflows",
      "GET",
      "/workflows",
    );
    if (list.status !== 200) throw this.apiError("list_workflows", list);
    let deleted = 0;
    for (const wf of list.body?.data ?? []) {
      if (!wf.id || wf.name !== name) continue;
      const full = await this.call<{ actions?: Array<{ url?: string }> }>(
        "read_workflow",
        "GET",
        `/workflows/${encodeURIComponent(wf.id)}`,
      );
      if (!full.body?.actions?.some((a) => a.url === url)) continue;
      await this.deleteWebhookEndpoint(wf.id);
      deleted++;
    }
    return deleted;
  }

  /** Remove a workflow we created. For the live check and for a later unregister. */
  async deleteWebhookEndpoint(workflowId: string): Promise<void> {
    const r = await this.call(
      "delete_workflow",
      "DELETE",
      `/workflows/${encodeURIComponent(workflowId)}`,
    );
    if (r.status !== 204 && r.status !== 404) throw this.apiError("delete_workflow", r);
  }

  webhookEventId(input: NormalizeWebhookInput): string {
    return webhookEventId([bodyId(input.payload)], input.payload);
  }

  async normalizeWebhook(input: NormalizeWebhookInput): Promise<NormalizedProviderEvent[]> {
    if (!this.opts.webhookSecret)
      throw new Error("Checkout.com webhook secret is not set for this gateway account");
    verifyCheckoutcomSignature(
      this.opts.webhookSecret,
      headerValue(input.headers, "cko-signature"),
      input.payload,
    );
    let ev: CheckoutcomEvent;
    try {
      ev = JSON.parse(input.payload.toString()) as CheckoutcomEvent;
    } catch {
      throw new Error("Checkout.com webhook body is not JSON");
    }
    return normalizeCheckoutcomEvent(ev, this.webhookEventId(input), ev);
  }
}
