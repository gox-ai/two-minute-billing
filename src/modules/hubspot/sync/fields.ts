import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { minorToDecimalString } from "@/platform/currency";
import { listDefinitionsTx } from "@/modules/custom-fields/service";
import { paidTotals } from "@/modules/invoicing/service";
import { OPEN_INVOICE_STATUSES } from "@/modules/invoicing/status";
import { estimateRenewal } from "@/modules/subscriptions/estimate";
import { apiSubscriptionStatus } from "@/modules/subscriptions/serialize";
import {
  appliedCoupons,
  businesses,
  coupons,
  customers,
  invoices,
  prices,
  products,
  subscriptionItems,
  subscriptions,
} from "@db/schema";
import type { HubSpotClient, Connection } from "../client";
import { listProperties, type DiscoverableObject } from "../discovery";
import type { fieldMapping } from "../settings";
import type { z } from "zod";

/**
 * Local field → HubSpot property value. Each object has a resolver that turns a local field name
 * (`LOCAL_FIELDS[object]` or `cf_<api_name>`) into a typed value; `toHubSpot` renders it.
 */

export type FieldMapping = z.infer<typeof fieldMapping>;

/** A local value before rendering. Money stays in minor units until the last step. */
export type FieldValue =
  | { kind: "text"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  /** A calendar day, `YYYY-MM-DD`. */
  | { kind: "date"; value: string }
  | { kind: "datetime"; value: Date }
  | { kind: "money"; minor: bigint; currency: string };

/** Resolves the named local fields for one record; unknown or empty fields are absent. */
export type FieldResolver = (locals: string[]) => Promise<Map<string, FieldValue>>;

const DAY_MS = 86_400_000;

/** HubSpot takes every value as a string; `date` properties need UTC midnight in epoch ms. */
export function toHubSpot(v: FieldValue, remoteType?: string | null): string {
  switch (v.kind) {
    case "text":
      return v.value;
    case "number":
      return String(v.value);
    case "boolean":
      return v.value ? "true" : "false";
    case "money":
      return minorToDecimalString(v.minor, v.currency);
    case "date": {
      const [y, m, d] = v.value.split("-").map(Number);
      return String(Date.UTC(y!, m! - 1, d!));
    }
    case "datetime": {
      const ms = v.value.getTime();
      return String(remoteType === "date" ? Math.floor(ms / DAY_MS) * DAY_MS : ms);
    }
  }
}

/** Property types per portal object, cached briefly: only needed to pin datetimes to midnight. */
const typeCache = new Map<string, { at: number; types: Map<string, string | null> }>();
const TYPE_TTL_MS = 10 * 60_000;

async function remoteTypes(client: HubSpotClient, conn: Connection, object: DiscoverableObject) {
  const key = `${conn.id}:${object}`;
  const hit = typeCache.get(key);
  if (hit && Date.now() - hit.at < TYPE_TTL_MS) return hit.types;
  const props = await listProperties(client, object);
  const types = new Map(props.map((p) => [p.name, p.type]));
  typeCache.set(key, { at: Date.now(), types });
  return types;
}

/** The pushable mappings (`to_remote` / `both`) rendered as HubSpot properties. */
export async function mappedProperties(
  client: HubSpotClient,
  conn: Connection,
  object: DiscoverableObject,
  mappings: FieldMapping[],
  resolve: FieldResolver,
): Promise<Record<string, string>> {
  const push = mappings.filter((m) => m.direction !== "to_local");
  if (push.length === 0) return {};
  const values = await resolve([...new Set(push.map((m) => m.local))]);
  const types = [...values.values()].some((v) => v.kind === "datetime")
    ? await remoteTypes(client, conn, object)
    : null;
  const out: Record<string, string> = {};
  for (const m of push) {
    const v = values.get(m.local);
    if (v) out[m.remote] = toHubSpot(v, types?.get(m.remote));
  }
  return out;
}

type Customer = typeof customers.$inferSelect;

const text = (s: string | null | undefined): FieldValue | undefined =>
  s != null && s.trim() !== "" ? { kind: "text", value: s } : undefined;

/** A custom-field value, typed by its definition. */
function customValue(raw: unknown, dataType: string | undefined): FieldValue | undefined {
  if (raw == null || raw === "") return undefined;
  if (dataType === "boolean" || typeof raw === "boolean")
    return { kind: "boolean", value: raw === true || raw === "true" };
  if (dataType === "number" || typeof raw === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? { kind: "number", value: n } : undefined;
  }
  if (dataType === "date" && typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw))
    return { kind: "date", value: raw.slice(0, 10) };
  return { kind: "text", value: String(raw) };
}

/**
 * The currency a customer's money fields are quoted in: their preferred one, else the
 * business default. Amounts in other currencies are left out rather than mixed.
 */
async function customerMoney(conn: Connection, customer: Customer) {
  return withTenant(conn.organizationId, async (tx) => {
    let currency = customer.currency;
    if (!currency) {
      const [b] = await tx
        .select({ c: businesses.defaultCurrency })
        .from(businesses)
        .where(eq(businesses.id, conn.businessId))
        .limit(1);
      currency = b?.c ?? "USD";
    }

    const subs = await tx
      .select({ mrr: subscriptions.mrr, currency: subscriptions.currency })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.businessId, conn.businessId),
          eq(subscriptions.customerId, customer.id),
          isNull(subscriptions.deletedAt),
        ),
      );
    // `mrr` is already 0 for a subscription that earns nothing now.
    const mrr = subs
      .filter((s) => s.currency === currency)
      .reduce((sum, s) => sum + (s.mrr ?? 0n), 0n);

    // `amount_due_minor` is the issue-time collectible; payments since then are subtracted.
    const open = await tx
      .select({ id: invoices.id, due: invoices.amountDueMinor, total: invoices.totalMinor })
      .from(invoices)
      .where(
        and(
          eq(invoices.businessId, conn.businessId),
          eq(invoices.customerId, customer.id),
          eq(invoices.currency, currency),
          inArray(invoices.status, [...OPEN_INVOICE_STATUSES]),
          eq(invoices.writtenOff, false),
        ),
      );
    const paid = await paidTotals(
      tx,
      open.map((i) => i.id),
    );
    let dues = 0n;
    for (const inv of open) {
      const remaining = (inv.due ?? inv.total) - (paid.get(inv.id) ?? 0n);
      if (remaining > 0n) dues += remaining;
    }
    return { currency, mrr, dues };
  });
}

/** A customer's `subscription_*` field → the deal field it mirrors. */
const SUBSCRIPTION_FIELD: Record<string, string> = {
  subscription_id: "id",
  subscription_status: "status",
  subscription_plan_id: "plan_id",
  subscription_plan_amount: "plan_amount",
  subscription_mrr: "mrr",
  subscription_currency: "currency",
};

/** The customer's newest subscription that is not cancelled, else its newest. */
async function currentSubscription(conn: Connection, customer: Customer) {
  const subs = await withTenant(conn.organizationId, (tx) =>
    tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.businessId, conn.businessId),
          eq(subscriptions.customerId, customer.id),
          isNull(subscriptions.deletedAt),
        ),
      )
      .orderBy(desc(subscriptions.createdAt)),
  );
  return subs.find((s) => apiSubscriptionStatus(s) !== "cancelled") ?? subs[0] ?? null;
}

/** Contact and company fields both come from the customer. */
export function customerResolver(conn: Connection, customer: Customer): FieldResolver {
  return async (locals) => {
    const out = new Map<string, FieldValue>();
    const money =
      locals.includes("mrr") || locals.includes("total_dues")
        ? await customerMoney(conn, customer)
        : null;
    const cfTypes = locals.some((l) => l.startsWith("cf_"))
      ? await withTenant(conn.organizationId, (tx) =>
          listDefinitionsTx(tx, conn.businessId, { entityType: "customer", includeArchived: true }),
        ).then((defs) => new Map(defs.map((d) => [d.apiName, d.dataType])))
      : null;
    const cf = (customer.customFields ?? {}) as Record<string, unknown>;

    const subLocals = locals.filter((l) => l in SUBSCRIPTION_FIELD);
    if (subLocals.length > 0) {
      const sub = await currentSubscription(conn, customer);
      if (sub) {
        const got = await subscriptionResolver(
          conn,
          sub,
        )(subLocals.map((l) => SUBSCRIPTION_FIELD[l]!));
        for (const l of subLocals) {
          const v = got.get(SUBSCRIPTION_FIELD[l]!);
          if (v) out.set(l, v);
        }
      }
    }

    for (const local of locals) {
      if (local in SUBSCRIPTION_FIELD) continue;
      let v: FieldValue | undefined;
      switch (local) {
        case "id":
          v = text(customer.publicId);
          break;
        case "email":
          v = text(customer.email?.trim().toLowerCase());
          break;
        case "first_name":
          v = text(customer.firstName);
          break;
        case "last_name":
          v = text(customer.lastName);
          break;
        case "phone":
          v = text(customer.phone);
          break;
        case "company":
          v = text(customer.company);
          break;
        case "locale":
          v = text(customer.locale);
          break;
        case "preferred_currency":
          v = text(customer.currency);
          break;
        case "auto_collection":
          v = { kind: "boolean", value: customer.autoCollection === "on" };
          break;
        case "net_term_days":
          v = { kind: "number", value: customer.netTermDays };
          break;
        case "vat_number":
          v = text(customer.vatNumber);
          break;
        case "billing_line1":
          v = text(customer.addressLine1);
          break;
        case "billing_city":
          v = text(customer.city);
          break;
        case "billing_state":
          v = text(customer.state);
          break;
        case "billing_zip":
          v = text(customer.postalCode);
          break;
        case "billing_country":
          v = text(customer.country);
          break;
        case "created_at":
          v = { kind: "datetime", value: customer.createdAt };
          break;
        case "mrr":
          v = { kind: "money", minor: money!.mrr, currency: money!.currency };
          break;
        case "total_dues":
          v = { kind: "money", minor: money!.dues, currency: money!.currency };
          break;
        default:
          if (local.startsWith("cf_")) {
            const name = local.slice(3);
            v = customValue(cf[name], cfTypes?.get(name));
          }
      }
      if (v) out.set(local, v);
    }
    return out;
  };
}

type Subscription = typeof subscriptions.$inferSelect;

/** Lazy, once per resolver: the plan line and the next renewal are the costly reads. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= load());
}

/**
 * Deal fields come from the subscription. `mrr` is what it earns now (0 in trial, paused or
 * cancelled); `next_billing_amount` is the renewal estimate, absent when nothing renews.
 */
export function subscriptionResolver(conn: Connection, sub: Subscription): FieldResolver {
  const plan = once(() =>
    withTenant(conn.organizationId, async (tx) => {
      const rows = await tx
        .select({
          name: products.name,
          priceRef: prices.publicId,
          catalogAmount: prices.amountMinor,
          snapshot: subscriptionItems.priceSnapshot,
          type: prices.type,
          interval: prices.interval,
          count: prices.intervalCount,
          quantity: subscriptionItems.quantity,
          ref: subscriptionItems.publicId,
        })
        .from(subscriptionItems)
        .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
        .innerJoin(products, eq(products.id, prices.productId))
        .where(
          and(
            eq(subscriptionItems.businessId, conn.businessId),
            eq(subscriptionItems.subscriptionId, sub.id),
          ),
        );
      rows.sort(
        (a, b) =>
          Number(b.type === "recurring") - Number(a.type === "recurring") ||
          a.ref.localeCompare(b.ref),
      );
      return rows[0] ?? null;
    }),
  );
  const renewal = once(() =>
    estimateRenewal({
      organizationId: conn.organizationId,
      businessId: conn.businessId,
      subscriptionId: sub.id,
    }),
  );
  const status = apiSubscriptionStatus(sub);

  return async (locals) => {
    const out = new Map<string, FieldValue>();
    const need = (...names: string[]) => names.some((n) => locals.includes(n));
    const item = need("plan", "plan_id", "plan_amount", "plan_quantity", "billing_period")
      ? await plan()
      : null;
    const cfTypes = locals.some((l) => l.startsWith("cf_"))
      ? await withTenant(conn.organizationId, (tx) =>
          listDefinitionsTx(tx, conn.businessId, {
            entityType: "subscription",
            includeArchived: true,
          }),
        ).then((defs) => new Map(defs.map((d) => [d.apiName, d.dataType])))
      : null;
    const cf = (sub.customFields ?? {}) as Record<string, unknown>;
    const at = (d: Date | null | undefined): FieldValue | undefined =>
      d ? { kind: "datetime", value: d } : undefined;
    const money = (minor: bigint): FieldValue => ({ kind: "money", minor, currency: sub.currency });

    for (const local of locals) {
      let v: FieldValue | undefined;
      switch (local) {
        case "id":
          v = text(sub.publicId);
          break;
        case "status":
          v = text(status);
          break;
        case "plan":
          v = text(item?.name);
          break;
        case "plan_id":
          v = text(item?.priceRef);
          break;
        case "plan_amount": {
          // The line's unit price (an override wins over the catalog) times its quantity.
          const snap = item?.snapshot as { amountMinor?: number | null } | null | undefined;
          const unit = snap?.amountMinor ?? item?.catalogAmount ?? null;
          v = item && unit != null ? money(BigInt(unit) * BigInt(item.quantity)) : undefined;
          break;
        }
        case "plan_quantity":
          v = item ? { kind: "number", value: item.quantity } : undefined;
          break;
        case "mrr":
          v = money(sub.mrr ?? 0n);
          break;
        case "arr":
          v = money((sub.mrr ?? 0n) * 12n);
          break;
        case "next_billing_at":
          v = at(
            status === "in_trial"
              ? sub.trialEnd
              : status === "future"
                ? sub.startDate
                : status === "active"
                  ? sub.currentPeriodEnd
                  : null,
          );
          break;
        case "next_billing_amount": {
          const est = status === "cancelled" || status === "non_renewing" ? null : await renewal();
          v = est ? money(BigInt(est.amount_due_minor ?? est.total_minor)) : undefined;
          break;
        }
        case "current_term_start":
          v = at(sub.currentPeriodStart);
          break;
        case "current_term_end":
          v = at(sub.currentPeriodEnd);
          break;
        case "trial_end":
          v = at(sub.trialEnd);
          break;
        case "cancelled_at":
          v = at(sub.canceledAt);
          break;
        case "auto_collection": {
          let mode = sub.autoCollection;
          if (!mode)
            mode = await withTenant(conn.organizationId, async (tx) => {
              const [c] = await tx
                .select({ a: customers.autoCollection })
                .from(customers)
                .where(
                  and(eq(customers.businessId, conn.businessId), eq(customers.id, sub.customerId)),
                )
                .limit(1);
              return c?.a ?? null;
            });
          v = mode ? { kind: "boolean", value: mode === "on" } : undefined;
          break;
        }
        case "billing_period": {
          const n = sub.billingPeriod ?? item?.count ?? null;
          const unit = sub.billingPeriodUnit ?? item?.interval ?? null;
          v = n && unit ? text(`${n} ${unit}${n > 1 ? "s" : ""}`) : undefined;
          break;
        }
        case "currency":
          v = text(sub.currency);
          break;
        case "coupon": {
          const codes = await withTenant(conn.organizationId, (tx) =>
            tx
              .select({ code: coupons.code })
              .from(appliedCoupons)
              .innerJoin(coupons, eq(coupons.id, appliedCoupons.couponId))
              .where(
                and(
                  eq(appliedCoupons.businessId, conn.businessId),
                  eq(appliedCoupons.subscriptionId, sub.id),
                  eq(appliedCoupons.status, "active"),
                ),
              ),
          );
          v = text(codes.map((c) => c.code).join(", "));
          break;
        }
        default:
          if (local.startsWith("cf_")) {
            const name = local.slice(3);
            v = customValue(cf[name], cfTypes?.get(name));
          }
      }
      if (v) out.set(local, v);
    }
    return out;
  };
}
