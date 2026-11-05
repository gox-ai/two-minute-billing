/**
 * Stale-pending REFUND sweep — the backstop for a settlement webhook that never came.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * The refund twin of `payments/stale-pending.ts`, and it exists for the same reason with
 * one extra edge: a refund the provider accepted is recorded `pending` **with its ledger
 * pair already booked**, and the ONLY thing that ever resolves it is the provider's
 * settlement webhook (`refund.processed`, `PAYMENT.CAPTURE.REFUNDED`, `charge.refunded`).
 *
 * So a callback that never arrives — a mis-provisioned endpoint, an outage on either side,
 * a tunnel that was down during the window — strands the refund for ever: the row says
 * `pending`, its transaction says `in_progress`, the customer has been told the money is
 * on its way, and nothing in the engine revisits it. Unlike a stranded charge, the money
 * has already left our books, so the failure is quiet: the ledger is right, the customer
 * is uninformed, and the operator has no signal at all.
 *
 * Card and bank refunds legitimately take 5–10 working days, which is long enough that a
 * missed callback is indistinguishable from a slow one. That is precisely why this cannot
 * be a short timeout, and why it asks the gateway rather than deciding anything.
 *
 * ── What it does NOT do ───────────────────────────────────────────────────────
 * It never decides an outcome. It asks (`fetchRefundStatus`) and hands the verdict to the
 * same `settleRefund` / `reverseRefund` path a webhook takes, so a swept refund and a
 * webhook-settled one are byte-identical in the ledger and in the events log. A gateway
 * still saying `pending` is left alone however old the refund is — the engine's opinion is
 * worth less than the gateway's. Adapters without `fetchRefundStatus` are skipped and
 * COUNTED, never guessed at.
 */
import { and, eq, exists, lt, isNotNull, isNull, sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { scanBusinessFilter } from "@/platform/clock";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";
import { resolveAdapter, getProvider } from "@/providers/registry";
import { settleRefund, reverseRefund } from "./settlement";
import {
  gatewayAccounts,
  ledgerEntries,
  paymentRequests,
  payments,
  refunds,
  transactions,
} from "@db/schema";

const log = createLogger("stale-pending-refund");

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long an accepted refund may legitimately stay unsettled before we ask.
 *
 * A grace period, not a timeout: nothing is failed when it elapses, we merely stop
 * assuming the webhook is still on its way. Set from the slowest ordinary rail rather than
 * the fastest — card issuers quote up to 10 working days and a fortnight covers weekends
 * and a public holiday, so a healthy refund is never polled. Sweeping late costs nothing
 * but time; sweeping early costs a needless gateway call. Neither can damage a live refund,
 * because the gateway's answer is what decides.
 */
const REFUND_GRACE_HOURS = 24 * 14;

/**
 * How long a refund whose create answer was lost waits before we look for it. Not a
 * settlement window: the question is only whether the gateway created it at all, and a
 * create call is answered in seconds.
 */
const LOST_ANSWER_GRACE_HOURS = 1;

export interface StalePendingRefundResult {
  /** Refunds old enough to ask the gateway about. */
  examined: number;
  /** Confirmed as money returned. */
  settled: number;
  /** Confirmed as refused — booking reversed. */
  reversed: number;
  /** The gateway says it is still working — left untouched. */
  stillPending: number;
  /** Skipped because the adapter cannot be asked (no `fetchRefundStatus`). */
  unsupported: number;
  /** Lost-answer refunds (no gateway id) whose gateway refund was found and adopted. */
  located: number;
}

/**
 * The adapter that placed this refund. Resolved through the refund's TRANSACTION, because
 * `refunds` carries only a provider key while the transaction carries the gateway account —
 * and an org with two accounts on one provider must be asked through the right credentials.
 */
async function adapterForRefund(ref: typeof refunds.$inferSelect) {
  const [txn] = await systemDb
    .select({ gatewayAccountId: transactions.gatewayAccountId })
    .from(transactions)
    .where(eq(transactions.refundId, ref.id))
    .limit(1);
  if (txn?.gatewayAccountId) {
    const [acc] = await systemDb
      .select()
      .from(gatewayAccounts)
      .where(eq(gatewayAccounts.id, txn.gatewayAccountId))
      .limit(1);
    if (acc) return resolveAdapter(acc);
  }
  // Rows predating gateway accounts carry only the key. `getProvider` throws for an
  // unconfigured one, which the caller counts as unsupported.
  return ref.providerKey ? getProvider(ref.providerKey) : null;
}

export async function sweepStalePendingRefunds(now: Date): Promise<StalePendingRefundResult> {
  const out: StalePendingRefundResult = {
    examined: 0,
    settled: 0,
    reversed: 0,
    stillPending: 0,
    unsupported: 0,
    located: 0,
  };

  await resolveLostAnswerRefunds(now, out);

  const candidates = await systemDb
    .select()
    .from(refunds)
    .where(
      and(
        eq(refunds.status, "pending"),
        // No gateway handle = nothing to ask about. Such a row is a different problem (the
        // refund was recorded without an id) and operator reconcile owns it.
        isNotNull(refunds.providerRefundId),
        lt(refunds.createdAt, new Date(now.getTime() - REFUND_GRACE_HOURS * HOUR_MS)),
        scanBusinessFilter(refunds.businessId),
      ),
    )
    // Oldest first, so the longest-stranded refund is always resolved next and a backlog
    // drains across ticks rather than being held in one — the same contract as the charge
    // sweep and the renewal pass.
    .orderBy(refunds.createdAt)
    .limit(config.TICK_SCAN_LIMIT);

  for (const ref of candidates) {
    out.examined++;

    let adapter;
    try {
      adapter = await adapterForRefund(ref);
    } catch (e) {
      // A gateway account that no longer resolves (deleted, credentials rotated away) is an
      // ops problem, not a verdict about the money. Inventing an outcome here is the one
      // thing this sweep must never do.
      out.unsupported++;
      log.warn("stale-refund: cannot resolve an adapter for this refund", {
        refund: ref.publicId,
        error: String(e),
      });
      continue;
    }
    if (!adapter?.fetchRefundStatus) {
      out.unsupported++;
      continue;
    }

    let verdict;
    try {
      const [payment] = await systemDb
        .select({
          providerChargeId: payments.providerChargeId,
          paymentRequestId: payments.paymentRequestId,
        })
        .from(payments)
        .where(eq(payments.id, ref.paymentId))
        .limit(1);
      // A payment-request child carries no charge id; the request holds the one charge.
      let providerChargeId = payment?.providerChargeId ?? null;
      if (!providerChargeId && payment?.paymentRequestId) {
        const [req] = await systemDb
          .select({ providerChargeId: paymentRequests.providerChargeId })
          .from(paymentRequests)
          .where(eq(paymentRequests.id, payment.paymentRequestId))
          .limit(1);
        providerChargeId = req?.providerChargeId ?? null;
      }
      verdict = await adapter.fetchRefundStatus({
        providerRefundId: ref.providerRefundId!,
        ...(providerChargeId ? { providerChargeId } : {}),
        requestedAt: ref.createdAt,
      });
    } catch (e) {
      // A failed poll says nothing about the refund. Leave it pending; the next tick asks
      // again. This is also why a non-2xx must throw inside the adapter rather than being
      // mapped to `failed` — "we could not ask" is not "it was refused".
      log.warn("stale-refund: gateway status poll failed", {
        refund: ref.publicId,
        error: String(e),
      });
      out.stillPending++;
      continue;
    }

    if (verdict.status === "succeeded") {
      if (await settleRefund(ref, now)) out.settled++;
      else out.stillPending++; // a webhook won the race between the poll and the write
    } else if (verdict.status === "failed") {
      if (
        await reverseRefund(ref, {
          failureCode: "refund_failed_at_gateway",
          gatewayConfirmed: true,
        })
      )
        out.reversed++;
      else out.stillPending++;
    } else {
      out.stillPending++;
    }
  }

  if (out.settled > 0 || out.reversed > 0 || out.located > 0) {
    // Worth a line at info: every row here is a refund whose settlement webhook did NOT
    // arrive, which is a signal about webhook delivery health, not just about these refunds.
    log.info("stale-refund sweep: refunds whose settlement webhook never arrived", {
      event: "stale_pending_refund_swept",
      ...out,
    });
  }
  return out;
}

/**
 * Refunds booked on a LOST answer: accepted on our books (ledger posted, transaction
 * recorded) with no gateway id, because the create call timed out or answered 5xx.
 * `locateRefund` finds the gateway refund by the tag `refund()` stamped on it. Found: adopt
 * the id, then settle / reverse / wait as the gateway says. Not there: it was never
 * created, so the booking is reversed.
 *
 * Only rows whose refund was BOOKED (a refund transaction and its own ledger lines) and not
 * imported: a bare reservation or an imported row has nothing to reverse, and reversing it
 * would post cash back that never left.
 */
async function resolveLostAnswerRefunds(now: Date, out: StalePendingRefundResult) {
  // A payment-request child carries no charge id; the request holds the one charge.
  const chargeId = sql<
    string | null
  >`coalesce(${payments.providerChargeId}, ${paymentRequests.providerChargeId})`;
  const rows = await systemDb
    .select({ ref: refunds, providerChargeId: chargeId })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .leftJoin(paymentRequests, eq(paymentRequests.id, payments.paymentRequestId))
    .innerJoin(transactions, eq(transactions.refundId, refunds.id))
    .where(
      and(
        eq(refunds.status, "pending"),
        isNull(refunds.providerRefundId),
        eq(refunds.imported, false),
        sql`${chargeId} is not null`,
        exists(
          systemDb
            .select({ one: sql`1` })
            .from(ledgerEntries)
            .where(
              and(
                eq(ledgerEntries.sourceType, "refund"),
                eq(ledgerEntries.sourceId, refunds.publicId),
              ),
            ),
        ),
        lt(refunds.createdAt, new Date(now.getTime() - LOST_ANSWER_GRACE_HOURS * HOUR_MS)),
        scanBusinessFilter(refunds.businessId),
      ),
    )
    .orderBy(refunds.createdAt)
    .limit(config.TICK_SCAN_LIMIT);

  for (const { ref, providerChargeId } of rows) {
    out.examined++;
    let adapter;
    try {
      adapter = await adapterForRefund(ref);
    } catch {
      out.unsupported++;
      continue;
    }
    if (!adapter?.locateRefund) {
      out.unsupported++;
      continue;
    }
    let found;
    try {
      found = await adapter.locateRefund({
        providerChargeId: providerChargeId!,
        ownershipRef: ref.publicId,
      });
    } catch (e) {
      log.warn("stale-refund: could not look up a lost-answer refund", {
        refund: ref.publicId,
        error: String(e),
      });
      out.stillPending++;
      continue;
    }
    if (!found) {
      // Only a refund still pending: one a webhook settled meanwhile is left alone.
      if (await reverseRefund(ref, { failureCode: "refund_not_created", onlyPending: true }))
        out.reversed++;
      else out.stillPending++;
      continue;
    }
    const stamped = await withTenant(ref.organizationId, async (tx) => {
      const [row] = await tx
        .update(refunds)
        .set({ providerRefundId: found.providerRefundId })
        .where(and(eq(refunds.id, ref.id), isNull(refunds.providerRefundId)))
        .returning();
      if (row)
        await tx
          .update(transactions)
          .set({ idAtGateway: found.providerRefundId })
          .where(and(eq(transactions.refundId, ref.id), isNull(transactions.idAtGateway)));
      return row;
    });
    if (!stamped) {
      out.stillPending++; // a webhook adopted it first
      continue;
    }
    out.located++;
    if (found.status === "succeeded") {
      if (await settleRefund(stamped, now)) out.settled++;
    } else if (found.status === "failed") {
      if (
        await reverseRefund(stamped, {
          failureCode: "refund_failed_at_gateway",
          gatewayConfirmed: true,
        })
      )
        out.reversed++;
    } else {
      out.stillPending++;
    }
  }
}

/** Exported for the verify suite — the grace period before a refund is polled. */
export const __refundGraceHours = REFUND_GRACE_HOURS;
/** Exported for the verify suite — the wait before a lost-answer refund is looked up. */
export const __lostAnswerGraceHours = LOST_ANSWER_GRACE_HOURS;
