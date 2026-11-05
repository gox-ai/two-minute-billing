"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  type ColumnDef,
  type RowData,
  type SortingState,
  type ColumnFiltersState,
  type VisibilityState,
  type RowSelectionState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, Columns3, Download, X } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TableSearch } from "@/components/table-search";
import { toast } from "sonner";
import { buildCsv, EXPORT_ROW_CAP, type ExportCell } from "@/lib/table-export";
import { cn } from "@/lib/utils";

declare module "@tanstack/react-table" {
  // Column-level presentation hints, read by the renderers below.
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Header + cell alignment. Money columns are `'right'`. */
    align?: "left" | "right" | "center";
    /** Extra classes applied to every body cell in the column. */
    cellClassName?: string;
    /**
     * Extra classes applied to the column's HEAD cell.
     *
     * ⚠️ NOT for casing any more. Its one real use used to be `normal-case`: `TableHead` set a
     * tracked UPPERCASE micro-label, but Tailwind Preflight resets `text-transform` on
     * `button` and a SORTABLE head renders inside a sort button — so sortable heads came out
     * sentence-case and non-sortable ones UPPERCASE, in the same header row. That is settled
     * (2026-09-09): `TableHead` no longer uppercases, every head is sentence-case, and the ten
     * `normal-case` overrides that existed to paper over the split are gone. Do not add one.
     */
    headClassName?: string;
    /** Fixed width utility, e.g. `'w-12'`. */
    width?: string;
    /**
     * The CSV cells this column exports, in order. Default: its header and value. Split a
     * composite cell (plan + id), write money in major units with its currency, or `[]` to
     * leave the column out. Every column exports, shown or hidden.
     */
    exportAs?: ExportCell<TData>[];
  }
}

export interface SortOption {
  /** Column id (or accessorKey) to sort by. */
  id: string;
  label: string;
}

/**
 * Server-driven mode: the parent owns search, sort and paging (they run in SQL),
 * so the table renders exactly the rows it is given. Set by `patterns/list-page` when
 * a list is backed by a paginated endpoint.
 */
export interface DataTableManualMode<TData = unknown> {
  /** Rows matching the current query on the server — what the count shows. */
  total: number;
  /** The engine stopped counting at `total`; the count reads "10,000+". */
  totalCapped?: boolean;
  search: string;
  onSearchChange: (v: string) => void;
  sorting: SortingState;
  onSortingChange: (s: SortingState) => void;
  /** Rendered where pagination normally goes (infinite-scroll sentinel). */
  footer?: React.ReactNode;
  /** A request is in flight. */
  loading?: boolean;
  /**
   * Every row of the current query, up to `cap`, for Export. Without it Export writes the
   * rows loaded so far.
   */
  exportAll?: (
    cap: number,
    onProgress: (loaded: number) => void,
  ) => Promise<{ rows: TData[]; capped: boolean }>;
}

export interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  /** Show the global search box + filter across all columns. */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Rows per page; omit to disable pagination. */
  pageSize?: number;
  /** Rendered when `data` is empty (or filtered to nothing). */
  emptyState?: React.ReactNode;
  /** Toolbar count: "N <countLabel>" next to the search box. */
  countLabel?: string;
  /** Enable the Export CSV button; used as the downloaded file name. */
  exportName?: string;
  /** Show the column-visibility chooser. */
  columnChooser?: boolean;
  /** Persist column visibility under this localStorage key. */
  persistKey?: string;
  /** Leading row checkboxes + a bulk bar when rows are selected. */
  enableSelection?: boolean;
  /** Renders inside the bulk bar next to "N selected" (gets selected originals). */
  bulkActions?: (rows: TData[], clearSelection: () => void) => React.ReactNode;
  /** Extra toolbar content (filter chips etc.), rendered after the search box. */
  toolbarExtras?: React.ReactNode;
  /** Rendered right after the search box (the palette hint). */
  searchHint?: React.ReactNode;
  /** Row click → navigate (the whole row is hot). */
  onRowHref?: (row: TData) => string | undefined;
  /**
   * "Sort by ▾" menu. Omit to derive it from every sortable column with a
   * plain-string header; pass `[]` to hide the control.
   */
  sortOptions?: SortOption[];
  /** Trailing sticky kebab column (the per-row action menu). */
  rowMenu?: (row: TData) => React.ReactNode;
  /** Rendered above the table card. */
  header?: React.ReactNode;
  /** Leads the toolbar row inside the card (ListPage: views, Filter list). */
  toolbarLead?: React.ReactNode;
  /** Ends the toolbar row (ListPage: Refresh and Create, when it has no page header). */
  toolbarEnd?: React.ReactNode;
  /** A band under the toolbar row (ListPage: applied filters, the filter builder). */
  toolbarBelow?: React.ReactNode;
  /** The count moves out of the toolbar: it is reported here instead (ListPage's title pill). */
  onCountText?: (text: string) => void;
  /** Server-driven search/sort/paging. Omit for the client-side default. */
  manual?: DataTableManualMode<TData>;
  /**
   * How long the search field waits after the last keystroke before filtering
   * (or refetching). 0 disables the debounce.
   */
  searchDebounceMs?: number;
  /**
   * Column ids hidden on first load. They stay available in the column chooser —
   * this is for columns that are real but low-value by default, so a wide table
   * does not have to truncate the ones that matter. A user's own choice, once
   * persisted via `persistKey`, always wins over this.
   */
  initialHidden?: string[];
  /**
   * Report every change to which columns are hidden.
   *
   * Set by `ListPage` when the list has saved views, so a view can capture the column
   * choice along with its filters. Reported as the HIDDEN ids rather than the full
   * id → visible map: a map records a verdict for every column that existed when it was
   * captured, so a column added later comes back `undefined` and its default silently
   * depends on how tanstack reads a missing key.
   */
  onHiddenChange?: (hidden: string[]) => void;
  /**
   * Hidden column ids to ADOPT — for applying a saved view's column choice.
   *
   * A nonce-style prop, not controlled state: the chooser still owns visibility from one
   * moment to the next, and this only says "the operator just picked a view, take these".
   * Making it fully controlled would mean `ListPage` re-deriving state on every toggle
   * and would break the localStorage path that all the lists without views still use.
   */
  applyHidden?: { hidden: string[]; nonce: number } | null;
  /**
   * Initial sort. Defaults to the created-at column descending (newest-first).
   * Pass `null` to open unsorted.
   */
  defaultSort?: { id: string; desc?: boolean } | null;
}

function columnLabel<TData, TValue>(col: ColumnDef<TData, TValue>, id: string): string {
  return typeof col.header === "string" ? col.header : id;
}

/** Column ids that mean "when this row was created". */
const CREATED_AT_IDS = ["created_at", "createdAt", "occurred_at", "created"];

function columnId<TData, TValue>(c: ColumnDef<TData, TValue>): string | undefined {
  if (c.id) return c.id;
  return "accessorKey" in c && typeof c.accessorKey === "string" ? c.accessorKey : undefined;
}

/**
 * Lists open **newest-first**, with the arrow showing on Created At — so the
 * initial sort is `created_at desc` whenever the table has such a column.
 * An explicit `defaultSort` overrides it; `null` opts out (for lists with their
 * own meaningful order, e.g. a hand-ordered settings table).
 */
export function resolveDefaultSort<TData, TValue>(
  columns: ColumnDef<TData, TValue>[],
  defaultSort?: { id: string; desc?: boolean } | null,
): SortingState {
  if (defaultSort === null) return [];
  if (defaultSort) return [{ id: defaultSort.id, desc: defaultSort.desc ?? true }];
  const created = columns.map(columnId).find((id) => id && CREATED_AT_IDS.includes(id));
  return created ? [{ id: created, desc: true }] : [];
}

const ALIGN_CLASS = { left: "text-left", right: "text-right", center: "text-center" } as const;

/**
 * Client-side data-table (TanStack) with search / sort / pagination plus the
 * list toolbar: record count, CSV export, "Sort by", column chooser (persisted),
 * bulk row selection and a sticky row-menu column. Every list view reuses this —
 * see `patterns/list-page` for the full list archetype (segments + filter builder +
 * Create/Import chrome) built on top of it.
 */
export function DataTable<TData, TValue>({
  columns,
  data,
  searchable = true,
  searchPlaceholder = "Search…",
  pageSize = 10,
  emptyState,
  countLabel,
  exportName,
  columnChooser = false,
  persistKey,
  enableSelection = false,
  bulkActions,
  toolbarExtras,
  searchHint,
  onRowHref,
  sortOptions,
  rowMenu,
  header,
  toolbarLead,
  toolbarEnd,
  toolbarBelow,
  onCountText,
  manual,
  defaultSort,
  searchDebounceMs = 250,
  initialHidden,
  onHiddenChange,
  applyHidden,
}: DataTableProps<TData, TValue>) {
  const router = useRouter();
  const [sorting, setSorting] = React.useState<SortingState>(() =>
    resolveDefaultSort(columns, defaultSort),
  );
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = React.useState("");
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>(() =>
    Object.fromEntries((initialHidden ?? []).map((id) => [id, false])),
  );
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});

  // Restore persisted column visibility after mount (avoids hydration mismatch). MERGED
  // over the defaults: the saved map only names columns this person decided on, and a
  // column added later is absent from it — which the table reads as visible, so a new
  // hidden-by-default column used to appear for everyone who had ever changed a column.
  const initialHiddenKey = (initialHidden ?? []).join(",");
  React.useEffect(() => {
    if (!persistKey) return;
    try {
      const raw = localStorage.getItem(`dt:${persistKey}:columns`);
      if (raw)
        setColumnVisibility({
          ...Object.fromEntries(
            (initialHiddenKey ? initialHiddenKey.split(",") : []).map((id) => [id, false]),
          ),
          ...(JSON.parse(raw) as VisibilityState),
        });
    } catch {
      /* corrupted state — ignore */
    }
  }, [persistKey, initialHiddenKey]);
  const persistVisibility = (updater: React.SetStateAction<VisibilityState>) => {
    setColumnVisibility((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (persistKey) {
        try {
          localStorage.setItem(`dt:${persistKey}:columns`, JSON.stringify(next));
        } catch {
          /* storage full/blocked — non-fatal */
        }
      }
      return next;
    });
  };

  /** The hidden ids, which is the shape a saved view stores. */
  const hiddenIds = React.useMemo(
    () =>
      Object.entries(columnVisibility)
        .filter(([, visible]) => visible === false)
        .map(([id]) => id)
        .sort(),
    [columnVisibility],
  );
  // Reported on every change, including the localStorage restore above — `ListPage`
  // compares it against the selected view to decide whether the view is dirty, and a
  // restore it never heard about would read as "unchanged" forever.
  const hiddenKey = hiddenIds.join(",");
  const onHiddenChangeRef = React.useRef(onHiddenChange);
  onHiddenChangeRef.current = onHiddenChange;
  React.useEffect(() => {
    onHiddenChangeRef.current?.(hiddenKey === "" ? [] : hiddenKey.split(","));
  }, [hiddenKey]);

  /**
   * Adopt a view's column choice. Keyed on the NONCE, not on the array: picking the same
   * view twice must re-apply it (the operator may have toggled a column since), and a
   * fresh array identity on every parent render would fight the chooser for control.
   */
  React.useEffect(() => {
    if (!applyHidden) return;
    persistVisibility(Object.fromEntries(applyHidden.hidden.map((id) => [id, false])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyHidden?.nonce]);

  const allColumns = React.useMemo<ColumnDef<TData, TValue>[]>(() => {
    const select: ColumnDef<TData, TValue> = {
      id: "__select",
      enableSorting: false,
      enableHiding: false,
      meta: { width: "w-10" },
      // Was a native input whose indeterminate state had to be poked onto the DOM
      // node through a ref, because the attribute does not exist in HTML. The
      // primitive takes it as a value.
      header: ({ table }) => (
        <Checkbox
          aria-label="Select all rows"
          checked={
            table.getIsAllPageRowsSelected()
              ? true
              : table.getIsSomePageRowsSelected()
                ? "indeterminate"
                : false
          }
          onCheckedChange={(v) => table.toggleAllPageRowsSelected(v === true)}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label="Select row"
          checked={row.getIsSelected()}
          onClick={(e) => e.stopPropagation()}
          onCheckedChange={(v) => row.toggleSelected(v === true)}
        />
      ),
    };
    const menu: ColumnDef<TData, TValue> = {
      id: "__menu",
      header: () => null,
      enableSorting: false,
      enableHiding: false,
      meta: { align: "right", width: "w-12" },
      cell: ({ row }) => (
        // Stop propagation so opening the menu doesn't trigger the row link.
        <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
          {rowMenu?.(row.original)}
        </div>
      ),
    };
    return [...(enableSelection ? [select] : []), ...columns, ...(rowMenu ? [menu] : [])];
  }, [columns, enableSelection, rowMenu]);

  // In manual mode the parent owns search/sort/paging — the table just renders
  // the rows it was handed, and sorting state lives upstream.
  const sortingState = manual ? manual.sorting : sorting;

  // ── Search ──
  // The per-keystroke state lives in `TableSearch`, NOT here: while it sat in this
  // component every character re-rendered every row to produce an identical table
  // (~20ms per keystroke at 67 rows, 2ms at one). Debouncing the filter never fixed
  // that — React re-rendered regardless. This component now hears SETTLED values
  // only, so it re-renders when the results change rather than when the text does.
  // Still the only debounce in the chain: `ListPage` consumes `onSearchChange`
  // already settled.
  const onSearchSettled = React.useCallback(
    (value: string) => {
      if (manual) manual.onSearchChange(value);
      else setGlobalFilter(value);
    },
    // `manual` is a fresh object each render in every caller, so depending on it
    // would defeat the point; the fields read here are stable for a given mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [!!manual],
  );

  const table = useReactTable({
    data,
    columns: allColumns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    manualSorting: !!manual,
    manualFiltering: !!manual,
    manualPagination: !!manual,
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sortingState) : updater;
      if (manual) manual.onSortingChange(next);
      else setSorting(next);
    },
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: persistVisibility,
    onRowSelectionChange: setRowSelection,
    initialState: { pagination: { pageSize } },
    state: {
      sorting: sortingState,
      columnFilters,
      // The server already applied the search; don't filter the page again.
      globalFilter: manual ? "" : globalFilter,
      columnVisibility,
      rowSelection,
    },
  });

  const rows = table.getRowModel().rows;
  const loadedCount = table.getFilteredRowModel().rows.length;
  const filteredCount = manual ? manual.total : loadedCount;
  const countText = `${filteredCount.toLocaleString("en")}${manual?.totalCapped ? "+" : ""}`;
  const { pageIndex, pageSize: ps } = table.getState().pagination;
  const from = filteredCount === 0 ? 0 : manual ? 1 : pageIndex * ps + 1;
  const to = manual ? loadedCount : Math.min((pageIndex + 1) * ps, filteredCount);
  const selectedRows = table.getFilteredSelectedRowModel().rows;
  const clearSelection = () => table.resetRowSelection();

  // Every column the table defines, shown or hidden: the column chooser shapes the screen,
  // not the file. Values come off the row, so rows fetched only for the export work too.
  const exportCells = (): ExportCell<TData>[] =>
    table.getAllLeafColumns().flatMap((c) => {
      if (c.id === "__select") return [];
      const meta = c.columnDef.meta;
      if (meta?.exportAs) return meta.exportAs;
      const read = c.accessorFn;
      if (!read) return [];
      return [
        {
          header: columnLabel(c.columnDef as ColumnDef<TData, TValue>, c.id),
          value: (row: TData) => read(row, 0),
        },
      ];
    });
  const download = (rows: TData[]) => {
    const blob = new Blob([buildCsv(exportCells(), rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exportName ?? "export"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const exportCsv = (only?: TData[]) =>
    download(
      (only
        ? table.getFilteredRowModel().rows.filter((r) => only.includes(r.original))
        : table.getFilteredRowModel().rows
      ).map((r) => r.original),
    );

  /**
   * Server lists: page through the whole query, then write the file on the NEXT render, so
   * columns that read per-page data (the customers list's subscriptions) see every page.
   */
  const [exporting, setExporting] = React.useState(false);
  const [fetchedForExport, setFetchedForExport] = React.useState<{
    rows: TData[];
    capped: boolean;
  } | null>(null);
  const exportAll = async () => {
    if (!manual?.exportAll || exporting) return;
    setExporting(true);
    const id = toast.loading("Exporting rows…");
    try {
      const res = await manual.exportAll(EXPORT_ROW_CAP, (n) =>
        toast.loading(
          `Exporting rows: ${n.toLocaleString("en")} of ${Math.min(manual.total, EXPORT_ROW_CAP).toLocaleString("en")}`,
          { id },
        ),
      );
      toast.dismiss(id);
      setFetchedForExport(res);
    } catch (e) {
      toast.error(`We could not export the rows. ${(e as Error).message}. Try again.`, { id });
      setExporting(false);
    }
  };
  React.useEffect(() => {
    if (!fetchedForExport) return;
    download(fetchedForExport.rows);
    if (fetchedForExport.capped) {
      toast.success(
        `Rows exported. The file has the first ${EXPORT_ROW_CAP.toLocaleString("en")} rows. To export the other rows, use filters.`,
      );
    } else {
      toast.success("Rows exported.");
    }
    setFetchedForExport(null);
    setExporting(false);
  }, [fetchedForExport]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Sort by ▾" — explicit options win; otherwise every sortable, labelled column.
  const sortMenu: SortOption[] =
    sortOptions ??
    table
      .getAllLeafColumns()
      .filter(
        (c) =>
          c.getCanSort() &&
          c.getIsVisible() &&
          typeof c.columnDef.header === "string" &&
          c.columnDef.header,
      )
      .map((c) => ({ id: c.id, label: c.columnDef.header as string }));
  const activeSort = sortingState[0];
  // A default sort on a hidden column is not in the menu; name it from its header.
  const activeHeader = activeSort ? table.getColumn(activeSort.id)?.columnDef.header : undefined;
  const activeSortLabel = activeSort
    ? (sortMenu.find((o) => o.id === activeSort.id)?.label ??
      (typeof activeHeader === "string" ? activeHeader : undefined))
    : undefined;
  const applySorting = (next: SortingState) =>
    manual ? manual.onSortingChange(next) : setSorting(next);
  const toggleSort = (id: string) => {
    const descFirst = !!table.getColumn(id)?.columnDef.sortDescFirst;
    applySorting(
      activeSort?.id === id ? [{ id, desc: !activeSort.desc }] : [{ id, desc: descFirst }],
    );
  };

  const hasToolbar =
    searchable ||
    countLabel ||
    exportName ||
    columnChooser ||
    toolbarExtras ||
    toolbarLead ||
    toolbarEnd ||
    sortMenu.length > 0;

  React.useEffect(() => {
    onCountText?.(countText);
  }, [onCountText, countText]);

  return (
    // The whole table fades in as one. Deliberately NOT a per-row stagger: a
    // list can be hundreds of rows, and animating each one turns a page of data
    // into a slot machine — and the rows are the thing you came to read.
    <div className="anim-fade space-y-3">
      {header}

      {/* One card: the toolbar row, the filter band, then the table. `bg-card`, not
          transparent — on the tinted ground a bare table reads as the page. */}
      <div className="overflow-hidden rounded-xl border bg-card">
        {hasToolbar ? (
          <div className="flex flex-wrap items-center gap-2 border-b px-3.5 py-3">
            {toolbarLead}
            {countLabel && !onCountText ? (
              <span className="text-sm">
                <strong className="font-semibold">{countText}</strong>{" "}
                <span className="text-muted-foreground">{countLabel.toLowerCase()}</span>
              </span>
            ) : null}
            {searchable ? (
              <TableSearch
                placeholder={searchPlaceholder}
                debounceMs={searchDebounceMs}
                loading={manual?.loading}
                externalValue={manual?.search}
                onSettled={onSearchSettled}
                className="relative max-w-md min-w-40 flex-[1_1_12rem]"
              />
            ) : null}
            {searchable ? searchHint : null}
            <div className="ms-auto flex flex-wrap items-center gap-2">
              {exportName ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" disabled={exporting}>
                      <Download className="size-3.5" /> Export{" "}
                      <ChevronDown className="size-3.5 opacity-60" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-60">
                    {manual?.exportAll ? (
                      <DropdownMenuItem onSelect={() => void exportAll()}>
                        {manual.total > EXPORT_ROW_CAP || manual.totalCapped
                          ? `Export the first ${EXPORT_ROW_CAP.toLocaleString("en")} rows as CSV`
                          : `Export all ${countText} row${manual.total === 1 ? "" : "s"} as CSV`}
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onSelect={() => exportCsv()}>
                        {/* Without `exportAll`, manual mode exports what has loaded so far. */}
                        Export {manual ? `${loadedCount} loaded` : loadedCount} row
                        {loadedCount === 1 ? "" : "s"} as CSV
                      </DropdownMenuItem>
                    )}
                    {enableSelection ? (
                      <DropdownMenuItem
                        disabled={selectedRows.length === 0}
                        onSelect={() => exportCsv(selectedRows.map((r) => r.original))}
                      >
                        Export selected as CSV
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              {toolbarExtras}
              {sortMenu.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm">
                      Sort by{activeSortLabel ? `: ${activeSortLabel}` : ""}
                      {activeSort ? (
                        activeSort.desc ? (
                          <ArrowDown className="size-3.5" />
                        ) : (
                          <ArrowUp className="size-3.5" />
                        )
                      ) : (
                        <ChevronDown className="size-3.5 opacity-60" />
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                      Sort by
                    </DropdownMenuLabel>
                    {sortMenu.map((o) => (
                      <DropdownMenuItem key={o.id} onSelect={() => toggleSort(o.id)}>
                        <span className="flex-1">{o.label}</span>
                        {activeSort?.id === o.id ? (
                          activeSort.desc ? (
                            <ArrowDown className="size-3.5" />
                          ) : (
                            <ArrowUp className="size-3.5" />
                          )
                        ) : null}
                      </DropdownMenuItem>
                    ))}
                    {activeSort ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => applySorting([])}>
                          Clear sort
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              {columnChooser ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" aria-label="Select columns">
                      <Columns3 className="size-3.5" />
                      <ChevronDown className="size-3.5 opacity-60" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuLabel>Columns</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {table
                      .getAllLeafColumns()
                      .filter((c) => c.id !== "__select" && c.getCanHide())
                      .map((c) => (
                        <DropdownMenuCheckboxItem
                          key={c.id}
                          checked={c.getIsVisible()}
                          onCheckedChange={(v) => c.toggleVisibility(!!v)}
                        >
                          {columnLabel(c.columnDef as ColumnDef<TData, TValue>, c.id)}
                        </DropdownMenuCheckboxItem>
                      ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              {toolbarEnd}
            </div>
          </div>
        ) : null}

        {toolbarBelow ? (
          <div className="space-y-3 border-b px-3.5 py-3 empty:hidden">{toolbarBelow}</div>
        ) : null}

        {enableSelection && selectedRows.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 border-b bg-accent/60 px-3.5 py-2 text-sm">
            <strong className="font-semibold">{selectedRows.length} selected</strong>
            {exportName ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportCsv(selectedRows.map((r) => r.original))}
              >
                <Download className="size-3.5" /> Export selected
              </Button>
            ) : null}
            {bulkActions?.(
              selectedRows.map((r) => r.original),
              clearSelection,
            )}
            <Button
              variant="ghost"
              size="sm"
              className="ms-auto"
              onClick={clearSelection}
              aria-label="Clear selection"
            >
              <X className="size-3.5" /> Clear
            </Button>
          </div>
        ) : null}

        <div
          className={cn("transition-opacity", manual?.loading && "pointer-events-none opacity-60")}
          aria-busy={manual?.loading || undefined}
        >
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id} className="border-b hover:bg-transparent">
                  {hg.headers.map((header) => {
                    const canSort = header.column.getCanSort();
                    const meta = header.column.columnDef.meta;
                    const sorted = header.column.getIsSorted();
                    return (
                      <TableHead
                        key={header.id}
                        className={cn(
                          // No local type override: the label and its soft band come from `ui/table`.
                          "h-11 px-4",
                          meta?.align && ALIGN_CLASS[meta.align],
                          meta?.width,
                          meta?.headClassName,
                          // Opaque under the band, so the frozen head cell matches the row.
                          header.column.id === "__menu" &&
                            "sticky right-0 z-10 bg-card bg-linear-to-r from-muted/40 to-muted/40 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.12)]",
                        )}
                      >
                        {header.isPlaceholder ? null : canSort ? (
                          <button
                            type="button"
                            className={cn(
                              // Baseline, not center: reversed, the icon is the start item and an
                              // inline-flex takes its baseline from it, lifting the label 1.5px.
                              "group/head touch-target relative inline-flex items-baseline gap-1 hover:text-foreground",
                              meta?.align === "right" && "flex-row-reverse",
                            )}
                            onClick={header.column.getToggleSortingHandler()}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sorted === "asc" ? (
                              <ArrowUp className="size-3.5 self-center" />
                            ) : sorted === "desc" ? (
                              <ArrowDown className="size-3.5 self-center" />
                            ) : (
                              // Only the sorted column shows its arrow; the rest appear on
                              // hover or keyboard focus.
                              <ArrowUpDown className="size-3.5 self-center opacity-0 group-hover/head:opacity-40 group-focus-visible/head:opacity-40" />
                            )}
                          </button>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {rows.length ? (
                rows.map((row) => {
                  const href = onRowHref?.(row.original);
                  return (
                    <TableRow
                      key={row.id}
                      data-state={row.getIsSelected() && "selected"}
                      className={cn("group/row hover:bg-muted/40", href && "cursor-pointer")}
                      onClick={
                        href
                          ? (e) => {
                              // Let inner links/buttons/menus win — the row is only
                              // a fallback target for the "dead" area of the row.
                              if (
                                (e.target as HTMLElement).closest(
                                  "a,button,input,select,[role=menuitem]",
                                )
                              )
                                return;
                              router.push(href);
                            }
                          : undefined
                      }
                    >
                      {row.getVisibleCells().map((cell) => {
                        const meta = cell.column.columnDef.meta;
                        return (
                          <TableCell
                            key={cell.id}
                            className={cn(
                              // Rows are airy and top-aligned (two-line Info cells).
                              // Opt into wrapping per column with `meta.cellClassName`.
                              "px-4 py-3 align-top",
                              meta?.align && ALIGN_CLASS[meta.align],
                              meta?.width,
                              meta?.cellClassName,
                              // The actions column is sticky so it stays reachable while a
                              // wide table scrolls. A `border-l` read as an ordinary column
                              // rule, which made the data scrolling UNDER it look like a
                              // clipped value (e.g. "$129.0("). A left shadow reads as a
                              // floating edge instead, which is what it actually is.
                              cell.column.id === "__menu" &&
                                "sticky right-0 z-10 bg-card shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.12)] group-hover/row:bg-muted/40 group-data-[state=selected]/row:bg-muted",
                            )}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );
                })
              ) : (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={allColumns.length}
                    className="h-24 p-6 text-center text-muted-foreground"
                  >
                    {emptyState ?? "No results."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {filteredCount > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Showing {from}–{to} of {countText}
          </span>
          {manual ? (
            manual.footer
          ) : table.getPageCount() > 1 ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
              >
                Next
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
