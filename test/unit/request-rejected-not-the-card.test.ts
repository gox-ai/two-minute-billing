import { describe, expect, it } from "vitest";
import { isHardDecline, shouldTryBackup } from "@/modules/invoicing/collection";
import { normalizeRazorpayDecline, normalizeStripeDecline } from "@/providers/decline-codes";
import { MERCHANT_SIDE_PARK, classifyDecline } from "@/modules/subscriptions/decline-policy";

/**
 * A REQUEST WE MALFORMED MUST NOT BRAND THE CUSTOMER'S CARD.
 *
 * Every rule emitting `gateway_request_rejected` says "Nothing is wrong with the customer's
 * payment method" — and `isHardDecline` then marked that payment method `invalid`, pulling a
 * working card out of collection for every FUTURE charge. Latent in the Stripe rules since
 * #63 and reachable for RazorPay from 2026-09-10, when `BAD_REQUEST_ERROR` was corrected from
 * `card_declined` to this code.
 *
 * The code stays non-retriable — an identical rejected request cannot succeed — so what had
 * to change is the instrument verdict, not the retry verdict.
 */
describe("a rejected request is never the instrument's fault", () => {
  const failed = (code: string, retriable: boolean) => ({
    status: "failed",
    failure: { code, retriable },
  });

  it("does not mark the payment method invalid", () => {
    expect(isHardDecline(failed("gateway_request_rejected", false))).toBe(false);
  });

  it("still tries the backup — a different instrument may route elsewhere", () => {
    expect(shouldTryBackup(failed("gateway_request_rejected", false))).toBe(true);
  });

  it("stays non-retriable and parks, so dunning surfaces it instead of looping", () => {
    expect(classifyDecline("gateway_request_rejected")).toBe("park");
    expect(MERCHANT_SIDE_PARK.has("gateway_request_rejected")).toBe(true);
  });

  it("holds for the RazorPay envelope code that reaches it", () => {
    // A 400 with no `error.reason`: declineFailure prefers the reason, so only the
    // ambiguous request-level case lands here.
    const n = normalizeRazorpayDecline({ code: "BAD_REQUEST_ERROR" });
    expect(n.code).toBe("gateway_request_rejected");
    expect(n.retriable).toBe(false);
    expect(isHardDecline(failed(n.code, n.retriable))).toBe(false);
  });

  it("holds for the Stripe rules that reach it too", () => {
    const n = normalizeStripeDecline({ code: "payment_intent_invalid_parameter" });
    expect(n.code).toBe("gateway_request_rejected");
    expect(isHardDecline(failed(n.code, n.retriable ?? false))).toBe(false);
  });

  it("a genuine card decline is still branded — the exemption is narrow", () => {
    // The guard must not have been widened into "never blame the instrument".
    expect(isHardDecline(failed("expired_card", false))).toBe(true);
    expect(isHardDecline(failed("stolen_card", false))).toBe(true);
  });
});
