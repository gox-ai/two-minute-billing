"use server";

import { revalidatePath } from "next/cache";
import {
  portalBuyCredits,
  portalQuoteCredits,
  portalSetAutoTopup,
  type PortalCreditPackQuote,
} from "@/lib/portal-api";
import { readStorefrontToken } from "@/lib/storefront-session";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";

const readCoupon = (fd: FormData) => String(fd.get("coupon") ?? "").trim() || undefined;

/**
 * "Buy credits": mint a purchase checkout for one pack price. Returns its URL; the client
 * opens it with a full page load (a server redirect is a soft navigation, and the checkout
 * page then reads the link as not valid). A coupon code goes onto that checkout.
 */
export async function portalBuyCreditsAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const token = await readStorefrontToken("portal");
  if (!token) return actionError("Your session ended. Open the portal link again.");
  const price = String(fd.get("price") ?? "");
  const quantity = Number(fd.get("quantity") ?? "1");
  if (!price) return actionError("We could not start the purchase. Reload the page.");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100)
    return actionError("We could not start the purchase. Enter a quantity from 1 to 100.");
  const coupon = readCoupon(fd);
  const res = await portalBuyCredits(token, price, quantity, coupon);
  if (!res.ok || !res.data?.url)
    return actionError(
      res.error ?? "We could not start the purchase. Try again.",
      coupon && res.status === 400 ? { errors: { coupon: res.error ?? "" } } : undefined,
    );
  return actionOk(undefined, res.data.url);
}

/** The price of one pack purchase with a coupon code, before the buyer pays. */
export async function portalQuoteCreditsAction(input: {
  price: string;
  quantity: number;
  coupon: string;
}): Promise<{ ok: true; quote: PortalCreditPackQuote } | { ok: false; error: string }> {
  const token = await readStorefrontToken("portal");
  if (!token) return { ok: false, error: "Your session ended. Open the portal link again." };
  const coupon = input.coupon.trim();
  if (!coupon) return { ok: false, error: "Enter a coupon code." };
  const res = await portalQuoteCredits(token, input.price, input.quantity, coupon);
  if (!res.ok || !res.data)
    return { ok: false, error: res.error ?? "We could not check the coupon code. Try again." };
  return { ok: true, quote: res.data };
}

/** The buyer enables or disables automatic top-up for one credit unit. */
export async function portalSetAutoTopupAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const token = await readStorefrontToken("portal");
  if (!token) return actionError("Your session ended. Open the portal link again.");
  const unit = String(fd.get("unit") ?? "");
  const enabled = fd.get("enabled") === "true";
  if (!unit) return actionError("We could not change automatic top-up. Reload the page.");
  const res = await portalSetAutoTopup(token, unit, enabled);
  revalidatePath("/portal", "layout");
  if (!res.ok) return actionError(res.error ?? "We could not change automatic top-up. Try again.");
  return actionOk(enabled ? "Automatic top-up enabled." : "Automatic top-up disabled.");
}
