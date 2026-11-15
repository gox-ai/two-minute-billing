/**
 * `businesses.credit_config` and `customers.credit_settings` (0464) as the API takes them.
 * Absent keys take the defaults in `policy.ts`; a PATCH replaces the object whole, null clears it.
 */
import { z } from "zod";
import {
  AUTO_TOPUP_ON_HARD_DECLINE,
  CAPTURE_OVER_HOLD,
  IN_FLIGHT_APPLIES,
  NO_SUBSCRIPTION_OVERDRAFT,
  NO_SUBSCRIPTION_USAGE,
  TRIAL_USAGE,
  type BusinessCreditConfig,
  type CustomerCreditSettings,
} from "@db/schema";
import { MAX_HOLD_SECONDS, NO_SUBSCRIPTION_INVOICE_DAYS, RESTORE_EXPIRY_MONTHS } from "./policy";
import { MAX_LATE_EVENT_GRACE_HOURS } from "./credit-cost";
import { topupRetryHoursIssue } from "@/modules/usage-controls/auto-topup-amount";

const currency = z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter ISO currency code in capitals");
const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// Retry delays of an automatic top-up: whole hours, at most 4 of them, 72 hours in total.
const retryHours = z.array(z.number()).superRefine((v, ctx) => {
  const issue = topupRetryHoursIssue(v);
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
});

export const businessCreditConfigSchema = z
  .object({
    hold_default_seconds: z.number().int().min(1).max(MAX_HOLD_SECONDS).optional(),
    in_flight_share_bps: z.number().int().min(1).max(10_000).optional(),
    in_flight_applies: z.enum(IN_FLIGHT_APPLIES).optional(),
    blocking_enabled: z.boolean().optional(),
    portal_auto_topup: z.boolean().optional(),
    auto_topup_retries: z.boolean().optional(),
    auto_topup_retry_hours: retryHours.optional(),
    auto_topup_retry_hours_by_method: z
      .object({ card: retryHours.optional(), bank_debit: retryHours.optional() })
      .strict()
      .optional(),
    on_exhausted_default: z.enum(["block", "bill"]).optional(),
    overdraft_limit_minor: z.record(currency, minor).optional(),
    top_up_limits: z
      .record(
        currency,
        z
          .object({
            min_minor: minor.nullable().optional(),
            max_minor: minor.nullable().optional(),
          })
          .strict()
          .refine((l) => l.min_minor == null || l.max_minor == null || l.min_minor <= l.max_minor, {
            message: "min_minor must not be more than max_minor",
          }),
      )
      .optional(),
    // Free grants: refused above `max_minor`; audited and alerted above `alert_above_minor`.
    grant_limits: z
      .record(
        currency,
        z
          .object({
            max_minor: minor.nullable().optional(),
            alert_above_minor: minor.nullable().optional(),
          })
          .strict(),
      )
      .optional(),
    // The same limits for a unit with no rate, per unit key, in the unit's smallest step.
    unit_grant_limits: z
      .record(
        z.string().min(1).max(100),
        z
          .object({
            max_units: minor.nullable().optional(),
            alert_above_units: minor.nullable().optional(),
          })
          .strict(),
      )
      .optional(),
    default_tax_treatment: z.enum(["taxed_at_purchase", "taxed_at_use"]).nullable().optional(),
    // Credit scope (2.55): grants scoped to all usage pay only these prices or meters.
    credit_scope: z
      .union([
        z
          .object({
            kind: z.literal("prices"),
            prices: z.array(z.string().min(1).max(100)).min(1).max(100),
          })
          .strict(),
        z
          .object({
            kind: z.literal("meters"),
            meters: z.array(z.string().min(1).max(100)).min(1).max(100),
          })
          .strict(),
      ])
      .nullable()
      .optional(),
    // Usage paid in credits: the grace window for a late event. Absent = 12 hours.
    late_event_grace_hours: z.number().min(0).max(MAX_LATE_EVENT_GRACE_HOURS).optional(),
    // Engine choices; each absent key keeps the rule from before it (`resolveCreditEngineRules`).
    trial_usage: z.enum(TRIAL_USAGE).optional(),
    no_subscription_usage: z.enum(NO_SUBSCRIPTION_USAGE).optional(),
    no_subscription_overdraft: z.enum(NO_SUBSCRIPTION_OVERDRAFT).optional(),
    no_subscription_invoice_after_days: z
      .number()
      .int()
      .min(NO_SUBSCRIPTION_INVOICE_DAYS.min)
      .max(NO_SUBSCRIPTION_INVOICE_DAYS.max)
      .optional(),
    restore_expiry_months: z
      .union([
        z.number().int().min(RESTORE_EXPIRY_MONTHS.min).max(RESTORE_EXPIRY_MONTHS.max),
        z.literal("never"),
      ])
      .optional(),
    auto_topup_on_hard_decline: z.enum(AUTO_TOPUP_ON_HARD_DECLINE).optional(),
    capture_over_hold: z.enum(CAPTURE_OVER_HOLD).optional(),
  })
  .strict();

/** Engine-choice keys that a PATCH which omits them keeps (`keepInFlightApplies`). */
export const KEPT_ENGINE_KEYS = [
  "trial_usage",
  "no_subscription_usage",
  "no_subscription_overdraft",
  "no_subscription_invoice_after_days",
  "restore_expiry_months",
  "auto_topup_on_hard_decline",
  "capture_over_hold",
] as const;

export const customerCreditSettingsSchema = z
  .object({
    on_exhausted: z.enum(["block", "bill"]).nullable().optional(),
    overdraft_limit_minor: z.record(currency, minor).optional(),
    override_expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();

/** Drop null limit bounds so the stored shape matches `BusinessCreditConfig`. */
export function toBusinessCreditConfig(
  v: z.infer<typeof businessCreditConfigSchema> | null,
): BusinessCreditConfig | null {
  if (!v) return null;
  const { top_up_limits, grant_limits, unit_grant_limits, ...rest } = v;
  return {
    ...rest,
    ...(unit_grant_limits
      ? {
          unit_grant_limits: Object.fromEntries(
            Object.entries(unit_grant_limits).map(([unit, l]) => [
              unit,
              {
                ...(l.max_units != null ? { max_units: l.max_units } : {}),
                ...(l.alert_above_units != null ? { alert_above_units: l.alert_above_units } : {}),
              },
            ]),
          ),
        }
      : {}),
    ...(grant_limits
      ? {
          grant_limits: Object.fromEntries(
            Object.entries(grant_limits).map(([cur, l]) => [
              cur,
              {
                ...(l.max_minor != null ? { max_minor: l.max_minor } : {}),
                ...(l.alert_above_minor != null ? { alert_above_minor: l.alert_above_minor } : {}),
              },
            ]),
          ),
        }
      : {}),
    ...(top_up_limits
      ? {
          top_up_limits: Object.fromEntries(
            Object.entries(top_up_limits).map(([cur, l]) => [
              cur,
              {
                ...(l.min_minor != null ? { min_minor: l.min_minor } : {}),
                ...(l.max_minor != null ? { max_minor: l.max_minor } : {}),
              },
            ]),
          ),
        }
      : {}),
  };
}

export function toCustomerCreditSettings(
  v: z.infer<typeof customerCreditSettingsSchema> | null,
): CustomerCreditSettings | null {
  return v ? { ...v } : null;
}

/**
 * Written when a person creates a business: the hold share guards parallel holds only.
 * A key, and every business from before this key, keeps the share on every hold.
 */
export function initialCreditConfig(creator: {
  hasOperator?: boolean;
}): BusinessCreditConfig | undefined {
  return creator.hasOperator === true ? { in_flight_applies: "other_holds_open" } : undefined;
}

/**
 * A PATCH replaces `credit_config` whole. `in_flight_applies`, `late_event_grace_hours` and
 * `unit_grant_limits` are the keys an omission keeps, so a caller that does not know them cannot move a business back.
 */
export function keepInFlightApplies(
  next: BusinessCreditConfig | null,
  stored: BusinessCreditConfig | null | undefined,
): BusinessCreditConfig | null {
  if (!next) return next;
  let out = next;
  if (out.in_flight_applies === undefined && stored?.in_flight_applies)
    out = { ...out, in_flight_applies: stored.in_flight_applies };
  // The same for the late-event grace window: an omission keeps what the business set.
  if (out.late_event_grace_hours === undefined && stored?.late_event_grace_hours !== undefined)
    out = { ...out, late_event_grace_hours: stored.late_event_grace_hours };
  // And the buyer's switch for automatic top-up: a caller that does not know it keeps it.
  if (out.portal_auto_topup === undefined && stored?.portal_auto_topup !== undefined)
    out = { ...out, portal_auto_topup: stored.portal_auto_topup };
  // And the limits per unit: the dashboard form does not send them yet. `{}` removes them.
  if (out.unit_grant_limits === undefined && stored?.unit_grant_limits !== undefined)
    out = { ...out, unit_grant_limits: stored.unit_grant_limits };
  // And the top-up retry keys (0530): no dashboard form sends them yet.
  // And the engine choices: a caller that does not know a key keeps it.
  for (const k of [
    "auto_topup_retries",
    "auto_topup_retry_hours",
    "auto_topup_retry_hours_by_method",
    ...KEPT_ENGINE_KEYS,
  ] as const)
    if (out[k] === undefined && stored?.[k] !== undefined) out = { ...out, [k]: stored[k] };
  return out;
}
