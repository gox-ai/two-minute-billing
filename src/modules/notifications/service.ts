/**
 * Notification settings, devices, the bell, summaries and destinations: the reads and writes
 * behind the session routes. Every tenant read goes through `withTenant`; `systemDb` only for
 * a device endpoint that may move between accounts, the public confirm, the per-address send
 * count, and the worker's settings read.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  businesses,
  notificationDestinations,
  notificationDigests,
  notificationPreferences,
  notifications,
  notificationSettings,
  notificationSettingsOrg,
  organizations,
  prices,
  pushSubscriptions,
} from "@db/schema";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { config } from "@/platform/config";
import { publicId } from "@/platform/ids";
import { encryptSecret } from "@/platform/secrets";
import { createLogger } from "@/platform/logger";
import { effectivePermissions } from "@/modules/auth/permissions";
import { resolveMailer } from "@/modules/emails/mailer-resolver";
import { escapeHtml } from "@/modules/emails/sanitize";
import { isTeamAddress } from "@/modules/emails/test-mode";
import {
  hadTeamAlertOn,
  resolveTeamAlertsConfig,
  serializeTeamAlertsConfig,
  type TeamAlertsConfig,
} from "./legacy-team-alerts";
import {
  CATALOGUE,
  NOTIFICATION_KINDS,
  defaultPreferences,
  kindDef,
  isNotificationKind,
  type KindPreference,
  type MemberRole,
  type NotificationKind,
} from "./catalogue";
import { isTimeZone, zonedTimeToUtc, type BusinessFilter, type QuietHours } from "./resolve";

const log = createLogger("notifications");

/** The signed-in member. `AuthedUser` fits. */
export interface NotificationMember {
  userId: string;
  email?: string;
  role: string;
  customRole?: { id: string; version: number; permissions: readonly string[] } | null;
}

export class NotificationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "forbidden"
      | "invalid"
      | "rate_limited"
      | "not_pending"
      | "no_link",
  ) {
    super(message);
  }
}

export const memberPermissions = (m: NotificationMember): ReadonlySet<string> =>
  effectivePermissions(m.role, m.customRole ?? null);

const asRole = (role: string): MemberRole =>
  (["owner", "admin", "manager", "ops", "developer"].includes(role)
    ? role
    : "custom") as MemberRole;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const at = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  throw new NotificationError(
    `${at}${issue?.message ?? "Correct the highlighted fields."}`,
    "invalid",
  );
}

// ── input shapes ──

const aboveSchema = z.record(
  z.string().regex(/^[A-Z]{3}$/),
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
);
const prefSchema = z.object({
  timing: z.enum(["instant", "summary", "off"]),
  push: z.boolean(),
  email: z.boolean(),
  above: aboveSchema.optional(),
});
const kindsSchema = z.partialRecord(z.enum(NOTIFICATION_KINDS), prefSchema);
const filterSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }),
  z.object({
    mode: z.literal("selected"),
    business_ids: z.array(z.string().min(1).max(64)).min(1).max(500),
  }),
]);
const summarySchema = z.object({
  enabled: z.boolean(),
  channels: z.array(z.enum(["push", "email"])).max(2),
});

export const preferencesInput = z.object({
  default: kindsSchema.optional(),
  exceptions: z
    .array(z.object({ business: z.string().min(1).max(64), kinds: kindsSchema }))
    .max(500)
    .optional(),
  business_filter: filterSchema.optional(),
  daily: summarySchema.optional(),
  weekly: summarySchema.optional(),
  send_empty: z.boolean().optional(),
  notice_dismissed: z.boolean().optional(),
});
export type PreferencesInput = z.infer<typeof preferencesInput>;

const hour = z.number().int().min(0).max(23);
export const settingsInput = z.object({
  timezone: z.string().max(64).refine(isTimeZone, "Select a valid time zone.").optional(),
  summary_hour: hour.optional(),
  weekly_day: z.number().int().min(1).max(7).optional(),
  quiet: z
    .object({ enabled: z.boolean(), from: hour, to: hour, disputes_through: z.boolean() })
    .optional(),
});

const b64url = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_\-=+/]+$/);
export const pushSubscriptionInput = z.object({
  endpoint: z.string().max(2048).url().startsWith("https://"),
  keys: z.object({ p256dh: b64url, auth: b64url }),
  label: z.string().trim().max(100).optional(),
  user_agent: z.string().max(500).optional(),
});

const destKindsSchema = z.partialRecord(
  z.enum(NOTIFICATION_KINDS),
  z.object({ on: z.boolean(), above: aboveSchema.optional() }),
);
const destCommon = {
  business_filter: filterSchema.optional(),
  kinds: destKindsSchema.optional(),
  daily: z.boolean().optional(),
  weekly: z.boolean().optional(),
  hide_names: z.boolean().optional(),
};
export const destinationCreateInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("chat"),
    name: z.string().trim().min(1).max(100),
    url: z.string().trim().max(2048),
    ...destCommon,
  }),
  z.object({
    type: z.literal("email"),
    name: z.string().trim().max(100).optional(),
    email: z.string().trim().max(254).email(),
    ...destCommon,
  }),
]);
export const destinationUpdateInput = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  url: z.string().trim().max(2048).optional(),
  ...destCommon,
});

// ── helpers ──

interface LiveBusiness {
  id: string;
  publicId: string;
  name: string;
}

/** Live businesses of the organization. Test businesses never send notifications. */
async function liveBusinesses(tx: Tx): Promise<LiveBusiness[]> {
  return tx
    .select({ id: businesses.id, publicId: businesses.publicId, name: businesses.name })
    .from(businesses)
    .where(and(eq(businesses.livemode, "live"), eq(businesses.status, "active")))
    .orderBy(asc(businesses.name));
}

/** Currencies the organization's live businesses sell in, for the "Only above" control. */
async function liveCurrencies(tx: Tx, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const out = new Set<string>();
  const bizRows = await tx
    .select({ def: businesses.defaultCurrency, list: businesses.currencies })
    .from(businesses)
    .where(inArray(businesses.id, ids));
  for (const r of bizRows) {
    if (r.def) out.add(r.def.toUpperCase());
    if (Array.isArray(r.list))
      for (const c of r.list) if (typeof c === "string") out.add(c.toUpperCase());
  }
  const priceRows = await tx
    .selectDistinct({ currency: prices.currency })
    .from(prices)
    .where(and(inArray(prices.businessId, ids), eq(prices.active, true)));
  for (const r of priceRows) out.add(r.currency.toUpperCase());
  return [...out].sort();
}

const toPublicFilter = (f: BusinessFilter, byId: Map<string, string>): BusinessFilter =>
  f.mode === "all"
    ? f
    : {
        mode: "selected",
        business_ids: f.business_ids.map((id) => byId.get(id)).filter((x): x is string => !!x),
      };

function toInternalFilter(f: BusinessFilter, byPublic: Map<string, string>): BusinessFilter {
  if (f.mode === "all") return f;
  const ids = f.business_ids.map((p) => {
    const id = byPublic.get(p);
    if (!id) throw new NotificationError(`We could not find the business ${p}.`, "invalid");
    return id;
  });
  return { mode: "selected", business_ids: [...new Set(ids)] };
}

/** Limits only on kinds that have them; currency codes upper-case. */
function cleanPref(kind: NotificationKind, p: KindPreference): KindPreference {
  const out: KindPreference = { timing: p.timing, push: p.push, email: p.email };
  if (kindDef(kind).amount && p.above && Object.keys(p.above).length) out.above = { ...p.above };
  return out;
}

const sameAbove = (a?: Record<string, number>, b?: Record<string, number>) => {
  const ka = Object.keys(a ?? {}).sort();
  const kb = Object.keys(b ?? {}).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a![k] === b![k]);
};
const samePref = (a: KindPreference, b: KindPreference | undefined) =>
  !!b &&
  a.timing === b.timing &&
  a.push === b.push &&
  a.email === b.email &&
  sameAbove(a.above, b.above);

/** Stored kinds over the role's defaults, so a kind added later still has a row. */
function fullKinds(
  stored: Record<string, KindPreference> | null | undefined,
  role: MemberRole,
): Record<NotificationKind, KindPreference> {
  const out = defaultPreferences(role);
  for (const [k, v] of Object.entries(stored ?? {})) if (isNotificationKind(k)) out[k] = v;
  return out;
}

// ── preferences ──

/** True when any business of the tenant had a team alert that sent mail (before 0533). */
async function hadAnyTeamAlert(tx: Tx): Promise<boolean> {
  const rows = await tx
    .select({ teamAlertsConfig: businesses.teamAlertsConfig })
    .from(businesses)
    .where(isNotNull(businesses.teamAlertsConfig));
  return rows.some((r) => hadTeamAlertOn(resolveTeamAlertsConfig(r)));
}

/** Hide the "team alerts are now notifications" notice. Does not set the member up. */
export async function dismissTeamAlertsNotice(organizationId: string, member: NotificationMember) {
  await withTenant(organizationId, (tx) =>
    tx
      .insert(notificationSettingsOrg)
      .values({ organizationId, userId: member.userId, noticeDismissedAt: new Date() })
      .onConflictDoUpdate({
        target: [notificationSettingsOrg.organizationId, notificationSettingsOrg.userId],
        set: { noticeDismissedAt: new Date(), updatedAt: sql`app_now()` },
      }),
  );
}

export async function getPreferences(organizationId: string, member: NotificationMember) {
  const role = asRole(member.role);
  const perms = memberPermissions(member);
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, member.userId));
    const [org] = await tx
      .select()
      .from(notificationSettingsOrg)
      .where(eq(notificationSettingsOrg.userId, member.userId))
      .limit(1);
    const live = await liveBusinesses(tx);
    const byId = new Map(live.map((b) => [b.id, b.publicId]));
    const def = rows.find((r) => r.businessId === null);
    return {
      set_up: !!def,
      catalogue: CATALOGUE.map((k) => ({
        kind: k.kind,
        group: k.group,
        label: k.label,
        help: k.help,
        tone: k.tone,
        amount: k.amount,
        visible: perms.has(k.permission),
      })),
      default: fullKinds(def?.kinds, role),
      exceptions: rows
        .filter((r) => r.businessId !== null && byId.has(r.businessId))
        .map((r) => ({ business: byId.get(r.businessId!)!, kinds: r.kinds })),
      business_filter: toPublicFilter(org?.businessFilter ?? { mode: "all" }, byId),
      daily: org?.daily ?? { enabled: true, channels: ["email"] },
      weekly: org?.weekly ?? { enabled: false, channels: ["email"] },
      send_empty: org?.sendEmpty ?? false,
      notice_dismissed_at: org?.noticeDismissedAt?.toISOString() ?? null,
      // Owners and admins of an organization whose team alerts sent mail see the notice once.
      team_alerts_notice:
        (role === "owner" || role === "admin") &&
        !org?.noticeDismissedAt &&
        (await hadAnyTeamAlert(tx)),
      currencies: await liveCurrencies(
        tx,
        live.map((b) => b.id),
      ),
      businesses: live.map((b) => ({ id: b.publicId, name: b.name })),
    };
  });
}

/**
 * Save the member's settings. The first save seeds the role's defaults for kinds not given.
 * `exceptions`, when given, replaces every business exception; each keeps only the kinds that
 * differ from the default.
 */
export async function savePreferences(
  organizationId: string,
  member: NotificationMember,
  raw: unknown,
) {
  const input = parse(preferencesInput, raw);
  const role = asRole(member.role);
  await withTenant(organizationId, async (tx) => {
    const live = await liveBusinesses(tx);
    const byPublic = new Map(live.map((b) => [b.publicId, b.id]));
    const [existing] = await tx
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, member.userId),
          isNull(notificationPreferences.businessId),
        ),
      )
      .limit(1)
      .for("update");
    const merged = fullKinds(existing?.kinds, role);
    for (const [k, v] of Object.entries(input.default ?? {}))
      merged[k as NotificationKind] = cleanPref(k as NotificationKind, v as KindPreference);
    await tx
      .insert(notificationPreferences)
      .values({ organizationId, userId: member.userId, businessId: null, kinds: merged })
      .onConflictDoUpdate({
        target: [notificationPreferences.organizationId, notificationPreferences.userId],
        targetWhere: sql`business_id IS NULL`,
        set: { kinds: merged, updatedAt: sql`app_now()` },
      });

    if (input.exceptions) {
      const keep = new Set<string>();
      for (const ex of input.exceptions) {
        const businessId = byPublic.get(ex.business);
        if (!businessId)
          throw new NotificationError(`We could not find the business ${ex.business}.`, "invalid");
        const diff: Record<string, KindPreference> = {};
        for (const [k, v] of Object.entries(ex.kinds)) {
          const p = cleanPref(k as NotificationKind, v as KindPreference);
          if (!samePref(p, merged[k as NotificationKind])) diff[k] = p;
        }
        if (Object.keys(diff).length === 0) continue;
        keep.add(businessId);
        await tx
          .insert(notificationPreferences)
          .values({ organizationId, userId: member.userId, businessId, kinds: diff })
          .onConflictDoUpdate({
            target: [
              notificationPreferences.organizationId,
              notificationPreferences.userId,
              notificationPreferences.businessId,
            ],
            targetWhere: sql`business_id IS NOT NULL`,
            set: { kinds: diff, updatedAt: sql`app_now()` },
          });
      }
      const stale = await tx
        .select({ id: notificationPreferences.id, businessId: notificationPreferences.businessId })
        .from(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.userId, member.userId),
            sql`${notificationPreferences.businessId} IS NOT NULL`,
          ),
        );
      const drop = stale.filter((r) => !keep.has(r.businessId!)).map((r) => r.id);
      if (drop.length)
        await tx.delete(notificationPreferences).where(inArray(notificationPreferences.id, drop));
    }

    const orgSet: Partial<typeof notificationSettingsOrg.$inferInsert> = {};
    if (input.business_filter)
      orgSet.businessFilter = toInternalFilter(input.business_filter, byPublic);
    if (input.daily) orgSet.daily = input.daily;
    if (input.weekly) orgSet.weekly = input.weekly;
    if (input.send_empty !== undefined) orgSet.sendEmpty = input.send_empty;
    if (input.notice_dismissed) orgSet.noticeDismissedAt = new Date();
    await tx
      .insert(notificationSettingsOrg)
      .values({ organizationId, userId: member.userId, ...orgSet })
      .onConflictDoUpdate({
        target: [notificationSettingsOrg.organizationId, notificationSettingsOrg.userId],
        set: { ...orgSet, updatedAt: sql`app_now()` },
      });
  });
  return getPreferences(organizationId, member);
}

// ── personal settings ──

const DEFAULT_QUIET: QuietHours = { enabled: false, from: 22, to: 7, disputes_through: true };

function serializeSettings(row: typeof notificationSettings.$inferSelect | undefined) {
  return {
    set: !!row,
    timezone: row?.timezone ?? "UTC",
    summary_hour: row?.summaryHour ?? 8,
    weekly_day: row?.weeklyDay ?? 1,
    quiet: row?.quiet ?? DEFAULT_QUIET,
  };
}

export async function getSettings(organizationId: string, userId: string) {
  const [row] = await withTenant(organizationId, (tx) =>
    tx.select().from(notificationSettings).where(eq(notificationSettings.userId, userId)).limit(1),
  );
  return serializeSettings(row);
}

export async function saveSettings(organizationId: string, userId: string, raw: unknown) {
  const input = parse(settingsInput, raw);
  const set: Partial<typeof notificationSettings.$inferInsert> = {};
  if (input.timezone) set.timezone = input.timezone;
  if (input.summary_hour !== undefined) set.summaryHour = input.summary_hour;
  if (input.weekly_day !== undefined) set.weeklyDay = input.weekly_day;
  if (input.quiet) set.quiet = input.quiet;
  const [row] = await withTenant(organizationId, (tx) =>
    tx
      .insert(notificationSettings)
      .values({ userId, ...set })
      .onConflictDoUpdate({
        target: notificationSettings.userId,
        set: { ...set, updatedAt: sql`app_now()` },
      })
      .returning(),
  );
  return serializeSettings(row);
}

/** For the worker: personal settings of many members, across organizations. */
export async function settingsForUsers(userIds: string[]) {
  if (userIds.length === 0) return new Map<string, ReturnType<typeof serializeSettings>>();
  const rows = await systemDb
    .select()
    .from(notificationSettings)
    .where(inArray(notificationSettings.userId, userIds));
  const byUser = new Map(rows.map((r) => [r.userId, r]));
  return new Map(userIds.map((id) => [id, serializeSettings(byUser.get(id))]));
}

// ── push subscriptions ──

function serializePush(r: typeof pushSubscriptions.$inferSelect) {
  return {
    id: r.publicId,
    label: r.label,
    user_agent: r.userAgent,
    created_at: r.createdAt.toISOString(),
    last_success_at: r.lastSuccessAt?.toISOString() ?? null,
    last_failure_at: r.lastFailureAt?.toISOString() ?? null,
  };
}

export async function listPushSubscriptions(organizationId: string, userId: string) {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .orderBy(desc(pushSubscriptions.createdAt)),
  );
  return rows.map(serializePush);
}

/**
 * Add this device, or take it over: the endpoint is the browser's, and the person who
 * subscribed last owns it. `systemDb` because the row may belong to another account.
 */
export async function savePushSubscription(userId: string, raw: unknown) {
  const input = parse(pushSubscriptionInput, raw);
  const [row] = await systemDb
    .insert(pushSubscriptions)
    .values({
      publicId: publicId("psub"),
      userId,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      label: input.label ?? null,
      userAgent: input.user_agent ?? null,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        label: input.label ?? null,
        userAgent: input.user_agent ?? null,
        failureCount: 0,
        lastFailureAt: null,
      },
    })
    .returning();
  return serializePush(row!);
}

/** The member's own devices only. */
export async function deletePushSubscription(
  organizationId: string,
  userId: string,
  id: string,
): Promise<boolean> {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.publicId, id)))
      .returning({ id: pushSubscriptions.id }),
  );
  return rows.length === 1;
}

// ── the bell ──

const RECENT = sql`now() - interval '90 days'`;

function serializeNotification(
  r: typeof notifications.$inferSelect,
  biz: { publicId: string; name: string } | null,
) {
  return {
    id: r.publicId,
    kind: r.kind,
    tone: r.tone,
    timing: r.timing,
    title: r.title,
    body: r.body,
    url: r.url,
    record: r.record,
    business: biz ? { id: biz.publicId, name: biz.name } : null,
    amount_minor: r.amountMinor,
    currency: r.currency,
    group_count: r.groupCount,
    test: r.test,
    read: r.readAt !== null,
    read_at: r.readAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
  };
}

async function businessIdOf(tx: Tx, publicIdValue: string | null | undefined) {
  if (!publicIdValue) return null;
  const [b] = await tx
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.publicId, publicIdValue))
    .limit(1);
  if (!b)
    throw new NotificationError(`We could not find the business ${publicIdValue}.`, "not_found");
  return b.id;
}

/** Instant rows, newest first. `cursor` is the last row's id from the previous page. */
export async function listNotifications(
  organizationId: string,
  userId: string,
  opts: {
    unread?: boolean;
    businessPublicId?: string | null;
    cursor?: string | null;
    limit?: number;
  } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  return withTenant(organizationId, async (tx) => {
    const businessId = await businessIdOf(tx, opts.businessPublicId);
    const where = [
      eq(notifications.userId, userId),
      eq(notifications.timing, "instant"),
      sql`${notifications.createdAt} > ${RECENT}`,
    ];
    if (opts.unread) where.push(isNull(notifications.readAt));
    if (businessId) where.push(eq(notifications.businessId, businessId));
    if (opts.cursor) {
      const [c] = await tx
        .select({ id: notifications.id, createdAt: notifications.createdAt })
        .from(notifications)
        .where(and(eq(notifications.userId, userId), eq(notifications.publicId, opts.cursor)))
        .limit(1);
      if (!c) throw new NotificationError("We could not find the cursor notification.", "invalid");
      where.push(
        sql`(${notifications.createdAt}, ${notifications.id}) < (${c.createdAt.toISOString()}::timestamptz, ${c.id}::uuid)`,
      );
    }
    const rows = await tx
      .select({ n: notifications, bizPublicId: businesses.publicId, bizName: businesses.name })
      .from(notifications)
      .leftJoin(businesses, eq(businesses.id, notifications.businessId))
      .where(and(...where))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      data: page.map((r) =>
        serializeNotification(
          r.n,
          r.bizPublicId ? { publicId: r.bizPublicId, name: r.bizName! } : null,
        ),
      ),
      has_more: rows.length > limit,
      next_cursor: rows.length > limit ? page[page.length - 1]!.n.publicId : null,
    };
  });
}

/** Unread instant rows; `destructive` sets the badge tone. */
export async function unreadCount(
  organizationId: string,
  userId: string,
  opts: { businessPublicId?: string | null } = {},
): Promise<{ count: number; destructive: boolean }> {
  return withTenant(organizationId, async (tx) => {
    const businessId = await businessIdOf(tx, opts.businessPublicId);
    const [r] = await tx
      .select({
        count: sql<number>`count(*)::int`,
        destructive: sql<boolean>`coalesce(bool_or(${notifications.tone} = 'destructive'), false)`,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.timing, "instant"),
          isNull(notifications.readAt),
          sql`${notifications.createdAt} > ${RECENT}`,
          businessId ? eq(notifications.businessId, businessId) : undefined,
        ),
      );
    return { count: r?.count ?? 0, destructive: r?.destructive ?? false };
  });
}

export async function markRead(
  organizationId: string,
  userId: string,
  id: string,
): Promise<boolean> {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(and(eq(notifications.userId, userId), eq(notifications.publicId, id)))
      .returning({ id: notifications.id }),
  );
  return rows.length === 1;
}

/** Mark every unread instant row read, in one business when given. Returns how many. */
export async function markAllRead(
  organizationId: string,
  userId: string,
  opts: { businessPublicId?: string | null } = {},
): Promise<number> {
  return withTenant(organizationId, async (tx) => {
    const businessId = await businessIdOf(tx, opts.businessPublicId);
    const rows = await tx
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.timing, "instant"),
          isNull(notifications.readAt),
          businessId ? eq(notifications.businessId, businessId) : undefined,
        ),
      )
      .returning({ id: notifications.id });
    return rows.length;
  });
}

/** A built summary and the member's own summary items for its business and period. */
export async function getSummary(organizationId: string, userId: string, id: string) {
  return withTenant(organizationId, async (tx) => {
    const [d] = await tx
      .select({
        d: notificationDigests,
        bizPublicId: businesses.publicId,
        bizName: businesses.name,
        tz: businesses.timezone,
      })
      .from(notificationDigests)
      .innerJoin(businesses, eq(businesses.id, notificationDigests.businessId))
      .where(eq(notificationDigests.publicId, id))
      .limit(1);
    if (!d) throw new NotificationError(`We could not find the summary ${id}.`, "not_found");
    const tz = d.tz ?? "UTC";
    const [y, m, day] = String(d.d.periodStart).split("-").map(Number) as [number, number, number];
    const days = d.d.period === "weekly" ? 7 : 1;
    const start = zonedTimeToUtc(y, m, day, 0, tz);
    const endDay = new Date(Date.UTC(y, m - 1, day + days));
    const end = zonedTimeToUtc(
      endDay.getUTCFullYear(),
      endDay.getUTCMonth() + 1,
      endDay.getUTCDate(),
      0,
      tz,
    );
    const items = await tx
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.businessId, d.d.businessId),
          eq(notifications.timing, "summary"),
          gte(notifications.createdAt, start),
          lt(notifications.createdAt, end),
        ),
      )
      .orderBy(asc(notifications.createdAt));
    const biz = { publicId: d.bizPublicId, name: d.bizName };
    return {
      id: d.d.publicId,
      period: d.d.period,
      period_start: String(d.d.periodStart),
      timezone: tz,
      business: { id: biz.publicId, name: biz.name },
      parts: d.d.parts,
      built_at: d.d.builtAt.toISOString(),
      items: items.map((r) => serializeNotification(r, biz)),
    };
  });
}

// ── destinations (owners and admins) ──

/** Confirmation links work for this long. */
export const CONFIRM_TTL_MS = 7 * 24 * 3600_000;
/** One organization may mail one address at most this often… */
export const RESEND_MIN_INTERVAL_MS = 10 * 60_000;
/** …and this many times in a rolling day. */
export const SENDS_PER_DAY_PER_DESTINATION = 3;
/** Every organization together may mail one address this many times in a rolling day. */
export const SENDS_PER_DAY_PER_ADDRESS = 10;
export const MAX_DESTINATIONS = 50;
const DAY_MS = 24 * 3600_000;
const TOKEN_PREFIX = "ndc_";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function assertDestinationManager(member: NotificationMember): void {
  if (member.role !== "owner" && member.role !== "admin")
    throw new NotificationError(
      "Only owners and admins can change team notifications.",
      "forbidden",
    );
}

/** A Google Chat incoming webhook: HTTPS on chat.googleapis.com only. */
export function isChatWebhookUrl(url: string): boolean {
  if (!url.startsWith("https://chat.googleapis.com/")) return false;
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" && u.hostname === "chat.googleapis.com" && !u.username && !u.password
    );
  } catch {
    return false;
  }
}
const CHAT_URL_ERROR =
  "Enter a Google Chat webhook URL. It starts with https://chat.googleapis.com/.";

type DestinationRow = typeof notificationDestinations.$inferSelect;

function serializeDestination(r: DestinationRow, byId: Map<string, string>) {
  return {
    id: r.publicId,
    type: r.type,
    name: r.name,
    url_hint: r.urlHint ? `…${r.urlHint}` : null,
    email: r.email,
    status: r.status,
    business_filter: toPublicFilter(r.businessFilter, byId),
    kinds: r.kinds,
    daily: r.daily,
    weekly: r.weekly,
    hide_names: r.hideNames,
    last_error: r.lastError,
    last_sent_at: r.lastSentAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
  };
}

function cleanDestKinds(kinds: Record<string, { on: boolean; above?: Record<string, number> }>) {
  const out: Record<string, { on: boolean; above?: Record<string, number> }> = {};
  for (const [k, v] of Object.entries(kinds)) {
    if (!isNotificationKind(k)) continue;
    out[k] = { on: v.on };
    if (kindDef(k).amount && v.above && Object.keys(v.above).length) out[k].above = { ...v.above };
  }
  return out;
}

async function businessMaps(tx: Tx) {
  const live = await liveBusinesses(tx);
  return {
    byId: new Map(live.map((b) => [b.id, b.publicId])),
    byPublic: new Map(live.map((b) => [b.publicId, b.id])),
  };
}

export async function listDestinations(organizationId: string, member: NotificationMember) {
  assertDestinationManager(member);
  return withTenant(organizationId, async (tx) => {
    const { byId } = await businessMaps(tx);
    const rows = await tx
      .select()
      .from(notificationDestinations)
      .where(ne(notificationDestinations.status, "removed"))
      .orderBy(asc(notificationDestinations.type), asc(notificationDestinations.createdAt));
    return rows.map((r) => serializeDestination(r, byId));
  });
}

async function loadDestination(tx: Tx, id: string): Promise<DestinationRow> {
  const [row] = await tx
    .select()
    .from(notificationDestinations)
    .where(
      and(
        eq(notificationDestinations.publicId, id),
        ne(notificationDestinations.status, "removed"),
      ),
    )
    .limit(1);
  if (!row) throw new NotificationError(`We could not find the destination ${id}.`, "not_found");
  return row;
}

/** Add a Google Chat space (active at once) or an email address (outside ones confirm by link). */
export async function createDestination(
  organizationId: string,
  member: NotificationMember,
  raw: unknown,
) {
  assertDestinationManager(member);
  const input = parse(destinationCreateInput, raw);
  if (input.type === "chat" && !isChatWebhookUrl(input.url))
    throw new NotificationError(CHAT_URL_ERROR, "invalid");
  const email = input.type === "email" ? input.email.toLowerCase() : null;
  const member_ = email ? await isTeamAddress(organizationId, email) : false;

  const { row, confirm } = await withTenant(organizationId, async (tx) => {
    const { byId, byPublic } = await businessMaps(tx);
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(notificationDestinations)
      .where(ne(notificationDestinations.status, "removed"));
    if (n >= MAX_DESTINATIONS)
      throw new NotificationError(
        `We could not add the destination. An organization can have ${MAX_DESTINATIONS} destinations.`,
        "invalid",
      );
    const common = {
      businessFilter: input.business_filter
        ? toInternalFilter(input.business_filter, byPublic)
        : { mode: "all" as const },
      kinds: cleanDestKinds(input.kinds ?? {}),
      daily: input.daily ?? false,
      weekly: input.weekly ?? false,
      hideNames: input.hide_names ?? false,
      createdByUserId: member.userId,
    };
    if (input.type === "chat") {
      const [r] = await tx
        .insert(notificationDestinations)
        .values({
          organizationId,
          publicId: publicId("ndst"),
          type: "chat",
          name: input.name,
          urlEnc: encryptSecret(input.url),
          urlHint: input.url.slice(-6),
          status: "active",
          ...common,
        })
        .returning();
      return { row: serializeDestination(r!, byId), confirm: null };
    }
    // An address removed earlier keeps its row, so the send limits hold across remove and add.
    const [prev] = await tx
      .select()
      .from(notificationDestinations)
      .where(
        and(
          eq(notificationDestinations.type, "email"),
          eq(notificationDestinations.email, email!),
          isNull(notificationDestinations.legacyBusinessId),
        ),
      )
      .limit(1);
    if (prev && prev.status !== "removed")
      throw new NotificationError(
        `We could not add ${email}. It is already in the list.`,
        "invalid",
      );
    const values = {
      name: input.name || email!,
      status: member_ ? "active" : "pending",
      tokenHash: null,
      tokenExpiresAt: null,
      ...common,
    };
    const [r] = prev
      ? await tx
          .update(notificationDestinations)
          .set({ ...values, updatedAt: sql`app_now()` })
          .where(eq(notificationDestinations.id, prev.id))
          .returning()
      : await tx
          .insert(notificationDestinations)
          .values({
            organizationId,
            publicId: publicId("ndst"),
            type: "email",
            email: email!,
            ...values,
          })
          .returning();
    return { row: serializeDestination(r!, byId), confirm: member_ ? null : r!.publicId };
  });
  if (confirm) await sendConfirmationQuietly(organizationId, confirm);
  return confirm
    ? ((await listDestinations(organizationId, member)).find((d) => d.id === confirm) ?? row)
    : row;
}

export async function updateDestination(
  organizationId: string,
  member: NotificationMember,
  id: string,
  raw: unknown,
) {
  assertDestinationManager(member);
  const input = parse(destinationUpdateInput, raw);
  return withTenant(organizationId, async (tx) => {
    const { byId, byPublic } = await businessMaps(tx);
    const cur = await loadDestination(tx, id);
    const set: Partial<typeof notificationDestinations.$inferInsert> = {};
    if (input.name) set.name = input.name;
    if (input.url !== undefined) {
      if (cur.type !== "chat")
        throw new NotificationError("Only a Google Chat space has a webhook URL.", "invalid");
      if (!isChatWebhookUrl(input.url)) throw new NotificationError(CHAT_URL_ERROR, "invalid");
      Object.assign(set, {
        urlEnc: encryptSecret(input.url),
        urlHint: input.url.slice(-6),
        status: "active",
        failureStreak: 0,
        lastError: null,
      });
    }
    if (input.business_filter)
      set.businessFilter = toInternalFilter(input.business_filter, byPublic);
    if (input.kinds) set.kinds = cleanDestKinds(input.kinds);
    if (input.daily !== undefined) set.daily = input.daily;
    if (input.weekly !== undefined) set.weekly = input.weekly;
    if (input.hide_names !== undefined) set.hideNames = input.hide_names;
    const [r] = await tx
      .update(notificationDestinations)
      .set({ ...set, updatedAt: sql`app_now()` })
      .where(eq(notificationDestinations.id, cur.id))
      .returning();
    return serializeDestination(r!, byId);
  });
}

/** Marks the row `removed`; the row stays so the send limits hold. */
export async function removeDestination(
  organizationId: string,
  member: NotificationMember,
  id: string,
) {
  assertDestinationManager(member);
  await withTenant(organizationId, async (tx) => {
    const cur = await loadDestination(tx, id);
    await tx
      .update(notificationDestinations)
      .set({ status: "removed", tokenHash: null, tokenExpiresAt: null, updatedAt: sql`app_now()` })
      .where(eq(notificationDestinations.id, cur.id));
  });
}

/** "Send again" for a pending outside address. A member's address becomes active at once. */
export async function resendConfirmation(
  organizationId: string,
  member: NotificationMember,
  id: string,
) {
  assertDestinationManager(member);
  const cur = await withTenant(organizationId, (tx) => loadDestination(tx, id));
  if (cur.type !== "email" || cur.status !== "pending")
    throw new NotificationError(
      `We did not send the email. ${cur.name} is not waiting for confirmation.`,
      "not_pending",
    );
  if (await isTeamAddress(organizationId, cur.email!)) {
    await withTenant(organizationId, (tx) =>
      tx
        .update(notificationDestinations)
        .set({ status: "active", tokenHash: null, tokenExpiresAt: null })
        .where(eq(notificationDestinations.id, cur.id)),
    );
    return;
  }
  await sendConfirmation(organizationId, cur.publicId);
}

async function sendConfirmationQuietly(organizationId: string, id: string) {
  try {
    await sendConfirmation(organizationId, id);
  } catch (e) {
    if (!(e instanceof NotificationError)) throw e;
    log.warn("notification destination confirmation not sent", {
      event: "notification_confirmation_not_sent",
      reason: e.code,
    });
  }
}

/**
 * Write a new token and mail the link; the old link stops working. Throws `rate_limited` over
 * either limit and `no_link` when the dashboard URL is not set. Ported from team alerts.
 */
async function sendConfirmation(organizationId: string, id: string): Promise<void> {
  const base = config.DASHBOARD_BASE_URL?.replace(/\/$/, "");
  if (!base)
    throw new NotificationError(
      "We could not send the email. The dashboard address of this deployment is not set.",
      "no_link",
    );
  const now = new Date();
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const sent = await withTenant(organizationId, async (tx) => {
    const [cur] = await tx
      .select()
      .from(notificationDestinations)
      .where(eq(notificationDestinations.publicId, id))
      .limit(1)
      .for("update");
    if (!cur?.email) return null;
    const [sum] = await systemDb
      .select({ n: sql<number>`coalesce(sum(${notificationDestinations.sendCount}), 0)::int` })
      .from(notificationDestinations)
      .where(
        and(
          eq(notificationDestinations.email, cur.email),
          gt(notificationDestinations.sendWindowStart, dayAgo),
        ),
      );
    const windowOpen = cur.sendWindowStart != null && cur.sendWindowStart > dayAgo;
    const count = windowOpen ? cur.sendCount : 0;
    const tooSoon =
      cur.lastSentAt != null && now.getTime() - cur.lastSentAt.getTime() < RESEND_MIN_INTERVAL_MS;
    if (
      tooSoon ||
      count >= SENDS_PER_DAY_PER_DESTINATION ||
      Number(sum?.n ?? 0) >= SENDS_PER_DAY_PER_ADDRESS
    )
      return false;
    await tx
      .update(notificationDestinations)
      .set({
        status: "pending",
        tokenHash: hashToken(token),
        tokenExpiresAt: new Date(now.getTime() + CONFIRM_TTL_MS),
        lastSentAt: now,
        sendCount: count + 1,
        sendWindowStart: windowOpen ? cur.sendWindowStart : now,
      })
      .where(eq(notificationDestinations.id, cur.id));
    const [org] = await tx
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return { email: cur.email, orgName: org?.name ?? "your organization" };
  });
  if (sent === null)
    throw new NotificationError(`We could not find the destination ${id}.`, "not_found");
  if (!sent)
    throw new NotificationError(
      "We could not send the email. We sent too many confirmation emails to this address. Try again later.",
      "rate_limited",
    );
  const link = `${base}/notifications/confirm/s/${token}`;
  const subject = `Confirm that you want billing notifications from ${sent.orgName}`;
  const intro = `Someone added this email address to the billing notifications of ${sent.orgName}. We do not send notifications to this address until you confirm it. If you do not want these notifications, ignore this email.`;
  await resolveMailer(null).send({
    to: sent.email,
    from: config.MAIL_FROM,
    fromName: config.MAIL_FROM_NAME,
    subject,
    html: [
      '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#222">',
      `<h2 style="font-size:18px;margin:0 0 16px">${escapeHtml(subject)}</h2>`,
      `<p style="font-size:14px;line-height:1.6;margin:0 0 12px">${escapeHtml(intro)}</p>`,
      `<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Confirm email address</a></p>`,
      '<p style="font-size:12px;color:#666;margin:0">The link works one time and expires in 7 days.</p>',
      "</div>",
    ].join(""),
    text: `${intro}\n\nConfirm email address: ${link}\n\nThe link works one time and expires in 7 days.`,
    idempotencyKey: `notification_destination_confirm:${hashToken(token)}`,
  });
}

/**
 * The public confirm. Spends the token: once, before it expires, while the address is still
 * pending. `systemDb`: the token names no organization. Returns nothing about the address.
 */
export async function confirmDestination(token: string): Promise<boolean> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return false;
  const rows = await systemDb
    .update(notificationDestinations)
    .set({ status: "active", tokenHash: null, tokenExpiresAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(notificationDestinations.tokenHash, hashToken(token)),
        eq(notificationDestinations.status, "pending"),
        gt(notificationDestinations.tokenExpiresAt, new Date()),
      ),
    )
    .returning({ id: notificationDestinations.id });
  return rows.length === 1;
}

// ── deprecated team-alerts API adapter (removed with that API) ──

async function legacyRows(tx: Tx, businessId: string) {
  return tx
    .select()
    .from(notificationDestinations)
    .where(
      and(
        eq(notificationDestinations.type, "email"),
        eq(notificationDestinations.legacyBusinessId, businessId),
      ),
    )
    .orderBy(asc(notificationDestinations.createdAt));
}

/** `team_alerts_config` in its old shape, read from the business's email destinations. */
export async function legacyTeamAlertsConfig(organizationId: string, businessId: string) {
  return legacyConfigOf(await withTenant(organizationId, (tx) => legacyRows(tx, businessId)));
}

/** `legacyTeamAlertsConfig` for many businesses in one read (the business list). */
export async function legacyTeamAlertsConfigs(organizationId: string, businessIds: string[]) {
  const rows = businessIds.length
    ? await withTenant(organizationId, (tx) =>
        tx
          .select()
          .from(notificationDestinations)
          .where(
            and(
              eq(notificationDestinations.type, "email"),
              inArray(notificationDestinations.legacyBusinessId, businessIds),
            ),
          )
          .orderBy(asc(notificationDestinations.createdAt)),
      )
    : [];
  return new Map(
    businessIds.map((id) => [id, legacyConfigOf(rows.filter((r) => r.legacyBusinessId === id))]),
  );
}

function legacyConfigOf(all: DestinationRow[]) {
  const rows = all.filter((r) => r.status !== "removed");
  const on = (k: NotificationKind) => rows.some((r) => r.kinds[k]?.on === true);
  const cfg: TeamAlertsConfig = {
    recipients: rows.map((r) => r.email!),
    overdue: {
      enabled: on("invoice_overdue"),
      thresholds: rows.find((r) => r.kinds.invoice_overdue?.on)?.kinds.invoice_overdue?.above ?? {},
    },
    webhookFailures: { enabled: on("webhook_failing") },
    dailyDigest: { enabled: rows.some((r) => r.daily) },
    largeGrants: { enabled: on("large_credit_grant") },
  };
  return serializeTeamAlertsConfig(cfg);
}

/**
 * A write of the old `team_alerts_config`: one email destination per recipient, limited to
 * this business. Members are active at once; outside addresses confirm by email. A recipient
 * left off the list is removed.
 */
export async function applyLegacyTeamAlertsConfig(
  organizationId: string,
  businessId: string,
  raw: unknown,
) {
  const cfg = resolveTeamAlertsConfig({ teamAlertsConfig: raw });
  const kinds = {
    invoice_overdue: {
      on: cfg.overdue.enabled,
      ...(Object.keys(cfg.overdue.thresholds).length ? { above: cfg.overdue.thresholds } : {}),
    },
    webhook_failing: { on: cfg.webhookFailures.enabled },
    large_credit_grant: { on: cfg.largeGrants.enabled },
  };
  const members = new Set<string>();
  for (const e of cfg.recipients) if (await isTeamAddress(organizationId, e)) members.add(e);
  const toConfirm = await withTenant(organizationId, async (tx) => {
    const rows = await legacyRows(tx, businessId);
    const byEmail = new Map(rows.map((r) => [r.email!, r]));
    const confirm: string[] = [];
    for (const email of cfg.recipients) {
      const prev = byEmail.get(email);
      const values = {
        kinds,
        daily: cfg.dailyDigest.enabled,
        businessFilter: { mode: "selected" as const, business_ids: [businessId] },
      };
      if (prev && prev.status !== "removed") {
        await tx
          .update(notificationDestinations)
          .set({ ...values, updatedAt: sql`app_now()` })
          .where(eq(notificationDestinations.id, prev.id));
        continue;
      }
      const status = members.has(email) ? "active" : "pending";
      const [r] = prev
        ? await tx
            .update(notificationDestinations)
            .set({ ...values, status, updatedAt: sql`app_now()` })
            .where(eq(notificationDestinations.id, prev.id))
            .returning()
        : await tx
            .insert(notificationDestinations)
            .values({
              organizationId,
              publicId: publicId("ndst"),
              type: "email",
              name: email,
              email,
              status,
              legacyBusinessId: businessId,
              ...values,
            })
            .returning();
      if (status === "pending") confirm.push(r!.publicId);
    }
    const drop = rows.filter((r) => r.status !== "removed" && !cfg.recipients.includes(r.email!));
    if (drop.length)
      await tx
        .update(notificationDestinations)
        .set({
          status: "removed",
          tokenHash: null,
          tokenExpiresAt: null,
          updatedAt: sql`app_now()`,
        })
        .where(
          inArray(
            notificationDestinations.id,
            drop.map((r) => r.id),
          ),
        );
    return confirm;
  });
  for (const id of toConfirm) await sendConfirmationQuietly(organizationId, id);
  return legacyTeamAlertsConfig(organizationId, businessId);
}

/** The old recipient list with states, for `GET …/team_alert_recipients`. */
export async function legacyRecipientStates(organizationId: string, businessId: string) {
  const rows = (await withTenant(organizationId, (tx) => legacyRows(tx, businessId))).filter(
    (r) => r.status !== "removed",
  );
  const out: Array<{
    email: string;
    state: "member" | "confirmed" | "pending";
    last_sent_at: string | null;
  }> = [];
  for (const r of rows)
    out.push({
      email: r.email!,
      state:
        r.status === "pending"
          ? "pending"
          : (await isTeamAddress(organizationId, r.email!))
            ? "member"
            : "confirmed",
      last_sent_at: r.lastSentAt?.toISOString() ?? null,
    });
  return out;
}

/** The old "Send again" by address. */
export async function legacyResend(organizationId: string, businessId: string, email: string) {
  const norm = email.trim().toLowerCase();
  const rows = await withTenant(organizationId, (tx) => legacyRows(tx, businessId));
  const row = rows.find((r) => r.email === norm && r.status !== "removed");
  if (!row)
    throw new NotificationError(
      `We could not send the email. ${norm} is not a team alert recipient.`,
      "not_found",
    );
  if (row.status !== "pending")
    throw new NotificationError(
      `We did not send the email. ${norm} is already confirmed.`,
      "not_pending",
    );
  await sendConfirmation(organizationId, row.publicId);
}
