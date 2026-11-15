import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHECKOUTCOM_OWNERSHIP_KEY,
  CheckoutcomProvider,
  encodeCheckoutcomIntent,
} from "@/providers/checkoutcom";

// Flow can report a completed payment with no id. The engine then finds it by the session's
// reference, so the buyer is never told to pay a second time.
const REF = "pi_XXXXXXXXXXXX01";
const SESSION = "ps_XXXXXXXXXXXX01";
const intentId = encodeCheckoutcomIntent({
  p: "payment",
  s: SESSION,
  cur: "USD",
  a: "2500",
  r: REF,
});

const provider = () =>
  new CheckoutcomProvider({
    secretKey: "sk_sbox_XXXXXXXXXXXX",
    publicKey: "pk_sbox_XXXXXXXXXXXX",
    processingChannelId: "pc_XXXXXXXXXXXX",
    apiPrefix: "abcd1234",
    defaultCountry: "US",
    livemode: false,
    entityId: "ent_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  });

const payment = (status: string) => ({
  id: "pay_XXXXXXXXXXXX01",
  status,
  approved: status !== "Declined",
  amount: 2500,
  currency: "USD",
  reference: REF,
  metadata: { cko_payment_session_id: SESSION, [CHECKOUTCOM_OWNERSHIP_KEY]: REF },
  source: { type: "card", scheme: "Visa", last4: "4242" },
});

function stubGateway(found: unknown[]) {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      seen.push(url);
      const body = url.includes("/payments?reference=")
        ? { data: found }
        : url.includes("/payments/pay_")
          ? found[0]
          : {};
      return new Response(JSON.stringify(body), {
        status: url.includes("/payments/pay_") && !found.length ? 404 : 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("Checkout.com: a Flow payment with no id is found by the session's reference", () => {
  it("an authorized payment on the session authorizes the intent", async () => {
    const seen = stubGateway([payment("Authorized")]);
    const r = await provider().submitClientResult({
      intentId,
      purpose: "payment",
      clientResult: { lookup: "reference" },
      idempotencyKey: "k1",
    });
    expect(r.status).toBe("authorized");
    expect(r.providerChargeId).toBe("pay_XXXXXXXXXXXX01");
    expect(seen.some((u) => u.includes(`/payments?reference=${REF}`))).toBe(true);
  });

  it("no payment yet: the intent waits, it is never refused", async () => {
    stubGateway([]);
    const r = await provider().submitClientResult({
      intentId,
      purpose: "payment",
      clientResult: { lookup: "reference" },
      idempotencyKey: "k2",
    });
    expect(r.status).toBe("requires_action");
  });

  it("without the lookup flag, a missing id is still refused", async () => {
    stubGateway([payment("Authorized")]);
    const r = await provider().submitClientResult({
      intentId,
      purpose: "payment",
      clientResult: {},
      idempotencyKey: "k3",
    });
    expect(r.status).toBe("failed");
  });

  it("releasing a session we never heard back from voids its payment, found by reference", async () => {
    const seen = stubGateway([payment("Authorized")]);
    await provider().voidIntent({ intentId, idempotencyKey: "k4" });
    expect(seen.some((u) => u.includes(`/payments?reference=${REF}`))).toBe(true);
    expect(seen.some((u) => u.includes("/payments/pay_XXXXXXXXXXXX01/voids"))).toBe(true);
  });
});
