"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionOk, actionError, type ActionResult } from "@/lib/action-result";
import { resolveHubSpotConflict } from "@/lib/api/hubspot";

export async function resolveHubSpotConflictAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("integrations:manage", "admin");
  const biz = String(fd.get("biz") ?? "").trim();
  const id = String(fd.get("id") ?? "").trim();
  const keep = String(fd.get("keep") ?? "");
  if (!biz || !id) return actionError("The conflict ID is missing. Reload the page.");
  if (keep !== "ours" && keep !== "theirs") return actionError("Select which version to keep");
  const res = await resolveHubSpotConflict(biz, id, keep);
  if (!res.ok) return actionError(res.error ?? "We could not resolve the conflict.");
  revalidatePath(`/businesses/${biz}/integrations/hubspot`);
  return actionOk(
    keep === "ours" ? "Kept our values. We will update HubSpot" : "Kept the HubSpot values",
  );
}
