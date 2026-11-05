import { and, desc, eq, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { loadEffectiveDunningConfig } from "@/modules/dunning-policies/effective";
import { afterCommit, systemDb, withTenant, type Tx } from "@/platform/db";
import {
  collectInvoice,
  CollectionInFlightError,
  autoCollectionOnSql,
  dunningHoldFor,
  dunningNotHeldSql,
} from "@/modules/invoicing/service";
import { chargeOrder, resolveChargeCandidates } from "@/modules/invoicing/collection";
import { firstPresentable } from "@/modules/invoicing/representment";
import {
  voidInvoice,
  writeOffInvoice,
  reverseInvoice,
  InvoiceOpsError,
} from "@/modules/invoicing/ops";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import {
  dunningAppliesTo,
  parkedDunningDeadline,
  nextParkedReminderAt,
  retryDaysForMethod,
  type DunningConfig,
} from "./dunning-schedule";
import { recomputeSubscriptionMrr } from "./service";
import { HOLD_FOR_NEW_CARD } from "./decline-policy";
import { storedPayerDeclineMessage } from "./decline-overrides";
import {
  invoices,
  subscriptions,
  businesses,
  customers,
  payments,
  paymentMethods,
} from "@db/schema";
import { businessNow, currentClockScope, scanBusinessFilter, stampNow } from "@/platform/clock";
import { config as appConfig } from "@/platform/config";
import { createLogger } from "@/platform/logger";
import { getTraceId } from "@/platform/trace";
import type { TickError } from "@/modules/subscriptions/renewal";
import { decidePaymentSourceExpiry } from "@/modules/payment-methods/sweep";
import { frozenStopBooking } from "@/modules/metrics/stocks";
import {
  MANDATE_REVOKED_CODES,
  loadBillingRulesRow,
  resolveBillingRulesConfig,
} from "./billing-rules-config";

const log = createLogger("dunning");

/**
 * Apply a business's configured dunning FINAL ACTION when retries are exhausted
 * (E3/INV-3 + SUB-7). The invoice action overrides the base `not_paid` set by the
 * failed-charge path; the subscription action may CANCEL it or RETAIN it (the
 * subscription can now survive exhaustion). Runs its own transactions (void /
 * write-off open theirs).
 */
/**
 * Does this customer have a CARD on file, for the purpose of the `no_card` cancel reason?
 *
 * Extracted so it can be asserted directly (`test/unit/dunning-no-card-reason.test.ts`). The
 * behaviour it guards is NOT reachable end-to-end today — see the note at its call site — so a
 * fixture cannot make it go red, and an inline predicate no test can reach is how the bug it
 * fixes got in.
 */
export function hasCardOnFileForReason(
  pms: Array<{ expMonth: number | null; expYear: number | null; mandateExpiresAt: Date | null }>,
  asOf: Date,
): boolean {
  return pms.some((pm) => {
    const d = decidePaymentSourceExpiry(pm, asOf);
    return !(d.next === "expired" && d.reason === "card");
  });
}

export async function applyDunningFinalAction(input: {
  organizationId: string;
  businessId: string;
  invoicePublicId: string;
  subscriptionId: string | null;
  subscriptionPublicId: string | null;
  config: DunningConfig;
}): Promise<void> {
  const { organizationId, businessId, config } = input;
  // Invoice: not_paid (already set) | void (reverse ledger) | write_off (bad debt / CN).
  try {
    if (config.finalAction.invoice === "void")
      await voidInvoice(organizationId, businessId, input.invoicePublicId);
    else if (config.finalAction.invoice === "write_off")
      await writeOffInvoice(organizationId, businessId, input.invoicePublicId);
    // "Reverse the Invoice": settled as paid via an order-cancellation CN.
    else if (config.finalAction.invoice === "reverse")
      await reverseInvoice(organizationId, businessId, input.invoicePublicId);
  } catch (e) {
    // A concurrent settle may have already moved the invoice out of an open state.
    if (!(e instanceof InvoiceOpsError)) throw e;
  }
  // Re-read the invoice: if a concurrent payment collected it (paid and NOT a
  // write-off), the debt is settled — the void/write-off was correctly swallowed
  // above and we must NOT cancel the subscription (review fix).
  const collected = await withTenant(organizationId, async (tx) => {
    const [inv] = await tx
      .select({ status: invoices.status, writtenOff: invoices.writtenOff })
      .from(invoices)
      .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, input.invoicePublicId)))
      .limit(1);
    if (!inv) return false;
    // 'reverse' deliberately leaves the invoice paid-and-not-written-off, which is
    // indistinguishable from a concurrent payment by this check — but it is OUR
    // doing, not a customer settling up, so it must NOT suppress the subscription
    // action. Only the other three actions can be pre-empted by a real payment.
    if (config.finalAction.invoice === "reverse") return false;
    return inv.status === "paid" && !inv.writtenOff;
  });
  if (collected) return;
  // A revoked mandate can override the subscription half (billing_rules_config).
  const revoked = input.subscriptionId
    ? await mandateRevokedOverride(organizationId, businessId, input.invoicePublicId)
    : null;
  if (revoked === "cancel_at_term_end" || revoked === "pause") {
    const handled = await applyMandateRevokedAction(
      organizationId,
      businessId,
      input.subscriptionId!,
      revoked,
    );
    // Not handled (the subscription is not active): the configured end action applies.
    if (handled) return;
  }
  let subscriptionAction = revoked === "cancel_now" ? "cancel" : config.finalAction.subscription;
  // 2.17: the business's own end action. Term-end and pause need an active subscription;
  // anything else (a trial, a failure) falls back to cancelling now.
  if (input.subscriptionId) {
    if (subscriptionAction === "cancel_at_term_end" || subscriptionAction === "pause") {
      const handled = await applyMandateRevokedAction(
        organizationId,
        businessId,
        input.subscriptionId,
        subscriptionAction,
      );
      if (handled) return;
      subscriptionAction = "cancel";
    } else if (subscriptionAction === "stop_charging") {
      await stopAutoCollection(organizationId, businessId, input.subscriptionId);
      return;
    }
  }
  // Subscription: cancel (historical default) | retain (SUB-7 — survives exhaustion).
  if (input.subscriptionId && subscriptionAction === "cancel") {
    await withTenant(organizationId, async (tx) => {
      /**
       * "Cancelled – No Card" means no payment instrument was on file to
       * charge; a card that WAS on file but declined is a payment failure. So `no_card` only
       * when the customer has no non-expired CARD. A present-but-`invalid` card — e.g. one
       * that hard-declined — is a charge failure → `not_paid`, not `no_card`.
       *
       * ── AND `status` CANNOT ANSWER THAT ANY MORE (fixed 2026-09-02) ────────────────────
       * This read `status !== "expired"`, which was right when it was written and stopped
       * being right when `payment_methods.status` gained a second meaning. The C6 sweep sets
       * `expired` for EITHER cause — `decidePaymentSourceExpiry` returns
       * `reason: "card" | "mandate"` precisely because one column now carries both — so a
       * customer with a Visa valid to 2099 whose MANDATE lapsed read as having no card, and
       * dunning cancelled them "Cancelled – No Card". A merchant auditing that against the
       * card on file cannot reconcile it, and three separate readers queried it before anyone
       * traced it. Drift, not a decision: the comment dates to 07-21 and the filter to 08-29,
       * both BEFORE `79c37cb7` widened what `expired` means.
       *
       * So ask the SWEEP's own decider instead of re-reading its output. A row stops counting
       * as a card on file only when the PRINTED expiry has passed (`reason === "card"`); a
       * lapsed mandate leaves the card on file and the reason is `not_paid`, which is simply
       * true. Sharing the decider is the point — a second copy of "is this expired" is how the
       * first one drifted. The mandate fact already has its own channel in
       * `payment_source_expired` with `expiry_reason: 'mandate'`, so a cancellation reason does
       * not need to restate it. Inventing a new one would break the reason enum for every
       * existing consumer.
       *
       * ⚠️ AND THE SYMPTOM IS NOT REACHABLE HERE TODAY — measured 2026-09-02, stated so nobody
       * "verifies" this with a fixture and concludes the fix did nothing. A mandate-expired
       * instrument does not reach a cancellation at all: dunning exhausts its attempts and
       * PARKS (`inv=payment_due attempts=9 nextAttemptAt=null`), so no reason is derived. The
       * old `status !== "expired"` read was still wrong — `status` carries two meanings — and
       * this makes it right, but the reported "dunning cancels them no_card" does not occur on
       * this path. `verify:dunning` § I asserts the PARK, which is the real behaviour, and
       * `test/unit/dunning-no-card-reason.test.ts` asserts the predicate directly, because a
       * fixture cannot make an unreachable branch go red.
       */
      const [subRow] = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, input.subscriptionId!))
        .limit(1);
      let reason: "no_card" | "not_paid" = "not_paid";
      if (subRow) {
        const pms = await tx
          .select({
            expMonth: paymentMethods.expMonth,
            expYear: paymentMethods.expYear,
            mandateExpiresAt: paymentMethods.mandateExpiresAt,
          })
          .from(paymentMethods)
          .where(eq(paymentMethods.customerId, subRow.customerId));
        if (!hasCardOnFileForReason(pms, businessNow(businessId))) reason = "no_card";
      }
      // Guard on status <> canceled so a duplicate pass can't re-cancel and
      // re-emit subscription.canceled.
      // Both ways of holding a PENDING cancellation are cleared alongside the status, same as
      // every other terminal path: a subscription dunning killed mid-term may well also have
      // had a cancellation scheduled, and leaving either set makes the dead row advertise a
      // future cancellation and render a "Remove scheduled cancellation" button that throws.
      // `remainingBillingCycles` is left alone — see `cancelSubscription`.
      // Business clock, not wall clock: under Time Travel (or a late tick) the churn
      // must land on the day dunning gave up — `mrr_movements` cannot be corrected later.
      const cancelledAt = businessNow(businessId);
      const [c] = await tx
        .update(subscriptions)
        .set({
          status: "cancelled",
          canceledAt: cancelledAt,
          cancelReason: reason,
          cancelAtPeriodEnd: false,
          cancelScheduledAt: null,
          cancelBookedAt: subRow ? frozenStopBooking(subRow, cancelledAt) : null,
        })
        .where(
          and(eq(subscriptions.id, input.subscriptionId!), ne(subscriptions.status, "cancelled")),
        )
        .returning();
      if (!c) return;
      // Cancelled → cached mrr 0, same rule as every other cancel path (see
      // cancelSubscription). Involuntary churn is the case where a stale rate is
      // most misleading: the revenue is exactly what dunning just lost.
      await recomputeSubscriptionMrr(tx, c.id, cancelledAt);
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "subscription_canceled",
        // 'cancelled', not 'canceled' — the stored enum and every other emitter of
        // this event use the double-l spelling. This one shipped the American form,
        // so a webhook consumer switching on `status` mishandled exactly the
        // dunning-driven cancellations (involuntary churn) it most wants to catch.
        data: buildEventData(
          "subscription_canceled",
          { id: input.subscriptionPublicId ?? c.publicId, status: "cancelled", reason },
          c.resourceVersion,
        ),
      });
    });
  }
}

/**
 * After an asynchronous failure (settlement, a webhook reversal) exhausts an invoice on a
 * revoked mandate: run the end action once the caller's transaction commits, as the sync
 * path does. Only when `mandate_revoked` names a subscription action — `follow_dunning`
 * keeps today's async behaviour, which applies no end action there.
 */
export function scheduleRevokedMandateAction(input: {
  organizationId: string;
  businessId: string;
  invoicePublicId: string;
  subscriptionId: string | null;
  code: string | null;
  rule: string;
  config: DunningConfig;
}): void {
  if (!input.subscriptionId || !input.code || !MANDATE_REVOKED_CODES.has(input.code)) return;
  if (!["cancel_now", "cancel_at_term_end", "pause"].includes(input.rule)) return;
  const run = () =>
    applyDunningFinalAction({
      organizationId: input.organizationId,
      businessId: input.businessId,
      invoicePublicId: input.invoicePublicId,
      subscriptionId: input.subscriptionId,
      subscriptionPublicId: null,
      config: input.config,
    });
  if (!afterCommit(run))
    log.error("revoked-mandate end action has no transaction to follow; not applied", {
      invoice: input.invoicePublicId,
    });
}

/**
 * The `mandate_revoked` action when the decline that exhausted the invoice was a revoked
 * mandate; null when it was not, or when the rule leaves the end action alone
 * (`follow_dunning`, and `request_new_mandate`, whose park ends at the dunning deadline).
 */
async function mandateRevokedOverride(
  organizationId: string,
  businessId: string,
  invoicePublicId: string,
): Promise<"cancel_now" | "cancel_at_term_end" | "pause" | null> {
  return withTenant(organizationId, async (tx) => {
    // The decline that exhausted dunning, as its writer recorded it — not the newest
    // failed row, which can be a superseded backup booked after the governing decline.
    const [inv] = await tx
      .select({ code: invoices.dunningExhaustedCode, status: invoices.dunningStatus })
      .from(invoices)
      .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, invoicePublicId)))
      .limit(1);
    if (inv?.status !== "exhausted" || !inv.code || !MANDATE_REVOKED_CODES.has(inv.code))
      return null;
    const rule = resolveBillingRulesConfig(
      await loadBillingRulesRow(organizationId, businessId, tx),
    ).mandateRevoked;
    return rule === "cancel_now" || rule === "cancel_at_term_end" || rule === "pause" ? rule : null;
  });
}

/**
 * Cancel at term end, or pause now. False when the subscription is not active (nothing to
 * schedule or pause), so the caller falls back to the configured end action.
 */
async function applyMandateRevokedAction(
  organizationId: string,
  businessId: string,
  subscriptionId: string,
  action: "cancel_at_term_end" | "pause",
): Promise<boolean> {
  const [sub] = await withTenant(organizationId, (tx) =>
    tx
      .select({
        status: subscriptions.status,
        atEnd: subscriptions.cancelAtPeriodEnd,
        periodEnd: subscriptions.currentPeriodEnd,
        cancelScheduledAt: subscriptions.cancelScheduledAt,
      })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1),
  );
  // Already done (a second writer reached the same exhaustion), or nothing left to do.
  if (sub?.status === "cancelled") return true;
  if (action === "pause" && sub?.status === "paused") return true;
  if (action === "cancel_at_term_end" && sub?.status === "active" && sub.atEnd) return true;
  if (sub?.status !== "active") return false;
  const now = businessNow(businessId);
  // Never pause a subscription that is already set to cancel: let the scheduled cancel
  // stand, or cancel now (false → the caller cancels) when its end has passed.
  if (action === "pause" && (sub.atEnd || sub.cancelScheduledAt)) {
    const end = sub.cancelScheduledAt ?? sub.periodEnd;
    return end != null && end.getTime() > now.getTime();
  }
  try {
    if (action === "cancel_at_term_end") {
      const { cancelSubscription } = await import("./service");
      await cancelSubscription({
        organizationId,
        businessId,
        subscriptionId,
        atPeriodEnd: true,
        now,
        cancelReason: "not_paid",
      });
    } else {
      const { pauseSubscriptionWithOptions } = await import("./service");
      await pauseSubscriptionWithOptions({
        organizationId,
        businessId,
        subscriptionId,
        now,
        pauseOption: "immediately",
      });
    }
    return true;
  } catch (e) {
    log.warn("revoked-mandate action failed; the dunning end action applies", {
      subscription: subscriptionId,
      action,
      error: (e as Error)?.message,
    });
    return false;
  }
}

/**
 * End action `stop_charging` (2.17): keep the subscription and turn its auto-collection off,
 * so later invoices are raised as send-invoice bills and never charged.
 */
async function stopAutoCollection(
  organizationId: string,
  businessId: string,
  subscriptionId: string,
): Promise<void> {
  await withTenant(organizationId, async (tx) => {
    const [s] = await tx
      .update(subscriptions)
      .set({ autoCollection: "off" })
      .where(
        and(
          eq(subscriptions.id, subscriptionId),
          ne(subscriptions.status, "cancelled"),
          sql`${subscriptions.autoCollection} is distinct from 'off'`,
        ),
      )
      .returning();
    if (!s) return;
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "subscription_changed",
      data: buildEventData(
        "subscription_changed",
        { id: s.publicId, status: s.status, auto_collection: "off" },
        s.resourceVersion,
      ),
    });
  });
}

/**
 * ── Every scan in this file excludes AUTO-COLLECT-OFF invoices (2026-08-31) ───
 *
 * An offline invoice in dunning is now indistinguishable, by columns, from one being
 * retried: both are `payment_due` + `dunning_status: 'in_progress'` with a
 * `next_attempt_at`. That is deliberate. For an offline invoice `next_attempt_at` is a
 * REMINDER instant, walked forward by `runInvoiceDueTransitions`, and nothing may ever
 * charge it.
 *
 * Before that change the shield was structural: an offline invoice was `not_paid`, and
 * every pass here requires `payment_due`. It is now `autoCollectionOnSql()` in each
 * scan's WHERE clause instead (a per-row check is not equivalent — see that function).
 * Remove it and the first reminder becomes a real charge on a customer who was
 * promised none. `verify:dunning-offline` case 10b drives both passes to prove it.
 */

/** The dunning config this invoice runs (customer policy, plan policy, else the business's). */
async function loadDunningConfig(
  tx: Tx,
  businessId: string,
  customerId: string | null | undefined,
  subscriptionId?: string | null,
): Promise<DunningConfig> {
  return loadEffectiveDunningConfig(tx, { businessId, customerId, subscriptionId });
}

/**
 * One dunning pass (driven by the billing clock): find unpaid invoices whose next
 * retry is due and re-attempt collection.
 *  - success → invoice paid (by collectInvoice) + subscription back to active,
 *  - failure → collectInvoice reschedules the next retry (or null = exhausted),
 *  - exhausted → invoice uncollectible + subscription canceled.
 *
 * System-wide across orgs (the clock is global); each invoice is collected in its
 * own org's RLS context inside collectInvoice.
 */
export async function runDunningPass(
  now: Date,
): Promise<{ retried: number; recovered: number; canceled: number; errors: TickError[] }> {
  const errors: TickError[] = [];
  // Batch numbering: hand due retries to the collect workers' pump instead of charging them
  // one by one here. Serially, a decline wave (11% of a 1M-renewal peak) held this pass, and
  // with it the clock tick and every renewal behind it, for hours (D4). A scoped tick (Time
  // Travel, verify suites) still retries inline.
  if (appConfig.RENEWAL_BATCH_NUMBERING === "TRUE" && !currentClockScope()?.onlyBusinessId) {
    await systemDb.execute(sql`
      update invoices set collect_due_at = now(), collect_trace_id = ${getTraceId() ?? null}
      where id in (
        select invoices.id from invoices
        join customers on customers.id = invoices.customer_id
        left join subscriptions on subscriptions.id = invoices.subscription_id
        where invoices.status = 'payment_due' and invoices.next_attempt_at <= ${now.toISOString()}::timestamptz
          and invoices.collect_due_at is null and ${autoCollectionOnSql()}
          and ${dunningNotHeldSql()}
          and ${scanBusinessFilter(invoices.businessId) ?? sql`true`})`);
    return { retried: 0, recovered: 0, canceled: 0, errors };
  }
  const due = await systemDb
    .select({
      id: invoices.id,
      organizationId: invoices.organizationId,
      businessId: invoices.businessId,
      customerId: invoices.customerId,
      subscriptionId: invoices.subscriptionId,
    })
    .from(invoices)
    // The joins exist for `autoCollectionOnSql` — never retry a send-invoice bill.
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(subscriptions, eq(subscriptions.id, invoices.subscriptionId))
    .where(
      and(
        eq(invoices.status, "payment_due"),
        isNotNull(invoices.nextAttemptAt),
        lte(invoices.nextAttemptAt, now),
        autoCollectionOnSql(),
        // Excluded customer / below the minimum: the row keeps its retry instant, which
        // runs on the first pass after the hold lifts (as `resumeDunning` restores one).
        dunningNotHeldSql(),
        scanBusinessFilter(invoices.businessId),
      ),
    );

  let retried = 0;
  let recovered = 0;
  let canceled = 0;

  for (const row of due) {
    try {
      const outcome = await retryDueInvoice(row, now);
      if (outcome === null) continue;
      retried++;
      if (outcome === "recovered") recovered++;
      if (outcome === "canceled") canceled++;
    } catch (e) {
      // Isolate failures so one invoice can't stall the whole pass. An invoice that
      // throws on every retry never advances its dunning state and never reaches
      // `exhausted`, so nothing else would ever surface it — hence the `errors.push`
      // below, which is also what makes it safe to log this one only once an hour.
      log.recurringError(`dunning_retry_failed:${row.id}`, e, {
        event: "dunning_retry_failed",
        invoiceId: row.id,
        subscriptionId: row.subscriptionId,
      });
      errors.push({
        organization: row.organizationId,
        business: row.businessId,
        invoice: row.id,
        ...(row.subscriptionId ? { subscription: row.subscriptionId } : {}),
        step: "dunning_retry",
        message: (e as Error)?.message ?? String(e),
      });
    }
  }
  return { retried, recovered, canceled, errors };
}

/**
 * One dunning retry, as the pass runs it. Null when the business has one-off dunning off,
 * or the invoice is held (excluded customer, below the minimum).
 */
export async function retryDueInvoice(
  row: { id: string; organizationId: string; businessId: string; subscriptionId: string | null },
  now: Date,
): Promise<Awaited<ReturnType<typeof retryInvoice>> | null> {
  const { cfg, held } = await withTenant(row.organizationId, async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, row.id)).limit(1);
    const cfg = await loadDunningConfig(tx, row.businessId, inv?.customerId, inv?.subscriptionId);
    return { cfg, held: inv ? (await dunningHoldFor(tx, inv, cfg)) !== null : false };
  });
  // Checked before the claim, so a held row keeps its `next_attempt_at`.
  if (held) return null;
  // Dunning for one-time invoices. An invoice with no
  // subscription behind it is only retried when the business opted in — the
  // failure site already gates on the same flag, but a merchant can switch it
  // off mid-dunning and in-flight one-off invoices must stop too.
  if (!row.subscriptionId && (!cfg.enabled || !cfg.dunOneTimeInvoices)) return null;
  return retryInvoice(row.organizationId, row.businessId, row.id, row.subscriptionId, now);
}

/**
 * Sweep stranded dunning claims (review fix). `retryInvoice` claims a row by nulling
 * `next_attempt_at`; a crash between the claim and the collect outcome leaves the
 * invoice `payment_due` + `dunning_status='in_progress'` with no scheduled retry, so
 * the dunning scan (`next_attempt_at IS NOT NULL`) skips it forever. Re-arm those —
 * but NOT ones with an in-flight (pending) payment, which is a legitimate gateway
 * park, not a stranded claim. Runs at the START of the tick (before runDunningPass),
 * so a re-armed invoice is retried the same tick.
 */
export async function sweepStrandedRetries(
  now: Date,
): Promise<{ rearmed: number; errors: TickError[] }> {
  const errors: TickError[] = [];
  const stranded = await systemDb
    .select({ id: invoices.id, organizationId: invoices.organizationId })
    .from(invoices)
    // See `autoCollectionOnSql`. An AUTO-COLLECT-OFF invoice at `payment_due` +
    // `in_progress` + `next_attempt_at IS NULL` is NOT a stranded claim: it is an
    // offline invoice that has sent its last reminder (no dunning period configured,
    // so the window never closes — see `dunOfflineInvoices`). Re-arming it would hand
    // it to `runDunningPass` and charge a customer who was promised no charge.
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(subscriptions, eq(subscriptions.id, invoices.subscriptionId))
    .where(
      and(
        eq(invoices.status, "payment_due"),
        isNull(invoices.nextAttemptAt),
        eq(invoices.dunningStatus, "in_progress"),
        autoCollectionOnSql(),
        // An automatic top-up's purchase invoice is never re-armed (its run owns it).
        sql`${invoices.purpose} is distinct from 'credit_purchase'`,
        scanBusinessFilter(invoices.businessId),
      ),
    );
  let rearmed = 0;
  for (const row of stranded) {
    try {
      const done = await withTenant(row.organizationId, async (tx) => {
        const [pending] = await tx
          .select({ id: payments.id })
          .from(payments)
          .where(and(eq(payments.invoiceId, row.id), eq(payments.status, "pending")))
          .limit(1);
        if (pending) return false;
        const [r] = await tx
          .update(invoices)
          .set({ nextAttemptAt: now })
          .where(
            and(
              eq(invoices.id, row.id),
              eq(invoices.status, "payment_due"),
              isNull(invoices.nextAttemptAt),
              eq(invoices.dunningStatus, "in_progress"),
            ),
          )
          .returning({ id: invoices.id });
        return !!r;
      });
      if (done) rearmed++;
    } catch (e) {
      log.recurringError(`dunning_rearm_failed:${row.id}`, e, {
        event: "dunning_rearm_failed",
        invoiceId: row.id,
      });
      errors.push({
        organization: row.organizationId,
        invoice: row.id,
        step: "dunning_rearm",
        message: (e as Error)?.message ?? String(e),
      });
    }
  }
  return { rearmed, errors };
}

/**
 * Close the dunning window on PARKED invoices whose deadline has passed.
 *
 * ── Why this pass has to exist ────────────────────────────────────────────────
 * `planFailureRearm` returns `parked` for a refusal that is not a payment-method
 * decline, which sets `next_attempt_at = null` and `dunning_status = 'parked'`. The
 * name suggests dunning-without-retries. It is not: `runDunningPass` scans
 * `WHERE next_attempt_at IS NOT NULL`, so from that moment **nothing in the clock
 * ever looks at the row again** — the dunning period does not end, the final action
 * never fires, and the subscription stays active on an invoice nobody is collecting.
 * Measured 2026-08-28 on an `afa_not_completed` invoice: parked on day 0, still
 * parked and still serving with no scheduled anything.
 *
 * This pass gives EVERY park a real deadline (`parkedDunningDeadline` — the
 * business's dunning period, or `PARKED_GRACE_DAYS` when it has configured none,
 * which is the usual case), so "pay in the portal before dunning finishes" describes
 * something that actually finishes.
 *
 * Until 2026-09-04 it gated on `PARKED_WITH_DEADLINE`, an allowlist of the declines a
 * customer can clear, on the reasoning that cancelling over a MERCHANT-side blocker
 * punishes the payer for our bug. The allowlist reached 4 of `PARK`'s 13 codes and
 * `expired_card` was not among them — the textbook dunning case, parked forever. It
 * had been grown one code at a time and never swept, and 50 of 52 parked invoices on
 * a real database could never close, the oldest for 13 months.
 *
 * The decision (the user, 2026-09-04) is that a park is a dunning state and every
 * dunning state ends. Whether closing CANCELS is still the merchant's, expressed
 * where it belongs: `finalAction.subscription`. A merchant-side park now raises an
 * ops alert (`MERCHANT_SIDE_PARK`) so the misconfiguration is visible to a human
 * well before the window shuts.
 *
 * ── ONE attempt, ON the deadline, and nothing before it ──────────────────────
 * This pass used to charge nothing at all, on the reasoning that re-presenting a parked
 * debit is pointless. That is right for every day of the window and wrong on its last
 * one, which is the same distinction `scheduleTail` already draws for a retried invoice:
 * nothing is retried DURING the period, then one attempt at the end, then the final
 * action. Fixed mode has had that attempt since the dunning period shipped — a park with
 * a configured period is armed by `planFailureRearm` as a retry at the deadline. Smart
 * mode never reaches that branch (it returns `parked` before the schedule is consulted,
 * deliberately — see its docblock), so a smart-mode business got the window and not the
 * attempt. So did a fixed-mode park on a business with no period configured, which is
 * most of them.
 *
 * The attempt is not futile, and the codes say why. `recurring_not_enabled` and
 * `gateway_limit_exceeded` are fixed by the MERCHANT at the gateway and nothing else
 * would ever trigger a re-collect. `mandate_cycle_limit_exceeded` self-clears when the
 * cycle rolls over, which by the deadline it usually has. A declined or expired card may
 * have been repaired at the issuer without the customer touching our portal.
 * No card over its attempt caps is charged (`representment.ts`): networks fine that.
 *
 * A collected invoice leaves dunning the ordinary way (`collectInvoice` books the
 * payment and settles it), so the terminal path below runs only on a failure or a
 * refusal to try — using the SAME shape (`not_paid` + `dunning_status = 'exhausted'`)
 * and the SAME `applyDunningFinalAction` a retry-exhausted invoice reaches. A parked
 * expiry and a retry exhaustion must be indistinguishable downstream, or the final
 * action grows a second definition.
 */
export async function sweepExpiredParkedDunning(now: Date): Promise<{
  examined: number;
  /** Deadline charges actually presented — `examined` minus cards that may not be presented. */
  attempted: number;
  exhausted: number;
  canceled: number;
  errors: TickError[];
}> {
  const out = { examined: 0, attempted: 0, exhausted: 0, canceled: 0, errors: [] as TickError[] };
  const parked = await systemDb
    .select({
      id: invoices.id,
      publicId: invoices.publicId,
      organizationId: invoices.organizationId,
      businessId: invoices.businessId,
      subscriptionId: invoices.subscriptionId,
      dueDate: invoices.dueDate,
      createdAt: invoices.createdAt,
      dunningParkedAt: invoices.dunningParkedAt,
      attemptCount: invoices.attemptCount,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.status, "payment_due"),
        eq(invoices.dunningStatus, "parked"),
        isNull(invoices.nextAttemptAt),
        dunningNotHeldSql(),
        scanBusinessFilter(invoices.businessId),
      ),
    )
    // Oldest park first, so a backlog drains in the order the windows opened
    // (0232: the park is the anchor, so it is also the right sort key).
    .orderBy(invoices.dunningParkedAt)
    .limit(appConfig.TICK_SCAN_LIMIT);

  for (const row of parked) {
    try {
      const ctx = await withTenant(row.organizationId, async (tx) => {
        /**
         * WHY this invoice is parked. `dunning_status` records the state and not the
         * reason, and the reason no longer gates the deadline (every park gets one)
         * — it is kept for the log line, which is how a merchant-side park is told
         * apart from a customer-clearable one after the fact. Newest failed payment,
         * because that is the attempt that parked it.
         */
        const [pay] = await tx
          .select({
            // A reversal's decline is `reversal_code`; its `failure_code` is `late_failure`.
            code: sql<string | null>`coalesce(${payments.reversalCode}, ${payments.failureCode})`,
            pmId: payments.paymentMethodId,
          })
          .from(payments)
          .where(and(eq(payments.invoiceId, row.id), eq(payments.status, "failed")))
          .orderBy(desc(payments.createdAt))
          .limit(1);
        const sub = row.subscriptionId
          ? ((
              await tx
                .select({ publicId: subscriptions.publicId, status: subscriptions.status })
                .from(subscriptions)
                .where(eq(subscriptions.id, row.subscriptionId))
                .limit(1)
            )[0] ?? null)
          : null;
        const [inv] = await tx.select().from(invoices).where(eq(invoices.id, row.id)).limit(1);
        const cfg = await loadDunningConfig(
          tx,
          row.businessId,
          inv?.customerId,
          inv?.subscriptionId,
        );
        return {
          code: pay?.code ?? null,
          failedPmId: pay?.pmId ?? null,
          sub,
          cfg,
          held: inv ? (await dunningHoldFor(tx, inv, cfg)) !== null : false,
        };
      });
      // A business that has switched dunning off — or excluded this invoice's class —
      // must not get a cancellation through this side door either. Nor a held invoice.
      if (
        ctx.held ||
        !dunningAppliesTo(ctx.cfg, {
          hasSubscription: row.subscriptionId != null,
          subscriptionStatus: ctx.sub?.status ?? null,
        })
      )
        continue;
      // Always a real date — see `parkedDunningDeadline` for why "no configured
      // dunning period" must not mean "no deadline" here, and what it falls back to.
      // Anchored on the PARK (0232), not the due date: the window measures how long
      // the customer has to clear the refusal, and that starts when it was refused.
      const deadline = parkedDunningDeadline(
        ctx.cfg,
        row.dunningParkedAt ?? row.dueDate ?? row.createdAt,
      );
      if (now.getTime() < deadline.getTime()) continue;
      out.examined++;

      /**
       * ── The deadline attempt ─────────────────────────────────────────────────
       *
       * See this function's docblock for why a park gets exactly one charge, and only
       * on its last day. No claim is taken here: `collectInvoice` takes its own
       * (`claimCollection`, before any guard reads anything), so two overlapping ticks
       * cannot both charge — the loser throws `CollectionInFlightError`, which every
       * other pass treats as "someone else owns this invoice", and so does this one.
       *
       * The outcome is not inspected. Whatever happens, the invoice's own writers have
       * already recorded it: a success settles the invoice and the guarded close below
       * finds nothing to do; a failure runs `recordFailedPayment` → `planFailureRearm`,
       * which either re-parks (and the close proceeds) or — if the refusal has CHANGED
       * class, because the merchant fixed the gateway and the card is now merely short
       * of funds — re-arms the ordinary retry ladder, at which point the row is no
       * longer `parked` and the close correctly does nothing. Reading the outcome here
       * and acting on it would be a second definition of what a failed charge means.
       */
      let attemptedNow = false;
      {
        try {
          const live = await withTenant(row.organizationId, async (tx) => {
            const [inv] = await tx.select().from(invoices).where(eq(invoices.id, row.id)).limit(1);
            if (!inv) return null;
            if (!row.subscriptionId) return { inv, sub: null };
            const [sub] = await tx
              .select()
              .from(subscriptions)
              .where(eq(subscriptions.id, row.subscriptionId))
              .limit(1);
            return { inv, sub: sub ?? null };
          });
          // Credit on file before the card, as every collection path does.
          const credit = live
            ? await (
                await import("@/modules/customers/collect")
              ).applyCreditBeforeCharge({
                organizationId: row.organizationId,
                businessId: row.businessId,
                invoice: live.inv,
              })
            : null;
          if (live && credit) live.inv = credit.invoice;
          // The deadline attempt only on a card that may be presented: none after a
          // do-not-retry decline unless the card changed or a new one was added, and none
          // over the per-card caps (`representment.ts`). Otherwise the window closes
          // without a charge.
          const presentable =
            live && !credit?.settled
              ? await firstPresentable({
                  organizationId: row.organizationId,
                  candidates: chargeOrder(
                    await resolveChargeCandidates({
                      organizationId: row.organizationId,
                      customerId: live.inv.customerId,
                      subscription: live.sub ?? undefined,
                      currency: live.inv.currency,
                    }),
                  ),
                  now,
                  applyCaps: true,
                  invoiceId: row.id,
                })
              : null;
          // A lost / stolen / seized card, or a revoked mandate, is never charged again;
          // only a new one is.
          const deadCode = (ctx.code ?? "").toLowerCase();
          const deadCard =
            (HOLD_FOR_NEW_CARD.has(deadCode) || MANDATE_REVOKED_CODES.has(deadCode)) &&
            presentable?.pm?.id === ctx.failedPmId;
          if (live && presentable?.pm && !presentable.capped && !deadCard) {
            await collectInvoice({
              organizationId: row.organizationId,
              businessId: row.businessId,
              invoice: live.inv,
              subscription: live.sub ?? undefined,
            });
            out.attempted++;
            attemptedNow = true;
          }
        } catch (e) {
          // Another collector owns it: back off and leave the window open. The next
          // tick finds the row still parked and past its deadline, and tries again.
          if (e instanceof CollectionInFlightError) continue;
          throw e;
        }
      }

      // Terminal, in the same shape the failed-charge path uses. Guarded on the row
      // still being parked so a concurrent payment (the portal's Pay now — the
      // outcome this whole deadline exists to provoke) wins the race.
      const closed = await withTenant(row.organizationId, async (tx) => {
        const [inv] = await tx
          .update(invoices)
          .set({
            status: "not_paid" as const,
            dunningStatus: "exhausted" as const,
            nextAttemptAt: null,
            // When dunning gave up (0282) — the dated half of the recovery rate.
            dunningExhaustedAt: now,
            // The window closed; no decline ended it.
            dunningExhaustedCode: null,
          })
          .where(
            and(
              eq(invoices.id, row.id),
              eq(invoices.status, "payment_due"),
              eq(invoices.dunningStatus, "parked"),
            ),
          )
          .returning({ id: invoices.id });
        if (!inv) return false;
        await emitEvent(tx, {
          organizationId: row.organizationId,
          businessId: row.businessId,
          type: "invoice_dunning_exhausted",
          data: buildEventData("invoice_dunning_exhausted", {
            id: row.publicId,
            attempts: row.attemptCount,
          }),
        });
        await emitEvent(tx, {
          organizationId: row.organizationId,
          businessId: row.businessId,
          type: "invoice_not_paid",
          data: buildEventData("invoice_not_paid", { id: row.publicId }),
        });
        return true;
      });
      if (!closed) {
        // The deadline attempt itself may have ended dunning (a terminal decline). The
        // row was parked when read, so that exhaustion is this attempt's, and nothing
        // else on this path applies its end action.
        if (attemptedNow) {
          const [after] = await withTenant(row.organizationId, (tx) =>
            tx
              .select({ status: invoices.status, dunningStatus: invoices.dunningStatus })
              .from(invoices)
              .where(eq(invoices.id, row.id))
              .limit(1),
          );
          if (after?.status === "not_paid" && after.dunningStatus === "exhausted") {
            out.exhausted++;
            await applyDunningFinalAction({
              organizationId: row.organizationId,
              businessId: row.businessId,
              invoicePublicId: row.publicId,
              subscriptionId: row.subscriptionId,
              subscriptionPublicId: ctx.sub?.publicId ?? null,
              config: ctx.cfg,
            });
          }
        }
        continue;
      }
      out.exhausted++;

      await applyDunningFinalAction({
        organizationId: row.organizationId,
        businessId: row.businessId,
        invoicePublicId: row.publicId,
        subscriptionId: row.subscriptionId,
        subscriptionPublicId: ctx.sub?.publicId ?? null,
        config: ctx.cfg,
      });
      if (row.subscriptionId && ctx.cfg.finalAction.subscription === "cancel") out.canceled++;
      log.info("parked dunning window closed at its deadline", {
        event: "parked_dunning_exhausted",
        invoice: row.publicId,
        code: ctx.code,
      });
    } catch (e) {
      // Isolate: one invoice must not stall the pass (same contract as runDunningPass).
      log.recurringError(`parked_dunning_sweep_failed:${row.id}`, e, {
        event: "parked_dunning_sweep_failed",
        invoiceId: row.id,
      });
      out.errors.push({
        organization: row.organizationId,
        invoice: row.id,
        step: "parked_dunning_sweep",
        message: (e as Error)?.message ?? String(e),
      });
    }
  }
  return out;
}

/**
 * Walk the reminder ladder on PARKED invoices — the contact a park never had.
 *
 * ── Why this pass exists ──────────────────────────────────────────────────────
 * Every other dunning state talks to the payer BY ATTEMPTING: a retried invoice mails
 * `payment_failed` on each failed charge, so its schedule doubles as its contact ladder. A
 * park attempts nothing, by definition — so it sent one notice at the moment of parking
 * and then nothing at all for the whole window, after which `sweepExpiredParkedDunning`
 * closes it and the final action cancels a subscription whose customer was told once, up
 * to thirty days earlier.
 *
 * That is the one state where contact is the ONLY thing that can recover the money, and it
 * had the least of it.
 *
 * ── It never charges, and it cannot ───────────────────────────────────────────
 * The rung instants live in `dunning_next_reminder_at`, NOT in `next_attempt_at`. A parked
 * invoice is auto-collect-ON, so a reminder written into that column would be picked up by
 * `runDunningPass` and CHARGED — re-presenting exactly the debit parking exists to stop —
 * and would hide the row from the expiry sweep, which scans `next_attempt_at IS NULL`. The
 * separation is the whole design; see migration 0283.
 *
 * ── The rungs are re-derived, never counted ───────────────────────────────────
 * `nextParkedReminderAt` recomputes from `dunning_parked_at` each time, exactly as the
 * offline ladder does: `attempt_count` cannot index it (a park makes no attempts), and a
 * derived instant cannot drift out of step with the deadline the way a stored counter can.
 * Strictly future and strictly inside the window, so one tick cannot walk the whole ladder
 * and mail the customer once per rung.
 */
export async function sweepParkedReminders(
  now: Date,
): Promise<{ reminded: number; errors: TickError[] }> {
  const out = { reminded: 0, errors: [] as TickError[] };
  const due = await systemDb
    .select({
      id: invoices.id,
      publicId: invoices.publicId,
      organizationId: invoices.organizationId,
      businessId: invoices.businessId,
      subscriptionId: invoices.subscriptionId,
      dueDate: invoices.dueDate,
      createdAt: invoices.createdAt,
      dunningParkedAt: invoices.dunningParkedAt,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.status, "payment_due"),
        eq(invoices.dunningStatus, "parked"),
        isNotNull(invoices.dunningNextReminderAt),
        lte(invoices.dunningNextReminderAt, now),
        dunningNotHeldSql(),
        scanBusinessFilter(invoices.businessId),
      ),
    )
    .orderBy(invoices.dunningNextReminderAt)
    .limit(appConfig.TICK_SCAN_LIMIT);

  for (const row of due) {
    try {
      const ctx = await withTenant(row.organizationId, async (tx) => {
        // The refusal that parked it, in the payer's own terms — the template declares
        // `declineMessage` as `always`, and "update your details" with no reason given is
        // the mail people ignore.
        const [pay] = await tx
          .select({
            code: payments.failureCode,
            message: payments.failureMessage,
            pmType: paymentMethods.type,
            pmRail: paymentMethods.mandateRail,
          })
          .from(payments)
          .leftJoin(paymentMethods, eq(paymentMethods.id, payments.paymentMethodId))
          .where(and(eq(payments.invoiceId, row.id), eq(payments.status, "failed")))
          .orderBy(desc(payments.createdAt))
          .limit(1);
        const sub = row.subscriptionId
          ? ((
              await tx
                .select({ status: subscriptions.status })
                .from(subscriptions)
                .where(eq(subscriptions.id, row.subscriptionId))
                .limit(1)
            )[0] ?? null)
          : null;
        const [inv] = await tx.select().from(invoices).where(eq(invoices.id, row.id)).limit(1);
        const cfg = await loadDunningConfig(
          tx,
          row.businessId,
          inv?.customerId,
          inv?.subscriptionId,
        );
        return { pay, sub, cfg, held: inv ? (await dunningHoldFor(tx, inv, cfg)) !== null : false };
      });
      // A business that switched dunning off, or excluded this invoice's class, does not
      // get reminders through the side door either — the same gate the expiry sweep uses.
      if (
        ctx.held ||
        !dunningAppliesTo(ctx.cfg, {
          hasSubscription: row.subscriptionId != null,
          subscriptionStatus: ctx.sub?.status ?? null,
        })
      )
        continue;

      const anchor = row.dunningParkedAt ?? row.dueDate ?? row.createdAt;
      const deadline = parkedDunningDeadline(ctx.cfg, anchor);
      const next = nextParkedReminderAt(
        ctx.cfg,
        anchor,
        now,
        retryDaysForMethod(ctx.cfg, ctx.pay?.pmType, ctx.pay?.pmRail),
      );

      /**
       * PAST THE DEADLINE, SEND NOTHING — clear the rung and leave the row to the expiry
       * sweep.
       *
       * `nextParkedReminderAt` already refuses to SCHEDULE a rung on or after the
       * deadline, but that is a statement about the next one; it says nothing about a rung
       * armed earlier that only came due now. The scan matches on `<= now` alone, so a due
       * rung fires however late the pass reaches it.
       *
       * In the ordinary tick that cannot happen — `sweepExpiredParkedDunning` runs first
       * and a past-deadline invoice is no longer `parked` by the time this scan reads it.
       * But relying on that makes the safety a property of the ORDER of two passes rather
       * than of this one, and the failure it permits is the worst mail this feature can
       * send: "settle by <date>" delivered after <date>, to a customer whose subscription
       * the very same tick just cancelled. Caught by `verify:dunning-smart`, which drove
       * this pass alone at a year out and got a reminder.
       */
      if (now.getTime() >= deadline.getTime()) {
        await withTenant(row.organizationId, (tx) =>
          tx
            .update(invoices)
            .set({ dunningNextReminderAt: null })
            .where(and(eq(invoices.id, row.id), eq(invoices.dunningStatus, "parked"))),
        );
        continue;
      }

      /**
       * Advance the rung FIRST, conditionally, and let that be the claim.
       *
       * The update is guarded on the row still being parked with this same due rung, so
       * two overlapping ticks cannot both mail: the loser updates nothing and backs off.
       * Advancing before emitting also means a crash between the two costs a reminder
       * rather than sending one on every tick forever — the safe side, and the same
       * trade the parked expiry sweep documents for its own ordering.
       */
      const advanced = await withTenant(row.organizationId, async (tx) => {
        const [upd] = await tx
          .update(invoices)
          .set({ dunningNextReminderAt: next })
          .where(
            and(
              eq(invoices.id, row.id),
              eq(invoices.status, "payment_due"),
              eq(invoices.dunningStatus, "parked"),
              isNotNull(invoices.dunningNextReminderAt),
              lte(invoices.dunningNextReminderAt, now),
            ),
          )
          .returning({ id: invoices.id });
        if (!upd) return false;
        await emitEvent(tx, {
          organizationId: row.organizationId,
          businessId: row.businessId,
          type: "invoice_dunning_reminder",
          data: buildEventData("invoice_dunning_reminder", {
            id: row.publicId,
            // Both are `always` vars on the template and neither can be read back off the
            // invoice, so they travel on the event. See `resolveDunningReminder`.
            decline_message: ctx.pay
              ? await storedPayerDeclineMessage(
                  tx,
                  { businessId: row.businessId, code: ctx.pay.code, message: ctx.pay.message },
                  "We could not complete the payment.",
                )
              : null,
            deadline: deadline.toISOString(),
            code: ctx.pay?.code ?? null,
          }),
        });
        return true;
      });
      if (advanced) out.reminded++;
    } catch (e) {
      // Isolate: one invoice must not stall the pass (same contract as its neighbours).
      log.recurringError(`parked_dunning_reminder_failed:${row.id}`, e, {
        event: "parked_dunning_reminder_failed",
        invoiceId: row.id,
      });
      out.errors.push({
        organization: row.organizationId,
        invoice: row.id,
        step: "parked_dunning_reminder",
        message: (e as Error)?.message ?? String(e),
      });
    }
  }
  return out;
}

async function retryInvoice(
  organizationId: string,
  businessId: string,
  invoiceId: string,
  /** Null for a one-time invoice. */
  subscriptionId: string | null,
  now: Date,
): Promise<"recovered" | "still_failing" | "canceled"> {
  // Atomically CLAIM the row before charging: null out next_attempt_at only if
  // it is still due and the invoice is still payment_due. Two overlapping ticks
  // otherwise both pass the `nextAttemptAt <= now` scan filter and both call
  // collectInvoice with different gateway idempotency keys → a real double charge.
  // The loser gets rowcount 0 here and backs off (review fix).
  const claimed = await withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .update(invoices)
      .set({ nextAttemptAt: null })
      .where(
        and(
          eq(invoices.id, invoiceId),
          eq(invoices.status, "payment_due"),
          isNotNull(invoices.nextAttemptAt),
          lte(invoices.nextAttemptAt, now),
        ),
      )
      .returning({ id: invoices.id });
    return !!row;
  });
  if (!claimed) return "still_failing";

  // Reload invoice + subscription inside the org's RLS context.
  const ctx = await withTenant(organizationId, async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    if (!inv) return null;
    if (!subscriptionId) return { inv, sub: null };
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    return sub ? { inv, sub } : null;
  });
  if (!ctx) return "still_failing";

  // Credit on file before the card, as every collection path does.
  const { applyCreditBeforeCharge } = await import("@/modules/customers/collect");
  const credit = await applyCreditBeforeCharge({ organizationId, businessId, invoice: ctx.inv });
  if (credit.settled) return "recovered";
  ctx.inv = credit.invoice;

  // Per-card caps (`representment.ts`): a card at its limit is not presented; the retry
  // waits until the window reopens instead.
  const { capped } = await firstPresentable({
    organizationId,
    candidates: chargeOrder(
      await resolveChargeCandidates({
        organizationId,
        customerId: ctx.inv.customerId,
        subscription: ctx.sub ?? undefined,
        currency: ctx.inv.currency,
      }),
    ),
    now,
    applyCaps: true,
    invoiceId,
  });
  if (capped) {
    await withTenant(organizationId, (tx) =>
      tx
        .update(invoices)
        .set({ nextAttemptAt: capped.until })
        .where(
          and(
            eq(invoices.id, invoiceId),
            eq(invoices.status, "payment_due"),
            isNull(invoices.nextAttemptAt),
          ),
        ),
    );
    log.info("dunning retry deferred: card at its attempt limit", {
      event: "dunning_card_cap",
      invoice: ctx.inv.publicId,
      until: capped.until.toISOString(),
      declines_24h: capped.declines24h,
      declines_30d: capped.declines30d,
    });
    return "still_failing";
  }

  // Several due invoices, one charge (2.51): null = not combined, charge this one alone.
  const { tryCombinedRetry } = await import("./dunning-combined");
  const combined = await tryCombinedRetry({
    organizationId,
    businessId,
    primary: ctx.inv,
    subscription: ctx.sub,
    now,
  });
  if (combined) return combined;

  // collectInvoice records the payment, on success marks the invoice paid +
  // clears nextAttemptAt, on failure reschedules (or nulls) nextAttemptAt.
  let payment: Awaited<ReturnType<typeof collectInvoice>>;
  try {
    payment = await collectInvoice({
      organizationId,
      businessId,
      invoice: ctx.inv,
      subscription: ctx.sub ?? undefined,
    });
  } catch (e) {
    // Someone else is charging this invoice right now. Same answer as losing the
    // next_attempt_at claim above: back off and leave the outcome to whoever holds it.
    // Reporting a failure instead would arm a retry against an attempt still in flight.
    if (e instanceof CollectionInFlightError) return "still_failing";
    throw e;
  }

  if (payment.status === "succeeded") {
    // Collecting the invoice does NOT touch the subscription's status. There is no past-due
    // status to come back from — a subscription in dunning is still `active` — so the only
    // thing a status write here ever did was revive one an operator had cancelled or paused
    // meanwhile, as `active` at a rate of 0 with no movement in the ledger.
    return "recovered";
  }

  // A pending payment means the gateway outcome is UNKNOWN (timeout /
  // needs_attention): the invoice was parked with nextAttemptAt=null for the
  // reconciler — that is NOT exhaustion, and firing the final action here would
  // void/write off an invoice whose charge may still settle as a success.
  if (payment.status !== "failed") return "still_failing";

  // Re-read: only a genuinely terminal failure (the failed-charge path sets
  // not_paid + dunning exhausted) triggers the final action.
  const exhausted = await withTenant(organizationId, async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    return inv ? inv.status === "not_paid" && inv.dunningStatus === "exhausted" : false;
  });

  if (exhausted) {
    // The failed-charge path already set the invoice not_paid + dunning_status
    // exhausted. Apply the business's configured final action: the invoice may be
    // voided / written off, and the subscription CANCELLED or RETAINED (SUB-7).
    const config = await withTenant(organizationId, (tx) =>
      loadDunningConfig(tx, businessId, ctx.inv.customerId, ctx.inv.subscriptionId),
    );
    await applyDunningFinalAction({
      organizationId,
      businessId,
      invoicePublicId: ctx.inv.publicId,
      subscriptionId,
      subscriptionPublicId: ctx.sub?.publicId ?? null,
      config,
    });
    // A one-time invoice has no subscription, so it can never count as cancelled.
    return subscriptionId && config.finalAction.subscription === "cancel"
      ? "canceled"
      : "still_failing";
  }
  return "still_failing";
}

/**
 * Manually STOP dunning an invoice (E3): no more retries — it settles to `not_paid`
 * with dunning_status `stopped`. The debt still stands (collect / record / credits
 * can still pay it), but the automated retry schedule is halted.
 */
export async function stopDunning(
  orgId: string,
  businessId: string,
  invoicePublicId: string,
): Promise<typeof invoices.$inferSelect> {
  return withTenant(orgId, async (tx) => {
    const [inv] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, invoicePublicId)))
      .limit(1);
    if (!inv) throw new InvoiceOpsError(`We could not find the invoice ${invoicePublicId}.`);
    if (inv.status !== "payment_due")
      throw new InvoiceOpsError(`You cannot stop dunning on a ${inv.status} invoice`);
    const [updated] = await tx
      .update(invoices)
      .set({ status: "not_paid", dunningStatus: "stopped", nextAttemptAt: null })
      .where(eq(invoices.id, inv.id))
      .returning();
    await emitEvent(tx, {
      organizationId: orgId,
      businessId,
      type: "invoice_dunning_stopped",
      data: buildEventData("invoice_dunning_stopped", { id: inv.publicId }),
    });
    // P4: halting collection on a real debt is an operator decision with money
    // consequences (no more retries will ever run), so it is audited in the SAME tx
    // as the state change, like `invoice.void`.
    const { writeAuditLog } = await import("@/modules/audit/service");
    await writeAuditLog(
      {
        organizationId: orgId,
        businessId,
        action: "invoice.stop_dunning",
        resourceType: "invoice",
        resourceId: inv.publicId,
        before: {
          status: inv.status,
          dunning_status: inv.dunningStatus,
          next_attempt_at: inv.nextAttemptAt?.toISOString() ?? null,
        },
        after: {
          status: updated!.status,
          dunning_status: updated!.dunningStatus,
          next_attempt_at: null,
        },
      },
      tx,
    );
    return updated!;
  });
}

/**
 * Manually PAUSE dunning until a date (E3): the invoice stays `payment_due`
 * (dunning still in progress) but the next retry is pushed to `until`, so the
 * clock skips it in the meantime.
 */
export async function pauseDunning(
  orgId: string,
  businessId: string,
  invoicePublicId: string,
  until: Date,
): Promise<typeof invoices.$inferSelect> {
  return withTenant(orgId, async (tx) => {
    const [inv] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, invoicePublicId)))
      .limit(1);
    if (!inv) throw new InvoiceOpsError(`We could not find the invoice ${invoicePublicId}.`);
    if (inv.status !== "payment_due")
      throw new InvoiceOpsError(`You cannot pause dunning on a ${inv.status} invoice`);
    // Remember the schedule being paused, so resume can put it back. A re-pause of a
    // still-paused invoice keeps the ORIGINAL schedule, not the first pause's date.
    const stillPaused =
      inv.dunningPause != null &&
      inv.nextAttemptAt?.getTime() === new Date(inv.dunningPause.until).getTime();
    const [updated] = await tx
      .update(invoices)
      .set({
        nextAttemptAt: until,
        dunningStatus: "in_progress",
        dunningPause: {
          until: until.toISOString(),
          next_attempt_at: stillPaused
            ? inv.dunningPause!.next_attempt_at
            : (inv.nextAttemptAt?.toISOString() ?? null),
          dunning_status: stillPaused ? inv.dunningPause!.dunning_status : inv.dunningStatus,
        },
      })
      .where(eq(invoices.id, inv.id))
      .returning();
    await emitEvent(tx, {
      organizationId: orgId,
      businessId,
      type: "invoice_dunning_stopped",
      data: buildEventData("invoice_dunning_stopped", { id: inv.publicId }, null, {
        paused_until: until.toISOString(),
      }),
    });
    // P4: same reasoning as stop_dunning — a deferred retry date is an operator
    // choice, and the pushed-out date is the field a reader needs to see.
    const { writeAuditLog } = await import("@/modules/audit/service");
    await writeAuditLog(
      {
        organizationId: orgId,
        businessId,
        action: "invoice.pause_dunning",
        resourceType: "invoice",
        resourceId: inv.publicId,
        before: {
          dunning_status: inv.dunningStatus,
          next_attempt_at: inv.nextAttemptAt?.toISOString() ?? null,
        },
        after: { dunning_status: updated!.dunningStatus, next_attempt_at: until.toISOString() },
      },
      tx,
    );
    return updated!;
  });
}

/**
 * Undo `pauseDunning`: restore the retry schedule and dunning status the pause replaced.
 * Only while the pause still stands — `next_attempt_at` is still the pause date and that
 * date is ahead. A past-due restored attempt runs on the clock's next pass, exactly as it
 * would have without the pause.
 */
export async function resumeDunning(
  orgId: string,
  businessId: string,
  invoicePublicId: string,
): Promise<typeof invoices.$inferSelect> {
  return withTenant(orgId, async (tx) => {
    const [inv] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, invoicePublicId)))
      .for("update")
      .limit(1);
    if (!inv) throw new InvoiceOpsError(`We could not find the invoice ${invoicePublicId}.`);
    if (inv.status !== "payment_due")
      throw new InvoiceOpsError(`You cannot resume dunning on a ${inv.status} invoice`);
    const pause = inv.dunningPause;
    const pausedUntil = pause ? new Date(pause.until) : null;
    if (
      !pause ||
      !pausedUntil ||
      inv.nextAttemptAt?.getTime() !== pausedUntil.getTime() ||
      pausedUntil.getTime() <= stampNow(businessId).getTime()
    )
      throw new InvoiceOpsError("Dunning is not paused on this invoice");
    const restoredAt = pause.next_attempt_at ? new Date(pause.next_attempt_at) : null;
    const [updated] = await tx
      .update(invoices)
      .set({
        nextAttemptAt: restoredAt,
        dunningStatus: pause.dunning_status,
        dunningPause: null,
        // An operator re-armed it: a change-charge hold must not push the next retry back.
        retryHoldUntil: null,
      })
      .where(eq(invoices.id, inv.id))
      .returning();
    await emitEvent(tx, {
      organizationId: orgId,
      businessId,
      type: "invoice_updated",
      data: buildEventData("invoice_updated", { id: inv.publicId }),
    });
    const { writeAuditLog } = await import("@/modules/audit/service");
    await writeAuditLog(
      {
        organizationId: orgId,
        businessId,
        action: "invoice.resume_dunning",
        resourceType: "invoice",
        resourceId: inv.publicId,
        before: {
          dunning_status: inv.dunningStatus,
          next_attempt_at: inv.nextAttemptAt?.toISOString() ?? null,
        },
        after: {
          dunning_status: updated!.dunningStatus,
          next_attempt_at: restoredAt?.toISOString() ?? null,
        },
      },
      tx,
    );
    return updated!;
  });
}
