/**
 * Holds in a credit unit with no money rate (0527). A hold on a meter with a credit cost
 * reserves units: `credit_unit_balances.held_steps` is the sum of the open holds and the gate
 * offers `available_steps − held_steps`, so no event and no other hold can spend them.
 * Capture gives the units back and takes the event's units in one transaction.
 *
 * Lock order: the customer lock, grant rows and hold rows, the balance rows (by unit id),
 * then `credit_usage_events` rows.
 */
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { stampNow } from "@/platform/clock";
import type { Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { tryParseFixed12 } from "@/platform/fixed";
import { lockCustomerBalances } from "@/modules/customers/balances-read";
import { ingestUsageEventsTx } from "@/modules/metering/ingest";
import { resolveUsageKeys } from "@/modules/metering/meters";
import { rowsOf } from "@/modules/metering/usage-sql";
import { subscribedEventTypes } from "@/modules/webhooks/subscribed-types";
import { creditGrantGrace, creditHolds, creditUnitBalances, creditUsageEvents } from "@db/schema";
import {
  parseCostE6,
  parseUnitSteps,
  resolveCreditCost,
  splitEventUnits,
  unitsDueSteps,
  type CostSource,
} from "./credit-cost";
import { ensureCreditWindows } from "./credit-clock";
import {
  CaptureEventError,
  CreditRefusedError,
  emitHoldEvent,
  HoldInputError,
  markHoldChanged,
  refsOf,
  type CreditContext,
  type CreditHold,
} from "./holds";
import {
  CREDIT_CONFIG_DEFAULTS,
  inFlightRefused,
  resolveCreditEngineRules,
  type EffectivePolicy,
} from "./policy";
import { formatSteps } from "./units";
import { shortTerms, unitPolicy } from "./usage-gate";
import { bringUnitBalanceToNow, unitBalanceDue } from "./usage-settlement";

/** What one unit of a meter costs this customer, in credits. */
export interface MeterCreditCost {
  unitId: string;
  unitKey: string;
  decimals: number;
  currency: string;
  aggregation: string;
  costE6: bigint;
  source: CostSource;
}

/**
 * The credit cost of a meter for a customer: the subscription's row, then the plan's, then
 * the meter's own (the gate's rule). Null when the meter is not paid in credits.
 */
export async function meterCreditCostFor(
  tx: Tx,
  input: { meterId: string; customerId: string },
): Promise<MeterCreditCost | null> {
  const rows = rowsOf<{
    unit_id: string;
    unit_key: string;
    decimals: number;
    currency: string;
    aggregation: string;
    credits_per_unit: string;
    product_id: string | null;
    subscription_id: string | null;
  }>(
    await tx.execute(sql`
      select c.unit_id, u.key as unit_key, u.decimals, u.currency, m.aggregation,
        c.credits_per_unit::text as credits_per_unit, c.product_id, c.subscription_id
      from meter_credit_costs c
      join credit_units u on u.id = c.unit_id
      join meters m on m.id = c.meter_id
      where c.meter_id = ${input.meterId} and c.active`),
  );
  const own = rows.find((r) => !r.product_id && !r.subscription_id);
  if (!own) return null;
  const byProduct = new Map<string, bigint>();
  const bySubscription = new Map<string, bigint>();
  for (const r of rows) {
    const cost = parseCostE6(r.credits_per_unit) ?? 0n;
    if (r.product_id) byProduct.set(r.product_id, cost);
    else if (r.subscription_id) bySubscription.set(r.subscription_id, cost);
  }
  const subs =
    byProduct.size || bySubscription.size
      ? rowsOf<{ id: string; product_ids: string[] }>(
          await tx.execute(sql`
            select s.id,
              array(select distinct p.product_id::text from subscription_items si
                    join prices p on p.id = si.price_id where si.subscription_id = s.id) as product_ids
            from subscriptions s
            where s.customer_id = ${input.customerId} and s.status in ('active', 'in_trial')
            order by s.created_at, s.id`),
        ).map((s) => ({ id: s.id, productIds: s.product_ids }))
      : [];
  const r = resolveCreditCost(
    { base: parseCostE6(own.credits_per_unit) ?? 0n, byProduct, bySubscription },
    subs,
  );
  return {
    unitId: own.unit_id,
    unitKey: own.unit_key,
    decimals: own.decimals,
    currency: own.currency,
    aggregation: own.aggregation,
    costE6: r.costE6,
    source: r.source,
  };
}

/** The steps a hold or an estimate asks for: a meter quantity at the cost, or a count of credits. */
export function requestedSteps(
  cost: Pick<MeterCreditCost, "costE6" | "decimals">,
  input: { quantity?: string | null; units?: string | null },
): bigint | null {
  if (input.units != null) return parseUnitSteps(input.units, cost.decimals);
  if (input.quantity == null) return null;
  const q = tryParseFixed12(input.quantity);
  return q === null || q < 0n ? null : unitsDueSteps(q, cost.costE6, cost.decimals);
}

interface RowState {
  id: string;
  available: bigint;
  held: bigint;
  pinned: bigint;
}

async function lockRow(tx: Tx, customerId: string, unitId: string): Promise<RowState | null> {
  const [row] = await tx
    .select({
      id: creditUnitBalances.id,
      available: creditUnitBalances.availableSteps,
      held: creditUnitBalances.heldSteps,
      pinned: creditUnitBalances.pinnedSteps,
    })
    .from(creditUnitBalances)
    .where(
      and(eq(creditUnitBalances.customerId, customerId), eq(creditUnitBalances.unitId, unitId)),
    )
    .for("update")
    .limit(1);
  return row ?? null;
}

/** Move the row's sums and keep `row` in step. */
async function moveRow(
  tx: Tx,
  row: RowState,
  d: { available?: bigint; held?: bigint; pinned?: bigint },
): Promise<void> {
  row.available += d.available ?? 0n;
  row.held += d.held ?? 0n;
  row.pinned += d.pinned ?? 0n;
  await tx
    .update(creditUnitBalances)
    .set({
      availableSteps: row.available,
      heldSteps: row.held,
      pinnedSteps: row.pinned,
      updatedAt: sql`app_now()`,
    })
    .where(eq(creditUnitBalances.id, row.id));
}

/**
 * Make the customer's rows in these units exact at `now` and lock them, by unit id. The
 * caller holds the customer lock.
 */
async function lockUnitRows(tx: Tx, customerId: string, unitIds: string[], now: Date) {
  const sorted = [...new Set(unitIds)].sort();
  for (const unitId of sorted) {
    const at = { customerId, unitId, now };
    if (await unitBalanceDue(tx, at)) await bringUnitBalanceToNow(tx, at);
  }
  const rows = new Map<string, RowState>();
  for (const unitId of sorted) {
    const row = await lockRow(tx, customerId, unitId);
    if (row) rows.set(unitId, row);
  }
  return rows;
}

/** What the row offers: open holds keep their units, less the part closed grants back. */
const offeredOf = (row: RowState) => {
  const kept = row.held > row.pinned ? row.held - row.pinned : 0n;
  return row.available > kept ? row.available - kept : 0n;
};

/**
 * After the holds of a row went down: closed grants keep only what the open holds still need
 * beyond the row (`pinned ≤ max(held − available, 0)`). What is let go stays in the grant's
 * grace row and is booked out with it; it never becomes spendable. Pins only shrink here.
 */
export async function settlePins(
  tx: Tx,
  input: { customerId: string; unitId: string },
  row: RowState,
): Promise<void> {
  const need = row.held > row.available ? row.held - row.available : 0n;
  let over = row.pinned > need ? row.pinned - need : 0n;
  if (over <= 0n) return;
  const pins = await tx
    .select({ grantId: creditGrantGrace.grantId, held: creditGrantGrace.heldSteps })
    .from(creditGrantGrace)
    .where(
      and(
        eq(creditGrantGrace.customerId, input.customerId),
        eq(creditGrantGrace.unitId, input.unitId),
        isNull(creditGrantGrace.lockedAt),
        sql`${creditGrantGrace.heldSteps} > 0`,
      ),
    )
    .orderBy(sql`${creditGrantGrace.locksAt} desc`, creditGrantGrace.grantId)
    .for("update");
  let freed = 0n;
  for (const g of pins) {
    if (over <= 0n) break;
    const cut = g.held < over ? g.held : over;
    await tx
      .update(creditGrantGrace)
      .set({ heldSteps: g.held - cut, updatedAt: sql`app_now()` })
      .where(eq(creditGrantGrace.grantId, g.grantId));
    over -= cut;
    freed += cut;
  }
  // The row never claims more than the grace rows hold.
  await moveRow(tx, row, { pinned: -(freed + over) });
}

/**
 * Reserve `units` for a hold. Refused when the balance does not cover it (`block`, and `bill`
 * until usage beyond the balance has a money price) and, under `block`, by the in-flight
 * share. The caller's transaction commits the hold and the reservation together.
 */
export async function createUnitHold(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    ctx: CreditContext;
    meter: { id: string; key: string };
    cost: MeterCreditCost;
    units: bigint;
    ttlSeconds: number;
    scope: Record<string, string> | null;
    metadata: Record<string, unknown> | null;
  },
): Promise<{ hold: CreditHold; policy: EffectivePolicy }> {
  const { ctx, cost } = input;
  const customerId = ctx.customer.id;
  await lockCustomerBalances(tx, customerId);
  const now = stampNow(input.businessId);
  await ensureCreditWindows(tx, { customerId, now });
  const at = { customerId, unitId: cost.unitId, now };
  if (await unitBalanceDue(tx, at)) await bringUnitBalanceToNow(tx, at);
  const row = await lockRow(tx, customerId, cost.unitId);
  const policy = await unitPolicy(tx, { businessId: input.businessId, ...at });
  // What may be spent before holds: the row, and what closed grants keep for open holds.
  const before = row ? (row.available > 0n ? row.available : 0n) + row.pinned : 0n;
  const held = row?.held ?? 0n;
  const offered = row ? offeredOf(row) : 0n;
  const cfg = ctx.business.creditConfig ?? {};
  const fmt = (v: bigint) => formatSteps(v, cost.decimals);
  if (
    policy.policy === "block" &&
    inFlightRefused({
      balanceBeforeHoldsMinor: before,
      openHoldsMinor: held,
      amountMinor: input.units,
      shareBps: cfg.in_flight_share_bps ?? CREDIT_CONFIG_DEFAULTS.in_flight_share_bps,
      applies: cfg.in_flight_applies,
    })
  )
    throw new CreditRefusedError("in_flight_limit", {
      unit: cost.unitKey,
      balance_units: fmt(before),
      open_holds_units: fmt(held),
    });
  // A hold reserves credits the customer has: it never reserves money overage or an overshoot.
  if (!row || input.units > offered)
    throw new CreditRefusedError("insufficient_credit", {
      unit: cost.unitKey,
      available_units: fmt(offered),
    });
  await moveRow(tx, row, { held: input.units });
  const [hold] = await tx
    .insert(creditHolds)
    .values({
      organizationId: input.organizationId,
      businessId: input.businessId,
      publicId: publicId("chd"),
      customerId,
      currency: cost.currency,
      amountMinor: 0n,
      unitId: cost.unitId,
      amountUnits: input.units,
      remainingUnits: input.units,
      meterId: input.meter.id,
      scope: input.scope,
      status: "held",
      expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000),
      metadata: input.metadata,
    })
    .returning();
  return { hold: hold!, policy };
}

/**
 * Give what a hold still reserves back. Units that a closed grant kept for it stay with that
 * grant (`settlePins`). The caller holds the customer lock and the hold row.
 */
export async function returnHeldUnits(tx: Tx, hold: CreditHold): Promise<void> {
  if (!hold.unitId || !hold.remainingUnits) return;
  const row = await lockRow(tx, hold.customerId, hold.unitId);
  if (!row) return;
  await moveRow(tx, row, { held: -hold.remainingUnits });
  await settlePins(tx, { customerId: hold.customerId, unitId: hold.unitId }, row);
}

/**
 * End the customer's holds in a unit whose time is up: their units go back. The caller holds
 * the customer lock. Runs in the hold expiry pass and whenever the gate makes the row exact,
 * so a hold stops reserving at its expiry, not at the next pass.
 */
export async function expireLapsedUnitHolds(
  tx: Tx,
  input: { customerId: string; unitId: string; now: Date },
): Promise<CreditHold[]> {
  const lapsed = await tx
    .select()
    .from(creditHolds)
    .where(
      and(
        eq(creditHolds.customerId, input.customerId),
        eq(creditHolds.unitId, input.unitId),
        eq(creditHolds.status, "held"),
        lte(creditHolds.expiresAt, input.now),
      ),
    )
    .orderBy(creditHolds.id)
    .for("update");
  if (!lapsed.length) return [];
  const rows = await tx
    .update(creditHolds)
    .set({ status: "expired", remainingUnits: 0n })
    .where(
      inArray(
        creditHolds.id,
        lapsed.map((h) => h.id),
      ),
    )
    .returning();
  const row = await lockRow(tx, input.customerId, input.unitId);
  const units = lapsed.reduce((s, h) => s + (h.remainingUnits ?? 0n), 0n);
  if (row && units > 0n) {
    await moveRow(tx, row, { held: -units });
    await settlePins(tx, input, row);
  }
  const first = rows[0]!;
  await markHoldChanged(tx, first.businessId, [input.customerId]);
  if ((await subscribedEventTypes(tx, first.organizationId)).has("credit_hold_expired")) {
    for (const h of rows)
      await emitHoldEvent(tx, {
        organizationId: h.organizationId,
        businessId: h.businessId,
        type: "credit_hold_expired",
        hold: h,
        refs: await refsOf(tx, h),
      });
  }
  return rows;
}

/**
 * Capture a hold in units, whole or one step of a lease. What the hold reserves goes back,
 * then the event takes its own units: first what closed grants keep for the hold (as a late
 * event takes from a grace row), then the row. Less than reserved leaves the rest: in the
 * balance when `final`, reserved again when not. More takes what the row offers and records
 * the rest (`units_uncovered`). An event the gate refused before is paid here from the row.
 * The caller holds the customer lock and the hold row, and writes the hold.
 */
export async function captureUnitHold(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    hold: CreditHold;
    now: Date;
    usageEvent?: unknown;
    usageEventKey?: string;
    final: boolean;
  },
): Promise<{
  eventId: string;
  capturedUnits: bigint;
  uncoveredUnits: bigint;
  remainingUnits: bigint;
}> {
  const { hold, now } = input;
  const unitId = hold.unitId!;
  const reserved = hold.remainingUnits ?? 0n;
  const wrongCustomer = () =>
    new CaptureEventError({
      code: "invalid_request",
      message: "We could not capture the hold. The usage event is for a different customer.",
    });
  let eventId: string;
  let own: RowState | undefined;
  // `capture_over_hold: cap_at_hold`: the event takes at most what the hold reserves.
  const [biz] = rowsOf<{ credit_config: Parameters<typeof resolveCreditEngineRules>[0] }>(
    await tx.execute(sql`select credit_config from businesses where id = ${input.businessId}`),
  );
  const cap =
    resolveCreditEngineRules(biz?.credit_config).captureOverHold === "cap_at_hold"
      ? reserved
      : null;
  if (input.usageEvent != null) {
    const key = (input.usageEvent as { customer?: unknown }).customer;
    const owner =
      typeof key === "string"
        ? ((await resolveUsageKeys(tx, input.businessId, [key])).get(key) ?? null)
        : null;
    if (owner !== hold.customerId) throw wrongCustomer();
    // Every row the event's meters may take from, before the gate locks them in its order.
    const name = (input.usageEvent as { event_name?: unknown }).event_name;
    const paid =
      typeof name === "string"
        ? rowsOf<{ unit_id: string }>(
            await tx.execute(sql`
              select distinct c.unit_id from meters m
              join meter_credit_costs c on c.meter_id = m.id and c.active
              where m.business_id = ${input.businessId} and m.event_name = ${name}`),
          )
        : [];
    const rows = await lockUnitRows(
      tx,
      hold.customerId,
      [unitId, ...paid.map((p) => p.unit_id)],
      now,
    );
    own = rows.get(unitId);
    // The pinned part of the reservation is handed to the gate; the rest returns to the row.
    const pin = own ? (reserved < own.pinned ? reserved : own.pinned) : 0n;
    if (own) await moveRow(tx, own, { held: -reserved, pinned: -pin });
    const [r] = await ingestUsageEventsTx(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      events: [input.usageEvent],
      coveredUnitId: unitId,
      coveredPinSteps: pin,
      coveredCapSteps: cap,
    });
    // Short in another unit: the hold does not cover it.
    if (r!.status === "error" && r!.error?.code === "insufficient_credit")
      throw new CreditRefusedError("insufficient_credit");
    if (r!.status === "error") throw new CaptureEventError(r!.error!);
    if (r!.status === "duplicate")
      throw new CaptureEventError({
        code: "duplicate_event",
        message:
          "We could not capture the hold. An event with this key exists. Send usage_event_id to capture it.",
      });
    const [id] = rowsOf<{ event_id: string }>(
      await tx.execute(sql`select event_id from usage_event_dedup
        where business_id = ${input.businessId} and key = ${r!.key}`),
    );
    eventId = id!.event_id;
    if (own) {
      // The gate moved the row and the grace rows: read the row again. What it did not take
      // of the pinned part is still in the grace rows, and still pinned.
      const [pins] = rowsOf<{ held: string }>(
        await tx.execute(sql`
          select coalesce(sum(held_steps), 0)::text as held from credit_grant_grace
          where customer_id = ${hold.customerId} and unit_id = ${unitId} and locked_at is null`),
      );
      Object.assign(own, (await lockRow(tx, hold.customerId, unitId))!);
      await moveRow(tx, own, { pinned: BigInt(pins?.held ?? "0") - own.pinned });
    }
  } else {
    const [d] = rowsOf<{ event_id: string; customer_id: string | null }>(
      await tx.execute(sql`select d.event_id, e.customer_id from usage_event_dedup d
        join usage_events e on e.id = d.event_id and e."timestamp" = d.event_timestamp
        where d.business_id = ${input.businessId} and d.key = ${input.usageEventKey}`),
    );
    if (!d) throw new HoldInputError(`No such usage event: ${input.usageEventKey}`, "not_found");
    if (d.customer_id !== hold.customerId) throw wrongCustomer();
    eventId = d.event_id;
    own = await payRefusedEvent(tx, { businessId: input.businessId, hold, eventId, now, cap });
  }
  if (cap !== null) await auditPastHold(tx, { ...input, eventId, unitId });
  const [sum] = rowsOf<{ units: string; uncovered: string }>(
    await tx.execute(sql`
      -- Uncovered: billed in money, or taken below zero (0530).
      select coalesce(sum(units) filter (where source <> 'overdraft'), 0)::text as units,
        (coalesce(sum(units_uncovered), 0)
          + coalesce(sum(units) filter (where source = 'overdraft'), 0))::text as uncovered
      from credit_usage_events
      where business_id = ${input.businessId} and event_id = ${eventId} and unit_id = ${unitId}
        and status in ('taken', 'pending', 'settled')`),
  );
  const capturedUnits = BigInt(sum?.units ?? "0");
  // A lease keeps what this step did not use.
  const remainingUnits = input.final || capturedUnits >= reserved ? 0n : reserved - capturedUnits;
  if (own) {
    if (remainingUnits > 0n) await moveRow(tx, own, { held: remainingUnits });
    await settlePins(tx, { customerId: hold.customerId, unitId }, own);
  }
  return {
    eventId,
    capturedUnits,
    uncoveredUnits: BigInt(sum?.uncovered ?? "0"),
    remainingUnits,
  };
}

/**
 * Capture by key: what the hold reserves goes back, and an event the gate refused for credit
 * is paid now from the row. In the hold's unit it takes what the row offers; in another unit
 * it must be covered in full, else the capture is refused. An event that took its credits at
 * ingest is left as it is. Units that a closed grant keeps for the hold are not used here.
 * The caller locked `usage_rollup_state` first when the event is refused (`captureCreditHold`).
 */
async function payRefusedEvent(
  tx: Tx,
  input: {
    businessId: string;
    hold: CreditHold;
    eventId: string;
    now: Date;
    /** `capture_over_hold: cap_at_hold`: the most the event takes in the hold's unit. */
    cap: bigint | null;
  },
): Promise<RowState | undefined> {
  const { hold, now } = input;
  const mine = and(
    eq(creditUsageEvents.businessId, input.businessId),
    eq(creditUsageEvents.eventId, input.eventId),
  );
  const seen = await tx
    .selectDistinct({ unitId: creditUsageEvents.unitId })
    .from(creditUsageEvents)
    .where(and(mine, eq(creditUsageEvents.status, "refused")));
  const unitIds = [hold.unitId!, ...seen.map((s) => s.unitId)];
  const rows = await lockUnitRows(tx, hold.customerId, unitIds, now);
  const own = rows.get(hold.unitId!);
  if (own && hold.remainingUnits) await moveRow(tx, own, { held: -hold.remainingUnits });
  const refused = await tx
    .select()
    .from(creditUsageEvents)
    .where(
      and(
        mine,
        eq(creditUsageEvents.status, "refused"),
        eq(creditUsageEvents.reason, "insufficient_credit"),
        inArray(creditUsageEvents.unitId, [...new Set(unitIds)]),
      ),
    )
    .orderBy(creditUsageEvents.unitId, creditUsageEvents.id)
    .for("update");
  let capLeft = input.cap;
  for (const r of refused) {
    const row = rows.get(r.unitId);
    const offered = row ? offeredOf(row) : 0n;
    const covered = r.unitId === hold.unitId;
    if (!covered && r.unitsDue > offered) throw new CreditRefusedError("insufficient_credit");
    // In the hold's unit the event is never refused: the rest is billed in money when the
    // meter or the unit has an overage price, else it is an overshoot below zero.
    const kept = row && row.held > row.pinned ? row.held - row.pinned : 0n;
    const terms = covered
      ? await shortTerms(tx, {
          businessId: input.businessId,
          customerId: hold.customerId,
          unitId: r.unitId,
          meterId: r.meterId,
          now,
        })
      : null;
    // A capped capture: what is past the hold is recorded as a `forgiven` part.
    const due = covered && capLeft !== null && r.unitsDue > capLeft ? capLeft : r.unitsDue;
    const forgiven = r.unitsDue - due;
    if (covered && capLeft !== null) capLeft -= due;
    const take = splitEventUnits({
      due,
      offered: row ? row.available - kept : 0n,
      policy: terms?.policy.policy ?? "block",
      priced: !!terms?.price,
      floor: 0n,
      coveredByHold: covered && !!row,
    });
    // No balance row: nothing was ever granted, so there is nothing to go below.
    if (take.refused) throw new CreditRefusedError("insufficient_credit");
    const spent = take.covered + take.overdraft;
    if (row && spent > 0n) await moveRow(tx, row, { available: -spent });
    const price = take.billed > 0n ? terms!.price : null;
    // Paid at the capture, so the grants that are live now pay it.
    await tx
      .update(creditUsageEvents)
      .set({
        status: "taken",
        reason: null,
        units: take.covered,
        unitsUncovered: take.billed,
        overageBasis: price?.basis ?? null,
        overageRateE12: price?.basis === "unit" ? price.overageMinorPerUnitE12 : null,
        overagePriceId: price?.basis === "meter" ? price.priceId : null,
        coveredByHold: covered,
        receivedAt: now,
      })
      .where(eq(creditUsageEvents.id, r.id));
    if (take.overdraft > 0n)
      await tx.insert(creditUsageEvents).values({
        organizationId: r.organizationId,
        businessId: r.businessId,
        customerId: r.customerId,
        meterId: r.meterId,
        unitId: r.unitId,
        eventId: r.eventId,
        eventKey: r.eventKey,
        eventTimestamp: r.eventTimestamp,
        receivedAt: now,
        part: r.part + 1,
        quantity: "0",
        creditsPerUnit: r.creditsPerUnit,
        costSource: r.costSource,
        units: take.overdraft,
        source: "overdraft",
        status: "taken",
        coveredByHold: covered,
      });
    if (forgiven > 0n)
      await tx.insert(creditUsageEvents).values({
        organizationId: r.organizationId,
        businessId: r.businessId,
        customerId: r.customerId,
        meterId: r.meterId,
        unitId: r.unitId,
        eventId: r.eventId,
        eventKey: r.eventKey,
        eventTimestamp: r.eventTimestamp,
        receivedAt: now,
        part: r.part + (take.overdraft > 0n ? 2 : 1),
        quantity: "0",
        creditsPerUnit: r.creditsPerUnit,
        costSource: r.costSource,
        units: forgiven,
        source: "overdraft",
        status: "forgiven",
        zeroReason: "hold_cap",
        coveredByHold: covered,
      });
  }
  if (!refused.length) return own;
  // Paid now: the event counts as usage from here. The fold may have passed it.
  await tx.execute(sql`update usage_events set refused_at = null
    where business_id = ${input.businessId} and id = ${input.eventId} and refused_at is not null`);
  const { foldEventsBehindWatermark } = await import("@/modules/metering/fold");
  await foldEventsBehindWatermark(tx, input.businessId, [input.eventId]);
  return own;
}

/** The audit row of the units a capped capture did not charge (`capture_over_hold`). */
async function auditPastHold(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    hold: CreditHold;
    eventId: string;
    unitId: string;
  },
): Promise<void> {
  const [r] = rowsOf<{ units: string; unit: string; decimals: number; customer: string }>(
    await tx.execute(sql`
      select sum(c.units)::text as units, u.key as unit, u.decimals, cu.public_id as customer
      from credit_usage_events c
      join credit_units u on u.id = c.unit_id
      join customers cu on cu.id = c.customer_id
      where c.business_id = ${input.businessId} and c.event_id = ${input.eventId}
        and c.unit_id = ${input.unitId} and c.status = 'forgiven' and c.zero_reason = 'hold_cap'
      group by u.key, u.decimals, cu.public_id`),
  );
  if (!r || BigInt(r.units) <= 0n) return;
  const { recordZeroOut } = await import("./overage");
  await recordZeroOut(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    customer: r.customer,
    unit: r.unit,
    units: formatSteps(BigInt(r.units), r.decimals),
    reason: "hold_cap",
    resourceType: "credit_hold",
    resourceId: input.hold.publicId,
  });
}
