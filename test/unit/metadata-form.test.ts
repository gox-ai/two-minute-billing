import { describe, it, expect } from "vitest";
import { checkMetadata } from "../../dashboard/lib/metadata-form";

describe("checkMetadata", () => {
  it("blank clears", () => {
    expect(checkMetadata("  ")).toEqual({ ok: true, value: null });
    expect(checkMetadata(undefined)).toEqual({ ok: true, value: null });
  });

  it("accepts a JSON object", () => {
    expect(checkMetadata('{"tier":"gold","n":1}')).toEqual({
      ok: true,
      value: { tier: "gold", n: 1 },
    });
  });

  it.each([
    ["broken JSON", '{"tier":'],
    ["trailing comma", '{"a":1,}'],
    ["an array", "[1,2]"],
    ["a string", '"gold"'],
    ["a number", "42"],
    ["null", "null"],
  ])("refuses %s", (_label, raw) => {
    expect(checkMetadata(raw).ok).toBe(false);
  });

  it("enforces the API's bounds", () => {
    const keys = (n: number) =>
      JSON.stringify(Object.fromEntries([...Array(n)].map((_, i) => [`k${i}`, i])));
    expect(checkMetadata(keys(50)).ok).toBe(true);
    expect(checkMetadata(keys(51)).ok).toBe(false);
    expect(checkMetadata(JSON.stringify({ ["k".repeat(64)]: 1 })).ok).toBe(true);
    expect(checkMetadata(JSON.stringify({ ["k".repeat(65)]: 1 })).ok).toBe(false);
    expect(checkMetadata(JSON.stringify({ big: "x".repeat(16_000) })).ok).toBe(false);
  });
});
