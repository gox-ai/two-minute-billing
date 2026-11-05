"use server";

import { revalidatePath } from "next/cache";
import { actionOk, actionError, type ActionResult } from "@/lib/action-result";
import { requirePermission } from "@/lib/session";
import { voidPaymentIntent } from "@/lib/api/payments";

/**
 * Cancel a hanging intent at the gateway.
 *
 * The void endpoint has existed since C-PI and nothing in the dashboard reached it, so
 * the only way to clear one was a curl with a live key. An open intent occupies its
 * invoice for the rail's whole TTL — 96 hours on an Indian card — which blocks the
 * customer from paying by any other means until it lapses (production, 2026-09-06: an
 * abandoned Pay now held ₹52,414.64 of invoice for four days).
 *
 * It does NOT need "is money held?" answered first, and that is a property of the engine
 * rather than luck: `voidPaymentIntent` throws unless the GATEWAY confirms the void, so a
 * captured intent fails loudly instead of being marked void here while the money sits at
 * the gateway. A released authorization books its reversal on the way through.
 */
export async function voidPaymentIntentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("payments:collect", "ops");
  const biz = String(formData.get("biz") ?? "").trim();
  const pi = String(formData.get("pi") ?? "").trim();
  if (!biz || !pi) return actionError("The payment intent ID is missing. Reload the page.");

  const res = await voidPaymentIntent(biz, pi);
  revalidatePath(`/businesses/${biz}/payment_intents/${pi}`);
  revalidatePath(`/businesses/${biz}/payment_intents`);
  return res.ok
    ? actionOk("Intent voided at the gateway")
    : actionError(res.error ?? "We could not void the payment intent.");
}
