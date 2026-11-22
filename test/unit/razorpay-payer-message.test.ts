import { describe, it, expect } from "vitest";
import { RazorpayProvider } from "@/providers/razorpay";
import { payerDeclineMessage } from "@/providers/decline-codes";

const razorpay = new RazorpayProvider({
  keyId: "rzp_test_x",
  keySecret: "secret",
  apiBase: "https://api.razorpay.test/v1",
  webhookSecret: "test-webhook-secret",
});
const decline = (error: Record<string, string>) =>
  (
    razorpay as unknown as {
      declineFailure(
        json: unknown,
        status: number,
      ): {
        code: string;
        message: string;
        exposedToPayer?: boolean;
        retriable?: boolean;
      };
    }
  ).declineFailure({ error }, 400);

describe("RazorPay declines: whose words reach the payer", () => {
  it("a bank that does not permit the payment gets our next step, not 'a temporary issue'", () => {
    // RazorPay's own description told the payer to wait for a refund (production, 2026-11-02).
    const f = decline({
      code: "GATEWAY_ERROR",
      reason: "Transaction not permitted to issuer/cardholder",
      description:
        "Your payment didn't go through due to a temporary issue. Any debited amount will be refunded in 4-5 business days.",
    });
    expect(f.code).toBe("card_restricted");
    // Visa 57: never resubmit (decline audit 2026-11-18).
    expect(f.retriable).toBe(false);
    expect(f.message).toBe(
      "Your bank does not allow this payment on this card. Contact your bank to allow it, or use a different card.",
    );
    expect(payerDeclineMessage(f, "fallback")).toBe(f.message);
  });

  it("a refusal hidden from the payer keeps RazorPay's description for the operator", () => {
    const f = decline({
      code: "BAD_REQUEST_ERROR",
      description: "The id provided does not exist",
    });
    expect(f.code).toBe("gateway_request_rejected");
    expect(f.message).toBe("The id provided does not exist");
    expect(f.exposedToPayer).toBe(false);
    expect(payerDeclineMessage(f, "fallback")).not.toContain("does not exist");
  });
});
