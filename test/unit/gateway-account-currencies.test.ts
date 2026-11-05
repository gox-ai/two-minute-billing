import { describe, expect, it } from "vitest";
import { assertBusinessCurrencies, assertGatewayCurrencies } from "@/modules/gateway/service";

const biz = { defaultCurrency: "INR", currencies: ["INR", "USD"] };

describe("assertBusinessCurrencies", () => {
  it("accepts the business's currencies, case-insensitively", () => {
    expect(() => assertBusinessCurrencies(biz, ["inr", "USD"])).not.toThrow();
  });

  it("refuses a currency the business does not bill in, naming it", () => {
    expect(() => assertBusinessCurrencies(biz, ["USD", "KWD"])).toThrow(
      "This business does not bill in KWD. Add it to the business currencies",
    );
  });

  it("accepts the default currency even when the list omits it", () => {
    expect(() =>
      assertBusinessCurrencies({ defaultCurrency: "EUR", currencies: ["USD"] }, ["EUR"]),
    ).not.toThrow();
  });

  it("refuses nothing for a business with no currency list", () => {
    expect(() =>
      assertBusinessCurrencies({ defaultCurrency: "INR", currencies: null }, ["JPY"]),
    ).not.toThrow();
  });

  it("keeps a currency the account already holds", () => {
    expect(() => assertBusinessCurrencies(biz, ["USD", "GBP"], ["GBP"])).not.toThrow();
    expect(() => assertBusinessCurrencies(biz, ["GBP", "JPY"], ["GBP"])).toThrow("bill in JPY.");
  });

  it("accepts an empty or null list (no restriction on the account)", () => {
    expect(() => assertBusinessCurrencies(biz, [])).not.toThrow();
    expect(() => assertBusinessCurrencies(biz, null)).not.toThrow();
  });
});

describe("assertGatewayCurrencies", () => {
  it("accepts currencies on the gateway's list, case-insensitively", () => {
    expect(() => assertGatewayCurrencies("cashfree", ["inr", "USD", "JPY"])).not.toThrow();
  });

  it("refuses a currency the gateway does not take, naming the gateway and the codes", () => {
    expect(() => assertGatewayCurrencies("payu", ["INR", "USD", "EUR"])).toThrow(
      "We could not save the gateway account. PayU does not take USD, EUR. Remove them from this account.",
    );
    expect(() => assertGatewayCurrencies("cashfree", ["KWD"])).toThrow(
      "Cashfree does not take KWD. Remove it from this account.",
    );
  });

  it("keeps a currency the account already holds", () => {
    expect(() => assertGatewayCurrencies("payu", ["INR", "USD"], ["usd"])).not.toThrow();
    expect(() => assertGatewayCurrencies("payu", ["USD", "EUR"], ["USD"])).toThrow("take EUR.");
  });

  it("refuses nothing for a gateway with no list, or an empty or null list", () => {
    expect(() => assertGatewayCurrencies("tmtest", ["KWD"])).not.toThrow();
    expect(() => assertGatewayCurrencies("payu", [])).not.toThrow();
    expect(() => assertGatewayCurrencies("payu", null)).not.toThrow();
  });
});
