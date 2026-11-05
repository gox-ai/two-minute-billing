import type { FastifyInstance, FastifyReply } from "fastify";
import { metadataField, redirectUrl } from "./limits";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  createProduct,
  updateProduct,
  setProductActive,
  listProducts,
  getProductByPublicId,
  createProductGroup,
  updateProductGroup,
  setProductGroupActive,
  listProductGroups,
  getProductGroupByPublicId,
  createPrice,
  updatePrice,
  setPriceActive,
  listPrices,
  getPriceByPublicId,
  setItemApplicablePlans,
  listItemApplicablePlans,
  listApplicablePlansForBusiness,
  setDifferentialPrice,
  listDifferentialPrices,
  listDifferentialPricesForBusiness,
  getDifferentialPrice,
  deleteDifferentialPrice,
  deleteAttachedItem,
  listApplicableAddonsForPlan,
  pageProductGroups,
  pageProducts,
  pagePrices,
  PRODUCT_GROUP_PAGE_SPECS,
  PRODUCT_GROUP_SORT_FIELDS,
  PRODUCT_PAGE_SPECS,
  PRODUCT_SORT_FIELDS,
  PRICE_PAGE_SPECS,
  PRICE_SORT_FIELDS,
  CatalogError,
  TierListError,
  SlugConflictError,
  type ApplicableAddon,
  type DifferentialPriceView,
  type ProductGroup,
} from "@/modules/catalog/service";
import { catalogListEnvelope, catalogPageQuery, wantsListQuery } from "./catalog-list";
import type { prices, products } from "@db/schema";
import {
  resolveBusiness,
  badRequest,
  notFound,
  conflict,
  VersionConflictError,
  requirePerm,
  refusedByRateLimit,
} from "./helpers";
import { parseRequest } from "./strict-params";
import {
  billsFromList,
  isMeteredPrice,
  MAX_PRICE_RATES,
  TIER_MODELS,
  tierListIssues,
  USAGE_AGGREGATIONS,
  usagePricingIssues,
  type MeterTier,
  type PriceTier,
  type TierIssue,
} from "@/modules/catalog/pricing";
import {
  MeterPriceError,
  meterPriceViews,
  type MeterPriceView,
} from "@/modules/catalog/meter-prices";
import { fixed12FromNumeric, formatFixed12 } from "@/platform/fixed";
import { withTenant } from "@/platform/db";
import { config } from "@/platform/config";
import { UPLOAD_LIMIT_MESSAGE, UPLOAD_WINDOW_MS } from "@/platform/rate-limit";
import { ImageUploadError, MAX_IMAGE_BYTES } from "@/platform/image-upload";
import {
  ObjectStoreNotConfiguredError,
  deleteStoredImage,
  uploadBrandImage,
} from "@/platform/object-store";

function serializeDifferentialPrice(d: DifferentialPriceView) {
  return {
    object: "differential_price",
    id: d.id,
    addon: d.addon,
    plan: d.plan,
    currency: d.currency,
    interval: d.interval,
    amount_minor: d.amountMinor,
    tiers: d.tiers,
  };
}

/** One add-on ↔ plan applicability, flat. `source` says why it applies. */
function serializeApplicability(a: ApplicableAddon, plan: string) {
  return {
    object: "attached_item",
    item: a.addon,
    plan,
    kind: a.kind,
    active: a.active,
    source: a.source,
    applicability: a.applicability,
    charge_on_event: a.config.chargeOnEvent,
    charge_once: a.config.chargeOnce,
    default_quantity: a.config.defaultQuantity,
    billing_cycles: a.config.billingCycles,
    min_quantity: a.config.minQuantity,
    max_quantity: a.config.maxQuantity,
    quantity_step: a.config.quantityStep,
    customer_can_change_quantity: a.config.customerCanChangeQuantity,
  };
}

/** `POST …/products/:prod/image` — base64 bytes; the leading bytes decide the type. */
const productImageBody = z.object({
  data: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4),
  content_type: z.string().max(128).optional(),
});

function serializeProduct(p: typeof products.$inferSelect, groupPublicId: string) {
  return {
    object: "product",
    id: p.publicId,
    product_group: groupPublicId,
    kind: p.kind,
    name: p.name,
    external_name: p.externalName,
    description: p.description,
    unit_of_measure: p.unitOfMeasure,
    metered: p.metered,
    enabled_for_checkout: p.enabledForCheckout,
    enabled_in_portal: p.enabledInPortal,
    redirect_url: p.redirectUrl,
    /** The buyer-facing picture; null when none. Set with `POST …/products/:prod/image`. */
    image_url: p.imageUrl,
    tax_code: p.taxCode,
    addon_applies_to_all: p.addonAppliesToAll,
    metadata: p.metadata,
    active: p.active,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    resource_version: p.resourceVersion,
  };
}

function serializeProductGroup(g: ProductGroup) {
  return {
    object: "product_group",
    id: g.publicId,
    name: g.name,
    description: g.description,
    active: g.active,
    created_at: g.createdAt,
    updated_at: g.updatedAt,
    resource_version: g.resourceVersion,
  };
}

function serializePrice(
  pr: typeof prices.$inferSelect,
  productPublicId: string,
  meterView?: MeterPriceView,
) {
  return {
    object: "price",
    id: pr.publicId,
    product: productPublicId,
    name: pr.name,
    external_name: pr.externalName,
    description: pr.description,
    type: pr.type,
    model: pr.model,
    currency: pr.currency,
    amount_minor: pr.amountMinor != null ? Number(pr.amountMinor) : null,
    interval: pr.interval,
    interval_count: pr.intervalCount,
    usage_aggregation: pr.usageAggregation,
    usage_recurring: pr.usageRecurring,
    usage_time_unit: pr.usageTimeUnit,
    // Read-only: the price bills measured usage (`isMeteredPrice`).
    metered: isMeteredPrice(pr),
    tiers: pr.tiers,
    // Meter prices (0453); null / defaults on every other price.
    meter: meterView?.meter ?? null,
    unit_amount_decimal:
      pr.unitAmountDecimal != null ? formatFixed12(fixed12FromNumeric(pr.unitAmountDecimal)) : null,
    quantity_divisor: String(pr.quantityDivisor),
    amount_source: pr.amountSource,
    markup_percent:
      pr.markupPercent != null ? formatFixed12(fixed12FromNumeric(pr.markupPercent)) : null,
    // Billed from the list: list | cost (null reads as list).
    markup_base: billsFromList(pr.amountSource) ? (pr.markupBase ?? "list") : null,
    rates: meterView?.rates ?? [],
    package_size: pr.packageSize,
    free_units: pr.freeUnits,
    percentage_bps: pr.percentageBps,
    minimum_amount_minor: pr.minimumAmountMinor != null ? Number(pr.minimumAmountMinor) : null,
    bill_usage_monthly: pr.billUsageMonthly,
    commitment_amount_minor:
      pr.commitmentAmountMinor != null ? Number(pr.commitmentAmountMinor) : null,
    // 0465: a credit pack (one-time) or credits per cycle (recurring); null grants nothing.
    grants_credit: pr.grantsCredit ?? null,
    trial_period: pr.trialPeriod,
    trial_period_unit: pr.trialPeriodUnit,
    trial_end_action: pr.trialEndAction,
    billing_cycles: pr.billingCycles,
    free_quantity: pr.freeQuantity,
    portal_min_quantity: pr.portalMinQuantity,
    portal_max_quantity: pr.portalMaxQuantity,
    invoice_notes: pr.invoiceNotes,
    show_description_in_invoices: pr.showDescriptionInInvoices,
    show_description_in_quotes: pr.showDescriptionInQuotes,
    tax_code: pr.taxCode,
    // Accounting metadata, flat. Descriptive only — nothing in the engine
    // reads these, and accounting_code is NOT a ledger account handle.
    sku: pr.sku,
    accounting_code: pr.accountingCode,
    accounting_category_code: pr.accountingCategoryCode,
    is_taxable: pr.isTaxable,
    tax_behavior: pr.taxBehavior,
    metadata: pr.metadata,
    active: pr.active,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    resource_version: pr.resourceVersion,
  };
}

const productKind = z.enum(["plan", "addon", "charge"]);

const productFields = {
  external_name: z.string().max(200),
  unit_of_measure: z.string().max(100),
  metered: z.boolean(),
  enabled_for_checkout: z.boolean(),
  enabled_in_portal: z.boolean(),
  // The checkout sends buyers here after paying, so it must be a URL a browser may follow.
  // "" clears it.
  redirect_url: z.union([z.literal(""), redirectUrl()]),
  // HSN/SAC classification (India GST). Length-capped rather than pattern-matched: the
  // code set is jurisdictional and revised by notification, so a regex here would reject
  // a valid future code and force a deploy to accept it.
  tax_code: z.string().max(20),
  metadata: metadataField(),
};

/**
 * Catalog slug ids, CASE-PRESERVING — the same rule `validateSlug()` already enforces in
 * the service (`src/modules/catalog/service.ts`, `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`).
 *
 * This route used to demand lowercase, which contradicted both the service and the `id`
 * comment on `createPriceBody` below ("a caller migrating an external catalog must be able
 * to keep its ids, and the service already accepted this"). Imported ids are often
 * mixed-case (`platform-pro-v202607-USD-Monthly`) and the id-stable migration stores them
 * verbatim, so the ONLY way to create one was to bypass the API and call the service
 * directly — which is exactly what `src/modules/migration/import.ts` does. Widened
 * 2026-08-25 so fixtures can be created over the public API instead of forcing a
 * credential-rotating re-import.
 */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const createProductBody = z.object({
  name: z.string().min(1).max(200),
  external_name: productFields.external_name.optional(),
  description: z.string().max(2000).optional(),
  kind: productKind.default("plan"),
  id: z.string().regex(SLUG_RE, "id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$").optional(),
  unit_of_measure: productFields.unit_of_measure.optional(),
  metered: productFields.metered.optional(),
  enabled_for_checkout: productFields.enabled_for_checkout.optional(),
  enabled_in_portal: productFields.enabled_in_portal.optional(),
  redirect_url: productFields.redirect_url.optional(),
  tax_code: productFields.tax_code.optional(),
  addon_applies_to_all: z.boolean().optional(),
  metadata: productFields.metadata.optional(),
  // Group to file under; omit → the business's Default group.
  product_group: z.string().min(1).max(100).optional(),
});

const updateProductBody = z.object({
  name: z.string().min(1).max(200).optional(),
  external_name: productFields.external_name.nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  kind: productKind.optional(),
  unit_of_measure: productFields.unit_of_measure.nullable().optional(),
  metered: productFields.metered.optional(),
  enabled_for_checkout: productFields.enabled_for_checkout.optional(),
  enabled_in_portal: productFields.enabled_in_portal.optional(),
  redirect_url: productFields.redirect_url.nullable().optional(),
  tax_code: productFields.tax_code.nullable().optional(),
  addon_applies_to_all: z.boolean().optional(),
  metadata: productFields.metadata.nullable().optional(),
  product_group: z.string().min(1).max(100).optional(),
  active: z.boolean().optional(),
  expected_version: z.number().int().nonnegative().optional(),
});

const createGroupBody = z.object({
  name: z.string().min(1).max(200),
  id: z.string().regex(SLUG_RE, "id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$").optional(),
  description: z.string().max(2000).optional(),
});

const updateGroupBody = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  active: z.boolean().optional(),
});

const priceModel = z.enum([
  "flat",
  "per_unit",
  "tiered",
  "volume",
  "stairstep",
  "usage",
  "package",
  "percentage",
  "graduated_percentage",
]);

/**
 * Accounting metadata, exposed FLAT (three optional scalars with no cardinality of their
 * own — a nested object would be invented structure our API style does not use anywhere
 * else).
 *
 * DESCRIPTIVE METADATA ONLY. Nothing in the engine reads them; `accounting_code` is a
 * free-text customer GL handle and is deliberately NOT resolved against `ledger_accounts`.
 * Nullable on create too, so a PUT-shaped client can clear them the same way it sets them.
 */
const priceAccountingFields = {
  sku: z.string().max(200).nullable().optional(),
  accounting_code: z.string().max(200).nullable().optional(),
  accounting_category_code: z.string().max(200).nullable().optional(),
};

const tierSchema = z.object({
  upToMinor: z.number().int().positive().nullable(),
  unitAmountMinor: z.number().int().nonnegative().optional(),
  flatAmountMinor: z.number().int().nonnegative().optional(),
  // graduated_percentage: the rate inside this tier, in basis points.
  rateBps: z.number().int().nonnegative().max(1_000_000).optional(),
});

/** A tier on a meter price (0453): decimal bound, a rate per `quantity_divisor` units. */
const meterTierSchema = z.object({
  up_to: z.string().max(60).nullable(),
  unit_amount_decimal: z.string().max(60),
  flat_amount_minor: z.number().int().nonnegative().optional(),
});

/** Meter price fields (0453). Validated against the meter by `meterPriceIssues`. */
const meterPriceFields = {
  // The meter's key (or id). Its aggregation, recurring and time unit are copied.
  meter: z.string().min(1).max(100).optional(),
  // Minor units per `quantity_divisor` units, up to 12 decimals, no exponent.
  unit_amount_decimal: z.string().max(60).optional(),
  quantity_divisor: z
    .union([z.string().regex(/^\d{1,18}$/), z.number().int().positive()])
    .optional(),
  amount_source: z.string().max(40).optional(),
  markup_percent: z.string().max(40).optional(),
  // model_price_list: list | cost. Checked by `meterPriceIssues`.
  markup_base: z.string().max(10).optional(),
  rates: z
    .array(
      z.object({
        match: z.record(z.string(), z.string().max(255)),
        unit_amount_decimal: z.string().max(60).optional(),
        tiers: z.array(meterTierSchema).min(1).optional(),
        markup_percent: z.string().max(40).optional(),
      }),
    )
    .max(MAX_PRICE_RATES)
    .optional(),
};
const METER_ONLY_FIELDS = [
  "unit_amount_decimal",
  "quantity_divisor",
  "amount_source",
  "markup_percent",
  "markup_base",
  "rates",
] as const;

const SNAKE_TIER_FIELD = {
  upToMinor: "up_to_minor",
  unitAmountMinor: "unit_amount_minor",
  rateBps: "rate_bps",
} as const;

/** `tierListIssues` as zod issues under `tiers.<i>.<field>`, so a 400 names the tier. */
function tierZodIssues(issues: TierIssue[], snake = false) {
  return issues.map((i) => {
    const field = i.field && snake ? SNAKE_TIER_FIELD[i.field] : i.field;
    return {
      code: "custom" as const,
      path: i.index == null ? ["tiers"] : ["tiers", i.index, ...(field ? [field] : [])],
      message: i.message,
      input: undefined,
    };
  });
}

/** The service's tier refusal (a model only it knows, e.g. on PATCH) as field errors. */
function tierListBadRequest(reply: FastifyReply, e: TierListError, snake = false) {
  return badRequest(reply, new z.ZodError(tierZodIssues(e.issues, snake)));
}

const createPriceBody = z
  .object({
    product: z.string().min(1).max(100),
    // CAT-0 slug id, same contract as products/groups: caller-named, else auto-derived
    // from the name (or currency/interval/model). Auto-deriving is a better default, but
    // a caller migrating an external catalog must be able to keep its ids, and the service
    // already accepted this.
    id: z.string().regex(SLUG_RE, "id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$").optional(),
    name: z.string().max(200).optional(),
    external_name: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    model: priceModel,
    type: z.enum(["recurring", "one_time"]).default("recurring"),
    currency: z.string().length(3),
    amount_minor: z.number().int().nonnegative().optional(),
    interval: z.enum(["day", "week", "month", "year"]).optional(),
    interval_count: z.number().int().positive().default(1),
    usage_aggregation: z.enum(USAGE_AGGREGATIONS).optional(),
    usage_recurring: z.boolean().optional(),
    usage_time_unit: z.enum(["hour", "day"]).optional(),
    // A meter price takes tiers in the meter tier shape (`meterTierSchema`).
    tiers: z
      .array(z.union([tierSchema, meterTierSchema]))
      .min(1)
      .optional(),
    ...meterPriceFields,
    package_size: z.number().int().positive().optional(),
    free_units: z.number().int().nonnegative().optional(),
    percentage_bps: z.number().int().positive().max(1_000_000).optional(),
    minimum_amount_minor: z.number().int().nonnegative().optional(),
    bill_usage_monthly: z.boolean().optional(),
    commitment_amount_minor: z.number().int().positive().optional(),
    grants_credit: z.record(z.string(), z.unknown()).nullable().optional(),
    trial_period: z.number().int().nonnegative().optional(),
    trial_period_unit: z.enum(["day", "week", "month", "year"]).optional(),
    trial_end_action: z.enum(["activate_subscription", "cancel_subscription"]).optional(),
    billing_cycles: z.number().int().positive().optional(),
    free_quantity: z.number().int().nonnegative().optional(),
    // Portal-only seat limits; staff may set any quantity.
    portal_min_quantity: z.number().int().positive().optional(),
    portal_max_quantity: z.number().int().positive().optional(),
    invoice_notes: z.string().max(2000).optional(),
    show_description_in_invoices: z.boolean().optional(),
    show_description_in_quotes: z.boolean().optional(),
    // HSN/SAC for this price — same length-capped shape as products.tax_code.
    tax_code: productFields.tax_code.optional(),
    ...priceAccountingFields,
    is_taxable: z.boolean().optional(),
    tax_behavior: z.enum(["inclusive", "exclusive"]).optional(),
    metadata: metadataField().optional(),
  })
  .refine((v) => v.type !== "recurring" || !!v.interval, {
    message: "recurring price requires an interval",
    path: ["interval"],
  })
  .refine(
    (v) => v.meter != null || !["flat", "per_unit"].includes(v.model) || v.amount_minor != null,
    {
      message: "amount_minor is required for flat/per_unit prices",
      path: ["amount_minor"],
    },
  )
  .refine((v) => !TIER_MODELS.has(v.model) || (v.tiers?.length ?? 0) > 0, {
    message: "tiers are required for tiered/volume/stairstep/graduated_percentage prices",
    path: ["tiers"],
  })
  .refine(
    (v) =>
      v.meter != null ||
      v.model !== "package" ||
      (v.package_size != null && v.amount_minor != null),
    {
      message: "package prices require package_size and amount_minor",
      path: ["package_size"],
    },
  )
  .refine((v) => v.model !== "percentage" || v.percentage_bps != null, {
    message: "percentage prices require percentage_bps",
    path: ["percentage_bps"],
  })
  .refine((v) => v.type !== "one_time" || v.minimum_amount_minor == null, {
    message: "A one-time price has no billing period, so it cannot have a minimum spend.",
    path: ["minimum_amount_minor"],
  })
  .superRefine((v, ctx) => {
    if (v.meter != null) {
      // A meter price copies how it measures usage from the meter.
      for (const f of LOCKED_USAGE_FIELDS)
        if (v[f] !== undefined)
          ctx.addIssue({
            code: "custom",
            path: [f],
            message: `A price on a meter takes ${f} from the meter. Remove ${f}.`,
          });
      return;
    }
    for (const f of METER_ONLY_FIELDS)
      if (v[f] !== undefined)
        ctx.addIssue({
          code: "custom",
          path: [f],
          message: `${f} applies only to a price on a meter. Set meter.`,
        });
    if (v.tiers?.some((t) => !("upToMinor" in t)))
      ctx.addIssue({
        code: "custom",
        path: ["tiers"],
        message: "Use upToMinor tiers. The up_to tier shape is for a price on a meter.",
      });
    else if (v.tiers?.length)
      for (const i of tierZodIssues(tierListIssues(v.tiers as PriceTier[], v.model)))
        ctx.addIssue(i);
    for (const i of usagePricingIssues({
      model: v.model,
      usageAggregation: v.usage_aggregation,
      usageRecurring: v.usage_recurring,
      usageTimeUnit: v.usage_time_unit,
    }))
      ctx.addIssue({ code: "custom", path: [i.field], message: i.message });
  });

/** How a price measures usage is fixed at create: live items rate from it. */
const LOCKED_USAGE_FIELDS = ["usage_aggregation", "usage_recurring", "usage_time_unit"] as const;
const lockedUsageField = z
  .unknown()
  .optional()
  .refine((v) => v === undefined, {
    message:
      "You cannot change how a price measures usage after you create it. Create a new price.",
  });

/** Fixed at create on a meter price: live items and the rate card depend on them. */
const LOCKED_METER_FIELDS = ["meter", "amount_source", "quantity_divisor"] as const;
const lockedMeterField = z
  .unknown()
  .optional()
  .refine((v) => v === undefined, {
    message:
      "You cannot change the meter, amount source or divisor of a price. Create a new price.",
  });

const updatePriceBody = z.object({
  ...Object.fromEntries(LOCKED_USAGE_FIELDS.map((f) => [f, lockedUsageField])),
  ...Object.fromEntries(LOCKED_METER_FIELDS.map((f) => [f, lockedMeterField])),
  name: z.string().max(200).nullable().optional(),
  external_name: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  amount_minor: z.number().int().nonnegative().nullable().optional(),
  tiers: z
    .array(z.union([tierSchema, meterTierSchema]))
    .min(1)
    .nullable()
    .optional(),
  // Meter prices: the rate, the markup and the whole rate card (replaced). The meter, the
  // amount source and the divisor are fixed at create.
  unit_amount_decimal: z.string().max(60).nullable().optional(),
  markup_percent: z.string().max(40).nullable().optional(),
  markup_base: z.string().max(10).nullable().optional(),
  rates: meterPriceFields.rates,
  package_size: z.number().int().positive().nullable().optional(),
  free_units: z.number().int().nonnegative().nullable().optional(),
  percentage_bps: z.number().int().positive().max(1_000_000).nullable().optional(),
  minimum_amount_minor: z.number().int().nonnegative().nullable().optional(),
  bill_usage_monthly: z.boolean().optional(),
  commitment_amount_minor: z.number().int().positive().nullable().optional(),
  grants_credit: z.record(z.string(), z.unknown()).nullable().optional(),
  trial_period: z.number().int().nonnegative().nullable().optional(),
  trial_period_unit: z.enum(["day", "week", "month", "year"]).nullable().optional(),
  trial_end_action: z.enum(["activate_subscription", "cancel_subscription"]).nullable().optional(),
  billing_cycles: z.number().int().positive().nullable().optional(),
  free_quantity: z.number().int().nonnegative().nullable().optional(),
  portal_min_quantity: z.number().int().positive().nullable().optional(),
  portal_max_quantity: z.number().int().positive().nullable().optional(),
  invoice_notes: z.string().max(2000).nullable().optional(),
  show_description_in_invoices: z.boolean().optional(),
  show_description_in_quotes: z.boolean().optional(),
  tax_code: productFields.tax_code.nullable().optional(),
  ...priceAccountingFields,
  is_taxable: z.boolean().optional(),
  tax_behavior: z.enum(["inclusive", "exclusive"]).optional(),
  metadata: metadataField().nullable().optional(),
  active: z.boolean().optional(),
  expected_version: z.number().int().nonnegative().optional(),
});

const applicabilityEnum = z.enum(["mandatory", "recommended", "optional"]);
const chargeOnEventEnum = z.enum([
  "subscription_creation",
  "trial_start",
  "activation",
  "on_demand",
]);
const applicablePlansBody = z.object({
  plans: z.array(z.string().min(1).max(100)),
  /**
   * The add-on's "applies to every plan" flag. The GET on this path already reports
   * `applies_to_all`, so without it here a GET→edit→PUT round-trip silently dropped
   * the field. Optional, and omitting it LEAVES the flag alone — a caller sending only
   * `plans` is editing the link set, not clearing the flag.
   */
  applies_to_all: z.boolean().optional(),
  // Optional per-plan applicability map { plan_public_id: level } (CP-6).
  applicability: z.record(z.string(), applicabilityEnum).optional(),
  // CAT-4: optional per-plan attached-item charge config.
  config: z
    .record(
      z.string(),
      z.object({
        charge_on_event: chargeOnEventEnum.optional(),
        charge_once: z.boolean().optional(),
        default_quantity: z.number().int().positive().optional(),
        billing_cycles: z.number().int().positive().nullable().optional(),
        // Portal-only quantity limits; staff may set any quantity.
        min_quantity: z.number().int().positive().nullable().optional(),
        max_quantity: z.number().int().positive().nullable().optional(),
        quantity_step: z.number().int().positive().max(100000).optional(),
        customer_can_change_quantity: z.boolean().optional(),
      }),
    )
    .optional(),
});

const differentialPriceBody = z
  .object({
    plan: z.string().min(1).max(100),
    currency: z.string().length(3),
    interval: z.enum(["day", "week", "month", "year"]).nullable().optional(),
    // CAT-7: a flat/per-unit amount OR a tiers table (exactly one).
    amount_minor: z.number().int().nonnegative().optional(),
    tiers: z
      .array(
        z.object({
          up_to_minor: z.number().int().positive().nullable(),
          unit_amount_minor: z.number().int().nonnegative().optional(),
          flat_amount_minor: z.number().int().nonnegative().optional(),
        }),
      )
      .optional(),
  })
  .refine((v) => v.amount_minor != null || (v.tiers && v.tiers.length > 0), {
    message: "amount_minor or tiers required",
  })
  .superRefine((v, ctx) => {
    if (!v.tiers?.length) return;
    const tiers = v.tiers.map((t) => ({ upToMinor: t.up_to_minor }));
    for (const i of tierZodIssues(tierListIssues(tiers), true)) ctx.addIssue(i);
  });

export async function registerCatalogRoutes(app: FastifyInstance) {
  app.post(
    "/v1/businesses/:biz/products",
    {
      preHandler: [authenticate, requirePerm("catalog:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(createProductBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const p = await createProduct({
          organizationId: req.organization!.id,
          businessId: business.id,
          name: parsed.data.name,
          externalName: parsed.data.external_name,
          description: parsed.data.description,
          kind: parsed.data.kind,
          id: parsed.data.id,
          unitOfMeasure: parsed.data.unit_of_measure,
          metered: parsed.data.metered,
          enabledForCheckout: parsed.data.enabled_for_checkout,
          enabledInPortal: parsed.data.enabled_in_portal,
          redirectUrl: parsed.data.redirect_url,
          taxCode: parsed.data.tax_code,
          addonAppliesToAll: parsed.data.addon_applies_to_all,
          metadata: parsed.data.metadata,
          productGroupPublicId: parsed.data.product_group,
        });
        return reply.code(201).send(serializeProduct(p, p.groupPublicId));
      } catch (e) {
        if (e instanceof SlugConflictError) return conflict(reply, e.message);
        if (e instanceof CatalogError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/products",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const orgId = req.organization!.id;
      const query = req.query as {
        include_archived?: string;
        group?: string;
        kind?: string;
        status?: string;
      };
      // CAT-8: status=archived surfaces archived; status=active / default → active only.
      const includeArchived = query.include_archived === "true" || query.status === "archived";
      const page = wantsListQuery(req)
        ? catalogPageQuery(req, reply, {
            specs: PRODUCT_PAGE_SPECS,
            sortFields: PRODUCT_SORT_FIELDS,
            bareParams: ["include_archived", "group", "kind", "status"],
          })
        : undefined;
      if (page === null) return;
      // Map group internal id → public id (include archived so every product resolves).
      const groups = await listProductGroups(orgId, business.id, { includeArchived: true });
      const pidById = new Map(groups.map((g) => [g.id, g.publicId]));
      let groupId: string | undefined;
      if (query.group) {
        const g = groups.find((x) => x.publicId === query.group);
        if (!g) return notFound(reply, `No such product group: ${query.group}`);
        groupId = g.id;
      }
      if (page) {
        const result = await pageProducts(
          orgId,
          business.id,
          {
            includeArchived,
            archivedOnly: query.status === "archived",
            groupId,
            kind: query.kind,
          },
          page,
        );
        return catalogListEnvelope(page, result, (p) =>
          serializeProduct(p, pidById.get(p.productGroupId) ?? ""),
        );
      }
      let rows = await listProducts(orgId, business.id, {
        includeArchived,
        groupId,
        kind: query.kind,
      });
      if (query.status === "archived") rows = rows.filter((p) => !p.active);
      return {
        object: "list",
        data: rows.map((p) => serializeProduct(p, pidById.get(p.productGroupId) ?? "")),
      };
    },
  );

  // Edit a product (name/desc/kind/code/group/applies-to-all/active). Only provided fields change.
  app.patch(
    "/v1/businesses/:biz/products/:prod",
    {
      preHandler: [authenticate, requirePerm("catalog:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      // CAT-0 DoD: the slug id is immutable — attempting to change it is a 400, not a silent no-op.
      if ((req.body as Record<string, unknown> | null)?.id !== undefined)
        return badRequest(reply, "id is immutable and cannot be changed");
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(updateProductBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { prod } = req.params as { prod: string };
      const orgId = req.organization!.id;
      try {
        if (parsed.data.active !== undefined && Object.keys(parsed.data).length === 1) {
          const p = await setProductActive(orgId, business.id, prod, parsed.data.active);
          if (!p) return notFound(reply, `No such product: ${prod}`);
          return serializeProduct(p, await groupPid(orgId, business.id, p.productGroupId));
        }
        const p = await updateProduct({
          organizationId: orgId,
          businessId: business.id,
          productPublicId: prod,
          expectedVersion: parsed.data.expected_version,
          name: parsed.data.name,
          externalName: parsed.data.external_name,
          description: parsed.data.description,
          kind: parsed.data.kind,
          unitOfMeasure: parsed.data.unit_of_measure,
          metered: parsed.data.metered,
          enabledForCheckout: parsed.data.enabled_for_checkout,
          enabledInPortal: parsed.data.enabled_in_portal,
          redirectUrl: parsed.data.redirect_url,
          taxCode: parsed.data.tax_code,
          addonAppliesToAll: parsed.data.addon_applies_to_all,
          metadata: parsed.data.metadata,
          productGroupPublicId: parsed.data.product_group,
        });
        if (!p) return notFound(reply, `No such product: ${prod}`);
        if (parsed.data.active !== undefined) {
          const p2 = await setProductActive(orgId, business.id, prod, parsed.data.active);
          return serializeProduct(p2 ?? p, p.groupPublicId);
        }
        return serializeProduct(p, p.groupPublicId);
      } catch (e) {
        if (e instanceof SlugConflictError) return conflict(reply, e.message);
        if (e instanceof CatalogError) return badRequest(reply, e.message);
        if (e instanceof VersionConflictError) return conflict(reply, e.message);
        throw e;
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/products/:prod",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { prod } = req.params as { prod: string };
      const orgId = req.organization!.id;
      const p = await getProductByPublicId(orgId, business.id, prod);
      if (!p) return notFound(reply, `No such product: ${prod}`);
      return serializeProduct(p, await groupPid(orgId, business.id, p.productGroupId));
    },
  );

  // Archive a product (soft — active=false; keeps history + existing subs working).
  app.delete(
    "/v1/businesses/:biz/products/:prod",
    {
      preHandler: [authenticate, requirePerm("catalog:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { prod } = req.params as { prod: string };
      const orgId = req.organization!.id;
      const p = await setProductActive(orgId, business.id, prod, false);
      if (!p) return notFound(reply, `No such product: ${prod}`);
      return serializeProduct(p, await groupPid(orgId, business.id, p.productGroupId));
    },
  );

  /**
   * The product's picture (0347): store the file and point the product at it in one call,
   * so `image_url` only ever holds a URL this deployment stored. Base64 JSON, for the reasons
   * `POST …/brand_images` gives. The replaced picture's object is deleted afterwards — best
   * effort: a failed delete costs storage, not correctness.
   */
  app.post(
    "/v1/businesses/:biz/products/:prod/image",
    {
      // A 5 MB image is ~6.7 MB of base64; raised here only, as on the brand route.
      bodyLimit: 8 * 1024 * 1024,
      preHandler: [authenticate, requirePerm("catalog:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { prod } = req.params as { prod: string };
      const orgId = req.organization!.id;
      const parsed = parseRequest(productImageBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const before = await getProductByPublicId(orgId, business.id, prod);
      if (!before) return notFound(reply, `No such product: ${prod}`);
      if (
        await refusedByRateLimit(
          req,
          reply,
          {
            scope: "product_image_upload",
            keys: [
              {
                kind: "organization",
                value: req.organization?.id,
                limit: config.RATE_LIMIT_PRODUCT_IMAGE_UPLOADS_PER_ORG,
              },
            ],
            windowMs: UPLOAD_WINDOW_MS,
          },
          UPLOAD_LIMIT_MESSAGE,
        )
      )
        return;
      const owner = { kind: "business" as const, publicId: business.publicId };
      let url: string;
      try {
        url = (
          await uploadBrandImage({
            owner,
            asset: "product",
            buffer: Buffer.from(parsed.data.data, "base64"),
            declaredType: parsed.data.content_type ?? null,
          })
        ).url;
      } catch (e) {
        if (e instanceof ObjectStoreNotConfiguredError)
          return reply.code(503).send({
            error: {
              type: "api_error",
              message: "Image uploads are not enabled on this deployment.",
            },
          });
        if (e instanceof ImageUploadError) return badRequest(reply, e.message);
        throw e;
      }
      const p = await updateProduct({
        organizationId: orgId,
        businessId: business.id,
        productPublicId: prod,
        imageUrl: url,
      });
      if (!p) {
        await deleteStoredImage({ url, owner });
        return notFound(reply, `No such product: ${prod}`);
      }
      await deleteStoredImage({ url: before.imageUrl, owner });
      return serializeProduct(p, p.groupPublicId);
    },
  );

  /** Remove the product's picture. Answers the product, with `image_url` null. */
  app.delete(
    "/v1/businesses/:biz/products/:prod/image",
    {
      preHandler: [authenticate, requirePerm("catalog:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { prod } = req.params as { prod: string };
      const orgId = req.organization!.id;
      const before = await getProductByPublicId(orgId, business.id, prod);
      if (!before) return notFound(reply, `No such product: ${prod}`);
      const p = await updateProduct({
        organizationId: orgId,
        businessId: business.id,
        productPublicId: prod,
        imageUrl: null,
      });
      if (!p) return notFound(reply, `No such product: ${prod}`);
      await deleteStoredImage({
        url: before.imageUrl,
        owner: { kind: "business", publicId: business.publicId },
      });
      return serializeProduct(p, p.groupPublicId);
    },
  );

  // ─── Product Groups ───────────────────────────────────────────────────────
  app.post(
    "/v1/businesses/:biz/product_groups",
    {
      preHandler: [authenticate, requirePerm("catalog:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(createGroupBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const g = await createProductGroup({
          organizationId: req.organization!.id,
          businessId: business.id,
          name: parsed.data.name,
          id: parsed.data.id,
          description: parsed.data.description,
        });
        return reply.code(201).send(serializeProductGroup(g));
      } catch (e) {
        if (e instanceof SlugConflictError) return conflict(reply, e.message);
        if (e instanceof CatalogError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/product_groups",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const includeArchived =
        (req.query as { include_archived?: string }).include_archived === "true";
      if (wantsListQuery(req)) {
        const page = catalogPageQuery(req, reply, {
          specs: PRODUCT_GROUP_PAGE_SPECS,
          sortFields: PRODUCT_GROUP_SORT_FIELDS,
          bareParams: ["include_archived"],
        });
        if (!page) return;
        const result = await pageProductGroups(
          req.organization!.id,
          business.id,
          { includeArchived },
          page,
        );
        return catalogListEnvelope(page, result, serializeProductGroup);
      }
      const rows = await listProductGroups(req.organization!.id, business.id, { includeArchived });
      return { object: "list", data: rows.map(serializeProductGroup) };
    },
  );

  app.get(
    "/v1/businesses/:biz/product_groups/:grp",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { grp } = req.params as { grp: string };
      const g = await getProductGroupByPublicId(req.organization!.id, business.id, grp);
      if (!g) return notFound(reply, `No such product group: ${grp}`);
      return serializeProductGroup(g);
    },
  );

  // Edit a group (name/code/description/active). Only provided fields change.
  app.patch(
    "/v1/businesses/:biz/product_groups/:grp",
    {
      preHandler: [authenticate, requirePerm("catalog:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      // CAT-0 DoD: the slug id is immutable — attempting to change it is a 400, not a silent no-op.
      if ((req.body as Record<string, unknown> | null)?.id !== undefined)
        return badRequest(reply, "id is immutable and cannot be changed");
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(updateGroupBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { grp } = req.params as { grp: string };
      const orgId = req.organization!.id;
      try {
        if (parsed.data.active !== undefined && Object.keys(parsed.data).length === 1) {
          const g = await setProductGroupActive(orgId, business.id, grp, parsed.data.active);
          if (!g) return notFound(reply, `No such product group: ${grp}`);
          return serializeProductGroup(g);
        }
        const g = await updateProductGroup({
          organizationId: orgId,
          businessId: business.id,
          groupPublicId: grp,
          name: parsed.data.name,
          description: parsed.data.description,
        });
        if (!g) return notFound(reply, `No such product group: ${grp}`);
        if (parsed.data.active !== undefined) {
          const g2 = await setProductGroupActive(orgId, business.id, grp, parsed.data.active);
          return serializeProductGroup(g2 ?? g);
        }
        return serializeProductGroup(g);
      } catch (e) {
        if (e instanceof SlugConflictError) return conflict(reply, e.message);
        if (e instanceof CatalogError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Archive a group (soft — blocked while it has active products; Default can't be archived).
  app.delete(
    "/v1/businesses/:biz/product_groups/:grp",
    {
      preHandler: [authenticate, requirePerm("catalog:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { grp } = req.params as { grp: string };
      try {
        const g = await setProductGroupActive(req.organization!.id, business.id, grp, false);
        if (!g) return notFound(reply, `No such product group: ${grp}`);
        return serializeProductGroup(g);
      } catch (e) {
        if (e instanceof SlugConflictError) return conflict(reply, e.message);
        if (e instanceof CatalogError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Set/list which plans an add-on or charge is attached to.
  app.put(
    "/v1/businesses/:biz/products/:prod/applicable_plans",
    {
      preHandler: [authenticate, requirePerm("catalog:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(applicablePlansBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { prod } = req.params as { prod: string };
      try {
        const result = await setItemApplicablePlans({
          organizationId: req.organization!.id,
          businessId: business.id,
          itemPublicId: prod,
          planPublicIds: parsed.data.plans,
          appliesToAll: parsed.data.applies_to_all,
          applicability: parsed.data.applicability,
          config: parsed.data.config
            ? Object.fromEntries(
                Object.entries(parsed.data.config).map(([pid, c]) => [
                  pid,
                  {
                    chargeOnEvent: c.charge_on_event,
                    chargeOnce: c.charge_once,
                    defaultQuantity: c.default_quantity,
                    billingCycles: c.billing_cycles,
                    minQuantity: c.min_quantity,
                    maxQuantity: c.max_quantity,
                    quantityStep: c.quantity_step,
                    customerCanChangeQuantity: c.customer_can_change_quantity,
                  },
                ]),
              )
            : undefined,
        });
        // Same shape as the GET, `applies_to_all` included — the round trip is the point.
        return {
          object: "applicable_plans",
          item: prod,
          applies_to_all: result.appliesToAll,
          plans: result.plans,
        };
      } catch (e) {
        if (e instanceof SlugConflictError) return conflict(reply, e.message);
        if (e instanceof CatalogError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/products/:prod/applicable_plans",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { prod } = req.params as { prod: string };
      const result = await listItemApplicablePlans(req.organization!.id, business.id, prod);
      if (!result) return notFound(reply, `No such product: ${prod}`);
      return {
        object: "applicable_plans",
        item: prod,
        applies_to_all: result.appliesToAll,
        plans: result.plans,
        applicability: result.applicability,
        config: result.config,
      };
    },
  );

  /** Every add-on's and charge's applicable plans at once — what the subscription screens need. */
  app.get(
    "/v1/businesses/:biz/applicable_plans",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const rows = await listApplicablePlansForBusiness(req.organization!.id, business.id);
      return {
        object: "list",
        data: rows.map((r) => ({
          object: "applicable_plans",
          item: r.addon,
          applies_to_all: r.appliesToAll,
          plans: r.plans,
          applicability: r.applicability,
          config: r.config,
        })),
      };
    },
  );

  /** One add-on or charge ↔ plan applicability (explicit, differential-implied, or applies-to-all). */
  app.get(
    "/v1/businesses/:biz/products/:prod/applicable_plans/:plan",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { prod, plan } = req.params as { prod: string; plan: string };
      const orgId = req.organization!.id;
      const planRow = await getProductByPublicId(orgId, business.id, plan);
      if (!planRow || planRow.kind !== "plan") return notFound(reply, `No such plan: ${plan}`);
      const hit = (await listApplicableAddonsForPlan(orgId, business.id, planRow.id)).find(
        (a) => a.addon === prod,
      );
      if (!hit) return notFound(reply, `${prod} is not applicable to plan ${plan}`);
      return serializeApplicability(hit, plan);
    },
  );

  /**
   * Remove ONE explicit attachment, leaving the rest of the set as it is. An
   * applicability implied by a differential price is removed by deleting that price.
   */
  app.delete(
    "/v1/businesses/:biz/products/:prod/applicable_plans/:plan",
    {
      preHandler: [authenticate, requirePerm("catalog:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { prod, plan } = req.params as { prod: string; plan: string };
      const r = await deleteAttachedItem({
        organizationId: req.organization!.id,
        businessId: business.id,
        itemPublicId: prod,
        planPublicId: plan,
      });
      if (r === null) return notFound(reply, `No such product: ${prod}`);
      if (!r) return notFound(reply, `${prod} has no explicit attachment to plan ${plan}`);
      return { object: "attached_item", item: prod, plan, deleted: true };
    },
  );

  app.get(
    "/v1/businesses/:biz/differential_prices/:id",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const d = await getDifferentialPrice(req.organization!.id, business.id, id);
      if (!d) return notFound(reply, `No such differential price: ${id}`);
      return serializeDifferentialPrice(d);
    },
  );

  // Remove one differential price; the add-on then rates at its own price on that plan.
  app.delete(
    "/v1/businesses/:biz/differential_prices/:id",
    {
      preHandler: [authenticate, requirePerm("catalog:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const d = await deleteDifferentialPrice(req.organization!.id, business.id, id);
      if (!d) return notFound(reply, `No such differential price: ${id}`);
      return { ...serializeDifferentialPrice(d), deleted: true };
    },
  );

  /** Every differential price in the business, each naming its add-on. */
  app.get(
    "/v1/businesses/:biz/differential_prices",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const rows = await listDifferentialPricesForBusiness(req.organization!.id, business.id);
      return { object: "list", data: rows };
    },
  );

  // ─── Differential pricing (CP-6) ──────────────────────────────────────────
  app.get(
    "/v1/businesses/:biz/products/:prod/differential_prices",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { prod } = req.params as { prod: string };
      const rows = await listDifferentialPrices(req.organization!.id, business.id, prod);
      return { object: "list", addon: prod, data: rows };
    },
  );

  app.put(
    "/v1/businesses/:biz/products/:prod/differential_prices",
    {
      preHandler: [authenticate, requirePerm("catalog:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(differentialPriceBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { prod } = req.params as { prod: string };
      try {
        const row = await setDifferentialPrice({
          organizationId: req.organization!.id,
          businessId: business.id,
          addonPublicId: prod,
          planPublicId: parsed.data.plan,
          currency: parsed.data.currency,
          interval: parsed.data.interval,
          amountMinor: parsed.data.amount_minor,
          tiers: parsed.data.tiers
            ? parsed.data.tiers.map((t) => ({
                upToMinor: t.up_to_minor,
                unitAmountMinor: t.unit_amount_minor,
                flatAmountMinor: t.flat_amount_minor,
              }))
            : undefined,
        });
        return {
          object: "differential_price",
          id: row.publicId,
          addon: prod,
          plan: parsed.data.plan,
          currency: row.currency,
          interval: row.interval,
          amount_minor: row.amountMinor != null ? Number(row.amountMinor) : null,
          tiers: row.tiers,
        };
      } catch (e) {
        if (e instanceof SlugConflictError) return conflict(reply, e.message);
        if (e instanceof TierListError) return tierListBadRequest(reply, e, true);
        if (e instanceof CatalogError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.post(
    "/v1/businesses/:biz/prices",
    {
      preHandler: [authenticate, requirePerm("catalog:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(createPriceBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const product = await getProductByPublicId(
        req.organization!.id,
        business.id,
        parsed.data.product,
      );
      if (!product) {
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `No such product: ${parsed.data.product}`,
          },
        });
      }
      try {
        const pr = await createPrice({
          organizationId: req.organization!.id,
          businessId: business.id,
          productId: product.id,
          id: parsed.data.id,
          name: parsed.data.name,
          type: parsed.data.type,
          model: parsed.data.model,
          currency: parsed.data.currency,
          amountMinor: parsed.data.amount_minor,
          interval: parsed.data.interval,
          intervalCount: parsed.data.interval_count,
          usageAggregation: parsed.data.usage_aggregation,
          usageRecurring: parsed.data.usage_recurring,
          usageTimeUnit: parsed.data.usage_time_unit,
          ...(parsed.data.meter != null
            ? {
                meter: parsed.data.meter,
                meterTiers: parsed.data.tiers as MeterTier[] | undefined,
                unitAmountDecimal: parsed.data.unit_amount_decimal,
                quantityDivisor: parsed.data.quantity_divisor,
                amountSource: parsed.data.amount_source,
                markupPercent: parsed.data.markup_percent,
                markupBase: parsed.data.markup_base,
                rates: parsed.data.rates?.map((r) => ({
                  match: r.match,
                  unitAmountDecimal: r.unit_amount_decimal ?? null,
                  tiers: r.tiers ?? null,
                  markupPercent: r.markup_percent ?? null,
                })),
              }
            : { tiers: parsed.data.tiers as PriceTier[] | undefined }),
          packageSize: parsed.data.package_size,
          freeUnits: parsed.data.free_units,
          percentageBps: parsed.data.percentage_bps,
          minimumAmountMinor: parsed.data.minimum_amount_minor,
          billUsageMonthly: parsed.data.bill_usage_monthly,
          commitmentAmountMinor: parsed.data.commitment_amount_minor,
          grantsCredit: parsed.data.grants_credit,
          externalName: parsed.data.external_name,
          description: parsed.data.description,
          trialPeriod: parsed.data.trial_period,
          trialPeriodUnit: parsed.data.trial_period_unit,
          trialEndAction: parsed.data.trial_end_action,
          billingCycles: parsed.data.billing_cycles,
          freeQuantity: parsed.data.free_quantity,
          portalMinQuantity: parsed.data.portal_min_quantity,
          portalMaxQuantity: parsed.data.portal_max_quantity,
          invoiceNotes: parsed.data.invoice_notes,
          showDescriptionInInvoices: parsed.data.show_description_in_invoices,
          showDescriptionInQuotes: parsed.data.show_description_in_quotes,
          taxCode: parsed.data.tax_code,
          sku: parsed.data.sku,
          accountingCode: parsed.data.accounting_code,
          accountingCategoryCode: parsed.data.accounting_category_code,
          isTaxable: parsed.data.is_taxable,
          taxBehavior: parsed.data.tax_behavior,
          metadata: parsed.data.metadata,
        });
        const views = await meterViewsFor(req.organization!.id, [pr]);
        return reply.code(201).send(serializePrice(pr, product.publicId, views.get(pr.id)));
      } catch (e) {
        // A caller-named slug can collide (409) now that `id` is accepted on this route.
        if (e instanceof SlugConflictError) return conflict(reply, e.message);
        if (e instanceof MeterPriceError) return meterPriceBadRequest(reply, e);
        if (e instanceof TierListError) return tierListBadRequest(reply, e);
        if (e instanceof CatalogError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/prices",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      // CAT-8 filters: currency, interval, model, product, status.
      const q = req.query as {
        include_archived?: string;
        currency?: string;
        interval?: string;
        model?: string;
        product?: string;
        status?: string;
      };
      const status = q.status === "active" || q.status === "archived" ? q.status : undefined;
      if (wantsListQuery(req)) {
        const page = catalogPageQuery(req, reply, {
          specs: PRICE_PAGE_SPECS,
          sortFields: PRICE_SORT_FIELDS,
          bareParams: ["include_archived", "currency", "interval", "model", "product", "status"],
        });
        if (!page) return;
        const result = await pagePrices(
          req.organization!.id,
          business.id,
          {
            includeArchived: q.include_archived === "true",
            currency: q.currency,
            interval: q.interval,
            model: q.model,
            productPublicId: q.product,
            status,
          },
          page,
        );
        const views = await meterViewsFor(
          req.organization!.id,
          result.data.map((r) => r.price),
        );
        return catalogListEnvelope(page, result, (r) =>
          serializePrice(r.price, r.productPublicId, views.get(r.price.id)),
        );
      }
      const rows = await listPrices(req.organization!.id, business.id, {
        includeArchived: q.include_archived === "true",
        currency: q.currency,
        interval: q.interval,
        model: q.model,
        productPublicId: q.product,
        status,
      });
      const views = await meterViewsFor(
        req.organization!.id,
        rows.map((r) => r.price),
      );
      return {
        object: "list",
        data: rows.map((r) => serializePrice(r.price, r.productPublicId, views.get(r.price.id))),
      };
    },
  );

  // CAT-8: fetch a single price by slug id.
  app.get(
    "/v1/businesses/:biz/prices/:price",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const orgId = req.organization!.id;
      const { price } = req.params as { price: string };
      const row = await getPriceByPublicId(orgId, business.id, price);
      if (!row) return notFound(reply, `No such price: ${price}`);
      const all = await listProducts(orgId, business.id, { includeArchived: true });
      const productPid = all.find((p) => p.id === row.productId)?.publicId ?? "";
      return serializePrice(row, productPid, (await meterViewsFor(orgId, [row])).get(row.id));
    },
  );

  /** The plan-side lookup: add-ons and charges applicable to this plan price's plan. */
  app.get(
    "/v1/businesses/:biz/prices/:price/applicable_addons",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const orgId = req.organization!.id;
      const { price } = req.params as { price: string };
      const row = await getPriceByPublicId(orgId, business.id, price);
      if (!row) return notFound(reply, `No such price: ${price}`);
      const all = await listProducts(orgId, business.id, { includeArchived: true });
      const plan = all.find((p) => p.id === row.productId);
      if (!plan || plan.kind !== "plan")
        return badRequest(reply, `Price ${price} is not a plan price`);
      const addons = await listApplicableAddonsForPlan(orgId, business.id, plan.id);
      return {
        object: "list",
        price,
        plan: plan.publicId,
        data: addons.map((a) => serializeApplicability(a, plan.publicId)),
      };
    },
  );

  // Edit a price (name/amount/tiers/active). Edits apply to NEW subscriptions only —
  // live subs keep their price_snapshot, so this never re-rates them.
  app.patch(
    "/v1/businesses/:biz/prices/:price",
    {
      preHandler: [authenticate, requirePerm("catalog:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      // CAT-0 DoD: the slug id is immutable — attempting to change it is a 400, not a silent no-op.
      if ((req.body as Record<string, unknown> | null)?.id !== undefined)
        return badRequest(reply, "id is immutable and cannot be changed");
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(updatePriceBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { price } = req.params as { price: string };
      const orgId = req.organization!.id;
      try {
        const pr = await updatePrice({
          organizationId: orgId,
          businessId: business.id,
          pricePublicId: price,
          expectedVersion: parsed.data.expected_version,
          name: parsed.data.name,
          externalName: parsed.data.external_name,
          description: parsed.data.description,
          amountMinor: parsed.data.amount_minor,
          ...(parsed.data.tiers?.some((t) => "up_to" in t)
            ? { meterTiers: parsed.data.tiers as MeterTier[] }
            : { tiers: parsed.data.tiers as PriceTier[] | null | undefined }),
          unitAmountDecimal: parsed.data.unit_amount_decimal,
          markupPercent: parsed.data.markup_percent,
          markupBase: parsed.data.markup_base,
          rates: parsed.data.rates?.map((r) => ({
            match: r.match,
            unitAmountDecimal: r.unit_amount_decimal ?? null,
            tiers: r.tiers ?? null,
            markupPercent: r.markup_percent ?? null,
          })),
          packageSize: parsed.data.package_size,
          freeUnits: parsed.data.free_units,
          percentageBps: parsed.data.percentage_bps,
          minimumAmountMinor: parsed.data.minimum_amount_minor,
          billUsageMonthly: parsed.data.bill_usage_monthly,
          commitmentAmountMinor: parsed.data.commitment_amount_minor,
          grantsCredit: parsed.data.grants_credit,
          trialPeriod: parsed.data.trial_period,
          trialPeriodUnit: parsed.data.trial_period_unit,
          trialEndAction: parsed.data.trial_end_action,
          billingCycles: parsed.data.billing_cycles,
          freeQuantity: parsed.data.free_quantity,
          portalMinQuantity: parsed.data.portal_min_quantity,
          portalMaxQuantity: parsed.data.portal_max_quantity,
          invoiceNotes: parsed.data.invoice_notes,
          showDescriptionInInvoices: parsed.data.show_description_in_invoices,
          showDescriptionInQuotes: parsed.data.show_description_in_quotes,
          taxCode: parsed.data.tax_code,
          sku: parsed.data.sku,
          accountingCode: parsed.data.accounting_code,
          accountingCategoryCode: parsed.data.accounting_category_code,
          isTaxable: parsed.data.is_taxable,
          taxBehavior: parsed.data.tax_behavior,
          metadata: parsed.data.metadata,
        });
        if (!pr) return notFound(reply, `No such price: ${price}`);
        const final =
          parsed.data.active !== undefined
            ? ((await setPriceActive(orgId, business.id, price, parsed.data.active)) ?? pr)
            : pr;
        const views = await meterViewsFor(orgId, [final]);
        return serializePrice(
          final,
          await productPidForPrice(orgId, business.id, final.id),
          views.get(final.id),
        );
      } catch (e) {
        if (e instanceof VersionConflictError) return conflict(reply, e.message);
        if (e instanceof MeterPriceError) return meterPriceBadRequest(reply, e);
        if (e instanceof TierListError) return tierListBadRequest(reply, e);
        if (e instanceof CatalogError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Archive a price (soft — active=false).
  app.delete(
    "/v1/businesses/:biz/prices/:price",
    {
      preHandler: [authenticate, requirePerm("catalog:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { price } = req.params as { price: string };
      const orgId = req.organization!.id;
      const pr = await setPriceActive(orgId, business.id, price, false);
      if (!pr) return notFound(reply, `No such price: ${price}`);
      return serializePrice(
        pr,
        await productPidForPrice(orgId, business.id, pr.id),
        (await meterViewsFor(orgId, [pr])).get(pr.id),
      );
    },
  );
}

/** Meter key and rate card for the meter prices among `rows` (none → no query). */
async function meterViewsFor(
  orgId: string,
  rows: ReadonlyArray<typeof prices.$inferSelect>,
): Promise<Map<string, MeterPriceView>> {
  if (!rows.some((r) => r.meterId)) return new Map();
  return withTenant(orgId, (tx) => meterPriceViews(tx, rows));
}

function meterPriceBadRequest(reply: FastifyReply, e: MeterPriceError) {
  return reply.code(400).send({
    error: {
      type: "invalid_request_error",
      message: e.message,
      ...(e.param ? { param: e.param } : {}),
    },
  });
}

/** Resolve a price's product public id (for serializing mutation responses). */
async function productPidForPrice(
  orgId: string,
  bizId: string,
  priceInternalId: string,
): Promise<string> {
  const rows = await listPrices(orgId, bizId, { includeArchived: true });
  return rows.find((r) => r.price.id === priceInternalId)?.productPublicId ?? "";
}

/** Resolve a product group's public id from its internal id (for serializing products). */
async function groupPid(orgId: string, bizId: string, groupInternalId: string): Promise<string> {
  const groups = await listProductGroups(orgId, bizId, { includeArchived: true });
  return groups.find((g) => g.id === groupInternalId)?.publicId ?? "";
}
