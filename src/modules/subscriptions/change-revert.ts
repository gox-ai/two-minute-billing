/**
 * Revert a plan change, or an item add, whose invoice failed for good (a hard decline at once).
 *
 * The change applies before it is charged, so a declined charge left the customer on the new
 * plan, unpaid, until dunning's final action ran — and that action cancels the whole
 * subscription, the old plan with it. A revert puts the subscription back as it was before the
 * change: items, the columns the change wrote, and the plan credits. The invoice and the
 * change's credit notes are voided in the same transaction: if a void fails, nothing is
 * reverted and the dunning final action runs, so a reverted change never leaves a collectable
 * invoice. No proration runs and nothing is charged. The caller throws `ChangeRevertedError`
 * (proration.ts), which the API answers with 402.
 *
 * Only a change that moved existing items can be reverted exactly. A change that added or
 * removed items, touched discounts, re-cut deferred charges or settled metered usage records a
 * `blocker`; so does a credit note whose credit went elsewhere. Those keep the dunning final
 * action. An added item is reverted by deleting it, unless credit or usage is already booked
 * on it.
 */
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import {
  creditGrants,
  creditNoteAllocations,
  creditNotes,
  invoices,
  subscriptions,
  subscriptionItems,
  transactions,
  usageRecords,
} from "@db/schema";
import { auditSubscription, subscriptionSnapshot } from "./audit";
import { syncMeterBilling } from "./meter-billing";
import { recomputeSubscriptionMrr } from "./service";

const log = createLogger("subscriptions.change-revert");

type SubRow = typeof subscriptions.$inferSelect;
type ItemRow = typeof subscriptionItems.$inferSelect;
type CreditNote = typeof creditNotes.$inferSelect;

/** What `ChangeRevertedError` reports: the voided invoice and why its payment failed. */
export interface RevertedCharge {
  kind: "change" | "item_add";
  invoice: string;
  declineCode: string;
  /** Payer-safe, with the business's decline overrides applied. */
  declineMessage: string;
}

/** What a revert needs, captured inside the change's own transaction before it writes. */
export interface ChangeUndo {
  /** Why this change cannot be reverted exactly; null when it can. */
  blocker: string | null;
  sub: SubRow;
  items: ItemRow[];
  /** The items as the change leaves them: a revert refuses if they moved since. */
  moved: Array<{ itemId: string; priceId: string; quantity: number }>;
  /** The plan-credit grants open before the change, as they were. */
  grants: Array<{ id: string; expiresAt: Date | null; metadata: unknown }>;
}

/** Filled by `applyChange`; read by `changeSubscription` once the invoice is collected. */
export type ChangeUndoSink = { value?: ChangeUndo };

export async function captureChangeUndo(
  tx: Tx,
  input: {
    /** The row the change planned from: the claim refuses any other version. */
    sub: SubRow;
    moved: ChangeUndo["moved"];
    blocker: string | null;
  },
): Promise<ChangeUndo> {
  const { sub } = input;
  const items = await tx
    .select()
    .from(subscriptionItems)
    .where(eq(subscriptionItems.subscriptionId, sub.id));
  const grants = items.length
    ? await tx
        .select({
          id: creditGrants.id,
          expiresAt: creditGrants.expiresAt,
          metadata: creditGrants.metadata,
        })
        .from(creditGrants)
        .where(
          and(
            inArray(
              creditGrants.subscriptionItemId,
              items.map((i) => i.id),
            ),
            eq(creditGrants.source, "plan_cycle"),
            inArray(creditGrants.status, ["active", "pending"]),
          ),
        )
    : [];
  return { blocker: input.blocker, sub, items, moved: input.moved, grants };
}

let voidFault: (() => void) | null = null;
/** Suites only: throw between the invoice void and the credit-note voids of a revert. */
export function setRevertVoidFaultForTests(f: (() => void) | null): void {
  if (config.NODE_ENV === "production") throw new Error("test hook in production");
  voidFault = f;
}

/** Void the reverted invoice and its credit notes inside the revert's transaction. */
async function voidReverted(
  tx: Tx,
  organizationId: string,
  businessId: string,
  invoicePublicId: string,
  notes: CreditNote[],
): Promise<void> {
  const { voidInvoiceInTx } = await import("@/modules/invoicing/ops");
  await voidInvoiceInTx(tx, organizationId, businessId, invoicePublicId, {
    voidReasonCode: "change_reverted",
  });
  voidFault?.();
  const { voidCreditNote } = await import("@/modules/credit-notes/service");
  for (const n of notes)
    await voidCreditNote({ organizationId, businessId, creditNotePublicId: n.publicId, tx });
}

/**
 * Put the subscription back as `undo` holds it and void the change's invoice and credit notes,
 * in one transaction. Returns false and writes nothing when the items no longer match what the
 * change left (another writer moved them). Throws, and writes nothing, when a void fails.
 */
export async function revertChange(input: {
  organizationId: string;
  businessId: string;
  undo: ChangeUndo;
  invoicePublicId: string;
  notes: CreditNote[];
  now: Date;
}): Promise<boolean> {
  const { undo } = input;
  return withTenant(input.organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, undo.sub.id))
      .for("update")
      .limit(1);
    if (!row) return false;
    const current = await tx
      .select()
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, row.id))
      .for("update");
    const priorIds = new Set(undo.items.map((i) => i.id));
    const intact =
      current.length === undo.items.length &&
      current.every((i) => priorIds.has(i.id)) &&
      undo.moved.every((m) => {
        const c = current.find((i) => i.id === m.itemId);
        return c?.priceId === m.priceId && c.quantity === m.quantity;
      });
    if (!intact) return false;

    const before = await subscriptionSnapshot(tx, row);
    for (const item of undo.items) {
      await tx
        .update(subscriptionItems)
        .set({
          priceId: item.priceId,
          quantity: item.quantity,
          freeQuantity: item.freeQuantity,
          billingCycles: item.billingCycles,
          cyclesBilled: item.cyclesBilled,
          metadata: item.metadata,
          priceSnapshot: item.priceSnapshot,
          usageBilledThrough: item.usageBilledThrough,
          nextCreditResetAt: item.nextCreditResetAt,
        })
        .where(eq(subscriptionItems.id, item.id));
    }
    // The columns a change writes: the claim, a term reset's term and cadence, the commitment
    // and the allowance record.
    await tx
      .update(subscriptions)
      .set({
        metadata: undo.sub.metadata,
        currentPeriodStart: undo.sub.currentPeriodStart,
        currentPeriodEnd: undo.sub.currentPeriodEnd,
        currentSubPeriodStart: undo.sub.currentSubPeriodStart,
        currentSubPeriodEnd: undo.sub.currentSubPeriodEnd,
        billingAnchorDay: undo.sub.billingAnchorDay,
        billingPeriod: undo.sub.billingPeriod,
        billingPeriodUnit: undo.sub.billingPeriodUnit,
        billUsageMonthly: undo.sub.billUsageMonthly,
        commitmentAmountMinor: undo.sub.commitmentAmountMinor,
        commitmentSegments: undo.sub.commitmentSegments,
        resetState: undo.sub.resetState,
      })
      .where(eq(subscriptions.id, row.id));
    await syncMeterBilling(tx, row.id);
    await recomputeSubscriptionMrr(tx, row.id, input.now);
    const { revertPlanChangeCredits } = await import("@/modules/credits/service");
    const credits = await revertPlanChangeCredits(tx, {
      customerId: row.customerId,
      itemIds: undo.items.map((i) => i.id),
      prior: undo.grants,
      now: input.now,
    });

    const [after] = await tx.select().from(subscriptions).where(eq(subscriptions.id, row.id));
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "subscription_changed",
      data: buildEventData(
        "subscription_changed",
        { id: after!.publicId, status: after!.status },
        after!.resourceVersion,
      ),
    });
    await auditSubscription(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: "subscription.change_reverted",
      before,
      after: after!,
    });
    await voidReverted(
      tx,
      input.organizationId,
      input.businessId,
      input.invoicePublicId,
      input.notes,
    );
    log.info("plan change reverted after its invoice failed", {
      event: "subscription_change_reverted",
      subscription: row.publicId,
      grantsVoided: credits.voided,
      grantsRestored: credits.restored,
    });
    return true;
  });
}

type ExhaustedInvoice = { id: string; subscriptionId: string; customerId: string };

/** The invoice, if its collection ended `not_paid` / `exhausted` (a hard decline at once). */
async function exhausted(
  organizationId: string,
  businessId: string,
  invoicePublicId: string,
): Promise<ExhaustedInvoice | null> {
  const [row] = await withTenant(organizationId, (tx) =>
    tx
      .select({
        id: invoices.id,
        status: invoices.status,
        dunningStatus: invoices.dunningStatus,
        subscriptionId: invoices.subscriptionId,
        customerId: invoices.customerId,
      })
      .from(invoices)
      .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, invoicePublicId)))
      .limit(1),
  );
  if (row?.status !== "not_paid" || row.dunningStatus !== "exhausted" || !row.subscriptionId)
    return null;
  return { id: row.id, subscriptionId: row.subscriptionId, customerId: row.customerId };
}

/** The newest failed payment on the invoice, in the words the payer is shown. */
async function declineOf(
  organizationId: string,
  businessId: string,
  invoiceId: string,
): Promise<{ code: string; message: string }> {
  return withTenant(organizationId, async (tx) => {
    const [t] = await tx
      .select({ code: transactions.errorCode, text: transactions.errorText })
      .from(transactions)
      .where(
        and(
          eq(transactions.invoiceId, invoiceId),
          eq(transactions.type, "payment"),
          inArray(transactions.status, ["failed", "late_failed"]),
        ),
      )
      .orderBy(desc(transactions.occurredAt), desc(transactions.createdAt))
      .limit(1);
    const { storedPayerDeclineMessage } = await import("./decline-overrides");
    return {
      code: t?.code ?? "payment_failed",
      message: await storedPayerDeclineMessage(
        tx,
        { businessId, code: t?.code ?? null, message: t?.text ?? null },
        "The payment was not completed.",
      ),
    };
  });
}

/** The business's dunning final action, as a renewal invoice gets it. */
async function finalAction(
  organizationId: string,
  businessId: string,
  invoicePublicId: string,
  inv: ExhaustedInvoice,
  blocker: string,
): Promise<void> {
  log.info("invoice failed for good; the final action runs", {
    event: "change_final_action",
    invoice: invoicePublicId,
    reason: blocker,
  });
  const [sub] = await withTenant(organizationId, (tx) =>
    tx
      .select({ id: subscriptions.id, publicId: subscriptions.publicId })
      .from(subscriptions)
      .where(eq(subscriptions.id, inv.subscriptionId))
      .limit(1),
  );
  if (!sub) return;
  const { loadEffectiveDunningConfig } = await import("@/modules/dunning-policies/effective");
  const { applyDunningFinalAction } = await import("./dunning");
  const config = await withTenant(organizationId, (tx) =>
    loadEffectiveDunningConfig(tx, {
      businessId,
      customerId: inv.customerId,
      subscriptionId: sub.id,
    }),
  );
  await applyDunningFinalAction({
    organizationId,
    businessId,
    invoicePublicId,
    subscriptionId: sub.id,
    subscriptionPublicId: sub.publicId,
    config,
  });
}

/** `failed_change_charge: start_dunning`: an invoice exhausted at once gets the final action. */
export async function finalActionIfExhausted(
  organizationId: string,
  businessId: string,
  invoicePublicId: string,
): Promise<void> {
  const inv = await exhausted(organizationId, businessId, invoicePublicId);
  if (inv) await finalAction(organizationId, businessId, invoicePublicId, inv, "start_dunning");
}

/**
 * A change invoice whose charge ended dunning at once: revert the change (and void its invoice
 * and credit notes), or run the final action when it cannot be reverted exactly. Returns what
 * was reverted, or null.
 */
export async function settleExhaustedChange(
  input: { organizationId: string; businessId: string; now: Date },
  invoicePublicId: string,
  undo: ChangeUndo | undefined,
  notes: CreditNote[],
): Promise<RevertedCharge | null> {
  const { organizationId, businessId } = input;
  const inv = await exhausted(organizationId, businessId, invoicePublicId);
  if (!inv) return null;
  // A change's credit note (an upgrade's unused old term) is voided with it. Only one whose
  // credit sits on this invoice alone, or nowhere, can be: the invoice's void releases it.
  const notesFree = notes.length
    ? await withTenant(organizationId, async (tx) => {
        const rows = await tx
          .select({ id: creditNotes.id, refunded: creditNotes.refundedMinor })
          .from(creditNotes)
          .where(
            and(
              eq(creditNotes.businessId, businessId),
              inArray(
                creditNotes.publicId,
                notes.map((n) => n.publicId),
              ),
            ),
          );
        if (rows.length !== notes.length || rows.some((r) => r.refunded > 0n)) return false;
        const elsewhere = await tx
          .select({ id: creditNoteAllocations.id })
          .from(creditNoteAllocations)
          .where(
            and(
              inArray(
                creditNoteAllocations.creditNoteId,
                rows.map((r) => r.id),
              ),
              ne(creditNoteAllocations.invoiceId, inv.id),
            ),
          )
          .limit(1);
        return elsewhere.length === 0;
      })
    : true;
  let reverted = false;
  let failed = false;
  if (undo && !undo.blocker && notesFree) {
    try {
      reverted = await revertChange({
        organizationId,
        businessId,
        undo,
        invoicePublicId,
        notes,
        now: input.now,
      });
    } catch (e) {
      failed = true;
      log.error(e, { event: "change_revert_failed", invoice: invoicePublicId });
    }
  }
  if (!reverted) {
    const blocker = failed
      ? "revert_failed"
      : (undo?.blocker ?? (notesFree ? (undo ? "items_moved" : "no_undo") : "credit_note"));
    await finalAction(organizationId, businessId, invoicePublicId, inv, blocker);
    return null;
  }
  const decline = await declineOf(organizationId, businessId, inv.id);
  return {
    kind: "change",
    invoice: invoicePublicId,
    declineCode: decline.code,
    declineMessage: decline.message,
  };
}

/**
 * An item add whose own invoice ended dunning at once: delete the item and void the invoice in
 * one transaction, or run the final action when credit or usage is already booked on the item
 * or the void fails.
 */
export async function settleExhaustedAdd(input: {
  organizationId: string;
  businessId: string;
  itemId: string;
  invoicePublicId: string;
  now: Date;
}): Promise<RevertedCharge | null> {
  const { organizationId, businessId, invoicePublicId } = input;
  const inv = await exhausted(organizationId, businessId, invoicePublicId);
  if (!inv) return null;
  let outcome: "reverted" | "booked" | "gone" | "failed" = "gone";
  try {
    outcome = await withTenant(organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, inv.subscriptionId))
        .for("update")
        .limit(1);
      const [item] = await tx
        .select()
        .from(subscriptionItems)
        .where(eq(subscriptionItems.id, input.itemId))
        .for("update")
        .limit(1);
      if (!row || !item || item.subscriptionId !== row.id) return "gone" as const;
      const [grant] = await tx
        .select({ id: creditGrants.id })
        .from(creditGrants)
        .where(eq(creditGrants.subscriptionItemId, item.id))
        .limit(1);
      const [usage] = await tx
        .select({ id: usageRecords.id })
        .from(usageRecords)
        .where(eq(usageRecords.subscriptionItemId, item.id))
        .limit(1);
      if (grant || usage) return "booked" as const;
      const before = await subscriptionSnapshot(tx, row);
      await tx.delete(subscriptionItems).where(eq(subscriptionItems.id, item.id));
      await recomputeSubscriptionMrr(tx, row.id, input.now);
      await syncMeterBilling(tx, row.id);
      const [after] = await tx.select().from(subscriptions).where(eq(subscriptions.id, row.id));
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "subscription_changed",
        data: buildEventData(
          "subscription_changed",
          { id: after!.publicId, status: after!.status },
          after!.resourceVersion,
        ),
      });
      await auditSubscription(tx, {
        organizationId,
        businessId,
        action: "subscription.change_reverted",
        before,
        after: after!,
      });
      await voidReverted(tx, organizationId, businessId, invoicePublicId, []);
      return "reverted" as const;
    });
  } catch (e) {
    outcome = "failed";
    log.error(e, { event: "change_revert_failed", invoice: invoicePublicId });
  }
  if (outcome !== "reverted") {
    await finalAction(organizationId, businessId, invoicePublicId, inv, `item_add_${outcome}`);
    return null;
  }
  const decline = await declineOf(organizationId, businessId, inv.id);
  return {
    kind: "item_add",
    invoice: invoicePublicId,
    declineCode: decline.code,
    declineMessage: decline.message,
  };
}
