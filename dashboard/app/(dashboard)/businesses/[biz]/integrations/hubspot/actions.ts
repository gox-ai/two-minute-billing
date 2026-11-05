"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionOk, actionError, type ActionResult } from "@/lib/action-result";
import { disconnectHubSpot, startHubSpot, syncHubSpot, updateHubSpot } from "@/lib/api/hubspot";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const revalidate = (biz: string) => revalidatePath(`/businesses/${biz}/integrations/hubspot`);

export async function saveHubSpotSettingsAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("integrations:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const res = await updateHubSpot(biz, { autosync: fd.get("autosync") === "on" });
  if (!res.ok) return actionError(res.error ?? "We could not save the HubSpot settings.");
  revalidate(biz);
  return actionOk("HubSpot settings saved");
}

export async function syncHubSpotAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("integrations:manage", "manager");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const full = str(fd, "full") === "1";
  const res = await syncHubSpot(biz, full);
  if (!res.ok) return actionError(res.error ?? "We could not start a sync.");
  revalidate(biz);
  return actionOk(full ? "Full resync started" : "Sync started");
}

export async function disconnectHubSpotAction(biz: string): Promise<ActionResult> {
  await requirePermission("integrations:manage", "admin");
  const res = await disconnectHubSpot(biz);
  if (!res.ok) return actionError(res.error ?? "We could not disconnect HubSpot.");
  revalidate(biz);
  return actionOk("HubSpot disconnected");
}

export async function startHubSpotAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("integrations:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const res = await startHubSpot(biz);
  if (!res.ok) return actionError(res.error ?? "We could not start the first sync.");
  revalidate(biz);
  return actionOk("First sync started");
}
