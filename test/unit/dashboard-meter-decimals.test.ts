import { describe, expect, it } from "vitest";
import {
  formatDecimalQuantity,
  formatMinorRate,
  lineQuantity,
  lineUnitPrice,
  majorRateToMinor,
  minorRateToMajor,
  shiftDecimal,
} from "../../dashboard/lib/meters";

describe("dashboard meter decimals", () => {
  it("shifts decimal strings exactly", () => {
    expect(shiftDecimal("3", 2)).toBe("300");
    expect(shiftDecimal("0.000003", 2)).toBe("0.0003");
    expect(shiftDecimal("300", -2)).toBe("3");
    expect(shiftDecimal("0.0003", -2)).toBe("0.000003");
    expect(shiftDecimal("1e3", 2)).toBeNull();
  });

  it("$3 per 1M tokens posts 300 minor units; a rate past 12 places is refused", () => {
    expect(majorRateToMinor("3", "USD")).toBe("300");
    expect(majorRateToMinor("15", "JPY")).toBe("15");
    expect(majorRateToMinor("0.000000000000001", "USD")).toBeNull();
    expect(minorRateToMajor("300.000000000000", "USD")).toBe("3");
  });

  it("formats decimal quantities and sub-cent rates without float loss", () => {
    expect(formatDecimalQuantity("1234567.000000000000")).toBe("1,234,567");
    expect(formatDecimalQuantity("0.123456789012")).toBe("0.123456789012");
    expect(formatMinorRate("0.0003", "USD")).toBe("$0.000003");
    expect(formatMinorRate("370", "USD")).toBe("$3.70");
  });

  it("invoice lines read the decimal fields, then fall back to the integer ones", () => {
    expect(lineQuantity({ quantity: 1, quantity_decimal: "456789.000000000000" })).toBe("456,789");
    expect(lineQuantity({ quantity: 3, quantity_decimal: null })).toBe("3");
    expect(lineUnitPrice({ unit_amount_minor: 685, unit_amount_decimal: "0.0015" }, "USD")).toBe(
      "$0.000015",
    );
    expect(lineUnitPrice({ unit_amount_minor: 1999 }, "USD")).toBe("$19.99");
  });
});
