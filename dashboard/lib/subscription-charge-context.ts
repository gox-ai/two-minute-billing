import { getSubscription, listPrices, listProducts } from "@/lib/api";
import type { Price, Product } from "@/lib/api";

export interface SubscriptionChargeContext {
  currency: string;
  /** Charge-kind, active prices already filtered to the subscription's currency. */
  chargePrices: Price[];
  products: Product[];
}

/**
 * Context for the subscription-level charge takeovers. Currency comes from the
 * subscription (there is no picker at this scope), and the catalog is pre-filtered to
 * it because the API rejects a cross-currency price.
 */
export async function loadSubscriptionChargeContext(
  biz: string,
  sub: string,
): Promise<SubscriptionChargeContext | { error: string }> {
  try {
    const subscription = await getSubscription(biz, sub);
    const [prices, products] = await Promise.all([
      listPrices(biz, { includeArchived: false }).catch(() => ({ data: [] as Price[] })),
      listProducts(biz, { includeArchived: false }).catch(() => ({ data: [] as Product[] })),
    ]);
    const productById = new Map(products.data.map((p) => [p.id, p]));
    return {
      currency: subscription.currency,
      chargePrices: prices.data.filter(
        (p) =>
          p.active !== false &&
          p.currency === subscription.currency &&
          productById.get(p.product)?.kind === "charge",
      ),
      products: products.data,
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
