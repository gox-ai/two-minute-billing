import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  char,
  bigint,
  integer,
  boolean,
  jsonb,
  numeric,
  date,
  timestamp,
  uniqueIndex,
  index,
  primaryKey,
  foreignKey,
} from "drizzle-orm/pg-core";
import { organizations } from "./tenancy";

/**
 * A model in the AI price list (0455). Platform-global like `countries`: no tenant, no RLS,
 * read-only for the app role. Written by the `model_prices_sync` job only.
 */
export const modelPriceModels = pgTable(
  "model_price_models",
  {
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    name: text("name"),
    /** Exact-match aliases from the source (`match.equals`) only. */
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Context tiers as published: shown, not rated. */
    contextTiers: jsonb("context_tiers"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    /** Stops moving when the source drops the model. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ name: "model_price_models_pkey", columns: [t.provider, t.model] }),
    index("model_price_models_model_idx").on(t.model),
    index("model_price_models_aliases_idx").using("gin", t.aliases),
  ],
);

/**
 * Dated list prices (0455). Append-only: a change is a new row. The price at an instant is the
 * row with the greatest `effectiveFrom` at or before it; an invoice line cites its `publicId`.
 */
export const modelPrices = pgTable(
  "model_prices",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    /** mpr_… */
    publicId: text("public_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    /** input | output | cache_read | cache_write | … (open set from the source). */
    tokenType: text("token_type").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    /** Minor units per `quantityDivisor` units, ≤ 12 dp. "$3 per 1M" = "300" per 1000000. */
    unitAmountDecimal: numeric("unit_amount_decimal", { precision: 38, scale: 12 }).notNull(),
    quantityDivisor: bigint("quantity_divisor", { mode: "bigint" }).notNull(),
    /** Our applied-from instant; `-infinity` for a model's first price. */
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    source: text("source").notNull(),
    sourceVersion: text("source_version"),
    /** The source's own date, kept even when in the past. */
    sourceEffectiveFrom: date("source_effective_from"),
    sourceCheckedOn: date("source_checked_on"),
    /** More than 12 dp in minor units at the source: rounded half-up once. */
    rounded: boolean("rounded").notNull().default(false),
    syncRunId: uuid("sync_run_id").notNull(),
    /** Staff email that released a held batch; null when the sync applied it. */
    releasedBy: text("released_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "model_prices_model_fk",
      columns: [t.provider, t.model],
      foreignColumns: [modelPriceModels.provider, modelPriceModels.model],
    }),
    uniqueIndex("model_prices_public_id_uq").on(t.publicId),
    uniqueIndex("model_prices_key_from_uq").on(
      t.provider,
      t.model,
      t.tokenType,
      t.currency,
      t.effectiveFrom,
    ),
    index("model_prices_model_token_from_idx").on(t.model, t.tokenType, t.effectiveFrom.desc()),
    index("model_prices_sync_run_idx").on(t.syncRunId),
  ],
);

/**
 * Your cost (0456): provider prices an organization negotiated, dated. Organization-scoped
 * (RLS). The sync never touches it. Overlaps per key are refused by the
 * `model_cost_overrides_no_overlap` exclusion constraint (SQL only; Drizzle cannot declare it).
 */
export const modelCostOverrides = pgTable(
  "model_cost_overrides",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** mco_… */
    publicId: text("public_id").notNull(),
    /** NULL = this model under any provider. */
    provider: text("provider"),
    /** May name a model the list does not have. */
    model: text("model").notNull(),
    tokenType: text("token_type").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    /** Minor units per `quantityDivisor` units, ≤ 12 dp. */
    unitAmountDecimal: numeric("unit_amount_decimal", { precision: 38, scale: 12 }).notNull(),
    quantityDivisor: bigint("quantity_divisor", { mode: "bigint" })
      .notNull()
      .default(sql`1`),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    /** NULL = open-ended. */
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("model_cost_overrides_public_id_uq").on(t.publicId),
    index("model_cost_overrides_lookup_idx").on(
      t.organizationId,
      t.model,
      t.tokenType,
      t.effectiveFrom.desc(),
    ),
  ],
);

/** Price-change email per organization and sync run (0459); the unique row stops a resend. */
export const modelPriceNotices = pgTable(
  "model_price_notices",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    syncRunId: uuid("sync_run_id").notNull(),
    changes: jsonb("changes").$type<Array<Record<string, unknown>>>().notNull(),
    /** pending | sent | failed | skipped (no member holds model_prices:manage) */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("model_price_notices_org_run_uq").on(t.organizationId, t.syncRunId),
    index("model_price_notices_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`status = 'pending'`),
  ],
);
