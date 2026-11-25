import { describe, it, expect } from "vitest";
import { readdedStatus } from "@/modules/payment-methods/service";

const NOW = new Date("2026-11-25T06:06:55Z");
const card = (expMonth: number, expYear: number) => ({
  display: { type: "card", expMonth, expYear },
  mandate: undefined,
});
const row = (status: string, expMonth = 9, expYear = 2024) => ({
  status,
  expMonth,
  expYear,
  mandateExpiresAt: null,
});

describe("re-adding a card re-judges its status", () => {
  it("an expired row with a new future expiry becomes valid", () => {
    // Left `expired`, auto-collection refused the card the buyer had just added.
    expect(readdedStatus(row("expired"), card(10, 2031) as never, true, NOW)).toBe("valid");
    expect(readdedStatus(row("expired"), card(10, 2031) as never, false, NOW)).toBe("valid");
  });

  it("an expiry still in the past keeps it expired", () => {
    expect(readdedStatus(row("expired"), card(9, 2024) as never, true, NOW)).toBeNull();
  });

  it("a card expiring this month becomes expiring", () => {
    expect(readdedStatus(row("expired"), card(11, 2026) as never, true, NOW)).toBe("expiring");
  });

  it("invalid clears only on a new token", () => {
    expect(readdedStatus(row("invalid", 10, 2031), card(10, 2031) as never, true, NOW)).toBe(
      "valid",
    );
    expect(readdedStatus(row("invalid", 10, 2031), card(10, 2031) as never, false, NOW)).toBeNull();
  });

  it("a valid row is left alone", () => {
    expect(readdedStatus(row("valid", 10, 2031), card(10, 2031) as never, true, NOW)).toBeNull();
  });
});
