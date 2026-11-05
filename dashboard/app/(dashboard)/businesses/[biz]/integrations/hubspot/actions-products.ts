"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionOk, actionError, type ActionResult } from "@/lib/action-result";
import { updateHubSpotSettings } from "@/lib/api/hubspot";

export async function saveHubSpotProductsAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("integrations:manage", "admin");
  const biz = String(fd.get("biz") ?? "").trim();
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const res = await updateHubSpotSettings(biz, {
    products: { enabled: fd.get("products_enabled") === "on" },
  });
  if (!res.ok) return actionError(res.error ?? "We could not save product sync.");
  revalidatePath(`/businesses/${biz}/integrations/hubspot`);
  return actionOk("Product sync saved");
}
