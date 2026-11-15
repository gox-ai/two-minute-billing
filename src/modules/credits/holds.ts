/**
 * Credit holds (design G3 §3.7, C5, C6): reserve an estimated cost before a call, capture the
 * real usage after it. Created under the customer-balance lock (7401) that invoice commits take,
 * so parallel holds never overspend.
 */
import { ensureCreditWindows } from "./credit-clock";
import { and, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { scanBusinessFilter, stampNow } from "@/platform/clock";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createLogger } from "@/platform/logger";
import {
  businesses,
  creditHolds,
  creditUnits,
  customers,
  meters,
  prices,
  subscriptionItems,
  subscriptions,
  type BusinessCreditConfig,
  type CustomerCreditSettings,
  type PriceGrantsCredit,
} from "@db/schema";
import { lockCustomerBalances } from "@/modules/customers/balances-read";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData, type EventType } from "@/modules/events/registry";
import { subscribedEventTypes } from "@/modules/webhooks/subscribed-types";
import { markDirtyOnIngest } from "@/modules/usage-controls/dirty";
import {
  ensureUsageMonthsFor,
  ingestUsageEventsTx,
  type EventError,
} from "@/modules/metering/ingest";
import { rowsOf, uuidMs } from "@/modules/metering/usage-sql";
import { resolveUsageKeys } from "@/modules/metering/meters";
import { liveBalance, loadBalanceSnapshot } from "./balance";
import {
  ACCESS_MESSAGES,
  CREDIT_CONFIG_DEFAULTS,
  effectivePolicy,
  inFlightRefused,
  MAX_HOLD_SECONDS,
  type AccessCode,
  type EffectivePolicy,
} from "./policy";
import { formatSteps } from "./units";
import { LIVE_SUBSCRIPTION_STATUSES, ratedUnbilledUsage } from "./usage";

const log = createLogger("credits.holds");

export type CreditHold = typeof creditHolds.$inferSelect;

/** A refusal with a stable code: 402 at the API. */
export class CreditRefusedError extends Error {
  constructor(
    readonly code: Exclude<AccessCode, "ok">,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(ACCESS_MESSAGES[code]);
    this.name = "CreditRefusedError";
  }
}

/** Capture or release of a hold that is no longer held: 409 with the current status. */
export class HoldFinalError extends Error {
  constructor(readonly status: string) {
    super(`We could not change the hold. Its status is ${status}.`);
    this.name = "HoldFinalError";
  }
}

export class HoldInputError extends Error {
  constructor(
    message: string,
    readonly code: string = "invalid_request",
  ) {
    super(message);
    this.name = "HoldInputError";
  }
}

export interface CreditContext {
  business: {
    id: string;
    creditConfig: BusinessCreditConfig | null;
    defaultCurrency: string | null;
  };
  customer: {
    id: string;
    publicId: string;
    currency: string | null;
    creditSettings: CustomerCreditSettings | null;
  };
}

export async function loadCreditContext(
  tx: Tx,
  businessId: string,
  customerId: string,
): Promise<CreditContext | null> {
  const [row] = await tx
    .select({
      bizId: businesses.id,
      creditConfig: businesses.creditConfig,
      defaultCurrency: businesses.defaultCurrency,
      custId: customers.id,
      custPublicId: customers.publicId,
      custCurrency: customers.currency,
      creditSettings: customers.creditSettings,
    })
    .from(customers)
    .innerJoin(businesses, eq(businesses.id, customers.businessId))
    .where(and(eq(customers.id, customerId), eq(customers.businessId, businessId)))
    .limit(1);
  if (!row) return null;
  return {
    business: {
      id: row.bizId,
      creditConfig: row.creditConfig ?? null,
      defaultCurrency: row.defaultCurrency ?? null,
    },
    customer: {
      id: row.custId,
      publicId: row.custPublicId,
      currency: row.custCurrency ?? null,
      creditSettings: row.creditSettings ?? null,
    },
  };
}

/** `grants_credit` of the customer's live recurring prices, the meter's subscription first. */
export async function livePlanCredits(
  tx: Tx,
  customerId: string,
  firstSubscriptionId: string | null,
): Promise<Array<PriceGrantsCredit | null>> {
  const rows = await tx
    .select({ subId: subscriptions.id, gc: prices.grantsCredit })
    .from(subscriptionItems)
    .innerJoin(subscriptions, eq(subscriptionItems.subscriptionId, subscriptions.id))
    .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .where(
      and(
        eq(subscriptions.customerId, customerId),
        inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
        sql`${prices.grantsCredit} is not null`,
      ),
    );
  rows.sort(
    (a, b) => Number(b.subId === firstSubscriptionId) - Number(a.subId === firstSubscriptionId),
  );
  return rows.map((r) => r.gc ?? null);
}

/**
 * A hold changed the customer's balance: mark it for the usage-controls check, whatever the
 * webhook subscriptions are (C5 governs webhooks only).
 */
export async function markHoldChanged(
  tx: Tx,
  businessId: string,
  customerIds: string[],
): Promise<void> {
  await markDirtyOnIngest(tx, { businessId, customerIds });
}

/** Write a hold event only when an enabled endpoint lists the type explicitly (C5). */
export async function emitHoldEvent(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    type: Extract<EventType, `credit_hold_${string}`>;
    hold: CreditHold;
    refs: HoldRefs;
  },
): Promise<boolean> {
  const listened = await subscribedEventTypes(tx, input.organizationId);
  if (!listened.has(input.type)) return false;
  await emitEvent(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    type: input.type,
    data: buildEventData(
      input.type,
      serializeHold(input.hold, input.refs),
      input.hold.resourceVersion,
    ),
  });
  return true;
}

export interface HoldRefs {
  customer: string;
  meter: string | null;
  /** Set for a hold in units. */
  unit?: { key: string; decimals: number } | null;
}

export function serializeHold(h: CreditHold, refs: HoldRefs) {
  const unit = h.unitId ? (refs.unit ?? null) : null;
  const credits = (v: bigint | null) => (unit && v != null ? formatSteps(v, unit.decimals) : null);
  return {
    object: "credit_hold" as const,
    id: h.publicId,
    customer: refs.customer,
    currency: h.currency,
    // 0 for a hold in units.
    amount_minor: Number(h.amountMinor),
    unit: unit?.key ?? null,
    units: credits(h.amountUnits),
    // What the hold still reserves: less than `units` once a step of a lease is captured.
    remaining_units: credits(h.remainingUnits),
    captured_units: credits(h.capturedUnits),
    meter: refs.meter,
    scope: h.scope ?? null,
    status: h.status,
    expires_at: h.expiresAt.toISOString(),
    captured_minor: h.capturedMinor != null ? Number(h.capturedMinor) : null,
    overdraft: h.overdraft,
    metadata: h.metadata ?? null,
    created_at: h.createdAt.toISOString(),
    updated_at: h.updatedAt.toISOString(),
  };
}

const scopeIssue = (scope: Record<string, unknown> | null | undefined): string | null => {
  if (scope == null) return null;
  const keys = Object.keys(scope);
  if (keys.length > 10) return "scope may have at most 10 keys.";
  for (const k of keys) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) return `scope key ${k} is not valid.`;
    const v = scope[k];
    if (typeof v !== "string" || v.length > 255)
      return `scope.${k} must be a string of at most 255 characters.`;
  }
  return null;
};

/** The hold's currency: the request's, else the meter subscription's, else the customer's. */
async function holdCurrency(
  tx: Tx,
  ctx: CreditContext,
  meterId: string | null,
  requested: string | undefined,
): Promise<string> {
  if (requested) return requested.toUpperCase();
  if (meterId) {
    const [s] = await tx
      .select({ currency: subscriptions.currency })
      .from(subscriptionItems)
      .innerJoin(subscriptions, eq(subscriptionItems.subscriptionId, subscriptions.id))
      .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
      .where(
        and(
          eq(subscriptions.customerId, ctx.customer.id),
          inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
          eq(prices.meterId, meterId),
        ),
      )
      .limit(1);
    if (s) return s.currency;
  }
  const cur = ctx.customer.currency ?? ctx.business.defaultCurrency;
  if (!cur) throw new HoldInputError("We could not create the hold. Send a currency.");
  return cur.toUpperCase();
}

export async function resolveMeter(
  tx: Tx,
  businessId: string,
  key: string,
): Promise<{ id: string; key: string } | null> {
  const [m] = await tx
    .select({ id: meters.id, key: meters.key })
    .from(meters)
    .where(and(eq(meters.businessId, businessId), eq(meters.key, key)))
    .limit(1);
  return m ?? null;
}

/**
 * Create a hold (§3.7). Refuses with `in_flight_limit` or `insufficient_credit` under the
 * `block` policy only; with `bill` the overage bills on the next invoice, so a hold only records.
 * A meter with a credit cost takes a hold in units (`quantity` or `units`; `unit-holds.ts`).
 */
export async function createCreditHold(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  amountMinor?: bigint | null;
  /** A meter with a credit cost: the meter quantity the work will use, or the credits. */
  quantity?: string | null;
  units?: string | null;
  currency?: string;
  meterKey?: string | null;
  scope?: Record<string, string> | null;
  expiresInSeconds?: number;
  metadata?: Record<string, unknown> | null;
}): Promise<{ hold: CreditHold; policy: EffectivePolicy; refs: HoldRefs }> {
  if (input.amountMinor != null && input.amountMinor <= 0n)
    throw new HoldInputError("We could not create the hold. amount_minor must be more than 0.");
  const issue = scopeIssue(input.scope);
  if (issue) throw new HoldInputError(`We could not create the hold. ${issue}`);
  return withTenant(input.organizationId, async (tx) => {
    const ctx = await loadCreditContext(tx, input.businessId, input.customerId);
    if (!ctx) throw new HoldInputError("No such customer", "not_found");
    const meter = input.meterKey ? await resolveMeter(tx, input.businessId, input.meterKey) : null;
    if (input.meterKey && !meter)
      throw new HoldInputError(`No such meter: ${input.meterKey}`, "not_found");
    const cfg = ctx.business.creditConfig ?? {};
    const ttl =
      input.expiresInSeconds ??
      cfg.hold_default_seconds ??
      CREDIT_CONFIG_DEFAULTS.hold_default_seconds;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_HOLD_SECONDS)
      throw new HoldInputError(
        `We could not create the hold. expires_in must be a whole number of seconds from 1 to ${MAX_HOLD_SECONDS}.`,
      );
    const inUnits = input.quantity != null || input.units != null;
    const unitHolds = meter || inUnits ? await import("./unit-holds") : null;
    const cost = meter
      ? await unitHolds!.meterCreditCostFor(tx, { meterId: meter.id, customerId: ctx.customer.id })
      : null;
    if (cost) {
      // The meter is paid in credits: the hold reserves units.
      if (input.amountMinor != null || (input.quantity != null) === (input.units != null))
        throw new HoldInputError(
          "We could not create the hold. This meter is paid in credits. Send quantity or units, not both, and no amount_minor.",
        );
      const units = unitHolds!.requestedSteps(cost, input);
      if (units === null || units <= 0n)
        throw new HoldInputError(
          `We could not create the hold. ${input.units != null ? "units" : "quantity"} must be a number that costs 1 or more of the smallest part of a ${cost.unitKey}.`,
        );
      const made = await unitHolds!.createUnitHold(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        ctx,
        meter: meter!,
        cost,
        units,
        ttlSeconds: ttl,
        scope: input.scope ?? null,
        metadata: input.metadata ?? null,
      });
      const unitRefs: HoldRefs = {
        customer: ctx.customer.publicId,
        meter: meter!.key,
        unit: { key: cost.unitKey, decimals: cost.decimals },
      };
      await markHoldChanged(tx, input.businessId, [made.hold.customerId]);
      await emitHoldEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "credit_hold_created",
        hold: made.hold,
        refs: unitRefs,
      });
      return { ...made, refs: unitRefs };
    }
    if (inUnits)
      throw new HoldInputError(
        "We could not create the hold. quantity and units are for a meter that is paid in credits. Send amount_minor.",
      );
    if (input.amountMinor == null)
      throw new HoldInputError("We could not create the hold. Send amount_minor.");
    const amountMinor = input.amountMinor;
    const currency = await holdCurrency(tx, ctx, meter?.id ?? null, input.currency);

    // Serialize with every other read-then-draw of this customer's credit.
    await lockCustomerBalances(tx, ctx.customer.id);
    const now = stampNow(input.businessId);
    await ensureCreditWindows(tx, { customerId: ctx.customer.id, now });
    const snap = await loadBalanceSnapshot(tx, { customerId: ctx.customer.id, currency, now });
    const meterItems = meter
      ? await tx
          .select({ priceId: prices.publicId, subId: subscriptions.id })
          .from(subscriptionItems)
          .innerJoin(subscriptions, eq(subscriptionItems.subscriptionId, subscriptions.id))
          .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
          .where(
            and(
              eq(subscriptions.customerId, ctx.customer.id),
              inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
              eq(prices.meterId, meter.id),
            ),
          )
      : [];
    const policy = effectivePolicy({
      businessConfig: ctx.business.creditConfig,
      customerSettings: ctx.customer.creditSettings,
      now,
      grants: snap.grants,
      meterPriceIds: meter ? meterItems.map((i) => i.priceId) : null,
      planCredits: await livePlanCredits(tx, ctx.customer.id, meterItems[0]?.subId ?? null),
    });
    if (policy.policy === "block") {
      const bal = await liveBalance(tx, {
        customerId: ctx.customer.id,
        currency,
        now,
        businessConfig: ctx.business.creditConfig,
        customerSettings: ctx.customer.creditSettings,
        snapshot: snap,
        rateUsage: true,
      });
      // The in-flight base is what may be spent before holds: the overdraft room included.
      const before = bal.availableMinor + bal.openHoldsMinor;
      if (
        inFlightRefused({
          balanceBeforeHoldsMinor: before,
          openHoldsMinor: bal.openHoldsMinor,
          amountMinor,
          shareBps: cfg.in_flight_share_bps ?? CREDIT_CONFIG_DEFAULTS.in_flight_share_bps,
          applies: cfg.in_flight_applies,
        })
      )
        throw new CreditRefusedError("in_flight_limit", {
          balance_minor: Number(before),
          open_holds_minor: Number(bal.openHoldsMinor),
        });
      if (amountMinor > bal.availableMinor)
        throw new CreditRefusedError("insufficient_credit", {
          available_minor: Number(bal.availableMinor),
        });
    }
    const [hold] = await tx
      .insert(creditHolds)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        publicId: publicId("chd"),
        customerId: ctx.customer.id,
        currency,
        amountMinor,
        meterId: meter?.id ?? null,
        scope: input.scope ?? null,
        status: "held",
        expiresAt: new Date(now.getTime() + ttl * 1000),
        metadata: input.metadata ?? null,
      })
      .returning();
    const refs: HoldRefs = { customer: ctx.customer.publicId, meter: meter?.key ?? null };
    await markHoldChanged(tx, input.businessId, [hold!.customerId]);
    await emitHoldEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "credit_hold_created",
      hold: hold!,
      refs,
    });
    return { hold: hold!, policy, refs };
  });
}

async function lockHold(tx: Tx, businessId: string, holdPublicId: string): Promise<CreditHold> {
  const [h] = rowsOf<{ id: string; customer_id: string }>(
    await tx.execute(sql`select id, customer_id from credit_holds
      where business_id = ${businessId} and public_id = ${holdPublicId}`),
  );
  if (!h) throw new HoldInputError(`No such credit hold: ${holdPublicId}`, "not_found");
  // Same order as create: the customer lock, then the row.
  await lockCustomerBalances(tx, h.customer_id);
  const [row] = await tx
    .select()
    .from(creditHolds)
    .where(eq(creditHolds.id, h.id))
    .for("update")
    .limit(1);
  return row!;
}

export async function refsOf(tx: Tx, hold: CreditHold): Promise<HoldRefs> {
  const [c] = await tx
    .select({ publicId: customers.publicId })
    .from(customers)
    .where(eq(customers.id, hold.customerId))
    .limit(1);
  const [m] = hold.meterId
    ? await tx.select({ key: meters.key }).from(meters).where(eq(meters.id, hold.meterId)).limit(1)
    : [];
  const [u] = hold.unitId
    ? await tx
        .select({ key: creditUnits.key, decimals: creditUnits.decimals })
        .from(creditUnits)
        .where(eq(creditUnits.id, hold.unitId))
        .limit(1)
    : [];
  return { customer: c?.publicId ?? "", meter: m?.key ?? null, unit: u ?? null };
}

/** A held row past its time is final: flip it and refuse. */
async function assertHeld(tx: Tx, hold: CreditHold, now: Date): Promise<void> {
  if (hold.status !== "held") throw new HoldFinalError(hold.status);
  if (hold.expiresAt.getTime() <= now.getTime()) {
    await tx.update(creditHolds).set({ status: "expired" }).where(eq(creditHolds.id, hold.id));
    throw new HoldFinalError("expired");
  }
}

export class CaptureEventError extends Error {
  constructor(readonly error: EventError | { code: string; message: string }) {
    super(error.message);
    this.name = "CaptureEventError";
  }
}

/**
 * Capture a hold with the real usage (§3.7): the event is ingested in this transaction and
 * `captured_minor` is the money it adds. The hold stops counting and the event starts counting
 * in one commit. More than the hold is accepted; past the overdraft limit it is flagged.
 * A hold in units gives its units back and the event takes its own (`captureUnitHold`);
 * `overdraft` then says that the event cost more than the balance had.
 * A money hold does not cover an event of a meter that is paid in credits: the gate decides it.
 */
export async function captureCreditHold(input: {
  organizationId: string;
  businessId: string;
  holdPublicId: string;
  usageEvent?: unknown;
  usageEventKey?: string;
  /** False: a step of a lease. The hold stays open with what the event did not use. */
  final?: boolean;
}): Promise<{ hold: CreditHold; refs: HoldRefs }> {
  if ((input.usageEvent == null) === (input.usageEventKey == null))
    throw new HoldInputError(
      "We could not capture the hold. Send usage_event or usage_event_id, not both.",
    );
  if (input.usageEvent != null) await ensureUsageMonthsFor(input.businessId, [input.usageEvent]);
  return withTenant(input.organizationId, async (tx) => {
    // A hold in units may pay an event the gate refused, which then enters the usage totals:
    // the fold's lock comes first, as in an event void.
    if (input.usageEventKey != null) {
      const [refused] = rowsOf<{ x: number }>(
        await tx.execute(sql`
          select 1 as x from usage_event_dedup d
          join usage_events e on e.id = d.event_id and e."timestamp" = d.event_timestamp
          join credit_holds h on h.business_id = d.business_id and h.public_id = ${input.holdPublicId}
          where d.business_id = ${input.businessId} and d.key = ${input.usageEventKey}
            and e.refused_at is not null and h.unit_id is not null`),
      );
      if (refused)
        await tx.execute(sql`select 1 from usage_rollup_state
          where business_id = ${input.businessId} for update`);
    }
    const hold = await lockHold(tx, input.businessId, input.holdPublicId);
    const now = stampNow(input.businessId);
    await assertHeld(tx, hold, now);
    if (hold.unitId) {
      const { captureUnitHold } = await import("./unit-holds");
      const r = await captureUnitHold(tx, { ...input, hold, now, final: input.final !== false });
      // A step that leaves nothing reserved closes the hold.
      const open = r.remainingUnits > 0n;
      const [done] = await tx
        .update(creditHolds)
        .set({
          ...(open ? {} : { status: "captured", capturedMinor: 0n }),
          remainingUnits: r.remainingUnits,
          capturedUnits: (hold.capturedUnits ?? 0n) + r.capturedUnits,
          usageEventId: r.eventId,
          overdraft: hold.overdraft || r.uncoveredUnits > 0n,
        })
        .where(eq(creditHolds.id, hold.id))
        .returning();
      const refs = await refsOf(tx, done!);
      await markHoldChanged(tx, input.businessId, [done!.customerId]);
      await emitHoldEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "credit_hold_captured",
        hold: done!,
        refs,
      });
      return { hold: done!, refs };
    }
    if (input.final === false)
      throw new HoldInputError(
        "We could not capture the hold. final: false is for a hold in units. A hold in money is captured one time.",
      );
    const rate = (cutoffAt?: Date) =>
      ratedUnbilledUsage(tx, {
        customerId: hold.customerId,
        currency: hold.currency,
        // Past any accepted event timestamp (≤ 5 minutes ahead), so the new event is inside.
        asOf: new Date(now.getTime() + 10 * 60_000),
        ...(hold.meterId ? { meterId: hold.meterId } : {}),
        ...(cutoffAt ? { cutoffAt } : {}),
      }).then((ls) => ls.reduce((a, l) => a + l.amountMinor, 0n));

    let capturedMinor: bigint;
    let eventId: string;
    if (input.usageEvent != null) {
      const ev = input.usageEvent as { customer?: unknown; key?: unknown };
      const owner = await customerForUsageKey(tx, input.businessId, ev.customer);
      if (owner !== hold.customerId)
        throw new CaptureEventError({
          code: "invalid_request",
          message: "We could not capture the hold. The usage event is for a different customer.",
        });
      const before = await rate();
      const [r] = await ingestUsageEventsTx(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        events: [input.usageEvent],
      });
      // A meter paid in credits refused the event: nothing is stored, the hold stays open.
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
      const after = await rate();
      capturedMinor = after > before ? after - before : 0n;
    } else {
      const [d] = rowsOf<{ event_id: string; customer_id: string | null }>(
        await tx.execute(sql`select d.event_id, e.customer_id from usage_event_dedup d
          join usage_events e on e.id = d.event_id and e."timestamp" = d.event_timestamp
          where d.business_id = ${input.businessId} and d.key = ${input.usageEventKey}`),
      );
      if (!d) throw new HoldInputError(`No such usage event: ${input.usageEventKey}`, "not_found");
      if (d.customer_id !== hold.customerId)
        throw new CaptureEventError({
          code: "invalid_request",
          message: "We could not capture the hold. The usage event is for a different customer.",
        });
      // The money it added = usage received through its millisecond less usage before it.
      const ms = uuidMs(d.event_id);
      const [st] = rowsOf<{ watermark: Date | null }>(
        await tx.execute(
          sql`select watermark from usage_rollup_state where business_id = ${input.businessId}`,
        ),
      );
      if (st?.watermark && new Date(st.watermark).getTime() > ms)
        throw new CaptureEventError({
          code: "event_folded",
          message:
            "We could not capture the hold. The usage event is already in the usage totals. Send the event in the capture request.",
        });
      eventId = d.event_id;
      const after = await rate(new Date(ms + 1));
      const before = await rate(new Date(ms));
      capturedMinor = after > before ? after - before : 0n;
    }

    // Overdraft: the balance after this capture, with the hold no longer counting.
    const ctx = (await loadCreditContext(tx, input.businessId, hold.customerId))!;
    await tx
      .update(creditHolds)
      .set({ status: "captured", capturedMinor, usageEventId: eventId })
      .where(eq(creditHolds.id, hold.id));
    const bal = await liveBalance(tx, {
      customerId: hold.customerId,
      currency: hold.currency,
      now,
      businessConfig: ctx.business.creditConfig,
      customerSettings: ctx.customer.creditSettings,
      rateUsage: true,
      usageAsOf: new Date(now.getTime() + 10 * 60_000),
    });
    const overdraft = bal.availableMinor < 0n;
    const [done] = await tx
      .update(creditHolds)
      .set({ overdraft })
      .where(eq(creditHolds.id, hold.id))
      .returning();
    const refs = await refsOf(tx, done!);
    await markHoldChanged(tx, input.businessId, [done!.customerId]);
    await emitHoldEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "credit_hold_captured",
      hold: done!,
      refs,
    });
    return { hold: done!, refs };
  });
}

async function customerForUsageKey(
  tx: Tx,
  businessId: string,
  key: unknown,
): Promise<string | null> {
  if (typeof key !== "string") return null;
  return (await resolveUsageKeys(tx, businessId, [key])).get(key) ?? null;
}

export async function releaseCreditHold(input: {
  organizationId: string;
  businessId: string;
  holdPublicId: string;
}): Promise<{ hold: CreditHold; refs: HoldRefs }> {
  return withTenant(input.organizationId, async (tx) => {
    const hold = await lockHold(tx, input.businessId, input.holdPublicId);
    await assertHeld(tx, hold, stampNow(input.businessId));
    if (hold.unitId) await (await import("./unit-holds")).returnHeldUnits(tx, hold);
    const [done] = await tx
      .update(creditHolds)
      .set({ status: "released", ...(hold.unitId ? { remainingUnits: 0n } : {}) })
      .where(eq(creditHolds.id, hold.id))
      .returning();
    const refs = await refsOf(tx, done!);
    await markHoldChanged(tx, input.businessId, [done!.customerId]);
    await emitHoldEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "credit_hold_released",
      hold: done!,
      refs,
    });
    return { hold: done!, refs };
  });
}

/**
 * Move a hold's expiry later (a lease that runs long): `expires_in` seconds from now, up to
 * the maximum hold time. Never earlier than it is, never more units. A hold in units only.
 */
export async function extendCreditHold(input: {
  organizationId: string;
  businessId: string;
  holdPublicId: string;
  expiresInSeconds: number;
}): Promise<{ hold: CreditHold; refs: HoldRefs }> {
  const ttl = input.expiresInSeconds;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_HOLD_SECONDS)
    throw new HoldInputError(
      `We could not extend the hold. expires_in must be a whole number of seconds from 1 to ${MAX_HOLD_SECONDS}.`,
    );
  return withTenant(input.organizationId, async (tx) => {
    const hold = await lockHold(tx, input.businessId, input.holdPublicId);
    const now = stampNow(input.businessId);
    await assertHeld(tx, hold, now);
    if (!hold.unitId)
      throw new HoldInputError(
        "We could not extend the hold. Only a hold in units can be extended.",
      );
    const expiresAt = new Date(now.getTime() + ttl * 1000);
    if (expiresAt.getTime() <= hold.expiresAt.getTime())
      throw new HoldInputError(
        "We could not extend the hold. The new expiry must be later than the current expiry.",
      );
    const [done] = await tx
      .update(creditHolds)
      .set({ expiresAt })
      .where(eq(creditHolds.id, hold.id))
      .returning();
    // A closed grant that keeps units for the hold keeps them as long as the hold is open.
    await tx.execute(sql`
      update credit_grant_grace set locks_at = ${expiresAt.toISOString()}::timestamptz
      where customer_id = ${hold.customerId} and unit_id = ${hold.unitId}
        and locked_at is null and held_steps > 0
        and locks_at < ${expiresAt.toISOString()}::timestamptz`);
    return { hold: done!, refs: await refsOf(tx, done!) };
  });
}

export async function getCreditHold(
  tx: Tx,
  businessId: string,
  holdPublicId: string,
): Promise<{ hold: CreditHold; refs: HoldRefs } | null> {
  const [h] = await tx
    .select()
    .from(creditHolds)
    .where(and(eq(creditHolds.businessId, businessId), eq(creditHolds.publicId, holdPublicId)))
    .limit(1);
  if (!h) return null;
  return { hold: h, refs: await refsOf(tx, h) };
}

/** Newest first, keyset on id. */
export async function listCreditHolds(
  tx: Tx,
  input: {
    businessId: string;
    customerId?: string;
    status?: string;
    limit: number;
    startingAfter?: string;
  },
): Promise<{ data: Array<ReturnType<typeof serializeHold>>; hasMore: boolean }> {
  let afterId: string | null = null;
  if (input.startingAfter) {
    const [a] = await tx
      .select({ id: creditHolds.id })
      .from(creditHolds)
      .where(
        and(
          eq(creditHolds.businessId, input.businessId),
          eq(creditHolds.publicId, input.startingAfter),
        ),
      )
      .limit(1);
    afterId = a?.id ?? null;
  }
  const rows = (await tx.execute(sql`
    select h.*, c.public_id as customer_public_id, m.key as meter_key,
      u.key as unit_key, u.decimals as unit_decimals
    from credit_holds h
    join customers c on c.id = h.customer_id
    left join meters m on m.id = h.meter_id
    left join credit_units u on u.id = h.unit_id
    where h.business_id = ${input.businessId}
      ${input.customerId ? sql`and h.customer_id = ${input.customerId}` : sql``}
      ${input.status ? sql`and h.status = ${input.status}` : sql``}
      ${afterId ? sql`and h.id < ${afterId}` : sql``}
    order by h.id desc
    limit ${input.limit + 1}`)) as unknown as Array<Record<string, unknown>>;
  const page = rows.slice(0, input.limit);
  return {
    hasMore: rows.length > input.limit,
    data: page.map((r) =>
      serializeHold(
        {
          id: r.id as string,
          organizationId: r.organization_id as string,
          businessId: r.business_id as string,
          publicId: r.public_id as string,
          customerId: r.customer_id as string,
          currency: r.currency as string,
          amountMinor: BigInt(r.amount_minor as string),
          unitId: (r.unit_id as string | null) ?? null,
          amountUnits: r.amount_units != null ? BigInt(r.amount_units as string) : null,
          capturedUnits: r.captured_units != null ? BigInt(r.captured_units as string) : null,
          remainingUnits: r.remaining_units != null ? BigInt(r.remaining_units as string) : null,
          meterId: (r.meter_id as string | null) ?? null,
          scope: (r.scope as Record<string, string> | null) ?? null,
          status: r.status as string,
          expiresAt: new Date(r.expires_at as string),
          capturedMinor: r.captured_minor != null ? BigInt(r.captured_minor as string) : null,
          usageEventId: (r.usage_event_id as string | null) ?? null,
          overdraft: r.overdraft === true,
          metadata: (r.metadata as Record<string, unknown> | null) ?? null,
          createdAt: new Date(r.created_at as string),
          updatedAt: new Date(r.updated_at as string),
          resourceVersion: Number(r.resource_version),
        },
        {
          customer: r.customer_public_id as string,
          meter: (r.meter_key as string | null) ?? null,
          unit:
            r.unit_key != null
              ? { key: r.unit_key as string, decimals: Number(r.unit_decimals) }
              : null,
        },
      ),
    ),
  };
}

/**
 * The `expire_credit_holds` pass: held rows past their time become `expired`. A hold in units
 * gives its units back under the customer lock (`expireLapsedUnitHolds`).
 */
export async function expireCreditHolds(now: Date): Promise<{ expired: number }> {
  // systemDb: the pass finds lapsed holds across organizations; each expires under withTenant.
  const scope = scanBusinessFilter(creditHolds.businessId);
  const lapsed = and(eq(creditHolds.status, "held"), lte(creditHolds.expiresAt, now), scope);
  let expired = 0;
  const inUnits = await systemDb
    .selectDistinct({
      organizationId: creditHolds.organizationId,
      customerId: creditHolds.customerId,
      unitId: creditHolds.unitId,
    })
    .from(creditHolds)
    .where(and(lapsed, isNotNull(creditHolds.unitId)));
  for (const u of inUnits) {
    try {
      expired += await withTenant(u.organizationId, async (tx) => {
        await lockCustomerBalances(tx, u.customerId);
        const { expireLapsedUnitHolds } = await import("./unit-holds");
        const rows = await expireLapsedUnitHolds(tx, {
          customerId: u.customerId,
          unitId: u.unitId!,
          now,
        });
        return rows.length;
      });
    } catch (e) {
      log.error(e, { event: "credit_unit_holds_expire_failed", customerId: u.customerId });
    }
  }
  const due = await systemDb
    .selectDistinct({ organization_id: creditHolds.organizationId })
    .from(creditHolds)
    .where(and(lapsed, isNull(creditHolds.unitId)));
  for (const { organization_id: org } of due) {
    try {
      expired += await withTenant(org, async (tx) => {
        const rows = await tx
          .update(creditHolds)
          .set({ status: "expired" })
          .where(and(lapsed, isNull(creditHolds.unitId)))
          .returning();
        for (const b of new Set(rows.map((h) => h.businessId)))
          await markHoldChanged(
            tx,
            b,
            rows.filter((h) => h.businessId === b).map((h) => h.customerId),
          );
        if (rows.length && (await subscribedEventTypes(tx, org)).has("credit_hold_expired")) {
          for (const h of rows) {
            const refs = await refsOf(tx, h);
            await emitHoldEvent(tx, {
              organizationId: org,
              businessId: h.businessId,
              type: "credit_hold_expired",
              hold: h,
              refs,
            });
          }
        }
        return rows.length;
      });
    } catch (e) {
      log.error(e, { event: "credit_holds_expire_failed", organizationId: org });
    }
  }
  return { expired };
}
