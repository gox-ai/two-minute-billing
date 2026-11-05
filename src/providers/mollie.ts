/**
 * Mollie adapter: cards, SEPA Direct Debit and PayPal on the Payments API v2, over plain HTTP.
 *
 * Recurring uses Mollie's own mandates, never Mollie Subscriptions (the engine owns WHEN to
 * charge). A hosted `first` payment creates the mandate: a card (incl. Apple Pay and Google
 * Pay) makes a `creditcard` mandate; iDEAL, Bancontact, Belfius, KBC, EPS and Pay by Bank
 * make a `directdebit` (SEPA) mandate; PayPal makes a `paypal` mandate. Renewals are
 * `recurring` payments against that mandate. A hosted `oneoff` payment ("Pay now") lets the
 * payer pick any enabled method and never becomes a stored instrument.
 *
 * Webhooks: Mollie posts only an id (`id=tr_…`, unsigned) to the per-payment `webhookUrl`.
 * The adapter fetches the payment with our API key and trusts only that answer, so a forged
 * id books nothing. Every delivery re-derives the payment's whole state (status, refunds,
 * chargebacks), and each fact gets its own event id, so redeliveries dedupe.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { decimalToMinor, minorToDecimalString } from "@/platform/currency";
import type {
  ChargeInput,
  ChargeResult,
  ConsumeIntentInput,
  ConsumeIntentResult,
  CreateIntentInput,
  EnsureCustomerInput,
  FetchedIntent,
  IntentPurpose,
  IntentRef,
  NormalizeWebhookInput,
  NormalizedProviderEvent,
  PaymentProvider,
  ProviderCapabilities,
  ProviderCustomerRef,
  ProviderMandate,
  ProviderPaymentMethodRef,
  RefundInput,
  RefundResult,
  VaultPaymentMethodInput,
} from "./types";
import { markStrandedObject, ProviderIndeterminateError, ProviderRefusalError } from "./types";
import type {
  CancelPendingChargeInput,
  CancelPendingChargeResult,
  ProviderRefundRecord,
} from "./types";
import { classifyGatewayHttp } from "./gateway-http-class";
import { createLogger } from "@/platform/logger";
import { boundedProviderKey, providerFetch } from "./http";
import { normalizeMollieDecline, type DeclineSignal } from "./decline-codes";
import { headerValue, webhookEventId } from "./webhook-event-id";

export const MOLLIE_API_BASE = "https://api.mollie.com/v2";
/** Metadata keys on every object we create. */
export const MOLLIE_OWNERSHIP_KEY = "tmbilling_ref";
const KIND_KEY = "tmbilling_kind";
const IDEM_KEY = "tmbilling_idem";
const IDEMPOTENCY_KEY_MAX = 128;
/** Recent payments scanned to find one whose create answer was lost. */
const LOOKUP_PAGE = 250;
/** Pages a list walk reads before it gives up (it then throws: "none" would be a guess). */
const LIST_MAX_PAGES = 40;
/** Attempts of one create under one key, and the wait between them when Mollie names none. */
const CREATE_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
/** A longer `Retry-After` is not slept through inside a request: the outcome stays open. */
const RETRY_MAX_WAIT_MS = 10_000;
/** Timers can fire a millisecond early; a retry must never come sooner than Mollie asked. */
const RETRY_MARGIN_MS = 25;
/**
 * The settlement poll re-reads refunds created this long before its window: a refund's
 * status changes after it is created, and its webhook can be lost too.
 */
export const MOLLIE_REFUND_LOOKBACK_MS = 7 * 24 * 3_600_000;
/** …and chargebacks this long before it, for a `reversedAt` set long after the chargeback. */
export const MOLLIE_CHARGEBACK_LOOKBACK_MS = 180 * 24 * 3_600_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What a payment is FOR, stamped in metadata so a webhook maps it without our database. */
type Kind = "charge" | "setup" | "payment";

/** Mandate method → our method type. Others (Bacs) are not offered. */
const MANDATE_METHOD: Readonly<Record<string, ProviderPaymentMethodRef["display"]["type"]>> = {
  creditcard: "card",
  directdebit: "sepa_debit",
  paypal: "paypal",
};

/** Our method type → the Mollie methods that create that mandate on a first payment. */
export const MOLLIE_FIRST_METHODS: Readonly<Record<string, readonly string[]>> = {
  // Apple Pay and Google Pay ride `creditcard`: Mollie refuses them by name (measured).
  card: ["creditcard"],
  sepa_debit: ["ideal", "bancontact", "belfius", "kbc", "eps", "paybybank"],
  paypal: ["paypal"],
};

/**
 * What the payer paid with (`ChargeResult.methodUsed`): our method type where one fits, else
 * Mollie's own method name, lowercased (`ideal`, `bancontact`, `paybybank`, `twint`, …).
 */
export function mollieMethodUsed(p: Pick<MolliePayment, "method" | "details">): string | undefined {
  const wallet = p.details?.wallet;
  switch (p.method) {
    case undefined:
    case null:
      return undefined;
    case "creditcard":
      return wallet === "applepay" ? "apple_pay" : wallet === "googlepay" ? "google_pay" : "card";
    case "applepay":
      return "apple_pay";
    case "googlepay":
      return "google_pay";
    case "directdebit":
      return "sepa_debit";
    case "paypal":
      return "paypal";
    default:
      return p.method.toLowerCase().replace(/[^a-z0-9_]/g, "");
  }
}

/** Mandate status → the engine's mandate vocabulary (`payment-methods/mandate-afa.ts`). */
export function normalizeMollieMandateStatus(status: string | undefined): string | undefined {
  if (status === "valid") return "active";
  if (status === "pending") return "initiated";
  if (status === "invalid") return "cancelled";
  return undefined;
}

export function mollieRefundStatus(status: string | undefined): RefundResult["status"] {
  if (status === "refunded") return "succeeded";
  if (status === "failed" || status === "canceled") return "failed";
  return "pending"; // queued, pending, processing
}

/** `re_…:tr_…`: a Mollie refund is read under its payment, so the id carries both. */
export const mollieRefundRef = (refundId: string, paymentId: string) => `${refundId}:${paymentId}`;
function parseRefundRef(ref: string): { refundId: string; paymentId: string } | null {
  const [refundId, paymentId] = ref.split(":");
  return refundId?.startsWith("re_") && paymentId?.startsWith("tr_")
    ? { refundId, paymentId }
    : null;
}

/** `sha256=<hex>` HMAC of the raw body (next-gen webhooks), compared in constant time. */
export function verifyMollieSignature(
  rawBody: string | Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const want = createHmac("sha256", secret).update(rawBody).digest("hex");
  // During a secret rotation Mollie sends two signatures; either may match.
  return header.split(",").some((part) => {
    const got = part.trim().replace(/^sha256=/, "");
    const a = Buffer.from(want, "utf8");
    const b = Buffer.from(got, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

interface MollieAmount {
  value: string;
  currency: string;
}

export interface MolliePayment {
  id: string;
  mode?: string;
  status?: string;
  method?: string | null;
  sequenceType?: string;
  createdAt?: string;
  paidAt?: string;
  failedAt?: string;
  amount: MollieAmount;
  amountRefunded?: MollieAmount;
  amountRemaining?: MollieAmount;
  amountChargedBack?: MollieAmount;
  amountCaptured?: MollieAmount;
  /** Set once the payment was authorized (a method that is captured later). */
  authorizedAt?: string;
  customerId?: string | null;
  mandateId?: string | null;
  metadata?: Record<string, unknown> | null;
  details?: {
    failureReason?: string;
    failureMessage?: string;
    bankReasonCode?: string;
    bankReason?: string;
    wallet?: string;
  } | null;
  _links?: {
    checkout?: { href?: string };
    changePaymentState?: { href?: string };
    refunds?: { href?: string };
  };
}

export interface MollieRefund {
  id: string;
  status?: string;
  amount: MollieAmount;
  createdAt?: string;
  paymentId?: string;
  metadata?: Record<string, unknown> | null;
  _embedded?: { payment?: MolliePayment };
}

export interface MollieChargeback {
  id: string;
  amount: MollieAmount;
  createdAt?: string;
  reversedAt?: string | null;
  reason?: { code?: string; description?: string } | null;
  paymentId?: string;
  _embedded?: { payment?: MolliePayment };
}

interface MollieList<T> {
  _embedded?: Record<string, T[] | undefined>;
  _links?: { next?: { href?: string } | null };
}

interface MollieMandate {
  id: string;
  status?: string;
  method?: string;
  mandateReference?: string | null;
  customerId?: string;
  details?: {
    consumerAccount?: string | null;
    consumerBic?: string | null;
    cardNumber?: string | null;
    cardLabel?: string | null;
    cardExpiryDate?: string | null;
    cardFingerprint?: string | null;
  };
}

interface MollieError {
  status?: number;
  title?: string;
  detail?: string;
  field?: string;
}

export interface MollieConfig {
  /** `test_…` or `live_…`; the prefix must match the account's mode. */
  apiKey: string;
  livemode: boolean;
  /** Where Mollie posts this account's payment webhooks. Omitted when no public URL exists. */
  notificationUrl?: string;
  /** Optional signing secret of a next-gen webhook made in the Mollie dashboard. */
  webhookSecret?: string;
  apiBase?: string;
}

const log = createLogger("mollie");

const toValue = (minor: bigint, currency: string) => ({
  currency: currency.toUpperCase(),
  value: minorToDecimalString(minor, currency.toUpperCase()),
});
const toMinor = (a: MollieAmount | undefined): bigint =>
  a ? decimalToMinor(a.value, a.currency) : 0n;
const errorText = (e: MollieError | undefined, status: number) =>
  `${e?.detail ?? e?.title ?? `HTTP ${status}`}${e?.field ? ` (field ${e.field})` : ""}`;

/** Mollie rejects a webhook URL it cannot reach (localhost, a bare host name). */
export function reachableWebhookUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname;
    if (!host.includes(".") || /^(127\.|0\.0\.0\.0|\[?::1)/.test(host)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/** `ours` iff our tag is on the object; Mollie keeps no metadata of its own, so absent is `foreign`. */
function ownershipOf(
  meta: Record<string, unknown> | null | undefined,
): Pick<NormalizedProviderEvent, "ownership" | "ownershipRef"> {
  const ref = meta && typeof meta === "object" ? meta[MOLLIE_OWNERSHIP_KEY] : undefined;
  return typeof ref === "string" && ref
    ? { ownership: "ours", ownershipRef: ref }
    : { ownership: "foreign" };
}

function kindOf(p: MolliePayment): Kind {
  const k = p.metadata?.[KIND_KEY];
  if (k === "charge" || k === "setup" || k === "payment") return k;
  if (p.sequenceType === "first") return "setup";
  if (p.sequenceType === "recurring") return "charge";
  return "payment";
}

/** The failure on a failed, canceled or expired payment, normalized. */
export function mollieFailure(p: MolliePayment): NonNullable<ChargeResult["failure"]> {
  const code =
    p.details?.failureReason ?? p.details?.bankReasonCode ?? (p.status as string) ?? "failed";
  const message =
    p.details?.failureMessage ?? p.details?.bankReason ?? `Mollie payment ${p.status ?? "failed"}`;
  const norm = normalizeMollieDecline({ code, message } satisfies DeclineSignal);
  return {
    code: norm.code,
    providerCode: code,
    message: norm.message ?? message,
    retriable: norm.retriable,
    ...(norm.ruleId ? { ruleId: norm.ruleId } : {}),
  };
}

/** A payment's status → ChargeResult. `open`/`pending`/`authorized` have no verdict yet. */
export function molliePaymentResult(p: MolliePayment): ChargeResult {
  const methodUsed = mollieMethodUsed(p);
  const base = { providerChargeId: p.id, raw: p, ...(methodUsed ? { methodUsed } : {}) };
  if (p.status === "paid") return { status: "succeeded", ...base };
  if (p.status === "failed" || p.status === "canceled" || p.status === "expired")
    return { status: "failed", failure: mollieFailure(p), ...base };
  return { status: "pending", ...base };
}

export class MollieProvider implements PaymentProvider {
  readonly key = "mollie" as const;
  readonly capabilities: ProviderCapabilities = {
    refunds: true,
    partialRefunds: true,
    mandateCurrencyAuthoritative: ["sepa_debit"],
    // Cards take many currencies; SEPA is EUR only (`currencyBoundMethods`).
    currencies: [],
    methods: ["card", "sepa_debit", "paypal"],
    intents: true,
    // `setup` = a hosted first payment (the mandate); `payment` = a hosted one-off payment.
    intentPurposes: ["payment", "setup"],
    // A paid payment is captured already, and an open one holds nothing. No void exists.
    intentVoid: false,
    intentStatus: true,
    // No per-debit ceiling on any Mollie mandate.
    mandates: false,
    // `DELETE /v2/payments/{id}` while the payment `isCancelable` (SEPA before submission).
    pendingDebitCancel: true,
    // Webhook catch-up: Mollie stops retrying after 10 tries in 26 h, and no classic webhook
    // announces a chargeback reversal. `pollSettlements` reads both from the list endpoints.
    settlementReport: { intervalMinutes: 60, maxWindowHours: 48 },
  };

  private readonly base: string;

  constructor(private readonly cfg: MollieConfig) {
    const key = cfg.apiKey.trim();
    const mode = key.startsWith("live_") ? true : key.startsWith("test_") ? false : null;
    if (mode === null)
      throw new Error("The Mollie API key must start with test_ or live_. Copy it again.");
    if (mode !== cfg.livemode)
      throw new Error(
        cfg.livemode
          ? "This is a live business, so the Mollie API key must start with live_."
          : "This is a test business, so the Mollie API key must start with test_.",
      );
    this.base = (cfg.apiBase ?? MOLLIE_API_BASE).replace(/\/$/, "");
  }

  // ── transport ──────────────────────────────────────────────────────────────

  private async api<T>(
    operation: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ status: number; headers?: Headers; json: T & MollieError }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.apiKey.trim()}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey)
      headers["Idempotency-Key"] = boundedProviderKey(idempotencyKey, IDEMPOTENCY_KEY_MAX);
    const res = await providerFetch({
      gatewayKey: this.key,
      operation,
      method,
      url: `${this.base}${path}`,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json: unknown = {};
    try {
      json = res.text ? JSON.parse(res.text) : {};
    } catch {
      json = { detail: res.text.slice(0, 200) };
    }
    return { status: res.status, headers: res.headers, json: json as T & MollieError };
  }

  /** GET that answers null on 404/410 and throws on any other failure. */
  private async read<T>(operation: string, path: string): Promise<T | null> {
    const { status, json } = await this.api<T>(operation, "GET", path);
    if (status === 404 || status === 410) return null;
    if (status >= 300) throw new Error(`Mollie ${operation} failed: ${errorText(json, status)}`);
    return json;
  }

  /**
   * POST under an idempotency key, read by `classifyGatewayHttp`. A network error, 408, 409
   * ("still being processed"), 429 or 5xx may have created the object: retry under the same
   * key (Mollie replays the first answer for an hour), waiting `Retry-After` when sent. Then
   * `find` looks it up by our metadata; without a match the outcome is indeterminate. Only
   * another 4xx is a refusal.
   */
  private async create<T extends { id: string }>(
    operation: string,
    path: string,
    body: Record<string, unknown>,
    idempotencyKey: string,
    find?: () => Promise<T | null>,
  ): Promise<{ ok: true; resource: T } | { ok: false; status: number; error: MollieError }> {
    let last = "";
    for (let attempt = 1; attempt <= CREATE_ATTEMPTS; attempt++) {
      let waitMs: number | null = null;
      try {
        const res = await this.api<T>(operation, "POST", path, body, idempotencyKey);
        const cls = classifyGatewayHttp({
          status: res.status,
          retryAfter: res.headers?.get("retry-after") ?? null,
        });
        if (cls.kind === "answer") return { ok: true, resource: res.json };
        if (cls.kind === "definite") return { ok: false, status: res.status, error: res.json };
        last = `HTTP ${res.status}`;
        waitMs = cls.retryAfterMs;
      } catch (e) {
        last = (e as Error).message;
      }
      if (attempt === CREATE_ATTEMPTS) break;
      const ms = waitMs ?? RETRY_BASE_MS * 2 ** (attempt - 1);
      if (ms > RETRY_MAX_WAIT_MS) break;
      await sleep(ms + RETRY_MARGIN_MS);
    }
    const found = find ? await find().catch(() => null) : null;
    if (found) return { ok: true, resource: found };
    throw new ProviderIndeterminateError(
      `We could not confirm whether Mollie created the ${operation} (${last}). Try again later.`,
    );
  }

  /** Every item of a list endpoint, newest first, until `stop` says the rest is older. */
  private async *walk<T>(
    operation: string,
    path: string,
    key: string,
    stop: (item: T) => boolean,
  ): AsyncGenerator<T> {
    let next: string | null = path;
    for (let page = 0; next; page++) {
      if (page === LIST_MAX_PAGES)
        throw new Error(`Mollie ${operation}: more than ${LIST_MAX_PAGES} pages to read`);
      const list: MollieList<T> | null = await this.read<MollieList<T>>(operation, next);
      for (const item of list?._embedded?.[key] ?? []) {
        if (stop(item)) return;
        yield item;
      }
      const href: string | undefined = list?._links?.next?.href;
      next = href ? this.relative(href) : null;
    }
  }

  /** A `_links` href as a path under our base. */
  private relative(href: string): string {
    if (href.startsWith(this.base)) return href.slice(this.base.length);
    const u = new URL(href);
    return u.pathname.replace(/^.*?\/v2(?=\/)/, "") + u.search;
  }

  /** A recent payment we created under this idempotency key, if Mollie has one. */
  private async findPayment(idempotencyKey: string): Promise<MolliePayment | null> {
    const want = boundedProviderKey(idempotencyKey, IDEMPOTENCY_KEY_MAX);
    const list = await this.read<{ _embedded?: { payments?: MolliePayment[] } }>(
      "payment_lookup",
      `/payments?limit=${LOOKUP_PAGE}`,
    );
    return list?._embedded?.payments?.find((p) => p.metadata?.[IDEM_KEY] === want) ?? null;
  }

  private meta(kind: Kind, ref: string | undefined, idempotencyKey: string) {
    return {
      [KIND_KEY]: kind,
      [IDEM_KEY]: boundedProviderKey(idempotencyKey, IDEMPOTENCY_KEY_MAX),
      ...(ref ? { [MOLLIE_OWNERSHIP_KEY]: ref.slice(0, 200) } : {}),
    };
  }

  private get webhookUrl(): Record<string, string> {
    const url = reachableWebhookUrl(this.cfg.notificationUrl);
    return url ? { webhookUrl: url } : {};
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const { status, json } = await this.api<{ count?: number }>(
      "health_check",
      "GET",
      "/methods?sequenceType=recurring",
    );
    if (status >= 300) return { ok: false, detail: errorText(json, status) };
    return { ok: true, detail: `${json.count ?? 0} recurring methods active` };
  }

  // ── customers ──────────────────────────────────────────────────────────────

  async ensureCustomer(input: EnsureCustomerInput): Promise<ProviderCustomerRef> {
    const res = await this.create<{ id: string }>(
      "customer",
      "/customers",
      {
        ...(input.name ? { name: input.name.slice(0, 255) } : {}),
        ...(input.email ? { email: input.email.split(",")[0]!.trim() } : {}),
        metadata: { [MOLLIE_OWNERSHIP_KEY]: input.customerRef },
      },
      `tmb_customer_${input.customerRef}`,
    );
    if (!res.ok)
      throw new ProviderRefusalError(
        `Mollie refused the customer: ${errorText(res.error, res.status)}`,
      );
    return { providerKey: this.key, providerCustomerId: res.resource.id };
  }

  async updateCustomer(ref: ProviderCustomerRef, input: EnsureCustomerInput): Promise<void> {
    const { status, json } = await this.api(
      "customer_update",
      "PATCH",
      `/customers/${encodeURIComponent(ref.providerCustomerId)}`,
      {
        ...(input.name ? { name: input.name.slice(0, 255) } : {}),
        ...(input.email ? { email: input.email.split(",")[0]!.trim() } : {}),
      },
    );
    if (status >= 300) throw new Error(`Mollie customer update failed: ${errorText(json, status)}`);
  }

  // ── mandates ───────────────────────────────────────────────────────────────

  private async getMandate(customerId: string, mandateId: string): Promise<MollieMandate | null> {
    return this.read<MollieMandate>(
      "mandate",
      `/customers/${encodeURIComponent(customerId)}/mandates/${encodeURIComponent(mandateId)}`,
    );
  }

  /** A mandate as a stored instrument. Throws for a mandate type we do not offer. */
  describeMandate(m: MollieMandate, customerId: string): ProviderPaymentMethodRef {
    const type = MANDATE_METHOD[m.method ?? ""];
    if (!type)
      throw new ProviderRefusalError(
        `Mollie mandate ${m.id} uses the ${m.method ?? "unknown"} method, which this gateway account does not offer.`,
      );
    const d = m.details ?? {};
    const display: ProviderPaymentMethodRef["display"] = { type };
    if (type === "card") {
      if (d.cardLabel) display.brand = d.cardLabel.toLowerCase();
      if (d.cardNumber) display.last4 = d.cardNumber.slice(-4);
      const exp = /^(\d{4})-(\d{2})/.exec(d.cardExpiryDate ?? "");
      if (exp) {
        display.expYear = Number(exp[1]);
        display.expMonth = Number(exp[2]);
      }
      if (d.cardFingerprint) display.instrumentFingerprint = d.cardFingerprint;
    } else if (type === "sepa_debit") {
      const iban = (d.consumerAccount ?? "").replace(/\s+/g, "");
      if (iban.length >= 4) display.last4 = iban.slice(-4);
      if (/^[A-Z]{2}/.test(iban)) display.issuerCountry = iban.slice(0, 2);
    }
    // PayPal: `consumerAccount` is the payer's email; we keep nothing of it.
    const status = normalizeMollieMandateStatus(m.status);
    const mandate: ProviderMandate = {
      ...(status ? { status } : {}),
      ...(m.method ? { rail: m.method } : {}),
      reference: m.mandateReference ?? m.id,
      ...(type === "sepa_debit" ? { currency: "EUR" } : {}),
    };
    return {
      providerKey: this.key,
      providerPaymentMethodId: m.id,
      providerCustomerId: customerId,
      display,
      mandate,
    };
  }

  /** The mandate a finished first payment created, or why there is none. */
  private async mandateOfFirstPayment(
    paymentId: string,
  ): Promise<
    | { ok: true; ref: ProviderPaymentMethodRef; payment: MolliePayment }
    | { ok: false; payment: MolliePayment | null; reason: "open" | "failed" | "not_first" }
  > {
    const p = await this.read<MolliePayment>(
      "first_payment",
      `/payments/${encodeURIComponent(paymentId)}`,
    );
    // Only a first payment makes a mandate: a one-off is never a stored instrument.
    if (!p || p.sequenceType !== "first") return { ok: false, payment: p, reason: "not_first" };
    if (p.status === "failed" || p.status === "canceled" || p.status === "expired")
      return { ok: false, payment: p, reason: "failed" };
    if (p.status !== "paid" || !p.mandateId || !p.customerId)
      return { ok: false, payment: p, reason: "open" };
    const m = await this.getMandate(p.customerId, p.mandateId);
    if (!m) return { ok: false, payment: p, reason: "failed" };
    return { ok: true, ref: this.describeMandate(m, p.customerId), payment: p };
  }

  /**
   * A first payment for a bank mandate moves EUR 0.01 to check the account. Nothing books it, so
   * give it back. Not awaited: a failed refund must not hold up or fail the mandate. The key
   * makes the buyer's completion and the webhook harvest send one refund between them.
   */
  private returnCheckAmount(p: MolliePayment): void {
    const amount = toMinor(p.amount);
    if (amount <= 0n || toMinor(p.amountRefunded) > 0n || p._links?.refunds) return;
    void this.create<MollieRefund>(
      "setup_refund",
      `/payments/${encodeURIComponent(p.id)}/refunds`,
      { amount: toValue(amount, p.amount.currency), description: "Payment method check returned" },
      `setup_refund_${p.id}`,
    )
      .then((res) => {
        if (!res.ok)
          log.warn("mollie refused the payment method check refund", {
            payment: p.id,
            status: res.status,
            error: errorText(res.error, res.status),
          });
      })
      .catch((e: unknown) =>
        log.warn("mollie payment method check refund failed", {
          payment: p.id,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
  }

  async vaultPaymentMethod(input: VaultPaymentMethodInput): Promise<ProviderPaymentMethodRef> {
    const customerId = input.customer.providerCustomerId;
    if (input.token.startsWith("mdt_")) {
      const m = await this.getMandate(customerId, input.token);
      if (!m)
        throw new ProviderRefusalError(
          "Mollie does not know this mandate for this customer. We cannot save it.",
        );
      return this.describeMandate(m, customerId);
    }
    if (!input.token.startsWith("tr_"))
      throw new ProviderRefusalError("A Mollie payment method is a first payment or a mandate.");
    const r = await this.mandateOfFirstPayment(input.token);
    if (!r.ok)
      throw new ProviderRefusalError(
        r.reason === "not_first"
          ? "This Mollie payment did not set up automatic payments. We cannot save it as a payment method."
          : r.reason === "failed"
            ? "The payer did not complete the Mollie payment, so no mandate exists."
            : "The Mollie payment is not finished yet. Try again after the payer completes it.",
      );
    // The token is a client assertion: the mandate must belong to THIS customer.
    if (r.ref.providerCustomerId !== customerId)
      throw new ProviderRefusalError(
        "This Mollie mandate belongs to a different customer. We cannot save it here.",
      );
    return r.ref;
  }

  async fetchMandate(input: {
    providerCustomerId: string;
    token: string;
  }): Promise<ProviderMandate | null> {
    const m = await this.getMandate(input.providerCustomerId, input.token);
    return m ? (this.describeMandate(m, input.providerCustomerId).mandate ?? null) : null;
  }

  async fetchPaymentMethodDisplay(input: {
    providerPaymentMethodId: string;
    providerCustomerId?: string;
  }): Promise<ProviderPaymentMethodRef["display"] | null> {
    if (!input.providerCustomerId) return null;
    try {
      const m = await this.getMandate(input.providerCustomerId, input.providerPaymentMethodId);
      return m ? this.describeMandate(m, input.providerCustomerId).display : null;
    } catch {
      return null;
    }
  }

  async fetchVaultedPaymentMethod(input: {
    providerCustomerId: string;
    providerPaymentMethodId: string;
  }): Promise<ProviderPaymentMethodRef | null> {
    const m = await this.getMandate(input.providerCustomerId, input.providerPaymentMethodId);
    return m ? this.describeMandate(m, input.providerCustomerId) : null;
  }

  async deletePaymentMethod(input: {
    customer: ProviderCustomerRef;
    paymentMethod: ProviderPaymentMethodRef;
  }): Promise<void> {
    const c = input.paymentMethod.providerCustomerId ?? input.customer.providerCustomerId;
    const id = input.paymentMethod.providerPaymentMethodId;
    const { status, json } = await this.api(
      "mandate_revoke",
      "DELETE",
      `/customers/${encodeURIComponent(c)}/mandates/${encodeURIComponent(id)}`,
    );
    // 404 / 410: already revoked.
    if (status < 300 || status === 404 || status === 410) return;
    throw new Error(`Mollie could not revoke mandate ${id}: ${errorText(json, status)}`);
  }

  // ── intents (hosted checkout) ──────────────────────────────────────────────

  /** Mollie's answer to a refused create, as a readable refusal. */
  private refusal(what: string, e: MollieError, status: number): ProviderRefusalError {
    const detail = e.detail ?? "";
    if (/does not accept recurring payments/i.test(detail))
      return new ProviderRefusalError(
        /paypal/i.test(what)
          ? "PayPal on this Mollie account cannot take automatic payments. Ask PayPal to enable Reference Transactions on your PayPal business account, then connect PayPal in Mollie again."
          : `Mollie refused the ${what}: this payment method cannot set up automatic payments on this Mollie account.`,
      );
    if (/not enabled in your website profile/i.test(detail))
      return new ProviderRefusalError(
        `Mollie refused the ${what}: the payment method is not active on this Mollie profile. Activate it in the Mollie dashboard.`,
      );
    return new ProviderRefusalError(`Mollie refused the ${what}: ${errorText(e, status)}`);
  }

  async createIntent(input: CreateIntentInput): Promise<IntentRef> {
    const currency = input.currency.toUpperCase();
    if (input.purpose === "payment" && input.paymentMethod)
      return this.chargeIntent(input, currency);
    if (!input.returnUrl)
      throw new Error("A Mollie hosted payment needs returnUrl (the payer comes back to it)");
    const ref = input.ownershipRef ?? input.idempotencyKey;
    const requested = (input.methodTypes ?? []).filter((m) => MOLLIE_FIRST_METHODS[m]);
    let body: Record<string, unknown>;
    if (input.purpose === "setup") {
      if (input.methodTypes?.length && requested.length === 0)
        throw new ProviderRefusalError(
          `Mollie cannot set up automatic payments with ${input.methodTypes.join(", ")}. Use card, SEPA Direct Debit or PayPal.`,
        );
      // Cards and PayPal set up a mandate for 0.00. The SEPA methods (iDEAL, Bancontact, …)
      // need 0.01 EUR, which the payer pays and Mollie keeps as a normal payment.
      const wantsSepa = (requested.length ? requested : ["sepa_debit"]).includes("sepa_debit");
      const amountMinor = wantsSepa && currency === "EUR" ? 1n : 0n;
      body = {
        amount: toValue(amountMinor, currency),
        description: (input.description ?? "Set up automatic payments").slice(0, 255),
        sequenceType: "first",
        customerId: input.customer.providerCustomerId,
        // No single method: Mollie shows every method that can create the mandate.
        ...(requested.length ? { method: requested.flatMap((m) => MOLLIE_FIRST_METHODS[m]!) } : {}),
        redirectUrl: input.returnUrl,
        ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
        metadata: this.meta("setup", ref, input.idempotencyKey),
        ...this.webhookUrl,
      };
    } else {
      const amount = input.amountMinor ?? 0n;
      if (amount <= 0n) throw new Error("A Mollie payment intent needs a positive amountMinor");
      // A one-off: no customer, no mandate, every method the merchant enabled.
      body = {
        amount: toValue(amount, currency),
        description: (input.description ?? `Payment ${ref}`).slice(0, 255),
        sequenceType: "oneoff",
        redirectUrl: input.returnUrl,
        ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
        metadata: this.meta("payment", ref, input.idempotencyKey),
        ...this.webhookUrl,
      };
    }
    const what = input.purpose === "setup" ? "mandate setup" : "payment";
    const res = await this.create<MolliePayment>(
      "intent",
      "/payments",
      body,
      input.idempotencyKey,
      () => this.findPayment(input.idempotencyKey),
    );
    if (!res.ok)
      throw this.refusal(
        requested.includes("paypal") && requested.length === 1 ? "PayPal mandate setup" : what,
        res.error,
        res.status,
      );
    const p = res.resource;
    const url = p._links?.checkout?.href;
    if (!url)
      throw markStrandedObject(
        new Error(`Mollie created payment ${p.id} without a checkout URL (status ${p.status})`),
        p.id,
      );
    return {
      intentId: p.id,
      status: "requires_action",
      authorization: { mode: "redirect", approvalUrl: url },
      raw: p,
    };
  }

  /** An on-session payment on a stored mandate: a `recurring` payment, no buyer step. */
  private async chargeIntent(input: CreateIntentInput, currency: string): Promise<IntentRef> {
    const pm = input.paymentMethod!;
    const r = await this.recurringPayment({
      amountMinor: input.amountMinor ?? 0n,
      currency,
      customerId: pm.providerCustomerId ?? input.customer.providerCustomerId,
      mandateId: pm.providerPaymentMethodId,
      idempotencyKey: input.idempotencyKey,
      kind: "payment",
      ref: input.ownershipRef ?? input.idempotencyKey,
      ...(input.description ? { description: input.description } : {}),
    });
    if (r.status === "failed")
      return { intentId: r.providerChargeId, status: "inited", failure: r.failure, raw: r.raw };
    return {
      intentId: r.providerChargeId,
      status: r.status === "succeeded" ? "authorized" : "inited",
      raw: r.raw,
    };
  }

  async consumeIntent(input: ConsumeIntentInput): Promise<ConsumeIntentResult> {
    if (input.purpose === "setup") {
      const r = await this.mandateOfFirstPayment(input.intentId);
      if (r.ok) {
        this.returnCheckAmount(r.payment);
        return { purpose: "setup", paymentMethod: r.ref };
      }
      if (r.reason === "failed" && r.payment)
        return { purpose: "setup", failure: mollieFailure(r.payment) };
      if (r.reason === "not_first")
        throw new ProviderRefusalError(
          `Mollie payment ${input.intentId} did not set up automatic payments.`,
        );
      throw new Error(
        `Mollie payment ${input.intentId} is ${r.payment?.status ?? "unknown"}. The payer did not complete the payment page.`,
      );
    }
    const p = await this.read<MolliePayment>(
      "consume_intent",
      `/payments/${encodeURIComponent(input.intentId)}`,
    );
    if (!p) throw new Error(`Mollie payment ${input.intentId} does not exist`);
    // A paid payment already moved the money. An authorized one (pay-later methods) moves it
    // only when captured: "this status for as long as new captures can be created".
    if (p.status === "authorized")
      return { purpose: "payment", charge: await this.capture(p, input) };
    return { purpose: "payment", charge: molliePaymentResult(p) };
  }

  /** Capture an authorized payment (in full unless an amount is given), then read it back. */
  private async capture(p: MolliePayment, input: ConsumeIntentInput): Promise<ChargeResult> {
    const path = `/payments/${encodeURIComponent(p.id)}`;
    const res = await this.create<{ id: string }>(
      "capture",
      `${path}/captures`,
      input.amountMinor != null ? { amount: toValue(input.amountMinor, p.amount.currency) } : {},
      input.idempotencyKey,
      async () => {
        const now = await this.read<MolliePayment>("capture_lookup", path);
        return now && now.status !== "authorized" ? { id: now.id } : null;
      },
    );
    const now = (await this.read<MolliePayment>("capture_lookup", path)) ?? p;
    if (res.ok || now.status !== "authorized") return molliePaymentResult(now);
    const norm = normalizeMollieDecline({
      code: "capture_refused",
      message: res.error.detail ?? errorText(res.error, res.status),
    });
    return {
      status: "failed",
      providerChargeId: p.id,
      failure: {
        code: norm.code,
        providerCode: String(res.status),
        message: norm.message ?? errorText(res.error, res.status),
        retriable: norm.retriable,
        ...(norm.ruleId ? { ruleId: norm.ruleId } : {}),
      },
      raw: res.error,
    };
  }

  async fetchIntent(input: {
    intentId: string;
    purpose?: IntentPurpose;
    resolveOwnership?: boolean;
  }): Promise<FetchedIntent> {
    const unknown: FetchedIntent = {
      intentId: input.intentId,
      status: "unknown",
      ...(input.resolveOwnership ? { ownership: "unknown" as const } : {}),
    };
    if (!input.intentId.startsWith("tr_")) return unknown;
    let p: MolliePayment | null;
    try {
      p = await this.read<MolliePayment>(
        "fetch_intent",
        `/payments/${encodeURIComponent(input.intentId)}`,
      );
    } catch {
      return unknown;
    }
    if (!p) return unknown;
    const status: FetchedIntent["status"] =
      p.status === "paid" || p.status === "authorized"
        ? // Paid, or authorized and waiting for a capture: the engine's consume books it.
          "authorized"
        : p.status === "failed" || p.status === "expired"
          ? "failed"
          : p.status === "canceled"
            ? "voided"
            : "requires_action";
    return {
      intentId: p.id,
      status,
      providerChargeId: p.id,
      amountMinor: toMinor(p.amount),
      currency: p.amount.currency,
      ...(input.resolveOwnership
        ? {
            ...ownershipOf(p.metadata),
            ...(p.createdAt ? { providerObjectCreatedAt: new Date(p.createdAt) } : {}),
          }
        : {}),
      raw: p,
    };
  }

  // ── money ──────────────────────────────────────────────────────────────────

  private async recurringPayment(a: {
    amountMinor: bigint;
    currency: string;
    customerId: string;
    mandateId: string;
    idempotencyKey: string;
    kind: Kind;
    ref: string;
    description?: string;
  }): Promise<ChargeResult> {
    const res = await this.create<MolliePayment>(
      "charge",
      "/payments",
      {
        amount: toValue(a.amountMinor, a.currency),
        description: (a.description ?? `Payment ${a.ref}`).slice(0, 255),
        sequenceType: "recurring",
        customerId: a.customerId,
        mandateId: a.mandateId,
        metadata: this.meta(a.kind, a.ref, a.idempotencyKey),
        ...this.webhookUrl,
      },
      a.idempotencyKey,
      () => this.findPayment(a.idempotencyKey),
    );
    if (res.ok) return molliePaymentResult(res.resource);
    // A refused create: no payment exists. Classify on Mollie's sentence.
    const detail = res.error.detail ?? "";
    // Both measured: "…has no valid mandate…" and "No suitable mandates found for customer".
    const signal: DeclineSignal = /no valid mandate|no suitable mandates/i.test(detail)
      ? { code: "no_valid_mandate", message: detail }
      : /does not accept recurring payments/i.test(detail)
        ? { code: "method_not_recurring", message: detail }
        : { code: "request_rejected", message: detail };
    const norm = normalizeMollieDecline(signal);
    return {
      status: "failed",
      providerChargeId: "",
      failure: {
        code: norm.code,
        providerCode: res.error.field ? `${res.status}:${res.error.field}` : String(res.status),
        message: norm.message ?? errorText(res.error, res.status),
        retriable: norm.retriable,
        ...(norm.ruleId ? { ruleId: norm.ruleId } : {}),
      },
      raw: res.error,
    };
  }

  /**
   * An off-session debit on the mandate. Mollie has no stored-credential flag: a
   * `recurring` payment is always merchant-initiated, so `initiator` changes nothing here.
   */
  async charge(input: ChargeInput): Promise<ChargeResult> {
    return this.recurringPayment({
      amountMinor: input.amountMinor,
      currency: input.currency.toUpperCase(),
      customerId: input.paymentMethod.providerCustomerId ?? input.customer.providerCustomerId,
      mandateId: input.paymentMethod.providerPaymentMethodId,
      idempotencyKey: input.idempotencyKey,
      kind: "charge",
      ref: input.ownershipRef ?? input.idempotencyKey,
      ...(input.description ? { description: input.description } : {}),
    });
  }

  async fetchChargeStatus(input: { providerChargeId: string }): Promise<ChargeResult> {
    // An empty id would read the payment LIST, never a verdict.
    if (!input.providerChargeId.startsWith("tr_"))
      throw new Error(`Not a Mollie payment id: "${input.providerChargeId}"`);
    const p = await this.read<MolliePayment>(
      "charge_status",
      `/payments/${encodeURIComponent(input.providerChargeId)}`,
    );
    if (!p) throw new Error(`Mollie payment ${input.providerChargeId} does not exist`);
    return molliePaymentResult(p);
  }

  /**
   * A charge whose create answer was lost, by the idempotency key `meta()` stamps on it (our
   * ref is shared by every attempt on one invoice, so it only confirms the match). Pages
   * back to `createdAfter`; null = Mollie has no such payment.
   */
  async locateCharge(input: {
    ownershipRef: string;
    idempotencyKey: string;
    amountMinor: bigint;
    currency: string;
    createdAfter: Date;
  }): Promise<ChargeResult | null> {
    const key = boundedProviderKey(input.idempotencyKey, IDEMPOTENCY_KEY_MAX);
    const ref = input.ownershipRef.slice(0, 200);
    const after = input.createdAfter.getTime();
    for await (const p of this.walk<MolliePayment>(
      "charge_lookup",
      `/payments?limit=${LOOKUP_PAGE}`,
      "payments",
      (x) => !!x.createdAt && Date.parse(x.createdAt) < after,
    )) {
      if (p.metadata?.[IDEM_KEY] !== key) continue;
      const theirRef = p.metadata?.[MOLLIE_OWNERSHIP_KEY];
      if (theirRef !== undefined && theirRef !== ref) continue;
      if (toMinor(p.amount) !== input.amountMinor) continue;
      return molliePaymentResult(p);
    }
    return null;
  }

  /** Cancel a payment Mollie still reports `isCancelable`. The verdict is read back. */
  async cancelPendingCharge(input: CancelPendingChargeInput): Promise<CancelPendingChargeResult> {
    const path = `/payments/${encodeURIComponent(input.providerChargeId)}`;
    const res = await this.api<MolliePayment>(
      "cancel_charge",
      "DELETE",
      path,
      undefined,
      input.idempotencyKey,
    );
    const p = res.status < 300 ? res.json : await this.read<MolliePayment>("cancel_charge", path);
    if (!p) return { status: "not_cancelable", reason: "Mollie has no such payment." };
    if (p.status === "canceled") return { status: "cancelled", raw: p };
    const reason = res.status >= 300 ? errorText(res.json, res.status) : undefined;
    const now = molliePaymentResult(p);
    if (now.status !== "pending")
      return { status: "already_final", charge: now, ...(reason ? { reason } : {}), raw: p };
    return { status: "not_cancelable", reason: reason ?? `Mollie payment ${p.status}`, raw: p };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const p = await this.read<MolliePayment>(
      "refund_payment",
      `/payments/${encodeURIComponent(input.providerChargeId)}`,
    );
    if (!p)
      throw new ProviderRefusalError(`Mollie payment ${input.providerChargeId} does not exist.`);
    const currency = p.amount.currency;
    // Mollie needs the amount even for a full refund: the part still refundable.
    const amount = input.amountMinor ?? toMinor(p.amountRemaining);
    if (amount <= 0n)
      throw new ProviderRefusalError("Nothing is left to refund on this Mollie payment.");
    const res = await this.create<MollieRefund>(
      "refund",
      `/payments/${encodeURIComponent(p.id)}/refunds`,
      {
        amount: toValue(amount, currency),
        ...(input.reason ? { description: input.reason.slice(0, 140) } : {}),
        metadata: {
          [IDEM_KEY]: boundedProviderKey(input.idempotencyKey, IDEMPOTENCY_KEY_MAX),
          [MOLLIE_OWNERSHIP_KEY]: (input.ownershipRef ?? input.idempotencyKey).slice(0, 200),
        },
      },
      input.idempotencyKey,
      () => this.findRefund(p.id, input.idempotencyKey),
    );
    if (!res.ok)
      throw new ProviderRefusalError(
        `Mollie refused the refund: ${errorText(res.error, res.status)}`,
      );
    return {
      status: mollieRefundStatus(res.resource.status),
      providerRefundId: mollieRefundRef(res.resource.id, p.id),
      raw: res.resource,
    };
  }

  /** A refund we created on this payment under this idempotency key, if Mollie has one. */
  private async findRefund(
    paymentId: string,
    idempotencyKey: string,
  ): Promise<MollieRefund | null> {
    const want = boundedProviderKey(idempotencyKey, IDEMPOTENCY_KEY_MAX);
    const list = await this.read<MollieList<MollieRefund>>(
      "refund_lookup",
      `/payments/${encodeURIComponent(paymentId)}/refunds?limit=250`,
    );
    return list?._embedded?.refunds?.find((r) => r.metadata?.[IDEM_KEY] === want) ?? null;
  }

  async fetchRefundStatus(input: { providerRefundId: string }): Promise<RefundResult> {
    const ref = parseRefundRef(input.providerRefundId);
    if (!ref) throw new Error(`Not a Mollie refund reference: ${input.providerRefundId}`);
    const r = await this.read<MollieRefund>(
      "refund_status",
      `/payments/${encodeURIComponent(ref.paymentId)}/refunds/${encodeURIComponent(ref.refundId)}`,
    );
    if (!r) throw new Error(`Mollie refund ${ref.refundId} does not exist`);
    return {
      status: mollieRefundStatus(r.status),
      providerRefundId: input.providerRefundId,
      raw: r,
    };
  }

  /**
   * The webhook catch-up, run by the settlement-report poll. Reads refunds and chargebacks
   * account-wide (newest first, payment embedded) and maps each exactly as a webhook would,
   * so the event ids match and dedupe makes every re-read safe:
   *  - refunds created in the window or up to {@link MOLLIE_REFUND_LOOKBACK_MS} before it;
   *  - chargebacks created or reversed in the window (a reversal has no classic webhook).
   * Only payments carrying our ref: other objects on the account are not ours to record.
   */
  async pollSettlements(input: { since: Date; until: Date }): Promise<NormalizedProviderEvent[]> {
    const since = input.since.getTime();
    const until = input.until.getTime();
    const ts = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
    const out: NormalizedProviderEvent[] = [];
    const paymentOf = async (x: {
      paymentId?: string;
      _embedded?: { payment?: MolliePayment };
    }) => {
      const p =
        x._embedded?.payment ??
        (x.paymentId
          ? await this.read<MolliePayment>(
              "settlement_payment",
              `/payments/${encodeURIComponent(x.paymentId)}`,
            )
          : null);
      return p && ownershipOf(p.metadata).ownership === "ours" ? p : null;
    };

    const refundFloor = since - MOLLIE_REFUND_LOOKBACK_MS;
    for await (const r of this.walk<MollieRefund>(
      "settlement_refunds",
      `/refunds?limit=250&embed=payment`,
      "refunds",
      (x) => ts(x.createdAt) < refundFloor,
    )) {
      if (ts(r.createdAt) > until) continue;
      const p = await paymentOf(r);
      if (p) out.push(...mapMolliePayment(p, [r], []).filter((e) => e.providerRefundId));
    }

    const chargebackFloor = since - MOLLIE_CHARGEBACK_LOOKBACK_MS;
    for await (const c of this.walk<MollieChargeback>(
      "settlement_chargebacks",
      `/chargebacks?limit=250&embed=payment`,
      "chargebacks",
      (x) => ts(x.createdAt) < chargebackFloor,
    )) {
      const created = ts(c.createdAt);
      const reversed = ts(c.reversedAt);
      const inWindow = (t: number) => t >= since && t <= until;
      if (!inWindow(created) && !inWindow(reversed)) continue;
      const p = await paymentOf(c);
      if (p) out.push(...mapMolliePayment(p, [], [c]).filter((e) => e.providerDisputeId));
    }
    return out;
  }

  // ── webhooks ───────────────────────────────────────────────────────────────

  /** The object id a delivery names: `id=` on a classic call, `entityId` on a next-gen event. */
  static deliveredId(payload: string | Buffer): {
    id?: string;
    paymentHint?: string;
    nextGen: boolean;
  } {
    const text = payload.toString().trim();
    if (text.startsWith("{")) {
      try {
        const j = JSON.parse(text) as {
          id?: string;
          entityId?: string;
          _embedded?: { entity?: { id?: string; paymentId?: string } };
        };
        const id = j.entityId ?? j._embedded?.entity?.id;
        return {
          ...(id ? { id } : {}),
          ...(j._embedded?.entity?.paymentId ? { paymentHint: j._embedded.entity.paymentId } : {}),
          nextGen: true,
        };
      } catch {
        return { nextGen: true };
      }
    }
    const id = new URLSearchParams(text).get("id") ?? undefined;
    return { ...(id ? { id } : {}), nextGen: false };
  }

  /**
   * A classic delivery is the same body for every status change of one payment, so this id
   * only names the payment; each normalized event carries its own state-derived id.
   */
  webhookEventId(input: NormalizeWebhookInput): string {
    const text = input.payload.toString().trim();
    if (text.startsWith("{")) {
      try {
        const j = JSON.parse(text) as { id?: unknown };
        return webhookEventId([j.id], input.payload);
      } catch {
        return webhookEventId([], input.payload);
      }
    }
    const { id } = MollieProvider.deliveredId(input.payload);
    return webhookEventId([id ? `mollie:${id}` : undefined], input.payload);
  }

  /**
   * Fetch the named payment and translate its CURRENT state. A delivery is never trusted:
   * an id Mollie does not know under our key yields no events.
   */
  async normalizeWebhook(input: NormalizeWebhookInput): Promise<NormalizedProviderEvent[]> {
    const d = MollieProvider.deliveredId(input.payload);
    if (d.nextGen && this.cfg.webhookSecret) {
      const sig = headerValue(input.headers, "x-mollie-signature");
      if (!verifyMollieSignature(input.payload, sig, this.cfg.webhookSecret))
        throw new Error("Invalid Mollie webhook signature");
    }
    const paymentId = d.id?.startsWith("tr_")
      ? d.id
      : d.id?.startsWith("re_") || d.id?.startsWith("chb_")
        ? d.paymentHint
        : undefined;
    // Not a payment (an order, a payment link, a settlement): nothing we book.
    if (!paymentId?.startsWith("tr_")) return [];
    return this.paymentEvents(paymentId);
  }

  /** Every fact about one payment, each with an id stable across redeliveries. */
  async paymentEvents(paymentId: string): Promise<NormalizedProviderEvent[]> {
    const p = await this.read<MolliePayment>(
      "webhook_payment",
      `/payments/${encodeURIComponent(paymentId)}`,
    );
    if (!p) return [];
    const settledOnce = Boolean(p.paidAt) || p.status === "paid";
    const [refunds, chargebacks] = settledOnce
      ? await Promise.all([
          this.read<{ _embedded?: { refunds?: MollieRefund[] } }>(
            "webhook_refunds",
            `/payments/${encodeURIComponent(p.id)}/refunds?limit=250`,
          ),
          this.read<{ _embedded?: { chargebacks?: MollieChargeback[] } }>(
            "webhook_chargebacks",
            `/payments/${encodeURIComponent(p.id)}/chargebacks?limit=250`,
          ),
        ])
      : [null, null];
    return mapMolliePayment(
      p,
      refunds?._embedded?.refunds ?? [],
      chargebacks?._embedded?.chargebacks ?? [],
    );
  }
}

/** Pure: a fetched payment (+ its refunds and chargebacks) → normalized events. */
export function mapMolliePayment(
  p: MolliePayment,
  refunds: MollieRefund[],
  chargebacks: MollieChargeback[],
): NormalizedProviderEvent[] {
  const kind = kindOf(p);
  const base = {
    raw: p,
    ...ownershipOf(p.metadata),
    ...(p.createdAt ? { providerObjectCreatedAt: new Date(p.createdAt) } : {}),
  };
  const at = (s: string | null | undefined) => (s ? new Date(s) : new Date());
  const out: NormalizedProviderEvent[] = [];
  const st = p.status ?? "";
  const dead = st === "failed" || st === "canceled" || st === "expired";

  if (kind === "setup") {
    if (st === "paid")
      out.push({
        ...base,
        providerEventId: `${p.id}:paid`,
        type: "intent.setup_succeeded",
        providerIntentId: p.id,
        ...(p.mandateId ? { providerPaymentMethodId: p.mandateId } : {}),
        occurredAt: at(p.paidAt),
      });
    else if (dead) {
      const f = mollieFailure(p);
      out.push({
        ...base,
        providerEventId: `${p.id}:${st}`,
        type: "intent.setup_failed",
        providerIntentId: p.id,
        failureCode: f.code,
        providerFailureCode: f.providerCode!,
        failureMessage: f.message,
        failureRetriable: true,
        occurredAt: at(p.failedAt),
      });
    }
  } else if (kind === "payment" && !(dead && p.paidAt)) {
    // A hosted one-off (or an on-session debit): paid = ready to book through the intent;
    // authorized (pay-later) = ready to capture, which the intent's consume does.
    if (st === "authorized")
      out.push({
        ...base,
        providerEventId: `${p.id}:authorized`,
        type: "intent.authorized",
        providerIntentId: p.id,
        providerChargeId: p.id,
        occurredAt: at(p.authorizedAt),
      });
    else if (st === "paid") {
      out.push({
        ...base,
        providerEventId: `${p.id}:paid`,
        type: "intent.authorized",
        providerIntentId: p.id,
        providerChargeId: p.id,
        occurredAt: at(p.paidAt),
      });
      // Captured after an authorization: our consume booked the capture `pending`, and only
      // this settles it (the intent is consumed, so the event above is ignored then).
      if (p.authorizedAt)
        out.push({
          ...base,
          providerEventId: `${p.id}:captured`,
          type: "charge.succeeded",
          providerChargeId: p.id,
          capturedAmountMinor: toMinor(p.amountCaptured ?? p.amount),
          occurredAt: at(p.paidAt),
        });
    } else if (dead) {
      const f = mollieFailure(p);
      out.push({
        ...base,
        providerEventId: `${p.id}:${st}`,
        type: "intent.failed",
        providerIntentId: p.id,
        failureCode: f.code,
        providerFailureCode: f.providerCode!,
        failureMessage: f.message,
        failureRetriable: f.retriable,
        occurredAt: at(p.failedAt),
      });
    }
  } else {
    // A renewal, or any payment that failed after it was paid.
    const charge = { ...base, providerChargeId: p.id };
    if (st === "paid")
      out.push({
        ...charge,
        providerEventId: `${p.id}:paid`,
        type: "charge.succeeded",
        // Read back from the payment: a paid payment collected its whole `amount`.
        ...(p.amount?.value ? { capturedAmountMinor: toMinor(p.amount) } : {}),
        occurredAt: at(p.paidAt),
      });
    else if (st === "open" || st === "pending")
      out.push({
        ...charge,
        providerEventId: `${p.id}:pending`,
        type: "charge.pending",
        occurredAt: at(p.createdAt),
      });
    else if (dead) {
      const f = mollieFailure(p);
      // A SEPA debit can fail days after `paid`. Flag every debit failure as a reversal:
      // the engine treats it as one only if it had booked the payment.
      const reversal = p.method === "directdebit" || Boolean(p.paidAt);
      out.push({
        ...charge,
        providerEventId: `${p.id}:${st}`,
        type: "charge.failed",
        failureCode: f.code,
        providerFailureCode: f.providerCode!,
        failureMessage: f.message,
        failureRetriable: f.retriable,
        lateReversal: reversal,
        occurredAt: at(p.failedAt),
      });
    }
  }

  // A setup's check amount was never booked, so neither is its refund.
  for (const r of kind === "setup" ? [] : refunds) {
    const status = mollieRefundStatus(r.status);
    const providerRefundId = mollieRefundRef(r.id, p.id);
    const refundRef = r.metadata?.[MOLLIE_OWNERSHIP_KEY];
    // This refund's own amount: the payment's `amountRefunded` is a running total that also
    // counts refunds still pending.
    const record: ProviderRefundRecord = {
      providerRefundId,
      amountMinor: toMinor(r.amount),
      status,
      ...(typeof refundRef === "string" && refundRef ? { ownershipRef: refundRef } : {}),
    };
    const ev = {
      ...base,
      raw: r,
      providerChargeId: p.id,
      providerRefundId,
      refunds: [record],
      occurredAt: at(r.createdAt),
    };
    if (status === "succeeded")
      out.push({
        ...ev,
        providerEventId: `${r.id}:refunded`,
        type: "charge.refunded",
      });
    else if (status === "failed")
      out.push({ ...ev, providerEventId: `${r.id}:${r.status}`, type: "refund.failed" });
    else out.push({ ...ev, providerEventId: `${r.id}:pending`, type: "refund.pending" });
  }

  for (const c of chargebacks) {
    const dispute = {
      ...base,
      raw: c,
      providerChargeId: p.id,
      providerDisputeId: c.id,
      disputeReason: c.reason?.code ?? null,
      disputeAmountMinor: toMinor(c.amount),
      disputeCurrency: c.amount.currency,
      occurredAt: at(c.createdAt),
    };
    // A chargeback takes the money at once: opened and withdrawn together.
    out.push(
      {
        ...dispute,
        providerEventId: `${c.id}:created`,
        type: "dispute.created",
        disputeStatus: "charged_back",
      },
      {
        ...dispute,
        providerEventId: `${c.id}:funds_withdrawn`,
        type: "dispute.funds_withdrawn",
        disputeStatus: "charged_back",
      },
    );
    if (c.reversedAt)
      out.push({
        ...dispute,
        providerEventId: `${c.id}:reversed`,
        type: "dispute.funds_reinstated",
        disputeStatus: "reversed",
        occurredAt: at(c.reversedAt),
      });
  }
  return out;
}
