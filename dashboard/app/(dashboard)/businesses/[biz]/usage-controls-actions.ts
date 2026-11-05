"use server";

// Usage controls (design G5 § 5): every action posts to a real API field.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, parseForm, type ActionResult } from "@/lib/action-result";
import { toMinor } from "@/lib/money";
import {
  createSpendLimit,
  createSpendLimitTier,
  createUsageAlert,
  deleteSpendLimit,
  deleteSpendLimitTier,
  deletePlanUsageThreshold,
  deleteSubscriptionUsageThreshold,
  deleteUsageAlert,
  previewRateChange,
  putPlanUsageThreshold,
  putSubscriptionUsageThreshold,
  saveAutoTopup,
  saveUsageWidgetOrigins,
  setAutoTopupEnabled,
  updateSpendLimit,
  type AutoTopupWrite,
  type RateChangePreview,
  type UsageAlertWrite,
} from "@/lib/api/usage-controls";
import type { AlertKind, AlertThreshold, LimitInterval } from "@/lib/usage-controls";

const MANAGE = "usage_controls:manage" as const;
const VIEW = "usage_controls:view" as const;

const ids = {
  biz: z.string().min(1, "The business ID is missing. Reload the page."),
};
const customerIds = {
  ...ids,
  cus: z.string().min(1, "The customer ID is missing. Reload the page."),
};

const intervals = z.enum(["day", "week", "month", "period"], { message: "Select an interval." });
const currency = z.string().trim().length(3, "Select a currency.");
/** A positive amount in major units, as typed. */
const majorAmount = (msg: string) =>
  z
    .string()
    .trim()
    .min(1, msg)
    .refine((v) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0, msg);

const usageControlsPath = (biz: string, cus: string) =>
  `/businesses/${biz}/customers/${cus}/usage-controls`;

function fail(
  res: { error?: string; param?: string; requestId?: string },
  fallback: string,
  fieldMap: Record<string, string> = {},
): ActionResult {
  const field = res.param
    ? (fieldMap[res.param] ?? fieldMap[res.param.split(".")[0]!] ?? res.param)
    : null;
  return actionError(res.error ?? fallback, {
    requestId: res.requestId,
    ...(field ? { errors: { [field]: res.error ?? fallback } } : {}),
  });
}

// ── Spend limits ───────────────────────────────────────────────────────────────

const limitSchema = z
  .object({
    ...customerIds,
    scope: z.enum(["customer", "subscription", "property"], { message: "Select what to limit." }),
    subscription: z.string().optional(),
    property_key: z.string().trim().max(100).optional(),
    property_value: z.string().trim().max(255).optional(),
    interval: intervals,
    amount: majorAmount("Enter an amount more than 0."),
    currency,
    mode: z.enum(["hard", "soft"], { message: "Select what happens at the limit." }),
  })
  .superRefine((v, ctx) => {
    if (v.scope === "subscription" && !v.subscription)
      ctx.addIssue({ code: "custom", path: ["subscription"], message: "Select a subscription." });
    if (v.scope === "property" && !v.property_key)
      ctx.addIssue({ code: "custom", path: ["property_key"], message: "Enter the property." });
  });

export async function createSpendLimitAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission(MANAGE, "manager");
  const parsed = parseForm(limitSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const res = await createSpendLimit(d.biz, d.cus, {
    scope: d.scope,
    ...(d.scope === "subscription" ? { subscription: d.subscription } : {}),
    ...(d.scope === "property"
      ? { property_key: d.property_key, property_value: d.property_value || null }
      : {}),
    interval: d.interval,
    amount_minor: toMinor(Number(d.amount), d.currency),
    currency: d.currency.toUpperCase(),
    mode: d.mode,
  });
  revalidatePath(usageControlsPath(d.biz, d.cus));
  if (!res.ok) return fail(res, "We could not save the limit.", { amount_minor: "amount" });
  return actionOk("Spend limit created.");
}

const limitEditSchema = z.object({
  ...customerIds,
  id: z.string().min(1, "The limit ID is missing. Reload the page."),
  amount: majorAmount("Enter an amount more than 0."),
  currency,
});

export async function updateSpendLimitAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission(MANAGE, "manager");
  const parsed = parseForm(limitEditSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const res = await updateSpendLimit(d.biz, d.cus, d.id, {
    amount_minor: toMinor(Number(d.amount), d.currency),
  });
  revalidatePath(usageControlsPath(d.biz, d.cus));
  if (!res.ok) return fail(res, "We could not save the limit.", { amount_minor: "amount" });
  return actionOk("Spend limit saved.");
}

const deleteSchema = z.object({
  ...ids,
  cus: z.string().optional(),
  id: z.string().min(1, "The ID is missing. Reload the page."),
});

export async function deleteSpendLimitAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission(MANAGE, "manager");
  const parsed = parseForm(deleteSchema, fd);
  if (parsed.error) return parsed.error;
  const { biz, cus, id } = parsed.data;
  if (!cus) return actionError("The customer ID is missing. Reload the page.");
  const res = await deleteSpendLimit(biz, cus, id);
  revalidatePath(usageControlsPath(biz, cus));
  if (!res.ok) return fail(res, "We could not delete the limit.");
  return actionOk("Spend limit deleted.");
}

// ── Limit tiers ────────────────────────────────────────────────────────────────

const optMajor = z
  .string()
  .trim()
  .optional()
  .refine((v) => !v || (/^\d+(\.\d+)?$/.test(v) && Number(v) > 0), "Enter an amount more than 0.");

const tierSchema = z
  .object({
    ...ids,
    currency,
    level: z
      .string()
      .trim()
      .min(1, "Enter the lifetime paid amount.")
      .refine((v) => /^\d+(\.\d+)?$/.test(v), "Enter an amount of 0 or more."),
    day: optMajor,
    week: optMajor,
    month: optMajor,
    period: optMajor,
  })
  .superRefine((v, ctx) => {
    if (!v.day && !v.week && !v.month && !v.period)
      ctx.addIssue({ code: "custom", path: ["month"], message: "Enter at least one limit." });
  });

export async function createSpendLimitTierAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission(MANAGE, "manager");
  const parsed = parseForm(tierSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const cur = d.currency.toUpperCase();
  const amounts: Partial<Record<LimitInterval, number>> = {};
  for (const k of ["day", "week", "month", "period"] as const)
    if (d[k]) amounts[k] = toMinor(Number(d[k]), cur);
  const res = await createSpendLimitTier(d.biz, {
    currency: cur,
    level_minor: toMinor(Number(d.level), cur),
    amounts,
  });
  revalidatePath(`/businesses/${d.biz}/settings/usage-controls`);
  if (!res.ok)
    return fail(res, "We could not save the limit tier.", {
      level_minor: "level",
      "amounts.day": "day",
      "amounts.week": "week",
      "amounts.month": "month",
      "amounts.period": "period",
    });
  return actionOk("Limit tier created.");
}

export async function deleteSpendLimitTierAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission(MANAGE, "manager");
  const parsed = parseForm(deleteSchema, fd);
  if (parsed.error) return parsed.error;
  const res = await deleteSpendLimitTier(parsed.data.biz, parsed.data.id);
  revalidatePath(`/businesses/${parsed.data.biz}/settings/usage-controls`);
  if (!res.ok) return fail(res, "We could not delete the limit tier.");
  return actionOk("Limit tier deleted.");
}

// ── Alerts ─────────────────────────────────────────────────────────────────────

/** Allowed threshold units per kind (design § 3.4). */
const UNITS_FOR: Record<AlertKind, AlertThreshold["unit"][]> = {
  usage_quantity: ["units", "percent"],
  spend: ["minor", "percent"],
  credit_balance: ["minor", "percent"],
  credit_runway: ["days"],
};

const alertSchema = z
  .object({
    ...ids,
    scope: z.enum(["customer", "plan"]),
    customer: z.string().optional(),
    product: z.string().optional(),
    kind: z.enum(["usage_quantity", "spend", "credit_balance", "credit_runway"], {
      message: "Select what to watch.",
    }),
    meter: z.string().optional(),
    interval: z.string().optional(),
    currency: z.string().optional(),
    threshold_unit: z.enum(["minor", "units", "percent", "days"], {
      message: "Select the threshold unit.",
    }),
    thresholds: z.string().trim().min(1, "Enter 1 to 10 thresholds."),
    email: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.scope === "customer" && !v.customer)
      ctx.addIssue({ code: "custom", path: ["customer"], message: "The customer is missing." });
    if (v.scope === "plan" && !v.product)
      ctx.addIssue({ code: "custom", path: ["product"], message: "Select a plan." });
    if (!UNITS_FOR[v.kind].includes(v.threshold_unit))
      ctx.addIssue({
        code: "custom",
        path: ["threshold_unit"],
        message: "This unit is not available for this kind of alert.",
      });
    if (v.kind === "usage_quantity" && !v.meter)
      ctx.addIssue({ code: "custom", path: ["meter"], message: "Select a meter." });
    if (
      (v.kind === "usage_quantity" || v.kind === "spend") &&
      !intervals.safeParse(v.interval).success
    )
      ctx.addIssue({ code: "custom", path: ["interval"], message: "Select an interval." });
    if (v.kind !== "usage_quantity" && !currency.safeParse(v.currency).success)
      ctx.addIssue({ code: "custom", path: ["currency"], message: "Select a currency." });
    const values = v.thresholds.split(/[,\s]+/).filter(Boolean);
    if (
      values.length < 1 ||
      values.length > 10 ||
      values.some((x) => !/^\d+(\.\d+)?$/.test(x) || Number(x) <= 0) ||
      new Set(values.map(Number)).size !== values.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["thresholds"],
        message: "Enter 1 to 10 different numbers more than 0, with commas between them.",
      });
  });

export async function createUsageAlertAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission(MANAGE, "manager");
  const parsed = parseForm(alertSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const cur = d.currency?.toUpperCase();
  const thresholds: AlertThreshold[] = d.thresholds
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((x) => ({
      unit: d.threshold_unit,
      value:
        d.threshold_unit === "minor"
          ? toMinor(Number(x), cur)
          : d.threshold_unit === "percent"
            ? Number(x)
            : Math.round(Number(x)),
    }));
  const body: UsageAlertWrite = {
    kind: d.kind,
    ...(d.scope === "customer" ? { customer: d.customer } : { product: d.product }),
    ...(d.kind === "usage_quantity" ? { meter: d.meter } : {}),
    ...(d.kind === "usage_quantity" || d.kind === "spend"
      ? { interval: d.interval as LimitInterval }
      : {}),
    ...(d.kind !== "usage_quantity" ? { currency: cur } : {}),
    thresholds,
    email: d.email === "on",
  };
  const res = await createUsageAlert(d.biz, body);
  if (d.customer) revalidatePath(usageControlsPath(d.biz, d.customer));
  revalidatePath(`/businesses/${d.biz}/settings/usage-controls`);
  if (!res.ok) return fail(res, "We could not save the alert.");
  return actionOk("Alert created.");
}

export async function deleteUsageAlertAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission(MANAGE, "manager");
  const parsed = parseForm(deleteSchema, fd);
  if (parsed.error) return parsed.error;
  const { biz, cus, id } = parsed.data;
  const res = await deleteUsageAlert(biz, id);
  if (cus) revalidatePath(usageControlsPath(biz, cus));
  revalidatePath(`/businesses/${biz}/settings/usage-controls`);
  if (!res.ok) return fail(res, "We could not delete the alert.");
  return actionOk("Alert deleted.");
}

// ── Automatic top-up ───────────────────────────────────────────────────────────

const topupSchema = z
  .object({
    ...customerIds,
    currency,
    trigger: z.enum(["threshold", "schedule"], { message: "Select when to top up." }),
    threshold: z.string().trim().optional(),
    schedule_every: z.string().optional(),
    weekday: z.string().optional(),
    month_day: z.string().optional(),
    method: z.enum(["fixed", "target"], { message: "Select how much to add." }),
    amount: z.string().trim().optional(),
    target: z.string().trim().optional(),
    monthly_cap: majorAmount("Enter a monthly limit more than 0."),
    max_runs_per_day: z.coerce
      .number({ message: "Enter a number from 1 to 10." })
      .int("Enter a whole number from 1 to 10.")
      .min(1, "Enter a number from 1 to 10.")
      .max(10, "Enter a number from 1 to 10."),
    payment_method: z.string().optional(),
    tax_treatment: z.enum(["taxed_at_purchase", "taxed_at_use"], {
      message: "Select a tax treatment.",
    }),
    priority: z.coerce
      .number({ message: "Enter a priority from 0 to 100." })
      .int("Enter a whole number from 0 to 100.")
      .min(0, "Enter a priority from 0 to 100.")
      .max(100, "Enter a priority from 0 to 100."),
    expires_after_months: z.string().trim().optional(),
  })
  .superRefine((v, ctx) => {
    const pos = (x?: string) => !!x && /^\d+(\.\d+)?$/.test(x) && Number(x) > 0;
    if (v.trigger === "threshold" && !(v.threshold && /^\d+(\.\d+)?$/.test(v.threshold)))
      ctx.addIssue({
        code: "custom",
        path: ["threshold"],
        message: "Enter a balance of 0 or more.",
      });
    if (v.trigger === "schedule") {
      if (v.schedule_every !== "week" && v.schedule_every !== "month")
        ctx.addIssue({
          code: "custom",
          path: ["schedule_every"],
          message: "Select weekly or monthly.",
        });
      if (v.schedule_every === "week" && !/^[1-7]$/.test(v.weekday ?? ""))
        ctx.addIssue({ code: "custom", path: ["weekday"], message: "Select a day of the week." });
      if (
        v.schedule_every === "month" &&
        !(
          /^\d{1,2}$/.test(v.month_day ?? "") &&
          Number(v.month_day) >= 1 &&
          Number(v.month_day) <= 31
        )
      )
        ctx.addIssue({ code: "custom", path: ["month_day"], message: "Enter a day from 1 to 31." });
    }
    if (v.method === "fixed" && !pos(v.amount))
      ctx.addIssue({ code: "custom", path: ["amount"], message: "Enter an amount more than 0." });
    if (v.method === "target" && !pos(v.target))
      ctx.addIssue({ code: "custom", path: ["target"], message: "Enter a balance more than 0." });
    if (
      v.expires_after_months &&
      !(
        /^\d{1,3}$/.test(v.expires_after_months) &&
        Number(v.expires_after_months) >= 1 &&
        Number(v.expires_after_months) <= 120
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["expires_after_months"],
        message: "Enter 1 to 120 months, or leave it empty.",
      });
  });

const TOPUP_FIELDS: Record<string, string> = {
  threshold_minor: "threshold",
  amount_minor: "amount",
  target_minor: "target",
  monthly_cap_minor: "monthly_cap",
  payment_method: "payment_method",
  "grant.tax_treatment": "tax_treatment",
};

export async function saveAutoTopupAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission(MANAGE, "manager");
  const parsed = parseForm(topupSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const cur = d.currency.toUpperCase();
  const m = (x: string) => toMinor(Number(x), cur);
  const body: AutoTopupWrite = {
    currency: cur,
    trigger: d.trigger,
    ...(d.trigger === "threshold"
      ? { threshold_minor: m(d.threshold!) }
      : {
          schedule:
            d.schedule_every === "week"
              ? { every: "week", weekday: Number(d.weekday) }
              : { every: "month", day: Number(d.month_day) },
        }),
    method: d.method,
    ...(d.method === "fixed" ? { amount_minor: m(d.amount!) } : { target_minor: m(d.target!) }),
    monthly_cap_minor: m(d.monthly_cap),
    max_runs_per_day: d.max_runs_per_day,
    payment_method: d.payment_method || null,
    grant: {
      tax_treatment: d.tax_treatment,
      priority: d.priority,
      expires_after_months: d.expires_after_months ? Number(d.expires_after_months) : null,
    },
  };
  const res = await saveAutoTopup(d.biz, d.cus, body);
  revalidatePath(usageControlsPath(d.biz, d.cus));
  if (!res.ok) return fail(res, "We could not save automatic top-up.", TOPUP_FIELDS);
  const saved = res.data as { lead_time?: { warning: string | null } } | undefined;
  return saved?.lead_time?.warning
    ? { ok: true, warning: true, message: `Automatic top-up saved. ${saved.lead_time.warning}` }
    : actionOk("Automatic top-up saved.");
}

const toggleSchema = z.object({
  ...customerIds,
  currency,
  on: z.enum(["true", "false"]),
});

export async function setAutoTopupEnabledAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission(MANAGE, "manager");
  const parsed = parseForm(toggleSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const on = d.on === "true";
  const res = await setAutoTopupEnabled(d.biz, d.cus, d.currency.toUpperCase(), on);
  revalidatePath(usageControlsPath(d.biz, d.cus));
  if (!res.ok)
    return fail(
      res,
      on ? "We could not turn on automatic top-up." : "We could not turn off automatic top-up.",
    );
  return actionOk(on ? "Automatic top-up turned on." : "Automatic top-up turned off.");
}

// ── Threshold invoicing ────────────────────────────────────────────────────────

const thresholdSchema = z
  .object({
    ...ids,
    product: z.string().optional(),
    subscription: z.string().optional(),
    currency,
    /** on = invoice early, off = (subscription only) turn it off for this subscription. */
    enabled: z.enum(["on", "off"]),
    amount: z.string().trim().optional(),
    return_to: z.string().startsWith("/businesses/", "The page is missing. Reload the page."),
  })
  .superRefine((v, ctx) => {
    if (!v.product && !v.subscription)
      ctx.addIssue({ code: "custom", path: ["product"], message: "The plan is missing." });
    if (v.enabled === "on" && !(v.amount && /^\d+(\.\d+)?$/.test(v.amount) && Number(v.amount) > 0))
      ctx.addIssue({ code: "custom", path: ["amount"], message: "Enter an amount more than 0." });
  });

export async function saveUsageInvoiceThresholdAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission(MANAGE, "manager");
  const parsed = parseForm(thresholdSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const cur = d.currency.toUpperCase();
  const amount = d.enabled === "on" ? toMinor(Number(d.amount), cur) : null;
  const res = d.subscription
    ? await putSubscriptionUsageThreshold(d.biz, d.subscription, amount)
    : await putPlanUsageThreshold(d.biz, d.product!, cur, amount!);
  revalidatePath(d.return_to);
  if (!res.ok) return fail(res, "We could not save the setting.", { amount_minor: "amount" });
  return actionOk("Setting saved.");
}

const thresholdDeleteSchema = z.object({
  ...ids,
  product: z.string().optional(),
  subscription: z.string().optional(),
  currency: z.string().optional(),
  return_to: z.string().startsWith("/businesses/", "The page is missing. Reload the page."),
});

export async function removeUsageInvoiceThresholdAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission(MANAGE, "manager");
  const parsed = parseForm(thresholdDeleteSchema, fd);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const res = d.subscription
    ? await deleteSubscriptionUsageThreshold(d.biz, d.subscription)
    : await deletePlanUsageThreshold(d.biz, d.product ?? "", (d.currency ?? "").toUpperCase());
  revalidatePath(d.return_to);
  if (!res.ok) return fail(res, "We could not remove the setting.");
  return actionOk(d.subscription ? "Override removed." : "Setting removed.");
}

// ── Rate-change preview (a read) ───────────────────────────────────────────────

const previewSchema = z.object({
  ...ids,
  price: z.string().min(1, "The price ID is missing. Reload the page."),
  draft: z.string().min(2, "Change at least one rate.").max(200_000),
  starting_after: z.string().optional(),
});

export async function previewRateChangeAction(
  fd: FormData,
): Promise<{ ok: true; data: RateChangePreview } | { ok: false; message: string; field?: string }> {
  await requirePermission(VIEW, "manager");
  const parsed = parseForm(previewSchema, fd);
  if (parsed.error) return { ok: false, message: parsed.error.message ?? "Correct the rates." };
  const d = parsed.data;
  let draft: Record<string, unknown>;
  try {
    draft = JSON.parse(d.draft) as Record<string, unknown>;
  } catch {
    return { ok: false, message: "We could not read the rates. Reload the page." };
  }
  const res = await previewRateChange(d.biz, d.price, {
    ...draft,
    ...(d.starting_after ? { starting_after: d.starting_after } : {}),
  });
  if (!res.ok)
    return {
      ok: false,
      message: res.error ?? "We could not preview the change.",
      field: res.param,
    };
  return { ok: true, data: res.data as RateChangePreview };
}

// ── Usage widget origins ───────────────────────────────────────────────────────

const originsSchema = z.object({
  ...ids,
  origins: z.string().max(10_000),
});

export async function saveUsageWidgetOriginsAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission(MANAGE, "manager");
  const parsed = parseForm(originsSchema, fd);
  if (parsed.error) return parsed.error;
  const origins = parsed.data.origins
    .split(/[\s,]+/)
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.length > 20)
    return actionError("Correct the highlighted fields.", {
      errors: { origins: "Enter 20 origins or fewer." },
    });
  const res = await saveUsageWidgetOrigins(parsed.data.biz, origins);
  revalidatePath(`/businesses/${parsed.data.biz}/settings/usage-controls`);
  if (!res.ok) return fail(res, "We could not save the origins.", { origins: "origins" });
  return actionOk("Origins saved.");
}
