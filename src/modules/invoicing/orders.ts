import { sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import type { ListPage } from "@/platform/list-query";
import { listInvoicesPage, type InvoiceListFilters, type InvoiceListRow } from "./service";

/** What the Orders list prints: paid, due, refunded or partly refunded. */
export type OrderStatus = "paid" | "due" | "refunded" | "partly_refunded";

/** Same rule as the `order_status` filter in `service.ts`. */
export function orderStatus(invoiceStatus: string, paid: bigint, refunded: bigint): OrderStatus {
  if (refunded > 0n && refunded >= paid) return "refunded";
  if (refunded > 0n) return "partly_refunded";
  return invoiceStatus === "paid" ? "paid" : "due";
}

export interface OrderRow {
  row: InvoiceListRow;
  status: OrderStatus;
  refundedMinor: bigint;
  products: Array<{ id: string | null; name: string; units: number }>;
  paymentMethod: { type: string; brand: string | null; last4: string | null } | null;
  gateway: string | null;
  coupons: string[];
  discountMinor: bigint;
  taxMinor: bigint;
  /** Billing country on the customer record (ISO 3166-1 alpha-2). */
  customerCountry: string | null;
  /** The customer's custom-field values, keyed by API name. */
  customerCustomFields: Record<string, unknown> | null;
}

const inList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

/** One page of orders: the invoice list narrowed by the order rule, plus per-row detail. */
export async function listOrdersPage(
  organizationId: string,
  businessId: string,
  f: InvoiceListFilters = {},
): Promise<ListPage<OrderRow>> {
  const page = await listInvoicesPage(organizationId, businessId, { ...f, ordersOnly: true });
  const ids = page.data.map((r) => r.invoice.id);
  if (ids.length === 0) return { ...page, data: [] };

  const detail = await withTenant(organizationId, async (tx) => {
    const lines = (await tx.execute(sql`
      select l.invoice_id::text as invoice, l.description, l.quantity, p.public_id as product, p.name
      from invoice_line_items l
      left join prices pr on pr.id = l.price_id
      left join products p on p.id = pr.product_id
      where l.invoice_id in (${inList(ids)}) and l.kind = 'one_time'
        and coalesce(pr.grants_credit ->> 'kind', '') <> 'pack'
      order by l.seq`)) as unknown as Array<{
      invoice: string;
      description: string;
      quantity: number;
      product: string | null;
      name: string | null;
    }>;
    const pays = (await tx.execute(sql`
      select distinct on (p.invoice_id) p.invoice_id::text as invoice, p.provider_key as gateway,
        m.type, m.brand, m.last4
      from payments p left join payment_methods m on m.id = p.payment_method_id
      where p.invoice_id in (${inList(ids)}) and p.status = 'succeeded'
      order by p.invoice_id, p.created_at, p.id`)) as unknown as Array<{
      invoice: string;
      gateway: string;
      type: string | null;
      brand: string | null;
      last4: string | null;
    }>;
    const sums = (await tx.execute(sql`
      select i.id::text as invoice, c.country as country, c.custom_fields as custom_fields,
        coalesce((select sum(t.amount_minor) from applied_taxes t where t.invoice_id = i.id), 0)::text as tax,
        coalesce((select sum(d.amount_minor) from invoice_line_discounts d where d.invoice_id = i.id), 0)::text as discount,
        coalesce((select sum(p.amount_minor) from payments p
          where p.invoice_id = i.id and p.status = 'succeeded'), 0)::text as paid,
        coalesce((select sum(r.amount_minor) from refunds r join payments p on p.id = r.payment_id
          where p.invoice_id = i.id and r.status = 'succeeded'), 0)::text as refunded
      from invoices i left join customers c on c.id = i.customer_id
      where i.id in (${inList(ids)})`)) as unknown as Array<{
      invoice: string;
      country: string | null;
      custom_fields: Record<string, unknown> | null;
      tax: string;
      discount: string;
      paid: string;
      refunded: string;
    }>;
    const codes = (await tx.execute(sql`
      select d.invoice_id::text as invoice, c.code
      from invoice_line_discounts d
      join applied_coupons ac on ac.id = d.applied_coupon_id
      join coupons c on c.id = ac.coupon_id
      where d.invoice_id in (${inList(ids)}) and d.amount_minor <> 0
      group by 1, 2 order by 1, 2`)) as unknown as Array<{ invoice: string; code: string }>;
    return { lines, pays, sums, codes };
  });

  const sumOf = new Map(detail.sums.map((s) => [s.invoice, s]));
  return {
    ...page,
    data: page.data.map((row): OrderRow => {
      const id = row.invoice.id;
      const s = sumOf.get(id);
      const refunded = BigInt(s?.refunded ?? "0");
      const pay = detail.pays.find((p) => p.invoice === id);
      const products = new Map<string, { id: string | null; name: string; units: number }>();
      for (const l of detail.lines.filter((x) => x.invoice === id)) {
        const name = l.name ?? l.description;
        const key = l.product ?? `d:${name}`;
        const have = products.get(key);
        if (have) have.units += l.quantity;
        else products.set(key, { id: l.product, name, units: l.quantity });
      }
      return {
        row,
        status: orderStatus(row.invoice.status, BigInt(s?.paid ?? "0"), refunded),
        refundedMinor: refunded,
        products: [...products.values()],
        paymentMethod: pay?.type ? { type: pay.type, brand: pay.brand, last4: pay.last4 } : null,
        gateway: pay?.gateway ?? null,
        coupons: detail.codes.filter((c) => c.invoice === id).map((c) => c.code),
        discountMinor: BigInt(s?.discount ?? "0"),
        taxMinor: BigInt(s?.tax ?? "0"),
        customerCountry: s?.country?.trim() || null,
        customerCustomFields: s?.custom_fields ?? null,
      };
    }),
  };
}

export interface OrderPaymentRow {
  id: string;
  status: string;
  amountMinor: bigint;
  currency: string;
  gateway: string;
  paymentMethod: { type: string; brand: string | null; last4: string | null } | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: Date;
}

export interface OrderRefundRow {
  id: string;
  payment: string;
  status: string;
  amountMinor: bigint;
  currency: string;
  reason: string | null;
  gateway: string;
  createdAt: Date;
}

export interface OrderDetail extends OrderRow {
  payments: OrderPaymentRow[];
  refunds: OrderRefundRow[];
}

/**
 * One order, or null when the invoice is not an order (a subscription invoice, a credit pack,
 * a draft) or is not in this business. Same row as the list, plus every payment attempt and
 * every refund.
 */
export async function getOrderDetail(
  organizationId: string,
  businessId: string,
  publicId: string,
): Promise<OrderDetail | null> {
  const page = await listOrdersPage(organizationId, businessId, {
    filters: [{ field: "id", op: "is", value: publicId }],
    limit: 1,
  });
  const order = page.data.find((o) => o.row.invoice.publicId === publicId);
  if (!order) return null;
  const invoiceId = order.row.invoice.id;
  const { payments, refunds } = await withTenant(organizationId, async (tx) => {
    const pays = (await tx.execute(sql`
      select p.public_id as id, p.status, p.amount_minor::text as amount, p.currency,
        p.provider_key as gateway, p.failure_code, p.failure_message, p.created_at,
        m.type, m.brand, m.last4
      from payments p left join payment_methods m on m.id = p.payment_method_id
      where p.invoice_id = ${invoiceId}
      order by p.created_at, p.id`)) as unknown as Array<{
      id: string;
      status: string;
      amount: string;
      currency: string;
      gateway: string;
      failure_code: string | null;
      failure_message: string | null;
      created_at: Date | string;
      type: string | null;
      brand: string | null;
      last4: string | null;
    }>;
    const refs = (await tx.execute(sql`
      select r.public_id as id, p.public_id as payment, r.status, r.amount_minor::text as amount,
        r.currency, r.reason, r.provider_key as gateway, r.created_at
      from refunds r join payments p on p.id = r.payment_id
      where p.invoice_id = ${invoiceId}
      order by r.created_at, r.id`)) as unknown as Array<{
      id: string;
      payment: string;
      status: string;
      amount: string;
      currency: string;
      reason: string | null;
      gateway: string;
      created_at: Date | string;
    }>;
    return { payments: pays, refunds: refs };
  });
  return {
    ...order,
    payments: payments.map((p) => ({
      id: p.id,
      status: p.status,
      amountMinor: BigInt(p.amount),
      currency: p.currency.trim(),
      gateway: p.gateway,
      paymentMethod: p.type ? { type: p.type, brand: p.brand, last4: p.last4 } : null,
      failureCode: p.failure_code,
      failureMessage: p.failure_message,
      createdAt: new Date(p.created_at),
    })),
    refunds: refunds.map((r) => ({
      id: r.id,
      payment: r.payment,
      status: r.status,
      amountMinor: BigInt(r.amount),
      currency: r.currency.trim(),
      reason: r.reason,
      gateway: r.gateway,
      createdAt: new Date(r.created_at),
    })),
  };
}
