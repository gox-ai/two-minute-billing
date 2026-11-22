/**
 * Bursts: the first event of a (target, business, kind) sends; later ones in the next 5 minutes
 * are counted and kept (up to 20). When the window closes, each channel the first send used gets
 * one more message: the single later event as a normal notification, or a list of them
 * ("3 more invoices overdue · $2,385"); a list push keeps the first one's tag and replaces it.
 * Clock kinds do not group: one clock run already sends one message (`fanout.ts`).
 */
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { notificationDeliveries, notificationGroups, notifications } from "@db/schema";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { config } from "@/platform/config";
import { scanBusinessFilterNullable } from "@/platform/clock";
import { kindDef, type NotificationKind } from "./catalogue";
import { renderItems, renderNotification, type Facts, type RenderOptions } from "./text";
import type { PushBody } from "./channels";

export const GROUP_WINDOW_MS = 5 * 60_000;
/** Later events a group keeps for its closing message. */
export const MAX_GROUP_ITEMS = 20;

export type GroupRow = typeof notificationGroups.$inferSelect;

/** What a delivery row carries: the rendered send, and enough to render its "N more". */
export interface DeliveryPayload {
  facts: Facts;
  opts: Omit<RenderOptions, "grouped" | "now" | "baseUrl">;
  /** Events this send stands for: 1, or N for a list. */
  count: number;
  /** A list's items (facts of each event); `facts` is the first. */
  items?: Facts[];
  tone: string;
  group_id?: string;
  more?: boolean;
  push?: PushBody;
  mail?: { to?: string; subject: string; html: string; text: string };
  chat?: unknown;
  /** A daily or weekly summary. */
  summary?: boolean;
}

/** `u:<user>|<business>|<kind>` or `d:<destination>|<business>|<kind>`. */
export const groupKey = (target: string, businessId: string, kind: string) =>
  `${target}|${businessId}|${kind}`;

export const baseUrl = () => config.DASHBOARD_BASE_URL?.replace(/\/$/, "") ?? null;

const addTotals = (t: Record<string, number>, f: Facts): Record<string, number> => {
  if (f.amountMinor == null || !f.currency) return t;
  return { ...t, [f.currency]: (t[f.currency] ?? 0) + Number(f.amountMinor) };
};

export const totalsOf = (f: Facts): Record<string, number> => addTotals({}, f);

export const sumTotals = (list: Facts[]): Record<string, number> => list.reduce(addTotals, {});

/** What a group keeps of a later event: its facts, without the email address. */
export const itemOf = (f: Facts): Facts => {
  const { customerEmail: _, ...rest } = f;
  return rest;
};

/** Whether a kind joins 5-minute groups. Clock kinds send one message a run instead. */
export const groupsBursts = (kind: NotificationKind) => kindDef(kind).source !== "clock";

/**
 * Join the open group for `key` when its window is still open: count the event, refresh the
 * first bell row, and return true (send nothing). A window past 5 minutes that the closer has
 * not reached yet is closed here first. False: the caller sends and opens a group.
 */
export async function joinOpenGroup(
  tx: Tx,
  key: string,
  facts: Facts,
  now: Date,
): Promise<boolean> {
  const [open] = await tx
    .select()
    .from(notificationGroups)
    .where(and(eq(notificationGroups.key, key), isNull(notificationGroups.closedAt)))
    .limit(1)
    .for("update");
  if (!open) return false;
  if (open.openedAt.getTime() <= now.getTime() - GROUP_WINDOW_MS) {
    await closeGroup(tx, open, now);
    return false;
  }
  const count = open.count + 1;
  const totals = addTotals(open.totals, facts);
  const items =
    open.items.length < MAX_GROUP_ITEMS
      ? [...open.items, itemOf(facts) as Record<string, unknown>]
      : open.items;
  await tx
    .update(notificationGroups)
    .set({ count, totals, items })
    .where(eq(notificationGroups.id, open.id));
  const firstId = open.firstNotificationIds[0];
  if (firstId) {
    const [first] = await tx
      .select()
      .from(notifications)
      .where(eq(notifications.id, firstId))
      .limit(1);
    if (first) {
      const o = renderOptsOf(first.facts) ?? {};
      const r = renderNotification(open.kind as NotificationKind, first.facts as Facts, {
        ...o,
        timezone: o.timezone ?? "UTC",
        grouped: { count, totals },
        now,
      });
      await tx
        .update(notifications)
        .set({
          title: r.title,
          body: r.body,
          url: r.url,
          groupCount: count,
          groupTotals: totals,
          readAt: null,
        })
        .where(eq(notifications.id, first.id));
    }
  }
  return true;
}

/** Bell rows keep their render options next to the facts, under `_opts`. */
function renderOptsOf(facts: unknown): Partial<RenderOptions> | null {
  const o = (facts as { _opts?: Partial<RenderOptions> } | null)?._opts;
  return o && typeof o === "object" ? o : null;
}

export async function openGroup(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    key: string;
    kind: NotificationKind;
    facts: Facts;
    firstNotificationId?: string | null;
    now: Date;
  },
): Promise<string | null> {
  const [g] = await tx
    .insert(notificationGroups)
    .values({
      organizationId: input.organizationId,
      businessId: input.businessId,
      key: input.key,
      kind: input.kind,
      openedAt: input.now,
      count: 1,
      totals: totalsOf(input.facts),
      firstNotificationIds: input.firstNotificationId ? [input.firstNotificationId] : [],
    })
    .onConflictDoNothing()
    .returning({ id: notificationGroups.id });
  return g?.id ?? null;
}

/**
 * Close one group. With later events, one message per first send, on the same channel and
 * target: one later event goes out as a normal notification, more as a list with the first
 * send's push tag. A first push still held for quiet hours holds this one too.
 */
export async function closeGroup(tx: Tx, group: GroupRow, now: Date): Promise<number> {
  await tx
    .update(notificationGroups)
    .set({ closedAt: now })
    .where(eq(notificationGroups.id, group.id));
  const extra = group.count - 1;
  if (extra < 1) return 0;
  const items = group.items as Facts[];
  const firsts = await tx
    .select()
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.groupKey, group.key),
        sql`${notificationDeliveries.payload}->>'group_id' = ${group.id}`,
      ),
    );
  let made = 0;
  for (const d of firsts) {
    const p = d.payload as unknown as DeliveryPayload;
    const kind = d.kind as NotificationKind;
    const single = extra === 1 && items[0] ? items[0] : null;
    // A list replaces the first push on the device; a single later event stands beside it.
    const r = renderItems(
      kind,
      items,
      { ...p.opts, tag: single ? null : group.key, baseUrl: baseUrl(), now },
      { count: extra, totals: minusTotals(group.totals, p.facts), more: true },
    );
    const payload: DeliveryPayload = {
      facts: single ?? items[0] ?? p.facts,
      opts: p.opts,
      count: extra,
      tone: kindDef(kind).tone,
      more: true,
      ...(single ? {} : { items }),
    };
    if (d.channel === "push") payload.push = single ? r.push : { ...r.push, renotify: true };
    else if (d.channel === "chat") payload.chat = r.chat;
    else payload.mail = { to: p.mail?.to, ...r.email };
    const held = d.status === "held";
    const rows = await tx
      .insert(notificationDeliveries)
      .values({
        organizationId: d.organizationId,
        businessId: d.businessId,
        channel: d.channel,
        userId: d.userId,
        destinationId: d.destinationId,
        pushSubscriptionId: d.pushSubscriptionId,
        kind: d.kind,
        notificationId: d.notificationId,
        groupKey: group.key,
        payload: payload as unknown as Record<string, unknown>,
        status: held ? "held" : "pending",
        nextAttemptAt: held ? d.nextAttemptAt : now,
        dedupeKey: `grp:${group.id}:more:${d.id}`,
      })
      .onConflictDoNothing({ target: notificationDeliveries.dedupeKey })
      .returning({ id: notificationDeliveries.id });
    made += rows.length;
  }
  return made;
}

/** The group's totals without the first event's amount. */
function minusTotals(totals: Record<string, number>, first: Facts): Record<string, number> {
  const rest = { ...totals };
  if (first.currency && first.amountMinor != null && rest[first.currency] != null)
    rest[first.currency] = rest[first.currency]! - Number(first.amountMinor);
  return rest;
}

/** The minute job: close every window older than 5 minutes. Returns the "N more" sends made. */
export async function closeDueGroups(now: Date): Promise<{ closed: number; deliveries: number }> {
  const due = await systemDb
    .select()
    .from(notificationGroups)
    .where(
      and(
        isNull(notificationGroups.closedAt),
        lte(notificationGroups.openedAt, new Date(now.getTime() - GROUP_WINDOW_MS)),
        scanBusinessFilterNullable(notificationGroups.businessId),
      ),
    )
    .limit(1000);
  let deliveries = 0;
  for (const g of due) {
    deliveries += await withTenant(g.organizationId, async (tx) => {
      const [cur] = await tx
        .select()
        .from(notificationGroups)
        .where(and(eq(notificationGroups.id, g.id), isNull(notificationGroups.closedAt)))
        .limit(1)
        .for("update", { skipLocked: true });
      return cur ? closeGroup(tx, cur, now) : 0;
    });
  }
  return { closed: due.length, deliveries };
}
