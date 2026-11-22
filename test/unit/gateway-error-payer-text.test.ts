import { describe, expect, it } from "vitest";
import {
  ALL_DECLINE_RULES,
  operatorFailureText,
  payerDeclineMessage,
  payerFailureText,
  PAYER_REASON_WITHHELD,
  PAYER_SAFE_INTERNAL_FAILURE,
  withBuiltInRetry,
  builtInDeclineAnswer,
} from "@/providers/decline-codes";

const F = "fallback";

describe("a payer never reads a raw gateway code", () => {
  it.each([
    ["insufficient_funds", "insufficient_funds"],
    ["E308", "E308"],
    ["payment_cancelled", "payment_cancelled"],
    ["card_declined", "Your card was declined by the issuer (05)."],
  ])("%s with gateway text %j gets our sentence", (code, message) => {
    const m = payerDeclineMessage({ code, message }, F);
    expect(m).not.toBe(message);
    expect(m).not.toMatch(/^[\w.:-]+$/);
  });

  it("an unknown code gets the neutral sentence", () => {
    expect(payerDeclineMessage({ code: "E308", message: "E308" }, F)).toBe(PAYER_REASON_WITHHELD);
  });

  it("a rule's payer sentence is shown, stored or live", () => {
    const rule = ALL_DECLINE_RULES.find((r) => r.message && r.exposedToPayer === true)!;
    expect(payerDeclineMessage({ code: rule.code, message: rule.message }, F)).toBe(rule.message);
  });

  it("an engine sentence under an engine-only code is shown", () => {
    const message = "There is no saved payment method to charge. Add one to settle this invoice.";
    expect(payerDeclineMessage({ code: "no_payment_method", message }, F)).toBe(message);
  });

  it("our own fault stays 'a problem on our side'", () => {
    expect(payerDeclineMessage({ code: "gateway_error", message: "TypeError" }, F)).toBe(
      PAYER_SAFE_INTERNAL_FAILURE,
    );
  });

  it("an absent failure gives the fallback", () => {
    expect(payerFailureText(undefined, F)).toBe(F);
  });
});

describe("the operator reads the gateway's sentence, else our label and the code", () => {
  it("keeps a sentence", () => {
    expect(
      operatorFailureText({ code: "insufficient_funds", message: "Not enough balance." }),
    ).toBe("Not enough balance.");
  });

  it("turns a bare code into a label with the gateway code beside it", () => {
    expect(
      operatorFailureText({ code: "insufficient_funds", providerCode: "E308", message: "E308" }),
    ).toBe("Insufficient funds. Gateway code: E308.");
  });

  it("names an unlabelled code generically, never as the bare token", () => {
    expect(operatorFailureText({ code: "payment_cancelled" })).toBe(
      "The gateway refused the payment. Gateway code: payment_cancelled.",
    );
  });
});

describe("our refused request retries on every gateway", () => {
  it("every built-in gateway_request_rejected rule answers retriable", () => {
    const rules = ALL_DECLINE_RULES.filter((r) => r.code === "gateway_request_rejected");
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(builtInDeclineAnswer(r).retriable, r.id).toBe(true);
  });

  it("an adapter's literal non-retriable answer is corrected before overrides", () => {
    expect(withBuiltInRetry({ code: "gateway_request_rejected", retriable: false }).retriable).toBe(
      true,
    );
    expect(withBuiltInRetry({ code: "expired_card", retriable: false }).retriable).toBe(false);
  });
});
