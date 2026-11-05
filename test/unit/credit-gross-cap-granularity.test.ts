import { describe, it, expect } from "vitest";
import {
  grossCreditOnInvoice,
  preTaxCreditFitting,
  type InvoiceCreditBasis,
} from "@/modules/subscriptions/proration";

/**
 * WHY A CAPPED CREDIT CAN LAND A PAISA UNDER THE CAP, and why that is neither the binary
 * search nor the cap derivation.
 *
 * Measured on a LITE-INR fixture (10759.24 billed, 8600.00 refunded, cap 215924, fitted
 * 215923). `preTaxCreditFitting` returns the largest PRE-TAX value whose gross still fits
 * the cap — correctly. But `grossCreditOnInvoice` is a composition of rounded rescales, so
 * its IMAGE is coarse: as `p` rises by one, the gross jumps by about five. When the cap falls
 * in one of those gaps, the largest achievable gross is strictly below it, and the credit is
 * short by up to the gap.
 *
 * Working on the GROSS instead would not have that problem: the remaining headroom is exact
 * — 215924 IS `total − refunded` — and the ceiling can then be enforced hard, refusing a note
 * that asks for more and naming the amount that is left.
 *
 * ⚠️ NOT A COMPONENT-ROUNDING BUG, though it decomposes as one by coincidence. 215924 − 182986
 * = 32938 = 2 × half-up(182986 × 9%), which invites "CGST and SGST are rounded separately".
 * That explanation is dead: this fixture books ONE `IGST @ 18%` row, and a single 18%
 * component rounded half-up on 182986 gives 32937 — the fitted figure. The decomposition was
 * checked against the wrong number.
 */
const FIXTURE: InvoiceCreditBasis = {
  totalMinor: 1075924n,
  bookedTaxMinor: 164124n,
  bookedDiscountMinor: 0n,
  refundedMinor: 860000n,
  promoAppliedMinor: 0n,
  open: false,
};

describe("a capped credit and the forward map's granularity", () => {
  const CAP = 1075924n - 860000n; // 215924 — the remaining headroom

  it("the cap is exactly the remaining headroom", () => {
    expect(CAP).toBe(215924n);
  });

  it("the fitted credit lands one paisa UNDER the cap", () => {
    const p = preTaxCreditFitting(CAP, FIXTURE);
    expect(grossCreditOnInvoice(p, FIXTURE)).toBe(215923n);
  });

  it("and the search is innocent: the cap is not in the map's image at all", () => {
    const image = new Set<bigint>();
    for (let p = 911_700n; p <= 911_900n; p++) image.add(grossCreditOnInvoice(p, FIXTURE));
    expect(image.has(215923n)).toBe(true);
    expect(image.has(215925n)).toBe(true);
    expect(image.has(CAP)).toBe(false); // 215924 is unreachable — nothing to find
  });

  it("the map really is coarse: consecutive pre-tax values skip gross values", () => {
    const a = grossCreditOnInvoice(911_796n, FIXTURE);
    const b = grossCreditOnInvoice(911_801n, FIXTURE);
    expect(b - a).toBeGreaterThan(1n);
  });

  it("a single blended 18% gives the fitted figure, killing the component story", () => {
    const base = 182_986n;
    const blended = base + (base * 18n * 2n + 100n) / 200n;
    expect(blended).toBe(215923n);
    expect(blended).not.toBe(CAP);
  });

  it("the fitted value is still the maximum that fits — the invariant holds", () => {
    const p = preTaxCreditFitting(CAP, FIXTURE);
    expect(grossCreditOnInvoice(p, FIXTURE) <= CAP).toBe(true);
    expect(grossCreditOnInvoice(p + 1n, FIXTURE) > CAP).toBe(true);
  });
});
