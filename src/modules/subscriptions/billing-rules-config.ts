/**
 * Billing rules (0481), stored in `businesses.billing_rules_config`:
 *
 *   { trial_end_action?, specific_date_cancel_final_period?, required_reasons?: {…},
 *     failed_change_charge?, pending_change_expiry_hours?, pending_change_expiry_hours_slow?,
 *     new_customer_auto_collection?, mandate_revoked?,
 *     upgrade_proration?, downgrade_proration?, upgrade_gate?, downgrade_gate?,
 *     upgrade_timing?, downgrade_timing?, payment_application?: {…},
 *     plan_credits?: {…}, allowances?: {…}, zero_invoice_paid_event?,
 *     mid_term_coupons?, customer_coupons?,
 *     late_usage_invoices?: { enabled?, minimum?: { "<CUR>": minor units },
 *       wait_hours?, min_interval_hours? } }
 *
 * Pure resolver: null, absent or a value outside its union resolves to what the engine did
 * before the column, so an untouched business is unchanged. Only
 * `specific_date_cancel_final_period` has no fixed default: absent, it follows the
 * business's `default_credit_option_for_cancel`, which is what a scheduled cancel used.
 * The two plan-change timings have none either: absent, each source keeps its own
 * behaviour (change-policy.ts).
 */
import type { Tx } from "@/platform/db";
import { NEW_BUSINESS_LIFECYCLE } from "./lifecycle-config";
import {
  NEW_BUSINESS_PAYMENT_APPLICATION,
  resolvePaymentApplication,
  serializePaymentApplication,
} from "@/modules/payments/application-config";

/** What a trial does at its end when the plan price sets no `trial_end_action`. */
export type TrialEndAction = "activate" | "cancel" | "pause";

/** What a date-specific cancel bills for the term it ends mid-way. */
export type SpecificDateFinalPeriod = "full_period" | "prorated" | "nothing";

/** What happens when the immediate charge for a plan change fails. */
export type FailedChangeCharge = (typeof FAILED_CHANGE_CHARGES)[number];

/** What happens to the subscription when a payment fails because the payer revoked the mandate. */
export type MandateRevokedAction =
  | "follow_dunning"
  | "cancel_now"
  | "cancel_at_term_end"
  | "pause"
  | "request_new_mandate";

/** How a plan change bills the rest of the current term, per direction. */
export type ChangeProration = "prorated" | "none";
/** What must hold before a plan change may happen. */
export type ChangeGate = "off" | "invoices_paid";
/** When a plan change takes effect. Null = not saved: each source keeps its own default. */
export type ChangeTimingRule = "now" | "end_of_term" | "customer_chooses";

export const CHANGE_PRORATIONS = ["prorated", "none"] as const;
export const CHANGE_GATES = ["off", "invoices_paid"] as const;
export const CHANGE_TIMING_RULES = ["now", "end_of_term", "customer_chooses"] as const;

export const REASON_ACTIONS = [
  "cancel_subscription",
  "void_invoice",
  "create_credit_note",
  "refund",
] as const;
export type ReasonAction = (typeof REASON_ACTIONS)[number];

export const TRIAL_END_ACTIONS = ["activate", "cancel", "pause"] as const;
export const SPECIFIC_DATE_FINAL_PERIODS = ["full_period", "prorated", "nothing"] as const;
/**
 * A failed charge on a change's invoice. `start_dunning` (unset): dunning retries it now, and a
 * hard decline runs the final action at once. `next_renewal`: retries wait for the term end.
 * `revert`: a hard decline undoes the change and voids the invoice (`change-revert.ts`).
 * `apply_when_paid`: the change waits for its invoice to be paid (`pending-change.ts`).
 */
export const FAILED_CHANGE_CHARGES = [
  "start_dunning",
  "next_renewal",
  "revert",
  "apply_when_paid",
] as const;
/** How long a change held for payment waits, in hours. Always capped at the term end. */
export const PENDING_CHANGE_EXPIRY_HOURS = { min: 1, max: 720, default: 23 } as const;
/** The same for a slow payment method (a bank debit, a mandate, an offline invoice). */
export const PENDING_CHANGE_EXPIRY_HOURS_SLOW = { min: 1, max: 720, default: 168 } as const;
export const AUTO_COLLECTION_VALUES = ["on", "off"] as const;
export const MANDATE_REVOKED_ACTIONS = [
  "follow_dunning",
  "cancel_now",
  "cancel_at_term_end",
  "pause",
  "request_new_mandate",
] as const;

/**
 * Credit and allowance resets (design-G3b § 6). No business used resets before these keys,
 * so each default is the recommended option, not a "keep today" value.
 */
export const PLAN_CREDIT_UPGRADES = ["full", "prorated", "next_window"] as const;
export const PLAN_CREDIT_DOWNGRADES = ["full", "prorated", "next_window"] as const;
export const PLAN_CREDIT_FIRST_WINDOWS = ["full", "prorated", "next_full_window"] as const;
export const PLAN_CREDIT_PAUSES = ["skip", "keep_granting", "shift"] as const;
export const PLAN_CREDIT_CANCEL_AT_PERIOD_ENDS = [
  "grant_started_window",
  "stop_at_request",
] as const;
/** When a period's plan credits can be spent: from the invoice's issue, or once it is paid. */
export const PLAN_CREDIT_GRANT_WHENS = ["invoice_issued", "invoice_paid"] as const;
/** Plan credits of an unpaid period when the subscription is cancelled for non-payment. */
export const PLAN_CREDIT_UNPAID_CANCELS = ["keep", "void_unused"] as const;
export const ALLOWANCE_UPGRADES = ["new_window", "keep_used", "prorated"] as const;
/** The new plan's credits on an upgrade: at once in full, at once prorated, or next window. */
export type PlanCreditUpgrade = (typeof PLAN_CREDIT_UPGRADES)[number];
export type PlanCreditDowngrade = (typeof PLAN_CREDIT_DOWNGRADES)[number];
/** A window cut short by the subscription start. A price may override it (grants_credit). */
export type PlanCreditFirstWindow = (typeof PLAN_CREDIT_FIRST_WINDOWS)[number];
/** Windows while paused: skip them, keep granting, or move the clock on by the pause. */
export type PlanCreditPause = (typeof PLAN_CREDIT_PAUSES)[number];
/** After a cancel at period end: grant the window that starts before the end, or stop now. */
export type PlanCreditCancelAtPeriodEnd = (typeof PLAN_CREDIT_CANCEL_AT_PERIOD_ENDS)[number];
export type PlanCreditGrantWhen = (typeof PLAN_CREDIT_GRANT_WHENS)[number];
export type PlanCreditUnpaidCancel = (typeof PLAN_CREDIT_UNPAID_CANCELS)[number];
/** An allowance on an upgrade: a new window, keep the used count, or prorate what is left. */
export type AllowanceUpgrade = (typeof ALLOWANCE_UPGRADES)[number];

/** Which zero-total invoices emit `invoice_paid`: none, one-off invoices only, or all. */
export const ZERO_INVOICE_PAID_EVENTS = ["never", "one_off", "all"] as const;
export type ZeroInvoicePaidEvent = (typeof ZERO_INVOICE_PAID_EVENTS)[number];
/** Which mid-term invoices take the subscription's coupons. */
export const MID_TERM_COUPONS = ["skip", "unbilled_and_edits", "all"] as const;
export type MidTermCoupons = (typeof MID_TERM_COUPONS)[number];
/** A customer-level coupon: used only when the subscription has none, or stacked with its own. */
export const CUSTOMER_COUPONS = ["fallback", "stack"] as const;
export type CustomerCoupons = (typeof CUSTOMER_COUPONS)[number];

/** The largest per-currency minimum the API accepts, in minor units. */
export const MAX_LATE_USAGE_MINIMUM_MINOR = 1_000_000_000;
/** How long the oldest late event waits before the invoice, in hours. Unset = 24. */
export const LATE_USAGE_WAIT_HOURS = { min: 1, max: 168, default: 24 } as const;
/** The least time between two late-usage invoices of one customer, in hours. Unset = 24. */
export const LATE_USAGE_MIN_INTERVAL_HOURS = { min: 1, max: 720, default: 24 } as const;

/**
 * Late usage after a cancellation: one more invoice for usage of an invoiced period that
 * arrives after a cancelled subscription's last invoice. Off by default.
 */
export interface LateUsageInvoices {
  enabled: boolean;
  /** Currency (upper case) → the smallest late-usage subtotal we invoice. Absent = none. */
  minimum: Readonly<Record<string, number>>;
  /** Hours the oldest unbilled late event waits, so a burst lands on one invoice. */
  waitHours: number;
  /** Hours that must pass after a customer's last late-usage invoice before the next. */
  minIntervalHours: number;
}

export interface PlanCreditRules {
  onUpgrade: PlanCreditUpgrade;
  onDowngrade: PlanCreditDowngrade;
  firstWindow: PlanCreditFirstWindow;
  onPause: PlanCreditPause;
  onCancelAtPeriodEnd: PlanCreditCancelAtPeriodEnd;
  grantWhen: PlanCreditGrantWhen;
  onUnpaidCancel: PlanCreditUnpaidCancel;
}

/**
 * Decline codes that mean the payer withdrew the authorization (`TERMINATE` in
 * decline-policy.ts, minus `fraudulent`).
 */
export const MANDATE_REVOKED_CODES: ReadonlySet<string> = new Set([
  "revocation_of_authorization",
  "debit_not_authorized",
]);

export interface BillingRulesConfig {
  /** Default `activate`: renewal.ts converts a trial unless the price says cancel. */
  trialEndAction: TrialEndAction;
  /** Default: `default_credit_option_for_cancel` mapped (none → full_period). */
  specificDateCancelFinalPeriod: SpecificDateFinalPeriod;
  /** Default all false: every route accepts the action without a reason. */
  requiredReasons: Record<ReasonAction, boolean>;
  /** Default `start_dunning`: a failed change invoice enters dunning like any other. */
  failedChangeCharge: FailedChangeCharge;
  /** `apply_when_paid`: hours a held change waits for payment. Default 23. */
  pendingChangeExpiryHours: number;
  /** The same for a slow payment method. Default 168. */
  pendingChangeExpiryHoursSlow: number;
  /** Default `on`: `customers.auto_collection` column default. */
  newCustomerAutoCollection: "on" | "off";
  /** Default `follow_dunning`: the decline terminates dunning and the end action runs. */
  mandateRevoked: MandateRevokedAction;
  /** Default `prorated`: `changeSubscription` prorates unless the call says `prorate: false`. */
  upgradeProration: ChangeProration;
  downgradeProration: ChangeProration;
  /** Default `off`: nothing refused a change before. */
  upgradeGate: ChangeGate;
  downgradeGate: ChangeGate;
  /** Default null: see change-policy.ts for what each source does while unset. */
  upgradeTiming: ChangeTimingRule | null;
  downgradeTiming: ChangeTimingRule | null;
  /**
   * Credit resets. Defaults: full, next_window, full, skip, grant_started_window,
   * invoice_issued, keep.
   */
  planCredits: PlanCreditRules;
  /** Allowance resets. Default `new_window`. */
  allowances: { onUpgrade: AllowanceUpgrade };
  /** Default `never`: a zero-total invoice emitted no `invoice_paid`. */
  zeroInvoicePaidEvent: ZeroInvoicePaidEvent;
  /** Default `skip`: mid-term invoices took no subscription coupon. */
  midTermCoupons: MidTermCoupons;
  /** Default `fallback`. */
  customerCoupons: CustomerCoupons;
  /** Default off with no minimum: late usage after a cancellation is not billed. */
  lateUsageInvoices: LateUsageInvoices;
}

const CREDIT_TO_FINAL_PERIOD: Record<string, SpecificDateFinalPeriod> = {
  none: "full_period",
  prorate: "prorated",
  full: "nothing",
};

/** The cancel credit option a final-period choice posts. */
export const FINAL_PERIOD_CREDIT_OPTION: Record<
  SpecificDateFinalPeriod,
  "none" | "prorate" | "full"
> = {
  full_period: "none",
  prorated: "prorate",
  nothing: "full",
};

function pick<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

function pickOrNull<T extends string>(raw: unknown, allowed: readonly T[]): T | null {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : null;
}

function obj(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

const hoursIn = (v: unknown, b: { min: number; max: number; default: number }) =>
  typeof v === "number" && Number.isInteger(v) && v >= b.min && v <= b.max ? v : b.default;

function lateUsageMinimum(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [cur, v] of Object.entries(obj(raw) ?? {}))
    if (
      /^[A-Z]{3}$/.test(cur) &&
      typeof v === "number" &&
      Number.isSafeInteger(v) &&
      v >= 0 &&
      v <= MAX_LATE_USAGE_MINIMUM_MINOR
    )
      out[cur] = v;
  return out;
}

/** Takes the business ROW (Drizzle's camelCase), like the other resolvers. */
export function resolveBillingRulesConfig(
  biz: { billingRulesConfig?: unknown; defaultCreditOptionForCancel?: unknown } | null | undefined,
): BillingRulesConfig {
  const cfg = obj(biz?.billingRulesConfig);
  const reasons = obj(cfg?.required_reasons);
  const credits = obj(cfg?.plan_credits);
  const allowances = obj(cfg?.allowances);
  const late = obj(cfg?.late_usage_invoices);
  const inherited =
    CREDIT_TO_FINAL_PERIOD[String(biz?.defaultCreditOptionForCancel ?? "none")] ?? "full_period";
  return {
    trialEndAction: pick(cfg?.trial_end_action, TRIAL_END_ACTIONS, "activate"),
    specificDateCancelFinalPeriod: pick(
      cfg?.specific_date_cancel_final_period,
      SPECIFIC_DATE_FINAL_PERIODS,
      inherited,
    ),
    requiredReasons: Object.fromEntries(
      REASON_ACTIONS.map((a) => [a, reasons?.[a] === true]),
    ) as Record<ReasonAction, boolean>,
    failedChangeCharge: pick(cfg?.failed_change_charge, FAILED_CHANGE_CHARGES, "start_dunning"),
    pendingChangeExpiryHours: hoursIn(
      cfg?.pending_change_expiry_hours,
      PENDING_CHANGE_EXPIRY_HOURS,
    ),
    pendingChangeExpiryHoursSlow: hoursIn(
      cfg?.pending_change_expiry_hours_slow,
      PENDING_CHANGE_EXPIRY_HOURS_SLOW,
    ),
    newCustomerAutoCollection: pick(
      cfg?.new_customer_auto_collection,
      AUTO_COLLECTION_VALUES,
      "on",
    ),
    mandateRevoked: pick(cfg?.mandate_revoked, MANDATE_REVOKED_ACTIONS, "follow_dunning"),
    upgradeProration: pick(cfg?.upgrade_proration, CHANGE_PRORATIONS, "prorated"),
    downgradeProration: pick(cfg?.downgrade_proration, CHANGE_PRORATIONS, "prorated"),
    upgradeGate: pick(cfg?.upgrade_gate, CHANGE_GATES, "off"),
    downgradeGate: pick(cfg?.downgrade_gate, CHANGE_GATES, "off"),
    upgradeTiming: pickOrNull(cfg?.upgrade_timing, CHANGE_TIMING_RULES),
    downgradeTiming: pickOrNull(cfg?.downgrade_timing, CHANGE_TIMING_RULES),
    planCredits: {
      onUpgrade: pick(credits?.on_upgrade, PLAN_CREDIT_UPGRADES, "full"),
      onDowngrade: pick(credits?.on_downgrade, PLAN_CREDIT_DOWNGRADES, "next_window"),
      firstWindow: pick(credits?.first_window, PLAN_CREDIT_FIRST_WINDOWS, "full"),
      onPause: pick(credits?.on_pause, PLAN_CREDIT_PAUSES, "skip"),
      onCancelAtPeriodEnd: pick(
        credits?.on_cancel_at_period_end,
        PLAN_CREDIT_CANCEL_AT_PERIOD_ENDS,
        "grant_started_window",
      ),
      grantWhen: pick(credits?.grant_when, PLAN_CREDIT_GRANT_WHENS, "invoice_issued"),
      onUnpaidCancel: pick(credits?.on_unpaid_cancel, PLAN_CREDIT_UNPAID_CANCELS, "keep"),
    },
    allowances: {
      onUpgrade: pick(allowances?.on_upgrade, ALLOWANCE_UPGRADES, "new_window"),
    },
    zeroInvoicePaidEvent: pick(cfg?.zero_invoice_paid_event, ZERO_INVOICE_PAID_EVENTS, "never"),
    midTermCoupons: pick(cfg?.mid_term_coupons, MID_TERM_COUPONS, "skip"),
    customerCoupons: pick(cfg?.customer_coupons, CUSTOMER_COUPONS, "fallback"),
    lateUsageInvoices: {
      enabled: late?.enabled === true,
      minimum: lateUsageMinimum(late?.minimum),
      waitHours: hoursIn(late?.wait_hours, LATE_USAGE_WAIT_HOURS),
      minIntervalHours: hoursIn(late?.min_interval_hours, LATE_USAGE_MIN_INTERVAL_HOURS),
    },
  };
}

/** The resolved config in the API's snake_case. */
export function serializeBillingRulesConfig(c: BillingRulesConfig) {
  return {
    trial_end_action: c.trialEndAction,
    specific_date_cancel_final_period: c.specificDateCancelFinalPeriod,
    required_reasons: { ...c.requiredReasons },
    failed_change_charge: c.failedChangeCharge,
    pending_change_expiry_hours: c.pendingChangeExpiryHours,
    pending_change_expiry_hours_slow: c.pendingChangeExpiryHoursSlow,
    new_customer_auto_collection: c.newCustomerAutoCollection,
    mandate_revoked: c.mandateRevoked,
    upgrade_proration: c.upgradeProration,
    downgrade_proration: c.downgradeProration,
    upgrade_gate: c.upgradeGate,
    downgrade_gate: c.downgradeGate,
    upgrade_timing: c.upgradeTiming,
    downgrade_timing: c.downgradeTiming,
    plan_credits: {
      on_upgrade: c.planCredits.onUpgrade,
      on_downgrade: c.planCredits.onDowngrade,
      first_window: c.planCredits.firstWindow,
      on_pause: c.planCredits.onPause,
      on_cancel_at_period_end: c.planCredits.onCancelAtPeriodEnd,
      grant_when: c.planCredits.grantWhen,
      on_unpaid_cancel: c.planCredits.onUnpaidCancel,
    },
    allowances: { on_upgrade: c.allowances.onUpgrade },
    zero_invoice_paid_event: c.zeroInvoicePaidEvent,
    mid_term_coupons: c.midTermCoupons,
    customer_coupons: c.customerCoupons,
    late_usage_invoices: {
      enabled: c.lateUsageInvoices.enabled,
      minimum: { ...c.lateUsageInvoices.minimum },
      wait_hours: c.lateUsageInvoices.waitHours,
      min_interval_hours: c.lateUsageInvoices.minIntervalHours,
    },
  };
}

/** `serializeBillingRulesConfig` plus the payment-application block (its own resolver). */
export function serializeBillingRules(
  biz: { billingRulesConfig?: unknown; defaultCreditOptionForCancel?: unknown } | null | undefined,
) {
  return {
    ...serializeBillingRulesConfig(resolveBillingRulesConfig(biz)),
    payment_application: serializePaymentApplication(resolvePaymentApplication(biz)),
  };
}

/** Keys that merge one level down: a PATCH may send only some of their keys. */
const NESTED_KEYS = new Set([
  "required_reasons",
  "payment_application",
  "plan_credits",
  "allowances",
  "late_usage_invoices",
]);

/** A PATCH body's keys over the stored blob; the nested keys merge one level down. */
export function mergeBillingRulesConfig(
  stored: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const base = obj(stored) ?? {};
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = NESTED_KEYS.has(k) && obj(v) ? { ...(obj(base[k]) ?? {}), ...obj(v) } : v;
  }
  return out;
}

/**
 * Written when a person creates a business. The first five and `payment_application` equal
 * today's behaviour, pinned; a change applies only once its invoice is paid; the plan-change
 * keys are the recommended values (an upgrade
 * needs paid invoices and applies now, a downgrade waits for the term end). A new business
 * also gets `invoice_paid` for every zero-total invoice and coupons on every mid-term invoice.
 * Plan credits follow the money: a downgrade prorates the new plan's credits, and a
 * cancellation for non-payment voids the unpaid period's unused credits.
 */
const NEW_BUSINESS_BILLING_RULES = {
  trial_end_action: "activate",
  specific_date_cancel_final_period: "full_period",
  required_reasons: {
    cancel_subscription: false,
    void_invoice: false,
    create_credit_note: false,
    refund: false,
  },
  failed_change_charge: "apply_when_paid",
  new_customer_auto_collection: "on",
  mandate_revoked: "follow_dunning",
  payment_application: NEW_BUSINESS_PAYMENT_APPLICATION,
  upgrade_proration: "prorated",
  downgrade_proration: "prorated",
  upgrade_gate: "invoices_paid",
  downgrade_gate: "off",
  upgrade_timing: "now",
  downgrade_timing: "end_of_term",
  zero_invoice_paid_event: "all",
  mid_term_coupons: "all",
  customer_coupons: "fallback",
  plan_credits: { on_downgrade: "prorated", on_unpaid_cancel: "void_unused" },
} as const;

/** Only a signed-in person gets the pinned values; a key keeps the resolver defaults. */
export function initialBillingRulesConfig(creator: {
  hasOperator?: boolean;
}): Record<string, unknown> | undefined {
  return creator.hasOperator === true
    ? structuredClone({ ...NEW_BUSINESS_BILLING_RULES, ...NEW_BUSINESS_LIFECYCLE } as Record<
        string,
        unknown
      >)
    : undefined;
}

/**
 * The 400 an action gets when the business requires a reason and none was sent.
 * ASD-STE100: "We could not <verb> <thing>. <Reason>. <Next step>."
 */
export const REASON_REQUIRED_MESSAGE: Record<ReasonAction, string> = {
  cancel_subscription:
    "We could not cancel the subscription. This business requires a reason. Select a reason code and try again.",
  void_invoice:
    "We could not void the invoice. This business requires a reason. Enter a reason and try again.",
  create_credit_note:
    "We could not create the credit note. This business requires a reason code. Select a reason code and try again.",
  refund:
    "We could not refund the payment. This business requires a reason. Enter a reason and try again.",
};

/** The message when `action` requires a reason and `value` is blank; null when it may proceed. */
export function missingReason(
  biz: { billingRulesConfig?: unknown } | null | undefined,
  action: ReasonAction,
  value: string | null | undefined,
): string | null {
  if (!resolveBillingRulesConfig(biz).requiredReasons[action]) return null;
  return value != null && value.trim() !== "" ? null : REASON_REQUIRED_MESSAGE[action];
}

/** The two columns the resolver reads, for a caller holding only the business id. */
export async function loadBillingRulesRow(
  organizationId: string,
  businessId: string,
  tx?: Tx,
): Promise<{ billingRulesConfig: unknown; defaultCreditOptionForCancel: unknown } | null> {
  // Imported here so the resolver stays loadable without a database (unit tests).
  const { withTenant } = await import("@/platform/db");
  const { businesses } = await import("@db/schema");
  const { eq } = await import("drizzle-orm");
  const read = async (t: Tx) =>
    (
      await t
        .select({
          billingRulesConfig: businesses.billingRulesConfig,
          defaultCreditOptionForCancel: businesses.defaultCreditOptionForCancel,
        })
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1)
    )[0] ?? null;
  return tx ? read(tx) : withTenant(organizationId, read);
}
