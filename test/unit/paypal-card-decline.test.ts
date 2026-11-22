/**
 * A refused PayPal card payment is classified on `processor_response`, not on the
 * status word `DECLINED`: a stolen or expired card stops retries, and the failure keeps
 * PayPal's code and the rule id an override keys on.
 */
import { describe, it, expect } from "vitest";
import { PayPalProvider, paypalCardFailure } from "@/providers/paypal";
import { normalizePaypalDecline } from "@/providers/decline-codes";

type Call = { method: string; path: string };

function providerAnswering(
  answer: (c: Call) => { status: number; json: unknown },
  calls: Call[] = [],
): PayPalProvider {
  const p = new PayPalProvider({
    clientId: "unit",
    clientSecret: "unit",
    apiBase: "https://api.invalid",
  });
  const fake = async (_kind: string, method: string, path: string) => {
    const c = { method, path };
    calls.push(c);
    return answer(c);
  };
  (p as unknown as { api: unknown }).api = fake;
  (p as unknown as { callUntilAnswered: unknown }).callUntilAnswered = fake;
  return p;
}

const CARD = { card: { brand: "MASTERCARD", last_digits: "4444" } };

describe("paypalCardFailure", () => {
  it("reads the issuer's code and keeps it with the rule id", () => {
    const f = paypalCardFailure("DECLINED", {
      id: "CAP0000000000001",
      status: "DECLINED",
      processor_response: { response_code: "5120", avs_code: "Y", cvv_code: "M" },
    });
    expect(f.code).toBe("insufficient_funds");
    expect(f.retriable).toBe(true);
    expect(f.providerCode).toBe("5120");
    expect(f.ruleId).toBe("paypal.processor.5120");
    expect(f.message).toContain("Processor code: 5120.");
  });

  it("a lost card is a hard decline", () => {
    const f = paypalCardFailure("DECLINED", { processor_response: { response_code: "9520" } });
    expect(f.code).toBe("lost_card");
    expect(f.retriable).toBe(false);
  });

  it("advice 03 outranks the issuer's code", () => {
    const f = paypalCardFailure("DECLINED", {
      processor_response: { response_code: "5100", payment_advice_code: "03" },
    });
    expect(f.code).toBe("network_do_not_retry");
    expect(f.retriable).toBe(false);
  });

  it("a Mastercard wait advice sets retryAfterMs", () => {
    const f = paypalCardFailure(
      "DECLINED",
      { processor_response: { response_code: "5120", payment_advice_code: "02" } },
      "mastercard",
    );
    expect(f.retryAfterMs).toBe(72 * 3_600_000);
  });

  it("no processor answer falls back to the status word, not a raw token", () => {
    const f = paypalCardFailure("DECLINED", { status: "DECLINED" });
    expect(f.code).toBe("card_declined");
    expect(f.providerCode).toBe("DECLINED");
  });

  it("a processor code that blames our request is hidden and retried", () => {
    const n = normalizePaypalDecline({ code: "DECLINED", declineCode: "1350" });
    expect(n.code).toBe("gateway_request_rejected");
    expect(n.retriable).toBe(true);
    expect(n.exposedToPayer).toBe(false);
  });

  it("an expired order is a payment the buyer did not complete", () => {
    expect(normalizePaypalDecline("ORDER_EXPIRED").code).toBe("payment_abandoned");
    expect(normalizePaypalDecline("AUTHORIZATION_EXPIRED").code).toBe("intent_expired");
  });
});

describe("paypal charge(): a declined vaulted-card capture", () => {
  it("books the processor's reason", async () => {
    const p = providerAnswering(() => ({
      status: 201,
      json: {
        id: "ORDER000000000001",
        status: "COMPLETED",
        payment_source: CARD,
        purchase_units: [
          {
            payments: {
              captures: [
                {
                  id: "CAP0000000000001",
                  status: "DECLINED",
                  processor_response: { response_code: "5400" },
                },
              ],
            },
          },
        ],
      },
    }));
    const r = await p.charge({
      amountMinor: 5_000n,
      currency: "USD",
      customer: { providerKey: "paypal", providerCustomerId: "cus_unit" },
      paymentMethod: {
        providerKey: "paypal",
        providerPaymentMethodId: "vault_unit",
        display: { type: "card" },
      },
      idempotencyKey: "pay_unit_1",
      description: "unit",
    } as never);
    expect(r.status).toBe("failed");
    expect(r.failure?.code).toBe("expired_card");
    expect(r.failure?.retriable).toBe(false);
    expect(r.failure?.ruleId).toBe("paypal.processor.5400");
  });
});

describe("paypal consumeIntent: a DENIED authorization", () => {
  it("is booked as a decline and never captured", async () => {
    const calls: Call[] = [];
    const p = providerAnswering((c) => {
      if (c.method === "GET")
        return {
          status: 200,
          json: { id: "ORDER000000000002", status: "APPROVED", payment_source: CARD },
        };
      if (c.path.endsWith("/authorize"))
        return {
          status: 201,
          json: {
            id: "ORDER000000000002",
            status: "COMPLETED",
            purchase_units: [
              {
                payments: {
                  authorizations: [
                    {
                      id: "AUTH000000000002",
                      status: "DENIED",
                      processor_response: { response_code: "9500" },
                    },
                  ],
                },
              },
            ],
          },
        };
      return { status: 500, json: {} };
    }, calls);
    const r = await p.consumeIntent({
      purpose: "payment",
      intentId: "ORDER000000000002",
      idempotencyKey: "pi_consume_unit",
    } as never);
    expect(r.purpose).toBe("payment");
    const charge = (r as { charge: { status: string; failure?: { code: string } } }).charge;
    expect(charge.status).toBe("failed");
    expect(charge.failure?.code).toBe("fraudulent");
    expect(calls.some((c) => c.path.includes("/capture"))).toBe(false);
  });
});
