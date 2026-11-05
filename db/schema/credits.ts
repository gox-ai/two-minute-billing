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
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { customers } from "./customers";
import { invoices } from "./invoices";
import { subscriptionItems } from "./subscriptions";
import { meters } from "./meters";
import { users } from "./users";

/**
 * Ledger accounts for credit grants. Accounts are plain strings (no DDL); these are the names.
 *  - pending:      sold, invoice not yet paid
 *  - paid:         deferred revenue at cost basis
 *  - promotional:  granted face value
 *  - discount:     contra-revenue, face above cost basis
 *  - breakage:     revenue from expired paid credit
 */
export const CREDIT_LEDGER_ACCOUNTS = {
  pending: "credit_grants_pending",
  paid: "credit_grants_paid",
  promotional: "credit_grants_promotional",
  discount: "credit_grant_discount",
  breakage: "credit_breakage",
} as const;

export type CreditOnExhausted = "block" | "bill";
export type CreditTaxTreatment = "taxed_at_purchase" | "taxed_at_use";

/**
 * Which invoice lines a grant may pay: every usage line, the usage lines of these prices, or
 * of these meters (by key; every price that bills the meter, resolved when the grant draws).
 */
export type CreditApplicability =
  | { kind: "metered" }
  | { kind: "prices"; prices: string[] }
  | { kind: "meters"; meters: string[] };

/** `businesses.credit_config` (0464). Absent keys take the API's defaults. */
export type BusinessCreditConfig = {
  hold_default_seconds?: number;
  in_flight_share_bps?: number;
  blocking_enabled?: boolean;
  on_exhausted_default?: CreditOnExhausted;
  overdraft_limit_minor?: Record<string, number>;
  top_up_limits?: Record<string, { min_minor?: number; max_minor?: number }>;
  /** Free credit an operator gives, per grant: refuse above `max_minor`, alert above the other. */
  grant_limits?: Record<string, { max_minor?: number; alert_above_minor?: number }>;
  default_tax_treatment?: CreditTaxTreatment | null;
  /** Credit scope (2.55): narrows every grant scoped to all usage. Absent = no narrowing. */
  credit_scope?: Exclude<CreditApplicability, { kind: "metered" }> | null;
};

/** `customers.credit_settings` (0464): operator override, ignored after `override_expires_at`. */
export type CustomerCreditSettings = {
  on_exhausted?: CreditOnExhausted | null;
  overdraft_limit_minor?: Record<string, number>;
  override_expires_at?: string | null;
};

/** When credits or an allowance renew (G3b, 0497). Absent = once per billing term. */
export type CreditReset = {
  every: "hour" | "day" | "week" | "month" | "quarter" | "half_year" | "year" | "term" | "never";
  count?: number;
  anchor?: "subscription" | "calendar";
};

/** An allowance's reset; `{ same_as_credits: true }` follows the subscription's plan credits. */
export type AllowanceReset = CreditReset | { same_as_credits: true };

/** `prices.grants_credit` (0465): a pack on a one-time price, credits per cycle on a recurring one. */
export type PriceGrantsCredit =
  | {
      kind: "pack";
      unit: string | null;
      amount: number;
      category: "paid";
      priority?: number;
      expires_after: { days: number } | null;
      applicability?: CreditApplicability;
      tax_treatment?: CreditTaxTreatment | null;
      on_exhausted?: CreditOnExhausted | null;
    }
  | {
      kind: "per_cycle";
      unit: string | null;
      amount: number;
      priority?: number;
      applicability?: CreditApplicability;
      on_exhausted?: CreditOnExhausted | null;
      rollover?: {
        mode: "none" | "carry";
        percent?: number;
        cap?: number | null;
        expire_after_cycles?: number | null;
      };
      /** G3b: renew on this clock instead of each term (no hourly credits). */
      reset?: CreditReset;
      /** G3b: a partial first window; null = the business setting. */
      first_window?: "full" | "prorated" | "next_full_window" | null;
    };

/**
 * A business's own unit of credit (0460). Money is the implicit unit (`unit_id` NULL on a
 * grant). `key` is the catalog-family slug id. `locked_at` freezes currency, rate and decimals.
 */
export const creditUnits = pgTable(
  "credit_units",
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
    key: text("key").notNull(),
    name: text("name").notNull(),
    pluralName: text("plural_name").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    /** Minor units per unit × 10^12. */
    minorPerUnitE12: bigint("minor_per_unit_e12", { mode: "bigint" }).notNull(),
    /** 0–4: grant amounts are integers in 10^-decimals steps. */
    decimals: smallint("decimals").notNull().default(0),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [uniqueIndex("credit_units_business_key_uq").on(t.businessId, t.key)],
);

/**
 * One lot of credit for one customer (0461). Remaining = Σ its movements, never a column;
 * `status` is lifecycle: pending → active → expired | voided.
 * CHECKs: a paid grant has a tax treatment and an invoice (or restores one); `taxed_at_use`
 * only with money; source `restore` ⇔ `restored_from_id`.
 */
export const creditGrants = pgTable(
  "credit_grants",
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
    publicId: text("public_id").notNull(), // cgr_…
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    currency: char("currency", { length: 3 }).notNull(),
    /** NULL = money. */
    unitId: uuid("unit_id").references(() => creditUnits.id),
    /** Units in the unit's smallest step (money: minor units). */
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    faceMinor: bigint("face_minor", { mode: "bigint" }).notNull(),
    costBasisMinor: bigint("cost_basis_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** paid | promotional */
    category: text("category").notNull(),
    /** 0–100, lower draws first. */
    priority: smallint("priority").notNull().default(50),
    effectiveAt: timestamp("effective_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    applicability: jsonb("applicability")
      .$type<CreditApplicability>()
      .notNull()
      .default(sql`'{"kind": "metered"}'::jsonb`),
    /** purchase | plan_cycle | manual | restore | auto_top_up (API refuses until PR 3) */
    source: text("source").notNull(),
    sourceRef: text("source_ref"),
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    subscriptionItemId: uuid("subscription_item_id").references(() => subscriptionItems.id, {
      onDelete: "set null",
    }),
    restoredFromId: uuid("restored_from_id"),
    taxTreatment: text("tax_treatment").$type<CreditTaxTreatment>(),
    onExhausted: text("on_exhausted").$type<CreditOnExhausted>(),
    /** pending | active | expired | voided */
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("credit_grants_public_id_uq").on(t.publicId),
    uniqueIndex("credit_grants_source_ref_uq")
      .on(t.businessId, t.source, t.sourceRef)
      .where(sql`source_ref IS NOT NULL`),
    index("credit_grants_customer_live_idx")
      .on(t.customerId, t.currency)
      .where(sql`status IN ('active', 'expired')`),
    index("credit_grants_pending_idx")
      .on(t.status)
      .where(sql`status = 'pending'`),
    index("credit_grants_invoice_idx")
      .on(t.invoiceId)
      .where(sql`invoice_id IS NOT NULL`),
    index("credit_grants_expiry_idx")
      .on(t.expiresAt)
      .where(sql`status = 'active' AND expires_at IS NOT NULL`),
  ],
);

/**
 * Every change to a grant's units and money (0462). Append-only: the app role holds SELECT and
 * INSERT only. Into the grant (grant, restore, rollover_in) ≥ 0; out of it ≤ 0 (CHECK).
 */
export const creditGrantMovements = pgTable(
  "credit_grant_movements",
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
    publicId: text("public_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => creditGrants.id, { onDelete: "cascade" }),
    /** grant | draw | expire | void | restore | rollover_in | rollover_out | activate */
    kind: text("kind").notNull(),
    units: bigint("units", { mode: "bigint" }).notNull(),
    faceMinor: bigint("face_minor", { mode: "bigint" }).notNull(),
    costMinor: bigint("cost_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    invoiceId: uuid("invoice_id"),
    ledgerTransactionId: uuid("ledger_transaction_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("credit_grant_movements_public_id_uq").on(t.publicId),
    index("credit_grant_movements_grant_idx").on(t.grantId),
    index("credit_grant_movements_customer_created_idx").on(t.customerId, t.createdAt.desc()),
    index("credit_grant_movements_invoice_idx")
      .on(t.invoiceId)
      .where(sql`invoice_id IS NOT NULL`),
  ],
);

/**
 * An estimated cost reserved before a call (0463). A `held` row stops counting at
 * `expires_at`, before the pass marks it expired. `captured_minor` may exceed the hold.
 */
export const creditHolds = pgTable(
  "credit_holds",
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
    publicId: text("public_id").notNull(), // chd_…
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    currency: char("currency", { length: 3 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    meterId: uuid("meter_id").references(() => meters.id, { onDelete: "set null" }),
    /** {property: value}, as the access check's scope. */
    scope: jsonb("scope").$type<Record<string, string>>(),
    /** held | captured | released | expired */
    status: text("status").notNull().default("held"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    capturedMinor: bigint("captured_minor", { mode: "bigint" }),
    /** usage_events is partitioned: no foreign key. */
    usageEventId: uuid("usage_event_id"),
    overdraft: boolean("overdraft").notNull().default(false),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("credit_holds_public_id_uq").on(t.publicId),
    index("credit_holds_customer_held_idx")
      .on(t.customerId)
      .where(sql`status = 'held'`),
    index("credit_holds_expiry_idx")
      .on(t.expiresAt)
      .where(sql`status = 'held'`),
  ],
);
