import { describe, it, expect } from "vitest";
// Relative, not `@/…`: this lives in the dashboard app and the root `@/` alias points at src/.
import {
  composePhone,
  dialForCountry,
  isValidComposedPhone,
  type PhoneCountry,
} from "../../dashboard/lib/phone";

const country = (
  code: string,
  dial: string,
  phone_pattern: string | null,
  phone_lengths: number[] | null,
): PhoneCountry => ({ code, dial_code: dial, phone_pattern, phone_lengths });

const countries = [
  country("GB", "44", "[1-9]\\d{9}", [10]),
  country("TH", "66", "[2-9]\\d{7,8}", [8, 9]),
  // Italy keeps its 0 in the international form.
  country("IT", "39", "0\\d{5,10}|3\\d{8,9}", [6, 7, 8, 9, 10, 11]),
  country("ZZ", "999", null, null),
];

describe("composePhone — a number typed the domestic way posts as valid E.164", () => {
  it.each([
    ["44", "07700 900123", "+447700900123"],
    ["44", "7700 900123", "+447700900123"],
    ["44", "44 7700 900123", "+447700900123"],
    ["44", "+44 7700 900123", "+447700900123"],
    ["44", "0044 7700 900123", "+447700900123"],
    ["66", "081 234 5678", "+66812345678"],
    ["39", "06 1234 5678", "+390612345678"],
  ])("+%s with %j → %s", (dial, typed, want) => {
    expect(composePhone(dial, typed, countries)).toBe(want);
  });

  it("keeps what was typed when the dial code has no rules", () => {
    expect(composePhone("999", "0123 456", countries)).toBe("+9990123456");
  });

  it("posts nothing without a number, or without a dial code", () => {
    expect(composePhone("44", "  ", countries)).toBe("");
    expect(composePhone("", "7700 900123", countries)).toBe("");
  });
});

describe("isValidComposedPhone", () => {
  it("rejects a number still carrying its trunk 0, accepts the corrected one", () => {
    expect(isValidComposedPhone("+4407700900123", countries)).toBe(false);
    expect(isValidComposedPhone("+447700900123", countries)).toBe(true);
  });

  it("accepts empty (optional field) and falls back to a length check without rules", () => {
    expect(isValidComposedPhone("", countries)).toBe(true);
    expect(isValidComposedPhone("+9990123456", countries)).toBe(true);
  });
});

describe("dialForCountry — a number typed before the country still posts", () => {
  it("fills an empty dial code even after a number is typed", () => {
    expect(dialForCountry("", true, "91")).toBe("91");
    expect(composePhone(dialForCountry("", true, "44"), "07700 900123", countries)).toBe(
      "+447700900123",
    );
  });

  it("keeps a dial code already set once a number is typed", () => {
    expect(dialForCountry("44", true, "91")).toBe("44");
  });

  it("follows the country while no number is typed", () => {
    expect(dialForCountry("44", false, "91")).toBe("91");
  });
});
