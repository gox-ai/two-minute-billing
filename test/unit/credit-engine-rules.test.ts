import { describe, expect, it } from "vitest";
import { resolveCreditEngineRules, restoreExpiresAt } from "@/modules/credits/policy";
import {
  businessCreditConfigSchema,
  keepInFlightApplies,
} from "@/modules/credits/customer-settings";
import { serializeCreditUsage } from "@/modules/credits/usage-gate";
import { resolveBillingRulesConfig } from "@/modules/subscriptions/billing-rules-config";
import { resolveCreditConfig } from "../../dashboard/lib/credits";
import { billingRules } from "../../dashboard/lib/billing-rules";

describe("credit_config engine choices", () => {
  it("unset resolves to the rules before the keys", () => {
    expect(resolveCreditEngineRules(null)).toEqual({
      trialUsage: "refuse",
      noSubscriptionUsage: "block",
      noSubscriptionOverdraft: "needs_payment_method",
      noSubscriptionInvoiceAfterDays: 30,
      restoreExpiryMonths: 12,
      autoTopupOnHardDecline: "disable",
      captureOverHold: "debt",
    });
  });

  it("reads each value that is set", () => {
    const r = resolveCreditEngineRules({
      trial_usage: "as_paid",
      no_subscription_usage: "as_subscriber",
      no_subscription_overdraft: "never",
      no_subscription_invoice_after_days: 7,
      restore_expiry_months: "never",
      auto_topup_on_hard_decline: "keep_enabled",
      capture_over_hold: "cap_at_hold",
    });
    expect(r).toEqual({
      trialUsage: "as_paid",
      noSubscriptionUsage: "as_subscriber",
      noSubscriptionOverdraft: "never",
      noSubscriptionInvoiceAfterDays: 7,
      restoreExpiryMonths: null,
      autoTopupOnHardDecline: "keep_enabled",
      captureOverHold: "cap_at_hold",
    });
  });

  it("a stored value outside the API's range resolves to the default", () => {
    const r = resolveCreditEngineRules({
      no_subscription_invoice_after_days: 0,
      restore_expiry_months: 500,
    } as never);
    expect(r.noSubscriptionInvoiceAfterDays).toBe(30);
    expect(r.restoreExpiryMonths).toBe(12);
  });

  it("restored credit expires 12 months later when unset, never on `never`", () => {
    const now = new Date("2026-01-31T10:00:00Z");
    expect(restoreExpiresAt(null, now)?.toISOString()).toBe("2027-01-31T10:00:00.000Z");
    expect(restoreExpiresAt({ restore_expiry_months: 3 }, now)?.toISOString()).toBe(
      "2026-05-01T10:00:00.000Z",
    );
    expect(restoreExpiresAt({ restore_expiry_months: "never" }, now)).toBeNull();
  });

  it("the API accepts each option and refuses a value out of range", () => {
    const ok = businessCreditConfigSchema.safeParse({
      trial_usage: "overdraft_only",
      no_subscription_usage: "as_subscriber",
      no_subscription_overdraft: "always",
      no_subscription_invoice_after_days: 90,
      restore_expiry_months: 120,
      auto_topup_on_hard_decline: "keep_enabled",
      capture_over_hold: "cap_at_hold",
    });
    expect(ok.success).toBe(true);
    for (const bad of [
      { trial_usage: "bill" },
      { no_subscription_invoice_after_days: 91 },
      { no_subscription_invoice_after_days: 1.5 },
      { restore_expiry_months: 0 },
      { restore_expiry_months: "forever" },
      { capture_over_hold: "refuse" },
    ])
      expect(businessCreditConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("a PATCH that omits a key keeps the stored value", () => {
    const stored = {
      trial_usage: "as_paid" as const,
      restore_expiry_months: "never" as const,
      capture_over_hold: "cap_at_hold" as const,
    };
    expect(keepInFlightApplies({ blocking_enabled: true }, stored)).toEqual({
      blocking_enabled: true,
      ...stored,
    });
    expect(keepInFlightApplies({ trial_usage: "refuse" }, stored)?.trial_usage).toBe("refuse");
  });
});

describe("usage event credits past the hold", () => {
  const part = (p: Partial<Parameters<typeof serializeCreditUsage>[0][number]>) => ({
    event_id: "e",
    meter: "render",
    unit: "credit",
    decimals: 0,
    part: 0,
    quantity: "3",
    credits_per_unit: "1.000000",
    cost_source: "meter" as const,
    units_due: "3",
    units_uncovered: "0",
    units: "1",
    source: "balance" as const,
    overage_basis: null,
    status: "taken" as const,
    reason: null,
    covered_by_hold: true,
    zero_reason: null,
    ...p,
  });
  it("a capped capture shows the rest in credits_past_hold, not in credits_taken", () => {
    const [v] = serializeCreditUsage([
      part({}),
      part({
        part: 1,
        units: "2",
        source: "overdraft",
        status: "forgiven",
        zero_reason: "hold_cap",
      }),
    ]);
    expect(v!.credits_taken).toBe("1");
    expect(v!.credits_past_hold).toBe("2");
    expect(v!.credits_overdrawn).toBe("0");
  });
  it("a written-off overshoot still counts as taken", () => {
    const [v] = serializeCreditUsage([
      part({}),
      part({
        part: 1,
        units: "2",
        source: "overdraft",
        status: "forgiven",
        zero_reason: "plan_reset",
      }),
    ]);
    expect(v!.credits_taken).toBe("3");
    expect(v!.credits_past_hold).toBe("0");
  });
});

describe("late usage invoice times", () => {
  it("unset: a 24-hour wait and one invoice a day", () => {
    const r = resolveBillingRulesConfig({ billingRulesConfig: { late_usage_invoices: {} } });
    expect(r.lateUsageInvoices.waitHours).toBe(24);
    expect(r.lateUsageInvoices.minIntervalHours).toBe(24);
  });
  it("reads values in range and ignores values out of range", () => {
    const set = resolveBillingRulesConfig({
      billingRulesConfig: { late_usage_invoices: { wait_hours: 2, min_interval_hours: 6 } },
    });
    expect([set.lateUsageInvoices.waitHours, set.lateUsageInvoices.minIntervalHours]).toEqual([
      2, 6,
    ]);
    const bad = resolveBillingRulesConfig({
      billingRulesConfig: { late_usage_invoices: { wait_hours: 0, min_interval_hours: 1000 } },
    });
    expect([bad.lateUsageInvoices.waitHours, bad.lateUsageInvoices.minIntervalHours]).toEqual([
      24, 24,
    ]);
  });
});

describe("dashboard defaults", () => {
  it("the credit settings screen preselects the resolved defaults", () => {
    const c = resolveCreditConfig(null);
    expect([
      c.trial_usage,
      c.no_subscription_usage,
      c.no_subscription_overdraft,
      c.no_subscription_invoice_after_days,
      c.restore_expiry_months,
      c.auto_topup_on_hard_decline,
      c.capture_over_hold,
    ]).toEqual(["refuse", "block", "needs_payment_method", 30, 12, "disable", "debt"]);
  });
  it("the late usage screen preselects 24 and 24", () => {
    const late = billingRules({ billing_rules_config: null } as never).late_usage_invoices;
    expect([late.wait_hours, late.min_interval_hours]).toEqual([24, 24]);
  });
});
