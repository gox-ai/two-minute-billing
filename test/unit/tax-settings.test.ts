import { describe, it, expect } from "vitest";
import {
  computeInvoiceTax,
  lineIsInclusive,
  perLineBases,
  taxLinesForBase,
  taxMinorFor,
  type TaxableLine,
  type TaxResolution,
} from "@/modules/tax/service";
import {
  mergeTaxSettings,
  newPriceTaxBehavior,
  resolveTaxSettings,
  sellerTaxIdFor,
} from "@/modules/tax/settings";

const R = (
  components: Array<{ name: string; rateBps: number }>,
  over: Partial<TaxResolution> = {},
): TaxResolution => ({
  key: "res",
  components: components.map((c) => ({ ...c, taxComponentId: `txc_${c.name}` })),
  totalRateBps: components.reduce((s, c) => s + c.rateBps, 0),
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
  ...over,
});

const line = (id: string, amountMinor: bigint, resolution: TaxResolution, inclusive = false) =>
  ({ id, amountMinor, taxable: true, inclusive, resolution }) satisfies TaxableLine;

const tax = (lines: TaxableLine[], discountMinor = 0n) =>
  computeInvoiceTax({
    lines,
    discountMinor,
    subtotalMinor: lines.reduce((s, l) => s + l.amountMinor, 0n),
    customerExempt: false,
  });

describe("tax rounding (2.71)", () => {
  const amounts = [1003n, 1003n, 1003n];

  it("today rounds each component once on the invoice total", () => {
    const res = R([{ name: "VAT", rateBps: 1800 }]);
    // 3009 × 18% = 541.62 → 542.
    expect(tax(amounts.map((a, i) => line(String(i), a, res))).additiveTaxMinor).toBe(542n);
  });

  it("per line rounds each line and sums: 3 × round(180.54) = 543", () => {
    const res = R([{ name: "VAT", rateBps: 1800 }], { rounding: "per_line" });
    const t = tax(amounts.map((a, i) => line(String(i), a, res)));
    expect(t.additiveTaxMinor).toBe(543n);
    expect(t.rows.map((r) => r.amountMinor)).toEqual([181n, 181n, 181n]);
  });

  it("the estimate rounds as the invoice does, with a discount spread over the lines", () => {
    for (const rounding of ["per_invoice_total", "per_line"] as const) {
      const res = R(
        [
          { name: "CGST", rateBps: 900 },
          { name: "SGST", rateBps: 900 },
        ],
        { rounding },
      );
      for (const discount of [0n, 100n, 7n]) {
        const t = tax(
          amounts.map((a, i) => line(String(i), a, res)),
          discount,
        );
        const base = 3009n - discount;
        expect(taxMinorFor(res, base, amounts)).toBe(t.additiveTaxMinor);
        const rows = taxLinesForBase(res, base, amounts);
        expect(rows.reduce((s, r) => s + r.amountMinor, 0n)).toBe(t.additiveTaxMinor);
      }
    }
  });

  it("per line backs inclusive tax out of each line", () => {
    const res = R([{ name: "VAT", rateBps: 2000 }], { rounding: "per_line" });
    const t = tax([line("a", 1001n, res, true), line("b", 1001n, res, true)]);
    // 1001 × 20/120 = 166.83 → 166 per line.
    expect(t.inclusiveTaxMinor).toBe(332n);
    expect(t.additiveTaxMinor).toBe(0n);
  });

  it("splits a discount exactly across the charge lines", () => {
    expect(perLineBases([1003n, 1003n, 1003n], 2909n)).toEqual([969n, 970n, 970n]);
    expect(perLineBases([500n, -200n], 300n)).toEqual([500n, -200n]);
    expect(perLineBases([-200n], -300n)).toBeNull();
  });
});

describe("tax behaviour (2.30)", () => {
  it("the customer override wins over the region and the price", () => {
    expect(lineIsInclusive(R([]), false)).toBe(false);
    expect(lineIsInclusive(R([]), true)).toBe(true);
    expect(lineIsInclusive(R([], { priceType: "inclusive" }), false)).toBe(true);
    expect(
      lineIsInclusive(R([], { customerBehavior: "exclusive", priceType: "inclusive" }), true),
    ).toBe(false);
    expect(lineIsInclusive(R([], { customerBehavior: "inclusive" }), false)).toBe(true);
  });

  it("a new price takes its currency's value; no value = no rule", () => {
    const raw = { behavior_by_currency: { INR: "inclusive", USD: "exclusive", eur: "inclusive" } };
    expect(newPriceTaxBehavior(raw, "inr")).toBe("inclusive");
    expect(newPriceTaxBehavior(raw, "USD")).toBe("exclusive");
    expect(newPriceTaxBehavior(raw, "EUR")).toBeNull();
    expect(newPriceTaxBehavior(null, "INR")).toBeNull();
  });
});

describe("tax settings resolver", () => {
  it("null and malformed values resolve to today's behaviour", () => {
    for (const raw of [null, undefined, 3, "x", [], { rounding: "half_even" }]) {
      expect(resolveTaxSettings(raw)).toEqual({
        behaviorByCurrency: {},
        sellerTaxIds: {},
        rounding: "per_invoice_total",
      });
    }
  });

  it("seller tax id per destination country (2.31)", () => {
    const raw = { seller_tax_ids: { DE: " DE123456789 ", gb: "GB1", FR: "" } };
    expect(sellerTaxIdFor(raw, "de")).toBe("DE123456789");
    expect(sellerTaxIdFor(raw, "GB")).toBeNull();
    expect(sellerTaxIdFor(raw, "FR")).toBeNull();
    expect(sellerTaxIdFor(raw, null)).toBeNull();
  });

  it("a patch replaces only the keys it names; null clears one", () => {
    const stored = { rounding: "per_line", seller_tax_ids: { DE: "DE1" } };
    expect(mergeTaxSettings(stored, {})).toBeUndefined();
    expect(mergeTaxSettings(stored, { seller_tax_ids: { GB: " GB1 ", FR: " " } })).toEqual({
      rounding: "per_line",
      seller_tax_ids: { GB: "GB1" },
    });
    expect(
      mergeTaxSettings(stored, { seller_tax_ids: null, tax_rounding: "per_invoice_total" }),
    ).toEqual({ rounding: "per_invoice_total" });
  });
});
