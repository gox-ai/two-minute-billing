/**
 * RazorPay adapter conformance — webhook shapes and lost answers.
 *
 * Payload shapes follow RazorPay's documented samples (webhooks/payloads/refunds,
 * webhooks/payments): `refund.processed` carries the refund AND the payment, and the
 * payment's `amount_refunded` is its running total.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import * as razorpayModule from "@/providers/razorpay";
import { ProviderIndeterminateError, strandedObjectId } from "@/providers/types";
import type { ProviderCustomerRef, ProviderPaymentMethodRef } from "@/providers/types";

const { RazorpayProvider, describeRazorpayMandate } = razorpayModule;
const normaliseRazorpayMandateStatus = (s: string) =>
  razorpayModule.normaliseRazorpayMandateStatus(s);

type Answer = { status?: number; json?: unknown; body?: string; throws?: string };
interface Stub {
  match: (method: string, url: string) => boolean;
  answer: Answer;
}

/** Answers from `stubs`; an unstubbed call fails the test. */
function stubFetch(stubs: Stub[]) {
  const seen: Array<{ method: string; url: string; body?: string }> = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    seen.push({ method, url, body: typeof init?.body === "string" ? init.body : undefined });
    const hit = stubs.find((s) => s.match(method, url));
    if (!hit) throw new Error(`unstubbed gateway call: ${method} ${url}`);
    if (hit.answer.throws) throw new Error(hit.answer.throws);
    return new Response(hit.answer.body ?? JSON.stringify(hit.answer.json ?? {}), {
      status: hit.answer.status ?? 200,
    });
  });
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

const SECRET = "conformance-secret";
const rzp = () =>
  new RazorpayProvider({
    keyId: "rzp_test_x",
    keySecret: "secret",
    apiBase: "https://api.razorpay.test/v1",
    webhookSecret: SECRET,
  });
const deliver = (event: Record<string, unknown>) => {
  const body = JSON.stringify(event);
  return rzp().normalizeWebhook({
    payload: body,
    headers: { "x-razorpay-signature": createHmac("sha256", SECRET).update(body).digest("hex") },
  });
};

const CUSTOMER: ProviderCustomerRef = { providerKey: "razorpay", providerCustomerId: "cust_x" };
const UPI: ProviderPaymentMethodRef = {
  providerKey: "razorpay",
  providerPaymentMethodId: "token_x",
  display: { type: "upi" },
};
const CHARGE = {
  amountMinor: 100000n,
  currency: "INR",
  customer: CUSTOMER,
  paymentMethod: UPI,
  idempotencyKey: "collect_inv_1",
  email: "payer@example.com",
  phone: "+919000000001",
};
const isOrderCreate = (m: string, u: string) => m === "POST" && u.endsWith("/orders");
const isRecurring = (m: string, u: string) =>
  m === "POST" && u.endsWith("/payments/create/recurring");
const isOrderPayments = (m: string, u: string) =>
  m === "GET" && u.endsWith("/orders/order_lost/payments");

describe("refund.processed names the refund and the running total", () => {
  it("carries providerRefundId and the payment's amount_refunded", async () => {
    const [ev] = await deliver({
      entity: "event",
      event: "refund.processed",
      contains: ["refund", "payment"],
      created_at: 1786681800,
      payload: {
        refund: {
          entity: {
            id: "rfnd_XXXXXXXXXXXX01",
            entity: "refund",
            amount: 50000,
            currency: "INR",
            payment_id: "pay_XXXXXXXXXXXX01",
            status: "processed",
            notes: { tmbilling_ref: "re_ours" },
          },
        },
        payment: {
          entity: {
            id: "pay_XXXXXXXXXXXX01",
            amount: 500000,
            currency: "INR",
            status: "captured",
            captured: true,
            amount_refunded: 190000,
            refund_status: "partial",
          },
        },
      },
    });
    expect(ev?.type).toBe("charge.refunded");
    expect(ev?.providerChargeId).toBe("pay_XXXXXXXXXXXX01");
    expect(ev?.providerRefundId).toBe("rfnd_XXXXXXXXXXXX01");
    // The running total, not this refund's 50000 and not the payment's 500000.
    expect(ev?.amountRefundedMinor).toBe(190000n);
    expect(ev?.ownershipRef).toBe("re_ours");
  });

  it("a capture carries its amount, so a late capture can be matched", async () => {
    const [ev] = await deliver({
      event: "payment.captured",
      created_at: 1786681800,
      payload: {
        payment: {
          entity: { id: "pay_c", amount: 7000, status: "captured", order_id: "order_c" },
        },
      },
    });
    expect(ev?.amountMinor).toBe(7000n);
    expect(ev?.providerIntentId).toBe("order_c");
  });
});

describe("a lost answer on the recurring debit is indeterminate, never a decline", () => {
  const cases: Array<[string, Answer]> = [
    ["a 503", { status: 503, json: { error: { code: "SERVER_ERROR" } } }],
    ["a 409", { status: 409, json: { error: { code: "BAD_REQUEST_ERROR" } } }],
    ["a 429", { status: 429, json: { error: { code: "BAD_REQUEST_ERROR" } } }],
    ["a 408", { status: 408, body: "" }],
    ["a body that is not JSON", { status: 200, body: "<html>bad gateway</html>" }],
    ["a transport failure", { throws: "socket hang up" }],
    ["an accepted answer with no payment id", { status: 200, json: {} }],
  ];
  for (const [label, answer] of cases) {
    it(`throws ProviderIndeterminateError carrying the order: ${label}`, async () => {
      stubFetch([
        { match: isOrderCreate, answer: { json: { id: "order_lost" } } },
        { match: isRecurring, answer },
        { match: isOrderPayments, answer: { json: { items: [] } } },
      ]);
      const err = await rzp()
        .charge(CHARGE)
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(ProviderIndeterminateError);
      expect(strandedObjectId(err)).toBe("order_lost");
    });
  }

  it("answers from the order when the debit did reach RazorPay", async () => {
    stubFetch([
      { match: isOrderCreate, answer: { json: { id: "order_lost" } } },
      { match: isRecurring, answer: { status: 504, body: "" } },
      {
        match: isOrderPayments,
        answer: { json: { items: [{ id: "pay_found", status: "created", captured: false }] } },
      },
    ]);
    const res = await rzp().charge(CHARGE);
    expect(res.status).toBe("pending");
    expect(res.providerChargeId).toBe("pay_found");
  });

  it("a 4xx is still a definite decline", async () => {
    stubFetch([
      { match: isOrderCreate, answer: { json: { id: "order_lost" } } },
      {
        match: isRecurring,
        answer: { status: 400, json: { error: { code: "BAD_REQUEST_ERROR", reason: "x" } } },
      },
    ]);
    const res = await rzp().charge(CHARGE);
    expect(res.status).toBe("failed");
  });

  it("fetchChargeStatus resolves an order id through its payments", async () => {
    stubFetch([
      {
        match: isOrderPayments,
        answer: {
          json: {
            items: [
              { id: "pay_1", status: "failed", captured: false, created_at: 1 },
              { id: "pay_2", status: "captured", captured: true, created_at: 2 },
            ],
          },
        },
      },
    ]);
    const res = await rzp().fetchChargeStatus({ providerChargeId: "order_lost" });
    expect(res.status).toBe("succeeded");
    expect(res.providerChargeId).toBe("pay_2");
  });
});

describe("locateCharge finds a lost debit by our order receipt", () => {
  const LOCATE = {
    ownershipRef: "inv_1",
    idempotencyKey: "collect_inv_1",
    amountMinor: 100000n,
    currency: "INR",
    createdAfter: new Date("2026-10-27T00:00:00Z"),
  };
  const ours = {
    id: "order_lost",
    amount: 100000,
    currency: "INR",
    notes: { tmbilling_ref: "collect_inv_1" },
  };
  const isOrderList = (m: string, u: string) => m === "GET" && /\/orders\?/.test(u);

  it("lists by receipt from createdAfter and answers from the order's payments", async () => {
    const seen = stubFetch([
      { match: isOrderList, answer: { json: { items: [ours] } } },
      {
        match: isOrderPayments,
        answer: { json: { items: [{ id: "pay_found", status: "captured", captured: true }] } },
      },
    ]);
    const res = await rzp().locateCharge(LOCATE);
    expect(res?.status).toBe("succeeded");
    expect(res?.providerChargeId).toBe("pay_found");
    const q = new URL(seen[0]!.url).searchParams;
    expect(q.get("receipt")).toBe("collect_inv_1");
    expect(q.get("from")).toBe(String(LOCATE.createdAfter.getTime() / 1000));
    expect(seen.every((c) => c.method === "GET")).toBe(true);
  });

  it("answers null when our order has no payment, or no order of ours exists", async () => {
    stubFetch([
      {
        match: isOrderList,
        answer: {
          json: { items: [ours, { ...ours, id: "order_other", notes: { tmbilling_ref: "x" } }] },
        },
      },
      { match: isOrderPayments, answer: { json: { items: [] } } },
    ]);
    expect(await rzp().locateCharge(LOCATE)).toBeNull();
  });

  it("throws when the order's payments cannot be read", async () => {
    stubFetch([
      { match: isOrderList, answer: { json: { items: [ours] } } },
      { match: isOrderPayments, answer: { status: 502, body: "" } },
    ]);
    await expect(rzp().locateCharge(LOCATE)).rejects.toThrow();
  });
});

describe("a lost answer on a refund create is indeterminate, never a refusal", () => {
  const isRefund = (m: string, u: string) => m === "POST" && u.endsWith("/payments/pay_r/refund");
  const isList = (m: string, u: string) => m === "GET" && u.includes("/payments/pay_r/refunds");
  const REFUND = { providerChargeId: "pay_r", amountMinor: 1000n, idempotencyKey: "re_lost" };

  it("throws ProviderIndeterminateError on a 5xx when no refund of ours exists", async () => {
    stubFetch([
      { match: isRefund, answer: { status: 502, json: { error: { code: "SERVER_ERROR" } } } },
      { match: isList, answer: { json: { items: [{ id: "rfnd_other", notes: [] }] } } },
    ]);
    await expect(rzp().refund(REFUND)).rejects.toBeInstanceOf(ProviderIndeterminateError);
  });

  it("finds the refund by our tag when RazorPay did create it", async () => {
    stubFetch([
      { match: isRefund, answer: { throws: "timed out" } },
      {
        match: isList,
        answer: {
          json: {
            items: [{ id: "rfnd_ours", status: "pending", notes: { tmbilling_ref: "re_lost" } }],
          },
        },
      },
    ]);
    const res = await rzp().refund(REFUND);
    expect(res).toMatchObject({ status: "pending", providerRefundId: "rfnd_ours" });
  });

  it("locateRefund answers null when the payment has no refund with our tag", async () => {
    stubFetch([{ match: isList, answer: { json: { items: [] } } }]);
    expect(
      await rzp().locateRefund?.({ providerChargeId: "pay_r", ownershipRef: "re_lost" }),
    ).toBeNull();
  });
});

describe("an uncaptured `refunded` payment is not money taken", () => {
  it("fetchChargeStatus reports it failed, not pending", async () => {
    stubFetch([
      {
        match: (m, u) => m === "GET" && u.endsWith("/payments/pay_u"),
        answer: { json: { id: "pay_u", status: "refunded", captured: false, amount: 100 } },
      },
    ]);
    const res = await rzp().fetchChargeStatus({ providerChargeId: "pay_u" });
    expect(res.status).toBe("failed");
  });

  it("a captured then refunded payment is still a succeeded charge", async () => {
    stubFetch([
      {
        match: (m, u) => m === "GET" && u.endsWith("/payments/pay_c"),
        answer: { json: { id: "pay_c", status: "refunded", captured: true, amount: 100 } },
      },
    ]);
    expect((await rzp().fetchChargeStatus({ providerChargeId: "pay_c" })).status).toBe("succeeded");
  });

  it("fetchIntent does not call it consumed", async () => {
    stubFetch([
      {
        match: (m, u) => m === "GET" && u.endsWith("/orders/order_u/payments"),
        answer: { json: { items: [{ id: "pay_u", status: "refunded", captured: false }] } },
      },
    ]);
    const res = await rzp().fetchIntent({ intentId: "order_u" });
    expect(res.status).toBe("failed");
  });
});

describe("the currency a mandate is stored in", () => {
  const tok = (method: string) => ({ id: "token_c", method, recurring: true, max_amount: 50_000 });

  it("UPI and netbanking are INR; a card takes its registration payment's currency", () => {
    expect(describeRazorpayMandate(tok("upi"))?.currency).toBe("INR");
    expect(describeRazorpayMandate(tok("emandate"))?.currency).toBe("INR");
    expect(describeRazorpayMandate(tok("card"), "usd")?.currency).toBe("USD");
  });

  it("a card with no registration payment has no currency, so a token event cannot write INR", async () => {
    expect(describeRazorpayMandate(tok("card"))?.currency).toBeUndefined();
    const [ev] = await deliver({
      event: "token.confirmed",
      created_at: 1786681800,
      payload: { token: { entity: tok("card") } },
    });
    expect(ev?.mandate?.currency).toBeUndefined();
    expect(ev?.mandate?.maxAmountMinor).toBe(50_000n);
  });
});

describe("token statuses that end a mandate read as dead", () => {
  it.each(["cancellation_initiated", "expired"])("%s → cancelled", async (status) => {
    expect(normaliseRazorpayMandateStatus(status)).toBe("cancelled");
    expect(
      describeRazorpayMandate({ id: "token_m", recurring: true, recurring_details: { status } })
        ?.status,
    ).toBe("cancelled");
    const [ev] = await deliver({
      event: "token.cancelled",
      created_at: 1786681800,
      payload: { token: { entity: { id: "token_m", recurring_details: { status } } } },
    });
    expect(ev?.mandate?.status).toBe("cancelled");
  });

  it("leaves the documented statuses alone", () => {
    for (const s of ["initiated", "confirmed", "rejected", "cancelled", "paused"])
      expect(normaliseRazorpayMandateStatus(s)).toBe(s);
  });
});

describe("order notes stay inside RazorPay's limits", () => {
  it("keeps 15 pairs of at most 256 characters, our tag included", async () => {
    const seen = stubFetch([
      { match: isOrderCreate, answer: { json: { id: "order_n" } } },
      { match: (m, u) => m === "GET" && u.includes("/customers/"), answer: { json: {} } },
    ]);
    const metadata = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`k${i}`, "v".repeat(400)]),
    );
    await rzp().createIntent({
      purpose: "payment",
      currency: "INR",
      amountMinor: 5000n,
      customer: CUSTOMER,
      idempotencyKey: "pi_notes",
      ownershipRef: "pi_notes_ref",
      session: "on_session",
      metadata,
      description: "d".repeat(1000),
      methodTypes: ["card"],
    });
    const order = seen.find((r) => isOrderCreate(r.method, r.url));
    const notes = (JSON.parse(order!.body!) as { notes: Record<string, string> }).notes;
    expect(Object.keys(notes).length).toBeLessThanOrEqual(15);
    for (const v of Object.values(notes)) expect(v.length).toBeLessThanOrEqual(256);
    expect(notes.tmbilling_ref).toBe("pi_notes_ref");
  });
});
