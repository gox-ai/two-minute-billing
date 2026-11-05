/**
 * Spend limits and limit tiers (design G5 §3.2–3.3): CRUD with the nesting and buyer rules,
 * the access-check evaluator (hard limits), reached states (once per limit, subject and
 * interval) and tiers reached from lifetime paid (never demoted).
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { stampNow } from "@/platform/clock";
import { emitEvent } from "@/modules/events/emit";
import {
  businesses,
  customerLimitTierReached,
  customers,
  meters,
  spendLimits,
  spendLimitStates,
  spendLimitTiers,
  subscriptions,
  type SpendLimitMode,
  type SpendLimitScope,
  type SpendLimitSetBy,
  type SpendLimitTierAmounts,
  type UsageControlInterval,
} from "@db/schema";
import { formatMoney } from "@/modules/emails/templates";
import type { SpendLimitHit, SpendLimitInput } from "@/modules/credits/spend-limits";
import { liveMeteredItems } from "@/modules/credits/usage";
import { markDirty, setUsageControlsActive, usageControlsActive } from "./dirty";
import {
  businessTimeZone,
  calendarWindow,
  measureSpend,
  newRateCache,
  periodWindow,
  type RateCache,
} from "./measure";

export type SpendLimit = typeof spendLimits.$inferSelect;
export type SpendLimitTier = typeof spendLimitTiers.$inferSelect;

export const INTERVALS: readonly UsageControlInterval[] = ["day", "week", "month", "period"];
const INTERVAL_WORD: Record<UsageControlInterval, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  period: "billing period",
};
const MAX_TIERS_PER_CURRENCY = 10;
const MONTH_MS = 28 * 86_400_000;

/** A refusal at write: 422 naming the field. */
export class UsageControlRuleError extends Error {
  constructor(
    message: string,
    readonly param: string,
  ) {
    super(message);
    this.name = "UsageControlRuleError";
  }
}
/** A missing resource: 404. */
export class UsageControlNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageControlNotFoundError";
  }
}
/** A duplicate or forbidden change: 409. */
export class UsageControlConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageControlConflictError";
  }
}

// ── Nesting ──────────────────────────────────────────────────────────────────────────

/**
 * day ≤ week ≤ month, and month ≤ period when the term is a month or longer. Returns the
 * message for the first pair out of order, or null.
 */
export function nestingIssue(
  amounts: Partial<Record<UsageControlInterval, bigint | number>>,
  termAtLeastMonth: boolean,
): { message: string; interval: UsageControlInterval } | null {
  const order: UsageControlInterval[] = termAtLeastMonth
    ? ["day", "week", "month", "period"]
    : ["day", "week", "month"];
  const present = order.filter((i) => amounts[i] != null);
  for (let a = 0; a < present.length; a++)
    for (let b = a + 1; b < present.length; b++) {
      const lo = present[a]!;
      const hi = present[b]!;
      if (BigInt(amounts[lo]!) > BigInt(amounts[hi]!))
        return {
          interval: lo,
          message: `The ${INTERVAL_WORD[lo]} limit cannot be more than the ${INTERVAL_WORD[hi]} limit.`,
        };
    }
  return null;
}

async function termAtLeastMonth(
  tx: Tx,
  customerId: string,
  subscriptionId: string | null,
): Promise<boolean> {
  const rows = await tx
    .select({ s: subscriptions.currentPeriodStart, e: subscriptions.currentPeriodEnd })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.customerId, customerId),
        subscriptionId ? eq(subscriptions.id, subscriptionId) : undefined,
        inArray(subscriptions.status, ["active", "in_trial"]),
      ),
    );
  return rows.some((r) => r.s && r.e && r.e.getTime() - r.s.getTime() >= MONTH_MS);
}

/** Same subject: scope, subscription, property key and value. */
const sameSubject = (a: SpendLimitLike, b: SpendLimitLike) =>
  a.scope === b.scope &&
  (a.subscriptionId ?? null) === (b.subscriptionId ?? null) &&
  (a.propertyKey ?? null) === (b.propertyKey ?? null) &&
  (a.propertyValue ?? null) === (b.propertyValue ?? null);

type SpendLimitLike = Pick<
  SpendLimit,
  | "scope"
  | "subscriptionId"
  | "propertyKey"
  | "propertyValue"
  | "interval"
  | "amountMinor"
  | "mode"
  | "setBy"
>;

async function checkNesting(
  tx: Tx,
  customerId: string,
  candidate: SpendLimitLike & { id?: string },
): Promise<void> {
  const others = await tx
    .select()
    .from(spendLimits)
    .where(
      and(
        eq(spendLimits.customerId, customerId),
        eq(spendLimits.active, true),
        eq(spendLimits.mode, candidate.mode),
        eq(spendLimits.setBy, candidate.setBy),
      ),
    );
  const amounts: Partial<Record<UsageControlInterval, bigint>> = {};
  for (const o of others)
    if (o.id !== candidate.id && sameSubject(o, candidate)) amounts[o.interval] = o.amountMinor;
  amounts[candidate.interval] = candidate.amountMinor;
  const issue = nestingIssue(
    amounts,
    await termAtLeastMonth(tx, customerId, candidate.subscriptionId ?? null),
  );
  if (issue) throw new UsageControlRuleError(issue.message, "amount_minor");
}

// ── Tiers ───────────────────────────────────────────────────────────────────────────

/** Lifetime paid (§3.3): Σ succeeded payments − Σ succeeded refunds, in one currency. */
export async function lifetimePaidMinor(
  tx: Tx,
  customerId: string,
  currency: string,
): Promise<bigint> {
  const rows = (await tx.execute(sql`
    select
      coalesce((select sum(amount_minor) from payments where customer_id = ${customerId}
        and currency = ${currency} and status = 'succeeded'), 0)
      - coalesce((select sum(r.amount_minor) from refunds r join payments p on p.id = r.payment_id
        where p.customer_id = ${customerId} and r.currency = ${currency}
          and r.status = 'succeeded'), 0) as paid`)) as unknown as Array<{ paid: string }>;
  return BigInt(rows[0]?.paid ?? "0");
}

/** The highest active tier this customer reached in `currency`, with when. */
export async function reachedTier(
  tx: Tx,
  customerId: string,
  currency: string,
): Promise<{ tier: SpendLimitTier; reachedAt: Date } | null> {
  const [r] = await tx
    .select({ tier: spendLimitTiers, reachedAt: customerLimitTierReached.reachedAt })
    .from(customerLimitTierReached)
    .innerJoin(spendLimitTiers, eq(spendLimitTiers.id, customerLimitTierReached.tierId))
    .where(
      and(
        eq(customerLimitTierReached.customerId, customerId),
        eq(customerLimitTierReached.currency, currency),
        eq(spendLimitTiers.active, true),
      ),
    )
    .orderBy(desc(spendLimitTiers.levelMinor))
    .limit(1);
  return r ?? null;
}

/**
 * Append every active tier at or below lifetime paid that the customer has not reached.
 * Append-only and unique per (customer, tier): a refund never removes a row, so tiers never
 * demote. Emits `customer_limit_tier_reached` per new row.
 */
export async function evaluateTiers(
  tx: Tx,
  input: { organizationId: string; businessId: string; customerId: string; currency: string },
): Promise<string[]> {
  const cur = input.currency.toUpperCase();
  const tiers = await tx
    .select()
    .from(spendLimitTiers)
    .where(
      and(
        eq(spendLimitTiers.businessId, input.businessId),
        eq(spendLimitTiers.currency, cur),
        eq(spendLimitTiers.active, true),
      ),
    )
    .orderBy(asc(spendLimitTiers.levelMinor));
  if (!tiers.length) return [];
  const paid = await lifetimePaidMinor(tx, input.customerId, cur);
  const reached: string[] = [];
  for (const t of tiers) {
    if (t.levelMinor > paid) break;
    const [row] = await tx
      .insert(customerLimitTierReached)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.customerId,
        tierId: t.id,
        currency: cur,
        lifetimePaidMinor: paid,
        reachedAt: stampNow(input.businessId),
      })
      .onConflictDoNothing()
      .returning();
    if (!row) continue;
    reached.push(t.publicId);
    const [c] = await tx
      .select({ publicId: customers.publicId })
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1);
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "customer_limit_tier_reached",
      data: {
        customer_limit_tier: serializeTier(t),
        customer: c?.publicId ?? null,
        lifetime_paid_minor: Number(paid),
        currency: cur,
      },
    });
  }
  if (reached.length)
    await markDirty(tx, { businessId: input.businessId, customerIds: [input.customerId] });
  return reached;
}

export function serializeTier(t: SpendLimitTier) {
  return {
    object: "spend_limit_tier" as const,
    id: t.publicId,
    currency: t.currency,
    level_minor: Number(t.levelMinor),
    amounts: t.amounts,
    active: t.active,
    created_at: t.createdAt.toISOString(),
  };
}

function checkTierAmounts(amounts: SpendLimitTierAmounts): void {
  const keys = Object.keys(amounts);
  if (!keys.length) throw new UsageControlRuleError("Set at least one amount.", "amounts");
  for (const k of keys)
    if (!INTERVALS.includes(k as UsageControlInterval))
      throw new UsageControlRuleError(`Unknown interval: ${k}.`, "amounts");
  const issue = nestingIssue(amounts, true);
  if (issue) throw new UsageControlRuleError(issue.message, `amounts.${issue.interval}`);
}

export async function createTier(input: {
  organizationId: string;
  businessId: string;
  currency: string;
  levelMinor: bigint;
  amounts: SpendLimitTierAmounts;
}): Promise<SpendLimitTier> {
  checkTierAmounts(input.amounts);
  const cur = input.currency.toUpperCase();
  return withTenant(input.organizationId, async (tx) => {
    const n = await tx
      .select({ id: spendLimitTiers.id, level: spendLimitTiers.levelMinor })
      .from(spendLimitTiers)
      .where(
        and(
          eq(spendLimitTiers.businessId, input.businessId),
          eq(spendLimitTiers.currency, cur),
          eq(spendLimitTiers.active, true),
        ),
      );
    if (n.length >= MAX_TIERS_PER_CURRENCY)
      throw new UsageControlRuleError(
        `A currency can have at most ${MAX_TIERS_PER_CURRENCY} limit tiers.`,
        "level_minor",
      );
    if (n.some((t) => t.level === input.levelMinor))
      throw new UsageControlConflictError("A limit tier with this level already exists.");
    const [t] = await tx
      .insert(spendLimitTiers)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        publicId: publicId("sltr"),
        currency: cur,
        levelMinor: input.levelMinor,
        amounts: input.amounts,
      })
      .returning();
    await setUsageControlsActive(tx, input.businessId);
    return t!;
  });
}

export async function listTiers(
  organizationId: string,
  businessId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<SpendLimitTier[]> {
  return withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(spendLimitTiers)
      .where(
        and(
          eq(spendLimitTiers.businessId, businessId),
          opts.includeArchived ? undefined : eq(spendLimitTiers.active, true),
        ),
      )
      .orderBy(asc(spendLimitTiers.currency), asc(spendLimitTiers.levelMinor)),
  );
}

export async function getTier(
  tx: Tx,
  businessId: string,
  tierPublicId: string,
): Promise<SpendLimitTier | null> {
  const [t] = await tx
    .select()
    .from(spendLimitTiers)
    .where(
      and(eq(spendLimitTiers.businessId, businessId), eq(spendLimitTiers.publicId, tierPublicId)),
    )
    .limit(1);
  return t ?? null;
}

/** Change a tier's amounts. The level is fixed: reached rows point at it. */
export async function updateTier(input: {
  organizationId: string;
  businessId: string;
  tier: string;
  amounts: SpendLimitTierAmounts;
}): Promise<SpendLimitTier> {
  checkTierAmounts(input.amounts);
  return withTenant(input.organizationId, async (tx) => {
    const t = await getTier(tx, input.businessId, input.tier);
    if (!t) throw new UsageControlNotFoundError(`No such limit tier: ${input.tier}`);
    if (!t.active) throw new UsageControlConflictError("The limit tier is archived.");
    const [u] = await tx
      .update(spendLimitTiers)
      .set({ amounts: input.amounts })
      .where(eq(spendLimitTiers.id, t.id))
      .returning();
    return u!;
  });
}

/** Archive (never delete): reached rows keep pointing at it; an archived tier stops applying. */
export async function archiveTier(input: {
  organizationId: string;
  businessId: string;
  tier: string;
}): Promise<SpendLimitTier> {
  return withTenant(input.organizationId, async (tx) => {
    const t = await getTier(tx, input.businessId, input.tier);
    if (!t) throw new UsageControlNotFoundError(`No such limit tier: ${input.tier}`);
    if (!t.active) return t;
    const [u] = await tx
      .update(spendLimitTiers)
      .set({ active: false })
      .where(eq(spendLimitTiers.id, t.id))
      .returning();
    return u!;
  });
}

// ── Limits: CRUD ─────────────────────────────────────────────────────────────────────

export interface SpendLimitInputFields {
  scope: SpendLimitScope;
  subscriptionId?: string | null;
  propertyKey?: string | null;
  propertyValue?: string | null;
  meterIds?: string[] | null;
  interval: UsageControlInterval;
  amountMinor: bigint;
  currency: string;
  mode: SpendLimitMode;
  setBy: SpendLimitSetBy;
}

/** A property key must be a limit dimension of every meter the limit covers (§3.2, 0475). */
async function checkPropertyKey(
  tx: Tx,
  businessId: string,
  key: string,
  meterIds: string[] | null,
): Promise<void> {
  const rows = await tx
    .select({ id: meters.id, key: meters.key, dims: meters.limitDimensions })
    .from(meters)
    .where(
      and(
        eq(meters.businessId, businessId),
        meterIds ? inArray(meters.id, meterIds) : eq(meters.status, "active"),
      ),
    );
  const ok = meterIds
    ? rows.length > 0 && rows.every((m) => m.dims.includes(key))
    : rows.some((m) => m.dims.includes(key));
  if (!ok) {
    const missing = meterIds ? rows.filter((m) => !m.dims.includes(key)).map((m) => m.key) : [];
    throw new UsageControlRuleError(
      missing.length
        ? `The property "${key}" is not a limit property of these meters: ${missing.join(", ")}. Add it to the meter's limit properties first.`
        : `No meter has the limit property "${key}". Add it to a meter's limit properties first.`,
      "property_key",
    );
  }
}

/**
 * The operator's effective hard amount for a subject and interval: its own limit, raised by
 * a reached tier for customer scope (a hand-set limit newer than the tier wins, §3.3).
 */
async function operatorCeiling(
  tx: Tx,
  customerId: string,
  f: Pick<
    SpendLimitInputFields,
    "scope" | "propertyKey" | "propertyValue" | "interval" | "currency"
  >,
): Promise<bigint | null> {
  const rows = await tx
    .select()
    .from(spendLimits)
    .where(
      and(
        eq(spendLimits.customerId, customerId),
        eq(spendLimits.active, true),
        eq(spendLimits.setBy, "operator"),
        eq(spendLimits.mode, "hard"),
        eq(spendLimits.scope, f.scope),
        eq(spendLimits.interval, f.interval),
        eq(spendLimits.currency, f.currency),
      ),
    );
  const mine = rows.filter(
    (r) =>
      (r.propertyKey ?? null) === (f.propertyKey ?? null) &&
      ((r.propertyValue ?? null) === (f.propertyValue ?? null) || r.propertyValue === null),
  );
  // A row for this exact value overrides the each-value row.
  const exact = mine.find((r) => (r.propertyValue ?? null) === (f.propertyValue ?? null));
  const own = exact ?? mine[0] ?? null;
  if (f.scope !== "customer") return own ? own.amountMinor : null;
  const tier = await reachedTier(tx, customerId, f.currency);
  const tierAmount = tier?.tier.amounts[f.interval];
  return effectiveCustomerAmount(
    own ? { amountMinor: own.amountMinor, updatedAt: own.updatedAt } : null,
    tier && tierAmount != null
      ? { amountMinor: BigInt(tierAmount), reachedAt: tier.reachedAt }
      : null,
  );
}

/**
 * Customer scope: the higher of the hand-set limit and the reached tier, unless the hand-set
 * limit was changed after the tier was reached (then it wins, even when lower).
 */
export function effectiveCustomerAmount(
  own: { amountMinor: bigint; updatedAt: Date } | null,
  tier: { amountMinor: bigint; reachedAt: Date } | null,
): bigint | null {
  if (!own) return tier?.amountMinor ?? null;
  if (!tier) return own.amountMinor;
  if (own.updatedAt.getTime() > tier.reachedAt.getTime()) return own.amountMinor;
  return own.amountMinor > tier.amountMinor ? own.amountMinor : tier.amountMinor;
}

async function checkBuyerCeiling(
  tx: Tx,
  customerId: string,
  f: SpendLimitInputFields,
): Promise<void> {
  if (f.setBy !== "customer") return;
  const ceiling = await operatorCeiling(tx, customerId, f);
  if (ceiling != null && f.amountMinor > ceiling) {
    const m = formatMoney(ceiling, f.currency);
    throw new UsageControlRuleError(
      `We could not save the limit. Your provider's limit is ${m}. Set a limit of ${m} or less.`,
      "amount_minor",
    );
  }
}

export async function createSpendLimit(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  fields: SpendLimitInputFields;
}): Promise<SpendLimit> {
  const f = { ...input.fields, currency: input.fields.currency.toUpperCase() };
  if (f.setBy === "customer" && (f.mode !== "hard" || f.scope === "subscription"))
    throw new UsageControlRuleError(
      "You can set only a hard limit on your account or on a usage property.",
      "scope",
    );
  if (f.scope === "property" && !f.propertyKey)
    throw new UsageControlRuleError("A property limit needs property_key.", "property_key");
  if (f.scope !== "property" && (f.propertyKey || f.propertyValue))
    throw new UsageControlRuleError("Only a property limit takes a property.", "property_key");
  if (f.scope === "subscription" && !f.subscriptionId)
    throw new UsageControlRuleError("A subscription limit needs subscription.", "subscription");
  return withTenant(input.organizationId, async (tx) => {
    if (f.scope === "property")
      await checkPropertyKey(tx, input.businessId, f.propertyKey!, f.meterIds ?? null);
    const candidate = {
      scope: f.scope,
      subscriptionId: f.subscriptionId ?? null,
      propertyKey: f.propertyKey ?? null,
      propertyValue: f.propertyValue ?? null,
      interval: f.interval,
      amountMinor: f.amountMinor,
      mode: f.mode,
      setBy: f.setBy,
    };
    await checkNesting(tx, input.customerId, candidate);
    await checkBuyerCeiling(tx, input.customerId, f);
    const [row] = await tx
      .insert(spendLimits)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        publicId: publicId("slim"),
        customerId: input.customerId,
        ...candidate,
        meterIds: f.meterIds?.length ? f.meterIds : null,
        currency: f.currency,
      })
      .onConflictDoNothing()
      .returning();
    if (!row)
      throw new UsageControlConflictError(
        "A limit for this subject, interval and mode already exists. Change it instead.",
      );
    await setUsageControlsActive(tx, input.businessId);
    await markDirty(tx, { businessId: input.businessId, customerIds: [input.customerId] });
    return row;
  });
}

export async function getSpendLimit(
  tx: Tx,
  businessId: string,
  customerId: string,
  limitPublicId: string,
): Promise<SpendLimit | null> {
  const [r] = await tx
    .select()
    .from(spendLimits)
    .where(
      and(
        eq(spendLimits.businessId, businessId),
        eq(spendLimits.customerId, customerId),
        eq(spendLimits.publicId, limitPublicId),
      ),
    )
    .limit(1);
  return r ?? null;
}

export async function listSpendLimits(
  organizationId: string,
  businessId: string,
  customerId: string,
  opts: { setBy?: SpendLimitSetBy } = {},
): Promise<SpendLimit[]> {
  return withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(spendLimits)
      .where(
        and(
          eq(spendLimits.businessId, businessId),
          eq(spendLimits.customerId, customerId),
          eq(spendLimits.active, true),
          opts.setBy ? eq(spendLimits.setBy, opts.setBy) : undefined,
        ),
      )
      .orderBy(asc(spendLimits.createdAt), asc(spendLimits.publicId)),
  );
}

/** Change the amount or the meters. `asBuyer` refuses an operator row. */
export async function updateSpendLimit(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  limit: string;
  amountMinor?: bigint;
  meterIds?: string[] | null;
  asBuyer?: boolean;
}): Promise<SpendLimit> {
  return withTenant(input.organizationId, async (tx) => {
    const cur = await getSpendLimit(tx, input.businessId, input.customerId, input.limit);
    if (!cur || !cur.active)
      throw new UsageControlNotFoundError(`No such spend limit: ${input.limit}`);
    if (input.asBuyer && cur.setBy !== "customer")
      throw new UsageControlConflictError("You cannot change a limit that your provider set.");
    const next = { ...cur, amountMinor: input.amountMinor ?? cur.amountMinor };
    if (input.amountMinor != null) {
      await checkNesting(tx, input.customerId, next);
      await checkBuyerCeiling(tx, input.customerId, {
        ...next,
        meterIds: next.meterIds,
      });
    }
    if (input.meterIds !== undefined && cur.scope === "property")
      await checkPropertyKey(tx, input.businessId, cur.propertyKey!, input.meterIds);
    const [u] = await tx
      .update(spendLimits)
      .set({
        ...(input.amountMinor != null ? { amountMinor: input.amountMinor } : {}),
        ...(input.meterIds !== undefined
          ? { meterIds: input.meterIds?.length ? input.meterIds : null }
          : {}),
        updatedAt: stampNow(input.businessId),
      })
      .where(eq(spendLimits.id, cur.id))
      .returning();
    await markDirty(tx, { businessId: input.businessId, customerIds: [input.customerId] });
    return u!;
  });
}

/** Remove a limit (inactive; its reached states stay). A buyer may remove only its own. */
export async function deleteSpendLimit(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  limit: string;
  asBuyer?: boolean;
}): Promise<SpendLimit> {
  return withTenant(input.organizationId, async (tx) => {
    const cur = await getSpendLimit(tx, input.businessId, input.customerId, input.limit);
    if (!cur || !cur.active)
      throw new UsageControlNotFoundError(`No such spend limit: ${input.limit}`);
    if (input.asBuyer && cur.setBy !== "customer")
      throw new UsageControlConflictError("You cannot delete a limit that your provider set.");
    const [u] = await tx
      .update(spendLimits)
      .set({ active: false })
      .where(eq(spendLimits.id, cur.id))
      .returning();
    await markDirty(tx, { businessId: input.businessId, customerIds: [input.customerId] });
    return u!;
  });
}

/** What a limit row allows now and how much of it is used. */
export interface LimitStanding {
  /** Customer-scope operator hard limit: raised by a reached tier (§3.3). Else the amount. */
  effectiveMinor: bigint;
  /** Null for an each-value property limit: each value has its own spend. */
  spentMinor: bigint | null;
  resetsAt: Date | null;
}

/** The amount that applies to a row: an operator's customer limit merged with the tier. */
export async function effectiveLimitAmount(tx: Tx, l: SpendLimit): Promise<bigint> {
  if (l.scope !== "customer" || l.setBy !== "operator" || l.mode !== "hard") return l.amountMinor;
  const tier = await reachedTier(tx, l.customerId, l.currency);
  const t = tier?.tier.amounts[l.interval];
  return effectiveCustomerAmount(
    { amountMinor: l.amountMinor, updatedAt: l.updatedAt },
    tier && t != null ? { amountMinor: BigInt(t), reachedAt: tier.reachedAt } : null,
  )!;
}

export async function limitStanding(
  tx: Tx,
  l: SpendLimit,
  at: { now: Date; tz: string; cache: RateCache },
): Promise<LimitStanding> {
  const effectiveMinor = await effectiveLimitAmount(tx, l);
  if (l.scope === "property" && l.propertyValue === null)
    return { effectiveMinor, spentMinor: null, resetsAt: null };
  const m = await measureLimit(
    tx,
    { businessId: l.businessId, customerId: l.customerId, ...at },
    {
      id: l.publicId,
      limitId: l.id,
      scope: l.scope,
      subscriptionId: l.subscriptionId,
      propertyKey: l.propertyKey,
      propertyValue: l.propertyValue,
      meterIds: l.meterIds,
      interval: l.interval,
      amountMinor: effectiveMinor,
      currency: l.currency,
      mode: l.mode,
      setBy: l.setBy,
      source: "limit",
    },
  );
  return { effectiveMinor, spentMinor: m.spentMinor, resetsAt: m.resetsAt };
}

/**
 * A reached tier's amounts for intervals with no operator hard customer limit: the access
 * check applies them as the provider's limit (`resolveApplicable`).
 */
export async function tierOnlyLimits(
  tx: Tx,
  customerId: string,
  rows: SpendLimit[],
): Promise<
  Array<{
    tier: SpendLimitTier;
    interval: UsageControlInterval;
    amountMinor: bigint;
    currency: string;
  }>
> {
  const reached = await tx
    .selectDistinct({ c: customerLimitTierReached.currency })
    .from(customerLimitTierReached)
    .where(eq(customerLimitTierReached.customerId, customerId));
  const out = [];
  for (const { c } of reached) {
    const tier = await reachedTier(tx, customerId, c);
    if (!tier) continue;
    for (const i of INTERVALS) {
      const amt = tier.tier.amounts[i];
      if (amt == null) continue;
      const covered = rows.some(
        (r) =>
          r.currency === c &&
          r.scope === "customer" &&
          r.setBy === "operator" &&
          r.mode === "hard" &&
          r.interval === i,
      );
      if (!covered)
        out.push({ tier: tier.tier, interval: i, amountMinor: BigInt(amt), currency: c });
    }
  }
  return out;
}

export function serializeSpendLimit(
  l: SpendLimit,
  refs: { customer: string; subscription?: string | null; meters?: string[] | null },
  standing?: LimitStanding,
) {
  return {
    object: "spend_limit" as const,
    id: l.publicId,
    customer: refs.customer,
    scope: l.scope,
    subscription: refs.subscription ?? null,
    property_key: l.propertyKey,
    property_value: l.propertyValue,
    meters: refs.meters ?? null,
    interval: l.interval,
    amount_minor: Number(l.amountMinor),
    currency: l.currency,
    mode: l.mode,
    set_by: l.setBy,
    active: l.active,
    effective_amount_minor: Number(standing?.effectiveMinor ?? l.amountMinor),
    spent_minor: standing?.spentMinor != null ? Number(standing.spentMinor) : null,
    reached: standing?.spentMinor != null ? standing.spentMinor >= standing.effectiveMinor : null,
    resets_at: standing?.resetsAt?.toISOString() ?? null,
    created_at: l.createdAt.toISOString(),
    updated_at: l.updatedAt.toISOString(),
  };
}

// ── Evaluation ───────────────────────────────────────────────────────────────────────

/** An applicable limit for one subject: an own row or a tier amount. */
export interface ResolvedLimit {
  id: string;
  limitId: string | null;
  scope: SpendLimitScope;
  subscriptionId: string | null;
  propertyKey: string | null;
  /** The value measured (a request value for an each-value row). */
  propertyValue: string | null;
  meterIds: string[] | null;
  interval: UsageControlInterval;
  amountMinor: bigint;
  currency: string;
  mode: SpendLimitMode;
  setBy: SpendLimitSetBy;
  source: "limit" | "tier";
}

/** subject_key for `spend_limit_states`. */
export const subjectKey = (
  l: Pick<ResolvedLimit, "scope" | "subscriptionId" | "propertyKey" | "propertyValue">,
) =>
  l.scope === "customer"
    ? "customer"
    : l.scope === "subscription"
      ? `sub:${l.subscriptionId}`
      : `prop:${l.propertyKey}=${l.propertyValue ?? ""}`;

/** Active limits of a customer plus the tier amounts as customer-scope operator hard limits. */
export async function loadCustomerLimits(
  tx: Tx,
  customerId: string,
  opts: { mode?: SpendLimitMode; currency?: string } = {},
): Promise<{
  rows: SpendLimit[];
  tiers: Map<string, { tier: SpendLimitTier; reachedAt: Date } | null>;
}> {
  const rows = await tx
    .select()
    .from(spendLimits)
    .where(
      and(
        eq(spendLimits.customerId, customerId),
        eq(spendLimits.active, true),
        opts.mode ? eq(spendLimits.mode, opts.mode) : undefined,
        opts.currency ? eq(spendLimits.currency, opts.currency) : undefined,
      ),
    );
  const tiers = new Map<string, { tier: SpendLimitTier; reachedAt: Date } | null>();
  if (!opts.mode || opts.mode === "hard") {
    const currencies = opts.currency ? [opts.currency] : [...new Set(rows.map((r) => r.currency))];
    if (!opts.currency) {
      const reached = await tx
        .selectDistinct({ c: customerLimitTierReached.currency })
        .from(customerLimitTierReached)
        .where(eq(customerLimitTierReached.customerId, customerId));
      for (const r of reached) if (!currencies.includes(r.c)) currencies.push(r.c);
    }
    for (const c of currencies) tiers.set(c, await reachedTier(tx, customerId, c));
  }
  return { rows, tiers };
}

/**
 * Resolve the limits that apply to a request: meter filter, subscription of the meter,
 * property values from the request scope (an exact-value row overrides the each-value row),
 * tiers merged into customer-scope operator hard limits. A property limit whose key the
 * request does not carry comes back in `notChecked`.
 */
export function resolveApplicable(
  loaded: Awaited<ReturnType<typeof loadCustomerLimits>>,
  req: {
    meterId: string | null;
    subscriptionIds: string[] | null;
    scope: Record<string, string> | null;
    currency: string;
  },
): { applicable: ResolvedLimit[]; notChecked: ResolvedLimit[] } {
  const applicable: ResolvedLimit[] = [];
  const notChecked: ResolvedLimit[] = [];
  const rows = loaded.rows.filter(
    (r) =>
      r.currency === req.currency &&
      (!r.meterIds || !req.meterId || r.meterIds.includes(req.meterId)) &&
      (r.scope !== "subscription" ||
        !req.subscriptionIds ||
        req.subscriptionIds.includes(r.subscriptionId!)),
  );
  const asResolved = (r: SpendLimit, value: string | null): ResolvedLimit => ({
    id: r.publicId,
    limitId: r.id,
    scope: r.scope,
    subscriptionId: r.subscriptionId,
    propertyKey: r.propertyKey,
    propertyValue: value,
    meterIds: r.meterIds,
    interval: r.interval,
    amountMinor: r.amountMinor,
    currency: r.currency,
    mode: r.mode,
    setBy: r.setBy,
    source: "limit",
  });
  for (const r of rows) {
    if (r.scope !== "property") continue;
    const v = req.scope?.[r.propertyKey!];
    if (v === undefined) {
      if (r.propertyValue === null || !notChecked.some((n) => n.id === r.publicId))
        notChecked.push(asResolved(r, r.propertyValue));
      continue;
    }
    if (r.propertyValue !== null) {
      if (r.propertyValue === v) applicable.push(asResolved(r, v));
      continue;
    }
    // Each-value row: overridden by an exact row for the same key, interval, mode, setter.
    const overridden = rows.some(
      (o) =>
        o.scope === "property" &&
        o.propertyKey === r.propertyKey &&
        o.propertyValue === v &&
        o.interval === r.interval &&
        o.mode === r.mode &&
        o.setBy === r.setBy,
    );
    if (!overridden) applicable.push(asResolved(r, v));
  }
  for (const r of rows) if (r.scope === "subscription") applicable.push(asResolved(r, null));
  // Customer scope: operator rows merged with the tier, buyer rows as they are.
  const tier = loaded.tiers.get(req.currency) ?? null;
  const cust = rows.filter((r) => r.scope === "customer");
  for (const r of cust) {
    if (r.setBy === "customer" || r.mode === "soft") {
      applicable.push(asResolved(r, null));
      continue;
    }
    const tierAmount = tier?.tier.amounts[r.interval];
    const amount = effectiveCustomerAmount(
      { amountMinor: r.amountMinor, updatedAt: r.updatedAt },
      tier && tierAmount != null
        ? { amountMinor: BigInt(tierAmount), reachedAt: tier.reachedAt }
        : null,
    )!;
    applicable.push({ ...asResolved(r, null), amountMinor: amount });
  }
  if (tier) {
    for (const i of INTERVALS) {
      const amt = tier.tier.amounts[i];
      if (amt == null) continue;
      if (cust.some((r) => r.setBy === "operator" && r.mode === "hard" && r.interval === i))
        continue;
      applicable.push({
        id: tier.tier.publicId,
        limitId: null,
        scope: "customer",
        subscriptionId: null,
        propertyKey: null,
        propertyValue: null,
        meterIds: null,
        interval: i,
        amountMinor: BigInt(amt),
        currency: req.currency,
        mode: "hard",
        setBy: "operator",
        source: "tier",
      });
    }
  }
  return { applicable, notChecked };
}

interface OpenHold {
  amount: bigint;
  meterId: string | null;
  scope: Record<string, string> | null;
}

/** The customer's open (unexpired) holds in a currency, read once per check. */
async function openHolds(
  tx: Tx,
  customerId: string,
  currency: string,
  now: Date,
): Promise<OpenHold[]> {
  const rows = (await tx.execute(sql`
    select amount_minor::text as amount, meter_id, scope from credit_holds
    where customer_id = ${customerId} and status = 'held' and currency = ${currency}
      and expires_at > ${now.toISOString()}::timestamptz`)) as unknown as Array<{
    amount: string;
    meter_id: string | null;
    scope: Record<string, string> | null;
  }>;
  return rows.map((r) => ({ amount: BigInt(r.amount), meterId: r.meter_id, scope: r.scope }));
}

/** Holds that count toward a limit: in its meters (a hold with no meter counts) and scope. */
function holdsInScope(
  holds: OpenHold[],
  l: ResolvedLimit,
  subMeters: Map<string, string[]>,
): bigint {
  const meterSet =
    l.meterIds ?? (l.scope === "subscription" ? (subMeters.get(l.subscriptionId!) ?? []) : null);
  return holds
    .filter(
      (h) =>
        (!meterSet || h.meterId === null || meterSet.includes(h.meterId)) &&
        (l.scope !== "property" || h.scope?.[l.propertyKey!] === (l.propertyValue ?? "")),
    )
    .reduce((a, h) => a + h.amount, 0n);
}

/** Measure one resolved limit now: spend in its interval and when it resets. */
export async function measureLimit(
  tx: Tx,
  input: { businessId: string; customerId: string; now: Date; tz: string; cache: RateCache },
  l: ResolvedLimit,
): Promise<{ spentMinor: bigint; windowStart: Date; resetsAt: Date }> {
  const m = await measureSpend(
    tx,
    {
      businessId: input.businessId,
      customerId: input.customerId,
      currency: l.currency,
      interval: l.interval,
      now: input.now,
      tz: input.tz,
      meterIds: l.meterIds,
      subscriptionId: l.scope === "subscription" ? l.subscriptionId : null,
      where:
        l.scope === "property" && l.propertyValue !== null
          ? { key: l.propertyKey!, value: l.propertyValue }
          : null,
    },
    { cache: input.cache },
  );
  return { spentMinor: m.amountMinor, windowStart: m.window.start, resetsAt: m.resetsAt };
}

function hitOf(
  l: ResolvedLimit,
  m: { spentMinor: bigint; resetsAt: Date | null },
  holdsMinor: bigint,
  status: "ok" | "reached" | "not_checked",
): SpendLimitHit {
  return {
    id: l.id,
    limit: l.id,
    scope: l.scope,
    property_key: l.propertyKey,
    property_value: l.propertyValue,
    interval: l.interval,
    mode: l.mode,
    set_by: l.setBy,
    source: l.source,
    amount_minor: Number(l.amountMinor),
    limit_minor: Number(l.amountMinor),
    spent_minor: Number(m.spentMinor),
    open_holds_minor: Number(holdsMinor),
    resets_at: m.resetsAt ? m.resetsAt.toISOString() : null,
    reached: status === "reached",
    status,
  };
}

/**
 * The access check's spend limits (§3.2 hard): for each applicable hard limit,
 * spent + open holds in scope + estimate (default 1) > amount refuses. Refused → only the
 * tightest refusing limit; else every limit checked, with `not_checked` property limits.
 */
export async function evaluateSpendLimits(
  tx: Tx,
  input: SpendLimitInput,
): Promise<SpendLimitHit[]> {
  if (!(await usageControlsActive(tx, input.businessId))) return [];
  const currency = input.currency.toUpperCase();
  const loaded = await loadCustomerLimits(tx, input.customerId, { mode: "hard", currency });
  if (!loaded.rows.length && !loaded.tiers.get(currency)) return [];
  const items = await liveMeteredItems(tx, { customerId: input.customerId, currency });
  const subIds = input.meterId
    ? [...new Set(items.filter((i) => i.snap.meter?.id === input.meterId).map((i) => i.sub.id))]
    : null;
  const { applicable, notChecked } = resolveApplicable(loaded, {
    meterId: input.meterId,
    subscriptionIds: subIds,
    scope: input.scope,
    currency,
  });
  if (!applicable.length)
    return notChecked.map((l) => hitOf(l, { spentMinor: 0n, resetsAt: null }, 0n, "not_checked"));
  const now = stampNow(input.businessId);
  const tz = await businessTimeZone(tx, input.businessId);
  const cache = newRateCache();
  const subMeters = new Map<string, string[]>();
  for (const i of items)
    if (i.snap.meter)
      subMeters.set(i.sub.id, [...(subMeters.get(i.sub.id) ?? []), i.snap.meter.id]);
  const estimate = input.estimateMinor ?? 1n;
  const holds = await openHolds(tx, input.customerId, currency, now);
  const checked: Array<{ hit: SpendLimitHit; headroom: bigint }> = [];
  for (const l of applicable) {
    const m = await measureLimit(
      tx,
      { businessId: input.businessId, customerId: input.customerId, now, tz, cache },
      l,
    );
    const held = holdsInScope(holds, l, subMeters);
    const headroom = l.amountMinor - (m.spentMinor + held);
    checked.push({ hit: hitOf(l, m, held, headroom - estimate < 0n ? "reached" : "ok"), headroom });
  }
  const refused = checked
    .filter((c) => c.hit.reached)
    .sort((a, b) => (a.headroom < b.headroom ? -1 : a.headroom > b.headroom ? 1 : 0));
  if (refused.length) return [refused[0]!.hit];
  return [
    ...checked.map((c) => c.hit),
    ...notChecked.map((l) => hitOf(l, { spentMinor: 0n, resetsAt: null }, 0n, "not_checked")),
  ];
}

// ── Reached states (on arrival) ──────────────────────────────────────────────────────

/** Distinct values of a property in the customer's events over a window (each-value rows). */
async function propertyValuesSeen(
  tx: Tx,
  input: { businessId: string; customerId: string; key: string; from: Date; to: Date },
): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select distinct properties ->> ${input.key}::text as v from usage_events
    where business_id = ${input.businessId} and customer_id = ${input.customerId}
      and voided_at is null and "timestamp" >= ${input.from.toISOString()}::timestamptz
      and "timestamp" < ${input.to.toISOString()}::timestamptz
      and properties ? ${input.key}::text
    limit 1000`)) as unknown as Array<{ v: string | null }>;
  return rows.map((r) => r.v).filter((v): v is string => v != null);
}

/**
 * For every active limit (hard and soft) of a customer, measure spend and, on reaching the
 * amount, write the state row; the unique (limit, subject, interval start) makes
 * `spend_limit_reached` fire once per interval. Returns the events emitted.
 */
export async function evaluateLimitStates(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    now: Date;
    tz: string;
    cache?: RateCache;
  },
): Promise<number> {
  const loaded = await loadCustomerLimits(tx, input.customerId);
  if (!loaded.rows.length && ![...loaded.tiers.values()].some(Boolean)) return 0;
  const cache = input.cache ?? newRateCache();
  const currencies = new Set([...loaded.rows.map((r) => r.currency), ...loaded.tiers.keys()]);
  const [cust] = await tx
    .select({ publicId: customers.publicId })
    .from(customers)
    .where(eq(customers.id, input.customerId))
    .limit(1);
  let emitted = 0;
  for (const currency of currencies) {
    const base = resolveApplicable(
      { rows: loaded.rows.filter((r) => r.currency === currency), tiers: loaded.tiers },
      { meterId: null, subscriptionIds: null, scope: null, currency },
    );
    const resolved: ResolvedLimit[] = [...base.applicable];
    // Property limits: an exact row is measured for its value; an each-value row for every
    // value seen in its interval that no exact row overrides.
    for (const r of loaded.rows.filter((x) => x.currency === currency && x.scope === "property")) {
      const asR = (v: string): ResolvedLimit => ({
        id: r.publicId,
        limitId: r.id,
        scope: "property",
        subscriptionId: null,
        propertyKey: r.propertyKey,
        propertyValue: v,
        meterIds: r.meterIds,
        interval: r.interval,
        amountMinor: r.amountMinor,
        currency,
        mode: r.mode,
        setBy: r.setBy,
        source: "limit",
      });
      if (r.propertyValue !== null) {
        resolved.push(asR(r.propertyValue));
        continue;
      }
      const w = r.interval === "period" ? null : calendarWindow(r.interval, input.now, input.tz);
      const from = w?.start ?? (await earliestTermStart(tx, input.customerId)) ?? input.now;
      const values = await propertyValuesSeen(tx, {
        businessId: input.businessId,
        customerId: input.customerId,
        key: r.propertyKey!,
        from,
        to: input.now,
      });
      for (const v of values) {
        const overridden = loaded.rows.some(
          (o) =>
            o.scope === "property" &&
            o.propertyKey === r.propertyKey &&
            o.propertyValue === v &&
            o.interval === r.interval &&
            o.mode === r.mode &&
            o.setBy === r.setBy,
        );
        if (!overridden) resolved.push(asR(v));
      }
    }
    for (const l of resolved) {
      if (!l.limitId) continue; // tiers have no state row; their limit refuses at access
      const m = await measureLimit(tx, { ...input, cache }, l);
      if (m.spentMinor < l.amountMinor) continue;
      const [state] = await tx
        .insert(spendLimitStates)
        .values({
          organizationId: input.organizationId,
          businessId: input.businessId,
          limitId: l.limitId,
          subjectKey: subjectKey(l),
          intervalStart: m.windowStart,
          reachedAt: input.now,
        })
        .onConflictDoNothing()
        .returning();
      if (!state) continue;
      await emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "spend_limit_reached",
        data: {
          spend_limit: {
            id: l.id,
            scope: l.scope,
            property_key: l.propertyKey,
            property_value: l.propertyValue,
            interval: l.interval,
            amount_minor: Number(l.amountMinor),
            currency: l.currency,
            mode: l.mode,
            set_by: l.setBy,
          },
          customer: cust?.publicId ?? null,
          mode: l.mode,
          spent_minor: Number(m.spentMinor),
          interval_start: m.windowStart.toISOString(),
          resets_at: m.resetsAt.toISOString(),
        },
      });
      emitted++;
    }
  }
  return emitted;
}

async function earliestTermStart(tx: Tx, customerId: string): Promise<Date | null> {
  const rows = await tx
    .select({ s: subscriptions.currentPeriodStart, e: subscriptions.currentPeriodEnd })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.customerId, customerId),
        inArray(subscriptions.status, ["active", "in_trial"]),
      ),
    );
  const starts = rows
    .map((r) => periodWindow({ currentPeriodStart: r.s, currentPeriodEnd: r.e })?.start)
    .filter((d): d is Date => !!d);
  return starts.length ? new Date(Math.min(...starts.map((d) => d.getTime()))) : null;
}

/** Tier catch-up for one customer in every currency it paid in (the daily `usage_alerts` pass). */
export async function catchUpTiers(
  tx: Tx,
  input: { organizationId: string; businessId: string; customerId: string },
): Promise<number> {
  const rows = (await tx.execute(sql`
    select distinct currency from payments where customer_id = ${input.customerId}
      and status = 'succeeded'`)) as unknown as Array<{ currency: string }>;
  let n = 0;
  for (const r of rows) n += (await evaluateTiers(tx, { ...input, currency: r.currency })).length;
  return n;
}
