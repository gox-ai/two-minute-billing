"use client";

import * as React from "react";
import Link from "next/link";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ListPage,
  type ListFilterField,
  type ListSegment,
  type ListServerFilter,
  type ListPageHeader,
} from "@/components/patterns/list-page";
import { makeListSource } from "@/lib/list-source";
import { IdCell, MoneyCell, TextCell, TruncateCell } from "@/components/patterns/list-cells";
import { StatusChip } from "@/components/patterns/chip";
import { EmptyState } from "@/components/states";
import { fmtDateTimeShort } from "@/lib/format";
import { CustomerInfoCell } from "@/components/patterns/customer-info-cell";
import type { Transaction } from "@/lib/api/payments";
import { ArrowLeftRight } from "lucide-react";
import { useBusinessTz } from "@/components/business-tz";
import { paymentMarkLabel, type PaymentMarkKey } from "@/components/brand/payment-mark";
import { InstrumentMark } from "@/components/brand/instrument-mark";
import { paymentMethodTypeLabel } from "@/lib/filter-options";
import { moneyCell } from "@/lib/table-export";
import { GatewayLabel } from "@/components/partner-logo";
import {
  gatewayFilterOptions,
  gatewayObjectUrl,
  type GatewayCatalogEntry,
} from "@/components/gateways/gateway-meta";

/**
 * The engine's operator tables, copied verbatim from `src/platform/list-query.ts`
 * (reached here through `TRANSACTION_FILTER_OPS`).
 *
 * These lists used to be narrowed by hand — five of nine text operators, three of
 * nine date ones — so `is one of`, `between` and `in the last N days` existed in SQL
 * and were unreachable from the screen. Mirror the engine or the screen lies about
 * what the list can do.
 */
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
const ENUM_OPS = ["is", "is_not", "in", "not_in", "is_present"];
const BOOL_OPS = ["is"];
const NUM_OPS = ["is", "is_not", "gt", "gte", "lt", "lte", "between", "is_present"];
const DATE_OPS = [
  "on",
  "before",
  "after",
  "on_or_before",
  "on_or_after",
  "between",
  "in_last",
  "in_next",
  "is_present",
];

/**
 * The closed vocabularies, written out rather than derived from the loaded page.
 *
 * Options built from `rows` silently omit every value that exists elsewhere in the
 * business: a page of successes offered no way to filter for `late_failed`, which is
 * the one status an operator opens this screen to find. `TransactionType` /
 * `TransactionStatus` in `src/modules/transactions/service.ts` are the authority.
 */
const TYPE_OPTIONS = [
  { value: "authorization", label: "Authorization" },
  { value: "payment", label: "Payment" },
  { value: "refund", label: "Refund" },
  { value: "payment_reversal", label: "Payment reversal" },
];

const STATUS_OPTIONS = [
  { value: "in_progress", label: "In progress" },
  { value: "succeeded", label: "Success" },
  { value: "failed", label: "Failure" },
  { value: "voided", label: "Voided" },
  { value: "timeout", label: "Timeout" },
  { value: "needs_attention", label: "Needs attention" },
  { value: "late_failed", label: "Late failure" },
];

/** Every network we have artwork and a name for — typed, so dropping one breaks the build. */
const BRAND_KEYS: PaymentMarkKey[] = [
  "visa",
  "mastercard",
  "amex",
  "rupay",
  "discover",
  "diners",
  "jcb",
  "maestro",
  "unionpay",
  "paypal",
  "upi",
];
const BRAND_OPTIONS = BRAND_KEYS.map((k) => ({ value: k, label: paymentMarkLabel(k) }));

/**
 * One instrument type can be labelled differently per gateway (`bank_transfer` is
 * "Direct Debit (Bacs / BECS / PAD)" on Stripe and "Netbanking (eMandate)" on
 * RazorPay), so the filter needs one gateway-neutral name per VALUE. The values
 * themselves come from the gateway catalogue's `method_types` — built from each adapter's
 * capabilities — so a rail an adapter gains cannot be missing here.
 */
const PM_TYPE_LABELS: Record<string, string> = {
  card: "Card",
  upi: "UPI",
  us_bank_account: "Direct debit (ACH)",
  sepa_debit: "Direct debit (SEPA)",
  bank_transfer: "Bank debit (Bacs / BECS / PAD / eMandate)",
  paypal: "PayPal wallet",
  wallet: "Wallet",
  venmo: "Venmo",
  bacs_debit: "Direct debit (Bacs)",
  au_becs_debit: "Direct debit (BECS Australia)",
  nz_becs_debit: "Direct debit (BECS New Zealand)",
  acss_debit: "Pre-authorized debit (Canada)",
  autogiro: "Direct debit (Autogiro)",
  betalingsservice: "Direct debit (Betalingsservice)",
  payto: "PayTo",
};
const pmTypeOptions = (catalog: readonly GatewayCatalogEntry[]) =>
  [...new Set(catalog.flatMap((g) => g.method_types.map((m) => m.value)))]
    .sort()
    .map((v) => ({ value: v, label: PM_TYPE_LABELS[v] ?? v }));

/** Money log: every gateway attempt, one row, own detail page. */
export function TransactionsTable({
  page,
  biz,
  gatewayCatalog,
  rows,
  total,
  hasMore,
  nextCursor,
  initialFilters,
  livemode,
}: {
  /** The page header, drawn by the list (see ListPage.page). */
  page?: ListPageHeader;
  biz: string;
  /** `GET /v1/gateways` — the gateway filter's options. */
  gatewayCatalog: GatewayCatalogEntry[];
  /** First page, server-rendered — later pages stream in through fetchPage. */
  rows: Transaction[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** Deep-link filters from the URL (`?status=failure`) — see ListPage. */
  initialFilters?: ListServerFilter[];
  /** Stripe and PayPal put the mode in the deep link — see `gatewayObjectUrl`. */
  livemode: "live" | "test" | null;
}) {
  const fetchPage = React.useMemo(() => makeListSource<Transaction>("transactions", biz), [biz]);
  // Dates render in the business timezone, not UTC (see components/business-tz).
  const tz = useBusinessTz();
  const columns = React.useMemo<ColumnDef<Transaction>[]>(
    () => [
      {
        id: "id",
        header: "Transaction",
        accessorFn: (t) => t.id,
        cell: ({ row }) => (
          <Link
            href={`/businesses/${biz}/transactions/${row.original.id}`}
            className="font-mono text-xs text-primary hover:underline"
          >
            {row.original.id}
          </Link>
        ),
      },
      {
        id: "customer",
        header: "Customer",
        accessorFn: (t) => `${t.customer_name ?? ""} ${t.customer_email ?? ""}`.trim(),
        cell: ({ row }) => {
          const t = row.original;
          if (!t.customer) return <TextCell />;
          return (
            <CustomerInfoCell
              id={t.customer}
              name={t.customer_name}
              email={t.customer_email}
              href={`/businesses/${biz}/customers/${t.customer}`}
            />
          );
        },
      },
      {
        accessorKey: "type",
        header: "Type",
        cell: ({ row }) => (
          <span className="text-sm capitalize">{row.original.type.replace(/_/g, " ")}</span>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusChip status={row.original.status} />,
      },
      {
        id: "amount",
        header: "Amount",
        accessorFn: (t) => t.amount_minor,
        meta: {
          align: "right",
          exportAs: [
            moneyCell<Transaction>(
              "Amount",
              (r) => r.amount_minor,
              (r) => r.currency,
            ),
            { header: "Currency", value: (r) => r.currency ?? "" },
          ],
        },
        cell: ({ row }) => (
          <MoneyCell minor={row.original.amount_minor} currency={row.original.currency} />
        ),
      },
      {
        id: "payment_method",
        header: "Payment Method",
        accessorFn: (t) =>
          t.payment_method
            ? `${t.payment_method.brand ?? ""} ${t.payment_method.last4 ?? ""}`
            : t.method_type
              ? paymentMethodTypeLabel(t.method_type)
              : "",
        cell: ({ row }) => {
          const pm = row.original.payment_method;
          // No saved method (a one-off checkout): show what the gateway said paid.
          if (!pm)
            return (
              <TextCell>
                {row.original.method_type
                  ? paymentMethodTypeLabel(row.original.method_type)
                  : undefined}
              </TextCell>
            );
          return (
            <span className="flex items-center gap-1.5 text-sm">
              {/* The network's own mark, the same one the payer sees in the portal. A
                  generic card outline made a RuPay card, a UPI mandate and a bank debit
                  indistinguishable on the screen where someone triages a failed payment. */}
              {/* No `type` on a transaction's payment_method — brand carries it (a UPI
                  mandate reports brand 'upi'), and a last4 means a card regardless. */}
              <InstrumentMark brand={pm.brand} last4={pm.last4} className="h-3.5 w-6" />
              <span className="capitalize">{pm.brand ?? "Card"}</span>
              {pm.last4 ? <span className="text-muted-foreground">ending {pm.last4}</span> : null}
            </span>
          );
        },
      },
      {
        id: "gateway",
        header: "Gateway",
        accessorFn: (t) => t.gateway_key ?? "—",
        cell: ({ row }) =>
          row.original.gateway_key ? (
            <GatewayLabel gatewayKey={row.original.gateway_key} className="text-sm" />
          ) : (
            <span className="text-sm">—</span>
          ),
      },
      {
        /**
         * The provider's own id for the charge — how a row is found from a bank
         * statement. It LINKS to that charge on the gateway's dashboard where we have
         * a confirmed URL for the gateway and id shape, and is plain text otherwise
         * (see `gatewayObjectUrl`). Truncated with the full id in the tooltip: a Stripe
         * intent is 27 chars and a tmtest id 37, which would push Amount off-screen.
         */
        id: "id_at_gateway",
        header: "Gateway Charge Id",
        accessorFn: (t) => t.id_at_gateway ?? "",
        cell: ({ row }) => {
          const t = row.original;
          const href = gatewayObjectUrl(t.gateway_key, t.id_at_gateway, livemode);
          return (
            <IdCell id={t.id_at_gateway} width="w-36" {...(href ? { href, external: true } : {})} />
          );
        },
      },
      {
        id: "invoice",
        header: "Invoice",
        accessorFn: (t) => t.invoice ?? "—",
        cell: ({ row }) => (
          <IdCell
            id={row.original.invoice}
            href={`/businesses/${biz}/invoices/${row.original.invoice}`}
          />
        ),
      },
      // The failure reason gets its OWN column, e.g. "(BAD_REQUEST_ERROR) Currency
      // is not supported". We serialized both `error_code` and `error_text` and
      // rendered only the bare code as a subtitle under Status, so the actual reason
      // a payment failed — the single most useful field on this screen — was
      // invisible in the list.
      {
        id: "error",
        header: "Error",
        accessorFn: (t) => [t.error_code, t.error_text].filter(Boolean).join(" "),
        cell: ({ row }) => {
          const { error_code: code, error_text: text } = row.original;
          if (!code && !text) return <TextCell>{null}</TextCell>;
          // One line, cut at the column; the full "(code) message" is the tooltip.
          return (
            <TruncateCell
              value={[code ? `(${code})` : null, text].filter(Boolean).join(" ")}
              width="max-w-md"
              className="text-foreground"
            >
              {code ? <span className="text-muted-foreground">({code}) </span> : null}
              {text}
            </TruncateCell>
          );
        },
      },
      {
        accessorKey: "created_at",
        id: "created_at",
        header: "Created",
        cell: ({ row }) => <TextCell>{fmtDateTimeShort(row.original.created_at, tz)}</TextCell>,
      },
    ],
    // `tz` is deliberately absent, as it was: it comes from context and re-reads on
    // render. `livemode` is not — the gateway deep link is built from it.
    [biz, livemode],
  );

  const segments = React.useMemo<ListSegment<Transaction>[]>(
    () => [
      { id: "all", label: "All Transactions" },
      {
        id: "payments",
        label: "Payments",
        filters: [{ field: "type", op: "is", value: "payment" }],
      },
      // `type[contains]=refund` until now — and `type` is an ENUM column, whose operator
      // table has no `contains` (ENUM_OPS in src/platform/list-query.ts). The route
      // validates a segment's filters like any other, so this view answered 400 and
      // rendered as a failed load. `is` was all it ever needed: of the four types only
      // `refund` contained the word.
      { id: "refunds", label: "Refunds", filters: [{ field: "type", op: "is", value: "refund" }] },
      {
        id: "success",
        label: "Successful",
        filters: [{ field: "status", op: "is", value: "succeeded" }],
      },
      { id: "failed", label: "Failed", filters: [{ field: "status", op: "is", value: "failed" }] },
      {
        id: "needs_attention",
        label: "Needs Attention",
        filters: [{ field: "status", op: "is", value: "needs_attention" }],
      },
      // Recent failures, not all failures. A money log keeps every decline forever, so
      // the unqualified "Failed" view is mostly history — this is the one an operator
      // opens in the morning. `in_last` counts whole BUSINESS days (filterSql anchors the
      // window to `now() AT TIME ZONE tz`), so it agrees with the Created column.
      {
        id: "failed_recent",
        label: "Failed (last 7 days)",
        filters: [
          { field: "status", op: "is", value: "failed" },
          { field: "created_at", op: "in_last", value: "7" },
        ],
      },
      // Money not yet reconciled against a payout. `settled_at` is null for everything
      // still in flight, which is one filter instead of enumerating the four
      // non-terminal statuses — and it keeps working when a fifth is added.
      {
        id: "unsettled",
        label: "Unsettled",
        filters: [{ field: "settled_at", op: "is_present", value: "false" }],
      },
      // The declines dunning must stop retrying, straight off the gateway's own verdict.
      // Unset (not a failure, or a row predating the column) matches neither value, so
      // this view cannot quietly pick up successes.
      {
        id: "hard_declines",
        label: "Hard declines",
        filters: [{ field: "retriable", op: "is", value: "false" }],
      },
    ],
    [],
  );

  /**
   * Every column in the engine's `LIST_FILTERS` map (src/modules/transactions/service.ts),
   * each with that column's own operator table. A field offered here that the engine does
   * not know 400s on Apply, so this list is checked against that map and not against what
   * the response happens to print.
   *
   * `gateway_key` is deliberately absent: it is the SAME column as `gateway` under the
   * name the envelope prints, and two picker rows narrowing one column read as two
   * different gateway filters. `gateway` is the id the deep-link params and the SDK
   * already send, so it stays the one on screen — the engine still answers a saved view
   * or an API call that names `gateway_key`.
   */
  const filterFields = React.useMemo<ListFilterField<Transaction>[]>(
    () => [
      { id: "id", label: "Transaction Id", group: "Identity", serverOps: TEXT_OPS },
      {
        id: "id_at_gateway",
        label: "Gateway Charge Id",
        group: "Identity",
        serverOps: TEXT_OPS,
        hint: "The ID of the charge at the provider. Use it to find a row from a bank statement or the gateway dashboard.",
        keywords: "charge reference provider",
      },
      {
        id: "trace_id",
        label: "Trace Id",
        group: "Identity",
        serverOps: TEXT_OPS,
        hint: "The run that made this attempt. The gateway request log and the events from the same run show the same ID.",
        keywords: "correlation run request log",
      },
      { id: "invoice", label: "Invoice Id", group: "Identity", serverOps: TEXT_OPS },
      { id: "subscription", label: "Subscription Id", group: "Identity", serverOps: TEXT_OPS },
      {
        id: "credit_note",
        label: "Credit Note Id",
        group: "Identity",
        serverOps: TEXT_OPS,
        hint: "The credit note that the refund is for.",
      },
      {
        id: "reference_payment",
        label: "Reference Payment Id",
        group: "Identity",
        serverOps: TEXT_OPS,
        hint: "The payment that a refund or reversal reverses.",
      },
      {
        id: "payment_intent",
        label: "Payment Intent Id",
        group: "Identity",
        serverOps: TEXT_OPS,
        hint: "The 3DS intent (pi_…) for this attempt. Most renewals do not have one.",
        keywords: "3ds authentication pi",
      },

      {
        id: "type",
        label: "Type",
        type: "select",
        group: "Status",
        options: TYPE_OPTIONS,
        serverOps: ENUM_OPS,
      },
      {
        id: "status",
        label: "Status",
        type: "select",
        group: "Status",
        options: STATUS_OPTIONS,
        serverOps: ENUM_OPS,
      },
      {
        id: "retriable",
        label: "Retriable",
        type: "boolean",
        group: "Status",
        serverOps: BOOL_OPS,
        hint: "The retry verdict from the gateway. It is empty on rows that are not failures. Those rows match neither Yes nor No.",
        keywords: "hard decline dunning retry",
      },
      { id: "error_code", label: "Error Code", group: "Status", serverOps: TEXT_OPS },
      {
        id: "error_text",
        label: "Error Message",
        group: "Status",
        serverOps: TEXT_OPS,
        hint: "Gateways use one code for many types of refusal. The message text tells them apart.",
        keywords: "decline reason failure",
      },

      { id: "customer", label: "Customer Id", group: "Customer", serverOps: TEXT_OPS },
      {
        id: "customer_name",
        label: "Customer Name",
        group: "Customer",
        serverOps: TEXT_OPS,
        hint: "Matches the name that this log shows. This is the company name, or the first and last name.",
        keywords: "company holder",
      },
      { id: "customer_email", label: "Customer Email", group: "Customer", serverOps: TEXT_OPS },

      // `number`, not `money`: this log holds every currency the business charges in, and
      // a major-unit box needs ONE exponent to be honest — ₹12.99 and ¥1299 are both 1299
      // minor. So the operator types minor units, and the label and hint say so.
      {
        id: "amount_minor",
        label: "Amount (minor units)",
        type: "number",
        group: "Amounts",
        serverOps: NUM_OPS,
        hint: "Integer minor units. For example, 129900 is ₹1,299.00. This log has many currencies, so it uses minor units and not decimal amounts.",
        keywords: "value total",
      },
      // Free text rather than a picker: the set of currencies is whatever the business
      // prices in, and a menu built from one loaded page hides the rest. SQL matches
      // case-insensitively, and "is one of" takes a comma-separated list.
      {
        id: "currency",
        label: "Currency",
        group: "Amounts",
        serverOps: ENUM_OPS,
        hint: "ISO 4217 code, for example INR.",
      },

      { id: "created_at", label: "Created", type: "date", group: "Dates", serverOps: DATE_OPS },
      // When the money moved, vs `created_at` = when we wrote the row. On an imported book
      // every migrated transaction shares one `created_at`, so this is the only date that
      // answers "what settled on the 9th" — and it is the column Business Home's revenue
      // figures are summed over.
      { id: "occurred_at", label: "Occurred", type: "date", group: "Dates", serverOps: DATE_OPS },
      {
        id: "settled_at",
        label: "Settled",
        type: "date",
        group: "Dates",
        serverOps: DATE_OPS,
        hint: 'Empty while the money is still in transit. Use "is empty" to see the unsettled transactions.',
        keywords: "payout reconciliation",
      },
      {
        id: "updated_at",
        label: "Last Updated",
        type: "date",
        group: "Dates",
        serverOps: DATE_OPS,
        hint: "The only date that shows a LATE status change. For example, a webhook that arrived days after the attempt, or a reconcile by an operator.",
        keywords: "modified reconcile late failure",
      },

      {
        id: "gateway",
        label: "Gateway",
        type: "select",
        group: "Gateway",
        options: gatewayFilterOptions(gatewayCatalog),
        serverOps: ENUM_OPS,
        keywords: "gateway_key provider",
      },
      {
        id: "gateway_account",
        label: "Gateway Account Id",
        group: "Gateway",
        serverOps: TEXT_OPS,
        hint: "The account at that provider (gwa_…). A business can have several accounts. You reconcile each account separately.",
        keywords: "gwa merchant account",
      },

      // Gateways spell the same network several ways; `is` lowercases both sides, so
      // casing is handled. One that punctuates it differently ("master_card") is still
      // reachable through "is one of".
      {
        id: "payment_method_brand",
        label: "Card Brand",
        type: "select",
        group: "Payment method",
        options: BRAND_OPTIONS,
        serverOps: ENUM_OPS,
        keywords: "network visa mastercard",
      },
      {
        id: "payment_method_last4",
        label: "Card Last 4",
        group: "Payment method",
        serverOps: TEXT_OPS,
      },
      {
        id: "payment_method_type",
        label: "Instrument Type",
        type: "select",
        group: "Payment method",
        options: pmTypeOptions(gatewayCatalog),
        serverOps: ENUM_OPS,
        hint: "The only field that tells a card decline from a UPI mandate failure. They have the same status and code, but need different handling.",
        keywords: "rail method upi mandate",
      },
    ],
    [gatewayCatalog],
  );

  return (
    <ListPage
      page={page}
      entity={{ singular: "Transaction", plural: "Transactions" }}
      columns={columns}
      data={rows}
      server={{ total, hasMore, nextCursor, fetchPage }}
      segments={segments}
      filterFields={filterFields}
      savedViews={{ entity: "transactions", biz }}
      initialFilters={initialFilters}
      sortOptions={[
        { id: "created_at", label: "Created" },
        { id: "amount_minor", label: "Amount" },
        { id: "status", label: "Status" },
      ]}
      searchPlaceholder="Search for ID / customer / gateway / invoice…"
      exportName="transactions"
      persistKey={`transactions:${biz}`}
      rowHref={(t) => `/businesses/${biz}/transactions/${t.id}`}
      emptyState={
        <EmptyState
          icon={<ArrowLeftRight />}
          title="No transactions"
          description="No transactions match this view, filter or search."
        />
      }
    />
  );
}
