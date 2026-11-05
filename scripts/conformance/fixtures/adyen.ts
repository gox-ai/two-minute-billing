/**
 * Adyen conformance fixtures. Payment, modification and notification shapes follow the offline
 * suite (`verify:adyen`) and Adyen's documented examples; every id is a same-shape fake. The
 * adapter takes no API base, so the fake owns Adyen's test host, which is never reached.
 *
 * The world bills in EUR so a SEPA Direct Debit mandate (`bank_debit`) can be charged too.
 * The route answers Adyen before it processes (`processAfterAnswer`); the harness drains the
 * queued job after each delivery.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { sweepStalePendingCharges } from "@/modules/payments/stale-pending";
import { resolveAdapter } from "@/providers/registry";
import { decodeStoredMethod, signAdyenItem, type AdyenNotificationItem } from "@/providers/adyen";
import { gatewayAccounts, invoices, paymentMethods, payments, providerEvents } from "@db/schema";
import { refundPayment } from "@/modules/refunds/service";
import { FakeGateway, json, type FakeRequest } from "../fake-http";
import { AMOUNT, drainStoredWebhooks, outcomeOf, type World } from "../harness";
import { hostedApplePayRows } from "../hosted-wallet";
import type {
  Billed,
  Body,
  DisputeStep,
  DocumentedStatus,
  ExtraRow,
  GatewayDriver,
  GatewayFixture,
  RefundState,
  TokenKind,
} from "../types";

const HOST = "https://checkout-test.adyen.com";
const VERSION = "/v71";
const READ = "2026-10-27";
const SPEC =
  "https://raw.githubusercontent.com/Adyen/adyen-openapi/main/json/CheckoutService-v71.json";
const DOC = {
  events: "https://docs.adyen.com/development-resources/webhooks/webhook-types",
  // Type `googlepay`; refunds, partial refunds and separate captures supported (read 2026-10-28).
  googlePay: "https://docs.adyen.com/payment-methods/google-pay",
  disputes: "https://docs.adyen.com/risk-management/disputes-api/dispute-notifications",
  currencies: "https://docs.adyen.com/development-resources/currency-codes",
  idempotency: "https://docs.adyen.com/development-resources/api-idempotency",
  errors: "https://docs.adyen.com/development-resources/error-codes",
  // EUR only, 500 EUR default limit, merchant pre-notification, undefendable chargebacks.
  sepa: "https://docs.adyen.com/payment-methods/sepa-direct-debit",
  // "eventCode: CHARGEBACK, paymentMethod: sepadirectdebit"; example reason "AC01:IncorrectAccountNumber".
  sepaChargebacks: "https://docs.adyen.com/risk-management/chargeback-guidelines/sepa-chargebacks",
  // The SEPA table: every reason code, none defendable.
  reasonCodes: "https://docs.adyen.com/risk-management/understanding-disputes/dispute-reason-codes",
  // Webhooks: store, answer 2xx within 10 s, then process.
  handleWebhooks: "https://docs.adyen.com/development-resources/webhooks/handle-webhook-events",
};
/** A test IBAN from Adyen's SEPA API-only page. */
const TEST_IBAN = "NL98ABNA0410108103";
const MERCHANT = "ConformanceMerchantECOM";

/** The harness's secret is not hex; Adyen's HMAC key is. Both sides derive the same key. */
const hmacKey = (secret: string) => createHash("sha256").update(secret).digest("hex");

type Amount = { value: number; currency: string };
interface Payment {
  psp: string;
  reference: string;
  amount: Amount;
  token: string;
  shopper: string;
  metadata: Record<string, string>;
  resultCode: string;
  /** `paymentMethod.type` as sent: `scheme` or `sepadirectdebit`. */
  type: string;
}
interface Modification {
  psp: string;
  payment: string;
  kind: "refund" | "reversal" | "capture" | "cancel";
  amount: Amount;
  reference: string;
}

class FakeAdyen extends FakeGateway {
  readonly host = HOST;
  /** storedPaymentMethodId → its shopperReference (empty until a shopper first reads it). */
  readonly stored = new Map<string, string>();
  /** Stored ids that are SEPA mandates, not cards. */
  readonly sepa = new Set<string>();
  /** What a SEPA debit answers at submission (`Authorised` unless a row sets `Received`). */
  sepaResult = "Authorised";
  readonly payments = new Map<string, Payment>();
  readonly mods = new Map<string, Modification>();
  /** Payment links by id: the create request plus `status`. */
  readonly links = new Map<string, Record<string, unknown>>();
  /**
   * Idempotency-Key → the first answer, replayed "without duplication" whatever the replay's
   * body (the docs do not say). A key the fake never answered is processed as new. 704 while
   * the first is in flight is injected as a fault.
   */
  private readonly keys = new Map<string, [number, unknown]>();

  psp() {
    return this.id("P", 9);
  }
  newPayment(over: Omit<Payment, "psp">): Payment {
    const p = { psp: this.psp(), ...over };
    this.payments.set(p.psp, p);
    return p;
  }
  newMod(
    payment: Payment,
    kind: Modification["kind"],
    value: number,
    reference = "",
  ): Modification {
    const m = {
      psp: this.psp(),
      payment: payment.psp,
      kind,
      amount: { value, currency: payment.amount.currency },
      reference,
    };
    this.mods.set(m.psp, m);
    return m;
  }

  private once(req: FakeRequest, make: () => [number, unknown]): Response {
    const key = req.headers["idempotency-key"];
    const seen = key ? this.keys.get(key) : undefined;
    if (seen) return json(seen[0], seen[1], { "idempotency-key": key! });
    const [status, body] = make();
    if (key) this.keys.set(key, [status, body]);
    return json(status, body);
  }

  async route(req: FakeRequest): Promise<Response | null> {
    if (!req.path.startsWith(VERSION)) return null;
    const path = req.path.slice(VERSION.length);
    const { method, body } = req;
    if (method === "GET" && path === "/storedPaymentMethods") {
      const shopper = req.url.searchParams.get("shopperReference") ?? "";
      const mine = [...this.stored].filter(([, s]) => s === shopper || s === "");
      for (const [t] of mine) this.stored.set(t, shopper);
      return json(200, {
        merchantAccount: MERCHANT,
        shopperReference: shopper,
        storedPaymentMethods: mine.map(([id]) =>
          this.sepa.has(id)
            ? {
                id,
                type: "sepadirectdebit",
                iban: TEST_IBAN,
                ownerName: "Conformance Payer",
                supportedRecurringProcessingModels: ["Subscription", "UnscheduledCardOnFile"],
              }
            : {
                id,
                type: "scheme",
                brand: "visa",
                lastFour: "1111",
                expiryMonth: "03",
                expiryYear: "30",
                holderName: "Conformance Payer",
                supportedRecurringProcessingModels: ["Subscription", "UnscheduledCardOnFile"],
              },
        ),
      });
    }
    if (method === "POST" && path === "/payments") {
      const ref = String(body.reference ?? "");
      const op = ref.startsWith("tmp:") ? "authorize" : "charge";
      return this.guarded(op, req, () =>
        this.once(req, () => {
          const pmt = body.paymentMethod as { storedPaymentMethodId?: string; type?: string };
          const token = String(pmt.storedPaymentMethodId);
          const type = String(pmt.type);
          // A SEPA token charged as a card (or the reverse) is refused, as Adyen would.
          if ((type === "sepadirectdebit") !== this.sepa.has(token))
            return [
              422,
              {
                status: 422,
                errorCode: "14_0",
                message: "Invalid payment method",
                errorType: "validation",
              },
            ];
          const sepa = type === "sepadirectdebit";
          const p = this.newPayment({
            reference: ref,
            amount: body.amount as Amount,
            token,
            shopper: String(body.shopperReference),
            metadata: (body.metadata as Record<string, string>) ?? {},
            resultCode: sepa ? this.sepaResult : "Authorised",
            type,
          });
          return [
            200,
            {
              additionalData: { paymentMethod: sepa ? "sepadirectdebit" : "visa" },
              pspReference: p.psp,
              resultCode: p.resultCode,
              amount: p.amount,
              merchantReference: ref,
              // On an Authorised result only (PaymentResponse.paymentMethod).
              ...(p.resultCode === "Authorised"
                ? {
                    paymentMethod: sepa
                      ? { type: "sepadirectdebit" }
                      : { brand: "visa", type: "scheme" },
                  }
                : {}),
            },
          ];
        }),
      );
    }
    // Pay by Link: `id`, `url`, `status` (PaymentLinkResponse); PATCH only expires.
    if (method === "POST" && path === "/paymentLinks")
      return this.guarded("payment_link", req, () =>
        this.once(req, () => {
          const id = this.id("PL", 14);
          const link = { ...body, id, status: "active", url: `https://test.adyen.link/${id}` };
          this.links.set(id, link);
          return [201, link];
        }),
      );
    const pl = path.match(/^\/paymentLinks\/([^/]+)$/);
    if (pl) {
      const link = this.links.get(decodeURIComponent(pl[1]!));
      if (!link) return json(404, { status: 404, errorCode: "000", message: "Not found" });
      if (method === "PATCH" && body.status === "expired") link.status = "expired";
      return json(200, link);
    }
    const mod = path.match(/^\/payments\/([^/]+)\/(refunds|reversals|captures|cancels)$/);
    if (mod && method === "POST") {
      const p = this.payments.get(decodeURIComponent(mod[1]!));
      const kind = {
        refunds: "refund",
        reversals: "reversal",
        captures: "capture",
        cancels: "cancel",
      }[mod[2]!] as Modification["kind"];
      const op = kind === "refund" || kind === "reversal" ? "refund" : kind;
      return this.guarded(op, req, () =>
        this.once(req, () => {
          if (!p)
            return [
              422,
              {
                status: 422,
                errorCode: "167",
                message: "Original pspReference required for this operation",
                errorType: "validation",
              },
            ];
          const value = (body.amount as Amount | undefined)?.value ?? p.amount.value;
          const m = this.newMod(p, kind, value, String(body.reference ?? ""));
          return [
            201,
            {
              merchantAccount: MERCHANT,
              paymentPspReference: p.psp,
              pspReference: m.psp,
              reference: m.reference,
              status: "received",
              ...(body.amount ? { amount: m.amount } : {}),
            },
          ];
        }),
      );
    }
    return null;
  }
}

class AdyenDriver implements GatewayDriver {
  readonly fake = new FakeAdyen();
  readonly forgedStatus = 400;
  readonly chargeOp = "charge";
  readonly refundOp = "refund";
  readonly errors = {
    // "the API returns an HTTP 422 … or HTTP 409 … with the error code 704".
    conflict: {
      status: 409,
      body: {
        status: 409,
        errorCode: "704",
        message: "Request already processed or in progress",
        errorType: "validation",
      },
    },
    rateLimited: {
      status: 429,
      body: { status: 429, errorCode: "705", message: "Rate limited", errorType: "validation" },
    },
    server: {
      status: 500,
      body: { status: 500, errorCode: "000", message: "Internal error", errorType: "internal" },
    },
    refundRefused: {
      status: 422,
      body: {
        status: 422,
        errorCode: "137",
        message: "Field 'amount' is not valid",
        errorType: "validation",
      },
    },
  };

  credentials(webhookSecret: string) {
    return {
      api_key: "AQEconformance0000000000000000000000000001",
      client_key: "test_CONFORMANCE00000000000000000000001",
      merchant_account: MERCHANT,
      webhook_secret: hmacKey(webhookSecret),
    };
  }
  token(kind: TokenKind) {
    if (kind === "declines") return null;
    const t = this.fake.id("CONF", 12);
    this.fake.stored.set(t, "");
    if (kind === "bank_debit") this.fake.sepa.add(t);
    return t;
  }
  sign() {
    return {};
  }
  signBody(_w: World, body: string, secret: string) {
    const doc = JSON.parse(body) as {
      notificationItems: Array<{ NotificationRequestItem: AdyenNotificationItem }>;
    };
    for (const { NotificationRequestItem: i } of doc.notificationItems)
      i.additionalData = { ...i.additionalData, hmacSignature: signAdyenItem(hmacKey(secret), i) };
    return JSON.stringify(doc);
  }

  payment(psp: string) {
    const p = this.fake.payments.get(psp);
    if (!p) throw new Error(`fake Adyen has no payment ${psp}`);
    return p;
  }
  item(
    i: Partial<AdyenNotificationItem> & { eventCode: string; pspReference: string },
  ): AdyenNotificationItem {
    return {
      merchantAccountCode: MERCHANT,
      eventDate: new Date().toISOString(),
      paymentMethod: "visa",
      success: "true",
      reason: "",
      ...i,
      additionalData: { ...i.additionalData },
    };
  }
  notify(...items: AdyenNotificationItem[]): Body {
    return {
      body: JSON.stringify({
        live: "false",
        notificationItems: items.map((NotificationRequestItem) => ({ NotificationRequestItem })),
      }),
      eventIds: items.map((i) => `${i.pspReference}:${i.eventCode}:${i.success}`),
    };
  }
  /** An item about payment `p` (AUTHORISATION carries its own psp; modifications name it). */
  payItem(
    p: Payment,
    eventCode: string,
    over: Partial<AdyenNotificationItem> = {},
  ): AdyenNotificationItem {
    const own = eventCode === "AUTHORISATION";
    return this.item({
      eventCode,
      pspReference: own ? p.psp : this.fake.psp(),
      ...(own ? {} : { originalReference: p.psp }),
      merchantReference: p.reference,
      amount: { ...p.amount },
      additionalData: Object.fromEntries(
        Object.entries(p.metadata).map(([k, v]) => [`metadata.${k}`, v]),
      ),
      ...over,
    });
  }
  modItem(
    m: Modification,
    eventCode: string,
    success = true,
    extra: Record<string, string> = {},
  ): AdyenNotificationItem {
    const p = this.payment(m.payment);
    return this.item({
      eventCode,
      pspReference: m.psp,
      originalReference: p.psp,
      merchantReference: m.reference || p.reference,
      amount: { ...m.amount },
      success: String(success),
      additionalData: extra,
    });
  }

  collect() {
    return [];
  }
  paymentSucceeded(_w: World, psp: string) {
    return [this.notify(this.payItem(this.payment(psp), "AUTHORISATION"))];
  }
  paymentFailed(_w: World, psp: string, late: boolean) {
    const p = this.payment(psp);
    if (!late)
      return [
        this.notify(this.payItem(p, "AUTHORISATION", { success: "false", reason: "Refused" })),
      ];
    // Auto-capture rejected by the scheme after the authorisation was booked.
    const m = this.fake.newMod(p, "capture", p.amount.value);
    return [this.notify(this.modItem(m, "CAPTURE_FAILED", true))];
  }
  refundEvent(_w: World, _psp: string, refundId: string, state: RefundState) {
    const m = this.fake.mods.get(refundId);
    if (!m) throw new Error(`fake Adyen has no modification ${refundId}`);
    // Adyen has no "refund pending" notification: the request answers `received`.
    if (state === "pending") return [];
    const code = m.kind === "reversal" ? "CANCEL_OR_REFUND" : "REFUND";
    const extra: Record<string, string> =
      m.kind === "reversal" ? { "modification.action": "refund" } : {};
    return [this.notify(this.modItem(m, code, state === "succeeded", extra))];
  }
  dashboardRefund(_w: World, psp: string, amountMinor: bigint) {
    const p = this.payment(psp);
    const m = this.fake.newMod(p, "refund", Number(amountMinor));
    return { refundId: m.psp, events: [this.notify(this.modItem(m, "REFUND"))] };
  }
  disputeItem(
    p: Payment,
    dispute: string,
    eventCode: string,
    disputeStatus?: string,
  ): AdyenNotificationItem {
    return this.item({
      eventCode,
      pspReference: dispute,
      originalReference: p.psp,
      merchantReference: p.reference,
      amount: { ...p.amount },
      reason: "Other Fraud-Card Absent Environment",
      additionalData: {
        chargebackReasonCode: "10.4",
        chargebackSchemeCode: "visa",
        modificationMerchantReferences: "",
        defensePeriodEndsAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
        ...(disputeStatus ? { disputeStatus } : {}),
      },
    });
  }
  disputeSteps(_w: World, psp: string, flow: "won" | "lost" | "win_after_loss"): DisputeStep[] {
    const p = this.payment(psp);
    const d = this.fake.psp();
    const ev = (code: string, status?: string) => this.notify(this.disputeItem(p, d, code, status));
    const withdrawn: DisputeStep = {
      after: "withdrawn",
      bodies: [ev("NOTIFICATION_OF_CHARGEBACK", "Undefended"), ev("CHARGEBACK", "Undefended")],
    };
    // Defended: the money comes back while the issuer reviews (the money state of a win).
    const reversed: DisputeStep = {
      after: "won",
      bodies: [ev("INFORMATION_SUPPLIED", "Responded"), ev("CHARGEBACK_REVERSED", "Pending")],
    };
    if (flow === "won")
      return [
        withdrawn,
        reversed,
        { after: "won", bodies: [ev("ISSUER_RESPONSE_TIMEFRAME_EXPIRED", "Won")] },
      ];
    const second: DisputeStep = { after: "lost", bodies: [ev("SECOND_CHARGEBACK", "Lost")] };
    if (flow === "lost") return [withdrawn, reversed, second];
    return [
      withdrawn,
      reversed,
      second,
      { after: "won", bodies: [ev("PREARBITRATION_WON", "Won")] },
    ];
  }
  /** A SEPA chargeback on `p`, in the shape of Adyen's documented example. */
  sepaChargeback(p: Payment, code: string): AdyenNotificationItem {
    return this.item({
      eventCode: "CHARGEBACK",
      pspReference: this.fake.psp(),
      originalReference: p.psp,
      merchantReference: p.reference,
      amount: { ...p.amount },
      paymentMethod: "sepadirectdebit",
      reason: `${code}:${SEPA_REASON[code] ?? "Reason"}`,
      additionalData: {
        chargebackReasonCode: code,
        chargebackSchemeCode: "sepadirectdebit",
        modificationMerchantReferences: "",
        defensePeriodEndsAt: new Date().toISOString(),
        defendable: "false",
        disputeStatus: "Lost",
      },
    });
  }
  chargesOn(token: string) {
    return [...this.fake.payments.values()]
      .filter((p) => p.token === token && p.reference.startsWith("tmc:"))
      .map((p) => p.psp);
  }

  statusEvent(_w: World, st: DocumentedStatus, psp: string): Body[] {
    const p = this.payment(psp);
    if (st.object === "event:sepa-chargeback")
      return [this.notify(this.sepaChargeback(p, st.status))];
    if (st.object === "event:dispute")
      return [
        this.notify(this.disputeItem(p, this.fake.psp(), st.status, DISPUTE_STATUS[st.status])),
      ];
    const success = st.object === "event:payment:false" ? "false" : "true";
    const kind = /REFUND/.test(st.status)
      ? "refund"
      : /CANCEL/.test(st.status)
        ? "cancel"
        : "capture";
    const m = this.fake.newMod(p, kind, st.status === "AUTHORISATION" ? p.amount.value : 500);
    const extra: Record<string, string> =
      st.status === "CANCEL_OR_REFUND" ? { "modification.action": "refund" } : {};
    if (st.status === "AUTHORISATION")
      return [
        this.notify(
          this.payItem(p, "AUTHORISATION", {
            success,
            ...(success === "false" ? { reason: "Refused" } : {}),
          }),
        ),
      ];
    return [
      this.notify({
        ...this.modItem(m, st.status, success === "true", extra),
        ...(success === "false" ? { reason: "Refused" } : {}),
      }),
    ];
  }
}

/** SEPA reason codes → their name in Adyen's table (the `reason` suffix). */
const SEPA_REASON: Record<string, string> = {
  AC01: "IncorrectAccountNumber",
  AC04: "ClosedAccountNumber",
  AC06: "BlockedAccount",
  AC13: "InvalidDebtorAccountType",
  AG01: "TransactionForbidden",
  AG02: "InvalidBankOperationCode",
  AM04: "InsufficientFunds",
  AM05: "Duplication",
  BE05: "UnrecognisedInitiatingParty",
  CNOR: "CreditorBankIsNotRegistered",
  DNOR: "DebtorBankIsNotRegistered",
  ED05: "SettlementFailed",
  FF01: "InvalidFileFormat",
  MD01: "NoMandate",
  MD02: "MissingMandatoryInformationInMandate",
  MD06: "RefundRequestByEndCustomer",
  MD07: "EndCustomerDeceased",
  MS02: "NotSpecifiedReasonCustomerGenerated",
  MS03: "NotSpecifiedReasonAgentGenerated",
  RC01: "BankIdentifierIncorrect",
  RR01: "MissingDebtorAccountOrIdentification",
  RR02: "MissingDebtorNameOrAddress",
  RR03: "MissingCreditorNameOrAddress",
  RR04: "RegulatoryReason",
  SL01: "SpecificServiceOfferedByDebtorAgent",
};

/** The disputeStatus each event carries, from the "Possible disputeStatus values" column. */
const DISPUTE_STATUS: Record<string, string | undefined> = {
  REQUEST_FOR_INFORMATION: "Unresponded",
  NOTIFICATION_OF_CHARGEBACK: "Undefended",
  INFORMATION_SUPPLIED: "Responded",
  CHARGEBACK: "Undefended",
  SECOND_CHARGEBACK: "Lost",
  CHARGEBACK_REVERSED: "Pending",
  PREARBITRATION_WON: "Won",
  PREARBITRATION_LOST: "Lost",
  PREARBITRATION_OPEN: "Undefended",
  PREARBITRATION_ACCEPTED: "Pending",
  PREARBITRATION_DECLINED: "Pending",
  PREARBITRATION_ISSUER_WITHDRAWN: "Won",
  SCHEME_ARBITRATION: "Pending",
  SCHEME_ARBITRATION_WON: "Won",
  SCHEME_ARBITRATION_LOST: "Lost",
  DISPUTE_DEFENSE_PERIOD_ENDED: "Accepted",
  ISSUER_RESPONSE_TIMEFRAME_EXPIRED: "Won",
};

const ev = (
  status: string,
  expect: DocumentedStatus["expect"],
  success = true,
): DocumentedStatus => ({
  object: success ? "event:payment" : "event:payment:false",
  status,
  doc: "webhook-types",
  expect,
});
const dsp = (status: string, expect: DocumentedStatus["expect"]): DocumentedStatus => ({
  object: "event:dispute",
  status,
  doc: "dispute-events",
  expect,
});
const NOT_USED = (what: string) => ({ none: `${what}; this account uses none of it.` });
/** A SEPA chargeback reason code: a bank return reopens the invoice, a payer claim is a lost dispute. */
const sepa = (code: string): DocumentedStatus => ({
  object: "event:sepa-chargeback",
  status: code,
  doc: "sepa-reason-codes",
  expect:
    code === "MD01" || code === "MD06"
      ? ["dispute.created", "dispute.funds_withdrawn", "dispute.lost"]
      : ["charge.failed"],
});

const later = (ms: number) => new Date(Date.now() + ms);
const sweepAt = (w: World, at: Date) =>
  runWithClockScope({ onlyBusinessId: w.biz.id }, () => sweepStalePendingCharges(at));
/** A charge whose answer is lost; `made` = Adyen processed it first. */
const lostCharge = async (w: World, made: boolean) => {
  const d = w.driver as AdyenDriver;
  d.fake.inject("charge", { kind: "network", afterCreate: made }, 6);
  const b = await w.bill().finally(() => d.fake.clearFaults());
  const [pm] = await withTenant(w.org.id, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.id, b.paymentMethodId)),
  );
  const id = pm!.providerPaymentMethodId;
  const token = decodeStoredMethod(id)?.token ?? id;
  return { b, d, made: () => d.chargesOn(token), calls: () => d.fake.callsOf("charge").length };
};

/** Sweeps at 15 min and 25 h: nothing is sent, nothing is made, the row stays `timeout`. */
const noReplay = async (
  w: World,
  b: Billed,
  made: () => string[],
  calls: () => number,
): Promise<{ pass: boolean; detail: string }> => {
  const n = calls();
  await sweepAt(w, later(15 * 60_000));
  await sweepAt(w, later(25 * 3_600_000));
  const after = await w.reload(b);
  return {
    pass: calls() === n && made().length === 0 && after.txnStatus === "timeout",
    detail: `replays ${calls() - n}; charges ${made().length}; attempt ${outcomeOf(after)}`,
  };
};

const adapterOf = async (w: World) => {
  const [acc] = await systemDb
    .select()
    .from(gatewayAccounts)
    .where(eq(gatewayAccounts.id, w.account.id));
  return resolveAdapter(acc!);
};

/** S14 for a currency whose Adyen unit differs from ISO (`amount` is `{ value, currency }`). */
const currencyRow = (currency: string, minor: bigint, sent: number): ExtraRow => ({
  scenario: "S14",
  id: `S14.amount.${currency}`,
  title: `${minor} ${currency} in our minor units is sent to Adyen as ${sent}`,
  async run({ world }) {
    const w = await world(`s14${currency.toLowerCase()}`);
    const d = w.driver as AdyenDriver;
    const b = await w.bill();
    const [pm] = await withTenant(w.org.id, (tx) =>
      tx.select().from(paymentMethods).where(eq(paymentMethods.id, b.paymentMethodId)),
    );
    await (
      await adapterOf(w)
    )
      .charge({
        amountMinor: minor,
        currency,
        customer: { providerKey: "adyen", providerCustomerId: pm!.providerCustomerId },
        paymentMethod: {
          providerKey: "adyen",
          providerPaymentMethodId: pm!.providerPaymentMethodId,
          providerCustomerId: pm!.providerCustomerId,
          display: {} as never,
        },
        idempotencyKey: `cur_${currency}_${randomUUID()}`,
        ownershipRef: `inv_cur_${currency}`,
      })
      .catch((e: Error) => e);
    const value = (d.fake.callsOf("charge").at(-1)?.body.amount as Amount | undefined)?.value;
    return { pass: value === sent, detail: `${minor} ${currency} sent as ${value} (want ${sent})` };
  },
});

/** The buyer pays the link with Apple Pay; AUTHORISATION names the link (`paymentLinkId`). */
function payLink(w: World, intentAtGateway: string) {
  const d = w.driver as AdyenDriver;
  const id = intentAtGateway.slice("adypl_".length);
  const link = d.fake.links.get(id);
  if (!link) throw new Error(`fake Adyen has no payment link ${id}`);
  link.status = "completed";
  const metadata = (link.metadata as Record<string, string>) ?? {};
  const p = d.fake.newPayment({
    reference: String(link.reference),
    amount: link.amount as Amount,
    token: "",
    shopper: String(link.shopperReference ?? ""),
    metadata,
    resultCode: "Authorised",
    type: "applepay",
  });
  const item = d.payItem(p, "AUTHORISATION", {
    paymentMethod: "visa_applepay",
    additionalData: {
      ...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [`metadata.${k}`, v])),
      paymentLinkId: id,
    },
  });
  return { chargeId: p.psp, bodies: [d.notify(item)] };
}

export const adyenFixture: GatewayFixture = {
  key: "adyen",
  currency: "EUR",
  docs: [
    { id: "webhook-types", url: DOC.events, read: READ, check: { kind: "page" } },
    { id: "dispute-events", url: DOC.disputes, read: READ, check: { kind: "page" } },
    { id: "sepa-reason-codes", url: DOC.reasonCodes, read: "2026-10-28", check: { kind: "page" } },
  ],
  // Adyen reports state as standard-webhook event codes plus `success`; every payment,
  // modification, refund and dispute code on the two pages.
  statuses: [
    ev("AUTHORISATION", ["charge.succeeded"]),
    ev("AUTHORISATION", ["charge.failed"], false),
    ev("AUTHORISATION_ADJUSTMENT", { none: "We never adjust an authorised amount." }),
    ev("CANCELLATION", ["intent.voided"]),
    ev("CANCEL_OR_REFUND", ["charge.refunded"]),
    ev("CAPTURE", ["charge.succeeded"]),
    ev("CAPTURE", ["charge.failed"], false),
    ev("CAPTURE_FAILED", ["charge.failed"]),
    // "The original payment has expired": an uncaptured authorisation lapsed.
    ev("EXPIRE", ["intent.voided"]),
    ev("HANDLED_EXTERNALLY", {
      none: "Handled outside Adyen; nothing moved through this account.",
    }),
    ev("ORDER_OPENED", NOT_USED("Partial payments (orders)")),
    ev("ORDER_CLOSED", NOT_USED("Partial payments (orders)")),
    ev("REFUND", ["charge.refunded"]),
    ev("REFUND", ["refund.failed"], false),
    ev("REFUND_FAILED", ["refund.failed"]),
    ev("REFUNDED_REVERSED", ["refund.failed"]),
    ev("REFUND_WITH_DATA", NOT_USED("Unreferenced refunds")),
    ev("VOID_PENDING_REFUND", NOT_USED("Point-of-sale refunds")),
    ev("AUTORESCUE", NOT_USED("Auto Rescue")),
    ev("CANCEL_AUTORESCUE", NOT_USED("Auto Rescue")),
    ev("TECHNICAL_CANCEL", { none: "We never send a technical cancel." }),
    ev("OFFER_CLOSED", { none: "An abandoned session; nothing was paid." }),
    ev("REFUND_NOT_CLEARED", {
      none: "Sales-day payout accounting: the shopper has the refund; Adyen moves it between batches.",
    }),
    // "Adyen did not receive the captured funds … Adyen debits the payment amount from your payable batch."
    ev("SETTLED_REVERSED", ["charge.reversed"]),
    ev("POSTPONED_REFUND", { none: "Our refunds are of captured payments only." }),
    ev("PENDING", NOT_USED("Redirect and bank-transfer methods")),
    ev("MANUAL_REVIEW_ACCEPT", ["review.closed"]),
    ev("MANUAL_REVIEW_REJECT", ["review.closed"]),
    dsp("NOTIFICATION_OF_FRAUD", {
      none: "An informational fraud alert (TC40/SAFE), not a dispute; no money moves.",
    }),
    dsp("REQUEST_FOR_INFORMATION", ["dispute.created"]),
    dsp("NOTIFICATION_OF_CHARGEBACK", ["dispute.created"]),
    dsp("INFORMATION_SUPPLIED", {
      none: "Our defence was submitted; the case and its money do not change.",
    }),
    dsp("CHARGEBACK", ["dispute.created", "dispute.funds_withdrawn"]),
    dsp("SECOND_CHARGEBACK", ["dispute.funds_withdrawn", "dispute.lost"]),
    dsp("CHARGEBACK_REVERSED", ["dispute.funds_reinstated"]),
    dsp("PREARBITRATION_WON", ["dispute.won"]),
    dsp("PREARBITRATION_LOST", ["dispute.lost"]),
    dsp("PREARBITRATION_OPEN", ["dispute.created"]),
    dsp("PREARBITRATION_ACCEPTED", {
      none: "Our own answer; disputeStatus stays Pending until the verdict event.",
    }),
    dsp("PREARBITRATION_DECLINED", {
      none: "Our own answer; disputeStatus stays Pending until the verdict event.",
    }),
    dsp("PREARBITRATION_ISSUER_WITHDRAWN", ["dispute.won"]),
    dsp("SCHEME_ARBITRATION", {
      none: "Escalated to the scheme; disputeStatus stays Pending until the ruling.",
    }),
    dsp("SCHEME_ARBITRATION_WON", ["dispute.won"]),
    dsp("SCHEME_ARBITRATION_LOST", ["dispute.lost"]),
    // "the defense period ended because you accepted liability": the only notice of an accepted chargeback.
    dsp("DISPUTE_DEFENSE_PERIOD_ENDED", ["dispute.lost"]),
    // "The issuer either accepted your defense of the dispute, or did not respond in time." (Won)
    dsp("ISSUER_RESPONSE_TIMEFRAME_EXPIRED", ["dispute.won"]),
    dsp("ISSUER_COMMENTS", { none: "Free-text issuer comments; no status or money change." }),
    // SEPA Direct Debit: a return or claim arrives as CHARGEBACK with one of these codes.
    ...Object.keys(SEPA_REASON).map(sepa),
  ],
  na: {
    "S6.after-failure":
      "A refused Adyen payment is final; a retry is a new payment with a new pspReference.",
    S10: "Cards answer at once, and our SEPA debits capture with the authorisation (`captureDelayHours: 0`); Adyen cancels only an uncaptured payment, so no pending debit can be stopped. https://docs.adyen.com/payment-methods/sepa-direct-debit/api-only",
    // https://docs.adyen.com/development-resources/api-idempotency (read 2026-10-27)
    "S7.locate-none":
      "Adyen has no payment lookup; the lost answer is found by resending the create under the same key, which makes a payment Adyen never received while the invoice still owes it. So the attempt never ends 'not created': S7.replay-creates-once, S7.replay-not-owed, S7.replay-instrument-gone and S7.replay-in-flight cover this path.",
  },
  limits: [
    { op: "charge", field: "header:idempotency-key", max: 64, source: DOC.idempotency },
    { op: "charge", field: "reference", max: 80, source: SPEC },
    { op: "charge", field: "metadata.tmbilling_ref", max: 80, source: SPEC },
    { op: "refund", field: "header:idempotency-key", max: 64, source: DOC.idempotency },
    { op: "refund", field: "reference", max: 80, source: SPEC },
  ],
  driver: () => new AdyenDriver(),
  extraRows: [
    // https://docs.adyen.com/unified-commerce/pay-by-link/create-payment-links/api
    ...hostedApplePayRows({
      createOp: "payment_link",
      intentPrefix: "adypl_",
      methodUsed: "apple_pay",
      checkCreate(call, ref) {
        const b = call.body as Record<string, unknown>;
        const methods = JSON.stringify(b.allowedPaymentMethods);
        if (methods !== '["applepay"]') return `allowedPaymentMethods ${methods}`;
        if (b.reference !== `tmh:${ref}`) return `reference ${String(b.reference)}`;
        if ((b.metadata as Record<string, string>)?.tmbilling_ref !== ref)
          return "no ownership ref";
        if ((b.amount as Amount)?.value !== Number(AMOUNT)) return "not the invoice amount";
        if (b.manualCapture !== true || b.reusable !== false) return "not a one-time hold";
        if (!call.headers["idempotency-key"]) return "no Idempotency-Key";
        return null;
      },
      pay: payLink,
    }),
    {
      scenario: "S6",
      id: "S6.intent-id",
      title: "a capture made in the Customer Area names the authorisation it captures",
      async run({ world }) {
        const w = await world("s6ady");
        const d = w.driver as AdyenDriver;
        const b = await w.collected();
        const p = d.payment(b.chargeId);
        const hold = d.fake.newPayment({ ...p, reference: `tmp:${p.reference.slice(4)}` });
        const m = d.fake.newMod(hold, "capture", hold.amount.value);
        const body = d.notify(d.modItem(m, "CAPTURE"));
        await w.deliver(body);
        const [row] = await w.eventRows(body.eventIds);
        const intent = (row?.normalized as { providerIntentId?: string } | null)?.providerIntentId;
        return {
          pass: intent === hold.psp,
          detail: `providerIntentId ${intent ?? "absent"} (want ${hold.psp})`,
        };
      },
    },
    {
      scenario: "S8",
      id: "S8.704-on-422",
      title:
        '704 "request already processed or in progress" on HTTP 422 with transient-error is never a definite failure',
      async run({ world }) {
        const w = await world("s8704");
        const d = w.driver as AdyenDriver;
        d.fake.inject(
          "charge",
          {
            kind: "http",
            status: 422,
            body: {
              status: 422,
              errorCode: "704",
              message: "Request already processed or in progress",
              errorType: "validation",
            },
            headers: { "transient-error": "true" },
            afterCreate: true,
          },
          6,
        );
        const b = await w.bill().finally(() => d.fake.clearFaults());
        const outcome = b.txnStatus ?? b.paymentStatus;
        return { pass: outcome !== "failed", detail: `attempt ${outcome} ${b.failureCode ?? ""}` };
      },
    },
    {
      scenario: "S13",
      id: "S13.googlepay-notification",
      // A Google Pay pay-now is a card payment to Adyen (DOC.googlePay). The item's
      // `paymentMethod` value is not documented; `googlepay` is the type name. Live proof: 5d.
      title: "a refund notification for a Google Pay payment books like a card's, once",
      async run({ world }) {
        const w = await world("s13gpay");
        const d = w.driver as AdyenDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        const m = d.fake.newMod(d.payment(b.chargeId), "refund", 1500);
        const body = d.notify({ ...d.modItem(m, "REFUND"), paymentMethod: "googlepay" });
        await w.deliver(body);
        await w.deliver(body);
        return {
          pass: (await w.cash()) === cash0 - 1500n,
          detail: `cash ${(await w.cash()) - cash0} (want -1500)`,
        };
      },
    },
    {
      scenario: "S13",
      id: "S13.batched-items",
      title: "one delivery carrying several notification items books each",
      async run({ world }) {
        const w = await world("s13batch");
        const d = w.driver as AdyenDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        const p = d.payment(b.chargeId);
        const r1 = d.fake.newMod(p, "refund", 1000);
        const r2 = d.fake.newMod(p, "refund", 2000);
        await w.deliver(d.notify(d.modItem(r1, "REFUND"), d.modItem(r2, "REFUND")));
        const rows = await w.refundRows(b.paymentId!);
        return {
          pass: (await w.cash()) === cash0 - 3000n,
          detail: `cash ${(await w.cash()) - cash0} rows ${rows.map((r) => `${r.amountMinor}:${r.status}`)}`,
        };
      },
    },
    {
      scenario: "S7",
      id: "S7.replay-creates-once",
      title:
        "a create Adyen never received is made by the sweep's same-key replay, once, with the original body",
      async run({ world }) {
        const w = await world("s7rep");
        const { b, d, made, calls } = await lostCharge(w, false);
        const cash0 = await w.cash();
        const sent = d.fake.callsOf("charge").at(-1)!.body;
        await sweepAt(w, later(15 * 60_000));
        const after = await w.reload(b);
        const replayed = d.fake.callsOf("charge").at(-1)!.body;
        const n = calls();
        await sweepAt(w, later(30 * 60_000));
        const same = JSON.stringify(sent) === JSON.stringify(replayed);
        return {
          pass:
            made().length === 1 &&
            after.txnStatus === "succeeded" &&
            after.chargeId === made()[0] &&
            (await w.cash()) === cash0 + AMOUNT &&
            calls() === n &&
            same,
          detail: `charges ${made().length} attempt ${outcomeOf(after)} cash ${(await w.cash()) - cash0} calls after a second sweep +${calls() - n} same body ${same}`,
        };
      },
    },
    {
      scenario: "S7",
      id: "S7.replay-not-owed",
      title: "no replay once the invoice no longer owes the money: the row stays for an operator",
      async run({ world }) {
        const w = await world("s7paid");
        const { b, made, calls } = await lostCharge(w, false);
        // Offline payment and void are refused while the debit is pending; a direct write
        // stands in for a settlement those guards do not see.
        await withTenant(w.org.id, (tx) =>
          tx.update(invoices).set({ status: "paid" }).where(eq(invoices.id, b.invoiceId)),
        );
        return noReplay(w, b, made, calls);
      },
    },
    {
      scenario: "S7",
      id: "S7.replay-instrument-gone",
      title: "no replay on an instrument that can no longer be charged",
      async run({ world }) {
        const w = await world("s7pm");
        const { b, made, calls } = await lostCharge(w, false);
        await withTenant(w.org.id, (tx) =>
          tx
            .update(paymentMethods)
            .set({ status: "invalid" })
            .where(eq(paymentMethods.id, b.paymentMethodId)),
        );
        return noReplay(w, b, made, calls);
      },
    },
    {
      scenario: "S7",
      id: "S7.replay-in-flight",
      title:
        "a replay answered 704 (in flight) decides nothing: the row stays timeout, never 'not created'",
      async run({ world }) {
        const w = await world("s7704");
        const { b, d } = await lostCharge(w, true);
        d.fake.inject("charge", { kind: "http", ...d.errors.conflict }, 20);
        try {
          await sweepAt(w, later(15 * 60_000));
          const early = outcomeOf(await w.reload(b));
          await sweepAt(w, later(25 * 3_600_000));
          const late = await w.reload(b);
          return {
            pass: early === "timeout" && late.txnStatus === "timeout",
            detail: `at 15 min ${early}; at 25 h ${outcomeOf(late)} ${late.failureCode ?? ""}`,
          };
        } finally {
          d.fake.clearFaults();
        }
      },
    },
    // ── SEPA Direct Debit (EUR) ──
    {
      scenario: "S13",
      id: "S13.sepa-charge-request",
      title:
        "a SEPA renewal is a ContAuth subscription debit with type sepadirectdebit, saved as a SEPA mandate",
      async run({ world }) {
        const w = await world("s13sepa");
        const d = w.driver as AdyenDriver;
        const b = await w.bill("bank_debit");
        const sent = d.fake.callsOf("charge").at(-1)?.body ?? {};
        const pmt = sent.paymentMethod as { type?: string } | undefined;
        const [pm] = await withTenant(w.org.id, (tx) =>
          tx.select().from(paymentMethods).where(eq(paymentMethods.id, b.paymentMethodId)),
        );
        const [pay] = b.paymentId
          ? await withTenant(w.org.id, (tx) =>
              tx.select().from(payments).where(eq(payments.id, b.paymentId!)),
            )
          : [];
        return {
          pass:
            b.txnStatus === "succeeded" &&
            pmt?.type === "sepadirectdebit" &&
            sent.shopperInteraction === "ContAuth" &&
            sent.recurringProcessingModel === "Subscription" &&
            (sent.amount as Amount | undefined)?.currency === "EUR" &&
            pm?.type === "sepa_debit" &&
            pm.last4 === TEST_IBAN.slice(-4) &&
            pm.mandateRail === "sepa_core" &&
            pay?.methodType === "sepa_debit",
          detail: `txn ${b.txnStatus} type ${pmt?.type} ${String(sent.shopperInteraction)}/${String(sent.recurringProcessingModel)} pm ${pm?.type} ${pm?.last4} rail ${pm?.mandateRail} paid with ${pay?.methodType}`,
        };
      },
    },
    {
      scenario: "S13",
      id: "S13.sepa-received-settles",
      title:
        "a SEPA debit answered Received stays pending until its AUTHORISATION, then books once",
      async run({ world }) {
        const w = await world("s13separ");
        const d = w.driver as AdyenDriver;
        d.fake.sepaResult = "Received";
        try {
          const cash0 = await w.cash();
          const b = await w.bill("bank_debit");
          const pending = outcomeOf(b);
          const body = d.notify(d.payItem(d.payment(b.chargeId), "AUTHORISATION"));
          await w.deliver(body);
          await w.deliver(body);
          const after = await w.reload(b);
          return {
            pass:
              (pending === "in_progress" || pending === "pending") &&
              after.txnStatus === "succeeded" &&
              (await w.cash()) === cash0 + AMOUNT &&
              (await w.balanced()),
            detail: `at submission ${pending}; after webhook ${outcomeOf(after)} cash ${(await w.cash()) - cash0}`,
          };
        } finally {
          d.fake.sepaResult = "Authorised";
        }
      },
    },
    {
      scenario: "S9",
      id: "S9.sepa-return-reopens",
      title:
        "a SEPA bank return (CHARGEBACK AM04) reverses the payment and reopens the invoice, once, with no dispute",
      async run({ world }) {
        const w = await world("s9sepa");
        const d = w.driver as AdyenDriver;
        const b = await w.bill("bank_debit");
        const cash0 = await w.cash();
        const item = d.sepaChargeback(d.payment(b.chargeId), "AM04");
        const body = d.notify(item);
        await w.deliver(body);
        const n = await w.entries();
        await w.deliver(body);
        const after = await w.reload(b);
        const disp = await w.dispute(item.pspReference!);
        const inv = await w.invoiceStatus(b.invoiceId);
        const [row] = await w.eventRows(body.eventIds);
        const code = (row?.normalized as { failureCode?: string } | null)?.failureCode;
        return {
          pass:
            b.txnStatus === "succeeded" &&
            (await w.cash()) === cash0 - AMOUNT &&
            inv !== "paid" &&
            after.txnStatus === "late_failed" &&
            !disp &&
            code === "insufficient_funds" &&
            (await w.entries()) === n &&
            (await w.balanced()),
          detail: `cash ${(await w.cash()) - cash0} invoice ${inv} txn ${after.txnStatus} code ${code} dispute ${disp?.status ?? "none"}`,
        };
      },
    },
    {
      scenario: "S9",
      id: "S9.sepa-return-while-pending",
      title: "a SEPA return before the debit was booked fails it: no money, invoice unpaid",
      async run({ world }) {
        const w = await world("s9sepap");
        const d = w.driver as AdyenDriver;
        d.fake.sepaResult = "Received";
        try {
          const cash0 = await w.cash();
          const b = await w.bill("bank_debit");
          await w.deliver(d.notify(d.sepaChargeback(d.payment(b.chargeId), "AC04")));
          const after = await w.reload(b);
          const inv = await w.invoiceStatus(b.invoiceId);
          return {
            pass:
              after.txnStatus === "failed" &&
              (await w.cash()) === cash0 &&
              inv !== "paid" &&
              (await w.balanced()),
            detail: `txn ${outcomeOf(after)} code ${after.failureCode} cash ${(await w.cash()) - cash0} invoice ${inv}`,
          };
        } finally {
          d.fake.sepaResult = "Authorised";
        }
      },
    },
    {
      scenario: "S5",
      id: "S5.sepa-refund-request",
      title:
        "a SEPA refund request by the payer (MD06) is a dispute, withdrawn and lost at once; the invoice stays paid",
      async run({ world }) {
        const w = await world("s5sepa");
        const d = w.driver as AdyenDriver;
        const b = await w.bill("bank_debit");
        const cash0 = await w.cash();
        const item = d.sepaChargeback(d.payment(b.chargeId), "MD06");
        const body = d.notify(item);
        await w.deliver(body);
        const n = await w.entries();
        await w.deliver(body);
        const disp = await w.dispute(item.pspReference!);
        const inv = await w.invoiceStatus(b.invoiceId);
        return {
          pass:
            disp?.status === "lost" &&
            (await w.cash()) === cash0 - AMOUNT &&
            inv === "paid" &&
            (await w.entries()) === n &&
            (await w.balanced()),
          detail: `dispute ${disp?.status ?? "none"} cash ${(await w.cash()) - cash0} invoice ${inv}`,
        };
      },
    },
    {
      scenario: "S5",
      id: "S5.sepa-unknown-code",
      title: "a SEPA chargeback with a code we do not know stays a dispute, never a re-debit",
      async run({ world }) {
        const w = await world("s5sepau");
        const d = w.driver as AdyenDriver;
        const b = await w.bill("bank_debit");
        const item = d.sepaChargeback(d.payment(b.chargeId), "ZZ99");
        await w.deliver(d.notify(item));
        const disp = await w.dispute(item.pspReference!);
        const inv = await w.invoiceStatus(b.invoiceId);
        return {
          pass: disp?.status === "lost" && inv === "paid" && (await w.balanced()),
          detail: `dispute ${disp?.status ?? "none"} invoice ${inv}`,
        };
      },
    },
    {
      scenario: "S2",
      id: "S2.sepa-refund",
      title: "a partial refund of a SEPA debit books at its amount when REFUND arrives, once",
      async run({ world }) {
        const w = await world("s2sepa");
        const d = w.driver as AdyenDriver;
        const b = await w.bill("bank_debit");
        const cash0 = await w.cash();
        const r = await refundPayment({
          organizationId: w.org.id,
          businessId: w.biz.id,
          paymentPublicId: b.paymentPublicId!,
          amountMinor: 2500,
        });
        await w.deliver(d.refundEvent(w, b.chargeId, r.providerRefundId!, "succeeded"));
        await w.redeliver();
        const rows = await w.refundRows(b.paymentId!);
        return {
          pass:
            (await w.cash()) === cash0 - 2500n &&
            rows.length === 1 &&
            rows[0]!.status === "succeeded" &&
            (await w.balanced()),
          detail: `cash ${(await w.cash()) - cash0} rows ${rows.map((x) => `${x.amountMinor}:${x.status}`)}`,
        };
      },
    },
    {
      scenario: "S2",
      id: "S2.refund-by-cancel",
      title:
        "our refund that Adyen completes by cancelling the debit (CANCEL_OR_REFUND, action cancel) books as the refund",
      async run({ world }) {
        const w = await world("s2cxl");
        const d = w.driver as AdyenDriver;
        const b = await w.bill("bank_debit");
        const cash0 = await w.cash();
        const r = await refundPayment({
          organizationId: w.org.id,
          businessId: w.biz.id,
          paymentPublicId: b.paymentPublicId!,
          amountMinor: Number(AMOUNT),
        });
        const m = d.fake.mods.get(r.providerRefundId!);
        if (!m) return { pass: false, detail: `no modification ${r.providerRefundId}` };
        await w.deliver(
          d.notify(d.modItem(m, "CANCEL_OR_REFUND", true, { "modification.action": "cancel" })),
        );
        const rows = await w.refundRows(b.paymentId!);
        return {
          pass:
            (await w.cash()) === cash0 - AMOUNT &&
            rows.length === 1 &&
            rows[0]!.status === "succeeded" &&
            (await w.balanced()),
          detail: `${m.kind} cash ${(await w.cash()) - cash0} rows ${rows.map((x) => `${x.amountMinor}:${x.status}`)}`,
        };
      },
    },
    {
      scenario: "S7",
      id: "S7.sepa-replay-same-body",
      title: "a lost SEPA charge is replayed with the same body, type sepadirectdebit included",
      async run({ world }) {
        const w = await world("s7sepa");
        const d = w.driver as AdyenDriver;
        d.fake.inject("charge", { kind: "network", afterCreate: false }, 6);
        const b = await w.bill("bank_debit").finally(() => d.fake.clearFaults());
        const sent = d.fake.callsOf("charge").at(-1)!.body;
        await sweepAt(w, later(15 * 60_000));
        const replayed = d.fake.callsOf("charge").at(-1)!.body;
        const after = await w.reload(b);
        return {
          pass:
            JSON.stringify(sent) === JSON.stringify(replayed) &&
            (replayed.paymentMethod as { type?: string }).type === "sepadirectdebit" &&
            after.txnStatus === "succeeded",
          detail: `attempt ${outcomeOf(after)} type ${(replayed.paymentMethod as { type?: string }).type}`,
        };
      },
    },
    // ── Answer first, process from the stored rows ──
    {
      scenario: "S11",
      id: "S11.answered-before-processing",
      title:
        "the route stores a delivery and answers [accepted] before it books anything; the queued job books it once",
      async run({ world }) {
        const w = await world("s11store");
        const d = w.driver as AdyenDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        const m = d.fake.newMod(d.payment(b.chargeId), "refund", 1200);
        const body = d.notify(d.modItem(m, "REFUND"));
        const post = () =>
          w.app.inject({
            method: "POST",
            url: `/v1/gateway_webhooks/adyen?id=${w.account.publicId}`,
            headers: { "content-type": "application/json", host: new URL(w.notificationUrl).host },
            payload: d.signBody(w, body.body, w.secret),
          });
        const res = await post();
        const [row] = await w.eventRows(body.eventIds);
        const cashBefore = await w.cash();
        const again = await post();
        const jobs = (await systemDb.execute(
          sql`select count(*)::int as n from graphile_worker.jobs where task_identifier = 'process_gateway_webhook' and key like ${`gwhook:adyen:${w.biz.id}:%`}`,
        )) as unknown as Array<{ n: number }>;
        await drainStoredWebhooks();
        const [done] = await w.eventRows(body.eventIds);
        return {
          pass:
            res.statusCode === 200 &&
            res.body === "[accepted]" &&
            again.statusCode === 200 &&
            row?.outcome == null &&
            row?.responseStatus === 200 &&
            cashBefore === cash0 &&
            jobs[0]?.n === 1 &&
            done?.outcome === "processed" &&
            (await w.cash()) === cash0 - 1200n,
          detail: `answer ${res.statusCode} ${res.body} stored ${row?.outcome ?? "null"} cash before job ${cashBefore - cash0} jobs ${jobs[0]?.n} after ${done?.outcome} cash ${(await w.cash()) - cash0}`,
        };
      },
    },
    {
      scenario: "S11",
      id: "S11.stored-error-retries",
      title: "a stored event that errored is applied when its job runs again, once",
      async run({ world }) {
        const w = await world("s11retry");
        const d = w.driver as AdyenDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        const m = d.fake.newMod(d.payment(b.chargeId), "refund", 700);
        const body = d.notify(d.modItem(m, "REFUND"));
        // Stored and queued, not yet run.
        await w.app.inject({
          method: "POST",
          url: `/v1/gateway_webhooks/adyen?id=${w.account.publicId}`,
          headers: { "content-type": "application/json", host: new URL(w.notificationUrl).host },
          payload: d.signBody(w, body.body, w.secret),
        });
        const [first] = await w.eventRows(body.eventIds);
        // As an earlier run of the job left it: errored, nothing booked.
        await systemDb
          .update(providerEvents)
          .set({ outcome: "error", error: "simulated" })
          .where(and(eq(providerEvents.businessId, w.biz.id), eq(providerEvents.id, first!.id)));
        await drainStoredWebhooks();
        const [after] = await w.eventRows(body.eventIds);
        const rows = await w.refundRows(b.paymentId!);
        return {
          pass:
            after?.outcome === "processed" &&
            (await w.cash()) === cash0 - 700n &&
            rows.length === 1 &&
            (await w.balanced()),
          detail: `outcome ${after?.outcome} cash ${(await w.cash()) - cash0} refunds ${rows.length}`,
        };
      },
    },
    // "IDR 0 (differs from standard)", "CVE 0", "CLP 2", "ISK 2".
    currencyRow("IDR", 1_000_000n, 10_000),
    currencyRow("CVE", 10_000n, 100),
    currencyRow("CLP", 5000n, 500_000),
    currencyRow("ISK", 5n, 500),
  ],
};
