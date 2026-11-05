import { describe, expect, it } from "vitest";
import { ratingDetail } from "@/modules/invoicing/invoice-pdf";
import { ratingRows } from "../../dashboard/lib/usage-aggregation";

// A meter line's tiers: decimal strings, the amount unrounded in minor units.
const rating = {
  quantity: 16,
  free_quantity: 0,
  level: null,
  tiers: [
    {
      from: "0",
      to: "10",
      units: "10",
      unit_amount_decimal: "100",
      flat_amount_minor: 0,
      amount: "1000",
    },
    {
      from: "10",
      to: null,
      units: "6",
      unit_amount_decimal: "50",
      flat_amount_minor: 0,
      amount: "300.4",
    },
  ],
};
const fmt = (m: number | bigint) => `$${(Number(m) / 100).toFixed(2)}`;

describe("meter tier rows", () => {
  it("print each tier's amount on the PDF", () => {
    expect(ratingDetail(rating as never, fmt)).toEqual([
      "Units 0 to 10: 10 = $10.00",
      "Units 10 and more: 6 = $3.00",
    ]);
  });
  it("show each tier's amount on the dashboard, not a dash", () => {
    expect(ratingRows(rating as never, fmt)).toEqual([
      "Units 0 to 10: 10 = $10.00",
      "Units 10 and more: 6 = $3.00",
    ]);
  });
});
