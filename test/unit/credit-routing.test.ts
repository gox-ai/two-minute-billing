import { describe, it, expect } from "vitest";
import {
  distributeCreditAcrossInvoices,
  planOpenInvoiceCreditRouting,
  routingFromFundingSplit,
  totalRouting,
  type InvoiceCreditRouting,
} from "@/modules/subscriptions/credit-routing";

/**
 * These are the assertions that could not exist before `credit-routing.ts` did.
 *
 * The bug that motivated the extraction — `freedExcess` restoring 2400265 to the excess
 * bucket against an `excessApplied` of 2000000 — is pure arithmetic, yet demonstrating it
 * took three attempts at a full database fixture (a term invoice, an excess payment, a
 * declining card, a goodwill credit note, a downgrade) because it could only be reached
 * through `changeSubscription`. Below it is one line, and the invariant it violated is
 * stated once and checked over a grid.
 */

const R = (r: Partial<InvoiceCreditRouting> = {}): InvoiceCreditRouting => ({
  adjustmentMinor: 0n,
  freedPromoMinor: 0n,
  freedExcessMinor: 0n,
  cashableMinor: 0n,
  strandedMinor: 0n,
  ...r,
});

/** Everything the routing places, plus what it strands, is the credit. Nothing invented. */
const conserves = (credit: bigint, r: InvoiceCreditRouting) =>
  r.adjustmentMinor + r.freedPromoMinor + r.freedExcessMinor + r.cashableMinor + r.strandedMinor ===
  credit;

describe("planOpenInvoiceCreditRouting — the debt comes first", () => {
  it("a credit inside the debt is one adjustment and nothing else", () => {
    const r = planOpenInvoiceCreditRouting({
      creditMinor: 50000n,
      outstandingMinor: 100000n,
      discountedTotalMinor: 50000n,
      taxedBaseMinor: 50000n,
      promoAppliedMinor: 0n,
      excessAppliedMinor: 0n,
      refundableAppliedMinor: 0n,
      cashAvailableMinor: 0n,
    });
    // The user-reported upgrade shape: ₹1,000 unpaid, upgrade halfway, ₹500 credit.
    expect(r).toEqual(R({ adjustmentMinor: 50000n }));
  });

  it("a credit exactly equal to the debt does not overflow", () => {
    const r = planOpenInvoiceCreditRouting({
      creditMinor: 100000n,
      outstandingMinor: 100000n,
      discountedTotalMinor: 100000n,
      taxedBaseMinor: 100000n,
      promoAppliedMinor: 0n,
      excessAppliedMinor: 0n,
      refundableAppliedMinor: 0n,
      cashAvailableMinor: 0n,
    });
    expect(r).toEqual(R({ adjustmentMinor: 100000n }));
  });

  it("zero and negative credits route nothing", () => {
    for (const creditMinor of [0n, -1n]) {
      const r = planOpenInvoiceCreditRouting({
        creditMinor,
        outstandingMinor: 100000n,
        discountedTotalMinor: 0n,
        taxedBaseMinor: 0n,
        promoAppliedMinor: 0n,
        excessAppliedMinor: 0n,
        refundableAppliedMinor: 0n,
        cashAvailableMinor: 0n,
      });
      expect(r).toEqual(R());
    }
  });
});

describe("planOpenInvoiceCreditRouting — the overflow past the debt", () => {
  it("a REFUNDABLE-funded invoice with a failed cash leg routes the overflow as cashable", () => {
    // verify:proration § E1, and the shape that 500'd on 2026-08-31: an open term
    // part-settled from the customer's own refundable balance, cash leg declined.
    const r = planOpenInvoiceCreditRouting({
      creditMinor: 1600n,
      outstandingMinor: 1100n,
      discountedTotalMinor: 1600n,
      taxedBaseMinor: 1600n,
      promoAppliedMinor: 0n,
      excessAppliedMinor: 0n,
      refundableAppliedMinor: 2000n,
      cashAvailableMinor: 0n, // the card failed — nothing was ever collected
    });
    expect(r).toEqual(R({ adjustmentMinor: 1100n, cashableMinor: 500n }));
    expect(conserves(1600n, r)).toBe(true);
  });

  it("an EXCESS-funded invoice sends the overflow to the excess bucket, never to cash", () => {
    // verify:proration § E2. Excess payments must not become cashable credit.
    const r = planOpenInvoiceCreditRouting({
      creditMinor: 1600n,
      outstandingMinor: 1100n,
      discountedTotalMinor: 1600n,
      taxedBaseMinor: 1600n,
      promoAppliedMinor: 0n,
      excessAppliedMinor: 2000n,
      refundableAppliedMinor: 0n,
      cashAvailableMinor: 0n,
    });
    expect(r).toEqual(R({ adjustmentMinor: 1100n, freedExcessMinor: 500n }));
  });

  it("mixed excess + cash funding splits the overflow pro-rata between them", () => {
    const r = planOpenInvoiceCreditRouting({
      creditMinor: 1600n,
      outstandingMinor: 1100n,
      discountedTotalMinor: 1600n,
      taxedBaseMinor: 1600n,
      promoAppliedMinor: 0n,
      excessAppliedMinor: 1000n,
      refundableAppliedMinor: 0n,
      cashAvailableMinor: 1000n,
    });
    // 500 overflow, funded half-and-half → 250 each, exactly.
    expect(r).toEqual(R({ adjustmentMinor: 1100n, freedExcessMinor: 250n, cashableMinor: 250n }));
    expect(conserves(1600n, r)).toBe(true);
  });

  it("the promo slice is the overflow past the TAXED BASE, not a pro-rata share", () => {
    // probe-adjust-over-taxed-base's shape: a promo-funded term credited beyond the base
    // it was taxed on frees promotional credit rather than handing over cash never collected.
    const r = planOpenInvoiceCreditRouting({
      creditMinor: 3024266n,
      outstandingMinor: 2114324n,
      discountedTotalMinor: 2701742n,
      taxedBaseMinor: 1791800n,
      promoAppliedMinor: 1000000n,
      excessAppliedMinor: 0n,
      refundableAppliedMinor: 0n,
      cashAvailableMinor: 2114324n,
    });
    // freedPromo = discountedTotal − taxedBase = 909942, NOT a share of the overflow.
    expect(r.freedPromoMinor).toBe(909942n);
    expect(r.adjustmentMinor).toBe(2114324n);
    expect(conserves(3024266n, r)).toBe(true);
  });

  it("never frees more promo than the invoice applied", () => {
    const r = planOpenInvoiceCreditRouting({
      creditMinor: 500000n,
      outstandingMinor: 1000n,
      discountedTotalMinor: 500000n,
      taxedBaseMinor: 0n, // every unit credited is past the taxed base
      promoAppliedMinor: 7000n,
      excessAppliedMinor: 0n,
      refundableAppliedMinor: 0n,
      cashAvailableMinor: 0n,
    });
    expect(r.freedPromoMinor).toBe(7000n); // capped at what was applied, not 500000
  });
});

describe("planOpenInvoiceCreditRouting — no leg may exceed its own source", () => {
  /**
   * THE REGRESSION. The first cut divided the overflow by `excessApplied + refundableApplied
   * + cashAvailable` and clamped only the cashable leg, assuming `overflow <= funded` always
   * holds. It does not — a prior note on the invoice subtracts from capacity AND from what is
   * outstanding, widening the overflow while narrowing the funding.
   *
   * These are verify:proration § E3's exact numbers: a 2791800 term, 2000000 from an excess
   * payment, card declined, a 500000 goodwill adjustment, downgraded to a near-zero plan.
   */
  it("E3: 2400265 of overflow against 2000000 of funding strands 400265 — it does not invent it", () => {
    const r = planOpenInvoiceCreditRouting({
      creditMinor: 2692065n,
      outstandingMinor: 291800n,
      discountedTotalMinor: 2692065n,
      taxedBaseMinor: 2692065n,
      promoAppliedMinor: 0n,
      excessAppliedMinor: 2000000n,
      refundableAppliedMinor: 0n,
      cashAvailableMinor: 0n,
    });
    expect(r.adjustmentMinor).toBe(291800n);
    expect(r.freedExcessMinor).toBe(2000000n); // pre-fix this read 2400265
    expect(r.cashableMinor).toBe(0n);
    expect(r.strandedMinor).toBe(400265n);
    expect(conserves(2692065n, r)).toBe(true);
  });

  it("holds across a grid — no leg ever exceeds its source, and nothing is invented", () => {
    const amounts = [0n, 1n, 999n, 1000n, 7331n, 2000000n];
    let checked = 0;
    for (const credit of [1n, 1500n, 2692065n]) {
      for (const outstanding of amounts) {
        for (const excessApplied of amounts) {
          for (const refundableApplied of amounts) {
            for (const cashAvailable of [0n, 1n, 1000n]) {
              for (const promoApplied of [0n, 1000n]) {
                const r = planOpenInvoiceCreditRouting({
                  creditMinor: credit,
                  outstandingMinor: outstanding,
                  discountedTotalMinor: credit,
                  taxedBaseMinor: credit / 2n,
                  promoAppliedMinor: promoApplied,
                  excessAppliedMinor: excessApplied,
                  refundableAppliedMinor: refundableApplied,
                  cashAvailableMinor: cashAvailable,
                });
                // Nothing invented, nothing lost.
                expect(conserves(credit, r)).toBe(true);
                // Every leg non-negative.
                for (const v of Object.values(r)) expect(v >= 0n).toBe(true);
                // No source hands back more than it put in.
                expect(r.freedExcessMinor <= excessApplied).toBe(true);
                expect(r.freedPromoMinor <= promoApplied).toBe(true);
                expect(r.cashableMinor <= refundableApplied + cashAvailable).toBe(true);
                expect(r.adjustmentMinor <= outstanding).toBe(true);
                checked++;
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

describe("distributeCreditAcrossInvoices", () => {
  it("one invoice takes the whole credit, unrounded", () => {
    const d = distributeCreditAcrossInvoices({
      totalMinor: 1440929n,
      parts: [{ id: "a", baseMinor: 2791800n, capacityMinor: 2791800n }],
    });
    expect(d).toEqual({ shares: [{ id: "a", shareMinor: 1440929n }], unplacedMinor: 0n });
  });

  // ── These two replaced the pro-rata pair on 2026-09-02 ───────────────────────────
  // They used to assert a proportional split (1000 over three equal weights → 333/333/334)
  // and a clamp-and-re-place pass. Both encoded the OLD strategy, and both are the only
  // tests in this file that moved when the allocator became newest-first — every invariant
  // beside them (drops what cannot be absorbed, zero capacity, zero base, one invoice) was
  // untouched, which is what says the change is an ordering change and not a money change.
  //
  // Two arms: one where the newest supply absorbs the whole credit, and one where it cannot
  // and the rest spills onto older supply. The second is the one that establishes the rule —
  // in the first, "newest first" and "the newest only" are indistinguishable, and reading
  // that arm alone gave the wrong answer for an hour.

  it("fills the NEWEST invoice first and leaves older ones untouched while it has room", () => {
    const d = distributeCreditAcrossInvoices({
      totalMinor: 1000n,
      parts: [
        { id: "oldest", baseMinor: 1n, capacityMinor: 100000n },
        { id: "middle", baseMinor: 1n, capacityMinor: 100000n },
        { id: "newest", baseMinor: 1n, capacityMinor: 100000n },
      ],
    });
    // Equal weights would have been 333/333/334 under the pro-rata rule. The newest can take
    // all of it, so it does — and no fraction of a unit lands on a supply that keeps its own.
    expect(d.shares).toEqual([
      { id: "oldest", shareMinor: 0n },
      { id: "middle", shareMinor: 0n },
      { id: "newest", shareMinor: 1000n },
    ]);
    expect(d.shares.reduce((s, x) => s + x.shareMinor, 0n)).toBe(1000n);
    expect(d.unplacedMinor).toBe(0n);
  });

  it("SPILLS onto older invoices once the newest is full, and still places every unit", () => {
    // The second arm: the newest supply is worth less than the credit, so it gives what it
    // has and the remainder falls to the older one. Nothing is withheld, and no invoice is
    // asked to give back more than it took.
    const d = distributeCreditAcrossInvoices({
      totalMinor: 1000n,
      parts: [
        { id: "oldest", baseMinor: 1n, capacityMinor: 100000n },
        { id: "newest", baseMinor: 1n, capacityMinor: 100n },
      ],
    });
    expect(d.shares).toEqual([
      { id: "oldest", shareMinor: 900n },
      { id: "newest", shareMinor: 100n },
    ]);
    expect(d.shares.reduce((s, x) => s + x.shareMinor, 0n)).toBe(1000n);
    expect(d.unplacedMinor).toBe(0n);
  });

  it("drops what no invoice can absorb rather than refusing — and reports it", () => {
    const d = distributeCreditAcrossInvoices({
      totalMinor: 1000n,
      parts: [
        { id: "a", baseMinor: 1n, capacityMinor: 100n },
        { id: "b", baseMinor: 1n, capacityMinor: 200n },
      ],
    });
    expect(d.shares).toEqual([
      { id: "a", shareMinor: 100n },
      { id: "b", shareMinor: 200n },
    ]);
    // The SECOND stranding site: 700 the term cannot absorb anywhere.
    expect(d.unplacedMinor).toBe(700n);
  });

  it("skips zero-capacity invoices entirely — money already returned", () => {
    const d = distributeCreditAcrossInvoices({
      totalMinor: 500n,
      parts: [
        { id: "spent", baseMinor: 1000n, capacityMinor: 0n },
        { id: "live", baseMinor: 1000n, capacityMinor: 100000n },
      ],
    });
    expect(d.shares).toEqual([{ id: "live", shareMinor: 500n }]);
  });

  it("no capacity anywhere → nothing placed, everything reported unplaced", () => {
    const d = distributeCreditAcrossInvoices({
      totalMinor: 500n,
      parts: [{ id: "a", baseMinor: 1000n, capacityMinor: 0n }],
    });
    expect(d).toEqual({ shares: [], unplacedMinor: 500n });
  });

  it("a zero credit or no parts places nothing", () => {
    expect(distributeCreditAcrossInvoices({ totalMinor: 0n, parts: [] })).toEqual({
      shares: [],
      unplacedMinor: 0n,
    });
    expect(
      distributeCreditAcrossInvoices({
        totalMinor: 100n,
        parts: [{ id: "a", baseMinor: 0n, capacityMinor: 10n }],
      }),
    ).toEqual({ shares: [], unplacedMinor: 100n });
  });
});

describe("the two routing functions are not interchangeable", () => {
  /**
   * Raised by the session wiring `estimate.ts` (2026-08-31): a PAID invoice must go through
   * `routingFromFundingSplit`, never the open function. Pinning the exact difference so the
   * claim in the file header stays true — and so the ONE thing that must not regress is
   * checked: promotional credit never appears in `cashableMinor`.
   *
   * The shape that raised it: promo 1000000 + cash 2114324, credited in full.
   */
  const CREDIT = 3114324n;
  const openFn = planOpenInvoiceCreditRouting({
    creditMinor: CREDIT,
    outstandingMinor: 0n, // a paid invoice — this is the misuse
    discountedTotalMinor: 2791800n,
    taxedBaseMinor: 1791800n,
    promoAppliedMinor: 1000000n,
    excessAppliedMinor: 0n,
    refundableAppliedMinor: 0n,
    cashAvailableMinor: 2114324n,
  });
  const paidFn = routingFromFundingSplit(CREDIT, {
    promotional: 1000000n,
    excess: 0n,
    refundable: 2114324n,
  });

  it("agree to the unit on the cashable leg — the field consumers read", () => {
    expect(openFn.cashableMinor).toBe(paidFn.cashableMinor);
    expect(openFn.cashableMinor).toBe(2114324n);
  });

  it("promotional credit never becomes cashable, under EITHER function", () => {
    // The invariant that actually matters. `promoApplied` is absent from the cashable cap.
    expect(openFn.cashableMinor).toBeLessThanOrEqual(0n + 2114324n); // refundableApplied + cash
    expect(paidFn.cashableMinor).toBeLessThanOrEqual(0n + 2114324n);
  });

  it("but the open function MISLABELS the promo slice as stranded on a paid invoice", () => {
    expect(openFn.freedPromoMinor).toBe(0n);
    expect(openFn.strandedMinor).toBe(1000000n);
    // Which is why the caller must branch on status:
    expect(paidFn.freedPromoMinor).toBe(1000000n);
    expect(paidFn.strandedMinor).toBe(0n);
  });

  it("both still conserve — the mislabelling loses nothing", () => {
    expect(conserves(CREDIT, openFn)).toBe(true);
    expect(conserves(CREDIT, paidFn)).toBe(true);
  });
});

describe("routingFromFundingSplit + totalRouting", () => {
  it("a PAID invoice has no debt to relieve; the split maps straight through", () => {
    const r = routingFromFundingSplit(3114324n, {
      promotional: 1000000n,
      excess: 0n,
      refundable: 2114324n,
    });
    expect(r).toEqual(R({ freedPromoMinor: 1000000n, cashableMinor: 2114324n }));
    expect(conserves(3114324n, r)).toBe(true);
  });

  it("a capped split (TDS-withheld residual) reports the shortfall as stranded", () => {
    const r = routingFromFundingSplit(1000n, { promotional: 0n, excess: 0n, refundable: 600n });
    expect(r.strandedMinor).toBe(400n);
  });

  it("totals sum every leg across a term", () => {
    const t = totalRouting([
      R({ adjustmentMinor: 1100n, cashableMinor: 500n }),
      R({ adjustmentMinor: 291800n, freedExcessMinor: 2000000n, strandedMinor: 400265n }),
    ]);
    expect(t).toEqual(
      R({
        adjustmentMinor: 292900n,
        freedExcessMinor: 2000000n,
        cashableMinor: 500n,
        strandedMinor: 400265n,
      }),
    );
  });

  it("an empty term totals to nothing", () => {
    expect(totalRouting([])).toEqual(R());
  });
});
