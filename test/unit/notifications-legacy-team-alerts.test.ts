import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEAM_ALERTS,
  hadTeamAlertOn,
  resolveTeamAlertsConfig,
} from "@/modules/notifications/legacy-team-alerts";
import { teamAlertsNoticeMail } from "@/modules/notifications/notice";

describe("resolveTeamAlertsConfig", () => {
  it("null, absent and malformed resolve to everything off", () => {
    for (const v of [null, undefined, "x", 3, [], { recipients: "a@example.com" }])
      expect(resolveTeamAlertsConfig({ teamAlertsConfig: v })).toEqual(DEFAULT_TEAM_ALERTS);
  });

  it("keeps valid recipients, lowercased, deduped, capped at 10", () => {
    const many = Array.from({ length: 14 }, (_, i) => `u${i}@example.com`);
    const r = resolveTeamAlertsConfig({
      teamAlertsConfig: { recipients: ["A@Example.com", "a@example.com", "bad", 7, ...many] },
    });
    expect(r.recipients[0]).toBe("a@example.com");
    expect(r.recipients).toHaveLength(10);
    expect(r.recipients).not.toContain("bad");
  });

  it("drops malformed thresholds and reads only a literal true as on", () => {
    const r = resolveTeamAlertsConfig({
      teamAlertsConfig: {
        recipients: ["a@example.com"],
        overdue: { enabled: "true", thresholds: { USD: 100, usd: 5, EUR: -1, GBP: 1.5 } },
        webhook_failures: { enabled: true },
        daily_digest: { enabled: 1 },
      },
    });
    expect(r.overdue).toEqual({ enabled: false, thresholds: { USD: 100 } });
    expect(r.webhookFailures.enabled).toBe(true);
    expect(r.dailyDigest.enabled).toBe(false);
  });
});

describe("hadTeamAlertOn (the one-time notice)", () => {
  const on = (cfg: unknown) => hadTeamAlertOn(resolveTeamAlertsConfig({ teamAlertsConfig: cfg }));
  it("needs an alert on and a recipient", () => {
    expect(on({ recipients: [], large_grants: { enabled: true } })).toBe(false);
    expect(on({ recipients: ["a@example.com"] })).toBe(false);
    for (const k of ["overdue", "webhook_failures", "daily_digest", "large_grants"])
      expect(on({ recipients: ["a@example.com"], [k]: { enabled: true } })).toBe(true);
  });
});

describe("teamAlertsNoticeMail", () => {
  it("names the stop date and links both settings pages", () => {
    const m = teamAlertsNoticeMail(new Date("2026-11-16T10:00:00Z"), "https://app.example.com");
    expect(m.subject).toBe("Team alerts are now notifications");
    expect(m.text).toContain("Team alerts stopped on November 16, 2026.");
    expect(m.text).toContain(
      "Set up your notifications: https://app.example.com/account/notifications",
    );
    expect(m.text).toContain("Team notifications: https://app.example.com/settings/notifications");
  });
});
