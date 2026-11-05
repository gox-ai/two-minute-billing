"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { apiWrite } from "@/lib/api";
import { actionOk, actionError, type ActionResult } from "@/lib/action-result";

const pageUrl = (biz: string) => `/businesses/${biz}/catalog/payment_links`;

interface ItemInput {
  price: string;
  quantity: number;
  min_quantity?: number;
  max_quantity?: number;
  optional?: boolean;
}

/** Create a payment link. The item rows arrive as one JSON field from the dialog. */
export async function createPaymentLinkAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("payments:collect", "ops");
  const biz = String(fd.get("biz") ?? "");
  const name = String(fd.get("name") ?? "").trim();
  if (!biz) return actionError("The business is missing. Reload the page.");
  if (!name) return actionError("Enter a name.", { errors: { name: "Enter a name." } });
  let items: ItemInput[];
  try {
    items = JSON.parse(String(fd.get("items") ?? "[]")) as ItemInput[];
  } catch {
    return actionError("We could not read the items. Reload the page and try again.");
  }
  if (!Array.isArray(items) || items.length === 0 || items.some((i) => !i.price))
    return actionError("Select a price for each item.");
  const res = await apiWrite(`/v1/businesses/${biz}/payment_links`, {
    name,
    items,
    show_on_pricing_page: fd.get("show_on_pricing_page") === "on",
  });
  revalidatePath(pageUrl(biz));
  if (!res.ok) return actionError(res.error ?? "We could not create the payment link.");
  return actionOk(`${name}: payment link created`);
}

/**
 * Archive or restore a link, or show or hide it on the pricing page — one form action, so
 * each row button posts `field` and `value` and nothing else.
 */
export async function updatePaymentLinkAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("payments:collect", "ops");
  const biz = String(fd.get("biz") ?? "");
  const id = String(fd.get("id") ?? "");
  const field = String(fd.get("field") ?? "");
  const on = fd.get("value") === "true";
  if (!biz || !id) return actionError("The payment link is missing. Reload the page.");
  if (field !== "active" && field !== "show_on_pricing_page")
    return actionError("We could not change the payment link. Reload the page.");
  const res = await apiWrite(`/v1/businesses/${biz}/payment_links/${id}`, { [field]: on }, "PATCH");
  revalidatePath(pageUrl(biz));
  if (!res.ok) return actionError(res.error ?? "We could not change the payment link.");
  if (field === "active") return actionOk(on ? "Payment link restored" : "Payment link archived");
  return actionOk(on ? "Shown on your pricing page" : "Removed from your pricing page");
}
