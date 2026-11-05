"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, parseForm, type ActionResult } from "@/lib/action-result";
import {
  archiveCreditUnit,
  createCreditUnit,
  updateCreditUnit,
  type CreditUnitWrite,
} from "@/lib/api/credits";
import { majorRateToMinorDecimal } from "@/lib/credits";

const unitsPath = (biz: string) => `/businesses/${biz}/settings/credit-units`;

const unitSchema = z
  .object({
    biz: z.string().min(1),
    unit: z.string().optional(),
    locked: z.string().optional(),
    expected_version: z.coerce.number().int().optional(),
    name: z.string().trim().min(1, "Enter a name.").max(100, "Enter 100 characters or fewer."),
    plural_name: z
      .string()
      .trim()
      .min(1, "Enter the plural name.")
      .max(100, "Enter 100 characters or fewer."),
    key: z
      .string()
      .trim()
      .max(100)
      .refine((v) => v === "" || /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(v), {
        message: "Use only letters, digits, dots, dashes or underscores. Do not use spaces.",
      })
      .optional(),
    currency: z.string().trim().length(3, "Select a currency.").optional(),
    rate: z.string().trim().optional(),
    decimals: z.coerce.number().int().min(0).max(4).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.locked === "1") return;
    if (!v.currency)
      ctx.addIssue({ code: "custom", path: ["currency"], message: "Select a currency." });
    if (!v.rate || !majorRateToMinorDecimal(v.rate, v.currency ?? "USD"))
      ctx.addIssue({
        code: "custom",
        path: ["rate"],
        message:
          "Enter the money value of one unit, more than 0. Use up to 12 decimal places in minor units.",
      });
  });

function unitBody(d: z.infer<typeof unitSchema>): CreditUnitWrite {
  const body: CreditUnitWrite = { name: d.name, plural_name: d.plural_name };
  if (d.locked !== "1") {
    body.currency = d.currency!.toUpperCase();
    body.minor_per_unit = majorRateToMinorDecimal(d.rate!, body.currency)!;
    body.decimals = d.decimals ?? 0;
  }
  return body;
}

export async function createCreditUnitAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("credits:manage", "ops");
  const parsed = parseForm(unitSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const res = await createCreditUnit(d.biz, { ...(d.key ? { id: d.key } : {}), ...unitBody(d) });
  revalidatePath(unitsPath(d.biz));
  if (!res.ok) {
    if (res.status === 409)
      return actionError(res.error ?? "That unit ID is already in use.", {
        errors: { key: res.error ?? "That unit ID is already in use." },
      });
    return actionError(res.error ?? "We could not create the credit unit.", {
      requestId: res.requestId,
      ...(res.param ? { errors: { [res.param]: res.error ?? "" } } : {}),
    });
  }
  return actionOk(`Credit unit ${d.name} created.`, unitsPath(d.biz));
}

export async function updateCreditUnitAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("credits:manage", "ops");
  const parsed = parseForm(unitSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  if (!d.unit) return actionError("The unit ID is missing. Reload the page.");
  const body = unitBody(d);
  if (d.expected_version) body.expected_version = d.expected_version;
  const res = await updateCreditUnit(d.biz, d.unit, body);
  revalidatePath(unitsPath(d.biz));
  if (!res.ok)
    return actionError(res.error ?? "We could not change the credit unit.", {
      requestId: res.requestId,
      ...(res.status === 409 && !res.error ? { code: "conflict" as const } : {}),
    });
  return actionOk("Credit unit saved.", unitsPath(d.biz));
}

export async function archiveCreditUnitAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("credits:manage", "ops");
  const biz = String(fd.get("biz") ?? "");
  const unit = String(fd.get("unit") ?? "");
  if (!biz || !unit) return actionError("The unit ID is missing. Reload the page.");
  const res = await archiveCreditUnit(biz, unit);
  revalidatePath(unitsPath(biz));
  if (!res.ok)
    return actionError(res.error ?? "We could not archive the credit unit.", {
      requestId: res.requestId,
    });
  return actionOk("Credit unit archived.");
}
