"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/states";
import { Pager, useLocalPages } from "@/components/patterns/pager";
import { cn } from "@/lib/utils";

/**
 * The widget library: everything this business can place or open, in one list.
 *
 * A widget is one reusable answer with its cut pinned — a measure off the semantic layer, or
 * a report the engine reconstructs. One list, because what an operator cares about is what a
 * widget CAN DO: a measure can be placed on a board, a report opens on its own page and
 * downloads as CSV.
 *
 * Filtering is client-side: the whole library arrives in one pair of requests.
 */

export interface LibraryWidget {
  /** Measure id or report key — what the board stores and what the URL carries. */
  id: string;
  name: string;
  description: string;
  source: "measure" | "report";
  /** The section heading. Derived from unit × basis, so both kinds sort into the same shelves. */
  family: string;
  /** "Money", "Count", "Rate" — what the figure IS. */
  unitLabel: string;
  /** "At an instant", "Over a period", "Cohort grid", … — how to read it. */
  basisLabel: string;
  /** Dimension labels this widget can be cut by. */
  dimensions: string[];
  /** Grain labels it can be re-cut at; empty where it has no series to re-cut. */
  grains: string[];
  href: string;
  /** Measures only: a board tile resolves through the semantic layer, so only these place. */
  placeable: boolean;
  /** A widget that answers as a grid and can never become a measure. Only viewable here. */
  gridOnly: boolean;
}

type FilterId = "all" | "measure" | "report" | "board" | "grid";

const FILTERS: Array<{ id: FilterId; label: string; match: (w: LibraryWidget) => boolean }> = [
  { id: "all", label: "All", match: () => true },
  { id: "measure", label: "Measures", match: (w) => w.source === "measure" },
  { id: "report", label: "Reports", match: (w) => w.source === "report" },
  { id: "board", label: "Can go on a board", match: (w) => w.placeable },
  { id: "grid", label: "Grids and cohorts", match: (w) => w.gridOnly },
];

/** Families open on arrival; the rest fold to one line until asked for. */
const OPEN_BY_DEFAULT = 2;

type Kind = "measure" | "report" | "grid";
const kindOf = (w: LibraryWidget): Kind =>
  w.gridOnly ? "grid" : w.source === "measure" ? "measure" : "report";

const KIND_LABEL: Record<Kind, string> = { measure: "Measure", report: "Report", grid: "Grid" };
const KIND_TONE: Record<Kind, string> = {
  measure: "border-primary/20 bg-primary/10 text-primary",
  report: "border-border bg-muted text-muted-foreground",
  grid: "border-border bg-accent text-foreground",
};

function KindPill({ kind }: { kind: Kind }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        KIND_TONE[kind],
      )}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}

export function WidgetLibrary({ widgets }: { widgets: LibraryWidget[] }) {
  const [q, setQ] = React.useState("");
  const [filter, setFilter] = React.useState<FilterId>("all");
  // A family the reader folded or opened; everything else follows the default.
  const [toggled, setToggled] = React.useState<Record<string, boolean>>({});

  const needle = q.trim().toLowerCase();
  const matches = React.useMemo(() => {
    const pick = FILTERS.find((f) => f.id === filter)!.match;
    return widgets.filter((w) => {
      if (!pick(w)) return false;
      if (!needle) return true;
      const hay = [w.name, w.description, w.family, w.unitLabel, w.basisLabel, ...w.dimensions]
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [filter, needle, widgets]);

  const sections = React.useMemo(() => {
    const by = new Map<string, LibraryWidget[]>();
    for (const w of matches) {
      if (!by.has(w.family)) by.set(w.family, []);
      by.get(w.family)!.push(w);
    }
    return [...by.entries()];
  }, [matches]);

  const counts = React.useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.id, widgets.filter(f.match).length])),
    [widgets],
  );

  // A search or a filter is a request to see the results, so every matching family opens.
  const narrowed = needle !== "" || filter !== "all";

  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Find a stat" className="overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <div className="relative w-full sm:w-72">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Name, description, dimension"
              aria-label="Search stats"
              className="pl-8"
            />
          </div>
          <div
            role="group"
            aria-label="Show"
            className="flex flex-wrap items-center rounded-md border bg-card p-0.5"
          >
            {FILTERS.map((f) => {
              const on = filter === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  aria-pressed={on}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors sm:h-7",
                    on
                      ? "bg-primary/10 font-semibold text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f.label}
                  <span className="text-xs tabular-nums opacity-80">{counts[f.id]}</span>
                </button>
              );
            })}
          </div>
          <span className="ml-auto text-sm text-muted-foreground tabular-nums">
            {matches.length} of {widgets.length}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t bg-muted/40 px-5 py-3 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-2">
            <KindPill kind="measure" />
            Opens in Explore · can go on a board
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <KindPill kind="report" />
            Own page · downloads as CSV · built on request, so not a board tile
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <KindPill kind="grid" />A report that answers as a grid
          </span>
        </div>
      </section>

      {sections.length === 0 ? (
        <div className="rounded-xl border bg-card">
          <EmptyState
            title="Nothing matches"
            description={<>No stat&apos;s name, description or dimension mentions that.</>}
          />
        </div>
      ) : (
        sections.map(([family, rows], i) => {
          const open = narrowed || (toggled[family] ?? i < OPEN_BY_DEFAULT);
          return (
            <FamilyCard
              // A new search or filter starts each family on its first page.
              key={`${family}|${filter}|${needle}`}
              family={family}
              rows={rows}
              open={open}
              onToggle={narrowed ? undefined : () => setToggled((t) => ({ ...t, [family]: !open }))}
            />
          );
        })
      )}
    </div>
  );
}

function FamilyCard({
  family,
  rows,
  open,
  onToggle,
}: {
  family: string;
  rows: LibraryWidget[];
  open: boolean;
  /** Absent while a search or filter holds every family open. */
  onToggle?: () => void;
}) {
  const { rows: page, pager } = useLocalPages(rows, 10);

  if (!open) {
    return (
      <section aria-label={family} className="overflow-hidden rounded-xl border bg-card">
        <button
          type="button"
          aria-expanded={false}
          onClick={onToggle}
          className="flex w-full items-center gap-2.5 px-5 py-3.5 text-left hover:bg-muted/40"
        >
          <ChevronDown aria-hidden className="size-4 shrink-0 -rotate-90 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-semibold">{family}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{rows.length}</span>
          <span className="hidden min-w-0 flex-1 truncate text-sm text-muted-foreground md:block">
            {rows
              .slice(0, 5)
              .map((w) => w.name)
              .join(", ")}
            {rows.length > 5 ? " …" : ""}
          </span>
          <span className="ml-auto shrink-0 text-sm font-medium text-primary">
            Show {rows.length}
          </span>
        </button>
      </section>
    );
  }

  return (
    <section aria-label={family} className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2.5 border-b px-5 py-3.5">
        {onToggle ? (
          <button
            type="button"
            aria-expanded
            aria-label={`Collapse ${family}`}
            onClick={onToggle}
            className="-m-2 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
          >
            <ChevronDown aria-hidden className="size-4" />
          </button>
        ) : null}
        <h3 className="text-sm font-semibold">{family}</h3>
        <span className="text-xs text-muted-foreground tabular-nums">{rows.length}</span>
      </div>
      <Table className="table-fixed [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
        <colgroup>
          <col className="w-[23%]" />
          <col className="w-[27%]" />
          <col className="w-[17%]" />
          <col className="w-[18%]" />
          {/* Fixed, sized for the widest pill ("Measure") plus the cell gutters. */}
          <col className="w-32" />
        </colgroup>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Stat</TableHead>
            <TableHead>What it answers</TableHead>
            <TableHead>Split by</TableHead>
            <TableHead>What it is</TableHead>
            <TableHead className="text-right">Kind</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.map((w) => {
            const cut = w.dimensions.length > 0 ? w.dimensions.join(", ") : "—";
            return (
              <TableRow key={`${w.source}:${w.id}`}>
                <TableCell className="truncate font-medium" title={w.name}>
                  <Link href={w.href} className="text-primary hover:underline">
                    {w.name}
                  </Link>
                </TableCell>
                <TableCell className="truncate text-muted-foreground" title={w.description}>
                  {w.description}
                </TableCell>
                <TableCell className="truncate text-muted-foreground" title={cut}>
                  {cut}
                </TableCell>
                <TableCell className="truncate text-muted-foreground">
                  {w.unitLabel} · {w.basisLabel}
                  {w.grains.length > 1 ? ` · ${w.grains.join("/")}` : ""}
                </TableCell>
                <TableCell className="text-right">
                  <KindPill kind={kindOf(w)} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {rows.length > 10 ? <Pager pager={pager} /> : null}
    </section>
  );
}
