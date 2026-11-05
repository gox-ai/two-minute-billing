// Server-side parsing of the `DunningFields` form, shared by the business dunning save
// and the named-policy saves so both read the form identically. Plain module: a
// "use server" file may export only async actions.
import { actionError, type ActionResult } from "@/lib/action-result";
import { toMinor } from "@/lib/money";
import type { DunningPolicyConfig } from "@/lib/api/dunning-policies";
import { BANK_DEBIT_MAX_RETRIES, DEFAULT_CADENCE, SUBSCRIPTION_OPTIONS } from "./copy";

/** "1, 3, 5" → numbers; null when a value is not a whole number in range. */
function dayList(raw: string, min: number, max: number): number[] | null {
  const parts = raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
  const nums = parts.map(Number);
  return nums.every((n) => Number.isInteger(n) && n >= min && n <= max) ? nums : null;
}

const same = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export interface ParsedDunningForm {
  /** The per-invoice keys, as a policy stores them. `retries` absent = engine default. */
  perInvoice: DunningPolicyConfig & {
    mode: "fixed" | "smart";
    final_action: NonNullable<DunningPolicyConfig["final_action"]>;
  };
  /** The posted schedule; empty = use the engine default. */
  days: number[];
  /** The business-wide switches (rendered only on the business page). */
  collectOnPm: boolean;
  cancelNoPmAtRenewal: boolean;
}

export function parseDunningForm(
  fd: FormData,
): { data: ParsedDunningForm } | { error: ActionResult } {
  const str = (k: string) => String(fd.get(k) ?? "").trim();

  // Repeated `retry_days` inputs from the schedule editor.
  const days = fd
    .getAll("retry_days")
    .map((v) => String(v).trim())
    .filter((v) => v !== "")
    .map(Number);
  if (days.some((n) => !Number.isInteger(n) || n < 1 || n > 90))
    return { error: actionError("Enter each retry as a whole number of days from 1 to 90.") };
  if (days.length > 8) return { error: actionError("Enter 8 retries or fewer.") };

  const inv = str("final_invoice_action");
  const sub = str("final_subscription_action");
  if (inv !== "not_paid" && inv !== "void" && inv !== "write_off" && inv !== "reverse")
    return { error: actionError("Select a final invoice action.") };
  const subAction = SUBSCRIPTION_OPTIONS.find((o) => o.value === sub)?.value;
  if (!subAction) return { error: actionError("Select a final subscription action.") };

  // Per payment method schedules (2.48). Blank = the main schedule.
  const byMethod: NonNullable<DunningPolicyConfig["retries_by_method"]> = {};
  for (const [kind, max, label] of [
    ["card", 8, "cards"],
    ["bank_debit", BANK_DEBIT_MAX_RETRIES, "bank debits"],
    ["offline", 8, "offline invoices"],
  ] as const) {
    const raw = str(`method_days_${kind}`);
    if (!raw) continue;
    const list = dayList(raw, 1, 90);
    if (!list || list.length === 0)
      return {
        error: actionError(
          `Enter the days for ${label} as whole numbers from 1 to 90, with commas between them.`,
        ),
      };
    if (list.length > max)
      return { error: actionError(`Enter ${max} retries or fewer for ${label}.`) };
    byMethod[kind] = list.map((after_days) => ({ after_days }));
  }

  // Adaptive cadence (2.59). Only values that differ from the defaults are stored.
  const cadence: NonNullable<DunningPolicyConfig["adaptive_cadence"]> = {};
  const transient = dayList(str("cadence_transient_hours"), 1, 168);
  if (!transient || transient.length < 1 || transient.length > 5)
    return {
      error: actionError(
        "Enter 1 to 5 retry times for gateway or network faults, in hours from 1 to 168.",
      ),
    };
  if (!same(transient, DEFAULT_CADENCE.transientHours)) cadence.transient_hours = transient;
  const generic = dayList(str("cadence_generic_days"), 1, 14);
  if (!generic || generic.length < 1 || generic.length > 5)
    return {
      error: actionError("Enter 1 to 5 retries for generic declines, in days from 1 to 14."),
    };
  if (!same(generic, DEFAULT_CADENCE.genericDays)) cadence.generic_days = generic;
  if (str("cadence_funds_mode") === "days") {
    const gap = Number(str("cadence_funds_gap_days"));
    if (!Number.isInteger(gap) || gap < 1 || gap > 14)
      return {
        error: actionError("Enter the insufficient-funds interval in days, from 1 to 14."),
      };
    cadence.funds_gap_days = gap;
  }
  const fundsMax = Number(str("cadence_funds_max_retries"));
  if (!Number.isInteger(fundsMax) || fundsMax < 1 || fundsMax > 6)
    return {
      error: actionError("Enter the most insufficient-funds retries, from 1 to 6."),
    };
  if (fundsMax !== DEFAULT_CADENCE.fundsMaxRetries) cadence.funds_max_retries = fundsMax;

  // Days after the invoice due date. Blank = no deadline: the schedule alone ends dunning.
  const rawPeriod = str("dunning_period_days");
  let periodDays: number | null = null;
  if (rawPeriod) {
    periodDays = Number(rawPeriod);
    if (!Number.isInteger(periodDays) || periodDays < 1 || periodDays > 365)
      return {
        error: actionError("Enter the dunning period as a whole number of days from 1 to 365."),
      };
  }

  // Paired `min_currency` / `min_amount` rows, amounts in major units.
  const minCurrencies = fd.getAll("min_currency").map((v) => String(v).trim().toUpperCase());
  const minAmounts = fd.getAll("min_amount").map((v) => String(v).trim());
  const minimumAmounts: Record<string, number> = {};
  for (let i = 0; i < minCurrencies.length; i++) {
    const cur = minCurrencies[i]!;
    const major = Number(minAmounts[i]);
    if (!/^[A-Z]{3}$/.test(cur))
      return { error: actionError("Select a currency for each minimum amount.") };
    if (cur in minimumAmounts)
      return { error: actionError(`Enter one minimum amount for ${cur}. Remove the other row.`) };
    const minor = Number.isFinite(major) ? toMinor(major, cur) : NaN;
    if (!Number.isSafeInteger(minor) || minor < 1)
      return { error: actionError(`Enter a minimum amount for ${cur} that is more than zero.`) };
    minimumAmounts[cur] = minor;
  }

  // Switches post via SwitchField's hidden input, which renders only while checked.
  const on = (k: string) => fd.get(k) != null;
  return {
    data: {
      perInvoice: {
        enabled: on("dunning_enabled"),
        // Anything unrecognised reads as `fixed`, matching `resolveDunningConfig`.
        mode: str("dunning_mode") === "smart" ? "smart" : "fixed",
        ...(days.length ? { retries: days.map((after_days) => ({ after_days })) } : {}),
        final_action: { invoice: inv, subscription: subAction },
        retries_by_method: byMethod,
        adaptive_cadence: cadence,
        skip_retries_for_hard_failures: on("skip_retries_for_hard_failures"),
        dunning_period_days: periodDays,
        dun_trial_and_future_subscriptions: on("dun_trial_and_future_subscriptions"),
        dun_one_time_invoices: on("dun_one_time_invoices"),
        dun_offline_invoices: on("dun_offline_invoices"),
        adaptive_timing: on("adaptive_timing"),
        park_hard_declines: on("park_hard_declines"),
        minimum_amounts: minimumAmounts,
      },
      days,
      collectOnPm: on("collect_on_payment_method_update"),
      cancelNoPmAtRenewal: on("no_payment_method_at_renewal_cancel"),
    },
  };
}
