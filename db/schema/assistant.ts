import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  smallint,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { businesses, organizations } from "./tenancy";

/** The in-app assistant (0505). All tenant rows behind RLS. */
export const assistantSettings = pgTable("assistant_settings", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** On by default (user decision 2026-11-06); an owner can switch it off. */
  enabled: boolean("enabled").notNull().default(true),
  /** Set with an own key: the organization's provider, model and key are used instead of ours. */
  provider: text("provider"), // openai | anthropic | google
  model: text("model"),
  apiKeyEncrypted: text("api_key_encrypted"),
  apiKeyLast4: text("api_key_last4"),
  /** 0507: the month ("2026-11") of the last 80% allowance email, so it goes once a month. */
  allowanceWarnedMonth: text("allowance_warned_month"),
  /** 0508: Billy may prepare changes the member confirms. Off until an owner turns it on. */
  actionsEnabled: boolean("actions_enabled").notNull().default(false),
  /** 0508: also refunds, collections, voids and write-offs (a second confirmation each time). */
  moneyActionsEnabled: boolean("money_actions_enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const assistantConversations = pgTable(
  "assistant_conversations",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // acv_…
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    /** The member's own conversation; others read it only while it is shared. */
    userId: uuid("user_id").notNull(),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    /** The last message. A rename, pin, archive or share does not move it. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    /** 0519: hidden from the main list; a new message clears it. Archiving unpins. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    /** 0519: members of the organization who can see the business may read it. */
    sharedAt: timestamp("shared_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("assistant_conversations_public_id_uq").on(t.publicId),
    index("assistant_conversations_member_idx").on(t.organizationId, t.userId, t.updatedAt),
    index("assistant_conversations_history_idx")
      .on(
        t.organizationId,
        t.userId,
        t.businessId,
        t.pinnedAt.desc().nullsLast(),
        t.updatedAt.desc(),
        t.id.desc(),
      )
      .where(sql`archived_at IS NULL`),
    index("assistant_conversations_archived_idx")
      .on(
        t.organizationId,
        t.userId,
        t.businessId,
        t.pinnedAt.desc().nullsLast(),
        t.updatedAt.desc(),
        t.id.desc(),
      )
      .where(sql`archived_at IS NOT NULL`),
  ],
);

export const assistantMessages = pgTable(
  "assistant_messages",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // amsg_…
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => assistantConversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // user | assistant
    content: text("content").notNull(),
    /** What the assistant read, as plain-language steps. */
    steps: jsonb("steps"),
    /** Rows behind the answer ("View data"), capped. */
    data: jsonb("data"),
    /** The figure check: figures found in the tool results, and those that were not. */
    figures: jsonb("figures"),
    /** The page and record the member was on. */
    page: jsonb("page"),
    /** 0508: follow-up suggestions, a question with options, a proposed action, attachments. */
    extras: jsonb("extras"),
    /** 0508: the member's rating of an answer, and an optional comment. */
    feedback: text("feedback"), // up | down
    feedbackComment: text("feedback_comment"),
    feedbackAt: timestamp("feedback_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("assistant_messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

/** Append-only: one row per answered turn. The monthly cap reads the platform-billed rows. */
export const assistantUsage = pgTable(
  "assistant_usage",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    conversationId: uuid("conversation_id").references(() => assistantConversations.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    billedTo: text("billed_to").notNull(), // platform | organization
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    /** USD minor units × 10^12, from the price book; null when the model is not priced. */
    costFixed12: numeric("cost_fixed12", { precision: 38, scale: 0 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("assistant_usage_org_created_idx").on(t.organizationId, t.createdAt)],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** 0508: a screenshot attached to a question. Deleted with the conversation, or after 90 days. */
export const assistantAttachments = pgTable(
  "assistant_attachments",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // att_…
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => assistantConversations.id, {
      onDelete: "cascade",
    }),
    userId: uuid("user_id").notNull(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(), // image/png | image/jpeg | image/webp
    size: integer("size").notNull(),
    data: bytea("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("assistant_attachments_public_id_uq").on(t.publicId),
    index("assistant_attachments_created_idx").on(t.createdAt),
  ],
);

/** 0508: a change Billy prepared, and what happened when the member confirmed it (or not). */
export const assistantActions = pgTable(
  "assistant_actions",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // aact_…
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => assistantConversations.id, {
      onDelete: "set null",
    }),
    userId: uuid("user_id").notNull(),
    operation: text("operation").notNull(),
    method: text("method").notNull(), // POST | PATCH | DELETE
    path: text("path").notNull(),
    body: jsonb("body"),
    tier: smallint("tier").notNull(),
    status: text("status").notNull(), // proposed | running | done | failed | cancelled | expired
    idempotencyKey: text("idempotency_key").notNull(),
    summary: jsonb("summary").notNull(),
    result: jsonb("result"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("assistant_actions_public_id_uq").on(t.publicId),
    index("assistant_actions_org_created_idx").on(t.organizationId, t.createdAt),
  ],
);

/**
 * 0512: a member's request to our support team, drafted by the assistant and sent by the member
 * (Cloud only). Our staff answer it from the back-office; the thread is `support_messages`.
 */
export const supportRequests = pgTable(
  "support_requests",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // sr_…
    /** The reference a member quotes: SR-<number>. */
    number: integer("number")
      .notNull()
      .default(sql`nextval('support_request_number_seq')`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    /** The member who sent it; only they read it in the dashboard. */
    userId: uuid("user_id").notNull(),
    /** The conversation it was drafted in, unless the member removed it from the request. */
    conversationId: uuid("conversation_id").references(() => assistantConversations.id, {
      onDelete: "set null",
    }),
    subject: text("subject").notNull(),
    status: text("status").notNull(), // open | waiting | resolved
    /** What the member chose to attach: page, records, a failed request, browser. */
    context: jsonb("context").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    lastMemberReplyAt: timestamp("last_member_reply_at", { withTimezone: true }),
    lastStaffReplyAt: timestamp("last_staff_reply_at", { withTimezone: true }),
    /** Set by a staff reply, cleared when the member reads the thread. */
    memberUnreadAt: timestamp("member_unread_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("support_requests_public_id_uq").on(t.publicId),
    uniqueIndex("support_requests_number_uq").on(t.number),
    uniqueIndex("support_requests_idempotency_uq").on(t.organizationId, t.userId, t.idempotencyKey),
    index("support_requests_member_idx").on(t.organizationId, t.userId, t.updatedAt),
    index("support_requests_status_idx").on(t.status, t.updatedAt),
  ],
);

/** 0512: one message in a support thread. Staff replies are shown as written, never to the model. */
export const supportMessages = pgTable(
  "support_messages",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // srm_…
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestId: uuid("request_id")
      .notNull()
      .references(() => supportRequests.id, { onDelete: "cascade" }),
    authorKind: text("author_kind").notNull(), // member | staff | system
    body: text("body").notNull(),
    /** Screenshots: assistant_attachments public ids with name, type and size. */
    attachments: jsonb("attachments"),
    /** The staff member who wrote a staff reply. Back-office only; members never see it. */
    staffBy: text("staff_by"),
    /** When the back-office told staff about a member message (claimed once, never re-sent). */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("support_messages_public_id_uq").on(t.publicId),
    index("support_messages_request_idx").on(t.requestId, t.createdAt),
    index("support_messages_unnotified_idx")
      .on(t.createdAt)
      .where(sql`notified_at IS NULL`),
  ],
);
