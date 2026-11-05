/**
 * Reset settings (design G3b §6): the business's plan-credit and allowance rules, read from
 * `resolveBillingRulesConfig`, which owns the keys, values and defaults.
 */
import { resolveBillingRulesConfig } from "@/modules/subscriptions/billing-rules-config";
import type {
  AllowanceUpgrade,
  PlanCreditDowngrade,
  PlanCreditRules,
  PlanCreditUpgrade,
} from "@/modules/subscriptions/billing-rules-config";

export {
  ALLOWANCE_UPGRADES,
  PLAN_CREDIT_CANCEL_AT_PERIOD_ENDS,
  PLAN_CREDIT_DOWNGRADES,
  PLAN_CREDIT_FIRST_WINDOWS,
  PLAN_CREDIT_PAUSES,
  PLAN_CREDIT_UPGRADES,
  type AllowanceUpgrade,
  type PlanCreditCancelAtPeriodEnd,
  type PlanCreditDowngrade,
  type PlanCreditFirstWindow,
  type PlanCreditPause,
  type PlanCreditRules,
  type PlanCreditUpgrade,
} from "@/modules/subscriptions/billing-rules-config";

export interface ResetSettings {
  planCredits: PlanCreditRules;
  allowances: { onUpgrade: AllowanceUpgrade };
}

export function readResetSettings(
  biz: { billingRulesConfig?: unknown } | null | undefined,
): ResetSettings {
  const { planCredits, allowances } = resolveBillingRulesConfig(biz);
  return { planCredits, allowances };
}

/** One plan change's own rules (`POST …/change`), over the business's. */
export interface ResetOverrides {
  planCredits?: { onUpgrade?: PlanCreditUpgrade; onDowngrade?: PlanCreditDowngrade };
  allowances?: { onUpgrade?: AllowanceUpgrade };
}

export function withResetOverrides(s: ResetSettings, o: ResetOverrides | undefined): ResetSettings {
  if (!o) return s;
  const p = o.planCredits;
  return {
    planCredits: {
      ...s.planCredits,
      onUpgrade: p?.onUpgrade ?? s.planCredits.onUpgrade,
      onDowngrade: p?.onDowngrade ?? s.planCredits.onDowngrade,
    },
    allowances: { onUpgrade: o.allowances?.onUpgrade ?? s.allowances.onUpgrade },
  };
}
