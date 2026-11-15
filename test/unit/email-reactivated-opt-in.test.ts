import { describe, expect, it } from "vitest";
import {
  initialEmailConfig,
  isEmailTypeEnabled,
  resolveEmailConfig,
} from "@/modules/emails/config";

describe("subscription_reactivated email is opt-in", () => {
  it("is off for an existing business that never switched it on", () => {
    const cfg = resolveEmailConfig({ emailConfig: { enabled: true } });
    expect(isEmailTypeEnabled(cfg, "subscription_reactivated")).toBe(false);
    // Its neighbour is unaffected.
    expect(isEmailTypeEnabled(cfg, "subscription_activated")).toBe(true);
  });

  it("is on only when switched on, and only while email is enabled", () => {
    const on = { types: { subscription_reactivated: true } };
    expect(
      isEmailTypeEnabled(
        resolveEmailConfig({ emailConfig: { enabled: true, ...on } }),
        "subscription_reactivated",
      ),
    ).toBe(true);
    expect(
      isEmailTypeEnabled(resolveEmailConfig({ emailConfig: on }), "subscription_reactivated"),
    ).toBe(false);
  });

  it("starts on for a business a person creates, and leaves sending itself off", () => {
    const created = initialEmailConfig({ hasOperator: true });
    expect(created).toEqual({ types: { subscription_reactivated: true } });
    expect(resolveEmailConfig({ emailConfig: created }).enabled).toBe(false);
    expect(initialEmailConfig({ hasOperator: false })).toBeUndefined();
    expect(initialEmailConfig({})).toBeUndefined();
  });
});
