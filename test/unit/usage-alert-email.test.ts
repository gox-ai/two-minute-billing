import { describe, expect, it } from "vitest";
import { renderEmail } from "@/modules/emails/templates";
import { usageAlertMailVars } from "@/modules/usage-controls/mail";

const fmt = (d: Date) => d.toISOString().slice(0, 10);

describe("usage alert email", () => {
  it("states the alert once, as one sentence", () => {
    const vars = usageAlertMailVars(
      {
        usage_alert: { kind: "spend", currency: "INR", interval: "month" },
        threshold: { value: 40000, unit: "minor" },
        threshold_value: 40000,
        value: 41000,
      },
      fmt,
    );
    const out = renderEmail("usage_alert", {
      businessName: "Two Minute Billing",
      customerName: "Asha",
      ...vars,
    });
    expect(out.subject).toBe("Usage alert: Your spend this month reached ₹400.00");
    expect(out.text).toContain("Your spend this month reached ₹400.00. Your usage is now ₹410.00.");
    expect(out.text).not.toContain("You used Your");
  });
});
