/**
 * What happens when a customer runs out of credit (design G3 §3.9, C2). Blocking is opt-in per
 * business; the first rung that answers wins.
 */
import type {
  BusinessCreditConfig,
  CreditOnExhausted,
  CustomerCreditSettings,
  PriceGrantsCredit,
} from "@db/schema";
import { grantApplies, liveAt, type BalanceGrant } from "./balance";

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
  in_flight_limit: "The customer has too many open holds.",
  no_subscription: "The customer has no subscription for this meter.",
  not_entitled: "The plan does not include this feature.",
};

export type PolicySource =
  | "business_blocking_off"
  | "customer_override"
  | "grant"
  | "plan_price"
  | "business_default";

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
  const blockGrant = input.grants.some(
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

/** Holds plus `amount` may use at most this share of the balance before holds (§3.7). */
export function inFlightRefused(input: {
  balanceBeforeHoldsMinor: bigint;
  openHoldsMinor: bigint;
  amountMinor: bigint;
  shareBps: number;
}): boolean {
  const cap = (input.balanceBeforeHoldsMinor * BigInt(input.shareBps)) / 10_000n;
  return input.openHoldsMinor + input.amountMinor > cap;
}
