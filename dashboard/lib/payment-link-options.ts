import type { Price, Product } from "@/lib/api";
import type { SelectOption } from "@/components/ui/select-field";
import type { PaymentLinkPriceMeta } from "@/components/catalog/payment-link-dialog";
import { freqLabel, priceDisplay } from "@/components/catalog/pricing-matrix";

/**
 * The payment-link dialog's price picker: every active price, grouped under its product,
 * plus each price's type and product kind so the dialog can say what the link will do.
 */
export function paymentLinkPriceOptions(
  prices: Price[],
  products: Product[],
): { options: SelectOption[]; meta: Record<string, PaymentLinkPriceMeta> } {
  const byId = new Map(products.map((p) => [p.id, p]));
  const live = prices
    .filter((p) => p.active !== false && byId.get(p.product)?.active !== false)
    .sort(
      (a, b) =>
        (byId.get(a.product)?.name ?? "").localeCompare(byId.get(b.product)?.name ?? "") ||
        a.currency.localeCompare(b.currency),
    );
  const options = live.map((p) => {
    const product = byId.get(p.product);
    return {
      value: p.id,
      label: `${p.currency.toUpperCase()} · ${freqLabel(p)} · ${priceDisplay(p)}`,
      group: product?.external_name ?? product?.name ?? p.product,
    };
  });
  const meta = Object.fromEntries(
    live.map((p) => [p.id, { type: p.type, kind: byId.get(p.product)?.kind ?? "plan" }]),
  );
  return { options, meta };
}
