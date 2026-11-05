"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionOk, actionError, type ActionResult } from "@/lib/action-result";
import {
  updateBusiness,
  type CheckoutFieldKey,
  type CheckoutFieldState,
  type PortalFieldKey,
  type PortalFieldState,
} from "@/lib/api/business-settings";
import {
  CHECKOUT_KEYS,
  CHECKOUT_STATES,
  PORTAL_KEYS,
  PORTAL_STATES,
  neverHidden,
  portalInputName,
} from "./field-matrix";

// Own action for this page rather than adding to the shared settings/actions.ts (0245).

/**
 * Save both matrices whole: every row posts on one form, so what the screen shows is what
 * gets stored. An invalid posted state is omitted, and the engine's default then applies.
 */
export async function saveCheckoutFieldsAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = String(fd.get("biz") ?? "").trim();
  if (!biz) return actionError("The business ID is missing. Reload the page.");

  const valid = (k: string, v: string, states: readonly string[]) =>
    states.includes(v) && !(v === "hide" && neverHidden(k));

  const checkout_field_config: Partial<Record<CheckoutFieldKey, CheckoutFieldState>> = {};
  for (const key of CHECKOUT_KEYS) {
    const v = String(fd.get(key) ?? "");
    if (valid(key, v, CHECKOUT_STATES)) checkout_field_config[key] = v as CheckoutFieldState;
  }
  const portal_field_config: Partial<Record<PortalFieldKey, PortalFieldState>> = {};
  for (const key of PORTAL_KEYS) {
    const v = String(fd.get(portalInputName(key)) ?? "");
    if (valid(key, v, PORTAL_STATES)) portal_field_config[key] = v as PortalFieldState;
  }

  const evRaw = String(fd.get("expected_version") ?? "").trim();
  const ev = evRaw ? Number(evRaw) : null;

  const res = await updateBusiness(biz, {
    checkout_field_config,
    portal_field_config,
    ...(ev != null && Number.isFinite(ev) && ev > 0 ? { expected_version: ev } : {}),
  });
  revalidatePath(`/businesses/${biz}/settings/checkout-fields`);

  if (res.ok) return actionOk("Checkout and portal fields saved");
  if (res.status === 409) {
    return actionError(res.error ?? "Someone changed this business after you opened it.", {
      code: "conflict",
    });
  }
  return actionError(res.error ?? "We could not save the checkout and portal fields.");
}
