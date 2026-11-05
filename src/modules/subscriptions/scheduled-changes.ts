import { and, eq, lte, sql } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { notDeleted } from "./deleted-sql";
import { publicId } from "@/platform/ids";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { type EventType } from "@/modules/events/registry";
import { businesses, scheduledChanges, subscriptions, subscriptionItems, prices } from "@db/schema";
import { resolveBillingRulesConfig } from "./billing-rules-config";
import { directionOfItemEdit } from "./change-policy";
import { scanBusinessFilter, stampNow } from "@/platform/clock";
import { config } from "@/platform/config";
// Type-only: the shape `clock_ticks.errors` stores, shared with the renewal pass
// so an operator reads one errors list, not two. Erased at runtime, so it adds
// no import edge to renewal.ts.
import { type TickError } from "./renewal";
import {
  cancelSubscription,
  SubscriptionError,
  type CreditOptionForTerm,
  type UnbilledChargesOption,
  type ArHandling,
  type RefundableCreditsHandling,
  type DunningHandling,
} from "./service";
import {
  changeSubscription,
  estimateScheduledMrrDeltaMinor,
  type ItemChange,
  type ItemAdd,
} from "./proration";
import { createLogger } from "@/platform/logger";

const log = createLogger("subscriptions.scheduled-changes");

/** Money-handling options carried on a scheduled specific_date cancel (SUB-5). */
export interface ScheduledCancelOptions {
  creditOptionForCurrentTermCharges?: CreditOptionForTerm;
  unbilledChargesOption?: UnbilledChargesOption;
  accountReceivablesHandling?: ArHandling;
  refundableCreditsHandling?: RefundableCreditsHandling;
  cancelReasonCode?: string | null;
  /** The free-text reason, re-stated when the cancel lands. */
  cancelReason?: string | null;
  /** `include_cancellation_day_in_billing: false`, validated when the cancel was scheduled. */
  excludeCancellationDay?: boolean;
}

/** Options a scheduled resume applies when it lands (absent = invoice immediately). */
export interface ScheduledResumeOptions {
  chargesHandling?: "invoice_immediately" | "add_to_unbilled_charges";
  unpaidInvoicesHandling?: "no_action" | "schedule_payment_collection";
}

/** The caller's explicit pause options, applied when a scheduled pause lands. Absent = business default. */
export interface ScheduledPauseOptions {
  unbilledChargesHandling?: UnbilledChargesOption | "no_action";
  dunningHandling?: DunningHandling;
  /** A pause the customer took from the cancel flow's offer. */
  source?: "retention_offer";
  /** `plan_credits.on_pause` the pause call sent. */
  planCreditsOnPause?: "skip" | "keep_granting" | "shift";
}

export type ScheduledChangeType = "cancel" | "pause" | "resume" | "change";
type Row = typeof scheduledChanges.$inferSelect;

/**
 * Withdrawing a scheduled cancel withdraws its booking, unless the row still stops: a fired
 * cancel froze the booking on the cancelled row, and an end-of-term flag holds its own.
 */
const keepBookingIfStillStopping = sql`case when ${subscriptions.status} = 'cancelled' or ${subscriptions.cancelAtPeriodEnd} then ${subscriptions.cancelBookedAt} end`;

/** Schedule a future-dated action on a subscription (applied by the billing clock). */
/** Emit a subscription-scoped scheduling event, resolving the sub's public id. */
async function emitScheduleEvent(
  tx: Tx,
  orgId: string,
  bizId: string,
  subInternalId: string,
  type: EventType,
  extra: Record<string, unknown>,
): Promise<void> {
  const [s] = await tx
    .select({ pid: subscriptions.publicId })
    .from(subscriptions)
    .where(eq(subscriptions.id, subInternalId))
    .limit(1);
  await emitEvent(tx, {
    organizationId: orgId,
    businessId: bizId,
    type,
    data: buildEventData(type, { id: s?.pid ?? subInternalId, ...extra }),
  });
}

/**
 * The three lists of ONE composition edit, as a scheduled `change` stores them.
 * Identical in shape to what `changeSubscription` takes, because apply-time hands
 * them straight to it — a scheduled edit and an immediate one must be the same edit,
 * only later.
 */
export interface ScheduledItemWork {
  changes?: ItemChange[];
  adds?: ItemAdd[];
  /** Public ids (`si_…`) of items to detach when the change lands. */
  removes?: string[];
}

/**
 * Reject at SCHEDULE time what apply time would reject anyway — while the operator is
 * still on the screen and can fix it.
 *
 * A scheduled row is applied by the billing clock, minutes or months later, with nobody
 * watching: `changeSubscription` throws, the applier records `last_error` and retries to
 * its cap, and the operator's first signal is the change never having happened. That was
 * survivable while a schedule could only carry `changes` (one id, already on the screen);
 * `adds` and `removes` widen the surface enough to be worth a preflight.
 *
 * What it does NOT check, deliberately: the added price's CADENCE. That is validated
 * against the POST-change cycle (`proration.ts`, the ADDS block) which depends on the
 * `changes` in the same edit AND on the subscription's cadence when the change lands —
 * an added yearly add-on is legal precisely because a plan price in the same edit turns
 * the subscription yearly. Re-deriving that here would refuse the edit this work exists
 * to support. Cadence stays an apply-time refusal, reported through `last_error`.
 *
 * Nothing here is a substitute for the apply-time guards: a price can be archived, or an
 * item detached by hand, in the window between. It removes the typo class, not the race.
 */
async function preflightItemWork(
  tx: Tx,
  subscriptionId: string,
  businessId: string,
  work: ScheduledItemWork,
): Promise<void> {
  const changes = work.changes ?? [];
  const adds = work.adds ?? [];
  const removes = work.removes ?? [];

  const touchedItemIds = [...new Set([...changes.map((c) => c.itemId), ...removes])];
  if (touchedItemIds.length > 0) {
    const rows = await tx
      .select({ pid: subscriptionItems.publicId })
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, subscriptionId));
    const live = new Set(rows.map((r) => r.pid));
    for (const pid of touchedItemIds) {
      if (!live.has(pid)) {
        throw new SubscriptionError(`We could not find the subscription item ${pid}.`);
      }
    }
  }
  // Same refusal `changeSubscription` makes, in its own words: a change bills the new
  // price for the rest of the term and a removal credits the term back, so an item in
  // both lists asks for opposite money and whichever loop reached it first would decide.
  const removed = new Set(removes);
  for (const c of changes) {
    if (removed.has(c.itemId)) {
      throw new SubscriptionError(
        `You cannot change and remove the same subscription item: ${c.itemId}`,
      );
    }
  }

  if (adds.length > 0) {
    const [sub] = await tx
      .select({ currency: subscriptions.currency })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    for (const add of adds) {
      const [p] = await tx
        .select({ currency: prices.currency })
        .from(prices)
        .where(and(eq(prices.businessId, businessId), eq(prices.publicId, add.priceId)))
        .limit(1);
      if (!p) throw new SubscriptionError(`We could not find the price ${add.priceId}.`);
      if (sub && p.currency !== sub.currency) {
        throw new SubscriptionError("Item currency must match the subscription currency");
      }
    }
  }
}

export async function scheduleChange(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  type: ScheduledChangeType;
  effectiveAt: Date;
  /** Existing items whose price/quantity/custom amount moves when the change lands. */
  changes?: ItemChange[];
  /**
   * Items to ATTACH when the change lands, and public ids of items to DETACH — the
   * other two thirds of a composition edit.
   *
   * A schedule used to carry `changes` only, so the change screen refused to defer any
   * edit that added or removed a line ("Scheduled changes can only modify existing
   * lines"). Nothing in the engine required it:
   * `changeSubscription` has taken all three lists in ONE transaction since 2026-08-24,
   * `estimateChange` already previewed all three, and `scheduled_changes.payload` is
   * jsonb — so widening the schedule needed no migration, only these fields and the
   * pass-through at apply time.
   */
  adds?: ItemAdd[];
  removes?: string[];
  /** Money-handling options for a scheduled specific_date cancel (SUB-5). */
  cancelOptions?: ScheduledCancelOptions;
  resumeOptions?: ScheduledResumeOptions;
  pauseOptions?: ScheduledPauseOptions;
}): Promise<Row> {
  const itemWork: ScheduledItemWork = {
    ...(input.changes?.length ? { changes: input.changes } : {}),
    ...(input.adds?.length ? { adds: input.adds } : {}),
    ...(input.removes?.length ? { removes: input.removes } : {}),
  };
  // An adds-only or removes-only schedule is a legal edit — the check is that the change
  // does SOMETHING, not that it modifies an existing line.
  if (input.type === "change" && Object.keys(itemWork).length === 0) {
    throw new SubscriptionError("A scheduled change needs at least one item change, add or remove");
  }
  // Persist the change's payload so apply-time reproduces the merchant's intent:
  // the item work for a `change`, money-handling options for a `cancel` (previously
  // dropped — the scheduled cancel ran a bare cancelSubscription, silently ignoring
  // credit_option/unbilled/AR/refundable handling — review blocker).
  const payload =
    input.type === "change"
      ? itemWork
      : input.type === "cancel" && input.cancelOptions
        ? { cancel: input.cancelOptions }
        : input.type === "resume" && input.resumeOptions
          ? { resume: input.resumeOptions }
          : input.type === "pause" && input.pauseOptions
            ? { pause: input.pauseOptions }
            : null;
  return withTenant(input.organizationId, async (tx) => {
    // Price the edit's recurring effect once, here, rather than re-estimating every
    // pending row whenever a report asks for scheduled upgrade/downgrade MRR. Gross and
    // approximate by construction — the estimator's header says exactly how.
    let mrrDeltaMinor: bigint | null = null;
    if (input.type === "change") {
      await preflightItemWork(tx, input.subscriptionId, input.businessId, itemWork);
      mrrDeltaMinor = await estimateScheduledMrrDeltaMinor(tx, {
        subscriptionId: input.subscriptionId,
        businessId: input.businessId,
        ...itemWork,
      });
    }
    // Scheduling a change REPLACES any change already pending for
    // this subscription — the merchant changed their mind, they did not queue a second
    // change. tm used to just insert, leaving BOTH rows `scheduled` with the same
    // effectiveAt; the subscription detail only ever showed the newest, so the stack
    // was invisible in state and surfaced only as a doubled
    // `subscription_scheduled_changes_removed` event. Left alone, two
    // pending changes race at renewal and the customer can be renewed onto the wrong
    // plan — PRO scheduled to BUSINESS (64900) then to BASIC (6900) could apply either.
    //
    // Superseded SILENTLY, no `subscription_scheduled_change_removed` event: only the
    // new schedule is reported, and emitting a removal here would swap one misleading
    // event for another. Scoped to the SAME type — a pending cancel and a pending
    // change are different intents and must not evict each other.
    await tx
      .update(scheduledChanges)
      .set({ status: "canceled" })
      .where(
        and(
          eq(scheduledChanges.subscriptionId, input.subscriptionId),
          eq(scheduledChanges.type, input.type),
          eq(scheduledChanges.status, "scheduled"),
        ),
      );
    const [row] = await tx
      .insert(scheduledChanges)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        subscriptionId: input.subscriptionId,
        publicId: publicId("sch"),
        type: input.type,
        effectiveAt: input.effectiveAt,
        payload,
        mrrDeltaMinor,
      })
      .returning();
    // Project a pending CANCEL onto the subscription (0159). Owned here rather
    // than by the caller so the invariant "a scheduled cancel row exists ⟺
    // cancel_scheduled_at is set" holds for every scheduler — including the
    // supersede path above, which moves the date without going through a create.
    if (input.type === "cancel") {
      await tx
        .update(subscriptions)
        .set({
          cancelScheduledAt: input.effectiveAt,
          cancelBookedAt: sql`coalesce(${subscriptions.cancelBookedAt}, ${stampNow(input.businessId).toISOString()}::timestamptz)`,
        })
        .where(eq(subscriptions.id, input.subscriptionId));
    }
    await emitScheduleEvent(
      tx,
      input.organizationId,
      input.businessId,
      input.subscriptionId,
      "subscription_change_scheduled",
      {
        scheduled_change: row!.publicId,
        change_type: input.type,
      },
    );
    return row!;
  });
}

export async function listScheduledChanges(
  organizationId: string,
  subscriptionId: string,
): Promise<Row[]> {
  return withTenant(organizationId, async (tx) =>
    tx
      .select()
      .from(scheduledChanges)
      .where(eq(scheduledChanges.subscriptionId, subscriptionId))
      .orderBy(scheduledChanges.effectiveAt),
  );
}

/** Cancel a still-pending scheduled change. Returns the updated row, or null. */
export async function cancelScheduledChange(
  organizationId: string,
  businessId: string,
  scheduledChangePublicId: string,
): Promise<Row | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .update(scheduledChanges)
      .set({ status: "canceled" })
      .where(
        and(
          eq(scheduledChanges.businessId, businessId),
          eq(scheduledChanges.publicId, scheduledChangePublicId),
          eq(scheduledChanges.status, "scheduled"),
        ),
      )
      .returning();
    if (row) {
      // Withdrawing a pending CANCEL puts the subscription back to renewing — clear
      // the projection with it, in the same transaction, or the row and the
      // subscription would disagree about whether a cancellation is coming.
      if (row.type === "cancel") {
        await tx
          .update(subscriptions)
          .set({ cancelScheduledAt: null, cancelBookedAt: keepBookingIfStillStopping })
          .where(eq(subscriptions.id, row.subscriptionId));
      }
      await emitScheduleEvent(
        tx,
        organizationId,
        businessId,
        row.subscriptionId,
        "subscription_scheduled_change_removed",
        {
          scheduled_change: row.publicId,
        },
      );
    }
    return row ?? null;
  });
}

/**
 * How many ticks a failing scheduled change is retried before it goes terminal.
 * A transient cause (a gateway blip on the cancel's refund, a lock timeout) is
 * almost always gone within five minutes; past that, retrying every 60s forever
 * is not resilience, it is a row nobody will ever look at. At the cap the row
 * becomes `failed` with `last_error`, and every attempt in between is reported
 * in `clock_ticks.errors`.
 */
const MAX_ATTEMPTS = 5;

/**
 * What one apply attempt concluded. The distinction that matters is TERMINAL vs
 * RETRYABLE: a thrown error is retryable (up to MAX_ATTEMPTS), everything below
 * ends the row now. `moot` means the merchant's intent is already satisfied
 * (someone cancelled the sub by hand first) — not an error. `unapplicable`
 * means it can never be satisfied, which IS worth an operator's attention but
 * must not be retried, because the next four attempts would fail identically.
 */
type ApplyOutcome =
  | { kind: "applied" }
  | { kind: "moot"; reason: string }
  | { kind: "unapplicable"; reason: string };

/** Apply one scheduled change inside its org's RLS context. */
async function applyOne(row: Row, now: Date): Promise<ApplyOutcome> {
  const base = {
    organizationId: row.organizationId,
    businessId: row.businessId,
    subscriptionId: row.subscriptionId,
  };
  // A change scheduled against a subscription that has since been cancelled must
  // not resurrect it (a scheduled pause used to flip cancelled → paused).
  const [current] = await withTenant(row.organizationId, async (tx) =>
    tx
      .select({ status: subscriptions.status })
      .from(subscriptions)
      // …or that has since been DELETED. A scheduled change is an intent about a
      // subscription that is meant to keep running; deleting it withdraws the intent, and
      // applying the change anyway would edit a row nothing can see.
      .where(and(eq(subscriptions.id, row.subscriptionId), notDeleted()))
      .limit(1),
  );
  // Effectively unreachable — subscription_id cascades on delete, so a vanished
  // subscription takes this row with it. Reachable only if RLS hides the sub from
  // the org context, which is a real fault: report it and stop, instead of the
  // bare `return` this used to do, which left the row `scheduled` forever and
  // re-scanned it every tick for the life of the deployment.
  if (!current)
    return { kind: "unapplicable", reason: "subscription deleted or not visible in its own org" };
  switch (row.type) {
    case "cancel": {
      if (current.status === "cancelled")
        return { kind: "moot", reason: "subscription is already cancelled" };
      // Apply the persisted money-handling options (SUB-5) — the effective date has
      // arrived, so this is now an IMMEDIATE cancel with the merchant's options.
      const opts = (row.payload as { cancel?: ScheduledCancelOptions } | null)?.cancel;
      if (opts) {
        const { cancelSubscriptionWithOptions } = await import("./service");
        await cancelSubscriptionWithOptions({ ...base, now, cancelOption: "immediately", ...opts });
      } else {
        await cancelSubscription({ ...base, atPeriodEnd: false, now });
      }
      break;
    }
    case "pause":
      if (current.status === "cancelled")
        return { kind: "unapplicable", reason: "cannot pause a cancelled subscription" };
      if (current.status === "paused")
        return { kind: "moot", reason: "subscription is already paused" };
      {
        // Lands as an immediate pause with the caller's stored options; pause_config
        // fills only what the caller did not give, exactly as for an immediate pause.
        const { pauseSubscriptionWithOptions } = await import("./service");
        const opts = (row.payload as { pause?: ScheduledPauseOptions } | null)?.pause;
        await pauseSubscriptionWithOptions({ ...base, now, pauseOption: "immediately", ...opts });
      }
      break;
    case "resume":
      if (current.status === "cancelled")
        return { kind: "unapplicable", reason: "cannot resume a cancelled subscription" };
      if (current.status !== "paused")
        return {
          kind: "moot",
          reason: `subscription is not paused. Its status is ${current.status}`,
        };
      // Auto-resume after skip_billing_cycles lands past the paused term's end, so the
      // core restarts the term here and bills it now (never back-billing the skipped
      // cycles). Collected immediately: nobody is present to choose otherwise.
      {
        const { resumeSubscriptionWithOptions } = await import("./service");
        const opts = (row.payload as { resume?: ScheduledResumeOptions } | null)?.resume;
        await resumeSubscriptionWithOptions({
          ...base,
          now,
          chargesHandling: opts?.chargesHandling ?? "invoice_immediately",
          ...(opts?.unpaidInvoicesHandling
            ? { unpaidInvoicesHandling: opts.unpaidInvoicesHandling }
            : {}),
        });
      }
      break;
    case "change": {
      // `changeSubscription` rejects a cancelled subscription outright, and would
      // do so on every retry — so this is terminal, not a five-attempt loop. It
      // was the one type with no status guard at all, which is how it ended up
      // as the row that spun forever.
      if (current.status === "cancelled")
        return {
          kind: "unapplicable",
          reason: "cannot change a cancelled subscription. Reactivate it instead",
        };
      // All three lists, exactly as they were scheduled. `changeSubscription` applies
      // them in ONE transaction and folds every line onto ONE invoice / credit note, so
      // a deferred composition edit lands as one document — the same guarantee the
      // immediate path got in 2026-08-24. Rows scheduled before `adds`/`removes` existed
      // simply have neither key, and read as the changes-only edit they were.
      const work = (row.payload as ScheduledItemWork | null) ?? {};
      const changes = work.changes ?? [];
      const adds = work.adds ?? [];
      const removes = work.removes ?? [];
      // `invoiceImmediately: true` explicitly, NOT the business default. A change
      // deferred to a date has no per-change invoicing choice of its own —
      // `scheduled_changes` has no column for one — so the change page states that a
      // scheduled change invoices when it lands, and this is the code that has to keep
      // that promise. Resolving `default_invoice_immediately` here (as an omission now
      // would) would silently defer a landed change into unbilled charges on any
      // business with the setting off, contradicting the screen that scheduled it.
      // Proration follows the business rule for the change's direction; the gate and the
      // timing were decided when the change was scheduled.
      const prorate = await withTenant(row.organizationId, async (tx) => {
        const [biz] = await tx
          .select({ billingRulesConfig: businesses.billingRulesConfig })
          .from(businesses)
          .where(eq(businesses.id, row.businessId))
          .limit(1);
        const rules = resolveBillingRulesConfig(biz);
        const direction = await directionOfItemEdit(
          tx,
          { id: row.subscriptionId, businessId: row.businessId },
          { changes, adds, removes },
        );
        return (
          (direction === "downgrade" ? rules.downgradeProration : rules.upgradeProration) ===
          "prorated"
        );
      });
      await changeSubscription({
        ...base,
        now,
        changes,
        adds,
        removes,
        invoiceImmediately: true,
        prorate,
      });
      break;
    }
  }
  return { kind: "applied" };
}

/** Close a scheduled change out — `applied` (done or moot) or `failed` (terminal). */
async function finishRow(
  row: Row,
  now: Date,
  status: "applied" | "failed",
  reason: string | null,
): Promise<void> {
  await withTenant(row.organizationId, async (tx) => {
    await tx
      .update(scheduledChanges)
      .set(
        status === "applied"
          ? { status: "applied", appliedAt: now, lastError: reason }
          : { status: "failed", failedAt: now, lastError: reason },
      )
      .where(eq(scheduledChanges.id, row.id));
    // A cancel that is no longer pending must stop claiming the subscription is
    // non_renewing — whether it fired, was moot, or gave up.
    if (row.type === "cancel") {
      await tx
        .update(subscriptions)
        .set({ cancelScheduledAt: null, cancelBookedAt: keepBookingIfStillStopping })
        .where(eq(subscriptions.id, row.subscriptionId));
    }
  });
}

/**
 * Billing-clock pass: apply every scheduled change that's now due. Runs across
 * all orgs (admin connection); each change's work happens in its org's RLS
 * context.
 *
 * Per-change failures are isolated so one can't stall the tick — but RECORDED,
 * not swallowed (SCHED-1, matching `runBillingClockTick`). The old bare
 * `catch {}` logged nothing, pushed no `TickError`, and left the row `scheduled`
 * to be retried every 60s forever; the only counter was successes, so 3-of-8
 * applying was indistinguishable from 3-due-3-applied and the ops table showed a
 * healthy green line. A scheduled CANCEL failing that way meant the customer was
 * never cancelled and kept being billed, with the complaint as the first signal.
 *
 * BOUNDED, like the renewal pass: ordered by due time (longest-overdue first, so
 * the cap is fair) and capped at TICK_SCAN_LIMIT, reporting `capped` so a
 * truncated sweep can't read as a complete one.
 */
export async function applyDueScheduledChanges(now: Date): Promise<{
  applied: number;
  failed: number;
  errors: TickError[];
  capped?: boolean;
}> {
  const due = await systemDb
    .select()
    .from(scheduledChanges)
    .where(
      and(
        eq(scheduledChanges.status, "scheduled"),
        lte(scheduledChanges.effectiveAt, now),
        scanBusinessFilter(scheduledChanges.businessId),
      ),
    )
    .orderBy(scheduledChanges.effectiveAt)
    .limit(config.TICK_SCAN_LIMIT);
  const capped = due.length >= config.TICK_SCAN_LIMIT;

  let applied = 0;
  let failed = 0;
  const errors: TickError[] = [];
  for (const row of due) {
    // Count the attempt BEFORE running it. A cause that kills the process
    // mid-apply (OOM, a pod eviction) would otherwise never reach the increment,
    // and the row would retry on every tick forever — the exact failure mode
    // this cap exists to end.
    const attempts = row.attempts + 1;
    await withTenant(row.organizationId, async (tx) => {
      await tx.update(scheduledChanges).set({ attempts }).where(eq(scheduledChanges.id, row.id));
    });
    try {
      const outcome = await applyOne(row, now);
      if (outcome.kind === "unapplicable") {
        await finishRow(row, now, "failed", outcome.reason);
        failed++;
        errors.push({
          organization: row.organizationId,
          business: row.businessId,
          step: "scheduled_change",
          message: `${row.publicId} (${row.type}) cannot be applied: ${outcome.reason}`,
        });
        log.warn("scheduled_changes: a change can never apply — marked failed", {
          event: "scheduled_change_unapplicable",
          scheduledChange: row.publicId,
          type: row.type,
          reason: outcome.reason,
        });
        continue;
      }
      await finishRow(row, now, "applied", outcome.kind === "moot" ? outcome.reason : null);
      applied++;
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      const giveUp = attempts >= MAX_ATTEMPTS;
      await withTenant(row.organizationId, async (tx) => {
        await tx
          .update(scheduledChanges)
          .set(
            giveUp
              ? { status: "failed", failedAt: now, lastError: message }
              : { lastError: message },
          )
          .where(eq(scheduledChanges.id, row.id));
      });
      if (giveUp) failed++;
      errors.push({
        organization: row.organizationId,
        business: row.businessId,
        step: "scheduled_change",
        message: `${row.publicId} (${row.type}) attempt ${attempts}/${MAX_ATTEMPTS}${giveUp ? " — GIVING UP" : ""}: ${message}`,
      });
      log.error(e, {
        event: "scheduled_change_failed",
        scheduledChange: row.publicId,
        type: row.type,
        attempts,
        giveUp,
        summary: `scheduled_changes: ${row.publicId} (${row.type}) failed on attempt ${attempts}/${MAX_ATTEMPTS}${giveUp ? " — marked failed, no further retries" : ""}`,
      });
    }
  }
  return { applied, failed, errors, ...(capped ? { capped: true } : {}) };
}
