"use client";

import { PaletteSearchHint } from "@/components/palette-hints";
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
import { InfoCell, TextCell, TruncateCell } from "@/components/patterns/list-cells";
import { AddonPeek, MoreSubscriptionsPeek } from "@/components/subscriptions/subscription-peek";
import { addonItems, planItem } from "@/lib/subscription-plan";
import { CustomerRowMenu } from "@/components/customers/customer-row-menu";
import { EmptyState } from "@/components/states";
import { money, fmtDate, fmtDateTimeShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Users } from "lucide-react";
import type { Customer, Subscription, TaxTreatment } from "@/lib/api";
import type { CustomFieldDefinition } from "@/lib/api/custom-fields";
import { customFieldFilterFields } from "@/lib/custom-field-filters";
import { useBusinessTz } from "@/components/business-tz";
import { accountHolderName } from "@/lib/names";
import { BILLING_DATE_MODE_OPTIONS } from "@/lib/billing-date-mode";
import type { Country } from "@/lib/api/geo";
import { moneyCell } from "@/lib/table-export";
import {
  mergeOptions,
  CURRENCY_FILTER_HINT,
  PAYMENT_METHOD_TYPE_OPTIONS,
} from "@/lib/filter-options";
import { gatewayFilterOptions, type GatewayCatalogEntry } from "@/components/gateways/gateway-meta";

/** The declared gateways; `mergeOptions` adds anything the data carries beyond them. */

const INTERVAL_SHORT: Record<string, string> = { day: "day", week: "wk", month: "mo", year: "yr" };

/**
 * Which subscription the row SHOWS when a customer has several. Newest-first alone put
 * a cancelled resubscribe-and-cancel on top of the live one the operator came to see,
 * so a live status outranks recency: the newest `active`, else the newest still-running
 * one, and only then the newest of whatever is left. Everything not chosen moves into
 * the "+N more" peek, so nothing is hidden.
 */
const PRIMARY_RANK: Record<string, number> = {
  active: 0,
  in_trial: 1,
  non_renewing: 2,
  future: 3,
  paused: 4,
};
const primarySubscription = (subs: Subscription[]): Subscription | undefined => {
  let best: Subscription | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  // The list arrives newest-first, so `<` keeps the newest of an equal rank.
  for (const s of subs) {
    const rank = PRIMARY_RANK[s.status] ?? 9;
    if (rank < bestRank) [best, bestRank] = [s, rank];
  }
  return best;
};

/**
 * One operator set per engine filter KIND, a verbatim mirror of
 * `src/platform/list-query.ts` (TEXT_OPS / ENUM_OPS / BOOL_OPS / NUMBER_OPS / DATE_OPS).
 * `CUSTOMER_FILTER_OPS` is derived from the same tables by `opsFromSpecs`, so a field
 * given the set for the kind `FILTERS` declares for it cannot offer an operator the
 * route answers with a 400 — and the previous hand-trimmed list (`is, is_not, contains,
 * starts_with, is_present`) hid six operators the endpoint had implemented all along.
 *
 * `is_present` is derived from the kind, so it also lands on NOT NULL columns
 * (`auto_collection`, `vat_number_status`, `net_term_days`, ...) where "is empty" can
 * only match nothing. Kept rather than trimmed per field: the endpoint accepts it and
 * answers truthfully, and a hand-curated exception list is exactly how a filter panel
 * and a server allow-list start disagreeing.
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
/** The EXISTS-backed virtual fields answer exactly the enum set (`SET_OPS`, `existsFieldCondition`). */
const SET_OPS = ENUM_OPS;

/**
 * FIXED option lists, used wherever the vocabulary is CLOSED.
 *
 * Options derived from `rows` only ever contain values the loaded page happens to hold,
 * so "Tax Treatment is Reverse charge" would be unofferable until a reverse-charge
 * customer surfaced on page one — on a server-backed list that is a filter the operator
 * can see is missing but cannot ask for. Only genuinely OPEN vocabularies (the
 * currencies and countries a given business actually uses) stay derived below.
 */
const AUTO_COLLECTION_OPTIONS = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

/**
 * Keyed by the `TaxTreatment` union rather than written as a plain array, so adding a
 * treatment to the API type is a build error HERE instead of a value the tax screens can
 * set and this filter cannot find. Vocabulary + meanings: db/schema/customers.ts.
 */
const TAX_TREATMENT_LABELS: Record<TaxTreatment, string> = {
  default: "Default (resolved from place of supply)",
  sez_igst: "SEZ — IGST",
  sez_zero_rated: "SEZ — zero rated",
  export_igst: "Export — IGST",
  export_zero_rated: "Export — zero rated",
  reverse_charge: "Reverse charge",
};
const TAX_TREATMENT_OPTIONS = Object.entries(TAX_TREATMENT_LABELS).map(([value, label]) => ({
  value,
  label,
}));

/** `customers.vat_number_status` (CUST-4): set by the TaxIdValidator, reset on edit. */
const VAT_NUMBER_STATUS_OPTIONS = [
  { value: "not_validated", label: "Not validated" },
  { value: "valid", label: "Valid" },
  { value: "invalid", label: "Invalid" },
  { value: "undetermined", label: "Undetermined" },
];

/**
 * `customers.pii_cleared` is `null | 'cleared'` (CUST-7), so the ONE value is the whole
 * vocabulary and "is empty" is what asks for the customers still holding their PII.
 */
const PII_CLEARED_OPTIONS = [{ value: "cleared", label: "Cleared" }];

/**
 * `subscription_status` compares the STORED column, whose vocabulary is
 * `StoredSubscriptionStatus` (modules/subscriptions/serialize.ts): five values, and
 * `cancelled` has two Ls. This list used to be `active, in_trial, paused, canceled,
 * past_due` — `canceled` and `past_due` are not values that column ever holds, so both
 * options returned an empty page, and `future` was missing entirely.
 *
 * `non_renewing` is deliberately absent: it is API-only, folded over `active` at
 * serialize time, so such a subscription is stored `active` and correctly counts as live.
 */
const SUBSCRIPTION_STATUS_OPTIONS = [
  { value: "future", label: "Future" },
  { value: "in_trial", label: "In trial" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "cancelled", label: "Cancelled" },
];

/** Who a stored instrument is for — mirrors `payment_methods.role` and `/assign_role`. */
const PAYMENT_METHOD_ROLE_OPTIONS = [
  { value: "primary", label: "Primary" },
  { value: "backup", label: "Backup" },
];

/** `payment_methods.status` (C6); the expiry sweep moves rows between the first three. */
const PAYMENT_METHOD_STATUS_OPTIONS = [
  { value: "valid", label: "Valid" },
  { value: "expiring", label: "Expiring" },
  { value: "expired", label: "Expired" },
  { value: "invalid", label: "Invalid" },
  { value: "pending_verification", label: "Pending verification" },
];

/**
 * Said on every select whose options are derived from the loaded rows, because such a
 * list is honestly incomplete — the business may hold currencies or countries no loaded
 * page shows. The reference data behind country/subdivision lives in the DB and is
 * served by `GET /v1/countries` to SERVER components (lib/api/geo.ts); this table is a
 * client component that receives only rows, so there is no fixed list to import here.
 */
const DERIVED_HINT = "Values seen on the pages loaded so far";

/** Columns an operator can add from the Columns menu: [id, header, value]. */
const OPTIONAL_TEXT_COLUMNS: Array<
  [
    string,
    string,
    (c: Customer, countryName: (code: string | null | undefined) => string) => string,
  ]
> = [
  ["customer_id", "Customer ID", (c) => c.id],
  ["email", "Email", (c) => c.email ?? ""],
  ["company", "Company", (c) => c.company ?? ""],
  ["phone", "Phone", (c) => c.phone ?? ""],
  ["country", "Country", (c, countryName) => countryName(c.address?.country)],
  ["currency", "Currency", (c) => c.effective_currency ?? c.currency ?? ""],
  ["auto_collection", "Auto Collection", (c) => (c.auto_collection === "off" ? "Off" : "On")],
  ["net_term_days", "Net Terms", (c) => (c.net_term_days ? `${c.net_term_days} days` : "")],
  ["locale", "Language", (c) => c.locale ?? ""],
  ["tax_exempt", "Tax Exempt", (c) => (c.tax_exempt ? "Yes" : "No")],
];

/** The ids of every optional column, so they start hidden. */
const OPTIONAL_COLUMN_IDS = [...OPTIONAL_TEXT_COLUMNS.map(([id]) => id), "updated_at"];

/** A custom field's value as the customer page shows it. Keyed by `api_name`. */
function customFieldText(
  def: CustomFieldDefinition,
  c: Customer,
  tz: string | null | undefined,
): string {
  const v = (c.custom_fields as Record<string, unknown> | null | undefined)?.[def.api_name];
  if (v === undefined || v === null || v === "") return "";
  if (def.data_type === "boolean") return v ? "Yes" : "No";
  if (def.data_type === "date") return fmtDate(String(v), tz);
  return String(v);
}

function addressLine(c: Customer): string {
  const a = c.address;
  return a ? [a.line1, a.city, a.state, a.postal_code, a.country].filter(Boolean).join(", ") : "";
}

/**
 * The "Subscription count" group. One shape per API status, so the list stays
 * in step with `subscriptionCountSql` in `customers/service.ts` — add a status there
 * and here together, or the panel offers a field the route rejects.
 */
const SUBSCRIPTION_COUNT_FIELDS = (
  [
    ["active", "Active Subscriptions"],
    ["non_renewing", "Non-renewing Subscriptions"],
    ["in_trial", "In-trial Subscriptions"],
    ["future", "Future Subscriptions"],
    ["paused", "Paused Subscriptions"],
    ["cancelled", "Cancelled Subscriptions"],
  ] as const
).map(([status, label]) => ({
  id: `${status}_subscription_count`,
  label,
  type: "number" as const,
  group: "Subscriptions",
  serverOps: NUMBER_OPS,
  keywords: `count how many ${status}`,
}));

/** Distinct, sorted select options for a filter field, from the loaded rows. */
function options(values: (string | null | undefined)[]): { value: string; label: string }[] {
  return [...new Set(values.filter((v): v is string => !!v))]
    .sort()
    .map((v) => ({ value: v, label: v }));
}

/**
 * The Customers list, backed by the **paginated** customers endpoint:
 * search, segments, the filter builder, sort and paging all run in SQL (see
 * `GET /v1/businesses/:biz/customers`), and rows stream in on scroll. The first
 * page is server-rendered; every later page comes through `/api/lists/customers`
 * so the org API key stays server-side.
 *
 * All list chrome comes from `ListPage`; this file declares the columns, the
 * segments (as server filters) and what customers can be filtered by.
 */
export function CustomersTable({
  page,
  biz,
  gatewayCatalog,
  rows,
  subsByCustomer,
  total,
  hasMore,
  nextCursor,
  initialFilters,
  customFields,
  countries,
}: {
  /** The page header, drawn by the list (see ListPage.page). */
  page?: ListPageHeader;
  biz: string;
  /** `GET /v1/gateways` — the gateway filter's options. */
  gatewayCatalog: GatewayCatalogEntry[];
  /** First page, server-rendered. */
  rows: Customer[];
  /** Newest-first subscriptions for the first page's customers. */
  subsByCustomer: Record<string, Subscription[]>;
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** Deep-link filters, e.g. Business Home's signup counts. See ListPage.initialFilters. */
  initialFilters?: ListServerFilter[];
  /**
   * The full country reference (`lib/api/geo`), fetched by the page — the same list every
   * address form uses. Without it the Country filters could only offer the countries on
   * the loaded page, which is how "EUR is missing" happened to Currency.
   */
  countries: Country[];
  /**
   * This business's customer custom-field definitions, archived included, fetched by the
   * page. They are admin-defined and per-business, so they cannot be declared in
   * `filterFields` below — the engine is the only thing that knows they exist.
   */
  customFields: CustomFieldDefinition[];
}) {
  // Dates render in the business timezone, not UTC (see components/business-tz).
  const tz = useBusinessTz();
  // Subscription Info is hydrated per page — merged as pages stream in.
  const [subs, setSubs] = React.useState(subsByCustomer);
  React.useEffect(() => setSubs(subsByCustomer), [subsByCustomer]);

  // Pages come through /api/lists/customers, which also ships this page's
  // subscriptions for the Subscription Info column.
  const fetchPage = React.useMemo(
    () =>
      makeListSource<Customer>("customers", biz, {
        onPayload: (payload, isFirstPage) => {
          const next = (payload.subs_by_customer ?? {}) as Record<string, Subscription[]>;
          setSubs((prev) => (isFirstPage ? next : { ...prev, ...next }));
        },
      }),
    [biz],
  );

  const countryName = React.useMemo(() => {
    const byCode = new Map(countries.map((c) => [c.code.toUpperCase(), c.name]));
    return (code: string | null | undefined) =>
      code ? (byCode.get(code.toUpperCase()) ?? code) : "";
  }, [countries]);

  const columns = React.useMemo<ColumnDef<Customer>[]>(
    () => [
      {
        id: "name",
        header: "Customer Info",
        accessorFn: (c) =>
          [accountHolderName(c) ?? c.id, c.company, c.email, c.id].filter(Boolean).join(" "),
        meta: {
          exportAs: [
            { header: "Customer ID", value: (c) => c.id },
            { header: "Name", value: (c) => accountHolderName(c) ?? "" },
            { header: "Company", value: (c) => c.company ?? "" },
            { header: "Email", value: (c) => c.email ?? "" },
          ],
        },
        cell: ({ row }) => {
          const c = row.original;
          const name = accountHolderName(c) ?? c.id;
          const nameIsId = name === c.id;
          const showEmail = !!c.email && c.email !== name;
          // Free text, so bounded — but wrapped at 320px rather than cut off: one
          // pasted 200-char name must not widen the column past the pane.
          const line = "block max-w-80 wrap-anywhere text-xs text-muted-foreground";
          return (
            <InfoCell
              title={
                <span className={cn("block max-w-80 wrap-anywhere", nameIsId && "font-mono")}>
                  {name}
                </span>
              }
              href={`/businesses/${biz}/customers/${c.id}`}
              sub={c.company ? <span className={line}>{c.company}</span> : undefined}
              extra={
                <>
                  {showEmail ? <span className={line}>{c.email}</span> : null}
                  {c.phone ? <span className={line}>{c.phone}</span> : null}
                  {/* Nothing else identifies the row: show the id under the name. */}
                  {!nameIsId && !c.company && !showEmail && !c.phone ? (
                    <span className={cn(line, "font-mono")}>{c.id}</span>
                  ) : null}
                </>
              }
            />
          );
        },
      },
      {
        id: "subscription",
        header: "Subscription Info",
        enableSorting: false,
        accessorFn: (c) => {
          const sub = primarySubscription(subs[c.id] ?? []);
          if (!sub) return "";
          const plan = planItem(sub);
          return `${sub.status} ${plan?.product_name ?? sub.id}`;
        },
        meta: {
          exportAs: [
            {
              header: "Subscription ID",
              value: (c) => primarySubscription(subs[c.id] ?? [])?.id ?? "",
            },
            {
              header: "Subscription Status",
              value: (c) => primarySubscription(subs[c.id] ?? [])?.status ?? "",
            },
            {
              header: "Plan",
              value: (c) => {
                const sub = primarySubscription(subs[c.id] ?? []);
                return sub ? (planItem(sub)?.product_name ?? "") : "";
              },
            },
          ],
        },
        cell: ({ row }) => {
          const list = subs[row.original.id] ?? [];
          const sub = primarySubscription(list);
          if (!sub) return <TextCell />;
          const plan = planItem(sub);
          // Billed amount (engine, net of recurring discounts) leads; list price trails it.
          // List covers every item on the plan's cadence, so an addon doesn't read as a markup.
          const listMinor =
            plan?.unit_price_minor != null
              ? [plan, ...addonItems(sub).filter((i) => i.interval === plan.interval)].reduce(
                  (s, i) => s + (i.unit_price_minor ?? 0) * (i.quantity || 1),
                  0,
                )
              : null;
          return (
            <InfoCell
              status={sub.status}
              // Same reason as the Customer Info column: a product name is free text.
              title={
                <span
                  className={cn("block max-w-80 wrap-anywhere", !plan?.product_name && "font-mono")}
                >
                  {plan?.product_name ?? sub.id}
                </span>
              }
              href={`/businesses/${biz}/subscriptions/${sub.id}`}
              // The two badges name what they count on hover: which addons ride this
              // subscription, and which OTHER subscriptions this customer has — each of
              // those a link, because the row can only ever show one.
              sub={
                <span className="flex flex-wrap items-center gap-2">
                  {/* A cancelled subscription bills nothing; its old price would read as revenue. */}
                  {sub.status === "cancelled" ? null : (
                    <span className="text-xs text-muted-foreground">
                      {sub.recurring_amount_minor != null
                        ? money(sub.recurring_amount_minor, sub.currency)
                        : listMinor != null
                          ? money(listMinor, sub.currency)
                          : sub.currency}
                      {plan?.interval ? ` / ${INTERVAL_SHORT[plan.interval] ?? plan.interval}` : ""}
                      {sub.recurring_amount_minor != null &&
                      listMinor != null &&
                      listMinor > sub.recurring_amount_minor
                        ? ` · list ${money(listMinor, sub.currency)}`
                        : null}
                    </span>
                  )}
                  <AddonPeek items={addonItems(sub)} currency={sub.currency} />
                  <MoreSubscriptionsPeek biz={biz} subs={list.filter((s) => s.id !== sub.id)} />
                </span>
              }
            />
          );
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
      {
        id: "billing_address",
        header: "Billing Address",
        enableSorting: false,
        accessorFn: (c) => addressLine(c),
        cell: ({ row }) => <TruncateCell value={addressLine(row.original)} />,
      },
      // ── Optional columns, hidden until picked in the Columns menu ──────────────
      // Not sortable: the list sorts on the server, by the fields in "Sort by".
      // No MRR column: the list endpoint leaves `mrr` out on purpose, so it would be blank.
      ...OPTIONAL_TEXT_COLUMNS.map(([id, header, value]): ColumnDef<Customer> => ({
        id,
        header,
        enableSorting: false,
        accessorFn: (c) => value(c, countryName),
        cell: ({ row }) => <TruncateCell value={value(row.original, countryName)} />,
      })),
      {
        id: "updated_at",
        header: "Updated At",
        enableSorting: false,
        accessorFn: (c) => c.updated_at ?? "",
        cell: ({ row }) => (
          <TextCell>
            {row.original.updated_at ? fmtDateTimeShort(row.original.updated_at, tz) : null}
          </TextCell>
        ),
      },
      // One column per custom field this business defined, archived ones left out: a
      // retired field can still be filtered on, but a column of mostly empty cells is noise.
      ...customFields
        .filter((d) => !d.archived)
        .map((d): ColumnDef<Customer> => ({
          id: `cf:${d.api_name}`,
          header: d.label,
          enableSorting: false,
          accessorFn: (c) => customFieldText(d, c, tz),
          cell: ({ row }) => <TruncateCell value={customFieldText(d, row.original, tz)} />,
        })),
    ],
    [biz, subs, tz, customFields, countryName],
  );

  // Segments compile to server filters, so a view narrows all 50k rows — not just the
  // page on screen. The `subscription_status` / `payment_method_*` / `has_unpaid_invoices`
  // fields are the API's EXISTS-backed virtuals, and their negations wrap the whole
  // EXISTS — so a customer with NO subscription at all matches "Without a Live
  // Subscription", and one with no payment method matches "Without a Payment Method".
  // That is the intent of both labels; see `existsFieldCondition` for why it is not the
  // comparison inside the sub-query that gets negated.
  const segments = React.useMemo<ListSegment<Customer>[]>(
    () => [
      { id: "all", label: "All Customers" },
      {
        id: "active",
        label: "With Active Subscriptions",
        filters: [{ field: "subscription_status", op: "is", value: "active" }],
      },
      {
        id: "trial",
        label: "In Trial",
        filters: [{ field: "subscription_status", op: "is", value: "in_trial" }],
      },
      {
        id: "no_live_sub",
        label: "Without a Live Subscription",
        // `active` covers non_renewing too (API-only, stored `active`), so a subscription
        // winding down at term end is still counted live here — which is correct.
        filters: [{ field: "subscription_status", op: "not_in", value: "active,in_trial" }],
      },
      {
        id: "unpaid",
        label: "With Unpaid Invoices",
        // `has_unpaid_invoices` is posted/payment_due/not_paid — deliberately NOT
        // `pending`, which is an invoice still accreting metered lines that nobody has
        // been asked to pay yet (see UNPAID_INVOICE_STATUSES).
        filters: [{ field: "has_unpaid_invoices", op: "is", value: "true" }],
      },
      {
        id: "no_payment_method",
        label: "Without a Payment Method",
        // `is_present=false` on either payment-method field asks "has none at all";
        // `payment_method_type` is the one the service's own comment names.
        filters: [{ field: "payment_method_type", op: "is_present", value: "false" }],
      },
      {
        id: "pm_expiring",
        label: "Payment Method Expiring or Expired",
        // The expiry sweep sets these two statuses, and this is the list an operator
        // works before the renewals fail rather than after.
        filters: [{ field: "payment_method_status", op: "in", value: "expiring,expired" }],
      },
      {
        id: "offline",
        label: "Auto-collection Off",
        filters: [{ field: "auto_collection", op: "is", value: "off" }],
      },
      {
        id: "tax_exempt",
        label: "Tax Exempt",
        filters: [{ field: "tax_exempt", op: "is", value: "true" }],
      },
    ],
    [],
  );

  /** The whole country reference as options — see `lib/filter-options.ts` for why the
   *  loaded page is not a safe source for a closed-vocabulary filter. */
  const countryOptions = React.useMemo(
    () => countries.map((c) => ({ value: c.code, label: c.name })),
    [countries],
  );

  /**
   * Every field the customers endpoint can filter on — the 40 columns of `FILTERS` plus
   * the 4 EXISTS-backed `VIRTUAL_FILTERS`, in `src/modules/customers/service.ts`. That
   * file is the authority: each `id` here is a key of its map and each `serverOps` is the
   * set its `kind` yields, because a field the panel offers and the route rejects is a
   * 400 the operator reads as "search is broken".
   *
   * `group` matters at this size: 44 fields in one flat alphabetical list is unusable, so
   * the picker searches and shows the section. The nine group names are shared across
   * every list in the product, so an operator who learns where Country lives on customers
   * finds it in the same place on invoices.
   */
  const filterFields = React.useMemo<ListFilterField<Customer>[]>(
    () => [
      // ── Identity ─────────────────────────────────────────────────────────────
      { id: "id", label: "Customer Id", group: "Identity", serverOps: TEXT_OPS },
      // The DERIVED holder name, matching the Customer Info column — the engine filters
      // `accountHolderNameSql`, not the deprecated `name` column, so filtering by the
      // name on screen cannot return an empty page. The three components below are for
      // matching one part exactly.
      {
        id: "name",
        label: "Name",
        group: "Identity",
        serverOps: TEXT_OPS,
        keywords: "customer full name",
      },
      { id: "first_name", label: "First Name", group: "Identity", serverOps: TEXT_OPS },
      { id: "last_name", label: "Last Name", group: "Identity", serverOps: TEXT_OPS },
      { id: "company", label: "Company", group: "Identity", serverOps: TEXT_OPS },
      { id: "email", label: "Email", group: "Identity", serverOps: TEXT_OPS },
      { id: "phone", label: "Phone", group: "Identity", serverOps: TEXT_OPS },
      {
        id: "locale",
        label: "Preferred Language",
        group: "Identity",
        // `text`, not a select: a locale is `en-US`, and the question asked of it is
        // `starts_with=en` ("everyone we mail in English"), which no option list answers.
        serverOps: TEXT_OPS,
        keywords: "locale language portal email invoice",
        hint: "BCP-47, e.g. en-US or fr",
      },

      // ── Status ───────────────────────────────────────────────────────────────
      {
        id: "invoice_status",
        label: "Invoice Status",
        type: "text",
        group: "Status",
        serverOps: SET_OPS,
        keywords: "invoice paid voided posted payment due",
        hint: "Matches a customer with ANY invoice in that status. Is empty matches a customer with no invoices",
      },
      {
        id: "has_unpaid_invoices",
        label: "Has Unpaid Invoices",
        type: "boolean",
        group: "Status",
        // `bool` kind on the engine: the status set is fixed inside the sub-query and the
        // VALUE only chooses which way the EXISTS points, so `is` is the only operator.
        serverOps: BOOL_OPS,
        keywords: "dues outstanding overdue payment due not paid",
        hint: "Posted, payment due or not paid. A pending invoice can still get more lines, so it does not count",
      },
      {
        id: "pii_cleared",
        label: "Personal Data Cleared",
        type: "select",
        options: PII_CLEARED_OPTIONS,
        group: "Status",
        serverOps: ENUM_OPS,
        keywords: "gdpr pii scrub clear personal data",
      },

      // ── Subscriptions ────────────────────────────────────────────────────────
      {
        id: "subscription_status",
        label: "Subscription Status",
        type: "select",
        options: SUBSCRIPTION_STATUS_OPTIONS,
        group: "Subscriptions",
        serverOps: SET_OPS,
        hint: "Matches a customer with ANY subscription in that status. A negation matches a customer with none",
      },
      /*
       * HOW MANY, not whether — these get their own "Subscription count" group for a
       * reason: `Subscription Status` above answers presence, and "more than one active
       * subscription" is a different question that presence cannot express. Counted on
       * the API status, so `non_renewing` means here exactly what the pill on the
       * subscriptions list says.
       */
      {
        id: "subscription_count",
        label: "Subscription Count",
        type: "number",
        group: "Subscriptions",
        serverOps: NUMBER_OPS,
        keywords: "count how many total all subscriptions",
        hint: "Every subscription, any status. Use the per-status counts below for one status",
      },
      ...SUBSCRIPTION_COUNT_FIELDS,

      // ── Payment ──────────────────────────────────────────────────────────────
      {
        id: "payment_method_count",
        label: "Payment Method Count",
        type: "number",
        group: "Payment",
        serverOps: NUMBER_OPS,
        keywords: "how many saved cards methods backup",
        hint: "Saved payment methods, any status. 0 = none on file",
      },
      {
        id: "payment_method_type",
        label: "Payment Method Type",
        type: "select",
        options: PAYMENT_METHOD_TYPE_OPTIONS,
        group: "Payment",
        serverOps: SET_OPS,
        keywords: "card upi ach sepa mandate instrument",
        hint: "Is empty = no payment method at all",
      },
      {
        id: "payment_method_status",
        label: "Payment Method Status",
        type: "select",
        options: PAYMENT_METHOD_STATUS_OPTIONS,
        group: "Payment",
        serverOps: SET_OPS,
        keywords: "expiring expired invalid card",
      },
      /*
       * ── The stored INSTRUMENT (the "Payment Method" group) ─────────────────────
       * Every one is EXISTS-backed, so it answers "has ANY method matching" and its
       * negation includes the customer with none — which is why they all carry the
       * same `hint` shape as the two above.
       *
       * Deliberately `text` where the vocabulary is OPEN: a card brand, a last-4, an
       * issuing country and a gateway-account id are not a closed set, and the
       * customer row does not carry them, so there is nothing honest to derive
       * options from. A select built from the loaded page would offer the operator a
       * list that changes as they scroll.
       */
      {
        id: "primary_payment_method_type",
        label: "Primary Payment Method",
        type: "select",
        options: PAYMENT_METHOD_TYPE_OPTIONS,
        group: "Payment",
        serverOps: SET_OPS,
        keywords: "default primary rail pays first",
        hint: "Is empty = no primary payment method assigned",
      },
      {
        id: "backup_payment_method_type",
        label: "Backup Payment Method",
        type: "select",
        options: PAYMENT_METHOD_TYPE_OPTIONS,
        group: "Payment",
        serverOps: SET_OPS,
        keywords: "fallback secondary dunning",
        hint: "Is empty = no fallback if the primary is refused",
      },
      {
        id: "payment_method_role",
        label: "Payment Method Role",
        type: "select",
        options: PAYMENT_METHOD_ROLE_OPTIONS,
        group: "Payment",
        serverOps: SET_OPS,
      },
      {
        id: "payment_method_gateway",
        label: "Payment Method Gateway",
        type: "select",
        options: gatewayFilterOptions(gatewayCatalog),
        group: "Payment",
        serverOps: SET_OPS,
        keywords: "stripe razorpay paypal provider",
      },
      {
        id: "payment_method_gateway_account",
        label: "Gateway Account",
        type: "text",
        group: "Payment",
        serverOps: SET_OPS,
        keywords: "gwa account merchant",
        hint: "The gateway account's public id (gwa_…)",
      },
      {
        id: "payment_method_id",
        label: "Payment Method Id",
        type: "text",
        group: "Payment",
        serverOps: SET_OPS,
        keywords: "pm instrument id",
      },
      {
        id: "payment_method_brand",
        label: "Card Type",
        type: "text",
        group: "Payment",
        serverOps: SET_OPS,
        keywords: "visa mastercard rupay amex brand network",
      },
      {
        id: "payment_method_last4",
        label: "Card/Account Last 4",
        type: "text",
        group: "Payment",
        serverOps: SET_OPS,
        keywords: "last four digits number",
      },
      {
        id: "payment_method_exp_month",
        label: "Month of Expiry",
        type: "text",
        group: "Payment",
        serverOps: SET_OPS,
        // Equality and set membership only — see the engine note: the EXISTS compares
        // text, so a range would sort "9" after "10".
        hint: "Exact month, e.g. 09",
      },
      {
        id: "payment_method_exp_year",
        label: "Year of Expiry",
        type: "text",
        group: "Payment",
        serverOps: SET_OPS,
        hint: "Exact year, e.g. 2027",
      },
      {
        id: "paying",
        label: "Paying Customer",
        type: "boolean",
        group: "Payment",
        serverOps: BOOL_OPS,
      },
      {
        id: "renewing",
        label: "Renewing Customer",
        type: "boolean",
        group: "Payment",
        serverOps: BOOL_OPS,
      },
      {
        id: "cannot_be_charged",
        label: "Cannot Be Charged",
        type: "boolean",
        group: "Payment",
        serverOps: BOOL_OPS,
      },
      {
        id: "payment_method_expiring",
        label: "Card Expiring in 90 Days",
        type: "boolean",
        group: "Payment",
        serverOps: BOOL_OPS,
      },
      {
        id: "payment_method_issuer_country",
        label: "Issuing Country",
        type: "text",
        group: "Payment",
        serverOps: SET_OPS,
        keywords: "issuer bank country",
      },
      {
        id: "payment_method_sub_type",
        label: "Bank Account Type",
        type: "text",
        group: "Payment",
        serverOps: SET_OPS,
        keywords: "savings current checking instrument sub type",
      },

      // ── Billing ──────────────────────────────────────────────────────────────
      {
        id: "currency",
        label: "Preferred Currency",
        type: "text",
        // Open vocabulary: which currencies a business bills in is its own choice, so
        // this stays derived from the rows.

        group: "Billing",
        serverOps: ENUM_OPS,
        hint: CURRENCY_FILTER_HINT,
      },
      {
        id: "auto_collection",
        label: "Auto-collection",
        type: "select",
        options: AUTO_COLLECTION_OPTIONS,
        group: "Billing",
        serverOps: ENUM_OPS,
        keywords: "offline send invoice charge automatically",
      },
      {
        id: "net_term_days",
        label: "Net Term Days",
        type: "number",
        group: "Billing",
        serverOps: NUMBER_OPS,
        keywords: "net d terms due days",
        hint: "Days a send-invoice customer has to pay. 0 = due on receipt",
      },
      {
        id: "billing_date",
        label: "Billing Date",
        type: "number",
        group: "Billing",
        serverOps: NUMBER_OPS,
        keywords: "anchor day of month calendar billing",
        hint: "Day of the month, 1-31",
      },
      {
        id: "billing_date_mode",
        label: "Billing Date Mode",
        type: "select",
        options: BILLING_DATE_MODE_OPTIONS,
        group: "Billing",
        serverOps: ENUM_OPS,
        keywords: "anchor using defaults manually set",
      },
      { id: "invoice_notes", label: "Invoice Notes", group: "Billing", serverOps: TEXT_OPS },

      // ── Address (the BILLING address, serialized under `address`) ────────────
      {
        id: "country",
        // Keeps its bare id: it shipped before the rest of this block and saved queries
        // carry it. The engine deliberately has no `address_country` alias, so there is
        // exactly one canonical id for the column.
        label: "Country",
        type: "select",
        options: mergeOptions(
          countryOptions,
          rows.map((c) => c.address?.country),
        ),
        group: "Address",
        serverOps: ENUM_OPS,
        keywords: "billing address country",
        hint: DERIVED_HINT,
      },
      { id: "address_line1", label: "Address Line 1", group: "Address", serverOps: TEXT_OPS },
      { id: "address_line2", label: "Address Line 2", group: "Address", serverOps: TEXT_OPS },
      { id: "address_line3", label: "Address Line 3", group: "Address", serverOps: TEXT_OPS },
      { id: "address_city", label: "City", group: "Address", serverOps: TEXT_OPS },
      {
        id: "address_state",
        label: "State",
        group: "Address",
        serverOps: TEXT_OPS,
        keywords: "province region",
      },
      {
        id: "address_state_code",
        label: "State Code",
        type: "text",
        // `enum` on the engine (it is the canonical subdivision code the tax engine
        // resolves place of supply on), so no substring operators. The fixed list is
        // per-country and lives in the DB behind `GET /v1/countries/:code/subdivisions`,
        // which only a server component can reach — hence derived here.

        group: "Address",
        serverOps: ENUM_OPS,
        keywords: "iso 3166-2 subdivision place of supply",
        hint: DERIVED_HINT,
      },
      {
        id: "address_postal_code",
        label: "Postal Code",
        group: "Address",
        serverOps: TEXT_OPS,
        keywords: "zip pin postcode",
      },
      // The billing address's OWN contact block (CP-2) — distinct from the customer's
      // first/last/company/phone above, which is why the engine filters both.
      {
        id: "address_first_name",
        label: "Billing First Name",
        group: "Address",
        serverOps: TEXT_OPS,
      },
      {
        id: "address_last_name",
        label: "Billing Last Name",
        group: "Address",
        serverOps: TEXT_OPS,
      },
      { id: "address_company", label: "Billing Company", group: "Address", serverOps: TEXT_OPS },
      { id: "address_phone", label: "Billing Phone", group: "Address", serverOps: TEXT_OPS },

      // ── Shipping address (one jsonb blob; the engine extracts each key) ──────
      {
        id: "shipping_address_city",
        label: "Shipping City",
        group: "Shipping address",
        serverOps: TEXT_OPS,
      },
      {
        id: "shipping_address_state",
        label: "Shipping State",
        group: "Shipping address",
        serverOps: TEXT_OPS,
      },
      {
        id: "shipping_address_country",
        label: "Shipping Country",
        type: "select",
        options: mergeOptions(
          countryOptions,
          rows.map((c) => c.shipping_address?.country),
        ),
        group: "Shipping address",
        serverOps: ENUM_OPS,
        hint: DERIVED_HINT,
      },
      {
        id: "shipping_address_postal_code",
        label: "Shipping Postal Code",
        group: "Shipping address",
        serverOps: TEXT_OPS,
        keywords: "zip pin postcode",
      },

      // ── Tax ──────────────────────────────────────────────────────────────────
      { id: "tax_exempt", label: "Tax Exempt", type: "boolean", group: "Tax", serverOps: BOOL_OPS },
      {
        id: "tax_treatment",
        label: "Tax Treatment",
        type: "select",
        options: TAX_TREATMENT_OPTIONS,
        group: "Tax",
        serverOps: ENUM_OPS,
        keywords: "sez export reverse charge zero rated",
      },
      {
        id: "tax_registration_number",
        label: "Tax Registration Number",
        group: "Tax",
        serverOps: TEXT_OPS,
        keywords: "gstin gst registration",
        // The migration-audit question is "who is missing one", which is `is empty`.
        hint: "The customer's own registration number (GSTIN for India)",
      },
      {
        id: "vat_number",
        label: "VAT Number",
        group: "Tax",
        serverOps: TEXT_OPS,
        hint: "The separate EU/VIES id, with its own validation lifecycle",
      },
      {
        id: "vat_number_status",
        label: "VAT Number Status",
        type: "select",
        options: VAT_NUMBER_STATUS_OPTIONS,
        group: "Tax",
        serverOps: ENUM_OPS,
      },
      {
        id: "vat_validated_at",
        label: "VAT Validated At",
        type: "date",
        group: "Tax",
        serverOps: DATE_OPS,
        keywords: "vies validation date",
      },
      {
        id: "withholding_rate_bps",
        label: "Withholding Rate (%)",
        // `money`, not `number`: the column is basis points and the exponent is 2 for
        // every row, so the operator types 10 and the filter sends 1000. Typing bps is
        // how "withholding over 10%" becomes a filter set 100x wrong.
        type: "money",
        moneyExponent: 2,
        group: "Tax",
        serverOps: NUMBER_OPS,
        keywords: "tds withholding basis points bps",
        hint: "Percent. We store it as basis points, so 10 means 1000 bps",
      },

      // ── Dates ────────────────────────────────────────────────────────────────
      { id: "created_at", label: "Created At", type: "date", group: "Dates", serverOps: DATE_OPS },
      { id: "updated_at", label: "Updated At", type: "date", group: "Dates", serverOps: DATE_OPS },

      // ── Custom fields ────────────────────────────────────────────────────────
      // Last and in their own group, because unlike everything above these are not
      // columns of `customers` but keys of its `custom_fields` jsonb that this
      // business's admin defined, so the set differs per business. Ids, labels,
      // operators and an enum's options all come off the definition — see
      // lib/custom-field-filters for what is dropped and why.
      ...customFieldFilterFields<Customer>(customFields),
    ],
    [rows, customFields, countryOptions, gatewayCatalog],
  );

  return (
    <ListPage
      page={page}
      entity={{ singular: "Customer", plural: "Customers" }}
      columns={columns}
      data={rows}
      server={{ total, hasMore, nextCursor, fetchPage }}
      segments={segments}
      filterFields={filterFields}
      savedViews={{ entity: "customers", biz }}
      initialFilters={initialFilters}
      initialHidden={[
        ...OPTIONAL_COLUMN_IDS,
        ...customFields.filter((d) => !d.archived).map((d) => `cf:${d.api_name}`),
      ]}
      // Sort ids are the API's sortable fields (see CUSTOMER_SORT_FIELDS).
      sortOptions={[
        { id: "created_at", label: "Created At" },
        { id: "name", label: "Name" },
        { id: "email", label: "Email" },
        { id: "company", label: "Company" },
      ]}
      createAction={createAction("Customer", `/businesses/${biz}/customers/new`)}
      importAction={importAction("Customers", undefined, "CSV import is not configured yet")}
      searchPlaceholder="Search for ID / Name / Email / Company…"
      searchHint={<PaletteSearchHint />}
      exportName="customers"
      persistKey={`customers:${biz}`}
      enableSelection
      rowHref={(c) => `/businesses/${biz}/customers/${c.id}`}
      rowMenu={(c) => <CustomerRowMenu biz={biz} id={c.id} label={accountHolderName(c) ?? c.id} />}
      emptyState={
        <EmptyState
          icon={<Users />}
          title="No customers"
          description="No customers match this view, filter or search."
        />
      }
    />
  );
}
