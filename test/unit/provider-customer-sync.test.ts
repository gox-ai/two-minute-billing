/**
 * F-14 — the provider-side customer identity sync (`updateCustomer`).
 *
 * `ensureProviderCustomer` calls `provider.updateCustomer?.(…)` on every REUSE of an
 * existing provider customer. Only Stripe implemented it, so on RazorPay the optional
 * chaining silently dropped the call — and on RazorPay that is not cosmetic:
 * `createEmandateAuthLink` reads `contact` off **RazorPay's** customer record and
 * refuses without one. A customer whose RazorPay mirror predated their phone number
 * could never register a mandate, and adding the phone (portal billing details, or
 * checkout's "Edit billing details") satisfied the LOCAL gate while changing nothing
 * at the gateway. The buyer's own escape hatch could not clear the error that named it.
 *
 * Two independent things are locked down here, in two layers, because they fail in
 * opposite directions:
 *
 *  1. **The adapter sends the right request.** RazorPay's edit verb is `PUT`; `PATCH`
 *     is not routed at all (404 "no Route matched with those values" — measured live
 *     in test mode, 2026-08-30, for a valid id, a bogus id and an empty body alike).
 *     And `contact: ""` is ACCEPTED and BLANKS the contact, so an empty value must
 *     never be sent.
 *  2. **A sync failure can never fail a vault or a charge.** `ensureProviderCustomer`
 *     is on the hot path of both, and `providerFetch` THROWS on a transport failure.
 *     A slow gateway on an endpoint nobody is waiting for must not turn a renewal into
 *     a dunning attempt.
 *
 * Both are driven through the real code — a stubbed `fetch` for the adapter, a stubbed
 * `withTenant` for the engine — so the assertions are about the bytes we send and the
 * control flow we actually have, not about a double that could agree with a bug.
 */
import { beforeAll, describe, it, expect, afterEach, vi } from "vitest";
import { RazorpayProvider } from "@/providers/razorpay";
import { PayPalProvider } from "@/providers/paypal";
import type { PaymentProvider, ProviderCustomerRef } from "@/providers/types";

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

/** Answers from `stubs`, records what was asked, REJECTS anything unstubbed. */
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

const razorpay = () =>
  new RazorpayProvider({
    keyId: "rzp_test_x",
    keySecret: "secret",
    apiBase: "https://api.razorpay.test/v1",
  });

const RZ_CUSTOMER: ProviderCustomerRef = {
  providerKey: "razorpay",
  providerCustomerId: "cust_alice",
};

/** Every PUT to the customer succeeds. */
const putOk: Stub = {
  match: (m, u) => m === "PUT" && u.endsWith("/customers/cust_alice"),
  json: { id: "cust_alice", contact: "+919000000001" },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — RazorPay sends the request RazorPay actually accepts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pay for the module graph ONCE, before the clock is anyone's problem.
 *
 * Every test below dynamically imports `payment-methods/service`, and whichever runs first
 * also resolves and transforms that whole graph — a cost with nothing to do with the
 * assertion it lands on. Under parallel load it exceeded vitest's 5s default and this file
 * failed intermittently on a different test each time, four times on 2026-09-10 alone,
 * twice reported as a real break by someone reading the summary. `import()` is cached, so
 * warming it here makes every later import a map lookup.
 *
 * The generous timeout belongs HERE, on the warm-up, and not on the tests: a test that
 * genuinely hangs should still fail fast.
 */
beforeAll(async () => {
  await import("@/modules/payment-methods/service");
}, 60_000);

describe("F-14 · RazorPay pushes identity onto an existing provider customer", () => {
  /**
   * ⚠️ THE MUTATION TARGET. Delete `updateCustomer` from the RazorPay adapter (which is
   * the pre-fix state — the method simply did not exist and `updateCustomer?.()`
   * optional-chained it away) and this goes red on `updateCustomer is not a function`.
   * Change the verb from `PUT` to `PATCH` — the shape the endpoint LOOKS like it should
   * have — and it goes red on the method assertion instead, which is the mistake this
   * case exists to catch: a PATCH is a 404 at RazorPay, so the sync would appear
   * implemented and repair nothing.
   */
  it("PUTs the contact — the verb is PUT, PATCH is not routed at RazorPay", async () => {
    const seen = stubFetch([putOk]);
    await razorpay().updateCustomer(RZ_CUSTOMER, {
      customerRef: "cus_alice",
      phone: "+919000000001",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("PUT");
    expect(seen[0]!.url).toMatch(/\/customers\/cust_alice$/);
    expect(JSON.parse(seen[0]!.body!)).toEqual({ contact: "+919000000001" });
  });

  it("sends name and email alongside the contact when we have them", async () => {
    const seen = stubFetch([putOk]);
    await razorpay().updateCustomer(RZ_CUSTOMER, {
      customerRef: "cus_alice",
      name: "Maya Castillo",
      email: "maya@example.test",
      phone: "+919000000001",
    });
    expect(JSON.parse(seen[0]!.body!)).toEqual({
      name: "Maya Castillo",
      email: "maya@example.test",
      contact: "+919000000001",
    });
  });

  /**
   * ⚠️ MUTATION TARGET. Replace the `if (input.x)` guards with an unconditional spread
   * and this goes red: an empty `contact` is ACCEPTED by RazorPay and BLANKS the stored
   * one (measured), which would destroy the very mandate the sync exists to enable.
   */
  it("never sends an empty value — a blank contact would WIPE the stored one", async () => {
    const seen = stubFetch([putOk]);
    await razorpay().updateCustomer(RZ_CUSTOMER, {
      customerRef: "cus_alice",
      name: "Maya Castillo",
      email: "",
      phone: "",
    });
    expect(JSON.parse(seen[0]!.body!)).toEqual({ name: "Maya Castillo" });
  });

  it("makes NO call at all when there is nothing to sync", async () => {
    const seen = stubFetch([putOk]);
    await razorpay().updateCustomer(RZ_CUSTOMER, { customerRef: "cus_alice" });
    expect(seen).toHaveLength(0);
  });

  /**
   * RazorPay's duplicate check is on EMAIL, not contact — measured, and the opposite of
   * the folklore. PUT-ing a contact another customer already holds returns 200; PUT-ing
   * a contested email returns 400 "Customer already exists for the merchant". Since one
   * PUT carries all three fields, a contested email would take the CONTACT down with it
   * — losing the only field a mandate cannot be registered without.
   *
   * ⚠️ MUTATION TARGET. Drop the contact-only retry and this goes red.
   */
  it("retries with the contact alone when a contested email sinks the full sync", async () => {
    const seen = stubFetch([
      {
        match: (m, u, b) =>
          m === "PUT" && u.endsWith("/customers/cust_alice") && !!b?.includes("email"),
        status: 400,
        json: {
          error: {
            code: "BAD_REQUEST_ERROR",
            description: "Customer already exists for the merchant",
          },
        },
      },
      {
        match: (m, u, b) =>
          m === "PUT" && u.endsWith("/customers/cust_alice") && !b?.includes("email"),
        json: { id: "cust_alice", contact: "+919000000001" },
      },
    ]);
    await expect(
      razorpay().updateCustomer(RZ_CUSTOMER, {
        customerRef: "cus_alice",
        name: "Maya Castillo",
        email: "taken@example.test",
        phone: "+919000000001",
      }),
    ).resolves.toBeUndefined();
    expect(seen).toHaveLength(2);
    expect(JSON.parse(seen[1]!.body!)).toEqual({ contact: "+919000000001" });
  });

  it("swallows a refusal the retry cannot rescue — a stale name is not a payment failure", async () => {
    stubFetch([
      {
        match: (m, u) => m === "PUT" && u.endsWith("/customers/cust_alice"),
        status: 400,
        json: { error: { description: "Customer already exists for the merchant" } },
      },
    ]);
    await expect(
      razorpay().updateCustomer(RZ_CUSTOMER, {
        customerRef: "cus_alice",
        email: "taken@example.test",
        phone: "+919000000001",
      }),
    ).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PayPal — the absence is the answer
// ─────────────────────────────────────────────────────────────────────────────

describe("F-14 · PayPal has no customer object to sync", () => {
  /**
   * `ensureCustomer` returns our own `cus_…` and Vault v3 stores no customer resource,
   * so an `updateCustomer` here could only be an empty method pretending to be a sync.
   * This asserts the deliberate absence: if someone adds one, they have to come here,
   * read why it was left out, and make the case in this test rather than in silence.
   */
  it("declines to implement updateCustomer rather than shipping an empty one", () => {
    // Typed as the INTERFACE, where `updateCustomer` is the optional member: this both
    // proves PayPal is a complete adapter without it and gives the assertion something
    // to name. (`PayPalProvider` itself has no such property, so reading it off the
    // concrete class would not compile — which is its own small piece of evidence.)
    const pp: PaymentProvider = new PayPalProvider({
      clientId: "cid",
      clientSecret: "csec",
      apiBase: "https://api.sandbox.paypal.test",
    });
    expect(pp.updateCustomer).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — the sync is best-effort, at the engine, for EVERY adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `ensureProviderCustomer` reads the mapping through `withTenant`. Stub it so the test
 * is about the control flow around `updateCustomer` and not about Postgres; everything
 * else in the module graph keeps its real implementation.
 */
vi.mock("@/platform/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/db")>();
  return {
    ...actual,
    withTenant: async () => [
      { providerCustomerId: "cust_alice", providerKey: "razorpay", gatewayAccountId: "ga_1" },
    ],
  };
});

describe("F-14 · a failed identity sync can never fail a vault or a charge", () => {
  const customer = {
    id: "int_1",
    publicId: "cus_alice",
    email: "maya@example.test",
    phone: "+919000000001",
    billingPhone: null,
  } as never;

  function providerWith(updateCustomer: PaymentProvider["updateCustomer"]): PaymentProvider {
    return {
      key: "razorpay",
      capabilities: { methods: [] },
      updateCustomer,
      ensureCustomer: async () => {
        throw new Error("ensureCustomer must NOT be called — the mapping already exists");
      },
    } as unknown as PaymentProvider;
  }

  /**
   * ⚠️ THE MUTATION TARGET for the engine guard. Remove the `try`/`catch` around
   * `input.provider.updateCustomer?.(…)` in `ensureProviderCustomer` and this goes red:
   * the rejection propagates and the caller — a vault, or a renewal charge — fails on a
   * best-effort identity push it was never waiting for.
   */
  it("returns the mapping when the sync THROWS (transport failure, timeout, TLS)", async () => {
    const { ensureProviderCustomer } = await import("@/modules/payment-methods/service");
    const provider = providerWith(async () => {
      throw new Error("razorpay update_customer (PUT …) timed out after 20000ms");
    });
    const ref = await ensureProviderCustomer({
      organizationId: "org_1",
      businessId: "biz_1",
      customer,
      provider,
      gatewayAccountId: "ga_1",
    });
    expect(ref).toEqual({ providerKey: "razorpay", providerCustomerId: "cust_alice" });
  });

  it("still pushes the CURRENT phone on reuse — the whole point of the sync", async () => {
    const { ensureProviderCustomer } = await import("@/modules/payment-methods/service");
    const pushed: Array<{ ref: ProviderCustomerRef; phone?: string }> = [];
    const provider = providerWith(async (ref, input) => {
      pushed.push({ ref, phone: input.phone });
    });
    await ensureProviderCustomer({
      organizationId: "org_1",
      businessId: "biz_1",
      customer,
      provider,
      gatewayAccountId: "ga_1",
    });
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.phone).toBe("+919000000001");
    expect(pushed[0]!.ref.providerCustomerId).toBe("cust_alice");
  });

  it("tolerates an adapter with no updateCustomer at all (PayPal)", async () => {
    const { ensureProviderCustomer } = await import("@/modules/payment-methods/service");
    const ref = await ensureProviderCustomer({
      organizationId: "org_1",
      businessId: "biz_1",
      customer,
      provider: providerWith(undefined),
      gatewayAccountId: "ga_1",
    });
    expect(ref.providerCustomerId).toBe("cust_alice");
  });
});
