import { describe, it, expect } from "vitest";
import {
  compareGrants,
  drawFromGrant,
  grantPhase,
  planGrantApplication,
  type PlannerGrant,
  type PlannerLine,
} from "@/modules/credits/planner";
import {
  divHalfUp,
  E12,
  faceMinorFor,
  formatRateE12,
  formatSteps,
  MONEY_RATE,
  parseRateE12,
  stepsForMinor,
  type CreditUnitRate,
} from "@/modules/credits/units";
import { resolvePeriodInvoiceMoney } from "@/modules/invoicing/service";
import type { TaxResolution } from "@/modules/tax/service";

const D = (s: string) => new Date(`${s}T00:00:00Z`);

function grant(over: Partial<PlannerGrant> & { id: string; face: bigint }): PlannerGrant {
  const rate = over.rate ?? MONEY_RATE;
  const amount = over.amount ?? stepsForMinor(over.face, rate);
  const cost = over.costBasisMinor ?? 0n;
  return {
    category: "promotional",
    source: "manual",
    priority: 50,
    effectiveAt: D("2026-01-01"),
    expiresAt: null,
    taxTreatment: null,
    unitId: rate === MONEY_RATE ? null : "u",
    applicability: { kind: "metered" },
    amount,
    costBasisMinor: cost,
    rate,
    remainingUnits: amount,
    remainingFace: over.face,
    remainingCost: cost,
    ...over,
  };
}
const usage = (key: string, valueMinor: bigint, pricePublicId = "p-usage"): PlannerLine => ({
  key,
  kind: "usage",
  pricePublicId,
  valueMinor,
});

describe("credit units conversion (§3.1)", () => {
  const cent: CreditUnitRate = { minorPerUnitE12: E12, decimals: 0 }; // 1 credit = $0.01
  const rupee: CreditUnitRate = { minorPerUnitE12: 100n * E12, decimals: 0 }; // 1 credit = ₹1
  const tenth: CreditUnitRate = { minorPerUnitE12: E12 / 2n, decimals: 2 }; // 0.5 minor/unit, 0.01 steps
  it.each([
    [cent, 500n, 500n],
    [rupee, 1000n, 100000n],
    [tenth, 100n, 1n], // 1.00 unit = 0.5 minor → 1 (half up)
    [tenth, 300n, 2n], // 3.00 units = 1.5 → 2
    [MONEY_RATE, 12345n, 12345n],
  ])("face of %o × %s steps", (rate, steps, face) => {
    expect(faceMinorFor(steps, rate)).toBe(face);
  });
  it("money → steps rounds half up at the unit's precision", () => {
    expect(stepsForMinor(150n, rupee)).toBe(2n); // 1.5 credits
    expect(stepsForMinor(149n, rupee)).toBe(1n);
    expect(stepsForMinor(1n, tenth)).toBe(200n); // 2.00 units
  });
  it("rates and steps format and parse", () => {
    expect(parseRateE12("0.01")).toBe(E12 / 100n);
    expect(parseRateE12("100")).toBe(100n * E12);
    expect(parseRateE12("0")).toBeNull();
    expect(parseRateE12("1e3")).toBeNull();
    expect(formatRateE12(E12 / 100n)).toBe("0.01");
    expect(formatRateE12(100n * E12)).toBe("100");
    expect(formatSteps(125n, 1)).toBe("12.5");
    expect(formatSteps(100n, 2)).toBe("1");
    expect(divHalfUp(5n, 2n)).toBe(3n);
  });
});

describe("drawdown order (§3.3)", () => {
  // G1 promo p10 exp 1 Dec 400 · G2 paid p10 exp 1 Dec 1,000 · G3 paid p10 exp 1 Jan 500 ·
  // G4 promo p50 no expiry 300.
  const paid = { category: "paid" as const, taxTreatment: "taxed_at_purchase" as const };
  const G = [
    grant({ id: "g4", face: 300n }),
    grant({ id: "g3", face: 500n, priority: 10, expiresAt: D("2027-01-01"), ...paid }),
    grant({ id: "g2", face: 1000n, priority: 10, expiresAt: D("2026-12-01"), ...paid }),
    grant({ id: "g1", face: 400n, priority: 10, expiresAt: D("2026-12-01") }),
  ];
  it("G1 400, G2 1,000, G3 300; G4 untouched", () => {
    const r = planGrantApplication({ phase: "pre_tax", grants: G, lines: [usage("0", 1700n)] });
    expect(r.draws.map((d) => [d.grantId, d.faceMinor])).toEqual([
      ["g1", 400n],
      ["g2", 1000n],
      ["g3", 300n],
    ]);
    expect(r.grants.find((g) => g.id === "g3")!.remainingFace).toBe(200n);
  });
  it("a restore grant draws first, before a priority-0 grant", () => {
    const R1 = grant({ id: "r1", face: 100n, source: "restore", priority: 50 });
    const P0 = grant({ id: "p0", face: 5n, priority: 0 });
    const r = planGrantApplication({
      phase: "pre_tax",
      grants: [...G, R1, P0],
      lines: [usage("0", 1700n)],
    });
    expect(r.draws[0]!.grantId).toBe("r1");
    expect(r.grants.find((g) => g.id === "g3")!.remainingFace).toBe(305n);
    expect([...G, R1, P0].sort(compareGrants)[0]!.id).toBe("r1");
  });
  it("promotional before paid at equal priority and expiry", () => {
    const a = grant({ id: "a", face: 10n, ...paid });
    const b = grant({ id: "b", face: 10n });
    expect([a, b].sort(compareGrants).map((g) => g.id)).toEqual(["b", "a"]);
  });
  it("only usage lines, only applicable prices, only live windows", () => {
    const g = grant({ id: "g", face: 1000n, applicability: { kind: "prices", prices: ["p-a"] } });
    const late = grant({ id: "late", face: 1000n, effectiveAt: D("2026-03-01") });
    const r = planGrantApplication({
      phase: "pre_tax",
      grants: [g, late],
      lines: [
        { key: "0", kind: "recurring", pricePublicId: "p-a", valueMinor: 500n },
        { ...usage("1", 300n, "p-b"), window: { start: D("2026-01-01"), end: D("2026-02-01") } },
        { ...usage("2", 200n, "p-a"), window: { start: D("2026-01-01"), end: D("2026-02-01") } },
        {
          key: "3",
          kind: "usage",
          pricePublicId: "p-a",
          valueMinor: 50n,
          adjustment: "minimum_spend",
        },
      ],
    });
    expect(r.draws).toHaveLength(1);
    expect(r.draws[0]!.grantId).toBe("g");
    expect(r.byLine.get("2")).toBe(200n);
    expect(r.byLine.get("1")).toBeUndefined();
  });
  it("phases: promotional and taxed-at-purchase pre-tax, taxed-at-use post-tax", () => {
    expect(grantPhase({ category: "promotional", taxTreatment: null })).toBe("pre_tax");
    expect(grantPhase({ category: "paid", taxTreatment: "taxed_at_purchase" })).toBe("pre_tax");
    expect(grantPhase({ category: "paid", taxTreatment: "taxed_at_use" })).toBe("post_tax");
  });
});

describe("units and cost per draw (§3.4.5–6)", () => {
  it("3-way split of 1,000 units over 333/333/334 sums to the cost basis", () => {
    let g = grant({
      id: "g",
      face: 1000n,
      costBasisMinor: 800n,
      category: "paid",
      taxTreatment: "taxed_at_purchase",
    });
    const costs: bigint[] = [];
    for (const face of [333n, 333n, 334n]) {
      const d = drawFromGrant(g, face);
      costs.push(d.costMinor);
      g = {
        ...g,
        remainingFace: g.remainingFace - d.faceMinor,
        remainingUnits: g.remainingUnits - d.units,
        remainingCost: g.remainingCost - d.costMinor,
      };
    }
    expect(costs).toEqual([266n, 267n, 267n]);
    expect([g.remainingFace, g.remainingUnits, g.remainingCost]).toEqual([0n, 0n, 0n]);
  });
  it("Ex 1: 300 of 1,000 ₹1 credits at ₹800 → face 30,000, cost 24,000", () => {
    const rupee: CreditUnitRate = { minorPerUnitE12: 100n * E12, decimals: 0 };
    const g = grant({
      id: "g",
      face: 100000n,
      amount: 1000n,
      rate: rupee,
      costBasisMinor: 80000n,
      category: "paid",
      taxTreatment: "taxed_at_purchase",
    });
    expect(drawFromGrant(g, 30000n)).toEqual({ faceMinor: 30000n, units: 300n, costMinor: 24000n });
  });
  it("unit rounding never leaves a unit without money or money without a unit (property)", () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let t = 0; t < 400; t++) {
      const rate: CreditUnitRate = {
        minorPerUnitE12: BigInt(1 + rnd(500)) * (E12 / 10n),
        decimals: rnd(3),
      };
      const amount = BigInt(1 + rnd(5000));
      const face = faceMinorFor(amount, rate);
      if (face <= 0n) continue;
      const cost = BigInt(rnd(Number(face) + 1));
      let g = grant({
        id: "g",
        face,
        amount,
        rate,
        costBasisMinor: cost,
        category: "paid",
        taxTreatment: "taxed_at_purchase",
      });
      let costSum = 0n;
      for (let i = 0; i < 50 && g.remainingFace > 0n; i++) {
        const want = BigInt(1 + rnd(Number(face)));
        const d = drawFromGrant(g, want);
        expect(d.faceMinor).toBeLessThanOrEqual(want);
        costSum += d.costMinor;
        g = {
          ...g,
          remainingFace: g.remainingFace - d.faceMinor,
          remainingUnits: g.remainingUnits - d.units,
          remainingCost: g.remainingCost - d.costMinor,
        };
        expect(g.remainingUnits).toBeGreaterThanOrEqual(0n);
        expect(g.remainingCost).toBeGreaterThanOrEqual(0n);
        if (g.remainingFace > 0n) expect(g.remainingUnits).toBeGreaterThan(0n);
      }
      if (g.remainingFace === 0n) {
        expect(g.remainingUnits).toBe(0n);
        expect(costSum).toBe(cost);
      }
    }
  });
  it("planner property: phase Σ ≤ line value, each grant within its face, cap honoured", () => {
    let seed = 11;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let t = 0; t < 300; t++) {
      const grants = Array.from({ length: 1 + rnd(5) }, (_, i) =>
        grant({ id: `g${i}`, face: BigInt(1 + rnd(2000)), priority: rnd(3) * 10 }),
      );
      const lines = Array.from({ length: 1 + rnd(4) }, (_, i) =>
        usage(String(i), BigInt(rnd(1500))),
      );
      const cap = BigInt(rnd(3000));
      const r = planGrantApplication({ phase: "pre_tax", grants, lines, capMinor: cap });
      const value = lines.reduce((s, l) => s + l.valueMinor, 0n);
      expect(r.totalMinor).toBeLessThanOrEqual(value);
      expect(r.totalMinor).toBeLessThanOrEqual(cap);
      for (const l of lines) expect(r.byLine.get(l.key) ?? 0n).toBeLessThanOrEqual(l.valueMinor);
      for (const g of r.grants) expect(g.remainingFace).toBeGreaterThanOrEqual(0n);
      expect(planGrantApplication({ phase: "post_tax", grants, lines }).draws).toHaveLength(0);
    }
  });
});

// ── C8 through the invoice money resolver ────────────────────────────────────
const VAT20: TaxResolution = {
  key: "vat20",
  components: [{ name: "VAT", rateBps: 2000, taxComponentId: "txc_vat" }],
  totalRateBps: 2000,
  taxabilityReason: "standard_rated",
  sellerStateCode: null,
  placeOfSupplyCode: null,
  treatment: "default",
  taxNote: null,
  priceType: "exclusive",
  regime: "vat",
  regionId: "reg",
  intraState: null,
  registrationNumber: null,
  registrationLabel: null,
  rounding: "per_invoice_total",
  customerBehavior: null,
};
type Line = { amountMinor: bigint; kind: "usage" | "recurring"; pricePublicId?: string };
function money(lines: Line[], grants: PlannerGrant[], promotional = 0n, refundable = 0n) {
  const subtotal = lines.reduce((s, l) => s + l.amountMinor, 0n);
  const plan = {
    lines: lines.map((l) => ({
      description: "x",
      priceId: null,
      quantity: 1,
      unitAmountMinor: l.amountMinor,
      amountMinor: l.amountMinor,
      kind: l.kind,
      periodStart: D("2026-01-01"),
      periodEnd: D("2026-02-01"),
      taxable: true,
      inclusive: false,
      pricePublicId: l.pricePublicId ?? "p-usage",
    })),
    subtotal,
    discStack: { lineDiscountByIndex: [], invoiceLevelByIndex: [], invoiceLevelMinor: 0n },
    discountedSubtotal: subtotal,
    taxResolution: VAT20,
    exempt: false,
    invoiceRounding: null,
    subscription: { currency: "EUR" },
    withholdingRateBps: 0,
    creditLimits: { refundable: null, excess: null },
    invoiceDate: D("2026-02-01"),
    dueDate: D("2026-02-01"),
  };
  return resolvePeriodInvoiceMoney(plan as never, { promotional, refundable, excess: 0n }, grants);
}
const promo20 = grant({ id: "promo", face: 2000n });
const paidAtUse = grant({
  id: "paid",
  face: 10000n,
  costBasisMinor: 10000n,
  category: "paid",
  taxTreatment: "taxed_at_use",
});
const paidAtPurchase = grant({
  id: "pap",
  face: 10000n,
  costBasisMinor: 8000n,
  category: "paid",
  taxTreatment: "taxed_at_purchase",
});

describe("C8: grants and tax (§3.4, §4 Ex 1–2)", () => {
  it("Ex 2: promo pays pre-tax, the paid grant pays the taxed rest — $6 of tax, not $10", () => {
    const m = money([{ amountMinor: 5000n, kind: "usage" }], [promo20, paidAtUse]);
    expect(m.invoiceTax.totalTaxMinor).toBe(600n);
    expect(m.total).toBe(5600n);
    expect(m.grantPreTaxApplied).toBe(2000n);
    expect(m.grantPostTaxApplied).toBe(3600n);
    expect(m.amountDue).toBe(0n);
    const post = m.grantDraws.find((d) => d.grantId === "paid")!;
    expect([post.faceMinor, post.costMinor, post.phase]).toEqual([3600n, 3600n, "post_tax"]);
  });
  it("a promotional grant lowers the tax base (1,000 of tax with no grant)", () => {
    expect(money([{ amountMinor: 5000n, kind: "usage" }], []).invoiceTax.totalTaxMinor).toBe(1000n);
    expect(money([{ amountMinor: 5000n, kind: "usage" }], [promo20]).invoiceTax.totalTaxMinor).toBe(
      600n,
    );
  });
  it("a taxed-at-use grant pays tax as money, after the promo phase (tax is not 0)", () => {
    const m = money([{ amountMinor: 5000n, kind: "usage" }], [paidAtUse]);
    expect(m.invoiceTax.totalTaxMinor).toBe(1000n);
    expect(m.grantPreTaxApplied).toBe(0n);
    expect(m.grantPostTaxApplied).toBe(6000n);
    expect(m.amountDue).toBe(0n);
  });
  it("Ex 1: a taxed-at-purchase grant covers usage before tax — tax 0 at use", () => {
    const m = money([{ amountMinor: 3000n, kind: "usage" }], [paidAtPurchase]);
    expect(m.invoiceTax.totalTaxMinor).toBe(0n);
    expect(m.grantPreTaxApplied).toBe(3000n);
    expect(m.grantDraws[0]!.costMinor).toBe(2400n);
    expect(m.amountDue).toBe(0n);
  });
  it("an inapplicable line keeps its own tax and goes to the buckets", () => {
    const m = money(
      [
        { amountMinor: 5000n, kind: "usage" },
        { amountMinor: 1000n, kind: "recurring" },
      ],
      [grant({ id: "big", face: 100000n })],
      0n,
      500n,
    );
    expect(m.grantPreTaxApplied).toBe(5000n);
    expect(m.invoiceTax.totalTaxMinor).toBe(200n); // 20% of the 1,000 line only
    expect(m.refundableApplied).toBe(500n);
    expect(m.amountDue).toBe(700n);
  });
  it("the promotional bucket comes after pre-tax grants and never drives a base negative", () => {
    const m = money(
      [
        { amountMinor: 5000n, kind: "usage" },
        { amountMinor: 1000n, kind: "recurring" },
      ],
      [grant({ id: "big", face: 100000n })],
      1000n,
    );
    expect(m.promoApplied).toBe(1000n);
    expect(m.invoiceTax.totalTaxMinor).toBe(0n);
    expect(m.amountDue).toBe(0n);
  });
  it("no grants: the money is what it was", () => {
    const m = money([{ amountMinor: 5000n, kind: "usage" }], [], 2000n);
    expect([m.promoApplied, m.invoiceTax.totalTaxMinor, m.amountDue]).toEqual([2000n, 600n, 3600n]);
    expect(m.grantDraws).toHaveLength(0);
  });
});
