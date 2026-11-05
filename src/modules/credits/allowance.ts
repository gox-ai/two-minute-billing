/**
 * Allowance windows (design G3b §3.5, §3.6): a `meter` entitlement with a `reset` counts the
 * usage of its current reset window, not the next invoice's window, and says when it resets.
 * `never` counts all usage since the clock start. An upgrade mid-window follows
 * `allowances.on_upgrade`: a new window from the change, the used count kept, or a limit
 * prorated over the window.
 *
 * `{ same_as_credits: true }` links the allowance to the plan credits: at read time it is the
 * reset of the per-cycle credits on the subscription's own item for that plan (none = `term`),
 * and its windows are that item's clock windows (`windowContext`), pause shifts included, so the
 * pair renews at the same instant. Saving is refused while the plan's active prices give it no
 * single schedule.
 *
 * An allowance with its own reset follows `plan_credits.on_pause` too: `shift` moves its windows
 * by the paused time with the credits' rules (subscription anchor: every later window; calendar:
 * the open window runs on, then a short window to the next boundary). `skip` and
 * `keep_granting` leave its windows as they are: an allowance grants nothing.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { parseFixed12, formatFixed12 } from "@/platform/fixed";
import {
  businesses,
  features,
  planEntitlements,
  prices,
  subscriptionEntitlements,
  subscriptionItems,
  subscriptions,
  type AllowanceReset,
  type CreditReset,
  type PriceGrantsCredit,
} from "@db/schema";
import { readMeterUsage } from "@/modules/metering/read";
import { usageWindowForNextInvoice } from "@/modules/subscriptions/usage-window";
import {
  isCreditsLink,
  normalizeReset,
  pauseShiftOf,
  resetKey,
  windowAt,
  foldPauseShifts,
  type PauseRecord,
  type Reset,
  type ResetWindow,
  type WindowContext,
} from "./reset-windows";
import { loadLegacyPauses, windowContext } from "./credit-clock";

type SubRow = typeof subscriptions.$inferSelect;
type BizRow = Pick<typeof businesses.$inferSelect, "timezone">;
/** The subscription item whose credits clock a linked allowance follows. */
export type CreditsItem = Pick<
  typeof subscriptionItems.$inferSelect,
  "id" | "priceId" | "createdAt"
>;

export interface AllowanceUse {
  /** Decimal string. */
  used: string;
  /** ISO, or null when it never resets. */
  resetsAt: string | null;
  /** The limit to check `used` against (an upgrade may prorate it). */
  limit: string | null;
}

async function meterQuantity(
  tx: Tx,
  input: { customerId: string; meterId: string; start: Date; end: Date },
): Promise<bigint> {
  if (input.end.getTime() <= input.start.getTime()) return 0n;
  try {
    const u = await readMeterUsage(tx, {
      customerId: input.customerId,
      meterId: input.meterId,
      window: { start: input.start, end: input.end },
    });
    return u.segments.flatMap((s) => s.rows).reduce((a, r) => a + r.quantity, 0n);
  } catch (e) {
    if ((e as Error).name === "LevelMeterReadError") return 0n;
    throw e;
  }
}

// ── The credits link ──────────────────────────────────────────────────────────

/** The per-cycle credits reset of a price; null when it grants none; `term` when absent or bad. */
function perCycleReset(gc: PriceGrantsCredit | null | undefined): Reset | null {
  if (gc?.kind !== "per_cycle") return null;
  try {
    return normalizeReset(gc.reset ?? null) ?? { every: "term" };
  } catch {
    return { every: "term" };
  }
}

/** The distinct credits schedules of a plan's active per-cycle prices. */
async function activeCreditSchedules(tx: Tx, productId: string): Promise<Reset[]> {
  const rows = await tx
    .select({ gc: prices.grantsCredit })
    .from(prices)
    .where(and(eq(prices.productId, productId), eq(prices.active, true)));
  const byKey = new Map<string, Reset>();
  for (const r of rows) {
    const reset = perCycleReset(r.gc);
    if (reset) byKey.set(resetKey(reset), reset);
  }
  return [...byKey.values()];
}

const SELECT_SCHEDULE = "Select a schedule for the allowance.";

/** Why a plan's allowance may not follow its credits (an STE message), or null. */
export async function creditsLinkRefusal(tx: Tx, productId: string): Promise<string | null> {
  const schedules = await activeCreditSchedules(tx, productId);
  if (!schedules.length)
    return `We could not save the entitlement. No active price of this plan grants credits each period. ${SELECT_SCHEDULE}`;
  if (schedules.length > 1)
    return `We could not save the entitlement. The plan's prices renew their credits on different schedules. ${SELECT_SCHEDULE}`;
  return null;
}

/** Why a subscription's allowance may not follow its credits, or null. */
export async function subscriptionLinkRefusal(
  tx: Tx,
  subscriptionId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ gc: prices.grantsCredit })
    .from(subscriptionItems)
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .where(eq(subscriptionItems.subscriptionId, subscriptionId));
  return rows.some((r) => r.gc?.kind === "per_cycle")
    ? null
    : `We could not save the entitlement. No price on this subscription grants credits each period. ${SELECT_SCHEDULE}`;
}

/**
 * After a price write: the refusal when the plan has an allowance linked to its credits and its
 * active prices now renew credits on different schedules; null otherwise.
 */
export async function linkedAllowanceConflict(tx: Tx, productId: string): Promise<string | null> {
  const linked = await tx
    .select({ name: features.name })
    .from(planEntitlements)
    .innerJoin(features, eq(features.id, planEntitlements.featureId))
    .where(
      and(
        eq(planEntitlements.productId, productId),
        sql`${planEntitlements.reset}->>'same_as_credits' = 'true'`,
      ),
    )
    .orderBy(features.name);
  if (!linked.length) return null;
  if ((await activeCreditSchedules(tx, productId)).length <= 1) return null;
  return (
    `We could not save the price. The allowance "${linked[0]!.name}" renews with the credits of ` +
    "this plan. With this change, the prices of the plan renew their credits on different " +
    "schedules. Use the same schedule as the other active prices, or select a schedule for the " +
    "allowance."
  );
}

/**
 * The reset an allowance counts on this subscription: a link resolves to the per-cycle credits
 * of the subscription's own item for the plan (`productIds`; empty = any item), an active
 * price first; with none, `term`.
 */
export async function resolveAllowanceReset(
  tx: Tx,
  subscriptionId: string,
  reset: AllowanceReset | null | undefined,
  productIds: readonly string[] = [],
): Promise<CreditReset | null> {
  return (await resolveAllowanceSchedule(tx, subscriptionId, reset, productIds)).reset;
}

/** `resolveAllowanceReset`, with the credits item a link follows (null when not linked). */
export async function resolveAllowanceSchedule(
  tx: Tx,
  subscriptionId: string,
  reset: AllowanceReset | null | undefined,
  productIds: readonly string[] = [],
): Promise<{ reset: CreditReset | null; creditsItem: CreditsItem | null }> {
  if (!isCreditsLink(reset))
    return { reset: (reset as CreditReset | null | undefined) ?? null, creditsItem: null };
  const rows = await tx
    .select({
      active: prices.active,
      gc: prices.grantsCredit,
      id: subscriptionItems.id,
      priceId: subscriptionItems.priceId,
      createdAt: subscriptionItems.createdAt,
    })
    .from(subscriptionItems)
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .where(
      and(
        eq(subscriptionItems.subscriptionId, subscriptionId),
        productIds.length ? inArray(prices.productId, [...productIds]) : undefined,
      ),
    )
    .orderBy(subscriptionItems.createdAt, subscriptionItems.id);
  const own = rows.filter((r) => r.gc?.kind === "per_cycle");
  const pick = own.find((r) => r.active) ?? own[0];
  return {
    reset: (perCycleReset(pick?.gc) ?? { every: "term" }) as CreditReset,
    creditsItem: pick ? { id: pick.id, priceId: pick.priceId, createdAt: pick.createdAt } : null,
  };
}

/**
 * The window context an allowance counts in: a linked one takes its credits item's clock
 * context; one with its own reset takes the subscription's pause shift and its own stored
 * shift (`reset_state.allowance_shifts`, for this reset only). `legacy`: the pause history of a
 * resume that stored no window (`loadLegacyPauses`), replayed when none is stored.
 */
export function allowanceContext(
  sub: SubRow,
  biz: BizRow,
  input: {
    featureId: string;
    reset: Reset;
    creditsItem?: CreditsItem | null;
    legacy?: readonly PauseRecord[] | null;
  },
): WindowContext | null {
  const legacy = input.legacy ? { reset: input.reset, pauses: input.legacy } : null;
  if (input.creditsItem) return windowContext(sub, input.creditsItem, biz, legacy);
  if (!sub.currentPeriodStart || !sub.currentPeriodEnd) return null;
  const own = sub.resetState?.allowance_shifts?.[input.featureId];
  const ctx: WindowContext = {
    termStart: sub.currentPeriodStart,
    termEnd: sub.currentPeriodEnd,
    timeZone: biz.timezone ?? "UTC",
    clockStart: sub.startedAt ?? sub.createdAt,
    shiftMs: sub.resetState?.shift_ms ?? 0,
    pauseShift:
      own && own.reset === resetKey(input.reset)
        ? { start: new Date(own.start), end: new Date(own.end) }
        : null,
  };
  if (!ctx.pauseShift && legacy)
    ctx.pauseShift = foldPauseShifts(legacy.reset, ctx, legacy.pauses).pauseShift ?? null;
  return ctx;
}

/** The allowance's reset window at `now`, or null when it has no reset of its own. */
export async function allowanceWindow(
  tx: Tx,
  sub: SubRow,
  reset: CreditReset | null | undefined,
  now: Date,
  opts: { featureId?: string; creditsItem?: CreditsItem | null } = {},
): Promise<ResetWindow | null> {
  let r;
  try {
    r = normalizeReset(reset ?? null);
  } catch {
    return null;
  }
  if (!r) return null;
  const [biz] = await tx
    .select({ timezone: businesses.timezone })
    .from(businesses)
    .where(eq(businesses.id, sub.businessId))
    .limit(1);
  const ctx = allowanceContext(sub, biz ?? { timezone: "UTC" }, {
    featureId: opts.featureId ?? "",
    reset: r,
    creditsItem: opts.creditsItem,
    legacy: await loadLegacyPauses(tx, sub),
  });
  return ctx ? windowAt(r, now, ctx) : null;
}

/**
 * At a resume under `shift` (in the resume's transaction, before `shift_ms` grows): the moved
 * open window of every allowance with its own reset on the subscription, by feature id. A
 * linked allowance is left out: it reads its credits item's shift.
 */
export async function allowancePauseShifts(
  tx: Tx,
  sub: SubRow,
  biz: BizRow,
  pausedAt: Date,
  pausedMs: number,
  legacy: readonly PauseRecord[] | null = null,
): Promise<NonNullable<NonNullable<SubRow["resetState"]>["allowance_shifts"]>> {
  const out = { ...(sub.resetState?.allowance_shifts ?? {}) };
  const plan = await tx
    .selectDistinct({ featureId: planEntitlements.featureId, reset: planEntitlements.reset })
    .from(planEntitlements)
    .innerJoin(features, eq(features.id, planEntitlements.featureId))
    .innerJoin(prices, eq(prices.productId, planEntitlements.productId))
    .innerJoin(subscriptionItems, eq(subscriptionItems.priceId, prices.id))
    .where(
      and(
        eq(subscriptionItems.subscriptionId, sub.id),
        eq(features.type, "meter"),
        eq(features.active, true),
        sql`${planEntitlements.reset} is not null`,
      ),
    );
  const over = await tx
    .select({
      featureId: subscriptionEntitlements.featureId,
      reset: subscriptionEntitlements.reset,
    })
    .from(subscriptionEntitlements)
    .innerJoin(features, eq(features.id, subscriptionEntitlements.featureId))
    .where(
      and(
        eq(subscriptionEntitlements.subscriptionId, sub.id),
        eq(features.type, "meter"),
        eq(features.active, true),
      ),
    );
  // The override's reset beats the plan's, as `meterFeature` reads it.
  const byFeature = new Map<string, AllowanceReset | null>();
  for (const p of plan) if (!byFeature.has(p.featureId)) byFeature.set(p.featureId, p.reset);
  for (const o of over) if (o.reset) byFeature.set(o.featureId, o.reset);
  for (const [featureId, stored] of byFeature) {
    if (!stored || isCreditsLink(stored)) continue;
    let r: Reset | null;
    try {
      r = normalizeReset(stored);
    } catch {
      continue;
    }
    if (!r) continue;
    const ctx = allowanceContext(sub, biz, { featureId, reset: r, legacy });
    const moved = ctx ? pauseShiftOf(r, ctx, pausedAt, pausedMs) : null;
    if (moved)
      out[featureId] = {
        reset: resetKey(r),
        start: moved.start.toISOString(),
        end: moved.end.toISOString(),
      };
  }
  return out;
}

/**
 * What a meter allowance has used and when it resets. With no reset: the next invoice's
 * window, as before (G3 / 0467). `value` is the granted limit ("unlimited" or a number).
 */
export async function allowanceUse(
  tx: Tx,
  input: {
    customerId: string;
    meterId: string;
    subscription: SubRow;
    featureId: string;
    value: string | null;
    reset: CreditReset | null | undefined;
    /** A linked allowance: the credits item whose windows it counts. */
    creditsItem?: CreditsItem | null;
    now: Date;
  },
): Promise<AllowanceUse> {
  const sub = input.subscription;
  const w = await allowanceWindow(tx, sub, input.reset, input.now, {
    featureId: input.featureId,
    creditsItem: input.creditsItem,
  });
  let start: Date | null;
  let end: Date | null;
  let resetsAt: string | null;
  if (w) {
    start = w.start;
    end = w.end ?? new Date(input.now.getTime() + 5 * 60_000);
    resetsAt = w.end ? w.end.toISOString() : null;
  } else {
    const nw = await usageWindowForNextInvoice(tx, sub);
    start = nw?.start ?? sub.currentPeriodStart;
    end = nw?.end ?? sub.currentPeriodEnd;
    resetsAt = end ? end.toISOString() : null;
  }
  if (!start || !end) return { used: "0", resetsAt: null, limit: input.value };
  let limit = input.value;
  // An upgrade inside this window (§6.4).
  const change = sub.resetState?.allowance_changes?.[input.featureId];
  const at = change ? new Date(change.at) : null;
  if (change && at && at.getTime() > start.getTime() && at.getTime() < end.getTime()) {
    if (change.mode === "new_window") start = at;
    else if (change.mode === "prorated" && limit !== "unlimited" && limit != null) {
      const oldN = Number.parseInt(change.old_value, 10);
      const newN = Number.parseInt(limit, 10);
      if (change.old_value !== "unlimited" && Number.isFinite(oldN) && Number.isFinite(newN)) {
        const len = end.getTime() - start.getTime();
        const before = at.getTime() - start.getTime();
        limit = String(Math.floor((oldN * before + newN * (len - before)) / len));
      }
    }
  }
  const used = await meterQuantity(tx, {
    customerId: input.customerId,
    meterId: input.meterId,
    start,
    end,
  });
  return { used: formatFixed12(used), resetsAt, limit };
}

/** used + need ≤ limit; "unlimited" always fits. */
export function allowanceFits(limit: string | null, used: string, need = "1"): boolean {
  if (limit == null) return false;
  if (limit === "unlimited") return true;
  const n = Number.parseInt(limit, 10);
  if (!Number.isFinite(n)) return false;
  return parseFixed12(used) + parseFixed12(need) <= parseFixed12(String(n));
}
