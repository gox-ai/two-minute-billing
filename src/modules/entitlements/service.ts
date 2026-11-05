import { and, eq, inArray } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import {
  features,
  planEntitlements,
  subscriptionEntitlements,
  prices,
  products,
  subscriptionItems,
  subscriptions,
} from "@db/schema";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { createLogger } from "@/platform/logger";
import { parseFixed12 } from "@/platform/fixed";
import type { AllowanceReset, CreditReset } from "@db/schema";

const log = createLogger("entitlements");

export type FeatureType = "switch" | "quota" | "meter";

type Feature = typeof features.$inferSelect;

/** The feature as a webhook payload carries it (same fields as the API object). */
function featureEventResource(f: Feature): Record<string, unknown> {
  return {
    id: f.publicId,
    key: f.key,
    name: f.name,
    type: f.type,
    unit: f.unit,
    description: f.description,
    active: f.active,
  };
}

async function emitFeatureEvent(
  tx: Tx,
  type: "feature_created" | "feature_updated" | "feature_archived",
  f: Feature,
): Promise<void> {
  await emitEvent(tx, {
    organizationId: f.organizationId,
    businessId: f.businessId,
    type,
    data: buildEventData(type, featureEventResource(f)),
  });
}

// --- Feature catalog ---

export async function createFeature(input: {
  organizationId: string;
  businessId: string;
  key: string;
  name: string;
  type: FeatureType;
  unit?: string;
  description?: string;
  /** Meter features only: count this meter's usage (0467). */
  meterId?: string | null;
}): Promise<Feature> {
  return withTenant(input.organizationId, async (tx) => {
    const [f] = await tx
      .insert(features)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        publicId: publicId("feat"),
        key: input.key,
        name: input.name,
        type: input.type,
        unit: input.unit ?? null,
        description: input.description ?? null,
        meterId: input.meterId ?? null,
      })
      .returning();
    await emitFeatureEvent(tx, "feature_created", f!);
    return f!;
  });
}

export async function listFeatures(organizationId: string, businessId: string): Promise<Feature[]> {
  return withTenant(organizationId, async (tx) =>
    tx.select().from(features).where(eq(features.businessId, businessId)),
  );
}

export async function getFeatureByKey(
  organizationId: string,
  businessId: string,
  key: string,
): Promise<Feature | null> {
  return withTenant(organizationId, async (tx) => {
    const [f] = await tx
      .select()
      .from(features)
      .where(and(eq(features.businessId, businessId), eq(features.key, key)))
      .limit(1);
    return f ?? null;
  });
}

/** A feature by its public id (`feat_…`) or, failing that, its key. */
export async function getFeature(
  organizationId: string,
  businessId: string,
  idOrKey: string,
): Promise<Feature | null> {
  return withTenant(organizationId, async (tx) => {
    const [byId] = await tx
      .select()
      .from(features)
      .where(and(eq(features.businessId, businessId), eq(features.publicId, idOrKey)))
      .limit(1);
    if (byId) return byId;
    const [byKey] = await tx
      .select()
      .from(features)
      .where(and(eq(features.businessId, businessId), eq(features.key, idOrKey)))
      .limit(1);
    return byKey ?? null;
  });
}

/** Edit a feature's descriptive fields. `key` and `type` are fixed: grants are typed by them. */
export async function updateFeature(input: {
  organizationId: string;
  businessId: string;
  featureId: string;
  name?: string;
  unit?: string | null;
  description?: string | null;
  meterId?: string | null;
}): Promise<Feature | null> {
  const set: Partial<typeof features.$inferInsert> = {};
  if (input.meterId !== undefined) set.meterId = input.meterId;
  if (input.name !== undefined) set.name = input.name;
  if (input.unit !== undefined) set.unit = input.unit;
  if (input.description !== undefined) set.description = input.description;
  return withTenant(input.organizationId, async (tx) => {
    const where = and(eq(features.businessId, input.businessId), eq(features.id, input.featureId));
    const [f] = Object.keys(set).length
      ? await tx.update(features).set(set).where(where).returning()
      : await tx.select().from(features).where(where).limit(1);
    if (f && Object.keys(set).length) await emitFeatureEvent(tx, "feature_updated", f);
    return f ?? null;
  });
}

/**
 * Archive or reactivate a feature. An archived feature grants nothing: it drops out of
 * every subscription's effective entitlements and its checks answer `feature_archived`.
 * Grants are kept, so reactivating restores them unchanged.
 */
export async function setFeatureActive(
  organizationId: string,
  businessId: string,
  featureId: string,
  active: boolean,
): Promise<Feature | null> {
  return withTenant(organizationId, async (tx) => {
    const where = and(eq(features.businessId, businessId), eq(features.id, featureId));
    const [before] = await tx.select({ active: features.active }).from(features).where(where);
    const [f] = await tx.update(features).set({ active }).where(where).returning();
    // Only a real transition: archiving an archived feature changes no entitlement.
    if (f && before?.active !== active) {
      log.log(active ? "feature reactivated" : "feature archived", { businessId, feature: f.key });
      await emitFeatureEvent(tx, active ? "feature_updated" : "feature_archived", f);
    }
    return f ?? null;
  });
}

// --- Plan entitlements (feature × product → value) ---

export async function setPlanEntitlement(input: {
  organizationId: string;
  businessId: string;
  productId: string;
  featureId: string;
  value: string;
  /** G3b: undefined keeps the stored reset; null clears it. */
  reset?: AllowanceReset | null;
}): Promise<typeof planEntitlements.$inferSelect> {
  return withTenant(input.organizationId, async (tx) => {
    const [prior] = await tx
      .select({ value: planEntitlements.value })
      .from(planEntitlements)
      .where(
        and(
          eq(planEntitlements.productId, input.productId),
          eq(planEntitlements.featureId, input.featureId),
        ),
      )
      .limit(1);
    // Upsert on (product, feature) — re-attaching updates the granted value.
    const [e] = await tx
      .insert(planEntitlements)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        publicId: publicId("ent"),
        productId: input.productId,
        featureId: input.featureId,
        value: input.value,
        reset: input.reset ?? null,
      })
      .onConflictDoUpdate({
        target: [planEntitlements.productId, planEntitlements.featureId],
        set: { value: input.value, ...(input.reset !== undefined ? { reset: input.reset } : {}) },
      })
      .returning();
    // What a plan grants decides what every subscriber on it can do — a change here
    // shows up later as "why did this customer lose access", so record who/when.
    log.log("plan entitlement set", {
      businessId: input.businessId,
      product: input.productId,
      feature: input.featureId,
      value: input.value,
    });
    if (prior?.value !== e!.value) {
      const [ref] = await tx
        .select({ product: products.publicId, feature: features.key })
        .from(products)
        .innerJoin(features, eq(features.id, input.featureId))
        .where(eq(products.id, input.productId))
        .limit(1);
      await emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "plan_entitlement_set",
        data: buildEventData("plan_entitlement_set", {
          id: e!.publicId,
          product: ref?.product ?? null,
          feature: ref?.feature ?? null,
          value: e!.value,
          previous_value: prior?.value ?? null,
        }),
      });
    }
    return e!;
  });
}

export interface PlanEntitlementRow {
  entitlement: typeof planEntitlements.$inferSelect;
  feature: Feature;
}

/** A product's own grants (no merging, no overrides), by feature key. */
export async function listPlanEntitlements(
  organizationId: string,
  businessId: string,
  productId: string,
): Promise<PlanEntitlementRow[]> {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select({ entitlement: planEntitlements, feature: features })
      .from(planEntitlements)
      .innerJoin(features, eq(planEntitlements.featureId, features.id))
      .where(
        and(eq(planEntitlements.businessId, businessId), eq(planEntitlements.productId, productId)),
      );
    return rows.sort((a, b) => a.feature.key.localeCompare(b.feature.key));
  });
}

// --- Per-subscription overrides ---

export async function setSubscriptionEntitlement(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  featureId: string;
  value: string;
  /** G3b: undefined keeps the stored reset; null = the plan's. */
  reset?: AllowanceReset | null;
}): Promise<typeof subscriptionEntitlements.$inferSelect> {
  return withTenant(input.organizationId, async (tx) => {
    const [prior] = await tx
      .select({ value: subscriptionEntitlements.value })
      .from(subscriptionEntitlements)
      .where(
        and(
          eq(subscriptionEntitlements.subscriptionId, input.subscriptionId),
          eq(subscriptionEntitlements.featureId, input.featureId),
        ),
      )
      .limit(1);
    const [e] = await tx
      .insert(subscriptionEntitlements)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        publicId: publicId("sent"),
        subscriptionId: input.subscriptionId,
        featureId: input.featureId,
        value: input.value,
        reset: input.reset ?? null,
      })
      .onConflictDoUpdate({
        target: [subscriptionEntitlements.subscriptionId, subscriptionEntitlements.featureId],
        set: { value: input.value, ...(input.reset !== undefined ? { reset: input.reset } : {}) },
      })
      .returning();
    log.log("subscription entitlement override set", {
      businessId: input.businessId,
      subscription: input.subscriptionId,
      feature: input.featureId,
      value: input.value,
    });
    if (prior?.value !== e!.value) {
      const [ref] = await tx
        .select({ subscription: subscriptions.publicId, feature: features.key })
        .from(subscriptions)
        .innerJoin(features, eq(features.id, input.featureId))
        .where(eq(subscriptions.id, input.subscriptionId))
        .limit(1);
      await emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "subscription_entitlement_set",
        data: buildEventData("subscription_entitlement_set", {
          id: e!.publicId,
          subscription: ref?.subscription ?? null,
          feature: ref?.feature ?? null,
          value: e!.value,
          previous_value: prior?.value ?? null,
        }),
      });
    }
    return e!;
  });
}

// --- Resolution ---

const UNLIMITED = "unlimited";

export interface EffectiveEntitlement {
  feature_key: string;
  feature_name: string;
  type: FeatureType;
  unit: string | null;
  value: string;
  source: "plan" | "override";
  /**
   * G3b: the allowance's reset (override's, else the plan's), a credits link resolved for this
   * subscription; null = the invoice window.
   */
  reset: CreditReset | null;
}

/** Combine two granted values for the same feature (when a sub has multiple
 *  plans granting the same feature). switch: OR. quota/meter: max, unlimited wins. */
function mergeValue(type: FeatureType, a: string, b: string): string {
  if (type === "switch") {
    return a === "true" || b === "true" ? "true" : "false";
  }
  if (a === UNLIMITED || b === UNLIMITED) return UNLIMITED;
  const na = Number.parseInt(a, 10);
  const nb = Number.parseInt(b, 10);
  return String(Math.max(Number.isFinite(na) ? na : 0, Number.isFinite(nb) ? nb : 0));
}

/**
 * The effective entitlements for a subscription: union of plan entitlements
 * across all the subscription's items' products (merged per feature), with any
 * per-subscription override replacing the resolved value.
 */
export async function effectiveEntitlements(
  organizationId: string,
  subscriptionId: string,
): Promise<EffectiveEntitlement[]> {
  return withTenant(organizationId, async (tx) => {
    // 1) Products this subscription is on (via its items' prices).
    const itemRows = await tx
      .select({ productId: prices.productId })
      .from(subscriptionItems)
      .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
      .where(eq(subscriptionItems.subscriptionId, subscriptionId));
    const productIds = [...new Set(itemRows.map((r) => r.productId))];

    // 2) Plan entitlements for those products, joined to the feature.
    const planRows = productIds.length
      ? await tx
          .select({
            feature: features,
            productId: planEntitlements.productId,
            value: planEntitlements.value,
            reset: planEntitlements.reset,
          })
          .from(planEntitlements)
          .innerJoin(features, eq(planEntitlements.featureId, features.id))
          .where(inArray(planEntitlements.productId, productIds))
      : [];

    const { resolveAllowanceReset } = await import("@/modules/credits/allowance");
    // Merge per feature key.
    const byKey = new Map<string, EffectiveEntitlement>();
    for (const { feature, productId, value, reset: stored } of planRows) {
      if (!feature.active) continue;
      const reset = stored
        ? await resolveAllowanceReset(tx, subscriptionId, stored, [productId])
        : null;
      const existing = byKey.get(feature.key);
      if (existing) {
        existing.value = mergeValue(feature.type as FeatureType, existing.value, value);
        existing.reset ??= reset ?? null;
      } else {
        byKey.set(feature.key, {
          feature_key: feature.key,
          feature_name: feature.name,
          type: feature.type as FeatureType,
          unit: feature.unit,
          value,
          source: "plan",
          reset: reset ?? null,
        });
      }
    }

    // 3) Apply per-subscription overrides (replace value, mark source).
    const overrideRows = await tx
      .select({
        feature: features,
        value: subscriptionEntitlements.value,
        reset: subscriptionEntitlements.reset,
      })
      .from(subscriptionEntitlements)
      .innerJoin(features, eq(subscriptionEntitlements.featureId, features.id))
      .where(eq(subscriptionEntitlements.subscriptionId, subscriptionId));
    for (const { feature, value, reset: stored } of overrideRows) {
      if (!feature.active) continue;
      const planReset = byKey.get(feature.key)?.reset ?? null;
      const reset = stored
        ? await resolveAllowanceReset(
            tx,
            subscriptionId,
            stored,
            planRows.filter((r) => r.feature.id === feature.id).map((r) => r.productId),
          )
        : null;
      byKey.set(feature.key, {
        feature_key: feature.key,
        feature_name: feature.name,
        type: feature.type as FeatureType,
        unit: feature.unit,
        value,
        source: "override",
        reset: reset ?? planReset,
      });
    }

    return [...byKey.values()].sort((a, b) => a.feature_key.localeCompare(b.feature_key));
  });
}

export interface EntitlementCheck {
  feature_key: string;
  entitled: boolean;
  value: string | null;
  required: number | null;
  reason: string;
  /** A meter feature linked to a meter (0467): usage in its window, a decimal string. */
  used?: string;
  /** G3b: when that window resets (ISO); null = never. */
  resets_at?: string | null;
}

/**
 * Check whether a subscription is entitled to a feature, optionally against a
 * required amount (for quota/meter). switch → entitled iff value is "true".
 * quota/meter → entitled iff value is "unlimited" or value ≥ required (default 1).
 */
export async function checkEntitlement(
  organizationId: string,
  subscriptionId: string,
  key: string,
  required?: number,
): Promise<EntitlementCheck> {
  const ents = await effectiveEntitlements(organizationId, subscriptionId);
  const ent = ents.find((e) => e.feature_key === key);
  if (!ent) {
    const f = await withTenant(organizationId, async (tx) => {
      const [row] = await tx
        .select({ active: features.active })
        .from(features)
        .innerJoin(subscriptions, eq(subscriptions.businessId, features.businessId))
        .where(and(eq(subscriptions.id, subscriptionId), eq(features.key, key)))
        .limit(1);
      return row;
    });
    const reason = f && !f.active ? "feature_archived" : "not_granted";
    return { feature_key: key, entitled: false, value: null, required: required ?? null, reason };
  }
  if (ent.type === "switch") {
    const on = ent.value === "true";
    return {
      feature_key: key,
      entitled: on,
      value: ent.value,
      required: required ?? null,
      reason: on ? "granted" : "switch_off",
    };
  }
  // quota / meter
  const need = required ?? 1;
  if (ent.value === UNLIMITED) {
    return {
      feature_key: key,
      entitled: true,
      value: ent.value,
      required: need,
      reason: "unlimited",
    };
  }
  // A meter feature linked to a meter counts its reset window's usage against the limit.
  const use =
    ent.type === "meter" ? await meterFeatureUsed(organizationId, subscriptionId, key) : null;
  const used = use?.used ?? null;
  const value = use?.limit ?? ent.value;
  const limit = Number.parseInt(value, 10);
  const within =
    value === UNLIMITED ||
    (Number.isFinite(limit) &&
      (used == null
        ? need <= limit
        : parseFixed12(used) + parseFixed12(String(need)) <= parseFixed12(String(limit))));
  return {
    feature_key: key,
    entitled: within,
    value,
    required: need,
    reason: within ? "within_limit" : "over_limit",
    ...(used != null ? { used, resets_at: use?.resetsAt ?? null } : {}),
  };
}

/**
 * Usage of the meter a feature is linked to, in its reset window (G3b; none = this period),
 * with when it resets and the limit to check; null when the feature has no meter.
 */
async function meterFeatureUsed(
  organizationId: string,
  subscriptionId: string,
  key: string,
): Promise<{ used: string; resetsAt: string | null; limit: string | null } | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select({ meterId: features.meterId, sub: subscriptions })
      .from(features)
      .innerJoin(subscriptions, eq(subscriptions.businessId, features.businessId))
      .where(and(eq(subscriptions.id, subscriptionId), eq(features.key, key)))
      .limit(1);
    if (!row?.meterId) return null;
    const { meterFeature } = await import("@/modules/credits/access");
    const { allowanceUse } = await import("@/modules/credits/allowance");
    const { stampNow } = await import("@/platform/clock");
    const f = await meterFeature(tx, subscriptionId, row.meterId, key);
    return allowanceUse(tx, {
      customerId: row.sub.customerId,
      meterId: row.meterId,
      subscription: row.sub,
      featureId: f?.id ?? "",
      value: f?.value ?? null,
      reset: f?.reset ?? null,
      creditsItem: f?.creditsItem ?? null,
      now: stampNow(row.sub.businessId),
    });
  });
}
