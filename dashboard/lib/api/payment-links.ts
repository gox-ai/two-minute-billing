// Typed fetchers for payment links (Product catalog → Payment links).
// Server-only — imports the frozen api client. Shapes mirror src/api/payment-link-routes.
import { apiGet } from "@/lib/api";

export interface PaymentLinkItem {
  price: string;
  quantity: number;
  /** The buyer may choose a quantity between these; both null = fixed. */
  min_quantity: number | null;
  max_quantity: number | null;
  /** The buyer may remove this line, or leave it out. */
  optional: boolean;
}

export interface PaymentLink {
  object: "payment_link";
  id: string;
  name: string;
  active: boolean;
  /** `create` subscribes the buyer; `purchase` sells one-time items. */
  mode: "create" | "purchase";
  show_on_pricing_page: boolean;
  redirect_url: string | null;
  cancel_url: string | null;
  /** The public link; null when the engine has no storefront address configured. */
  url: string | null;
  items: PaymentLinkItem[];
  opens: number;
  completions: number;
  created_at: string;
}

export function listPaymentLinks(
  biz: string,
  opts: { product?: string; includeArchived?: boolean } = {},
) {
  const q = new URLSearchParams();
  if (opts.product) q.set("product", opts.product);
  if (opts.includeArchived) q.set("include_archived", "true");
  const suffix = q.size ? `?${q}` : "";
  return apiGet<{ object: "list"; data: PaymentLink[]; has_more: boolean }>(
    `/v1/businesses/${biz}/payment_links${suffix}`,
  );
}
