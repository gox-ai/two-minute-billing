import { describe, expect, it } from "vitest";
import { changedBillingRules } from "../../dashboard/lib/billing-rules";

const current = {
  trial_end_action: "activate",
  plan_credits: { on_upgrade: "full", on_downgrade: "next_window" },
  required_reasons: { refund: false, void_invoice: true },
  upgrade_timing: "now",
};

describe("changedBillingRules", () => {
  it("drops a rule equal to the resolved value", () => {
    expect(
      changedBillingRules(
        { trial_end_action: "activate", plan_credits: { on_upgrade: "full" } },
        current,
      ),
    ).toEqual({});
  });

  it("keeps only the nested subkeys that moved", () => {
    expect(
      changedBillingRules(
        { plan_credits: { on_upgrade: "prorated", on_downgrade: "next_window" } },
        current,
      ),
    ).toEqual({ plan_credits: { on_upgrade: "prorated" } });
  });

  it("keeps a changed scalar and a changed boolean", () => {
    expect(
      changedBillingRules(
        { trial_end_action: "pause", required_reasons: { refund: true, void_invoice: true } },
        current,
      ),
    ).toEqual({ trial_end_action: "pause", required_reasons: { refund: true } });
  });

  it("passes the timing keys through: they decide pinning themselves", () => {
    expect(changedBillingRules({ upgrade_timing: "now" }, current)).toEqual({
      upgrade_timing: "now",
    });
  });

  it("keeps everything when the current rules are unknown", () => {
    expect(changedBillingRules({ trial_end_action: "activate" }, null)).toEqual({
      trial_end_action: "activate",
    });
  });
});
