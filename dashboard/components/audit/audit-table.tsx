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
import { fmtDateTime, fmtDateTimeShort } from "@/lib/format";
import { actorLabel } from "@/components/audit/labels";
import type { AuditLog, AuditSource } from "@/lib/api/audit";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDisplayTz } from "@/components/business-tz";

// ---------------------------------------------------------------------------
// Source chip
// ---------------------------------------------------------------------------

const SOURCE_TONE: Record<string, string> = {
  // api / dashboard are both ordinary actor types (an integration vs. a person), not
  // an urgency signal, so they share the "info" token — the label already tells them
  // apart, and the actor column names the person.
  api: "border-info/25 bg-info-soft text-info",
  dashboard: "border-info/25 bg-info-soft text-info",
  billing_clock: "border-warning/25 bg-warning-soft text-warning",
  migration: "border-success/25 bg-success-soft text-success",
  // `system` — a seed or a verify run, nobody to attribute it to and nothing to act
  // on, so it stays neutral (the default tone).
};

function SourceChip({ source }: { source: string }) {
  const cls = SOURCE_TONE[source as AuditSource] ?? "border-border bg-muted text-muted-foreground";
  return (
    <Badge variant="outline" className={cn("font-mono text-xs font-medium", cls)}>
      {source}
    </Badge>
  );
}

/**
 * An actor cell. Named actors ("System", "Billing clock") are words, api key ids are
 * tokens — `actorLabel` decides which, so every audit surface renders them alike.
 */
function ActorText({ actor }: { actor: string | null }) {
  const { text, mono } = actorLabel(actor);
  return (
    <p className={cn("text-xs wrap-anywhere", mono ? "font-mono" : "text-foreground")}>{text}</p>
  );
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
                  <p className="font-mono">{fmtDateTime(row.created_at, tz)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Source</p>
                  <SourceChip source={row.source} />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Actor</p>
                  <ActorText actor={row.actor} />
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
              {row.business_id ? (
                <Link
                  href={`/businesses/${row.business_id}/audit/${row.id}${
                    row.resource_type ? `?source=${encodeURIComponent(row.resource_type)}` : ""
                  }`}
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
  onView: (row: AuditLog) => void,
  /** The zone to render in — business, else organization, else UTC (`useDisplayTz`). */
  tz: string,
): ColumnDef<AuditLog>[] {
  const cols: ColumnDef<AuditLog>[] = [
    {
      id: "created_at",
      header: "When",
      accessorFn: (r) => r.created_at,
      cell: ({ getValue }) => (
        <span className="font-mono text-xs text-muted-foreground">
          {fmtDateTimeShort(getValue<string>(), tz)}
        </span>
      ),
    },
    {
      id: "actor",
      header: "Actor",
      accessorFn: (r) => r.actor ?? "",
      cell: ({ getValue }) => <ActorText actor={getValue<string>() || null} />,
    },
    {
      id: "source",
      header: "Source",
      accessorFn: (r) => r.source,
      cell: ({ getValue }) => <SourceChip source={getValue<string>()} />,
    },
    {
      id: "action",
      header: "Action",
      accessorFn: (r) => r.action,
      cell: ({ getValue }) => (
        <span className="font-mono text-xs font-medium">{getValue<string>()}</span>
      ),
    },
    {
      id: "resource",
      header: "Resource",
      accessorFn: (r) => [r.resource_type, r.resource_id].filter(Boolean).join(" / "),
      cell: ({ getValue }) => (
        <span className="font-mono text-xs text-muted-foreground">{getValue<string>() || "—"}</span>
      ),
    },
  ];

  if (showBusiness) {
    cols.push({
      id: "business_id",
      header: "Business",
      accessorFn: (r) => r.business_id ?? "",
      cell: ({ getValue }) => (
        <span className="font-mono text-xs text-muted-foreground">{getValue<string>() || "—"}</span>
      ),
    });
  }

  cols.push({
    id: "_view",
    header: "",
    enableSorting: false,
    enableHiding: false,
    // A row that belongs to a business opens the RECORD PAGE (0149) — the same
    // destination the Activity Log's "Details" link uses, with the prose summary,
    // every resource the action touched and the contextual diff. It used to open a
    // drawer of raw before/after JSON, so the same audit entry looked like two
    // different features depending on which screen you reached it from.
    //
    // The drawer survives for ORG-GLOBAL rows only (`business_id` null — an API-key
    // rotation, a cross-business admin action). Those have no business-scoped page to
    // link to, and the drawer's JSON is the whole answer for them. Rendering a link
    // there would 404, which is why this branches instead of always linking.
    cell: ({ row }) =>
      row.original.business_id ? (
        <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
          <Link
            href={`/businesses/${row.original.business_id}/audit/${row.original.id}${
              row.original.resource_type
                ? `?source=${encodeURIComponent(row.original.resource_type)}`
                : ""
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            View
          </Link>
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={(e) => {
            e.stopPropagation();
            onView(row.original);
          }}
        >
          View
        </Button>
      ),
  });

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
  biz?: string;
}) {
  // Dates render in the business timezone, falling back to the ORGANIZATION's on the
  // org-wide /audit page — never bare UTC unless neither is set (components/business-tz).
  const tz = useDisplayTz();
  const [selected, setSelected] = React.useState<AuditLog | null>(null);

  const columns = React.useMemo(
    () => makeColumns(showBusiness, setSelected, tz),
    [showBusiness, tz],
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
      { id: "all", label: "All Entries" },
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
      { id: "created_at", label: "When", type: "date", group: "Dates", serverOps: DATE_OPS },
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
        sortOptions={[{ id: "created_at", label: "When" }]}
        searchPlaceholder="Search actions, actors…"
        pageSize={25}
        persistKey={showBusiness ? "audit-org" : "audit-biz"}
        exportName="audit-log"
      />
      <AuditDetailDrawer
        row={selected}
        open={selected !== null}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
