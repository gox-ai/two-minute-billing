import { describe, expect, it } from "vitest";
import { meterPriceFields } from "../../dashboard/lib/meter-price-form";

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

describe("meter price form", () => {
  it("edit: a cost-plus-markup price posts only its markup", () => {
    expect(
      meterPriceFields(
        form({ meter_present: "1", amount_source: "event_cost", markup_percent: "25" }),
        "edit",
      ),
    ).toEqual({ ok: true, body: { markup_percent: "25" } });
  });

  it("edit: a missing amount source is an error, never read as the rate card", () => {
    const r = meterPriceFields(form({ meter_present: "1", markup_percent: "25" }), "edit");
    expect(r).toMatchObject({ ok: false, field: "amount_source" });
  });

  it("create: no amount source means the rate card", () => {
    expect(
      meterPriceFields(
        form({
          meter_present: "1",
          meter: "ai_tokens",
          unit_amount_decimal: "300",
          quantity_divisor: "1000000",
          rates: "[]",
        }),
        "create",
      ),
    ).toEqual({
      ok: true,
      body: {
        meter: "ai_tokens",
        amount_source: "rate",
        unit_amount_decimal: "300",
        quantity_divisor: "1000000",
        rates: [],
      },
    });
  });
});
