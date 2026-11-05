import { describe, expect, it } from "vitest";
import {
  mergeBillingRulesConfig,
  resolveBillingRulesConfig,
  serializeBillingRulesConfig,
} from "@/modules/subscriptions/billing-rules-config";

describe("credit and allowance reset settings", () => {
  it("resolves the recommended option for every key when nothing is stored", () => {
    const r = resolveBillingRulesConfig({ billingRulesConfig: null });
    expect(r.planCredits).toEqual({
      onUpgrade: "full",
      onDowngrade: "next_window",
      firstWindow: "full",
      onPause: "skip",
      onCancelAtPeriodEnd: "grant_started_window",
    });
    expect(r.allowances).toEqual({ onUpgrade: "new_window" });
  });

  it("reads stored values and drops one outside its union", () => {
    const r = resolveBillingRulesConfig({
      billingRulesConfig: {
        plan_credits: { on_upgrade: "next_window", on_downgrade: "prorated", on_pause: "shift" },
        allowances: { on_upgrade: "keep_used" },
      },
    });
    expect(r.planCredits.onUpgrade).toBe("next_window");
    expect(r.planCredits.onDowngrade).toBe("next_window");
    expect(r.planCredits.onPause).toBe("shift");
    expect(r.allowances.onUpgrade).toBe("keep_used");
  });

  it("serializes in snake_case", () => {
    const out = serializeBillingRulesConfig(resolveBillingRulesConfig({ billingRulesConfig: {} }));
    expect(out.plan_credits.on_cancel_at_period_end).toBe("grant_started_window");
    expect(out.allowances.on_upgrade).toBe("new_window");
  });

  it("merges plan_credits and allowances one level down", () => {
    const stored = { plan_credits: { on_pause: "shift" }, allowances: { on_upgrade: "keep_used" } };
    const merged = mergeBillingRulesConfig(stored, { plan_credits: { on_upgrade: "prorated" } });
    expect(merged.plan_credits).toEqual({ on_pause: "shift", on_upgrade: "prorated" });
    expect(merged.allowances).toEqual({ on_upgrade: "keep_used" });
  });
});
