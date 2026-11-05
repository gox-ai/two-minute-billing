import { describe, it, expect } from "vitest";
import {
  creditNoteTaxShare,
  lineTaxShare,
  type CreditNoteTaxInput,
} from "@/modules/credit-notes/note-tax";

// Invoice: 9,500 at 10% (+950), 4,750 not taxable, 2,850 + 1,900 at 20% (+570, +380).
// Total 20,900, tax 1,900.
const invoice = {
  bookedTaxMinor: 1900n,
  remainingTaxMinor: 1900n,
  taxedGrossMinor: 20900n,
};
const note = (over: Partial<CreditNoteTaxInput>): CreditNoteTaxInput => ({
  ...invoice,
  totalMinor: 0n,
  creditedAfterMinor: over.totalMinor ?? 0n,
  lines: null,
  ...over,
});

describe("credit note tax — line rule", () => {
  it("crediting the 0% line reverses no tax", () => {
    const lines = [{ amountMinor: 4750n, rateBps: 0n, bookedTaxMinor: 0n, isTaxLine: false }];
    expect(creditNoteTaxShare(note({ totalMinor: 4750n, lines }))).toBe(0n);
  });

  it("the invoice rule on the same amount reverses the average share", () => {
    // round(4,750 × 1,900 / 20,900) = 432 — what a line-blind note books.
    expect(creditNoteTaxShare(note({ totalMinor: 4750n }))).toBe(432n);
  });

  it("each line backs its tax out of its own rate", () => {
    const lines = [
      { amountMinor: 10450n, rateBps: 1000n, bookedTaxMinor: 950n, isTaxLine: false },
      { amountMinor: 3420n, rateBps: 2000n, bookedTaxMinor: 570n, isTaxLine: false },
    ];
    expect(creditNoteTaxShare(note({ totalMinor: 13870n, lines }))).toBe(950n + 570n);
  });

  it("rounds half up once per line", () => {
    // At 20% the tax inside an amount is amount / 6.
    const at = (amountMinor: bigint) =>
      lineTaxShare({ amountMinor, rateBps: 2000n, bookedTaxMinor: 570n, isTaxLine: false });
    expect(at(3n)).toBe(1n); // 0.5 → 1
    expect(at(2n)).toBe(0n); // 0.33 → 0
    expect(at(10n)).toBe(2n); // 1.67 → 2
  });

  it("never reverses more than the line booked", () => {
    expect(
      lineTaxShare({ amountMinor: 20000n, rateBps: 1000n, bookedTaxMinor: 950n, isTaxLine: false }),
    ).toBe(950n);
  });

  it("a tax line is all tax", () => {
    expect(
      lineTaxShare({ amountMinor: 300n, rateBps: 0n, bookedTaxMinor: 950n, isTaxLine: true }),
    ).toBe(300n);
  });
});

describe("credit note tax — caps and the last note", () => {
  it("is capped at the tax still standing", () => {
    expect(creditNoteTaxShare(note({ totalMinor: 4750n, remainingTaxMinor: 100n }))).toBe(100n);
  });

  it("the note that fully credits the invoice reverses everything left", () => {
    // 1,000 incl. 153 tax in four notes of 250: 38 + 38 + 38, then 39.
    const base = { bookedTaxMinor: 153n, taxedGrossMinor: 1000n, lines: null, totalMinor: 250n };
    expect(creditNoteTaxShare({ ...base, remainingTaxMinor: 153n, creditedAfterMinor: 250n })).toBe(
      38n,
    );
    expect(creditNoteTaxShare({ ...base, remainingTaxMinor: 77n, creditedAfterMinor: 750n })).toBe(
      38n,
    );
    expect(creditNoteTaxShare({ ...base, remainingTaxMinor: 39n, creditedAfterMinor: 1000n })).toBe(
      39n,
    );
  });

  it("the last note never reverses more than its own total", () => {
    expect(
      creditNoteTaxShare({
        totalMinor: 5n,
        bookedTaxMinor: 153n,
        remainingTaxMinor: 40n,
        taxedGrossMinor: 1000n,
        creditedAfterMinor: 1000n,
        lines: null,
      }),
    ).toBe(5n);
  });

  it("an untaxed invoice reverses nothing", () => {
    expect(
      creditNoteTaxShare({
        totalMinor: 500n,
        bookedTaxMinor: 0n,
        remainingTaxMinor: 0n,
        taxedGrossMinor: 500n,
        creditedAfterMinor: 500n,
        lines: null,
      }),
    ).toBe(0n);
  });
});
