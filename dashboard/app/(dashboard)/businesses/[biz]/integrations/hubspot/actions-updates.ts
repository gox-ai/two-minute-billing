"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionOk, actionError, type ActionResult } from "@/lib/action-result";
import { updateHubSpotSettings } from "@/lib/api/hubspot";

const REMOTE_CHANGE = ["overwrite_local", "nothing"] as const;
const CONFLICT = ["local_wins", "remote_wins", "flag"] as const;

export async function saveHubSpotUpdatesAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("integrations:manage", "admin");
  const biz = String(fd.get("biz") ?? "").trim();
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const remoteChange = String(fd.get("remote_change") ?? "");
  const conflict = String(fd.get("conflict") ?? "");
  if (!(REMOTE_CHANGE as readonly string[]).includes(remoteChange))
    return actionError("Select what a HubSpot change does");
  if (!(CONFLICT as readonly string[]).includes(conflict))
    return actionError("Select how to resolve conflicts");
  // `localChange` belongs to the customers section; the API deep-merges, so it is left untouched.
  const pullAddress = fd.get("pull_address") === "on";
  const pullEmail = fd.get("pull_email") === "on";
  const res = await updateHubSpotSettings(biz, {
    updates: { remoteChange, conflict, pullAddress, pullEmail },
  });
  if (!res.ok) return actionError(res.error ?? "We could not save update rules.");
  revalidatePath(`/businesses/${biz}/integrations/hubspot`);
  return actionOk("Update rules saved");
}
