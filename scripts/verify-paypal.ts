/**
 * PayPal adapter checks, in two tiers.
 *
 * OFFLINE (always runs, needs only Postgres): the conformance regressions. The adapter
 * talks to a scripted stand-in for PayPal's HTTP API, and its normalized webhooks are fed
 * to the real engine against a payment collected through tmtest. Each block names the
 * defect it pins.
 *
 * LIVE smoke (skips without sandbox creds): OAuth2 client-credentials auth + Orders API
 * request validity. Real money moves in `verify:paypal-live` (vault → charge → refund) and
 * `verify:paypal-tunnel` (engine + PayPal's own webhooks).
 *
 *   pnpm verify:paypal
 */
import { and, eq } from "drizzle-orm";
import { config } from "@/platform/config";
import { PayPalProvider } from "@/providers/paypal";
import { ProviderIndeterminateError, type NormalizedProviderEvent } from "@/providers/types";
import { classifyDecline, MERCHANT_SIDE_PARK } from "@/modules/subscriptions/decline-policy";
import { payerDeclineMessage } from "@/providers/decline-codes";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod, collectInvoice } from "@/modules/invoicing/service";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import { disputes, payments, ledgerEntries, transactions, invoices, refunds } from "@db/schema";

// Loaded after the engine: a static import of this module first trips an init cycle.
const { isHardDecline } = await import("@/modules/invoicing/collection");

const checks: [string, boolean, string][] = [];
const ok = (name: string, pass: boolean, detail = "") => checks.push([name, pass, detail]);

// ── the scripted PayPal ─────────────────────────────────────────────────────────
type Answer = { status: number; json: unknown } | Error;
type Call = { operation: string; method: string; path: string; requestId?: string; body?: unknown };

/** A provider whose HTTP layer answers from `route`; every call is recorded. */
function scripted(route: (c: Call, n: number) => Answer) {
  const p = new PayPalProvider({
    clientId: "unit",
    clientSecret: "unit",
    apiBase: "https://api.invalid",
    webhookId: "WH-UNIT",
    replayDelaysMs: [0, 0],
  });
  const calls: Call[] = [];
  const anyP = p as unknown as Record<string, unknown>;
  anyP.accessToken = async () => "unit";
  anyP.api = async (
    operation: string,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => {
    const c = { operation, method, path, body, requestId: headers?.["PayPal-Request-Id"] };
    calls.push(c);
    const a = route(c, calls.length);
    if (a instanceof Error) throw a;
    return a;
  };
  return { p, calls };
}

const AGREEMENT = "B-XXXXXXXXXXXXXXXX01";
const CHARGE = {
  amountMinor: 1500n,
  currency: "USD",
  customer: { providerKey: "paypal" as const, providerCustomerId: "cus_unit" },
  paymentMethod: {
    providerKey: "paypal" as const,
    providerPaymentMethodId: AGREEMENT,
    display: { type: "paypal" as const },
  },
  idempotencyKey: "inv_unit_attempt_1_pm_unit",
};
const COMPLETED_ORDER = {
  id: "ORDERUNIT0000001",
  status: "COMPLETED",
  purchase_units: [{ payments: { captures: [{ id: "CAPUNIT000000001", status: "COMPLETED" }] } }],
};
const declined = (issue: string) => ({
  status: 422,
  json: {
    name: "UNPROCESSABLE_ENTITY",
    message: "The requested action could not be performed.",
    details: [{ issue, description: "PayPal internal wording that must not reach a payer." }],
    debug_id: "dbgunit0000001",
  },
});
const threw = async (f: () => Promise<unknown>) => {
  try {
    await f();
    return null;
  } catch (e) {
    return e;
  }
};

console.log("PayPal offline conformance tier");

// ══ #1 a lost answer is indeterminate, replayed under the same PayPal-Request-Id ══
{
  const { p, calls } = scripted(() => ({
    status: 500,
    json: { name: "INTERNAL_SERVER_ERROR", debug_id: "x" },
  }));
  const e = await threw(() => p.charge(CHARGE));
  const ids = new Set(calls.map((c) => c.requestId));
  ok(
    "#1 charge: a 5xx that never clears throws ProviderIndeterminateError, not a decline",
    e instanceof ProviderIndeterminateError,
    `threw ${e instanceof Error ? e.name : String(e)}`,
  );
  ok(
    "#1 charge: every replay carries the SAME PayPal-Request-Id",
    calls.length === 3 && ids.size === 1 && !ids.has(undefined),
    `${calls.length} call(s), ${ids.size} distinct id(s)`,
  );
}
{
  const { p, calls } = scripted((_c, n) =>
    n === 1 ? new Error("fetch failed (timeout)") : { status: 201, json: COMPLETED_ORDER },
  );
  const out = await p.charge(CHARGE).catch((e: unknown) => e);
  const r = out as { status?: string; providerChargeId?: string };
  ok(
    "#1 charge: a timeout is replayed and the replay answer (the first capture) is booked",
    r.status === "succeeded" &&
      r.providerChargeId === "CAPUNIT000000001" &&
      calls.length === 2 &&
      calls[0]!.requestId === calls[1]!.requestId,
    `status ${r.status ?? String(out)}, ${calls.length} call(s)`,
  );
}
{
  const { p } = scripted(() => ({
    status: 409,
    json: { name: "RESOURCE_CONFLICT", details: [{ issue: "PREVIOUS_REQUEST_IN_PROGRESS" }] },
  }));
  const e = await threw(() => p.charge(CHARGE));
  ok(
    "#1 charge: 409 PREVIOUS_REQUEST_IN_PROGRESS is indeterminate",
    e instanceof ProviderIndeterminateError,
  );
}
{
  const { p } = scripted(() => ({ status: 429, json: { name: "RATE_LIMIT_REACHED" } }));
  const e = await threw(() => p.charge(CHARGE));
  ok(
    "#1 charge: a 429 that outlasts the replays is indeterminate (PayPal does not say it created nothing)",
    e instanceof ProviderIndeterminateError,
    `threw ${e instanceof Error ? e.name : String(e)}`,
  );
}
{
  const { p } = scripted(() => ({ status: 503, json: { name: "SERVICE_UNAVAILABLE" } }));
  const e = await threw(() =>
    p.refund({
      providerChargeId: "CAPUNIT000000001",
      amountMinor: 500n,
      currency: "USD",
      idempotencyKey: "re_unit_1",
    }),
  );
  ok(
    "#1 refund: a 5xx throws ProviderIndeterminateError, so the reservation is kept",
    e instanceof ProviderIndeterminateError,
    `threw ${e instanceof Error ? e.name : String(e)}`,
  );
}
{
  const { p } = scripted((c) =>
    c.method === "GET"
      ? {
          status: 200,
          json: {
            id: "ORDERUNIT0000002",
            status: "APPROVED",
            purchase_units: [
              { payments: { authorizations: [{ id: "AUTHUNIT00000001", status: "CREATED" }] } },
            ],
          },
        }
      : { status: 502, json: { name: "BAD_GATEWAY" } },
  );
  const e = await threw(() =>
    p.consumeIntent({
      purpose: "payment",
      intentId: "ORDERUNIT0000002",
      idempotencyKey: "pi_unit_consume",
    } as never),
  );
  ok(
    "#1 consumeIntent: a 5xx on the capture throws ProviderIndeterminateError",
    e instanceof ProviderIndeterminateError,
    `threw ${e instanceof Error ? e.name : String(e)}`,
  );
  const { p: pv } = scripted((c) =>
    c.method === "GET"
      ? {
          status: 200,
          json: {
            id: "ORDERUNIT0000003",
            status: "COMPLETED",
            purchase_units: [
              { payments: { authorizations: [{ id: "AUTHUNIT00000002", status: "CREATED" }] } },
            ],
          },
        }
      : { status: 500, json: { name: "INTERNAL_SERVER_ERROR" } },
  );
  const ev = await threw(() => pv.voidIntent({ intentId: "ORDERUNIT0000003" } as never));
  ok(
    "#1 voidIntent: a 5xx on the void throws ProviderIndeterminateError",
    ev instanceof ProviderIndeterminateError,
    `threw ${ev instanceof Error ? ev.name : String(ev)}`,
  );
}

// ══ #2 deleting a B- agreement cancels it at PayPal, idempotently ══════════════
{
  const { p, calls } = scripted(() => ({ status: 204, json: {} }));
  await p.deletePaymentMethod({ customer: CHARGE.customer, paymentMethod: CHARGE.paymentMethod });
  ok(
    "#2 delete: a B- agreement is CANCELLED via v1, not DELETEd as a v3 vault token",
    calls.length === 1 &&
      calls[0]!.method === "POST" &&
      calls[0]!.path === `/v1/billing-agreements/agreements/${AGREEMENT}/cancel`,
    calls.map((c) => `${c.method} ${c.path}`).join(", "),
  );
  const gone = scripted((c) =>
    c.method === "POST"
      ? { status: 400, json: { name: "STATUS_INVALID" } }
      : { status: 200, json: { id: AGREEMENT, state: "Cancelled" } },
  );
  const e1 = await threw(() =>
    gone.p.deletePaymentMethod({ customer: CHARGE.customer, paymentMethod: CHARGE.paymentMethod }),
  );
  ok("#2 delete: an agreement already cancelled resolves", e1 === null, String(e1));
  const live = scripted((c) =>
    c.method === "POST"
      ? { status: 500, json: {} }
      : { status: 200, json: { id: AGREEMENT, state: "Active" } },
  );
  const e2 = await threw(() =>
    live.p.deletePaymentMethod({ customer: CHARGE.customer, paymentMethod: CHARGE.paymentMethod }),
  );
  ok("#2 delete: a refused cancel on a still-active agreement throws", e2 instanceof Error);
}

// ══ #5 dead-instrument and merchant-side codes ═══════════════════════════════
for (const issue of [
  "BILLING_AGREEMENT_NOT_FOUND",
  "TOKEN_ID_NOT_FOUND",
  "INVALID_VAULT_ID",
  "PAYER_ACCOUNT_LOCKED_OR_CLOSED",
  "PAYER_ACCOUNT_RESTRICTED",
]) {
  const { p } = scripted(() => declined(issue));
  const r = await p.charge(CHARGE);
  ok(
    `#5 ${issue}: the method is unusable (payment_method_not_found, hard, parks)`,
    r.failure?.code === "payment_method_not_found" &&
      isHardDecline(r) &&
      classifyDecline(r.failure.code) === "park",
    `code ${r.failure?.code}, retriable ${r.failure?.retriable}`,
  );
}
for (const issue of [
  "PAYEE_ACCOUNT_RESTRICTED",
  "PAYEE_NOT_CONSENTED",
  "PERMISSION_DENIED",
  "NOT_ENABLED_FOR_PAYMENT_SOURCE",
  "PAYEE_BLOCKED_TRANSACTION",
]) {
  const { p } = scripted(() => declined(issue));
  const r = await p.charge(CHARGE);
  const code = r.failure?.code ?? "";
  ok(
    `#5 ${issue}: merchant-side — parks with the ops alert, method stays valid, payer not blamed`,
    MERCHANT_SIDE_PARK.has(code) &&
      !isHardDecline(r) &&
      payerDeclineMessage({ code, message: r.failure?.message }, "fallback") !== r.failure?.message,
    `code ${code}, retriable ${r.failure?.retriable}`,
  );
}

// ══ #6 no raw PayPal text or debug id in failure text ═════════════════════════
{
  const { p } = scripted(() => declined("SOME_FUTURE_ISSUE"));
  const r = await p.charge(CHARGE);
  const m = r.failure?.message ?? "";
  ok(
    "#6 an unruled decline keeps the issue code but not PayPal's description or debug_id",
    m.includes("SOME_FUTURE_ISSUE") &&
      !m.includes("PayPal internal wording") &&
      !m.includes("dbgunit"),
    m,
  );
}

// ══ 3f: locateCharge, whole-unit currencies, vault request id, final_capture ══
{
  const TAG = "tmbilling_ref:inv_unit";
  const LOCATE = {
    ownershipRef: "inv_unit",
    idempotencyKey: "inv_unit_attempt_1",
    amountMinor: 1500n,
    currency: "USD",
    createdAfter: new Date(Date.now() - 3_600_000),
  };
  const row = (id: string, custom?: string, value = "15.00") => ({
    transaction_info: {
      transaction_id: id,
      transaction_amount: { value, currency_code: "USD" },
      ...(custom ? { custom_field: custom } : {}),
    },
  });
  const search =
    (rows: unknown[], reportedUntil = new Date().toISOString()) =>
    (c: Call) =>
      c.path.startsWith("/v1/reporting/transactions")
        ? {
            status: 200,
            json: {
              transaction_details: rows,
              total_pages: 1,
              last_refreshed_datetime: reportedUntil,
            },
          }
        : c.path === "/v2/payments/captures/CAPUNIT000000009"
          ? { status: 200, json: { id: "CAPUNIT000000009", status: "COMPLETED" } }
          : { status: 404, json: { name: "RESOURCE_NOT_FOUND" } };

  const found = await scripted(
    search([
      row("CAPUNIT000000009", TAG),
      row("CAPUNIT000000008", "tmbilling_ref:inv_other"),
      row("CAPUNIT000000007", TAG, "9.00"),
    ]),
  ).p.locateCharge(LOCATE);
  ok(
    "3f locateCharge: our tag at our amount is found and read back from the capture",
    found?.status === "succeeded" && found.providerChargeId === "CAPUNIT000000009",
    JSON.stringify(found),
  );
  const none = await scripted(
    search([row("CAPUNIT000000008", "tmbilling_ref:inv_other")]),
  ).p.locateCharge(LOCATE);
  ok("3f locateCharge: only other tags → null (never created)", none === null);
  // PayPal's report lags by hours: before it covers the attempt, "none" is not an answer.
  ok(
    "3g locateCharge: a report that does not reach the attempt yet throws, never null",
    (await threw(() =>
      scripted(
        search([], new Date(LOCATE.createdAfter.getTime() - 3_600_000).toISOString()),
      ).p.locateCharge(LOCATE),
    )) instanceof Error,
  );
  ok(
    "3f locateCharge: an untagged row at our amount throws, never null",
    (await threw(() =>
      scripted(search([row("CAPUNIT000000006")])).p.locateCharge(LOCATE),
    )) instanceof Error,
  );
  ok(
    "3f locateCharge: two tagged rows at our amount throw (not guessing)",
    (await threw(() =>
      scripted(search([row("CAPUNIT000000009", TAG), row("CAPUNIT000000005", TAG)])).p.locateCharge(
        LOCATE,
      ),
    )) instanceof Error,
  );
  ok(
    "3f locateCharge: 403 (Transaction Search not enabled) throws, never null",
    (await threw(() =>
      scripted(() => ({ status: 403, json: { name: "NOT_AUTHORIZED" } })).p.locateCharge(LOCATE),
    )) instanceof Error,
  );
}
{
  const paid = (source: Record<string, unknown>) =>
    scripted(() => ({
      status: 201,
      json: { ...COMPLETED_ORDER, payment_source: source },
    })).p.charge(CHARGE);
  const wallet = await paid({ paypal: { email_address: "payer@example.com" } });
  const card = await paid({ card: { last_digits: "1111" } });
  const bare = await scripted(() => ({ status: 201, json: COMPLETED_ORDER })).p.charge(CHARGE);
  ok(
    "methodUsed: the order's payment_source key; absent when PayPal names none",
    wallet.methodUsed === "paypal" && card.methodUsed === "card" && bare.methodUsed === undefined,
    `${wallet.methodUsed} ${card.methodUsed} ${bare.methodUsed}`,
  );
}
{
  const { p, calls } = scripted(() => ({ status: 201, json: COMPLETED_ORDER }));
  await p.charge({ ...CHARGE, currency: "HUF", amountMinor: 2500n });
  const sent = (calls[0]?.body as { purchase_units?: Array<{ amount?: { value?: string } }> })
    ?.purchase_units?.[0]?.amount?.value;
  ok('3f HUF 2500 minor is sent as "25"', sent === "25", `sent ${sent}`);
  const n = calls.length;
  const e = await threw(() => p.charge({ ...CHARGE, currency: "TWD", amountMinor: 2550n }));
  ok(
    "3f TWD with a fraction throws before anything is sent",
    e instanceof Error && calls.length === n,
    `${e instanceof Error ? e.message : String(e)}; calls ${calls.length - n}`,
  );
}
{
  const { p, calls } = scripted((c) =>
    c.path === "/v3/vault/payment-tokens"
      ? { status: 200, json: { id: "VTUNIT01", payment_source: { paypal: {} } } }
      : { status: 404, json: {} },
  );
  await p.consumeIntent({ purpose: "setup", intentId: "STUNIT01", idempotencyKey: "k" });
  ok(
    "3f vault exchange sends a PayPal-Request-Id",
    !!calls.find((c) => c.path === "/v3/vault/payment-tokens")?.requestId,
  );
}
{
  const { p, calls } = scripted((c) =>
    c.method === "GET"
      ? {
          status: 200,
          json: {
            id: "ORDERUNIT0000002",
            purchase_units: [
              { payments: { authorizations: [{ id: "AUTHUNIT01", status: "CREATED" }] } },
            ],
          },
        }
      : { status: 201, json: { id: "CAPUNIT000000010", status: "COMPLETED" } },
  );
  await p.consumeIntent({
    purpose: "payment",
    intentId: "ORDERUNIT0000002",
    idempotencyKey: "k2",
    amountMinor: 600n,
    currency: "USD",
  });
  const body = calls.find((c) => c.path.endsWith("/capture"))?.body as { final_capture?: unknown };
  ok("3f a capture sends final_capture: true", body?.final_capture === true, JSON.stringify(body));
}

// ══ webhook normalization ═══════════════════════════════════════════════════
const hook = new PayPalProvider({
  clientId: "unit",
  clientSecret: "unit",
  apiBase: "https://api.invalid",
  webhookId: "WH-UNIT",
});
(hook as unknown as Record<string, unknown>).verifyWebhookSignatureLocally = async () => {};
const HEADERS = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-UNIT",
  "paypal-transmission-id": "tx-unit",
  "paypal-transmission-sig": "c2ln",
  "paypal-transmission-time": new Date().toISOString(),
};
let whSeq = 0;
async function normalize(eventType: string, resource: Record<string, unknown>) {
  const body = {
    id: `WH-UNIT-${Date.now()}-${++whSeq}`,
    event_type: eventType,
    create_time: new Date().toISOString(),
    resource,
  };
  const payload = JSON.stringify(body);
  const [ev] = await hook.normalizeWebhook({
    headers: HEADERS,
    payload: Buffer.from(payload),
  } as never);
  return { ev: ev!, payload: body };
}

// #7 v1 sale refunds are sized from amount.total
{
  const { ev } = await normalize("PAYMENT.SALE.REFUNDED", {
    id: "REFUNDUNIT000001",
    sale_id: "SALEUNIT00000001",
    state: "completed",
    amount: { total: "-5.00", currency: "USD" },
  });
  ok(
    "#7 PAYMENT.SALE.REFUNDED: the sale is correlated and the amount read from amount.total",
    ev.type === "charge.refunded" &&
      ev.providerChargeId === "SALEUNIT00000001" &&
      ev.amountRefundedMinor === 500n,
    `charge ${ev.providerChargeId}, amount ${ev.amountRefundedMinor}`,
  );
  const { ev: unsized } = await normalize("PAYMENT.SALE.REFUNDED", {
    id: "REFUNDUNIT000002",
    sale_id: "SALEUNIT00000001",
    state: "completed",
  });
  ok(
    "#7 a v1 refund with no amount is not correlated, so it is never booked as a FULL refund",
    unsized.providerChargeId === undefined,
  );
}
// #2 the buyer cancelling a B- agreement at PayPal detaches the method
{
  const { ev } = await normalize("BILLING.SUBSCRIPTION.CANCELLED", {
    id: AGREEMENT,
    state: "Cancelled",
  });
  ok(
    "#2 BILLING.SUBSCRIPTION.CANCELLED on a B- agreement → payment_method.detached",
    ev.type === "payment_method.detached" && ev.providerPaymentMethodId === AGREEMENT,
    `${ev.type}`,
  );
  const { ev: sub } = await normalize("BILLING.SUBSCRIPTION.CANCELLED", {
    id: "I-XXXXXXXXXXXX01",
    status: "CANCELLED",
  });
  ok("#2 the same event on a Subscriptions-API id is left alone", sub.type === "unknown", sub.type);
}
// #3 dispute transitions
const disputeResource = (
  status: string,
  outcome?: string,
  extra: Record<string, unknown> = {},
) => ({
  dispute_id: "PP-D-UNIT-1",
  status,
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  dispute_amount: { currency_code: "USD", value: "15.00" },
  disputed_transactions: [{ seller_transaction_id: "CAPUNIT000000001" }],
  ...(outcome ? { dispute_outcome: { outcome_code: outcome } } : {}),
  ...extra,
});
{
  const { ev } = await normalize("CUSTOMER.DISPUTE.UPDATED", disputeResource("UNDER_REVIEW"));
  ok(
    "#3 CUSTOMER.DISPUTE.UPDATED on an open case is a status refresh, not a close",
    ev.type === "dispute.updated" && ev.disputeStatus === "under_review",
    `${ev.type} / ${ev.disputeStatus}`,
  );
  const expect: Record<string, string> = {
    RESOLVED_BUYER_FAVOUR: "dispute.lost",
    ACCEPTED: "dispute.lost",
    RESOLVED_SELLER_FAVOUR: "dispute.won",
    DENIED: "dispute.won",
    CANCELED_BY_BUYER: "dispute.won",
    RESOLVED_WITH_PAYOUT: "dispute.won",
    NONE: "dispute.closed",
  };
  for (const [code, want] of Object.entries(expect)) {
    const { ev: r } = await normalize(
      "CUSTOMER.DISPUTE.RESOLVED",
      disputeResource("RESOLVED", code),
    );
    ok(`#3 outcome ${code} → ${want}`, r.type === want, r.type);
  }
  const { ev: debited } = await normalize(
    "CUSTOMER.DISPUTE.RESOLVED",
    disputeResource("RESOLVED", "RESOLVED_WITH_PAYOUT", {
      money_movements: [
        {
          affected_party: "SELLER",
          type: "DEBIT",
          reason: "DISPUTE_SETTLEMENT",
          amount: { currency_code: "USD", value: "15.00" },
        },
      ],
    }),
  );
  ok(
    "#3 RESOLVED_WITH_PAYOUT with a net seller settlement debit is a loss",
    debited.type === "dispute.lost",
    debited.type,
  );
}

// ══ engine: reversals and disputes against a real collected payment ══════════
const AMOUNT = 1500n;
async function scenario(label: string) {
  const org = await createOrganization({ name: `PayPal conformance ${label}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    defaultCurrency: "USD",
    organizationId: orgId,
    name: "Biz",
    livemode: "test",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `pp-${label}@example.com`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: Number(AMOUNT),
    interval: "month",
  });
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  await collectInvoice({
    organizationId: orgId,
    businessId: biz.id,
    invoice,
    subscription: sub.subscription,
  });
  const [pay] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.invoiceId, invoice.id), eq(payments.status, "succeeded")))
      .limit(1),
  );
  if (!pay?.providerChargeId) throw new Error(`${label}: setup failed — no succeeded payment`);
  // The engine is provider-agnostic past normalization: the PayPal event is delivered as
  // the gateway that took this charge.
  const deliver = async (eventType: string, resource: Record<string, unknown>) => {
    const { ev, payload } = await normalize(eventType, resource);
    return handleProviderEvent("tmtest", ev as NormalizedProviderEvent, {
      businessId: biz.id,
      payload,
    });
  };
  const ledger = async (sourceType: string, account: string) => {
    const rows = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.sourceType, sourceType), eq(ledgerEntries.account, account))),
    );
    return rows.reduce(
      (s, r) => s + (r.direction === "debit" ? r.amountMinor : -r.amountMinor),
      0n,
    );
  };
  const state = async () => {
    const [txn] = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(transactions)
        .where(and(eq(transactions.paymentId, pay.id), eq(transactions.type, "payment")))
        .limit(1),
    );
    const [inv] = await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, invoice.id)),
    );
    const [d] = await withTenant(orgId, (tx) => tx.select().from(disputes).limit(1));
    return {
      txn: txn?.status,
      invoice: inv?.status,
      dispute: d?.status,
      withdrawn: d?.fundsWithdrawn,
    };
  };
  const chargeId = pay.providerChargeId;
  const dispute = (status: string, outcome?: string) => ({
    ...disputeResource(status, outcome),
    disputed_transactions: [{ seller_transaction_id: chargeId }],
  });
  const reversal = (id: string) => ({
    id,
    status: "COMPLETED",
    note_to_payer: "Payment reversed",
    amount: { currency_code: "USD", value: "15.00" },
    links: [{ rel: "up", href: `https://api.paypal.com/v2/payments/captures/${chargeId}` }],
  });
  return { orgId, pay, chargeId, deliver, ledger, state, dispute, reversal };
}

// #4 a reversal with no dispute is booked through the late-failure reversal
{
  const s = await scenario("reversal");
  const r1 = await s.deliver("PAYMENT.CAPTURE.REVERSED", s.reversal("REVUNIT000000001"));
  const st = await s.state();
  const cash = await s.ledger("payment_reversal", "cash");
  ok(
    "#4 PAYMENT.CAPTURE.REVERSED books the money back out and reopens the invoice",
    r1 === "processed" && st.txn === "late_failed" && cash === -AMOUNT && st.invoice !== "paid",
    `result ${r1}, txn ${st.txn}, invoice ${st.invoice}, payment_reversal cash ${cash}`,
  );
  const r2 = await s.deliver("PAYMENT.CAPTURE.REVERSED", s.reversal("REVUNIT000000001"));
  ok(
    "#4 a redelivered reversal books nothing twice",
    r2 === "ignored" && (await s.ledger("payment_reversal", "cash")) === -AMOUNT,
    `result ${r2}`,
  );
}
// #4 DENIED after COMPLETED is the same reversal
{
  const s = await scenario("denied");
  const r = await s.deliver("PAYMENT.CAPTURE.DENIED", { id: s.chargeId, status: "DENIED" });
  const st = await s.state();
  ok(
    "#4 PAYMENT.CAPTURE.DENIED on a captured payment is booked as a reversal",
    r === "processed" &&
      st.txn === "late_failed" &&
      (await s.ledger("payment_reversal", "cash")) === -AMOUNT,
    `result ${r}, txn ${st.txn}`,
  );
}
// #3 an UPDATED case stays open; a reversal during it is the dispute's withdrawal; a
// buyer cancellation gives it back
{
  const s = await scenario("dispute-open");
  await s.deliver("CUSTOMER.DISPUTE.CREATED", s.dispute("WAITING_FOR_SELLER_RESPONSE"));
  await s.deliver("CUSTOMER.DISPUTE.UPDATED", s.dispute("UNDER_REVIEW"));
  const st1 = await s.state();
  ok(
    "#3 after CUSTOMER.DISPUTE.UPDATED the case is still open (under_review), not closed",
    st1.dispute === "under_review",
    `status ${st1.dispute}`,
  );
  await s.deliver("PAYMENT.CAPTURE.REVERSED", s.reversal("REVUNIT000000002"));
  const st2 = await s.state();
  ok(
    "#4 a reversal during an open dispute is the dispute's withdrawal, not a second reversal",
    st2.withdrawn === "true" &&
      (await s.ledger("dispute", "cash")) === -AMOUNT &&
      (await s.ledger("payment_reversal", "cash")) === 0n,
    `withdrawn ${st2.withdrawn}, dispute cash ${await s.ledger("dispute", "cash")}`,
  );
  await s.deliver("CUSTOMER.DISPUTE.RESOLVED", s.dispute("RESOLVED", "CANCELED_BY_BUYER"));
  const st3 = await s.state();
  ok(
    "#3 CANCELED_BY_BUYER reinstates the withdrawn funds (won), never a loss",
    st3.dispute === "won" &&
      (await s.ledger("dispute", "cash")) === 0n &&
      (await s.ledger("dispute", "dispute_losses")) === 0n,
    `status ${st3.dispute}, dispute cash ${await s.ledger("dispute", "cash")}`,
  );
}
// #3/#4 a loss on a payment already reversed does not take the cash twice
{
  const s = await scenario("lost-after-reversal");
  await s.deliver("PAYMENT.CAPTURE.REVERSED", s.reversal("REVUNIT000000003"));
  await s.deliver("CUSTOMER.DISPUTE.CREATED", s.dispute("OPEN"));
  await s.deliver("CUSTOMER.DISPUTE.RESOLVED", s.dispute("RESOLVED", "RESOLVED_BUYER_FAVOUR"));
  const st = await s.state();
  const total = (await s.ledger("payment_reversal", "cash")) + (await s.ledger("dispute", "cash"));
  ok(
    "#3 a buyer-favour loss after a reversal leaves exactly one cash outflow",
    st.dispute === "lost" && total === -AMOUNT,
    `status ${st.dispute}, total cash ${total}`,
  );
}
// #7 a partial v1 refund books its own amount, not the whole payment
{
  const s = await scenario("sale-refund");
  const r = await s.deliver("PAYMENT.SALE.REFUNDED", {
    id: "REFUNDUNIT000003",
    sale_id: s.chargeId,
    state: "completed",
    amount: { total: "-5.00", currency: "USD" },
  });
  const rows = await withTenant(s.orgId, (tx) =>
    tx.select().from(refunds).where(eq(refunds.paymentId, s.pay.id)),
  );
  ok(
    "#7 a 5.00 v1 sale refund on a 15.00 payment books 5.00",
    r === "processed" && rows.length === 1 && rows[0]!.amountMinor === 500n,
    `result ${r}, refunds ${rows.map((x) => x.amountMinor).join(",")}`,
  );
}

let failed = 0;
for (const [name, pass, detail] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}${pass || !detail ? "" : `\n      ${detail}`}`);
  if (!pass) failed++;
}
console.log(
  failed === 0
    ? `✅ PAYPAL OFFLINE CONFORMANCE: ${checks.length} checks PASS`
    : `❌ PAYPAL OFFLINE CONFORMANCE: ${failed} of ${checks.length} FAILED`,
);

// ══ LIVE smoke tier ══════════════════════════════════════════════════════════
if (!config.PAYPAL_TEST_BUSINESS_US_CLIENT_ID || !config.PAYPAL_TEST_BUSINESS_US_CLIENT_SECRET) {
  console.log("SKIP live tier: PayPal US sandbox creds not set");
  await closeDb();
  process.exit(failed === 0 ? 0 : 1);
}

const paypal = new PayPalProvider({
  clientId: config.PAYPAL_TEST_BUSINESS_US_CLIENT_ID,
  clientSecret: config.PAYPAL_TEST_BUSINESS_US_CLIENT_SECRET,
  apiBase: config.PAYPAL_API_BASE,
});

console.log("PayPal sandbox base:", config.PAYPAL_API_BASE);
console.log("authenticating (OAuth2 client-credentials)…");
const health = await paypal.healthCheck();
console.log(
  `  authenticated=${health.authenticated} order=${health.orderId?.slice(0, 14)}… status=${health.orderStatus}`,
);

const pass = health.authenticated === true && !!health.orderId && health.orderStatus === "CREATED";
console.log("");
console.log(pass ? "✅ PAYPAL ADAPTER (auth + order shape): PASS" : "❌ PAYPAL ADAPTER: FAIL");
console.log("   (smoke tier — real money moves in verify:paypal-live / verify:paypal-tunnel)");
await closeDb();
process.exit(pass && failed === 0 ? 0 : 1);
