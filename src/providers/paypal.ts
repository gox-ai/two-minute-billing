import type {
  PaymentProvider,
  ProviderCapabilities,
  EnsureCustomerInput,
  ProviderCustomerRef,
  VaultPaymentMethodInput,
  ProviderPaymentMethodRef,
  InitiateVaultSetupInput,
  VaultSetupRef,
  ChargeInput,
  ChargeResult,
  RefundInput,
  RefundResult,
  GatewayBalance,
  GatewayBalanceResult,
  NormalizeWebhookInput,
  ProvisionedWebhook,
  WebhookRemoval,
  NormalizedProviderEvent,
  CreateIntentInput,
  IntentRef,
  ConsumeIntentInput,
  ConsumeIntentResult,
  VoidIntentInput,
  VoidIntentResult,
} from "./types";
import { ProviderIndeterminateError, ProviderRefusalError } from "./types";
import { createVerify } from "node:crypto";
import { providerFetch, boundedProviderKey } from "./http";
import { minorToDecimalString, decimalToMinor, minorScale } from "@/platform/currency";
import { classifyGatewayHttp } from "./gateway-http-class";
import { normalizePaypalDecline, PAYPAL_CODE_TABLE } from "./decline-codes";
import { createLogger } from "@/platform/logger";
import { bodyId, webhookEventId } from "./webhook-event-id";

const log = createLogger("paypal");

interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  apiBase: string;
  webhookId?: string;
  /** Waits before each same-id replay of a money call that got no final answer. Tests pass []. */
  replayDelaysMs?: readonly number[];
}

/**
 * A money call whose answer was lost (`classifyGatewayHttp`: transport error, 5xx, 408, 409,
 * 429). PayPal says to retry these with the same PayPal-Request-Id, which returns the first
 * request's result (ids are kept 6 hours). 409 is PREVIOUS_REQUEST_IN_PROGRESS.
 */
const PAYPAL_REPLAY_DELAYS_MS = [1_000, 3_000] as const;

/** The longest `Retry-After` a replay waits for; a billing tick must not hang on it. */
const PAYPAL_MAX_RETRY_AFTER_MS = 10_000;

/** Transaction Search takes at most 31 days per call. */
const PAYPAL_SEARCH_WINDOW_MS = 31 * 86_400_000;
const PAYPAL_SEARCH_PAGE_SIZE = 500;
/**
 * How far past the lookup's start PayPal's report must reach before "no such charge" is an
 * answer (or up to the search itself, if sooner): the start is the attempt less 10 min of
 * skew, plus 20 min for a late capture. The report lags by hours (`last_refreshed_datetime`;
 * measured 1.9 h on 2026-10-27).
 */
const PAYPAL_REPORT_COVER_MS = 30 * 60_000;
const PAYPAL_SEARCH_MAX_PAGES = 20;

/**
 * Parse a PayPal body only once the status is known. A non-JSON 2xx is a lost answer (we
 * cannot read what PayPal did), so it throws. A non-JSON 4xx or 5xx is still that status:
 * the status alone decides definite versus lost.
 */
function parsePaypalBody(status: number, text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    if (classifyGatewayHttp({ status }).kind === "answer")
      throw new Error(`PayPal answered HTTP ${status} with a body that is not JSON`, { cause: e });
    return {};
  }
}

/** PayPal's specific issue (`details[0].issue`), else the envelope `name`. */
function paypalIssue(json: unknown): string | undefined {
  const j = json as { details?: Array<{ issue?: unknown }>; name?: unknown } | undefined;
  const issue = j?.details?.[0]?.issue ?? j?.name;
  return typeof issue === "string" && issue ? issue : undefined;
}

/** A PayPal decimal string to signed minor units; a balance can be negative. Absent = 0. */
function paypalSignedMinor(value: string | undefined, currency: string): bigint {
  if (!value) return 0n;
  const minor = decimalToMinor(value.replace(/^-/, ""), currency);
  return value.startsWith("-") ? -minor : minor;
}

/**
 * Operator-facing reason for a refused refund: PayPal's issue, its description, and the
 * debug_id PayPal support asks for. Never sent to the payer.
 */
export function paypalRefundRefusal(status: number, json: unknown): string {
  const j = json as {
    details?: Array<{ description?: unknown }>;
    message?: unknown;
    debug_id?: unknown;
  };
  const issue = paypalIssue(json);
  const text = j?.details?.[0]?.description ?? j?.message;
  const parts = [
    `PayPal refused the refund (${issue ?? `HTTP ${status}`}).`,
    typeof text === "string" && text ? text.trim() : "",
    typeof j?.debug_id === "string" && j.debug_id ? `PayPal debug ID: ${j.debug_id}.` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Currencies PayPal takes in whole units although ISO 4217 gives them two decimals
 * (https://developer.paypal.com/reference/currency-codes/: "does not support decimals").
 */
const PAYPAL_WHOLE_UNIT_CURRENCIES = new Set(["HUF", "TWD"]);

/**
 * amountMinor (bigint) → PayPal decimal string for the given currency, e.g.
 * 2500n USD → "25.00", 2500n JPY → "2500", 2500n BHD → "2.500", 2500n HUF → "25".
 * A HUF/TWD amount with a fraction throws before anything is sent: PayPal refuses it, and
 * rounding would charge a different amount from the invoice.
 */
function toDecimal(amountMinor: bigint, currency: string): string {
  const c = currency.toUpperCase();
  if (PAYPAL_WHOLE_UNIT_CURRENCIES.has(c)) {
    const scale = minorScale(c);
    if (amountMinor % scale !== 0n)
      throw new Error(
        `PayPal takes ${c} in whole units only, and ${minorToDecimalString(amountMinor, c)} ${c} ` +
          "has a fraction. Nothing was sent to PayPal.",
      );
    return (amountMinor / scale).toString();
  }
  return minorToDecimalString(amountMinor, currency);
}

/**
 * PayPal rejects a `PayPal-Request-Id` longer than 65 chars with a bare
 * `422 UNPROCESSABLE_ENTITY` — no field, no issue, nothing to debug from. Its docs
 * claim 108; measured live 2026-07-27 (65 passes, 66 fails). See `boundedProviderKey`.
 */
const PAYPAL_REQUEST_ID_MAX = 65;

/**
 * CRC-32 (IEEE) of a UTF-8 string — the last field of PayPal's signed message.
 * Hand-rolled because it is ~15 lines and pulling a dependency into the webhook trust
 * path for it would be a poor trade.
 */
const CRC32_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(s: string): number {
  const bytes = Buffer.from(s, "utf8");
  let c = 0 ^ -1;
  for (const b of bytes) c = (c >>> 8) ^ CRC32_TABLE[(c ^ b) & 0xff]!;
  return (c ^ -1) >>> 0;
}

/**
 * What paid (`ChargeResult.methodUsed`): the one key of an order's `payment_source`.
 * A capture resource carries none, so it stays unknown there.
 */
const PAYPAL_METHOD_USED: Readonly<Record<string, string>> = {
  paypal: "paypal",
  venmo: "venmo",
  card: "card",
  apple_pay: "apple_pay",
  google_pay: "google_pay",
};

export function paypalMethodUsed(raw: unknown): { methodUsed?: string } {
  const src = (raw as { payment_source?: Record<string, unknown> } | null)?.payment_source;
  const key = src && typeof src === "object" ? Object.keys(src).find((k) => src[k]) : undefined;
  const m = key ? PAYPAL_METHOD_USED[key] : undefined;
  return m ? { methodUsed: m } : {};
}

/** The `payment_source` PayPal echoes back on a vault token. */
/**
 * Verified against PayPal's own OpenAPI spec for `/v3/vault/payment-tokens`
 * (`card_response_entity`), 2026-09-12 — not the rendered docs, which do not serve their
 * field tables to a fetcher.
 */
type PayPalVaultSource = {
  card?: {
    brand?: string;
    last_digits?: string;
    expiry?: string;
    name?: string;
    /** `CREDIT` | `DEBIT` | `PREPAID` | `STORE` | `UNKNOWN`. PayPal SHOUTS its enums. */
    type?: string;
    /**
     * ⚠️ `bin_country_code` is the BANK's country — the issuer. Not to be confused with
     * `billing_address.country_code`, which is where the cardholder says they live.
     */
    bin_details?: {
      bin?: string;
      issuing_bank?: string;
      bin_country_code?: string;
      products?: string[];
    } | null;
  };
  paypal?: { email_address?: string; payer_id?: string };
} & Record<string, unknown>;

/**
 * What did we actually vault? PayPal returns the concrete instrument on the
 * payment-token response (`card` with brand/last_digits/expiry, or `paypal` for a
 * wallet). `charge` dispatches on this type, so getting it wrong doesn't just
 * mislabel the method in the dashboard — it makes the method uncharageable.
 */
function describeVaultSource(
  src: PayPalVaultSource | undefined,
): ProviderPaymentMethodRef["display"] {
  const card = src?.card;
  if (!card) return { type: "paypal" };
  // `expiry` is "YYYY-MM".
  const [year, month] = (card.expiry ?? "").split("-");
  /**
   * PayPal answers three of the four instrument facts the other adapters supply, and the
   * gaps are stated rather than filled:
   *
   *  · NO FINGERPRINT. The v3 payment-token schema has no such field at all, so
   *    `instrumentFingerprint` stays null here — PayPal instruments simply cannot be matched
   *    to the same physical card the way Stripe's can.
   *  · NO 3DS-SUPPORT FLAG. `authentication_result.three_d_secure` is the RESULT of an
   *    authentication that happened, which is a different question from whether the card
   *    can do 3DS at all. Mapping it would answer the wrong one.
   *  · `bin_details.products` is NOT mapped to `instrumentSubType`. It is an ARRAY of BIN
   *    categories (`CONSUMER`, `CORPORATE`, `PREPAID_GIFT`), where that column holds
   *    RazorPay's scalar consumer/business. Flattening one into the other would merge two
   *    taxonomies that only look alike.
   *
   * `type` is lower-cased — a CASE normalisation only, so `credit`/`debit`/`prepaid` line
   * up with Stripe's and RazorPay's spelling of the same values. PayPal's extra `store`
   * survives as `store` rather than being folded into anything.
   */
  const bin = card.bin_details;
  return {
    type: "card",
    brand: card.brand?.toLowerCase(),
    last4: card.last_digits,
    expMonth: month ? Number(month) : undefined,
    expYear: year ? Number(year) : undefined,
    ...(bin?.bin_country_code ? { issuerCountry: bin.bin_country_code.toUpperCase() } : {}),
    ...(bin?.issuing_bank ? { issuerName: bin.issuing_bank } : {}),
    ...(card.type ? { instrumentFunding: card.type.toLowerCase() } : {}),
  };
}

/**
 * The buyer-approval link on a PayPal resource.
 *
 * Setup tokens name it `approve`, orders name it `payer-action`, and both shapes
 * turn up on both resources depending on the API version — so one picker serves
 * vault setup AND payment intents rather than each guessing at its own rel name.
 */
function approvalLink(
  links: Array<{ rel?: string; href?: string }> | undefined,
): string | undefined {
  return links?.find((l) => l.rel === "approve" || l.rel === "payer-action")?.href;
}

/**
 * A v1 BILLING AGREEMENT id, as `B-XXXXXXXXXXXXXXXXX`.
 *
 * Migrated wallets carry one of these, not a v3 vault token: a source that was set up
 * through PayPal Express Checkout is an agreement, and every store that predates the
 * Vault API holds them. The two are charged through DIFFERENT keys of the same v2 order
 * (see `vaultChargeSource`), and the id prefix is the only thing distinguishing them on
 * an imported row — the vocabulary the source hands over says `paypal` for both.
 */
const BILLING_AGREEMENT_ID = /^B-[A-Z0-9]{12,}$/i;

/**
 * Build the order `payment_source` for a vaulted method, keyed by its real type.
 *
 * Three keys, not two. A v3 vault token goes under `card` or `paypal` by the type it was
 * vaulted as; a v1 billing agreement goes under `token` with an explicit
 * `type: "BILLING_AGREEMENT"`, which is a SIBLING of `paypal`, not a shape of it.
 * Sending an agreement id as `paypal.vault_id` is the same class of error as sending a
 * card vault_id under `paypal` — the id is real, the key is wrong.
 *
 * ⚠️ Charging an agreement needs PayPal REFERENCE TRANSACTIONS enabled on the account:
 * it is limited-release and granted per merchant, so this code path can be correct and
 * still be refused. If these start failing, that permission is the first thing to check,
 * not the request shape.
 */
function vaultChargeSource(
  pm: ProviderPaymentMethodRef,
): Record<string, { vault_id: string } | { id: string; type: string }> {
  if (BILLING_AGREEMENT_ID.test(pm.providerPaymentMethodId)) {
    return { token: { id: pm.providerPaymentMethodId, type: "BILLING_AGREEMENT" } };
  }
  const vault = { vault_id: pm.providerPaymentMethodId };
  return pm.display.type === "card" ? { card: vault } : { paypal: vault };
}

/**
 * ── #31 · the ownership tag, and why the NAMESPACE lives in the value ────────
 *
 * `CreateIntentInput.ownershipRef` maps to PayPal's `custom_id` on the purchase unit.
 * But `custom_id` is a single, UNNAMESPACED string, and that makes it different in kind
 * from the other two adapters: Stripe stamps `metadata.tmbilling_ref` and RazorPay
 * `notes.tmbilling_ref`, where the KEY is the namespace and any value under it is ours
 * by construction. PayPal gives us one field that everybody shares — other products on
 * the same account stamp it too, so "a `custom_id` is present" cannot mean "this object
 * is ours".
 *
 * So the prefix carries the namespace, and only a value bearing it is read back as ours.
 * A `custom_id` present WITHOUT it is positive evidence of a sibling product on a shared
 * PayPal account (`ownership: 'foreign'`); no `custom_id` at all is ignorance
 * (`'unknown'`), never "not ours" — see `NormalizedProviderEvent.ownership`.
 *
 * The ref is stripped back off on the way in, so the engine compares against the same
 * bare ref it handed us.
 */
export const PAYPAL_OWNERSHIP_PREFIX = "tmbilling_ref:";

/**
 * PayPal documents `custom_id` as max 127 characters. Our refs are far shorter, but the
 * engine's own keys are not always (`collectInvoice` builds ~69-char idempotency keys,
 * and this field carries one on the `charge` path), so the value is bounded the same
 * deterministic way every other gateway reference is.
 *
 * ⚠️ Bounding DEGRADES the tag rather than breaking the payment, and that is the point:
 * an over-long ref is compressed to a hash, so the object still reads as ours while
 * exact-ref matching is lost. The alternative — sending 130 characters and taking a 422
 * on an order create — would let a tag refuse a payment, which no diagnostic may do.
 */
const PAYPAL_CUSTOM_ID_MAX = 127;

/**
 * The ref stamped on `healthCheck`'s probe order.
 *
 * `healthCheck` creates a REAL PayPal order (it is how we prove the Orders API request
 * shape against live credentials), so it is a create path like any other and has to be
 * tagged: an untagged $5 probe order sitting on a shared PayPal account is exactly what
 * the classifier would otherwise count as another product's traffic. It deliberately
 * names no engine object — nothing matches it, because nothing should.
 */
export const PAYPAL_HEALTHCHECK_OWNERSHIP_REF = "healthcheck";

/** Our `ownershipRef` → the `custom_id` value we send. */
export function paypalOwnershipTag(ref: string): string {
  return `${PAYPAL_OWNERSHIP_PREFIX}${boundedProviderKey(
    ref,
    PAYPAL_CUSTOM_ID_MAX - PAYPAL_OWNERSHIP_PREFIX.length,
  )}`;
}

/**
 * Read ownership off a PayPal resource — the three-way answer #31 needs.
 *
 * Looks in the two places our tag can appear, and NOWHERE else:
 *  - `custom_id` on the resource itself (a capture, an authorization, a refund), and
 *  - `purchase_units[0].custom_id` when the resource IS the order (CHECKOUT.ORDER.*),
 *    which is where we stamped it.
 *
 * ⚠️ Whether PayPal PROPAGATES a purchase unit's `custom_id` onto the capture is
 * UNVERIFIED here: their rendered `captures-get` example echoes `invoice_id` and shows
 * no `custom_id`, and four attempts to find the field's description failed. An example
 * is not a schema, so this reads the field if it is there and answers `unknown` if it is
 * not — the ambiguity stays visible at runtime instead of being resolved by assumption.
 * Nothing depends on the answer: the machine tie-back is
 * `supplementary_data.related_ids.order_id`, which needs no tag at all.
 */
export function readPaypalOwnership(
  resource: unknown,
  opts?: { mayBeForeign?: boolean },
): {
  ownership: NonNullable<NormalizedProviderEvent["ownership"]>;
  ownershipRef?: string;
} {
  const r = (resource ?? {}) as {
    custom_id?: unknown;
    purchase_units?: Array<{ custom_id?: unknown }>;
  };
  const raw = r.custom_id ?? r.purchase_units?.[0]?.custom_id;
  if (typeof raw !== "string" || raw === "") return { ownership: "unknown" };
  if (!raw.startsWith(PAYPAL_OWNERSHIP_PREFIX)) {
    // A tag was read and it is not ours — countable evidence of a sibling product, but
    // ONLY on a kind of object we actually stamp (see `paypalMayBeForeign`). On a kind
    // we never tag, this says nothing about whose object it is, and answering `foreign`
    // there would file our own money under "another product's traffic" — a line nobody
    // reads — instead of under the unattributed-capture alert that exists to be read.
    return { ownership: opts?.mayBeForeign ? "foreign" : "unknown" };
  }
  const ref = raw.slice(PAYPAL_OWNERSHIP_PREFIX.length);
  return { ownership: "ours", ...(ref ? { ownershipRef: ref } : {}) };
}

/**
 * May an event's resource answer `foreign`? — i.e. is it a kind of object THIS adapter
 * stamps, so that a tag which is not ours is real evidence rather than noise?
 *
 * We stamp `custom_id` on the ORDER's purchase unit and nowhere else, so the answer is
 * yes for the order and the objects descended from it (its authorization, its capture)
 * and no for everything else:
 *  - **refunds** (`PAYMENT.CAPTURE.REFUNDED`) — we send no `custom_id` on a refund, so
 *    a value there did not come from us and its absence proves nothing either;
 *  - **vault / setup tokens** (`VAULT.*`) — bound by `customer.merchant_customer_id`,
 *    a different field with a different meaning (see `assertSetupTokenBelongsTo`);
 *  - **disputes** (`CUSTOMER.DISPUTE.*`) — PayPal's own object, never ours to tag;
 *  - **v1 sales** (`PAYMENT.SALE.*`) — the legacy billing-agreement rail; this engine
 *    creates no v1 sales at all, so one arriving is another product's by definition and
 *    needs no tag to say so.
 *
 * `ours` and `unknown` are unaffected — a tag of OURS is ours wherever it turns up.
 */
export function paypalMayBeForeign(eventType: unknown): boolean {
  const t = String(eventType ?? "");
  if (t === "PAYMENT.CAPTURE.REFUNDED") return false;
  return (
    t.startsWith("CHECKOUT.ORDER.") ||
    t.startsWith("PAYMENT.AUTHORIZATION.") ||
    t.startsWith("PAYMENT.CAPTURE.")
  );
}

/**
 * When the GATEWAY created the object an event is about — PayPal's `create_time`.
 *
 * ⚠️ An ISO-8601 STRING, not the epoch integer Stripe (`created`) and RazorPay
 * (`created_at`) use, so this is the one of the three that cannot share an
 * implementation. Read off the RESOURCE, never the event: the event's own `create_time`
 * is when the notification fired, and reading that as the object's age would mark a
 * capture of an order created weeks before tagging existed as "created after tagging
 * shipped and carries no tag" — i.e. provably not ours, on no evidence at all.
 *
 * An unparseable or absent value yields `undefined` rather than an Invalid Date, whose
 * `getTime()` is NaN and whose every comparison is silently false.
 */
export function paypalObjectCreatedAt(resource: unknown): Date | undefined {
  const raw = (resource as { create_time?: unknown } | undefined)?.create_time;
  if (typeof raw !== "string" || raw === "") return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

/**
 * Authorization statuses that mean PayPal is HOLDING the buyer's funds.
 *
 * `CREATED` is the live hold. `PARTIALLY_CAPTURED` still holds the uncaptured
 * remainder, which is what a void releases. Everything else is deliberately absent:
 * `CAPTURED` moved the money (not a hold), `VOIDED` released it before we arrived,
 * `DENIED` never held it, and `PENDING` — a risk review — is a state PayPal has never
 * shown us, so it must read as ignorance rather than as a hold we invented.
 */
const PAYPAL_HELD_AUTHORIZATION_STATUSES = new Set(["CREATED", "PARTIALLY_CAPTURED"]);

/**
 * Order statuses that mean the order was never authorized, so nothing can be held.
 *
 * Authorizing is a SEPARATE call (`POST /v2/checkout/orders/{id}/authorize`), so an
 * order sitting in any of these has no authorization resource and therefore no hold —
 * this is PayPal's own state machine, not an inference from another gateway. Used only
 * together with "the order read succeeded and listed no authorizations", so a truncated
 * `payments` block alone cannot produce a false "nothing was held".
 */
const PAYPAL_PRE_AUTHORIZATION_ORDER_STATUSES = new Set([
  "CREATED",
  "SAVED",
  "APPROVED",
  "PAYER_ACTION_REQUIRED",
]);

/**
 * A PayPal dispute event → the engine transition, read from the RESOURCE.
 *
 * Outcome codes are from PayPal's `customer_disputes_v1` spec (read 2026-10-26).
 * ACCEPTED ("PayPal accepted the dispute") and DENIED ("PayPal denied the dispute") are
 * deprecated but still documented. RESOLVED_WITH_PAYOUT means PayPal's protection paid,
 * so the merchant keeps the money unless `money_movements` shows a net settlement debit
 * to the seller. NONE closes a case that a new dispute on the same transaction replaces.
 * An unknown code keeps the old conservative close.
 */
export function paypalDisputeTransition(
  eventType: unknown,
  resource: unknown,
): {
  type: "dispute.created" | "dispute.updated" | "dispute.won" | "dispute.lost" | "dispute.closed";
  openStatus?: "needs_response" | "under_review";
} {
  const r = (resource ?? {}) as {
    status?: string;
    dispute_outcome?: { outcome_code?: string };
    money_movements?: Array<{
      affected_party?: string;
      type?: string;
      reason?: string;
      amount?: { value?: string; currency_code?: string };
    }>;
  };
  if (eventType === "CUSTOMER.DISPUTE.CREATED") return { type: "dispute.created" };
  const resolved = eventType === "CUSTOMER.DISPUTE.RESOLVED" || r.status === "RESOLVED";
  if (!resolved) {
    const s = r.status;
    const openStatus =
      s === "UNDER_REVIEW" || s === "WAITING_FOR_BUYER_RESPONSE"
        ? ("under_review" as const)
        : s === "OPEN" || s === "WAITING_FOR_SELLER_RESPONSE"
          ? ("needs_response" as const)
          : undefined;
    return { type: "dispute.updated", ...(openStatus ? { openStatus } : {}) };
  }
  switch (r.dispute_outcome?.outcome_code) {
    case "RESOLVED_BUYER_FAVOUR":
    case "ACCEPTED":
      return { type: "dispute.lost" };
    case "RESOLVED_SELLER_FAVOUR":
    case "DENIED":
    case "CANCELED_BY_BUYER":
      return { type: "dispute.won" };
    case "RESOLVED_WITH_PAYOUT": {
      // Net DISPUTE_SETTLEMENT movement on the seller, in decimal units of one currency.
      let net = 0;
      for (const m of r.money_movements ?? []) {
        if (m.affected_party !== "SELLER" || m.reason !== "DISPUTE_SETTLEMENT") continue;
        const v = Number(m.amount?.value ?? 0);
        if (Number.isFinite(v)) net += m.type === "DEBIT" ? -v : m.type === "CREDIT" ? v : 0;
      }
      return { type: net < 0 ? "dispute.lost" : "dispute.won" };
    }
    default:
      return { type: "dispute.closed" };
  }
}

/** The `href` of a PayPal resource link by `rel`. */
function linkHref(r: { links?: Array<{ rel?: string; href?: string }> }, rel: string) {
  return r.links?.find((l) => l.rel === rel)?.href;
}

/**
 * The CAPTURE a refund-shaped resource belongs to. `PAYMENT.CAPTURE.REFUNDED` and
 * `.REVERSED` carry the refund (or reversal) as the resource; the capture is the `up`
 * link (no `supplementary_data` on these events, verified live 2026-07-27).
 */
function parentCaptureId(r: {
  supplementary_data?: { related_ids?: { capture_id?: string } };
  links?: Array<{ rel?: string; href?: string }>;
}): string | undefined {
  const up = linkHref(r, "up");
  return (
    r.supplementary_data?.related_ids?.capture_id ??
    (up && up.includes("/captures/") ? up.split("/").pop() : undefined)
  );
}

/**
 * The v1 SALE a `PAYMENT.SALE.*` refund or reversal belongs to. Imported payments keep the
 * sale id as `provider_charge_id`, so this is what correlates them.
 */
function parentSaleId(r: {
  sale_id?: string;
  links?: Array<{ rel?: string; href?: string }>;
}): string | undefined {
  const sale = linkHref(r, "sale");
  return r.sale_id ?? (sale ? sale.split("/").pop() : undefined);
}

/**
 * Amount on a refund-shaped resource, v2 (`value`/`currency_code`) or v1 (`total`/
 * `currency`). Cumulative first, like Stripe's `amount_refunded`. v1 samples sign the
 * amount negative, so the magnitude is taken. `undefined` when neither shape is present.
 */
function refundedAmountMinor(r: {
  seller_payable_breakdown?: { total_refunded_amount?: { value?: string; currency_code?: string } };
  total_refunded_amount?: { value?: string; currency?: string; currency_code?: string };
  amount?: { value?: string; total?: string; currency_code?: string; currency?: string };
}): bigint | undefined {
  for (const a of [
    r.seller_payable_breakdown?.total_refunded_amount,
    r.total_refunded_amount,
    r.amount,
  ]) {
    const raw = a as
      | { value?: string; total?: string; currency_code?: string; currency?: string }
      | undefined;
    const value = raw?.value ?? raw?.total;
    const currency = raw?.currency_code ?? raw?.currency;
    if (value == null || !currency) continue;
    const minor = decimalToMinor(String(value).replace(/^-/, ""), String(currency));
    return minor;
  }
  return undefined;
}

/**
 * PayPal adapter. Like every adapter it only moves money + vaults methods
 * (BLUEPRINT ADR-001) — our engine owns subscriptions/invoices.
 *
 * NOTE: PayPal off-session (merchant-initiated) charging requires a buyer-approved
 * vault token (a browser approval step), so `vaultPaymentMethod` takes the approved
 * setup-token id from the client. OAuth + order/refund/webhook calls are server-side.
 */
export class PayPalProvider implements PaymentProvider {
  readonly key = "paypal" as const;
  readonly capabilities: ProviderCapabilities = {
    refunds: true,
    partialRefunds: true,
    currencies: [],
    // Not `card`: every vault here is a PayPal wallet (`createSetupToken` sends
    // `payment_source.paypal`). Vaulting a card needs PayPal's hosted card fields and a
    // `payment_source.card` setup token, which we have not built. Advertising it showed
    // buyers a card option that saved a PayPal wallet.
    methods: ["paypal"],
    // Both intent purposes are the same PayPal handshake seen twice: a `setup`
    // intent is the /v3/vault/setup-tokens approval `initiateVaultSetup` already
    // ran, a `payment` intent is an AUTHORIZE order. PayPal has a true void
    // (release the hold without moving money), so intentVoid is honest here —
    // unlike RazorPay, where it must stay false.
    intents: true,
    intentPurposes: ["payment", "setup"],
    intentVoid: true,
    /**
     * PayPal has NO mandate model on the flow we use, and this says so explicitly
     * rather than leaving the engine to infer it from a null ceiling.
     *
     * A vault here is a `usage_type: MERCHANT` billing agreement (see
     * `createSetupToken`): the buyer authorizes merchant-initiated debits, full stop.
     * There is no per-debit amount agreed at registration, no field to send one in,
     * and nothing on `/v3/vault/payment-tokens` to read one back from. So
     * `InitiateVaultSetupInput.maxAmountMinor` / `CreateIntentInput.maxAmountMinor`
     * are accepted and DELIBERATELY dropped — the alternative would be to invent a
     * ceiling, store it on `payment_methods.mandate_max_amount_minor`, and have
     * `mandateRefusal` refuse a perfectly chargeable PayPal debit before the gateway
     * ever sees it. A limit we made up is worse than no limit: it fails renewals that
     * would have succeeded, and it tells the buyer their bank imposed a cap it never did.
     *
     * `false` here is what lets the engine distinguish "this gateway would have told
     * us and reported nothing" (Stripe/RazorPay, where NULL means unknown and is worth
     * investigating) from "this gateway has no mandates at all" (here, where NULL is
     * the correct and permanent answer). Both used to collapse to the same null column.
     *
     * ⚠️ This does not mean a PayPal debit is unlimited. The buyer's funding source,
     * PayPal's own risk engine and the account's limits all still apply — they are
     * simply not knowable to us in advance, which is precisely the difference from a
     * rail that agrees a number up front.
     */
    mandates: false,
  };

  private cfg: PayPalConfig;
  private token?: { value: string; expiresAt: number };

  constructor(cfg: PayPalConfig) {
    this.cfg = cfg;
  }

  /** OAuth2 client-credentials token, cached until ~60s before expiry. */
  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt > now + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await providerFetch({
      gatewayKey: this.key,
      operation: "oauth_token",
      method: "POST",
      url: `${this.cfg.apiBase}/v1/oauth2/token`,
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (res.status >= 300) throw new Error(`PayPal OAuth failed: ${res.status} ${res.text}`);
    const json = JSON.parse(res.text) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: now + json.expires_in * 1000 };
    return json.access_token;
  }

  private async api<T>(
    operation: string,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json: T; retryAfter: string | null }> {
    const token = await this.accessToken();
    const res = await providerFetch({
      gatewayKey: this.key,
      operation,
      method,
      url: `${this.cfg.apiBase}${path}`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(headers ?? {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      json: parsePaypalBody(res.status, res.text) as T,
      retryAfter: res.headers?.get("retry-after") ?? null,
    };
  }

  /**
   * A call that must not read a lost answer as a verdict. Replays the SAME request (same
   * PayPal-Request-Id) while `classifyGatewayHttp` says the answer was lost; if PayPal never
   * answers, throws `ProviderIndeterminateError`, which the engine books as pending, not
   * failed. That includes a 429: PayPal does not document that a 429 created nothing.
   */
  private async callUntilAnswered<T>(
    operation: string,
    method: string,
    path: string,
    body?: unknown,
    requestId?: string,
  ): Promise<{ status: number; json: T }> {
    // Outside the loop: an OAuth failure means the money call was never sent.
    await this.accessToken();
    const headers = requestId ? { "PayPal-Request-Id": requestId } : undefined;
    const delays = this.cfg.replayDelaysMs ?? PAYPAL_REPLAY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      let lost: string;
      let retryAfterMs: number | null = null;
      try {
        const res = await this.api<T>(operation, method, path, body, headers);
        const cls = classifyGatewayHttp({ status: res.status, retryAfter: res.retryAfter });
        if (cls.kind !== "retry_same_key") return res;
        retryAfterMs = cls.retryAfterMs;
        lost = `HTTP ${res.status}${paypalIssue(res.json) ? ` ${paypalIssue(res.json)}` : ""}`;
      } catch (e) {
        // No response, or a 2xx body that is not JSON. Either way we did not read a result.
        lost = `no readable answer (${e instanceof Error ? e.message : String(e)})`;
      }
      if (attempt >= delays.length) {
        throw new ProviderIndeterminateError(
          `PayPal gave no final answer to ${operation} after ${attempt + 1} tries` +
            `${requestId ? " with the same PayPal-Request-Id" : ""} (last: ${lost}). ` +
            "We do not know if the request took effect.",
        );
      }
      await sleep(
        Math.max(delays[attempt]!, Math.min(retryAfterMs ?? 0, PAYPAL_MAX_RETRY_AFTER_MS)),
      );
    }
  }

  /** Live connectivity check used by verification — proves the credentials work.
   *  Returns the contract-v2 `{ ok, detail }` plus provider-specific extras. */
  async healthCheck(): Promise<{
    ok: boolean;
    detail?: string;
    authenticated: boolean;
    orderId?: string;
    orderStatus?: string;
  }> {
    await this.accessToken(); // throws if credentials are bad
    // Create (don't capture) a sample order to prove the Orders API request shape.
    const { json } = await this.api<{ id: string; status: string }>(
      "health_check",
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: { currency_code: "USD", value: "5.00" },
            // Tagged like every other create path — see PAYPAL_HEALTHCHECK_OWNERSHIP_REF.
            custom_id: paypalOwnershipTag(PAYPAL_HEALTHCHECK_OWNERSHIP_REF),
          },
        ],
      },
    );
    return {
      ok: true,
      detail: `order ${json.id} ${json.status}`,
      authenticated: true,
      orderId: json.id,
      orderStatus: json.status,
    };
  }

  async ensureCustomer(input: EnsureCustomerInput): Promise<ProviderCustomerRef> {
    // PayPal charges against a vaulted token, not a stored customer object.
    return { providerKey: this.key, providerCustomerId: input.customerRef };
  }

  /**
   * ⚠️ **`updateCustomer` is deliberately NOT implemented here — do not add it.**
   *
   * The optional adapter method exists to push our current identity onto a customer
   * object the PROVIDER stores. PayPal stores none: `ensureCustomer` above returns our
   * own `cus_…` public id unchanged, and Vault v3 has no customer resource to fetch or
   * update. The nearest thing, `customer.merchant_customer_id`, is a write-once field
   * on the SETUP TOKEN — it is the ownership binding `assertSetupTokenBelongsTo`
   * verifies, and it already carries the same `cus_…`, so there is nothing about it a
   * later identity change could or should alter.
   *
   * Identity that PayPal does consume (buyer name/email on the approval experience) is
   * read fresh from the request at the moment each token or order is created, so it is
   * never stale to begin with — there is no gateway-side copy to drift.
   *
   * An empty method here would therefore be a lie in the shape of a sync, and
   * `ensureProviderCustomer`'s optional chaining already skips the call for free.
   * Absence is the accurate answer; this comment exists so it doesn't read as an
   * oversight and get "fixed".
   */

  /**
   * Create a setup token with a buyer-approval redirect — the FIRST half of a
   * PayPal vault, and (identically) of a `setup` payment intent.
   *
   * Shared verbatim by `initiateVaultSetup` and `createIntent({purpose:'setup'})`:
   * they are the same gateway call, and the only difference is whether the engine
   * records the pending approval as a bare VaultSetupRef or as a tracked intent
   * with attempts. Duplicating the request body would let the two flows drift.
   */
  private async createSetupToken(
    returnUrl: string,
    cancelUrl: string,
    ourCustomerId: string,
  ): Promise<{
    id: string;
    approvalUrl: string;
    raw: unknown;
  }> {
    // A PayPal wallet vault, off-session merchant-initiated usage. Buyer approves at
    // the returned link; the approved setup token is then exchanged for a permanent
    // vault token (vaultPaymentMethod / consumeIntent).
    const { status, json } = await this.api<{
      id: string;
      links?: Array<{ rel: string; href: string }>;
    }>("vault", "POST", "/v3/vault/setup-tokens", {
      // ── The ownership binding (see `assertSetupTokenBelongsTo`) ───────────────
      // `ensureCustomer` here returns our own `cus_…` public id as the provider
      // customer id (PayPal keeps no customer mirror), so this stamps the setup token
      // with the customer it was minted for — the same job Stripe's
      // `metadata.tmbilling_ref` does on its customer object. Without it a setup token
      // is a bearer credential: whoever holds the id can vault the instrument behind
      // it into THEIR account, and the id travels in a URL (`approval_token_id` on
      // the return leg), so it lands in browser history, referrers and proxy logs.
      customer: { merchant_customer_id: ourCustomerId },
      payment_source: {
        paypal: {
          usage_type: "MERCHANT",
          experience_context: {
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    });
    if (status >= 300)
      throw new Error(`PayPal setup-token failed: ${status} ${JSON.stringify(json)}`);
    const approvalUrl = approvalLink(json.links);
    if (!approvalUrl)
      throw new Error(
        `PayPal setup-token returned no approval link: ${JSON.stringify(json.links)}`,
      );
    return { id: json.id, approvalUrl, raw: json };
  }

  async initiateVaultSetup(input: InitiateVaultSetupInput): Promise<VaultSetupRef> {
    // `input.maxAmountMinor` is deliberately not sent — PayPal's MERCHANT billing
    // agreement has no per-debit ceiling to send it to. See `capabilities.mandates`.
    //
    // ⚠️ `input.ownershipRef` is deliberately NOT forwarded into the setup token, and
    // this adapter is the exception to #31's "pass the engine's ref" rule. The tag on a
    // setup token is `customer.merchant_customer_id`, which is not just an ownership
    // hint here: `assertSetupTokenBelongsTo` compares it against `providerCustomerId`
    // to close CWE-598 (a setup-token id travels in a URL, so holding one must not be
    // enough to vault someone else's wallet). Stamping a different field there would
    // couple that check to an unrelated value and break it the moment the two diverge.
    // Nothing is lost: for PayPal `providerCustomerId` IS our own `cus_…` public id
    // (PayPal keeps no customer mirror), which is exactly what the engine passes as
    // `ownershipRef` for a vault attempt — the token is already tagged with our id.
    const setup = await this.createSetupToken(
      input.returnUrl,
      input.cancelUrl,
      input.customer.providerCustomerId,
    );
    return { setupTokenId: setup.id, mode: "redirect", approvalUrl: setup.approvalUrl };
  }

  /**
   * Refuse a setup token that was not minted for THIS customer.
   *
   * ── The hole this closes (CWE-598) ───────────────────────────────────────────
   * `POST /portal/v1/payment_methods { token }` hands whatever the buyer's browser
   * supplies straight to `vaultPaymentMethod`. Until now `exchangeSetupToken` posted
   * that id to `/v3/vault/payment-tokens` and stored the result under the CALLER's
   * customer — no binding, no check. Possessing another buyer's setup-token id was
   * enough to vault their PayPal wallet into your own account and charge it.
   *
   * A setup-token id is not public, but PayPal's travels in a URL: the storefront's
   * return leg reads `approval_token_id` off the query string, so it is written to
   * browser history, `Referer` headers and every proxy log on the path. That is the
   * same exposure class the W1 work closed for session tokens.
   *
   * The binding is `customer.merchant_customer_id`, stamped by `createSetupToken` with
   * our own `cus_…` id (which, for this adapter, IS `providerCustomerId` — PayPal keeps
   * no customer mirror, so `ensureCustomer` returns our ref unchanged).
   *
   * ── Fails CLOSED, on purpose ────────────────────────────────────────────────
   * A token whose readback carries NO `merchant_customer_id` is refused just as loudly
   * as one carrying the wrong id. A guard that waves through unbound tokens is not a
   * guard — an attacker's token would simply be one we did not mint. Nothing in this
   * product is live yet, so there are no pre-existing unbound tokens to strand.
   *
   * MEASURED against the PayPal sandbox 2026-08-30: `POST /v3/vault/setup-tokens`
   * with `customer: { merchant_customer_id: 'cus_probe_alice' }` returned 201 and
   * `GET /v3/vault/setup-tokens/{id}` echoed
   * `customer: { id: 'mtkAUgFeZV', merchant_customer_id: 'cus_probe_alice' }` — so the
   * binding survives the round trip, and PayPal's own `customer.id` (which it mints
   * and we do not use) is a different value, exactly as the guard assumes.
   *
   * ⚠️ Not yet exercised through a full buyer-APPROVED wallet vault — that needs the
   * human step `verify:paypal-wallet` pauses for. Approval does not touch the customer
   * hash, but confirm it on the next sandbox run of that suite.
   */
  private async assertSetupTokenBelongsTo(
    setupTokenId: string,
    expectedCustomerId: string,
  ): Promise<void> {
    const { status, json } = await this.api<{
      customer?: { merchant_customer_id?: string };
    }>("vault", "GET", `/v3/vault/setup-tokens/${encodeURIComponent(setupTokenId)}`);
    if (status >= 300) {
      // Includes the 404 an id belonging to another MERCHANT gives us. Deliberately
      // fatal: "we could not confirm ownership" and "ownership is fine" are not the
      // same answer, and only one of them may vault an instrument.
      throw new Error(
        `PayPal setup token ${setupTokenId} could not be read for ownership verification (${status})`,
      );
    }
    const bound = json?.customer?.merchant_customer_id;
    if (bound !== expectedCustomerId) {
      throw new Error(
        `PayPal setup token ${setupTokenId} was not created for this customer` +
          ". We refuse to vault an instrument that someone else approved.",
      );
    }
  }

  /**
   * Exchange an APPROVED setup token for a permanent vault token — the SECOND half
   * of a vault, shared by `vaultPaymentMethod` and `consumeIntent({purpose:'setup'})`.
   * Consuming a setup intent is exactly this call; the intent's id IS the setup token.
   *
   * `expectedCustomerId` is REQUIRED on the raw-token path and absent on the intent
   * path, and the asymmetry is the same one `stripe.ts` documents on its own vault:
   * an intent row was looked up by the engine, scoped to the org and the customer, so
   * the binding is ours by construction. A token posted to the portal is a client
   * ASSERTION and has to be proved.
   */
  private async exchangeSetupToken(
    setupTokenId: string,
    expectedCustomerId?: string,
  ): Promise<ProviderPaymentMethodRef> {
    if (expectedCustomerId) {
      await this.assertSetupTokenBelongsTo(setupTokenId, expectedCustomerId);
    }
    // A wallet setup token needs buyer approval first; a CARD setup token (created by
    // hosted fields in the browser) comes back APPROVED immediately — both exchange here.
    // One request id per setup token: a lost answer is replayed, never exchanged twice
    // (PayPal keeps vault request ids 3 hours).
    const { status, json } = await this.callUntilAnswered<{
      id: string;
      payment_source?: PayPalVaultSource;
    }>(
      "vault",
      "POST",
      "/v3/vault/payment-tokens",
      { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } },
      boundedProviderKey(`vault_${setupTokenId}`, PAYPAL_REQUEST_ID_MAX),
    );
    if (status >= 300) throw new Error(`PayPal vault failed: ${status} ${JSON.stringify(json)}`);
    return {
      providerKey: this.key,
      providerPaymentMethodId: json.id,
      // Record what was ACTUALLY vaulted. Hardcoding 'paypal' mislabelled every
      // vaulted card as a wallet, threw away the brand/last4 PayPal returns, and —
      // because `charge` dispatches on this type — made the card unchargeable.
      display: describeVaultSource(json.payment_source),
    };
  }

  async vaultPaymentMethod(input: VaultPaymentMethodInput): Promise<ProviderPaymentMethodRef> {
    // input.token = an approved SETUP token; exchange it for a permanent vault token.
    // `providerCustomerId` is our own `cus_…` here (ensureCustomer returns the ref
    // unchanged), which is exactly what `createSetupToken` stamped on the token — so
    // the ownership proof needs no new field on the input.
    return this.exchangeSetupToken(input.token, input.customer.providerCustomerId);
  }

  /**
   * Map a non-2xx PayPal money call onto a normalized failed ChargeResult.
   * Shared by `charge` and `consumeIntent` so an intent capture declines with the
   * same normalized code (and the same dunning verdict) as a direct charge.
   */
  private chargeFailure(status: number, json: any): ChargeResult {
    // PayPal's specific decline is in details[].issue (e.g. INSTRUMENT_DECLINED);
    // `name` is usually the generic envelope (UNPROCESSABLE_ENTITY). Prefer the
    // issue, then normalize so smart dunning can park/terminate.
    const rawCode = paypalIssue(json);
    const norm = normalizePaypalDecline(rawCode);
    return {
      status: "failed",
      providerChargeId: "",
      failure: {
        code: norm.code,
        // This text can reach the payer's email. PayPal's own description and debug_id
        // stay in `raw`; the issue code is enough for an operator.
        message:
          norm.message ??
          (rawCode
            ? `PayPal did not accept the payment. PayPal code: ${rawCode}.`
            : `PayPal did not accept the payment (HTTP ${status}).`),
        retriable: status >= 500 ? true : norm.retriable,
      },
      raw: json,
    };
  }

  /**
   * Map a PayPal CAPTURE onto a ChargeResult.
   *
   * ⚠️ Dispatch on the CAPTURE's status, not the ORDER's. A PayPal order goes
   * COMPLETED as soon as it has been captured — the capture itself can still be
   * **PENDING** (`status_details.reason: PENDING_REVIEW`, and eCheck/manual-action
   * holds), meaning PayPal has NOT released the money and may still DENY it.
   * Reading only the order status booked cash for money under review, marked the
   * payment `succeeded`, and left nothing for the webhook to settle. Caught by
   * `verify:paypal-wallet` 2026-07-31: card captures complete synchronously, so
   * only a wallet payment that tripped review ever exposed it.
   */
  private captureResult(
    capture: { id?: string; status?: string } | undefined,
    fallbackId: string,
    raw: unknown,
  ): ChargeResult {
    const captureId = capture?.id ?? fallbackId;
    const captureStatus = capture?.status;
    const used = paypalMethodUsed(raw);
    if (captureStatus === "DECLINED" || captureStatus === "FAILED") {
      const norm = normalizePaypalDecline(captureStatus);
      return {
        status: "failed",
        providerChargeId: captureId,
        failure: {
          code: norm.code,
          message: `capture ${captureStatus}`,
          retriable: norm.retriable,
        },
        ...used,
        raw,
      };
    }
    if (captureStatus && captureStatus !== "COMPLETED") {
      // PENDING (and anything else non-terminal): park it. The engine holds the
      // payment `pending` / transaction `in_progress`, and the terminal outcome
      // arrives as PAYMENT.CAPTURE.COMPLETED (→ charge.succeeded) or
      // PAYMENT.CAPTURE.DENIED (→ charge.failed) — both already mapped inbound.
      // Same shape as RazorPay UPI Autopay and Stripe ACH/SEPA.
      return { status: "pending", providerChargeId: captureId, ...used, raw };
    }
    return { status: "succeeded", providerChargeId: captureId, ...used, raw };
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    const value = toDecimal(input.amountMinor, input.currency);
    // Order create + capture in one call: a lost answer may hide a capture, so it is
    // replayed under the same id and never read as a decline.
    const { status, json } = await this.callUntilAnswered<any>(
      "charge",
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: { currency_code: input.currency.toUpperCase(), value },
            description: input.description,
            // #31: tagged on every create path. The idempotency key is the fallback,
            // since it maps 1:1 to one payment attempt of ours.
            custom_id: paypalOwnershipTag(input.ownershipRef ?? input.idempotencyKey),
          },
        ],
        // Charge the vaulted token, merchant-initiated. The payment_source key MUST
        // match what was vaulted: a card vault_id sent under `paypal` is rejected
        // 422 MISMATCHED_VAULT_ID_TO_PAYMENT_SOURCE (and vice-versa), so dispatch on
        // the method's own type rather than assuming every PayPal vault is a wallet.
        payment_source: vaultChargeSource(input.paymentMethod),
      },
      boundedProviderKey(input.idempotencyKey, PAYPAL_REQUEST_ID_MAX),
    );

    if (status >= 300) return this.chargeFailure(status, json);

    if (json.status === "COMPLETED") {
      // Capture id (used for refunds) lives under the purchase unit's payments.
      const capture = json.purchase_units?.[0]?.payments?.captures?.[0];
      return this.captureResult(capture, json.id, json);
    }
    // Anything else (e.g. requires buyer approval) is not a completed charge.
    return {
      status: json.status === "PAYER_ACTION_REQUIRED" ? "requires_action" : "pending",
      providerChargeId: json.id,
      ...paypalMethodUsed(json),
      raw: json,
    };
  }

  /**
   * Contract v2 (C7): begin an intent.
   *
   * The two purposes are the same buyer-approval handshake against different
   * PayPal resources:
   *  - `setup`   → /v3/vault/setup-tokens. The intent id IS the setup token, and
   *    consuming it mints the vault token. Identical call to `initiateVaultSetup`
   *    (they share `createSetupToken`) — the engine simply tracks this one.
   *  - `payment` → an order with **intent: 'AUTHORIZE'**. Note `charge()` uses
   *    'CAPTURE' and deliberately still does: a one-shot off-session charge has no
   *    gap between authorize and capture, while an intent is authorize-now /
   *    capture-on-consume so the engine can hold (or void) the buyer's funds while
   *    it decides.
   */
  async createIntent(input: CreateIntentInput): Promise<IntentRef> {
    if (input.purpose === "setup") {
      // A vault setup is a redirect flow by construction — without somewhere to send
      // the buyer back, PayPal has no way to hand us an approved token.
      if (!input.returnUrl || !input.cancelUrl) {
        throw new Error(
          "PayPal setup intent requires returnUrl and cancelUrl (the buyer approves in a redirect)",
        );
      }
      // Stamped with the same customer binding `initiateVaultSetup` uses, so an intent
      // consumed later can still be proved to belong to whoever it was minted for.
      const setup = await this.createSetupToken(
        input.returnUrl,
        input.cancelUrl,
        input.customer.providerCustomerId,
      );
      return {
        intentId: setup.id,
        // Always: a MERCHANT-usage setup token is worthless until the buyer approves
        // it in the browser, so there is no state in which this comes back ready.
        status: "requires_action",
        authorization: { mode: "redirect", approvalUrl: setup.approvalUrl },
        raw: setup.raw,
      };
    }

    const amountMinor = input.amountMinor ?? 0n;
    if (amountMinor <= 0n) {
      throw new Error(
        "PayPal payment intent requires a positive amountMinor (a zero-amount hold is a setup intent)",
      );
    }
    const currency = input.currency.toUpperCase();

    // Where PayPal returns the buyer after approving/cancelling. Lives INSIDE the
    // payment_source key, not at the order level.
    const experienceContext =
      input.returnUrl || input.cancelUrl
        ? { experience_context: { return_url: input.returnUrl, cancel_url: input.cancelUrl } }
        : {};
    // With a vaulted method the order charges that token (keyed by its REAL type —
    // see vaultChargeSource); without one the buyer picks their wallet during the
    // approval redirect. `input.methodTypes` is not consulted: server-side PayPal
    // only offers the wallet here, and a card intent arrives as a vaulted card.
    const source = input.paymentMethod ? vaultChargeSource(input.paymentMethod) : { paypal: {} };
    const sourceKey = Object.keys(source)[0]!;
    const payment_source = {
      [sourceKey]: { ...(source as Record<string, object>)[sourceKey], ...experienceContext },
    };

    const { status, json } = await this.api<any>(
      "intent",
      "POST",
      "/v2/checkout/orders",
      {
        intent: "AUTHORIZE",
        purchase_units: [
          {
            amount: { currency_code: currency, value: toDecimal(amountMinor, currency) },
            description: input.description,
            // ── #31 · the tag (unconditional) ────────────────────────────────────
            // `createIntent` reaches the network BEFORE our `payment_intents` row is
            // inserted, which is the one case ids cannot cover: the order exists and
            // our row does not. Falling back to the idempotency key when the caller
            // passed no `ownershipRef` is deliberate — a conditional tag would leave
            // untagged orders behind and invalidate the classifier's rule for every
            // object, not just this one.
            custom_id: paypalOwnershipTag(input.ownershipRef ?? input.idempotencyKey),
          },
        ],
        payment_source,
      },
      { "PayPal-Request-Id": boundedProviderKey(input.idempotencyKey, PAYPAL_REQUEST_ID_MAX) },
    );
    if (status >= 300) {
      /**
       * A PROCESSOR DECLINE IS NOT OUR CONFIGURATION FAULT — PayPal's half of #63.
       *
       * `charge()` posts to THIS endpoint with THIS `payment_source` and already books a
       * non-2xx through `chargeFailure`; only `createIntent` threw. So the caller's
       * backstop (13152c64) recorded a refused instrument as `gateway_request_rejected` —
       * "not the customer's card" — which for `INSTRUMENT_DECLINED` is the inverse of what
       * happened. Same response shape, same classifier: no new decline list is written here.
       *
       * ⚠️ Narrow, like Stripe's. Only an issue the existing PayPal tables already know
       * comes back as data; an unrecognised code is an unclassified failure — most likely
       * ours — and still throws, so a decline-shaped result cannot bury it.
       *
       * `intentId` stays empty because there is nothing to recover, and that is the
       * measured difference from RazorPay. PayPal's error envelope carries no resource id
       * (only `debug_id` and documentation `links`), and their Orders-API error reference
       * documents no case where a create errors and still leaves an order behind
       * (checked 2026-09-07). RazorPay DOES name its object, in `error.metadata.order_id`.
       */
      // The same pair `chargeFailure` reads: the specific issue, else the envelope name.
      const issue = (json?.details?.[0]?.issue as string) ?? (json?.name as string) ?? "";
      const known =
        normalizePaypalDecline(issue).ruleId != null ||
        PAYPAL_CODE_TABLE[issue] != null ||
        PAYPAL_CODE_TABLE[issue.toUpperCase()] != null;
      if (known) {
        return {
          intentId: "",
          status: "inited",
          failure: this.chargeFailure(status, json).failure,
          raw: json,
        };
      }
      throw new Error(`PayPal payment intent failed: ${status} ${JSON.stringify(json)}`);
    }

    // APPROVED = the buyer has authorized and the order is ready to authorize/capture;
    // COMPLETED = already money-moved (a replay of a consumed intent). Both mean the
    // buyer has nothing left to do.
    if (json.status === "APPROVED" || json.status === "COMPLETED") {
      return { intentId: json.id, status: "authorized", raw: json };
    }
    const approvalUrl = approvalLink(json.links);
    // PAYER_ACTION_REQUIRED is the documented "go approve this" status, but a freshly
    // created wallet order comes back CREATED and carries the payer-action link all the
    // same — reporting that as `inited` with no authorization would strand the buyer
    // with a challenge we never surfaced.
    if (json.status === "PAYER_ACTION_REQUIRED" || approvalUrl) {
      return {
        intentId: json.id,
        status: "requires_action",
        authorization: { mode: "redirect", approvalUrl },
        raw: json,
      };
    }
    return { intentId: json.id, status: "inited", raw: json };
  }

  /**
   * Fetch an order, tolerating "this id is not an order" — used to find the
   * authorization hanging off an intent (consume/void both need it).
   */
  private async fetchOrder(orderId: string): Promise<{ status: number; json: any }> {
    return this.api<any>("intent", "GET", `/v2/checkout/orders/${orderId}`);
  }

  /**
   * Contract v2 (C7): consume an authorized intent.
   *  - `payment` → authorize the approved order, then capture the authorization.
   *  - `setup`   → exchange the approved setup token for a permanent vault token.
   */
  async consumeIntent(input: ConsumeIntentInput): Promise<ConsumeIntentResult> {
    if (input.purpose === "setup") {
      // The intent id IS the setup token; consuming it produces the instrument, no
      // money moves. `describeVaultSource` (inside) records what was ACTUALLY vaulted,
      // so a vaulted CARD is not mislabelled as a wallet and made unchargeable.
      return { purpose: "setup", paymentMethod: await this.exchangeSetupToken(input.intentId) };
    }

    // A failed READ is not a decline: a 5xx here once failed an approved, payable intent.
    const order = await this.callUntilAnswered<any>(
      "intent",
      "GET",
      `/v2/checkout/orders/${encodeURIComponent(input.intentId)}`,
    );
    if (order.status >= 300) {
      return { purpose: "payment", charge: this.chargeFailure(order.status, order.json) };
    }
    const payments = order.json?.purchase_units?.[0]?.payments ?? {};

    // Already captured — a replayed consume. Answer from the existing capture rather
    // than capturing twice (PayPal would 422, and the caller would read a decline
    // where money had in fact moved).
    const existingCapture = payments.captures?.[0];
    if (existingCapture) {
      return {
        purpose: "payment",
        charge: this.captureResult(existingCapture, input.intentId, order.json),
      };
    }

    // The order may already carry an authorization — either because createIntent's
    // order was authorized by an earlier consume attempt, or because the buyer's
    // approval produced one. Capture that instead of authorizing again.
    const authorizations: Array<{ id?: string; status?: string }> = payments.authorizations ?? [];
    let authId =
      authorizations.find((a) => a.status !== "VOIDED" && a.status !== "CAPTURED")?.id ??
      authorizations[0]?.id;
    if (!authId) {
      const authorized = await this.callUntilAnswered<any>(
        "intent_authorize",
        "POST",
        `/v2/checkout/orders/${input.intentId}/authorize`,
        {},
        boundedProviderKey(`${input.idempotencyKey}:authorize`, PAYPAL_REQUEST_ID_MAX),
      );
      if (authorized.status >= 300) {
        return {
          purpose: "payment",
          charge: this.chargeFailure(authorized.status, authorized.json),
        };
      }
      authId = authorized.json?.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;
      if (!authId) {
        return {
          purpose: "payment",
          charge: {
            status: "failed",
            providerChargeId: input.intentId,
            failure: {
              code: "processing_error",
              message: "PayPal accepted the authorization request but returned no authorization.",
              // The order exists and the buyer approved it; a re-consume can still work.
              retriable: true,
            },
            raw: authorized.json,
          },
        };
      }
    }

    // Capture the hold. An explicit amount lets the engine capture less than it
    // authorized (invoice shrank); omitting it captures the full authorization.
    // `final_capture`: we capture an authorization once, so PayPal releases any
    // remainder now instead of holding it on the buyer (its default is false).
    const body = {
      ...(input.amountMinor != null && input.currency
        ? {
            amount: {
              value: toDecimal(input.amountMinor, input.currency),
              currency_code: input.currency.toUpperCase(),
            },
          }
        : {}),
      final_capture: true,
    };
    const captured = await this.callUntilAnswered<any>(
      "intent_capture",
      "POST",
      `/v2/payments/authorizations/${authId}/capture`,
      body,
      boundedProviderKey(input.idempotencyKey, PAYPAL_REQUEST_ID_MAX),
    );
    if (captured.status >= 300) {
      return { purpose: "payment", charge: this.chargeFailure(captured.status, captured.json) };
    }
    // Same capture mapping as `charge()`, PENDING-parking included: a capture under
    // review returns `pending` and settles later via PAYMENT.CAPTURE.COMPLETED/DENIED.
    // A capture resource carries no `payment_source`; the order read above does.
    return {
      purpose: "payment",
      charge: {
        ...paypalMethodUsed(order.json),
        ...this.captureResult(captured.json, authId, captured.json),
      },
    };
  }

  /**
   * Contract v2 (C7): release an authorized intent without moving money.
   *
   * Takes the intent id — which for a payment intent is the ORDER id — so it first
   * resolves the authorization hanging off that order. An id whose order cannot be read
   * is PROBED against the authorization endpoint, which keeps a caller holding the
   * authorization (e.g. replaying from a PAYMENT.AUTHORIZATION.CREATED webhook)
   * working.
   *
   * ⚠️ #32 — that probe is proof, not an assumption. The void endpoint takes an
   * AUTHORIZATION id, so an id nothing has proved to be one is never posted to it, and
   * the two ways this call can end without reaching a live authorization answer
   * differently: an order the gateway showed us was never authorized is `voided: true,
   * held: false` (nothing to release, and PayPal has no order-void endpoint to call),
   * while any other unresolved shape THROWS. `voided: true` is a claim that the
   * checkout is provably over and no caller retries or polls after seeing it, so it is
   * returned only where we can point at what ended it.
   */
  async voidIntent(input: VoidIntentInput): Promise<VoidIntentResult> {
    const order = await this.fetchOrder(input.intentId);
    const orderRead = order.status < 300;
    const authorizations: Array<{ id?: string; status?: string }> = orderRead
      ? (order.json?.purchase_units?.[0]?.payments?.authorizations ?? [])
      : [];
    const authorization =
      authorizations.find((a) => a.status !== "CAPTURED") ?? authorizations[0] ?? undefined;

    // ── #32 · the id we void must be an AUTHORIZATION we can point at ──────────
    // `undefined` until something PROVES an authorization: either the order read
    // listed one (with an id), or the probe below read one back off PayPal. There is
    // deliberately no `?? input.intentId` fallback — that fallback is what posted an
    // ORDER id to `/v2/payments/authorizations/{id}/void`, collected the inevitable
    // 404, and had it forgiven as "already voided" by the idempotency branch. The
    // buyer's funds stayed held and the caller was told the checkout was over.
    let authId: string | undefined = authorization?.id;

    // ── #30 · was the buyer's money ACTUALLY held? ──────────────────────────────
    // PayPal answers from the AUTHORIZATION, which is the resource its void endpoint
    // takes (`POST /v2/payments/authorizations/{id}/void`): an authorization existing
    // at all means a hold was placed, and its status says whether the hold is still
    // there. So this needs no poll on the ordinary path — the order read that resolves
    // the authorization id is the same read that answers the question.
    //
    // Note this is a STATUS on a resource we had to fetch anyway, not the discriminator
    // Stripe uses (`requires_capture` / `amount_capturable` on the cancel response).
    // `Prefer: return=representation` on the void is deliberately NOT sent: it would
    // return the authorization AFTER voiding, whose status is `VOIDED` by definition,
    // so it cannot say what the authorization was before — it answers a different
    // question and would change this adapter's response contract (204 → 200) for it.
    let held: boolean | undefined;
    if (authorization) {
      held = PAYPAL_HELD_AUTHORIZATION_STATUSES.has(String(authorization.status))
        ? true
        : undefined;
    } else if (orderRead) {
      // A readable order with NO authorization on it. **This is the #21 shape** — the
      // buyer abandoned the approval, nothing was ever authorized, and booking a
      // `payment_reversal` here invents the release of money the bank never took (63 of
      // the 102 intent reversals in the dev database are exactly this). Two independent
      // facts have to agree before we say so: the order read succeeded, and the order's
      // own status is a pre-authorization one. Anything else (COMPLETED, VOIDED, a
      // status a later API version adds) is ignorance, not "nothing held".
      held = PAYPAL_PRE_AUTHORIZATION_ORDER_STATUSES.has(String(order.json?.status))
        ? false
        : undefined;
    } else {
      // The order read FAILED, so `input.intentId` MIGHT already BE an authorization
      // id (a caller replaying from a PAYMENT.AUTHORIZATION.CREATED webhook). Ask,
      // rather than assume: this read is both the `held` evidence — it has to happen
      // before the void, since afterwards the status is `VOIDED` whatever it was — and
      // (#32) the only proof that the id names an authorization at all. It costs
      // nothing on the common path: it runs only once the order lookup came back
      // non-2xx.
      const probe = await this.api<{ id?: string; status?: string }>(
        "intent_void",
        "GET",
        `/v2/payments/authorizations/${encodeURIComponent(input.intentId)}`,
      );
      if (probe.status < 300) {
        // A 2xx from the authorization endpoint IS the proof that `input.intentId`
        // names an authorization, so it is the only thing that licenses the void
        // below. The status, when there is one, additionally answers `held`.
        authId = input.intentId;
        held = PAYPAL_HELD_AUTHORIZATION_STATUSES.has(String(probe.json?.status))
          ? true
          : undefined;
      }
    }

    // ── #32 · no authorization resolved ⇒ no void request exists to send ───────
    // Two shapes reach here and they must not answer the same way.
    //
    // (b) The order was READ and its own status proves it was never authorized (the
    //     #21 shape, 63 of the 102 dev reversals). PayPal has no "void an order" call
    //     — the round trip this replaces could only ever 404 — and there is provably
    //     nothing held, so the checkout really is over: `voided: true, held: false`,
    //     which keeps the operator's Void action working on the commonest case.
    //
    // (a) Anything else: the order GET failed transiently, or it was read but its
    //     status is not proof (`COMPLETED` means a capture, and reporting that as
    //     released would hide it exactly as `AUTHORIZATION_ALREADY_CAPTURED` must
    //     not be forgiven below), or an authorization was listed with no id. We do
    //     not know whether a hold exists, so we THROW. `voided: false` was the other
    //     candidate and is worse here: both callers read it as the gateway having
    //     REFUSED (`voidPaymentIntent` raises "did not void the intent",
    //     `releaseHoldBeforeExpiry` logs `reason: gateway_refused`), and the gateway
    //     was never asked. Throwing carries the reason, is retriable at both callers
    //     (they leave the intent open rather than marking it voided), and makes
    //     "the checkout is over" unreachable from a call that never reached a live
    //     authorization — rather than merely unlikely.
    if (!authId) {
      if (held === false) return { voided: true, providerTransactionId: input.intentId, held };
      /**
       * #42 — `ProviderIndeterminateError`, not a bare `Error`. A bare one reaches the
       * route as a 500, which tells the operator nothing and implies a fault of ours;
       * this class is what lets the API answer 502 `retriable: true` with this sentence.
       *
       * The sentence says only what we KNOW: which resolution failed, and that no void
       * request was sent. It deliberately does not say the hold survived — we did not
       * ask, so `held` is `undefined` here, and asserting either way would be #21 in an
       * error message.
       */
      throw new ProviderIndeterminateError(
        `PayPal void aborted: the authorization for intent ${input.intentId} could not be resolved ` +
          `(order read ${orderRead ? `ok, status ${JSON.stringify(order.json?.status)}` : `failed ${order.status}`}, ` +
          `${authorizations.length} authorization(s) listed). So no void request was sent, and we ` +
          `do not know if a hold is in place`,
      );
    }

    const { status, json } = await this.callUntilAnswered<any>(
      "intent_void",
      "POST",
      `/v2/payments/authorizations/${authId}/void`,
      {},
      boundedProviderKey(`${input.intentId}:void`, PAYPAL_REQUEST_ID_MAX),
    );
    // PayPal answers 204 with no body on success, so the void has no id of its own —
    // the authorization it released is the only handle worth showing on the timeline.
    if (status < 300) return { voided: true, providerTransactionId: json?.id ?? authId, held };

    // Idempotent per the contract: an authorization that is already gone or already
    // voided resolves as voided rather than throwing, so a retried release is a no-op.
    // AUTHORIZATION_ALREADY_CAPTURED deliberately does NOT match — money moved, and
    // reporting that as "released" would hide a real capture.
    const issue = String(json?.details?.[0]?.issue ?? json?.name ?? "");
    if (status === 404 || /VOIDED|RESOURCE_NOT_FOUND|INVALID_RESOURCE_ID/.test(issue)) {
      // The gateway says there was nothing here to void, which CONTRADICTS a `true` we
      // derived a moment earlier (someone else voided it in between, or the status we
      // read was stale) — so that claim is withdrawn to `undefined` rather than
      // asserted. ⚠️ #32: `held === false` used to be left standing here, and no longer
      // can reach this line — an order that was never authorized now returns above
      // WITHOUT a request, because PayPal has no order-void endpoint and that doomed
      // round trip was the whole mechanism of the defect. `held` here is `true` or
      // `undefined`, and both withdraw to `undefined`.
      return { voided: true, providerTransactionId: authId };
    }
    throw new Error(
      `PayPal authorization ${authId} could not be voided: ${status} ${JSON.stringify(json)}`,
    );
  }

  /**
   * Contract: what became of a charge we already placed (see `fetchChargeStatus` on
   * `PaymentProvider`). The stale-pending sweep's only source of truth when
   * `PAYMENT.CAPTURE.COMPLETED` / `.DENIED` never arrived.
   *
   * ── Why PayPal needs this ────────────────────────────────────────────────────
   * `captureResult` deliberately parks a capture that is not COMPLETED as `pending`:
   * `PENDING_REVIEW` and eCheck holds mean PayPal has not released the money and may
   * still DENY it. That is correct, and it is also a dead end without a poll — the
   * sweep counted such a payment as `unsupported` and the portal's "I won't approve
   * this" control answered HTTP 503. A capture under review that lost its webhook was
   * unresolvable by anything in the engine.
   *
   * ── Two id shapes, and why we must try both ──────────────────────────────────
   * `charge()` returns the CAPTURE id when the order completed synchronously, and the
   * ORDER id when it did not (`captureResult`'s `fallbackId`, plus the
   * pending/requires_action fallback below it). `consumeIntent` does the same. PayPal
   * ids are opaque 17-character strings with no prefix, so the shape cannot be told
   * apart — the only honest discriminator is to ask. Captures first (the common case),
   * then the order, whose capture we read out of the purchase unit.
   *
   * ── The refund trap ──────────────────────────────────────────────────────────
   * A capture polled DAYS later can read `REFUNDED` / `PARTIALLY_REFUNDED`. Feeding
   * those through `captureResult` would map them to `pending` (they are not
   * "COMPLETED"), and the sweep would keep re-polling a payment that succeeded and was
   * then refunded — forever. They cannot occur on the synchronous path, which is why
   * `captureResult` never had to consider them, and they are exactly what a poll sees.
   * Both mean the capture SUCCEEDED; the refund is its own object with its own sweep
   * (`fetchRefundStatus`).
   *
   * Everything else stays in flight. `PENDING`, and any status a later API version
   * adds, is not a failure — the sweep never turns an unrecognised answer into a
   * ledger reversal, and a failed lookup is not a verdict either (it throws, and the
   * caller leaves the payment pending and asks again next tick).
   */
  async fetchChargeStatus(input: { providerChargeId: string }): Promise<ChargeResult> {
    const id = input.providerChargeId;
    const cap = await this.api<{ id?: string; status?: string; name?: string }>(
      "charge",
      "GET",
      `/v2/payments/captures/${encodeURIComponent(id)}`,
    );
    if (cap.status < 300) return this.capturePollResult(cap.json, id, cap.json);

    // Not a capture id (404 RESOURCE_NOT_FOUND) — try it as an order.
    const { order, capture } = await this.captureFromOrder("charge", id);
    if (order.status >= 300) {
      throw new Error(
        `PayPal charge ${id} is neither a readable capture (${cap.status}) nor a readable order (${order.status})`,
      );
    }
    if (capture) return this.capturePollResult(capture, id, order.json);
    // An order with no capture at all. VOIDED is terminal and moved no money;
    // CREATED / APPROVED / PAYER_ACTION_REQUIRED / SAVED are all still open, and an
    // order the buyer simply never approved is abandoned rather than refused — the
    // sweep's own abandonment window decides that, not this poll.
    if (order.json?.status === "VOIDED") {
      const norm = normalizePaypalDecline("VOIDED");
      return {
        status: "failed",
        providerChargeId: id,
        failure: {
          code: norm.code,
          message: "PayPal reports this order as VOIDED. The authorization was released",
          retriable: norm.retriable,
        },
        raw: order.json,
      };
    }
    return { status: "pending", providerChargeId: id, raw: order.json };
  }

  /**
   * Find a charge whose create answer was lost (see `PaymentProvider.locateCharge`).
   *
   * Orders v2 and Payments v2 have no search, so this reads Transaction Search
   * (`GET /v1/reporting/transactions`) from `createdAfter` and matches our `custom_id`
   * tag (`custom_field`) and the amount. A match is confirmed by reading the capture.
   *
   * `null` is a promise that nothing was created, so it is returned only when no incoming
   * row of this amount could be ours: a row with no `custom_field` throws instead. Two
   * tagged rows throw too (an invoice's attempts share the tag). PayPal lists a transaction
   * up to 3 hours late; the sweep only fails an attempt on a `null` 24 hours on.
   *
   * Transaction Search is an app permission. Without it PayPal answers 403 and this throws,
   * so the row stays for an operator, with an error naming the permission.
   */
  async locateCharge(input: {
    ownershipRef: string;
    idempotencyKey: string;
    amountMinor: bigint;
    currency: string;
    createdAfter: Date;
  }): Promise<ChargeResult | null> {
    const tag = paypalOwnershipTag(input.ownershipRef);
    const currency = input.currency.toUpperCase();
    const ours = new Set<string>();
    let untagged = 0;
    // How far PayPal's report reaches (it lags by hours). "None" is only an answer once it
    // covers the attempt.
    let reportedUntil: number | null = null;
    const end = new Date();
    for (let from = input.createdAfter.getTime(); from < end.getTime();) {
      const to = Math.min(from + PAYPAL_SEARCH_WINDOW_MS, end.getTime());
      for (let page = 1; ; page++) {
        const q = new URLSearchParams({
          start_date: new Date(from).toISOString(),
          end_date: new Date(to).toISOString(),
          transaction_currency: currency,
          // A DENIED capture moves no balance; it is still a charge we made.
          balance_affecting_records_only: "N",
          fields: "transaction_info",
          page_size: String(PAYPAL_SEARCH_PAGE_SIZE),
          page: String(page),
        });
        const res = await this.api<{
          transaction_details?: Array<{
            transaction_info?: {
              transaction_id?: string;
              custom_field?: string;
              transaction_amount?: { value?: string; currency_code?: string };
            };
          }>;
          total_pages?: number;
          last_refreshed_datetime?: string;
        }>("locate_charge", "GET", `/v1/reporting/transactions?${q}`);
        // Optional on the merchant's app: without it the capture webhook resolves the attempt.
        if (res.status === 403)
          log.warn(
            "PayPal Transaction Search is not enabled — the lost answer waits for the webhook",
            {
              event: "paypal_transaction_search_not_enabled",
              ownership_ref: input.ownershipRef,
              detail:
                "enable Transaction Search on the PayPal REST app to also look lost answers up",
            },
          );
        if (res.status >= 300)
          throw new Error(
            `PayPal Transaction Search failed: HTTP ${res.status} ${paypalIssue(res.json) ?? ""}`.trim(),
          );
        const refreshed = Date.parse(res.json.last_refreshed_datetime ?? "");
        if (Number.isFinite(refreshed))
          reportedUntil = reportedUntil === null ? refreshed : Math.min(reportedUntil, refreshed);
        for (const row of res.json.transaction_details ?? []) {
          const t = row.transaction_info;
          const amt = t?.transaction_amount;
          if (!t?.transaction_id || !amt?.value) continue;
          if ((amt.currency_code ?? currency).toUpperCase() !== currency) continue;
          if (decimalToMinor(amt.value, currency) !== input.amountMinor) continue;
          if (t.custom_field === tag) ours.add(t.transaction_id);
          else if (!t.custom_field) untagged++;
        }
        const pages = res.json.total_pages ?? 1;
        if (page >= pages) break;
        if (page >= PAYPAL_SEARCH_MAX_PAGES)
          throw new Error("PayPal Transaction Search has too many pages to read in one lookup");
      }
      from = to;
    }

    if (ours.size > 1)
      throw new Error(
        `PayPal lists ${ours.size} charges of this amount with our tag since the attempt; not guessing`,
      );
    const [captureId] = [...ours];
    if (captureId) return this.fetchChargeStatus({ providerChargeId: captureId });
    if (untagged > 0)
      throw new Error(
        `PayPal lists ${untagged} untagged charge(s) of this amount since the attempt; ` +
          "cannot say that ours was never created",
      );
    const mustReach = Math.min(
      input.createdAfter.getTime() + PAYPAL_REPORT_COVER_MS,
      end.getTime(),
    );
    if (reportedUntil === null || reportedUntil < mustReach)
      throw new Error(
        `PayPal's transaction report does not cover the attempt yet (it reaches ${reportedUntil === null ? "an unknown time" : new Date(reportedUntil).toISOString()}); asking again later`,
      );
    return null;
  }

  /**
   * The capture hanging off an ORDER — the ONE place that knows where PayPal keeps it.
   *
   * Two callers have to ask this question, for the same underlying reason: `charge()`
   * returns the ORDER id whenever the order did not complete synchronously (and
   * `consumeIntent` does the same), and a PayPal id is an opaque 17-character string
   * with no prefix, so nothing downstream can tell an order id from a capture id by
   * looking at it. `fetchChargeStatus` asks "what became of this charge"; `refund`
   * (#41) asks "which capture do I actually refund". They held the same
   * `purchase_units[0].payments.captures[0]` walk by copy, which is two readers that can
   * drift — so they share this instead.
   *
   * `operation` is the caller's own gateway-log label, so the Gateway Activity row still
   * records which question was being asked.
   *
   * A non-2xx is NOT raised here: "that id is not an order either" is a legitimate
   * answer, and each caller words its own failure. `capture` is `undefined` both for
   * "could not read the order" and for "read it, and nothing was captured against it" —
   * a caller that must tell those apart reads `order.status`.
   */
  private async captureFromOrder(
    operation: string,
    id: string,
  ): Promise<{
    order: { status: number; json: any };
    capture: { id?: string; status?: string } | undefined;
  }> {
    const order = await this.api<any>(
      operation,
      "GET",
      `/v2/checkout/orders/${encodeURIComponent(id)}`,
    );
    return {
      order,
      capture:
        order.status < 300 ? order.json?.purchase_units?.[0]?.payments?.captures?.[0] : undefined,
    };
  }

  /**
   * A POLLED capture → ChargeResult. Split from `captureResult` because a capture read
   * back later has two states a freshly created one cannot have — see the refund trap
   * in `fetchChargeStatus`. Everything else defers to `captureResult`, so a swept
   * verdict and a synchronous one agree by construction.
   */
  private capturePollResult(
    capture: { id?: string; status?: string } | undefined,
    fallbackId: string,
    raw: unknown,
  ): ChargeResult {
    const s = capture?.status;
    if (s === "REFUNDED" || s === "PARTIALLY_REFUNDED") {
      return {
        status: "succeeded",
        providerChargeId: capture?.id ?? fallbackId,
        ...paypalMethodUsed(raw),
        raw,
      };
    }
    return this.captureResult(capture, fallbackId, raw);
  }

  /**
   * Contract: what became of a refund we already placed (see `fetchRefundStatus` on
   * `PaymentProvider`). Backs the stale-pending refund sweep when
   * `PAYMENT.CAPTURE.REFUNDED` never arrived.
   *
   * PayPal's refund states are `COMPLETED | PENDING | FAILED | CANCELLED`. Only the two
   * terminal negatives are a failure; `PENDING` — and any state a later API version adds —
   * is still in flight. The sweep must never turn an unrecognised status into a ledger
   * reversal, so the default direction is "leave it alone".
   *
   * A non-2xx is NOT a verdict either: it means we could not ask, which the caller treats
   * as "still pending" and retries on the next tick.
   */
  async fetchRefundStatus(input: { providerRefundId: string }): Promise<RefundResult> {
    const { status, json } = await this.api<{ id?: string; status?: string }>(
      "refund",
      "GET",
      `/v2/payments/refunds/${input.providerRefundId}`,
    );
    if (status >= 300) throw new Error(`PayPal refund lookup failed (${status})`);
    const mapped: RefundResult["status"] =
      json.status === "COMPLETED"
        ? "succeeded"
        : json.status === "FAILED" || json.status === "CANCELLED"
          ? "failed"
          : "pending";
    return { status: mapped, providerRefundId: json.id ?? input.providerRefundId, raw: json };
  }

  /**
   * ── #41 · the id we are handed may be an ORDER id, and this is a CAPTURES call ──
   *
   * `providerChargeId` is whatever `charge()` / `consumeIntent` recorded, and that is
   * the CAPTURE id only when the order completed synchronously — otherwise it is the
   * ORDER id (`captureResult`'s `fallbackId`, and the pending / `requires_action`
   * fallback). Opaque 17-character ids with no prefix, so the shape cannot be told
   * apart: the only honest discriminator is to ask, which is what `fetchChargeStatus`
   * already does and what `captureFromOrder` now holds for both of them.
   *
   * This never fabricated success — a non-2xx maps to `failed` — so the defect was an
   * honest failure on a resolvable cause, not a lie. The fix is only to make the refund
   * SUCCEED in that case, so it is opt-in: the capture attempt goes out FIRST and the
   * order is read only on the one answer that means "that is not a capture id"
   * (404 / RESOURCE_NOT_FOUND, the same shapes `voidIntent` names). A 422
   * CAPTURE_FULLY_REFUNDED, a declined refund, anything else — PayPal has answered the
   * question, and asking about an order would spend a round trip to learn nothing.
   *
   * ── The `PayPal-Request-Id` on the retry: DIFFERENT, and DERIVED ───────────────
   * Reusing the first attempt's id is the trap. PayPal documents that "when you include
   * a previously specified PayPal-Request-Id header in a request, PayPal returns the
   * latest status of the previous request that used that same header", and that the
   * value "must be unique for both each request and an API call type" — so the retry
   * would risk being answered with the cached 404 and this fix would be inert.
   *
   * A fresh random id would avoid that and break something worse: two engine retries of
   * the SAME refund (same `idempotencyKey`) would arrive under two ids, and PayPal's own
   * idempotency could not collapse them — a double refund of the buyer's money.
   *
   * So the retry's id is derived from the same key with a fixed discriminator: distinct
   * from the first attempt's (no replay) and identical every time this refund is retried
   * (no double refund). Same shape `voidIntent` already uses (`${intentId}:void`).
   *
   * A real engine key is longer than PayPal's measured 65-char cap (`collectInvoice`
   * builds ~69), so both ids go through `boundedProviderKey`. It HASHES rather than
   * truncating, which is what keeps the two apart: distinctness does not depend on the
   * suffix surviving, and it is why applying the suffix before or after the bound makes
   * no difference to safety here — measured, after this docblock first claimed a
   * truncation collision that cannot happen (39-char hash + `:order_capture` = 53, still
   * under the cap and still distinct). The suffix goes first because one derivation step
   * is easier to reason about, not because the other collides.
   *
   * ⚠️ REASONED FROM PAYPAL'S DOCS, NOT MEASURED. Whether PayPal caches a 404 against a
   * request id is not documented and this box has never exchanged a live PayPal refund
   * (0 of 35,135 provider webhooks ever received here are PayPal's). Both quotes above
   * were read from developer.paypal.com/api/rest/reference/idempotency on 2026-09-04.
   * The choice is the safe one under either behaviour; a sandbox refund against a stale
   * request id is what would settle it.
   */
  async refund(input: RefundInput): Promise<RefundResult> {
    // Partial refund: PayPal wants { value, currency_code } in the capture's own
    // currency. Full refund (no amount) omits the amount. Currency comes from the
    // refund request — never hardcode it (a non-USD capture 400s otherwise).
    //
    // ── #48 · A REFUND IS ITS OWN OBJECT AND INHERITS NO TAG ──────────────────────
    // `RefundInput.ownershipRef` has existed since #31 and the engine passes it (the
    // `re_…` public id), but this call dropped it, so every PayPal Refund we created
    // was untagged. RazorPay stamps its refund through `notes` and a source scan locks
    // that; here the field was available and unused.
    //
    // The cost was BLINDNESS rather than a false accusation, which is why this is not
    // urgent: `paypalProvenance` reads an ABSENT `custom_id` as `unknown` — ignorance,
    // never "not ours" — and only a `custom_id` present WITHOUT our prefix as
    // `foreign`. So an untagged refund of ours could never be positively identified,
    // and therefore could never reach `ours_unattributed`, the population that pages.
    //
    // ⚠️ `custom_id` IS a documented request-body field here — "The API caller-provided
    // external ID. Used to reconcile API caller-initiated transactions with PayPal
    // transactions", max 127 chars. Verified against the endpoint reference on
    // 2026-09-04 rather than a search summary, which claimed the opposite: an unknown
    // field on this call is a refund the customer does not get back, so the schema page
    // is the only acceptable evidence. Bounded by `paypalOwnershipTag`, which HASHES an
    // over-long ref rather than truncating — the tag degrades, the refund still goes.
    //
    // No idempotency-key fallback, deliberately, unlike `charge()`: absence reads
    // `unknown` on this adapter, which is honest, whereas a key-derived tag would read
    // as OURS and defeat exact-ref matching for nothing.
    const body = {
      ...(input.amountMinor != null && input.currency
        ? {
            amount: {
              value: toDecimal(input.amountMinor, input.currency),
              currency_code: input.currency.toUpperCase(),
            },
          }
        : {}),
      ...(input.ownershipRef ? { custom_id: paypalOwnershipTag(input.ownershipRef) } : {}),
    };
    // `encodeURIComponent` on the id, which this call was missing while
    // `fetchChargeStatus` had it: the id comes out of our own database and an unescaped
    // `/` or space in it addresses a different endpoint rather than failing.
    // A lost answer throws `ProviderIndeterminateError`: booking it `failed` released the
    // reservation, and a retry under a new key could refund twice.
    const attempt = (captureId: string, requestId: string) =>
      this.callUntilAnswered<{
        id?: string;
        status?: string;
        name?: string;
        details?: { issue?: string }[];
      }>(
        "refund",
        "POST",
        `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
        body,
        boundedProviderKey(requestId, PAYPAL_REQUEST_ID_MAX),
      );

    let res = await attempt(input.providerChargeId, input.idempotencyKey);
    const issue = String(res.json?.details?.[0]?.issue ?? res.json?.name ?? "");
    // `status >= 300` FIRST, and it is not redundant: it is the invariant that a refund
    // PayPal accepted is never posted a second time. Without it the guard rests on a 2xx
    // body happening not to carry a `name` field, and the failure mode of that being
    // wrong is refunding the buyer twice.
    if (
      res.status >= 300 &&
      (res.status === 404 || /RESOURCE_NOT_FOUND|INVALID_RESOURCE_ID/.test(issue))
    ) {
      // Only a capture id we did not already try is worth a second request. An order
      // that reads but carries no capture has nothing to refund, and the answer the
      // caller gets stays the FIRST failure — the one about the refund, not about our
      // lookup.
      const { capture } = await this.captureFromOrder("refund", input.providerChargeId);
      if (capture?.id && capture.id !== input.providerChargeId) {
        res = await attempt(capture.id, `${input.idempotencyKey}:order_capture`);
      }
    }
    const { status, json } = res;
    // `callUntilAnswered` already replayed every lost answer, so a 4xx here is definite:
    // PayPal created no refund and returns no refund id.
    if (status >= 400) throw new ProviderRefusalError(paypalRefundRefusal(status, res.json));
    return {
      status: status < 300 && json.status === "COMPLETED" ? "succeeded" : "pending",
      providerRefundId: json.id ?? "",
      raw: json,
    };
  }

  /**
   * The merchant's PayPal balance (`GET /v1/reporting/balances`). A refund is paid from
   * `available_balance`; PayPal refuses it with REFUND_FAILED_INSUFFICIENT_FUNDS when that
   * and the linked bank cannot cover it. Needs "Transaction search" on the PayPal app
   * (scope `reporting/search/read`, measured 2026-11-04); without it PayPal answers 403.
   * The figures lag: `last_refresh_time` says how far.
   */
  async fetchBalance(input: { currency?: string } = {}): Promise<GatewayBalanceResult> {
    const qs = input.currency
      ? `?currency_code=${encodeURIComponent(input.currency.toUpperCase())}`
      : "";
    const res = await this.api<{
      balances?: Array<{
        currency?: string;
        total_balance?: { value?: string };
        available_balance?: { value?: string };
        withheld_balance?: { value?: string };
      }>;
      last_refresh_time?: string;
      as_of_time?: string;
    }>("balance", "GET", `/v1/reporting/balances${qs}`);
    if (res.status === 401 || res.status === 403)
      return {
        ok: false,
        reason: "not_permitted",
        message:
          "PayPal does not let these credentials read the balance. In the PayPal developer dashboard, open Apps & Credentials, select this app, and enable Transaction search under Features.",
      };
    if (res.status >= 300)
      return {
        ok: false,
        reason: "unavailable",
        message: `PayPal did not return the balance (${paypalIssue(res.json) ?? `HTTP ${res.status}`}).`,
      };
    const balances: GatewayBalance[] = [];
    for (const b of res.json.balances ?? []) {
      if (!b.currency) continue;
      const minor = (v?: { value?: string }) => paypalSignedMinor(v?.value, b.currency!);
      balances.push({
        currency: b.currency.toUpperCase(),
        availableMinor: minor(b.available_balance),
        withheldMinor: minor(b.withheld_balance),
        totalMinor: minor(b.total_balance),
      });
    }
    const at = res.json.last_refresh_time ?? res.json.as_of_time;
    const asOf = at ? new Date(at) : null;
    return { ok: true, balances, asOf: asOf && !Number.isNaN(asOf.getTime()) ? asOf : null };
  }

  /**
   * Register our notification URL with PayPal and return the webhook ID.
   * PayPal has no shared signing secret — verification is an API call that takes
   * the `webhook_id` (see normalizeWebhook), so the id IS the material we need.
   * Idempotent: an existing endpoint for the same URL is reused rather than
   * recreated (PayPal 400s on WEBHOOK_URL_ALREADY_EXISTS).
   */
  /**
   * Delete the vaulted payment token at PayPal. For a wallet vault this cancels
   * the billing agreement, so off-session charging stops — intended for CUST-7
   * erasure, and not reversible.
   *
   * Idempotent per the contract: PayPal returns 204 on success and 404 once the
   * token is gone.
   */
  /**
   * Contract: re-read an instrument's display facts (see `fetchPaymentMethodDisplay`).
   *
   * Reuses `describeVaultSource`, so a backfilled row and a freshly vaulted one describe
   * the same card identically — including the three fields PayPal cannot answer, which
   * stay null rather than being approximated from something adjacent.
   */
  async fetchPaymentMethodDisplay(input: {
    providerPaymentMethodId: string;
    providerCustomerId?: string;
  }): Promise<ProviderPaymentMethodRef["display"] | null> {
    const { status, json } = await this.api<{ payment_source?: PayPalVaultSource }>(
      "fetch_payment_method",
      "GET",
      `/v3/vault/payment-tokens/${input.providerPaymentMethodId}`,
    );
    // Gone is a real answer, not a failure: the row stays unfilled rather than
    // acquiring invented values.
    if (status === 404) return null;
    if (status >= 300) {
      throw new Error(
        `PayPal vault token ${input.providerPaymentMethodId} could not be read: ${status}`,
      );
    }
    return describeVaultSource(json?.payment_source);
  }

  async deletePaymentMethod(input: {
    customer: ProviderCustomerRef;
    paymentMethod: ProviderPaymentMethodRef;
  }): Promise<void> {
    const tokenId = input.paymentMethod.providerPaymentMethodId;
    // A v1 billing agreement is not a vault token: DELETE /v3/vault/payment-tokens/B-…
    // answers 404, which read as "already gone" and left the agreement live at PayPal.
    if (BILLING_AGREEMENT_ID.test(tokenId)) return this.cancelBillingAgreement(tokenId);
    const { status, json } = await this.api<{ message?: string; name?: string }>(
      "delete_payment_method",
      "DELETE",
      `/v3/vault/payment-tokens/${tokenId}`,
    );
    if (status < 300 || status === 404) return;
    throw new Error(
      `PayPal vault token ${tokenId} could not be deleted: ${status} ${JSON.stringify(json)}`,
    );
  }

  /**
   * Cancel a v1 billing agreement (`POST /v1/billing-agreements/agreements/{id}/cancel`,
   * 204 on success). Idempotent: on a refusal we read the agreement, and an agreement
   * that is gone or no longer active resolves. Any other answer throws.
   */
  private async cancelBillingAgreement(agreementId: string): Promise<void> {
    const path = `/v1/billing-agreements/agreements/${encodeURIComponent(agreementId)}`;
    const cancel = await this.api<{ name?: string }>(
      "delete_payment_method",
      "POST",
      `${path}/cancel`,
      {
        note: "Payment method removed by the merchant.",
      },
    );
    if (cancel.status < 300) return;
    const read = await this.api<{ state?: string }>("delete_payment_method", "GET", path);
    if (read.status === 404) return;
    const state = String(read.json?.state ?? "").toUpperCase();
    if (read.status < 300 && /^(CANCELL?ED|EXPIRED|INACTIVE)$/.test(state)) return;
    throw new Error(
      `PayPal billing agreement ${agreementId} could not be cancelled: ${cancel.status} ` +
        `${paypalIssue(cancel.json) ?? ""} (agreement read ${read.status}, state ${state || "unknown"})`,
    );
  }

  /**
   * Verify a PayPal webhook transmission locally, against PayPal's own leaf certificate.
   *
   * Signed message: `transmission_id|transmission_time|webhook_id|crc32(raw body)`.
   * The CRC is over the EXACT bytes PayPal sent — re-serialising the parsed JSON would
   * change whitespace/key order and break the signature, which is why the raw string is
   * threaded down here rather than the object.
   *
   * Certificates are cached by URL: PayPal signs every event with the same leaf for
   * months, and fetching it per webhook would add a round-trip to a hot path (and a
   * dependency on PayPal being reachable in order to accept their own callback).
   *
   * No age limit on `transmission_time`: PayPal does not document whether a retry or a
   * dashboard resend is signed again (https://developer.paypal.com/api/rest/webhooks/ and the
   * notifications v1 spec, read 2026-10-28). A window could refuse a real resend; the per-event
   * dedup already stops a replayed delivery.
   */
  private async verifyWebhookSignatureLocally(
    h: NormalizeWebhookInput["headers"],
    rawBody: string,
  ): Promise<void> {
    const certUrl = String(h["paypal-cert-url"]);
    const transmissionId = String(h["paypal-transmission-id"]);
    const transmissionTime = String(h["paypal-transmission-time"]);
    const signature = String(h["paypal-transmission-sig"]);
    const authAlgo = String(h["paypal-auth-algo"] ?? "SHA256withRSA");

    // PayPal only ever uses SHA256withRSA today; refuse anything else rather than
    // silently mapping an unknown algorithm onto sha256.
    if (!/^sha256withrsa$/i.test(authAlgo.replace(/[^a-z0-9]/gi, ""))) {
      throw new Error(`PayPal webhook uses an unsupported auth algo: ${authAlgo}`);
    }

    const pem = await this.fetchPaypalCert(certUrl);
    const expected = `${transmissionId}|${transmissionTime}|${this.cfg.webhookId}|${crc32(rawBody)}`;
    const verifier = createVerify("sha256");
    verifier.update(expected, "utf8");
    verifier.end();

    let valid = false;
    let verifyErr: string | undefined;
    try {
      valid = verifier.verify(pem, Buffer.from(signature, "base64"));
    } catch (err) {
      verifyErr = err instanceof Error ? err.message : String(err);
    }
    if (!valid) {
      // Say WHY. A rejected transmission is not persisted (by design — we must not
      // store unverified payloads), so without this a genuine-but-rejected delivery is
      // indistinguishable from one that never arrived. The signed message contains only
      // ids and a checksum, no secrets.
      log.warn("[paypal] webhook signature REJECTED", {
        event: "paypal_webhook_signature_rejected",
        signedMessage: expected,
        certUrl,
        sigBytes: Buffer.from(signature, "base64").length,
        bodyBytes: Buffer.byteLength(rawBody, "utf8"),
        ...(verifyErr ? { verifyError: verifyErr } : {}),
      });
      throw new Error("PayPal webhook signature verification failed");
    }
  }

  /** Leaf certificate cache — PayPal reuses one for months. */
  private static readonly certCache = new Map<string, string>();

  private async fetchPaypalCert(certUrl: string): Promise<string> {
    const cached = PayPalProvider.certCache.get(certUrl);
    if (cached) return cached;
    const res = await providerFetch({
      gatewayKey: this.key,
      operation: "webhook_cert",
      method: "GET",
      url: certUrl,
      headers: {},
    });
    if (res.status >= 300 || !res.text.includes("BEGIN CERTIFICATE")) {
      throw new Error(`PayPal webhook cert could not be fetched from ${certUrl}: ${res.status}`);
    }
    PayPalProvider.certCache.set(certUrl, res.text);
    return res.text;
  }

  async provisionWebhookEndpoint(input: { url: string }): Promise<ProvisionedWebhook> {
    const list = await this.api<{ webhooks?: Array<{ id: string; url: string }> }>(
      "provision_webhook",
      "GET",
      "/v1/notifications/webhooks",
    );
    const found = list.json?.webhooks?.find((w) => w.url === input.url);
    if (found) return { webhookId: found.id, providerEndpointId: found.id };

    const created = await this.api<{ id?: string; name?: string; message?: string }>(
      "provision_webhook",
      "POST",
      "/v1/notifications/webhooks",
      {
        url: input.url,
        // Subscribe to all events; we filter in normalizeWebhook.
        event_types: [{ name: "*" }],
      },
    );
    if (created.status >= 300 || !created.json?.id)
      throw new Error(
        `paypal webhook provisioning failed: ${created.json?.message ?? created.json?.name ?? created.status}`,
      );
    return { webhookId: created.json.id, providerEndpointId: created.json.id };
  }

  async removeWebhookEndpoint(input: { url: string }): Promise<WebhookRemoval> {
    const list = await this.api<{ webhooks?: Array<{ id: string; url: string }> }>(
      "remove_webhook",
      "GET",
      "/v1/notifications/webhooks",
    );
    if (list.status >= 300) throw new Error(`PayPal could not list webhooks: ${list.status}`);
    let removed = false;
    for (const w of list.json?.webhooks ?? []) {
      if (w.url !== input.url) continue;
      const del = await this.api<unknown>(
        "remove_webhook",
        "DELETE",
        `/v1/notifications/webhooks/${encodeURIComponent(w.id)}`,
      );
      if (del.status >= 300 && del.status !== 404)
        throw new Error(`PayPal could not delete webhook ${w.id}: ${del.status}`);
      removed = true;
    }
    return { removed };
  }

  /** PayPal's event id (`WH-…`) is in the body. */
  webhookEventId(input: NormalizeWebhookInput): string {
    return webhookEventId([bodyId(input.payload)], input.payload);
  }

  async normalizeWebhook(input: NormalizeWebhookInput): Promise<NormalizedProviderEvent[]> {
    if (!this.cfg.webhookId) {
      throw new Error("PAYPAL_WEBHOOK_ID not configured — cannot verify webhook");
    }
    const h = input.headers;

    // ── local gate, BEFORE trusting PayPal's answer ────────────────────────
    // PayPal has no shared secret: authenticity rests entirely on their
    // /verify-webhook-signature API. Measured 2026-08-01, the **sandbox** endpoint
    // answers `SUCCESS` for a transmission with a fabricated `transmission_sig`
    // (base64 "fakesignature") and a non-existent cert — i.e. it rubber-stamps, and
    // an adapter that only forwards the question inherits that. These two checks are
    // cheap, local, and independent of PayPal's verdict.
    const required = [
      "paypal-auth-algo",
      "paypal-cert-url",
      "paypal-transmission-id",
      "paypal-transmission-sig",
      "paypal-transmission-time",
    ] as const;
    const missing = required.filter((k) => !h[k]);
    if (missing.length) {
      throw new Error(`PayPal webhook missing transmission headers: ${missing.join(", ")}`);
    }
    // The cert PayPal tells us to trust must actually be PayPal's — otherwise a
    // caller can point verification at a certificate they control.
    const certUrl = String(h["paypal-cert-url"]);
    let certHost: string;
    try {
      const u = new URL(certUrl);
      certHost = u.hostname;
      if (u.protocol !== "https:") throw new Error("not https");
    } catch {
      throw new Error(`PayPal webhook cert_url is not a valid https URL: ${certUrl}`);
    }
    if (certHost !== "paypal.com" && !certHost.endsWith(".paypal.com")) {
      throw new Error(`PayPal webhook cert_url host is not PayPal: ${certHost}`);
    }

    const event = JSON.parse(input.payload.toString());
    const eventId = this.webhookEventId(input);

    // ── authenticity: verify the RSA signature OURSELVES ──────────────────────
    // PayPal has no shared secret, so this is the whole trust boundary. Delegating it
    // to `/v1/notifications/verify-webhook-signature` was the original design and it
    // failed: measured 2026-08-01, the sandbox endpoint answers `SUCCESS` for a
    // transmission whose signature is literally base64("fakesignature"). An adapter
    // that only forwards the question inherits whatever the answer happens to be.
    //
    // The real check (what PayPal's own SDKs do): the signed message is
    //   transmission_id | transmission_time | webhook_id | crc32(raw body)
    // verified with SHA256withRSA against the leaf cert at `cert_url` — which the
    // gate above has already constrained to a paypal.com host, so an attacker cannot
    // point us at a certificate they control.
    await this.verifyWebhookSignatureLocally(h, input.payload.toString());

    const map: Record<string, NormalizedProviderEvent["type"]> = {
      "PAYMENT.CAPTURE.COMPLETED": "charge.succeeded",
      "PAYMENT.SALE.COMPLETED": "charge.succeeded",
      "CHECKOUT.ORDER.COMPLETED": "charge.succeeded",
      "PAYMENT.CAPTURE.DENIED": "charge.failed",
      "PAYMENT.CAPTURE.DECLINED": "charge.failed",
      "PAYMENT.SALE.DENIED": "charge.failed",
      "PAYMENT.CAPTURE.REFUNDED": "charge.refunded",
      "PAYMENT.SALE.REFUNDED": "charge.refunded",
      // Dispute lifecycle. CREATED opens the case; UPDATED is an interim status move
      // (the case stays open); RESOLVED carries the verdict in `dispute_outcome`. The
      // dispute branch below re-types both from the resource (`paypalDisputeTransition`).
      "CUSTOMER.DISPUTE.CREATED": "dispute.created",
      "CUSTOMER.DISPUTE.UPDATED": "dispute.updated",
      "CUSTOMER.DISPUTE.RESOLVED": "dispute.closed",
      // "A billing agreement is canceled" — the buyer cancelled a v1 `B-…` agreement at
      // PayPal. The name is shared with the Subscriptions API, so the branch below acts
      // only on an agreement id.
      "BILLING.SUBSCRIPTION.CANCELLED": "payment_method.detached",
      // Automatic card updater: PayPal's Payment-Token vault does not emit a
      // network card-reissue refresh event (VAULT.PAYMENT-TOKEN.* covers
      // CREATED/DELETED only). Mapped defensively so a future UPDATED flows through.
      "VAULT.PAYMENT-TOKEN.UPDATED": "payment_method.updated",
      // A setup intent consumed: the vault token now exists at PayPal. Lands on the
      // same branch as UPDATED — it confirms the instrument (status → valid) and
      // refreshes brand/last4/expiry from the authoritative payment_source. Harmless
      // for a wallet token (no card fields ⇒ nothing to overwrite; the update writer
      // ignores nulls), and a no-op if the vault call's own response has not been
      // persisted yet.
      "VAULT.PAYMENT-TOKEN.CREATED": "payment_method.updated",
      // ── intent lifecycle ────────────────────────────────────────────────────
      // A released authorization is NOT a failed charge. It used to be mapped that
      // way for want of a better word, and the word was wrong: no money ever moved,
      // so failing a "charge" would drag the invoice back into dunning over a hold
      // the merchant themselves dropped. It is an intent that will never be consumed.
      "PAYMENT.AUTHORIZATION.VOIDED": "intent.voided",
      // The two events that move a payment intent to `authorized` without polling:
      // CHECKOUT.ORDER.APPROVED (buyer finished the approval redirect) and
      // PAYMENT.AUTHORIZATION.CREATED (funds now held). Do NOT reach for
      // 'charge.succeeded' here — an authorization is money HELD, not captured, and
      // booking cash for it is the same class of bug as reading the order status
      // instead of the capture status (see `captureResult`).
      "CHECKOUT.ORDER.APPROVED": "intent.authorized",
      "PAYMENT.AUTHORIZATION.CREATED": "intent.authorized",
      // ── #33 · a capture in flight ───────────────────────────────────────────
      // The ONE PayPal delivery observed live carrying `custom_id`, so #31's
      // classifier could not see the tag on the only event known to carry it. Also
      // the shape that leaves no record at all: a capture that goes PENDING with no
      // synchronous answer (a timed-out call, a webhook-first flow).
      // ⚠️ NOT `charge.succeeded` — nothing has settled; the verdict still arrives as
      // `.COMPLETED` / `.DENIED`. NOT `intent.authorized` — this is not a hold, the
      // capture was requested and the funds are moving.
      "PAYMENT.CAPTURE.PENDING": "charge.pending",
      "PAYMENT.SALE.PENDING": "charge.pending",
      // ── #34/#35 TIER 1 · PayPal takes a capture BACK ────────────────────────
      // We went on believing we were paid.
      // ⚠️ NOT `charge.refunded`: a refund is something WE issued and `applyRefund`
      // books it as one, with a credit note against the customer's invoice. A reversal
      // is the gateway unwinding a settlement for its own reasons, and dressing it up
      // as our refund tells the customer's account a story that never happened.
      // ⚠️ NOT `charge.failed`: the charge succeeded and was booked; re-arming dunning
      // on a settlement being unwound is a different (wrong) mechanism.
      "PAYMENT.CAPTURE.REVERSED": "charge.reversed",
      "PAYMENT.SALE.REVERSED": "charge.reversed",
      // ── #34/#35 TIER 1 · the refund the bank never issued ───────────────────
      // "bank settlement process fails to issue the refund". We believe a customer was
      // repaid when they were not, and the auto-refund path reports success. This maps
      // to an EXISTING kind whose handler already does exactly the right thing:
      // `reverseFailedRefund` correlates on `providerRefundId` and calls the shared
      // `reverseRefund`, the same unwind the stale-pending sweep uses. ⚠️ That
      // correlation is why the `refund.` branch below is REQUIRED, not decorative:
      // the generic fall-through would emit this refund's id as `providerChargeId`
      // and the handler would return "ignored" on its first line.
      "PAYMENT.REFUND.FAILED": "refund.failed",
      // A refund raised and not yet issued (PayPal's example: an eCheck refund taking
      // days out of the merchant's bank). Persist-only — `PAYMENT.CAPTURE.REFUNDED`
      // still does the booking and `.FAILED` still does the reversal; this exists so
      // the window between them is not silence.
      "PAYMENT.REFUND.PENDING": "refund.pending",
      // ── #34/#35 TIER 1 · the approval that stopped standing ─────────────────
      // "A problem occurred after the buyer approved the order but before you captured
      // the payment" (PayPal publishes a dedicated handling page for it). The approval
      // no longer stands, so the intent can never be captured.
      // `markPaymentIntentVoidedFromGateway` is the right handler and books NOTHING —
      // its docblock says so explicitly, because `voidPaymentIntent` books the
      // `payment_reversal` for a release IT performed and duplicating that here would
      // double-count. So this closes a dead intent and moves no money.
      "CHECKOUT.PAYMENT-APPROVAL.REVERSED": "intent.voided",
      // ── #34/#35 TIER 3 · a vaulted instrument deleted at PayPal ─────────────
      // We would keep charging a token that no longer exists. `applyPaymentMethodDetached`
      // marks it `invalid` so collection stops selecting it, logs
      // `payment_method_detached_out_of_band`, and no-ops when the row is already gone
      // (the echo of our own delete). ⚠️ Needs its own branch below for the same reason
      // the refunds do — the dispatcher guards on `providerPaymentMethodId`.
      //
      // ⚠️ `VAULT.PAYMENT-TOKEN.DELETION-INITIATED` is DELIBERATELY not mapped. It is a
      // *request* ("a request to delete a payment token has been submitted"), not an
      // outcome, and `DELETED` — mapped here — is the outcome. Routing the request to
      // `payment_method.detached` marks the instrument `invalid` and pushes the customer
      // onto a backup card on a deletion that may never complete.
      "VAULT.PAYMENT-TOKEN.DELETED": "payment_method.detached",
    };
    let type = map[event.event_type] ?? "unknown";
    const r = event.resource ?? {};
    const occurredAt = new Date(event.create_time ?? Date.now());

    // ── #31 · whose object is this, and when did the GATEWAY create it? ─────────
    // Resolved ONCE and spread into every return below, because `normalizeWebhook`
    // returns from five different places and a tag resolved in one of them is a tag
    // missing from four. Both fields are computed from the RESOURCE, never the event.
    const objectCreatedAt = paypalObjectCreatedAt(r);
    const provenance = {
      ...readPaypalOwnership(r, { mayBeForeign: paypalMayBeForeign(event.event_type) }),
      ...(objectCreatedAt ? { providerObjectCreatedAt: objectCreatedAt } : {}),
    };

    if (type === "payment_method.updated") {
      const src = r.payment_source?.card ?? r.card ?? {};
      return [
        {
          providerEventId: eventId,
          type,
          providerPaymentMethodId: r.id,
          ...provenance,
          card: {
            brand: src.brand ?? src.card_type ?? null,
            last4: src.last_digits ?? src.last4 ?? null,
            expMonth: src.expiry ? Number(String(src.expiry).split("-")[1]) : null,
            expYear: src.expiry ? Number(String(src.expiry).split("-")[0]) : null,
          },
          occurredAt,
          raw: event,
        },
      ];
    }

    // ── the vault token is GONE at PayPal — we would otherwise keep charging it ─
    // Its own branch rather than sharing `payment_method.updated`'s: that one writes
    // card fields off `payment_source`, and a DELETED payload carries none.
    //
    // ⚠️ REQUIRED, not decorative. Without it `VAULT.PAYMENT-TOKEN.DELETED` falls
    // through to the generic return at the bottom, which sets `providerChargeId: r.id`
    // — and the inbound dispatcher guards this kind on `providerPaymentMethodId`. The
    // event would be "mapped" and still never mark an instrument invalid. That is not
    // hypothetical: it is exactly the defect found in the Stripe adapter this wave,
    // where `payment_method.detached` had been mapped with no branch since the adapter
    // was written.
    if (type === "payment_method.detached") {
      if (
        event.event_type === "BILLING.SUBSCRIPTION.CANCELLED" &&
        !BILLING_AGREEMENT_ID.test(String(r.id ?? ""))
      ) {
        return [
          { providerEventId: eventId, type: "unknown", ...provenance, occurredAt, raw: event },
        ];
      }
      return [
        {
          providerEventId: eventId,
          type,
          providerPaymentMethodId: r.id,
          ...provenance,
          occurredAt,
          raw: event,
        },
      ];
    }

    // ── intent lifecycle ──────────────────────────────────────────────────────
    // The engine correlates an intent on `payment_intents.intent_at_gateway`, which
    // for PayPal is the ORDER id (`createIntent` returns `json.id` of the v2 order).
    // Only CHECKOUT.ORDER.APPROVED delivers that id as `resource.id`; the two
    // AUTHORIZATION events carry the AUTHORIZATION as their resource, and the order
    // id hangs off `supplementary_data.related_ids.order_id` — or, when PayPal omits
    // that block, off the `up` link, which points at the order the authorization
    // belongs to (same trick `charge.refunded` uses to recover a capture id).
    if (type.startsWith("intent.")) {
      const up = (r.links ?? []).find((l: { rel?: string }) => l.rel === "up")?.href as
        | string
        | undefined;
      // `CHECKOUT.PAYMENT-APPROVAL.REVERSED` joins APPROVED here because its resource
      // is an ORDER too (PayPal lists the Orders API as its related method), so `r.id`
      // IS the order id — the value `payment_intents.intent_at_gateway` holds. Left out,
      // the `up`-link fallback would run on an order resource, correlate to nothing, and
      // the event would be mapped and still inert.
      const orderId =
        event.event_type === "CHECKOUT.ORDER.APPROVED" ||
        event.event_type === "CHECKOUT.PAYMENT-APPROVAL.REVERSED"
          ? r.id
          : (r.supplementary_data?.related_ids?.order_id ?? (up ? up.split("/").pop() : undefined));
      return [
        {
          providerEventId: eventId,
          type,
          ...(orderId ? { providerIntentId: orderId } : {}),
          ...provenance,
          occurredAt,
          raw: event,
        },
      ];
    }

    if (type.startsWith("dispute.")) {
      const transition = paypalDisputeTransition(event.event_type, r);
      type = transition.type;
      const amt = r.disputed_transactions?.[0]?.seller_transaction_id
        ? undefined
        : r.dispute_amount;
      const value = amt?.value ?? r.dispute_amount?.value;
      const currency = amt?.currency_code ?? r.dispute_amount?.currency_code;
      // The disputed provider transaction id → correlate to our payment.
      const chargeId =
        r.disputed_transactions?.[0]?.seller_transaction_id ??
        r.disputed_transactions?.[0]?.buyer_transaction_id;
      return [
        {
          providerEventId: eventId,
          type,
          providerDisputeId: r.dispute_id ?? r.id,
          ...provenance,
          providerChargeId: chargeId,
          disputeReason: r.reason ?? null,
          // Our open status on `dispute.updated`; PayPal's own word otherwise.
          disputeStatus: transition.openStatus ?? r.status ?? null,
          disputeAmountMinor:
            value != null && currency ? decimalToMinor(String(value), String(currency)) : undefined,
          disputeCurrency: currency ? String(currency).toUpperCase() : null,
          evidenceDueBy: r.seller_response_due_date ? new Date(r.seller_response_due_date) : null,
          occurredAt,
          raw: event,
        },
      ];
    }

    // ── a refund that did not land, or has not landed YET ─────────────────────
    // The resource is the REFUND, so `r.id` is a refund id and the CAPTURE our payment
    // is keyed on appears only as the `up` link — PayPal sends no `supplementary_data`
    // on refund events (verified live 2026-07-27, the reason `charge.refunded` below
    // does the same thing). Correlate on `providerRefundId`; the capture is carried for
    // the inspector's Transaction column only.
    //
    // ⚠️ REQUIRED, not decorative, and this is the highest-value event of the wave.
    // Without this branch the generic return at the bottom emits `providerChargeId:
    // r.id` — a REFUND id — and never `providerRefundId`, and `reverseFailedRefund`
    // returns "ignored" on its first line without one. `PAYMENT.REFUND.FAILED` would be
    // mapped and still leave us believing a customer was repaid when the bank never
    // issued it. Same shape as the 2026-07-27 bug the `charge.refunded` branch below
    // was written to fix.
    if (type === "refund.failed" || type === "refund.pending") {
      const up = (r.links ?? []).find((l: { rel?: string }) => l.rel === "up")?.href as
        | string
        | undefined;
      const captureId =
        r.supplementary_data?.related_ids?.capture_id ?? (up ? up.split("/").pop() : undefined);
      const amt = r.seller_payable_breakdown?.total_refunded_amount ?? r.amount;
      return [
        {
          providerEventId: eventId,
          type,
          providerRefundId: r.id,
          ...(captureId ? { providerChargeId: captureId } : {}),
          ...provenance,
          ...(amt?.value != null && amt?.currency_code
            ? {
                amountRefundedMinor: decimalToMinor(String(amt.value), String(amt.currency_code)),
              }
            : {}),
          // PayPal names no failure code on this resource; absent stays absent rather
          // than being filled with `status`, which is not a decline reason.
          occurredAt,
          raw: event,
        },
      ];
    }

    if (type === "charge.refunded") {
      // The resource here is the REFUND, not the capture — so `r.id` is a refund id,
      // while the capture id our payment is keyed on appears ONLY as the `up` link
      // (PayPal sends no supplementary_data on this event; verified live 2026-07-27).
      // Emitting r.id as providerChargeId meant an out-of-band PayPal refund verified
      // and then landed as `ignored`: money left PayPal and the ledger never learned.
      //
      // v1 `PAYMENT.SALE.REFUNDED` has no `up` link: the sale is `sale_id`, the amount
      // `amount.total`. `applyRefund` books a FULL refund when the amount is missing, so
      // a v1 refund we cannot size is left uncorrelated rather than booked in full.
      const v1 = event.event_type === "PAYMENT.SALE.REFUNDED";
      const amountRefundedMinor = refundedAmountMinor(r);
      const chargeId = v1
        ? amountRefundedMinor != null
          ? parentSaleId(r)
          : undefined
        : parentCaptureId(r);
      return [
        {
          providerEventId: eventId,
          type,
          providerChargeId: chargeId,
          providerRefundId: r.id,
          ...provenance,
          // Cumulative where PayPal gives it: the reconciler treats it as the running total.
          amountRefundedMinor,
          occurredAt,
          raw: event,
        },
      ];
    }

    // ── PayPal took a settled capture (or v1 sale) back ─────────────────────────
    // The resource is the reversal, refund-shaped, so the charge is its parent. The
    // engine books it through the late-failure reversal path, or as the dispute's
    // withdrawal when a dispute on the charge is open.
    if (type === "charge.reversed") {
      const chargeId =
        event.event_type === "PAYMENT.SALE.REVERSED"
          ? parentSaleId(r)
          : (parentCaptureId(r) ?? (r.status === "REVERSED" ? r.id : undefined));
      // No `failureCode`: a reversal is not a decline of the instrument, and absent
      // keeps the engine's default (retriable) rather than inventing one.
      return [
        {
          providerEventId: eventId,
          type,
          ...(chargeId ? { providerChargeId: chargeId } : {}),
          ...provenance,
          occurredAt,
          raw: event,
        },
      ];
    }

    // ── #31 · the machine tie-back, which needs no tag at all ──────────────────
    // A capture event's `supplementary_data.related_ids` names the ORDER (and the
    // authorization) it came from, and the order id is exactly what the engine stores
    // in `payment_intents.intent_at_gateway` — so an UNTAGGED capture of ours is still
    // matchable, inline, with no extra gateway call. This is the mechanism; the tag is
    // the fallback for objects no id of ours can reach. Emitted alongside
    // `providerChargeId` (the capture) because the two are different handles on
    // different objects and the engine correlates on both.
    const relatedOrderId = r.supplementary_data?.related_ids?.order_id as string | undefined;
    const captured =
      type === "charge.succeeded" ? paypalCapturedAmount(event.event_type, r) : undefined;
    // DENIED on a capture we already hold as succeeded is PayPal taking it back; the
    // engine acts on the flag only for a succeeded transaction.
    const denied =
      event.event_type === "PAYMENT.CAPTURE.DENIED" || event.event_type === "PAYMENT.SALE.DENIED";
    return [
      {
        providerEventId: eventId,
        type,
        providerChargeId: r.id,
        ...(relatedOrderId ? { providerIntentId: relatedOrderId } : {}),
        ...(captured != null ? { capturedAmountMinor: captured } : {}),
        ...(denied ? { lateReversal: true } : {}),
        ...provenance,
        occurredAt,
        raw: event,
      },
    ];
  }
}

/**
 * What a success event's resource says was captured: a v2 capture's `amount`, a v1
 * sale's `amount.total`, or an order's COMPLETED captures (one currency only).
 */
export function paypalCapturedAmount(eventType: string, r: any): bigint | undefined {
  const minor = (value: unknown, currency: unknown) =>
    value != null && typeof currency === "string" && currency
      ? decimalToMinor(String(value), currency)
      : undefined;
  if (eventType === "PAYMENT.CAPTURE.COMPLETED")
    return minor(r?.amount?.value, r?.amount?.currency_code);
  if (eventType === "PAYMENT.SALE.COMPLETED") return minor(r?.amount?.total, r?.amount?.currency);
  if (eventType === "CHECKOUT.ORDER.COMPLETED") {
    const captures = ((r?.purchase_units ?? []) as any[])
      .flatMap((u) => (u?.payments?.captures ?? []) as any[])
      .filter((c) => c?.status === "COMPLETED");
    const currencies = new Set(captures.map((c) => c?.amount?.currency_code));
    if (captures.length === 0 || currencies.size !== 1) return undefined;
    let total = 0n;
    for (const c of captures) {
      const m = minor(c?.amount?.value, c?.amount?.currency_code);
      if (m == null) return undefined;
      total += m;
    }
    return total;
  }
  return undefined;
}
