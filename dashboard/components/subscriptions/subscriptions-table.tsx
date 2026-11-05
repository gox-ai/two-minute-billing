"use client";

import { PaletteSearchHint } from "@/components/palette-hints";
import { gatewayFilterOptions, type GatewayCatalogEntry } from "@/components/gateways/gateway-meta";
import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ListPage,
  createAction,
  importAction,
  type ListFilterField,
  type ListSegment,
  type ListServerFilter,
  type ListPageHeader,
} from "@/components/patterns/list-page";
import { makeListSource } from "@/lib/list-source";
import {
  IdCell,
  InfoCell,
  MoneyCell,
  TextCell,
  TruncateCell,
} from "@/components/patterns/list-cells";
import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";
import { AddonPeek } from "@/components/subscriptions/subscription-peek";
import { addonItems, planItem, planLabel } from "@/lib/subscription-plan";
import { EmptyState } from "@/components/states";
import { SubscriptionRowMenu } from "@/components/subscriptions/subscription-row-menu";
import { fmtDate, fmtDateShort, fmtDateTimeShort, money } from "@/lib/format";
import { CreditCard } from "lucide-react";
import type { Subscription } from "@/lib/api";
import type { CustomFieldDefinition } from "@/lib/api/custom-fields";
import { customFieldFilterFields } from "@/lib/custom-field-filters";
import { CURRENCY_FILTER_HINT, PAYMENT_METHOD_TYPE_OPTIONS } from "@/lib/filter-options";
import { moneyCell } from "@/lib/table-export";

/**
 * The engine's operator vocabulary per column kind, mirrored from
 * `src/platform/list-query.ts` — which is what `SUBSCRIPTION_FILTER_OPS` is derived from.
 *
 * The two lists these replace lagged a whole widening behind the engine: three date
 * operators were offered where nine exist, so `between`, `in_last` and `in_next` were
 * unreachable from the UI on every date column, and every text column was missing
 * `not_contains`, `ends_with`, `in` and `not_in`. An operator we don't offer is a question
 * answered by exporting to a spreadsheet.
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
const NUMBER_OPS = ["is", "is_not", "gt", "gte", "lt", "lte", "between", "is_present"];
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
 * `plan` and `addon` are EXISTS-backed VIRTUAL fields (PLAN_FIELD / ADDON_FIELD in
 * subscriptions/service.ts), not columns: each compares an item's product id or name, and
 * the engine deliberately gives them a narrower set than a real text column.
 */
const ITEM_OPS = ["is", "contains", "starts_with"];
const LIVE = ["active", "in_trial"];

/**
 * When this customer is next charged — blank when nothing is coming.
 *
 * `current_period_end` cannot answer this: it is deliberately `null` for the whole
 * trial (see `src/modules/subscriptions/serialize.ts`), so reading
 * it made every `in_trial` row render "—" in the column that exists to say when the
 * trial converts. `next_billing_at` is populated across every status and is exactly
 * the field for this column, so it leads; `current_period_end` stays as the fallback
 * for a payload that predates it.
 *
 * A subscription that is NOT renewing (cancelled/paused, or scheduled to cancel at
 * term end) still renders blank — there is no next charge to name.
 */
function nextBillingAt(s: Subscription): string | null {
  const renews = LIVE.includes(s.status) && !s.cancel_at_period_end;
  if (!renews) return null;
  return s.next_billing_at ?? s.current_period_end ?? null;
}

/**
 * The stored figure, trusted as-is. An `in_trial` row renders `0.00` because the engine
 * now STORES 0 for a trial (a trial has not started generating
 * recurring revenue; see `recomputeSubscriptionMrr` in the subscriptions module), so the
 * cell, the API, the `mrr` filter and the MRR sort all read one number. This used to
 * coerce `in_trial` to 0 here, which fixed only the cell: the filter and the sort run in
 * SQL against `subscriptions.mrr`, so `mrr > 0` still returned rows this column showed as
 * 0.00 (the bug, closed 2026-08-03).
 *
 * Blank (not 0) for anything that is not live — a cancelled subscription contributes no
 * MRR and naming a figure there would invite summing it.
 */
/**
 * The MRR cell shows the STORED figure for every status, because that column is what
 * this list's `mrr` filter and sort run against in SQL.
 *
 * It used to blank anything outside `LIVE` (active / in_trial), which made the column
 * disagree with its own controls: `mrr[gt]=0` returned `paused` and `non_renewing` rows
 * that then rendered as `—`. The engine now zeroes the column for the statuses that earn
 * nothing (in_trial, paused, cancelled — `recomputeSubscriptionMrr`), so displaying it
 * verbatim is both honest and self-consistent: a `non_renewing` subscription shows the
 * rate it is still earning until term end, and a paused one shows 0 because that is what
 * it now contributes. Blank only when the column is genuinely null.
 */
function mrrOf(s: Subscription): number | null {
  return s.mrr ?? null;
}

/** Currencies of the MRR figures a page shows (cancelled rows render a dash). */
function mrrCurrencySet(rows: Subscription[]): Set<string> {
  return new Set(
    rows.filter((s) => s.status !== "cancelled" && mrrOf(s) != null).map((s) => s.currency),
  );
}

/** Distinct, sorted select options from the loaded rows. */
function options(values: (string | null | undefined)[]): { value: string; label: string }[] {
  return [...new Set(values.filter((v): v is string => !!v))]
    .sort()
    .map((v) => ({ value: v, label: v }));
}

/** `3 months`, from the subscription's own cadence. */
function billingPeriodText(s: Subscription): string {
  const n = s.billing_period;
  const unit = s.billing_period_unit;
  if (!n || !unit) return "";
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Columns an operator can add from the Columns menu: [id, header, value]. */
const OPTIONAL_TEXT_COLUMNS: Array<[string, string, (s: Subscription) => string]> = [
  ["subscription_id", "Subscription ID", (s) => s.id],
  ["customer_email", "Customer Email", (s) => s.customer_email ?? ""],
  ["plan_price", "Plan Price ID", (s) => planItem(s)?.price ?? ""],
  ["plan_quantity", "Plan Quantity", (s) => String(planItem(s)?.quantity ?? "")],
  ["currency", "Currency", (s) => s.currency],
  ["billing_period", "Billing Period", billingPeriodText],
  [
    "remaining_billing_cycles",
    "Remaining Billing Cycles",
    (s) => String(s.remaining_billing_cycles ?? ""),
  ],
  // Both are overrides; empty means the customer's setting applies.
  [
    "auto_collection",
    "Auto Collection",
    (s) => (s.auto_collection ? (s.auto_collection === "off" ? "Off" : "On") : "Customer setting"),
  ],
  [
    "net_term_days",
    "Net Terms",
    (s) => (s.net_term_days ? `${s.net_term_days} days` : "Customer setting"),
  ],
  ["po_number", "PO Number", (s) => s.po_number ?? ""],
  ["invoice_notes", "Invoice Notes", (s) => s.invoice_notes ?? ""],
  ["cancel_reason", "Cancellation Reason", (s) => s.cancel_reason ?? ""],
];

/** Optional date columns: [id, header, ISO value]. */
const OPTIONAL_DATE_COLUMNS: Array<
  [string, string, (s: Subscription) => string | null | undefined]
> = [
  ["start_date", "Start Date", (s) => s.start_date],
  ["started_at", "Started At", (s) => s.started_at],
  ["activated_at", "Activated At", (s) => s.activated_at],
  ["trial_start", "Trial Start", (s) => s.trial_start],
  ["trial_end", "Trial End", (s) => s.trial_end],
  ["current_period_start", "Current Term Start", (s) => s.current_period_start],
  ["current_term_end", "Current Term End", (s) => s.current_period_end],
  // Also a pending cancellation's date, so it can be in the future.
  ["canceled_at", "Cancellation Date", (s) => s.canceled_at],
  ["updated_at", "Updated At", (s) => s.updated_at],
];

/** The ids of every optional column, so they start hidden. */
const OPTIONAL_COLUMN_IDS = [
  "status",
  "recurring_amount",
  ...OPTIONAL_TEXT_COLUMNS.map(([id]) => id),
  ...OPTIONAL_DATE_COLUMNS.map(([id]) => id),
];

/** A custom field's value as the record page shows it. Keyed by `api_name`. */
function customFieldText(
  def: CustomFieldDefinition,
  s: Subscription,
  tz: string | null | undefined,
): string {
  const v = s.custom_fields?.[def.api_name];
  if (v === undefined || v === null || v === "") return "";
  if (def.data_type === "boolean") return v ? "Yes" : "No";
  if (def.data_type === "date") return fmtDate(String(v), tz);
  return String(v);
}

/**
 * Subscriptions list on the shared `ListPage` chrome.
 *
 * `tz` is the business's IANA timezone — dates render in it, not UTC, because the
 * engine's term boundaries are midnight in that zone.
 */
/**
 * The instrument group, shared in SHAPE with the customers list so an operator who
 * learns "Card Type" on one finds it on the other. Ids are keys of `VIRTUAL_FILTERS`
 * in `src/modules/subscriptions/service.ts`; that file is the authority.
 */
const paymentMethodFields = (gatewayCatalog: readonly GatewayCatalogEntry[]) => [
  {
    id: "payment_method_type",
    label: "Payer Payment Method Type",
    type: "select" as const,
    group: "Payment",
    options: PAYMENT_METHOD_TYPE_OPTIONS,
    serverOps: ENUM_OPS,
    hint: "Any instrument the payer holds. Use is empty to find payers with no instrument",
  },
  {
    id: "payment_method_status",
    label: "Payer Payment Method Status",
    type: "text" as const,
    group: "Payment",
    serverOps: ENUM_OPS,
    keywords: "valid expiring expired invalid",
  },
  {
    id: "payment_method_role",
    label: "Payer Payment Method Role",
    type: "select" as const,
    group: "Payment",
    options: [
      { value: "primary", label: "Primary" },
      { value: "backup", label: "Backup" },
    ],
    serverOps: ENUM_OPS,
  },
  {
    id: "payment_method_gateway",
    label: "Payer Gateway",
    type: "select" as const,
    group: "Payment",
    // Closed: the gateways this engine has (`GET /v1/gateways`). A value outside it can
    // never match a stored `provider_key`.
    options: gatewayFilterOptions(gatewayCatalog),
    serverOps: ENUM_OPS,
  },
  {
    id: "payment_method_gateway_account",
    label: "Payer Gateway Account",
    type: "text" as const,
    group: "Payment",
    serverOps: ENUM_OPS,
    hint: "The gateway account's public id (gwa_…)",
  },
  {
    id: "payment_method_id",
    label: "Payer Payment Method Id",
    type: "text" as const,
    group: "Payment",
    serverOps: ENUM_OPS,
  },
  {
    id: "payment_method_brand",
    label: "Payer Card Type",
    type: "text" as const,
    group: "Payment",
    serverOps: ENUM_OPS,
    keywords: "visa mastercard rupay amex brand network",
  },
  {
    id: "payment_method_last4",
    label: "Payer Card/Account Last 4",
    type: "text" as const,
    group: "Payment",
    serverOps: ENUM_OPS,
  },
  {
    id: "payment_method_exp_month",
    label: "Payer Month of Expiry",
    type: "text" as const,
    group: "Payment",
    serverOps: ENUM_OPS,
    // Equality and set membership only — the EXISTS compares text, so a range would
    // sort "9" after "10". See the engine note.
    hint: "Exact month, e.g. 09",
  },
  {
    id: "payment_method_exp_year",
    label: "Payer Year of Expiry",
    type: "text" as const,
    group: "Payment",
    serverOps: ENUM_OPS,
    hint: "Exact year, e.g. 2027",
  },
  {
    id: "payment_method_issuer_country",
    label: "Payer Issuing Country",
    type: "text" as const,
    group: "Payment",
    serverOps: ENUM_OPS,
  },
  {
    id: "payment_method_sub_type",
    label: "Payer Bank Account Type",
    type: "text" as const,
    group: "Payment",
    serverOps: ENUM_OPS,
    keywords: "savings current checking",
  },
];

export function SubscriptionsTable({
  page,
  biz,
  rows,
  tz,
  total,
  hasMore,
  nextCursor,
  initialFilters,
  customFields,
  gatewayCatalog,
}: {
  /** The page header, drawn by the list (see ListPage.page). */
  page?: ListPageHeader;
  biz: string;
  /** `GET /v1/gateways` — the payer-gateway filter's options. */
  gatewayCatalog: GatewayCatalogEntry[];
  /** First page, server-rendered — later pages stream in through fetchPage. */
  rows: Subscription[];
  tz?: string | null;
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** Deep-link filters, e.g. Business Home's plan mix. See ListPage.initialFilters. */
  initialFilters?: ListServerFilter[];
  /**
   * This business's subscription custom-field definitions, archived included, fetched by
   * the page. They are admin-defined and per-business, so they cannot be declared in
   * `filterFields` below — the engine is the only thing that knows they exist.
   */
  customFields: CustomFieldDefinition[];
}) {
  // Currencies of the MRR figures loaded so far: one → the code moves to the header.
  const [mrr, setMrr] = React.useState(() => ({ rows, currencies: mrrCurrencySet(rows) }));
  if (mrr.rows !== rows) setMrr({ rows, currencies: mrrCurrencySet(rows) });
  const fetchPage = React.useMemo(
    () =>
      makeListSource<Subscription>("subscriptions", biz, {
        onPayload: (payload, isFirstPage) => {
          const next = mrrCurrencySet(payload.data);
          setMrr((prev) => ({
            rows: prev.rows,
            currencies: isFirstPage ? next : new Set([...prev.currencies, ...next]),
          }));
        },
      }),
    [biz],
  );
  const mrrCurrency = mrr.currencies.size === 1 ? [...mrr.currencies][0] : null;
  const columns = React.useMemo<ColumnDef<Subscription>[]>(
    () => [
      {
        id: "subscription",
        header: "Subscription Info",
        accessorFn: (s) => `${planLabel(s)} ${s.id}`,
        meta: {
          exportAs: [
            { header: "Subscription ID", value: (s) => s.id },
            // A plan-less subscription's label is its id: no plan to name.
            { header: "Plan", value: (s) => (planLabel(s) === s.id ? "" : planLabel(s)) },
            {
              header: "Add-ons",
              value: (s) =>
                addonItems(s)
                  .map((i) => i.product_name)
                  .join("; "),
            },
          ],
        },
        cell: ({ row }) => {
          const s = row.original;
          const addons = addonItems(s);
          const label = planLabel(s);
          // A plan-less subscription's label IS its id: show it once, in mono.
          const labelIsId = label === s.id;
          return (
            <InfoCell
              status={s.status}
              // Free text, so bounded — wrapped at 320px rather than cut off.
              title={
                <span className={cn("block max-w-80 wrap-anywhere", labelIsId && "font-mono")}>
                  {label}
                </span>
              }
              href={`/businesses/${biz}/subscriptions/${s.id}`}
              // The addon count rides the id line: on the title line it stacked behind
              // the status chip and the plan name and was what pushed this column past
              // the pane, while line 2 had ~200px of slack. Same information, no cost.
              sub={
                labelIsId && addons.length === 0 ? undefined : (
                  <span className="flex items-center gap-2">
                    {labelIsId ? null : (
                      <span
                        className="block max-w-64 truncate font-mono text-xs text-muted-foreground"
                        title={s.id}
                      >
                        {s.id}
                      </span>
                    )}
                    <AddonPeek items={addons} currency={s.currency} />
                  </span>
                )
              }
              // Dropped: an Info glyph whose only behaviour was a
              // `title="Subscription ID: …"` tooltip repeating the mono id rendered
              // directly beneath it. It read as interactive (`cursor-pointer`, accent
              // hover) and did nothing on click — a control that does nothing
              // (CLAUDE.md rule 0) restating context already on screen. If a real
              // quick-view popover is ever built, it comes back as a real control.
            />
          );
        },
      },
      {
        id: "customer",
        header: "Customer Info",
        accessorFn: (s) => s.customer_name || s.customer_email || s.customer || "",
        meta: {
          exportAs: [
            { header: "Customer Name", value: (s) => s.customer_name ?? "" },
            { header: "Customer Email", value: (s) => s.customer_email ?? "" },
          ],
        },
        cell: ({ row }) => {
          const s = row.original;
          if (!s.customer) return <TextCell />;
          const name = s.customer_name || s.customer_email || s.customer;
          const nameIsId = name === s.customer;
          // Order: name · company · email · phone; `name` already consumed whichever
          // stood in for it, so it is not repeated below.
          const secondary = [s.customer_company, s.customer_email, s.customer_phone].filter(
            (v): v is string => !!v && v !== name,
          );
          // Same as the customers list: wrapped at 320px, never cut off.
          const line = "block max-w-80 wrap-anywhere text-xs text-muted-foreground";
          return (
            <InfoCell
              title={
                <span className={cn("block max-w-80 wrap-anywhere", nameIsId && "font-mono")}>
                  {name}
                </span>
              }
              href={`/businesses/${biz}/customers/${s.customer}`}
              sub={
                secondary.length > 0 ? (
                  <>
                    {secondary.map((v) => (
                      <span key={v} className={line}>
                        {v}
                      </span>
                    ))}
                  </>
                ) : nameIsId ? undefined : (
                  // Nothing else identifies the row: show the id under the name.
                  <span className={cn(line, "font-mono")}>{s.customer}</span>
                )
              }
            />
          );
        },
      },
      {
        id: "customer_id",
        header: "Customer ID",
        accessorFn: (s) => s.customer || "",
        cell: ({ row }) => (
          <IdCell
            id={row.original.customer}
            href={`/businesses/${biz}/customers/${row.original.customer}`}
            width="max-w-32"
          />
        ),
      },
      {
        // Id stays `current_period_end`: it is the server's sort/filter key for this
        // column (LIST_SORTS/LIST_FILTERS in subscriptions/service.ts), and the engine
        // column behind it IS the next-billing instant — only the API serializer masks
        // it during a trial. The accessor resolves what the cell shows so the CSV
        // export and the client sort agree with the screen.
        id: "current_period_end",
        accessorFn: (s) => nextBillingAt(s) ?? "",
        header: "Next Billing At",
        cell: ({ row }) => {
          const at = nextBillingAt(row.original);
          return <TextCell>{at ? fmtDateShort(at, tz) : null}</TextCell>;
        },
      },
      {
        id: "mrr",
        accessorFn: (s) => mrrOf(s) ?? "",
        header: mrrCurrency ? `MRR (${mrrCurrency})` : "MRR",
        meta: {
          align: "right",
          exportAs: [
            // Blank for a cancelled subscription, as on screen.
            moneyCell<Subscription>(
              "MRR",
              (s) => (s.status === "cancelled" ? null : mrrOf(s)),
              (s) => s.currency,
            ),
            { header: "Currency", value: (s) => s.currency ?? "" },
          ],
        },
        cell: ({ row }) => {
          const s = row.original;
          const m = mrrOf(s);
          // A cancelled subscription bills nothing: a dash, not "$0.00".
          if (s.status === "cancelled" || m == null) return <TextCell />;
          if (mrrCurrency)
            return <span className="text-sm font-medium tabular-nums">{money(m, s.currency)}</span>;
          return <MoneyCell minor={m} currency={s.currency} />;
        },
      },
      {
        accessorKey: "created_at",
        id: "created_at",
        header: "Created At",
        cell: ({ row }) => (
          <TextCell>
            {row.original.created_at ? fmtDateTimeShort(row.original.created_at, tz) : null}
          </TextCell>
        ),
      },
      // ── Optional columns, hidden until picked in the Columns menu ──────────────
      // Not sortable: the list sorts on the server, by the fields in "Sort by".
      // No coupon or payment method column: the list endpoint returns neither.
      {
        id: "status",
        header: "Status",
        enableSorting: false,
        accessorFn: (s) => s.status,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: "recurring_amount",
        header: "Recurring Amount",
        enableSorting: false,
        meta: {
          align: "right",
          exportAs: [
            moneyCell<Subscription>(
              "Recurring Amount",
              (s) => s.recurring_amount_minor,
              (s) => s.currency,
            ),
          ],
        },
        accessorFn: (s) => s.recurring_amount_minor ?? "",
        cell: ({ row }) => (
          <MoneyCell minor={row.original.recurring_amount_minor} currency={row.original.currency} />
        ),
      },
      ...OPTIONAL_TEXT_COLUMNS.map(([id, header, value]): ColumnDef<Subscription> => ({
        id,
        header,
        enableSorting: false,
        accessorFn: (s) => value(s),
        cell: ({ row }) => <TruncateCell value={value(row.original)} />,
      })),
      ...OPTIONAL_DATE_COLUMNS.map(([id, header, value]): ColumnDef<Subscription> => ({
        id,
        header,
        enableSorting: false,
        accessorFn: (s) => value(s) ?? "",
        cell: ({ row }) => {
          const at = value(row.original);
          return <TextCell>{at ? fmtDateShort(at, tz) : null}</TextCell>;
        },
      })),
      // One column per active custom field; an archived one is filterable but not shown.
      ...customFields
        .filter((d) => !d.archived)
        .map((d): ColumnDef<Subscription> => ({
          id: `cf:${d.api_name}`,
          header: d.label,
          enableSorting: false,
          accessorFn: (s) => customFieldText(d, s, tz),
          cell: ({ row }) => <TruncateCell value={customFieldText(d, row.original, tz)} />,
        })),
    ],
    [biz, tz, mrrCurrency, customFields],
  );

  const segments = React.useMemo<ListSegment<Subscription>[]>(
    () => [
      { id: "all", label: "All Subscriptions" },
      // Every status segment now filters the API-LEVEL status — the value the row's pill
      // shows — because the engine's `status` filter compares `apiStatusSql` rather than the
      // stored column. So "Active" here means genuinely renewing: a subscription with a
      // cancellation committed to reports `non_renewing` and is deliberately not in it.
      { id: "active", label: "Active", filters: [{ field: "status", op: "is", value: "active" }] },
      {
        id: "in_trial",
        label: "In Trial",
        filters: [{ field: "status", op: "is", value: "in_trial" }],
      },
      {
        id: "non_renewing",
        label: "Non-renewing",
        // Was `cancel_at_period_end is true` AND `status is active`, which under the new
        // semantics matches NOTHING: the very flag that makes a row non-renewing is what
        // stops it reporting `active`. It also under-reported before that, because a
        // `specific_date` cancel and a spent `remaining_billing_cycles` set no flag at all —
        // one filter on the derived status covers all three routes into the state.
        filters: [{ field: "status", op: "is", value: "non_renewing" }],
      },
      { id: "paused", label: "Paused", filters: [{ field: "status", op: "is", value: "paused" }] },
      {
        id: "cancelled",
        label: "Cancelled",
        filters: [{ field: "status", op: "is", value: "cancelled" }],
      },
      // A future-dated create sits in `future` until its start date and had no segment at
      // all — the one status an operator most wants to sanity-check after an import was
      // reachable only by building the filter by hand.
      { id: "future", label: "Future", filters: [{ field: "status", op: "is", value: "future" }] },
      {
        id: "renewing_soon",
        label: "Renewing In 7 Days",
        // `next_billing_at` is the only date that answers "who is charged next" across every
        // status — `current_period_end` is null for the whole trial. The status filter is
        // what makes this RENEWALS rather than renewals-plus-trial-conversions-plus-starts,
        // all three of which populate that column.
        filters: [
          { field: "status", op: "is", value: "active" },
          { field: "next_billing_at", op: "in_next", value: "7" },
        ],
      },
      {
        id: "trials_ending",
        label: "Trials Ending In 7 Days",
        filters: [
          { field: "status", op: "is", value: "in_trial" },
          { field: "trial_end", op: "in_next", value: "7" },
        ],
      },
      {
        id: "cancelling_soon",
        label: "Cancelling In 30 Days",
        // `canceled_at` is a three-way coalesce at the API edge (serialize.ts) that resolves
        // to a PENDING `specific_date` cancel, or to the term end a non-renewing subscription
        // will cancel on — so the forward window alone is the segment. No status filter on
        // purpose: a `specific_date` cancel on a TRIALLING subscription still reports
        // `in_trial`, and pinning this to `non_renewing` would drop exactly those rows.
        // A 30-day window rather than "this month" because the relative operators count days:
        // a calendar-month segment would mean 30 days on the 1st and one day on the 31st.
        filters: [{ field: "canceled_at", op: "in_next", value: "30" }],
      },
    ],
    [],
  );

  /**
   * Every filterable field the engine exposes for this list — the map in `listFilters()`
   * (subscriptions/service.ts) plus its two virtual item fields, grouped for the picker.
   * This offered 12 of 38, so two thirds of the vocabulary the engine validates and
   * indexes for was reachable only by hand-editing the URL.
   *
   * Nothing here is offered speculatively: each id is a key of that map and each
   * `serverOps` is its kind's list verbatim, so no row the builder can produce 400s.
   */
  const filterFields = React.useMemo<ListFilterField<Subscription>[]>(
    () => [
      { id: "id", label: "Subscription Id", group: "Identity", serverOps: TEXT_OPS },

      {
        id: "status",
        label: "Status",
        type: "select",
        group: "Status",
        // FIXED, not derived from `rows`: the vocabulary is closed (`ApiSubscriptionStatus`,
        // serialize.ts) and a page-derived list silently omitted every status absent from the
        // first page — a book with no paused subscription on page 1 offered no way to ask for
        // one. `non_renewing` exists only at the API boundary, and the engine's filter now
        // compares that same derived value, so it belongs in the list.
        options: [
          { value: "future", label: "Future" },
          { value: "in_trial", label: "In Trial" },
          { value: "active", label: "Active" },
          { value: "non_renewing", label: "Non-renewing" },
          { value: "paused", label: "Paused" },
          { value: "cancelled", label: "Cancelled" },
        ],
        serverOps: ENUM_OPS,
      },
      {
        id: "cancel_at_period_end",
        label: "Cancel At Term End",
        type: "boolean",
        group: "Status",
        // Relabelled from "Non-renewing": that is now a STATUS value, and this flag is only
        // one of the three things that produce it (a `specific_date` cancel and a spent
        // `remaining_billing_cycles` do too). Asking for the non-renewing book through this
        // flag under-reports it, so the hint sends the operator to the status instead.
        hint: "End-of-term cancellations only. To find all non-renewing subscriptions, use Status is Non-renewing.",
        keywords: "non-renewing non renewing cancel churn",
        serverOps: BOOL_OPS,
      },
      {
        id: "cancel_reason",
        label: "Cancellation Reason",
        group: "Status",
        // Free text rather than a fixed pick-list, despite the column being `kind: 'enum'`
        // (which fixes the OPERATORS, not the values). Two vocabularies land in it: the system
        // reasons the engine writes, and the merchant reason LABEL the cancel dialog posts
        // (`lifecycle-dialogs.tsx` sends `cancel_reason=<label>`, and the route accepts any
        // string up to 200 chars). A closed pick-list would have made every
        // merchant-cancelled subscription unaskable.
        hint: "System reasons: not_paid, no_card, trial_ended. A merchant cancellation stores its reason label.",
        serverOps: ENUM_OPS,
      },
      {
        id: "cancel_reason_code",
        label: "Cancellation Reason Code",
        group: "Status",
        serverOps: TEXT_OPS,
      },

      { id: "customer", label: "Customer Id", group: "Customer", serverOps: TEXT_OPS },
      {
        id: "customer_name",
        label: "Customer Name",
        group: "Customer",
        // Compares the RESOLVED account-holder name the row renders, not `customers.name` —
        // against the bare column a first/last-name customer returned an empty page.
        serverOps: TEXT_OPS,
      },
      { id: "customer_email", label: "Customer Email", group: "Customer", serverOps: TEXT_OPS },
      { id: "customer_company", label: "Customer Company", group: "Customer", serverOps: TEXT_OPS },
      { id: "customer_phone", label: "Customer Phone", group: "Customer", serverOps: TEXT_OPS },

      { id: "plan", label: "Plan", group: "Plan & items", serverOps: ITEM_OPS },
      {
        id: "addon",
        label: "Addon",
        group: "Plan & items",
        // `is_present` is on the add-on field alone, where it reads "has any add-on at all".
        // The plan field has no use for it: every subscription has at least one item.
        serverOps: [...ITEM_OPS, "is_present"],
      },
      {
        id: "plan_quantity",
        label: "Plan Quantity",
        type: "number",
        group: "Plan & items",
        // Scoped to the PLAN item in SQL, so an add-on quantity can never answer for it.
        serverOps: NUMBER_OPS,
      },
      {
        id: "coupon",
        label: "Coupon",
        group: "Plan & items",
        // The active discount's coupon CODE, or null. A manual discount carries no coupon, so
        // "is not empty" here means discounted by a coupon — not discounted.
        hint: "Code of the active coupon. A manual discount carries none.",
        serverOps: TEXT_OPS,
      },

      {
        id: "mrr",
        label: "MRR",
        type: "number",
        group: "Amounts",
        // Deliberately NOT `money`. That type shifts one fixed exponent, and this list is not
        // single-currency — the Currency filter below it exists because it is not. A JPY row
        // is exponent 0 and an INR row is 2, so any single shift would mis-scale one of them
        // and the filter would quietly answer a different question than the one typed.
        // `number` plus this hint is the honest pair (see the `money` note in patterns/list-filters).
        hint: "Integer minor units. For example, 129900 is 1,299.00 in a two-decimal currency",
        serverOps: NUMBER_OPS,
      },
      {
        id: "currency",
        label: "Currency",
        type: "text",
        group: "Amounts",
        // Derived, unlike Status: the vocabulary is open (any ISO code a business prices in),
        // so there is no closed list to state — and this component is handed only the loaded
        // page, hence the hint rather than a promise of completeness.

        hint: "Codes seen on the loaded rows.",
        serverOps: ENUM_OPS,
      },

      {
        id: "billing_period",
        label: "Billing Period",
        type: "number",
        group: "Billing",
        hint: "The count only. 3 with unit Month is quarterly.",
        serverOps: NUMBER_OPS,
      },
      {
        id: "billing_period_unit",
        label: "Billing Period Unit",
        type: "select",
        group: "Billing",
        // Closed set (db/schema/subscriptions.ts), stated rather than derived.
        options: [
          { value: "day", label: "Day" },
          { value: "week", label: "Week" },
          { value: "month", label: "Month" },
          { value: "year", label: "Year" },
        ],
        serverOps: ENUM_OPS,
      },
      {
        id: "remaining_billing_cycles",
        label: "Remaining Billing Cycles",
        type: "number",
        group: "Billing",
        hint: 'Empty means it renews forever, so "is empty" is the no-end-date filter.',
        serverOps: NUMBER_OPS,
      },
      { id: "po_number", label: "PO Number", group: "Billing", serverOps: TEXT_OPS },
      { id: "invoice_notes", label: "Invoice Notes", group: "Billing", serverOps: TEXT_OPS },

      {
        id: "auto_collection",
        label: "Auto Collection",
        type: "select",
        group: "Payment",
        options: [
          { value: "on", label: "On" },
          { value: "off", label: "Off" },
        ],
        // Filtered RAW, exactly as the response returns it — this is the SUBSCRIPTION-level
        // override, not the resolved setting.
        hint: 'The override on this subscription. Use "is empty" to find the rows that inherit the customer setting.',
        serverOps: ENUM_OPS,
      },
      {
        id: "create_pending_invoices",
        label: "Create Pending Invoices",
        type: "boolean",
        group: "Payment",
        // A bool column gets `is` and nothing else from the engine, so there is no operator
        // for the inherit case — say so rather than let Yes + No look exhaustive.
        hint: "The override only. A subscription inheriting the business default matches neither Yes nor No.",
        serverOps: BOOL_OPS,
      },
      {
        id: "net_term_days",
        label: "Net Term Days",
        type: "number",
        group: "Payment",
        serverOps: NUMBER_OPS,
      },
      {
        id: "default_payment_method",
        label: "Payment Method Id",
        group: "Payment",
        // Compares the PUBLIC id (`pm_…`) the operator can see, not the uuid column.
        hint: "The card set on this subscription (pm_…). Empty means that we charge the customer's primary payment method.",
        serverOps: TEXT_OPS,
      },
      /*
       * ── The "Payment Method" group ─────────────────────────────────────────────
       * EXISTS over the subscription's CUSTOMER, so these ask "does the payer hold ANY
       * instrument matching" — a broader question than `Payment Method Id` directly
       * above, which is the one card THIS subscription is pinned to. Both are offered
       * because an operator asks both: "which subscriptions will charge that card" and
       * "which payers are on RazorPay at all".
       *
       * `text` where the vocabulary is open (brand, last 4, expiry, issuing country,
       * gateway-account id): the subscription row carries none of it, so a select built
       * from the loaded page would offer a list that changes as the operator scrolls.
       */
      ...paymentMethodFields(gatewayCatalog),

      { id: "start_date", label: "Start Date", type: "date", group: "Dates", serverOps: DATE_OPS },
      { id: "started_at", label: "Started At", type: "date", group: "Dates", serverOps: DATE_OPS },
      {
        id: "activated_at",
        label: "Activated At",
        type: "date",
        group: "Dates",
        serverOps: DATE_OPS,
      },
      {
        id: "trial_start",
        label: "Trial Start",
        type: "date",
        group: "Dates",
        serverOps: DATE_OPS,
      },
      { id: "trial_end", label: "Trial End", type: "date", group: "Dates", serverOps: DATE_OPS },
      {
        id: "current_period_start",
        label: "Current Term Start",
        type: "date",
        group: "Dates",
        // Both term boundaries serialize as null for the whole trial and
        // the engine's filter agrees, so an in-trial row is never returned for a term window.
        hint: "A trialling subscription reports no term, so it matches no term window.",
        serverOps: DATE_OPS,
      },
      {
        id: "current_period_end",
        label: "Current Term End",
        type: "date",
        group: "Dates",
        // Was labelled "Next Billing At" here, which became the wrong field the moment the
        // engine grew a real `next_billing_at` filter: this one is null through a trial, and
        // on a day-anchored business it compares the INCLUSIVE boundary the API prints
        // (…23:59:59), one whole day off the stored instant.
        keywords: "period end renewal term",
        serverOps: DATE_OPS,
      },
      {
        id: "next_billing_at",
        label: "Next Billing At",
        type: "date",
        group: "Dates",
        // The one date that answers "who renews in the next 7 days" across every status.
        hint: "Empty for non-renewing, paused and cancelled subscriptions. They have no next charge.",
        serverOps: DATE_OPS,
      },
      {
        id: "cancel_scheduled_at",
        label: "Scheduled Cancellation Date",
        type: "date",
        group: "Dates",
        // The other half of "which subscriptions are about to cancel?" — a `specific_date`
        // cancel sets no flag, so Cancel At Term End alone under-reports the book.
        keywords: "specific date pending cancel",
        serverOps: DATE_OPS,
      },
      {
        id: "canceled_at",
        label: "Cancelled At",
        type: "date",
        group: "Dates",
        // A three-way coalesce at the API edge: the actual cancellation, else a pending
        // `specific_date` cancel, else the term end a non-renewing subscription will cancel
        // on. So a FORWARD window is meaningful and answers cancellations still to come.
        hint: "Also finds pending cancellations, so a future window is meaningful.",
        serverOps: DATE_OPS,
      },
      { id: "created_at", label: "Created At", type: "date", group: "Dates", serverOps: DATE_OPS },
      { id: "updated_at", label: "Updated At", type: "date", group: "Dates", serverOps: DATE_OPS },

      {
        id: "has_scheduled_changes",
        label: "Has Scheduled Changes",
        type: "boolean",
        group: "Other",
        hint: "A change still waiting on the billing clock.",
        serverOps: BOOL_OPS,
      },

      // Last and in their own group, because unlike everything above these are not
      // columns of `subscriptions` but keys of its `custom_fields` jsonb that this
      // business's admin defined, so the set differs per business. Ids, labels,
      // operators and an enum's options all come off the definition — see
      // lib/custom-field-filters for what is dropped and why.
      ...customFieldFilterFields<Subscription>(customFields),
    ],
    [rows, customFields, gatewayCatalog],
  );

  return (
    <ListPage
      page={page}
      entity={{ singular: "Subscription", plural: "Subscriptions" }}
      columns={columns}
      data={rows}
      server={{ total, hasMore, nextCursor, fetchPage }}
      segments={segments}
      filterFields={filterFields}
      // Operator-saved views: the built-in segments above cover the lifecycle, and a
      // 38-field builder is only worth having if the combination an operator assembles
      // can be named and come back tomorrow.
      savedViews={{ entity: "subscriptions", biz }}
      initialFilters={initialFilters}
      sortOptions={[
        { id: "created_at", label: "Created At" },
        { id: "current_period_end", label: "Next Billing At" },
        { id: "mrr", label: "MRR" },
        { id: "status", label: "Status" },
      ]}
      createAction={createAction("Subscription", `/businesses/${biz}/subscriptions/new`)}
      importAction={importAction("Subscriptions", undefined, "CSV import is not configured yet")}
      searchPlaceholder="Search for ID / Name / Plan…"
      searchHint={<PaletteSearchHint />}
      exportName="subscriptions"
      persistKey={`subs:${biz}`}
      // Customer ID duplicates the name+email already in Customer Info, and it was
      // the widest low-value column — with it visible the MRR figures were clipped
      // mid-number. Still one click away in the column chooser.
      initialHidden={[
        "customer_id",
        ...OPTIONAL_COLUMN_IDS,
        ...customFields.filter((d) => !d.archived).map((d) => `cf:${d.api_name}`),
      ]}
      enableSelection
      rowHref={(s) => `/businesses/${biz}/subscriptions/${s.id}`}
      rowMenu={(s) => (
        <SubscriptionRowMenu biz={biz} id={s.id} customer={s.customer} label={planLabel(s)} />
      )}
      emptyState={
        <EmptyState
          icon={<CreditCard />}
          title="No subscriptions"
          description="No subscriptions match this view, filter or search."
        />
      }
    />
  );
}
