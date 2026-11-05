/**
 * #31 — proving a RazorPay object OURS, or provably NOT ours.
 *
 * The RazorPay merchant account is shared with another product, so this engine
 * receives capture webhooks for payments it never created: **124 `charge.succeeded`
 * events had already arrived for charges with no payment row of ours** when this was
 * written, and none was booked — booking requires matching our own intent or
 * transaction, and `reconcileUnmatchedCapture` refuses to guess a customer. Money was
 * never at risk. What was broken is that "another product's charge" (normal, should be
 * silent) and "our capture we failed to attribute" (a money incident) produced the SAME
 * WARN, so the second could never be alerted on.
 *
 * Measured before this shipped: of **875 RazorPay orders this engine created, ZERO
 * carried `notes.tmbilling_ref`**. The tag existed twice in the adapter (the e-mandate
 * auth link, and `stripe.ts`'s customer stamp) and had never reached a money object.
 *
 * Two halves are locked here, and they fail in opposite directions:
 *
 *  1. **Every create path stamps the ref, unconditionally.** The classifier's rule is
 *     "created after tagging shipped and carries no tag ⇒ provably not ours", which is
 *     only sound if there is no untagged create path left. So each path is asserted on
 *     its own — a new path that forgets the note fails loudly — and a source scan makes
 *     a NEW `POST` endpoint fail this file until someone classifies it.
 *  2. **Absence is only read as evidence where absence can BE evidence.** We never
 *     stamp the payment entity (see the exemptions in the scan below), so a capture
 *     whose payment notes lack our ref must answer `unknown`, never `foreign`. Reading
 *     silence as "not ours" is what would turn a tagging regression into invisible
 *     money loss — the same error as reading a missing poll answer as "nothing held".
 *
 * Driven through the real adapter with a stubbed `fetch` (the house pattern from
 * `provider-customer-sync.test.ts`), so the assertions are about the bytes we send and
 * the events we actually emit.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";
import { RazorpayProvider } from "@/providers/razorpay";
import type { ProviderCustomerRef, ProviderPaymentMethodRef } from "@/providers/types";

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
    if (!hit) throw new Error(`unstubbed gateway call: ${method} ${url} ${body ?? ""}`);
    return new Response(JSON.stringify(hit.json), {
      status: hit.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return seen;
}

const SECRET = "test-webhook-secret";
const razorpay = () =>
  new RazorpayProvider({
    keyId: "rzp_test_x",
    keySecret: "secret",
    apiBase: "https://api.razorpay.test/v1",
    webhookSecret: SECRET,
  });

const CUSTOMER: ProviderCustomerRef = { providerKey: "razorpay", providerCustomerId: "cust_alice" };
const UPI_TOKEN: ProviderPaymentMethodRef = {
  providerKey: "razorpay",
  providerPaymentMethodId: "token_alice",
  display: { type: "upi" },
};

/** The note bag as RazorPay echoes it, parsed off a recorded request body. */
function notesOf(rec: Recorded | undefined): Record<string, string> | undefined {
  if (!rec?.body) return undefined;
  return (JSON.parse(rec.body) as { notes?: Record<string, string> }).notes;
}
const posted = (seen: Recorded[], path: string) =>
  seen.find((r) => r.method === "POST" && r.url.endsWith(path));

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Every create path stamps the ref
// ─────────────────────────────────────────────────────────────────────────────

describe("every RazorPay object we create carries notes.tmbilling_ref", () => {
  it("stamps the off-session charge's order with the FULL idempotency key", async () => {
    // The measured blind spot. `receipt` is capped at 40 chars and
    // `boundedProviderKey` HASHES anything longer to `tm_<hash>`, so on the recurring
    // path the only trace of us was irreversible. `notes` has no such cap, so the same
    // key goes in whole — that is the difference between "an order we can recognise"
    // and "an order we hashed away".
    const key = "collect_invoice_INV-5510_attempt_3_2026-09-04T00:00:00.000Z";
    const seen = stubFetch([
      { match: (m, u) => m === "POST" && u.endsWith("/orders"), json: { id: "order_x" } },
      {
        match: (m, u) => m === "POST" && u.endsWith("/payments/create/recurring"),
        json: { razorpay_payment_id: "pay_x", status: "captured" },
      },
    ]);
    await razorpay().charge({
      amountMinor: 100000n,
      currency: "INR",
      customer: CUSTOMER,
      paymentMethod: UPI_TOKEN,
      idempotencyKey: key,
      email: "a@b.test",
      phone: "+919000000001",
    });
    const order = posted(seen, "/orders");
    expect(notesOf(order)?.tmbilling_ref).toBe(key);
    // And the receipt is still the hashed 40-char form — proving `notes` is carrying
    // what the receipt cannot.
    const receipt = JSON.parse(order!.body!).receipt as string;
    expect(receipt.startsWith("tm_")).toBe(true);
    expect(receipt).not.toBe(key);
  });

  it("stamps a payment intent's order with the caller's ownershipRef", async () => {
    const seen = stubFetch([
      { match: (m, u) => m === "POST" && u.endsWith("/orders"), json: { id: "order_i" } },
    ]);
    await razorpay().createIntent({
      purpose: "payment",
      ownershipRef: "pi_create_pi_abc123_a1",
      amountMinor: 250000n,
      currency: "INR",
      customer: CUSTOMER,
      idempotencyKey: "idem_intent_1",
      metadata: { invoice: "INV-5510" },
    });
    const notes = notesOf(posted(seen, "/orders"));
    expect(notes?.tmbilling_ref).toBe("pi_create_pi_abc123_a1");
    // The caller's own metadata must survive alongside it — the note bag was already
    // carrying metadata + description before the tag existed.
    expect(notes?.invoice).toBe("INV-5510");
  });

  it("falls back to the idempotency key when no ownershipRef is passed", async () => {
    // Unconditional means unconditional: no engine caller passes `ownershipRef` yet
    // (measured 2026-09-04 — the field exists on the contract and has no call site), so
    // a create path that only tags when asked would tag nothing at all today.
    const seen = stubFetch([
      { match: (m, u) => m === "POST" && u.endsWith("/orders"), json: { id: "order_i" } },
    ]);
    await razorpay().createIntent({
      purpose: "payment",
      amountMinor: 250000n,
      currency: "INR",
      customer: CUSTOMER,
      idempotencyKey: "idem_intent_2",
    });
    expect(notesOf(posted(seen, "/orders"))?.tmbilling_ref).toBe("idem_intent_2");
  });

  it("stamps a UPI mandate-registration order", async () => {
    const seen = stubFetch([
      { match: (m, u) => m === "POST" && u.endsWith("/orders"), json: { id: "order_m" } },
    ]);
    await razorpay().createIntent({
      purpose: "setup",
      ownershipRef: "pi_setup_pi_upi_a1",
      currency: "INR",
      customer: CUSTOMER,
      idempotencyKey: "idem_setup_upi",
      methodTypes: ["upi"],
    });
    const body = JSON.parse(posted(seen, "/orders")!.body!);
    expect(body.method).toBe("upi"); // still the mandate order, not a plain one
    expect(body.notes?.tmbilling_ref).toBe("pi_setup_pi_upi_a1");
  });

  it("stamps a CARD mandate-registration order (a separate body shape)", async () => {
    const seen = stubFetch([
      { match: (m, u) => m === "POST" && u.endsWith("/orders"), json: { id: "order_c" } },
    ]);
    await razorpay().createIntent({
      purpose: "setup",
      ownershipRef: "pi_setup_pi_card_a1",
      currency: "USD",
      customer: CUSTOMER,
      idempotencyKey: "idem_setup_card",
      methodTypes: ["card"],
    });
    const body = JSON.parse(posted(seen, "/orders")!.body!);
    expect(body.method).toBe("card");
    expect(body.notes?.tmbilling_ref).toBe("pi_setup_pi_card_a1");
  });

  it("stamps a vault-setup order from the customer id when the caller passes no ref", async () => {
    // The fallback path: a caller that supplies no `ownershipRef` still tags, using the
    // provider customer id — the same value `createEmandateAuthLink` has always used.
    // An untagged order is what breaks the classifier's rule, so no path may skip it.
    const seen = stubFetch([
      { match: (m, u) => m === "POST" && u.endsWith("/orders"), json: { id: "order_v" } },
    ]);
    await razorpay().initiateVaultSetup({
      customer: CUSTOMER,
      returnUrl: "https://x.test/ok",
      cancelUrl: "https://x.test/no",
      methodTypes: ["upi"],
      currency: "INR",
    });
    expect(notesOf(posted(seen, "/orders"))?.tmbilling_ref).toBe("cust_alice");
  });

  it("forwards InitiateVaultSetupInput.ownershipRef to the mandate order", async () => {
    // The engine passes the `cus_…` the vault attempt is for (#31). Before this was
    // wired, `initiateVaultSetup` dropped it and every vault order was tagged with
    // RazorPay's OWN customer id — a value that identifies the account, not the attempt,
    // so two attempts for one customer were indistinguishable in the notes.
    const seen = stubFetch([
      { match: (m, u) => m === "POST" && u.endsWith("/orders"), json: { id: "order_v2" } },
    ]);
    await razorpay().initiateVaultSetup({
      ownershipRef: "cus_alice_public",
      customer: CUSTOMER,
      returnUrl: "https://x.test/ok",
      cancelUrl: "https://x.test/no",
      methodTypes: ["upi"],
      currency: "INR",
    });
    expect(notesOf(posted(seen, "/orders"))?.tmbilling_ref).toBe("cus_alice_public");
  });

  it("forwards the vault ref to the e-mandate link WITHOUT touching its customer binding", async () => {
    // ⚠️ The reason this rail needs its own case: `assertAuthLinkBelongsTo` compares
    // `notes.tmbilling_ref` on the auth-link invoice to an expected PROVIDER CUSTOMER
    // id, so that key is load-bearing AT ITS VALUE. Forwarding our ref onto it would
    // silently disable an ownership proof on the raw-token vault path while looking like
    // better tagging. The finer ref must land on the second key and only there.
    const seen = stubFetch([
      {
        match: (m, u) => m === "GET" && u.endsWith("/customers/cust_alice"),
        json: { name: "Alice", email: "a@b.test", contact: "+919000000001" },
      },
      {
        match: (m, u) => m === "POST" && u.endsWith("/subscription_registration/auth_links"),
        json: { id: "inv_link2", short_url: "https://rzp.io/i/y" },
      },
    ]);
    await razorpay().initiateVaultSetup({
      ownershipRef: "cus_alice_public",
      customer: CUSTOMER,
      returnUrl: "https://x.test/ok",
      cancelUrl: "https://x.test/no",
      methodTypes: ["bank_transfer"],
      currency: "INR",
    });
    const notes = notesOf(posted(seen, "/subscription_registration/auth_links"));
    expect(notes?.tmbilling_ref).toBe("cust_alice");
    expect(notes?.tmbilling_intent_ref).toBe("cus_alice_public");
  });

  it("keeps the e-mandate auth link's customer binding AND adds the intent ref", async () => {
    // ⚠️ `notes.tmbilling_ref` on this endpoint is load-bearing at a specific VALUE:
    // `assertAuthLinkBelongsTo` compares it to the expected provider customer id on the
    // raw-token vault path. Overwriting it with an intent ref would silently disable
    // that ownership proof, so the finer ref rides a second key.
    const seen = stubFetch([
      {
        match: (m, u) => m === "GET" && u.endsWith("/customers/cust_alice"),
        json: { name: "Alice", email: "a@b.test", contact: "+919000000001" },
      },
      {
        match: (m, u) => m === "POST" && u.endsWith("/subscription_registration/auth_links"),
        json: { id: "inv_link", short_url: "https://rzp.io/i/x" },
      },
    ]);
    await razorpay().createIntent({
      purpose: "setup",
      ownershipRef: "pi_setup_pi_nb_a1",
      currency: "INR",
      customer: CUSTOMER,
      idempotencyKey: "idem_setup_nb",
      methodTypes: ["bank_transfer"],
    });
    const notes = notesOf(posted(seen, "/subscription_registration/auth_links"));
    expect(notes?.tmbilling_ref).toBe("cust_alice");
    expect(notes?.tmbilling_intent_ref).toBe("pi_setup_pi_nb_a1");
  });

  it("stamps the health-check order, so a probe is never mistaken for a stranger's", async () => {
    const seen = stubFetch([
      {
        match: (m, u) => m === "POST" && u.endsWith("/orders"),
        json: { id: "order_h", status: "created" },
      },
    ]);
    await razorpay().healthCheck();
    expect(notesOf(posted(seen, "/orders"))?.tmbilling_ref).toBe("tmbilling_healthcheck");
  });

  it("stamps the customer mirror", async () => {
    const seen = stubFetch([
      { match: (m, u) => m === "POST" && u.endsWith("/customers"), json: { id: "cust_new" } },
    ]);
    await razorpay().ensureCustomer({ customerRef: "cus_alice", email: "a@b.test" });
    expect(notesOf(posted(seen, "/customers"))?.tmbilling_ref).toBe("cus_alice");
  });

  it("stamps the refund", async () => {
    const seen = stubFetch([
      {
        match: (m, u) => m === "POST" && u.endsWith("/payments/pay_x/refund"),
        json: { id: "rfnd_x", status: "processed" },
      },
    ]);
    await razorpay().refund({
      providerChargeId: "pay_x",
      amountMinor: 5000n,
      idempotencyKey: "idem_refund_1",
    });
    expect(notesOf(posted(seen, "/payments/pay_x/refund"))?.tmbilling_ref).toBe("idem_refund_1");
  });

  it("stamps the UPI-collect mandate order (the harness path)", async () => {
    const seen = stubFetch([
      { match: (m, u) => m === "POST" && u.endsWith("/orders"), json: { id: "order_u" } },
      {
        match: (m, u) => m === "POST" && u.endsWith("/payments/create/upi"),
        json: { razorpay_payment_id: "pay_u" },
      },
    ]);
    await razorpay().initiateUpiAutopayCollect({
      customerId: "cust_alice",
      vpa: "success@razorpay",
      email: "a@b.test",
      contact: "+919000000001",
    });
    expect(notesOf(posted(seen, "/orders"))?.tmbilling_ref).toBe("cust_alice");
  });

  /**
   * The loud gate. Every POST path in the adapter is either TAGGED (asserted above) or
   * EXEMPT with a reason — and a new one fails here until its author picks a side.
   * A per-path assertion cannot do this on its own: the failure mode #31 is about is a
   * create path nobody thought about.
   */
  it("leaves no unclassified POST endpoint in the adapter", () => {
    const src = readFileSync(resolve(__dirname, "../../src/providers/razorpay.ts"), "utf8");
    // `this.api(op, "POST", path, …)` — path is a plain string or a template literal.
    const found = new Set<string>();
    for (const m of src.matchAll(/"POST",\s*(?:\n\s*)?(?:"([^"]+)"|`([^`]+)`)/g)) {
      found.add((m[1] ?? m[2]!).replace(/\$\{[^}]*\}/g, ":id"));
    }
    const TAGGED = new Set([
      "/orders", // charge(), createMandateOrder(), createIntent(), healthCheck()
      "/customers",
      "/subscription_registration/auth_links",
      "/payments/:id/refund",
    ]);
    /**
     * Exempt, each for a measured reason — see the comments at the call sites:
     *  · `/payments/create/recurring` and `/payments/create/upi` — RazorPay's acceptance
     *    of `notes` on the s2s payment-create endpoints is NOT measured on this account,
     *    and a rejected field there fails every off-session collection. The capture that
     *    results is attributed through its ORDER instead (which we do tag) — see the
     *    ownership readback below.
     *  · `/payments/:id/capture` — takes amount + currency only; there is no note bag.
     *  · `/webhooks` — merchant configuration, not an object a webhook is ever about.
     */
    const EXEMPT = new Set([
      "/payments/create/recurring",
      "/payments/create/upi",
      "/payments/:id/capture",
      "/webhooks",
    ]);
    const unclassified = [...found].filter((p) => !TAGGED.has(p) && !EXEMPT.has(p));
    expect(unclassified).toEqual([]);
    // And the scan must actually be finding things — a regex that matches nothing would
    // pass the line above forever.
    expect([...found].length).toBeGreaterThanOrEqual(TAGGED.size + EXEMPT.size);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Reading it back on the inbound side
// ─────────────────────────────────────────────────────────────────────────────

/** A signed RazorPay webhook, delivered through the real verifier. */
const deliver = (event: Record<string, unknown>) => {
  const body = JSON.stringify(event);
  return razorpay().normalizeWebhook({
    payload: body,
    headers: { "x-razorpay-signature": createHmac("sha256", SECRET).update(body).digest("hex") },
  });
};

// 2026-08-14T12:30:00Z, in RazorPay's own unit: SECONDS.
const EPOCH_SEC = 1786681800;
const EPOCH_MS = 1786681800000;

describe("an inbound event says whether the object was ours", () => {
  it("reads OURS off the order entity a capture expands", async () => {
    const [ev] = await deliver({
      id: "evt_1",
      event: "payment.captured",
      created_at: EPOCH_SEC + 60,
      payload: {
        payment: { entity: { id: "pay_1", order_id: "order_1", notes: [], created_at: EPOCH_SEC } },
        order: {
          entity: {
            id: "order_1",
            created_at: EPOCH_SEC,
            notes: { tmbilling_ref: "collect_invoice_INV-1" },
          },
        },
      },
    });
    expect(ev?.ownership).toBe("ours");
    expect(ev?.ownershipRef).toBe("collect_invoice_INV-1");
  });

  it("reads FOREIGN when the order's notes were read and ours is absent", async () => {
    // The whole point of #31: this is a sibling product's charge, and it is now
    // COUNTABLE rather than indistinguishable from a capture we failed to attribute.
    const [ev] = await deliver({
      id: "evt_2",
      event: "payment.captured",
      created_at: EPOCH_SEC,
      payload: {
        payment: { entity: { id: "pay_2", order_id: "order_2", created_at: EPOCH_SEC } },
        order: {
          entity: { id: "order_2", created_at: EPOCH_SEC, notes: { product: "other-app" } },
        },
      },
    });
    expect(ev?.ownership).toBe("foreign");
    expect(ev?.ownershipRef).toBeUndefined();
  });

  it("treats an EMPTY note bag on the order as foreign — RazorPay echoes it as []", async () => {
    const [ev] = await deliver({
      id: "evt_3",
      event: "payment.captured",
      created_at: EPOCH_SEC,
      payload: {
        payment: { entity: { id: "pay_3", order_id: "order_3" } },
        order: { entity: { id: "order_3", created_at: EPOCH_SEC, notes: [] } },
      },
    });
    expect(ev?.ownership).toBe("foreign");
  });

  it("answers UNKNOWN for a capture that carries only the payment entity", async () => {
    // ⚠️ The load-bearing one. `payment.captured` carries the PAYMENT's notes, not the
    // ORDER's, and we never stamp a payment — a buyer's Checkout payment against our
    // order is minted by RazorPay with a note bag we never touch. So an untagged payment
    // is NOT evidence of anything, and calling it `foreign` would report our own money
    // as a stranger's. The order id it carries is how it gets resolved instead.
    const [ev] = await deliver({
      id: "evt_4",
      event: "payment.captured",
      created_at: EPOCH_SEC,
      payload: {
        payment: { entity: { id: "pay_4", order_id: "order_4", notes: [], created_at: EPOCH_SEC } },
      },
    });
    expect(ev?.ownership).toBe("unknown");
    // …and the handle to resolve it with is already on the event.
    expect(ev?.providerIntentId).toBe("order_4");
  });

  it("still reads OURS off a payment entity that does carry the ref", async () => {
    const [ev] = await deliver({
      id: "evt_5",
      event: "payment.captured",
      created_at: EPOCH_SEC,
      payload: {
        payment: {
          entity: {
            id: "pay_5",
            order_id: "order_5",
            created_at: EPOCH_SEC,
            notes: { tmbilling_ref: "idem_x" },
          },
        },
      },
    });
    expect(ev?.ownership).toBe("ours");
    expect(ev?.ownershipRef).toBe("idem_x");
  });

  it("answers UNKNOWN on an intent authorization with no order expansion", async () => {
    const [ev] = await deliver({
      id: "evt_6",
      event: "payment.authorized",
      created_at: EPOCH_SEC,
      payload: {
        payment: { entity: { id: "pay_6", order_id: "order_6", notes: [], created_at: EPOCH_SEC } },
      },
    });
    expect(ev?.type).toBe("intent.authorized");
    expect(ev?.ownership).toBe("unknown");
  });

  it("reads OURS on an intent authorization when the order IS expanded", async () => {
    const [ev] = await deliver({
      id: "evt_7",
      event: "payment.authorized",
      created_at: EPOCH_SEC,
      payload: {
        payment: { entity: { id: "pay_7", order_id: "order_7", created_at: EPOCH_SEC } },
        order: {
          entity: { id: "order_7", created_at: EPOCH_SEC, notes: { tmbilling_ref: "pi_abc" } },
        },
      },
    });
    expect(ev?.ownership).toBe("ours");
    expect(ev?.ownershipRef).toBe("pi_abc");
  });

  it("never claims foreign on an entity that has no note bag at all", async () => {
    // A token/settlement entity carries no `notes`, so the adapter did not look and must
    // say so. `unknown` is the default and must survive every branch.
    const [tok] = await deliver({
      id: "evt_8",
      event: "token.confirmed",
      created_at: EPOCH_SEC,
      payload: { token: { entity: { id: "token_1", recurring_details: { status: "confirmed" } } } },
    });
    expect(tok?.ownership).toBe("unknown");
    const [st] = await deliver({
      id: "evt_9",
      event: "settlement.processed",
      created_at: EPOCH_SEC,
      payload: { settlement: { entity: { id: "setl_1", amount: 100, created_at: EPOCH_SEC } } },
    });
    expect(st?.ownership).toBe("unknown");
  });
});

describe("providerObjectCreatedAt is RazorPay's created_at, in SECONDS", () => {
  it("converts the payment's created_at without a 1000x error", async () => {
    const [ev] = await deliver({
      id: "evt_10",
      event: "payment.captured",
      // The event fired a day after the object was created — which is exactly why
      // `occurredAt` cannot answer the classifier's question.
      created_at: EPOCH_SEC + 86400,
      payload: {
        payment: { entity: { id: "pay_10", order_id: "order_10", created_at: EPOCH_SEC } },
      },
    });
    expect(ev?.providerObjectCreatedAt?.getTime()).toBe(EPOCH_MS);
    expect(ev?.providerObjectCreatedAt?.getUTCFullYear()).toBe(2026);
    expect(ev?.occurredAt.getTime()).toBe(EPOCH_MS + 86400_000);
  });

  it("reports the ORDER's created_at when ownership was read off the order", async () => {
    // The pair travels together or it is worthless: "created after tagging shipped and
    // carries no tag ⇒ not ours" has to be asked of the SAME object whose tags were read.
    // A payment minted today against an order from before the rollout would otherwise be
    // judged on the wrong object's age.
    const [ev] = await deliver({
      id: "evt_11",
      event: "payment.captured",
      created_at: EPOCH_SEC + 86400,
      payload: {
        payment: { entity: { id: "pay_11", order_id: "order_11", created_at: EPOCH_SEC + 3600 } },
        order: { entity: { id: "order_11", created_at: EPOCH_SEC, notes: [] } },
      },
    });
    expect(ev?.ownership).toBe("foreign");
    expect(ev?.providerObjectCreatedAt?.getTime()).toBe(EPOCH_MS);
  });

  it("leaves it absent when the gateway named no created_at", async () => {
    const [ev] = await deliver({
      id: "evt_12",
      event: "payment.captured",
      created_at: EPOCH_SEC,
      payload: { payment: { entity: { id: "pay_12" } } },
    });
    expect(ev?.providerObjectCreatedAt).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Resolving a capture's tag from the order it names
// ─────────────────────────────────────────────────────────────────────────────

describe("resolving ownership from the order, off the happy path", () => {
  it("does NOT fetch the order when nobody asked", async () => {
    // A local match succeeds for almost every capture, and paying an extra gateway
    // round trip on every one of them would be a real cost for no information.
    const seen = stubFetch([
      {
        match: (m, u) => m === "GET" && u.endsWith("/orders/order_p/payments"),
        json: { items: [{ id: "pay_p", status: "captured", amount: 100, currency: "INR" }] },
      },
    ]);
    const got = await razorpay().fetchIntent({ intentId: "order_p" });
    expect(got.status).toBe("consumed");
    expect(got.ownership).toBeUndefined();
    expect(seen.filter((r) => r.method === "GET").length).toBe(1);
  });

  it("reads the tag off the order when asked", async () => {
    const seen = stubFetch([
      {
        match: (m, u) => m === "GET" && u.endsWith("/orders/order_q/payments"),
        json: { items: [{ id: "pay_q", status: "captured", amount: 100, currency: "INR" }] },
      },
      {
        match: (m, u) => m === "GET" && u.endsWith("/orders/order_q"),
        json: { id: "order_q", created_at: EPOCH_SEC, notes: { tmbilling_ref: "idem_q" } },
      },
    ]);
    const got = await razorpay().fetchIntent({ intentId: "order_q", resolveOwnership: true });
    expect(got.ownership).toBe("ours");
    expect(got.ownershipRef).toBe("idem_q");
    expect(got.providerObjectCreatedAt?.getTime()).toBe(EPOCH_MS);
    expect(got.providerChargeId).toBe("pay_q");
    expect(seen.filter((r) => r.method === "GET").length).toBe(2);
  });

  it("reports FOREIGN for an order that carries someone else's notes", async () => {
    stubFetch([
      {
        match: (m, u) => m === "GET" && u.endsWith("/orders/order_r/payments"),
        json: { items: [] },
      },
      {
        match: (m, u) => m === "GET" && u.endsWith("/orders/order_r"),
        json: { id: "order_r", created_at: EPOCH_SEC, notes: { product: "other-app" } },
      },
    ]);
    const got = await razorpay().fetchIntent({ intentId: "order_r", resolveOwnership: true });
    expect(got.ownership).toBe("foreign");
    expect(got.providerObjectCreatedAt?.getTime()).toBe(EPOCH_MS);
  });

  it("answers UNKNOWN when the order could not be read — a 5xx is not a verdict", async () => {
    stubFetch([
      {
        match: (m, u) => m === "GET" && u.endsWith("/orders/order_s/payments"),
        json: { items: [] },
      },
      {
        match: (m, u) => m === "GET" && u.endsWith("/orders/order_s"),
        status: 500,
        json: { error: { description: "we are down" } },
      },
    ]);
    const got = await razorpay().fetchIntent({ intentId: "order_s", resolveOwnership: true });
    expect(got.ownership).toBe("unknown");
  });

  it("answers UNKNOWN for an id shape it cannot query, without reaching the gateway", async () => {
    // The netbanking auth-link rail stores an `inv_…`; `GET /orders/inv_…` is a 400.
    const seen = stubFetch([]);
    const got = await razorpay().fetchIntent({ intentId: "inv_x", resolveOwnership: true });
    expect(got.status).toBe("unknown");
    expect(got.ownership).toBe("unknown");
    expect(seen.length).toBe(0);
  });
});
