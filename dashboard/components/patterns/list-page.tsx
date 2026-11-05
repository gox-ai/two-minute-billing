"use client";

import * as React from "react";
import { useBusinessTz } from "@/components/business-tz";
import Link from "next/link";
import { type ColumnDef, type SortingState } from "@tanstack/react-table";
import { BookmarkPlus, Plus, SlidersHorizontal, Upload, X } from "lucide-react";
import { RefreshButton } from "@/components/refresh-button";
import { PageHeader, type Crumb } from "@/components/page-header";
import { DataTable, resolveDefaultSort, type SortOption } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LIST_TOTAL_CAP } from "@/lib/list-source";
import { EXPORT_PAGE_SIZE, fetchAllPages } from "@/lib/table-export";
import {
  AppliedFilterPills,
  FilterBuilder,
  fromServerFilters,
  matches,
  operatorsFor,
  rowIsUsable,
  toServerFilters,
  fieldType,
  type FilterRow,
  type ListFilterField,
  type ListServerFilter,
} from "@/components/patterns/list-filters";
import {
  ManageViewsDialog,
  SaveViewDialog,
  savedViewStateKey,
  useSavedViews,
  ViewsMenu,
  viewStateKey,
  type SavedView,
  type ViewDraft,
  type ViewState,
} from "@/components/patterns/list-views";

// Re-exported so the ~20 list components keep importing their filter types from here.
export type {
  ListFilterField,
  ListFilterType,
  ListServerFilter,
} from "@/components/patterns/list-filters";

// ── Public types ──────────────────────────────────────────────────────────────

export interface ListEntity {
  /** "Customer" — used for "Create Customer". */
  singular: string;
  /** "Customers" — used for the count, "All Customers", "Import Customers". */
  plural: string;
}

/**
 * A BUILT-IN view: the canned entries at the top of the `All Things ▾` dropdown.
 *
 * These ship with the list and belong to every operator. An operator's OWN named views
 * are `SavedView`s, stored in the engine and loaded through `savedViews` below — the
 * dropdown shows both, under separate headings.
 *
 * Client-side lists use `match`; **server-backed lists must use `filters`**, so
 * the segment narrows the whole table in SQL rather than just the loaded page.
 */
export interface ListSegment<T> {
  id: string;
  label: string;
  /** Row predicate — client-side lists only. */
  match?: (row: T) => boolean;
  /** Server filters this segment applies. Required in server mode. */
  filters?: ListServerFilter[];
}

export interface ListAction {
  label: string;
  href?: string;
  onClick?: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
  /** Tooltip — use it to explain a disabled action. */
  title?: string;
}

/** The current view, as sent to a paginated endpoint. */
export interface ListQuery {
  /** Opaque cursor; null/absent = first page. */
  cursor?: string | null;
  search?: string;
  sort?: { field: string; desc: boolean } | null;
  /** Segment filters + builder filters, merged. */
  filters: ListServerFilter[];
  /** Rows per page; the source's own page size when absent. Export asks for bigger pages. */
  limit?: number;
}

export interface ListFetchResult<T> {
  rows: T[];
  /** Filtered-set size; null when the endpoint only returns it on page 1. */
  total: number | null;
  hasMore: boolean;
  nextCursor: string | null;
}

/**
 * Server-backed mode: search / segments / filters / sort / paging all run in the
 * API, and rows stream in as the operator scrolls. Required for any list that can
 * grow unbounded — a 50k-row business must never be shipped to the browser.
 */
export interface ListServerMode<T> {
  /**
   * Totals for the server-rendered first page. `null` when the endpoint does not count:
   * the list then counts the rows it loaded and shows "N+" while more remain.
   */
  total: number | null;
  hasMore: boolean;
  nextCursor: string | null;
  /** Fetches one page for the given view. */
  fetchPage: (q: ListQuery) => Promise<ListFetchResult<T>>;
}

/**
 * Turn on the operator's own saved views for this list.
 *
 * `entity` must be one of `LIST_VIEW_ENTITIES` in
 * `src/modules/list-views/entities.ts` — the same key `/api/lists/<entity>` uses, so a
 * view, a shared URL and an API call all name the same list. Omit `biz` for the two
 * org-level lists (the activity log, the billing clock); the engine stores a NULL
 * business for those rather than guessing one.
 */
export interface ListSavedViews {
  entity: string;
  biz?: string;
}

// ── ListPage ──────────────────────────────────────────────────────────────────

/** The screen's opener, drawn by the list so its count and Create sit beside the title. */
export interface ListPageHeader {
  title: string;
  description?: React.ReactNode;
  breadcrumbs?: Crumb[];
  /** Header-right content the page owns, before Refresh and Create. */
  actions?: React.ReactNode;
  /** Between the header and the list: the page's flash message or a warning. */
  notice?: React.ReactNode;
}

export interface ListPageProps<T, TValue = unknown> {
  entity: ListEntity;
  /**
   * The page header. With it, the count is a pill beside the title and Refresh / Import /
   * Create move to the header's right; without it they end the toolbar row.
   */
  page?: ListPageHeader;
  columns: ColumnDef<T, TValue>[];
  data: T[];
  /** Built-in views for the `All <Things> ▾` dropdown. Omit to hide it. */
  segments?: ListSegment<T>[];
  /** Fields offered by "Filter list". Omit to hide the button. */
  filterFields?: ListFilterField<T>[];
  /**
   * Enable operator-saved views on this list. Adds "Save view", the My/Shared groups in
   * the dropdown, and the Manage dialog. Every list that has `filterFields` should have
   * this too — a rich filter you cannot keep is a filter you retype every morning.
   */
  savedViews?: ListSavedViews;
  /** Primary button on the top bar (usually `Create <Thing>`). */
  createAction?: ListAction;
  /**
   * Use instead of `createAction` when creating opens a dialog rather than a
   * page (pass the trigger component itself).
   */
  createSlot?: React.ReactNode;
  /** Outline button left of it (usually `Import <Things>`). */
  importAction?: ListAction;
  /** Use instead of `importAction` when import opens a dialog (pass the trigger). */
  importSlot?: React.ReactNode;
  /** Extra top-bar content, rendered after the filter button. */
  topBarExtras?: React.ReactNode;
  /** Extra toolbar content, rendered after Export. */
  toolbarExtras?: React.ReactNode;
  searchPlaceholder?: string;
  /** Rendered right after the search box (the palette hint). */
  searchHint?: React.ReactNode;
  /**
   * Show the search box. `DataTable` defaults it on, and `ListPage` had no way to turn
   * it off — so the two lists whose endpoints ignore `q` (`retries`, `payment_intents`;
   * neither proxy fetcher forwards it) rendered a search field that filtered nothing.
   * A server-backed list must pass `false` unless its endpoint really searches.
   */
  searchable?: boolean;
  /** Enables the Export menu; also the CSV file name. */
  exportName?: string;
  /** localStorage key for column visibility + the selected view. */
  persistKey?: string;
  columnChooser?: boolean;
  /** Column ids hidden on first load; see DataTable.initialHidden. */
  initialHidden?: string[];
  enableSelection?: boolean;
  bulkActions?: (rows: T[], clearSelection: () => void) => React.ReactNode;
  /** Whole-row link target (lists are row-clickable). */
  rowHref?: (row: T) => string | undefined;
  /** Trailing kebab menu per row. */
  rowMenu?: (row: T) => React.ReactNode;
  sortOptions?: SortOption[];
  pageSize?: number;
  emptyState?: React.ReactNode;
  /**
   * Initial sort — defaults to the created-at column descending (every list opens
   * newest-first). `null` opens unsorted.
   */
  defaultSort?: { id: string; desc?: boolean } | null;
  /**
   * Search debounce. Defaults to 350ms for a server-backed list (each change is a
   * request) and 250ms for a client-side one (a local re-filter).
   */
  searchDebounceMs?: number;
  /**
   * Back this list with a paginated endpoint. `data` is then the first page
   * (server-rendered) and everything else streams in through `fetchPage`.
   */
  server?: ListServerMode<T>;
  /**
   * Filters to apply on FIRST RENDER, for deep links like
   * `…/transactions?status=failure`. Build them with `urlFilters()` in the page's
   * server component.
   *
   * The list used to own its filter state exclusively and simply ignore the URL,
   * so `?status=failure` rendered the *whole* log while every caller believed it
   * had filtered — the same silent-lie class as the invoice `?subscription=` bug.
   * Seeding `applied` (rather than quietly narrowing the rows) also means the
   * filter pills and "Clear filters" both work, so the operator can see WHY
   * rows are missing.
   *
   * Field ids not offered by `filterFields` are dropped — a URL cannot be
   * trusted to name a real column, and an unknown one would 400 the endpoint.
   */
  initialFilters?: ListServerFilter[];
}

/**
 * The narrowing this component owns, read off the live URL: `view`, `segment`, `q`
 * and `sort` (`field:asc|desc`). `filter=` is NOT here — it is read server-side by
 * `urlFilters()` in the page, because it has to reach the first fetch.
 *
 * Read in an EFFECT, never during render: the server rendered this page without the
 * link's narrowing, so seeding state from `window` is a hydration mismatch. The
 * `?view=` cold-load effect takes the same route for the same reason.
 */
function readUrlState(): {
  view: string | null;
  segment: string | null;
  q: string | null;
  sort: SortingState | null;
} {
  if (typeof window === "undefined") return { view: null, segment: null, q: null, sort: null };
  const sp = new URLSearchParams(window.location.search);
  const [field, dir] = (sp.get("sort") ?? "").split(":");
  return {
    view: sp.get("view"),
    segment: sp.get("segment"),
    q: sp.get("q"),
    sort: field ? [{ id: field, desc: dir === "desc" }] : null,
  };
}

/**
 * The **list archetype**, shared by every list screen:
 *
 * ```
 * [ All Things ▾ ] [ ⚙ 2 Filters ] [Save view]            [ Import Things ] [ + Create Thing ]
 * [ status is one of Active, In Trial ×] [ MRR is at least 5000 ×]
 * [ filter builder band — when open ]
 * N Things   [search]  [Export ▾]                          [ Sort by ▾ ] [ ▤▾ ]
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ table (two-line Info cells, right-aligned money, sticky row kebab)        │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * Segments and filters narrow the rows before the table sees them, so the
 * record count, search, sort, export and pagination all operate on the
 * filtered set. Pass `columns` + `data` and the chrome is free; see
 * `customers/customers-table` for the reference wiring.
 */
export function ListPage<T, TValue = unknown>({
  entity,
  page,
  columns,
  data,
  segments,
  filterFields,
  savedViews,
  createAction,
  createSlot,
  importAction,
  importSlot,
  topBarExtras,
  toolbarExtras,
  searchHint,
  searchPlaceholder,
  searchable,
  exportName,
  persistKey,
  columnChooser = true,
  initialHidden,
  enableSelection,
  bulkActions,
  rowHref,
  rowMenu,
  sortOptions,
  pageSize,
  emptyState,
  defaultSort,
  searchDebounceMs,
  server,
  initialFilters,
}: ListPageProps<T, TValue>) {
  // Newest-first out of the box, in both modes (server mode sends it as sort_by).
  const initialSort = React.useMemo(
    () => resolveDefaultSort(columns, defaultSort),
    [columns, defaultSort],
  );
  // Date filters bucket by the BUSINESS day, not the UTC day — see businessDay().
  const tz = useBusinessTz();
  const isServer = !!server;

  /**
   * Put the create button INSIDE the empty state.
   *
   * Every one of the app's 70 `EmptyState`s passed no `action`, so the zero-state of each list
   * was a dead end that described where a button lived instead of being one — "Use "Create
   * business", above". That is the single highest-intent moment in the product and it was spent
   * on prose.
   *
   * Done here rather than in ~15 tables because this component already holds both halves, so
   * they cannot drift apart. It also discriminates correctly on its own: a read-only list (the
   * logs, events, disputes) passes no `createAction` and keeps an actionless empty state, which
   * is right — "no failed webhooks" is good news, not a call to action.
   *
   * A caller that already supplies its own `action` wins.
   */
  const emptyStateWithCreate = React.useMemo(() => {
    if (!React.isValidElement<{ action?: React.ReactNode }>(emptyState)) return emptyState;
    if (emptyState.props.action != null) return emptyState;
    // `createSlot` is the dialog variant of the same intent. Rendering that node in both places
    // is safe — React gives each instance its own state and Radix mints its own ids — so the
    // dialog opens from the empty state exactly as it does from the toolbar.
    const action = createAction ? (
      <ActionButton action={createAction} variant="default" />
    ) : (
      createSlot
    );
    if (!action) return emptyState;
    return React.cloneElement(emptyState, { action });
  }, [emptyState, createAction, createSlot]);

  const fields = React.useMemo(() => filterFields ?? [], [filterFields]);
  const fieldsById = React.useMemo(
    () => Object.fromEntries(fields.map((f) => [f.id, f])),
    [fields],
  );

  const [segmentId, setSegmentId] = React.useState(segments?.[0]?.id ?? "all");
  const [savedId, setSavedId] = React.useState<string | null>(null);
  const [filterOpen, setFilterOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<FilterRow[]>([]);
  // Deep-link filters (`initialFilters`) become real builder rows, so the URL
  // narrows the list exactly as if the operator had typed the filter. Negative
  // keys keep them clear of `nextKey`, which starts at 1.
  const [applied, setApplied] = React.useState<FilterRow[]>(() =>
    fromServerFilters(initialFilters ?? [], filterFields ?? [], !!server),
  );
  const nextKeyRef = React.useRef(1);
  const nextKey = React.useCallback(() => nextKeyRef.current++, []);

  const [saveOpen, setSaveOpen] = React.useState(false);
  const [manageOpen, setManageOpen] = React.useState(false);
  /** Hidden column ids, reported up by DataTable so a view can capture them. */
  const [hidden, setHidden] = React.useState<string[]>(() => [...(initialHidden ?? [])].sort());
  const [applyHidden, setApplyHidden] = React.useState<{ hidden: string[]; nonce: number } | null>(
    null,
  );
  const hiddenNonce = React.useRef(0);

  // ── Saved views ──
  //
  // The hook is always called (React requires it) but does nothing without an entity:
  // passing '' makes the fetch a no-op rather than adding a conditional hook.
  const viewsApi = useSavedViews(savedViews?.entity ?? "", savedViews?.biz);
  const views = savedViews ? viewsApi.views : [];
  const selectedView = React.useMemo(
    () => views.find((v) => v.id === savedId) ?? null,
    [views, savedId],
  );

  // Remember the selected built-in view per list (the operator stays in their view).
  React.useEffect(() => {
    if (!persistKey) return;
    // A link naming a segment outranks the operator's last-used one: the sender chose
    // it, and silently swapping it is how a shared list shows two people different rows.
    const fromLink = readUrlState();
    if (fromLink.segment || fromLink.view) return;
    try {
      const saved = localStorage.getItem(`dt:${persistKey}:segment`);
      if (saved && segments?.some((s) => s.id === saved)) setSegmentId(saved);
    } catch {
      /* blocked storage — ignore */
    }
  }, [persistKey, segments]);

  const applySegment = (id: string) => {
    setSegmentId(id);
    // A built-in view and a saved one are alternatives, not layers: leaving `savedId` set
    // would AND a segment's filters onto a saved view's while the label named only one
    // of them, which is the "narrowed under the wrong name" bug in a new costume.
    setSavedId(null);
    if (persistKey) {
      try {
        localStorage.setItem(`dt:${persistKey}:segment`, id);
      } catch {
        /* blocked storage — ignore */
      }
    }
  };

  // The view state a saved view overwrites. Declared HERE, above `applySavedView`,
  // rather than beside the other server-mode state below: the callback writes both, and
  // reading them from a `const` declared further down means closing over a binding in
  // its temporal dead zone — harmless only for as long as nothing calls the callback
  // during render, which is not a property to depend on.
  //
  // `search` is already debounced: `DataTable` owns the field and only reports the
  // settled value, so every change is worth a request.
  const [search, setSearch] = React.useState("");
  const [sorting, setSorting] = React.useState<SortingState>(initialSort);
  /** Has the link been read yet? State, not a ref: the writer needs a re-render. */
  const [urlAdopted, setUrlAdopted] = React.useState(false);

  /**
   * Adopt what a link says. Idempotent, so it is safe to run on mount and again once
   * the saved views arrive.
   *
   * A segment and a saved view are ALTERNATIVES, not layers (see `applySegment`), so a
   * link carrying both is honoured as the view alone — otherwise the segment's filters
   * would AND onto the view's under a label naming only one of them.
   */
  const applyUrlState = React.useCallback(() => {
    const fromLink = readUrlState();
    if (!fromLink.view && fromLink.segment && segments?.some((s) => s.id === fromLink.segment)) {
      setSegmentId(fromLink.segment);
    }
    if (fromLink.q !== null) setSearch(fromLink.q);
    if (fromLink.sort) setSorting(fromLink.sort);
  }, [segments]);

  /** Adopt a saved view wholesale: filters, search, sort and columns. */
  const applySavedView = React.useCallback(
    (v: SavedView) => {
      setSavedId(v.id);
      setSegmentId(segments?.[0]?.id ?? "all");
      setApplied(fromServerFilters(v.filters, fields, isServer));
      setSearch(v.search ?? "");
      setSorting(v.sort_field ? [{ id: v.sort_field, desc: !!v.sort_desc }] : initialSort);
      if (v.hidden_columns) {
        hiddenNonce.current += 1;
        setApplyHidden({ hidden: v.hidden_columns, nonce: hiddenNonce.current });
      }
      setFilterOpen(false);
    },
    [fields, isServer, segments, initialSort],
  );

  const selectView = (id: string) => {
    const v = views.find((x) => x.id === id);
    if (v) applySavedView(v);
    else applySegment(id);
  };

  // ── Client-side narrowing (skipped entirely in server mode) ──
  const clientRows = React.useMemo(() => {
    if (server) return data;
    const segment = segments?.find((s) => s.id === segmentId);
    let out = segment?.match && !savedId ? data.filter(segment.match) : data;
    if (applied.length > 0) {
      out = out.filter((row) =>
        applied.every((r) => {
          const field = fieldsById[r.field];
          if (!field?.value) return true;
          return matches(
            field.value(row),
            r.op,
            r.value,
            fieldType(field),
            tz,
            field.moneyExponent ?? 2,
          );
        }),
      );
    }
    return out;
  }, [server, data, segments, segmentId, savedId, applied, fieldsById, tz]);

  // ── Server mode: rows stream in; search/sort/filters become query params ──
  const [serverRows, setServerRows] = React.useState<T[]>(data);
  // An endpoint that does not count: the loaded rows are the count, "+" while more remain.
  const uncounted = server?.total === null;
  const [total, setTotal] = React.useState(server?.total ?? data.length);
  const [hasMore, setHasMore] = React.useState(server?.hasMore ?? false);
  const [cursor, setCursor] = React.useState<string | null>(server?.nextCursor ?? null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  /**
   * A new SSR payload — `router.refresh()` after a mutation, or a monitoring page
   * refreshing on a timer — always carries the **default view's** first page.
   *
   * Adopting it unconditionally put unfiltered rows under a narrowed label. Measured
   * on a monitoring page that auto-refreshes every 15s: select "Overran", and the next refresh
   * silently repopulated the table with every tick while the Views button still read
   * "Overran" and the footer still counted the segment. The old comment here claimed
   * "the query effect below refetches it", but that effect only fires on a `queryKey`
   * change — and a refresh changes `data`, not the query.
   *
   * So the payload is adopted only when the live query IS the default view; otherwise
   * the ACTIVE query is refetched, and the refresh updates the rows the operator asked
   * for rather than replacing them.
   */
  const [ssrNonce, setSsrNonce] = React.useState(0);
  const queryKeyRef = React.useRef("");
  // The payload last seen: a re-run with the same `data` (React's dev double-invoke of
  // effects) is not a new payload, and bumping `ssrNonce` on it fetched the list a third time.
  const seenData = React.useRef(data);
  React.useEffect(() => {
    if (!server) return;
    if (seenData.current === data) return;
    seenData.current = data;
    if (queryKeyRef.current !== ssrQueryKey.current) {
      // Only ask for a refetch once we're actually holding a non-default view's
      // rows. On MOUNT with a segment restored from localStorage this effect runs
      // before the first fetch, and bumping here would make the mount fetch twice.
      if (divergedFromSsr.current) setSsrNonce((n) => n + 1);
      return;
    }
    setServerRows(data);
    setTotal(server.total ?? data.length);
    setHasMore(server.hasMore);
    setCursor(server.nextCursor);
    divergedFromSsr.current = false;
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Just the builder's rows, in wire form — what a saved view stores. */
  const builderFilters = React.useMemo(
    () => toServerFilters(applied, fieldsById, isServer),
    [applied, fieldsById, isServer],
  );

  const serverFilters = React.useMemo<ListServerFilter[]>(() => {
    // A saved view is self-contained, so the built-in segment contributes nothing while
    // one is selected (see `applySegment`).
    const segment = savedId ? undefined : segments?.find((s) => s.id === segmentId);
    return [...(segment?.filters ?? []), ...builderFilters];
  }, [segments, segmentId, savedId, builderFilters]);

  const query = React.useMemo<ListQuery>(
    () => ({
      search: search.trim() || undefined,
      sort: sorting[0] ? { field: sorting[0].id, desc: sorting[0].desc } : null,
      filters: serverFilters,
    }),
    [search, sorting, serverFilters],
  );
  const queryKey = JSON.stringify(query);
  // Read by the SSR-payload effect above, which runs on a `data` change and must
  // know whether the operator has narrowed away from the default view.
  queryKeyRef.current = queryKey;
  /**
   * What the server-rendered `data` represents: the default view's first page.
   * Skipping a refetch when the live query equals it avoids a redundant request
   * on mount — but a *restored* segment (localStorage) differs from it, so that
   * case correctly refetches. `divergedFromSsr` then forces a refetch when the
   * operator returns to the default view, whose rows we no longer hold.
   *
   * `initialFilters` is deliberately NOT folded in here: the SSR page is fetched
   * unfiltered, so a deep-linked view MUST refetch on mount. Adding the seed to
   * this key would suppress that refetch and reinstate the original bug — the
   * URL claiming a filter while the table shows everything. The same reasoning
   * covers a default saved view applied on mount.
   */
  const ssrQueryKey = React.useRef(
    JSON.stringify({
      search: undefined,
      // The engine's own default matches `initialSort` (created_at desc), so the
      // SSR page already satisfies it — sending it explicitly changes nothing.
      sort: initialSort[0] ? { field: initialSort[0].id, desc: initialSort[0].desc } : null,
      filters: segments?.[0]?.filters ?? [],
    } satisfies ListQuery),
  );
  const divergedFromSsr = React.useRef(false);
  const fetchPageRef = React.useRef(server?.fetchPage);
  fetchPageRef.current = server?.fetchPage;

  /**
   * The operator's Refresh: re-run the ACTIVE query through `fetchPage`, so only the rows
   * reload. No `router.refresh()` — that re-runs the whole server component (five engine
   * calls on some of these pages) to replace a table.
   *
   * Needs its own force flag because the guard below skips a refetch while the live query
   * still IS the SSR one — the view an operator lands on — so `ssrNonce` alone does nothing
   * there. Faking it by setting `divergedFromSsr` would be wrong: that ref also decides
   * whether an incoming SSR payload gets adopted, so rows would stop updating after a
   * mutation's refresh.
   */
  const forceRefetch = React.useRef(false);
  const [refreshNonce, setRefreshNonce] = React.useState(0);
  /** A fetch for the same query and nonces already in flight is reused, not sent again. */
  const inflight = React.useRef<{ key: string; promise: Promise<ListFetchResult<T>> } | null>(null);
  const refreshRows = React.useCallback(() => {
    forceRefetch.current = true;
    setRefreshNonce((n) => n + 1);
  }, []);

  React.useEffect(() => {
    if (!server) return;
    if (!forceRefetch.current && !divergedFromSsr.current && queryKey === ssrQueryKey.current)
      return;
    forceRefetch.current = false;
    divergedFromSsr.current = true;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const fetchKey = `${queryKey}|${ssrNonce}|${refreshNonce}`;
    const promise =
      inflight.current?.key === fetchKey
        ? inflight.current.promise
        : fetchPageRef.current!({ ...(JSON.parse(queryKey) as ListQuery), cursor: null });
    inflight.current = { key: fetchKey, promise };
    const settled = () => {
      if (inflight.current?.promise === promise) inflight.current = null;
    };
    promise.then(settled, settled);
    promise
      .then((res) => {
        if (cancelled) return;
        setServerRows(res.rows);
        setTotal(res.total ?? res.rows.length);
        setHasMore(res.hasMore);
        setCursor(res.nextCursor);
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // `ssrNonce` re-runs the ACTIVE query when a router refresh lands while a
    // segment or filter is on — the query itself hasn't changed, but its answer has.
    // `refreshNonce` is the same thing asked for by hand, on any view.
  }, [queryKey, ssrNonce, refreshNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = React.useCallback(() => {
    if (!server || !hasMore || loading) return;
    setLoading(true);
    setLoadError(null);
    fetchPageRef.current!({ ...query, cursor })
      .then((res) => {
        setServerRows((prev) => [...prev, ...res.rows]);
        if (uncounted) setTotal((n) => n + res.rows.length);
        setHasMore(res.hasMore);
        setCursor(res.nextCursor);
      })
      .catch((e: Error) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }, [server, uncounted, hasMore, loading, query, cursor]);

  // Infinite scroll — fetch the next page when the sentinel scrolls into view.
  const sentinel = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = sentinel.current;
    if (!el || !server || !hasMore) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && loadMore(), {
      rootMargin: "400px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [server, hasMore, loadMore]);

  const rows = server ? serverRows : clientRows;
  const totalCapped = uncounted ? hasMore : total >= LIST_TOTAL_CAP;
  // The title pill's count, as the table reports it (filtered, capped). Until it reports,
  // the same figure from the props, so the server render already shows it.
  const [reportedCount, setCountText] = React.useState<string | null>(null);
  const countText =
    reportedCount ??
    (server
      ? `${total.toLocaleString("en")}${totalCapped ? "+" : ""}`
      : rows.length.toLocaleString("en"));

  // ── URL: the current narrowing, shareable ──
  //
  // Written with `history.replaceState`, NOT `router.replace`. A router navigation
  // re-renders the page on the server, which lands as a fresh `data` prop — straight
  // into the SSR-adoption effect above, whose whole job is deciding whether to trust a
  // payload it did not ask for. Every filter keystroke would enter that path. The
  // address bar is the only thing that needs to change here, so change only that.
  //
  // The grammar is the API's own `filter=field:op:value`, so a link, a stored view and
  // a curl command all say the same thing. `urlFilters()` reads it back on a cold load.
  //
  // `segment` is here and NOT only in localStorage: the stored one is a per-operator
  // convenience, and letting it decide meant a link to the Failed segment opened on
  // whatever segment the recipient last used — two people, one URL, different rows.
  //
  // ⚠️ Gated on `urlAdopted`. This effect is declared above the cold-load effects, so
  // on mount it ran FIRST — with default state — and deleted the very params the reader
  // was about to look for: loading `?q=parity` measured as an empty address bar and an
  // empty search box. The gate holds the first write until the link has been read.
  const urlStateKey = `${queryKey}|${savedId ?? ""}|${segmentId}`;
  React.useEffect(() => {
    if (typeof window === "undefined" || !urlAdopted) return;
    const url = new URL(window.location.href);
    const sp = url.searchParams;
    // Only the keys this component owns — a page's own params (`?customer=`, `?window=`)
    // must survive, or sharing a filtered view would drop the scope it was filtered in.
    sp.delete("filter");
    sp.delete("view");
    sp.delete("segment");
    sp.delete("q");
    sp.delete("sort");
    for (const f of builderFilters) sp.append("filter", `${f.field}:${f.op}:${f.value}`);
    if (savedId) sp.set("view", savedId);
    // Defaults stay out of the address bar: a param is worth writing only where it
    // changes what the recipient sees. A saved view already names its own segment.
    if (!savedId && segmentId !== (segments?.[0]?.id ?? "all")) sp.set("segment", segmentId);
    if (search.trim()) sp.set("q", search.trim());
    const sort = sorting[0];
    const fallback = initialSort[0];
    if (sort && (sort.id !== fallback?.id || sort.desc !== fallback?.desc)) {
      sp.set("sort", `${sort.id}:${sort.desc ? "desc" : "asc"}`);
    }
    const next = `${url.pathname}${sp.toString() ? `?${sp.toString()}` : ""}${url.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, "", next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlStateKey, urlAdopted]);

  /**
   * On a cold load: honour `?view=` from a shared link, else the operator's own default
   * view. Runs once, the first time views are available — re-running would drag the
   * operator back to their default every time the list reloaded them.
   *
   * A URL that already carries `filter=` wins over a default view: the link was sent to
   * show something specific, and silently replacing it with someone's saved default is
   * how a shared link stops meaning what its sender saw.
   */
  const openedRef = React.useRef(false);
  React.useEffect(() => {
    if (openedRef.current || !savedViews || viewsApi.loading) return;
    openedRef.current = true;
    const wanted = readUrlState().view;
    const target = wanted
      ? views.find((v) => v.id === wanted)
      : (initialFilters ?? []).length > 0
        ? undefined
        : views.find((v) => v.is_default);
    if (target) applySavedView(target);
    // A view carries its own search and sort, so re-apply the link's AFTER it: an
    // explicit `?sort=` in a URL is the sender being specific, exactly as `filter=`
    // outranks a default view above.
    applyUrlState();
  }, [savedViews, viewsApi.loading, views, initialFilters, applySavedView, applyUrlState]);

  /**
   * The same adoption on mount, because the effect above returns early on a list with
   * no saved views (most of them) and while the views are still loading — so
   * `?segment=`/`?q=`/`?sort=` would otherwise never be read.
   *
   * Its own ref, NOT `openedRef`: sharing one would let this effect claim the flag
   * during `viewsApi.loading` and permanently suppress the operator's default view.
   * `applyUrlState` is idempotent, so running in both places is free.
   */
  const urlAppliedRef = React.useRef(false);
  React.useEffect(() => {
    if (urlAppliedRef.current) return;
    urlAppliedRef.current = true;
    applyUrlState();
    setUrlAdopted(true);
  }, [applyUrlState]);

  // ── Filter builder ──
  const newRow = React.useCallback((): FilterRow => {
    const field = fields[0];
    return {
      key: nextKey(),
      field: field?.id ?? "",
      op: operatorsFor(field, isServer)[0]!.id,
      value: "",
    };
  }, [fields, isServer, nextKey]);

  const openFilters = () => {
    setDraft(applied.length > 0 ? applied.map((r) => ({ ...r })) : [newRow()]);
    setFilterOpen(true);
  };

  const applyFilters = () => {
    // Drop rows the operator can't use (no value, and not a unary operator).
    setApplied(draft.filter((r) => rowIsUsable(r, fieldsById[r.field], isServer)));
    setFilterOpen(false);
  };

  const clearAll = () => {
    setApplied([]);
    setDraft([]);
    setFilterOpen(false);
  };

  // ── View state + dirtiness ──
  const trackColumns = !!savedViews && columnChooser;
  const currentState = React.useMemo<ViewState>(
    () => ({
      filters: builderFilters,
      search,
      sort: sorting[0] ? { field: sorting[0].id, desc: sorting[0].desc } : null,
      hiddenColumns: trackColumns ? hidden : null,
    }),
    [builderFilters, search, sorting, hidden, trackColumns],
  );
  const dirty = React.useMemo(() => {
    if (!selectedView) return builderFilters.length > 0 || search.trim() !== "";
    return (
      viewStateKey(currentState) !==
      savedViewStateKey(selectedView, trackColumns && !!selectedView.hidden_columns)
    );
  }, [selectedView, currentState, builderFilters, search, trackColumns]);

  const segment = segments?.find((s) => s.id === segmentId);
  const viewLabel = selectedView?.name ?? segment?.label ?? `All ${entity.plural}`;
  const filterCount = applied.length;

  const systemSegments = React.useMemo(
    () => (segments ?? []).map((s) => ({ id: s.id, label: s.label })),
    [segments],
  );

  const saveButton =
    savedViews && dirty ? (
      <div className="flex items-center gap-1">
        {selectedView ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-primary"
            onClick={() =>
              void viewsApi.saveOver(
                selectedView.id,
                currentState,
                trackColumns && !!selectedView.hidden_columns,
              )
            }
          >
            Update “{selectedView.name}”
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="text-primary"
          onClick={() => setSaveOpen(true)}
        >
          <BookmarkPlus className="size-3.5" />
          {selectedView ? "Save as new view" : "Save view"}
        </Button>
      </div>
    ) : null;

  // Refresh, Import and Create: header-right with a page header, else the toolbar's end.
  const topActions =
    server || importAction || importSlot || createAction || createSlot ? (
      <>
        {/* Server mode only: it is the one mode with a `fetchPage` to re-run, so the
            control cannot appear on a list it could not actually reload. */}
        {server ? (
          <RefreshButton
            key="refresh"
            onRefresh={refreshRows}
            pending={loading}
            variant={page ? "outline" : "ghost"}
          />
        ) : null}
        {/* An import that isn't set up is hidden, not shown disabled. */}
        {importAction && !importAction.disabled ? (
          <ActionButton key="import-action" action={importAction} variant="outline" />
        ) : null}
        {importSlot ? <React.Fragment key="import-slot">{importSlot}</React.Fragment> : null}
        {createAction ? (
          <ActionButton key="create-action" action={createAction} variant="default" />
        ) : null}
        {createSlot ? <React.Fragment key="create-slot">{createSlot}</React.Fragment> : null}
      </>
    ) : null;

  const toolbarLead = (
    <>
      {segments && segments.length > 0 ? (
        <ViewsMenu
          label={viewLabel}
          systemSegments={systemSegments}
          views={views}
          selectedId={savedId ?? segmentId}
          loading={viewsApi.loading}
          error={savedViews ? viewsApi.error : null}
          onSelect={selectView}
          onManage={() => setManageOpen(true)}
        />
      ) : null}

      {fields.length > 0 ? (
        <Button
          variant={filterCount > 0 ? "secondary" : "outline"}
          size="sm"
          onClick={() => (filterOpen ? setFilterOpen(false) : openFilters())}
          aria-expanded={filterOpen}
          className={cn(filterCount > 0 && "border border-primary/30 text-primary")}
        >
          <SlidersHorizontal className="size-3.5" />
          {filterCount > 0 ? `${filterCount} Filter${filterCount > 1 ? "s" : ""}` : "Filter list"}
        </Button>
      ) : null}

      {filterCount > 0 ? (
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={clearAll}>
          <X className="size-3.5" /> Clear filters
        </Button>
      ) : null}

      {saveButton}
      {topBarExtras}
    </>
  );

  // The narrowing in words, always visible. A bare count tells an operator the list is
  // filtered but not by WHAT, which is how somebody concludes rows are missing.
  const toolbarBelow = (
    <>
      <AppliedFilterPills
        applied={applied}
        fieldsById={fieldsById}
        server={isServer}
        onRemove={(key) => {
          setApplied((prev) => prev.filter((r) => r.key !== key));
          setDraft((prev) => prev.filter((r) => r.key !== key));
        }}
      />

      {filterOpen ? (
        <FilterBuilder
          fields={fields}
          draft={draft}
          onDraftChange={setDraft}
          onApply={applyFilters}
          onDiscard={() => {
            setDraft(applied.map((r) => ({ ...r })));
            setFilterOpen(false);
          }}
          server={isServer}
          tz={tz}
          nextKey={nextKey}
        />
      ) : null}
    </>
  );

  // Infinite-scroll footer: the sentinel does the work, the button is the
  // keyboard/no-observer path, and a failed page says so instead of just stopping.
  const serverFooter = server ? (
    <div className="flex items-center gap-3">
      {loadError ? (
        <span className="text-destructive">
          We could not load more rows: {loadError}{" "}
          <button type="button" className="underline" onClick={loadMore}>
            retry
          </button>
        </span>
      ) : hasMore ? (
        <>
          <div ref={sentinel} aria-hidden className="size-px" />
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loading}>
            {loading ? "Loading…" : `Load more`}
          </Button>
        </>
      ) : (
        <span>All {total.toLocaleString("en")} loaded</span>
      )}
    </div>
  ) : undefined;

  return (
    <>
      {page ? (
        <PageHeader
          title={page.title}
          count={countText}
          description={page.description}
          breadcrumbs={page.breadcrumbs}
          actions={
            page.actions || topActions ? (
              <>
                {page.actions}
                {topActions}
              </>
            ) : undefined
          }
        />
      ) : null}
      {page?.notice}
      <DataTable
        toolbarLead={toolbarLead}
        toolbarBelow={toolbarBelow}
        toolbarEnd={page ? undefined : topActions}
        onCountText={page ? setCountText : undefined}
        columns={columns}
        data={rows}
        countLabel={entity.plural}
        searchPlaceholder={searchPlaceholder ?? `Search for ID / Name…`}
        searchable={searchable}
        exportName={exportName}
        columnChooser={columnChooser}
        initialHidden={initialHidden}
        persistKey={persistKey}
        enableSelection={enableSelection}
        bulkActions={bulkActions}
        toolbarExtras={toolbarExtras}
        searchHint={searchHint}
        onRowHref={rowHref}
        rowMenu={rowMenu}
        sortOptions={sortOptions}
        pageSize={pageSize}
        emptyState={emptyStateWithCreate}
        // Client mode: the table owns sorting, so it needs the default too.
        defaultSort={defaultSort}
        searchDebounceMs={searchDebounceMs ?? (server ? 350 : 250)}
        onHiddenChange={trackColumns ? setHidden : undefined}
        applyHidden={applyHidden}
        manual={
          server
            ? {
                total,
                totalCapped,
                search,
                onSearchChange: setSearch,
                sorting,
                onSortingChange: setSorting,
                footer: serverFooter,
                loading,
                exportAll: (cap, onProgress) =>
                  fetchAllPages(
                    (c) => fetchPageRef.current!({ ...query, cursor: c, limit: EXPORT_PAGE_SIZE }),
                    cap,
                    onProgress,
                  ),
              }
            : undefined
        }
      />

      {savedViews ? (
        <>
          <SaveViewDialog
            open={saveOpen}
            onOpenChange={setSaveOpen}
            entityPlural={entity.plural}
            trackColumns={trackColumns}
            onSave={async (d: ViewDraft) => {
              const res = await viewsApi.create(currentState, d);
              // Land the operator IN the view they just saved, so the label matches the
              // rows and a second edit updates it rather than saving a near-duplicate.
              if (res.ok && res.view) setSavedId(res.view.id);
              return res;
            }}
          />
          <ManageViewsDialog
            open={manageOpen}
            onOpenChange={setManageOpen}
            views={views}
            onRename={(id, name) => viewsApi.patch(id, { name })}
            onVisibility={(id, visibility) => viewsApi.patch(id, { visibility })}
            onDefault={(id, is_default) => viewsApi.patch(id, { is_default })}
            onDuplicate={(id) => viewsApi.duplicate(id)}
            onDelete={async (id) => {
              const res = await viewsApi.remove(id);
              // Deleting the view you are looking at leaves the label naming something
              // that no longer exists; fall back to the list's default view.
              if (res.ok && id === savedId) {
                setSavedId(null);
                setApplied([]);
                setSearch("");
              }
              return res;
            }}
          />
        </>
      ) : null}
    </>
  );
}

function ActionButton({ action, variant }: { action: ListAction; variant: "default" | "outline" }) {
  const content = (
    <>
      {action.icon}
      {action.label}
    </>
  );
  if (action.href && !action.disabled) {
    return (
      <Button asChild size="sm" variant={variant} title={action.title}>
        <Link href={action.href}>{content}</Link>
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant={variant}
      onClick={action.onClick}
      disabled={action.disabled}
      title={action.title}
    >
      {content}
    </Button>
  );
}

/** Convenience: the `+ Create <Thing>` action with its icon + wording. */
export function createAction(singular: string, href: string): ListAction {
  return { label: `Create ${singular}`, href, icon: <Plus className="size-4" /> };
}

/** Convenience: the `Import <Things>` action. */
export function importAction(plural: string, href?: string, title?: string): ListAction {
  return {
    label: `Import ${plural}`,
    href,
    icon: <Upload className="size-4" />,
    disabled: !href,
    title: href ? title : (title ?? "Import is not configured"),
  };
}
