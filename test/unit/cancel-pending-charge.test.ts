/**
 * `cancelPendingCharge` reports what the gateway OBSERVED, never what the call returned.
 * A `cancelled` the gateway did not confirm would book a debit as stopped while it collects.
 * Shapes follow each gateway's documented payment object. Live sandbox proofs for
 * GoCardless, Mollie and Stripe ran separately (see docs/PROGRESS.md).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { GoCardlessProvider } from "@/providers/gocardless";
import { CashfreeProvider, cashfreePaymentId, subChargeRef } from "@/providers/cashfree";
import { MollieProvider } from "@/providers/mollie";
import { StripeProvider } from "@/providers/stripe";

interface Stub {
  match: (method: string, url: string) => boolean;
  status?: number;
  json: unknown;
}

function stubFetch(stubs: Stub[]): string[] {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: { method?: string }) => {
    const url =
      typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    const method = (init?.method ?? "GET").toUpperCase();
    seen.push(`${method} ${url}`);
    const hit = stubs.find((s) => s.match(method, url));
    if (!hit) throw new Error(`unstubbed gateway call: ${method} ${url}`);
    return new Response(JSON.stringify(hit.json), {
      status: hit.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

const KEY = { idempotencyKey: "cancel-debit-pay_XXXXXXXXXXXX01" };

describe("GoCardless", () => {
  const gc = () =>
    new GoCardlessProvider({
      accessToken: "sandbox_x",
      livemode: false,
      apiBase: "https://gc.test",
    });

  it("a payment cancelled before submission is cancelled", async () => {
    const seen = stubFetch([
      {
        match: (m, u) => m === "POST" && u.endsWith("/payments/PM01/actions/cancel"),
        json: { payments: { id: "PM01", status: "cancelled" } },
      },
    ]);
    const r = await gc().cancelPendingCharge({ providerChargeId: "PM01", ...KEY });
    expect(r.status).toBe("cancelled");
    expect(seen).toEqual(["POST https://gc.test/payments/PM01/actions/cancel"]);
  });

  it("a submitted payment answers cancellation_failed and stays not_cancelable", async () => {
    stubFetch([
      {
        match: (m, u) => m === "POST" && u.endsWith("/actions/cancel"),
        status: 422,
        json: {
          error: { message: "cancellation failed", errors: [{ reason: "cancellation_failed" }] },
        },
      },
      {
        match: (m, u) => m === "GET" && u.endsWith("/payments/PM02"),
        json: { payments: { id: "PM02", status: "submitted" } },
      },
    ]);
    const r = await gc().cancelPendingCharge({ providerChargeId: "PM02", ...KEY });
    expect(r.status).toBe("not_cancelable");
  });

  it("a repeat cancel on a cancelled payment answers cancelled again", async () => {
    stubFetch([
      {
        match: (m, u) => m === "POST" && u.endsWith("/actions/cancel"),
        status: 422,
        json: { error: { errors: [{ reason: "cancellation_failed" }] } },
      },
      {
        match: (m, u) => m === "GET" && u.endsWith("/payments/PM03"),
        json: { payments: { id: "PM03", status: "cancelled" } },
      },
    ]);
    const r = await gc().cancelPendingCharge({ providerChargeId: "PM03", ...KEY });
    expect(r.status).toBe("cancelled");
  });

  it("a confirmed payment is already_final with a succeeded charge", async () => {
    stubFetch([
      {
        match: (m, u) => m === "POST" && u.endsWith("/actions/cancel"),
        status: 422,
        json: { error: { errors: [{ reason: "cancellation_failed" }] } },
      },
      {
        match: (m, u) => m === "GET" && u.endsWith("/payments/PM04"),
        json: { payments: { id: "PM04", status: "confirmed" } },
      },
    ]);
    const r = await gc().cancelPendingCharge({ providerChargeId: "PM04", ...KEY });
    expect(r.status).toBe("already_final");
    expect(r.charge?.status).toBe("succeeded");
  });
});

describe("Cashfree", () => {
  const cf = () =>
    new CashfreeProvider({
      appId: "app_x",
      secretKey: "secret_x",
      livemode: false,
      apiBase: "https://cf.test/pg",
    });
  const sid = "tms_0123456789abcdef";
  const pid = cashfreePaymentId(sid, "inv_1_attempt_1");
  const ref = subChargeRef(pid);
  const manage = (m: string, u: string) => m === "POST" && u.endsWith(`/payments/${pid}/manage`);
  const read = (m: string, u: string) =>
    m === "GET" && u.endsWith(`/subscriptions/${sid}/payments/${pid}`);

  it("cancels a subscription payment and reads back CANCELLED", async () => {
    const seen = stubFetch([
      { match: manage, json: { payment_id: pid, payment_status: "CANCELLED" } },
      { match: read, json: { payment_id: pid, payment_status: "CANCELLED" } },
    ]);
    const r = await cf().cancelPendingCharge({ providerChargeId: ref, ...KEY });
    expect(r.status).toBe("cancelled");
    expect(seen[0]).toContain(`/subscriptions/${sid}/payments/${pid}/manage`);
  });

  it("a 2xx that reads back still pending is NOT a cancel", async () => {
    stubFetch([
      { match: manage, json: { payment_id: pid, payment_status: "PENDING" } },
      { match: read, json: { payment_id: pid, payment_status: "PENDING" } },
    ]);
    const r = await cf().cancelPendingCharge({ providerChargeId: ref, ...KEY });
    expect(r.status).toBe("not_cancelable");
  });

  it("a payment that already succeeded is already_final", async () => {
    stubFetch([
      { match: manage, status: 400, json: { message: "payment cannot be cancelled" } },
      { match: read, json: { payment_id: pid, payment_status: "SUCCESS" } },
    ]);
    const r = await cf().cancelPendingCharge({ providerChargeId: ref, ...KEY });
    expect(r.status).toBe("already_final");
    expect(r.charge?.status).toBe("succeeded");
  });

  it("a PG order has no pending debit to cancel, and makes no call", async () => {
    const seen = stubFetch([]);
    const r = await cf().cancelPendingCharge({ providerChargeId: "ord:tmo_x:123", ...KEY });
    expect(r.status).toBe("not_cancelable");
    expect(seen).toEqual([]);
  });
});

describe("Mollie", () => {
  const mollie = () =>
    new MollieProvider({ apiKey: "test_x", livemode: false, apiBase: "https://mollie.test/v2" });
  const amount = { value: "10.00", currency: "EUR" };

  it("a cancelable payment is cancelled by DELETE", async () => {
    const seen = stubFetch([
      {
        match: (m, u) => m === "DELETE" && u.endsWith("/payments/tr_01"),
        json: { id: "tr_01", status: "canceled", amount },
      },
    ]);
    const r = await mollie().cancelPendingCharge({ providerChargeId: "tr_01", ...KEY });
    expect(r.status).toBe("cancelled");
    expect(seen).toEqual(["DELETE https://mollie.test/v2/payments/tr_01"]);
  });

  it("a 422 on a payment still pending is not_cancelable", async () => {
    stubFetch([
      {
        match: (m, u) => m === "DELETE" && u.endsWith("/payments/tr_02"),
        status: 422,
        json: {
          status: 422,
          title: "Unprocessable Entity",
          detail: "The payment cannot be canceled",
        },
      },
      {
        match: (m, u) => m === "GET" && u.endsWith("/payments/tr_02"),
        json: { id: "tr_02", status: "pending", amount },
      },
    ]);
    const r = await mollie().cancelPendingCharge({ providerChargeId: "tr_02", ...KEY });
    expect(r.status).toBe("not_cancelable");
  });

  it("a paid payment is already_final", async () => {
    stubFetch([
      {
        match: (m, u) => m === "DELETE" && u.endsWith("/payments/tr_03"),
        status: 422,
        json: { status: 422, detail: "The payment cannot be canceled" },
      },
      {
        match: (m, u) => m === "GET" && u.endsWith("/payments/tr_03"),
        json: { id: "tr_03", status: "paid", amount },
      },
    ]);
    const r = await mollie().cancelPendingCharge({ providerChargeId: "tr_03", ...KEY });
    expect(r.status).toBe("already_final");
    expect(r.charge?.status).toBe("succeeded");
  });
});

describe("Stripe", () => {
  const pi = (status: string, type: string) => ({
    id: "pi_XXXXXXXXXXXX01",
    object: "payment_intent",
    status,
    amount: 1000,
    currency: "eur",
    payment_method: { id: "pm_XXXXXXXXXXXX01", object: "payment_method", type },
  });

  it("cancels a processing SEPA debit and reads back canceled", async () => {
    let cancelled = false;
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: { method?: string }) => {
      const url = String((input as { url?: string })?.url ?? input);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push(`${method} ${url.split("?")[0]}`);
      if (method === "POST" && url.includes("/cancel")) cancelled = true;
      const body = pi(cancelled ? "canceled" : "processing", "sepa_debit");
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const r = await new StripeProvider("sk_test_x").cancelPendingCharge({
      providerChargeId: "pi_XXXXXXXXXXXX01",
      ...KEY,
    });
    expect(r.status).toBe("cancelled");
    expect(seen.some((c) => c.startsWith("POST") && c.endsWith("/cancel"))).toBe(true);
  });

  it("never asks to cancel a processing card payment", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: { method?: string }) => {
      seen.push(
        `${(init?.method ?? "GET").toUpperCase()} ${String((input as { url?: string })?.url ?? input)}`,
      );
      return new Response(JSON.stringify(pi("processing", "card")), { status: 200 });
    });
    const r = await new StripeProvider("sk_test_x").cancelPendingCharge({
      providerChargeId: "pi_XXXXXXXXXXXX01",
      ...KEY,
    });
    expect(r.status).toBe("not_cancelable");
    expect(seen.every((c) => c.startsWith("GET"))).toBe(true);
  });

  it("a debit that succeeded is already_final", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify(pi("succeeded", "sepa_debit")), { status: 200 }),
    );
    const r = await new StripeProvider("sk_test_x").cancelPendingCharge({
      providerChargeId: "pi_XXXXXXXXXXXX01",
      ...KEY,
    });
    expect(r.status).toBe("already_final");
    expect(r.charge?.status).toBe("succeeded");
  });
});
