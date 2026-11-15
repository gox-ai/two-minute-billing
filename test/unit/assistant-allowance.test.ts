import { describe, expect, it } from "vitest";
import { fixed12ToCents, monthKey, renewsAt, usedPercent } from "@/modules/assistant/allowance";
import { renderAssistantAllowanceEmail } from "@/modules/emails/templates";

describe("allowance arithmetic", () => {
  it("reads the stored cost (USD minor units × 10^12) as cents", () => {
    expect(fixed12ToCents("190000000000")).toBeCloseTo(0.19, 10);
    expect(fixed12ToCents(null)).toBe(0);
  });

  it("rounds the percent down, so 100% means all of it", () => {
    expect(usedPercent(59.99, 60)).toBe(99);
    expect(usedPercent(60, 60)).toBe(100);
    expect(usedPercent(0, 0)).toBe(0);
    expect(usedPercent(0.01, 0)).toBe(100);
  });

  it("renews on the first of next month, UTC, across a year end", () => {
    expect(renewsAt(new Date("2026-12-31T23:59:00Z")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
    expect(monthKey(new Date("2026-11-07T10:00:00Z"))).toBe("2026-11");
  });
});

describe("80% email", () => {
  const mail = renderAssistantAllowanceEmail(
    {
      name: "Rowan",
      organizationName: "Larkfield <Labs>",
      usedPercent: 84,
      renewsOn: "December 1",
      link: "https://app.example.com/settings/assistant",
    },
    { name: "Two Minute Billing", logoUrl: null, supportEmail: null },
  );

  it("says how much is used, when it renews and what to do", () => {
    expect(mail.subject).toBe("Larkfield <Labs>: you used 84% of this month's Billy use");
    expect(mail.text).toContain("renews on December 1");
    expect(mail.text).toContain("add your own model key");
    expect(mail.text).toContain("View Billy use: https://app.example.com/settings/assistant");
  });

  it("escapes the organization name in HTML", () => {
    expect(mail.html).toContain("Larkfield &lt;Labs&gt;");
    expect(mail.html).not.toContain("<Labs>");
  });

  it("never shows more than 100%", () => {
    const over = renderAssistantAllowanceEmail({
      organizationName: "Larkfield",
      usedPercent: 130,
      renewsOn: "December 1",
      link: null,
    });
    expect(over.subject).toContain("100%");
  });
});
