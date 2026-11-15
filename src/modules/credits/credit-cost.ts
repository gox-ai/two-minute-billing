/**
 * Usage paid in credits of a unit with no money rate: the pure rules. What an event costs,
 * which cost layer applies, how a late event is paid, and how a settlement spreads units over
 * grants. No I/O.
 */
import type { BusinessCreditConfig, CreditApplicability } from "@db/schema";
import { compareGrants, type PlannerGrant } from "./planner";
import { divHalfUp, E12 } from "./units";

const E6 = 1_000_000n;

/** `credits_per_unit` is numeric(20, 6). "0.5" → 500000n. Null when it is not a plain decimal. */
export function parseCostE6(text: string): bigint | null {
  const m = /^(\d{1,14})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) return null;
  return BigInt(m[1]!) * E6 + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}

export function formatCostE6(e6: bigint): string {
  const whole = e6 / E6;
  const frac = (e6 % E6).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * Credits one event costs, in the unit's smallest step:
 * round_half_up(quantity × credits per unit × 10^decimals). Quantity is fixed-12.
 */
export function unitsDueSteps(quantityE12: bigint, costE6: bigint, decimals: number): bigint {
  if (quantityE12 <= 0n || costE6 <= 0n) return 0n;
  return divHalfUp(quantityE12 * costE6 * 10n ** BigInt(decimals), E12 * E6);
}

export type CostSource = "meter" | "plan" | "subscription";

export interface CostLayers {
  /** The meter's own cost. */
  base: bigint;
  /** Plan (product id) → cost. */
  byProduct: ReadonlyMap<string, bigint>;
  /** Subscription id → cost. */
  bySubscription: ReadonlyMap<string, bigint>;
}

/**
 * The cost that applies to a customer: a subscription's own row, then a plan's, then the
 * meter's. `subscriptions` are the customer's live ones, oldest first; the first that has a
 * row at a layer wins it.
 */
export function resolveCreditCost(
  layers: CostLayers,
  subscriptions: ReadonlyArray<{ id: string; productIds: readonly string[] }>,
): { costE6: bigint; source: CostSource } {
  for (const s of subscriptions) {
    const c = layers.bySubscription.get(s.id);
    if (c !== undefined) return { costE6: c, source: "subscription" };
  }
  for (const s of subscriptions)
    for (const p of s.productIds) {
      const c = layers.byProduct.get(p);
      if (c !== undefined) return { costE6: c, source: "plan" };
    }
  return { costE6: layers.base, source: "meter" };
}

export const DEFAULT_LATE_EVENT_GRACE_HOURS = 12;
export const MAX_LATE_EVENT_GRACE_HOURS = 24 * 35;

/** The grace window of a business, in ms. Unset = 12 hours. */
export function lateEventGraceMs(config: BusinessCreditConfig | null | undefined): number {
  const h = config?.late_event_grace_hours;
  const hours =
    typeof h === "number" && Number.isFinite(h) && h >= 0 ? h : DEFAULT_LATE_EVENT_GRACE_HOURS;
  return Math.round(hours * 3_600_000);
}

/**
 * How an event is paid. `event_time`: it arrived inside the grace window, so a grant that was
 * live at its timestamp pays first, even if it closed since. `receipt_time`: the balance at
 * receipt pays (an event on time, one later than the window, or no window).
 */
export function payClass(input: {
  eventAt: Date;
  receivedAt: Date;
  graceMs: number;
}): "event_time" | "receipt_time" {
  const late = input.receivedAt.getTime() - input.eventAt.getTime();
  return late > 0 && input.graceMs > 0 && late <= input.graceMs ? "event_time" : "receipt_time";
}

/** A closed grant's grace row covers an event dated inside the grant's life, until it locks. */
export function graceCovers(
  g: { validFrom: Date; validUntil: Date; locksAt: Date; lockedAt: Date | null },
  eventAt: Date,
  receivedAt: Date,
): boolean {
  return (
    g.lockedAt === null &&
    receivedAt.getTime() < g.locksAt.getTime() &&
    g.validFrom.getTime() <= eventAt.getTime() &&
    eventAt.getTime() < g.validUntil.getTime()
  );
}

export interface UnitGrantState {
  amount: bigint;
  costBasisMinor: bigint;
  remainingUnits: bigint;
  remainingCost: bigint;
}

/**
 * Cost of a draw of `units`. Cumulative, so a grant closes to 0 units and 0 cost:
 * cost drawn so far = round_half_up(cost basis × units drawn so far ÷ amount).
 */
export function unitDrawCost(g: UnitGrantState, units: bigint): bigint {
  if (units <= 0n) return 0n;
  if (units >= g.remainingUnits) return g.remainingCost;
  if (g.costBasisMinor <= 0n || g.amount <= 0n) return 0n;
  const drawnBefore = g.costBasisMinor - g.remainingCost;
  const unitsAfter = g.amount - (g.remainingUnits - units);
  let cost = divHalfUp(g.costBasisMinor * (unitsAfter > 0n ? unitsAfter : 0n), g.amount);
  cost -= drawnBefore;
  if (cost < 0n) cost = 0n;
  return cost > g.remainingCost ? g.remainingCost : cost;
}

export interface UnitGrant extends UnitGrantState {
  id: string;
  category: "paid" | "promotional";
  source: string;
  priority: number;
  effectiveAt: Date;
  expiresAt: Date | null;
  /**
   * Set when the grant pays past `expiresAt`: a term plan grant that waits for its renewal
   * (null = until it is closed). `expiresAt` still orders the drawdown.
   */
  paysUntil?: Date | null;
  applicability: CreditApplicability;
}

export interface UnitDemand {
  meterId: string;
  meterKey: string;
  /** The instant the grants are matched at. */
  payAt: Date;
  units: bigint;
}

export interface UnitDraw {
  meterId: string;
  grantId: string;
  units: bigint;
  costMinor: bigint;
}

const liveAt = (g: Pick<UnitGrant, "effectiveAt" | "expiresAt" | "paysUntil">, at: Date) => {
  const end = g.paysUntil === undefined ? g.expiresAt : g.paysUntil;
  return g.effectiveAt.getTime() <= at.getTime() && (end === null || end.getTime() > at.getTime());
};

/** A grant scoped to prices pays no meter with a credit cost: such a meter has no price. */
const coversMeter = (g: Pick<UnitGrant, "applicability">, meterKey: string) => {
  const a = g.applicability;
  return !a || a.kind === "metered" || (a.kind === "meters" && a.meters.includes(meterKey));
};

const order = (a: UnitGrant, b: UnitGrant) =>
  compareGrants(a as unknown as PlannerGrant, b as unknown as PlannerGrant);

/**
 * Spread what was taken at ingest over the grants, in the drawdown order (restore grants,
 * priority, soonest expiry, given before paid, oldest, id). A grant pays a demand when it is
 * live at `payAt` and covers the meter. The gate took the units from one number per unit, so
 * a demand may be left with no such grant; any grant that has units then pays it
 * (`fallbackUnits`; `windowFallbackUnits` is the part paid by a grant that was not live, which
 * the gate rules out). `shortUnits` > 0 means the balance row and the grants disagree.
 */
export function allocateUnitDraws(
  grants: readonly UnitGrant[],
  demands: readonly UnitDemand[],
): { draws: UnitDraw[]; fallbackUnits: bigint; windowFallbackUnits: bigint; shortUnits: bigint } {
  const state = [...grants].sort(order).map((g) => ({ ...g }));
  const draws = new Map<string, UnitDraw>();
  let fallbackUnits = 0n;
  let windowFallbackUnits = 0n;
  let shortUnits = 0n;
  const take = (g: (typeof state)[number], d: UnitDemand, want: bigint): bigint => {
    const units = want < g.remainingUnits ? want : g.remainingUnits;
    if (units <= 0n) return 0n;
    const costMinor = unitDrawCost(g, units);
    g.remainingUnits -= units;
    g.remainingCost -= costMinor;
    const key = `${d.meterId}|${g.id}`;
    const acc = draws.get(key) ?? { meterId: d.meterId, grantId: g.id, units: 0n, costMinor: 0n };
    acc.units += units;
    acc.costMinor += costMinor;
    draws.set(key, acc);
    return units;
  };
  const sorted = [...demands].sort((a, b) => a.payAt.getTime() - b.payAt.getTime());
  for (const d of sorted) {
    let left = d.units;
    for (const g of state) {
      if (left <= 0n) break;
      if (liveAt(g, d.payAt) && coversMeter(g, d.meterKey)) left -= take(g, d, left);
    }
    for (const g of state) {
      if (left <= 0n) break;
      const got = take(g, d, left);
      left -= got;
      fallbackUnits += got;
      if (!liveAt(g, d.payAt)) windowFallbackUnits += got;
    }
    shortUnits += left;
  }
  return { draws: [...draws.values()], fallbackUnits, windowFallbackUnits, shortUnits };
}

/**
 * A count of credits as sent ("1", "0.5") in the unit's smallest step. Null when it is not a
 * plain decimal, or has more decimals than the unit.
 */
export function parseUnitSteps(text: string, decimals: number): bigint | null {
  const m = /^(\d{1,15})(?:\.(\d{1,12}))?$/.exec(text.trim());
  if (!m) return null;
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > decimals) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/**
 * What an event that settles a hold takes: its units, up to what the row offers once the
 * hold's units are back. The rest is recorded and not taken.
 */
export function coveredTake(due: bigint, offered: bigint): { units: bigint; uncovered: bigint } {
  const room = offered > 0n ? offered : 0n;
  const units = due < room ? due : room;
  return { units, uncovered: due - units };
}

/**
 * The estimate of an access check with none sent: one event of a `count` meter, else one
 * step of the unit ("has the customer any credit").
 */
export function defaultEstimateSteps(aggregation: string, costE6: bigint, decimals: number) {
  if (aggregation !== "count") return 1n;
  const one = unitsDueSteps(E12, costE6, decimals);
  return one > 0n ? one : 1n;
}

/**
 * What happens to the units of one event (0530). Each unit is in exactly one state:
 * `covered` (credits pay it), `billed` (money pays it, at the overage price) or `overdraft`
 * (an overshoot below zero that no one has billed; the next grant repays it first).
 */
export interface UnitSplit {
  covered: bigint;
  billed: bigint;
  overdraft: bigint;
  refused: boolean;
}

/**
 * Split an event's units. `offered`: what the balance row offers; negative when the balance
 * is already below zero. Credits pay first. Under `bill` with a money price the rest is
 * billed. Else the rest may take the balance down to `floor` units below zero, and an event
 * that would pass the floor is refused whole. An event that settles a hold is never refused:
 * what it cannot bill is an overshoot, past the floor too.
 */
export function splitEventUnits(input: {
  due: bigint;
  offered: bigint;
  policy: "block" | "bill";
  priced: boolean;
  floor: bigint;
  coveredByHold?: boolean;
}): UnitSplit {
  const have = input.offered > 0n ? input.offered : 0n;
  if (input.due <= have) return { covered: input.due, billed: 0n, overdraft: 0n, refused: false };
  const rest = input.due - have;
  if (input.priced && input.policy === "bill")
    return { covered: have, billed: rest, overdraft: 0n, refused: false };
  const floor = input.floor > 0n ? input.floor : 0n;
  if (input.due <= input.offered + floor || input.coveredByHold)
    return { covered: have, billed: 0n, overdraft: rest, refused: false };
  return { covered: 0n, billed: 0n, overdraft: 0n, refused: true };
}

/**
 * How much of the overshoot parts the grants can repay, oldest first: each part whole while
 * the capacity lasts, then one part in part. An overshoot is repaid before anything else is
 * left on a grant.
 */
export function repayOvershoot(
  parts: ReadonlyArray<{ id: string; units: bigint }>,
  capacity: bigint,
): Array<{ id: string; units: bigint; whole: boolean }> {
  const out: Array<{ id: string; units: bigint; whole: boolean }> = [];
  let left = capacity > 0n ? capacity : 0n;
  for (const p of parts) {
    if (left <= 0n) break;
    const units = p.units < left ? p.units : left;
    if (units <= 0n) continue;
    out.push({ id: p.id, units, whole: units === p.units });
    left -= units;
  }
  return out;
}

/**
 * Cost to give back with `units` of one draw: in proportion to the draw, and the exact rest
 * with its last units, so a draw given back whole returns exactly what it took.
 */
export function drawRestoreCost(
  draw: { units: bigint; costMinor: bigint },
  returned: { units: bigint; costMinor: bigint },
  units: bigint,
): bigint {
  const unitsLeft = draw.units - returned.units;
  const costLeft = draw.costMinor - returned.costMinor;
  if (units <= 0n || unitsLeft <= 0n || costLeft <= 0n) return 0n;
  if (units >= unitsLeft) return costLeft;
  const cost = divHalfUp(draw.costMinor * units, draw.units);
  return cost > costLeft ? costLeft : cost;
}

/** "0.25" (major units per whole credit) → fixed-12 minor units per credit. Null when not > 0. */
export function parseMoneyPerCreditE12(text: string, currencyExponent: number): bigint | null {
  const m = /^(\d{1,12})(?:\.(\d{1,12}))?$/.exec(text.trim());
  if (!m) return null;
  const v =
    (BigInt(m[1]!) * E12 + BigInt((m[2] ?? "").padEnd(12, "0"))) * 10n ** BigInt(currencyExponent);
  return v > 0n ? v : null;
}

/**
 * The cost basis of a plan grant with a per-unit basis (0530): `steps` of a unit with
 * `decimals` at `minorPerCreditE12`, rounded half up to the minor unit. Used as a pack's cost:
 * the cumulative rule (`unitDrawCost`) recognises it as the credits are used.
 */
export function planGrantCostMinor(
  steps: bigint,
  minorPerCreditE12: bigint,
  decimals: number,
): bigint {
  if (steps <= 0n || minorPerCreditE12 <= 0n) return 0n;
  return divHalfUp(steps * minorPerCreditE12, E12 * 10n ** BigInt(decimals));
}
