"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { apiWrite } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { parseForm, actionOk, actionError, type ActionResult } from "@/lib/action-result";
import { NOT_UTC_MESSAGE, parseUtcFromForm } from "@/lib/tz";
import { fmtDateTime } from "@/lib/format";
import { businessTz } from "@/lib/business-tz-server";

/**
 * New invoice-lifecycle ops that app/actions.ts's `invoiceOpAction` does not
 * cover (its whitelist is void/write_off/collect/retry only). These return an
 * ActionResult for <ActionForm>; a 409 maps to code:'conflict' so the toast
 * offers Reload. Routes: src/api/invoice-routes.ts.
 */

const invPath = (biz: string, inv: string) => `/businesses/${biz}/invoices/${inv}`;

/** Map an apiWrite failure to an ActionResult, tagging 409 as a conflict. */
function toError(res: { status: number; error?: string }): ActionResult {
  const msg = res.error ?? "We could not change the invoice.";
  return res.status === 409 ? actionError(msg, { code: "conflict" }) : actionError(msg);
}

const bizInv = z.object({ biz: z.string().min(1), inv: z.string().min(1) });

/** Close a pending invoice → finalize (discount/tax/credits/collect). */
export async function closeInvoiceAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("invoices:manage", "ops");
  const { data, error } = parseForm(bizInv, formData);
  if (error) return error;
  const res = await apiWrite(`/v1/businesses/${data.biz}/invoices/${data.inv}/close`, {});
  if (!res.ok) return toError(res);
  revalidatePath(invPath(data.biz, data.inv));
  return actionOk("Invoice closed");
}

/** Regenerate a voided invoice → a fresh invoice for the same period. */
export async function regenerateInvoiceAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("invoices:manage", "ops");
  const { data, error } = parseForm(bizInv, formData);
  if (error) return error;
  const res = await apiWrite(`/v1/businesses/${data.biz}/invoices/${data.inv}/regenerate`, {});
  if (!res.ok) return toError(res);
  revalidatePath(`/businesses/${data.biz}/invoices`);
  revalidatePath(invPath(data.biz, data.inv));
  const fresh = (res.data as { id?: string } | undefined)?.id;
  return actionOk(fresh ? `Invoice regenerated as ${fresh}` : "Invoice regenerated");
}

/** Stop dunning: halt retries; invoice settles to not_paid (debt still stands). */
export async function stopDunningAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("invoices:manage", "ops");
  const { data, error } = parseForm(bizInv, formData);
  if (error) return error;
  const res = await apiWrite(`/v1/businesses/${data.biz}/invoices/${data.inv}/stop_dunning`, {});
  if (!res.ok) return toError(res);
  revalidatePath(invPath(data.biz, data.inv));
  return actionOk("Dunning stopped");
}

/** Pause dunning until a date: invoice stays payment_due; next retry pushed out. */
export async function pauseDunningAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("invoices:manage", "ops");
  const { data, error } = parseForm(bizInv.extend({ until: z.string().min(1) }), formData);
  if (error) return error;
  const until = parseUtcFromForm(data.until);
  if (!until)
    return actionError("Enter a valid date and time.", { errors: { until: NOT_UTC_MESSAGE } });
  const res = await apiWrite(`/v1/businesses/${data.biz}/invoices/${data.inv}/pause_dunning`, {
    until: until.toISOString(),
  });
  if (!res.ok) return toError(res);
  revalidatePath(invPath(data.biz, data.inv));
  return actionOk(
    `Dunning paused until ${fmtDateTime(until.toISOString(), await businessTz(data.biz))}`,
  );
}
