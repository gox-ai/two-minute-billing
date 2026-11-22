/**
 * An error-shaped processor decline (GraphQL error with a legacy code, no transaction) keeps
 * the code table's class. It was `gateway_error`, which told the payer "a problem on our side".
 */
import { describe, it, expect } from "vitest";
import { BraintreeApiError, BraintreeProvider } from "@/providers/braintree";

const bt = new BraintreeProvider({
  merchantId: "m",
  publicKey: "unit",
  privateKey: "unit",
  livemode: false,
});
const classify = (legacyCode: string, errorClass = "VALIDATION") =>
  (
    bt as unknown as {
      classifiedApiFailure(e: BraintreeApiError): { code: string; ruleId?: string } | undefined;
    }
  ).classifiedApiFailure(
    new BraintreeApiError("charge", [
      { message: "Declined", extensions: { errorClass, legacyCode } },
    ]),
  );

describe("braintree classifiedApiFailure accepts table codes", () => {
  it.each([
    ["2001", "insufficient_funds"],
    ["2004", "expired_card"],
    ["2000", "do_not_honor"],
  ])("legacy code %s → %s", (legacy, code) => {
    const f = classify(legacy);
    expect(f?.code).toBe(code);
    expect(f?.ruleId).toBeUndefined();
  });

  it("an unknown code outside the VALIDATION class is still left to the caller", () => {
    expect(classify("999999", "NOT_FOUND")).toBeUndefined();
  });

  it("an unknown VALIDATION code is our request, by its class", () => {
    const f = classify("999999");
    expect(f?.code).toBe("gateway_request_rejected");
    expect(f?.ruleId).toBe("braintree.category.validation");
  });

  it("a table code under an unknown-outcome class is left to the caller", () => {
    expect(classify("2001", "INTERNAL")).toBeUndefined();
  });
});
