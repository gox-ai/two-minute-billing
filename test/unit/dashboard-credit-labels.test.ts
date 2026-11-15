import { describe, expect, it } from "vitest";
import {
  heldUnsettledRows,
  holdAmount,
  movementCells,
  packCreditLabel,
  rateSentence,
  txnKindLabel,
  unitFormRate,
} from "../../dashboard/lib/credits";
import { historyLabel } from "../../dashboard/lib/portal-credits-view";

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

describe("a unit with no money rate", () => {
  it("shows its units and no money value", () => {
    const c = movementCells(150, 0, {
      ...token,
      key: "credit",
      plural: "credits",
      decimals: 1,
      rated: false,
    });
    expect(c.units).toBe("15 credits");
    expect(c.value).toBe("—");
  });
  it("has no rate sentence in money", () => {
    expect(rateSentence({ name: "credit", currency: "USD", minor_per_unit: null })).toBe(
      "No money value",
    );
    expect(rateSentence({ name: "credit", currency: "USD", minor_per_unit: "1" })).toBe(
      "1 credit = USD 0.01",
    );
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

describe("a hold's amount", () => {
  const units = [
    {
      id: "credit",
      name: "credit",
      plural_name: "credits",
      decimals: 1,
      currency: "USD",
      minor_per_unit: null,
    },
  ] as unknown as Parameters<typeof holdAmount>[1];
  it("a hold in money reads as money", () => {
    expect(holdAmount({ amount_minor: 1500, currency: "USD" }, units)).toBe("$15.00");
  });
  it("a hold in units reads as credits, never as money of 0", () => {
    const h = { amount_minor: 0, currency: "USD", unit: "credit" };
    expect(holdAmount({ ...h, units: "10.5" }, units)).toBe("10.5 credits");
    expect(holdAmount({ ...h, units: "1" }, units)).toBe("1 credit");
  });
  it("a lease that captured a step holds what remains; the table adds what it held at first", () => {
    const h = {
      amount_minor: 0,
      currency: "USD",
      unit: "credit",
      units: "900",
      remaining_units: "700",
    };
    expect(holdAmount(h, units)).toBe("700 credits");
    expect(holdAmount(h, units, { ofTotal: true })).toBe("700 of 900 credits");
    expect(holdAmount({ ...h, remaining_units: "900" }, units, { ofTotal: true })).toBe(
      "900 credits",
    );
    expect(holdAmount({ ...h, remaining_units: null }, units, { ofTotal: true })).toBe(
      "900 credits",
    );
    expect(holdAmount({ ...h, units: "1", remaining_units: "0.5" }, units, { ofTotal: true })).toBe(
      "0.5 of 1 credit",
    );
  });
});

describe("held and unsettled lines under an available figure", () => {
  const calls = {
    key: "api",
    name: "API call",
    plural: "API calls",
    decimals: 0,
    currency: "USD",
    rated: false,
  };
  it("both when not zero, the same words as the portal", () => {
    expect(heldUnsettledRows({ held: 900, unsettled: 150 }, calls)).toEqual([
      { label: "Held by open holds", value: "900 API calls" },
      { label: "Used, not settled yet", value: "150 API calls" },
    ]);
  });
  it("a zero or absent part has no line", () => {
    expect(heldUnsettledRows({ held: 0, unsettled: 350 }, calls)).toEqual([
      { label: "Used, not settled yet", value: "350 API calls" },
    ]);
    expect(heldUnsettledRows({}, calls)).toEqual([]);
  });
});

describe("a draw's label", () => {
  it("an invoice draw is applied to an invoice", () => {
    expect(txnKindLabel({ kind: "draw", settlement: null })).toBe("Applied to invoice");
    expect(txnKindLabel({ kind: "draw" })).toBe("Applied to invoice");
    expect(historyLabel({ kind: "draw", for_usage: false })).toBe("Used on an invoice");
    expect(historyLabel({ kind: "draw" })).toBe("Used on an invoice");
  });
  it("a settlement draw paid for usage", () => {
    expect(txnKindLabel({ kind: "draw", settlement: "cst_XXXXXXXXXXXX01" })).toBe("Used for usage");
    expect(historyLabel({ kind: "draw", for_usage: true })).toBe("Paid for usage");
  });
  it("only a draw reads the settlement", () => {
    expect(txnKindLabel({ kind: "restore", settlement: "cst_XXXXXXXXXXXX01" })).toBe("Restored");
    expect(txnKindLabel({ kind: "hold" })).toBe("hold");
    expect(historyLabel({ kind: "expire", for_usage: true })).toBe("Expired");
    expect(historyLabel({ kind: "hold" })).toBe("Credit changed");
  });
});

describe("the unit form's Money value choice", () => {
  it("No money value posts null, whatever the rate field holds", () => {
    expect(unitFormRate("1", undefined, "USD")).toBeNull();
    expect(unitFormRate("1", "0.01", "USD")).toBeNull();
  });
  it("Has a money value posts the rate in minor units", () => {
    expect(unitFormRate("", "0.01", "USD")).toBe("1");
    expect(unitFormRate(undefined, "0.5", "JPY")).toBe("0.5");
  });
  it("a missing or zero rate is not correct", () => {
    expect(unitFormRate("", "", "USD")).toBeUndefined();
    expect(unitFormRate(undefined, undefined, "USD")).toBeUndefined();
    expect(unitFormRate("", "0", "USD")).toBeUndefined();
    expect(unitFormRate("", "abc", "USD")).toBeUndefined();
  });
});
