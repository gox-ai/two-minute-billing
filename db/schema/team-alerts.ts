import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";

/**
 * A team alert recipient outside the organization (0495). Alerts reach it only once it is
 * `confirmed` through the emailed link. Only the hash of the single-use token is stored.
 * Removing the address from the list marks the row `removed`, so adding it back asks again;
 * the row stays so the send limit survives a remove and add.
 */
export const teamAlertRecipients = pgTable(
  "team_alert_recipients",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    /** Lower-cased. */
    email: text("email").notNull(),
    status: text("status").notNull().default("pending"), // pending | confirmed | removed
    tokenHash: text("token_hash"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    /** Confirmation mails sent since `sendWindowStart` (a rolling day). */
    sendCount: integer("send_count").notNull().default(0),
    sendWindowStart: timestamp("send_window_start", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("team_alert_recipients_biz_email_uq").on(t.businessId, t.email),
    uniqueIndex("team_alert_recipients_token_uq")
      .on(t.tokenHash)
      .where(sql`token_hash IS NOT NULL`),
    index("team_alert_recipients_email_sent_idx").on(t.email, t.lastSentAt),
  ],
);
