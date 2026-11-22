import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  bigint,
  jsonb,
  date,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { users } from "./users";

/**
 * Operator notifications (0533). Contract and pipeline: src/modules/notifications/README.md.
 * Replaces team alerts (`team_alert_recipients`, `businesses.team_alerts_config`).
 */

/** Per kind: timing, member channels, amount limits per currency (minor units). */
export type NotificationKindPref = {
  timing: "instant" | "summary" | "off";
  push: boolean;
  email: boolean;
  above?: Record<string, number>;
};

/** A member's settings for one organization: business NULL = the default for every business. */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** NULL = the organization default; set = this business's exceptions only. */
    businessId: uuid("business_id").references(() => businesses.id, { onDelete: "cascade" }),
    kinds: jsonb("kinds").$type<Record<string, NotificationKindPref>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("notification_preferences_default_uq")
      .on(t.organizationId, t.userId)
      .where(sql`business_id IS NULL`),
    uniqueIndex("notification_preferences_business_uq")
      .on(t.organizationId, t.userId, t.businessId)
      .where(sql`business_id IS NOT NULL`),
  ],
);

export type BusinessFilter = { mode: "all" } | { mode: "selected"; business_ids: string[] };
export type SummaryPref = { enabled: boolean; channels: Array<"push" | "email"> };

/** A member's per-organization switches: which businesses, the summaries. */
export const notificationSettingsOrg = pgTable(
  "notification_settings_org",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    businessFilter: jsonb("business_filter")
      .$type<BusinessFilter>()
      .notNull()
      .default({ mode: "all" }),
    daily: jsonb("daily")
      .$type<SummaryPref>()
      .notNull()
      .default({ enabled: true, channels: ["email"] }),
    weekly: jsonb("weekly")
      .$type<SummaryPref>()
      .notNull()
      .default({ enabled: false, channels: ["email"] }),
    sendEmpty: boolean("send_empty").notNull().default(false),
    /** The one-time "team alerts are now notifications" notice. */
    noticeDismissedAt: timestamp("notice_dismissed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [uniqueIndex("notification_settings_org_uq").on(t.organizationId, t.userId)],
);

export type QuietHours = { enabled: boolean; from: number; to: number; disputes_through: boolean };

/** Personal, across organizations: timezone, summary time, quiet hours. */
export const notificationSettings = pgTable("notification_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  timezone: text("timezone").notNull().default("UTC"),
  /** Local hour 0–23 for the daily summary (and the weekly one on `weeklyDay`). */
  summaryHour: integer("summary_hour").notNull().default(8),
  /** ISO weekday 1–7; 1 = Monday. */
  weeklyDay: integer("weekly_day").notNull().default(1),
  quiet: jsonb("quiet")
    .$type<QuietHours>()
    .notNull()
    .default({ enabled: false, from: 22, to: 7, disputes_through: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .default(sql`app_now()`)
    .notNull(),
});

/** A browser or installed app that accepts Web Push for this person. */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // psub_…
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    label: text("label"),
    userAgent: text("user_agent"),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    failureCount: integer("failure_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint_uq").on(t.endpoint),
    uniqueIndex("push_subscriptions_public_id_uq").on(t.publicId),
    index("push_subscriptions_user_idx").on(t.userId),
  ],
);

/** The bell (timing = instant) and the items a member reads in the summary (timing = summary). */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // ntf_…
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id").references(() => businesses.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    tone: text("tone").notNull(), // destructive | warning | neutral
    timing: text("timing").notNull(), // instant | summary
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** Dashboard path the row opens. */
    url: text("url"),
    record: jsonb("record").$type<{ type: string; id: string } | null>(),
    amountMinor: bigint("amount_minor", { mode: "number" }),
    currency: text("currency"),
    facts: jsonb("facts").$type<Record<string, unknown>>().notNull().default({}),
    eventId: uuid("event_id"),
    groupKey: text("group_key"),
    groupCount: integer("group_count").notNull().default(1),
    groupTotals: jsonb("group_totals").$type<Record<string, number>>(),
    test: boolean("test").notNull().default(false),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("notifications_public_id_uq").on(t.publicId),
    index("notifications_user_feed_idx").on(t.userId, t.organizationId, t.createdAt),
    index("notifications_unread_idx")
      .on(t.userId, t.organizationId)
      .where(sql`read_at IS NULL AND timing = 'instant'`),
    index("notifications_summary_idx")
      .on(t.organizationId, t.businessId, t.createdAt)
      .where(sql`timing = 'summary'`),
    index("notifications_created_idx").on(t.createdAt),
  ],
);

/** One row per matched event, clock fact or direct call, waiting for fan-out. */
export const notificationQueue = pgTable(
  "notification_queue",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id").references(() => businesses.id, { onDelete: "cascade" }),
    eventId: uuid("event_id"),
    dedupeKey: text("dedupe_key").notNull(),
    kinds: text("kinds").array().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("pending"), // pending | done | failed
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("notification_queue_dedupe_uq").on(t.dedupeKey),
    index("notification_queue_pending_idx")
      .on(t.nextAttemptAt)
      .where(sql`status = 'pending'`),
  ],
);

/** One send to one target on one channel. `dedupeKey` makes a retried job send once. */
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id"),
    channel: text("channel").notNull(), // push | email | chat | outside_email
    userId: uuid("user_id"),
    destinationId: uuid("destination_id"),
    pushSubscriptionId: uuid("push_subscription_id"),
    kind: text("kind").notNull(),
    notificationId: uuid("notification_id"),
    groupKey: text("group_key"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"), // pending | sent | failed | skipped | held
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("notification_deliveries_dedupe_uq").on(t.dedupeKey),
    index("notification_deliveries_pending_idx")
      .on(t.nextAttemptAt)
      .where(sql`status IN ('pending', 'held')`),
    index("notification_deliveries_destination_idx").on(t.destinationId, t.createdAt),
  ],
);

/** An open 5-minute burst window for one (target, business, kind). */
export const notificationGroups = pgTable(
  "notification_groups",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id"),
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(1),
    totals: jsonb("totals").$type<Record<string, number>>().notNull().default({}),
    firstNotificationIds: uuid("first_notification_ids")
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** Facts of the events after the first, up to 20 (0535); count and totals stay exact. */
    items: jsonb("items").$type<Array<Record<string, unknown>>>().notNull().default([]),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("notification_groups_open_uq")
      .on(t.key)
      .where(sql`closed_at IS NULL`),
    index("notification_groups_open_idx")
      .on(t.openedAt)
      .where(sql`closed_at IS NULL`),
  ],
);

export type DestinationKindPref = { on: boolean; above?: Record<string, number> };

/** Organization-level destinations: Google Chat spaces and outside email addresses. */
export const notificationDestinations = pgTable(
  "notification_destinations",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // ndst_…
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // chat | email
    name: text("name").notNull(),
    /** Google Chat webhook URL, `encryptSecret` envelope. Never returned. */
    urlEnc: text("url_enc"),
    urlHint: text("url_hint"),
    /** Lower-cased, for type = email. */
    email: text("email"),
    status: text("status").notNull(), // active | pending | not_working | removed
    tokenHash: text("token_hash"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    sendCount: integer("send_count").notNull().default(0),
    sendWindowStart: timestamp("send_window_start", { withTimezone: true }),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    businessFilter: jsonb("business_filter")
      .$type<BusinessFilter>()
      .notNull()
      .default({ mode: "all" }),
    kinds: jsonb("kinds").$type<Record<string, DestinationKindPref>>().notNull().default({}),
    daily: boolean("daily").notNull().default(false),
    weekly: boolean("weekly").notNull().default(false),
    hideNames: boolean("hide_names").notNull().default(false),
    failureStreak: integer("failure_streak").notNull().default(0),
    lastError: text("last_error"),
    /** Set only by the deprecated team-alerts API adapter. */
    legacyBusinessId: uuid("legacy_business_id"),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("notification_destinations_public_id_uq").on(t.publicId),
    uniqueIndex("notification_destinations_token_uq")
      .on(t.tokenHash)
      .where(sql`token_hash IS NOT NULL`),
    index("notification_destinations_org_idx").on(t.organizationId, t.status),
    index("notification_destinations_email_sent_idx").on(t.email, t.lastSentAt),
  ],
);

/** A built daily or weekly summary for one business and period. */
export const notificationDigests = pgTable(
  "notification_digests",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // nsum_…
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    period: text("period").notNull(), // daily | weekly
    periodStart: date("period_start").notNull(),
    parts: jsonb("parts").$type<Record<string, unknown>>().notNull(),
    builtAt: timestamp("built_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("notification_digests_period_uq").on(t.businessId, t.period, t.periodStart),
    uniqueIndex("notification_digests_public_id_uq").on(t.publicId),
  ],
);
