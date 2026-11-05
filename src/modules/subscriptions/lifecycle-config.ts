/**
 * Subscription lifecycle rules, stored in `businesses.billing_rules_config` beside the
 * other billing rules (billing-rules-config.ts):
 *
 *   { plan_change_term?, plan_change_coupons?, downgrade_credit?, reactivation_charges? }
 *
 * Pure resolver: null, absent or a value outside its union resolves to what the engine
 * did before the key existed, so an untouched business is unchanged.
 */

/** Whether a plan change restarts the term. A change of billing period always does. */
export type PlanChangeTerm = "keep_anchor" | "reset_on_upgrade" | "reset_on_any_change";
/** What a plan change does with the coupons on the subscription. */
export type PlanChangeCoupons = "keep" | "drop" | "keep_if_valid";
/** Where the credit a change leaves over goes. */
export type DowngradeCredit = "credit_balance" | "refund" | "customer_chooses";
/** How a reactivation of a cancelled subscription bills its new term, when the request does not say. */
export type ReactivationCharges = "invoice_immediately" | "add_to_unbilled_charges";

export const PLAN_CHANGE_TERMS = [
  "keep_anchor",
  "reset_on_upgrade",
  "reset_on_any_change",
] as const;
export const PLAN_CHANGE_COUPONS = ["keep", "drop", "keep_if_valid"] as const;
export const DOWNGRADE_CREDITS = ["credit_balance", "refund", "customer_chooses"] as const;
export const REACTIVATION_CHARGES = ["invoice_immediately", "add_to_unbilled_charges"] as const;

export interface LifecycleConfig {
  /** Default `keep_anchor`: `reset_term` was a per-call option only. */
  planChangeTerm: PlanChangeTerm;
  /** Default `keep`: coupons stayed on the subscription through a plan change. */
  planChangeCoupons: PlanChangeCoupons;
  /** Default `credit_balance`: a change's credit note stays as account credit. */
  downgradeCredit: DowngradeCredit;
  /** Default `invoice_immediately`: the reactivate route billed the new term at once. */
  reactivationCharges: ReactivationCharges;
}

function pick<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

/** Takes the business ROW (Drizzle's camelCase). */
export function resolveLifecycleConfig(
  biz: { billingRulesConfig?: unknown } | null | undefined,
): LifecycleConfig {
  const raw = biz?.billingRulesConfig;
  const cfg =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  return {
    planChangeTerm: pick(cfg?.plan_change_term, PLAN_CHANGE_TERMS, "keep_anchor"),
    planChangeCoupons: pick(cfg?.plan_change_coupons, PLAN_CHANGE_COUPONS, "keep"),
    downgradeCredit: pick(cfg?.downgrade_credit, DOWNGRADE_CREDITS, "credit_balance"),
    reactivationCharges: pick(
      cfg?.reactivation_charges,
      REACTIVATION_CHARGES,
      "invoice_immediately",
    ),
  };
}

/** The resolved keys in the API's snake_case, merged into `billing_rules_config`. */
export function serializeLifecycleConfig(c: LifecycleConfig) {
  return {
    plan_change_term: c.planChangeTerm,
    plan_change_coupons: c.planChangeCoupons,
    downgrade_credit: c.downgradeCredit,
    reactivation_charges: c.reactivationCharges,
  };
}

/**
 * Written when a person creates a business: today's behaviour pinned, except coupons,
 * which a plan change keeps only while they still apply to the new plan.
 */
export const NEW_BUSINESS_LIFECYCLE = {
  plan_change_term: "keep_anchor",
  plan_change_coupons: "keep_if_valid",
  downgrade_credit: "credit_balance",
  reactivation_charges: "invoice_immediately",
} as const;

/**
 * Whether this change restarts the term. An explicit `reset_term` wins; `undefined` keeps
 * the engine's own rule (a change of billing period resets). Only a change that moves the
 * plan's price counts as a plan change.
 */
export function resetTermFor(
  rule: PlanChangeTerm,
  direction: "upgrade" | "downgrade" | "same",
  planMoves: boolean,
  explicit?: boolean,
): boolean | undefined {
  if (explicit !== undefined) return explicit;
  if (!planMoves) return undefined;
  if (rule === "reset_on_any_change") return true;
  if (rule === "reset_on_upgrade" && direction === "upgrade") return true;
  return undefined;
}
