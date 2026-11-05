import { z } from "zod";
import { CADENCE_LIMITS } from "@/modules/subscriptions/adaptive-schedule";
import {
  BANK_DEBIT_MAX_RETRIES,
  FINAL_SUBSCRIPTION_ACTIONS,
} from "@/modules/subscriptions/dunning-schedule";

const retryList = z.array(z.object({ after_days: z.number().int().min(1).max(90) })).min(1);
const cadenceList = (lim: { min: number; max: number }) =>
  z.array(z.number().int().min(lim.min).max(lim.max)).min(1).max(CADENCE_LIMITS.maxSteps);

/**
 * Structured dunning config (E3): retries + final action on exhaustion. Shared by
 * `PATCH business.dunning_config` and the named dunning policies (0386).
 */
export const dunningConfigObject = z.object({
  retries: z
    .array(z.object({ after_days: z.number().int().min(1).max(90) }))
    .min(1)
    .max(8)
    .optional(),
  final_action: z
    .object({
      // The four: Mark as Not Paid · Mark as Voided · Write-off · Reverse.
      invoice: z.enum(["not_paid", "void", "write_off", "reverse"]),
      // 2.17: cancel now · cancel at term end · pause · keep, stop charging · keep billing.
      subscription: z.enum(FINAL_SUBSCRIPTION_ACTIONS),
    })
    .optional(),
  // 2.48: a schedule per instrument kind; an absent kind uses `retries`.
  retries_by_method: z
    .object({
      card: retryList.max(8).optional(),
      // Inside every debit scheme's limits; network caps and spacing still apply on top.
      bank_debit: retryList.max(BANK_DEBIT_MAX_RETRIES).optional(),
      offline: retryList.max(8).optional(),
    })
    .optional(),
  // 2.59: smart mode's adaptive cadences; an absent key keeps its coded value.
  adaptive_cadence: z
    .object({
      transient_hours: cadenceList(CADENCE_LIMITS.transientHours).optional(),
      generic_days: cadenceList(CADENCE_LIMITS.genericDays).optional(),
      // Null = the next likely payday (1st, 15th or last day of the month).
      funds_gap_days: z
        .number()
        .int()
        .min(CADENCE_LIMITS.fundsGapDays.min)
        .max(CADENCE_LIMITS.fundsGapDays.max)
        .nullable()
        .optional(),
      funds_max_retries: z
        .number()
        .int()
        .min(CADENCE_LIMITS.fundsMaxRetries.min)
        .max(CADENCE_LIMITS.fundsMaxRetries.max)
        .optional(),
    })
    .optional(),
  // 2.48: plan product id → dpol_…; a customer's own policy still wins. Business-wide.
  plan_policies: z.record(z.string().min(1).max(100), z.string().regex(/^dpol_/)).optional(),
  // Billing LogIQ: auto-collect open dues when a payment method is added (default on).
  collect_on_payment_method_update: z.boolean().optional(),
  /**
   * Whether a reactivation requires its charge to SUCCEED (default: inherits
   * `collect_on_payment_method_update`, which is what it used to be part of).
   * Split out 2026-09-07.
   */
  require_successful_charge_on_reactivation: z.boolean().optional(),
  // A hard decline ends dunning (default on) vs the schedule applying regardless.
  skip_retries_for_hard_failures: z.boolean().optional(),
  // Master "Dunning" switch (default on).
  enabled: z.boolean().optional(),
  // "Dunning period": days after the invoice due date at whose end the
  // final action applies. Null = no deadline; the retry schedule alone decides.
  dunning_period_days: z.number().int().min(1).max(365).nullable().optional(),
  // The two dunning scope toggles.
  dun_trial_and_future_subscriptions: z.boolean().optional(),
  dun_one_time_invoices: z.boolean().optional(),
  // Dun AUTO-COLLECT-OFF (send-invoice) invoices: they stay `payment_due` +
  // `dunning_status: in_progress` from the moment they are raised and the customer is
  // reminded on each offset — no charge is attempted and no attempt is counted.
  //
  // ⚠ DEFAULT TRUE since 2026-08-31: an `auto_collection: off` unpaid invoice carries
  // `dunning_status: in_progress` and a `next_retry_at`, exactly like an online one.
  // Omitting the key now means ON; send `false` to opt out.
  //
  // `dunning_period_days` is no longer required for it to DO anything — it decides
  // only whether the window ever CLOSES (offline invoices have no retries to run out,
  // so with no period the reminders continue and no final action ever applies).
  dun_offline_invoices: z.boolean().optional(),
  /**
   * Dunning mode. `fixed` = the merchant's own retry offsets, hardness as a
   * boolean. `smart` = decline-code aware (soft retries, hard-recoverable parks,
   * unrecoverable terminates).
   *
   * ⚠️ ACCEPTED HERE BECAUSE IT HAS TO BE, not only so it can be set. The column is
   * assigned WHOLE (`dunningConfig: d.dunning_config`, below) and this object
   * strips what it does not declare, so while `mode` was absent every settings
   * save silently rewrote a smart business back to fixed — no error, no audit
   * trail. A field the engine honours must be expressible here or it cannot
   * survive its own settings screen.
   */
  mode: z.enum(["fixed", "smart"]).optional(),
  // No payment method at renewal: `cancel` overrides a `retain` final action for that case.
  no_payment_method_at_renewal: z.enum(["follow_final_action", "cancel"]).optional(),
  // Smart mode's adaptive retry timing (`adaptive-schedule.ts`). Off unless true.
  adaptive_timing: z.boolean().optional(),
  // Park hard-recoverable declines instead of retrying them. Off unless true.
  park_hard_declines: z.boolean().optional(),
  // Per-currency minimum still owed (minor units) before dunning chases an invoice.
  minimum_amounts: z
    .record(
      z.string().regex(/^[A-Z]{3}$/, "Use an upper-case three-letter currency code."),
      z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    )
    .optional(),
});

/** The per-invoice keys a named dunning policy owns (`DUNNING_POLICY_KEYS`). */
export const dunningPolicyConfigObject = dunningConfigObject.pick({
  enabled: true,
  mode: true,
  retries: true,
  final_action: true,
  dunning_period_days: true,
  skip_retries_for_hard_failures: true,
  park_hard_declines: true,
  adaptive_timing: true,
  minimum_amounts: true,
  dun_offline_invoices: true,
  dun_one_time_invoices: true,
  dun_trial_and_future_subscriptions: true,
  retries_by_method: true,
  adaptive_cadence: true,
});
