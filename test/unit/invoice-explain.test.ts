import { describe, expect, it } from "vitest";
import {
  compareInvoices,
  explainInvoice,
  totalsLadder,
  type InvoiceView,
} from "@/modules/invoicing/explain";

const base = (over: Partial<InvoiceView>): InvoiceView => ({
  id: "inv_1",
  number: "INV-1",
  status: "paid",
  currency: "USD",
  subtotal_minor: 0,
  total_minor: 0,
  amount_paid_minor: 0,
  amount_due_minor: 0,
  credits_applied_minor: 0,
  lines: [],
  discounts: [],
  ...over,
});

const line = (o: Record<string, unknown>) => ({
  id: "il_1",
  description: "Pro",
  kind: "recurring",
  quantity: 1,
  amount_minor: 1000,
  price: "pro-monthly",
  period_start: "2026-10-01T00:00:00Z",
  period_end: "2026-11-01T00:00:00Z",
  ...o,
});

describe("totalsLadder", () => {
  it("holds when total = subtotal − document discount + tax + rounding", () => {
    const inv = base({
      subtotal_minor: 1000,
      document_level_discount_minor: 100,
      total_minor: 1080,
      lines: [line({}), line({ id: "il_t", kind: "tax", amount_minor: 180, price: null })],
    });
    const t = totalsLadder(inv);
    expect(t.tax_minor).toBe(180);
    expect(t.holds).toBe(true);
  });

  it("reports a ladder that does not add up instead of hiding it", () => {
    expect(
      totalsLadder(base({ subtotal_minor: 1000, total_minor: 999, lines: [line({})] })).holds,
    ).toBe(false);
  });
});

describe("explainInvoice", () => {
  it("says why a line is untaxed and which discount hit it", () => {
    const inv = base({
      subtotal_minor: 1000,
      total_minor: 1000,
      lines: [line({ is_taxed: false, tax_exempt_reason: "reverse_charge", tax_amount_minor: 0 })],
      discounts: [
        {
          label: "Launch",
          scope: "item_level",
          source: "coupon",
          coupon_code: "LAUNCH",
          line_item_ids: ["il_1"],
          amount_minor: 0,
        },
      ],
    });
    const e = explainInvoice(inv, null);
    expect(e.lines[0]!.untaxed_because).toBe("reverse_charge");
    expect(e.lines[0]!.discounted_by[0]!.coupon_code).toBe("LAUNCH");
    expect(e.lines[0]!.period_days).toBe(31);
    expect(e.compared_to_previous).toBeNull();
  });
});

describe("compareInvoices", () => {
  it("groups by price and reports added, removed and changed charges, largest first", () => {
    const prev = base({
      id: "inv_0",
      total_minor: 1500,
      lines: [
        line({}),
        line({ id: "il_2", description: "Seats", price: "seat", amount_minor: 500 }),
      ],
    });
    const cur = base({
      total_minor: 3200,
      lines: [
        line({ amount_minor: 1200 }),
        line({ id: "il_3", description: "Support", price: "support", amount_minor: 2000 }),
      ],
    });
    const c = compareInvoices(cur, prev);
    expect(c.total_delta_minor).toBe(1700);
    expect(c.line_changes.map((x) => [x.price, x.change, x.delta_minor])).toEqual([
      ["support", "added", 2000],
      ["seat", "removed", -500],
      ["pro-monthly", "changed", 200],
    ]);
  });

  it("ignores charges that did not change", () => {
    const same = base({ lines: [line({})] });
    expect(compareInvoices(same, { ...same, id: "inv_0" }).line_changes).toEqual([]);
  });
});
