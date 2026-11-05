import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { STRIPE_CODE_TABLE, STRIPE_RULES, normalizeStripeDecline } from "@/providers/decline-codes";
import { classifyDecline } from "@/modules/subscriptions/decline-policy";

/**
 * The adapter used to ask a hardcoded `err.code === "payment_intent_payment_attempt_failed"`,
 * so § 5 of decline-codes.ts held rules that could never fire. These pin the rules as the
 * single source of that answer.
 */
describe("thrown invalid_request_error → the rules decide", () => {
  const codeRules = STRIPE_RULES.filter(
    (r) => r.code === "gateway_request_rejected" && r.field === "code" && r.op === "eq",
  );

  it("every gateway_request_rejected code rule is reachable from a bare code", () => {
    expect(codeRules.length).toBeGreaterThanOrEqual(7);
    for (const rule of codeRules) {
      const n = normalizeStripeDecline({ code: String(rule.value) });
      expect(n.code, rule.id).toBe("gateway_request_rejected");
      expect(n.ruleId, rule.id).toBe(rule.id);
    }
  });

  it("the real INV-100004 code books the CUSTOMER's remedy, not an operator's", () => {
    // Taken verbatim from the production gateway log for the 00:00 renewal:
    //   { "code": "payment_intent_mandate_invalid", "type": "invalid_request_error",
    //     "message": "Only active mandates can be used with PaymentIntents." }
    // The table names it `mandate_expired` — the mandate lapsed and only a new one
    // recovers it — so it parks for the customer to re-authorise. Getting this wrong sends
    // an operator after a problem only the customer can clear.
    const n = normalizeStripeDecline({ code: "payment_intent_mandate_invalid" });
    expect(n.code).toBe("mandate_expired");
    expect(classifyDecline(n.code)).toBe("park");
    // Recognised through the legacy TABLE rather than a rule, which is why the adapter's
    // gate is "did the rules recognise this at all" and not "is it one specific token".
    expect("payment_intent_mandate_invalid" in STRIPE_CODE_TABLE).toBe(true);
  });

  it("does not resurrect the phantom code that was invented for it", () => {
    // `payment_intent_mandate_inactive` had a rule until 2026-09-10 and exists nowhere in
    // the Stripe SDK. It claimed `gateway_request_rejected` — the opposite remedy to the
    // real code above. A guessed code is worse than an honest fall-through.
    expect(STRIPE_RULES.some((r) => r.value === "payment_intent_mandate_inactive")).toBe(false);
  });

  it("a code no rule names does NOT become a request rejection", () => {
    // Narrowness: the adapter books only what the rules classify and throws the rest, so
    // our own bugs keep surfacing instead of being buried as declines.
    const n = normalizeStripeDecline({ code: "some_code_we_never_saw" });
    expect(n.code).not.toBe("gateway_request_rejected");
  });

  it("the adapter no longer hardcodes the one code it used to know", () => {
    const src = readFileSync("src/providers/stripe.ts", "utf8");
    expect(src).not.toContain('err.code === "payment_intent_payment_attempt_failed"');
    expect(src).toContain("requestRejectedFailure");
  });
});
