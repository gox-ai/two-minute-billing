/**
 * Billing rules (`businesses.billing_rules_config`, 0481). The API returns every key
 * resolved; the fallbacks below repeat `resolveBillingRulesConfig` for a stale response.
 */
export type TrialEndAction = "activate" | "cancel" | "pause";
export type SpecificDateFinalPeriod = "full_period" | "prorated" | "nothing";
export type FailedChangeCharge = "start_dunning" | "next_renewal";
export type MandateRevokedAction =
  | "follow_dunning"
  | "cancel_now"
  | "cancel_at_term_end"
  | "pause"
  | "request_new_mandate";
export type DeclinedRefundOutcome = "block" | "issue_credit";
export type ReasonAction = "cancel_subscription" | "void_invoice" | "create_credit_note" | "refund";
export type ChangeProration = "prorated" | "none";
export type ChangeGate = "off" | "invoices_paid";
/** Null = not saved: each source keeps its own default (see PLAN_CHANGE_TIMING_UNSET). */
export type ChangeTimingRule = "now" | "end_of_term" | "customer_chooses";

// ── Subscription lifecycle (lifecycle-config.ts) ──
export type PlanChangeTerm = "keep_anchor" | "reset_on_upgrade" | "reset_on_any_change";
export type PlanChangeCoupons = "keep" | "drop" | "keep_if_valid";
export type DowngradeCredit = "credit_balance" | "refund" | "customer_chooses";
export type ReactivationCharges = "invoice_immediately" | "add_to_unbilled_charges";

export interface LifecycleRules {
  plan_change_term: PlanChangeTerm;
  plan_change_coupons: PlanChangeCoupons;
  downgrade_credit: DowngradeCredit;
  reactivation_charges: ReactivationCharges;
}

export interface BillingRulesConfig extends Partial<LifecycleRules> {
  trial_end_action: TrialEndAction;
  specific_date_cancel_final_period: SpecificDateFinalPeriod;
  required_reasons: Record<ReasonAction, boolean>;
  failed_change_charge: FailedChangeCharge;
  new_customer_auto_collection: "on" | "off";
  mandate_revoked: MandateRevokedAction;
  // Collection rules (2.12, 2.15).
  partial_payment_write_off: Record<string, number>;
  partial_payment_write_off_max_percent: number;
  declined_refund: DeclinedRefundOutcome;
  upgrade_proration: ChangeProration;
  downgrade_proration: ChangeProration;
  upgrade_gate: ChangeGate;
  downgrade_gate: ChangeGate;
  upgrade_timing: ChangeTimingRule | null;
  downgrade_timing: ChangeTimingRule | null;
}

/** A PATCH: keys left out keep their stored value. */
export type BillingRulesPatch = Partial<Omit<BillingRulesConfig, "required_reasons">> & {
  required_reasons?: Partial<Record<ReasonAction, boolean>>;
  payment_application?: Partial<PaymentApplication>;
  plan_credits?: Partial<PlanCreditResets>;
  allowances?: Partial<AllowanceResets>;
};

const CREDIT_TO_FINAL: Record<string, SpecificDateFinalPeriod> = {
  none: "full_period",
  prorate: "prorated",
  full: "nothing",
};

export function billingRules(
  b:
    | {
        billing_rules_config?: Partial<BillingRulesConfig> | null;
        default_credit_option_for_cancel?: string | null;
      }
    | null
    | undefined,
): BillingRulesConfig {
  const c = b?.billing_rules_config ?? {};
  const r = c.required_reasons;
  return {
    trial_end_action: c.trial_end_action ?? "activate",
    specific_date_cancel_final_period:
      c.specific_date_cancel_final_period ??
      CREDIT_TO_FINAL[b?.default_credit_option_for_cancel ?? "none"] ??
      "full_period",
    required_reasons: {
      cancel_subscription: r?.cancel_subscription === true,
      void_invoice: r?.void_invoice === true,
      create_credit_note: r?.create_credit_note === true,
      refund: r?.refund === true,
    },
    failed_change_charge: c.failed_change_charge ?? "start_dunning",
    new_customer_auto_collection: c.new_customer_auto_collection ?? "on",
    mandate_revoked: c.mandate_revoked ?? "follow_dunning",
    partial_payment_write_off: c.partial_payment_write_off ?? {},
    partial_payment_write_off_max_percent: c.partial_payment_write_off_max_percent ?? 2,
    declined_refund: c.declined_refund ?? "block",
    upgrade_proration: c.upgrade_proration ?? "prorated",
    downgrade_proration: c.downgrade_proration ?? "prorated",
    upgrade_gate: c.upgrade_gate ?? "off",
    downgrade_gate: c.downgrade_gate ?? "off",
    upgrade_timing: c.upgrade_timing ?? null,
    downgrade_timing: c.downgrade_timing ?? null,
  };
}

/**
 * The largest shortfall the engine writes off on this invoice (`shortfallToWriteOff` in
 * src/modules/subscriptions/collection-rules-config.ts): the currency's amount and the percent
 * of the total, whichever is lower. 0 = never (no limit for the currency, or a credit purchase).
 */
export function shortfallWriteOffLimit(
  rules: Pick<
    BillingRulesConfig,
    "partial_payment_write_off" | "partial_payment_write_off_max_percent"
  >,
  inv: { currency: string; total_minor: number; purpose?: string | null },
): number {
  if (inv.purpose === "credit_purchase") return 0;
  const max = rules.partial_payment_write_off[inv.currency.toUpperCase()];
  if (!max || max <= 0) return 0;
  const byPercent = Math.floor(
    (inv.total_minor * rules.partial_payment_write_off_max_percent) / 100,
  );
  return Math.max(0, Math.min(max, byPercent));
}

export const CHANGE_PRORATION_LABELS: Record<ChangeProration, string> = {
  prorated: "Prorate",
  none: "Do not prorate",
};

export const CHANGE_GATE_LABELS: Record<ChangeGate, string> = {
  off: "No requirement",
  invoices_paid: "All invoices paid",
};

export const CHANGE_TIMING_LABELS: Record<ChangeTimingRule, string> = {
  now: "Now",
  end_of_term: "At the end of the term",
  customer_chooses: "Customer selects",
};

/** What the customer portal does for each direction while the timing is not saved. */
export const PLAN_CHANGE_TIMING_UNSET: Record<"upgrade" | "downgrade", ChangeTimingRule> = {
  upgrade: "now",
  downgrade: "end_of_term",
};

export const TRIAL_END_LABELS: Record<TrialEndAction, string> = {
  activate: "Activate the subscription",
  cancel: "Cancel the subscription",
  pause: "Pause the subscription",
};

export const FINAL_PERIOD_LABELS: Record<SpecificDateFinalPeriod, string> = {
  full_period: "Bill the full term",
  prorated: "Bill until the cancellation date",
  nothing: "Bill nothing",
};

export const FAILED_CHANGE_LABELS: Record<FailedChangeCharge, string> = {
  start_dunning: "Start dunning",
  next_renewal: "Retry at the next renewal",
};

export const MANDATE_REVOKED_LABELS: Record<MandateRevokedAction, string> = {
  follow_dunning: "Do the dunning end action",
  cancel_now: "Cancel the subscription now",
  cancel_at_term_end: "Cancel at the end of the term",
  pause: "Pause the subscription",
  request_new_mandate: "Keep it and ask for a new mandate",
};

export const DECLINED_REFUND_LABELS: Record<DeclinedRefundOutcome, string> = {
  block: "Keep the money with the business",
  issue_credit: "Give the customer credit",
};

// ── Payment application (2.51, 2.66, 2.69): billing_rules_config.payment_application ──
export type SeveralDueInvoices = "separate" | "combined" | "customer_chooses";
export type InvoiceOrder = "oldest_first" | "newest_first" | "customer_chooses";
export type ExcessPaymentAction = "credit" | "refund" | "customer_chooses";

export interface PaymentApplication {
  several_due_invoices: SeveralDueInvoices;
  invoice_order: InvoiceOrder;
  excess_payment: ExcessPaymentAction;
}

/** The resolved block; the fallbacks repeat `resolvePaymentApplication` for a stale response. */
export function paymentApplication(
  b:
    | { billing_rules_config?: { payment_application?: Partial<PaymentApplication> } | null }
    | null
    | undefined,
): PaymentApplication {
  const p = b?.billing_rules_config?.payment_application ?? {};
  return {
    several_due_invoices: p.several_due_invoices ?? "separate",
    invoice_order: p.invoice_order ?? "oldest_first",
    excess_payment: p.excess_payment ?? "credit",
  };
}

export const SEVERAL_DUE_LABELS: Record<SeveralDueInvoices, string> = {
  separate: "One charge for each invoice",
  combined: "One charge for all due invoices",
  customer_chooses: "The customer selects in the portal",
};

export const INVOICE_ORDER_LABELS: Record<InvoiceOrder, string> = {
  oldest_first: "Oldest due date first",
  newest_first: "Newest due date first",
  customer_chooses: "The customer selects in the portal",
};

export const EXCESS_PAYMENT_LABELS: Record<ExcessPaymentAction, string> = {
  credit: "Keep as customer credit",
  refund: "Refund automatically",
  customer_chooses: "The customer selects in the portal",
};

const TIMING_RULES: readonly ChangeTimingRule[] = ["now", "end_of_term", "customer_chooses"];

/**
 * The timing keys a Update subscription save stores. A timing not saved yet is shown
 * preselected and posted with `<key>_unset`; it is stored only when the select changed
 * (the page then drops `_unset`) or its `<key>_save` box is checked.
 */
export function timingRulesFromForm(
  fd: FormData,
): Pick<BillingRulesPatch, "upgrade_timing" | "downgrade_timing"> {
  const out: Pick<BillingRulesPatch, "upgrade_timing" | "downgrade_timing"> = {};
  for (const key of ["upgrade_timing", "downgrade_timing"] as const) {
    const v = String(fd.get(key) ?? "").trim();
    if (!(TIMING_RULES as readonly string[]).includes(v)) continue;
    if (v === String(fd.get(`${key}_unset`) ?? "") && fd.get(`${key}_save`) !== "on") continue;
    out[key] = v as ChangeTimingRule;
  }
  return out;
}

/** The lifecycle keys, resolved as `resolveLifecycleConfig` does for a stale response. */
export function lifecycleRules(
  b: { billing_rules_config?: Partial<BillingRulesConfig> | null } | null | undefined,
): LifecycleRules {
  const c = b?.billing_rules_config ?? {};
  return {
    plan_change_term: c.plan_change_term ?? "keep_anchor",
    plan_change_coupons: c.plan_change_coupons ?? "keep",
    downgrade_credit: c.downgrade_credit ?? "credit_balance",
    reactivation_charges: c.reactivation_charges ?? "invoice_immediately",
  };
}

export const PLAN_CHANGE_TERM_LABELS: Record<PlanChangeTerm, string> = {
  keep_anchor: "Keep the current term",
  reset_on_upgrade: "Start a new term on an upgrade",
  reset_on_any_change: "Start a new term on every plan change",
};

export const PLAN_CHANGE_COUPON_LABELS: Record<PlanChangeCoupons, string> = {
  keep: "Keep the coupons",
  drop: "Remove the coupons",
  keep_if_valid: "Keep only coupons that apply to the new plan",
};

/** `customer_chooses` is absent: the portal has no control for it yet. */
export const DOWNGRADE_CREDIT_LABELS: Record<DowngradeCredit, string> = {
  credit_balance: "Keep as account credit",
  refund: "Refund to the payment method",
  customer_chooses: "Customer selects",
};

export const REACTIVATION_CHARGE_LABELS: Record<ReactivationCharges, string> = {
  invoice_immediately: "Invoice immediately",
  add_to_unbilled_charges: "Add to unbilled charges",
};

// ── Credit and allowance resets (design-G3b § 6): plan_credits.*, allowances.* ──
export const PLAN_CREDIT_UPGRADES = ["full", "prorated", "next_window"] as const;
export const PLAN_CREDIT_DOWNGRADES = ["full", "next_window"] as const;
export const PLAN_CREDIT_FIRST_WINDOWS = ["full", "prorated", "next_full_window"] as const;
export const PLAN_CREDIT_PAUSES = ["skip", "keep_granting", "shift"] as const;
export const PLAN_CREDIT_CANCEL_AT_PERIOD_ENDS = [
  "grant_started_window",
  "stop_at_request",
] as const;
export const ALLOWANCE_UPGRADES = ["new_window", "keep_used", "prorated"] as const;

export interface PlanCreditResets {
  on_upgrade: (typeof PLAN_CREDIT_UPGRADES)[number];
  on_downgrade: (typeof PLAN_CREDIT_DOWNGRADES)[number];
  first_window: (typeof PLAN_CREDIT_FIRST_WINDOWS)[number];
  on_pause: (typeof PLAN_CREDIT_PAUSES)[number];
  on_cancel_at_period_end: (typeof PLAN_CREDIT_CANCEL_AT_PERIOD_ENDS)[number];
}
export interface AllowanceResets {
  on_upgrade: (typeof ALLOWANCE_UPGRADES)[number];
}

/** The resolved blocks; the fallbacks repeat `resolveBillingRulesConfig` for a stale response. */
export function resetRules(b: { billing_rules_config?: object | null } | null | undefined): {
  planCredits: PlanCreditResets;
  allowances: AllowanceResets;
} {
  const c = (b?.billing_rules_config ?? {}) as {
    plan_credits?: Partial<PlanCreditResets>;
    allowances?: Partial<AllowanceResets>;
  };
  const p = c.plan_credits ?? {};
  const a = c.allowances ?? {};
  return {
    planCredits: {
      on_upgrade: p.on_upgrade ?? "full",
      on_downgrade: p.on_downgrade ?? "next_window",
      first_window: p.first_window ?? "full",
      on_pause: p.on_pause ?? "skip",
      on_cancel_at_period_end: p.on_cancel_at_period_end ?? "grant_started_window",
    },
    allowances: { on_upgrade: a.on_upgrade ?? "new_window" },
  };
}

export const CREDIT_UPGRADE_LABELS: Record<PlanCreditResets["on_upgrade"], string> = {
  full: "At once, in full",
  prorated: "At once, prorated",
  next_window: "From the next window",
};
export const CREDIT_DOWNGRADE_LABELS: Record<PlanCreditResets["on_downgrade"], string> = {
  full: "At once, in full",
  next_window: "From the next window",
};
export const FIRST_WINDOW_LABELS: Record<PlanCreditResets["first_window"], string> = {
  full: "The full amount",
  prorated: "A prorated amount",
  next_full_window: "Nothing until the first full window",
};
export const CREDIT_PAUSE_LABELS: Record<PlanCreditResets["on_pause"], string> = {
  skip: "Skip windows while paused",
  keep_granting: "Keep granting",
  shift: "Move the windows by the paused time",
};
export const CREDIT_CANCEL_LABELS: Record<PlanCreditResets["on_cancel_at_period_end"], string> = {
  grant_started_window: "Grant windows that start before the end",
  stop_at_request: "Stop granting at the cancel request",
};
export const ALLOWANCE_UPGRADE_LABELS: Record<AllowanceResets["on_upgrade"], string> = {
  new_window: "Start a new window",
  keep_used: "Keep the used count",
  prorated: "Prorate the rest of the allowance",
};

/** The rules one change may override (`POST …/change`), resolved as the engine does. */
export interface ChangeRuleDefaults {
  on_charge_failure: FailedChangeCharge;
  coupons: PlanChangeCoupons;
  /** `customer_chooses` keeps the credit on an operator change. */
  downgrade_credit: "credit_balance" | "refund";
  plan_credits: {
    upgrade: PlanCreditResets["on_upgrade"];
    downgrade: PlanCreditResets["on_downgrade"];
  };
  allowances: AllowanceResets["on_upgrade"];
}

export function changeRuleDefaults(
  b: { billing_rules_config?: Partial<BillingRulesConfig> | null } | null | undefined,
): ChangeRuleDefaults {
  const life = lifecycleRules(b);
  const resets = resetRules(b);
  return {
    on_charge_failure: billingRules(b).failed_change_charge,
    coupons: life.plan_change_coupons,
    downgrade_credit: life.downgrade_credit === "refund" ? "refund" : "credit_balance",
    plan_credits: {
      upgrade: resets.planCredits.on_upgrade,
      downgrade: resets.planCredits.on_downgrade,
    },
    allowances: resets.allowances.on_upgrade,
  };
}
