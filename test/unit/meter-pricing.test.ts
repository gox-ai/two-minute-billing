import { describe, expect, it } from "vitest";
import {
  computeLineAmount,
  meterPriceIssues,
  rateMeterCombination,
  resolveMeterRate,
  type MeterRate,
} from "@/modules/catalog/pricing";
import { FIXED12_SCALE, fixed12FromInt, parseFixed12 } from "@/platform/fixed";

const base = {
  model: "usage",
  amountSource: "rate",
  freeQuantity: 0,
  quantityDivisor: 1_000_000n,
  currencyExponent: 2,
};

describe("rateMeterCombination", () => {
  it("$3 per 1M input and $15 per 1M output tokens bill 370 + 685 minor, to the cent", () => {
    const input = rateMeterCombination({
      ...base,
      quantity: fixed12FromInt(1_234_567),
      rate: { unitAmountDecimal: "300", tiers: null },
    });
    const output = rateMeterCombination({
      ...base,
      quantity: fixed12FromInt(456_789),
      rate: { unitAmountDecimal: "1500", tiers: null },
    });
    expect(input.amountMinor).toBe(370n);
    expect(output.amountMinor).toBe(685n);
    expect(input.amountMinor + output.amountMinor).toBe(1055n);
    // 300 ÷ 10^6 minor per token.
    expect(input.unitAmount).toBe(parseFixed12("0.0003"));
  });

  it("with an integer rate and divisor 1 equals computeLineAmount", () => {
    for (let q = 0; q < 200; q += 7)
      for (const rate of [0, 1, 49, 1000]) {
        const got = rateMeterCombination({
          ...base,
          quantityDivisor: 1n,
          quantity: fixed12FromInt(q),
          rate: { unitAmountDecimal: String(rate), tiers: null },
        }).amountMinor;
        const want = computeLineAmount(
          {
            model: "usage",
            amountMinor: BigInt(rate),
            tiers: null,
            packageSize: null,
            freeUnits: null,
            percentageBps: null,
            freeQuantity: null,
          },
          q,
        );
        expect(got, `q=${q} rate=${rate}`).toBe(want);
      }
  });

  it("tiered decimal rates round once per line, not per tier", () => {
    // 3 tiers of 0.4 minor/unit each: per-tier rounding gives 0+0+0; once gives 1.
    const r = rateMeterCombination({
      ...base,
      model: "tiered",
      quantityDivisor: 1n,
      quantity: fixed12FromInt(3),
      rate: {
        unitAmountDecimal: null,
        tiers: [
          { up_to: "1", unit_amount_decimal: "0.4" },
          { up_to: "2", unit_amount_decimal: "0.4" },
          { up_to: null, unit_amount_decimal: "0.4" },
        ],
      },
    });
    expect(r.amountMinor).toBe(1n);
    expect(r.tiers?.map((t) => t.amount)).toEqual(["0.4", "0.4", "0.4"]);
  });

  it("volume bills every unit at its band's rate plus the band's flat fee", () => {
    const r = rateMeterCombination({
      ...base,
      model: "volume",
      quantity: fixed12FromInt(2_500_000),
      rate: {
        unitAmountDecimal: null,
        tiers: [
          { up_to: "1000000", unit_amount_decimal: "300" },
          { up_to: null, unit_amount_decimal: "250", flat_amount_minor: 5 },
        ],
      },
    });
    expect(r.amountMinor).toBe(625n + 5n);
  });

  it("package per 1M rounds packages up", () => {
    const r = rateMeterCombination({
      ...base,
      model: "package",
      quantityDivisor: 1n,
      packageSize: 1_000_000,
      quantity: fixed12FromInt(1_000_001),
      rate: { unitAmountDecimal: "250", tiers: null },
    });
    expect(r.amountMinor).toBe(500n);
  });

  it("free quantity comes off each line first", () => {
    const r = rateMeterCombination({
      ...base,
      quantityDivisor: 1n,
      freeQuantity: 10,
      quantity: fixed12FromInt(15),
      rate: { unitAmountDecimal: "2", tiers: null },
    });
    expect(r.amountMinor).toBe(10n);
    expect(r.billableQuantity).toBe(fixed12FromInt(5));
  });

  it("event_amount and event_cost + 20% convert major to minor exactly", () => {
    const amount = rateMeterCombination({
      ...base,
      amountSource: "event_amount",
      quantity: fixed12FromInt(2),
      rate: { unitAmountDecimal: null, tiers: null },
      amountSum: parseFixed12("1.234"),
    });
    expect(amount.amountMinor).toBe(123n);
    const cost = rateMeterCombination({
      ...base,
      amountSource: "event_cost",
      quantity: fixed12FromInt(2),
      rate: { unitAmountDecimal: null, tiers: null },
      costSum: parseFixed12("0.0125"),
      markupPercent: parseFixed12("20"),
    });
    // 0.0125 × 1.2 = 0.015 USD = 1.5 minor → 2.
    expect(cost.amountMinor).toBe(2n);
    const yen = rateMeterCombination({
      ...base,
      amountSource: "event_cost",
      currencyExponent: 0,
      quantity: FIXED12_SCALE,
      rate: { unitAmountDecimal: null, tiers: null },
      costSum: parseFixed12("100"),
      markupPercent: parseFixed12("12.5"),
    });
    expect(yen.amountMinor).toBe(113n);
  });
});

describe("rate card precedence", () => {
  const rates: MeterRate[] = [
    { id: "a", match: { model: "m1" }, unitAmountDecimal: "100", tiers: null },
    { id: "b", match: { token_type: "output" }, unitAmountDecimal: "200", tiers: null },
    {
      id: "c",
      match: { model: "m1", token_type: "output" },
      unitAmountDecimal: "300",
      tiers: null,
    },
  ];
  const snap = { rates, unitAmountDecimal: "1", tiers: null };
  const cases: Array<[Record<string, string>, string]> = [
    [{ model: "m1", token_type: "output" }, "300"], // most specific
    [{ model: "m1", token_type: "input" }, "100"],
    [{ model: "m2", token_type: "output" }, "200"],
    [{ model: "m2", token_type: "output_x" }, "1"], // default rate
  ];
  for (const [group, want] of cases)
    it(`${JSON.stringify(group)} → ${want}`, () => {
      expect(resolveMeterRate(snap, group).unitAmountDecimal).toBe(want);
    });

  it("on a tie the oldest rate wins", () => {
    const r = resolveMeterRate(
      { rates: [rates[0]!, rates[1]!], unitAmountDecimal: "1", tiers: null },
      { model: "m1", token_type: "output" },
    );
    expect(r.match).toEqual({ model: "m1" });
  });
});

describe("meterPriceIssues", () => {
  it("refuses a rate with 13 decimals, an exponent, a match off group_by and a duplicate", () => {
    const issues = meterPriceIssues(
      {
        model: "usage",
        unitAmountDecimal: "0.1234567890123",
        rates: [
          { match: { model: "a" }, unitAmountDecimal: "1e3" },
          { match: { region: "eu" }, unitAmountDecimal: "1" },
          { match: { model: "a" }, unitAmountDecimal: "2" },
        ],
      },
      ["model", "token_type"],
    ).map((i) => i.field);
    expect(issues).toEqual(
      expect.arrayContaining([
        "unit_amount_decimal",
        "rates.0.unit_amount_decimal",
        "rates.1.match.region",
        "rates.2.match",
      ]),
    );
  });

  it("refuses tiers or rates on a dynamic price, and a markup on event_amount", () => {
    const fields = meterPriceIssues(
      { model: "usage", amountSource: "event_amount", unitAmountDecimal: "1", markupPercent: "10" },
      [],
    ).map((i) => i.field);
    expect(fields).toEqual(expect.arrayContaining(["amount_source", "markup_percent"]));
  });

  it("refuses a flat model", () => {
    expect(meterPriceIssues({ model: "flat", unitAmountDecimal: "1" }, [])[0]?.field).toBe("model");
  });
});
