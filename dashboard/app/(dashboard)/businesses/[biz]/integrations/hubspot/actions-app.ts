"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionOk, actionError, type ActionResult } from "@/lib/action-result";
import { updateHubSpotSettings } from "@/lib/api/hubspot";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const DISCOUNT_MODES = ["price_override", "coupon", "ignore"] as const;

export async function saveHubSpotAppAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("integrations:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");

  const raw =
    str(fd, "deal_types_mode") === "text"
      ? str(fd, "edit_deal_types_text").split(",")
      : fd.getAll("edit_deal_types").map(String);
  const editDealTypes = [...new Set(raw.map((v) => v.trim()).filter(Boolean))];

  const discountMode = str(fd, "discount_mode");
  if (!(DISCOUNT_MODES as readonly string[]).includes(discountMode))
    return actionError("Select how deal discounts reach the subscription");

  const res = await updateHubSpotSettings(biz, {
    deals: { manualCreate: fd.get("manual_create") === "on", editDealTypes, discountMode },
  });
  if (!res.ok) return actionError(res.error ?? "We could not save the HubSpot options.");
  revalidatePath(`/businesses/${biz}/integrations/hubspot`);
  return actionOk("HubSpot options saved");
}
