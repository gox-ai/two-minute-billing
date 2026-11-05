"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getMe } from "@/lib/api";
import { planCheckout } from "@/lib/account-billing";
import { actionError, type ActionResult } from "@/lib/action-result";
import { requirePermission } from "@/lib/session";

/** Where the hosted checkout and portal send the person back to. */
async function returnUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:4100";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/settings/billing`;
}

/** Open our hosted checkout for a plan: the first plan, or a change to the current one. */
export async function choosePlanAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const price = String(formData.get("price") ?? "");
  if (!price) return actionError("We could not open the checkout. Select a plan.");
  let url: string;
  try {
    const org = await getMe();
    url = (await planCheckout(org.id, price, `${await returnUrl()}?done=1`)).url;
  } catch (e) {
    return actionError(`We could not open the checkout. ${(e as Error).message}`);
  }
  redirect(url);
}
