import { syncMeterBilling } from "./meter-billing";
import { and, asc, desc, eq, gt, inArray, sql, type Column, type SQL } from "drizzle-orm";
import { notDeleted } from "./deleted-sql";
import { currentEventContext } from "@/platform/event-context";
import { withTenant, type Tx } from "@/platform/db";
import { assertTestBusinessRoom } from "@/modules/tenancy/test-limits";
import { effectivePatch } from "@/platform/effective-patch";
import {
  auditSubscription,
  auditedSubscriptionUpdate,
  subscriptionSnapshot,
  snapshotSubscriptionById,
} from "./audit";
import { resolvePauseConfig } from "./pause-config";
import {
  FINAL_PERIOD_CREDIT_OPTION,
  resolveBillingRulesConfig,
  type PlanCreditCancelAtPeriodEnd,
  type PlanCreditPause,
  type SpecificDateFinalPeriod,
} from "./billing-rules-config";
import { resolveBackdatingConfig, isBackdateAllowed } from "./backdating-config";
import {
  clampLimit,
  countExpr,
  filterConditions,
  keysetCondition,
  kindsFromSpecs,
  opsFromSpecs,
  pageOrder,
  parseCursor,
  searchCondition,
  toPage,
  existsFieldCondition,
  type VirtualFilter,
  type FilterKind,
  type FilterSpec,
  type ListFilter,
  type ListPage,
  cappedTotal,
} from "@/platform/list-query";
import {
  alignTermStart,
  alignTrialEnd,
  billingModeFor,
  DEFAULT_BILLING_MODE,
  inclusiveBoundary,
  loadBillingMode,
  normalizeTermEnd,
  type BillingMode,
} from "@/modules/subscriptions/billing-mode";
import { localDatePartsInTz, midnightOnDateInTz, stampNow, startOfDayInTz } from "@/platform/clock";
import { publicId } from "@/platform/ids";
import { recordMrrMovement } from "@/modules/metrics/mrr-movements";
import { emitEvent, emitOrDefer, type DeferredEvents } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import {
  snapshotPrice,
  isOverridable,
  computeLineAmount,
  ratableFromSnapshot,
  alignSnapshotToCycle,
  cadenceMultiple,
  type PriceSnapshot,
  isMeteredPrice,
} from "@/modules/catalog/pricing";
import {
  applyExplicitDifferentials,
  resolveMandatoryAttachedItems,
} from "@/modules/catalog/service";
import { enforceMetadataRules, type MetadataRuleScope } from "@/modules/metadata-rules/service";
import {
  validateAndCoerce as coerceCustomFields,
  customFieldFilterSet,
  type CustomFieldDefinitionRow,
} from "@/modules/custom-fields/service";
import { monthlyRecurringMinor, monthlyNormalizedMinor } from "@/modules/metrics/mrr";
import { frozenStopBooking } from "@/modules/metrics/stocks";
import {
  subscriptions,
  subscriptionItems,
  prices,
  customers,
  products,
  unbilledCharges,
  invoices as invoicesTable,
  creditNotes as creditNotesTable,
  businesses,
  appliedCoupons,
  coupons,
  couponSetCodes,
  paymentMethods,
  payments,
  ledgerEntries,
  scheduledChanges,
  gatewayAccounts,
  renewalSkips,
} from "@db/schema";
import { resolveAssignableAddress } from "@/modules/customers/addresses";
import { accountHolderName } from "@/modules/customers/names";
import { accountHolderNameSql } from "@/modules/customers/name-sql";
import { apiStatusSql } from "./status-sql";
import { creditNoteSpendable } from "@/modules/credit-notes/serialize";

// In `./interval` so invoicing can use them without importing this module.
export { addInterval, type Interval } from "./interval";
import { addInterval, type Interval } from "./interval";
import { settleMeteredUsage } from "./usage-settlement";
import { bookEarlyEndCommitment, freshSegments } from "./commitment";
import {
  newTermFields,
  nextSubPeriodEnd,
  subPeriodFields,
  supportsMonthlyUsage,
} from "./sub-periods";

/**
 * Subscription status vocabulary (Phase F) — the state diagram from
 * architecture §4.1: a future-dated create sits in `future` until
 * its start date; trials are `in_trial`; a running sub is `active`; `paused` skips
 * billing; `cancelled` is terminal. There is NO `past_due` sub status — dunning is
 * invoice-side (a sub stays `active` while its invoice duns; dues are surfaced by
 * SUB-3 computed fields), and dunning-exhaust applies the configured final action.
 *
 * `non_renewing` is DERIVED at the API boundary (not stored): an `active` sub that
 * will cancel at term end — either `cancel_at_period_end` was set or its
 * `remaining_billing_cycles` reached 0 (SUB-2/SUB-4). The stored status stays
 * `active`; the flags carry the intent.
 */
// `StoredSubscriptionStatus`/`ApiSubscriptionStatus`/`apiSubscriptionStatus` moved
// to `./serialize` (events/content.ts needs them and must never import this
// file — it imports `emitEvent`, which would close the
// serialize → service → events/emit → events/content cycle). Re-exported here
// so existing importers of `subscriptions/service` are unaffected.
import {
  type StoredSubscriptionStatus,
  type ApiSubscriptionStatus,
  apiSubscriptionStatus,
} from "./serialize";
export { type StoredSubscriptionStatus, type ApiSubscriptionStatus, apiSubscriptionStatus };

/** Stored statuses the billing clock renews (period roll-forward). */
export const RENEWABLE_STATUSES = ["in_trial", "active"] as const;

export class SubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionError";
  }
}

const cadenceLabel = (count: number, unit: string) => (count === 1 ? unit : `${count} ${unit}s`);

/**
 * Guard: every RECURRING item must bill on a cadence that DIVIDES the
 * subscription's cycle — the "billing cycle for addons" rule.
 *
 * A subscription still has exactly one cycle (`billing_period` +
 * `billing_period_unit`); there is no per-item cadence anywhere in the engine. What
 * changed on 2026-08-05 is that an item billing MORE often than the cycle is no
 * longer refused: it is folded into the cycle by `alignSnapshotToCycle`, which
 * scales its amount by `cadenceMultiple` (a ₹475/month add-on on a yearly plan →
 * ₹5,700 once a year). The invoice then prints one unit of "Additional Connections"
 * at ₹5,700 on an annual billing period.
 *
 * The rule is ONE-DIRECTIONAL, and the reverse is still an error:
 *  - monthly item on a yearly plan → allowed, ×12,
 *  - **yearly item on a monthly plan → refused** — the cycle ends before the item's
 *    period does, so there is no "amount for one cycle" to charge. Rating it anyway
 *    is the original 12× overcharge this guard was written for.
 *  - a non-divisor either way (5-month item, 12-month cycle) → refused.
 *
 * Only flat/per-unit amounts can be scaled, so tiered/volume/package/percentage
 * items still require an exact cadence match (`alignSnapshotToCycle` explains why).
 *
 * Returns the operator-facing reason, or null when the price is fine. It returns
 * rather than throws because the callers raise different error types
 * (`SubscriptionError` vs `ProrationError`).
 *
 * One-time prices carry no interval and are always allowed. A PLAN price is the
 * caller's business: changing a plan's interval is a frequency change, which
 * resets the term instead of being rejected — so plan items are not passed here.
 */
export function cadenceMismatch(
  price: {
    type: string;
    interval: string | null;
    intervalCount: number | null;
    publicId: string;
    model?: string;
    usageAggregation?: string | null;
  },
  interval: string,
  intervalCount: number,
  /** The subscription bills usage every month: a monthly metered price fits its term. */
  opts: { monthlyUsage?: boolean } = {},
): string | null {
  if (price.type !== "recurring") return null;
  const priceInterval = price.interval ?? "month";
  const priceCount = price.intervalCount ?? 1;
  if (priceInterval === interval && priceCount === intervalCount) return null;
  if (
    opts.monthlyUsage &&
    priceInterval === "month" &&
    priceCount === 1 &&
    price.model != null &&
    isMeteredPrice({ model: price.model, usageAggregation: price.usageAggregation ?? null })
  )
    return null;
  const multiple = cadenceMultiple({ interval, intervalCount }, price);
  const itemLabel = cadenceLabel(priceCount, priceInterval);
  const cycleLabel = cadenceLabel(intervalCount, interval);
  // Divides the cycle exactly AND carries a single scalable amount → fold it in.
  if (multiple != null && price.model != null && isOverridable(price.model)) return null;
  if (multiple != null) {
    return (
      `Billing period mismatch: price ${price.publicId} bills every ${itemLabel}, but the subscription ` +
      `bills every ${cycleLabel}. Usually we multiply the amount of a shorter-cadence item by ${multiple} ` +
      `to fit it into the cycle. This is a ${price.model} price, and its tiers, package or percentage ` +
      `cannot be multiplied by ${multiple} with one clear result. ` +
      `Use the ${cycleLabel} price for this item, or put it on its own subscription.`
    );
  }
  return (
    `Billing period mismatch: price ${price.publicId} bills every ${itemLabel}, ` +
    `but the subscription bills every ${cycleLabel}. An item may bill more often than the ` +
    `subscription only when its period divides the cycle exactly. For example, a monthly add-on on a yearly ` +
    `plan bills 12× its rate once a year. An item may never bill LESS often, because the cycle would ` +
    `end before the period of the item ends. ` +
    `Use the ${cycleLabel} price for this item, or put it on its own subscription.`
  );
}

/** Days in a calendar month (`month` 0-based), the clamp for a day-31 anchor. */
const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/**
 * The next calendar billing anchor for a day-of-month (CUST-5). Returns the soonest
 * instant strictly after `now` landing on `day` (clamped to the month's length, so
 * 31 → Feb 28/29). Used when a customer has a manually-set billing date.
 *
 * "The 15th" is a date in the BUSINESS's zone, so the anchor is local midnight there —
 * not 00:00 UTC, which is 05:30 on the 15th in Asia/Kolkata and 20:00 on the 14th in
 * New York. A day-anchored business would otherwise carry that offset in its term
 * boundary forever (`advancePeriod` preserves the time of day), so every renewal, every
 * "next billing" date and every whole-day proration boundary sat off midnight — the
 * credit stopped being a whole number of days. Businesses on the default UTC timezone
 * are unaffected: local midnight IS 00:00 UTC there.
 */
export function calendarAnchorFor(now: Date, day: number, timeZone: string): Date {
  const at = (year: number, month: number) =>
    midnightOnDateInTz(year, month, Math.min(day, daysInMonth(year, month)), timeZone);
  const { year, month } = localDatePartsInTz(now, timeZone);
  const candidate = at(year, month);
  if (candidate > now) return candidate;
  return month === 11 ? at(year + 1, 0) : at(year, month + 1);
}

/**
 * Advance a billing period by one interval, re-aligning to a persisted calendar
 * anchor day when there is one (CUST-5 review fix). Naive `addInterval` drifts:
 * a day-31 anchor clamped to Feb-28 would then renew to Mar-28, Apr-28, … losing
 * the 31st forever. For month/year cadences with an anchor day we instead advance
 * the month/year off day-1 (so JS can't roll a 31st into the next month) and set
 * the day to min(anchorDay, daysInThatMonth).
 * Non-anchored subscriptions (and day/week cadences) keep plain `addInterval`.
 *
 * `anchorDay` is a day of the month in the BUSINESS's zone, so the re-alignment happens
 * on the local calendar and rebuilds the instant from local midnight + the period
 * start's local time of day. On a day-anchored business that time of day is zero, which
 * is what keeps its terms on midnight; `mode` is required rather than optional so no
 * call site can quietly fall back to UTC and re-open that gap. For a business in UTC
 * (the default) this is arithmetically the same as the UTC-only version it replaced.
 */
export function advancePeriod(
  periodStart: Date,
  unit: Interval,
  count: number,
  anchorDay: number | null | undefined,
  mode: BillingMode,
): Date {
  if (anchorDay == null || (unit !== "month" && unit !== "year"))
    return addInterval(periodStart, unit, count);
  const tz = mode.timezone;
  const { year, month } = localDatePartsInTz(periodStart, tz);
  const timeOfDayMs = periodStart.getTime() - startOfDayInTz(periodStart, tz).getTime();
  // Advance off day 1 of the LOCAL month so a 31st can't roll into the next month, then
  // clamp the anchor to the target month's length.
  const target = new Date(Date.UTC(year, month + (unit === "year" ? 12 * count : count), 1));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth();
  const boundary = midnightOnDateInTz(ty, tm, Math.min(anchorDay, daysInMonth(ty, tm)), tz);
  return new Date(boundary.getTime() + timeOfDayMs);
}

export interface SubscriptionItemInput {
  price: typeof prices.$inferSelect;
  quantity: number;
  /** Subscription-level custom price (overrides the catalog flat/per-unit amount). */
  customAmountMinor?: number | null;
  /** CAT-7: override the tier table (tiered differential price). */
  customTiers?: unknown;
  /** CP-4 item depth. */
  freeQuantity?: number | null;
  billingCycles?: number | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Sum the monthly-normalized recurring revenue of a set of items (CP-4 cached MRR).
 *
 * When an item carries a `price_snapshot`, rate from the snapshot — NOT the live
 * catalog price. Add-ons attached with a plan-scoped differential have a
 * catalog base of 0 with the resolved amount (e.g. 4900) frozen only in the
 * snapshot; a subscription-level custom price lives there too. Rating from the
 * live price would drop that revenue. Per-unit items multiply by quantity via
 * `computeLineAmount`. Items without a snapshot (e.g. migration import) fall back
 * to the live price.
 */
export function computeSubscriptionMrr(
  items: Array<{
    price: typeof prices.$inferSelect;
    quantity: number;
    snapshot?: PriceSnapshot | null;
    /** The item's own `free_quantity`; null/absent falls back to the price's. */
    freeQuantity?: number | null;
  }>,
): bigint {
  return items.reduce((s, i) => {
    const snap = i.snapshot ?? null;
    const type = snap?.type ?? i.price.type;
    if (type !== "recurring") return s;
    const model = snap?.model ?? i.price.model;
    // variable/metered — not committed recurring revenue
    if (
      isMeteredPrice({
        model,
        usageAggregation: snap?.usageAggregation ?? i.price.usageAggregation,
      })
    )
      return s;
    if (snap) {
      const periodAmount = computeLineAmount(ratableFromSnapshot(snap, i.freeQuantity), i.quantity);
      if (periodAmount <= 0n) return s;
      return (
        s + monthlyNormalizedMinor(periodAmount, snap.interval ?? "month", snap.intervalCount ?? 1)
      );
    }
    return (
      s +
      monthlyRecurringMinor(
        { ...i.price, freeQuantity: i.freeQuantity ?? i.price.freeQuantity },
        i.quantity,
      )
    );
  }, 0n);
}

/** One active `applied_coupons` row, joined to its coupon (null for manual rows). */
export interface ActiveDiscountForMrr {
  source: string; // coupon | manual
  remainingPeriods: number | null;
  /** Span in BILLING periods the discount was created with; null = unlimited. */
  totalPeriods: number | null;
  manualKind: string | null;
  manualPercentOffBps: number | null;
  manualAmountOffMinor: bigint | null;
  manualCurrency: string | null;
  coupon: {
    kind: string;
    percentOffBps: number | null;
    amountOffMinor: bigint | null;
    currency: string | null;
    durationType: string;
  } | null;
}

/**
 * Pick the discounts that net into reported MRR and project them onto the shape
 * `netMrrForDiscounts` consumes — the ONE place that decides "does this discount
 * restate steady-state recurring revenue?".
 *
 * **The rule: a discount nets into MRR when it recurs, i.e. when it spans MORE
 * THAN ONE billing period.** A discount that reduces exactly one upcoming invoice
 * is a one-off and leaves the recurring rate alone.
 *
 *     total_periods === null  → unlimited (forever)  → nets
 *     total_periods  >  1     → recurs               → nets
 *     total_periods <= 1      → one-off              → does not net
 *
 * Both discount sources go through the same test, because both exist on a real
 * book: coupon-sourced rows, and **manual** rows (`source='manual'`, no coupon —
 * also how an imported subscription-level `discounts[]` entry lands).
 *
 * One 12900/mo subscription per case:
 *
 *     forever 10% coupon           → mrr 11610  (× 0.9)
 *     forever fixed 12900 discount → mrr 0
 *     repeating 20%/2-period coupon→ mrr 10320  (× 0.8)
 *     limited_period 20%/6mo disc  → mrr 10320  (× 0.8)
 *     one_time 500 coupon/discount → mrr 12900
 *
 * The same rule from the other side: a limited-period coupon whose span covers
 * only ONE cycle of the subscription (12 months on a YEARLY plan) is a one-time
 * coupon for that subscription and is not included in MRR — which is why
 * `total_periods` is counted in BILLING periods, not in the discount's own time
 * unit.
 *
 * Two earlier versions of this rule are worth not re-deriving:
 *  - "forever only" (until 2026-08-08) understated nothing but MISSED every
 *    repeating/limited-period discount.
 *  - keying off `remaining_periods` instead of `total_periods` looks equivalent
 *    and is not: it counts DOWN, so a 6-period discount in its last period reads
 *    1 and would silently stop netting one renewal before it actually ends, and
 *    the cached `mrr` column would have to be recomputed on EVERY renewal to
 *    track the countdown. `total_periods` never moves, so the column only needs
 *    recomputing when a discount starts or ends.
 *
 * Missing the manual half of this (before 2026-08-07) overstated a real book: a
 * subscription whose standalone `forever` discount cancels its whole amount
 * ($22,714/yr off $22,714/yr) has MRR 0, and we reported the gross $1,892.83/mo.
 */
/**
 * The subscription's billing term, or a loud failure.
 *
 * Since 2026-08-25 only a TRIALLING subscription lacks one (trial and term are mutually
 * exclusive), so every billing path that has already established the
 * subscription is active can call this. It exists so those paths state the invariant
 * instead of scattering `!` — a `!` says "trust me", this says which rule makes it true and
 * fails at the boundary if the rule ever stops holding, rather than on a null date deep
 * inside invoice planning.
 */
/**
 * The subscription's billing term if it HAS one, else null — for the paths that legitimately
 * run against both a trialling and an active subscription and must branch, rather than the
 * post-activation paths that can assert. Kept beside `requireTerm` so the two read as one
 * decision: assert when the caller already knows, ask when it genuinely doesn't.
 */
export function termOrNull(sub: {
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}): { start: Date; end: Date } | null {
  return sub.currentPeriodStart && sub.currentPeriodEnd
    ? { start: sub.currentPeriodStart, end: sub.currentPeriodEnd }
    : null;
}

export function requireTerm(sub: {
  publicId: string;
  status: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}): { start: Date; end: Date } {
  if (!sub.currentPeriodStart || !sub.currentPeriodEnd) {
    throw new Error(
      `subscription ${sub.publicId} has no billing term (status ${sub.status}) — ` +
        `a trialling subscription has none; bill it only after the trial converts`,
    );
  }
  return { start: sub.currentPeriodStart, end: sub.currentPeriodEnd };
}

/**
 * The instant the NEXT bill lands on — the only boundary a caller usually wants.
 *
 * Trial and term became mutually exclusive on 2026-08-25: a trialling
 * subscription has no `current_period_*`, and its next bill is at `trial_end`; everything
 * else bills at `current_period_end`. Before that, `current_period_end` doubled as both and
 * every caller could read one field.
 *
 * Returns null only for a subscription that has neither — a `future` one that has not
 * started, or a cancelled trial whose window was collapsed.
 */
export function nextBillingBoundary(sub: {
  status: string;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
}): Date | null {
  return sub.status === "in_trial" ? sub.trialEnd : sub.currentPeriodEnd;
}

export function discountsForMrr(rows: ActiveDiscountForMrr[]): Array<{
  kind: string;
  percentOffBps: number | null;
  amountOffMinor: bigint | null;
  currency: string | null;
}> {
  const out: Array<{
    kind: string;
    percentOffBps: number | null;
    amountOffMinor: bigint | null;
    currency: string | null;
  }> = [];
  for (const r of rows) {
    // Span in billing periods; null = unlimited. `total_periods` is authoritative,
    // but a row written before it existed (or by a site that forgot it) reads null,
    // and null-means-forever would silently OVERSTATE the discount on a `once`
    // coupon. Fall back to the coupon's own duration_type, which cannot be missing.
    const span =
      r.totalPeriods != null
        ? r.totalPeriods
        : r.coupon != null && r.coupon.durationType === "once"
          ? 1
          : null;
    if (span != null && span <= 1) continue;
    if (r.coupon) {
      out.push({
        kind: r.coupon.kind,
        percentOffBps: r.coupon.percentOffBps,
        amountOffMinor: r.coupon.amountOffMinor,
        currency: r.coupon.currency,
      });
      continue;
    }
    out.push({
      kind: r.manualKind === "fixed_amount" ? "fixed_amount" : "percentage",
      percentOffBps: r.manualPercentOffBps,
      amountOffMinor: r.manualAmountOffMinor,
      currency: r.manualCurrency,
    });
  }
  return out;
}

/**
 * Net a gross monthly-recurring figure against a subscription's currently active
 * discounts. Feed it the output of `discountsForMrr`, which owns the "which
 * discounts count" rule and carries the reasoning behind it.
 *
 * Percentage discounts are multiplicative on the running figure; fixed-amount
 * discounts are subtracted after normalizing the per-period amount to a monthly
 * one (a $22,714/yr discount is $1,892.83/mo), and the result floors at 0.
 *
 * Fixed amounts net BEFORE percentages, the invoice stack's fixed → % order; input
 * order is kept within each stage. Staged here, not left to the caller's row order:
 * an unordered query then made the same pair net to 2019 at write and 2012 on recompute.
 */
export function netMrrForDiscounts(
  grossMrr: bigint,
  activeForeverCoupons: Array<{
    kind: string;
    percentOffBps: number | null;
    amountOffMinor: bigint | null;
    currency: string | null;
  }>,
  billingInterval: string,
  billingIntervalCount: number,
): bigint {
  return applyStagedDiscounts(grossMrr, activeForeverCoupons, (off) =>
    monthlyNormalizedMinor(off, billingInterval, billingIntervalCount),
  );
}

/** Fixed amounts first (via `fixedOff`), then percentages half-up; floors at 0 after each step. */
function applyStagedDiscounts(
  gross: bigint,
  discounts: Array<{ kind: string; percentOffBps: number | null; amountOffMinor: bigint | null }>,
  fixedOff: (amountOffMinor: bigint) => bigint,
): bigint {
  let net = gross;
  const staged = [
    ...discounts.filter((c) => c.kind === "fixed_amount"),
    ...discounts.filter((c) => c.kind !== "fixed_amount"),
  ];
  for (const c of staged) {
    if (c.kind === "percentage") {
      const bps = BigInt(c.percentOffBps ?? 0);
      net = (net * (10000n - bps) + 5000n) / 10000n; // round half up
    } else if (c.kind === "fixed_amount" && c.amountOffMinor != null) {
      net -= fixedOff(c.amountOffMinor);
    }
    if (net < 0n) net = 0n;
  }
  return net;
}

/**
 * What one billing period charges for the recurring items, net of every discount that
 * spans more than one period (`discountsForMrr`), before tax. Not monthly-normalised and,
 * unlike MRR, not zeroed for trial/paused: it is what the subscription will be billed.
 * null when cancelled, or when an item recurs on a different cadence than the subscription
 * (no conversion is guessed).
 */
export function computeRecurringAmount(input: {
  status: string;
  billingPeriodUnit: string | null;
  billingPeriod: number | null;
  items: Array<{
    price: Pick<
      typeof prices.$inferSelect,
      | "type"
      | "model"
      | "interval"
      | "intervalCount"
      | "amountMinor"
      | "tiers"
      | "packageSize"
      | "freeUnits"
      | "percentageBps"
      | "freeQuantity"
    >;
    quantity: number;
    snapshot?: PriceSnapshot | null;
    /** The item's own `free_quantity`; null/absent falls back to the price's. */
    freeQuantity?: number | null;
  }>;
  discounts: ActiveDiscountForMrr[];
}): bigint | null {
  if (input.status === "cancelled") return null;
  const unit = input.billingPeriodUnit ?? "month";
  const count = input.billingPeriod ?? 1;
  let gross = 0n;
  for (const i of input.items) {
    const snap = i.snapshot ?? null;
    if ((snap?.type ?? i.price.type) !== "recurring") continue;
    if (isMeteredPrice(snap ?? i.price)) continue;
    const amount = snap
      ? computeLineAmount(ratableFromSnapshot(snap, i.freeQuantity), i.quantity)
      : computeLineAmount(
          { ...i.price, freeQuantity: i.freeQuantity ?? i.price.freeQuantity },
          i.quantity,
        );
    if (amount <= 0n) continue;
    const interval = snap ? (snap.interval ?? "month") : (i.price.interval ?? "month");
    const intervalCount = snap ? (snap.intervalCount ?? 1) : (i.price.intervalCount ?? 1);
    if (interval !== unit || intervalCount !== count) return null;
    gross += amount;
  }
  return applyStagedDiscounts(gross, discountsForMrr(input.discounts), (off) => off);
}

// The applied_coupons ⟕ coupons projection the discount rule reads; shared so the MRR
// recompute and the recurring-amount batch cannot drift apart.
const activeDiscountColumns = {
  source: appliedCoupons.source,
  remainingPeriods: appliedCoupons.remainingPeriods,
  totalPeriods: appliedCoupons.totalPeriods,
  manualKind: appliedCoupons.manualKind,
  manualPercentOffBps: appliedCoupons.manualPercentOffBps,
  manualAmountOffMinor: appliedCoupons.manualAmountOffMinor,
  manualCurrency: appliedCoupons.manualCurrency,
  couponKind: coupons.kind,
  couponPercentOffBps: coupons.percentOffBps,
  couponAmountOffMinor: coupons.amountOffMinor,
  couponCurrency: coupons.currency,
  couponDurationType: coupons.durationType,
};

function toActiveDiscountForMrr(r: {
  source: string;
  remainingPeriods: number | null;
  totalPeriods: number | null;
  manualKind: string | null;
  manualPercentOffBps: number | null;
  manualAmountOffMinor: bigint | null;
  manualCurrency: string | null;
  couponKind: string | null;
  couponPercentOffBps: number | null;
  couponAmountOffMinor: bigint | null;
  couponCurrency: string | null;
  couponDurationType: string | null;
}): ActiveDiscountForMrr {
  return {
    source: r.source,
    remainingPeriods: r.remainingPeriods,
    totalPeriods: r.totalPeriods,
    manualKind: r.manualKind,
    manualPercentOffBps: r.manualPercentOffBps,
    manualAmountOffMinor: r.manualAmountOffMinor,
    manualCurrency: r.manualCurrency,
    coupon:
      r.couponDurationType != null
        ? {
            kind: r.couponKind!,
            percentOffBps: r.couponPercentOffBps,
            amountOffMinor: r.couponAmountOffMinor,
            currency: r.couponCurrency,
            durationType: r.couponDurationType,
          }
        : null,
  };
}

/**
 * `computeRecurringAmount` for a page of subscriptions in two queries (items, discounts),
 * whatever the page size. Keyed by subscription uuid.
 */
export async function recurringAmountsForSubs(
  tx: Tx,
  subs: ReadonlyArray<Pick<Sub, "id" | "status" | "billingPeriod" | "billingPeriodUnit">>,
): Promise<Map<string, bigint | null>> {
  const out = new Map<string, bigint | null>();
  const ids = subs.filter((s) => s.status !== "cancelled").map((s) => s.id);
  for (const s of subs) out.set(s.id, null);
  if (ids.length === 0) return out;
  // In chunks: the forward-book measures pass every live subscription in the business, and
  // one statement binds at most 65,534 parameters (D4 load test, 1.2M subscriptions).
  const itemRows = [];
  const discountRows = [];
  for (let i = 0; i < ids.length; i += 5000) {
    const chunk = ids.slice(i, i + 5000);
    itemRows.push(
      ...(await tx
        .select({
          subscriptionId: subscriptionItems.subscriptionId,
          price: prices,
          quantity: subscriptionItems.quantity,
          snapshot: subscriptionItems.priceSnapshot,
          freeQuantity: subscriptionItems.freeQuantity,
        })
        .from(subscriptionItems)
        .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
        .where(inArray(subscriptionItems.subscriptionId, chunk))),
    );
    discountRows.push(
      ...(await tx
        .select({ subscriptionId: appliedCoupons.subscriptionId, ...activeDiscountColumns })
        .from(appliedCoupons)
        .leftJoin(coupons, eq(appliedCoupons.couponId, coupons.id))
        .where(
          and(inArray(appliedCoupons.subscriptionId, chunk), eq(appliedCoupons.status, "active")),
        )
        .orderBy(appliedCoupons.createdAt, appliedCoupons.id)),
    );
  }
  const items = new Map<string, Parameters<typeof computeRecurringAmount>[0]["items"]>();
  for (const r of itemRows) {
    const list = items.get(r.subscriptionId) ?? [];
    list.push({
      price: r.price,
      quantity: r.quantity,
      snapshot: r.snapshot as PriceSnapshot | null,
      freeQuantity: r.freeQuantity,
    });
    items.set(r.subscriptionId, list);
  }
  const discounts = new Map<string, ActiveDiscountForMrr[]>();
  for (const r of discountRows) {
    const list = discounts.get(r.subscriptionId) ?? [];
    list.push(toActiveDiscountForMrr(r));
    discounts.set(r.subscriptionId, list);
  }
  for (const s of subs) {
    if (s.status === "cancelled") continue;
    out.set(
      s.id,
      computeRecurringAmount({
        status: s.status,
        billingPeriodUnit: s.billingPeriodUnit,
        billingPeriod: s.billingPeriod,
        items: items.get(s.id) ?? [],
        discounts: discounts.get(s.id) ?? [],
      }),
    );
  }
  return out;
}

/** Single-subscription form of `recurringAmountsForSubs`, for the detail route. */
export async function recurringAmountForSubscription(
  organizationId: string,
  sub: Pick<Sub, "id" | "status" | "billingPeriod" | "billingPeriodUnit">,
): Promise<bigint | null> {
  return withTenant(
    organizationId,
    async (tx) => (await recurringAmountsForSubs(tx, [sub])).get(sub.id) ?? null,
  );
}

/**
 * Recompute a subscription's cached `mrr` column from its current items and
 * active `forever` coupons, and persist it.
 *
 * **A subscription that is `in_trial` persists 0**, not its plan rate: a trial has
 * not started generating recurring revenue, and the money the composition is worth
 * only becomes revenue when the trial converts. This is
 * stored, not applied at the API boundary, because `mrr` is FILTERED and SORTED
 * in SQL (`LIST_FILTERS` / `LIST_SORTS` below): zeroing it in `serialize.ts`
 * would leave `mrr[gt]=0` returning rows the screen renders as 0.00 and the MRR
 * sort ranking trials by a number nobody can see (that was the bug, 2026-08-03).
 * The trial→active transition MUST call this again — see `renewal.ts`
 * (`renewSubscription`, the trial-end conversion, and `startFutureSubscriptions`
 * for a future-dated sub whose trial elapsed) — or a converted subscription
 * reports 0 MRR forever, which is worse than the bug this closes.
 *
 * Call it from EVERY path that mutates the recurring composition or the cadence.
 * The column is what `serializeSubscription` reports and what the subscriptions
 * list sorts and filters on, so a missed call is a wrong revenue figure on screen,
 * not merely a stale cache. Callers, exhaustively:
 *  - coupon apply / remove AND manual-discount apply / remove (coupons/service.ts)
 *    — for any discount that nets, i.e. spans > 1 billing period; see `discountsForMrr`,
 *  - `consumeDiscount` when the last period burns (active → exhausted) and
 *    `restoreDiscountPeriod` when a void resurrects one (coupons/service.ts): the
 *    discount leaving/rejoining the active set is exactly when the rate changes.
 *    The intermediate decrements are deliberately NOT recompute points — the rule
 *    keys off `total_periods`, which does not move (see `discountsForMrr`),
 *  - `addSubscriptionItem` / `removeSubscriptionItem` (items.ts),
 *  - `changeSubscription` (proration.ts) — quantity, price, custom price AND the
 *    term-reset cadence change.
 * `createSubscription` (below) and the migration importer instead compute the
 * initial value INLINE with `computeSubscriptionMrr`, because they write `mrr` in
 * the same INSERT that creates the items — there is no row to update yet. The
 * importer must therefore apply the SAME netting by hand
 * (`netMrrForDiscounts(gross, discountsForMrr(…))`); it did not until
 * 2026-08-07, and imported a book at 10.2× the true MRR.
 *
 * The `changeSubscription` caller was MISSING until 2026-08-03. The previous
 * version of this comment asserted "item composition changes already recompute
 * inline at their own call sites", but proration.ts contained no MRR reference at
 * all, so every `/change` left the column describing the pre-change composition
 * (measured: an add-on quantity 6→7 at 20000/unit left `mrr` exactly 20000 low).
 * Always pass the transaction that made the composition write, so the recompute
 * cannot commit without it (or survive its rollback).
 */
export async function recomputeSubscriptionMrr(
  tx: Tx,
  subscriptionId: string,
  /**
   * When this move HAPPENED, for the movement ledger. Omitted → the column default
   * (wall clock), which is only right when the operation is happening now: a backdated
   * or late-running one would otherwise file its delta in the wrong period, and
   * `mrr_movements` has no way to correct a row after the fact.
   */
  occurredAt?: Date,
): Promise<bigint> {
  const [sub] = await tx
    .select({
      status: subscriptions.status,
      billingPeriod: subscriptions.billingPeriod,
      billingPeriodUnit: subscriptions.billingPeriodUnit,
      // For the movement ledger below: who moved, in what currency, and from what.
      organizationId: subscriptions.organizationId,
      businessId: subscriptions.businessId,
      customerId: subscriptions.customerId,
      currency: subscriptions.currency,
      mrr: subscriptions.mrr,
    })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))
    .limit(1);
  if (!sub) return 0n;

  /**
   * Append to the MRR movement ledger whenever this write actually moves the number.
   *
   * This function is the ONE place every mutation path funnels through, which is exactly
   * why the ledger is written here and nowhere else — a second writer would be a second
   * definition. `createSubscription` is the one exception and records its own opening
   * move, because it writes `mrr` in the INSERT that creates the items (no row to update).
   */
  const previousMrr = sub.mrr ?? 0n;
  const settle = async (next: bigint, status: string) => {
    await recordMrrMovement(tx, {
      organizationId: sub.organizationId,
      businessId: sub.businessId,
      subscriptionId,
      customerId: sub.customerId,
      currency: sub.currency,
      previousMinor: previousMrr,
      nextMinor: next,
      status,
      ...(occurredAt ? { occurredAt } : {}),
    });
    return next;
  };

  // In trial → 0 (see the doc comment). CANCELLED → 0 for the same reason: the
  // subscription generates no recurring revenue any more, so `mrr: 0`. The importer
  // has always written 0 for cancelled rows, so without this an engine-cancelled
  // subscription and an imported one disagreed
  // on the same screen. Reports that need the rate a churned subscription CARRIED
  // (the historical MRR series, cancellation MRR) re-derive it from its surviving
  // items — see `reportingMrrBySubscription` in metrics/mrr.ts.
  //
  // PAUSED → 0 as well (2026-08-19, operator ruling). A paused subscription raises no
  // invoices, so it earns nothing while it is paused. Until this it kept its full rate,
  // and three surfaces disagreed about what that meant: the reporting series
  // (`reportingMrrBySubscription`) took the stored value for every non-cancelled status
  // and therefore COUNTED paused; `migration/reconcile.ts` totals ACTIVE + NON_RENEWING
  // only and therefore EXCLUDED it; and the subscriptions list blanked the cell while
  // its own `mrr` filter and sort ran in SQL against the stored column, so `mrr[gt]=0`
  // returned rows rendered as `—`. Zeroing here is the single change that makes all of
  // them agree, because every one of them reads this column.
  //
  // Reversible by construction: `resumeSubscription` / `resumeSubscriptionWithOptions`
  // already call this function after writing `status = 'active'`, so resuming restates
  // the real rate from the items with no separate restore path to keep in sync.
  //
  // Read from the row rather than taken as an argument so EVERY caller — coupon
  // apply/remove, item add/remove, `/change`, and any future one — gets the rule
  // without having to know it exists; call this AFTER the status write in a
  // transition, so the new status is what it sees.
  //
  // `last_earning_mrr` (0271) is deliberately NOT touched here. It holds the netted rate
  // this subscription last carried while it was earning, and that is exactly the number a
  // zeroing transition must preserve rather than overwrite: the historical series reads it
  // for cancelled rows, and re-deriving the rate later cannot work because the discounts
  // that netted it do not survive the cancellation. Leaving it alone is also what makes
  // paused → cancelled correct — the pause already parked the pre-pause rate here, and the
  // cancellation must not replace it with the 0 the pause left in `mrr`.
  //
  // …EXCEPT when it is empty. A row that was earning since before 0271 and never recomputed
  // holds NULL, and zeroing it then lost the rate for good: history fell back to re-rating its
  // items at list price. The rate it carried up to this moment IS its last earning rate.
  if (sub.status === "in_trial" || sub.status === "cancelled" || sub.status === "paused") {
    await tx
      .update(subscriptions)
      .set({
        mrr: 0n,
        ...(previousMrr > 0n
          ? { lastEarningMrr: sql`coalesce(${subscriptions.lastEarningMrr}, ${previousMrr})` }
          : {}),
      })
      .where(eq(subscriptions.id, subscriptionId));
    return settle(0n, sub.status);
  }

  const rows = await tx
    .select({
      price: prices,
      quantity: subscriptionItems.quantity,
      snapshot: subscriptionItems.priceSnapshot,
      freeQuantity: subscriptionItems.freeQuantity,
    })
    .from(subscriptionItems)
    .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .where(eq(subscriptionItems.subscriptionId, subscriptionId));
  const gross = computeSubscriptionMrr(
    rows.map((r) => ({ ...r, snapshot: r.snapshot as PriceSnapshot | null })),
  );

  // leftJoin (not innerJoin): MANUAL discounts (source='manual') have no coupon
  // row — and an imported subscription-level `discounts[]` entry lands as one.
  // An innerJoin here silently reported gross MRR for every one of them.
  const activeDiscounts = await tx
    .select(activeDiscountColumns)
    .from(appliedCoupons)
    .leftJoin(coupons, eq(appliedCoupons.couponId, coupons.id))
    .where(
      and(eq(appliedCoupons.subscriptionId, subscriptionId), eq(appliedCoupons.status, "active")),
    )
    // Apply order within a stage: two percentages round per step, so order moves a unit.
    .orderBy(appliedCoupons.createdAt, appliedCoupons.id);

  const net = netMrrForDiscounts(
    gross,
    discountsForMrr(activeDiscounts.map(toActiveDiscountForMrr)),
    sub.billingPeriodUnit ?? "month",
    sub.billingPeriod ?? 1,
  );
  // The row is in an earning status, so `net` is both what it earns now and the last rate
  // it carried while earning — write both. A comped subscription nets to 0 and stores 0,
  // which is the point: when it later churns, history must value it at the ~nothing it was
  // billed, not at the list price its items still quote.
  await tx
    .update(subscriptions)
    .set({ mrr: net, lastEarningMrr: net })
    .where(eq(subscriptions.id, subscriptionId));
  return settle(net, sub.status);
}

/**
 * Create a subscription. The engine owns the period boundaries: it derives the
 * billing interval from the first recurring price and sets current_period_*
 * itself (no provider involved). Trials set status=trialing until trial_end.
 * Renewal/invoicing/proration land in the next increments.
 */
export async function createSubscription(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  now: Date;
  /**
   * Caller-supplied public id (name the subscription at signup).
   * Omitted → a fresh `sub_<nano>`. Unique per business, so a duplicate is a caller
   * error and is raised as `SubscriptionError` (→ 400) rather than left to trip
   * `subscriptions_biz_public_id_uq` as a 500.
   */
  publicId?: string;
  items: SubscriptionItemInput[];
  trialDays?: number;
  /**
   * An exact trial end, in place of `trialDays`: the instant it ends, or on a day-anchored
   * business the day it ends on. Must be after the start.
   */
  trialEnd?: Date;
  defaultPaymentMethodId?: string;
  /** Backdate/future-date the period start (defaults to `now`). */
  startDate?: Date;
  /** Calendar billing: end the FIRST period on this date, then align to it. */
  billingAnchor?: Date;
  /** CP-1/CP-4 commercial fields. */
  autoCollection?: "on" | "off";
  /** E2/INV-1: renew into a `pending` invoice (null = inherit business default). */
  createPendingInvoices?: boolean;
  /** Bill metered usage every month inside a longer term. Undefined = the plan price's. */
  billUsageMonthly?: boolean;
  /** Minimum commitment per term. Undefined = the plan price's; null = none. */
  commitmentAmountMinor?: bigint | null;
  netTermDays?: number;
  poNumber?: string;
  /** Ship-to: an `addr_…` id from this customer's address book. Absent = the default. */
  shippingAddressPublicId?: string;
  invoiceNotes?: string;
  /**
   * Credits Flexibility (0219), subscription half. The most of each bucket that may be
   * AUTO-applied to one invoice raised for this subscription, in minor units.
   * Undefined/null = no subscription cap (the default and
   * today's behaviour); `0n` = never auto-apply to this subscription. Combined with the
   * business's `credits_flexibility` by taking the TIGHTER of the two.
   */
  maxRefundableCreditsUsageMinor?: bigint | null;
  maxExcessPaymentUsageMinor?: bigint | null;
  metadata?: Record<string, unknown>;
  /** Custom-field values (SET-4). `cf_<name>` or bare `<name>`; validated on write. */
  customFields?: Record<string, unknown> | null;
  /** Hosted checkout only: it collects no custom fields, so Required ones are not enforced. */
  skipRequiredCustomFields?: boolean;
  /** How this business's metadata key rules apply to the write. Default `enforce`. */
  metadataRules?: MetadataRuleScope;
  /**
   * Opt-in deferral: when a buffer is supplied, the lifecycle events
   * (subscription_created / _started / _activated) are APPENDED to it instead of
   * being emitted, and the caller owns emitting them later. Used by the
   * auto-collect-ON signup, which must not make the subscription visible to
   * webhook consumers until its first charge is known good — a delivered webhook
   * cannot be unsent, so the event must never be written until then. Omit it and
   * this function behaves exactly as before.
   */
  deferEventsTo?: DeferredEvents;
}): Promise<{
  subscription: typeof subscriptions.$inferSelect;
  items: Array<typeof subscriptionItems.$inferSelect>;
}> {
  if (input.items.length === 0) {
    throw new SubscriptionError("A subscription needs at least one item");
  }

  // All items must share one currency.
  const currencies = new Set(input.items.map((i) => i.price.currency));
  if (currencies.size > 1) {
    throw new SubscriptionError(
      `A subscription can have only one currency. The items use these currencies: ${[...currencies].join(", ")}.`,
    );
  }
  const currency = input.items[0]!.price.currency;

  // Validate any subscription-level custom prices (flat/per-unit only, ≥ 0).
  for (const i of input.items) {
    if (i.customAmountMinor == null) continue;
    if (!isOverridable(i.price.model)) {
      throw new SubscriptionError(
        `You can set a custom price only on a flat or per_unit price. This price is ${i.price.model}.`,
      );
    }
    if (i.customAmountMinor < 0) throw new SubscriptionError("unit_price_minor must be 0 or more");
  }

  // Quantity guard: a quantity-INVARIANT price bills the same regardless of quantity,
  // so a quantity > 1 is nonsense input. tm used to silently ignore it, charging
  // correctly but accepting garbage.
  //
  // `percentage` is deliberately NOT in this set, though it was until 2026-07-29. That
  // grouping rested on a false premise — "computeLineAmount drops quantity for these
  // models". It does not: `percentageAmount` takes quantity AS THE BASE it charges a
  // cut of ("`base` is the monetary value to take a cut of (passed as `quantity`)").
  // Rejecting quantity therefore made fixed-percentage pricing unusable — the base
  // could never be set, so every such price rated 1.5% of 1 = 0 (verify:percentage,
  // red and unnoticed since). These semantics are ours to define, and quantity-as-base
  // is what the rating code implements.
  //
  // A USAGE-aggregated percentage is different: its base comes from metered usage, so
  // a quantity there really is meaningless and stays rejected.
  for (const i of input.items) {
    const quantityInvariant =
      i.price.model === "flat" || (i.price.model !== "usage" && isMeteredPrice(i.price));
    if (quantityInvariant && i.quantity !== 1) {
      throw new SubscriptionError(
        `quantity must be 1 for ${i.price.model} price ${i.price.publicId}. Quantity applies only to per-unit, tiered, volume and package items.`,
      );
    }
  }

  // Billing cadence comes from the first recurring price.
  const recurring = input.items.find((i) => i.price.type === "recurring");
  if (!recurring) {
    throw new SubscriptionError("A subscription needs at least one recurring price");
  }
  const interval = (recurring.price.interval ?? "month") as Interval;
  const intervalCount = recurring.price.intervalCount ?? 1;

  // …and every OTHER recurring item has to agree with it. Picking the cadence off
  // the first recurring price only makes sense once they all match: otherwise the
  // subscription's cycle depends on the order the caller happened to list its
  // items in, and every item that disagrees is silently re-cadenced to it.
  // Monthly usage billing and the commitment default to the plan price's (only plan
  // prices carry them).
  const billUsageMonthly =
    input.billUsageMonthly ?? input.items.some((i) => i.price.billUsageMonthly);
  const commitmentAmountMinor =
    input.commitmentAmountMinor !== undefined
      ? input.commitmentAmountMinor
      : (input.items.find((i) => i.price.commitmentAmountMinor != null)?.price
          .commitmentAmountMinor ?? null);
  if (billUsageMonthly && !supportsMonthlyUsage(interval, intervalCount))
    throw new SubscriptionError(
      "We could not bill usage every month. The billing period must be 2 months or more, in months or years.",
    );
  if (billUsageMonthly || commitmentAmountMinor != null) {
    const pending =
      input.createPendingInvoices ??
      (await withTenant(input.organizationId, async (tx) => {
        const [b] = await tx
          .select({ pending: businesses.createPendingInvoices })
          .from(businesses)
          .where(eq(businesses.id, input.businessId))
          .limit(1);
        return b?.pending ?? false;
      }));
    if (pending)
      throw new SubscriptionError(
        "We could not set monthly usage billing or a minimum commitment. They do not work with pending invoices.",
      );
  }
  for (const i of input.items) {
    const reason = cadenceMismatch(i.price, interval, intervalCount, {
      monthlyUsage: billUsageMonthly,
    });
    if (reason) throw new SubscriptionError(reason);
  }

  // Period starts at startDate (backdating/future-dating) or now.
  let now = input.startDate ?? input.now;
  // A DAY-ANCHORED business floors the term start to the start of
  // the day in its timezone (default UTC). Every downstream boundary keys off `now` —
  // period start/end, trial end, billing anchor day, and the first invoice's line
  // service periods — so this single floor aligns them all.
  const bizMode = await loadBillingMode(input.organizationId, input.businessId);
  now = alignTermStart(now, bizMode);
  // Trial resolution, three cases distinguished by trialDays:
  //  - trialDays === 0    → EXPLICIT no-trial: disables the plan's default trial.
  //  - trialDays > 0      → a trial of that many days.
  //  - trialDays OMITTED  → AUTO-APPLY the plan (first recurring) price's configured
  //                          trial_period.
  // (tm previously only trialed on an explicit trial_days; the explicit-0 skip is the
  // escape hatch the `skipTrial` path needs.)
  let trialEnd =
    input.trialDays === 0
      ? null
      : input.trialDays && input.trialDays > 0
        ? addInterval(now, "day", input.trialDays)
        : recurring.price.trialPeriod && recurring.price.trialPeriod > 0
          ? // ⚠ `advancePeriod`, NOT `addInterval` — a `trial_period_unit` of month/year
            // is month arithmetic and has to clamp on the BUSINESS calendar like every
            // other boundary here. A 1-month trial starting 31 Jan on an Asia/Kolkata
            // business ran to 28 Feb 23:59:59 IST, i.e. an exclusive boundary of 1 MARCH:
            // `addInterval` saw the UTC day (30 Jan), clamped min(30, 28) to 28 Feb 18:30Z
            // — which IS 1 Mar local. Correct is 28 Feb, a day earlier, and the row's own
            // `billingAnchorDay` (31) already said so. `inclusiveBoundary` just below does
            // NOT rescue this: it backs off one second, never a day.
            //
            // The anchor is the trial's OWN start day-of-month, read in the business zone —
            // NOT `billingAnchorDay`, which is resolved further down and may be an explicit
            // calendar anchor or the customer's billing_date, neither of which has anything
            // to do with how long the trial runs.
            //
            // `trialDays` (the arm above) is day arithmetic and unaffected; so are
            // day/week trial units, which `advancePeriod` hands straight to `addInterval`.
            advancePeriod(
              now,
              (recurring.price.trialPeriodUnit ?? "day") as Interval,
              recurring.price.trialPeriod,
              localDatePartsInTz(now, bizMode.timezone).day,
              bizMode,
            )
          : null;
  // On a day-anchored business the trial ends at the LAST moment of its final day
  // (end-of-day in the business tz), not the first — so trial_end lands on the intended
  // calendar day instead of the prior UTC day.
  //
  // `inclusiveBoundary`, NOT `alignTrialEnd`, and the difference is a whole day. The
  // two helpers take different things:
  //   · `alignTrialEnd(d)`  — d NAMES THE DAY the trial ends ON (an operator picked it,
  //     or a client echoed back the …T23:59:59 we serve). It advances to the next local
  //     midnight and backs off, so it is idempotent on a read-back. Right for
  //     `reactivateSubscription` and `editTrialEnd`.
  //   · `inclusiveBoundary(d)` — d IS THE EXCLUSIVE BOUNDARY; back off one second.
  // What `addInterval` produced above is the exclusive boundary: `now` was already
  // floored by `alignTermStart`, so start + 14 days is exactly the local midnight the
  // trial ends AT. Sending that through `alignTrialEnd` advanced it another day, and a
  // 14-day trial ran 15 (23-Aug 00:00 → 06-Sep 23:59:59 rather than 05-Sep 23:59:59,
  // i.e. next_billing_at at 06-Sep 00:00). Applies to a `trial_days`
  // request and a plan's configured `trial_period` alike — both arms feed this line.
  if (trialEnd) trialEnd = inclusiveBoundary(trialEnd, bizMode);
  if (input.trialEnd) {
    if (input.trialDays != null) {
      throw new SubscriptionError("Pass trial_end or trial_days, not both");
    }
    // A named end, not a length: aligned like an operator-picked trial end.
    trialEnd = alignTrialEnd(input.trialEnd, bizMode);
    if (trialEnd <= now) throw new SubscriptionError("trial_end must be after the start");
  }
  // A future-dated start parks the sub in `future` (SUB-1) until the clock starts
  // it (→ in_trial or active) at its start date — no invoice is raised now. The test is
  // the ALIGNED start, not the raw input: on a day-anchored business a start later today
  // belongs to a billing day that has already begun, so the sub starts now rather than
  // sitting in `future` over a term of its own that is already running.
  const isFuture = now > input.now;
  const status: StoredSubscriptionStatus = isFuture ? "future" : trialEnd ? "in_trial" : "active";
  // Calendar anchor: an explicit sub-level anchor wins; else consume the
  // customer's manually-set billing_date (CUST-5 / D5). An explicit anchor is a term
  // boundary the caller hands us, so it goes through the mode like any other.
  let billingAnchor = input.billingAnchor
    ? normalizeTermEnd(input.billingAnchor, bizMode)
    : undefined;
  // The intended day-of-month for calendar billing (31, not the clamped 28) — persisted
  // so renewals re-align to it instead of drifting (CUST-5 review fix). Read in the
  // business's zone, because that is the calendar `advancePeriod` re-aligns on: a term
  // starting 4-Aug 00:00 IST is 3-Aug 18:30Z, and anchoring it to UTC day 3 renewed it a
  // day early (found 2026-08-04).
  let billingAnchorDay: number | null = billingAnchor
    ? localDatePartsInTz(billingAnchor, bizMode.timezone).day
    : null;
  if (!billingAnchor) {
    const [cust] = await withTenant(input.organizationId, (tx) =>
      tx
        .select({ mode: customers.billingDateMode, day: customers.billingDate })
        .from(customers)
        .where(eq(customers.id, input.customerId))
        .limit(1),
    );
    if (cust?.mode === "manually_set" && cust.day) {
      billingAnchor = calendarAnchorFor(now, cust.day, bizMode.timezone);
      billingAnchorDay = cust.day;
    }
  }
  // Default the anchor day to the start day-of-month for month/year cadences so
  // EVERY calendar subscription re-aligns at renewal (a day-31 start renews to
  // 31/28/31, never drifting) — not just those with an explicit anchor (review fix).
  if (billingAnchorDay == null && (interval === "month" || interval === "year")) {
    billingAnchorDay = localDatePartsInTz(now, bizMode.timezone).day;
  }
  // First period end: trial end if trialing; else the calendar anchor if it's in
  // the future (calendar billing — first period runs start→anchor, then aligns to
  // it since renewal advances by the interval); else a full interval from start.
  const periodEnd =
    trialEnd ??
    (billingAnchor && billingAnchor > now
      ? billingAnchor
      : // ⚠ `advancePeriod`, NOT `addInterval`. Both clamp; `addInterval` clamps on the UTC
        // calendar while the term lives on the BUSINESS calendar. A 31-Aug-IST start is UTC
        // day 30, so `addInterval` clamps min(30, 30) and lands 1 Oct IST where our own
        // renewal path says 30 Sep. `billingAnchorDay`
        // is set immediately above and was never passed here, so the row recorded an anchor its
        // own first term contradicted. Identical on a UTC business, or with a null anchor.
        advancePeriod(now, interval, intervalCount, billingAnchorDay, bizMode));

  // remaining_billing_cycles (SUB-4): cycles remaining AFTER the current one, so a
  // plan `billing_cycles` of N runs exactly N cycles then cancels. Seed from the
  // recurring item's billing_cycles cap (minus the current period); null = forever.
  const cycleCap = recurring.billingCycles ?? recurring.price.billingCycles ?? null;
  // A trial's current "period" is unbilled — the first PAID cycle is billed by the
  // trial-end renewal (which decrements), so seed the FULL cap; a non-trial sub's
  // current period is billed at create/start, so seed cap − 1 (cycles after it).
  // Without this, billing_cycles=1 + trial cancelled at trial end with 0 paid cycles.
  const remainingBillingCycles =
    cycleCap != null ? (trialEnd ? cycleCap : Math.max(0, cycleCap - 1)) : null;

  const created = await withTenant(input.organizationId, async (tx) => {
    const shipTo = input.shippingAddressPublicId
      ? await resolveAssignableAddress(tx, {
          businessId: input.businessId,
          customerId: input.customerId,
          addressPublicId: input.shippingAddressPublicId,
        })
      : null;
    // CAT-3: auto-include the plans' MANDATORY add-ons (differential-aware,
    // immutable snapshots frozen here). Resolve which of the requested items are
    // plans, then expand their mandatory add-ons not already requested.
    const requestedProductIds = [...new Set(input.items.map((i) => i.price.productId))];
    const requestedProducts = await tx
      .select({ id: products.id, kind: products.kind })
      .from(products)
      .where(
        and(eq(products.businessId, input.businessId), inArray(products.id, requestedProductIds)),
      );
    const planProductIds = requestedProducts.filter((r) => r.kind === "plan").map((r) => r.id);
    const addonProductIds = new Set(
      requestedProducts.filter((r) => r.kind === "addon").map((r) => r.id),
    );
    const mandatory = await resolveMandatoryAttachedItems(tx, {
      businessId: input.businessId,
      planProductIds,
      currency,
      interval,
      intervalCount,
      existingProductIds: requestedProductIds,
      strict: true, // create-time: an unpriceable mandatory add-on rejects the sub
    });
    // charge_once add-ons bill one time (unbilled charge folded into the first
    // invoice); the rest are recurring subscription items.
    const recurringMandatory = mandatory.filter((m) => !m.chargeOnce);
    const onceMandatory = mandatory.filter((m) => m.chargeOnce);
    const mandatoryItems: SubscriptionItemInput[] = recurringMandatory.map((m) => ({
      price: m.price,
      quantity: m.quantity,
      customAmountMinor: m.differentialAmountMinor ?? undefined,
      customTiers: m.differentialTiers ?? undefined,
      billingCycles: m.billingCycles ?? undefined,
      metadata: { auto_included: "mandatory" },
    }));
    // CAT-7: an add-on the caller asked for EXPLICITLY gets the same
    // plan-scoped differential the mandatory ones get above — the snapshot frozen
    // below is immutable, so a missed differential bills 0 for the life of the
    // subscription. `estimateNewSubscription` calls the same helper.
    const requestedItems: SubscriptionItemInput[] = await applyExplicitDifferentials(tx, {
      currency,
      planProductIds,
      addonProductIds,
      items: input.items,
    });
    const allItems = [...requestedItems, ...mandatoryItems];
    // MRR rates the EFFECTIVE amount, which is what `priceSnapshot` freezes below —
    // a differential (or an explicit override) on a catalog-0 add-on is real revenue,
    // and rating the live catalog price here would report it as 0.
    //
    // Rated through the SNAPSHOT — the same `snapshotPrice(...)` the items freeze below —
    // rather than by patching `amountMinor` onto the catalog row. Patching covered a FLAT
    // override and silently missed a TIERED one: `customTiers` was never passed, so a volume
    // or graduated price with overridden tiers was rated at CATALOG tiers while the snapshot
    // stored the overridden ones. Measured 2026-08-26 on a half-price volume override — tiers
    // 500/400 against a catalog 1000/800 — which stored `mrr` 15000 against a real 12500, a
    // 20% overstatement that every MRR figure inherited and that `recomputeSubscriptionMrr`
    // (which reads the snapshot) would silently "correct" on the next unrelated write.
    const rate = (
      price: typeof prices.$inferSelect,
      quantity: number,
      amt: number | null | undefined,
      tiers: unknown,
      freeQuantity: number | null | undefined,
    ) => ({
      price,
      quantity,
      snapshot: snapshotPrice(price, amt ?? null, tiers ?? undefined),
      freeQuantity: freeQuantity ?? null,
    });
    const grossMrr =
      computeSubscriptionMrr(
        requestedItems.map((i) =>
          rate(i.price, i.quantity, i.customAmountMinor, i.customTiers, i.freeQuantity),
        ),
      ) +
      computeSubscriptionMrr(
        recurringMandatory.map((m) =>
          rate(m.price, m.quantity, m.differentialAmountMinor, m.differentialTiers, null),
        ),
      );
    // A subscription that starts IN TRIAL stores 0 (see
    // `recomputeSubscriptionMrr`); the trial-end conversion in `renewal.ts` restates
    // it to the real rate. `future` keeps its rate: it is not live either, but the
    // list renders `—` for it and nothing was asked to change there.
    const mrr = status === "in_trial" ? 0n : grossMrr;
    await enforceMetadataRules(tx, input.businessId, "subscription", input.metadata ?? null, {
      mode: "create",
      scope: input.metadataRules,
    });
    const subCustomFields = await coerceCustomFields(
      tx,
      input.businessId,
      "subscription",
      input.customFields,
      { mode: "create", skipRequired: input.skipRequiredCustomFields },
    );
    // A caller-supplied id is checked here so the caller gets "already taken" instead
    // of a unique-violation 500. Scoped to the business, matching the constraint.
    if (input.publicId) {
      const [clash] = await tx
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.businessId, input.businessId),
            eq(subscriptions.publicId, input.publicId),
          ),
        )
        .limit(1);
      if (clash)
        throw new SubscriptionError(`Subscription id is already in use: ${input.publicId}`);
    }
    await assertTestBusinessRoom(tx, input.businessId, "subscriptions");
    const [sub] = await tx
      .insert(subscriptions)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.customerId,
        publicId: input.publicId ?? publicId("sub"),
        status,
        currency,
        // NO TERM WHILE TRIALLING (2026-08-25). A trial is not a billing term — a
        // subscription has `trial_*` or `current_term_*`, never both — and `renewal.ts`
        // selects a trialling subscription by `trial_end`. The first real term is stamped
        // when the trial converts. `periodEnd` above is `trialEnd ?? …`, i.e. the same
        // instant, which is exactly the conflation this removes.
        currentPeriodStart: trialEnd ? null : now,
        currentPeriodEnd: trialEnd ? null : periodEnd,
        trialEnd,
        defaultPaymentMethodId: input.defaultPaymentMethodId ?? null,
        // Timeline. `start_date` is the term's own start, so it is stored ALIGNED — the
        // raw request instant would disagree with `current_period_start` on a day-anchored
        // business, which left the clock starting a `future` sub hours after its term had
        // begun and made `healUnbilledFirstPeriods`' `current_period_start = start_date`
        // signature unmatchable (so a crash between activation and the first invoice was
        // never healed there).
        startDate: input.startDate ? now : null,
        startedAt: isFuture ? null : now,
        activatedAt: isFuture || status === "in_trial" ? null : now,
        trialStart: trialEnd ? now : null,
        // Billing period snapshot
        billingPeriod: intervalCount,
        billingPeriodUnit: interval,
        billingAnchorDay,
        remainingBillingCycles,
        // Commercial fields
        autoCollection: input.autoCollection ?? null,
        createPendingInvoices: input.createPendingInvoices ?? null,
        billUsageMonthly,
        ...subPeriodFields(
          {
            billUsageMonthly,
            billingPeriodUnit: interval,
            billingPeriod: intervalCount,
            billingAnchorDay,
          },
          trialEnd ? null : now,
          trialEnd ? null : periodEnd,
          bizMode,
        ),
        commitmentAmountMinor,
        commitmentSegments: freshSegments(commitmentAmountMinor, trialEnd ? null : now),
        netTermDays: input.netTermDays ?? null,
        poNumber: input.poNumber ?? null,
        shippingAddressId: shipTo?.id ?? null,
        invoiceNotes: input.invoiceNotes ?? null,
        maxRefundableCreditsUsageMinor: input.maxRefundableCreditsUsageMinor ?? null,
        maxExcessPaymentUsageMinor: input.maxExcessPaymentUsageMinor ?? null,
        metadata: input.metadata ?? null,
        customFields: subCustomFields,
        mrr,
        // Mirrors `mrr` for the same reason this write exists at all: creation does not go
        // through `recomputeSubscriptionMrr`, so without it a subscription created and
        // cancelled without a single recompute in between would have no recorded earning
        // rate and its history would fall back to re-rating the items at list price. A
        // trialling create records nothing — it has not earned yet.
        lastEarningMrr: status === "in_trial" ? null : mrr,
      })
      .returning();

    const items = await tx
      .insert(subscriptionItems)
      .values(
        allItems.map((i) => ({
          organizationId: input.organizationId,
          businessId: input.businessId,
          subscriptionId: sub!.id,
          publicId: publicId("si"),
          priceId: i.price.id,
          quantity: i.quantity,
          freeQuantity: i.freeQuantity ?? null,
          billingCycles: i.billingCycles ?? null,
          metadata: i.metadata ?? null,
          // Aligned to the subscription's cycle: a shorter-cadence item freezes its
          // scaled per-cycle amount, so every later reader rates it correctly.
          priceSnapshot: alignSnapshotToCycle(
            snapshotPrice(i.price, i.customAmountMinor, i.customTiers),
            { interval, intervalCount },
          ),
        })),
      )
      .returning();

    /**
     * The opening move, for the MRR movement ledger.
     *
     * Creation is the one write that does NOT go through `recomputeSubscriptionMrr` — the
     * rate is computed inline because `mrr` is written in the INSERT that creates the
     * items, before there is a row to update. So it records its own, and a subscription
     * that starts in trial (mrr 0) records nothing: the trial-end conversion recomputes
     * and books the first real move there, which is where the revenue actually starts.
     *
     * AFTER the items insert, deliberately: the recorder resolves which PLAN the movement
     * belongs to by reading them, and a subscription with no items yet resolves to none —
     * which would file every first sale under "no plan".
     */
    await recordMrrMovement(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      subscriptionId: sub!.id,
      customerId: input.customerId,
      currency,
      previousMinor: 0n,
      nextMinor: mrr,
      status,
      occurredAt: now,
    });
    // Meter prices: freeze the rate card, and one live subscription per customer bills a meter.
    await syncMeterBilling(tx, sub!.id);

    // CAT-4: charge_once mandatory add-ons → a pending one-time charge folded into
    // the first invoice (billSubscriptionPeriod picks up pending unbilled charges).
    for (const m of onceMandatory) {
      const ratable = ratableFromSnapshot(
        snapshotPrice(
          m.price,
          m.differentialAmountMinor ?? undefined,
          m.differentialTiers ?? undefined,
        ),
        null,
      );
      const amount = computeLineAmount(ratable, m.quantity);
      if (amount <= 0n) continue;
      await tx.insert(unbilledCharges).values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        subscriptionId: sub!.id,
        publicId: publicId("uch"),
        description: `${m.price.publicId} (one-time)`,
        amountMinor: amount,
        currency,
      });
    }

    const defer = input.deferEventsTo;
    const evData = () =>
      buildEventData(
        "subscription_created",
        { id: sub!.publicId, status: sub!.status },
        sub!.resourceVersion,
      );
    await emitOrDefer(
      tx,
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "subscription_created",
        data: evData(),
      },
      defer,
    );
    if (!isFuture) {
      await emitOrDefer(
        tx,
        {
          organizationId: input.organizationId,
          businessId: input.businessId,
          type: "subscription_started",
          data: buildEventData(
            "subscription_started",
            { id: sub!.publicId, status: sub!.status },
            sub!.resourceVersion,
          ),
        },
        defer,
      );
      if (status === "active") {
        await emitOrDefer(
          tx,
          {
            organizationId: input.organizationId,
            businessId: input.businessId,
            type: "subscription_activated",
            data: buildEventData(
              "subscription_activated",
              { id: sub!.publicId, status: sub!.status },
              sub!.resourceVersion,
            ),
          },
          defer,
        );
      }
    }
    // NOT deferred like the events above. `emitOrDefer` exists because an event, once
    // delivered, cannot be unsent, so an event whose operation might still be rolled
    // back must not be written yet. An audit row is the opposite: it is written in this
    // transaction and dies with it if the signup fails, so it can never describe a
    // subscription that does not exist — and deferring it would lose the row entirely
    // on the paths that never flush.
    await auditSubscription(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: "subscription.create",
      // A creation: the reader sees the new record's full body, not a diff.
      before: null,
      after: sub!,
    });
    return { subscription: sub!, items };
  });

  /**
   * POST-COMMIT: does the instrument that will be charged actually fit this subscription?
   *
   * A mandate is sized ONCE, at vault time, and in the ordinary signup order — vault the
   * card, THEN create the subscription — that is the moment least is known, so the ceiling
   * can be the fallback while the renewal it must carry is larger. Nothing re-sizes it
   * afterwards and a registered ceiling cannot be raised in place: only a fresh
   * authorisation replaces it, and only the BUYER can give one. Until now the gap was
   * detected only when somebody happened to load an estimate — `mandateShortfallFor` rides
   * on the renewal preview — so a signup could sit for a month and fail its first renewal
   * with nobody warned. Measured on the dev book 2026-09-04: 33 of 200 INR mandates on
   * customers with a live subscription were already below their own renewal.
   *
   * AFTER the transaction, never inside it: the check plans a renewal estimate, and a
   * warning must not lengthen a write transaction or hold its locks.
   *
   * NEVER fails the create. A subscription that exists and is unwarned is far better than
   * a create that 500s because a warning could not be computed — the same rule
   * `beginVaultSetup` applies to its own sizing.
   *
   * Dynamic import because `estimate.ts` imports THIS module; a static import back would
   * be a cycle. That is the established idiom here (21 other call sites).
   */
  try {
    const { mandateShortfallFor, estimateRenewal } = await import("./estimate");
    const est = await estimateRenewal({
      organizationId: input.organizationId,
      businessId: input.businessId,
      subscriptionId: created.subscription.id,
    });
    if (est) {
      const shortfall = await mandateShortfallFor(
        input.organizationId,
        input.businessId,
        created.subscription,
        BigInt(est.total_minor),
      );
      if (shortfall) {
        // Its OWN short transaction: the create has already committed, and `emitEvent`
        // writes the event row plus its outbox entry, which must be atomic with each
        // other but no longer with the subscription.
        await withTenant(input.organizationId, (tx) =>
          emitEvent(tx, {
            organizationId: input.organizationId,
            businessId: input.businessId,
            type: "payment_source_mandate_insufficient",
            /**
             * `{ payment_source: <resource> }` plus a SIBLING `mandate_shortfall`.
             *
             * ⚠️ The facts go in the sibling, NOT inside `payment_source`, and that is
             * load-bearing: `emitEvent` runs `buildEventContent`, which REPLACES
             * `data[resourceType]` with a full snapshot loaded from the
             * database. Anything the caller put inside that key is overwritten — measured,
             * by asserting on it and reading NaN. Top-level siblings survive, because the
             * builder starts from the caller's data and only swaps the resource key.
             *
             * It is also the better shape: the card is the RESOURCE, the shortfall is the
             * REASON, and the reason is not a property of the card — the same card is fine
             * for a smaller subscription.
             *
             * No `resource_version`: the instrument did not change, the subscription
             * attached to it did, so quoting one would imply a write that never happened.
             */
            data: buildEventData(
              "payment_source_mandate_insufficient",
              { id: shortfall.payment_method },
              null,
              {
                mandate_shortfall: {
                  mandate_ceiling_minor: shortfall.ceiling_minor,
                  next_amount_minor: shortfall.amount_minor,
                  currency: shortfall.currency,
                  rail: shortfall.rail,
                  reauthorized_ceiling_minor: shortfall.reauthorized_ceiling_minor,
                  subscription: created.subscription.publicId,
                },
              },
            ),
          }),
        );
        log.warn("subscription created with a mandate that cannot carry its renewal", {
          event: "mandate_insufficient_at_create",
          subscription: created.subscription.publicId,
          paymentMethod: shortfall.payment_method,
          ceilingMinor: shortfall.ceiling_minor,
          nextAmountMinor: shortfall.amount_minor,
        });
      }
    }
  } catch (e) {
    log.warn("mandate shortfall check failed after subscription create", {
      event: "mandate_shortfall_check_failed",
      error: (e as Error)?.message,
    });
  }

  return created;
}

/**
 * `invoice_immediately: false` at SIGNUP (a true|false choice on the create page,
 * defaulting to true). Instead of raising the first invoice
 * now, the first period's recurring charge is queued as a PENDING UNBILLED CHARGE, so
 * it rides on the next invoice this subscription raises (`billSubscriptionPeriod`
 * folds pending charges in). Nothing is collected now, and no invoice exists yet.
 *
 * Deliberately the SAME mechanism `resumeSubscriptionWithOptions` uses for
 * `charges_handling='add_to_unbilled_charges'` — one helper, one set of semantics, so
 * "defer these charges" behaves identically wherever it is offered:
 *   - `recurringChargeMinor` rates the full recurring amount from the items' frozen
 *     price snapshots (so overrides + plan-scoped differentials are honoured) and
 *     applies the subscription's active coupons as a non-mutating peek — a signup
 *     coupon therefore discounts the deferred charge exactly as it would have
 *     discounted the invoice.
 *   - usage-model items are excluded: they bill in arrears at the renewal anyway.
 *   - one-time (charge) items are NOT deferred; they are billed by the first invoice
 *     that is actually raised, i.e. the next renewal.
 *
 * Known fidelity limit, shared with resume and written down so it isn't rediscovered:
 * an unbilled charge is folded back as a single `one_time`, taxable, tax-exclusive
 * line with `productKind='charge'`. So a deferred plan period loses its product
 * identity on the invoice it eventually lands on, and an item-scoped coupon applied
 * LATER will not match it. Fixing that means teaching `unbilled_charges` to carry the
 * line's product kind / taxability, which is an invoicing-module change.
 *
 * The period the charge covers is stamped on it (`period_start`/`period_end`), which
 * the fold-in carries onto the invoice line — so revenue recognition still points at
 * the term the money was for, not the term it was billed in.
 */
export async function deferFirstPeriodToUnbilledCharges(input: {
  organizationId: string;
  businessId: string;
  subscription: typeof subscriptions.$inferSelect;
  now: Date;
}): Promise<{ chargeId: string | null; amountMinor: bigint }> {
  const { organizationId, businessId, subscription } = input;
  // The first period is billable now, so its plan credits are granted now.
  const { grantCurrentCycle } = await import("@/modules/credits/plan-credits");
  await grantCurrentCycle({ organizationId, businessId, subscription });
  const { addAdHocCharge, recurringChargeMinor } = await import("./items");
  const amountMinor = await recurringChargeMinor(organizationId, subscription.id);
  if (amountMinor <= 0n) return { chargeId: null, amountMinor: 0n };
  const r = await addAdHocCharge({
    organizationId,
    businessId,
    subscriptionId: subscription.id,
    description: "First period charge (invoiced later)",
    amountMinor: Number(amountMinor),
    invoiceNow: false,
    now: input.now,
    periodStart: subscription.currentPeriodStart,
    periodEnd: subscription.currentPeriodEnd,
  });
  return { chargeId: r.object === "unbilled_charge" ? r.charge.publicId : null, amountMinor };
}

/** Refused when a "provisional" subscription turns out to have real money attached. */
export class ProvisionalDeleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionalDeleteError";
  }
}

/**
 * Hard-delete a subscription that was created but never allowed to exist: the
 * auto-collect-ON signup whose first charge declined — NO subscription, no invoice
 * and no events are left behind.
 *
 * This is the one place a subscription row is destroyed rather than cancelled, so
 * it is guarded hard: if ANY invoice, ledger entry or payment references the
 * subscription, the row is money-bearing history and must be cancelled/voided
 * instead — this throws. The ledger is append-only and is never touched here.
 *
 * Deletes everything `createSubscription` + `applyCouponToSubscription` wrote:
 * items, auto-included one-time charges, applied coupons, and the row itself
 * (custom-field values live on the row; the remaining child tables — entitlements,
 * scheduled changes, charge log, checkout sessions — cascade).
 */
export async function deleteProvisionalSubscription(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
}): Promise<void> {
  const { organizationId, businessId, subscriptionId } = input;
  await withTenant(organizationId, async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    if (!sub) return;

    const invs = await tx
      .select({ id: invoicesTable.id, publicId: invoicesTable.publicId })
      .from(invoicesTable)
      .where(eq(invoicesTable.subscriptionId, subscriptionId));
    if (invs.length > 0) {
      throw new ProvisionalDeleteError(
        `Subscription ${sub.publicId} has ${invs.length} invoice(s): ${invs.map((i) => i.publicId).join(", ")}. It is not provisional. Void or cancel it instead.`,
      );
    }
    const pays = await tx
      .select({ id: payments.id })
      .from(payments)
      .innerJoin(invoicesTable, eq(payments.invoiceId, invoicesTable.id))
      .where(eq(invoicesTable.subscriptionId, subscriptionId));
    if (pays.length > 0) {
      throw new ProvisionalDeleteError(
        `Subscription ${sub.publicId} has recorded payments. It is not provisional.`,
      );
    }
    // The ledger has no subscription column; entries are keyed by the public id of
    // the money object that produced them. With no invoice and no payment the only
    // way one could name this subscription is a direct posting — check anyway, and
    // never delete a ledger row (append-only).
    const led = await tx
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.sourceId, sub.publicId))
      .limit(1);
    if (led.length > 0) {
      throw new ProvisionalDeleteError(
        `Subscription ${sub.publicId} has ledger entries. It is not provisional, because the ledger is append-only.`,
      );
    }

    // Undo the coupon side too: applying one bumps `times_redeemed` and can CLAIM a
    // single-use coupon-set code. A signup that never happened must not burn either.
    const applied = await tx
      .select({ id: appliedCoupons.id, couponId: appliedCoupons.couponId })
      .from(appliedCoupons)
      .where(eq(appliedCoupons.subscriptionId, subscriptionId));
    for (const ac of applied) {
      await tx
        .update(couponSetCodes)
        .set({ status: "not_redeemed", redeemedAt: null, appliedCouponId: null })
        .where(eq(couponSetCodes.appliedCouponId, ac.id));
      // A manual (ad-hoc) discount has no coupon row and no redemption counter.
      if (ac.couponId) {
        await tx
          .update(coupons)
          .set({ timesRedeemed: sql`greatest(${coupons.timesRedeemed} - 1, 0)` })
          .where(eq(coupons.id, ac.couponId));
      }
    }
    await tx.delete(appliedCoupons).where(eq(appliedCoupons.subscriptionId, subscriptionId));
    await tx.delete(unbilledCharges).where(eq(unbilledCharges.subscriptionId, subscriptionId));
    await tx.delete(subscriptionItems).where(eq(subscriptionItems.subscriptionId, subscriptionId));
    await tx
      .delete(subscriptions)
      .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.businessId, businessId)));
  });
}

export async function listSubscriptions(
  organizationId: string,
  businessId: string,
): Promise<Array<typeof subscriptions.$inferSelect>> {
  return withTenant(organizationId, async (tx) =>
    tx
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.businessId, businessId), notDeleted()))
      .orderBy(desc(subscriptions.createdAt)),
  );
}

/** Compact item view for LIST rows: enough to render "plan + price + N addons". */
export interface SubscriptionListItemView {
  price: string; // price public id
  quantity: number;
  interval: string | null;
  unit_price_minor: number | null;
  product_name: string;
  product_kind: string;
}

/**
 * List a business's subscriptions, newest first, each joined to its customer's
 * public id + email/name and its items (batched — one query for all rows) so
 * list pages can show "plan · price · +N addons" columns.
 * Optionally filter to a single customer (by internal id).
 */
export interface SubscriptionListRow {
  subscription: Sub;
  customerPublicId: string | null;
  customerEmail: string | null;
  /** RESOLVED account-holder name (`customers/names.ts`), not a single column. */
  customerName: string | null;
  /**
   * Company and phone come off the same joined row as name and email — no extra
   * query. They are here because the list leads with a four-line Customer Info cell
   * (name · company · email · phone) and it could only render two: the
   * columns existed on `customers` the whole time, the projection just never
   * selected them.
   */
  customerCompany: string | null;
  customerPhone: string | null;
  items: SubscriptionListItemView[];
  /** `computeRecurringAmount`; set by the paged list only. */
  recurringAmountMinor?: bigint | null;
}

// ── Paginated list (see docs/GUIDE.md §3.4 for the shared contract) ────────────

/** `startOfDayInTz(x) === x` in SQL — is this instant exactly local midnight? */
function atLocalMidnight(col: Column | SQL, tz: string): SQL {
  return sql`((${col} AT TIME ZONE ${tz}) = date_trunc('day', (${col} AT TIME ZONE ${tz})))`;
}

/**
 * A boundary as the API REPORTS it on a day-anchored business: inclusively, the last
 * second of the final day (`termEnd`/`inclusiveBoundary` in serialize.ts), not the
 * exclusive instant we store.
 *
 * Date filters bucket by the business day, so the two conventions sit a whole DAY apart
 * at exactly the boundary: a term stored 04-Aug 00:00 local prints "03-Aug 23:59:59",
 * and comparing the raw column filed it under 04-Aug — so `current_period_end[on]=<the
 * date the row itself shows>` came back empty. Same shape as the timezone bug
 * `business-tz.ts` documents, one convention further out.
 */
function inclusiveBoundarySql(col: Column | SQL, mode: BillingMode): SQL {
  if (mode.anchor !== "day") return sql`${col}`;
  return sql`(CASE
      WHEN ${atLocalMidnight(col, mode.timezone)} THEN ${col} - interval '1 second'
      ELSE ${col}
    END)`;
}

/** `normalizeTermEnd` in SQL: a non-midnight instant rounds UP to the next local day. */
function normalizeTermEndSql(col: Column | SQL, mode: BillingMode): SQL {
  if (mode.anchor !== "day") return sql`${col}`;
  const tz = mode.timezone;
  return sql`(CASE
      WHEN ${atLocalMidnight(col, tz)} THEN ${col}
      ELSE ((date_trunc('day', (${col} AT TIME ZONE ${tz})) + interval '1 day') AT TIME ZONE ${tz})
    END)`;
}

/**
 * `nextBillingAt` (serialize.ts) in SQL — the instant the next invoice is raised, per
 * status. NULL for `non_renewing`/`paused`/`cancelled` there and here: a date in that
 * cell would promise a charge that never comes, and a filter that answered one would
 * return rows the response says have no next billing.
 */
function nextBillingAtSql(mode: BillingMode): SQL {
  return sql`(CASE
      WHEN ${subscriptions.status} = 'in_trial'
        THEN ${normalizeTermEndSql(subscriptions.trialEnd, mode)}
      WHEN ${subscriptions.status} = 'future'
        THEN COALESCE(${subscriptions.startDate}, ${subscriptions.currentPeriodStart})
      WHEN ${apiStatusSql} = 'active' THEN ${subscriptions.currentPeriodEnd}
      ELSE NULL
    END)`;
}

/**
 * The subscription's OWN payment method, as the public id the API prints
 * (`default_payment_method`). A primary-key subquery rather than the raw
 * `default_payment_method_id`: the operator filters with the id they can see (`pm_…`),
 * and comparing that against a uuid column matches nothing. NULL means collection falls
 * back to the customer's primary card — which is what `is_present[false]` asks for.
 */
const subscriptionPaymentMethodSql = sql`(
  SELECT ${paymentMethods.publicId} FROM ${paymentMethods}
  WHERE ${paymentMethods.id} = ${subscriptions.defaultPaymentMethodId})`;

/**
 * The code of the ACTIVE discount's coupon (`discount.coupon` on the detail response),
 * or NULL. A manual discount carries no coupon, so `coupon[is_present]=true` means
 * "discounted by a coupon", not "discounted". At most one discount is active per
 * subscription (`applied_coupons_active_manual_uq`), and the lookup rides the indexed
 * `(subscription_id, status)`.
 */
const activeCouponCodeSql = sql`(
  SELECT ${coupons.code} FROM ${appliedCoupons}
  JOIN ${coupons} ON ${coupons.id} = ${appliedCoupons.couponId}
  WHERE ${appliedCoupons.subscriptionId} = ${subscriptions.id}
    AND ${appliedCoupons.status} = 'active'
  LIMIT 1)`;

/** Is a change still waiting on the clock? EXISTS over `scheduled_changes_sub_idx`. */
const hasScheduledChangesSql = sql`(EXISTS (
  SELECT 1 FROM ${scheduledChanges}
  WHERE ${scheduledChanges.subscriptionId} = ${subscriptions.id}
    AND ${scheduledChanges.status} = 'scheduled'))`;

/**
 * The PLAN item's quantity — serialized per item (`items[].quantity`) rather than on
 * the subscription. Scoped to `kind = 'plan'` so an add-on's quantity can never answer
 * for it.
 */
const planQuantitySql = sql`(
  SELECT ${subscriptionItems.quantity} FROM ${subscriptionItems}
  JOIN ${prices} ON ${prices.id} = ${subscriptionItems.priceId}
  JOIN ${products} ON ${products.id} = ${prices.productId}
  WHERE ${subscriptionItems.subscriptionId} = ${subscriptions.id} AND ${products.kind} = 'plan'
  LIMIT 1)`;

/**
 * Filterable columns. Customer fields come off the joined `customers` row; several are
 * the SQL twin of a serializer expression (each says which) so that the filter and the
 * value the response prints are the same value.
 *
 * A function of the billing mode because a day-anchored business reports its boundaries
 * inclusively — see `inclusiveBoundarySql`. Nothing about the field NAMES or KINDS
 * depends on the mode, so `FILTER_SHAPE` below derives those once.
 */
function listFilters(mode: BillingMode): Record<string, FilterSpec> {
  // There is no billing term while a subscription is in trial, and
  // `serializeSubscription` follows that (both `current_period_*` serialize as null). The
  // filter has to agree: otherwise an in-trial row comes back for a term window the API
  // says it has no term in.
  const termOrNull = (col: Column | SQL) =>
    sql`(CASE WHEN ${subscriptions.status} = 'in_trial' THEN NULL ELSE ${col} END)`;

  return {
    id: { column: subscriptions.publicId, kind: "text" },
    status: { column: apiStatusSql, kind: "enum" },
    currency: { column: subscriptions.currency, kind: "enum" },
    // Lifecycle timeline (CP-4) — each is what the response prints, raw.
    start_date: { column: subscriptions.startDate, kind: "date" },
    started_at: { column: subscriptions.startedAt, kind: "date" },
    activated_at: { column: subscriptions.activatedAt, kind: "date" },
    trial_start: { column: subscriptions.trialStart, kind: "date" },
    trial_end: { column: subscriptions.trialEnd, kind: "date" },
    current_period_start: { column: termOrNull(subscriptions.currentPeriodStart), kind: "date" },
    current_period_end: {
      column: termOrNull(inclusiveBoundarySql(subscriptions.currentPeriodEnd, mode)),
      kind: "date",
    },
    // "Who renews in the next 7 days?" — the one date that answers it across every
    // status, and the only one that is right for a trialling subscription, which
    // deliberately reports no term.
    next_billing_at: { column: nextBillingAtSql(mode), kind: "date" },
    cancel_at_period_end: { column: subscriptions.cancelAtPeriodEnd, kind: "bool" },
    // The other half of "which subscriptions are about to cancel?" — a specific_date
    // cancel sets no flag, so `cancel_at_period_end[is]=true` alone under-reports the
    // book. Indexed (partial, non-null only) for exactly this query.
    cancel_scheduled_at: { column: subscriptions.cancelScheduledAt, kind: "date" },
    // `canceled_at` is a THREE-way coalesce at the API edge (serialize.ts): the actual
    // cancellation, else a pending specific_date cancel, else the term end a
    // `non_renewing` subscription will cancel on. Filtering the bare column would have
    // missed every cancellation that has not happened yet — which is most of the book
    // an operator asks this question about.
    canceled_at: {
      column: sql`COALESCE(${subscriptions.canceledAt}, ${subscriptions.cancelScheduledAt},
        CASE WHEN ${apiStatusSql} = 'non_renewing'
          THEN ${inclusiveBoundarySql(subscriptions.currentPeriodEnd, mode)} END)`,
      kind: "date",
    },
    // SUB-8: `cancel_reason` is the SYSTEM reason (not_paid, no_card, …), a closed set;
    // `cancel_reason_code` is merchant-supplied and free-form.
    cancel_reason: { column: subscriptions.cancelReason, kind: "enum" },
    cancel_reason_code: { column: subscriptions.cancelReasonCode, kind: "text" },
    // Term shape, and how many fixed cycles are left (null = renews forever, which is
    // why `remaining_billing_cycles[is_present]=false` is the "no end date" filter).
    billing_period: { column: subscriptions.billingPeriod, kind: "number" },
    billing_period_unit: { column: subscriptions.billingPeriodUnit, kind: "enum" },
    remaining_billing_cycles: { column: subscriptions.remainingBillingCycles, kind: "number" },
    // Collection + commercial (CP-1/CP-4). `auto_collection` and
    // `create_pending_invoices` are nullable = "inherit" (the customer / the business),
    // and they are filtered RAW rather than resolved: `auto_collection[is]=off` means
    // this subscription's OVERRIDE is off, which is the field the response returns.
    auto_collection: { column: subscriptions.autoCollection, kind: "enum" },
    create_pending_invoices: { column: subscriptions.createPendingInvoices, kind: "bool" },
    net_term_days: { column: subscriptions.netTermDays, kind: "number" },
    po_number: { column: subscriptions.poNumber, kind: "text" },
    invoice_notes: { column: subscriptions.invoiceNotes, kind: "text" },
    default_payment_method: { column: subscriptionPaymentMethodSql, kind: "text" },
    coupon: { column: activeCouponCodeSql, kind: "text" },
    has_scheduled_changes: { column: hasScheduledChangesSql, kind: "bool" },
    plan_quantity: { column: planQuantitySql, kind: "number" },
    mrr: { column: subscriptions.mrr, kind: "number" },
    created_at: { column: subscriptions.createdAt, kind: "date" },
    updated_at: { column: subscriptions.updatedAt, kind: "date" },
    customer: { column: customers.publicId, kind: "text" },
    // The RESOLVED account-holder name (`customers/name-sql.ts`), matching what the
    // row renders. Against the bare `customers.name` column this returned an empty
    // page for any customer whose name lives in first/last — the operator types the
    // name they can see and the list tells them there is no such subscription.
    customer_name: { column: accountHolderNameSql, kind: "text" },
    customer_email: { column: customers.email, kind: "text" },
    // Company and phone are already selected for the list's Customer Info cell, so
    // filtering on them costs nothing extra.
    customer_company: { column: customers.company, kind: "text" },
    customer_phone: { column: customers.phone, kind: "text" },
  };
}

/** One representative spec map, for the mode-independent field/kind/operator tables. */
const FILTER_SHAPE = listFilters(DEFAULT_BILLING_MODE);

/**
 * Virtual fields: the plan (or any item's product) and any ADD-ON on the subscription,
 * each resolved with an EXISTS over items → price → product. The subscription list
 * filters by both, and a UI filter that only searched the loaded page would be a
 * filter that doesn't filter.
 */
/**
 * ── The stored instrument ("Payment Method" group) ─────────────────────────────
 *
 * EXISTS over the SUBSCRIPTION'S customer, on `payment_methods_customer_idx` (verified
 * against the live schema). Semantics are "this subscription's customer has ANY method
 * matching" — which is why the negation includes a customer holding no method at all,
 * per `existsFieldCondition`'s docblock.
 *
 * ⚠️ NOT the subscription's own `default_payment_method`, which is already a filter
 * above and answers a narrower question: which instrument THIS subscription is pinned
 * to. Two ids for one concept is how a saved segment and a filter panel start
 * disagreeing, so these keep the `payment_method_` prefix and that one keeps its name.
 */
const subPaymentMethodExists = (inner: SQL) =>
  sql`EXISTS (SELECT 1 FROM ${paymentMethods}
    WHERE ${paymentMethods.customerId} = ${subscriptions.customerId} AND ${inner})`;

const subPmGatewayAccountExists = (inner: SQL) =>
  sql`EXISTS (SELECT 1 FROM ${paymentMethods}
    JOIN ${gatewayAccounts} ON ${gatewayAccounts.id} = ${paymentMethods.gatewayAccountId}
    WHERE ${paymentMethods.customerId} = ${subscriptions.customerId} AND ${inner})`;

const pmVirtual = (col: Column): VirtualFilter => ({
  kind: "enum",
  condition: (op, v) => existsFieldCondition(subPaymentMethodExists, col, op, v),
});

const VIRTUAL_FILTERS: Record<string, VirtualFilter> = {
  payment_method_id: pmVirtual(paymentMethods.publicId),
  payment_method_type: pmVirtual(paymentMethods.type),
  payment_method_status: pmVirtual(paymentMethods.status),
  payment_method_gateway: pmVirtual(paymentMethods.providerKey),
  /** Shown as "Card Type" — Visa / Mastercard / RuPay, not card-vs-bank. */
  payment_method_brand: pmVirtual(paymentMethods.brand),
  payment_method_last4: pmVirtual(paymentMethods.last4),
  payment_method_exp_month: pmVirtual(paymentMethods.expMonth),
  payment_method_exp_year: pmVirtual(paymentMethods.expYear),
  payment_method_issuer_country: pmVirtual(paymentMethods.issuerCountry),
  /** The "Bank Account Type". */
  payment_method_sub_type: pmVirtual(paymentMethods.instrumentSubType),
  payment_method_role: pmVirtual(paymentMethods.role),
  payment_method_gateway_account: {
    kind: "enum",
    condition: (op, v) =>
      existsFieldCondition(subPmGatewayAccountExists, gatewayAccounts.publicId, op, v),
  },
};

const PLAN_FIELD = "plan";
const ADDON_FIELD = "addon";

export const SUBSCRIPTION_FILTER_OPS: Record<string, readonly string[]> = {
  ...opsFromSpecs(FILTER_SHAPE),
  ...opsFromSpecs(VIRTUAL_FILTERS),
  [PLAN_FIELD]: ["is", "contains", "starts_with"],
  // `addon[is_present]=true` is "has any add-on at all" — the plan field has no use for
  // it, since every subscription has at least one item.
  [ADDON_FIELD]: ["is", "contains", "starts_with", "is_present"],
};

/**
 * `field → kind`, so the ROUTE can reject a malformed VALUE (`mrr[between]=1000`,
 * `created_at[on]=31/08/2026`) with a 400 that names the shape instead of leaving the
 * Postgres cast to answer with a 500. Both virtual fields are text: each compares a
 * product id or name, and `is_present` validates the same way for every kind.
 */
export const SUBSCRIPTION_FILTER_KINDS: Record<string, FilterKind> = {
  ...kindsFromSpecs(FILTER_SHAPE),
  ...kindsFromSpecs(VIRTUAL_FILTERS),
  [PLAN_FIELD]: "text",
  [ADDON_FIELD]: "text",
};

/**
 * The business's own `cf_<api_name>` fields as filter specs, operators and kinds.
 *
 * They are per-business and created at runtime, so they cannot join the static maps
 * above — `modules/list-views/entities.ts` reads those and they must keep meaning what
 * they mean. A caller merges this over them for the one request it is serving.
 *
 * Here rather than in the route because this module owns WHICH jsonb column holds a
 * subscription's values. Both halves come from ONE definitions read: the route loads the
 * rows (it needs `ops`/`kinds` before `parseListQuery` will accept a `cf_*` filter) and
 * passes them to `listSubscriptionsPage` as `customFieldDefs`. Reading them again in the
 * service could disagree with the route's copy if a definition were created in between,
 * and would double the queries on every list page.
 *
 * Mode-independent, unlike `listFilters`: a jsonb value has no term-boundary convention.
 */
export function subscriptionCustomFieldFilterSet(defs: CustomFieldDefinitionRow[]) {
  return customFieldFilterSet(defs, subscriptions.customFields);
}

/**
 * Sortable columns. Only `created_at` is indexed
 * (`subscriptions_business_created_idx`) and therefore keyset-paginated; the rest are
 * plain per-row values on the business's own subscriptions, ordered under an offset
 * cursor. Nothing here reaches through the customers join or into a subquery — that
 * would sort by a per-row lookup over the whole filtered set.
 */
function listSorts(mode: BillingMode) {
  return {
    created_at: subscriptions.createdAt,
    updated_at: subscriptions.updatedAt,
    // Ordered on the STORED boundary, not the inclusive one the filter compares: the
    // two are one second apart, so the ordering is identical and the index stays usable.
    current_period_end: subscriptions.currentPeriodEnd,
    next_billing_at: nextBillingAtSql(mode),
    activated_at: subscriptions.activatedAt,
    started_at: subscriptions.startedAt,
    trial_end: subscriptions.trialEnd,
    mrr: subscriptions.mrr,
    status: apiStatusSql,
  };
}

export type SubscriptionSortField = keyof ReturnType<typeof listSorts>;
export const SUBSCRIPTION_SORT_FIELDS = Object.keys(
  listSorts(DEFAULT_BILLING_MODE),
) as SubscriptionSortField[];

export interface SubscriptionListFilters {
  /** Single customer (internal id) — the customer-detail page's own list. */
  customerId?: string;
  /** A set of customers (internal ids) — hydrates one page of a customers list. */
  customerIds?: string[];
  search?: string;
  filters?: ListFilter[];
  sortField?: string;
  sortDesc?: boolean;
  startingAfter?: string;
  limit?: number;
  /**
   * The business's `subscription` custom-field definitions, loaded once by the route
   * (see `subscriptionCustomFieldFilterSet`). Absent means no `cf_*` filter applies —
   * the right answer for a caller that never validated the query against them.
   */
  customFieldDefs?: CustomFieldDefinitionRow[];
  /** Widen to soft-deleted subscriptions too (`?include_deleted=true`). Absent = hidden. */
  includeDeleted?: boolean;
}

/**
 * Does the subscription carry an item whose product matches? `kind` narrows it to one
 * product kind — undefined for `plan` (which deliberately matches ANY item's product,
 * the behaviour it has always had), `"addon"` for the add-on filter.
 */
function itemProductCondition(op: string, value: string, kind?: string): SQL | undefined {
  const parts: SQL[] = [sql`${subscriptionItems.subscriptionId} = ${subscriptions.id}`];
  if (kind) parts.push(sql`${products.kind} = ${kind}`);
  if (op !== "is_present") {
    parts.push(
      op === "is"
        ? sql`(${products.publicId} = ${value} OR lower(${products.name}) = lower(${value}))`
        : op === "starts_with"
          ? sql`(${products.publicId} ILIKE ${value + "%"} OR ${products.name} ILIKE ${value + "%"})`
          : sql`(${products.publicId} ILIKE ${"%" + value + "%"} OR ${products.name} ILIKE ${"%" + value + "%"})`,
    );
  }
  const exists = sql`EXISTS (
    SELECT 1 FROM ${subscriptionItems}
    JOIN ${prices} ON ${prices.id} = ${subscriptionItems.priceId}
    JOIN ${products} ON ${products.id} = ${prices.productId}
    WHERE ${sql.join(parts, sql` AND `)}
  )`;
  // `is_present` asks about the KIND alone, so the negation is the whole EXISTS —
  // "no add-on at all", not "an add-on that doesn't match".
  if (op === "is_present") return value === "false" ? sql`NOT ${exists}` : exists;
  return exists;
}

/** Load the compact item views for a page of subscriptions (one extra query). */
async function itemsForSubs(
  tx: Tx,
  subIds: string[],
): Promise<Map<string, SubscriptionListItemView[]>> {
  const itemsBySub = new Map<string, SubscriptionListItemView[]>();
  if (subIds.length === 0) return itemsBySub;
  const itemRows = await tx
    .select({ item: subscriptionItems, price: prices, product: products })
    .from(subscriptionItems)
    .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .innerJoin(products, eq(prices.productId, products.id))
    .where(inArray(subscriptionItems.subscriptionId, subIds));
  for (const { item, price, product } of itemRows) {
    const snap = item.priceSnapshot as PriceSnapshot | null;
    const view: SubscriptionListItemView = {
      price: price.publicId,
      quantity: item.quantity,
      interval: price.interval,
      unit_price_minor:
        snap?.amountMinor ?? (price.amountMinor != null ? Number(price.amountMinor) : null),
      product_name: product.name,
      product_kind: product.kind,
    };
    itemsBySub.set(item.subscriptionId, [...(itemsBySub.get(item.subscriptionId) ?? []), view]);
  }
  return itemsBySub;
}

/**
 * One page of a business's subscriptions, newest-first.
 *
 * Keyset on `(created_at DESC, public_id DESC)` (index
 * `subscriptions_business_created_idx`); other sorts use an offset cursor. Items
 * are loaded for **the page only** — the unpaginated version fetched every item
 * row of every subscription in the business on every request.
 */
/**
 * The WHERE of the subscriptions list — shared by the page read and the count batch, so a
 * count and the list its drill-down opens can never disagree about a filter.
 */
export async function subscriptionListConditions(
  tx: Tx,
  businessId: string,
  f: SubscriptionListFilters,
  // The billing MODE, not just the timezone: it also carries the term-end convention
  // several filters compare against (a day-anchored business reports boundaries
  // inclusively — `inclusiveBoundarySql`). Passed in when the caller already read it.
  mode?: Awaited<ReturnType<typeof billingModeFor>>,
): Promise<SQL[]> {
  mode ??= await billingModeFor(tx, businessId);
  const conds: SQL[] = [eq(subscriptions.businessId, businessId)];
  if (!f.includeDeleted) conds.push(notDeleted());
  if (f.customerId) conds.push(eq(subscriptions.customerId, f.customerId));
  else if (f.customerIds) conds.push(inArray(subscriptions.customerId, f.customerIds) as SQL);
  const search = searchCondition(
    // Every DISPLAYED name column — see the `customer_name` filter above for why one
    // column was never enough, and `customers/names.ts` for why the deprecated
    // `customers.name` is no longer one of them.
    [
      subscriptions.publicId,
      subscriptions.status,
      customers.publicId,
      customers.firstName,
      customers.lastName,
      customers.company,
      customers.email,
    ],
    f.search,
  );
  if (search) conds.push(search);
  // Date filters bucket by the BUSINESS day, not the UTC day (business-tz.ts).
  // `cf_*` specs ride in the SAME call and the same zone, so a custom field of a given
  // kind filters exactly like a real column of that kind. Keys cannot collide: an
  // `api_name` may not itself start with `cf_` (custom-fields/service.ts) and no static
  // field does.
  const cfSpecs = f.customFieldDefs?.length
    ? subscriptionCustomFieldFilterSet(f.customFieldDefs).specs
    : undefined;
  conds.push(...filterConditions({ ...listFilters(mode), ...cfSpecs }, f.filters, mode.timezone));
  // The EXISTS-backed fields are not in `listFilters`, so `filterConditions` cannot
  // see them.
  for (const filter of f.filters ?? []) {
    const virtual = VIRTUAL_FILTERS[filter.field];
    const c = virtual
      ? virtual.condition(filter.op, filter.value)
      : filter.field === PLAN_FIELD
        ? itemProductCondition(filter.op, filter.value)
        : filter.field === ADDON_FIELD
          ? itemProductCondition(filter.op, filter.value, "addon")
          : undefined;
    if (c) conds.push(c);
  }

  return conds;
}

/**
 * Exact counts for several filter sets over the subscriptions list, in one transaction —
 * the list's own count query each, without fetching a page. Keyed by the caller's labels.
 */
export async function countSubscriptions(
  organizationId: string,
  businessId: string,
  sets: ReadonlyArray<{ key: string; filters: ListFilter[] }>,
  customFieldDefs?: SubscriptionListFilters["customFieldDefs"],
): Promise<Record<string, number>> {
  return withTenant(organizationId, async (tx) => {
    const mode = await billingModeFor(tx, businessId);
    const out: Record<string, number> = {};
    for (const set of sets) {
      const conds = await subscriptionListConditions(
        tx,
        businessId,
        { filters: set.filters, customFieldDefs },
        mode,
      );
      const [row] = await tx
        .select({ n: countExpr })
        .from(subscriptions)
        .leftJoin(customers, eq(subscriptions.customerId, customers.id))
        .where(and(...conds));
      out[set.key] = row?.n ?? 0;
    }
    return out;
  });
}

export async function listSubscriptionsPage(
  organizationId: string,
  businessId: string,
  f: SubscriptionListFilters = {},
): Promise<ListPage<SubscriptionListRow>> {
  const limit = clampLimit(f.limit);
  const sortField = (f.sortField ?? "created_at") as SubscriptionSortField;
  const descending = f.sortDesc ?? true;
  const keyset = sortField === "created_at";

  return withTenant(organizationId, async (tx) => {
    if (f.customerIds?.length === 0)
      return { data: [], hasMore: false, nextCursor: null, total: 0 };

    const mode = await billingModeFor(tx, businessId);
    const conds = await subscriptionListConditions(tx, businessId, f, mode);

    // Count with the same join, since customer columns are filterable.
    let total: number | null = null;
    if (!f.startingAfter) {
      total = await cappedTotal(
        tx,
        tx
          .select({ one: sql`1` })
          .from(subscriptions)
          .leftJoin(customers, eq(subscriptions.customerId, customers.id))
          .where(and(...conds)),
      );
    }

    const { keysetId, offset } = parseCursor(f.startingAfter);
    const pageConds = [...conds];
    if (keyset && keysetId) {
      const [cursor] = await tx
        .select({
          createdAt: sql<string>`${subscriptions.createdAt}::text`,
          publicId: subscriptions.publicId,
        })
        .from(subscriptions)
        .where(and(eq(subscriptions.businessId, businessId), eq(subscriptions.publicId, keysetId)))
        .limit(1);
      const seek = keysetCondition(
        subscriptions.createdAt,
        subscriptions.publicId,
        cursor ? { sortValue: cursor.createdAt, tiebreak: cursor.publicId } : undefined,
        descending,
      );
      if (seek) pageConds.push(seek);
    }

    const rows = await tx
      // First/last ride along with name/company/phone for the same reason those do —
      // one join, no extra query — and because the displayed name is resolved from all
      // of them (`accountHolderName`), not read out of `customers.name`.
      .select({
        s: subscriptions,
        cusPid: customers.publicId,
        cusEmail: customers.email,
        cusFirstName: customers.firstName,
        cusLastName: customers.lastName,
        cusCompany: customers.company,
        cusPhone: customers.phone,
      })
      .from(subscriptions)
      .leftJoin(customers, eq(subscriptions.customerId, customers.id))
      .where(and(...pageConds))
      .orderBy(...pageOrder(listSorts(mode)[sortField], subscriptions.publicId, descending, keyset))
      .limit(limit + 1)
      .offset(keyset ? 0 : offset);

    const page = toPage(rows, limit, { keyset, offset, keyOf: (r) => r.s.publicId, total });
    const itemsBySub = await itemsForSubs(
      tx,
      page.data.map((r) => r.s.id),
    );
    const recurringBySub = await recurringAmountsForSubs(
      tx,
      page.data.map((r) => r.s),
    );
    return {
      ...page,
      data: page.data.map((r) => ({
        subscription: r.s,
        customerPublicId: r.cusPid ?? null,
        customerEmail: r.cusEmail ?? null,
        customerName: accountHolderName({
          firstName: r.cusFirstName,
          lastName: r.cusLastName,
          company: r.cusCompany,
          email: r.cusEmail,
        }),
        customerCompany: r.cusCompany ?? null,
        customerPhone: r.cusPhone ?? null,
        items: itemsBySub.get(r.s.id) ?? [],
        recurringAmountMinor: recurringBySub.get(r.s.id) ?? null,
      })),
    };
  });
}

/**
 * Every subscription of a business (or one customer), unpaginated.
 * **Internal use only** — API routes use `listSubscriptionsPage`.
 */
export async function listSubscriptionsForBusiness(
  organizationId: string,
  businessId: string,
  opts?: { customerId?: string },
): Promise<SubscriptionListRow[]> {
  return withTenant(organizationId, async (tx) => {
    const where = opts?.customerId
      ? and(
          eq(subscriptions.businessId, businessId),
          eq(subscriptions.customerId, opts.customerId),
          notDeleted(),
        )
      : and(eq(subscriptions.businessId, businessId), notDeleted());
    const rows = await tx
      // First/last ride along with name/company/phone for the same reason those do —
      // one join, no extra query — and because the displayed name is resolved from all
      // of them (`accountHolderName`), not read out of `customers.name`.
      .select({
        s: subscriptions,
        cusPid: customers.publicId,
        cusEmail: customers.email,
        cusFirstName: customers.firstName,
        cusLastName: customers.lastName,
        cusCompany: customers.company,
        cusPhone: customers.phone,
      })
      .from(subscriptions)
      .leftJoin(customers, eq(subscriptions.customerId, customers.id))
      .where(where)
      .orderBy(desc(subscriptions.createdAt));
    const itemsBySub = await itemsForSubs(
      tx,
      rows.map((r) => r.s.id),
    );
    return rows.map((r) => ({
      subscription: r.s,
      customerPublicId: r.cusPid ?? null,
      customerEmail: r.cusEmail ?? null,
      customerName: accountHolderName({
        firstName: r.cusFirstName,
        lastName: r.cusLastName,
        company: r.cusCompany,
        email: r.cusEmail,
      }),
      customerCompany: r.cusCompany ?? null,
      customerPhone: r.cusPhone ?? null,
      items: itemsBySub.get(r.s.id) ?? [],
    }));
  });
}

// `SubscriptionItemView`/`SubscriptionDetail`/`getSubscriptionDetail` moved to
// `./serialize` (see the StoredSubscriptionStatus note above — same cycle
// concern). Re-exported so existing importers are unaffected.
import {
  type SubscriptionItemView,
  type SubscriptionDetail,
  getSubscriptionDetail,
} from "./serialize";
import { createLogger } from "@/platform/logger";

const log = createLogger("subscriptions");
export { type SubscriptionItemView, type SubscriptionDetail, getSubscriptionDetail };

/**
 * Update a subscription's collection/commercial settings (CP-1/CP-4). These are
 * plain fields — no proration or billing side effects.
 */
export async function updateSubscriptionSettings(input: {
  organizationId: string;
  businessId: string;
  subscriptionPublicId: string;
  autoCollection?: "on" | "off" | null;
  poNumber?: string | null;
  /** Ship-to: an `addr_…` id from the customer's address book; `null` = the default. */
  shippingAddressPublicId?: string | null;
  invoiceNotes?: string | null;
  customFields?: Record<string, unknown> | null;
  /**
   * Free-form metadata — REPLACED wholesale, not merged, matching what the create path
   * does with the same field.
   *
   * Distinct from `customFields` above, which is the admin-DEFINED `cf_*` subsystem and
   * is coerced against its definitions. This is the escape hatch, so it is written as
   * given. Editable here for the metadata-ONLY change: a caller flipping a flag with no
   * item movement should not have to mint a checkout page to do it, while a caller
   * moving both sends them together through the checkout session instead (see
   * `modules/checkout`), which is what keeps items and flags from landing apart.
   */
  metadata?: Record<string, unknown> | null;
  /**
   * How many cycles remain AFTER the current one (SUB-4) — the same meaning the create
   * path seeds and `renewal.ts` decrements, not "total cycles". `null` clears the cap
   * and the subscription renews forever; `0` makes the current term the last one, so it
   * reads `non_renewing` and cancels at term end.
   *
   * Editable because the alternative for an operator who needs "two more renewals then
   * stop" was a scheduled cancellation on a date they had to compute by hand. Display
   * shipped long before the write did.
   */
  remainingBillingCycles?: number | null;
  /**
   * Credits Flexibility (0219), subscription half — see `createSubscription`'s copy of
   * this doc. `null` clears the cap (back to whatever the business setting allows);
   * `0n` stops that bucket auto-applying to this subscription's invoices entirely.
   */
  maxRefundableCreditsUsageMinor?: bigint | null;
  maxExcessPaymentUsageMinor?: bigint | null;
  /** Net-D for invoices raised from now on; `null` falls back to the customer's / business's. */
  netTermDays?: number | null;
  /**
   * The payment method this subscription charges (internal id, already checked to belong
   * to its customer). `null` clears it — collection falls back to the customer's primary.
   */
  defaultPaymentMethodId?: string | null;
  /** How this business's metadata key rules apply to the write. Default `enforce`. */
  metadataRules?: MetadataRuleScope;
}): Promise<typeof subscriptions.$inferSelect | null> {
  return withTenant(input.organizationId, async (tx) => {
    const [cur] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.businessId, input.businessId),
          eq(subscriptions.publicId, input.subscriptionPublicId),
        ),
      )
      .limit(1);
    if (!cur) return null;
    const patch: Partial<typeof subscriptions.$inferInsert> = {};
    if (input.metadata !== undefined)
      await enforceMetadataRules(tx, input.businessId, "subscription", input.metadata, {
        mode: "update",
        existing: cur.metadata as Record<string, unknown> | null,
        scope: input.metadataRules,
      });
    if (input.netTermDays !== undefined) patch.netTermDays = input.netTermDays;
    if (input.defaultPaymentMethodId !== undefined)
      patch.defaultPaymentMethodId = input.defaultPaymentMethodId;
    if (input.autoCollection !== undefined) patch.autoCollection = input.autoCollection;
    if (input.maxRefundableCreditsUsageMinor !== undefined)
      patch.maxRefundableCreditsUsageMinor = input.maxRefundableCreditsUsageMinor;
    if (input.maxExcessPaymentUsageMinor !== undefined)
      patch.maxExcessPaymentUsageMinor = input.maxExcessPaymentUsageMinor;
    if (input.poNumber !== undefined) patch.poNumber = input.poNumber;
    if (input.shippingAddressPublicId !== undefined)
      patch.shippingAddressId = input.shippingAddressPublicId
        ? (
            await resolveAssignableAddress(tx, {
              businessId: input.businessId,
              customerId: cur.customerId,
              addressPublicId: input.shippingAddressPublicId,
            })
          ).id
        : null;
    if (input.invoiceNotes !== undefined) patch.invoiceNotes = input.invoiceNotes;
    if (input.remainingBillingCycles !== undefined)
      patch.remainingBillingCycles = input.remainingBillingCycles;
    if (input.metadata !== undefined) patch.metadata = input.metadata;
    if (input.customFields !== undefined) {
      const cf = await coerceCustomFields(
        tx,
        input.businessId,
        "subscription",
        input.customFields,
        {
          mode: "update",
          existing: (cur.customFields as Record<string, unknown> | null) ?? null,
        },
      );
      if (cf !== undefined) patch.customFields = cf;
    }
    // A re-save of the same values is not an edit: no write, no audit row, no event.
    const changed = effectivePatch(patch, cur);
    if (Object.keys(changed).length === 0) return cur;
    const row = await auditedSubscriptionUpdate(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      subscriptionPublicId: input.subscriptionPublicId,
      action: "subscription.update",
      mutate: async () => {
        const [r] = await tx
          .update(subscriptions)
          .set(changed)
          .where(
            and(
              eq(subscriptions.businessId, input.businessId),
              eq(subscriptions.publicId, input.subscriptionPublicId),
            ),
          )
          .returning();
        return r ?? null;
      },
    });
    if (row)
      await emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "subscription_changed",
        // Settings, not the plan: webhooks get it, the customer is not emailed about it.
        data: buildEventData(
          "subscription_changed",
          { id: row.publicId, status: row.status },
          row.resourceVersion,
          { settings_only: true },
        ),
      });
    return row;
  });
}

export async function getSubscriptionByPublicId(
  organizationId: string,
  businessId: string,
  subscriptionPublicId: string,
): Promise<typeof subscriptions.$inferSelect | null> {
  return withTenant(organizationId, async (tx) => {
    const [s] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.businessId, businessId),
          eq(subscriptions.publicId, subscriptionPublicId),
          notDeleted(),
        ),
      )
      .limit(1);
    return s ?? null;
  });
}

/**
 * Delete a subscription: a SOFT delete, and the only operation that makes a
 * subscription stop existing rather than stop renewing.
 *
 * What it does NOT do is as much the point as what it does. No status is written, no
 * cancellation is emitted, no term is closed and no credit is issued — so deleting an
 * ACTIVE subscription silently stops billing a paying customer. A merchant who wants the
 * ending on the record cancels instead; delete is for the subscription that should never
 * have been there.
 *
 * Everything it produced survives untouched: its invoices (paid or owed), its payments and
 * every ledger entry. They stay on the customer, and an unpaid invoice stays payable and
 * stays in dunning, because the debt is real whatever happened to the subscription that
 * raised it. A hard DELETE could not offer that — `invoices.subscription_id` is
 * ON DELETE SET NULL, so the money would outlive its own explanation.
 *
 * Returns null when there is nothing to delete, so a repeat call is a no-op rather than an
 * error: the caller can't tell a second delete from a first, and shouldn't have to.
 */
export async function deleteSubscription(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  now: Date;
}): Promise<Sub | null> {
  return withTenant(input.organizationId, async (tx) => {
    const [before] = await tx
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.id, input.subscriptionId), notDeleted()))
      .limit(1);
    if (!before) return null;
    const beforeSnapshot = await subscriptionSnapshot(tx, before);
    const [s] = await tx
      .update(subscriptions)
      .set({
        deletedAt: input.now,
        // The audit log is the full record of who did this; the column is here so the row
        // itself answers it without a join. `system` when nothing is bound — a seed, a
        // script — rather than a name we would be inventing.
        deletedBy: currentEventContext()?.actor ?? "system",
      })
      // Guarded on `deleted_at IS NULL`, so two concurrent deletes produce one stamp, one
      // event and one audit row. The loser sees no row and returns null, which is exactly
      // the repeat-call case above.
      .where(and(eq(subscriptions.id, input.subscriptionId), notDeleted()))
      .returning();
    if (!s) return null;
    await auditSubscription(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: "subscription.delete",
      before: beforeSnapshot,
      after: s,
    });
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "subscription_deleted",
      data: buildEventData(
        "subscription_deleted",
        // The status it held WHEN it was deleted, not a new one — an integrator needs to
        // know it dropped a live subscription, not a churned one.
        { id: s.publicId, status: apiSubscriptionStatus(s), deleted: true },
        s.resourceVersion,
      ),
    });
    return s;
  });
}

export async function getSubscriptionItems(
  organizationId: string,
  subscriptionId: string,
): Promise<Array<typeof subscriptionItems.$inferSelect>> {
  return withTenant(organizationId, async (tx) =>
    tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, subscriptionId)),
  );
}

type Sub = typeof subscriptions.$inferSelect;

/**
 * Cancel a subscription. `atPeriodEnd` true → keep it active and let the billing
 * clock cancel it when the term ends; false → cancel immediately.
 */
export async function cancelSubscription(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  atPeriodEnd: boolean;
  now: Date;
  cancelReason?: string | null; // system reason (SUB-8), e.g. not_paid
  cancelReasonCode?: string | null; // merchant reason code (SUB-8)
  /**
   * An operator's end-of-term cancel: record its `plan_credits.on_cancel_at_period_end`
   * (omitted value = the business rule). Absent = leave the stored rule alone.
   */
  planCredits?: { onCancelAtPeriodEnd?: PlanCreditCancelAtPeriodEnd };
}): Promise<Sub> {
  return withTenant(input.organizationId, async (tx) => {
    // On a DAY-ANCHORED business an immediate cancel floors both
    // canceledAt and the (now-ended) term end to the start of the cancel day in the
    // business timezone. The prorated cancellation credit is computed by the caller
    // from the PRE-cancel subscription, so shortening the term end here does not
    // affect the credit (see cancelWithOptions).
    let cancelInstant = input.now;
    let dayAnchored = false;
    let hasOpenTerm = false;
    let before: typeof subscriptions.$inferSelect | undefined;
    if (!input.atPeriodEnd) {
      const mode = await billingModeFor(tx, input.businessId);
      dayAnchored = mode.anchor === "day";
      cancelInstant = alignTermStart(input.now, mode);
      const [cur] = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, input.subscriptionId))
        .limit(1);
      hasOpenTerm = cur?.currentPeriodStart != null;
      before = cur;
    }
    const set: Omit<Partial<typeof subscriptions.$inferInsert>, "cancelBookedAt"> & {
      cancelBookedAt?: Date | null | SQL;
    } = input.atPeriodEnd
      ? // CMRR drops a booked stop from the moment it is booked; an earlier booking stands.
        {
          cancelAtPeriodEnd: true,
          cancelBookedAt: sql`coalesce(${subscriptions.cancelBookedAt}, ${input.now.toISOString()}::timestamptz)`,
        }
      : // A terminal cancel supersedes any PENDING cancellation, so both ways of holding one
        // are cleared: the specific-date column and the end-of-term flag. `cancelScheduledAt`
        // was cleared here from the start, on the stated grounds that "the cancelled
        // subscription doesn't keep advertising a future cancellation date" —
        // `cancelAtPeriodEnd` was not, and it advertises exactly that. The subscription then
        // reads `Cancelled` and `Cancellation scheduled — cancels on <date>` at the same time,
        // and the banner's "Remove scheduled cancellation" button calls
        // `removeScheduledCancellation`, which throws on any non-active subscription: a control
        // that renders and fails.
        //
        // `remainingBillingCycles` is deliberately NOT reset. A spent cycle count is a fact
        // about what happened (the term ran out), not a pending intent; nulling it would assert
        // "renews forever" on a dead subscription and lose the reason it ended.
        // (The `scheduled_changes` row is closed out as moot by the clock's next pass.)
        //
        // The day-anchored truncation closes an OPEN term at the cancel instant — so it only
        // applies where a term exists. Cancelling a TRIALLING subscription must not stamp one
        // (2026-08-25): the row has `current_period_start = null`, and writing an end alone
        // leaves a half-term that reads as a period beginning nowhere. `current_term_*`
        // stays null for a cancelled trial — nothing was ever billed, so no term ever
        // opened.
        {
          status: "cancelled",
          canceledAt: cancelInstant,
          cancelAtPeriodEnd: false,
          cancelScheduledAt: null,
          cancelBookedAt: before ? frozenStopBooking(before, cancelInstant) : null,
          ...(dayAnchored && hasOpenTerm ? { currentPeriodEnd: cancelInstant } : {}),
        };
    if (input.cancelReason !== undefined) set.cancelReason = input.cancelReason;
    if (input.cancelReasonCode !== undefined) set.cancelReasonCode = input.cancelReasonCode;
    const [s] = await tx
      .update(subscriptions)
      .set(set)
      .where(eq(subscriptions.id, input.subscriptionId))
      .returning();
    if (input.atPeriodEnd && input.planCredits) {
      const { noteCancelCreditRule } = await import("@/modules/credits/credit-clock");
      await noteCancelCreditRule(tx, input.subscriptionId, input.planCredits.onCancelAtPeriodEnd);
    }
    // A cancelled subscription generates no recurring revenue, so its cached `mrr`
    // must be 0 — the rule `recomputeSubscriptionMrr` documents and enforces off the
    // row's status. NOTHING called it on any cancel path, so a churned subscription
    // kept its full pre-cancel rate: the API and the detail page reported live MRR
    // for a cancelled sub, and `mrr[gt]=0` returned it as revenue-bearing. The
    // importer already wrote 0, so an imported cancellation and an engine one
    // disagreed on the same screen. Called AFTER the status write, inside the same
    // transaction, exactly as that function's contract requires.
    const mrr = input.atPeriodEnd
      ? s!.mrr
      : await recomputeSubscriptionMrr(tx, s!.id, cancelInstant);
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: input.atPeriodEnd ? "subscription_cancel_scheduled" : "subscription_canceled",
      data: buildEventData(
        input.atPeriodEnd ? "subscription_cancel_scheduled" : "subscription_canceled",
        { id: s!.publicId, status: input.atPeriodEnd ? apiSubscriptionStatus(s!) : "cancelled" },
        s!.resourceVersion,
      ),
    });
    // `s` was captured before the recompute, so return the corrected figure with it.
    return { ...s!, mrr };
  });
}

export type CancelOption = "immediately" | "end_of_term" | "specific_date";
export type CreditOptionForTerm = "none" | "prorate" | "full";
export type UnbilledChargesOption = "invoice" | "delete";
/**
 * What to do with invoices still OPEN when a subscription is cancelled immediately.
 *
 * `write_off` and `void` are not the same event and must not be conflated: a write-off
 * keeps the invoice and records the loss (the revenue was earned and will not be
 * collected), while a void says the invoice should never have stood at all. The ledger
 * treatment differs and so does what the customer's statement shows, which is why they
 * are separate options rather than one "clear them" action.
 */
export type ArHandling = "no_action" | "schedule_payment_collection" | "write_off" | "void";
export type RefundableCreditsHandling = "no_action" | "schedule_refund";

/**
 * Cancel with the full option set (SUB-5 + SUB-8). Orchestrates the primitive
 * cancel plus the side-decisions available at immediate cancel:
 *  - `credit_option_for_current_term_charges` → E5 prorated/full credit note
 *    (paid term → refundable CN, unpaid → adjustment CN),
 *  - `unbilled_charges_option` → invoice or delete pending unbilled charges,
 *  - `account_receivables_handling` → leave / collect / write off open invoices,
 *  - `refundable_credits_handling` → schedule a refund of the refundable bucket.
 * `end_of_term` sets cancel_at_period_end; `specific_date` schedules a future
 * cancel. Returns the (possibly still-active) subscription + a summary of effects.
 */
export async function cancelSubscriptionWithOptions(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  now: Date;
  cancelOption?: CancelOption;
  cancelAt?: Date;
  creditOptionForCurrentTermCharges?: CreditOptionForTerm;
  unbilledChargesOption?: UnbilledChargesOption;
  accountReceivablesHandling?: ArHandling;
  refundableCreditsHandling?: RefundableCreditsHandling;
  cancelReasonCode?: string | null;
  cancelReason?: string | null;
  /**
   * `include_cancellation_day_in_billing`: whether the prorated credit bills the day of
   * the cancellation (true — the whole-day default) or credits it too (false). Validated
   * here; only meaningful with whole-day proration.
   */
  includeCancellationDayInBilling?: boolean;
  /** The validated form of the above, as a scheduled cancel carries it to apply time. */
  excludeCancellationDay?: boolean;
  /**
   * `none`: an omitted money option does nothing — no credit, unbilled charges and open
   * invoices left as they are, no refund — instead of taking the business's cancel
   * defaults (0242). A chargeback policy cancel uses it: it must never refund or collect.
   */
  moneyDefaults?: "business" | "none";
  /** `final_period` (specific_date only): the credit for the last term, as the business rule. */
  finalPeriod?: SpecificDateFinalPeriod;
  /** `plan_credits.on_cancel_at_period_end` for this cancel (end_of_term / specific_date). */
  planCreditsOnCancelAtPeriodEnd?: PlanCreditCancelAtPeriodEnd;
}): Promise<{
  subscription: Sub;
  creditNote: string | null;
  scheduledChange: string | null;
  /**
   * Side-effects of an immediate cancel that did NOT complete (a credit that could
   * not be issued, an invoice that could not be written off or collected, a refund
   * the gateway refused). The cancellation itself stands — these are reported rather
   * than thrown, because throwing after the status write 500s a cancellation that
   * really happened and leaves no way to finish the rest. Empty on every other path.
   */
  warnings: string[];
}> {
  const { organizationId, businessId } = input;
  const sub = await getSubscriptionByPublicIdInternal(organizationId, input.subscriptionId);
  if (!sub) throw new SubscriptionError("Subscription not found");
  if (sub.status === "cancelled") throw new SubscriptionError("Subscription is already cancelled");

  // H1 (SET-1..3): fill omitted options from the business billing-rule defaults.
  const [biz] = await withTenant(organizationId, (tx) =>
    tx
      .select({
        cancelOption: businesses.defaultCancelOption,
        creditOption: businesses.defaultCreditOptionForCancel,
        unbilled: businesses.defaultUnbilledOnCancel,
        // 0242: the two halves of the cancel screen this function has always
        // accepted per call but had no business default for.
        arHandling: businesses.defaultArHandlingOnCancel,
        refundableCredits: businesses.defaultRefundableCreditsOnCancel,
        backdatingConfig: businesses.backdatingConfig,
        timezone: businesses.timezone,
        billingRulesConfig: businesses.billingRulesConfig,
      })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1),
  );
  const cancelOption = (input.cancelOption ??
    (biz?.cancelOption as CancelOption | undefined) ??
    "immediately") as CancelOption;
  const noDefaults = input.moneyDefaults === "none";
  const overrideProblem = cancelOverrideProblem({
    cancelOption,
    creditOption: input.creditOptionForCurrentTermCharges,
    finalPeriod: input.finalPeriod,
    planCreditsOnCancelAtPeriodEnd: input.planCreditsOnCancelAtPeriodEnd,
  });
  if (overrideProblem) throw new SubscriptionError(overrideProblem);
  // A date-specific cancel has its own final-period default (billing_rules_config), which
  // falls back to the cancel credit default when unset.
  const creditOption = (input.creditOptionForCurrentTermCharges ??
    (input.finalPeriod ? FINAL_PERIOD_CREDIT_OPTION[input.finalPeriod] : undefined) ??
    (noDefaults
      ? undefined
      : cancelOption === "specific_date"
        ? FINAL_PERIOD_CREDIT_OPTION[
            resolveBillingRulesConfig({
              billingRulesConfig: biz?.billingRulesConfig,
              defaultCreditOptionForCancel: biz?.creditOption,
            }).specificDateCancelFinalPeriod
          ]
        : (biz?.creditOption as CreditOptionForTerm | undefined))) as
    | CreditOptionForTerm
    | undefined;
  const unbilledOption = (input.unbilledChargesOption ??
    (noDefaults ? undefined : (biz?.unbilled as UnbilledChargesOption | undefined))) as
    | UnbilledChargesOption
    | undefined;
  // Both columns are NOT NULL DEFAULT 'no_action', which is the same fallback the
  // `applyCancelMoneyHandling` call below used to inline — so an untouched business is
  // unchanged by this wiring.
  const arHandling = (input.accountReceivablesHandling ??
    (noDefaults ? undefined : (biz?.arHandling as ArHandling | undefined)) ??
    "no_action") as ArHandling;
  const refundableHandling = (input.refundableCreditsHandling ??
    (noDefaults ? undefined : (biz?.refundableCredits as RefundableCreditsHandling | undefined)) ??
    "no_action") as RefundableCreditsHandling;

  // 0242 — BACKDATING WINDOW, enforced here rather than at the route because this is
  // where the business row is already read; `withSub`'s `business` is a narrow type that
  // does not carry the config. A past `cancelAt` is a backdated cancellation.
  // `raisesPastDatedInvoice` is false: a cancel raises credit notes and collections,
  // never a past-dated invoice, so neither invoice-date consent applies.
  if (input.cancelAt) {
    const verdict = isBackdateAllowed({
      config: resolveBackdatingConfig(biz),
      action: "cancel",
      target: input.cancelAt,
      now: input.now,
      businessTimezone: biz?.timezone ?? null,
      raisesPastDatedInvoice: false,
    });
    if (!verdict.allowed) throw new SubscriptionError(verdict.message);
  }

  if (input.includeCancellationDayInBilling !== undefined) {
    const problem = await cancellationDayProblem({
      organizationId,
      businessId,
      sub,
      cancelOption,
      creditOption,
      cancelAt: input.cancelAt,
    });
    if (problem) throw new SubscriptionError(problem);
  }
  const excludeCancellationDay =
    input.excludeCancellationDay === true || input.includeCancellationDayInBilling === false;

  // A `future` sub has never started or billed: cancelling it (by ANY option) is a
  // cancel-before-start → terminal cancel now, no money, no deferral. Otherwise an
  // end_of_term flag would let startFutureSubscriptions start + bill it first
  // (review blocker: end_of_term cancel on a future sub still billed period 1).
  // Post-H (#10): every cancel path writes an audit row (was only the immediately
  // path — end_of_term/specific_date/future left no trail).
  const { writeAuditLog } = await import("@/modules/audit/service");
  // 0149: the pre-cancel record, for the contextual diff. Captured ONCE here, before
  // any of the four paths below runs, because each of them mutates the row. The
  // hand-built `before`/`after` maps on each call are kept as-is: they carry the
  // option set (cancel_option, credit_option, the credit note raised), which is the
  // operator's intent and appears in no column, so a pure snapshot diff would lose it.
  const beforeFull = await snapshotSubscriptionById(organizationId, sub.id);
  if (sub.status === "future") {
    const cancelled = await cancelSubscription({
      organizationId,
      businessId,
      subscriptionId: sub.id,
      atPeriodEnd: false,
      now: input.now,
      cancelReasonCode: input.cancelReasonCode,
    });
    await writeAuditLog({
      organizationId,
      businessId,
      action: "subscription.cancel",
      resourceType: "subscription",
      resourceId: cancelled.publicId,
      before: { status: sub.status },
      after: {
        status: cancelled.status,
        cancel_option: "immediately",
        reason: "cancel_before_start",
      },
      beforeFull,
      afterFull: await snapshotSubscriptionById(organizationId, sub.id),
    });
    return { subscription: cancelled, creditNote: null, scheduledChange: null, warnings: [] };
  }

  // A PAUSED subscription has no term end the clock will ever reach: the renewal
  // scan is `status IN ('in_trial','active')`, so `cancel_at_period_end` on a paused
  // row is never acted on. It was accepted anyway — flag set, `apiSubscriptionStatus`
  // still reporting `paused` (non_renewing folds only over `active`), and the
  // cancellation simply never happening. Measured: 30 days past term end, still
  // paused. Rejected rather than silently reinterpreted — cancelling now and
  // cancelling at some future boundary have different money consequences, and
  // guessing which one the merchant meant is not ours to do. Both alternatives are
  // available and are named in the message; note `specific_date` DOES work on a
  // paused subscription, because the scheduled-changes pass acts on any status.
  if (cancelOption === "end_of_term" && sub.status === "paused") {
    throw new SubscriptionError(
      "A paused subscription has no term end to cancel at. Resume it first, or use cancel_option=immediately or specific_date.",
    );
  }

  // end_of_term → flag cancel_at_period_end (renewal cancels at term end, no money now).
  if (cancelOption === "end_of_term") {
    const s = await cancelSubscription({
      organizationId,
      businessId,
      subscriptionId: sub.id,
      atPeriodEnd: true,
      now: input.now,
      cancelReasonCode: input.cancelReasonCode,
      // Stored now, like the immediate path; the term-end cancel leaves it in place.
      cancelReason: input.cancelReason,
      planCredits: { onCancelAtPeriodEnd: input.planCreditsOnCancelAtPeriodEnd },
    });
    await writeAuditLog({
      organizationId,
      businessId,
      action: "subscription.cancel",
      resourceType: "subscription",
      resourceId: s.publicId,
      before: { status: sub.status },
      after: { status: s.status, cancel_option: "end_of_term", cancel_at_period_end: true },
      beforeFull,
      afterFull: await snapshotSubscriptionById(organizationId, sub.id),
    });
    return { subscription: s, creditNote: null, scheduledChange: null, warnings: [] };
  }

  // specific_date → schedule a future cancel (applied by the billing clock),
  // CARRYING the money-handling options so apply-time reproduces them (SUB-5).
  if (cancelOption === "specific_date") {
    if (!input.cancelAt)
      throw new SubscriptionError("cancel_option=specific_date requires cancel_at");
    // A past `cancel_at` was accepted and reported as "scheduled", then fired on the
    // next tick — the caller was told the subscription cancels on a date that had
    // already gone, when what they actually got was an immediate cancel a minute
    // late. If that is the intent, `cancel_option: 'immediately'` says so and runs
    // the money handling synchronously.
    if (input.cancelAt.getTime() <= input.now.getTime()) {
      throw new SubscriptionError(
        "cancel_at must be in the future. To cancel now, use cancel_option=immediately.",
      );
    }
    const { scheduleChange } = await import("./scheduled-changes");
    const row = await scheduleChange({
      organizationId,
      businessId,
      subscriptionId: sub.id,
      type: "cancel",
      effectiveAt: input.cancelAt,
      cancelOptions: {
        creditOptionForCurrentTermCharges: creditOption,
        unbilledChargesOption: unbilledOption,
        accountReceivablesHandling: input.accountReceivablesHandling,
        refundableCreditsHandling: input.refundableCreditsHandling,
        cancelReasonCode: input.cancelReasonCode,
        ...(input.cancelReason !== undefined ? { cancelReason: input.cancelReason } : {}),
        ...(excludeCancellationDay ? { excludeCancellationDay: true } : {}),
      },
    });
    // `scheduleChange` has projected the pending cancel onto the subscription
    // (`cancel_scheduled_at`), so it now reads as `non_renewing` with a
    // `canceled_at` — exactly like an end_of_term one (0159). Before that it was
    // indistinguishable from a subscription that renews forever, everywhere except
    // the scheduled_changes sub-resource. Stamp the merchant's reason code the same
    // way the other three paths do, then re-read for the response.
    if (input.cancelReasonCode !== undefined || input.cancelReason !== undefined) {
      await withTenant(organizationId, (tx) =>
        tx
          .update(subscriptions)
          .set({
            ...(input.cancelReasonCode !== undefined
              ? { cancelReasonCode: input.cancelReasonCode }
              : {}),
            ...(input.cancelReason !== undefined ? { cancelReason: input.cancelReason } : {}),
          })
          .where(eq(subscriptions.id, sub.id)),
      );
    }
    {
      const { noteCancelCreditRule } = await import("@/modules/credits/credit-clock");
      await withTenant(organizationId, (tx) =>
        noteCancelCreditRule(tx, sub.id, input.planCreditsOnCancelAtPeriodEnd),
      );
    }
    const scheduled = await getSubscriptionByPublicIdInternal(organizationId, sub.id);
    await writeAuditLog({
      organizationId,
      businessId,
      action: "subscription_cancel_scheduled",
      resourceType: "subscription",
      resourceId: sub.publicId,
      before: { status: sub.status },
      after: {
        status: apiSubscriptionStatus(scheduled!),
        cancel_option: "specific_date",
        cancel_at: input.cancelAt,
        scheduled_change: row.publicId,
      },
      beforeFull,
      afterFull: await snapshotSubscriptionById(organizationId, sub.id),
    });
    return {
      subscription: scheduled!,
      creditNote: null,
      scheduledChange: row.publicId,
      warnings: [],
    };
  }

  // immediately → terminal cancel + side-effects.
  // 0) The open usage window ends here: queue it so step 1 invoices (or deletes) it too.
  await withTenant(organizationId, async (tx) => {
    const items = await tx
      .select({ id: subscriptionItems.id })
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, sub.id));
    await settleMeteredUsage(
      tx,
      sub,
      items.map((i) => i.id),
      input.now,
    );
  });
  // 1) Unbilled charges: invoice or delete BEFORE cancelling.
  const { invoiceUnbilledCharges, deleteUnbilledCharges } = await import("./items");
  if (unbilledOption === "invoice")
    await invoiceUnbilledCharges({
      organizationId,
      businessId,
      subscriptionId: sub.id,
      now: input.now,
    });
  else if (unbilledOption === "delete")
    await deleteUnbilledCharges({ organizationId, businessId, subscriptionId: sub.id });

  // 2) Terminal cancel (system + merchant reason).
  const cancelled = await cancelSubscription({
    organizationId,
    businessId,
    subscriptionId: sub.id,
    atPeriodEnd: false,
    now: input.now,
    cancelReason: input.cancelReason,
    cancelReasonCode: input.cancelReasonCode,
  });

  // Steps 3–5 run AFTER the subscription is already cancelled, in their own
  // transactions (the credit is pure DB; collection and refunds call the gateway, so
  // they cannot be held inside one). A throw here used to 500 a cancellation that had
  // ALREADY happened, skip the audit row entirely, and leave the caller with no way
  // forward: the retry hits `Subscription is already cancelled` and refuses, so the
  // customer's cancellation credit could never be issued through the API. Each step is
  // now isolated and REPORTED — the cancellation stands, the audit row is always
  // written, and `warnings` names precisely what did not happen so an operator can
  // finish it by hand. (Making cancel+credit genuinely atomic is a deeper refactor:
  // every helper opens its own `withTenant`. Filed, not attempted here.)
  const warnings: string[] = [];

  // 3) Credit for the unused portion of the current term (E5 helper).
  let creditNote: string | null = null;
  if (creditOption && creditOption !== "none") {
    try {
      const { issueProratedCreditForUnusedTerm } = await import("./cancellation-credit");
      const cn = await issueProratedCreditForUnusedTerm({
        // Use the PRE-cancel subscription: on DAY-ANCHORED businesses cancelSubscription
        // shortens currentPeriodEnd to the cancel day, but the credit must be prorated
        // against the ORIGINAL term end. (A no-op for instant-anchored businesses.)
        organizationId,
        businessId,
        subscription: sub,
        creditOption,
        now: input.now,
        ...(excludeCancellationDay ? { excludeCancellationDay: true } : {}),
        reason: "Cancellation credit for unused term",
      });
      creditNote = cn?.publicId ?? null;
    } catch (e) {
      // The subscription IS cancelled — only the credit failed, so this stays a 200
      // with a `warnings` entry rather than a 500 (see applyCancelMoneyHandling).
      // But a warning in a response body is not a RECORD: the dashboard renders it
      // once in a toast and keeps nothing, so credit the customer is owed and did
      // not get has to be answerable from the logs alone.
      log.error(e, {
        event: "cancel_credit_not_issued",
        subscription: sub.publicId,
        businessId: businessId,
        creditOption,
      });
      warnings.push(
        `We could not issue the cancellation credit (${creditOption}): ${(e as Error)?.message ?? String(e)}`,
      );
    }
  }

  // 3b) The term ends early: its prorated minimum commitment, after the credit above. The
  // cancel's unbilled-charges option decides it like any other queued charge.
  try {
    const booked = await withTenant(organizationId, async (tx) =>
      bookEarlyEndCommitment(tx, sub, input.now, await billingModeFor(tx, businessId)),
    );
    if (booked && unbilledOption === "invoice")
      await invoiceUnbilledCharges({
        organizationId,
        businessId,
        subscriptionId: sub.id,
        now: input.now,
      });
    else if (booked && unbilledOption === "delete")
      await deleteUnbilledCharges({ organizationId, businessId, subscriptionId: sub.id });
  } catch (e) {
    log.error(e, { event: "cancel_commitment_not_booked", subscription: sub.publicId, businessId });
    warnings.push(
      `We could not raise the minimum commitment adjustment: ${(e as Error)?.message ?? String(e)}`,
    );
  }

  // 4) Open-invoice (AR) handling + 5) refundable-credit handling.
  warnings.push(
    ...(await applyCancelMoneyHandling({
      organizationId,
      businessId,
      subscription: cancelled,
      arHandling,
      refundableHandling,
      now: input.now,
    })),
  );

  // 6) A trial cancelled before it converted has ZERO LENGTH — it never happened.
  //
  // `trial_end` collapses onto `trial_start`, not onto the cancellation instant.
  // Measured directly on a cancelled trial:
  //
  //     trial_start = 2026-08-24T18:30    trial_end = 2026-08-24T18:30
  //
  // both the START OF THE SIGNUP DAY. The first version of this set `trial_end = now` and
  // was wrong for a reason worth keeping: "truncate to the cancel instant" is the intuitive
  // reading and the data says otherwise — a trial that never ran is zero-length where it
  // began, not a short trial that ended when the customer left.
  //
  // We left `trial_end` at its ORIGINAL end, so a cancelled trial went on advertising a
  // trial running to 2026-09-07, in every later snapshot.
  //
  // TRIAL ONLY, and that limit is measured rather than assumed: a PAID cancel KEEPS the
  // term — `termStart` retained, `termEnd` moved to the cancel instant, which is what we
  // already do. Nulling on every cancel would strand the credit path, which reads
  // `currentPeriodStart/End` to prorate.
  //
  // Runs LAST for that reason: `cancelSubscription` above, then the credit and AR/refundable
  // work, all of which read the term. Only once nothing else needs it is it safe to touch.
  //
  // ⚠ ONLY `trial_end` is corrected here. The TERM cannot be nulled without a migration:
  // `current_period_start`/`current_period_end` are `.notNull()`
  // (db/schema/subscriptions.ts:52-53), so our data model REQUIRES a term — and
  // `subscriptions_due_idx` is built on `current_period_end`, so the billing clock and
  // renewal selection read it on every pass. That is a schema change with real blast
  // radius, not a patch.
  const wasInTrial = sub.status === "in_trial";
  if (wasInTrial) {
    // `trialStart` is stamped with the term start when the trial begins
    // (`trialStart: isTrial ? termStart : null`), so it is the same instant we collapse to;
    // the term start is the fallback for a row written before that stamp existed.
    const collapseTo = sub.trialStart ?? sub.currentPeriodStart;
    await withTenant(organizationId, (tx) =>
      tx.update(subscriptions).set({ trialEnd: collapseTo }).where(eq(subscriptions.id, sub.id)),
    );
  }

  if (warnings.length > 0) {
    log.error(
      "subscription was cancelled but one or more side-effects did not complete — see warnings",
      {
        event: "cancel_side_effects_incomplete",
        subscription: cancelled.publicId,
        incomplete: warnings.length,
        warnings,
      },
    );
  }
  await writeAuditLog({
    organizationId,
    businessId,
    action: "subscription.cancel",
    resourceType: "subscription",
    resourceId: cancelled.publicId,
    before: { status: sub.status },
    after: {
      status: cancelled.status,
      cancel_option: cancelOption,
      credit_option: creditOption ?? "none",
      credit_note: creditNote,
      ...(warnings.length > 0 ? { warnings } : {}),
    },
    beforeFull,
    afterFull: await snapshotSubscriptionById(organizationId, sub.id),
  });
  return { subscription: cancelled, creditNote, scheduledChange: null, warnings };
}

/**
 * Why a per-call override cannot apply to this cancel, or null. Refused rather than ignored,
 * like `include_cancellation_day_in_billing`. Shared with the cancel estimate.
 */
export function cancelOverrideProblem(input: {
  cancelOption: CancelOption;
  creditOption: CreditOptionForTerm | undefined;
  finalPeriod: SpecificDateFinalPeriod | undefined;
  planCreditsOnCancelAtPeriodEnd: PlanCreditCancelAtPeriodEnd | undefined;
}): string | null {
  if (input.finalPeriod && input.cancelOption !== "specific_date")
    return "final_period applies only to cancel_option=specific_date. Remove final_period, or set cancel_option=specific_date.";
  if (input.finalPeriod && input.creditOption)
    return "final_period and credit_option_for_current_term_charges set the same credit. Send only one of them.";
  if (input.planCreditsOnCancelAtPeriodEnd && input.cancelOption === "immediately")
    return "plan_credits.on_cancel_at_period_end applies only to a cancel at the end of the term or on a date. Remove plan_credits, or set cancel_option=end_of_term or specific_date.";
  return null;
}

/**
 * Why `include_cancellation_day_in_billing` cannot apply to this cancel, or null. It only
 * moves a whole-day prorated credit, so every other shape is refused rather than ignored.
 * Shared with the cancel estimate so the preview refuses what the cancel refuses.
 */
export async function cancellationDayProblem(input: {
  organizationId: string;
  businessId: string;
  sub: { status: string; currentPeriodEnd: Date | null };
  cancelOption: CancelOption;
  creditOption: CreditOptionForTerm | undefined;
  cancelAt?: Date;
}): Promise<string | null> {
  const p = "include_cancellation_day_in_billing";
  const mode = await loadBillingMode(input.organizationId, input.businessId);
  if (mode.proration !== "whole_day")
    return `${p} applies only to a business with whole-day proration`;
  if (input.cancelOption !== "immediately" && input.cancelOption !== "specific_date")
    return `${p} applies only to cancel_option=immediately or specific_date`;
  if (input.creditOption !== "prorate")
    return `${p} applies only with credit_option_for_current_term_charges=prorate`;
  if (input.sub.status !== "active")
    return `${p} applies only to an active subscription. This subscription is ${input.sub.status}.`;
  if (
    input.cancelOption === "specific_date" &&
    input.cancelAt &&
    input.sub.currentPeriodEnd &&
    input.cancelAt.getTime() >= input.sub.currentPeriodEnd.getTime()
  )
    return `${p} applies only to a cancel_at within the current term`;
  return null;
}

/** Load a subscription by public id (org-scoped) — small internal helper. */
async function getSubscriptionByPublicIdInternal(
  organizationId: string,
  subscriptionId: string,
): Promise<Sub | null> {
  return withTenant(organizationId, async (tx) => {
    const [s] = await tx
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.id, subscriptionId), notDeleted()))
      .limit(1);
    return s ?? null;
  });
}

/** Apply the AR + refundable-credit handling side-decisions of an immediate cancel. */
async function applyCancelMoneyHandling(input: {
  organizationId: string;
  businessId: string;
  subscription: Sub;
  arHandling: ArHandling;
  refundableHandling: RefundableCreditsHandling;
  now: Date;
}): Promise<string[]> {
  const { organizationId, businessId, subscription: sub } = input;
  const { OPEN_INVOICE_STATUSES } = await import("@/modules/invoicing/status");
  // Open invoices for this subscription.
  const open = await withTenant(organizationId, async (tx) =>
    tx
      .select()
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.subscriptionId, sub.id),
          inArray(invoicesTable.status, [...OPEN_INVOICE_STATUSES]),
        ),
      ),
  );

  // Per-item failures are collected, not thrown: this runs AFTER the subscription is
  // already cancelled, so throwing here 500s a cancellation that has in fact happened
  // — and the caller's retry is then refused by the `already cancelled` guard, so the
  // remaining side-effects could never be completed through the API. `writeOffInvoice`
  // was unwrapped, so one bad invoice stranded every invoice after it in the loop.
  const warnings: string[] = [];

  if (input.arHandling === "write_off") {
    const { writeOffInvoice } = await import("@/modules/invoicing/ops");
    for (const inv of open) {
      if ((inv.amountDueMinor ?? inv.totalMinor) > 0n) {
        try {
          await writeOffInvoice(organizationId, businessId, inv.publicId);
        } catch (e) {
          // AR the operator asked to clear is still on the books, and the loop
          // deliberately continues past it — nothing downstream re-raises, so this
          // line is the only trace outside the response body.
          log.error(e, {
            event: "cancel_writeoff_failed",
            invoice: inv.publicId,
            subscription: sub.publicId,
            businessId: businessId,
          });
          warnings.push(
            `We could not write off invoice ${inv.publicId}: ${(e as Error)?.message ?? String(e)}`,
          );
        }
      }
    }
  } else if (input.arHandling === "void") {
    const { voidInvoice } = await import("@/modules/invoicing/ops");
    for (const inv of open) {
      /**
       * NO amount-due guard, unlike `write_off` above. Writing off a zero-due invoice is
       * a no-op worth skipping; VOIDING one is not — a posted invoice with nothing left
       * due is exactly the invoice an operator means when they say it should never have
       * stood. `voidInvoice` refuses a settled-archival or already-closed invoice itself,
       * so the guard would only ever skip cases it handles better.
       */
      try {
        await voidInvoice(organizationId, businessId, inv.publicId);
      } catch (e) {
        // Same reasoning as the write-off loop: the operator asked for these to be
        // cleared, one failure must not strand the rest, and nothing downstream
        // re-raises — so this line and the warning are the only trace.
        log.error(e, {
          event: "cancel_void_failed",
          invoice: inv.publicId,
          subscription: sub.publicId,
          businessId: businessId,
        });
        warnings.push(
          `We could not void invoice ${inv.publicId}: ${(e as Error)?.message ?? String(e)}`,
        );
      }
    }
  } else if (input.arHandling === "schedule_payment_collection") {
    const { collectInvoiceNow } = await import("@/modules/invoicing/ops");
    for (const inv of open) {
      // A refused collection is the EXPECTED outcome here, not a fault — the invoice
      // stays open and dunning picks it up. Recorded all the same, so "why is this
      // still unpaid after cancellation" is answerable.
      try {
        await collectInvoiceNow(organizationId, businessId, inv.publicId);
      } catch (e) {
        // WARN, not error: a refused collection is the expected outcome here and
        // dunning still owns the invoice. Logged all the same so "why is this still
        // unpaid after cancellation" is answerable without the response body.
        log.warn("cancellation collection refused — invoice left open for dunning", {
          event: "cancel_collect_failed",
          invoice: inv.publicId,
          subscription: sub.publicId,
          businessId: businessId,
          error: (e as Error)?.message ?? String(e),
        });
        warnings.push(
          `We could not collect invoice ${inv.publicId}. It stays open for dunning. Reason: ${(e as Error)?.message ?? String(e)}`,
        );
      }
    }
  }
  // 'no_action' → leave open invoices as they stand.

  if (input.refundableHandling === "schedule_refund") {
    // Refund every still-refundable credit note the customer holds to the payable.
    const { refundCreditNote } = await import("@/modules/credit-notes/service");
    const cns = await withTenant(organizationId, async (tx) =>
      tx
        .select()
        .from(creditNotesTable)
        .where(
          and(
            eq(creditNotesTable.customerId, sub.customerId),
            eq(creditNotesTable.kind, "refundable"),
          ),
        ),
    );
    for (const cn of cns) {
      const available = creditNoteSpendable(cn);
      if (cn.status !== "voided" && available > 0n) {
        try {
          await refundCreditNote({ organizationId, businessId, creditNotePublicId: cn.publicId });
        } catch (e) {
          // Cash the customer is owed did not leave the account. The payout machinery
          // logs its own failures, but a refusal raised BEFORE it (validation, no
          // payable payment, a voided note) never reaches those lines.
          log.error(e, {
            event: "cancel_refund_failed",
            creditNote: cn.publicId,
            subscription: sub.publicId,
            businessId: businessId,
            availableMinor: String(available),
          });
          warnings.push(
            `We could not refund credit note ${cn.publicId}: ${(e as Error)?.message ?? String(e)}`,
          );
        }
      }
    }
  }
  return warnings;
}

/** Pause a subscription — the billing clock skips paused subs (not billed). */
export async function pauseSubscription(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  /** The instant the pause takes effect — a deferred pause applies at its own date. */
  now?: Date;
  /** Who started this pause; the portal lets a customer end only a `retention_offer` one. */
  source?: "operator" | "retention_offer";
  /** `plan_credits.on_pause` for this pause only; omitted = the business rule. */
  planCreditsOnPause?: PlanCreditPause;
}): Promise<Sub> {
  return withTenant(input.organizationId, async (tx) => {
    const [current] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, input.subscriptionId))
      .limit(1);
    const before = current ? await subscriptionSnapshot(tx, current) : null;
    // Plan credit windows that started before the pause are granted first (G3b §6).
    if (current && current.status !== "paused") {
      const { onSubscriptionPaused } = await import("@/modules/credits/credit-clock");
      await onSubscriptionPaused(tx, current, input.now ?? stampNow(input.businessId), {
        onPause: input.planCreditsOnPause,
      });
    }
    const [s] = await tx
      .update(subscriptions)
      .set({ status: "paused", pauseSource: input.source ?? "operator" })
      .where(eq(subscriptions.id, input.subscriptionId))
      .returning();
    // A paused subscription earns nothing, so its cached MRR goes to 0 — the rule lives
    // in `recomputeSubscriptionMrr` and is called AFTER the status write so it reads the
    // new status. In the same transaction as the pause: the cached figure is what the
    // list shows, sorts and filters on, so a failure between the two would leave a
    // paused row still advertising its rate. `resumeSubscription` recomputes likewise
    // and restores it.
    await recomputeSubscriptionMrr(tx, input.subscriptionId, input.now);
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "subscription_paused",
      data: buildEventData(
        "subscription_paused",
        { id: s!.publicId, status: "paused" },
        s!.resourceVersion,
      ),
    });
    // `pauseSubscriptionWithOptions` delegates here, so the option-set path is audited
    // by this one call — auditing both would write two rows for one pause.
    await auditSubscription(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: "subscription.pause",
      before,
      after: s!,
    });
    return s!;
  });
}

/**
 * Reactivate a subscription:
 *  - if it's set to cancel at period end (still active) → just clear that flag,
 *  - if it's already canceled → start a fresh term from `now` (active), and flag
 *    `billable: true` so the caller bills the new period in advance.
 * Throws if the subscription is active and not pending cancellation.
 */
/**
 * On a DAY-ANCHORED business a (re)started term floors to the start of the day in the
 * business timezone — same as createSubscription. Returns the term start to use:
 * floored when day-anchored, else `now` unchanged. Used by the reactivate/resume paths
 * (createSubscription + cancel already align directly).
 */
async function alignedTermStart(tx: Tx, businessId: string, now: Date): Promise<Date> {
  return alignTermStart(now, await billingModeFor(tx, businessId));
}

export async function reactivateSubscription(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  now: Date;
}): Promise<{ subscription: Sub; billable: boolean }> {
  return withTenant(input.organizationId, async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, input.subscriptionId))
      .limit(1);
    if (!sub) throw new SubscriptionError("Subscription not found");

    if (sub.status !== "cancelled") {
      if (
        !sub.cancelAtPeriodEnd &&
        sub.cancelScheduledAt == null &&
        sub.remainingBillingCycles !== 0
      ) {
        throw new SubscriptionError("Subscription is not cancelled or pending cancellation");
      }
      // Clear a scheduled cancellation (remove_scheduled_cancellation, SUB-2): reset
      // the flag, a pending specific_date cancel, and the exhausted cycle counter so
      // it renews indefinitely.
      const before = await subscriptionSnapshot(tx, sub);
      // As in removeScheduledCancellation: withdraw the row the clock would act on,
      // in this transaction, or reactivating leaves a cancel still armed.
      const withdrawn = await tx
        .update(scheduledChanges)
        .set({ status: "canceled" })
        .where(
          and(
            eq(scheduledChanges.subscriptionId, sub.id),
            eq(scheduledChanges.type, "cancel"),
            eq(scheduledChanges.status, "scheduled"),
          ),
        )
        .returning({ publicId: scheduledChanges.publicId });
      for (const row of withdrawn) {
        await emitEvent(tx, {
          organizationId: input.organizationId,
          businessId: input.businessId,
          type: "subscription_scheduled_change_removed",
          data: buildEventData("subscription_scheduled_change_removed", {
            id: sub.publicId,
            scheduled_change: row.publicId,
          }),
        });
      }
      const [updated] = await tx
        .update(subscriptions)
        .set({
          cancelAtPeriodEnd: false,
          cancelScheduledAt: null,
          cancelBookedAt: null,
          remainingBillingCycles: null,
        })
        .where(eq(subscriptions.id, sub.id))
        .returning();
      await emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "subscription_reactivated",
        data: buildEventData(
          "subscription_reactivated",
          { id: sub.publicId, status: updated!.status },
          updated!.resourceVersion,
        ),
      });
      await auditSubscription(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        action: "subscription.reactivate",
        before,
        after: updated!,
      });
      return { subscription: updated!, billable: false };
    }

    // Already cancelled → new term from now. Cadence from the first recurring item.
    const itemRows = await tx
      .select({ item: subscriptionItems, price: prices })
      .from(subscriptionItems)
      .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
      .where(eq(subscriptionItems.subscriptionId, sub.id));
    const rec = itemRows.find(
      (r) =>
        (r.item.priceSnapshot as { type?: string } | null)?.type === "recurring" ||
        r.price.type === "recurring",
    );
    const snap = rec?.item.priceSnapshot as { interval?: string; intervalCount?: number } | null;
    const interval = (snap?.interval ?? rec?.price.interval ?? "month") as Interval;
    const intervalCount = snap?.intervalCount ?? rec?.price.intervalCount ?? 1;
    const termStart = await alignedTermStart(tx, input.businessId, input.now);
    const reMode = await billingModeFor(tx, input.businessId);
    // The new term anchors on its own start, as `reactivateSubscriptionWithOptions` does.
    // The old anchor made a full-price term of the wrong length (8th-anchored, reactivated
    // on the 23rd: 23rd → 8th, 16 days billed as a month).
    const reactivatedAnchorDay =
      interval === "month" || interval === "year"
        ? localDatePartsInTz(termStart, reMode.timezone).day
        : null;
    // See createSubscription: UTC-calendar clamping puts a month-end term a day late on a
    // non-UTC business.
    const periodEnd = advancePeriod(
      termStart,
      interval,
      intervalCount,
      reactivatedAnchorDay,
      reMode,
    );
    // Snapshot BEFORE the update: `sub` is the pre-update row, but the item read
    // inside `subscriptionSnapshot` hits the database, so taking it afterwards would
    // silently pick up any item change a future edit to this path introduces.
    const before = await subscriptionSnapshot(tx, sub);
    const [updated] = await tx
      .update(subscriptions)
      .set({
        status: "active",
        currentPeriodStart: termStart,
        currentPeriodEnd: periodEnd,
        ...newTermFields(
          { ...sub, billingAnchorDay: reactivatedAnchorDay },
          termStart,
          periodEnd,
          reMode,
        ),
        billingAnchorDay: reactivatedAnchorDay,
        canceledAt: null,
        cancelAtPeriodEnd: false,
        cancelScheduledAt: null,
        cancelBookedAt: null,
        // Reset the cancellation state fully (review fix): a cycle-exhausted sub
        // (remaining_billing_cycles=0) otherwise reactivates straight into derived
        // non_renewing and re-cancels after one term; stale reason codes lingered.
        remainingBillingCycles: null,
        cancelReason: null,
        cancelReasonCode: null,
        // Re-stamp ONLY start_date = now so the first-period heal (current_period_start
        // = start_date, active, no invoice) covers a crash between this status tx and
        // the caller's billing. started_at/activated_at are preserved — they record the
        // ORIGINAL signup/activation history, which metrics read; re-stamping them lost it
        // (G backlog). It is the ALIGNED term start, not raw `now` — the heal signature
        // compares it to `current_period_start`, and on a day-anchored business the raw
        // instant never equals it, so the heal it exists for could not fire.
        startDate: termStart,
      })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    // A sub cancelled DURING a trial stored `mrr = 0`; this reactivation starts a paid
    // term, so the real rate has to be restated (see `recomputeSubscriptionMrr`). The
    // recompute runs after `.returning()`, so carry its value onto the row we hand
    // back — the caller serializes this object, and a stale `mrr` on it would report
    // the pre-reactivation figure over the API.
    const netMrr = await recomputeSubscriptionMrr(tx, sub.id, termStart);
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "subscription_reactivated",
      data: buildEventData(
        "subscription_reactivated",
        { id: sub.publicId, status: updated!.status },
        updated!.resourceVersion,
      ),
    });
    await auditSubscription(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: "subscription.reactivate",
      before,
      after: { ...updated!, mrr: netMrr },
    });
    return { subscription: { ...updated!, mrr: netMrr }, billable: true };
  });
}

/**
 * Reactivate a dunning-cancelled subscription INTO ITS CURRENT TERM (`findInTermReactivation`):
 * the term, items and start date stay as they are and nothing is billed. Keeping
 * `start_date` is what keeps the first-period heal away; it also finds the term's invoice.
 */
export async function reactivateSubscriptionInTerm(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  now: Date;
  billingCycles?: number | null;
}): Promise<{ subscription: Sub }> {
  return withTenant(input.organizationId, async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, input.subscriptionId))
      .limit(1);
    if (!sub) throw new SubscriptionError("Subscription not found");
    const { findInTermReactivation } = await import("./in-term-reactivation");
    if (!(await findInTermReactivation(tx, sub, input.now)))
      throw new SubscriptionError(
        "We could not reactivate the subscription in its current term. The term ended or its invoice is voided.",
      );
    const before = await subscriptionSnapshot(tx, sub);
    const [updated] = await tx
      .update(subscriptions)
      .set({
        status: "active",
        canceledAt: null,
        cancelAtPeriodEnd: false,
        cancelScheduledAt: null,
        cancelBookedAt: null,
        remainingBillingCycles: input.billingCycles ?? null,
        cancelReason: null,
        cancelReasonCode: null,
      })
      .where(and(eq(subscriptions.id, sub.id), eq(subscriptions.status, "cancelled")))
      .returning();
    if (!updated) throw new SubscriptionError("Subscription is not cancelled");
    // Dated now, not at the term start: the churn was booked on the cancel day.
    const netMrr = await recomputeSubscriptionMrr(tx, sub.id, input.now);
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "subscription_reactivated",
      data: buildEventData(
        "subscription_reactivated",
        { id: sub.publicId, status: updated.status },
        updated.resourceVersion,
      ),
    });
    await auditSubscription(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: "subscription.reactivate",
      before,
      after: { ...updated, mrr: netMrr },
    });
    return { subscription: { ...updated, mrr: netMrr } };
  });
}

/** One desired line of a reactivated subscription (public price id + overrides). */
export interface ReactivationItemInput {
  /** Price public id (e.g. `price_…`). */
  price: string;
  quantity?: number;
  /** Custom per-unit price in minor units (flat/per-unit only). */
  unitPriceMinor?: number | null;
  freeQuantity?: number | null;
  billingCycles?: number | null;
}

/**
 * Edit-a-cancelled-subscription = REACTIVATION. Unlike
 * `changeSubscription` (which prorates against the current term), a cancelled sub
 * has no live term, so this starts a FRESH term from `now` and — when `items` is
 * given — rebuilds the line set from scratch (like `createSubscription`), never
 * prorating. The caller (route) then bills the fresh term per the invoicing
 * option (`billable`/`isTrial` drive that), exactly as `reactivateSubscription`.
 *
 * `items` are the FULL desired set (plan + add-ons + charges); the frontend
 * already auto-includes mandatory add-ons, so no mandatory expansion happens here.
 */
export async function reactivateSubscriptionWithOptions(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  now: Date;
  /** Full desired line set. When omitted, the existing items are kept as-is. */
  items?: ReactivationItemInput[];
  /** Cap the reactivated lifecycle to N cycles (null/undefined = forever). */
  billingCycles?: number | null;
  /** Reactivate into a trial ending at this instant (no immediate charge). */
  trialEnd?: Date | null;
}): Promise<{ subscription: Sub; billable: boolean; isTrial: boolean }> {
  const { organizationId, businessId, subscriptionId, now } = input;
  return withTenant(organizationId, async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    if (!sub) throw new SubscriptionError("Subscription not found");
    if (sub.status !== "cancelled") {
      throw new SubscriptionError(
        `You can reactivate only a cancelled subscription with changes. This subscription is ${sub.status}.`,
      );
    }

    // Resolve the desired item set (when provided) into concrete prices + snapshots.
    let resolved: SubscriptionItemInput[] | null = null;
    if (input.items && input.items.length > 0) {
      resolved = [];
      for (const it of input.items) {
        const [price] = await tx
          .select()
          .from(prices)
          .where(and(eq(prices.businessId, businessId), eq(prices.publicId, it.price)))
          .limit(1);
        if (!price) throw new SubscriptionError(`We could not find the price ${it.price}.`);
        if (price.currency !== sub.currency) {
          throw new SubscriptionError("You cannot reactivate with a price in a different currency");
        }
        if (it.unitPriceMinor != null) {
          if (!isOverridable(price.model)) {
            throw new SubscriptionError(
              `You can set a custom price only on a flat or per_unit price. This price is ${price.model}.`,
            );
          }
          if (it.unitPriceMinor < 0)
            throw new SubscriptionError("unit_price_minor must be 0 or more");
        }
        resolved.push({
          price,
          quantity: it.quantity ?? 1,
          customAmountMinor: it.unitPriceMinor ?? undefined,
          freeQuantity: it.freeQuantity ?? undefined,
          billingCycles: it.billingCycles ?? undefined,
        });
      }
      const recurring = resolved.find((i) => i.price.type === "recurring");
      if (!recurring)
        throw new SubscriptionError("A subscription needs at least one recurring price");
      // Reactivation rebuilds the item set, so it needs create's cadence guard too —
      // it only ever validated currency and custom prices. Same cycle the block below
      // re-derives from `resolved`; computed here because the snapshots need it.
      const newCycle = {
        interval: (recurring.price.interval ?? "month") as Interval,
        intervalCount: recurring.price.intervalCount ?? 1,
      };
      for (const i of resolved) {
        const reason = cadenceMismatch(i.price, newCycle.interval, newCycle.intervalCount);
        if (reason) throw new SubscriptionError(reason);
      }

      // Rebuild items from scratch (fresh lifecycle — old rows are dropped).
      await tx.delete(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub.id));
      await tx.insert(subscriptionItems).values(
        resolved.map((i) => ({
          organizationId,
          businessId,
          subscriptionId: sub.id,
          publicId: publicId("si"),
          priceId: i.price.id,
          quantity: i.quantity,
          freeQuantity: i.freeQuantity ?? null,
          billingCycles: i.billingCycles ?? null,
          metadata: i.metadata ?? null,
          priceSnapshot: alignSnapshotToCycle(
            snapshotPrice(i.price, i.customAmountMinor, i.customTiers),
            newCycle,
          ),
        })),
      );
      await syncMeterBilling(tx, sub.id);
    }

    // Cadence from the (new or existing) recurring item.
    let interval: Interval;
    let intervalCount: number;
    if (resolved) {
      const rec = resolved.find((i) => i.price.type === "recurring")!;
      interval = (rec.price.interval ?? "month") as Interval;
      intervalCount = rec.price.intervalCount ?? 1;
    } else {
      const itemRows = await tx
        .select({ item: subscriptionItems, price: prices })
        .from(subscriptionItems)
        .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
        .where(eq(subscriptionItems.subscriptionId, sub.id));
      const rec = itemRows.find(
        (r) =>
          (r.item.priceSnapshot as { type?: string } | null)?.type === "recurring" ||
          r.price.type === "recurring",
      );
      const snap = rec?.item.priceSnapshot as { interval?: string; intervalCount?: number } | null;
      interval = (snap?.interval ?? rec?.price.interval ?? "month") as Interval;
      intervalCount = snap?.intervalCount ?? rec?.price.intervalCount ?? 1;
    }

    const isTrial = !!input.trialEnd;
    // Reactivation opens a fresh term, so both of its boundaries go through the mode —
    // the trial end included. Left raw it started the new term off local midnight, which
    // is the same day-early-renewal bug `editTrialEnd` had (the anchor day and the term
    // start then disagree about which calendar day the term is on).
    const mode = await billingModeFor(tx, input.businessId);
    const termStart = alignTermStart(now, mode);
    const trialEnd = isTrial ? alignTrialEnd(input.trialEnd!, mode) : null;
    // The FIRST real term of a trialling subscription is stamped here, not at creation
    // (a trial has no term), so this is the boundary most signups actually get.
    // THE ANCHOR THE REACTIVATED TERM TAKES: the local day-of-month of its own start — the
    // same rule `createSubscription` uses for a fresh term (`billingAnchorDay` defaulting to
    // the start day, below) and `changeSubscription`'s reset uses for a restarted one
    // (`resetAnchorDay`, proration.ts). This was `sub.billingAnchorDay`, the anchor from
    // BEFORE the cancellation, while the write below never replaced it — so the boundary
    // landed on the old day of the month. Measured 2026-08-31: a sub anchored on the 8th,
    // reactivated on the 23rd onto a YEARLY price, ran 2026-08-23 → 2027-08-**08** — 350 days,
    // billed as a full year by the reactivate route (which calls `billSubscriptionPeriod` over
    // the stored term), i.e. 15 days the customer paid for and did not get. `advancePeriod`
    // takes the result's day-of-month ENTIRELY from this argument, so a stale anchor relocates
    // the boundary silently rather than erroring.
    //
    // A resume after the paid term ended re-anchors the same way (2026-11-03); a resume
    // inside the paid term keeps that term.
    //
    // `null` outside month/year mirrors both sibling sites: a day-of-month means nothing to a
    // day/week term, and `advancePeriod` hands those straight to `addInterval`.
    const reactivatedAnchorDay =
      interval === "month" || interval === "year"
        ? localDatePartsInTz(termStart, mode.timezone).day
        : null;
    const periodEnd =
      trialEnd ?? advancePeriod(termStart, interval, intervalCount, reactivatedAnchorDay, mode);

    const [updated] = await tx
      .update(subscriptions)
      .set({
        status: isTrial ? "in_trial" : "active",
        // NO TERM WHILE TRIALLING. A trial is not a billing term — the two are mutually
        // exclusive (`current_term_*` absent in trial, `trial_*` absent after) and we
        // carried both, which also left a cancelled trial holding a term that never ran.
        // The trial's own end is the boundary; `renewal.ts` selects trials by `trial_end`
        // and the conversion below stamps the first real term.
        currentPeriodStart: isTrial ? null : termStart,
        currentPeriodEnd: isTrial ? null : periodEnd,
        ...newTermFields(
          {
            ...sub,
            billingPeriodUnit: interval,
            billingPeriod: intervalCount,
            billingAnchorDay: reactivatedAnchorDay,
          },
          isTrial ? null : termStart,
          isTrial ? null : periodEnd,
          mode,
        ),
        billingPeriod: intervalCount,
        billingPeriodUnit: interval,
        // Written for BOTH branches, trial included: a reactivation into a trial opens its
        // first paid term at the trial end and `renewSubscription` anchors that term off this
        // column, so leaving the pre-cancellation value here would push the same stale boundary
        // one conversion downstream instead of removing it. A trialling CREATE anchors to the
        // signup day the same way.
        billingAnchorDay: reactivatedAnchorDay,
        // The trial and the term begin together, so `trial_start`/`start_date` are the
        // ALIGNED start — stamping raw `now` here made the timeline disagree with the term
        // it describes. `activated_at` stays the real instant: it is an audit stamp.
        trialStart: isTrial ? termStart : null,
        trialEnd,
        activatedAt: isTrial ? null : now,
        canceledAt: null,
        cancelAtPeriodEnd: false,
        cancelScheduledAt: null,
        cancelBookedAt: null,
        remainingBillingCycles: input.billingCycles ?? null,
        cancelReason: null,
        cancelReasonCode: null,
        startDate: termStart,
      })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    // The rate is NOT written above: `recomputeSubscriptionMrr` rates the items just saved
    // (snapshots and discounts), stores it with `last_earning_mrr`, and appends the
    // `reactivation` movement 0 → rate. Writing `mrr` directly skipped that movement, so the
    // ledger never heard of the reactivation. Into a trial it stores 0 and appends nothing.
    const netMrr = await recomputeSubscriptionMrr(tx, sub.id, termStart);
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "subscription_reactivated",
      data: buildEventData(
        "subscription_reactivated",
        { id: sub.publicId, status: updated!.status },
        updated!.resourceVersion,
      ),
    });
    return { subscription: { ...updated!, mrr: netMrr }, billable: !isTrial, isTrial };
  });
}

/**
 * Resume a paused subscription with the business's resume defaults. A thin alias of
 * {@link resumeSubscriptionWithOptions}, so every resume shares one billing rule.
 */
export async function resumeSubscription(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  /** The instant the resume takes effect — a scheduled resume applies at its own date. */
  now?: Date;
}): Promise<Sub> {
  const { subscription } = await resumeSubscriptionWithOptions({
    ...input,
    now: input.now ?? new Date(),
  });
  return subscription;
}

/** Remove a scheduled cancellation (SUB-2): clear cancel_at_period_end + reset an
 * exhausted remaining_billing_cycles → the sub renews again (leaves non_renewing).
 *
 * Covers BOTH ways a cancellation can be pending. This used to handle only the
 * `end_of_term` flag and threw "Subscription has no scheduled cancellation" at a
 * subscription that visibly had one — a `specific_date` cancel could be created
 * through this endpoint's sibling (`/cancel`) but undone only through a different
 * endpoint (`DELETE /scheduled_changes/{sch}`), which required knowing the `sch_`
 * id. The dashboard used the delete path so it worked there; API consumers hit
 * the wall. */
export async function removeScheduledCancellation(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  /** Cycles to run after the current one once un-cancelled. Omitted = renew forever. */
  billingCycles?: number;
}): Promise<Sub> {
  return withTenant(input.organizationId, async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, input.subscriptionId))
      .limit(1);
    if (!sub) throw new SubscriptionError("Subscription not found");
    if (sub.status !== "active")
      throw new SubscriptionError(
        `You can remove the scheduled cancellation only from an active subscription. This subscription is ${sub.status}.`,
      );
    if (
      !sub.cancelAtPeriodEnd &&
      sub.cancelScheduledAt == null &&
      sub.remainingBillingCycles !== 0
    ) {
      throw new SubscriptionError("Subscription has no scheduled cancellation");
    }
    const before = await subscriptionSnapshot(tx, sub);
    // Withdraw the executing row too, or the billing clock would still cancel the
    // subscription on the date — the flag clear alone would be cosmetic. Done in
    // THIS transaction (not via `cancelScheduledChange`, which opens its own
    // `withTenant`) so the row and the column can never disagree.
    const withdrawn = await tx
      .update(scheduledChanges)
      .set({ status: "canceled" })
      .where(
        and(
          eq(scheduledChanges.subscriptionId, sub.id),
          eq(scheduledChanges.type, "cancel"),
          eq(scheduledChanges.status, "scheduled"),
        ),
      )
      .returning({ publicId: scheduledChanges.publicId });
    for (const row of withdrawn) {
      await emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "subscription_scheduled_change_removed",
        data: buildEventData("subscription_scheduled_change_removed", {
          id: sub.publicId,
          scheduled_change: row.publicId,
        }),
      });
    }
    const [s] = await tx
      .update(subscriptions)
      .set({
        cancelAtPeriodEnd: false,
        cancelScheduledAt: null,
        cancelBookedAt: null,
        remainingBillingCycles: input.billingCycles ?? null,
      })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "subscription_scheduled_cancellation_removed",
      data: buildEventData(
        "subscription_scheduled_cancellation_removed",
        { id: s!.publicId, status: apiSubscriptionStatus(s!) },
        s!.resourceVersion,
      ),
    });
    await auditSubscription(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: "subscription.remove_scheduled_cancellation",
      before,
      after: s!,
    });
    return s!;
  });
}

export type PauseOption = "immediately" | "end_of_term" | "specific_date" | "billing_cycles";
export type DunningHandling = "continue" | "stop";
export type ResumeChargesHandling = "invoice_immediately" | "add_to_unbilled_charges";
export type UnpaidInvoicesHandling = "no_action" | "schedule_payment_collection";

/**
 * Pause with the full option set (SUB-6). `immediately` pauses now;
 * `end_of_term`/`specific_date` schedule the pause; `billing_cycles` pauses now
 * and auto-resumes after `skip_billing_cycles` cadence intervals (a scheduled
 * resume the clock applies). `unbilled_charges_handling` invoices/deletes pending
 * charges; `dunning_handling='stop'` halts dunning on the sub's open invoices.
 */
export async function pauseSubscriptionWithOptions(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  now: Date;
  /** Omitted resolves `businesses.pause_config.pause_option` (0242). */
  pauseOption?: PauseOption;
  pauseDate?: Date;
  skipBillingCycles?: number;
  /** `no_action` keeps pending charges for the resumption invoice, whatever the business default. */
  unbilledChargesHandling?: UnbilledChargesOption | "no_action";
  dunningHandling?: DunningHandling;
  /** Schedule the resume for this instant (a `resume` scheduled change). */
  resumeDate?: Date;
  /** Who started the pause; carried to a deferred pause. Omitted = `operator`. */
  source?: "operator" | "retention_offer";
  /** `plan_credits.on_pause` for this pause; carried to a deferred pause. Omitted = business rule. */
  planCreditsOnPause?: PlanCreditPause;
}): Promise<{ subscription: Sub; resumeScheduledAt: Date | null; scheduledChange: string | null }> {
  const { organizationId, businessId } = input;
  const sub = await getSubscriptionByPublicIdInternal(organizationId, input.subscriptionId);
  if (!sub) throw new SubscriptionError("Subscription not found");
  // A `future` sub hasn't started — pausing it (and resuming it into billing before
  // its start date) is a state hole; cancel-before-start is the only valid stop.
  if (sub.status === "cancelled" || sub.status === "paused" || sub.status === "future")
    throw new SubscriptionError(`You cannot pause a ${sub.status} subscription`);

  // 0242: fill omitted options from the business pause defaults. Every default resolves
  // to what this function already did when the argument was absent, so an unconfigured
  // business is unchanged — `retain` and `continue` both mean "take the branch below at
  // all", which is why they map to `undefined` rather than to a value.
  const pauseCfg = resolvePauseConfig(
    (
      await withTenant(organizationId, (tx) =>
        tx
          .select({ pauseConfig: businesses.pauseConfig })
          .from(businesses)
          .where(eq(businesses.id, businessId))
          .limit(1),
      )
    )[0],
  );
  const pauseOption: PauseOption = input.pauseOption ?? pauseCfg.pauseOption;
  const unbilledChargesHandling: UnbilledChargesOption | undefined =
    input.unbilledChargesHandling === "no_action"
      ? undefined
      : (input.unbilledChargesHandling ??
        (pauseCfg.unbilledOnPause === "invoice"
          ? ("invoice" as UnbilledChargesOption)
          : undefined));
  const dunningHandling =
    input.dunningHandling ??
    (pauseCfg.dunningOnPause === "stop" ? ("stop" as DunningHandling) : undefined);

  // `resume_date` — checked before anything is written, against the instant the pause lands.
  if (input.resumeDate) {
    if (pauseOption === "billing_cycles")
      throw new SubscriptionError(
        "You cannot use resume_date with pause_option=billing_cycles. That option schedules its own resume.",
      );
    const pausesAt =
      pauseOption === "end_of_term"
        ? sub.currentPeriodEnd
        : pauseOption === "specific_date"
          ? input.pauseDate
          : input.now;
    if (pausesAt && input.resumeDate.getTime() <= pausesAt.getTime())
      throw new SubscriptionError("resume_date must be after the pause takes effect");
    if (sub.cancelScheduledAt && input.resumeDate.getTime() >= sub.cancelScheduledAt.getTime())
      throw new SubscriptionError("resume_date must be before the scheduled cancellation");
  }
  const scheduleResume = async (): Promise<Date | null> => {
    if (!input.resumeDate) return null;
    const { scheduleChange } = await import("./scheduled-changes");
    await scheduleChange({
      organizationId,
      businessId,
      subscriptionId: sub.id,
      type: "resume",
      effectiveAt: input.resumeDate,
    });
    return input.resumeDate;
  };

  // Deferred pause (end_of_term / specific_date) → schedule it, no state change now.
  if (pauseOption === "end_of_term" || pauseOption === "specific_date") {
    const at = pauseOption === "end_of_term" ? sub.currentPeriodEnd : input.pauseDate;
    if (!at) throw new SubscriptionError("pause_option=specific_date requires pause_date");
    const { scheduleChange } = await import("./scheduled-changes");
    const pauseOptions = {
      ...(input.unbilledChargesHandling
        ? { unbilledChargesHandling: input.unbilledChargesHandling }
        : {}),
      ...(input.dunningHandling ? { dunningHandling: input.dunningHandling } : {}),
      ...(input.source === "retention_offer" ? { source: input.source } : {}),
      ...(input.planCreditsOnPause ? { planCreditsOnPause: input.planCreditsOnPause } : {}),
    };
    const row = await scheduleChange({
      organizationId,
      businessId,
      subscriptionId: sub.id,
      type: "pause",
      effectiveAt: at,
      // The caller's own options, not the resolved defaults: pause_config is read when it lands.
      ...(Object.keys(pauseOptions).length ? { pauseOptions } : {}),
    });
    const resumeAt = await scheduleResume();
    return { subscription: sub, resumeScheduledAt: resumeAt, scheduledChange: row.publicId };
  }

  // Unbilled charges handling at pause.
  if (unbilledChargesHandling) {
    const { invoiceUnbilledCharges, deleteUnbilledCharges } = await import("./items");
    if (unbilledChargesHandling === "invoice")
      await invoiceUnbilledCharges({
        organizationId,
        businessId,
        subscriptionId: sub.id,
        now: input.now,
      });
    else await deleteUnbilledCharges({ organizationId, businessId, subscriptionId: sub.id });
  }
  // Dunning handling: stop dunning on the sub's open, in-progress invoices.
  if (dunningHandling === "stop") {
    const { stopDunning } = await import("./dunning");
    const open = await withTenant(organizationId, (tx) =>
      tx
        .select()
        .from(invoicesTable)
        .where(
          and(eq(invoicesTable.subscriptionId, sub.id), eq(invoicesTable.status, "payment_due")),
        ),
    );
    for (const inv of open) {
      try {
        await stopDunning(organizationId, businessId, inv.publicId);
      } catch (e) {
        log.warn("could not stop dunning on cancel", {
          invoice: inv.publicId,
          error: (e as Error)?.message,
        });
      }
    }
  }

  const paused = await pauseSubscription({
    organizationId,
    businessId,
    subscriptionId: sub.id,
    now: input.now,
    ...(input.source ? { source: input.source } : {}),
    ...(input.planCreditsOnPause ? { planCreditsOnPause: input.planCreditsOnPause } : {}),
  });

  // billing_cycles → auto-resume after N cadence intervals (scheduled resume).
  let resumeScheduledAt: Date | null = null;
  if (pauseOption === "billing_cycles") {
    const n = input.skipBillingCycles ?? 1;
    const unit = (sub.billingPeriodUnit ?? "month") as Interval;
    const count = (sub.billingPeriod ?? 1) * n;
    resumeScheduledAt = advancePeriod(
      requireTerm(sub).end,
      unit,
      count,
      sub.billingAnchorDay,
      await loadBillingMode(organizationId, businessId),
    );
    const { scheduleChange } = await import("./scheduled-changes");
    await scheduleChange({
      organizationId,
      businessId,
      subscriptionId: sub.id,
      type: "resume",
      effectiveAt: resumeScheduledAt,
    });
  } else {
    resumeScheduledAt = await scheduleResume();
  }
  return { subscription: paused, resumeScheduledAt, scheduledChange: null };
}

/**
 * Resume with the full option set (SUB-6). Billing is in advance, so:
 *  - IN-TERM (`now < current_period_end`): the term already invoiced continues
 *    unchanged and nothing new is charged, whatever `chargesHandling` says.
 *  - OUT-OF-TERM (term ended while paused, or none): the term restarts at `now` and is
 *    always billed — `invoice_immediately` raises and collects its invoice,
 *    `add_to_unbilled_charges` parks the full recurring charge. Omitted → the business
 *    default (`pause_config.charges_on_resume`).
 * `unpaid_invoices_handling='schedule_payment_collection'` attempts collection on open
 * invoices in either case.
 */
export async function resumeSubscriptionWithOptions(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  now: Date;
  chargesHandling?: ResumeChargesHandling;
  unpaidInvoicesHandling?: UnpaidInvoicesHandling;
}): Promise<{ subscription: Sub; invoice: string | null }> {
  const { organizationId, businessId } = input;
  const sub = await getSubscriptionByPublicIdInternal(organizationId, input.subscriptionId);
  if (!sub) throw new SubscriptionError("Subscription not found");
  if (sub.status !== "paused")
    throw new SubscriptionError(
      `You can resume only a paused subscription. This subscription is ${sub.status}.`,
    );

  const resumeCfg = resolvePauseConfig(
    (
      await withTenant(organizationId, (tx) =>
        tx
          .select({ pauseConfig: businesses.pauseConfig })
          .from(businesses)
          .where(eq(businesses.id, businessId))
          .limit(1),
      )
    )[0],
  );
  const inTerm =
    sub.currentPeriodStart != null &&
    sub.currentPeriodEnd != null &&
    input.now.getTime() < sub.currentPeriodEnd.getTime();
  const chargesHandling: ResumeChargesHandling | undefined = inTerm
    ? undefined
    : (input.chargesHandling ?? resumeCfg.chargesOnResume);
  const unpaidInvoicesHandling: UnpaidInvoicesHandling | undefined =
    input.unpaidInvoicesHandling ??
    (resumeCfg.unpaidInvoicesOnResume === "no_action"
      ? undefined
      : resumeCfg.unpaidInvoicesOnResume);

  // Out-of-term: the old boundary is stale, restart from now (floored to start-of-day
  // on day-anchored businesses). In-term: keep the paid term.
  const unit = (sub.billingPeriodUnit ?? "month") as Interval;
  const count = sub.billingPeriod ?? 1;
  const resumed = await withTenant(organizationId, async (tx) => {
    // A resume withdraws any later scheduled resume (a pause with an end date). Left in
    // place it would fire inside a LATER pause and end that one early, billing at once.
    // Rows due now are the applier's own and stay as they are.
    await tx
      .update(scheduledChanges)
      .set({ status: "canceled" })
      .where(
        and(
          eq(scheduledChanges.subscriptionId, sub.id),
          eq(scheduledChanges.type, "resume"),
          eq(scheduledChanges.status, "scheduled"),
          gt(scheduledChanges.effectiveAt, input.now),
        ),
      );
    let term: {
      currentPeriodStart: Date;
      currentPeriodEnd: Date;
      billingAnchorDay?: number | null;
    } | null = null;
    let termFields: ReturnType<typeof newTermFields> | null = null;
    if (!inTerm) {
      const mode = await billingModeFor(tx, businessId);
      const termStart = alignTermStart(input.now, mode);
      const anchorDay = await resumeAnchorDay(tx, sub, termStart, unit, mode);
      term = {
        currentPeriodStart: termStart,
        currentPeriodEnd: advancePeriod(termStart, unit, count, anchorDay, mode),
        billingAnchorDay: anchorDay,
      };
      if (anchorDay !== sub.billingAnchorDay)
        await moveSkipsToNewAnchor(tx, sub, term.currentPeriodEnd, anchorDay, mode, input.now);
      // The paused term's commitment is waived; the new term starts fresh.
      termFields = newTermFields(
        { ...sub, billingAnchorDay: anchorDay },
        termStart,
        term.currentPeriodEnd,
        mode,
      );
    }
    const before = await subscriptionSnapshot(tx, sub);
    const [s] = await tx
      .update(subscriptions)
      .set({ status: "active", ...term, ...termFields })
      // Only from paused: of two concurrent resumes, the loser updates nothing and bills nothing.
      .where(and(eq(subscriptions.id, sub.id), eq(subscriptions.status, "paused")))
      .returning();
    if (!s)
      throw new SubscriptionError(
        "You can resume only a paused subscription. This subscription was resumed already.",
      );
    // Plan credit windows of the pause: skipped, or moved on (G3b §6).
    const { onSubscriptionResumed } = await import("@/modules/credits/credit-clock");
    await onSubscriptionResumed(tx, s, input.now, { startedNewTerm: !inTerm });
    // A paused sub stores `mrr = 0`; restate the live rate.
    const netMrr = await recomputeSubscriptionMrr(
      tx,
      sub.id,
      term?.currentPeriodStart ?? input.now,
    );
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "subscription_resumed",
      data: buildEventData(
        "subscription_resumed",
        { id: s!.publicId, status: "active" },
        s!.resourceVersion,
      ),
    });
    // Audited AFTER the MRR recompute so the snapshot carries the committed figure —
    // the row returned by the UPDATE still holds the paused-trial zero.
    await auditSubscription(tx, {
      organizationId,
      businessId,
      action: "subscription.resume",
      before,
      after: { ...s!, mrr: netMrr },
    });
    return { ...s!, mrr: netMrr };
  });

  let invoice: string | null = null;
  if (chargesHandling === "invoice_immediately") {
    const { billSubscriptionPeriod } = await import("@/modules/invoicing/service");
    const { invoice: inv } = await billSubscriptionPeriod({
      organizationId,
      businessId,
      subscription: resumed,
      periodStart: requireTerm(resumed).start,
      periodEnd: requireTerm(resumed).end,
    });
    invoice = inv.publicId;
  } else if (chargesHandling === "add_to_unbilled_charges") {
    // Rate the FULL recurring charge for the fresh period from item snapshots — not
    // the monthly-normalized MRR, which would book 1/12 of a yearly sub (review fix).
    const { addAdHocCharge, recurringChargeMinor } = await import("./items");
    const amount = await recurringChargeMinor(organizationId, resumed.id);
    if (amount > 0n)
      await addAdHocCharge({
        organizationId,
        businessId,
        subscriptionId: resumed.id,
        description: "Resumed period charge",
        amountMinor: Number(amount),
        invoiceNow: false,
        now: input.now,
      });
  }
  if (unpaidInvoicesHandling === "schedule_payment_collection") {
    const { OPEN_INVOICE_STATUSES } = await import("@/modules/invoicing/status");
    const { collectInvoiceNow } = await import("@/modules/invoicing/ops");
    const open = await withTenant(organizationId, (tx) =>
      tx
        .select()
        .from(invoicesTable)
        .where(
          and(
            eq(invoicesTable.subscriptionId, resumed.id),
            inArray(invoicesTable.status, [...OPEN_INVOICE_STATUSES]),
          ),
        ),
    );
    for (const inv of open) {
      try {
        await collectInvoiceNow(organizationId, businessId, inv.publicId);
      } catch (e) {
        log.warn("could not collect an open invoice on resume — left open", {
          invoice: inv.publicId,
          error: (e as Error)?.message,
        });
      }
    }
  }
  return { subscription: resumed, invoice };
}

/**
 * The billing day a resume after the paid term starts on. Normally the resume day, so the
 * term is a full period (the old day made it shorter or longer, billed in full). Kept as is
 * for a customer with a billing day set on purpose (`billing_date_mode: manually_set`),
 * and when the resume lands on the old day as this month allows it (31 → 28 Feb).
 */
async function resumeAnchorDay(
  tx: Tx,
  sub: Sub,
  termStart: Date,
  unit: Interval,
  mode: BillingMode,
): Promise<number | null> {
  if (unit !== "month" && unit !== "year") return null;
  const [cust] = await tx
    .select({ mode: customers.billingDateMode })
    .from(customers)
    .where(eq(customers.id, sub.customerId))
    .limit(1);
  return pickResumeAnchor(
    sub.billingAnchorDay,
    localDatePartsInTz(termStart, mode.timezone),
    cust?.mode === "manually_set",
  );
}

/** Pure part of `resumeAnchorDay`. `month` is 0-based. */
export function pickResumeAnchor(
  old: number | null,
  at: { year: number; month: number; day: number },
  manuallySet: boolean,
): number | null {
  if (manuallySet) return old;
  if (old != null && Math.min(old, daysInMonth(at.year, at.month)) === at.day) return old;
  return at.day;
}

/**
 * A resume moved the billing day: move each pending renewal skip from the Nth upcoming
 * renewal on the old day to the Nth upcoming renewal on the new one, so no skip is lost.
 */
async function moveSkipsToNewAnchor(
  tx: Tx,
  sub: Sub,
  firstNewBoundary: Date,
  newAnchor: number | null,
  mode: BillingMode,
  now: Date,
): Promise<void> {
  const pending = await tx
    .select()
    .from(renewalSkips)
    .where(
      and(
        eq(renewalSkips.subscriptionId, sub.id),
        eq(renewalSkips.status, "scheduled"),
        gt(renewalSkips.renewalAt, now),
      ),
    )
    .orderBy(asc(renewalSkips.renewalAt));
  if (pending.length === 0 || !sub.currentPeriodEnd) return;
  const unit = (sub.billingPeriodUnit ?? "month") as Interval;
  const count = sub.billingPeriod ?? 1;
  const last = pending[pending.length - 1]!.renewalAt.getTime();
  // The old schedule's upcoming renewals, up to the last skip.
  const oldUpcoming: number[] = [];
  for (let at = sub.currentPeriodEnd, i = 0; at.getTime() <= last && i < 400; i++) {
    if (at > now) oldUpcoming.push(at.getTime());
    at = advancePeriod(at, unit, count, sub.billingAnchorDay, mode);
  }
  const newUpcoming = (n: number) => {
    let at = firstNewBoundary;
    for (let i = 0; i < n; i++) at = advancePeriod(at, unit, count, newAnchor, mode);
    return at;
  };
  const targets = pending.map((skip, i) => {
    const n = oldUpcoming.indexOf(skip.renewalAt.getTime());
    return { id: skip.id, at: newUpcoming(n >= 0 ? n : i) };
  });
  // Two steps, so a target that equals another skip's old date cannot trip the unique index.
  for (const t of targets)
    await tx
      .update(renewalSkips)
      .set({ renewalAt: sql`${renewalSkips.renewalAt} + interval '400 years'` })
      .where(eq(renewalSkips.id, t.id));
  for (const t of targets)
    await tx.update(renewalSkips).set({ renewalAt: t.at }).where(eq(renewalSkips.id, t.id));
}

/**
 * `resume_option=specific_date`: schedule the resume of a paused subscription. The options
 * ride on the scheduled change and apply when it lands, exactly as an immediate resume
 * would apply them. Replaces any resume already pending (e.g. a `billing_cycles` pause's).
 */
export async function scheduleResumeSubscription(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  now: Date;
  resumeDate: Date;
  chargesHandling?: ResumeChargesHandling;
  unpaidInvoicesHandling?: UnpaidInvoicesHandling;
}): Promise<{ subscription: Sub; scheduledChange: string }> {
  const sub = await getSubscriptionByPublicIdInternal(input.organizationId, input.subscriptionId);
  if (!sub) throw new SubscriptionError("Subscription not found");
  if (sub.status !== "paused")
    throw new SubscriptionError(
      `You can resume only a paused subscription. This subscription is ${sub.status}.`,
    );
  if (input.resumeDate.getTime() <= input.now.getTime())
    throw new SubscriptionError(
      "resume_date must be in the future. To resume now, use resume_option=immediately.",
    );
  if (sub.cancelScheduledAt && input.resumeDate.getTime() >= sub.cancelScheduledAt.getTime())
    throw new SubscriptionError("resume_date must be before the scheduled cancellation");
  const { scheduleChange } = await import("./scheduled-changes");
  const row = await scheduleChange({
    organizationId: input.organizationId,
    businessId: input.businessId,
    subscriptionId: sub.id,
    type: "resume",
    effectiveAt: input.resumeDate,
    ...(input.chargesHandling || input.unpaidInvoicesHandling
      ? {
          resumeOptions: {
            ...(input.chargesHandling ? { chargesHandling: input.chargesHandling } : {}),
            ...(input.unpaidInvoicesHandling
              ? { unpaidInvoicesHandling: input.unpaidInvoicesHandling }
              : {}),
          },
        }
      : {}),
  });
  return { subscription: sub, scheduledChange: row.publicId };
}

/**
 * change_term_end (SUB-9): move the current term's end boundary. `prorate` issues
 * a proration credit/charge for the delta via the change engine; `invoice_
 * immediately` collects it now. Only active/non_renewing subs.
 */
export async function changeTermEnd(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  termEndsAt: Date;
  prorate?: boolean;
  invoiceImmediately?: boolean;
  now: Date;
  /** Post-H (#5): per-operation idempotency token (from the request Idempotency-Key). */
  originToken?: string | null;
}): Promise<{ subscription: Sub; prorationInvoice: string | null }> {
  const { organizationId, businessId } = input;
  const sub = await getSubscriptionByPublicIdInternal(organizationId, input.subscriptionId);
  if (!sub) throw new SubscriptionError("Subscription not found");
  if (sub.status !== "active")
    throw new SubscriptionError(
      `You can change the term end only on an active subscription. This subscription is ${sub.status}.`,
    );
  // The API reports a day-anchored term end INCLUSIVELY, so a read-modify-write hands
  // back …T23:59:59. Normalize to the stored exclusive boundary FIRST, so the
  // validations and the idempotent-no-op check below all compare the same convention —
  // otherwise re-submitting an unchanged term end looked like a real change and
  // re-prorated it. See normalizeTermEnd.
  const mode = await loadBillingMode(organizationId, businessId);
  const termEndsAt = normalizeTermEnd(input.termEndsAt, mode);
  input = { ...input, termEndsAt };
  if (input.termEndsAt <= requireTerm(sub).start)
    throw new SubscriptionError("term_ends_at must be after the current period start");
  // A term end in the past would credit time the customer has already consumed
  // (30-day term, day 21, set end to day 11 → 6666 minor over-credit) and make
  // the clock renew immediately, so the boundary must be in the future.
  if (input.termEndsAt <= input.now)
    throw new SubscriptionError("term_ends_at must be in the future");

  // Idempotent retry (G backlog): if the boundary is ALREADY at the target, a prior
  // call succeeded — do NOT re-prorate (that re-ran the full delta on retry). No-op.
  if (requireTerm(sub).end.getTime() === input.termEndsAt.getTime()) {
    return { subscription: sub, prorationInvoice: null };
  }

  // Settle the money BEFORE moving the boundary (review blocker: they were separate
  // txs in the reverse order, so a crash left the term moved with no charge/credit —
  // a free extension). If proration throws, the boundary is never moved, so the
  // customer can't get extended time for free; the proration invoice/CN is the
  // durable record of the money.
  // H1 (SET-1): default prorate / invoice_immediately from the business when omitted.
  const [bizDef] = await withTenant(organizationId, (tx) =>
    tx
      .select({
        prorate: businesses.defaultProrateOnChange,
        invoiceImmediately: businesses.defaultInvoiceImmediately,
      })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1),
  );
  // Post-H (#8): defaults reverted to false — an omitted prorate/invoice_immediately
  // no longer silently generates + collects a proration invoice.
  const prorate = input.prorate ?? bizDef?.prorate ?? false;
  const invoiceImmediately = input.invoiceImmediately ?? bizDef?.invoiceImmediately ?? false;
  // A prorated term change moves money across two transactions; without a client
  // Idempotency-Key a crash-retry cannot be distinguished from a fresh operation
  // and would double-charge (finale review). Require the key up front.
  if (prorate && !input.originToken) {
    throw new SubscriptionError("A prorated term change requires an Idempotency-Key header");
  }
  let prorationInvoice: string | null = null;
  if (prorate) {
    // Prorate the recurring charge over the extended/shortened term vs. what was
    // billed for the original term. Uses the proration helper with a term-length
    // delta line so the ledger stays exact.
    const { prorateTermChange } = await import("./proration");
    const inv = await prorateTermChange({
      organizationId,
      businessId,
      subscription: sub,
      oldPeriodEnd: requireTerm(sub).end,
      newPeriodEnd: input.termEndsAt,
      invoiceImmediately,
      now: input.now,
      originToken: input.originToken ?? null,
    });
    prorationInvoice = inv?.publicId ?? null;
  }
  const updated = await withTenant(organizationId, async (tx) => {
    const before = await subscriptionSnapshot(tx, sub);
    // The sub-period may not pass the new term end.
    const subPeriodEnd =
      sub.currentSubPeriodEnd && sub.currentSubPeriodStart && sub.currentPeriodStart
        ? nextSubPeriodEnd(
            sub.currentPeriodStart,
            input.termEndsAt,
            sub.currentSubPeriodStart,
            sub.billingAnchorDay,
            await billingModeFor(tx, businessId),
          )
        : null;
    const [s] = await tx
      .update(subscriptions)
      .set({
        currentPeriodEnd: input.termEndsAt,
        ...(subPeriodEnd ? { currentSubPeriodEnd: subPeriodEnd } : {}),
      })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    // Reported, not stored — the same boundary the read reports (`inclusiveBoundary`).
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "subscription_changed",
      data: buildEventData(
        "subscription_changed",
        {
          id: s!.publicId,
          current_period_end: inclusiveBoundary(input.termEndsAt, mode),
          term_changed: true,
        },
        s!.resourceVersion,
      ),
    });
    await auditSubscription(tx, {
      organizationId,
      businessId,
      action: "subscription.change_term_end",
      before,
      after: s!,
    });
    return s!;
  });
  return { subscription: updated, prorationInvoice };
}

/**
 * Edit the trial end date of an in-trial subscription.
 *  - A future date extends/shortens the trial: `trial_end` moves, and since a
 *    trialing sub's current period IS the trial window, `current_period_end`
 *    moves with it (mirrors the "First period end: trial end if trialing"
 *    rule at create time). The billing clock scans `current_period_end`
 *    directly (no separate per-subscription job to reschedule — moving the
 *    column IS the reschedule, same as `changeTermEnd`).
 *  - `immediately: true` ends the trial now: the trial/period boundary is
 *    moved to `now`, then the existing trial-end renewal path
 *    (`renewSubscription`) is invoked synchronously — it activates the
 *    subscription and raises + collects the first term's invoice exactly as
 *    it would at natural trial end (same `remaining_billing_cycles` decrement,
 *    same events), rather than reimplementing that billing here.
 *
 * Both boundaries go through the business's billing mode first — a day-anchored
 * business's terms live on local midnights, and this op writes the instant the next
 * term starts from.
 */
export async function editTrialEnd(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  now: Date;
  trialEnd?: Date;
  immediately?: boolean;
}): Promise<{ subscription: Sub }> {
  const { organizationId, businessId } = input;
  const sub = await getSubscriptionByPublicIdInternal(organizationId, input.subscriptionId);
  if (!sub) throw new SubscriptionError("Subscription not found");
  if (sub.status !== "in_trial")
    throw new SubscriptionError(
      `You can change the trial end only on an in-trial subscription. This subscription is ${sub.status}.`,
    );

  // This op writes a TERM BOUNDARY (the trial end is the next term's start), so it owes
  // the same billing-mode alignment create/resume/cancel already do: on a day-anchored
  // business every boundary is a local midnight. Skipping it is not cosmetic — the sub's
  // `billing_anchor_day` was derived from the ALIGNED start (day 3 for a term starting
  // 04-Aug 00:00 IST = 03-Aug 18:30Z), so `advancePeriod` re-anchors an UNALIGNED start
  // onto that day and the renewal lands a day early. Found 2026-08-04: a trial ended at
  // 22:26 IST reported "next billing 03-Sept 22:26" instead of 04-Sept 00:00.
  const mode = await loadBillingMode(organizationId, businessId);

  if (input.immediately) {
    // Floors to the START of the local day the trial is ended in — NOT the next
    // midnight: the operator asked to activate and bill now, so `now` has to fall
    // INSIDE the term this opens. Whole-day granularity then makes today the first
    // BILLED day; the trial keeps every whole day it completed. Clamped to the trial
    // start so a subscription imported with an unaligned mid-day trial start cannot
    // end its trial before it began.
    const boundary = new Date(
      Math.max(
        alignTermStart(input.now, mode).getTime(),
        // A trialling subscription has no term, so `trialStart` is the only window it has;
        // `startDate` backs both up for a row written before either was stamped.
        (sub.trialStart ?? sub.currentPeriodStart ?? sub.startDate ?? new Date(0)).getTime(),
      ),
    );
    // REFUSE before writing anything if the conversion could not be collected: this is
    // an operator asking for an activation, and converting a cardless auto-collecting
    // subscription would cancel it (`no_card`) instead.
    // The natural trial end still converts-then-cancels; the clock has nobody to tell.
    const { isTrialConversionUncollectable } = await import("./renewal");
    if (await isTrialConversionUncollectable(organizationId, sub.id, boundary)) {
      throw new SubscriptionError(
        "We cannot end the trial. This subscription auto-collects, and the customer has no payment method on file. " +
          "Add a payment method, or disable auto-collection to send the first invoice instead.",
      );
    }
    // Move the trial/period boundary there, then reuse the exact renewal
    // path a natural trial-end clock tick would take (activation + billing).
    await withTenant(organizationId, async (tx) => {
      const before = await subscriptionSnapshot(tx, sub);
      const [s] = await tx
        .update(subscriptions)
        // trialEnd ONLY. Mirroring the boundary onto `currentPeriodEnd` is the conflation
        // removed on 2026-08-25 — a trialling subscription has no term, and the renewal
        // below stamps the first real one when it activates. The due scan now selects a
        // trialling subscription by `trial_end`, so the move alone is what the clock needs.
        .set({ trialEnd: boundary })
        .where(eq(subscriptions.id, sub.id))
        .returning();
      // The boundary move is audited on its own, separately from the activation the
      // renewal below performs: they are two changes, and only this one was chosen by
      // an operator. They share the ambient trace, so the Activity Log presents both
      // as one record, which is the right presentation for "end trial now".
      if (s) {
        await auditSubscription(tx, {
          organizationId,
          businessId,
          action: "subscription.end_trial",
          before,
          after: s,
        });
      }
    });
    const { renewSubscription } = await import("./renewal");
    await renewSubscription(organizationId, sub.id, input.now, { endTrialNow: true });
    const updated = await getSubscriptionByPublicIdInternal(organizationId, input.subscriptionId);
    if (!updated) throw new SubscriptionError("Subscription not found after ending trial");
    return { subscription: updated };
  }

  if (!input.trialEnd)
    throw new SubscriptionError("trial_end is required unless immediately is set");
  // A past trial end would retroactively shorten a period already partly
  // consumed and make the clock renew immediately — same rationale as
  // change_term_end's future-boundary requirement.
  if (input.trialEnd <= input.now) throw new SubscriptionError("trial_end must be in the future");
  // The operator NAMED a day, so this is `alignTrialEnd`'s case, not
  // `inclusiveBoundary`'s: the trial ends at the end of the calendar day they picked
  // rather than the previous one, and a client that echoes back the `…T23:59:59` we
  // serve lands on the same instant. (`createSubscription` computes a boundary instead
  // and therefore uses `inclusiveBoundary` — see the note there; the two are a day
  // apart and were conflated until 2026-08-23.) Applied AFTER the future check, which
  // is about the operator's raw input.
  const trialEnd = alignTrialEnd(input.trialEnd, mode);

  const updated = await withTenant(organizationId, async (tx) => {
    const before = await subscriptionSnapshot(tx, sub);
    // Read the OLD boundary in-transaction, so "extended" is decided against the value
    // this update is actually replacing rather than a stale read from before the lock.
    const [prev] = await tx
      .select({ trialEnd: subscriptions.trialEnd })
      .from(subscriptions)
      .where(eq(subscriptions.id, sub.id))
      .limit(1);
    const extended = !!prev?.trialEnd && trialEnd > prev.trialEnd;
    const [s] = await tx
      .update(subscriptions)
      .set({ trialEnd }) // no term while trialling — see the note on the branch above
      .where(eq(subscriptions.id, sub.id))
      .returning();
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "subscription_changed",
      // `trial_end_extended` rides on the ENVELOPE (the 4th arg), not inside the
      // subscription resource, and that placement is load-bearing: `buildEventContent`
      // does `enriched.subscription = snapshot`, REPLACING the thin resource payload
      // whenever the snapshot loads. A flag put inside it disappears — which is exactly
      // how every enriched dunning cancellation once fell through to the wrong email
      // branch (see `cancelReasonOf` in emails/outbox.ts). Top-level keys survive,
      // which is why the pre-debit notice reads `raw.debit_at` the same way.
      //
      // Shortening a trial is not a thing to congratulate a customer about, so the
      // email only fires on a genuine extension; the flag is emitted either way because
      // a webhook consumer wants to know which happened.
      data: buildEventData(
        "subscription_changed",
        { id: s!.publicId, trial_end: trialEnd, current_period_end: null, trial_end_changed: true },
        s!.resourceVersion,
        { trial_end_extended: extended },
      ),
    });
    await auditSubscription(tx, {
      organizationId,
      businessId,
      action: "subscription.change_trial_end",
      before,
      after: s!,
    });
    return s!;
  });
  return { subscription: updated };
}

// ── SUB-3: dues snapshot (computed on GET, not stored) ─────────────────────────

export interface DuesSnapshot {
  due_invoices_count: number;
  total_dues_minor: number;
  due_since: Date | null;
}

/** Compute a subscription's outstanding dues from its open invoices (SUB-3). */
export async function subscriptionDues(
  organizationId: string,
  subscriptionId: string,
): Promise<DuesSnapshot> {
  const { OPEN_INVOICE_STATUSES } = await import("@/modules/invoicing/status");
  const { paidTotals } = await import("@/modules/invoicing/service");
  return withTenant(organizationId, async (tx) => {
    const open = await tx
      .select({
        id: invoicesTable.id,
        due: invoicesTable.amountDueMinor,
        total: invoicesTable.totalMinor,
        dueDate: invoicesTable.dueDate,
        createdAt: invoicesTable.createdAt,
      })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.subscriptionId, subscriptionId),
          inArray(invoicesTable.status, [...OPEN_INVOICE_STATUSES]),
        ),
      );
    // `amount_due_minor` is net of credits only; cash payments are subtracted here, as
    // `invoiceOutstanding` does, or a part-paid invoice shows its whole balance.
    const paid = await paidTotals(
      tx,
      open.map((r) => r.id),
    );
    let total = 0n;
    let since: Date | null = null;
    for (const r of open) {
      const left = (r.due ?? r.total) - (paid.get(r.id) ?? 0n);
      if (left > 0n) total += left;
      const when = r.dueDate ?? r.createdAt;
      if (when && (!since || when < since)) since = when;
    }
    return { due_invoices_count: open.length, total_dues_minor: Number(total), due_since: since };
  });
}
