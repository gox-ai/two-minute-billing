import { describe, it, expect } from "vitest";
import { computeDiscount, type ProrationFactor } from "@/modules/coupons/service";

// 0243 — fixed-amount coupon proration (business opt-in via
// businesses.prorate_fixed_amount_coupons). `prorationFactor` scales a
// FIXED-amount coupon's amount-off by the part of the term an invoice covers;
// percentage coupons must be completely unaffected (they already scale via
// subtotalMinor).

const half: ProrationFactor = { numerator: 1n, denominator: 2n };
const quarter: ProrationFactor = { numerator: 1n, denominator: 4n };

describe("computeDiscount — factor absent (today's behaviour)", () => {
  it("fixed coupon: full amount, unscaled", () => {
    expect(computeDiscount({ kind: "fixed_amount", amountOffMinor: 1000n }, 5000n)).toBe(1000n);
  });
  it("percentage coupon: unaffected either way", () => {
    expect(computeDiscount({ kind: "percentage", percentOffBps: 1000 }, 5000n)).toBe(500n);
  });
  it("clamps to subtotal", () => {
    expect(computeDiscount({ kind: "fixed_amount", amountOffMinor: 9000n }, 5000n)).toBe(5000n);
  });
  it("negative amountOffMinor floors at 0", () => {
    expect(computeDiscount({ kind: "fixed_amount", amountOffMinor: -100n }, 5000n)).toBe(0n);
  });
  it("currency mismatch → 0, factor irrelevant", () => {
    expect(
      computeDiscount(
        { kind: "fixed_amount", amountOffMinor: 1000n, currency: "USD" },
        5000n,
        "EUR",
        half,
      ),
    ).toBe(0n);
  });
  it("zero/negative subtotal → 0 regardless of factor", () => {
    expect(
      computeDiscount({ kind: "fixed_amount", amountOffMinor: 1000n }, 0n, undefined, half),
    ).toBe(0n);
  });
});

describe("computeDiscount — prorationFactor scales ONLY the fixed_amount branch", () => {
  it("fixed coupon at half term → half the amount", () => {
    expect(
      computeDiscount({ kind: "fixed_amount", amountOffMinor: 1000n }, 5000n, undefined, half),
    ).toBe(500n);
  });
  it("fixed coupon at quarter term → quarter the amount", () => {
    expect(
      computeDiscount({ kind: "fixed_amount", amountOffMinor: 1000n }, 5000n, undefined, quarter),
    ).toBe(250n);
  });
  it("percentage coupon is completely unaffected by a factor", () => {
    const noFactor = computeDiscount({ kind: "percentage", percentOffBps: 2000 }, 5000n);
    const withFactor = computeDiscount(
      { kind: "percentage", percentOffBps: 2000 },
      5000n,
      undefined,
      quarter,
    );
    expect(withFactor).toBe(noFactor);
    expect(withFactor).toBe(1000n);
  });
  it("rounds half-up, mirroring proration.ts#prorate", () => {
    // 999 * 1/2 = 499.5 → rounds up to 500, never truncated down to 499.
    expect(
      computeDiscount({ kind: "fixed_amount", amountOffMinor: 999n }, 5000n, undefined, half),
    ).toBe(500n);
  });
  it("the scaled result still clamps to [0, subtotal]", () => {
    // Even a huge coupon, halved, cannot exceed a tiny subtotal.
    expect(
      computeDiscount({ kind: "fixed_amount", amountOffMinor: 100_000n }, 300n, undefined, half),
    ).toBe(300n);
  });
  it("zero numerator (invoice covers none of the term) → 0", () => {
    expect(
      computeDiscount({ kind: "fixed_amount", amountOffMinor: 1000n }, 5000n, undefined, {
        numerator: 0n,
        denominator: 1n,
      }),
    ).toBe(0n);
  });
  it("numerator === denominator (full term) → unscaled, same as factor absent", () => {
    const full: ProrationFactor = { numerator: 31n, denominator: 31n };
    expect(
      computeDiscount({ kind: "fixed_amount", amountOffMinor: 1000n }, 5000n, undefined, full),
    ).toBe(1000n);
  });
  it("a zero/negative denominator is ignored (treated as no proration)", () => {
    expect(
      computeDiscount({ kind: "fixed_amount", amountOffMinor: 1000n }, 5000n, undefined, {
        numerator: 1n,
        denominator: 0n,
      }),
    ).toBe(1000n);
  });
  it("currency guard still applies with a factor present", () => {
    expect(
      computeDiscount(
        { kind: "fixed_amount", amountOffMinor: 1000n, currency: "EUR" },
        5000n,
        "EUR",
        half,
      ),
    ).toBe(500n);
  });
});
