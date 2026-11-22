import { describe, it, expect } from "vitest";
import { splitTax } from "../../dashboard/lib/tax-rows";

describe("splitTax", () => {
  it("all inside: no rows, the whole figure is included", () => {
    expect(splitTax(1785, [])).toEqual({ addedMinor: 0, includedMinor: 1785 });
  });

  it("all added: rows sum to the figure, nothing included", () => {
    const rows = [
      { label: "CGST (9.00%)", amount_minor: 900 },
      { label: "SGST/UTGST (9.00%)", amount_minor: 900 },
    ];
    expect(splitTax(1800, rows)).toEqual({ addedMinor: 1800, includedMinor: 0 });
  });

  it("mixed: rows are the added part, the rest is included", () => {
    expect(splitTax(2500, [{ amountMinor: 1000 }])).toEqual({
      addedMinor: 1000,
      includedMinor: 1500,
    });
  });

  it("no breakdown at all: treated as added, as screens always showed it", () => {
    expect(splitTax(1800, undefined)).toEqual({ addedMinor: 1800, includedMinor: 0 });
    expect(splitTax(undefined, undefined)).toEqual({ addedMinor: 0, includedMinor: 0 });
  });
});
