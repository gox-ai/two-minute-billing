/**
 * Usage alerts (design G5 §3.4): usage, spend, credit balance and credit runway, per customer
 * or per plan. Each threshold fires once per subject and period (`usage_alert_states`,
 * unique), resolves on recovery or at period end, and its state is readable per threshold.
 * Alerts never block or charge.
 */
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { stampNow } from "@/platform/clock";
import { emitEvent } from "@/modules/events/emit";
import {
  creditUnits,
  customers,
  meters,
  prices,
  products,
  subscriptionItems,
  subscriptions,
  usageAlertObservations,
  usageAlerts,
  usageAlertStates,
  type UsageAlertKind,
  type UsageAlertThreshold,
  type UsageControlInterval,
} from "@db/schema";
import { FIXED12_SCALE, formatFixed12, parseFixed12 } from "@/platform/fixed";
import { meterFeature } from "@/modules/credits/access";
import { liveMeteredItems } from "@/modules/credits/usage";
import { markDirty, setUsageControlsActive } from "./dirty";
import {
  businessTimeZone,
  calendarWindow,
  measureBalance,
  measureQuantity,
  measureRunway,
  measureSpend,
  newRateCache,
  periodWindow,
  type RateCache,
  type Window,
} from "./measure";
import {
  loadCustomerLimits,
  resolveApplicable,
  UsageControlConflictError,
  UsageControlNotFoundError,
  UsageControlRuleError,
} from "./limits";

export type UsageAlert = typeof usageAlerts.$inferSelect;
export type UsageAlertState = typeof usageAlertStates.$inferSelect;

const FALLING: ReadonlySet<UsageAlertKind> = new Set(["credit_balance", "credit_runway"]);
const UNITS_BY_KIND: Record<UsageAlertKind, ReadonlyArray<UsageAlertThreshold["unit"]>> = {
  usage_quantity: ["units", "percent"],
  spend: ["minor", "percent"],
  credit_balance: ["minor", "units", "percent"],
  credit_runway: ["days"],
};

// ── Crossing (pure) ──────────────────────────────────────────────────────────────────

/**
 * Thresholds a move from `prev` to `cur` crosses. Rising: every t with prev < t ≤ cur;
 * falling: every t with cur ≤ t < prev. `prev` null = first observation (rising from 0,
 * falling from +∞). One jump crosses every threshold it passes.
 */
export function crossed(
  thresholds: bigint[],
  prev: bigint | null,
  cur: bigint,
  falling: boolean,
): bigint[] {
  return thresholds.filter((t) =>
    falling ? cur <= t && (prev === null || t < prev) : (prev === null ? 0n : prev) < t && t <= cur,
  );
}

/** In-alarm thresholds the current value has moved back across. */
export function recovered(inAlarm: bigint[], cur: bigint, falling: boolean): bigint[] {
  return inAlarm.filter((t) => (falling ? cur > t : cur < t));
}

// ── Values ───────────────────────────────────────────────────────────────────────────

/** Values are compared as Fixed12 so units, money and days share one scale. */
const fx = (n: bigint) => n * FIXED12_SCALE;
const fromNumber = (v: number) => parseFixed12(String(v));

export interface Subject {
  key: string;
  customerId: string;
  subscriptionId: string | null;
}

interface Observed {
  /** Fixed12. */
  value: bigint;
  periodKey: Date;
  resetsAt: Date;
  /** Fixed12 reference for percent thresholds; null = none. */
  reference: bigint | null;
}

async function subjectWindow(
  tx: Tx,
  a: UsageAlert,
  s: Subject,
  now: Date,
  tz: string,
): Promise<Window | null> {
  if (a.kind === "credit_balance" || a.kind === "credit_runway")
    return calendarWindow("month", now, tz);
  if (a.interval !== "period")
    return calendarWindow(a.interval as Exclude<UsageControlInterval, "period">, now, tz);
  const subs = await tx
    .select({ s: subscriptions.currentPeriodStart, e: subscriptions.currentPeriodEnd })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.customerId, s.customerId),
        s.subscriptionId ? eq(subscriptions.id, s.subscriptionId) : undefined,
        inArray(subscriptions.status, ["active", "in_trial"]),
      ),
    )
    .orderBy(asc(subscriptions.currentPeriodEnd));
  for (const r of subs) {
    const w = periodWindow({ currentPeriodStart: r.s, currentPeriodEnd: r.e });
    if (w) return w;
  }
  return null;
}

/** The spend limit a % spend alert refers to: operator hard, else any, for the interval. */
async function spendReference(tx: Tx, a: UsageAlert, s: Subject): Promise<bigint | null> {
  const loaded = await loadCustomerLimits(tx, s.customerId, { currency: a.currency! });
  const { applicable } = resolveApplicable(loaded, {
    meterId: a.meterId,
    subscriptionIds: s.subscriptionId ? [s.subscriptionId] : null,
    scope: null,
    currency: a.currency!,
  });
  const forInterval = applicable.filter(
    (l) =>
      l.interval === a.interval &&
      (l.scope === "customer" ||
        (l.scope === "subscription" && l.subscriptionId === s.subscriptionId)),
  );
  const pick =
    forInterval.find((l) => l.mode === "hard" && l.setBy === "operator") ??
    forInterval.find((l) => l.mode === "hard") ??
    forInterval[0];
  return pick ? pick.amountMinor : null;
}

/** The meter feature's numeric entitlement limit (PR 2), for % usage alerts. */
async function usageReference(tx: Tx, a: UsageAlert, s: Subject): Promise<bigint | null> {
  if (!a.meterId) return null;
  let subId = s.subscriptionId;
  if (!subId) {
    const items = await liveMeteredItems(tx, { customerId: s.customerId, meterId: a.meterId });
    subId = items[0]?.sub.id ?? null;
  }
  if (!subId) return null;
  const f = await meterFeature(tx, subId, a.meterId);
  if (!f?.value || f.value === "unlimited" || f.type === "switch") return null;
  const n = Number.parseInt(f.value, 10);
  return Number.isFinite(n) ? BigInt(n) : null;
}

/** Measure an alert's value for one subject now. null = nothing to measure (no usage yet, no runway). */
export async function observe(
  tx: Tx,
  a: UsageAlert,
  s: Subject,
  ctx: { now: Date; tz: string; cache: RateCache },
): Promise<Observed | null> {
  const w = await subjectWindow(tx, a, s, ctx.now, ctx.tz);
  if (!w) return null;
  const to = new Date(Math.min(ctx.now.getTime(), w.end.getTime()));
  switch (a.kind) {
    case "usage_quantity": {
      const q = await measureQuantity(tx, {
        customerId: s.customerId,
        meterId: a.meterId!,
        from: w.start,
        to,
      });
      const ref = await usageReference(tx, a, s);
      return {
        value: q,
        periodKey: w.start,
        resetsAt: w.end,
        reference: ref == null ? null : fx(ref),
      };
    }
    case "spend": {
      const m = await measureSpend(
        tx,
        {
          businessId: a.businessId,
          customerId: s.customerId,
          currency: a.currency!,
          interval: a.interval!,
          now: ctx.now,
          tz: ctx.tz,
          meterIds: a.meterId ? [a.meterId] : null,
          subscriptionId: s.subscriptionId,
        },
        { cache: ctx.cache },
      );
      const ref = await spendReference(tx, a, s);
      return {
        value: fx(m.amountMinor),
        periodKey: w.start,
        resetsAt: m.resetsAt,
        reference: ref == null ? null : fx(ref),
      };
    }
    case "credit_balance": {
      const b = await measureBalance(tx, {
        customerId: s.customerId,
        currency: a.currency!,
        unitId: a.unitId,
        now: ctx.now,
      });
      return {
        value: fx(b.value),
        periodKey: w.start,
        resetsAt: w.end,
        reference: fx(b.grantedTotal),
      };
    }
    case "credit_runway": {
      const r = await measureRunway(tx, {
        businessId: a.businessId,
        customerId: s.customerId,
        currency: a.currency!,
        unitId: a.unitId,
        now: ctx.now,
      });
      if (r.runwayDays === null) return null;
      return {
        value: fx(BigInt(r.runwayDays)),
        periodKey: w.start,
        resetsAt: w.end,
        reference: null,
      };
    }
  }
}

/** A threshold as an absolute Fixed12 value; null when it is a percent with no reference. */
export function absoluteThreshold(t: UsageAlertThreshold, reference: bigint | null): bigint | null {
  if (t.unit !== "percent") return fromNumber(t.value);
  if (reference === null) return null;
  // reference × pct ÷ 100, rounded half-up at Fixed12.
  const n = reference * fromNumber(t.value);
  const d = 100n * FIXED12_SCALE;
  return (n + d / 2n) / d;
}

// ── Subjects ─────────────────────────────────────────────────────────────────────────

/** The subscriptions of a customer that a plan alert covers (live, to the alert's product). */
async function planSubjects(tx: Tx, a: UsageAlert, customerId: string): Promise<Subject[]> {
  const rows = await tx
    .selectDistinct({ id: subscriptions.id })
    .from(subscriptions)
    .innerJoin(subscriptionItems, eq(subscriptionItems.subscriptionId, subscriptions.id))
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .where(
      and(
        eq(subscriptions.customerId, customerId),
        inArray(subscriptions.status, ["active", "in_trial"]),
        eq(prices.productId, a.productId!),
      ),
    );
  return rows.map((r) => ({ key: `sub:${r.id}`, customerId, subscriptionId: r.id }));
}

/** Alerts that apply to a customer, each with its subjects. A customer alert of the same kind and meter wins over a plan alert. */
export async function alertsForCustomer(
  tx: Tx,
  businessId: string,
  customerId: string,
): Promise<Array<{ alert: UsageAlert; subjects: Subject[] }>> {
  const own = await tx
    .select()
    .from(usageAlerts)
    .where(
      and(
        eq(usageAlerts.businessId, businessId),
        eq(usageAlerts.customerId, customerId),
        eq(usageAlerts.active, true),
      ),
    );
  const productIds = await tx
    .selectDistinct({ id: prices.productId })
    .from(subscriptions)
    .innerJoin(subscriptionItems, eq(subscriptionItems.subscriptionId, subscriptions.id))
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .where(
      and(
        eq(subscriptions.customerId, customerId),
        inArray(subscriptions.status, ["active", "in_trial"]),
      ),
    );
  const ids = productIds.map((p) => p.id).filter((x): x is string => !!x);
  const plan = ids.length
    ? await tx
        .select()
        .from(usageAlerts)
        .where(
          and(
            eq(usageAlerts.businessId, businessId),
            inArray(usageAlerts.productId, ids),
            eq(usageAlerts.active, true),
          ),
        )
    : [];
  const out: Array<{ alert: UsageAlert; subjects: Subject[] }> = own.map((a) => ({
    alert: a,
    subjects: [{ key: "customer", customerId, subscriptionId: null }],
  }));
  for (const a of plan) {
    if (own.some((o) => o.kind === a.kind && (o.meterId ?? null) === (a.meterId ?? null))) continue;
    // Balance and runway are the customer's, whatever the plan: one subject.
    const subjects =
      a.kind === "credit_balance" || a.kind === "credit_runway"
        ? [{ key: "customer", customerId, subscriptionId: null }]
        : await planSubjects(tx, a, customerId);
    if (subjects.length) out.push({ alert: a, subjects });
  }
  return out;
}

// ── Evaluation ───────────────────────────────────────────────────────────────────────

async function customerPublicId(tx: Tx, customerId: string): Promise<string | null> {
  const [c] = await tx
    .select({ p: customers.publicId })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return c?.p ?? null;
}

async function alertRefs(tx: Tx, a: UsageAlert) {
  const [m] = a.meterId
    ? await tx.select({ key: meters.key }).from(meters).where(eq(meters.id, a.meterId)).limit(1)
    : [];
  const [p] = a.productId
    ? await tx
        .select({ id: products.publicId })
        .from(products)
        .where(eq(products.id, a.productId))
        .limit(1)
    : [];
  const [u] = a.unitId
    ? await tx
        .select({ key: creditUnits.key })
        .from(creditUnits)
        .where(eq(creditUnits.id, a.unitId))
        .limit(1)
    : [];
  return {
    meter: m?.key ?? null,
    product: (p as { id: string } | undefined)?.id ?? null,
    unit: u?.key ?? null,
  };
}

function alertPayload(a: UsageAlert, refs: Awaited<ReturnType<typeof alertRefs>>) {
  return {
    id: a.publicId,
    kind: a.kind,
    scope: a.scope,
    product: refs.product,
    meter: refs.meter,
    interval: a.interval,
    currency: a.currency,
    unit: refs.unit,
  };
}

/** Value as the API shows it: minor units / days as integers, quantities as decimal strings. */
export function valueOut(kind: UsageAlertKind, unitId: string | null, v: bigint): number | string {
  if (kind === "usage_quantity" || (kind === "credit_balance" && unitId)) return formatFixed12(v);
  return Number(v / FIXED12_SCALE);
}

/**
 * Evaluate one alert for one subject: resolve in-alarm thresholds of earlier periods
 * (`period_ended`) and those the value moved back across (`recovered`), then fire every
 * threshold crossed since the last observation, once per period. Returns events emitted.
 */
export async function evaluateAlertSubject(
  tx: Tx,
  a: UsageAlert,
  s: Subject,
  ctx: { now: Date; tz: string; cache: RateCache },
): Promise<number> {
  const o = await observe(tx, a, s, ctx);
  let emitted = await resolvePastPeriods(tx, a, s, o?.periodKey ?? null, ctx.now);
  if (!o) return emitted;
  const falling = FALLING.has(a.kind);
  const abs = a.thresholds
    .map((t) => ({ t, v: absoluteThreshold(t, o.reference) }))
    .filter((x): x is { t: UsageAlertThreshold; v: bigint } => x.v !== null);
  const [prevObs] = await tx
    .select()
    .from(usageAlertObservations)
    .where(
      and(
        eq(usageAlertObservations.alertId, a.id),
        eq(usageAlertObservations.subjectKey, s.key),
        eq(usageAlertObservations.periodKey, o.periodKey),
      ),
    )
    .limit(1);
  const prev = prevObs ? parseFixed12(String(prevObs.lastValue)) : null;
  const refs = await alertRefs(tx, a);
  const cus = await customerPublicId(tx, s.customerId);
  const base = {
    usage_alert: alertPayload(a, refs),
    customer: cus,
    subscription: s.subscriptionId ? await subPublicId(tx, s.subscriptionId) : null,
    value: valueOut(a.kind, a.unitId, o.value),
    period_key: o.periodKey.toISOString(),
    resets_at: o.resetsAt.toISOString(),
  };

  // Recovered: in-alarm thresholds of this period the value moved back across.
  const open = await tx
    .select()
    .from(usageAlertStates)
    .where(
      and(
        eq(usageAlertStates.alertId, a.id),
        eq(usageAlertStates.subjectKey, s.key),
        eq(usageAlertStates.periodKey, o.periodKey),
        isNotNull(usageAlertStates.triggeredAt),
        isNull(usageAlertStates.resolvedAt),
      ),
    );
  for (const st of open) {
    const def = a.thresholds.find(
      (t) => fromNumber(t.value) === parseFixed12(String(st.threshold)),
    );
    const tv = def ? absoluteThreshold(def, o.reference) : null;
    if (tv === null || recovered([tv], o.value, falling).length === 0) continue;
    const [u] = await tx
      .update(usageAlertStates)
      .set({ resolvedAt: ctx.now, resolveReason: "recovered", lastValue: formatFixed12(o.value) })
      .where(and(eq(usageAlertStates.id, st.id), isNull(usageAlertStates.resolvedAt)))
      .returning();
    if (!u) continue;
    await emitEvent(tx, {
      organizationId: a.organizationId,
      businessId: a.businessId,
      type: "usage_alert_resolved",
      data: {
        ...base,
        usage_alert: base.usage_alert,
        threshold: def,
        threshold_value: valueOut(a.kind, a.unitId, tv),
        reason: "recovered",
      },
    });
    emitted++;
  }

  // Crossed: each threshold once per period (the unique state row).
  const hits = crossed(
    abs.map((x) => x.v),
    prev,
    o.value,
    falling,
  );
  for (const x of abs) {
    if (!hits.includes(x.v)) continue;
    const [st] = await tx
      .insert(usageAlertStates)
      .values({
        organizationId: a.organizationId,
        businessId: a.businessId,
        alertId: a.id,
        customerId: s.customerId,
        subjectKey: s.key,
        periodKey: o.periodKey,
        threshold: formatFixed12(fromNumber(x.t.value)),
        lastValue: formatFixed12(o.value),
        triggeredAt: ctx.now,
      })
      .onConflictDoNothing()
      .returning();
    if (!st) continue;
    await emitEvent(tx, {
      organizationId: a.organizationId,
      businessId: a.businessId,
      type: "usage_alert_triggered",
      data: {
        ...base,
        usage_alert: base.usage_alert,
        threshold: x.t,
        threshold_value: valueOut(a.kind, a.unitId, x.v),
        reference_value: o.reference === null ? null : valueOut(a.kind, a.unitId, o.reference),
        email: a.email,
      },
    });
    emitted++;
  }

  await tx
    .insert(usageAlertObservations)
    .values({
      organizationId: a.organizationId,
      businessId: a.businessId,
      alertId: a.id,
      customerId: s.customerId,
      subjectKey: s.key,
      periodKey: o.periodKey,
      lastValue: formatFixed12(o.value),
    })
    .onConflictDoUpdate({
      target: [
        usageAlertObservations.alertId,
        usageAlertObservations.subjectKey,
        usageAlertObservations.periodKey,
      ],
      set: { lastValue: formatFixed12(o.value) },
    });
  return emitted;
}

async function subPublicId(tx: Tx, id: string): Promise<string | null> {
  const [s] = await tx
    .select({ p: subscriptions.publicId })
    .from(subscriptions)
    .where(eq(subscriptions.id, id))
    .limit(1);
  return s?.p ?? null;
}

/**
 * Resolve, with `period_ended`, triggered states of this alert and subject from periods
 * before `currentKey`. `currentKey` null (nothing measurable) resolves none.
 */
async function resolvePastPeriods(
  tx: Tx,
  a: UsageAlert,
  s: Subject,
  currentKey: Date | null,
  now: Date,
): Promise<number> {
  if (!currentKey) return 0;
  const rows = await tx
    .update(usageAlertStates)
    .set({ resolvedAt: now, resolveReason: "period_ended" })
    .where(
      and(
        eq(usageAlertStates.alertId, a.id),
        eq(usageAlertStates.subjectKey, s.key),
        isNotNull(usageAlertStates.triggeredAt),
        isNull(usageAlertStates.resolvedAt),
        sql`${usageAlertStates.periodKey} < ${currentKey.toISOString()}::timestamptz`,
      ),
    )
    .returning();
  if (!rows.length) return 0;
  const refs = await alertRefs(tx, a);
  const cus = await customerPublicId(tx, s.customerId);
  for (const st of rows) {
    const def = a.thresholds.find(
      (t) => fromNumber(t.value) === parseFixed12(String(st.threshold)),
    );
    await emitEvent(tx, {
      organizationId: a.organizationId,
      businessId: a.businessId,
      type: "usage_alert_resolved",
      data: {
        usage_alert: alertPayload(a, refs),
        customer: cus,
        subscription: s.subscriptionId ? await subPublicId(tx, s.subscriptionId) : null,
        threshold: def ?? null,
        period_key: st.periodKey.toISOString(),
        reason: "period_ended",
      },
    });
  }
  return rows.length;
}

/** Evaluate every alert that applies to a customer (the on-arrival check). */
export async function evaluateCustomerAlerts(
  tx: Tx,
  input: { businessId: string; customerId: string; now: Date; tz?: string; cache?: RateCache },
): Promise<number> {
  const list = await alertsForCustomer(tx, input.businessId, input.customerId);
  if (!list.length) return 0;
  const ctx = {
    now: input.now,
    tz: input.tz ?? (await businessTimeZone(tx, input.businessId)),
    cache: input.cache ?? newRateCache(),
  };
  let n = 0;
  for (const { alert, subjects } of list)
    for (const s of subjects) n += await evaluateAlertSubject(tx, alert, s, ctx);
  return n;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────────────

export interface AlertFields {
  kind: UsageAlertKind;
  scope: "customer" | "plan";
  customerId?: string | null;
  productId?: string | null;
  meterId?: string | null;
  interval?: UsageControlInterval | null;
  currency?: string | null;
  unitId?: string | null;
  thresholds: UsageAlertThreshold[];
  email?: boolean;
}

function checkThresholds(
  kind: UsageAlertKind,
  unitId: string | null,
  ts: UsageAlertThreshold[],
): void {
  if (ts.length < 1 || ts.length > 10)
    throw new UsageControlRuleError("Set 1 to 10 thresholds.", "thresholds");
  const seen = new Set<string>();
  for (const [i, t] of ts.entries()) {
    if (!UNITS_BY_KIND[kind].includes(t.unit))
      throw new UsageControlRuleError(
        `A ${kind} threshold takes the unit ${UNITS_BY_KIND[kind].join(" or ")}.`,
        `thresholds[${i}].unit`,
      );
    if (kind === "credit_balance" && (t.unit === "units") !== !!unitId && t.unit !== "percent")
      throw new UsageControlRuleError(
        unitId
          ? "A credit unit balance takes thresholds in units or percent."
          : "A money balance takes thresholds in minor units or percent.",
        `thresholds[${i}].unit`,
      );
    if (!(t.value >= 0) || (t.unit !== "units" && !Number.isInteger(t.value)))
      throw new UsageControlRuleError(
        "A threshold must be a whole number of 0 or more.",
        `thresholds[${i}].value`,
      );
    if (t.unit === "percent" && (t.value <= 0 || t.value > 1000))
      throw new UsageControlRuleError(
        "A percent threshold must be from 1 to 1000.",
        `thresholds[${i}].value`,
      );
    const k = String(t.value);
    if (seen.has(k))
      throw new UsageControlRuleError("Thresholds must be unique.", `thresholds[${i}].value`);
    seen.add(k);
  }
}

async function checkAlertRefs(tx: Tx, businessId: string, f: AlertFields): Promise<void> {
  const needsInterval = f.kind === "usage_quantity" || f.kind === "spend";
  if (needsInterval !== !!f.interval)
    throw new UsageControlRuleError(
      needsInterval
        ? "A usage or spend alert needs interval."
        : "Only a usage or spend alert takes interval.",
      "interval",
    );
  if (f.kind === "usage_quantity" && !f.meterId)
    throw new UsageControlRuleError("A usage alert needs a meter.", "meter");
  if (f.meterId && !needsInterval)
    throw new UsageControlRuleError("Only a usage or spend alert takes a meter.", "meter");
  if (f.kind !== "usage_quantity" && !f.currency)
    throw new UsageControlRuleError("This alert needs currency.", "currency");
  if (f.unitId && f.kind !== "credit_balance" && f.kind !== "credit_runway")
    throw new UsageControlRuleError("Only a balance or runway alert takes a credit unit.", "unit");
  checkThresholds(f.kind, f.unitId ?? null, f.thresholds);
  // A % spend threshold needs the scope's limit for that interval (customer scope: now).
  if (
    f.kind === "spend" &&
    f.scope === "customer" &&
    f.thresholds.some((t) => t.unit === "percent")
  ) {
    const loaded = await loadCustomerLimits(tx, f.customerId!, { currency: f.currency! });
    const has = resolveApplicable(loaded, {
      meterId: f.meterId ?? null,
      subscriptionIds: null,
      scope: null,
      currency: f.currency!,
    }).applicable.some((l) => l.interval === f.interval && l.scope === "customer");
    if (!has)
      throw new UsageControlRuleError(
        "A percent spend alert needs a customer spend limit for the same interval. Set the limit first, or use an amount.",
        "thresholds",
      );
  }
  void businessId;
}

export async function createAlert(input: {
  organizationId: string;
  businessId: string;
  fields: AlertFields;
}): Promise<UsageAlert> {
  const f = { ...input.fields, currency: input.fields.currency?.toUpperCase() ?? null };
  return withTenant(input.organizationId, async (tx) => {
    await checkAlertRefs(tx, input.businessId, f);
    const [a] = await tx
      .insert(usageAlerts)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        publicId: publicId("ualt"),
        kind: f.kind,
        scope: f.scope,
        customerId: f.scope === "customer" ? f.customerId! : null,
        productId: f.scope === "plan" ? f.productId! : null,
        meterId: f.meterId ?? null,
        interval: f.interval ?? null,
        currency: f.currency,
        unitId: f.unitId ?? null,
        thresholds: f.thresholds,
        email: f.email ?? false,
      })
      .returning();
    await setUsageControlsActive(tx, input.businessId);
    if (a!.customerId)
      await markDirty(tx, { businessId: input.businessId, customerIds: [a!.customerId] });
    return a!;
  });
}

export async function getAlert(
  tx: Tx,
  businessId: string,
  alertPublicId: string,
): Promise<UsageAlert | null> {
  const [a] = await tx
    .select()
    .from(usageAlerts)
    .where(and(eq(usageAlerts.businessId, businessId), eq(usageAlerts.publicId, alertPublicId)))
    .limit(1);
  return a ?? null;
}

export async function listAlerts(
  organizationId: string,
  businessId: string,
  filter: { customerId?: string; productId?: string } = {},
): Promise<UsageAlert[]> {
  return withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(usageAlerts)
      .where(
        and(
          eq(usageAlerts.businessId, businessId),
          eq(usageAlerts.active, true),
          filter.customerId ? eq(usageAlerts.customerId, filter.customerId) : undefined,
          filter.productId ? eq(usageAlerts.productId, filter.productId) : undefined,
        ),
      )
      .orderBy(asc(usageAlerts.createdAt), asc(usageAlerts.publicId))
      .limit(500),
  );
}

export async function updateAlert(input: {
  organizationId: string;
  businessId: string;
  alert: string;
  thresholds?: UsageAlertThreshold[];
  email?: boolean;
}): Promise<UsageAlert> {
  return withTenant(input.organizationId, async (tx) => {
    const a = await getAlert(tx, input.businessId, input.alert);
    if (!a || !a.active) throw new UsageControlNotFoundError(`No such usage alert: ${input.alert}`);
    if (input.thresholds)
      await checkAlertRefs(tx, input.businessId, {
        kind: a.kind,
        scope: a.scope,
        customerId: a.customerId,
        productId: a.productId,
        meterId: a.meterId,
        interval: a.interval,
        currency: a.currency,
        unitId: a.unitId,
        thresholds: input.thresholds,
      });
    const [u] = await tx
      .update(usageAlerts)
      .set({
        ...(input.thresholds ? { thresholds: input.thresholds } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
      })
      .where(eq(usageAlerts.id, a.id))
      .returning();
    if (u!.customerId)
      await markDirty(tx, { businessId: input.businessId, customerIds: [u!.customerId] });
    return u!;
  });
}

export async function deleteAlert(input: {
  organizationId: string;
  businessId: string;
  alert: string;
}): Promise<UsageAlert> {
  return withTenant(input.organizationId, async (tx) => {
    const a = await getAlert(tx, input.businessId, input.alert);
    if (!a) throw new UsageControlNotFoundError(`No such usage alert: ${input.alert}`);
    if (!a.active) throw new UsageControlConflictError("The usage alert is already deleted.");
    const [u] = await tx
      .update(usageAlerts)
      .set({ active: false })
      .where(eq(usageAlerts.id, a.id))
      .returning();
    return u!;
  });
}

export async function serializeAlert(tx: Tx, a: UsageAlert) {
  const refs = await alertRefs(tx, a);
  return {
    object: "usage_alert" as const,
    ...alertPayload(a, refs),
    customer: a.customerId ? await customerPublicId(tx, a.customerId) : null,
    thresholds: a.thresholds,
    email: a.email,
    active: a.active,
    created_at: a.createdAt.toISOString(),
  };
}

// ── Per-threshold state read (Decision 5) ────────────────────────────────────────────

/**
 * The current period's state per threshold, from the state rows alone: armed (no row),
 * triggered (triggered, not resolved), resolved. A consumer can rebuild its view from this.
 */
export async function alertStates(
  tx: Tx,
  a: UsageAlert,
  customerId: string,
): Promise<
  Array<{
    subject: string;
    subscription: string | null;
    period_key: string | null;
    resets_at: string | null;
    thresholds: Array<Record<string, unknown>>;
  }>
> {
  const now = stampNow(a.businessId);
  const tz = await businessTimeZone(tx, a.businessId);
  const subjects: Subject[] =
    a.scope === "customer" || a.kind === "credit_balance" || a.kind === "credit_runway"
      ? [{ key: "customer", customerId, subscriptionId: null }]
      : await planSubjects(tx, a, customerId);
  const out = [];
  for (const s of subjects) {
    const w = await subjectWindow(tx, a, s, now, tz);
    const rows = w
      ? await tx
          .select()
          .from(usageAlertStates)
          .where(
            and(
              eq(usageAlertStates.alertId, a.id),
              eq(usageAlertStates.subjectKey, s.key),
              eq(usageAlertStates.periodKey, w.start),
            ),
          )
      : [];
    const [obs] = w
      ? await tx
          .select()
          .from(usageAlertObservations)
          .where(
            and(
              eq(usageAlertObservations.alertId, a.id),
              eq(usageAlertObservations.subjectKey, s.key),
              eq(usageAlertObservations.periodKey, w.start),
            ),
          )
          .limit(1)
      : [];
    const lastObs = obs ? parseFixed12(String(obs.lastValue)) : null;
    out.push({
      subject: s.key === "customer" ? "customer" : "subscription",
      subscription: s.subscriptionId ? await subPublicId(tx, s.subscriptionId) : null,
      period_key: w?.start.toISOString() ?? null,
      resets_at: w?.end.toISOString() ?? null,
      thresholds: a.thresholds.map((t) => {
        const st = rows.find((r) => parseFixed12(String(r.threshold)) === fromNumber(t.value));
        const state = !st || !st.triggeredAt ? "armed" : st.resolvedAt ? "resolved" : "triggered";
        const lv = st?.lastValue != null ? parseFixed12(String(st.lastValue)) : lastObs;
        return {
          value: t.value,
          unit: t.unit,
          state,
          last_value: lv === null ? null : valueOut(a.kind, a.unitId, lv),
          triggered_at: st?.triggeredAt?.toISOString() ?? null,
          resolved_at: st?.resolvedAt?.toISOString() ?? null,
          resolve_reason: st?.resolveReason ?? null,
          period_key: w?.start.toISOString() ?? null,
          resets_at: w?.end.toISOString() ?? null,
        };
      }),
    });
  }
  return out;
}

/** Customers with an open (triggered, unresolved) state, for the period-roll scan. */
export const OPEN_STATES = and(
  isNotNull(usageAlertStates.triggeredAt),
  isNull(usageAlertStates.resolvedAt),
);
