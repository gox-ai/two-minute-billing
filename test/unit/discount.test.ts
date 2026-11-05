import { describe, it, expect } from "vitest";
import { computeDiscount, computeStackedDiscounts } from "@/modules/coupons/service";

const pct = (bps: number) => ({ kind: "percentage", percentOffBps: bps });
const fixed = (amt: number) => ({ kind: "fixed_amount", amountOffMinor: BigInt(amt) });

describe("computeDiscount — percentage", () => {
  it("20% of 10000 = 2000", () => expect(computeDiscount(pct(2000), 10000n)).toBe(2000n));
  it("100% = full subtotal", () => expect(computeDiscount(pct(10000), 4900n)).toBe(4900n));
  it("floors fractional results", () => {
    expect(computeDiscount(pct(3300), 999n)).toBe(329n); // floor(999*0.33)=329
  });
  it(">100% clamps to subtotal", () => expect(computeDiscount(pct(15000), 1000n)).toBe(1000n));
  it("0% = 0", () => expect(computeDiscount(pct(0), 10000n)).toBe(0n));
});

describe("computeDiscount — fixed amount", () => {
  it("fixed under subtotal", () => expect(computeDiscount(fixed(3000), 10000n)).toBe(3000n));
  it("fixed equal to subtotal", () => expect(computeDiscount(fixed(10000), 10000n)).toBe(10000n));
  it("fixed over subtotal clamps (never negative total)", () => {
    expect(computeDiscount(fixed(99999), 10000n)).toBe(10000n);
  });
});

describe("computeDiscount — edges", () => {
  it("zero subtotal → 0 for any coupon", () => {
    expect(computeDiscount(pct(5000), 0n)).toBe(0n);
    expect(computeDiscount(fixed(5000), 0n)).toBe(0n);
  });
  it("negative subtotal → 0", () => expect(computeDiscount(pct(5000), -100n)).toBe(0n));
  it("missing config → 0", () => expect(computeDiscount({ kind: "percentage" }, 1000n)).toBe(0n));
});

describe("computeDiscount — fixed-amount currency guard [regression: bug #1]", () => {
  const usdCoupon = { kind: "fixed_amount", amountOffMinor: 1000n, currency: "USD" };
  it("applies when currencies match", () => {
    expect(computeDiscount(usdCoupon, 5000n, "USD")).toBe(1000n);
  });
  it("does NOT apply when currencies differ ($10 coupon must not subtract €10)", () => {
    expect(computeDiscount(usdCoupon, 5000n, "EUR")).toBe(0n);
  });
  it("case-insensitive currency match", () => {
    expect(computeDiscount({ ...usdCoupon, currency: "usd" }, 5000n, "USD")).toBe(1000n);
  });
  it("percentage coupons are currency-agnostic (still apply across currencies)", () => {
    expect(computeDiscount(pct(2000), 5000n, "EUR")).toBe(1000n);
  });
  it("no invoice currency given → applies (back-compat)", () => {
    expect(computeDiscount(usdCoupon, 5000n)).toBe(1000n);
  });
});

/**
 * The TWO-STAGE waterfall (0169) — our convention for `sub_total`.
 *
 *   subtotal = Σ line amounts − Σ(item_level shares)      ← item-level nets INTO it
 *   total    = subtotal − Σ(document_level shares) + tax  ← document-level applies TO it
 *
 * A 15% coupon on a 12900 plan reports `sub_total: 10965` item-level and `12900`
 * document-level. Same money, two conventions — which is exactly what these assertions
 * pin, so a future refactor cannot quietly collapse the stages again.
 */
describe("computeStackedDiscounts — the two-stage waterfall", () => {
  const LINES = [
    { index: 0, amountMinor: 9900n, productKind: "plan", productPublicId: "pro" },
    { index: 1, amountMinor: 2000n, productKind: "addon", productPublicId: "seats" },
  ];
  const GROSS = 11900n;
  const base = {
    percentOffBps: 1500,
    amountOffMinor: null,
    currency: null,
    invoiceName: null,
    createdAt: new Date("2026-01-01"),
  };
  const itemLevel = (over: Record<string, unknown> = {}) => ({
    ...base,
    appliedCouponId: "ac_item",
    couponPublicId: "ITEM15",
    kind: "percentage",
    applyOn: "each_specified_item",
    constraints: [{ itemKind: "plan", constraintType: "all", productIds: null }],
    ...over,
  });
  const docLevel = (over: Record<string, unknown> = {}) => ({
    ...base,
    appliedCouponId: "ac_doc",
    couponPublicId: "DOC15",
    kind: "percentage",
    applyOn: "invoice_amount",
    constraints: [],
    ...over,
  });
  const stack = (coupons: unknown[]) =>
    computeStackedDiscounts(coupons as never, LINES as never, "USD");
  const subtotalOf = (r: ReturnType<typeof stack>) => GROSS - r.itemLevelMinor;
  const sharesOf = (r: ReturnType<typeof stack>, scope: string) =>
    r.shares.filter((s) => s.scope === scope).reduce((s, x) => s + x.amountMinor, 0n);

  it("an ITEM-level coupon reduces the subtotal", () => {
    const r = stack([itemLevel()]);
    // 15% of the 9900 plan line only; the 2000 addon is not matched.
    expect(r.itemLevelMinor).toBe(1485n);
    expect(r.invoiceLevelMinor).toBe(0n);
    expect(subtotalOf(r)).toBe(10415n);
  });

  it("a DOCUMENT-level coupon leaves the subtotal GROSS", () => {
    const r = stack([docLevel()]);
    expect(r.itemLevelMinor).toBe(0n);
    expect(r.invoiceLevelMinor).toBe(1785n); // 15% of the whole 11900
    expect(subtotalOf(r)).toBe(GROSS);
  });

  it("the same percentage off gives DIFFERENT subtotals by scope — the whole point", () => {
    expect(subtotalOf(stack([itemLevel()]))).not.toBe(subtotalOf(stack([docLevel()])));
    // …while the money actually taken off is identical for a whole-invoice match.
    const bothMatchAll = stack([
      itemLevel({
        constraints: [
          { itemKind: "plan", constraintType: "all", productIds: null },
          { itemKind: "addon", constraintType: "all", productIds: null },
        ],
      }),
    ]);
    expect(bothMatchAll.totalMinor).toBe(stack([docLevel()]).totalMinor);
  });

  it("100% ITEM-level on the only line reports subtotal 0", () => {
    // The invoice that opened this: sub_total had to be 0, and we reported 9900.
    const r = computeStackedDiscounts(
      [itemLevel({ percentOffBps: 10000 })] as never,
      [LINES[0]!] as never,
      "USD",
    );
    expect(9900n - r.itemLevelMinor).toBe(0n);
  });

  it("DOCUMENT-level discounts are attributed to lines too, without entering the subtotal", () => {
    // A document-level discount still carries a line_item_id and populates
    // line_items[].discount_amount, yet sub_total stays gross. Attribution and stage
    // are independent questions.
    const r = stack([docLevel()]);
    expect(r.invoiceLevelByIndex.reduce((s, d) => s + d, 0n)).toBe(1785n);
    expect(r.lineDiscountByIndex.reduce((s, d) => s + d, 0n)).toBe(0n);
    expect(r.shares.every((s) => s.scope === "document_level")).toBe(true);
    expect(r.shares.length).toBe(2); // spread across BOTH lines
    expect(subtotalOf(r)).toBe(GROSS);
  });

  it("shares reconcile to both stage totals", () => {
    const r = stack([itemLevel(), docLevel({ percentOffBps: 1000 })]);
    expect(sharesOf(r, "item_level")).toBe(r.itemLevelMinor);
    expect(sharesOf(r, "document_level")).toBe(r.invoiceLevelMinor);
    // No zero rows: an untouched line gets no line_item_discounts[] entry.
    expect(r.shares.every((s) => s.amountMinor > 0n)).toBe(true);
  });

  it("only the DOCUMENT-level part gets an aggregate discount line", () => {
    // A line for the full discountMinor would subtract the item-level part twice — the
    // stored subtotal already has it off.
    const r = stack([itemLevel(), docLevel({ percentOffBps: 1000 })]);
    expect(r.rows.reduce((s, x) => s + x.documentLevelMinor, 0n)).toBe(r.invoiceLevelMinor);
    const itemRow = r.rows.find((x) => x.appliedCouponId === "ac_item")!;
    expect(itemRow.discountMinor).toBe(1485n);
    expect(itemRow.documentLevelMinor).toBe(0n); // discounted, but no line of its own
  });

  it("MONEY DOES NOT MOVE: the booked total is unchanged by the split", () => {
    // The safety property of the whole change. Whatever the scope mix, the amount taken
    // off the invoice is the same, so total/amount_due/tax/ledger cannot shift.
    for (const coupons of [[itemLevel()], [docLevel()], [itemLevel(), docLevel()]]) {
      const r = stack(coupons);
      expect(r.itemLevelMinor + r.invoiceLevelMinor).toBe(r.totalMinor);
      expect(subtotalOf(r) - sharesOf(r, "document_level")).toBe(GROSS - r.totalMinor);
    }
  });
});
