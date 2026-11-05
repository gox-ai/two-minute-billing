"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionOk, actionError, type ActionResult } from "@/lib/action-result";
import { updateHubSpotSettings } from "@/lib/api/hubspot";

export async function saveHubSpotInvoicesAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("integrations:manage", "admin");
  const biz = String(fd.get("biz") ?? "").trim();
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const enabled = fd.get("invoices_enabled") === "on";
  const objectType = String(fd.get("invoice_object") ?? "").trim() || null;
  if (enabled && !objectType)
    return actionError("Select the HubSpot object for invoices. Then enable invoice sync.");
  const res = await updateHubSpotSettings(biz, { invoices: { enabled, objectType } });
  if (!res.ok) return actionError(res.error ?? "We could not save invoice sync.");
  revalidatePath(`/businesses/${biz}/integrations/hubspot`);
  return actionOk("Invoice sync saved");
}
