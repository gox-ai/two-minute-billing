import { describe, expect, it } from "vitest";
import { changeDirection, changeTimings, prorateFor } from "@/modules/subscriptions/change-policy";
import {
  initialBillingRulesConfig,
  resolveBillingRulesConfig,
} from "@/modules/subscriptions/billing-rules-config";

describe("plan-change rules", () => {
  it("a longer period is an upgrade and a shorter one a downgrade, whatever the amount", () => {
    expect(changeDirection(1000, 500, { before: 1, after: 12 })).toBe("upgrade");
    expect(changeDirection(500, 1000, { before: 12, after: 1 })).toBe("downgrade");
    expect(changeDirection(500, 1000, { before: 1, after: 1 })).toBe("upgrade");
    expect(changeDirection(1000, 1000, { before: 1, after: 1 })).toBe("same");
  });

  it("unset rules resolve to today's behaviour", () => {
    const r = resolveBillingRulesConfig({});
    expect(r.upgradeProration).toBe("prorated");
    expect(r.downgradeProration).toBe("prorated");
    expect(r.upgradeGate).toBe("off");
    expect(r.downgradeGate).toBe("off");
    expect(r.upgradeTiming).toBeNull();
    expect(r.downgradeTiming).toBeNull();
  });

  it("malformed values resolve to the default", () => {
    const r = resolveBillingRulesConfig({
      billingRulesConfig: { upgrade_proration: "full", upgrade_gate: true, downgrade_timing: 1 },
    });
    expect(r.upgradeProration).toBe("prorated");
    expect(r.upgradeGate).toBe("off");
    expect(r.downgradeTiming).toBeNull();
  });

  it("a person's new business gets the recommended plan-change rules", () => {
    const r = resolveBillingRulesConfig({
      billingRulesConfig: initialBillingRulesConfig({ hasOperator: true }),
    });
    expect([r.upgradeGate, r.downgradeGate]).toEqual(["invoices_paid", "off"]);
    expect([r.upgradeTiming, r.downgradeTiming]).toEqual(["now", "end_of_term"]);
    expect([r.upgradeProration, r.downgradeProration]).toEqual(["prorated", "prorated"]);
  });

  it("unset timing keeps each source's own behaviour", () => {
    const t = (direction: "upgrade" | "downgrade", source: "portal" | "api") =>
      changeTimings({ rule: null, direction, source, inTrial: false });
    expect(t("upgrade", "portal")).toEqual({ timings: ["now"], defaultTiming: "now" });
    expect(t("downgrade", "portal")).toEqual({
      timings: ["end_of_term"],
      defaultTiming: "end_of_term",
    });
    expect(t("downgrade", "api")).toEqual({
      timings: ["now", "end_of_term"],
      defaultTiming: "now",
    });
  });

  it("a saved timing binds every source; customer_chooses defaults by direction", () => {
    for (const source of ["portal", "dashboard", "api"] as const) {
      expect(
        changeTimings({ rule: "end_of_term", direction: "upgrade", source, inTrial: false }),
      ).toEqual({ timings: ["end_of_term"], defaultTiming: "end_of_term" });
      expect(
        changeTimings({ rule: "customer_chooses", direction: "downgrade", source, inTrial: false }),
      ).toEqual({ timings: ["now", "end_of_term"], defaultTiming: "end_of_term" });
    }
  });

  it("in a trial every change applies now", () => {
    expect(
      changeTimings({ rule: "end_of_term", direction: "downgrade", source: "api", inTrial: true }),
    ).toEqual({ timings: ["now"], defaultTiming: "now" });
    expect(
      changeTimings({ rule: null, direction: "downgrade", source: "portal", inTrial: true }),
    ).toEqual({ timings: ["now"], defaultTiming: "now" });
  });

  it("the call's prorate wins over the rule for its direction", () => {
    const policy = {
      timings: ["now" as const],
      defaultTiming: "now" as const,
      blocked: null,
      prorate: { upgrade: true, downgrade: false },
      invoiceImmediately: null,
      planChangeTerm: "keep_anchor" as const,
    };
    expect(prorateFor(policy, "downgrade")).toBe(false);
    expect(prorateFor(policy, "same")).toBe(true);
    expect(prorateFor(policy, "downgrade", true)).toBe(true);
  });
});
