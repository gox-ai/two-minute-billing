import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  char,
  bigint,
  smallint,
  boolean,
  jsonb,
  numeric,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { customers } from "./customers";
import { products } from "./catalog";
import { subscriptions } from "./subscriptions";
import { meters } from "./meters";
import { creditUnits } from "./credits";
import { invoices } from "./invoices";
import { payments } from "./payments";
import { paymentMethods } from "./payment-methods";
import { preDebitNotices } from "./pre-debit-notices";

/** Usage controls (Tier 3 PR 3, 0470–0477): spend limits, alerts, auto top-up, threshold invoicing. */

export type UsageControlInterval = "day" | "week" | "month" | "period";
export type SpendLimitScope = "customer" | "subscription" | "property";
export type SpendLimitMode = "hard" | "soft";
export type SpendLimitSetBy = "operator" | "customer";

/** `spend_limit_tiers.amounts`: minor units per interval. */
export type SpendLimitTierAmounts = Partial<Record<UsageControlInterval, number>>;

export type UsageAlertKind = "usage_quantity" | "spend" | "credit_balance" | "credit_runway";
export type UsageAlertThreshold = { value: number; unit: "minor" | "units" | "percent" | "days" };

export type AutoTopupTrigger = "threshold" | "schedule";
export type AutoTopupMethod = "fixed" | "target";
export type AutoTopupSchedule =
  | { every: "week"; weekday: number }
  | { every: "month"; day: number };
export type AutoTopupRunStatus =
  | "created"
  | "notice_sent"
  | "charging"
  | "pending"
  | "succeeded"
  | "failed"
  | "cancelled";
/** Open runs: at most one per config (`credit_auto_topup_runs_open_uq`). */
export const AUTO_TOPUP_OPEN_RUN_STATUSES = [
  "created",
  "notice_sent",
  "charging",
  "pending",
] as const;

/** `usage_invoice_thresholds.steps`: exactly one recurring entry today (CHECK). */
export type UsageInvoiceThresholdSteps = [{ amount_minor: number; recurring: true }];

/** `invoices.purpose` (0474). NULL = an ordinary invoice. */
export type InvoicePurpose = "usage_interim" | "credit_purchase";

/**
 * A spend limit (0470). Subscription scope ⇔ `subscription_id`; property scope ⇔
 * `property_key`; `property_value` NULL = each value. A buyer row (`set_by = customer`) is
 * hard and customer- or property-scoped (CHECK). One active row per subject, interval, mode
 * and setter (`spend_limits_subject_uq`).
 */
export const spendLimits = pgTable(
  "spend_limits",
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
    publicId: text("public_id").notNull(), // slim_…
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "cascade",
    }),
    scope: text("scope").$type<SpendLimitScope>().notNull(),
    propertyKey: text("property_key"),
    propertyValue: text("property_value"),
    /** NULL = all meters. */
    meterIds: uuid("meter_ids").array(),
    /** A SQL keyword: quote it in raw queries. */
    interval: text("interval").$type<UsageControlInterval>().notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    mode: text("mode").$type<SpendLimitMode>().notNull(),
    setBy: text("set_by").$type<SpendLimitSetBy>().notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("spend_limits_public_id_uq").on(t.publicId),
    uniqueIndex("spend_limits_subject_uq")
      .on(
        t.customerId,
        t.scope,
        sql`coalesce(${t.subscriptionId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`coalesce(${t.propertyKey}, '')`,
        sql`coalesce(${t.propertyValue}, '')`,
        sql`(${t.propertyValue} IS NULL)`,
        t.interval,
        t.mode,
        t.setBy,
      )
      .where(sql`active`),
  ],
);

/** A limit tier (0470): lifetime paid ≥ `level_minor` raises customer-scope limits. Archived, never deleted. */
export const spendLimitTiers = pgTable(
  "spend_limit_tiers",
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
    publicId: text("public_id").notNull(), // sltr_…
    currency: char("currency", { length: 3 }).notNull(),
    levelMinor: bigint("level_minor", { mode: "bigint" }).notNull(),
    amounts: jsonb("amounts").$type<SpendLimitTierAmounts>().notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("spend_limit_tiers_public_id_uq").on(t.publicId),
    uniqueIndex("spend_limit_tiers_level_uq")
      .on(t.businessId, t.currency, t.levelMinor)
      .where(sql`active`),
  ],
);

/** A tier a customer reached (0470). Append-only (SELECT, INSERT): the highest row wins, so tiers never demote. */
export const customerLimitTierReached = pgTable(
  "customer_limit_tier_reached",
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
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    tierId: uuid("tier_id")
      .notNull()
      .references(() => spendLimitTiers.id),
    currency: char("currency", { length: 3 }).notNull(),
    lifetimePaidMinor: bigint("lifetime_paid_minor", { mode: "bigint" }).notNull(),
    reachedAt: timestamp("reached_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("customer_limit_tier_reached_uq").on(t.customerId, t.tierId),
    index("customer_limit_tier_reached_customer_idx").on(t.customerId, t.currency),
    index("customer_limit_tier_reached_tier_idx").on(t.tierId),
  ],
);

/** A limit reached once per subject and interval (0470): the unique index makes the event fire once. */
export const spendLimitStates = pgTable(
  "spend_limit_states",
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
    limitId: uuid("limit_id")
      .notNull()
      .references(() => spendLimits.id, { onDelete: "cascade" }),
    subjectKey: text("subject_key").notNull(),
    intervalStart: timestamp("interval_start", { withTimezone: true }).notNull(),
    reachedAt: timestamp("reached_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [uniqueIndex("spend_limit_states_uq").on(t.limitId, t.subjectKey, t.intervalStart)],
);

/**
 * A usage alert (0471). Customer scope ⇔ `customer_id`; plan scope ⇔ `product_id`.
 * `interval` for usage and spend only; `currency` for every kind but usage; `unit_id` (NULL =
 * money) for balance and runway. 1–10 thresholds (CHECK).
 */
export const usageAlerts = pgTable(
  "usage_alerts",
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
    publicId: text("public_id").notNull(), // ualt_…
    kind: text("kind").$type<UsageAlertKind>().notNull(),
    /** customer | plan */
    scope: text("scope").$type<"customer" | "plan">().notNull(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    meterId: uuid("meter_id").references(() => meters.id),
    /** A SQL keyword: quote it in raw queries. */
    interval: text("interval").$type<UsageControlInterval>(),
    currency: char("currency", { length: 3 }),
    unitId: uuid("unit_id").references(() => creditUnits.id),
    thresholds: jsonb("thresholds").$type<UsageAlertThreshold[]>().notNull(),
    email: boolean("email").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("usage_alerts_public_id_uq").on(t.publicId),
    index("usage_alerts_customer_idx")
      .on(t.customerId)
      .where(sql`active AND customer_id IS NOT NULL`),
    index("usage_alerts_product_idx")
      .on(t.productId)
      .where(sql`active AND product_id IS NOT NULL`),
  ],
);

/**
 * One row per threshold that triggered in a period (0471); no row = armed. State is derived:
 * `resolved_at` set → resolved, else `triggered_at` set → triggered. `period_key` = the
 * interval start (usage, spend) or the calendar month start (balance, runway).
 */
export const usageAlertStates = pgTable(
  "usage_alert_states",
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
    alertId: uuid("alert_id")
      .notNull()
      .references(() => usageAlerts.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    subjectKey: text("subject_key").notNull(),
    periodKey: timestamp("period_key", { withTimezone: true }).notNull(),
    /** The threshold's value, as in `usage_alerts.thresholds`. */
    threshold: numeric("threshold").notNull(),
    lastValue: numeric("last_value"),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** Set exactly when `resolved_at` is (CHECK); e.g. recovered | period_ended. */
    resolveReason: text("resolve_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("usage_alert_states_uq").on(t.alertId, t.subjectKey, t.periodKey, t.threshold),
    index("usage_alert_states_customer_idx").on(t.customerId),
    index("usage_alert_states_open_idx")
      .on(t.periodKey)
      .where(sql`triggered_at IS NOT NULL AND resolved_at IS NULL`),
  ],
);

/** The last value seen per alert, subject and period (0471): the crossing compares against it. */
export const usageAlertObservations = pgTable(
  "usage_alert_observations",
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
    alertId: uuid("alert_id")
      .notNull()
      .references(() => usageAlerts.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    subjectKey: text("subject_key").notNull(),
    periodKey: timestamp("period_key", { withTimezone: true }).notNull(),
    lastValue: numeric("last_value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("usage_alert_observations_uq").on(t.alertId, t.subjectKey, t.periodKey),
    index("usage_alert_observations_customer_idx").on(t.customerId),
  ],
);

/**
 * Automatic top-up config (0472), one per customer, currency and unit (NULL = money).
 * threshold ⇔ `threshold_minor`; schedule ⇔ `schedule`; fixed ⇔ `amount_minor`; target ⇔
 * `target_minor`. Min / max per purchase come from `businesses.credit_config.top_up_limits`,
 * and the ₹15,000 card / UPI mandate clamp is applied per run. Disabled, never deleted.
 */
export const creditAutoTopups = pgTable(
  "credit_auto_topups",
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
    publicId: text("public_id").notNull(), // atu_…
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    currency: char("currency", { length: 3 }).notNull(),
    unitId: uuid("unit_id").references(() => creditUnits.id),
    trigger: text("trigger").$type<AutoTopupTrigger>().notNull(),
    thresholdMinor: bigint("threshold_minor", { mode: "bigint" }),
    schedule: jsonb("schedule").$type<AutoTopupSchedule>(),
    method: text("method").$type<AutoTopupMethod>().notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }),
    targetMinor: bigint("target_minor", { mode: "bigint" }),
    monthlyCapMinor: bigint("monthly_cap_minor", { mode: "bigint" }).notNull(),
    /** 1–10. */
    maxRunsPerDay: smallint("max_runs_per_day").notNull().default(3),
    /** NULL = the customer's charge order. */
    paymentMethodId: uuid("payment_method_id").references(() => paymentMethods.id, {
      onDelete: "set null",
    }),
    /** Grant settings passed to the credit purchase (priority, expiry, tax treatment, …). */
    grantConfig: jsonb("grant_config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** active | disabled */
    status: text("status").$type<"active" | "disabled">().notNull().default("active"),
    disabledReason: text("disabled_reason"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    /** Last `credit_auto_topup_threshold_low`, for once a week. */
    thresholdLowAt: timestamp("threshold_low_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("credit_auto_topups_public_id_uq").on(t.publicId),
    uniqueIndex("credit_auto_topups_customer_uq").on(
      t.customerId,
      t.currency,
      sql`coalesce(${t.unitId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    index("credit_auto_topups_active_idx")
      .on(t.businessId)
      .where(sql`status = 'active'`),
  ],
);

/**
 * One automatic top-up (0472). At most one open run per config; a schedule slot fires once
 * (`trigger_key`). `charge_after` plans the charge; a gateway notice gates execution on the
 * stored `pre_debit_notices.executable_after` / `expires_at`. Never deleted.
 */
export const creditAutoTopupRuns = pgTable(
  "credit_auto_topup_runs",
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
    publicId: text("public_id").notNull(), // atur_…
    configId: uuid("config_id")
      .notNull()
      .references(() => creditAutoTopups.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    trigger: text("trigger").$type<AutoTopupTrigger>().notNull(),
    /** Schedule: `sch:<YYYY-MM-DD>`. */
    triggerKey: text("trigger_key"),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    status: text("status").$type<AutoTopupRunStatus>().notNull().default("created"),
    /** The purchase invoice (`origin_token` `atu:<run public id>`). */
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),
    noticeId: uuid("notice_id").references(() => preDebitNotices.id, { onDelete: "set null" }),
    chargeAfter: timestamp("charge_after", { withTimezone: true }),
    declineCode: text("decline_code"),
    failureMessage: text("failure_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("credit_auto_topup_runs_public_id_uq").on(t.publicId),
    uniqueIndex("credit_auto_topup_runs_trigger_key_uq")
      .on(t.configId, t.triggerKey)
      .where(sql`trigger_key IS NOT NULL`),
    uniqueIndex("credit_auto_topup_runs_open_uq")
      .on(t.configId)
      .where(sql`status IN ('created', 'notice_sent', 'charging', 'pending')`),
    index("credit_auto_topup_runs_due_idx").on(t.status, t.chargeAfter),
    index("credit_auto_topup_runs_config_created_idx").on(t.configId, t.createdAt.desc()),
    index("credit_auto_topup_runs_customer_idx").on(t.customerId, t.createdAt.desc()),
    index("credit_auto_topup_runs_invoice_idx")
      .on(t.invoiceId)
      .where(sql`invoice_id IS NOT NULL`),
    index("credit_auto_topup_runs_payment_idx")
      .on(t.paymentId)
      .where(sql`payment_id IS NOT NULL`),
  ],
);

/**
 * Threshold invoicing config (0474). Plan scope ⇔ `product_id` (one per product and
 * currency); subscription scope ⇔ `subscription_id` (wins over the plan; inactive turns it
 * off). `steps` holds exactly one recurring entry (CHECK); NULL only on an inactive row.
 */
export const usageInvoiceThresholds = pgTable(
  "usage_invoice_thresholds",
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
    scope: text("scope").$type<"plan" | "subscription">().notNull(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "cascade",
    }),
    steps: jsonb("steps").$type<UsageInvoiceThresholdSteps>(),
    currency: char("currency", { length: 3 }).notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("usage_invoice_thresholds_plan_uq")
      .on(t.productId, t.currency)
      .where(sql`scope = 'plan'`),
    uniqueIndex("usage_invoice_thresholds_subscription_uq")
      .on(t.subscriptionId)
      .where(sql`scope = 'subscription'`),
  ],
);

/** Read-only widget bearer tokens (0476). Only the SHA-256 of `uwt_…` is stored. */
export const usageWidgetTokens = pgTable(
  "usage_widget_tokens",
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
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** API key public id that minted it. */
    createdBy: text("created_by"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("usage_widget_tokens_token_hash_uq").on(t.tokenHash),
    index("usage_widget_tokens_customer_idx").on(t.customerId),
    index("usage_widget_tokens_expires_idx").on(t.expiresAt),
  ],
);

/** When each customer was last evaluated by the on-arrival check (0477). */
export const usageControlCursors = pgTable("usage_control_cursors", {
  customerId: uuid("customer_id")
    .primaryKey()
    .references(() => customers.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  businessId: uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull(),
});

/**
 * The dirty set (0477). Insert-only with ON CONFLICT DO NOTHING (ingest, fold hook, config
 * writes); claimed with DELETE … RETURNING oldest first. The app role has no UPDATE.
 */
export const usageControlDirty = pgTable(
  "usage_control_dirty",
  {
    customerId: uuid("customer_id")
      .primaryKey()
      .references(() => customers.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    markedAt: timestamp("marked_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [index("usage_control_dirty_marked_idx").on(t.markedAt)],
);
