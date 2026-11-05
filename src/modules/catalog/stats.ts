import { and, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { prices, products, productGroups, subscriptionItems, subscriptions } from "@db/schema";
import type { PriceSnapshot } from "./pricing";
import { computeSubscriptionMrr } from "@/modules/subscriptions/service";

/**
 * Catalog usage figures for the product, price and product-group pages.
 *
 * "Active" is the stored status set `active` + `in_trial` — the set the engine carries MRR
 * over (non_renewing is `active` in storage). Deleted subscriptions are excluded.
 *
 * MRR is the subscription's stored NET `mrr` (after recurring discounts), apportioned
 * across its items by each item's gross recurring amount. So a subscription's items sum
 * back to exactly its `mrr`, and the products of a business sum to its MRR. A trialling
 * subscription counts but contributes 0, as it does everywhere else. Per currency, never
 * summed across currencies.
 */

export interface MrrByCurrency {
  currency: string;
  amountMinor: bigint;
}

export interface UsageStats {
  activeSubscriptions: number;
  /** Of `activeSubscriptions`, how many are still in trial. */
  inTrialSubscriptions: number;
  mrr: MrrByCurrency[];
}

export interface ProductGroupStats extends UsageStats {
  products: Array<{ productPublicId: string } & UsageStats>;
}

const EARNING_STATUSES = ["active", "in_trial"] as const;

class Acc {
  subs = new Set<string>();
  trial = new Set<string>();
  mrr = new Map<string, bigint>();
  add(subId: string, inTrial: boolean, currency: string, amount: bigint) {
    this.subs.add(subId);
    if (inTrial) this.trial.add(subId);
    this.mrr.set(currency, (this.mrr.get(currency) ?? 0n) + amount);
  }
  out(): UsageStats {
    return {
      activeSubscriptions: this.subs.size,
      inTrialSubscriptions: this.trial.size,
      mrr: [...this.mrr.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, amountMinor]) => ({ currency, amountMinor })),
    };
  }
}

/**
 * Split `total` across `weights` in proportion, largest remainder first, so the parts
 * sum to `total` exactly. All-zero weights get nothing.
 */
export function apportion(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum <= 0n || total === 0n) return weights.map(() => 0n);
  const parts = weights.map((w) => (total * w) / sum);
  let left = total - parts.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((w, i) => ({ i, rem: (total * w) % sum }))
    .sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.i - b.i));
  for (const { i } of order) {
    if (left <= 0n) break;
    parts[i]! += 1n;
    left -= 1n;
  }
  return parts;
}

/**
 * Per-item MRR for every earning subscription carrying one of `priceIds`, grouped by the
 * item's product. `key` picks what an item is counted under (its product, or its price).
 */
async function usageByKey(
  tx: Tx,
  businessId: string,
  priceIds: string[],
  key: "product" | "price",
): Promise<Map<string, Acc>> {
  const out = new Map<string, Acc>();
  if (priceIds.length === 0) return out;
  const subs = await tx
    .select({
      id: subscriptions.id,
      status: subscriptions.status,
      currency: subscriptions.currency,
      mrr: subscriptions.mrr,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.businessId, businessId),
        inArray(subscriptions.status, [...EARNING_STATUSES]),
        isNull(subscriptions.deletedAt),
        exists(
          tx
            .select({ one: sql`1` })
            .from(subscriptionItems)
            .where(
              and(
                eq(subscriptionItems.subscriptionId, subscriptions.id),
                inArray(subscriptionItems.priceId, priceIds),
              ),
            ),
        ),
      ),
    );
  if (subs.length === 0) return out;

  // Every item of those subscriptions, not just the matching ones: the apportionment
  // weights are relative to the whole subscription.
  const items = await tx
    .select({
      subscriptionId: subscriptionItems.subscriptionId,
      quantity: subscriptionItems.quantity,
      snapshot: subscriptionItems.priceSnapshot,
      freeQuantity: subscriptionItems.freeQuantity,
      price: prices,
    })
    .from(subscriptionItems)
    .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .where(
      inArray(
        subscriptionItems.subscriptionId,
        subs.map((s) => s.id),
      ),
    );
  const bySub = new Map<string, typeof items>();
  for (const it of items) {
    const list = bySub.get(it.subscriptionId) ?? [];
    list.push(it);
    bySub.set(it.subscriptionId, list);
  }
  const targets = new Set(priceIds);
  for (const sub of subs) {
    const its = bySub.get(sub.id) ?? [];
    const gross = its.map((it) =>
      computeSubscriptionMrr([
        {
          price: it.price,
          quantity: it.quantity,
          snapshot: it.snapshot as PriceSnapshot | null,
          freeQuantity: it.freeQuantity,
        },
      ]),
    );
    const net = sub.status === "active" ? (sub.mrr ?? 0n) : 0n;
    const parts = apportion(net, gross);
    its.forEach((it, i) => {
      if (!targets.has(it.price.id)) return;
      const k = key === "product" ? it.price.productId : it.price.id;
      const acc = out.get(k) ?? new Acc();
      acc.add(sub.id, sub.status === "in_trial", sub.currency.toUpperCase(), parts[i]!);
      out.set(k, acc);
    });
  }
  return out;
}

function merge(accs: Iterable<Acc>): Acc {
  const all = new Acc();
  for (const a of accs) {
    for (const s of a.subs) all.subs.add(s);
    for (const s of a.trial) all.trial.add(s);
    for (const [c, v] of a.mrr) all.mrr.set(c, (all.mrr.get(c) ?? 0n) + v);
  }
  return all;
}

/** Null when the product is not in this business. */
export async function productStats(
  organizationId: string,
  businessId: string,
  productPublicId: string,
): Promise<UsageStats | null> {
  return withTenant(organizationId, async (tx) => {
    const [p] = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.businessId, businessId), eq(products.publicId, productPublicId)))
      .limit(1);
    if (!p) return null;
    const ps = await tx.select({ id: prices.id }).from(prices).where(eq(prices.productId, p.id));
    const by = await usageByKey(
      tx,
      businessId,
      ps.map((r) => r.id),
      "product",
    );
    return (by.get(p.id) ?? new Acc()).out();
  });
}

/** Null when the price is not in this business. */
export async function priceStats(
  organizationId: string,
  businessId: string,
  pricePublicId: string,
): Promise<UsageStats | null> {
  return withTenant(organizationId, async (tx) => {
    const [pr] = await tx
      .select({ id: prices.id })
      .from(prices)
      .where(and(eq(prices.businessId, businessId), eq(prices.publicId, pricePublicId)))
      .limit(1);
    if (!pr) return null;
    const by = await usageByKey(tx, businessId, [pr.id], "price");
    return (by.get(pr.id) ?? new Acc()).out();
  });
}

/**
 * Null when the group is not in this business. `products` lists every product in the
 * group (archived included, zeroed when unused); the group total counts a subscription
 * carrying two of its products once.
 */
export async function productGroupStats(
  organizationId: string,
  businessId: string,
  groupPublicId: string,
): Promise<ProductGroupStats | null> {
  return withTenant(organizationId, async (tx) => {
    const [g] = await tx
      .select({ id: productGroups.id })
      .from(productGroups)
      .where(
        and(eq(productGroups.businessId, businessId), eq(productGroups.publicId, groupPublicId)),
      )
      .limit(1);
    if (!g) return null;
    const prods = await tx
      .select({ id: products.id, publicId: products.publicId })
      .from(products)
      .where(eq(products.productGroupId, g.id))
      .orderBy(products.createdAt, products.publicId);
    const ps =
      prods.length === 0
        ? []
        : await tx
            .select({ id: prices.id })
            .from(prices)
            .where(
              inArray(
                prices.productId,
                prods.map((p) => p.id),
              ),
            );
    const by = await usageByKey(
      tx,
      businessId,
      ps.map((r) => r.id),
      "product",
    );
    return {
      ...merge(by.values()).out(),
      products: prods.map((p) => ({
        productPublicId: p.publicId,
        ...(by.get(p.id) ?? new Acc()).out(),
      })),
    };
  });
}
