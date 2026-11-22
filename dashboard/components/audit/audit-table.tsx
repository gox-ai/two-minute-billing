"use client";

import * as React from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ListPage,
  type ListFilterField,
  type ListSegment,
  type ListPageHeader,
} from "@/components/patterns/list-page";
import { makeListSource } from "@/lib/list-source";
import { fmtDateTime } from "@/lib/format-date";
import { actionTitle, actorLabel, sourceLabel } from "@/components/audit/labels";
import type { AuditLog, AuditSource } from "@/lib/api/audit";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Chip } from "@/components/patterns/chip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MiddleEllipsis } from "@/components/patterns/id-text";
import { cn } from "@/lib/utils";
import { useDisplayTz } from "@/components/business-tz";

// ---------------------------------------------------------------------------
// Source chip
// ---------------------------------------------------------------------------

const SOURCE_TONE: Record<string, React.ComponentProps<typeof Chip>["tone"]> = {
  // An integration, a person, or a customer on a hosted page: actor types, not urgency.
  api: "blue",
  dashboard: "blue",
  checkout: "blue",
  portal: "blue",
  assistant: "blue",
  mcp: "blue",
  // A gateway or another system told us: no one at our end acted.
  webhook: "tan",
  hubspot: "tan",
  billing_clock: "tan",
  migration: "green",
  // `system` — a seed or a verify run, nothing to act on, so the default tone.
};

/** `checkout` / `portal` for a customer's own action (its actor is the session), else `source`. */
function entrySource(row: AuditLog): string {
  return row.channel ?? row.source;
}

function SourceChip({ row }: { row: AuditLog }) {
  const source = entrySource(row);
  return <Chip tone={SOURCE_TONE[source as AuditSource] ?? "gray"}>{sourceLabel(source)}</Chip>;
}

/** Customer page of a checkout/portal actor, when the session's customer is known. */
function customerHref(row: AuditLog): string | null {
  const c = row.actor_customer;
  return row.channel && c && row.business_id
    ? `/businesses/${row.business_id}/customers/${c.id}`
    : null;
}

/**
 * An actor on one line. A checkout or portal session reads as its customer, linked; a
 * session with no customer reads "Customer". Api key ids are tokens, cut in the middle.
 */
function ActorText({ row }: { row: AuditLog }) {
  if (row.channel) {
    const href = customerHref(row);
    const name = row.actor_customer?.name ?? "Customer";
    return href ? (
      <Link href={href} className="block max-w-48 truncate text-sm text-primary hover:underline">
        {name}
      </Link>
    ) : (
      <span className="text-sm text-foreground">Customer</span>
    );
  }
  const { text, mono } = actorLabel(row.actor);
  if (mono) return <MiddleEllipsis value={text} className="max-w-48 text-xs" />;
  return <OneLine value={text} className="max-w-48 text-sm text-foreground" />;
}

/** One line, cut at the end; the whole value is in the tooltip. */
function OneLine({
  value,
  tip,
  className,
}: {
  value: string;
  /** Tooltip text, when it differs from `value`. */
  tip?: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("block min-w-0 truncate", className)}>{value}</span>
      </TooltipTrigger>
      <TooltipContent className="break-all">{tip ?? value}</TooltipContent>
    </Tooltip>
  );
}

/** A business row's full record page (0149); org-global rows have none. */
function recordHref(row: AuditLog): string | undefined {
  if (!row.business_id) return undefined;
  const q = row.resource_type ? `?source=${encodeURIComponent(row.resource_type)}` : "";
  return `/businesses/${row.business_id}/audit/${row.id}${q}`;
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value == null) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <pre className="overflow-x-auto rounded-md border bg-muted p-3 text-xs leading-relaxed wrap-break-word whitespace-pre-wrap">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function AuditDetailDrawer({
  row,
  open,
  onClose,
}: {
  row: AuditLog | null;
  open: boolean;
  onClose: () => void;
}) {
  // Business zone inside /businesses/[biz]; on the org-wide /audit page there is no
  // business, so this resolves to the ORGANIZATION's zone and only then to UTC.
  const tz = useDisplayTz();
  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <SheetContent className="overflow-y-auto sm:max-w-xl">
        {row && (
          <>
            <SheetHeader>
              <SheetTitle className="font-mono text-base">{row.action}</SheetTitle>
            </SheetHeader>

            <div className="mt-6 space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">When</p>
                  <p>{fmtDateTime(row.created_at, tz)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Source</p>
                  <SourceChip row={row} />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Actor</p>
                  <ActorText row={row} />
                  {row.channel && row.actor ? (
                    <p className="font-mono text-xs wrap-anywhere text-muted-foreground">
                      {row.actor}
                    </p>
                  ) : null}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Resource</p>
                  <p className="font-mono text-xs">
                    {row.resource_type ?? "—"}
                    {row.resource_id ? ` / ${row.resource_id}` : ""}
                  </p>
                </div>
                {row.business_id ? (
                  <div className="col-span-2">
                    <p className="text-xs text-muted-foreground">Business</p>
                    <p className="font-mono text-xs">{row.business_id}</p>
                  </div>
                ) : null}
              </div>

              {/* The full record page (0149) — prose summary, every resource this
                  action touched, and the contextual before/after diff. Only for rows
                  that belong to a business: the detail route is business-scoped, and
                  an org-global action (key rotation, cross-business admin) has no
                  page to link to, so the JSON below stays the whole answer there. */}
              {recordHref(row) ? (
                <Link
                  href={recordHref(row)!}
                  className="inline-block text-sm text-primary hover:underline"
                >
                  View full record and diff
                </Link>
              ) : null}

              <hr />

              <JsonBlock label="Before" value={row.before} />
              <JsonBlock label="After" value={row.after} />
              <JsonBlock label="Full record" value={row} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/**
 * Operators the endpoint implements, per column kind — `AUDIT_FILTER_OPS` is
 * `opsFromSpecs(FILTERS)`, so every field gets the whole table for its kind
 * (`src/platform/list-query.ts`).
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

function makeColumns(
  showBusiness: boolean,
  businessNames: Record<string, string>,
  onView: (row: AuditLog) => void,
  /** The zone to render in — business, else organization, else UTC (`useDisplayTz`). */
  tz: string,
): ColumnDef<AuditLog>[] {
  const bizName = (id: string | null | undefined) => (id ? (businessNames[id] ?? id) : "");
  const cols: ColumnDef<AuditLog>[] = [
    {
      id: "created_at",
      header: "Created",
      accessorFn: (r) => r.created_at,
      meta: { phone: "hide" },
      cell: ({ getValue }) => (
        <span className="text-sm whitespace-nowrap text-muted-foreground">
          {fmtDateTime(getValue<string>(), tz)}
        </span>
      ),
    },
    {
      id: "actor",
      header: "Actor",
      // The export keeps the raw actor (a session id for a customer) and adds the customer.
      accessorFn: (r) => r.actor ?? "",
      meta: {
        phone: "hide",
        exportAs: [
          { header: "Actor", value: (r) => r.actor ?? "" },
          { header: "Actor customer", value: (r) => r.actor_customer?.id ?? "" },
        ],
      },
      cell: ({ row }) => <ActorText row={row.original} />,
    },
    {
      id: "source",
      header: "Source",
      accessorFn: (r) => entrySource(r),
      meta: {
        phone: "hide",
        exportAs: [
          { header: "Source", value: (r) => r.source },
          { header: "Channel", value: (r) => r.channel ?? "" },
        ],
      },
      cell: ({ row }) => <SourceChip row={row.original} />,
    },
    {
      id: "action",
      header: "Action",
      meta: { grow: true, phone: "title" },
      accessorFn: (r) => r.action,
      // Keyboard path to the entry: a link to the record page, or the drawer for an
      // org-global row (no business, so no record page). The row itself is pressable too.
      cell: ({ row }) => {
        const r = row.original;
        const href = recordHref(r);
        const title = (
          <OneLine value={actionTitle(r.action)} tip={r.action} className="font-medium" />
        );
        return (
          <span className="flex w-0 min-w-full flex-col text-sm">
            <span className="flex min-w-0 items-baseline gap-2">
              {href ? (
                <Link href={href} className="block min-w-0 text-foreground hover:underline">
                  {title}
                </Link>
              ) : (
                <button
                  type="button"
                  className="block min-w-0 text-start text-foreground hover:underline"
                  onClick={() => onView(r)}
                >
                  {title}
                </button>
              )}
              {/* Phone: the business shares the action's line, so line 2 has the full width. */}
              {showBusiness && r.business_id ? (
                <span className="ms-auto hidden max-w-[45%] shrink-0 truncate text-muted-foreground list-narrow:block">
                  {bizName(r.business_id)}
                </span>
              ) : null}
            </span>
            <span className="mt-0.5 hidden min-w-0 items-center gap-1 text-xs text-muted-foreground list-narrow:flex">
              <span className="shrink-0">{fmtDateTime(r.created_at, tz)}</span>
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate [&_*]:text-xs">
                <ActorText row={r} />
              </span>
              <span aria-hidden>·</span>
              <span className="shrink-0">{sourceLabel(entrySource(r))}</span>
            </span>
          </span>
        );
      },
    },
    {
      id: "resource",
      header: "Resource",
      accessorFn: (r) => [r.resource_type, r.resource_id].filter(Boolean).join(" / "),
      meta: { phone: "hide" },
      cell: ({ getValue }) => (
        <span className="text-sm text-muted-foreground">{getValue<string>() || "—"}</span>
      ),
    },
  ];

  if (showBusiness) {
    cols.push({
      id: "business_id",
      header: "Business",
      accessorFn: (r) => r.business_id ?? "",
      meta: {
        phone: "hide",
        exportAs: [{ header: "Business", value: (r) => r.business_id ?? "" }],
      },
      cell: ({ getValue }) => {
        const id = getValue<string>();
        return id ? (
          <OneLine
            value={bizName(id)}
            tip={id}
            className="max-w-40 text-sm text-muted-foreground"
          />
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        );
      },
    });
  }

  return cols;
}

/**
 * Backed by the **paginated** audit-log endpoints (LOG-4): search, the filter
 * builder and scroll all run server-side, since an audit trail is exactly the
 * append-only, unbounded list `docs/GUIDE.md` §3.4 requires a cursor for. The
 * first page is server-rendered by the page; later pages stream in through
 * `/api/lists/audit_logs` (business-scoped) or `/api/lists/org_audit_logs`
 * (the org-wide `/audit` page, which has no single `biz`).
 */
export function AuditTable({
  page,
  rows,
  total,
  hasMore,
  nextCursor,
  showBusiness = false,
  businessNames = {},
  /** Omit on the org-wide `/audit` page — it has no single business. */
  biz,
}: {
  /** The page header, drawn by the list (see ListPage.page). */
  page?: ListPageHeader;
  rows: AuditLog[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  showBusiness?: boolean;
  /** `biz_` id → name, for the Business column on the org-wide page. */
  businessNames?: Record<string, string>;
  biz?: string;
}) {
  // Dates render in the business timezone, falling back to the ORGANIZATION's on the
  // org-wide /audit page — never bare UTC unless neither is set (components/business-tz).
  const tz = useDisplayTz();
  const [selected, setSelected] = React.useState<AuditLog | null>(null);

  const columns = React.useMemo(
    () => makeColumns(showBusiness, businessNames, setSelected, tz),
    [showBusiness, businessNames, tz],
  );

  const fetchPage = React.useMemo(
    () => makeListSource<AuditLog>(biz ? "audit_logs" : "org_audit_logs", biz),
    [biz],
  );

  // Segments compile to server filters (AUDIT_FILTER_OPS in
  // src/modules/audit/service.ts), so a view narrows the whole trail, not just
  // the loaded page. "Writes" and "Via a user" (from the old client-filtered
  // version) needed a regex / not-starts-with match the engine's filter ops
  // don't offer (`text` ops: is/is_not/contains/starts_with/is_present) — no
  // equivalent server filter exists, so they're omitted rather than shipped as
  // segments that would silently stop narrowing the full trail.
  const segments = React.useMemo<ListSegment<AuditLog>[]>(
    () => [
      { id: "all", label: "All entries" },
      // Keys, webhook endpoints, gateway accounts, integrations, mail transport, team,
      // the 2FA requirement and data exports: `SECURITY_ACTION_PREFIXES` on the engine.
      {
        id: "security",
        label: "Security",
        filters: [{ field: "category", op: "is", value: "security" }],
      },
      // An org's integration keys are the only actors shaped `key_…`.
      {
        id: "api",
        label: "Via API key",
        filters: [{ field: "actor", op: "starts_with", value: "key_" }],
      },
      // A dashboard action is attributed to the SIGNED-IN OPERATOR — `dashboardActor`
      // records `user.email` (0150 + 0151) — so an `@` is exactly what separates an
      // operator from every named non-human actor (`system`, `dashboard`,
      // `billing_clock`), from a `key_…` id, and from a buyer's portal/checkout session
      // id. "Operator", not "person", for that last reason: a self-serve portal action
      // is a person too, and this view does not include it.
      {
        id: "operator",
        label: "By an operator",
        filters: [{ field: "actor", op: "contains", value: "@" }],
      },
      // The durable clock's own passes — renewals, dunning, retries. Named actor, see
      // NAMED_ACTORS in components/audit/labels.
      {
        id: "clock",
        label: "Billing clock",
        filters: [{ field: "actor", op: "is", value: "billing_clock" }],
      },
      // `system` is the honest actor for a seed or a verify run: no human, no request.
      { id: "system", label: "System", filters: [{ field: "actor", op: "is", value: "system" }] },
    ],
    [],
  );

  /**
   * `AUDIT_FILTER_OPS` (src/modules/audit/service.ts): five columns, each with the full
   * operator table for its kind (`opsFromSpecs`). The sixth, `category`, is reached
   * through the "Security" segment only. The ops were a hand-written
   * subset and withheld set membership, ranges and relative windows the endpoint
   * already answered.
   *
   * ⚠ `source` and `business_id` render as COLUMNS but are not in the engine's map, so
   * there is deliberately no filter for either — the Activity Log's own source chips
   * are the only way to narrow by source today. Two more views ("Writes", "Via a user"
   * in the pre-server version) were dropped for the same reason: they needed a regex /
   * not-starts-with match the operator vocabulary does not have.
   */
  const filterFields = React.useMemo<ListFilterField<AuditLog>[]>(
    () => [
      { id: "action", label: "Action", group: "Identity", serverOps: TEXT_OPS },
      { id: "actor", label: "Actor", group: "Identity", serverOps: TEXT_OPS },
      { id: "resource_type", label: "Resource type", group: "Other", serverOps: TEXT_OPS },
      { id: "resource_id", label: "Resource id", group: "Other", serverOps: TEXT_OPS },
      { id: "created_at", label: "Created", type: "date", group: "Dates", serverOps: DATE_OPS },
    ],
    [],
  );

  return (
    <>
      <ListPage
        page={page}
        entity={{ singular: "Entry", plural: "Entries" }}
        columns={columns}
        data={rows}
        server={{ total, hasMore, nextCursor, fetchPage }}
        segments={segments}
        filterFields={filterFields}
        // Two entity keys, keyed off the same `biz` the fetcher is: the org-wide
        // `/audit` page spans every business, so its views are stored against a NULL
        // business — a view saved there must not appear inside one business's log, and
        // vice versa. The field set is identical, which is why they share this table.
        savedViews={biz ? { entity: "audit_logs", biz } : { entity: "org_audit_logs" }}
        sortOptions={[{ id: "created_at", label: "Created" }]}
        // Across businesses the Business column needs the room; the resource stays in the
        // chooser and on each entry's page.
        initialHidden={showBusiness ? ["resource"] : undefined}
        searchPlaceholder="Search actions, actors…"
        pageSize={25}
        persistKey={showBusiness ? "audit-org" : "audit-biz"}
        exportName="audit-log"
        rowHref={recordHref}
      />
      <AuditDetailDrawer
        row={selected}
        open={selected !== null}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
