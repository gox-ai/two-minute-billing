import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { loadEffectiveDunningConfig } from "@/modules/dunning-policies/effective";
import { systemDb, withTenant } from "@/platform/db";
import { notDeleted } from "./deleted-sql";
import {
  advancePeriod,
  recomputeSubscriptionMrr,
  requireTerm,
  termOrNull,
  type Interval,
} from "./service";
import { auditSubscription, subscriptionSnapshot } from "./audit";
import {
  billingModeFor,
  inclusiveBoundary,
  normalizeTermEnd,
  type BillingMode,
} from "./billing-mode";
import { scheduledSkipAt, voidPassedSkips } from "./renewal-skips";
import {
  billSubscriptionPeriod,
  collectPeriodInvoice,
  commitSubscriptionPeriodInvoice,
  isAutoCollectOn,
  PeriodAlreadyBilledError,
  PeriodClaimLostError,
  planSubscriptionPeriodInvoice,
} from "@/modules/invoicing/service";
import { resolveChargeCandidates } from "@/modules/invoicing/collection";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { usesPendingInvoices } from "@/modules/invoicing/pending";
import { applyDunningFinalAction } from "./dunning";
import { loadRenewalCollectionRules, settleCollection } from "./renewal-collection";
import { collectionRulesActive } from "@/modules/invoicing/invoice-rules-config";
import { resolveBillingRulesConfig, type TrialEndAction } from "./billing-rules-config";
import { type DunningConfig } from "./dunning-schedule";
import {
  subscriptions,
  subscriptionItems,
  prices,
  products,
  businesses,
  customers,
  invoices,
  clockTicks,
  renewalSkips,
} from "@db/schema";
import { termCoveredByPriorInvoice, termUsageWindow } from "./usage-window";
import { nextSubPeriodEnd, subPeriodDue, subPeriodFields } from "./sub-periods";
import { closingCommitment, freshSegments } from "./commitment";
import { currentClockScope, scanBusinessFilter } from "@/platform/clock";
import { config } from "@/platform/config";
import { runBounded } from "@/platform/concurrency";
import type { Tx } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { frozenStopBooking } from "@/modules/metrics/stocks";

const log = createLogger("renewal");

/** The dunning config (customer policy, plan policy, else business) for the renewal-time exhaustion path. */
async function loadRenewalDunningConfig(
  tx: Tx,
  businessId: string,
  customerId: string,
  subscriptionId?: string,
): Promise<DunningConfig> {
  return loadEffectiveDunningConfig(tx, { businessId, customerId, subscriptionId });
}

/**
 * How far ahead of real time a tick may run before it must declare a business scope.
 *
 * Exported because `verify:clock-obs` § 7 induces this guard on purpose (to prove one
 * throwing pass cannot abort a tick) and has to warp *just* past it — small enough that
 * every other pass in the same tick still behaves normally. It used to hardcode `61_000`
 * against this 60s value, linked by nothing but a comment, which left a **one-second**
 * margin: the guard fires only while `now - Date.now() > 60s`, so the induced failure
 * quietly stopped happening whenever a loaded runner burned a second between building the
 * date and reaching this line — and the suite then failed on the assertions that expect a
 * failed pass. Deriving the warp from this constant removes both the race and the drift.
 */
export const TIME_WARP_TOLERANCE_MS = 60_000;

/**
 * A tick whose `now` is in the FUTURE must name the business it is driving.
 *
 * The due-scan below is deliberately global — the real clock has to sweep every tenant.
 * `scanBusinessFilter` narrows it, but returns "no restriction" when no clock scope is
 * set. So a test that fast-forwards the clock without a scope renews **every due
 * subscription in the database**, not just its own.
 *
 * That is not hypothetical. On 2026-08-02 `verify:migration` warped ~20 days ahead with no
 * scope and converted a 14-day trial belonging to an unrelated imported business, raised a
 * ₹56,715 invoice against it, failed the card and opened dunning — while its own throwaway
 * org was the only thing it meant to touch. Two bursts, an hour apart, in the same local DB.
 *
 * Real ticks pass real time and are unaffected. Time Travel travel already runs inside
 * `runWithClockScope({ onlyBusinessId })`. Anything else that warps must do the same.
 */
function assertScopedIfTimeWarped(now: Date): void {
  const scope = currentClockScope();
  if (scope?.onlyBusinessId) return;
  const aheadMs = now.getTime() - Date.now();
  if (aheadMs <= TIME_WARP_TOLERANCE_MS) return;
  // Report the overshoot in a unit that can actually be read. This used to be a fixed
  // `/ 86_400_000` day count, so every warp under ~12h rounded to "0 day(s)" — and a
  // refusal that says it happened 0 days ahead of real time reads as a false positive,
  // which is exactly how the deliberate 61s warp in `verify:clock-obs` § 7 presented in CI.
  const ahead =
    aheadMs >= 86_400_000
      ? `${Math.round(aheadMs / 86_400_000)} day(s)`
      : aheadMs >= 3_600_000
        ? `${(aheadMs / 3_600_000).toFixed(1)}h`
        : `${(aheadMs / 1000).toFixed(1)}s`;
  throw new Error(
    `runBillingClockTick refused: now=${now.toISOString()} is ${ahead} ahead of real time ` +
      `(tolerance ${TIME_WARP_TOLERANCE_MS / 1000}s) with NO clock scope. An unscoped time-warped tick ` +
      "renews every due subscription in the database, across every organization. Wrap it:\n" +
      "    await runWithClockScope({ onlyBusinessId: biz.id, now }, () => runBillingClockTick(now))",
  );
}

/**
 * One billing-clock tick: find every subscription whose current period has ended
 * and renew it. Runs across ALL organizations (the clock is system-wide), but
 * each subscription's work is done inside its own org's RLS context.
 *
 *  - trialing → active: the trial ended; bill the first paid period.
 *  - active/past_due:  the period ended; bill the next period.
 * Billing advances current_period_* by the price's interval. Charge success/-
 * failure is recorded by billSubscriptionPeriod (dunning handles failures later).
 */
export async function runBillingClockTick(
  now: Date,
): Promise<{ renewed: number; errors: TickError[]; capped?: boolean }> {
  assertScopedIfTimeWarped(now);
  // Declared HERE rather than beside the renewal loop below, because the two
  // sub-passes that run first now report into the same list. Every per-item failure
  // in this tick ends up in `clock_ticks.errors` (SCHED-1) — the durable record that
  // makes "why didn't this renew?" answerable after the log line has rotated away.
  const errors: TickError[] = [];
  // First: start any future-dated subscriptions whose start date has arrived
  // (SUB-1) — future → in_trial | active, billing the first active period.
  errors.push(...(await startFutureSubscriptions(now)));
  // Self-heal (F review blocker): a crash between the future→active claim and
  // the first bill leaves an active sub whose first period has no invoice —
  // and nothing else would ever bill it (the sub is no longer `future`, and
  // renewal only fires at period end). Signature is narrow on purpose:
  // current_period_start === start_date (a resume restarts the period, and bills it
  // itself, so resumed periods never match).
  errors.push(...(await healUnbilledFirstPeriods(now)));
  await voidPassedSkips(now);

  if (!currentClockScope()?.onlyBusinessId) {
    // Whatever the flags say now: invoices committed unnumbered before batch numbering was
    // switched off still get their numbers (and then their charge, from the pump).
    const { requestPendingInvoiceNumbering } = await import("@/modules/invoicing/number-queue");
    await requestPendingInvoiceNumbering();
    // Receipts left unnumbered by a lost request (0387).
    const { requestPendingReceiptNumbering } = await import("@/modules/receipts/number-queue");
    await requestPendingReceiptNumbering();
  }
  if (config.RENEWAL_FANOUT === "TRUE" && !currentClockScope()?.onlyBusinessId) {
    const { capped } = await queueDueRenewals(now);
    return { renewed: 0, errors, ...(capped ? { capped: true } : {}) };
  }

  // Find due subscriptions across all orgs (admin connection — clock is global).
  //
  // BOUNDED (2026-08-05 robustness review, finding #3): this was "every due row", and
  // each one is billed serially with a gateway call, so a backlog turned one tick into an
  // unbounded sweep holding a worker slot — with no way to stop it. Ordering by
  // `current_period_end` makes the cap fair: the longest-overdue subscriptions renew
  // first, and the next tick (60s later) continues. Nothing is lost, only deferred.
  const due = await systemDb
    .select({
      id: subscriptions.id,
      organizationId: subscriptions.organizationId,
      publicId: subscriptions.publicId,
    })
    .from(subscriptions)
    .where(
      and(
        inArray(subscriptions.status, ["in_trial", "active"]),
        // A deleted subscription is not billed again. This is the one scan where omitting
        // the filter would charge a customer for a subscription the merchant removed.
        notDeleted(),
        // TWO BOUNDARIES, one scan. A trialling subscription has no term since 2026-08-25,
        // so it becomes due by `trial_end`; an active one by `current_period_end`. Written
        // as an OR over the two columns rather than a COALESCE so each side can use its own
        // index (`subscriptions_due_idx` for the term, `subscriptions_trial_due_idx` for the
        // trial) — a COALESCE would be unindexable and turn every tick into a seq scan.
        //
        // Getting this wrong fails SILENTLY and expensively: a trial that matches neither
        // predicate never converts, never bills, and raises no error.
        or(
          // A trialling subscription is due at its TRIAL end. It may also still carry a term:
          // migration 0189 deliberately does NOT backfill existing trials to NULL, because a
          // row whose stored term disagrees with its `trial_end` (an edited trial, an import)
          // would silently never convert. So accept either boundary here — new trials match on
          // `trial_end`, rows created before 0189 match on the term they still hold.
          and(
            eq(subscriptions.status, "in_trial"),
            or(lte(subscriptions.trialEnd, now), lte(subscriptions.currentPeriodEnd, now)),
          ),
          and(
            eq(subscriptions.status, "active"),
            lte(subscriptions.currentPeriodEnd, now),
            usageCloseReached(
              sql`${subscriptions.id}`,
              sql`${subscriptions.businessId}`,
              sql`${subscriptions.currentPeriodEnd}`,
              now,
            ),
          ),
          // A monthly usage boundary inside the term (`subPeriodDue`).
          and(
            eq(subscriptions.status, "active"),
            lte(subscriptions.currentSubPeriodEnd, now),
            sql`${subscriptions.currentSubPeriodEnd} < ${subscriptions.currentPeriodEnd}`,
            usageCloseReached(
              sql`${subscriptions.id}`,
              sql`${subscriptions.businessId}`,
              sql`${subscriptions.currentSubPeriodEnd}`,
              now,
            ),
          ),
        ),
        scanBusinessFilter(subscriptions.businessId),
      ),
    )
    // Oldest-due first across BOTH classes — ordering on one column alone would let a
    // backlog of the other starve under TICK_SCAN_LIMIT.
    .orderBy(
      sql`coalesce(${subscriptions.trialEnd}, least(${subscriptions.currentSubPeriodEnd}, ${subscriptions.currentPeriodEnd}))`,
    )
    .limit(config.TICK_SCAN_LIMIT);
  const capped = due.length >= config.TICK_SCAN_LIMIT;

  let renewed = 0;
  // Wall-clock budget (finding #3): each renewal raises an invoice AND charges a card, so
  // a slow gateway makes this pass's duration a function of the backlog. Checked between
  // subscriptions — never mid-renewal, which must stay atomic. Whatever is left is still
  // due, so the next tick picks it up.
  const deadline = Date.now() + config.TICK_PASS_BUDGET_MS;
  // BOUNDED-CONCURRENT since 2026-09-11, serial before it. A renewal is one gateway round
  // trip (Stripe 593ms mean, Razorpay 681ms, measured over ~29k real calls), and waiting for
  // each before starting the next capped this pass at 25 per tick — `budget ÷ latency`,
  // nothing more principled than that. `TICK_RENEWAL_CONCURRENCY` defaults to 1, so this is
  // byte-for-byte the old behaviour until a deployment states otherwise; see the config note
  // for what binds next (TICK_SCAN_LIMIT first, then the gateway's per-account rate limit).
  //
  // Safe without new locking: `renewSubscription` claims the period advance with a
  // compare-and-swap, so two callers racing the same subscription cannot both advance it,
  // and the gateway call happens outside the DB transaction so a 600ms round trip never
  // holds a connection. The deadline still bites BETWEEN subscriptions only.
  const run = await runBounded(
    due,
    config.TICK_RENEWAL_CONCURRENCY,
    (row) => renewSubscription(row.organizationId, row.id, now),
    { deadline },
  );
  const budgetSpent = run.unstarted.length > 0;
  for (const outcome of run.settled) {
    const row = outcome.item;
    if (outcome.ok) {
      renewed++;
    } else {
      const e = outcome.error;
      // Isolate failures so one bad subscription can't stall the whole tick — but
      // RECORD them (SCHED-1) instead of swallowing, so "why didn't this renew?"
      // is answerable per subscription in clock_ticks.errors.
      // Recorded in `clock_ticks.errors` (SCHED-1) AND logged: the tick row keeps the
      // message, the log keeps the stack and the trace. "Why didn't this renew?" is
      // the question this engine exists to answer.
      //
      // `recurringError`, not `error`: the clock is `* * * * *`, so a subscription
      // stuck in a broken state (a trialling one with no billing term, say) fails on
      // EVERY tick — 1,440 identical stacks a day, one cause. The first occurrence
      // logs in full and later ones are counted, which is safe only because the
      // `errors.push` below keeps the per-subscription record durable regardless.
      // Every sibling pass now does both too; until they gained their own
      // `errors.push` they could not, because the log line was their only record.
      log.recurringError(`renewal_pass_failed:${row.publicId}`, e, {
        event: "renewal_pass_failed",
        subscription: row.publicId,
        organizationId: row.organizationId,
      });
      errors.push({
        organization: row.organizationId,
        subscription: row.publicId,
        step: "renewal",
        message: (e as Error)?.message ?? String(e),
      });
    }
  }
  return {
    renewed,
    errors,
    ...(capped || budgetSpent
      ? { capped: true, cappedBy: budgetSpent ? ("budget" as const) : ("scan_limit" as const) }
      : {}),
  };
}

/** Usage closes this many minutes after a period ends, plus the business's own delay. */
export const USAGE_CLOSE_BASE_MINUTES = 6;
/** Never wait longer than this past the period end; fold lag past it bills as late usage. */
export const USAGE_CLOSE_CAP_MINUTES = 30;

/**
 * Decision 2, as ONE predicate for both due scans: a subscription that bills a meter is due
 * once the BUSINESS clock passes `boundary` + 6 min + `usage_close_delay_minutes`, capped at
 * +30. Gated on the business clock (periods end on it), not on the fold watermark (real
 * clock): billing reads the unfolded tail raw, so the wait only keeps late lines rare.
 */
export function usageCloseReached(
  subscriptionId: SQL,
  businessId: SQL,
  boundary: SQL,
  now: Date,
): SQL {
  return sql`(not exists (select 1 from customer_meter_billing cmb where cmb.subscription_id = ${subscriptionId})
    or ${boundary} + make_interval(mins => least(${USAGE_CLOSE_CAP_MINUTES},
         ${USAGE_CLOSE_BASE_MINUTES} + (select b.usage_close_delay_minutes from businesses b
                                         where b.id = ${businessId})))
       <= ${now.toISOString()}::timestamptz)`;
}

/** One per-item clock error (SCHED-1) — surfaced in clock_ticks.errors. */
/**
 * Queue one `renew_subscription` job per due subscription, up to a per-business share, so
 * workers renew in parallel and one large business cannot hold back the rest. The job key makes
 * a re-queue a no-op while the job waits; `renewSubscription`'s claim makes a duplicate run one.
 * Each business is walked on its own index, so a tick costs what it queues, not the backlog.
 */
/**
 * Behind every cron job (priority 0; graphile runs the LOWEST number first). The tick that
 * refills this queue, and the outbox drains, must never wait behind the renewals it queued:
 * at equal priority a 6,000-job backlog started each tick 3–7 minutes late (D4).
 */
const RENEWAL_JOB_PRIORITY = 10;

/** `capped`: the backlog is full, so due renewals may be left for a later tick. */
async function queueDueRenewals(now: Date): Promise<{ capped: boolean }> {
  // Top the backlog up to the limit rather than adding a share every tick: a backlog of hours
  // made every worker's job lookup scan it (D4: 100k jobs, 114 ms per lookup).
  const [pending] = (await systemDb.execute(sql`
    select count(*)::int n from graphile_worker._private_jobs
    where task_id = (select id from graphile_worker._private_tasks
                     where identifier = 'renew_subscription')`)) as unknown as Array<{ n: number }>;
  const room = config.RENEWAL_FANOUT_LIMIT - Number(pending?.n ?? 0);
  if (room <= 0) return { capped: true };
  const at = now.toISOString();
  const perBusiness = config.RENEWAL_FANOUT_PER_BUSINESS;
  const notQueued = sql`not exists (select 1 from graphile_worker.jobs j where j.key = 'renew:' || s.id::text)`;
  const scope = scanBusinessFilter(businesses.id);
  const rows = (await systemDb.execute(sql`
    with picked as (
      select x.* from businesses
      cross join lateral (
        (select s.id, s.organization_id, s.business_id, s.public_id, s.current_period_end due_at
          from subscriptions s
          where s.business_id = businesses.id and s.status = 'active' and s.deleted_at is null
            and s.current_period_end <= ${at}::timestamptz and ${notQueued}
            and ${usageCloseReached(sql`s.id`, sql`s.business_id`, sql`s.current_period_end`, now)}
          order by s.current_period_end limit ${perBusiness})
        union all
        (select s.id, s.organization_id, s.business_id, s.public_id,
                coalesce(s.trial_end, s.current_period_end) due_at
          from subscriptions s
          where s.business_id = businesses.id and s.status = 'in_trial' and s.deleted_at is null
            and (s.trial_end <= ${at}::timestamptz or s.current_period_end <= ${at}::timestamptz)
            and ${notQueued}
          order by s.trial_end limit ${perBusiness})
        union all
        (select s.id, s.organization_id, s.business_id, s.public_id, s.current_sub_period_end due_at
          from subscriptions s
          where s.business_id = businesses.id and s.current_sub_period_end is not null
            and s.deleted_at is null and s.status = 'active'
            and s.current_sub_period_end <= ${at}::timestamptz
            and s.current_sub_period_end < s.current_period_end
            and s.current_period_end > ${at}::timestamptz and ${notQueued}
            and ${usageCloseReached(sql`s.id`, sql`s.business_id`, sql`s.current_sub_period_end`, now)}
          order by s.current_sub_period_end limit ${perBusiness})
      ) x
      ${scope ? sql`where ${scope}` : sql``}
      limit ${room}
    ),
    -- Rank within each business: run_at steps 1 ms per rank, so the queue serves every
    -- business's first renewal, then every second one, instead of one business's whole share.
    ranked as (
      select picked.*, row_number() over (partition by business_id order by due_at) rn from picked
    )
    select count(*)::int n from graphile_worker.add_jobs(array(
      select row('renew_subscription',
                 json_build_object('organizationId', organization_id, 'businessId', business_id,
                                   'subscriptionId', id, 'publicId', public_id),
                 null, now() + rn * interval '1 millisecond', 1, 'renew:' || id::text,
                 ${sql.raw(String(RENEWAL_JOB_PRIORITY))}, null)::graphile_worker.job_spec
      from ranked), true)`)) as unknown as Array<{ n: number }>;
  return { capped: Number(rows[0]?.n ?? 0) >= room };
}

/**
 * Record a failure from work the tick queued (fan-out renewals, the collection pump) on the most
 * recent tick row, where an inline renewal's failure would have gone: `clock_ticks.errors` is
 * where "why did this not renew" is looked up.
 */
export async function recordFailureOnTick(e: TickError): Promise<void> {
  await systemDb
    .update(clockTicks)
    .set({
      errors: sql`coalesce(${clockTicks.errors}, '[]'::jsonb) || ${JSON.stringify([e])}::jsonb`,
    })
    .where(eq(clockTicks.id, sql`(select id from clock_ticks order by started_at desc limit 1)`));
}

export interface TickError {
  organization: string;
  business?: string;
  subscription?: string;
  /** The invoice a per-item failure was about, when the subject is an invoice. */
  invoice?: string;
  step: string;
  message: string;
}

/**
 * SUB-1: start future-dated subscriptions whose start date has arrived. A `future`
 * sub with a trial → `in_trial` (no invoice); without a trial → `active` and its
 * first period is billed in advance. Runs system-wide in each org's RLS context.
 */
async function startFutureSubscriptions(now: Date): Promise<TickError[]> {
  const errors: TickError[] = [];
  const due = await systemDb
    .select({ id: subscriptions.id, organizationId: subscriptions.organizationId })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, "future"),
        isNotNull(subscriptions.startDate),
        lte(subscriptions.startDate, now),
        notDeleted(),
        scanBusinessFilter(subscriptions.businessId),
      ),
    );
  for (const row of due) {
    try {
      const ctx = await withTenant(row.organizationId, async (tx) => {
        const [sub] = await tx
          .select()
          .from(subscriptions)
          .where(
            and(eq(subscriptions.id, row.id), eq(subscriptions.status, "future"), notDeleted()),
          )
          .limit(1);
        if (!sub) return null;
        // A subscription with a trial starts IN it — even a trial that has already
        // elapsed by the time this pass runs (the clock was down longer than the trial
        // lasted). It then sits `in_trial` on a boundary in the past, which makes it due
        // in THIS SAME TICK's renewal scan below, and the conversion happens there.
        //
        // This used to activate + advance to the first paid period right here, duplicating
        // the trial conversion ("this path replaces that renewal"). That duplicate is gone,
        // because `renewSubscription` is now the single place that decides whether a trial
        // converts AT ALL — `trial_end_action = 'cancel_subscription'` and the cardless
        // auto-collect-on cancel both live there, and a second conversion site silently
        // bypassed both. Everything the duplicate did by hand, that path already does:
        // the day-anchored round-up onto local midnight (`normalizeTermEnd` on the trial
        // boundary), the period advance, and the `remaining_billing_cycles` decrement that
        // the G review blocker added here precisely BECAUSE the renewal was skipped
        // (billing_cycles=1 + trial + clock downtime billed two paid cycles). With the
        // renewal no longer skipped, decrementing here as well would bill one cycle short.
        const nextStatus = sub.trialEnd != null ? "in_trial" : "active";
        const [started] = await tx
          .update(subscriptions)
          .set({
            status: nextStatus,
            startedAt: sub.startedAt ?? now,
            activatedAt: nextStatus === "active" ? now : null,
          })
          .where(and(eq(subscriptions.id, sub.id), eq(subscriptions.status, "future")))
          .returning();
        if (!started) return null;
        // The start pass crosses the trial boundary in BOTH directions — `future` →
        // `in_trial` (MRR must go to 0) and, when the trial elapsed before the clock
        // ran, `future` → `active` (MRR must be the real rate). Recompute either way
        // in this transaction, after the status write: it reads the new status and
        // derives the right answer for both, so neither direction needs its own rule.
        await recomputeSubscriptionMrr(tx, started.id, now);
        await emitEvent(tx, {
          organizationId: row.organizationId,
          businessId: sub.businessId,
          type: "subscription_started",
          data: buildEventData(
            "subscription_started",
            { id: started.publicId, status: started.status },
            started.resourceVersion,
          ),
        });
        if (nextStatus === "active") {
          await emitEvent(tx, {
            organizationId: row.organizationId,
            businessId: sub.businessId,
            type: "subscription_activated",
            data: buildEventData(
              "subscription_activated",
              { id: started.publicId, status: "active" },
              started.resourceVersion,
            ),
          });
        }
        return { sub: started };
      });
      if (ctx && ctx.sub.status === "active") {
        // Is the first bill collectable at all?
        //
        // Create-time gating (`assertChargeableForAutoCollect`) refuses a cardless
        // auto-collect-ON subscription that charges immediately, and EXEMPTS future
        // starts — reasonably, since the merchant has until the start date to add a
        // card. Nothing owned that exemption at the boundary it deferred to, so a
        // future-dated cardless subscription activated and billed straight into
        // `no_payment_method`: AR posted to the append-only ledger, MRR booked,
        // `invoice_issued` then `payment_failed` sent, and ~4 dunning retries later
        // it died as involuntary churn. Every part of that is a fiction.
        //
        // The subscription still ACTIVATES — the merchant scheduled it, and its term
        // is genuinely running — but the invoice is not raised. `healUnbilledFirstPeriods`
        // re-checks this every tick, so the moment a card is added the first period
        // bills, with no manual step: the skip is a deferral, not a refusal.
        //
        // Deliberately not the trial remedy. A trial that expires cardless is a
        // customer who never subscribed, so it cancels; this is a subscription the
        // merchant asked for, and cancelling it on its start date would be us
        // overruling them.
        if (await isFirstPeriodUncollectable(row.organizationId, ctx.sub)) {
          log.warn(
            "future-dated subscription started with nothing to charge — first period NOT invoiced",
            {
              event: "future_start_awaiting_payment_method",
              subscription: ctx.sub.publicId,
              organizationId: row.organizationId,
              businessId: ctx.sub.businessId,
              detail:
                "active with no invoice for its current period; healUnbilledFirstPeriods bills it once a payment method exists",
            },
          );
          continue;
        }
        // Bill the first period in advance (mirrors create-time active billing). It runs
        // after the activation commits, so the heal below can race it; whichever loses
        // the unique index finds the period billed.
        await billSubscriptionPeriod(
          {
            organizationId: row.organizationId,
            businessId: ctx.sub.businessId,
            subscription: ctx.sub,
            periodStart: requireTerm(ctx.sub).start,
            periodEnd: requireTerm(ctx.sub).end,
          },
          { opensPeriod: true },
        ).catch(ignorePeriodAlreadyBilled);
        // TL-4/CAT-4: fire charge_on_event='activation' attached items ONCE.
        const { fireActivationCharges } = await import("./items");
        await fireActivationCharges({
          organizationId: row.organizationId,
          businessId: ctx.sub.businessId,
          subscriptionId: ctx.sub.id,
          now,
        });
      }
    } catch (e) {
      // Isolate: one subscription must not stall the pass. RECORDED as well as logged
      // — a trial that fails to start its paid term looks, from outside, exactly like a
      // trial that simply hasn't ended yet, and the log line alone rotates away.
      log.recurringError(`trial_end_failed:${row.id}`, e, {
        event: "trial_end_failed",
        subscriptionId: row.id,
        organizationId: row.organizationId,
      });
      errors.push({
        organization: row.organizationId,
        subscription: row.id,
        step: "trial_end",
        message: (e as Error)?.message ?? String(e),
      });
    }
  }
  return errors;
}

/** A first-period bill that lost the race to another pass: the period is billed, not failed. */
function ignorePeriodAlreadyBilled(e: unknown): void {
  if (!(e instanceof PeriodAlreadyBilledError)) throw e;
}

/**
 * `isUncollectableAutoCollect` for a FIRST period — the shape both the future-start
 * pass and the unbilled-first-period heal need.
 *
 * The two contextual inputs are fixed rather than derived, and both are exact for a
 * first period rather than convenient:
 *  - `priorCovered: false` — there is no prior invoice to have pre-covered this
 *    period's usage, so the probe prices the same arrears window the real billing
 *    call would.
 *  - `createAsPending` is resolved properly (business default + per-subscription
 *    override) instead of assumed, because in pending-invoice mode nothing is owed at
 *    this boundary and the probe must say "collectable" — the draft is collected when
 *    it closes.
 */
async function isFirstPeriodUncollectable(
  organizationId: string,
  sub: typeof subscriptions.$inferSelect,
): Promise<boolean> {
  const bizPending = await withTenant(organizationId, async (tx) => {
    const [biz] = await tx
      .select({ pending: businesses.createPendingInvoices })
      .from(businesses)
      .where(eq(businesses.id, sub.businessId))
      .limit(1);
    return biz?.pending ?? false;
  });
  return isUncollectableAutoCollect({
    organizationId,
    sub,
    periodStart: requireTerm(sub).start,
    periodEnd: requireTerm(sub).end,
    createAsPending: usesPendingInvoices(sub.createPendingInvoices, bizPending),
    priorCovered: false,
  });
}

/**
 * Bill the first period of subscriptions that were activated (future → active)
 * but never invoiced — the crash window between the activation tx and the first
 * `billSubscriptionPeriod`. Idempotent: skips any sub that already has an
 * invoice whose period_start equals its current_period_start.
 *
 * Also the RETRY for a first period deliberately left unbilled because there was
 * nothing to charge (see `startFutureSubscriptions`). That is why the same
 * collectability probe runs here: without it this pass would immediately undo that
 * skip and raise the uncollectible invoice one tick later. With it, the pass bills
 * the period on the first tick after a payment method appears.
 */
async function healUnbilledFirstPeriods(now: Date): Promise<TickError[]> {
  const errors: TickError[] = [];
  const orphaned = await systemDb
    .select({ id: subscriptions.id, organizationId: subscriptions.organizationId })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, "active"),
        notDeleted(),
        isNotNull(subscriptions.startDate),
        // Two first-bill signatures: a plain future start (period begins at
        // start_date) and an elapsed-trial start (period begins at trial_end).
        // Resumed periods begin at the resume instant, so they can't match either.
        // The trial branch allows one second, because a DAY-ANCHORED trial ends at
        // 23:59:59 local and the term it opens starts on the midnight a second later
        // (`normalizeTermEnd`, above) — matched exactly, this heal could never fire for a
        // day-anchored business. One second is the whole round-up and stays far away from
        // any resume instant, so it cannot pull in a period that was never meant to bill.
        sql`(${subscriptions.currentPeriodStart} = ${subscriptions.startDate}
           or ${subscriptions.currentPeriodStart} = ${subscriptions.trialEnd}
           or ${subscriptions.currentPeriodStart} = ${subscriptions.trialEnd} + interval '1 second')`,
        lte(subscriptions.currentPeriodStart, now),
        notExists(
          systemDb
            .select({ one: sql`1` })
            .from(invoices)
            .where(
              and(
                eq(invoices.subscriptionId, subscriptions.id),
                eq(invoices.periodStart, subscriptions.currentPeriodStart),
              ),
            ),
        ),
        scanBusinessFilter(subscriptions.businessId),
      ),
    );
  for (const row of orphaned) {
    try {
      await withTenant(row.organizationId, async (tx) => {
        const [sub] = await tx
          .select()
          .from(subscriptions)
          .where(and(eq(subscriptions.id, row.id), notDeleted()))
          .limit(1);
        if (!sub) return;
        // Re-check inside RLS right before billing (cheap double-read; the
        // billSubscriptionPeriod below is outside this tx, so a race here at
        // worst re-creates the invoice the NOT EXISTS already filtered).
        const [existing] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(
              eq(invoices.subscriptionId, sub.id),
              eq(invoices.periodStart, requireTerm(sub).start),
            ),
          )
          .limit(1);
        if (existing) return;
        return sub;
      }).then(async (sub) => {
        if (!sub) return;
        // Still nothing to charge → still don't invoice. This is the deferral being
        // held, not a crash being healed; next tick asks again.
        if (await isFirstPeriodUncollectable(row.organizationId, sub)) return;
        // The read above is not a lock: a concurrent pass may bill first. The unique
        // index then refuses this one, and the period is billed.
        await billSubscriptionPeriod(
          {
            organizationId: row.organizationId,
            businessId: sub.businessId,
            subscription: sub,
            periodStart: requireTerm(sub).start,
            periodEnd: requireTerm(sub).end,
          },
          { opensPeriod: true },
        ).catch(ignorePeriodAlreadyBilled);
      });
    } catch (e) {
      // Isolate — retried next tick. A subscription that throws here is one that
      // renewed in the engine's eyes but never got its invoice, which is precisely the
      // state nothing else would ever surface: recorded, not just logged.
      log.recurringError(`renewal_failed:${row.id}`, e, {
        event: "renewal_failed",
        subscriptionId: row.id,
        organizationId: row.organizationId,
      });
      errors.push({
        organization: row.organizationId,
        subscription: row.id,
        step: "heal_unbilled_first_period",
        message: (e as Error)?.message ?? String(e),
      });
    }
  }
  return errors;
}

/**
 * Should a trial ending now CANCEL instead of converting, and under which reason?
 * `null` = convert normally. Read-only; the caller does every write.
 *
 * The two reasons are not interchangeable, and the difference is not cosmetic —
 * `no_card` is already wired up as involuntary churn (`metrics/analytics.ts`
 * INVOLUNTARY_REASONS) and triggers the nonpayment cancellation email
 * (`emails/outbox.ts` NONPAYMENT_CANCEL_REASONS).
 * A `trial_ended` cancellation is neither of those things: the merchant configured
 * a trial that expires, nobody failed to pay, and counting it as involuntary churn
 * or dunning it by email would both be wrong.
 */
async function resolveTrialEndCancel(input: {
  organizationId: string;
  sub: typeof subscriptions.$inferSelect;
  trialEndAction: string | null;
  periodStart: Date;
  periodEnd: Date;
  createAsPending: boolean;
  priorCovered: boolean;
}): Promise<"trial_ended" | "no_card" | null> {
  const { organizationId, sub } = input;

  // (1) Configured to expire. No further questions — not about the card, not about
  // auto-collection, not about the amount.
  if (input.trialEndAction === "cancel_subscription") return "trial_ended";

  // (2) Nothing to charge on a subscription we are meant to charge.
  //
  // Pending-invoice mode is exempt: the renewal opens a DRAFT that accretes usage and
  // is collected when it closes, so nothing is owed at this boundary and there is
  // nothing yet to fail (the billing call below returns early on a `pending` invoice
  // for exactly that reason). Cancelling here would kill a subscription whose first
  // bill has not even been assembled.
  return (await isUncollectableAutoCollect(input)) ? "no_card" : null;
}

/**
 * Is this a subscription the engine is meant to CHARGE, with nothing at all to charge
 * it with, and a real amount owed? Read-only — the caller decides what to do about it.
 *
 * Two boundaries ask this and they want opposite remedies, which is why the question
 * is factored out of the answer:
 *  - a **trial ending** cardless is a customer who never subscribed → cancel
 *    (`resolveTrialEndCancel`),
 *  - a **future-dated start** is a subscription the merchant deliberately scheduled →
 *    activate but do not raise an invoice that can only fail (`startFutureSubscriptions`).
 *
 * Getting it wrong in the permissive direction is expensive and was live on the
 * future-start path until 2026-08-19: the invoice is raised, AR is posted to the
 * append-only ledger, `invoice_issued` then `payment_failed` go out, and dunning
 * unwinds all of it days later as involuntary churn — a conversion and a churn that
 * both never happened, settled by a compensating void.
 */
async function isUncollectableAutoCollect(input: {
  organizationId: string;
  sub: typeof subscriptions.$inferSelect;
  periodStart: Date;
  periodEnd: Date;
  createAsPending: boolean;
  priorCovered: boolean;
}): Promise<boolean> {
  const { organizationId, sub } = input;

  // Pending-invoice mode is exempt: the period opens a DRAFT that accretes usage and
  // is collected when it closes, so nothing is owed at this boundary and there is
  // nothing yet to fail (`billSubscriptionPeriod` returns early on a `pending`
  // invoice for exactly that reason). Acting here would judge a bill that has not
  // been assembled.
  if (input.createAsPending) return false;

  const custAutoCollection = await withTenant(organizationId, async (tx) => {
    const [c] = await tx
      .select({ ac: customers.autoCollection })
      .from(customers)
      .where(eq(customers.id, sub.customerId))
      .limit(1);
    return c?.ac ?? null;
  });
  // Auto-collect OFF is the send-invoice model — a missing card is not a failure
  // there, it is the whole arrangement.
  if (!isAutoCollectOn(sub.autoCollection, custAutoCollection)) return false;

  // "Nothing to charge" is deliberately the NARROWEST possible test: no payment
  // method row at all, which is exactly the case where `collectInvoice` cannot even
  // make an attempt (it records `no_payment_method` without calling a gateway).
  //
  // An EXPIRED or previously-declined card is left alone to try and fail into
  // dunning. `resolveChargeCandidates` does not filter by status, so this asks only
  // "is there anything at all to charge" — and that is the right question, because
  // cancelling a customer who DOES have a card on file, on our judgement that it
  // looks stale, is a far worse failure than one wasted retry. Note this is narrower
  // than the `no_card` reason `applyDunningFinalAction` derives (which also counts a
  // customer whose every card has expired); the reason string is shared, the test
  // for reaching it is not.
  const { primary } = await resolveChargeCandidates({
    organizationId,
    customerId: sub.customerId,
    subscription: sub,
  });
  if (primary) return false;

  // Cardless — but is anything actually OWED? A free plan, a 100%-off coupon, or a
  // credit balance covering the period all produce an invoice that never needed a
  // card, and those subscriptions are perfectly collectable. Gating on card presence
  // alone would act against every one of them.
  //
  // This is the read-only half of `billSubscriptionPeriod` (the plan/commit split
  // exists precisely so a caller can veto the money before it is persisted): it
  // writes nothing and emits nothing. The plan is then DISCARDED and the real
  // billing re-plans — deliberately, because a plan and its commit can legitimately
  // disagree when a concurrent credit draw moves the balances, and the commit path
  // already owns that reconciliation under the per-customer lock.
  const plan = await planSubscriptionPeriodInvoice({
    organizationId,
    businessId: sub.businessId,
    subscription: sub,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    // The same arrears window the real billing call would pass, so the probe prices
    // the invoice that would actually be raised — a trial with metered usage does owe
    // for it, and a probe that ignored usage would cancel a subscription that had a
    // collectable bill.
    // Usage is metered over the TERM, so a subscription without one (trialling) has no
    // usage window to report — `undefined` is exactly right there.
    usagePeriod: termUsageWindow(sub, { priorCovered: input.priorCovered }),
  });
  // Not reachable while `createAsPending` is false above, but the plan is a union and
  // a draft carries no money — narrow rather than assert, and treat it as collectable
  // if it ever is.
  if (plan.mode !== "finalize") return false;
  return plan.money.amountDue > 0n;
}

/**
 * Cancel a subscription AT the boundary the billing clock just reached, instead of
 * rolling it forward. Two callers, two boundaries, one body: a trial that did not
 * convert, and a renewal the customer cannot pay for.
 *
 * `activatedAt` is not touched, and that is load-bearing in both directions. It is the
 * exact discriminator that separates an engine trial-expiry from a person cancelling
 * mid-trial — "activated_at present
 * means the trial converted and any later cancellation is an ordinary end-of-term
 * one". So a trial that dies here keeps its NULL and reads as an expiry, and a renewal
 * that dies here keeps the date it was activated on and reads as end-of-term. Stamping
 * or clearing it would make each look like the other.
 *
 * `currentPeriodEnd` is likewise left where the boundary was rather than advanced: the
 * subscription never entered the next term, and that same classifier wants
 * `cancelled_at >= ` the boundary it died at.
 *
 * `expectStatus` is the status the CALLER read, not a constant. The guarded claim has
 * to compare against the row the decision was made on, or two overlapping ticks both
 * cancel and both emit `subscription.canceled`.
 */
/** The business trial-end default, spelled as the price-level `trial_end_action`. */
const TRIAL_END_DEFAULT_ACTION: Record<TrialEndAction, string | null> = {
  activate: null,
  cancel: "cancel_subscription",
  pause: "pause_subscription",
};

/**
 * Trial ends paused instead of converting: no term, no invoice. A resume starts the first
 * paid term and bills it (out-of-term resume). Guarded like `cancelAtBoundary`.
 */
async function pauseAtTrialEnd(input: {
  organizationId: string;
  sub: typeof subscriptions.$inferSelect;
  now: Date;
}): Promise<void> {
  const { organizationId, sub, now } = input;
  await withTenant(organizationId, async (tx) => {
    const before = await subscriptionSnapshot(tx, sub);
    const [p] = await tx
      .update(subscriptions)
      .set({ status: "paused" })
      .where(
        and(
          eq(subscriptions.id, sub.id),
          eq(subscriptions.status, "in_trial"),
          sub.currentPeriodEnd == null
            ? isNull(subscriptions.currentPeriodEnd)
            : eq(subscriptions.currentPeriodEnd, sub.currentPeriodEnd),
        ),
      )
      .returning();
    if (!p) return;
    await recomputeSubscriptionMrr(tx, p.id, now);
    await emitEvent(tx, {
      organizationId,
      businessId: sub.businessId,
      type: "subscription_paused",
      data: buildEventData(
        "subscription_paused",
        { id: p.publicId, status: "paused" },
        p.resourceVersion,
        { ended_trial: true },
      ),
    });
    await auditSubscription(tx, {
      organizationId,
      businessId: sub.businessId,
      action: "subscription.pause",
      before,
      after: p,
    });
  });
}

async function cancelAtBoundary(input: {
  organizationId: string;
  sub: typeof subscriptions.$inferSelect;
  expectStatus: "in_trial" | "active";
  reason: "trial_ended" | "no_card";
  now: Date;
}): Promise<void> {
  const { organizationId, sub, expectStatus, reason, now } = input;
  await withTenant(organizationId, async (tx) => {
    const before = await subscriptionSnapshot(tx, sub);
    // Guarded claim, same as the term-end cancel above: a concurrent cancel or an
    // overlapping tick must not re-cancel and re-emit subscription.canceled. The
    // status guard also pins this to a row still in the state the caller decided on,
    // so a tick that races a conversion cannot cancel a subscription another tick has
    // already activated (or renewed).
    const [c] = await tx
      .update(subscriptions)
      // Both ways of holding a pending cancellation are cleared alongside the status —
      // either boundary may well also have had one scheduled, and leaving either set makes the
      // terminal row advertise a cancellation that already happened and render a
      // "Remove scheduled cancellation" button that throws. `remainingBillingCycles`
      // is left alone (see `cancelSubscription`).
      .set({
        status: "cancelled",
        canceledAt: now,
        cancelReason: reason,
        cancelAtPeriodEnd: false,
        cancelScheduledAt: null,
        cancelBookedAt: frozenStopBooking(sub, now),
      })
      .where(
        and(
          eq(subscriptions.id, sub.id),
          eq(subscriptions.status, expectStatus),
          // The claim compares against the value we READ. A converting trial read NULL (it
          // had no term), and `= NULL` is never true in SQL — so the guard has to be IS NULL
          // there or every trial conversion would lose its own race and silently never bill.
          sub.currentPeriodEnd == null
            ? isNull(subscriptions.currentPeriodEnd)
            : eq(subscriptions.currentPeriodEnd, sub.currentPeriodEnd),
        ),
      )
      .returning();
    if (!c) return;
    // Cancelled → cached mrr 0, the rule every cancel path owes (see
    // `cancelSubscription`). For a trialing sub, which already stores 0, this is
    // normally a no-op — but it must run anyway: the row is terminal now, deriving the
    // zero is what keeps it correct if a trial ever carried a rate, and a cardless
    // RENEWAL cancelled here is a subscription that really was booking a rate until
    // this instant.
    await recomputeSubscriptionMrr(tx, c.id, now);
    await emitEvent(tx, {
      organizationId,
      businessId: sub.businessId,
      // 'cancelled', not 'canceled' — the stored enum and every other emitter of this
      // event use the double-l spelling (see applyDunningFinalAction, which shipped
      // the American form and broke consumers switching on `status`).
      type: "subscription_canceled",
      data: buildEventData(
        "subscription_canceled",
        { id: c.publicId, status: "cancelled", reason },
        c.resourceVersion,
        // Top-level: enrichment replaces the resource payload. Routes the email.
        expectStatus === "in_trial" ? { ended_trial: true } : undefined,
      ),
    });
    // Audited even though nobody chose it — same argument as the activation below:
    // actor 'billing_clock', source 'scheduled_job', no IP, because there was no
    // request. A subscription that died at its boundary is exactly the row an operator
    // needs when asked why a customer vanished.
    await auditSubscription(tx, {
      organizationId,
      businessId: sub.businessId,
      action: "subscription.cancel",
      before,
      after: c,
    });
  });
}

/**
 * Reload the subscription + derive its interval inside the org's RLS context. Shared by
 * `renewSubscription` and `isTrialConversionUncollectable`, so the pre-flight probe reads
 * exactly what the conversion itself will read — a probe on a different snapshot would be
 * a different question.
 */
async function loadRenewalCtx(organizationId: string, subscriptionId: string) {
  return withTenant(organizationId, async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      // Re-checked here and not only in the scan: a delete can land between the two, and the
      // tick must not bill a subscription that was removed while it queued.
      .where(and(eq(subscriptions.id, subscriptionId), notDeleted()))
      .limit(1);
    if (!sub) return null;
    // Every recurring item, not `limit 1`. Two different things used to be read off one
    // arbitrary row here, and both were wrong on a mixed-cadence subscription:
    //
    //  1. THE RENEWAL CADENCE. `limit 1` over an unordered set took the interval from
    //     whichever recurring item Postgres happened to return. That is harmless while
    //     every item shares a cadence and catastrophic once they don't — and a
    //     monthly→yearly plan change produces exactly that state, because the monthly
    //     add-ons keep their monthly price on the now-yearly plan. Measured 2026-08-23:
    //     a yearly term renewed after **16 days** (periodStart + 1 MONTH, re-aligned to
    //     a stale anchor day) and raised an invoice for the FULL yearly amount,
    //     ₹98,700. Being unordered it could pass a fixture and fail in production.
    //     The cadence of a TERM is the subscription's own property — `billing_period` /
    //     `billing_period_unit`, which `changeSubscription` keeps correct and which
    //     every other renewal-adjacent path already trusts — so it is read from `sub`
    //     and no item gets a vote. (It was also reading the CATALOG price rather than
    //     the item's `price_snapshot`, so any `alignSnapshotToCycle` folding was
    //     invisible to it too; moot now that the item is not consulted.)
    //
    //  2. `trial_end_action` — whether a trial ending here converts or cancels
    //     (`resolveTrialEndCancel`). Same non-determinism, and the same class of harm:
    //     an ADD-ON carrying `cancel_subscription` could cancel a subscription whose
    //     plan says to convert. It is a plan-price setting and is treated
    //     as one here — resolved from the PLAN item, with the first recurring item as a
    //     fallback for a plan-less subscription (an add-on-only sub is legal).
    const recurringRows = await tx
      .select({
        interval: prices.interval,
        intervalCount: prices.intervalCount,
        trialEndAction: prices.trialEndAction,
        productKind: products.kind,
      })
      .from(subscriptionItems)
      .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
      .innerJoin(products, eq(prices.productId, products.id))
      .where(and(eq(subscriptionItems.subscriptionId, sub.id), eq(prices.type, "recurring")));
    // `recurring` stays undefined when there is nothing recurring, so the existing
    // `if (!ctx.recurring) return` guards keep meaning "nothing here renews".
    const planRow = recurringRows.find((r) => r.productKind === "plan") ?? recurringRows[0];
    const recurring =
      recurringRows.length > 0
        ? {
            interval: (sub.billingPeriodUnit ?? "month") as Interval,
            intervalCount: sub.billingPeriod ?? 1,
            trialEndAction: planRow?.trialEndAction ?? null,
          }
        : undefined;
    // Business default for pending-invoice billing (E2).
    const [biz] = await tx
      .select({
        pending: businesses.createPendingInvoices,
        billingRulesConfig: businesses.billingRulesConfig,
      })
      .from(businesses)
      .where(eq(businesses.id, sub.businessId))
      .limit(1);
    return {
      sub,
      recurring,
      bizPending: biz?.pending ?? false,
      trialEndDefault: resolveBillingRulesConfig(biz).trialEndAction,
      mode: await billingModeFor(tx, sub.businessId),
    };
  });
}

/**
 * Would converting this trial at `boundary` be uncollectable — auto-collection on, no
 * payment method at all, and a real amount owed?
 *
 * Exists for ONE caller: the operator-initiated `edit_trial_end { immediately: true }`,
 * which asks BEFORE it moves the boundary. A natural trial end has nobody to tell, so the
 * clock converts and then cancels (`no_card`, involuntary churn). An operator is waiting
 * on a reply, so this request is refused — "Cannot change the subscription as there is no
 * valid card on file" — instead of quietly killing the subscription they were trying to
 * activate. Same rule, different remedy.
 *
 * The window is the one the conversion would open (`normalizeTermEnd(boundary)` → one
 * interval on), so pending-invoice mode and a genuinely free first term both come back
 * collectable and are NOT refused.
 */
export async function isTrialConversionUncollectable(
  organizationId: string,
  subscriptionId: string,
  boundary: Date,
): Promise<boolean> {
  const ctx = await loadRenewalCtx(organizationId, subscriptionId);
  if (!ctx?.sub || !ctx.recurring) return false;
  const { sub, recurring } = ctx;
  const periodStart = normalizeTermEnd(boundary, ctx.mode);
  const periodEnd = advancePeriod(
    periodStart,
    (recurring.interval ?? "month") as Interval,
    recurring.intervalCount ?? 1,
    sub.billingAnchorDay,
    ctx.mode,
  );
  return isUncollectableAutoCollect({
    organizationId,
    sub,
    periodStart,
    periodEnd,
    createAsPending: usesPendingInvoices(sub.createPendingInvoices, ctx.bizPending),
    // No invoice covers the trial window's usage, so the probe prices the same arrears
    // window the real billing call would — same reasoning as `isFirstPeriodUncollectable`.
    priorCovered: false,
  });
}

/**
 * Renew (or activate, for a trialing sub) one subscription whose period has
 * ended. Exported so the edit-trial-end "immediately" op (SUB-EDIT-TRIAL) can
 * reuse the exact trial-end billing path instead of reimplementing it — the
 * caller moves `trial_end`/`current_period_end` to `now` first, then calls this.
 */
export async function renewSubscription(
  organizationId: string,
  subscriptionId: string,
  now: Date,
  /** Leave the invoice to `number_invoices` (batch numbering), which also queues its collection. */
  opts: {
    deferNumber?: boolean;
    /** An operator ended the trial to activate it: the business trial-end default does not apply. */
    endTrialNow?: boolean;
  } = {},
): Promise<void> {
  const ctx = await loadRenewalCtx(organizationId, subscriptionId);
  if (!ctx?.sub || !ctx.recurring) return;
  const { sub, recurring } = ctx;
  // Monthly usage billing: bill the earliest due boundary, one per run.
  if (subPeriodDue(sub, now)) {
    await billSubPeriod({ organizationId, sub, mode: ctx.mode, deferNumber: opts.deferNumber });
    return;
  }
  // A split subscription is queued for its boundaries too; the term itself is not due yet.
  if (
    sub.status === "active" &&
    sub.currentSubPeriodEnd != null &&
    sub.currentPeriodEnd != null &&
    sub.currentPeriodEnd.getTime() > now.getTime()
  )
    return;
  const interval = (recurring.interval ?? "month") as Interval;
  const intervalCount = recurring.intervalCount ?? 1;
  // Pending-invoice billing (E2): renew into an open `pending` invoice that
  // accretes usage until closed, instead of finalizing + charging now.
  const createAsPending = usesPendingInvoices(sub.createPendingInvoices, ctx.bizPending);

  // The new period starts where the old one ended, and ends one interval later —
  // re-aligned to the persisted calendar anchor day so a short month can't drift
  // the billing date permanently forward (CUST-5 review fix).
  //
  // One exception, and only for a TRIAL converting: a day-anchored business's terms sit
  // on local midnights, but a day-anchored trial deliberately ends at the LAST moment of
  // its final day (…23:59:59 — `alignTrialEnd`). Taken literally the term it
  // converts into would start a second before midnight and every later boundary would
  // inherit that offset (`current_term_start: 10-Aug 23:59:59`), so round the trial
  // boundary up to the midnight it is a hair short of. An exact midnight — every ordinary
  // renewal, and the aligned boundary `editTrialEnd` writes — passes through untouched,
  // and instant-anchored businesses are never touched at all.
  // A trialling subscription has NO term (2026-08-25), so its first paid period opens at
  // the TRIAL end — which is what `currentPeriodEnd` used to hold for it.
  // Prefer the trial's own end; fall back to the term for a pre-0189 trial that still has
  // one (see the due scan above).
  const priorBoundary =
    sub.status === "in_trial" ? (sub.trialEnd ?? sub.currentPeriodEnd) : sub.currentPeriodEnd;
  if (priorBoundary == null) {
    throw new Error(
      `subscription ${sub.publicId} has no boundary to renew from (status ${sub.status}) — ` +
        `a trialling subscription renews from trial_end, an active one from current_period_end`,
    );
  }
  const periodStart =
    sub.status === "in_trial" ? normalizeTermEnd(priorBoundary, ctx.mode) : priorBoundary;
  const periodEnd = advancePeriod(
    periodStart,
    interval,
    intervalCount,
    sub.billingAnchorDay,
    ctx.mode,
  );

  // Term end is the cancellation point when cancel_at_period_end was set OR the
  // subscription has run out its remaining_billing_cycles (SUB-2/SUB-4: it became
  // non_renewing and this is the end of its final cycle).
  if (sub.cancelAtPeriodEnd || sub.remainingBillingCycles === 0) {
    await cancelAtTermEnd({ organizationId, sub, now, deferNumber: opts.deferNumber });
    return;
  }

  // Was the just-ended period's usage already claimed by ITS OWN invoice?
  // A pending draft persists the arrears window it bills at close
  // (metadata.usage_window); if the prior period's invoice covers itself, this
  // renewal must not re-bill that window — and vice versa, if it doesn't (old
  // regime / first invoice), a new pending draft must pick the window up, or a
  // whole period of metered usage is silently never invoiced (E-review B5).
  //
  // Read BEFORE the advance (it used to sit just above the billing call) because the
  // trial-end gate below needs it too, to probe the same invoice the real billing
  // would raise. Safe to move: every value it reads is off `sub`, the pre-advance
  // snapshot, and the invoice it looks for is the PRIOR period's — this renewal's
  // has not been created yet either way.
  //
  // A CONVERTING TRIAL has no prior term to have been covered (2026-08-25: trial and term
  // are mutually exclusive), and no usage invoice behind it either — so the question is
  // simply "no", and asking it with `requireTerm` would throw on the one subscription
  // shape this function exists to advance.
  const priorCovered = await priorPeriodCovered(organizationId, sub);

  // ── DOES THIS TRIAL CONVERT AT ALL? ────────────────────────────────────────
  // Everything past this point activates the subscription and bills it. A trial has
  // two ways of not getting that far, and both have to be decided HERE — before the
  // activate write, not by unwinding it afterwards:
  //
  //  1. The merchant said so. `trial_end_action = 'cancel_subscription'` on the plan
  //     price is an explicit "this trial does not convert", and it is unconditional:
  //     card or no card, auto-collection either way. This was settable through the
  //     API and offered in the price form, but NOTHING read it — the subscription
  //     activated and billed regardless, which is the dead-control failure CLAUDE.md
  //     forbids.
  //  2. Auto-collection is ON and there is nothing to charge. Discovering that after
  //     activating costs far more than a wasted retry: the activate write books full
  //     MRR (see the recompute below — "the conversion is where MRR becomes real"),
  //     posts AR to the append-only ledger, and sends invoice_issued then
  //     payment_failed — and dunning unwinds all of it days later as involuntary
  //     churn. Analytics record a conversion AND a churn that never happened, and
  //     the ledger carries entries for money that was never collectible, settled by
  //     a compensating void or write-off. Dunning's grace period buys nothing here
  //     either: the TRIAL was the grace period, and a customer who ignored the whole
  //     of it is not served by four more retries against a card that doesn't exist.
  //
  // Auto-collect OFF stays on the converting path deliberately — that is the
  // send-invoice model, where no card is EXPECTED, the invoice IS the bill and net
  // terms apply. `resolveTrialEndCancel` is where that split lives.
  if (sub.status === "in_trial") {
    // The price's own value wins; else the business default (billing_rules_config).
    const trialEndAction =
      recurring.trialEndAction ??
      (opts.endTrialNow ? null : TRIAL_END_DEFAULT_ACTION[ctx.trialEndDefault]);
    if (trialEndAction === "pause_subscription") {
      await pauseAtTrialEnd({ organizationId, sub, now });
      return;
    }
    const reason = await resolveTrialEndCancel({
      organizationId,
      sub,
      trialEndAction,
      periodStart,
      periodEnd,
      createAsPending,
      priorCovered,
    });
    if (reason) {
      await cancelAtBoundary({ organizationId, sub, expectStatus: "in_trial", reason, now });
      return;
    }
  }

  // ── IS THIS RENEWAL SKIPPED? ───────────────────────────────────────────────
  // Before the no-card gate: a skipped renewal charges no recurring items, so a missing
  // card is no reason to cancel it. Skips are refused on trials and pending-invoice billing.
  if (sub.status === "active" && !createAsPending) {
    const skip = await withTenant(organizationId, (tx) =>
      scheduledSkipAt(tx, sub.id, priorBoundary),
    );
    if (skip) {
      await renewSkipped({
        organizationId,
        sub,
        skipId: skip.id,
        periodStart,
        periodEnd,
        priorCovered,
        mode: ctx.mode,
        now,
        deferNumber: opts.deferNumber,
      });
      return;
    }
  }

  // ── DOES THIS RENEWAL HAPPEN AT ALL? ───────────────────────────────────────
  // The same question the trial gate above asks, at the other boundary — and it went
  // unasked until 2026-08-27. `isUncollectableAutoCollect` was wired to trial-end and
  // to a first period, never to a renewal, so a cardless auto-collect subscription
  // rolled its term, raised an invoice, recorded a `no_payment_method` failure and sent
  // `payment_failed` — and then dunning unwound all of it days later as involuntary
  // churn.
  //
  // Unlike the trial, the remedy is NOT ours to choose. An active subscription that
  // cannot pay is exactly what the business's dunning FINAL ACTION already decides, and
  // deciding it again here would override a merchant who chose `retain`. So this gate
  // does not invent a policy — it asks the configured one at the boundary instead of
  // after four impossible retries:
  //
  //  - `cancel` → cancel here, reason `no_card`. No term roll, no invoice, no AR on the
  //    append-only ledger, no `payment_failed`. Also taken under `retain` when the
  //    merchant set `no_payment_method_at_renewal: cancel`.
  //  - `retain` → the merchant wants the dues on the books, so the invoice IS still
  //    raised — but committed with `collect: false`. An attempt against a customer with
  //    no payment method cannot reach a gateway at all (`collectInvoice` records
  //    `no_payment_method` without calling one), so the boundary attempt is pure noise:
  //    a failed payment row and a `payment_failed` email that teach the customer
  //    nothing. Dunning owns the retries from here, which is what `retain` means.
  //
  // ⚠️ KNOWN COST OF THE CANCEL BRANCH: it does not bill the just-ended period's
  // metered usage, which the probe has just priced into `amountDue`. That is deliberate
  // — the alternative is raising an invoice solely so it can fail — but it IS revenue we
  // stop invoicing. A merchant who wants that receivable configures `retain`.
  //
  // Cheap for the common case: the probe returns on the pending-invoice check or the
  // auto-collection check before it queries anything expensive, and only reaches the
  // plan for a cardless auto-collect subscription.
  let skipCollection = false;
  if (
    sub.status !== "in_trial" &&
    (await isUncollectableAutoCollect({
      organizationId,
      sub,
      periodStart,
      periodEnd,
      createAsPending,
      priorCovered,
    }))
  ) {
    const dunning = await withTenant(organizationId, (tx) =>
      loadRenewalDunningConfig(tx, sub.businessId, sub.customerId, sub.id),
    );
    // `noPaymentMethodAtRenewal: cancel` lets a `retain` business still cancel the
    // no-card case here; card declines keep following the final action.
    if (
      dunning.finalAction.subscription === "cancel" ||
      dunning.noPaymentMethodAtRenewal === "cancel"
    ) {
      log.warn("cardless renewal cancelled at the boundary", {
        event: "renewal_no_card_cancel",
        subscriptionId: sub.id,
        organizationId,
        businessId: sub.businessId,
      });
      await cancelAtBoundary({
        organizationId,
        sub,
        expectStatus: "active",
        reason: "no_card",
        now,
      });
      return;
    }
    skipCollection = true;
  }

  // Advance the period + activate (trial ends here) BEFORE billing, so the
  // invoice we generate reflects the new period. Decrement remaining_billing_cycles
  // (SUB-4): one fewer cycle remains after this renewal; null = renews forever.
  const nextRemaining =
    sub.remainingBillingCycles != null ? Math.max(0, sub.remainingBillingCycles - 1) : null;
  // The new term's sub-period (usage cursor at its start) and commitment segments.
  const nextTermFields = {
    ...subPeriodFields(sub, periodStart, periodEnd, ctx.mode),
    commitmentSegments: freshSegments(sub.commitmentAmountMinor, periodStart),
  };
  //
  // The claim runs INSIDE the invoice transaction (`claim` below), so the period advance and its
  // invoice commit or roll back together. Run as two transactions, a crash between them (a
  // deploy killing the worker, a lost connection) left the period advanced with no invoice, and
  // nothing re-bills it (D4: 21 such at a worker kill, 258 at connection exhaustion).
  const claim = async (tx: Tx): Promise<boolean> => {
    // ATOMIC CLAIM (F review blocker): only a still-renewable sub whose period
    // hasn't been advanced by anyone else. Without the status guard a concurrent
    // cancel-immediately got resurrected (status forced back to 'active') and
    // billed; without the period guard two overlapping ticks both advanced +
    // both billed. The loser sees no row and stops.
    const before = await subscriptionSnapshot(tx, sub);
    const [updated] = await tx
      .update(subscriptions)
      .set({
        status: "active",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        remainingBillingCycles: nextRemaining,
        ...nextTermFields,
        // A trial converting here IS the activation, so stamp `activated_at` — this path
        // emitted `subscription_activated` but never set the column, leaving a row that
        // read `active` with `activated_at: null` and no "Active on" row in the timeline
        // (found 2026-08-02). `?? periodStart` keeps it idempotent: a later renewal of an
        // already-active sub must not move the date, and the instant is the TERM START
        // (= the trial end), not when the clock happened to run — so a tick that fires a
        // minute late still records the boundary the customer was actually activated on.
        activatedAt: sub.activatedAt ?? periodStart,
      })
      .where(
        and(
          eq(subscriptions.id, sub.id),
          inArray(subscriptions.status, ["in_trial", "active"]),
          // Same as the claim above: a converting trial read NULL, and `= NULL` never
          // matches, so it must be an IS NULL test or the conversion loses its own race.
          sub.currentPeriodEnd == null
            ? isNull(subscriptions.currentPeriodEnd)
            : eq(subscriptions.currentPeriodEnd, sub.currentPeriodEnd),
        ),
      )
      .returning();
    if (!updated) return false;
    // A trial ending here is an activation; every period roll-forward is a renewal.
    if (sub.status === "in_trial") {
      // THE CONVERSION IS WHERE MRR BECOMES REAL. A trialing subscription stores
      // `mrr = 0` (see `recomputeSubscriptionMrr`), so unless this
      // recompute runs the moment the trial converts, every converted subscription
      // reports 0 MRR forever — a far worse bug than the one the zero closes. It runs
      // in THIS transaction, AFTER the status write above (the recompute reads the
      // status off the row), so `active` + the real rate commit together and a
      // rolled-back conversion cannot leave a live sub restated.
      // The term start, not the tick: a conversion is worth what it is worth from the
      // trial's end, and a clock that fires late must not move the revenue a day on.
      await recomputeSubscriptionMrr(tx, sub.id, periodStart);
      await emitEvent(tx, {
        organizationId,
        businessId: sub.businessId,
        type: "subscription_activated",
        data: buildEventData(
          "subscription_activated",
          { id: updated.publicId, status: "active" },
          updated.resourceVersion,
        ),
      });
    }
    await emitEvent(tx, {
      organizationId,
      businessId: sub.businessId,
      type: "subscription_renewed",
      data: buildEventData(
        "subscription_renewed",
        // Reported, not stored: a consumer reconciling this event against
        // `GET /v1/subscriptions/:id` must see the same term end, and the read reports a
        // day-anchored boundary inclusively (`inclusiveBoundary`).
        {
          id: updated.publicId,
          current_period_start: periodStart,
          current_period_end: inclusiveBoundary(periodEnd, ctx.mode),
        },
        updated.resourceVersion,
      ),
    });
    // Audited even though NOBODY CHOSE IT. Every other audited action has an operator
    // behind it; this one is usually the billing clock, and `writeAuditLog` records
    // that honestly — actor 'billing_clock', source 'scheduled_job', and a NULL IP,
    // because there was no request. It belongs in the log regardless: "Subscription
    // activated" with the term and MRR that moved is the row an operator most often
    // needs to reconcile. Skipping unattended changes is what made the Activity Log
    // sparse.
    //
    // `sub` is the pre-update row read by the caller, and no items change here.
    await auditSubscription(tx, {
      organizationId,
      businessId: sub.businessId,
      action: sub.status === "in_trial" ? "subscription.activate" : "subscription.renew",
      before,
      after: updated,
    });
    return true;
  };
  // The row the claim writes, for the plan: it reads only the id, customer and currency.
  const advanced = {
    ...sub,
    status: "active" as const,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    remainingBillingCycles: nextRemaining,
    activatedAt: sub.activatedAt ?? periodStart,
    ...nextTermFields,
  };

  const billInput = {
    organizationId,
    businessId: sub.businessId,
    subscription: advanced,
    periodStart,
    periodEnd,
    // Bill metered usage in arrears for the period that just closed — unless a
    // prior pending invoice already owns that window (transition out of pending
    // mode must not double-bill it).
    usagePeriod: termUsageWindow(sub, { priorCovered: createAsPending || priorCovered }),
    // The closing term's minimum commitment (none for a converting trial).
    commitment: createAsPending ? undefined : closingCommitment(sub),
    // Pending mode: create an open draft; it bills its own period's usage at
    // close, plus the just-ended period's if nothing else claimed it.
    createAsPending,
    pendingUsageWindow: createAsPending
      ? // `sub.currentPeriodStart` is null for a converting trial (it had no term), and the
        // window it would have covered is the new period itself.
        {
          start: priorCovered ? periodStart : (sub.currentPeriodStart ?? periodStart),
          end: periodEnd,
        }
      : undefined,
  };
  // Collection rules (0486): a small-invoice write-off or a charge on the due date. Inactive
  // (the default), the commit below is unchanged.
  const rules =
    createAsPending || skipCollection
      ? null
      : await loadRenewalCollectionRules(organizationId, sub);
  const ruled = !!rules && rules.autoCollect && collectionRulesActive(rules.cfg, sub.currency);
  // `retain` + no payment method: raise the invoice, skip the attempt that cannot reach
  // a gateway. Same plan, same money, same events — only the collection step differs,
  // which is precisely what the plan/commit split exists for.
  let billed: Awaited<ReturnType<typeof commitSubscriptionPeriodInvoice>>;
  try {
    billed = await commitSubscriptionPeriodInvoice(await planSubscriptionPeriodInvoice(billInput), {
      claim,
      // The claim already serializes renewals. A conflict here means another invoice opens
      // this period while the term was never advanced: it throws and is recorded on the tick.
      opensPeriod: true,
      ...(skipCollection || ruled
        ? { collect: false }
        : opts.deferNumber
          ? { deferNumber: true }
          : {}),
    });
  } catch (e) {
    if (e instanceof PeriodClaimLostError) return; // concurrent cancel / overlapping tick
    throw e;
  }
  if (ruled && billed.invoice.status !== "pending")
    billed = await settleCollection({
      organizationId,
      businessId: sub.businessId,
      subscription: advanced,
      invoice: billed.invoice,
      cfg: rules!.cfg,
      now,
    });
  const { invoice, numberDeferred } = billed;
  // TL-4/CAT-4: a trial→active renewal is an ACTIVATION — fire activation-event
  // attached items ONCE (fire-once via subscription_charge_log).
  if (sub.status === "in_trial") {
    const { fireActivationCharges } = await import("./items");
    await fireActivationCharges({
      organizationId,
      businessId: sub.businessId,
      subscriptionId: sub.id,
      now,
    });
  }

  // A pending invoice is a draft — it doesn't affect the subscription's standing
  // (nothing is owed yet); it's finalized + collected at close.
  if (invoice.status === "pending") return;
  // Collected by the collection pump once numbered; it applies the outcome below.
  if (numberDeferred) return;
  await applyRenewalOutcome(organizationId, sub, invoice);
}

/**
 * Whether the term just ended already has its usage window billed by its own invoice (a
 * pending draft persists the window it bills at close in `metadata.usage_window`). A
 * trialling subscription has no term, so the answer is no.
 */
async function priorPeriodCovered(
  organizationId: string,
  sub: typeof subscriptions.$inferSelect,
): Promise<boolean> {
  const term = termOrNull(sub);
  if (term == null) return false;
  return withTenant(organizationId, (tx) =>
    termCoveredByPriorInvoice(tx, {
      id: sub.id,
      currentPeriodStart: term.start,
      currentPeriodEnd: term.end,
    }),
  );
}

/**
 * Cancel at term end (cancel_at_period_end, or the last billing cycle) and raise one final
 * invoice for what the closing term owes in arrears: its metered usage and its pending
 * one-time charges. No recurring fee, because no next term starts. With neither, no invoice.
 *
 * The cancel is the period claim, so the status write and the invoice commit together, and a
 * second tick that loses the claim bills nothing.
 */
async function cancelAtTermEnd(input: {
  organizationId: string;
  sub: typeof subscriptions.$inferSelect;
  now: Date;
  deferNumber?: boolean;
}): Promise<void> {
  const { organizationId, sub, now } = input;
  const claim = async (tx: Tx): Promise<boolean> => {
    const [c] = await tx
      .update(subscriptions)
      // `cancelAtPeriodEnd` is cleared: it has been honoured, and a terminal row that still
      // carries it shows "Cancellation scheduled" on a cancelled subscription. The event
      // reason reads `sub`, the pre-update snapshot.
      .set({
        status: "cancelled",
        canceledAt: now,
        cancelAtPeriodEnd: false,
        cancelBookedAt: frozenStopBooking(sub, now),
      })
      .where(and(eq(subscriptions.id, sub.id), ne(subscriptions.status, "cancelled")))
      .returning();
    if (!c) return false;
    await recomputeSubscriptionMrr(tx, c.id, now);
    await emitEvent(tx, {
      organizationId,
      businessId: sub.businessId,
      type: "subscription_canceled",
      data: buildEventData(
        "subscription_canceled",
        {
          id: sub.publicId,
          status: "cancelled",
          reason: sub.cancelAtPeriodEnd ? "cancel_at_period_end" : "billing_cycles_exhausted",
        },
        c.resourceVersion,
      ),
    });
    return true;
  };

  const term = termOrNull(sub);
  const plan =
    term == null
      ? null
      : await planSubscriptionPeriodInvoice({
          organizationId,
          businessId: sub.businessId,
          subscription: sub,
          periodStart: term.start,
          periodEnd: term.end,
          skipFixed: true,
          // A pending draft that already owns this window bills it at close.
          usagePeriod: termUsageWindow(
            {
              currentPeriodStart: term.start,
              currentPeriodEnd: term.end,
              currentSubPeriodStart: sub.currentSubPeriodStart,
            },
            { priorCovered: await priorPeriodCovered(organizationId, sub) },
          ),
          commitment: closingCommitment(sub),
        });
  if (!plan || plan.lines.length === 0) {
    await withTenant(organizationId, async (tx) => {
      await claim(tx);
    });
    return;
  }
  let billed: Awaited<ReturnType<typeof commitSubscriptionPeriodInvoice>>;
  try {
    billed = await commitSubscriptionPeriodInvoice(plan, {
      claim,
      ...(input.deferNumber ? { deferNumber: true } : {}),
    });
  } catch (e) {
    if (e instanceof PeriodClaimLostError) return;
    throw e;
  }
  if (billed.numberDeferred) return;
  await applyRenewalOutcome(organizationId, sub, billed.invoice);
}

/**
 * A skipped renewal: the period advances, the fixed term keeps its cycle, and the recurring
 * items are not charged. Metered usage from the period just ended and pending one-time
 * charges still invoice; with neither, no invoice is raised at all. MRR does not move.
 */
async function renewSkipped(input: {
  organizationId: string;
  sub: typeof subscriptions.$inferSelect;
  skipId: string;
  periodStart: Date;
  periodEnd: Date;
  priorCovered: boolean;
  mode: BillingMode;
  now: Date;
  deferNumber?: boolean;
}): Promise<void> {
  const { organizationId, sub, periodStart, periodEnd, now } = input;
  // One transaction: the skip is applied with the period advance or not at all.
  const claim = async (tx: Tx): Promise<boolean> => {
    const before = await subscriptionSnapshot(tx, sub);
    const [applied] = await tx
      .update(renewalSkips)
      .set({ status: "applied", appliedAt: now })
      .where(and(eq(renewalSkips.id, input.skipId), eq(renewalSkips.status, "scheduled")))
      .returning();
    if (!applied) return false;
    const [updated] = await tx
      .update(subscriptions)
      // The skipped term carries no commitment (waived).
      .set({
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        ...subPeriodFields(sub, periodStart, periodEnd, input.mode),
        commitmentSegments: sub.commitmentAmountMinor != null ? [] : null,
      })
      .where(
        and(
          eq(subscriptions.id, sub.id),
          eq(subscriptions.status, "active"),
          eq(subscriptions.currentPeriodEnd, sub.currentPeriodEnd!),
        ),
      )
      .returning();
    if (!updated) return false;
    await emitEvent(tx, {
      organizationId,
      businessId: sub.businessId,
      type: "subscription_renewal_skipped",
      data: buildEventData(
        "subscription_renewal_skipped",
        {
          id: updated.publicId,
          renewal_skip: applied.publicId,
          current_period_start: periodStart,
          current_period_end: inclusiveBoundary(periodEnd, input.mode),
        },
        updated.resourceVersion,
      ),
    });
    await auditSubscription(tx, {
      organizationId,
      businessId: sub.businessId,
      action: "subscription.renewal_skipped",
      before,
      after: updated,
    });
    return true;
  };

  const plan = await planSubscriptionPeriodInvoice({
    organizationId,
    businessId: sub.businessId,
    subscription: { ...sub, currentPeriodStart: periodStart, currentPeriodEnd: periodEnd },
    periodStart,
    periodEnd,
    skipFixed: true,
    usagePeriod: termUsageWindow(sub, { priorCovered: input.priorCovered }),
    commitment: closingCommitment(sub),
  });
  if (plan.lines.length === 0) {
    await withTenant(organizationId, async (tx) => {
      if (!(await claim(tx))) throw new PeriodClaimLostError();
    }).catch((e) => {
      if (!(e instanceof PeriodClaimLostError)) throw e;
    });
    return;
  }
  let billed: Awaited<ReturnType<typeof commitSubscriptionPeriodInvoice>>;
  try {
    billed = await commitSubscriptionPeriodInvoice(plan, {
      claim,
      opensPeriod: true,
      ...(input.deferNumber ? { deferNumber: true } : {}),
    });
  } catch (e) {
    if (e instanceof PeriodClaimLostError) return;
    throw e;
  }
  await withTenant(organizationId, (tx) =>
    tx
      .update(renewalSkips)
      .set({ invoiceId: billed.invoice.id })
      .where(eq(renewalSkips.id, input.skipId)),
  );
  if (billed.numberDeferred) return;
  await applyRenewalOutcome(organizationId, sub, billed.invoice);
}

/**
 * Bill one monthly usage boundary inside the term: the usage since the cursor plus queued
 * charges, keyed `(subscription, boundary)`. No base fee and no commitment line. The claim
 * moves the sub-period on in the invoice's transaction; with nothing to bill it moves alone.
 */
async function billSubPeriod(input: {
  organizationId: string;
  sub: typeof subscriptions.$inferSelect;
  mode: BillingMode;
  deferNumber?: boolean;
}): Promise<void> {
  const { organizationId, sub, mode } = input;
  const boundary = sub.currentSubPeriodEnd!;
  const term = requireTerm(sub);
  const next = nextSubPeriodEnd(term.start, term.end, boundary, sub.billingAnchorDay, mode);
  const claim = async (tx: Tx): Promise<boolean> => {
    const [u] = await tx
      .update(subscriptions)
      .set({ currentSubPeriodStart: boundary, currentSubPeriodEnd: next })
      .where(
        and(
          eq(subscriptions.id, sub.id),
          eq(subscriptions.status, "active"),
          eq(subscriptions.currentSubPeriodEnd, boundary),
        ),
      )
      .returning({ id: subscriptions.id });
    return u != null;
  };
  // A boundary that is not inside the term (a term writer left it behind) is recomputed
  // from the term, never billed.
  if (boundary.getTime() <= term.start.getTime()) {
    await withTenant(organizationId, (tx) =>
      tx
        .update(subscriptions)
        .set(subPeriodFields(sub, term.start, term.end, mode))
        .where(and(eq(subscriptions.id, sub.id), eq(subscriptions.currentSubPeriodEnd, boundary))),
    );
    return;
  }
  const usagePeriod = termUsageWindow(sub, { until: boundary })!;
  const plan = await planSubscriptionPeriodInvoice({
    organizationId,
    businessId: sub.businessId,
    subscription: sub,
    periodStart: boundary,
    periodEnd: next,
    skipFixed: true,
    usagePeriod,
    metadata: {
      sub_period: { start: boundary.toISOString(), end: next.toISOString() },
      usage_window: {
        start: usagePeriod.start.toISOString(),
        end: usagePeriod.end.toISOString(),
      },
    },
  });
  if (plan.lines.length === 0) {
    await withTenant(organizationId, async (tx) => {
      await claim(tx);
    });
    return;
  }
  // No payment method on an auto-collect subscription: raise it uncollected, dunning owns it.
  const noCard = await isUncollectableAutoCollect({
    organizationId,
    sub,
    periodStart: boundary,
    periodEnd: next,
    createAsPending: false,
    priorCovered: true,
  });
  let billed: Awaited<ReturnType<typeof commitSubscriptionPeriodInvoice>>;
  try {
    billed = await commitSubscriptionPeriodInvoice(plan, {
      claim,
      opensPeriod: true,
      ...(noCard ? { collect: false } : input.deferNumber ? { deferNumber: true } : {}),
    });
  } catch (e) {
    if (e instanceof PeriodClaimLostError) return;
    throw e;
  }
  if (billed.numberDeferred) return;
  await applyRenewalOutcome(organizationId, sub, billed.invoice);
}

/**
 * Collect a batch-numbered renewal invoice and apply the outcome, as `renewSubscription` does
 * inline. Skips an invoice already attempted, settled or voided, so a repeated job is a no-op.
 */
export async function collectRenewalInvoice(
  organizationId: string,
  invoiceId: string,
): Promise<void> {
  const loaded = await withTenant(organizationId, async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    if (!inv?.subscriptionId) return null;
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, inv.subscriptionId))
      .limit(1);
    return sub ? { inv, sub } : null;
  });
  if (!loaded) return;
  const { inv, sub } = loaded;
  if (inv.number == null || inv.attemptCount > 0) return;
  if (inv.status === "voided" || inv.status === "not_paid" || inv.status === "pending") return;
  const { invoice } = await collectPeriodInvoice({
    organizationId,
    businessId: inv.businessId,
    subscription: sub,
    invoice: inv,
  });
  await applyRenewalOutcome(organizationId, sub, invoice);
}

async function applyRenewalOutcome(
  organizationId: string,
  sub: { id: string; publicId: string; businessId: string; customerId: string },
  invoice: { publicId: string; status: string },
): Promise<void> {
  // React to the collection outcome (the SUBSCRIPTION has no past_due
  // status; dunning lives on the invoice, and the sub stays `active` with dues
  // surfaced by SUB-3 until the dunning final action fires):
  //  - not_paid (non-retriable / exhausted at generation) → apply the final action
  //    (invoice void/write_off + subscription cancel or retain),
  //  - payment_due (retry scheduled) / posted (Net-D) / paid → leave active.
  if (invoice.status === "not_paid") {
    const config = await withTenant(organizationId, (tx) =>
      loadRenewalDunningConfig(tx, sub.businessId, sub.customerId, sub.id),
    );
    await applyDunningFinalAction({
      organizationId,
      businessId: sub.businessId,
      invoicePublicId: invoice.publicId,
      subscriptionId: sub.id,
      subscriptionPublicId: sub.publicId,
      config,
    });
    // Retain → the sub stays active carrying the unpaid invoice as dues (SUB-3).
  }
}
