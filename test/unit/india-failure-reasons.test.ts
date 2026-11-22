import { describe, expect, it } from "vitest";
import { planFailureRearm } from "@/modules/subscriptions/dunning-schedule";
import { razorpayPaymentFailure } from "@/providers/razorpay";
import { normalizeCashfreeEvent } from "@/providers/cashfree";
import { normalizePayuPayment } from "@/providers/payu";

const base = {
  dunningStatus: null,
  currentNextAttemptAt: null,
  autoCollectOn: true,
  retriable: true,
  newAttemptCount: 1,
  now: new Date("2026-01-10T00:00:00Z"),
  dueDate: new Date("2026-01-09T00:00:00Z"),
  retryDays: [1, 3, 5, 7],
  declineCode: "insufficient_funds",
  mandateRail: "enach",
};

describe("a refusal repeated in the next cycle parks", () => {
  it("insufficient funds on eNACH retries, unless the last cycle ended the same way", () => {
    for (const mode of ["fixed", "smart"] as const) {
      expect(planFailureRearm({ ...base, mode }).action, mode).toBe("retry");
      expect(planFailureRearm({ ...base, mode, repeatedAcrossCycles: true }).action, mode).toBe(
        "parked",
      );
    }
  });
});

describe("the gateway's reason reaches the attempt", () => {
  it("Razorpay: a failed payment keeps its reason, words and rule", () => {
    const f = razorpayPaymentFailure({
      error_reason: "incorrect_ifsc",
      error_code: "BAD_REQUEST_ERROR",
      error_description: "IFSC code no longer valid",
    });
    expect(f).toMatchObject({
      code: "bank_account_invalid_details",
      providerCode: "incorrect_ifsc",
      message: "IFSC code no longer valid",
      retriable: false,
      ruleId: "razorpay.code.incorrect_ifsc",
    });
  });

  it("Razorpay: a payer sentence replaces the description", () => {
    const f = razorpayPaymentFailure({
      error_reason: "transaction_limit_exceeded",
      error_description: "Payment failed",
    });
    expect(f.code).toBe("insufficient_funds");
    expect(f.message).toMatch(/limit set on your account/);
  });

  it("Cashfree: a refused authorization carries the bank's reason", () => {
    const ev = normalizeCashfreeEvent("SUBSCRIPTION_AUTH_STATUS", {
      subscription_id: "tms_XXXXXXXXXXXX01",
      payment_status: "FAILED",
      failure_details: { failure_reason: "RESPAUTHMANDATE DECLINED BY PSP" },
    });
    expect(ev).toMatchObject({
      type: "intent.setup_failed",
      failureCode: "card_declined",
      providerFailureCode: "RESPAUTHMANDATE DECLINED BY PSP",
    });
  });

  it("PayU: a refused registration carries its E-code", () => {
    const ev = normalizePayuPayment({
      txnid: "tmsuXXXXXXXXXX01",
      mihpayid: "1",
      status: "failure",
      error: "E4271",
      error_Message: "Mandate request declined by the customer",
    });
    expect(ev.type).toBe("intent.setup_failed");
    expect(ev.providerFailureCode).toBe("E4271");
    expect(ev.failureCode).toBe("debit_not_authorized");
  });
});
