/**
 * Apply a business's chargeback policy (0244) — the actions the business's chargeback
 * management settings configure, run AFTER the dispute's own ledger work.
 *
 * ── Why this is a separate module, and runs after the transaction ────────────
 * `handleDisputeEvent` does its ledger postings inside one `withTenant` transaction
 * holding `lockDispute`. Every action here either talks to a payment gateway
 * (cancel-with-collection) or opens its own transaction, so none of it can run inside
 * that one — the same reason `applyCancelMoneyHandling` runs after `cancelSubscription`
 * rather than within it.
 *
 * ── IDEMPOTENCE, which matters more here than anywhere else in this file ─────
 * This is reached from a WEBHOOK (`webhooks/inbound.ts`), and providers retry webhooks.
 * A retried event must not cancel a subscription twice or — much worse — raise a second
 * credit note, which is not self-correcting.
 *
 * There is no marker column and none is needed: the caller only asks us to fire on a real
 * STATE TRANSITION.
 *   · `initiated` fires only when the dispute row was newly INSERTED, so a replayed
 *     `dispute.created` finds the row and asks for nothing.
 *   · `lost` fires only from inside the existing `status !== 'lost' && !== 'won'` guard,
 *     which by construction runs once per dispute.
 *
 * The deliberate consequence: if the process dies after that transaction commits but
 * before this runs, the policy never fires for that dispute. **That is the safe side of
 * the trade** — a missed policy is visible and fixable by hand, a duplicate credit note
 * or a wrongly cancelled subscription is not. It is logged as such.
 *
 * ── NOTHING HERE THROWS ─────────────────────────────────────────────────────
 * A throw would fail the webhook, the provider would retry, and the retry would find the
 * transition already made and skip the policy — so the failure would be silent AND
 * permanent. Every step is isolated and reported instead, which is the same shape (and
 * the same reasoning) as `applyCancelMoneyHandling`'s `warnings`.
 */
import { stampNow } from "@/platform/clock";
import { and, eq, ne, notInArray, or, sql } from "drizzle-orm";
import { businesses, customers, invoices, subscriptions } from "@db/schema";
import { withTenant } from "@/platform/db";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { createLogger } from "@/platform/logger";
import { resolveChargebackConfig, type ChargebackSubscriptionAction } from "./chargeback-config";

const log = createLogger("disputes");

export interface ChargebackPolicyInput {
  organizationId: string;
  businessId: string;
  /** The dispute, for the log trail and the credit note's reason. */
  disputePublicId: string;
  customerId: string | null;
  invoiceId: string | null;
  currency: string;
  amountMinor: bigint;
  /** Which transition asked. `initiated` gets subscription actions only. */
  phase: "initiated" | "lost";
  now: Date;
}

/** What actually happened, for the caller's log. Never thrown. */
export interface ChargebackPolicyResult {
  applied: string[];
  failed: string[];
}

export async function applyChargebackPolicy(
  input: ChargebackPolicyInput,
): Promise<ChargebackPolicyResult> {
  const applied: string[] = [];
  const failed: string[] = [];
  const note = (e: unknown) => (e as Error)?.message ?? String(e);

  const [biz] = await withTenant(input.organizationId, (tx) =>
    tx
      .select({ chargebackConfig: businesses.chargebackConfig })
      .from(businesses)
      .where(eq(businesses.id, input.businessId))
      .limit(1),
  );
  const cfg = resolveChargebackConfig(biz);

  const subAction =
    input.phase === "initiated" ? cfg.onInitiatedSubscription : cfg.onLostSubscription;
  const wantsInvoice = input.phase === "lost" && cfg.onLostInvoice === "credit_note";

  // Nothing configured — the overwhelmingly common case, and it must cost nothing.
  if (subAction === "no_action" && !wantsInvoice && !cfg.stopCollectingAll) {
    return { applied, failed };
  }

  // ── 1. The documentary credit note (LOST only) ─────────────────────────────
  // `createRefundedCreditNote` books NO ledger entries by design — the dispute's own
  // `dispute_losses` posting is the accounting treatment and stays untouched. This is the
  // reconciliation DOCUMENT only.
  if (wantsInvoice) {
    if (!input.invoiceId || !input.customerId) {
      // An uncorrelated dispute has no invoice to credit. Not a failure of the policy —
      // there is nothing to document — but worth saying so rather than silently skipping.
      applied.push("credit_note:skipped_uncorrelated");
    } else {
      try {
        await withTenant(input.organizationId, async (tx) => {
          const [inv] = await tx
            .select({ publicId: invoices.publicId })
            .from(invoices)
            .where(eq(invoices.id, input.invoiceId!))
            .limit(1);
          const { createRefundedCreditNote } = await import("@/modules/credit-notes/service");
          await createRefundedCreditNote(tx, {
            organizationId: input.organizationId,
            businessId: input.businessId,
            customerId: input.customerId!,
            invoiceId: input.invoiceId!,
            invoicePublicId: inv?.publicId ?? input.invoiceId!,
            currency: input.currency,
            amountMinor: input.amountMinor,
            reason: `Chargeback lost (${input.disputePublicId})`,
          });
        });
        applied.push("credit_note");
      } catch (e) {
        failed.push(`credit_note: ${note(e)}`);
      }
    }
  }

  // ── 2. The subscription action ─────────────────────────────────────────────
  if (subAction !== "no_action") {
    const targets = await subscriptionTargets(input, cfg.cascadeToOtherSubscriptions);
    for (const sub of targets) {
      try {
        const isCancel = subAction === "cancel_immediately" || subAction === "cancel_end_of_term";
        // Already in a state at least as strong (another dispute, or a person): leave it. A
        // weaker state (a cancel or pause months away) does not count: act now.
        const termEnd = sub.currentPeriodEnd?.getTime() ?? null;
        const pauseAt = await scheduledPauseAt(input.organizationId, sub.id);
        const already =
          subAction === "cancel_immediately"
            ? sub.status === "cancelled"
            : subAction === "cancel_end_of_term"
              ? sub.status === "cancelled" ||
                sub.cancelAtPeriodEnd ||
                (sub.cancelScheduledAt != null &&
                  termEnd != null &&
                  sub.cancelScheduledAt.getTime() <= termEnd)
              : subAction === "pause_indefinitely"
                ? sub.status === "paused"
                : sub.status === "paused" ||
                  (pauseAt != null && termEnd != null && pauseAt.getTime() <= termEnd);
        if (!isCancel && sub.status === "cancelled") continue;
        if (already) {
          applied.push(`${subAction}:already:${sub.publicId}`);
          continue;
        }
        // A person's pause scheduled for later is overtaken by the policy's: withdraw it
        // and say so, so the merchant can see why it is gone.
        const policyPauseAt =
          subAction === "pause_indefinitely" ? input.now.getTime() : (termEnd ?? null);
        // With them, every scheduled resume after the policy's pause starts: left in place it
        // would end the policy's pause and bill the disputing customer again.
        const laterPauses =
          !isCancel && policyPauseAt != null
            ? await laterScheduled(input.organizationId, sub.id, policyPauseAt, ["pause", "resume"])
            : [];
        // The INTERNAL id: the service functions read `subscriptions.id`.
        await runSubscriptionAction(input, sub.id, subAction);
        applied.push(`${subAction}:${sub.publicId}`);
        if (laterPauses.length) await withdrawOvertaken(input, sub.publicId, laterPauses);
      } catch (e) {
        // One subscription failing must not stop the others — a partial application is
        // reported, never rolled back (the ones that succeeded really are cancelled).
        failed.push(`${subAction}:${sub.publicId}: ${note(e)}`);
      }
    }
  }

  // ── 3. Stop collecting from this customer ──────────────────────────────────
  // Stop collecting for unpaid invoices / unbilled charges across all subscriptions.
  // Implemented as the customer's own `auto_collection = off`, which is exactly the field
  // the collection paths already consult — rather than touching each invoice, which would
  // leave new ones still collecting.
  if (cfg.stopCollectingAll && input.customerId) {
    try {
      await withTenant(input.organizationId, async (tx) => {
        const [row] = await tx
          .update(customers)
          .set({ autoCollection: "off", updatedAt: stampNow() })
          .where(and(eq(customers.id, input.customerId!), ne(customers.autoCollection, "off")))
          .returning();
        // Only a real flip is announced; a customer already off changed nothing.
        if (row)
          await emitEvent(tx, {
            organizationId: input.organizationId,
            businessId: input.businessId,
            type: "customer_updated",
            data: buildEventData(
              "customer_updated",
              { id: row.publicId, email: row.email },
              row.resourceVersion,
            ),
          });
      });
      applied.push("stop_collecting");
    } catch (e) {
      failed.push(`stop_collecting: ${note(e)}`);
    }
  }

  if (applied.length || failed.length) {
    log.info("chargeback policy applied", {
      event: "chargeback_policy_applied",
      dispute: input.disputePublicId,
      businessId: input.businessId,
      phase: input.phase,
      applied,
      failed,
    });
  }
  return { applied, failed };
}

/**
 * The subscriptions to act on: the disputed invoice's own, plus — only when the merchant
 * has explicitly asked — the customer's others.
 *
 * `cascade` is off by default because one disputed payment is not evidence about every
 * subscription a customer holds, and cancelling them is not undone by turning the setting
 * back off. Cancelled ones are excluded, and the cascade skips the customer's OTHER paused
 * ones: a pause someone else made is not ours to change.
 */
async function subscriptionTargets(
  input: ChargebackPolicyInput,
  cascade: boolean,
): Promise<Array<typeof subscriptions.$inferSelect>> {
  return withTenant(input.organizationId, async (tx) => {
    const own = input.invoiceId
      ? ((
          await tx
            .select({ subscriptionId: invoices.subscriptionId })
            .from(invoices)
            .where(eq(invoices.id, input.invoiceId))
            .limit(1)
        )[0]?.subscriptionId ?? null)
      : null;

    if (!cascade) {
      if (!own) return [];
      // Cancelled too: a second dispute on a cancelled subscription joins that cancel.
      const [row] = await tx.select().from(subscriptions).where(eq(subscriptions.id, own)).limit(1);
      return row ? [row] : [];
    }

    if (!input.customerId) return [];
    return tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.customerId, input.customerId),
          // The disputed subscription is treated as without the cascade; the customer's
          // other cancelled or paused ones are left alone.
          own
            ? or(
                eq(subscriptions.id, own),
                notInArray(subscriptions.status, ["cancelled", "paused"]),
              )
            : notInArray(subscriptions.status, ["cancelled", "paused"]),
        ),
      );
  });
}

/** One action against one subscription. `pause_*` is a pause forever — indefinite. */
async function runSubscriptionAction(
  input: ChargebackPolicyInput,
  subscriptionId: string,
  action: Exclude<ChargebackSubscriptionAction, "no_action">,
): Promise<void> {
  const svc = await import("@/modules/subscriptions/service");
  const reason = `Chargeback ${input.phase} (${input.disputePublicId})`;

  if (action === "cancel_immediately" || action === "cancel_end_of_term") {
    await svc.cancelSubscriptionWithOptions({
      organizationId: input.organizationId,
      businessId: input.businessId,
      subscriptionId,
      now: input.now,
      cancelOption: action === "cancel_immediately" ? "immediately" : "end_of_term",
      // A chargeback cancel never refunds or collects: no credit, refundable credit and
      // open invoices left as they are, and the business's cancel defaults (0242) not read.
      // The disputed money is the dispute's own business.
      moneyDefaults: "none",
      creditOptionForCurrentTermCharges: "none",
      accountReceivablesHandling: "no_action",
      refundableCreditsHandling: "no_action",
      cancelReason: reason,
    });
    return;
  }

  await svc.pauseSubscriptionWithOptions({
    organizationId: input.organizationId,
    businessId: input.businessId,
    subscriptionId,
    now: input.now,
    pauseOption: action === "pause_indefinitely" ? "immediately" : "end_of_term",
    // No `pauseDate`/`skipBillingCycles`: pausing forever is what an indefinite pause
    // already is. The business's `pause_config` (0242) still decides
    // unbilled charges and dunning.
  });
}

/** When the earliest pending scheduled pause starts, or null. */
async function scheduledPauseAt(
  organizationId: string,
  subscriptionId: string,
): Promise<Date | null> {
  const { scheduledChanges } = await import("@db/schema");
  const { asc } = await import("drizzle-orm");
  const [row] = await withTenant(organizationId, (tx) =>
    tx
      .select({ at: scheduledChanges.effectiveAt })
      .from(scheduledChanges)
      .where(
        and(
          eq(scheduledChanges.subscriptionId, subscriptionId),
          eq(scheduledChanges.type, "pause"),
          eq(scheduledChanges.status, "scheduled"),
        ),
      )
      .orderBy(asc(scheduledChanges.effectiveAt))
      .limit(1),
  );
  return row?.at ?? null;
}

/** Pending scheduled changes of these types that take effect after `afterMs`. */
async function laterScheduled(
  organizationId: string,
  subscriptionId: string,
  afterMs: number,
  types: Array<"pause" | "resume">,
): Promise<string[]> {
  const { inArray } = await import("drizzle-orm");
  const { scheduledChanges } = await import("@db/schema");
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({ publicId: scheduledChanges.publicId, at: scheduledChanges.effectiveAt })
      .from(scheduledChanges)
      .where(
        and(
          eq(scheduledChanges.subscriptionId, subscriptionId),
          inArray(scheduledChanges.type, types),
          eq(scheduledChanges.status, "scheduled"),
        ),
      ),
  );
  return rows.filter((r) => r.at.getTime() > afterMs).map((r) => r.publicId);
}

/**
 * Withdraw the overtaken scheduled pauses and resumes. `cancelScheduledChange` emits
 * `subscription_scheduled_change_removed`; a row the policy's own scheduling already replaced
 * gets the event here, once.
 */
async function withdrawOvertaken(
  input: ChargebackPolicyInput,
  subscriptionPublicId: string,
  scheduledChangeIds: string[],
): Promise<void> {
  const { cancelScheduledChange } = await import("@/modules/subscriptions/scheduled-changes");
  const { scheduledChanges } = await import("@db/schema");
  for (const id of scheduledChangeIds) {
    // Scheduling the policy's pause may already have replaced it; either way it is gone now.
    if (await cancelScheduledChange(input.organizationId, input.businessId, id)) continue;
    const [row] = await withTenant(input.organizationId, (tx) =>
      tx
        .select({ status: scheduledChanges.status })
        .from(scheduledChanges)
        .where(eq(scheduledChanges.publicId, id))
        .limit(1),
    );
    if (row?.status !== "canceled") continue;
    await withTenant(input.organizationId, (tx) =>
      emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "subscription_scheduled_change_removed",
        data: buildEventData(
          "subscription_scheduled_change_removed",
          { id: subscriptionPublicId, scheduled_change: id },
          null,
          { reason: `Replaced by the chargeback policy pause (${input.disputePublicId})` },
        ),
      }),
    );
  }
}
