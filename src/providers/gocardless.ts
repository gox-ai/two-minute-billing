/**
 * GoCardless adapter: bank Direct Debit (Bacs, SEPA, ACH, BECS, BECS NZ, PAD, Autogiro,
 * Betalingsservice) and PayTo, all on one mandate path.
 *
 * Plain HTTP against the Pro API. The engine owns WHEN to charge: every charge is one
 * Payment against the mandate, never a GoCardless subscription, and gateway-side retries
 * (Success+) stay off so dunning is ours alone.
 *
 * Settlement is asynchronous. `charge()` answers `pending`; the verdict arrives as a
 * `payments` event. `confirmed` is collected money (charge.succeeded). A later `failed`
 * on the same payment is a LATE FAILURE and is flagged as a reversal, so the engine's
 * late-failure path reopens the invoice. `charged_back` is a dispute with funds withdrawn.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  ChargeInput,
  ChargeResult,
  ConsumeIntentInput,
  ConsumeIntentResult,
  CreateIntentInput,
  EnsureCustomerInput,
  InitiateVaultSetupInput,
  IntentRef,
  NormalizeWebhookInput,
  NormalizedProviderEvent,
  PaymentProvider,
  ProviderCapabilities,
  ProviderCustomerRef,
  ProviderPaymentMethodRef,
  RefundInput,
  RefundResult,
  VaultPaymentMethodInput,
  VaultSetupRef,
} from "./types";
import { markStrandedObject, ProviderIndeterminateError, ProviderRefusalError } from "./types";
import type { CancelPendingChargeInput, CancelPendingChargeResult } from "./types";
import { boundedProviderKey, providerFetch } from "./http";
import { normalizeGocardlessDecline } from "./decline-codes";
import { headerValue, webhookEventId } from "./webhook-event-id";
import { createLogger } from "@/platform/logger";
import { isGeoLoaded, subdivisionsFor } from "@/platform/geo";

const log = createLogger("gocardless");

export const GOCARDLESS_API_VERSION = "2015-07-06";
export const GOCARDLESS_SANDBOX_BASE = "https://api-sandbox.gocardless.com";
export const GOCARDLESS_LIVE_BASE = "https://api.gocardless.com";
/** Metadata key carrying our `ownershipRef` (#31). GoCardless allows 3 keys per object. */
export const GOCARDLESS_OWNERSHIP_KEY = "tmbilling_ref";
const IDEMPOTENCY_KEY_MAX = 128;
const METADATA_VALUE_MAX = 500;
/** Longest we wait for `ratelimit-reset` before one retry. GoCardless counts per minute. */
const RATE_LIMIT_MAX_WAIT_MS = 60_000;
/** Events mapped at once from one delivery: GoCardless waits 10 s for the answer. */
const WEBHOOK_MAP_CONCURRENCY = 8;
/**
 * How far past `createdAfter` a lost charge is looked for. `createdAfter` is the attempt
 * less 10 min of clock skew, and a create is answered or abandoned within seconds (one
 * retry). One hour covers both with room, and keeps a later attempt on the same invoice
 * out of the match.
 */
const LOCATE_WINDOW_MS = 3_600_000;
/** Pages of 500 (the documented maximum) the lookup reads before it gives up. */
const LOCATE_MAX_PAGES = 20;

/**
 * Our method type → the GoCardless scheme and the one currency it settles in. Order
 * matters: with no method asked for, the first one in the currency is set up (AUD → BECS).
 */
export const GOCARDLESS_METHOD_SCHEMES: Readonly<
  Record<string, { scheme: string; currency: string }>
> = {
  bacs_debit: { scheme: "bacs", currency: "GBP" },
  sepa_debit: { scheme: "sepa_core", currency: "EUR" },
  us_bank_account: { scheme: "ach", currency: "USD" },
  au_becs_debit: { scheme: "becs", currency: "AUD" },
  nz_becs_debit: { scheme: "becs_nz", currency: "NZD" },
  acss_debit: { scheme: "pad", currency: "CAD" },
  autogiro: { scheme: "autogiro", currency: "SEK" },
  betalingsservice: { scheme: "betalingsservice", currency: "DKK" },
  payto: { scheme: "pay_to", currency: "AUD" },
};

/** A mandate's scheme → our method type. Unlisted schemes are not offered. */
const SCHEME_METHOD: Readonly<Record<string, ProviderPaymentMethodRef["display"]["type"]>> = {
  bacs: "bacs_debit",
  sepa_core: "sepa_debit",
  sepa_cor1: "sepa_debit",
  ach: "us_bank_account",
  becs: "au_becs_debit",
  becs_nz: "nz_becs_debit",
  pad: "acss_debit",
  autogiro: "autogiro",
  betalingsservice: "betalingsservice",
  pay_to: "payto",
};

/**
 * PayTo purpose codes a mandate may carry; GoCardless requires one on every PayTo
 * agreement (https://docs.gocardless.com/docs/collect-payments/recurring-payments/payto,
 * read 2026-10-28).
 */
export const GOCARDLESS_PAYTO_PURPOSE_CODES = [
  "mortgage",
  "utility",
  "loan",
  "dependant_support",
  "gambling",
  "retail",
  "salary",
  "personal",
  "government",
  "pension",
  "tax",
  "other",
] as const;
const PAYTO_DEFAULT_PURPOSE = "retail";
/** What the payer's bank app shows for the agreement when the caller sent no description. */
const PAYTO_DEFAULT_DESCRIPTION = "Subscription payments";

/**
 * GoCardless mandate status → the engine's normalised mandate vocabulary
 * (`payment-methods/mandate-afa.ts`). There is no `replaced` status: a replaced mandate
 * reads `cancelled`, and its event re-points the method (`mapMandateEvent`).
 */
export function normalizeGocardlessMandateStatus(status: string | undefined): string | undefined {
  switch (status) {
    case "active":
      return "active";
    case "pending_customer_approval":
    case "pending_submission":
    case "submitted":
      return "initiated";
    case "failed":
      return "rejected";
    case "cancelled":
    case "expired":
    case "blocked":
      return "cancelled";
    case "suspended_by_payer":
      return "paused";
    case "consumed":
      return "spent";
    default:
      return undefined;
  }
}

/**
 * Mandate event action → the status it puts the mandate in. The event is the source of
 * truth: GoCardless's API can trail its webhooks by minutes, so a read could undo it.
 */
const MANDATE_ACTION_STATUS: Readonly<Record<string, string>> = {
  created: "pending_submission",
  customer_approval_granted: "pending_submission",
  customer_approval_skipped: "pending_submission",
  submitted: "submitted",
  resubmission_requested: "pending_submission",
  reinstated: "active",
  transferred: "active",
  active: "active",
  failed: "failed",
  cancelled: "cancelled",
  expired: "expired",
  blocked: "blocked",
  suspended_by_payer: "suspended_by_payer",
  consumed: "consumed",
};

/**
 * A payment's `scheme` → our method type (`ChargeResult.methodUsed`). The same map as
 * `SCHEME_METHOD`: every payment scheme GoCardless debits a mandate on is offered.
 * https://developer.gocardless.com/api-reference/#core-endpoints-payments ("scheme").
 */
const SCHEME_METHOD_USED: Readonly<Record<string, string>> = SCHEME_METHOD;

/**
 * The engine's `DEBIT_CANCELLED_CODE`. Only `cancelled` with cause `payment_cancelled` ("This
 * payment was cancelled at your request", https://docs.gocardless.com/docs/api-reference/events/payment,
 * read 2026-10-28): the merchant stopped it and no money moved. Mandate and bank causes stay
 * declines.
 */
export const GOCARDLESS_CANCELLED_CODE = "debit_cancelled";
const CANCELLED_MESSAGE =
  "The payment was cancelled at GoCardless before the bank collected it. No money moved.";

function cancelledAtRequest(status: string | undefined, cause: string | undefined): boolean {
  return status === "cancelled" && cause === "payment_cancelled";
}

/** Map a payment's status onto a ChargeResult. `charged_back` collected first, so it succeeded. */
export function gocardlessPaymentResult(
  payment: { id: string; status?: string; scheme?: string | null },
  cause?: { cause?: string; description?: string },
  raw?: unknown,
): ChargeResult {
  const m = payment.scheme ? SCHEME_METHOD_USED[payment.scheme] : undefined;
  const used = m ? { methodUsed: m } : {};
  switch (payment.status) {
    case "confirmed":
    case "paid_out":
    case "charged_back":
      return { status: "succeeded", providerChargeId: payment.id, ...used, raw };
    case "failed":
    case "cancelled":
    case "customer_approval_denied": {
      const code = cause?.cause ?? payment.status;
      if (cancelledAtRequest(payment.status, cause?.cause))
        return {
          status: "failed",
          providerChargeId: payment.id,
          failure: {
            code: GOCARDLESS_CANCELLED_CODE,
            providerCode: code,
            message: CANCELLED_MESSAGE,
            retriable: false,
          },
          ...used,
          raw,
        };
      const norm = normalizeGocardlessDecline(code);
      return {
        status: "failed",
        providerChargeId: payment.id,
        failure: {
          code: norm.code,
          providerCode: code,
          message: norm.message ?? cause?.description ?? `GoCardless payment ${payment.status}`,
          retriable: norm.retriable,
          ...(norm.ruleId ? { ruleId: norm.ruleId } : {}),
        },
        ...used,
        raw,
      };
    }
    default:
      // pending_customer_approval, pending_submission, submitted: the bank has not answered.
      return { status: "pending", providerChargeId: payment.id, ...used, raw };
  }
}

/** Refund status → RefundResult status. */
export function gocardlessRefundStatus(status: string | undefined): RefundResult["status"] {
  if (status === "paid") return "succeeded";
  if (status === "cancelled" || status === "bounced" || status === "funds_returned")
    return "failed";
  return "pending";
}

/** Hex HMAC-SHA256 of the raw body, compared in constant time. */
export function verifyGocardlessSignature(
  rawBody: string | Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const want = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(want, "utf8");
  const b = Buffer.from(signature.trim(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

interface GcError {
  type?: string;
  code?: number;
  message?: string;
  errors?: Array<{
    reason?: string;
    message?: string;
    field?: string;
    links?: { conflicting_resource_id?: string; new_mandate?: string };
    metadata?: Record<string, unknown>;
  }>;
  links?: { conflicting_resource_id?: string; new_mandate?: string };
  metadata?: Record<string, unknown>;
}

interface GcEvent {
  id: string;
  created_at?: string;
  action?: string;
  resource_type?: string;
  links?: Record<string, string | undefined>;
  details?: {
    origin?: string;
    cause?: string;
    description?: string;
    scheme?: string;
    reason_code?: string;
    will_attempt_retry?: boolean;
  };
  resource_metadata?: Record<string, unknown> | null;
}

interface GcMandate {
  id: string;
  status?: string;
  scheme?: string;
  reference?: string;
  /** The earliest `charge_date` a payment created now can take (`YYYY-MM-DD`). */
  next_possible_charge_date?: string | null;
  /** ACH only: the earliest `charge_date` for standard (not Faster) ACH. */
  next_possible_standard_ach_charge_date?: string | null;
  /** PayTo only: the limits the payer approved in their bank app. */
  consent_parameters?: { max_amount_per_payment?: number | null; currency?: string } | null;
  links?: { customer?: string; customer_bank_account?: string; new_mandate?: string };
}

/**
 * The scheduling fields for an invoice debit: `charge_date` = the due day when the mandate
 * can be debited by then, else none (as soon as possible). A dated ACH payment is standard
 * ACH, so it is judged against that date and asks for standard ACH explicitly.
 */
export function gocardlessChargeDate(
  dueDay: string | undefined,
  mandate:
    | Pick<
        GcMandate,
        "scheme" | "next_possible_charge_date" | "next_possible_standard_ach_charge_date"
      >
    | undefined,
): { charge_date: string; faster_ach?: false } | undefined {
  if (!dueDay || !mandate) return undefined;
  const standardAch =
    mandate.scheme === "ach"
      ? (mandate.next_possible_standard_ach_charge_date ?? undefined)
      : undefined;
  const earliest = standardAch ?? mandate.next_possible_charge_date ?? undefined;
  if (!earliest || dueDay < earliest) return undefined;
  return standardAch ? { charge_date: dueDay, faster_ach: false } : { charge_date: dueDay };
}

/** A US `region` must be a 2-letter state code; anything unresolvable is left out. */
export function gocardlessRegion(state: string, country: string | undefined): string | undefined {
  const s = state.trim();
  if (!s) return undefined;
  if (country?.toUpperCase() !== "US") return s;
  const bare = s.replace(/^US-/i, "");
  if (/^[A-Za-z]{2}$/.test(bare)) return bare.toUpperCase();
  if (!isGeoLoaded()) return undefined;
  const hit = subdivisionsFor("US")?.find((x) => x.label.toLowerCase() === bare.toLowerCase());
  return hit ? hit.value.replace(/^US-/i, "") : undefined;
}

/** Map `items` with at most `limit` in flight, keeping their order. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface GoCardlessConfig {
  accessToken: string;
  webhookSecret?: string;
  /** Picks the live or sandbox host; `apiBase` overrides it (tests). */
  livemode: boolean;
  apiBase?: string;
  /** Replaces the rate-limit wait (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** PayTo `purpose_code` (default `retail`). */
  paytoPurposeCode?: string;
}

const firstReason = (err: GcError | undefined): string | undefined =>
  err?.errors?.find((e) => e.reason)?.reason;

const errorMetadata = (err: GcError | undefined, key: string): unknown =>
  err?.metadata?.[key] ?? err?.errors?.find((e) => e.metadata?.[key] != null)?.metadata?.[key];

/** A create refused over its `charge_date` / `faster_ach` (a validation error on them). */
const dateRefused = (err: GcError | undefined): boolean =>
  !!err?.errors?.some((e) => /^(charge_date|faster_ach)$/.test(e.field ?? ""));

const conflictingId = (err: GcError | undefined): string | undefined =>
  err?.links?.conflicting_resource_id ??
  err?.errors?.find((e) => e.links?.conflicting_resource_id)?.links?.conflicting_resource_id;

const errorText = (err: GcError | undefined, status: number): string => {
  const detail = err?.errors
    ?.map((e) => [e.field, e.message].filter(Boolean).join(" "))
    .filter(Boolean)
    .join("; ");
  return `${err?.message ?? `HTTP ${status}`}${detail ? ` (${detail})` : ""}`;
};

/** `ours` iff our tag is on the resource; `foreign` iff GoCardless sent metadata without it. */
function ownershipOf(
  meta: Record<string, unknown> | null | undefined,
): Pick<NormalizedProviderEvent, "ownership" | "ownershipRef"> {
  if (!meta || typeof meta !== "object") return { ownership: "unknown" };
  const ref = meta[GOCARDLESS_OWNERSHIP_KEY];
  return typeof ref === "string" && ref
    ? { ownership: "ours", ownershipRef: ref }
    : { ownership: "foreign" };
}

const tag = (ref: string | undefined): Record<string, string> =>
  ref ? { [GOCARDLESS_OWNERSHIP_KEY]: ref.slice(0, METADATA_VALUE_MAX) } : {};

/** The operator's sentence for a refund GoCardless refused. */
export function gocardlessRefundRefusal(
  res: { status: number; error?: GcError },
  currency: string | undefined,
): string {
  const no = "We could not refund this payment.";
  const reason = firstReason(res.error);
  if (res.status === 429)
    return `${no} GoCardless limits the number of requests, and we did not send the refund. Try again in 1 minute.`;
  if (reason === "available_refund_amount_insufficient") {
    const avail = Number(errorMetadata(res.error, "available_refund_amount"));
    const cur = currency?.toUpperCase() ?? "";
    return Number.isFinite(avail)
      ? `${no} Your GoCardless balance for ${cur} refunds is ${(avail / 100).toFixed(2)} ${cur}, which is less than the refund. Try again when your balance is sufficient.`
      : `${no} Your GoCardless balance for ${cur} refunds is less than the refund. Try again when your balance is sufficient.`;
  }
  // The 7-day safer refund period comes back as 422 `feature_disabled` with the days left.
  const days = Number(errorMetadata(res.error, "no_of_days_until_refund_possible"));
  if (reason === "feature_disabled" && Number.isFinite(days) && days > 0)
    return `${no} GoCardless refunds a payment only 7 days after its charge date. You can refund it in ${days} ${days === 1 ? "day" : "days"}. To remove this wait, contact GoCardless support.`;
  if (res.status === 403 || reason === "forbidden" || reason === "feature_disabled")
    return `${no} Refunds are not enabled on this GoCardless account. Enable refunds in the GoCardless Dashboard, or contact GoCardless support.`;
  if (reason === "refund_payment_invalid_state")
    return `${no} GoCardless refunds a payment only after it is confirmed.`;
  if (reason === "number_of_refunds_exceeded")
    return `${no} GoCardless allows a maximum of 5 refunds on one payment.`;
  return `${no} GoCardless refused it: ${errorText(res.error, res.status)}`;
}

export class GoCardlessProvider implements PaymentProvider {
  readonly key = "gocardless" as const;
  readonly capabilities: ProviderCapabilities;

  private readonly base: string;
  private readonly purposeCode: string;

  constructor(private readonly cfg: GoCardlessConfig) {
    this.base = (
      cfg.apiBase ?? (cfg.livemode ? GOCARDLESS_LIVE_BASE : GOCARDLESS_SANDBOX_BASE)
    ).replace(/\/$/, "");
    const purpose = cfg.paytoPurposeCode?.trim().toLowerCase() || PAYTO_DEFAULT_PURPOSE;
    if (!(GOCARDLESS_PAYTO_PURPOSE_CODES as readonly string[]).includes(purpose))
      throw new Error(
        `The PayTo purpose code "${cfg.paytoPurposeCode}" is not valid. Use one of: ${GOCARDLESS_PAYTO_PURPOSE_CODES.join(", ")}.`,
      );
    this.purposeCode = purpose;
    const methods = Object.keys(GOCARDLESS_METHOD_SCHEMES) as ProviderCapabilities["methods"];
    this.capabilities = {
      refunds: true,
      partialRefunds: true,
      // A scheme debits in its own currency only.
      mandateCurrencyAuthoritative: methods,
      currencies: [...new Set(Object.values(GOCARDLESS_METHOD_SCHEMES).map((s) => s.currency))],
      methods,
      // Setup only: a Billing Request is a mandate authorisation, never a hold on money.
      intents: true,
      intentPurposes: ["setup"],
      intentVoid: false,
      /**
       * No per-debit ceiling on the Direct Debit schemes. It also keeps collection from
       * refusing a debit on a mandate that is still `initiated`: GoCardless accepts a
       * payment on a pending mandate and collects it once the bank has set it up. A PayTo
       * mandate reports its ceiling (`describeMandate`), and the engine's ceiling check
       * reads the stored value whatever this flag says.
       */
      mandates: false,
      // GoCardless sends each Direct Debit scheme's advance notice itself; ours would be a
      // second one. PayTo has no advance notice, so our own reminder goes.
      gatewayNotifiesPayer: methods.filter((m) => m !== "payto"),
      // The events list is a webhook backstop, read on the settlement-report clock.
      settlementReport: { intervalMinutes: 60, maxWindowHours: 24 },
      // `POST /payments/{id}/actions/cancel`, while the payment is `pending_submission`.
      pendingDebitCancel: true,
    };
  }

  // ── transport ──────────────────────────────────────────────────────────────

  private async api<T>(
    operation: string,
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ status: number; headers?: Headers; json: T & { error?: GcError } }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.accessToken}`,
      "GoCardless-Version": GOCARDLESS_API_VERSION,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey)
      headers["Idempotency-Key"] = boundedProviderKey(idempotencyKey, IDEMPOTENCY_KEY_MAX);
    for (let attempt = 1; ; attempt++) {
      const res = await providerFetch({
        gatewayKey: this.key,
        operation,
        method,
        url: `${this.base}${path}`,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      // A read is safe to repeat; a create's 429 is handled by `create`.
      if (
        res.status === 429 &&
        method === "GET" &&
        attempt < 2 &&
        (await this.rateLimitWait(res.headers))
      )
        continue;
      let json: unknown = {};
      try {
        json = res.text ? JSON.parse(res.text) : {};
      } catch {
        json = { error: { message: res.text.slice(0, 200) } };
      }
      return { status: res.status, headers: res.headers, json: json as T & { error?: GcError } };
    }
  }

  /** Wait until `ratelimit-reset`. False when that is further away than we wait. */
  private async rateLimitWait(headers: Headers | undefined): Promise<boolean> {
    const reset = Date.parse(headers?.get("ratelimit-reset") ?? "");
    const ms = Number.isFinite(reset) ? Math.max(reset - Date.now(), 1000) : 1000;
    if (ms > RATE_LIMIT_MAX_WAIT_MS) return false;
    await (this.cfg.sleep ?? ((t: number) => new Promise((r) => setTimeout(r, t))))(ms);
    return true;
  }

  /** GET that throws on any non-2xx: for reads the caller cannot continue without. */
  private async read<T>(operation: string, path: string): Promise<T> {
    const { status, json } = await this.api<T>(operation, "GET", path);
    if (status >= 300)
      throw new Error(`GoCardless ${operation} ${path} failed: ${errorText(json.error, status)}`);
    return json;
  }

  /**
   * Create a resource under an idempotency key. A repeat of the key answers 409
   * `idempotent_creation_conflict`; the earlier resource is then read and returned as if
   * this call had made it. A transport failure or a 5xx is retried once under the same key,
   * which either creates the resource or finds the first one. A 429 created nothing: we
   * wait for `ratelimit-reset` and retry once, then answer a definite refusal — unless an
   * earlier attempt's outcome is unknown.
   */
  private async create<T extends { id: string }>(
    operation: string,
    collection: string,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<{ ok: true; resource: T } | { ok: false; status: number; error?: GcError }> {
    let uncertain = false;
    for (let attempt = 1; ; attempt++) {
      let res: {
        status: number;
        headers?: Headers;
        json: Record<string, unknown> & { error?: GcError };
      };
      try {
        res = await this.api(
          operation,
          "POST",
          `/${collection}`,
          { [collection]: body },
          idempotencyKey,
        );
      } catch (e) {
        uncertain = true;
        if (attempt < 2) continue;
        throw new ProviderIndeterminateError(
          `We could not confirm whether GoCardless created the ${operation}: ${(e as Error).message}`,
        );
      }
      if (res.status < 300) return { ok: true, resource: res.json[collection] as T };
      if (res.status === 409 && firstReason(res.json.error) === "idempotent_creation_conflict") {
        const id = conflictingId(res.json.error);
        if (!id)
          throw new ProviderIndeterminateError(
            `GoCardless reports an earlier ${operation} for this key but did not name it`,
          );
        const existing = await this.read<Record<string, T>>(operation, `/${collection}/${id}`);
        return { ok: true, resource: existing[collection] as T };
      }
      if (res.status === 429) {
        if (attempt < 2 && (await this.rateLimitWait(res.headers))) continue;
        if (!uncertain) return { ok: false, status: 429, error: res.json.error };
        throw new ProviderIndeterminateError(
          `GoCardless answered 429 to the ${operation} after an attempt we could not confirm. We could not confirm whether it was created`,
        );
      }
      if (res.status >= 500) {
        uncertain = true;
        if (attempt < 2) continue;
        throw new ProviderIndeterminateError(
          `GoCardless answered ${res.status} to the ${operation}. We could not confirm whether it was created`,
        );
      }
      return { ok: false, status: res.status, error: res.json.error };
    }
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const { status, json } = await this.api<{
      creditors?: Array<{ id: string; country_code?: string; can_create_refunds?: boolean }>;
    }>("health_check", "GET", "/creditors?limit=1");
    if (status >= 300) return { ok: false, detail: errorText(json.error, status) };
    const c = json.creditors?.[0];
    return {
      ok: true,
      detail: c
        ? `creditor ${c.id} (${c.country_code ?? "?"}); refunds ${c.can_create_refunds ? "enabled" : "disabled"}`
        : "authenticated",
    };
  }

  // ── customers ──────────────────────────────────────────────────────────────

  private customerBody(input: EnsureCustomerInput): Record<string, unknown> {
    const name = input.name?.trim();
    const parts = name ? name.split(/\s+/) : [];
    const a = input.address;
    const region = a?.state ? gocardlessRegion(a.state, a.country ?? undefined) : undefined;
    // A Canadian customer with a company name gets a Business PAD mandate, else a
    // Personal one (https://docs.gocardless.com/docs/api-reference/customer, read 2026-10-28).
    const business =
      a?.country?.toUpperCase() === "CA" && input.company?.trim()
        ? { company_name: input.company.trim() }
        : {};
    return {
      ...(input.email ? { email: input.email.split(",")[0]!.trim() } : {}),
      ...(parts.length >= 2
        ? { given_name: parts.slice(0, -1).join(" "), family_name: parts.at(-1) }
        : name
          ? { company_name: name }
          : {}),
      ...business,
      ...(a?.line1 ? { address_line1: a.line1 } : {}),
      ...(a?.line2 ? { address_line2: a.line2 } : {}),
      ...(a?.city ? { city: a.city } : {}),
      ...(a?.postalCode ? { postal_code: a.postalCode } : {}),
      ...(region ? { region } : {}),
      ...(a?.country ? { country_code: a.country.toUpperCase() } : {}),
      ...(input.phone ? { phone_number: input.phone } : {}),
      metadata: tag(input.customerRef),
    };
  }

  async ensureCustomer(input: EnsureCustomerInput): Promise<ProviderCustomerRef> {
    const res = await this.create<{ id: string }>(
      "customer",
      "customers",
      this.customerBody(input),
      `tmb_customer_${input.customerRef}`,
    );
    if (!res.ok)
      throw new ProviderRefusalError(
        `GoCardless refused the customer: ${errorText(res.error, res.status)}`,
      );
    return { providerKey: this.key, providerCustomerId: res.resource.id };
  }

  async updateCustomer(ref: ProviderCustomerRef, input: EnsureCustomerInput): Promise<void> {
    const body = this.customerBody(input);
    delete body.metadata; // set once at creation; a PUT would replace the whole map
    const { status, json } = await this.api(
      "customer_update",
      "PUT",
      `/customers/${encodeURIComponent(ref.providerCustomerId)}`,
      { customers: body },
    );
    if (status >= 300)
      throw new Error(`GoCardless customer update failed: ${errorText(json.error, status)}`);
  }

  // ── mandate setup (Billing Request + hosted flow) ────────────────────────────

  /** The rail to register: the first requested method we support in this currency. */
  private pickMethod(methodTypes?: string[], currency?: string): string {
    const cur = currency?.toUpperCase();
    const supported = (
      methodTypes?.length ? methodTypes : Object.keys(GOCARDLESS_METHOD_SCHEMES)
    ).filter((m) => GOCARDLESS_METHOD_SCHEMES[m]);
    const pick = cur
      ? supported.find((m) => GOCARDLESS_METHOD_SCHEMES[m]!.currency === cur)
      : supported[0];
    if (!pick)
      throw new ProviderRefusalError(
        `GoCardless cannot set up a Direct Debit for ${cur ?? "this request"} with the methods ` +
          `${(methodTypes ?? []).join(", ") || "requested"}. Use Bacs (GBP), SEPA (EUR), ACH (USD), ` +
          "BECS or PayTo (AUD), BECS NZ (NZD), PAD (CAD), Autogiro (SEK) or Betalingsservice (DKK).",
      );
    return pick;
  }

  private async startBillingRequest(input: {
    customerId: string;
    returnUrl: string;
    cancelUrl: string;
    methodTypes?: string[];
    currency?: string;
    description?: string;
    maxAmountMinor?: bigint;
    ownershipRef?: string;
    idempotencyKey?: string;
  }): Promise<VaultSetupRef> {
    const method = this.pickMethod(input.methodTypes, input.currency);
    const { scheme, currency } = GOCARDLESS_METHOD_SCHEMES[method]!;
    const payto = scheme === "pay_to";
    // PayTo refuses an agreement without a per-payment ceiling (measured 2026-10-28,
    // though the reference calls `constraints` optional).
    if (payto && (input.maxAmountMinor == null || input.maxAmountMinor <= 0n))
      throw new ProviderRefusalError(
        "We could not set up the PayTo agreement. PayTo needs a maximum amount for each payment, and the request did not give one. Send the request again with the currency AUD.",
      );
    const description =
      input.description?.slice(0, 255) || (payto ? PAYTO_DEFAULT_DESCRIPTION : "");
    const brqBody = {
      mandate_request: {
        currency,
        scheme,
        metadata: tag(input.ownershipRef),
        ...(description ? { description } : {}),
        ...(payto ? { constraints: { max_amount_per_payment: Number(input.maxAmountMinor) } } : {}),
      },
      ...(payto ? { purpose_code: this.purposeCode } : {}),
      metadata: tag(input.ownershipRef),
      links: { customer: input.customerId },
    };
    let brq: { id: string };
    if (input.idempotencyKey) {
      const res = await this.create<{ id: string }>(
        "billing_request",
        "billing_requests",
        brqBody,
        input.idempotencyKey,
      );
      if (!res.ok)
        throw new ProviderRefusalError(
          `GoCardless refused the mandate request: ${errorText(res.error, res.status)}`,
        );
      brq = res.resource;
    } else {
      const { status, json } = await this.api<{ billing_requests: { id: string } }>(
        "billing_request",
        "POST",
        "/billing_requests",
        { billing_requests: brqBody },
      );
      if (status >= 300)
        throw new ProviderRefusalError(
          `GoCardless refused the mandate request: ${errorText(json.error, status)}`,
        );
      brq = json.billing_requests;
    }
    const flow = await this.api<{ billing_request_flows: { authorisation_url?: string } }>(
      "billing_request_flow",
      "POST",
      "/billing_request_flows",
      {
        billing_request_flows: {
          redirect_uri: input.returnUrl,
          exit_uri: input.cancelUrl,
          links: { billing_request: brq.id },
        },
      },
    );
    const url = flow.json.billing_request_flows?.authorisation_url;
    if (flow.status >= 300 || !url)
      throw markStrandedObject(
        new Error(
          `GoCardless did not create the hosted mandate page: ${errorText(flow.json.error, flow.status)}`,
        ),
        brq.id,
      );
    return { mode: "redirect", approvalUrl: url, setupTokenId: brq.id };
  }

  async initiateVaultSetup(input: InitiateVaultSetupInput): Promise<VaultSetupRef> {
    return this.startBillingRequest({
      customerId: input.customer.providerCustomerId,
      returnUrl: input.returnUrl,
      cancelUrl: input.cancelUrl,
      ...(input.methodTypes ? { methodTypes: input.methodTypes } : {}),
      ...(input.currency ? { currency: input.currency } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.maxAmountMinor != null ? { maxAmountMinor: input.maxAmountMinor } : {}),
      ...(input.ownershipRef ? { ownershipRef: input.ownershipRef } : {}),
    });
  }

  async createIntent(input: CreateIntentInput): Promise<IntentRef> {
    if (input.purpose !== "setup")
      throw new ProviderRefusalError(
        "GoCardless cannot hold a payment. A Direct Debit is collected with a charge on a mandate.",
      );
    if (!input.returnUrl || !input.cancelUrl)
      throw new Error("A GoCardless setup needs returnUrl and cancelUrl (hosted mandate page)");
    const setup = await this.startBillingRequest({
      customerId: input.customer.providerCustomerId,
      returnUrl: input.returnUrl,
      cancelUrl: input.cancelUrl,
      ...(input.methodTypes ? { methodTypes: input.methodTypes } : {}),
      currency: input.currency,
      ...(input.description ? { description: input.description } : {}),
      ...(input.maxAmountMinor != null ? { maxAmountMinor: input.maxAmountMinor } : {}),
      ...(input.ownershipRef ? { ownershipRef: input.ownershipRef } : {}),
      idempotencyKey: input.idempotencyKey,
    });
    const { setupTokenId, ...authorization } = setup;
    return { intentId: setupTokenId, status: "requires_action", authorization };
  }

  /** The vaulted instrument for a mandate: its scheme, bank and last digits. */
  private async describeMandate(
    mandateId: string,
  ): Promise<ProviderPaymentMethodRef & { mandateCustomerId?: string }> {
    const { mandates: m } = await this.read<{ mandates: GcMandate }>(
      "mandate",
      `/mandates/${encodeURIComponent(mandateId)}`,
    );
    const type = SCHEME_METHOD[m.scheme ?? ""];
    if (!type)
      throw new ProviderRefusalError(
        `GoCardless mandate ${m.id} uses the ${m.scheme ?? "unknown"} scheme, which this gateway account does not offer`,
      );
    let bank: {
      bank_name?: string;
      account_number_ending?: string;
      country_code?: string;
    } = {};
    if (m.links?.customer_bank_account) {
      const r = await this.api<{ customer_bank_accounts: typeof bank }>(
        "customer_bank_account",
        "GET",
        `/customer_bank_accounts/${encodeURIComponent(m.links.customer_bank_account)}`,
      );
      if (r.status < 300) bank = r.json.customer_bank_accounts ?? {};
    }
    const status = normalizeGocardlessMandateStatus(m.status);
    const ceiling = m.consent_parameters?.max_amount_per_payment;
    return {
      providerKey: this.key,
      providerPaymentMethodId: m.id,
      ...(m.links?.customer ? { providerCustomerId: m.links.customer } : {}),
      mandateCustomerId: m.links?.customer,
      display: {
        type,
        // Bank account ending: 2 digits on most schemes, 4 on NZD.
        ...(bank.account_number_ending ? { last4: bank.account_number_ending } : {}),
        ...(bank.bank_name ? { issuerName: bank.bank_name } : {}),
        ...(bank.country_code ? { issuerCountry: bank.country_code.toUpperCase() } : {}),
      },
      mandate: {
        ...(status ? { status } : {}),
        ...(m.scheme ? { rail: m.scheme } : {}),
        ...(m.reference ? { reference: m.reference } : {}),
        currency: GOCARDLESS_METHOD_SCHEMES[type]!.currency,
        // PayTo: the bank refuses a payment above what the payer approved.
        ...(typeof ceiling === "number" && ceiling > 0 ? { maxAmountMinor: BigInt(ceiling) } : {}),
      },
    };
  }

  /** A fulfilled Billing Request's mandate, or a reason it has none. */
  private async mandateOfBillingRequest(
    brqId: string,
  ): Promise<{ mandateId?: string; status?: string; customerId?: string }> {
    const { billing_requests: b } = await this.read<{
      billing_requests: {
        status?: string;
        mandate_request?: { links?: { mandate?: string } };
        links?: { mandate_request_mandate?: string; customer?: string };
      };
    }>("billing_request", `/billing_requests/${encodeURIComponent(brqId)}`);
    return {
      mandateId: b.mandate_request?.links?.mandate ?? b.links?.mandate_request_mandate,
      status: b.status,
      customerId: b.links?.customer,
    };
  }

  async vaultPaymentMethod(input: VaultPaymentMethodInput): Promise<ProviderPaymentMethodRef> {
    let mandateId = input.token;
    if (input.token.startsWith("BRQ")) {
      const brq = await this.mandateOfBillingRequest(input.token);
      if (!brq.mandateId)
        throw new Error(
          `GoCardless billing request ${input.token} has no mandate yet (status ${brq.status ?? "unknown"}). ` +
            "The payer did not complete the mandate page.",
        );
      mandateId = brq.mandateId;
    }
    const { mandateCustomerId, ...ref } = await this.describeMandate(mandateId);
    // The token is a client assertion: it must name a mandate of THIS customer.
    if (mandateCustomerId && mandateCustomerId !== input.customer.providerCustomerId)
      throw new ProviderRefusalError(
        "This GoCardless mandate belongs to a different customer. We cannot save it here.",
      );
    return ref;
  }

  async consumeIntent(input: ConsumeIntentInput): Promise<ConsumeIntentResult> {
    if (input.purpose !== "setup")
      throw new ProviderRefusalError("GoCardless has no payment intents to capture.");
    const brq = await this.mandateOfBillingRequest(input.intentId);
    if (brq.status === "cancelled")
      return {
        purpose: "setup",
        failure: {
          code: "setup_cancelled",
          message: "The Direct Debit setup was cancelled before the payer completed it.",
          retriable: true,
        },
      };
    if (!brq.mandateId)
      throw new Error(
        `GoCardless billing request ${input.intentId} is ${brq.status ?? "unknown"} and has no mandate yet. ` +
          "The payer did not complete the mandate page.",
      );
    const { mandateCustomerId: _c, ...ref } = await this.describeMandate(brq.mandateId);
    return { purpose: "setup", paymentMethod: ref };
  }

  async fetchPaymentMethodDisplay(input: {
    providerPaymentMethodId: string;
  }): Promise<ProviderPaymentMethodRef["display"] | null> {
    try {
      return (await this.describeMandate(input.providerPaymentMethodId)).display;
    } catch {
      return null;
    }
  }

  async deletePaymentMethod(input: { paymentMethod: ProviderPaymentMethodRef }): Promise<void> {
    const id = input.paymentMethod.providerPaymentMethodId;
    const { status, json } = await this.api(
      "mandate_cancel",
      "POST",
      `/mandates/${encodeURIComponent(id)}/actions/cancel`,
      { data: {} },
    );
    // Already cancelled, failed or expired: nothing left to remove.
    if (status < 300 || firstReason(json.error) === "cancellation_failed") return;
    if (status === 404) return;
    throw new Error(`GoCardless could not cancel mandate ${id}: ${errorText(json.error, status)}`);
  }

  // ── money ──────────────────────────────────────────────────────────────────

  /**
   * Collect on the invoice's due day when the scheme's notice period ends by then. The
   * mandate's next possible dates carry that period, so nothing is hard-coded. A failed
   * read collects as soon as possible, as before.
   */
  private async chargeDateFor(
    input: ChargeInput,
  ): Promise<{ charge_date: string; faster_ach?: false } | undefined> {
    const due = input.invoiceDueDate;
    if (!due || due <= new Date().toISOString().slice(0, 10)) return undefined;
    const id = input.paymentMethod.providerPaymentMethodId;
    try {
      const { status, json } = await this.api<{ mandates?: GcMandate }>(
        "mandate_charge_date",
        "GET",
        `/mandates/${encodeURIComponent(id)}`,
      );
      if (status < 300) return gocardlessChargeDate(due, json.mandates);
      log.warn("could not read the mandate's next charge date; collecting as soon as possible", {
        event: "gocardless_charge_date_unread",
        status,
      });
    } catch (e) {
      log.warn("could not read the mandate's next charge date; collecting as soon as possible", {
        event: "gocardless_charge_date_unread",
        error: String(e),
      });
    }
    return undefined;
  }

  /** The mandate that replaced `mandateId`, from the refusal or the old mandate. */
  private async replacementMandate(
    mandateId: string,
    err: GcError | undefined,
  ): Promise<string | undefined> {
    const named =
      err?.links?.new_mandate ?? err?.errors?.find((e) => e.links?.new_mandate)?.links?.new_mandate;
    if (named) return named;
    const r = await this.api<{ mandates?: GcMandate }>(
      "mandate",
      "GET",
      `/mandates/${encodeURIComponent(mandateId)}`,
    );
    return r.status < 300 ? r.json.mandates?.links?.new_mandate : undefined;
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    let schedule = await this.chargeDateFor(input);
    let mandate = input.paymentMethod.providerPaymentMethodId;
    let res:
      | { ok: true; resource: { id: string; status?: string; scheme?: string | null } }
      | { ok: false; status: number; error?: GcError };
    // A key is spent only by a SUCCESSFUL create, so a refused one is retried under it.
    for (let attempt = 1; ; attempt++) {
      res = await this.create<{ id: string; status?: string; scheme?: string | null }>(
        "charge",
        "payments",
        {
          amount: Number(input.amountMinor),
          currency: input.currency.toUpperCase(),
          ...(schedule ?? {}),
          // The engine owns retries; GoCardless's own would debit the payer twice.
          retry_if_possible: false,
          ...(input.description ? { description: input.description.slice(0, 255) } : {}),
          metadata: tag(input.ownershipRef ?? input.idempotencyKey),
          links: { mandate },
        },
        input.idempotencyKey,
      );
      if (res.ok || attempt >= 3) break;
      if (schedule && dateRefused(res.error)) {
        log.warn("GoCardless refused the charge date; collecting as soon as possible", {
          event: "gocardless_charge_date_refused",
          charge_date: schedule.charge_date,
          detail: errorText(res.error, res.status),
        });
        schedule = undefined;
        continue;
      }
      // The decline rules say whether the mandate was replaced.
      const rule = normalizeGocardlessDecline(firstReason(res.error) ?? "").ruleId;
      if (rule === "gocardless.code.mandate_replaced") {
        const next = await this.replacementMandate(mandate, res.error);
        if (next && next !== mandate) {
          log.info("mandate replaced; charging the new mandate", {
            event: "gocardless_charge_mandate_replaced",
            from: mandate,
            to: next,
          });
          mandate = next;
          continue;
        }
      }
      break;
    }
    if (res.ok) return gocardlessPaymentResult(res.resource, undefined, res.resource);
    const reason = firstReason(res.error) ?? res.error?.type ?? `http_${res.status}`;
    const norm = normalizeGocardlessDecline(reason);
    return {
      status: "failed",
      providerChargeId: "",
      failure: {
        code: norm.code,
        providerCode: reason,
        message: norm.message ?? errorText(res.error, res.status),
        retriable: norm.retriable,
        ...(norm.ruleId ? { ruleId: norm.ruleId } : {}),
      },
      raw: res.error,
    };
  }

  /** The latest failure cause GoCardless reported for a payment, from its events. */
  private async failureCause(
    paymentId: string,
  ): Promise<{ cause?: string; description?: string } | undefined> {
    const { status, json } = await this.api<{ events?: GcEvent[] }>(
      "payment_events",
      "GET",
      `/events?payment=${encodeURIComponent(paymentId)}&limit=20`,
    );
    if (status >= 300) return undefined;
    const ev = json.events?.find((e) =>
      ["failed", "cancelled", "customer_approval_denied", "late_failure"].includes(e.action ?? ""),
    );
    return ev?.details
      ? {
          ...(ev.details.cause ? { cause: ev.details.cause } : {}),
          ...(ev.details.description ? { description: ev.details.description } : {}),
        }
      : undefined;
  }

  async fetchChargeStatus(input: { providerChargeId: string }): Promise<ChargeResult> {
    const { payments: p } = await this.read<{
      payments: { id: string; status?: string; scheme?: string | null };
    }>("charge_status", `/payments/${encodeURIComponent(input.providerChargeId)}`);
    const failed = ["failed", "cancelled", "customer_approval_denied"].includes(p.status ?? "");
    return gocardlessPaymentResult(p, failed ? await this.failureCause(p.id) : undefined, p);
  }

  /**
   * Contract: find a charge whose create answer was lost (see `locateCharge` on
   * `PaymentProvider`). GoCardless has no filter by metadata or idempotency key, and a
   * repeat of the key would create the payment
   * (https://docs.gocardless.com/docs/api-reference/payment, read 2026-10-27). So list the
   * payments created in a bounded window and match our `tmbilling_ref`, the amount and the
   * currency. The list reads live data, so `null` is definite.
   */
  async locateCharge(input: {
    ownershipRef: string;
    idempotencyKey: string;
    amountMinor: bigint;
    currency: string;
    createdAfter: Date;
  }): Promise<ChargeResult | null> {
    type Row = {
      id: string;
      status?: string;
      scheme?: string | null;
      amount?: number;
      currency?: string;
      metadata?: Record<string, unknown>;
    };
    // As `tag()` stamped them: the ref, or the key when a caller sent no ref.
    const refs = new Set(
      [input.ownershipRef, input.idempotencyKey].map((r) => r.slice(0, METADATA_VALUE_MAX)),
    );
    const currency = input.currency.toUpperCase();
    const query = {
      "created_at[gte]": input.createdAfter.toISOString(),
      "created_at[lte]": new Date(input.createdAfter.getTime() + LOCATE_WINDOW_MS).toISOString(),
      currency,
      limit: "500",
    };
    const found: Row[] = [];
    let after: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= LOCATE_MAX_PAGES)
        throw new Error(
          `more than ${LOCATE_MAX_PAGES * 500} GoCardless payments were created in the lookup window; cannot confirm none is ours`,
        );
      const qs = new URLSearchParams({ ...query, ...(after ? { after } : {}) });
      const res = await this.read<{
        payments?: Row[];
        meta?: { cursors?: { after?: string | null } };
      }>("locate_charge", `/payments?${qs}`);
      const rows = res.payments ?? [];
      for (const p of rows) {
        const ref = p.metadata?.[GOCARDLESS_OWNERSHIP_KEY];
        if (
          typeof ref === "string" &&
          refs.has(ref) &&
          p.amount === Number(input.amountMinor) &&
          p.currency === currency
        )
          found.push(p);
      }
      after = res.meta?.cursors?.after ?? undefined;
      if (!after || rows.length === 0) break;
    }
    if (found.length > 1)
      throw new Error(
        `GoCardless has ${found.length} payments tagged ${input.ownershipRef} for this amount in the window; cannot tell which one this attempt made`,
      );
    const p = found[0];
    if (!p) return null;
    const failed = ["failed", "cancelled", "customer_approval_denied"].includes(p.status ?? "");
    return gocardlessPaymentResult(p, failed ? await this.failureCause(p.id) : undefined, p);
  }

  /**
   * Cancel a payment before GoCardless submits it to the banks. Valid only while the payment
   * is `pending_submission`; after that GoCardless answers `cancellation_failed`. The verdict
   * is read back from the payment either way, so a repeat cancel answers `cancelled` again.
   */
  async cancelPendingCharge(input: CancelPendingChargeInput): Promise<CancelPendingChargeResult> {
    const id = encodeURIComponent(input.providerChargeId);
    const res = await this.api<{ payments?: { id: string; status?: string } }>(
      "cancel_charge",
      "POST",
      `/payments/${id}/actions/cancel`,
      { data: { metadata: {} } },
      input.idempotencyKey,
    );
    const p =
      res.status < 300 && res.json.payments
        ? res.json.payments
        : (
            await this.read<{ payments: { id: string; status?: string } }>(
              "cancel_charge",
              `/payments/${id}`,
            )
          ).payments;
    if (p.status === "cancelled") return { status: "cancelled", raw: p };
    const reason = res.status >= 300 ? errorText(res.json.error, res.status) : undefined;
    const now = gocardlessPaymentResult(p, undefined, p);
    if (now.status !== "pending")
      return {
        status: "already_final",
        charge: await this.fetchChargeStatus({ providerChargeId: p.id }),
        ...(reason ? { reason } : {}),
        raw: p,
      };
    return { status: "not_cancelable", reason: reason ?? `GoCardless payment ${p.status}`, raw: p };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    let p: { amount: number; amount_refunded?: number; currency?: string };
    try {
      ({ payments: p } = await this.read<{ payments: typeof p }>(
        "refund_payment",
        `/payments/${encodeURIComponent(input.providerChargeId)}`,
      ));
    } catch (e) {
      // Nothing was sent, so the engine must release the reservation.
      throw new ProviderRefusalError(
        `We could not refund this payment. We could not read the payment at GoCardless, so we did not send a refund. Try again. (${(e as Error).message})`,
      );
    }
    const already = BigInt(p.amount_refunded ?? 0);
    const amount = input.amountMinor ?? BigInt(p.amount) - already;
    if (amount <= 0n)
      throw new ProviderRefusalError("Nothing is left to refund on this GoCardless payment.");
    const res = await this.create<{ id: string; status?: string }>(
      "refund",
      "refunds",
      {
        amount: Number(amount),
        // The running total, this refund included — GoCardless refuses any other figure.
        total_amount_confirmation: Number(already + amount),
        metadata: tag(input.ownershipRef ?? input.idempotencyKey),
        links: { payment: input.providerChargeId },
      },
      input.idempotencyKey,
    );
    if (!res.ok) throw new ProviderRefusalError(gocardlessRefundRefusal(res, p.currency));
    return {
      status: gocardlessRefundStatus(res.resource.status),
      providerRefundId: res.resource.id,
      raw: res.resource,
    };
  }

  async fetchRefundStatus(input: { providerRefundId: string }): Promise<RefundResult> {
    const { refunds: r } = await this.read<{ refunds: { id: string; status?: string } }>(
      "refund_status",
      `/refunds/${encodeURIComponent(input.providerRefundId)}`,
    );
    return { status: gocardlessRefundStatus(r.status), providerRefundId: r.id, raw: r };
  }

  // ── events ─────────────────────────────────────────────────────────────────

  webhookEventId(input: NormalizeWebhookInput): string {
    let ids: string[] = [];
    try {
      const body = JSON.parse(input.payload.toString()) as { events?: Array<{ id?: unknown }> };
      ids = (body.events ?? []).map((e) => e.id).filter((x): x is string => typeof x === "string");
    } catch {
      // Not JSON: the body hash below.
    }
    if (ids.length === 1) return ids[0]!;
    if (ids.length > 1)
      return `gcbatch:${createHash("sha256")
        .update([...ids].sort().join(","))
        .digest("hex")}`;
    return webhookEventId([], input.payload);
  }

  /**
   * Verify and translate. One delivery carries a batch, and each event keeps its own
   * `EV…` id as `providerEventId`, because GoCardless may redeliver an event in another batch.
   */
  async normalizeWebhook(input: NormalizeWebhookInput): Promise<NormalizedProviderEvent[]> {
    if (!this.cfg.webhookSecret)
      throw new Error(
        "GoCardless webhook secret is not configured. Paste it on the gateway account's webhook card.",
      );
    if (
      !verifyGocardlessSignature(
        input.payload,
        headerValue(input.headers, "webhook-signature"),
        this.cfg.webhookSecret,
      )
    )
      throw new Error("Invalid GoCardless webhook signature");
    const body = JSON.parse(input.payload.toString()) as { events?: GcEvent[] };
    const events = body.events ?? [];
    // Answer within GoCardless's 10 s: no reads for events already settled here.
    let settled: ReadonlySet<string> = new Set();
    if (input.settledEventIds)
      try {
        settled = await input.settledEventIds(
          events.flatMap((e) => [e.id, `${e.id}:funds_withdrawn`]),
        );
      } catch {
        // Unknown: map everything, as before.
      }
    const done = (e: GcEvent) =>
      settled.has(e.id) && (e.action !== "charged_back" || settled.has(`${e.id}:funds_withdrawn`));
    const mapped = await mapBounded(events, WEBHOOK_MAP_CONCURRENCY, (e) =>
      done(e) ? Promise.resolve([this.unmapped(e)]) : this.mapEvent(e),
    );
    return mapped.flat();
  }

  /** An event passed through without a gateway read; the engine dedups it. */
  private unmapped(ev: GcEvent): NormalizedProviderEvent {
    return {
      providerEventId: ev.id,
      type: "unknown",
      occurredAt: ev.created_at ? new Date(ev.created_at) : new Date(),
      raw: ev,
      ...ownershipOf(ev.resource_metadata),
    };
  }

  /** The events list for `[since, until)`, mapped exactly as a webhook would be. */
  async pollSettlements(input: { since: Date; until: Date }): Promise<NormalizedProviderEvent[]> {
    const out: NormalizedProviderEvent[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const q = new URLSearchParams({
        "created_at[gte]": input.since.toISOString(),
        "created_at[lt]": input.until.toISOString(),
        limit: "500",
        ...(after ? { after } : {}),
      });
      const json = await this.read<{
        events?: GcEvent[];
        meta?: { cursors?: { after?: string | null } };
      }>("settlement_report", `/events?${q.toString()}`);
      for (const ev of json.events ?? []) {
        for (const n of await this.mapEvent(ev)) if (n.type !== "unknown") out.push(n);
      }
      after = json.meta?.cursors?.after ?? undefined;
      if (!after) break;
    }
    return out;
  }

  /** One GoCardless event → zero or more normalized events. Exported shape is pure data. */
  async mapEvent(ev: GcEvent): Promise<NormalizedProviderEvent[]> {
    const base: NormalizedProviderEvent = {
      providerEventId: ev.id,
      type: "unknown",
      occurredAt: ev.created_at ? new Date(ev.created_at) : new Date(),
      raw: ev,
      ...ownershipOf(ev.resource_metadata),
    };
    const action = ev.action ?? "";
    const links = ev.links ?? {};
    switch (ev.resource_type) {
      case "payments":
        return this.mapPaymentEvent(ev, base, action, links.payment);
      case "refunds":
        return this.mapRefundEvent(base, action, links.refund, links.payment);
      case "mandates":
        return links.mandate
          ? [await this.mapMandateEvent(base, action, links.mandate, links.new_mandate)]
          : [base];
      case "billing_requests":
        return [mapBillingRequestEvent(ev, base, action, links)];
      default:
        return [base];
    }
  }

  private async mapPaymentEvent(
    ev: GcEvent,
    base: NormalizedProviderEvent,
    action: string,
    paymentId: string | undefined,
  ): Promise<NormalizedProviderEvent[]> {
    if (!paymentId) return [base];
    const charge = { ...base, providerChargeId: paymentId };
    switch (action) {
      case "created":
      case "submitted":
      case "customer_approval_granted":
      case "resubmission_requested":
        return [{ ...charge, type: "charge.pending" }];
      case "confirmed": {
        // Events can arrive out of order. If the payment has since failed, the failure
        // event carries the verdict and this one must not settle it.
        const { payments: p } = await this.read<{ payments: { status?: string; amount?: number } }>(
          "payment",
          `/payments/${encodeURIComponent(paymentId)}`,
        );
        const dead = ["failed", "cancelled", "customer_approval_denied"].includes(p.status ?? "");
        if (dead) return [{ ...charge, type: "charge.updated" }];
        // The event names no amount; the payment read above does (minor units, collected whole).
        return [
          {
            ...charge,
            type: "charge.succeeded",
            ...(typeof p.amount === "number"
              ? { capturedAmountMinor: BigInt(p.amount), amountMinor: BigInt(p.amount) }
              : {}),
          },
        ];
      }
      case "failed":
      case "late_failure":
      case "cancelled":
      case "customer_approval_denied": {
        const code = ev.details?.cause ?? action;
        if (cancelledAtRequest(action, ev.details?.cause))
          return [
            {
              ...charge,
              type: "charge.failed",
              failureCode: GOCARDLESS_CANCELLED_CODE,
              providerFailureCode: code,
              failureMessage: CANCELLED_MESSAGE,
              failureRetriable: false,
            },
          ];
        const norm = normalizeGocardlessDecline(code);
        // A failure after `confirmed` is a late failure. Flag every bank failure as a
        // reversal: the engine treats it as one only if it had booked the payment.
        const reversal = action === "failed" || action === "late_failure";
        return [
          {
            ...charge,
            type: "charge.failed",
            failureCode: norm.code,
            providerFailureCode: code,
            failureMessage: norm.message ?? ev.details?.description ?? `payment ${action}`,
            failureRetriable: norm.retriable,
            raw: reversal ? { ...ev, data: { reversal: true, retriable: norm.retriable } } : ev,
          },
        ];
      }
      case "charged_back": {
        const { payments: p } = await this.read<{ payments: { amount: number; currency: string } }>(
          "payment",
          `/payments/${encodeURIComponent(paymentId)}`,
        );
        const dispute = {
          ...charge,
          providerDisputeId: `${paymentId}:chargeback`,
          disputeReason: ev.details?.cause ?? null,
          disputeStatus: "charged_back",
          disputeAmountMinor: BigInt(p.amount),
          disputeCurrency: p.currency,
        };
        // A Direct Debit chargeback takes the money at once: opened and withdrawn together.
        return [
          { ...dispute, type: "dispute.created" },
          {
            ...dispute,
            providerEventId: `${ev.id}:funds_withdrawn`,
            type: "dispute.funds_withdrawn",
          },
        ];
      }
      case "chargeback_cancelled":
        return [
          {
            ...charge,
            type: "dispute.funds_reinstated",
            providerDisputeId: `${paymentId}:chargeback`,
            disputeStatus: "chargeback_cancelled",
          },
        ];
      case "paid_out":
      case "late_failure_settled":
      case "chargeback_settled":
      case "surcharge_fee_debited":
      case "surcharge_fee_credited":
        // Payout bookkeeping on money whose fate was already reported.
        return [{ ...charge, type: "charge.updated" }];
      default:
        return [charge];
    }
  }

  private async mapRefundEvent(
    base: NormalizedProviderEvent,
    action: string,
    refundId: string | undefined,
    paymentId: string | undefined,
  ): Promise<NormalizedProviderEvent[]> {
    if (!refundId) return [base];
    const ev = {
      ...base,
      providerRefundId: refundId,
      ...(paymentId ? { providerChargeId: paymentId } : {}),
    };
    switch (action) {
      case "created":
        return [{ ...ev, type: "refund.pending" }];
      case "paid": {
        // Refund events link only the refund (measured): its payment comes from the refund.
        const charge =
          paymentId ??
          (
            await this.read<{ refunds: { links?: { payment?: string } } }>(
              "refund",
              `/refunds/${encodeURIComponent(refundId)}`,
            )
          ).refunds.links?.payment;
        if (!charge) return [{ ...ev, type: "charge.refunded" }];
        const { payments: p } = await this.read<{ payments: { amount_refunded?: number } }>(
          "payment",
          `/payments/${encodeURIComponent(charge)}`,
        );
        return [
          {
            ...ev,
            providerChargeId: charge,
            type: "charge.refunded",
            ...(p.amount_refunded != null
              ? { amountRefundedMinor: BigInt(p.amount_refunded) }
              : {}),
          },
        ];
      }
      case "failed":
      case "bounced":
      case "funds_returned":
      case "cancelled":
        return [{ ...ev, type: "refund.failed" }];
      default:
        return [ev];
    }
  }

  /**
   * The event's action sets the status: the API can trail the webhook by minutes, and a
   * lagging read would book a dead mandate as live. Reads only fetch what the event does
   * not carry: the new mandate of a `replaced` one, the new bank of a `transferred` one.
   */
  private async mapMandateEvent(
    base: NormalizedProviderEvent,
    action: string,
    mandateId: string,
    newMandateId: string | undefined,
  ): Promise<NormalizedProviderEvent> {
    const ev = { ...base, providerPaymentMethodId: mandateId };
    if (action === "replaced") {
      if (!newMandateId) return ev;
      // A failed read throws: the delivery is answered non-2xx and comes again.
      const { mandateCustomerId: _c, ...next } = await this.describeMandate(newMandateId);
      return {
        ...ev,
        type: "payment_method.mandate_updated",
        replacementPaymentMethodId: newMandateId,
        mandate: { ...next.mandate, status: next.mandate?.status ?? "active" },
        paymentMethodDisplay: next.display,
      };
    }
    const status = normalizeGocardlessMandateStatus(MANDATE_ACTION_STATUS[action]);
    if (!status) return ev;
    const out: NormalizedProviderEvent = {
      ...ev,
      type: "payment_method.mandate_updated",
      mandate: { status },
    };
    if (action !== "transferred") return out;
    const { mandateCustomerId: _c, ...now } = await this.describeMandate(mandateId);
    return { ...out, paymentMethodDisplay: now.display };
  }
}

function mapBillingRequestEvent(
  ev: GcEvent,
  base: NormalizedProviderEvent,
  action: string,
  links: Record<string, string | undefined>,
): NormalizedProviderEvent {
  const brq = links.billing_request;
  if (!brq) return base;
  if (action === "fulfilled")
    return {
      ...base,
      type: "intent.setup_succeeded",
      providerIntentId: brq,
      ...(links.mandate_request_mandate
        ? { providerPaymentMethodId: links.mandate_request_mandate }
        : {}),
    };
  if (action === "cancelled" || action === "failed")
    return {
      ...base,
      type: "intent.setup_failed",
      providerIntentId: brq,
      failureCode: "setup_cancelled",
      providerFailureCode: ev.details?.cause ?? action,
      failureMessage: ev.details?.description ?? `billing request ${action}`,
      failureRetriable: true,
    };
  return { ...base, providerIntentId: brq };
}
