/**
 * The gate at ingest for a meter with a credit cost (0526). In the transaction that stores an
 * event, its credits are taken from `credit_unit_balances` under the row's lock, so the balance
 * of a customer under `block` never goes below 0. Settlement draws the taken units from the
 * grants later (`usage-settlement.ts`). Loaded by ingest only when such a meter counts an event.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { DECIMAL_TEXT_RE, pgTextArray, rowsOf } from "@/modules/metering/usage-sql";
import { propertyText } from "@/modules/metering/json-source";
import { formatFixed12, tryParseFixed12 } from "@/platform/fixed";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import {
  creditGrantGrace,
  creditGrants,
  creditUnitBalances,
  creditUsageEvents,
  meterCreditCosts,
  type CreditUsageReason,
  type CreditUsageStatus,
} from "@db/schema";
import {
  formatCostE6,
  graceCovers,
  lateEventGraceMs,
  parseCostE6,
  payClass,
  resolveCreditCost,
  splitEventUnits,
  unitsDueSteps,
  type CostLayers,
  type CostSource,
} from "./credit-cost";
import { lockCustomerBalances } from "@/modules/customers/balances-read";
import { livePlanCredits, loadCreditContext } from "./holds";
import { overagePriceFor, type OveragePrice } from "./overage-price";
import { resolveOverdraftLimit } from "./overdraft";
import { unitPoliciesFor } from "./unit-policies";
import {
  effectivePolicy,
  resolveCreditEngineRules,
  type CreditEngineRules,
  type EffectivePolicy,
} from "./policy";
import { formatSteps } from "./units";
import { LIVE_SUBSCRIPTION_STATUSES } from "./usage";
import { bringUnitBalanceToNow, unitBalanceDue } from "./usage-settlement";

const log = createLogger("credits.usage-gate");
const DECIMAL = new RegExp(DECIMAL_TEXT_RE);

/**
 * SQL: what a balance row offers. Open holds keep their units, except the part that closed
 * grants back from their grace rows (`pinned_steps`).
 */
export const OFFERED =
  sql<bigint>`greatest(${creditUnitBalances.availableSteps} - greatest(${creditUnitBalances.heldSteps} - ${creditUnitBalances.pinnedSteps}, 0), 0)`.mapWith(
    BigInt,
  );

/** An active meter with a credit cost, as ingest loads it with its other meters. */
export interface GateMeter {
  id: string;
  key: string;
  eventName: string;
  aggregation: string;
  valueProperty: string | null;
  filters: Record<string, Array<string | number | boolean>> | null;
  credit: { unitId: string; unitKey: string; decimals: number; cost: string; overrides: boolean };
}

export interface GateEvent {
  eventId: string;
  key: string;
  customerId: string | null;
  eventName: string;
  properties: Record<string, unknown>;
  /** As sent, so Postgres keeps every microsecond. */
  timestamp: string;
  at: Date;
  backfill: boolean;
}

/**
 * SQL: `OFFERED` before the floor at 0. Negative when the balance is below zero (an overshoot
 * that no one has billed, 0530).
 */
export const OFFERED_RAW =
  sql<bigint>`(${creditUnitBalances.availableSteps} - greatest(${creditUnitBalances.heldSteps} - ${creditUnitBalances.pinnedSteps}, 0))`.mapWith(
    BigInt,
  );

/**
 * What applies when an event needs more than the balance has (0530): the policy, the money
 * price of the rest, and the floor below zero. Read only then.
 */
export interface ShortTerms {
  policy: EffectivePolicy;
  /** No live subscription: nothing to carry a money line but a one-off invoice. */
  packOnly: boolean;
  /** Null: the rest is never billed in money at the gate. */
  price: OveragePrice | null;
  /** Units below zero the balance may reach, in the unit's smallest step. */
  floor: bigint;
}

/**
 * The floor that applies now. An overshoot that no subscription will carry (no subscription,
 * or a free trial) is paid on a one-off invoice at the unit's overage price, so the floor is 0
 * while the unit has no such price. With no subscription, `no_subscription_overdraft` decides
 * the rest: by default also 0 while the customer has no saved payment method, or while such an
 * invoice is open or was written off (uncollectible keeps the block).
 */
async function overdraftFloor(
  tx: Tx,
  input: {
    customerId: string;
    unitId: string;
    packOnly: boolean;
    trial: boolean;
    rules: CreditEngineRules;
  },
): Promise<bigint> {
  if (input.packOnly && input.rules.noSubscriptionOverdraft === "never") return 0n;
  const limit = (await resolveOverdraftLimit(tx, input)).steps;
  if (limit <= 0n || (!input.packOnly && !input.trial)) return limit;
  if ((await unitPoliciesFor(tx, [input.unitId])).get(input.unitId)?.overageMinorPerUnitE12 == null)
    return 0n;
  if (!input.packOnly || input.rules.noSubscriptionOverdraft === "always") return limit;
  const [ok] = rowsOf<{ x: number }>(
    await tx.execute(sql`
      select 1 as x where exists (
        select 1 from payment_methods pm
        where pm.customer_id = ${input.customerId} and pm.status in ('valid', 'expiring'))
      and not exists (
        select 1 from credit_usage_events c join invoices i on i.id = c.overage_invoice_id
        where c.customer_id = ${input.customerId} and c.unit_id = ${input.unitId}
          and c.source = 'overdraft' and c.status = 'billed'
          and (i.status in ('posted', 'payment_due', 'not_paid')
            or (i.status = 'paid' and i.written_off)))`),
  );
  return ok ? limit : 0n;
}

export async function shortTerms(
  tx: Tx,
  input: { businessId: string; customerId: string; unitId: string; meterId: string; now: Date },
): Promise<ShortTerms> {
  const { policy, sub, rules } = await resolveUnitPolicy(tx, input);
  const packOnly = !sub;
  const trial = sub?.status === "in_trial";
  // `trial_usage`: refuse = no price, no floor; overdraft_only = the floor only; as_paid = both.
  const priced = trial
    ? rules.trialUsage === "as_paid"
    : !packOnly || rules.noSubscriptionUsage === "as_subscriber";
  const price = priced ? await overagePriceFor(tx, input) : null;
  const floor =
    trial && rules.trialUsage === "refuse"
      ? 0n
      : await overdraftFloor(tx, { ...input, packOnly, trial, rules });
  return { policy, packOnly, price, floor };
}

export interface GateRefusal {
  code: "insufficient_credit";
  message: string;
}

/** In-app text (ASD-STE100). The route answers 402 with it. */
export const INSUFFICIENT_CREDIT_MESSAGE =
  "We could not take credits for the event. The customer does not have sufficient credit. The event is stored and is not billed.";

const refusal = (): GateRefusal => ({
  code: "insufficient_credit",
  message: INSUFFICIENT_CREDIT_MESSAGE,
});

const passesFilters = (m: GateMeter, props: Record<string, unknown>) =>
  Object.entries(m.filters ?? {}).every(([p, values]) => {
    const t = propertyText(props[p]);
    return t !== null && values.some((v) => String(v) === t);
  });

/** The event's quantity on the meter (fixed-12), or null when the meter does not count it. */
export function meterQuantityE12(m: GateMeter, e: Pick<GateEvent, "eventName" | "properties">) {
  if (m.eventName !== e.eventName || !passesFilters(m, e.properties)) return null;
  if (m.aggregation === "count") return 1_000_000_000_000n;
  const raw = m.valueProperty ? propertyText(e.properties[m.valueProperty]) : null;
  if (raw === null || !DECIMAL.test(raw)) return null;
  return tryParseFixed12(raw);
}

interface Demand {
  event: GateEvent;
  meter: GateMeter;
  quantityE12: bigint;
}

type Row = typeof creditUsageEvents.$inferInsert;

/** Override rows of the meters and the live subscriptions (oldest first) of the customers. */
async function loadCostContext(
  tx: Tx,
  meterIds: string[],
  customerIds: string[],
): Promise<{
  layers: Map<string, Pick<CostLayers, "byProduct" | "bySubscription">>;
  subs: Map<string, Array<{ id: string; productIds: string[] }>>;
}> {
  const layers = new Map<
    string,
    { byProduct: Map<string, bigint>; bySubscription: Map<string, bigint> }
  >();
  const rows = meterIds.length
    ? await tx
        .select()
        .from(meterCreditCosts)
        .where(and(inArray(meterCreditCosts.meterId, meterIds), eq(meterCreditCosts.active, true)))
    : [];
  for (const r of rows) {
    if (!r.productId && !r.subscriptionId) continue;
    const l = layers.get(r.meterId) ?? { byProduct: new Map(), bySubscription: new Map() };
    const cost = parseCostE6(r.creditsPerUnit) ?? 0n;
    if (r.productId) l.byProduct.set(r.productId, cost);
    else l.bySubscription.set(r.subscriptionId!, cost);
    layers.set(r.meterId, l);
  }
  const subs = new Map<string, Array<{ id: string; productIds: string[] }>>();
  if (layers.size && customerIds.length) {
    const live = rowsOf<{ customer_id: string; id: string; product_ids: string[] }>(
      await tx.execute(sql`
        select s.customer_id, s.id,
          array(select distinct p.product_id::text from subscription_items si
                join prices p on p.id = si.price_id where si.subscription_id = s.id) as product_ids
        from subscriptions s
        where s.customer_id = any(${pgTextArray(customerIds)}::uuid[])
          and s.status in ('active', 'in_trial')
        order by s.created_at, s.id`),
    );
    for (const s of live)
      subs.set(s.customer_id, [
        ...(subs.get(s.customer_id) ?? []),
        { id: s.id, productIds: s.product_ids },
      ]);
  }
  return { layers, subs };
}

/**
 * `block` or `bill` when the credits run out. `bill` bills the rest in money when the meter
 * or the unit has an overage price, and acts as `block` when neither has. A customer with no
 * live subscription is `block` unless `no_subscription_usage` is `as_subscriber`; a free trial
 * is `block` unless `trial_usage` is `as_paid`. Otherwise the ladder answers; a live grant in
 * this unit that says `block` is its grant rung.
 */
export async function gatePolicy(
  tx: Tx,
  input: { businessId: string; customerId: string; unitId: string; now: Date },
): Promise<"block" | "bill"> {
  return (await unitPolicy(tx, input)).policy;
}

/** `gatePolicy` with the rung that answered. `no_subscription`: a customer with no live subscription. */
export async function unitPolicy(
  tx: Tx,
  input: { businessId: string; customerId: string; unitId: string; now: Date },
): Promise<EffectivePolicy> {
  return (await resolveUnitPolicy(tx, input)).policy;
}

async function resolveUnitPolicy(
  tx: Tx,
  input: { businessId: string; customerId: string; unitId: string; now: Date },
): Promise<{
  policy: EffectivePolicy;
  sub: { id: string; status: string } | null;
  rules: CreditEngineRules;
}> {
  const [sub] = rowsOf<{ id: string; status: string }>(
    await tx.execute(sql`
      select id, status from subscriptions
      where customer_id = ${input.customerId}
        and status in (${sql.join(
          LIVE_SUBSCRIPTION_STATUSES.map((s) => sql`${s}`),
          sql`, `,
        )})
      order by created_at, id limit 1`),
  );
  const ctx = await loadCreditContext(tx, input.businessId, input.customerId);
  const rules = resolveCreditEngineRules(ctx?.business.creditConfig);
  const out = (policy: EffectivePolicy) => ({ policy, sub: sub ?? null, rules });
  if (!sub && rules.noSubscriptionUsage === "block")
    return out({ policy: "block", source: "no_subscription" });
  // A free trial charges nothing unless `trial_usage` says to bill it as a paid subscription.
  if (sub?.status === "in_trial" && rules.trialUsage !== "as_paid")
    return out({ policy: "block", source: "trial" });
  const ladder = effectivePolicy({
    businessConfig: ctx?.business.creditConfig,
    customerSettings: ctx?.customer.creditSettings,
    now: input.now,
    grants: [],
    meterPriceIds: null,
    planCredits: sub ? await livePlanCredits(tx, input.customerId, sub.id) : [],
  });
  if (ladder.source === "business_blocking_off" || ladder.source === "customer_override")
    return out(ladder);
  const [blockGrant] = await tx
    .select({ id: creditGrants.id })
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.customerId, input.customerId),
        eq(creditGrants.unitId, input.unitId),
        eq(creditGrants.status, "active"),
        eq(creditGrants.onExhausted, "block"),
        sql`${creditGrants.effectiveAt} <= ${input.now.toISOString()}::timestamptz`,
        sql`(${creditGrants.expiresAt} is null or ${creditGrants.expiresAt} > ${input.now.toISOString()}::timestamptz)`,
      ),
    )
    .limit(1);
  return out(blockGrant ? { policy: "block", source: "grant" } : ladder);
}

/**
 * Take the credits of freshly stored events. Returns the events refused for credit, by key.
 * A refused event stays stored, with a `refused` row here and a `credit_usage_refused` event.
 * `coveredUnitId`: the events settle a hold in this unit (its units are back in the row), so
 * they are never refused for it: they take what the row offers and record the rest.
 */
export async function gateCreditUsage(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    now: Date;
    meters: readonly GateMeter[];
    events: readonly GateEvent[];
    coveredUnitId?: string | null;
    /** With `coveredUnitId`: units the hold may take from closed grants that it pins. */
    coveredPinSteps?: bigint;
    /**
     * With `coveredUnitId`: the most the events take in that unit (`capture_over_hold:
     * cap_at_hold`). The rest is a `forgiven` part. Null: no cap.
     */
    coveredCapSteps?: bigint | null;
  },
): Promise<Map<string, GateRefusal>> {
  const refused = new Map<string, GateRefusal>();
  const demands: Demand[] = [];
  for (const event of input.events)
    for (const meter of input.meters) {
      const quantityE12 = meterQuantityE12(meter, event);
      if (quantityE12 !== null) demands.push({ event, meter, quantityE12 });
    }
  if (!demands.length) return refused;

  const [biz] = rowsOf<{ credit_config: Parameters<typeof lateEventGraceMs>[0] }>(
    await tx.execute(sql`select credit_config from businesses where id = ${input.businessId}`),
  );
  const graceMs = lateEventGraceMs(biz?.credit_config);
  const customerIds = [...new Set(demands.flatMap((d) => d.event.customerId ?? []))];
  const withOverrides = [
    ...new Set(demands.filter((d) => d.meter.credit.overrides).map((d) => d.meter.id)),
  ];
  const cost = withOverrides.length
    ? await loadCostContext(tx, withOverrides, customerIds)
    : { layers: new Map(), subs: new Map() };

  const rows: Row[] = [];
  const base = (d: Demand, costE6: bigint, source: CostSource, due: bigint): Row => ({
    organizationId: input.organizationId,
    businessId: input.businessId,
    customerId: d.event.customerId,
    meterId: d.meter.id,
    unitId: d.meter.credit.unitId,
    eventId: d.event.eventId,
    eventKey: d.event.key,
    eventTimestamp: sql`${d.event.timestamp}::timestamptz` as unknown as Date,
    receivedAt: input.now,
    quantity: formatFixed12(d.quantityE12),
    creditsPerUnit: formatCostE6(costE6),
    costSource: source,
    unitsDue: due,
    coveredByHold: input.coveredUnitId === d.meter.credit.unitId,
    status: "taken",
  });
  const skip = (row: Row, status: CreditUsageStatus, reason: CreditUsageReason) =>
    rows.push({ ...row, status, reason });

  const groups = new Map<string, { customerId: string; unitId: string; list: Demand[] }>();
  const priced = new Map<Demand, { costE6: bigint; source: CostSource; due: bigint }>();
  for (const d of demands) {
    const layer = cost.layers.get(d.meter.id);
    const r = resolveCreditCost(
      {
        base: parseCostE6(d.meter.credit.cost) ?? 0n,
        byProduct: layer?.byProduct ?? new Map(),
        bySubscription: layer?.bySubscription ?? new Map(),
      },
      d.event.customerId ? (cost.subs.get(d.event.customerId) ?? []) : [],
    );
    const due = unitsDueSteps(d.quantityE12, r.costE6, d.meter.credit.decimals);
    priced.set(d, { ...r, due });
    if (!d.event.customerId) {
      skip(base(d, r.costE6, r.source, due), "skipped", "unmatched_customer");
      continue;
    }
    if (d.event.backfill) {
      skip(base(d, r.costE6, r.source, due), "skipped", "backfill");
      continue;
    }
    const k = `${d.event.customerId}|${d.meter.credit.unitId}`;
    const g = groups.get(k) ?? {
      customerId: d.event.customerId,
      unitId: d.meter.credit.unitId,
      list: [],
    };
    g.list.push(d);
    groups.set(k, g);
  }

  // Lock every balance the request touches, in a fixed order; then decide event by event.
  interface GroupState {
    customerId: string;
    unitId: string;
    balanceId: string | null;
    start: bigint;
    available: bigint;
    grace: Array<typeof creditGrantGrace.$inferSelect>;
    /** Per closed grant: what late events may take, and what open holds keep. */
    graceLeft: Map<string, bigint>;
    pinLeft: Map<string, bigint>;
    /** What this capture may still take of the pinned units. */
    pinBudget: bigint;
    /** What this capture may still take at all; null = no cap. */
    capLeft: bigint | null;
    topup: { threshold: bigint | null; due: boolean };
    /** Per meter: read once, and only when an event is short. */
    terms: Map<string, ShortTerms>;
  }
  const isLate = (d: Demand) =>
    payClass({ eventAt: d.event.at, receivedAt: input.now, graceMs }) === "event_time";
  const states = new Map<string, GroupState>();
  const keys = [...groups.keys()].sort();
  // A grant starts or ends at this instant: the row is made exact first, under the customer
  // lock, which every path takes before a balance row.
  const due = new Set<string>();
  for (const k of keys) {
    const g = groups.get(k)!;
    if (await unitBalanceDue(tx, { customerId: g.customerId, unitId: g.unitId, now: input.now }))
      due.add(k);
  }
  for (const id of [...new Set([...due].map((k) => groups.get(k)!.customerId))].sort())
    await lockCustomerBalances(tx, id);
  for (const k of keys) {
    const g = groups.get(k)!;
    const at = { customerId: g.customerId, unitId: g.unitId, now: input.now };
    if (due.has(k)) await bringUnitBalanceToNow(tx, at);
    const [bal] = await tx
      .select({
        id: creditUnitBalances.id,
        // What the row offers: the open holds keep their units. Below zero: an overshoot.
        steps: OFFERED_RAW,
        threshold: creditUnitBalances.topupThresholdSteps,
        dueAt: creditUnitBalances.topupDueAt,
      })
      .from(creditUnitBalances)
      .where(
        and(
          eq(creditUnitBalances.customerId, g.customerId),
          eq(creditUnitBalances.unitId, g.unitId),
        ),
      )
      .for("update")
      .limit(1);
    const covered = input.coveredUnitId === g.unitId;
    const grace =
      bal && (g.list.some(isLate) || (covered && (input.coveredPinSteps ?? 0n) > 0n))
        ? await tx
            .select()
            .from(creditGrantGrace)
            .where(
              and(
                eq(creditGrantGrace.customerId, g.customerId),
                eq(creditGrantGrace.unitId, g.unitId),
                isNull(creditGrantGrace.lockedAt),
              ),
            )
            .orderBy(creditGrantGrace.validUntil, creditGrantGrace.grantId)
            .for("update")
        : [];
    let steps = bal?.steps ?? 0n;
    // A grant became due between the probe and the row lock. The customer lock cannot be
    // waited for under a row lock: take it only if it is free, else offer nothing.
    if (bal && !due.has(k) && (await unitBalanceDue(tx, at))) {
      const [free] = rowsOf<{ ok: boolean }>(
        await tx.execute(
          sql`select pg_try_advisory_xact_lock(hashtextextended(${g.customerId}::text, 7401)) as ok`,
        ),
      );
      if (free?.ok) {
        await bringUnitBalanceToNow(tx, at);
        steps = await currentSteps(tx, bal.id);
      } else {
        log.warn("credit balance not exact at the gate: nothing offered", {
          event: "credit_gate_balance_not_exact",
          customerId: g.customerId,
        });
        steps = 0n;
      }
    }
    states.set(k, {
      customerId: g.customerId,
      unitId: g.unitId,
      balanceId: bal?.id ?? null,
      start: steps,
      available: steps,
      grace,
      graceLeft: new Map(grace.map((r) => [r.grantId, r.availableSteps - r.heldSteps])),
      pinLeft: new Map(grace.map((r) => [r.grantId, r.heldSteps])),
      pinBudget: covered ? (input.coveredPinSteps ?? 0n) : 0n,
      capLeft: covered ? (input.coveredCapSteps ?? null) : null,
      topup: { threshold: bal?.threshold ?? null, due: bal?.dueAt != null },
      terms: new Map(),
    });
  }

  // An event is accepted or refused whole, for every meter that counts it.
  const byEvent = new Map<string, Demand[]>();
  for (const g of groups.values())
    for (const d of g.list) byEvent.set(d.event.key, [...(byEvent.get(d.event.key) ?? []), d]);
  const refusedRows: Array<{
    d: Demand;
    due: bigint;
    available: bigint;
    policy: "block" | "bill";
  }> = [];
  for (const event of input.events) {
    const list = byEvent.get(event.key);
    if (!list) continue;
    const undo = list.map((d) => {
      const s = states.get(`${d.event.customerId}|${d.meter.credit.unitId}`)!;
      return {
        s,
        available: s.available,
        graceLeft: new Map(s.graceLeft),
        pinLeft: new Map(s.pinLeft),
        pinBudget: s.pinBudget,
        capLeft: s.capLeft,
      };
    });
    const accepted: Row[] = [];
    let short: { d: Demand; available: bigint; policy: "block" | "bill" } | null = null;
    for (const d of list) {
      const s = states.get(`${d.event.customerId}|${d.meter.credit.unitId}`)!;
      const p = priced.get(d)!;
      const row = base(d, p.costE6, p.source, p.due);
      // A late event inside the grace window: the grants that were live at its timestamp
      // and closed since pay first.
      const parts: Array<{ grantId: string; units: bigint }> = [];
      // A capped capture: what is past the hold is not charged, only recorded.
      let forgiven = 0n;
      if (s.capLeft !== null && input.coveredUnitId === s.unitId) {
        const take = p.due < s.capLeft ? p.due : s.capLeft;
        forgiven = p.due - take;
        s.capLeft -= take;
      }
      let rest = p.due - forgiven;
      // The capture of a hold whose grant closed: the units that grant keeps for it pay first.
      if (input.coveredUnitId === s.unitId)
        for (const r of s.grace) {
          if (rest <= 0n || s.pinBudget <= 0n) break;
          const pin = s.pinLeft.get(r.grantId)!;
          const units = [pin, rest, s.pinBudget].reduce((a, b) => (b < a ? b : a));
          if (units <= 0n) continue;
          parts.push({ grantId: r.grantId, units });
          s.pinLeft.set(r.grantId, pin - units);
          s.pinBudget -= units;
          rest -= units;
        }
      if (isLate(d))
        for (const r of s.grace) {
          if (rest <= 0n) break;
          const left = s.graceLeft.get(r.grantId)!;
          if (left <= 0n || !graceCovers(r, d.event.at, input.now)) continue;
          const units = left < rest ? left : rest;
          const same = parts.find((x) => x.grantId === r.grantId);
          if (same) same.units += units;
          else parts.push({ grantId: r.grantId, units });
          s.graceLeft.set(r.grantId, left - units);
          rest -= units;
        }
      let split = { covered: rest, billed: 0n, overdraft: 0n, refused: false };
      let price: OveragePrice | null = null;
      if (rest > s.available) {
        const coveredByHold = input.coveredUnitId === s.unitId;
        let terms = s.terms.get(d.meter.id);
        if (!terms) {
          terms = await shortTerms(tx, {
            businessId: input.businessId,
            customerId: s.customerId,
            unitId: s.unitId,
            meterId: d.meter.id,
            now: input.now,
          });
          s.terms.set(d.meter.id, terms);
        }
        // No balance row: nothing can go below zero.
        split = splitEventUnits({
          due: rest,
          offered: s.available,
          policy: terms.policy.policy,
          priced: terms.price !== null,
          floor: s.balanceId ? terms.floor : 0n,
          coveredByHold: coveredByHold && !!s.balanceId,
        });
        if (split.refused) {
          short = {
            d,
            available: s.available > 0n ? s.available : 0n,
            policy: terms.policy.policy,
          };
          break;
        }
        price = split.billed > 0n ? terms.price : null;
      }
      s.available -= split.covered + split.overdraft;
      // Part 0 carries the event's quantity and cost; a grace part is `pending`.
      let n = 0;
      const head = {
        quantity: row.quantity,
        unitsDue: p.due,
        unitsUncovered: split.billed,
        ...(price
          ? {
              overageBasis: price.basis,
              overageRateE12: price.basis === "unit" ? price.overageMinorPerUnitE12 : null,
              overagePriceId: price.basis === "meter" ? price.priceId : null,
            }
          : {}),
      };
      const tail = { quantity: "0", unitsDue: 0n, unitsUncovered: 0n };
      for (const part of parts)
        accepted.push({
          ...row,
          ...(n === 0 ? head : tail),
          part: n++,
          units: part.units,
          source: "grace",
          graceGrantId: part.grantId,
          status: "pending",
        });
      if (split.covered > 0n || (n === 0 && split.overdraft === 0n))
        accepted.push({
          ...row,
          ...(n === 0 ? head : tail),
          part: n++,
          units: split.covered,
          status: "taken",
        });
      // An overshoot below zero: its own part, so a later grant, invoice or write-off closes it.
      if (split.overdraft > 0n)
        accepted.push({
          ...row,
          ...(n === 0 ? head : tail),
          part: n++,
          units: split.overdraft,
          source: "overdraft",
          status: "taken",
        });
      if (forgiven > 0n)
        accepted.push({
          ...row,
          ...(n === 0 ? head : tail),
          part: n++,
          units: forgiven,
          source: "overdraft",
          status: "forgiven",
          zeroReason: "hold_cap",
        });
    }
    if (!short) {
      rows.push(...accepted);
      continue;
    }
    for (const u of undo) {
      u.s.available = u.available;
      u.s.graceLeft = u.graceLeft;
      u.s.pinLeft = u.pinLeft;
      u.s.pinBudget = u.pinBudget;
      u.s.capLeft = u.capLeft;
    }
    for (const d of list) {
      const p = priced.get(d)!;
      skip(base(d, p.costE6, p.source, p.due), "refused", "insufficient_credit");
    }
    refused.set(event.key, refusal());
    refusedRows.push({
      d: short.d,
      due: priced.get(short.d)!.due,
      available: short.available,
      policy: short.policy,
    });
  }

  for (const s of states.values()) {
    // The automatic top-up's threshold, checked in the take itself: the mark is the queue
    // (`credit_auto_topups` pass). Set once, under the row's lock.
    const mark =
      s.topup.threshold !== null && !s.topup.due && s.available <= s.topup.threshold
        ? { topupDueAt: input.now }
        : {};
    if (s.balanceId && (s.available !== s.start || "topupDueAt" in mark))
      await tx
        .update(creditUnitBalances)
        .set({
          availableSteps: sql`${creditUnitBalances.availableSteps} - ${s.start - s.available}`,
          updatedAt: sql`app_now()`,
          ...mark,
        })
        .where(eq(creditUnitBalances.id, s.balanceId));
    for (const r of s.grace) {
      const free = s.graceLeft.get(r.grantId)!;
      const pin = s.pinLeft.get(r.grantId)!;
      if (free + pin !== r.availableSteps)
        await tx
          .update(creditGrantGrace)
          .set({ availableSteps: free + pin, heldSteps: pin, updatedAt: sql`app_now()` })
          .where(eq(creditGrantGrace.grantId, r.grantId));
    }
  }

  for (let i = 0; i < rows.length; i += 500)
    await tx.insert(creditUsageEvents).values(rows.slice(i, i + 500));
  if (refusedRows.length) {
    // Refused for the whole event: it counts as cost, not as usage (`countsAsUsage`).
    const marked = input.events.filter((e) => refused.has(e.key));
    await tx.execute(sql`
      update usage_events e set refused_at = ${input.now.toISOString()}::timestamptz
      from unnest(${pgTextArray(marked.map((e) => e.eventId))}::uuid[],
                  ${pgTextArray(marked.map((e) => e.timestamp))}::timestamptz[]) as u(id, ts)
      where e.id = u.id and e."timestamp" = u.ts`);
    await emitRefused(tx, input, refusedRows);
  }
  return refused;
}

async function currentSteps(tx: Tx, balanceId: string): Promise<bigint> {
  const [r] = await tx
    .select({ steps: OFFERED_RAW })
    .from(creditUnitBalances)
    .where(eq(creditUnitBalances.id, balanceId));
  return r?.steps ?? 0n;
}

async function emitRefused(
  tx: Tx,
  input: { organizationId: string; businessId: string; now: Date },
  list: Array<{ d: Demand; due: bigint; available: bigint; policy: "block" | "bill" }>,
): Promise<void> {
  const ids = [...new Set(list.map((r) => r.d.event.customerId!))];
  const customers = rowsOf<{ id: string; public_id: string }>(
    await tx.execute(
      sql`select id, public_id from customers where id = any(${pgTextArray(ids)}::uuid[])`,
    ),
  );
  const publicIdOf = new Map(customers.map((c) => [c.id, c.public_id]));
  for (const { d, due, available, policy } of list) {
    const decimals = d.meter.credit.decimals;
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "credit_usage_refused",
      data: buildEventData("credit_usage_refused", {
        id: d.event.key,
        object: "credit_usage",
        usage_event: d.event.key,
        customer: publicIdOf.get(d.event.customerId!) ?? null,
        meter: d.meter.key,
        unit: d.meter.credit.unitKey,
        quantity: formatFixed12(d.quantityE12),
        credits_due: formatSteps(due, decimals),
        credits_available: formatSteps(available, decimals),
        status: "refused",
        reason: "insufficient_credit",
        // `bill`: refused because neither the meter nor the unit has an overage price.
        policy,
        timestamp: d.event.at.toISOString(),
        received_at: input.now.toISOString(),
      }),
    });
  }
  log.info("usage refused for credit", {
    event: "credit_usage_refused",
    refused: list.length,
  });
}

/** Keys among `keys` whose event was refused for credit: a replay answers as the first time did. */
export async function refusedEventKeys(
  tx: Tx,
  businessId: string,
  keys: readonly string[],
): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await tx
    .select({ key: creditUsageEvents.eventKey })
    .from(creditUsageEvents)
    .where(
      and(
        eq(creditUsageEvents.businessId, businessId),
        inArray(creditUsageEvents.eventKey, [...keys]),
        eq(creditUsageEvents.status, "refused"),
      ),
    );
  return new Set(rows.map((r) => r.key));
}

export class CreditUsageSettledError extends Error {
  constructor(
    message = "We could not void the event. Its credits changed at the same time. Try again.",
  ) {
    super(message);
    this.name = "CreditUsageSettledError";
  }
}

/**
 * An event is voided: give back the credits it took. Units that no settlement drew go back
 * to the balance row (an overshoot part with them). Units that a settlement drew get a
 * correcting settlement (`correctSettledUsage`). Refused when an invoice or a pending charge
 * carries the event's usage beyond the credits: correct that with a credit note.
 */
export async function releaseCreditUsage(
  tx: Tx,
  input: { businessId: string; eventId: string },
): Promise<void> {
  const mine = and(
    eq(creditUsageEvents.businessId, input.businessId),
    eq(creditUsageEvents.eventId, input.eventId),
  );
  const seen = await tx
    .selectDistinct({
      customerId: creditUsageEvents.customerId,
      unitId: creditUsageEvents.unitId,
      status: creditUsageEvents.status,
    })
    .from(creditUsageEvents)
    .where(mine);
  // A correction moves grants: the customer lock comes before the balance rows.
  const corrects = seen.some((x) => x.status === "settled");
  if (corrects)
    for (const id of [...new Set(seen.flatMap((x) => x.customerId ?? []))].sort())
      await lockCustomerBalances(tx, id);
  // The balance rows first (settlement's order), then the event's rows as they stand now.
  const balanceOf = new Map<string, string>();
  const units = [...new Map(seen.filter((x) => x.customerId).map((x) => [x.unitId, x])).values()];
  for (const s of units.sort((a, b) => (a.unitId < b.unitId ? -1 : 1))) {
    const [bal] = await tx
      .select({ id: creditUnitBalances.id })
      .from(creditUnitBalances)
      .where(
        and(
          eq(creditUnitBalances.customerId, s.customerId!),
          eq(creditUnitBalances.unitId, s.unitId),
        ),
      )
      .for("update")
      .limit(1);
    if (bal) balanceOf.set(s.unitId, bal.id);
  }
  const rows = await tx.select().from(creditUsageEvents).where(mine).for("update");
  const live = rows.filter((r) => ["taken", "pending", "settled", "billed"].includes(r.status));
  if (live.some((r) => r.status === "billed" || r.overageChargeId || r.overageInvoiceId))
    throw new CreditUsageSettledError(
      "We could not void the event. An invoice bills its usage beyond the credits. Issue a credit note instead.",
    );
  // Settled between the first read and the row locks.
  if (!corrects && rows.some((r) => r.status === "settled")) throw new CreditUsageSettledError();
  if (corrects) {
    const { correctSettledUsage } = await import("./overage");
    const { stampNow } = await import("@/platform/clock");
    await correctSettledUsage(tx, {
      businessId: input.businessId,
      eventId: input.eventId,
      rows,
      now: stampNow(input.businessId),
    });
  }
  for (const r of rows.filter((x) => x.status === "taken" && x.units > 0n))
    await tx
      .update(creditUnitBalances)
      .set({
        availableSteps: sql`${creditUnitBalances.availableSteps} + ${r.units}`,
        updatedAt: sql`app_now()`,
      })
      .where(eq(creditUnitBalances.id, balanceOf.get(r.unitId)!));
  for (const r of rows.filter((x) => x.status === "pending" && x.units > 0n)) {
    const back = await tx
      .update(creditGrantGrace)
      .set({
        availableSteps: sql`${creditGrantGrace.availableSteps} + ${r.units}`,
        updatedAt: sql`app_now()`,
      })
      .where(and(eq(creditGrantGrace.grantId, r.graceGrantId!), isNull(creditGrantGrace.lockedAt)))
      .returning({ id: creditGrantGrace.grantId });
    // The window ended at this instant and the units are drawn.
    if (!back.length) throw new CreditUsageSettledError();
  }
  await tx
    .update(creditUsageEvents)
    .set({
      status: "skipped",
      reason: "voided",
      units: 0n,
      settlementId: null,
      zeroReason: "event_voided",
    })
    .where(and(mine, inArray(creditUsageEvents.status, ["taken", "pending", "settled"])));
}

/** What the gate recorded for events, by event id, as the usage event API shows it. */
export async function creditUsageOfEvents(
  tx: Tx,
  businessId: string,
  eventIds: readonly string[],
): Promise<Map<string, ReturnType<typeof serializeCreditUsage>>> {
  const out = new Map<string, ReturnType<typeof serializeCreditUsage>>();
  if (!eventIds.length) return out;
  const rows = rowsOf<CreditUsageRow>(
    await tx.execute(sql`
      select c.event_id, m.key as meter, u.key as unit, u.decimals, c.part, c.quantity::text as quantity,
        c.credits_per_unit::text as credits_per_unit, c.cost_source, c.units_due, c.units_uncovered,
        c.units, c.source, c.status, c.reason, c.covered_by_hold, c.overage_basis, c.zero_reason
      from credit_usage_events c
      join meters m on m.id = c.meter_id
      join credit_units u on u.id = c.unit_id
      where c.business_id = ${businessId} and c.event_id = any(${pgTextArray([...eventIds])}::uuid[])
      order by c.event_id, m.key, c.part`),
  );
  const byEvent = new Map<string, CreditUsageRow[]>();
  for (const r of rows) byEvent.set(r.event_id, [...(byEvent.get(r.event_id) ?? []), r]);
  for (const [id, list] of byEvent) out.set(id, serializeCreditUsage(list));
  return out;
}

interface CreditUsageRow {
  event_id: string;
  meter: string;
  unit: string;
  decimals: number;
  part: number;
  quantity: string;
  credits_per_unit: string;
  cost_source: CostSource;
  units_due: string | bigint;
  units_uncovered: string | bigint;
  units: string | bigint;
  source: "balance" | "grace" | "overdraft";
  overage_basis: "meter" | "unit" | null;
  status: CreditUsageStatus;
  reason: CreditUsageReason | null;
  covered_by_hold: boolean;
  zero_reason?: string | null;
}

/**
 * One entry per meter. `status`: `pending` while a part waits for a grace window to end,
 * `taken` while a part waits for settlement, `settled` once every part is drawn; `refused`
 * and `skipped` spend nothing and are never billed.
 */
export function serializeCreditUsage(rows: CreditUsageRow[]) {
  const byMeter = new Map<string, CreditUsageRow[]>();
  for (const r of rows) byMeter.set(r.meter, [...(byMeter.get(r.meter) ?? []), r]);
  return [...byMeter.values()].map((parts) => {
    const head = parts.find((p) => p.part === 0) ?? parts[0]!;
    const d = head.decimals;
    const sum = (f: (p: CreditUsageRow) => boolean) =>
      parts.filter(f).reduce((s, p) => s + BigInt(p.units), 0n);
    // `billed` and `forgiven` are states of an overshoot part; the event itself is settled.
    const status: CreditUsageStatus = parts.some((p) => p.status === "pending")
      ? "pending"
      : parts.some((p) => p.status === "taken")
        ? "taken"
        : head.status === "billed" || head.status === "forgiven"
          ? "settled"
          : head.status;
    return {
      meter: head.meter,
      unit: head.unit,
      status,
      reason: head.reason,
      quantity: formatFixed12(tryParseFixed12(head.quantity) ?? 0n),
      credits_per_unit: head.credits_per_unit.replace(/\.?0+$/, ""),
      cost_source: head.cost_source,
      credits_due: formatSteps(BigInt(head.units_due), d),
      credits_taken: formatSteps(
        sum((p) => !pastHold(p)),
        d,
      ),
      credits_from_closed_grant: formatSteps(
        sum((p) => p.source === "grace"),
        d,
      ),
      credits_uncovered: formatSteps(BigInt(head.units_uncovered), d),
      // How `credits_uncovered` is billed in money; null when nothing bills it.
      overage_basis: head.overage_basis,
      // Taken below zero and not repaid, billed or written off yet.
      credits_overdrawn: formatSteps(
        sum((p) => p.source === "overdraft" && p.status === "taken"),
        d,
      ),
      covered_by_hold: head.covered_by_hold,
      // Past the hold and not charged (`capture_over_hold: cap_at_hold`).
      credits_past_hold: formatSteps(sum(pastHold), d),
    };
  });
}

const pastHold = (p: CreditUsageRow) => p.status === "forgiven" && p.zero_reason === "hold_cap";
