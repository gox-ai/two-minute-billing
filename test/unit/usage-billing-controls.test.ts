import { describe, it, expect } from "vitest";
import {
  leadCoverMinor,
  scheduleSlotOn,
  topupAmount,
  type TopupAmountInput,
} from "@/modules/usage-controls/auto-topup-amount";
import { foldBilledDiscount, thresholdEligible } from "@/modules/usage-controls/interim-lines";
import {
  noticeDutyFor,
  noticeLeadHours,
  OWN_NOTICE_LEAD_HOURS,
} from "@/modules/payment-methods/notice-duty";
import type { DiscountStack } from "@/modules/coupons/service";

const base: TopupAmountInput = {
  trigger: "threshold",
  method: "fixed",
  thresholdMinor: 1_000n,
  amountMinor: 500n,
  targetMinor: null,
  balanceMinor: 0n,
  openMinor: 0n,
  minMinor: null,
  maxMinor: null,
  afaCapMinor: null,
  monthlyCapMinor: 1_000_000n,
  usedThisMonthMinor: 0n,
};

describe("auto top-up amount", () => {
  it("fixed lands strictly above the threshold, in multiples", () => {
    expect(topupAmount({ ...base, balanceMinor: 1_000n })).toEqual({
      kind: "run",
      amountMinor: 500n,
    });
    expect(topupAmount({ ...base, balanceMinor: 0n })).toEqual({
      kind: "run",
      amountMinor: 1_500n,
    });
    expect(topupAmount({ ...base, balanceMinor: 999n })).toEqual({
      kind: "run",
      amountMinor: 500n,
    });
    expect(topupAmount({ ...base, balanceMinor: 1_001n })).toEqual({ kind: "none" });
  });
  it("open runs count toward the balance", () => {
    expect(topupAmount({ ...base, balanceMinor: 600n, openMinor: 500n })).toEqual({ kind: "none" });
  });
  it("target tops up to the target and respects min / max", () => {
    const t = { ...base, method: "target" as const, amountMinor: null, targetMinor: 5_000n };
    expect(topupAmount({ ...t, balanceMinor: 800n })).toEqual({ kind: "run", amountMinor: 4_200n });
    expect(topupAmount({ ...t, balanceMinor: 800n, maxMinor: 3_000n })).toEqual({
      kind: "run",
      amountMinor: 3_000n,
    });
    expect(topupAmount({ ...t, balanceMinor: 900n, minMinor: 4_500n })).toEqual({
      kind: "run",
      amountMinor: 4_500n,
    });
  });
  it("clamps an INR card / UPI mandate run at ₹15,000", () => {
    expect(
      topupAmount({
        ...base,
        amountMinor: 2_000_000n,
        afaCapMinor: 1_500_000n,
        monthlyCapMinor: 10_000_000n,
      }),
    ).toEqual({ kind: "run", amountMinor: 1_500_000n });
  });
  it("the monthly cap reduces the run, then skips it below min", () => {
    const c = { ...base, minMinor: 300n, monthlyCapMinor: 2_000n };
    expect(topupAmount({ ...c, usedThisMonthMinor: 1_200n })).toEqual({
      kind: "run",
      amountMinor: 800n,
    });
    expect(topupAmount({ ...c, usedThisMonthMinor: 1_800n })).toEqual({
      kind: "skip",
      reason: "monthly_cap",
    });
  });
  it("schedule + target makes no run at the target", () => {
    expect(
      topupAmount({
        ...base,
        trigger: "schedule",
        method: "target",
        thresholdMinor: null,
        amountMinor: null,
        targetMinor: 1_000n,
        balanceMinor: 1_000n,
      }),
    ).toEqual({ kind: "none" });
  });
  it("a 31st anchor fires on 30 April; weekly on its ISO weekday", () => {
    expect(scheduleSlotOn({ every: "month", day: 31 }, "2026-04-30")).toBe("2026-04-30");
    expect(scheduleSlotOn({ every: "month", day: 31 }, "2026-04-29")).toBeNull();
    expect(scheduleSlotOn({ every: "month", day: 31 }, "2026-05-31")).toBe("2026-05-31");
    // 2026-11-02 is a Monday.
    expect(scheduleSlotOn({ every: "week", weekday: 1 }, "2026-11-02")).toBe("2026-11-02");
    expect(scheduleSlotOn({ every: "week", weekday: 2 }, "2026-11-02")).toBeNull();
  });
  it("lead cover is lead hours of burn, rounded up", () => {
    expect(leadCoverMinor(26, 24_000n)).toBe(26_000n);
    expect(leadCoverMinor(72, 100n)).toBe(300n);
    expect(leadCoverMinor(26, 1n)).toBe(2n);
    expect(leadCoverMinor(0, 100n)).toBe(0n);
  });
});

describe("notice duty and lead", () => {
  const pm = (o: Partial<{ type: string; mandateRail: string | null; providerKey: string }>) => ({
    type: "upi",
    mandateRail: "upi" as string | null,
    providerKey: "razorpay",
    ...o,
  });
  const gw = (key: string, minLeadHours: number, methods: string[] = ["upi"]) => ({
    key,
    capabilities: {
      preDebitNotice: { methods, minLeadHours, maxDebitsPerNotice: 1, exactAmount: true },
    },
    notifyUpcomingDebit: async () => ({}) as never,
  });
  it("the worst case per adapter, not minLeadHours + 2", () => {
    // PayU worst case per instrument (cards 27 h, UPI 31 h), never below the adapter's own lead.
    expect(noticeLeadHours(pm({}), gw("payu", 25) as never)).toBe(31);
    expect(
      noticeLeadHours(
        pm({ type: "card", mandateRail: "card" }),
        gw("payu", 24, ["card", "upi"]) as never,
      ),
    ).toBe(27);
    expect(noticeLeadHours(pm({}), gw("payu", 48) as never)).toBe(48);
    expect(noticeLeadHours(pm({}), gw("cashfree", 24) as never)).toBe(49);
    expect(noticeLeadHours(pm({}), gw("tmtest", 30) as never)).toBe(30);
    expect(noticeLeadHours(pm({}), null)).toBe(OWN_NOTICE_LEAD_HOURS);
    expect(noticeLeadHours(pm({ type: "card", mandateRail: null }), null)).toBe(0);
  });
  it("who notifies", () => {
    expect(noticeDutyFor(pm({}), gw("payu", 48) as never)).toBe("gateway");
    expect(noticeDutyFor(pm({}), null)).toBe("ours");
    expect(
      noticeDutyFor(pm({}), { key: "x", capabilities: { gatewayNotifiesPayer: ["upi"] } } as never),
    ).toBe("gateway_notifies");
    expect(noticeDutyFor(pm({ type: "card", mandateRail: null }), null)).toBe("none");
    // The gateway's own notice counts only in its currencies (Cashfree: INR).
    const inrOnly = {
      key: "cashfree",
      capabilities: { gatewayNotifiesPayer: ["card"], gatewayNotifiesPayerCurrencies: ["INR"] },
    } as never;
    const card = (mandateCurrency: string) => ({
      ...pm({ type: "card", mandateRail: "card" }),
      mandateCurrency,
    });
    expect(noticeDutyFor(card("INR"), inrOnly)).toBe("gateway_notifies");
    expect(noticeDutyFor(card("USD"), inrOnly)).toBe("ours");
  });
});

describe("threshold invoicing", () => {
  it("eligibility by model × aggregation", () => {
    expect(thresholdEligible({ model: "usage", usageAggregation: "sum" })).toBe(true);
    expect(thresholdEligible({ model: "tiered", usageAggregation: "max" })).toBe(true);
    expect(thresholdEligible({ model: "volume", usageAggregation: "sum" })).toBe(false);
    expect(thresholdEligible({ model: "usage", usageAggregation: "last" })).toBe(false);
    expect(thresholdEligible({ model: "usage", usageAggregation: "avg" })).toBe(false);
    expect(
      thresholdEligible({ model: "usage", usageAggregation: "sum", usageRecurring: true }),
    ).toBe(false);
    expect(
      thresholdEligible({
        model: "stairstep",
        usageAggregation: "sum",
        tiers: [{ flatAmountMinor: 500 }, { flatAmountMinor: 300 }],
      }),
    ).toBe(false);
  });

  const stack = (over: Partial<DiscountStack>): DiscountStack => ({
    rows: [],
    totalMinor: 0n,
    invoiceLevelMinor: 0n,
    itemLevelMinor: 0n,
    lineDiscountByIndex: [],
    invoiceLevelByIndex: [],
    shares: [],
    ...over,
  });
  it("the virtual lines' discount moves onto the final invoice", () => {
    // Real line 600, virtual (billed on interims) 400; 20% → 120 + 80.
    const s = stack({
      rows: [
        {
          appliedCouponId: "c",
          couponPublicId: "c",
          label: "20%",
          discountMinor: 200n,
          documentLevelMinor: 200n,
        },
      ],
      totalMinor: 200n,
      invoiceLevelMinor: 200n,
      lineDiscountByIndex: [0n, 0n],
      invoiceLevelByIndex: [120n, 80n],
      shares: [
        {
          lineIndex: 0,
          appliedCouponId: "c",
          label: "20%",
          scope: "document_level",
          amountMinor: 120n,
        },
        {
          lineIndex: 1,
          appliedCouponId: "c",
          label: "20%",
          scope: "document_level",
          amountMinor: 80n,
        },
      ],
    });
    const { stack: f, excessMinor } = foldBilledDiscount(s, [600n]);
    expect(excessMinor).toBe(0n);
    expect(f.totalMinor).toBe(200n);
    expect(f.invoiceLevelByIndex).toEqual([200n]);
    expect(f.rows[0]!.discountMinor).toBe(200n);
  });
  it("a discount larger than the final invoice leaves the excess", () => {
    const s = stack({
      rows: [
        {
          appliedCouponId: "c",
          couponPublicId: "c",
          label: "₹500",
          discountMinor: 500n,
          documentLevelMinor: 500n,
        },
      ],
      totalMinor: 500n,
      invoiceLevelMinor: 500n,
      lineDiscountByIndex: [0n, 0n],
      invoiceLevelByIndex: [100n, 400n],
      shares: [
        {
          lineIndex: 0,
          appliedCouponId: "c",
          label: "₹500",
          scope: "document_level",
          amountMinor: 100n,
        },
        {
          lineIndex: 1,
          appliedCouponId: "c",
          label: "₹500",
          scope: "document_level",
          amountMinor: 400n,
        },
      ],
    });
    const { stack: f, excessMinor } = foldBilledDiscount(s, [300n]);
    expect(f.totalMinor).toBe(300n);
    expect(excessMinor).toBe(200n);
  });
});
