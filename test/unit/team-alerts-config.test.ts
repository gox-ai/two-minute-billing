import { describe, expect, it } from "vitest";
import {
  activeTeamAlertKinds,
  DEFAULT_TEAM_ALERTS,
  resolveTeamAlertsConfig,
} from "@/modules/team-alerts/config";
import { digestDay, overdueWindow, webhookWindow } from "@/modules/team-alerts/windows";

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

  it("an alert is active only with a recipient, and overdue only with a threshold", () => {
    const base = {
      overdue: { enabled: true, thresholds: {} },
      webhook_failures: { enabled: true },
      daily_digest: { enabled: true },
    };
    expect(
      activeTeamAlertKinds(
        resolveTeamAlertsConfig({ teamAlertsConfig: { ...base, recipients: [] } }),
      ),
    ).toEqual([]);
    expect(
      activeTeamAlertKinds(
        resolveTeamAlertsConfig({ teamAlertsConfig: { ...base, recipients: ["a@example.com"] } }),
      ),
    ).toEqual(["webhook_failures", "daily_digest"]);
  });
});

describe("alert windows", () => {
  const hour = new Date("2026-06-10T03:00:00Z");
  it("consecutive hours tile without a gap or an overlap", () => {
    const next = new Date(hour.getTime() + 3_600_000);
    expect(overdueWindow(hour).end).toEqual(overdueWindow(next).start);
    expect(webhookWindow(hour).end).toEqual(webhookWindow(next).start);
  });
  it("the digest fires in the 08:xx local hour and covers the day before", () => {
    expect(digestDay(hour, "Asia/Kolkata")?.day).toBe("2026-06-09");
    expect(digestDay(hour, "UTC")).toBeNull();
    expect(digestDay(new Date("2026-06-10T08:00:00Z"), "UTC")?.day).toBe("2026-06-09");
  });
});
