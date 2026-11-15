/**
 * What happens when a customer runs out of credit (design G3 §3.9, C2). Blocking is opt-in per
 * business; the first rung that answers wins.
 */
import {
  AUTO_TOPUP_ON_HARD_DECLINE,
  CAPTURE_OVER_HOLD,
  NO_SUBSCRIPTION_OVERDRAFT,
  NO_SUBSCRIPTION_USAGE,
  TRIAL_USAGE,
  type AutoTopupOnHardDecline,
  type BusinessCreditConfig,
  type CaptureOverHold,
  type CreditOnExhausted,
  type CustomerCreditSettings,
  type InFlightApplies,
  type NoSubscriptionOverdraft,
  type NoSubscriptionUsage,
  type PriceGrantsCredit,
  type TrialUsage,
} from "@db/schema";
import { grantApplies, liveAt, ratedOnly, type BalanceGrant } from "./balance";

export type AccessCode =
  | "ok"
  | "insufficient_credit"
  | "spend_limit_reached"
  | "in_flight_limit"
  | "no_subscription"
  | "not_entitled";

/** In-app text (ASD-STE100). */
export const ACCESS_MESSAGES: Record<AccessCode, string> = {
  ok: "The customer can use this meter.",
  insufficient_credit: "The customer does not have sufficient credit.",
  spend_limit_reached: "The customer reached a spend limit.",
  in_flight_limit:
    "The open holds and this amount are more than the part of the balance that holds can use.",
  no_subscription: "The customer has no subscription for this meter.",
  not_entitled: "The plan does not include this feature.",
};

export type PolicySource =
  | "business_blocking_off"
  | "customer_override"
  | "grant"
  | "plan_price"
  | "business_default"
  /** A meter with a credit cost: no live subscription, so the rest is refused (`no_subscription_usage`). */
  | "no_subscription"
  /** A meter with a credit cost: the subscription is in a free trial (`trial_usage`). */
  | "trial";

export interface EffectivePolicy {
  policy: CreditOnExhausted;
  source: PolicySource;
}

/** Defaults for the absent keys of `businesses.credit_config`. */
export const CREDIT_CONFIG_DEFAULTS = {
  hold_default_seconds: 60,
  in_flight_share_bps: 5_000,
} as const;
export const MAX_HOLD_SECONDS = 86_400;
/** `no_subscription_invoice_after_days` bounds; absent = 30. */
export const NO_SUBSCRIPTION_INVOICE_DAYS = { min: 1, max: 90, default: 30 } as const;
/** `restore_expiry_months` bounds; absent = 12. */
export const RESTORE_EXPIRY_MONTHS = { min: 1, max: 120, default: 12 } as const;

export function effectivePolicy(input: {
  businessConfig: BusinessCreditConfig | null | undefined;
  customerSettings: CustomerCreditSettings | null | undefined;
  now: Date;
  /** Grants of the balance snapshot (active, any remaining, used-up included). */
  grants: BalanceGrant[];
  /** The meter's price public ids on the live subscription; null = no meter (any grant counts). */
  meterPriceIds: string[] | null;
  /** `grants_credit` of the live plan prices (the meter's subscription first). */
  planCredits: Array<PriceGrantsCredit | null | undefined>;
}): EffectivePolicy {
  const biz = input.businessConfig ?? {};
  if (biz.blocking_enabled !== true) return { policy: "bill", source: "business_blocking_off" };
  const cust = input.customerSettings;
  if (cust?.on_exhausted) {
    const until = cust.override_expires_at ? Date.parse(cust.override_expires_at) : null;
    if (until == null || Number.isNaN(until) || until > input.now.getTime())
      return { policy: cust.on_exhausted, source: "customer_override" };
  }
  const nowWindow = { start: input.now, end: new Date(input.now.getTime() + 1) };
  // A unit with no rate pays no money usage, so its grants do not set this policy.
  const blockGrant = ratedOnly(input.grants).some(
    (g) =>
      g.onExhausted === "block" &&
      liveAt(g, input.now) &&
      (input.meterPriceIds == null ||
        input.meterPriceIds.some((pricePublicId) =>
          grantApplies(g, { pricePublicId, window: nowWindow }),
        )),
  );
  if (blockGrant) return { policy: "block", source: "grant" };
  const plan = input.planCredits.find((c) => c?.on_exhausted)?.on_exhausted;
  if (plan) return { policy: plan, source: "plan_price" };
  return { policy: biz.on_exhausted_default ?? "bill", source: "business_default" };
}

/**
 * Holds plus `amount` may use at most this share of the balance before holds (§3.7).
 * `other_holds_open`: the share guards parallel work only, so a hold with no other hold open
 * is never refused here (the balance check still applies).
 */
export function inFlightRefused(input: {
  balanceBeforeHoldsMinor: bigint;
  openHoldsMinor: bigint;
  amountMinor: bigint;
  shareBps: number;
  applies?: InFlightApplies | null;
}): boolean {
  if (input.applies === "other_holds_open" && input.openHoldsMinor <= 0n) return false;
  const cap = (input.balanceBeforeHoldsMinor * BigInt(input.shareBps)) / 10_000n;
  return input.openHoldsMinor + input.amountMinor > cap;
}

/** The engine choices of `credit_config`, each resolved to the rule before its key when unset. */
export interface CreditEngineRules {
  trialUsage: TrialUsage;
  noSubscriptionUsage: NoSubscriptionUsage;
  noSubscriptionOverdraft: NoSubscriptionOverdraft;
  noSubscriptionInvoiceAfterDays: number;
  /** Null = the given-back credit never expires. */
  restoreExpiryMonths: number | null;
  autoTopupOnHardDecline: AutoTopupOnHardDecline;
  captureOverHold: CaptureOverHold;
}

const pick = <T extends string>(v: unknown, all: readonly T[], dflt: T): T =>
  (all as readonly unknown[]).includes(v) ? (v as T) : dflt;
const intIn = (v: unknown, b: { min: number; max: number; default: number }) =>
  typeof v === "number" && Number.isInteger(v) && v >= b.min && v <= b.max ? v : b.default;

export function resolveCreditEngineRules(
  cfg: BusinessCreditConfig | null | undefined,
): CreditEngineRules {
  const c = cfg ?? {};
  return {
    trialUsage: pick(c.trial_usage, TRIAL_USAGE, "refuse"),
    noSubscriptionUsage: pick(c.no_subscription_usage, NO_SUBSCRIPTION_USAGE, "block"),
    noSubscriptionOverdraft: pick(
      c.no_subscription_overdraft,
      NO_SUBSCRIPTION_OVERDRAFT,
      "needs_payment_method",
    ),
    noSubscriptionInvoiceAfterDays: intIn(
      c.no_subscription_invoice_after_days,
      NO_SUBSCRIPTION_INVOICE_DAYS,
    ),
    restoreExpiryMonths:
      c.restore_expiry_months === "never"
        ? null
        : intIn(c.restore_expiry_months, RESTORE_EXPIRY_MONTHS),
    autoTopupOnHardDecline: pick(
      c.auto_topup_on_hard_decline,
      AUTO_TOPUP_ON_HARD_DECLINE,
      "disable",
    ),
    captureOverHold: pick(c.capture_over_hold, CAPTURE_OVER_HOLD, "debt"),
  };
}

/** When credit given back at `now` expires: `restore_expiry_months` later, or never (null). */
export function restoreExpiresAt(
  cfg: BusinessCreditConfig | null | undefined,
  now: Date,
): Date | null {
  const months = resolveCreditEngineRules(cfg).restoreExpiryMonths;
  if (months == null) return null;
  const at = new Date(now);
  at.setUTCMonth(at.getUTCMonth() + months);
  return at;
}
