"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  portalCreateSpendLimit,
  portalDeleteSpendLimit,
  portalUpdateSpendLimit,
} from "@/lib/portal-api";
import { readStorefrontToken } from "@/lib/storefront-session";
import { actionError, actionOk, parseForm, type ActionResult } from "@/lib/action-result";
import { toMinor } from "@/lib/money";

const SESSION_ENDED = "Your session ended. Open the portal link again.";
const amount = z
  .string()
  .trim()
  .min(1, "Enter an amount more than 0.")
  .refine((v) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0, "Enter an amount more than 0.");
const currency = z.string().trim().length(3, "The currency is missing. Reload the page.");

const createSchema = z
  .object({
    scope: z.enum(["customer", "property"], { message: "Select what to limit." }),
    property_key: z.string().trim().max(64).optional(),
    property_value: z.string().trim().max(255).optional(),
    interval: z.enum(["day", "week", "month", "period"], { message: "Select an interval." }),
    amount,
    currency,
  })
  .superRefine((v, ctx) => {
    if (v.scope === "property" && !v.property_key)
      ctx.addIssue({ code: "custom", path: ["property_key"], message: "Enter the property." });
  });

/** The buyer adds its own hard limit; the API refuses one above the provider's. */
export async function portalCreateLimitAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const token = await readStorefrontToken("portal");
  if (!token) return actionError(SESSION_ENDED);
  const parsed = parseForm(createSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const res = await portalCreateSpendLimit(token, {
    scope: d.scope,
    ...(d.scope === "property"
      ? { property_key: d.property_key, property_value: d.property_value || null }
      : {}),
    interval: d.interval,
    amount_minor: toMinor(Number(d.amount), d.currency),
    currency: d.currency.toUpperCase(),
  });
  revalidatePath("/portal", "layout");
  if (!res.ok)
    return actionError(res.error ?? "We could not save the limit.", {
      errors: { amount: res.error ?? "We could not save the limit." },
    });
  return actionOk("Limit saved.");
}

const editSchema = z.object({
  id: z.string().min(1, "The limit is missing. Reload the page."),
  amount,
  currency,
});

export async function portalUpdateLimitAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const token = await readStorefrontToken("portal");
  if (!token) return actionError(SESSION_ENDED);
  const parsed = parseForm(editSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const res = await portalUpdateSpendLimit(token, d.id, toMinor(Number(d.amount), d.currency));
  revalidatePath("/portal", "layout");
  if (!res.ok)
    return actionError(res.error ?? "We could not save the limit.", {
      errors: { amount: res.error ?? "We could not save the limit." },
    });
  return actionOk("Limit saved.");
}

const deleteSchema = z.object({ id: z.string().min(1, "The limit is missing. Reload the page.") });

export async function portalDeleteLimitAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const token = await readStorefrontToken("portal");
  if (!token) return actionError(SESSION_ENDED);
  const parsed = parseForm(deleteSchema, fd);
  if (parsed.error) return parsed.error;
  const res = await portalDeleteSpendLimit(token, parsed.data.id);
  revalidatePath("/portal", "layout");
  if (!res.ok) return actionError(res.error ?? "We could not delete the limit.");
  return actionOk("Limit deleted.");
}
