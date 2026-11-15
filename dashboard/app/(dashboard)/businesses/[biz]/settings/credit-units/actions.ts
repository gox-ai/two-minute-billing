"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, parseForm, type ActionResult } from "@/lib/action-result";
import {
  archiveCreditUnit,
  createCreditUnit,
  updateCreditUnit,
  type CreditUnitWrite,
} from "@/lib/api/credits";
import { majorRateToMinorDecimal, maxRateDecimals, unitFormRate } from "@/lib/credits";
import { planOverdraftChanges, stepsFromUnits, zeroOrMoreMessage } from "@/lib/credit-settings";
import {
  listPlanOverdraftLimits,
  removePlanOverdraftLimit,
  setPlanOverdraftLimit,
} from "@/lib/api/credit-settings";

const unitsPath = (biz: string) => `/businesses/${biz}/settings/credit-units`;

const unitSchema = z
  .object({
    biz: z.string().min(1),
    unit: z.string().optional(),
    locked: z.string().optional(),
    no_rate: z.string().optional(),
    expected_version: z.coerce.number().int().optional(),
    name: z.string().trim().min(1, "Enter a name.").max(100, "Enter 100 characters or fewer."),
    plural_name: z
      .string()
      .trim()
      .min(1, "Enter the plural name.")
      .max(100, "Enter 100 characters or fewer."),
    key: z
      .string()
      .trim()
      .max(100)
      .refine((v) => v === "" || /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(v), {
        message: "Use only letters, digits, dots, dashes or underscores. Do not use spaces.",
      })
      .optional(),
    currency: z.string().trim().length(3, "Select a currency.").optional(),
    rate: z.string().trim().optional(),
    decimals: z.coerce.number().int().min(0).max(4).optional(),
    // Policies of a unit with no money value; posted only for such a unit.
    unit_decimals: z.coerce.number().int().min(0).max(4).optional(),
    unit_currency: z.string().trim().length(3).optional(),
    overage: z.string().trim().optional(),
    overdraft: z.string().trim().optional(),
    negative_balance_at_reset: z.enum(["carry", "forgive"]).optional(),
    plan_overdrafts: z.string().optional(),
    /** JSON list of the plans the form loaded: only these can be removed. */
    plan_overdrafts_loaded: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    const d = v.unit_decimals ?? 0;
    if (v.overage && !majorRateToMinorDecimal(v.overage, v.unit_currency ?? "USD"))
      ctx.addIssue({
        code: "custom",
        path: ["overage"],
        message: "Enter a price more than 0, or leave it empty.",
      });
    if (v.overdraft && stepsFromUnits(v.overdraft, d) === null)
      ctx.addIssue({
        code: "custom",
        path: ["overdraft"],
        message: zeroOrMoreMessage(d),
      });
    if (planRows(v.plan_overdrafts, d) === null)
      ctx.addIssue({
        code: "custom",
        path: ["plan_overdrafts"],
        message: zeroOrMoreMessage(d, "a plan limit"),
      });
    if (v.locked === "1") return;
    if (!v.currency)
      ctx.addIssue({ code: "custom", path: ["currency"], message: "Select a currency." });
    // "No money value" needs no rate, on create and on a unit with no grant yet.
    if (unitFormRate(v.no_rate, v.rate, v.currency ?? "USD") === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["rate"],
        message: `Enter the money value of one unit: more than 0, with up to ${maxRateDecimals(v.currency ?? "USD")} decimal places. Or select No money value.`,
      });
  });

/** The plan rows of the form in steps; null when one is not a valid limit. */
function planRows(json: string | undefined, decimals: number) {
  if (!json) return [];
  let rows: Array<{ product?: unknown; limit?: unknown }>;
  try {
    rows = JSON.parse(json);
  } catch {
    return null;
  }
  const out: Array<{ product: string; steps: number }> = [];
  for (const r of rows) {
    if (typeof r.product !== "string" || !r.product) continue;
    const steps = stepsFromUnits(String(r.limit ?? ""), decimals);
    if (steps === null) return null;
    out.push({ product: r.product, steps });
  }
  return out;
}

type UnitBody = CreditUnitWrite & {
  overage_minor_per_unit?: string | null;
  overdraft_limit?: number;
  negative_balance_at_reset?: "carry" | "forgive";
};

function unitBody(d: z.infer<typeof unitSchema>): UnitBody {
  const body: UnitBody = { name: d.name, plural_name: d.plural_name };
  if (d.negative_balance_at_reset) {
    const cur = (d.unit_currency ?? d.currency ?? "USD").toUpperCase();
    body.overage_minor_per_unit = d.overage ? majorRateToMinorDecimal(d.overage, cur) : null;
    body.overdraft_limit = d.overdraft ? stepsFromUnits(d.overdraft, d.unit_decimals ?? 0)! : 0;
    body.negative_balance_at_reset = d.negative_balance_at_reset;
  }
  if (d.locked !== "1") {
    body.currency = d.currency!.toUpperCase();
    // Always sent: a rate, or null for a unit with no money value.
    body.minor_per_unit = unitFormRate(d.no_rate, d.rate, body.currency)!;
    body.decimals = d.decimals ?? 0;
  }
  return body;
}

export async function createCreditUnitAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("credits:manage", "ops");
  const parsed = parseForm(unitSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const res = await createCreditUnit(d.biz, { ...(d.key ? { id: d.key } : {}), ...unitBody(d) });
  revalidatePath(unitsPath(d.biz));
  if (!res.ok) {
    if (res.status === 409)
      return actionError(res.error ?? "That unit ID is already in use.", {
        errors: { key: res.error ?? "That unit ID is already in use." },
      });
    return actionError(res.error ?? "We could not create the credit unit.", {
      requestId: res.requestId,
      ...(res.param ? { errors: { [res.param]: res.error ?? "" } } : {}),
    });
  }
  const unitKey = (res.data as { id?: string } | undefined)?.id ?? d.key;
  const plans = await syncPlanOverdrafts(d, unitKey);
  if (plans) return plans;
  return actionOk(`Credit unit ${d.name} created.`, unitsPath(d.biz));
}

export async function updateCreditUnitAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("credits:manage", "ops");
  const parsed = parseForm(unitSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  if (!d.unit) return actionError("The unit ID is missing. Reload the page.");
  const body = unitBody(d);
  if (d.expected_version) body.expected_version = d.expected_version;
  const res = await updateCreditUnit(d.biz, d.unit, body);
  revalidatePath(unitsPath(d.biz));
  if (!res.ok)
    return actionError(res.error ?? "We could not change the credit unit.", {
      requestId: res.requestId,
      ...(res.status === 409 && !res.error ? { code: "conflict" as const } : {}),
    });
  const plans = await syncPlanOverdrafts(d, d.unit);
  if (plans) return plans;
  return actionOk("Credit unit saved.", unitsPath(d.biz));
}

/** PUT and DELETE the plan overrides the form changed. A failure is returned. */
async function syncPlanOverdrafts(
  d: z.infer<typeof unitSchema>,
  unit: string | undefined,
): Promise<ActionResult | null> {
  if (!d.negative_balance_at_reset || !unit) return null;
  const rows = planRows(d.plan_overdrafts, d.unit_decimals ?? 0) ?? [];
  const stored = (await listPlanOverdraftLimits(d.biz, unit)).flatMap((o) =>
    o.product ? [{ product: o.product, overdraft_limit: o.overdraft_limit }] : [],
  );
  let loaded = new Set<string>();
  try {
    const raw: unknown = JSON.parse(d.plan_overdrafts_loaded ?? "[]");
    if (Array.isArray(raw)) loaded = new Set(raw.filter((x): x is string => typeof x === "string"));
  } catch {
    /* no list: remove nothing */
  }
  const changes = planOverdraftChanges(stored, rows, loaded);
  for (const p of changes.put) {
    const r = await setPlanOverdraftLimit(d.biz, unit, p.product, p.steps);
    if (!r.ok)
      return actionError(r.error ?? "We could not save the overdraft limit of a plan.", {
        requestId: r.requestId,
      });
  }
  for (const product of changes.remove) {
    const r = await removePlanOverdraftLimit(d.biz, unit, product);
    if (!r.ok)
      return actionError(r.error ?? "We could not remove the overdraft limit of a plan.", {
        requestId: r.requestId,
      });
  }
  return null;
}

export async function archiveCreditUnitAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("credits:manage", "ops");
  const biz = String(fd.get("biz") ?? "");
  const unit = String(fd.get("unit") ?? "");
  if (!biz || !unit) return actionError("The unit ID is missing. Reload the page.");
  const res = await archiveCreditUnit(biz, unit);
  revalidatePath(unitsPath(biz));
  if (!res.ok)
    return actionError(res.error ?? "We could not archive the credit unit.", {
      requestId: res.requestId,
    });
  return actionOk("Credit unit archived.");
}
