// Reads the "Grants credit" fields that `GrantsCreditCard` posts, for the price create and
// edit actions. Plain module (no "use server"), so the actions can import it.
import { toSmallestStep, type PriceGrantsCredit } from "./credits";
import { resetOf, type ResetDraft } from "./reset";

/** What the card posts as JSON under `grants_credit`. Amounts are as typed. */
export interface GrantsCreditDraft {
  on: boolean;
  kind: "pack" | "per_cycle";
  unit: string;
  /** The unit's decimal places (money: the currency exponent). */
  decimals: number;
  amount: string;
  priority: string;
  expires_days: string;
  tax_treatment: string;
  on_exhausted: string;
  roll_mode: "none" | "carry";
  roll_percent: string;
  roll_cap: string;
  roll_keep: "cycles" | "forever";
  roll_cycles: string;
  /** Per cycle (G3b): the "Renews" control. Absent on drafts from before it. */
  reset?: ResetDraft;
  /** Kept as stored: the dashboard has no control for it. */
  first_window?: "full" | "prorated" | "next_full_window" | null;
}

export type GrantsCreditFields =
  | { ok: true; value: PriceGrantsCredit | null }
  | { ok: false; field: string; message: string };

const whole = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : null);

/** `null` when the form has no card (nothing to send); else the body value or a field error. */
export function grantsCreditFields(fd: FormData): GrantsCreditFields | null {
  if (fd.get("grants_credit_present") !== "1") return null;
  let d: GrantsCreditDraft;
  try {
    d = JSON.parse(String(fd.get("grants_credit") ?? ""));
  } catch {
    return {
      ok: false,
      field: "gc_amount",
      message: "We could not read the credit fields. Reload the page.",
    };
  }
  if (!d.on) return { ok: true, value: null };

  const unit = d.unit || null;
  const amount = toSmallestStep(d.amount, d.decimals);
  if (amount == null)
    return {
      ok: false,
      field: "gc_amount",
      message:
        d.decimals === 0
          ? "Enter the credit amount as a whole number more than 0."
          : `Enter the credit amount, more than 0, with up to ${d.decimals} decimal places.`,
    };
  const priority = whole(d.priority);
  if (priority == null || priority > 100)
    return { ok: false, field: "gc_priority", message: "Enter a priority from 0 to 100." };
  const policy = d.on_exhausted === "block" || d.on_exhausted === "bill" ? d.on_exhausted : null;

  if (d.kind === "pack") {
    let expires: { days: number } | null = null;
    if (d.expires_days.trim()) {
      const days = whole(d.expires_days);
      if (!days || days > 3650)
        return {
          ok: false,
          field: "gc_expires_days",
          message: "Enter from 1 to 3,650 days, or leave it empty.",
        };
      expires = { days };
    }
    if (d.tax_treatment !== "taxed_at_purchase" && d.tax_treatment !== "taxed_at_use")
      return {
        ok: false,
        field: "gc_tax_treatment",
        message: "Select a tax treatment for the credit.",
      };
    if (d.tax_treatment === "taxed_at_use" && unit)
      return {
        ok: false,
        field: "gc_tax_treatment",
        message: "Credit in a custom unit is taxed at purchase.",
      };
    return {
      ok: true,
      value: {
        kind: "pack",
        unit,
        amount,
        category: "paid",
        priority,
        expires_after: expires,
        applicability: { kind: "metered" },
        tax_treatment: d.tax_treatment,
        on_exhausted: policy,
      },
    };
  }

  let rollover: NonNullable<Extract<PriceGrantsCredit, { kind: "per_cycle" }>["rollover"]> = {
    mode: "none",
  };
  if (d.roll_mode === "carry") {
    const percent = whole(d.roll_percent);
    if (!percent || percent > 100)
      return { ok: false, field: "gc_roll_percent", message: "Enter a percentage from 1 to 100." };
    let cap: number | null = null;
    if (d.roll_cap.trim()) {
      cap = toSmallestStep(d.roll_cap, d.decimals);
      if (cap == null)
        return {
          ok: false,
          field: "gc_roll_cap",
          message: "Enter a cap more than 0, or leave it empty.",
        };
    }
    let cycles: number | null = null;
    if (d.roll_keep === "cycles") {
      cycles = whole(d.roll_cycles);
      if (!cycles || cycles > 120)
        return {
          ok: false,
          field: "gc_roll_cycles",
          message: "Enter from 1 to 120 billing periods.",
        };
    }
    rollover = { mode: "carry", percent, cap, expire_after_cycles: cycles };
  }
  const reset = d.reset ? resetOf(d.reset) : ({ ok: true, value: null } as const);
  if (!reset.ok) return { ok: false, field: "gc_reset_every", message: reset.message };
  if (reset.value?.every === "hour")
    return { ok: false, field: "gc_reset_every", message: "Credits cannot renew every hour." };
  if (reset.value?.every === "never" && rollover.mode === "carry")
    return {
      ok: false,
      field: "gc_roll_mode",
      message: "Credits that never renew cannot carry over. Select Unused credit expires.",
    };
  return {
    ok: true,
    value: {
      kind: "per_cycle",
      unit,
      amount,
      priority,
      applicability: { kind: "metered" },
      on_exhausted: policy,
      rollover,
      ...(reset.value ? { reset: reset.value } : {}),
      // Only a calendar window can start before the subscription; elsewhere the control is hidden.
      ...(d.first_window &&
      reset.value?.anchor === "calendar" &&
      reset.value.every !== "term" &&
      reset.value.every !== "never"
        ? { first_window: d.first_window }
        : {}),
    },
  };
}
