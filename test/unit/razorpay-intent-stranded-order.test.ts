/**
 * #63 for RazorPay — a rejection that left an ORDER behind must not lose it.
 *
 * The caller books every throw out of `createIntent` as `gateway_request_rejected`
 * (13152c64), so the failure itself is recorded. What it cannot recover is the gateway
 * object: its synthesised ref carries `intentId: ""`, and an order RazorPay kept — with
 * our `notes.tmbilling_ref` on it and no local row — trips `orphaned_gateway_intents` on
 * every retry. RazorPay names it in the documented error envelope,
 * `error.metadata.order_id`.
 */
import { describe, it, expect } from "vitest";
import { RazorpayProvider } from "@/providers/razorpay";

function providerAnswering(status: number, json: unknown): RazorpayProvider {
  const p = new RazorpayProvider({
    keyId: "rzp_test_unit",
    keySecret: "unit",
    apiBase: "https://api.invalid",
  });
  (p as unknown as { api: unknown }).api = async () => ({ status, json });
  return p;
}

const INPUT = {
  purpose: "payment" as const,
  currency: "INR",
  amountMinor: 5_000_00n,
  customer: { providerKey: "razorpay" as const, providerCustomerId: "cust_unit" },
  idempotencyKey: "pi_create_pi_unit_a1",
  session: "on_session" as const,
};

/** The documented RazorPay error envelope, naming the objects the request touched. */
function rejectedWithOrder(reason?: string) {
  return {
    error: {
      code: "BAD_REQUEST_ERROR",
      description: "Authentication failed due to incorrect otp",
      ...(reason ? { reason } : {}),
      metadata: { order_id: "order_unit_stranded", payment_id: "pay_unit" },
    },
  };
}

describe("razorpay createIntent: the order RazorPay kept comes back as data", () => {
  it("returns the stranded order id instead of throwing", async () => {
    const ref = await providerAnswering(400, rejectedWithOrder("invalid_otp")).createIntent(INPUT);
    expect(ref.intentId).toBe("order_unit_stranded");
    // Never `requires_action`: `intentVoid` is false here, so a buyer sent into Checkout
    // on an order the gateway refused is a hold we could never unwind.
    expect(ref.status).toBe("inited");
    expect(ref.authorization).toBeUndefined();
    expect(ref.failure).toBeDefined();
  });

  it("classifies through declineFailure when RazorPay named a reason", async () => {
    const ref = await providerAnswering(400, rejectedWithOrder("invalid_otp")).createIntent(INPUT);
    expect(ref.failure?.providerCode).toBe("invalid_otp");
  });

  it("does NOT let the generic envelope code become card_declined", async () => {
    // `RAZORPAY_CODE_TABLE` maps `BAD_REQUEST_ERROR` to `card_declined`. With no `reason`
    // that is all `declineFailure` would have, and it would report our own malformed
    // request as the customer's card failing.
    const ref = await providerAnswering(400, rejectedWithOrder()).createIntent(INPUT);
    expect(ref.failure?.code).toBe("gateway_request_rejected");
    expect(ref.failure?.retriable).toBe(false);
  });

  it("STILL THROWS when no order id is stranded", async () => {
    // Nothing was left at the gateway, so there is nothing the caller's backstop does
    // not already record.
    const noObject = { error: { code: "BAD_REQUEST_ERROR", description: "amount is required" } };
    await expect(providerAnswering(400, noObject).createIntent(INPUT)).rejects.toThrow(
      /payment-intent order failed/i,
    );
  });
});
