import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { products } from "./catalog";
import { subscriptions } from "./subscriptions";
import { meters } from "./meters";
import type { AllowanceReset } from "./credits";

/**
 * A Feature is a named capability a plan can grant (business-scoped catalog),
 * the basis of entitlements / feature-gating.
 *  - switch: boolean on/off (e.g. "sso", "api_access")
 *  - quota:  a static numeric limit (e.g. "max_projects" = 10)
 *  - meter:  a numeric allowance meant to be consumed (e.g. "monthly_api_calls")
 * `key` is the stable machine identifier the customer's app checks against.
 */
export const features = pgTable(
  "features",
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
    publicId: text("public_id").notNull(), // feat_…
    key: text("key").notNull(), // stable machine key, unique per business
    name: text("name").notNull(),
    type: text("type").notNull(), // switch | quota | meter
    unit: text("unit"), // optional display unit for quota/meter (e.g. "projects")
    // 0467, meter features: counts usage from this meter. NULL = today's answer.
    meterId: uuid("meter_id").references(() => meters.id),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("features_public_id_uq").on(t.publicId),
    uniqueIndex("features_business_key_uq").on(t.businessId, t.key),
    index("features_business_idx").on(t.businessId),
    index("features_meter_idx")
      .on(t.meterId)
      .where(sql`meter_id IS NOT NULL`),
  ],
);

/**
 * A plan entitlement attaches a Feature to a Product (the "plan") with a granted
 * value. value semantics by feature type:
 *  - switch: "true" / "false"
 *  - quota/meter: an integer string, or "unlimited"
 * Effective entitlements for a subscription are resolved from the plan
 * entitlements of all its items' products, then overridden per-subscription.
 */
export const planEntitlements = pgTable(
  "plan_entitlements",
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
    publicId: text("public_id").notNull(), // ent_…
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    featureId: uuid("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    /** G3b (0497), meter features: a reset or the credits link. Null = the next invoice's window. */
    reset: jsonb("reset").$type<AllowanceReset>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("plan_entitlements_public_id_uq").on(t.publicId),
    uniqueIndex("plan_entitlements_product_feature_uq").on(t.productId, t.featureId),
    index("plan_entitlements_business_idx").on(t.businessId),
  ],
);

/**
 * A per-subscription override of a feature's granted value — for custom deals
 * (e.g. this customer negotiated max_projects=100 on the Pro plan). Takes
 * precedence over the plan entitlement during resolution.
 */
export const subscriptionEntitlements = pgTable(
  "subscription_entitlements",
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
    publicId: text("public_id").notNull(), // sent_…
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    featureId: uuid("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    /** G3b (0497): overrides the plan's reset when set. */
    reset: jsonb("reset").$type<AllowanceReset>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("subscription_entitlements_public_id_uq").on(t.publicId),
    uniqueIndex("subscription_entitlements_sub_feature_uq").on(t.subscriptionId, t.featureId),
    index("subscription_entitlements_business_idx").on(t.businessId),
  ],
);
