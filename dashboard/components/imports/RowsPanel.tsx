"use client";

import * as React from "react";
import type {
  ImportEntity,
  ImportRow,
  ImportRowPage,
  RowOutcome,
  RowQuery,
  RowState,
} from "@/lib/api/imports";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/patterns/chip";
import { SelectField } from "@/components/ui/select-field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FLUSH } from "@/components/transfer/RouteBand";
import { cn } from "@/lib/utils";
import { useDefaultState } from "@/lib/use-default-state";
import { ENTITY_LABEL, fieldLabel, fmt } from "./labels";

export type ListRowsAction = (
  biz: string,
  run: string,
  query: RowQuery,
) => Promise<ImportRowPage | null>;

export interface RowTab {
  id: string;
  label: string;
  /** Count per section; the tab's figure is their sum. */
  counts: Partial<Record<ImportEntity, number>>;
  sub: string;
  red?: boolean;
  filter: { state?: RowState; outcome?: RowOutcome };
}

const PAGE = 50;

const STATE_CHIP: Record<RowState, { label: string; tone: "blue" | "gray" | "red" }> = {
  new: { label: "New", tone: "blue" },
  existing: { label: "In this business", tone: "gray" },
  invalid: { label: "Blocked", tone: "red" },
  excluded: { label: "Left out", tone: "gray" },
};

const OUTCOME_CHIP: Record<RowOutcome, { label: string; tone: "green" | "gray" | "red" }> = {
  created: { label: "Added", tone: "green" },
  unchanged: { label: "Not changed", tone: "gray" },
  failed: { label: "Failed", tone: "red" },
  excluded: { label: "Left out", tone: "gray" },
};

function RowChip({ row }: { row: ImportRow }) {
  const c = row.outcome
    ? OUTCOME_CHIP[row.outcome]
    : row.state
      ? STATE_CHIP[row.state]
      : { label: "Not checked", tone: "gray" as const };
  return <Chip tone={c.tone}>{c.label}</Chip>;
}

/** What to say about a row: the outcome, then errors, then warnings. */
function details(row: ImportRow): Array<{ text: string; level: "error" | "warning" | "info" }> {
  const out: Array<{ text: string; level: "error" | "warning" | "info" }> = [];
  if (row.outcome_message)
    out.push({ text: row.outcome_message, level: row.outcome === "failed" ? "error" : "info" });
  for (const e of row.errors)
    if (e.message !== row.outcome_message)
      out.push({ text: withField(e.field, e.message), level: "error" });
  for (const w of row.warnings) out.push({ text: withField(w.field, w.message), level: "warning" });
  return out;
}

const withField = (field: string | null, message: string) =>
  field ? `${fieldLabel(field)}: ${message}` : message;

/** The outcome strip, the sections, then the rows of the selected tab and section. */
export function RowsPanel({
  biz,
  runId,
  version,
  entities,
  tabs,
  initialTab,
  listRows,
  aside,
}: {
  biz: string;
  runId: string;
  /** Changes when the run's rows change (a new check): the list loads again. */
  version: string;
  entities: ImportEntity[];
  tabs: RowTab[];
  initialTab: string;
  listRows: ListRowsAction;
  /** Under the strip, above the rows: a blocked-rows banner. */
  aside?: (tab: string) => React.ReactNode;
}) {
  const [tab, setTab] = useDefaultState(initialTab);
  const [entity, setEntity] = React.useState<ImportEntity | "all">("all");
  const [rows, setRows] = React.useState<ImportRow[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  // The list on screen is for `loadedFor`; a different key means its first page is loading.
  const [loadedFor, setLoadedFor] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const current = tabs.find((t) => t.id === tab) ?? tabs[0]!;
  const sum = (t: RowTab, e: ImportEntity | "all") =>
    e === "all" ? Object.values(t.counts).reduce((n, c) => n + (c ?? 0), 0) : (t.counts[e] ?? 0);
  // Primitives, not the tab object: the parent builds `tabs` on every render.
  const { state, outcome } = current.filter;

  const query = React.useCallback(
    (after?: string): RowQuery => ({
      state,
      outcome,
      entity: entity === "all" ? undefined : entity,
      limit: PAGE,
      starting_after: after,
    }),
    [state, outcome, entity],
  );

  const key = `${runId}:${version}:${state}:${outcome}:${entity}`;
  const loading = loadedFor !== key || loadingMore;

  React.useEffect(() => {
    let live = true;
    listRows(biz, runId, query()).then((page) => {
      if (!live) return;
      setFailed(!page);
      setRows(page?.data ?? []);
      setHasMore(!!page?.has_more);
      setLoadedFor(key);
    });
    return () => {
      live = false;
    };
  }, [biz, runId, key, query, listRows]);

  async function more() {
    const last = rows[rows.length - 1];
    if (!last) return;
    setLoadingMore(true);
    const page = await listRows(biz, runId, query(last.id));
    setRows((r) => [...r, ...(page?.data ?? [])]);
    setHasMore(!!page?.has_more);
    setLoadingMore(false);
  }

  const shownOf = sum(current, entity);
  const sectionOptions = [
    { value: "all", label: "All sections", n: sum(current, "all") },
    ...entities.map((e) => ({ value: e, label: ENTITY_LABEL[e], n: sum(current, e) })),
  ];

  return (
    <section
      aria-label="Rows"
      className="anim-rise flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card"
    >
      <div role="tablist" aria-label="Result" className="flex flex-wrap gap-px border-b bg-border">
        {tabs.map((t) => {
          const n = sum(t, "all");
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "flex min-w-0 flex-[1_1_7rem] flex-col bg-card px-5 py-3 text-left transition-colors hover:bg-linear-to-r hover:from-muted/50 hover:to-muted/50 max-sm:px-3",
                tab === t.id && "shadow-[inset_0_-2px_0_var(--primary)]",
              )}
            >
              <span
                className={cn(
                  "text-xs",
                  tab === t.id ? "font-medium text-primary" : "text-muted-foreground",
                  t.red && n > 0 && "text-destructive",
                )}
              >
                {t.label}
              </span>
              <span
                className={cn(
                  "text-xl font-semibold tabular-nums",
                  t.red && n > 0 ? "text-destructive" : n === 0 && "text-muted-foreground",
                )}
              >
                {fmt(n)}
              </span>
              <span className="truncate text-xs text-muted-foreground max-sm:hidden">{t.sub}</span>
            </button>
          );
        })}
      </div>

      <div className="grid min-w-0 grid-cols-1 @min-[56.875rem]/main:grid-cols-[13rem_minmax(0,1fr)]">
        <nav
          aria-label="Sections"
          className="hidden flex-col gap-0.5 border-r p-3 @min-[56.875rem]/main:flex"
        >
          <span className="px-2.5 pb-1 text-xs text-muted-foreground">Sections</span>
          {sectionOptions.map((o) => (
            <button
              key={o.value}
              type="button"
              aria-current={entity === o.value ? "true" : undefined}
              onClick={() => setEntity(o.value as ImportEntity | "all")}
              className={cn(
                "flex h-9 items-center justify-between gap-2 rounded-md px-2.5 text-left text-sm transition-colors hover:bg-muted/60",
                entity === o.value
                  ? "bg-muted font-medium text-foreground"
                  : o.n === 0
                    ? "text-muted-foreground"
                    : "text-foreground",
              )}
            >
              <span className="truncate">{o.label}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{fmt(o.n)}</span>
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-col">
          {aside?.(tab)}
          <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
            <div className="w-56 max-w-full @min-[56.875rem]/main:hidden">
              <SelectField
                ariaLabel="Section"
                size="sm"
                value={entity}
                onValueChange={(v) => setEntity(v as ImportEntity | "all")}
                options={sectionOptions.map((o) => ({
                  value: o.value,
                  label: `${o.label} · ${fmt(o.n)}`,
                }))}
              />
            </div>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {loadedFor !== key ? "Loading…" : `Showing ${fmt(rows.length)} of ${fmt(shownOf)}`}
            </span>
          </div>
          {failed ? (
            <p className="m-0 px-5 py-4 text-sm text-destructive">
              We could not load the rows. Reload the page.
            </p>
          ) : !loading && rows.length === 0 ? (
            <p className="m-0 px-5 py-6 text-sm text-muted-foreground">No rows here.</p>
          ) : (
            <Table phone="stack" className={FLUSH}>
              <TableHeader>
                <TableRow>
                  <TableHead phone="title">Row</TableHead>
                  <TableHead>Section</TableHead>
                  <TableHead>Details</TableHead>
                  <TableHead phone="aside" className="text-right">
                    Result
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const d = details(r);
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="align-top whitespace-normal">
                        <div className="font-medium wrap-break-word">{r.source_id ?? "No ID"}</div>
                        <div className="text-xs text-muted-foreground tabular-nums">
                          Row {fmt(r.row_number)}
                        </div>
                      </TableCell>
                      <TableCell className="align-top whitespace-normal">
                        {ENTITY_LABEL[r.entity]}
                      </TableCell>
                      <TableCell className="max-w-120 align-top whitespace-normal">
                        {d.length ? (
                          d.map((x, i) => (
                            <p
                              key={i}
                              className={cn(
                                "m-0 text-sm",
                                x.level === "error"
                                  ? "text-destructive"
                                  : x.level === "warning"
                                    ? "text-warning"
                                    : "text-muted-foreground",
                              )}
                            >
                              {x.text}
                            </p>
                          ))
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right align-top">
                        <RowChip row={r} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {hasMore && (
            <div className="flex justify-center border-t px-5 py-3">
              <Button variant="outline" size="sm" onClick={more} disabled={loading}>
                {loading ? "Loading…" : "Show more"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
