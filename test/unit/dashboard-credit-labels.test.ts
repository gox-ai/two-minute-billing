import { describe, expect, it } from "vitest";
import { movementCells, packCreditLabel } from "../../dashboard/lib/credits";

const money = { key: null, name: "USD", plural: "USD", decimals: 0, currency: "USD" };
const token = { key: "token", name: "token", plural: "tokens", decimals: 0, currency: "USD" };

describe("credit transactions: Units and Value", () => {
  it("a money movement reads the same in both cells, one minus sign", () => {
    const c = movementCells(-1500, -1500, money);
    expect(c.units).toBe(c.value);
    expect(c.units).toBe("-$15.00");
  });
  it("a unit movement uses the same sign as the value", () => {
    const c = movementCells(-1, -10, token);
    expect(c.units).toBe("-1 token");
    expect(c.value).toBe("-$0.10");
  });
});

describe("portal pack row", () => {
  const base = { unit_name: "EUR", unit_plural_name: "EUR", decimals: 0, currency: "EUR" };
  it("a money pack states money, not minor units", () => {
    expect(packCreditLabel({ ...base, unit: null, credit_amount: 2000 })).toBe("€20.00 of credit");
  });
  it("a unit pack states its units", () => {
    expect(
      packCreditLabel({
        unit: "token",
        unit_name: "token",
        unit_plural_name: "tokens",
        decimals: 0,
        credit_amount: 1000,
        currency: "USD",
      }),
    ).toBe("1,000 tokens");
  });
});
