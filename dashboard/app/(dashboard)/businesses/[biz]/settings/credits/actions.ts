"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";
import { updateCreditConfig } from "@/lib/api/credits";
import {
  AUTO_TOPUP_ON_HARD_DECLINE,
  CAPTURE_OVER_HOLD,
  IN_FLIGHT_APPLIES,
  LATE_EVENT_GRACE_MAX,
  NO_SUBSCRIPTION_INVOICE_DAYS as INVOICE_DAYS,
  NO_SUBSCRIPTION_OVERDRAFT,
  NO_SUBSCRIPTION_USAGE,
  RESTORE_EXPIRY_MONTHS as RESTORE,
  TRIAL_USAGE,
} from "@/lib/credits";
import { unitGrantLimitsBody } from "@/lib/unit-grant-limits";
import { topupRetryBody, type TopupRetryStored } from "@/lib/topup-retry";

const minor = z.number().int().min(0);
const currencyMap = <T extends z.ZodType>(v: T) => z.record(z.string().regex(/^[A-Z]{3}$/), v);

// "never", or whole months in the API's range. One message for every wrong value.
const restoreMonths = z.unknown().transform((v, ctx): number | "never" => {
  if (v === "never") return v;
  if (typeof v === "number" && Number.isInteger(v) && v >= RESTORE.min && v <= RESTORE.max)
    return v;
  ctx.addIssue({ code: "custom", message: `Enter ${RESTORE.min} to ${RESTORE.max} whole months.` });
  return z.NEVER;
});

const configSchema = z
  .object({
    hold_default_seconds: z
      .number({ message: "Enter the hold time in seconds." })
      .int("Enter whole seconds.")
      .min(1, "Enter 1 second or more.")
      .max(86_400, "Enter 86,400 seconds (24 hours) or fewer."),
    in_flight_share_bps: z
      .number({ message: "Enter a percentage." })
      .int()
      .min(1, "Enter a percentage from 0.01 to 100.")
      .max(10_000, "Enter a percentage from 0.01 to 100."),
    in_flight_applies: z.enum(IN_FLIGHT_APPLIES),
    blocking_enabled: z.boolean(),
    portal_auto_topup: z.boolean(),
    late_event_grace_hours: z
      .number({ message: "Enter a number of hours." })
      .min(0, `Enter 0 to ${LATE_EVENT_GRACE_MAX} hours.`)
      .max(LATE_EVENT_GRACE_MAX, `Enter 0 to ${LATE_EVENT_GRACE_MAX} hours.`),
    on_exhausted_default: z.enum(["block", "bill"]),
    trial_usage: z.enum(TRIAL_USAGE),
    no_subscription_usage: z.enum(NO_SUBSCRIPTION_USAGE),
    no_subscription_overdraft: z.enum(NO_SUBSCRIPTION_OVERDRAFT),
    no_subscription_invoice_after_days: z
      .number({ message: "Enter a number of days." })
      .int("Enter whole days.")
      .min(INVOICE_DAYS.min, `Enter ${INVOICE_DAYS.min} to ${INVOICE_DAYS.max} days.`)
      .max(INVOICE_DAYS.max, `Enter ${INVOICE_DAYS.min} to ${INVOICE_DAYS.max} days.`),
    restore_expiry_months: restoreMonths,
    auto_topup_on_hard_decline: z.enum(AUTO_TOPUP_ON_HARD_DECLINE),
    capture_over_hold: z.enum(CAPTURE_OVER_HOLD),
    overdraft_limit_minor: currencyMap(minor),
    top_up_limits: currencyMap(
      z.object({ min_minor: minor.nullable().optional(), max_minor: minor.nullable().optional() }),
    ),
    grant_limits: currencyMap(
      z.object({
        max_minor: minor.nullable().optional(),
        alert_above_minor: minor.nullable().optional(),
      }),
    ),
    // The stored limits per unit with no money value. The typed fields (`unit_limits`) are
    // set over them. Left out when the business has no such unit: the API then keeps its value.
    unit_grant_limits: z
      .record(
        z.string().min(1).max(100),
        z.object({
          max_units: minor.nullable().optional(),
          alert_above_units: minor.nullable().optional(),
        }),
      )
      .optional(),
    default_tax_treatment: z.enum(["taxed_at_purchase", "taxed_at_use"]).nullable(),
    credit_scope: z
      .union([
        z.object({ kind: z.literal("meters"), meters: z.array(z.string()) }),
        z.object({ kind: z.literal("prices"), prices: z.array(z.string()).min(1) }),
      ])
      .nullable(),
  })
  .superRefine((c, ctx) => {
    if (c.credit_scope?.kind === "meters" && c.credit_scope.meters.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["credit_scope"],
        message: "Select one or more meters, or select every usage line.",
      });
    for (const [cur, l] of Object.entries(c.top_up_limits))
      if (l.min_minor != null && l.max_minor != null && l.min_minor > l.max_minor)
        ctx.addIssue({
          code: "custom",
          path: [`top_up_${cur}`],
          message: `The minimum for ${cur} must not be more than the maximum.`,
        });
  });

/** The limit fields of the units with no money value, as typed. */
const unitLimitsSchema = z
  .array(
    z.object({
      unit: z.string().min(1).max(100),
      plural: z.string().max(200),
      decimals: z.number().int().min(0).max(4),
      max: z.string().max(40),
      alert: z.string().max(40),
    }),
  )
  .max(500);

/** The retry fields as typed, and the saved values they are compared with. */
const hoursList = z.array(z.number()).max(20);
const retrySchema = z.object({
  draft: z.object({
    enabled: z.boolean(),
    hours: z.array(z.string().max(40)).max(20),
    card: z.string().max(200),
    bank_debit: z.string().max(200),
  }),
  saved: z.object({
    auto_topup_retries: z.boolean(),
    auto_topup_retry_hours: hoursList,
    auto_topup_retry_hours_by_method: z.object({
      card: hoursList.optional(),
      bank_debit: hoursList.optional(),
    }),
  }),
});

/** Settings → Credits: writes `businesses.credit_config` whole. */
export async function saveCreditConfigAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  await requirePermission("credits:manage", "ops");
  const biz = String(fd.get("biz") ?? "");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  let raw: unknown;
  try {
    raw = JSON.parse(String(fd.get("config") ?? ""));
  } catch {
    return actionError("We could not read the settings. Reload the page.");
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const i of parsed.error.issues) {
      const key = String(i.path[0] ?? "_form");
      errors[key] ??= i.message;
    }
    return actionError("Correct the highlighted fields.", { errors });
  }
  let config: z.infer<typeof configSchema> & TopupRetryStored = parsed.data;
  // The retry schedule: only the keys that changed are sent, so an unset key stays unset.
  const retryRaw = fd.get("topup_retries");
  if (retryRaw != null) {
    let retry;
    try {
      retry = retrySchema.safeParse(JSON.parse(String(retryRaw)));
    } catch {
      retry = null;
    }
    if (!retry?.success) return actionError("We could not read the settings. Reload the page.");
    const body = topupRetryBody(retry.data.draft, retry.data.saved);
    if (!body.ok) return actionError("Correct the highlighted fields.", { errors: body.errors });
    config = { ...config, ...body.value };
  }
  const typed = fd.get("unit_limits");
  if (typed != null) {
    let drafts;
    try {
      drafts = unitLimitsSchema.safeParse(JSON.parse(String(typed)));
    } catch {
      drafts = null;
    }
    if (!drafts?.success) return actionError("We could not read the settings. Reload the page.");
    const limits = unitGrantLimitsBody(drafts.data, config.unit_grant_limits ?? {});
    if (!limits.ok)
      return actionError("Correct the highlighted fields.", { errors: limits.errors });
    config = { ...config, unit_grant_limits: limits.value };
  }
  const version = Number(fd.get("expected_version") ?? "") || undefined;
  const res = await updateCreditConfig(biz, config, version);
  revalidatePath(`/businesses/${biz}/settings/credits`);
  revalidatePath(`/businesses/${biz}/settings`);
  if (!res.ok)
    return actionError(res.error ?? "We could not save the credit settings.", {
      requestId: res.requestId,
      ...(res.status === 409 ? { code: "conflict" as const } : {}),
    });
  return actionOk("Credit settings saved.");
}
