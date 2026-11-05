"use server";

import { revalidatePath } from "next/cache";
import { apiWrite } from "@/lib/api";
import { renameCouponSet } from "@/lib/api/catalog-stats";
import { requirePermission } from "@/lib/session";
import { z } from "zod";
import { actionOk, actionError, parseForm, numberFromForm } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-result";

const setDetailPath = (biz: string, set: string) => `/businesses/${biz}/catalog/coupon_sets/${set}`;

const addCodesSchema = z
  .object({
    biz: z.string().min(1),
    set: z.string().min(1),
    codes: z.string().trim().max(200_000).optional(),
    count: numberFromForm({ min: 1, max: 10000, message: "Enter a whole number from 1 to 10,000" }),
    code_prefix: z.string().trim().max(20, "Enter a prefix of 20 characters or fewer").optional(),
  })
  .refine((v) => !!v.codes || v.count != null, {
    message: "Paste codes or enter a count",
    path: ["codes"],
  });

/** Add codes to a set: explicit codes (comma/whitespace separated) win over a count. */
export async function addCouponSetCodesAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("coupons:manage", "manager");
  const parsed = parseForm(addCodesSchema, formData);
  if (parsed.error) return parsed.error;
  const d = parsed.data;

  const body: Record<string, unknown> = {};
  if (d.code_prefix) body.code_prefix = d.code_prefix;
  const codes = (d.codes ?? "").split(/[\s,]+/).filter(Boolean);
  if (codes.length) body.codes = codes;
  else body.count = d.count;

  const res = await apiWrite(`/v1/businesses/${d.biz}/coupon_sets/${d.set}/codes`, body, "POST");
  revalidatePath(setDetailPath(d.biz, d.set));
  if (!res.ok) return actionError(res.error ?? "We could not add the codes.");
  const added = (res.data as { added?: number } | undefined)?.added;
  return actionOk(added != null ? `${added} code(s) added` : "Codes added");
}

/** Archive a single not-yet-redeemed code. */
export async function archiveCouponCodeAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("coupons:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const set = String(formData.get("set") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();
  if (!biz || !code) return actionError("The coupon code is missing. Reload the page.");

  const res = await apiWrite(
    `/v1/businesses/${biz}/coupon_codes/${encodeURIComponent(code)}/archive`,
    {},
    "POST",
  );
  if (set) revalidatePath(setDetailPath(biz, set));
  if (!res.ok) return actionError(res.error ?? "We could not archive the code.");
  return actionOk(`Code ${code} archived`);
}

/** Delete all unused (not_redeemed) codes in a set. */
export async function deleteUnusedCodesAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("coupons:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const set = String(formData.get("set") ?? "").trim();
  if (!biz || !set) return actionError("The coupon set ID is missing. Reload the page.");

  const res = await apiWrite(`/v1/businesses/${biz}/coupon_sets/${set}/unused_codes`, {}, "DELETE");
  revalidatePath(setDetailPath(biz, set));
  if (!res.ok) return actionError(res.error ?? "We could not delete the unused codes.");
  const deleted = (res.data as { deleted?: number } | undefined)?.deleted;
  return actionOk(deleted != null ? `${deleted} unused code(s) deleted` : "Unused codes deleted");
}

const renameSchema = z.object({
  biz: z.string().min(1),
  set: z.string().min(1),
  name: z.string().trim().min(1, "Set name is required").max(200, "Enter 200 characters or fewer"),
});

/** Rename a coupon set. */
export async function renameCouponSetAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("coupons:manage", "manager");
  const parsed = parseForm(renameSchema, formData);
  if (parsed.error) return parsed.error;
  const { biz, set, name } = parsed.data;

  const res = await renameCouponSet(biz, set, name);
  revalidatePath(setDetailPath(biz, set));
  revalidatePath(`/businesses/${biz}/catalog/coupon_sets`);
  if (!res.ok) return actionError(res.error ?? "We could not rename the coupon set.");
  return actionOk("Coupon set renamed");
}
