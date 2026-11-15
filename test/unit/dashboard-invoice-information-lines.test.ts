import { describe, expect, it } from "vitest";
import { isInformationLine, withoutInformationLines } from "../../dashboard/lib/invoice-lines";

describe("invoice information lines", () => {
  it("usage that credits paid is information", () => {
    expect(isInformationLine({ kind: "credit_usage" })).toBe(true);
  });
  it("a charge, a zero-amount charge and an adjustment are not", () => {
    for (const kind of ["plan", "usage", "addon", "charge", "tax", "discount", "rounding"])
      expect(isInformationLine({ kind })).toBe(false);
    expect(isInformationLine({ kind: null })).toBe(false);
    expect(isInformationLine({})).toBe(false);
  });
  it("is left out of the lines a table or a credit note lists, in order", () => {
    const lines = [
      { id: "a", kind: "plan" },
      { id: "b", kind: "credit_usage" },
      { id: "c", kind: "tax" },
    ];
    expect(withoutInformationLines(lines).map((l) => l.id)).toEqual(["a", "c"]);
    expect(withoutInformationLines(null)).toEqual([]);
  });
});
