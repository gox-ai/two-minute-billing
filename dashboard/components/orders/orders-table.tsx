"use client";

import * as React from "react";
import Link from "next/link";
import { type ColumnDef } from "@tanstack/react-table";
import { FileDown, Link2, Package, Receipt, RotateCcw, ShoppingBag, User } from "lucide-react";
import {
  ListPage,
  type ListFilterField,
  type ListPageHeader,
  type ListSegment,
} from "@/components/patterns/list-page";
import { makeListSource } from "@/lib/list-source";
import { InfoCell, MoneyCell, TextCell, TruncateCell } from "@/components/patterns/list-cells";
import { MiddleEllipsis } from "@/components/patterns/id-text";
import {
  gatewayDisplayName,
  gatewayFilterOptions,
  type GatewayCatalogEntry,
} from "@/components/gateways/gateway-meta";
import type { CustomFieldDefinition } from "@/lib/api/custom-fields";
import { customFieldFilterFields } from "@/lib/custom-field-filters";
import { CURRENCY_FILTER_HINT, PAYMENT_METHOD_TYPE_OPTIONS } from "@/lib/filter-options";
import { CustomerInfoCell } from "@/components/patterns/customer-info-cell";
import { OrderStatusChip, STATUS_OPTIONS, STATUS_VIEW } from "@/components/orders/order-status";
import { RowMenu, copyIdItem } from "@/components/patterns/row-menu";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { useBusinessTz } from "@/components/business-tz";
import { fmtDate, fmtDateTime } from "@/lib/format-date";
import { fmtDateShort } from "@/lib/format";
import { instrumentLabel } from "@/lib/instrument-label";
import { moneyCell } from "@/lib/table-export";
import type { Order } from "@/lib/api/orders";

const TEXT_OPS = [
  "is",
  "is_not",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "in",
  "not_in",
  "is_present",
];
const ENUM_OPS = ["is", "is_not", "in", "not_in"];
const NUM_OPS = ["is", "is_not", "gt", "gte", "lt", "lte", "between"];
const DATE_OPS = [
  "on",
  "before",
  "after",
  "on_or_before",
  "on_or_after",
  "between",
  "in_last",
  "in_next",
];
const DATE_OPS_PRESENT = [...DATE_OPS, "is_present"];
const TEXT_OPS_NN = TEXT_OPS.filter((o) => o !== "is_present");

/** Integer minor units: the list mixes currencies, so one exponent would be wrong for a row. */
const MINOR_HINT = "Integer minor units. For example, 129900 is 1,299.00 in a two-decimal currency";

const productsText = (o: Order) =>
  o.products.map((p) => (p.units > 1 ? `${p.name} ×${p.units}` : p.name)).join(", ");

const methodText = (o: Order) =>
  o.payment_method
    ? instrumentLabel({
        type: o.payment_method.type,
        brand: o.payment_method.brand,
        last4: o.payment_method.last4,
      })
    : "";

const CHANNEL_OPTIONS = [
  { value: "api", label: "API" },
  { value: "dashboard", label: "Dashboard" },
  { value: "system", label: "System (billing clock)" },
  { value: "import", label: "Import" },
];

const INVOICE_STATUS_LABEL: Record<string, string> = {
  posted: "Posted",
  payment_due: "Payment due",
  not_paid: "Not paid",
  paid: "Paid",
};

/** The invoice's own status values an order can have (`orderRuleOn`). */
const INVOICE_STATUS_OPTIONS = Object.entries(INVOICE_STATUS_LABEL).map(([value, label]) => ({
  value,
  label,
}));

/** A custom field's value of the customer, as the customer page shows it. */
function customFieldText(
  def: CustomFieldDefinition,
  o: Order,
  tz: string | null | undefined,
): string {
  const v = o.customer.custom_fields?.[def.api_name];
  if (v === undefined || v === null || v === "") return "";
  if (def.data_type === "boolean") return v ? "Yes" : "No";
  if (def.data_type === "date") return fmtDate(String(v), tz);
  return String(v);
}

/** Orders list on the shared `ListPage` chrome. */
export function OrdersTable({
  page,
  biz,
  rows,
  total,
  hasMore,
  nextCursor,
  initialFilters,
  products,
  customFields,
  gatewayCatalog,
}: {
  page?: ListPageHeader;
  biz: string;
  /** First page, server-rendered. */
  rows: Order[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  initialFilters?: Array<{ field: string; op: string; value: string }>;
  /** The products that can be on an order (one-time, not a credit pack), for the Product filter. */
  products: Array<{ id: string; name: string }>;
  /** The customer custom-field definitions, archived included: they filter and show as columns. */
  customFields: CustomFieldDefinition[];
  /** `GET /v1/gateways`: the Gateway filter's options and names. */
  gatewayCatalog: GatewayCatalogEntry[];
}) {
  const fetchPage = React.useMemo(() => makeListSource<Order>("orders", biz), [biz]);
  const tz = useBusinessTz();

  const columns = React.useMemo<ColumnDef<Order>[]>(
    () => [
      {
        id: "order",
        header: "Order",
        // The export prints the number, else the id. The search box matches both on the server.
        accessorFn: (o) => o.number ?? o.id,
        cell: ({ row }) => {
          const o = row.original;
          return (
            <InfoCell
              title={
                o.number ? (
                  o.number
                ) : (
                  <MiddleEllipsis value={o.id} className="max-w-40 font-mono text-sm" />
                )
              }
              href={`/businesses/${biz}/orders/${o.id}`}
            />
          );
        },
      },
      {
        id: "customer",
        header: "Customer",
        accessorFn: (o) => o.customer.name ?? o.customer.id ?? "",
        cell: ({ row }) => {
          const c = row.original.customer;
          if (!c.id) return <TextCell>{c.name}</TextCell>;
          return <CustomerInfoCell id={c.id} name={c.name} email={c.email} />;
        },
      },
      {
        id: "products",
        header: "Products",
        accessorFn: productsText,
        cell: ({ row }) => (
          // Wraps instead of widening the table, so it fits its card at 1366.
          <TextCell className="inline-block max-w-40 whitespace-normal text-foreground">
            {productsText(row.original)}
          </TextCell>
        ),
      },
      {
        // The id is the sort key, so sorting by Amount names a column that exists.
        id: "total_minor",
        header: "Amount",
        accessorFn: (o) => o.total_minor,
        meta: {
          align: "right",
          phone: "aside",
          exportAs: [
            moneyCell<Order>(
              "Amount",
              (r) => r.total_minor,
              (r) => r.currency,
            ),
            { header: "Currency", value: (r) => r.currency },
          ],
        },
        cell: ({ row }) => (
          <MoneyCell minor={row.original.total_minor} currency={row.original.currency} />
        ),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (o) => o.status,
        meta: {
          exportAs: [{ header: "Status", value: (r) => STATUS_VIEW[r.status]?.label ?? r.status }],
        },
        cell: ({ row }) => <OrderStatusChip status={row.original.status} />,
      },
      {
        id: "created_at",
        header: "Date",
        accessorFn: (o) => o.created_at,
        cell: ({ row }) => <TextCell>{fmtDateShort(row.original.created_at, tz)}</TextCell>,
      },
      {
        id: "payment_method",
        header: "Payment method",
        accessorFn: methodText,
        cell: ({ row }) => <TextCell>{methodText(row.original)}</TextCell>,
      },
      {
        id: "coupon",
        header: "Coupon",
        accessorFn: (o) => o.coupons.join(", "),
        cell: ({ row }) => <TextCell>{row.original.coupons.join(", ")}</TextCell>,
      },
      // Optional columns: in the chooser, hidden by default.
      ...(
        [
          ["customer_id", "Customer ID", (o: Order) => o.customer.id ?? ""],
          ["customer_email", "Customer email", (o: Order) => o.customer.email ?? ""],
          ["country", "Billing country", (o: Order) => o.customer.country ?? ""],
          [
            "invoice_status",
            "Invoice status",
            (o: Order) => INVOICE_STATUS_LABEL[o.invoice_status] ?? o.invoice_status,
          ],
          [
            "gateway",
            "Gateway",
            (o: Order) => (o.gateway ? gatewayDisplayName(o.gateway, gatewayCatalog) : ""),
          ],
          [
            "channel",
            "Channel",
            (o: Order) =>
              CHANNEL_OPTIONS.find((c) => c.value === o.channel)?.label ?? o.channel ?? "",
          ],
        ] as Array<[string, string, (o: Order) => string]>
      ).map(([id, header, value]): ColumnDef<Order> => ({
        id,
        header,
        enableSorting: false,
        accessorFn: value,
        cell: ({ row }) => <TruncateCell value={value(row.original)} />,
      })),
      ...(
        [
          ["paid_at", "Paid on", (o: Order) => o.paid_at, true],
          ["due_date", "Due date", (o: Order) => o.due_date, false],
        ] as Array<[string, string, (o: Order) => string | null, boolean]>
      ).map(([id, header, value, withTime]): ColumnDef<Order> => ({
        id,
        header,
        enableSorting: false,
        accessorFn: (o) => value(o) ?? "",
        cell: ({ row }) => {
          const at = value(row.original);
          return (
            <TextCell>{at ? (withTime ? fmtDateTime(at, tz) : fmtDate(at, tz)) : null}</TextCell>
          );
        },
      })),
      ...(
        [
          ["discount", "Discount", (o: Order) => o.discount_minor],
          ["tax", "Tax", (o: Order) => o.tax_minor],
          ["refunded", "Refunded", (o: Order) => o.refunded_minor],
        ] as Array<[string, string, (o: Order) => number]>
      ).map(([id, header, value]): ColumnDef<Order> => ({
        id,
        header,
        accessorFn: value,
        meta: {
          align: "right",
          exportAs: [
            moneyCell<Order>(
              header,
              (r) => value(r),
              (r) => r.currency,
            ),
          ],
        },
        cell: ({ row }) => (
          <MoneyCell minor={value(row.original)} currency={row.original.currency} />
        ),
      })),
      // One column per active custom field of the customer; an archived one only filters.
      ...customFields
        .filter((d) => !d.archived)
        .map((d): ColumnDef<Order> => ({
          id: `cf:${d.api_name}`,
          header: d.label,
          enableSorting: false,
          accessorFn: (o) => customFieldText(d, o, tz),
          cell: ({ row }) => <TruncateCell value={customFieldText(d, row.original, tz)} />,
        })),
    ],
    [biz, tz, customFields, gatewayCatalog],
  );

  const hiddenColumns = React.useMemo(
    () => [
      // Payment method and coupon live on the order page; hidden here so the table fits at 1440.
      "payment_method",
      "coupon",
      "customer_id",
      "customer_email",
      "country",
      "invoice_status",
      "paid_at",
      "discount",
      "tax",
      "refunded",
      "gateway",
      "channel",
      "due_date",
      ...customFields.filter((d) => !d.archived).map((d) => `cf:${d.api_name}`),
    ],
    [customFields],
  );

  const segments = React.useMemo<ListSegment<Order>[]>(
    () => [
      { id: "all", label: "All orders" },
      { id: "paid", label: "Paid", filters: [{ field: "order_status", op: "is", value: "paid" }] },
      { id: "due", label: "Due", filters: [{ field: "order_status", op: "is", value: "due" }] },
      {
        id: "refunded",
        label: "Refunded",
        filters: [{ field: "order_status", op: "is", value: "refunded" }],
      },
      {
        id: "partly_refunded",
        label: "Partly refunded",
        filters: [{ field: "order_status", op: "is", value: "partly_refunded" }],
      },
      // No Overdue segment: a segment is a fixed filter, and "due date before today" moves.
      // The Due date filter and the Due date column answer it.
    ],
    [],
  );

  const filterFields = React.useMemo<ListFilterField<Order>[]>(
    () => [
      { id: "number", label: "Invoice number", group: "Order", serverOps: TEXT_OPS },
      { id: "id", label: "Invoice ID", group: "Order", serverOps: TEXT_OPS_NN },
      {
        id: "order_status",
        label: "Status",
        type: "select",
        group: "Order",
        options: STATUS_OPTIONS,
        serverOps: ENUM_OPS,
      },
      {
        id: "status",
        label: "Invoice status",
        type: "select",
        group: "Order",
        options: INVOICE_STATUS_OPTIONS,
        serverOps: ENUM_OPS,
      },
      {
        id: "product",
        label: "Product",
        type: "select",
        group: "Order",
        options: products.map((p) => ({ value: p.id, label: p.name })),
        serverOps: ENUM_OPS,
      },
      {
        id: "coupon",
        label: "Coupon code",
        group: "Order",
        serverOps: TEXT_OPS,
        // A partial code is the usual search.
        defaultOp: "contains",
        hint: "The code of a coupon that took money off the order",
      },
      {
        id: "channel",
        label: "Channel",
        type: "select",
        group: "Order",
        options: CHANNEL_OPTIONS,
        serverOps: ENUM_OPS,
        hint: "Empty on invoices created before we recorded the channel",
      },
      { id: "customer", label: "Customer ID", group: "Customer", serverOps: TEXT_OPS_NN },
      { id: "customer_name", label: "Customer name", group: "Customer", serverOps: TEXT_OPS },
      { id: "customer_email", label: "Customer email", group: "Customer", serverOps: TEXT_OPS },
      {
        id: "customer_country",
        label: "Billing country",
        group: "Customer",
        serverOps: ENUM_OPS,
        hint: "2-letter ISO code, for example US or IN",
      },
      {
        id: "currency",
        label: "Currency",
        group: "Amount",
        serverOps: ENUM_OPS,
        hint: CURRENCY_FILTER_HINT,
      },
      {
        id: "total_minor",
        label: "Amount (minor units)",
        type: "number",
        group: "Amount",
        serverOps: NUM_OPS,
        hint: MINOR_HINT,
        keywords: "total",
      },
      {
        id: "discount_minor",
        label: "Discount (minor units)",
        type: "number",
        group: "Amount",
        serverOps: NUM_OPS,
        hint: MINOR_HINT,
      },
      {
        id: "tax_minor",
        label: "Tax (minor units)",
        type: "number",
        group: "Amount",
        serverOps: NUM_OPS,
        hint: MINOR_HINT,
      },
      {
        id: "refunded_minor",
        label: "Refunded (minor units)",
        type: "number",
        group: "Amount",
        serverOps: NUM_OPS,
        hint: MINOR_HINT,
      },
      {
        id: "gateway",
        label: "Gateway",
        type: "select",
        group: "Payment",
        // Closed: the gateways this engine has (`GET /v1/gateways`).
        options: gatewayFilterOptions(gatewayCatalog),
        serverOps: ENUM_OPS,
        hint: "The gateway of a payment that paid the order",
      },
      {
        id: "payment_method_type",
        label: "Payment method type",
        type: "select",
        group: "Payment",
        options: PAYMENT_METHOD_TYPE_OPTIONS,
        serverOps: ENUM_OPS,
      },
      { id: "created_at", label: "Date", type: "date", group: "Dates", serverOps: DATE_OPS },
      {
        id: "paid_at",
        label: "Paid on",
        type: "date",
        group: "Dates",
        serverOps: DATE_OPS_PRESENT,
      },
      {
        id: "due_date",
        label: "Due date",
        type: "date",
        group: "Dates",
        serverOps: DATE_OPS_PRESENT,
      },
      // The customer's custom fields: keys of the customer's `custom_fields`, so the set
      // differs per business. An order has no custom fields of its own, and there is no
      // metadata filter for orders in the engine yet.
      ...customFieldFilterFields<Order>(customFields).map((f) => ({
        ...f,
        group: "Customer custom fields",
      })),
    ],
    [products, customFields, gatewayCatalog],
  );

  return (
    <ListPage
      page={page}
      entity={{ singular: "Order", plural: "Orders" }}
      columns={columns}
      data={rows}
      server={{ total, hasMore, nextCursor, fetchPage }}
      segments={segments}
      filterFields={filterFields}
      initialFilters={initialFilters}
      savedViews={{ entity: "orders", biz }}
      sortOptions={[
        { id: "created_at", label: "Date" },
        { id: "total_minor", label: "Amount" },
        { id: "paid_at", label: "Paid on" },
        // The invoice's own status; `LIST_SORTS.status`. The order status is derived and not sortable.
        { id: "status", label: "Invoice status" },
        { id: "due_date", label: "Due date" },
      ]}
      searchPlaceholder="Search by number, ID or customer"
      exportName="orders"
      persistKey={`orders:${biz}`}
      initialHidden={hiddenColumns}
      enableSelection
      // No create action: an order comes from a payment link, a purchase checkout or a manual
      // invoice with a one-time line. There is no "new order" form in the dashboard to open.
      rowHref={(o) => `/businesses/${biz}/orders/${o.id}`}
      rowMenu={(o) => {
        const base = `/businesses/${biz}/orders/${o.id}`;
        const invoice = `/businesses/${biz}/invoices/${o.id}`;
        return (
          <RowMenu
            label={o.number ?? o.id}
            groups={[
              {
                label: "References",
                items: [
                  {
                    label: "View order",
                    icon: <ShoppingBag className="size-4" />,
                    href: base,
                  },
                  { label: "View invoice", icon: <Receipt className="size-4" />, href: invoice },
                  o.customer.id
                    ? {
                        label: "View customer",
                        icon: <User className="size-4" />,
                        href: `/businesses/${biz}/customers/${o.customer.id}`,
                      }
                    : null,
                ],
              },
              {
                label: "Quick actions",
                items: [
                  {
                    label: "Download invoice PDF",
                    icon: <FileDown className="size-4" />,
                    download: `${invoice}/pdf`,
                  },
                  // The refund dialogs live on the order page, in its Refunds card.
                  o.status === "paid" || o.status === "partly_refunded"
                    ? {
                        label: "Refund",
                        icon: <RotateCcw className="size-4" />,
                        href: `${base}#refunds`,
                      }
                    : null,
                  copyIdItem("invoice", o.id),
                ],
              },
            ]}
          />
        );
      }}
      emptyState={
        <EmptyState
          icon={<Package />}
          title="No orders yet"
          description="An order is an invoice for one-time products. Create a payment link or a one-time product to start."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button asChild size="sm">
                <Link href={`/businesses/${biz}/catalog/payment_links`}>
                  <Link2 className="size-3.5" /> Create a payment link
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={`/businesses/${biz}/catalog/charges/new`}>
                  Create a one-time product
                </Link>
              </Button>
            </div>
          }
        />
      }
    />
  );
}
