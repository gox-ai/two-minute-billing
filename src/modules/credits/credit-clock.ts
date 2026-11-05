/**
 * The credit clock (design G3b §3.3, §3.5, §3.6, §6): plan credits on a reset other than the
 * term are granted one window at a time, here and nowhere else. The term invoice keeps granting
 * `term` items (`plan-credits.ts`).
 *
 * - One grant per item, price and window start (`windowRef`, unique), so the job, the readers
 *   (`ensureCreditWindows`), the invoice and a plan change grant each window once.
 * - `subscription_items.next_credit_reset_at` is the next window start; the job scans its index.
 * - At each window start the closing grant rolls over (§3.5) on what its own window's usage
 *   leaves (a simulated drawdown: that usage is billed later); the rest expires through the
 *   expiry pass once no open invoice window can still draw it.
 */
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { scanBusinessFilter } from "@/platform/clock";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import {
  businesses,
  creditGrants,
  events,
  prices,
  subscriptionItems,
  subscriptions,
  type PriceGrantsCredit,
  type SubscriptionResetState,
} from "@db/schema";
import { lockCustomerBalances } from "@/modules/customers/balances-read";
import {
  creditUnitByKey,
  grantRemaining,
  insertCreditGrant,
  recordGrantMovement,
  unitRate,
} from "./service";
import { faceMinorFor, stepsForMinor } from "./units";
import {
  calendarWindowOfShort,
  endAfterWindows,
  foldPauseShifts,
  isTermReset,
  normalizeReset,
  pauseShiftOf,
  prorateForRest,
  windowAt,
  windowRef,
  windowRollRef,
  type PauseRecord,
  type Reset,
  type ResetWindow,
  type WindowContext,
} from "./reset-windows";
import {
  readResetSettings,
  withResetOverrides,
  type ResetOverrides,
  type PlanCreditCancelAtPeriodEnd,
  type PlanCreditPause,
  type ResetSettings,
} from "./reset-settings";

const log = createLogger("credits.clock");

type PerCycle = Extract<PriceGrantsCredit, { kind: "per_cycle" }>;
type SubRow = typeof subscriptions.$inferSelect;
type ItemRow = typeof subscriptionItems.$inferSelect;
type PriceRow = typeof prices.$inferSelect;
type BizRow = Pick<typeof businesses.$inferSelect, "id" | "timezone" | "billingRulesConfig">;

/** A cursor that never comes due: a `never` item after its one grant. */
export const NEVER_AGAIN = new Date("9999-01-01T00:00:00Z");
/** Statuses whose items keep a clock. */
const CLOCK_STATUSES = ["active", "paused", "in_trial"] as const;
const MAX_WINDOWS_PER_RUN = 400;

/** The item's reset, or null when it grants per term (or grants no plan credits). */
export function itemReset(gc: PriceGrantsCredit | null | undefined): Reset | null {
  if (gc?.kind !== "per_cycle") return null;
  try {
    const r = normalizeReset(gc.reset ?? null);
    return isTermReset(r) ? null : r;
  } catch {
    return null;
  }
}

/**
 * The item's window context. `legacy`: the pause history of a resume that stored no window
 * (`loadLegacyPauses`), replayed for this reset when the item has none stored.
 */
export function windowContext(
  sub: Pick<SubRow, "currentPeriodStart" | "currentPeriodEnd" | "resetState">,
  item: Pick<ItemRow, "createdAt" | "id" | "priceId">,
  biz: Pick<BizRow, "timezone">,
  legacy?: { reset: Reset | null; pauses: readonly PauseRecord[] } | null,
): WindowContext | null {
  if (!sub.currentPeriodStart || !sub.currentPeriodEnd) return null;
  // A pause window belongs to the price it was cut for; a plan change drops it. The old key
  // `calendar_shifts` is still read.
  const rs = sub.resetState;
  const pw = rs?.pause_windows?.[item.id] ?? rs?.calendar_shifts?.[item.id];
  const ctx: WindowContext = {
    termStart: sub.currentPeriodStart,
    termEnd: sub.currentPeriodEnd,
    timeZone: biz.timezone ?? "UTC",
    clockStart: item.createdAt,
    shiftMs: rs?.shift_ms ?? 0,
    pauseShift:
      pw && pw.price_id === item.priceId
        ? { start: new Date(pw.start), end: new Date(pw.end) }
        : null,
  };
  if (!ctx.pauseShift && legacy)
    ctx.pauseShift = foldPauseShifts(legacy.reset, ctx, legacy.pauses).pauseShift ?? null;
  return ctx;
}

/** A resume older than stored pause windows: a shift total, and no window for any item. */
const isLegacyShift = (rs: SubRow["resetState"]) =>
  !!rs && (rs.shift_ms ?? 0) > 0 && rs.pause_windows === undefined && !rs.paused_at;

/**
 * The shifted pauses of the current term, for a subscription resumed before pause windows were
 * stored (null otherwise). `reset_state` keeps no pause instant once resumed, so they come from
 * the `subscription_paused` / `subscription_resumed` events; the last pause takes the rest of
 * `shift_ms`, so the total is exact. Null, with a warning, when the events do not account for
 * `shift_ms`: the windows then step from the shift total alone.
 */
export async function loadLegacyPauses(
  tx: Tx,
  sub: Pick<SubRow, "id" | "publicId" | "businessId" | "currentPeriodStart" | "resetState">,
): Promise<PauseRecord[] | null> {
  if (!isLegacyShift(sub.resetState) || !sub.currentPeriodStart) return null;
  const rows = await tx
    .select({ type: events.type, at: events.createdAt })
    .from(events)
    .where(
      and(
        eq(events.businessId, sub.businessId),
        eq(events.resourceType, "subscription"),
        eq(events.resourceId, sub.publicId),
        inArray(events.type, ["subscription_paused", "subscription_resumed"]),
        gte(events.createdAt, sub.currentPeriodStart),
      ),
    )
    .orderBy(asc(events.createdAt));
  const pauses: PauseRecord[] = [];
  let open: Date | null = null;
  for (const r of rows) {
    if (r.type === "subscription_paused") open ??= r.at;
    else if (open) {
      pauses.push({ at: open, ms: r.at.getTime() - open.getTime() });
      open = null;
    }
  }
  const total = sub.resetState!.shift_ms!;
  const last = pauses.at(-1);
  const rest = last ? total - pauses.slice(0, -1).reduce((a, p) => a + p.ms, 0) : 0;
  if (!last || rest <= 0 || Math.abs(rest - last.ms) > 60_000) {
    log.warn("pause windows not derived: no pause record matches shift_ms", {
      subscriptionId: sub.id,
      shiftMs: total,
      pauses: pauses.length,
    });
    return null;
  }
  last.ms = rest;
  return pauses;
}

const subStartOf = (sub: SubRow) => sub.startedAt ?? sub.activatedAt ?? sub.createdAt;

async function setCursor(tx: Tx, itemId: string, at: Date | null) {
  await tx
    .update(subscriptionItems)
    .set({ nextCreditResetAt: at })
    .where(eq(subscriptionItems.id, itemId));
}

/**
 * Grant every window of one item that has started by `now` and is not granted yet, then move
 * its cursor. Caller holds `lockCustomerBalances` for the customer.
 */
export async function advanceItemClock(
  tx: Tx,
  input: { sub: SubRow; item: ItemRow; price: PriceRow; biz: BizRow; now: Date },
): Promise<{ granted: number; skipped: number }> {
  const { sub, item, price, biz, now } = input;
  const out = { granted: 0, skipped: 0 };
  const reset = itemReset(price.grantsCredit);
  if (!reset) {
    if (item.nextCreditResetAt) await setCursor(tx, item.id, null);
    return out;
  }
  if (!(CLOCK_STATUSES as readonly string[]).includes(sub.status) || sub.deletedAt) {
    if (item.nextCreditResetAt) await setCursor(tx, item.id, null);
    return out;
  }
  const ctx = windowContext(sub, item, biz);
  if (!ctx || sub.status === "in_trial") {
    // A trial grants nothing (G3 §3.6); the conversion's renewal starts the clock.
    const wake = sub.trialEnd ?? null;
    if (String(item.nextCreditResetAt) !== String(wake)) await setCursor(tx, item.id, wake);
    return out;
  }
  const settings = readResetSettings(biz);
  const gc = price.grantsCredit as PerCycle;
  const calendar = (reset.anchor ?? "subscription") === "calendar";
  const cursor = item.nextCreditResetAt;
  if (cursor && cursor.getTime() > now.getTime()) return out; // not due
  let w: ResetWindow = windowAt(reset, cursor ?? now, ctx);
  let next: Date | null = null;
  for (let i = 0; i < MAX_WINDOWS_PER_RUN; i++) {
    if (w.start.getTime() > now.getTime()) {
      next = w.start;
      break;
    }
    // A window past the term waits for the renewal (it moves the term).
    if (w.start.getTime() >= ctx.termEnd.getTime()) {
      next = w.start;
      break;
    }
    const verdict = gate(sub, w, settings);
    if (verdict === "wait") {
      next = w.start;
      break;
    }
    if (verdict === "grant") {
      const done = await grantWindow(tx, { sub, item, price, gc, reset, w, ctx, settings, now });
      if (done) out.granted++;
    } else out.skipped++;
    if (!w.end) {
      next = NEVER_AGAIN;
      break;
    }
    if (!calendar && w.end.getTime() >= ctx.termEnd.getTime()) {
      // The next term's first window starts at its own term start.
      next = ctx.termEnd;
      break;
    }
    w = windowAt(reset, w.end, ctx);
  }
  if (!next) next = w.start;
  if (String(item.nextCreditResetAt) !== String(next)) await setCursor(tx, item.id, next);
  return out;
}

/** The pause rule: the one the pause call sent, else the business rule. */
const pauseRuleOf = (sub: Pick<SubRow, "resetState">, s: ResetSettings): PlanCreditPause =>
  sub.resetState?.pause_rule ?? s.planCredits.onPause;

/** The cancel rule: the one the pending cancel's call sent, else the business rule. */
export function cancelRuleOf(
  sub: Pick<SubRow, "resetState" | "cancelBookedAt">,
  s: ResetSettings,
): PlanCreditCancelAtPeriodEnd {
  const r = sub.resetState?.cancel_rule;
  return r && sub.cancelBookedAt && new Date(r.booked_at).getTime() === sub.cancelBookedAt.getTime()
    ? r.value
    : s.planCredits.onCancelAtPeriodEnd;
}

/** Whether a window that has started is granted, skipped, or waits (§6 pause and cancel). */
function gate(sub: SubRow, w: ResetWindow, s: ResetSettings): "grant" | "skip" | "wait" {
  const onPause = pauseRuleOf(sub, s);
  if (sub.status === "paused") {
    if (onPause === "keep_granting") return "grant";
    if (onPause === "shift") return "wait";
    return "skip";
  }
  const pausedAt = sub.resetState?.paused_at ? new Date(sub.resetState.paused_at) : null;
  if (pausedAt && w.start.getTime() >= pausedAt.getTime() && onPause === "skip") return "skip";
  if (sub.cancelAtPeriodEnd || sub.cancelScheduledAt) {
    if (cancelRuleOf(sub, s) === "stop_at_request") return "skip";
    if (sub.cancelScheduledAt && w.start.getTime() >= sub.cancelScheduledAt.getTime())
      return "skip";
  }
  return "grant";
}

/** Grant one window (rolling the closing one first). False when it was already granted. */
async function grantWindow(
  tx: Tx,
  input: {
    sub: SubRow;
    item: ItemRow;
    price: PriceRow;
    gc: PerCycle;
    reset: Reset;
    w: ResetWindow;
    ctx: WindowContext;
    settings: ResetSettings;
    now: Date;
    /** A plan change: the grant starts here, with this amount rule. */
    change?: { at: Date; rule: "full" | "prorated" };
  },
): Promise<boolean> {
  const { sub, item, price, gc, reset, w } = input;
  const ref = windowRef(item.id, price.id, w.start);
  const [done] = await tx
    .select({ id: creditGrants.id })
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.businessId, sub.businessId),
        eq(creditGrants.source, "plan_cycle"),
        eq(creditGrants.sourceRef, ref),
      ),
    )
    .limit(1);
  if (done) return false;
  const unit = gc.unit ? await creditUnitByKey(tx, sub.businessId, gc.unit) : null;
  if (reset.every !== "never" && gc.rollover?.mode === "carry" && !input.change)
    await rollClosing(tx, { ...input, unit });

  let amount = BigInt(gc.amount) * BigInt(Math.max(1, item.quantity ?? 1));
  let effectiveAt = w.start;
  if (input.change) {
    effectiveAt = input.change.at.getTime() > w.start.getTime() ? input.change.at : w.start;
    if (input.change.rule === "prorated") amount = prorateForRest(amount, w, input.change.at);
  } else {
    // A calendar window that starts before the subscription is a partial first window; the
    // short window after a calendar pause shift follows the same rule, prorated over its month.
    const start = subStartOf(sub);
    const short = calendarWindowOfShort(reset, w, input.ctx);
    if (short || (reset.anchor === "calendar" && w.start.getTime() < start.getTime())) {
      const rule = gc.first_window ?? input.settings.planCredits.firstWindow;
      if (rule === "next_full_window") return false;
      if (rule === "prorated")
        amount = short ? prorateForRest(amount, short, w.start) : prorateForRest(amount, w, start);
    }
  }
  if (amount <= 0n) return false;
  if (w.end && w.end.getTime() <= effectiveAt.getTime()) return false;
  await insertCreditGrant(tx, {
    organizationId: sub.organizationId,
    businessId: sub.businessId,
    customerId: sub.customerId,
    currency: unit?.currency ?? sub.currency,
    unit,
    amount,
    category: "promotional",
    priority: gc.priority ?? 50,
    effectiveAt,
    expiresAt: w.end,
    applicability: gc.applicability ?? { kind: "metered" },
    source: "plan_cycle",
    sourceRef: ref,
    subscriptionItemId: item.id,
    onExhausted: gc.on_exhausted ?? null,
    metadata: { reset: reset as unknown as Record<string, unknown> },
  });
  return true;
}

/**
 * Roll the grant that closes at `w.start` (§3.5): floor(left × percent ÷ 100), capped, where
 * left = remaining − what its own window's unbilled usage will still draw. Never twice.
 */
async function rollClosing(
  tx: Tx,
  input: {
    sub: SubRow;
    item: ItemRow;
    price: PriceRow;
    gc: PerCycle;
    reset: Reset;
    w: ResetWindow;
    ctx: WindowContext;
    unit: Awaited<ReturnType<typeof creditUnitByKey>>;
  },
): Promise<void> {
  const { sub, item, price, gc, reset, w, ctx, unit } = input;
  const roll = gc.rollover!;
  const closing = await tx
    .select()
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.subscriptionItemId, item.id),
        eq(creditGrants.source, "plan_cycle"),
        eq(creditGrants.status, "active"),
        eq(creditGrants.expiresAt, w.start),
        sql`${creditGrants.sourceRef} like ${`${item.id}:w:%`}`,
        sql`coalesce(${creditGrants.metadata}->>'ended_by_change', '') = ''`,
      ),
    )
    .for("update");
  for (const g of closing) {
    const [rolled] = await tx
      .select({ id: creditGrants.id })
      .from(creditGrants)
      .where(
        and(
          eq(creditGrants.businessId, sub.businessId),
          eq(creditGrants.source, "plan_cycle"),
          sql`${creditGrants.metadata}->>'rolled_from' = ${g.id}`,
        ),
      )
      .limit(1);
    if (rolled) continue;
    const left = (await grantRemaining(tx, [g.id])).get(g.id)!;
    const pending = await pendingDraw(tx, sub, g.id, g.currency, w.start);
    const rate = unitRate(unit);
    const pendingUnits = pending >= left.face ? left.units : stepsForMinor(pending, rate);
    const leftUnits = left.units - (pendingUnits > left.units ? left.units : pendingUnits);
    const leftFace = left.face - (pending > left.face ? left.face : pending);
    let carry = (leftUnits * BigInt(roll.percent ?? 100)) / 100n;
    if (roll.cap != null && carry > BigInt(roll.cap)) carry = BigInt(roll.cap);
    if (carry <= 0n) continue;
    let face = carry === leftUnits ? leftFace : faceMinorFor(carry, rate);
    if (face > leftFace) face = leftFace;
    if (face <= 0n) continue;
    const cycles = roll.expire_after_cycles === undefined ? 1 : roll.expire_after_cycles;
    const expiresAt =
      cycles == null ? null : endAfterWindows(reset, windowAt(reset, w.start, ctx), cycles, ctx);
    await recordGrantMovement(tx, {
      grant: g,
      kind: "rollover_out",
      units: -carry,
      faceMinor: -face,
    });
    await insertCreditGrant(tx, {
      organizationId: sub.organizationId,
      businessId: sub.businessId,
      customerId: sub.customerId,
      currency: g.currency,
      unit,
      amount: carry,
      faceMinor: face,
      category: "promotional",
      priority: g.priority,
      effectiveAt: w.start,
      expiresAt,
      applicability: g.applicability,
      source: "plan_cycle",
      sourceRef: windowRollRef(item.id, price.id, w.start),
      subscriptionItemId: item.id,
      onExhausted: g.onExhausted,
      metadata: { rolled_from: g.id },
      opening: { kind: "rollover_in", ledger: false },
    });
  }
}

/** Money the customer's unbilled usage up to `asOf` will still draw from grant `grantId`. */
async function pendingDraw(
  tx: Tx,
  sub: SubRow,
  grantId: string,
  currency: string,
  asOf: Date,
): Promise<bigint> {
  const { loadBalanceSnapshot, simulateDrawdown, toPlanner } = await import("./balance");
  const { ratedUnbilledUsage } = await import("./usage");
  const { sliceUsageLines } = await import("./slices");
  const snap = await loadBalanceSnapshot(tx, { customerId: sub.customerId, currency, now: asOf });
  const usage = await ratedUnbilledUsage(tx, { customerId: sub.customerId, currency, asOf });
  const sliced = await sliceUsageLines(tx, sub.customerId, usage, snap.grants.map(toPlanner));
  return simulateDrawdown(snap.grants, sliced).get(grantId) ?? 0n;
}

// ── Readers and the job ───────────────────────────────────────────────────────

/** Items of the customer's live subscriptions whose clock is due (or not started). */
async function dueItems(tx: Tx, customerId: string, now: Date) {
  return tx
    .select({ sub: subscriptions, item: subscriptionItems, price: prices })
    .from(subscriptionItems)
    .innerJoin(subscriptions, eq(subscriptions.id, subscriptionItems.subscriptionId))
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .where(
      and(
        eq(subscriptions.customerId, customerId),
        inArray(subscriptions.status, [...CLOCK_STATUSES]),
        or(
          lte(subscriptionItems.nextCreditResetAt, now),
          and(
            isNull(subscriptionItems.nextCreditResetAt),
            sql`${prices.grantsCredit}->>'kind' = 'per_cycle'`,
            sql`coalesce(${prices.grantsCredit}->'reset'->>'every', 'term') <> 'term'`,
          ),
        ),
      ),
    )
    .orderBy(subscriptionItems.createdAt, subscriptionItems.id);
}

/**
 * Grant every window that is due for this customer, so a reader that needs a balance now
 * never reads an under-granted one when the job is late. Cheap when nothing is due.
 */
export async function ensureCreditWindows(
  tx: Tx,
  input: { customerId: string; now: Date },
): Promise<{ granted: number }> {
  const rows = await dueItems(tx, input.customerId, input.now);
  if (!rows.length) return { granted: 0 };
  await lockCustomerBalances(tx, input.customerId);
  const bizIds = [...new Set(rows.map((r) => r.sub.businessId))];
  const bizRows = await tx
    .select({
      id: businesses.id,
      timezone: businesses.timezone,
      billingRulesConfig: businesses.billingRulesConfig,
    })
    .from(businesses)
    .where(inArray(businesses.id, bizIds));
  let granted = 0;
  for (const r of rows) {
    const biz = bizRows.find((b) => b.id === r.sub.businessId);
    if (!biz) continue;
    // Re-read under the lock: a concurrent run may have moved the cursor.
    const [item] = await tx
      .select()
      .from(subscriptionItems)
      .where(eq(subscriptionItems.id, r.item.id))
      .limit(1);
    if (!item) continue;
    granted += (
      await advanceItemClock(tx, { sub: r.sub, item, price: r.price, biz, now: input.now })
    ).granted;
  }
  return { granted };
}

/** The `plan_credit_resets` job: every customer with a due item cursor (index scan). */
export async function runPlanCreditResets(
  now: Date,
): Promise<{ customers: number; granted: number }> {
  const due = await systemDb
    .selectDistinct({
      organizationId: subscriptionItems.organizationId,
      customerId: subscriptions.customerId,
    })
    .from(subscriptionItems)
    .innerJoin(subscriptions, eq(subscriptions.id, subscriptionItems.subscriptionId))
    .where(
      and(
        isNotNull(subscriptionItems.nextCreditResetAt),
        lte(subscriptionItems.nextCreditResetAt, now),
        scanBusinessFilter(subscriptionItems.businessId),
      ),
    )
    .limit(500);
  let granted = 0;
  for (const d of due) {
    try {
      granted += (
        await withTenant(d.organizationId, (tx) =>
          ensureCreditWindows(tx, { customerId: d.customerId, now }),
        )
      ).granted;
    } catch (e) {
      log.error(e, { event: "plan_credit_reset_failed", customerId: d.customerId });
    }
  }
  if (due.length) log.info("plan credit windows granted", { customers: due.length, granted });
  return { customers: due.length, granted };
}

// ── Plan changes (§3.6), pause and resume (§6) ────────────────────────────────

/** A recurring amount per month, for upgrade or downgrade. */
function monthlyMinor(price: PriceRow, quantity: number): number {
  const amt = Number(price.amountMinor ?? 0) * Math.max(1, quantity);
  const n = price.intervalCount ?? 1;
  const months =
    price.interval === "year"
      ? 12 * n
      : price.interval === "week"
        ? (7 * n) / 30
        : price.interval === "day"
          ? n / 30
          : n;
  return months > 0 ? amt / months : amt;
}

/**
 * After a plan change moved items to new prices (in the change's transaction): per the
 * business settings, the old price's open window grant ends at the change, and the new price's
 * window that holds the change is granted at once (in full or prorated), or from the next
 * window. A term reset re-grants through the term invoice, so term items are left to it.
 */
export async function applyPlanChangeCredits(
  tx: Tx,
  input: {
    subscriptionId: string;
    now: Date;
    termReset: boolean;
    changes: Array<{ itemId: string; oldPriceId: string; oldQuantity: number }>;
    /** This change's own rules; omitted keys follow the business. */
    overrides?: ResetOverrides;
  },
): Promise<void> {
  if (!input.changes.length) return;
  const [sub] = await tx
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, input.subscriptionId))
    .limit(1);
  if (!sub) return;
  const [biz] = await tx
    .select({
      id: businesses.id,
      timezone: businesses.timezone,
      billingRulesConfig: businesses.billingRulesConfig,
    })
    .from(businesses)
    .where(eq(businesses.id, sub.businessId))
    .limit(1);
  if (!biz) return;
  const settings = withResetOverrides(readResetSettings(biz), input.overrides);
  await lockCustomerBalances(tx, sub.customerId);
  await recordAllowanceUpgrades(tx, sub, input.changes, input.now, settings);
  for (const c of input.changes) {
    const [row] = await tx
      .select({ item: subscriptionItems, price: prices })
      .from(subscriptionItems)
      .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
      .where(eq(subscriptionItems.id, c.itemId))
      .limit(1);
    const [old] = await tx.select().from(prices).where(eq(prices.id, c.oldPriceId)).limit(1);
    if (!row || !old || old.id === row.price.id) continue;
    const oldGc = old.grantsCredit?.kind === "per_cycle" ? old.grantsCredit : null;
    const newGc = row.price.grantsCredit?.kind === "per_cycle" ? row.price.grantsCredit : null;
    if (!oldGc && !newGc) continue;
    const newReset = itemReset(newGc);
    const oldReset = itemReset(oldGc);
    if (input.termReset && !newReset && !oldReset) continue;
    const up = monthlyMinor(row.price, row.item.quantity) >= monthlyMinor(old, c.oldQuantity);
    const rule = up ? settings.planCredits.onUpgrade : settings.planCredits.onDowngrade;
    if (rule === "next_window") {
      // The old grant runs to its window end; the new price starts at its next window.
      if (newReset) {
        const ctx = windowContext(sub, row.item, biz);
        const w = ctx ? windowAt(newReset, input.now, ctx) : null;
        await setCursor(tx, row.item.id, w?.end ?? null);
      }
      continue;
    }
    // The old price's open grant(s) end at the change.
    await tx
      .update(creditGrants)
      .set({
        expiresAt: input.now,
        metadata: sql`coalesce(${creditGrants.metadata}, '{}'::jsonb) || '{"ended_by_change": true}'::jsonb`,
      })
      .where(
        and(
          eq(creditGrants.subscriptionItemId, row.item.id),
          eq(creditGrants.source, "plan_cycle"),
          eq(creditGrants.status, "active"),
          lte(creditGrants.effectiveAt, input.now),
          or(isNull(creditGrants.expiresAt), gt(creditGrants.expiresAt, input.now)),
          sql`${creditGrants.sourceRef} not like ${`${row.item.id}:wroll:%`}`,
          sql`${creditGrants.sourceRef} not like ${`${row.item.id}:rollover:%`}`,
        ),
      );
    if (!newGc || input.termReset) {
      if (newReset) await setCursor(tx, row.item.id, input.now);
      continue;
    }
    const ctx = windowContext(sub, row.item, biz);
    if (!ctx) continue;
    const reset = newReset ?? ({ every: "term" } as Reset);
    const w = windowAt(reset, input.now, ctx);
    await grantWindow(tx, {
      sub,
      item: row.item,
      price: row.price,
      gc: newGc,
      reset,
      w,
      ctx,
      settings,
      now: input.now,
      change: { at: input.now, rule: rule === "prorated" ? "prorated" : "full" },
    });
    await setCursor(tx, row.item.id, newReset ? (w.end ?? NEVER_AGAIN) : null);
  }
}

/**
 * Whether a plan change's credit and allowance rules have anything to act on: a moved item
 * whose old or new price grants credits per cycle, or whose new plan changes a meter
 * allowance. Public ids in, as `/change` takes them.
 */
export async function planChangeResetScope(
  tx: Tx,
  subscriptionId: string,
  changes: Array<{ itemId: string; newPriceId?: string }>,
): Promise<{ planCredits: boolean; allowances: boolean }> {
  const out = { planCredits: false, allowances: false };
  const moving = changes.filter((c): c is { itemId: string; newPriceId: string } => !!c.newPriceId);
  if (!moving.length) return out;
  const rows = await tx
    .select({ itemId: subscriptionItems.publicId, price: prices })
    .from(subscriptionItems)
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .where(
      and(
        eq(subscriptionItems.subscriptionId, subscriptionId),
        inArray(
          subscriptionItems.publicId,
          moving.map((c) => c.itemId),
        ),
      ),
    );
  if (!rows.length) return out;
  const fresh = await tx
    .select()
    .from(prices)
    .where(
      and(
        eq(prices.businessId, rows[0]!.price.businessId),
        inArray(
          prices.publicId,
          moving.map((c) => c.newPriceId),
        ),
      ),
    );
  for (const c of moving) {
    const old = rows.find((r) => r.itemId === c.itemId)?.price;
    const nw = fresh.find((p) => p.publicId === c.newPriceId);
    if (!old || !nw || old.id === nw.id) continue;
    if (old.grantsCredit?.kind === "per_cycle" || nw.grantsCredit?.kind === "per_cycle")
      out.planCredits = true;
    if (out.allowances || old.productId === nw.productId) continue;
    const moved = (await tx.execute(sql`
      select 1 from features f
      join plan_entitlements n on n.feature_id = f.id and n.product_id = ${nw.productId}
      left join plan_entitlements o on o.feature_id = f.id and o.product_id = ${old.productId}
      where f.type = 'meter' and f.meter_id is not null
        and coalesce(o.value, '0') <> n.value and coalesce(o.value, '0') <> 'unlimited'
        and not exists (select 1 from subscription_entitlements se
          where se.subscription_id = ${subscriptionId} and se.feature_id = f.id)
      limit 1`)) as unknown as unknown[];
    if (moved.length) out.allowances = true;
  }
  return out;
}

/**
 * An upgrade that raises a meter allowance mid-window: note it, so the check counts per
 * `allowances.on_upgrade` (a new window from here, the used count kept, or a prorated limit).
 * A feature with a subscription override is not moved by a plan change.
 */
async function recordAllowanceUpgrades(
  tx: Tx,
  sub: SubRow,
  changes: Array<{ itemId: string; oldPriceId: string; oldQuantity: number }>,
  now: Date,
  settings: ResetSettings,
): Promise<void> {
  const rows = await tx
    .select({ item: subscriptionItems, price: prices })
    .from(subscriptionItems)
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .where(
      inArray(
        subscriptionItems.id,
        changes.map((c) => c.itemId),
      ),
    );
  const oldPrices = await tx
    .select()
    .from(prices)
    .where(
      inArray(
        prices.id,
        changes.map((c) => c.oldPriceId),
      ),
    );
  const allowance_changes = { ...(sub.resetState?.allowance_changes ?? {}) };
  let touched = false;
  for (const c of changes) {
    const row = rows.find((r) => r.item.id === c.itemId);
    const old = oldPrices.find((p) => p.id === c.oldPriceId);
    if (!row || !old || old.productId === row.price.productId) continue;
    if (monthlyMinor(row.price, row.item.quantity) < monthlyMinor(old, c.oldQuantity)) continue;
    const ents = (await tx.execute(sql`
      select f.id as feature_id, o.value as old_value, n.value as new_value
      from features f
      join plan_entitlements n on n.feature_id = f.id and n.product_id = ${row.price.productId}
      left join plan_entitlements o on o.feature_id = f.id and o.product_id = ${old.productId}
      where f.type = 'meter' and f.meter_id is not null
        and not exists (select 1 from subscription_entitlements se
          where se.subscription_id = ${sub.id} and se.feature_id = f.id)`)) as unknown as Array<{
      feature_id: string;
      old_value: string | null;
      new_value: string;
    }>;
    for (const e of ents) {
      const oldV = e.old_value ?? "0";
      if (oldV === e.new_value || oldV === "unlimited") continue;
      allowance_changes[e.feature_id] = {
        at: now.toISOString(),
        old_value: oldV,
        mode: settings.allowances.onUpgrade,
      };
      touched = true;
    }
  }
  if (!touched) return;
  await tx
    .update(subscriptions)
    .set({ resetState: { ...(sub.resetState ?? {}), allowance_changes } })
    .where(eq(subscriptions.id, sub.id));
  sub.resetState = { ...(sub.resetState ?? {}), allowance_changes };
}

/**
 * Before a pause: grant what is due, then note when the pause began and the call's
 * `on_pause` rule (omitted = the business rule, so an earlier pause's choice is dropped).
 */
export async function onSubscriptionPaused(
  tx: Tx,
  sub: SubRow,
  now: Date,
  opts: { onPause?: PlanCreditPause } = {},
): Promise<void> {
  await ensureCreditWindows(tx, { customerId: sub.customerId, now });
  const { pause_rule: _old, ...kept } = sub.resetState ?? {};
  const state: SubscriptionResetState = {
    ...kept,
    paused_at: now.toISOString(),
    ...(opts.onPause ? { pause_rule: opts.onPause } : {}),
  };
  await tx.update(subscriptions).set({ resetState: state }).where(eq(subscriptions.id, sub.id));
}

/**
 * The call's `on_cancel_at_period_end` for the cancel just booked, tied to its booking.
 * Omitted clears an earlier choice, so the business rule applies.
 */
export async function noteCancelCreditRule(
  tx: Tx,
  subscriptionId: string,
  rule: PlanCreditCancelAtPeriodEnd | undefined,
): Promise<void> {
  const [sub] = await tx
    .select({ resetState: subscriptions.resetState, bookedAt: subscriptions.cancelBookedAt })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))
    .limit(1);
  if (!sub) return;
  const { cancel_rule: old, ...kept } = sub.resetState ?? {};
  if (!rule && !old) return;
  const state: SubscriptionResetState = {
    ...kept,
    ...(rule && sub.bookedAt
      ? { cancel_rule: { value: rule, booked_at: sub.bookedAt.toISOString() } }
      : {}),
  };
  await tx
    .update(subscriptions)
    .set({ resetState: state })
    .where(eq(subscriptions.id, subscriptionId));
}

/**
 * At a resume: `skip` leaves the windows that started while paused ungranted (the cursor moves
 * past them); `shift` extends the window open at the pause by the paused time. A subscription
 * anchor moves every later window on too. A calendar anchor moves only the next window's
 * start: that window runs to the next calendar boundary (shorter; boundaries the moved end
 * covers are skipped), then the calendar resumes. The short window follows `first_window`.
 * Allowances with their own reset shift by the same rule (`allowancePauseShifts`); a linked one
 * reads its credits item's state. A resume that starts a new term anchors its windows at that
 * term, so nothing shifts and the shifts reset. `startedNewTerm` is the resume's own decision;
 * dates cannot tell it (a day-anchored new term can start at the pause instant).
 */
export async function onSubscriptionResumed(
  tx: Tx,
  sub: SubRow,
  now: Date,
  opts: { startedNewTerm: boolean },
): Promise<void> {
  const state = sub.resetState ?? {};
  const pausedAt = state.paused_at ? new Date(state.paused_at) : null;
  if (!pausedAt) return;
  const [biz] = await tx
    .select({
      id: businesses.id,
      timezone: businesses.timezone,
      billingRulesConfig: businesses.billingRulesConfig,
    })
    .from(businesses)
    .where(eq(businesses.id, sub.businessId))
    .limit(1);
  if (!biz) return;
  const rule = pauseRuleOf(sub, readResetSettings(biz));
  const paused = Math.max(0, now.getTime() - pausedAt.getTime());
  const newTerm = opts.startedNewTerm;
  const rows = await tx
    .select({ item: subscriptionItems, price: prices })
    .from(subscriptionItems)
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .where(eq(subscriptionItems.subscriptionId, sub.id));
  const { calendar_shifts: oldKey, pause_rule: _rule, ...kept } = state;
  const next: SubscriptionResetState = { ...kept, paused_at: null };
  if (newTerm) {
    next.shift_ms = 0;
    next.pause_windows = {};
    next.allowance_shifts = {};
  }
  const shifting = rule === "shift" && paused > 0 && !newTerm;
  if (shifting) next.shift_ms = (state.shift_ms ?? 0) + paused;
  // Written under the new key only; windows stored under the old one carry over.
  const pauseWindows = { ...(newTerm ? {} : oldKey), ...(next.pause_windows ?? {}) };
  next.pause_windows = pauseWindows;
  // A pause resumed before windows were stored: replay it, so this pause extends the right window.
  const legacyPauses = shifting ? await loadLegacyPauses(tx, sub) : null;
  await lockCustomerBalances(tx, sub.customerId);
  for (const { item, price } of rows) {
    const reset = itemReset(price.grantsCredit);
    if (!reset || reset.every === "never" || rule === "keep_granting") continue;
    if (shifting) {
      // The window open at the pause runs on for the paused time (its grant and the window).
      await tx
        .update(creditGrants)
        .set({
          expiresAt: sql`${creditGrants.expiresAt} + make_interval(secs => ${paused / 1000})`,
        })
        .where(
          and(
            eq(creditGrants.subscriptionItemId, item.id),
            eq(creditGrants.source, "plan_cycle"),
            eq(creditGrants.status, "active"),
            lte(creditGrants.effectiveAt, pausedAt),
            gt(creditGrants.expiresAt, pausedAt),
          ),
        );
      const ctx = windowContext(
        sub,
        item,
        biz,
        legacyPauses ? { reset, pauses: legacyPauses } : null,
      );
      const moved = ctx ? pauseShiftOf(reset, ctx, pausedAt, paused) : null;
      if (!moved) continue;
      pauseWindows[item.id] = {
        price_id: item.priceId,
        start: moved.start.toISOString(),
        end: moved.end.toISOString(),
      };
      // The next window starts at the moved end: the cursor comes from the same window.
      await setCursor(tx, item.id, moved.end);
      continue;
    }
    // Skip: windows that started while paused are not granted; move the cursor past them.
    const ctx = windowContext({ ...sub, resetState: next }, item, biz);
    const cur = item.nextCreditResetAt;
    if (!ctx || !cur || cur.getTime() > now.getTime() || cur.getTime() < pausedAt.getTime())
      continue;
    const w = windowAt(reset, now, ctx);
    if (w.start.getTime() >= pausedAt.getTime()) await setCursor(tx, item.id, w.end ?? null);
  }
  if (shifting) {
    const { allowancePauseShifts } = await import("./allowance");
    next.allowance_shifts = await allowancePauseShifts(
      tx,
      sub,
      biz,
      pausedAt,
      paused,
      legacyPauses,
    );
  }
  await tx.update(subscriptions).set({ resetState: next }).where(eq(subscriptions.id, sub.id));
}
