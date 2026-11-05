/**
 * Spend limits for the access check (design G3 §3.9 step 3). The default evaluator is the
 * usage-controls one (design G5 §3.2), loaded on first use; tests may replace it.
 */
import type { Tx } from "@/platform/db";

/** One limit the check measured. Refused → only the tightest refusing limit is returned. */
export interface SpendLimitHit {
  /** slim_… for a limit, sltr_… for a reached tier. */
  id: string;
  /** Same as `id` (the PR 2 name). */
  limit: string;
  scope: "customer" | "subscription" | "property";
  property_key: string | null;
  property_value: string | null;
  interval: "day" | "week" | "month" | "period";
  mode: "hard" | "soft";
  set_by: "operator" | "customer";
  source: "limit" | "tier";
  amount_minor: number;
  /** Same as `amount_minor` (the PR 2 name). */
  limit_minor: number;
  spent_minor: number;
  open_holds_minor: number;
  /** null for a `not_checked` limit. */
  resets_at: string | null;
  reached: boolean;
  /** not_checked: a property limit whose key the request did not send. */
  status: "ok" | "reached" | "not_checked";
}

export interface SpendLimitInput {
  organizationId: string;
  businessId: string;
  customerId: string;
  meterId: string | null;
  currency: string;
  scope: Record<string, string> | null;
  estimateMinor: bigint | null;
}

export interface SpendLimitEvaluator {
  evaluate(tx: Tx, input: SpendLimitInput): Promise<SpendLimitHit[]>;
}

export const noopSpendLimitEvaluator: SpendLimitEvaluator = {
  evaluate: async () => [],
};

/** The usage-controls evaluator, imported lazily (usage-controls reads credits). */
export const defaultSpendLimitEvaluator: SpendLimitEvaluator = {
  evaluate: async (tx, input) =>
    (await import("@/modules/usage-controls/limits")).evaluateSpendLimits(tx, input),
};

let current: SpendLimitEvaluator = defaultSpendLimitEvaluator;

export function spendLimitEvaluator(): SpendLimitEvaluator {
  return current;
}

/** Replace the evaluator (a test). null restores the default. */
export function setSpendLimitEvaluator(e: SpendLimitEvaluator | null): void {
  current = e ?? defaultSpendLimitEvaluator;
}
