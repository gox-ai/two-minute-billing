/**
 * Load what a notification says about one event, clock fact or direct call, inside the
 * fan-out's tenant transaction. Also the derived checks some kinds need (catalogue `derived`).
 */
import { and, desc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import { declineLabel } from "@/providers/decline-codes";
import {
  businesses,
  creditGrants,
  customers,
  disputes,
  gatewayAccounts,
  invoices,
  paymentAttempts,
  paymentIntents,
  paymentMethods,
  payments,
  prices,
  products,
  refunds,
  subscriptionItems,
  subscriptions,
  transactions,
  webhookEndpoints,
} from "@db/schema";
import type { Tx } from "@/platform/db";
import { resolveErrorId } from "@/platform/error-taxonomy";
import { accountHolderName } from "@/modules/customers/names";
import { notDeleted } from "@/modules/subscriptions/deleted-sql";
import type { EventRow } from "@/modules/events/emit";
import { FRAUD_DECLINE_CODES, kindDef, type NotificationKind } from "./catalogue";
import type { Facts } from "./text";

/** A queue row's payload for clock and direct kinds. */
export interface NotificationPayload {
  /** The record to load, as an event's resource: `{ type: "invoice", id: "inv_…" }`. */
  record?: { type: string; id: string } | null;
  /** Facts the caller already knows; they win over loaded ones. */
  facts?: Partial<Facts>;
  /** The event source, for the portal check. */
  source?: string | null;
  /** One clock run's facts of one kind and business: sent as one message (a list). */
  items?: NotificationPayload[];
}

export interface FactsBundle {
  facts: Facts;
  business: { id: string; publicId: string; name: string; timezone: string; test: boolean };
  /** Internal ids for the derived checks. Never stored or shown. */
  refs: {
    customerId: string | null;
    invoiceId: string | null;
    subscriptionId: string | null;
    /** Canonical decline code of a failed payment. */
    failureCode: string | null;
    /** Error code of a refused payment attempt. */
    errorCode: string | null;
  };
}

type Data = Record<string, unknown>;
const obj = (v: unknown): Data | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Data) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const ref = (v: unknown): string | null => str(v) ?? str(obj(v)?.id);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** "product_not_received" → "Product not received". */
export function humanize(code: string | null | undefined): string | null {
  if (!code) return null;
  const s = code.replace(/[_-]+/g, " ").trim().toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : null;
}

/** A short operator reason for a decline code; the gateway's text when the code is not known. */
export function declineReason(code: string | null | undefined, message?: string | null) {
  const label = declineLabel(code);
  if (label) return label;
  const m = message?.trim();
  if (m) return m.length > 140 ? `${m.slice(0, 139)}…` : m;
  return code ? humanize(code) : null;
}

function billingCycle(period: number | null, unit: string | null): string | null {
  if (!unit) return null;
  const n = period ?? 1;
  if (n === 1)
    return ({ day: "daily", week: "weekly", month: "monthly", year: "yearly" } as Data)[unit] as
      | string
      | null;
  return `every ${n} ${unit}s`;
}

const PORTAL_CHANGE: Record<string, string> = {
  subscription_changed: "Changed the subscription",
  subscription_change_scheduled: "Scheduled a change to the subscription",
  subscription_paused: "Paused the subscription",
  subscription_pause_scheduled: "Scheduled a pause",
  subscription_canceled: "Cancelled the subscription",
  subscription_cancel_scheduled: "Scheduled a cancellation",
};

export async function loadFacts(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    kind: NotificationKind;
    event?: EventRow | null;
    payload?: NotificationPayload | null;
  },
): Promise<FactsBundle | null> {
  const [biz] = await tx
    .select({
      id: businesses.id,
      publicId: businesses.publicId,
      name: businesses.name,
      timezone: businesses.timezone,
      livemode: businesses.livemode,
    })
    .from(businesses)
    .where(eq(businesses.id, input.businessId))
    .limit(1);
  if (!biz) return null;
  const bizId = biz.id;
  const b = `/businesses/${biz.publicId}`;

  const ev = input.event ?? null;
  const record =
    input.payload?.record ??
    (ev?.resourceType && ev.resourceId ? { type: ev.resourceType, id: ev.resourceId } : null);
  const data = obj(ev?.data) ?? {};
  const resource = (record && obj(data[record.type])) ?? {};

  const f: Facts = {
    businessName: biz.name,
    businessPublicId: biz.publicId,
    occurredAt: iso(ev?.createdAt) ?? new Date().toISOString(),
  };
  const refs: FactsBundle["refs"] = {
    customerId: null,
    invoiceId: null,
    subscriptionId: null,
    failureCode: null,
    errorCode: null,
  };
  let customerPublicId = ref(resource.customer) ?? ref(data.customer);
  let subscriptionPublicId = ref(resource.subscription) ?? ref(data.subscription);
  let invoicePublicId = ref(resource.invoice) ?? ref(data.invoice);
  const money = (m: bigint | number | null | undefined, c: string | null | undefined) => {
    if (m != null && c) {
      f.amountMinor = Number(m);
      f.currency = c;
    }
  };
  const txnUrl = async (where: ReturnType<typeof eq>) => {
    const [t] = await tx
      .select({ publicId: transactions.publicId })
      .from(transactions)
      .where(and(eq(transactions.businessId, bizId), where))
      .orderBy(desc(transactions.createdAt))
      .limit(1);
    return t ? `${b}/transactions/${t.publicId}` : null;
  };

  switch (record?.type) {
    case "payment": {
      const [p] = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.businessId, bizId), eq(payments.publicId, record.id)))
        .limit(1);
      if (!p) {
        await loadTransaction(record.id);
        break;
      }
      money(p.amountMinor, p.currency);
      refs.customerId = p.customerId;
      refs.invoiceId = p.invoiceId;
      refs.failureCode = p.failureCode;
      if (p.status === "failed") f.reason = declineReason(p.failureCode, p.failureMessage);
      f.record = { type: "transaction", id: p.publicId };
      f.url = await txnUrl(eq(transactions.paymentId, p.id));
      break;
    }
    case "refund": {
      const [r] = await tx
        .select()
        .from(refunds)
        .where(and(eq(refunds.businessId, bizId), eq(refunds.publicId, record.id)))
        .limit(1);
      if (!r) {
        await loadTransaction(record.id);
        break;
      }
      money(r.amountMinor, r.currency);
      const [t] = await tx
        .select()
        .from(transactions)
        .where(and(eq(transactions.businessId, bizId), eq(transactions.refundId, r.id)))
        .orderBy(desc(transactions.createdAt))
        .limit(1);
      if (t) {
        refs.customerId = t.customerId;
        refs.invoiceId = t.invoiceId;
        f.reason = declineReason(t.errorCode, t.errorText);
        f.record = { type: "transaction", id: t.publicId };
        f.url = `${b}/transactions/${t.publicId}`;
      }
      break;
    }
    case "transaction":
      await loadTransaction(record.id);
      break;
    case "dispute": {
      const [d] = await tx
        .select()
        .from(disputes)
        .where(and(eq(disputes.businessId, bizId), eq(disputes.publicId, record.id)))
        .limit(1);
      if (!d) break;
      money(d.amountMinor, d.currency);
      refs.customerId = d.customerId;
      refs.invoiceId = d.invoiceId;
      f.reason = humanize(d.reason);
      f.dueAt = iso(d.evidenceDueBy);
      f.outcome =
        ev?.type === "dispute_won"
          ? "won"
          : ev?.type === "dispute_lost"
            ? "lost"
            : outcomeOf(d.status);
      f.record = { type: "dispute", id: d.publicId };
      f.url =
        (d.paymentId && (await txnUrl(eq(transactions.paymentId, d.paymentId)))) || `${b}/disputes`;
      break;
    }
    case "invoice": {
      const [i] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.businessId, bizId), eq(invoices.publicId, record.id)))
        .limit(1);
      if (!i) break;
      money(i.amountDueMinor ?? i.totalMinor, i.currency);
      refs.customerId = i.customerId;
      refs.invoiceId = i.id;
      refs.subscriptionId = i.subscriptionId;
      f.invoiceNumber = i.number ?? i.publicId;
      f.dueAt = iso(i.dueDate);
      f.nextRetryAt = iso(i.nextAttemptAt);
      f.record = { type: "invoice", id: i.publicId };
      f.url = `${b}/invoices/${i.publicId}`;
      invoicePublicId = null;
      break;
    }
    case "subscription": {
      const [s] = await tx
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.businessId, bizId), eq(subscriptions.publicId, record.id)))
        .limit(1);
      if (!s) break;
      refs.customerId = s.customerId;
      refs.subscriptionId = s.id;
      f.dueAt =
        input.kind === "trial_ending"
          ? iso(s.trialEnd)
          : input.kind === "cancellation_scheduled"
            ? iso(s.cancelScheduledAt ?? s.currentPeriodEnd)
            : iso(s.currentPeriodEnd);
      if (input.kind === "customer_portal_change" && ev) f.reason = PORTAL_CHANGE[ev.type] ?? null;
      f.record = { type: "subscription", id: s.publicId };
      f.url = `${b}/subscriptions/${s.publicId}`;
      subscriptionPublicId = null;
      break;
    }
    case "customer":
    case "wallet":
      customerPublicId = record.id;
      break;
    case "payment_source": {
      const [pm] = await tx
        .select()
        .from(paymentMethods)
        .where(and(eq(paymentMethods.businessId, bizId), eq(paymentMethods.publicId, record.id)))
        .limit(1);
      if (!pm) break;
      refs.customerId = pm.customerId;
      const card =
        pm.brand && pm.last4 ? `${humanize(pm.brand)} ending ${pm.last4}` : "The payment method";
      f.reason =
        ev?.type === "payment_source_expired"
          ? `${card} expired`
          : `The gateway marked ${card === "The payment method" ? "the payment method" : card} as invalid`;
      break;
    }
    case "credit_grant": {
      const [g] = await tx
        .select()
        .from(creditGrants)
        .where(and(eq(creditGrants.businessId, bizId), eq(creditGrants.publicId, record.id)))
        .limit(1);
      if (!g) break;
      money(g.faceMinor, g.currency);
      refs.customerId = g.customerId;
      break;
    }
    case "payment_attempt": {
      const [a] = await tx
        .select({
          errorCode: paymentAttempts.errorCode,
          errorText: paymentAttempts.errorText,
          customerId: paymentIntents.customerId,
          gatewayAccountId: paymentIntents.gatewayAccountId,
        })
        .from(paymentAttempts)
        .innerJoin(paymentIntents, eq(paymentIntents.id, paymentAttempts.paymentIntentId))
        .where(and(eq(paymentAttempts.businessId, bizId), eq(paymentAttempts.publicId, record.id)))
        .limit(1);
      if (!a) break;
      refs.customerId = a.customerId;
      refs.errorCode = a.errorCode;
      f.reason = declineReason(a.errorCode, a.errorText);
      if (a.gatewayAccountId) {
        const [g] = await tx
          .select({ publicId: gatewayAccounts.publicId, label: gatewayAccounts.label })
          .from(gatewayAccounts)
          .where(eq(gatewayAccounts.id, a.gatewayAccountId))
          .limit(1);
        if (g) {
          f.gatewayName = g.label;
          f.record = { type: "gateway_account", id: g.publicId };
          f.url = `${b}/settings/gateways/${g.publicId}`;
        }
      }
      break;
    }
    case "webhook_endpoint": {
      const [w] = await tx
        .select({ publicId: webhookEndpoints.publicId, url: webhookEndpoints.url })
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.publicId, record.id))
        .limit(1);
      if (!w) break;
      f.endpointUrl = w.url;
      f.record = { type: "webhook_endpoint", id: w.publicId };
      f.url = `/developer/webhooks/${w.publicId}`;
      break;
    }
    default:
      // spend_limit, usage_alert, credit_auto_topup, usage_threshold: the payload names
      // the customer and the amount.
      money(num(resource.amount_minor), str(resource.currency));
      if (ev?.type === "credit_auto_topup_failed" || ev?.type === "credit_auto_topup_hard_declined")
        f.reason = declineReason(str(data.decline_code), str(data.decline_reason));
  }

  async function loadTransaction(publicId: string): Promise<void> {
    const [t] = await tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.businessId, bizId), eq(transactions.publicId, publicId)))
      .limit(1);
    if (!t) return;
    money(t.amountMinor, t.currency);
    refs.customerId = t.customerId;
    refs.invoiceId = t.invoiceId;
    refs.subscriptionId = t.subscriptionId;
    refs.failureCode ??= t.errorCode;
    if (t.errorCode) f.reason = declineReason(t.errorCode, t.errorText);
    if (t.gatewayAccountId) {
      const [g] = await tx
        .select({ label: gatewayAccounts.label })
        .from(gatewayAccounts)
        .where(eq(gatewayAccounts.id, t.gatewayAccountId))
        .limit(1);
      f.gatewayName = g?.label ?? null;
    }
    f.record = { type: "transaction", id: t.publicId };
    f.url = `${b}/transactions/${t.publicId}`;
  }

  // Related records named by public id on the event.
  if (invoicePublicId && !refs.invoiceId) {
    const [i] = await tx
      .select({
        id: invoices.id,
        customerId: invoices.customerId,
        subscriptionId: invoices.subscriptionId,
      })
      .from(invoices)
      .where(and(eq(invoices.businessId, bizId), eq(invoices.publicId, invoicePublicId)))
      .limit(1);
    if (i) {
      refs.invoiceId = i.id;
      refs.customerId ??= i.customerId;
      refs.subscriptionId ??= i.subscriptionId;
    }
  }
  if (refs.invoiceId) {
    const [i] = await tx
      .select({
        publicId: invoices.publicId,
        number: invoices.number,
        subscriptionId: invoices.subscriptionId,
        customerId: invoices.customerId,
        nextAttemptAt: invoices.nextAttemptAt,
      })
      .from(invoices)
      .where(eq(invoices.id, refs.invoiceId))
      .limit(1);
    if (i) {
      f.invoiceNumber ??= i.number ?? i.publicId;
      f.nextRetryAt ??= iso(i.nextAttemptAt);
      refs.subscriptionId ??= i.subscriptionId;
      refs.customerId ??= i.customerId;
      f.url ??= `${b}/invoices/${i.publicId}`;
      f.record ??= { type: "invoice", id: i.publicId };
    }
  }
  if (subscriptionPublicId && !refs.subscriptionId) {
    const [s] = await tx
      .select({ id: subscriptions.id, customerId: subscriptions.customerId })
      .from(subscriptions)
      .where(
        and(eq(subscriptions.businessId, bizId), eq(subscriptions.publicId, subscriptionPublicId)),
      )
      .limit(1);
    if (s) {
      refs.subscriptionId = s.id;
      refs.customerId ??= s.customerId;
    }
  }
  if (refs.subscriptionId) {
    const [s] = await tx
      .select({ period: subscriptions.billingPeriod, unit: subscriptions.billingPeriodUnit })
      .from(subscriptions)
      .where(eq(subscriptions.id, refs.subscriptionId))
      .limit(1);
    f.planName = await planName(tx, refs.subscriptionId);
    f.billingCycle = s ? billingCycle(s.period, s.unit) : null;
  }
  if (customerPublicId && !refs.customerId) {
    const [c] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.businessId, bizId), eq(customers.publicId, customerPublicId)))
      .limit(1);
    refs.customerId = c?.id ?? null;
  }
  if (refs.customerId) {
    const [c] = await tx
      .select({
        publicId: customers.publicId,
        firstName: customers.firstName,
        lastName: customers.lastName,
        company: customers.company,
        email: customers.email,
      })
      .from(customers)
      .where(eq(customers.id, refs.customerId))
      .limit(1);
    if (c) {
      f.customerName = accountHolderName(c);
      f.customerEmail = c.email;
      const cus = `${b}/customers/${c.publicId}`;
      if (input.kind === "large_credit_grant") f.url = `${cus}/credits`;
      else if (kindDef(input.kind).group === "Usage and credits") f.url ??= `${cus}/usage-controls`;
      f.url ??= cus;
      f.record ??= { type: "customer", id: c.publicId };
    }
  }

  Object.assign(f, input.payload?.facts ?? {});
  return {
    facts: f,
    business: {
      id: biz.id,
      publicId: biz.publicId,
      name: biz.name,
      timezone: biz.timezone ?? "UTC",
      test: biz.livemode === "test",
    },
    refs,
  };
}

const outcomeOf = (status: string): "won" | "lost" | null =>
  status === "won" ? "won" : status === "lost" ? "lost" : null;

/** The plan product's name; else any product on the subscription. */
async function planName(tx: Tx, subscriptionId: string): Promise<string | null> {
  const rows = await tx
    .select({ name: products.name, kind: products.kind })
    .from(subscriptionItems)
    .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .innerJoin(products, eq(prices.productId, products.id))
    .where(eq(subscriptionItems.subscriptionId, subscriptionId));
  return rows.find((r) => r.kind === "plan")?.name ?? rows[0]?.name ?? null;
}

// ── derived checks ──

export function isFraudDecline(code: string | null | undefined): boolean {
  return !!code && FRAUD_DECLINE_CODES.has(code);
}

/** A refusal caused by the merchant's own gateway account (keys revoked, recurring off). */
export function isMerchantAccountError(code: string | null | undefined): boolean {
  return !!code && resolveErrorId(code).family === "merchant_account";
}

/**
 * The first non-voided invoice of its subscription, or of its customer when not recurring.
 * Mirrors `firstInvoice` in `invoicing/relations.ts`, which is not exported on its own.
 */
export async function isFirstInvoice(tx: Tx, invoiceId: string): Promise<boolean> {
  const [inv] = await tx
    .select({
      id: invoices.id,
      customerId: invoices.customerId,
      subscriptionId: invoices.subscriptionId,
      status: invoices.status,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (!inv || inv.status === "voided" || inv.status === "pending") return false;
  const [earlier] = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        inv.subscriptionId
          ? eq(invoices.subscriptionId, inv.subscriptionId)
          : and(eq(invoices.customerId, inv.customerId), sql`${invoices.subscriptionId} is null`),
        notInArray(invoices.status, ["voided", "pending"]),
        lt(invoices.createdAt, inv.createdAt),
      ),
    )
    .limit(1);
  return !earlier;
}

/** A subscription that still bills: not cancelled and not deleted. */
export async function hasLiveSubscription(tx: Tx, customerId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.customerId, customerId),
        inArray(subscriptions.status, ["future", "in_trial", "active", "paused"]),
        notDeleted(),
      ),
    )
    .limit(1);
  return !!row;
}

/** Does the kind's derived check pass for this bundle? Kinds with no check always pass. */
export async function passesDerivedCheck(
  tx: Tx,
  kind: NotificationKind,
  bundle: FactsBundle,
  source?: string | null,
): Promise<boolean> {
  switch (kindDef(kind).derived) {
    case undefined:
      return true;
    case "fraud_decline":
      return isFraudDecline(bundle.refs.failureCode);
    case "merchant_account":
      return isMerchantAccountError(bundle.refs.errorCode);
    case "first_invoice":
      return !!bundle.refs.invoiceId && (await isFirstInvoice(tx, bundle.refs.invoiceId));
    case "live_subscription":
      return !!bundle.refs.customerId && (await hasLiveSubscription(tx, bundle.refs.customerId));
    case "portal":
      return source === "portal";
  }
}
