/**
 * Fixed-amount coupons as a PER-PERIOD ALLOWANCE (0247).
 *
 * The rule: once the fixed amount is fully used in a period, later invoices in that same
 * period do not get the coupon again. So the amount is an
 * allowance a billing period spends, shared by every invoice raised in that period — not a
 * per-invoice discount, and not a balance that carries forward.
 *
 * ── The two failure modes this file exists to keep out ──────────────────────
 * 1. TODAY (flag off): every invoice takes the full amount AND spends a period, so a
 *    mid-term change burns a month of a "3 months off" coupon for a part-period benefit.
 * 2. THE REVERTED ATTEMPT (0246): prorations stopped spending a period but still took a
 *    discount, so a 500 x 3 coupon paid out on four-plus invoices — 2000 against 1500
 *    owed, unbounded in the number of mid-term changes. Its own test missed this by
 *    modelling three periods with only two renewals.
 *
 * The arithmetic below is the pure half — how `peekDiscounts` clamps an amount to the
 * remaining allowance. `settlePeriodDiscount` (the DB write that decides same-period vs
 * new-period) is exercised by the DB-backed gates; keeping them separate is what lets the
 * money maths be tested without a database.
 */
import { describe, it, expect } from "vitest";
import { computeStackedDiscounts, type StackCoupon } from "@/modules/coupons/service";

const at = new Date("2026-01-01T00:00:00Z");

/**
 * A fixed coupon as `peekDiscounts` would hand it over: `amountOffMinor` is ALREADY the
 * allowance remaining for this invoice's period, which is where the clamping happens.
 */
const fixed = (allowanceMinor: bigint): StackCoupon => ({
  appliedCouponId: "ac_1",
  couponPublicId: "SAVE500",
  kind: "fixed_amount",
  amountOffMinor: allowanceMinor,
  currency: "INR",
  createdAt: at,
});

const lines = (amountMinor: bigint) => [
  { index: 0, amountMinor, kind: "recurring", priceId: "p_1", productId: "prod_1" } as never,
];

const FACE = 50000n; // ₹500

describe("one period's allowance is shared across its invoices", () => {
  it("the renewal takes what it needs", () => {
    const s = computeStackedDiscounts([fixed(FACE)], lines(100000n), "INR");
    expect(s.totalMinor).toBe(FACE);
  });

  it("a proration in the SAME period gets only the remainder", () => {
    // The renewal already spent ₹500 of ₹500, so the allowance handed over is 0.
    const s = computeStackedDiscounts([fixed(0n)], lines(25000n), "INR");
    expect(s.totalMinor).toBe(0n);
  });

  it("a partly-spent period gives exactly what is left, never the face amount again", () => {
    // Renewal was small (₹200 invoice), so ₹300 of the allowance survives.
    const s = computeStackedDiscounts([fixed(30000n)], lines(100000n), "INR");
    expect(s.totalMinor).toBe(30000n);
  });

  it("a new period resets to the full amount", () => {
    const s = computeStackedDiscounts([fixed(FACE)], lines(100000n), "INR");
    expect(s.totalMinor).toBe(FACE);
  });

  it("is still clamped by the invoice, so a small invoice cannot over-discount", () => {
    const s = computeStackedDiscounts([fixed(FACE)], lines(25000n), "INR");
    expect(s.totalMinor).toBe(25000n);
  });
});

describe("the case the reverted attempt got wrong", () => {
  it("delivers exactly the entitlement over a term with a mid-term change, not more", () => {
    // ₹500 x 3 periods. Period 1 has a renewal AND a mid-term proration.
    //
    //   period 1 renewal   ₹1000 invoice, allowance ₹500 → ₹500, period spent
    //   period 1 proration  ₹250 invoice, allowance   ₹0 → ₹0,   NO period spent
    //   period 2 renewal   ₹1000 invoice, allowance ₹500 → ₹500, period spent
    //   period 3 renewal   ₹1000 invoice, allowance ₹500 → ₹500, period spent
    //                                                     ────────
    //                                                     ₹1500 = 3 x ₹500 exactly
    //
    // The reverted design gave ₹2000 here, and today's gives ₹1250 while burning a
    // period on the proration. Both are wrong; this is the number that is right.
    const p1Renewal = computeStackedDiscounts([fixed(FACE)], lines(100000n), "INR");
    const p1Proration = computeStackedDiscounts([fixed(0n)], lines(25000n), "INR");
    const p2Renewal = computeStackedDiscounts([fixed(FACE)], lines(100000n), "INR");
    const p3Renewal = computeStackedDiscounts([fixed(FACE)], lines(100000n), "INR");

    expect(p1Proration.totalMinor).toBe(0n);
    const total =
      p1Renewal.totalMinor + p1Proration.totalMinor + p2Renewal.totalMinor + p3Renewal.totalMinor;
    expect(total).toBe(FACE * 3n);
    expect(total).toBe(150000n);
  });

  it("no number of mid-term changes can increase what a period gives", () => {
    // The unbounded leak in the reverted design: each extra proration was another
    // discount. Here every one after the allowance is spent contributes zero.
    let total = computeStackedDiscounts([fixed(FACE)], lines(100000n), "INR").totalMinor;
    for (let change = 0; change < 10; change++) {
      total += computeStackedDiscounts([fixed(0n)], lines(25000n), "INR").totalMinor;
    }
    expect(total).toBe(FACE);
  });
});

describe("percentage discounts are outside all of this", () => {
  it("scales to the subtotal on every invoice, with no allowance to spend", () => {
    const pct: StackCoupon = {
      appliedCouponId: "ac_pct",
      couponPublicId: "TENOFF",
      kind: "percentage",
      percentOffBps: 1000,
      createdAt: at,
    };
    // Both invoices in one period get their own 10% — correct, because a percentage of a
    // charge is not a pot of money that can run out.
    expect(computeStackedDiscounts([pct], lines(100000n), "INR").totalMinor).toBe(10000n);
    expect(computeStackedDiscounts([pct], lines(25000n), "INR").totalMinor).toBe(2500n);
  });
});
