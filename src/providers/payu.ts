/**
 * PayU India. Plain HTTP: hosted checkout (`_payment`) for the buyer, the `postservice`
 * commands for everything server-side. INR only.
 *
 * - Mandates: Standing Instructions (`si=1`, `billingCycle: ADHOC`, so PayU never debits on
 *   its own). The registration's `mihpayid` is the mandate (`authpayuid`). Rails: card, UPI
 *   Autopay, net banking / eNACH. Card and UPI registration debits ₹1 (net banking ₹0).
 * - Renewals: `pre_debit_SI` (card, UPI) through the engine's notice gate, then
 *   `si_transaction`. Net banking needs no notice.
 * - One-off payments: hosted checkout with no `si` and no method restriction, so the payer
 *   sees every enabled method. Never vaulted: only an SI registration (`payment_source:
 *   sist`) becomes an instrument.
 *
 * Every `txnid` is ours (≤ 25 chars) and starts with its kind, so a webhook or a poll can
 * route it: `tmsu` setup, `tmpy` one-off, `tmrc` renewal. The charge id IS the txnid
 * (`verify_payment` answers by it); a refund id is `<txnid>:<refund token>`. A vaulted
 * instrument is `<rail>:<authpayuid>` because PayU's mandate commands differ per rail.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  ChargeInput,
  ChargeResult,
  ConsumeIntentInput,
  ConsumeIntentResult,
  CreateIntentInput,
  EnsureCustomerInput,
  FetchedIntent,
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
  preDebitRule,
} from "./types";
import { providerFetch } from "./http";
import { normalizePayuDecline } from "./decline-codes";
import { shortReference } from "./short-reference";
import { webhookEventId } from "./webhook-event-id";

export const PAYU_TEST_CHECKOUT = "https://test.payu.in/_payment";
export const PAYU_LIVE_CHECKOUT = "https://secure.payu.in/_payment";
export const PAYU_TEST_POSTSERVICE = "https://test.payu.in/merchant/postservice.php?form=2";
export const PAYU_LIVE_POSTSERVICE = "https://info.payu.in/merchant/postservice.php?form=2";

/** Default per-debit ceiling when the caller sends none: ₹10,000. */
const DEFAULT_MANDATE_MAX_MINOR = 1_000_000n;
/** UPI `billingAmount` maximum (SI parameter reference): ₹15,000. */
const MAX_UPI_MANDATE_MINOR = 1_500_000n;
/** Net banking (net-banking authentication) maximum: ₹10,00,000. */
const MAX_MANDATE_MINOR = 100_000_000n;
/** How long a mandate runs. PayU counts iterations from the end date. */
const MANDATE_YEARS = 10;

const IST_OFFSET_MS = 330 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

type MethodType = ProviderCapabilities["methods"][number];
/** Our instrument id prefix per SI rail. */
type Rail = "card" | "upi" | "nb";

export interface PayuConfig {
  merchantKey: string;
  merchantSalt: string;
  /** The account's mode: picks test.payu.in or the live hosts. */
  livemode: boolean;
  /** Test override for the postservice URL. */
  postserviceUrl?: string;
  /** Test clock. */
  now?: () => number;
}

// ── hashing ──────────────────────────────────────────────────────────────────

export const sha512 = (s: string) => createHash("sha512").update(s, "utf8").digest("hex");

/**
 * `_payment` request hash. Measured on test.payu.in with `api_version=7`: the si_details
 * slot is always present, empty for a one-off payment.
 */
export function payuRequestHash(salt: string, f: Record<string, string | undefined>): string {
  return sha512(
    [
      f.key,
      f.txnid,
      f.amount,
      f.productinfo,
      f.firstname,
      f.email,
      f.udf1,
      f.udf2,
      f.udf3,
      f.udf4,
      f.udf5,
      "",
      "",
      "",
      "",
      "",
      f.si_details,
      salt,
    ]
      .map((v) => v ?? "")
      .join("|"),
  );
}

/**
 * Reverse hash on a checkout response or payment webhook. Measured on the surl POST of SI
 * registrations and one-off payments: si_details is NOT part of it. `additionalCharges`,
 * when present, goes first (PayU docs; not measured).
 */
export function payuReverseHash(salt: string, f: Record<string, string | undefined>): string {
  const base = [
    salt,
    f.status,
    "",
    "",
    "",
    "",
    "",
    f.udf5,
    f.udf4,
    f.udf3,
    f.udf2,
    f.udf1,
    f.email,
    f.firstname,
    f.productinfo,
    f.amount,
    f.txnid,
    f.key,
  ].map((v) => v ?? "");
  return sha512((f.additionalCharges ? [f.additionalCharges, ...base] : base).join("|"));
}

/** Postservice command hash: `sha512(key|command|var1|salt)` (measured). */
export const payuCommandHash = (key: string, command: string, var1: string, salt: string) =>
  sha512(`${key}|${command}|${var1}|${salt}`);

/** Card mandate webhook hash (PayU docs; not measured). */
export function payuMandateWebhookHash(salt: string, b: Record<string, unknown>): string {
  const si = (b.si_details ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (v == null ? "" : String(v));
  return sha512(
    [
      b.status,
      b.authPayuId ?? b.authpayuid,
      b.notificationType,
      si.billingAmount ?? b.billingAmount,
      si.paymentStartDate ?? b.paymentStartDate,
      si.paymentEndDate ?? b.paymentEndDate,
      b.message,
      b.eventDate,
      b.key,
      b.udf1,
      b.udf2,
      b.udf3,
      b.udf4,
      b.udf5,
      salt,
    ]
      .map(s)
      .join("|"),
  );
}

/**
 * UPI mandate webhook hash: `sha512(status|action|authpayuid|dateTime|amount|endDate|salt)`
 * (issuer-webhook reference, "Mandate for UPI").
 */
export function payuUpiMandateWebhookHash(salt: string, b: Record<string, unknown>): string {
  const s = (v: unknown) => (v == null ? "" : String(v));
  return sha512(
    [b.status, b.action, b.authpayuid, b.dateTime, b.amount, b.endDate, salt].map(s).join("|"),
  );
}

/** A UPI mandate pause / unpause / revoke post (JSON or form). */
const isUpiMandatePost = (b: Record<string, unknown>) =>
  /^MANDATE_(PAUSE|UNPAUSE|REVOKE)$/.test(String(b.action ?? "")) && b.authpayuid != null;

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a.toLowerCase());
  const y = Buffer.from(b.toLowerCase());
  return x.length === y.length && timingSafeEqual(x, y);
}

// ── ids ──────────────────────────────────────────────────────────────────────

export type PayuTxnKind = "setup" | "payment" | "renewal";
const KIND_PREFIX: Record<PayuTxnKind, string> = {
  setup: "tmsu",
  payment: "tmpy",
  renewal: "tmrc",
};

/** A txnid of one kind: derived from the key, or random without one. ≤ 25, alphanumeric. */
export function payuTxnid(kind: PayuTxnKind, key?: string): string {
  return shortReference(key ?? randomUUID(), {
    maxLength: 25,
    alphanumericOnly: true,
    prefix: KIND_PREFIX[kind],
  });
}

/** The kind of one of our txnids, or null for a txnid we did not mint. */
export function payuTxnKind(txnid: string | undefined | null): PayuTxnKind | null {
  if (!txnid) return null;
  for (const [k, p] of Object.entries(KIND_PREFIX))
    if (txnid.startsWith(p)) return k as PayuTxnKind;
  return null;
}

/** Refund token (`var2`): ≤ 23 chars, unique per refund. */
export const payuRefundToken = (key: string) =>
  shortReference(key, { maxLength: 23, alphanumericOnly: true, prefix: "tmrf" });
const requestId = (key: string, prefix: string) =>
  shortReference(key, { maxLength: 25, alphanumericOnly: true, prefix });

export const payuRefundRef = (txnid: string, token: string) => `${txnid}:${token}`;

/** A listed refund's id: its token, or PayU's request id for a refund with none (`rq…`). */
const listedRefundRef = (txnid: string, x: { token: string; requestId: string }) =>
  payuRefundRef(txnid, x.token || `rq${x.requestId}`);
const isListed = (x: { token: string; requestId: string }, token: string) =>
  x.token === token || (!x.token && token === `rq${x.requestId}`);
export function parsePayuRefundRef(ref: string): { txnid: string; token: string } | null {
  const [txnid, token] = ref.split(":");
  return txnid && token ? { txnid, token } : null;
}

export const payuInstrumentId = (rail: Rail, authpayuid: string) => `${rail}:${authpayuid}`;
export function parsePayuInstrument(id: string): { rail: Rail; authpayuid: string } | null {
  const m = /^(card|upi|nb):(\d+)$/.exec(id.trim());
  return m ? { rail: m[1] as Rail, authpayuid: m[2]! } : null;
}

// ── amounts, time, text ──────────────────────────────────────────────────────

/** Minor units to PayU's decimal string ("100.00"). */
export function toPayuAmount(minor: bigint): string {
  if (minor < 0n) throw new RangeError(`amount out of range: ${minor}`);
  const r = minor % 100n;
  return `${minor / 100n}.${r < 10n ? "0" : ""}${r}`;
}

/** A PayU decimal amount to minor units, or undefined. */
export function fromPayuAmount(v: unknown): bigint | undefined {
  const s = typeof v === "number" ? v.toFixed(2) : typeof v === "string" ? v.trim() : "";
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return undefined;
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? "0").padEnd(2, "0"));
}

/** `YYYY-MM-DD` of an instant, in IST. */
export const istDate = (d: Date) =>
  new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const istStartOfDay = (date: string) => new Date(`${date}T00:00:00+05:30`);

/** PayU times (`addedon`) are IST without an offset. */
export function payuTime(v: unknown): Date | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const d = new Date(`${v.trim().replace(" ", "T")}+05:30`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** NPCI blocks UPI Autopay executions 10:00–13:00 and 17:00–21:30 IST. */
export function nextUpiDebitWindow(t: Date): Date {
  const i = new Date(t.getTime() + IST_OFFSET_MS);
  const m = i.getUTCHours() * 60 + i.getUTCMinutes();
  const day = istStartOfDay(istDate(t)).getTime();
  if (m >= 600 && m < 780) return new Date(day + 780 * 60_000);
  if (m >= 1020 && m < 1290) return new Date(day + 1290 * 60_000);
  return t;
}

/**
 * How long after `executableAfter` a debit may really run: the engine's 10-minute margin
 * plus a clock tick. That whole stretch must miss NPCI's blocked hours.
 */
const UPI_DEBIT_SLACK_MS = 30 * 60_000;

/**
 * The debit date a notice names, and the window the debit may use: from the lead time (or
 * the requested time, if later) to the end of that IST day. UPI moves out of peak hours and
 * keeps at least an hour of its window, else it moves to the next day.
 */
export function payuDebitSchedule(
  now: Date,
  debitAt: Date,
  minLeadHours: number,
  upi: boolean,
): { debitDate: string; executableAfter: Date; expiresAt: Date } {
  const earliest = new Date(now.getTime() + minLeadHours * HOUR_MS);
  let t = debitAt > earliest ? debitAt : earliest;
  for (let i = 0; i < 3; i++) {
    if (upi) {
      t = nextUpiDebitWindow(t);
      const late = new Date(t.getTime() + UPI_DEBIT_SLACK_MS);
      const clear = nextUpiDebitWindow(late);
      if (clear.getTime() !== late.getTime()) t = clear;
    }
    const end = new Date(istStartOfDay(istDate(t)).getTime() + DAY_MS);
    // At least an hour of the debit day stays, so the debit cannot land after the notice ends.
    if (t.getTime() + HOUR_MS <= end.getTime())
      return { debitDate: istDate(t), executableAfter: t, expiresAt: end };
    t = end;
  }
  const end = new Date(istStartOfDay(istDate(t)).getTime() + DAY_MS);
  return { debitDate: istDate(t), executableAfter: t, expiresAt: end };
}

/** PayU allows A–Z a–z 0–9 - _ @ ( ) / space and dot in productinfo, names and phone. */
const clean = (s: string, max: number) =>
  s
    .replace(/[^A-Za-z0-9\-_@()/ .]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

function phoneDigits(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  const d = phone.replace(/[^0-9]/g, "");
  return d.length === 12 && d.startsWith("91") ? d.slice(2) : d || undefined;
}

/**
 * PayU URL-decodes surl/furl/curl once before it POSTs back (measured: `%2F` arrived as
 * `/`, `%26` as `&`). Escaping `%` keeps the return URL's own encoding intact.
 */
export const payuReturnUrl = (url: string) => url.replace(/%/g, "%25");

// ── response shapes ──────────────────────────────────────────────────────────

/** One row of `verify_payment`'s `transaction_details`. */
export interface PayuTxn {
  mihpayid?: string;
  txnid?: string;
  status?: string;
  unmappedstatus?: string;
  amt?: string;
  transaction_amount?: string;
  mode?: string;
  payment_source?: string;
  card_no?: string;
  card_type?: string;
  bankcode?: string;
  error_code?: string;
  error_Message?: string;
  field9?: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  addedon?: string;
}

/**
 * Refund answers PayU documents as accepted and pending, with a request_id: 102 queued, 226
 * "capture is done today", and 112/122/126/127/225/258 (refund API error table).
 */
const PAYU_REFUND_PENDING_CODES = new Set([102, 112, 122, 126, 127, 225, 226, 258]);

/** udf3 on a registration that also collects the first invoice's payment. */
const FIRST_CHARGE_MARK = "tmfirst";

interface CommandAnswer {
  status?: number | string;
  msg?: string;
  message?: string;
  [k: string]: unknown;
}

/**
 * `mode` → what the payer used (`ChargeResult.methodUsed`): our vocabulary where one fits
 * (net banking is `bank_transfer`, as on the other India gateways), else a plain label.
 */
export function payuMethodUsed(mode: string | undefined | null): string | undefined {
  const m = (mode ?? "").trim().toUpperCase();
  if (!m) return undefined;
  if (m === "CC" || m === "DC" || m === "CARD" || m === "CREDITCARD" || m === "DEBITCARD")
    return "card";
  if (m === "UPI") return "upi";
  if (m === "NB" || m === "ENACH" || m === "NACH") return "bank_transfer";
  if (m === "CASH" || m === "WALLET") return "wallet";
  if (m === "EMI") return "emi";
  if (m === "BNPL" || m === "PAYLATER") return "bnpl";
  if (m === "NEFTRTGS" || m === "NEFT" || m === "RTGS") return "neft_rtgs";
  return /^[A-Z_]{1,20}$/.test(m) ? m.toLowerCase() : undefined;
}

/** `mode` → the SI rail of a registration. */
function railOfMode(mode: string | undefined): Rail {
  const m = (mode ?? "").toUpperCase();
  if (m === "UPI") return "upi";
  if (m === "NB" || m === "ENACH" || m === "NACH") return "nb";
  return "card";
}

const METHOD_OF_RAIL: Record<Rail, MethodType> = {
  card: "card",
  upi: "upi",
  nb: "bank_transfer",
};

/** Our method types → PayU `enforce_paymethod` values (measured: upi, creditcard|debitcard). */
const ENFORCE: Readonly<Record<string, string>> = {
  card: "creditcard|debitcard",
  upi: "upi",
  bank_transfer: "netbanking",
};

/** PayU mandate status (card, UPI, net banking) → our mandate vocabulary. */
export function payuMandateStatus(status: string | null | undefined): string | undefined {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "active" || s === "success") return "confirmed";
  if (s === "initiated" || s === "pending") return "initiated";
  // UPI mandate webhooks say `pause` (issuer-webhook reference).
  if (s === "paused" || s === "pause") return "paused";
  if (s === "failed" || s === "failure") return "rejected";
  if (
    s === "cancelled" ||
    s === "canceled" ||
    s === "deleted" ||
    s === "discarded" ||
    s === "expired" ||
    s === "revoked" ||
    s === "revoke" ||
    s.startsWith("cancel")
  )
    return "cancelled";
  return undefined;
}

type Failure = NonNullable<ChargeResult["failure"]>;

function failureFrom(signal: { code?: string | null; message?: string | null }): Failure {
  const n = normalizePayuDecline(signal);
  return {
    code: n.code,
    ...(signal.code ? { providerCode: signal.code } : {}),
    message: n.message ?? signal.message ?? "PayU did not complete the payment.",
    retriable: n.retriable,
    ...(n.ruleId ? { ruleId: n.ruleId } : {}),
    ...(n.retryAfterMs ? { retryAfterMs: n.retryAfterMs } : {}),
  };
}

const txnFailure = (t: PayuTxn) =>
  failureFrom({
    code: t.error_code && t.error_code !== "E000" ? t.error_code : null,
    message: t.error_Message && t.error_Message !== "NO ERROR" ? t.error_Message : t.field9,
  });

type TxnState = "succeeded" | "failed" | "pending" | "not_found";

/** A `verify_payment` row's outcome. Only `success` is success (PayU docs). */
export function payuTxnState(t: PayuTxn | undefined): TxnState {
  const s = (t?.status ?? "").trim().toLowerCase();
  if (!t || s === "not found" || t.mihpayid === "Not Found") return "not_found";
  if (s === "success") return "succeeded";
  if (s === "failure" || s === "failed") return "failed";
  return "pending";
}

const isRegistration = (t: PayuTxn) => (t.payment_source ?? "").toLowerCase() === "sist";

/**
 * Ownership. Every txnid we mint carries a kind prefix, so a txnid without one is provably
 * not ours (a sibling product on the same PayU account). udf1 carries our ref.
 */
function ownershipOf(
  txnid: string | undefined,
  udf1: string | undefined,
): Pick<NormalizedProviderEvent, "ownership" | "ownershipRef"> {
  if (!payuTxnKind(txnid)) return { ownership: "foreign" };
  return udf1 ? { ownership: "ours", ownershipRef: udf1 } : { ownership: "unknown" };
}

function describeTxn(t: PayuTxn): ProviderPaymentMethodRef["display"] {
  const rail = railOfMode(t.mode);
  const last4 = (t.card_no ?? "").replace(/[^0-9]/g, "").slice(-4);
  return {
    type: METHOD_OF_RAIL[rail],
    ...(rail === "card" && t.card_type ? { brand: t.card_type.toLowerCase() } : {}),
    ...(last4.length === 4 ? { last4 } : {}),
  };
}

// ── the adapter ──────────────────────────────────────────────────────────────

export class PayuProvider implements PaymentProvider {
  readonly key = "payu" as const;
  readonly capabilities: ProviderCapabilities = {
    refunds: true,
    partialRefunds: true,
    // Every PayU mandate registers in INR.
    mandateCurrencyAuthoritative: ["card", "upi", "bank_transfer"],
    currencies: ["INR"],
    methods: ["card", "upi", "bank_transfer"],
    intents: true,
    // `setup` = an SI registration; `payment` = a one-off hosted checkout.
    intentPurposes: ["payment", "setup"],
    // The consent transaction may be the first instalment on cards and UPI ("Upfront
    // Payment", customer-experience-and-workflow-recurring-payments).
    setupCollectsFirstCharge: ["card", "upi"],
    // Hosted checkout captures at once; there is no hold to release.
    intentVoid: false,
    intentStatus: true,
    mandates: true,
    // Dispute webhooks are unsigned with nothing to read back: an operator records them.
    disputeFeed: false,
    // surl/furl are form POSTs.
    buyerReturnByPost: true,
    // PayU integration support, 2026-11-02: cards need 24 h ("48 hours … only a general
    // guideline"). UPI: a notice covers the first try and up to three retries; after that a
    // new notice waits 25 h, so UPI always waits 25. UPI debits the notified amount exactly.
    preDebitNotice: {
      methods: ["card", "upi"],
      minLeadHours: 24,
      maxDebitsPerNotice: 1,
      exactAmount: true,
      // "The pre-debit and execution cycle for a mandate must complete in full before a new
      // pre-debit can be initiated" (UPI only); `action: Delete` withdraws a notice.
      oneOpenPerMandate: ["upi"],
      byMethod: { upi: { minLeadHours: 25, maxDebitsPerNotice: 4 } },
    },
    // SI parameter reference: UPI `billingAmount` at most ₹15,000.
    mandateCeilingCapMinor: { upi: MAX_UPI_MANDATE_MINOR },
  };

  private cfg: PayuConfig;

  constructor(cfg: PayuConfig) {
    if (!cfg.merchantKey || !cfg.merchantSalt)
      throw new Error("PayU needs a merchant key and a merchant salt");
    this.cfg = cfg;
  }

  private get checkoutUrl(): string {
    return this.cfg.livemode ? PAYU_LIVE_CHECKOUT : PAYU_TEST_CHECKOUT;
  }

  private get postserviceUrl(): string {
    return (
      this.cfg.postserviceUrl ?? (this.cfg.livemode ? PAYU_LIVE_POSTSERVICE : PAYU_TEST_POSTSERVICE)
    );
  }

  private now(): Date {
    return new Date(this.cfg.now?.() ?? Date.now());
  }

  /** One postservice command. Throws on transport failure; HTTP ≥ 500 → Indeterminate. */
  private async command<T extends CommandAnswer>(
    operation: string,
    command: string,
    var1: string,
    extra: Record<string, string> = {},
  ): Promise<T> {
    const body = new URLSearchParams({
      key: this.cfg.merchantKey,
      command,
      var1,
      ...extra,
      hash: payuCommandHash(this.cfg.merchantKey, command, var1, this.cfg.merchantSalt),
    });
    const res = await providerFetch({
      gatewayKey: this.key,
      operation,
      method: "POST",
      url: this.postserviceUrl,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
    // A throttled, conflicting or failed answer says nothing about what PayU did.
    if (res.status >= 500 || [408, 409, 425, 429].includes(res.status))
      throw new ProviderIndeterminateError(
        `We could not get an answer from PayU for ${command} (HTTP ${res.status}).`,
      );
    try {
      return JSON.parse(res.text) as T;
    } catch {
      throw new Error(`PayU ${command} answered HTTP ${res.status} with a body that is not JSON`);
    }
  }

  /** `verify_payment` for one txnid. `undefined` row = the call itself was refused. */
  async verifyTxn(txnid: string, operation = "verify_payment"): Promise<PayuTxn | undefined> {
    const r = await this.command<CommandAnswer & { transaction_details?: Record<string, PayuTxn> }>(
      operation,
      "verify_payment",
      txnid,
    );
    const row = r.transaction_details?.[txnid];
    if (!row && Number(r.status) !== 1)
      throw new Error(`PayU verify_payment refused: ${r.msg ?? r.message ?? "no answer"}`);
    return row;
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    // No probe endpoint: a txnid that cannot exist. A bad key or salt answers "Invalid Hash."
    const r = await this.command("health_check", "verify_payment", "tmhealthcheck");
    if (r.transaction_details)
      return {
        ok: true,
        detail:
          "Credentials accepted. This check cannot see whether PayU has enabled recurring payments (standing instructions) on your account.",
      };
    return {
      ok: false,
      detail:
        `PayU refused the Merchant Key or the Merchant Salt (${String(r.msg ?? r.message ?? r.status)}). ` +
        "Copy the key and the 32-bit salt again from Developer → API Keys in PayU. Use the test keys for a test business and the live keys for a live business.",
    };
  }

  /** PayU keeps no customer object; payer details go on each transaction. */
  async ensureCustomer(input: EnsureCustomerInput): Promise<ProviderCustomerRef> {
    return { providerKey: this.key, providerCustomerId: input.customerRef };
  }

  // ── hosted checkout ────────────────────────────────────────────────────────

  /** The signed `_payment` form. */
  checkoutForm(opts: {
    txnid: string;
    amountMinor: bigint;
    contact?: ProviderContact;
    description?: string;
    returnUrl: string;
    cancelUrl?: string;
    ownershipRef: string;
    customerId: string;
    si?: { maxAmountMinor: bigint; methodTypes?: string[] };
    udf3?: string;
  }): { action: string; fields: Record<string, string> } {
    const email = opts.contact?.email?.trim();
    const phone = phoneDigits(opts.contact?.phone);
    if (!email || !phone)
      throw new ProviderRefusalError(
        "PayU needs the payer's email address and phone number. Add them to the customer. Then try again.",
      );
    if (email.length > 50)
      throw new ProviderRefusalError(
        "PayU takes email addresses of up to 50 characters. Use a shorter email address for the customer. Then try again.",
      );
    const today = istDate(this.now());
    const fields: Record<string, string> = {
      key: this.cfg.merchantKey,
      txnid: opts.txnid,
      amount: toPayuAmount(opts.amountMinor),
      productinfo:
        clean(opts.description ?? "", 100) || (opts.si ? "Payment authorization" : "Payment"),
      firstname: clean(opts.contact?.name?.split(/\s+/)[0] ?? "", 60) || "Customer",
      email,
      phone,
      surl: payuReturnUrl(opts.returnUrl),
      furl: payuReturnUrl(opts.returnUrl),
      ...(opts.cancelUrl ? { curl: payuReturnUrl(opts.cancelUrl) } : {}),
      api_version: "7",
      // udf1 = our ref, udf2 = the customer. PayU writes udf4 itself on UPI registrations.
      udf1: opts.ownershipRef.slice(0, 255),
      udf2: opts.customerId.slice(0, 255),
      ...(opts.udf3 ? { udf3: opts.udf3 } : {}),
    };
    if (opts.si) {
      const end = `${Number(today.slice(0, 4)) + MANDATE_YEARS}${today.slice(4)}`;
      fields.si = "1";
      fields.si_details = JSON.stringify({
        billingAmount: toPayuAmount(opts.si.maxAmountMinor),
        billingCurrency: "INR",
        billingCycle: "ADHOC",
        billingInterval: 1,
        paymentStartDate: today,
        paymentEndDate: end,
      });
      const enforce = [
        ...new Set((opts.si.methodTypes ?? []).map((m) => ENFORCE[m]).filter(Boolean)),
      ];
      if (opts.si.methodTypes?.length && !enforce.length)
        throw new ProviderRefusalError(
          `PayU cannot register a mandate for ${opts.si.methodTypes.join(", ")}. Select card, UPI or net banking.`,
        );
      if (enforce.length) fields.enforce_paymethod = enforce.join("|");
    }
    fields.hash = payuRequestHash(this.cfg.merchantSalt, fields);
    return { action: this.checkoutUrl, fields };
  }

  private setupForm(
    txnid: string,
    input: {
      contact?: ProviderContact;
      currency?: string;
      maxAmountMinor?: bigint;
      methodTypes?: string[];
      returnUrl: string;
      cancelUrl?: string;
      description?: string;
      ownershipRef?: string;
      customerId: string;
      firstChargeMinor?: bigint;
    },
  ) {
    const currency = (input.currency ?? "INR").toUpperCase();
    if (currency !== "INR")
      throw new ProviderRefusalError(
        `PayU mandates are INR only. We cannot register a mandate in ${currency}. Use a gateway that supports ${currency}.`,
      );
    const types = input.methodTypes?.filter((m) => ENFORCE[m]);
    const upiOnly = types?.length === 1 && types[0] === "upi";
    const nbOnly = types?.length === 1 && types[0] === "bank_transfer";
    const cap = upiOnly ? MAX_UPI_MANDATE_MINOR : MAX_MANDATE_MINOR;
    let ceiling = input.maxAmountMinor ?? DEFAULT_MANDATE_MAX_MINOR;
    if (ceiling > cap) ceiling = cap;
    const first =
      input.firstChargeMinor && input.firstChargeMinor > 0n ? input.firstChargeMinor : null;
    if (upiOnly && first && first > cap)
      throw new ProviderRefusalError(
        `UPI Autopay can take at most ₹${toPayuAmount(cap)} for each payment, and this payment is ₹${toPayuAmount(first)}. Use a card.`,
      );
    // The first charge is itself a debit under the mandate, so the ceiling covers it.
    if (first && ceiling < first) ceiling = first;
    return this.checkoutForm({
      txnid,
      // Registration debits ₹1 on card and UPI (net banking ₹0), or the first invoice.
      amountMinor: first ?? (nbOnly ? 0n : 100n),
      ...(first ? { udf3: FIRST_CHARGE_MARK } : {}),
      ...(input.contact ? { contact: input.contact } : {}),
      ...(input.description ? { description: input.description } : {}),
      returnUrl: input.returnUrl,
      ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
      ownershipRef: input.ownershipRef ?? txnid,
      customerId: input.customerId,
      si: {
        maxAmountMinor: ceiling,
        ...(input.methodTypes ? { methodTypes: input.methodTypes } : {}),
      },
    });
  }

  async initiateVaultSetup(input: InitiateVaultSetupInput): Promise<VaultSetupRef> {
    const txnid = payuTxnid("setup");
    const formPost = this.setupForm(txnid, {
      ...(input.contact ? { contact: input.contact } : {}),
      ...(input.currency ? { currency: input.currency } : {}),
      ...(input.maxAmountMinor != null ? { maxAmountMinor: input.maxAmountMinor } : {}),
      ...(input.methodTypes ? { methodTypes: input.methodTypes } : {}),
      returnUrl: input.returnUrl,
      cancelUrl: input.cancelUrl,
      ...(input.description ? { description: input.description } : {}),
      ...(input.ownershipRef ? { ownershipRef: input.ownershipRef } : {}),
      customerId: input.customer.providerCustomerId,
    });
    return { setupTokenId: txnid, mode: "form_post", formPost };
  }

  async createIntent(input: CreateIntentInput): Promise<IntentRef> {
    if (!input.returnUrl) throw new Error("PayU intents need a returnUrl");
    if (input.purpose === "setup") {
      const txnid = payuTxnid("setup", input.idempotencyKey);
      const formPost = this.setupForm(txnid, {
        ...(input.contact ? { contact: input.contact } : {}),
        currency: input.currency,
        ...(input.maxAmountMinor != null ? { maxAmountMinor: input.maxAmountMinor } : {}),
        ...(input.methodTypes ? { methodTypes: input.methodTypes } : {}),
        returnUrl: input.returnUrl,
        ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
        ...(input.description ? { description: input.description } : {}),
        ownershipRef: input.ownershipRef ?? input.idempotencyKey,
        customerId: input.customer.providerCustomerId,
        ...(input.firstChargeMinor ? { firstChargeMinor: input.firstChargeMinor } : {}),
      });
      return {
        intentId: txnid,
        status: "requires_action",
        authorization: { mode: "form_post", formPost },
      };
    }
    const amount = input.amountMinor ?? 0n;
    if (amount <= 0n) throw new Error("PayU payment intents need a positive amountMinor");
    const currency = input.currency.toUpperCase();
    if (currency !== "INR")
      throw new ProviderRefusalError(
        `PayU takes INR only. We cannot open a payment in ${currency}.`,
      );
    const txnid = payuTxnid("payment", input.idempotencyKey);
    // No `si` and no `enforce_paymethod`: the payer sees every method enabled on the account.
    const formPost = this.checkoutForm({
      txnid,
      amountMinor: amount,
      ...(input.contact ? { contact: input.contact } : {}),
      ...(input.description ? { description: input.description } : {}),
      returnUrl: input.returnUrl,
      ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
      ownershipRef: input.ownershipRef ?? input.idempotencyKey,
      customerId: input.customer.providerCustomerId,
    });
    return {
      intentId: txnid,
      status: "requires_action",
      authorization: { mode: "form_post", formPost },
    };
  }

  /** A registration's instrument, or the reason there is none. */
  private registrationOutcome(
    txnid: string,
    t: PayuTxn | undefined,
  ):
    | { kind: "vaulted"; ref: ProviderPaymentMethodRef }
    | { kind: "failed"; failure: Failure }
    | { kind: "unfinished" } {
    const state = payuTxnState(t);
    if (state === "not_found" || state === "pending") return { kind: "unfinished" };
    if (state === "succeeded" && isRegistration(t!)) {
      const rail = railOfMode(t!.mode);
      const mandate: ProviderMandate = {
        currency: "INR",
        rail: rail === "nb" ? "enach" : rail,
        status: "confirmed",
        reference: t!.mihpayid!,
      };
      // The registration payment is ours to refund ("refunded back by the merchant on
      // calling the Refund API": PayU, cards payment experience).
      const paid = fromPayuAmount(t!.amt ?? t!.transaction_amount);
      return {
        kind: "vaulted",
        ref: {
          providerKey: this.key,
          providerPaymentMethodId: payuInstrumentId(rail, t!.mihpayid!),
          display: describeTxn(t!),
          mandate,
          ...(paid != null && paid > 0n
            ? {
                setupAuthCharge: {
                  providerChargeId: txnid,
                  amountMinor: paid,
                  currency: "INR",
                  ...(t!.udf3 === FIRST_CHARGE_MARK ? { firstCharge: true } : {}),
                },
              }
            : {}),
        },
      };
    }
    // `success` with `payment_source: payu` = money taken, mandate refused (PayU docs).
    return {
      kind: "failed",
      failure: txnFailure(t ?? { txnid }),
    };
  }

  /** Reads the mandate's terms when PayU reports them; never fails the vault over it. */
  private async withMandateTerms(ref: ProviderPaymentMethodRef): Promise<ProviderPaymentMethodRef> {
    try {
      const m = await this.fetchMandate({
        providerCustomerId: "",
        token: ref.providerPaymentMethodId,
      });
      if (m) return { ...ref, mandate: { ...ref.mandate, ...m } };
    } catch {
      // A failed read is not evidence about the mandate.
    }
    return ref;
  }

  /** `token` is the registration txnid. The customer stamped in udf2 is the ownership proof. */
  async vaultPaymentMethod(input: VaultPaymentMethodInput): Promise<ProviderPaymentMethodRef> {
    const t = await this.verifyTxn(input.token, "vault");
    if (payuTxnState(t) === "not_found")
      throw new Error(`PayU transaction ${input.token} does not exist`);
    if ((t!.udf2 ?? "") !== input.customer.providerCustomerId)
      throw new Error(`PayU transaction ${input.token} does not belong to this customer`);
    const out = this.registrationOutcome(input.token, t);
    if (out.kind === "vaulted") return this.withMandateTerms(out.ref);
    // A paid registration without a mandate is refunded through its webhook
    // (`intent.setup_failed` with `setupAuthCharge`).
    throw new Error(
      out.kind === "unfinished"
        ? `PayU registration ${input.token} is not finished. The payer did not complete the mandate.`
        : `PayU did not register a mandate on ${input.token}: ${out.failure.message}`,
    );
  }

  async consumeIntent(input: ConsumeIntentInput): Promise<ConsumeIntentResult> {
    const t = await this.verifyTxn(input.intentId, "consume_intent");
    if (input.purpose === "setup") {
      const out = this.registrationOutcome(input.intentId, t);
      if (out.kind === "vaulted")
        return { purpose: "setup", paymentMethod: await this.withMandateTerms(out.ref) };
      if (out.kind === "unfinished")
        throw new Error(
          `PayU registration ${input.intentId} is not finished. The payer did not complete the mandate.`,
        );
      const paid = unmandatedPayment(input.intentId, t);
      return { purpose: "setup", failure: out.failure, ...(paid ? { setupAuthCharge: paid } : {}) };
    }
    return { purpose: "payment", charge: this.chargeFromTxn(input.intentId, t, true) };
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
    let t: PayuTxn | undefined;
    try {
      t = await this.verifyTxn(id, "fetch_intent");
    } catch {
      // A failed read is not evidence about the money.
      return unknown;
    }
    const state = payuTxnState(t);
    if (state === "not_found") return unknown;
    const own = input.resolveOwnership ? ownershipOf(id, t!.udf1) : {};
    const created = payuTime(t!.addedon);
    const base = {
      intentId: id,
      ...own,
      ...(created && input.resolveOwnership ? { providerObjectCreatedAt: created } : {}),
      raw: t,
    };
    if (state === "pending") return { ...base, status: "requires_action" };
    if (state === "failed") return { ...base, status: "failed" };
    // A registration holds a mandate; anything else was captured on the spot.
    if (payuTxnKind(id) === "setup")
      return { ...base, status: isRegistration(t!) ? "authorized" : "failed" };
    const amountMinor = fromPayuAmount(t!.amt ?? t!.transaction_amount);
    return {
      ...base,
      status: "consumed",
      providerChargeId: id,
      ...(amountMinor != null ? { amountMinor, currency: "INR" } : {}),
    };
  }

  // ── mandates ───────────────────────────────────────────────────────────────

  private instrument(pm: ProviderPaymentMethodRef, mandateReference?: string | null) {
    const parsed = parsePayuInstrument(pm.providerPaymentMethodId);
    if (parsed) return parsed;
    if (mandateReference && /^\d+$/.test(mandateReference)) {
      const rail: Rail =
        pm.display.type === "upi" ? "upi" : pm.display.type === "bank_transfer" ? "nb" : "card";
      return { rail, authpayuid: mandateReference };
    }
    return null;
  }

  async fetchMandate(input: {
    providerCustomerId: string;
    token: string;
  }): Promise<ProviderMandate | null> {
    const p = parsePayuInstrument(input.token);
    if (!p) return null;
    const command =
      p.rail === "upi"
        ? "upi_mandate_status"
        : p.rail === "nb"
          ? "NB_mandate_status"
          : "check_mandate_status";
    const r = await this.command<CommandAnswer & { amount?: string; mandateEndDate?: string }>(
      "fetch_mandate",
      command,
      JSON.stringify({
        authPayuId: p.authpayuid,
        requestId: requestId(`${input.token}:${Date.now()}`, "tmms"),
      }),
    );
    const status = payuMandateStatus(typeof r.status === "string" ? r.status : undefined);
    // `status: 0` = PayU has no mandate under this id ("Mandate entry not found").
    if (!status) return null;
    const max = fromPayuAmount(r.amount);
    const end =
      typeof r.mandateEndDate === "string"
        ? new Date(`${r.mandateEndDate.slice(0, 10)}T23:59:59+05:30`)
        : undefined;
    return {
      status,
      currency: "INR",
      rail: p.rail === "nb" ? "enach" : p.rail,
      reference: p.authpayuid,
      ...(max != null && max > 0n ? { maxAmountMinor: max } : {}),
      ...(end && !Number.isNaN(end.getTime()) ? { expiresAt: end } : {}),
    };
  }

  /** Revokes the mandate. Irreversible at PayU; already gone = done. */
  async deletePaymentMethod(input: {
    customer: ProviderCustomerRef;
    paymentMethod: ProviderPaymentMethodRef;
  }): Promise<void> {
    const p = this.instrument(input.paymentMethod);
    if (!p) return;
    const r = await this.command(
      "delete_payment_method",
      p.rail === "upi" ? "upi_mandate_revoke" : "mandate_revoke",
      JSON.stringify({
        authPayuId: p.authpayuid,
        requestId: requestId(`revoke:${p.authpayuid}:${Date.now()}`, "tmrv"),
      }),
    );
    if (Number(r.status) === 1) return;
    const m = await this.fetchMandate({
      providerCustomerId: input.customer.providerCustomerId,
      token: payuInstrumentId(p.rail, p.authpayuid),
    }).catch(() => undefined);
    if (m === null || m?.status === "cancelled" || m?.status === "rejected") return;
    throw new Error(
      `PayU mandate ${p.authpayuid} could not be revoked: ${r.message ?? r.msg ?? r.status}. ` +
        "Revoke it in the PayU dashboard. Until then, the mandate stays chargeable.",
    );
  }

  // ── pre-debit notice and renewals ──────────────────────────────────────────

  async notifyUpcomingDebit(
    input: Parameters<NonNullable<PaymentProvider["notifyUpcomingDebit"]>>[0],
  ): Promise<Awaited<ReturnType<NonNullable<PaymentProvider["notifyUpcomingDebit"]>>>> {
    const invoiceNo = requestId(input.idempotencyKey, "tmin");
    const failed = (code: string, message: string, retriable = true, final = false) => ({
      status: "failed" as const,
      notificationRef: invoiceNo,
      failure: { code, message, retriable, ...(final ? { final } : {}) },
    });
    if (input.currency.toUpperCase() !== "INR")
      return failed("currency_not_supported", "PayU debits INR only.", false);
    const p = this.instrument(input.paymentMethod, input.mandateReference);
    if (!p)
      return failed("payment_method_not_found", "This instrument is not a PayU mandate.", false);
    const plan = payuDebitSchedule(
      this.now(),
      input.debitAt,
      preDebitRule(this.capabilities.preDebitNotice!, p.rail).minLeadHours,
      p.rail === "upi",
    );
    const var1 = JSON.stringify({
      authpayuid: p.authpayuid,
      requestId: requestId(input.idempotencyKey, "tmpd"),
      debitDate: plan.debitDate,
      amount: toPayuAmount(input.amountMinor),
      invoiceDisplayNumber: invoiceNo,
    });
    const r = await this.command<CommandAnswer & { invoiceStatus?: string }>(
      "pre_debit_notice",
      "pre_debit_SI",
      var1,
    );
    const sent = {
      status: "sent" as const,
      notificationRef: invoiceNo,
      executableAfter: plan.executableAfter,
      expiresAt: plan.expiresAt,
    };
    if (Number(r.status) === 1) return sent;
    // A repeat of our own notice (lost answer): ask PayU whether the invoice exists.
    if (p.rail === "card") {
      const again = await this.command<CommandAnswer & { invoiceStatus?: string }>(
        "pre_debit_notice",
        "pre_debit_SI",
        JSON.stringify({
          authpayuid: p.authpayuid,
          // "requestId is mandatory" on Retrieve too (measured 2026-10-30).
          requestId: requestId(`${input.idempotencyKey}:retrieve`, "tmpr"),
          invoiceDisplayNumber: invoiceNo,
          action: "Retrieve",
        }),
      ).catch(() => null);
      if (
        again &&
        Number(again.status) === 1 &&
        !/deleted/i.test(String(again.invoiceStatus ?? ""))
      )
        return sent;
    }
    const message = String(r.message ?? r.msg ?? "PayU did not accept the pre-debit notice.");
    // `status: "QC"` is the bank or NPCI's code: "Mandate is active in PayU DB and Pre-Debit
    // gets declined from Bank/NPCI". The mandate status read would still say active.
    if (String(r.status).toUpperCase() === "QC")
      return failed("mandate_expired", message, false, true);
    // A refusal a rule names (a revoked or inactive mandate, an open UPI cycle) keeps its class.
    const code = typeof r.status === "string" && /^E\d+$/.test(r.status) ? r.status : null;
    const n = normalizePayuDecline({ code, message });
    return n.ruleId
      ? failed(n.code, message, n.retriable)
      : failed(String(r.status ?? "notice_rejected"), message);
  }

  async withdrawPreDebitNotice(
    input: Parameters<NonNullable<PaymentProvider["withdrawPreDebitNotice"]>>[0],
  ): Promise<"withdrawn" | "not_needed" | "failed"> {
    const p = this.instrument(input.paymentMethod, input.mandateReference);
    if (!p || p.rail !== "upi") return "not_needed";
    const r = await this.command<CommandAnswer>(
      "pre_debit_withdraw",
      "pre_debit_SI",
      // The reference says authpayuid and the invoice number suffice; measured 2026-10-31,
      // PayU answers "amount is mandatory", then "debitDate is mandatory", without them.
      JSON.stringify({
        authpayuid: p.authpayuid,
        requestId: requestId(`${input.notificationRef}:delete`, "tmpw"),
        debitDate: istDate(input.debitAt),
        amount: toPayuAmount(input.amountMinor),
        invoiceDisplayNumber: input.notificationRef,
        action: "Delete",
      }),
    ).catch(() => null);
    return r && Number(r.status) === 1 ? "withdrawn" : "failed";
  }

  private chargeFromTxn(txnid: string, t: PayuTxn | undefined, oneOff = false): ChargeResult {
    const state = payuTxnState(t);
    const methodUsed = oneOff ? payuMethodUsed(t?.mode) : undefined;
    const extra = { ...(methodUsed ? { methodUsed } : {}), raw: t };
    if (state === "succeeded") return { status: "succeeded", providerChargeId: txnid, ...extra };
    if (state === "failed")
      return { status: "failed", providerChargeId: txnid, failure: txnFailure(t!), ...extra };
    return {
      status: "pending",
      providerChargeId: oneOff && state === "not_found" ? "" : txnid,
      ...extra,
    };
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    const currency = input.currency.toUpperCase();
    if (currency !== "INR")
      return {
        status: "failed",
        providerChargeId: "",
        failure: {
          code: "gateway_request_rejected",
          message: `PayU debits INR only. We cannot debit this mandate in ${currency}.`,
          retriable: false,
        },
      };
    const p = this.instrument(input.paymentMethod, input.mandateReference);
    if (!p)
      throw new ProviderRefusalError(
        `PayU instrument ${input.paymentMethod.providerPaymentMethodId} is not a mandate that tmbilling registered.`,
      );
    // "Unless the Pre-Debit notification API is implemented, the Recurring Payment
    // Transaction API will not work": never send a card or UPI debit without one.
    if (p.rail !== "nb" && !input.preDebitNotice)
      return {
        status: "failed",
        providerChargeId: "",
        failure: {
          code: "gateway_request_rejected",
          message:
            "PayU needs a pre-debit notice before each card or UPI debit. We did not send this debit.",
          retriable: true,
        },
      };
    // NPCI blocks UPI Autopay executions 10:00–13:00 and 17:00–21:30 IST (live accounts;
    // test debits stay unconstrained so the suites do not depend on the hour).
    if (p.rail === "upi" && this.cfg.livemode) {
      const now = this.now();
      const open = nextUpiDebitWindow(now);
      if (open.getTime() !== now.getTime())
        return {
          status: "failed",
          providerChargeId: "",
          failure: {
            code: PRE_DEBIT_NOT_DUE_CODE,
            message: "NPCI does not allow UPI Autopay debits at this time of day.",
            retriable: true,
            retryAfterMs: open.getTime() - now.getTime() + 60_000,
          },
        };
    }
    const txnid = payuTxnid("renewal", input.idempotencyKey);
    // Retry of the same attempt: PayU does not document a repeated txnid, so ask first. When
    // PayU cannot be asked, nothing is sent: a blind repeat could debit twice.
    let prior: PayuTxn | undefined;
    try {
      prior = await this.verifyTxn(txnid, "charge_lookup");
    } catch (e) {
      throw new ProviderIndeterminateError(
        `We could not check debit ${txnid} with PayU before sending it, so we did not send it: ${(e as Error).message}`,
      );
    }
    if (payuTxnState(prior) !== "not_found") return this.chargeFromTxn(txnid, prior);

    const var1 = JSON.stringify({
      authpayuid: p.authpayuid,
      amount: toPayuAmount(input.amountMinor),
      txnid,
      ...(input.preDebitNotice
        ? { invoiceDisplayNumber: input.preDebitNotice.notificationRef }
        : {}),
      ...(phoneDigits(input.phone) ? { phone: phoneDigits(input.phone) } : {}),
      // Optional, echoed back; PayU's email field takes 50 characters.
      ...(input.email && input.email.length <= 50 ? { email: input.email } : {}),
      udf1: (input.ownershipRef ?? input.idempotencyKey).slice(0, 255),
    });
    let r: CommandAnswer & { details?: Record<string, { status?: string; field9?: string }> };
    try {
      r = await this.command("charge", "si_transaction", var1);
    } catch (e) {
      // One read settles most lost answers; "not found" this soon proves nothing.
      const t = await this.verifyTxn(txnid, "charge_lookup").catch(() => undefined);
      if (t && payuTxnState(t) !== "not_found") return this.chargeFromTxn(txnid, t);
      if (e instanceof ProviderIndeterminateError) throw markStrandedObject(e, txnid);
      throw markStrandedObject(
        new ProviderIndeterminateError(
          `We could not confirm whether PayU accepted debit ${txnid}: ${(e as Error).message}`,
        ),
        txnid,
      );
    }
    const d = r.details?.[txnid];
    if (!d) {
      // A refusal of the request ("Invalid Hash."): definite only when a rule names it.
      const message = String(r.msg ?? r.message ?? "");
      const failure = failureFrom({ message: message || null });
      if (failure.ruleId) return { status: "failed", providerChargeId: txnid, failure, raw: r };
      throw markStrandedObject(
        new ProviderIndeterminateError(
          `PayU answered debit ${txnid} without its outcome${message ? `: ${message}` : ""}.`,
        ),
        txnid,
      );
    }
    const s = (d.status ?? "").trim().toLowerCase();
    if (s === "captured") return { status: "succeeded", providerChargeId: txnid, raw: r };
    if (s === "pending" || s === "in progress" || s === "in-progress")
      return { status: "pending", providerChargeId: txnid, raw: r };
    // `failed` or blank: failed (PayU docs).
    return {
      status: "failed",
      providerChargeId: txnid,
      failure: failureFrom({ message: d.field9 ?? null }),
      raw: r,
    };
  }

  async fetchChargeStatus(input: { providerChargeId: string }): Promise<ChargeResult> {
    const t = await this.verifyTxn(input.providerChargeId, "charge_status");
    if (payuTxnState(t) === "not_found")
      return { status: "pending", providerChargeId: input.providerChargeId };
    return this.chargeFromTxn(
      input.providerChargeId,
      t,
      payuTxnKind(input.providerChargeId) === "payment",
    );
  }

  /** A charge whose answer was lost: its txnid is made from the key, so one read answers. */
  async locateCharge(input: {
    idempotencyKey: string;
    providerChargeId?: string;
  }): Promise<ChargeResult | null> {
    const txnid =
      input.providerChargeId && payuTxnKind(input.providerChargeId) === "renewal"
        ? input.providerChargeId
        : payuTxnid("renewal", input.idempotencyKey);
    const t = await this.verifyTxn(txnid, "locate_charge");
    if (payuTxnState(t) === "not_found") return null;
    return this.chargeFromTxn(txnid, t);
  }

  // ── refunds ────────────────────────────────────────────────────────────────

  /** Every refund PayU holds for one txnid. */
  async listRefunds(
    txnid: string,
  ): Promise<{ requestId: string; token: string; amountMinor?: bigint; status: string }[] | null> {
    const r = await this.command<CommandAnswer & { "Refund Details"?: Record<string, unknown[]> }>(
      "refund_status",
      "getAllRefundsFromTxnIds",
      txnid,
    );
    const details = r["Refund Details"];
    if (Number(r.status) !== 1) return null;
    // "No Refunds Found" also answers status 1, with no rows.
    if (!details || typeof details !== "object") return [];
    const rows = Object.values(details).flat() as Record<string, unknown>[];
    return rows.map((x) => ({
      requestId: String(x.RequestID ?? ""),
      token: String(x.RefundToken ?? ""),
      ...(fromPayuAmount(x.Amount) != null ? { amountMinor: fromPayuAmount(x.Amount)! } : {}),
      status: String(x.Status ?? ""),
    }));
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const txnid = input.providerChargeId;
    const t = await this.verifyTxn(txnid, "refund");
    if (payuTxnState(t) !== "succeeded" || !t?.mihpayid)
      throw new ProviderRefusalError(`PayU has no successful payment ${txnid} to refund.`);
    // Banks do not take refunds of net banking / eNACH mandate debits (PayU error 232).
    if (payuTxnKind(txnid) === "renewal" && railOfMode(t.mode) === "nb")
      throw new ProviderRefusalError(
        "Banks do not accept refunds of net banking or eNACH mandate debits. Return the money to the customer in a different way.",
      );
    const amount = input.amountMinor ?? fromPayuAmount(t.amt ?? t.transaction_amount);
    if (amount == null) throw new Error(`PayU payment ${txnid} has no amount to refund`);
    const token = payuRefundToken(input.idempotencyKey);
    const providerRefundId = payuRefundRef(txnid, token);
    let r: CommandAnswer & { request_id?: string; error_code?: number };
    try {
      r = await this.command("refund", "cancel_refund_transaction", t.mihpayid, {
        var2: token,
        var3: toPayuAmount(amount),
      });
    } catch {
      // No answer: the refund may exist. Our token is queryable, so the sweep resolves it.
      return { status: "pending", providerRefundId };
    }
    // Status 1 is a request PayU took: 102 queued, and the documented pending codes (226
    // "capture is done today" and the rest) carry a request_id. Any other answer is decided
    // by the refund list: our repeat ("token already used") is listed, a refusal is not.
    const code = r.error_code != null ? Number(r.error_code) : null;
    if (Number(r.status) === 1 && (code === null || PAYU_REFUND_PENDING_CODES.has(code)))
      return { status: "pending", providerRefundId, raw: r };
    const list = await this.listRefunds(txnid).catch(() => null);
    if (!list) return { status: "pending", providerRefundId, raw: r };
    const mine = list.find((x) => x.token === token);
    if (mine) return { status: refundStatus(mine.status), providerRefundId, raw: r };
    // Status 1 with an unknown code: not proof of a refusal.
    if (Number(r.status) === 1) return { status: "pending", providerRefundId, raw: r };
    throw new ProviderRefusalError(
      `PayU refused the refund: ${String(r.msg ?? r.message ?? r.error_code ?? "no reason given")}`,
    );
  }

  async fetchRefundStatus(input: {
    providerRefundId: string;
    requestedAt?: Date;
  }): Promise<RefundResult> {
    const ref = parsePayuRefundRef(input.providerRefundId);
    if (!ref) return { status: "pending", providerRefundId: input.providerRefundId };
    const list = await this.listRefunds(ref.txnid);
    if (!list) return { status: "pending", providerRefundId: input.providerRefundId };
    const mine = list.find((x) => isListed(x, ref.token));
    // Listed the moment it is queued (measured); absent a day later = never created.
    if (!mine) {
      const young =
        input.requestedAt && this.now().getTime() - input.requestedAt.getTime() < DAY_MS;
      return { status: young ? "pending" : "failed", providerRefundId: input.providerRefundId };
    }
    return {
      status: refundStatus(mine.status),
      providerRefundId: input.providerRefundId,
      raw: mine,
    };
  }

  async setupChargeState(
    providerChargeId: string,
  ): Promise<{ capturedMinor: bigint; refunded: boolean } | null> {
    const t = await this.verifyTxn(providerChargeId, "setup_charge_state");
    if (payuTxnState(t) !== "succeeded") return null;
    const captured = fromPayuAmount(t!.amt ?? t!.transaction_amount);
    if (captured == null) return null;
    const list = await this.listRefunds(providerChargeId);
    // Unknown is not "no refund": refuse to book on it.
    if (!list) throw new Error(`We could not read the refunds of ${providerChargeId} from PayU.`);
    return { capturedMinor: captured, refunded: list.length > 0 };
  }

  // ── webhooks ───────────────────────────────────────────────────────────────

  webhookEventId(input: NormalizeWebhookInput): string {
    return webhookEventId([derivedEventId(input.payload)], input.payload);
  }

  /**
   * Payment webhooks are form posts signed with the reverse hash (salt). Refund and
   * net-banking mandate webhooks are unsigned JSON, so their state is read back from PayU
   * and the body is used only to know what to ask. Disputes are unsigned with nothing to
   * read back: kept as `unknown`.
   */
  async normalizeWebhook(input: NormalizeWebhookInput): Promise<NormalizedProviderEvent[]> {
    const raw = input.payload.toString();
    const base = { providerEventId: this.webhookEventId(input) };
    const json = parseJson(raw);
    const upi = json ?? (Object.fromEntries(new URLSearchParams(raw)) as Record<string, unknown>);
    if (isUpiMandatePost(upi)) return [{ ...base, ...this.upiMandateEvent(upi), raw: upi }];
    if (!json) {
      const f = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
      this.verifyPaymentHash(f);
      return [
        {
          ...base,
          occurredAt: payuTime(f.addedon) ?? new Date(),
          raw: redactPaymentWebhook(f),
          ...normalizePayuPayment(f),
        },
      ];
    }
    if (json.notificationType) return [{ ...base, ...(await this.mandateEvent(json)), raw: json }];
    if (json.request_id != null || String(json.action ?? "").toLowerCase() === "refund")
      return [{ ...base, ...(await this.refundEvent(json)), occurredAt: new Date(), raw: json }];
    return [{ ...base, type: "unknown", occurredAt: new Date(), raw: json }];
  }

  verifyPaymentHash(f: Record<string, string>): void {
    if (!f.hash || !f.txnid || f.status == null)
      throw new Error("PayU webhook is missing its hash");
    if (f.key !== this.cfg.merchantKey) throw new Error("PayU webhook names another merchant key");
    if (!sameHex(payuReverseHash(this.cfg.merchantSalt, f), f.hash))
      throw new Error("PayU webhook hash verification failed");
  }

  /** A signed UPI mandate post: the payer paused, resumed or revoked it in their UPI app. */
  private upiMandateEvent(
    b: Record<string, unknown>,
  ): Omit<NormalizedProviderEvent, "providerEventId" | "raw"> {
    const id = String(b.authpayuid ?? "").trim();
    if (!/^\d+$/.test(id)) throw new Error("PayU UPI mandate webhook names no mandate");
    // `key` is not in the field table; the salted hash proves the sender.
    if (b.key != null && String(b.key) !== this.cfg.merchantKey)
      throw new Error("PayU webhook names another merchant key");
    if (!b.hash || !sameHex(payuUpiMandateWebhookHash(this.cfg.merchantSalt, b), String(b.hash)))
      throw new Error("PayU UPI mandate webhook hash verification failed");
    const status = payuMandateStatus(String(b.status ?? ""));
    const max = fromPayuAmount(b.amount);
    return {
      type: "payment_method.mandate_updated",
      providerPaymentMethodId: payuInstrumentId("upi", id),
      mandate: {
        reference: id,
        rail: "upi",
        ...(status ? { status } : {}),
        ...(max != null && max > 0n ? { maxAmountMinor: max, currency: "INR" } : {}),
      },
      // `dateTime` is the mandate's START date (field table), so it cannot order the posts.
      // PayU does not retry them: arrival order is the real order.
      occurredAt: new Date(),
    };
  }

  private async refundEvent(
    b: Record<string, unknown>,
  ): Promise<Omit<NormalizedProviderEvent, "providerEventId" | "raw" | "occurredAt">> {
    const txnid = String(b.merchantTxnId ?? "").trim();
    const token = String(b.token ?? "").trim();
    if (!txnid || (!token && b.request_id == null))
      throw new Error("PayU refund webhook names no transaction");
    if (b.key != null && String(b.key) !== this.cfg.merchantKey)
      throw new Error("PayU webhook names another merchant key");
    const list = await this.listRefunds(txnid).catch(() => null);
    const requestId = String(b.request_id ?? "").trim();
    const providerRefundId = payuRefundRef(txnid, token || `rq${requestId}`);
    // Could not ask: book nothing, and PayU delivers again.
    if (!list)
      return {
        type: "refund.pending",
        providerChargeId: txnid,
        providerRefundId,
        unresolved: `We could not read the refunds of ${txnid} from PayU.`,
      };
    const mine = list.find(
      (x) => (!!token && x.token === token) || (!!requestId && x.requestId === requestId),
    );
    // Unsigned body: a refund PayU does not list is refused.
    if (!mine) throw new Error(`PayU does not confirm refund ${token} on ${txnid}`);
    const status = refundStatus(mine.status);
    return {
      type:
        status === "succeeded"
          ? "charge.refunded"
          : status === "failed"
            ? "refund.failed"
            : "refund.pending",
      providerChargeId: txnid,
      providerRefundId: listedRefundRef(txnid, mine),
      // Each refund PayU lists, at its own amount and state.
      refunds: list
        .filter((x) => (x.token || x.requestId) && x.amountMinor != null)
        .map((x) => ({
          providerRefundId: listedRefundRef(txnid, x),
          amountMinor: x.amountMinor!,
          status: refundStatus(x.status),
        })),
    };
  }

  private async mandateEvent(
    b: Record<string, unknown>,
  ): Promise<Omit<NormalizedProviderEvent, "providerEventId" | "raw">> {
    const id = String(b.authPayuId ?? b.authPayuid ?? b.authpayuid ?? "").trim();
    if (!/^\d+$/.test(id)) throw new Error("PayU mandate webhook names no mandate");
    if (b.hash != null) {
      // Card mandate: signed.
      if (String(b.key ?? "") !== this.cfg.merchantKey)
        throw new Error("PayU webhook names another merchant key");
      if (!sameHex(payuMandateWebhookHash(this.cfg.merchantSalt, b), String(b.hash)))
        throw new Error("PayU mandate webhook hash verification failed");
      const si = (b.si_details ?? {}) as Record<string, unknown>;
      const cancelled = /cancel|deletion/i.test(String(b.notificationType));
      const status = cancelled ? "cancelled" : payuMandateStatus(String(b.status ?? ""));
      const max = fromPayuAmount(si.billingAmount);
      return {
        type: "payment_method.mandate_updated",
        providerPaymentMethodId: payuInstrumentId("card", id),
        mandate: {
          reference: id,
          rail: "card",
          ...(status ? { status } : {}),
          ...(max != null && max > 0n ? { maxAmountMinor: max, currency: "INR" } : {}),
        },
        occurredAt: new Date(),
      };
    }
    // Net banking cancellation: unsigned, so the state comes from PayU.
    const token = payuInstrumentId("nb", id);
    const m = await this.fetchMandate({ providerCustomerId: "", token });
    if (!m) throw new Error(`PayU does not confirm net banking mandate ${id}`);
    return {
      type: "payment_method.mandate_updated",
      providerPaymentMethodId: token,
      mandate: m,
      occurredAt: new Date(),
    };
  }
}

// ── pure helpers ─────────────────────────────────────────────────────────────

function parseJson(raw: string): Record<string, unknown> | null {
  const s = raw.trim();
  if (!s.startsWith("{")) return null;
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Card details and the merchant key stay out of `provider_events`. */
function redactPaymentWebhook(f: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) {
    if (/^(key|hash|card_token|cardToken|cardhash|card_hash)$/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** QUEUED, IN PROGRESS, REQUESTED and od_hit are still moving (PayU refund states). */
function refundStatus(s: string | undefined): RefundResult["status"] {
  const v = (s ?? "").trim().toLowerCase();
  if (v === "success") return "succeeded";
  if (v === "failure" || v === "failed" || v === "rejected") return "failed";
  return "pending";
}

/**
 * A registration PayU paid without a mandate (`payment_source: payu`, E755): nobody's money,
 * so it is reported for the engine's durable refund.
 */
function unmandatedPayment(
  txnid: string,
  t: PayuTxn | undefined,
): ProviderPaymentMethodRef["setupAuthCharge"] | undefined {
  if (payuTxnState(t) !== "succeeded" || !t?.mihpayid || isRegistration(t)) return undefined;
  const paid = fromPayuAmount(t.amt ?? t.transaction_amount);
  return paid != null && paid > 0n
    ? { providerChargeId: txnid, amountMinor: paid, currency: "INR" }
    : undefined;
}

/** No event id at PayU: the object and its state name one event. */
function derivedEventId(raw: string | Buffer): string | undefined {
  const s = raw.toString();
  const j = parseJson(s);
  const str = (v: unknown) => (v == null ? "" : String(v).trim());
  const upi = j ?? (Object.fromEntries(new URLSearchParams(s)) as Record<string, unknown>);
  if (isUpiMandatePost(upi))
    return `payu:upi-mandate:${str(upi.authpayuid)}:${str(upi.action)}:${str(upi.status)}:${str(upi.dateTime)}:${str(upi.pauseStartDate)}:${str(upi.pauseEndDate)}`;
  if (j) {
    if (j.notificationType)
      return `payu:mandate:${str(j.authPayuId ?? j.authPayuid ?? j.authpayuid)}:${str(j.notificationType)}:${str(j.status)}:${str(j.eventDate)}`;
    if (j.request_id != null)
      return `payu:refund:${str(j.request_id)}:${str(j.status)}:${str(j.bank_arn)}`;
    if (j.cb_id != null)
      return `payu:dispute:${str(j.cb_id)}:${str(j.cb_status)}:${str(j.updated_at)}`;
    return undefined;
  }
  const f = new URLSearchParams(s);
  const id = f.get("mihpayid");
  if (!id) return undefined;
  return `payu:payment:${id}:${f.get("status") ?? ""}:${f.get("unmappedstatus") ?? ""}`;
}

type Mapped = Omit<NormalizedProviderEvent, "providerEventId" | "occurredAt" | "raw">;

/** A verified payment webhook → our vocabulary. Exported for the offline suite. */
export function normalizePayuPayment(f: Record<string, string>): Mapped {
  const txnid = f.txnid ?? "";
  const kind = payuTxnKind(txnid);
  const t: PayuTxn = {
    txnid,
    mihpayid: f.mihpayid,
    status: f.status,
    mode: f.mode,
    payment_source: f.payment_source,
    error_code: f.error,
    error_Message: f.error_Message,
    field9: f.field9,
  };
  const state = payuTxnState(t);
  const own = ownershipOf(txnid, f.udf1);
  const created = payuTime(f.addedon);
  const at = created ? { providerObjectCreatedAt: created } : {};
  if (kind === "setup") {
    if (state === "pending") return { type: "unknown", providerIntentId: txnid, ...own };
    const ok = state === "succeeded" && isRegistration(t);
    const paid = ok ? undefined : unmandatedPayment(txnid, { ...t, amt: f.amount });
    return {
      type: ok ? "intent.setup_succeeded" : "intent.setup_failed",
      providerIntentId: txnid,
      ...(paid ? { setupAuthCharge: paid } : {}),
      ...own,
      ...at,
    };
  }
  const f9 = state === "failed" ? txnFailure(t) : undefined;
  // "autoRefund": PayU refunds a payment it had reported success.
  const reversed = state === "failed" && /^autorefund$/i.test(f.unmappedstatus ?? "");
  // `amount` is the amount the request asked for (PayU webhook reference).
  const amountMinor = fromPayuAmount(f.amount);
  return {
    type:
      state === "succeeded"
        ? "charge.succeeded"
        : state === "failed"
          ? "charge.failed"
          : "charge.pending",
    providerChargeId: txnid,
    ...(kind === "payment" ? { providerIntentId: txnid } : {}),
    ...(amountMinor != null ? { amountMinor } : {}),
    ...(reversed ? { lateReversal: true } : {}),
    ...(f9
      ? {
          failureCode: f9.code,
          failureRetriable: f9.retriable,
          failureMessage: f9.message,
          ...(f9.providerCode ? { providerFailureCode: f9.providerCode } : {}),
        }
      : {}),
    ...own,
    ...at,
  };
}
