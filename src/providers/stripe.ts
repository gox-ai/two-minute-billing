import Stripe from "stripe";
import { createHash } from "node:crypto";
import type {
  PaymentProvider,
  ProviderCapabilities,
  EnsureCustomerInput,
  ProviderCustomerRef,
  VaultPaymentMethodInput,
  ProviderPaymentMethodRef,
  InitiateVaultSetupInput,
  VaultSetupRef,
  BuyerAuthorization,
  ChargeInput,
  ChargeResult,
  RefundInput,
  WalletDomainStatus,
  RefundResult,
  NormalizeWebhookInput,
  ProvisionedWebhook,
  WebhookRemoval,
  NormalizedProviderEvent,
  ProviderRefundRecord,
  CreateIntentInput,
  IntentRef,
  ConsumeIntentInput,
  ConsumeIntentResult,
  VoidIntentInput,
  VoidIntentResult,
  ProviderMandate,
  FetchedIntent,
  IntentPurpose,
} from "./types";
import { minorToDecimalString } from "@/platform/currency";
import { markStrandedObject, ProviderIndeterminateError, ProviderRefusalError } from "./types";
import type { CancelPendingChargeInput, CancelPendingChargeResult } from "./types";

/**
 * Errors after which Stripe may still have charged: the connection dropped, Stripe answered
 * 5xx, rate-limited the call, or reports the same key still in use (409). A 4xx that is
 * not 409 or 429 is Stripe refusing the request, so nothing was created.
 */
export function isLostStripeAnswer(err: unknown): boolean {
  if (
    err instanceof Stripe.errors.StripeConnectionError ||
    err instanceof Stripe.errors.StripeRateLimitError ||
    err instanceof Stripe.errors.StripeIdempotencyError
  )
    return true;
  if (err instanceof Stripe.errors.StripeAPIError) return true;
  const status = (err as { statusCode?: number }).statusCode;
  return err instanceof Stripe.errors.StripeError && (status === 409 || (status ?? 0) >= 500);
}

/** Stripe refused the request as invalid (4xx `invalid_request_error`, not 409 or 429). */
export function isStripeRefundRefusal(err: unknown): boolean {
  if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) return false;
  const status = err.statusCode ?? 400;
  return status >= 400 && status < 500 && status !== 409 && status !== 429;
}

import { createLogger } from "@/platform/logger";

/**
 * Declines are NOT logged here, deliberately: a card being refused is ordinary
 * billing life, it is already a normalized `failureCode` on the attempt row, and
 * logging every one drowns the sink (providers/http.ts makes the same split for
 * transport failures). What IS logged is the small set of outcomes where we accept
 * the provider's word that something is already gone — those are reconciliation
 * facts, and they are invisible everywhere else.
 */
const log = createLogger("stripe");
import { logGatewayRequest, redactHeaders, redactBody, PROVIDER_APP_NAME } from "./http";
import { currentGatewayLogContext } from "./log-context";
import {
  AUTHENTICATION_REQUIRED_CODE,
  normalizeStripeDecline,
  STRIPE_CODE_TABLE,
  type DeclineSignal,
  type NormalizedDecline,
} from "./decline-codes";
import { currentEventContext } from "@/platform/event-context";
import { bodyId, webhookEventId } from "./webhook-event-id";

/** The API version the SDK pins. Objects we read come back in this shape. */
export const STRIPE_API_VERSION = Stripe.API_VERSION;

/**
 * Oldest `Stripe-Signature` timestamp we accept, in seconds. Stripe signs every delivery
 * attempt afresh, retries included (https://docs.stripe.com/webhooks#preventing-replay-attacks),
 * so this bounds only a captured request. Explicit: the SDK's default (300 s in stripe-node 22)
 * could change with an upgrade. The SDK sets no future limit; a future time only Stripe can sign.
 */
export const STRIPE_WEBHOOK_TOLERANCE_S = 300;

/**
 * Whole-unit currencies (exponent 0 in our table) that Stripe still takes as two-decimal,
 * with the fraction always `00`: "to charge 5 ISK, provide an amount value of 500".
 * https://docs.stripe.com/currencies#special-cases (read 2026-10-27). HUF and TWD are
 * special there for payouts only, which we never create.
 */
const STRIPE_TWO_DECIMAL_WHOLE_UNIT = new Set(["ISK", "UGX"]);

/**
 * Two-decimal currencies (ISO 4217, our table) that Stripe takes in whole units:
 * MGA is on its zero-decimal list. https://docs.stripe.com/currencies#zero-decimal
 * (read 2026-10-31).
 */
const STRIPE_WHOLE_UNIT_TWO_DECIMAL = new Set(["MGA"]);

/** Our minor units → the `amount` Stripe expects. */
export function toStripeAmount(minor: bigint, currency: string | null | undefined): number {
  const c = (currency ?? "").toUpperCase();
  if (STRIPE_TWO_DECIMAL_WHOLE_UNIT.has(c)) return Number(minor * 100n);
  if (STRIPE_WHOLE_UNIT_TWO_DECIMAL.has(c)) {
    if (minor % 100n !== 0n)
      throw new ProviderRefusalError(
        `Stripe cannot charge ${minorToDecimalString(minor, c)} ${c}: it takes this currency in whole units only.`,
      );
    return Number(minor / 100n);
  }
  return Number(minor);
}

/** A Stripe `amount` → our minor units. */
export function fromStripeAmount(amount: number, currency: string | null | undefined): bigint {
  const c = (currency ?? "").toUpperCase();
  if (STRIPE_TWO_DECIMAL_WHOLE_UNIT.has(c)) return BigInt(Math.round(amount / 100));
  if (STRIPE_WHOLE_UNIT_TWO_DECIMAL.has(c)) return BigInt(amount) * 100n;
  return BigInt(amount);
}

/** Reads each kind of event object at the pinned version, by id. */
const READ_EVENT_OBJECT: Record<string, (s: Stripe, id: string) => Promise<unknown>> = {
  charge: (s, id) => s.charges.retrieve(id),
  payment_intent: (s, id) => s.paymentIntents.retrieve(id),
  refund: (s, id) => s.refunds.retrieve(id),
  dispute: (s, id) => s.disputes.retrieve(id),
  payment_method: (s, id) => s.paymentMethods.retrieve(id),
  setup_intent: (s, id) => s.setupIntents.retrieve(id),
  mandate: (s, id) => s.mandates.retrieve(id),
};

/**
 * Recorded, never booked. They read only the object id and our ownership tag, which
 * are the same in every API version, so they cost no read. `charge.updated` and
 * `payment_intent.created` are also the two busiest event types.
 */
const RECORD_ONLY_TYPES = new Set<string>([
  "charge.updated",
  "intent.created",
  "settlement.processed",
  "settlement.failed",
  "reserve.hold.updated",
  "fraud_warning.created",
  "review.opened",
  "review.closed",
]);

/** Map a Stripe API path to our normalized `operation` label for gateway_request_logs. */
function deriveOperation(path: string | undefined): string {
  if (!path) return "unknown";
  if (path.includes("/v1/payment_intents")) return "payment_intent";
  if (path.includes("/v1/refunds")) return "refund";
  if (path.includes("/v1/customers")) return "ensure_customer";
  if (path.includes("/v1/payment_methods")) return "vault";
  return path;
}

/**
 * Instances we've already wired `request`/`response` listeners onto — guards
 * against double-attaching if a StripeProvider is ever constructed more than
 * once around the same underlying `Stripe` client.
 */
const instrumented = new WeakSet<Stripe>();

interface PendingStripeRequest {
  startedAt: number;
  businessId: string | null;
  gatewayAccountId: string | null;
  source: string | null;
  actor: string | null;
}

/**
 * Wire the stripe-node SDK's own `request`/`response` event emitters so every
 * outbound Stripe HTTP call lands one row in `gateway_request_logs`, same as
 * providerFetch(...) does for razorpay/paypal. stripe-node owns its HTTP
 * transport internally, so there's no fetch/undici call site to intercept —
 * these events are the SDK's supported instrumentation hook.
 *
 * Correlation: stripe-node emits exactly one `request` then exactly one
 * `response` per HTTP call (the `response` event fires for HTTP error
 * statuses too, not just 2xx — Stripe API errors still produce a response).
 * We key a pending-request map by method+path+idempotency_key (idempotency
 * keys are per-call in this codebase — see charge()/refund() below — so the
 * triple is unique for any calls in flight concurrently). request_start_time
 * from the request event doubles as a fallback duration source, but we prefer
 * the SDK-reported `elapsed` on the response event.
 *
 * ALS note: stripe-node emits `request` synchronously from within the
 * `paymentIntents.create(...)` call (i.e. still on the caller's async chain),
 * so ALS context (currentGatewayLogContext/currentEventContext) IS visible
 * there. The `response` event fires later, from the HTTP client's own
 * callback chain — by inspection of stripe-node's RequestSender, that later
 * callback is NOT guaranteed to run within the original ALS subtree (it's
 * scheduled off the underlying http/https response's 'end' event, a separate
 * async boundary Node's AsyncLocalStorage does not implicitly re-enter
 * unless the emitter itself was constructed inside the store — it isn't; the
 * Stripe client is a long-lived singleton built once per gateway account).
 * So we capture the ALS context explicitly on `request` and thread it through
 * to the logGatewayRequest call at `response` time, rather than relying on
 * ambient ALS lookup inside logGatewayRequest.
 */
function instrumentStripeClient(stripe: Stripe): void {
  if (instrumented.has(stripe)) return;
  instrumented.add(stripe);

  const pending = new Map<string, PendingStripeRequest>();
  const keyFor = (e: { method?: string; path?: string; idempotency_key?: string }) =>
    `${e.method ?? ""} ${e.path ?? ""} ${e.idempotency_key ?? ""}`;

  stripe.on("request", (event: Stripe.RequestEvent) => {
    const logCtx = currentGatewayLogContext();
    const evtCtx = currentEventContext();
    pending.set(keyFor(event), {
      startedAt: Date.now(),
      businessId: logCtx?.businessId ?? null,
      gatewayAccountId: logCtx?.gatewayAccountId ?? null,
      source: evtCtx?.source ?? null,
      actor: evtCtx?.actor ?? null,
    });
  });

  stripe.on("response", (event: Stripe.ResponseEvent) => {
    const key = keyFor(event);
    const ctx = pending.get(key);
    pending.delete(key);
    // Headers/bodies come from the capturing HTTP client below, keyed on the same
    // request; the SDK events carry none of that (only method/path/status/elapsed).
    const captured = takeCapture(event.method, event.path);
    logGatewayRequest({
      gatewayKey: "stripe",
      operation: deriveOperation(event.path),
      method: event.method ?? "POST",
      url: `https://api.stripe.com${event.path ?? ""}`,
      status: event.status ?? null,
      durationMs: Math.round(event.elapsed ?? Date.now() - (ctx?.startedAt ?? Date.now())),
      businessId: ctx?.businessId ?? null,
      gatewayAccountId: ctx?.gatewayAccountId ?? null,
      source: ctx?.source ?? null,
      actor: ctx?.actor ?? null,
      requestHeaders: captured?.requestHeaders,
      requestBody: captured?.requestBody,
      responseHeaders: captured?.responseHeaders,
      responseBody: captured?.responseBody,
    });
  });
}

/**
 * Stripe is the only adapter that does not go through `providerFetch` — stripe-node
 * owns its transport — and the SDK's `request`/`response` events expose **no headers
 * and no bodies**. So every Stripe row in `gateway_request_logs` had all four payload
 * columns null (measured 2026-08-01: 174/174 rows), while RazorPay and PayPal stored
 * them in full. A gateway-request-log page has to show the same four for a Stripe call
 * as for any other gateway.
 *
 * Fix: hand stripe-node a fetch that captures the real bytes on the way past. The
 * capture is stashed here and picked up by the `response` handler, which is where the
 * row is written (it has the business/account context and the SDK's own timing).
 */
interface StripeCapture {
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
}

/** method+path → capture, consumed by the `response` handler. */
const captures = new Map<string, StripeCapture[]>();
const captureKey = (method: string | undefined, path: string | undefined) =>
  `${(method ?? "POST").toUpperCase()} ${path ?? ""}`;

function takeCapture(
  method: string | undefined,
  path: string | undefined,
): StripeCapture | undefined {
  const key = captureKey(method, path);
  const queue = captures.get(key);
  if (!queue?.length) return undefined;
  const first = queue.shift();
  if (!queue.length) captures.delete(key);
  return first;
}

function headerRecord(h: RequestInit["headers"]): Record<string, unknown> {
  if (!h) return {};
  if (typeof Headers !== "undefined" && h instanceof Headers) return Object.fromEntries(h);
  if (Array.isArray(h)) return Object.fromEntries(h);
  return h as Record<string, unknown>;
}

/**
 * A `fetch` that records each Stripe call, then behaves exactly like the real one.
 * Never let logging break a payment: any failure inside the capture is swallowed and
 * the original response/error is returned untouched.
 */
const capturingFetch: typeof fetch = async (input, init) => {
  // Never follow a redirect with the secret key on it; the SDK treats the throw as a
  // connection error, so the outcome stays unknown rather than failed.
  const res = await fetch(input, { ...init, redirect: "manual" });
  if (res.status >= 300 && res.status < 400)
    throw new Error(`Stripe answered ${res.status}. Redirects are not followed.`);
  try {
    const url = new URL(typeof input === "string" ? input : String(input));
    const key = captureKey(init?.method, url.pathname + (url.search || ""));
    // clone() so the SDK still gets an unread body.
    const text = await res.clone().text();
    const entry: StripeCapture = {
      requestHeaders: redactHeaders(headerRecord(init?.headers)),
      requestBody: redactBody(typeof init?.body === "string" ? init.body : undefined),
      responseHeaders: redactHeaders(Object.fromEntries(res.headers)),
      responseBody: redactBody(text),
    };
    captures.set(key, [...(captures.get(key) ?? []), entry]);
    // Never grow without bound if a `response` event is ever missed.
    if ((captures.get(key)?.length ?? 0) > 8) captures.get(key)!.shift();
  } catch {
    /* capture is best-effort; the call itself already succeeded */
  }
  return res;
};

/** Map a Stripe card-error code to our normalized, dunning-aware failure code. */
/**
 * Describe a Stripe PaymentMethod in our display vocabulary.
 *
 * Cards expose brand/last4/expiry; bank debits (ACH `us_bank_account`, SEPA
 * `sepa_debit`) have no expiry and carry the bank name as the "brand" plus the
 * account's last4. Reading `pm.card` unconditionally (the previous behavior) left
 * every non-card method with an empty display and a wrong `type: 'card'`, which in
 * turn broke method-based routing.
 */
export function describeStripePaymentMethod(
  pm: Stripe.PaymentMethod,
): ProviderPaymentMethodRef["display"] {
  switch (pm.type) {
    case "us_bank_account":
      return {
        type: "us_bank_account",
        brand: pm.us_bank_account?.bank_name ?? undefined,
        last4: pm.us_bank_account?.last4 ?? undefined,
      };
    case "sepa_debit":
      return {
        type: "sepa_debit",
        brand: pm.sepa_debit?.bank_code ?? undefined,
        last4: pm.sepa_debit?.last4 ?? undefined,
      };
    /**
     * READING one of these is kept even though we no longer let anyone REQUEST one
     * (see `METHOD_TYPE_MAP`). Describing an instrument is not claiming to sell it: an
     * imported or legacy pm can still arrive, and the alternative is the default branch
     * calling a UK direct debit a "wallet". Classification follows reality; the request
     * vocabulary is where support is declared.
     */
    case "bacs_debit":
      return {
        type: "bank_transfer",
        brand: "Bacs Direct Debit",
        last4: (pm as any).bacs_debit?.last4 ?? undefined,
      };
    case "au_becs_debit":
      return {
        type: "bank_transfer",
        brand: "BECS Direct Debit",
        last4: (pm as any).au_becs_debit?.last4 ?? undefined,
      };
    case "acss_debit":
      return {
        type: "bank_transfer",
        brand: "Pre-Authorized Debit (PAD)",
        last4: (pm as any).acss_debit?.last4 ?? undefined,
      };
    case "card": {
      const walletType = (pm.card as any)?.wallet?.type;
      const brand =
        walletType === "apple_pay"
          ? "Apple Pay"
          : walletType === "google_pay"
            ? "Google Pay"
            : walletType === "link"
              ? "Stripe Link"
              : pm.card?.brand;
      // AVS/CVC verdicts (0245) — `checks` is null for a non-card pm and its three
      // fields are independently nullable (Stripe never attempted / can't attempt
      // one). Lowercased defensively; Stripe already sends lowercase snake_case.
      // Where the card was ISSUED, which RBI's e-mandate rules turn on and which we
      // discarded until 2026-09-12 — the engine inferred "Indian card" from an INR
      // amount instead. Stripe shows this as "Origin" in its own dashboard.
      const issuerCountry = pm.card?.country?.toUpperCase();
      // The rest of what the same read already returned and we discarded. `funding` is
      // Stripe's own vocabulary (credit | debit | prepaid | unknown) and is stored
      // verbatim rather than re-spelled. `iin` is available here and deliberately NOT
      // taken — see migration 0251.
      const instrumentFunding = pm.card?.funding;
      const issuerName = pm.card?.issuer ?? undefined;
      const instrumentFingerprint = pm.card?.fingerprint ?? undefined;
      const threeDSecureSupported = pm.card?.three_d_secure_usage?.supported;
      const checks = pm.card?.checks;
      const avsLine1Check = checks?.address_line1_check?.toLowerCase();
      const avsPostalCheck = checks?.address_postal_code_check?.toLowerCase();
      const cvcCheck = checks?.cvc_check?.toLowerCase();
      return {
        type: "card",
        brand,
        last4: pm.card?.last4,
        expMonth: pm.card?.exp_month,
        expYear: pm.card?.exp_year,
        // Omitted rather than null when Stripe said nothing: undefined means UNKNOWN,
        // and a stored null that later reads as "not India" is the error this guards.
        ...(issuerCountry ? { issuerCountry } : {}),
        ...(instrumentFunding ? { instrumentFunding } : {}),
        ...(issuerName ? { issuerName } : {}),
        ...(instrumentFingerprint ? { instrumentFingerprint } : {}),
        ...(typeof threeDSecureSupported === "boolean" ? { threeDSecureSupported } : {}),
        avsLine1Check,
        avsPostalCheck,
        cvcCheck,
        // Only stamped when at least one verdict actually arrived — otherwise
        // this would assert "checked" for a payload that said nothing.
        ...(avsLine1Check || avsPostalCheck || cvcCheck ? { avsCheckedAt: new Date() } : {}),
      };
    }
    default:
      // Some other Stripe instrument (wallet, redirect method, …). We have no
      // canonical token for it, so classify as a wallet rather than lying "card",
      // and keep Stripe's own type in `brand` so it stays visible to operators.
      return { type: "wallet", brand: pm.type };
  }
}

/**
 * True when a Stripe error means "the thing you asked me to remove is already
 * gone" — the only outcome `deletePaymentMethod` may swallow to stay idempotent.
 * Stripe answers a re-detach with a 400 `invalid_request_error` (no `code`), not
 * `resource_missing`, so the message has to be matched too.
 */
function isStripeAlreadyGone(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number; message?: string };
  if (e?.code === "resource_missing") return true;
  return (
    e?.statusCode === 400 &&
    /previously (been )?detached|not attached to a customer|no attached payment method/i.test(
      e?.message ?? "",
    )
  );
}

/**
 * A description Stripe will accept, because on an INDIAN account it is mandatory.
 *
 * Stripe rejects a cross-border ("export") PaymentIntent from a `country=IN` account
 * that carries no description:
 *
 *   "As per Indian regulations, export transactions require a description."
 *   https://stripe.com/docs/india-exports
 *
 * Measured 2026-08-13 creating a USD payment intent on our own test account — it 400s
 * before any money moves. The sibling half of this rule (name + billing address on the
 * customer) was already handled in `ensureCustomer`; the description was not, and it
 * only bites the INTENT path: `collectInvoice` always passes one, so renewals never
 * hit it, which is why it survived.
 *
 * The fallback is deliberately generic rather than invented detail — the regulation
 * wants a non-empty purpose on the transaction, and a caller-supplied description
 * always wins. Applied to every account, not just Indian ones: a constant, honest
 * label costs nothing elsewhere, and branching on the account country would mean
 * fetching it on every charge to save a field Stripe is happy to receive.
 */
function exportSafeDescription(description: string | undefined, fallback: string): string {
  const d = description?.trim();
  return d && d.length > 0 ? d : fallback;
}

/**
 * THE REASON A STRIPE DECLINE ACTUALLY GAVE — `decline_code` first, `code` second.
 *
 * ⚠️ Both of the callers below used to pass `err.code`, and that DISCARDED the reason.
 * On a card decline Stripe sets `code` to the generic `"card_declined"` and puts the
 * issuer's actual verdict in `decline_code`: `stolen_card`, `expired_card`,
 * `insufficient_funds`, `authentication_required`. `StripeCardError.decline_code` is a
 * declared readonly property (stripe 22.2.2, `Error.d.ts:43`), so it is always there to
 * read — nothing was stopping us.
 *
 * The consequence was that the shared decline table could not do its job on these two
 * paths however correct it was: every card decline normalised to `card_declined` and
 * stayed retriable, so a STOLEN card was retried through the dunning ladder, an expired
 * card never moved collection to the backup, and an AFA `authentication_required` was
 * invisible. The webhook path at the bottom of this file already read
 * `decline_code ?? code ?? failure_code ?? outcome.reason`, so the same gateway answered
 * differently depending on which of our own paths observed it.
 *
 * `||` rather than `??` deliberately: `decline_code` is typed `string` on
 * `StripeCardError`, so an empty string is representable and must fall through to `code`
 * rather than be treated as a reason.
 */
function stripeDeclineReason(err: {
  code?: string | null;
  decline_code?: string | null;
}): string | undefined {
  return err.decline_code || err.code || undefined;
}

/**
 * Everything the decline RULES can read, from one Stripe error shape (#69 stage 1).
 *
 * `stripeDeclineReason` collapses two fields into one string, which is all a dictionary
 * lookup could use. The rule engine matches on the message and the category too — that is
 * how "No such PaymentMethod" becomes `payment_method_not_found` instead of a generic
 * code that gets retried against an instrument Stripe has just said is gone.
 *
 * `code` deliberately keeps `decline_code` FIRST: on a card decline `err.code` is the
 * generic `card_declined` and the issuer's real reason is in `decline_code`.
 *
 * `networkMessage` and `recommendationCode` come from the CHARGE's `outcome`, not from
 * the error and not from the intent — which is why `charge()` expands `latest_charge`.
 * Remove that expand and these go quietly null: the rules that read them stop matching,
 * nothing throws, and the network's do-not-retry instruction is silently disobeyed again.
 *
 * ⚠️ They shipped INERT for a day (2026-09-06) because I looked for these fields on the
 * error object, did not find them, and concluded the SDK did not expose them. It does —
 * `Charge.Outcome.network_decline_code`, `network_advice_code`, `advice_code`, `reason`.
 * The rules were right; the sourcing was missing, and "I could not find it" was recorded
 * as "it is not there".
 */
/**
 * The charge's `outcome`, when the intent came back with `latest_charge` expanded.
 *
 * Stripe returns `latest_charge` as an ID unless asked otherwise, so this is null on any
 * path that did not request the expansion — which is a real state, not a bug, and the
 * rules that read these fields simply do not match.
 */
function stripeOutcome(pi: unknown): Stripe.Charge.Outcome | null {
  const charge = (pi as { latest_charge?: unknown } | null | undefined)?.latest_charge;
  return charge && typeof charge === "object" && "outcome" in charge
    ? ((charge as Stripe.Charge).outcome ?? null)
    : null;
}

/** The card network of the expanded `latest_charge`, when there is one. */
function stripeCardBrand(pi: unknown): string | null {
  const charge = (pi as { latest_charge?: unknown } | null | undefined)?.latest_charge;
  return charge && typeof charge === "object"
    ? ((charge as Stripe.Charge).payment_method_details?.card?.brand ?? null)
    : null;
}

const stripeDeclineSignal = (err: {
  code?: string | null;
  decline_code?: string | null;
  message?: string | null;
  type?: string | null;
  payment_intent?: unknown;
}): DeclineSignal => {
  const outcome = stripeOutcome(err.payment_intent);
  return {
    code: stripeDeclineReason(err),
    declineCode: err.decline_code ?? null,
    message: err.message ?? null,
    category: err.type ?? null,
    /**
     * `network_decline_code` first: it is the network's own reason
     * ("previously_declined_do_not_retry"). `reason` is Stripe's summary of the same
     * event and carries "highest_risk_level" when Stripe itself blocked the charge, so
     * the two together cover both rules without either shadowing the other.
     */
    networkMessage: outcome?.network_decline_code ?? outcome?.reason ?? null,
    /** The 2-digit network advice code — decline rules match e.g. "03" on this. */
    recommendationCode: outcome?.network_advice_code ?? outcome?.advice_code ?? null,
    // Advice codes are per network; the MAC waits apply to Mastercard only.
    cardBrand: stripeCardBrand(err.payment_intent),
  };
};

/**
 * The largest per-debit ceiling an India CARD mandate can register, in paise (₹10,00,000).
 *
 * ⚠️ A LOCAL COPY on purpose, pinned by a test rather than imported. Providers are a lower
 * layer than modules and must not import from them — `providers/razorpay.ts` holds the same
 * figure for the same reason (`MAX_MANDATE_MAX_AMOUNT`), and
 * `MANDATE_RAIL_MAX_CEILING_MINOR.card` in `payment-methods/mandate-afa.ts` is the module
 * layer's copy. `test/unit/mandate.test.ts` pins them together, so a cap corrected in one
 * place cannot silently disagree with the others.
 *
 * It is a property of the RAIL, not of a gateway: RBI/NPCI govern what an India card
 * e-mandate may register, which is why RazorPay and Stripe carry the same number. Stripe's
 * own API maximum has not been measured separately — if it is lower, this clamp is still
 * safe (it only ever reduces the request) and the measured figure should replace it.
 */
export const MAX_INDIA_CARD_MANDATE_MINOR = 100_000_000n;

/**
 * Stripe's decline vocabulary → the canonical tokens dunning routes on.
 *
 * ── WHY THIS IS NO LONGER A LOCAL SWITCH ─────────────────────────────────────────────
 * It was a five-case switch that passed everything else through with `retriable: true`,
 * and so never consulted `decline-codes.ts`'s `TERMINAL` set. Measured 2026-09-04 by
 * feeding the same code to both paths: **five declines diverged, all one way.**
 * `stolen_card`, `lost_card`, `fraudulent`, `pickup_card` and
 * `revocation_of_authorization` were `retriable: true` here and `false` on RazorPay — a
 * card reported STOLEN was retried through the dunning ladder on Stripe and treated as a
 * hard decline on RazorPay. Same rail, same regulation, two answers.
 *
 * The AFA tokens looked aligned only by accident: the old default passed unknown provider
 * codes through verbatim, and Stripe's spelling happens to equal our token for
 * `authentication_required`. Any code whose name differed reached a policy with no case
 * for it — `generic_decline` being the common one, which took the liberal retry default
 * and burned a dunning schedule on a decline the issuer repeats identically.
 *
 * Two deliberate improvements come with the move, both from tokens the policy already
 * handles better than this switch did: `incorrect_cvc` no longer collapses into
 * `card_declined` (the ladder parks it with "re-entry / new card fixes it"), and the
 * merchant-configuration refusals map to `recurring_not_enabled`, which parks for a human
 * rather than retrying. `expired_card` keeps its non-retriable answer, now from TERMINAL
 * rather than from a special case in `normalizeStripeDecline` — that case also threw away
 * the rule id, which is what a merchant override keys on.
 */
// `NormalizedDecline`, not a narrowed `{ code, retriable }`: the narrow annotation was
// silently dropping `message`, `exposedToPayer` and `ruleId` at the type level, so every
// read of them below was an error and a rule's own sentence could never reach a payer.
const normalizeFailure = (input: string | DeclineSignal | undefined): NormalizedDecline =>
  normalizeStripeDecline(input);

/**
 * A Stripe PaymentIntent → our ChargeResult, shared by `charge()` (confirm) and
 * `consumeIntent()` (capture). Both calls answer with the same object in the same
 * states, so mapping it twice was only ever a way for the two paths to drift.
 */
/** Bank debits Stripe lets us cancel while `processing` (Payment Intents lifecycle docs). */
const STRIPE_CANCELABLE_DEBITS: ReadonlySet<string> = new Set([
  "us_bank_account",
  "acss_debit",
  "au_becs_debit",
  "bacs_debit",
  "nz_bank_account",
  "sepa_debit",
]);

/**
 * How far past `createdAfter` a lost charge is looked for. `createdAfter` is the attempt
 * less 10 min of clock skew; a create is answered or abandoned within the SDK's 80 s
 * timeout and two retries. One hour covers both with room, and keeps a later attempt
 * on the same invoice out of the match.
 */
const STRIPE_LOCATE_WINDOW_SECONDS = 3600;
/** Pages of 100 the list confirmation reads before it gives up on a definite answer. */
const STRIPE_LOCATE_MAX_PAGES = 50;

/** Stripe's `payment_method_details.type` / PaymentMethod `type` → our method type. */
const STRIPE_METHOD_USED: Readonly<Record<string, string>> = {
  card: "card",
  us_bank_account: "us_bank_account",
  sepa_debit: "sepa_debit",
  bacs_debit: "bacs_debit",
  au_becs_debit: "au_becs_debit",
  nz_bank_account: "nz_becs_debit",
  acss_debit: "acss_debit",
  paypal: "paypal",
  payto: "payto",
};

/**
 * What paid (`ChargeResult.methodUsed`): the expanded charge, else the expanded
 * PaymentMethod, else the intent's only allowed type. Unknown otherwise.
 */
export function stripeMethodUsed(
  pi: Pick<Stripe.PaymentIntent, "latest_charge" | "payment_method" | "payment_method_types">,
): string | undefined {
  const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  const pm = typeof pi.payment_method === "object" ? pi.payment_method : null;
  const only = pi.payment_method_types?.length === 1 ? pi.payment_method_types[0] : undefined;
  const t = charge?.payment_method_details?.type ?? pm?.type ?? only;
  const wallet = charge?.payment_method_details?.card?.wallet?.type;
  if (t === "card" && (wallet === "apple_pay" || wallet === "google_pay")) return wallet;
  return t ? STRIPE_METHOD_USED[t] : undefined;
}

const methodUsedOf = (pi: Parameters<typeof stripeMethodUsed>[0]) => {
  const m = stripeMethodUsed(pi);
  return m ? { methodUsed: m } : {};
};

export function chargeResultFromPaymentIntent(pi: Stripe.PaymentIntent): ChargeResult {
  if (pi.status === "succeeded") {
    return { status: "succeeded", providerChargeId: pi.id, ...methodUsedOf(pi), raw: pi };
  }
  if (pi.status === "requires_action") {
    /**
     * INDIA: `requires_action` does NOT mean "the buyer must act".
     *
     * Every India e-mandate debit parks here to serve the RBI pre-debit notification,
     * and `card_await_notification.customer_approval_required` is Stripe stating which
     * kind of wait this is. Measured 2026-09-10 (`verify:stripe-india-afa-live`): a ₹100
     * debit came back `false`, waited five minutes, and succeeded untouched. Flattening
     * that to an empty `data` was how the engine came to light an approval CTA on
     * payments nobody had to approve — the same conflation `stale-pending.ts` already
     * names for the webhook shape (`processing.card.customer_notification`).
     *
     * Only ever set from a boolean Stripe actually sent: an absent field means the shape
     * carries no statement, and the engine's fallback must stay in charge of those.
     */
    const notify = pi.next_action?.card_await_notification;
    const data: Record<string, unknown> = {};
    if (typeof notify?.customer_approval_required === "boolean")
      data.approvalRequired = notify.customer_approval_required;
    if (typeof notify?.charge_attempt_at === "number")
      data.chargeAttemptAt = notify.charge_attempt_at;
    return {
      status: "requires_action",
      providerChargeId: pi.id,
      nextAction: { type: pi.next_action?.type ?? "unknown", data },
      ...methodUsedOf(pi),
      raw: pi,
    };
  }
  return { status: "pending", providerChargeId: pi.id, ...methodUsedOf(pi), raw: pi };
}

/**
 * A PaymentIntent we READ (a poll or a lookup) → the charge verdict. `canceled` and a
 * refused confirm are failures; everything else is `chargeResultFromPaymentIntent`.
 */
function chargeResultFromReadIntent(pi: Stripe.PaymentIntent): ChargeResult {
  if (pi.status === "canceled") {
    // A cancellation carries no decline CODE — `cancellation_reason` is `abandoned` /
    // `duplicate` / `requested_by_customer`, which is not our vocabulary and would
    // become a bogus normalized code if fed to `normalizeFailure`. So normalize from
    // nothing (the liberal `charge_failed`/retriable default the synchronous path
    // uses for a decline it cannot classify) and keep Stripe's own reason as the
    // provider code, where an operator can match it against Stripe's docs.
    const f = normalizeFailure(undefined);
    return {
      status: "failed",
      providerChargeId: pi.id,
      failure: {
        code: f.code,
        ...(pi.cancellation_reason ? { providerCode: pi.cancellation_reason } : {}),
        message: `Stripe reports this PaymentIntent as canceled${pi.cancellation_reason ? ` (${pi.cancellation_reason})` : ""}`,
        retriable: f.retriable,
        ...(f.retryAfterMs ? { retryAfterMs: f.retryAfterMs } : {}),
      },
      ...methodUsedOf(pi),
      raw: pi,
    };
  }
  if (pi.status === "requires_payment_method" && pi.last_payment_error) {
    const err = pi.last_payment_error;
    const f = normalizeFailure(stripeDeclineSignal(err));
    return {
      status: "failed",
      providerChargeId: pi.id,
      failure: {
        code: f.code,
        ...(err.code ? { providerCode: err.code } : {}),
        message: f.message ?? err.message ?? "Stripe refused this payment",
        retriable: f.retriable,
        ...(f.retryAfterMs ? { retryAfterMs: f.retryAfterMs } : {}),
      },
      ...methodUsedOf(pi),
      raw: pi,
    };
  }
  // succeeded / requires_action / everything still in flight. Shared with `charge()`
  // and `consumeIntent()` so a swept outcome is byte-identical to a delivered one.
  return chargeResultFromPaymentIntent(pi);
}

/**
 * A Stripe Mandate → our `ProviderMandate`, i.e. what the buyer ACTUALLY authorized.
 *
 * The Stripe twin of `describeRazorpayMandate`, and it exists for the same reason:
 * we asked for a ceiling (`deriveMandateCeiling`) and the gateway registered one.
 * The number that decides whether a renewal can be collected is Stripe's, not ours.
 *
 * ── Where the ceiling lives ──────────────────────────────────────────────────
 * An earlier version of this adapter asserted that "Stripe publishes no documented
 * per-debit cap field on this object" and read no amount at all. That was WRONG, and
 * it is why `payment_methods.mandate_max_amount_minor` was permanently NULL on every
 * Stripe account: the whole mandate subsystem (`mandateRefusal`, the portal's
 * "up to ₹X per charge", the checkout re-authorisation gate) is driven by that column
 * and therefore never fired. The Mandate object carries the amount in three places,
 * checked here in the order Stripe populates them:
 *
 *   - `multi_use.amount` / `.currency` — a repeated-debit mandate. This is what an
 *     India card e-mandate created with `card.mandate_options.amount_type = 'maximum'`
 *     becomes, and it is the case that matters to us.
 *   - `payment_method_details.<rail>.amount` (+ `amount_type`) — the rails that
 *     denominate the cap on their own sub-hash: `upi`, `payto`, `pix`. ⚠️ Only an
 *     `amount_type` of `maximum` is a CEILING. `fixed` means "future debits are
 *     exactly this", which is a different promise; treating it as a ceiling would let
 *     a smaller-than-fixed debit through the pre-flight and be refused at the gateway
 *     anyway. Both are stored, because both make any LARGER debit fail — but see the
 *     rail note below.
 *   - `single_use.amount` / `.currency` — a one-shot authorization. Its "ceiling" is
 *     the exact amount it was raised for.
 *
 * `payment_method_details.card` is an EMPTY hash in Stripe's schema (verified against
 * the pinned `stripe@22` typings) — an India CARD e-mandate reports its amount via
 * `multi_use`, not via the card sub-hash. That is why the earlier reading looked
 * correct from the card side and was still wrong.
 *
 * Returns undefined when the object carries nothing we can use, so an instrument with
 * no mandate is never represented as a mandate with unknown fields.
 */
export function describeStripeMandate(
  m: Stripe.Mandate | null | undefined,
  /**
   * The `mandate_options` Stripe ECHOED on the intent that minted this mandate, used
   * as the ceiling source of last resort.
   *
   * ── MEASURED 2026-09-04 (three retrieves, ALL test mode) ───────────────────────
   * The comment above used to say the amount arrives on the Mandate object, in
   * `multi_use.amount` for an India card e-mandate. The read-back leg was explicitly
   * flagged as unmeasured (see `indiaCardMandateOptions`, which asked for exactly this
   * experiment before trusting the ceiling in production). It has now been run — an
   * India `tok_in` card vaulted through the portal, its e-mandate authorised in a real
   * browser, then `mandates.retrieve`:
   *
   *   { id: "mandate_…", status: "active", type: "multi_use",
   *     multi_use: {},                      ← EMPTY
   *     payment_method_details: { card: {}, type: "card" } }
   *
   * No amount, in any of the three places. That is THREE mandates, every one
   * `livemode: false` — thin evidence for a flat claim about Stripe, so what is asserted
   * here is the MEASUREMENT, not a law: on this account, in test mode, a card-rail Mandate
   * reported no ceiling, and reading it there yielded `undefined` forever while
   * `payment_methods.mandate_max_amount_minor` stayed NULL — the symptom the earlier fix
   * was written to cure, reappearing one level down. If live turns out to populate
   * `multi_use.amount`, the ordering below makes that HARMLESS rather than wrong, which is
   * what makes it safe to act on evidence this thin.
   *
   * The intent DOES hold it: the same SetupIntent echoed
   * `payment_method_options.card.mandate_options = { amount: 1500000, amount_type:
   * "maximum", currency: "inr", … }`. That is Stripe's own record of what it
   * registered, so it is authoritative rather than a guess at our own request — the
   * distinction the call site's comment cares about, and it survives Stripe accepting
   * a different ceiling from the one we asked for.
   *
   * Checked LAST, not first — and the reason is not API-version etiquette, it is that the
   * two numbers can legitimately DIFFER and the provider's is the true one. This echo is
   * our request as Stripe accepted it; the Mandate is what stands after any clamping.
   * `payment-methods/service.ts:753` already assumes exactly that, describing a re-vault's
   * fresher readback as "a ceiling the buyer's bank clamped" — and a clamped ceiling is
   * LOWER than we asked for. Preferring our own echo would then record a limit the bank
   * never granted and let `mandateRefusal` wave through a debit the gateway will refuse.
   * Mandate first is the safe direction; a future API version that populates it makes this
   * fallback dead weight rather than a wrong answer.
   *
   * ⚠️ `amount_type` is deliberately NOT read, so the column cannot distinguish "at most X"
   * from "exactly X". Reviewed and KEPT (2026-09-04): gating on `maximum` would turn a
   * known number into NULL for a `fixed` mandate, and per `invoicing/collection.ts:378` a
   * null ceiling means unknown, which SKIPS the pre-flight entirely — trading a small
   * imprecision for a total blind spot. A larger debit fails against a `fixed` mandate too,
   * so enforcing at that number is right; only a smaller-than-fixed debit is mis-permitted,
   * and that one is refused at the gateway anyway. The rail-hash branch above takes
   * `railHash?.amount` unconditionally for the same reason, so this matches the existing
   * treatment rather than inventing one. The real cost is the lost distinction: anyone who
   * needs to pre-flight a smaller-than-fixed debit must persist `amount_type` too.
   */
  intentMandateOptions?: { amount?: number | null; currency?: string | null } | null,
): ProviderMandate | undefined {
  if (!m) return undefined;
  const rail = m.payment_method_details?.type;
  // The rails that put the cap on their own sub-hash. Typed loosely on purpose: the
  // set grows with every Stripe API version (upi/payto/pix today), and a rail we have
  // not enumerated must fall through to "no amount reported", never to a wrong one.
  const railHash = (
    rail ? (m.payment_method_details as unknown as Record<string, unknown>)[rail] : undefined
  ) as { amount?: number | null; amount_type?: string | null } | undefined;
  const amountMinor =
    m.multi_use?.amount ??
    railHash?.amount ??
    m.single_use?.amount ??
    intentMandateOptions?.amount ??
    undefined;
  const currency =
    m.multi_use?.currency ?? m.single_use?.currency ?? intentMandateOptions?.currency ?? undefined;
  // Stripe's three statuses → the vocabulary `applyMandateUpdate` understands and
  // whose DEAD_MANDATE_STATUSES decides collectability. Kept identical to the
  // `mandate.updated` webhook mapping so a mandate read here and the same mandate
  // read from an event never disagree. `inactive` on a SINGLE-use mandate is the
  // ordinary end of a one-shot authorization ("previously used"), not a revocation.
  const isMultiUse = m.type === "multi_use" || (m.multi_use != null && m.single_use == null);
  const status =
    m.status === "active"
      ? "confirmed"
      : m.status === "pending"
        ? "initiated"
        : m.status === "inactive"
          ? isMultiUse
            ? "cancelled"
            : "spent"
          : undefined;
  const sepaReference = m.payment_method_details?.sepa_debit?.reference;
  const out: ProviderMandate = {
    ...(amountMinor != null ? { maxAmountMinor: fromStripeAmount(amountMinor, currency) } : {}),
    ...(amountMinor != null && currency ? { currency: currency.toUpperCase() } : {}),
    // The rail in Stripe's own words (`card`, `upi`, `sepa_debit`, `us_bank_account`,
    // …), matching how the RazorPay adapter keeps `upi`/`emandate`/`nach` raw:
    // settlement lag and authentication rules are properties of the rail, and
    // `debitNeedsBuyerAuthentication` keys off exactly this value.
    ...(rail ? { rail } : {}),
    ...(status ? { status } : {}),
    // SEPA's creditor reference is the only rail-specific mandate reference Stripe's
    // Mandate object documents; otherwise the mandate's own id is what a support
    // ticket needs.
    reference: sepaReference ?? m.id,
  };
  // Nothing but the id we already had ⇒ not worth representing as a mandate.
  if (out.maxAmountMinor == null && !out.rail && !out.status) return undefined;
  return out;
}

/**
 * ⚠️ A ceiling read off a mandate is only comparable to a debit if we know the
 * CURRENCY it is denominated in. `multi_use`/`single_use` carry one; the rail
 * sub-hashes (`upi`, `payto`) do not, and `mandateRefusal` skips the check when the
 * currencies disagree rather than guessing an FX rate. That is the correct
 * conservative direction — the gateway stays the authority — but it does mean a UPI
 * ceiling read without a currency is inert. Stripe UPI is not a rail we run today;
 * if it becomes one, the currency has to come from the SetupIntent that created the
 * mandate, not be assumed.
 */

/**
 * A Stripe card decline → our normalized failure ChargeResult. Same handling the
 * charge path has always used, so an intent capture that declines dunning-classifies
 * identically to a plain charge that declines.
 */
/**
 * Stripe's refusal for a debit that needs a mandate and has none.
 *
 * The message is the only distinguishing part: the CODE is the generic
 * `payment_intent_payment_attempt_failed`, shared with every other inline-confirm failure.
 * Documented and stable — "Please either provide the id of an existing mandate or create a
 * new mandate" — and matched here rather than in the caller because reading a gateway's
 * prose is an adapter's job, exactly like `stripeDeclineSignal`.
 *
 * Worth its own code because the REMEDY is specific and no retry reaches it: the customer
 * must authorize again. `collectInvoice` also writes the answer onto the instrument, so
 * the next debit is refused before Stripe is asked (see MANDATE_MISSING_STATUS).
 */
function isMissingMandateRefusal(message: string): boolean {
  return /parameter .?mandate.? is not provided or invalid/i.test(message);
}

/**
 * The rules' verdict on a THROWN `invalid_request_error`, when they have one.
 *
 * Completes #63. `decline-codes.ts` § 5 was written as the destination for this knowledge,
 * but the adapter kept asking a hardcoded `err.code ===` instead — so every rule in that
 * section except `payment_intent_payment_attempt_failed` was unreachable, and
 * `payment_intent_mandate_inactive` threw in production on 2026-09-10 (INV-100004) against
 * a rule that already existed. Adding another rule now needs no change here.
 *
 * Only the CODE is offered to the rules — never `stripeDeclineSignal`, whose `category`
 * would match the `invalid_request_error` catch-all and turn every one of our own bugs
 * into a booked decline. `undefined` means the rules do not name this code, and the caller
 * must throw.
 *
 * ⚠️ WE TAKE WHATEVER VERDICT THE RULES GIVE, not one particular token. It gated on
 * `gateway_request_rejected` alone until 2026-09-10, and that lost the remedy on the very
 * code that prompted this: production stores 30 rows of `payment_intent_mandate_invalid`,
 * which the table names `mandate_expired` — "the mandate lapsed, only a new one recovers
 * it", an outcome the CUSTOMER clears by re-authorising. Rejecting it here threw it into
 * the safety net, which books the generic `gateway_error` and sends an OPERATOR after a
 * problem only the customer can fix. Reaching the rules has to mean taking their answer.
 *
 * Recognition, not the answer's value, is therefore the test: a matched rule (`ruleId`) or
 * a code the legacy table names. Anything else is a code nothing in this repo has ever
 * seen, which is our bug — it still throws, and the attempt-loop catch books it retriably
 * as `gateway_error` so the invoice is never stranded either way.
 */
function classifiedThrowFailure(
  err: Stripe.errors.StripeInvalidRequestError,
): ChargeResult["failure"] | undefined {
  const f = normalizeFailure(err.code);
  const recognised = f.ruleId != null || (err.code != null && err.code in STRIPE_CODE_TABLE);
  if (!recognised) return undefined;
  // The missing-mandate refusal keeps its own code: the remedy is the customer authorizing
  // again, and MANDATE_MISSING_STATUS learning keys on it. It carries Stripe's prose and no
  // `ruleId` on purpose — the rule that matched the code says "a problem on our side",
  // which is the wrong sentence for this outcome and did not decide this code.
  if (isMissingMandateRefusal(err.message))
    return {
      code: "mandate_missing",
      providerCode: err.code,
      message: err.message,
      retriable: false,
    };
  return {
    code: f.code,
    providerCode: err.code,
    message: f.message ?? err.message,
    retriable: f.retriable,
    ...(f.retryAfterMs ? { retryAfterMs: f.retryAfterMs } : {}),
    ruleId: f.ruleId,
  };
}

/** The rules read this refusal as "the cardholder must authenticate" (3DS). */
export function isAuthenticationDecline(err: Stripe.errors.StripeCardError): boolean {
  return normalizeFailure(stripeDeclineSignal(err)).code === AUTHENTICATION_REQUIRED_CODE;
}

function chargeResultFromCardError(err: Stripe.errors.StripeCardError): ChargeResult {
  // `decline_code` FIRST — see `stripeDeclineReason`. `err.code` on a card decline is the
  // generic "card_declined"; the reason the issuer actually gave is in `decline_code`.
  const f = normalizeFailure(stripeDeclineSignal(err));
  const used = err.payment_method?.type ? STRIPE_METHOD_USED[err.payment_method.type] : undefined;
  return {
    status: "failed",
    providerChargeId: err.payment_intent?.id ?? "",
    ...(used ? { methodUsed: used } : {}),
    failure: {
      code: f.code,
      providerCode: err.code,
      // OUR sentence when a rule wrote one (#69 stage 2). A gateway's own text is
      // written for a developer reading an API response and it reaches a payer's
      // inbox unedited as `declineMessage`.
      message: f.message ?? err.message,
      retriable: f.retriable,
      ...(f.retryAfterMs ? { retryAfterMs: f.retryAfterMs } : {}),
      ruleId: f.ruleId,
    },
    raw: err,
  };
}

/**
 * A Stripe PaymentIntent status → our three-state `IntentRef.status`.
 *
 * Used on the DECLINE path, where the intent still exists at Stripe (a card error
 * leaves it `requires_payment_method`) and its real status must ride back with the
 * failure rather than being invented.
 */
function intentStatusFromStripe(status: string | undefined): IntentRef["status"] {
  if (status === "requires_capture" || status === "succeeded") return "authorized";
  if (status === "requires_action" || status === "requires_confirmation") return "requires_action";
  return "inited";
}

/**
 * True when Stripe refuses a cancel because the intent is ALREADY cancelled — the
 * only outcome `voidIntent` may swallow to stay idempotent. Stripe answers with a
 * 400 `invalid_request_error` whose message names the current status, so the message
 * has to be matched (same shape as `isStripeAlreadyGone` above). Deliberately narrow:
 * a refusal because the intent already SUCCEEDED is a real error — the money moved and
 * the caller must not be told the hold was released.
 */
function isStripeAlreadyCanceled(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number; message?: string };
  return (
    e?.statusCode === 400 && /status of canceled|already (been )?canceled/i.test(e?.message ?? "")
  );
}

/**
 * The metadata key every tmbilling-created Stripe object carries (#31).
 *
 * NOT a new convention: `ensureCustomer` has stamped and read back exactly this key
 * on CUSTOMERS since the vault-adoption check was written. This constant only names
 * the precedent so the money objects use the same key rather than a second one.
 */
export const STRIPE_OWNERSHIP_KEY = "tmbilling_ref";

/**
 * Metadata on a pay-now PaymentIntent: the buyer picks the method in Elements, and every
 * method except a card captures at confirm. Copied onto its Charge like any metadata.
 */
export const STRIPE_CAPTURE_KEY = "tmbilling_capture";
export const STRIPE_CAPTURE_ON_CONFIRM = "on_confirm";

/**
 * Did Stripe take this money at the buyer's confirm (automatic capture), rather than on a
 * capture call of ours? Reads the capture method Stripe applies to the method the buyer
 * USED, so `latest_charge` must be expanded. When the method cannot be read and a
 * per-method manual override exists, the answer is `false`: we cannot tell.
 */
export function stripeCapturedOnConfirm(pi: Stripe.PaymentIntent): boolean {
  if (pi.status !== "succeeded" && pi.status !== "processing") return false;
  const options = (pi.payment_method_options ?? {}) as Record<
    string,
    { capture_method?: string | null } | undefined
  >;
  const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  const used = charge?.payment_method_details?.type;
  if (!used && Object.values(options).some((o) => o?.capture_method === "manual")) return false;
  const effective = (used ? options[used]?.capture_method : null) ?? pi.capture_method;
  return effective !== "manual";
}

/** A Stripe PaymentIntent status → `FetchedIntent.status`. */
export function fetchedStatusFromStripe(
  status: string,
  capturedOnConfirm: boolean,
): FetchedIntent["status"] {
  switch (status) {
    case "requires_payment_method":
      return "inited";
    case "requires_confirmation":
    case "requires_action":
      return "requires_action";
    case "requires_capture":
      return "authorized";
    case "succeeded":
      return "consumed";
    // A bank debit in flight is money moving, not a hold. On a manual intent it is
    // neither, so we say we do not know.
    case "processing":
      return capturedOnConfirm ? "consumed" : "unknown";
    case "canceled":
      return "voided";
    default:
      return "unknown";
  }
}

/** Stripe refuses a capture because the intent is not `requires_capture`. */
function isStripeUnexpectedState(err: unknown): boolean {
  return (err as { code?: string })?.code === "payment_intent_unexpected_state";
}

/**
 * Statuses a PaymentIntent can be cancelled from with NOTHING held.
 *
 * Enumerated positively, and the default for an unlisted status is `undefined`
 * rather than `false`: a status this SDK version has never heard of must not be
 * turned into "no money was held" (`VoidIntentResult.held`). Stripe's cancellable
 * set is `requires_payment_method`, `requires_capture`, `requires_confirmation`,
 * `requires_action` and — rarely — `processing`; of those, only `requires_capture`
 * holds funds, and `processing` is an async rail with money genuinely in flight, so
 * it is deliberately absent from BOTH answers.
 */
const STRIPE_NO_HOLD_STATUSES = new Set([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
]);

/**
 * Was the buyer's money held, judged from the PaymentIntent as it stood BEFORE we
 * cancelled it (#30 → `VoidIntentResult.held`).
 *
 * ── Why the argument is the PRE-cancel intent ────────────────────────────────
 * The obvious implementation — read `status` / `amount_capturable` off the cancel
 * RESPONSE — cannot work, and this is measured against Stripe's own reference
 * (docs.stripe.com/api/payment_intents/cancel, fetched 2026-09-04): the documented
 * response body for a cancel is `"status": "canceled", "amount_capturable": 0`.
 * Cancel returns the POST-cancel object, so reading the discriminator off it reads
 * the answer to our own call and can only ever say "nothing was held" — which is
 * defect #21 restated rather than fixed. The docs sentence that makes
 * `requires_capture` the discriminator ("For PaymentIntents with a `status` of
 * `requires_capture`, the remaining `amount_capturable` is automatically refunded")
 * describes what cancel DOES, not what it reports.
 *
 * So the caller has to read the intent first. That is the same ordering the tmtest
 * reference enforces atomically (two narrow claims, where the status the void CLAIMED
 * is the only moment that separates an authorized hold from an abandoned checkout)
 * and the same ordering RazorPay's `heldBeforeVoid` uses.
 *
 * `amount_capturable > 0` is checked independently of the status so a future status
 * name cannot hide a hold: the money-side fact outranks the label.
 */
export function stripeHeldFromPreCancel(
  status: string | undefined,
  amountCapturable: number | null | undefined,
): boolean | undefined {
  if (status === "requires_capture") return true;
  if ((amountCapturable ?? 0) > 0) return true;
  if (status && STRIPE_NO_HOLD_STATUSES.has(status)) return false;
  return undefined;
}

/**
 * Stripe object kinds (`object` on every Stripe object) that EVERY one of our create
 * paths stamps with `STRIPE_OWNERSHIP_KEY`, and which may therefore answer `foreign`
 * when the tag is absent.
 *
 * ── Why this set exists rather than "does it have metadata?" ─────────────────
 * `ownership: 'foreign'` is a claim that the object belongs to a sibling product on
 * a shared gateway account. That claim is only sound for a kind we always tag: an
 * untagged object of a kind we sometimes fail to tag is OURS-but-unlabelled, and
 * calling it foreign would turn a money incident into a line nobody looks at — the
 * precise failure `NormalizedProviderEvent.ownership` warns about.
 *
 * Deliberately EXCLUDED, with the reason for each:
 *  · `payment_method` — a pm confirmed through Elements is created by STRIPE from the
 *    buyer's browser, not by any call of ours, so `vaultPaymentMethod` has nothing to
 *    stamp on that path (it only creates a pm from a legacy `tok_…`).
 *  · `setup_intent` — `createIntent({purpose:'setup'})` is tagged, but the legacy
 *    `initiateVaultSetup` path cannot be: `InitiateVaultSetupInput` carries no id of
 *    ours (checked 2026-09-04). Until it does, an untagged SetupIntent may be ours.
 *  · `payout`, `mandate`, `review`, `radar.early_fraud_warning` — Stripe's own
 *    objects, which we never create. Nothing about a remittance or a Radar hold is
 *    "another product's", so `foreign` would be meaningless for them.
 *
 * Adding a kind here is only correct once every create path for it stamps a ref.
 */
const STRIPE_TAGGED_OBJECT_KINDS = new Set(["payment_intent", "charge", "refund", "customer"]);

/** The `ownership` / `ownershipRef` / `providerObjectCreatedAt` triple, for spreading. */
export interface StripeOwnershipFields {
  ownership: "ours" | "foreign" | "unknown";
  ownershipRef?: string;
  providerObjectCreatedAt?: Date;
}

/**
 * Classify the gateway object an inbound event is about (#31).
 *
 * Three-way on purpose, and `unknown` is the default rather than `foreign`: reading
 * silence as "not ours" would turn a tagging regression into invisible money loss the
 * day a deploy stops stamping refs. Ownership is NEVER inferred from a local match —
 * that is the engine's job; this only reports what was read off the object.
 *
 * `created` is Stripe seconds (their whole API is), so ×1000. It is the OBJECT's
 * creation, not the event's: a capture that fires today can belong to an intent
 * created weeks before tagging shipped, and `occurredAt` would mark that historical
 * object foreign on no evidence at all.
 */
export function stripeOwnershipOf(obj: {
  object?: string;
  metadata?: Record<string, string> | null;
  created?: number | null;
}): StripeOwnershipFields {
  const createdAt =
    obj.created != null ? { providerObjectCreatedAt: new Date(obj.created * 1000) } : {};
  const ref = obj.metadata?.[STRIPE_OWNERSHIP_KEY];
  if (ref) return { ownership: "ours", ownershipRef: ref, ...createdAt };
  // A tagged kind whose metadata we READ and ours was absent. `metadata` is `{}` on a
  // Stripe object that supports it and has none set, so presence of the field — not
  // presence of a key — is what proves we actually looked.
  if (obj.metadata && STRIPE_TAGGED_OBJECT_KINDS.has(obj.object ?? ""))
    return { ownership: "foreign", ...createdAt };
  return { ownership: "unknown", ...createdAt };
}

/** The fields of a Stripe Refund we read. The same in every API version. */
interface StripeRefundLike {
  id: string;
  amount?: number | null;
  currency?: string | null;
  status?: string | null;
  metadata?: Record<string, string> | null;
}

/** A Refund as the engine books it. Null when the object carries no amount. */
export function stripeRefundRecord(r: StripeRefundLike): ProviderRefundRecord | null {
  if (r.amount == null) return null;
  const ref = r.metadata?.[STRIPE_OWNERSHIP_KEY];
  return {
    providerRefundId: r.id,
    amountMinor: fromStripeAmount(r.amount, r.currency),
    status:
      r.status === "succeeded"
        ? "succeeded"
        : r.status === "failed" || r.status === "canceled"
          ? "failed"
          : "pending",
    ...(ref ? { ownershipRef: ref } : {}),
  };
}

/**
 * Stripe adapter. Stripe does exactly two jobs here (BLUEPRINT ADR-001): vault
 * payment methods + execute charges/refunds. We never create Stripe
 * subscriptions/invoices — our engine owns those.
 */
/** Account country per secret-key hash — an account's country does not change. */
const ACCOUNT_COUNTRY_BY_KEY = new Map<string, Promise<string | null>>();

export class StripeProvider implements PaymentProvider {
  readonly key = "stripe" as const;
  readonly capabilities: ProviderCapabilities = {
    refunds: true,
    partialRefunds: true,
    currencies: [], // any Stripe-supported currency
    // Bank debits settle ASYNCHRONOUSLY (ACH/SEPA take days): a charge returns
    // `pending` → transaction `in_progress`, and the terminal outcome arrives only
    // as an inbound webhook (payment_intent.succeeded / .payment_failed). Enabling
    // them requires the inbound webhook path to be wired — see the gateway README.
    // `bank_transfer` covers Bacs / BECS / PAD: `describeStripePaymentMethod`
    // classifies all three under that canonical type, so that is the value
    // routing will see. Apple Pay / Google Pay / Link are NOT listed — they are
    // card presentations (we surface them as a card BRAND), and a pm backed by
    // one still has canonical type `card`. Listing them here would let a
    // merchant store an unroutable `method_types` value: `matchesMethod` in
    // gateway/router.ts compares against a pm's canonical type, so an account
    // restricted to `apple_pay` could never match a real charge. The richer
    // REQUEST vocabulary lives in METHOD_TYPE_MAP below.
    methods: ["card", "us_bank_account", "sepa_debit", "bank_transfer"],
    // Intents (C7). Both purposes are native here: a `setup` intent IS the
    // SetupIntent `initiateVaultSetup` has always created (the zero-amount
    // `seti_…` rows that list as payment intents), and a `payment` intent is
    // a manual-capture PaymentIntent. Stripe has a true void
    // (`paymentIntents.cancel`) that releases the hold without moving money, so
    // unlike RazorPay we can honestly advertise `intentVoid`.
    intents: true,
    intentPurposes: ["payment", "setup"],
    intentVoid: true,
    // A pay-now bank debit captures at confirm and sends no authorization webhook, so
    // the buyer's second leg must be able to ask (`fetchIntent`).
    intentStatus: true,
    // Stripe SAYS when a debit waits on the buyer — `requires_action` at call time,
    // `intent.requires_action` by webhook — so `stale-pending` must not guess from rail
    // and age. Guessing mislabels the 26-hour India pre-debit window, in which every
    // e-mandate debit sits whether or not anyone has to authenticate it.
    // Stripe's India page: above 15,000 INR OR the mandate's max, the pre-debit
    // notification carries an AFA link the buyer can tap. See the capability's docstring.
    afaLinkAboveMandateMax: true,
    // Stripe HAS a mandate model and reports the ceiling: `Mandate.multi_use.amount`
    // + `.currency` for a multi-use mandate (which is what an India card e-mandate
    // registered with `amount_type: 'maximum'` becomes), `Mandate.single_use.amount`
    // for a one-shot authorization, and `payment_method_details.upi.amount` /
    // `.payto.amount` for the rails that denominate it on their own sub-hash.
    // So a NULL ceiling on a Stripe instrument means UNKNOWN — an ordinary
    // card-on-file with no mandate rail — and never "no ceiling exists here".
    mandates: true,
    // The India recurring confirm takes a `mandate` parameter and is refused without it —
    // after the PaymentIntent exists, which is how a missing mandate becomes an orphan
    // rather than a decline. Lets the pre-flight answer instead of Stripe.
    perDebitMandateReference: true,
    // A bank debit can be cancelled while `processing` (`cancelPendingCharge`).
    pendingDebitCancel: true,
  };

  /**
   * Request vocabulary → Stripe's `payment_method_types` names. Deliberately
   * WIDER than `capabilities.methods`: this is what a caller may ASK to vault
   * (`method_type` on the vault-setup routes), whereas `capabilities.methods` is
   * the canonical instrument vocabulary routing matches on.
   */
  private static readonly METHOD_TYPE_MAP: Record<string, string> = {
    card: "card",
    apple_pay: "card",
    google_pay: "card",
    wallet: "card",
    us_bank_account: "us_bank_account",
    ach_debit: "us_bank_account",
    bank_transfer: "us_bank_account",
    sepa_debit: "sepa_debit",
    // NOT accepted: `bacs_debit`, `au_becs_debit`, `acss_debit`. Dropped 2026-09-05.
    // They were mapped here — so a caller could REQUEST one — while absent from
    // `capabilities.methods`, so no surface ever offered one and no lifecycle was ever
    // exercised. The gateway settings screen did offer them, as one "Direct Debit
    // (Bacs / BECS / PAD)" row sending `bank_transfer`, which this map folds onto
    // `us_bank_account`: it configured ACH under a UK/AU/CA label. Mapping a rail we
    // neither offer nor test is a claim of support, and the only thing it bought was a
    // control that lied. Add them back as themselves, in `capabilities.methods` and with
    // their own vault + settlement paths, or not at all.
    link: "link",
  };

  private mapMethodTypes(requested?: string[]): string[] {
    const mapped = (requested ?? ["card"])
      .map((m) => StripeProvider.METHOD_TYPE_MAP[m])
      .filter((m): m is string => Boolean(m));
    // Never send an empty list (Stripe would 400); fall back to card.
    return mapped.length > 0 ? [...new Set(mapped)] : ["card"];
  }

  private stripe: Stripe;
  private webhookSecret?: string;
  /** A second signing secret, accepted beside the first while an endpoint is replaced. */
  private webhookSecretNext?: string;
  private publishableKey?: string;
  /** Cache key for per-account facts; a hash so the map never holds the secret. */
  private readonly keyHash: string;

  constructor(
    secretKey: string,
    webhookSecret?: string,
    publishableKey?: string,
    webhookSecretNext?: string,
  ) {
    this.keyHash = createHash("sha256").update(secretKey).digest("hex");
    // Use the SDK's pinned API version (avoids hardcoding a version string).
    // The custom HTTP client is what makes Stripe calls log headers/bodies like every
    // other adapter — see `capturingFetch`.
    this.stripe = new Stripe(secretKey, {
      httpClient: Stripe.createFetchHttpClient(capturingFetch),
      // The SDK's own version of `PROVIDER_APP_NAME`: it folds this into the User-Agent,
      // which is the only channel any of these gateways has for "which app is calling".
      // Kept in step with the adapters on `providerFetch` so no gateway sees us as
      // anonymous while the others don't.
      appInfo: { name: PROVIDER_APP_NAME },
    });
    instrumentStripeClient(this.stripe);
    this.webhookSecret = webhookSecret;
    this.webhookSecretNext = webhookSecretNext;
    this.publishableKey = publishableKey;
  }

  /** Live connectivity check: a cheap authenticated GET that proves the secret
   *  key works before we ever try to charge. Unlike razorpay/paypal (hand-rolled
   *  auth over providerFetch), stripe-node owns auth internally — so this simply
   *  exercises the credential end-to-end. `balance.retrieve` touches no customer
   *  data and is available on every account. */
  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const balance = await this.stripe.balance.retrieve();
    return { ok: true, detail: `livemode=${balance.livemode}` };
  }

  /**
   * The buyer challenge descriptor Stripe always produces: confirm `clientSecret`
   * with Stripe.js. Shared by the vault-setup flow and by intents, because they are
   * the same handshake (see `BuyerAuthorization`) — one client-side renderer.
   */
  private clientSecretAuthorization(clientSecret: string): BuyerAuthorization {
    return {
      mode: "client_secret",
      clientSecret,
      ...(this.publishableKey ? { publishableKey: this.publishableKey } : {}),
    };
  }

  /**
   * Create a SetupIntent — the single gateway call behind BOTH `initiateVaultSetup`
   * (untracked vault flow) and `createIntent({ purpose: 'setup' })` (the same flow,
   * recorded as an intent with attempts). Kept in one place so the two can never
   * drift into asking Stripe for different things.
   *
   * `methodTypes` lets a business offer bank debits (ACH/SEPA) alongside cards;
   * unsupported names are dropped, default `card`. `usage: 'off_session'` is what
   * makes the resulting pm chargeable later for renewals.
   */
  /**
   * `payment_method_options.card.mandate_options` for an INDIA card e-mandate — the
   * REQUEST half of the mandate ceiling, and the reason there is anything to read back.
   *
   * A ceiling is not something an adapter can observe after the fact: Stripe mints a
   * Mandate with `amount_type: 'maximum'` only because the SetupIntent asked for one.
   * Before this, `InitiateVaultSetupInput.maxAmountMinor` / `CreateIntentInput`'s were
   * accepted and silently dropped, so every Stripe mandate was registered with no
   * ceiling at all and `describeStripeMandate` had nothing to find.
   *
   * ── Why the INR gate is not laziness ─────────────────────────────────────────
   * `mandate_options` with `supported_types: ['india']` is an RBI e-mandate
   * construction. Sending it on an ordinary US/EU card vault would attach an
   * amount/interval agreement to a plain card-on-file that has none — and every
   * caller passes a `maxAmountMinor` (`beginVaultSetup` derives one unconditionally),
   * so an ungated version would change the shape of EVERY Stripe vault in the product.
   * INR + the card rail is exactly the set where the mandate is real, and it is the
   * set `mandate-afa.ts` already reasons about.
   *
   * MEASURED 2026-08-30 against our Stripe test account (`accounts.retrieve()` reports
   * `country: IN`, `default_currency: inr` — it IS a Stripe India account): the
   * SetupIntent was accepted, and retrieving it echoed back
   * `payment_method_options.card.mandate_options = { amount: 2500000, amount_type:
   * "maximum", currency: "inr", interval: "sporadic", supported_types: ["india"] }`.
   * So Stripe stores the ceiling we register. The same call with `currency: 'USD'`
   * sent no `mandate_options` at all and also succeeded, which is the gate working.
   *
   * ⚠️ The READ-BACK half is not yet measured end-to-end. Confirming that SetupIntent
   * with an India test card (`tok_in`) returns `requires_action` +
   * `redirect_to_url` — the buyer's e-mandate authorisation page — and `mandate` stays
   * null until they complete it in a browser. So no live Mandate object has been
   * observed carrying `multi_use.amount`; `describeStripeMandate` is verified against
   * the pinned Stripe typings and its unit fixtures, not against a completed India
   * e-mandate. Finish that leg (browser-complete one `tok_in` setup, then
   * `mandates.retrieve`) before trusting the ceiling in production.
   *
   * `interval: 'sporadic'` is deliberate: subscription renewals under an e-mandate are
   * variable in amount and can be off-cycle (an upgrade, a mid-cycle addon), and
   * `sporadic` is the one interval that needs no `interval_count` and does not promise
   * the bank a rhythm we will not keep.
   */
  private indiaCardMandateOptions(
    customerId: string,
    methodTypes: string[],
    currency: string | undefined,
    maxAmountMinor: bigint | undefined,
  ): { payment_method_options?: Stripe.SetupIntentCreateParams.PaymentMethodOptions } {
    if (currency?.toUpperCase() !== "INR") return {};
    if (!methodTypes.includes("card")) return {};
    if (maxAmountMinor == null || maxAmountMinor <= 0n) return {};
    const nowSec = Math.floor(Date.now() / 1000);
    // CLAMPED, the same way `razorpay.ts` clamps `createMandateOrder` — this path had no
    // clamp at all, so an over-cap ceiling reached Stripe and came back a 400 instead of
    // registering at the largest the rail can carry. `withMandateHeadroom` clamps to
    // NPCI's ₹1,00,000 upstream, so this is defence in depth rather than a live bug; it
    // exists because the two providers must not answer differently for the same rail, and
    // because a caller reaching this adapter directly bypasses that upstream clamp.
    const amount =
      maxAmountMinor > MAX_INDIA_CARD_MANDATE_MINOR ? MAX_INDIA_CARD_MANDATE_MINOR : maxAmountMinor;
    return {
      payment_method_options: {
        card: {
          mandate_options: {
            amount: Number(amount),
            // MAXIMUM, never `fixed`: the whole point is a variable renewal capped at
            // a ceiling. `fixed` would bind the buyer to one exact amount and refuse
            // the proration, tax change or quantity bump that makes the next invoice
            // differ by a rupee.
            amount_type: "maximum",
            currency: "inr",
            /**
             * `sporadic`, and NOT RazorPay's `frequency: "monthly"` — settled 2026-09-05
             * against Stripe's own type definitions rather than left as an open question.
             *
             * Stripe documents `interval` as one of day|week|month|year|sporadic, and
             * `interval_count` as "optional when interval=sporadic". A subscription's
             * renewal date is NOT a fixed cadence here: proration, term changes, dunning
             * retries and anchor moves all shift it, so declaring `month` would promise the
             * buyer's bank a rhythm the engine does not keep. RazorPay sends `monthly`
             * because its API demands a frequency; Stripe offers the honest option, so the
             * two adapters differing is the APIs differing, not a gap in this one.
             */
            interval: "sporadic",
            /**
             * NO `end_date`, and that is now evidenced rather than assumed.
             *
             * Stripe's own type says: "End date of the mandate or subscription. **If not
             * provided, the mandate will be active until canceled.**" So omitting it gives
             * an unbounded mandate, which is what a subscription wants. RazorPay sets
             * `expire_at = now + 10 years` because its API REQUIRES an expiry — copying
             * that here would invent an artificial cliff in 2036 and silently stop
             * collecting for anyone still subscribed. `ProviderMandate.expiresAt` therefore
             * stays null on Stripe, which `mandateExpiredRefusal` already reads as "no
             * expiry" rather than "expired".
             */
            // Unique per mandate and stable within this call. Stripe shows it to the
            // buyer's bank; the customer id makes it traceable in a support ticket.
            reference: `${customerId}-${nowSec}`.slice(0, 80),
            // "Start date should not be lesser than yesterday" — now is always valid.
            start_date: nowSec,
            supported_types: ["india"],
          },
        },
      },
    };
  }

  /**
   * Merge our #31 ownership tag into whatever metadata the caller supplied.
   *
   * The caller's keys are preserved and ours is applied last, so a caller cannot
   * accidentally shadow the tag. Returns `undefined` when there is neither a ref nor
   * caller metadata, so we don't send an empty object where Stripe expects nothing.
   *
   * ⚠️ A missing `ref` means the object ships UNTAGGED, and the classifier's rule
   * ("created after tagging shipped and carries no tag ⇒ provably not ours") is only
   * sound for object kinds where that cannot happen. That is what
   * `STRIPE_TAGGED_OBJECT_KINDS` enumerates — keep the two in step.
   */
  private ownershipMetadata(
    ref: string | undefined,
    caller?: Record<string, string>,
  ): Record<string, string> | undefined {
    if (!ref) return caller;
    return { ...(caller ?? {}), [STRIPE_OWNERSHIP_KEY]: ref };
  }

  private async createStripeSetupIntent(params: {
    /**
     * Beside the authorization in Stripe's own dashboard. `initiateVaultSetup` and
     * `createIntent({purpose:'setup'})` are the SAME gateway call, so both send it and
     * neither can drift from the other.
     */
    description?: string;
    customerId: string;
    methodTypes?: string[];
    idempotencyKey?: string;
    currency?: string;
    maxAmountMinor?: bigint;
    /**
     * #31 ownership tag.
     *
     * ⚠️ The note here used to say `initiateVaultSetup` "genuinely has none" because
     * `InitiateVaultSetupInput` carried no id of ours. That was true when written and is
     * FALSE as of 2026-09-04: the field was added to that input and
     * `payment-methods/service.ts` now supplies the customer's `cus_…`, so both callers
     * have a ref and a SetupIntent is taggable after all. Still optional, because a
     * caller may legitimately not have one and a missing tag must degrade to `unknown`
     * rather than to a claim.
     */
    ownershipRef?: string;
  }): Promise<Stripe.SetupIntent & { client_secret: string }> {
    const methodTypes = this.mapMethodTypes(params.methodTypes);
    const si = await this.stripe.setupIntents.create(
      {
        customer: params.customerId,
        // Stripe showed a SetupIntent with no description AT ALL — and that is the row a
        // support person opens when a renewal later fails on "the card they saved".
        ...(params.description ? { description: params.description } : {}),
        usage: "off_session",
        payment_method_types: methodTypes,
        ...(params.ownershipRef
          ? { metadata: { [STRIPE_OWNERSHIP_KEY]: params.ownershipRef } }
          : {}),
        ...this.indiaCardMandateOptions(
          params.customerId,
          methodTypes,
          params.currency,
          params.maxAmountMinor,
        ),
      },
      params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined,
    );
    if (!si.client_secret) throw new Error(`Stripe SetupIntent ${si.id} returned no client_secret`);
    return si as Stripe.SetupIntent & { client_secret: string };
  }

  async initiateVaultSetup(input: InitiateVaultSetupInput): Promise<VaultSetupRef> {
    // Buyer-side instrument capture: a SetupIntent whose client_secret the browser
    // confirms via Stripe Elements (off-session mandate; PAN/bank details never
    // touch us — PCI SAQ-A). The confirmed pm_… is then completed via
    // vaultPaymentMethod.
    const si = await this.createStripeSetupIntent({
      customerId: input.customer.providerCustomerId,
      methodTypes: input.methodTypes,
      ...(input.description ? { description: input.description } : {}),
      // Both were accepted and dropped until 2026-08-30 — see `indiaCardMandateOptions`
      // for what they now do and why only the INR card rail is affected.
      ...(input.currency ? { currency: input.currency } : {}),
      ...(input.maxAmountMinor != null ? { maxAmountMinor: input.maxAmountMinor } : {}),
      // #31: the vault attempt's own ref, now that the input carries one. Without this the
      // SetupIntent is the one object we create and never tag, and an untagged object on a
      // shared account cannot be told from a sibling product's.
      ...(input.ownershipRef ? { ownershipRef: input.ownershipRef } : {}),
    });
    return { setupTokenId: si.id, ...this.clientSecretAuthorization(si.client_secret) };
  }

  async ensureCustomer(input: EnsureCustomerInput): Promise<ProviderCustomerRef> {
    const a = input.address;
    const customer = await this.stripe.customers.create({
      email: input.email,
      name: input.name,
      // Name + address satisfy India-export compliance on cross-border charges.
      ...(a?.line1
        ? {
            address: {
              line1: a.line1,
              line2: a.line2,
              city: a.city,
              state: a.state,
              postal_code: a.postalCode,
              country: a.country,
            },
          }
        : {}),
      metadata: { ...(input.metadata ?? {}), tmbilling_ref: input.customerRef },
    });
    return { providerKey: this.key, providerCustomerId: customer.id };
  }

  async updateCustomer(ref: ProviderCustomerRef, input: EnsureCustomerInput): Promise<void> {
    // Keep the reused Stripe customer in sync with our record — name + address
    // are load-bearing on Indian accounts (export-transaction regulations).
    //
    // ⚠️ `name` here is the BILLING CONTACT (see `providerCustomerDetails`), so this call
    // RENAMES an existing Stripe customer whose billing contact differs from whatever we
    // sent when it was created. That is deliberate — the gateway identity and the invoice
    // the payment settles must not disagree — but it is a visible mutation in someone
    // else's system, triggered by a buyer adding a card, so it is worth knowing it
    // happens here and nowhere else.
    //
    // `metadata` carries the account-holder name so support can still find a customer by
    // the name they signed up with. Stripe MERGES metadata keys on update (a key is only
    // removed by sending it as an empty string), so this preserves `tmbilling_ref` from
    // `ensureCustomer` instead of clobbering it — do not "fix" this into a full object.
    const a = input.address;
    await this.stripe.customers.update(ref.providerCustomerId, {
      ...(input.email ? { email: input.email } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(a?.line1
        ? {
            address: {
              line1: a.line1,
              line2: a.line2,
              city: a.city,
              state: a.state,
              postal_code: a.postalCode,
              country: a.country,
            },
          }
        : {}),
    });
  }

  async vaultPaymentMethod(input: VaultPaymentMethodInput): Promise<ProviderPaymentMethodRef> {
    // The client supplies a Stripe PaymentMethod id (pm_…) or a card token (tok_…).
    // Either way the raw PAN never touches us (PCI SAQ-A).
    let paymentMethodId = input.token;
    if (input.token.startsWith("tok_")) {
      const created = await this.stripe.paymentMethods.create({
        type: "card",
        card: { token: input.token },
      });
      paymentMethodId = created.id;
    }

    let pm = await this.stripe.paymentMethods.retrieve(paymentMethodId);
    let boundCustomerId: string | undefined;
    if (!pm.customer) {
      // Keep what attach() RETURNS. Re-retrieving by the id we passed in is wrong
      // for Stripe's shared test tokens (`pm_card_visa` & co): every retrieve of
      // one mints a NEW unattached PaymentMethod, so attach would bind a clone
      // while we stored an unattached twin. Stripe lets an unattached pm be
      // charged exactly once, so the first charge worked and every subsequent one
      // failed with "PaymentMethod … may not be used again" — i.e. a vaulted card
      // that renews exactly zero times. For a real pm_… from Elements both paths
      // return the same object, so this is strictly safer.
      pm = await this.stripe.paymentMethods.attach(paymentMethodId, {
        customer: input.customer.providerCustomerId,
      });
    } else {
      // A pm_… confirmed via SetupIntent (portal add-card) is already attached
      // to the SETUP call's Stripe customer — a different object from the one
      // ensureCustomer just minted (each call creates a fresh customer). Adopt
      // that customer, but only after proving it is ours for THIS customer:
      // ensureCustomer stamps metadata.tmbilling_ref with our cus_… public id.
      const custId = typeof pm.customer === "string" ? pm.customer : pm.customer.id;
      const owner = await this.stripe.customers.retrieve(custId);
      const ref = !owner.deleted ? owner.metadata?.tmbilling_ref : undefined;
      if (!input.customerRef || ref !== input.customerRef) {
        throw new Error(`Payment method ${pm.id} is attached to another customer`);
      }
      boundCustomerId = custId;
    }

    return {
      providerKey: this.key,
      providerPaymentMethodId: pm.id,
      ...(boundCustomerId ? { providerCustomerId: boundCustomerId } : {}),
      display: describeStripePaymentMethod(pm),
    };
  }

  /**
   * Contract: re-read an instrument's display facts (see `fetchPaymentMethodDisplay`).
   *
   * Deliberately reuses `describeStripePaymentMethod`, so a backfilled row and a freshly
   * vaulted one can never disagree about how the same card is described.
   */
  async fetchPaymentMethodDisplay(input: {
    providerPaymentMethodId: string;
    /** Unused: Stripe's pm read is not customer-scoped. Present to satisfy the contract. */
    providerCustomerId?: string;
  }): Promise<ProviderPaymentMethodRef["display"] | null> {
    try {
      const pm = await this.stripe.paymentMethods.retrieve(input.providerPaymentMethodId);
      return describeStripePaymentMethod(pm);
    } catch (err) {
      // Gone from Stripe's side is a real answer, not a failure: the row stays unfilled
      // rather than acquiring invented values.
      if (isStripeAlreadyGone(err)) return null;
      throw err;
    }
  }

  /** Contract: see `fetchVaultedPaymentMethod`. A pm attached to another customer is null. */
  async fetchVaultedPaymentMethod(input: {
    providerCustomerId: string;
    providerPaymentMethodId: string;
  }): Promise<(ProviderPaymentMethodRef & { requiresPerDebitMandate?: boolean }) | null> {
    let pm: Stripe.PaymentMethod;
    try {
      pm = await this.stripe.paymentMethods.retrieve(input.providerPaymentMethodId);
    } catch (err) {
      if (isStripeAlreadyGone(err)) return null;
      throw err;
    }
    const owner = typeof pm.customer === "string" ? pm.customer : (pm.customer?.id ?? null);
    if (owner !== input.providerCustomerId) return null;
    return {
      providerKey: this.key,
      providerPaymentMethodId: pm.id,
      providerCustomerId: owner,
      display: describeStripePaymentMethod(pm),
      // An India account's off-session confirm needs the e-mandate reference.
      requiresPerDebitMandate: (await this.accountCountry()) === "IN",
    };
  }

  /** The account's country, read once per secret key for the process. */
  private accountCountry(): Promise<string | null> {
    let hit = ACCOUNT_COUNTRY_BY_KEY.get(this.keyHash);
    if (!hit) {
      hit = this.stripe.accounts.retrieveCurrent().then((a) => a.country ?? null);
      // A failed read is not cached — the next attach asks again.
      hit.catch(() => ACCOUNT_COUNTRY_BY_KEY.delete(this.keyHash));
      ACCOUNT_COUNTRY_BY_KEY.set(this.keyHash, hit);
    }
    return hit;
  }

  /**
   * The issuer wants this cardholder to authenticate, and the buyer is on the page.
   *
   * Reported as `requires_action` so the engine runs its on-session challenge (a new
   * intent the buyer confirms). The refused intent is cancelled so it is not left behind
   * as an orphan; a failed cancel is logged and does not block the challenge.
   */
  private async buyerMustAuthenticate(err: Stripe.errors.StripeCardError): Promise<ChargeResult> {
    const piId = err.payment_intent?.id ?? "";
    if (piId) {
      try {
        await this.stripe.paymentIntents.cancel(piId);
      } catch (e) {
        log.warn("could not cancel the PaymentIntent the issuer refused for authentication", {
          event: "stripe_auth_decline_cancel_failed",
          payment_intent: piId,
          error: (e as Error).message,
        });
      }
    }
    return {
      status: "requires_action",
      providerChargeId: piId,
      nextAction: { type: "authentication_required", data: { approvalRequired: true } },
      raw: err,
    };
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    try {
      const pi = await this.stripe.paymentIntents.create(
        {
          amount: toStripeAmount(input.amountMinor, input.currency),
          currency: input.currency.toLowerCase(),
          customer: input.customer.providerCustomerId,
          payment_method: input.paymentMethod.providerPaymentMethodId,
          // Off-session even when the buyer is present (`initiator.by: customer`): the card
          // was just saved with 3DS, and an on-session confirm makes the issuer challenge a
          // second time. Only an `authentication_required` refusal asks the buyer — see
          // `buyerMustAuthenticate`.
          off_session: true,
          confirm: true,
          /**
           * The NETWORK's own answer lives on the charge, not on the intent and not on
           * the error (#69). `outcome.network_decline_code`, `network_advice_code` and
           * `reason` are what carry "previously_declined_do_not_retry" and the two-digit
           * advice code — the card network telling us whether to re-present at all.
           * Without this expand they never arrive, and three correct decline rules sat
           * inert for a day because I concluded the SDK did not expose them.
           */
          expand: ["latest_charge"],
          /**
           * REQUIRED on an Indian account for an off-session recurring card debit (#63).
           * Without it Stripe answers 400 `invalid_request_error` — "The parameter
           * `mandate` is not provided or invalid" — and because that is an API error
           * rather than a card decline, nothing was booked: no payment row, no
           * transaction, no dunning. The attempt existed only in `gateway_request_logs`.
           *
           * Conditional rather than always-on: a non-mandate instrument has no reference
           * and Stripe rejects an empty `mandate` just as firmly as a missing one.
           */
          ...(input.mandateReference ? { mandate: input.mandateReference } : {}),
          // Mandatory on an Indian account for a cross-border charge — see
          // `exportSafeDescription`. `collectInvoice` always supplies one, so the
          // fallback only covers a caller that does not.
          description: exportSafeDescription(input.description, "Subscription charge"),
          // #31, and this is the path EVERY off-session renewal takes.
          //
          // `ChargeInput` carries no `ownershipRef` (checked against providers/types.ts
          // 2026-09-04) and neither call site — `invoicing/collection.ts:699` nor
          // `wallet/service.ts:86` — passes `metadata` at all. Leaving it untagged
          // would therefore ship a `charge.succeeded` with `metadata: {}` for our own
          // renewals, which `stripeOwnershipOf` would then read as `foreign`: the exact
          // false "not ours" #31 exists to remove, on the busiest money path we have.
          //
          // So the idempotency key stands in. It is the only id of ours this input
          // carries, and the contract already defines it as mapping "1:1 to a tmbilling
          // payment attempt" — in practice `sub_<pub>_first_charge_<pm_pub>` or a
          // `pay_…` public id. It is an ownership WITNESS, not a matching key (matching
          // still goes through `provider_charge_id`), which is precisely what
          // `CreateIntentInput.ownershipRef`'s own contract note says the tag is for.
          //
          // ⚠️ `ChargeInput.ownershipRef` NOW EXISTS (added 2026-09-04, `types.ts`) and every
          // caller supplies it, so the real public id is what gets stamped. The key is kept
          // only as a fallback and it should now be unreachable — but it is NOT deleted on
          // purpose: the classifier's rule is "created after rollout and carrying no tag ⇒
          // provably not ours", which is sound only while EVERY charge is tagged. A future
          // call site that forgot `ownershipRef` would otherwise ship an untagged charge and
          // be silently misread as another product's. `charge()` is the path every
          // off-session renewal takes, so that is the last place to leave a hole.
          metadata: this.ownershipMetadata(
            input.ownershipRef ?? input.idempotencyKey,
            input.metadata,
          ),
        },
        { idempotencyKey: input.idempotencyKey },
      );

      // NOTE: no `capture_method` — this path captures immediately, which is what an
      // off-session renewal must do. The authorize-now/capture-on-consume model lives
      // in createIntent/consumeIntent and deliberately does not touch this one.
      return chargeResultFromPaymentIntent(pi);
    } catch (err) {
      if (err instanceof Stripe.errors.StripeCardError) {
        if (input.initiator?.by === "customer" && isAuthenticationDecline(err))
          return this.buyerMustAuthenticate(err);
        return chargeResultFromCardError(err);
      }
      /**
       * AN ATTEMPT THAT FAILED AT THE API IS STILL AN ATTEMPT (#63).
       *
       * A request the gateway would not accept arrives as `invalid_request_error`, so it
       * used to fall through to the rethrow below and NOTHING was booked: no payment row,
       * no transaction, no dunning. The attempt existed only in `gateway_request_logs`,
       * which is an ops surface — invisible in the customer's Transactions, invisible to
       * the clock, and invisible to the operator. Measured 2026-09-04: an invoice left at
       * `payment_due` with `dunning_status` NULL that no pass would ever have touched.
       *
       * WHICH codes count is the rules' answer now (`requestRejectedFailure`), not a
       * hardcoded `err.code ===` that knew one spelling. The refusal is an outcome and
       * belongs in the ledger of attempts, booked with the rule's own hardness and
       * wording: a malformed request re-presented identically cannot succeed, so dunning
       * must surface it, not hammer it.
       *
       * ⚠️ Still deliberately narrow. An `invalid_request_error` the rules do NOT classify
       * as `gateway_request_rejected` still throws, because those are our bugs and a
       * decline-shaped result would bury them — which is exactly what happened to the
       * missing `mandate` for as long as this case was silent.
       */
      if (err instanceof Stripe.errors.StripeInvalidRequestError) {
        const failure = classifiedThrowFailure(err);
        /**
         * The id, when Stripe kept the object. Refusing the confirm does NOT delete the
         * PaymentIntent it already created, and that id is the only handle on money armed
         * at the gateway: the transaction booked from this result carries it, so the
         * intent is findable from the invoice instead of only from
         * `orphaned_gateway_intents` calling it unexplained. The card-decline path beside
         * this one has always read it; this branch dropped it, and a renewal at 00:00:03
         * on 2026-09-07 became an orphan that could not be tied to anything.
         */
        if (failure)
          return {
            status: "failed",
            providerChargeId: err.payment_intent?.id ?? "",
            failure,
            raw: {
              stripe_code: err.code,
              stripe_type: err.type,
              request_id: err.requestId,
              payment_intent: err.payment_intent?.id ?? null,
            },
          };
      }
      const strandedId = (err as { payment_intent?: { id?: string } }).payment_intent?.id;
      // No answer survived the SDK's own retries: the charge may have happened. A plain
      // throw is booked as a retriable failure, and the next attempt's new key charges
      // again. Pending keeps the invoice blocked until the PaymentIntent is read.
      if (isLostStripeAnswer(err)) {
        throw markStrandedObject(
          new ProviderIndeterminateError(
            `Stripe did not confirm the charge (${(err as Error).name}): ${(err as Error).message}`,
          ),
          strandedId,
        );
      }
      // Keep throwing — an unrecognised error is our bug and the caller must see it — but
      // stamp the object Stripe KEPT first. The confirm failed after the PaymentIntent was
      // created, and this is the only place that id still exists.
      throw markStrandedObject(err, strandedId);
    }
  }

  /**
   * Contract: what became of a charge we already placed (see `fetchChargeStatus` on
   * `PaymentProvider`). The stale-pending sweep's only source of truth when a
   * settlement webhook never arrived.
   *
   * ── Why Stripe needs this at all ─────────────────────────────────────────────
   * `capabilities.methods` includes `us_bank_account`, `sepa_debit` and
   * `bank_transfer`, and this adapter's own note says a bank debit "returns `pending`
   * → transaction `in_progress`, and the terminal outcome arrives only as an inbound
   * webhook". India e-mandate debits take the same `processing` path. Without this
   * method the sweep counted every one of them as `unsupported` and the portal's
   * "I won't approve this" control answered HTTP 503 — an ACH debit that lost its
   * webhook was unresolvable by anything in the engine.
   *
   * `charge()` returns the PaymentIntent id, so that is what arrives here.
   *
   * ── The mapping, and its deliberate asymmetry ────────────────────────────────
   * `succeeded` is the ONLY money-in-hand answer, exactly as `charge()` maps it —
   * the sweep must not be a second opinion about what "settled" means.
   *
   * Only two states are treated as terminal failures, and both are states in which
   * Stripe guarantees no money moved:
   *   - `canceled` — the intent was cancelled or expired; it can never succeed.
   *   - `requires_payment_method` **with a `last_payment_error`** — the off-session
   *     confirm was refused. The error is what distinguishes it from a fresh,
   *     never-confirmed intent, which is not a decline and must stay in flight.
   *
   * Everything else stays PENDING, including statuses a later API version invents:
   * `processing` (the async rail doing its job), `requires_capture` (authorized, ours
   * to capture), `requires_confirmation`. A poll that invents a failure marks a debit
   * failed while the money is still on its way to us, burns a dunning attempt against
   * an instrument that did nothing wrong, and can push the customer onto a backup card
   * for a charge that then settles twice. Leaving it alone costs one more tick.
   *
   * `requires_action` rides back as itself rather than being flattened: an India
   * e-mandate debit above the AFA ceiling is waiting on the BUYER, and
   * `sweepStalePendingCharges` distinguishes that from a slow rail.
   */
  /**
   * Register this storefront domain for wallet buttons, then ask Stripe to re-verify it.
   *
   * Create-then-validate rather than create alone: `create` on a domain Stripe already
   * knows throws, and an operator pressing the button twice must not see an error for a
   * domain that is in fact fine. So an existing registration is looked up first and
   * `validate` runs either way — which is also what makes this the honest check that the
   * association file is being served, since validating is when Stripe fetches it.
   */
  async registerWalletDomain(input: { domain: string }): Promise<WalletDomainStatus> {
    const existing = await this.stripe.paymentMethodDomains.list({
      domain_name: input.domain,
      limit: 1,
    });
    const domain =
      existing.data[0] ??
      (await this.stripe.paymentMethodDomains.create({ domain_name: input.domain }));
    // Re-verify every time. A domain registered before the file was in place stays
    // inactive until something asks again, and nothing else ever asks.
    const checked = await this.stripe.paymentMethodDomains.validate(domain.id);
    const wallet = (name: string, w: { status: string; status_details?: unknown }) => ({
      wallet: name,
      active: w.status === "active",
      // Stripe's own words, not ours: it names the actual cause, which is almost always
      // that the association file could not be fetched from the domain.
      ...(((w.status_details as { error_message?: string } | undefined)?.error_message ??
        undefined) !== undefined
        ? { detail: (w.status_details as { error_message?: string }).error_message! }
        : {}),
    });
    return {
      domain: checked.domain_name,
      enabled: checked.enabled,
      wallets: [
        wallet("apple_pay", checked.apple_pay),
        wallet("google_pay", checked.google_pay),
        wallet("link", checked.link),
        wallet("paypal", checked.paypal),
      ],
    };
  }

  async fetchChargeStatus(input: { providerChargeId: string }): Promise<ChargeResult> {
    return chargeResultFromReadIntent(
      await this.stripe.paymentIntents.retrieve(input.providerChargeId),
    );
  }

  /**
   * Contract: find a charge whose create answer was lost (see `locateCharge` on
   * `PaymentProvider`), by the `tmbilling_ref` `charge()` stamped, the amount and the
   * currency, created inside a bounded window.
   *
   * Search answers in one call, but its index lags ("searchable in under 1 minute",
   * longer during an outage) and it "isn't available to businesses in India"
   * (https://docs.stripe.com/search, read 2026-10-27). So a search hit is taken as found,
   * and "nothing found" is checked again with the list API, which has no lag. A `null`
   * from here is therefore definite.
   */
  async locateCharge(input: {
    ownershipRef: string;
    idempotencyKey: string;
    amountMinor: bigint;
    currency: string;
    createdAfter: Date;
  }): Promise<ChargeResult | null> {
    const from = Math.floor(input.createdAfter.getTime() / 1000);
    const to = from + STRIPE_LOCATE_WINDOW_SECONDS;
    const amount = toStripeAmount(input.amountMinor, input.currency);
    const currency = input.currency.toLowerCase();
    const ours = (pi: Stripe.PaymentIntent) => {
      const ref = pi.metadata?.[STRIPE_OWNERSHIP_KEY];
      return (
        (ref === input.ownershipRef || ref === input.idempotencyKey) &&
        pi.amount === amount &&
        pi.currency === currency &&
        pi.created >= from &&
        pi.created <= to
      );
    };
    let found = (await this.searchIntents(input.ownershipRef, from, to)).filter(ours);
    if (found.length === 0) found = (await this.listIntents(from, to)).filter(ours);
    if (found.length > 1)
      throw new Error(
        `Stripe has ${found.length} PaymentIntents tagged ${input.ownershipRef} for this amount in the window; cannot tell which one this attempt made`,
      );
    return found[0] ? chargeResultFromReadIntent(found[0]) : null;
  }

  /** PaymentIntents tagged `ref` in [from, to]. Empty when Stripe refuses search here. */
  private async searchIntents(
    ref: string,
    from: number,
    to: number,
  ): Promise<Stripe.PaymentIntent[]> {
    const value = ref.replace(/["\\]/g, "\\$&");
    try {
      const res = await this.stripe.paymentIntents.search({
        query: `metadata["${STRIPE_OWNERSHIP_KEY}"]:"${value}" AND created>=${from} AND created<=${to}`,
        limit: 100,
      });
      return res.data;
    } catch (err) {
      // Not offered to this account (India), or the key may not search: the list answers.
      if (
        err instanceof Stripe.errors.StripeInvalidRequestError ||
        err instanceof Stripe.errors.StripePermissionError
      )
        return [];
      throw err;
    }
  }

  /** Every PaymentIntent created in [from, to]. Throws past the page cap: no definite answer. */
  private async listIntents(from: number, to: number): Promise<Stripe.PaymentIntent[]> {
    const out: Stripe.PaymentIntent[] = [];
    let after: string | undefined;
    for (let page = 0; page < STRIPE_LOCATE_MAX_PAGES; page++) {
      const res = await this.stripe.paymentIntents.list({
        created: { gte: from, lte: to },
        limit: 100,
        ...(after ? { starting_after: after } : {}),
      });
      out.push(...res.data);
      after = res.data.at(-1)?.id;
      if (!res.has_more || !after) return out;
    }
    throw new Error(
      `more than ${STRIPE_LOCATE_MAX_PAGES * 100} PaymentIntents were created in the lookup window; cannot confirm none is ours`,
    );
  }

  /**
   * Contract: what became of a refund we already placed (see `fetchRefundStatus` on
   * `PaymentProvider`). Backs the stale-pending refund sweep when `charge.refunded` never
   * arrived — Stripe bank refunds can take days, so a missed callback looks exactly like a
   * slow one.
   *
   * Deliberately MORE conservative than `refund()`'s mapping below, which folds everything
   * that is not `succeeded`/`pending` into `failed`. That is harmless for a refund created
   * a millisecond ago, where `requires_action` cannot occur — but this poll drives a LEDGER
   * REVERSAL, and treating an actionable refund as refused would unwind money that is still
   * on its way. Only Stripe's two terminal failure states count as failed; everything else
   * is still in flight.
   */
  async fetchRefundStatus(input: { providerRefundId: string }): Promise<RefundResult> {
    const refund = await this.stripe.refunds.retrieve(input.providerRefundId);
    const status: RefundResult["status"] =
      refund.status === "succeeded"
        ? "succeeded"
        : refund.status === "failed" || refund.status === "canceled"
          ? "failed"
          : "pending";
    return { status, providerRefundId: refund.id, raw: refund };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    let refund: Stripe.Refund;
    try {
      refund = await this.stripe.refunds.create(
        {
          payment_intent: input.providerChargeId,
          amount:
            input.amountMinor != null
              ? toStripeAmount(input.amountMinor, input.currency)
              : undefined,
          // #31. A Refund is its OWN object with its own metadata — it does not inherit
          // the PaymentIntent's — so `refund.failed` / `charge.refund.updated` arrive
          // describing an object nothing has tagged unless we tag it here. Same fallback
          // and same rule as `charge()`: `RefundInput.ownershipRef` now exists and carries the
          // refund's own `re_…`, with the idempotency key left as an unreachable-but-retained
          // fallback for the same reason (an untagged object must never be mistaken for a
          // sibling product's).
          metadata: this.ownershipMetadata(input.ownershipRef ?? input.idempotencyKey),
        },
        { idempotencyKey: input.idempotencyKey },
      );
    } catch (err) {
      // A validation refusal created nothing, so the engine may release the reservation.
      // 409 and 429 stay plain throws: the refund may exist.
      if (isStripeRefundRefusal(err))
        throw new ProviderRefusalError(`Stripe refused the refund. ${(err as Error).message}`);
      throw err;
    }
    return {
      status:
        refund.status === "succeeded"
          ? "succeeded"
          : refund.status === "pending"
            ? "pending"
            : "failed",
      providerRefundId: refund.id,
      ...(refund.failure_reason
        ? { failureMessage: `Stripe could not complete the refund (${refund.failure_reason}).` }
        : {}),
      raw: refund,
    };
  }

  // ── Intents (C7) ───────────────────────────────────────────────────────────
  //
  // Two purposes, one object:
  //  - `setup`   → a SetupIntent (`seti_…`). Zero amount; the PRODUCT is a vaulted
  //    instrument. This is the same call `initiateVaultSetup` makes — the only
  //    difference is that the engine now records it as an intent with attempts.
  //  - `payment` → a MANUAL-CAPTURE PaymentIntent (`pi_…`). Authorize now, capture
  //    when the intent is consumed against an invoice. `charge()` stays as it was
  //    (auto-capture) because an off-session renewal has no second step to wait for.
  //    Exception: a pay-now (`captureOnConfirm`, the buyer picks in Elements and the
  //    invoice exists) keeps only cards and Link manual. Bank debits and redirect methods cannot be held, so Stripe captures them
  //    at confirm and consume books what was captured.

  async createIntent(input: CreateIntentInput): Promise<IntentRef> {
    if (input.purpose === "setup") {
      const si = await this.createStripeSetupIntent({
        customerId: input.customer.providerCustomerId,
        methodTypes: input.methodTypes,
        idempotencyKey: input.idempotencyKey,
        ...(input.description ? { description: input.description } : {}),
        // Same ceiling `initiateVaultSetup` registers — the two paths are the same
        // gateway call and must not ask Stripe for different mandates.
        currency: input.currency,
        ...(input.maxAmountMinor != null ? { maxAmountMinor: input.maxAmountMinor } : {}),
        ...(input.ownershipRef ? { ownershipRef: input.ownershipRef } : {}),
      });
      // A fresh SetupIntent is always `requires_payment_method`: the buyer supplies
      // the instrument DURING the challenge, so there is nothing to authorize yet.
      return {
        intentId: si.id,
        status: "requires_action",
        authorization: this.clientSecretAuthorization(si.client_secret),
        raw: si,
      };
    }

    // `confirm` needs an instrument. With one we authorize server-side (and 3DS, if
    // demanded, comes back as requires_action); without one we create the intent
    // unconfirmed and hand the buyer its client_secret, which is how they choose a
    // card in Elements. `off_session` is only meaningful on a confirming call.
    const confirm = Boolean(input.paymentMethod);
    // Manual capture limits Elements to methods that can be held: cards, wallets, BNPL.
    // So a buyer-picks-the-method pay-now captures automatically, with cards and Link kept
    // on authorize-then-capture. Everything else (a server-side confirm, a checkout with
    // no invoice yet) keeps manual capture.
    const captureOnConfirm = input.captureOnConfirm === true && !confirm && !input.methodTypes;
    try {
      const pi = await this.stripe.paymentIntents.create(
        {
          amount: toStripeAmount(input.amountMinor ?? 0n, input.currency),
          currency: input.currency.toLowerCase(),
          customer: input.customer.providerCustomerId,
          ...(input.paymentMethod
            ? { payment_method: input.paymentMethod.providerPaymentMethodId }
            : {}),
          // The engine's model is authorize-now / capture-on-consume. Where the buyer
          // picks a method that cannot be held, the money moves at confirm and consume
          // books the captured result (`capturedOnConfirmResult`).
          ...(captureOnConfirm
            ? {
                capture_method: "automatic" as const,
                payment_method_options: {
                  card: { capture_method: "manual" as const },
                  link: { capture_method: "manual" as const },
                },
              }
            : { capture_method: "manual" as const }),
          ...(confirm
            ? { confirm: true as const, off_session: input.session === "off_session" }
            : {}),
          ...(input.methodTypes
            ? { payment_method_types: this.mapMethodTypes(input.methodTypes) }
            : {}),
          /**
           * ONLY WITH `confirm`. Stripe rejects it outright otherwise:
           * *"The parameter `return_url` cannot be passed when creating a PaymentIntent
           * unless `confirm` is set to true."* — observed 2026-09-05 on the portal's
           * "Pay now" button, which 400'd the whole create rather than degrading.
           *
           * It used to be gated on `input.returnUrl` alone, which read as harmless: the
           * caller supplies a return URL, so we forward it. But the unconfirmed branch is
           * exactly the one where a return URL cannot apply — there is no confirm to
           * redirect FROM. The buyer confirms client-side (`payment-dialog.tsx`), which
           * passes the return URL to Stripe.js for a method that redirects.
           *
           * The caller is NOT wrong to pass it: the same input serves the confirming
           * branch, where Stripe requires it whenever a 3DS redirect is possible. So this
           * gates rather than removes, and a caller that supplies one for a server-side
           * confirm still gets it.
           */
          ...(confirm && input.returnUrl ? { return_url: input.returnUrl } : {}),
          // A server-side confirm with no return URL must not allow redirect methods:
          // Stripe refuses the confirm outright ("you must provide a `return_url`") when
          // the account's dynamic methods include one. 3DS still works via `next_action`.
          ...(confirm && !input.returnUrl && !input.methodTypes
            ? { automatic_payment_methods: { enabled: true, allow_redirects: "never" as const } }
            : {}),
          // Mandatory on an Indian account for a cross-border authorization. This is
          // the path that actually 400'd (measured 2026-08-13): an intent has no
          // invoice behind it to borrow a description from.
          description: exportSafeDescription(input.description, "Card authorization"),
          // #31: our ref, stamped at CREATION so the charge inherits it. Verified
          // against Stripe's docs 2026-09-04: a PaymentIntent copies its metadata to
          // the Charge when the charge is created, and a LATER PI metadata update does
          // not propagate to charges that already exist. So stamping here — and only
          // here — is what makes `charge.succeeded` carry the tag inline, with no extra
          // API call (unlike RazorPay and PayPal).
          metadata: this.ownershipMetadata(
            input.ownershipRef,
            captureOnConfirm
              ? { ...(input.metadata ?? {}), [STRIPE_CAPTURE_KEY]: STRIPE_CAPTURE_ON_CONFIRM }
              : input.metadata,
          ),
        },
        { idempotencyKey: input.idempotencyKey },
      );

      if (pi.status === "requires_action") {
        return {
          intentId: pi.id,
          status: "requires_action",
          ...(pi.client_secret
            ? { authorization: this.clientSecretAuthorization(pi.client_secret) }
            : {}),
          raw: pi,
        };
      }
      // `requires_capture` is the manual-capture success state: the hold exists, the
      // money has not moved. `succeeded` can only appear if the account/instrument
      // ignored manual capture — either way the authorization is in hand.
      if (pi.status === "requires_capture" || pi.status === "succeeded") {
        return { intentId: pi.id, status: "authorized", raw: pi };
      }
      // We never confirmed, so the buyer still has to pick an instrument: that is a
      // challenge, not an idle intent, and the client_secret is how they complete it.
      if (!confirm && pi.status === "requires_payment_method" && pi.client_secret) {
        return {
          intentId: pi.id,
          status: "requires_action",
          authorization: this.clientSecretAuthorization(pi.client_secret),
          raw: pi,
        };
      }
      return { intentId: pi.id, status: "inited", raw: pi };
    } catch (err) {
      // Same decline handling as charge(), so a declined authorization classifies
      // identically for dunning. RETURNED, not thrown: a decline is an ordinary
      // outcome of creating an intent (`IntentRef.failure`), and throwing made the
      // caller re-parse a Stripe error it should never see — and left the attempt row
      // with no normalized code for dunning/retry to reason about. The status is
      // whatever Stripe reports for the intent it left behind (a card error parks it
      // at `requires_payment_method` ⇒ `inited`), never a state we made up.
      if (err instanceof Stripe.errors.StripeCardError) {
        const charge = chargeResultFromCardError(err);
        return {
          intentId: charge.providerChargeId,
          status: intentStatusFromStripe(err.payment_intent?.status),
          ...(charge.failure ? { failure: charge.failure } : {}),
          raw: err,
        };
      }
      /**
       * AN ATTEMPT THAT FAILED AT THE API IS STILL AN ATTEMPT — the other half of #63.
       *
       * That fix taught `charge()` to book `payment_intent_payment_attempt_failed`
       * instead of throwing it, and left THIS path with the identical defect. Measured in
       * production 2026-09-06 14:34 IST: a dashboard Collect now on invoice 65978 failed
       * with "The parameter `mandate` is not provided or invalid", threw here, and booked
       * nothing — no intent, no attempt (`payment_attempts.payment_intent_id` is NOT NULL,
       * so the attempt had nowhere to live), no transaction. The failure existed only in
       * `gateway_request_logs`: invisible in the customer's Transactions, invisible to the
       * clock, invisible to the operator who clicked the button. It also left a Stripe
       * PaymentIntent behind with our ownership tag and no local row, so every retry trips
       * `orphaned_gateway_intents` — a money-safety alert learning to cry wolf.
       *
       * Returned with the status Stripe reports for the object it left behind, exactly as
       * the card-error branch above does. `requires_payment_method` ⇒ `inited`.
       *
       * WHICH codes count is the rules' answer now (`requestRejectedFailure`), shared with
       * `charge()`, so `decline-codes.ts` § 5 reaches both paths and a new rule needs no
       * adapter change.
       *
       * ⚠️ Still deliberately narrow, same as #63: an `invalid_request_error` the rules do
       * NOT classify as `gateway_request_rejected` still throws, because those are our bugs
       * and a decline-shaped result would bury them — which is precisely what happened to
       * the missing `mandate` while this was silent.
       */
      if (err instanceof Stripe.errors.StripeInvalidRequestError) {
        const failure = classifiedThrowFailure(err);
        const pi = (err as { payment_intent?: { id?: string; status?: string } }).payment_intent;
        if (failure)
          return {
            intentId: pi?.id ?? "",
            status: intentStatusFromStripe(pi?.status),
            failure,
            raw: err,
          };
      }
      // Keep throwing — an unrecognised error is our bug and the caller must see it — but
      // stamp the object Stripe KEPT first. The confirm failed after the PaymentIntent was
      // created, and this is the only place that id still exists.
      throw markStrandedObject(
        err,
        (err as { payment_intent?: { id?: string } }).payment_intent?.id,
      );
    }
  }

  async consumeIntent(input: ConsumeIntentInput): Promise<ConsumeIntentResult> {
    if (input.purpose === "setup") {
      // Expand the pm rather than retrieving it by id: Stripe's shared test tokens
      // mint a NEW unattached PaymentMethod on every retrieve (see the note in
      // vaultPaymentMethod), so a second lookup can hand back a twin of the card the
      // buyer actually confirmed. The expanded object is the real one.
      const si = await this.stripe.setupIntents.retrieve(input.intentId, {
        // `mandate` is expanded alongside the pm because this is the ONLY moment the
        // two are together: the vaulted instrument and the agreement it was registered
        // under. `vaultPaymentMethod`'s raw-token path has a pm and no SetupIntent, so
        // it can never learn the ceiling — which is exactly why the ceiling has to be
        // harvested here, where it exists.
        expand: ["payment_method", "mandate"],
      });
      const pmObj = typeof si.payment_method === "string" ? null : si.payment_method;
      const pm =
        pmObj ??
        (typeof si.payment_method === "string"
          ? await this.stripe.paymentMethods.retrieve(si.payment_method)
          : null);
      if (!pm) {
        throw new Error(
          `Stripe SetupIntent ${si.id} carries no payment_method (status=${si.status}). There is nothing to vault`,
        );
      }
      // The confirmed pm is attached to the SETUP call's Stripe customer, which is
      // not necessarily the customer a later charge would assume (each ensureCustomer
      // mints a fresh one). Carry that binding so the caller charges the right one —
      // same concern vaultPaymentMethod handles via `boundCustomerId`. No ownership
      // re-check here: WE created this SetupIntent against that customer, so the
      // binding is ours by construction rather than something a client asserted.
      const bound = pm.customer
        ? typeof pm.customer === "string"
          ? pm.customer
          : pm.customer.id
        : typeof si.customer === "string"
          ? si.customer
          : si.customer?.id;
      // What the buyer actually authorized, as STRIPE registered it — not the ceiling
      // we asked for. `persistVaultedPaymentMethod` writes it onto
      // `payment_methods.mandate_*`, which is what makes `mandateRefusal`, the
      // portal's per-charge limit and the re-authorisation gate work on Stripe at all.
      // Undefined for an ordinary card-on-file, which has no mandate and must not be
      // given an empty one.
      const mandate = describeStripeMandate(
        typeof si.mandate === "string" || si.mandate == null ? null : si.mandate,
        // The ceiling is NOT on the Mandate object for a card rail — measured, see
        // `describeStripeMandate`. This intent is the only place Stripe reports what it
        // actually registered, and it is in hand right here, which is why the harvest
        // reads it rather than the `mandate.updated` webhook (which never sees an
        // intent and so cannot recover it at all).
        si.payment_method_options?.card?.mandate_options ?? null,
      );
      return {
        purpose: "setup",
        paymentMethod: {
          providerKey: this.key,
          providerPaymentMethodId: pm.id,
          ...(bound ? { providerCustomerId: bound } : {}),
          display: describeStripePaymentMethod(pm),
          ...(mandate ? { mandate } : {}),
        },
      };
    }

    try {
      const pi = await this.stripe.paymentIntents.capture(
        input.intentId,
        {
          // Omitted → capture the full authorized amount. A smaller amount is a
          // partial capture; Stripe releases the remainder of the hold itself.
          ...(input.amountMinor != null
            ? { amount_to_capture: toStripeAmount(input.amountMinor, input.currency) }
            : {}),
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return { purpose: "payment", charge: chargeResultFromPaymentIntent(pi) };
    } catch (err) {
      if (err instanceof Stripe.errors.StripeCardError) {
        return { purpose: "payment", charge: chargeResultFromCardError(err) };
      }
      // Captured at the buyer's confirm, so there is nothing to capture: book what is.
      if (isStripeUnexpectedState(err)) {
        const charge = await this.capturedOnConfirmResult(input);
        if (charge) return { purpose: "payment", charge };
      }
      throw err;
    }
  }

  /**
   * The result of a pay-now intent Stripe captured at confirm: `succeeded`, or `pending`
   * while a bank debit is in flight. Null when the intent is not one, so the caller
   * rethrows the original refusal. Only reached after a capture was refused, so the
   * card path makes no extra call.
   */
  private async capturedOnConfirmResult(input: ConsumeIntentInput): Promise<ChargeResult | null> {
    const pi = await this.stripe.paymentIntents.retrieve(input.intentId, {
      expand: ["latest_charge"],
    });
    if (!stripeCapturedOnConfirm(pi)) return null;
    // The engine checked its intent amount against the invoice before claiming; Stripe's
    // own figure must be that same amount, or the booking would invent money.
    if (input.amountMinor != null && fromStripeAmount(pi.amount, pi.currency) !== input.amountMinor)
      throw new Error(
        `Stripe captured ${pi.amount} on ${pi.id} at confirm, but consume expected ${input.amountMinor}`,
      );
    return chargeResultFromPaymentIntent(pi);
  }

  /**
   * What became of a PaymentIntent. Expands `latest_charge` so a capture at confirm can
   * be told from one of ours. A SetupIntent is never polled (the engine asks only for
   * `payment`), so any other id answers `unknown`.
   */
  async fetchIntent(input: {
    intentId: string;
    purpose?: IntentPurpose;
    resolveOwnership?: boolean;
  }): Promise<FetchedIntent> {
    if (!input.intentId.startsWith("pi_")) return { intentId: input.intentId, status: "unknown" };
    let pi: Stripe.PaymentIntent;
    try {
      pi = await this.stripe.paymentIntents.retrieve(input.intentId, {
        expand: ["latest_charge"],
      });
    } catch (err) {
      if ((err as { code?: string })?.code === "resource_missing")
        return { intentId: input.intentId, status: "unknown" };
      throw err;
    }
    const captured = stripeCapturedOnConfirm(pi);
    return {
      intentId: pi.id,
      status: fetchedStatusFromStripe(pi.status, captured),
      providerChargeId: pi.id,
      ...(captured ? { capturedOnConfirm: true } : {}),
      amountMinor: fromStripeAmount(pi.amount, pi.currency),
      currency: pi.currency.toUpperCase(),
      ...(input.resolveOwnership ? stripeOwnershipOf(pi) : {}),
      raw: pi,
    };
  }

  /**
   * Release an authorization we will not consume. Stripe has a real void — cancelling
   * an uncaptured PaymentIntent drops the hold without moving a cent — so no refund is
   * ever substituted here.
   *
   * Idempotent per the contract: an already-cancelled intent resolves `{voided:true}`.
   * An intent that already SUCCEEDED still throws — that money moved, and reporting it
   * as voided would hide a captured charge.
   *
   * ── `held`, and why there is a read before the cancel (#30) ──────────────────
   * The caller books a `payment_reversal` off this result, and booking one for a hold
   * that never existed invents a release the bank never made (63 of 102 intent
   * reversals in the dev database, measured 2026-09-03). So the void has to say
   * whether money was actually held.
   *
   * Stripe's cancel response cannot answer it — see `stripeHeldFromPreCancel` for the
   * documented response body that settles this — so the PaymentIntent is retrieved
   * FIRST. One extra GET, no state change, and it is diagnostic rather than
   * permission: if it fails we still cancel and simply report `held: undefined`.
   * Refusing to release a hold because we could not describe it would be strictly
   * worse than the defect.
   *
   * A SetupIntent needs no read at all. It has no amount and nothing capturable, so
   * `held: false` is CERTAIN there — and that certainty matters, because an abandoned
   * vault challenge is one of the shapes that was booking a phantom reversal.
   */
  /**
   * Cancel a bank debit that is still `processing`. Stripe allows it only for the bank-debit
   * methods in `STRIPE_CANCELABLE_DEBITS`, inside "a limited and varying cancellation time
   * window" (Payment Intents lifecycle docs). A card in `processing` is not cancelable. The
   * verdict is read back from the PaymentIntent.
   */
  async cancelPendingCharge(input: CancelPendingChargeInput): Promise<CancelPendingChargeResult> {
    const read = () =>
      this.stripe.paymentIntents.retrieve(input.providerChargeId, { expand: ["payment_method"] });
    const pi = await read();
    if (pi.status === "canceled") return { status: "cancelled", raw: pi };
    if (pi.status !== "processing") {
      const now = await this.fetchChargeStatus({ providerChargeId: pi.id });
      return now.status === "succeeded" || now.status === "failed"
        ? { status: "already_final", charge: now, raw: pi }
        : { status: "not_cancelable", reason: `Stripe PaymentIntent ${pi.status}`, raw: pi };
    }
    const pm = pi.payment_method;
    const method = typeof pm === "object" && pm ? pm.type : undefined;
    if (!method || !STRIPE_CANCELABLE_DEBITS.has(method))
      return {
        status: "not_cancelable",
        reason: `Stripe cannot cancel a processing ${method ?? "payment"}`,
        raw: pi,
      };
    let reason: string | undefined;
    try {
      await this.stripe.paymentIntents.cancel(pi.id, {}, { idempotencyKey: input.idempotencyKey });
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
    const after = await read();
    if (after.status === "canceled") return { status: "cancelled", raw: after };
    if (after.status === "succeeded" || after.status === "requires_payment_method")
      return {
        status: "already_final",
        charge: await this.fetchChargeStatus({ providerChargeId: pi.id }),
        ...(reason ? { reason } : {}),
        raw: after,
      };
    return {
      status: "not_cancelable",
      reason: reason ?? `Stripe PaymentIntent ${after.status}`,
      raw: after,
    };
  }

  async voidIntent(input: VoidIntentInput): Promise<VoidIntentResult> {
    // Purpose is not on VoidIntentInput, and Stripe's own id prefixes are the
    // authoritative discriminator: `seti_` is a SetupIntent, `pi_` a PaymentIntent.
    const isSetup = input.intentId.startsWith("seti_");
    let held: boolean | undefined = isSetup ? false : undefined;
    if (!isSetup) {
      try {
        const pre = await this.stripe.paymentIntents.retrieve(input.intentId);
        held = stripeHeldFromPreCancel(pre.status, pre.amount_capturable);
      } catch (err) {
        // Stays `undefined` — "cannot say", never "nothing held".
        log.info("could not read the PaymentIntent before cancelling — held is unknown", {
          event: "stripe_void_pre_read_failed",
          intent: input.intentId,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      const canceled = isSetup
        ? await this.stripe.setupIntents.cancel(
            input.intentId,
            {},
            { idempotencyKey: input.idempotencyKey },
          )
        : await this.stripe.paymentIntents.cancel(
            input.intentId,
            {},
            { idempotencyKey: input.idempotencyKey },
          );
      return {
        voided: canceled.status === "canceled",
        providerTransactionId: canceled.id,
        ...(held !== undefined ? { held } : {}),
      };
    } catch (err) {
      if (isStripeAlreadyCanceled(err)) {
        // We report the void as SUCCEEDED on Stripe's word that the intent was already
        // canceled — nothing of ours moved. If our state and Stripe's ever disagree,
        // this line is the only place that says the difference was assumed away.
        log.info("void treated as succeeded — Stripe reports the intent already canceled", {
          event: "stripe_void_already_canceled",
          intent: input.intentId,
        });
        // `held` rides along unchanged. For a `pi_…` the pre-read saw `canceled` and so
        // already answered `undefined` — someone got there first and the pre-cancel
        // state is gone. For a `seti_…` `false` still holds: a SetupIntent never held
        // money, whoever cancelled it.
        return {
          voided: true,
          providerTransactionId: input.intentId,
          ...(held !== undefined ? { held } : {}),
        };
      }
      throw err;
    }
  }

  /**
   * Detach the PaymentMethod from its customer. Stripe has no "delete card" API —
   * detach IS the deletion: a detached pm can never be charged or re-attached, and
   * Stripe drops the card details from the object. That satisfies CUST-7 erasure.
   *
   * Idempotent per the contract: an already-detached or unknown pm resolves.
   */
  async deletePaymentMethod(input: {
    customer: ProviderCustomerRef;
    paymentMethod: ProviderPaymentMethodRef;
  }): Promise<void> {
    try {
      await this.stripe.paymentMethods.detach(input.paymentMethod.providerPaymentMethodId);
    } catch (err) {
      if (!isStripeAlreadyGone(err)) throw err;
      // The instrument was already detached at Stripe. Benign, but it means our row
      // and the vault disagreed before we got here — same class of fact the
      // payment-methods module logs when a token may SURVIVE a delete.
      log.info("gateway detach skipped — the instrument was already gone at Stripe", {
        event: "stripe_detach_already_gone",
        providerPaymentMethodId: input.paymentMethod.providerPaymentMethodId,
      });
    }
  }

  /**
   * Register our notification URL as a Stripe webhook endpoint and return the
   * `whsec_…` Stripe generates. This is why tmbilling never has to ASK for a
   * Stripe signing secret: we hold the account's secret key, so we can create the
   * endpoint ourselves, so the Stripe screen shows no secret field.
   *
   * Idempotent: if an endpoint for this exact URL already exists, Stripe won't
   * return its secret again (secrets are only exposed at creation), so we delete
   * the stale endpoint and recreate it to obtain a usable secret.
   */
  /** Deletes every endpoint registered for exactly `url`. */
  async removeWebhookEndpoint(input: { url: string }): Promise<WebhookRemoval> {
    const existing = await this.stripe.webhookEndpoints.list({ limit: 100 });
    let removed = false;
    for (const ep of existing.data) {
      if (ep.url !== input.url) continue;
      await this.stripe.webhookEndpoints.del(ep.id);
      removed = true;
    }
    return { removed };
  }

  async provisionWebhookEndpoint(input: { url: string }): Promise<ProvisionedWebhook> {
    const existing = await this.stripe.webhookEndpoints.list({ limit: 100 });
    for (const ep of existing.data) {
      if (ep.url === input.url) await this.stripe.webhookEndpoints.del(ep.id);
    }
    const params = {
      url: input.url,
      // Receive all events: we filter server-side in normalizeWebhook, and enumerating
      // types here would silently drop new ones.
      //
      // ⚠️ `['*']` is NOT literally every event. Stripe's own reference states it
      // outright: event types marked *Selection required* are "created only when at
      // least one webhook is listening for it. A webhook set to listen to all events
      // doesn't satisfy this requirement." So an opt-in type has to be named
      // explicitly or it is never generated at all — a wildcard cannot reach it.
      //
      // Verified 2026-08-21 against docs.stripe.com/api/events/types: the opt-in
      // types are `issuing_authorization.request`,
      // `identity.verification_session.redacted` and `reporting.report_type.updated`
      // — Issuing, Identity and Reporting, none of which this engine consumes. So the
      // wildcard is correct TODAY; it stops being correct the moment we need an
      // opt-in type, and the fix then is to name it here rather than assume `*` covers it.
      enabled_events: ["*"] as Stripe.WebhookEndpointCreateParams.EnabledEvent[],
      description: "tmbilling",
    };
    let ep: Stripe.WebhookEndpoint;
    try {
      // Pinned, so events arrive in the shape this adapter reads and need no extra read.
      ep = await this.stripe.webhookEndpoints.create({
        ...params,
        api_version: STRIPE_API_VERSION,
      });
    } catch (e) {
      // An account allows at most 3 distinct non-default endpoint versions, and Stripe
      // refuses the 4th as an invalid request. An unpinned endpoint still books
      // correctly: `normalizeWebhook` reads each money object at our version.
      if (!(e instanceof Stripe.errors.StripeInvalidRequestError)) throw e;
      log.warn("could not pin the webhook endpoint's API version; created it unpinned", {
        event: "stripe_webhook_endpoint_unpinned",
        apiVersion: STRIPE_API_VERSION,
        detail: e.message,
      });
      ep = await this.stripe.webhookEndpoints.create(params);
    }
    return {
      ...(ep.secret ? { webhookSecret: ep.secret } : {}),
      providerEndpointId: ep.id,
    };
  }

  /**
   * The refunds a `charge.refunded` reports. API versions before 2022-11-15 embed them
   * on the Charge; later ones do not, so they are read, limited to refunds created by
   * the event's time. A failed read returns none: the Refund events book the same
   * refunds by id.
   */
  private async chargeRefundRecords(
    charge: { id?: string; refunds?: { data?: StripeRefundLike[]; has_more?: boolean } },
    eventCreated: number,
  ): Promise<ProviderRefundRecord[]> {
    const toRecords = (list: StripeRefundLike[]) =>
      list.map(stripeRefundRecord).filter((r): r is ProviderRefundRecord => r != null);
    const embedded = charge.refunds?.data;
    if (embedded && !charge.refunds?.has_more) return toRecords(embedded);
    if (!charge.id) return toRecords(embedded ?? []);
    try {
      const list = await this.stripe.refunds.list({
        charge: charge.id,
        created: { lte: eventCreated },
        limit: 100,
      });
      return toRecords(list.data);
    } catch (e) {
      log.warn("could not read the refunds of a refunded charge", {
        event: "stripe_charge_refunds_read_failed",
        charge: charge.id,
        detail: (e as Error).message,
      });
      return toRecords(embedded ?? []);
    }
  }

  /** Stripe's event id (`evt_…`) is in the body. */
  webhookEventId(input: NormalizeWebhookInput): string {
    return webhookEventId([bodyId(input.payload)], input.payload);
  }

  async normalizeWebhook(input: NormalizeWebhookInput): Promise<NormalizedProviderEvent[]> {
    const secrets = [this.webhookSecret, this.webhookSecretNext].filter((s): s is string => !!s);
    if (secrets.length === 0) {
      throw new Error("STRIPE_WEBHOOK_SECRET not configured — cannot verify webhook");
    }
    const sig = input.headers["stripe-signature"];
    const header = Array.isArray(sig) ? sig[0]! : sig!;
    // Two endpoints sign with two secrets while one replaces the other; either may sign.
    let event: Stripe.Event | undefined;
    for (const [i, secret] of secrets.entries()) {
      try {
        event = this.stripe.webhooks.constructEvent(
          input.payload,
          header,
          secret,
          STRIPE_WEBHOOK_TOLERANCE_S,
        );
        break;
      } catch (e) {
        // This secret signed it and the time is stale: the other secret cannot help.
        if (i === secrets.length - 1 || /tolerance/i.test((e as Error).message)) throw e;
      }
    }
    if (!event) throw new Error("Stripe webhook signature could not be verified");
    const eventId = this.webhookEventId(input);

    const map: Record<string, NormalizedProviderEvent["type"]> = {
      "payment_intent.succeeded": "charge.succeeded",
      "payment_intent.payment_failed": "charge.failed",
      "charge.succeeded": "charge.succeeded",
      "charge.captured": "charge.succeeded",
      "charge.failed": "charge.failed",
      // ⚠️ NOT `charge.succeeded`. Stripe: "Occurs whenever a pending charge is
      // created" — a delayed rail has accepted the money and nothing has settled.
      // The verdict still arrives on its own; this exists so a capture that went
      // pending with no synchronous answer (a timed-out call, a webhook-first flow)
      // leaves a NAMED row instead of an `unknown` nobody can find.
      "charge.pending": "charge.pending",
      // ⚠️ NOT a money term, ever. Stripe: "Occurs whenever a charge description or
      // metadata is updated, or upon an asynchronous capture" — two different things
      // under one name, so settling on it would settle a transaction because somebody
      // retitled a charge in the dashboard. 4,830 of these have been delivered and
      // dropped; persist-only, and it is the event that carries `balance_transaction`
      // (the handle #18's fee hangs off — a reference, not the fee).
      "charge.updated": "charge.updated",
      // ⚠️ NOT `charge.failed`. Stripe: "Occurs whenever an uncaptured charge
      // expires" — that is a HOLD lapsing, not a decline. Nothing was ever booked,
      // so calling it a failure would reverse cash we never took and re-arm dunning
      // against a buyer who did nothing wrong. It is the same argument this file
      // already makes for `payment_intent.canceled`, and the same answer: a released
      // hold is `intent.voided`. Correlated through the Charge's `payment_intent`,
      // because an intent is keyed by the intent id (see the C7 block below).
      "charge.expired": "intent.voided",
      // ⚠️ `invoice.payment_succeeded` / `invoice.payment_failed` are deliberately
      // NOT mapped, and removing them was a correctness fix rather than tidying —
      // the exact mirror of dropping RazorPay's `subscription.*` (INDIA-LAUNCH §4b).
      //
      // They belong to Stripe's Invoices API, which this engine never calls: WE own
      // subscription state and invoicing (locked decision 1), and providers only
      // charge/refund/vault. So they can never describe one of OUR invoices.
      //
      // What they CAN describe is someone else's. `enabled_events: ['*']` means we
      // receive every one, and on a SHARED account another billing system may drive
      // Stripe Invoices itself — so these arrived here describing its collections and
      // were mapped straight onto our money terms. Only correlation saved it:
      // `reconcileChargeSucceeded` finds no local transaction for a foreign
      // PaymentIntent id and returns `ignored`. That is a safety net, not a design.
      "charge.refunded": "charge.refunded",
      // The four events whose object is a Refund. The Refund is the same in every API
      // version, so these — not `charge.refunded` — are what refunds book and settle
      // from. The branch below decides the term from the refund's `status`:
      // succeeded → `charge.refunded` (booked per refund id), failed → `refund.failed`,
      // created and still pending → `refund.pending`, any other update → `unknown`.
      "refund.failed": "refund.failed",
      "refund.updated": "refund.pending",
      "charge.refund.updated": "refund.pending",
      "refund.created": "refund.pending",
      "payment_method.detached": "payment_method.detached",
      // The legacy Card/Source rail's detach. 515 `customer.source.created` have
      // arrived on this account, so these objects exist here; the same branch that
      // serves `payment_method.detached` answers for it because the news is identical
      // — an instrument we would otherwise keep charging is gone.
      "customer.source.deleted": "payment_method.detached",
      // ── The gateway withholding OUR funds ────────────────────────────────────
      // A reserve hold changes what actually settles into the bank, and nothing here
      // read it. One normalized term for both, because a hold is one object moving
      // through states and the engine takes no different action on either.
      "reserve.hold.created": "reserve.hold.updated",
      "reserve.hold.updated": "reserve.hold.updated",
      "payment_method.automatically_updated": "payment_method.updated",
      // The same event under its name before API version 2020-08-27. An endpoint pinned
      // to an older version still receives this name.
      "payment_method.card_automatically_updated": "payment_method.updated",
      "payment_method.updated": "payment_method.updated",
      // ── Mandate lifecycle ─────────────────────────────────────────────────────
      // The counterpart to RazorPay's five `token.*` events, and until now the
      // largest hole on this adapter: every non-card rail it already parses
      // (`sepa_debit`, `bacs_debit`, `au_becs_debit`, `acss_debit`,
      // `us_bank_account`) is mandate-backed, as is an India recurring CARD, and a
      // revoked mandate was invisible here until a debit burned a dunning attempt
      // against it. Stripe's own India guidance names the cost: the
      // `payment_intent_mandate_invalid` code is one "you can prevent ... by
      // checking the mandate status before attempting to charge", and
      // `india_recurring_payment_mandate_canceled` fires when "we only learn that a
      // mandate has been cancelled at this point". This event is how we learn earlier.
      "mandate.updated": "payment_method.mandate_updated",
      "charge.dispute.created": "dispute.created",
      "charge.dispute.funds_withdrawn": "dispute.funds_withdrawn",
      "charge.dispute.funds_reinstated": "dispute.funds_reinstated",
      "charge.dispute.closed": "dispute.closed",
      // Stripe: "Occurs when the dispute is updated (usually with evidence)" — which
      // is where a RE-ISSUED evidence deadline arrives. Mapped to `dispute.created`
      // for the same reason RazorPay's `payment.dispute.action_required` is: that
      // handler's upsert refreshes `reason` + `evidenceDueBy` WITHOUT touching
      // status, so a new deadline lands on a dispute already under review instead of
      // resetting it. Without this we heard `created` and then nothing until
      // won/lost/closed, and a re-issued deadline was missed entirely.
      "charge.dispute.updated": "dispute.created",
      // ── Payouts (settlement) ──────────────────────────────────────────────────
      // The counterpart to RazorPay `settlement.processed`: the gateway remitting
      // money it already collected, netted of fees. Never booked against an invoice
      // — see the `settlement.processed` note in providers/types.ts. Persist-only,
      // so the bank balance can be reconciled against collections at all.
      "payout.paid": "settlement.processed",
      "payout.failed": "settlement.failed",
      // Pre-dispute fraud signal and Radar manual-review holds. Both persist-only;
      // the payment's own verdict still arrives as `charge.succeeded` / `.failed`.
      "radar.early_fraud_warning.created": "fraud_warning.created",
      "review.opened": "review.opened",
      "review.closed": "review.closed",
      // ── Intent lifecycle (C7) ──────────────────────────────────────────────
      // `payment_intent.succeeded` / `.payment_failed` are already mapped above and
      // stay money events: under manual capture, `succeeded` fires at CAPTURE time,
      // which is exactly when the money moves. The four below are the AUTHORIZATION
      // half of the story and carry their own vocabulary — see INTENT_LIFECYCLE_EVENTS
      // for why none of them may borrow a `charge.*` name.
      "payment_intent.amount_capturable_updated": "intent.authorized",
      "payment_intent.canceled": "intent.voided",
      "setup_intent.succeeded": "intent.setup_succeeded",
      "setup_intent.setup_failed": "intent.setup_failed",
      // A vault challenge the buyer abandoned, or that we/the merchant cancelled.
      // RazorPay's `token.cancelled` equivalent, and terminal for the intent —
      // without it an abandoned setup sits open forever.
      "setup_intent.canceled": "intent.voided",
      // ── 3DS / strong authentication, arriving LATE ────────────────────────────
      // The synchronous path already handles a challenge known at call time:
      // `charge()` and `createIntent()` return `status: 'requires_action'` with a
      // `nextAction`, and hosted checkout drives it. These two are the cases that
      // path cannot see, because the requirement appears AFTER our call returned:
      // Radar/dynamic 3DS, an issuer soft-decline that Stripe upgrades into a
      // challenge, and a re-confirmation on an off-session debit.
      "payment_intent.requires_action": "intent.requires_action",
      "setup_intent.requires_action": "intent.requires_action",
      /**
       * The intent EXISTS at the gateway. Named, not acted on.
       *
       * This is the only signal that reaches us when Stripe minted an intent our request
       * path never recorded — a timeout, or a crash between the call returning at Stripe
       * and our transaction committing. Money armed at the gateway with no local row, and
       * nothing else would ever mention it.
       *
       * It was arriving all along (5,245 of them by 2026-09-05) and landing as `unknown`,
       * because an unmapped Stripe type still normalises and still gets a `provider_events`
       * row — so `WHERE type = 'payment_intent.created'` found nothing and read as "we are
       * not subscribed". Naming it makes the row queryable; `sweepOrphanedIntents` reads
       * both this name and the historical `unknown` rows.
       *
       * ⚠️ Nothing may act on this INLINE. It fires before our own transaction commits, so
       * "no local row ⇒ orphan" is true of essentially every payment we make for the first
       * seconds of its life. The judgement belongs to the sweep, after a grace period.
       */
      "payment_intent.created": "intent.created",
      // `payment_intent.processing` is the INDIA e-mandate case and is deliberately
      // resolved in the branch below rather than here, because the same event name
      // means two different things. Stripe parks an off-session India card debit in
      // `processing` for 26 hours while the bank sends the RBI pre-debit
      // notification; only when
      // `processing.card.customer_notification.approval_requested` is true does the
      // buyer actually have to act (the notification then carries the AFA link for a
      // debit above ₹15,000 or above the mandate ceiling). Otherwise `processing` is
      // just a slow rail with nothing for anyone to do, and reporting that as
      // "action required" would nag a customer who has no action available.
      "payment_intent.processing": "unknown",
    };
    let type = map[event.type] ?? "unknown";
    let obj = event.data.object as {
      id?: string;
      // #31. `object` names the KIND (`charge`, `payment_intent`, `mandate`, …) and is
      // what decides whether an absent tag may be read as `foreign`; `metadata` is
      // where our ref lives; `created` is the OBJECT's age, which is the only thing
      // that can distinguish "created before tagging shipped" from "not ours".
      // All three are read by `stripeOwnershipOf` and by nothing else here.
      object?: string;
      metadata?: Record<string, string> | null;
      created?: number | null;
      payment_intent?: string;
      charge?: string;
      // setup_intent.*: the instrument the buyer confirmed.
      payment_method?: string | { id?: string };
      amount_refunded?: number;
      // charge.succeeded: a PaymentIntent's `amount_received`, a Charge's `amount_captured`.
      amount_received?: number;
      amount_captured?: number;
      captured?: boolean;
      // Present only up to API version 2022-11-15; see `chargeRefundRecords`.
      refunds?: { data?: StripeRefundLike[]; has_more?: boolean };
      // payment_method.updated
      card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number };
      // dispute
      amount?: number;
      currency?: string;
      reason?: string;
      status?: string;
      evidence_details?: { due_by?: number | null };
      // intent.requires_action — what the buyer must do, and by when.
      next_action?: {
        type?: string;
        card_await_notification?: { charge_attempt_at?: number | null } | null;
      };
      processing?: {
        type?: string;
        card?: {
          customer_notification?: {
            approval_requested?: boolean | null;
            completes_at?: number | null;
          };
        };
      };
      // mandate.updated. `multi_use.amount` IS the per-debit ceiling of an India card
      // e-mandate — see `describeStripeMandate`, which reads this object.
      type?: string;
      multi_use?: { amount?: number; currency?: string } | null;
      single_use?: { amount?: number; currency?: string } | null;
      payment_method_details?: {
        type?: string;
        sepa_debit?: { reference?: string };
        // The rails that denominate the cap on their own sub-hash (upi/payto/pix).
        [rail: string]: unknown;
      };
      // refund.failed
      failure_reason?: string;
      // payout.* — `amount` and `currency` are shared with dispute above.
      arrival_date?: number | null;
      statement_descriptor?: string | null;
      // radar.early_fraud_warning.created
      fraud_type?: string;
      actionable?: boolean;
      // charge.failed — the decline, wherever this event's object keeps it. A
      // PaymentIntent reports it under `last_payment_error`; a Charge under
      // `failure_code` (with `outcome.reason` as the network's own wording).
      // `decline_code` is the issuer's specific reason and beats the generic `code`.
      last_payment_error?: { code?: string; decline_code?: string };
      // A SetupIntent's refusal, on `setup_intent.setup_failed`.
      last_setup_error?: { code?: string; decline_code?: string; message?: string; type?: string };
      failure_code?: string;
      outcome?: { reason?: string };
    };

    // ── Read the object at our pinned version ─────────────────────────────────
    // Stripe renders `data` in the endpoint's API version, which can be years older (or
    // newer) than ours. An event that books money or changes a payment method is normalized
    // from the object read by id at our version, never from an older shape. The
    // payload gives only the id, the kind, the event type and `created`.
    // An event already rendered at our version is read as delivered: same shape, no call.
    const objectKind = obj.object;
    const readObject = objectKind ? READ_EVENT_OBJECT[objectKind] : undefined;
    const booksOrChangesState =
      (type !== "unknown" || event.type === "payment_intent.processing") &&
      !RECORD_ONLY_TYPES.has(type);
    if (event.api_version !== STRIPE_API_VERSION && booksOrChangesState && readObject && obj.id) {
      try {
        obj = (await readObject(this.stripe, obj.id)) as typeof obj;
      } catch (e) {
        // Book nothing from the old shape. The row records `error`, the route answers
        // non-2xx, and Stripe delivers the event again.
        const detail = (e as Error).message;
        log.warn("could not read a webhook's object at our API version", {
          event: "stripe_webhook_object_read_failed",
          type: event.type,
          object: obj.id,
          apiVersion: event.api_version,
          detail,
        });
        return [
          {
            ...stripeOwnershipOf(obj),
            providerEventId: eventId,
            type,
            occurredAt: new Date(event.created * 1000),
            raw: event,
            unresolved: `We could not read ${objectKind} ${obj.id} from Stripe. ${detail.replace(/\.?$/, ".")} Stripe sends the event again.`,
          },
        ];
      }
    }

    // #31: computed ONCE and spread into every branch below, so a new event shape
    // cannot ship without an ownership answer. Spread FIRST in each literal, ahead of
    // the branch's own fields, so nothing can silently overwrite it.
    const owner = stripeOwnershipOf(obj);

    // ── India e-mandate: does `processing` actually need the buyer? ────────────
    // Resolved here rather than in the map because the same event name carries both
    // answers. Stripe holds an off-session India card debit in `processing` for 26
    // hours while the buyer's bank sends the RBI pre-debit notification;
    // `approval_requested` is Stripe's own flag for "the customer needs to
    // authenticate the payment using the pre-debit notification sent to them", and
    // `completes_at` is "the time that Stripe attempts to charge the payment method"
    // — i.e. the deadline that authentication has to beat.
    //
    // When the flag is false there is nothing for anyone to do and the verdict will
    // arrive on its own as `payment_intent.succeeded` / `.payment_failed`, so the
    // event stays `unknown` and is dropped. Reporting THAT as action-required would
    // send a customer a challenge that does not exist.
    const notification = obj.processing?.card?.customer_notification;
    if (event.type === "payment_intent.processing" && notification?.approval_requested === true) {
      type = "intent.requires_action";
    }

    // ── A pay-now intent that captured at the buyer's confirm ──────────────────
    // A bank debit or a redirect method sends no `amount_capturable_updated`, so the
    // money event IS its authorization. `intent.authorized` comes first so the intent
    // books the money before `charge.succeeded` looks for a row. On a card the intent
    // is already consumed when `succeeded` fires, so the extra event is ignored.
    if (
      obj.object === "payment_intent" &&
      obj.metadata?.[STRIPE_CAPTURE_KEY] === STRIPE_CAPTURE_ON_CONFIRM &&
      (event.type === "payment_intent.succeeded" || event.type === "payment_intent.processing")
    ) {
      const occurredAt = new Date(event.created * 1000);
      const captureState = event.type === "payment_intent.succeeded" ? "succeeded" : "processing";
      const authorized: NormalizedProviderEvent = {
        ...owner,
        providerEventId: eventId,
        type: "intent.authorized",
        providerIntentId: obj.id,
        providerChargeId: obj.id,
        captureState,
        occurredAt,
        raw: event,
      };
      if (captureState === "processing") return [authorized];
      return [
        authorized,
        {
          ...owner,
          providerEventId: eventId,
          type: "charge.succeeded",
          providerChargeId: obj.id,
          occurredAt,
          raw: event,
        },
      ];
    }

    if (type === "intent.requires_action") {
      const isSetup = event.type.startsWith("setup_intent.");
      return [
        {
          ...owner,
          providerEventId: eventId,
          type,
          providerIntentId: obj.id,
          // Same asymmetry as the C7 block below: a `pi_…` becomes our transaction's
          // `id_at_gateway` once captured, a `seti_…` is never a charge id.
          ...(isSetup ? {} : { providerChargeId: obj.id }),
          // `pre_debit_notification` is not a Stripe next_action type — it is ours,
          // for the India case, where the challenge is delivered by the bank and
          // there is no URL to send anyone to. Naming it keeps the two apart: one is
          // a challenge we can render, the other is one we can only wait for.
          actionType:
            notification?.approval_requested === true
              ? "pre_debit_notification"
              : (obj.next_action?.type ?? "unknown"),
          // When Stripe will attempt the debit. An India debit reports it on the intent's
          // `processing` or, while it waits out the pre-debit notification, on `next_action`.
          actionDeadline: (() => {
            const at =
              notification?.completes_at ??
              obj.next_action?.card_await_notification?.charge_attempt_at;
            return at ? new Date(at * 1000) : null;
          })(),
          occurredAt: new Date(event.created * 1000),
          raw: event,
        },
      ];
    }

    // ── Mandate lifecycle (`mandate.updated`) ─────────────────────────────────
    if (type === "payment_method.mandate_updated") {
      const pmId =
        typeof obj.payment_method === "string" ? obj.payment_method : obj.payment_method?.id;
      // Stripe's three statuses, mapped onto the vocabulary `applyMandateUpdate`
      // already understands (and whose DEAD_MANDATE_STATUSES decides whether the
      // instrument is still collectable):
      //   active   → `confirmed`  — the only one that can be debited off-session
      //   inactive → `cancelled`  — Stripe: "rejected, revoked, or previously used"
      //   pending  → `initiated`  — created, not yet usable, not yet dead
      //
      // ⚠️ `inactive` is only a REVOCATION on a multi-use mandate. On a `single_use`
      // mandate it also means "previously used" — the ordinary end of a one-shot
      // authorization — and mapping that to `cancelled` would mark a perfectly good
      // instrument `invalid` and push the customer onto their backup card for no
      // reason. So a single-use mandate going inactive is reported as spent, not
      // dead, and never reaches DEAD_MANDATE_STATUSES.
      //
      // The whole block — status, rail, reference AND the per-debit ceiling — is
      // derived by `describeStripeMandate`, shared with `consumeIntent`'s setup
      // harvest. Two mappings would be two chances for the mandate an event reports
      // and the mandate the vault recorded to disagree about the same object.
      //
      // The ceiling used to be deliberately omitted here, on the stated grounds that
      // "Stripe publishes no documented per-debit cap field on this object". That was
      // wrong — `multi_use.amount` is exactly that field, and an India card e-mandate
      // is a multi-use mandate — and the omission is why `mandate_max_amount_minor`
      // was NULL on every Stripe instrument and the pre-flight never fired.
      const mandate = describeStripeMandate(obj as unknown as Stripe.Mandate) ?? {};
      return [
        {
          ...owner,
          providerEventId: eventId,
          type,
          ...(pmId ? { providerPaymentMethodId: pmId } : {}),
          mandate,
          occurredAt: new Date(event.created * 1000),
          raw: event,
        },
      ];
    }

    // ── A Refund object: created, updated, landed or failed ───────────────────
    // `refund.failed` says so by name; the others fire on every transition, so the
    // refund's own `status` decides. `canceled` is as final as `failed`: the money
    // stays with us. A routine update (a card reference arriving) must neither book
    // nor reverse anything.
    if (type === "refund.failed" || type === "refund.pending") {
      const occurredAt = new Date(event.created * 1000);
      // We store the PaymentIntent id as the charge id; a legacy charge has none.
      const chargeRef = obj.payment_intent ?? obj.charge;
      const base = {
        ...owner,
        providerEventId: eventId,
        providerRefundId: obj.id,
        ...(chargeRef ? { providerChargeId: chargeRef } : {}),
        occurredAt,
        raw: event,
      };
      if (event.type === "refund.failed" || obj.status === "failed" || obj.status === "canceled") {
        return [
          {
            ...base,
            type: "refund.failed",
            ...(obj.amount != null
              ? { amountRefundedMinor: fromStripeAmount(obj.amount, obj.currency) }
              : {}),
            ...(obj.failure_reason ? { providerFailureCode: obj.failure_reason } : {}),
          },
        ];
      }
      const record = obj.id ? stripeRefundRecord({ ...obj, id: obj.id }) : null;
      if (obj.status === "succeeded" && record) {
        return [{ ...base, type: "charge.refunded", refunds: [record] }];
      }
      if (event.type === "refund.created") {
        return [
          {
            ...base,
            type: "refund.pending",
            ...(obj.amount != null
              ? { amountRefundedMinor: fromStripeAmount(obj.amount, obj.currency) }
              : {}),
          },
        ];
      }
      return [{ ...owner, providerEventId: eventId, type: "unknown", occurredAt, raw: event }];
    }

    // ── Payout (settlement) ───────────────────────────────────────────────────
    // Not a charge term and never booked against an invoice — the gateway remitting
    // money it already collected. Stripe's Payout `amount` is what leaves for the
    // bank; unlike RazorPay it carries no per-payout fee/tax breakdown on the object
    // itself (that lives in balance transactions), so those fields stay unset rather
    // than being filled with a guess.
    //
    // `reserve.hold.updated` shares the branch, and the shared FIELDS are the point:
    // a reserve is money withheld out of what would otherwise settle, i.e. exactly
    // the deduction that explains a payout's gap from gross, and putting it on the
    // same fields makes it queryable out of `provider_events.normalized` with no new
    // storage. It keeps its OWN `type` because a reader who mistakes a hold for a
    // payout will reconcile the bank against a credit that never arrived.
    //
    // ⚠️ Stripe publishes no `reserve.hold` object reference, so the extraction is
    // deliberately defensive: `amount` / `currency` / `status` are read if present and
    // left absent otherwise. Absent means unknown, never zero.
    if (
      type === "settlement.processed" ||
      type === "settlement.failed" ||
      type === "reserve.hold.updated"
    ) {
      return [
        {
          ...owner,
          providerEventId: eventId,
          type,
          settlementId: obj.id,
          ...(obj.amount != null
            ? { settlementAmountMinor: fromStripeAmount(obj.amount, obj.currency) }
            : {}),
          settlementCurrency: obj.currency ? obj.currency.toUpperCase() : null,
          settlementStatus: obj.status ?? null,
          // Stripe's nearest thing to RazorPay's UTR — the descriptor that shows on
          // the bank statement. Null when the payout has none.
          settlementUtr: obj.statement_descriptor ?? null,
          occurredAt: new Date(event.created * 1000),
          raw: event,
        },
      ];
    }

    // ── Fraud warning / manual review (persist-only) ──────────────────────────
    // Both name a CHARGE rather than a PaymentIntent, so correlate through it: the
    // engine takes no action, but the inspector must still be able to show which
    // payment is under a warning or a hold.
    if (type === "fraud_warning.created" || type === "review.opened" || type === "review.closed") {
      return [
        {
          ...owner,
          providerEventId: eventId,
          type,
          ...(obj.payment_intent
            ? { providerChargeId: obj.payment_intent }
            : obj.charge
              ? { providerChargeId: obj.charge }
              : {}),
          occurredAt: new Date(event.created * 1000),
          raw: event,
        },
      ];
    }

    // ── Intent lifecycle (C7) ─────────────────────────────────────────────────
    //
    // These are the callbacks that make a buyer authorization REAL instead of
    // force-passed: the gateway telling us the hold exists, the hold was released,
    // or the vault setup finished. They carry their OWN vocabulary, and no money
    // term may be substituted for one of them:
    //   - `amount_capturable_updated` means AUTHORIZED, not paid. Calling it
    //     `charge.succeeded` would make `reconcileChargeSucceeded` settle the
    //     transaction and book cash for money that is still only on hold.
    //   - `payment_intent.canceled` is a released hold — no money moved — so
    //     `charge.failed` would reverse cash that was never booked and re-arm dunning.
    //   - `setup_intent.*` is not a charge at all; `payment_method.updated` would
    //     hand the card-updater a card-less payload and blank a stored instrument.
    //
    // `providerIntentId` is the correlation key the engine resolves against
    // `payment_intents.intent_at_gateway` — an authorized-but-unconsumed intent has
    // NO `transactions` row, so the charge-path lookup on `id_at_gateway` cannot
    // reach it. For the `pi_…` pair we ALSO emit `providerChargeId`: once the intent
    // is captured that same id IS our transaction's `id_at_gateway`, so the webhook
    // inspector can link the delivery to the money it eventually moved. A `seti_…`
    // is never a charge id, so the setup pair deliberately carries only the intent id.
    //
    // `charge.expired` is the one member whose object is a CHARGE, not an intent, so
    // it is resolved separately below: on a Charge the intent id lives in
    // `payment_intent`, and reading `obj.id` would hand the engine a `ch_…` to look
    // up in `intent_at_gateway` and quietly match nothing.
    const INTENT_LIFECYCLE_EVENTS = new Set([
      "payment_intent.amount_capturable_updated",
      "payment_intent.canceled",
      "payment_intent.requires_action",
      "setup_intent.succeeded",
      "setup_intent.setup_failed",
      "setup_intent.canceled",
      "setup_intent.requires_action",
    ]);
    if (event.type === "charge.expired") {
      return [
        {
          ...owner,
          providerEventId: eventId,
          type,
          ...(obj.payment_intent ? { providerIntentId: obj.payment_intent } : {}),
          providerChargeId: obj.payment_intent ?? obj.id,
          occurredAt: new Date(event.created * 1000),
          raw: event,
        },
      ];
    }
    /**
     * Its own branch rather than a member of INTENT_LIFECYCLE_EVENTS, for one reason:
     * that branch also stamps `providerChargeId: obj.id` on a payment intent, and at
     * CREATED there is no charge — carrying one would invite a charge handler to
     * correlate on an id that has never moved money. The intent id is the whole payload
     * here, plus the ownership tag that says whether the intent is even ours.
     */
    if (event.type === "payment_intent.created") {
      return [
        {
          ...owner,
          providerEventId: eventId,
          type,
          providerIntentId: obj.id,
          occurredAt: new Date(event.created * 1000),
          raw: event,
        },
      ];
    }
    if (INTENT_LIFECYCLE_EVENTS.has(event.type)) {
      const isSetup = event.type.startsWith("setup_intent.");
      const pmId =
        typeof obj.payment_method === "string" ? obj.payment_method : obj.payment_method?.id;
      // The refusal arrives only here: the buyer's browser confirmed the setup with Stripe
      // directly, so no call of ours ever saw the error. Same vocabulary as a sync decline.
      const setupErr = event.type === "setup_intent.setup_failed" ? obj.last_setup_error : null;
      const setupNorm = setupErr ? normalizeFailure(stripeDeclineSignal(setupErr)) : undefined;
      const setupMessage = setupNorm?.message ?? setupErr?.message ?? undefined;
      const setupCode = setupErr ? stripeDeclineReason(setupErr) : undefined;
      return [
        {
          ...owner,
          providerEventId: eventId,
          type,
          providerIntentId: obj.id,
          ...(isSetup ? {} : { providerChargeId: obj.id }),
          ...(setupNorm
            ? { failureCode: setupNorm.code, failureRetriable: setupNorm.retriable }
            : {}),
          ...(setupCode ? { providerFailureCode: setupCode } : {}),
          ...(setupMessage ? { failureMessage: setupMessage } : {}),
          // The instrument the buyer confirmed during the vault challenge. Carried so
          // the engine can attribute the setup without a second gateway round-trip;
          // it is NOT a card-updater payload and never reaches that writer.
          ...(pmId ? { providerPaymentMethodId: pmId } : {}),
          occurredAt: new Date(event.created * 1000),
          raw: event,
        },
      ];
    }

    // ── An instrument that is GONE at the gateway ─────────────────────────────
    //
    // ⚠️ PRE-EXISTING DEFECT, found 2026-09-04 while adding `customer.source.deleted`:
    // `payment_method.detached` has been in the map since the adapter was written and
    // had NO branch, so it fell through to the generic charge return below — which
    // sets `providerChargeId` and never `providerPaymentMethodId`. The inbound
    // dispatcher guards on `ev.type === "payment_method.detached" &&
    // ev.providerPaymentMethodId`, so every Stripe detach has been landing `ignored`
    // and no instrument was ever marked invalid from one. RazorPay and PayPal have no
    // equivalent gap because neither maps anything to this term today.
    //
    // The object is a PaymentMethod (`pm_…`) or, on the legacy rail, a Card/Source
    // (`card_…` / `src_…`); either way `obj.id` is the handle
    // `payment_methods.provider_payment_method_id` holds.
    if (type === "payment_method.detached") {
      return [
        {
          ...owner,
          providerEventId: eventId,
          type,
          providerPaymentMethodId: obj.id,
          occurredAt: new Date(event.created * 1000),
          raw: event,
        },
      ];
    }

    // ── Automatic card updater ────────────────────────────────────────────────
    if (type === "payment_method.updated") {
      return [
        {
          ...owner,
          providerEventId: eventId,
          type,
          providerPaymentMethodId: obj.id,
          card: {
            brand: obj.card?.brand ?? null,
            last4: obj.card?.last4 ?? null,
            expMonth: obj.card?.exp_month ?? null,
            expYear: obj.card?.exp_year ?? null,
          },
          occurredAt: new Date(event.created * 1000),
          raw: event,
        },
      ];
    }

    // ── Dispute / chargeback lifecycle ────────────────────────────────────────
    if (type.startsWith("dispute.")) {
      // charge.dispute.closed carries the terminal verdict in `status`.
      if (event.type === "charge.dispute.closed") {
        type =
          obj.status === "won"
            ? "dispute.won"
            : obj.status === "lost"
              ? "dispute.lost"
              : "dispute.closed";
      }
      return [
        {
          ...owner,
          providerEventId: eventId,
          type,
          providerDisputeId: obj.id,
          // Correlate to our payment: we store the PaymentIntent id as
          // providerChargeId, so prefer payment_intent over the ch_… charge id.
          providerChargeId: obj.payment_intent ?? obj.charge ?? obj.id,
          disputeReason: obj.reason ?? null,
          disputeStatus: obj.status ?? null,
          disputeAmountMinor:
            obj.amount != null ? fromStripeAmount(obj.amount, obj.currency) : undefined,
          disputeCurrency: obj.currency ? obj.currency.toUpperCase() : null,
          evidenceDueBy: obj.evidence_details?.due_by
            ? new Date(obj.evidence_details.due_by * 1000)
            : null,
          occurredAt: new Date(event.created * 1000),
          raw: event,
        },
      ];
    }

    if (type === "charge.refunded") {
      // The object is a Charge; we store the PaymentIntent id as providerChargeId,
      // so match on payment_intent. Each refund is carried with its own id, so the
      // engine books per refund and the Refund events cannot double it.
      const refundRecords = await this.chargeRefundRecords(obj, event.created);
      return [
        {
          ...owner,
          providerEventId: eventId,
          type,
          providerChargeId: obj.payment_intent ?? obj.id,
          // Newest first, as Stripe lists them. For the inspector only.
          providerRefundId: refundRecords[0]?.providerRefundId,
          amountRefundedMinor:
            obj.amount_refunded != null
              ? fromStripeAmount(obj.amount_refunded, obj.currency)
              : undefined,
          refunds: refundRecords,
          occurredAt: new Date(event.created * 1000),
          raw: event,
        },
      ];
    }

    // ── charge lifecycle ──────────────────────────────────────────────────────
    // Normalize an async failure into the SAME vocabulary the synchronous
    // `chargeResultFromCardError` produces, so smart dunning cannot classify one
    // decline two different ways depending on whether it arrived in the charge
    // response or minutes later as a webhook.
    //
    // Stripe puts the decline in different places depending on which object the
    // event carries: a PaymentIntent under `last_payment_error`, a Charge under
    // `failure_code`/`outcome`. `decline_code` is the issuer's specific reason and
    // is preferred over the generic `code` (which is usually just `card_declined`).
    //
    // This is the path an INDIA e-mandate debit takes. Stripe holds such a
    // PaymentIntent in `processing` for ~26h while the buyer's bank sends the
    // pre-debit notification, so the verdict — including
    // `india_recurring_payment_mandate_canceled` and `payment_intent_mandate_invalid`
    // — only ever arrives here, never in the original call.
    const err = obj.last_payment_error;
    const providerFailureCode: string | undefined =
      type === "charge.failed"
        ? (err?.decline_code ?? err?.code ?? obj.failure_code ?? obj.outcome?.reason ?? undefined)
        : undefined;
    const norm = providerFailureCode ? normalizeFailure(providerFailureCode) : undefined;
    const captured = type === "charge.succeeded" ? stripeCapturedAmount(obj) : undefined;
    return [
      {
        ...owner,
        providerEventId: eventId,
        type,
        providerChargeId: obj.payment_intent ?? obj.id,
        ...(captured != null ? { capturedAmountMinor: captured } : {}),
        ...(norm ? { failureCode: norm.code, failureRetriable: norm.retriable } : {}),
        ...(providerFailureCode ? { providerFailureCode } : {}),
        occurredAt: new Date(event.created * 1000),
        raw: event,
      },
    ];
  }
}

/**
 * What a `charge.succeeded` object says was captured. A Charge reports it only once
 * `captured` is true: under manual capture `charge.succeeded` fires at authorization.
 */
export function stripeCapturedAmount(obj: {
  object?: string;
  amount_received?: number;
  amount_captured?: number;
  captured?: boolean;
  currency?: string;
}): bigint | undefined {
  if (obj.object === "payment_intent" && typeof obj.amount_received === "number")
    return fromStripeAmount(obj.amount_received, obj.currency);
  if (obj.object === "charge" && obj.captured === true && typeof obj.amount_captured === "number")
    return fromStripeAmount(obj.amount_captured, obj.currency);
  return undefined;
}
