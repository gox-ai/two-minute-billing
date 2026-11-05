import { describe, it, expect } from "vitest";
import { fromStripeAmount, toStripeAmount } from "@/providers/stripe";

describe("Stripe amounts", () => {
  it("sends ordinary currencies as our minor units", () => {
    expect(toStripeAmount(1050n, "USD")).toBe(1050);
    expect(toStripeAmount(1000n, "JPY")).toBe(1000);
    expect(fromStripeAmount(1050, "usd")).toBe(1050n);
  });

  it("sends ISK and UGX as two-decimal amounts ending in 00", () => {
    expect(toStripeAmount(5n, "ISK")).toBe(500);
    expect(fromStripeAmount(500, "isk")).toBe(5n);
  });

  it("sends MGA in whole units, which is ISO two-decimal for us", () => {
    // 1,000 ariary is 100000 minor units here and 1000 at Stripe; a 1:1 pass charged 100x.
    expect(toStripeAmount(100_000n, "MGA")).toBe(1000);
    expect(fromStripeAmount(1000, "mga")).toBe(100_000n);
  });

  it("refuses an MGA amount with a fraction rather than rounding it", () => {
    expect(() => toStripeAmount(100_050n, "MGA")).toThrow(/whole units only/);
  });
});
