import { describe, expect, it } from "vitest";
import { dunningHoldReason, resolveDunningConfig } from "@/modules/subscriptions/dunning-schedule";

const cfg = (minimum_amounts: unknown) =>
  resolveDunningConfig({ dunningConfig: { minimum_amounts } });
const facts = (outstandingMinor: bigint, currency = "USD", customerExcluded = false) => ({
  customerExcluded,
  currency,
  outstandingMinor,
});

describe("dunning hold", () => {
  it("keeps only upper-case codes with positive integer minor units", () => {
    expect(cfg({ USD: 500, usd: 1, EUR: 0, INR: 2.5, GBP: "9", JPY: 100 }).minimumAmounts).toEqual({
      USD: 500,
      JPY: 100,
    });
    expect(cfg(null).minimumAmounts).toEqual({});
    expect(cfg([1]).minimumAmounts).toEqual({});
  });

  it("holds below the minimum for the invoice's currency only", () => {
    const c = cfg({ USD: 500 });
    expect(dunningHoldReason(c, facts(499n))).toBe("below_minimum");
    expect(dunningHoldReason(c, facts(500n))).toBeNull();
    expect(dunningHoldReason(c, facts(1n, "EUR"))).toBeNull();
    expect(dunningHoldReason(c, facts(1n, "usd"))).toBe("below_minimum");
  });

  it("an empty map holds nothing; exclusion holds everything", () => {
    expect(dunningHoldReason(cfg({}), facts(1n))).toBeNull();
    expect(dunningHoldReason(cfg({}), facts(10_000n, "USD", true))).toBe("customer_excluded");
  });
});
