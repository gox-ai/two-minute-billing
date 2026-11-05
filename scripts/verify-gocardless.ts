/**
 * GoCardless adapter, offline. No request leaves the process: `fetch` is replaced by a
 * fake API that answers from fixtures modelled on the documented shapes.
 *
 * What regresses without it: a forged or tampered webhook is accepted; a batch shares one
 * dedupe id; a late failure or chargeback stops reaching the late-failure and dispute
 * paths; GoCardless's own retries come back on; a 409 replay or a 5xx books a second debit.
 *
 *   pnpm verify:gocardless
 */
import { createHmac } from "node:crypto";
import { closeDb } from "@/platform/db";
import { flushGatewayRequestLogs } from "@/providers/http";
import { readFileSync } from "node:fs";
import { primeGeoReference } from "@/platform/geo";
import {
  GoCardlessProvider,
  GOCARDLESS_LIVE_BASE,
  GOCARDLESS_SANDBOX_BASE,
  gocardlessChargeDate,
  gocardlessRegion,
  gocardlessPaymentResult,
  gocardlessRefundStatus,
  normalizeGocardlessMandateStatus,
  verifyGocardlessSignature,
} from "@/providers/gocardless";
import { normalizeGocardlessDecline } from "@/providers/decline-codes";
import { GATEWAYS } from "@/providers/gateway-catalog";
import { GATEWAY_FACTORIES } from "@/providers/gateways";
import {
  ProviderIndeterminateError,
  ProviderRefusalError,
  type NormalizedProviderEvent,
  type PaymentProvider,
} from "@/providers/types";

const checks: [string, boolean, string?][] = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);
const SECRET = "gc_test_secret_offline";
const BASE = "https://gocardless.invalid";

// ── fake API ────────────────────────────────────────────────────────────────
interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
const seen: Seen[] = [];
type Route = (
  req: Seen,
) => { status: number; body: unknown; headers?: Record<string, string> } | undefined;
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
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
  seen.push(req);
  for (const r of routes) {
    const hit = r(req);
    if (hit)
      return new Response(JSON.stringify(hit.body), {
        status: hit.status,
        ...(hit.headers ? { headers: hit.headers } : {}),
      });
  }
  return new Response(JSON.stringify({ error: { message: "no fixture", code: 404 } }), {
    status: 404,
  });
}) as typeof fetch;

const get =
  (path: string, body: unknown, status = 200): Route =>
  (r) =>
    r.method === "GET" && new URL(r.url).pathname === path ? { status, body } : undefined;

const PAYMENTS: Record<string, { status: string; amount: number; amount_refunded: number }> = {
  PM00000000AA01: { status: "confirmed", amount: 2500, amount_refunded: 0 },
  PM00000000AA02: { status: "failed", amount: 2500, amount_refunded: 0 },
  PM00000000AA03: { status: "charged_back", amount: 4999, amount_refunded: 0 },
  PM00000000AA04: { status: "paid_out", amount: 2500, amount_refunded: 1000 },
  PM00000000AA05: { status: "failed", amount: 2500, amount_refunded: 0 },
};
const paymentRoutes: Route = (r) => {
  const m = new URL(r.url).pathname.match(/^\/payments\/(PM\w+)$/);
  if (r.method !== "GET" || !m || !PAYMENTS[m[1]!]) return undefined;
  return { status: 200, body: { payments: { id: m[1], currency: "GBP", ...PAYMENTS[m[1]!] } } };
};

const sign = (body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(body).digest("hex");

const gc = new GoCardlessProvider({
  accessToken: "sandbox_x",
  webhookSecret: SECRET,
  livemode: false,
  apiBase: BASE,
});

// ── 1. signature ────────────────────────────────────────────────────────────
async function signatures() {
  const body = JSON.stringify({
    events: [
      {
        id: "EV00000000SG01",
        created_at: "2026-10-24T10:00:00.000Z",
        resource_type: "payments",
        action: "submitted",
        links: { payment: "PM00000000AA09" },
        details: { origin: "gocardless", cause: "payment_submitted" },
      },
    ],
    meta: { webhook_id: "WB00000000SG01" },
  });
  ok("sig: a valid signature verifies", verifyGocardlessSignature(body, sign(body), SECRET));
  const accepted = await gc.normalizeWebhook({
    payload: body,
    headers: { "Webhook-Signature": sign(body) },
  });
  ok("sig: normalizeWebhook accepts a signed delivery", accepted.length === 1);
  const rejects = async (
    name: string,
    payload: string,
    headers: Record<string, string>,
    p = gc,
  ) => {
    try {
      await p.normalizeWebhook({ payload, headers });
      ok(name, false, "accepted");
    } catch {
      ok(name, true);
    }
  };
  await rejects(
    "sig: a tampered body is refused",
    body.replace("PM00000000AA09", "PM00000000AA08"),
    {
      "webhook-signature": sign(body),
    },
  );
  await rejects("sig: the wrong secret is refused", body, {
    "webhook-signature": sign(body, "another_secret"),
  });
  await rejects("sig: a missing header is refused", body, {});
  await rejects(
    "sig: no stored secret refuses every delivery",
    body,
    { "webhook-signature": sign(body) },
    new GoCardlessProvider({ accessToken: "x", livemode: false, apiBase: BASE }),
  );
}

// ── 2. a multi-event delivery ───────────────────────────────────────────────
const OURS = { tmbilling_ref: "pay_XXXXXXXXXXXX01" };
const evt = (
  id: string,
  resource_type: string,
  action: string,
  links: Record<string, string>,
  details: Record<string, unknown> = {},
  resource_metadata: Record<string, unknown> | undefined = OURS,
) => ({
  id,
  created_at: "2026-10-24T10:00:00.000Z",
  resource_type,
  action,
  links,
  details: { origin: "bank", ...details },
  ...(resource_metadata ? { resource_metadata } : {}),
});

async function batch() {
  routes = [
    paymentRoutes,
    // Lagging API: the mandate still reads active when the cancellation arrives.
    get("/mandates/MD00000000AA01", {
      mandates: { id: "MD00000000AA01", status: "active", scheme: "bacs" },
    }),
  ];
  const events = [
    evt(
      "EV00000000BT01",
      "payments",
      "confirmed",
      { payment: "PM00000000AA01" },
      { cause: "payment_confirmed" },
    ),
    evt(
      "EV00000000BT02",
      "payments",
      "failed",
      { payment: "PM00000000AA02" },
      {
        cause: "insufficient_funds",
        description: "The customer's account had insufficient funds.",
        scheme: "bacs",
        reason_code: "ARUDD-0",
      },
    ),
    evt(
      "EV00000000BT03",
      "payments",
      "charged_back",
      { payment: "PM00000000AA03" },
      { cause: "authorisation_disputed" },
    ),
    evt("EV00000000BT04", "payments", "chargeback_cancelled", { payment: "PM00000000AA03" }),
    evt(
      "EV00000000BT05",
      "payments",
      "paid_out",
      { payment: "PM00000000AA01" },
      { origin: "gocardless" },
    ),
    evt("EV00000000BT06", "refunds", "paid", {
      refund: "RF00000000AA01",
      payment: "PM00000000AA04",
    }),
    evt("EV00000000BT07", "refunds", "funds_returned", {
      refund: "RF00000000AA02",
      payment: "PM00000000AA04",
    }),
    evt(
      "EV00000000BT08",
      "mandates",
      "cancelled",
      { mandate: "MD00000000AA01" },
      { cause: "bank_account_closed" },
    ),
    evt("EV00000000BT09", "billing_requests", "fulfilled", {
      billing_request: "BRQ00000000AA1",
      mandate_request_mandate: "MD00000000AA02",
    }),
    evt("EV00000000BT10", "payouts", "paid", { payout: "PO00000000AA01" }),
    // Out of order: `confirmed` for a payment that has since failed.
    evt("EV00000000BT11", "payments", "confirmed", { payment: "PM00000000AA05" }),
    evt(
      "EV00000000BT12",
      "payments",
      "submitted",
      { payment: "PM00000000AA09" },
      {},
      { other_app: "x" },
    ),
  ];
  const body = JSON.stringify({ events, meta: { webhook_id: "WB00000000BT01" } });
  const out = await gc.normalizeWebhook({
    payload: body,
    headers: { "webhook-signature": sign(body) },
  });
  const by = (id: string) =>
    out.filter((e) => e.providerEventId === id || e.providerEventId.startsWith(`${id}:`));
  const one = (id: string): NormalizedProviderEvent | undefined => by(id)[0];

  ok(
    "batch: every event keeps its own EV id",
    new Set(out.map((e) => e.providerEventId)).size === out.length,
  );
  ok("batch: confirmed → charge.succeeded", one("EV00000000BT01")?.type === "charge.succeeded");
  ok(
    "batch: confirmed carries the payment id",
    one("EV00000000BT01")?.providerChargeId === "PM00000000AA01",
  );
  ok(
    "capturedAmountMinor: confirmed carries the amount from the payment read (minor units)",
    one("EV00000000BT01")?.capturedAmountMinor === 2500n,
  );
  ok(
    "capturedAmountMinor: unset on a confirmed event for a payment that since failed",
    one("EV00000000BT11")?.type === "charge.updated" &&
      one("EV00000000BT11")?.capturedAmountMinor === undefined,
  );
  ok(
    "batch: ownership is read from resource_metadata",
    one("EV00000000BT01")?.ownership === "ours" &&
      one("EV00000000BT01")?.ownershipRef === OURS.tmbilling_ref,
  );
  ok("batch: metadata without our tag is foreign", one("EV00000000BT12")?.ownership === "foreign");
  const f = one("EV00000000BT02");
  ok("batch: failed → charge.failed", f?.type === "charge.failed");
  ok(
    "batch: a bank failure is flagged as a reversal (late-failure path)",
    (f?.raw as { data?: { reversal?: boolean } })?.data?.reversal === true,
  );
  ok(
    "batch: failure code normalised from details.cause",
    f?.failureCode === "insufficient_funds" &&
      f?.providerFailureCode === "insufficient_funds" &&
      f?.failureRetriable === true,
  );
  const cb = by("EV00000000BT03");
  ok(
    "batch: charged_back → dispute.created + dispute.funds_withdrawn",
    cb.map((e) => e.type).join(",") === "dispute.created,dispute.funds_withdrawn",
  );
  ok(
    "batch: chargeback amount read from the payment",
    cb[0]?.disputeAmountMinor === 4999n && cb[0]?.disputeCurrency === "GBP",
  );
  ok(
    "batch: one dispute id per payment",
    cb.every((e) => e.providerDisputeId === "PM00000000AA03:chargeback") &&
      one("EV00000000BT04")?.providerDisputeId === "PM00000000AA03:chargeback",
  );
  ok(
    "batch: chargeback_cancelled → dispute.funds_reinstated",
    one("EV00000000BT04")?.type === "dispute.funds_reinstated",
  );
  ok(
    "batch: paid_out is persist-only (charge.updated)",
    one("EV00000000BT05")?.type === "charge.updated",
  );
  const rp = one("EV00000000BT06");
  ok(
    "batch: refunds.paid → charge.refunded with the running total",
    rp?.type === "charge.refunded" &&
      rp?.amountRefundedMinor === 1000n &&
      rp?.providerRefundId === "RF00000000AA01",
  );
  ok(
    "batch: refunds.funds_returned → refund.failed",
    one("EV00000000BT07")?.type === "refund.failed",
  );
  const md = one("EV00000000BT08");
  ok(
    "batch: mandate event → the event's status wins over a lagging mandate read",
    md?.type === "payment_method.mandate_updated" &&
      md?.mandate?.status === "cancelled" &&
      md?.providerPaymentMethodId === "MD00000000AA01",
    JSON.stringify(md?.mandate),
  );
  const br = one("EV00000000BT09");
  ok(
    "batch: billing_requests.fulfilled → intent.setup_succeeded",
    br?.type === "intent.setup_succeeded" &&
      br?.providerIntentId === "BRQ00000000AA1" &&
      br?.providerPaymentMethodId === "MD00000000AA02",
  );
  ok(
    "batch: an unmapped resource is persisted as unknown",
    one("EV00000000BT10")?.type === "unknown",
  );
  ok(
    "batch: confirmed after a failure does not settle",
    one("EV00000000BT11")?.type === "charge.updated",
  );

  const single = gc.webhookEventId({
    payload: JSON.stringify({ events: [events[0]] }),
    headers: {},
  });
  const a = gc.webhookEventId({ payload: body, headers: {} });
  const reordered = JSON.stringify({
    events: [...events].reverse(),
    meta: { webhook_id: "WB00000000BT02" },
  });
  ok("id: a one-event delivery is deduped by its event id", single === "EV00000000BT01");
  ok(
    "id: a batch id is stable across a redelivery in another order",
    a === gc.webhookEventId({ payload: reordered, headers: {} }),
  );
  ok(
    "id: different batches get different ids",
    a !== gc.webhookEventId({ payload: JSON.stringify({ events: events.slice(1) }), headers: {} }),
  );
}

// ── 3. status → ChargeResult ────────────────────────────────────────────────
function statusMapping() {
  const s = (status: string) => gocardlessPaymentResult({ id: "PM00000000AA01", status }).status;
  for (const p of ["pending_customer_approval", "pending_submission", "submitted"])
    ok(`status: ${p} → pending`, s(p) === "pending");
  for (const p of ["confirmed", "paid_out", "charged_back"])
    ok(`status: ${p} → succeeded`, s(p) === "succeeded");
  for (const p of ["failed", "cancelled", "customer_approval_denied"])
    ok(`status: ${p} → failed`, s(p) === "failed");
  const read = gocardlessPaymentResult(
    { id: "PM00000000AA04", status: "cancelled" },
    { cause: "payment_cancelled" },
  );
  ok(
    "status: cancelled at your request reads as debit_cancelled, not retriable",
    read.failure?.code === "debit_cancelled" && read.failure.retriable === false,
  );
  const used = (scheme: string | undefined) =>
    gocardlessPaymentResult({ id: "PM00000000AA03", status: "confirmed", scheme }).methodUsed;
  ok(
    "status: methodUsed names the scheme; no scheme, none",
    used("sepa_core") === "sepa_debit" &&
      used("ach") === "us_bank_account" &&
      used("becs") === "au_becs_debit" &&
      used("pad") === "acss_debit" &&
      used("becs_nz") === "nz_becs_debit" &&
      used("autogiro") === "autogiro" &&
      used("betalingsservice") === "betalingsservice" &&
      used("pay_to") === "payto" &&
      used("faster_payments") === undefined &&
      used(undefined) === undefined,
  );
  const late = gocardlessPaymentResult(
    { id: "PM00000000AA02", status: "failed" },
    { cause: "bank_account_closed" },
  );
  ok(
    "status: a failure carries the normalised cause",
    late.failure?.code === "bank_account_closed" && late.failure.retriable === false,
  );
  ok(
    "refund: paid → succeeded, funds_returned → failed, submitted → pending",
    gocardlessRefundStatus("paid") === "succeeded" &&
      gocardlessRefundStatus("funds_returned") === "failed" &&
      gocardlessRefundStatus("bounced") === "failed" &&
      gocardlessRefundStatus("submitted") === "pending",
  );
  ok(
    "mandate: pending_submission → initiated, active → active, suspended → paused, expired → cancelled",
    normalizeGocardlessMandateStatus("pending_submission") === "initiated" &&
      normalizeGocardlessMandateStatus("active") === "active" &&
      normalizeGocardlessMandateStatus("suspended_by_payer") === "paused" &&
      normalizeGocardlessMandateStatus("expired") === "cancelled" &&
      normalizeGocardlessMandateStatus("replaced") === undefined,
  );
}

// ── 4. late failure event, explicit ─────────────────────────────────────────
async function lateFailure() {
  routes = [paymentRoutes];
  const [lf] = await gc.mapEvent(
    evt(
      "EV00000000LF01",
      "payments",
      "late_failure",
      { payment: "PM00000000AA02" },
      { cause: "refer_to_payer" },
    ),
  );
  ok(
    "late: a late_failure action reaches the reversal path",
    lf?.type === "charge.failed" &&
      (lf.raw as { data?: { reversal?: boolean } }).data?.reversal === true,
  );
  const [cancelled] = await gc.mapEvent(
    evt(
      "EV00000000LF02",
      "payments",
      "cancelled",
      { payment: "PM00000000AA02" },
      { origin: "api", cause: "payment_cancelled" },
    ),
  );
  ok(
    "late: a cancellation is a plain failure, not a reversal",
    cancelled?.type === "charge.failed" && !(cancelled.raw as { data?: unknown }).data,
  );
  ok(
    "cancel: payment_cancelled is a debit stopped before collection, not a decline",
    cancelled?.type === "charge.failed" &&
      cancelled.failureCode === "debit_cancelled" &&
      cancelled.failureRetriable === false,
  );
  const [mandateGone] = await gc.mapEvent(
    evt(
      "EV00000000LF03",
      "payments",
      "cancelled",
      { payment: "PM00000000AA02" },
      { origin: "bank", cause: "mandate_cancelled" },
    ),
  );
  ok(
    "cancel: a payment cancelled with its mandate stays a decline",
    mandateGone?.type === "charge.failed" && mandateGone.failureCode !== "debit_cancelled",
  );
}

// ── 5. decline mapping ──────────────────────────────────────────────────────
function declines() {
  const d = normalizeGocardlessDecline;
  ok(
    "decline: insufficient_funds retries",
    d("insufficient_funds").code === "insufficient_funds" && d("insufficient_funds").retriable,
  );
  ok(
    "decline: refer_to_payer reads as insufficient funds",
    d("refer_to_payer").code === "insufficient_funds",
  );
  ok(
    "decline: bank_account_closed is terminal",
    d("bank_account_closed").code === "bank_account_closed" && !d("bank_account_closed").retriable,
  );
  ok(
    "decline: invalid_bank_details is terminal",
    d("invalid_bank_details").code === "bank_account_invalid_details" &&
      !d("invalid_bank_details").retriable,
  );
  ok(
    "decline: authorisation_disputed → debit_not_authorized",
    d("authorisation_disputed").code === "debit_not_authorized" &&
      !d("authorisation_disputed").retriable,
  );
  ok(
    "decline: mandate_cancelled → revocation",
    d("mandate_cancelled").code === "revocation_of_authorization" &&
      !d("mandate_cancelled").retriable,
  );
  ok(
    "decline: mandate_is_inactive (create) → mandate_expired",
    d("mandate_is_inactive").code === "mandate_expired",
  );
  ok(
    "decline: validation_failed is ours, hidden from the payer",
    d("validation_failed").code === "gateway_request_rejected" &&
      d("validation_failed").exposedToPayer === false,
  );
  ok(
    "decline: an unknown cause passes through retriable",
    d("some_new_cause").code === "some_new_cause" && d("some_new_cause").retriable,
  );
}

// ── 6. capabilities + request shapes ────────────────────────────────────────
async function capabilitiesAndRequests() {
  const c = gc.capabilities;
  ok(
    "cap: methods are every GoCardless scheme we map",
    c.methods.join(",") ===
      "bacs_debit,sepa_debit,us_bank_account,au_becs_debit,nz_becs_debit,acss_debit,autogiro,betalingsservice,payto",
    c.methods.join(","),
  );
  ok(
    "cap: currencies GBP, EUR, USD, AUD, NZD, CAD, SEK, DKK",
    c.currencies.join(",") === "GBP,EUR,USD,AUD,NZD,CAD,SEK,DKK",
    c.currencies.join(","),
  );
  ok(
    "cap: setup intents only, no void",
    c.intents === true && c.intentPurposes?.join(",") === "setup" && c.intentVoid === false,
  );
  ok("cap: no per-debit ceiling (mandates false)", c.mandates === false);
  ok(
    "cap: GoCardless notifies the payer on every Direct Debit rail, not on PayTo",
    c.gatewayNotifiesPayer?.join(",") === c.methods.filter((m) => m !== "payto").join(","),
  );
  ok(
    "cap: events backstop declared and implemented",
    !!c.settlementReport && typeof gc.pollSettlements === "function",
  );
  ok("cap: refunds, partial refunds", c.refunds && c.partialRefunds);
  ok(
    "cap: no intentStatus probe, no provisioning API",
    c.intentStatus === undefined && (gc as PaymentProvider).provisionWebhookEndpoint === undefined,
  );
  const def = GATEWAYS.gocardless;
  ok(
    "catalog: operator-pasted secret, async settlement",
    def.webhook.secret === "operator_pasted" && def.settlement.alwaysAsync === true,
  );
  ok(
    "catalog: advertised methods equal the adapter's",
    [...def.advertisedMethods].join(",") === c.methods.join(","),
  );

  // Host follows livemode.
  routes = [
    get("/creditors", {
      creditors: [{ id: "CR00000000AA01", country_code: "GB", can_create_refunds: false }],
    }),
  ];
  for (const live of [false, true]) {
    seen.length = 0;
    const a = GATEWAY_FACTORIES.gocardless.build(
      { access_token: "x" },
      { businessId: "b", livemode: live },
    );
    await a.healthCheck?.();
    const host = live ? GOCARDLESS_LIVE_BASE : GOCARDLESS_SANDBOX_BASE;
    ok(
      `factory: livemode=${live} talks to ${host}`,
      seen[0]?.url.startsWith(host) === true,
      seen[0]?.url,
    );
    ok(
      `factory: sends the version header and a bearer token`,
      seen[0]?.headers["gocardless-version"] === "2015-07-06" &&
        seen[0]?.headers.authorization === "Bearer x",
    );
  }

  const charge = {
    amountMinor: 2500n,
    currency: "gbp",
    customer: { providerKey: "gocardless" as const, providerCustomerId: "CU00000000AA01" },
    paymentMethod: {
      providerKey: "gocardless" as const,
      providerPaymentMethodId: "MD00000000AA01",
      display: { type: "bacs_debit" as const },
    },
    idempotencyKey: "inv_XXXXXXXXXXXX01_attempt_1_pm_XXXXXXXXXXXX01",
    ownershipRef: "pay_XXXXXXXXXXXX02",
  };
  seen.length = 0;
  routes = [
    (r) =>
      r.method === "POST" && r.url.endsWith("/payments")
        ? {
            status: 201,
            body: {
              payments: { id: "PM00000000CH01", status: "pending_submission", scheme: "bacs" },
            },
          }
        : undefined,
  ];
  const r1 = await gc.charge(charge);
  const sent = seen[0]?.body as { payments?: Record<string, unknown> };
  ok(
    "charge: answers pending with the payment id",
    r1.status === "pending" && r1.providerChargeId === "PM00000000CH01",
  );
  ok("charge: methodUsed from the payment's scheme", r1.methodUsed === "bacs_debit");
  ok("charge: gateway-side retries are off", sent?.payments?.retry_if_possible === false);
  ok(
    "charge: amount in minor units, upper-case currency, mandate link",
    sent?.payments?.amount === 2500 &&
      sent?.payments?.currency === "GBP" &&
      (sent?.payments?.links as { mandate?: string })?.mandate === "MD00000000AA01",
  );
  ok(
    "charge: tagged with our ownershipRef",
    (sent?.payments?.metadata as Record<string, string>)?.tmbilling_ref === "pay_XXXXXXXXXXXX02",
  );
  ok("charge: Idempotency-Key sent", seen[0]?.headers["idempotency-key"] === charge.idempotencyKey);
  ok(
    "charge: no due date → no mandate read, no charge_date",
    !("charge_date" in (sent?.payments ?? {})) && seen.length === 1,
  );

  // Collect on the invoice's due day when the mandate's notice period ends by then.
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const bacsM = { scheme: "bacs", next_possible_charge_date: day(3) };
  ok(
    "charge date: due on or after the next possible date → the due date; before → none",
    gocardlessChargeDate(day(20), bacsM)?.charge_date === day(20) &&
      gocardlessChargeDate(day(3), bacsM)?.charge_date === day(3) &&
      gocardlessChargeDate(day(2), bacsM) === undefined &&
      gocardlessChargeDate(undefined, bacsM) === undefined &&
      gocardlessChargeDate(day(20), bacsM)?.faster_ach === undefined,
  );
  const achM = {
    scheme: "ach",
    next_possible_charge_date: day(2),
    next_possible_standard_ach_charge_date: day(5),
  };
  ok(
    "charge date (ACH): judged against the standard ACH date, and asks for standard ACH",
    gocardlessChargeDate(day(4), achM) === undefined &&
      gocardlessChargeDate(day(20), achM)?.charge_date === day(20) &&
      gocardlessChargeDate(day(20), achM)?.faster_ach === false,
    JSON.stringify(gocardlessChargeDate(day(4), achM)),
  );
  const created: Route = (r) =>
    r.method === "POST" && r.url.endsWith("/payments")
      ? { status: 201, body: { payments: { id: "PM00000000CH02", status: "pending_submission" } } }
      : undefined;
  const mandate = (status = 200, extra: Record<string, unknown> = {}): Route =>
    get(
      "/mandates/MD00000000AA01",
      status < 300
        ? {
            mandates: {
              id: "MD00000000AA01",
              status: "active",
              scheme: "bacs",
              next_possible_charge_date: day(3),
              ...extra,
            },
          }
        : { error: { message: "boom", code: status } },
      status,
    );
  const postedAll = () =>
    seen
      .filter((s) => s.method === "POST")
      .map((s) => (s.body as { payments?: Record<string, unknown> })?.payments);
  const posted = () => postedAll()[0];
  seen.length = 0;
  routes = [mandate(), created];
  const far = await gc.charge({ ...charge, invoiceDueDate: day(20) });
  ok(
    "charge: due date past the notice period → charge_date = due date (mandate read first)",
    far.status === "pending" &&
      posted()?.charge_date === day(20) &&
      !("faster_ach" in (posted() ?? {})) &&
      seen[0]?.method === "GET" &&
      seen[0].url.endsWith("/mandates/MD00000000AA01"),
    JSON.stringify(posted()),
  );
  seen.length = 0;
  routes = [
    mandate(200, {
      scheme: "ach",
      next_possible_charge_date: day(2),
      next_possible_standard_ach_charge_date: day(5),
    }),
    created,
  ];
  await gc.charge({ ...charge, currency: "usd", invoiceDueDate: day(20) });
  ok(
    "charge (ACH): a dated payment sends faster_ach: false",
    posted()?.charge_date === day(20) && posted()?.faster_ach === false,
    JSON.stringify(posted()),
  );
  seen.length = 0;
  routes = [mandate(), created];
  await gc.charge({ ...charge, invoiceDueDate: day(2) });
  ok(
    "charge: due date inside the notice period → as soon as possible",
    !("charge_date" in (posted() ?? {})),
  );
  seen.length = 0;
  await gc.charge({ ...charge, invoiceDueDate: day(-5) });
  ok(
    "charge: due date passed → as soon as possible, no mandate read",
    !("charge_date" in (posted() ?? {})) && seen.every((s) => s.method === "POST"),
  );
  seen.length = 0;
  routes = [mandate(500), created];
  const unread = await gc.charge({ ...charge, invoiceDueDate: day(20) });
  ok(
    "charge: mandate read fails → still charged, as soon as possible",
    unread.status === "pending" && !("charge_date" in (posted() ?? {})),
  );
  // GoCardless refuses the date: collect as soon as possible instead of failing the debit.
  seen.length = 0;
  let datePosts = 0;
  routes = [
    mandate(),
    (r) => {
      if (r.method !== "POST" || !r.url.endsWith("/payments")) return undefined;
      datePosts++;
      const body = (r.body as { payments: Record<string, unknown> }).payments;
      return body.charge_date
        ? {
            status: 422,
            body: {
              error: {
                type: "validation_failed",
                code: 422,
                errors: [{ field: "charge_date", message: "must be on or after 2026-11-02" }],
              },
            },
          }
        : {
            status: 201,
            body: { payments: { id: "PM00000000CH03", status: "pending_submission" } },
          };
    },
  ];
  const refusedDate = await gc.charge({ ...charge, invoiceDueDate: day(20) });
  ok(
    "charge: a refused charge_date is retried once without it (same key)",
    refusedDate.status === "pending" &&
      refusedDate.providerChargeId === "PM00000000CH03" &&
      datePosts === 2 &&
      !("charge_date" in (postedAll()[1] ?? {})) &&
      seen
        .filter((x) => x.method === "POST")
        .every((x) => x.headers["idempotency-key"] === charge.idempotencyKey),
    `posts=${datePosts}`,
  );

  routes = [
    (r) =>
      r.method === "POST" && r.url.endsWith("/payments")
        ? {
            status: 409,
            body: {
              error: {
                type: "invalid_state",
                code: 409,
                errors: [
                  {
                    reason: "idempotent_creation_conflict",
                    message: "exists",
                    links: { conflicting_resource_id: "PM00000000CH01" },
                  },
                ],
              },
            },
          }
        : undefined,
    get("/payments/PM00000000CH01", { payments: { id: "PM00000000CH01", status: "submitted" } }),
  ];
  const r2 = await gc.charge(charge);
  ok(
    "charge: a 409 replay returns the existing payment",
    r2.status === "pending" && r2.providerChargeId === "PM00000000CH01",
  );

  let posts = 0;
  routes = [
    (r) =>
      r.method === "POST" && r.url.endsWith("/payments")
        ? (posts++, { status: 503, body: { error: { type: "gocardless", code: 503 } } })
        : undefined,
  ];
  try {
    await gc.charge(charge);
    ok("charge: repeated 5xx is indeterminate, never failed", false, "returned");
  } catch (e) {
    ok(
      "charge: repeated 5xx is indeterminate, never failed",
      e instanceof ProviderIndeterminateError,
    );
  }
  ok("charge: a 5xx is retried once under the same key", posts === 2);

  routes = [
    (r) =>
      r.method === "POST" && r.url.endsWith("/payments")
        ? {
            status: 422,
            body: {
              error: {
                type: "invalid_state",
                code: 422,
                errors: [{ reason: "mandate_is_inactive", message: "inactive" }],
              },
            },
          }
        : undefined,
  ];
  const r3 = await gc.charge(charge);
  ok(
    "charge: an inactive mandate is a failed charge, mandate_expired",
    r3.status === "failed" &&
      r3.failure?.code === "mandate_expired" &&
      r3.failure.providerCode === "mandate_is_inactive",
  );

  seen.length = 0;
  routes = [
    paymentRoutes,
    (r) =>
      r.method === "POST" && r.url.endsWith("/refunds")
        ? { status: 201, body: { refunds: { id: "RF00000000CH01", status: "created" } } }
        : undefined,
  ];
  const rf = await gc.refund({
    providerChargeId: "PM00000000AA04",
    amountMinor: 500n,
    idempotencyKey: "cn_XXXXXXXXXXXX01",
  });
  const rbody = seen.find((s) => s.method === "POST")?.body as {
    refunds?: Record<string, unknown>;
  };
  ok(
    "refund: total_amount_confirmation = prior refunds + this one",
    rbody?.refunds?.total_amount_confirmation === 1500 && rbody?.refunds?.amount === 500,
  );
  ok(
    "refund: created → pending",
    rf.status === "pending" && rf.providerRefundId === "RF00000000CH01",
  );

  // Events backstop: two pages, unknown events dropped.
  let page = 0;
  routes = [
    (r) => {
      if (r.method !== "GET" || !new URL(r.url).pathname.startsWith("/events")) return undefined;
      page++;
      const after = new URL(r.url).searchParams.get("after");
      return {
        status: 200,
        body: after
          ? {
              events: [
                evt("EV00000000PL02", "payments", "submitted", { payment: "PM00000000AA09" }),
              ],
              meta: { cursors: { after: null } },
            }
          : {
              events: [
                evt("EV00000000PL01", "payouts", "paid", { payout: "PO00000000AA01" }),
                evt("EV00000000PL03", "refunds", "created", {
                  refund: "RF00000000AA03",
                  payment: "PM00000000AA04",
                }),
              ],
              meta: { cursors: { after: "EV00000000PL01" } },
            },
      };
    },
  ];
  const polled = await gc.pollSettlements({
    since: new Date("2026-10-24T00:00:00Z"),
    until: new Date("2026-10-24T12:00:00Z"),
  });
  ok(
    "poll: follows the cursor and drops unmapped events",
    page === 2 &&
      polled.map((e) => e.providerEventId).join(",") === "EV00000000PL03,EV00000000PL02",
  );
}

// ── 7. audit fixes: mandates, 429, refunds, region, settled events ─────────
async function auditFixes() {
  const signed = (events: unknown[]) => {
    const payload = JSON.stringify({ events, meta: { webhook_id: "WB00000000AF01" } });
    return { payload, headers: { "webhook-signature": sign(payload) } };
  };
  const bankRoute = (id: string, ending: string, name: string) =>
    get(`/customer_bank_accounts/${id}`, {
      customer_bank_accounts: {
        id,
        account_number_ending: ending,
        bank_name: name,
        country_code: "GB",
      },
    });

  // Mandate events: the action wins, and no read is needed for it.
  seen.length = 0;
  routes = [
    get("/mandates/MD00000000MA01", {
      mandates: { id: "MD00000000MA01", status: "cancelled", scheme: "bacs" },
    }),
  ];
  const [reinstated] = await gc.mapEvent(
    evt("EV00000000MA01", "mandates", "reinstated", { mandate: "MD00000000MA01" }),
  );
  ok(
    "mandate: reinstated → active, even while the API still reads cancelled",
    reinstated?.mandate?.status === "active",
    JSON.stringify(reinstated?.mandate),
  );
  const [expired] = await gc.mapEvent(
    evt("EV00000000MA02", "mandates", "expired", { mandate: "MD00000000MA01" }),
  );
  ok(
    "mandate: a state event makes no mandate read",
    expired?.mandate?.status === "cancelled" && !seen.some((x) => x.url.includes("/mandates/")),
    seen.map((x) => x.url).join(","),
  );

  // replaced: the method moves to the new mandate, with its own status and bank display.
  seen.length = 0;
  routes = [
    get("/mandates/MD00000000NW01", {
      mandates: {
        id: "MD00000000NW01",
        status: "active",
        scheme: "bacs",
        reference: "REF-NEW",
        links: { customer: "CU00000000AA01", customer_bank_account: "BA00000000NW01" },
      },
    }),
    bankRoute("BA00000000NW01", "11", "BARCLAYS"),
  ];
  const [replaced] = await gc.mapEvent(
    evt(
      "EV00000000MR01",
      "mandates",
      "replaced",
      { mandate: "MD00000000OL01", new_mandate: "MD00000000NW01" },
      { origin: "gocardless", cause: "scheme_identifier_changed" },
    ),
  );
  ok(
    "mandate: replaced → re-point to links.new_mandate (not a cancel)",
    replaced?.type === "payment_method.mandate_updated" &&
      replaced.providerPaymentMethodId === "MD00000000OL01" &&
      replaced.replacementPaymentMethodId === "MD00000000NW01" &&
      replaced.mandate?.status === "active" &&
      replaced.mandate?.reference === "REF-NEW" &&
      replaced.paymentMethodDisplay?.last4 === "11" &&
      replaced.paymentMethodDisplay?.issuerName === "BARCLAYS",
    JSON.stringify({ r: replaced?.replacementPaymentMethodId, m: replaced?.mandate }),
  );

  // transferred: same mandate, new bank account → the display is refreshed.
  routes = [
    get("/mandates/MD00000000TR01", {
      mandates: {
        id: "MD00000000TR01",
        status: "active",
        scheme: "bacs",
        links: { customer: "CU00000000AA01", customer_bank_account: "BA00000000TR02" },
      },
    }),
    bankRoute("BA00000000TR02", "77", "HSBC UK"),
  ];
  const [transferred] = await gc.mapEvent(
    evt(
      "EV00000000TR01",
      "mandates",
      "transferred",
      {
        mandate: "MD00000000TR01",
        previous_customer_bank_account: "BA00000000TR01",
        new_customer_bank_account: "BA00000000TR02",
      },
      { origin: "bank", cause: "bank_account_transferred" },
    ),
  );
  ok(
    "mandate: transferred → active with the new bank's display",
    transferred?.type === "payment_method.mandate_updated" &&
      transferred.mandate?.status === "active" &&
      transferred.paymentMethodDisplay?.last4 === "77" &&
      transferred.paymentMethodDisplay?.issuerName === "HSBC UK" &&
      transferred.replacementPaymentMethodId === undefined,
    JSON.stringify(transferred?.paymentMethodDisplay),
  );

  // A create refused with mandate_replaced is retried once on the new mandate.
  const charge = {
    amountMinor: 2500n,
    currency: "gbp",
    customer: { providerKey: "gocardless" as const, providerCustomerId: "CU00000000AA01" },
    paymentMethod: {
      providerKey: "gocardless" as const,
      providerPaymentMethodId: "MD00000000OL01",
      display: { type: "bacs_debit" as const },
    },
    idempotencyKey: "inv_XXXXXXXXXXXX03_attempt_1_pm_XXXXXXXXXXXX03",
    ownershipRef: "inv_XXXXXXXXXXXX03",
  };
  seen.length = 0;
  routes = [
    (r) => {
      if (r.method !== "POST" || !r.url.endsWith("/payments")) return undefined;
      const m = (r.body as { payments: { links: { mandate: string } } }).payments.links.mandate;
      return m === "MD00000000OL01"
        ? {
            status: 422,
            body: {
              error: {
                type: "invalid_state",
                code: 422,
                errors: [
                  {
                    reason: "mandate_replaced",
                    message: "replaced",
                    links: { new_mandate: "MD00000000NW01" },
                  },
                ],
              },
            },
          }
        : {
            status: 201,
            body: { payments: { id: "PM00000000RP01", status: "pending_submission" } },
          };
    },
  ];
  const onNew = await gc.charge(charge);
  ok(
    "charge: mandate_replaced → retried on the new mandate under the same key",
    onNew.status === "pending" &&
      onNew.providerChargeId === "PM00000000RP01" &&
      seen.filter((x) => x.method === "POST").length === 2 &&
      seen.every(
        (x) => x.method !== "POST" || x.headers["idempotency-key"] === charge.idempotencyKey,
      ),
    `${onNew.status} ${onNew.failure?.code ?? ""}`,
  );

  // 429: wait for ratelimit-reset, retry once, then a definite (retriable) refusal.
  const waits: number[] = [];
  const gcRl = new GoCardlessProvider({
    accessToken: "sandbox_x",
    webhookSecret: SECRET,
    livemode: false,
    apiBase: BASE,
    sleep: async (ms) => void waits.push(ms),
  });
  const limited =
    (count: { n: number }): Route =>
    (r) =>
      r.method === "POST" && r.url.endsWith("/payments")
        ? (count.n++,
          {
            status: 429,
            body: {
              error: {
                type: "invalid_api_usage",
                code: 429,
                errors: [{ reason: "rate_limit_exceeded", message: "slow down" }],
              },
            },
            headers: { "ratelimit-reset": new Date(Date.now() + 5_000).toUTCString() },
          })
        : undefined;
  const c429 = { n: 0 };
  routes = [limited(c429)];
  let rl: Awaited<ReturnType<typeof gcRl.charge>> | Error;
  try {
    rl = await gcRl.charge({
      ...charge,
      paymentMethod: { ...charge.paymentMethod, providerPaymentMethodId: "MD00000000NW01" },
    });
  } catch (e) {
    rl = e as Error;
  }
  ok(
    "429: charge waits for ratelimit-reset, retries once, then fails definitely and retriably",
    !(rl instanceof Error) &&
      rl.status === "failed" &&
      rl.failure?.retriable === true &&
      c429.n === 2 &&
      waits.length === 1 &&
      waits[0]! > 0 &&
      waits[0]! <= 60_000,
    rl instanceof Error
      ? `threw ${rl.name}`
      : `${rl.status} ${rl.failure?.code} posts=${c429.n} waits=${waits.join(",")}`,
  );
  let n5 = 0;
  routes = [
    (r) =>
      r.method === "POST" && r.url.endsWith("/payments")
        ? ++n5 === 1
          ? { status: 503, body: { error: { code: 503 } } }
          : {
              status: 429,
              body: { error: { code: 429, errors: [{ reason: "rate_limit_exceeded" }] } },
            }
        : undefined,
  ];
  let after5xx: unknown;
  try {
    await gcRl.charge(charge);
  } catch (e) {
    after5xx = e;
  }
  ok(
    "429 after a 5xx stays indeterminate (the first attempt may have created it)",
    after5xx instanceof ProviderIndeterminateError,
  );
  const r429 = { n: 0 };
  routes = [
    paymentRoutes,
    (r) =>
      r.method === "POST" && r.url.endsWith("/refunds")
        ? (r429.n++,
          {
            status: 429,
            body: { error: { code: 429, errors: [{ reason: "rate_limit_exceeded" }] } },
          })
        : undefined,
  ];
  let refund429: unknown;
  try {
    await gcRl.refund({
      providerChargeId: "PM00000000AA01",
      amountMinor: 100n,
      idempotencyKey: "cn_XXXXXXXXXXXX02",
    });
  } catch (e) {
    refund429 = e;
  }
  ok(
    "429: a refund is a refusal (reservation released), never indeterminate",
    refund429 instanceof ProviderRefusalError &&
      /Try again in 1 minute/.test((refund429 as Error).message),
    String(refund429),
  );
  let reads = 0;
  routes = [
    (r) =>
      r.method === "GET" && r.url.endsWith("/payments/PM00000000RL01")
        ? ++reads === 1
          ? { status: 429, body: { error: { code: 429 } } }
          : { status: 200, body: { payments: { id: "PM00000000RL01", status: "confirmed" } } }
        : undefined,
  ];
  const readBack = await gcRl
    .fetchChargeStatus({ providerChargeId: "PM00000000RL01" })
    .catch((e: Error) => e);
  ok(
    "429: a read is retried once after the wait",
    !(readBack instanceof Error) && readBack.status === "succeeded" && reads === 2,
    readBack instanceof Error ? readBack.message : "",
  );

  // Refund pre-read failure: nothing was sent, so it is a refusal.
  let preRead: unknown;
  seen.length = 0;
  routes = [get("/payments/PM00000000ZZ01", { error: { code: 500, message: "boom" } }, 500)];
  try {
    await gc.refund({
      providerChargeId: "PM00000000ZZ01",
      amountMinor: 100n,
      idempotencyKey: "cn_XXXXXXXXXXXX03",
    });
  } catch (e) {
    preRead = e;
  }
  ok(
    "refund: a failed payment read is a refusal (nothing sent), not a plain error",
    preRead instanceof ProviderRefusalError && !seen.some((x) => x.method === "POST"),
    String(preRead),
  );

  // Refund refusals the operator can act on.
  const refuse = async (status: number, error: unknown) => {
    routes = [
      paymentRoutes,
      (r) =>
        r.method === "POST" && r.url.endsWith("/refunds") ? { status, body: { error } } : undefined,
    ];
    try {
      await gc.refund({
        providerChargeId: "PM00000000AA01",
        amountMinor: 100n,
        idempotencyKey: "cn_XXXXXXXXXXXX04",
      });
      return "accepted";
    } catch (e) {
      return e instanceof ProviderRefusalError ? e.message : `not a refusal: ${String(e)}`;
    }
  };
  const period = await refuse(422, {
    type: "invalid_state",
    code: 422,
    errors: [
      {
        reason: "feature_disabled",
        message: "refunds are not possible yet",
        metadata: { no_of_days_until_refund_possible: 4 },
      },
    ],
  });
  ok(
    "refund: the 7-day safer period names the days left, not 'refunds not enabled'",
    /7 days after its charge date/.test(period) &&
      /in 4 days/.test(period) &&
      !/not enabled/.test(period),
    period,
  );
  const balance = await refuse(422, {
    type: "validation_failed",
    code: 422,
    errors: [
      {
        reason: "available_refund_amount_insufficient",
        message: "not enough funds",
        metadata: { available_refund_amount: -1495 },
      },
    ],
  });
  ok(
    "refund: available_refund_amount_insufficient names the available amount",
    /-14\.95 GBP/.test(balance),
    balance,
  );
  const disabled = await refuse(403, {
    type: "invalid_api_usage",
    code: 403,
    errors: [{ reason: "forbidden", message: "forbidden" }],
  });
  ok(
    "refund: refunds disabled → Dashboard and support",
    /GoCardless Dashboard/.test(disabled) && /support/.test(disabled),
    disabled,
  );

  // US region: a 2-letter state code, or nothing.
  const geo = JSON.parse(readFileSync("db/seed-data/geo.json", "utf8"));
  primeGeoReference({
    countries: geo.countries,
    subdivisions: geo.subdivisions,
    aliases: geo.aliases ?? [],
  });
  ok(
    "customer: US region → 2-letter state code; unresolvable → omitted; non-US unchanged",
    gocardlessRegion("California", "US") === "CA" &&
      gocardlessRegion("us-ny", "US") === "NY" &&
      gocardlessRegion("tx", "us") === "TX" &&
      gocardlessRegion("Atlantis", "US") === undefined &&
      gocardlessRegion("Bavaria", "DE") === "Bavaria",
  );
  seen.length = 0;
  routes = [
    (r) =>
      r.method === "POST" && r.url.endsWith("/customers")
        ? { status: 201, body: { customers: { id: "CU00000000RG01" } } }
        : undefined,
  ];
  await gc.ensureCustomer({
    customerRef: "cus_XXXXXXXXXXXX05",
    name: "Pat Payer",
    email: "payer@example.com",
    address: {
      line1: "1 Main St",
      city: "Austin",
      postalCode: "73301",
      state: "Texas",
      country: "US",
    },
  });
  ok(
    "customer: a full US state name is sent as its code",
    (seen[0]?.body as { customers?: { region?: string } })?.customers?.region === "TX",
    JSON.stringify(seen[0]?.body),
  );

  // Refund events link only the refund (measured live): the payment comes from the refund.
  seen.length = 0;
  routes = [
    paymentRoutes,
    get("/refunds/RF00000000LK01", {
      refunds: { id: "RF00000000LK01", status: "paid", links: { payment: "PM00000000AA04" } },
    }),
  ];
  const [paidOnly] = await gc.mapEvent(
    evt("EV00000000RL01", "refunds", "paid", { refund: "RF00000000LK01" }),
  );
  ok(
    "refund event: links only the refund → the payment is read from it, with the running total",
    paidOnly?.type === "charge.refunded" &&
      paidOnly.providerChargeId === "PM00000000AA04" &&
      paidOnly.amountRefundedMinor === 1000n,
    JSON.stringify({ c: paidOnly?.providerChargeId, t: String(paidOnly?.amountRefundedMinor) }),
  );

  // Settled events: answered from the dedup, without gateway reads.
  seen.length = 0;
  routes = [paymentRoutes];
  const batchEvents = [
    evt("EV00000000ST01", "payments", "confirmed", { payment: "PM00000000AA01" }),
    evt("EV00000000ST02", "payments", "charged_back", { payment: "PM00000000AA03" }),
    evt("EV00000000ST03", "refunds", "paid", {
      refund: "RF00000000AA01",
      payment: "PM00000000AA04",
    }),
  ];
  const asked: string[][] = [];
  const out = await gc.normalizeWebhook({
    ...signed(batchEvents),
    settledEventIds: async (ids) => {
      asked.push(ids);
      return new Set([
        "EV00000000ST01",
        "EV00000000ST02",
        "EV00000000ST02:funds_withdrawn",
        "EV00000000ST03",
      ]);
    },
  });
  ok(
    "webhook: settled event ids make no gateway reads",
    seen.length === 0 && out.length === 3 && asked.length === 1,
    `reads=${seen.map((x) => x.url).join(",")} out=${out.length}`,
  );
  seen.length = 0;
  const partial = await gc.normalizeWebhook({
    ...signed(batchEvents),
    settledEventIds: async () => new Set(["EV00000000ST01"]),
  });
  ok(
    "webhook: unsettled events are still mapped, in order",
    partial.map((e) => e.type).join(",") ===
      "unknown,dispute.created,dispute.funds_withdrawn,charge.refunded" && seen.length === 2,
    partial.map((e) => e.type).join(","),
  );
}

// ── 8. extra schemes: BECS, BECS NZ, PAD, Autogiro, Betalingsservice, PayTo ──
async function extraSchemes() {
  const cus = { providerKey: "gocardless" as const, providerCustomerId: "CU00000000XS01" };
  const brqRoutes: Route[] = [
    (r) =>
      r.method === "POST" && r.url.endsWith("/billing_requests")
        ? { status: 201, body: { billing_requests: { id: "BRQ0000000XS01" } } }
        : undefined,
    (r) =>
      r.method === "POST" && r.url.endsWith("/billing_request_flows")
        ? {
            status: 201,
            body: {
              billing_request_flows: { authorisation_url: "https://pay.example.com/flow/XS01" },
            },
          }
        : undefined,
  ];
  const brqSent = () =>
    (
      seen.find((x) => x.url.endsWith("/billing_requests"))?.body as {
        billing_requests?: Record<string, any>;
      }
    )?.billing_requests;
  const setup = (methodTypes: string[] | undefined, currency: string, extra = {}) =>
    gc.initiateVaultSetup({
      customer: cus,
      returnUrl: "https://example.com/r",
      cancelUrl: "https://example.com/c",
      ...(methodTypes ? { methodTypes } : {}),
      currency,
      ...extra,
    });
  const want: [string, string, string][] = [
    ["au_becs_debit", "AUD", "becs"],
    ["nz_becs_debit", "NZD", "becs_nz"],
    ["acss_debit", "CAD", "pad"],
    ["autogiro", "SEK", "autogiro"],
    ["betalingsservice", "DKK", "betalingsservice"],
  ];
  for (const [method, cur, scheme] of want) {
    seen.length = 0;
    routes = brqRoutes;
    await setup([method], cur);
    const b = brqSent();
    ok(
      `setup ${method}: mandate request in ${scheme} / ${cur}, no PayTo fields`,
      b?.mandate_request?.scheme === scheme &&
        b?.mandate_request?.currency === cur &&
        !("purpose_code" in (b ?? {})) &&
        !("constraints" in (b?.mandate_request ?? {})),
      JSON.stringify(b),
    );
  }
  // AUD has two rails: the caller's pick wins, and no pick means BECS.
  seen.length = 0;
  await setup(undefined, "AUD");
  ok("setup AUD, no method asked → BECS", brqSent()?.mandate_request?.scheme === "becs");
  seen.length = 0;
  await setup(["payto", "au_becs_debit"], "AUD", { maxAmountMinor: 15_000n });
  const pt = brqSent();
  ok(
    "setup PayTo: pay_to with purpose_code retail, a description and the ceiling as max_amount_per_payment",
    pt?.mandate_request?.scheme === "pay_to" &&
      pt?.purpose_code === "retail" &&
      typeof pt?.mandate_request?.description === "string" &&
      pt.mandate_request.description.length > 0 &&
      pt?.mandate_request?.constraints?.max_amount_per_payment === 15000,
    JSON.stringify(pt),
  );
  seen.length = 0;
  await setup(["au_becs_debit", "payto"], "AUD", { maxAmountMinor: 15_000n });
  ok("setup AUD, BECS asked first → BECS", brqSent()?.mandate_request?.scheme === "becs");
  seen.length = 0;
  let refused = "";
  try {
    await setup(["payto"], "AUD");
  } catch (e) {
    refused = e instanceof ProviderRefusalError ? e.message : `not a refusal: ${String(e)}`;
  }
  ok(
    "setup PayTo without a ceiling: a refusal, and nothing sent",
    /PayTo needs a maximum amount/.test(refused) && seen.length === 0,
    refused,
  );
  // The purpose code comes from the account; a bad one is refused when the adapter is built.
  const lending = GATEWAY_FACTORIES.gocardless.build(
    { access_token: "x", api_base: BASE, payto_purpose_code: "Utility" },
    { businessId: "b", livemode: false },
  );
  seen.length = 0;
  await lending.initiateVaultSetup!({
    customer: cus,
    returnUrl: "https://example.com/r",
    cancelUrl: "https://example.com/c",
    methodTypes: ["payto"],
    currency: "AUD",
    maxAmountMinor: 5000n,
  });
  ok("setup PayTo: the account's purpose code is sent", brqSent()?.purpose_code === "utility");
  let bad = "";
  try {
    GATEWAY_FACTORIES.gocardless.build(
      { access_token: "x", payto_purpose_code: "shopping" },
      { businessId: "b", livemode: false },
    );
  } catch (e) {
    bad = (e as Error).message;
  }
  ok("factory: an unknown PayTo purpose code is refused", /not valid/.test(bad), bad);

  // A PayTo mandate reports its ceiling; a Direct Debit mandate reports none.
  const mandateOf = (id: string, scheme: string, consent?: Record<string, unknown>): Route =>
    get(`/mandates/${id}`, {
      mandates: {
        id,
        status: "active",
        scheme,
        links: { customer: cus.providerCustomerId },
        ...(consent ? { consent_parameters: consent } : {}),
      },
    });
  routes = [
    mandateOf("MD0000000XS001", "pay_to", { max_amount_per_payment: 15000, currency: "AUD" }),
    mandateOf("MD0000000XS002", "betalingsservice"),
  ];
  const ptPm = await gc.vaultPaymentMethod({ customer: cus, token: "MD0000000XS001" });
  ok(
    "vault PayTo: type payto, ceiling 15000 AUD from consent_parameters",
    ptPm.display.type === "payto" &&
      ptPm.mandate?.maxAmountMinor === 15000n &&
      ptPm.mandate?.currency === "AUD" &&
      ptPm.mandate?.rail === "pay_to",
    JSON.stringify(ptPm, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
  );
  const bsPm = await gc.vaultPaymentMethod({ customer: cus, token: "MD0000000XS002" });
  ok(
    "vault Betalingsservice: type betalingsservice, DKK, no ceiling",
    bsPm.display.type === "betalingsservice" &&
      bsPm.mandate?.currency === "DKK" &&
      bsPm.mandate?.maxAmountMinor === undefined,
  );

  // Business PAD: a Canadian customer's company goes as company_name.
  const customerSent = async (country: string) => {
    seen.length = 0;
    routes = [
      (r) =>
        r.method === "POST" && r.url.endsWith("/customers")
          ? { status: 201, body: { customers: { id: "CU00000000XS02" } } }
          : undefined,
    ];
    await gc.ensureCustomer({
      customerRef: "cus_XXXXXXXXXXXX06",
      name: "Pat Payer",
      company: "Fernhill Analytics",
      address: { line1: "1 Main St", city: "Town", postalCode: "00000", country },
    });
    return (seen[0]?.body as { customers?: Record<string, unknown> })?.customers;
  };
  const ca = await customerSent("CA");
  const gb = await customerSent("GB");
  ok(
    "customer: a Canadian company is sent as company_name (Business PAD); elsewhere not",
    ca?.company_name === "Fernhill Analytics" &&
      ca?.given_name === "Pat" &&
      !("company_name" in (gb ?? {})),
    JSON.stringify({ ca, gb }),
  );
  const def = GATEWAYS.gocardless;
  ok(
    "catalog: every method has an option with a hint",
    def.methodOptions.length === gc.capabilities.methods.length &&
      def.methodOptions.every((o) => !!o.hint),
  );
}

try {
  await signatures();
  await batch();
  statusMapping();
  await lateFailure();
  declines();
  await capabilitiesAndRequests();
  await auditFixes();
  await extraSchemes();
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
console.log(pass ? "\n✅ GOCARDLESS ADAPTER: PASS" : "\n❌ GOCARDLESS ADAPTER: FAIL");
await flushGatewayRequestLogs();
await closeDb();
process.exit(pass ? 0 : 1);
