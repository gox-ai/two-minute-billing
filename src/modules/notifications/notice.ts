/**
 * One-time notice that team alerts stopped (job `notifications_team_alerts_notice`, enqueued
 * once by migration 0534). One email to each owner and admin of an organization where any
 * business had a team alert on with a recipient. A `done` queue row per (organization, user)
 * is the marker, so a re-run sends nothing twice.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { businesses, memberships, notificationQueue, users } from "@db/schema";
import { systemDb, withTenant } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { escapeHtml } from "@/modules/emails/sanitize";
import { sendMail } from "./channels";
import { baseUrl } from "./groups";
import { hadTeamAlertOn, resolveTeamAlertsConfig } from "./legacy-team-alerts";

const log = createLogger("notifications.notice");

export const TEAM_ALERTS_NOTICE_KIND = "team_alerts_notice";
export const teamAlertsNoticeKey = (organizationId: string, userId: string) =>
  `notice:${TEAM_ALERTS_NOTICE_KIND}:${organizationId}:${userId}`;

export interface NoticeResult {
  organizations: number;
  sent: number;
  skipped: number;
  failed: number;
}

/** Organizations with at least one business that had a team alert on. */
export async function organizationsWithTeamAlerts(): Promise<string[]> {
  const rows = await systemDb
    .select({ organizationId: businesses.organizationId, cfg: businesses.teamAlertsConfig })
    .from(businesses)
    .where(isNotNull(businesses.teamAlertsConfig));
  const out = new Set<string>();
  for (const r of rows)
    if (hadTeamAlertOn(resolveTeamAlertsConfig({ teamAlertsConfig: r.cfg })))
      out.add(r.organizationId);
  return [...out];
}

export function teamAlertsNoticeMail(stoppedOn: Date, base: string | null) {
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(stoppedOn);
  const subject = "Team alerts are now notifications";
  const intro =
    `Team alerts stopped on ${date}. Notifications replace them: each member selects the events ` +
    "they want, by push, email or in the app, and owners and admins can add Google Chat spaces " +
    "and outside email addresses.";
  const own = `${base ?? ""}/account/notifications`;
  const team = `${base ?? ""}/settings/notifications`;
  const link = (href: string, label: string) =>
    `<p style="font-size:14px;line-height:1.6;margin:0 0 8px">${escapeHtml(label)}: <a href="${escapeHtml(href)}">${escapeHtml(href)}</a></p>`;
  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#222">',
    `<h2 style="font-size:18px;margin:0 0 16px">${escapeHtml(subject)}</h2>`,
    `<p style="font-size:14px;line-height:1.6;margin:0 0 16px">${escapeHtml(intro)}</p>`,
    link(own, "Set up your notifications"),
    link(team, "Team notifications"),
    "</div>",
  ].join("");
  const text = [intro, `Set up your notifications: ${own}`, `Team notifications: ${team}`].join(
    "\n\n",
  );
  return { subject, html, text };
}

/**
 * Send the notice. A retryable mail failure frees its marker and the run throws at the end,
 * so the job retries only those recipients.
 */
export async function runTeamAlertsNotice(now = new Date()): Promise<NoticeResult> {
  const orgIds = await organizationsWithTeamAlerts();
  const mail = teamAlertsNoticeMail(now, baseUrl());
  const out: NoticeResult = { organizations: orgIds.length, sent: 0, skipped: 0, failed: 0 };
  let retry = 0;
  for (const organizationId of orgIds) {
    const people = await withTenant(organizationId, (tx) =>
      tx
        .selectDistinct({ userId: users.id, email: users.email })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            inArray(memberships.role, ["owner", "admin"]),
            isNotNull(memberships.acceptedAt),
          ),
        ),
    );
    for (const p of people) {
      const dedupeKey = teamAlertsNoticeKey(organizationId, p.userId);
      const claimed = await withTenant(organizationId, (tx) =>
        tx
          .insert(notificationQueue)
          .values({
            organizationId,
            dedupeKey,
            kinds: [TEAM_ALERTS_NOTICE_KIND],
            status: "done",
          })
          .onConflictDoNothing({ target: notificationQueue.dedupeKey })
          .returning({ id: notificationQueue.id }),
      );
      if (claimed.length === 0) {
        out.skipped++;
        continue;
      }
      const r = await sendMail({ to: p.email, ...mail, idempotencyKey: dedupeKey });
      if (r.kind === "sent") {
        out.sent++;
        continue;
      }
      out.failed++;
      log.warn("team alerts notice not sent", {
        event: "notifications_team_alerts_notice_failed",
        organizationId,
        user: p.userId,
        permanent: r.kind === "permanent",
      });
      if (r.kind === "retry") {
        retry++;
        await withTenant(organizationId, (tx) =>
          tx.delete(notificationQueue).where(eq(notificationQueue.dedupeKey, dedupeKey)),
        );
      } else {
        await withTenant(organizationId, (tx) =>
          tx
            .update(notificationQueue)
            .set({ status: "failed", lastError: ("error" in r ? r.error : r.reason).slice(0, 500) })
            .where(eq(notificationQueue.dedupeKey, dedupeKey)),
        );
      }
    }
  }
  if (retry > 0) throw new Error(`team alerts notice: ${retry} mail(s) to retry`);
  return out;
}
