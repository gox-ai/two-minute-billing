/**
 * Fan-out: turn each pending `notification_queue` row into bell rows, summary items and
 * deliveries. Claim with a lease (`for update skip locked`), fair share per business, five
 * attempts with backoff. One tenant transaction per row: the row is marked done in it, so a
 * failure leaves nothing half-written, and every delivery's `dedupe_key` makes a retry safe.
 * A clock row can carry `payload.items` (one clock run, one kind and business): a recipient
 * gets the items that pass their settings as one message, a list when more than one passes.
 */
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { events, notificationDeliveries, notificationQueue, notifications } from "@db/schema";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { config } from "@/platform/config";
import { scanBusinessFilter } from "@/platform/clock";
import { publicId } from "@/platform/ids";
import { createLogger } from "@/platform/logger";
import { isNotificationKind, kindDef, type NotificationKind } from "./catalogue";
import { loadFacts, passesDerivedCheck, type FactsBundle, type NotificationPayload } from "./facts";
import {
  pickKindsForRecipient,
  resolveDestination,
  resolvePreference,
  type Resolution,
} from "./resolve";
import { renderItems, renderNotification, type Facts, type RenderOptions } from "./text";
import { settingsForUsers } from "./service";
import {
  activeDestinations,
  liveBusinesses,
  loadMembers,
  pushSubscriptionsOf,
  seesSeveral,
  type Destination,
  type Member,
  type PushSub,
} from "./recipients";
import {
  baseUrl,
  groupKey,
  groupsBursts,
  joinOpenGroup,
  openGroup,
  sumTotals,
  type DeliveryPayload,
} from "./groups";

const log = createLogger("notifications.fanout");

export const MAX_ATTEMPTS = 5;
const BACKOFF_S = [60, 300, 1800, 7200];
export const backoffMs = (attempts: number) =>
  (BACKOFF_S[Math.min(attempts, BACKOFF_S.length) - 1] ?? 60) * 1000;
const LEASE_MS = 2 * 60_000;

type QueueRow = typeof notificationQueue.$inferSelect;

export interface FanoutResult {
  claimed: number;
  done: number;
  retried: number;
  failed: number;
  notifications: number;
  deliveries: number;
}

export async function fanOutPending(now = new Date()): Promise<FanoutResult> {
  const ranked = systemDb
    .select({
      id: notificationQueue.id,
      nextAttemptAt: notificationQueue.nextAttemptAt,
      rn: sql<number>`row_number() over (
        partition by ${notificationQueue.businessId}
        order by ${notificationQueue.nextAttemptAt}, ${notificationQueue.id}
      )`.as("rn"),
    })
    .from(notificationQueue)
    .where(
      and(
        eq(notificationQueue.status, "pending"),
        lte(notificationQueue.nextAttemptAt, now),
        scanBusinessFilter(notificationQueue.businessId),
      ),
    )
    .as("ranked");
  const picked = await systemDb
    .select({ id: ranked.id })
    .from(ranked)
    .where(lte(ranked.rn, config.TICK_FAIR_SHARE_PER_BUSINESS))
    .orderBy(ranked.nextAttemptAt)
    .limit(config.TICK_SCAN_LIMIT);
  const out: FanoutResult = {
    claimed: 0,
    done: 0,
    retried: 0,
    failed: 0,
    notifications: 0,
    deliveries: 0,
  };
  if (picked.length === 0) return out;

  const ids = `{${picked.map((p) => p.id).join(",")}}`;
  const lease = new Date(now.getTime() + LEASE_MS).toISOString();
  const leased = (await systemDb.execute(sql`
    update notification_queue set next_attempt_at = ${lease}::timestamptz
    where id in (select id from notification_queue
                 where id = any(${ids}::uuid[]) and status = 'pending'
                   and next_attempt_at <= ${now.toISOString()}::timestamptz
                 for update skip locked)
    returning id`)) as unknown as Array<{ id: string }>;
  if (leased.length === 0) return out;
  const rows = await systemDb
    .select()
    .from(notificationQueue)
    .where(
      inArray(
        notificationQueue.id,
        leased.map((r) => r.id),
      ),
    )
    .orderBy(notificationQueue.createdAt);
  out.claimed = rows.length;

  for (const row of rows) {
    try {
      const r = await withTenant(row.organizationId, (tx) => fanOutRow(tx, row, now));
      out.done++;
      out.notifications += r.notifications;
      out.deliveries += r.deliveries;
    } catch (e) {
      const attempts = row.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      await systemDb
        .update(notificationQueue)
        .set({
          attempts,
          status: failed ? "failed" : "pending",
          lastError: ((e as Error)?.message ?? String(e)).slice(0, 500),
          nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
        })
        .where(eq(notificationQueue.id, row.id));
      if (failed) out.failed++;
      else out.retried++;
      log.warn("notification fan-out failed", {
        event: "notification_fanout_failed",
        queueId: row.id,
        attempts,
        error: (e as Error)?.message,
      });
    }
  }
  return out;
}

interface Ctx {
  tx: Tx;
  row: QueueRow;
  now: Date;
  /** Per kind, one bundle per item: one for an event, several for a clock run's list. */
  bundles: Map<NotificationKind, FactsBundle[]>;
  eventId: string | null;
  base: string | null;
  counts: { notifications: number; deliveries: number };
}

/** One queue row, inside its organization's transaction. Marks the row done. */
export async function fanOutRow(
  tx: Tx,
  row: QueueRow,
  now: Date,
): Promise<{ notifications: number; deliveries: number }> {
  const counts = { notifications: 0, deliveries: 0 };
  const finish = async () => {
    await tx
      .update(notificationQueue)
      .set({ status: "done", attempts: row.attempts + 1, lastError: null })
      .where(eq(notificationQueue.id, row.id));
    return counts;
  };
  if (!row.businessId) return finish();
  const event = row.eventId
    ? ((await tx.select().from(events).where(eq(events.id, row.eventId)).limit(1))[0] ?? null)
    : null;
  if (row.eventId && !event) return finish();
  const payload = row.payload as NotificationPayload;
  const source = event?.source ?? payload.source ?? null;

  const bundles = new Map<NotificationKind, FactsBundle[]>();
  const items = payload.items?.length ? payload.items : [payload];
  for (const k of row.kinds) {
    if (!isNotificationKind(k)) continue;
    const list: FactsBundle[] = [];
    for (const item of items) {
      const b = await loadFacts(tx, {
        organizationId: row.organizationId,
        businessId: row.businessId,
        kind: k,
        event,
        payload: item,
      });
      if (b && (await passesDerivedCheck(tx, k, b, source))) list.push(b);
    }
    if (list.length) bundles.set(k, list);
  }
  // One "gateway needs attention" per gateway per hour: a done marker row is the ledger.
  const gw = bundles.get("gateway_attention")?.[0];
  if (gw) {
    const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000).toISOString();
    const marker = await tx
      .insert(notificationQueue)
      .values({
        organizationId: row.organizationId,
        businessId: row.businessId,
        dedupeKey: `gateway_attention:${row.businessId}:${gw.facts.record?.id ?? "gateway"}:${hour}`,
        kinds: ["gateway_attention"],
        status: "done",
      })
      .onConflictDoNothing({ target: notificationQueue.dedupeKey })
      .returning({ id: notificationQueue.id });
    if (marker.length === 0) bundles.delete("gateway_attention");
  }
  if (bundles.size === 0) return finish();

  const ctx: Ctx = { tx, row, now, bundles, eventId: event?.id ?? null, base: baseUrl(), counts };
  const kinds = [...bundles.keys()];
  const biz = bundles.get(kinds[0]!)![0]!.business;
  const live = await liveBusinesses(tx, row.organizationId);

  const members = await loadMembers(tx, row.organizationId);
  if (members.length) {
    const settings = await settingsForUsers(members.map((m) => m.userId));
    const subs = await pushSubscriptionsOf(
      tx,
      members.map((m) => m.userId),
    );
    for (const m of members) {
      const s = settings.get(m.userId)!;
      const exceptions = m.exceptions.get(biz.id);
      const res = new Map<NotificationKind, Resolution>();
      const passing = new Map<NotificationKind, FactsBundle[]>();
      for (const k of kinds)
        for (const b of bundles.get(k)!) {
          const f = b.facts;
          const r = resolvePreference({
            defaultRow: { kinds: m.defaultKinds },
            businessRow: exceptions ? { kinds: exceptions } : null,
            filter: m.filter,
            businessId: biz.id,
            kind: k,
            permissions: m.permissions,
            role: m.memberRole,
            amountMinor: f.amountMinor,
            currency: f.currency,
            test: biz.test,
            quiet: s.quiet,
            now,
            timezone: s.timezone,
            isDispute: kindDef(k).group === "Disputes",
          });
          if (r.timing === "off") continue;
          if (!res.has(k)) res.set(k, r);
          passing.set(k, [...(passing.get(k) ?? []), b]);
        }
      for (const k of pickKindsForRecipient(kinds, new Set(res.keys())))
        await toMember(ctx, m, k, res.get(k)!, passing.get(k)!, {
          showBusiness: seesSeveral(m.filter, live),
          exceptionBusinessName: exceptions?.[k] ? biz.name : null,
          subs: subs.get(m.userId) ?? [],
        });
    }
  }

  if (!biz.test) {
    const several = live.length > 1;
    for (const d of await activeDestinations(tx, row.organizationId)) {
      const on = new Map<NotificationKind, FactsBundle[]>();
      for (const k of kinds)
        for (const b of bundles.get(k)!) {
          const r = resolveDestination({
            dest: d,
            kind: k,
            amountMinor: b.facts.amountMinor,
            currency: b.facts.currency,
            businessId: biz.id,
            test: biz.test,
          });
          if (r.send) on.set(k, [...(on.get(k) ?? []), b]);
        }
      for (const k of pickKindsForRecipient(kinds, new Set(on.keys())))
        await toDestination(ctx, d, k, on.get(k)!, several);
    }
  }
  return finish();
}

/** One message for a recipient: the single event, or a list when a clock run passed several. */
function renderFor(
  ctx: Ctx,
  kind: NotificationKind,
  items: FactsBundle[],
  opts: DeliveryPayload["opts"],
  tag: string | null,
) {
  const facts = items.map((b) => b.facts);
  const r = renderItems(
    kind,
    facts,
    { ...opts, baseUrl: ctx.base, tag, now: ctx.now },
    { count: facts.length, totals: sumTotals(facts) },
  );
  return { r, list: facts.length > 1 ? facts : null };
}

async function toMember(
  ctx: Ctx,
  m: Member,
  kind: NotificationKind,
  res: Resolution,
  items: FactsBundle[],
  o: { showBusiness: boolean; exceptionBusinessName: string | null; subs: PushSub[] },
): Promise<void> {
  const { tx, row, now } = ctx;
  const biz = items[0]!.business;
  const def = kindDef(kind);
  const opts: DeliveryPayload["opts"] = {
    timezone: biz.timezone,
    showBusiness: o.showBusiness,
    audience: "member",
    exceptionBusinessName: o.exceptionBusinessName,
  };
  const facts = items[0]!.facts;
  const rowBase = (f: Facts | null) => ({
    publicId: publicId("ntf"),
    organizationId: row.organizationId,
    businessId: biz.id,
    userId: m.userId,
    kind,
    tone: def.tone,
    record: f?.record ?? null,
    amountMinor: f?.amountMinor ?? null,
    currency: f?.currency ?? null,
    eventId: ctx.eventId,
    test: biz.test,
  });

  if (res.timing === "summary") {
    for (const b of items) {
      const r = renderNotification(kind, b.facts, { ...opts, baseUrl: ctx.base, now });
      await tx.insert(notifications).values({
        ...rowBase(b.facts),
        timing: "summary",
        title: r.title,
        body: r.body,
        url: r.url,
        facts: { ...b.facts, _opts: opts },
      });
      ctx.counts.notifications++;
    }
    return;
  }

  const key = groupKey(`u:${m.userId}`, biz.id, kind);
  const bursts = items.length === 1 && groupsBursts(kind);
  if (bursts && (await joinOpenGroup(tx, key, facts, now))) return;
  const { r, list } = renderFor(ctx, kind, items, opts, bursts ? key : null);
  const [n] = await tx
    .insert(notifications)
    .values({
      ...rowBase(list ? null : facts),
      timing: "instant",
      title: r.title,
      body: r.body,
      url: r.url,
      facts: list ? { _opts: opts, _items: list } : { ...facts, _opts: opts },
      groupKey: key,
      ...(list ? { groupCount: list.length, groupTotals: sumTotals(list) } : {}),
    })
    .returning({ id: notifications.id });
  ctx.counts.notifications++;
  const groupId = bursts
    ? await openGroup(tx, {
        organizationId: row.organizationId,
        businessId: biz.id,
        key,
        kind,
        facts,
        firstNotificationId: n!.id,
        now,
      })
    : null;

  const base: DeliveryPayload = {
    facts,
    opts,
    count: list?.length ?? 1,
    tone: def.tone,
    ...(groupId ? { group_id: groupId } : {}),
    ...(list ? { items: list } : {}),
  };
  const values: Array<typeof notificationDeliveries.$inferInsert> = [];
  const common = {
    organizationId: row.organizationId,
    businessId: biz.id,
    userId: m.userId,
    kind,
    notificationId: n!.id,
    groupKey: key,
  };
  if (res.push !== false)
    for (const s of o.subs)
      values.push({
        ...common,
        channel: "push",
        pushSubscriptionId: s.id,
        payload: { ...base, push: r.push } as unknown as Record<string, unknown>,
        status: res.push === "held" ? "held" : "pending",
        nextAttemptAt: res.push === "held" && res.heldUntil ? res.heldUntil : now,
        dedupeKey: `${row.id}:${kind}:u:${m.userId}:${s.id}:push`,
      });
  if (res.email)
    values.push({
      ...common,
      channel: "email",
      payload: { ...base, mail: { to: m.email, ...r.email } } as unknown as Record<string, unknown>,
      nextAttemptAt: now,
      dedupeKey: `${row.id}:${kind}:u:${m.userId}:email`,
    });
  await insertDeliveries(ctx, values);
}

async function toDestination(
  ctx: Ctx,
  d: Destination,
  kind: NotificationKind,
  items: FactsBundle[],
  several: boolean,
) {
  const { tx, row, now } = ctx;
  const biz = items[0]!.business;
  const facts = items[0]!.facts;
  const key = groupKey(`d:${d.id}`, biz.id, kind);
  const bursts = items.length === 1 && groupsBursts(kind);
  if (bursts && (await joinOpenGroup(tx, key, facts, now))) return;
  const groupId = bursts
    ? await openGroup(tx, {
        organizationId: row.organizationId,
        businessId: biz.id,
        key,
        kind,
        facts,
        now,
      })
    : null;
  const opts: DeliveryPayload["opts"] = {
    timezone: biz.timezone,
    hideNames: d.hideNames,
    showBusiness: several,
    audience: "destination",
  };
  const { r, list } = renderFor(ctx, kind, items, opts, bursts ? key : null);
  const payload: DeliveryPayload = {
    facts,
    opts,
    count: list?.length ?? 1,
    tone: kindDef(kind).tone,
    ...(groupId ? { group_id: groupId } : {}),
    ...(list ? { items: list } : {}),
    ...(d.type === "chat" ? { chat: r.chat } : { mail: r.email }),
  };
  await insertDeliveries(ctx, [
    {
      organizationId: row.organizationId,
      businessId: biz.id,
      channel: d.type === "chat" ? "chat" : "outside_email",
      destinationId: d.id,
      kind,
      groupKey: key,
      payload: payload as unknown as Record<string, unknown>,
      nextAttemptAt: now,
      dedupeKey: `${row.id}:${kind}:d:${d.id}:${d.type === "chat" ? "chat" : "outside_email"}`,
    },
  ]);
}

async function insertDeliveries(
  ctx: Ctx,
  values: Array<typeof notificationDeliveries.$inferInsert>,
) {
  if (values.length === 0) return;
  const rows = await ctx.tx
    .insert(notificationDeliveries)
    .values(values)
    .onConflictDoNothing({ target: notificationDeliveries.dedupeKey })
    .returning({ id: notificationDeliveries.id });
  ctx.counts.deliveries += rows.length;
}

/** Render options a member's bell row was made with (`facts._opts`). */
export type StoredOpts = Omit<RenderOptions, "grouped" | "now" | "baseUrl">;
