import { describe, expect, it } from "vitest";
import type { AccountBrand } from "@/modules/emails/account-brand";
import {
  renderAccountSecurityEmail,
  renderInviteEmail,
  renderPasswordResetEmail,
  renderSignupConfirmEmail,
} from "@/modules/emails/templates";

const cloud: AccountBrand = {
  name: "Two Minute Billing",
  logoUrl: "https://dash.example.com/brand/email-logo.png",
  supportEmail: "help@example.com",
};
const selfHosted: AccountBrand = { name: "Northwind Billing", logoUrl: null, supportEmail: null };

describe("account email layout", () => {
  it("signs with the cloud logo, name and support address", () => {
    const m = renderPasswordResetEmail(
      { name: "Priya", link: "https://x.example.com/r", ttlMinutes: 30 },
      cloud,
    );
    expect(m.subject).toBe("Reset your Two Minute Billing password");
    expect(m.html).toContain('src="https://dash.example.com/brand/email-logo.png"');
    expect(m.html).toContain("mailto:help@example.com");
    expect(m.text).toContain("Help: help@example.com");
  });

  it("a self-hosted deployment signs with its own name and no logo of ours", () => {
    const m = renderSignupConfirmEmail(
      { link: "https://x.example.com/c", ttlHours: 24 },
      selfHosted,
    );
    expect(m.subject).toBe("Confirm your email address for Northwind Billing");
    expect(m.html).not.toContain("<img");
    expect(m.html).not.toContain("Two Minute Billing");
    expect(m.html).not.toContain("Help:");
  });

  it("shows the raw link under a link button, for clients that block buttons", () => {
    const m = renderSignupConfirmEmail(
      { link: "https://x.example.com/c?t=1&u=2", ttlHours: 24 },
      cloud,
    );
    expect(m.html).toContain("If the button does not work");
    expect(m.html).toContain("https://x.example.com/c?t=1&amp;u=2");
  });

  it("names the inviter, escaped", () => {
    const m = renderInviteEmail(
      {
        name: "Priya",
        organizationName: "Muselane",
        link: "https://x.example.com/i",
        ttlHours: 72,
        inviter: { name: "Asha <b>Rao</b>", email: "asha@example.com" },
      },
      cloud,
    );
    expect(m.subject).toBe("Asha <b>Rao</b> added you to Muselane on Two Minute Billing");
    expect(m.text).toContain("Asha <b>Rao</b> (asha@example.com) added you to Muselane");
    expect(m.html).toContain("Asha &lt;b&gt;Rao&lt;/b&gt;");
    expect(m.html).not.toContain("<b>Rao</b>");
  });

  it("an invite with no person behind it says Someone", () => {
    const m = renderInviteEmail(
      { organizationName: "Muselane", link: "https://x.example.com/i", ttlHours: 72 },
      cloud,
    );
    expect(m.subject).toBe("You are now a member of Muselane on Two Minute Billing");
    expect(m.text).toContain("Someone added you to Muselane");
  });

  it("an alert that needs action gets the red bar; a routine notice does not", () => {
    const base = {
      email: "p@example.com",
      at: new Date("2026-11-05T07:36:00Z"),
      accountLink: "https://x.example.com/a",
    };
    const alert = renderAccountSecurityEmail(
      { ...base, kind: "mfa_failed_attempts", firstFactor: "password" },
      cloud,
    );
    const routine = renderAccountSecurityEmail({ ...base, kind: "two_factor_enabled" }, cloud);
    expect(alert.html).toContain("#D92D20");
    expect(alert.html).toContain("Change your password");
    expect(routine.html).not.toContain("#D92D20");
    expect(routine.html).toContain("Review your security settings");
    // The "did you not do this?" line survives in both formats, once.
    expect(routine.text.match(/Did you not do this\?/g)).toHaveLength(1);
    expect(routine.html).toContain("<b>Did you not do this?</b>");
  });
});
