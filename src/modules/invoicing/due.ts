import { and, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import { loadEffectiveDunningConfig } from "@/modules/dunning-policies/effective";
import { systemDb, withTenant } from "@/platform/db";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import {
  collectInvoice,
  CollectionInFlightError,
  isAutoCollectOn,
  autoCollectionOffSql,
  dunningHoldFor,
  dunningNotHeldSql,
} from "./service";
import { applyDunningFinalAction } from "@/modules/subscriptions/dunning";
import {
  offlineDunningApplies,
  offlineDunningDeadline,
  nextOfflineReminderAt,
  dunningAnchor,
} from "@/modules/subscriptions/dunning-schedule";
import { invoices, subscriptions, customers, businesses } from "@db/schema";
import { scanBusinessFilter } from "@/platform/clock";
import { config as appConfig } from "@/platform/config";
import { createLogger } from "@/platform/logger";
import type { TickError } from "@/modules/subscriptions/renewal";

const log = createLogger("invoicing.due");

/**
 * Clock pass (E1 / INV-2): transition finalized `posted` invoices whose due date
 * has passed — the state-diagram edges:
 *   posted → paid          (auto-collect on, charge succeeds at due date)
 *   posted → payment_due   (auto-collect on, charge fails → dunning opens)
 *   posted → payment_due   (auto-collect off: the offline dunning window opens)
 *   posted → not_paid      (auto-collect off AND offline dunning opted out)
 *
 * A `posted` invoice with a future due date is a Net-D bill deferred by
 * `billSubscriptionPeriod`; the clock collects (or hard-flags) it here at term.
 * Runs system-wide across orgs; each invoice is handled in its org's RLS context.
 *
 * ── The offline edge changed on 2026-08-31, and had to ────────────────────────
 * It used to be `posted → not_paid` unconditionally. Two things broke that:
 *
 *  1. An unpaid `auto_collection: off` invoice belongs in `payment_due` +
 *     `dunning_status: in_progress` + `next_attempt_at = date + the first reminder
 *     interval`, with no attempt recorded. `not_paid` is the collection-FAILED
 *     status, and a send-invoice bill has failed nothing.
 *  2. `due_date` now defaults to the INVOICE DATE when there are no net terms, so
 *     "past its due date → not_paid" would have flipped EVERY offline invoice to
 *     not_paid on the day it was raised — precisely backwards.
 *
 * So an offline invoice stays `payment_due` for its whole dunning window and becomes
 * `not_paid` + `exhausted` only when the window closes — the second scan at the
 * bottom of this file, which still ends in the same `applyDunningFinalAction` a
 * retry-exhausted invoice reaches. The opt-out (`dun_offline_invoices: false`) keeps
 * the older edge exactly as it was.
 */
export async function runInvoiceDueTransitions(now: Date): Promise<{
  transitioned: number;
  collected: number;
  notPaid: number;
  dueForDunning: number;
  /** Offline invoices whose due date opened a dunning window (dun_offline_invoices). */
  offlineDunningOpened: number;
  /**
   * Offline invoices moved on to their NEXT reminder instant inside an open window.
   * Not surfaced by `jobs.ts` (its reporter predates this counter) — returned so a
   * caller/test can tell "the ladder advanced" from "nothing happened".
   */
  offlineRemindersSent: number;
  /** Offline invoices whose window closed → the configured final action applied. */
  offlineDunningExhausted: number;
  /** Per-invoice failures (SCHED-1) — surfaced in `clock_ticks.errors`. */
  errors: TickError[];
}> {
  const errors: TickError[] = [];
  const due = await systemDb
    .select({
      id: invoices.id,
      organizationId: invoices.organizationId,
      businessId: invoices.businessId,
      subscriptionId: invoices.subscriptionId,
    })
    .from(invoices)
    // Skip invoices with an unexpired collection LEASE (a concurrent pass holds them);
    // a posted invoice normally has next_attempt_at NULL, so this is the claim marker.
    .where(
      and(
        eq(invoices.status, "posted"),
        or(
          and(
            isNotNull(invoices.dueDate),
            lte(invoices.dueDate, now),
            or(isNull(invoices.nextAttemptAt), lte(invoices.nextAttemptAt, now)),
          ),
          // A charge deferred for a gateway pre-debit notice is due at `next_attempt_at`,
          // even when net terms put the due date later. A deferral never sets a dunning
          // status; imported and offline-dunning invoices do, and must still wait.
          and(
            isNotNull(invoices.nextAttemptAt),
            lte(invoices.nextAttemptAt, now),
            isNull(invoices.dunningStatus),
          ),
        ),
        scanBusinessFilter(invoices.businessId),
      ),
    );

  let transitioned = 0;
  let collected = 0;
  let notPaid = 0;
  let dueForDunning = 0;
  let offlineDunningOpened = 0;
  let offlineRemindersSent = 0;
  let offlineDunningExhausted = 0;

  for (const row of due) {
    try {
      const ctx = await withTenant(row.organizationId, async (tx) => {
        const [inv] = await tx.select().from(invoices).where(eq(invoices.id, row.id)).limit(1);
        if (!inv || inv.status !== "posted") return null;
        const [cust] = await tx
          .select({ ac: customers.autoCollection })
          .from(customers)
          .where(eq(customers.id, inv.customerId))
          .limit(1);
        const sub = inv.subscriptionId
          ? ((
              await tx
                .select()
                .from(subscriptions)
                .where(eq(subscriptions.id, inv.subscriptionId))
                .limit(1)
            )[0] ?? null)
          : null;
        return { inv, custAc: cust?.ac, sub };
      });
      if (!ctx) continue;
      // Picked up before its due date only to retry a deferred charge; nothing else is early.
      const notYetDue = !ctx.inv.dueDate || ctx.inv.dueDate > now;
      if (notYetDue && !isAutoCollectOn(ctx.sub?.autoCollection ?? null, ctx.custAc)) continue;
      transitioned++;

      if (isAutoCollectOn(ctx.sub?.autoCollection ?? null, ctx.custAc)) {
        // ATOMIC CLAIM before charging (review blocker): two overlapping due passes
        // otherwise both call collectInvoice → two engine-side payment rows even
        // when the gateway dedupes. Lease next_attempt_at into the future WHERE the
        // invoice is still posted and unclaimed; the loser sees 0 rows and skips.
        // dunning_status stays null on a posted invoice, so the lease can't be
        // mistaken for a merchant pause by planFailureRearm. The lease self-heals:
        // a crash between claim and outcome leaves it, but once it expires
        // (next_attempt_at <= now) the next due pass reclaims it.
        const leaseUntil = new Date(now.getTime() + 10 * 60 * 1000);
        const claimed = await withTenant(row.organizationId, async (tx) => {
          const [r] = await tx
            .update(invoices)
            .set({ nextAttemptAt: leaseUntil })
            .where(
              and(
                eq(invoices.id, ctx.inv.id),
                eq(invoices.status, "posted"),
                or(isNull(invoices.nextAttemptAt), lte(invoices.nextAttemptAt, now)),
              ),
            )
            .returning({ id: invoices.id });
          return !!r;
        });
        if (!claimed) continue;
        // Collect now — flips the invoice to paid (success) or payment_due (fail,
        // which opens dunning) via collectInvoice's own status/event handling.
        //
        // The lease above claims this invoice against another DUE PASS; collectInvoice's
        // own claim covers the collectors that never take a lease (an operator's "collect
        // now", the customer-level collect). Losing that one means a charge is
        // already in flight, so this pass simply leaves the row alone — the lease expires
        // and a later pass reclaims it if the in-flight attempt did not settle it.
        // Credit on file before the card, as every collection path does.
        const { applyCreditBeforeCharge } = await import("@/modules/customers/collect");
        const credit = await applyCreditBeforeCharge({
          organizationId: row.organizationId,
          businessId: row.businessId,
          invoice: ctx.inv,
        });
        if (credit.settled) {
          collected++;
          continue;
        }
        let pay: Awaited<ReturnType<typeof collectInvoice>>;
        try {
          pay = await collectInvoice({
            organizationId: row.organizationId,
            businessId: row.businessId,
            invoice: credit.invoice,
            subscription: ctx.sub ?? undefined,
          });
        } catch (e) {
          if (e instanceof CollectionInFlightError) continue;
          throw e;
        }
        if (pay.status === "succeeded") {
          collected++;
        } else if (pay.status === "pending") {
          // In-flight (gateway timeout / async capture): the outcome is UNKNOWN.
          // Do NOT treat it as a failure — the reconciler settles it later.
          // Leave the subscription active; don't flip past_due on a maybe-success.
        } else {
          dueForDunning++;
          // A failed collect at due date can be terminal (non-retriable decline /
          // exhausted schedule). Re-read: if the invoice reached not_paid+exhausted,
          // apply the business's dunning final action (void/write_off + cancel/retain)
          // — otherwise the sub would strand past_due forever (renewal/retry paths
          // apply it; the due path previously did not — review fix).
          const exhausted = await withTenant(row.organizationId, async (tx) => {
            const [inv] = await tx
              .select({ status: invoices.status, dunningStatus: invoices.dunningStatus })
              .from(invoices)
              .where(eq(invoices.id, ctx.inv.id))
              .limit(1);
            return inv ? inv.status === "not_paid" && inv.dunningStatus === "exhausted" : false;
          });
          if (exhausted) {
            const config = await withTenant(row.organizationId, (tx) =>
              loadEffectiveDunningConfig(tx, {
                businessId: row.businessId,
                customerId: ctx.inv.customerId,
                subscriptionId: ctx.inv.subscriptionId,
              }),
            );
            await applyDunningFinalAction({
              organizationId: row.organizationId,
              businessId: row.businessId,
              invoicePublicId: ctx.inv.publicId,
              subscriptionId: ctx.sub?.id ?? null,
              subscriptionPublicId: ctx.sub?.publicId ?? null,
              config,
            });
          }
          // Retriable failure → dunning is in progress on the INVOICE; the
          // subscription stays `active` (there is no past_due sub status — SUB-3).
        }
      } else {
        // ── Offline (auto-collect-off) invoice reaching its due date ─────────────
        //
        // → `payment_due` + `dunning_status: in_progress` + `next_attempt_at` = the
        // first REMINDER instant (see this file's header). No charge is attempted, now or
        // ever: `next_attempt_at` here is a reminder time, and the two passes that
        // would otherwise act on it — `runDunningPass`, `sweepStrandedRetries` — skip
        // auto-collect-off rows for exactly that reason.
        //
        // → `not_paid` only when the business opted OUT (`dun_offline_invoices:
        // false`), or dunning is off / this invoice's class excluded. There the
        // older edge is preserved byte for byte: not_paid, dunning null, no
        // deadline, `invoice_not_paid` emitted.
        //
        // The deadline is NOT armed here any more. It used to be the only thing
        // `next_attempt_at` could hold, which meant a business with no
        // `dunning_period_days` got no dunning at all; enrolment needs no deadline,
        // only EXHAUSTION does. The second scan below re-derives the deadline each
        // time it looks at the row, so a merchant changing the period mid-window is
        // honoured rather than frozen at open time.
        const { config, held } = await withTenant(row.organizationId, async (tx) => {
          const config = await loadEffectiveDunningConfig(tx, {
            businessId: row.businessId,
            customerId: ctx.inv.customerId,
            subscriptionId: ctx.inv.subscriptionId,
          });
          return { config, held: (await dunningHoldFor(tx, ctx.inv, config)) !== null };
        });
        const dunCtx = {
          hasSubscription: ctx.inv.subscriptionId != null,
          subscriptionStatus: ctx.sub?.status ?? null,
        };
        // Excluded customer or below the minimum: the window does not open (same edge as
        // the opt-out).
        const dunned = !held && offlineDunningApplies(config, dunCtx);
        const reminder = dunned
          ? nextOfflineReminderAt(config, dunningAnchor(ctx.inv), now, dunCtx)
          : null;
        // TOCTOU guard: only transition a still-`posted` invoice — a concurrent
        // payment may have already moved it (paid/voided); emit only if we changed it.
        const moved = await withTenant(row.organizationId, async (tx) => {
          const [upd] = await tx
            .update(invoices)
            .set(
              dunned
                ? {
                    status: "payment_due" as const,
                    dunningStatus: "in_progress" as const,
                    nextAttemptAt: reminder,
                  }
                : { status: "not_paid" as const },
            )
            .where(and(eq(invoices.id, ctx.inv.id), eq(invoices.status, "posted")))
            .returning({ id: invoices.id });
          if (!upd) return false;
          if (dunned) {
            // `invoice_payment_due`, which is the event that carries the customer's
            // overdue reminder mail (`emailTypeForEvent` → `invoice_overdue`). That is
            // the whole visible effect of offline dunning: the payer is told, and told
            // again at each reminder instant, instead of the invoice going quietly
            // `not_paid` and nobody hearing about it.
            await emitEvent(tx, {
              organizationId: row.organizationId,
              businessId: row.businessId,
              type: "invoice_payment_due",
              data: buildEventData("invoice_payment_due", {
                id: ctx.inv.publicId,
                next_attempt_at: reminder,
              }),
            });
          } else {
            await emitEvent(tx, {
              organizationId: row.organizationId,
              businessId: row.businessId,
              type: "invoice_not_paid",
              data: buildEventData("invoice_not_paid", { id: ctx.inv.publicId }),
            });
          }
          return true;
        });
        if (moved) {
          if (dunned) offlineDunningOpened++;
          // `notPaid` counts what actually reached `not_paid`, so it no longer
          // double-counts an invoice that merely opened a window.
          else notPaid++;
        }
      }
    } catch (e) {
      // Isolate failures so one invoice can't stall the whole pass — but an invoice
      // that silently fails its due-date transition every tick would otherwise be
      // invisible until a customer asks why they were never charged.
      log.recurringError(`due_pass_invoice_failed:${row.id}`, e, {
        event: "due_pass_invoice_failed",
        invoiceId: row.id,
        businessId: row.businessId,
      });
      errors.push({
        organization: row.organizationId,
        business: row.businessId,
        invoice: row.id,
        step: "invoice_due_transition",
        message: (e as Error)?.message ?? String(e),
      });
    }
  }
  // ── Offline dunning windows: walk the reminders, then close ────────────────
  //
  // Same scan shape as `runDunningPass` (payment_due + in_progress + a due
  // `next_attempt_at`) — because since 2026-08-31 an offline invoice in dunning looks
  // EXACTLY like a retried one, which is the point: the two are reported
  // identically. What tells them apart is auto-collection, re-read per row below.
  //
  // ⚠️ The invariant this replaces is gone, and its replacement is load-bearing. The
  // old comment read: "`next_attempt_at` is the deadline, not a retry time. Safe to
  // reuse: every pass that acts on `next_attempt_at` first requires status
  // `payment_due` or `posted`, and this row is `not_paid`." The row is `payment_due`
  // now, so that shield is void. What keeps a charge from being attempted is that
  // `runDunningPass` and `sweepStrandedRetries` both skip auto-collect-off invoices
  // explicitly. Removing either guard re-introduces the one thing auto-collect-off
  // rules out — a charge — so they are asserted by `verify:dunning-offline`.
  //
  // Still deliberately in THIS pass rather than `runDunningPass`, which exists to
  // retry charges: there is nothing here to retry.
  const offlineDue = await systemDb
    .select({
      id: invoices.id,
      organizationId: invoices.organizationId,
      businessId: invoices.businessId,
      publicId: invoices.publicId,
      customerId: invoices.customerId,
      subscriptionId: invoices.subscriptionId,
      attemptCount: invoices.attemptCount,
    })
    .from(invoices)
    // The joins exist for `autoCollectionOffSql` — see it for why this filter MUST be
    // in the WHERE clause and not applied per row (with the limit below, offline rows
    // otherwise fall off the end of a page full of ordinary dunning rows).
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(subscriptions, eq(subscriptions.id, invoices.subscriptionId))
    .where(
      and(
        eq(invoices.status, "payment_due"),
        eq(invoices.dunningStatus, "in_progress"),
        isNotNull(invoices.nextAttemptAt),
        lte(invoices.nextAttemptAt, now),
        autoCollectionOffSql(),
        // Held rows keep their reminder instant and resume when the hold lifts.
        dunningNotHeldSql(),
        scanBusinessFilter(invoices.businessId),
      ),
    )
    // Oldest reminder first, and bounded, so a backlog drains in the order the debts
    // aged rather than stalling the tick.
    .orderBy(invoices.nextAttemptAt)
    .limit(appConfig.TICK_SCAN_LIMIT);

  for (const row of offlineDue) {
    try {
      // Re-read everything under RLS and re-check every precondition. A window can be
      // opened and then invalidated before it closes: the customer may have paid (the
      // invoice is payable for the whole window — that is the feature), the merchant
      // may have switched auto-collection back ON, or turned the flag or dunning off.
      // Acting on the state we saw at open time would void a paid invoice.
      const ctx = await withTenant(row.organizationId, async (tx) => {
        const [inv] = await tx.select().from(invoices).where(eq(invoices.id, row.id)).limit(1);
        if (
          !inv ||
          inv.status !== "payment_due" ||
          inv.dunningStatus !== "in_progress" ||
          !inv.nextAttemptAt ||
          inv.nextAttemptAt.getTime() > now.getTime()
        )
          return null;
        const [cust] = await tx
          .select({ ac: customers.autoCollection })
          .from(customers)
          .where(eq(customers.id, inv.customerId))
          .limit(1);
        const sub = inv.subscriptionId
          ? ((
              await tx
                .select()
                .from(subscriptions)
                .where(eq(subscriptions.id, inv.subscriptionId))
                .limit(1)
            )[0] ?? null)
          : null;
        const config = await loadEffectiveDunningConfig(tx, {
          businessId: inv.businessId,
          customerId: inv.customerId,
          subscriptionId: inv.subscriptionId,
        });
        return {
          inv,
          custAc: cust?.ac ?? null,
          sub,
          config,
          held: (await dunningHoldFor(tx, inv, config)) !== null,
        };
      });
      if (!ctx || ctx.held) continue;
      // Auto-collection is ON → this is an ordinary dunning retry, not an offline
      // window. `runDunningPass` owns it; touching it here would re-schedule a charge
      // out from under the pass that is about to make it. (This is also the filter
      // that makes the shared scan shape safe in the other direction.)
      if (isAutoCollectOn(ctx.sub?.autoCollection ?? null, ctx.custAc)) continue;
      const dunCtx = {
        hasSubscription: ctx.inv.subscriptionId != null,
        subscriptionStatus: ctx.sub?.status ?? null,
      };
      // Flag/dunning switched off, or the invoice's class excluded, mid-window. Leave
      // the row exactly as it stands: a merchant who turns this off wants the chase to
      // stop, not the invoice voided or re-dated.
      if (!offlineDunningApplies(ctx.config, dunCtx)) continue;

      // `dunningPeriodDays` is still the ONLY thing that can end an offline window —
      // there are no retries to run out of. Null (the default) → the reminders run and
      // the invoice stays payable, which is the same open-ended outcome the opt-out
      // gives, minus the silence. Nothing is ever voided or cancelled without a
      // configured period.
      const deadline = offlineDunningDeadline(ctx.config, dunningAnchor(ctx.inv), dunCtx);
      if (!deadline || deadline.getTime() > now.getTime()) {
        // ── Still inside the window: move on to the next reminder ───────────────
        //
        // Re-derived from the due date rather than counted, because `attempt_count`
        // must stay 0 on an offline invoice (no charge is attempted) and so cannot
        // serve as the ladder index. `nextOfflineReminderAt` returns strictly-future
        // instants only, so this cannot spin through the whole schedule in one tick;
        // null means the last reminder has been sent and, with no deadline, there is
        // nothing further to do — the invoice simply stays payable.
        const reminder = nextOfflineReminderAt(ctx.config, dunningAnchor(ctx.inv), now, dunCtx);
        const advanced = await withTenant(row.organizationId, async (tx) => {
          const [upd] = await tx
            .update(invoices)
            .set({ nextAttemptAt: reminder })
            .where(
              and(
                eq(invoices.id, ctx.inv.id),
                eq(invoices.status, "payment_due"),
                eq(invoices.dunningStatus, "in_progress"),
                isNotNull(invoices.nextAttemptAt),
                lte(invoices.nextAttemptAt, now),
              ),
            )
            .returning({ id: invoices.id });
          if (!upd) return false;
          await emitEvent(tx, {
            organizationId: row.organizationId,
            businessId: row.businessId,
            type: "invoice_payment_due",
            data: buildEventData("invoice_payment_due", {
              id: ctx.inv.publicId,
              next_attempt_at: reminder,
            }),
          });
          return true;
        });
        if (advanced) offlineRemindersSent++;
        continue;
      }

      // ── The window has closed ────────────────────────────────────────────────
      // Mark exhausted BEFORE the final action, and only from `payment_due` +
      // `in_progress` — that compare-and-set is what stops two overlapping ticks both
      // voiding the invoice and both cancelling the subscription. Clearing
      // `next_attempt_at` also takes the row out of this scan for good.
      //
      // `not_paid` + `exhausted` is the same terminal shape a retry-exhausted or a
      // parked-expired invoice reaches, deliberately: a single definition of "dunning
      // ended without the money", so the final action cannot grow a second one.
      const claimed = await withTenant(row.organizationId, async (tx) => {
        const [upd] = await tx
          .update(invoices)
          .set({
            status: "not_paid" as const,
            dunningStatus: "exhausted" as const,
            nextAttemptAt: null,
            // When dunning gave up (0282) — the dated half of the recovery rate.
            dunningExhaustedAt: now,
            // The period closed; no decline ended it.
            dunningExhaustedCode: null,
          })
          .where(
            and(
              eq(invoices.id, ctx.inv.id),
              eq(invoices.status, "payment_due"),
              eq(invoices.dunningStatus, "in_progress"),
            ),
          )
          .returning({ id: invoices.id });
        if (!upd) return false;
        // Both events, matching `sweepExpiredParkedDunning`. The invoice only becomes
        // `not_paid` HERE now, so this is where `invoice_not_paid` belongs — the due
        // date no longer announces a transition it no longer makes.
        await emitEvent(tx, {
          organizationId: row.organizationId,
          businessId: row.businessId,
          type: "invoice_dunning_exhausted",
          data: buildEventData("invoice_dunning_exhausted", {
            id: ctx.inv.publicId,
            attempts: row.attemptCount,
          }),
        });
        await emitEvent(tx, {
          organizationId: row.organizationId,
          businessId: row.businessId,
          type: "invoice_not_paid",
          data: buildEventData("invoice_not_paid", { id: ctx.inv.publicId }),
        });
        return true;
      });
      if (!claimed) continue;

      // The same final action the failed-charge paths use, so an operator's
      // "At the end of the dunning period" setting means one thing everywhere.
      // `applyDunningFinalAction` re-reads the invoice and skips the subscription
      // action if a concurrent payment settled it.
      await applyDunningFinalAction({
        organizationId: row.organizationId,
        businessId: row.businessId,
        invoicePublicId: ctx.inv.publicId,
        subscriptionId: ctx.sub?.id ?? null,
        subscriptionPublicId: ctx.sub?.publicId ?? null,
        config: ctx.config,
      });
      offlineDunningExhausted++;
    } catch (e) {
      log.recurringError(`offline_dunning_expiry_failed:${row.id}`, e, {
        event: "offline_dunning_expiry_failed",
        invoiceId: row.id,
        businessId: row.businessId,
      });
      errors.push({
        organization: row.organizationId,
        business: row.businessId,
        invoice: row.id,
        step: "offline_dunning_expiry",
        message: (e as Error)?.message ?? String(e),
      });
    }
  }

  return {
    transitioned,
    collected,
    notPaid,
    dueForDunning,
    offlineDunningOpened,
    offlineRemindersSent,
    offlineDunningExhausted,
    errors,
  };
}
