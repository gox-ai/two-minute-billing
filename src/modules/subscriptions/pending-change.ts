/**
 * `failed_change_charge: apply_when_paid` — a change applies only once its invoice is paid.
 *
 * The request prices the change as applying it would, at the request instant, raises its
 * invoice (and the unused-time credit notes the change owes) and collects it. Nothing else is
 * written: no items, term, coupons, plan credits or MRR. A `subscription_pending_changes` row
 * keeps what applying writes (`plan`) and the state it was priced on (`fingerprint`).
 *
 *  - Paid (at once, or later by any path that pays the invoice): the change is written, as of
 *    the request instant, in one transaction (`applyPaidPendingChange`). The paid invoice is
 *    the change's invoice; nothing is charged again.
 *  - The subscription moved meanwhile (the fingerprint differs): nothing is applied, and what
 *    the payer paid for the change goes back as a credit note (`keepPaidMoney`), refunded when
 *    the business's `downgrade_credit` rule says so.
 *  - Expired (the earliest of the term end and the expiry hours), replaced by another change,
 *    or ended by a cancel, a pause or a void of the invoice: the invoice and the credit notes
 *    are voided in one transaction (`endPendingChange`). While a payment is in progress the
 *    invoice cannot be voided, so a conflicting request is refused (409) and the expiry waits.
 *
 * Dunning never retries the invoice on its schedule (`dunning_status: stopped`); only an
 * explicit payment pays it: a repeat of the same request, the portal's Pay, an operator's
 * collect, a completed authentication or a slow payment that settles.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, lte, ne } from "drizzle-orm";
import { afterCommit, systemDb, withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { scanBusinessFilter, stampNow } from "@/platform/clock";
import { createLogger } from "@/platform/logger";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData, type EventType } from "@/modules/events/registry";
import { writeAuditLog } from "@/modules/audit/service";
import { BANK_DEBIT_METHODS } from "@/providers/method-types";
import { isMeteredPrice, type PriceSnapshot } from "@/modules/catalog/pricing";
import {
  appliedCoupons,
  appliedTaxes,
  invoiceLineItems,
  creditNoteAllocations,
  creditNotes,
  customers,
  invoices,
  paymentMethods,
  payments,
  prices,
  products,
  refunds,
  subscriptionItems,
  subscriptionPendingChanges,
  subscriptions,
  transactions,
} from "@db/schema";
import { loadBillingRulesRow, resolveBillingRulesConfig } from "./billing-rules-config";
import { isAutoCollectOn } from "@/modules/invoicing/service";
import { AWAITING_AUTHENTICATION_CODE } from "@/modules/payment-methods/mandate-afa";
import type { ComposePlan, HeldCharge } from "./proration";

const log = createLogger("subscriptions.pending-change");

type SubRow = typeof subscriptions.$inferSelect;
type InvoiceRow = typeof invoices.$inferSelect;
export type PendingRow = typeof subscriptionPendingChanges.$inferSelect;
export type PendingSource = "api" | "dashboard" | "checkout" | "portal";
export type PendingEndReason = "expired" | "replaced" | "cancelled" | "voided" | "moved";

/** What a void of the held invoice puts back: a hosted change's coupons, card and PO number. */
export interface PendingRestore {
  /** The active coupon ids before the request; coupons added since are released. */
  coupons?: string[];
  subscription?: { defaultPaymentMethodId: string | null; poNumber: string | null };
  /** The hosted checkout session that asked; its review page shows the held invoice. */
  checkoutSession?: string;
}

/** A change to hold until its invoice is paid. `applyChange` fills the last three. */
export interface ChangeHold {
  source: PendingSource;
  /** The request as sent: stored for display, and a repeat of it pays the same invoice. */
  request: Record<string, unknown>;
  restore?: PendingRestore | null;
  /** The payer is present: the invoice is collected on session, not at its creation. */
  onSession?: boolean;
  /** Why the change could not be held (it applies, and settles as `revert`). */
  blocker?: string;
  /** The change was held: its invoice is raised and nothing else is written. */
  held?: boolean;
  fingerprint?: string;
}

/** A conflicting request while the held invoice's payment is in progress. The API answers 409. */
export class PendingChangeBusyError extends Error {
  readonly statusCode = 409;
  readonly errorType = "conflict_error";
  readonly code = "pending_change_payment_in_progress";
  constructor(invoice: string) {
    super(
      `We could not do this now. A payment for the pending change (invoice ${invoice}) is in progress. Try again when the payment is complete.`,
    );
    this.name = "PendingChangeBusyError";
  }
}

// ── JSON that keeps bigint and Date ──────────────────────────────────────────

export function packJson(v: unknown): unknown {
  if (typeof v === "bigint") return { $bigint: v.toString() };
  if (v instanceof Date) return { $date: v.toISOString() };
  if (Array.isArray(v)) return v.map(packJson);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = packJson(x);
    return out;
  }
  return v;
}

export function unpackJson<T>(v: unknown): T {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 1 && typeof o.$bigint === "string") return BigInt(o.$bigint);
      if (keys.length === 1 && typeof o.$date === "string") return new Date(o.$date);
      const out: Record<string, unknown> = {};
      for (const [k, y] of Object.entries(o)) out[k] = walk(y);
      return out;
    }
    return x;
  };
  return walk(v) as T;
}

function stable(v: unknown): string {
  const p = packJson(v);
  const walk = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(walk)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x as object)
              .sort()
              .map((k) => [k, walk((x as Record<string, unknown>)[k])]),
          )
        : x;
  return JSON.stringify(walk(p));
}

const sha = (v: unknown) => createHash("sha256").update(stable(v)).digest("hex");

export function requestHash(request: Record<string, unknown>): string {
  return sha(request);
}

/** The items, term and coupons a held change was priced on. A replay needs the same. */
export async function subscriptionFingerprint(tx: Tx, subscriptionId: string): Promise<string> {
  const [sub] = await tx
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))
    .limit(1);
  if (!sub) return "gone";
  const items = await tx
    .select({
      id: subscriptionItems.id,
      priceId: subscriptionItems.priceId,
      quantity: subscriptionItems.quantity,
      freeQuantity: subscriptionItems.freeQuantity,
      billingCycles: subscriptionItems.billingCycles,
      cyclesBilled: subscriptionItems.cyclesBilled,
      snapshot: subscriptionItems.priceSnapshot,
    })
    .from(subscriptionItems)
    .where(eq(subscriptionItems.subscriptionId, sub.id))
    .orderBy(subscriptionItems.id);
  const coupons = await tx
    .select({ id: appliedCoupons.id })
    .from(appliedCoupons)
    // `exhausted` too: the held invoice itself may use up a once-only coupon.
    .where(
      and(
        eq(appliedCoupons.subscriptionId, sub.id),
        inArray(appliedCoupons.status, ["active", "exhausted"]),
      ),
    )
    .orderBy(appliedCoupons.id);
  return sha({
    status: sub.status,
    start: sub.currentPeriodStart,
    end: sub.currentPeriodEnd,
    period: sub.billingPeriod,
    unit: sub.billingPeriodUnit,
    anchor: sub.billingAnchorDay,
    commitment: sub.commitmentAmountMinor,
    monthly: sub.billUsageMonthly,
    items,
    coupons: coupons.map((c) => c.id),
  });
}

// ── Can this change be held? ─────────────────────────────────────────────────

type PlanForHold = ComposePlan & {
  lines: Array<{
    amountMinor: bigint;
    oneTimeItemId?: string | null;
    requestedAddIsOneTime?: boolean;
  }>;
  movedPlan: { productId: string; publicId: string } | null;
};

/**
 * Why a replay could not write this change exactly as it was priced, or null. A change that
 * edits a discount, re-cuts a deferred charge, settles metered usage, bills a one-time fee or
 * ends a term with a commitment books money in the same writes, so it is not held.
 */
export async function holdBlocker(
  organizationId: string,
  businessId: string,
  plan: PlanForHold,
  input: {
    couponCode?: string;
    manualDiscount?: unknown;
    removeDiscount?: boolean;
    planChangeCoupons?: import("./lifecycle-config").PlanChangeCoupons;
  },
): Promise<string | null> {
  if (input.couponCode || input.manualDiscount || input.removeDiscount) return "discount";
  if (plan.unbilledSettlements.length) return "deferred_charges";
  if (plan.lines.some((l) => l.oneTimeItemId || l.requestedAddIsOneTime)) return "one_time_charge";
  if (plan.resetTerm && (plan.sub.commitmentAmountMinor ?? 0n) > 0n) return "commitment";
  return withTenant(organizationId, async (tx) => {
    const ids = plan.resetTerm ? plan.allItemIds : plan.removals.map((r) => r.itemId);
    if (ids.length) {
      const rows = await tx
        .select({ snapshot: subscriptionItems.priceSnapshot })
        .from(subscriptionItems)
        .where(inArray(subscriptionItems.id, ids));
      if (rows.some((r) => r.snapshot && isMeteredPrice(r.snapshot as PriceSnapshot)))
        return "metered_usage";
    }
    if (plan.movedPlan) {
      const { couponsLeftBehind } = await import("./plan-change-coupons");
      const drop = await couponsLeftBehind(tx, {
        businessId,
        subscriptionId: plan.sub.id,
        newPlan: { productId: plan.movedPlan.productId, pricePublicId: plan.movedPlan.publicId },
        ...(input.planChangeCoupons ? { rule: input.planChangeCoupons } : {}),
      });
      if (drop.length) return "discount";
    }
    return null;
  });
}

/** What a replay writes, from the plan phase's result. */
export function composePlanOf(
  plan: ComposePlan,
  extra: { metadata?: Record<string, unknown> | null; resetOverrides?: unknown },
): Record<string, unknown> {
  const { sub: _sub, ...rest } = plan;
  return packJson({
    compose: {
      updates: rest.updates,
      inserts: rest.inserts,
      removals: rest.removals,
      unbilledSettlements: [],
      resetTerm: rest.resetTerm,
      inTrial: rest.inTrial,
      resetStart: rest.resetStart,
      newPeriodEnd: rest.newPeriodEnd,
      resetAnchorDay: rest.resetAnchorDay,
      newInterval: rest.newInterval,
      newIntervalCount: rest.newIntervalCount,
      bizMode: rest.bizMode,
      postMonthlyUsage: rest.postMonthlyUsage,
      postCommitmentMinor: rest.postCommitmentMinor,
      prorationNow: rest.prorationNow,
      allItemIds: rest.allItemIds,
    },
    ...(extra.metadata !== undefined ? { metadata: extra.metadata } : {}),
    ...(extra.resetOverrides ? { resetOverrides: extra.resetOverrides } : {}),
  }) as Record<string, unknown>;
}

// ── Record ───────────────────────────────────────────────────────────────────

/** A bank debit, a mandate or an offline invoice: settles in days, not seconds. */
async function slowMethod(tx: Tx, sub: SubRow): Promise<boolean> {
  const [cus] = await tx
    .select({ autoCollection: customers.autoCollection })
    .from(customers)
    .where(eq(customers.id, sub.customerId))
    .limit(1);
  if (!isAutoCollectOn(sub.autoCollection ?? null, cus?.autoCollection ?? null)) return true;
  const [pm] = sub.defaultPaymentMethodId
    ? await tx
        .select({ type: paymentMethods.type, rail: paymentMethods.mandateRail })
        .from(paymentMethods)
        .where(eq(paymentMethods.id, sub.defaultPaymentMethodId))
        .limit(1)
    : await tx
        .select({ type: paymentMethods.type, rail: paymentMethods.mandateRail })
        .from(paymentMethods)
        .where(
          and(eq(paymentMethods.customerId, sub.customerId), eq(paymentMethods.role, "primary")),
        )
        .limit(1);
  return !!pm && (pm.rail != null || BANK_DEBIT_METHODS.has(pm.type));
}

/** The earliest of the term end and `requested_at` + the hours. Never past a renewal. */
export function pendingExpiry(requestedAt: Date, periodEnd: Date | null, hours: number): Date {
  const byHours = new Date(requestedAt.getTime() + hours * 3_600_000);
  return periodEnd && periodEnd.getTime() < byHours.getTime() ? periodEnd : byHours;
}

/**
 * Runs inside the held invoice's own transaction: the row lands with the invoice, before the
 * collection, so a payment that settles at once (or by webhook) finds it.
 */
export async function recordPendingChange(
  tx: Tx,
  a: {
    organizationId: string;
    businessId: string;
    sub: SubRow;
    invoice: InvoiceRow;
    hold: ChangeHold;
    kind: "change" | "item_add";
    plan: Record<string, unknown>;
    creditNoteIds: string[];
    requestedAt: Date;
  },
): Promise<void> {
  const rules = resolveBillingRulesConfig(
    await loadBillingRulesRow(a.organizationId, a.businessId, tx),
  );
  const hours = (await slowMethod(tx, a.sub))
    ? rules.pendingChangeExpiryHoursSlow
    : rules.pendingChangeExpiryHours;
  const expiresAt = pendingExpiry(a.requestedAt, a.sub.currentPeriodEnd, hours);
  await tx.insert(subscriptionPendingChanges).values({
    organizationId: a.organizationId,
    businessId: a.businessId,
    subscriptionId: a.sub.id,
    publicId: publicId("spc"),
    invoiceId: a.invoice.id,
    kind: a.kind,
    request: packJson(a.hold.request) as Record<string, unknown>,
    requestHash: requestHash(a.hold.request),
    plan: a.plan,
    fingerprint: a.hold.fingerprint ?? (await subscriptionFingerprint(tx, a.sub.id)),
    creditNoteIds: a.creditNoteIds,
    restore: (a.hold.restore ?? null) as Record<string, unknown> | null,
    source: a.hold.source,
    requestedAt: a.requestedAt,
    expiresAt,
  });
  // Dunning never retries it on the schedule: only an explicit payment pays it. It is due by
  // the expiry, so no screen or reminder calls it overdue while the change waits.
  await tx
    .update(invoices)
    .set({ dunningStatus: "stopped", nextAttemptAt: null, dueDate: expiresAt })
    .where(
      and(
        eq(invoices.id, a.invoice.id),
        inArray(invoices.status, ["posted", "payment_due", "not_paid"]),
      ),
    );
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function livePendingChange(
  tx: Tx,
  subscriptionId: string,
): Promise<PendingRow | null> {
  const [row] = await tx
    .select()
    .from(subscriptionPendingChanges)
    .where(
      and(
        eq(subscriptionPendingChanges.subscriptionId, subscriptionId),
        eq(subscriptionPendingChanges.status, "pending"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** `pending_change` on the subscription object; null when nothing is held. */
export async function pendingChangeView(tx: Tx, subscriptionId: string) {
  const row = await livePendingChange(tx, subscriptionId);
  if (!row) return null;
  const [inv] = await tx
    .select({
      publicId: invoices.publicId,
      status: invoices.status,
      totalMinor: invoices.totalMinor,
      amountDueMinor: invoices.amountDueMinor,
      currency: invoices.currency,
    })
    .from(invoices)
    .where(eq(invoices.id, row.invoiceId))
    .limit(1);
  return {
    ...serializePendingChange(row, inv ?? null),
    items: await describeHeld(tx, row),
  };
}

/** What the held request does to each item, with the product names a person reads. */
async function describeHeld(tx: Tx, row: PendingRow) {
  const r = unpackJson<{
    price?: string;
    quantity?: number;
    changes?: Array<{ itemId: string; newPriceId?: string; newQuantity?: number }>;
    adds?: Array<{ priceId: string; quantity?: number }>;
    removes?: string[];
  }>(row.request);
  const pricePids = [
    ...(r.price ? [r.price] : []),
    ...(r.changes ?? []).flatMap((c) => (c.newPriceId ? [c.newPriceId] : [])),
    ...(r.adds ?? []).map((a) => a.priceId),
  ];
  const itemPids = [...(r.changes ?? []).map((c) => c.itemId), ...(r.removes ?? [])];
  const byPrice = new Map(
    (pricePids.length
      ? await tx
          .select({ pid: prices.publicId, name: products.name })
          .from(prices)
          .innerJoin(products, eq(products.id, prices.productId))
          .where(and(eq(prices.businessId, row.businessId), inArray(prices.publicId, pricePids)))
      : []
    ).map((x) => [x.pid, x.name]),
  );
  const byItem = new Map(
    (itemPids.length
      ? await tx
          .select({
            pid: subscriptionItems.publicId,
            price: prices.publicId,
            name: products.name,
            quantity: subscriptionItems.quantity,
          })
          .from(subscriptionItems)
          .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
          .innerJoin(products, eq(products.id, prices.productId))
          .where(
            and(
              eq(subscriptionItems.subscriptionId, row.subscriptionId),
              inArray(subscriptionItems.publicId, itemPids),
            ),
          )
      : []
    ).map((x) => [x.pid, x]),
  );
  type Line = {
    action: "change" | "add" | "remove";
    price: string | null;
    product_name: string | null;
    quantity: number | null;
    /** For a change: the item's product and quantity before it. */
    from_product_name?: string | null;
    from_quantity?: number | null;
  };
  const out: Line[] = [];
  if (row.kind === "item_add" && r.price)
    out.push({
      action: "add",
      price: r.price,
      product_name: byPrice.get(r.price) ?? null,
      quantity: r.quantity ?? 1,
    });
  for (const c of r.changes ?? []) {
    const was = byItem.get(c.itemId);
    const price = c.newPriceId ?? was?.price ?? null;
    out.push({
      action: "change",
      price,
      product_name: (c.newPriceId ? byPrice.get(c.newPriceId) : was?.name) ?? null,
      quantity: c.newQuantity ?? was?.quantity ?? null,
      from_product_name: was?.name ?? null,
      from_quantity: was?.quantity ?? null,
    });
  }
  for (const a of r.adds ?? [])
    out.push({
      action: "add",
      price: a.priceId,
      product_name: byPrice.get(a.priceId) ?? null,
      quantity: a.quantity ?? 1,
    });
  for (const id of r.removes ?? []) {
    const was = byItem.get(id);
    out.push({
      action: "remove",
      price: was?.price ?? null,
      product_name: was?.name ?? null,
      quantity: was?.quantity ?? null,
    });
  }
  return out;
}

export function serializePendingChange(
  row: PendingRow,
  inv: {
    publicId: string;
    status: string;
    totalMinor: bigint;
    amountDueMinor: bigint | null;
    currency: string;
  } | null,
) {
  return {
    object: "pending_change" as const,
    id: row.publicId,
    kind: row.kind,
    status: row.status,
    invoice: inv?.publicId ?? null,
    invoice_status: inv?.status ?? null,
    amount_due_minor: inv ? Number(inv.amountDueMinor ?? inv.totalMinor) : null,
    currency: inv?.currency ?? null,
    request: unpackJson<Record<string, unknown>>(row.request),
    source: row.source,
    requested_at: row.requestedAt,
    expires_at: row.expiresAt,
    end_reason: row.endReason,
  };
}

/**
 * What a held change costs, read off its invoice: a review page shows this, not a fresh price.
 * A re-price after the hold is wrong, because the change's own credit note already sits on the
 * held invoice, so the unused-time credit is gone from the new quote.
 */
export interface HeldQuote {
  pendingChange: string;
  invoice: string;
  currency: string;
  lines: Array<{ description: string; amountMinor: number }>;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  taxLines: Array<{ label: string; amountMinor: number }>;
  invoiceTotalMinor: number;
  /** The change's own unused-time credit on the invoice. */
  changeCreditMinor: number;
  /** Other refundable and excess credit the invoice drew. */
  otherCreditsMinor: number;
  promotionalDiscountMinor: number;
  paidMinor: number;
  /** What a payment collects now. */
  amountDueMinor: number;
  expiresAt: Date;
}

export async function heldQuote(tx: Tx, row: PendingRow): Promise<HeldQuote | null> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, row.invoiceId)).limit(1);
  if (!inv) return null;
  const lines = await tx
    .select({
      description: invoiceLineItems.description,
      amount: invoiceLineItems.amountMinor,
      kind: invoiceLineItems.kind,
    })
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, inv.id))
    .orderBy(invoiceLineItems.seq);
  const taxes = await tx
    .select({ name: appliedTaxes.name, amount: appliedTaxes.amountMinor })
    .from(appliedTaxes)
    .where(eq(appliedTaxes.invoiceId, inv.id));
  const taxByName = new Map<string, bigint>();
  for (const t of taxes) taxByName.set(t.name, (taxByName.get(t.name) ?? 0n) + t.amount);
  const own = row.creditNoteIds.length
    ? await tx
        .select({ amount: creditNoteAllocations.amountMinor })
        .from(creditNoteAllocations)
        .innerJoin(creditNotes, eq(creditNotes.id, creditNoteAllocations.creditNoteId))
        .where(
          and(
            eq(creditNoteAllocations.invoiceId, inv.id),
            inArray(creditNotes.publicId, row.creditNoteIds),
          ),
        )
    : [];
  const change = own.reduce((t, r) => t + r.amount, 0n);
  const paid = (
    await tx
      .select({ amount: payments.amountMinor })
      .from(payments)
      .where(and(eq(payments.invoiceId, inv.id), eq(payments.status, "succeeded")))
  ).reduce((t, p) => t + p.amount, 0n);
  const charges = lines.filter((l) => l.kind !== "discount");
  const discount = -lines.filter((l) => l.kind === "discount").reduce((t, l) => t + l.amount, 0n);
  const tax = [...taxByName.values()].reduce((t, v) => t + v, 0n);
  const promo = inv.promotionalCreditsAppliedMinor ?? 0n;
  const other =
    (inv.refundableCreditsAppliedMinor ?? 0n) - change + (inv.excessPaymentsAppliedMinor ?? 0n);
  const issueDue = inv.amountDueMinor ?? inv.totalMinor;
  const due = inv.status === "voided" || inv.status === "paid" ? 0n : issueDue - paid;
  return {
    pendingChange: row.publicId,
    invoice: inv.publicId,
    currency: inv.currency,
    lines: charges.map((l) => ({ description: l.description, amountMinor: Number(l.amount) })),
    subtotalMinor: Number(inv.subtotalMinor),
    discountMinor: Number(discount),
    taxMinor: Number(tax),
    taxLines: [...taxByName].map(([label, v]) => ({ label, amountMinor: Number(v) })),
    invoiceTotalMinor: Number(inv.totalMinor - promo),
    changeCreditMinor: Number(change),
    otherCreditsMinor: Number(other > 0n ? other : 0n),
    promotionalDiscountMinor: Number(promo),
    paidMinor: Number(paid),
    amountDueMinor: Number(due > 0n ? due : 0n),
    expiresAt: row.expiresAt,
  };
}

// ── Events and audit ─────────────────────────────────────────────────────────

async function announce(
  tx: Tx,
  row: PendingRow,
  type: Extract<
    EventType,
    | "subscription_pending_change_created"
    | "subscription_pending_change_applied"
    | "subscription_pending_change_expired"
  >,
  reason?: PendingEndReason,
): Promise<void> {
  const [sub] = await tx
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, row.subscriptionId))
    .limit(1);
  const [inv] = await tx
    .select({ publicId: invoices.publicId })
    .from(invoices)
    .where(eq(invoices.id, row.invoiceId))
    .limit(1);
  if (!sub) return;
  const view = {
    id: row.publicId,
    kind: row.kind,
    invoice: inv?.publicId ?? null,
    requested_at: row.requestedAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    ...(reason ? { reason } : {}),
  };
  await emitEvent(tx, {
    organizationId: row.organizationId,
    businessId: row.businessId,
    type,
    // Top level: the `subscription` key is replaced by its full snapshot on emit.
    data: buildEventData(type, { id: sub.publicId, status: sub.status }, sub.resourceVersion, {
      pending_change: view,
    }),
  });
  const action =
    type === "subscription_pending_change_created"
      ? "subscription.pending_change_created"
      : type === "subscription_pending_change_applied"
        ? "subscription.pending_change_applied"
        : "subscription.pending_change_expired";
  await writeAuditLog(
    {
      organizationId: row.organizationId,
      businessId: row.businessId,
      action,
      resourceType: "subscription",
      resourceId: sub.publicId,
      before: { pending_change: type === "subscription_pending_change_created" ? null : view.id },
      after: { pending_change: view },
    },
    tx,
  );
}

// ── After the collection ─────────────────────────────────────────────────────

/** The newest failed payment on the invoice, in the words the payer is shown. */
async function lastDecline(
  tx: Tx,
  businessId: string,
  invoiceId: string,
): Promise<{ code: string | null; message: string | null }> {
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
  if (!t) return { code: null, message: null };
  const { storedPayerDeclineMessage } = await import("./decline-overrides");
  return {
    code: t.code ?? "payment_failed",
    message: await storedPayerDeclineMessage(
      tx,
      { businessId, code: t.code ?? null, message: t.text ?? null },
      "The payment was not completed.",
    ),
  };
}

/** A payment still out at the gateway; with `authenticating`, one waiting for the payer too. */
async function inFlightOn(tx: Tx, invoiceId: string, authenticating = false): Promise<boolean> {
  const [p] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.invoiceId, invoiceId),
        inArray(payments.status, authenticating ? ["pending", "requires_action"] : ["pending"]),
      ),
    )
    .limit(1);
  return !!p;
}

const REQUIRES_ACTION_CODES = new Set(["requires_action", AWAITING_AUTHENTICATION_CODE]);

/**
 * The held invoice after an attempt: applied when it is paid, else what the 402 says. `announce`
 * is the request that held it (it emits `subscription_pending_change_created` once).
 */
export async function settleHeldInvoice(input: {
  organizationId: string;
  businessId: string;
  invoiceId: string;
  announce: boolean;
  onSession?: boolean;
}): Promise<{ applied: true } | { applied: false; held: HeldCharge }> {
  const { organizationId, businessId } = input;
  const load = async () =>
    (
      await withTenant(organizationId, (tx) =>
        tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1),
      )
    )[0];
  let inv = await load();
  let intent: HeldCharge["intent"] = null;
  // On session the request raised the invoice without a charge: collect it on session, so a
  // challenge returns the payment intent to authenticate, as a signup does.
  if (input.onSession && inv && ["posted", "payment_due"].includes(inv.status)) {
    const [tried] = await withTenant(organizationId, (tx) =>
      tx
        .select({ id: payments.id })
        .from(payments)
        .where(eq(payments.invoiceId, input.invoiceId))
        .limit(1),
    );
    if (!tried) {
      intent = await onSessionIntent(organizationId, businessId, inv);
      inv = await load();
    }
  }
  if (inv?.status === "paid") {
    const r = await applyPaidPendingChange(organizationId, input.invoiceId);
    if (r === "applied") return { applied: true };
    const { ProrationError } = await import("./proration");
    throw new ProrationError(
      "We could not change the subscription. It changed while the payment was made. We kept the payment as credit on the account.",
    );
  }
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(subscriptionPendingChanges)
      .where(eq(subscriptionPendingChanges.invoiceId, input.invoiceId))
      .for("update")
      .limit(1);
    if (!row) throw new Error(`no pending change for invoice ${input.invoiceId}`);
    const inFlight = await inFlightOn(tx, input.invoiceId);
    // An off-session challenge is booked in progress, waiting for the payer (the bank asks).
    const [waiting] = inFlight
      ? await tx
          .select({ id: transactions.id })
          .from(transactions)
          .where(
            and(
              eq(transactions.invoiceId, input.invoiceId),
              eq(transactions.status, "in_progress"),
              eq(transactions.errorCode, AWAITING_AUTHENTICATION_CODE),
            ),
          )
          .limit(1)
      : [];
    let expiresAt = row.expiresAt;
    // A slow payment is in progress: the change waits the slow hours, never past the term.
    if (inFlight && !waiting && row.status === "pending") {
      const [sub] = await tx
        .select({ end: subscriptions.currentPeriodEnd })
        .from(subscriptions)
        .where(eq(subscriptions.id, row.subscriptionId))
        .limit(1);
      const rules = resolveBillingRulesConfig(
        await loadBillingRulesRow(organizationId, businessId, tx),
      );
      const slow = pendingExpiry(
        row.requestedAt,
        sub?.end ?? null,
        rules.pendingChangeExpiryHoursSlow,
      );
      if (slow.getTime() > expiresAt.getTime()) {
        expiresAt = slow;
        await tx
          .update(subscriptionPendingChanges)
          .set({ expiresAt })
          .where(eq(subscriptionPendingChanges.id, row.id));
        await tx
          .update(invoices)
          .set({ dueDate: expiresAt })
          .where(and(eq(invoices.id, row.invoiceId), ne(invoices.status, "voided")));
      }
    }
    if (input.announce && row.status === "pending")
      await announce(tx, { ...row, expiresAt }, "subscription_pending_change_created");
    const decline = inFlight
      ? { code: waiting ? AWAITING_AUTHENTICATION_CODE : null, message: null }
      : await lastDecline(tx, businessId, input.invoiceId);
    return {
      applied: false as const,
      held: {
        kind: row.kind,
        code:
          intent || waiting || REQUIRES_ACTION_CODES.has(decline.code ?? "")
            ? ("requires_action" as const)
            : ("payment_failed" as const),
        pendingChange: row.publicId,
        invoice: inv?.publicId ?? "",
        expiresAt,
        inFlight,
        declineCode: decline.code,
        declineMessage: decline.message,
        intent,
      },
    };
  });
}

async function onSessionIntent(
  organizationId: string,
  businessId: string,
  inv: InvoiceRow,
): Promise<HeldCharge["intent"]> {
  const { collectInvoice, PaymentActionRequiredError } =
    await import("@/modules/invoicing/service");
  const [sub] = inv.subscriptionId
    ? await withTenant(organizationId, (tx) =>
        tx.select().from(subscriptions).where(eq(subscriptions.id, inv.subscriptionId!)).limit(1),
      )
    : [];
  try {
    await collectInvoice({
      organizationId,
      businessId,
      invoice: inv,
      ...(sub ? { subscription: sub } : {}),
      session: "on_session",
      manualAttempt: true,
    });
  } catch (e) {
    if (e instanceof PaymentActionRequiredError) return e.intent;
    log.warn("on-session attempt for a held change failed", {
      event: "pending_change_on_session_failed",
      invoice: inv.publicId,
      error: (e as Error).message,
    });
  }
  return null;
}

// ── Apply on payment ─────────────────────────────────────────────────────────

class ReplayMovedError extends Error {}

/**
 * The held invoice is paid: write the change as of the request instant, in one transaction.
 * Idempotent; every path that pays the invoice reaches it (`activatePaidCreditGrants`), and
 * the `pending_changes` pass catches a miss. When the subscription moved, the money is kept
 * as credit and nothing is applied.
 */
export async function applyPaidPendingChange(
  organizationId: string,
  invoiceId: string,
): Promise<"applied" | "kept" | "none"> {
  const outcome = await withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(subscriptionPendingChanges)
      .where(eq(subscriptionPendingChanges.invoiceId, invoiceId))
      .for("update")
      .limit(1);
    if (!row) return { kind: "none" as const };
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    if (inv?.status !== "paid") return { kind: "none" as const };
    if (row.status === "applied") return { kind: "applied" as const };
    if (row.status !== "pending")
      return { kind: row.keptCreditNote ? ("none" as const) : ("kept" as const), row };
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, row.subscriptionId))
      .for("update")
      .limit(1);
    const moved =
      !sub ||
      sub.status === "cancelled" ||
      (await subscriptionFingerprint(tx, sub.id)) !== row.fingerprint;
    if (!moved) {
      try {
        await tx.transaction((sp) => replay(sp, row, sub!, inv));
      } catch (e) {
        if (!(e instanceof ReplayMovedError)) throw e;
        return endMoved(tx, row);
      }
      const now = stampNow(row.businessId);
      await tx
        .update(subscriptionPendingChanges)
        .set({ status: "applied", appliedAt: now })
        .where(eq(subscriptionPendingChanges.id, row.id));
      await announce(tx, row, "subscription_pending_change_applied");
      log.info("held change applied", {
        event: "pending_change_applied",
        pendingChange: row.publicId,
        invoice: inv.publicId,
      });
      return { kind: "applied" as const };
    }
    return endMoved(tx, row);
  });
  if (outcome.kind === "kept") {
    await keepPaidMoney(organizationId, outcome.row!);
    return "kept";
  }
  return outcome.kind;
}

async function endMoved(tx: Tx, row: PendingRow) {
  await tx
    .update(subscriptionPendingChanges)
    .set({ status: "expired", endReason: "moved", endedAt: stampNow(row.businessId) })
    .where(eq(subscriptionPendingChanges.id, row.id));
  await announce(tx, row, "subscription_pending_change_expired", "moved");
  log.error("held change paid after the subscription moved; the payment is kept as credit", {
    event: "pending_change_moved",
    pendingChange: row.publicId,
  });
  return { kind: "kept" as const, row };
}

async function replay(tx: Tx, row: PendingRow, sub: SubRow, inv: InvoiceRow): Promise<void> {
  const { subscriptionSnapshot } = await import("./audit");
  if (row.kind === "item_add") {
    const p = unpackJson<{
      priceId: string;
      quantity: number;
      snapshot: PriceSnapshot;
      isOneTime: boolean;
    }>(row.plan);
    const [item] = await tx
      .insert(subscriptionItems)
      .values({
        organizationId: row.organizationId,
        businessId: row.businessId,
        subscriptionId: sub.id,
        publicId: publicId("si"),
        priceId: p.priceId,
        quantity: p.quantity,
        priceSnapshot: p.snapshot,
        // A one-time fee's single cycle is the paid invoice.
        ...(p.isOneTime ? { cyclesBilled: 1 } : {}),
      })
      .onConflictDoNothing()
      .returning();
    if (!item) throw new ReplayMovedError();
    const { recomputeSubscriptionMrr } = await import("./service");
    const { syncMeterBilling } = await import("./meter-billing");
    const before = await subscriptionSnapshot(tx, sub);
    await recomputeSubscriptionMrr(tx, sub.id, row.requestedAt);
    await syncMeterBilling(tx, sub.id);
    const [price] = await tx
      .select({ publicId: prices.publicId })
      .from(prices)
      .where(eq(prices.id, p.priceId))
      .limit(1);
    const [after] = await tx.select().from(subscriptions).where(eq(subscriptions.id, sub.id));
    await emitEvent(tx, {
      organizationId: row.organizationId,
      businessId: row.businessId,
      type: "subscription_changed",
      data: buildEventData(
        "subscription_changed",
        { id: sub.publicId, status: sub.status, item_added: price?.publicId ?? null },
        after!.resourceVersion,
      ),
    });
    const { auditSubscription } = await import("./audit");
    await auditSubscription(tx, {
      organizationId: row.organizationId,
      businessId: row.businessId,
      action: "subscription.change",
      before,
      after: after!,
    });
    return;
  }
  const p = unpackJson<{
    compose: Omit<ComposePlan, "sub">;
    metadata?: Record<string, unknown> | null;
    resetOverrides?: import("@/modules/credits/reset-settings").ResetOverrides;
  }>(row.plan);
  const beforeFull = await subscriptionSnapshot(tx, sub);
  const [current] =
    p.metadata !== undefined
      ? await tx
          .update(subscriptions)
          .set({ metadata: p.metadata, updatedAt: stampNow(row.businessId) })
          .where(eq(subscriptions.id, sub.id))
          .returning()
      : [sub];
  const { writeChangeComposition } = await import("./proration");
  const c = await writeChangeComposition(tx, {
    organizationId: row.organizationId,
    businessId: row.businessId,
    now: row.requestedAt,
    plan: { ...p.compose, sub: current ?? sub },
    beforeFull,
    appliedCouponId: null,
    ...(p.resetOverrides ? { resetOverrides: p.resetOverrides } : {}),
  });
  if (c.skipped.size || c.skippedRequestKeys.size) throw new ReplayMovedError();
  // `grant_when: invoice_paid`: the new plan's credits open now, the invoice being paid.
  const { settleHeldChangeGrants } = await import("@/modules/credits/service");
  await settleHeldChangeGrants(tx, { subscriptionId: sub.id, invoiceId: inv.id });
}

/**
 * Paid, but the change will not apply: give the payer back what the invoice took, except the
 * unused-time credit this change's own credit notes put on it (the old plan runs on, so that
 * time is not owed). Cash and other refundable credit become one refundable credit note,
 * refunded when `downgrade_credit` says so; promotional and excess credit and credit-grant
 * draws go back to where they came from. Idempotent on `kept_credit_note`.
 */
async function keepPaidMoney(organizationId: string, row: PendingRow): Promise<void> {
  const note = await withTenant(organizationId, async (tx) => {
    const [fresh] = await tx
      .select()
      .from(subscriptionPendingChanges)
      .where(eq(subscriptionPendingChanges.id, row.id))
      .for("update")
      .limit(1);
    if (!fresh || fresh.keptCreditNote) return null;
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, row.invoiceId)).limit(1);
    if (!inv || inv.status !== "paid") return null;
    const { lockCustomerBalances, PROMOTIONAL_CREDIT, EXCESS_PAYMENT } =
      await import("@/modules/customers/balances-read");
    await lockCustomerBalances(tx, inv.customerId);
    const own = fresh.creditNoteIds.length
      ? await tx
          .select({ amount: creditNoteAllocations.amountMinor })
          .from(creditNoteAllocations)
          .innerJoin(creditNotes, eq(creditNotes.id, creditNoteAllocations.creditNoteId))
          .where(
            and(
              eq(creditNoteAllocations.invoiceId, inv.id),
              inArray(creditNotes.publicId, fresh.creditNoteIds),
            ),
          )
      : [];
    const fromChange = own.reduce((s, r) => s + r.amount, 0n);
    const paid = await tx
      .select({ id: payments.id, amount: payments.amountMinor })
      .from(payments)
      .where(and(eq(payments.invoiceId, inv.id), eq(payments.status, "succeeded")));
    const refunded = paid.length
      ? await tx
          .select({ amount: refunds.amountMinor })
          .from(refunds)
          .where(
            and(
              inArray(
                refunds.paymentId,
                paid.map((p) => p.id),
              ),
              eq(refunds.status, "succeeded"),
            ),
          )
      : [];
    const cash =
      paid.reduce((s, p) => s + p.amount, 0n) - refunded.reduce((s, r) => s + r.amount, 0n);
    const refundableOther = (inv.refundableCreditsAppliedMinor ?? 0n) - fromChange;
    const promo = inv.promotionalCreditsAppliedMinor ?? 0n;
    const excess = inv.excessPaymentsAppliedMinor ?? 0n;
    const { postEntries } = await import("@/modules/ledger/service");
    const bucketLines: Array<{
      account: string;
      direction: "debit" | "credit";
      amountMinor: bigint;
      currency: string;
    }> = [];
    if (promo > 0n)
      bucketLines.push(
        {
          account: "promotional_credit",
          direction: "debit",
          amountMinor: promo,
          currency: inv.currency,
        },
        {
          account: PROMOTIONAL_CREDIT,
          direction: "credit",
          amountMinor: promo,
          currency: inv.currency,
        },
      );
    if (excess > 0n)
      bucketLines.push(
        {
          account: "credit_adjustments",
          direction: "debit",
          amountMinor: excess,
          currency: inv.currency,
        },
        {
          account: EXCESS_PAYMENT,
          direction: "credit",
          amountMinor: excess,
          currency: inv.currency,
        },
      );
    if (bucketLines.length)
      await postEntries(
        {
          organizationId,
          businessId: inv.businessId,
          customerId: inv.customerId,
          sourceType: "pending_change_restore",
          sourceId: inv.publicId,
          lines: bucketLines,
        },
        tx,
      );
    const { restoreGrantDraws } = await import("@/modules/credits/service");
    await restoreGrantDraws(tx, {
      organizationId,
      businessId: inv.businessId,
      customerId: inv.customerId,
      invoiceId: inv.id,
      invoicePublicId: inv.publicId,
      faceMinor: "all",
      ledger: true,
      sourceType: "pending_change_restore",
    });
    const amount = cash + (refundableOther > 0n ? refundableOther : 0n);
    let cn: { publicId: string } | null = null;
    if (amount > 0n) {
      const { createRefundableCreditNote } = await import("@/modules/credit-notes/service");
      cn = await createRefundableCreditNote(tx, {
        organizationId,
        businessId: inv.businessId,
        customerId: inv.customerId,
        invoiceId: inv.id,
        invoicePublicId: inv.publicId,
        currency: inv.currency,
        items: [
          {
            description: `Plan change not applied: payment of invoice ${inv.publicId} kept as credit`,
            amountMinor: Number(amount),
          },
        ],
        reasonCode: "pending_change_not_applied",
        reason: "The subscription changed before the payment for the plan change completed.",
      });
    }
    await tx
      .update(subscriptionPendingChanges)
      .set({ keptCreditNote: cn?.publicId ?? "none" })
      .where(eq(subscriptionPendingChanges.id, row.id));
    await writeAuditLog(
      {
        organizationId,
        businessId: inv.businessId,
        action: "subscription.pending_change_money_kept",
        resourceType: "invoice",
        resourceId: inv.publicId,
        before: null,
        after: {
          pending_change: fresh.publicId,
          credit_note: cn?.publicId ?? null,
          cash_minor: Number(cash),
          refundable_minor: Number(refundableOther > 0n ? refundableOther : 0n),
          promotional_minor: Number(promo),
          excess_minor: Number(excess),
          unused_time_kept_minor: Number(fromChange),
        },
      },
      tx,
    );
    return cn ? { note: cn, businessId: inv.businessId } : null;
  });
  if (!note) return;
  const { refundChangeCredit } = await import("./downgrade-credit");
  await refundChangeCredit({
    organizationId,
    businessId: note.businessId,
    creditNotes: [note.note],
  });
}

// ── End ──────────────────────────────────────────────────────────────────────

/**
 * End a pending change that will not apply: void its invoice and credit notes, put back what a
 * hosted change wrote, in one transaction. Returns `paid` when the invoice was paid meanwhile
 * (the caller applies it). Throws `PendingChangeBusyError` while a payment is in progress.
 */
export async function endPendingChange(
  organizationId: string,
  businessId: string,
  pendingId: string,
  reason: Exclude<PendingEndReason, "moved" | "voided">,
): Promise<"ended" | "paid" | "gone"> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(subscriptionPendingChanges)
      .where(eq(subscriptionPendingChanges.id, pendingId))
      .for("update")
      .limit(1);
    if (!row || row.status !== "pending") return "gone" as const;
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, row.invoiceId)).limit(1);
    if (inv?.status === "paid") return "paid" as const;
    if (inv && (await inFlightOn(tx, inv.id, true))) throw new PendingChangeBusyError(inv.publicId);
    await tx
      .update(subscriptionPendingChanges)
      .set({
        status: reason === "expired" ? "expired" : "cancelled",
        endReason: reason,
        endedAt: stampNow(businessId),
      })
      .where(eq(subscriptionPendingChanges.id, row.id));
    if (inv && inv.status !== "voided") {
      const { voidInvoiceInTx } = await import("@/modules/invoicing/ops");
      await voidInvoiceInTx(tx, organizationId, businessId, inv.publicId, {
        voidReasonCode: `pending_change_${reason}`,
      });
    }
    await undoHeldWrites(tx, row);
    await announce(tx, row, "subscription_pending_change_expired", reason);
    return "ended" as const;
  });
}

/** The credit notes the change raised, and what a hosted change wrote, after its invoice void. */
async function undoHeldWrites(tx: Tx, row: PendingRow): Promise<void> {
  const { voidCreditNote } = await import("@/modules/credit-notes/service");
  for (const id of row.creditNoteIds) {
    const [cn] = await tx
      .select({ status: creditNotes.status })
      .from(creditNotes)
      .where(and(eq(creditNotes.businessId, row.businessId), eq(creditNotes.publicId, id)))
      .limit(1);
    if (cn && cn.status !== "voided")
      await voidCreditNote({
        organizationId: row.organizationId,
        businessId: row.businessId,
        creditNotePublicId: id,
        tx,
      });
  }
  const restore = (row.restore ?? null) as PendingRestore | null;
  if (restore?.subscription)
    await tx
      .update(subscriptions)
      .set({ ...restore.subscription, updatedAt: stampNow(row.businessId) })
      .where(eq(subscriptions.id, row.subscriptionId));
  if (restore?.coupons) {
    const { undoSubscriptionCouponEdit } = await import("@/modules/coupons/service");
    await undoSubscriptionCouponEdit(tx, {
      organizationId: row.organizationId,
      subscriptionId: row.subscriptionId,
      before: restore.coupons,
    });
  }
}

/** `applyVoid` hook: an operator voided a held invoice by hand. Same transaction as the void. */
export async function onHeldInvoiceVoided(tx: Tx, invoiceId: string): Promise<void> {
  const [row] = await tx
    .select()
    .from(subscriptionPendingChanges)
    .where(
      and(
        eq(subscriptionPendingChanges.invoiceId, invoiceId),
        eq(subscriptionPendingChanges.status, "pending"),
      ),
    )
    .for("update")
    .limit(1);
  if (!row) return;
  await tx
    .update(subscriptionPendingChanges)
    .set({ status: "cancelled", endReason: "voided", endedAt: stampNow(row.businessId) })
    .where(eq(subscriptionPendingChanges.id, row.id));
  await undoHeldWrites(tx, row);
  await announce(tx, row, "subscription_pending_change_expired", "voided");
}

/** `activatePaidCreditGrants` hook: an invoice was paid; apply its held change after commit. */
export async function onInvoicePaid(tx: Tx, organizationId: string, invoiceId: string) {
  const [row] = await tx
    .select({ id: subscriptionPendingChanges.id })
    .from(subscriptionPendingChanges)
    .where(
      and(
        eq(subscriptionPendingChanges.invoiceId, invoiceId),
        eq(subscriptionPendingChanges.status, "pending"),
      ),
    )
    .limit(1);
  if (!row) return;
  // Outside the paying transaction, so a failed replay never rolls a payment back. The pass
  // applies it when no hook runs.
  afterCommit(async () => {
    await applyPaidPendingChange(organizationId, invoiceId);
  });
}

/**
 * Before another change, a cancel or a pause: end the subscription's pending change. A paid
 * one is applied first. Throws `PendingChangeBusyError` while its payment is in progress.
 */
export async function endPendingForSubscription(
  organizationId: string,
  businessId: string,
  subscriptionId: string,
  reason: Exclude<PendingEndReason, "moved" | "voided">,
): Promise<void> {
  const row = await withTenant(organizationId, (tx) => livePendingChange(tx, subscriptionId));
  if (!row) return;
  const r = await endPendingChange(organizationId, businessId, row.id, reason);
  if (r === "paid") await applyPaidPendingChange(organizationId, row.invoiceId);
}

/** `endPendingForSubscription` for automated paths: a payment in progress does not block them. */
export async function endPendingQuietly(
  organizationId: string,
  businessId: string,
  subscriptionId: string,
  reason: "cancelled" | "expired",
): Promise<void> {
  try {
    await endPendingForSubscription(organizationId, businessId, subscriptionId, reason);
  } catch (e) {
    if (!(e instanceof PendingChangeBusyError)) throw e;
    // Its payment lands on a changed subscription and is kept as credit (`keepPaidMoney`).
    log.warn("pending change left open: its payment is in progress", {
      event: "pending_change_busy",
      subscriptionId,
      reason,
    });
  }
}

/**
 * A new change request on a subscription with a pending one. A repeat of the same request
 * returns the pending row (its invoice is collected again); any other request replaces it.
 */
export async function pendingBeforeChange(
  organizationId: string,
  businessId: string,
  subscriptionId: string,
  request: Record<string, unknown>,
): Promise<PendingRow | null> {
  const row = await withTenant(organizationId, (tx) => livePendingChange(tx, subscriptionId));
  if (!row) return null;
  if (row.requestHash === requestHash(request)) return row;
  const r = await endPendingChange(organizationId, businessId, row.id, "replaced");
  if (r === "paid") await applyPaidPendingChange(organizationId, row.invoiceId);
  return null;
}

/** A repeat of the pending request: collect the same invoice again. */
export async function collectHeldAgain(
  organizationId: string,
  businessId: string,
  row: PendingRow,
  opts: { onSession?: boolean } = {},
): Promise<{ applied: true; invoice: InvoiceRow } | { applied: false; held: HeldCharge }> {
  const [inv] = await withTenant(organizationId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.id, row.invoiceId)).limit(1),
  );
  if (!inv) throw new Error(`invoice of pending change ${row.publicId} not found`);
  if (inv.status !== "paid") {
    const { collectInvoice, CollectionInFlightError } = await import("@/modules/invoicing/service");
    const [sub] = await withTenant(organizationId, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, row.subscriptionId)).limit(1),
    );
    try {
      await collectInvoice({
        organizationId,
        businessId,
        invoice: inv,
        ...(sub ? { subscription: sub } : {}),
        manualAttempt: true,
      });
    } catch (e) {
      if (!(e instanceof CollectionInFlightError)) throw e;
    }
  }
  const r = await settleHeldInvoice({
    organizationId,
    businessId,
    invoiceId: inv.id,
    announce: false,
    ...(opts.onSession ? { onSession: true } : {}),
  });
  if (!r.applied) return r;
  const [paid] = await withTenant(organizationId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1),
  );
  return { applied: true, invoice: paid ?? inv };
}

// ── The pass ─────────────────────────────────────────────────────────────────

/**
 * `pending_changes` clock pass, before renewals: apply held changes whose invoice some path
 * paid without the hook, give back money for paid ones that could not apply, and expire the
 * due ones (their invoice and credit notes are voided). A due change whose payment is still in
 * progress waits for it.
 */
export async function runPendingChanges(now: Date): Promise<{
  applied: number;
  expired: number;
  waiting: number;
  errors: import("./renewal").TickError[];
}> {
  const scope = scanBusinessFilter(subscriptionPendingChanges.businessId);
  const errors: import("./renewal").TickError[] = [];
  let applied = 0;
  let expired = 0;
  let waiting = 0;
  // systemDb: the pass scans every organization; each row is handled under withTenant.
  const paid = await systemDb
    .select({
      organizationId: subscriptionPendingChanges.organizationId,
      subscriptionId: subscriptionPendingChanges.subscriptionId,
      invoiceId: subscriptionPendingChanges.invoiceId,
    })
    .from(subscriptionPendingChanges)
    .innerJoin(invoices, eq(invoices.id, subscriptionPendingChanges.invoiceId))
    .where(
      and(
        eq(invoices.status, "paid"),
        ne(subscriptionPendingChanges.status, "applied"),
        isNull(subscriptionPendingChanges.keptCreditNote),
        scope,
      ),
    )
    .limit(200);
  for (const r of paid) {
    try {
      if ((await applyPaidPendingChange(r.organizationId, r.invoiceId)) === "applied") applied++;
    } catch (e) {
      log.error(e, { event: "pending_change_apply_failed", subscription: r.subscriptionId });
      errors.push({
        organization: r.organizationId,
        subscription: r.subscriptionId,
        step: "pending_change_apply",
        message: (e as Error).message,
      });
    }
  }
  const due = await systemDb
    .select({
      id: subscriptionPendingChanges.id,
      organizationId: subscriptionPendingChanges.organizationId,
      businessId: subscriptionPendingChanges.businessId,
      subscriptionId: subscriptionPendingChanges.subscriptionId,
      invoiceId: subscriptionPendingChanges.invoiceId,
    })
    .from(subscriptionPendingChanges)
    .where(
      and(
        eq(subscriptionPendingChanges.status, "pending"),
        lte(subscriptionPendingChanges.expiresAt, now),
        scope,
      ),
    )
    .limit(200);
  for (const r of due) {
    try {
      const out = await endPendingChange(r.organizationId, r.businessId, r.id, "expired");
      if (out === "ended") expired++;
      if (
        out === "paid" &&
        (await applyPaidPendingChange(r.organizationId, r.invoiceId)) === "applied"
      )
        applied++;
    } catch (e) {
      if (e instanceof PendingChangeBusyError) waiting++;
      else {
        log.error(e, { event: "pending_change_expire_failed", subscription: r.subscriptionId });
        errors.push({
          organization: r.organizationId,
          business: r.businessId,
          subscription: r.subscriptionId,
          step: "pending_change_expire",
          message: (e as Error).message,
        });
      }
    }
  }
  return { applied, expired, waiting, errors };
}
