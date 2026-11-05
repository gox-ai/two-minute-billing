/**
 * Mollie adapter, offline. No request leaves the process: `fetch` is replaced by a fake API
 * that answers with the shapes measured on the Mollie test API (2026-10-25).
 *
 * What regresses without it: a forged webhook id books something; a redelivery books twice;
 * a SEPA late failure or a chargeback stops reaching the reversal and dispute paths; a
 * one-off payment becomes a stored instrument; a lost create answer books a second debit.
 *
 *   pnpm verify:mollie
 */
import { createHmac } from "node:crypto";
import { closeDb } from "@/platform/db";
import { flushGatewayRequestLogs } from "@/providers/http";
import {
  MollieProvider,
  mapMolliePayment,
  mollieMethodUsed,
  mollieRefundStatus,
  normalizeMollieMandateStatus,
  reachableWebhookUrl,
  verifyMollieSignature,
  type MolliePayment,
} from "@/providers/mollie";
import { declineHiddenFromPayer, normalizeMollieDecline } from "@/providers/decline-codes";
import { GATEWAYS } from "@/providers/gateway-catalog";
import { GATEWAY_FACTORIES } from "@/providers/gateways";
import { ProviderIndeterminateError, ProviderRefusalError } from "@/providers/types";

const checks: [string, boolean, string?][] = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);
const BASE = "https://mollie.invalid/v2";
const KEY = "test_offlineofflineofflineoffline00";
const HOOK = "https://billing.example.com/v1/gateway_webhooks/mollie?id=gwa_XXXXXXXXXXXX01";

// ── fake API ────────────────────────────────────────────────────────────────
interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}
const seen: Seen[] = [];
type Route = (req: Seen) => { status: number; body: unknown } | "throw" | undefined;
let routes: Route[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const req: Seen = {
    method: init?.method ?? "GET",
    url,
    headers: Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    ),
    body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
  };
  seen.push(req);
  for (const r of routes) {
    const hit = r(req);
    if (hit === "throw") throw new Error("socket hang up");
    if (hit) return new Response(JSON.stringify(hit.body), { status: hit.status });
  }
  return new Response(
    JSON.stringify({ status: 404, title: "Not Found", detail: "No payment exists with token." }),
    { status: 404 },
  );
}) as typeof fetch;

const path = (r: Seen) => new URL(r.url).pathname.replace(/^\/v2/, "");
const get =
  (p: string, body: unknown, status = 200): Route =>
  (r) =>
    r.method === "GET" && path(r) === p ? { status, body } : undefined;
const list = (key: string, items: unknown[]) => ({
  _embedded: { [key]: items },
  count: items.length,
});

const mollie = (over: Partial<ConstructorParameters<typeof MollieProvider>[0]> = {}) =>
  new MollieProvider({ apiKey: KEY, livemode: false, apiBase: BASE, ...over });

const eur = (value: string) => ({ value, currency: "EUR" });
const pay = (over: Partial<MolliePayment>): MolliePayment => ({
  id: "tr_XXXXXXXXXXXX01",
  mode: "test",
  status: "paid",
  method: "directdebit",
  sequenceType: "recurring",
  createdAt: "2026-10-24T19:02:14+00:00",
  paidAt: "2026-10-24T19:02:41+00:00",
  amount: eur("12.34"),
  amountRefunded: eur("0.00"),
  amountRemaining: eur("12.34"),
  customerId: "cst_XXXXXXXX01",
  mandateId: "mdt_XXXXXXXX01",
  metadata: { tmbilling_kind: "charge", tmbilling_ref: "pay_XXXXXXXXXXXX01" },
  details: {},
  ...over,
});

// ── catalog + factory ────────────────────────────────────────────────────────
function catalog() {
  const def = GATEWAYS.mollie;
  const adapter = mollie();
  ok("catalog: display name Mollie", def.displayName === "Mollie");
  ok(
    "catalog: advertised methods equal the adapter's",
    JSON.stringify(def.advertisedMethods) === JSON.stringify(adapter.capabilities.methods),
  );
  ok(
    "catalog: card, SEPA Direct Debit and PayPal",
    JSON.stringify(adapter.capabilities.methods) === '["card","sepa_debit","paypal"]',
  );
  ok("catalog: SEPA is bound to EUR", def.currencyBoundMethods?.sepa_debit === "EUR");
  ok(
    "catalog: the API key verifies webhooks (fetch-back), no secret to paste",
    def.webhook.secret === "credential",
  );
  ok("catalog: a query string is accepted (measured), so no path id", !def.webhook.accountIdInPath);
  ok("catalog: recurring settles by webhook", def.settlement.alwaysAsync === true);
  const build = (k: string, livemode: boolean) => {
    try {
      GATEWAY_FACTORIES.mollie.build({ api_key: k }, { businessId: "biz_x", livemode });
      return "ok";
    } catch (e) {
      return (e as Error).name;
    }
  };
  ok("factory: a test_ key builds a test account", build(KEY, false) === "ok");
  ok(
    "factory: a live_ key on a test account is refused",
    build("live_x", false) === "GatewayResolveError",
  );
  ok(
    "factory: a test_ key on a live account is refused",
    build(KEY, true) === "GatewayResolveError",
  );
  ok(
    "factory: a key without a prefix is refused",
    build("access_x", false) === "GatewayResolveError",
  );
}

function capabilities() {
  const c = mollie().capabilities;
  ok("caps: refunds, full and partial", c.refunds && c.partialRefunds);
  ok(
    "caps: setup and payment intents",
    c.intents === true && c.intentPurposes?.join() === "payment,setup",
  );
  ok("caps: no void (a paid payment is captured already)", c.intentVoid === false);
  ok("caps: intent status can be asked", c.intentStatus === true);
  ok("caps: mandates declared false (no per-debit ceiling)", c.mandates === false);
  ok(
    "caps: no pre-debit notice; the webhook catch-up polls hourly",
    !c.preDebitNotice && c.settlementReport?.intervalMinutes === 60,
  );
}

// ── webhooks ─────────────────────────────────────────────────────────────────
const hook = (body: string, headers: Record<string, string> = {}) => ({ payload: body, headers });

async function webhooks() {
  const m = mollie();
  seen.length = 0;
  routes = [];
  ok(
    "webhook: a forged id that Mollie does not know books nothing",
    (await m.normalizeWebhook(hook("id=tr_FORGEDFORGED01"))).length === 0,
  );
  ok(
    "webhook: the forged id was checked with Mollie",
    seen.length === 1 && seen[0]!.url.endsWith("/payments/tr_FORGEDFORGED01"),
  );
  seen.length = 0;
  ok(
    "webhook: a non-payment id (order, link) books nothing and is not fetched",
    (await m.normalizeWebhook(hook("id=ord_XXXXXX01"))).length === 0 && seen.length === 0,
  );
  ok("webhook: an empty body books nothing", (await m.normalizeWebhook(hook(""))).length === 0);

  routes = [
    get(
      "/payments/tr_XXXXXXXXXXXX01",
      { status: 401, title: "Unauthorized", detail: "Missing authentication" },
      401,
    ),
  ];
  let threw = false;
  try {
    await m.normalizeWebhook(hook("id=tr_XXXXXXXXXXXX01"));
  } catch {
    threw = true;
  }
  ok("webhook: a fetch-back that fails throws (Mollie redelivers), never guesses", threw);

  routes = [
    get("/payments/tr_XXXXXXXXXXXX01", pay({})),
    get("/payments/tr_XXXXXXXXXXXX01/refunds", list("refunds", [])),
    get("/payments/tr_XXXXXXXXXXXX01/chargebacks", list("chargebacks", [])),
  ];
  const a = await m.normalizeWebhook(hook("id=tr_XXXXXXXXXXXX01"));
  const b = await m.normalizeWebhook(hook("id=tr_XXXXXXXXXXXX01"));
  ok(
    "webhook: a paid renewal is charge.succeeded",
    a.length === 1 &&
      a[0]!.type === "charge.succeeded" &&
      a[0]!.providerChargeId === "tr_XXXXXXXXXXXX01",
  );
  ok(
    "webhook: the event id is the fetched state, stable on redelivery",
    a[0]!.providerEventId === "tr_XXXXXXXXXXXX01:paid" &&
      b[0]!.providerEventId === a[0]!.providerEventId,
  );
  ok(
    "webhook: our tag is read back",
    a[0]!.ownership === "ours" && a[0]!.ownershipRef === "pay_XXXXXXXXXXXX01",
  );
  ok(
    "webhookEventId: names the payment, stable",
    m.webhookEventId(hook("id=tr_XXXXXXXXXXXX01")) === "mollie:tr_XXXXXXXXXXXX01",
  );
  ok(
    "webhookEventId: two payments differ",
    m.webhookEventId(hook("id=tr_XXXXXXXXXXXX02")) !==
      m.webhookEventId(hook("id=tr_XXXXXXXXXXXX01")),
  );

  // Next-gen (signed) deliveries.
  const secret = "whsec_offline_mollie";
  const body = JSON.stringify({
    resource: "event",
    id: "event_XXXXXXXX01",
    type: "payment.paid",
    entityId: "tr_XXXXXXXXXXXX01",
  });
  const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  ok("signature: a correct HMAC verifies", verifyMollieSignature(body, sig, secret));
  ok(
    "signature: a tampered body fails",
    !verifyMollieSignature(body.replace("paid", "fail"), sig, secret),
  );
  ok(
    "signature: either of two rotation signatures verifies",
    verifyMollieSignature(body, `sha256=00, ${sig}`, secret),
  );
  const signed = mollie({ webhookSecret: secret });
  let bad = false;
  try {
    await signed.normalizeWebhook(hook(body, { "x-mollie-signature": "sha256=deadbeef" }));
  } catch {
    bad = true;
  }
  ok("signature: a next-gen delivery with a bad signature is refused", bad);
  const good = await signed.normalizeWebhook(hook(body, { "X-Mollie-Signature": sig }));
  ok(
    "signature: a signed next-gen delivery is still fetched back",
    good[0]?.type === "charge.succeeded",
  );
  const unsignedNextGen = await m.normalizeWebhook(hook(body));
  ok(
    "next-gen without a secret: fetch-back is the check",
    unsignedNextGen[0]?.type === "charge.succeeded",
  );
  ok(
    "webhookEventId: a next-gen event keeps its own id",
    m.webhookEventId(hook(body)) === "event_XXXXXXXX01",
  );
}

function mapping() {
  const ev = (
    p: MolliePayment,
    r: Parameters<typeof mapMolliePayment>[1] = [],
    c: Parameters<typeof mapMolliePayment>[2] = [],
  ) => mapMolliePayment(p, r, c);

  const pending = ev(pay({ status: "pending", paidAt: undefined }));
  ok("map: a pending debit is charge.pending", pending[0]?.type === "charge.pending");
  ok(
    "capturedAmountMinor: a paid renewal carries its amount; a pending one does not",
    ev(pay({}))[0]?.capturedAmountMinor === 1234n &&
      ev(pay({ amount: { currency: "JPY", value: "1500" } }))[0]?.capturedAmountMinor === 1500n &&
      pending[0]?.capturedAmountMinor === undefined,
  );

  const sepaFail = ev(
    pay({
      status: "failed",
      paidAt: undefined,
      failedAt: "2026-10-24T19:03:58+00:00",
      details: { bankReasonCode: "MS03", bankReason: "Reason not specified" },
    }),
  );
  const f = sepaFail[0]!;
  ok(
    "map: a SEPA failure is charge.failed with the bank reason",
    f.type === "charge.failed" &&
      f.providerFailureCode === "MS03" &&
      f.failureCode === "do_not_honor",
  );
  ok("map: every SEPA failure is flagged a reversal (late failure path)", f.lateReversal === true);
  const late = ev(pay({ status: "failed", details: { bankReasonCode: "AM04" } }))[0]!;
  ok(
    "map: a failure after paid is a late failure (reversal, insufficient funds)",
    late.type === "charge.failed" &&
      late.lateReversal === true &&
      late.failureCode === "insufficient_funds" &&
      late.failureRetriable === true,
  );
  const cardFail = ev(
    pay({
      status: "failed",
      method: "creditcard",
      paidAt: undefined,
      details: { failureReason: "card_expired", failureMessage: "The card is expired" },
    }),
  )[0]!;
  ok(
    "map: a card failure is not a reversal",
    cardFail.failureCode === "expired_card" &&
      cardFail.failureRetriable === false &&
      cardFail.lateReversal === false,
  );

  const cb = ev(
    pay({ amountChargedBack: eur("12.34") }),
    [],
    [
      {
        id: "chb_XXXXXXXXXX01",
        amount: eur("12.34"),
        createdAt: "2026-10-24T19:03:29+00:00",
        reason: { code: "MS03", description: "Reason not specified" },
        paymentId: "tr_XXXXXXXXXXXX01",
      },
    ],
  );
  const types = cb.map((e) => e.type).join(",");
  ok(
    "map: a chargeback opens a dispute with funds withdrawn",
    types === "charge.succeeded,dispute.created,dispute.funds_withdrawn",
  );
  ok(
    "map: the dispute carries id, amount and reason",
    cb[1]!.providerDisputeId === "chb_XXXXXXXXXX01" &&
      cb[1]!.disputeAmountMinor === 1234n &&
      cb[1]!.disputeReason === "MS03" &&
      cb[1]!.providerChargeId === "tr_XXXXXXXXXXXX01",
  );
  ok(
    "map: each dispute event has its own id",
    new Set(cb.map((e) => e.providerEventId)).size === cb.length,
  );
  const rev = ev(
    pay({}),
    [],
    [{ id: "chb_XXXXXXXXXX01", amount: eur("12.34"), reversedAt: "2026-10-25T10:00:00+00:00" }],
  );
  ok(
    "map: a reversed chargeback reinstates the funds",
    rev.at(-1)?.type === "dispute.funds_reinstated" &&
      rev.at(-1)?.providerEventId === "chb_XXXXXXXXXX01:reversed",
  );

  const rf = ev(pay({ amountRefunded: eur("2.00") }), [
    { id: "re_XXXXXXXXXX01", status: "pending", amount: eur("2.00") },
    { id: "re_XXXXXXXXXX02", status: "refunded", amount: eur("2.00") },
    { id: "re_XXXXXXXXXX03", status: "canceled", amount: eur("1.00") },
  ]);
  ok(
    "map: refunds pending / refunded / canceled",
    rf
      .slice(1)
      .map((e) => e.type)
      .join(",") === "refund.pending,charge.refunded,refund.failed",
  );
  ok(
    "map: a refund id carries its payment",
    rf[2]!.providerRefundId === "re_XXXXXXXXXX02:tr_XXXXXXXXXXXX01" &&
      rf[2]!.amountRefundedMinor === undefined,
  );
  // The payment's running total counts the pending refund too; the record must not.
  const mixed = ev(pay({ amountRefunded: eur("5.00") }), [
    { id: "re_XXXXXXXXXX04", status: "refunded", amount: eur("3.00") },
    { id: "re_XXXXXXXXXX05", status: "pending", amount: eur("2.00") },
  ]).find((e) => e.type === "charge.refunded");
  ok(
    "map: refunds[] carries each refund's own amount, not the running total",
    mixed?.refunds?.length === 1 &&
      mixed.refunds[0]!.amountMinor === 300n &&
      mixed.refunds[0]!.status === "succeeded",
  );

  const setup = ev(
    pay({
      sequenceType: "first",
      method: "ideal",
      amount: eur("0.01"),
      mandateId: "mdt_XXXXXXXX02",
      metadata: { tmbilling_kind: "setup" },
    }),
  );
  ok(
    "map: a paid first payment is intent.setup_succeeded with its mandate",
    setup.length === 1 &&
      setup[0]!.type === "intent.setup_succeeded" &&
      setup[0]!.providerIntentId === "tr_XXXXXXXXXXXX01" &&
      setup[0]!.providerPaymentMethodId === "mdt_XXXXXXXX02",
  );
  const setupRefund = ev(
    pay({
      sequenceType: "first",
      method: "ideal",
      amount: eur("0.01"),
      mandateId: "mdt_XXXXXXXX02",
      metadata: { tmbilling_kind: "setup" },
    }),
    [{ id: "re_XXXXXXXXXX08", status: "refunded", amount: eur("0.01") }],
  );
  ok(
    "map: the refund of a setup's check amount is not a booked refund",
    setupRefund.length === 1 && setupRefund[0]!.type === "intent.setup_succeeded",
  );
  const setupDead = ev(
    pay({
      sequenceType: "first",
      status: "expired",
      paidAt: undefined,
      metadata: { tmbilling_kind: "setup" },
    }),
  );
  ok(
    "map: an expired first payment is intent.setup_failed",
    setupDead[0]?.type === "intent.setup_failed",
  );
  const open = ev(
    pay({
      sequenceType: "first",
      status: "open",
      paidAt: undefined,
      metadata: { tmbilling_kind: "setup" },
    }),
  );
  ok("map: an open first payment says nothing yet", open.length === 0);

  const oneoff = ev(
    pay({
      sequenceType: "oneoff",
      method: "ideal",
      mandateId: null,
      customerId: null,
      metadata: { tmbilling_kind: "payment", tmbilling_ref: "pi_XXXXXXXX01" },
    }),
  );
  ok(
    "map: a paid one-off is intent.authorized (the engine consumes it)",
    oneoff[0]?.type === "intent.authorized" && oneoff[0]!.providerIntentId === "tr_XXXXXXXXXXXX01",
  );
  ok(
    "consume-side record: iDEAL is kept as Mollie's own word",
    mollieMethodUsed(pay({ method: "ideal" })) === "ideal",
  );
  ok("map: a one-off never names an instrument", !oneoff[0]!.providerPaymentMethodId);
  const oneoffFail = ev(
    pay({
      sequenceType: "oneoff",
      status: "canceled",
      paidAt: undefined,
      method: "creditcard",
      metadata: { tmbilling_kind: "payment" },
    }),
  );
  ok("map: a canceled one-off is intent.failed", oneoffFail[0]?.type === "intent.failed");
  const foreign = ev(pay({ metadata: null }));
  ok("map: a payment without our tag is foreign", foreign[0]?.ownership === "foreign");

  ok(
    "methodUsed: card, wallets, SEPA, PayPal, else Mollie's word",
    mollieMethodUsed(pay({ method: "creditcard" })) === "card" &&
      mollieMethodUsed(pay({ method: "creditcard", details: { wallet: "applepay" } })) ===
        "apple_pay" &&
      mollieMethodUsed(pay({ method: "googlepay" })) === "google_pay" &&
      mollieMethodUsed(pay({ method: "directdebit" })) === "sepa_debit" &&
      mollieMethodUsed(pay({ method: "paypal" })) === "paypal" &&
      mollieMethodUsed(pay({ method: "twint" })) === "twint" &&
      mollieMethodUsed(pay({ method: "banktransfer" })) === "banktransfer" &&
      mollieMethodUsed(pay({ method: null })) === undefined,
  );
  ok(
    "mandate status vocabulary",
    normalizeMollieMandateStatus("valid") === "active" &&
      normalizeMollieMandateStatus("pending") === "initiated" &&
      normalizeMollieMandateStatus("invalid") === "cancelled",
  );
  ok(
    "refund status vocabulary",
    mollieRefundStatus("queued") === "pending" &&
      mollieRefundStatus("processing") === "pending" &&
      mollieRefundStatus("refunded") === "succeeded" &&
      mollieRefundStatus("failed") === "failed",
  );
}

function declines() {
  const n = (code: string, message?: string) =>
    normalizeMollieDecline({ code, ...(message ? { message } : {}) });
  ok(
    "decline: AM04 → insufficient_funds, retriable",
    n("AM04").code === "insufficient_funds" && n("AM04").retriable,
  );
  ok(
    "decline: AC04 → bank_account_closed, terminal",
    n("AC04").code === "bank_account_closed" && !n("AC04").retriable,
  );
  ok(
    "decline: MD01 → debit_not_authorized, terminal",
    n("MD01").code === "debit_not_authorized" && !n("MD01").retriable,
  );
  ok(
    "decline: card_expired → expired_card, terminal",
    n("card_expired").code === "expired_card" && !n("card_expired").retriable,
  );
  ok("decline: possible_fraud → fraudulent", n("possible_fraud").code === "fraudulent");
  ok("decline: invalid_cvv → incorrect_cvc", n("invalid_cvv").code === "incorrect_cvc");
  const nm = n("no_valid_mandate");
  ok(
    "decline: no valid mandate → mandate_expired, terminal, payer may read",
    nm.code === "mandate_expired" && !nm.retriable && nm.exposedToPayer === true,
  );
  const pp = n("method_not_recurring");
  ok(
    "decline: PayPal without reference transactions → ours, terminal, hidden",
    pp.code === "gateway_request_rejected" && !pp.retriable && declineHiddenFromPayer(pp.code),
  );
}

// ── requests ─────────────────────────────────────────────────────────────────
async function requests() {
  const m = mollie({ notificationUrl: HOOK });
  seen.length = 0;
  routes = [
    (r) =>
      r.method === "POST" && path(r) === "/payments"
        ? { status: 201, body: pay({ status: "pending", paidAt: undefined }) }
        : undefined,
  ];
  const base = {
    amountMinor: 1234n,
    currency: "eur",
    customer: { providerKey: "mollie" as const, providerCustomerId: "cst_XXXXXXXX01" },
    paymentMethod: {
      providerKey: "mollie" as const,
      providerPaymentMethodId: "mdt_XXXXXXXX01",
      display: { type: "sepa_debit" as const },
    },
    idempotencyKey: "idem_charge_01",
    ownershipRef: "pay_XXXXXXXXXXXX01",
  };
  const r = await m.charge({ ...base, initiator: { by: "merchant", recurring: true } });
  const req = seen[0]!;
  ok(
    "charge: a SEPA renewal answers pending",
    r.status === "pending" && r.providerChargeId === "tr_XXXXXXXXXXXX01",
  );
  ok(
    "charge: recurring on the mandate, with the customer",
    req.body?.sequenceType === "recurring" &&
      req.body?.mandateId === "mdt_XXXXXXXX01" &&
      req.body?.customerId === "cst_XXXXXXXX01",
  );
  ok(
    "charge: amount is a decimal string in minor units' currency",
    JSON.stringify(req.body?.amount) === '{"currency":"EUR","value":"12.34"}',
  );
  ok("charge: Idempotency-Key header", req.headers["idempotency-key"] === "idem_charge_01");
  ok("charge: Bearer API key", req.headers.authorization === `Bearer ${KEY}`);
  const meta = req.body?.metadata as Record<string, string>;
  ok(
    "charge: metadata tags kind, ref and key",
    meta.tmbilling_kind === "charge" &&
      meta.tmbilling_ref === "pay_XXXXXXXXXXXX01" &&
      meta.tmbilling_idem === "idem_charge_01",
  );
  ok("charge: the webhook URL rides on the payment", req.body?.webhookUrl === HOOK);
  seen.length = 0;
  await m.charge({ ...base, initiator: { by: "customer", recurring: false } });
  ok(
    "charge: initiator has no Mollie field (a recurring payment is merchant-initiated)",
    JSON.stringify(Object.keys(seen[0]!.body!).sort()) ===
      JSON.stringify(Object.keys(req.body!).sort()),
  );
  seen.length = 0;
  await mollie({
    notificationUrl: "http://localhost:4000/v1/gateway_webhooks/mollie?id=gwa_x",
  }).charge({ ...base, currency: "JPY", amountMinor: 1234n });
  ok(
    "charge: an unreachable (localhost) webhook URL is left out (Mollie refuses it)",
    seen[0]!.body?.webhookUrl === undefined,
  );
  ok("charge: JPY has no decimals", (seen[0]!.body!.amount as { value: string }).value === "1234");
  ok(
    "reachable: https host yes, localhost no",
    reachableWebhookUrl(HOOK) === HOOK &&
      !reachableWebhookUrl("http://127.0.0.1:4000/x") &&
      !reachableWebhookUrl("http://localhost/x"),
  );

  // A lost answer: retried under the same key, then looked up by our metadata.
  let posts = 0;
  routes = [
    (q) => (q.method === "POST" && path(q) === "/payments" ? (posts++, "throw") : undefined),
    get(
      "/payments",
      list("payments", [
        pay({
          id: "tr_XXXXXXXXXXXX09",
          metadata: { tmbilling_idem: "idem_lost_01", tmbilling_kind: "charge" },
        }),
      ]),
    ),
  ];
  const lost = await m.charge({ ...base, idempotencyKey: "idem_lost_01" });
  ok(
    "lost answer: retried under the same key, then found by metadata",
    posts === 3 && lost.providerChargeId === "tr_XXXXXXXXXXXX09" && lost.status === "succeeded",
  );
  routes = [
    (q) =>
      q.method === "POST" && path(q) === "/payments"
        ? { status: 503, body: { status: 503, title: "Service Unavailable" } }
        : undefined,
    get("/payments", list("payments", [])),
  ];
  let indeterminate = false;
  try {
    await m.charge({ ...base, idempotencyKey: "idem_lost_02" });
  } catch (e) {
    indeterminate = e instanceof ProviderIndeterminateError;
  }
  ok("lost answer: not found → ProviderIndeterminateError, never a decline", indeterminate);

  // 409: "the initial request is still being processed" — in flight, never a refusal.
  routes = [
    (q) =>
      q.method === "POST" && path(q) === "/payments"
        ? { status: 409, body: { status: 409, title: "Conflict" } }
        : undefined,
    get("/payments", list("payments", [])),
  ];
  let inFlight = false;
  try {
    await m.charge({ ...base, idempotencyKey: "idem_409_01" });
  } catch (e) {
    inFlight = e instanceof ProviderIndeterminateError;
  }
  ok("409 on a charge → indeterminate, never a decline", inFlight);

  // locateCharge: by our key; a payment of an earlier attempt on the same invoice is not it.
  routes = [
    get(
      "/payments",
      list("payments", [
        pay({
          id: "tr_XXXXXXXXXXXX11",
          createdAt: "2026-10-25T10:00:00+00:00",
          metadata: { tmbilling_idem: "idem_other", tmbilling_ref: "inv_X01" },
        }),
        pay({
          id: "tr_XXXXXXXXXXXX10",
          createdAt: "2026-10-25T09:00:00+00:00",
          status: "pending",
          metadata: { tmbilling_idem: "idem_loc_01", tmbilling_ref: "inv_X01" },
        }),
      ]),
    ),
  ];
  const where = {
    ownershipRef: "inv_X01",
    amountMinor: 1234n,
    currency: "EUR",
    createdAfter: new Date("2026-10-25T08:00:00Z"),
  };
  const found = await m.locateCharge({ ...where, idempotencyKey: "idem_loc_01" });
  const none = await m.locateCharge({ ...where, idempotencyKey: "idem_loc_02" });
  ok(
    "locateCharge: found by our key (pending), else null",
    found?.providerChargeId === "tr_XXXXXXXXXXXX10" && found.status === "pending" && none === null,
  );
  let emptyIdRefused = false;
  try {
    await m.fetchChargeStatus({ providerChargeId: "" });
  } catch {
    emptyIdRefused = true;
  }
  ok("fetchChargeStatus: an empty id is refused, never a list read", emptyIdRefused);

  // The webhook catch-up: refunds and chargeback reversals read from the list endpoints.
  const ours = pay({});
  routes = [
    get(
      "/refunds",
      list("refunds", [
        {
          id: "re_XXXXXXXXXX06",
          status: "refunded",
          amount: eur("2.50"),
          paymentId: ours.id,
          createdAt: "2026-10-25T09:30:00+00:00",
          _embedded: { payment: ours },
        },
        {
          id: "re_XXXXXXXXXX07",
          status: "refunded",
          amount: eur("1.00"),
          paymentId: "tr_XXXXXXXXXXXX99",
          createdAt: "2026-10-25T09:20:00+00:00",
          _embedded: { payment: pay({ id: "tr_XXXXXXXXXXXX99", metadata: {} }) },
        },
      ]),
    ),
    get(
      "/chargebacks",
      list("chargebacks", [
        {
          id: "chb_XXXXXXXXXX02",
          amount: eur("12.34"),
          paymentId: ours.id,
          createdAt: "2026-09-01T09:00:00+00:00",
          reversedAt: "2026-10-25T09:40:00+00:00",
          _embedded: { payment: ours },
        },
        {
          id: "chb_XXXXXXXXXX03",
          amount: eur("12.34"),
          paymentId: ours.id,
          createdAt: "2026-08-01T09:00:00+00:00",
          reversedAt: null,
          _embedded: { payment: ours },
        },
      ]),
    ),
  ];
  const polled = await m.pollSettlements({
    since: new Date("2026-10-25T09:00:00Z"),
    until: new Date("2026-10-25T10:00:00Z"),
  });
  const ids = polled.map((e) => e.providerEventId).sort();
  ok(
    "poll: our refund at its own amount, an old chargeback's reversal; nothing foreign",
    ids.join() ===
      "chb_XXXXXXXXXX02:created,chb_XXXXXXXXXX02:funds_withdrawn,chb_XXXXXXXXXX02:reversed,re_XXXXXXXXXX06:refunded" &&
      polled.find((e) => e.type === "charge.refunded")?.refunds?.[0]?.amountMinor === 250n,
    ids.join(),
  );

  // A pay-later one-off left `authorized` is captured on consume.
  let captured = false;
  routes = [
    (q) =>
      q.method === "POST" && path(q) === "/payments/tr_XXXXXXXXXXXX12/captures"
        ? ((captured = true), { status: 201, body: { id: "cpt_XXXXXXXX01", status: "pending" } })
        : undefined,
    (q) =>
      q.method === "GET" && path(q) === "/payments/tr_XXXXXXXXXXXX12"
        ? {
            status: 200,
            body: pay({
              id: "tr_XXXXXXXXXXXX12",
              sequenceType: "oneoff",
              method: "klarna",
              status: captured ? "paid" : "authorized",
              authorizedAt: "2026-10-25T09:00:00+00:00",
              metadata: { tmbilling_kind: "payment", tmbilling_ref: "pi_X01" },
            }),
          }
        : undefined,
  ];
  const consumed = await m.consumeIntent({
    intentId: "tr_XXXXXXXXXXXX12",
    purpose: "payment",
    idempotencyKey: "idem_capture_01",
  });
  ok(
    "consume: an authorized pay-later payment is captured, then read back paid",
    captured && consumed.purpose === "payment" && consumed.charge?.status === "succeeded",
  );

  routes = [
    (q) =>
      q.method === "POST"
        ? {
            status: 422,
            body: {
              status: 422,
              title: "Unprocessable Entity",
              detail: "The customer has no valid mandate for this payment method",
              field: "recurringType",
            },
          }
        : undefined,
  ];
  const nm = await m.charge(base);
  ok(
    "charge: no valid mandate → failed, mandate_expired, terminal",
    nm.status === "failed" &&
      nm.failure?.code === "mandate_expired" &&
      nm.failure.retriable === false,
  );
  routes = [
    (q) =>
      q.method === "POST"
        ? {
            status: 422,
            body: {
              status: 422,
              detail: "No suitable mandates found for customer",
              field: "customerId",
            },
          }
        : undefined,
  ];
  const ns = await m.charge(base);
  ok(
    "charge: no suitable mandates (revoked) → mandate_expired",
    ns.failure?.code === "mandate_expired",
  );

  // Hosted setup (first payment).
  seen.length = 0;
  routes = [
    (q) =>
      q.method === "POST" && path(q) === "/payments"
        ? {
            status: 201,
            body: pay({
              sequenceType: "first",
              status: "open",
              paidAt: undefined,
              _links: { checkout: { href: "https://www.mollie.com/checkout/select-method/XXXX" } },
            }),
          }
        : undefined,
  ];
  const setupInput = {
    purpose: "setup" as const,
    currency: "EUR",
    customer: base.customer,
    idempotencyKey: "idem_setup_01",
    returnUrl: "https://shop.example.com/return",
    ownershipRef: "pi_XXXXXXXX01",
  };
  const s1 = await m.createIntent(setupInput);
  ok(
    "setup: redirect to Mollie's hosted checkout",
    s1.status === "requires_action" &&
      s1.authorization?.mode === "redirect" &&
      s1.authorization.approvalUrl === "https://www.mollie.com/checkout/select-method/XXXX",
  );
  ok(
    "setup: a first payment with no fixed method, EUR 0.01 so SEPA methods show",
    seen[0]!.body?.sequenceType === "first" &&
      seen[0]!.body?.method === undefined &&
      (seen[0]!.body!.amount as { value: string }).value === "0.01",
  );
  seen.length = 0;
  await m.createIntent({ ...setupInput, methodTypes: ["card"] });
  ok(
    "setup: cards only → 0.00 and the card family",
    (seen[0]!.body!.amount as { value: string }).value === "0.00" &&
      JSON.stringify(seen[0]!.body?.method) === '["creditcard"]',
  );
  routes = [
    (q) =>
      q.method === "POST"
        ? {
            status: 422,
            body: {
              status: 422,
              detail: "The payment method selected does not accept recurring payments",
              field: "method",
            },
          }
        : undefined,
  ];
  let ppMsg = "";
  try {
    await m.createIntent({ ...setupInput, methodTypes: ["paypal"] });
  } catch (e) {
    ppMsg = e instanceof ProviderRefusalError ? e.message : "";
  }
  ok(
    "setup: PayPal without recurring → a readable refusal naming Reference Transactions",
    /Reference Transactions/.test(ppMsg),
  );

  // Hosted one-off ("Pay now").
  seen.length = 0;
  routes = [
    (q) =>
      q.method === "POST"
        ? {
            status: 201,
            body: pay({
              sequenceType: "oneoff",
              status: "open",
              paidAt: undefined,
              method: null,
              _links: { checkout: { href: "https://www.mollie.com/checkout/select-method/YYYY" } },
            }),
          }
        : undefined,
  ];
  const p1 = await m.createIntent({
    purpose: "payment",
    amountMinor: 5000n,
    currency: "EUR",
    customer: base.customer,
    idempotencyKey: "idem_pay_01",
    returnUrl: "https://shop.example.com/return",
  });
  const pb = seen[0]!.body!;
  ok(
    "pay now: a one-off with no method and no customer (never a mandate)",
    pb.sequenceType === "oneoff" &&
      pb.method === undefined &&
      pb.customerId === undefined &&
      pb.mandateId === undefined,
  );
  ok(
    "pay now: redirect to the hosted page",
    p1.authorization?.approvalUrl === "https://www.mollie.com/checkout/select-method/YYYY",
  );

  // Consuming.
  const card = {
    id: "mdt_XXXXXXXX03",
    status: "valid",
    method: "creditcard",
    customerId: "cst_XXXXXXXX01",
    mandateReference: null,
    details: {
      cardNumber: "6787",
      cardLabel: "Mastercard",
      cardExpiryDate: "2030-12-31",
      cardFingerprint: "fp_XXXX",
    },
  };
  routes = [
    get(
      "/payments/tr_FIRSTFIRST0001",
      pay({
        id: "tr_FIRSTFIRST0001",
        sequenceType: "first",
        method: "creditcard",
        mandateId: "mdt_XXXXXXXX03",
        amount: eur("0.00"),
      }),
    ),
    get("/customers/cst_XXXXXXXX01/mandates/mdt_XXXXXXXX03", card),
    get(
      "/payments/tr_ONEOFFONEOFF01",
      pay({ id: "tr_ONEOFFONEOFF01", sequenceType: "oneoff", method: "paypal", mandateId: null }),
    ),
    get(
      "/payments/tr_FIRSTOTHER0001",
      pay({
        id: "tr_FIRSTOTHER0001",
        sequenceType: "first",
        customerId: "cst_XXXXXXXX99",
        mandateId: "mdt_XXXXXXXX99",
      }),
    ),
    get("/customers/cst_XXXXXXXX99/mandates/mdt_XXXXXXXX99", {
      ...card,
      id: "mdt_XXXXXXXX99",
      customerId: "cst_XXXXXXXX99",
    }),
  ];
  seen.length = 0;
  const c1 = await m.consumeIntent({
    intentId: "tr_FIRSTFIRST0001",
    idempotencyKey: "k",
    purpose: "setup",
  });
  const pm = c1.purpose === "setup" ? c1.paymentMethod : undefined;
  ok(
    "consume setup: the card mandate becomes the instrument",
    pm?.providerPaymentMethodId === "mdt_XXXXXXXX03" &&
      pm.display.type === "card" &&
      pm.display.brand === "mastercard" &&
      pm.display.last4 === "6787" &&
      pm.display.expYear === 2030 &&
      pm.display.expMonth === 12 &&
      pm.mandate?.status === "active",
  );
  ok("consume setup: a 0.00 first payment sends no refund", !seen.some((q) => q.method === "POST"));

  // A bank first payment moved EUR 0.01; consuming it gives the 0.01 back, once.
  const sepaFirst = {
    id: "tr_FIRSTSEPA00001",
    sequenceType: "first",
    method: "ideal",
    mandateId: "mdt_XXXXXXXX04",
    amount: eur("0.01"),
    amountRemaining: eur("0.01"),
  } as const;
  const sepaMandate = {
    ...card,
    id: "mdt_XXXXXXXX04",
    method: "directdebit",
    details: { consumerAccount: "NL55INGB0000000000" },
  };
  seen.length = 0;
  routes = [
    get("/payments/tr_FIRSTSEPA00001", pay(sepaFirst)),
    get("/customers/cst_XXXXXXXX01/mandates/mdt_XXXXXXXX04", sepaMandate),
    (q) =>
      q.method === "POST" && path(q) === "/payments/tr_FIRSTSEPA00001/refunds"
        ? { status: 201, body: { id: "re_XXXXXXXXXX09", status: "pending", amount: eur("0.01") } }
        : undefined,
  ];
  const c3 = await m.consumeIntent({
    intentId: "tr_FIRSTSEPA00001",
    idempotencyKey: "k",
    purpose: "setup",
  });
  await new Promise((r) => setTimeout(r, 20));
  const back = seen.filter((q) => q.method === "POST");
  ok(
    "consume setup: the SEPA mandate is the instrument",
    c3.purpose === "setup" && c3.paymentMethod?.display.type === "sepa_debit",
  );
  ok(
    "consume setup: the EUR 0.01 check is refunded under one key",
    back.length === 1 &&
      JSON.stringify(back[0]!.body?.amount) === '{"currency":"EUR","value":"0.01"}' &&
      back[0]!.headers["idempotency-key"] === "setup_refund_tr_FIRSTSEPA00001",
  );
  seen.length = 0;
  routes[0] = get(
    "/payments/tr_FIRSTSEPA00001",
    pay({
      ...sepaFirst,
      _links: { refunds: { href: "https://api.mollie.com/v2/payments/tr_FIRSTSEPA00001/refunds" } },
    }),
  );
  await m.consumeIntent({ intentId: "tr_FIRSTSEPA00001", idempotencyKey: "k", purpose: "setup" });
  await new Promise((r) => setTimeout(r, 20));
  ok(
    "consume setup: a check already refunded is not refunded again",
    !seen.some((q) => q.method === "POST"),
  );
  routes = [
    get("/payments/tr_FIRSTSEPA00001", pay(sepaFirst)),
    get("/customers/cst_XXXXXXXX01/mandates/mdt_XXXXXXXX04", sepaMandate),
    (q) =>
      q.method === "POST"
        ? { status: 422, body: { status: 422, detail: "The payment cannot be refunded" } }
        : undefined,
  ];
  const c4 = await m.consumeIntent({
    intentId: "tr_FIRSTSEPA00001",
    idempotencyKey: "k",
    purpose: "setup",
  });
  await new Promise((r) => setTimeout(r, 20));
  ok(
    "consume setup: a refused check refund still saves the mandate",
    c4.purpose === "setup" && c4.paymentMethod?.providerPaymentMethodId === "mdt_XXXXXXXX04",
  );

  routes = [
    get(
      "/payments/tr_FIRSTFIRST0001",
      pay({
        id: "tr_FIRSTFIRST0001",
        sequenceType: "first",
        method: "creditcard",
        mandateId: "mdt_XXXXXXXX03",
        amount: eur("0.00"),
      }),
    ),
    get("/customers/cst_XXXXXXXX01/mandates/mdt_XXXXXXXX03", card),
    get(
      "/payments/tr_ONEOFFONEOFF01",
      pay({ id: "tr_ONEOFFONEOFF01", sequenceType: "oneoff", method: "paypal", mandateId: null }),
    ),
    get(
      "/payments/tr_FIRSTOTHER0001",
      pay({
        id: "tr_FIRSTOTHER0001",
        sequenceType: "first",
        customerId: "cst_XXXXXXXX99",
        mandateId: "mdt_XXXXXXXX99",
      }),
    ),
    get("/customers/cst_XXXXXXXX99/mandates/mdt_XXXXXXXX99", {
      ...card,
      id: "mdt_XXXXXXXX99",
      customerId: "cst_XXXXXXXX99",
    }),
  ];
  let refused = false;
  try {
    await m.vaultPaymentMethod({ customer: base.customer, token: "tr_ONEOFFONEOFF01" });
  } catch (e) {
    refused = e instanceof ProviderRefusalError;
  }
  ok("vault: a one-off payment is never saved as an instrument", refused);
  let other = false;
  try {
    await m.vaultPaymentMethod({ customer: base.customer, token: "tr_FIRSTOTHER0001" });
  } catch (e) {
    other = e instanceof ProviderRefusalError;
  }
  ok("vault: a mandate of another customer is refused", other);
  const c2 = await m.consumeIntent({
    intentId: "tr_ONEOFFONEOFF01",
    idempotencyKey: "k",
    purpose: "payment",
  });
  ok(
    "consume payment: a paid one-off is a succeeded charge with the method used",
    c2.purpose === "payment" &&
      c2.charge.status === "succeeded" &&
      c2.charge.methodUsed === "paypal",
  );
  const fi = await m.fetchIntent({ intentId: "tr_ONEOFFONEOFF01", resolveOwnership: true });
  ok(
    "fetchIntent: paid → authorized, with ownership",
    fi.status === "authorized" && fi.ownership === "ours" && fi.amountMinor === 1234n,
  );
  ok(
    "fetchIntent: an unknown id → unknown",
    (await m.fetchIntent({ intentId: "tr_NOPENOPENOPE01" })).status === "unknown",
  );

  // Refunds.
  seen.length = 0;
  routes = [
    get("/payments/tr_XXXXXXXXXXXX01", pay({ amountRemaining: eur("10.34") })),
    (q) =>
      q.method === "POST" && path(q) === "/payments/tr_XXXXXXXXXXXX01/refunds"
        ? {
            status: 201,
            body: { id: "re_XXXXXXXXXX05", status: "pending", amount: q.body?.amount },
          }
        : undefined,
    get("/payments/tr_XXXXXXXXXXXX01/refunds/re_XXXXXXXXXX05", {
      id: "re_XXXXXXXXXX05",
      status: "refunded",
      amount: eur("10.34"),
    }),
  ];
  const full = await m.refund({
    providerChargeId: "tr_XXXXXXXXXXXX01",
    idempotencyKey: "idem_refund_01",
  });
  const rb = seen.find((q) => q.method === "POST")!;
  ok(
    "refund: full = the part still refundable",
    (rb.body!.amount as { value: string }).value === "10.34" &&
      rb.headers["idempotency-key"] === "idem_refund_01",
  );
  ok(
    "refund: pending, id carries the payment",
    full.status === "pending" && full.providerRefundId === "re_XXXXXXXXXX05:tr_XXXXXXXXXXXX01",
  );
  seen.length = 0;
  await m.refund({
    providerChargeId: "tr_XXXXXXXXXXXX01",
    amountMinor: 200n,
    currency: "EUR",
    idempotencyKey: "idem_refund_02",
  });
  ok(
    "refund: partial sends its own amount",
    (seen.find((q) => q.method === "POST")!.body!.amount as { value: string }).value === "2.00",
  );
  const fr = await m.fetchRefundStatus({ providerRefundId: full.providerRefundId });
  ok("refund: status read back under its payment", fr.status === "succeeded");
}

try {
  catalog();
  capabilities();
  await webhooks();
  mapping();
  declines();
  await requests();
} catch (e) {
  console.error(`threw: ${e instanceof Error ? e.stack : String(e)}`);
  checks.push(["suite completed", false]);
} finally {
  globalThis.fetch = realFetch;
}

let pass = true;
for (const [n, c, detail] of checks) {
  console.log(`${c ? "✅" : "❌"} ${n}${!c && detail ? `  (${detail})` : ""}`);
  if (!c) pass = false;
}
console.log(pass ? "\n✅ MOLLIE ADAPTER: PASS" : "\n❌ MOLLIE ADAPTER: FAIL");
await flushGatewayRequestLogs();
await closeDb();
process.exit(pass ? 0 : 1);
