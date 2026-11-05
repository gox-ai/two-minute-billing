import { supportsMonthlyUsage } from "@/modules/subscriptions/interval";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { countExpr, type FilterSpec, type ListPage } from "@/platform/list-query";
import { planPage, finishPage, type CatalogPageRequest } from "./paging";
import { withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createLogger } from "@/platform/logger";
import { newPriceTaxBehavior } from "@/modules/tax/settings";
import { VersionConflictError } from "@/api/helpers";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import {
  isOverridable,
  cadenceMultiple,
  tierListIssues,
  usagePricingIssues,
  type MeterTier,
  type PriceTier,
  type TierIssue,
  type UsageAggregation,
  type UsageTimeUnit,
} from "./pricing";
import { isFrequencyAllowed, type BillingFrequency } from "@/modules/tenancy/service";
import {
  assertMeterPrice,
  meterForPrice,
  replacePriceRates,
  type PriceRateInput,
} from "./meter-prices";
import { auditRowChange } from "@/modules/audit/service";
import {
  attachedItems,
  businesses,
  differentialPrices,
  meters,
  priceRates,
  prices,
  products,
  productGroups,
  type PriceGrantsCredit,
  subscriptionItems,
} from "@db/schema";

const log = createLogger("catalog");

export type ProductKind = "plan" | "addon" | "charge";

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "item"
  );
}

// Case-PRESERVING id rule: imported catalog ids are commonly mixed-case
// (e.g. `pro-v202303-USD-Monthly`). Id-stable migration
// ([[id-stable-migration]]) stores them verbatim, so uppercase is accepted here.
// `slugify()` (name-derived fallback, no explicit id) still lowercases.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function validateSlug(id: string): boolean {
  return SLUG_RE.test(id);
}

/** A catalog/coupon slug id is already taken (plan §0.1: collisions are 409, not 400). */
export class SlugConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlugConflictError";
  }
}

/** Postgres unique-constraint violation — races on the (business_id, public_id) index. */
export function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

/** Run an insert, converting a unique-index race into the same 409 as a pre-checked collision. */
export async function insertOrSlugConflict<T>(fn: () => Promise<T>, what: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isUniqueViolation(e)) throw new SlugConflictError(`${what} id is already in use`);
    throw e;
  }
}

async function uniqueSlug(
  tx: Tx,
  businessId: string,
  table: any,
  field: any,
  base: string,
): Promise<string> {
  let slug = base;
  let n = 1;
  while (true) {
    const [existing] = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.businessId, businessId), eq(field, slug)))
      .limit(1);
    if (!existing) return slug;
    n++;
    slug = `${base}-${n}`;
  }
}

// ─── Product Groups (Phase 13) ──────────────────────────────────────────────
// A Product Group sub-groups a business's products. Every product belongs to
// exactly one group; a per-business "Default" group (publicId='default') exists
// so the layer is invisible until used.

export type ProductGroup = typeof productGroups.$inferSelect;

/**
 * Get-or-create the business's "Default" group (publicId='default'). Race-safe via the
 * unique (business_id, public_id) index. Runs inside an existing tenant transaction.
 */
export async function ensureDefaultGroup(
  organizationId: string,
  businessId: string,
  tx: Tx,
): Promise<ProductGroup> {
  const found = await tx
    .select()
    .from(productGroups)
    .where(and(eq(productGroups.businessId, businessId), eq(productGroups.publicId, "default")))
    .limit(1);
  if (found[0]) return found[0];
  await tx
    .insert(productGroups)
    .values({
      organizationId,
      businessId,
      publicId: "default",
      name: "Default",
      description: "Default product group.",
    })
    .onConflictDoNothing({ target: [productGroups.businessId, productGroups.publicId] });
  const [g] = await tx
    .select()
    .from(productGroups)
    .where(and(eq(productGroups.businessId, businessId), eq(productGroups.publicId, "default")))
    .limit(1);
  return g!;
}

export async function createProductGroup(input: {
  organizationId: string;
  businessId: string;
  name: string;
  id?: string;
  description?: string;
}): Promise<ProductGroup> {
  return withTenant(input.organizationId, async (tx) => {
    let slug: string;
    if (input.id) {
      if (!validateSlug(input.id)) throw new CatalogError(`Invalid slug format: ${input.id}`);
      const [existing] = await tx
        .select({ id: productGroups.id })
        .from(productGroups)
        .where(
          and(eq(productGroups.businessId, input.businessId), eq(productGroups.publicId, input.id)),
        )
        .limit(1);
      if (existing) throw new SlugConflictError(`Product group id is already in use: ${input.id}`);
      slug = input.id;
    } else {
      slug = await uniqueSlug(
        tx,
        input.businessId,
        productGroups,
        productGroups.publicId,
        slugify(input.name),
      );
    }
    const [g] = await insertOrSlugConflict(
      () =>
        tx
          .insert(productGroups)
          .values({
            organizationId: input.organizationId,
            businessId: input.businessId,
            publicId: slug,
            name: input.name,
            description: input.description ?? null,
          })
          .returning(),
      "Product group",
    );
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "product_group_created",
      data: buildEventData(
        "product_group_created",
        { id: g!.publicId, name: g!.name },
        g!.resourceVersion,
      ),
    });
    await auditRowChange(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: "product_group.create",
      resourceType: "product_group",
      resourceId: g!.publicId,
      before: null,
      after: g!,
    });
    return g!;
  });
}

/** Edit a group's mutable fields (name/description). Only provided fields change. */
export async function updateProductGroup(input: {
  organizationId: string;
  businessId: string;
  groupPublicId: string;
  name?: string;
  description?: string | null;
}): Promise<ProductGroup | null> {
  return withTenant(input.organizationId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(productGroups)
      .where(
        and(
          eq(productGroups.businessId, input.businessId),
          eq(productGroups.publicId, input.groupPublicId),
        ),
      )
      .limit(1);
    if (!existing) return null;
    const set: Partial<typeof productGroups.$inferInsert> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.description !== undefined) set.description = input.description;
    if (Object.keys(set).length === 0) return existing;
    const [g] = await tx
      .update(productGroups)
      .set(set)
      .where(eq(productGroups.id, existing.id))
      .returning();
    if (g) {
      await emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "product_group_updated",
        data: buildEventData(
          "product_group_updated",
          { id: g.publicId, name: g.name },
          g.resourceVersion,
        ),
      });
      await auditRowChange(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        action: "product_group.update",
        resourceType: "product_group",
        resourceId: g.publicId,
        before: existing,
        after: g,
      });
    }
    return g ?? null;
  });
}

/**
 * Soft-archive (active=false) or restore (active=true) a group. Archiving is blocked
 * while the group has active products, and the per-business Default group can't be archived.
 */
export async function setProductGroupActive(
  organizationId: string,
  businessId: string,
  groupPublicId: string,
  active: boolean,
): Promise<ProductGroup | null> {
  return withTenant(organizationId, async (tx) => {
    const [g] = await tx
      .select()
      .from(productGroups)
      .where(
        and(eq(productGroups.businessId, businessId), eq(productGroups.publicId, groupPublicId)),
      )
      .limit(1);
    if (!g) return null;
    if (!active) {
      if (g.publicId === "default")
        throw new CatalogError("You cannot archive the Default product group");
      const active1 = await tx
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.productGroupId, g.id), eq(products.active, true)))
        .limit(1);
      if (active1.length) {
        throw new CatalogError("You cannot archive a product group that still has active products");
      }
    }
    const [updated] = await tx
      .update(productGroups)
      .set({ active })
      .where(eq(productGroups.id, g.id))
      .returning();
    if (updated) {
      const type = active ? "product_group_updated" : "product_group_archived";
      await emitEvent(tx, {
        organizationId,
        businessId,
        type,
        data: buildEventData(
          type,
          { id: updated.publicId, name: updated.name, active: updated.active },
          updated.resourceVersion,
        ),
      });
      await auditRowChange(tx, {
        organizationId,
        businessId,
        action: active ? "product_group.restore" : "product_group.archive",
        resourceType: "product_group",
        resourceId: updated.publicId,
        before: g,
        after: updated,
      });
    }
    return updated ?? null;
  });
}

export async function listProductGroups(
  organizationId: string,
  businessId: string,
  opts?: { includeArchived?: boolean },
): Promise<ProductGroup[]> {
  return withTenant(organizationId, async (tx) => {
    const where = opts?.includeArchived
      ? eq(productGroups.businessId, businessId)
      : and(eq(productGroups.businessId, businessId), eq(productGroups.active, true));
    return tx.select().from(productGroups).where(where).orderBy(desc(productGroups.createdAt));
  });
}

export async function getProductGroupByPublicId(
  organizationId: string,
  businessId: string,
  groupPublicId: string,
): Promise<ProductGroup | null> {
  return withTenant(organizationId, async (tx) => {
    const [g] = await tx
      .select()
      .from(productGroups)
      .where(
        and(eq(productGroups.businessId, businessId), eq(productGroups.publicId, groupPublicId)),
      )
      .limit(1);
    return g ?? null;
  });
}

export type ProductWithGroup = typeof products.$inferSelect & { groupPublicId: string };

/** Product fields shared by create + update (CP-5 depth). */
export interface ProductFields {
  name?: string;
  externalName?: string | null;
  description?: string | null;
  kind?: ProductKind;
  unitOfMeasure?: string | null;
  metered?: boolean;
  enabledForCheckout?: boolean;
  enabledInPortal?: boolean;
  redirectUrl?: string | null;
  /** HSN/SAC classification (India GST); null falls back to `businesses.default_tax_code`. */
  taxCode?: string | null;
  addonAppliesToAll?: boolean;
  metadata?: Record<string, unknown> | null;
  /** Set only by the image route, with a URL it stored; never from a request body. */
  imageUrl?: string | null;
}

export async function createProduct(
  input: {
    organizationId: string;
    businessId: string;
    name: string;
    /** Optional human-readable slug id. Auto-generated from name if omitted. */
    id?: string;
    /** Group to file under (public id). Defaults to the business's "Default" group. */
    productGroupPublicId?: string;
  } & ProductFields,
): Promise<ProductWithGroup> {
  return withTenant(input.organizationId, async (tx) => {
    let slug: string;
    if (input.id) {
      if (!validateSlug(input.id)) throw new CatalogError(`Invalid slug format: ${input.id}`);
      const [existing] = await tx
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.businessId, input.businessId), eq(products.publicId, input.id)))
        .limit(1);
      if (existing) throw new SlugConflictError(`Product id is already in use: ${input.id}`);
      slug = input.id;
    } else {
      slug = await uniqueSlug(
        tx,
        input.businessId,
        products,
        products.publicId,
        slugify(input.name),
      );
    }
    const group = await resolveGroup(
      tx,
      input.organizationId,
      input.businessId,
      input.productGroupPublicId,
    );
    const [p] = await insertOrSlugConflict(
      () =>
        tx
          .insert(products)
          .values({
            organizationId: input.organizationId,
            businessId: input.businessId,
            productGroupId: group.id,
            publicId: slug,
            name: input.name,
            externalName: input.externalName ?? null,
            description: input.description ?? null,
            kind: input.kind ?? "plan",
            unitOfMeasure: input.unitOfMeasure ?? null,
            metered: input.metered ?? false,
            enabledForCheckout: input.enabledForCheckout ?? false,
            enabledInPortal: input.enabledInPortal ?? false,
            redirectUrl: input.redirectUrl ?? null,
            taxCode: input.taxCode ?? null,
            addonAppliesToAll: input.addonAppliesToAll ?? false,
            metadata: input.metadata ?? null,
          })
          .returning(),
      "Product",
    );
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "product_created",
      data: buildEventData(
        "product_created",
        { id: p!.publicId, name: p!.name, kind: p!.kind },
        p!.resourceVersion,
      ),
    });
    await auditRowChange(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: "product.create",
      resourceType: "product",
      resourceId: p!.publicId,
      before: null,
      after: p!,
      extra: { productGroup: group.publicId },
    });
    return { ...p!, groupPublicId: group.publicId };
  });
}

/** Resolve a group by public id (must exist in the business), or the Default group. */
async function resolveGroup(
  tx: Tx,
  organizationId: string,
  businessId: string,
  groupPublicId: string | undefined,
): Promise<ProductGroup> {
  if (!groupPublicId) return ensureDefaultGroup(organizationId, businessId, tx);
  const [g] = await tx
    .select()
    .from(productGroups)
    .where(and(eq(productGroups.businessId, businessId), eq(productGroups.publicId, groupPublicId)))
    .limit(1);
  if (!g) throw new CatalogError(`We could not find the product group ${groupPublicId}.`);
  return g;
}

/** Edit a product's mutable fields (incl. moving it to another group). Only provided fields change. */
export async function updateProduct(
  input: {
    organizationId: string;
    businessId: string;
    productPublicId: string;
    expectedVersion?: number;
    /** Move the product to a different group (public id). */
    productGroupPublicId?: string;
  } & ProductFields,
): Promise<ProductWithGroup | null> {
  const set: Partial<typeof products.$inferInsert> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.externalName !== undefined) set.externalName = input.externalName;
  if (input.description !== undefined) set.description = input.description;
  if (input.kind !== undefined) set.kind = input.kind;
  if (input.unitOfMeasure !== undefined) set.unitOfMeasure = input.unitOfMeasure;
  if (input.metered !== undefined) set.metered = input.metered;
  if (input.enabledForCheckout !== undefined) set.enabledForCheckout = input.enabledForCheckout;
  if (input.enabledInPortal !== undefined) set.enabledInPortal = input.enabledInPortal;
  if (input.redirectUrl !== undefined) set.redirectUrl = input.redirectUrl;
  if (input.taxCode !== undefined) set.taxCode = input.taxCode;
  if (input.addonAppliesToAll !== undefined) set.addonAppliesToAll = input.addonAppliesToAll;
  if (input.metadata !== undefined) set.metadata = input.metadata;
  if (input.imageUrl !== undefined) set.imageUrl = input.imageUrl;
  return withTenant(input.organizationId, async (tx) => {
    if (input.expectedVersion !== undefined) {
      const [cur] = await tx
        .select({ v: products.resourceVersion })
        .from(products)
        .where(
          and(
            eq(products.businessId, input.businessId),
            eq(products.publicId, input.productPublicId),
          ),
        )
        .limit(1);
      if (cur && cur.v !== input.expectedVersion)
        throw new VersionConflictError(input.expectedVersion, cur.v);
    }
    if (input.productGroupPublicId !== undefined) {
      const group = await resolveGroup(
        tx,
        input.organizationId,
        input.businessId,
        input.productGroupPublicId,
      );
      set.productGroupId = group.id;
    }
    const where = and(
      eq(products.businessId, input.businessId),
      eq(products.publicId, input.productPublicId),
    );
    const [before] = await tx.select().from(products).where(where).limit(1);
    const row =
      Object.keys(set).length === 0 || !before
        ? before
        : (await tx.update(products).set(set).where(where).returning())[0];
    if (!row) return null;
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "product_updated",
      data: buildEventData(
        "product_updated",
        { id: row.publicId, name: row.name, kind: row.kind },
        row.resourceVersion,
      ),
    });
    const groupPublicId = await groupPublicIdById(tx, row.productGroupId);
    await auditRowChange(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: "product.update",
      resourceType: "product",
      resourceId: row.publicId,
      before: { ...before!, productGroup: await groupPublicIdById(tx, before!.productGroupId) },
      after: { ...row, productGroup: groupPublicId },
    });
    return { ...row, groupPublicId };
  });
}

/** Resolve a group's public id from its internal id (for serializing product responses). */
async function groupPublicIdById(tx: Tx, groupId: string): Promise<string> {
  const [g] = await tx
    .select({ publicId: productGroups.publicId })
    .from(productGroups)
    .where(eq(productGroups.id, groupId))
    .limit(1);
  return g?.publicId ?? "";
}

/** Soft-archive (active=false) or restore (active=true) a product. */
export async function setProductActive(
  organizationId: string,
  businessId: string,
  productPublicId: string,
  active: boolean,
): Promise<typeof products.$inferSelect | null> {
  return withTenant(organizationId, async (tx) => {
    const where = and(eq(products.businessId, businessId), eq(products.publicId, productPublicId));
    const [before] = await tx.select().from(products).where(where).limit(1);
    const [p] = await tx.update(products).set({ active }).where(where).returning();
    if (p) {
      await auditRowChange(tx, {
        organizationId,
        businessId,
        action: active ? "product.restore" : "product.archive",
        resourceType: "product",
        resourceId: p.publicId,
        before: before ?? null,
        after: p,
      });
      const type = active ? "product_updated" : "product_archived";
      await emitEvent(tx, {
        organizationId,
        businessId,
        type,
        data: buildEventData(
          type,
          { id: p.publicId, name: p.name, active: p.active },
          p.resourceVersion,
        ),
      });
    }
    return p ?? null;
  });
}

export async function listProducts(
  organizationId: string,
  businessId: string,
  opts?: { includeArchived?: boolean; groupId?: string; kind?: string },
): Promise<Array<typeof products.$inferSelect>> {
  return withTenant(organizationId, async (tx) => {
    const conds = [eq(products.businessId, businessId)];
    if (!opts?.includeArchived) conds.push(eq(products.active, true));
    if (opts?.groupId) conds.push(eq(products.productGroupId, opts.groupId));
    if (opts?.kind) conds.push(eq(products.kind, opts.kind)); // CAT-8: filter by kind
    return tx
      .select()
      .from(products)
      .where(and(...conds))
      .orderBy(desc(products.createdAt));
  });
}

export async function getProductByPublicId(
  organizationId: string,
  businessId: string,
  productPublicId: string,
): Promise<typeof products.$inferSelect | null> {
  return withTenant(organizationId, async (tx) => {
    const [p] = await tx
      .select()
      .from(products)
      .where(and(eq(products.businessId, businessId), eq(products.publicId, productPublicId)))
      .limit(1);
    return p ?? null;
  });
}

export async function getPriceByPublicId(
  organizationId: string,
  businessId: string,
  pricePublicId: string,
): Promise<typeof prices.$inferSelect | null> {
  return withTenant(organizationId, async (tx) => {
    const [pr] = await tx
      .select()
      .from(prices)
      .where(and(eq(prices.businessId, businessId), eq(prices.publicId, pricePublicId)))
      .limit(1);
    return pr ?? null;
  });
}

export type { PriceTier } from "./pricing";

export type PriceModel =
  | "flat"
  | "per_unit"
  | "tiered"
  | "volume"
  | "stairstep"
  | "usage"
  | "package"
  | "percentage"
  | "graduated_percentage";

export interface CreatePriceInput {
  organizationId: string;
  businessId: string;
  productId: string;
  /** Optional human-readable slug id. Auto-generated if omitted. */
  id?: string;
  type: "recurring" | "one_time";
  model: PriceModel;
  currency: string;
  name?: string;
  amountMinor?: number;
  interval?: "day" | "week" | "month" | "year";
  intervalCount?: number;
  usageAggregation?: UsageAggregation;
  usageRecurring?: boolean;
  /** weighted_sum only; defaults to `hour` there. */
  usageTimeUnit?: UsageTimeUnit;
  tiers?: PriceTier[];
  packageSize?: number;
  freeUnits?: number;
  percentageBps?: number;
  /** Minimum spend per billing period. Recurring prices only. */
  minimumAmountMinor?: number | null;
  /** Plan recurring prices only: bill usage every month inside a 2+ month term. */
  billUsageMonthly?: boolean;
  /** Plan recurring prices only: minimum commitment per term. */
  commitmentAmountMinor?: number | null;
  // Real trial (CP-5), replacing bare trial_days.
  trialPeriod?: number;
  trialPeriodUnit?: "day" | "week" | "month" | "year";
  trialEndAction?: "activate_subscription" | "cancel_subscription";
  externalName?: string | null;
  description?: string | null;
  billingCycles?: number | null;
  freeQuantity?: number | null;
  portalMinQuantity?: number | null;
  portalMaxQuantity?: number | null;
  invoiceNotes?: string | null;
  showDescriptionInInvoices?: boolean;
  showDescriptionInQuotes?: boolean;
  /** HSN/SAC for this price. Null/omitted falls through to the product's, then the business default. */
  taxCode?: string | null;
  /**
   * Accounting detail (SKU / Account Name / Class), flat. DESCRIPTIVE
   * METADATA ONLY — nothing in the engine reads these, and `accountingCode` is NOT a
   * `ledger_accounts` handle. Do not wire billing behaviour onto them.
   */
  sku?: string | null;
  accountingCode?: string | null;
  accountingCategoryCode?: string | null;
  metadata?: Record<string, unknown> | null;
  isTaxable?: boolean;
  taxBehavior?: "inclusive" | "exclusive";
  /** A meter price (0453): the meter's key or id. Its usage fields are copied from the meter. */
  meter?: string;
  unitAmountDecimal?: string | null;
  quantityDivisor?: string | number | null;
  amountSource?: string;
  markupPercent?: string | null;
  /** model_price_list: list | cost. */
  markupBase?: string | null;
  /** A meter price's tiers, in the meter tier shape (decimal `up_to`, rate per divisor). */
  meterTiers?: MeterTier[] | null;
  rates?: PriceRateInput[];
  /** 0465: a credit pack (one-time) or credits per cycle (recurring). Validated here. */
  grantsCredit?: unknown;
}

/** `grants_credit` checked against the price and business; a refusal is a CatalogError (400). */
async function checkedGrantsCredit(
  tx: Tx,
  input: {
    businessId: string;
    productId: string;
    priceType: string;
    currency: string;
    value: unknown;
    interval?: string | null;
    intervalCount?: number | null;
  },
): Promise<PriceGrantsCredit | null> {
  const { validatePriceGrantsCredit } = await import("@/modules/credits/packs");
  const [prod] = await tx
    .select({ kind: products.kind })
    .from(products)
    .where(eq(products.id, input.productId))
    .limit(1);
  try {
    return await validatePriceGrantsCredit(tx, { ...input, productKind: prod?.kind ?? null });
  } catch (e) {
    if (e instanceof Error && e.name.startsWith("CreditRule")) throw new CatalogError(e.message);
    if (e instanceof Error && e.name === "TopUpLimitError") throw new CatalogError(e.message);
    throw e;
  }
}

/** A plan with an allowance linked to its credits keeps one credits schedule (G3b). */
async function assertLinkedAllowances(tx: Tx, productId: string): Promise<void> {
  const { linkedAllowanceConflict } = await import("@/modules/credits/allowance");
  const refusal = await linkedAllowanceConflict(tx, productId);
  if (refusal) throw new CatalogError(refusal);
}

export async function createPrice(input: CreatePriceInput): Promise<typeof prices.$inferSelect> {
  const onMeter = input.meter != null;
  if (!onMeter && input.tiers != null) assertTierList(input.tiers, input.model);
  const usageIssue = onMeter ? undefined : usagePricingIssues(input)[0];
  if (usageIssue) throw new CatalogError(usageIssue.message);
  if (input.type === "one_time" && input.minimumAmountMinor != null)
    throw new CatalogError(ONE_TIME_MINIMUM);
  return withTenant(input.organizationId, async (tx) => {
    // A meter price measures what its meter measures: the usage fields are copied from it.
    const meter = onMeter ? await meterForPrice(tx, input.businessId, input.meter!) : null;
    if (meter) {
      assertMeterPrice(
        {
          model: input.model,
          type: input.type,
          amountSource: input.amountSource,
          unitAmountDecimal: input.unitAmountDecimal,
          quantityDivisor: input.quantityDivisor,
          markupPercent: input.markupPercent,
          markupBase: input.markupBase,
          tiers: input.meterTiers ?? undefined,
          packageSize: input.packageSize,
          rates: input.rates,
          meterAggregation: meter.aggregation,
          meterRecurring: meter.recurring,
        },
        meter.groupBy,
      );
      input = {
        ...input,
        usageAggregation: meter.aggregation as UsageAggregation,
        usageRecurring: meter.recurring,
        usageTimeUnit: (meter.timeUnit as UsageTimeUnit | null) ?? undefined,
      };
    }
    if (input.billUsageMonthly || input.commitmentAmountMinor != null) {
      const [prod] = await tx
        .select({ kind: products.kind })
        .from(products)
        .where(eq(products.id, input.productId))
        .limit(1);
      const issue = termBillingIssue({
        productKind: prod?.kind ?? null,
        type: input.type ?? "recurring",
        interval: input.interval ?? null,
        intervalCount: input.intervalCount ?? 1,
        billUsageMonthly: input.billUsageMonthly ?? false,
        commitmentAmountMinor: input.commitmentAmountMinor ?? null,
      });
      if (issue) throw new CatalogError(issue);
    }
    // Enforce the business's billing-frequency allow-list. A recurring
    // price's (interval, interval_count) must be one the business enabled; one-time
    // prices carry no interval and are unrestricted. A null/empty list = no restriction.
    if (input.type !== "one_time" && input.interval) {
      const [biz] = await tx
        .select({ billingFrequencies: businesses.billingFrequencies })
        .from(businesses)
        .where(eq(businesses.id, input.businessId))
        .limit(1);
      const allowed = (biz?.billingFrequencies ?? null) as BillingFrequency[] | null;
      if (!isFrequencyAllowed(allowed, input.interval, input.intervalCount ?? 1)) {
        throw new CatalogError(
          `Billing frequency ${input.intervalCount ?? 1}×${input.interval} is not enabled for this business`,
        );
      }
    }
    if (input.model === "graduated_percentage") {
      const interval = input.type === "one_time" ? null : (input.interval ?? null);
      const [diff] = await tx
        .select({ id: differentialPrices.id })
        .from(differentialPrices)
        .where(
          and(
            eq(differentialPrices.addonProductId, input.productId),
            eq(differentialPrices.currency, input.currency.toUpperCase()),
            interval == null
              ? isNull(differentialPrices.interval)
              : eq(differentialPrices.interval, interval),
            sql`${differentialPrices.tiers} is not null`,
          ),
        )
        .limit(1);
      if (diff) throw new TierListError([NO_DIFF_TIERS_ON_GP]);
    }
    let slug: string;
    if (input.id) {
      if (!validateSlug(input.id)) throw new CatalogError(`Invalid slug format: ${input.id}`);
      const [existing] = await tx
        .select({ id: prices.id })
        .from(prices)
        .where(and(eq(prices.businessId, input.businessId), eq(prices.publicId, input.id)))
        .limit(1);
      if (existing) throw new SlugConflictError(`Price id is already in use: ${input.id}`);
      slug = input.id;
    } else {
      const base = input.name
        ? slugify(input.name)
        : `${input.currency.toLowerCase()}-${input.interval ?? "one-time"}-${input.model}`;
      slug = await uniqueSlug(tx, input.businessId, prices, prices.publicId, base);
    }
    // No `tax_behavior` on the request: the currency's value from the business's tax
    // settings, else exclusive (as before).
    const taxBehavior =
      input.taxBehavior ??
      newPriceTaxBehavior(
        (
          await tx
            .select({ taxSettings: businesses.taxSettings })
            .from(businesses)
            .where(eq(businesses.id, input.businessId))
            .limit(1)
        )[0]?.taxSettings,
        input.currency,
      ) ??
      "exclusive";
    const grantsCredit =
      input.grantsCredit != null
        ? await checkedGrantsCredit(tx, {
            businessId: input.businessId,
            productId: input.productId,
            priceType: input.type,
            currency: input.currency,
            value: input.grantsCredit,
            interval: input.interval ?? null,
            intervalCount: input.intervalCount ?? 1,
          })
        : null;
    const [pr] = await insertOrSlugConflict(
      () =>
        tx
          .insert(prices)
          .values({
            organizationId: input.organizationId,
            businessId: input.businessId,
            productId: input.productId,
            publicId: slug,
            name: input.name ?? null,
            externalName: input.externalName ?? null,
            description: input.description ?? null,
            type: input.type,
            model: input.model,
            currency: input.currency.toUpperCase(),
            amountMinor: input.amountMinor != null ? BigInt(input.amountMinor) : null,
            interval: input.interval ?? null,
            intervalCount: input.intervalCount ?? 1,
            usageAggregation: input.usageAggregation ?? null,
            usageRecurring: input.usageRecurring ?? false,
            usageTimeUnit:
              input.usageTimeUnit ?? (input.usageAggregation === "weighted_sum" ? "hour" : null),
            tiers: meter ? (input.meterTiers ?? null) : (input.tiers ?? null),
            ...(meter
              ? {
                  meterId: meter.id,
                  unitAmountDecimal: input.unitAmountDecimal ?? null,
                  quantityDivisor: BigInt(input.quantityDivisor ?? 1),
                  amountSource: input.amountSource ?? "rate",
                  markupPercent: input.markupPercent ?? null,
                  markupBase: input.markupBase ?? null,
                }
              : {}),
            packageSize: input.packageSize ?? null,
            freeUnits: input.freeUnits ?? null,
            percentageBps: input.percentageBps ?? null,
            minimumAmountMinor:
              input.minimumAmountMinor != null ? BigInt(input.minimumAmountMinor) : null,
            billUsageMonthly: input.billUsageMonthly ?? false,
            commitmentAmountMinor:
              input.commitmentAmountMinor != null ? BigInt(input.commitmentAmountMinor) : null,
            trialPeriod: input.trialPeriod ?? null,
            trialPeriodUnit: input.trialPeriodUnit ?? null,
            trialEndAction: input.trialEndAction ?? null,
            billingCycles: input.billingCycles ?? null,
            freeQuantity: input.freeQuantity ?? null,
            portalMinQuantity: input.portalMinQuantity ?? null,
            portalMaxQuantity: input.portalMaxQuantity ?? null,
            invoiceNotes: input.invoiceNotes ?? null,
            showDescriptionInInvoices: input.showDescriptionInInvoices ?? false,
            showDescriptionInQuotes: input.showDescriptionInQuotes ?? false,
            taxCode: input.taxCode ?? null,
            sku: input.sku ?? null,
            accountingCode: input.accountingCode ?? null,
            accountingCategoryCode: input.accountingCategoryCode ?? null,
            metadata: input.metadata ?? null,
            isTaxable: input.isTaxable ?? true,
            taxBehavior,
            grantsCredit,
          })
          .returning(),
      "Price",
    );
    if (grantsCredit?.kind === "per_cycle") await assertLinkedAllowances(tx, input.productId);
    if (meter && input.rates?.length)
      await replacePriceRates(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        priceId: pr!.id,
        rates: input.rates,
      });
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "price_created",
      data: buildEventData(
        "price_created",
        { id: pr!.publicId, model: pr!.model, currency: pr!.currency },
        pr!.resourceVersion,
      ),
    });
    await auditRowChange(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: "price.create",
      resourceType: "price",
      resourceId: pr!.publicId,
      before: null,
      after: pr!,
    });
    return pr!;
  });
}

/**
 * Edit a price's mutable fields (name/active/amount/tiers). Edits apply to NEW
 * subscriptions only — live subs keep their `price_snapshot`, so this never
 * retroactively re-rates them. Only provided fields change.
 */
export async function updatePrice(input: {
  organizationId: string;
  businessId: string;
  pricePublicId: string;
  expectedVersion?: number;
  name?: string | null;
  externalName?: string | null;
  description?: string | null;
  amountMinor?: number | null;
  tiers?: PriceTier[] | null;
  packageSize?: number | null;
  freeUnits?: number | null;
  percentageBps?: number | null;
  minimumAmountMinor?: number | null;
  billUsageMonthly?: boolean;
  commitmentAmountMinor?: number | null;
  trialPeriod?: number | null;
  trialPeriodUnit?: "day" | "week" | "month" | "year" | null;
  trialEndAction?: "activate_subscription" | "cancel_subscription" | null;
  billingCycles?: number | null;
  freeQuantity?: number | null;
  portalMinQuantity?: number | null;
  portalMaxQuantity?: number | null;
  invoiceNotes?: string | null;
  showDescriptionInInvoices?: boolean;
  showDescriptionInQuotes?: boolean;
  taxCode?: string | null;
  /** Descriptive accounting metadata only — see `CreatePriceInput`. */
  sku?: string | null;
  accountingCode?: string | null;
  accountingCategoryCode?: string | null;
  metadata?: Record<string, unknown> | null;
  isTaxable?: boolean;
  taxBehavior?: "inclusive" | "exclusive";
  /** Meter prices only (0453). Live items keep the rate card frozen in their snapshot. */
  unitAmountDecimal?: string | null;
  markupPercent?: string | null;
  markupBase?: string | null;
  meterTiers?: MeterTier[] | null;
  rates?: PriceRateInput[];
  /** 0465; null clears it. */
  grantsCredit?: unknown;
}): Promise<typeof prices.$inferSelect | null> {
  const set: Partial<typeof prices.$inferInsert> = {};
  if (input.grantsCredit === null) set.grantsCredit = null;
  if (input.unitAmountDecimal !== undefined) set.unitAmountDecimal = input.unitAmountDecimal;
  if (input.markupPercent !== undefined) set.markupPercent = input.markupPercent;
  if (input.markupBase !== undefined) set.markupBase = input.markupBase;
  if (input.meterTiers !== undefined) set.tiers = input.meterTiers;
  if (input.name !== undefined) set.name = input.name;
  if (input.externalName !== undefined) set.externalName = input.externalName;
  if (input.description !== undefined) set.description = input.description;
  if (input.amountMinor !== undefined)
    set.amountMinor = input.amountMinor != null ? BigInt(input.amountMinor) : null;
  if (input.tiers !== undefined) set.tiers = input.tiers;
  if (input.packageSize !== undefined) set.packageSize = input.packageSize;
  if (input.freeUnits !== undefined) set.freeUnits = input.freeUnits;
  if (input.percentageBps !== undefined) set.percentageBps = input.percentageBps;
  if (input.minimumAmountMinor !== undefined)
    set.minimumAmountMinor =
      input.minimumAmountMinor != null ? BigInt(input.minimumAmountMinor) : null;
  if (input.billUsageMonthly !== undefined) set.billUsageMonthly = input.billUsageMonthly;
  if (input.commitmentAmountMinor !== undefined)
    set.commitmentAmountMinor =
      input.commitmentAmountMinor != null ? BigInt(input.commitmentAmountMinor) : null;
  if (input.trialPeriod !== undefined) set.trialPeriod = input.trialPeriod;
  if (input.trialPeriodUnit !== undefined) set.trialPeriodUnit = input.trialPeriodUnit;
  if (input.trialEndAction !== undefined) set.trialEndAction = input.trialEndAction;
  if (input.billingCycles !== undefined) set.billingCycles = input.billingCycles;
  if (input.freeQuantity !== undefined) set.freeQuantity = input.freeQuantity;
  if (input.portalMinQuantity !== undefined) set.portalMinQuantity = input.portalMinQuantity;
  if (input.portalMaxQuantity !== undefined) set.portalMaxQuantity = input.portalMaxQuantity;
  if (input.invoiceNotes !== undefined) set.invoiceNotes = input.invoiceNotes;
  if (input.showDescriptionInInvoices !== undefined)
    set.showDescriptionInInvoices = input.showDescriptionInInvoices;
  if (input.showDescriptionInQuotes !== undefined)
    set.showDescriptionInQuotes = input.showDescriptionInQuotes;
  if (input.taxCode !== undefined) set.taxCode = input.taxCode;
  if (input.sku !== undefined) set.sku = input.sku;
  if (input.accountingCode !== undefined) set.accountingCode = input.accountingCode;
  if (input.accountingCategoryCode !== undefined)
    set.accountingCategoryCode = input.accountingCategoryCode;
  if (input.metadata !== undefined) set.metadata = input.metadata;
  if (input.isTaxable !== undefined) set.isTaxable = input.isTaxable;
  if (input.taxBehavior !== undefined) set.taxBehavior = input.taxBehavior;
  return withTenant(input.organizationId, async (tx) => {
    if (input.expectedVersion !== undefined) {
      const [cur] = await tx
        .select({ v: prices.resourceVersion })
        .from(prices)
        .where(
          and(eq(prices.businessId, input.businessId), eq(prices.publicId, input.pricePublicId)),
        )
        .limit(1);
      if (cur && cur.v !== input.expectedVersion)
        throw new VersionConflictError(input.expectedVersion, cur.v);
    }
    if (Object.keys(set).length === 0 && input.rates === undefined && input.grantsCredit == null) {
      const [pr] = await tx
        .select()
        .from(prices)
        .where(
          and(eq(prices.businessId, input.businessId), eq(prices.publicId, input.pricePublicId)),
        )
        .limit(1);
      return pr ?? null;
    }
    const priceWhere = and(
      eq(prices.businessId, input.businessId),
      eq(prices.publicId, input.pricePublicId),
    );
    const [before] = await tx.select().from(prices).where(priceWhere).limit(1);
    if (before && input.grantsCredit != null)
      set.grantsCredit = await checkedGrantsCredit(tx, {
        businessId: input.businessId,
        productId: before.productId,
        priceType: before.type,
        currency: before.currency,
        value: input.grantsCredit,
        interval: before.interval,
        intervalCount: before.intervalCount,
      });
    const meterEdit =
      input.unitAmountDecimal !== undefined ||
      input.markupPercent !== undefined ||
      input.markupBase !== undefined ||
      input.meterTiers !== undefined ||
      input.rates !== undefined;
    if (before && meterEdit && !before.meterId)
      throw new CatalogError(
        "unit_amount_decimal, markup_percent and rates apply only to a price on a meter.",
      );
    if (before?.meterId) {
      if (input.tiers !== undefined)
        throw new CatalogError("A price on a meter states its tiers in the meter tier shape.");
      const [m] = await tx
        .select({
          groupBy: meters.groupBy,
          aggregation: meters.aggregation,
          recurring: meters.recurring,
        })
        .from(meters)
        .where(eq(meters.id, before.meterId))
        .limit(1);
      const rates =
        input.rates ??
        (await tx.select().from(priceRates).where(eq(priceRates.priceId, before.id))).map((r) => ({
          match: r.match,
          unitAmountDecimal: r.unitAmountDecimal,
          tiers: r.tiers as MeterTier[] | null,
          markupPercent: r.markupPercent,
        }));
      const pick = <T>(next: T | undefined, cur: T) => (next !== undefined ? next : cur);
      assertMeterPrice(
        {
          model: before.model,
          type: before.type,
          amountSource: before.amountSource,
          unitAmountDecimal: pick(input.unitAmountDecimal, before.unitAmountDecimal),
          quantityDivisor: String(before.quantityDivisor),
          markupPercent: pick(input.markupPercent, before.markupPercent),
          markupBase: pick(input.markupBase, before.markupBase),
          tiers: pick(input.meterTiers, before.tiers as MeterTier[] | null) ?? undefined,
          packageSize: pick(input.packageSize, before.packageSize),
          rates,
          meterAggregation: m?.aggregation,
          meterRecurring: m?.recurring,
        },
        m?.groupBy ?? [],
      );
      if (input.rates !== undefined)
        await replacePriceRates(tx, {
          organizationId: input.organizationId,
          businessId: input.businessId,
          priceId: before.id,
          rates: input.rates,
        });
      // A rate-card edit alone still bumps the price's version, so readers see a change.
      if (Object.keys(set).length === 0) set.updatedAt = sql`app_now()` as unknown as Date;
    }
    // Checked against the stored model; a stored list is never re-checked unless replaced.
    if (before && !before.meterId && input.tiers !== undefined)
      assertTierList(input.tiers, before.model);
    if (before?.type === "one_time" && input.minimumAmountMinor != null)
      throw new CatalogError(ONE_TIME_MINIMUM);
    if (before && (input.billUsageMonthly || input.commitmentAmountMinor != null)) {
      const [prod] = await tx
        .select({ kind: products.kind })
        .from(products)
        .where(eq(products.id, before.productId))
        .limit(1);
      const issue = termBillingIssue({
        productKind: prod?.kind ?? null,
        type: before.type,
        interval: before.interval,
        intervalCount: before.intervalCount,
        billUsageMonthly: input.billUsageMonthly ?? before.billUsageMonthly,
        commitmentAmountMinor:
          input.commitmentAmountMinor !== undefined
            ? input.commitmentAmountMinor
            : before.commitmentAmountMinor,
      });
      if (issue) throw new CatalogError(issue);
    }
    const [pr] = await tx.update(prices).set(set).where(priceWhere).returning();
    if (pr?.active && set.grantsCredit !== undefined)
      await assertLinkedAllowances(tx, pr.productId);
    if (pr && set.grantsCredit !== undefined) {
      // A new reset (G3b): wake the price's items, so the credit clock picks them up.
      const { itemReset } = await import("@/modules/credits/credit-clock");
      if (itemReset(pr.grantsCredit))
        await tx
          .update(subscriptionItems)
          .set({ nextCreditResetAt: sql`app_now()` })
          .where(
            and(eq(subscriptionItems.priceId, pr.id), isNull(subscriptionItems.nextCreditResetAt)),
          );
    }
    if (pr) {
      await auditRowChange(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        action: "price.update",
        resourceType: "price",
        resourceId: pr.publicId,
        before: before ?? null,
        after: pr,
      });
      await emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "price_updated",
        data: buildEventData(
          "price_updated",
          { id: pr.publicId, model: pr.model, currency: pr.currency },
          pr.resourceVersion,
        ),
      });
    }
    return pr ?? null;
  });
}

/**
 * Soft-archive (active=false) or restore (active=true) a price. A restore that splits a linked
 * allowance's credits schedule is a CatalogError.
 */
export async function setPriceActive(
  organizationId: string,
  businessId: string,
  pricePublicId: string,
  active: boolean,
): Promise<typeof prices.$inferSelect | null> {
  return withTenant(organizationId, async (tx) => {
    const where = and(eq(prices.businessId, businessId), eq(prices.publicId, pricePublicId));
    const [before] = await tx.select().from(prices).where(where).limit(1);
    const [pr] = await tx.update(prices).set({ active }).where(where).returning();
    if (pr && active && !before?.active && pr.grantsCredit?.kind === "per_cycle")
      await assertLinkedAllowances(tx, pr.productId);
    if (pr) {
      await auditRowChange(tx, {
        organizationId,
        businessId,
        action: active ? "price.restore" : "price.archive",
        resourceType: "price",
        resourceId: pr.publicId,
        before: before ?? null,
        after: pr,
      });
      const type = active ? "price_updated" : "price_archived";
      await emitEvent(tx, {
        organizationId,
        businessId,
        type,
        data: buildEventData(type, { id: pr.publicId, active: pr.active }, pr.resourceVersion),
      });
    }
    return pr ?? null;
  });
}

/** Prices for a business, joined with their product's public id for serialization. */
export async function listPrices(
  organizationId: string,
  businessId: string,
  opts?: {
    includeArchived?: boolean;
    // CAT-8 filters.
    currency?: string;
    interval?: string;
    model?: string;
    productPublicId?: string;
    status?: "active" | "archived";
  },
): Promise<Array<{ price: typeof prices.$inferSelect; productPublicId: string }>> {
  return withTenant(organizationId, async (tx) => {
    const conds = [eq(prices.businessId, businessId)];
    // status wins over includeArchived: archived → inactive only, active → active only.
    if (opts?.status === "archived") conds.push(eq(prices.active, false));
    else if (opts?.status === "active" || !opts?.includeArchived)
      conds.push(eq(prices.active, true));
    if (opts?.currency) conds.push(eq(prices.currency, opts.currency.toUpperCase()));
    if (opts?.interval) conds.push(eq(prices.interval, opts.interval));
    if (opts?.model) conds.push(eq(prices.model, opts.model));
    if (opts?.productPublicId) conds.push(eq(products.publicId, opts.productPublicId));
    return tx
      .select({ price: prices, productPublicId: products.publicId })
      .from(prices)
      .innerJoin(products, eq(prices.productId, products.id))
      .where(and(...conds))
      .orderBy(desc(prices.createdAt));
  });
}

/**
 * Replace an add-on's set of applicable plans (by plan product public ids).
 * Validates that the addon is kind=addon and every target is kind=plan in the
 * same business. Returns the resolved plan public ids now linked.
 */
export type Applicability = "mandatory" | "recommended" | "optional";

export type ChargeOnEvent = "subscription_creation" | "trial_start" | "activation" | "on_demand";
export interface AttachedItemConfig {
  chargeOnEvent?: ChargeOnEvent;
  chargeOnce?: boolean;
  defaultQuantity?: number;
  billingCycles?: number | null;
  minQuantity?: number | null;
  maxQuantity?: number | null;
  quantityStep?: number;
  customerCanChangeQuantity?: boolean;
}

export async function setItemApplicablePlans(input: {
  organizationId: string;
  businessId: string;
  /** The add-on or charge being attached. */
  itemPublicId: string;
  planPublicIds: string[];
  /** CP-6: per-plan applicability level (defaults to 'optional'). */
  applicability?: Record<string, Applicability>;
  /** CAT-4: per-plan charge semantics (defaults: subscription_creation, once=false, qty=1). */
  config?: Record<string, AttachedItemConfig>;
  /**
   * The "applicable to every plan" flag (`products.addon_applies_to_all`), which is
   * the OTHER half of applicability and lives on the add-on rather than in
   * `attached_items`. Omitted = leave it alone; this endpoint's job is the link set,
   * and a caller sending only `plans` must not silently clear the flag.
   *
   * It is settable here because `listItemApplicablePlans` REPORTS it: a caller that
   * GETs this document, edits `plans` and PUTs it back would otherwise drop the field
   * on the floor with no error. Same field, same document, both directions.
   */
  appliesToAll?: boolean;
}): Promise<{ plans: string[]; appliesToAll: boolean }> {
  return withTenant(input.organizationId, async (tx) => {
    const [item] = await tx
      .select()
      .from(products)
      .where(
        and(eq(products.businessId, input.businessId), eq(products.publicId, input.itemPublicId)),
      )
      .limit(1);
    if (!item) throw new CatalogError(`We could not find the product ${input.itemPublicId}.`);
    if (item.kind !== "addon" && item.kind !== "charge")
      throw new CatalogError(`Product ${input.itemPublicId} is not an add-on or a charge`);
    const isCharge = item.kind === "charge";
    if (isCharge) {
      // A charge bills once at its event, so it needs a one-time price to bill with.
      const [oneTime] = await tx
        .select({ id: prices.id })
        .from(prices)
        .where(and(eq(prices.productId, item.id), eq(prices.type, "one_time")))
        .limit(1);
      if (!oneTime && input.planPublicIds.length)
        throw new CatalogError(`Charge ${input.itemPublicId} has no one-time price to attach`);
      const recommended = Object.entries(input.applicability ?? {}).find(
        ([, level]) => level === "recommended",
      );
      if (recommended)
        throw new CatalogError(
          `You can attach a charge as mandatory or optional, but not as recommended (plan ${recommended[0]})`,
        );
      if (input.appliesToAll)
        throw new CatalogError(
          "applies_to_all is for add-ons. Attach a charge to plans explicitly.",
        );
    }

    const plans = input.planPublicIds.length
      ? await tx
          .select()
          .from(products)
          .where(
            and(
              eq(products.businessId, input.businessId),
              inArray(products.publicId, input.planPublicIds),
            ),
          )
      : [];
    const byPid = new Map(plans.map((p) => [p.publicId, p]));
    for (const pid of input.planPublicIds) {
      const plan = byPid.get(pid);
      if (!plan) throw new CatalogError(`We could not find the plan ${pid}.`);
      if (plan.kind !== "plan") throw new CatalogError(`Product ${pid} is not a plan`);
      const c = input.config?.[pid];
      if (c?.minQuantity != null && c.maxQuantity != null && c.minQuantity > c.maxQuantity)
        throw new CatalogError(`The minimum quantity is more than the maximum (plan ${pid}).`);
    }

    if (input.appliesToAll !== undefined && input.appliesToAll !== item.addonAppliesToAll) {
      await tx
        .update(products)
        .set({ addonAppliesToAll: input.appliesToAll })
        .where(eq(products.id, item.id));
    }
    const appliesToAll = input.appliesToAll ?? item.addonAppliesToAll;

    // Snapshot the prior link set so we can emit created/deleted per changed link.
    const priorRows = await tx
      .select({ planPid: products.publicId })
      .from(attachedItems)
      .innerJoin(products, eq(attachedItems.planProductId, products.id))
      .where(eq(attachedItems.itemProductId, item.id));
    const priorPids = new Set(priorRows.map((r) => r.planPid));
    const nextPids = new Set(plans.map((p) => p.publicId));

    // Replace the link set atomically.
    await tx.delete(attachedItems).where(eq(attachedItems.itemProductId, item.id));
    if (plans.length) {
      await tx.insert(attachedItems).values(
        plans.map((plan) => {
          const cfg = input.config?.[plan.publicId];
          return {
            organizationId: input.organizationId,
            businessId: input.businessId,
            itemProductId: item.id,
            planProductId: plan.id,
            applicability: input.applicability?.[plan.publicId] ?? "optional",
            chargeOnEvent: cfg?.chargeOnEvent ?? "subscription_creation",
            // A charge never recurs, so it is always billed once and never cycle-capped.
            chargeOnce: isCharge || (cfg?.chargeOnce ?? false),
            defaultQuantity: cfg?.defaultQuantity ?? 1,
            billingCycles: isCharge ? null : (cfg?.billingCycles ?? null),
            minQuantity: cfg?.minQuantity ?? null,
            maxQuantity: cfg?.maxQuantity ?? null,
            quantityStep: cfg?.quantityStep ?? 1,
            customerCanChangeQuantity: cfg?.customerCanChangeQuantity ?? true,
          };
        }),
      );
    }
    // Per-link lifecycle events: added links → created, removed links → deleted.
    for (const plan of plans) {
      if (priorPids.has(plan.publicId)) continue;
      await emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "attached_item_created",
        data: buildEventData("attached_item_created", { id: item.publicId, plan: plan.publicId }),
      });
    }
    for (const pid of priorPids) {
      if (nextPids.has(pid)) continue;
      await emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "attached_item_deleted",
        data: buildEventData("attached_item_deleted", { id: item.publicId, plan: pid }),
      });
    }
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "attached_item_updated",
      data: buildEventData("attached_item_updated", {
        id: item.publicId,
        plans: plans.map((p) => p.publicId),
      }),
    });
    return { plans: plans.map((p) => p.publicId), appliesToAll };
  });
}

/** List the plan public ids an add-on is applicable to. */
export interface AttachedItemLink {
  applicability: Applicability;
  chargeOnEvent: string;
  chargeOnce: boolean;
  defaultQuantity: number;
  billingCycles: number | null;
  /** Portal-only quantity limits; staff may set any quantity. null = no limit. */
  minQuantity: number | null;
  maxQuantity: number | null;
  quantityStep: number;
  customerCanChangeQuantity: boolean;
}

/** A link implied by a differential price or "applies to all" has no limits. */
const NO_QUANTITY_LIMITS = {
  minQuantity: null,
  maxQuantity: null,
  quantityStep: 1,
  customerCanChangeQuantity: true,
} as const;

export async function listItemApplicablePlans(
  organizationId: string,
  businessId: string,
  itemPublicId: string,
): Promise<{
  appliesToAll: boolean;
  plans: string[];
  applicability: Record<string, Applicability>;
  config: Record<string, AttachedItemLink>;
} | null> {
  return withTenant(organizationId, async (tx) => {
    const [item] = await tx
      .select()
      .from(products)
      .where(and(eq(products.businessId, businessId), eq(products.publicId, itemPublicId)))
      .limit(1);
    if (!item) return null;
    const rows = await tx
      .select({
        planPid: products.publicId,
        applicability: attachedItems.applicability,
        chargeOnEvent: attachedItems.chargeOnEvent,
        chargeOnce: attachedItems.chargeOnce,
        defaultQuantity: attachedItems.defaultQuantity,
        billingCycles: attachedItems.billingCycles,
        minQuantity: attachedItems.minQuantity,
        maxQuantity: attachedItems.maxQuantity,
        quantityStep: attachedItems.quantityStep,
        customerCanChangeQuantity: attachedItems.customerCanChangeQuantity,
      })
      .from(attachedItems)
      .innerJoin(products, eq(attachedItems.planProductId, products.id))
      .where(eq(attachedItems.itemProductId, item.id));
    const applicability: Record<string, Applicability> = {};
    const config: Record<string, AttachedItemLink> = {};
    const planPids: string[] = [];
    for (const r of rows) {
      applicability[r.planPid] = r.applicability as Applicability;
      config[r.planPid] = {
        applicability: r.applicability as Applicability,
        chargeOnEvent: r.chargeOnEvent,
        chargeOnce: r.chargeOnce,
        defaultQuantity: r.defaultQuantity,
        billingCycles: r.billingCycles,
        minQuantity: r.minQuantity,
        maxQuantity: r.maxQuantity,
        quantityStep: r.quantityStep,
        customerCanChangeQuantity: r.customerCanChangeQuantity,
      };
      planPids.push(r.planPid);
    }

    // A plan-specific differential price for this addon implies the addon is
    // applicable to that plan (as `optional`), even absent an explicit
    // attached_item. This is the source of truth for imported catalogs, where
    // differentials carry the addon↔plan relationship but attachments may not.
    const diffPlans = await tx
      .selectDistinct({ planPid: products.publicId })
      .from(differentialPrices)
      .innerJoin(products, eq(differentialPrices.planProductId, products.id))
      .where(eq(differentialPrices.addonProductId, item.id));
    for (const { planPid } of diffPlans) {
      if (applicability[planPid]) continue; // an explicit attachment wins
      applicability[planPid] = "optional";
      config[planPid] = {
        applicability: "optional",
        chargeOnEvent: "subscription_creation",
        chargeOnce: false,
        defaultQuantity: 1,
        billingCycles: null,
        ...NO_QUANTITY_LIMITS,
      };
      planPids.push(planPid);
    }

    return { appliesToAll: item.addonAppliesToAll, plans: planPids, applicability, config };
  });
}

/**
 * `listItemApplicablePlans` for every add-on and charge in the business, in three queries.
 * The subscription screens need all of them at once, and one request per add-on queued
 * dozens of calls behind each other.
 */
export async function listApplicablePlansForBusiness(
  organizationId: string,
  businessId: string,
): Promise<
  Array<{
    addon: string;
    appliesToAll: boolean;
    plans: string[];
    applicability: Record<string, Applicability>;
    config: Record<string, AttachedItemLink>;
  }>
> {
  return withTenant(organizationId, async (tx) => {
    const addons = await tx
      .select({
        id: products.id,
        publicId: products.publicId,
        appliesToAll: products.addonAppliesToAll,
      })
      .from(products)
      .where(and(eq(products.businessId, businessId), inArray(products.kind, ["addon", "charge"])));
    if (addons.length === 0) return [];
    const ids = addons.map((a) => a.id);
    const plan = alias(products, "plan");
    const [links, diffs] = await Promise.all([
      tx
        .select({
          addonId: attachedItems.itemProductId,
          planPid: plan.publicId,
          applicability: attachedItems.applicability,
          chargeOnEvent: attachedItems.chargeOnEvent,
          chargeOnce: attachedItems.chargeOnce,
          defaultQuantity: attachedItems.defaultQuantity,
          billingCycles: attachedItems.billingCycles,
          minQuantity: attachedItems.minQuantity,
          maxQuantity: attachedItems.maxQuantity,
          quantityStep: attachedItems.quantityStep,
          customerCanChangeQuantity: attachedItems.customerCanChangeQuantity,
        })
        .from(attachedItems)
        .innerJoin(plan, eq(attachedItems.planProductId, plan.id))
        .where(inArray(attachedItems.itemProductId, ids)),
      tx
        .selectDistinct({ addonId: differentialPrices.addonProductId, planPid: plan.publicId })
        .from(differentialPrices)
        .innerJoin(plan, eq(differentialPrices.planProductId, plan.id))
        .where(inArray(differentialPrices.addonProductId, ids)),
    ]);
    const byAddon = new Map(
      addons.map((a) => [
        a.id,
        {
          addon: a.publicId,
          appliesToAll: a.appliesToAll,
          plans: [] as string[],
          applicability: {} as Record<string, Applicability>,
          config: {} as Record<string, AttachedItemLink>,
        },
      ]),
    );
    for (const r of links) {
      const e = byAddon.get(r.addonId)!;
      e.applicability[r.planPid] = r.applicability as Applicability;
      e.config[r.planPid] = {
        applicability: r.applicability as Applicability,
        chargeOnEvent: r.chargeOnEvent,
        chargeOnce: r.chargeOnce,
        defaultQuantity: r.defaultQuantity,
        billingCycles: r.billingCycles,
        minQuantity: r.minQuantity,
        maxQuantity: r.maxQuantity,
        quantityStep: r.quantityStep,
        customerCanChangeQuantity: r.customerCanChangeQuantity,
      };
      e.plans.push(r.planPid);
    }
    // Same rule as the single-add-on read: a differential price implies `optional`.
    for (const { addonId, planPid } of diffs) {
      const e = byAddon.get(addonId)!;
      if (e.applicability[planPid]) continue;
      e.applicability[planPid] = "optional";
      e.config[planPid] = {
        applicability: "optional",
        chargeOnEvent: "subscription_creation",
        chargeOnce: false,
        defaultQuantity: 1,
        billingCycles: null,
        ...NO_QUANTITY_LIMITS,
      };
      e.plans.push(planPid);
    }
    return [...byAddon.values()];
  });
}

/** Every differential price in the business, each naming its add-on — one query. */
export async function listDifferentialPricesForBusiness(
  organizationId: string,
  businessId: string,
): Promise<
  Array<{
    id: string;
    addon: string;
    plan: string;
    currency: string;
    interval: string | null;
    amountMinor: number | null;
    tiers: unknown | null;
  }>
> {
  return withTenant(organizationId, async (tx) => {
    const addon = alias(products, "addon");
    const plan = alias(products, "plan");
    const rows = await tx
      .select({
        id: differentialPrices.publicId,
        addonPid: addon.publicId,
        planPid: plan.publicId,
        currency: differentialPrices.currency,
        interval: differentialPrices.interval,
        amountMinor: differentialPrices.amountMinor,
        tiers: differentialPrices.tiers,
      })
      .from(differentialPrices)
      .innerJoin(addon, eq(differentialPrices.addonProductId, addon.id))
      .innerJoin(plan, eq(differentialPrices.planProductId, plan.id))
      .where(eq(addon.businessId, businessId));
    return rows.map((r) => ({
      id: r.id,
      addon: r.addonPid,
      plan: r.planPid,
      currency: r.currency,
      interval: r.interval,
      amountMinor: r.amountMinor != null ? Number(r.amountMinor) : null,
      tiers: r.tiers,
    }));
  });
}

// ─── Differential pricing (CP-6) ─────────────────────────────────────────────
// An add-on's price when attached to a specific plan can differ from its base
// price. Resolved at rating time by (addon, plan, currency, interval).

export async function setDifferentialPrice(input: {
  organizationId: string;
  businessId: string;
  addonPublicId: string;
  planPublicId: string;
  currency: string;
  interval?: "day" | "week" | "month" | "year" | null;
  /** CAT-7: a flat/per-unit amount OR (mutually exclusive) a `tiers` table. */
  amountMinor?: number;
  tiers?: unknown;
}): Promise<typeof differentialPrices.$inferSelect> {
  if (input.amountMinor == null && input.tiers == null) {
    throw new CatalogError("differential price requires amount_minor or tiers");
  }
  if (input.tiers != null) assertTierList(input.tiers as PriceTier[]);
  return withTenant(input.organizationId, async (tx) => {
    const rows = await tx
      .select()
      .from(products)
      .where(
        and(
          eq(products.businessId, input.businessId),
          inArray(products.publicId, [input.addonPublicId, input.planPublicId]),
        ),
      );
    const addon = rows.find((r) => r.publicId === input.addonPublicId);
    const plan = rows.find((r) => r.publicId === input.planPublicId);
    if (!addon || addon.kind !== "addon")
      throw new CatalogError(`We could not find the add-on ${input.addonPublicId}.`);
    if (!plan || plan.kind !== "plan")
      throw new CatalogError(`We could not find the plan ${input.planPublicId}.`);
    const currency = input.currency.toUpperCase();
    const interval = input.interval ?? null;
    // Resolution matches (currency, interval) exactly, so these are the prices it would reach.
    if (input.tiers != null) {
      const [gp] = await tx
        .select({ id: prices.id })
        .from(prices)
        .where(
          and(
            eq(prices.productId, addon.id),
            eq(prices.currency, currency),
            eq(prices.model, "graduated_percentage"),
            interval == null ? isNull(prices.interval) : eq(prices.interval, interval),
          ),
        )
        .limit(1);
      if (gp) throw new TierListError([NO_DIFF_TIERS_ON_GP]);
    }
    // Upsert on the unique (addon, plan, currency, interval).
    const [existing] = await tx
      .select()
      .from(differentialPrices)
      .where(
        and(
          eq(differentialPrices.addonProductId, addon.id),
          eq(differentialPrices.planProductId, plan.id),
          eq(differentialPrices.currency, currency),
          interval == null
            ? isNull(differentialPrices.interval)
            : eq(differentialPrices.interval, interval),
        ),
      )
      .limit(1);
    const emitSet = (row: typeof differentialPrices.$inferSelect) =>
      emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "differential_price_set",
        data: buildEventData("differential_price_set", {
          id: row.publicId,
          addon: addon.publicId,
          plan: plan.publicId,
          currency,
          amount_minor: row.amountMinor != null ? Number(row.amountMinor) : null,
        }),
      });
    const amountMinor = input.tiers != null ? null : BigInt(input.amountMinor!);
    const tiers = input.tiers ?? null;
    if (existing) {
      const [row] = await tx
        .update(differentialPrices)
        .set({ amountMinor, tiers })
        .where(eq(differentialPrices.id, existing.id))
        .returning();
      await emitSet(row!);
      return row!;
    }
    const [row] = await tx
      .insert(differentialPrices)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        addonProductId: addon.id,
        planProductId: plan.id,
        publicId: publicId("dprice"),
        currency,
        interval,
        amountMinor,
        tiers,
      })
      .returning();
    await emitSet(row!);
    return row!;
  });
}

export async function listDifferentialPrices(
  organizationId: string,
  businessId: string,
  addonPublicId: string,
): Promise<
  Array<{
    plan: string;
    currency: string;
    interval: string | null;
    amountMinor: number | null;
    tiers: unknown | null;
    id: string;
  }>
> {
  return withTenant(organizationId, async (tx) => {
    const [addon] = await tx
      .select()
      .from(products)
      .where(and(eq(products.businessId, businessId), eq(products.publicId, addonPublicId)))
      .limit(1);
    if (!addon) return [];
    const rows = await tx
      .select({
        id: differentialPrices.publicId,
        planPid: products.publicId,
        currency: differentialPrices.currency,
        interval: differentialPrices.interval,
        amountMinor: differentialPrices.amountMinor,
        tiers: differentialPrices.tiers,
      })
      .from(differentialPrices)
      .innerJoin(products, eq(differentialPrices.planProductId, products.id))
      .where(eq(differentialPrices.addonProductId, addon.id));
    return rows.map((r) => ({
      id: r.id,
      plan: r.planPid,
      currency: r.currency,
      interval: r.interval,
      amountMinor: r.amountMinor != null ? Number(r.amountMinor) : null,
      tiers: r.tiers,
    }));
  });
}

/** CAT-7: a differential override — a flat/per-unit amount OR a tiers table. */
export interface DifferentialOverride {
  amountMinor: bigint | null;
  tiers: unknown | null;
}

/**
 * Resolve the differential override for an addon attached to a plan, or null if
 * none is set (caller falls back to the addon's base price). CAT-7: the override
 * is either a flat/per-unit `amountMinor` or a `tiers` array. Runs in a tenant tx.
 */
export async function resolveDifferential(
  tx: Tx,
  addonProductId: string,
  planProductId: string,
  currency: string,
  interval: string | null,
): Promise<DifferentialOverride | null> {
  const [row] = await tx
    .select({ amountMinor: differentialPrices.amountMinor, tiers: differentialPrices.tiers })
    .from(differentialPrices)
    .where(
      and(
        eq(differentialPrices.addonProductId, addonProductId),
        eq(differentialPrices.planProductId, planProductId),
        eq(differentialPrices.currency, currency.toUpperCase()),
        interval == null
          ? isNull(differentialPrices.interval)
          : eq(differentialPrices.interval, interval),
      ),
    )
    .limit(1);
  return row ? { amountMinor: row.amountMinor, tiers: row.tiers } : null;
}

/** Back-compat: just the differential amount (null for a tiers-only differential). */
export async function resolveDifferentialAmount(
  tx: Tx,
  addonProductId: string,
  planProductId: string,
  currency: string,
  interval: string | null,
): Promise<bigint | null> {
  const d = await resolveDifferential(tx, addonProductId, planProductId, currency, interval);
  return d?.amountMinor ?? null;
}

/** An item carrying a resolvable per-subscription price override. */
export interface DifferentiableItem {
  price: typeof prices.$inferSelect;
  customAmountMinor?: number | null;
  customTiers?: unknown;
}

/**
 * CAT-7: fill in the plan-scoped differential for add-ons the caller asked
 * for EXPLICITLY (`resolveMandatoryAttachedItems` already does this for the ones it
 * auto-includes). A differential add-on is a catalog list price
 * of 0 with the real amount held per (add-on, plan, currency, interval) — so an
 * add-on that skips this rates at 0 and bills nothing. An explicit caller
 * override (`unit_price_minor`) still wins; the differential only fills the gap
 * when none was given. Runs in a caller-supplied tenant tx.
 *
 * Single source of truth for the rule, shared by `createSubscription` — which
 * FREEZES the result into each item's immutable `priceSnapshot` — and
 * `estimateNewSubscription`, which only rates it. Both must agree: the estimate
 * having its own (missing) copy of this is what let the create page preview an
 * add-on at 0.00 while the subscription it booked charged the differential (see
 * subscriptions/README.md, 2026-08-04).
 */
export async function applyExplicitDifferentials<T extends DifferentiableItem>(
  tx: Tx,
  input: {
    currency: string;
    /** Plan products among the requested items — a differential is scoped to one. */
    planProductIds: string[];
    /** Which requested products are add-ons (plans/charges take no differential). */
    addonProductIds: Set<string>;
    items: T[];
  },
): Promise<T[]> {
  if (input.planProductIds.length === 0 || input.addonProductIds.size === 0) return input.items;
  return Promise.all(
    input.items.map(async (i) => {
      if (i.customAmountMinor != null || i.customTiers != null) return i;
      if (!input.addonProductIds.has(i.price.productId)) return i;
      for (const planProductId of input.planProductIds) {
        const diff = await resolveDifferential(
          tx,
          i.price.productId,
          planProductId,
          input.currency,
          i.price.interval,
        );
        if (!diff) continue;
        return {
          ...i,
          customAmountMinor:
            diff.tiers == null && diff.amountMinor != null && isOverridable(i.price.model)
              ? Number(diff.amountMinor)
              : undefined,
          customTiers: diff.tiers ?? undefined,
        };
      }
      return i;
    }),
  );
}

/** CAT-3/CAT-4: an add-on to auto-include on a subscription. */
export interface MandatoryAttachedItem {
  price: typeof prices.$inferSelect;
  differentialAmountMinor: number | null;
  /** CAT-7: tiered differential override (null unless the differential is tiered). */
  differentialTiers: unknown | null;
  addonProductId: string;
  /** CAT-4: quantity + billing-cycles cap + one-time-vs-recurring, from the attached_item. */
  quantity: number;
  billingCycles: number | null;
  chargeOnce: boolean;
}

/**
 * CAT-3: resolve the mandatory add-on items to auto-include for a set of plan
 * products, at a given currency + interval. For each plan, add-ons linked with
 * `applicability='mandatory'` are expanded to the add-on's recurring price
 * matching (currency, interval) — differential-aware, deduped by add-on product
 * (an add-on mandatory on two of the sub's plans is added once). Add-ons already
 * present on the subscription (`existingProductIds`) are skipped. An add-on with
 * no compatible price is skipped (can't be billed on this cadence). Runs in
 * a caller-supplied tenant tx.
 */
export async function resolveMandatoryAttachedItems(
  tx: Tx,
  input: {
    businessId: string;
    planProductIds: string[];
    currency: string;
    interval: string | null;
    intervalCount: number;
    existingProductIds?: string[];
    /** CAT-4: which charge_on_event values to include (default: creation + trial_start). */
    chargeOnEvents?: string[];
    /** G backlog: at subscription-create, an unpriceable mandatory add-on is an
     * error; at renewal/change it's warned + skipped (never throw
     * mid-clock). Default false = warn-and-skip. */
    strict?: boolean;
    /** Post-H (#13): when set (non-strict paths), a skip writes a durable audit_log
     * row in this tx so silent under-billing is visible, not just a pino warn. */
    organizationId?: string;
    subscriptionId?: string;
  },
): Promise<MandatoryAttachedItem[]> {
  if (input.planProductIds.length === 0) return [];
  const events = input.chargeOnEvents ?? ["subscription_creation", "trial_start"];
  const links = await tx
    .select({
      addonId: attachedItems.itemProductId,
      planId: attachedItems.planProductId,
      chargeOnEvent: attachedItems.chargeOnEvent,
      chargeOnce: attachedItems.chargeOnce,
      defaultQuantity: attachedItems.defaultQuantity,
      billingCycles: attachedItems.billingCycles,
    })
    .from(attachedItems)
    .where(
      and(
        eq(attachedItems.businessId, input.businessId),
        inArray(attachedItems.planProductId, input.planProductIds),
        eq(attachedItems.applicability, "mandatory"),
      ),
    );
  if (links.length === 0) return [];
  const cur = input.currency.toUpperCase();
  const skip = new Set(input.existingProductIds ?? []);
  const out: MandatoryAttachedItem[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (!events.includes(link.chargeOnEvent)) continue; // wrong event (e.g. activation/on_demand)
    if (seen.has(link.addonId) || skip.has(link.addonId)) continue;
    seen.add(link.addonId);
    const priceRows = await tx
      .select()
      .from(prices)
      .where(
        and(
          eq(prices.businessId, input.businessId),
          eq(prices.productId, link.addonId),
          eq(prices.currency, cur),
        ),
      )
      // ORDER BY, because the last-resort pick below is positional. Without it the row
      // Postgres happened to return first decided the price: measured, an add-on carrying a
      // monthly AND a quarterly price billed 10000/year apart on two identical catalogs.
      // `publicId` is unique and immutable, so the choice is stable across runs and plans.
      .orderBy(prices.publicId);
    // Price selection (G backlog): a RECURRING mandatory add-on must resolve to a
    // recurring price — NEVER fall back to a one_time price (that would bill a
    // setup fee every period forever). A charge_once add-on prefers a one_time
    // price (billed once).
    const recurringRows = priceRows.filter((p) => p.type === "recurring");
    // ── AND THE PICK MUST FIT THE SUBSCRIPTION'S CYCLE (F-21, 2026-08-26) ───────────
    // The fallbacks accepted ANY interval, so a mandatory volume/tiered add-on landed on a
    // yearly plan at its own MONTHLY rate: billed 5000 where 60000 was owed — 12x under —
    // on an invoice line reading "5 x 1000" against a one-year service period, while MRR
    // stored the honest 15000/month. The identical add-on is REFUSED when a customer asks
    // for it explicitly, because that path runs `cadenceMismatch`; this one never did, so
    // the same add-on on the same plan cost 12x less when the catalog auto-included it.
    //
    // `cadenceMismatch` is asked rather than re-derived — it already encodes that a shorter
    // cadence may fold ONLY when the model carries a single scalable amount, which is
    // precisely why a volume price's tier table must not be folded x12. Dynamic import
    // because subscriptions/service imports this module.
    const { cadenceMismatch } = await import("@/modules/subscriptions/service");
    const cycleInterval = input.interval ?? "month";
    const cycleCount = input.intervalCount ?? 1;
    const fitsCycle = (p: (typeof recurringRows)[number]) =>
      cadenceMismatch(p, cycleInterval, cycleCount) == null;
    // A function of the CATALOG, never of insertion order. `ORDER BY public_id` was not
    // enough on its own: a public id encodes creation order (the second price of a shape
    // gets the `-2` suffix), so the same two prices still resolved two ways depending on
    // which was inserted first — measured, 180000 vs 170000 per year.
    //
    // Among the prices that fit, take the one CLOSEST to the cycle: the fewest folds is the
    // least transformation of what the catalog states, and it is a property of the price.
    // Ties break on public id, which is unique, so the choice is total.
    const closestFitting = recurringRows
      .filter(fitsCycle)
      .map((p) => ({
        p,
        folds: cadenceMultiple({ interval: cycleInterval, intervalCount: cycleCount }, p) ?? 1,
      }))
      .sort((a, b) => a.folds - b.folds || a.p.publicId.localeCompare(b.p.publicId))[0]?.p;
    const recurringMatch =
      recurringRows.find(
        (p) => p.interval === input.interval && p.intervalCount === input.intervalCount,
      ) ??
      recurringRows.find((p) => p.interval === input.interval && fitsCycle(p)) ??
      closestFitting;
    const match = link.chargeOnce
      ? (priceRows.find((p) => p.type === "one_time") ?? recurringMatch)
      : recurringMatch;
    if (!match) {
      // No compatible price: under-billing with no signal is unacceptable (G backlog).
      // "no price that FITS" — the absent case and the cadence-incompatible case land here
      // together on purpose: both mean this add-on cannot be auto-included at a price this
      // cycle can honour, and both must obey `strict` (throw at create, warn-and-audit on
      // the clock paths — never throw mid-clock, see the policy note above).
      const msg = `Mandatory add-on ${link.addonId} has no ${cur} ${link.chargeOnce ? "" : "recurring "}price compatible with a ${cycleCount} ${cycleInterval} cycle. We cannot include it automatically.`;
      if (input.strict) throw new CatalogError(msg);
      log.warn(msg, {
        businessId: input.businessId,
        addonId: link.addonId,
        currency: cur,
        interval: input.interval,
      });
      // Post-H (#13): record the skip DURABLY (append-only audit row, in this tx) so
      // the under-billing is queryable — a pino warn alone is not a durable signal.
      if (input.organizationId) {
        const { writeAuditLog } = await import("@/modules/audit/service");
        await writeAuditLog(
          {
            organizationId: input.organizationId,
            businessId: input.businessId,
            action: "mandatory_addon.skipped",
            resourceType: "attached_item",
            resourceId: link.addonId,
            after: {
              reason: "no_compatible_price",
              currency: cur,
              interval: input.interval,
              subscription: input.subscriptionId ?? null,
            },
          },
          tx,
        );
      }
      continue;
    }
    const diff = await resolveDifferential(tx, link.addonId, link.planId, cur, match.interval);
    // Gate the flat/per-unit differential override by isOverridable — same rule
    // addSubscriptionItem enforces, so create/change/estimate price identically
    // (G backlog: create-path override bypassed the gate). Tiered differentials
    // are a separate mechanism (customTiers) and apply regardless.
    const overridable = isOverridable(match.model);
    out.push({
      price: match,
      differentialAmountMinor:
        diff?.tiers == null && diff?.amountMinor != null && overridable
          ? Number(diff.amountMinor)
          : null,
      differentialTiers: diff?.tiers ?? null,
      addonProductId: link.addonId,
      quantity: link.defaultQuantity ?? 1,
      billingCycles: link.billingCycles ?? null,
      chargeOnce: link.chargeOnce ?? false,
    });
  }
  return out;
}

/**
 * CAT-3: are any of these add-on products a MANDATORY add-on for any of the given
 * plan products? Used to reject removing an auto-included mandatory add-on.
 */
export async function findMandatoryItemIds(
  tx: Tx,
  businessId: string,
  planProductIds: string[],
  addonProductIds: string[],
): Promise<Set<string>> {
  if (planProductIds.length === 0 || addonProductIds.length === 0) return new Set();
  const rows = await tx
    .select({ addonId: attachedItems.itemProductId })
    .from(attachedItems)
    .where(
      and(
        eq(attachedItems.businessId, businessId),
        inArray(attachedItems.planProductId, planProductIds),
        inArray(attachedItems.itemProductId, addonProductIds),
        eq(attachedItems.applicability, "mandatory"),
      ),
    );
  return new Set(rows.map((r) => r.addonId));
}

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

/** A tier list that breaks `tierListIssues`; the route turns `issues` into field errors. */
export class TierListError extends CatalogError {
  constructor(readonly issues: TierIssue[]) {
    super(`We could not save the tiers. ${issues.map((i) => i.message).join(" ")}`);
    this.name = "TierListError";
  }
}

function assertTierList(tiers: readonly PriceTier[] | null | undefined, model?: string) {
  const issues = tierListIssues(tiers, model);
  if (issues.length) throw new TierListError(issues);
}

/** Differential tiers have no rate, so they would rate a graduated percentage price at 0. */
const NO_DIFF_TIERS_ON_GP: TierIssue = {
  index: null,
  field: null,
  message:
    "A graduated percentage price cannot take per-plan tier overrides. Use an amount override, or change the price's own tiers.",
};

/** Monthly usage billing and the commitment belong to plan recurring prices; usage needs a 2+ month term. */
export function termBillingIssue(p: {
  productKind: string | null;
  type: string;
  interval: string | null;
  intervalCount: number;
  billUsageMonthly: boolean;
  commitmentAmountMinor: number | bigint | null;
}): string | null {
  if (!p.billUsageMonthly && p.commitmentAmountMinor == null) return null;
  if (p.productKind !== "plan" || p.type !== "recurring")
    return "We could not save the price. Monthly usage billing and a minimum commitment are only for recurring plan prices.";
  if (p.billUsageMonthly && !supportsMonthlyUsage(p.interval, p.intervalCount))
    return "We could not save the price. Monthly usage billing needs a billing period of 2 months or more, in months or years.";
  return null;
}

const ONE_TIME_MINIMUM =
  "We could not save the minimum spend. A one-time price has no billing period. Remove the minimum spend.";

// ── Single-resource reads/deletes and opt-in paging ──────────────────────────

/** A differential price by its id, naming its add-on and plan. */
export interface DifferentialPriceView {
  id: string;
  addon: string;
  plan: string;
  currency: string;
  interval: string | null;
  amountMinor: number | null;
  tiers: unknown | null;
}

export async function getDifferentialPrice(
  organizationId: string,
  businessId: string,
  id: string,
): Promise<DifferentialPriceView | null> {
  return withTenant(organizationId, async (tx) => {
    const addon = alias(products, "addon");
    const plan = alias(products, "plan");
    const [r] = await tx
      .select({
        id: differentialPrices.publicId,
        addonPid: addon.publicId,
        planPid: plan.publicId,
        currency: differentialPrices.currency,
        interval: differentialPrices.interval,
        amountMinor: differentialPrices.amountMinor,
        tiers: differentialPrices.tiers,
      })
      .from(differentialPrices)
      .innerJoin(addon, eq(differentialPrices.addonProductId, addon.id))
      .innerJoin(plan, eq(differentialPrices.planProductId, plan.id))
      .where(
        and(eq(differentialPrices.businessId, businessId), eq(differentialPrices.publicId, id)),
      )
      .limit(1);
    if (!r) return null;
    return {
      id: r.id,
      addon: r.addonPid,
      plan: r.planPid,
      currency: r.currency,
      interval: r.interval,
      amountMinor: r.amountMinor != null ? Number(r.amountMinor) : null,
      tiers: r.tiers,
    };
  });
}

/**
 * Remove one differential price. The add-on then rates at its own price on that plan,
 * exactly as if the override had never been set. Live subscriptions keep their snapshot.
 */
export async function deleteDifferentialPrice(
  organizationId: string,
  businessId: string,
  id: string,
): Promise<DifferentialPriceView | null> {
  const view = await getDifferentialPrice(organizationId, businessId, id);
  if (!view) return null;
  await withTenant(organizationId, async (tx) => {
    await tx
      .delete(differentialPrices)
      .where(
        and(eq(differentialPrices.businessId, businessId), eq(differentialPrices.publicId, id)),
      );
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "differential_price_deleted",
      data: buildEventData("differential_price_deleted", {
        id: view.id,
        addon: view.addon,
        plan: view.plan,
        currency: view.currency,
      }),
    });
  });
  return view;
}

/**
 * Remove ONE plan from an add-on's attachments, leaving the rest of the set alone.
 * Returns false when there is no explicit attachment (an applicability implied by a
 * differential price is removed by deleting that differential), null when the add-on
 * does not exist.
 */
export async function deleteAttachedItem(input: {
  organizationId: string;
  businessId: string;
  itemPublicId: string;
  planPublicId: string;
}): Promise<boolean | null> {
  return withTenant(input.organizationId, async (tx) => {
    const rows = await tx
      .select({ id: products.id, publicId: products.publicId })
      .from(products)
      .where(
        and(
          eq(products.businessId, input.businessId),
          inArray(products.publicId, [input.itemPublicId, input.planPublicId]),
        ),
      );
    const item = rows.find((r) => r.publicId === input.itemPublicId);
    const plan = rows.find((r) => r.publicId === input.planPublicId);
    if (!item) return null;
    if (!plan) return false;
    const deleted = await tx
      .delete(attachedItems)
      .where(
        and(eq(attachedItems.itemProductId, item.id), eq(attachedItems.planProductId, plan.id)),
      )
      .returning({ id: attachedItems.id });
    if (deleted.length === 0) return false;
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "attached_item_deleted",
      data: buildEventData("attached_item_deleted", { id: item.publicId, plan: plan.publicId }),
    });
    const remaining = await tx
      .select({ planPid: products.publicId })
      .from(attachedItems)
      .innerJoin(products, eq(attachedItems.planProductId, products.id))
      .where(eq(attachedItems.itemProductId, item.id));
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "attached_item_updated",
      data: buildEventData("attached_item_updated", {
        id: item.publicId,
        plans: remaining.map((r) => r.planPid),
      }),
    });
    return true;
  });
}

/** One add-on or charge applicable to a plan, and why. */
export interface ApplicableAddon {
  addon: string;
  kind: string;
  active: boolean;
  /** attached = an explicit link; differential = implied by a differential price; all = applies to every plan. */
  source: "attached" | "differential" | "all";
  applicability: Applicability;
  config: AttachedItemLink;
}

/**
 * The inverse of `listItemApplicablePlans`: every add-on/charge applicable to a plan,
 * by the same three rules — an explicit link wins, a differential price implies
 * `optional`, and `addon_applies_to_all` makes it `optional` on every plan.
 */
export async function listApplicableAddonsForPlan(
  organizationId: string,
  businessId: string,
  planProductId: string,
): Promise<ApplicableAddon[]> {
  return withTenant(organizationId, async (tx) => {
    const addon = alias(products, "addon");
    const [links, diffs, all] = await Promise.all([
      tx
        .select({
          addonPid: addon.publicId,
          kind: addon.kind,
          active: addon.active,
          applicability: attachedItems.applicability,
          chargeOnEvent: attachedItems.chargeOnEvent,
          chargeOnce: attachedItems.chargeOnce,
          defaultQuantity: attachedItems.defaultQuantity,
          billingCycles: attachedItems.billingCycles,
          minQuantity: attachedItems.minQuantity,
          maxQuantity: attachedItems.maxQuantity,
          quantityStep: attachedItems.quantityStep,
          customerCanChangeQuantity: attachedItems.customerCanChangeQuantity,
        })
        .from(attachedItems)
        .innerJoin(addon, eq(attachedItems.itemProductId, addon.id))
        .where(eq(attachedItems.planProductId, planProductId)),
      tx
        .selectDistinct({ addonPid: addon.publicId, kind: addon.kind, active: addon.active })
        .from(differentialPrices)
        .innerJoin(addon, eq(differentialPrices.addonProductId, addon.id))
        .where(eq(differentialPrices.planProductId, planProductId)),
      tx
        .select({ addonPid: products.publicId, kind: products.kind, active: products.active })
        .from(products)
        .where(
          and(
            eq(products.businessId, businessId),
            inArray(products.kind, ["addon", "charge"]),
            eq(products.addonAppliesToAll, true),
          ),
        ),
    ]);
    const implied: AttachedItemLink = {
      applicability: "optional",
      chargeOnEvent: "subscription_creation",
      chargeOnce: false,
      defaultQuantity: 1,
      billingCycles: null,
      ...NO_QUANTITY_LIMITS,
    };
    const out = new Map<string, ApplicableAddon>();
    for (const r of links) {
      out.set(r.addonPid, {
        addon: r.addonPid,
        kind: r.kind,
        active: r.active,
        source: "attached",
        applicability: r.applicability as Applicability,
        config: {
          applicability: r.applicability as Applicability,
          chargeOnEvent: r.chargeOnEvent,
          chargeOnce: r.chargeOnce,
          defaultQuantity: r.defaultQuantity,
          billingCycles: r.billingCycles,
          minQuantity: r.minQuantity,
          maxQuantity: r.maxQuantity,
          quantityStep: r.quantityStep,
          customerCanChangeQuantity: r.customerCanChangeQuantity,
        },
      });
    }
    for (const [rows, source] of [
      [diffs, "differential"],
      [all, "all"],
    ] as const) {
      for (const r of rows) {
        if (out.has(r.addonPid)) continue;
        out.set(r.addonPid, {
          addon: r.addonPid,
          kind: r.kind,
          active: r.active,
          source,
          applicability: "optional",
          config: implied,
        });
      }
    }
    return [...out.values()].sort((a, b) => a.addon.localeCompare(b.addon));
  });
}

export const PRODUCT_GROUP_PAGE_SPECS: Record<string, FilterSpec> = {
  id: { column: productGroups.publicId, kind: "text" },
  name: { column: productGroups.name, kind: "text" },
  active: { column: productGroups.active, kind: "bool" },
  created_at: { column: productGroups.createdAt, kind: "date" },
  updated_at: { column: productGroups.updatedAt, kind: "date" },
};
export const PRODUCT_GROUP_SORT_FIELDS = ["created_at", "updated_at", "name", "id"] as const;

export async function pageProductGroups(
  organizationId: string,
  businessId: string,
  opts: { includeArchived?: boolean },
  page: CatalogPageRequest,
): Promise<ListPage<ProductGroup>> {
  return withTenant(organizationId, async (tx) => {
    const plan = await planPage(tx, businessId, page, {
      specs: PRODUCT_GROUP_PAGE_SPECS,
      sorts: {
        created_at: productGroups.createdAt,
        updated_at: productGroups.updatedAt,
        name: productGroups.name,
        id: productGroups.publicId,
      },
      defaultSort: "created_at",
      tiebreak: productGroups.publicId,
      searchColumns: [productGroups.publicId, productGroups.name],
      base: [
        eq(productGroups.businessId, businessId),
        opts.includeArchived ? undefined : eq(productGroups.active, true),
      ],
    });
    const rows = await tx
      .select()
      .from(productGroups)
      .where(plan.where)
      .orderBy(...plan.orderBy)
      .limit(plan.limit + 1)
      .offset(plan.offset);
    const total =
      plan.offset === 0
        ? Number(
            (await tx.select({ n: countExpr }).from(productGroups).where(plan.where))[0]?.n ?? 0,
          )
        : null;
    return finishPage(rows, plan, total);
  });
}

const groupPidSql = sql`(SELECT pg.public_id FROM product_groups pg WHERE pg.id = ${products.productGroupId})`;

export const PRODUCT_PAGE_SPECS: Record<string, FilterSpec> = {
  id: { column: products.publicId, kind: "text" },
  name: { column: products.name, kind: "text" },
  external_name: { column: products.externalName, kind: "text" },
  kind: { column: products.kind, kind: "enum" },
  product_group: { column: groupPidSql, kind: "text" },
  metered: { column: products.metered, kind: "bool" },
  enabled_for_checkout: { column: products.enabledForCheckout, kind: "bool" },
  enabled_in_portal: { column: products.enabledInPortal, kind: "bool" },
  active: { column: products.active, kind: "bool" },
  created_at: { column: products.createdAt, kind: "date" },
  updated_at: { column: products.updatedAt, kind: "date" },
};
export const PRODUCT_SORT_FIELDS = ["created_at", "updated_at", "name", "id"] as const;

/** Paged products; the flat `group`/`kind`/`status` params keep their unpaged meaning. */
export async function pageProducts(
  organizationId: string,
  businessId: string,
  opts: { includeArchived?: boolean; archivedOnly?: boolean; groupId?: string; kind?: string },
  page: CatalogPageRequest,
): Promise<ListPage<typeof products.$inferSelect>> {
  return withTenant(organizationId, async (tx) => {
    const plan = await planPage(tx, businessId, page, {
      specs: PRODUCT_PAGE_SPECS,
      sorts: {
        created_at: products.createdAt,
        updated_at: products.updatedAt,
        name: products.name,
        id: products.publicId,
      },
      defaultSort: "created_at",
      tiebreak: products.publicId,
      searchColumns: [products.publicId, products.name, products.externalName],
      base: [
        eq(products.businessId, businessId),
        opts.archivedOnly
          ? eq(products.active, false)
          : opts.includeArchived
            ? undefined
            : eq(products.active, true),
        opts.groupId ? eq(products.productGroupId, opts.groupId) : undefined,
        opts.kind ? eq(products.kind, opts.kind) : undefined,
      ],
    });
    const rows = await tx
      .select()
      .from(products)
      .where(plan.where)
      .orderBy(...plan.orderBy)
      .limit(plan.limit + 1)
      .offset(plan.offset);
    const total =
      plan.offset === 0
        ? Number((await tx.select({ n: countExpr }).from(products).where(plan.where))[0]?.n ?? 0)
        : null;
    return finishPage(rows, plan, total);
  });
}

export const PRICE_PAGE_SPECS: Record<string, FilterSpec> = {
  id: { column: prices.publicId, kind: "text" },
  name: { column: prices.name, kind: "text" },
  product: { column: products.publicId, kind: "text" },
  type: { column: prices.type, kind: "enum" },
  model: { column: prices.model, kind: "enum" },
  currency: { column: prices.currency, kind: "enum" },
  interval: { column: prices.interval, kind: "enum" },
  interval_count: { column: prices.intervalCount, kind: "number" },
  amount_minor: { column: prices.amountMinor, kind: "number" },
  active: { column: prices.active, kind: "bool" },
  created_at: { column: prices.createdAt, kind: "date" },
  updated_at: { column: prices.updatedAt, kind: "date" },
};
export const PRICE_SORT_FIELDS = [
  "created_at",
  "updated_at",
  "name",
  "id",
  "amount_minor",
] as const;

/** Paged prices; the flat CAT-8 params keep their unpaged meaning. */
export async function pagePrices(
  organizationId: string,
  businessId: string,
  opts: {
    includeArchived?: boolean;
    currency?: string;
    interval?: string;
    model?: string;
    productPublicId?: string;
    status?: "active" | "archived";
  },
  page: CatalogPageRequest,
): Promise<ListPage<{ price: typeof prices.$inferSelect; productPublicId: string }>> {
  return withTenant(organizationId, async (tx) => {
    const plan = await planPage(tx, businessId, page, {
      specs: PRICE_PAGE_SPECS,
      sorts: {
        created_at: prices.createdAt,
        updated_at: prices.updatedAt,
        name: prices.name,
        id: prices.publicId,
        amount_minor: prices.amountMinor,
      },
      defaultSort: "created_at",
      tiebreak: prices.publicId,
      searchColumns: [prices.publicId, prices.name, prices.externalName],
      base: [
        eq(prices.businessId, businessId),
        opts.status === "archived"
          ? eq(prices.active, false)
          : opts.status === "active" || !opts.includeArchived
            ? eq(prices.active, true)
            : undefined,
        opts.currency ? eq(prices.currency, opts.currency.toUpperCase()) : undefined,
        opts.interval ? eq(prices.interval, opts.interval) : undefined,
        opts.model ? eq(prices.model, opts.model) : undefined,
        opts.productPublicId ? eq(products.publicId, opts.productPublicId) : undefined,
      ],
    });
    const rows = await tx
      .select({ price: prices, productPublicId: products.publicId })
      .from(prices)
      .innerJoin(products, eq(prices.productId, products.id))
      .where(plan.where)
      .orderBy(...plan.orderBy)
      .limit(plan.limit + 1)
      .offset(plan.offset);
    const total =
      plan.offset === 0
        ? Number(
            (
              await tx
                .select({ n: countExpr })
                .from(prices)
                .innerJoin(products, eq(prices.productId, products.id))
                .where(plan.where)
            )[0]?.n ?? 0,
          )
        : null;
    return finishPage(rows, plan, total);
  });
}
