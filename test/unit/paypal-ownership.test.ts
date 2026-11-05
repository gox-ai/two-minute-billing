/**
 * PayPal: ownership tagging (#31) and "was money actually held" (#30).
 *
 * ⚠️ THE UNPROVEN ADAPTER. PayPal has delivered **0 of the 35,135** provider webhook
 * events this box has ever received (Stripe 31,710, RazorPay 2,253, tmtest 1,172), so
 * nothing here is corroborated by real traffic. That is precisely why these cases exist:
 * they are the only evidence that the bytes we send carry a tag and that the answers we
 * derive from the bytes we get back stop at what PayPal actually said.
 *
 * Every case drives the REAL adapter through a stubbed `fetch` — the assertions are
 * about the request bodies we emit and the verdicts we compute, never about a
 * hand-written double that could agree with a bug. The webhook cases go through the
 * genuine signature path (a self-signed cert generated here, PayPal's own
 * `id|time|webhook_id|crc32(body)` message), so a normalization assertion cannot pass
 * on a payload the adapter would have rejected in production.
 *
 * Mutation targets are marked ⚠️ — reverting the named change must turn THAT case red
 * while its sibling stays green.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { createSign } from "node:crypto";
import { crc32 } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PayPalProvider,
  PAYPAL_OWNERSHIP_PREFIX,
  PAYPAL_HEALTHCHECK_OWNERSHIP_REF,
} from "@/providers/paypal";
import type { ProviderPaymentMethodRef } from "@/providers/types";
import { ProviderIndeterminateError, ProviderRefusalError } from "@/providers/types";

// ── HTTP harness (same shape as provider-adapters.test.ts) ───────────────────

interface Stub {
  match: (method: string, url: string, body: string | undefined) => boolean;
  status?: number;
  json?: unknown;
  text?: string;
}

interface Recorded {
  method: string;
  url: string;
  body: string | undefined;
  /** As SENT — #41 asserts the `PayPal-Request-Id` differs between two refund attempts. */
  headers: Record<string, string>;
}

/**
 * Answer from `stubs`, record what was asked. Deliberately strict: an unmatched call
 * REJECTS rather than returning a plausible empty body, because "{}" reads as a
 * successful gateway call in exactly this kind of code.
 */
function stubFetch(stubs: Stub[]): Recorded[] {
  const seen: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    async (
      input: unknown,
      init?: { method?: string; body?: unknown; headers?: Record<string, string> },
    ) => {
      const url =
        typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? init.body : undefined;
      seen.push({ method, url, body, headers: { ...(init?.headers ?? {}) } });
      const hit = stubs.find((s) => s.match(method, url, body));
      if (!hit) throw new Error(`unstubbed gateway call: ${method} ${url}`);
      const status = hit.status ?? 200;
      // PayPal's void answers **204 No Content**, and `Response` refuses a body with one
      // — so the stub has to be able to reproduce a genuinely empty answer. Faking it
      // with `200 {}` would hide whether the adapter copes with no body at all.
      const answer =
        status === 204 || status === 205 || status === 304
          ? null
          : (hit.text ?? JSON.stringify(hit.json ?? {}));
      return new Response(answer, {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  );
  return seen;
}

const WEBHOOK_ID = "WH-TEST-ID";

const paypal = () =>
  new PayPalProvider({
    clientId: "cid",
    clientSecret: "csec",
    apiBase: "https://api.sandbox.paypal.test",
    webhookId: WEBHOOK_ID,
  });

const OAUTH: Stub = {
  match: (m, u) => m === "POST" && u.includes("/v1/oauth2/token"),
  json: { access_token: "tok", expires_in: 3600 },
};

const VAULTED_CARD: ProviderPaymentMethodRef = {
  providerKey: "paypal",
  providerPaymentMethodId: "vault_tok_1",
  display: { type: "card", brand: "visa", last4: "4242" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The purchase unit we actually sent, parsed back out of the recorded request. */
function sentPurchaseUnit(seen: Recorded[], urlPart = "/v2/checkout/orders"): any {
  const call = seen.find((c) => c.method === "POST" && c.url.endsWith(urlPart));
  if (!call?.body) throw new Error(`no POST ${urlPart} recorded`);
  return JSON.parse(call.body).purchase_units?.[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// #31 · every create path stamps `custom_id`
//
// The classifier's rule is "created after tagging shipped and carries no tag ⇒
// provably not ours". That is only sound if EVERY create path stamps a ref — one
// untagged path and the rule starts calling our own money foreign. So these cases
// enumerate the create paths rather than testing one of them.
// ─────────────────────────────────────────────────────────────────────────────

describe("#31 · PayPal create paths carry an ownership tag", () => {
  const ORDER_CREATED: Stub = {
    match: (m, u) => m === "POST" && u.endsWith("/v2/checkout/orders"),
    json: {
      id: "ord_1",
      status: "COMPLETED",
      purchase_units: [{ payments: { captures: [{ id: "cap_1", status: "COMPLETED" }] } }],
    },
  };

  it("charge() tags the order — even though ChargeInput has no ownershipRef field", async () => {
    // ⚠️ MUTATION TARGET: drop `custom_id` from `charge`'s purchase unit.
    // The contract only added `ownershipRef` to CreateIntentInput, so the tag here is
    // derived from the idempotency key — which the contract already defines as mapping
    // 1:1 to a tmbilling payment attempt, i.e. it is our own id and nobody else's.
    const seen = stubFetch([OAUTH, ORDER_CREATED]);
    await paypal().charge({
      amountMinor: 2500n,
      currency: "usd",
      customer: { providerKey: "paypal", providerCustomerId: "cus_alice" },
      paymentMethod: VAULTED_CARD,
      idempotencyKey: "inv_123_attempt_1_pm_9",
    });
    expect(sentPurchaseUnit(seen).custom_id).toBe(
      `${PAYPAL_OWNERSHIP_PREFIX}inv_123_attempt_1_pm_9`,
    );
  });

  it("createIntent(payment) tags the order with the ownershipRef it was given", async () => {
    const seen = stubFetch([
      OAUTH,
      {
        match: (m, u) => m === "POST" && u.endsWith("/v2/checkout/orders"),
        json: { id: "ord_2", status: "APPROVED" },
      },
    ]);
    await paypal().createIntent({
      purpose: "payment",
      ownershipRef: "pi_abc123",
      amountMinor: 4200n,
      currency: "USD",
      customer: { providerKey: "paypal", providerCustomerId: "cus_alice" },
      paymentMethod: VAULTED_CARD,
      idempotencyKey: "idem_1",
    });
    expect(sentPurchaseUnit(seen).custom_id).toBe(`${PAYPAL_OWNERSHIP_PREFIX}pi_abc123`);
  });

  it("createIntent(payment) tags UNCONDITIONALLY — a missing ownershipRef falls back to ours", async () => {
    // ⚠️ MUTATION TARGET: make the tag conditional (`...(ref ? {custom_id} : {})`).
    // A single untagged create path invalidates the classifier's whole rule, so
    // "the caller forgot to pass a ref" must not produce an untagged order.
    const seen = stubFetch([
      OAUTH,
      {
        match: (m, u) => m === "POST" && u.endsWith("/v2/checkout/orders"),
        json: { id: "ord_3", status: "APPROVED" },
      },
    ]);
    await paypal().createIntent({
      purpose: "payment",
      amountMinor: 4200n,
      currency: "USD",
      customer: { providerKey: "paypal", providerCustomerId: "cus_alice" },
      idempotencyKey: "idem_no_ref",
    });
    expect(sentPurchaseUnit(seen).custom_id).toBe(`${PAYPAL_OWNERSHIP_PREFIX}idem_no_ref`);
  });

  it("healthCheck() tags its probe order — it creates a REAL PayPal order", async () => {
    // This one is easy to forget and it is a create path like any other: an untagged
    // $5 probe order on a shared PayPal account is indistinguishable from a sibling
    // product's, so the classifier would count our own probes as foreign traffic.
    const seen = stubFetch([
      OAUTH,
      {
        match: (m, u) => m === "POST" && u.endsWith("/v2/checkout/orders"),
        json: { id: "ord_hc", status: "CREATED" },
      },
    ]);
    await paypal().healthCheck();
    expect(sentPurchaseUnit(seen).custom_id).toBe(
      `${PAYPAL_OWNERSHIP_PREFIX}${PAYPAL_HEALTHCHECK_OWNERSHIP_REF}`,
    );
  });

  /**
   * The one create path that CANNOT carry `custom_id`, asserted rather than left
   * silent: a Vault v3 setup token has no purchase unit and so no `custom_id` field.
   * Its ownership binding is `customer.merchant_customer_id` — the field
   * `assertSetupTokenBelongsTo` already enforces. Sending a `custom_id` PayPal does
   * not document on this resource would risk a rejected vault for no gain.
   */
  it("the setup-token path is bound by merchant_customer_id, NOT custom_id", async () => {
    const seen = stubFetch([
      OAUTH,
      {
        match: (m, u) => m === "POST" && u.endsWith("/v3/vault/setup-tokens"),
        json: { id: "st_1", links: [{ rel: "approve", href: "https://paypal.test/a" }] },
      },
    ]);
    await paypal().initiateVaultSetup({
      customer: { providerKey: "paypal", providerCustomerId: "cus_alice" },
      returnUrl: "https://tm.test/r",
      cancelUrl: "https://tm.test/c",
    });
    const body = JSON.parse(
      seen.find((c) => c.url.endsWith("/v3/vault/setup-tokens"))!.body!,
    ) as Record<string, any>;
    expect(body.customer.merchant_customer_id).toBe("cus_alice");
    expect(body.custom_id).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #30 · `held` — was the buyer's money ACTUALLY held when we voided?
//
// PayPal answers this from the AUTHORIZATION, which is the resource its void
// endpoint takes: an authorization existing at all means a hold was placed. What it
// does NOT answer is what an authorization we never read was doing, and those cases
// must come back `undefined` — never `false`, which the engine would book as "no
// reversal needed" on no evidence.
// ─────────────────────────────────────────────────────────────────────────────

describe("#30 · PayPal voidIntent reports whether funds were held", () => {
  const order = (json: unknown, status = 200): Stub => ({
    match: (m, u) => m === "GET" && u.includes("/v2/checkout/orders/"),
    status,
    json,
  });
  const voidOk: Stub = {
    match: (m, u) => m === "POST" && u.includes("/void"),
    status: 204,
    text: "",
  };

  it("held: true — the order carries a live (CREATED) authorization", async () => {
    stubFetch([
      OAUTH,
      order({
        id: "ord_1",
        status: "APPROVED",
        purchase_units: [{ payments: { authorizations: [{ id: "auth_1", status: "CREATED" }] } }],
      }),
      voidOk,
    ]);
    const res = await paypal().voidIntent({ intentId: "ord_1", idempotencyKey: "k1" });
    expect(res).toMatchObject({ voided: true, held: true });
  });

  it("held: false — the order was never authorized, so there is nothing to release", async () => {
    // THE #21 CASE, and the only reason this defect is worth fixing on PayPal: a buyer
    // abandoned the approval, no authorization was ever created, and the engine used to
    // book a `payment_reversal` for a hold the bank never took (63 of 102 reversals in
    // the dev database are this shape). Two independent facts have to agree before we
    // say `false`: the order read SUCCEEDED, and the order's own status is a
    // pre-authorization one. A truncated `payments` block alone cannot fake that.
    stubFetch([
      OAUTH,
      order({ id: "ord_2", status: "APPROVED", purchase_units: [{}] }),
      { match: (m, u) => m === "POST" && u.includes("/void"), status: 404, json: {} },
    ]);
    const res = await paypal().voidIntent({ intentId: "ord_2", idempotencyKey: "k2" });
    expect(res.held).toBe(false);
  });

  it("held: undefined — the authorization was ALREADY voided, so we cannot say what it was before", async () => {
    // Matches the tmtest reference implementation's `already_voided` verdict: guessing
    // "not held" here is the error the field exists to prevent.
    stubFetch([
      OAUTH,
      order({
        id: "ord_3",
        status: "APPROVED",
        purchase_units: [{ payments: { authorizations: [{ id: "auth_3", status: "VOIDED" }] } }],
      }),
      {
        match: (m, u) => m === "POST" && u.includes("/void"),
        status: 422,
        json: { details: [{ issue: "AUTHORIZATION_ALREADY_VOIDED" }] },
      },
    ]);
    const res = await paypal().voidIntent({ intentId: "ord_3", idempotencyKey: "k3" });
    expect(res.voided).toBe(true);
    expect(res.held).toBeUndefined();
    expect("held" in res ? res.held : "absent").not.toBe(false);
  });

  it("held: undefined — a VOIDED authorization is not a hold, even if the void is accepted", async () => {
    // ⚠️ MUTATION TARGET: add `VOIDED` to the held-status set. Its sibling above goes
    // through the idempotent branch (which withdraws a stale `true` on its own), so
    // without this case the status SET itself is unpinned — a mutation adding `VOIDED`
    // to it stayed green. Here PayPal accepts the call, so the set is the only thing
    // deciding the answer.
    stubFetch([
      OAUTH,
      order({
        id: "ord_v",
        status: "APPROVED",
        purchase_units: [{ payments: { authorizations: [{ id: "auth_v", status: "VOIDED" }] } }],
      }),
      voidOk,
    ]);
    const res = await paypal().voidIntent({ intentId: "ord_v", idempotencyKey: "k8" });
    expect(res.voided).toBe(true);
    expect(res.held).toBeUndefined();
  });

  it("held: undefined — a PENDING authorization is not a hold PayPal has confirmed", async () => {
    // ⚠️ MUTATION TARGET: widen the held-status set to "any authorization exists".
    // PayPal's PENDING authorization (risk review) does not establish that funds are
    // held, and we have never seen one here — so it must read as ignorance.
    stubFetch([
      OAUTH,
      order({
        id: "ord_4",
        status: "APPROVED",
        purchase_units: [{ payments: { authorizations: [{ id: "auth_4", status: "PENDING" }] } }],
      }),
      voidOk,
    ]);
    const res = await paypal().voidIntent({ intentId: "ord_4", idempotencyKey: "k4" });
    expect(res.voided).toBe(true);
    expect(res.held).toBeUndefined();
  });

  it("held: undefined — a live authorization we read, but the void found nothing to release", async () => {
    // ⚠️ MUTATION TARGET: pass `held` through on the idempotent branch. We read
    // `CREATED` a moment ago and the gateway then said there is nothing here — someone
    // else voided it in between, or our read was stale. Reporting `true` would claim a
    // release we did not perform; the claim is withdrawn rather than asserted.
    // (Added after the implementation, unlike its siblings — proven load-bearing by
    // that mutation rather than by having been red first.)
    stubFetch([
      OAUTH,
      order({
        id: "ord_race",
        status: "APPROVED",
        purchase_units: [{ payments: { authorizations: [{ id: "auth_r", status: "CREATED" }] } }],
      }),
      {
        match: (m, u) => m === "POST" && u.includes("/void"),
        status: 404,
        json: { name: "RESOURCE_NOT_FOUND" },
      },
    ]);
    const res = await paypal().voidIntent({ intentId: "ord_race", idempotencyKey: "k7" });
    expect(res.voided).toBe(true);
    expect(res.held).toBeUndefined();
  });

  it("held: true — an intentId that is itself an AUTHORIZATION id, read before voiding", async () => {
    // The fallback path (a caller replaying from PAYMENT.AUTHORIZATION.CREATED). The
    // order read has already failed, so reading the authorization costs nothing on the
    // common path and is the only way this path can answer at all.
    stubFetch([
      OAUTH,
      order({ name: "RESOURCE_NOT_FOUND" }, 404),
      {
        match: (m, u) => m === "GET" && u.includes("/v2/payments/authorizations/"),
        json: { id: "auth_5", status: "CREATED" },
      },
      voidOk,
    ]);
    const res = await paypal().voidIntent({ intentId: "auth_5", idempotencyKey: "k5" });
    expect(res).toMatchObject({ voided: true, held: true });
  });

  it("neither the order nor the authorization could be read — nothing is voided, and it says so", async () => {
    // ⚠️ REWRITTEN BY #32. This case used to assert `voided: true, held: undefined`,
    // which is the defect itself written down as an expectation: `held` was honest,
    // but the void it reported had been posted to `/v2/payments/authorizations/
    // mystery_id/void` — an id nothing proved was an authorization — and answered from
    // the 404. `held: undefined` is still the right answer; there is now no `voided`
    // at all, because the call never reached an authorization. See the #32 block below.
    stubFetch([
      OAUTH,
      order({ name: "RESOURCE_NOT_FOUND" }, 404),
      {
        match: (m, u) => m === "GET" && u.includes("/v2/payments/authorizations/"),
        status: 404,
        json: { name: "RESOURCE_NOT_FOUND" },
      },
      voidOk,
    ]);
    await expect(
      paypal().voidIntent({ intentId: "mystery_id", idempotencyKey: "k6" }),
    ).rejects.toThrow(/could not be resolved/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #32 · a void that never reached an authorization must not report one
//
// The void endpoint takes an AUTHORIZATION id (`POST /v2/payments/authorizations/
// {id}/void`). `voidIntent` is handed an INTENT id, which for a payment intent is the
// ORDER id, so the authorization has to be RESOLVED first. When that resolution fails
// the adapter used to fall back to the intent id and post the ORDER id to the
// authorization endpoint — PayPal 404s, the 404 is forgiven as "already gone", and the
// caller is told `voided: true` while the buyer's funds are still held.
//
// The rule these cases pin: `voided: true` is returned only when we can point at a
// specific resolution — an authorization we actually voided (or that PayPal says is
// already gone), or proof from the order itself that no authorization ever existed.
// Anything else throws, because `voided: false` reads to both callers as "the gateway
// refused" and we never asked. Neither shape may construct a void request at all.
// ─────────────────────────────────────────────────────────────────────────────

describe("#32 · PayPal voidIntent never reports a void it did not perform", () => {
  const orderStub = (json: unknown, status = 200): Stub => ({
    match: (m, u) => m === "GET" && u.includes("/v2/checkout/orders/"),
    status,
    json,
  });
  const voidOk: Stub = {
    match: (m, u) => m === "POST" && u.includes("/void"),
    status: 204,
    text: "",
  };
  /** Every void POST the adapter actually emitted. */
  const voidCalls = (seen: Recorded[]) =>
    seen.filter((c) => c.method === "POST" && c.url.includes("/void"));

  it("throws when the order read fails TRANSIENTLY and the id is not an authorization", async () => {
    // ⚠️ THE DEFECT. A real order with a live authorization, whose GET happens to
    // answer 500. The old code posted `/v2/payments/authorizations/ord_live/void` —
    // the ORDER id — took the 404 as "already voided" and returned `voided: true`
    // while the hold survived. There is no request to send here: we do not know which
    // authorization to void, and `voided: false` would be read as "the gateway
    // refused" when the gateway was never asked.
    const seen = stubFetch([
      OAUTH,
      orderStub({ name: "INTERNAL_SERVER_ERROR" }, 500),
      {
        match: (m, u) => m === "GET" && u.includes("/v2/payments/authorizations/"),
        status: 404,
        json: { name: "RESOURCE_NOT_FOUND" },
      },
      voidOk,
    ]);
    await expect(
      paypal().voidIntent({ intentId: "ord_live", idempotencyKey: "k32a" }),
    ).rejects.toThrow(/could not be resolved/i);
    // ⚠️ MUTATION TARGET: restore the `?? input.intentId` fallback. The throw alone
    // does not prove we stopped sending it — this does.
    expect(voidCalls(seen)).toHaveLength(0);
  });

  it("throws rather than voiding when the order carries an authorization with no id", async () => {
    // The same resolution failure from the other direction: PayPal listed an
    // authorization (so a hold may well exist — this one reads CREATED) but gave us no
    // id for it. The old code posted the ORDER id, and the 404 branch withdrew `held`
    // to `undefined` while still answering `voided: true` — the worst shape available,
    // a live hold reported as a completed release.
    const seen = stubFetch([
      OAUTH,
      orderStub({
        id: "ord_noid",
        status: "COMPLETED",
        purchase_units: [{ payments: { authorizations: [{ status: "CREATED" }] } }],
      }),
      voidOk,
    ]);
    await expect(
      paypal().voidIntent({ intentId: "ord_noid", idempotencyKey: "k32b" }),
    ).rejects.toThrow(/could not be resolved/i);
    expect(voidCalls(seen)).toHaveLength(0);
  });

  it("throws when the order was read but its status is not proof that nothing was held", async () => {
    // A COMPLETED order with no authorization listed is a CAPTURE-intent order whose
    // money already moved. The old code answered `voided: true, held: undefined` — the
    // engine then marks the intent voided and stops, with the capture standing. This is
    // the same reasoning the adapter already applies to AUTHORIZATION_ALREADY_CAPTURED
    // ("money moved, and reporting that as released would hide a real capture"), which
    // the no-authorization branch was not applying.
    const seen = stubFetch([
      OAUTH,
      orderStub({ id: "ord_done", status: "COMPLETED", purchase_units: [{ payments: {} }] }),
      voidOk,
    ]);
    await expect(
      paypal().voidIntent({ intentId: "ord_done", idempotencyKey: "k32c" }),
    ).rejects.toThrow(/could not be resolved/i);
    expect(voidCalls(seen)).toHaveLength(0);
  });

  it("an order provably never authorized answers voided WITHOUT calling the void endpoint", async () => {
    // ⚠️ MUTATION TARGET: this is the #21 shape (63 of 102 dev reversals) and it must
    // keep answering `voided: true, held: false` — refusing here would strand the
    // operator's Void action on the commonest case, and there is provably nothing held.
    // What changes is that no HTTP call is made: PayPal has no "void an order"
    // endpoint, so the old 404-then-forgive round trip was a request that could only
    // ever fail, and its forgiveness is what made the defect above reachable.
    const seen = stubFetch([
      OAUTH,
      orderStub({ id: "ord_never", status: "APPROVED", purchase_units: [{}] }),
      voidOk,
    ]);
    const res = await paypal().voidIntent({ intentId: "ord_never", idempotencyKey: "k32d" });
    expect(res).toMatchObject({ voided: true, held: false });
    expect(voidCalls(seen)).toHaveLength(0);
  });

  it("a transient order failure still voids when the id IS proven to be an authorization", async () => {
    // The fallback path must survive the fix: the probe answering 2xx is what licenses
    // the POST, and the id it posts is the one the probe proved. Distinct from its #30
    // sibling (order 404) — here the order read fails with a 500, so "the order lookup
    // failed" is not by itself evidence of anything.
    const seen = stubFetch([
      OAUTH,
      orderStub({ name: "INTERNAL_SERVER_ERROR" }, 500),
      {
        match: (m, u) => m === "GET" && u.includes("/v2/payments/authorizations/"),
        json: { id: "auth_32", status: "CREATED" },
      },
      voidOk,
    ]);
    const res = await paypal().voidIntent({ intentId: "auth_32", idempotencyKey: "k32e" });
    expect(res).toMatchObject({ voided: true, held: true });
    expect(voidCalls(seen).map((c) => c.url)).toEqual([
      expect.stringContaining("/v2/payments/authorizations/auth_32/void"),
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #31 · inbound: ours / foreign / unknown, and the object's OWN creation time
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// #42 — the throw #32 introduced has to have an HTTP shape, and it has to mean
// "we cannot say", not "nothing happened to the money".
//
// `ProviderIndeterminateError` carries exactly the meaning `VoidIntentResult.held ===
// undefined` carries one layer down, so these cases pin BOTH halves: the class (which
// is what lets the route answer 502 rather than 500) and the sentence (which must not
// smuggle in a claim about a buyer's funds — #21 through the error channel).
// ─────────────────────────────────────────────────────────────────────────────

describe("#42 · an unresolved authorization throws INDETERMINATE, and says only that", () => {
  const orderStub = (json: unknown, status = 200): Stub => ({
    match: (m, u) => m === "GET" && u.includes("/v2/checkout/orders/"),
    status,
    json,
  });
  const voidOk: Stub = {
    match: (m, u) => m === "POST" && u.includes("/void"),
    status: 204,
    text: "",
  };

  /**
   * Does this sentence make a claim about the MONEY? "We could not confirm whether the
   * hold was released" and "the hold was not released" are the same length and opposite
   * statements, and only the first is something we know.
   */
  const claimsAboutMoney = (m: string) =>
    /\b(?:was|were) (?:not )?(?:released|refunded|captured|held)\b/i.test(m) ||
    /\bnothing (?:is|was) held\b/i.test(m) ||
    /\bfunds (?:are|were) (?:still )?(?:held|released)\b/i.test(m);

  it("the phrasing predicate is not vacuous", () => {
    // Without this the assertion below would pass on any message at all.
    expect(claimsAboutMoney("the hold was not released")).toBe(true);
    expect(claimsAboutMoney("the buyer's funds are still held")).toBe(true);
    expect(claimsAboutMoney("nothing was held")).toBe(true);
    expect(claimsAboutMoney("the authorization could not be resolved, so no void was sent")).toBe(
      false,
    );
  });

  /** The three shapes #32 refuses to void — each must throw the SAME class. */
  const unresolvable: Array<[string, Stub[], string]> = [
    [
      "a transient order-read failure on an id that is not an authorization",
      [
        OAUTH,
        orderStub({ name: "INTERNAL_SERVER_ERROR" }, 500),
        {
          match: (m, u) => m === "GET" && u.includes("/v2/payments/authorizations/"),
          status: 404,
          json: { name: "RESOURCE_NOT_FOUND" },
        },
        voidOk,
      ],
      "ord_live42",
    ],
    [
      "an authorization listed with no id",
      [
        OAUTH,
        orderStub({
          id: "ord_noid42",
          status: "COMPLETED",
          purchase_units: [{ payments: { authorizations: [{ status: "CREATED" }] } }],
        }),
        voidOk,
      ],
      "ord_noid42",
    ],
    [
      "an order whose status is not proof that nothing was held",
      [
        OAUTH,
        orderStub({ id: "ord_done42", status: "COMPLETED", purchase_units: [{ payments: {} }] }),
        voidOk,
      ],
      "ord_done42",
    ],
  ];

  for (const [label, stubs, intentId] of unresolvable) {
    it(`throws ProviderIndeterminateError: ${label}`, async () => {
      stubFetch(stubs);
      // ⚠️ MUTATION TARGET: revert to `throw new Error(...)` and this goes red while
      // the #32 cases above stay green — they only ever asserted that SOMETHING threw,
      // which is exactly how the 500 survived.
      const err = await paypal()
        .voidIntent({ intentId, idempotencyKey: `k42-${intentId}` })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(ProviderIndeterminateError);
      // The mirror must not collapse: a refusal is a 400, and this is not a refusal.
      expect(err).not.toBeInstanceOf(ProviderRefusalError);
      const message = (err as Error).message;
      expect(message).toMatch(/could not be resolved/i);
      expect(claimsAboutMoney(message)).toBe(false);
    });
  }

  it("the order that provably never authorized still returns, and never throws", async () => {
    // The #21 shape stays a RETURN (`held: false`) — indeterminacy is the other branch,
    // and turning this one into a 502 would strand the operator's Void action on the
    // commonest case in the database.
    stubFetch([
      OAUTH,
      orderStub({ id: "ord_never42", status: "APPROVED", purchase_units: [{}] }),
      voidOk,
    ]);
    const res = await paypal().voidIntent({ intentId: "ord_never42", idempotencyKey: "k42d" });
    expect(res).toMatchObject({ voided: true, held: false });
  });
});

describe("#31 · PayPal webhook normalization reports ownership", () => {
  let certPem: string;
  let keyPem: string;
  const CERT_URL = "https://api.paypal.com/v1/notifications/certs/CERT-TEST";

  beforeAll(() => {
    // A real RSA keypair + self-signed leaf, so the webhook cases go through the
    // adapter's genuine signature verification rather than around it.
    const dir = mkdtempSync(join(tmpdir(), "paypal-ownership-"));
    const key = join(dir, "k.pem");
    const cert = join(dir, "c.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "2",
        "-nodes",
        "-subj",
        "/CN=api.paypal.com",
      ],
      { stdio: "pipe" },
    );
    keyPem = readFileSync(key, "utf8");
    certPem = readFileSync(cert, "utf8");
  });

  /** Sign a body exactly the way PayPal does: id|time|webhook_id|crc32(raw body). */
  function deliver(event: unknown) {
    const body = JSON.stringify(event);
    const transmissionId = "tid-1";
    const transmissionTime = "2026-09-04T00:00:00Z";
    const message = `${transmissionId}|${transmissionTime}|${WEBHOOK_ID}|${crc32(Buffer.from(body, "utf8"))}`;
    const signer = createSign("sha256");
    signer.update(message, "utf8");
    signer.end();
    const headers = {
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": CERT_URL,
      "paypal-transmission-id": transmissionId,
      "paypal-transmission-time": transmissionTime,
      "paypal-transmission-sig": signer.sign(keyPem, "base64"),
    };
    stubFetch([{ match: (m, u) => m === "GET" && u === CERT_URL, text: certPem }]);
    return paypal().normalizeWebhook({ payload: body, headers });
  }

  const captureEvent = (resource: Record<string, unknown>) => ({
    id: "WH-EVT-1",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    // The EVENT's time — deliberately different from the resource's, because reading
    // this as the object's age is the bug `providerObjectCreatedAt` exists to prevent.
    create_time: "2026-09-04T09:00:00Z",
    resource: { id: "cap_1", ...resource },
  });

  it("ours — the capture carries our prefixed tag, and the bare ref is handed back", async () => {
    const [ev] = await deliver(captureEvent({ custom_id: `${PAYPAL_OWNERSHIP_PREFIX}pi_abc123` }));
    expect(ev!.ownership).toBe("ours");
    expect(ev!.ownershipRef).toBe("pi_abc123");
  });

  it("foreign — a tag was read and it is somebody else's", async () => {
    // ⚠️ MUTATION TARGET: treat any `custom_id` as ours. PayPal's `custom_id` is a
    // single UNNAMESPACED string (unlike Stripe `metadata.tmbilling_ref` / RazorPay
    // `notes.tmbilling_ref`, where the KEY is the namespace), so any other system
    // stamping that field on the same PayPal account would otherwise read as ours.
    // The namespace has to live in the VALUE.
    const [ev] = await deliver(captureEvent({ custom_id: "OrderInvoice-23_10_2024" }));
    expect(ev!.ownership).toBe("foreign");
    expect(ev!.ownershipRef).toBeUndefined();
  });

  it("only object kinds we actually TAG may answer foreign", async () => {
    // ⚠️ MUTATION TARGET: let every resource answer `foreign` on a non-ours tag.
    // We stamp `custom_id` on ORDERS only, so order-lineage objects (the order, its
    // authorization, its capture) are the only kinds where "a tag was read and it is
    // not ours" is evidence of anything. A refund, a dispute or a vault token we never
    // tag must answer `unknown` even when it carries somebody's `custom_id` — claiming
    // `foreign` for a kind we never tag would turn a money incident into a line nobody
    // reads. Same reasoning G1a applied on Stripe's untaggable inputs.
    const [capture] = await deliver(captureEvent({ custom_id: "someone-elses" }));
    expect(capture!.ownership).toBe("foreign");

    const [refund] = await deliver({
      id: "WH-EVT-6",
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      create_time: "2026-09-04T09:00:00Z",
      resource: {
        id: "ref_2",
        custom_id: "someone-elses",
        amount: { value: "1.00", currency_code: "USD" },
        links: [{ rel: "up", href: "https://api.paypal.test/v2/payments/captures/cap_8" }],
      },
    });
    expect(refund!.ownership).toBe("unknown");

    const [token] = await deliver({
      id: "WH-EVT-7",
      event_type: "VAULT.PAYMENT-TOKEN.CREATED",
      create_time: "2026-09-04T09:00:00Z",
      resource: { id: "vault_tok_2", custom_id: "someone-elses" },
    });
    expect(token!.ownership).toBe("unknown");
  });

  it("unknown — no tag at all, which is NOT the same as foreign", async () => {
    // An untagged object may be ours from before tagging shipped. Only the engine can
    // decide, by comparing `providerObjectCreatedAt` against the tagging deploy — so
    // the adapter must admit ignorance instead of voting.
    const [ev] = await deliver(captureEvent({}));
    expect(ev!.ownership).toBe("unknown");
    expect(ev!.ownershipRef).toBeUndefined();
  });

  it("parses the RESOURCE's ISO-8601 create_time, not the event's", async () => {
    // ⚠️ MUTATION TARGET: fall back to `event.create_time`. PayPal's create_time is an
    // ISO-8601 STRING (Stripe and RazorPay both use epoch integers), so a copied
    // implementation would produce an Invalid Date here.
    const [ev] = await deliver(captureEvent({ create_time: "2026-08-01T10:20:30Z" }));
    expect(ev!.providerObjectCreatedAt?.toISOString()).toBe("2026-08-01T10:20:30.000Z");
    expect(ev!.occurredAt.toISOString()).toBe("2026-09-04T09:00:00.000Z");
  });

  it("reports no creation time rather than an Invalid Date", async () => {
    const [absent] = await deliver(captureEvent({}));
    expect(absent!.providerObjectCreatedAt).toBeUndefined();
    const [garbage] = await deliver(captureEvent({ create_time: "not-a-date" }));
    expect(garbage!.providerObjectCreatedAt).toBeUndefined();
  });

  it("reads the tag off an ORDER resource's purchase unit (CHECKOUT.ORDER.APPROVED)", async () => {
    // The order event's resource IS the order, so the tag sits where we stamped it —
    // one level down, on the purchase unit.
    const [ev] = await deliver({
      id: "WH-EVT-2",
      event_type: "CHECKOUT.ORDER.APPROVED",
      create_time: "2026-09-04T09:00:00Z",
      resource: {
        id: "ord_9",
        create_time: "2026-09-03T08:00:00Z",
        purchase_units: [{ custom_id: `${PAYPAL_OWNERSHIP_PREFIX}pi_order` }],
      },
    });
    expect(ev!.type).toBe("intent.authorized");
    expect(ev!.ownership).toBe("ours");
    expect(ev!.ownershipRef).toBe("pi_order");
    expect(ev!.providerObjectCreatedAt?.toISOString()).toBe("2026-09-03T08:00:00.000Z");
  });

  it("hands back the ORDER id a capture belongs to, so matching needs no tag and no call", async () => {
    // The tag is the fallback, not the mechanism. `supplementary_data.related_ids`
    // carries the order (and authorization) a capture came from, which is the id the
    // engine already stores in `payment_intents.intent_at_gateway` — so an untagged
    // capture of ours is still matchable, inline, with no extra gateway call.
    const [ev] = await deliver(
      captureEvent({ supplementary_data: { related_ids: { order_id: "ord_match_me" } } }),
    );
    expect(ev!.type).toBe("charge.succeeded");
    expect(ev!.providerIntentId).toBe("ord_match_me");
    expect(ev!.providerChargeId).toBe("cap_1");
  });

  it("carries provenance on the vault-token and dispute branches as well", async () => {
    // The last two of the five return sites. Neither resource has a `custom_id` field
    // we stamp — a vault token's binding is `customer.merchant_customer_id` and a
    // dispute is PayPal's own object — so `unknown` is the honest answer here, and the
    // creation time still comes off the resource.
    const [token] = await deliver({
      id: "WH-EVT-4",
      event_type: "VAULT.PAYMENT-TOKEN.CREATED",
      create_time: "2026-09-04T09:00:00Z",
      resource: { id: "vault_tok_1", create_time: "2026-09-01T06:00:00Z" },
    });
    expect(token!.type).toBe("payment_method.updated");
    expect(token!.ownership).toBe("unknown");
    expect(token!.providerObjectCreatedAt?.toISOString()).toBe("2026-09-01T06:00:00.000Z");

    const [dispute] = await deliver({
      id: "WH-EVT-5",
      event_type: "CUSTOMER.DISPUTE.CREATED",
      create_time: "2026-09-04T09:00:00Z",
      resource: {
        dispute_id: "PP-D-1",
        create_time: "2026-08-20T05:00:00Z",
        status: "OPEN",
        dispute_amount: { value: "10.00", currency_code: "USD" },
      },
    });
    expect(dispute!.type).toBe("dispute.created");
    expect(dispute!.ownership).toBe("unknown");
    expect(dispute!.providerObjectCreatedAt?.toISOString()).toBe("2026-08-20T05:00:00.000Z");
  });

  it("carries ownership on the refund branch too, not just the default one", async () => {
    // `normalizeWebhook` returns from five different places; a tag resolved in one of
    // them is a tag missing from four. This pins the branch that has its own return.
    const [ev] = await deliver({
      id: "WH-EVT-3",
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      create_time: "2026-09-04T09:00:00Z",
      resource: {
        id: "ref_1",
        create_time: "2026-09-02T07:00:00Z",
        custom_id: `${PAYPAL_OWNERSHIP_PREFIX}pi_refunded`,
        amount: { value: "10.00", currency_code: "USD" },
        links: [{ rel: "up", href: "https://api.paypal.test/v2/payments/captures/cap_7" }],
      },
    });
    expect(ev!.type).toBe("charge.refunded");
    expect(ev!.ownership).toBe("ours");
    expect(ev!.ownershipRef).toBe("pi_refunded");
    expect(ev!.providerObjectCreatedAt?.toISOString()).toBe("2026-09-02T07:00:00.000Z");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // #33 / #34 / #35 · the event types that were normalizing to `unknown`.
  //
  // Two of these are branch-dependent, and that is the point: a map entry alone
  // emits `providerChargeId: r.id` from the generic fall-through, which on a refund
  // resource is a REFUND id and on a vault token is a token id. Both handlers guard
  // on a DIFFERENT field (`providerRefundId`, `providerPaymentMethodId`), so the
  // mapping would be "done" and the event would still do nothing — exactly the
  // pre-existing Stripe defect found this wave, where `payment_method.detached` had
  // been mapped with no branch since the adapter was written and had therefore never
  // once marked an instrument invalid. So these assert the FIELD the handler reads,
  // not just the `type`.
  // ───────────────────────────────────────────────────────────────────────────

  it("#33 · a PENDING capture is named, and its custom_id is read", async () => {
    // ⚠️ MUTATION TARGET: remove the PAYMENT.CAPTURE.PENDING map entry.
    const [ev] = await deliver({
      id: "WH-EVT-P1",
      event_type: "PAYMENT.CAPTURE.PENDING",
      create_time: "2026-09-04T09:00:00Z",
      resource: {
        id: "cap_pending_1",
        custom_id: `${PAYPAL_OWNERSHIP_PREFIX}pi_pending`,
        status: "PENDING",
        supplementary_data: { related_ids: { order_id: "ord_pending" } },
      },
    });
    expect(ev!.type).toBe("charge.pending");
    expect(ev!.providerChargeId).toBe("cap_pending_1");
    expect(ev!.providerIntentId).toBe("ord_pending");
    expect(ev!.ownership).toBe("ours"); // the whole point of #33
    expect(ev!.ownershipRef).toBe("pi_pending");
  });

  it("a pending capture must never settle a transaction", async () => {
    // ⚠️ MUTATION TARGET: map PAYMENT.CAPTURE.PENDING to charge.succeeded.
    const [ev] = await deliver({
      id: "WH-EVT-P2",
      event_type: "PAYMENT.CAPTURE.PENDING",
      create_time: "2026-09-04T09:00:00Z",
      resource: { id: "cap_pending_2", status: "PENDING" },
    });
    expect(ev!.type).not.toBe("charge.succeeded");
  });

  it("a REVERSED capture is money taken back — not a refund of ours", async () => {
    // ⚠️ MUTATION TARGET: map PAYMENT.CAPTURE.REVERSED to charge.refunded. That routes
    // it to `applyRefund`, which books a refund + credit note against the customer's
    // invoice for money the customer never asked for and never received.
    const [ev] = await deliver({
      id: "WH-EVT-R1",
      event_type: "PAYMENT.CAPTURE.REVERSED",
      create_time: "2026-09-04T09:00:00Z",
      resource: { id: "cap_rev_1", status: "REVERSED" },
    });
    expect(ev!.type).toBe("charge.reversed");
    expect(ev!.providerChargeId).toBe("cap_rev_1");
    expect(["charge.refunded", "charge.failed"]).not.toContain(ev!.type);
  });

  it("a FAILED refund reaches the reversal path, correlated on the REFUND id", async () => {
    // ⚠️ MUTATION TARGET: delete the refund branch. `reverseFailedRefund` returns
    // "ignored" on its first line without a providerRefundId, so the mapping alone is
    // inert — this is the assertion that proves the branch is load-bearing.
    const [ev] = await deliver({
      id: "WH-EVT-RF1",
      event_type: "PAYMENT.REFUND.FAILED",
      create_time: "2026-09-04T09:00:00Z",
      resource: {
        id: "ref_failed_1",
        status: "FAILED",
        amount: { value: "12.50", currency_code: "USD" },
        links: [{ rel: "up", href: "https://api.paypal.test/v2/payments/captures/cap_9" }],
      },
    });
    expect(ev!.type).toBe("refund.failed");
    expect(ev!.providerRefundId).toBe("ref_failed_1");
    expect(ev!.providerChargeId).toBe("cap_9");
    expect(ev!.amountRefundedMinor).toBe(1250n);
  });

  it("a PENDING refund is not a failed one", async () => {
    // ⚠️ MUTATION TARGET: map PAYMENT.REFUND.PENDING to refund.failed — that would
    // REVERSE a refund booking on a refund that is merely slow.
    const [ev] = await deliver({
      id: "WH-EVT-RP1",
      event_type: "PAYMENT.REFUND.PENDING",
      create_time: "2026-09-04T09:00:00Z",
      resource: { id: "ref_pending_1", status: "PENDING" },
    });
    expect(ev!.type).toBe("refund.pending");
    expect(ev!.providerRefundId).toBe("ref_pending_1");
  });

  it("a reversed payment approval closes the INTENT, keyed on the order id", async () => {
    // ⚠️ MUTATION TARGET: revert the orderId special-case. Without it the `up`-link
    // fallback runs on an order resource, correlates to nothing, and the event is
    // mapped but inert.
    const [ev] = await deliver({
      id: "WH-EVT-A1",
      event_type: "CHECKOUT.PAYMENT-APPROVAL.REVERSED",
      create_time: "2026-09-04T09:00:00Z",
      resource: { id: "ord_reversed_1", status: "APPROVED" },
    });
    expect(ev!.type).toBe("intent.voided");
    expect(ev!.providerIntentId).toBe("ord_reversed_1");
  });

  it("a deleted vault token carries the PAYMENT-METHOD id, not a charge id", async () => {
    // ⚠️ MUTATION TARGET: delete the detach branch. The inbound dispatcher guards on
    // `providerPaymentMethodId`, so without it the mapping is inert — exactly the
    // pre-existing Stripe defect this wave found.
    const [ev] = await deliver({
      id: "WH-EVT-V1",
      event_type: "VAULT.PAYMENT-TOKEN.DELETED",
      create_time: "2026-09-04T09:00:00Z",
      resource: { id: "vault_tok_gone" },
    });
    expect(ev!.type).toBe("payment_method.detached");
    expect(ev!.providerPaymentMethodId).toBe("vault_tok_gone");
    expect(ev!.providerChargeId).toBeUndefined();
  });

  it("DELETION-INITIATED stays unmapped, deliberately", async () => {
    // A request, not an outcome. Marking an instrument invalid on a delete that may
    // never complete pushes the customer onto a backup card for nothing; `.DELETED` is
    // the outcome and it is mapped.
    const [ev] = await deliver({
      id: "WH-EVT-V2",
      event_type: "VAULT.PAYMENT-TOKEN.DELETION-INITIATED",
      create_time: "2026-09-04T09:00:00Z",
      resource: { id: "vault_tok_going" },
    });
    expect(ev!.type).toBe("unknown");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #41 · refund() may be handed an ORDER id, and it posts to a CAPTURES endpoint
//
// `charge()` returns the CAPTURE id when the order completed synchronously and the
// ORDER id when it did not (`captureResult`'s `fallbackId`, plus the pending /
// `requires_action` fallback); `consumeIntent` does the same. PayPal ids are opaque
// 17-character strings with no prefix, so `refund()` cannot tell which one it holds.
//
// Unlike #32 this never fabricated success — a non-2xx maps to `status: "failed"`, so a
// wrong id failed HONESTLY. The fix is to make the refund SUCCEED where it failed for a
// resolvable reason, reusing `fetchChargeStatus`'s shape (try the capture, and only on a
// 404 read the capture out of the order's purchase unit) rather than inventing a second.
//
// Two properties are load-bearing and each has its own case:
//  · the happy path stays at ONE call — the resolution is opt-in, on a 404 only.
//  · the retry's `PayPal-Request-Id` DIFFERS from the first attempt's (or PayPal
//    replays the cached 404 per its own "returns the latest status of the previous
//    request that used that same header") yet is DERIVED, not random (or two engine
//    retries of one refund become two refunds).
// ─────────────────────────────────────────────────────────────────────────────

describe("#41 · PayPal refund resolves an order id to its capture", () => {
  const refundPost = (id: string): string => `/v2/payments/captures/${id}/refund`;

  const REFUND_OK = (capId: string, refundId = "ref_1"): Stub => ({
    match: (m, u) => m === "POST" && u.endsWith(refundPost(capId)),
    status: 201,
    json: { id: refundId, status: "COMPLETED" },
  });
  /** PayPal's answer when the id is not a capture at all. */
  const REFUND_404 = (id: string): Stub => ({
    match: (m, u) => m === "POST" && u.endsWith(refundPost(id)),
    status: 404,
    json: { name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }] },
  });
  const ORDER_WITH_CAPTURE = (ordId: string, capId: string): Stub => ({
    match: (m, u) => m === "GET" && u.endsWith(`/v2/checkout/orders/${ordId}`),
    json: {
      id: ordId,
      status: "COMPLETED",
      purchase_units: [{ payments: { captures: [{ id: capId, status: "COMPLETED" }] } }],
    },
  });

  const refundInput = (providerChargeId: string, idempotencyKey = "rf_key_1") => ({
    providerChargeId,
    amountMinor: 1250n,
    currency: "USD",
    idempotencyKey,
  });

  const refundPosts = (seen: Recorded[]) =>
    seen.filter((c) => c.method === "POST" && c.url.includes("/refund"));
  const orderGets = (seen: Recorded[]) =>
    seen.filter((c) => c.method === "GET" && c.url.includes("/v2/checkout/orders/"));
  const requestIds = (seen: Recorded[]) =>
    refundPosts(seen).map((c) => c.headers["PayPal-Request-Id"]);

  /**
   * ── #48 · A REFUND IS ITS OWN GATEWAY OBJECT AND INHERITS NO TAG ───────────────
   *
   * `RefundInput.ownershipRef` has existed since #31 and the engine passes it (`re_…`,
   * the public id of the refund row), but this adapter never sent it — so every PayPal
   * Refund we create is untagged. RazorPay stamps its refund via `notes`, and its
   * source-scan test locks that; PayPal had the field and dropped it.
   *
   * ⚠️ The consequence is BLINDNESS, not a false accusation, and the difference matters:
   * this adapter reads an ABSENT `custom_id` as `unknown` ("ignorance, never 'not
   * ours'") and only a `custom_id` present WITHOUT our prefix as `foreign`. So an
   * untagged refund of ours lands in `unclassified` — it can never be positively
   * identified as ours, and therefore can never reach `ours_unattributed`, the one
   * population that pages.
   *
   * `custom_id` is a DOCUMENTED request-body field on
   * `POST /v2/payments/captures/{id}/refund` — "The API caller-provided external ID.
   * Used to reconcile API caller-initiated transactions with PayPal transactions",
   * max 127 chars (verified against the endpoint reference 2026-09-04, because a web
   * SEARCH summary claimed the opposite; the schema page is authoritative and an
   * unknown field on a refund is a refund a customer does not get back).
   */
  const refundBody = (seen: Recorded[]) =>
    refundPosts(seen).map((c) => JSON.parse(c.body ?? "{}") as Record<string, unknown>);

  it("#48 stamps our ownership tag on the refund it creates", async () => {
    // ⚠️ MUTATION TARGET: drop `custom_id` from the refund body.
    const seen = stubFetch([OAUTH, REFUND_OK("cap_48")]);
    const res = await paypal().refund({
      ...refundInput("cap_48", "rf_key_48"),
      ownershipRef: "re_abc123",
    });
    expect(res.status).toBe("succeeded");
    expect(refundBody(seen)[0]!.custom_id).toBe("tmbilling_ref:re_abc123");
  });

  it("#48 …and the amount is still sent alongside it", async () => {
    // The tag must not displace the money. A partial refund without `amount` becomes a
    // FULL refund at PayPal, so a tagging bug here would over-refund.
    const seen = stubFetch([OAUTH, REFUND_OK("cap_48b")]);
    await paypal().refund({
      ...refundInput("cap_48b", "rf_key_48b"),
      ownershipRef: "re_abc124",
    });
    const body = refundBody(seen)[0]!;
    expect(body.amount).toEqual({ value: "12.50", currency_code: "USD" });
    expect(body.custom_id).toBe("tmbilling_ref:re_abc124");
  });

  it("#48 sends NO custom_id when the engine passed no ref", async () => {
    // Deliberately not falling back to the idempotency key here: an absent tag reads
    // `unknown` on this adapter, which is honest. A key-derived tag would read as OURS
    // and defeat exact-ref matching for no gain.
    const seen = stubFetch([OAUTH, REFUND_OK("cap_48c")]);
    await paypal().refund(refundInput("cap_48c", "rf_key_48c"));
    expect(refundBody(seen)[0]!.custom_id).toBeUndefined();
  });

  it("#48 the tag survives the order-id resolution path too", async () => {
    // The 404-then-resolve retry must carry the tag on the SECOND post, not just the
    // first — otherwise exactly the refunds that needed resolving stay untagged.
    const seen = stubFetch([
      OAUTH,
      REFUND_404("ord_48"),
      ORDER_WITH_CAPTURE("ord_48", "cap_48d"),
      REFUND_OK("cap_48d"),
    ]);
    const res = await paypal().refund({
      ...refundInput("ord_48", "rf_key_48d"),
      ownershipRef: "re_abc125",
    });
    expect(res.status).toBe("succeeded");
    expect(refundPosts(seen)).toHaveLength(2);
    expect(refundBody(seen)[1]!.custom_id).toBe("tmbilling_ref:re_abc125");
  });

  it("refunds a capture id in ONE call and never asks about an order", async () => {
    // ⚠️ MUTATION TARGET: make the order resolution unconditional. This case is the
    // whole reason it is not — the common id IS a capture id, and #31's
    // `resolveOwnership` is opt-in for exactly this reason.
    const seen = stubFetch([OAUTH, REFUND_OK("cap_1")]);
    const res = await paypal().refund(refundInput("cap_1"));
    expect(res.status).toBe("succeeded");
    expect(res.providerRefundId).toBe("ref_1");
    expect(refundPosts(seen)).toHaveLength(1);
    expect(orderGets(seen)).toHaveLength(0);
  });

  it("resolves an ORDER id to its capture and refunds THAT", async () => {
    // ⚠️ MUTATION TARGET: delete the 404 branch. The refund then fails honestly —
    // which is the defect: the money stays with PayPal for a reason we could resolve.
    const seen = stubFetch([
      OAUTH,
      REFUND_404("ord_1"),
      ORDER_WITH_CAPTURE("ord_1", "cap_7"),
      REFUND_OK("cap_7", "ref_7"),
    ]);
    const res = await paypal().refund(refundInput("ord_1"));
    expect(res.status).toBe("succeeded");
    expect(res.providerRefundId).toBe("ref_7");
    // The order was read ONCE, and only after the capture attempt failed.
    expect(orderGets(seen)).toHaveLength(1);
    const posts = refundPosts(seen);
    expect(posts).toHaveLength(2);
    expect(posts[0]!.url).toContain(refundPost("ord_1"));
    expect(posts[1]!.url).toContain(refundPost("cap_7"));
    expect(seen.indexOf(posts[0]!)).toBeLessThan(seen.indexOf(orderGets(seen)[0]!));
  });

  /**
   * THE MONEY ASSERTION. PayPal documents that a repeated `PayPal-Request-Id` "returns
   * the latest status of the previous request that used that same header", and that the
   * value "must be unique for both each request and an API call type" — so reusing the
   * first attempt's id on the retry risks replaying the cached 404 and the fix does
   * nothing. A random one would fix that and break something worse: two engine retries
   * of the SAME refund would carry two ids and could refund twice.
   *
   * So the retry's id must be DIFFERENT from the first attempt's and DERIVED from the
   * same `idempotencyKey`. Both halves are asserted, and the second across two separate
   * `refund()` calls, because determinism is only observable that way.
   */
  it("retries under a DIFFERENT request id, derived from the same idempotency key", async () => {
    const stubs = [
      OAUTH,
      REFUND_404("ord_2"),
      ORDER_WITH_CAPTURE("ord_2", "cap_8"),
      REFUND_OK("cap_8", "ref_8"),
    ];
    const first = stubFetch(stubs);
    await paypal().refund(refundInput("ord_2", "rf_key_same"));
    const idsA = requestIds(first);
    expect(idsA).toHaveLength(2);
    // ⚠️ MUTATION TARGET: pass `input.idempotencyKey` on the retry. PayPal would answer
    // the retry with the cached 404 and the whole fix would be inert.
    expect(idsA[1]).not.toBe(idsA[0]);
    expect(idsA[0]).toBe("rf_key_same");

    vi.unstubAllGlobals();
    const second = stubFetch(stubs);
    await paypal().refund(refundInput("ord_2", "rf_key_same"));
    // ⚠️ MUTATION TARGET: make the retry id random (a uuid / Date.now()). Same refund,
    // same key, two different ids at PayPal — two refunds.
    expect(requestIds(second)).toEqual(idsA);
  });

  it("keeps both request ids inside PayPal's 65-char cap, still distinct", async () => {
    // A real engine key is longer than the cap (`collectInvoice` builds ~69 chars), so
    // BOTH ids are hashed by `boundedProviderKey`. ⚠️ MUTATION TARGET: send `requestId`
    // unbounded — a 66-char `PayPal-Request-Id` is a 422 with no detail at all
    // (measured live 2026-07-27), so this would fail EVERY refund on a real key.
    //
    // What this case does NOT catch, measured: appending the discriminator AFTER
    // bounding instead of before. That was written up as a truncation collision and it
    // is not one — `boundedProviderKey` hashes rather than truncates, so the appended
    // form is 39 + 14 = 53 chars, still distinct and still under the cap.
    const longKey = `inv_${"9".repeat(60)}_attempt_1_pm`;
    expect(longKey.length).toBeGreaterThan(65);
    const seen = stubFetch([
      OAUTH,
      REFUND_404("ord_3"),
      ORDER_WITH_CAPTURE("ord_3", "cap_9"),
      REFUND_OK("cap_9", "ref_9"),
    ]);
    await paypal().refund(refundInput("ord_3", longKey));
    const ids = requestIds(seen);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) expect(id!.length).toBeLessThanOrEqual(65);
  });

  it("leaves a NON-404 refusal alone — it is a verdict, not an id problem", async () => {
    // A capture that is already fully refunded is PayPal answering the question. Asking
    // about an order here would spend a round trip to learn nothing and could re-post the
    // refund against a capture id we just resolved from the order it belongs to.
    const seen = stubFetch([
      OAUTH,
      {
        match: (m, u) => m === "POST" && u.endsWith(refundPost("cap_full")),
        status: 422,
        json: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "CAPTURE_FULLY_REFUNDED" }] },
      },
    ]);
    await expect(paypal().refund(refundInput("cap_full"))).rejects.toThrow(
      new ProviderRefusalError("PayPal refused the refund (CAPTURE_FULLY_REFUNDED)."),
    );
    expect(refundPosts(seen)).toHaveLength(1);
    expect(orderGets(seen)).toHaveLength(0);
  });

  it("fails honestly when the id is neither a capture nor a refundable order", async () => {
    // The order reads, but nothing was ever captured against it — so there is no capture
    // to refund and no second attempt to make. The FIRST failure is what the caller gets
    // back: it is the one about the refund, not about our lookup.
    const seen = stubFetch([
      OAUTH,
      REFUND_404("ord_empty"),
      {
        match: (m, u) => m === "GET" && u.endsWith("/v2/checkout/orders/ord_empty"),
        json: { id: "ord_empty", status: "APPROVED", purchase_units: [{}] },
      },
    ]);
    await expect(paypal().refund(refundInput("ord_empty"))).rejects.toThrow(
      /^PayPal refused the refund \(INVALID_RESOURCE_ID\)/,
    );
    expect(refundPosts(seen)).toHaveLength(1);
  });

  it("percent-encodes the id it puts in the path", async () => {
    // ⚠️ MUTATION TARGET: drop `encodeURIComponent`. `fetchChargeStatus` already encodes
    // both of its paths and `refund()` did not — a stored id carrying a `/` or a space
    // silently addressed a different endpoint.
    const weird = "cap 1/x";
    const seen = stubFetch([
      OAUTH,
      {
        match: (m, u) => m === "POST" && u.includes("/refund"),
        status: 201,
        json: { id: "ref_enc", status: "COMPLETED" },
      },
    ]);
    await paypal().refund(refundInput(weird));
    expect(refundPosts(seen)[0]!.url).toContain("/v2/payments/captures/cap%201%2Fx/refund");
  });

  it("never posts a second refund after PayPal ACCEPTED the first", async () => {
    // The paranoid shape: a 2xx whose body also carries a not-found-looking name. The
    // resolution must be unreachable, because the second post would refund the buyer
    // twice. ⚠️ MUTATION TARGET: drop the `status >= 300` half of the guard — the branch
    // then rests on a successful body happening not to carry a `name`.
    const seen = stubFetch([
      OAUTH,
      {
        match: (m, u) => m === "POST" && u.endsWith(refundPost("cap_odd")),
        status: 201,
        json: { id: "ref_odd", status: "COMPLETED", name: "RESOURCE_NOT_FOUND" },
      },
    ]);
    const res = await paypal().refund(refundInput("cap_odd"));
    expect(res.status).toBe("succeeded");
    expect(refundPosts(seen)).toHaveLength(1);
    expect(orderGets(seen)).toHaveLength(0);
  });

  it("sends the amount in the capture's own currency, unchanged by the retry", async () => {
    // The body must survive the second attempt — a retry that dropped it would turn a
    // partial refund into a FULL one, which is a different amount of the buyer's money.
    const seen = stubFetch([
      OAUTH,
      REFUND_404("ord_4"),
      ORDER_WITH_CAPTURE("ord_4", "cap_10"),
      REFUND_OK("cap_10", "ref_10"),
    ]);
    await paypal().refund({
      providerChargeId: "ord_4",
      amountMinor: 1250n,
      currency: "inr",
      idempotencyKey: "rf_key_amt",
    });
    for (const post of refundPosts(seen)) {
      expect(JSON.parse(post.body!)).toEqual({
        amount: { value: "12.50", currency_code: "INR" },
      });
    }
  });
});
