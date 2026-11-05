"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission, requireUser } from "@/lib/session";

// Reads below use `requireUser`: the API checks `model_prices:view`, and a redirect from a
// server action would navigate away from the invoice or form that asked.
import { actionError, actionOk, parseForm, type ActionResult } from "@/lib/action-result";
import {
  createCostOverride,
  deleteCostOverride,
  endCostOverride,
  getModelPrice,
  getModelPriceHistory,
  listModelPrices,
  type ModelPrice,
  type ModelPriceListRow,
  type ModelPriceHistory,
} from "@/lib/api/model-prices";
import { MAX_USAGE_DECIMALS, decimalPlaces, majorRateToMinor } from "@/lib/meters";

const PATH = "/settings/model-prices";

const isoOrEmpty = z
  .string()
  .trim()
  .optional()
  .refine((v) => !v || !Number.isNaN(Date.parse(v)), { message: "Enter a date and time." });

const costSchema = z.object({
  provider: z.string().trim().max(100).optional(),
  model: z.string().trim().min(1, "Enter the model.").max(200),
  token_type: z.string().trim().min(1, "Enter the token type.").max(100),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, "Select a currency."),
  cost: z
    .string()
    .trim()
    .regex(/^\d+(?:\.\d+)?$/, "Enter the cost as a number, 0 or more."),
  quantity_divisor: z.enum(["1", "1000", "1000000"]),
  effective_from: isoOrEmpty,
  note: z.string().trim().max(500).optional(),
});

/** Set your cost: a new `model_cost_overrides` row from `effective_from` (empty = now). */
export async function setCostAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("model_prices:manage", "manager");
  const parsed = parseForm(costSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const currency = d.currency.toUpperCase();
  const minor = majorRateToMinor(d.cost, currency);
  if (minor == null || (decimalPlaces(minor) ?? 99) > MAX_USAGE_DECIMALS)
    return actionError("Correct the highlighted fields.", {
      errors: { cost: "Use no more than 12 decimal places in minor units." },
    });
  if (d.effective_from && Date.parse(d.effective_from) < Date.now() - 60_000)
    return actionError("Correct the highlighted fields.", {
      errors: { effective_from: "Select now or a later time. A cost cannot start in the past." },
    });
  const res = await createCostOverride({
    provider: d.provider || null,
    model: d.model,
    token_type: d.token_type,
    currency,
    unit_amount_decimal: minor,
    quantity_divisor: d.quantity_divisor,
    ...(d.effective_from ? { effective_from: new Date(d.effective_from).toISOString() } : {}),
    ...(d.note ? { note: d.note } : {}),
  });
  revalidatePath(PATH);
  if (!res.ok) {
    if (res.status === 409)
      return actionError(
        res.error ??
          "We could not save the cost. A cost for this model is in effect at that time. End it first.",
        { requestId: res.requestId },
      );
    return actionError(res.error ?? "We could not save the cost.", {
      requestId: res.requestId,
      ...(res.param ? { errors: { [res.param]: res.error ?? "" } } : {}),
    });
  }
  return actionOk("Cost saved.");
}

const endSchema = z.object({
  id: z.string().min(1),
  effective_to: isoOrEmpty,
});

/** End your cost at `effective_to` (empty = now). */
export async function endCostAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("model_prices:manage", "manager");
  const parsed = parseForm(endSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  if (d.effective_to && Date.parse(d.effective_to) < Date.now() - 60_000)
    return actionError("Correct the highlighted fields.", {
      errors: { effective_to: "Select now or a later time." },
    });
  const res = await endCostOverride(
    d.id,
    d.effective_to ? new Date(d.effective_to).toISOString() : undefined,
  );
  revalidatePath(PATH);
  if (!res.ok)
    return actionError(res.error ?? "We could not end the cost.", { requestId: res.requestId });
  return actionOk("Cost ended.");
}

/** Delete a cost row that has not started. The API refuses a started row. */
export async function deleteCostAction(id: string): Promise<ActionResult> {
  await requirePermission("model_prices:manage", "manager");
  const res = await deleteCostOverride(id);
  revalidatePath(PATH);
  if (!res.ok)
    return actionError(res.error ?? "We could not delete the cost.", { requestId: res.requestId });
  return actionOk("Cost deleted.");
}

/** The price history drawer: dated list rows and cost rows for one model. */
export async function modelPriceHistoryAction(key: {
  provider: string | null;
  model: string;
  token_type?: string;
}): Promise<{ ok: true; data: ModelPriceHistory } | { ok: false; message: string }> {
  await requireUser();
  try {
    return { ok: true, data: await getModelPriceHistory(key) };
  } catch {
    return { ok: false, message: "We could not load the price history. Try again." };
  }
}

/** One cited list row, for the invoice "Price source" popover. */
export async function modelPriceAction(
  id: string,
): Promise<{ ok: true; data: ModelPrice | null } | { ok: false; message: string }> {
  await requireUser();
  try {
    return { ok: true, data: await getModelPrice(id) };
  } catch {
    return { ok: false, message: "We could not load the price." };
  }
}

/**
 * The list row and your cost live now for one key, for a read-only "Price now". Null when the
 * list has no row for it (or more than one provider lists the model and none is named).
 */
export async function priceNowAction(key: {
  provider?: string | null;
  model: string;
  token_type: string;
}): Promise<ModelPriceListRow | null> {
  await requireUser();
  try {
    const page = await listModelPrices({
      model: key.model,
      token_type: key.token_type,
      ...(key.provider ? { provider: key.provider } : {}),
      limit: 3,
    });
    const rows = page.data.filter((r) => r.model === key.model && r.token_type === key.token_type);
    return rows.length === 1 ? rows[0] : null;
  } catch {
    return null;
  }
}
