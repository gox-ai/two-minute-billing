/**
 * The payer stopped ONE mandate debit at their bank or UPI app: `debit_cancelled_by_payer`,
 * retriable, mandate untouched. A buyer who left a checkout keeps RazorPay's own code.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { RazorpayProvider, razorpayPayerStoppedDebit } from "@/providers/razorpay";
import { normalizeCashfreeDecline, payerDeclineMessage } from "@/providers/decline-codes";

const SECRET = "unit-secret";
const deliver = async (payment: Record<string, unknown>) => {
  const body = JSON.stringify({
    entity: "event",
    event: "payment.failed",
    contains: ["payment"],
    created_at: 1_790_000_000,
    payload: { payment: { entity: payment } },
  });
  const p = new RazorpayProvider({
    keyId: "rzp_test_x",
    keySecret: "secret",
    apiBase: "https://api.razorpay.test/v1",
    webhookSecret: SECRET,
  });
  return p.normalizeWebhook({
    payload: body,
    headers: {
      "x-razorpay-signature": createHmac("sha256", SECRET).update(body).digest("hex"),
      "x-razorpay-event-id": "evt_unit_01",
    },
  });
};

const failed = (extra: Record<string, unknown>) => ({
  id: "pay_XXXXXXXXXXXX01",
  entity: "payment",
  status: "failed",
  amount: 49_900,
  currency: "INR",
  order_id: "order_XXXXXXXXXXXX01",
  error_code: "BAD_REQUEST_ERROR",
  error_reason: "payment_cancelled",
  error_description: "Payment was cancelled by the customer.",
  ...extra,
});

describe("razorpay: payment_cancelled", () => {
  it("on a UPI Autopay debit of a mandate is the payer stopping that debit", async () => {
    const [ev] = await deliver(failed({ method: "upi", token_id: "token_XXXXXXXXXX01" }));
    expect(ev?.type).toBe("charge.failed");
    expect(ev?.failureCode).toBe("debit_cancelled_by_payer");
    expect(ev?.failureRetriable).toBe(true);
    expect(ev?.providerFailureCode).toBe("payment_cancelled");
  });

  it("on an e-mandate debit too", async () => {
    const [ev] = await deliver(failed({ method: "emandate", token_id: "token_XXXXXXXXXX01" }));
    expect(ev?.failureCode).toBe("debit_cancelled_by_payer");
  });

  it("on a checkout (no token) is an unfinished payer step, not a stopped debit", async () => {
    const [ev] = await deliver(failed({ method: "upi" }));
    expect(ev?.failureCode).toBe("afa_not_completed");
  });

  it("on a saved card stays RazorPay's code: the buyer left the bank page", () => {
    expect(razorpayPayerStoppedDebit("payment_cancelled", { method: "card", token_id: "t" })).toBe(
      false,
    );
  });

  it("a debit charge() made counts without the payment entity", () => {
    expect(razorpayPayerStoppedDebit("payment_cancelled")).toBe(true);
    expect(razorpayPayerStoppedDebit("insufficient_funds")).toBe(false);
  });
});

describe("cashfree: eNACH returns where the payer stopped the debit", () => {
  it.each(["Payment Stopped by Drawer", "Item cancelled"])("%s", (message) => {
    const n = normalizeCashfreeDecline({ message });
    expect(n.code).toBe("debit_cancelled_by_payer");
    expect(n.retriable).toBe(true);
  });

  it("a stored row reads our sentence", () => {
    expect(
      payerDeclineMessage({ code: "debit_cancelled_by_payer", message: "Item cancelled" }, "x"),
    ).toBe(
      "You stopped this payment at your bank. Pay this invoice now, or allow the next automatic payment.",
    );
  });
});
