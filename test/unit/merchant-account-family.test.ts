import { describe, expect, it } from "vitest";
import {
  declineSets,
  normalizePayuDecline,
  normalizeStripeDecline,
} from "@/providers/decline-codes";
import { resolveErrorId } from "@/platform/error-taxonomy";

// A code in the `merchant_account` family raises the operator's "Payment gateway needs
// attention" alert. A refusal the PAYER can clear with a different method must never land
// there. Adding a gateway code to this list means confirming it is the merchant's setup.
const MERCHANT_SIDE: Record<string, string[]> = {
  stripe: [
    "table:payment_method_unactivated",
    "code:capability_not_active",
    "code:testmode_charges_only",
    "code:sepa_unsupported_account",
    "code:action_blocked",
    "code:anomalous_money_movement_request",
  ],
  paypal: [
    "code:PERMISSION_DENIED",
    "code:PAYEE_NOT_CONSENTED",
    "code:CONSENT_NEEDED",
    "code:NOT_ENABLED_FOR_PAYMENT_SOURCE",
    "code:NOT_ELIGIBLE_FOR_TOKEN_PROCESSING",
    "code:AUTH_CAPTURE_NOT_ENABLED",
    "code:DOMESTIC_TRANSACTION_REQUIRED",
    "code:NOT_ENABLED_FOR_CARD_PROCESSING",
    "code:PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING",
    "code:NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE",
    "code:PAYMENT_TYPE_NOT_SUPPORTED_FOR_INTENT",
    "code:UNSUPPORTED_INTENT_FOR_PAYMENT_SOURCE",
  ],
  razorpay: ["table:recurring_payment_not_enabled", "code:recurring_payment_not_enabled"],
  cashfree: ["category:feature_not_enabled"],
  adyen: ["code:api:107"],
  payu: ["code:E4291", "code:E4121", "code:E4382"],
};

describe("merchant-account family (gateway alert)", () => {
  it("only reviewed gateway codes map into it", () => {
    const found: Record<string, string[]> = {};
    for (const [gw, s] of declineSets()) {
      const merchant = (c: string) => resolveErrorId(c).family === "merchant_account";
      const hits = [
        ...Object.entries(s.table)
          .filter(([, c]) => merchant(c))
          .map(([k]) => `table:${k}`),
        ...s.rules.filter((r) => merchant(r.code)).map((r) => `${r.field}:${r.value}`),
      ];
      if (hits.length) found[gw] = hits;
    }
    expect(found).toEqual(MERCHANT_SIDE);
  });

  it("payer-side refusals do not raise it", () => {
    const payer = [
      // The adapter sends `decline_code` as the code (`stripeDeclineReason`).
      normalizeStripeDecline({ code: "card_not_supported", declineCode: "card_not_supported" }),
      normalizePayuDecline({ code: "E755" }),
      normalizePayuDecline({ code: "E756" }),
      normalizePayuDecline({ code: "E4290" }),
    ];
    for (const n of payer) {
      expect(resolveErrorId(n.code).family).not.toBe("merchant_account");
      expect(n.retriable).toBe(false);
    }
  });
});
