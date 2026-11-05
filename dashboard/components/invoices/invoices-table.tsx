"use client";

import { PaletteSearchHint } from "@/components/palette-hints";
import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ListPage,
  type ListFilterField,
  type ListSegment,
  type ListPageHeader,
} from "@/components/patterns/list-page";
import { makeListSource } from "@/lib/list-source";
import { InfoCell, MoneyCell, TextCell } from "@/components/patterns/list-cells";
import { CustomerInfoCell } from "@/components/patterns/customer-info-cell";
import { cn } from "@/lib/utils";
import { StatusChip, Chip } from "@/components/patterns/chip";
import { EmptyState } from "@/components/states";
import type { InvoiceExtras } from "@/lib/api/invoices";
import { fmtDateShort, fmtDateTimeShort } from "@/lib/format";
import { Receipt } from "lucide-react";
import type { Invoice } from "@/lib/api";
import { TREATMENT_SHORT } from "@/lib/tax-format";
import { moneyCell } from "@/lib/table-export";
import { AR_AGING_BUCKET_LABELS } from "@/components/reports/report-drills";

/**
 * The list serializer emits more than the frozen `Invoice` type names (paid_at,
 * voided_at, po_number, customer_name…). Widen locally rather than editing the
 * frozen type — same pattern as `InvoiceDetail` on the detail page.
 */
type InvoiceRow = Invoice & InvoiceExtras;
import { useBusinessTz } from "@/components/business-tz";

const OPEN = ["posted", "payment_due", "not_paid"];

/**
 * Operators the engine implements, mirroring `src/platform/list-query.ts` term for term
 * (`INVOICE_FILTER_OPS` is `opsFromSpecs` over the same tables). We used to offer five
 * of the nine text operators and three of the nine date ones, so "is one of", "is
 * between" and "is in the next N days" were unaskable on a list the engine could
 * already answer them for.
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
 * The same lists without `is_present`, for a NOT NULL column.
 *
 * `opsFromSpecs` hands every field of a kind the whole operator table, so the engine
 * accepts `status[is_present]=false` — and answers it with zero rows, always, because
 * the column cannot be null. "is empty" / "is not empty" there is a control that can
 * never do anything, so the pair is dropped per FIELD rather than per kind.
 */
const withoutPresence = (ops: string[]) => ops.filter((o) => o !== "is_present");
const TEXT_OPS_NN = withoutPresence(TEXT_OPS);
const ENUM_OPS_NN = withoutPresence(ENUM_OPS);
const NUM_OPS_NN = withoutPresence(NUM_OPS);
const DATE_OPS_NN = withoutPresence(DATE_OPS);

/**
 * Amount fields stay `type: 'number'` in MINOR UNITS rather than `'money'`.
 *
 * `money` would let the operator type 1,299.00 and send 129900, but it needs ONE
 * exponent for the whole column and this list is mixed-currency: a business carries
 * `currencies` (plural — the page hands them to `ManualInvoiceForm`) and `currency` is a
 * filter right here. A JPY invoice has exponent 0, so a field pinned at 2 would send 100×
 * the bound that was typed and silently change which rows match. Minor units are exact
 * for every row, and every amount label says so.
 */
const MINOR_HINT = "Integer minor units. For example, 129900 is 1,299.00 in a two-decimal currency";

/**
 * Closed vocabularies, spelled out rather than derived from the loaded page: options
 * built from one page of rows silently omit every value that occurs only later in the
 * business, so a status that exists on the data is unfilterable here until they
 * happen to scroll a row carrying it into view.
 *
 * `status` mirrors the `InvoiceStatus` union and `dunning_status` the `DunningStatus`
 * one (`src/modules/invoicing/status.ts`); `invoices_status_ck` and
 * `invoices_dunning_status_ck` (0218) enforce exactly these in the database.
 */
const STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "posted", label: "Posted" },
  { value: "payment_due", label: "Payment Due" },
  { value: "not_paid", label: "Not Paid" },
  { value: "paid", label: "Paid" },
  { value: "voided", label: "Voided" },
];

/** `parked` = retries exhausted, awaiting a final action (settlement.ts / dunning.ts). */
const DUNNING_OPTIONS = [
  { value: "in_progress", label: "In progress" },
  { value: "parked", label: "Parked" },
  { value: "succeeded", label: "Recovered" },
  { value: "exhausted", label: "Exhausted" },
  { value: "stopped", label: "Stopped" },
];

/**
 * The ageing ladder's rungs, as filter options. One definition, in `report-drills.ts`,
 * which is also what the receivables report's drill-down sends — so the filter a reader
 * lands on and the filter they can build by hand are the same filter.
 *
 * The value IS the label: the engine compares the rung's NAME.
 */
const AR_BUCKET_OPTIONS = AR_AGING_BUCKET_LABELS.map((b) => ({ value: b, label: b }));

/** The `Channel` union in `src/platform/event-context.ts` — the Channel column. */
const CHANNEL_OPTIONS = [
  { value: "api", label: "API" },
  { value: "dashboard", label: "Dashboard" },
  { value: "system", label: "System (billing clock)" },
  { value: "import", label: "Import" },
];

/** The customer's treatment as snapshotted at issue; labels shared with the tax screens. */
const TREATMENT_OPTIONS = Object.entries(TREATMENT_SHORT).map(([value, label]) => ({
  value,
  label,
}));

/** Invoices list on the shared `ListPage` chrome. */
export function InvoicesTable({
  page,
  biz,
  rows,
  createSlot,
  total,
  hasMore,
  nextCursor,
  initialFilters,
}: {
  /** The page header, drawn by the list (see ListPage.page). */
  page?: ListPageHeader;
  biz: string;
  /** First page, server-rendered. */
  rows: Invoice[];
  /** The manual-invoice dialog trigger (create opens a modal here, not a page). */
  createSlot?: React.ReactNode;
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  /**
   * A deep link's narrowing (`?filter=ar_bucket:is:61–90 days`), read off the URL in the
   * page's server component. Seeding the list is what makes the pills and Clear work —
   * without it the address bar claims a filter the table has never heard of.
   */
  initialFilters?: Array<{ field: string; op: string; value: string }>;
}) {
  const fetchPage = React.useMemo(() => makeListSource<Invoice>("invoices", biz), [biz]);
  // Dates render in the business timezone, not UTC (see components/business-tz).
  const tz = useBusinessTz();
  const columns = React.useMemo<ColumnDef<InvoiceRow>[]>(
    () => [
      {
        id: "invoice",
        header: "Invoice",
        accessorFn: (i) => `${i.number ?? ""} ${i.id}`,
        cell: ({ row }) => {
          const i = row.original;
          return (
            <InfoCell
              title={<span className={cn(!i.number && "font-mono")}>{i.number ?? i.id}</span>}
              href={`/businesses/${biz}/invoices/${i.id}`}
              // A number-less invoice already shows its id as the title.
              sub={i.number ? i.id : undefined}
              trailing={
                i.imported ? (
                  <Chip tone="slate" className="px-1.5 py-0 text-xs uppercase">
                    Imported
                  </Chip>
                ) : null
              }
            />
          );
        },
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusChip status={row.original.status} />,
      },
      {
        id: "total",
        header: "Amount",
        accessorFn: (i) => i.total_minor,
        meta: {
          align: "right",
          exportAs: [
            moneyCell<InvoiceRow>(
              "Amount",
              (r) => r.total_minor,
              (r) => r.currency,
            ),
            { header: "Currency", value: (r) => r.currency ?? "" },
          ],
        },
        cell: ({ row }) => (
          <MoneyCell minor={row.original.total_minor} currency={row.original.currency} />
        ),
      },
      {
        id: "due",
        header: "Amount Due",
        accessorFn: (i) => (OPEN.includes(i.status) ? (i.amount_due_minor ?? i.total_minor) : 0),
        // Blank unless the invoice is open, as on screen.
        meta: {
          align: "right",
          exportAs: [
            moneyCell<InvoiceRow>(
              "Amount Due",
              (r) => (OPEN.includes(r.status) ? (r.amount_due_minor ?? r.total_minor) : null),
              (r) => r.currency,
            ),
          ],
        },
        cell: ({ row }) => {
          const i = row.original;
          if (!OPEN.includes(i.status)) return <TextCell />;
          return <MoneyCell minor={i.amount_due_minor ?? i.total_minor} currency={i.currency} />;
        },
      },
      {
        id: "dunning",
        header: "Dunning",
        accessorFn: (i) => i.attempt_count ?? 0,
        cell: ({ row }) => {
          const n = row.original.attempt_count;
          return <TextCell>{n ? `${n} attempt${n === 1 ? "" : "s"}` : null}</TextCell>;
        },
      },
      {
        accessorKey: "created_at",
        id: "created_at",
        header: "Created",
        cell: ({ row }) => (
          <TextCell>
            {row.original.created_at ? fmtDateTimeShort(row.original.created_at, tz) : null}
          </TextCell>
        ),
      },
      {
        accessorKey: "period_end",
        header: "Period End",
        cell: ({ row }) => (
          <TextCell>
            {row.original.period_end ? fmtDateShort(row.original.period_end, tz) : null}
          </TextCell>
        ),
      },
      {
        id: "retry",
        header: "Next Retry",
        accessorFn: (i) => i.next_attempt_at ?? "",
        cell: ({ row }) => (
          <TextCell>
            {row.original.next_attempt_at
              ? fmtDateTimeShort(row.original.next_attempt_at, tz)
              : null}
          </TextCell>
        ),
      },
      // Paid On and Customer are visible by default; Voided On is optional, so it
      // starts hidden here (still in the column chooser).
      {
        id: "customer",
        header: "Customer",
        accessorFn: (i) => i.customer_name ?? i.customer ?? "",
        cell: ({ row }) => {
          const i = row.original;
          if (!i.customer) return <TextCell>{i.customer_name ?? null}</TextCell>;
          return (
            <CustomerInfoCell id={i.customer} name={i.customer_name} email={i.customer_email} />
          );
        },
      },
      {
        id: "paid_at",
        header: "Paid On",
        accessorFn: (i) => i.paid_at ?? "",
        cell: ({ row }) => (
          <TextCell>
            {row.original.paid_at ? fmtDateTimeShort(row.original.paid_at, tz) : null}
          </TextCell>
        ),
      },
      {
        id: "voided_at",
        header: "Voided On",
        accessorFn: (i) => i.voided_at ?? "",
        cell: ({ row }) => (
          <TextCell>
            {row.original.voided_at ? fmtDateTimeShort(row.original.voided_at, tz) : null}
          </TextCell>
        ),
      },
      {
        id: "po_number",
        header: "PO Number",
        accessorFn: (i) => i.po_number ?? "",
        cell: ({ row }) => <TextCell>{row.original.po_number ?? null}</TextCell>,
      },
    ],
    [biz],
  );

  // The invoice views (these were status chips above the table before).
  const segments = React.useMemo<ListSegment<InvoiceRow>[]>(
    () => [
      { id: "all", label: "All Invoices" },
      // Everything still owed us, whether or not it is late — the set the Business Home
      // "Unpaid Invoices" card counts, and that card links here. `posted` is in it because
      // it means finalized but not yet due (Net-D inside its terms), which is money owed.
      {
        id: "unpaid",
        label: "Unpaid",
        filters: [{ field: "status", op: "in", value: OPEN.join(",") }],
      },
      {
        id: "pending",
        label: "Pending",
        filters: [{ field: "status", op: "is", value: "pending" }],
      },
      { id: "posted", label: "Posted", filters: [{ field: "status", op: "is", value: "posted" }] },
      {
        id: "payment_due",
        label: "Payment Due",
        filters: [{ field: "status", op: "is", value: "payment_due" }],
      },
      {
        id: "not_paid",
        label: "Not Paid",
        filters: [{ field: "status", op: "is", value: "not_paid" }],
      },
      { id: "paid", label: "Paid", filters: [{ field: "status", op: "is", value: "paid" }] },
      { id: "voided", label: "Voided", filters: [{ field: "status", op: "is", value: "voided" }] },
      // Outstanding AR, which only became askable on 2026-08-31: `amount_due_minor`
      // filtered the raw issue-time COLUMN, which is never decremented as cash lands, so
      // `[gt]=0` matched nearly every settled invoice in the business — a view that said
      // "owed" and listed money already in the bank. The engine now compares the same
      // expression the API prints (`reportedAmountDueMinor`), so this means what it says.
      {
        id: "outstanding",
        label: "Outstanding",
        filters: [{ field: "amount_due_minor", op: "gt", value: "0" }],
      },
      // What collections has to chase this week: `in_next` (a new operator) against the
      // Net-D term, and the real balance test so a fully paid Net-30 invoice drops out.
      {
        id: "due_soon",
        label: "Due in the Next 7 Days",
        filters: [
          { field: "due_date", op: "in_next", value: "7" },
          { field: "amount_due_minor", op: "gt", value: "0" },
        ],
      },
      // Mid-chase. `status = payment_due` covers both a Net-D invoice nobody has chased
      // yet and one three retries in; only `dunning_status` separates them.
      {
        id: "in_dunning",
        label: "In Dunning",
        filters: [{ field: "dunning_status", op: "in", value: "in_progress,parked" }],
      },
      // Bad debt. `status` reads `paid` on these because the write-off note zeroed the
      // balance (INV-4), so the Paid view above cannot exclude them and nothing else on
      // the list tells them apart from money that actually arrived.
      {
        id: "written_off",
        label: "Written Off",
        filters: [{ field: "written_off", op: "is", value: "true" }],
      },
    ],
    [],
  );

  /**
   * Every column in the engine's `LIST_FILTERS` map (`src/modules/invoicing/service.ts`),
   * which is the authority on what exists — 14 of the 33 were offered here, so the other
   * 19 were columns the API could narrow on and no operator could reach.
   */
  const filterFields = React.useMemo<ListFilterField<Invoice>[]>(
    () => [
      { id: "number", label: "Invoice Number", group: "Identity", serverOps: TEXT_OPS },
      { id: "id", label: "Invoice Id", group: "Identity", serverOps: TEXT_OPS_NN },
      {
        id: "po_number",
        label: "PO Number",
        group: "Identity",
        serverOps: TEXT_OPS,
        keywords: "purchase order",
      },

      {
        id: "status",
        label: "Status",
        type: "select",
        group: "Status",
        options: STATUS_OPTIONS,
        serverOps: ENUM_OPS_NN,
      },
      {
        id: "written_off",
        label: "Written Off",
        type: "boolean",
        group: "Status",
        serverOps: ["is"],
        hint: "Bad debt. The status shows Paid because the write-off note set the balance to zero",
        keywords: "bad debt write-off",
      },

      { id: "customer", label: "Customer Id", group: "Customer", serverOps: TEXT_OPS_NN },
      { id: "customer_name", label: "Customer Name", group: "Customer", serverOps: TEXT_OPS },
      { id: "customer_email", label: "Customer Email", group: "Customer", serverOps: TEXT_OPS },

      // `is empty` here is how "one-off invoices only" gets asked. The engine has no
      // `recurring` column and no `recurring` field in the response, so there is no
      // second field of that name — one predicate, one name.
      {
        id: "subscription",
        label: "Subscription Id",
        group: "Subscription",
        serverOps: TEXT_OPS,
        hint: "Empty means a one-off invoice with no subscription behind it",
        keywords: "recurring one-off",
      },

      {
        id: "currency",
        label: "Currency",
        group: "Amounts",
        serverOps: ENUM_OPS_NN,
        // Free text rather than a select on purpose: unlike status, the currency
        // vocabulary is ISO-4217, not a closed set this list can enumerate honestly.
        hint: "ISO-4217 code, for example INR or USD",
      },
      {
        id: "subtotal_minor",
        label: "Sub Total (minor units)",
        type: "number",
        group: "Amounts",
        serverOps: NUM_OPS_NN,
        hint: MINOR_HINT,
      },
      {
        id: "total_minor",
        label: "Amount (minor units)",
        type: "number",
        group: "Amounts",
        serverOps: NUM_OPS_NN,
        hint: MINOR_HINT,
        keywords: "total",
      },
      {
        id: "promotional_discount_minor",
        label: "Promotional Discount (minor units)",
        type: "number",
        group: "Amounts",
        serverOps: NUM_OPS_NN,
        hint: "Minor units. The promotional credit part. We apply it before tax, and Amount already excludes it",
        keywords: "promotional credits discount",
      },
      {
        id: "credits_applied_minor",
        label: "Credits Applied (minor units)",
        type: "number",
        group: "Amounts",
        serverOps: NUM_OPS_NN,
        hint: "Minor units. Only balance credit applied after tax: refundable and excess. It never includes promotional credit",
      },
      {
        id: "amount_paid_minor",
        label: "Amount Paid (minor units)",
        type: "number",
        group: "Amounts",
        serverOps: NUM_OPS_NN,
        hint: "Minor units. The cash that we collected. This is the sum of successful payments",
      },
      {
        id: "amount_due_minor",
        label: "Amount Due (minor units)",
        type: "number",
        group: "Amounts",
        serverOps: NUM_OPS_NN,
        hint: "Minor units. The amount that we can STILL collect, after payments. It is zero after a void or write-off",
        keywords: "outstanding owed balance",
      },
      {
        id: "withholding_minor",
        label: "Withholding (minor units)",
        type: "number",
        group: "Amounts",
        serverOps: NUM_OPS_NN,
        hint: MINOR_HINT,
        keywords: "tds tax withheld",
      },

      {
        id: "created_at",
        label: "Created",
        type: "date",
        group: "Dates",
        serverOps: DATE_OPS_NN,
        keywords: "created invoice date",
      },
      {
        id: "period_start",
        label: "Period Start",
        type: "date",
        group: "Dates",
        serverOps: DATE_OPS,
      },
      // Compared as the list PRINTS it: a business that reports period ends inclusively
      // stores 26-Aug 00:00 for a row showing "25 Aug", and the engine backs that off.
      { id: "period_end", label: "Period End", type: "date", group: "Dates", serverOps: DATE_OPS },
      { id: "paid_at", label: "Paid On", type: "date", group: "Dates", serverOps: DATE_OPS },
      { id: "voided_at", label: "Voided On", type: "date", group: "Dates", serverOps: DATE_OPS },

      {
        id: "due_date",
        label: "Due Date",
        type: "date",
        group: "Collection",
        serverOps: DATE_OPS,
        hint: "Empty means due on issue, with no Net-D term",
      },
      {
        id: "expected_payment_date",
        label: "Expected Payment Date",
        type: "date",
        group: "Collection",
        serverOps: DATE_OPS,
        hint: "A collections forecast that a person sets. Dunning never changes it",
      },
      {
        id: "dunning_status",
        label: "Dunning Status",
        type: "select",
        group: "Collection",
        options: DUNNING_OPTIONS,
        serverOps: ENUM_OPS,
        hint: "Empty until collections first chases the invoice",
      },
      {
        id: "ar_bucket",
        label: "Ageing Bucket",
        type: "select",
        group: "Collection",
        options: AR_BUCKET_OPTIONS,
        serverOps: ENUM_OPS,
        hint: "How long the invoice is overdue, counted from its due date. The values are the receivables aging buckets",
        keywords: "aging aging overdue receivables ar",
      },
      {
        id: "attempt_count",
        label: "Dunning Attempts",
        type: "number",
        group: "Collection",
        serverOps: NUM_OPS_NN,
      },
      {
        id: "next_attempt_at",
        label: "Next Retry",
        type: "date",
        group: "Collection",
        serverOps: DATE_OPS,
      },
      {
        id: "dunning_exhausted_at",
        label: "Retries Exhausted On",
        type: "date",
        group: "Collection",
        serverOps: DATE_OPS,
      },

      // The tax determination as FROZEN at issue, which is what makes it filterable:
      // re-deriving from current config would move historical rows in and out of a
      // result set the operator already exported.
      {
        id: "tax_treatment",
        label: "Tax Treatment",
        type: "select",
        group: "Tax",
        options: TREATMENT_OPTIONS,
        serverOps: ENUM_OPS,
      },
      {
        id: "place_of_supply_code",
        label: "Place of Supply",
        group: "Tax",
        serverOps: ENUM_OPS,
        hint: "Subdivision code at issue, for example TN, KA or CA",
        keywords: "gst state",
      },
      {
        id: "seller_state_code",
        label: "Seller State Code",
        group: "Tax",
        serverOps: ENUM_OPS,
        hint: "The seller state that selected CGST+SGST or IGST. It does not change after issue",
      },
      {
        id: "tax_note",
        label: "Tax Note",
        group: "Tax",
        serverOps: TEXT_OPS,
        keywords: "reverse charge sez export",
      },

      {
        id: "channel",
        label: "Channel",
        type: "select",
        group: "Other",
        options: CHANNEL_OPTIONS,
        serverOps: ENUM_OPS,
        hint: "Empty on invoices created before we recorded the channel",
      },
      { id: "imported", label: "Imported", type: "boolean", group: "Other", serverOps: ["is"] },
    ],
    [],
  );

  return (
    <ListPage
      page={page}
      entity={{ singular: "Invoice", plural: "Invoices" }}
      columns={columns}
      data={rows}
      server={{ total, hasMore, nextCursor, fetchPage }}
      segments={segments}
      // Voided On and PO Number are optional columns — present in the chooser,
      // off by default so the default view stays readable.
      initialHidden={["voided_at", "po_number"]}
      filterFields={filterFields}
      initialFilters={initialFilters}
      savedViews={{ entity: "invoices", biz }}
      sortOptions={[
        { id: "created_at", label: "Created" },
        { id: "total_minor", label: "Amount" },
        { id: "status", label: "Status" },
        { id: "period_end", label: "Period End" },
        // Backed by `LIST_SORTS.due_date`; the two due-date views above are far more
        // useful ordered by when the money is expected than by when we billed.
        { id: "due_date", label: "Due Date" },
      ]}
      createSlot={createSlot}
      searchPlaceholder="Search for number / ID…"
      searchHint={<PaletteSearchHint />}
      exportName="invoices"
      persistKey={`invoices:${biz}`}
      enableSelection
      rowHref={(i) => `/businesses/${biz}/invoices/${i.id}`}
      emptyState={
        <EmptyState
          icon={<Receipt />}
          title="No invoices"
          description="No invoices match this view or search."
        />
      }
    />
  );
}
