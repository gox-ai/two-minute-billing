import { describe, expect, it } from "vitest";
import { allocateExcess, type ExcessEntry } from "@/modules/refunds/excess-allocation";

// uuid v7 text sorts by time; these stand in for entry ids in time order.
let n = 0;
const at = () => `0190${String(++n).padStart(4, "0")}-0000-7000-8000-000000000000`;
const credit = (pay: string, amount: number, sourceType = "excess_payment"): ExcessEntry => ({
  id: at(),
  direction: "credit",
  amountMinor: BigInt(amount),
  currency: "INR",
  sourceType,
  sourceId: pay,
});
const draw = (inv: string, amount: number, currency = "INR"): ExcessEntry => ({
  id: at(),
  direction: "debit",
  amountMinor: BigInt(amount),
  currency,
  sourceType: "credit_applied",
  sourceId: inv,
});
const remaining = (rows: ReturnType<typeof allocateExcess>) =>
  Object.fromEntries(rows.map((r) => [r.paymentPublicId, Number(r.remainingMinor)]));

describe("allocateExcess", () => {
  it("a payment whose credit two invoices used up has nothing left", () => {
    // An excess payment of 5,699.00, then two invoice draws that take all of it.
    const rows = allocateExcess(
      [credit("pay_1", 569900), draw("inv_a", 18384), draw("inv_b", 551516)],
      new Set(["pay_1"]),
    );
    expect(rows).toEqual([
      { paymentPublicId: "pay_1", currency: "INR", ownMinor: 569900n, remainingMinor: 0n },
    ]);
  });

  it("a partly used payment keeps the rest", () => {
    const rows = allocateExcess([credit("pay_1", 10000), draw("inv_a", 2500)], new Set(["pay_1"]));
    expect(remaining(rows)).toEqual({ pay_1: 7500 });
  });

  it("draws come off the oldest payment first and the rest sums to the balance", () => {
    const rows = allocateExcess(
      [credit("pay_old", 3000), credit("pay_new", 5000), draw("inv_a", 4000)],
      new Set(["pay_old", "pay_new"]),
    );
    expect(remaining(rows)).toEqual({ pay_old: 0, pay_new: 4000 });
    expect(rows.reduce((s, r) => s + r.remainingMinor, 0n)).toBe(4000n);
  });

  it("a payment's own refund reduces only that payment", () => {
    const rows = allocateExcess(
      [
        credit("pay_old", 3000),
        credit("pay_new", 5000),
        { ...draw("pay_new", 1000), sourceType: "excess_refund_reserve" },
        draw("inv_a", 2000),
      ],
      new Set(["pay_old", "pay_new"]),
    );
    expect(remaining(rows)).toEqual({ pay_old: 1000, pay_new: 4000 });
  });

  it("an overpayment's recorded absorb comes off its own credit, not the oldest", () => {
    const absorb = draw("inv_own", 700);
    const rows = allocateExcess(
      [credit("pay_old", 3000), credit("pay_over", 1000), absorb],
      new Set(["pay_old", "pay_over"]),
      new Map([[absorb.id, "pay_over"]]),
    );
    expect(remaining(rows)).toEqual({ pay_old: 3000, pay_over: 300 });
  });

  it("credit from another source takes its turn but is not a payment row", () => {
    const rows = allocateExcess(
      [credit("adj_1", 2000, "excess_adjustment"), credit("pay_1", 5000), draw("inv_a", 3000)],
      new Set(["pay_1"]),
    );
    expect(remaining(rows)).toEqual({ pay_1: 4000 });
  });

  it("keeps each currency apart", () => {
    const usd = { ...credit("pay_usd", 1000), currency: "USD" };
    const rows = allocateExcess(
      [credit("pay_inr", 1000), usd, draw("inv_a", 1000, "USD")],
      new Set(["pay_inr", "pay_usd"]),
    );
    expect(remaining(rows)).toEqual({ pay_inr: 1000, pay_usd: 0 });
  });
});
