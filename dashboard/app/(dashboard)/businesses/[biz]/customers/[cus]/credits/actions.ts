"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, parseForm, type ActionResult } from "@/lib/action-result";
import { optUtcDateTime } from "@/lib/zod-utc";
import {
  createCreditGrant,
  releaseCreditHold,
  updateCustomerCreditSettings,
  voidCreditGrant,
  type CreditGrant,
  type CreditGrantWrite,
} from "@/lib/api/credits";
import { CREDIT_HOLDS_MANAGE, toSmallestStep, type CustomerCreditSettings } from "@/lib/credits";

const creditsPath = (biz: string, cus: string) => `/businesses/${biz}/customers/${cus}/credits`;
const customerPath = (biz: string, cus: string) => `/businesses/${biz}/customers/${cus}`;

const ids = {
  biz: z.string().min(1, "The business ID is missing. Reload the page."),
  cus: z.string().min(1, "The customer ID is missing. Reload the page."),
};

const grantSchema = z
  .object({
    ...ids,
    category: z.enum(["promotional", "paid"], { message: "Select the type of credit." }),
    unit: z.string().optional(),
    currency: z.string().trim().length(3, "Select a currency."),
    decimals: z.coerce.number().int().min(0).max(4),
    amount: z.string().trim().min(1, "Enter the amount of credit."),
    priority: z.coerce
      .number({ message: "Enter a priority from 0 to 100." })
      .int("Enter a whole number from 0 to 100.")
      .min(0, "Enter a priority from 0 to 100.")
      .max(100, "Enter a priority from 0 to 100."),
    expires_at: optUtcDateTime,
    on_exhausted: z.enum(["", "block", "bill"]).optional(),
    price_minor: z.string().optional(),
    tax_treatment: z.enum(["", "taxed_at_purchase", "taxed_at_use"]).optional(),
    mark_paid: z.string().optional(),
    paid_method: z.string().optional(),
    paid_reference: z.string().trim().max(200).optional(),
    paid_at: optUtcDateTime,
  })
  .superRefine((v, ctx) => {
    if (toSmallestStep(v.amount, v.decimals) == null)
      ctx.addIssue({
        code: "custom",
        path: ["amount"],
        message:
          v.decimals === 0
            ? "Enter a whole number more than 0."
            : `Enter a number more than 0, with up to ${v.decimals} decimal places.`,
      });
    if (v.category !== "paid") return;
    if (!v.price_minor || !/^\d+$/.test(v.price_minor))
      ctx.addIssue({
        code: "custom",
        path: ["price_minor"],
        message: "Enter the price, 0 or more.",
      });
    if (!v.tax_treatment)
      ctx.addIssue({ code: "custom", path: ["tax_treatment"], message: "Select a tax treatment." });
    if (v.tax_treatment === "taxed_at_use" && v.unit)
      ctx.addIssue({
        code: "custom",
        path: ["tax_treatment"],
        message: "Credit in a custom unit is taxed at purchase.",
      });
    if (v.mark_paid === "on" && !v.paid_method)
      ctx.addIssue({
        code: "custom",
        path: ["paid_method"],
        message: "Select the payment method.",
      });
  });

/**
 * Give credit by hand. Promotional books at once; paid raises an invoice (optionally
 * marked paid), so the result carries the invoice link.
 */
export async function giveCreditAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const category = fd.get("category");
  await requirePermission(
    category === "paid" ? ["credits:manage", "invoices:manage"] : "credits:manage",
    "ops",
  );
  const parsed = parseForm(grantSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const body: CreditGrantWrite = {
    category: d.category,
    unit: d.unit || null,
    amount: toSmallestStep(d.amount, d.decimals)!,
    priority: d.priority,
    ...(d.unit ? {} : { currency: d.currency.toUpperCase() }),
    ...(d.expires_at ? { expires_at: d.expires_at } : {}),
    ...(d.on_exhausted ? { on_exhausted: d.on_exhausted } : {}),
  };
  if (d.category === "paid") {
    body.price_minor = Number(d.price_minor);
    body.tax_treatment = d.tax_treatment as CreditGrantWrite["tax_treatment"];
    if (d.mark_paid === "on")
      body.mark_paid = {
        method: d.paid_method!,
        ...(d.paid_reference ? { reference: d.paid_reference } : {}),
        ...(d.paid_at ? { paid_at: d.paid_at } : {}),
      };
  }
  const res = await createCreditGrant(d.biz, d.cus, body);
  revalidatePath(creditsPath(d.biz, d.cus));
  revalidatePath(customerPath(d.biz, d.cus));
  if (!res.ok)
    return actionError(res.error ?? "We could not give the credit.", {
      requestId: res.requestId,
      ...(res.param ? { errors: { [res.param]: res.error ?? "" } } : {}),
    });
  const grant = res.data as CreditGrant | undefined;
  if (d.category === "paid" && grant?.invoice)
    return actionOk(
      grant.status === "active"
        ? "Credit given. The invoice is paid."
        : "Invoice created. The credit starts when the invoice is paid.",
      `/businesses/${d.biz}/invoices/${grant.invoice}`,
    );
  return actionOk("Credit given.");
}

export async function voidGrantAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("credits:manage", "ops");
  const biz = String(fd.get("biz") ?? "");
  const cus = String(fd.get("cus") ?? "");
  const grant = String(fd.get("grant") ?? "");
  if (!biz || !cus || !grant) return actionError("The grant ID is missing. Reload the page.");
  const res = await voidCreditGrant(biz, cus, grant);
  revalidatePath(creditsPath(biz, cus));
  if (!res.ok)
    return actionError(res.error ?? "We could not void the credit grant.", {
      requestId: res.requestId,
    });
  return actionOk("Credit grant voided.");
}

export async function releaseHoldAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission(CREDIT_HOLDS_MANAGE, "ops");
  const biz = String(fd.get("biz") ?? "");
  const hold = String(fd.get("hold") ?? "");
  if (!biz || !hold) return actionError("The hold ID is missing. Reload the page.");
  const res = await releaseCreditHold(biz, hold);
  if (!res.ok)
    return actionError(res.error ?? "We could not release the hold.", {
      requestId: res.requestId,
    });
  return actionOk("Hold released.");
}

const settingsSchema = z.object({
  ...ids,
  on_exhausted: z.enum(["", "block", "bill"]).optional(),
  override_expires_at: optUtcDateTime,
  overdraft: z.string().optional(),
});

/** The customer override: policy (with an optional end date) and overdraft limits. */
export async function saveCustomerCreditSettingsAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("credits:manage", "ops");
  const parsed = parseForm(settingsSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const overdraft: Record<string, number> = {};
  try {
    const raw = JSON.parse(d.overdraft || "{}") as Record<string, string>;
    for (const [cur, v] of Object.entries(raw)) {
      if (v === "" || v == null) continue;
      if (!/^\d+$/.test(String(v)))
        return actionError("Correct the highlighted fields.", {
          errors: { [`overdraft_${cur}`]: "Enter an amount, 0 or more." },
        });
      overdraft[cur] = Number(v);
    }
  } catch {
    return actionError("We could not read the overdraft limits. Reload the page.");
  }
  const settings: CustomerCreditSettings = {
    on_exhausted: d.on_exhausted ? d.on_exhausted : null,
    overdraft_limit_minor: overdraft,
    override_expires_at: d.on_exhausted && d.override_expires_at ? d.override_expires_at : null,
  };
  const empty = !settings.on_exhausted && Object.keys(overdraft).length === 0;
  const res = await updateCustomerCreditSettings(d.biz, d.cus, empty ? null : settings);
  revalidatePath(creditsPath(d.biz, d.cus));
  if (!res.ok)
    return actionError(res.error ?? "We could not save the credit settings.", {
      requestId: res.requestId,
    });
  return actionOk("Credit settings saved.");
}
