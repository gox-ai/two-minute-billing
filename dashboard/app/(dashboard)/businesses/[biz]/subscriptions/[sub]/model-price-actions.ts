"use server";

import { revalidatePath } from "next/cache";
import { apiPatch } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";

const PERCENT = /^\d+(?:\.\d{1,6})?$/;
const DECIMAL = /^\d+(?:\.\d{1,12})?$/;

type OverrideRate = {
  match: Record<string, string>;
  unit_amount_decimal?: string;
  markup_percent?: string;
};

/**
 * Per-customer selling price on a `model_price_list` or `event_cost_or_list` item (design
 * G1b § 3.4): the item's own markup and per-model rows, written into its price snapshot
 * (`PATCH …/items/:item`).
 */
export async function setItemModelPriceAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("subscriptions:manage", "manager");
  const biz = String(fd.get("biz") ?? "");
  const sub = String(fd.get("sub") ?? "");
  const item = String(fd.get("item") ?? "");
  if (!biz || !sub || !item)
    return actionError("The subscription item is missing. Reload the page.");

  const markup = String(fd.get("markup_percent") ?? "").trim();
  if (markup && !PERCENT.test(markup))
    return actionError("Correct the highlighted fields.", {
      errors: { markup_percent: "Enter a percent, 0 or more, with no more than 6 decimal places." },
    });

  let rates: OverrideRate[];
  try {
    rates = JSON.parse(String(fd.get("rates") ?? "[]"));
  } catch {
    return actionError("We could not read the rates. Reload the page.");
  }
  for (const r of rates) {
    if (!Object.keys(r.match ?? {}).length)
      return actionError("Correct the highlighted fields.", {
        errors: { rates: "Each row needs at least one value." },
      });
    const ok =
      r.markup_percent !== undefined
        ? PERCENT.test(r.markup_percent)
        : DECIMAL.test(r.unit_amount_decimal ?? "");
    if (!ok)
      return actionError("Correct the highlighted fields.", {
        errors: { rates: "Enter a fixed rate or a markup for each row." },
      });
  }

  const res = await apiPatch(`/v1/businesses/${biz}/subscriptions/${sub}/items/${item}`, {
    markup_percent: markup || null,
    rates,
  });
  revalidatePath(`/businesses/${biz}/subscriptions/${sub}`);
  if (!res.ok)
    return actionError(res.error ?? "We could not change the price.", {
      requestId: res.requestId,
      ...(res.param ? { errors: { [res.param]: res.error ?? "" } } : {}),
    });
  return actionOk("Price saved.");
}
