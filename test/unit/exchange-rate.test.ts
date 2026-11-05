import { describe, expect, it } from "vitest";
import { exchangeRateColumns, resolveIssueRate } from "@/modules/invoicing/exchange-rate";

/**
 * The whole value of the 0228 stamp is that a null means "not recorded" and a number
 * means "this is the rate that applied". Every test here pins one of the two, because
 * the failure mode is silent: a wrong-but-plausible rate produces a converted report
 * nobody can tell is wrong, and `1` in place of a missing rate is the most plausible
 * wrong value there is.
 */
const biz = (defaultCurrency: string | null, exchangeRates: unknown = null) =>
  ({ defaultCurrency, exchangeRates }) as Parameters<typeof resolveIssueRate>[0];

describe("resolveIssueRate", () => {
  it("stamps 1 for a document in the base currency, where the parity is a fact", () => {
    expect(resolveIssueRate(biz("USD"), "USD")).toEqual({ rate: "1", base: "USD" });
    // Case is not the caller's problem — currencies are compared upper.
    expect(resolveIssueRate(biz("usd"), "UsD")).toEqual({ rate: "1", base: "USD" });
  });

  it("stamps the configured rate for a foreign currency", () => {
    expect(resolveIssueRate(biz("USD", { INR: 94.953741 }), "INR")).toEqual({
      rate: "94.953741",
      base: "USD",
    });
  });

  it("keeps an operator-entered string rate at the precision they typed", () => {
    // `String(Number("94.9537410"))` would drop the trailing zero. The column is
    // `numeric`, so the precision survives the round trip only if we do not touch it.
    expect(resolveIssueRate(biz("USD", { INR: "94.9537410" }), "INR")).toEqual({
      rate: "94.9537410",
      base: "USD",
    });
    expect(resolveIssueRate(biz("USD", { INR: "  94.95  " }), "INR")).toEqual({
      rate: "94.95",
      base: "USD",
    });
  });

  it("returns null — never 1 — when there is no rate to report", () => {
    // NOT 1: 1 asserts parity with the base currency, which is a claim about money.
    expect(resolveIssueRate(biz("USD", { EUR: 0.86 }), "INR")).toBeNull();
    expect(resolveIssueRate(biz("USD", null), "INR")).toBeNull();
    expect(resolveIssueRate(biz("USD", {}), "INR")).toBeNull();
    // No base currency to measure against at all.
    expect(resolveIssueRate(biz(null, { INR: 94.95 }), "INR")).toBeNull();
    expect(resolveIssueRate(null, "INR")).toBeNull();
  });

  it("refuses an unusable rate rather than stamping it", () => {
    // `exchange_rates` is operator-edited jsonb, so all of these are reachable — and
    // `invoices_exchange_rate_valid` would turn a 0 or a negative into a 500 at insert.
    for (const bad of [0, -1, "0", "-3", "abc", "", null, true, {}, []]) {
      expect(resolveIssueRate(biz("USD", { INR: bad }), "INR"), String(bad)).toBeNull();
    }
  });

  it("maps a null snapshot onto both columns, so the pair CHECK holds", () => {
    // The constraint refuses a rate without a base and a base without a rate.
    expect(exchangeRateColumns(null)).toEqual({ exchangeRate: null, exchangeRateBase: null });
    expect(exchangeRateColumns({ rate: "94.95", base: "USD" })).toEqual({
      exchangeRate: "94.95",
      exchangeRateBase: "USD",
    });
  });
});
