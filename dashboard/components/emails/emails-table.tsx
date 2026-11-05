"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ListPage,
  type ListFilterField,
  type ListSegment,
  type ListPageHeader,
} from "@/components/patterns/list-page";
import { makeListSource } from "@/lib/list-source";
import { TextCell, TruncateCell } from "@/components/patterns/list-cells";
import { Chip } from "@/components/patterns/chip";
// From `@/lib/email-types`, NOT `@/lib/api/emails`. The latter is a server module (its
// fetchers reach `next/headers` for the session cookie), so a VALUE import from this
// 'use client' file would pull that chain into the browser bundle and 500 the route with an
// empty body. That constraint is real — but the duplicate predicate it used to justify is
// what let `ses` be missed here, so the shared copy now lives in a module with no
// 'use client' and no runtime server import, which both sides can read.
import { EMAIL_TYPES, emailTypeLabel, isRealDelivery, transportLabel } from "@/lib/email-types";
import { EmailDetailDialog, emailStatusTone } from "@/components/emails/email-detail-dialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/states";
import { fmtDateTimeShort } from "@/lib/format";
import { Mail } from "lucide-react";
import { type EmailMessage } from "@/lib/api/emails";
import { useBusinessTz } from "@/components/business-tz";

/**
 * The engine's operator tables, copied verbatim from `src/platform/list-query.ts`
 * (reached here through `EMAIL_FILTER_OPS`). The old hand-narrowed lists offered five of
 * nine text and three of nine date operators, so `is one of`, `between` and `in the last
 * N days` existed in SQL and were unreachable from the screen.
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
 * `customer` is a VIRTUAL field, not a column: the engine resolves it with an EXISTS
 * sub-query over `customers.public_id` and therefore implements only these three
 * (`CUSTOMER_FIELD` in src/modules/emails/service.ts). Giving it TEXT_OPS would offer a
 * `contains` the route rejects.
 */
const CUSTOMER_OPS = ["is", "is_not", "is_present"];

/**
 * The engine's own status vocabulary, written out rather than derived from the loaded
 * page: a page of successes offered no way to filter for `bounced`, which is the status
 * an operator opens this log to find.
 */
const STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "sent", label: "Sent" },
  { value: "failed", label: "Failed" },
  { value: "bounced", label: "Bounced" },
  { value: "skipped", label: "Skipped" },
];

/**
 * Every billing email the engine knows, under the name the rest of the product uses for
 * it (Settings → Email notifications, the template editor). Derived from EMAIL_TYPES so a
 * new type cannot reach the settings hub and be missing from this filter — which is
 * exactly how a page-derived option list fails, silently.
 */
const TYPE_OPTIONS = EMAIL_TYPES.map((t) => ({ value: t.key, label: t.label }));

/**
 * Read-only customer billing-email log with a rendered-body inspector + resend.
 * Backed by the **paginated** emails endpoint: segments, the filter builder and
 * sort run server-side (see `GET /v1/businesses/:biz/emails`), and rows stream
 * in on scroll. The first page is server-rendered; every later page comes
 * through `/api/lists/emails` so the org API key stays server-side.
 */
export function EmailsTable({
  page,
  biz,
  rows,
  total,
  hasMore,
  nextCursor,
  initialFilters,
}: {
  /** The page header, drawn by the list (see ListPage.page). */
  page?: ListPageHeader;
  biz: string;
  /** First page, server-rendered. */
  rows: EmailMessage[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** A deep link's narrowing, read off the URL by the page so the pills and Clear see it. */
  initialFilters?: Array<{ field: string; op: string; value: string }>;
}) {
  // Dates render in the business timezone, not UTC (see components/business-tz).
  const tz = useBusinessTz();
  const [detail, setDetail] = React.useState<EmailMessage | null>(null);

  // Pages come through /api/lists/emails.
  const fetchPage = React.useMemo(() => makeListSource<EmailMessage>("emails", biz), [biz]);

  const columns = React.useMemo<ColumnDef<EmailMessage>[]>(
    () => [
      {
        accessorKey: "created_at",
        id: "created_at",
        header: "Time",
        cell: ({ row }) => <TextCell>{fmtDateTimeShort(row.original.created_at, tz)}</TextCell>,
      },
      {
        accessorKey: "type",
        header: "Type",
        // The label the settings use; the key stays on hover for anyone matching logs.
        cell: ({ row }) => (
          <span className="text-sm" title={row.original.type}>
            {emailTypeLabel(row.original.type)}
          </span>
        ),
      },
      {
        accessorKey: "to",
        header: "To",
        cell: ({ row }) => (
          <span className="block max-w-80 text-sm wrap-anywhere">{row.original.to}</span>
        ),
      },
      {
        accessorKey: "subject",
        header: "Subject",
        cell: ({ row }) => <TruncateCell value={row.original.subject} width="max-w-96" />,
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <Chip
            tone={emailStatusTone(row.original.status, row.original.transport)}
            className="text-xs uppercase"
          >
            {row.original.status}
          </Chip>
        ),
      },
      {
        accessorKey: "transport",
        id: "transport",
        header: "Transport",
        // Not sortable/filterable: the engine exposes no operators for this column, and
        // a header that sorts nothing is worse than a plain one.
        enableSorting: false,
        // Muted = did not deliver. Through the shared predicate, not a third hand-listed
        // pair: this line was the one enumeration the `ses` fix first missed, so an SES row
        // read grey here while its status chip had already been corrected to green.
        cell: ({ row }) => (
          <span
            className={
              isRealDelivery("sent", row.original.transport)
                ? "text-sm"
                : "text-sm text-muted-foreground"
            }
          >
            {transportLabel(row.original.transport)}
          </span>
        ),
      },
    ],
    [],
  );

  // Segments compile to server filters, so a view narrows all the business's
  // emails — not just the page on screen.
  const segments = React.useMemo<ListSegment<EmailMessage>[]>(
    () => [
      { id: "all", label: "All Emails" },
      { id: "sent", label: "Sent", filters: [{ field: "status", op: "is", value: "sent" }] },
      {
        id: "pending",
        label: "Pending",
        filters: [{ field: "status", op: "is", value: "pending" }],
      },
      { id: "failed", label: "Failed", filters: [{ field: "status", op: "is", value: "failed" }] },
      {
        id: "bounced",
        label: "Bounced",
        filters: [{ field: "status", op: "is", value: "bounced" }],
      },
      {
        id: "skipped",
        label: "Skipped",
        filters: [{ field: "status", op: "is", value: "skipped" }],
      },
    ],
    [],
  );

  /**
   * Every field in the engine's `EMAIL_FILTER_OPS` — its six columns plus the virtual
   * `customer` — and nothing else. This list is short because the engine's map is short,
   * not because the screen is being coy.
   *
   * Two fields this table RENDERS are deliberately not offered, both for the same reason:
   * the engine has no filter for them, so the row would 400 on Apply.
   *   • `attempts` — was shipped here once and had to be deleted (there is no such
   *     column in `LIST_FILTERS`); it survives as a row in the detail drawer.
   *   • `transport` — the Transport column already declines to sort for the same reason
   *     (see `enableSorting: false` above). "Sent by SMTP but not by the console sink" has
   *     to be asked as a status filter until the engine indexes the column.
   */
  const filterFields = React.useMemo<ListFilterField<EmailMessage>[]>(
    () => [
      { id: "id", label: "Email Id", group: "Identity", serverOps: TEXT_OPS },
      {
        id: "subject",
        label: "Subject",
        group: "Identity",
        serverOps: TEXT_OPS,
        keywords: "line title",
      },

      {
        id: "type",
        label: "Type",
        type: "select",
        group: "Delivery",
        options: TYPE_OPTIONS,
        serverOps: ENUM_OPS,
      },
      {
        id: "status",
        label: "Status",
        type: "select",
        group: "Delivery",
        options: STATUS_OPTIONS,
        serverOps: ENUM_OPS,
        hint: "A 'sent' row went out only if a real relay carried it. The Transport column shows the relay.",
      },

      {
        id: "to",
        label: "To",
        group: "Customer",
        serverOps: TEXT_OPS,
        hint: "The address that we sent the message to. It is not always the current address of the customer.",
        keywords: "recipient address email",
      },
      {
        id: "customer",
        label: "Customer Id",
        group: "Customer",
        serverOps: CUSTOMER_OPS,
        hint: "The customer of this message (cus_…). Some emails have no customer. Use “is empty” to find them.",
      },

      { id: "created_at", label: "Time", type: "date", group: "Dates", serverOps: DATE_OPS },
    ],
    [],
  );

  return (
    <>
      <ListPage
        page={page}
        entity={{ singular: "Email", plural: "Emails" }}
        columns={columns}
        data={rows}
        server={{ total, hasMore, nextCursor, fetchPage }}
        segments={segments}
        filterFields={filterFields}
        initialFilters={initialFilters}
        savedViews={{ entity: "emails", biz }}
        // Sort ids are the API's sortable fields (see EMAIL_SORT_FIELDS).
        sortOptions={[{ id: "created_at", label: "Time" }]}
        searchPlaceholder="Search for recipient / subject / id…"
        exportName="emails"
        persistKey={`emails:${biz}`}
        rowMenu={(e) => (
          <Button variant="ghost" size="sm" onClick={() => setDetail(e)}>
            View
          </Button>
        )}
        emptyState={
          <EmptyState
            icon={<Mail />}
            title="No emails"
            description="No emails match this view or search."
          />
        }
      />
      <EmailDetailDialog biz={biz} email={detail} onClose={() => setDetail(null)} />
    </>
  );
}
