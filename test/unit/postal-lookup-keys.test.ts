import { describe, it, expect } from "vitest";
import { lookupKeys, postalKey } from "@/platform/postal-lookup";

describe("postal lookup keys", () => {
  it("normalises case, spaces and hyphens", () => {
    expect(postalKey(" sw1a 1aa ")).toBe("SW1A1AA");
    expect(postalKey("100-0001")).toBe("1000001");
  });
  it("tries the leading part where the data holds only that", () => {
    expect(lookupKeys("GB", "SW1A 1AA")).toEqual(["SW1A1AA", "SW1A"]);
    expect(lookupKeys("CA", "M5V 2T6")).toEqual(["M5V2T6", "M5V"]);
    expect(lookupKeys("NL", "1011 AB")).toEqual(["1011AB", "1011"]);
  });
  it("uses the full code elsewhere, and nothing for an empty one", () => {
    expect(lookupKeys("IN", "600 001")).toEqual(["600001"]);
    expect(lookupKeys("US", "")).toEqual([]);
  });
});
