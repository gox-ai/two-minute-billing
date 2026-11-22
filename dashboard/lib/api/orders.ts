import type { CreatedThrough } from "@/lib/created-through";
// Typed fetchers for the Orders list and the order page (read-only). Server-only.
// Shape mirrors the route in src/api/invoice-routes.ts (`GET /v1/businesses/:biz/orders`).
import { apiGet, listQuery } from "@/lib/api";
import type { ListParams, PagedList } from "@/lib/api";

export type OrderStatus = "paid" | "due" | "refunded" | "partly_refunded";

export interface Order {
  object: "order";
  /** The invoice id. */
  id: string;
  number: string | null;
  customer: {
    id: string | null;
    name: string | null;
    email: string | null;
    /** Billing country, ISO 3166-1 alpha-2. */
    country: string | null;
    /** The customer's custom-field values, keyed by API name. */
    custom_fields: Record<string, unknown> | null;
  };
  products: Array<{ id: string | null; name: string; units: number }>;
  total_minor: number;
  currency: string;
  status: OrderStatus;
  invoice_status: string;
  refunded_minor: number;
  discount_minor: number;
  tax_minor: number;
  created_at: string;
  paid_at: string | null;
  due_date: string | null;
  channel: string | null;
  payment_method: { type: string; brand: string | null; last4: string | null } | null;
  gateway: string | null;
  coupons: string[];
}

/** One page of orders (paginated). */
export const listOrders = (biz: string, params: ListParams = {}) => {
  const q = listQuery(params);
  return apiGet<PagedList<Order>>(`/v1/businesses/${biz}/orders${q ? `?${q}` : ""}`);
};

export interface OrderPayment {
  id: string;
  status: string;
  amount_minor: number;
  currency: string;
  gateway: string;
  payment_method: { type: string; brand: string | null; last4: string | null } | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
}

export interface OrderRefund {
  id: string;
  /** The payment this refund reverses. */
  payment: string;
  status: string;
  amount_minor: number;
  currency: string;
  reason: string | null;
  gateway: string;
  created_at: string;
}

export interface OrderDetail extends Order {
  created_through?: CreatedThrough | null;
  payments: OrderPayment[];
  refunds: OrderRefund[];
}

/** One order. A 404 (`isApiNotFound`) when the invoice is not an order. */
export const getOrder = (biz: string, id: string) =>
  apiGet<OrderDetail>(`/v1/businesses/${biz}/orders/${id}`);
