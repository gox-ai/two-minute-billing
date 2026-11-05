/**
 * Adapter-level guarantees for Stripe, PayPal and RazorPay that no integration suite
 * can reach without live sandbox credentials.
 *
 * Three findings are locked down here:
 *
 *  - **F-3 (ownership)** — the raw-token vault path (`POST /portal/v1/payment_methods
 *    { token }`) hands a client-supplied id straight to `vaultPaymentMethod`. Stripe
 *    already refused a pm attached to someone else; PayPal and RazorPay's `inv_…`
 *    shape did not. THE TEST IS THE EVIDENCE: each guard has a paired "wrong owner is
 *    refused" / "right owner is vaulted" case, so blinding the guard turns the first
 *    red while the second stays green — a guard that always throws is not a pass.
 *  - **F-8 (pollable charges)** — `fetchChargeStatus` on Stripe and PayPal, and in
 *    particular the direction it errs in: an unrecognised or non-terminal status is
 *    STILL IN FLIGHT. A poll that invents a failure marks a debit failed while the
 *    money is on its way.
 *  - **F-6 (mandate ceilings)** — Stripe reports a per-debit ceiling and PayPal has
 *    none, and `capabilities.mandates` now says which is which.
 *
 * Every case drives the real adapter through a stubbed `fetch`, so the assertions are
 * about the bytes we send and the answers we derive from the bytes we get — not about
 * a hand-written double that could agree with a bug.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { StripeProvider } from "@/providers/stripe";
import { describeStripeMandate } from "@/providers/stripe";
import { PayPalProvider } from "@/providers/paypal";
import { RazorpayProvider, assertAuthLinkBelongsTo, emandateReceipt } from "@/providers/razorpay";
import type { ProviderPaymentMethodRef } from "@/providers/types";
import { ProviderRefusalError } from "@/providers/types";

/** One stubbed HTTP exchange: match on method+path, answer with status+JSON. */
interface Stub {
  match: (method: string, url: string, body: string | undefined) => boolean;
  status?: number;
  json: unknown;
}

interface Recorded {
  method: string;
  url: string;
  body: string | undefined;
}

/**
 * Install a fetch that answers from `stubs` and records what was asked.
 *
 * Deliberately strict: an unmatched call REJECTS rather than returning a plausible
 * empty body. A test that silently exercises a path it did not stub proves nothing,
 * and the adapters are exactly the kind of code where "it returned {}" reads as a
 * successful gateway call.
 */
function stubFetch(stubs: Stub[]): Recorded[] {
  const seen: Recorded[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url =
      typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    seen.push({ method, url, body });
    const hit = stubs.find((s) => s.match(method, url, body));
    if (!hit) throw new Error(`unstubbed gateway call: ${method} ${url}`);
    return new Response(JSON.stringify(hit.json), {
      status: hit.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return seen;
}

const stripe = () => new StripeProvider("sk_test_x");
const paypal = () =>
  new PayPalProvider({
    clientId: "cid",
    clientSecret: "csec",
    apiBase: "https://api.sandbox.paypal.test",
  });
const razorpay = () =>
  new RazorpayProvider({
    keyId: "rzp_test_x",
    keySecret: "secret",
    apiBase: "https://api.razorpay.test/v1",
  });

/** PayPal's OAuth leg, needed by every PayPal call. */
const PAYPAL_OAUTH: Stub = {
  match: (m, u) => m === "POST" && u.includes("/v1/oauth2/token"),
  json: { access_token: "tok", expires_in: 3600 },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// F-3 — PayPal: a setup token is a bearer credential unless it is bound
// ─────────────────────────────────────────────────────────────────────────────

describe("F-3 · a PayPal setup token may only be vaulted by the customer it was minted for", () => {
  const setupTokenRead = (merchantCustomerId?: string): Stub => ({
    match: (m, u) => m === "GET" && u.includes("/v3/vault/setup-tokens/"),
    json: merchantCustomerId
      ? { id: "st_1", customer: { merchant_customer_id: merchantCustomerId } }
      : { id: "st_1" },
  });
  const exchange: Stub = {
    match: (m, u) => m === "POST" && u.includes("/v3/vault/payment-tokens"),
    json: { id: "vault_tok_1", payment_source: { paypal: { email_address: "a@b.test" } } },
  };

  it("vaults the instrument when the token names this customer", async () => {
    stubFetch([PAYPAL_OAUTH, setupTokenRead("cus_alice"), exchange]);
    const ref = await paypal().vaultPaymentMethod({
      customer: { providerKey: "paypal", providerCustomerId: "cus_alice" },
      token: "st_1",
    });
    expect(ref.providerPaymentMethodId).toBe("vault_tok_1");
  });

  /**
   * ⚠️ THE MUTATION TARGET. Blind `assertSetupTokenBelongsTo` — make it `return`
   * before comparing, or drop the call from `exchangeSetupToken` — and this case
   * goes red while the one above stays green.
   */
  it("refuses a token minted for a DIFFERENT customer", async () => {
    stubFetch([PAYPAL_OAUTH, setupTokenRead("cus_victim"), exchange]);
    await expect(
      paypal().vaultPaymentMethod({
        customer: { providerKey: "paypal", providerCustomerId: "cus_attacker" },
        token: "st_1",
      }),
    ).rejects.toThrow(/not created for this customer/i);
  });

  it("refuses a token carrying no binding at all — the guard fails CLOSED", async () => {
    stubFetch([PAYPAL_OAUTH, setupTokenRead(undefined), exchange]);
    await expect(
      paypal().vaultPaymentMethod({
        customer: { providerKey: "paypal", providerCustomerId: "cus_alice" },
        token: "st_1",
      }),
    ).rejects.toThrow(/not created for this customer/i);
  });

  it("refuses when the ownership read itself fails — 'cannot confirm' is not 'confirmed'", async () => {
    stubFetch([
      PAYPAL_OAUTH,
      {
        match: (m, u) => m === "GET" && u.includes("/v3/vault/setup-tokens/"),
        status: 404,
        json: {},
      },
      exchange,
    ]);
    await expect(
      paypal().vaultPaymentMethod({
        customer: { providerKey: "paypal", providerCustomerId: "cus_alice" },
        token: "st_1",
      }),
    ).rejects.toThrow(/could not be read for ownership verification/i);
  });

  it("never reaches the exchange call when ownership fails", async () => {
    const seen = stubFetch([PAYPAL_OAUTH, setupTokenRead("cus_victim"), exchange]);
    await expect(
      paypal().vaultPaymentMethod({
        customer: { providerKey: "paypal", providerCustomerId: "cus_attacker" },
        token: "st_1",
      }),
    ).rejects.toThrow();
    // Refusing AFTER minting the vault token would leave a permanent instrument at
    // PayPal bound to the victim's wallet — the check must gate the write, not audit it.
    expect(seen.some((r) => r.url.includes("/v3/vault/payment-tokens"))).toBe(false);
  });

  it("stamps the binding when it creates the setup token, or there is nothing to check", async () => {
    const seen = stubFetch([
      PAYPAL_OAUTH,
      {
        match: (m, u) => m === "POST" && u.includes("/v3/vault/setup-tokens"),
        json: { id: "st_1", links: [{ rel: "approve", href: "https://paypal.test/approve" }] },
      },
    ]);
    await paypal().initiateVaultSetup({
      customer: { providerKey: "paypal", providerCustomerId: "cus_alice" },
      returnUrl: "https://shop.test/ok",
      cancelUrl: "https://shop.test/no",
    });
    const create = seen.find(
      (r) => r.method === "POST" && r.url.includes("/v3/vault/setup-tokens"),
    );
    expect(JSON.parse(create!.body!).customer).toEqual({ merchant_customer_id: "cus_alice" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-3 — RazorPay: the `inv_` auth-link shape adopts the LINK's customer
// ─────────────────────────────────────────────────────────────────────────────

describe("F-3 · a RazorPay e-mandate auth link may only be vaulted by its own customer", () => {
  it("accepts the authoritative notes binding", () => {
    expect(() =>
      assertAuthLinkBelongsTo("inv_1", { notes: { tmbilling_ref: "cust_alice" } }, "cust_alice"),
    ).not.toThrow();
  });

  it("accepts the receipt-prefix fallback, which is what createEmandateAuthLink writes", () => {
    expect(() =>
      assertAuthLinkBelongsTo(
        "inv_1",
        { receipt: emandateReceipt("cust_alice", 1756500000) },
        "cust_alice",
      ),
    ).not.toThrow();
  });

  it("is not fooled by a customer id that merely PREFIXES ours", () => {
    // `emandate_cust_a_…` must not satisfy a check for `cust_ab`. The trailing
    // underscore in the stamped receipt is what makes the prefix unambiguous.
    expect(() =>
      assertAuthLinkBelongsTo(
        "inv_1",
        { receipt: emandateReceipt("cust_ab", 1756500000) },
        "cust_a",
      ),
    ).toThrow(/not created for this customer/i);
  });

  it("refuses a link bound to someone else", () => {
    expect(() =>
      assertAuthLinkBelongsTo(
        "inv_1",
        { notes: { tmbilling_ref: "cust_victim" } },
        "cust_attacker",
      ),
    ).toThrow(/not created for this customer/i);
  });

  it("refuses a link with no binding at all — fails CLOSED", () => {
    expect(() => assertAuthLinkBelongsTo("inv_1", {}, "cust_alice")).toThrow(
      /not created for this customer/i,
    );
  });

  /**
   * ⚠️ THE MUTATION TARGET for the wired-up path. Drop the `expectedCustomerId`
   * argument from `vaultPaymentMethod`'s `authLinkOutcome` call — or make
   * `assertAuthLinkBelongsTo` return early — and this case goes red while the
   * "vaults the mandate" case below stays green.
   */
  it("refuses through the real adapter when the link belongs to another buyer", async () => {
    stubFetch([
      {
        match: (m, u) => m === "GET" && u.includes("/invoices/inv_evil"),
        json: {
          payment_id: "pay_1",
          customer_id: "cust_victim",
          notes: { tmbilling_ref: "cust_victim" },
          receipt: emandateReceipt("cust_victim", 1756500000),
        },
      },
    ]);
    await expect(
      razorpay().vaultPaymentMethod({
        customer: { providerKey: "razorpay", providerCustomerId: "cust_attacker" },
        token: "inv_evil",
      }),
    ).rejects.toThrow(/not created for this customer/i);
  });

  it("vaults the mandate when the link is ours, adopting the link's own customer", async () => {
    stubFetch([
      {
        match: (m, u) => m === "GET" && u.includes("/invoices/inv_mine"),
        json: {
          payment_id: "pay_1",
          customer_id: "cust_rzp_minted",
          notes: { tmbilling_ref: "cust_alice" },
        },
      },
      {
        match: (m, u) => m === "GET" && u.includes("/payments/pay_1"),
        json: {
          status: "captured",
          token_id: "token_1",
          captured: true,
          customer_id: "cust_rzp_minted",
        },
      },
      {
        match: (m, u) => m === "GET" && u.includes("/customers/cust_rzp_minted/tokens/token_1"),
        json: {
          id: "token_1",
          method: "emandate",
          bank: "HDFC",
          recurring: true,
          max_amount: 6_600_000,
          recurring_details: { status: "confirmed" },
        },
      },
    ]);
    const ref = await razorpay().vaultPaymentMethod({
      customer: { providerKey: "razorpay", providerCustomerId: "cust_alice" },
      token: "inv_mine",
    });
    expect(ref.providerPaymentMethodId).toBe("token_1");
    // RazorPay mints its own customer for an auth link; the ref must carry it so the
    // engine charges the customer the token is actually scoped to.
    expect(ref.providerCustomerId).toBe("cust_rzp_minted");
    expect(ref.mandate?.maxAmountMinor).toBe(6_600_000n);
  });

  it("stamps both bindings on the auth link it creates", async () => {
    const seen = stubFetch([
      {
        match: (m, u) => m === "GET" && u.includes("/customers/cust_alice"),
        json: { name: "Alice", email: "a@b.test", contact: "+919000000000" },
      },
      {
        match: (m, u) => m === "POST" && u.includes("/subscription_registration/auth_links"),
        json: { id: "inv_1", short_url: "https://rzp.test/i/1" },
      },
    ]);
    await razorpay().initiateVaultSetup({
      customer: { providerKey: "razorpay", providerCustomerId: "cust_alice" },
      returnUrl: "https://shop.test/ok",
      cancelUrl: "https://shop.test/no",
      currency: "INR",
      methodTypes: ["bank_transfer"],
      maxAmountMinor: 5_000_000n,
    });
    const create = seen.find((r) => r.url.includes("/subscription_registration/auth_links"));
    const body = JSON.parse(create!.body!);
    expect(body.notes).toEqual({ tmbilling_ref: "cust_alice" });
    expect(String(body.receipt)).toMatch(/^emandate_cust_alice_\d+$/);
    // The receipt cap is 40 chars and boundedProviderKey HASHES past it — a hashed
    // receipt would destroy the fallback binding silently.
    expect(String(body.receipt).length).toBeLessThanOrEqual(40);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-8 — a pending charge must be pollable, and the poll must not invent failures
// ─────────────────────────────────────────────────────────────────────────────

describe("F-8 · Stripe fetchChargeStatus", () => {
  const pi = (over: Record<string, unknown>) => ({
    match: (m: string, u: string) => m === "GET" && u.includes("/v1/payment_intents/pi_1"),
    json: { id: "pi_1", object: "payment_intent", ...over },
  });

  it("is advertised at all — the sweep skips an adapter without it", () => {
    expect(typeof stripe().fetchChargeStatus).toBe("function");
  });

  it("settles a succeeded PaymentIntent", async () => {
    stubFetch([pi({ status: "succeeded" })]);
    const r = await stripe().fetchChargeStatus({ providerChargeId: "pi_1" });
    expect(r.status).toBe("succeeded");
    expect(r.providerChargeId).toBe("pi_1");
  });

  it("leaves an ACH/SEPA debit that is still `processing` alone", async () => {
    stubFetch([pi({ status: "processing" })]);
    expect((await stripe().fetchChargeStatus({ providerChargeId: "pi_1" })).status).toBe("pending");
  });

  it("fails a canceled intent, but normalizes the CODE rather than leaking Stripe's reason", async () => {
    stubFetch([pi({ status: "canceled", cancellation_reason: "abandoned" })]);
    const r = await stripe().fetchChargeStatus({ providerChargeId: "pi_1" });
    expect(r.status).toBe("failed");
    expect(r.failure?.code).toBe("charge_failed");
    expect(r.failure?.providerCode).toBe("abandoned");
  });

  it("fails requires_payment_method ONLY when a decline is attached", async () => {
    stubFetch([
      pi({
        status: "requires_payment_method",
        last_payment_error: {
          code: "insufficient_funds",
          message: "Your card has insufficient funds.",
        },
      }),
    ]);
    const r = await stripe().fetchChargeStatus({ providerChargeId: "pi_1" });
    expect(r.status).toBe("failed");
    expect(r.failure?.code).toBe("insufficient_funds");
    expect(r.failure?.retriable).toBe(true);
  });

  it("does NOT fail a requires_payment_method intent that was never confirmed", async () => {
    stubFetch([pi({ status: "requires_payment_method" })]);
    expect((await stripe().fetchChargeStatus({ providerChargeId: "pi_1" })).status).toBe("pending");
  });

  it("keeps an authorized-but-uncaptured intent in flight rather than calling it failed", async () => {
    stubFetch([pi({ status: "requires_capture" })]);
    expect((await stripe().fetchChargeStatus({ providerChargeId: "pi_1" })).status).toBe("pending");
  });

  it("rides an India e-mandate AFA challenge back as requires_action, not as a decline", async () => {
    stubFetch([pi({ status: "requires_action", next_action: { type: "use_stripe_sdk" } })]);
    const r = await stripe().fetchChargeStatus({ providerChargeId: "pi_1" });
    expect(r.status).toBe("requires_action");
  });

  it("treats a status this version has never seen as still in flight", async () => {
    stubFetch([pi({ status: "some_future_stripe_status" })]);
    expect((await stripe().fetchChargeStatus({ providerChargeId: "pi_1" })).status).toBe("pending");
  });
});

describe("F-8 · PayPal fetchChargeStatus", () => {
  const capture = (over: Record<string, unknown>, status = 200): Stub => ({
    match: (m, u) => m === "GET" && u.includes("/v2/payments/captures/"),
    status,
    json: { id: "cap_1", ...over },
  });

  it("is advertised at all", () => {
    expect(typeof paypal().fetchChargeStatus).toBe("function");
  });

  it("settles a COMPLETED capture", async () => {
    stubFetch([PAYPAL_OAUTH, capture({ status: "COMPLETED" })]);
    const r = await paypal().fetchChargeStatus({ providerChargeId: "cap_1" });
    expect(r.status).toBe("succeeded");
  });

  it("leaves a capture under review pending", async () => {
    stubFetch([
      PAYPAL_OAUTH,
      capture({ status: "PENDING", status_details: { reason: "PENDING_REVIEW" } }),
    ]);
    expect((await paypal().fetchChargeStatus({ providerChargeId: "cap_1" })).status).toBe(
      "pending",
    );
  });

  it("fails a DECLINED capture", async () => {
    stubFetch([PAYPAL_OAUTH, capture({ status: "DECLINED" })]);
    expect((await paypal().fetchChargeStatus({ providerChargeId: "cap_1" })).status).toBe("failed");
  });

  /**
   * The refund trap. A capture polled days later can read REFUNDED; the synchronous
   * mapping would call that "not COMPLETED" and therefore pending, and the sweep would
   * re-poll a settled payment forever.
   */
  it("reports a REFUNDED capture as SUCCEEDED — the charge landed, the refund is its own object", async () => {
    stubFetch([PAYPAL_OAUTH, capture({ status: "REFUNDED" })]);
    expect((await paypal().fetchChargeStatus({ providerChargeId: "cap_1" })).status).toBe(
      "succeeded",
    );
  });

  it("reports a PARTIALLY_REFUNDED capture as succeeded too", async () => {
    stubFetch([PAYPAL_OAUTH, capture({ status: "PARTIALLY_REFUNDED" })]);
    expect((await paypal().fetchChargeStatus({ providerChargeId: "cap_1" })).status).toBe(
      "succeeded",
    );
  });

  it("falls back to the ORDER when the id is not a capture id", async () => {
    // `charge()` returns the ORDER id whenever the order did not complete
    // synchronously, and PayPal ids carry no prefix to tell the two apart.
    stubFetch([
      PAYPAL_OAUTH,
      capture({ name: "RESOURCE_NOT_FOUND" }, 404),
      {
        match: (m, u) => m === "GET" && u.includes("/v2/checkout/orders/"),
        json: {
          id: "ord_1",
          status: "COMPLETED",
          purchase_units: [{ payments: { captures: [{ id: "cap_9", status: "COMPLETED" }] } }],
        },
      },
    ]);
    const r = await paypal().fetchChargeStatus({ providerChargeId: "ord_1" });
    expect(r.status).toBe("succeeded");
    expect(r.providerChargeId).toBe("cap_9");
  });

  it("keeps an order the buyer never approved pending rather than declaring it refused", async () => {
    stubFetch([
      PAYPAL_OAUTH,
      capture({ name: "RESOURCE_NOT_FOUND" }, 404),
      {
        match: (m, u) => m === "GET" && u.includes("/v2/checkout/orders/"),
        json: { id: "ord_1", status: "PAYER_ACTION_REQUIRED" },
      },
    ]);
    expect((await paypal().fetchChargeStatus({ providerChargeId: "ord_1" })).status).toBe(
      "pending",
    );
  });

  it("throws rather than guessing when neither resource can be read", async () => {
    stubFetch([
      PAYPAL_OAUTH,
      capture({ name: "RESOURCE_NOT_FOUND" }, 404),
      { match: (m, u) => m === "GET" && u.includes("/v2/checkout/orders/"), status: 404, json: {} },
    ]);
    await expect(paypal().fetchChargeStatus({ providerChargeId: "who_1" })).rejects.toThrow(
      /neither a readable capture/i,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-6 — mandate ceilings: real where the gateway has them, absent where it does not
// ─────────────────────────────────────────────────────────────────────────────

describe("F-6 · capabilities.mandates says whether a NULL ceiling is unknown or impossible", () => {
  it("is true for the gateways that register and report a per-debit ceiling", () => {
    expect(stripe().capabilities.mandates).toBe(true);
    expect(razorpay().capabilities.mandates).toBe(true);
  });

  it("is FALSE for PayPal, whose MERCHANT billing agreement has no per-debit ceiling", () => {
    expect(paypal().capabilities.mandates).toBe(false);
  });
});

describe("F-6 · describeStripeMandate reads the ceiling Stripe actually registered", () => {
  it("reads an India card e-mandate's ceiling off multi_use, not off the empty card hash", () => {
    const m = describeStripeMandate({
      id: "mandate_1",
      status: "active",
      type: "multi_use",
      multi_use: { amount: 2_500_000, currency: "inr" },
      payment_method_details: { type: "card", card: {} },
    } as never);
    expect(m?.maxAmountMinor).toBe(2_500_000n);
    expect(m?.currency).toBe("INR");
    expect(m?.rail).toBe("card");
    expect(m?.status).toBe("confirmed");
    expect(m?.reference).toBe("mandate_1");
  });

  it("reads a rail that denominates the cap on its own sub-hash", () => {
    const m = describeStripeMandate({
      id: "mandate_2",
      status: "active",
      type: "multi_use",
      payment_method_details: { type: "upi", upi: { amount: 1_500_000, amount_type: "maximum" } },
    } as never);
    expect(m?.maxAmountMinor).toBe(1_500_000n);
    expect(m?.rail).toBe("upi");
  });

  it("maps a revoked multi-use mandate to cancelled and a spent single-use one to spent", () => {
    const revoked = describeStripeMandate({
      id: "m3",
      status: "inactive",
      type: "multi_use",
      multi_use: { amount: 100, currency: "usd" },
      payment_method_details: { type: "sepa_debit", sepa_debit: { reference: "CRED-1" } },
    } as never);
    expect(revoked?.status).toBe("cancelled");
    // SEPA's creditor reference wins over the mandate id, as it did before.
    expect(revoked?.reference).toBe("CRED-1");

    const spent = describeStripeMandate({
      id: "m4",
      status: "inactive",
      type: "single_use",
      single_use: { amount: 100, currency: "usd" },
      payment_method_details: { type: "card", card: {} },
    } as never);
    // A one-shot authorization going inactive is the ordinary end of its life, and
    // must NOT reach DEAD_MANDATE_STATUSES and invalidate a good instrument.
    expect(spent?.status).toBe("spent");
  });

  it("returns undefined for nothing at all rather than a mandate of unknowns", () => {
    expect(describeStripeMandate(null)).toBeUndefined();
    expect(describeStripeMandate(undefined)).toBeUndefined();
  });
});

describe("F-6 · a Stripe INR card setup registers a CEILING, and a USD one does not", () => {
  const setupIntentCreate = (seen: Recorded[]) => {
    const r = seen.find((x) => x.method === "POST" && x.url.includes("/v1/setup_intents"));
    return new URLSearchParams(r!.body!);
  };
  const siStub: Stub = {
    match: (m, u) => m === "POST" && u.includes("/v1/setup_intents"),
    json: {
      id: "seti_1",
      object: "setup_intent",
      client_secret: "seti_1_secret",
      status: "requires_payment_method",
    },
  };

  it("sends card.mandate_options with amount_type=maximum for an INR card vault", async () => {
    const seen = stubFetch([siStub]);
    await stripe().initiateVaultSetup({
      customer: { providerKey: "stripe", providerCustomerId: "cus_1" },
      returnUrl: "https://shop.test/ok",
      cancelUrl: "https://shop.test/no",
      currency: "INR",
      methodTypes: ["card"],
      maxAmountMinor: 2_500_000n,
    });
    const form = setupIntentCreate(seen);
    expect(form.get("payment_method_options[card][mandate_options][amount]")).toBe("2500000");
    expect(form.get("payment_method_options[card][mandate_options][amount_type]")).toBe("maximum");
    expect(form.get("payment_method_options[card][mandate_options][currency]")).toBe("inr");
    expect(form.get("payment_method_options[card][mandate_options][supported_types][0]")).toBe(
      "india",
    );
  });

  it("sends NOTHING extra on a USD vault — an e-mandate agreement is not a card-on-file", async () => {
    const seen = stubFetch([siStub]);
    await stripe().initiateVaultSetup({
      customer: { providerKey: "stripe", providerCustomerId: "cus_1" },
      returnUrl: "https://shop.test/ok",
      cancelUrl: "https://shop.test/no",
      currency: "USD",
      methodTypes: ["card"],
      maxAmountMinor: 2_500_000n,
    });
    const form = setupIntentCreate(seen);
    expect([...form.keys()].some((k) => k.includes("mandate_options"))).toBe(false);
  });

  it("sends nothing when no ceiling was derived, even in INR", async () => {
    const seen = stubFetch([siStub]);
    await stripe().initiateVaultSetup({
      customer: { providerKey: "stripe", providerCustomerId: "cus_1" },
      returnUrl: "https://shop.test/ok",
      cancelUrl: "https://shop.test/no",
      currency: "INR",
      methodTypes: ["card"],
    });
    const form = setupIntentCreate(seen);
    expect([...form.keys()].some((k) => k.includes("mandate_options"))).toBe(false);
  });
});

describe("F-6 · consuming a Stripe setup intent harvests the mandate onto the instrument", () => {
  const consume = async (mandate: unknown): Promise<ProviderPaymentMethodRef | undefined> => {
    stubFetch([
      {
        match: (m, u) => m === "GET" && u.includes("/v1/setup_intents/seti_1"),
        json: {
          id: "seti_1",
          object: "setup_intent",
          status: "succeeded",
          customer: "cus_1",
          payment_method: {
            id: "pm_1",
            object: "payment_method",
            type: "card",
            customer: "cus_1",
            card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
          },
          mandate,
        },
      },
    ]);
    const r = await stripe().consumeIntent({
      intentId: "seti_1",
      idempotencyKey: "k",
      purpose: "setup",
    });
    return r.purpose === "setup" ? r.paymentMethod : undefined;
  };

  it("carries the ceiling Stripe registered onto the vaulted instrument", async () => {
    const pm = await consume({
      id: "mandate_1",
      object: "mandate",
      status: "active",
      type: "multi_use",
      multi_use: { amount: 2_500_000, currency: "inr" },
      payment_method_details: { type: "card", card: {} },
    });
    expect(pm?.mandate?.maxAmountMinor).toBe(2_500_000n);
    expect(pm?.mandate?.currency).toBe("INR");
  });

  it("leaves an ordinary card-on-file with NO mandate rather than an empty one", async () => {
    const pm = await consume(null);
    expect(pm?.providerPaymentMethodId).toBe("pm_1");
    expect(pm?.mandate).toBeUndefined();
  });
});

describe("Stripe fetchVaultedPaymentMethod — ownership and the India e-mandate flag", () => {
  const pmStub = (customer: string): Stub => ({
    match: (m, u) => m === "GET" && u.includes("/v1/payment_methods/pm_1"),
    json: {
      id: "pm_1",
      object: "payment_method",
      type: "card",
      customer,
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
    },
  });
  const accountStub = (country: string): Stub => ({
    match: (m, u) => m === "GET" && /\/v1\/account(\?|$)/.test(u),
    json: { id: "acct_1", object: "account", country },
  });
  const read = (key: string) =>
    new StripeProvider(key).fetchVaultedPaymentMethod({
      providerCustomerId: "cus_1",
      providerPaymentMethodId: "pm_1",
    });

  it("flags an India account's instrument as needing a per-debit mandate", async () => {
    stubFetch([pmStub("cus_1"), accountStub("IN")]);
    const r = await read("sk_test_in");
    expect(r?.providerCustomerId).toBe("cus_1");
    expect(r?.requiresPerDebitMandate).toBe(true);
  });

  it("does not flag any other account's", async () => {
    stubFetch([pmStub("cus_1"), accountStub("US")]);
    expect((await read("sk_test_us"))?.requiresPerDebitMandate).toBe(false);
  });

  it("reads the account country once per key", async () => {
    const seen = stubFetch([pmStub("cus_1"), accountStub("GB")]);
    await read("sk_test_gb");
    await read("sk_test_gb");
    expect(seen.filter((s) => /\/v1\/account(\?|$)/.test(s.url)).length).toBe(1);
  });

  it("refuses a pm attached to another customer without reading the account", async () => {
    const seen = stubFetch([pmStub("cus_other"), accountStub("IN")]);
    expect(await read("sk_test_other")).toBeNull();
    expect(seen.some((s) => /\/v1\/account(\?|$)/.test(s.url))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A refused refund names the gateway's reason
// ─────────────────────────────────────────────────────────────────────────────

describe("a refused refund throws ProviderRefusalError with the gateway's reason", () => {
  const refundInput = {
    providerChargeId: "CAPTURE01",
    amountMinor: 56539n,
    currency: "USD",
    idempotencyKey: "re_test01",
    ownershipRef: "re_test01",
  };

  it("PayPal 422: issue, description and debug ID reach the message", async () => {
    stubFetch([
      PAYPAL_OAUTH,
      {
        match: (m, u) => m === "POST" && u.includes("/v2/payments/captures/CAPTURE01/refund"),
        status: 422,
        json: {
          name: "UNPROCESSABLE_ENTITY",
          details: [
            {
              issue: "REFUND_FAILED_INSUFFICIENT_FUNDS",
              description: "Capture could not be refunded due to insufficient funds.",
            },
          ],
          debug_id: "dbg01",
        },
      },
    ]);
    const err = await paypal()
      .refund(refundInput)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRefusalError);
    expect((err as Error).message).toBe(
      "PayPal refused the refund (REFUND_FAILED_INSUFFICIENT_FUNDS). " +
        "Capture could not be refunded due to insufficient funds. PayPal debug ID: dbg01.",
    );
  });

  it("RazorPay 400: code and description reach the message", async () => {
    stubFetch([
      {
        match: (m, u) => m === "POST" && u.includes("/payments/CAPTURE01/refund"),
        status: 400,
        json: {
          error: {
            code: "BAD_REQUEST_ERROR",
            description: "The refund amount provided is greater than amount captured",
          },
        },
      },
    ]);
    const err = await razorpay()
      .refund(refundInput)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRefusalError);
    expect((err as Error).message).toBe(
      "RazorPay refused the refund (BAD_REQUEST_ERROR). " +
        "The refund amount provided is greater than amount captured",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PayPal balance — what a refund is paid from
// ─────────────────────────────────────────────────────────────────────────────

describe("PayPal fetchBalance reads /v1/reporting/balances", () => {
  it("returns minor units per currency, keeps a negative balance negative, and dates the figures", async () => {
    const seen = stubFetch([
      PAYPAL_OAUTH,
      {
        match: (m, u) => m === "GET" && u.includes("/v1/reporting/balances?currency_code=USD"),
        json: {
          balances: [
            {
              currency: "USD",
              total_balance: { currency_code: "USD", value: "0.55" },
              available_balance: { currency_code: "USD", value: "0.55" },
              withheld_balance: { currency_code: "USD", value: "0.00" },
            },
            {
              currency: "EUR",
              total_balance: { currency_code: "EUR", value: "-12.30" },
              available_balance: { currency_code: "EUR", value: "-12.30" },
            },
          ],
          last_refresh_time: "2026-11-04T16:29:59Z",
        },
      },
    ]);
    const r = await paypal().fetchBalance({ currency: "usd" });
    expect(seen.some((c) => c.url.includes("currency_code=USD"))).toBe(true);
    expect(r).toEqual({
      ok: true,
      asOf: new Date("2026-11-04T16:29:59Z"),
      balances: [
        { currency: "USD", availableMinor: 55n, withheldMinor: 0n, totalMinor: 55n },
        { currency: "EUR", availableMinor: -1230n, withheldMinor: 0n, totalMinor: -1230n },
      ],
    });
  });

  it("a 403 (Transaction search off) is not_permitted with the steps to enable it", async () => {
    stubFetch([
      PAYPAL_OAUTH,
      {
        match: (m, u) => m === "GET" && u.includes("/v1/reporting/balances"),
        status: 403,
        json: {
          name: "NOT_AUTHORIZED",
          message: "Authorization failed due to insufficient permissions.",
        },
      },
    ]);
    const r = await paypal().fetchBalance();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("not_permitted");
      expect(r.message).toContain("Transaction search");
    }
  });
});
