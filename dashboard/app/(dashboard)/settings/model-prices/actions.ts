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
  listUnlistedCosts,
  type ModelCostOverride,
  type ModelPrice,
  type ModelPriceListRow,
  type ModelPriceHistory,
} from "@/lib/api/model-prices";
import { MAX_USAGE_DECIMALS, decimalPlaces, majorRateToMinor } from "@/lib/meters";
import { currencyExponent } from "@/lib/money";
import {
  COST_DIVISORS_BY_UNIT,
  PRICE_UNITS,
  TIER_MESSAGE,
  TIER_RE,
  normalizeTier,
  type UnlistedCostFilters,
  type UnlistedCostPage,
} from "@/lib/model-prices";

const PATH = "/settings/model-prices";

const isoOrEmpty = z
  .string()
  .trim()
  .optional()
  .refine((v) => !v || !Number.isNaN(Date.parse(v)), { message: "Enter a date and time." });

// "HD" and "1024X1024" are the tiers "hd" and "1024x1024", as on a meter and an event.
const tier = z
  .string()
  .transform(normalizeTier)
  .pipe(z.string().regex(TIER_RE, TIER_MESSAGE))
  .optional();

/** The typed fields a failed submit sends back, so the dialog keeps them (`KeptInput`). */
const KEPT = ["model", "token_type", "provider", "quality", "resolution", "cost", "note"];

const costSchema = z.object({
  provider: z.string().trim().max(100).optional(),
  model: z.string().trim().min(1, "Enter the model.").max(200),
  token_type: z.string().trim().min(1, "Enter the price type.").max(100),
  unit: z.enum(PRICE_UNITS.map((u) => u.value) as [string, ...string[]]).default("token"),
  quality: tier,
  resolution: tier,
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, "Select a currency."),
  cost: z
    .string()
    .trim()
    .regex(/^\d+(?:\.\d+)?$/, "Enter the cost as a number, 0 or more."),
  quantity_divisor: z.enum(["1", "60", "1000", "3600", "1000000", "1000000000"], {
    error: "Select an amount for this unit.",
  }),
  effective_from: isoOrEmpty,
  note: z.string().trim().max(500).optional(),
});

/** Set your cost: a new `model_cost_overrides` row from `effective_from` (empty = now). */
export async function setCostAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("model_prices:manage", "manager");
  const values = Object.fromEntries(KEPT.map((k) => [k, String(fd.get(k) ?? "")]));
  const parsed = parseForm(costSchema, fd);
  if (parsed.error) return { ...parsed.error, values };
  const d = parsed.data;
  if (!COST_DIVISORS_BY_UNIT[d.unit]?.includes(d.quantity_divisor))
    return actionError("Correct the highlighted fields.", {
      errors: { quantity_divisor: "Select an amount for this unit." },
      values,
    });
  const currency = d.currency.toUpperCase();
  const minor = majorRateToMinor(d.cost, currency);
  if (minor == null || (decimalPlaces(minor) ?? 99) > MAX_USAGE_DECIMALS)
    return actionError("Correct the highlighted fields.", {
      errors: {
        cost: `Enter the cost as a number with no more than ${MAX_USAGE_DECIMALS + currencyExponent(currency)} decimal places.`,
      },
      values,
    });
  if (d.effective_from && Date.parse(d.effective_from) < Date.now() - 60_000)
    return actionError("Correct the highlighted fields.", {
      errors: { effective_from: "Select now or a later time. A cost cannot start in the past." },
      values,
    });
  const res = await createCostOverride({
    provider: d.provider || null,
    model: d.model,
    token_type: d.token_type,
    unit: d.unit,
    ...(d.quality ? { quality: d.quality } : {}),
    ...(d.resolution ? { resolution: d.resolution } : {}),
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
        { requestId: res.requestId, values },
      );
    return actionError(res.error ?? "We could not save the cost.", {
      requestId: res.requestId,
      values,
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
  unit?: string | null;
}): Promise<{ ok: true; data: ModelPriceHistory; at: number } | { ok: false; message: string }> {
  await requireUser();
  try {
    // `at`: when the rows were read, so the sheet decides "ended" per load.
    return { ok: true, data: await getModelPriceHistory(key), at: Date.now() };
  } catch {
    return { ok: false, message: "We could not load the price history. Try again." };
  }
}

/** One read of "Your costs with no list price", for the page's search and filters. */
export async function unlistedCostsAction(
  f: UnlistedCostFilters & { starting_after?: string | null },
): Promise<({ ok: true } & UnlistedCostPage<ModelCostOverride>) | { ok: false }> {
  await requireUser();
  try {
    return { ok: true, ...(await listUnlistedCosts(f)) };
  } catch {
    return { ok: false };
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
 * list has no row for it (or more than one provider lists the model and none is named). No
 * unit resolves tokens, else requests, as billing does.
 */
export async function priceNowAction(key: {
  provider?: string | null;
  model: string;
  token_type: string;
  unit?: string | null;
}): Promise<ModelPriceListRow | null> {
  await requireUser();
  try {
    const page = await listModelPrices({
      model: key.model,
      token_type: key.token_type,
      ...(key.provider ? { provider: key.provider } : {}),
      ...(key.unit ? { unit: key.unit } : {}),
      limit: 20,
    });
    const all = page.data.filter(
      (r) =>
        r.model === key.model && r.token_type === key.token_type && !r.quality && !r.resolution,
    );
    const ofUnit = (u: string) => all.filter((r) => (r.unit ?? "token") === u);
    const rows = key.unit
      ? ofUnit(key.unit)
      : ofUnit("token").length
        ? ofUnit("token")
        : ofUnit("request");
    return rows.length === 1 ? rows[0] : null;
  } catch {
    return null;
  }
}
