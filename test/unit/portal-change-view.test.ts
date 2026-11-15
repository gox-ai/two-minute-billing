import { describe, expect, it } from "vitest";
import {
  addonOffered,
  buyerChangeError,
  buyerCouponError,
  buyerLine,
  lineNames,
  pauseCopy,
  planAfterPeriodSwitch,
  planTag,
  priceText,
  skipChoices,
  sortPlans,
  startsNewTerm,
  termName,
  type PlanLike,
} from "../../dashboard/app/(storefront)/portal/(session)/portal-change-view";

const fmt = (m: number) => `$${(m / 100).toFixed(2)}`;
const plan = (p: Partial<PlanLike> & { price: string; name: string }): PlanLike => ({
  amount_minor: 1000,
  model: "flat",
  interval: "month",
  interval_count: 1,
  current: false,
  direction: "upgrade",
  ...p,
});

const PLANS = [
  plan({ price: "enterprise-m", name: "Enterprise", amount_minor: 99900 }),
  plan({ price: "growth-m", name: "Growth", amount_minor: 7900, current: true, direction: "same" }),
  plan({ price: "pro-m", name: "Pro", amount_minor: 19900 }),
  plan({
    price: "pro-team",
    name: "Pro",
    amount_minor: null,
    model: "stairstep",
    direction: "downgrade",
  }),
  plan({ price: "starter-m", name: "Starter", amount_minor: 2900, direction: "downgrade" }),
  plan({ price: "pro-y", name: "Pro", amount_minor: 199000, interval: "year" }),
  plan({ price: "starter-y", name: "Starter", amount_minor: 29000, interval: "year" }),
];
const TIMING = {
  upgrade: { options: ["now" as const], default: "now" as const, blocked: null },
  downgrade: { options: ["end_of_term" as const], default: "end_of_term" as const, blocked: null },
};

describe("plan list", () => {
  it("orders by price, cheapest first, a plan with no single price last", () => {
    expect(sortPlans(PLANS.filter((p) => p.interval === "month")).map((p) => p.price)).toEqual([
      "starter-m",
      "growth-m",
      "pro-m",
      "enterprise-m",
      "pro-team",
    ]);
  });

  it("tags the current plan, each direction with its timing, and no direction without a price", () => {
    expect(planTag(PLANS[1]!, TIMING)).toBe("Current plan");
    expect(planTag(PLANS[2]!, TIMING)).toBe("Upgrade · starts now");
    expect(planTag(PLANS[4]!, TIMING)).toBe("Downgrade · starts at your next renewal");
    expect(planTag(PLANS[3]!, TIMING)).toBeUndefined();
  });

  it("says per unit for a metered add-on and per seat for a per-unit price", () => {
    const calls = {
      price: "api",
      name: "API Calls",
      amount_minor: 50,
      interval: "month",
      interval_count: 1,
      model: "usage",
    };
    expect(priceText(calls, fmt)).toBe("$0.50 per unit used, billed every month");
    expect(priceText({ ...calls, model: "per_unit", amount_minor: 1200 }, fmt)).toBe(
      "$12.00 per seat every month",
    );
    expect(priceText(PLANS[3]!, fmt)).toBe("Priced by quantity, billed every month");
  });
});

describe("billing period switch", () => {
  it("never keeps a hidden plan selected", () => {
    expect(planAfterPeriodSwitch(PLANS, "pro-m", "1:year")).toBe("pro-y");
    expect(planAfterPeriodSwitch(PLANS, "growth-m", "1:year")).toBe("");
    expect(planAfterPeriodSwitch(PLANS, "pro-y", "1:month")).toBe("pro-m");
    expect(planAfterPeriodSwitch(PLANS, "enterprise-m", "1:year")).toBe("");
  });

  it("offers an add-on only on the plan's own billing period", () => {
    const rules = { "growth-m": {}, "pro-y": {} };
    const yearly = {
      price: "seats-y",
      name: "Extra Seats",
      amount_minor: 12000,
      interval: "year",
      interval_count: 1,
      quantity: 0,
      rules,
    };
    expect(addonOffered(yearly, PLANS[1])).toBe(false);
    expect(addonOffered(yearly, PLANS[5])).toBe(true);
    expect(addonOffered({ ...yearly, quantity: 1 }, PLANS[1])).toBe(true);
  });
});

describe("preview lines", () => {
  const names = lineNames(PLANS);
  it("names price ids and keeps the period apart", () => {
    expect(buyerLine("pro-y ×1 (new term)", names)).toEqual({
      label: "Pro, yearly",
      span: "new_term",
    });
    expect(buyerLine("Remaining time on Pro Monthly ×1", names)).toEqual({
      label: "Pro Monthly",
      span: "rest_of_period",
    });
    expect(buyerLine("Unused time on Per seat, monthly ×2", names)).toEqual({
      label: "Credit for unused time on Per seat, monthly × 2",
      span: "unused",
    });
    expect(buyerLine("Onboarding", names)).toEqual({ label: "Onboarding", span: null });
  });

  it("uses the price name when the engine sends it", () => {
    const n = lineNames([
      {
        price: "seats-m",
        name: "Extra Seats",
        amount_minor: 1200,
        interval: "month",
        interval_count: 1,
        price_name: "Per seat, monthly",
      },
    ]);
    expect(buyerLine("Unused time on Per seat, monthly ×2", n).label).toBe(
      "Credit for unused time on Extra Seats, monthly × 2",
    );
  });

  it("knows a change that starts a new term", () => {
    expect(startsNewTerm([{ description: "pro-y ×1 (new term)" }])).toBe(true);
    expect(startsNewTerm([{ description: "Remaining time on Pro Monthly ×1" }])).toBe(false);
  });
});

describe("errors in buyer words", () => {
  it("never shows the engine's operator text", () => {
    const raw =
      "Billing period mismatch: price seats-yearly-usd bills every year, but the subscription bills every month.";
    const out = buyerChangeError(raw, "We could not price this change.");
    expect(out).toMatch(/^We could not price this change\. /);
    expect(out).not.toMatch(/seats-yearly-usd|mismatch/);
    expect(
      buyerChangeError(
        "Use upcoming_renewals to get the dates.",
        "We could not skip the renewal.",
        "Select a different date.",
      ),
    ).toBe("We could not skip the renewal. Select a different date.");
  });

  it("keeps a refusal already written for the buyer", () => {
    expect(buyerChangeError("Select a change first.", "We could not price this change.")).toBe(
      "We could not price this change. Select a change first.",
    );
    expect(
      buyerChangeError(
        "We could not skip the renewal. Skips close 48 hours before the renewal.",
        "x",
      ),
    ).toBe("We could not skip the renewal. Skips close 48 hours before the renewal.");
  });

  it("maps coupon refusals", () => {
    expect(buyerCouponError("No active coupon: SPRNG")).toBe(
      "We could not apply this code. Check the code and try again.",
    );
    expect(buyerCouponError("No such coupon: X")).toMatch(/Check the code/);
    expect(buyerCouponError("Coupon SAVE has reached its redemption limit")).toMatch(
      /no longer available/,
    );
    expect(buyerCouponError("We could not apply this coupon. It is not available here.")).toBe(
      "We could not apply this coupon. It is not available here.",
    );
  });
});

describe("pause", () => {
  it("states start, length, charges and paid time when the terms are known", () => {
    const now = pauseCopy({ starts: "now", resume_charge: "now" }, "2 Dec 2026");
    expect(now[0]).toBe("Your subscription pauses today.");
    expect(now).toContain("It stays paused until you resume it here. There is no end date.");
    expect(now.join(" ")).toMatch(/If you resume before 2 Dec 2026/);
    expect(now.join(" ")).toMatch(/we charge you for it on that day/);
    const later = pauseCopy({ starts: "end_of_term", resume_charge: "next_invoice" }, "2 Dec 2026");
    expect(later[0]).toBe("Your subscription stays active until 2 Dec 2026. Then it pauses.");
    expect(later.join(" ")).toMatch(/your next invoice/);
  });

  it("states only what holds for both starts when the terms are unknown", () => {
    const out = pauseCopy(undefined, "2 Dec 2026");
    expect(out[0]).toBe("It stays paused until you resume it here. There is no end date.");
    expect(out.join(" ")).not.toMatch(/pauses today|for it on that day|next invoice/);
  });
});

describe("restart and skip", () => {
  it("names the term", () => {
    expect(termName("month", 1)).toBe("a new month");
    expect(termName("month", 3)).toBe("a new 3-month term");
  });

  it("lists a short set of skippable renewals", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i, skipped: i === 1 }));
    const short = skipChoices(rows, false);
    expect(short.shown.map((r) => r.id)).toEqual([0, 2, 3]);
    expect(short.more).toBe(8);
    expect(skipChoices(rows, true).shown).toHaveLength(11);
    expect(skipChoices(rows.slice(0, 4), false).more).toBe(0);
  });
});
