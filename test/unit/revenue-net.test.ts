import { describe, expect, it } from "vitest";
import {
  bucketOfLineKind,
  revenuePartsOf,
  type InvoiceDraw,
  type LineWeight,
} from "../../src/modules/payments/attribution";

/**
 * Gross to net per invoice line (`revenuePartsOf`). Hand-computed cases, minor units:
 *  A  one-time 1000, promo 300, tax 126 → gross 1000, promo 300, net 700; cash 700 / 126.
 *  B1 usage 1200 paid by a pack (face 1200, cost 1200) → prepaid 1200, net 0.
 *  B2 usage 1200 paid by a bonus pack (face 1200, cost 1080) → prepaid 1080, promo 120, net 0.
 *  D  plan 2000 + add-on 1000, document coupon −300, promo 500 → coupon 200/100,
 *     promo 500 × 1800/2700 = 333.3 and × 900/2700 = 166.7 → 333/167; net 1467/733.
 *  F  plan 1000 + usage 800, plan credits draw 500 → plan_credit 500 on usage; net 1000/300.
 *  G  inclusive line 11800 holding tax 1037, promo 5000 → gross 10763, net 5763.
 *  H  plan 3000 + unused time −1200, promo 500 → all 500 on the plan line; net 2500/−1200.
 *  P  usage 1000 + tax 180, taxed-at-use pack draw face 1180 cost 1180 → revenue share
 *     1180 × 1000/1180 = 1000 prepaid, 180 paid tax; cash weights 0 / 0.
 *  S  usage A 600 + usage B 400, a grant scoped to B's price draws 300 → all on B.
 */
type L = { kind: string; w: bigint; disc?: bigint; tax?: bigint; price?: string };
function facts(lines: L[], promo = 0n, draws: InvoiceDraw[] = []) {
  const weights: LineWeight[] = lines.map((l, i) => ({
    lineItemId: `l${i}`,
    kind: l.kind,
    bucket: bucketOfLineKind(l.kind),
    weightMinor: l.w,
  }));
  const extra = lines.map((l) => ({
    itemDiscountMinor: l.disc ?? 0n,
    exclusiveTaxMinor: l.tax ?? 0n,
    pricePublicId: l.price ?? null,
    adjustment: null,
    meterKey: null,
  }));
  return { weights, extra, promotionalCreditsMinor: promo, draws };
}
const draw = (
  category: string,
  source: string,
  face: bigint,
  cost = 0n,
  taxTreatment: string | null = null,
  applicability: InvoiceDraw["applicability"] = null,
): InvoiceDraw => ({
  category,
  source,
  faceMinor: face,
  costMinor: cost,
  taxTreatment,
  applicability,
});

const parts = (f: ReturnType<typeof facts>) => [...revenuePartsOf(f).byEntry.values()];
const identity = (f: ReturnType<typeof facts>) => {
  for (const p of parts(f)) {
    const d = p.deductions;
    expect(p.grossMinor - d.coupon - d.promotional_credit - d.plan_credit - d.prepaid_credit).toBe(
      p.netMinor,
    );
  }
};

describe("revenue net of credits", () => {
  it("A: an order partly paid with promotional credit", () => {
    const f = facts(
      [
        { kind: "one_time", w: 1000n },
        { kind: "tax", w: 126n },
      ],
      300n,
    );
    const [p] = parts(f);
    expect(p).toMatchObject({ grossMinor: 1000n, netMinor: 700n });
    expect(p!.deductions.promotional_credit).toBe(300n);
    expect(revenuePartsOf(f).cashWeights.map((w) => w.weightMinor)).toEqual([700n, 126n]);
    identity(f);
  });

  it("B1: usage paid from a paid pack is removed once, at cost", () => {
    const f = facts([{ kind: "usage", w: 1200n }], 0n, [
      draw("paid", "purchase", 1200n, 1200n, "taxed_at_purchase"),
    ]);
    const [p] = parts(f);
    expect(p!.deductions.prepaid_credit).toBe(1200n);
    expect(p!.netMinor).toBe(0n);
  });

  it("B2: the bonus of a pack is promotional credit", () => {
    const f = facts([{ kind: "usage", w: 1200n }], 0n, [
      draw("paid", "purchase", 1200n, 1080n, "taxed_at_purchase"),
    ]);
    const [p] = parts(f);
    expect(p!.deductions).toMatchObject({ prepaid_credit: 1080n, promotional_credit: 120n });
    expect(p!.netMinor).toBe(0n);
  });

  it("D: coupon, promotional credit and tax on one invoice", () => {
    const f = facts(
      [
        { kind: "recurring", w: 2000n },
        { kind: "one_time", w: 1000n },
        { kind: "discount", w: -300n },
        { kind: "tax", w: 396n },
      ],
      500n,
    );
    const [plan, addon] = parts(f);
    expect(plan!.deductions).toMatchObject({ coupon: 200n, promotional_credit: 333n });
    expect(addon!.deductions).toMatchObject({ coupon: 100n, promotional_credit: 167n });
    expect([plan!.netMinor, addon!.netMinor]).toEqual([1467n, 733n]);
    identity(f);
  });

  it("F: plan credits are their own deduction", () => {
    const f = facts(
      [
        { kind: "recurring", w: 1000n },
        { kind: "usage", w: 800n },
      ],
      0n,
      [draw("promotional", "plan_cycle", 500n)],
    );
    const [plan, use] = parts(f);
    expect(plan!.netMinor).toBe(1000n);
    expect(use!.deductions.plan_credit).toBe(500n);
    expect(use!.netMinor).toBe(300n);
  });

  it("G: an inclusive line with promotional credit nets to the taxable base", () => {
    const f = facts(
      [
        { kind: "one_time", w: 10763n },
        { kind: "tax", w: 1037n },
      ],
      5000n,
    );
    const [p] = parts(f);
    expect(p).toMatchObject({ grossMinor: 10763n, netMinor: 5763n });
  });

  it("H: a reversal line takes no credit", () => {
    const f = facts(
      [
        { kind: "recurring", w: 3000n },
        { kind: "proration", w: -1200n },
      ],
      500n,
    );
    const [plan, unused] = parts(f);
    expect(plan!.deductions.promotional_credit).toBe(500n);
    expect(unused!.deductions.promotional_credit).toBe(0n);
    expect(plan!.netMinor + unused!.netMinor).toBe(1300n);
  });

  it("P: a taxed-at-use draw counts only its revenue share", () => {
    const f = facts(
      [
        { kind: "usage", w: 1000n, tax: 180n },
        { kind: "tax", w: 180n },
      ],
      0n,
      [draw("paid", "purchase", 1180n, 1180n, "taxed_at_use")],
    );
    const r = revenuePartsOf(f);
    const [p] = [...r.byEntry.values()];
    expect(p!.deductions.prepaid_credit).toBe(1000n);
    expect(p!.netMinor).toBe(0n);
    expect(r.cashWeights.map((w) => w.weightMinor)).toEqual([0n, 0n]);
  });

  it("S: a grant scoped to prices lands only on those lines", () => {
    const f = facts(
      [
        { kind: "usage", w: 600n, price: "price_a" },
        { kind: "usage", w: 400n, price: "price_b" },
      ],
      0n,
      [draw("promotional", "manual", 300n, 0n, null, { kind: "prices", prices: ["price_b"] })],
    );
    const [a, b] = parts(f);
    expect(a!.deductions.promotional_credit).toBe(0n);
    expect(b!.deductions.promotional_credit).toBe(300n);
  });
});
