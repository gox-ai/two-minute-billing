/**
 * The delivery drain (`notification_delivery_nudge`, queue `egress_notifications`): one send per
 * pending `notification_deliveries` row. Claim with a lease, fair share per business, bounded
 * concurrency. Backoff 1, 5, 30 minutes, 2 hours; the fifth failure is final. Held pushes whose
 * quiet hours ended are released first, one push per device.
 */
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { notificationDeliveries, notificationDestinations, pushSubscriptions } from "@db/schema";
import { systemDb, withTenant } from "@/platform/db";
import { config } from "@/platform/config";
import { scanBusinessFilterNullable } from "@/platform/clock";
import { runBounded } from "@/platform/concurrency";
import { createLogger } from "@/platform/logger";
import { decryptSecret } from "@/platform/secrets";
import { escapeHtml } from "@/modules/emails/sanitize";
import { pushConfigured, sendChat, sendMail, sendPush, type SendOutcome } from "./channels";
import { backoffMs, MAX_ATTEMPTS } from "./fanout";
import type { DeliveryPayload } from "./groups";
import { baseUrl } from "./groups";
import { collapsedPush } from "./quiet";
import { ownerAndAdminEmails } from "./recipients";
import { unreadCount } from "./service";

const log = createLogger("notifications.deliver");

/** Five failed sends in a row and a Google Chat space is "not working". */
export const CHAT_FAILURE_LIMIT = 5;
const LEASE_MS = 2 * 60_000;

type Delivery = typeof notificationDeliveries.$inferSelect;

export interface DeliverResult {
  released: number;
  attempted: number;
  sent: number;
  skipped: number;
  retried: number;
  failed: number;
  capped?: boolean;
}

export async function deliverPendingNotifications(now = new Date()): Promise<DeliverResult> {
  const out: DeliverResult = {
    released: 0,
    attempted: 0,
    sent: 0,
    skipped: 0,
    retried: 0,
    failed: 0,
  };
  out.released = await releaseHeld(now);

  const ranked = systemDb
    .select({
      id: notificationDeliveries.id,
      nextAttemptAt: notificationDeliveries.nextAttemptAt,
      rn: sql<number>`row_number() over (
        partition by ${notificationDeliveries.businessId}
        order by ${notificationDeliveries.nextAttemptAt}, ${notificationDeliveries.id}
      )`.as("rn"),
    })
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.status, "pending"),
        lte(notificationDeliveries.nextAttemptAt, now),
        scanBusinessFilterNullable(notificationDeliveries.businessId),
      ),
    )
    .as("ranked");
  const picked = await systemDb
    .select({ id: ranked.id })
    .from(ranked)
    .where(lte(ranked.rn, config.TICK_FAIR_SHARE_PER_BUSINESS))
    .orderBy(ranked.nextAttemptAt)
    .limit(config.TICK_SCAN_LIMIT);
  if (picked.length === 0) return out;
  const capped = picked.length >= config.TICK_SCAN_LIMIT;

  const ids = `{${picked.map((p) => p.id).join(",")}}`;
  const lease = new Date(now.getTime() + LEASE_MS).toISOString();
  const leased = (await systemDb.execute(sql`
    update notification_deliveries set next_attempt_at = ${lease}::timestamptz
    where id in (select id from notification_deliveries
                 where id = any(${ids}::uuid[]) and status = 'pending'
                   and next_attempt_at <= ${now.toISOString()}::timestamptz
                 for update skip locked)
    returning id`)) as unknown as Array<{ id: string }>;
  if (leased.length === 0) return out;
  const claimed = await systemDb
    .select()
    .from(notificationDeliveries)
    .where(
      inArray(
        notificationDeliveries.id,
        leased.map((r) => r.id),
      ),
    )
    .orderBy(notificationDeliveries.nextAttemptAt);

  const deadline = Date.now() + config.TICK_PASS_BUDGET_MS;
  const run = await runBounded(
    claimed,
    config.TICK_EGRESS_CONCURRENCY,
    async (d) => {
      out.attempted++;
      const outcome = await sendOne(d, now);
      const status = await settle(d, outcome, now);
      out[status]++;
    },
    { deadline },
  );
  if (run.unstarted.length > 0) {
    const back = `{${run.unstarted.map((d) => d.id).join(",")}}`;
    await systemDb.execute(sql`
      update notification_deliveries set next_attempt_at = ${now.toISOString()}::timestamptz
      where id = any(${back}::uuid[]) and status = 'pending'`);
  }
  for (const s of run.settled)
    if (!s.ok) {
      out.failed++;
      log.error(s.error, { event: "notification_delivery_pass_failed", delivery: s.item.id });
    }
  if (capped || run.unstarted.length > 0) out.capped = true;
  return out;
}

/** One send for one row. Never throws for a send that failed; only for a database error. */
export async function sendOne(d: Delivery, now: Date): Promise<SendOutcome> {
  const p = d.payload as unknown as DeliveryPayload;
  switch (d.channel) {
    case "push": {
      if (!pushConfigured()) return { kind: "skipped", reason: "push_not_configured" };
      if (!d.pushSubscriptionId || !p.push) return { kind: "skipped", reason: "subscription_gone" };
      const [sub] = await systemDb
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.id, d.pushSubscriptionId))
        .limit(1);
      // The device moved to another person, or was removed.
      if (!sub || sub.userId !== d.userId) return { kind: "skipped", reason: "subscription_gone" };
      const badge = d.userId ? (await unreadCount(d.organizationId, d.userId)).count : undefined;
      const outcome = await sendPush(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        { ...p.push, ...(badge !== undefined ? { badge_count: badge } : {}) },
        p.tone === "destructive" ? "high" : "normal",
      );
      await recordPushResult(sub.id, outcome, now);
      return outcome;
    }
    case "email": {
      if (!p.mail?.to) return { kind: "permanent", error: "no address" };
      return sendMail({
        to: p.mail.to,
        subject: p.mail.subject,
        html: p.mail.html,
        text: p.mail.text,
        idempotencyKey: `notification:${d.dedupeKey}`,
      });
    }
    case "chat": {
      const dest = await destination(d.destinationId);
      if (!dest || dest.status !== "active" || !dest.urlEnc)
        return { kind: "skipped", reason: "destination_inactive" };
      let url: string;
      try {
        url = decryptSecret(dest.urlEnc);
      } catch {
        return { kind: "permanent", error: "could not decrypt the webhook URL" };
      }
      const outcome = await sendChat(url, p.chat);
      await recordChatResult(dest, outcome, now);
      return outcome;
    }
    case "outside_email": {
      const dest = await destination(d.destinationId);
      if (!dest || dest.status !== "active" || !dest.email || !p.mail)
        return { kind: "skipped", reason: "destination_inactive" };
      return sendMail({
        to: dest.email,
        subject: p.mail.subject,
        html: p.mail.html,
        text: p.mail.text,
        idempotencyKey: `notification:${d.dedupeKey}`,
      });
    }
    default:
      return { kind: "permanent", error: `unknown channel ${d.channel}` };
  }
}

async function destination(id: string | null) {
  if (!id) return null;
  const [dest] = await systemDb
    .select()
    .from(notificationDestinations)
    .where(eq(notificationDestinations.id, id))
    .limit(1);
  return dest ?? null;
}

async function settle(
  d: Delivery,
  o: SendOutcome,
  now: Date,
): Promise<"sent" | "skipped" | "retried" | "failed"> {
  const attempts = d.attempts + 1;
  const set = (v: Partial<typeof notificationDeliveries.$inferInsert>) =>
    systemDb.update(notificationDeliveries).set(v).where(eq(notificationDeliveries.id, d.id));
  switch (o.kind) {
    case "sent":
      await set({ status: "sent", attempts, sentAt: now, lastError: null });
      return "sent";
    case "skipped":
      await set({ status: "skipped", attempts, lastError: o.reason });
      return "skipped";
    case "permanent":
      await set({ status: "failed", attempts, lastError: o.error.slice(0, 500) });
      return "failed";
    case "retry": {
      const final = attempts >= MAX_ATTEMPTS;
      await set({
        status: final ? "failed" : "pending",
        attempts,
        lastError: o.error.slice(0, 500),
        nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
      });
      return final ? "failed" : "retried";
    }
  }
}

/** 404/410 deletes the device; other results update its health. */
export async function recordPushResult(subscriptionId: string, o: SendOutcome, now: Date) {
  if (o.kind === "sent")
    await systemDb
      .update(pushSubscriptions)
      .set({ lastSuccessAt: now, failureCount: 0 })
      .where(eq(pushSubscriptions.id, subscriptionId));
  else if (o.kind === "skipped" && o.gone)
    await systemDb.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscriptionId));
  else if (o.kind === "permanent" || o.kind === "retry")
    await systemDb
      .update(pushSubscriptions)
      .set({ lastFailureAt: now, failureCount: sql`${pushSubscriptions.failureCount} + 1` })
      .where(eq(pushSubscriptions.id, subscriptionId));
}

type Dest = typeof notificationDestinations.$inferSelect;

/**
 * A success resets the streak. A failure adds one; the fifth in a row marks the space
 * `not_working` and tells the owners and admins, once.
 */
export async function recordChatResult(dest: Dest, o: SendOutcome, now: Date): Promise<void> {
  if (o.kind === "sent") {
    if (dest.failureStreak > 0 || dest.lastError)
      await systemDb
        .update(notificationDestinations)
        .set({ failureStreak: 0, lastError: null })
        .where(eq(notificationDestinations.id, dest.id));
    return;
  }
  if (o.kind === "skipped") return;
  const [r] = await systemDb
    .update(notificationDestinations)
    .set({
      failureStreak: sql`${notificationDestinations.failureStreak} + 1`,
      lastError: o.error.slice(0, 500),
      status: sql`case when ${notificationDestinations.failureStreak} + 1 >= ${CHAT_FAILURE_LIMIT}
        and ${notificationDestinations.status} = 'active' then 'not_working'
        else ${notificationDestinations.status} end`,
      updatedAt: now,
    })
    .where(eq(notificationDestinations.id, dest.id))
    .returning({
      streak: notificationDestinations.failureStreak,
      status: notificationDestinations.status,
    });
  if (r?.streak === CHAT_FAILURE_LIMIT && r.status === "not_working")
    await tellNotWorking(dest, now);
}

async function tellNotWorking(dest: Dest, now: Date): Promise<void> {
  const to = await withTenant(dest.organizationId, (tx) =>
    ownerAndAdminEmails(tx, dest.organizationId),
  );
  const subject = `We could not send to the Google Chat space ${dest.name}`;
  const intro = `We could not send to the Google Chat space ${dest.name}. Change its webhook URL in Team notifications.`;
  const base = baseUrl();
  const link = base ? `${base}/settings/notifications` : null;
  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#222">',
    `<h2 style="font-size:18px;margin:0 0 16px">${escapeHtml(subject)}</h2>`,
    `<p style="font-size:14px;line-height:1.6;margin:0 0 12px">${escapeHtml(intro)}</p>`,
    dest.lastError
      ? `<p style="font-size:13px;color:#666;margin:0 0 12px">Last error: ${escapeHtml(dest.lastError)}</p>`
      : "",
    link
      ? `<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">View team notifications</a></p>`
      : "",
    "</div>",
  ].join("");
  const text = [intro, link ? `View team notifications: ${link}` : null]
    .filter(Boolean)
    .join("\n\n");
  for (const email of to) {
    const r = await sendMail({
      to: email,
      subject,
      html,
      text,
      idempotencyKey: `notification_destination_not_working:${dest.id}:${now.toISOString().slice(0, 10)}`,
    });
    if (r.kind !== "sent")
      log.warn("not-working notice not sent", {
        event: "notification_not_working_notice_failed",
        destination: dest.id,
      });
  }
}

/**
 * Held pushes whose quiet hours ended. One held push for a device goes out as it is; more than
 * one become a single push ("While quiet hours were on: …") and the rest are skipped.
 */
export async function releaseHeld(now: Date): Promise<number> {
  const due = await systemDb
    .select()
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.status, "held"),
        lte(notificationDeliveries.nextAttemptAt, now),
        scanBusinessFilterNullable(notificationDeliveries.businessId),
      ),
    )
    .limit(5000);
  const byDevice = new Map<string, Delivery[]>();
  for (const d of due) {
    const k = `${d.userId}|${d.pushSubscriptionId}`;
    byDevice.set(k, [...(byDevice.get(k) ?? []), d]);
  }
  let released = 0;
  for (const rows of byDevice.values()) {
    if (rows.length === 1) {
      await systemDb
        .update(notificationDeliveries)
        .set({ status: "pending", nextAttemptAt: now })
        .where(
          and(
            eq(notificationDeliveries.id, rows[0]!.id),
            eq(notificationDeliveries.status, "held"),
          ),
        );
      released++;
      continue;
    }
    const first = rows[0]!;
    const push = collapsedPush(
      rows.map((r) => ({
        kind: r.kind,
        count: (r.payload as unknown as DeliveryPayload).count ?? 1,
      })),
    );
    const payload: DeliveryPayload = {
      facts: {},
      opts: { timezone: "UTC" },
      count: rows.reduce((s, r) => s + ((r.payload as unknown as DeliveryPayload).count ?? 1), 0),
      tone: push.destructive ? "destructive" : "neutral",
      push: { title: push.title, body: push.body, url: push.url, tag: push.tag, renotify: true },
    };
    await systemDb.transaction(async (tx) => {
      const ids = rows.map((r) => r.id);
      const taken = await tx
        .update(notificationDeliveries)
        .set({ status: "skipped", lastError: "collapsed_after_quiet_hours" })
        .where(
          and(inArray(notificationDeliveries.id, ids), eq(notificationDeliveries.status, "held")),
        )
        .returning({ id: notificationDeliveries.id });
      if (taken.length === 0) return;
      await tx
        .insert(notificationDeliveries)
        .values({
          organizationId: first.organizationId,
          businessId: null,
          channel: "push",
          userId: first.userId,
          pushSubscriptionId: first.pushSubscriptionId,
          kind: first.kind,
          payload: payload as unknown as Record<string, unknown>,
          nextAttemptAt: now,
          dedupeKey: `quiet:${first.pushSubscriptionId}:${taken.map((t) => t.id).sort()[0]}`,
        })
        .onConflictDoNothing({ target: notificationDeliveries.dedupeKey });
    });
    released++;
  }
  return released;
}
