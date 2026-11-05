/**
 * Cashfree (India), API version 2026-01-01.
 *
 * - Mandates: the Subscriptions API with `plan_type: ON_DEMAND`, so Cashfree never debits
 *   on its own schedule. The mandate IS the subscription: its `subscription_id` (ours) is
 *   the vaulted instrument's token. Rails: UPI Autopay, eNACH, card.
 * - Debits: UPI uses the controlled flow (we send the pre-debit notice, then execute 25 h
 *   after Cashfree reports it delivered, so retries stay ours). eNACH and card use
 *   Raise-a-Charge, where Cashfree notifies the payer itself in INR (we email a USD or EUR payer).
 * - One-time invoice payments: PG Orders, paid in Cashfree's browser checkout, in INR or (by
 *   international card) USD, EUR, GBP, AED and JPY. Mandates: INR on every rail, USD and EUR
 *   on card only.
 * - Amounts on the wire are decimals in the currency's own units (JPY has none).
 * - An Indian card on a USD order pays in INR (`payment_currency INR`); the ORDER keeps its
 *   currency and amount, and refunds are taken in it. So money is read from the order.
 *
 * Every Cashfree payment and refund read is scoped by a parent id, so our ids carry it:
 *   subscription  `tms_<16 hex>`
 *   payment       `<subscription id>-<12 hex>`         charge id `sub:<payment id>`
 *   refund        `subrf:<payment id>:<refund id>`
 *   order         `tmo_<24 hex>`                       charge id `ord:<order id>:<cf_payment_id>`
 *   order refund  `ordrf:<order id>:<refund id>`
 * A webhook names the same objects, so it rebuilds the same ids.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { currencyExponent } from "@/platform/currency";
import { countryFor, isGeoLoaded, isValidPhone } from "@/platform/geo";
import type {
  BuyerAuthorization,
  ChargeInput,
  ChargeResult,
  ConsumeIntentInput,
  ConsumeIntentResult,
  CreateIntentInput,
  EnsureCustomerInput,
  FetchedIntent,
  HealthCheckInput,
  HealthCheckItem,
  HealthCheckResult,
  InitiateVaultSetupInput,
  IntentPurpose,
  IntentRef,
  NormalizeWebhookInput,
  NormalizedProviderEvent,
  PaymentProvider,
  ProviderCapabilities,
  ProviderContact,
  ProviderCustomerRef,
  ProviderMandate,
  ProviderPaymentMethodRef,
  RefundInput,
  RefundResult,
  VaultPaymentMethodInput,
  VaultSetupRef,
} from "./types";
import {
  PRE_DEBIT_NOT_DUE_CODE,
  ProviderIndeterminateError,
  ProviderRefusalError,
  markStrandedObject,
} from "./types";
import type { CancelPendingChargeInput, CancelPendingChargeResult } from "./types";
import { providerFetch } from "./http";
import { classifyGatewayHttp } from "./gateway-http-class";
import { normalizeCashfreeDecline } from "./decline-codes";
import { headerValue, webhookEventId } from "./webhook-event-id";

export const CASHFREE_API_VERSION = "2026-01-01";
export const CASHFREE_SANDBOX_BASE = "https://sandbox.cashfree.com/pg";
export const CASHFREE_LIVE_BASE = "https://api.cashfree.com/pg";

/**
 * Oldest webhook timestamp we accept. Cashfree retries at 2, 10 and 30 minutes and does not
 * say whether a retry is signed again, so the window covers the retries with room to spare.
 * Replays inside it are caught by the per-event dedupe.
 */
export const CASHFREE_WEBHOOK_MAX_AGE_MS = 6 * 3_600_000;
const WEBHOOK_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * Webhook versions we read: every version Cashfree's webhook pages document (read
 * 2026-10-27). Any other, or none, is recorded as an error and never parsed.
 */
export const CASHFREE_WEBHOOK_VERSIONS: readonly string[] = [
  "2023-08-01",
  "2025-01-01",
  "2026-01-01",
];
/** The versions the setup steps ask for: 2026-01-01 has no refund or dispute events yet. */
export const CASHFREE_PAYMENTS_WEBHOOK_VERSION = "2025-01-01";
export const CASHFREE_SUBSCRIPTIONS_WEBHOOK_VERSION = "2026-01-01";

/** Same-key attempts on a create, and how long they may take together. */
const CREATE_ATTEMPTS = 3;
const CREATE_BACKOFF_MS = 300;
const CREATE_MAX_WAIT_MS = 3_000;
const CREATE_BUDGET_MS = 20_000;

/** Tag keys on subscriptions and orders. */
const REF_TAG = "tmbilling_ref";
const CUSTOMER_TAG = "tmbilling_customer";

/** Default per-debit ceiling when the caller sends none: ₹10,000. */
const DEFAULT_MANDATE_MAX_MINOR = 1_000_000n;
/**
 * Card and UPI mandates without AFA: ₹15,000. Above it Cashfree hides card and UPI on the
 * mandate page unless the account has AFA arranged, which no API reports.
 */
export const CASHFREE_CARD_UPI_MANDATE_MAX_MINOR = 1_500_000n;
/** eNACH ceiling: ₹1 crore. */
const MAX_MANDATE_MINOR = 1_000_000_000n;

/** Hours between a delivered UPI pre-debit notice and its execution (Cashfree FAQ). */
export const CASHFREE_UPI_NOTICE_LEAD_HOURS = 25;
/** How long to wait on a notice Cashfree has not delivered yet. */
const NOTICE_RECHECK_MS = 3_600_000;

const IST_OFFSET_MS = 330 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

interface CashfreeConfig {
  appId: string;
  secretKey: string;
  /** The webhook endpoint's own Secret Key, when the operator pasted it. */
  webhookSecret?: string;
  /** The account's mode: picks the sandbox or live host. */
  livemode: boolean;
  /** Test override for the host. */
  apiBase?: string;
  /** Test clock for webhook freshness. */
  now?: () => number;
}

// ── ids ──────────────────────────────────────────────────────────────────────

const hex = (s: string, n: number) => createHash("sha256").update(s).digest("hex").slice(0, n);

/** A subscription id: random for a vault setup, derived from the key for an intent. */
export const cashfreeSubscriptionId = (key?: string) =>
  `tms_${key ? hex(`sub:${key}`, 16) : randomUUID().replace(/-/g, "").slice(0, 16)}`;
/** A payment id under a subscription. The subscription id is its prefix. */
export const cashfreePaymentId = (subscriptionId: string, key: string) =>
  `${subscriptionId}-${hex(`pay:${key}`, 12)}`;
const orderId = (key: string) => `tmo_${hex(`ord:${key}`, 24)}`;
const refundId = (key: string) => `tmr_${hex(`ref:${key}`, 24)}`;
const notificationId = (paymentId: string) => `${paymentId}-n`;
const executionId = (paymentId: string) => `${paymentId}-x`;

const OUR_PAYMENT_ID = /^(tms_[0-9a-f]{16})-[0-9a-f]{12}$/;

/** The subscription id inside one of our payment ids, or null for an id we did not mint. */
export function subscriptionOfPayment(paymentId: string): string | null {
  return OUR_PAYMENT_ID.exec(paymentId)?.[1] ?? null;
}

type ParsedRef =
  | { kind: "sub"; paymentId: string; subscriptionId: string | null }
  | { kind: "ord"; orderId: string; cfPaymentId: string };

const enc = (s: string) => encodeURIComponent(s);
const dec = (s: string) => decodeURIComponent(s);

export const subChargeRef = (paymentId: string) => `sub:${enc(paymentId)}`;
export const orderChargeRef = (oid: string, cfPaymentId: string) =>
  `ord:${enc(oid)}:${enc(cfPaymentId)}`;
export const subRefundRef = (paymentId: string, rid: string) =>
  `subrf:${enc(paymentId)}:${enc(rid)}`;
export const orderRefundRef = (oid: string, rid: string) => `ordrf:${enc(oid)}:${enc(rid)}`;

export function parseCashfreeChargeRef(ref: string): ParsedRef | null {
  const [kind, a, b] = ref.split(":");
  if (kind === "sub" && a) {
    const paymentId = dec(a);
    return { kind, paymentId, subscriptionId: subscriptionOfPayment(paymentId) };
  }
  if (kind === "ord" && a && b) return { kind, orderId: dec(a), cfPaymentId: dec(b) };
  return null;
}

function parseRefundRef(
  ref: string,
):
  | { kind: "sub"; paymentId: string; refundId: string }
  | { kind: "ord"; orderId: string; refundId: string }
  | null {
  const [kind, a, b] = ref.split(":");
  if (!a || !b) return null;
  if (kind === "subrf") return { kind: "sub", paymentId: dec(a), refundId: dec(b) };
  if (kind === "ordrf") return { kind: "ord", orderId: dec(a), refundId: dec(b) };
  return null;
}

/**
 * JSON.parse that keeps big integers exact. Webhooks send ids such as `cf_payment_id` as JSON
 * numbers above 2^53 (the REST API sends strings), and a double changes their last digits.
 * Any integer of 16 or more digits in a value position is read as a string. Signatures are
 * checked on the raw bytes before this runs.
 */
export function parseCashfreeJson(text: string): any {
  return JSON.parse(
    text.replace(
      /("(?:[^"\\]|\\.)*"\s*:\s*)(-?\d{16,})(?=\s*[,}\]])/g,
      (_m, key: string, digits: string) => `${key}"${digits}"`,
    ),
  );
}

/** Cashfree's `x-idempotency-key` must be a UUID. Same key in, same UUID out. */
export function cashfreeIdempotencyUuid(key: string): string {
  const h = hex(`cashfree-idem:${key}`, 32);
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ── amounts and time ─────────────────────────────────────────────────────────

/**
 * Order currencies and their decimals (sandbox, 2026-10-30): JPY refuses decimals, the rest
 * take 2. KWD and BHD are refused ("order Currency not enabled for this merchant account").
 */
export const CASHFREE_ORDER_EXPONENTS: Readonly<Record<string, number>> = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  JPY: 0,
};
export const CASHFREE_ORDER_CURRENCIES = Object.keys(CASHFREE_ORDER_EXPONENTS);
/** The domestic mandate currency: UPI Autopay and eNACH take nothing else. */
export const CASHFREE_MANDATE_CURRENCY = "INR";
/**
 * Card mandates in another currency, proven in the sandbox 2026-11-01 (AUTH SUCCESS, ACTIVE,
 * charge raised). Card only: UPI and eNACH are INR rails.
 */
export const CASHFREE_CARD_MANDATE_CURRENCIES: readonly string[] = ["USD", "EUR"];
export const CASHFREE_MANDATE_CURRENCIES: readonly string[] = [
  CASHFREE_MANDATE_CURRENCY,
  ...CASHFREE_CARD_MANDATE_CURRENCIES,
];

/** Why Cashfree cannot hold a mandate in `currency` on these rails, or undefined. */
export function cashfreeMandateProblem(
  currency: string,
  methodTypes?: readonly string[],
): string | undefined {
  const code = currency.toUpperCase();
  if (code === CASHFREE_MANDATE_CURRENCY) return undefined;
  if (!CASHFREE_CARD_MANDATE_CURRENCIES.includes(code))
    return `Cashfree cannot register a mandate in ${code}. It takes mandates in ${CASHFREE_MANDATE_CURRENCIES.join(", ")}. Use a different gateway for ${code}.`;
  const other = (methodTypes ?? []).filter((m) => m !== "card");
  if (other.length)
    return `Cashfree takes UPI Autopay and eNACH mandates in INR only. For a mandate in ${code}, select card.`;
  return undefined;
}

const exponentOf = (code: string) =>
  CASHFREE_ORDER_EXPONENTS[code.toUpperCase()] ?? currencyExponent(code);

/** Minor units to Cashfree's decimal amount in `currency`. Exact for any safe integer. */
export function cashfreeAmount(minor: bigint, currency: string): number {
  if (minor < 0n || minor > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError(`amount out of range: ${minor}`);
  return Number(minor) / 10 ** exponentOf(currency);
}

/**
 * A decimal amount (number or string) in `currency`'s minor units. Undefined when either is
 * missing, or when the amount has more decimals than the currency: Cashfree does not check
 * refund decimals (10.5 JPY was accepted), and such an amount cannot be booked exactly.
 */
export function cashfreeMinor(v: unknown, currency: unknown): bigint | undefined {
  if (typeof currency !== "string" || !currency) return undefined;
  const s =
    typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" ? v.trim() : "";
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return undefined;
  const exp = exponentOf(currency);
  const frac = m[2] ?? "";
  if (/[1-9]/.test(frac.slice(exp))) return undefined;
  return BigInt(`${m[1]}${frac.slice(0, exp).padEnd(exp, "0")}`);
}

/**
 * Why Cashfree would refuse this order amount, or undefined: a currency it does not take for
 * orders, or less than one whole unit ("Invalid amount entered" below 1, measured).
 */
export function cashfreeOrderAmountProblem(minor: bigint, currency: string): string | undefined {
  const code = currency.toUpperCase();
  if (!(code in CASHFREE_ORDER_EXPONENTS))
    return `Cashfree does not take payments in ${code}. It takes ${CASHFREE_ORDER_CURRENCIES.join(", ")}.`;
  const unit = 10n ** BigInt(CASHFREE_ORDER_EXPONENTS[code]!);
  if (minor < unit) return `Cashfree takes a payment of at least 1 ${code}.`;
  return undefined;
}

/** Cashfree times are IST; some come without an offset. */
export function cashfreeTime(v: unknown): Date | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const s = /[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}+05:30`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** `YYYY-MM-DD` of an instant, in IST. */
export const istDate = (d: Date) =>
  new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const istStartOfDay = (date: string) => new Date(`${date}T00:00:00+05:30`);
const istMinuteOfDay = (d: Date) => {
  const t = new Date(d.getTime() + IST_OFFSET_MS);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
};
const addDays = (date: string, n: number) =>
  istDate(new Date(istStartOfDay(date).getTime() + n * DAY_MS + HOUR_MS));

/**
 * NPCI does not allow UPI Autopay executions in the peak hours (10:00–13:00 and
 * 17:00–21:30 IST). Moves `t` to the next allowed minute.
 */
export function nextUpiDebitWindow(t: Date): Date {
  const m = istMinuteOfDay(t);
  const day = istStartOfDay(istDate(t)).getTime();
  if (m >= 600 && m < 780) return new Date(day + 780 * 60_000);
  if (m >= 1020 && m < 1290) return new Date(day + 1290 * 60_000);
  return t;
}

/**
 * The schedule date for a controlled notice and the window its execution may use. The
 * date is the debit's IST date, moved a day on when the allowed part of that day is
 * already over by the time the lead time has passed. T+1..T+7 per Cashfree.
 */
export function controlledSchedule(
  now: Date,
  debitAt: Date,
  minLeadHours: number,
): { date: string; executableAfter: Date; expiresAt: Date } {
  const earliest = new Date(now.getTime() + minLeadHours * HOUR_MS);
  const today = istDate(now);
  let date = istDate(debitAt > earliest ? debitAt : earliest);
  if (date <= today) date = addDays(today, 1);
  const lastDate = addDays(today, 7);
  for (;;) {
    const dayStart = istStartOfDay(date);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const start = nextUpiDebitWindow(earliest > dayStart ? earliest : dayStart);
    // Keep an hour of the allowed window, so a late clock tick still lands in it.
    if (start.getTime() + HOUR_MS <= dayEnd.getTime() || date >= lastDate)
      return { date, executableAfter: start, expiresAt: dayEnd };
    date = addDays(date, 1);
  }
}

/**
 * The schedule date for Raise-a-Charge. UPI and Indian cards need T+1 when raised before
 * 21:00 IST, T+2 after. eNACH takes no date: same day before 07:00 IST, else T+1.
 */
export function chargeScheduleDate(now: Date): string {
  return addDays(istDate(now), istMinuteOfDay(now) >= 21 * 60 ? 2 : 1);
}

// ── mandate description ──────────────────────────────────────────────────────

type MethodType = ProviderCapabilities["methods"][number];

interface CfSubscription {
  subscription_id?: string;
  cf_subscription_id?: string;
  subscription_status?: string;
  subscription_session_id?: string;
  subscription_expiry_time?: string | null;
  subscription_tags?: Record<string, string> | null;
  customer_details?: Record<string, unknown>;
  plan_details?: { plan_max_amount?: number | string | null; plan_currency?: string | null };
  authorisation_details?: CfAuthorization | null;
  authorization_details?: CfAuthorization | null;
}

interface CfAuthorization {
  authorization_reference?: string | null;
  authorization_status?: string | null;
  payment_group?: string | null;
  payment_method?: Record<string, Record<string, unknown> | null> | string | null;
}

/** Cashfree subscription status → our mandate vocabulary (`mandate-afa.ts`). */
export function cashfreeMandateStatus(status: string | null | undefined): string | undefined {
  switch ((status ?? "").toUpperCase()) {
    case "ACTIVE":
      return "confirmed";
    // INITIALIZED is a subscription the payer has not authorized: no mandate yet.
    case "BANK_APPROVAL_PENDING":
      return "initiated";
    // ON_HOLD follows failed debits and can be reactivated; the payer resumes a pause.
    case "CUSTOMER_PAUSED":
    case "ON_HOLD":
      return "paused";
    case "CUSTOMER_CANCELLED":
    case "CANCELLED":
    case "EXPIRED":
    case "COMPLETED":
    case "CARD_EXPIRED":
    case "LINK_EXPIRED":
      return "cancelled";
    default:
      return undefined;
  }
}

const authOf = (s: CfSubscription) => s.authorisation_details ?? s.authorization_details ?? null;

function railOf(auth: CfAuthorization | null): string | undefined {
  const pm = auth?.payment_method;
  if (pm && typeof pm === "object") {
    const k = Object.keys(pm).find((x) => pm[x]);
    if (k) return k;
  }
  if (typeof pm === "string" && pm) return pm.toLowerCase();
  return auth?.payment_group?.toLowerCase() ?? undefined;
}

function methodOfRail(rail: string | undefined): MethodType {
  if (rail === "upi") return "upi";
  if (rail === "enach" || rail === "pnach") return "bank_transfer";
  return "card";
}

/**
 * What paid (`ChargeResult.methodUsed`). A subscription payment names its mandate rail
 * (`authorization_details`); a PG order payment its `payment_group`. Unknown otherwise.
 */
const CF_METHOD_USED: Readonly<Record<string, MethodType>> = {
  card: "card",
  credit_card: "card",
  debit_card: "card",
  prepaid_card: "card",
  upi: "upi",
  enach: "bank_transfer",
  pnach: "bank_transfer",
  net_banking: "bank_transfer",
  wallet: "wallet",
};

export function cashfreeMethodUsed(group: string | null | undefined): { methodUsed?: MethodType } {
  const m = group ? CF_METHOD_USED[group.toLowerCase()] : undefined;
  return m ? { methodUsed: m } : {};
}

const last4 = (v: unknown) => {
  const d = typeof v === "string" ? v.replace(/[^0-9]/g, "") : "";
  return d.length >= 4 ? d.slice(-4) : undefined;
};

export function describeCashfreeSubscription(s: CfSubscription): {
  display: ProviderPaymentMethodRef["display"];
  mandate: ProviderMandate;
} {
  const auth = authOf(s);
  const rail = railOf(auth);
  const pm =
    auth?.payment_method && typeof auth.payment_method === "object" ? auth.payment_method : {};
  const card = (pm.card ?? null) as Record<string, unknown> | null;
  const bank = (pm.enach ?? pm.pnach ?? null) as Record<string, unknown> | null;
  const funding =
    typeof card?.card_type === "string" ? card.card_type.replace(/_card$/, "") : undefined;
  const display: ProviderPaymentMethodRef["display"] = {
    type: methodOfRail(rail),
    ...(typeof card?.card_network === "string" ? { brand: card.card_network.toLowerCase() } : {}),
    ...((last4(card?.card_number) ?? last4(bank?.account_number))
      ? { last4: last4(card?.card_number) ?? last4(bank?.account_number) }
      : {}),
    ...(typeof card?.card_country === "string" ? { issuerCountry: card.card_country } : {}),
    ...(funding ? { instrumentFunding: funding } : {}),
    ...(typeof card?.card_bank_name === "string" ? { issuerName: card.card_bank_name } : {}),
  };
  const max = cashfreeMinor(
    s.plan_details?.plan_max_amount,
    s.plan_details?.plan_currency ?? CASHFREE_MANDATE_CURRENCY,
  );
  const status =
    (auth?.authorization_status ?? "").toUpperCase() === "FAILED"
      ? "rejected"
      : cashfreeMandateStatus(s.subscription_status);
  const expiresAt = cashfreeTime(s.subscription_expiry_time);
  const mandate: ProviderMandate = {
    ...(max != null && max > 0n ? { maxAmountMinor: max } : {}),
    currency: (s.plan_details?.plan_currency ?? "INR").toUpperCase(),
    ...(rail ? { rail } : {}),
    ...(status ? { status } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(auth?.authorization_reference ? { reference: auth.authorization_reference } : {}),
  };
  return { display, mandate };
}

const INDIA = new Set(["IN", "IND", "INDIA"]);

/**
 * An India-issued card on a USD or EUR mandate. Refused until proven: Cashfree's currency
 * page does not allow foreign-currency subscription charges on India-issued cards.
 */
export function cashfreeIndianCardProblem(s: CfSubscription): string | undefined {
  const currency = (s.plan_details?.plan_currency ?? CASHFREE_MANDATE_CURRENCY).toUpperCase();
  if (currency === CASHFREE_MANDATE_CURRENCY) return undefined;
  const { display } = describeCashfreeSubscription(s);
  if (display.type !== "card" || !INDIA.has((display.issuerCountry ?? "").toUpperCase()))
    return undefined;
  return `We cannot save this card for payments in ${currency}. A bank in India issued this card. Use a card that a bank outside India issued.`;
}

/** Ownership from a tag bag: `ours` with the ref, `foreign` when read and absent, else `unknown`. */
function ownershipOf(tags: unknown): Pick<NormalizedProviderEvent, "ownership" | "ownershipRef"> {
  if (tags == null || typeof tags !== "object") return { ownership: "unknown" };
  const ref = (tags as Record<string, unknown>)[REF_TAG];
  return typeof ref === "string" && ref
    ? { ownership: "ours", ownershipRef: ref }
    : { ownership: "foreign" };
}

/** Our method types → Cashfree `payment_methods`. */
const CF_RAIL: Readonly<Record<string, string>> = {
  card: "card",
  upi: "upi",
  bank_transfer: "enach",
};

/**
 * An international number for a non-INR order: `+` and 8 to 15 digits (`+14155550100` was
 * accepted on a USD order, measured 2026-10-30).
 */
export function cashfreeInternationalPhone(phone: string | undefined): string | undefined {
  const t = (phone ?? "").trim();
  if (!t.startsWith("+")) return undefined;
  const d = t.replace(/[^0-9]/g, "");
  return /^\d{8,15}$/.test(d) ? `+${d}` : undefined;
}

/**
 * The payer's phone for an order, in any currency: a `+` number outside India keeps its country
 * code (an INR order can have a foreign payer). A number without `+` takes `country` when it is
 * given and not India (non-INR orders only); anything else is the 10-digit Indian number.
 */
export function cashfreeOrderPhone(
  phone: string | undefined,
  country?: string | null,
): string | undefined {
  const t = (phone ?? "").trim();
  if (t.startsWith("+") && !t.replace(/[^0-9+]/g, "").startsWith("+91"))
    return cashfreeInternationalPhone(t);
  if (!t.startsWith("+") && country && country.toUpperCase() !== "IN")
    return cashfreeForeignPhone(t, country);
  return cashfreePhone(t);
}

/**
 * The payer's phone for a USD or EUR mandate. A `+` number keeps its country code. A number
 * without one is read in the customer's country (`4155550100` or `14155550100` in US →
 * `+14155550100`), never as an Indian number. Undefined when nothing says the country.
 */
export function cashfreeForeignPhone(
  phone: string | undefined,
  country?: string | null,
): string | undefined {
  const t = (phone ?? "").trim();
  if (t.startsWith("+")) return cashfreeOrderPhone(t);
  const code = country?.toUpperCase();
  if (!code) return undefined;
  if (code === "IN") return cashfreePhone(t);
  const dial = isGeoLoaded() ? countryFor(code)?.dialCode : null;
  if (!dial) return undefined;
  const d = t.replace(/[^0-9]/g, "").replace(/^0+/, "");
  if (isValidPhone(d, code)) return cashfreeInternationalPhone(`+${dial}${d}`);
  if (d.startsWith(dial) && isValidPhone(d.slice(dial.length), code))
    return cashfreeInternationalPhone(`+${d}`);
  return undefined;
}

/** The payer's 10-digit mobile number, with `+91`, `91` or a leading `0` dropped. */
export function cashfreePhone(phone: string | undefined): string | undefined {
  const d = (phone ?? "").replace(/[^0-9]/g, "");
  const n =
    d.length === 12 && d.startsWith("91")
      ? d.slice(2)
      : d.length === 11 && d.startsWith("0")
        ? d.slice(1)
        : d;
  return /^\d{10}$/.test(n) ? n : undefined;
}

const PHONE_NOT_10_DIGITS =
  "Cashfree needs a 10-digit mobile number for the payer. Correct the phone number of the customer. Then try again.";
const PHONE_NOT_VALID =
  "Cashfree needs a valid phone number for the payer. Correct the phone number of the customer. Start an international number with + and the country code. Then try again.";
const PHONE_NEEDS_COUNTRY =
  "Cashfree needs the country code of the payer's phone number for a mandate in this currency. Start the phone number of the customer with + and the country code, or add the country of the customer. Then try again.";

/**
 * `payment_remarks` takes letters, digits, dot, hyphen and underscore only (measured
 * 2026-10-30: "paymentRemarks : allows only alpha numerics,dot,hyphen,underscore"). Every
 * other run of characters becomes one hyphen.
 */
export function cashfreeRemarks(v: string | undefined): string | undefined {
  const t = (v ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200)
    .replace(/-+$/, "");
  return t || undefined;
}

/** Cashfree refuses these fields below 3 characters. */
const atLeast3 = (v: string | undefined, max: number) => {
  const t = v?.trim().slice(0, max);
  return t && t.length >= 3 ? t : undefined;
};

interface CfError {
  message?: string;
  code?: string;
  type?: string;
}

type Failure = NonNullable<ChargeResult["failure"]>;

function failureFrom(signal: {
  code?: string | null;
  message?: string | null;
  category?: string | null;
}): Failure {
  const n = normalizeCashfreeDecline(signal);
  return {
    code: n.code,
    ...(signal.code ? { providerCode: signal.code } : {}),
    message: n.message ?? signal.message ?? "Cashfree did not complete the payment.",
    retriable: n.retriable,
    ...(n.ruleId ? { ruleId: n.ruleId } : {}),
    ...(n.retryAfterMs ? { retryAfterMs: n.retryAfterMs } : {}),
  };
}

const apiFailure = (json: CfError) =>
  failureFrom({
    code: json.code ?? null,
    message: json.message ?? null,
    category: json.type ?? null,
  });

/** Subscription payments that can no longer run. Any other status may still debit. */
const FINAL_PAYMENT = new Set(["SUCCESS", "FAILED", "CANCELLED"]);

const TERMINAL_SUBSCRIPTION = new Set([
  "CUSTOMER_CANCELLED",
  "CANCELLED",
  "EXPIRED",
  "COMPLETED",
  "CARD_EXPIRED",
  "LINK_EXPIRED",
]);

// ── the adapter ──────────────────────────────────────────────────────────────

export class CashfreeProvider implements PaymentProvider {
  readonly key = "cashfree" as const;
  readonly capabilities: ProviderCapabilities = {
    refunds: true,
    partialRefunds: true,
    // A subscription plan has one currency, and every debit is in it.
    mandateCurrencyAuthoritative: ["card", "upi", "bank_transfer"],
    // Pay-now orders. Mandates (`setup`) take `CASHFREE_MANDATE_CURRENCIES` (USD and EUR on
    // card only): `createSubscription` refuses others, and the catalogue's `intentCurrencies`
    // keeps routing from asking.
    currencies: [...CASHFREE_ORDER_CURRENCIES],
    methods: ["card", "upi", "bank_transfer"],
    intents: true,
    // `setup` = a subscription (mandate); `payment` = a PG order.
    intentPurposes: ["payment", "setup"],
    // A paid order is captured already, and an unpaid one holds nothing, so there is no
    // hold to release. Cashfree can terminate an unpaid order (PATCH `TERMINATED`), but
    // the order already closes itself at our intent's expiry (`order_expiry_time`).
    intentVoid: false,
    intentStatus: true,
    // `plan_max_amount` is the ceiling and it reads back on every subscription.
    mandates: true,
    // The subscription return is a form POST (`cf_subscriptionId`, `cf_status`, …).
    buyerReturnByPost: true,
    // UPI Autopay, controlled flow. Lead time: 25 h after a SUCCESSFUL notice (Cashfree
    // FAQ, sandbox and production); `checkPreDebitNotice` counts it from delivery. One
    // execution per notified payment id, so one debit per notice. The issuer declines an
    // amount other than the notified one.
    preDebitNotice: {
      methods: ["upi"],
      minLeadHours: CASHFREE_UPI_NOTICE_LEAD_HOURS,
      maxDebitsPerNotice: 1,
      exactAmount: true,
    },
    // Raise-a-Charge: Cashfree sends the pre-debit notice for eNACH and card itself. Only INR is
    // confirmed (support 2026-11-02: the notification webhook is INR only), so a USD or EUR card
    // payer gets our own pre-debit email.
    gatewayNotifiesPayer: ["card", "bank_transfer"],
    gatewayNotifiesPayerCurrencies: [CASHFREE_MANDATE_CURRENCY],
    // Subscription payments only (`cancelPendingCharge`).
    pendingDebitCancel: true,
  };

  private cfg: CashfreeConfig;

  constructor(cfg: CashfreeConfig) {
    this.cfg = cfg;
  }

  private get base(): string {
    return this.cfg.apiBase ?? (this.cfg.livemode ? CASHFREE_LIVE_BASE : CASHFREE_SANDBOX_BASE);
  }

  private async api<T>(
    operation: string,
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ status: number; json: T & CfError; headers: Headers }> {
    const res = await providerFetch({
      gatewayKey: this.key,
      operation,
      method,
      url: `${this.base}${path}`,
      headers: {
        "x-client-id": this.cfg.appId,
        "x-client-secret": this.cfg.secretKey,
        "x-api-version": CASHFREE_API_VERSION,
        "Content-Type": "application/json",
        Accept: "application/json",
        // Cashfree support traces a call by this id.
        "x-request-id": randomUUID(),
        ...(idempotencyKey ? { "x-idempotency-key": cashfreeIdempotencyUuid(idempotencyKey) } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    let json: unknown = {};
    try {
      json = res.text ? parseCashfreeJson(res.text) : {};
    } catch {
      json = { message: res.text.slice(0, 500) };
    }
    return { status: res.status, json: json as T & CfError, headers: res.headers };
  }

  /**
   * A POST that can create money, read through `classifyGatewayHttp`: 408, 409, 429, 5xx and
   * network errors are retried with the same key (Cashfree replays it), then reported as
   * `lost`. Any other answer is returned as is.
   */
  private async create<T>(
    operation: string,
    path: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<{ status: number; json: T & CfError } | { lost: string }> {
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      let res: { status: number; json: T & CfError; headers: Headers } | undefined;
      let why: string;
      try {
        res = await this.api<T>(operation, "POST", path, body, idempotencyKey);
        why = `HTTP ${res.status}`;
      } catch (e) {
        why = (e as Error).message;
      }
      const c = classifyGatewayHttp({
        status: res?.status ?? null,
        networkError: !res,
        // Cashfree names its wait in seconds in `x-ratelimit-retry`.
        retryAfter: res?.headers.get("x-ratelimit-retry") ?? res?.headers.get("retry-after"),
      });
      if (c.kind !== "retry_same_key") return res!;
      const wait = c.retryAfterMs ?? CREATE_BACKOFF_MS * attempt;
      const spent = Date.now() - started;
      if (attempt >= CREATE_ATTEMPTS || wait > CREATE_MAX_WAIT_MS || spent > CREATE_BUDGET_MS)
        return c.whenExhausted === "definite" && res ? res : { lost: why };
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  /** A read that throws on anything but 2xx and 404 (null). */
  private async read<T>(operation: string, path: string): Promise<T | null> {
    const { status, json } = await this.api<T>(operation, "GET", path);
    if (status === 404) return null;
    if (status >= 300)
      throw new Error(`Cashfree ${operation} failed: HTTP ${status} ${json.message ?? ""}`.trim());
    return json;
  }

  private sdk(kind: "subscription" | "order", sessionId: string): BuyerAuthorization {
    return {
      mode: "sdk",
      sdk: {
        provider: this.key,
        params: { kind, sessionId, environment: this.cfg.livemode ? "production" : "sandbox" },
      },
    };
  }

  async healthCheck(input?: HealthCheckInput): Promise<HealthCheckResult> {
    // No probe endpoint. A read of an id that cannot exist: 404 = keys accepted.
    const { status, json } = await this.api(
      "health_check",
      "GET",
      "/subscriptions/tms_healthcheck",
    );
    if (status === 401 || status === 403)
      return { ok: false, detail: `authentication failed: ${json.message ?? status}` };
    const version = input?.recentWebhooks
      ? cashfreeWebhookVersionCheck(input.recentWebhooks)
      : undefined;
    const wrongVersion = version?.status === "failed";
    return {
      ok: status < 500 && !wrongVersion,
      detail: wrongVersion ? version.message : `HTTP ${status}`,
      ...(version ? { checks: [version] } : {}),
    };
  }

  /** Subscriptions take the payer inline, so there is no customer object to create. */
  async ensureCustomer(input: EnsureCustomerInput): Promise<ProviderCustomerRef> {
    return { providerKey: this.key, providerCustomerId: input.customerRef };
  }

  // ── mandates ───────────────────────────────────────────────────────────────

  private async createSubscription(opts: {
    subscriptionId: string;
    customerId: string;
    contact?: ProviderContact;
    currency?: string;
    maxAmountMinor?: bigint;
    methodTypes?: string[];
    returnUrl?: string;
    description?: string;
    ownershipRef?: string;
    idempotencyKey?: string;
  }): Promise<{ subscriptionId: string; sessionId: string; raw: unknown }> {
    const currency = (opts.currency ?? CASHFREE_MANDATE_CURRENCY).toUpperCase();
    const domestic = currency === CASHFREE_MANDATE_CURRENCY;
    const currencyProblem = cashfreeMandateProblem(currency, opts.methodTypes);
    if (currencyProblem) throw new ProviderRefusalError(currencyProblem);
    const email = opts.contact?.email;
    if (!email || !opts.contact?.phone)
      throw new ProviderRefusalError(
        "Cashfree needs the payer's email address and phone number to register a mandate. Add them to the customer. Then try again.",
      );
    // An international card payer keeps a `+` number (accepted on USD/EUR mandates, 2026-11-01).
    const phone = domestic
      ? cashfreePhone(opts.contact.phone)
      : cashfreeForeignPhone(opts.contact.phone, opts.contact.country);
    if (!phone)
      throw new ProviderRefusalError(domestic ? PHONE_NOT_10_DIGITS : PHONE_NEEDS_COUNTRY);
    const rails = domestic
      ? opts.methodTypes?.map((m) => CF_RAIL[m]).filter((r): r is string => !!r)
      : ["card"];
    if (opts.methodTypes?.length && !rails?.length)
      throw new ProviderRefusalError(
        `Cashfree cannot register a mandate for ${opts.methodTypes.join(", ")}. Select card, UPI or eNACH.`,
      );
    // INR card and UPI: capped at the no-AFA limit. A list with eNACH (or no list) keeps the
    // eNACH limit; above ₹15,000 Cashfree then offers eNACH alone. The cap is an INR rule, so
    // a USD or EUR card mandate keeps the caller's ceiling.
    const cardUpiOnly = !!rails?.length && !rails.includes("enach");
    let ceiling = opts.maxAmountMinor ?? DEFAULT_MANDATE_MAX_MINOR;
    const cap = domestic && cardUpiOnly ? CASHFREE_CARD_UPI_MANDATE_MAX_MINOR : MAX_MANDATE_MINOR;
    if (ceiling > cap) ceiling = cap;
    const enachOnly = rails?.length === 1 && rails[0] === "enach";
    const name = atLeast3(opts.contact?.name, 100);
    const { status, json } = await this.api<CfSubscription>(
      "vault_setup",
      "POST",
      "/subscriptions",
      {
        subscription_id: opts.subscriptionId,
        customer_details: {
          customer_email: email,
          customer_phone: phone,
          ...(name ? { customer_name: name } : {}),
        },
        plan_details: {
          plan_name: "On-demand mandate",
          plan_type: "ON_DEMAND",
          plan_currency: currency,
          plan_max_amount: cashfreeAmount(ceiling, currency),
          ...(opts.description ? { plan_note: opts.description.slice(0, 200) } : {}),
        },
        authorization_details: {
          // eNACH registers at 0. UPI and card need a 1-unit authorization, refunded.
          authorization_amount: enachOnly ? 0 : 1,
          authorization_amount_refund: true,
          ...(rails?.length ? { payment_methods: rails } : {}),
        },
        ...(opts.returnUrl ? { subscription_meta: { return_url: opts.returnUrl } } : {}),
        subscription_tags: {
          [REF_TAG]: opts.ownershipRef ?? opts.customerId,
          [CUSTOMER_TAG]: opts.customerId,
          // What the payer's UPI app shows for the mandate.
          psp_note: `Payments up to ${domestic ? "₹" : `${currency} `}${cashfreeAmount(ceiling, currency).toLocaleString("en-IN", { minimumFractionDigits: exponentOf(currency) })}`,
        },
      },
      opts.idempotencyKey ?? opts.subscriptionId,
    );
    if (status >= 500)
      throw markStrandedObject(
        new ProviderIndeterminateError(
          `We could not confirm whether Cashfree registered subscription ${opts.subscriptionId} (HTTP ${status}).`,
        ),
        opts.subscriptionId,
      );
    if (status >= 300 || !json.subscription_session_id)
      throw new ProviderRefusalError(
        `Cashfree refused the mandate request: ${json.message ?? `HTTP ${status}`}`,
      );
    return {
      subscriptionId: opts.subscriptionId,
      sessionId: json.subscription_session_id,
      raw: json,
    };
  }

  async initiateVaultSetup(input: InitiateVaultSetupInput): Promise<VaultSetupRef> {
    const sub = await this.createSubscription({
      subscriptionId: cashfreeSubscriptionId(),
      customerId: input.customer.providerCustomerId,
      ...(input.contact ? { contact: input.contact } : {}),
      ...(input.currency ? { currency: input.currency } : {}),
      ...(input.maxAmountMinor != null ? { maxAmountMinor: input.maxAmountMinor } : {}),
      ...(input.methodTypes ? { methodTypes: input.methodTypes } : {}),
      returnUrl: input.returnUrl,
      ...(input.description ? { description: input.description } : {}),
      ...(input.ownershipRef ? { ownershipRef: input.ownershipRef } : {}),
    });
    return { setupTokenId: sub.subscriptionId, ...this.sdk("subscription", sub.sessionId) };
  }

  /**
   * Authorize a UPI mandate server-side with a collect request to `vpa`. Not part of the
   * contract: for verification harnesses (the sandbox VPA `testsuccess@gocash`).
   */
  async authorizeUpiCollect(input: {
    subscriptionId: string;
    sessionId: string;
    vpa: string;
  }): Promise<{ status: number; paymentStatus?: string; message?: string; simulatorUrl?: string }> {
    const { status, json } = await this.api<{
      payment_status?: string;
      data?: { payload?: { upiIntentData?: { androidAuthAppLinks?: Record<string, string> } } };
    }>(
      "vault_setup",
      "POST",
      "/subscriptions/pay",
      {
        subscription_id: input.subscriptionId,
        subscription_session_id: input.sessionId,
        payment_id: `${input.subscriptionId}-auth`,
        payment_type: "AUTH",
        payment_method: { upi: { channel: "collect", upi_id: input.vpa } },
      },
      `auth:${input.subscriptionId}`,
    );
    return {
      status,
      ...(json.payment_status ? { paymentStatus: json.payment_status } : {}),
      ...(json.message ? { message: json.message } : {}),
      // Sandbox only: the page whose "Simulate Success" button completes the mandate.
      ...(!this.cfg.livemode && json.data?.payload?.upiIntentData?.androidAuthAppLinks?.DEFAULT
        ? { simulatorUrl: json.data.payload.upiIntentData.androidAuthAppLinks.DEFAULT }
        : {}),
    };
  }

  private async getSubscription(subscriptionId: string): Promise<CfSubscription | null> {
    return this.read<CfSubscription>("vault", `/subscriptions/${enc(subscriptionId)}`);
  }

  /**
   * `cashfreeIndianCardProblem`, and the mandate cancelled at Cashfree so nothing can debit it.
   * The cancel is best effort: we never save the method, so we never charge it.
   */
  private async refuseIndianCard(sid: string, s: CfSubscription): Promise<string | undefined> {
    const problem = cashfreeIndianCardProblem(s);
    if (!problem) return undefined;
    await this.api(
      "vault",
      "POST",
      `/subscriptions/${enc(sid)}/manage`,
      { subscription_id: sid, action: "CANCEL" },
      `cancel:${sid}`,
    ).catch(() => undefined);
    return problem;
  }

  private refOf(subscriptionId: string, s: CfSubscription): ProviderPaymentMethodRef {
    const { display, mandate } = describeCashfreeSubscription(s);
    return { providerKey: this.key, providerPaymentMethodId: subscriptionId, display, mandate };
  }

  /**
   * `token` is the subscription id the buyer's browser brings back, so the tag we stamped
   * at creation is the ownership proof: another customer's subscription is refused.
   */
  async vaultPaymentMethod(input: VaultPaymentMethodInput): Promise<ProviderPaymentMethodRef> {
    const s = await this.getSubscription(input.token);
    if (!s) throw new Error(`Cashfree subscription ${input.token} does not exist`);
    const owner = s.subscription_tags?.[CUSTOMER_TAG];
    if (owner !== input.customer.providerCustomerId)
      throw new Error(`Cashfree subscription ${input.token} does not belong to this customer`);
    const status = (s.subscription_status ?? "").toUpperCase();
    if (status !== "ACTIVE" && status !== "BANK_APPROVAL_PENDING")
      throw new Error(
        `Cashfree subscription ${input.token} is ${status || "not authorized"}. The payer did not complete the mandate.`,
      );
    const refused = await this.refuseIndianCard(input.token, s);
    if (refused) throw new ProviderRefusalError(refused);
    return this.refOf(input.token, s);
  }

  async fetchMandate(input: {
    providerCustomerId: string;
    token: string;
  }): Promise<ProviderMandate | null> {
    const s = await this.getSubscription(input.token);
    return s ? describeCashfreeSubscription(s).mandate : null;
  }

  async fetchPaymentMethodDisplay(input: {
    providerPaymentMethodId: string;
    providerCustomerId?: string;
  }): Promise<ProviderPaymentMethodRef["display"] | null> {
    const s = await this.getSubscription(input.providerPaymentMethodId);
    if (!s) return null;
    if (
      input.providerCustomerId &&
      s.subscription_tags?.[CUSTOMER_TAG] !== input.providerCustomerId
    )
      return null;
    return describeCashfreeSubscription(s).display;
  }

  /**
   * Cancels the mandate at the bank or NPCI, and every payment raised on it that has not run.
   * Cancelling the subscription alone leaves its scheduled payments INITIALIZED or PENDING
   * (measured 2026-10-31, 2026-11-01), and Cashfree cancels a payment only while its
   * subscription is ACTIVE (Cashfree support 2026-11-02): so payments first, then the mandate.
   * Throws when the mandate or a payment may still be chargeable, so the caller records it.
   */
  async deletePaymentMethod(input: {
    customer: ProviderCustomerRef;
    paymentMethod: ProviderPaymentMethodRef;
  }): Promise<void> {
    const sid = input.paymentMethod.providerPaymentMethodId;
    // The rail from Cashfree, else the one we stored. Never our display type: an unknown rail
    // maps to card there, and only a KNOWN card rail lets a PENDING payment go unreported.
    const known = await this.getSubscription(sid).catch(() => null);
    const rail = (
      (known ? railOf(authOf(known)) : undefined) ?? input.paymentMethod.mandate?.rail
    )?.toLowerCase();
    // Payments first: a payment the subscription cancel leaves behind can still run.
    const before = await this.cancelQueuedPayments(sid);
    const { status, json } = await this.api(
      "delete_payment_method",
      "POST",
      `/subscriptions/${enc(sid)}/manage`,
      { subscription_id: sid, action: "CANCEL" },
      `cancel:${sid}`,
    );
    let mandateLive = false;
    if (status >= 300 && status !== 404) {
      const s = await this.getSubscription(sid);
      mandateLive = !!s && !TERMINAL_SUBSCRIPTION.has((s.subscription_status ?? "").toUpperCase());
    }
    // Left on a cancelled mandate: INITIALIZED fails at processing ("needs an active mandate",
    // Cashfree subscription FAQ, read 2026-11-02). A card PENDING is never debited and moves to
    // FAILED (Cashfree support 2026-11-02; a 2 USD one stayed PENDING >24 h past its date).
    // A UPI or eNACH PENDING may already sit at the bank and can still succeed (same FAQ).
    const card = !!rail && CF_METHOD_USED[rail] === "card";
    const stillChargeable = (p: { status: string }) =>
      p.status !== "INITIALIZED" && !(card && p.status === "PENDING");
    // Read again: a payment raised while we cancelled is caught here.
    const after = before.unread ? before : await this.cancelQueuedPayments(sid);
    const problems = [
      ...(mandateLive
        ? [`the subscription could not be cancelled (HTTP ${status} ${json.message ?? ""})`.trim()]
        : []),
      ...(after.unread ? ["its payments could not be read"] : []),
      ...(after.left.length
        ? [`payments ${after.left.map((p) => p.id).join(", ")} could not be cancelled`]
        : []),
    ];
    if (problems.length && (mandateLive || after.unread || after.left.some(stillChargeable)))
      throw new Error(
        `Cashfree subscription ${sid}: ${problems.join("; ")}. ` +
          "Cancel them in the Cashfree dashboard. Until then, money can still be debited.",
      );
  }

  /**
   * Cancels every payment on a subscription that has not run (any status other than SUCCESS,
   * FAILED or CANCELLED). `left` = payments still not final after their cancel; `unread` = the
   * list could not be read, so nothing is known.
   */
  private async cancelQueuedPayments(
    sid: string,
  ): Promise<{ left: Array<{ id: string; status: string }>; unread?: true }> {
    let res: { status: number; json: CfPayment[] & CfError };
    try {
      res = await this.api<CfPayment[]>(
        "delete_payment_method",
        "GET",
        `/subscriptions/${enc(sid)}/payments`,
      );
    } catch {
      return { left: [], unread: true };
    }
    if (res.status === 404) return { left: [] };
    if (res.status >= 300 || !Array.isArray(res.json)) return { left: [], unread: true };
    const left: Array<{ id: string; status: string }> = [];
    for (const p of res.json) {
      if (!p.payment_id || FINAL_PAYMENT.has((p.payment_status ?? "").toUpperCase())) continue;
      const path = `/subscriptions/${enc(sid)}/payments/${enc(p.payment_id)}`;
      try {
        await this.api(
          "delete_payment_method",
          "POST",
          `${path}/manage`,
          { subscription_id: sid, payment_id: p.payment_id, action: "CANCEL" },
          `cancel:${p.payment_id}`,
        );
        const now = await this.read<CfPayment>("delete_payment_method", path);
        const st = (now?.payment_status ?? "").toUpperCase();
        if (now && !FINAL_PAYMENT.has(st)) left.push({ id: p.payment_id, status: st });
      } catch {
        left.push({ id: p.payment_id, status: "UNKNOWN" });
      }
    }
    return { left };
  }

  // ── pre-debit notice and charges ───────────────────────────────────────────

  async notifyUpcomingDebit(
    input: Parameters<NonNullable<PaymentProvider["notifyUpcomingDebit"]>>[0],
  ) {
    const subscriptionId = input.paymentMethod.providerPaymentMethodId;
    const paymentId = cashfreePaymentId(subscriptionId, input.idempotencyKey);
    const notificationRef = notificationId(paymentId);
    if (input.currency.toUpperCase() !== CASHFREE_MANDATE_CURRENCY)
      return {
        status: "failed" as const,
        notificationRef,
        failure: {
          code: "currency_not_supported",
          message: "Cashfree takes UPI Autopay debits in INR only.",
          retriable: false,
        },
      };
    const now = new Date(this.cfg.now?.() ?? Date.now());
    const lead = this.capabilities.preDebitNotice!.minLeadHours;
    const plan = controlledSchedule(now, input.debitAt, lead);
    const { status, json } = await this.api<{ notification_status?: string }>(
      "pre_debit_notice",
      "POST",
      "/subscriptions/pay/controlled/notify-mandate",
      {
        notification_id: notificationRef,
        payment_id: paymentId,
        subscription_id: subscriptionId,
        payment_amount: cashfreeAmount(input.amountMinor, CASHFREE_MANDATE_CURRENCY),
        payment_schedule_date: `${plan.date}T00:00:00+05:30`,
        ...(cashfreeRemarks(input.description)
          ? { payment_remarks: cashfreeRemarks(input.description) }
          : {}),
      },
      input.idempotencyKey,
    );
    if (status >= 500)
      throw new ProviderIndeterminateError(
        `We could not confirm whether Cashfree accepted pre-debit notice ${notificationRef} (HTTP ${status}).`,
      );
    if (status >= 300)
      return {
        status: "failed" as const,
        notificationRef,
        failure: {
          code: json.code ?? "notice_rejected",
          message: json.message ?? `HTTP ${status}`,
          retriable: true,
        },
      };
    // Accepted. Delivery is reported by webhook and read again by `checkPreDebitNotice`
    // before the debit, which counts the lead time from delivery. Treating acceptance as
    // sent means a lost webhook never costs a fresh notice every few hours.
    if ((json.notification_status ?? "").toUpperCase() === "FAILED")
      return {
        status: "failed" as const,
        notificationRef,
        failure: {
          code: "notice_failed",
          message: "Cashfree did not send the notice.",
          retriable: true,
        },
      };
    return {
      status: "sent" as const,
      notificationRef,
      executableAfter: plan.executableAfter,
      expiresAt: plan.expiresAt,
    };
  }

  /** The controlled notification as Cashfree reports it; null when it does not exist. */
  async fetchControlledNotification(notificationRef: string): Promise<CfNotification | null> {
    const paymentId = notificationRef.replace(/-n$/, "");
    return this.read<CfNotification>(
      "pre_debit_notice",
      `/subscriptions/payments/${enc(paymentId)}/controlled/notifications/${enc(notificationRef)}`,
    );
  }

  /** SUCCESS + 25 h, outside NPCI's blackout hours; FAILED with Cashfree's codes. */
  async checkPreDebitNotice(input: {
    paymentMethod: ProviderPaymentMethodRef;
    notificationRef: string;
    now: Date;
  }): Promise<{
    status: "sent" | "pending" | "failed";
    executableAfter?: Date;
    failureCode?: string;
    failureMessage?: string;
  }> {
    const n = await this.fetchControlledNotification(input.notificationRef);
    if (!n)
      return {
        status: "failed",
        failureCode: "notice_not_found",
        failureMessage: "Cashfree has no record of this notice.",
      };
    const s = (n.notification_status ?? "").toUpperCase();
    if (s === "FAILED")
      return { status: "failed", ...noticeFailure(n.notification_failure_details) };
    if (s !== "SUCCESS") return { status: "pending" };
    const earliest = executableAfterNotice(noticeDeliveredAt(n) ?? input.now);
    return {
      status: "sent",
      executableAfter: earliest > input.now ? earliest : nextUpiDebitWindow(input.now),
    };
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    const currency = input.currency.toUpperCase();
    // A mandate debits in its own plan currency; USD and EUR only on a card mandate. A
    // mandate with no currency on record is INR: every one before USD and EUR was.
    const held = (input.paymentMethod.mandate?.currency ?? CASHFREE_MANDATE_CURRENCY).toUpperCase();
    const problem =
      held !== currency
        ? `Cashfree mandate ${input.paymentMethod.providerPaymentMethodId} is in ${held}. We cannot debit it in ${currency}.`
        : (cashfreeMandateProblem(currency, [input.paymentMethod.display.type]) ??
          (currency === CASHFREE_MANDATE_CURRENCY
            ? undefined
            : cashfreeOrderAmountProblem(input.amountMinor, currency)));
    if (problem)
      return {
        status: "failed",
        providerChargeId: "",
        failure: { code: "gateway_request_rejected", message: problem, retriable: false },
      };
    const subscriptionId = input.paymentMethod.providerPaymentMethodId;
    if (input.preDebitNotice) return this.executeControlled(input, subscriptionId);

    const paymentId = cashfreePaymentId(subscriptionId, input.idempotencyKey);
    const chargeId = subChargeRef(paymentId);
    const rail = input.paymentMethod.display.type;
    const now = new Date(this.cfg.now?.() ?? Date.now());
    const date = rail === "bank_transfer" ? null : chargeScheduleDate(now);
    const attemptAt = date ? istStartOfDay(date) : null;
    const res = await this.create<CfPayment>(
      "charge",
      "/subscriptions/pay",
      {
        subscription_id: subscriptionId,
        payment_id: paymentId,
        payment_type: "CHARGE",
        payment_amount: cashfreeAmount(input.amountMinor, currency),
        ...(date ? { payment_schedule_date: `${date}T00:00:00+05:30` } : {}),
        ...(cashfreeRemarks(input.description)
          ? { payment_remarks: cashfreeRemarks(input.description) }
          : {}),
      },
      input.idempotencyKey,
    );
    if ("lost" in res) {
      // Our payment id names it, so one read settles most lost answers. No id is stamped on
      // the error: the lost-answer sweep finds it again with `locateCharge`.
      const p = await this.readPayment(subscriptionId, paymentId).catch(() => null);
      if (p) return this.chargeResult(chargeId, p, attemptAt);
      throw new ProviderIndeterminateError(
        `We could not confirm whether Cashfree accepted charge ${paymentId} (${res.lost}).`,
      );
    }
    if (res.status >= 300)
      return {
        status: "failed",
        providerChargeId: chargeId,
        failure: apiFailure(res.json),
        raw: res.json,
      };
    return this.chargeResult(chargeId, res.json, attemptAt);
  }

  /** A subscription payment; null when Cashfree has none with this id. */
  private readPayment(subscriptionId: string, paymentId: string): Promise<CfPayment | null> {
    return this.read<CfPayment>(
      "charge_status",
      `/subscriptions/${enc(subscriptionId)}/payments/${enc(paymentId)}`,
    );
  }

  /**
   * Find a payment whose create answer was lost. Its id is ours: the one the row holds, else
   * the one made from the mandate and the idempotency key. One read answers: 404 means none.
   */
  async locateCharge(input: {
    idempotencyKey: string;
    paymentMethod?: { providerPaymentMethodId: string };
    providerChargeId?: string;
  }): Promise<ChargeResult | null> {
    // A controlled debit's payment id came from its notice, not this key: read the one held.
    const held = input.providerChargeId ? parseCashfreeChargeRef(input.providerChargeId) : null;
    const sid =
      held?.kind === "sub" ? held.subscriptionId : input.paymentMethod?.providerPaymentMethodId;
    if (!sid) throw new Error("Cashfree needs the mandate's subscription id to look up a payment");
    const paymentId =
      held?.kind === "sub" ? held.paymentId : cashfreePaymentId(sid, input.idempotencyKey);
    const p = await this.readPayment(sid, paymentId);
    if (!p) return null;
    const r = this.chargeResult(subChargeRef(paymentId), p, null);
    return r.status === "pending" ? { ...r, nextAction: undefined } : r;
  }

  private async executeControlled(
    input: ChargeInput,
    subscriptionId: string,
  ): Promise<ChargeResult> {
    const notice = input.preDebitNotice!;
    const paymentId = notice.notificationRef.replace(/-n$/, "");
    const chargeId = subChargeRef(paymentId);
    const res = await this.create<{
      execution_status?: string;
      payment_status?: string;
      payment_amount?: number | string;
    }>(
      "charge",
      "/subscriptions/pay/controlled/execute-mandate",
      { execution_id: executionId(paymentId), payment_id: paymentId },
      input.idempotencyKey,
    );
    if ("lost" in res) {
      // The notified payment exists either way, so only a final status answers. The id is
      // stamped: this payment was named by the notice's key, which `locateCharge` cannot rebuild.
      const p = await this.readPayment(subscriptionId, paymentId).catch(() => null);
      const s = (p?.payment_status ?? "").toUpperCase();
      if (p && ["SUCCESS", "FAILED", "CANCELLED"].includes(s))
        return this.chargeResult(chargeId, p, null);
      throw markStrandedObject(
        new ProviderIndeterminateError(
          `We could not confirm whether Cashfree executed ${paymentId} on ${subscriptionId} (${res.lost}).`,
        ),
        chargeId,
      );
    }
    const { status, json } = res;
    if (status >= 300) {
      const now = new Date(this.cfg.now?.() ?? Date.now());
      const wait = notDueWaitMs(json, now);
      if (wait != null)
        return {
          status: "failed",
          providerChargeId: chargeId,
          failure: {
            code: PRE_DEBIT_NOT_DUE_CODE,
            ...(json.code ? { providerCode: json.code } : {}),
            message: json.message ?? "Cashfree cannot debit this payment yet.",
            retriable: true,
            retryAfterMs: wait,
          },
          raw: json,
        };
      return { status: "failed", providerChargeId: chargeId, failure: apiFailure(json), raw: json };
    }
    const s = (json.execution_status ?? json.payment_status ?? "").toUpperCase();
    if (s === "SUCCESS") return { status: "succeeded", providerChargeId: chargeId, raw: json };
    if (s === "FAILED")
      return {
        status: "failed",
        providerChargeId: chargeId,
        failure: failureFrom({ message: "Cashfree reports the debit as failed." }),
        raw: json,
      };
    return { status: "pending", providerChargeId: chargeId, raw: json };
  }

  private chargeResult(chargeId: string, p: CfPayment, attemptAt: Date | null): ChargeResult {
    const s = (p.payment_status ?? "").toUpperCase();
    const used = cashfreeMethodUsed(railOf(p.authorization_details ?? null));
    if (s === "SUCCESS")
      return { status: "succeeded", providerChargeId: chargeId, ...used, raw: p };
    if (s === "FAILED" || s === "CANCELLED")
      return {
        status: "failed",
        providerChargeId: chargeId,
        failure: failureFrom({ message: p.failure_details?.failure_reason ?? `payment ${s}` }),
        ...used,
        raw: p,
      };
    return {
      status: "pending",
      providerChargeId: chargeId,
      ...used,
      // A scheduled presentment, not a challenge: nobody has to act.
      nextAction: {
        type: "scheduled_debit",
        data: {
          approvalRequired: false,
          ...(attemptAt ? { chargeAttemptAt: Math.floor(attemptAt.getTime() / 1000) } : {}),
        },
      },
      raw: p,
    };
  }

  async fetchChargeStatus(input: { providerChargeId: string }): Promise<ChargeResult> {
    const ref = parseCashfreeChargeRef(input.providerChargeId);
    const pending: ChargeResult = { status: "pending", providerChargeId: input.providerChargeId };
    if (!ref) return pending;
    if (ref.kind === "sub") {
      if (!ref.subscriptionId) return pending;
      const p = await this.read<CfPayment>(
        "charge_status",
        `/subscriptions/${enc(ref.subscriptionId)}/payments/${enc(ref.paymentId)}`,
      );
      if (!p) return pending;
      const r = this.chargeResult(input.providerChargeId, p, null);
      return r.status === "pending" ? { ...r, nextAction: undefined } : r;
    }
    const p = await this.read<CfOrderPayment>(
      "charge_status",
      `/orders/${enc(ref.orderId)}/payments/${enc(ref.cfPaymentId)}`,
    );
    return p ? this.orderPaymentResult(input.providerChargeId, p) : pending;
  }

  /**
   * Cancel a subscription payment the bank has not been asked to debit yet
   * (`POST /subscriptions/{sid}/payments/{pid}/manage`, `action: CANCEL`). The verdict is read
   * back from the payment. A PG order (`ord:` ref) is never pending on its own: the buyer pays
   * it in the checkout or it holds nothing, so there is no debit to stop.
   */
  async cancelPendingCharge(input: CancelPendingChargeInput): Promise<CancelPendingChargeResult> {
    const ref = parseCashfreeChargeRef(input.providerChargeId);
    if (ref?.kind !== "sub" || !ref.subscriptionId)
      return { status: "not_cancelable", reason: "Only a subscription payment can be cancelled." };
    const path = `/subscriptions/${enc(ref.subscriptionId)}/payments/${enc(ref.paymentId)}`;
    const res = await this.api<CfPayment>(
      "cancel_charge",
      "POST",
      `${path}/manage`,
      { subscription_id: ref.subscriptionId, payment_id: ref.paymentId, action: "CANCEL" },
      input.idempotencyKey,
    );
    const p = await this.read<CfPayment>("cancel_charge", path);
    const s = (p?.payment_status ?? "").toUpperCase();
    if (s === "CANCELLED") return { status: "cancelled", raw: p };
    const reason =
      res.status >= 300 ? `HTTP ${res.status} ${res.json.message ?? ""}`.trim() : undefined;
    if (s === "SUCCESS" || s === "FAILED")
      return {
        status: "already_final",
        charge: this.chargeResult(input.providerChargeId, p!, null),
        ...(reason ? { reason } : {}),
        raw: p,
      };
    return {
      status: "not_cancelable",
      reason: reason ?? `Cashfree payment ${s || "not found"}`,
      raw: p,
    };
  }

  private orderPaymentResult(chargeId: string, p: CfOrderPayment): ChargeResult {
    const s = (p.payment_status ?? "").toUpperCase();
    const used = cashfreeMethodUsed(p.payment_group);
    if (s === "SUCCESS")
      return { status: "succeeded", providerChargeId: chargeId, ...used, raw: p };
    if (s === "FAILED" || s === "USER_DROPPED" || s === "CANCELLED" || s === "VOID")
      return {
        status: "failed",
        providerChargeId: chargeId,
        failure: failureFrom({
          code: p.error_details?.error_reason ?? null,
          message: p.error_details?.error_description ?? p.payment_message ?? `payment ${s}`,
        }),
        ...used,
        raw: p,
      };
    return { status: "pending", providerChargeId: chargeId, ...used, raw: p };
  }

  // ── intents ────────────────────────────────────────────────────────────────

  async createIntent(input: CreateIntentInput): Promise<IntentRef> {
    if (input.purpose === "setup") {
      const sub = await this.createSubscription({
        subscriptionId: cashfreeSubscriptionId(input.idempotencyKey),
        customerId: input.customer.providerCustomerId,
        ...(input.contact ? { contact: input.contact } : {}),
        currency: input.currency,
        ...(input.maxAmountMinor != null ? { maxAmountMinor: input.maxAmountMinor } : {}),
        ...(input.methodTypes ? { methodTypes: input.methodTypes } : {}),
        ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
        ...(input.description ? { description: input.description } : {}),
        ownershipRef: input.ownershipRef ?? input.idempotencyKey,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        intentId: sub.subscriptionId,
        status: "requires_action",
        authorization: this.sdk("subscription", sub.sessionId),
        raw: sub.raw,
      };
    }

    const amount = input.amountMinor ?? 0n;
    if (amount <= 0n) throw new Error("Cashfree payment intents need a positive amountMinor");
    const currency = input.currency.toUpperCase();
    if (!this.capabilities.currencies.includes(currency))
      throw new ProviderRefusalError(
        `Cashfree does not take payments in ${currency}. It takes ${this.capabilities.currencies.join(", ")}.`,
      );
    const problem = cashfreeOrderAmountProblem(amount, currency);
    if (problem) throw new ProviderRefusalError(problem);
    if (!input.contact?.phone)
      throw new ProviderRefusalError(
        "Cashfree needs the payer's phone number to open a payment. Add it to the customer. Then try again.",
      );
    // INR: a number without `+` stays an Indian mobile, whatever the customer's country.
    const phone = cashfreeOrderPhone(
      input.contact.phone,
      currency === CASHFREE_MANDATE_CURRENCY ? null : input.contact.country,
    );
    if (!phone) throw new ProviderRefusalError(PHONE_NOT_VALID);
    const oid = orderId(input.idempotencyKey);
    const name = atLeast3(input.contact.name, 100);
    const note = atLeast3(input.description, 200);
    const { status, json } = await this.api<{ payment_session_id?: string; order_status?: string }>(
      "intent",
      "POST",
      "/orders",
      {
        order_id: oid,
        order_amount: cashfreeAmount(amount, currency),
        order_currency: currency,
        customer_details: {
          customer_id: input.customer.providerCustomerId
            .replace(/[^A-Za-z0-9_-]/g, "_")
            .slice(0, 50),
          customer_phone: phone,
          ...(input.contact.email ? { customer_email: input.contact.email } : {}),
          ...(name ? { customer_name: name } : {}),
        },
        ...(input.returnUrl ? { order_meta: { return_url: input.returnUrl } } : {}),
        ...(note ? { order_note: note } : {}),
        // The checkout closes with our intent, so a stale link cannot take a payment.
        ...(input.expiresAt ? { order_expiry_time: input.expiresAt.toISOString() } : {}),
        order_tags: { [REF_TAG]: input.ownershipRef ?? input.idempotencyKey },
      },
      input.idempotencyKey,
    );
    if (status >= 500)
      throw markStrandedObject(
        new ProviderIndeterminateError(
          `We could not confirm whether Cashfree created order ${oid} (HTTP ${status}).`,
        ),
        oid,
      );
    if (status >= 300 || !json.payment_session_id)
      throw new ProviderRefusalError(
        `Cashfree refused the payment order: ${json.message ?? `HTTP ${status}`}`,
      );
    return {
      intentId: oid,
      status: "requires_action",
      authorization: this.sdk("order", json.payment_session_id),
      raw: json,
    };
  }

  private readOrder(oid: string): Promise<CfOrder | null> {
    return this.read<CfOrder>("fetch_intent", `/orders/${enc(oid)}`);
  }

  private async orderPayments(oid: string): Promise<CfOrderPayment[]> {
    const { status, json } = await this.api<CfOrderPayment[]>(
      "intent",
      "GET",
      `/orders/${enc(oid)}/payments`,
    );
    if (status >= 300)
      throw new Error(`Cashfree could not list payments for order ${oid}: HTTP ${status}`);
    return Array.isArray(json) ? json : [];
  }

  async consumeIntent(input: ConsumeIntentInput): Promise<ConsumeIntentResult> {
    if (input.purpose === "setup") {
      const s = await this.getSubscription(input.intentId);
      if (!s) throw new Error(`Cashfree subscription ${input.intentId} does not exist`);
      const status = (s.subscription_status ?? "").toUpperCase();
      if (status === "ACTIVE" || status === "BANK_APPROVAL_PENDING") {
        const refused = await this.refuseIndianCard(input.intentId, s);
        if (refused)
          return {
            purpose: "setup",
            failure: { code: "card_not_supported", message: refused, retriable: false },
          };
        return { purpose: "setup", paymentMethod: this.refOf(input.intentId, s) };
      }
      if (
        status === "INITIALIZED" &&
        (authOf(s)?.authorization_status ?? "").toUpperCase() !== "FAILED"
      )
        throw new Error(
          `Cashfree subscription ${input.intentId} is not authorized yet. The payer did not complete the mandate.`,
        );
      return {
        purpose: "setup",
        failure: failureFrom({
          message: `The mandate was not authorized (Cashfree status ${status}).`,
        }),
      };
    }
    const payments = await this.orderPayments(input.intentId);
    const paid = payments.find((p) => (p.payment_status ?? "").toUpperCase() === "SUCCESS");
    if (paid?.cf_payment_id != null)
      return {
        purpose: "payment",
        charge: this.orderPaymentResult(
          orderChargeRef(input.intentId, String(paid.cf_payment_id)),
          paid,
        ),
      };
    const pending = payments.some((p) => (p.payment_status ?? "").toUpperCase() === "PENDING");
    const last = latestPayment(payments);
    if (!pending && last?.cf_payment_id != null) {
      const r = this.orderPaymentResult(
        orderChargeRef(input.intentId, String(last.cf_payment_id)),
        last,
      );
      if (r.status === "failed") return { purpose: "payment", charge: r };
    }
    return {
      purpose: "payment",
      charge: {
        status: "pending",
        providerChargeId: "",
        raw: { orderId: input.intentId, reason: "no successful payment on the order yet" },
      },
    };
  }

  async fetchIntent(input: {
    intentId: string;
    purpose?: IntentPurpose;
    resolveOwnership?: boolean;
  }): Promise<FetchedIntent> {
    const id = input.intentId;
    const unknown: FetchedIntent = {
      intentId: id,
      status: "unknown",
      ...(input.resolveOwnership ? { ownership: "unknown" as const } : {}),
    };
    try {
      if (id.startsWith("tms_")) {
        const s = await this.getSubscription(id);
        if (!s) return unknown;
        const st = (s.subscription_status ?? "").toUpperCase();
        const status: FetchedIntent["status"] =
          st === "ACTIVE" || st === "BANK_APPROVAL_PENDING"
            ? "authorized"
            : st === "INITIALIZED"
              ? "requires_action"
              : "failed";
        return {
          intentId: id,
          status,
          ...(input.resolveOwnership ? ownershipOf(s.subscription_tags) : {}),
          raw: s,
        };
      }
      if (!id.startsWith("tmo_")) return unknown;
      const o = await this.readOrder(id);
      if (!o) return unknown;
      const st = (o.order_status ?? "").toUpperCase();
      let status: FetchedIntent["status"] = "unknown";
      let providerChargeId: string | undefined;
      if (st === "PAID") {
        status = "consumed";
        const paid = (await this.orderPayments(id)).find(
          (p) => (p.payment_status ?? "").toUpperCase() === "SUCCESS",
        );
        if (paid?.cf_payment_id != null)
          providerChargeId = orderChargeRef(id, String(paid.cf_payment_id));
      } else if (st === "ACTIVE") status = "requires_action";
      else if (st === "EXPIRED") status = "failed";
      else if (st === "TERMINATED") status = "voided";
      return {
        intentId: id,
        status,
        ...(providerChargeId ? { providerChargeId } : {}),
        ...orderMoney(o),
        ...(input.resolveOwnership ? ownershipOf(o.order_tags) : {}),
        raw: o,
      };
    } catch {
      // A failed read is not evidence about the money.
      return unknown;
    }
  }

  // ── refunds ────────────────────────────────────────────────────────────────

  async refund(input: RefundInput): Promise<RefundResult> {
    const ref = parseCashfreeChargeRef(input.providerChargeId);
    if (!ref || (ref.kind === "sub" && !ref.subscriptionId))
      throw new ProviderRefusalError(
        `Cashfree payment ${input.providerChargeId} was not created by tmbilling. Refund it in the Cashfree dashboard.`,
      );
    const rid = refundId(input.idempotencyKey);
    const note = atLeast3(input.reason, 100) ?? "Refund";
    let path: string;
    let body: Record<string, unknown>;
    let providerRefundId: string;
    if (ref.kind === "sub") {
      const sid = ref.subscriptionId!;
      const p = await this.read<CfPayment>(
        "refund",
        `/subscriptions/${enc(sid)}/payments/${enc(ref.paymentId)}`,
      );
      // In the payment's currency: a USD or EUR card mandate debits in its plan currency.
      const currency = (
        nonBlank(p?.payment_currency) ??
        input.currency ??
        CASHFREE_MANDATE_CURRENCY
      ).toUpperCase();
      if (input.currency && input.currency.toUpperCase() !== currency)
        throw new ProviderRefusalError(
          `Cashfree payment ${ref.paymentId} is in ${currency}. We cannot refund it in ${input.currency.toUpperCase()}.`,
        );
      const amount = input.amountMinor ?? cashfreeMinor(p?.payment_amount, currency);
      if (amount == null)
        throw new Error(`Cashfree payment ${ref.paymentId} has no amount to refund`);
      // Measured: Cashfree answers 400 "refundAmount : must be greater than or equal to 1".
      if (amount < 10n ** BigInt(exponentOf(currency)))
        throw new ProviderRefusalError(
          `Cashfree takes a subscription refund of at least 1 ${currency}.`,
        );
      // A CHARGE payment carries no authorization details: the rail is the subscription's.
      let group = railOf(p?.authorization_details ?? null);
      if (!group) {
        const sub = await this.getSubscription(sid);
        group = sub ? railOf(authOf(sub)) : undefined;
      }
      path = `/subscriptions/${enc(sid)}/refunds`;
      // UPI refunds are STANDARD only, eNACH/pNACH INSTANT only.
      body = {
        subscription_id: sid,
        payment_id: ref.paymentId,
        refund_id: rid,
        refund_amount: cashfreeAmount(amount, currency),
        refund_note: note,
        refund_speed: group === "enach" || group === "pnach" ? "INSTANT" : "STANDARD",
      };
      providerRefundId = subRefundRef(ref.paymentId, rid);
    } else {
      // Refunds are taken in the ORDER's currency, whatever the payer's card paid in.
      const order = await this.read<CfOrder>("refund", `/orders/${enc(ref.orderId)}`);
      const money = orderMoney(order);
      if (!money.currency || money.amountMinor == null)
        throw new Error(`Cashfree order ${ref.orderId} has no amount to refund`);
      const currency = money.currency;
      if (input.currency && input.currency.toUpperCase() !== currency)
        throw new ProviderRefusalError(
          `Cashfree order ${ref.orderId} is in ${currency}. We cannot refund it in ${input.currency.toUpperCase()}.`,
        );
      let amount = input.amountMinor;
      if (amount == null) {
        // Full refund: what is left of the order. Refunds still in progress count as taken.
        const taken = await this.fetchOrderRefundedTotal(ref.orderId, ref.cfPaymentId, undefined, {
          currency,
          includePending: true,
        });
        if ("problem" in taken) throw new Error(taken.problem);
        amount = money.amountMinor - taken.total;
        if (amount <= 0n)
          throw new ProviderRefusalError(
            `Cashfree order ${ref.orderId} has no amount left to refund.`,
          );
      }
      if (amount <= 0n) throw new ProviderRefusalError("A refund must be more than 0.");
      path = `/orders/${enc(ref.orderId)}/refunds`;
      body = {
        refund_id: rid,
        refund_amount: cashfreeAmount(amount, currency),
        refund_note: note,
        refund_speed: "STANDARD",
      };
      providerRefundId = orderRefundRef(ref.orderId, rid);
    }
    let res: { status: number; json: CfRefund & CfError };
    try {
      res = await this.api<CfRefund>("refund", "POST", path, body, input.idempotencyKey);
    } catch {
      // No answer: the refund may exist. Our id is queryable, so the sweep resolves it.
      return { status: "pending", providerRefundId };
    }
    // 408, 409, 429 and 5xx may have made the refund: our id finds it later.
    if (classifyGatewayHttp({ status: res.status }).kind === "retry_same_key")
      return { status: "pending", providerRefundId, raw: res.json };
    if (res.status >= 300)
      return {
        status: "failed",
        providerRefundId,
        failureMessage: `Cashfree refused the refund (${res.json.code ?? `HTTP ${res.status}`}).${res.json.message ? ` ${res.json.message}` : ""}`,
        raw: res.json,
      };
    return { status: refundStatus(res.json.refund_status), providerRefundId, raw: res.json };
  }

  async fetchRefundStatus(input: { providerRefundId: string }): Promise<RefundResult> {
    const ref = parseRefundRef(input.providerRefundId);
    if (!ref) return { status: "pending", providerRefundId: input.providerRefundId };
    let path: string;
    if (ref.kind === "sub") {
      const sid = subscriptionOfPayment(ref.paymentId);
      if (!sid) return { status: "pending", providerRefundId: input.providerRefundId };
      path = `/subscriptions/${enc(sid)}/refunds/${enc(ref.refundId)}`;
    } else path = `/orders/${enc(ref.orderId)}/refunds/${enc(ref.refundId)}`;
    const { status, json } = await this.api<CfRefund>("refund_status", "GET", path);
    // Never created: no money left.
    if (status === 404)
      return { status: "failed", providerRefundId: input.providerRefundId, raw: json };
    if (status >= 300)
      return { status: "pending", providerRefundId: input.providerRefundId, raw: json };
    return {
      status: refundStatus(json.refund_status),
      providerRefundId: input.providerRefundId,
      raw: json,
    };
  }

  // ── webhooks ───────────────────────────────────────────────────────────────

  /**
   * `x-idempotency-key` is Cashfree's dedupe key where it sends one. Without it, the
   * object, its status and the event time together name one event.
   */
  webhookEventId(input: NormalizeWebhookInput): string {
    return webhookEventId(
      [headerValue(input.headers, "x-idempotency-key"), derivedEventId(input.payload)],
      input.payload,
    );
  }

  /**
   * Base64(HMAC-SHA256(timestamp + raw body, key)), then a freshness check. The key is the
   * endpoint's own Secret Key where Cashfree shows one, else the account's API Secret Key.
   */
  verifySignature(input: NormalizeWebhookInput): void {
    const ts = headerValue(input.headers, "x-webhook-timestamp");
    const sig = headerValue(input.headers, "x-webhook-signature");
    if (!ts || !sig) throw new Error("Cashfree webhook is missing its signature headers");
    const b = Buffer.from(sig);
    const signedBy = (key: string) => {
      const a = Buffer.from(
        createHmac("sha256", key)
          .update(ts + input.payload.toString())
          .digest("base64"),
      );
      return a.length === b.length && timingSafeEqual(a, b);
    };
    const keys = [this.cfg.webhookSecret, this.cfg.secretKey].filter((k): k is string => !!k);
    if (!keys.some(signedBy)) throw new Error("Cashfree webhook signature verification failed");
    // Seconds on webhook version 2026-01-01 (measured); older versions document milliseconds.
    const raw = Number(ts);
    const at = raw < 1e12 ? raw * 1000 : raw;
    const now = this.cfg.now?.() ?? Date.now();
    if (
      !Number.isFinite(at) ||
      now - at > CASHFREE_WEBHOOK_MAX_AGE_MS ||
      at - now > WEBHOOK_FUTURE_SKEW_MS
    )
      throw new Error(
        `Cashfree webhook timestamp is outside the accepted window (x-webhook-timestamp ${ts}, now ${now})`,
      );
  }

  async normalizeWebhook(input: NormalizeWebhookInput): Promise<NormalizedProviderEvent[]> {
    this.verifySignature(input);
    const event = parseCashfreeJson(input.payload.toString()) as {
      type?: string;
      event_time?: string;
      data?: any;
    };
    const base = {
      providerEventId: this.webhookEventId(input),
      occurredAt: cashfreeTime(event.event_time) ?? new Date(),
      raw: event,
    };
    // The dashboard's "Test" button sends this, signed but with no version header. Answer it
    // as a no-op, or Cashfree shows the endpoint as failing.
    if (event.type === "WEBHOOK" && event.data?.test_object !== undefined)
      return [{ ...base, type: "unknown" }];
    // The operator picks the version per endpoint. A shape we have no fixtures for is never
    // guessed at: the row records an error and the health check names the version to select.
    const version = headerValue(input.headers, "x-webhook-version");
    if (!version || !CASHFREE_WEBHOOK_VERSIONS.includes(version))
      return [{ ...base, type: "unknown", unresolved: unreadVersionMessage(version) }];
    const [primary, ...implied] = normalizeCashfreeEvents(event.type ?? "", event.data ?? {});
    const ev: NormalizedProviderEvent = { ...base, ...primary! };
    const auto = event.type === "AUTO_REFUND_STATUS_WEBHOOK";
    const r = auto ? event.data?.auto_refund : event.data?.refund;
    if (
      ev.type === "charge.refunded" &&
      (auto || event.type === "REFUND_STATUS_WEBHOOK") &&
      r?.order_id &&
      r.cf_payment_id != null
    ) {
      // The engine books a FULL refund when the total is absent, so an order refund always
      // carries its total, or is left unresolved (and redelivered).
      const got = await this.orderRefundedTotalFor(r, auto);
      if ("total" in got) ev.amountRefundedMinor = got.total;
      else ev.unresolved = got.problem;
    }
    return [ev, ...implied.map((x) => ({ ...base, ...x }))];
  }

  /**
   * The running refund total of the order payment a refund event names, in the ORDER's
   * currency. A refund in another currency, or with more decimals than it has, is a problem,
   * never a guess. An auto refund returns the whole payment, so its own amount is the total
   * when the list cannot be read.
   */
  private async orderRefundedTotalFor(
    r: {
      order_id: string;
      cf_payment_id: string | number;
      refund_id?: string;
      cf_refund_id?: string | number;
      refund_amount?: unknown;
      refund_currency?: string;
    },
    auto: boolean,
  ): Promise<{ total: bigint } | { problem: string }> {
    let order: CfOrder | null;
    try {
      order = await this.readOrder(r.order_id);
    } catch {
      order = null;
    }
    const currency = order?.order_currency?.toUpperCase();
    if (!currency)
      return {
        problem: `We could not read Cashfree order ${r.order_id}, so we did not record the refund.`,
      };
    const named = nonBlank(r.refund_currency)?.toUpperCase();
    if (named && named !== currency)
      return {
        problem: `Cashfree refund ${r.refund_id ?? r.cf_refund_id} is in ${named}, but its order is in ${currency}. We did not record it.`,
      };
    const own = cashfreeMinor(r.refund_amount, currency);
    if (own == null)
      return {
        problem: `Cashfree refund ${r.refund_id ?? r.cf_refund_id} has an amount we cannot read in ${currency} (${String(r.refund_amount)}). We did not record it.`,
      };
    const got = await this.fetchOrderRefundedTotal(
      r.order_id,
      String(r.cf_payment_id),
      {
        refundId: r.refund_id,
        cfRefundId: r.cf_refund_id != null ? String(r.cf_refund_id) : undefined,
        amountMinor: own,
      },
      { currency },
    );
    if ("problem" in got && auto) return { total: own };
    return got;
  }

  /**
   * Total of the SUCCESS refunds on one order payment, read from Cashfree, in minor units of
   * the order's `currency`. `settled` is the refund the caller knows succeeded, counted even
   * when the list does not show it yet. `includePending` also counts refunds not failed yet.
   * A problem when the list cannot be read, or a refund in it is in another currency or has
   * an amount we cannot read: never a partial figure presented as the total.
   */
  async fetchOrderRefundedTotal(
    oid: string,
    cfPaymentId: string,
    settled: { refundId?: string; cfRefundId?: string; amountMinor?: bigint } | undefined,
    opts: { currency: string; includePending?: boolean },
  ): Promise<{ total: bigint } | { problem: string }> {
    const unread = { problem: `We could not read the refunds of Cashfree order ${oid}.` };
    let res: { status: number; json: CfOrderRefund[] & CfError };
    try {
      res = await this.api<CfOrderRefund[]>("refund_status", "GET", `/orders/${enc(oid)}/refunds`);
    } catch {
      return unread;
    }
    if (res.status >= 300 || !Array.isArray(res.json)) return unread;
    const mine = res.json.filter((x) => String(x.cf_payment_id ?? "") === cfPaymentId);
    const currency = opts.currency.toUpperCase();
    let total = 0n;
    for (const x of mine) {
      const st = refundStatus(x.refund_status);
      if (st === "failed" || (st === "pending" && !opts.includePending)) continue;
      const named = nonBlank(x.refund_currency)?.toUpperCase();
      if (named && named !== currency)
        return {
          problem: `Cashfree order ${oid} lists a refund in ${named}, but the order is in ${currency}.`,
        };
      const a = cashfreeMinor(x.refund_amount, currency);
      if (a == null)
        return {
          problem: `Cashfree order ${oid} lists a refund amount we cannot read in ${currency} (${String(x.refund_amount)}).`,
        };
      total += a;
    }
    const listed = mine.some(
      (x) =>
        ((settled?.refundId && x.refund_id === settled.refundId) ||
          (settled?.cfRefundId && String(x.cf_refund_id ?? "") === settled.cfRefundId)) &&
        refundStatus(x.refund_status) === "succeeded",
    );
    if ((settled?.refundId || settled?.cfRefundId) && !listed) {
      if (settled.amountMinor == null) return unread;
      total += settled.amountMinor;
    }
    return { total };
  }
}

const unreadVersionMessage = (version: string | undefined) =>
  `We do not read Cashfree webhook version ${version ?? "(none)"}. In Cashfree, select version ` +
  `${CASHFREE_PAYMENTS_WEBHOOK_VERSION} on the Payments tab and ` +
  `${CASHFREE_SUBSCRIPTIONS_WEBHOOK_VERSION} on the Subscriptions tab of the webhook endpoint.`;

const VERSION_STEPS = [
  "In Cashfree, go to Developers → Webhooks.",
  `On the Payments tab, select webhook version ${CASHFREE_PAYMENTS_WEBHOOK_VERSION} for this endpoint.`,
  `On the Subscriptions tab, select webhook version ${CASHFREE_SUBSCRIPTIONS_WEBHOOK_VERSION} for this endpoint.`,
];

/**
 * The health check's webhook-version row, from the latest deliveries: each must be on the
 * version its tab needs (subscription events on the Subscriptions tab, the rest on Payments).
 */
export function cashfreeWebhookVersionCheck(
  recent: NonNullable<HealthCheckInput["recentWebhooks"]>,
): HealthCheckItem {
  const key = "webhook_version";
  if (recent.length === 0)
    return {
      key,
      status: "unchecked",
      message: "No Cashfree webhook arrived yet. We check its version when one arrives.",
      steps: VERSION_STEPS,
    };
  const seen = recent.map((r) => {
    const type = String((r.payload as { type?: unknown } | null)?.type ?? "");
    const subscriptions = type.startsWith("SUBSCRIPTION_");
    return {
      version: headerValue(r.headers, "x-webhook-version") ?? "(none)",
      tab: subscriptions ? "Subscriptions" : "Payments",
      want: subscriptions
        ? CASHFREE_SUBSCRIPTIONS_WEBHOOK_VERSION
        : CASHFREE_PAYMENTS_WEBHOOK_VERSION,
    };
  });
  const unread = seen.find((x) => !CASHFREE_WEBHOOK_VERSIONS.includes(x.version));
  if (unread)
    return {
      key,
      status: "failed",
      message: `Cashfree sends webhooks on version ${unread.version}. We do not read this version, so we do not record these events.`,
      steps: VERSION_STEPS,
    };
  const off = seen.find((x) => x.version !== x.want);
  if (off)
    return {
      key,
      status: "failed",
      message: `Cashfree sends ${off.tab} webhooks on version ${off.version}. Select version ${off.want} on the ${off.tab} tab.`,
      steps: VERSION_STEPS,
    };
  return {
    key,
    status: "ok",
    message: `Cashfree sends webhooks on the versions we read (${[...new Set(seen.map((x) => x.version))].sort().join(", ")}).`,
  };
}

interface CfOrderRefund {
  refund_id?: string;
  cf_refund_id?: string | number;
  cf_payment_id?: string | number;
  refund_amount?: number | string;
  refund_currency?: string;
  refund_status?: string;
}

interface CfOrder {
  order_status?: string;
  order_amount?: number | string;
  order_currency?: string;
  order_tags?: unknown;
}

/** The order's amount and currency, the money we book: never the payment's (see the header). */
function orderMoney(o: CfOrder | null | undefined): { amountMinor?: bigint; currency?: string } {
  const currency = o?.order_currency?.toUpperCase();
  const amountMinor = cashfreeMinor(o?.order_amount, currency);
  return currency && amountMinor != null ? { amountMinor, currency } : {};
}

// ── webhook mapping (pure) ───────────────────────────────────────────────────

interface CfPayment {
  payment_id?: string;
  cf_payment_id?: string | number;
  payment_status?: string;
  payment_type?: string;
  payment_amount?: number | string;
  payment_currency?: string | null;
  payment_schedule_date?: string | null;
  failure_details?: { failure_reason?: string | null } | null;
  authorization_details?: CfAuthorization | null;
}

interface CfOrderPayment {
  cf_payment_id?: string | number;
  payment_status?: string;
  /** `upi`, `credit_card`, `debit_card`, `net_banking`, `wallet`, … */
  payment_group?: string | null;
  payment_amount?: number | string;
  payment_message?: string;
  payment_time?: string | null;
  payment_completion_time?: string | null;
  error_details?: {
    error_code?: string | null;
    error_reason?: string | null;
    error_description?: string | null;
  } | null;
}

/** The newest attempt on an order. Cashfree does not document the list's order. */
export function latestPayment<
  T extends { cf_payment_id?: string | number; payment_time?: string | null },
>(payments: T[]): T | undefined {
  const at = (p: T) => cashfreeTime(p.payment_time)?.getTime() ?? -Infinity;
  const id = (p: T) => {
    try {
      return BigInt(String(p.cf_payment_id ?? "0"));
    } catch {
      return 0n;
    }
  };
  return [...payments]
    .sort((a, b) => at(a) - at(b) || (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0))
    .at(-1);
}

interface CfRefund {
  refund_id?: string;
  refund_status?: string;
}

function refundStatus(s: string | undefined): RefundResult["status"] {
  const v = (s ?? "").toUpperCase();
  if (v === "SUCCESS") return "succeeded";
  if (v === "FAILED" || v === "CANCEL" || v === "CANCELLED" || v === "REJECTED") return "failed";
  return "pending";
}

interface CfAttemptFailure {
  failure_reason?: string | null;
  failure_error_code?: string | null;
  failure_sub_error_code?: string | null;
}

interface CfNotification {
  notification_id?: string;
  notification_status?: string;
  notification_attempted_time?: string | null;
  notification_completed_time?: string | null;
  notification_failure_details?: CfAttemptFailure | null;
  payment_id?: string;
  payment_status?: string;
}

const noticeDeliveredAt = (n: CfNotification) =>
  cashfreeTime(n.notification_completed_time) ?? cashfreeTime(n.notification_attempted_time);

/** The earliest execution after a delivered notice. */
const executableAfterNotice = (deliveredAt: Date) =>
  nextUpiDebitWindow(new Date(deliveredAt.getTime() + CASHFREE_UPI_NOTICE_LEAD_HOURS * HOUR_MS));

/** A failed notice's code and reason, sub-code included (Cashfree often sends no code). */
export function noticeFailure(fd: CfAttemptFailure | null | undefined): {
  failureCode?: string;
  failureMessage?: string;
} {
  const sub = fd?.failure_sub_error_code || undefined;
  const code = fd?.failure_error_code || sub;
  const parts = [
    fd?.failure_reason || undefined,
    sub && sub !== code ? `sub-code ${sub}` : undefined,
  ];
  const message = parts.filter(Boolean).join(", ");
  return {
    ...(code ? { failureCode: code } : {}),
    ...(message ? { failureMessage: message } : {}),
  };
}

const TIMESTAMP =
  /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/;

/**
 * Wait for an execution Cashfree refused only as too early: a notice still in delivery
 * ("No successful notification"), a debit before the notice's date (measured: "Payment
 * attempt date cannot be before the scheduled date 2026-10-27"), or an NPCI blackout
 * refusal, which names the next permitted time. Undefined for any other refusal.
 */
export function notDueWaitMs(json: CfError, now: Date): number | undefined {
  const msg = json.message ?? "";
  if (/no successful notification/i.test(msg)) return NOTICE_RECHECK_MS;
  const m = TIMESTAMP.exec(msg);
  const named = m ? (m[0].length === 10 ? `${m[0]}T00:00:00+05:30` : m[0].replace(" ", "T")) : "";
  const at = cashfreeTime(named);
  const timing = /blackout|peak|window|permitted|not allowed|after|before|until/i.test(msg);
  if (at && timing) return Math.max(at.getTime() - now.getTime(), 60_000);
  if (/blackout|peak hour/i.test(msg))
    return Math.max(nextUpiDebitWindow(now).getTime() - now.getTime(), 15 * 60_000);
  return undefined;
}

function derivedEventId(raw: string | Buffer): string | undefined {
  try {
    const e = parseCashfreeJson(raw.toString()) as {
      type?: string;
      event_time?: string;
      data?: any;
    };
    const d = e.data ?? {};
    const obj =
      d.refund?.refund_id ??
      (d.auto_refund?.cf_refund_id != null ? `auto-${d.auto_refund.cf_refund_id}` : undefined) ??
      d.refund_id ??
      d.execution_id ??
      d.notification_id ??
      d.payment?.cf_payment_id ??
      d.payment_id ??
      d.dispute?.dispute_id ??
      d.subscription_details?.subscription_id ??
      d.subscription_status_webhook?.subscription_details?.subscription_id;
    const status =
      d.refund?.refund_status ??
      d.auto_refund?.refund_status ??
      d.refund_status ??
      d.execution_status ??
      d.notification_status ??
      d.payment?.payment_status ??
      d.payment_status ??
      d.dispute?.dispute_status ??
      d.subscription_details?.subscription_status ??
      "";
    if (!e.type || obj == null) return undefined;
    return `${e.type}:${obj}:${status}:${e.event_time ?? ""}`;
  } catch {
    return undefined;
  }
}

type Mapped = Omit<NormalizedProviderEvent, "providerEventId" | "occurredAt" | "raw">;

const subOwnership = (d: any) =>
  ownershipOf(d?.subscription_details?.subscription_tags ?? undefined);

/** Event `type` + `data` → our vocabulary. Exported for the offline suite. */
export function normalizeCashfreeEvent(type: string, d: any): Mapped {
  switch (type) {
    // ── PG orders ────────────────────────────────────────────────────────────
    case "PAYMENT_SUCCESS_WEBHOOK":
    case "PAYMENT_FAILED_WEBHOOK": {
      const oid = d.order?.order_id;
      const cfp = d.payment?.cf_payment_id;
      const ok = type === "PAYMENT_SUCCESS_WEBHOOK";
      const f = ok
        ? undefined
        : failureFrom({
            code: d.error_details?.error_reason ?? null,
            message: d.error_details?.error_description ?? d.payment?.payment_message ?? null,
          });
      // From the order: an Indian card on a USD order pays in INR (payment_amount 95.16
      // INR for a 1 USD order, measured), but the charge was booked in USD.
      const captured = ok ? orderMoney(d.order).amountMinor : undefined;
      // A paid order is the intent's capture: the engine books it through the intent (the
      // same consume as the buyer's return), which records the method and never books it
      // as a stray capture. A failed attempt leaves the order payable, so it is a charge
      // event only.
      return {
        type: ok ? "intent.authorized" : "charge.failed",
        ...(ok ? { captureState: "succeeded" as const } : {}),
        ...(oid && cfp != null ? { providerChargeId: orderChargeRef(oid, String(cfp)) } : {}),
        ...(oid ? { providerIntentId: oid } : {}),
        ...(captured != null ? { capturedAmountMinor: captured } : {}),
        ...(f
          ? {
              failureCode: f.code,
              failureRetriable: f.retriable,
              failureMessage: f.message,
              ...(f.providerCode ? { providerFailureCode: f.providerCode } : {}),
            }
          : {}),
        ...ownershipOf(d.order?.order_tags ?? undefined),
      };
    }
    case "REFUND_STATUS_WEBHOOK": {
      const r = d.refund ?? {};
      const status = refundStatus(r.refund_status);
      // No `amountRefundedMinor` here: the event carries this refund's amount, and the engine
      // reads the field as the payment's running total. `normalizeWebhook` adds the total.
      return {
        type:
          status === "succeeded"
            ? "charge.refunded"
            : status === "failed"
              ? "refund.failed"
              : "refund.pending",
        ...(r.order_id && r.cf_payment_id != null
          ? { providerChargeId: orderChargeRef(r.order_id, String(r.cf_payment_id)) }
          : {}),
        ...(r.order_id && r.refund_id
          ? { providerRefundId: orderRefundRef(r.order_id, r.refund_id) }
          : {}),
      };
    }
    // Cashfree returned a payment on its own: one that landed after its order expired, or
    // a second payment on an already paid order. Documented for successful ones only.
    case "AUTO_REFUND_STATUS_WEBHOOK": {
      const r = d.auto_refund ?? {};
      if (refundStatus(r.refund_status) !== "succeeded") return { type: "unknown" };
      return {
        type: "charge.refunded",
        ...(r.order_id && r.cf_payment_id != null
          ? { providerChargeId: orderChargeRef(r.order_id, String(r.cf_payment_id)) }
          : {}),
        ...(r.order_id && r.cf_refund_id != null
          ? { providerRefundId: orderRefundRef(r.order_id, `auto-${r.cf_refund_id}`) }
          : {}),
      };
    }
    case "DISPUTE_CREATED":
    case "DISPUTE_UPDATED":
    case "DISPUTE_CLOSED":
      return cashfreeDisputeEvents(type, d)[0]!;
    // ── subscriptions ────────────────────────────────────────────────────────
    case "SUBSCRIPTION_STATUS_CHANGED": {
      const s: CfSubscription = {
        ...(d.subscription_details ?? {}),
        plan_details: d.plan_details,
        authorization_details: d.authorization_details,
      };
      const { mandate } = describeCashfreeSubscription(s);
      return {
        type: "payment_method.mandate_updated",
        ...(s.subscription_id ? { providerPaymentMethodId: s.subscription_id } : {}),
        mandate,
        ...subOwnership(d),
      };
    }
    case "SUBSCRIPTION_AUTH_STATUS":
      return authEvent(d);
    case "SUBSCRIPTION_PAYMENT_SUCCESS":
    case "SUBSCRIPTION_PAYMENT_FAILED":
    case "SUBSCRIPTION_PAYMENT_CANCELLED": {
      if ((d.payment_type ?? "").toUpperCase() === "AUTH") return authEvent(d);
      const ok = type === "SUBSCRIPTION_PAYMENT_SUCCESS";
      // Version 2023-08-01 spells it `failureDetails.failureReason`.
      const reason = d.failure_details?.failure_reason ?? d.failureDetails?.failureReason;
      const f = ok
        ? undefined
        : failureFrom({ message: reason || `payment ${d.payment_status ?? ""}` });
      // The engine books a success after a FAILED on the same payment id by this amount.
      const amount = cashfreeMinor(d.payment_amount, d.payment_currency ?? "INR");
      return {
        type: ok ? "charge.succeeded" : "charge.failed",
        ...(d.payment_id ? { providerChargeId: subChargeRef(d.payment_id) } : {}),
        ...(amount != null ? { amountMinor: amount } : {}),
        ...(ok && amount != null ? { capturedAmountMinor: amount } : {}),
        ...(f
          ? {
              failureCode: f.code,
              failureRetriable: f.retriable,
              failureMessage: f.message,
              // Cashfree sends no code here, only its reason; it is what the attempt keeps.
              ...(reason ? { providerFailureCode: String(reason).slice(0, 200) } : {}),
            }
          : {}),
        ...subOwnership(d),
      };
    }
    case "SUBSCRIPTION_REFUND_STATUS": {
      const status = refundStatus(d.refund_status);
      const rid = d.payment_id && d.refund_id ? subRefundRef(d.payment_id, d.refund_id) : undefined;
      // The event carries this refund's own amount; there is no running total to read.
      const amount = cashfreeMinor(d.refund_amount, d.refund_currency ?? "INR");
      const booked = status === "succeeded";
      return {
        type: booked ? "charge.refunded" : status === "failed" ? "refund.failed" : "refund.pending",
        ...(d.payment_id ? { providerChargeId: subChargeRef(d.payment_id) } : {}),
        ...(rid ? { providerRefundId: rid } : {}),
        ...(booked && rid && amount != null
          ? { refunds: [{ providerRefundId: rid, amountMinor: amount, status }] }
          : {}),
        // Without both, the engine would read the event as a full refund.
        ...(booked && (!rid || amount == null)
          ? {
              unresolved:
                "The Cashfree refund event has no refund id or amount. We did not record it.",
            }
          : {}),
      };
    }
    // Controlled flow. The overview page spells these with `PAYMENT_`; accept both.
    case "SUBSCRIPTION_CONTROLLED_NOTIFICATION_STATUS":
    case "SUBSCRIPTION_PAYMENT_CONTROLLED_NOTIFICATION_STATUS": {
      const s = (d.notification_status ?? "").toUpperCase();
      if (!d.notification_id || (s !== "SUCCESS" && s !== "FAILED")) return { type: "unknown" };
      // The 25 h lead counts from delivery, not from our request.
      const delivered = s === "SUCCESS" ? noticeDeliveredAt(d) : undefined;
      return {
        type: "pre_debit_notice.updated",
        preDebitNotice: {
          notificationRef: d.notification_id,
          status: s === "SUCCESS" ? "sent" : "failed",
          ...(delivered ? { executableAfter: executableAfterNotice(delivered) } : {}),
          ...(s === "FAILED" ? noticeFailure(d.notification_failure_details) : {}),
        },
      };
    }
    case "SUBSCRIPTION_CONTROLLED_EXECUTION_STATUS":
    case "SUBSCRIPTION_PAYMENT_CONTROLLED_EXECUTION_STATUS": {
      const s = (d.execution_status ?? "").toUpperCase();
      const fd = d.failure_details ?? {};
      const f =
        s === "FAILED"
          ? failureFrom({ code: fd.failure_error_code || null, message: fd.failure_reason || null })
          : undefined;
      const amount = cashfreeMinor(d.payment_amount, d.payment_currency ?? "INR");
      return {
        type:
          s === "SUCCESS"
            ? "charge.succeeded"
            : s === "FAILED"
              ? "charge.failed"
              : "charge.pending",
        ...(d.payment_id ? { providerChargeId: subChargeRef(d.payment_id) } : {}),
        ...(amount != null ? { amountMinor: amount } : {}),
        ...(s === "SUCCESS" && amount != null ? { capturedAmountMinor: amount } : {}),
        ...(f
          ? {
              failureCode: f.code,
              failureRetriable: f.retriable,
              failureMessage: f.message,
              ...(f.providerCode ? { providerFailureCode: f.providerCode } : {}),
            }
          : {}),
      };
    }
    // Kept as `unknown`, persisted for the record: Cashfree's own PDN in the default flow,
    // a dropped checkout (the order stays payable), the fee breakdown and the card-expiry
    // reminder.
    default:
      return { type: "unknown" };
  }
}

const DISPUTE_STATUS = /^(DISPUTE|CHARGEBACK|RETRIEVAL|PRE_ARBITRATION|ARBITRATION)_(.+)$/;

const nonBlank = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * A dispute's money in the ORDER's currency, the one the payment was booked in. A dispute in
 * the payment's currency (an Indian card on a USD order disputes 95.16 INR) is scaled to the
 * order: order amount × dispute / payment, half up. Anything else is a problem, never a guess.
 */
export function disputeMoney(
  dp: Record<string, unknown>,
  od: Record<string, unknown>,
): { amountMinor?: bigint; currency: string } | { problem: string } {
  const orderCur = nonBlank(od.order_currency)?.toUpperCase();
  const cur = nonBlank(dp.dispute_amount_currency)?.toUpperCase() ?? orderCur;
  if (!cur) return { problem: "The Cashfree dispute names no currency. We did not record it." };
  const hasAmount = dp.dispute_amount != null && dp.dispute_amount !== "";
  const amount = hasAmount ? cashfreeMinor(dp.dispute_amount, cur) : undefined;
  if (hasAmount && amount == null)
    return {
      problem: `The Cashfree dispute amount ${String(dp.dispute_amount)} ${cur} cannot be read. We did not record it.`,
    };
  if (!orderCur || cur === orderCur)
    return { ...(amount != null ? { amountMinor: amount } : {}), currency: cur };
  const payCur = nonBlank(od.payment_currency)?.toUpperCase();
  const orderMinor = cashfreeMinor(od.order_amount, orderCur);
  const payMinor = cashfreeMinor(od.payment_amount, payCur);
  if (cur !== payCur || orderMinor == null || payMinor == null || payMinor <= 0n)
    return {
      problem: `The Cashfree dispute is in ${cur}, but its order is in ${orderCur}. We did not record it.`,
    };
  if (amount == null) return { currency: orderCur };
  return {
    amountMinor: (orderMinor * amount * 2n + payMinor) / (payMinor * 2n),
    currency: orderCur,
  };
}

/**
 * A dispute webhook → our dispute events. Cashfree takes the disputed amount when a
 * dispute or chargeback opens and returns it when the merchant wins; a retrieval request
 * only asks for documents. Pre-arbitration and arbitration open after the merchant won
 * the stage before and take the money again, so each is its own case: `<id>:<stage>`.
 */
export function cashfreeDisputeEvents(type: string, d: any): Mapped[] {
  const dp = d.dispute ?? {};
  const od = d.order_details ?? {};
  const status = String(dp.dispute_status ?? "")
    .replace(/"/g, "")
    .toUpperCase();
  const m = DISPUTE_STATUS.exec(status);
  const stage = m?.[1] ?? String(dp.dispute_type ?? "").toUpperCase();
  const outcome = m?.[2] ?? "";
  const id = dp.dispute_id != null ? String(dp.dispute_id) : undefined;
  const later = stage === "PRE_ARBITRATION" || stage === "ARBITRATION";
  const money = disputeMoney(dp, od);
  const fields = {
    ...(id ? { providerDisputeId: later ? `${id}:${stage.toLowerCase()}` : id } : {}),
    ...(od.order_id && od.cf_payment_id != null
      ? { providerChargeId: orderChargeRef(od.order_id, String(od.cf_payment_id)) }
      : {}),
    disputeReason: dp.reason_description ?? dp.dispute_reason ?? null,
    disputeStatus: status || null,
    ...("problem" in money
      ? { unresolved: money.problem }
      : {
          ...(money.amountMinor != null ? { disputeAmountMinor: money.amountMinor } : {}),
          disputeCurrency: money.currency,
        }),
    evidenceDueBy: cashfreeTime(dp.respond_by) ?? null,
  };
  // INSUFFICIENT_EVIDENCE asks for documents again while open; it is a loss only on close.
  const lost =
    outcome === "MERCHANT_LOST" ||
    outcome === "MERCHANT_ACCEPTED" ||
    (outcome === "INSUFFICIENT_EVIDENCE" && type === "DISPUTE_CLOSED");
  const t: Mapped["type"] =
    outcome === "MERCHANT_WON" || outcome.endsWith("REVERSAL")
      ? "dispute.won"
      : lost
        ? "dispute.lost"
        : type === "DISPUTE_CLOSED"
          ? "dispute.closed"
          : "dispute.created";
  const ev: Mapped = { type: t, ...fields };
  if (t === "dispute.created" && stage !== "RETRIEVAL")
    return [ev, { ...ev, type: "dispute.funds_withdrawn" }];
  return [ev];
}

/** Every event one webhook carries: the primary, plus the ones it implies. */
export function normalizeCashfreeEvents(type: string, d: any): Mapped[] {
  if (type === "DISPUTE_CREATED" || type === "DISPUTE_UPDATED" || type === "DISPUTE_CLOSED")
    return cashfreeDisputeEvents(type, d);
  const ev = normalizeCashfreeEvent(type, d);
  // A refused eNACH mandate goes BANK_APPROVAL_PENDING → INITIALIZED, which Cashfree does
  // not report as a status change. The failed authorization is the only notice.
  const failed =
    type === "SUBSCRIPTION_PAYMENT_FAILED" || (d.payment_status ?? "").toUpperCase() === "FAILED";
  if (ev.type === "intent.setup_failed" && failed && ev.providerIntentId) {
    const { mandate } = describeCashfreeSubscription({
      ...(d.subscription_details ?? {}),
      plan_details: d.plan_details,
      authorization_details: d.authorization_details,
    });
    return [
      ev,
      {
        type: "payment_method.mandate_updated",
        providerPaymentMethodId: ev.providerIntentId,
        mandate: { ...mandate, status: "rejected" },
        ...subOwnership(d),
      },
    ];
  }
  return [ev];
}

/** The mandate authorization: the setup intent is the subscription. */
function authEvent(d: any): Mapped {
  const sid = d.subscription_id ?? d.subscription_details?.subscription_id;
  const ok =
    (d.payment_status ?? "").toUpperCase() === "SUCCESS" ||
    ["ACTIVE", "BANK_APPROVAL_PENDING"].includes(
      (d.subscription_details?.subscription_status ?? "").toUpperCase(),
    );
  return {
    type: ok ? "intent.setup_succeeded" : "intent.setup_failed",
    ...(sid ? { providerIntentId: sid } : {}),
    ...subOwnership(d),
  };
}
