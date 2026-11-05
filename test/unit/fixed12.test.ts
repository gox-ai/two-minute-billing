import { describe, expect, it } from "vitest";
import {
  FIXED12_SCALE,
  divHalfUp,
  fixed12FromNumeric,
  formatFixed12,
  mulDivHalfUp,
  parseFixed12,
  roundFixed12,
  tryParseFixed12,
} from "@/platform/fixed";

describe("Fixed12 parse", () => {
  it("reads plain decimals exactly", () => {
    expect(parseFixed12("0")).toBe(0n);
    expect(parseFixed12("1")).toBe(FIXED12_SCALE);
    expect(parseFixed12("0.123456789012")).toBe(123456789012n);
    expect(parseFixed12("-2.5")).toBe(-2_500_000_000_000n);
    expect(parseFixed12("300")).toBe(300n * FIXED12_SCALE);
  });

  it("refuses an exponent, 13 dp, a bare dot and other non-decimals", () => {
    for (const bad of [
      "1e3",
      "1E3",
      "0.1234567890123",
      ".",
      "5.",
      ".5",
      "+1",
      " 1",
      "abc",
      "",
      "1,5",
      "NaN",
    ]) {
      expect(tryParseFixed12(bad), bad).toBeNull();
    }
    expect(() => parseFixed12("0.1234567890123")).toThrow(/more than 12 decimal places/);
  });

  it("formats canonically and round-trips", () => {
    expect(formatFixed12(370_370_100_000_000n)).toBe("370.3701");
    expect(formatFixed12(300n * FIXED12_SCALE)).toBe("300");
    expect(formatFixed12(-1n)).toBe("-0.000000000001");
    for (const s of ["0", "1.5", "-0.000000000001", "123456789012345678901234.123456789012"]) {
      expect(formatFixed12(parseFixed12(s))).toBe(s);
    }
  });

  it("reads database numeric text of any scale, rounding half-up at 12 dp", () => {
    expect(fixed12FromNumeric("370.370100000000")).toBe(370_370_100_000_000n);
    expect(fixed12FromNumeric("0.0000000000005")).toBe(1n);
    expect(fixed12FromNumeric("0.0000000000004999")).toBe(0n);
    expect(fixed12FromNumeric(null)).toBe(0n);
  });
});

describe("Fixed12 arithmetic", () => {
  it("rounds half away from zero at .5", () => {
    expect(divHalfUp(5n, 10n)).toBe(1n);
    expect(divHalfUp(4n, 10n)).toBe(0n);
    expect(divHalfUp(-5n, 10n)).toBe(-1n);
    expect(divHalfUp(15n, 10n)).toBe(2n);
    expect(roundFixed12(parseFixed12("2.5"))).toBe(3n);
    expect(roundFixed12(parseFixed12("2.499999999999"))).toBe(2n);
  });

  it("multiplies 10^20-scale values without loss", () => {
    const a = parseFixed12("100000000000000000000.000000000001");
    const b = parseFixed12("99999999999999999999.999999999999");
    // (a × b) is ~10^64 before the divide: still exact in bigint.
    const prod = mulDivHalfUp(a, b, FIXED12_SCALE);
    expect(formatFixed12(prod)).toBe("10000000000000000000000000000000000000000");
  });

  it("$3 per 1M tokens: 1,234,567 × 300 ÷ 10^6 = 370.3701 → 370 minor, rounded once", () => {
    const q = parseFixed12("1234567");
    const rate = parseFixed12("300");
    expect(mulDivHalfUp(q, rate, 1_000_000n * FIXED12_SCALE * FIXED12_SCALE)).toBe(370n);
  });
});
