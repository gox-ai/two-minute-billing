/**
 * The hourly `team_alerts_hourly` cron: one `team_alert_send` job per (business, alert kind).
 *
 * Crosses organizations (it looks for every business that opted in), so it reads through
 * `systemDb`. Everything per business runs in `sendTeamAlert` under the tenant.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { businesses } from "@db/schema";
import { systemDb } from "@/platform/db";
import { activeTeamAlertKinds, resolveTeamAlertsConfig, type TeamAlertKind } from "./config";
import { alertHour, digestDay } from "./windows";

export interface PlannedAlert {
  organizationId: string;
  businessId: string;
  kind: TeamAlertKind;
  /** ISO top of the hour the run is for. */
  hour: string;
}

/** What should be sent for `at`'s hour. The digest only in each business's digest hour. */
export async function planTeamAlerts(
  at: Date,
  scope: { onlyBusinessId?: string; excludeBusinessIds?: string[] } = {},
): Promise<PlannedAlert[]> {
  const hour = alertHour(at);
  const rows = await systemDb
    .select({
      id: businesses.id,
      organizationId: businesses.organizationId,
      timezone: businesses.timezone,
      teamAlertsConfig: businesses.teamAlertsConfig,
    })
    .from(businesses)
    // Live only: a test business's alerts would reach real staff as unmarked mail.
    .where(and(isNotNull(businesses.teamAlertsConfig), eq(businesses.livemode, "live")));
  const exclude = new Set(scope.excludeBusinessIds ?? []);
  const out: PlannedAlert[] = [];
  for (const b of rows) {
    if (scope.onlyBusinessId && b.id !== scope.onlyBusinessId) continue;
    if (exclude.has(b.id)) continue;
    for (const kind of activeTeamAlertKinds(resolveTeamAlertsConfig(b))) {
      if (kind === "daily_digest" && !digestDay(hour, b.timezone ?? "UTC")) continue;
      out.push({
        organizationId: b.organizationId,
        businessId: b.id,
        kind,
        hour: hour.toISOString(),
      });
    }
  }
  return out;
}

/**
 * Plan and enqueue. The job key makes a second fan-out for the same hour coalesce into the
 * pending job rather than queue a second mail.
 */
export async function runTeamAlertsFanout(
  at: Date,
  enqueue: (
    task: string,
    payload: unknown,
    spec: { jobKey: string; maxAttempts: number },
  ) => Promise<void>,
  scope: { onlyBusinessId?: string; excludeBusinessIds?: string[] } = {},
): Promise<{ enqueued: number }> {
  const plan = await planTeamAlerts(at, scope);
  for (const p of plan)
    await enqueue("team_alert_send", p, {
      jobKey: `team_alert:${p.kind}:${p.businessId}:${p.hour}`,
      maxAttempts: 6,
    });
  return { enqueued: plan.length };
}
