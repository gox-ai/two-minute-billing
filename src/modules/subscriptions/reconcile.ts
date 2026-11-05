/**
 * Reconcile a subscription's items against a DESIRED item list.
 *
 * Two surfaces both take "here is the item list I want" and work out the operations
 * themselves — `subscriptions/{id}/update_for_items` (API) and
 * `hosted_pages/checkout_existing_for_items` (buyer-facing). They must agree about
 * what a given list MEANS, so the reasoning lives here once rather than in each
 * caller.
 *
 * It also has to agree with itself across time: the buyer-facing preview and the
 * completion that follows it are two calls minutes apart, and a page that quotes one
 * figure and then charges another is the failure mode this module exists to prevent.
 *
 * Callers supply the list; this decides swap-vs-quantity-vs-add-vs-remove and drives
 * the engine primitives (`changeSubscription`, `addSubscriptionItem`,
 * `removeSubscriptionItem`). It deliberately does NOT decide policy — proration,
 * invoicing and term reset are passed through, because a trial upgrade and a paid
 * mid-term upgrade want opposite answers and neither is a default this layer can pick.
 */
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { auditSubscription, subscriptionSnapshot } from "@/modules/subscriptions/audit";
import { prices, products, subscriptionItems } from "@db/schema";
import { changeSubscription, type ItemChange } from "@/modules/subscriptions/proration";
import { addSubscriptionItem, removeSubscriptionItem } from "@/modules/subscriptions/items";
import { emitEvent, flushDeferredEvents, type DeferredEvents } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { subscriptions } from "@db/schema";

/** A live subscription item, flattened with its price + product kind. */
export interface LiveItem {
  itemPublicId: string;
  priceId: string; // internal
  pricePublicId: string;
  quantity: number;
  kind: string;
}

/** A line the caller wants the subscription to end up with. */
export interface DesiredItem {
  price: typeof prices.$inferSelect;
  quantity: number;
  kind: string;
}

/**
 * Load a subscription's live items. Items are hard-deleted on removal (there is
 * no soft-delete column), so every row is live — mirrors how proration.ts loads
 * a subscription's items.
 */
export async function loadLiveItems(
  organizationId: string,
  subscriptionId: string,
): Promise<LiveItem[]> {
  return withTenant(organizationId, async (tx) =>
    (
      await tx
        .select({
          itemPublicId: subscriptionItems.publicId,
          priceId: prices.id,
          pricePublicId: prices.publicId,
          quantity: subscriptionItems.quantity,
          kind: products.kind,
        })
        .from(subscriptionItems)
        .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
        .innerJoin(products, eq(products.id, prices.productId))
        .where(eq(subscriptionItems.subscriptionId, subscriptionId))
    ).map((r) => ({ ...r })),
  );
}

/**
 * Turn a desired item list into engine operations.
 *
 * Per requested line:
 *  - the subscription already has that exact price → change its QUANTITY
 *  - the line is a PLAN and the subscription has a (different) plan item →
 *    re-point that item's price: a plan SWAP, never a second plan
 *  - otherwise → ADD the item
 *
 * `replaceItemsList` selects between the two readings of the same list — and it is a
 * flag rather than an inference because the two are indistinguishable from the list
 * alone, while their outcomes differ by the customer's whole add-on set:
 *
 *  - false (the default on BOTH surfaces) — UPSERT.
 *    Unlisted items are left alone. Right for "add a seat" or a coupon-only page.
 *  - true (`replace_items_list=true`) — the list is EXHAUSTIVE. Unlisted
 *    **non-plan** items are removed. Right when the caller is submitting a complete
 *    configuration, where omitting a line is how the UI says "I removed this".
 *
 * `explicitRemovals` (`mandatory_items_to_remove`) drops named PRICE public ids
 * regardless of the mode — the way an upsert caller expresses a removal without
 * having to claim its list is exhaustive.
 *
 * The plan is never removed by either mechanism. A subscription without a plan is not
 * a downgrade, it is a broken subscription that bills nothing; a plan change is
 * already expressed as the swap above.
 */
export function planItemOperations(
  live: LiveItem[],
  desired: DesiredItem[],
  opts: { replaceItemsList?: boolean; explicitRemovals?: string[] } = {},
): {
  changes: ItemChange[];
  additions: Array<{ price: typeof prices.$inferSelect; quantity: number }>;
  removals: LiveItem[];
} {
  const changes: ItemChange[] = [];
  const additions: Array<{ price: typeof prices.$inferSelect; quantity: number }> = [];
  const livePlan = live.find((l) => l.kind === "plan");
  for (const line of desired) {
    const existing = live.find((l) => l.priceId === line.price.id);
    if (existing) {
      // Same price already on the sub → this is a quantity change (a no-op if equal).
      if (existing.quantity !== line.quantity) {
        changes.push({ itemId: existing.itemPublicId, newQuantity: line.quantity });
      }
      continue;
    }
    if (line.kind === "plan" && livePlan) {
      changes.push({
        itemId: livePlan.itemPublicId,
        newPriceId: line.price.publicId,
        newQuantity: line.quantity,
      });
      continue;
    }
    additions.push({ price: line.price, quantity: line.quantity });
  }

  // Compared by internal price id — the same key the match above uses, so an item can
  // never be counted as both kept and removed.
  const desiredPriceIds = new Set(desired.map((d) => d.price.id));
  const named = new Set(opts.explicitRemovals ?? []);
  const removals = live.filter((l) => {
    if (l.kind === "plan") return false;
    if (named.has(l.pricePublicId)) return true;
    return opts.replaceItemsList === true && !desiredPriceIds.has(l.priceId);
  });
  return { changes, additions, removals };
}

/**
 * Execute the operations `planItemOperations` derived.
 *
 * Order is load-bearing, not incidental: **swap → add → remove**.
 *
 * Removals run last because what MAY be removed depends on which plan the
 * subscription is on — `removeSubscriptionItem` refuses an add-on that is mandatory
 * for the current plan (CAT-3). Removing before the swap would test the OLD plan's
 * mandatory set, and could reject an add-on the new plan does not require (or permit
 * one it does). Swapping first makes that guard answer for the plan the customer is
 * actually moving to.
 */
export async function applyItemOperations(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  now: Date;
  ops: ReturnType<typeof planItemOperations>;
  /** Passed through, never defaulted here — see the module note on policy. */
  resetTerm?: boolean;
  /**
   * `prorate`. Passed through to `changeSubscription`, never defaulted here.
   * It used to be collapsed into `invoiceImmediately: false` by the route, because the
   * engine had no no-proration mode — which DEFERRED the money rather than suppressing
   * it, so a caller asking for no proration still got charged, just on the next invoice.
   */
  prorate?: boolean;
  invoiceImmediately?: boolean;
  /**
   * Metadata to REPLACE once every leg has succeeded; omitted leaves it alone, `null` clears.
   * Written in the summary transaction, so the one `subscription_changed` carries it and a
   * metadata-only edit still announces itself. The caller checks the metadata rules first.
   */
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  const { organizationId, businessId, subscriptionId, now, ops } = input;

  /**
   * ONE `subscription_changed` for the whole reconcile.
   *
   * Each primitive below emits its own, and each is right on its own: a standalone
   * `POST …/items` or `DELETE …/items/:id` is a `subscription_changed`. Composed, they
   * were not — a destination switch is a change plus an add plus a remove, so ONE buyer
   * action produced THREE identical `subscription_changed` events (observed 2026-08-27),
   * which counted our implementation steps rather than the customer's decision.
   *
   * ⚠️ The rule is NOT "exactly one event per change". It is narrower, and stands on its
   * own: three IDENTICAL events describing one decision, differing only by which internal
   * step raised them, tell a consumer nothing it can act on and invite it to react three
   * times.
   *
   * So the legs buffer instead of emitting, and one summary event is emitted here.
   */
  const buffered: DeferredEvents = [];

  try {
    // A swap/quantity change goes through changeSubscription in ONE call, so the engine
    // prorates the whole set together (one credit note + one invoice) rather than once
    // per line.
    // ── REMOVALS TRAVEL WITH THE CHANGE, NOT AFTER IT (money bug, 2026-08-31) ──────
    // `changeSubscription` takes `removes` and applies changes + removes in ONE
    // transaction, folding every line they produce into ONE document. Running the
    // removals as a separate leg AFTER it means the change never learns about them —
    // and on a TERM RESET that is a live overcharge, because the reset's charge loop
    // bills "the FULL new-term price for every POST-change item" and decides what is
    // post-change from `removedItemIds`, which is empty when the removes arrive later.
    // The `continue` that exists precisely to stop this (proration.ts, "This single line
    // is what stops the five-document edit from billing a year of something it removes
    // in the same call") cannot fire.
    //
    // Measured on real data 2026-08-31, driving the checkout for
    // `sub_XXXXXXXXXXXXXXXXXXXXXX03`: the page rendered "Additional Connections × 60 —
    // Removed" and INV-5369 billed it ₹45,120.00 + tax = **₹53,241.60** on the new term,
    // for an item the same call deleted from `subscription_items`. Reduced to a fixture
    // in `verify:update-for-items` (§ RESET+REMOVE) as plan swap + reset + one removed
    // per-unit add-on: the new-term invoice read $350.00 (plan $300 + seats $50) where
    // $300.00 is owed.
    //
    // THE ORDERING PROPERTY IS NOT LOST. The docblock above keeps removals last so CAT-3
    // is tested against the plan being moved TO, not the one being left. `changeSubscription`
    // already does exactly that for its own `removes` — "against the POST-change plan set…
    // which is what lets one atomic call do what three could not" — and names this file as
    // getting the same property the other way. So the guard is preserved by construction,
    // and the standalone loop below now handles only removals with no change to ride with.
    const ridingRemovals = ops.changes.length > 0 ? ops.removals : [];
    const standaloneRemovals = ops.changes.length > 0 ? [] : ops.removals;
    if (ops.changes.length > 0) {
      await changeSubscription({
        organizationId,
        businessId,
        subscriptionId,
        now,
        changes: ops.changes,
        removes: ridingRemovals.map((r) => r.itemPublicId),
        resetTerm: input.resetTerm,
        prorate: input.prorate,
        invoiceImmediately: input.invoiceImmediately,
        deferEventsTo: buffered,
      });
    }
    for (const add of ops.additions) {
      await addSubscriptionItem({
        organizationId,
        businessId,
        subscriptionId,
        price: add.price,
        quantity: add.quantity,
        invoiceImmediately: input.invoiceImmediately,
        now,
        deferEventsTo: buffered,
      });
    }
    // Only the removals that had no change to ride with — the rest were applied inside
    // `changeSubscription` above, in one transaction with the lines they affect.
    for (const gone of standaloneRemovals) {
      await removeSubscriptionItem({
        organizationId,
        businessId,
        subscriptionId,
        itemPublicId: gone.itemPublicId,
        now,
        deferEventsTo: buffered,
      });
    }
  } catch (e) {
    /**
     * A leg refused PART WAY. The legs before it are committed — each runs in its own
     * transaction, which is what lets each fold its own proration correctly — so their
     * events must still land, or state has moved with nobody told.
     *
     * Deliberately the per-leg events rather than a summary: on this path there is no
     * single coherent outcome to summarise, and the granular ones say exactly how far
     * the reconcile got.
     */
    await flushDeferredEvents(organizationId, buffered);
    throw e;
  }

  // Nothing moved — no event. An empty reconcile is a no-op, and announcing a change
  // that changed nothing is how a consumer ends up reacting to its own polling.
  if (buffered.length === 0 && input.metadata === undefined) return;

  /**
   * The summary. Read the row back rather than reusing anything from the legs: they
   * wrote the status, the term and the cached MRR, and `resource_version` has moved —
   * an event carrying the version we planned from would describe a row that no longer
   * exists.
   */
  await withTenant(organizationId, async (tx) => {
    const [read] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    if (!read) return;
    let sub = read;
    const metadataChanged =
      input.metadata !== undefined && !isDeepStrictEqual(read.metadata ?? null, input.metadata);
    if (metadataChanged) {
      const before = await subscriptionSnapshot(tx, read);
      const [row] = await tx
        .update(subscriptions)
        .set({ metadata: input.metadata, updatedAt: new Date() })
        .where(eq(subscriptions.id, subscriptionId))
        .returning();
      sub = row!;
      await auditSubscription(tx, {
        organizationId,
        businessId,
        action: "subscription.update",
        before,
        after: sub,
      });
    }
    if (buffered.length === 0 && !metadataChanged) return;
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "subscription_changed",
      data: buildEventData(
        "subscription_changed",
        {
          id: sub.publicId,
          status: sub.status,
          // What the reconcile actually did, so a consumer does not have to diff the
          // subscription to find out — the detail the three separate events carried
          // between them, on the one event that replaces them.
          items_changed: ops.changes.length,
          items_added: ops.additions.map((a) => a.price.publicId),
          items_removed: ops.removals.map((r) => r.pricePublicId),
        },
        sub.resourceVersion,
        // Metadata alone is a settings change: announced, but not emailed to the customer.
        buffered.length === 0 ? { settings_only: true } : undefined,
      ),
    });
  });
}

/** Resolve `price public id → { price row, product kind }` for a desired list. */
export async function resolveDesiredItems(
  organizationId: string,
  businessId: string,
  lines: Array<{ price: string; quantity?: number }>,
): Promise<DesiredItem[]> {
  return withTenant(organizationId, async (tx) => {
    const out: DesiredItem[] = [];
    for (const line of lines) {
      const [row] = await tx
        .select({ price: prices, kind: products.kind })
        .from(prices)
        .innerJoin(products, eq(products.id, prices.productId))
        .where(and(eq(prices.publicId, line.price), eq(prices.businessId, businessId)))
        .limit(1);
      if (!row) throw new ItemReconcileError(`We could not find the price ${line.price}.`);
      out.push({ price: row.price, quantity: line.quantity ?? 1, kind: row.kind });
    }
    return out;
  });
}

export class ItemReconcileError extends Error {}
