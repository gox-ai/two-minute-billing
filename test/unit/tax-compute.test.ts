import { describe, it, expect } from "vitest";
import { __taxCodeForLine } from "@/modules/invoicing/service";
import {
  allocateTaxAcrossLines,
  computeInvoiceTax,
  splitByWeight,
  taxMinorFor,
  type TaxableLine,
  type TaxResolution,
} from "@/modules/tax/service";

/** A resolution with the given components — the pure math needs no database. */
const R = (
  components: Array<{ name: string; rateBps: number; id?: string }>,
  over: Partial<TaxResolution> = {},
): TaxResolution => ({
  key: over.key ?? "res:" + components.map((c) => `${c.name}@${c.rateBps}`).join("+"),
  components: components.map((c) => ({
    name: c.name,
    rateBps: c.rateBps,
    taxComponentId: c.id ?? `txc_${c.name}`,
  })),
  totalRateBps: components.reduce((s, c) => s + c.rateBps, 0),
  taxabilityReason: "standard_rated",
  sellerStateCode: "TN",
  placeOfSupplyCode: "TN",
  treatment: "default",
  taxNote: null,
  priceType: "exclusive",
  regime: "gst",
  regionId: "reg_1",
  intraState: true,
  registrationNumber: "33AAFCN5032R1Z6",
  registrationLabel: "gstin",
  rounding: "per_invoice_total",
  customerBehavior: null,
  ...over,
});

const VAT20 = R([{ name: "VAT", rateBps: 2000 }], { regime: "vat", intraState: null });
/** India intra-state: CGST 9% + SGST 9%. */
const GST_INTRA = R([
  { name: "CGST", rateBps: 900 },
  { name: "SGST/UTGST", rateBps: 900 },
]);
/** India inter-state: a single IGST 18%. */
const GST_INTER = R([{ name: "IGST", rateBps: 1800 }], {
  placeOfSupplyCode: "KA",
  intraState: false,
});
const ZERO_RATED = R([], {
  taxabilityReason: "zero_rated",
  treatment: "export_zero_rated",
  taxNote: "Export of service",
});
const REVERSE = R([], {
  taxabilityReason: "reverse_charge",
  treatment: "reverse_charge",
  taxNote: "RCM applies",
});

const L = (
  id: string,
  amountMinor: bigint,
  resolution: TaxResolution = VAT20,
  taxable = true,
  inclusive = false,
): TaxableLine => ({ id, amountMinor, taxable, inclusive, resolution });

const run = (lines: TaxableLine[], opts?: { discountMinor?: bigint; customerExempt?: boolean }) =>
  computeInvoiceTax({
    lines,
    discountMinor: opts?.discountMinor ?? 0n,
    subtotalMinor: lines.reduce((s, l) => s + l.amountMinor, 0n),
    customerExempt: opts?.customerExempt ?? false,
  });

const sumRows = (r: { amountMinor: bigint }[]) => r.reduce((s, x) => s + x.amountMinor, 0n);
const named = (t: { rows: Array<{ name: string; amountMinor: bigint }> }, name: string) =>
  t.rows.filter((r) => r.name === name).reduce((s, r) => s + r.amountMinor, 0n);

describe("computeInvoiceTax — single component (behaviour preserved from the scalar engine)", () => {
  it("all-exclusive: tax added on top, rows reconcile", () => {
    const t = run([L("0", 10000n)]); // $100 @ 20%
    expect(t.additiveTaxMinor).toBe(2000n);
    expect(t.inclusiveTaxMinor).toBe(0n);
    expect(t.totalTaxMinor).toBe(2000n);
    expect(sumRows(t.rows)).toBe(2000n);
    expect(t.rows[0]!.taxabilityReason).toBe("standard_rated");
    expect(t.rows[0]!.taxComponentId).toBe("txc_VAT");
  });

  it("inclusive: tax is BACKED OUT of the gross (not added)", () => {
    // $120 gross @ 20% inclusive → net $100, tax $20.
    const t = run([L("0", 12000n, VAT20, true, true)]);
    expect(t.additiveTaxMinor).toBe(0n); // nothing added to the total
    expect(t.inclusiveTaxMinor).toBe(2000n); // 12000 * 2000 / 12000
    expect(t.totalTaxMinor).toBe(2000n);
    expect(sumRows(t.rows)).toBe(2000n);
  });

  it("mixed exclusive + inclusive lines", () => {
    const t = run([L("0", 10000n), L("1", 12000n, VAT20, true, true)]);
    expect(t.additiveTaxMinor).toBe(2000n);
    expect(t.inclusiveTaxMinor).toBe(2000n);
    expect(t.totalTaxMinor).toBe(4000n);
    expect(t.rows.length).toBe(2); // one component × two lines
    expect(sumRows(t.rows)).toBe(4000n);
  });

  it("non-taxable line → product_exempt zero row, excluded from base", () => {
    const t = run([L("0", 10000n), L("1", 5000n, VAT20, /*taxable*/ false)]);
    expect(t.additiveTaxMinor).toBe(2000n); // only the $100 taxed
    const exempt = t.rows.find((r) => r.taxabilityReason === "product_exempt");
    expect(exempt?.amountMinor).toBe(0n);
    expect(exempt?.lineId).toBe("1");
  });

  it("customer exempt → all lines customer_exempt, zero tax", () => {
    const t = run([L("0", 10000n), L("1", 5000n)], { customerExempt: true });
    expect(t.totalTaxMinor).toBe(0n);
    expect(
      t.rows.every((r) => r.taxabilityReason === "customer_exempt" && r.amountMinor === 0n),
    ).toBe(true);
    expect(t.rows.length).toBe(2);
  });

  it("discount reduces the taxable base", () => {
    const t = run([L("0", 10000n)], { discountMinor: 5000n });
    expect(t.additiveTaxMinor).toBe(1000n); // 20% of $50
  });

  it("no components → no tax, and a row saying WHY", () => {
    const t = run([L("0", 10000n, R([], { taxabilityReason: "no_rate" }))]);
    expect(t.totalTaxMinor).toBe(0n);
    expect(t.rows.length).toBe(1);
    expect(t.rows[0]!.taxabilityReason).toBe("no_rate");
    expect(t.rows[0]!.amountMinor).toBe(0n);
  });

  it("ledger identity: total − inclusive === additive", () => {
    const t = run([L("0", 10000n), L("1", 12000n, VAT20, true, true), L("2", 3000n, VAT20, false)]);
    expect(t.totalTaxMinor - t.inclusiveTaxMinor).toBe(t.additiveTaxMinor);
  });
});

describe("computeInvoiceTax — India GST components", () => {
  it("intra-state: CGST + SGST as SEPARATE rows summing to 18%", () => {
    const t = run([L("0", 100000n, GST_INTRA)]); // ₹1000.00
    expect(t.additiveTaxMinor).toBe(18000n);
    expect(named(t, "CGST")).toBe(9000n);
    expect(named(t, "SGST/UTGST")).toBe(9000n);
    expect(t.rows.length).toBe(2); // the legally required breakdown
  });

  it("inter-state: ONE IGST row, same total as the intra-state split", () => {
    const intra = run([L("0", 100000n, GST_INTRA)]);
    const inter = run([L("0", 100000n, GST_INTER)]);
    expect(inter.additiveTaxMinor).toBe(intra.additiveTaxMinor);
    expect(inter.rows.length).toBe(1);
    expect(named(inter, "IGST")).toBe(18000n);
  });

  it("Cess stacks on top of the GST split", () => {
    const withCess = R([
      { name: "CGST", rateBps: 900 },
      { name: "SGST/UTGST", rateBps: 900 },
      { name: "Cess", rateBps: 100 },
    ]);
    const t = run([L("0", 100000n, withCess)]);
    expect(t.additiveTaxMinor).toBe(19000n); // 9% + 9% + 1%
    expect(named(t, "Cess")).toBe(1000n);
  });

  it("inclusive GST: components are backed out of ONE combined rate, not each separately", () => {
    // ₹1180 gross at 9+9 → tax 1180*1800/11800 = 180.00, split 90/90.
    const t = run([L("0", 118000n, GST_INTRA, true, true)]);
    expect(t.inclusiveTaxMinor).toBe(18000n);
    expect(named(t, "CGST")).toBe(9000n);
    expect(named(t, "SGST/UTGST")).toBe(9000n);
    // Backing each component out independently would have given
    // 2 * (118000*900/10900) = 19486 — nearly ₹15 too much.
    expect(t.inclusiveTaxMinor).not.toBe(19486n);
  });

  it("zero-rated export: no tax, reason recorded, note carried on the resolution", () => {
    const t = run([L("0", 100000n, ZERO_RATED)]);
    expect(t.totalTaxMinor).toBe(0n);
    expect(t.rows[0]!.taxabilityReason).toBe("zero_rated");
    expect(ZERO_RATED.taxNote).toBe("Export of service");
  });

  it("reverse charge: no tax, distinct reason from a zero-rated export", () => {
    const t = run([L("0", 100000n, REVERSE)]);
    expect(t.totalTaxMinor).toBe(0n);
    expect(t.rows[0]!.taxabilityReason).toBe("reverse_charge");
    expect(t.rows[0]!.name).toBe("Reverse charge");
  });

  it("mixed tax profiles on one invoice: each line taxed at its own vector", () => {
    const reduced = R(
      [
        { name: "CGST", rateBps: 250, id: "txc_c5" },
        { name: "SGST/UTGST", rateBps: 250, id: "txc_s5" },
      ],
      { key: "reduced-5pct" },
    );
    const t = run([L("0", 100000n, GST_INTRA), L("1", 100000n, reduced)]);
    // 18% on the first line + 5% on the second, pooled and rounded separately.
    expect(t.additiveTaxMinor).toBe(18000n + 5000n);
    const line1 = t.rows.filter((r) => r.lineId === "1");
    expect(sumRows(line1)).toBe(5000n);
    expect(line1.every((r) => r.rateBps === 250)).toBe(true);
  });
});

describe("computeInvoiceTax — rounding exactness", () => {
  it("per-component rows sum EXACTLY to the pooled tax across awkward line splits", () => {
    // Three lines that do not divide evenly, at 9% + 9%.
    const lines = [L("0", 3333n, GST_INTRA), L("1", 3333n, GST_INTRA), L("2", 3334n, GST_INTRA)];
    const t = run(lines);
    const base = 10000n;
    expect(t.additiveTaxMinor).toBe((base * 900n) / 10000n + (base * 900n) / 10000n);
    // Each component's rows reconcile to that component's pooled total.
    expect(named(t, "CGST")).toBe((base * 900n) / 10000n);
    expect(named(t, "SGST/UTGST")).toBe((base * 900n) / 10000n);
    expect(sumRows(t.rows)).toBe(t.totalTaxMinor);
  });

  it("never drifts: rows always reconcile to totalTaxMinor over a sweep of bases", () => {
    for (let amount = 1n; amount <= 400n; amount++) {
      const t = run([L("0", amount, GST_INTRA), L("1", amount + 1n, GST_INTRA)]);
      expect(sumRows(t.rows)).toBe(t.totalTaxMinor);
    }
  });

  it("inclusive rows reconcile to the backed-out total over a sweep", () => {
    for (let amount = 1n; amount <= 400n; amount++) {
      const t = run([
        L("0", amount, GST_INTRA, true, true),
        L("1", amount * 3n, GST_INTRA, true, true),
      ]);
      expect(sumRows(t.rows)).toBe(t.totalTaxMinor);
      expect(t.additiveTaxMinor).toBe(0n);
    }
  });
});

describe("splitByWeight", () => {
  it("splits exactly, favouring the largest remainder", () => {
    expect(splitByWeight(10n, [1n, 1n])).toEqual([5n, 5n]);
    expect(splitByWeight(11n, [1n, 1n])).toEqual([6n, 5n]);
    // 900/900/100 of 1900: exact shares 47.37 / 47.37 / 5.26 → floors 47+47+5 = 99,
    // and the single remaining unit goes to the largest fraction (index 0).
    expect(splitByWeight(100n, [900n, 900n, 100n])).toEqual([48n, 47n, 5n]);
  });
  it("sums to the input for every total up to 500 across uneven weights", () => {
    for (let total = 0n; total <= 500n; total++) {
      const parts = splitByWeight(total, [900n, 900n, 100n, 250n]);
      expect(parts.reduce((s, p) => s + p, 0n)).toBe(total);
    }
  });
  it("zero weights or zero total yield zeros", () => {
    expect(splitByWeight(0n, [1n, 2n])).toEqual([0n, 0n]);
    expect(splitByWeight(10n, [0n, 0n])).toEqual([0n, 0n]);
  });
});

describe("allocateTaxAcrossLines", () => {
  it("is deterministic on ties (index order, not sort instability)", () => {
    const lines = [
      { id: "a", amountMinor: 100n },
      { id: "b", amountMinor: 100n },
      { id: "c", amountMinor: 100n },
    ];
    const first = allocateTaxAcrossLines(lines, 10n);
    for (let i = 0; i < 20; i++) expect(allocateTaxAcrossLines(lines, 10n)).toEqual(first);
    expect(first.reduce((s, p) => s + p.amountMinor, 0n)).toBe(10n);
  });
  it("ignores non-positive lines", () => {
    expect(allocateTaxAcrossLines([{ id: "a", amountMinor: 0n }], 5n)).toEqual([]);
  });
});

describe("taxMinorFor", () => {
  it("sums the components for a flat base", () => {
    expect(taxMinorFor(GST_INTRA, 100000n)).toBe(18000n);
    expect(taxMinorFor(GST_INTER, 100000n)).toBe(18000n);
    expect(taxMinorFor(ZERO_RATED, 100000n)).toBe(0n);
  });
  it("is zero for a non-positive base", () => {
    expect(taxMinorFor(GST_INTRA, 0n)).toBe(0n);
    expect(taxMinorFor(GST_INTRA, -100n)).toBe(0n);
  });
});

/**
 * HSN/SAC precedence — which classification code a line asserts on an India GST invoice.
 *
 * Pinned as a unit test because the rule decides what a LEGAL document says was sold, and
 * all three of its branches are silent when wrong: a blank code on an Indian invoice is a
 * defective tax invoice, and a code on a discount line asserts a supply that never
 * happened. Neither throws, and neither is visible until an auditor asks.
 */
describe("__taxCodeForLine — HSN/SAC precedence", () => {
  it("prefers the price's own code over everything below it", () => {
    // HSN belongs at the price: one product sold as a hosted subscription and as
    // a downloadable licence has two codes and one product row.
    expect(__taxCodeForLine("recurring", "998313", "998311", "998314")).toBe("998313");
  });

  it("prefers the product's own code over the business default", () => {
    expect(__taxCodeForLine("recurring", null, "998311", "998314")).toBe("998311");
    expect(__taxCodeForLine("recurring", undefined, "998311", "998314")).toBe("998311");
  });

  it("falls all the way through to the business default when neither level sets one", () => {
    // The common shape: a single-service business sets one code and never revisits it.
    // Both nulls must fall THROUGH — a guard that stops at the first level would ship
    // this line blank, which is a defective tax invoice.
    expect(__taxCodeForLine("recurring", null, null, "998314")).toBe("998314");
    expect(__taxCodeForLine("recurring", undefined, undefined, "998314")).toBe("998314");
    expect(__taxCodeForLine("recurring", null, undefined, "998314")).toBe("998314");
    expect(__taxCodeForLine("recurring", undefined, null, "998314")).toBe("998314");
  });

  it("classifies a line with no price behind it, rather than shipping it blank", () => {
    // A manual charge carries no price and no product, so `undefined` reaches both levels
    // — it must still pick up the business default. This is the case `||` vs `??` would
    // not change but a `priceTaxCode ? … : …` guard silently would.
    expect(__taxCodeForLine("one_time", undefined, undefined, "998314")).toBe("998314");
  });

  it("leaves every non-supply line null, even when a default exists", () => {
    // Discount, tax and rounding lines are arithmetic on the invoice, not services sold.
    // Stamping the default here would assert that ₹-500 of 998314 changed hands.
    for (const kind of ["discount", "tax", "rounding"]) {
      expect(__taxCodeForLine(kind, "998313", "998311", "998314")).toBeNull();
    }
  });

  it("is null when no level in the chain sets one", () => {
    // Every non-India invoice. The renderers key the whole column off this being null,
    // so a business outside the GST regime keeps the layout it had.
    expect(__taxCodeForLine("recurring", null, null, null)).toBeNull();
    expect(__taxCodeForLine("recurring", undefined, undefined, null)).toBeNull();
  });
});
