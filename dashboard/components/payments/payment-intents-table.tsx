"use client";

import { paymentSourceText } from "@/lib/payment-trigger";
import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ListPage,
  type ListFilterField,
  type ListSegment,
  type ListPageHeader,
  type ListServerFilter,
} from "@/components/patterns/list-page";
import { InstrumentMark } from "@/components/brand/instrument-mark";
import { makeListSource } from "@/lib/list-source";
import Link from "next/link";
import { MoneyCell, TextCell } from "@/components/patterns/list-cells";
import { MiddleEllipsis } from "@/components/patterns/id-text";
import { Chip, StatusChip } from "@/components/patterns/chip";
import { declineReading } from "@/lib/decline-reading";
import { EmptyState } from "@/components/states";
import { fmtDateTime } from "@/lib/format-date";
import { CustomerInfoCell } from "@/components/patterns/customer-info-cell";
import { displayIntentStatus } from "@/lib/payment-intent-status";
import { useBusinessTz } from "@/components/business-tz";
import type { PaymentIntentRow } from "@/lib/api/payments";
import { Wallet } from "lucide-react";
import { distinctAccountLabel, GatewayLabel } from "@/components/partner-logo";
import { gatewayDisplayName, type GatewayCatalogEntry } from "@/components/gateways/gateway-meta";

/**
 * `customer_name` on this row is ALREADY the engine's resolved `accountHolderName`
 * (`PaymentIntentListRow.customerName`), email fallback included.
 *
 * This used to re-derive it client-side from `first_name`/`last_name`/`name`/`email`
 * for consistency with the other lists. That is now strictly worse: the row carries no
 * `customer_company`, so re-deriving drops the COMPANY arm of the chain — a
 * company-only customer would render as their email here and as "Kavi Analytics Pvt
 * Ltd" everywhere else. Trust the server's answer.
 */
function customerName(r: PaymentIntentRow): string | null {
  return r.customer_name ?? r.customer_email ?? null;
}

/**
 * Why the newest attempt failed: our reading, then the gateway's message, then its
 * code. Wraps rather than cuts. Shared with the customer page's Payment intents tab.
 */
export function IntentLastError({ error }: { error: PaymentIntentRow["last_error"] }) {
  if (!error?.message && !error?.code) return <TextCell />;
  const reading = declineReading(error.code, error.message);
  return (
    <span className="flex flex-col gap-0.5">
      {/* Our reading first; the gateway's own words always stay under it. */}
      {reading ? (
        <span className="block max-w-80 text-sm/6 font-medium whitespace-normal">{reading}</span>
      ) : null}
      {error.message ? (
        <span className="block min-h-6 max-w-80 text-sm/6 wrap-break-word whitespace-normal">
          {error.message}
        </span>
      ) : null}
      {error.code ? (
        <span className="flex min-h-5 items-center font-mono text-xs wrap-anywhere whitespace-normal text-muted-foreground">
          {error.code}
        </span>
      ) : null}
    </span>
  );
}

export function IntentPurposeChip({ purpose }: { purpose: PaymentIntentRow["purpose"] }) {
  return <Chip>{purpose === "setup" ? "Setup" : "Payment"}</Chip>;
}

/**
 * Payment intents list.
 *
 * Amount/currency are nullable on the row: an intent can exist before either is
 * known, so those cells stay blank rather than rendering a fake zero.
 *
 * Status, amount and id stay separate sortable columns rather than stacking into
 * one: id (linked to the detail page), customer, status, type, amount, payment
 * attempts, payment method, gateway + gateway account, created.
 */
export function PaymentIntentsTable({
  page,
  biz,
  rows,
  total,
  hasMore,
  nextCursor,
  gatewayCatalog,
  initialFilters,
}: {
  /** The page header, drawn by the list (see ListPage.page). */
  page?: ListPageHeader;
  biz: string;
  /** Names the gateway ("TM Test Gateway", not the key). */
  gatewayCatalog: GatewayCatalogEntry[];
  rows: PaymentIntentRow[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** Deep-link filters from the URL (`?filter=customer:is:cus_…`) — see ListPage. */
  initialFilters?: ListServerFilter[];
}) {
  const tz = useBusinessTz();
  const fetchPage = makeListSource<PaymentIntentRow>("payment_intents", biz);

  const columns = React.useMemo<ColumnDef<PaymentIntentRow>[]>(
    () => [
      {
        accessorKey: "created_at",
        id: "created_at",
        header: "Created",
        cell: ({ row }) => <TextCell>{fmtDateTime(row.original.created_at, tz)}</TextCell>,
      },
      {
        id: "intent",
        header: "Payment intent",
        accessorFn: (r) => r.id,
        // The phone row's title stays the id: "Last error" takes the spare width.
        meta: { phone: "title" },
        // Middle ellipsis: ids are time-ordered, so they share their first characters
        // and differ at the end. The full id is in the tooltip and on the detail page.
        cell: ({ row }) => (
          <Link
            href={`/businesses/${biz}/payment_intents/${row.original.id}`}
            className="flex max-w-28 text-muted-foreground hover:text-primary hover:underline"
          >
            <MiddleEllipsis value={row.original.id} className="text-xs" />
          </Link>
        ),
      },
      {
        id: "customer",
        header: "Customer",
        accessorFn: (r) => customerName(r) ?? r.customer ?? "",
        cell: ({ row }) => {
          const r = row.original;
          if (!r.customer) return <TextCell />;
          return (
            <CustomerInfoCell
              id={r.customer}
              name={customerName(r)}
              email={r.customer_email}
              href={`/businesses/${biz}/customers/${r.customer}`}
            />
          );
        },
      },
      {
        accessorKey: "status",
        header: "Status",
        // DERIVED, not `status` verbatim — an intent has no `failed`, so a refused one is
        // stored as an OPEN intent with a failed attempt and rendered raw it reads
        // "In Progress" over a dead flow. The SEGMENTS above still filter on the stored
        // value, which is the engine's own vocabulary and the only thing the list
        // endpoint accepts.
        cell: ({ row }) => <StatusChip status={displayIntentStatus(row.original)} />,
      },
      {
        id: "last_error",
        header: "Last error",
        enableSorting: false,
        accessorFn: (r) =>
          [
            declineReading(r.last_error?.code, r.last_error?.message),
            r.last_error?.message,
            r.last_error?.code,
          ]
            .filter(Boolean)
            .join(" "),
        // The one column that takes the spare width, so the list fits its card: the
        // message wraps to whatever is left, and a long code breaks only when it must.
        meta: { grow: true },
        // Why the newest attempt failed: the message, then the gateway's code under it,
        // as the transactions list shows it. Wraps rather than cuts.
        cell: ({ row }) => <IntentLastError error={row.original.last_error} />,
      },
      {
        id: "purpose",
        header: "Type",
        accessorFn: (r) => r.purpose,
        // Most real rows are $0.00 `setup` intents, so without this column the
        // Amount column reads as broken.
        cell: ({ row }) => <IntentPurposeChip purpose={row.original.purpose} />,
      },
      {
        id: "amount",
        header: "Amount",
        accessorFn: (r) => r.amount_minor ?? 0,
        meta: { align: "right", phone: "aside" },
        cell: ({ row }) => {
          const { amount_minor: amt, currency } = row.original;
          // Blank, not $0.00 — an intent may predate knowing the amount.
          if (amt == null || !currency) return <TextCell />;
          return <MoneyCell minor={amt} currency={currency} />;
        },
      },
      {
        id: "attempt_count",
        // "Attempts" rather than "Payment Attempts" because the header text is
        // what sets this column's minimum width, and the full wording cost 60px on
        // a table already at its limit — inside a list of payment intents the
        // shorter word means exactly the same thing.
        header: "Attempts",
        accessorFn: (r) => r.attempt_count,
        meta: { align: "right" },
        // Denormalised on the intent (`attempt_count`), so the column costs no
        // per-row query.
        cell: ({ row }) => (
          <span className="text-sm tabular-nums">{row.original.attempt_count}</span>
        ),
      },
      {
        id: "payment_method",
        header: "Payment method",
        accessorFn: (r) =>
          [r.payment_method_brand, r.payment_method_last4].filter(Boolean).join(" "),
        cell: ({ row }) => {
          const { payment_method_brand: brand, payment_method_last4: last4 } = row.original;
          if (!brand && !last4) return <TextCell />;
          return (
            <span className="flex items-center gap-1.5 text-sm">
              {/* The payer's own network mark, as the portal shows it. */}
              <InstrumentMark brand={brand} last4={last4} className="h-3.5 w-6" />
              <span className="capitalize">{brand}</span>
              {last4 ? <span className="text-muted-foreground">ending {last4}</span> : null}
            </span>
          );
        },
      },
      {
        id: "gateway",
        header: "Gateway",
        accessorFn: (r) =>
          [
            r.gateway_key && gatewayDisplayName(r.gateway_key, gatewayCatalog),
            r.gateway_account_label,
          ]
            .filter(Boolean)
            .join(" "),
        // The logo, with the gateway ACCOUNT under it ("Stripe-1") only when its label
        // differs from the gateway's name: a business can hold several accounts on one
        // gateway, but "Stripe" under the Stripe logo says nothing new.
        cell: ({ row }) => {
          const { gateway_key: key, gateway_account_label: label } = row.original;
          if (!key) return <TextCell />;
          const name = gatewayDisplayName(key, gatewayCatalog);
          const account = distinctAccountLabel(key, label, name);
          return (
            <div className="flex flex-col gap-0.5">
              <GatewayLabel gatewayKey={key} name={name} className="text-sm" />
              {account ? <span className="text-xs text-muted-foreground">{account}</span> : null}
            </div>
          );
        },
      },
      {
        id: "source",
        header: "Source",
        accessorFn: (r) => paymentSourceText(r.initiated_by),
        cell: ({ row }) => (
          <span className="text-sm">{paymentSourceText(row.original.initiated_by)}</span>
        ),
      },
      {
        id: "expires_at",
        header: "Expires",
        accessorFn: (r) => r.expires_at ?? "",
        cell: ({ row }) => (
          <TextCell>
            {row.original.expires_at ? fmtDateTime(row.original.expires_at, tz) : null}
          </TextCell>
        ),
      },
    ],
    [biz, tz, gatewayCatalog],
  );

  /**
   * Mirrors the engine's `PI_STATUSES` / `PI_PURPOSES` (payment-intents/service.ts)
   * so a segment can never select a value the API will not return — an unknown one
   * is a 400 there, not an empty page.
   *
   * These are the only two facets the list endpoint implements, and both are
   * translated to `?status=` / `?purpose=` in `app/api/lists/[entity]/route.ts`.
   * Do NOT add a segment on any other field: the endpoint's allow-list would
   * reject the request rather than narrow it.
   */
  const segments = React.useMemo<ListSegment<PaymentIntentRow>[]>(
    () => [
      { id: "all", label: "All payment intents" },
      { id: "inited", label: "Open", filters: [{ field: "status", op: "is", value: "inited" }] },
      {
        id: "in_progress",
        label: "In progress",
        filters: [{ field: "status", op: "is", value: "in_progress" }],
      },
      {
        id: "authorized",
        label: "Authorized",
        filters: [{ field: "status", op: "is", value: "authorized" }],
      },
      {
        id: "consumed",
        label: "Used",
        filters: [{ field: "status", op: "is", value: "consumed" }],
      },
      {
        id: "expired",
        label: "Expired",
        filters: [{ field: "status", op: "is", value: "expired" }],
      },
      // Phase 4 added `voided` to the vocabulary; without a segment the state was
      // reachable only by scrolling.
      { id: "voided", label: "Voided", filters: [{ field: "status", op: "is", value: "voided" }] },
      {
        id: "purpose_payment",
        label: "Payments",
        filters: [{ field: "purpose", op: "is", value: "payment" }],
      },
      {
        id: "purpose_setup",
        label: "Setup (card on file)",
        filters: [{ field: "purpose", op: "is", value: "setup" }],
      },
    ],
    [],
  );

  /**
   * Exactly the facets the endpoint implements, with exactly one operator each.
   *
   * `/api/lists/payment_intents` translates the builder's rows into the engine's
   * `?status=` / `?purpose=` / `?customer=` params, and it reads them as
   * `filters.find(f => f.field === … && f.op === 'is')` — so any other field is DROPPED
   * on the way through (the list comes back unnarrowed under a filter pill), and any
   * other operator on these fields is dropped the same way. Offering `is one of`
   * here would therefore be a control that does nothing, which is why `serverOps` is a
   * single operator rather than the enum table every other server-backed list uses.
   *
   * Values mirror `PI_STATUSES` / `PI_PURPOSES` in src/api/payment-intent-routes.ts,
   * which 400s on an unknown one rather than returning an empty page.
   */
  const filterFields = React.useMemo<ListFilterField<PaymentIntentRow>[]>(
    () => [
      {
        id: "status",
        label: "Status",
        type: "select",
        group: "Status",
        options: [
          { value: "inited", label: "Open" },
          { value: "in_progress", label: "In progress" },
          { value: "authorized", label: "Authorized" },
          { value: "consumed", label: "Used" },
          { value: "expired", label: "Expired" },
          { value: "voided", label: "Voided" },
        ],
        serverOps: ["is"],
      },
      {
        id: "purpose",
        label: "Type",
        type: "select",
        group: "Configuration",
        options: [
          { value: "payment", label: "Payment" },
          { value: "setup", label: "Setup (card on file)" },
        ],
        serverOps: ["is"],
      },
      // The customer page's History tab links here with this one.
      { id: "customer", label: "Customer ID", group: "Customer", serverOps: ["is"] },
    ],
    [],
  );

  return (
    <ListPage
      page={page}
      entity={{ singular: "Payment intent", plural: "Payment intents" }}
      columns={columns}
      data={rows}
      server={{ total, hasMore, nextCursor, fetchPage }}
      segments={segments}
      filterFields={filterFields}
      initialFilters={initialFilters}
      savedViews={{ entity: "payment_intents", biz }}
      // The intents proxy fetcher forwards only `status` and `purpose`, never `q`, so a
      // search box would be a control that does nothing.
      searchable={false}
      /**
       * Measured, not guessed. The table's container is 1214px at a 1600px window,
       * and with every column on the row demanded 1583 — this list already
       * overflowed BEFORE the new columns. Four changes bring it to exactly 1214:
       * ellipsising the id, truncating the customer email, the shorter "Attempts"
       * header, and demoting this one. Re-measure with
       * `wrapper.scrollWidth - wrapper.clientWidth` before adding another column.
       *
       * `payment_method` goes rather than `attempt_count` / `purpose` because the
       * card is reachable from the customer and the transaction, whereas the attempt
       * count and the setup/payment split exist ONLY here. Both hidden columns stay in
       * the column chooser, and a user's choice still wins.
       *
       * ⚠️ `payment_method` is hidden purely on width: re-measured at the 1600px
       * reference viewport, un-hiding it makes the table 1411px in a 1204px wrapper
       * — 207px over, 9 cells clipped. Keep it hidden until something else gives up
       * room.
       *
       * 2026-11-13: "Last error" (on by default) cost 280px and pushed Gateway and
       * Created out of a 1068px wrapper at a 1440px window. `purpose` and
       * `attempt_count` gave up the room: the status chip and the error now say what
       * the attempt count used to hint at. Both stay in the column chooser.
       *
       * `gateway` goes too, as on transactions and gateway requests: the table was
       * still 31px over at 1440 and cut Gateway and Created at 1280 (910px card).
       * "Last error" is now the grow column, so it absorbs what is left.
       */
      initialHidden={[
        "expires_at",
        "payment_method",
        "purpose",
        "attempt_count",
        "gateway",
        "source",
      ]}
      emptyState={
        <EmptyState
          icon={<Wallet />}
          title="No payment intents"
          description="We create payment intents for 3DS and off-session challenge flows. An invoice then consumes the intent."
        />
      }
    />
  );
}
