import { describe, expect, it } from "vitest";
import { createdThroughLabel } from "../../dashboard/lib/created-through";
import { paymentSourceText } from "../../dashboard/lib/payment-trigger";

describe("createdThroughLabel", () => {
  it("names a member in the dashboard", () => {
    expect(createdThroughLabel({ source: "dashboard", actor: "sam@example.com" })).toBe(
      "In the dashboard by sam@example.com",
    );
  });
  it("starts every phrase with a capital", () => {
    expect(createdThroughLabel({ source: "api", actor: "key_1" })).toBe("Through the API");
    expect(createdThroughLabel({ source: "portal", actor: null })).toBe("In the customer portal");
    expect(createdThroughLabel({ source: "scheduled_job", actor: "billing_clock" })).toBe(
      "By the billing clock",
    );
    expect(createdThroughLabel({ source: "webhook", actor: "razorpay" })).toBe("From Razorpay");
    expect(createdThroughLabel({ source: "assistant", actor: "sam@example.com" })).toBe("By Billy");
  });
  it("says so when nothing was recorded", () => {
    expect(createdThroughLabel(null)).toBe("Not recorded");
  });
});

describe("paymentSourceText", () => {
  it("reads the trigger, or says nothing was recorded", () => {
    expect(paymentSourceText({ trigger: "checkout", actor: null })).toBe(
      "Paid by the customer in checkout",
    );
    expect(paymentSourceText(null)).toBe("Not recorded");
  });
});
