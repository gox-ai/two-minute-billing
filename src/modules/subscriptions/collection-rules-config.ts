/**
 * Collection rules (2.12, 2.15), stored beside the other billing rules in
 * `businesses.billing_rules_config`:
 *
 *   { partial_payment_write_off?: { "USD": 100, … }, partial_payment_write_off_max_percent?: 1–10,
 *     declined_refund?: "block" | "issue_credit" }
 *
 * Pure resolver; null, absent or malformed resolves to today's behaviour: no write-off,
 * and a declined refund leaves the money with the business (`block`).
 */

/** What happens when a refund the gateway accepted is later declined or returned. */
export type DeclinedRefundOutcome = "block" | "issue_credit";
export const DECLINED_REFUND_OUTCOMES = ["block", "issue_credit"] as const;

/**
 * One offline payment's shortfall, chosen by the operator. `write_off` stays inside the
 * business's limit (refused above it); `leave_due` never writes off. Omitted = the rule.
 */
export type ShortfallChoice = "write_off" | "leave_due";
export const SHORTFALL_CHOICES = ["write_off", "leave_due"] as const;

/** The largest tolerance the API accepts, in minor units. */
export const MAX_WRITE_OFF_MINOR = 100_000;
export const WRITE_OFF_PERCENT = { min: 1, max: 10, default: 2 } as const;

export interface CollectionRulesConfig {
  /** Currency (upper case) → the largest shortfall, in minor units, written off. Empty = off. */
  partialPaymentWriteOff: Readonly<Record<string, number>>;
  /** The shortfall must also be at most this percent of the invoice total. */
  partialPaymentWriteOffMaxPercent: number;
  declinedRefund: DeclinedRefundOutcome;
}

function obj(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function parseTolerances(raw: unknown): Readonly<Record<string, number>> {
  const src = obj(raw);
  if (!src) return {};
  const out: Record<string, number> = {};
  for (const [cur, v] of Object.entries(src))
    if (
      /^[A-Z]{3}$/.test(cur) &&
      typeof v === "number" &&
      Number.isSafeInteger(v) &&
      v > 0 &&
      v <= MAX_WRITE_OFF_MINOR
    )
      out[cur] = v;
  return out;
}

export function resolveCollectionRulesConfig(
  biz: { billingRulesConfig?: unknown } | null | undefined,
): CollectionRulesConfig {
  const cfg = obj(biz?.billingRulesConfig);
  const declined = cfg?.declined_refund;
  return {
    partialPaymentWriteOff: parseTolerances(cfg?.partial_payment_write_off),
    partialPaymentWriteOffMaxPercent: ((p) =>
      typeof p === "number" &&
      Number.isInteger(p) &&
      p >= WRITE_OFF_PERCENT.min &&
      p <= WRITE_OFF_PERCENT.max
        ? p
        : WRITE_OFF_PERCENT.default)(cfg?.partial_payment_write_off_max_percent),
    declinedRefund: declined === "issue_credit" ? "issue_credit" : "block",
  };
}

export function serializeCollectionRulesConfig(c: CollectionRulesConfig) {
  return {
    partial_payment_write_off: { ...c.partialPaymentWriteOff },
    partial_payment_write_off_max_percent: c.partialPaymentWriteOffMaxPercent,
    declined_refund: c.declinedRefund,
  };
}

/**
 * The shortfall to write off after a part payment, or 0n. It must be at most the currency's
 * amount AND at most the percent of the invoice total, so an instalment or a token payment
 * never settles an invoice. A credit purchase is never written off: it would grant credit
 * nobody paid for.
 */
export function shortfallToWriteOff(
  c: CollectionRulesConfig,
  inv: { currency: string; totalMinor: bigint; purpose?: string | null },
  remainingMinor: bigint,
): bigint {
  if (inv.purpose === "credit_purchase" || remainingMinor <= 0n) return 0n;
  const max = c.partialPaymentWriteOff[inv.currency.toUpperCase()];
  if (max === undefined || remainingMinor > BigInt(max)) return 0n;
  return remainingMinor * 100n <= inv.totalMinor * BigInt(c.partialPaymentWriteOffMaxPercent)
    ? remainingMinor
    : 0n;
}

/** A person's new business issues credit for a declined refund. API-created ones keep `block`. */
export function withInitialCollectionRules(
  base: Record<string, unknown> | undefined,
  creator: { hasOperator?: boolean },
): Record<string, unknown> | undefined {
  if (creator.hasOperator !== true) return base;
  return { ...(base ?? {}), declined_refund: "issue_credit" };
}
