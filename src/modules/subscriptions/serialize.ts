import { and, eq } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import type { PriceSnapshot } from "@/modules/catalog/pricing";
import { flattenForApi } from "@/modules/custom-fields/service";
import type { RenewalSkipView } from "@/modules/subscriptions/renewal-skips";
import { resolveShipTo, serializeShippingAddress } from "@/modules/customers/addresses";
import {
  inclusiveBoundary,
  normalizeTermEnd,
  type BillingMode,
} from "@/modules/subscriptions/billing-mode";
import {
  scheduledChanges,
  subscriptions,
  subscriptionItems,
  prices,
  products,
  customers,
  appliedCoupons,
  coupons,
  paymentMethods,
  businesses,
} from "@db/schema";

/**
 * Load the (singular) active discount for a subscription — coupon-sourced or
 * manual. leftJoin (not innerJoin): manual rows have no coupon_id, so `c` is
 * null for those and the manual fields on `ac` are used instead.
 */
async function loadActiveDiscount(tx: Tx, subscriptionId: string) {
  const [disc] = await tx
    .select({ ac: appliedCoupons, c: coupons })
    .from(appliedCoupons)
    .leftJoin(coupons, eq(appliedCoupons.couponId, coupons.id))
    .where(
      and(eq(appliedCoupons.subscriptionId, subscriptionId), eq(appliedCoupons.status, "active")),
    )
    .limit(1);
  if (!disc) return null;
  if (disc.c) {
    return {
      id: disc.ac.publicId,
      source: "coupon" as const,
      coupon: disc.c.code,
      manual: null,
      status: disc.ac.status,
      remaining_periods: disc.ac.remainingPeriods,
    };
  }
  return {
    id: disc.ac.publicId,
    source: "manual" as const,
    coupon: null,
    manual: {
      kind: (disc.ac.manualKind ?? "percentage") as "percentage" | "fixed_amount",
      percent_off_bps: disc.ac.manualPercentOffBps,
      amount_off_minor:
        disc.ac.manualAmountOffMinor != null ? Number(disc.ac.manualAmountOffMinor) : null,
      currency: disc.ac.manualCurrency,
      note: disc.ac.manualNote,
    },
    status: disc.ac.status,
    remaining_periods: disc.ac.remainingPeriods,
  };
}

// `StoredSubscriptionStatus`/`ApiSubscriptionStatus`/`apiSubscriptionStatus` and
// `SubscriptionItemView`/`SubscriptionDetail`/`getSubscriptionDetail` live HERE
// (not in `./service`) so `events/content.ts` can build a full subscription
// snapshot without importing `subscriptions/service.ts` — that file imports
// `emitEvent`, and events/emit.ts imports events/content.ts, so
// serialize → service → events/emit → events/content → serialize would be a
// cycle. `./service` re-exports all of these for back-compat.

/**
 * Subscription status vocabulary (Phase F). The state diagram: a future-dated create
 * sits in `future` until its start date;
 * trials are `in_trial`; a running sub is `active`; `paused` skips billing;
 * `cancelled` is terminal. There is NO `past_due` sub status — dunning is
 * invoice-side.
 *
 * `non_renewing` is DERIVED at the API boundary (not stored): an `active` sub
 * with a cancellation already committed to — `cancel_at_period_end` was set, a
 * `specific_date` cancel is pending (`cancel_scheduled_at`), or its
 * `remaining_billing_cycles` reached 0 (SUB-2/SUB-4). The stored status stays
 * `active`; the flags carry the intent.
 */
export type StoredSubscriptionStatus = "future" | "in_trial" | "active" | "paused" | "cancelled";
export type ApiSubscriptionStatus = StoredSubscriptionStatus | "non_renewing";

/**
 * The API-facing status: folds the non_renewing intent flags over `active`.
 *
 * `cancelScheduledAt` joined the set in 0159. A cancellation can be scheduled two
 * ways and only `end_of_term` was reflected here, so a `specific_date` cancel
 * serialized as a plain `active` subscription — the status pill said Active, the
 * `cancel_at_period_end` filter missed it, and the pending cancel was visible
 * only by fetching the subscription's `scheduled_changes` sub-resource.
 */
export function apiSubscriptionStatus(
  sub: Pick<
    typeof subscriptions.$inferSelect,
    "status" | "cancelAtPeriodEnd" | "cancelScheduledAt" | "remainingBillingCycles"
  >,
): ApiSubscriptionStatus {
  if (
    sub.status === "active" &&
    (sub.cancelAtPeriodEnd || sub.cancelScheduledAt != null || sub.remainingBillingCycles === 0)
  ) {
    return "non_renewing";
  }
  return sub.status as StoredSubscriptionStatus;
}

export interface SubscriptionItemView {
  id: string;
  price: string; // price public id
  quantity: number;
  price_model: string;
  price_type: string;
  interval: string | null;
  /** Effective per-item unit price in minor units (snapshot amount; reflects any override). */
  unit_price_minor: number | null;
  /** true when this item carries a subscription-level custom price. */
  unit_price_overridden: boolean;
  /** A `model_price_list` item's own selling price (G1b); absent when it has none. */
  selling_price?: {
    markup_percent: string | null;
    rates: Array<{
      match: Record<string, string>;
      unit_amount_decimal: string | null;
      markup_percent: string | null;
    }>;
  };
  /**
   * The catalog list price this item departs from, when it departs from one.
   * A plan-scoped differential add-on lists at 0 and bills the differential, so
   * without this the UI can only show the effective price and cannot say what it
   * replaced, so both are shown ("Original Price ~~0.00~~"). null when the
   * item is simply at list price.
   */
  catalog_amount_minor: number | null;
  product_name: string;
  product_kind: string;
  /** CP-4 item depth: units billed at 0 before rating / fixed cycle cap. */
  free_quantity: number | null;
  billing_cycles: number | null;
}

export interface SubscriptionDetail {
  subscription: typeof subscriptions.$inferSelect;
  customerPublicId: string | null;
  /**
   * Public id of the SUBSCRIPTION's own payment method, when it has one.
   * `subscriptions.default_payment_method_id` is a uuid, and collection prefers it
   * over the customer's primary (`invoicing/collection.ts`) — so without this the
   * API had no way to say which card actually gets charged, and the dashboard was
   * showing the customer's first/primary method instead. null = falls back to the
   * customer's primary at collection time.
   */
  defaultPaymentMethodPublicId: string | null;
  /** The subscription's own ship-to (`addr_…`); null = ships to the customer's default. */
  shippingAddressPublicId: string | null;
  /** Where it ships right now: its own address, else the customer's default, else null. */
  shipTo: ReturnType<typeof serializeShippingAddress> | null;
  items: SubscriptionItemView[];
  discount: {
    id: string;
    /** Discount source: 'coupon' (`coupon` carries the code) or 'manual' (no coupon object). */
    source: "coupon" | "manual";
    /** Coupon code — only set when source==='coupon'. */
    coupon: string | null;
    /** Manual discount shape — only set when source==='manual'. */
    manual: {
      kind: "percentage" | "fixed_amount";
      percent_off_bps: number | null;
      amount_off_minor: number | null;
      currency: string | null;
      note: string | null;
    } | null;
    status: string;
    remaining_periods: number | null;
  } | null;
}

/**
 * Full detail for one subscription: the row, its customer public id, its items
 * (joined to each price's public id + model/type/interval so the UI can render
 * plan changes and show the usage form only for usage-model items), and the
 * active discount if any. The list/lifecycle responses omit all of this.
 */
export async function getSubscriptionDetail(
  organizationId: string,
  businessId: string,
  subscriptionPublicId: string,
): Promise<SubscriptionDetail | null> {
  return withTenant(organizationId, async (tx) => {
    const [s] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.businessId, businessId),
          eq(subscriptions.publicId, subscriptionPublicId),
        ),
      )
      .limit(1);
    if (!s) return null;

    const [cus] = await tx
      .select({ publicId: customers.publicId })
      .from(customers)
      .where(eq(customers.id, s.customerId))
      .limit(1);

    // The subscription's own payment method (uuid → public id). Only queried when
    // set; a null column means collection falls back to the customer's primary.
    let defaultPaymentMethodPublicId: string | null = null;
    if (s.defaultPaymentMethodId) {
      const [pm] = await tx
        .select({ publicId: paymentMethods.publicId })
        .from(paymentMethods)
        .where(eq(paymentMethods.id, s.defaultPaymentMethodId))
        .limit(1);
      defaultPaymentMethodPublicId = pm?.publicId ?? null;
    }

    const shipToRow = await resolveShipTo(tx, {
      customerId: s.customerId,
      shippingAddressId: s.shippingAddressId,
    });
    const shippingAddressPublicId =
      s.shippingAddressId && shipToRow?.id === s.shippingAddressId ? shipToRow.publicId : null;

    const itemRows = await tx
      .select({ item: subscriptionItems, price: prices, product: products })
      .from(subscriptionItems)
      .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
      .innerJoin(products, eq(prices.productId, products.id))
      .where(eq(subscriptionItems.subscriptionId, s.id));
    const items: SubscriptionItemView[] = itemRows.map(({ item, price, product }) => {
      const snap = item.priceSnapshot as PriceSnapshot | null;
      return {
        id: item.publicId,
        price: price.publicId,
        quantity: item.quantity,
        price_model: price.model,
        price_type: price.type,
        interval: price.interval,
        unit_price_minor:
          snap?.amountMinor ?? (price.amountMinor != null ? Number(price.amountMinor) : null),
        unit_price_overridden: snap?.amountOverridden === true,
        ...sellingPriceJson(snap),
        catalog_amount_minor:
          snap?.amountOverridden === true
            ? (snap.catalogAmountMinor ??
              (price.amountMinor != null ? Number(price.amountMinor) : null))
            : null,
        product_name: product.name,
        product_kind: product.kind,
        free_quantity: item.freeQuantity,
        billing_cycles: item.billingCycles,
      };
    });

    const discount = await loadActiveDiscount(tx, s.id);

    return {
      subscription: s,
      customerPublicId: cus?.publicId ?? null,
      defaultPaymentMethodPublicId,
      shippingAddressPublicId,
      shipTo: shipToRow ? serializeShippingAddress(shipToRow) : null,
      items,
      discount,
    };
  });
}

export type SubscriptionDetailDiscount = NonNullable<
  Awaited<ReturnType<typeof getSubscriptionDetail>>
>["discount"];

/**
 * The slice of the business row serialization needs — any full business row satisfies
 * it. Required rather than optional on purpose: term-end convention is a money-adjacent
 * parity field, and an optional flag would let a new call site silently default to the
 * wrong convention. Making it positional means the compiler names every site instead.
 */
export type TermEndConvention = Pick<
  typeof businesses.$inferSelect,
  "anchorGranularity" | "timezone"
>;

/** The `BillingMode` the two boundary helpers below need, from the business row. */
function modeOf(biz: TermEndConvention): BillingMode {
  return {
    anchor: biz.anchorGranularity === "day" ? "day" : "instant",
    proration: "exact", // unused here — only the anchor decides a boundary
    timezone: biz.timezone ?? "UTC",
  };
}

/**
 * A term end is reported INCLUSIVELY on day-anchored businesses — the last second of the
 * final day (…T23:59:59) — where we store the exclusive next boundary (…T00:00:00.000 of
 * the following day). Same boundary, opposite convention.
 *
 * We keep storage exclusive (all the period arithmetic depends on
 * `next_period_start === current_period_end`) and convert only here, at the API edge,
 * through the shared `inclusiveBoundary` — see its comment for why the back-off is a
 * second rather than the millisecond this used to subtract.
 */
function termEnd(end: Date | null, biz: TermEndConvention): Date | null {
  return inclusiveBoundary(end, modeOf(biz));
}

/**
 * The instant the next invoice will be raised, per status:
 *
 *  - `in_trial`  → the trial end. The trial converting IS the first billing event, and
 *                  the clock schedules it off exactly this instant (`renewal.ts`).
 *  - `future`    → the scheduled start; nothing is billed until the sub actually starts.
 *  - `active`    → the current term's exclusive end = the next term's first instant.
 *  - everything else → null, and it must be null rather than a stale date:
 *      `non_renewing` will never bill again (it cancels at term end — the term end is
 *      reported as `canceled_at`), `paused` bills nothing until resumed, and `cancelled`
 *      is over. Showing a date there would promise a charge that never comes.
 *
 * The trial branch is run through `normalizeTermEnd` because a day-anchored trial ends
 * at the LAST moment of its final day (…T23:59:59 — `alignTrialEnd`), and
 * this field names the instant the invoice is raised: the first instant of the next
 * term, one second later, which is also what the trial-end renewal writes as the new
 * term start. Reported raw it read "Next billing on 03-Aug 23:59" for a term that in
 * fact begins 04-Aug 00:00. An exact midnight — and every instant-anchored business —
 * passes through untouched.
 */
function nextBillingAt(
  s: typeof subscriptions.$inferSelect,
  biz: TermEndConvention,
  skips?: RenewalSkipView,
): Date | null {
  const status = apiSubscriptionStatus(s);
  if (status === "in_trial") return s.trialEnd ? normalizeTermEnd(s.trialEnd, modeOf(biz)) : null;
  if (status === "future") return s.startDate ?? s.currentPeriodStart;
  // A skipped renewal charges nothing recurring, so the next billing is the first one not skipped.
  if (status === "active") {
    const term = skips ? skips.nextBillingAt : s.currentPeriodEnd;
    // A monthly usage invoice inside the term comes first.
    const sub = s.currentSubPeriodEnd;
    return sub && (!term || sub.getTime() < term.getTime()) ? sub : term;
  }
  return null;
}

export function serializeSubscription(
  s: typeof subscriptions.$inferSelect,
  biz: TermEndConvention,
  extra?: {
    items?: Array<{ id: string; price: string; quantity: number }> | SubscriptionItemView[];
    customer?: string | null;
    /** Public id of the subscription's own payment method; null = uses the customer's primary. */
    default_payment_method?: string | null;
    /** `shipping_address_id` + `shipping_address`, from `SubscriptionDetail`. */
    ship_to?: Pick<SubscriptionDetail, "shippingAddressPublicId" | "shipTo">;
    discount?: SubscriptionDetailDiscount | null;
    dues?: { due_invoices_count: number; total_dues_minor: number; due_since: Date | null };
    /** `collectedRevenue` for this subscription's invoices; detail GET only. */
    revenue?: { amount_minor: number; paid_invoices_count: number; first_paid_at: Date | null };
    /** `computeRecurringAmount` (service.ts); omitted when the caller did not load it. */
    recurring_amount_minor?: bigint | null;
    /** `renewalSkipViews`; omitted when the subscription has no scheduled skip. */
    renewalSkips?: RenewalSkipView;
  },
) {
  return {
    object: "subscription",
    id: s.publicId,
    // API status: `non_renewing` when active + cancel_at_period_end
    // or remaining_billing_cycles exhausted (SUB-2). The stored status stays active.
    status: apiSubscriptionStatus(s),
    currency: s.currency,
    // A subscription exposes no billing term while it is in a trial —
    // current_period_start/end are null until it converts to active. tm
    // keeps `[now, trial_end]` internally — the billing clock schedules the trial-end
    // conversion off current_period_end (renewal.ts) — but never surfaces it during the
    // trial. Both become the real term the moment the trial elapses and the sub activates.
    current_period_start: s.status === "in_trial" ? null : s.currentPeriodStart,
    current_period_end: s.status === "in_trial" ? null : termEnd(s.currentPeriodEnd, biz),
    /**
     * When the NEXT invoice will be raised — the only field that answers "when is this
     * customer charged again?" across every status.
     *
     * It exists because `current_period_end` cannot answer it: a trialing subscription
     * deliberately reports no term (above), so the dashboard — which read
     * `current_period_end` — showed "Next billing on —" and "will be raised on —" for the
     * whole trial, which is exactly when a customer asks.
     *
     * NOT run through `termEnd`: that reports a day-anchored term end INCLUSIVELY
     * (…T23:59:59) for display, whereas the invoice is actually raised at the
     * exclusive boundary — the first instant of the next term. Both are correct and they
     * are one second apart; this field is the one the clock acts on.
     */
    next_billing_at: nextBillingAt(s, biz, extra?.renewalSkips),
    // Renewals scheduled to be skipped, as the instants the clock renews at (like
    // `next_billing_at`, not the inclusive term end).
    skipped_renewals: extra?.renewalSkips?.skipped ?? [],
    trial_end: s.trialEnd,
    cancel_at_period_end: s.cancelAtPeriodEnd,
    // For a `non_renewing` subscription (scheduled to cancel at term end),
    // `cancelled_at` reports the scheduled cancellation date. tm
    // stores `canceledAt` only on ACTUAL cancellation, so surface the scheduled
    // date at the API boundary until it actually cancels.
    //
    // A `specific_date` cancel takes precedence over the term-end fallback: it
    // names its own instant, which is the answer to "when does this cancel?" and
    // is usually NOT the term end. It is the exact instant the clock will fire on,
    // so it is passed through raw — unlike the term-end fallback, which reports a
    // day-anchored boundary INCLUSIVELY (…T23:59:59) via `termEnd` for display.
    // Reporting the term end for a scheduled-date cancel would name a date the
    // subscription is not actually cancelled on.
    canceled_at:
      s.canceledAt ??
      s.cancelScheduledAt ??
      (apiSubscriptionStatus(s) === "non_renewing" ? termEnd(s.currentPeriodEnd, biz) : null),
    cancel_reason: s.cancelReason,
    cancel_reason_code: s.cancelReasonCode,
    // Timeline (CP-4)
    start_date: s.startDate,
    started_at: s.startedAt,
    activated_at: s.activatedAt,
    trial_start: s.trialStart,
    billing_period: s.billingPeriod,
    billing_period_unit: s.billingPeriodUnit,
    remaining_billing_cycles: s.remainingBillingCycles,
    // Commercial (CP-1/CP-4)
    auto_collection: s.autoCollection,
    create_pending_invoices: s.createPendingInvoices,
    // Monthly usage billing inside the term (null sub-period when off).
    bill_usage_monthly: s.billUsageMonthly,
    current_sub_period_start: s.currentSubPeriodStart,
    current_sub_period_end: s.currentSubPeriodEnd,
    commitment:
      s.commitmentAmountMinor != null ? { amount_minor: Number(s.commitmentAmountMinor) } : null,
    net_term_days: s.netTermDays,
    po_number: s.poNumber,
    invoice_notes: s.invoiceNotes,
    // Credits Flexibility (0219), subscription half — the most of each bucket that may be
    // AUTO-applied to one invoice for this subscription, in minor units. `null` = no
    // subscription cap (the default). The surface stays flat, like every other
    // commercial field here.
    max_refundable_credits_usage_minor:
      s.maxRefundableCreditsUsageMinor == null ? null : Number(s.maxRefundableCreditsUsageMinor),
    max_excess_payment_usage_minor:
      s.maxExcessPaymentUsageMinor == null ? null : Number(s.maxExcessPaymentUsageMinor),
    // The cached column, unmodified — and deliberately so. `mrr` is FILTERED and
    // SORTED in SQL against `subscriptions.mrr` (`LIST_FILTERS`/`LIST_SORTS` in
    // service.ts), so any adjustment made here would be invisible to the query that
    // decides which rows come back and in what order: `mrr[gt]=0` would return rows
    // this field reports as 0. That was the trial-MRR bug (2026-08-03) — a trialing
    // subscription reports 0 because it STORES 0 (see `recomputeSubscriptionMrr`),
    // not because the serializer hides its rate. Keep every MRR rule on the write
    // side; this line stays a straight read.
    mrr: s.mrr != null ? Number(s.mrr) : null,
    ...(extra?.recurring_amount_minor !== undefined
      ? {
          recurring_amount_minor:
            extra.recurring_amount_minor == null ? null : Number(extra.recurring_amount_minor),
        }
      : {}),
    metadata: s.metadata,
    custom_fields: s.customFields ?? null,
    ...flattenForApi(s.customFields as Record<string, unknown> | null),
    created_at: s.createdAt,
    updated_at: s.updatedAt,
    resource_version: s.resourceVersion,
    ...(extra?.customer != null ? { customer: extra.customer } : {}),
    // Which card this subscription actually charges. Omitted (not null) when the
    // caller didn't resolve it, so a list serializer that doesn't join payment
    // methods can't be mistaken for "this subscription has no override".
    ...(extra?.default_payment_method !== undefined
      ? { default_payment_method: extra.default_payment_method }
      : {}),
    // Omitted, like `default_payment_method`, when the caller did not resolve it.
    ...(extra?.ship_to
      ? {
          shipping_address_id: extra.ship_to.shippingAddressPublicId,
          shipping_address: extra.ship_to.shipTo,
        }
      : {}),
    ...(extra?.items ? { items: extra.items } : {}),
    ...(extra?.discount !== undefined ? { discount: extra.discount } : {}),
    ...(extra?.dues
      ? {
          due_invoices_count: extra.dues.due_invoices_count,
          total_dues_minor: extra.dues.total_dues_minor,
          due_since: extra.dues.due_since,
        }
      : {}),
    ...(extra?.revenue
      ? {
          revenue_to_date_minor: extra.revenue.amount_minor,
          revenue_paid_invoices_count: extra.revenue.paid_invoices_count,
          revenue_since: extra.revenue.first_paid_at,
        }
      : {}),
  };
}

export function serializeScheduledChange(s: typeof scheduledChanges.$inferSelect) {
  return {
    object: "scheduled_change",
    id: s.publicId,
    type: s.type,
    effective_at: s.effectiveAt,
    payload: s.payload,
    status: s.status,
    applied_at: s.appliedAt,
    // Why a scheduled change did not happen (0159). `status: 'failed'` + the
    // message is the answer to "I scheduled a cancellation and it never ran";
    // `last_error` on a still-`scheduled` row means it is mid-retry. Also set on
    // an `applied` row when the change was MOOT (already cancelled by hand) — it
    // records why nothing moved, which is otherwise indistinguishable from a
    // change that applied normally.
    attempts: s.attempts,
    last_error: s.lastError,
    failed_at: s.failedAt,
    created_at: s.createdAt,
  };
}

/**
 * Full-snapshot loader for event content (BLUEPRINT §11 Part B). Loads the
 * subscription row + items + customer public id (via getSubscriptionDetail)
 * and returns the serialized object, or null if not found. `tx` must be the
 * caller's RLS-scoped transaction.
 *
 * NOTE: dues (`due_invoices_count`/`total_dues_minor`/`due_since`) are omitted
 * here — `subscriptionDues()` lives in `./service`, which we must not import
 * from this file (cycle risk). Event snapshots don't need real-time dues.
 *
 * `businessId` is REQUIRED (Bugs #11): subscription public ids are unique per
 * BUSINESS, not per organization, and `tx`'s RLS scope is the organization — so
 * `where public_id = $1 limit 1` alone could return another business's row.
 */
export async function loadSubscriptionSnapshot(
  tx: Tx,
  subPublicId: string,
  businessId: string,
): Promise<Record<string, unknown> | null> {
  const [s] = await tx
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.businessId, businessId), eq(subscriptions.publicId, subPublicId)))
    .limit(1);
  if (!s) return null;

  const [cus] = await tx
    .select({ publicId: customers.publicId })
    .from(customers)
    .where(eq(customers.id, s.customerId))
    .limit(1);

  const itemRows = await tx
    .select({ item: subscriptionItems, price: prices, product: products })
    .from(subscriptionItems)
    .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .innerJoin(products, eq(prices.productId, products.id))
    .where(eq(subscriptionItems.subscriptionId, s.id));
  const items: SubscriptionItemView[] = itemRows.map(({ item, price, product }) => {
    const snap = item.priceSnapshot as PriceSnapshot | null;
    return {
      id: item.publicId,
      price: price.publicId,
      quantity: item.quantity,
      price_model: price.model,
      price_type: price.type,
      interval: price.interval,
      unit_price_minor:
        snap?.amountMinor ?? (price.amountMinor != null ? Number(price.amountMinor) : null),
      unit_price_overridden: snap?.amountOverridden === true,
      ...sellingPriceJson(snap),
      // Identical to the REST mapper in `getSubscriptionDetail` on purpose: an event
      // snapshot and an API poll of the same subscription must not disagree on a
      // field. Keep the two in step if either changes.
      catalog_amount_minor:
        snap?.amountOverridden === true
          ? (snap.catalogAmountMinor ??
            (price.amountMinor != null ? Number(price.amountMinor) : null))
          : null,
      product_name: product.name,
      product_kind: product.kind,
      free_quantity: item.freeQuantity,
      billing_cycles: item.billingCycles,
    };
  });

  const discount = await loadActiveDiscount(tx, s.id);

  // Event snapshots must carry the SAME term-end convention as the REST response for
  // the same subscription — a webhook consumer and an API poller comparing the two
  // would otherwise see boundaries 1ms apart.
  const [biz] = await tx
    .select({ anchorGranularity: businesses.anchorGranularity, timezone: businesses.timezone })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);

  return serializeSubscription(s, biz ?? { anchorGranularity: "instant", timezone: null }, {
    customer: cus?.publicId ?? null,
    items,
    discount,
  });
}

/** The item's selling-price override, as `PATCH …/items/:item` returns it. Absent when none. */
function sellingPriceJson(snap: PriceSnapshot | null) {
  const o = snap?.sellingOverride;
  if (!o) return {};
  return {
    selling_price: {
      markup_percent: o.markupPercent,
      rates: o.rates.map((r) => ({
        match: r.match,
        unit_amount_decimal: r.unitAmountDecimal,
        markup_percent: r.markupPercent,
      })),
    },
  };
}
