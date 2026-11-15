/**
 * The access check (design G3 §3.9): "may this customer spend now?". One read-only snapshot, no
 * locks, no writes, no events. Evaluation order, first failure wins: no_subscription →
 * not_entitled → spend_limit_reached → in_flight_limit → insufficient_credit → ok.
 * A meter with a credit cost answers in units, from the figure the gate offers
 * (`unitBalanceView`), and needs no subscription.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { stampNow } from "@/platform/clock";
import { withTenant, type Tx } from "@/platform/db";
import { formatFixed12, parseFixed12 } from "@/platform/fixed";
import {
  features,
  planEntitlements,
  prices,
  subscriptionEntitlements,
  subscriptionItems,
  subscriptions,
} from "@db/schema";
import { resolveUsageKeys } from "@/modules/metering/meters";
import {
  grantRenewsAt,
  liveAt,
  liveBalance,
  loadBalanceSnapshot,
  serializeAvailableUnits,
  type LiveBalance,
} from "./balance";
import { allowanceUse, resolveAllowanceSchedule, type CreditsItem } from "./allowance";
import { ensureCreditWindows } from "./credit-clock";
import type { CreditReset } from "@db/schema";
import { livePlanCredits, loadCreditContext, resolveMeter } from "./holds";
import {
  ACCESS_MESSAGES,
  CREDIT_CONFIG_DEFAULTS,
  effectivePolicy,
  inFlightRefused,
  type AccessCode,
  type EffectivePolicy,
} from "./policy";
import { spendLimitEvaluator, type SpendLimitHit } from "./spend-limits";
import { defaultEstimateSteps, formatCostE6, type CostSource } from "./credit-cost";
import { formatSteps } from "./units";
import { LIVE_SUBSCRIPTION_STATUSES, liveMeteredItems, ratedUnbilledUsage } from "./usage";

export interface AccessResult {
  allowed: boolean;
  code: AccessCode;
  message: string;
  customer: string;
  meter: string | null;
  currency: string;
  available_minor: number;
  available_units: Array<{
    unit: string;
    units: number;
    /** A unit with no money rate, in the unit's smallest step. */
    held_units?: number;
    unsettled_units?: number;
  }>;
  balance: {
    grants_minor: number;
    unbilled_usage_minor: number;
    open_holds_minor: number;
    overdraft_limit_minor: number;
  };
  on_exhausted: EffectivePolicy;
  usage_this_period: { quantity: string };
  cost_this_period_minor: number;
  limits: SpendLimitHit[];
  entitlement: { feature: string; value: string; used: string; resets_at: string | null } | null;
  /** The soonest renewal of a live plan credit grant (G3b). */
  renews_at: string | null;
  /** Set for a meter that is paid in credits; amounts are in the unit, as decimal text. */
  credits: {
    unit: string;
    credits_per_unit: string;
    cost_source: CostSource;
    /** What the estimate costs. */
    estimate: string;
    /** What the customer can spend now: the open holds are already taken off. */
    available: string;
    /** Reserved by open holds. */
    held: string;
    /** Taken by usage events and not drawn from a credit grant yet. */
    unsettled: string;
    /** `available` less the estimate, never below 0. */
    remaining: string;
  } | null;
  as_of: string;
}

function planCreditsRenewAt(bal: LiveBalance, now: Date): string | null {
  return (
    bal.grants
      .filter((g) => liveAt(g, now))
      .map(grantRenewsAt)
      .filter((d): d is string => !!d)
      .sort()[0] ?? null
  );
}

export class AccessInputError extends Error {
  constructor(
    message: string,
    readonly notFound = false,
  ) {
    super(message);
    this.name = "AccessInputError";
  }
}

/**
 * A meter feature's grant on the subscription (override beats plan; quota max, unlimited wins),
 * with its reset (G3b): the override's, else the plan's; a credits link resolved for this
 * subscription.
 */
export async function meterFeature(
  tx: Tx,
  subscriptionId: string,
  meterId: string,
  featureKey?: string,
): Promise<{
  id: string;
  key: string;
  type: string;
  value: string | null;
  reset: CreditReset | null;
  /** A linked reset: the credits item whose windows the allowance counts. */
  creditsItem: CreditsItem | null;
} | null> {
  const feats = await tx
    .select({ id: features.id, key: features.key, type: features.type })
    .from(features)
    .where(
      and(
        eq(features.meterId, meterId),
        eq(features.active, true),
        featureKey ? eq(features.key, featureKey) : undefined,
      ),
    );
  if (!feats.length) return null;
  const ids = feats.map((f) => f.id);
  const over = await tx
    .select({
      featureId: subscriptionEntitlements.featureId,
      value: subscriptionEntitlements.value,
      reset: subscriptionEntitlements.reset,
    })
    .from(subscriptionEntitlements)
    .where(
      and(
        eq(subscriptionEntitlements.subscriptionId, subscriptionId),
        inArray(subscriptionEntitlements.featureId, ids),
      ),
    );
  const plan = await tx
    .select({
      featureId: planEntitlements.featureId,
      productId: planEntitlements.productId,
      value: planEntitlements.value,
      reset: planEntitlements.reset,
    })
    .from(planEntitlements)
    .innerJoin(prices, eq(prices.productId, planEntitlements.productId))
    .innerJoin(subscriptionItems, eq(subscriptionItems.priceId, prices.id))
    .where(
      and(
        eq(subscriptionItems.subscriptionId, subscriptionId),
        inArray(planEntitlements.featureId, ids),
      ),
    );
  const f = feats[0]!;
  const rows = plan.filter((r) => r.featureId === f.id);
  const planRow = rows.find((r) => r.reset);
  const none = { reset: null, creditsItem: null };
  const planSched = planRow
    ? await resolveAllowanceSchedule(tx, subscriptionId, planRow.reset, [planRow.productId])
    : none;
  const base = { id: f.id, key: f.key, type: f.type };
  const o = over.find((r) => r.featureId === f.id);
  if (o) {
    const own = o.reset
      ? await resolveAllowanceSchedule(
          tx,
          subscriptionId,
          o.reset,
          rows.map((r) => r.productId),
        )
      : none;
    return { ...base, value: o.value, ...(own.reset ? own : planSched) };
  }
  const vals = rows.map((r) => r.value);
  if (!vals.length) return { ...base, value: null, ...none };
  if (f.type === "switch")
    return { ...base, value: vals.includes("true") ? "true" : "false", ...none };
  if (vals.includes("unlimited")) return { ...base, value: "unlimited", ...planSched };
  const n = Math.max(...vals.map((v) => Number.parseInt(v, 10)).filter(Number.isFinite), 0);
  return { ...base, value: String(n), ...planSched };
}

/** Entitled when on (switch), unlimited, or used + 1 ≤ limit. */
export function meterFeatureAllows(value: string | null, type: string, used: string): boolean {
  if (value == null) return false;
  if (type === "switch") return value === "true";
  if (value === "unlimited") return true;
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit)) return false;
  return parseFixed12(used) + parseFixed12("1") <= parseFixed12(String(limit));
}

export async function checkAccess(input: {
  organizationId: string;
  businessId: string;
  customerId?: string;
  customerKey?: string;
  meterKey?: string | null;
  estimateMinor?: bigint | null;
  /** A meter with a credit cost: the estimate as a meter quantity, or as credits. */
  estimateQuantity?: string | null;
  estimateUnits?: string | null;
  scope?: Record<string, string> | null;
}): Promise<AccessResult> {
  // Grant the reset windows that are due first, in their own transaction: the check reads one
  // snapshot and writes nothing (G3b §3.3).
  const resolvedId = await withTenant(input.organizationId, async (tx) => {
    const id =
      input.customerId ??
      (input.customerKey
        ? ((await resolveUsageKeys(tx, input.businessId, [input.customerKey])).get(
            input.customerKey,
          ) ?? null)
        : null);
    if (id) await ensureCreditWindows(tx, { customerId: id, now: stampNow(input.businessId) });
    return id;
  });
  return withTenant(
    input.organizationId,
    async (tx) => {
      const customerId = resolvedId;
      if (!customerId) throw new AccessInputError("No such customer", true);
      const ctx = await loadCreditContext(tx, input.businessId, customerId);
      if (!ctx) throw new AccessInputError("No such customer", true);
      const meter = input.meterKey
        ? await resolveMeter(tx, input.businessId, input.meterKey)
        : null;
      if (input.meterKey && !meter)
        throw new AccessInputError(`No such meter: ${input.meterKey}`, true);
      const now = stampNow(input.businessId);

      const unitHolds = meter ? await import("./unit-holds") : null;
      const cost = meter
        ? await unitHolds!.meterCreditCostFor(tx, { meterId: meter.id, customerId })
        : null;
      const inUnits = input.estimateQuantity != null || input.estimateUnits != null;
      if (
        cost &&
        (input.estimateMinor != null ||
          (input.estimateQuantity != null && input.estimateUnits != null))
      )
        throw new AccessInputError(
          "This meter is paid in credits. Send estimate_quantity or estimate_units, not both, and no estimate.",
        );
      if (!cost && inUnits)
        throw new AccessInputError(
          "estimate_quantity and estimate_units are for a meter that is paid in credits. Send estimate.",
        );
      const estimateSteps =
        cost && inUnits
          ? unitHolds!.requestedSteps(cost, {
              quantity: input.estimateQuantity,
              units: input.estimateUnits,
            })
          : null;
      if (cost && inUnits && estimateSteps === null)
        throw new AccessInputError(
          `${input.estimateUnits != null ? "estimate_units" : "estimate_quantity"} must be a number of 0 or more, with no more decimals than the unit has.`,
        );

      const items = meter ? await liveMeteredItems(tx, { customerId, meterId: meter.id }) : [];
      const [anySub] = meter
        ? []
        : await tx
            .select({ id: subscriptions.id, currency: subscriptions.currency })
            .from(subscriptions)
            .where(
              and(
                eq(subscriptions.customerId, customerId),
                inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
              ),
            )
            .limit(1);
      // A meter paid in credits has no priced item: the customer's live subscriptions, oldest
      // first, and of those the first whose plan has a feature for the meter.
      let creditSub: (typeof items)[number]["sub"] | null = null;
      if (cost && meter) {
        const live = await tx
          .select()
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.customerId, customerId),
              inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
              sql`${subscriptions.deletedAt} is null`,
            ),
          )
          .orderBy(subscriptions.createdAt, subscriptions.id);
        for (const s of live)
          if (await meterFeature(tx, s.id, meter.id)) {
            creditSub = s;
            break;
          }
        creditSub ??= live[0] ?? null;
      }
      const sub = items[0]?.sub ?? creditSub;
      const currency = (
        sub?.currency ??
        anySub?.currency ??
        ctx.customer.currency ??
        ctx.business.defaultCurrency ??
        "USD"
      ).toUpperCase();

      const snap = await loadBalanceSnapshot(tx, { customerId, currency, now });
      // Rate every item when grants may cover it; else only this meter (the response's cost).
      const blocking = ctx.business.creditConfig?.blocking_enabled === true;
      // Every item when grants may cover it or a block may spend the overdraft; else this meter only.
      const usage = await ratedUnbilledUsage(tx, {
        customerId,
        currency,
        asOf: now,
        ...(snap.grants.length || blocking || !meter ? {} : { meterId: meter.id, items }),
      });
      const bal: LiveBalance = await liveBalance(tx, {
        customerId,
        currency,
        now,
        businessConfig: ctx.business.creditConfig,
        customerSettings: ctx.customer.creditSettings,
        usage: snap.grants.length || blocking ? usage : [],
        snapshot: snap,
      });
      // This period's usage: a held invoice's closed window is not in it.
      const meterLines = meter ? usage.filter((l) => l.meterId === meter.id && !l.held) : [];
      const periodUsed = formatFixed12(
        meterLines.reduce((a, l) => a + parseFixed12(l.quantity), 0n),
      );
      const policy = effectivePolicy({
        businessConfig: ctx.business.creditConfig,
        customerSettings: ctx.customer.creditSettings,
        now,
        grants: snap.grants,
        meterPriceIds: meter ? items.map((i) => i.snap.publicId) : null,
        planCredits: await livePlanCredits(tx, customerId, sub?.id ?? null),
      });

      const feature = meter && sub ? await meterFeature(tx, sub.id, meter.id) : null;
      // The allowance counts its own reset window (G3b §3.5); with none, this period's usage.
      const allowance =
        feature && meter && sub && feature.type !== "switch"
          ? await allowanceUse(tx, {
              customerId,
              meterId: meter.id,
              subscription: sub,
              featureId: feature.id,
              value: feature.value,
              reset: feature.reset,
              creditsItem: feature.creditsItem,
              now,
            })
          : null;
      const ownWindow =
        !!feature?.reset || !!(feature && sub?.resetState?.allowance_changes?.[feature.id]);
      const used = allowance && ownWindow ? allowance.used : periodUsed;
      const limit = allowance ? allowance.limit : (feature?.value ?? null);
      const limits =
        sub || anySub
          ? await spendLimitEvaluator().evaluate(tx, {
              organizationId: input.organizationId,
              businessId: input.businessId,
              customerId,
              meterId: meter?.id ?? null,
              currency,
              scope: input.scope ?? null,
              estimateMinor: input.estimateMinor ?? null,
            })
          : [];
      const cfg = ctx.business.creditConfig ?? {};

      let code: AccessCode = "ok";
      let credits: AccessResult["credits"] = null;
      let onExhausted = policy;
      if (cost && meter) {
        // In units: the figure the gate offers at this instant. No subscription needed.
        const { shortTerms } = await import("./usage-gate");
        const { splitEventUnits } = await import("./credit-cost");
        const { unitBalanceView } = await import("./usage-settlement");
        const at = { customerId, unitId: cost.unitId, now };
        const view = await unitBalanceView(tx, at);
        // What the gate applies when the estimate is more than the balance.
        const terms = await shortTerms(tx, {
          businessId: input.businessId,
          meterId: meter.id,
          ...at,
        });
        onExhausted = terms.policy;
        const estimate =
          estimateSteps ?? defaultEstimateSteps(cost.aggregation, cost.costE6, cost.decimals);
        if (feature && !meterFeatureAllows(limit, feature.type, used)) code = "not_entitled";
        else if (limits.some((l) => l.reached)) code = "spend_limit_reached";
        else if (
          onExhausted.policy === "block" &&
          estimateSteps != null &&
          inFlightRefused({
            balanceBeforeHoldsMinor: view.beforeHolds,
            openHoldsMinor: view.held,
            amountMinor: estimateSteps,
            shareBps: cfg.in_flight_share_bps ?? CREDIT_CONFIG_DEFAULTS.in_flight_share_bps,
            applies: cfg.in_flight_applies,
          })
        )
          code = "in_flight_limit";
        else if (
          splitEventUnits({
            due: estimate,
            offered: view.raw,
            policy: onExhausted.policy,
            priced: terms.price !== null,
            floor: terms.floor,
          }).refused
        )
          code = "insufficient_credit";
        const fmt = (v: bigint) => formatSteps(v, cost.decimals);
        credits = {
          unit: cost.unitKey,
          credits_per_unit: formatCostE6(cost.costE6),
          cost_source: cost.source,
          estimate: fmt(estimate),
          available: fmt(view.offered),
          held: fmt(view.held),
          unsettled: fmt(view.unsettled),
          remaining: fmt(view.offered > estimate ? view.offered - estimate : 0n),
        };
      } else if (meter ? !sub : !anySub) code = "no_subscription";
      else if (feature && !meterFeatureAllows(limit, feature.type, used)) code = "not_entitled";
      else if (limits.some((l) => l.reached)) code = "spend_limit_reached";
      else if (
        policy.policy === "block" &&
        input.estimateMinor != null &&
        inFlightRefused({
          balanceBeforeHoldsMinor: bal.availableMinor + bal.openHoldsMinor,
          openHoldsMinor: bal.openHoldsMinor,
          amountMinor: input.estimateMinor,
          shareBps: cfg.in_flight_share_bps ?? CREDIT_CONFIG_DEFAULTS.in_flight_share_bps,
          applies: cfg.in_flight_applies,
        })
      )
        code = "in_flight_limit";
      else if (policy.policy === "block" && (input.estimateMinor ?? 1n) > bal.availableMinor)
        code = "insufficient_credit";

      return {
        allowed: code === "ok",
        code,
        message: ACCESS_MESSAGES[code],
        customer: ctx.customer.publicId,
        meter: meter?.key ?? null,
        currency,
        available_minor: Number(bal.availableMinor),
        available_units: bal.availableUnits.map(serializeAvailableUnits),
        balance: {
          grants_minor: Number(bal.grantsMinor),
          unbilled_usage_minor: Number(bal.unbilledUsageMinor),
          open_holds_minor: Number(bal.openHoldsMinor),
          overdraft_limit_minor: Number(bal.overdraftLimitMinor),
        },
        on_exhausted: onExhausted,
        usage_this_period: { quantity: periodUsed },
        cost_this_period_minor: Number(meterLines.reduce((a, l) => a + l.amountMinor, 0n)),
        limits,
        entitlement: feature
          ? {
              feature: feature.key,
              value: limit ?? feature.value ?? "false",
              used,
              resets_at: allowance?.resetsAt ?? null,
            }
          : null,
        renews_at: planCreditsRenewAt(bal, now),
        credits,
        as_of: now.toISOString(),
      };
    },
    { isolationLevel: "repeatable read" },
  );
}
