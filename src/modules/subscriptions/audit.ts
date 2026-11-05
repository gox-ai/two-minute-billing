/**
 * 0149 — audit writes for the subscription lifecycle.
 *
 * A subscription is the resource our audit log recorded almost nothing about: before
 * this, `subscription.cancel` was the ONLY audited subscription action out of
 * fourteen. Everything else — activation,
 * plan and quantity changes, pause, resume, reactivate, trial and term edits — had
 * no actor, no origin IP and no diff anywhere in the product.
 *
 * The wrapper exists because there are fourteen call sites and the interesting part
 * (build a snapshot, diff it, name the resource, join the caller's transaction) is
 * identical at every one. Hand-writing it fourteen times is how the changed-field
 * map and the snapshot drift apart — the diff says one thing, the record another.
 */
import { and, asc, eq } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { writeAuditLog } from "@/modules/audit/service";
import { auditSnapshot, changedFields } from "@/modules/audit/snapshot";
import { renewalSkips, subscriptions, subscriptionItems } from "@db/schema";

/** The subscription's items, in the snapshot's shape. */
export async function snapshotItems(
  tx: Tx,
  subscriptionId: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = await tx
    .select()
    .from(subscriptionItems)
    .where(eq(subscriptionItems.subscriptionId, subscriptionId))
    .orderBy(subscriptionItems.id);
  return rows.map((r) => auditSnapshot(r as unknown as Record<string, unknown>));
}

/**
 * The full body of a subscription: the row plus its items.
 *
 * Items are part of "the record" as anyone reading an audit log means it — a plan
 * change IS an item change, and a diff that showed only the row would report a
 * quantity increase as no change at all. They live in their own table, so they are
 * merged in here rather than being reachable from the row.
 */
export async function subscriptionSnapshot(
  tx: Tx,
  row: typeof subscriptions.$inferSelect,
): Promise<Record<string, unknown>> {
  // Scheduled skips are part of what the subscription will do, so a skip shows in the diff.
  const skips = await tx
    .select({ at: renewalSkips.renewalAt })
    .from(renewalSkips)
    .where(and(eq(renewalSkips.subscriptionId, row.id), eq(renewalSkips.status, "scheduled")))
    .orderBy(asc(renewalSkips.renewalAt));
  return auditSnapshot(row as unknown as Record<string, unknown>, {
    items: await snapshotItems(tx, row.id),
    skipped_renewals: skips.map((s) => s.at.toISOString()),
  });
}

/**
 * Audit one subscription change.
 *
 * `before` is the snapshot taken BEFORE the mutation — `null` means the
 * subscription did not exist yet, which is what makes the reader see the created
 * record's body rather than a diff against nothing. Pass `undefined` (omit it) when
 * the call site genuinely has no before-state available and a second read purely to
 * audit isn't worth it; the row is then written with the changed fields the caller
 * supplies in `before`/`after` and no snapshot at all.
 *
 * `after` is the post-mutation row; its snapshot is taken here, inside the caller's
 * transaction, so it reflects exactly what was committed.
 */
export async function auditSubscription(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    action: string;
    before: Record<string, unknown> | null;
    after: typeof subscriptions.$inferSelect;
  },
): Promise<void> {
  const afterFull = await subscriptionSnapshot(tx, input.after);
  const beforeFull = input.before;
  // A creation has nothing to diff, so the changed-field map IS the record. That
  // keeps the summary above the diff useful ("created with plan X, quantity 2")
  // instead of listing every column the row happens to have.
  const changed = beforeFull
    ? changedFields(beforeFull, afterFull)
    : { before: {}, after: afterFull };
  await writeAuditLog(
    {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: input.action,
      resourceType: "subscription",
      resourceId: input.after.publicId,
      before: changed.before,
      after: changed.after,
      beforeFull,
      afterFull,
    },
    tx,
  );
}

/**
 * A subscription's snapshot read in its own tenant transaction.
 *
 * For the multi-step operations that deliberately span several transactions — the
 * cancel option set invoices unbilled charges, cancels, issues a credit note and
 * settles open invoices as separate units of work — so there is no single `tx` to
 * hang a snapshot on. Returns null if the row is gone (a hard cancel that deleted a
 * provisional subscription), which the caller records as an absent snapshot rather
 * than failing the operation it was auditing.
 */
export async function snapshotSubscriptionById(
  organizationId: string,
  subscriptionId: string,
): Promise<Record<string, unknown> | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    return row ? subscriptionSnapshot(tx, row) : null;
  });
}

/**
 * Snapshot + audit in one call, for the many lifecycle functions that mutate with a
 * single `UPDATE … RETURNING` and so have no before-row in hand.
 *
 * Takes the snapshot, runs `mutate`, and audits the result. The extra read is the
 * price of a diff with context, and it is inside the caller's transaction — so the
 * before-state is the one the mutation actually applied to, not a racy earlier read.
 * Returns whatever `mutate` returned; `null` (nothing updated) writes no audit row.
 */
export async function auditedSubscriptionUpdate<T extends typeof subscriptions.$inferSelect | null>(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    subscriptionPublicId: string;
    action: string;
    mutate: () => Promise<T>;
  },
): Promise<T> {
  const [current] = await tx
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.businessId, input.businessId),
        eq(subscriptions.publicId, input.subscriptionPublicId),
      ),
    )
    .limit(1);
  const before = current ? await subscriptionSnapshot(tx, current) : null;
  const result = await input.mutate();
  if (!result) return result;
  await auditSubscription(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    action: input.action,
    // `current` missing means the row appeared during this transaction, i.e. it was
    // created — not "no context available".
    before,
    after: result,
  });
  return result;
}
