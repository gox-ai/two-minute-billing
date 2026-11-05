import { getCustomer, listBusinesses, listPrices, listProducts } from '@/lib/api'
import type { Price, Product } from '@/lib/api'

export interface ChargeContext {
  txnCurrency: string
  bizCurrencies: string[] | null
  /** Charge-kind, active prices across ALL currencies — the form filters by the picked one. */
  chargePrices: Price[]
  products: Product[]
}

/**
 * Everything the customer-level charge takeovers need: the currency to preselect,
 * the business's enabled currencies, and the catalog's charge-kind prices.
 *
 * `txnCurrency` is resolved the same way the customer detail page resolves it —
 * `effective_currency` (derived server-side from live subscriptions) first, NOT
 * `currency`, which is null for most customers and would fall through to the
 * business default and preselect USD for an INR-only customer.
 */
export async function loadChargeContext(
  biz: string,
  cus: string,
): Promise<ChargeContext | { error: string }> {
  try {
    const customer = await getCustomer(biz, cus)
    const [businesses, prices, products] = await Promise.all([
      listBusinesses(),
      listPrices(biz, { includeArchived: false }).catch(() => ({ data: [] as Price[] })),
      listProducts(biz, { includeArchived: false }).catch(() => ({ data: [] as Product[] })),
    ])
    const business = businesses.data.find((b) => b.id === biz)
    const productById = new Map(products.data.map((p) => [p.id, p]))
    return {
      txnCurrency:
        customer.effective_currency ?? customer.currency ?? business?.default_currency ?? 'USD',
      bizCurrencies: business?.currencies ?? null,
      chargePrices: prices.data.filter(
        (p) => p.active !== false && productById.get(p.product)?.kind === 'charge',
      ),
      products: products.data,
    }
  } catch (e) {
    return { error: (e as Error).message }
  }
}
