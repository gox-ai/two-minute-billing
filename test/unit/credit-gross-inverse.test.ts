import { describe, it, expect } from "vitest";
import {
  grossCreditOnInvoice,
  preTaxCreditFitting,
  type InvoiceCreditBasis,
} from "@/modules/subscriptions/proration";

/**
 * `preTaxCreditFitting` is the inverse of `grossCreditOnInvoice`, and both are pure — so the
 * property that matters can be asserted directly, with no database and no fixture.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────
 * The first binary search guessed its upper bound as `cap * 2 + 1000`. That is only valid
 * if `gross(hi) > cap`, and the forward map SHRINKS its argument by the coupon and refund
 * ratios — so on a heavily discounted or heavily refunded invoice the search saturated at
 * `hi` and returned far less than fits. Under-crediting is not the safe side of a cap:
 * the shortfall becomes `unplacedMinor`, which is DROPPED rather than owed, so the invoice
 * collects the difference.
 *
 * It shipped green. The credit-cap invariant tests, the falsification fixture and every
 * end-to-end fixture use undiscounted, unrefunded invoices, so the bound never bound.
 * These cases exist because they are the shapes no other gate exercises.
 */
const basis = (o: Partial<InvoiceCreditBasis>): InvoiceCreditBasis => ({
  totalMinor: 0n,
  bookedTaxMinor: 0n,
  bookedDiscountMinor: 0n,
  refundedMinor: 0n,
  promoAppliedMinor: 0n,
  open: false,
  ...o,
});

/** The defining property: the largest pre-tax credit whose gross still fits. */
function assertExactInverse(cap: bigint, b: InvoiceCreditBasis) {
  const p = preTaxCreditFitting(cap, b);
  expect(grossCreditOnInvoice(p, b)).toBeLessThanOrEqual(cap);
  // …and it is the LARGEST such p — one more must not fit. This is the half the guessed
  // bound failed: it returned a p that fit, just nowhere near the biggest one.
  expect(grossCreditOnInvoice(p + 1n, b)).toBeGreaterThan(cap);
}

describe("preTaxCreditFitting is an exact inverse, not an approximation", () => {
  it("undiscounted, unrefunded — the shape every other gate already covers", () => {
    assertExactInverse(35_400n, basis({ totalMinor: 35_400n, bookedTaxMinor: 5_400n }));
  });

  it("a barely-refunded invoice — the shape that motivated the binary search", () => {
    assertExactInverse(
      3_382_560n,
      basis({ totalMinor: 3_383_060n, bookedTaxMinor: 516_060n, refundedMinor: 500n }),
    );
  });

  it("70% coupon — the guessed bound was 28% short here", () => {
    const b = basis({ totalMinor: 35_400n, bookedTaxMinor: 5_400n, bookedDiscountMinor: 70_000n });
    assertExactInverse(35_400n, b);
    // Pinned explicitly: the guessed bound returned 71_800 (gross 25_417) against a
    // 35_400 ceiling. Anything at or below that is the regression coming back.
    expect(preTaxCreditFitting(35_400n, b)).toBeGreaterThan(71_800n);
  });

  it("80% refunded — the guessed bound was 52% short here", () => {
    const b = basis({ totalMinor: 118_000n, bookedTaxMinor: 18_000n, refundedMinor: 94_400n });
    assertExactInverse(20_000n, b);
    expect(preTaxCreditFitting(20_000n, b)).toBeGreaterThan(41_000n);
  });

  it("100% coupon — reachable, percent_off_bps accepts 10000", () => {
    assertExactInverse(
      11_800n,
      basis({ totalMinor: 11_800n, bookedTaxMinor: 1_800n, bookedDiscountMinor: 100_000n }),
    );
  });

  it("an OPEN invoice with promotional credit — the creditsAmountDue tax basis", () => {
    assertExactInverse(
      50_000n,
      basis({
        totalMinor: 59_000n,
        bookedTaxMinor: 9_000n,
        promoAppliedMinor: 20_000n,
        open: true,
      }),
    );
  });

  it("degenerate caps stay at zero rather than looping", () => {
    const b = basis({ totalMinor: 11_800n, bookedTaxMinor: 1_800n });
    expect(preTaxCreditFitting(0n, b)).toBe(0n);
    expect(preTaxCreditFitting(-5n, b)).toBe(0n);
  });

  it("coupon AND refund together — the two shrink factors compose", () => {
    assertExactInverse(
      20_000n,
      basis({
        totalMinor: 118_000n,
        bookedTaxMinor: 18_000n,
        bookedDiscountMinor: 200_000n,
        refundedMinor: 59_000n,
      }),
    );
  });
});
