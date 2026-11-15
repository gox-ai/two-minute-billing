/**
 * Subscription lifecycle rules, stored in `businesses.billing_rules_config` beside the
 * other billing rules (billing-rules-config.ts):
 *
 *   { plan_change_term?, plan_change_coupons?, downgrade_credit?, net_credit_documents?,
 *     block_downgrade_when_past_due?, reactivation_charges? }
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
/**
 * The documents a change that nets to a credit raises. `credit_note_and_invoice`: a credit
 * note for the unused time and a tax invoice for the new lines, the credit applied to it.
 * `one_credit_note`: the charge netted into one credit note, no invoice.
 */
export type NetCreditDocuments = "credit_note_and_invoice" | "one_credit_note";
/** How a reactivation of a cancelled subscription bills its new term, when the request does not say. */
export type ReactivationCharges = "invoice_immediately" | "add_to_unbilled_charges";

export const PLAN_CHANGE_TERMS = [
  "keep_anchor",
  "reset_on_upgrade",
  "reset_on_any_change",
] as const;
export const PLAN_CHANGE_COUPONS = ["keep", "drop", "keep_if_valid"] as const;
export const DOWNGRADE_CREDITS = ["credit_balance", "refund", "customer_chooses"] as const;
export const NET_CREDIT_DOCUMENTS = ["credit_note_and_invoice", "one_credit_note"] as const;
export const REACTIVATION_CHARGES = ["invoice_immediately", "add_to_unbilled_charges"] as const;

export interface LifecycleConfig {
  /** Default `keep_anchor`: `reset_term` was a per-call option only. */
  planChangeTerm: PlanChangeTerm;
  /** Default `keep`: coupons stayed on the subscription through a plan change. */
  planChangeCoupons: PlanChangeCoupons;
  /** Default `credit_balance`: a change's credit note stays as account credit. */
  downgradeCredit: DowngradeCredit;
  /**
   * Null = not saved: the rule before 2026-11-13 (two documents when the change is invoiced
   * now and the term's invoices can take the credit, else one note). New businesses store
   * `credit_note_and_invoice`.
   */
  netCreditDocuments: NetCreditDocuments | null;
  /** Default false: a downgrade applied now is not refused for a past-due invoice. */
  blockDowngradeWhenPastDue: boolean;
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
    netCreditDocuments: storedNetCreditDocuments(biz),
    blockDowngradeWhenPastDue: cfg?.block_downgrade_when_past_due === true,
    reactivationCharges: pick(
      cfg?.reactivation_charges,
      REACTIVATION_CHARGES,
      "invoice_immediately",
    ),
  };
}

/** `net_credit_documents` as stored: null = not saved (the rule before 2026-11-13). */
export function storedNetCreditDocuments(
  biz: { billingRulesConfig?: unknown } | null | undefined,
): NetCreditDocuments | null {
  const raw = (biz?.billingRulesConfig as Record<string, unknown> | null | undefined)
    ?.net_credit_documents;
  return (NET_CREDIT_DOCUMENTS as readonly unknown[]).includes(raw)
    ? (raw as NetCreditDocuments)
    : null;
}

/** The resolved keys in the API's snake_case, merged into `billing_rules_config`. */
export function serializeLifecycleConfig(c: LifecycleConfig) {
  return {
    plan_change_term: c.planChangeTerm,
    plan_change_coupons: c.planChangeCoupons,
    downgrade_credit: c.downgradeCredit,
    net_credit_documents: c.netCreditDocuments,
    block_downgrade_when_past_due: c.blockDowngradeWhenPastDue,
    reactivation_charges: c.reactivationCharges,
  };
}

/**
 * Written when a person creates a business: today's behaviour pinned, except coupons,
 * which a plan change keeps only while they still apply to the new plan, and a net credit,
 * which gets a credit note and an invoice.
 */
export const NEW_BUSINESS_LIFECYCLE = {
  plan_change_term: "keep_anchor",
  plan_change_coupons: "keep_if_valid",
  downgrade_credit: "credit_balance",
  // 2026-11-13: a new business books a net credit as a credit note plus an invoice.
  net_credit_documents: "credit_note_and_invoice",
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
