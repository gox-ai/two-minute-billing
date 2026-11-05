"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { apiWrite } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import {
  actionOk,
  actionError,
  parseForm,
  numberFromForm,
  couponCodeField,
} from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-result";
import { optUtcDateTime } from "@/lib/zod-utc";
import { metadataFromForm } from "@/lib/metadata-form";

const catalogPath = (biz: string) => `/businesses/${biz}/catalog/coupons`;

const itemConstraintSchema = z.object({
  item_kind: z.enum(["plan", "addon", "charge"]),
  constraint_type: z.enum(["all", "specific", "none"]),
  product_ids: z.array(z.string().min(1).max(100)).optional(),
});

/** Parses + validates the item-constraints JSON string built by the "each specified
 *  item" picker — a malformed payload is a field error, not a 500. */
const itemConstraintsFromForm = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (!raw) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "We could not read the item constraints. Select them again.",
      });
      return z.NEVER;
    }
    const result = z.array(itemConstraintSchema).safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({ code: "custom", message: "The item constraints are not valid." });
      return z.NEVER;
    }
    return result.data;
  });

const createCouponSchema = z
  .object({
    biz: z.string().min(1),
    code: couponCodeField("Coupon ID"),
    kind: z.enum(["percentage", "fixed_amount"]),
    duration_type: z.enum(["once", "forever", "repeating"]).default("once"),
    name: z.string().trim().max(200, "Enter 200 characters or fewer").optional(),
    invoice_name: z.string().trim().max(200, "Enter 200 characters or fewer").optional(),
    percent_off_bps: numberFromForm({
      min: 1,
      max: 10000,
      message: "Enter basis points from 1 to 10000 (10000 = 100%)",
    }),
    amount_off_minor: numberFromForm({
      min: 1,
      message: "Enter a positive whole number of minor units",
    }),
    currency: z.string().trim().length(3, "Select a currency").optional(),
    duration_in_periods: numberFromForm({ min: 1, message: "Periods must be at least 1" }),
    max_redemptions: numberFromForm({ min: 1, message: "Must be at least 1" }),
    max_redemptions_per_customer: numberFromForm({ min: 1, message: "Must be at least 1" }),
    redeem_by: optUtcDateTime,
    valid_from: optUtcDateTime,
    apply_on: z.enum(["invoice_amount", "each_specified_item", "none"]).optional(),
    item_constraints: itemConstraintsFromForm,
    metadata: metadataFromForm,
  })
  .refine((v) => v.kind !== "percentage" || v.percent_off_bps != null, {
    message: "Percentage is required for a percentage coupon",
    path: ["percent_off_bps"],
  })
  .refine((v) => v.kind !== "fixed_amount" || v.amount_off_minor != null, {
    message: "Amount is required for a fixed-amount coupon",
    path: ["amount_off_minor"],
  })
  .refine((v) => v.duration_type !== "repeating" || v.duration_in_periods != null, {
    message: "Periods is required for a limited-period coupon",
    path: ["duration_in_periods"],
  });

/** Create a coupon — extended version that handles apply_on + item_constraints. */
export async function createCouponExtAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("coupons:manage", "manager");
  const parsed = parseForm(createCouponSchema, formData);
  if (parsed.error) return parsed.error;
  const d = parsed.data;

  const body: Record<string, unknown> = {
    code: d.code,
    kind: d.kind,
    duration_type: d.duration_type,
  };
  if (d.name) body.name = d.name;

  if (d.kind === "percentage") {
    body.percent_off_bps = d.percent_off_bps;
  } else {
    body.amount_off_minor = d.amount_off_minor;
    if (d.currency) body.currency = d.currency.toUpperCase();
  }

  if (d.duration_type === "repeating") body.duration_in_periods = d.duration_in_periods;
  if (d.max_redemptions != null) body.max_redemptions = d.max_redemptions;
  if (d.max_redemptions_per_customer != null)
    body.max_redemptions_per_customer = d.max_redemptions_per_customer;
  if (d.metadata) body.metadata = d.metadata;
  if (d.redeem_by) body.redeem_by = d.redeem_by;
  if (d.valid_from) body.valid_from = d.valid_from;
  if (d.invoice_name) body.invoice_name = d.invoice_name;
  if (d.apply_on && d.apply_on !== "none") body.apply_on = d.apply_on;
  if (d.item_constraints && d.item_constraints.length > 0)
    body.item_constraints = d.item_constraints;

  const res = await apiWrite(`/v1/businesses/${d.biz}/coupons`, body, "POST");
  revalidatePath(catalogPath(d.biz));
  if (!res.ok) {
    if (res.status === 409)
      return actionError(res.error ?? "A coupon with this code already exists.", {
        code: "conflict",
      });
    return actionError(res.error ?? "We could not create the coupon.");
  }
  const cpn = (res.data as { id?: string } | undefined)?.id;
  return actionOk(`Coupon ${d.code} created`, cpn && `${catalogPath(d.biz)}/${cpn}`);
}

const editCouponSchema = z
  .object({
    biz: z.string().min(1),
    cpn: z.string().min(1),
    name: z
      .string()
      .max(200, "Enter 200 characters or fewer")
      .optional()
      .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined)),
    invoice_name: z
      .string()
      .max(200, "Enter 200 characters or fewer")
      .optional()
      .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined)),
    redeem_by: optUtcDateTime,
    valid_from: optUtcDateTime,
    max_redemptions: numberFromForm({ min: 1, message: "Must be at least 1" }),
    max_redemptions_per_customer: numberFromForm({ min: 1, message: "Must be at least 1" }),
    metadata: metadataFromForm,
    active: z.enum(["true", "false"]).optional(),
    item_constraints: itemConstraintsFromForm,
    // The discount rules. Present only when the form rendered them, which it does only for
    // an UNREDEEMED coupon; the engine re-checks `times_redeemed` and 400s either way, so
    // this is the convenience half of the rule, never the enforcement.
    kind: z.enum(["percentage", "fixed_amount"]).optional(),
    percent_off_bps: numberFromForm({
      min: 1,
      max: 10000,
      message: "Enter basis points from 1 to 10000 (10000 = 100%)",
    }),
    amount_off_minor: numberFromForm({
      min: 1,
      message: "Enter a positive whole number of minor units",
    }),
    currency: z.string().trim().length(3, "Select a currency").optional(),
    duration_type: z.enum(["once", "forever", "repeating"]).optional(),
    duration_in_periods: numberFromForm({ min: 1, message: "Periods must be at least 1" }),
    apply_on: z.enum(["invoice_amount", "each_specified_item", "none"]).optional(),
  })
  .refine((v) => v.kind !== "percentage" || v.percent_off_bps != null, {
    message: "Percentage is required for a percentage coupon",
    path: ["percent_off_bps"],
  })
  .refine((v) => v.kind !== "fixed_amount" || v.amount_off_minor != null, {
    message: "Amount is required for a fixed-amount coupon",
    path: ["amount_off_minor"],
  })
  .refine((v) => v.duration_type !== "repeating" || v.duration_in_periods != null, {
    message: "Periods is required for a limited-period coupon",
    path: ["duration_in_periods"],
  });

/** Edit a coupon's mutable fields (name, invoice_name, validity, redemptions, active) plus its
 *  CAT-2 scope — the discount math stays immutable. */
export async function editCouponExtAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("coupons:manage", "manager");
  const parsed = parseForm(editCouponSchema, formData);
  if (parsed.error) return parsed.error;
  const d = parsed.data;

  const body: Record<string, unknown> = {};

  // Nullable string fields: present but empty → null (clears the field). DateTimeField
  // and every text input here always posts (even when blank), so `formData.has(...)`
  // distinguishes "this form doesn't touch the field" from "clear it".
  if (formData.has("name")) body.name = d.name ?? null;
  if (formData.has("invoice_name")) body.invoice_name = d.invoice_name ?? null;
  if (formData.has("redeem_by")) body.redeem_by = d.redeem_by ?? null;
  if (formData.has("valid_from")) body.valid_from = d.valid_from ?? null;
  if (formData.has("max_redemptions")) body.max_redemptions = d.max_redemptions ?? null;
  if (formData.has("max_redemptions_per_customer"))
    body.max_redemptions_per_customer = d.max_redemptions_per_customer ?? null;
  if (formData.get("metadata_present") === "1") body.metadata = d.metadata;
  if (d.active !== undefined) body.active = d.active === "true";
  // Only posted by an each_specified_item coupon's form, and `[]` is a real answer there
  // (every kind set to None) — so presence, not truthiness, decides whether to send it.
  if (formData.has("item_constraints")) body.item_constraints = d.item_constraints ?? [];

  // Same convention for the discount rules: the fields exist in the DOM only when the
  // form judged the coupon unredeemed, so `has()` distinguishes "this form does not touch
  // the discount" from a real value. Sent as a group so the engine validates the coupon
  // the patch would produce, not one field at a time.
  if (formData.has("kind")) {
    body.kind = d.kind;
    if (d.kind === "percentage") {
      body.percent_off_bps = d.percent_off_bps;
      body.amount_off_minor = null;
      body.currency = null;
    } else {
      body.amount_off_minor = d.amount_off_minor;
      body.percent_off_bps = null;
      if (d.currency) body.currency = d.currency.toUpperCase();
    }
  }
  if (formData.has("duration_type")) {
    body.duration_type = d.duration_type;
    body.duration_in_periods = d.duration_type === "repeating" ? d.duration_in_periods : null;
  }
  // 'none' is the picker's label for "leave it at invoice amount", not a stored value.
  if (formData.has("apply_on") && d.apply_on) {
    body.apply_on = d.apply_on === "none" ? "invoice_amount" : d.apply_on;
  }

  const res = await apiWrite(`/v1/businesses/${d.biz}/coupons/${d.cpn}`, body, "PATCH");
  revalidatePath(catalogPath(d.biz));
  if (!res.ok) return actionError(res.error ?? "We could not save the coupon.");
  return actionOk(`Coupon ${d.cpn} saved`);
}

const couponMetadataSchema = z.object({
  biz: z.string().min(1),
  cpn: z.string().min(1),
  metadata: metadataFromForm,
});

/**
 * Replace a coupon's JSON metadata — the "Add/Edit metadata" dialog on the detail page.
 * PATCH replaces the object rather than merging, and a blank textarea clears it.
 */
export async function updateCouponMetadataAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("coupons:manage", "manager");
  const parsed = parseForm(couponMetadataSchema, formData);
  if (parsed.error) {
    const first =
      Object.values(parsed.error.errors ?? {})[0] ??
      parsed.error.message ??
      "The metadata is not valid.";
    return actionError(first, { errors: parsed.error.errors });
  }
  const { biz, cpn, metadata } = parsed.data;
  const res = await apiWrite(`/v1/businesses/${biz}/coupons/${cpn}`, { metadata }, "PATCH");
  revalidatePath(`${catalogPath(biz)}/${cpn}`);
  return res.ok
    ? actionOk("Metadata saved.")
    : actionError(res.error ?? "We could not save the metadata.");
}
