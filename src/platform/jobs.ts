import { EventEmitter } from "node:events";
import {
  run,
  makeWorkerUtils,
  Logger as GraphileLogger,
  type Runner,
  type WorkerUtils,
  type Task,
  type WorkerEvents,
} from "graphile-worker";
import { config } from "./config";
import { runBillingClockTick, type TickError } from "@/modules/subscriptions/renewal";
import { applyDueScheduledChanges } from "@/modules/subscriptions/scheduled-changes";
import {
  runDunningPass,
  sweepStrandedRetries,
  sweepExpiredParkedDunning,
  sweepParkedReminders,
} from "@/modules/subscriptions/dunning";
import { runInvoiceDueTransitions } from "@/modules/invoicing/due";
import { runAutoClosePending } from "@/modules/invoicing/pending";
import { sweepOutstandingCnPayouts } from "@/modules/credit-notes/service";
import { reapStuckTransfers } from "@/modules/transfer/service";
import { reapStaleIdempotencyKeys } from "@/platform/idempotency";
import { sweepRateLimitCounters } from "@/platform/rate-limit";
import { sweepLoginAttempts, sweepPasswordResetTokens } from "@/modules/auth/service";
import { sweepHttpStats } from "@/modules/ops/http-stats";
import { sweepBuyerRejections } from "@/modules/ops/buyer-rejections";
import { sweepApiServerErrors } from "@/modules/ops/api-errors";
import { runRemindersPass } from "@/modules/subscriptions/reminders";
import { sendCheckoutReminders } from "@/modules/checkout/reminders";
import { deliverPending } from "@/modules/webhooks/outbox";
import { deliverPendingEmails } from "@/modules/emails/outbox";
// Side-effect: registers the integrations sink (HubSpot + push partners) in the worker process.
import "@/modules/integrations/sink";
import { deliverPendingIntegrations } from "@/modules/integrations/outbox";
// Side-effect: registers the receipt sink in the worker process.
import "@/modules/receipts/sink";
import "@/modules/usage-controls/sink";
import { sweepStalePendingCharges } from "@/modules/payments/stale-pending";
import { sweepOrphanedIntents } from "@/modules/payments/orphaned-intents";
import { recheckPausedMandates } from "@/modules/payment-methods/paused-mandates";
import { sweepStalePendingRefunds } from "@/modules/refunds/stale-pending";
import { pollGatewaySettlementReports } from "@/modules/gateway/settlement-report";
import { requeueStrandedGatewayWebhooks, type StoredDeliveryJob } from "@/modules/gateway/inbound";
import { paymentSourceSweep } from "@/modules/payment-methods/sweep";
import { expirePaymentIntents } from "@/modules/payment-intents/service";
import { tmtestWebhookPass } from "@/providers/tmtest/webhooks";
import { runWithEventContext } from "@/platform/event-context";
import {
  getTraceId,
  newTraceId,
  stampTracePayload,
  traceContextFromPayload,
  withTraceContext,
} from "@/platform/trace";
import {
  startClockTick,
  finishClockTick,
  type TickCounters,
  type TickPass,
} from "@/modules/ops/clock-ticks";
import { createLogger } from "@/platform/logger";
import { recordJobRun } from "@/modules/ops/job-runs";

/**
 * The queue/clock's own logger.
 *
 * These lines used to go through the RAW pino instance, which meant no `service`
 * label — and, before the root-logger mixin, no traceId either, on the one log you
 * read after a bad tick. Note the argument order differs from raw pino: the facade
 * is `(message, fields)`, pino is `(fields, message)`. Getting that backwards puts
 * an object where the summary should be, which is why this conversion was done by
 * hand rather than by regex.
 */
const log = createLogger("jobs");

/**
 * The durable job handlers. graphile-worker stores jobs in Postgres (its own
 * `graphile_worker` schema), so the billing clock survives restarts and runs
 * exactly-once with retries — never in-memory timers (BLUEPRINT ADR-006).
 */
// NB: graphile-worker's crontab parser only allows [A-Za-z0-9_-] in task names
// (no dots), so cron-scheduled tasks use underscores.
/**
 * Run one billing clock tick and record its clock_ticks row (SCHED-1). Exported so
 * verify suites (and a future Time Travel travel step) can drive a single tick
 * deterministically. `logInfo` receives the summary line; the task passes the
 * worker logger, verify passes a no-op.
 */
/**
 * EVERY pass the billing clock is allowed to run, in the order it runs them.
 *
 * ── WHY A LIST EXISTS AT ALL ────────────────────────────────────────────────────
 * The rule this file most needs to hold is that **the scheduler makes no network call**.
 * On 2026-09-01 it did — the mail and webhook outboxes were passes here — and one
 * unreachable SMTP host took the sweep from ~12s to 115s, past its own 60s cadence, and
 * grew the queue to 1,456 jobs over three days. Phases 1 and 2 fixed that instance.
 *
 * Nothing fixed the CLASS. The rule lived in comments, and a comment does not fail a build:
 * six months from now `runPass("sync_tax_rates", () => fetch(...))` lands here, every test
 * still passes, and the same incident is rediscovered with a different dependency.
 *
 * So the list is enforced from both ends. `runPass` refuses a name that is not here, and
 * `verify:worker` asserts this array matches the `runPass` calls in this file EXACTLY —
 * same members, same order. Adding a pass therefore cannot be done by accident: it fails
 * until someone edits this array, and editing it is the moment to ask the only question
 * that matters, which is whether the new pass talks to anything outside this database.
 *
 * ── THE ORDER IS ALSO LOAD-BEARING ──────────────────────────────────────────────
 * Passes draw down one sweep-wide budget (`TICK_BUDGET_MS`) in this order, and whatever the
 * budget does not reach is recorded `skipped`. So the tail must be the most deferrable work
 * — which is why the four `sweep_*` GC passes sit at the end, behind `expire_payment_intents`
 * (releases money held at a gateway), `payment_source_sweep` (demotes a lapsed mandate) and
 * `reminders`. They did not, until 2026-09-02.
 *
 * ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────────
 * `email_outbox` and `webhook_outbox`. They are `email_outbox_nudge` and
 * `webhook_outbox_nudge` now, on their own named queues (see WORKER_CRONTAB), and they must
 * never come back. Re-adding either name here is the regression this list exists to stop.
 */
export const TICK_PASSES = [
  // ── State machine: money and subscription state. Never shed. ──
  "scheduled_changes",
  "renewal",
  "auto_close_pending",
  "invoice_due_transitions",
  "stranded_retries",
  "stale_pending",
  // ⚠️ ORDER IS THE CONTRACT, and this array is the declaration half of it. `orphaned_intents`
  // (2026-09-05) was declared ABOVE `stale_pending_refunds` while its `runPass` call landed
  // BELOW it, and the two halves have disagreed since — reddening `verify:clock-obs`
  // (recorded timeline vs declaration) and `verify:worker` (call sites vs declaration) on one
  // divergence. Corrected on the DECLARATION side on purpose: the execution order is what has
  // actually run in production, all three sit in the never-shed group so shedding is
  // unaffected, and moving the CALL would change behaviour in the file behind the
  // 2026-08-29 billing outage to satisfy a list.
  "orphaned_intents",
  "paused_mandates",
  "stale_pending_refunds",
  "settlement_reports",
  // Errored gateway webhooks that no retry job will reach (Phase 6a). Database only.
  "gateway_webhook_retries",
  "dunning",
  "parked_dunning",
  "parked_dunning_reminders",
  "checkout_reminders",
  "cn_payout_retries",
  "reap_transfers",
  "reap_idempotency_keys",
  // Usage controls (design G5): automatic top-up charges and collects interim usage invoices.
  "credit_auto_topups",
  "usage_threshold_invoices",
  // Usage alerts: period-end resolves, the daily tier catch-up and lead-time re-check. Database only.
  "usage_alerts",
  // ── Customer-visible and money-releasing. Shed only under real pressure. ──
  "reminders",
  "payment_source_sweep",
  "expire_payment_intents",
  // Open payment requests past their 30 days (0388). Database only.
  "expire_payment_requests",
  // Credit grants and holds (design G3): release or book money. Database only.
  "activate_credit_grants",
  "expire_credit_grants",
  "expire_credit_holds",
  // ── Housekeeping: table cleanup. First to be shed, by design. ──
  "sweep_rate_limits",
  "sweep_login_attempts",
  "sweep_auth_tokens",
  "sweep_http_stats",
  "sweep_buyer_rejections",
  "sweep_api_errors",
  "tmtest_webhooks",
] as const;

/** Membership set for the guard in `runPass`. */
const TICK_PASS_SET: ReadonlySet<string> = new Set(TICK_PASSES);

export async function runBillingClockTickOnce(
  logInfo: (m: string) => void = () => {},
  logicalNow?: Date,
): Promise<{ tickId: string; overran: boolean; errors: number; unfinished: string[] }> {
  // One trace per tick: every renewal, invoice, charge and error produced by this
  // pass shares a `job-` traceId, so "what happened in the 03:00 tick" is one
  // query instead of a timestamp range. Reuses the ambient trace when the worker
  // already established one (`tracedTask`) so a tick isn't split across two ids;
  // mints its own when called directly (verify suites, Time Travel travel).
  return runWithEventContext({ source: "scheduled_job", actor: "billing_clock" }, async () =>
    withTraceContext({ traceId: getTraceId() ?? newTraceId("job") }, async () => {
      // Single-flight comes from the crontab's `queue=` option (see WORKER_CRONTAB), NOT
      // from the task name: graphile-worker only serializes jobs that carry a queue name.
      // Row-level claims (renewal's compare-and-swap, the outbox leases) are the second
      // line of defence, because time travel travel and a real tick can still overlap.
      // SCHED-1 records one clock_ticks row per tick with counters + per-item errors + an
      // overrun flag, so "why didn't this renew?" is answerable without grepping logs.
      const started = new Date(); // real wall-clock: for clock_ticks timing + overrun
      // Stamped at START, not finish: a tick that dies mid-pass keeps its trace, which
      // is exactly when you need to find the gateway calls and events it did produce.
      const traceId = getTraceId() ?? null;
      const {
        id: tickId,
        laggedOverrun,
        lagMs,
        downtimeGap,
      } = await startClockTick(started, traceId);
      // TL-4: the LOGICAL clock driving every pass. Real wall-clock by default; a Time
      // Travel travel step passes the simulated instant. All pass scans + scheduling
      // decisions run as-of this instant, so a traveled run is deterministic.
      const now = logicalNow ?? started;

      const passes: TickPass[] = [];
      const errors: TickError[] = [];
      // Declared outside the try so the row can still be closed with whatever was
      // measured if the scaffolding itself fails.
      let msg = "billing_clock_tick: aborted before any pass completed";
      let counters: TickCounters = {
        scheduledApplied: 0,
        renewed: 0,
        dunningRetried: 0,
        dunningRecovered: 0,
        dunningCanceled: 0,
        webhooksDelivered: 0,
        webhooksFailed: 0,
      };

      /**
       * Run one pass: time it, record what it did, and CONTAIN its failure.
       *
       * Before this wrapper the passes were a bare `await` sequence, so the first one to
       * throw took the rest of the tick with it — a transient error in the due-date
       * transition meant dunning, the outboxes and the reminders silently did not run
       * that minute, and `finishClockTick` never ran either, leaving a row open forever
       * (found in the 2026-08-05 robustness review). Per-ITEM errors were already
       * isolated inside each pass; this isolates the pass entry itself: its scan query,
       * its config load, an unexpected null.
       *
       * A failure is recorded twice on purpose — as a failed `passes` entry (so the
       * timeline shows where the tick broke) and as a `TickError` with `step: name` (so it
       * appears in the same errors list an operator already reads). The caller gets
       * `null` and falls back to zeroed counters.
       */
      /**
       * ONE deadline for the whole sweep, drawn down by each pass in turn (phase 2).
       *
       * `TICK_PASS_BUDGET_MS` bounds a SINGLE pass, which never bounded the tick: twenty-two
       * passes at 15s each is a theoretical five-and-a-half-minute sweep, and at the 90s this
       * used to be it was thirty-three minutes. Every pass could be individually well-behaved
       * and the tick still outlive its own 60s cadence — which is exactly what happened on
       * 2026-09-01, and no per-pass number could have prevented it.
       *
       * Passes run in PRIORITY ORDER (renewals and invoices first, housekeeping last), so a
       * sweep that runs out of time drops the cheapest, most deferrable work rather than
       * whatever happened to be at the end of the list.
       */
      const tickDeadline = started.getTime() + config.TICK_BUDGET_MS;
      /** Passes that never ran because the sweep's budget was gone. */
      const skipped: string[] = [];
      /** Passes that ran but left due work behind (scan limit or pass budget). */
      const capped: string[] = [];

      const runPass = async <T>(
        name: string,
        fn: () => Promise<T>,
        counts?: (r: T) => Record<string, number>,
      ): Promise<T | null> => {
        // Refuse a pass that is not declared in TICK_PASSES. Thrown, not logged: this is a
        // programmer error, and it must stop the sweep the first time anyone runs it rather
        // than produce a tick that quietly does something nobody reviewed. The list is where
        // "does this pass make a network call?" gets asked.
        if (!TICK_PASS_SET.has(name)) {
          throw new Error(
            `billing_clock_tick: pass "${name}" is not in TICK_PASSES. Add it there — and ` +
              `while you are, confirm it makes no network call. The scheduler must not.`,
          );
        }
        // Out of time. Recorded as a `skipped` pass rather than silently omitted: a pass
        // that is absent from the array is indistinguishable from one that did nothing, and
        // "why did dunning not run at 03:00" has to be answerable from this row alone.
        if (Date.now() >= tickDeadline) {
          skipped.push(name);
          passes.push({ name, status: "skipped", ms: 0 });
          return null;
        }
        const t0 = Date.now();
        try {
          const value = await fn();
          // NO SILENT CAPS. A bounded pass (config.TICK_SCAN_LIMIT) that filled its budget
          // has NOT finished its work, and a truncated sweep reading as a complete one is
          // how "why is this invoice still unsent" becomes unanswerable. Recorded on the
          // pass AND warned, because a clock that caps every minute is not keeping up.
          const cap = value as { capped?: boolean; cappedBy?: "scan_limit" | "budget" } | null;
          const wasCapped = !!cap?.capped;
          if (wasCapped) {
            capped.push(name);
            const by = cap?.cappedBy ?? "scan_limit";
            log.warn(
              by === "budget"
                ? "billing_clock_tick pass ran out of its time budget — the remainder rolls to the next tick"
                : "billing_clock_tick pass hit its scan limit — the remainder rolls to the next tick",
              {
                tickId,
                event: "tick_pass_capped",
                pass: name,
                cappedBy: by,
                ...(by === "budget"
                  ? { budgetMs: config.TICK_PASS_BUDGET_MS }
                  : { limit: config.TICK_SCAN_LIMIT }),
              },
            );
          }
          passes.push({
            name,
            status: "ok",
            ms: Date.now() - t0,
            ...(counts
              ? { counts: { ...counts(value), ...(wasCapped ? { capped: 1 } : {}) } }
              : {}),
          });
          return value;
        } catch (e) {
          const message = (e as Error)?.message ?? String(e);
          passes.push({ name, status: "failed", ms: Date.now() - t0, error: message });
          errors.push({ organization: "system", step: name, message });
          // The Error itself, not a sentence about it: the facade extracts message + stack,
          // which is what Cloud Error Reporting groups on, and a clock pass failing is
          // exactly what should page. The prose this replaced said "pass X threw — later
          // passes still ran"; `pass` and `event` carry the first half as queryable fields
          // and the isolation is the comment above, while the tick summary line below still
          // narrates the whole tick in one readable sentence.
          log.error(e, { tickId, event: "tick_pass_failed", pass: name });
          return null;
        }
      };

      try {
        // Apply due scheduled changes FIRST (a scheduled cancel/pause must take effect
        // before this tick's renewal billing).
        const sched = await runPass(
          "scheduled_changes",
          () => applyDueScheduledChanges(now),
          (r) => ({ applied: r.applied, failed: r.failed }),
        );
        // Per-CHANGE failures, same treatment as renewal's (below): the pass isolates
        // them so one bad row can't stall the tick, and reports them so the tick does
        // not read as clean. Before this they were swallowed by a bare `catch {}` and
        // the row retried silently every minute — a scheduled cancel could go
        // permanently un-applied with nothing anywhere to show for it.
        if (sched) errors.push(...sched.errors);
        const renewal = await runPass(
          "renewal",
          () => runBillingClockTick(now),
          (r) => ({ renewed: r.renewed, failed: r.errors.length }),
        );
        // Per-subscription renewal failures are already isolated and reported by the
        // pass itself; carry them through unchanged.
        if (renewal) errors.push(...renewal.errors);
        // Auto-close pending invoices past their business's close-after window (E2).
        const autoClosed = await runPass(
          "auto_close_pending",
          () => runAutoClosePending(now),
          (r) => ({ closed: r.closed, failed: r.errors.length }),
        );
        // Per-ITEM failures, carried through the same way renewal's are. Until this, a
        // pass whose scan and config load both succeeded reported `status: 'ok'` while
        // every single item inside it threw: the tick row said the pass ran, the counters
        // said it did nothing, and the only trace of WHY was a log line that rotates away.
        if (autoClosed) errors.push(...autoClosed.errors);
        // Transition posted (Net-D / send-invoice) invoices at their due date:
        // collect (auto) or mark not_paid (offline). Runs before dunning so a fresh
        // payment_due is picked up on the next tick's dunning pass.
        const dueT = await runPass(
          "invoice_due_transitions",
          () => runInvoiceDueTransitions(now),
          (r) => ({
            transitioned: r.transitioned,
            collected: r.collected,
            not_paid: r.notPaid,
            due_for_dunning: r.dueForDunning,
            // Reported separately because "not_paid: 3" cannot answer the question this
            // feature raises — how many offline invoices are now on a countdown to being
            // voided, and how many just were.
            offline_dunning_opened: r.offlineDunningOpened,
            // The ladder advancing inside an already-open window — distinct from opening
            // one. Added 2026-08-31 alongside the counter itself (`due.ts`'s own comment
            // called out that this reporter predated it and threw the number away).
            offline_reminders_sent: r.offlineRemindersSent,
            offline_dunning_exhausted: r.offlineDunningExhausted,
            failed: r.errors.length,
          }),
        );
        if (dueT) errors.push(...dueT.errors);
        // Re-arm dunning claims stranded by a crash before their retry outcome.
        const strand = await runPass(
          "stranded_retries",
          () => sweepStrandedRetries(now),
          (r) => ({ rearmed: r.rearmed, failed: r.errors.length }),
        );
        if (strand) errors.push(...strand.errors);
        // Ask the gateway about async attempts whose settlement webhook never came.
        // BEFORE the dunning pass, deliberately: a swept attempt that turns out to
        // have failed re-enters dunning through the normal path, and this tick should
        // then act on it rather than leaving it a minute behind.
        const stale = await runPass(
          "stale_pending",
          () => sweepStalePendingCharges(now),
          (r) => ({
            examined: r.examined,
            settled: r.settled,
            failed: r.failed,
            still_pending: r.stillPending,
            unsupported: r.unsupported,
          }),
        );
        /**
         * Intents the gateway minted that we never recorded — the case the two sweeps
         * above structurally cannot see, because both start from a row of ours.
         *
         * AFTER them on purpose: an intent whose transaction is merely late gets recorded
         * by the passes above and stops being an orphan, so asking last keeps the count
         * honest rather than racing our own reconciliation. It only reads and logs; there
         * is no money to move against a row we cannot explain.
         */
        const orphans = await runPass(
          "orphaned_intents",
          () => sweepOrphanedIntents(now),
          (r) => ({ examined: r.examined, orphans: r.orphans }),
        );
        void orphans;
        /**
         * The one dead mandate state a gateway can take back, asked about rather than
         * waited for. RazorPay refuses to subscribe `token.resumed` (400 "Invalid event
         * name/names"), so a mandate that pauses and resumes is dead in our books forever
         * unless something asks. It applies the SAME policy the webhook does.
         */
        await runPass(
          "paused_mandates",
          () => recheckPausedMandates(),
          (r) => ({ rechecked: r.rechecked, changed: r.changed, skipped: r.skipped }),
        );
        // The same question on the refund side: a refund the provider accepted but whose
        // settlement webhook never came. Its own pass rather than folded into the one
        // above, because the two resolve different resources through different adapter
        // calls and a failure in either must not hide the other's counts.
        await runPass(
          "stale_pending_refunds",
          () => sweepStalePendingRefunds(now),
          (r) => ({
            examined: r.examined,
            settled: r.settled,
            reversed: r.reversed,
            still_pending: r.stillPending,
            unsupported: r.unsupported,
          }),
        );
        // Outcomes a gateway reports only in its settlement report (late returns, reversals).
        // Before dunning, as stale_pending is: a returned charge re-enters dunning normally.
        const settlementReports = await runPass(
          "settlement_reports",
          () => pollGatewaySettlementReports(now),
          (r) => ({
            polled: r.polled,
            events: r.events,
            processed: r.processed,
            duplicates: r.duplicates,
            advanced: r.advanced,
            failed: r.failed,
          }),
        );
        if (settlementReports) errors.push(...settlementReports.errors);
        // Queue our retry for an errored gateway webhook that no job will reach.
        const webhookRetries = await runPass(
          "gateway_webhook_retries",
          () => requeueStrandedGatewayWebhooks(now),
          (r) => ({ examined: r.examined, queued: r.queued, failed: r.errors.length }),
        );
        if (webhookRetries) errors.push(...webhookRetries.errors);
        const dun = await runPass(
          "dunning",
          () => runDunningPass(now),
          (r) => ({
            retried: r.retried,
            recovered: r.recovered,
            canceled: r.canceled,
            failed: r.errors.length,
          }),
        );
        if (dun) errors.push(...dun.errors);
        // Close the window on PARKED invoices whose deadline has passed. AFTER the
        // dunning pass, deliberately: `runDunningPass` cannot see a parked row at all
        // (it scans `next_attempt_at IS NOT NULL`), so there is nothing to race, and
        // running last means a payment that arrived this tick has already settled.
        const parkedDun = await runPass(
          "parked_dunning",
          () => sweepExpiredParkedDunning(now),
          (r) => ({
            examined: r.examined,
            exhausted: r.exhausted,
            canceled: r.canceled,
            failed: r.errors.length,
          }),
        );
        if (parkedDun) errors.push(...parkedDun.errors);
        // Walk the reminder ladder on parked invoices (0283). AFTER the expiry sweep, so
        // an invoice whose window closed this tick is no longer `parked` and cannot be
        // sent a "you have until…" notice on the day its deadline passed. It never
        // charges — the rungs live in their own column precisely so they cannot.
        const parkedRemind = await runPass(
          "parked_dunning_reminders",
          () => sweepParkedReminders(now),
          (r) => ({ reminded: r.reminded, failed: r.errors.length }),
        );
        if (parkedRemind) errors.push(...parkedRemind.errors);
        // Abandoned-checkout reminders (E6): businesses that switched them on only.
        const checkoutRemind = await runPass(
          "checkout_reminders",
          () => sendCheckoutReminders(now),
          (r) => ({ reminded: r.reminded, failed: r.errors.length }),
        );
        if (checkoutRemind) errors.push(...checkoutRemind.errors);
        // Retry CN payouts whose gateway refund declined (refunds_payable outstanding).
        const cnPayouts = await runPass(
          "cn_payout_retries",
          () => sweepOutstandingCnPayouts(),
          (r) => ({ retried: r.retried, cleared: r.cleared }),
        );
        // Crash reapers compare wall-clock stamps, so they take the REAL time. The simulated
        // instant of a time-travel step would make every live row look stale, in every org.
        // Reap transfers stuck `running` after a crash (finale review).
        const reaped = await runPass(
          "reap_transfers",
          () => reapStuckTransfers(started),
          (r) => ({ reaped: r.reaped }),
        );
        // Reap Idempotency-Key records orphaned by a process crash mid-request: a stale
        // `in_progress` (nothing durable written) is freed for a fresh attempt; a stale
        // `side_effects` (a write landed before the crash) is NEVER freed for
        // re-execution — only converted to a terminal `failed`. See platform/idempotency.ts.
        const idemReaped = await runPass(
          "reap_idempotency_keys",
          () => reapStaleIdempotencyKeys(started),
          (r) => ({ freed: r.freed, orphaned: r.orphaned }),
        );
        // Automatic credit top-up: create runs, notice, charge, settle (design G5 §3.6).
        const topups = await runPass(
          "credit_auto_topups",
          async () => {
            const { runCreditAutoTopups } = await import("@/modules/usage-controls/auto-topup");
            return runCreditAutoTopups(now);
          },
          (r) => ({
            created: r.created,
            noticed: r.noticed,
            succeeded: r.succeeded,
            pending: r.pending,
            failed: r.failed,
            skipped: r.skipped,
          }),
        );
        if (topups) errors.push(...topups.errors);
        // Interim usage invoices: collected here, with dunning like a renewal (design G5 §3.7).
        const interim = await runPass(
          "usage_threshold_invoices",
          async () => {
            const { runUsageThresholdInvoices } =
              await import("@/modules/usage-controls/threshold-invoicing");
            return runUsageThresholdInvoices(now);
          },
          (r) => ({ collected: r.collected, credited: r.credited, failed: r.errors.length }),
        );
        if (interim) errors.push(...interim.errors);
        // Alert states whose period ended resolve; once a day, tiers catch up (design G5 §3.3–3.4).
        await runPass(
          "usage_alerts",
          async () => {
            const { runUsageAlertsPass } = await import("@/modules/usage-controls/alerts-pass");
            // Registers the weekly lead-time re-check of automatic top-up (design G5 §3.6).
            await import("@/modules/usage-controls/auto-topup");
            return runUsageAlertsPass(now);
          },
          (r) => ({ resolved: r.resolved, tiers: r.tiers, capped: r.capped ? 1 : 0, ...r.daily }),
        );
        // Renamed from `trial_reminders` (2026-08-10): the pass emits renewal and
        // cancellation reminders too, so the old name described a third of what it does.
        // Historical clock_ticks rows keep the old key — the ops label map still resolves it.
        // The breakdown is logged per kind because "reminded: 12" cannot answer the question
        // anyone actually asks of this pass, which is *which* reminder fired.
        const rem = await runPass(
          "reminders",
          () => runRemindersPass(now),
          (r) => ({
            reminded: r.reminded,
            trialEnding: r.trialEnding,
            renewal: r.renewal,
            cancellation: r.cancellation,
            // Counted separately because it is the only one with a legal deadline —
            // "reminders: 12" cannot answer "did every mandate debit get its notice?".
            preDebit: r.preDebit,
            gatewayPreDebit: r.gatewayPreDebit,
            paymentDue: r.paymentDue,
            pause: r.pause,
            resume: r.resume,
            failed: r.errors.length,
          }),
        );
        if (rem) errors.push(...rem.errors);
        // Flag expiring/expired payment sources (idempotent — one event per transition).
        const sweep = await runPass(
          "payment_source_sweep",
          () => paymentSourceSweep(now),
          // `silenced` is the pre-cutover backlog: mandates demoted WITHOUT mailing the
          // payer (see MANDATE_EXPIRY_NOTICE_FROM). Reported because a silent demotion is
          // otherwise invisible everywhere — the whole point of suppressing the mail was to
          // avoid a bulk send, not to hide that it happened.
          (r) => ({
            expiring: r.expiring,
            expired: r.expired,
            silenced: r.silenced,
            reminded: r.reminded,
          }),
        );
        // Expire unconsumed payment intents past their TTL — and, since the sweep
        // learned to release the buyer's authorization hold first, report what it did
        // with the money. `expired` alone is the least interesting of the three:
        // `abandoned` is a hold we could NOT give back (the gateway has no void call,
        // or refused, or was unreachable), so the buyer's funds stay locked until the
        // gateway's own timetable frees them. That is the number an operator acts on,
        // and reporting only the count of rows hid it.
        const piExpired = await runPass(
          "expire_payment_intents",
          () => expirePaymentIntents(now),
          (r) => ({ expired: r.expired, released: r.released, abandoned: r.abandoned }),
        );
        await runPass(
          "expire_payment_requests",
          async () => {
            const { expirePaymentRequests } = await import("@/modules/payment-requests/service");
            return expirePaymentRequests(now);
          },
          (r) => ({ expired: r.expired }),
        );
        // A pending credit grant whose invoice some path marked paid without activating it.
        await runPass(
          "activate_credit_grants",
          async () => {
            const { runActivateCreditGrants } = await import("@/modules/credits/packs");
            return runActivateCreditGrants();
          },
          (r) => ({ activated: r.activated }),
        );
        await runPass(
          "expire_credit_grants",
          async () => {
            const { runExpireCreditGrants } = await import("@/modules/credits/expiry");
            return runExpireCreditGrants(now);
          },
          (r) => ({ expired: r.expired, waiting: r.waiting }),
        );
        await runPass(
          "expire_credit_holds",
          async () => {
            const { expireCreditHolds } = await import("@/modules/credits/holds");
            return expireCreditHolds(now);
          },
          (r) => ({ expired: r.expired }),
        );
        // Deliver due TM Test Gateway async webhooks (late failures, timeouts) through
        // the real inbound pipeline BEFORE outbound delivery, so any reconciliation
        // effects fan out in the same tick.
        /**
         * ── HOUSEKEEPING — LAST ON PURPOSE ────────────────────────────────────────
         *
         * These four are table cleanup: no money moves, no customer is notified, and a
         * day's delay costs disk rather than correctness. The sweep runs its passes in
         * priority order against one wall-clock budget (`TICK_BUDGET_MS`), so whatever it
         * cannot reach is recorded as `skipped` — and these are the passes that should be
         * skipped first. They used to sit ahead of `expire_payment_intents` (which releases
         * money held at a gateway), `payment_source_sweep` (which demotes a lapsed mandate)
         * and `reminders`, which made "shed the cheapest work" untrue in exactly the moment
         * it matters.
         */
        // Drop spent rate-limit windows (#6). One row per (api key, minute), so an
        // unswept table grows by the number of active keys every minute — harmless in
        // size, but it would make the counters table the largest thing in the database
        // within a month for no reason. Retention is two windows, so this can never
        // delete a window still being counted against.
        const rlSwept = await runPass(
          "sweep_rate_limits",
          () => sweepRateLimitCounters(now),
          (r) => ({ deleted: r.deleted }),
        );
        // Drop credential attempts past LOGIN_ATTEMPT_RETENTION_DAYS (audit M5). Beside the
        // rate-limit sweep on purpose: both tables are written by traffic rather than by
        // business events, so both grow fastest exactly when something is going wrong.
        const laSwept = await runPass(
          "sweep_login_attempts",
          () => sweepLoginAttempts(now),
          (r) => ({ deleted: r.deleted }),
        );
        // `sweepPasswordResetTokens` has said "Run by the billing clock" since it was written
        // and NOTHING called it (found 2026-08-28 while adding the pass above), so spent and
        // expired reset, invite and verification tokens accumulated forever. Wired here now:
        // a sweep nobody runs is not a retention policy, it is a comment.
        const atSwept = await runPass(
          "sweep_auth_tokens",
          () => sweepPasswordResetTokens(now),
          (r) => ({ deleted: r.deleted }),
        );
        // Drop HTTP rollup rows past HTTP_STATS_RETENTION_MS (OBS-1). Same family as the
        // two sweeps above: written by traffic rather than by business events, so it grows
        // fastest exactly when something is going wrong. Retention is what keeps a metric
        // that is written every minute from becoming the largest table we own.
        const hsSwept = await runPass(
          "sweep_http_stats",
          () => sweepHttpStats(now),
          (r) => ({ deleted: r.deleted }),
        );
        await runPass(
          "sweep_buyer_rejections",
          () => sweepBuyerRejections(now),
          (r) => ({ deleted: r.deleted }),
        );
        await runPass(
          "sweep_api_errors",
          () => sweepApiServerErrors(now),
          (r) => ({ deleted: r.deleted }),
        );

        const tmt = await runPass(
          "tmtest_webhooks",
          () => tmtestWebhookPass(now),
          (r) => ({ delivered: r.delivered }),
        );
        /**
         * `webhook_outbox` and `email_outbox` USED TO RUN HERE, and deliberately no longer do.
         *
         * Both make network calls to machines we do not own, and a scheduler that makes
         * network calls has turned a third party's latency into billing latency. That is not
         * a hypothetical: on 2026-09-01 one unreachable SMTP host took `email_outbox` to
         * 103s of a 115s sweep, past the clock's own 60s cadence, and the serialized
         * `billing_clock` queue grew to 1,456 jobs over three days. Every guard behaved as
         * written; the coupling was the defect.
         *
         * They are now `email_outbox_nudge` and `webhook_outbox_nudge` on their own named
         * queues (see WORKER_CRONTAB). The clock decides what is due and hands work out; it
         * no longer waits on anyone else's socket.
         *
         * The tick's `webhooksDelivered` / `webhooksFailed` counters therefore report 0 from
         * here on. The columns are kept rather than dropped because historical rows hold real
         * values and this table is a record, not a cache — and outbox health has a better
         * home anyway: read `webhook_deliveries` and `email_messages` directly, which
         * stays accurate regardless of which process does the sending.
         */

        // A failed pass contributes zeros rather than aborting the summary — the `passes`
        // array is where "this pass did not run" is recorded truthfully.
        const renewed = renewal?.renewed ?? 0;
        msg =
          `billing_clock_tick: scheduled ${sched?.applied ?? 0} applied, renewed ${renewed}, ` +
          `auto-closed ${autoClosed?.closed ?? 0} pending, ` +
          `due-transitions ${dueT?.transitioned ?? 0} (collected ${dueT?.collected ?? 0}, not_paid ${dueT?.notPaid ?? 0}, dunning ${dueT?.dueForDunning ?? 0}), ` +
          `dunning retried ${dun?.retried ?? 0} (recovered ${dun?.recovered ?? 0}, canceled ${dun?.canceled ?? 0}, re-armed ${strand?.rearmed ?? 0}), ` +
          `parked dunning closed ${parkedDun?.exhausted ?? 0} (canceled ${parkedDun?.canceled ?? 0}), ` +
          `stale-pending examined ${stale?.examined ?? 0} (settled ${stale?.settled ?? 0}, failed ${stale?.failed ?? 0}, still pending ${stale?.stillPending ?? 0}), ` +
          `cn-payout retries ${cnPayouts?.retried ?? 0} (cleared ${cnPayouts?.cleared ?? 0}), transfers reaped ${reaped?.reaped ?? 0}, ` +
          `idempotency keys reaped (freed ${idemReaped?.freed ?? 0}, orphaned ${idemReaped?.orphaned ?? 0}), ` +
          `trial-ending reminders ${rem?.reminded ?? 0}, payment-source sweep (${sweep?.expiring ?? 0} expiring, ${sweep?.expired ?? 0} expired), intents expired ${piExpired?.expired ?? 0} (holds released ${piExpired?.released ?? 0}, abandoned ${piExpired?.abandoned ?? 0}), tmtest webhooks ${tmt?.delivered ?? 0}, ` +
          `errors ${errors.length}` +
          (skipped.length ? `, SHED ${skipped.length} pass(es): ${skipped.join(", ")}` : "");
        // A shed sweep is a sweep that did not finish its work, so it says so at `warn` —
        // the whole point of recording `skipped` rather than omitting the pass. Once per
        // tick, not once per pass, because a budget that runs out drops several at a time
        // and one line per pass is the noise that makes a log unreadable.
        if (skipped.length) {
          log.warn("billing_clock_tick ran out of its budget — later passes were shed", {
            tickId,
            event: "tick_budget_spent",
            budgetMs: config.TICK_BUDGET_MS,
            shed: skipped,
          });
        }
        counters = {
          scheduledApplied: sched?.applied ?? 0,
          renewed,
          dunningRetried: dun?.retried ?? 0,
          dunningRecovered: dun?.recovered ?? 0,
          dunningCanceled: dun?.canceled ?? 0,
          // Always 0 now that egress left the tick — see the note where the passes were.
          webhooksDelivered: 0,
          webhooksFailed: 0,
        };
      } catch (e) {
        // `runPass` contains every pass, so reaching here means the tick's own
        // scaffolding failed. Record it and fall through — the row must still be closed,
        // because an open row is invisible to every alert and breaks the NEXT tick's lag
        // measurement (it reads the newest row's finished_at). Not rethrown: cron enqueues
        // a fresh tick every minute and every pass re-scans for due work, so a retry of
        // this exact tick would only duplicate the sweep.
        const message = (e as Error)?.message ?? String(e);
        errors.push({ organization: "system", step: "tick", message });
        passes.push({
          name: "tick",
          status: "failed",
          ms: Date.now() - started.getTime(),
          error: message,
        });
        log.error(e, { tickId, event: "tick_failed" });
      }

      const { overran, ranOverrun, runMs } = await finishClockTick(tickId, {
        startedAt: started,
        finishedAt: new Date(),
        laggedOverrun,
        counters,
        errors,
        passes,
      });
      // Overrun / per-item failures escalate to error level for ops alerting (SCHED-1).
      // `cause` names WHICH overrun fired — a 100ms tick logged as `overran: true`
      // after a restart is indistinguishable from a genuinely slow one otherwise.
      //
      // THREE CONSTANT MESSAGES, one per outcome — never the counters. `msg` is a
      // sentence built out of ~25 numbers, so using it as the log message made every
      // tick a unique string: a minute-by-minute log that no viewer could group, count
      // or alert on, and "how many ticks ran unhealthy today" was unanswerable without
      // regexing prose. The numbers were already structured in `counters`; they ride
      // there now, where you can filter and aggregate by them. `msg` stays for the
      // caller's own human-readable hook.
      if (overran || errors.length > 0) {
        const cause = ranOverrun
          ? laggedOverrun
            ? "run+lag"
            : "run"
          : laggedOverrun
            ? "lag"
            : "errors";
        log.error("billing_clock_tick completed unhealthy", {
          tickId,
          event: "tick_unhealthy",
          overran,
          cause,
          runMs,
          lagMs,
          errors: errors.length,
          counters,
        });
      } else if (downtimeGap) {
        // The clock had a gap, but no worker was up for all of it: these ticks were
        // never attempted (restart, deploy, host asleep). Worth seeing — a restart
        // loop shows up here — but it is not an overrun and must not page as one.
        log.warn(
          "billing_clock_tick resumed after a clock gap — the missed ticks were never attempted",
          {
            tickId,
            event: "tick_clock_gap",
            gapSeconds: Math.round((lagMs ?? 0) / 1000),
            lagMs,
            runMs,
            counters,
          },
        );
      } else {
        // An idle tick is `debug`: one a minute is 1,440 lines a day that say nothing, and
        // liveness is `worker_heartbeats`' job. A tick that did anything stays `info`.
        const didWork =
          Object.values(counters).some((v) => v > 0) ||
          passes.some((p) => p.counts && Object.values(p.counts).some((v) => v > 0));
        const fields = { tickId, event: "tick_ok", runMs, counters };
        if (didWork) log.info("billing_clock_tick completed", fields);
        else log.debug("billing_clock_tick completed", fields);
      }
      logInfo(msg);
      return { tickId, overran, errors: errors.length, unfinished: [...capped, ...skipped] };
    }),
  );
}

/**
 * Wrap a task so its whole body runs inside a trace context taken from the job
 * payload's `_trace` stamp (see `enqueue`), falling back to a fresh `job-` id.
 * Applied to every registered task below, so a queued job's logs correlate with
 * the request that queued it and no future task can silently lose its trace.
 */
function tracedTask(name: string, task: Task): Task {
  return async (payload, helpers) => {
    const ctx = traceContextFromPayload(payload);
    return withTraceContext(ctx, async () => {
      if (!ctx.inherited && payload != null) {
        // A payload-bearing job with no stamp means propagation broke upstream.
        // Surfaced (not thrown) so it's noticed in dev rather than degrading quietly.
        log.debug("task ran without an inherited trace", { task: name });
      }
      return task(payload, helpers);
    });
  };
}

const tasks: Record<string, Task> = {
  billing_clock_tick: async (_payload, helpers) => {
    // TL-4: a REAL tick must EXCLUDE time-travelled businesses — their clock is
    // driven by travel_forward, not wall time, so a real tick would otherwise
    // process them at real `now` and diverge from the simulation.
    const { timeTravelledBusinessIds } = await import("@/modules/time-travel/service");
    const excludeBusinessIds = await timeTravelledBusinessIds();
    const { runWithClockScope } = await import("@/platform/clock");
    // No `logInfo` callback: the tick logs itself, structured, above. Piping `msg` into
    // graphile's job log sent the same ~25-number sentence back into our sink through
    // the adapter, as a message nothing could group.
    await runWithClockScope({ excludeBusinessIds }, () => runBillingClockTickOnce());
  },

  /**
   * One renewal, queued by the tick when `RENEWAL_FANOUT` is on. Never retried (`max_attempts`
   * 1): a renewal still due is queued again by the next tick, and the period claim inside
   * `renewSubscription` makes a duplicate run do nothing.
   */
  renew_subscription: async (payload) => {
    const p = payload as {
      organizationId: string;
      businessId: string;
      subscriptionId: string;
      publicId: string;
    };
    // Same exclusion as the tick: a business that started Time Travel after this job was queued
    // is renewed by its simulation, not by wall time.
    const { timeTravelledBusinessIds } = await import("@/modules/time-travel/service");
    if ((await timeTravelledBusinessIds()).includes(p.businessId)) return;
    const { renewSubscription } = await import("@/modules/subscriptions/renewal");
    try {
      // The tick's identity: a fanned-out renewal is still the billing clock's change.
      await runWithEventContext({ source: "scheduled_job", actor: "billing_clock" }, () =>
        renewSubscription(p.organizationId, p.subscriptionId, new Date(), {
          deferNumber: config.RENEWAL_BATCH_NUMBERING === "TRUE",
        }),
      );
    } catch (e) {
      log.recurringError(`renewal_pass_failed:${p.publicId}`, e, {
        event: "renewal_pass_failed",
        subscription: p.publicId,
        organizationId: p.organizationId,
      });
      // Still due, so a later tick queues it again; the record says why it waited.
      const { recordFailureOnTick } = await import("@/modules/subscriptions/renewal");
      await recordFailureOnTick({
        organization: p.organizationId,
        business: p.businessId,
        subscription: p.subscriptionId,
        step: "renewal",
        message: (e as Error)?.message ?? String(e),
      }).catch(() => {});
    }
  },

  /** Batch numbering (`RENEWAL_BATCH_NUMBERING`): number a business's waiting renewal invoices. */
  number_invoices: async (payload) => {
    const p = payload as { organizationId: string; businessId: string };
    const { numberAwaitingInvoices } = await import("@/modules/invoicing/batch-number");
    await runWithEventContext({ source: "scheduled_job", actor: "billing_clock" }, async () => {
      // Drain in batches, each its own transaction; a short batch means the business is caught up.
      while (
        (await numberAwaitingInvoices(p.organizationId, p.businessId)) >=
        config.INVOICE_NUMBER_BATCH
      );
    });
  },

  /**
   * Apply stored gateway webhook events: a delivery the route answered at once
   * (`webhook.processAfterAnswer`), or events a synchronous delivery or the clock pass found
   * errored. Throws while an event errors, so the queue retries.
   */
  process_gateway_webhook: async (payload, helpers) => {
    const { processStoredGatewayWebhook } = await import("@/modules/gateway/inbound");
    // graphile counts this run in `attempts` before it starts; the last run marks the rows.
    await runWithEventContext({ source: "system", actor: null }, () =>
      processStoredGatewayWebhook(payload as StoredDeliveryJob, {
        attempts: helpers.job.attempts,
        maxAttempts: helpers.job.max_attempts,
      }),
    );
  },

  /** Refund the auth amount a mandate registration captured (`setup-auth-refund.ts`). */
  refund_setup_auth: async (payload, helpers) => {
    const { refundSetupAuth } = await import("@/modules/payment-methods/setup-auth-refund");
    const job = payload as import("@/modules/payment-methods/setup-auth-refund").SetupAuthRefundJob;
    const attempt = { attempts: helpers.job.attempts, maxAttempts: helpers.job.max_attempts };
    try {
      await runWithEventContext({ source: "system", actor: null }, () =>
        refundSetupAuth(job, attempt),
      );
    } catch (e) {
      const facts = {
        provider: job.providerKey,
        charge: job.providerChargeId,
        paymentMethod: job.paymentMethod,
        amountMinor: job.amountMinor,
        attempts: attempt.attempts,
      };
      // The failed job row is the durable record; the last attempt pages.
      if (attempt.attempts >= attempt.maxAttempts)
        log.error(e as Error, { event: "setup_auth_refund_failed", ...facts });
      else
        log.warn("a registration payment refund will be retried", {
          event: "setup_auth_refund_retry",
          reason: (e as Error)?.message,
          ...facts,
        });
      throw e;
    }
  },

  /** Receipts (0387): number a business's unnumbered receipts in batches, one series each. */
  number_receipts: async (payload) => {
    const p = payload as { organizationId: string; businessId: string };
    const { numberUnnumberedReceipts } = await import("@/modules/receipts/service");
    await runWithEventContext({ source: "scheduled_job", actor: "billing_clock" }, async () => {
      while (
        (await numberUnnumberedReceipts(p.organizationId, p.businessId)) >=
        config.INVOICE_NUMBER_BATCH
      );
    });
  },

  /**
   * Drain the webhook outbox NOW, instead of at the next minute boundary.
   *
   * The outbox row is enqueued already due (`next_attempt_at = now()`), but the only thing
   * that drained it was the 60-second cron tick — so a first delivery waited 0–60s, ~30s on
   * average, for a POST that had nothing to wait for. `enqueueDeliveries` now enqueues this
   * task in the SAME transaction as the event, so the job row commits atomically with the
   * change and graphile-worker's insert trigger wakes a worker immediately. Sub-second.
   *
   * This does NOT weaken the outbox (ADR-007): the POST still happens outside the
   * transaction, on the worker, with the same claim/retry/backoff. It only removes the wait.
   *
   * Coalesced on a `job_key` so a burst of events produces one nudge rather than one per
   * event. NOT on a named queue: that suppresses graphile-worker's insert NOTIFY and drops the
   * job onto the poll instead (measured ~890ms vs ~37ms commit->POST). Concurrent drains are
   * safe regardless — `deliverPending` leases each row with an atomic compare-and-swap.
   *
   * The clock scope is load-bearing and is the reason this is not a bare `deliverPending`
   * call: a real pass must EXCLUDE time-travelled businesses, whose clock is driven by
   * travel_forward rather than wall time. Without it a nudge would deliver a simulated
   * business's webhooks at real `now`, which is exactly what the tick is careful not to do.
   */
  /**
   * Drain the EMAIL outbox, off the billing clock's back.
   *
   * The twin of `webhook_outbox_nudge`, and the reason both exist as tasks rather than as
   * passes inside the tick: sending mail means calling a machine we do not own, and a
   * scheduler that makes network calls has made a third party's latency into billing
   * latency. Measured 2026-09-01 — one unreachable SMTP host took the sweep from ~12s to
   * 115s, past its own 60s cadence, and the queue grew to 1,456.
   *
   * Its own NAMED QUEUE (see WORKER_CRONTAB) is what makes this isolation real rather than
   * cosmetic: graphile serializes within a queue, so a mail drain that runs long occupies
   * `egress_email` and nothing else, while `billing_clock` keeps its own lane.
   */
  email_outbox_nudge: async () => {
    const { timeTravelledBusinessIds } = await import("@/modules/time-travel/service");
    const excludeBusinessIds = await timeTravelledBusinessIds();
    const { runWithClockScope } = await import("@/platform/clock");
    await runWithClockScope({ excludeBusinessIds }, async () => {
      const r = await deliverPendingEmails(new Date());
      // Silent when it did nothing — one line a minute saying "0 emails" is the kind of
      // noise that makes a log unreadable and an incident invisible.
      // Only when something was attempted: an open circuit on its own repeats every
      // minute for as long as the endpoint stays dead.
      if (r.attempted > 0) {
        log.info("email outbox nudged", {
          attempted: r.attempted,
          sent: r.sent,
          failed: r.failed,
          bounced: r.bounced,
          suppressed: r.suppressed,
          circuitOpen: r.circuitOpen,
        });
      }
    });
  },

  /**
   * Keep the DIARY (`due_work`) in step with the sources.
   *
   * ── WHY THIS IS NOT A PASS IN THE TICK, AND NOT EVERY MINUTE ────────────────────
   * It was both, briefly, and measuring it said otherwise. The projection covers ALL
   * outstanding work, not just what is due: on the development book that is 25,038 rows
   * costing ~11ms to compute, plus an upsert and a not-exists sweep over the same set —
   * against the 9ms the four due-scans it exists to replace take in total. Run every
   * minute, the diary cost MORE than the thing it was meant to make cheaper.
   *
   * That is a property of refresh-based maintenance, not of the idea. A diary pays off when
   * each billing writes its own next line as it goes: maintenance of one row per event, and
   * a read that touches only today's page.
   *
   * ── WHAT THIS JOB IS NOW (updated 2026-09-03) ───────────────────────────────────
   * Those write hooks DO exist — the nine `due_work_sync` triggers from 0225, asserted by
   * the `due_work_write_hooks_installed` invariant. So this is no longer the stand-in that
   * maintains the diary; the triggers do that, synchronously, on the writes themselves.
   * What is left for a full refresh is RECONCILIATION: repairing anything a trigger could
   * not see (a bulk statement that bypassed row triggers, a restore, a window where a hook
   * was missing) so the reconciler's verdict means something.
   *
   * It stays at the reconciler's cadence because that remains the only consumer whose
   * answer depends on it. `/ops/due-work` reads the table too, as of 2026-09-02, but its
   * freshness comes from the TRIGGERS — a renewal moves the diary row in the same
   * transaction that moves the subscription — so the screen is current regardless of when
   * this last ran, and running it more often would still buy precisely nothing.
   */
  due_work_refresh: async () => {
    const { refreshDueWork } = await import("@/modules/ops/due-work");
    const r = await refreshDueWork();
    // Silent when nothing moved — one line every fifteen minutes saying "0 changed" is the
    // noise that makes a log unreadable and a real change invisible.
    if (r.upserted > 0 || r.removed > 0) {
      log.info("due_work refreshed", {
        event: "due_work_refresh",
        upserted: r.upserted,
        removed: r.removed,
      });
    }
  },

  /**
   * Account security housekeeping (0328), every 15 minutes: completes support 2FA resets that
   * are due, sends organization 2FA deadline reminders (0329), and drops security events and
   * trusted browsers past retention. Its own queue because completing a reset
   * sends mail — someone else's socket must not sit in the billing clock's lane.
   */
  security_sweep: async () => {
    const { sweepMfaResets } = await import("@/modules/auth/mfa-reset");
    const { sweepSecurityEvents, flushSecurityMail } =
      await import("@/modules/auth/security-events");
    const { sendOrgMfaDeadlineReminders } = await import("@/modules/auth/org-two-factor");
    const { sweepTrustedBrowsers } = await import("@/modules/auth/trusted-browsers");
    const { sweepWebauthnChallenges } = await import("@/modules/auth/passkeys");
    const now = new Date();
    const resets = await sweepMfaResets(now);
    // 0329: "set up 2FA by tomorrow" for members of organizations that require it.
    const reminders = await sendOrgMfaDeadlineReminders(now);
    const events = await sweepSecurityEvents(now);
    const browsers = await sweepTrustedBrowsers(now);
    // 0330: passkey ceremonies are good for 5 minutes; nothing reads them after.
    await sweepWebauthnChallenges(now);
    await flushSecurityMail();
    if (
      resets.completed > 0 ||
      resets.failed > 0 ||
      reminders.sent > 0 ||
      events.deleted > 0 ||
      browsers.deleted > 0
    ) {
      log.info("security sweep", {
        event: "security_sweep",
        resetsCompleted: resets.completed,
        resetsFailed: resets.failed,
        deadlineRemindersSent: reminders.sent,
        eventsDeleted: events.deleted,
        trustedBrowsersDeleted: browsers.deleted,
      });
    }
  },

  /** Drain push-integration deliveries (`integration_deliveries`); the webhook drain's twin. */
  integration_outbox_nudge: async () => {
    const { timeTravelledBusinessIds } = await import("@/modules/time-travel/service");
    const excludeBusinessIds = await timeTravelledBusinessIds();
    const { runWithClockScope } = await import("@/platform/clock");
    await runWithClockScope({ excludeBusinessIds }, async () => {
      const r = await deliverPendingIntegrations(new Date());
      if (r.attempted > 0) {
        log.info("integration outbox nudged", {
          attempted: r.attempted,
          delivered: r.delivered,
          failed: r.failed,
          skipped: r.skipped,
          circuitOpen: r.circuitOpen,
        });
      }
    });
  },

  webhook_outbox_nudge: async () => {
    const { timeTravelledBusinessIds } = await import("@/modules/time-travel/service");
    const excludeBusinessIds = await timeTravelledBusinessIds();
    const { runWithClockScope } = await import("@/platform/clock");
    await runWithClockScope({ excludeBusinessIds }, async () => {
      const r = await deliverPending(new Date());
      if (r.attempted > 0) {
        log.info("webhook outbox nudged", {
          attempted: r.attempted,
          delivered: r.delivered,
          failed: r.failed,
          circuitOpen: r.circuitOpen,
        });
      }
    });
  },

  /**
   * Refresh every `auto` exchange rate (0229) from the rate provider.
   *
   * OFF THE BILLING QUEUE, on its own lane, for the reason the egress lines above exist:
   * this is the only task in the process that waits on a third party we do not pay and
   * cannot page. One unreachable SMTP host stalled the billing clock for three days
   * (2026-09-01); a rate feed being slow must cost a stale rate and nothing else. The
   * fetch also carries its own hard timeout (`platform/fx/ecb.ts`), so the ceiling is
   * bounded twice over.
   *
   * A failed pass leaves every existing rate standing and records the reason per currency
   * — never clears a good rate, because an absent rate breaks the reporting roll-up
   * outright while a stale one is a visible inaccuracy the screen can label.
   */
  /**
   * Close yesterday into `metric_daily` for every business (0267).
   *
   * Runs once a day, after midnight UTC, and writes the day that has just CLOSED — never
   * today, which is still moving. Each business is written independently: one business's
   * failure must not cost the others their day, and a partial day is repaired by the next
   * run because the write upserts on its full key. (The name predates `metric_daily`; it is
   * the crontab and job key, so it stays.)
   *
   * Its own lane, like every other non-tick line here: the scan is per business and a slow
   * one must not delay a renewal.
   */
  metrics_daily_snapshot: () =>
    recordJobRun("metrics_daily_snapshot", async () => {
      const { writeMetricDayForYesterday } = await import("@/modules/metrics/daily/cron");
      await writeMetricDayForYesterday(new Date());
      // Re-cut the movement fold (0273). A failure only lengthens the ledger tail the
      // waterfall reads, never changes its answer — so it must not retry the pass above.
      const { refreshMovementSummary } = await import("@/modules/metrics/reports/movement-matview");
      await refreshMovementSummary().catch((e) =>
        log.error(e, { event: "movement_summary_refresh_failed" }),
      );
    }),

  /**
   * Recompute TODAY's `metric_daily` row for every business, every 5 minutes.
   *
   * This is what makes caching possible: the nightly job above closes YESTERDAY, so
   * without this a "value now" read would still have to reconstruct the whole book itself.
   *
   * ⚠️⚠️ Queue `metrics_live`, shared only with `metric_windows_refresh` — see its cron line
   * below. Sharing `metrics_snapshot` (or worse, `billing_clock`) would let a worker killed
   * mid-run on THIS 5-minutely job stall that queue, the mechanism behind the 46-minute
   * billing outage on 2026-08-29.
   */
  metric_daily_current: async () => {
    const { writeMetricDayForToday } = await import("@/modules/metrics/daily/cron");
    await writeMetricDayForToday(new Date());
  },

  /** Restate the last 35 days and their coarse periods — see `daily/maintenance.ts`. */
  metric_daily_restate: () =>
    recordJobRun("metric_daily_restate", async () => {
      const { restateTrailingDays } = await import("@/modules/metrics/daily/maintenance");
      await restateTrailingDays(new Date());
    }),

  /** Rolling windows (last 7/30/90 days, 6/12 months) for the non-additive measures. */
  metric_windows_refresh: async () => {
    const { refreshRollingWindows } = await import("@/modules/metrics/daily/windows");
    await refreshRollingWindows(new Date());
  },

  /**
   * Fold received usage events into 15-minute rollups (metering/fold.ts). Own queue
   * `usage_rollups`: a long fold must never hold `billing_clock`. Real runs skip
   * time-travelled businesses, like the tick.
   */
  usage_fold: async () => {
    const { timeTravelledBusinessIds } = await import("@/modules/time-travel/service");
    const excludeBusinessIds = await timeTravelledBusinessIds();
    const { runWithClockScope } = await import("@/platform/clock");
    const { runUsageFold } = await import("@/modules/metering/fold");
    await runWithClockScope({ excludeBusinessIds }, () => runUsageFold().then(() => undefined));
  },

  /**
   * Daily usage partition upkeep: create the next months, then archive and drop partitions
   * past retention (metering/archive.ts). Throws when a partition had to be kept, so the
   * run is recorded as failed and the back-office alerts.
   */
  usage_partitions: () =>
    recordJobRun("usage_partitions", async () => {
      const { createUpcomingPartitions } = await import("@/modules/metering/partitions");
      await createUpcomingPartitions(new Date());
      const { runUsageRetention } = await import("@/modules/metering/archive");
      await runUsageRetention(new Date());
    }),

  /**
   * The on-arrival usage-controls check (usage-controls/check.ts): claims the dirty set,
   * evaluates limits, alerts and threshold invoices. Own queue `usage_controls`; no network
   * call. Real runs skip time-travelled businesses, like the tick.
   */
  usage_controls_check: () =>
    recordJobRun("usage_controls_check", async () => {
      const { timeTravelledBusinessIds } = await import("@/modules/time-travel/service");
      const excludeBusinessIds = await timeTravelledBusinessIds();
      const { runWithClockScope } = await import("@/platform/clock");
      const { runUsageControlsCheck } = await import("@/modules/usage-controls/check");
      // Registers the threshold-invoicing step of the check (design G5 §3.7).
      await import("@/modules/usage-controls/threshold-invoicing");
      await runWithClockScope({ excludeBusinessIds }, () =>
        runUsageControlsCheck().then(() => undefined),
      );
    }),

  /**
   * Plan credit windows (credits/credit-clock.ts, design G3b §3.3): grants every reset window
   * whose start has passed, from the `next_credit_reset_at` index. Own queue
   * `plan_credit_resets`; readers grant a due window themselves, so a late run under-grants
   * nothing. Real runs skip time-travelled businesses; a travel step drives them.
   */
  plan_credit_resets: () =>
    recordJobRun("plan_credit_resets", async () => {
      const { timeTravelledBusinessIds } = await import("@/modules/time-travel/service");
      const excludeBusinessIds = await timeTravelledBusinessIds();
      const { runWithClockScope } = await import("@/platform/clock");
      const { runPlanCreditResets } = await import("@/modules/credits/credit-clock");
      await runWithClockScope({ excludeBusinessIds }, () =>
        runPlanCreditResets(new Date()).then(() => undefined),
      );
    }),

  /** Hourly `usage_event_unmatched` notice per business (metering/notice.ts). */
  usage_unmatched_notice: async () => {
    const { timeTravelledBusinessIds } = await import("@/modules/time-travel/service");
    const excludeBusinessIds = await timeTravelledBusinessIds();
    const { runWithClockScope } = await import("@/platform/clock");
    const { runUnmatchedNotice } = await import("@/modules/metering/notice");
    await runWithClockScope({ excludeBusinessIds }, () =>
      runUnmatchedNotice(new Date()).then(() => undefined),
    );
  },

  /** Remove log-style rows past their retention period — see `modules/ops/retention.ts`. */
  retention_sweep: () =>
    recordJobRun("retention_sweep", async () => {
      const { runRetentionSweep } = await import("@/modules/ops/retention");
      await runRetentionSweep(new Date());
    }),

  /** Compare sampled older days with a recompute; `metric_daily_reproducible` reads it. */
  metric_daily_drift_scan: () =>
    recordJobRun("metric_daily_drift_scan", async () => {
      const { scanMetricDrift } = await import("@/modules/metrics/daily/maintenance");
      await scanMetricDrift(new Date());
    }),

  /**
   * Recompute one business's stored `metric_daily` history (no cron line — enqueued only).
   *
   * Every row is keyed by the business's LOCAL calendar date, so its timezone is part of
   * what each row means. Change the zone and the stored history describes days that no
   * longer exist for that business: the figures are not stale, they are cut on a boundary
   * the account no longer uses. Nothing here can repair a row in place, so the days it
   * already holds are recomputed from the book.
   *
   * Bounded by what is STORED — from the oldest `period_end` on file to today — so it
   * restates history rather than inventing more of it. The day grain only: a coarser grain
   * holds just the non-additive measures and the nightly close restates each open period.
   */
  metric_daily_recompute: async (payload) => {
    const p = payload as
      | { businessId?: string; grains?: string[]; since?: string }
      | null
      | undefined;
    const businessId = p?.businessId;
    if (!businessId) throw new Error("metric_daily_recompute: payload must carry a businessId");
    // `since` = a change of what is counted (0482): restate in place from that day.
    if (p?.since) {
      const { restateMetricsFrom } = await import("@/modules/metrics/daily/recompute");
      const r = await restateMetricsFrom(businessId, p.since);
      log.info("metric_daily restated in place for one business", {
        event: "metric_daily_restated",
        businessId,
        since: p.since,
        days: r.days,
        periods: r.periods,
      });
      return;
    }
    // `grains` = a reporting-calendar change (0293): only those coarse rows are re-cut.
    if (p?.grains) {
      const { recomputeCoarseGrainsForBusiness } =
        await import("@/modules/metrics/daily/recompute");
      const grains = p.grains.filter(
        (g): g is "week" | "quarter" | "year" => g === "week" || g === "quarter" || g === "year",
      );
      const r = await recomputeCoarseGrainsForBusiness(businessId, grains);
      log.info("metric_daily coarse grains recomputed for one business", {
        event: "metric_daily_coarse_recomputed",
        businessId,
        grains,
        periods: r.periods,
        rows: r.rows,
      });
      return;
    }
    const { recomputeMetricDailyForBusiness } = await import("@/modules/metrics/daily/recompute");
    const r = await recomputeMetricDailyForBusiness(businessId);
    log.info("metric_daily recomputed for one business", {
      event: "metric_daily_recomputed",
      businessId,
      days: r.days,
      rows: r.rows,
    });
  },

  fx_refresh_rates: async (payload) => {
    const { refreshAutoExchangeRates } = await import("@/modules/tenancy/exchange-rates");
    // Cron passes nothing, and the pass stays estate-wide. A settings save passes ONE
    // organization: choosing a reporting currency is what first makes that account's rate
    // map wanted, and waiting for the next tick leaves every converted total short by
    // whatever is billed in another currency.
    const only = (payload as { organizationId?: string } | null | undefined)?.organizationId;
    await refreshAutoExchangeRates({
      now: new Date(),
      ...(only ? { onlyOrganizationId: only } : {}),
    });
  },

  /** The AI model price list (model-prices/sync.ts). Never on the billing lane: it fetches. */
  model_prices_sync: async () => {
    const { runModelPriceSync } = await import("@/modules/model-prices/sync");
    const r = await runModelPriceSync();
    if (r.status === "failed")
      log.warn("model price sync failed", { event: "model_prices_sync", error: r.error });
    else log.info("model price sync ran", { event: "model_prices_sync", ...r });
  },

  /**
   * Team alerts (team-alerts/fanout.ts): one `team_alert_send` per opted-in business and kind.
   * The hour comes from the cron's own timestamp, so a backfilled run covers its own hour.
   */
  team_alerts_hourly: async (payload) => {
    const ts = (payload as { _cron?: { ts?: string } } | null)?._cron?.ts;
    const { timeTravelledBusinessIds } = await import("@/modules/time-travel/service");
    const { runTeamAlertsFanout } = await import("@/modules/team-alerts/fanout");
    const r = await runTeamAlertsFanout(ts ? new Date(ts) : new Date(), enqueue, {
      excludeBusinessIds: await timeTravelledBusinessIds(),
    });
    if (r.enqueued > 0) log.info("team alerts queued", { event: "team_alerts_queued", ...r });
  },

  /** One team alert mail. Retried by the queue when the mailer refuses (max 6). */
  /** The portal sign-in code email, queued so the request's timing reveals nothing. */
  portal_sign_in_code_send: async (payload) => {
    const p = payload as import("@/modules/customer-portal/login-code").SignInCodeJob | null;
    if (!p?.organizationId || !p.businessId || !p.codeId || !p.to || !p.code)
      throw new Error(
        "portal_sign_in_code_send: payload needs organizationId, businessId, codeId, to, code",
      );
    const { sendQueuedSignInCode } = await import("@/modules/customer-portal/login-code");
    await sendQueuedSignInCode(p);
  },

  team_alert_send: async (payload) => {
    const p = payload as {
      organizationId?: string;
      businessId?: string;
      kind?: "overdue" | "webhook_failures" | "daily_digest";
      hour?: string;
    } | null;
    if (!p?.organizationId || !p.businessId || !p.kind || !p.hour)
      throw new Error("team_alert_send: payload needs organizationId, businessId, kind, hour");
    const { sendTeamAlert } = await import("@/modules/team-alerts/service");
    await sendTeamAlert({
      organizationId: p.organizationId,
      businessId: p.businessId,
      kind: p.kind,
      hour: new Date(p.hour),
    });
  },

  /** Price-change mail to each organization's price managers (model-prices/notices.ts). */
  model_price_notices: async () => {
    const { runModelPriceNotices } = await import("@/modules/model-prices/notices");
    await runModelPriceNotices();
  },

  geo_upstream_check: async () => {
    const { checkGeoUpstream } = await import("@/platform/geo-upstream");
    const r = await checkGeoUpstream();
    if (r.error)
      log.warn("geo upstream check failed", { event: "geo_upstream_check", error: r.error });
    else
      log.info("geo upstream checked", { event: "geo_upstream_check", latest: r.upstreamVersion });
  },

  /**
   * Release queue locks whose holder is dead (0215).
   *
   * The boot-time sweep in `worker.ts` covers the common case — a worker dies, its
   * replacement starts, the lock is released within a second. This covers the one it
   * cannot: a worker that dies while a SIBLING keeps running, where no boot happens at
   * all. Under a supervisor that restarts a crashed process, that is the window between
   * the crash and the restart; with two workers on one host, it is indefinite.
   *
   * DELIBERATELY ON NO NAMED QUEUE. Every other cron line here takes `queue=` for
   * single-flight, and doing so would make this task the one thing in the system that can
   * be disabled by the exact failure it repairs — a stranded lock on `ops_stranded_locks`
   * would be permanent. Concurrent runs are harmless: `force_unlock_workers` is idempotent
   * and the identity test re-reads liveness each pass.
   *
   * Silence is the normal outcome. `releaseStrandedQueueLocks` logs at `error` when it
   * actually releases something, because a successful recovery still means a worker died
   * badly, and a self-heal nobody sees is how a supervisor that hard-kills on every deploy
   * stays invisible.
   */
  /**
   * HubSpot pushes queued by the event sink, every minute, for autosyncing connections.
   * Its own lane: HubSpot being slow or down must cost stale CRM records, never a renewal.
   */
  hubspot_sync_tick: async () => {
    const { connectionsWithDueWork, loadConnection, runSync } =
      await import("@/modules/hubspot/sync/engine");
    for (const c of await connectionsWithDueWork()) {
      const conn = await loadConnection(c.organizationId, c.id);
      if (conn) await runSync(conn, "event");
    }
  },

  /** The 15-minute autosync: drains whatever the tick left and reclaims dead claims. */
  hubspot_autosync: async () => {
    const { autosyncConnections, loadConnection, runSync } =
      await import("@/modules/hubspot/sync/engine");
    for (const c of await autosyncConnections()) {
      const conn = await loadConnection(c.organizationId, c.id);
      if (conn) await runSync(conn, "autosync");
    }
  },

  /** Sync Now and the post-connect sweep. Payload: `{ organizationId, connectionId, trigger, full }`. */
  hubspot_sync_connection: async (payload) => {
    const p = payload as {
      organizationId: string;
      connectionId: string;
      trigger: "manual" | "initial";
      full?: boolean;
    };
    const { loadConnection, runSync } = await import("@/modules/hubspot/sync/engine");
    const conn = await loadConnection(p.organizationId, p.connectionId);
    if (conn) await runSync(conn, p.trigger, { full: p.full, budgetMs: 10 * 60_000 });
  },

  ops_release_stranded_locks: async () => {
    const { releaseStrandedQueueLocks } = await import("@/modules/ops/stranded-locks");
    await releaseStrandedQueueLocks();
  },

  // Retired 2026-10-13 (no cron line schedules them). A job queued before the upgrade would
  // otherwise wait forever under a name no worker claims; these drain it. Delete next release.
  ops_invariants: async () => {},
  ops_alert_history: async () => {},
  ops_alert_notify: async () => {},
};

export const taskList: Record<string, Task> = Object.fromEntries(
  Object.entries(tasks).map(([name, task]) => [name, tracedTask(name, task)]),
);

/**
 * Which worker process a task belongs to.
 *
 * Only `billing` remains — the engine's clock. The `shadow` role (a parallel-run
 * poller) was removed with the shadow programme; the split survives because
 * it is the seam a future out-of-band role would use, and because `worker_heartbeat.role`
 * still holds `shadow` on rows written before the removal.
 */
/**
 * `billing` runs everything (what production deploys). `clock` and `reports` split it in two
 * for a multi-server deployment: reporting folds the whole book and must not share a heap or a
 * crash with renewals. `collect` charges batch-numbered renewal invoices: gateway-bound, so it
 * runs apart from renewals instead of competing with them for job slots.
 */
export type WorkerRole = "billing" | "clock" | "reports" | "collect";

/** Reporting, sync and housekeeping work, which a renewal never waits on. */
const REPORT_TASKS = new Set([
  "metrics_daily_snapshot",
  "metric_daily_current",
  "metric_daily_restate",
  "metric_windows_refresh",
  "metric_daily_drift_scan",
  "metric_daily_recompute",
  "retention_sweep",
  "fx_refresh_rates",
  "geo_upstream_check",
  "model_prices_sync",
  "model_price_notices",
  "hubspot_sync_tick",
  "hubspot_autosync",
  "hubspot_sync_connection",
]);
/** Frees a dead worker's queue locks, so every role runs it. */
const EVERY_ROLE = new Set(["ops_release_stranded_locks"]);
// `collect` runs no queued task of its own: it runs the collection pump (`collect-pump.ts`).
const roleOf = (task: string): WorkerRole => (REPORT_TASKS.has(task) ? "reports" : "clock");
const forRole = (role: WorkerRole, task: string): boolean =>
  role === "billing" || EVERY_ROLE.has(task) || roleOf(task) === role;
const cronTask = (line: string): string => line.trim().split(/\s+/)[5]!;

const ROLE_TASKS: Record<WorkerRole, string[]> = {
  billing: Object.keys(tasks),
  clock: Object.keys(tasks).filter((t) => forRole("clock", t)),
  reports: Object.keys(tasks).filter((t) => forRole("reports", t)),
  collect: Object.keys(tasks).filter((t) => forRole("collect", t)),
};

const BILLING_CRONTAB: string[] = [
  "* * * * * billing_clock_tick ?max=1&queue=billing_clock&jobKey=billing_clock_tick",
  /**
   * Egress — the two outboxes, moved OFF the tick (2026-09-02).
   *
   * ── WHY SEPARATE NAMED QUEUES IS THE WHOLE POINT ────────────────────────────────
   * The isolation is not "a separate process"; it is the QUEUE NAME. graphile-worker
   * serializes within a named queue and runs different queues concurrently up to
   * `WORKER_CONCURRENCY` (5). So `billing_clock`, `egress_email` and `egress_webhook`
   * each get their own lane on the SAME worker: a mail drain that runs long occupies its
   * own lane and cannot delay a renewal, which is precisely what could not be said while
   * both were passes inside one serialized tick.
   *
   * A dedicated egress DEPLOYMENT is deliberately NOT introduced here. Adding a
   * `WorkerRole` nobody deploys would mean the first environment to upgrade silently
   * stops sending mail — a worse outage than the one this fixes — and the isolation that
   * matters is already bought by the queue names. Splitting processes is a capacity
   * decision for when one worker is genuinely the limit.
   *
   * Same three options as the tick, for the same reasons: `max=1` because every pass
   * re-scans for due work so a retry is duplication, `queue=` for the lane, and `jobKey=`
   * so a drain that outlives its 60s cadence replaces its pending twin instead of stacking
   * a backlog. That last one is what made this a three-day incident rather than a slow
   * minute.
   */
  "* * * * * email_outbox_nudge ?max=1&queue=egress_email&jobKey=email_outbox_nudge",
  "* * * * * webhook_outbox_nudge ?max=1&queue=egress_webhook&jobKey=webhook_outbox_nudge",
  "* * * * * integration_outbox_nudge ?max=1&queue=egress_integration&jobKey=integration_outbox_nudge",
  // One minute before each quarter hour, so a reconciler reading on the quarter hour grades a
  // fresh index: on the same edge it once graded an EMPTY table and reported 20 violations
  // when the true drift was zero. Own queue, and a jobKey because a refresh is a repeatable
  // sweep like every other line here.
  "14,29,44,59 * * * * due_work_refresh ?max=1&queue=due_work&jobKey=due_work_refresh",
  // Support 2FA resets fall due in 15-minute steps; the wait is days, so that is plenty.
  "*/15 * * * * security_sweep ?max=1&queue=security&jobKey=security_sweep",
  /**
   * The exchange-rate refresh (0229) — TWICE A DAY, in the evening UTC.
   *
   * The ECB publishes its daily reference rates once per WEEKDAY, around 16:00 CET
   * (15:00 UTC in winter, 14:00 in summer). Cron here is UTC, so 16:30 clears
   * publication in both halves of the year without needing a DST rule; the 20:30 run is
   * a plain second attempt, because a single daily shot means one transient network
   * failure holds every auto rate stale for 24 hours. Re-fetching an already-current
   * rate rewrites the same number and the same `asOf`, so the second run is a no-op in
   * effect — two requests a day against a free public feed is a courtesy we can afford.
   *
   * Deliberately NOT hourly: the source publishes daily, so a more frequent poll would
   * spend requests to re-read a number that cannot have changed, and would make a
   * "last updated" line that moves without the rate moving — which is the kind of
   * detail that makes an operator trust a stale figure.
   *
   * Weekends are not skipped. A Saturday pass re-reads Friday's publication and writes
   * Friday's `asOf` unchanged, which is exactly what the screen should show; skipping
   * them would only mean a Monday morning failure goes unretried for longer.
   */
  /**
   * The daily snapshot, at 00:20 UTC — after the day it describes has closed, and late
   * enough that a renewal firing on the midnight edge has landed. It writes YESTERDAY,
   * so nothing it stores can still change under it except by a backdated edit, which the
   * next run restates.
   *
   * `jobKey` for the same reason as the drains: a snapshot pass that outlives its own
   * cadence must replace its pending twin rather than stack one per day.
   */
  "20 0 * * * metrics_daily_snapshot ?max=1&queue=metrics_snapshot&jobKey=metrics_daily_snapshot",
  /**
   * TODAY's `metric_daily` row, every 5 minutes — the piece that makes caching possible.
   * Without it a "value now" read still reconstructs the whole book; with it, it reads
   * a row that is at most 5 minutes stale.
   *
   * ⚠️⚠️ The `metrics_live` queue, shared ONLY with `metric_windows_refresh` below, and never
   * with `metrics_snapshot` or `billing_clock`. graphile-worker serializes only within a
   * named queue and a lock has no expiry: a worker killed holding one stops that queue
   * (the 46-minute billing outage on 2026-08-29). `ops_release_stranded_locks` now frees
   * such a lock within ~5 min, and this queue holds nothing a renewal waits on.
   *
   * Shared so the two never run at once: each holds ~0.5–0.7 GB at its peak, and glibc keeps
   * the SUM as worker RSS (measured 2026-10-14, `job_rss_growth`: 806 → 1,539 MiB at :35).
   *
   * `jobKey` so a run still going when the next tick fires coalesces into one pending job
   * instead of a backlog stacking up.
   */
  "*/5 * * * * metric_daily_current ?max=1&queue=metrics_live&jobKey=metric_daily_current",
  /**
   * After the 00:20 close: restate the trailing 35 days (≈4 min on production), then scan
   * older sampled days for drift. Each on its OWN queue for the reason above — a worker
   * killed mid-run must not stall anything else — and `jobKey` so an overrun coalesces.
   */
  "50 0 * * * metric_daily_restate ?max=1&queue=metric_daily_restate&jobKey=metric_daily_restate",
  "40 1 * * * metric_daily_drift_scan ?max=1&queue=metric_daily_drift&jobKey=metric_daily_drift_scan",
  // D17. After the metric jobs, before the morning; its own queue so a long first catch-up
  // blocks nothing else.
  "30 2 * * * retention_sweep ?max=1&queue=retention&jobKey=retention_sweep",
  // Usage metering: the fold on its own lane; partition upkeep and the unmatched notice share
  // `usage_maintenance`, so a slow archive upload stalls neither the fold nor retention_sweep.
  "* * * * * usage_fold ?max=1&queue=usage_rollups&jobKey=usage_fold",
  "15 1 * * * usage_partitions ?max=1&queue=usage_maintenance&jobKey=usage_partitions",
  "5 * * * * usage_unmatched_notice ?max=1&queue=usage_maintenance&jobKey=usage_unmatched_notice",
  // Usage controls on arrival: its own lane, so a slow check never holds the fold or the clock.
  "* * * * * usage_controls_check ?max=1&queue=usage_controls&jobKey=usage_controls_check",
  // Plan credit windows (G3b): their own lane, so a slow grant run never holds the clock.
  "* * * * * plan_credit_resets ?max=1&queue=plan_credit_resets&jobKey=plan_credit_resets",
  // Half-hourly (~65s on production). A window ends TODAY in the business's zone, so after
  // local midnight Home computes it on demand until the next run; :05 and :35 keep that gap
  // at 5 min for whole- and half-hour zones alike. Queue `metrics_live`, shared with
  // `metric_daily_current` above so the two take turns.
  "5,35 * * * * metric_windows_refresh ?max=1&queue=metrics_live&jobKey=metric_windows_refresh",
  "30 16,20 * * * fx_refresh_rates ?max=1&queue=fx_refresh&jobKey=fx_refresh_rates",
  // Weekly: record dr5hn's latest release for the `geo_reference_outdated` alert. Own
  // queue, like every external fetch here, so a hung request blocks nothing else.
  "30 4 * * 1 geo_upstream_check ?max=1&queue=geo_upstream&jobKey=geo_upstream_check",
  // Hourly; an unchanged source answers 304, and a held batch settles on these runs. Own queue,
  // shared only with the notice mail: the billing tick never makes a network call.
  "10 * * * * model_prices_sync ?max=1&queue=model_prices&jobKey=model_prices_sync",
  "*/10 * * * * model_price_notices ?max=1&queue=model_prices&jobKey=model_price_notices",
  // Team alerts on the hour. No jobKey: a pending run for the previous hour must not be
  // replaced, because each run covers its own hour. `fill` re-runs hours missed while down.
  "0 * * * * team_alerts_hourly ?max=1&queue=team_alerts&fill=6h",
  /**
   * The stranded-queue-lock sweep, every five minutes.
   *
   * NO `queue=`, unlike every other line here — see the task's own comment. A lock on
   * its queue would disable the only thing that can clear a lock, which is the failure
   * mode this whole mechanism exists to end rather than reproduce.
   *
   * Five minutes bounds worst-case recovery for the case boot cannot cover (a sibling
   * worker dies while this process keeps running) at 5 min + STRANDED_LOCK_GRACE_MS.
   * Against the 46 minutes and a human that it replaces, faster is not worth the extra
   * liveness reads.
   */
  "*/5 * * * * ops_release_stranded_locks ?max=1",
  "* * * * * hubspot_sync_tick ?max=1&queue=hubspot_sync&jobKey=hubspot_sync_tick",
  "*/15 * * * * hubspot_autosync ?max=1&queue=hubspot_sync&jobKey=hubspot_autosync",
];

const ROLE_CRONTAB: Record<WorkerRole, string[]> = {
  billing: BILLING_CRONTAB,
  clock: BILLING_CRONTAB.filter((l) => forRole("clock", cronTask(l))),
  reports: BILLING_CRONTAB.filter((l) => forRole("reports", cronTask(l))),
  collect: BILLING_CRONTAB.filter((l) => forRole("collect", cronTask(l))),
};

/** The task list one role may execute. */
export function taskListFor(role: WorkerRole | "all"): Record<string, Task> {
  if (role === "all") return taskList;
  return Object.fromEntries(ROLE_TASKS[role].map((name) => [name, taskList[name]!]));
}

/** The cron lines one role owns. */
export function crontabFor(role: WorkerRole | "all"): string {
  const lines = role === "all" ? ROLE_CRONTAB.billing : ROLE_CRONTAB[role];
  return lines.join("\n");
}

/** Task identifiers a role can run (for its heartbeat row). */
export function tasksFor(role: WorkerRole | "all"): string[] {
  return role === "all" ? Object.keys(tasks) : ROLE_TASKS[role];
}

/**
 * The cron schedule, in graphile-worker crontab format.
 *
 * Exported so a schedule view renders from THIS constant rather than from a copy: a "next run" panel that
 * reads a second, hand-maintained list would eventually lie about what the worker
 * is running. Cron is evaluated in **UTC** by graphile-worker.
 *
 * The three options are load-bearing (2026-08-05 robustness review, finding #2;
 * `jobKey` added 2026-09-01):
 *
 *  - `queue=billing_clock` — graphile-worker serializes jobs ONLY within a named
 *    queue. Without it cron jobs go in with `queue_name = NULL` and up to
 *    `concurrency` ticks run simultaneously, each opening its own clock_ticks row.
 *    A comment here previously claimed serialization came from the task name; it
 *    does not.
 *  - `max=1` — no retries. Cron enqueues a fresh tick every 60s and every pass
 *    re-scans for due work, so retrying THIS tick is pure duplication. With the
 *    default of 25 attempts and backoff out to ~6h, a ten-minute database outage
 *    left ten tick jobs queued that all swept at once on recovery, then again
 *    hours later.
 *  - `jobKey=billing_clock_tick` — no DUPLICATES, which is the same argument as
 *    `max=1` applied to the enqueue side rather than the retry side. `max=1` stops
 *    a failed tick being re-run; nothing stopped cron adding a SECOND tick while the
 *    first was still queued. A pending tick is redundant by construction — every pass
 *    scans as of `new Date()` at the moment it runs, not as of the job's `run_at` — so
 *    the queue only ever needs the newest one. Without this the queue is unbounded
 *    whenever a tick outlives its own 60s cadence: measured 2026-09-01, 1,456 queued
 *    ticks with the oldest 24h old, while a single unreachable SMTP host held every
 *    tick at 115s. graphile-worker defaults `jobKeyMode` to `replace`, which updates
 *    the pending row in place; a tick already LOCKED is left alone and a fresh row is
 *    created, so the steady-state depth is one running plus one waiting — never more.
 *
 * `jobKey` is deliberately NOT applied to the other lines. They are already spaced
 * wider than any plausible run (5 and 15 minutes), and an ops sweep that silently
 * replaced its own pending run would hide exactly the pile-up it exists to report.
 *
 * Kept as the UNION of every role's schedule (see `crontabFor`), because the ops panel
 * answers "what is this system scheduled to run", not "what is this one process running"
 * — a reader looking for the next renewal should not have to know which process owns it.
 * What each PROCESS actually runs is on its own `worker_heartbeats` row.
 */
export const WORKER_CRONTAB = crontabFor("all");

/** Pool size — surfaced on the worker's heartbeat row so ops sees real capacity. */
export const WORKER_CONCURRENCY = config.WORKER_CONCURRENCY;

/** Task identifiers this build can run (for the heartbeat row). */
export const WORKER_TASKS = Object.keys(tasks);

/**
 * graphile-worker's logs, routed through pino.
 *
 * Its default is a console logger, so everything the queue itself said — job started,
 * job failed, cron fired — arrived as unstructured text while our own lines were JSON.
 * `scope` carries graphile's own context (worker id, job id) and is passed through as
 * fields rather than flattened into the message.
 */
/**
 * graphile-worker logs its own ORDINARY LIFECYCLE at `error`.
 *
 * Every line in its signal handling — including the entirely normal
 * "Received 'SIGTERM'; attempting global graceful shutdown" and "Global graceful shutdown
 * complete" — goes through `logger.error` (graphile-worker 0.16.6, `dist/main.js` 85-130).
 * Forwarding that verbatim made a clean shutdown indistinguishable from a failure: in a
 * 13-hour log export, **21 of 185 ERROR rows (11%) were routine shutdown chatter**. An error
 * budget that is mostly normal operation is one nobody reads, which is the same alert-fatigue
 * failure as an invariant that is always red.
 *
 * Overriding a library's own level is normally a smell, so this is deliberately narrow:
 *  - it only ever DOWNGRADES, and only for `level === 'error'`;
 *  - it matches anchored, specific text, so anything graphile adds later stays an error;
 *  - a FORCEFUL shutdown lands on `warn`, not `info` — it means the graceful path timed out
 *    and work may have been cut off, which is worth seeing without being a failure.
 *
 * If a graphile upgrade rewords these, the lines simply return to `error` — the safe
 * direction, and `verify:logging` pins the mapping so the change is visible rather than silent.
 */
const GRAPHILE_LIFECYCLE = [
  { re: /^Received '.*'; attempting global graceful shutdown/, level: "info" as const },
  { re: /^Global graceful shutdown complete; killing self via/, level: "info" as const },
  { re: /^Ignoring '.*' \(graceful shutdown already in progress\)/, level: "info" as const },
  { re: /^Received '.*'; attempting global forceful shutdown/, level: "warn" as const },
  { re: /^Global forceful shutdown completed; killing self via/, level: "warn" as const },
  { re: /^Ignoring '.*' \(forceful shutdown already in progress\)/, level: "warn" as const },
];

/** The level a graphile line should actually be logged at. Only ever downgrades an error. */
export function graphileLevelFor(
  level: string,
  message: string,
): "error" | "warn" | "info" | "debug" {
  if (level === "error") {
    const hit = GRAPHILE_LIFECYCLE.find((m) => m.re.test(message));
    if (hit) return hit.level;
    return "error";
  }
  if (level === "warning") return "warn";
  if (level === "debug") return "debug";
  return "info";
}

const graphileLogger = new GraphileLogger((scope) => (level, message, meta) => {
  // `queue` rather than `source`: `source` is a RESERVED context field (api / dashboard /
  // scheduled_job / migration / system) that cloud-logging promotes to an indexed label.
  // Written raw, this object went top-level and overwrote that label with
  // `graphile-worker`, which is not one of its values. Through the facade it lands in
  // `debug_info` and the real `source` comes from the event context, as everywhere else.
  const fields = { queue: "graphile-worker", ...scope, ...meta };
  const effective = graphileLevelFor(level, message);
  if (effective === "error") log.error(message, fields);
  else if (effective === "warn") log.warn(message, fields);
  else if (effective === "debug") log.debug(message, fields);
  else log.info(message, fields);
});

/**
 * Start the long-running worker: processes the queue AND the cron schedule.
 *
 * `role` scopes BOTH what it executes and what it schedules — see `WorkerRole`. Defaults
 * to `billing`, the engine's clock, which is now the only role.
 */
export async function startWorker(
  role: WorkerRole | "all" = "billing",
  /**
   * The event emitter to use, when the caller needs listeners attached BEFORE the pool
   * starts. `worker:create` fires synchronously inside `run()`, so a listener attached to
   * `runner.events` afterwards misses every worker the pool opened at boot — which is
   * exactly the set whose ids stranded-lock recovery depends on knowing (see
   * `poolWorkerIds` in worker.ts). Omit it and one is created here as before.
   */
  events: WorkerEvents = new EventEmitter() as WorkerEvents,
): Promise<Runner> {
  return run({
    connectionString: config.DATABASE_URL,
    // `collect` runs only the stranded-lock sweep here; its concurrency goes to the pump lanes.
    // Idle slots are not free: every job insert wakes each one into a job lookup.
    concurrency: role === "collect" ? 1 : WORKER_CONCURRENCY,
    pollInterval: config.WORKER_POLL_INTERVAL_MS,
    taskList: taskListFor(role),
    // Route graphile-worker's own logging through pino instead of its console
    // default, so job/cron lines are structured and searchable like everything
    // else. Without this the one line per minute proving billing ran was the only
    // unstructured output the service produced.
    logger: graphileLogger,
    // Only this role's lines: a process must not schedule work it cannot execute.
    crontab: crontabFor(role),
    // Supply the emitter EXPLICITLY. When omitted, graphile-worker defaults it per
    // compiled-options instance (`lib.js`: `events = new EventEmitter()`), so the
    // pool that runs jobs can end up emitting on a different instance than the one
    // exposed as `runner.events` — `job:*` listeners then attach to an emitter that
    // never fires, silently. Owning the instance makes the worker's job-lifecycle
    // logging and counters actually work.
    events,
    // worker.ts owns SIGINT/SIGTERM. graphile's own handler starts the pool's shutdown first,
    // after which our `runner.stop()` returns at once — the worker then exited 0.5 s into a
    // running job and stranded its queue lock (2026-09-27).
    noHandleSignals: true,
    // graphile aborts running jobs this long after shutdown begins (default 5 s); match the
    // drain budget so the budget is the only limit.
    gracefulShutdownAbortTimeout: config.WORKER_SHUTDOWN_TIMEOUT_MS,
    // Batching (graphile-worker 0.17+), both off by default; see config.
    preset: {
      worker: {
        ...(config.WORKER_LOCAL_QUEUE_SIZE > 1
          ? { localQueue: { size: config.WORKER_LOCAL_QUEUE_SIZE } }
          : {}),
        completeJobBatchDelay: config.WORKER_JOB_BATCH_DELAY_MS,
        failJobBatchDelay: config.WORKER_JOB_BATCH_DELAY_MS,
      },
    },
  });
}

/**
 * Cached as the PROMISE, not the resolved value.
 *
 * `utils ??= await makeWorkerUtils(...)` looks like a singleton but is not: the await
 * suspends before the assignment, so N concurrent callers each build their own
 * WorkerUtils — each with its own pg pool — and all but one leak, with nothing left
 * holding a reference to release them. Caching the in-flight promise makes concurrent
 * callers share one instance.
 */
let utilsPromise: Promise<WorkerUtils> | undefined;

/**
 * Enqueue a job from anywhere (e.g. the API).
 *
 * The active traceId is stamped into the payload (`_trace`) so the work done
 * later by the worker correlates with the request that queued it — an ALS context
 * cannot survive a trip through a Postgres row.
 */
export async function enqueue(
  task: string,
  payload?: unknown,
  spec?: { jobKey?: string; queueName?: string; maxAttempts?: number; runAt?: Date },
): Promise<void> {
  utilsPromise ??= makeWorkerUtils({ connectionString: config.DATABASE_URL });
  const utils = await utilsPromise;
  await utils.addJob(task, stampTracePayload(payload) as object | undefined, spec);
}

/**
 * Release the enqueue pool. Idempotent, never throws.
 *
 * Without this the pool outlives the work: a script that enqueues one job hangs on exit
 * (which is why `scripts/enqueue-tick.ts` needs an explicit `process.exit`), and a
 * long-lived process that stops enqueuing keeps its connections checked out forever.
 */
export async function releaseEnqueuePool(): Promise<void> {
  const p = utilsPromise;
  if (!p) return;
  utilsPromise = undefined;
  try {
    await (await p).release();
  } catch {
    // Shutdown-time best effort: a pool that cannot be released cleanly must not be
    // the reason the process fails to exit.
  }
}
