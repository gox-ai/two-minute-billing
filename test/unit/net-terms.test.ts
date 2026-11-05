/**
 * Net terms precedence — the rule every invoice's due date comes from.
 *
 * Written when `createInvoiceFromLines` finally started honouring the chain (2026-09-01).
 * Until then only the subscription-period path resolved it, so a Net-30 customer got 30
 * days on their renewal and ZERO on the proration invoice a mid-term change raised — then
 * was dunned on it immediately, contradicting the terms they were sold.
 *
 * The subtle part, and the reason this file exists rather than a comment: `0` is not "due
 * today", it is "no terms at this level". The rule is `||`, never `??`, and a future tidy
 * to `??` would silently make a stored `0` beat the level above it.
 */
import { describe, it, expect } from "vitest";
import { netTermDaysFrom } from "@/modules/invoicing/service";

describe("netTermDaysFrom", () => {
  it("prefers the subscription over the customer and the business", () => {
    expect(
      netTermDaysFrom({
        subscription: { netTermDays: 7 },
        customer: { netTermDays: 30 },
        business: { defaultDueDays: 45 },
      }),
    ).toBe(7);
  });

  it("falls through to the customer when the subscription has none", () => {
    expect(
      netTermDaysFrom({
        subscription: { netTermDays: null },
        customer: { netTermDays: 30 },
        business: { defaultDueDays: 45 },
      }),
    ).toBe(30);
  });

  it("falls through to the business default when neither has terms", () => {
    expect(
      netTermDaysFrom({ subscription: null, customer: null, business: { defaultDueDays: 45 } }),
    ).toBe(45);
  });

  it("returns null when nothing anywhere has terms — the caller then makes it due on issue", () => {
    expect(netTermDaysFrom({})).toBeNull();
    expect(netTermDaysFrom({ subscription: null, customer: null, business: null })).toBeNull();
  });

  // ── The `0` cases: the whole reason this is `||` ────────────────────────────────
  it('treats a stored 0 as "no terms here" and falls through', () => {
    expect(
      netTermDaysFrom({
        subscription: { netTermDays: 0 },
        customer: { netTermDays: 30 },
        business: { defaultDueDays: 45 },
      }),
    ).toBe(30);
  });

  it("…at every level, including the business default", () => {
    expect(
      netTermDaysFrom({
        subscription: { netTermDays: 0 },
        customer: { netTermDays: 0 },
        business: { defaultDueDays: 0 },
      }),
    ).toBeNull();
  });

  it("is unmoved by an undefined level (a caller that read no row at all)", () => {
    expect(netTermDaysFrom({ customer: { netTermDays: 15 } })).toBe(15);
    expect(
      netTermDaysFrom({
        subscription: undefined,
        customer: undefined,
        business: { defaultDueDays: 20 },
      }),
    ).toBe(20);
  });
});
