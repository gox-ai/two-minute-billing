import { syncMeterBilling } from "./meter-billing";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { businessTimezone } from "@/platform/business-tz";
import {
  clampLimit,
  countExpr,
  filterConditions,
  keysetCondition,
  kindsFromSpecs,
  opsFromSpecs,
  pageOrder,
  parseCursor,
  toPage,
  type FilterSpec,
  type ListFilter,
  type ListPage,
} from "@/platform/list-query";
import {
  fixedChargeMinor,
  snapshotPrice,
  ratableFromSnapshot,
  ratableForItem,
  isOverridable,
  priceLabel,
  alignSnapshotToCycle,
  type PriceSnapshot,
} from "@/modules/catalog/pricing";
import {
  createInvoiceFromLines,
  previewInvoiceFromLines,
  USAGE_SETTLEMENT,
} from "@/modules/invoicing/service";
import type { CustomerBalances } from "@/modules/customers/balances";
import { resolveDifferential, findMandatoryItemIds } from "@/modules/catalog/service";
import { peekDiscounts } from "@/modules/coupons/service";
import {
  prorate,
  issueCurrentTermCredit,
  billsAtTrialEnd,
  rethrowCreditNoteErrorAsProration,
  ProrationConflictError,
  defaultInvoiceImmediately,
  planRemovedItemUnbilledSettlements,
  applyUnbilledChargeSettlements,
} from "./proration";
import {
  SubscriptionError,
  cadenceMismatch,
  recomputeSubscriptionMrr,
  requireTerm,
} from "./service";
import { loadBillingMode, prorationWindowStart } from "@/modules/subscriptions/billing-mode";
import { settleMeteredUsage } from "./usage-settlement";
import { COMMITMENT_CHARGE } from "./commitment";
import { emitEvent, emitOrDefer, type DeferredEvents } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import {
  subscriptions,
  subscriptionItems,
  prices,
  products,
  customers,
  invoices,
  invoiceLineItems,
  payments,
  unbilledCharges,
  attachedItems,
  subscriptionChargeLog,
  creditNotes,
} from "@db/schema";
import type { Tx } from "@/platform/db";
import { createLogger } from "@/platform/logger";

const log = createLogger("subscriptions");

/**
 * Fire-once claim on an event-driven attached-item charge (G backlog + Phase H).
 * Inserts a subscription_charge_log row guarded by its unique index; returns true
 * if THIS call claimed it (safe to charge), false if it was already fired. Makes
 * activation / trial_start / charge_once on_demand idempotent under travel re-runs.
 */
export async function claimAttachedItemCharge(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    subscriptionId: string;
    itemProductId: string;
    chargeEvent: string;
    invoiceId?: string | null;
  },
): Promise<boolean> {
  const inserted = await tx
    .insert(subscriptionChargeLog)
    .values({
      organizationId: input.organizationId,
      businessId: input.businessId,
      subscriptionId: input.subscriptionId,
      itemProductId: input.itemProductId,
      chargeEvent: input.chargeEvent,
      invoiceId: input.invoiceId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: subscriptionChargeLog.id });
  return inserted.length > 0;
}

/**
 * CP-6: resolve a differential price for an addon being attached to a subscription.
 * Returns the differential amount (minor units) when the added price's product is an
 * addon, the subscription has a plan item, and a differential row exists for
 * (addon, plan, currency, interval) — else null (caller uses the base price).
 */
export async function resolveDifferentialForAddTx(
  tx: Tx,
  subscriptionId: string,
  price: typeof prices.$inferSelect,
): Promise<{ amountMinor: bigint | null; tiers: unknown | null } | null> {
  // The subscription's plan product (item whose price's product is kind='plan').
  const planRows = await tx
    .select({ planId: products.id })
    .from(subscriptionItems)
    .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .innerJoin(products, eq(prices.productId, products.id))
    .where(and(eq(subscriptionItems.subscriptionId, subscriptionId), eq(products.kind, "plan")))
    .limit(1);
  const planId = planRows[0]?.planId;
  if (!planId) return null;
  return resolveDifferentialAgainstPlanTx(tx, planId, price);
}

/**
 * The same differential lookup, against an EXPLICIT plan product.
 *
 * Split out because the CHANGE path must resolve against the plan the subscription will
 * have AFTER the change, which is not always the one it has now — resolving against the
 * current plan is right only while the same call leaves the plan alone.
 */
export async function resolveDifferentialAgainstPlanTx(
  tx: Tx,
  planProductId: string,
  price: typeof prices.$inferSelect,
): Promise<{ amountMinor: bigint | null; tiers: unknown | null } | null> {
  const [addonProd] = await tx
    .select({ id: products.id, kind: products.kind })
    .from(products)
    .where(eq(products.id, price.productId))
    .limit(1);
  if (!addonProd || addonProd.kind !== "addon") return null;
  return resolveDifferential(tx, addonProd.id, planProductId, price.currency, price.interval);
}

/**
 * The rate a differential-priced item freezes, WITHOUT cadence alignment.
 *
 * Deliberately un-aligned: the change path folds onto the POST-change cycle afterwards, and
 * `effectiveAddSnapshotTx` folds onto the subscription's CURRENT one internally — so reusing
 * that helper on the change path would both fold against the wrong cadence and fold twice.
 * This is the shared half: resolve the rate, let the caller decide the cycle.
 *
 * The order mirrors `effectiveAddSnapshotTx` exactly (tiers beat amount, amount only where
 * the model is overridable), because the two must freeze the same rate or an add-on's price
 * depends on which endpoint attached it.
 */
export function snapshotWithDifferential(
  price: typeof prices.$inferSelect,
  diff: { amountMinor: bigint | null; tiers: unknown | null } | null,
): PriceSnapshot {
  if (diff?.tiers != null) return snapshotPrice(price, undefined, diff.tiers);
  if (diff?.amountMinor != null && isOverridable(price.model))
    return snapshotPrice(price, Number(diff.amountMinor));
  return snapshotPrice(price);
}

/**
 * The price snapshot an ADD will freeze: an explicit override wins; otherwise a
 * plan-scoped differential (a tiered differential overrides the tier table, a
 * flat/per-unit one the amount); otherwise the catalog price.
 *
 * Exported in tx-taking form so `estimateChange` can preview the SAME number this
 * path books, from inside its own transaction. This must never be reimplemented
 * there: a "differential" add-on carries a catalog list price of **0** with the real
 * amount held per (add-on, plan, currency, interval), so a parallel calculation
 * previews ₹0.00 and then bills ₹475.00 — the 2026-08-02 bug, one layer up.
 */
export async function effectiveAddSnapshotTx(
  tx: Tx,
  subscriptionId: string,
  price: typeof prices.$inferSelect,
  customAmountMinor?: number | null,
  /**
   * The plan product the subscription will have AFTER this call, when the SAME call is also
   * changing the plan. Omit it whenever the plan is not moving.
   *
   * ── WHY THIS PARAMETER EXISTS (2026-09-01) ────────────────────────────────────────
   * Without it this function resolved the differential against the plan **currently stored
   * on the subscription**, which during a plan change is still the OUTGOING one. So an
   * add-on added in the same edit as a plan change was contracted at the old plan's rate:
   * measured by `verify:proration` § G at 900 on a PRO→BUSINESS edit where 600 is
   * contracted, and 600 on the reverse where 900 is. **Both directions read the outgoing
   * plan**, so it was not a preference for the cheaper or the dearer rate — it was literally
   * the stale one, and the over-charge RECURS because the frozen `price_snapshot` feeds every
   * later renewal.
   *
   * `resolveDifferentialForAddTx`'s own sibling docblock already stated the rule this broke:
   * *"the CHANGE path must resolve against the plan the subscription will have AFTER the
   * change, which is not always the one it has now."* The changed-lines branch obeyed it via
   * `resolveDifferentialAgainstPlanTx(tx, postPlanProductId, …)`; the added-lines branch did
   * not. The adds branch was already post-change-aware for CADENCE — it validates against
   * `postCycle` — so it was post-change for the cycle and pre-change for the plan.
   *
   * ── WHY AN OVERRIDE HERE RATHER THAN INLINING THE RESOLUTION AT THE CALL SITES ─────
   * `estimate.ts` calls this function precisely so the preview cannot drift from the booking
   * ("the booking's own resolver, so the differential / cadence resolution cannot drift").
   * Inlining `resolveDifferentialAgainstPlanTx` + `snapshotWithDifferential` at both sites
   * would create two copies to keep identical by hand — which is exactly how the
   * changed/added asymmetry arose in the first place. One resolver, one optional argument.
   *
   * `addSubscriptionItem` (the third caller, adding to a subscription whose plan is not
   * moving) correctly passes nothing and keeps the stored-plan behaviour.
   */
  postPlanProductId?: string | null,
): Promise<PriceSnapshot> {
  let effectiveOverride = customAmountMinor;
  let effectiveTiers: unknown = undefined;
  if (effectiveOverride == null) {
    const diff = postPlanProductId
      ? await resolveDifferentialAgainstPlanTx(tx, postPlanProductId, price)
      : await resolveDifferentialForAddTx(tx, subscriptionId, price);
    if (diff?.tiers != null) effectiveTiers = diff.tiers;
    else if (diff?.amountMinor != null && isOverridable(price.model))
      effectiveOverride = Number(diff.amountMinor);
  }
  // …then folded into the subscription's cycle if it bills more often than it
  // (monthly add-on on a yearly plan → ×12). Order matters:
  // the differential/override supplies the RATE, the cadence multiple scales it.
  const [sub] = await tx
    .select({
      interval: subscriptions.billingPeriodUnit,
      intervalCount: subscriptions.billingPeriod,
    })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))
    .limit(1);
  return alignSnapshotToCycle(snapshotPrice(price, effectiveOverride, effectiveTiers), {
    interval: sub?.interval ?? "month",
    intervalCount: sub?.intervalCount ?? 1,
  });
}

type Invoice = typeof invoices.$inferSelect;
type CreditNote = typeof creditNotes.$inferSelect;
type Payment = typeof payments.$inferSelect;

/**
 * The start of the proration window for mid-period item add/remove. With WHOLE-DAY
 * proration the window start is the start of the current billing day (a
 * same-day-as-term-start add bills the full term and its `dateFrom` = term start);
 * `exact` businesses keep exact-timestamp proration. The
 * billing-day grid itself is billing-mode.ts's problem, not this module's.
 */
async function itemProrationWindowStart(
  orgId: string,
  businessId: string,
  now: Date,
  termStart: Date | null,
): Promise<Date> {
  const mode = await loadBillingMode(orgId, businessId);
  return prorationWindowStart(now, termStart, mode);
}

async function loadSubAndCustomer(orgId: string, subscriptionId: string) {
  return withTenant(orgId, async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    if (!sub) throw new SubscriptionError("Subscription not found");
    const [cus] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, sub.customerId))
      .limit(1);
    return { sub, customer: cus ?? null };
  });
}

/**
 * Add an item (add-on/charge) to a subscription mid-period. Inserts the item with
 * a price snapshot, then bills it now: a RECURRING price is prorated to the
 * remaining period, a ONE-TIME price is charged in FULL (it buys no span of time,
 * so there is no remainder to slice — see the branch below).
 */
export async function addSubscriptionItem(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  price: typeof prices.$inferSelect;
  quantity: number;
  /**
   * Buffer this operation's `subscription_changed` instead of emitting it.
   *
   * Supplied by `applyItemOperations`, which composes up to three of these calls for ONE
   * logical change and must not announce three. See the coalescing note there.
   */
  deferEventsTo?: DeferredEvents;
  /** Subscription-level custom price (overrides the flat/per-unit catalog amount). */
  customAmountMinor?: number | null;
  /**
   * Where this add's prorated charge lands — the same Invoicing Option `/change`
   * carries. `true` raises the invoice now and collects it; `false` queues the line as
   * an `unbilled_charge` folded into the next renewal, where tax, coupons and the
   * customer's credit balances are applied.
   *
   * OMITTED resolves `businesses.default_invoice_immediately`, exactly as
   * `changeSubscription` and `changeTermEnd` do. That shared resolution is the point:
   * a composition edit is applied as up to THREE calls (`/change`, `POST …/items`,
   * `DELETE …/items/:id`), and until this existed the middle one always invoiced — so
   * a deferred change could not include an ADD, and the change form had to refuse the
   * combination outright rather than defer half an edit and state a total it could not
   * honour.
   *
   * A REMOVAL needs no equivalent: it only ever credits, and a credit is issued
   * immediately either way — the credit is money already owed, not a charge being
   * scheduled.
   */
  invoiceImmediately?: boolean;
  now: Date;
}): Promise<{
  item: typeof subscriptionItems.$inferSelect;
  invoice: Invoice | null;
  payment: Payment | null;
  /** Set only on the deferred branch — the rows queued instead of an invoice. */
  unbilledCharges?: Array<typeof unbilledCharges.$inferSelect>;
}> {
  const { organizationId, businessId, now } = input;
  const { sub, customer } = await loadSubAndCustomer(organizationId, input.subscriptionId);
  if (input.price.currency !== sub.currency)
    throw new SubscriptionError("Item currency must match the subscription currency");
  // The cadence guard is the currency guard's twin: the subscription bills on one
  // cycle, so an item priced on a different one gets charged its own amount at the
  // SUBSCRIPTION's frequency (a yearly add-on billed monthly = 12× the list price).
  const cadenceReason = cadenceMismatch(
    input.price,
    sub.billingPeriodUnit ?? "month",
    sub.billingPeriod ?? 1,
    { monthlyUsage: sub.billUsageMonthly },
  );
  if (cadenceReason) throw new SubscriptionError(cadenceReason);
  if (input.customAmountMinor != null) {
    if (!isOverridable(input.price.model)) {
      throw new SubscriptionError(
        `You can set a custom price only on a flat or per_unit price. This price is ${input.price.model}.`,
      );
    }
    if (input.customAmountMinor < 0)
      throw new SubscriptionError("unit_price_minor must be 0 or more");
  }

  // CP-6/CAT-7: an explicit override wins; otherwise a plan-scoped differential —
  // a tiered differential overrides the tier table, a flat/per-unit one the amount.
  // Shared with `estimateChange` so the preview cannot drift from this booking.
  const snapshot = await withTenant(organizationId, (tx) =>
    effectiveAddSnapshotTx(tx, input.subscriptionId, input.price, input.customAmountMinor),
  );
  // The insert, the cached-MRR recompute and the `subscription_changed` event are ONE
  // transaction: they are three descriptions of a single composition change, and the
  // MRR recompute used to run in a transaction of its own — so a failure between them
  // left the item on the subscription with the cached revenue figure (what the list
  // SHOWS, sorts and filters on) still describing the item set before it, and no event
  // to reconcile from. Unlike the removal path this one owes no CREDIT, so there is no
  // credit-note refusal to be atomic with; the prorated CHARGE deliberately stays
  // outside, below — `createInvoiceFromLines` collects from a gateway and a network
  // call must never be held open inside a DB transaction.
  const item = await withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .insert(subscriptionItems)
      .values({
        organizationId,
        businessId,
        subscriptionId: sub.id,
        publicId: publicId("si"),
        priceId: input.price.id,
        quantity: input.quantity,
        priceSnapshot: snapshot,
      })
      .returning();
    // The item list is part of the subscription's recurring composition, so its
    // cached MRR must be recomputed on add: an add-on with a plan-scoped
    // differential (base 0 → 4900 in the snapshot) or per_unit×qty otherwise
    // never lands in MRR. Snapshot-aware — see computeSubscriptionMrr.
    await recomputeSubscriptionMrr(tx, sub.id, now);
    await syncMeterBilling(tx, sub.id);
    // The item list is part of the subscription, so an item add/remove fires
    // subscription_changed.
    await emitOrDefer(
      tx,
      {
        organizationId,
        businessId,
        type: "subscription_changed",
        data: buildEventData(
          "subscription_changed",
          { id: sub.publicId, status: sub.status, item_added: input.price.publicId },
          sub.resourceVersion,
        ),
      },
      input.deferEventsTo,
    );
    return row!;
  });

  // With whole-day proration the window starts at the start of the current billing
  // day. Same-day-as-term-start add ⇒ full-term charge + line
  // `dateFrom` = term start. Exact proration ⇒ the exact instant.
  const from = await itemProrationWindowStart(
    organizationId,
    businessId,
    now,
    sub.currentPeriodStart,
  );
  // Added items carry no item-level free quantity; the price's applies.
  const fullAmount = fixedChargeMinor(
    snapshot,
    ratableFromSnapshot(snapshot, null),
    input.quantity,
  );
  // ── ONE-TIME vs RECURRING (bug, 2026-08-03) ────────────────────────────────
  // A `one_time` price buys no span of time, so there is no "unused remainder" to
  // slice: its amount is the whole fee. This path used to prorate UNCONDITIONALLY
  // — the ternary below guarded only the trial case, never the price TYPE — so a
  // ₹5,000 one-off added halfway through a monthly term billed ≈₹2,500 and the
  // line read "… - Prorated Charges" with `kind: 'proration'`. Every OTHER
  // one-time path in this file already bills the full amount as `kind: 'one_time'`
  // (`fireActivationCharges`, `triggerAttachedItemCharge`, `addAdHocCharges`);
  // this was the lone dissenter, and it under-billed real money.
  // `snapshot.type` is the price type frozen at attach (catalog/pricing.ts), so the
  // decision is made from the same immutable record the amount is rated from.
  const isOneTime = snapshot.type === "one_time";
  // TRIAL GATE (see proration.billsAtTrialEnd): nothing has been billed on this
  // subscription, and `currentPeriodStart..currentPeriodEnd` is the TRIAL window —
  // prorating across it charges a slice of free time. The add-on is added; it is
  // first billed, in full, by the trial-end renewal.
  //
  // A ONE-TIME add in trial defers too, deliberately: `planSubscriptionPeriodInvoice`
  // rates every non-metered item from its snapshot and labels a `one_time` snapshot
  // `kind: 'one_time'` (invoicing/service.ts), so the trial-end conversion invoice
  // bills this fee IN FULL — nothing is lost by waiting. That keeps it consistent
  // with the other charges that ride a trial (`fireActivationCharges` fires on the
  // trial→active transition, i.e. at trial end) and keeps `estimateChange`'s
  // in-trial preview — full price, `immediate_charge: false`, `due_at_trial_end` —
  // exactly true. Charging it now would make the shipped preview a lie. The one
  // supported way to take money during a trial stays what it was: an explicit
  // one-time charge with `invoice_immediately`, via `addAdHocCharges`.
  const amountDue = billsAtTrialEnd(sub)
    ? 0n
    : isOneTime
      ? fullAmount
      : prorate(fullAmount, from, requireTerm(sub).start, requireTerm(sub).end);
  if (amountDue <= 0n) return { item, invoice: null, payment: null };

  // ── INVOICING OPTION: invoice now, or queue as an unbilled charge ───────────
  // Resolved here, not at the route, so every caller obeys one rule — and the SAME
  // rule `/change` obeys, since the two are halves of one composition edit.
  // 0242: a one-time fee and a mid-term item add are different rows on the
  // unbilled-charges screen, and `isOneTime` is already resolved above, so ask for the
  // one that applies rather than collapsing both onto one preference.
  const invoiceImmediately =
    input.invoiceImmediately ??
    (await defaultInvoiceImmediately(
      organizationId,
      businessId,
      isOneTime ? "onOneTimeCharge" : "onChange",
    ));

  // The item's PRODUCT, for both branches below. Its `kind` resolves the deferred row's
  // `entity_type`; its `name` is what the line is called when the price carries neither an
  // `external_name` nor a `name` — which is every platform price, so without it the line
  // printed the internal handle on a document the customer reads.
  const [product] = await withTenant(organizationId, (tx) =>
    tx
      .select({ kind: products.kind, name: products.name })
      .from(prices)
      .innerJoin(products, eq(prices.productId, products.id))
      .where(eq(prices.id, input.price.id))
      .limit(1),
  );

  if (!invoiceImmediately) {
    // The same single line, queued instead of invoiced. It carries the service window
    // the immediate invoice would have carried, so a deferred slice is still recognised
    // over the period it covers rather than over whichever renewal happens to bill it.
    const kind = product?.kind;
    const booked = await addAdHocCharges({
      organizationId,
      businessId,
      subscriptionId: sub.id,
      invoiceNow: false,
      now,
      lines: [
        {
          description: isOneTime
            ? priceLabel(input.price, product)
            : `${priceLabel(input.price, product)} - Prorated Charges`,
          amountMinor: Number(amountDue),
          quantity: input.quantity,
          priceId: input.price.id,
          // `entity_type`, resolved from the product kind — the ad-hoc default
          // (`charge_item_price`) would file an add-on under the wrong entity.
          entityType:
            kind === "plan"
              ? "plan_item_price"
              : kind === "addon"
                ? "addon_item_price"
                : kind === "charge"
                  ? "charge_item_price"
                  : "adhoc",
          // A one-time fee covers no service window, matching the immediate branch below.
          // A recurring add is a slice of the CURRENT term, so the term must exist —
          // `billsAtTrialEnd` gates trialling subscriptions out above (a trial has no term since
          // 2026-08-25), and a one-time fee carries no service window at all.
          ...(isOneTime ? {} : { periodStart: from, periodEnd: requireTerm(sub).end }),
        },
      ],
      // Deferring does not un-charge a one-time fee: the cycle is consumed by this
      // booking, or the renewal folds the queued charge in AND rates the item again.
      ...(isOneTime ? { markItemsBilled: [item.id] } : {}),
    });
    return {
      item,
      invoice: null,
      payment: null,
      unbilledCharges: booked.object === "unbilled_charges" ? booked.charges : [],
    };
  }

  const { invoice, payment } = await createInvoiceFromLines({
    organizationId,
    businessId,
    customerId: sub.customerId,
    subscriptionId: sub.id,
    currency: sub.currency,
    lines: [
      {
        // A one-time fee is not a prorated slice, so it must not claim to be one —
        // same plain label the other one-time paths use.
        description: isOneTime
          ? priceLabel(input.price, product)
          : `${priceLabel(input.price, product)} - Prorated Charges`,
        amountMinor: amountDue,
        priceId: input.price.id,
        quantity: input.quantity,
        kind: isOneTime ? "one_time" : "proration",
      },
    ],
    applyTax: true,
    country: customer?.country,
    state: customer?.state,
    applyCredit: true,
    collect: true,
    subscription: sub,
    // 🔴 This invoice consumes the one-time item's single billing cycle (bug,
    // 2026-08-03). `planSubscriptionPeriodInvoice` rates every non-metered item
    // from its snapshot each period and stops only at the item's cycle cap — which
    // for a `one_time` price is an implicit 1 — and it increments `cycles_billed`
    // itself for the items IT bills. This charge is raised outside it, so without
    // recording the cycle here the next renewal would see a one-time fee that had
    // never been billed and bill it a second time. Recorded inside the invoice's
    // own transaction, so the fee and the record that it was charged commit together.
    // A RECURRING add passes nothing: its prorated slice is part of a cycle the
    // renewal still bills in full, and consuming a cycle would eat one from a
    // legitimate `billing_cycles` cap.
    ...(isOneTime ? { markItemsBilled: [item.id] } : {}),
    // A one-time charge covers no service window (`date_from`/`date_to` are blank
    // on it), matching `fireActivationCharges` / `triggerAttachedItemCharge`, which
    // pass none. Only the prorated remainder carries `from..currentPeriodEnd`.
    // A recurring add is a slice of the CURRENT term, so the term must exist —
    // `billsAtTrialEnd` gates trialling subscriptions out above (a trial has no term since
    // 2026-08-25), and a one-time fee carries no service window at all.
    ...(isOneTime ? {} : { periodStart: from, periodEnd: requireTerm(sub).end }),
  });
  return { item, invoice, payment };
}

/**
 * TL-4 / CAT-4: fire the `charge_on_event='activation'` attached items when a
 * subscription activates (future→active, trial→active, or created-active). Each
 * charge fires AT MOST ONCE per subscription via a `subscription_charge_log` claim
 * (chargeEvent='activation'), so time travel re-travel / crash-retry / multiple
 * activation paths never double-charge. Best-effort per item (a resolution failure
 * on one item never blocks activation). Returns the number of charges raised.
 */
export async function fireActivationCharges(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  now: Date;
}): Promise<number> {
  const { organizationId, businessId } = input;
  const resolved = await withTenant(organizationId, async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, input.subscriptionId))
      .limit(1);
    if (!sub) return null;
    const planIds = (
      await tx
        .select({ id: products.id })
        .from(subscriptionItems)
        .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
        .innerJoin(products, eq(prices.productId, products.id))
        .where(and(eq(subscriptionItems.subscriptionId, sub.id), eq(products.kind, "plan")))
    ).map((r) => r.id);
    if (planIds.length === 0)
      return {
        sub,
        items: [] as Array<{
          itemId: string;
          price: typeof prices.$inferSelect;
          planId: string;
          qty: number;
          chargeOnce: boolean;
        }>,
      };
    const links = await tx
      .select()
      .from(attachedItems)
      .where(
        and(
          inArray(attachedItems.planProductId, planIds),
          eq(attachedItems.chargeOnEvent, "activation"),
        ),
      );
    const items: Array<{
      itemId: string;
      price: typeof prices.$inferSelect;
      planId: string;
      qty: number;
      chargeOnce: boolean;
    }> = [];
    const seen = new Set<string>();
    for (const ai of links) {
      if (seen.has(ai.itemProductId)) continue;
      seen.add(ai.itemProductId);
      const priceRows = await tx
        .select()
        .from(prices)
        .where(
          and(
            eq(prices.businessId, businessId),
            eq(prices.productId, ai.itemProductId),
            eq(prices.currency, sub.currency),
          ),
        );
      const rec = priceRows.filter((p) => p.type === "recurring");
      // Activation charges are one-time by nature: prefer a one_time price, else a rate.
      const price =
        priceRows.find((p) => p.type === "one_time") ??
        rec.find((p) => p.interval === sub.billingPeriodUnit) ??
        rec[0];
      if (!price) continue;
      items.push({
        itemId: ai.itemProductId,
        price,
        planId: ai.planProductId,
        qty: ai.defaultQuantity ?? 1,
        chargeOnce: ai.chargeOnce,
      });
    }
    return { sub, items };
  });
  if (!resolved || resolved.items.length === 0) return 0;
  const { sub } = resolved;
  const [customer] = await withTenant(organizationId, (tx) =>
    tx.select().from(customers).where(eq(customers.id, sub.customerId)).limit(1),
  );
  let fired = 0;
  for (const it of resolved.items) {
    // Fire-once claim (in its own tx). charge_once items claim the bare event
    // (one fire EVER); repeatable items (charge_once=false, finale review) key the
    // claim on this activation INSTANT — a re-travel/retry of the same activation
    // dedups, but a later re-activation (cancel → reactivate) fires again.
    const chargeEvent = it.chargeOnce ? "activation" : `activation@${input.now.getTime()}`;
    const claimed = await withTenant(organizationId, (tx) =>
      claimAttachedItemCharge(tx, {
        organizationId,
        businessId,
        subscriptionId: sub.id,
        itemProductId: it.itemId,
        chargeEvent,
      }),
    );
    if (!claimed) continue;
    const diff = await withTenant(organizationId, (tx) =>
      resolveDifferential(tx, it.itemId, it.planId, sub.currency, it.price.interval),
    );
    const overrideAmt =
      diff?.tiers == null && diff?.amountMinor != null && isOverridable(it.price.model)
        ? Number(diff.amountMinor)
        : undefined;
    const snapshot = snapshotPrice(it.price, overrideAmt, diff?.tiers ?? undefined);
    const amount = fixedChargeMinor(snapshot, ratableFromSnapshot(snapshot, null), it.qty);
    if (amount <= 0n) continue;
    try {
      await createInvoiceFromLines({
        organizationId,
        businessId,
        customerId: sub.customerId,
        subscriptionId: sub.id,
        currency: sub.currency,
        lines: [
          {
            description: `${it.price.publicId} (activation) ×${it.qty}`,
            amountMinor: amount,
            priceId: it.price.id,
            quantity: it.qty,
            kind: "one_time",
          },
        ],
        applyTax: true,
        country: customer?.country,
        state: customer?.state,
        applyCredit: true,
        collect: true,
        subscription: sub,
      });
      fired++;
    } catch (e) {
      // A failed activation charge never blocks activation — but it must be
      // RETRIABLE, not silently lost forever (finale review): release the claim
      // so the next activation pass / travel step retries, and log loudly.
      await withTenant(organizationId, (tx) =>
        tx
          .delete(subscriptionChargeLog)
          .where(
            and(
              eq(subscriptionChargeLog.subscriptionId, sub.id),
              eq(subscriptionChargeLog.itemProductId, it.itemId),
              eq(subscriptionChargeLog.chargeEvent, chargeEvent),
            ),
          ),
      );
      log.error(e, {
        stage: "activation_charge",
        retriable: true,
        subscription: sub.publicId,
        item: it.itemId,
      });
    }
  }
  return fired;
}

/**
 * CAT-4: trigger a charge for an `on_demand` attached add-on or charge now. Resolves
 * the item's price in the subscription's currency (differential-aware for the
 * sub's plan) and raises an immediate one-time invoice for `quantity` (default =
 * the attached item's default_quantity), collecting it.
 */
export async function triggerAttachedItemCharge(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  itemPublicId: string;
  quantity?: number;
  now: Date;
}): Promise<{ invoice: Invoice; payment: Payment | null }> {
  const { organizationId, businessId } = input;
  const { sub, customer } = await loadSubAndCustomer(organizationId, input.subscriptionId);
  // Guard by subscription status (G backlog): a charge only makes sense on a live
  // sub — never a future/paused/cancelled one.
  if (sub.status !== "active" && sub.status !== "in_trial") {
    throw new SubscriptionError(`You cannot trigger a charge on a ${sub.status} subscription`);
  }
  const resolved = await withTenant(organizationId, async (tx) => {
    const [item] = await tx
      .select()
      .from(products)
      .where(and(eq(products.businessId, businessId), eq(products.publicId, input.itemPublicId)))
      .limit(1);
    if (!item || (item.kind !== "addon" && item.kind !== "charge"))
      throw new SubscriptionError(`We could not find the add-on or charge ${input.itemPublicId}.`);
    // Plan-linkage + event guard (G backlog): the add-on must be attached to one of
    // the sub's current plans AND that link must be charge_on_event='on_demand'
    // (trigger_charge is the on_demand mechanism; creation/trial/activation charges
    // fire automatically, not via this route).
    // Post-H (#7): scan ALL of the sub's plan items (a sub can carry several plans),
    // not just one arbitrary limit(1) row — otherwise a legitimately-attached add-on
    // is falsely rejected (or its differential mis-resolved) on a multi-plan sub.
    const planIds = (
      await tx
        .select({ id: products.id })
        .from(subscriptionItems)
        .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
        .innerJoin(products, eq(prices.productId, products.id))
        .where(and(eq(subscriptionItems.subscriptionId, sub.id), eq(products.kind, "plan")))
    ).map((r) => r.id);
    if (planIds.length === 0)
      throw new SubscriptionError("Subscription has no plan to attach this charge to");
    const ais = await tx
      .select()
      .from(attachedItems)
      .where(
        and(
          eq(attachedItems.itemProductId, item.id),
          inArray(attachedItems.planProductId, planIds),
        ),
      );
    if (ais.length === 0)
      throw new SubscriptionError(
        `${input.itemPublicId} is not attached to this subscription's plan`,
      );
    // Prefer an on_demand linkage (this route's mechanism) over another event's.
    const ai = ais.find((a) => a.chargeOnEvent === "on_demand") ?? ais[0]!;
    if (ai.chargeOnEvent !== "on_demand") {
      throw new SubscriptionError(
        `${input.itemPublicId} has charge_on_event='${ai.chargeOnEvent}'. You can trigger only on_demand items.`,
      );
    }
    const priceRows = await tx
      .select()
      .from(prices)
      .where(
        and(
          eq(prices.businessId, businessId),
          eq(prices.productId, item.id),
          eq(prices.currency, sub.currency),
        ),
      );
    const rec = priceRows.filter((p) => p.type === "recurring");
    // For a one-time trigger, a one_time price is fine; else a recurring rate.
    const price =
      priceRows.find((p) => p.type === "one_time") ??
      rec.find((p) => p.interval === sub.billingPeriodUnit) ??
      rec[0];
    if (!price)
      throw new SubscriptionError(`${input.itemPublicId} has no price in ${sub.currency}`);
    // Resolve the differential against the SPECIFIC plan this add-on is attached to.
    const diff = await resolveDifferential(
      tx,
      item.id,
      ai.planProductId,
      sub.currency,
      price.interval,
    );
    return {
      itemId: item.id,
      price,
      diff,
      defaultQty: ai.defaultQuantity,
      chargeOnce: ai.chargeOnce,
    };
  });
  const qty = input.quantity ?? resolved.defaultQty;
  const diff = resolved.diff;
  const overrideAmt =
    diff?.tiers == null && diff?.amountMinor != null && isOverridable(resolved.price.model)
      ? Number(diff.amountMinor)
      : undefined;
  const snapshot = snapshotPrice(resolved.price, overrideAmt, diff?.tiers ?? undefined);
  const amount = fixedChargeMinor(snapshot, ratableFromSnapshot(snapshot, null), qty);
  if (amount <= 0n) throw new SubscriptionError("The charge for the attached item is zero");
  // charge_once history guard (G backlog): a charge_once on_demand item fires at
  // most once per subscription, regardless of repeat calls / travel re-runs.
  if (resolved.chargeOnce) {
    const claimed = await withTenant(organizationId, (tx) =>
      claimAttachedItemCharge(tx, {
        organizationId,
        businessId,
        subscriptionId: sub.id,
        itemProductId: resolved.itemId,
        chargeEvent: "on_demand",
      }),
    );
    if (!claimed)
      throw new SubscriptionError(
        `${input.itemPublicId} is charge_once, and this subscription already has a charge for it`,
      );
  }
  try {
    const { invoice, payment } = await createInvoiceFromLines({
      organizationId,
      businessId,
      customerId: sub.customerId,
      subscriptionId: sub.id,
      currency: sub.currency,
      lines: [
        {
          description: `${resolved.price.publicId} ×${qty}`,
          amountMinor: amount,
          priceId: resolved.price.id,
          quantity: qty,
          kind: "one_time",
        },
      ],
      applyTax: true,
      country: customer?.country,
      state: customer?.state,
      applyCredit: true,
      collect: true,
      subscription: sub,
    });
    return { invoice, payment };
  } catch (e) {
    // Release the charge_once claim on failure (finale review): otherwise a
    // transient invoice/charge error left the add-on permanently un-chargeable.
    if (resolved.chargeOnce) {
      await withTenant(organizationId, (tx) =>
        tx
          .delete(subscriptionChargeLog)
          .where(
            and(
              eq(subscriptionChargeLog.subscriptionId, sub.id),
              eq(subscriptionChargeLog.itemProductId, resolved.itemId),
              eq(subscriptionChargeLog.chargeEvent, "on_demand"),
            ),
          ),
      );
    }
    throw e;
  }
}

/**
 * Remove a subscription item mid-period, crediting the unused (prorated) time of a
 * RECURRING item via a real credit note against the current-term invoice (not a
 * negative invoice). A `one_time` item is credited NOTHING — it bought no span of
 * time, so it has no unused remainder; see the ruling at the `credit` computation.
 * Returns the credit note (or null if nothing to credit).
 */
export async function removeSubscriptionItem(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  itemPublicId: string;
  now: Date;
  /**
   * Buffer this operation's `subscription_changed` instead of emitting it.
   *
   * Supplied by `applyItemOperations`, which composes up to three of these calls for ONE
   * logical change and must not announce three. See the coalescing note there.
   */
  deferEventsTo?: DeferredEvents;
  // `creditNotes` carries every note this removal issued — one per invoice that charged
  // the item; `creditNote` is the largest of them, for callers that report just one.
}): Promise<{ creditNote: CreditNote | null; creditNotes: CreditNote[] }> {
  const { organizationId, businessId, now } = input;
  const { sub } = await loadSubAndCustomer(organizationId, input.subscriptionId);
  const item = await withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(subscriptionItems)
      .where(
        and(
          eq(subscriptionItems.subscriptionId, sub.id),
          eq(subscriptionItems.publicId, input.itemPublicId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
  if (!item)
    throw new SubscriptionError(`We could not find the subscription item ${input.itemPublicId}.`);

  // CAT-3: a MANDATORY add-on (for a current plan) cannot be removed.
  await withTenant(organizationId, async (tx) => {
    const [prod] = await tx
      .select({ id: products.id, kind: products.kind })
      .from(products)
      .innerJoin(prices, eq(products.id, prices.productId))
      .where(eq(prices.id, item.priceId))
      .limit(1);
    if (!prod || prod.kind !== "addon") return;
    const planIds = (
      await tx
        .select({ id: products.id })
        .from(subscriptionItems)
        .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
        .innerJoin(products, eq(prices.productId, products.id))
        .where(and(eq(subscriptionItems.subscriptionId, sub.id), eq(products.kind, "plan")))
    ).map((r) => r.id);
    const mandatory = await findMandatoryItemIds(tx, businessId, planIds, [prod.id]);
    if (mandatory.has(prod.id)) throw new SubscriptionError("You cannot remove a mandatory add-on");
  });

  const snapshot = item.priceSnapshot as PriceSnapshot | null;
  const ratable = snapshot ? ratableFromSnapshot(snapshot, item.freeQuantity) : null;
  const fullAmount = ratable ? fixedChargeMinor(snapshot!, ratable, item.quantity) : 0n;
  // Same window math as the add-charge (whole-day proration starts 'from' at the start
  // of the billing day) so a same-day add+remove nets to zero and the credit stays
  // whole-day.
  const from = await itemProrationWindowStart(
    organizationId,
    businessId,
    now,
    sub.currentPeriodStart,
  );
  // ── REMOVING A ONE-TIME ITEM CREDITS NOTHING (money decision, 2026-08-03) ──────
  // An invoiced one-time fee is NOT refunded by detaching the item. The operator's
  // route to giving a one-off fee back is an explicit credit note / refund, which is
  // a deliberate act with its own reason code — not a side effect of editing the
  // subscription's composition.
  //
  // This path used to time-prorate the credit for EVERY item, keyed on nothing but
  // "is this an item". Once the add path was fixed to charge a one-off in FULL, that
  // made a mid-term add-then-remove lose the customer money: 5000 charged, ~2500
  // credited back halfway through the term. The two defensible readings were "no
  // credit" and "the full fee back" (symmetric); the ruling is no
  // credit.
  //
  // Deliberately unconditional on `cycles_billed`, and both halves are right for the
  // same reason there is nothing to slice:
  //   · ALREADY BILLED  → the fee was earned when it was invoiced; detaching the
  //                       item does not un-earn it.
  //   · NEVER BILLED    → nothing was charged, so there is nothing to give back.
  //                       (Crediting here was the worse bug of the two: with no
  //                       invoice line for the fee's price, `targetInvoicePublicId`
  //                       resolves to null and the credit falls back to the newest
  //                       live invoice — i.e. it would have been funded out of the
  //                       PLAN's payment.)
  // A RECURRING item's removal credit is untouched: it bought a span of time and the
  // unused remainder is genuinely owed.
  //
  // TRIAL GATE (see proration.billsAtTrialEnd): the mirror of the add path, and it
  // still applies to recurring items. The customer paid nothing for this item, so
  // removing it credits nothing. Today `issueCurrentTermCredit` usually returns null
  // anyway (no live invoice to credit against), but a trial sub CAN carry one — a
  // signup one-time charge, an activation-event attached item — and that invoice must
  // not fund a refund for free time.
  const isOneTime = snapshot?.type === "one_time";
  const credit =
    billsAtTrialEnd(sub) || isOneTime
      ? 0n
      : prorate(fullAmount, from, requireTerm(sub).start, requireTerm(sub).end);

  // ── ATOMICITY (2026-08-03). The deletion and the credit it owes are ONE unit.
  // This path had the same hole `changeSubscription` did: the delete committed here
  // and `issueCurrentTermCredit` then opened its OWN transaction, where the
  // refundable-CN cap can legitimately REFUSE the credit (the item's own charge
  // invoice may have collected less cash than a full term of the item is worth — an
  // add-on scaled up after it was first charged has only ever been billed the delta).
  // When it did, the item was already gone with NOTHING credited: the customer lost
  // the item AND the money they were owed, and the route answered a bare 500 that
  // invited a retry of a removal that can never succeed. Everything that WRITES now
  // runs on this handle, so a refused credit rolls the deletion back.
  // Nothing here talks to a gateway — issuing an adjustment/refundable credit note
  // only books ledger rows, the payout being a separate explicit operation — so no
  // network call is held open inside the transaction (the rule that keeps the CHARGE
  // side of `addSubscriptionItem` / `changeSubscription` outside theirs).
  const creditNote = await withTenant(organizationId, async (tx) => {
    // ── OPTIMISTIC LOCK (Bugs #8, CP-0 idiom — the same one `changeSubscription`'s
    // apply phase takes, see proration.ts). Everything above is a READ: the item row,
    // its frozen snapshot, the mandatory-add-on check and — the part that decides
    // money — the term window `currentPeriodStart..currentPeriodEnd` that `prorate`
    // measured `credit` against. `changeSubscription` had the lock and this path had
    // none, so two removals of DIFFERENT items, or a removal racing `/change`, each
    // priced their credit off the SAME stale snapshot: a `/change` that term-resets
    // moves `current_period_start/end` and already credits the whole old term, and a
    // removal that read the pre-reset window then credits unused time on a term that
    // no longer exists — the customer is credited twice for one span of time.
    //
    // A conditional write, not a read-then-check: exactly one UPDATE can match
    // `resource_version = <the version we read>`, because the BEFORE UPDATE trigger
    // bumps it (migration 0057, amended by 0144 — the bump is unconditional). Under
    // READ COMMITTED the loser blocks on the winner's row lock, re-evaluates the
    // predicate once it commits, matches 0 rows and throws — as the FIRST statement
    // of this transaction, so the item is not deleted, no MRR is written, no event is
    // emitted and no credit note is issued. `ProrationConflictError` is a
    // `ProrationError` subclass mapped to **409 (retryable)**, and a retry re-reads
    // the post-removal state: the item is gone, so it answers the ordinary 400
    // `No such subscription item` instead of double-crediting.
    //
    // It composes with the atomicity fix below rather than replacing it: the lock
    // decides whether this call MAY write, the transaction decides that everything it
    // writes lands together.
    const claimed = await tx
      .update(subscriptions)
      .set({ updatedAt: now })
      .where(
        and(eq(subscriptions.id, sub.id), eq(subscriptions.resourceVersion, sub.resourceVersion)),
      )
      .returning({ id: subscriptions.id });
    if (claimed.length === 0) {
      throw new ProrationConflictError(
        "Another request changed the subscription at the same time. We did not remove the item. Retry the request.",
      );
    }
    // A metered item bills its open usage window before it goes: no renewal rates a
    // detached record.
    await settleMeteredUsage(tx, sub, [item.id], now);
    await tx.delete(subscriptionItems).where(eq(subscriptionItems.id, item.id));
    // ── THE CHARGE SIDE OF THE REMOVAL (money bug, 2026-08-24) ──────────────────
    // Everything below hands back money the customer ALREADY PAID. This hands back the
    // part they have not been billed for yet: an add made without `invoice_immediately`
    // — the default since 0109 — queued its prorated charge as a pending
    // `unbilled_charge` covering `[added .. currentPeriodEnd]`, and the next renewal
    // folds it in. Left alone, that renewal bills a line for an item this call just
    // detached, over a window running past the day it was detached.
    //
    // Re-cut to the span actually held, never blanket-voided: the slice up to `from` is
    // genuinely owed and still bills. See planRemovedItemUnbilledSettlements.
    const settlements = await planRemovedItemUnbilledSettlements(tx, {
      subscriptionId: sub.id,
      priceIds: [item.priceId],
      heldUntil: from,
    });
    await applyUnbilledChargeSettlements(tx, { organizationId, businessId, settlements });
    // The unused remainder is handed back ONCE. `credit` above is the whole remainder
    // [from .. currentPeriodEnd] at this item's rate; the part of it that was still only
    // QUEUED has just been cancelled, so crediting it again would pay the customer twice
    // for one span of time — and pay it out of an invoice that never charged this item
    // (with no invoice for this price, `issueCurrentTermCredit` falls back to the newest
    // live one, i.e. the PLAN's payment). What is left is the part that was really
    // invoiced, which is exactly what a credit note is for.
    const clawedBack = settlements.reduce((s, x) => s + x.droppedMinor, 0n);
    const netCredit = credit - clawedBack;
    // Recompute cached MRR now that the item is gone — remove is the mirror
    // of add; the removed add-on's recurring contribution must leave MRR. Inside the
    // transaction, so a refused credit can never leave the cached column describing
    // an item set that was never applied. Dated at `from`, the same instant the
    // credit window opens, so the delta lands in the period the item actually left.
    await recomputeSubscriptionMrr(tx, sub.id, from);
    // An item removal fires subscription_changed too.
    // Also inside: a delivered webhook cannot be unsent, so it must not announce a
    // removal that a credit refusal is about to roll back.
    await emitOrDefer(
      tx,
      {
        organizationId,
        businessId,
        type: "subscription_changed",
        data: buildEventData(
          "subscription_changed",
          { id: sub.publicId, status: sub.status, item_removed: input.itemPublicId },
          sub.resourceVersion,
        ),
      },
      input.deferEventsTo,
    );
    if (netCredit <= 0n) return null;
    const label = (item.priceSnapshot as PriceSnapshot | null)?.publicId ?? "item";
    // Bind the removal credit to THIS item's own charge invoices — EVERY invoice
    // that charged it, each credited from its own lines. A sub can carry several live
    // invoices in one term (each add-on billed on its own proration invoice, a quantity
    // scale-up billing only the delta on a second one); the newest-live default would
    // target the wrong one, and "the newest that charged it" was still one invoice and
    // still capped the credit at THAT invoice's cash — silently dropping the rest.
    // Measured 2026-08-24: an add-on at qty 1 (charged 500 on its own invoice) scaled to
    // qty 40 (the 19500 delta on a second) owes 20000 on removal, and we issued ONE note
    // for 19500. It must be one note per invoice — CN-202 560.00 against invoice 2189
    // (qty 1) and CN-203 21840.00 against 2190 (qty 39) on the same shape, summing to
    // the full 22400. `targetPriceIds` is that rule; see issueCurrentTermCredit.
    return await issueCurrentTermCredit({
      organizationId,
      businessId,
      subscription: sub,
      // `priceId` recovers the source invoice line for the note's item
      // (`reference_line_item_id`) — see `linkItemsToLines` in proration.ts.
      items: [
        {
          description: `${label} — prorated credit for unused time`,
          amountMinor: netCredit,
          priceId: item.priceId,
        },
      ],
      reasonCode: "subscription_change",
      reason: `Removed ${label} — prorated credit for unused time`,
      targetPriceIds: [item.priceId],
      // The window handed back: from the proration boundary the AMOUNT was cut on
      // (`from`, already floored to the local day on a whole-day business) to the end of
      // the term the removed item was billed for. Without it the note's items inherited
      // the source line's period — the WHOLE term, including the part the customer used —
      // or carried none at all. See `issueCurrentTermCredit.creditedPeriod`.
      creditedPeriod: { start: from, end: requireTerm(sub).end },
      // The credit books on the caller's handle — that IS the fix (withTenantTx).
      tx,
    });
  }).catch((e: unknown) => {
    // A refused credit is a VALIDATABLE condition, not an internal fault, and nothing
    // was written (the transaction above rolled back). Translated at the MODULE
    // boundary through the SHARED converter, so every caller — the DELETE route, the
    // dashboard action, any future scheduled applier — gets a 400 carrying the real
    // reason instead of the 500 that used to accompany a silently-deleted item.
    return rethrowCreditNoteErrorAsProration(e, "We cannot remove this item");
  });
  // A removal can now produce SEVERAL notes — one per invoice that charged the item
  // (see targetPriceIds). The response carries one `credit_note`, so it reports the
  // largest: the note the customer would recognise as the credit for this removal.
  // `credit_notes` on the subscription lists them all.
  const notes = [...(creditNote ?? [])].sort((a, b) =>
    b.totalMinor === a.totalMinor ? 0 : b.totalMinor > a.totalMinor ? 1 : -1,
  );
  return { creditNote: notes[0] ?? null, creditNotes: notes };
}

/** One drafted one-time charge on a subscription. */
export interface AdHocChargeInput {
  description: string;
  amountMinor: number;
  /** Quantity for a catalog-priced charge (`charge_items[quantity]`). */
  quantity?: number;
  /** The catalog Charge price this came from, when picked rather than typed. */
  priceId?: string | null;
  /** Service period — `date_from`/`date_to`, for revenue recognition. */
  periodStart?: Date | null;
  periodEnd?: Date | null;
  /**
   * `entity_type` on the unbilled charge. Omitted ⇒ derived from `priceId`
   * (`charge_item_price` when the line came from the catalog, else `adhoc`) — the
   * behaviour every ad-hoc caller had before. Passed explicitly by the DEFERRED
   * plan-change path (proration.ts), whose lines carry PLAN and ADD-ON price ids:
   * deriving there would have filed a plan proration as `charge_item_price`, which
   * is what the API then reports. Ignored when `invoiceNow` — an invoice line has
   * its own price link and no entity_type.
   */
  entityType?: string;
}

/**
 * Add one-time charges to a subscription. `invoiceNow` bills + collects them
 * immediately on ONE invoice; otherwise each is queued as an unbilled charge folded
 * into the next renewal invoice.
 *
 * Takes an array because the `Add Charge` / `Create Quick Charge` takeovers repeat
 * before committing: several charges, one invoice the customer receives. One call per
 * charge would raise one invoice each — separate documents, separate collection
 * attempts, and separate credit draws.
 *
 * Deferring, by contrast, genuinely produces N rows: each unbilled charge is stored
 * separately, and they merge when the renewal bills them.
 *
 * This is the ONLY place a charge is booked either way — the deferred plan change
 * (`changeSubscription`, proration.ts) routes through here rather than growing a
 * second `unbilled_charges` writer.
 */
export async function addAdHocCharges(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  lines: AdHocChargeInput[];
  invoiceNow: boolean;
  now: Date;
  /**
   * Subscription-item ids whose single billing cycle these charges consume, as
   * `createInvoiceFromLines({ markItemsBilled })` means it — incremented in the SAME
   * transaction as the booking.
   *
   * Needed because the DEFERRED branch is a booking too: a plan change that swaps an
   * item onto a `one_time` price charges that fee in full, and the period planner
   * bills any one-time item whose cycle is unspent. Queue the fee as an unbilled
   * charge without recording the cycle and the next renewal folds the unbilled charge
   * in AND rates the item again — the customer pays the one-off twice.
   */
  markItemsBilled?: string[];
}): Promise<
  | { object: "invoice"; invoice: Invoice; payment: Payment | null }
  | { object: "unbilled_charges"; charges: Array<typeof unbilledCharges.$inferSelect> }
> {
  const { organizationId, businessId } = input;
  if (input.lines.length === 0) throw new SubscriptionError("At least one charge is required");
  const { sub, customer } = await loadSubAndCustomer(organizationId, input.subscriptionId);

  if (input.invoiceNow) {
    const { invoice, payment } = await createInvoiceFromLines({
      organizationId,
      businessId,
      customerId: sub.customerId,
      subscriptionId: sub.id,
      currency: sub.currency,
      lines: input.lines.map((l) => ({
        description: l.description,
        amountMinor: BigInt(l.amountMinor),
        kind: "one_time",
        quantity: l.quantity,
        priceId: l.priceId ?? null,
        periodStart: l.periodStart ?? null,
        periodEnd: l.periodEnd ?? null,
      })),
      applyTax: true,
      country: customer?.country,
      state: customer?.state,
      applyCredit: true,
      collect: true,
      subscription: sub,
      ...(input.markItemsBilled?.length ? { markItemsBilled: input.markItemsBilled } : {}),
    });
    return { object: "invoice", invoice, payment };
  }

  // One transaction: a partial insert would leave some charges queued and lose the
  // rest with nothing to tell the operator which landed — and the cycle bump below
  // must commit with the charges that consume it, never before or after them.
  const charges = await withTenant(organizationId, async (tx) => {
    const rows = await tx
      .insert(unbilledCharges)
      .values(
        input.lines.map((l) => ({
          organizationId,
          businessId,
          subscriptionId: sub.id,
          publicId: publicId("uch"),
          description: l.description,
          amountMinor: BigInt(l.amountMinor),
          currency: sub.currency,
          quantity: l.quantity ?? 1,
          priceId: l.priceId ?? null,
          entityType: l.entityType ?? (l.priceId ? "charge_item_price" : "adhoc"),
          periodStart: l.periodStart ?? null,
          periodEnd: l.periodEnd ?? null,
        })),
      )
      .returning();
    if (input.markItemsBilled?.length) {
      await tx
        .update(subscriptionItems)
        .set({ cyclesBilled: sql`${subscriptionItems.cyclesBilled} + 1` })
        .where(inArray(subscriptionItems.id, input.markItemsBilled));
    }
    return rows;
  });
  return { object: "unbilled_charges", charges };
}

/**
 * Single-charge form, kept for the existing callers (the API's one-charge body and
 * resume's `add_to_unbilled_charges`). Delegates so there is one implementation.
 */
export async function addAdHocCharge(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  description: string;
  amountMinor: number;
  invoiceNow: boolean;
  now: Date;
  quantity?: number;
  priceId?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}): Promise<
  | { object: "invoice"; invoice: Invoice; payment: Payment | null }
  | { object: "unbilled_charge"; charge: typeof unbilledCharges.$inferSelect }
> {
  const { organizationId, businessId, subscriptionId, invoiceNow, now, ...line } = input;
  const r = await addAdHocCharges({
    organizationId,
    businessId,
    subscriptionId,
    invoiceNow,
    now,
    lines: [line],
  });
  return r.object === "invoice" ? r : { object: "unbilled_charge", charge: r.charges[0]! };
}

/**
 * Full recurring charge for ONE billing period of a subscription, rated from each
 * item's immutable price snapshot (never the monthly-normalized MRR). Used by
 * resume `add_to_unbilled_charges`: MRR is 1/12 of a yearly plan, so booking MRR
 * under-charged annual subs (review fix). Only `recurring` kinds count.
 */
export async function recurringChargeMinor(
  organizationId: string,
  subscriptionId: string,
): Promise<bigint> {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select({
        item: subscriptionItems,
        price: prices,
        productKind: products.kind,
        productPublicId: products.publicId,
        currency: subscriptions.currency,
      })
      .from(subscriptionItems)
      .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
      .innerJoin(products, eq(prices.productId, products.id))
      .innerJoin(subscriptions, eq(subscriptionItems.subscriptionId, subscriptions.id))
      .where(eq(subscriptionItems.subscriptionId, subscriptionId));
    // Gross recurring amount, one entry per recurring line (for coupon matching).
    const lines: Array<{
      index: number;
      amountMinor: bigint;
      productKind: string;
      productPublicId: string;
      pricePublicId: string;
    }> = [];
    let total = 0n;
    for (const r of rows) {
      const isRec =
        (r.item.priceSnapshot as PriceSnapshot | null)?.type === "recurring" ||
        r.price.type === "recurring";
      if (!isRec) continue;
      const ratable = ratableForItem(r.item, r.price);
      const amt = fixedChargeMinor(
        (r.item.priceSnapshot as PriceSnapshot | null) ?? r.price,
        ratable,
        r.item.quantity,
      );
      lines.push({
        index: lines.length,
        amountMinor: amt,
        productKind: r.productKind,
        productPublicId: r.productPublicId,
        pricePublicId: r.price.publicId,
      });
      total += amt;
    }
    if (total <= 0n || lines.length === 0) return total;
    // Apply the sub's active coupons (G backlog: this rated gross, ignoring
    // discounts). NON-mutating peek — the folded unbilled charge is a one-time line
    // that the coupon won't re-discount at billing, so discounting here is correct.
    const currency = rows[0]?.currency;
    const disc = await peekDiscounts(tx, subscriptionId, lines, currency);
    const net = total - disc.totalMinor;
    return net > 0n ? net : 0n;
  });
}

export async function listUnbilledCharges(organizationId: string, subscriptionId: string) {
  return withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(unbilledCharges)
      .where(eq(unbilledCharges.subscriptionId, subscriptionId))
      .orderBy(unbilledCharges.createdAt),
  );
}

/**
 * Invoice all PENDING unbilled charges for a subscription into a single invoice
 * (used by SUB-5 cancel `unbilled_charges_option='invoice'`). Marks them billed.
 * Returns the invoice (or null when there are no pending charges).
 */
export async function invoiceUnbilledCharges(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  now: Date;
}): Promise<Invoice | null> {
  const { organizationId, businessId } = input;
  const { sub, customer } = await loadSubAndCustomer(organizationId, input.subscriptionId);
  const pending = await withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(unbilledCharges)
      .where(
        and(eq(unbilledCharges.subscriptionId, sub.id), eq(unbilledCharges.status, "pending")),
      ),
  );
  if (pending.length === 0) return null;
  const { invoice } = await createInvoiceFromLines({
    organizationId,
    businessId,
    customerId: sub.customerId,
    subscriptionId: sub.id,
    currency: sub.currency,
    // Quantity and service period ride on the line; no `priceId`, so the tax determination
    // (every line taxable, exclusive) and therefore the totals stay what they were.
    lines: pending.map(unbilledChargeLine),
    applyTax: true,
    country: customer?.country,
    state: customer?.state,
    applyCredit: true,
    collect: false,
    subscription: sub,
    // Claimed in the invoice's transaction: only these rows, and only if still pending.
    markUnbilledChargesBilled: pending.map((c) => c.id),
  });
  return invoice;
}

/** A pending charge as the invoice line `/charges` with `invoice_now: true` would write. */
function unbilledChargeLine(c: typeof unbilledCharges.$inferSelect) {
  return {
    description: c.description,
    amountMinor: c.amountMinor,
    // Settled usage keeps its kind; its price decides the tax (`createInvoiceFromLines`).
    // A commitment true-up is a plan line.
    kind:
      c.entityType === USAGE_SETTLEMENT
        ? "usage"
        : c.entityType === COMMITMENT_CHARGE
          ? "recurring"
          : "one_time",
    ...(c.entityType === COMMITMENT_CHARGE ? { adjustment: "commitment" as const } : {}),
    quantity: c.quantity,
    priceId: c.priceId ?? null,
    periodStart: c.periodStart ?? null,
    periodEnd: c.periodEnd ?? null,
  };
}

/** Pending charges to invoice now: one subscription's, or every subscription of a customer. */
async function pendingChargesBySubscription(
  organizationId: string,
  businessId: string,
  scope: { subscriptionId: string } | { customerId: string },
) {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({ charge: unbilledCharges })
      .from(unbilledCharges)
      .innerJoin(subscriptions, eq(unbilledCharges.subscriptionId, subscriptions.id))
      .where(
        and(
          eq(unbilledCharges.businessId, businessId),
          eq(unbilledCharges.status, "pending"),
          "subscriptionId" in scope
            ? eq(subscriptions.id, scope.subscriptionId)
            : eq(subscriptions.customerId, scope.customerId),
        ),
      )
      .orderBy(subscriptions.createdAt, unbilledCharges.createdAt, unbilledCharges.id),
  );
  const bySub = new Map<string, Array<typeof unbilledCharges.$inferSelect>>();
  for (const { charge } of rows) {
    const list = bySub.get(charge.subscriptionId) ?? [];
    list.push(charge);
    bySub.set(charge.subscriptionId, list);
  }
  return bySub;
}

/**
 * Invoice the pending unbilled charges now — one invoice per subscription, each raised and
 * collected exactly as `/charges` with `invoice_now: true` raises one. The charges flip to
 * `billed` inside each invoice's transaction, so a charge billed by a concurrent renewal
 * or deleted meanwhile rolls that invoice back (`UnbilledChargesChangedError`).
 * Returns no invoices when nothing is pending.
 */
export async function invoiceUnbilledChargesNow(input: {
  organizationId: string;
  businessId: string;
  scope: { subscriptionId: string } | { customerId: string };
}): Promise<
  Array<{
    invoice: Invoice;
    payment: Payment | null;
    subscriptionPublicId: string;
    customerPublicId: string | null;
  }>
> {
  const { organizationId, businessId } = input;
  const bySub = await pendingChargesBySubscription(organizationId, businessId, input.scope);
  const out = [];
  for (const [subscriptionId, charges] of bySub) {
    const { sub, customer } = await loadSubAndCustomer(organizationId, subscriptionId);
    const raised = await createInvoiceFromLines({
      organizationId,
      businessId,
      customerId: sub.customerId,
      subscriptionId: sub.id,
      currency: sub.currency,
      lines: charges.map(unbilledChargeLine),
      applyTax: true,
      country: customer?.country,
      state: customer?.state,
      applyCredit: true,
      collect: true,
      subscription: sub,
      markUnbilledChargesBilled: charges.map((c) => c.id),
    });
    out.push({
      ...raised,
      subscriptionPublicId: sub.publicId,
      customerPublicId: customer?.publicId ?? null,
    });
  }
  return out;
}

/** The dry run of `invoiceUnbilledChargesNow`: the invoice each subscription would get. */
export async function estimateInvoiceUnbilledChargesNow(input: {
  organizationId: string;
  businessId: string;
  scope: { subscriptionId: string } | { customerId: string };
}) {
  const { organizationId, businessId } = input;
  const bySub = await pendingChargesBySubscription(organizationId, businessId, input.scope);
  const out = [];
  // Invoices are raised in turn, so each draws on what the previous left (per currency).
  const left = new Map<string, CustomerBalances>();
  for (const [subscriptionId, charges] of bySub) {
    const { sub } = await loadSubAndCustomer(organizationId, subscriptionId);
    const preview = await previewInvoiceFromLines({
      organizationId,
      businessId,
      customerId: sub.customerId,
      subscriptionId: sub.id,
      currency: sub.currency,
      lines: charges.map(unbilledChargeLine),
      balances: left.get(sub.currency),
    });
    left.set(sub.currency, preview.balancesAfter);
    out.push({ subscription: sub, charges, preview });
  }
  return out;
}

/** Why a single unbilled charge cannot be deleted. */
export class UnbilledChargeStateError extends Error {
  constructor(
    public readonly chargePublicId: string,
    public readonly status: string,
  ) {
    super(
      status === "billed"
        ? `Unbilled charge ${chargePublicId} is already invoiced. Issue a credit note to reverse it.`
        : `Unbilled charge ${chargePublicId} is already deleted`,
    );
    this.name = "UnbilledChargeStateError";
  }
}

export type UnbilledChargeRow = {
  charge: typeof unbilledCharges.$inferSelect;
  subscriptionPublicId: string;
  customerPublicId: string;
  invoicePublicId: string | null;
};

const unbilledSelection = {
  charge: unbilledCharges,
  subscriptionPublicId: subscriptions.publicId,
  customerPublicId: customers.publicId,
  invoicePublicId: invoices.publicId,
};

const unbilledRows = (tx: Tx) =>
  tx
    .select(unbilledSelection)
    .from(unbilledCharges)
    .innerJoin(subscriptions, eq(unbilledCharges.subscriptionId, subscriptions.id))
    .innerJoin(customers, eq(subscriptions.customerId, customers.id))
    .leftJoin(invoices, eq(unbilledCharges.invoiceId, invoices.id));
const unbilledCount = (tx: Tx) =>
  tx
    .select({ n: countExpr })
    .from(unbilledCharges)
    .innerJoin(subscriptions, eq(unbilledCharges.subscriptionId, subscriptions.id))
    .innerJoin(customers, eq(subscriptions.customerId, customers.id));

const UNBILLED_LIST_FILTERS: Record<string, FilterSpec> = {
  status: { column: unbilledCharges.status, kind: "enum" },
  created_at: { column: unbilledCharges.createdAt, kind: "date" },
};
export const UNBILLED_FILTER_OPS = opsFromSpecs(UNBILLED_LIST_FILTERS);
export const UNBILLED_FILTER_KINDS = kindsFromSpecs(UNBILLED_LIST_FILTERS);
export const UNBILLED_SORT_FIELDS = ["created_at"] as const;
export const UNBILLED_STATUSES = ["pending", "billed", "voided"] as const;

/** A business-wide page of unbilled charges. Keyset on `(created_at, public_id)`. */
export async function listUnbilledChargesPage(
  organizationId: string,
  businessId: string,
  f: {
    subscriptionPublicId?: string;
    customerPublicId?: string;
    filters?: ListFilter[];
    sortDesc?: boolean;
    startingAfter?: string;
    limit?: number;
  } = {},
): Promise<ListPage<UnbilledChargeRow>> {
  const limit = clampLimit(f.limit);
  const descending = f.sortDesc ?? false;
  return withTenant(organizationId, async (tx) => {
    const conds: SQL[] = [eq(unbilledCharges.businessId, businessId)];
    if (f.subscriptionPublicId) conds.push(eq(subscriptions.publicId, f.subscriptionPublicId));
    if (f.customerPublicId) conds.push(eq(customers.publicId, f.customerPublicId));
    conds.push(
      ...filterConditions(UNBILLED_LIST_FILTERS, f.filters, await businessTimezone(tx, businessId)),
    );
    let total: number | null = null;
    if (!f.startingAfter) {
      const [row] = await unbilledCount(tx).where(and(...conds));
      total = row?.n ?? 0;
    }
    const { keysetId } = parseCursor(f.startingAfter);
    const pageConds = [...conds];
    if (keysetId) {
      const [cursor] = await tx
        .select({
          sortValue: sql<string>`${unbilledCharges.createdAt}::text`,
          publicId: unbilledCharges.publicId,
        })
        .from(unbilledCharges)
        .where(
          and(eq(unbilledCharges.businessId, businessId), eq(unbilledCharges.publicId, keysetId)),
        )
        .limit(1);
      const seek = keysetCondition(
        unbilledCharges.createdAt,
        unbilledCharges.publicId,
        cursor ? { sortValue: cursor.sortValue, tiebreak: cursor.publicId } : undefined,
        descending,
      );
      if (seek) pageConds.push(seek);
    }
    const rows = (await unbilledRows(tx)
      .where(and(...pageConds))
      .orderBy(...pageOrder(unbilledCharges.createdAt, unbilledCharges.publicId, descending, true))
      .limit(limit + 1)) as UnbilledChargeRow[];
    return toPage(rows, limit, {
      keyset: true,
      offset: 0,
      keyOf: (r) => r.charge.publicId,
      total,
    });
  });
}

/**
 * Delete one queued charge: `pending` → `voided`, the same state a cancel's
 * `unbilled_charges_option: delete` leaves. No ledger entry exists to reverse — a queued
 * charge posts nothing until it is invoiced.
 */
export async function deleteUnbilledCharge(
  organizationId: string,
  businessId: string,
  chargePublicId: string,
): Promise<UnbilledChargeRow | null> {
  return withTenant(organizationId, async (tx) => {
    const [voided] = await tx
      .update(unbilledCharges)
      .set({ status: "voided" })
      .where(
        and(
          eq(unbilledCharges.businessId, businessId),
          eq(unbilledCharges.publicId, chargePublicId),
          eq(unbilledCharges.status, "pending"),
        ),
      )
      .returning({ id: unbilledCharges.id });
    const [row] = await unbilledRows(tx)
      .where(
        and(
          eq(unbilledCharges.businessId, businessId),
          eq(unbilledCharges.publicId, chargePublicId),
        ),
      )
      .limit(1);
    if (!row) return null;
    if (!voided) throw new UnbilledChargeStateError(chargePublicId, row.charge.status);
    return row as UnbilledChargeRow;
  });
}

/** Delete (void) all pending unbilled charges (SUB-5 cancel `unbilled_charges_option='delete'`). */
export async function deleteUnbilledCharges(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
}): Promise<number> {
  return withTenant(input.organizationId, async (tx) => {
    const rows = await tx
      .update(unbilledCharges)
      .set({ status: "voided" })
      .where(
        and(
          eq(unbilledCharges.subscriptionId, input.subscriptionId),
          eq(unbilledCharges.status, "pending"),
        ),
      )
      .returning({ id: unbilledCharges.id });
    return rows.length;
  });
}
