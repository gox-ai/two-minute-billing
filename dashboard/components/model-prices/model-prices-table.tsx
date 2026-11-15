"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { type ColumnDef } from "@tanstack/react-table";
import { Check, ChevronDown, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ListPage, type ListFilterField } from "@/components/patterns/list-page";
import { EmptyState } from "@/components/states";
import { useNavPending } from "@/components/navigation/nav-pending";
import {
  EndCostDialog,
  PriceHistorySheet,
  SetCostDialog,
  type ModelKey,
} from "@/components/model-prices/model-price-actions";
import type { ModelCostOverride, ModelPriceListRow } from "@/lib/api/model-prices";
import { unlistedCostsAction } from "@/app/(dashboard)/settings/model-prices/actions";
import { makeListSource } from "@/lib/list-source";
import {
  PRICE_UNITS,
  costRowActions,
  formatListPrice,
  listPriceParts,
  priceTypeLabel,
  priceUnitLabel,
  tokenTypeLabel,
  unlistedCostFilters,
  unlistedCostKey,
  type UnlistedCostFilters,
  type UnlistedCostPage,
} from "@/lib/model-prices";
import { providerName } from "@/lib/model-providers";
import { Capped, Tier } from "@/components/model-prices/tier-text";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MiddleEllipsis } from "@/components/patterns/id-text";
import { SettingsCard } from "@/components/settings/settings-layout";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtDate, fmtDateTime } from "@/lib/format-date";
import { tzLabel } from "@/lib/tz";
import { useDefaultState } from "@/lib/use-default-state";
import { cn } from "@/lib/utils";
import { useDisplayTz } from "@/components/business-tz";

/** A model the source has not listed for this long reads as "Not in the source since …". */
const STALE_MS = 3 * 24 * 60 * 60 * 1000;

/** The page's own URL scope: it narrows the price list and (business) the drift card. */
export interface ModelPriceScope {
  business?: string;
  hasCost: boolean;
  used: boolean;
}

type Open =
  | { kind: "set"; key: ModelKey | null }
  | { kind: "end"; cost: ModelCostOverride }
  | { kind: "history"; key: ModelKey }
  | null;

/**
 * Set or clear one of the page's scope params, keeping everything else in the address bar
 * (the list writes `q` and `filter=` there itself). The server re-renders with the new scope.
 */
function useScopeNav() {
  const { navigate, pendingFrom } = useNavPending();
  const go = React.useCallback(
    (key: string, value: string | null) => {
      const url = new URL(window.location.href);
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
      navigate(`${url.pathname}${url.search}`, { source: `model-prices:${key}` });
    },
    [navigate],
  );
  return { go, pending: (key: string) => pendingFrom(`model-prices:${key}`) };
}

/** A toolbar toggle for a one-way API flag; styled like the list's active "Filter list". */
function ScopeToggle({ param, on, label }: { param: string; on: boolean; label: string }) {
  const { go, pending } = useScopeNav();
  return (
    <Button
      variant={on ? "secondary" : "outline"}
      size="sm"
      aria-pressed={on}
      disabled={pending(param)}
      onClick={() => go(param, on ? null : "on")}
      className={cn(on && "border border-primary/30 text-primary")}
    >
      {on ? <Check className="size-3.5" /> : null}
      {label}
    </Button>
  );
}

/** Header-right business scope: the price list and the drift card follow it. */
export function BusinessScopePicker({
  value,
  businesses,
}: {
  value?: string;
  businesses: { id: string; name: string }[];
}) {
  const { go, pending } = useScopeNav();
  const current = businesses.find((b) => b.id === value);
  const options = [{ id: "", name: "All businesses" }, ...businesses];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" aria-label="Business" disabled={pending("business")}>
          {value ? (current?.name ?? value) : "All businesses"}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {options.map((b) => (
          <DropdownMenuItem
            key={b.id || "all"}
            onSelect={() => go("business", b.id || null)}
            className="justify-between"
          >
            {b.name}
            {(value ?? "") === b.id ? <Check className="size-3.5" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type PriceKey = { token_type: string; quality?: string | null; resolution?: string | null };

/** "Output", with its tier ("hd · 1024x1024") on a second line: rows that differ in the tier read apart. */
function TypeCell({ r, className }: { r: PriceKey; className: string }) {
  return (
    <>
      <Capped className={className} text={tokenTypeLabel(r.token_type)} />
      {r.quality || r.resolution ? (
        <Capped
          className={cn(className, "text-xs text-muted-foreground")}
          text={<Tier quality={r.quality} resolution={r.resolution} />}
        />
      ) : null}
    </>
  );
}

/**
 * "$0.75 per second of video" on one line while it fits 160px; a longer price puts "per …" on
 * the next line, so the cell never passes that width.
 */
function PriceText({ p, className }: { p: { amount: string; per: string }; className?: string }) {
  return (
    <div className={cn("flex max-w-40 flex-wrap items-baseline gap-x-1", className)}>
      <span>{p.amount}</span>
      <span className="text-xs text-muted-foreground">{p.per}</span>
    </div>
  );
}

/** "Starts 13 Nov 2026, 08:20": the zone is in the tooltip, to keep the line short. */
function TimeLine({ label, iso, tz }: { label: string; iso: string; tz: string }) {
  const text = `${label} ${fmtDateTime(iso, tz)}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="text-xs text-muted-foreground">{text}</div>
      </TooltipTrigger>
      <TooltipContent>
        {text} {tzLabel(tz)}
      </TooltipContent>
    </Tooltip>
  );
}

// A price is right-aligned in the table and left-aligned in a stacked row.
const PRICE_ALIGN = "justify-end list-narrow:max-w-none list-narrow:justify-start";

// Caps of the price list's cells: narrower in a card under 960px (a 1280px window).
const PROVIDER_CAP = "max-w-24 @min-[60rem]/list:max-w-32";
// The Model column's floor (what the fit arithmetic counts). Its content fills the width the
// column really gets and adds nothing to it: `w-0 min-w-full`.
const MODEL_MIN = "min-w-40 @min-[60rem]/list:min-w-60";
const MODEL_FILL = "w-0 min-w-full";
const TYPE_CAP = "max-w-36 @min-[60rem]/list:max-w-44";

// The row menu stays in view while a narrow card scrolls; the ground is opaque (as in DataTable).
const STICKY_MENU =
  "w-px pr-5 sm:sticky sm:right-0 sm:z-10 bg-card shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.12)]";

type UnlistedCosts = UnlistedCostPage<ModelCostOverride> & { key: string };

/**
 * "Your costs with no list price": one page at a time, narrowed by the price list's search and
 * its provider and unit filters (read from the address bar, where the list keeps them).
 */
function UnlistedCostsCard({
  initial,
  want,
  now,
  tz,
  keyMenu,
}: {
  initial: UnlistedCosts;
  /** The list's settled search and filters. */
  want: UnlistedCostFilters;
  now: number;
  tz: string;
  keyMenu: (key: ModelKey, endable: ModelCostOverride | null) => React.ReactNode;
}) {
  const wantKey = unlistedCostKey(want);
  // A server render (after a save) replaces what this card read itself.
  const [loaded, setLoaded] = useDefaultState(initial);
  const [more, startMore] = React.useTransition();

  React.useEffect(() => {
    if (loaded.key === wantKey) return;
    let live = true;
    unlistedCostsAction(want).then((r) => {
      if (live && r.ok) setLoaded({ rows: r.rows, nextCursor: r.nextCursor, key: wantKey });
    });
    return () => {
      live = false;
    };
    // `want` is `wantKey` as an object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantKey, loaded.key]);

  const showMore = () =>
    startMore(async () => {
      const r = await unlistedCostsAction({ ...want, starting_after: loaded.nextCursor });
      if (!r.ok) return;
      setLoaded((cur) =>
        cur.key === wantKey
          ? { rows: [...cur.rows, ...r.rows], nextCursor: r.nextCursor, key: cur.key }
          : cur,
      );
    });

  // Rows read with other filters are not shown as the answer to these.
  const rows = loaded.key === wantKey ? loaded.rows : [];
  if (!rows.length) return null;
  return (
    <SettingsCard
      title="Your costs with no list price"
      footer={
        loaded.nextCursor ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-muted-foreground">
              The first {rows.length.toLocaleString("en-US")} costs are shown.
            </span>
            <Button variant="outline" size="sm" disabled={more} onClick={showMore}>
              Show more
            </Button>
          </div>
        ) : undefined
      }
    >
      <p className="m-0 px-5 py-4 text-sm text-muted-foreground">
        The price list has no price for these models, qualities or resolutions. We use your cost for
        them. To delete a cost that has not started, view its history. The search and the Provider
        and Unit filters of the price list apply to these costs too.
      </p>
      {/* Widest row at a 908px card (a 1280px window): 256 + 216 + 184 + 174 + 60 = 890. */}
      <Table phone="stack">
        <TableHeader>
          <TableRow>
            <TableHead className="pl-5">Model</TableHead>
            <TableHead>Price type</TableHead>
            <TableHead className="text-right">Your cost</TableHead>
            <TableHead>Starts ({tzLabel(tz)})</TableHead>
            {/* On a phone the menu is opposite the title, as in other stacked lists. */}
            <TableHead
              phone="aside"
              className={cn(STICKY_MENU, "bg-linear-to-r from-muted/40 to-muted/40")}
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((c) => (
            <TableRow key={c.id} className="group/row">
              <TableCell className="pl-5">
                <div className="max-w-56">
                  <MiddleEllipsis value={c.model} className="text-sm" />
                </div>
                {c.provider ? (
                  <Capped
                    className="max-w-56 text-xs text-muted-foreground"
                    text={providerName(c.provider)}
                  />
                ) : null}
              </TableCell>
              <TableCell>
                <TypeCell r={c} className="max-w-48 max-sm:max-w-none" />
              </TableCell>
              <TableCell className="text-right">
                <PriceText
                  className="ms-auto justify-end max-sm:ms-0 max-sm:max-w-none max-sm:justify-start"
                  p={listPriceParts(
                    c.unit_amount_decimal,
                    c.currency,
                    c.quantity_divisor,
                    c.unit ?? "token",
                  )!}
                />
              </TableCell>
              <TableCell>
                {fmtDateTime(c.effective_from, tz)}
                <div className="text-xs text-muted-foreground">
                  {c.effective_to ? `Ends ${fmtDateTime(c.effective_to, tz)}` : "No end"}
                </div>
              </TableCell>
              <TableCell
                className={cn(
                  STICKY_MENU,
                  "text-right group-hover/row:bg-linear-to-r group-hover/row:from-muted/50 group-hover/row:to-muted/50",
                )}
              >
                {keyMenu(
                  {
                    provider: c.provider,
                    model: c.model,
                    token_type: c.token_type,
                    unit: c.unit ?? "token",
                    quality: c.quality ?? null,
                    resolution: c.resolution ?? null,
                  },
                  costRowActions(c, now).canEnd ? c : null,
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SettingsCard>
  );
}

/** Settings → Model prices list. Rows come from `GET /v1/organization/model_prices`. */
export function ModelPricesTable({
  rows,
  hasMore,
  nextCursor,
  pageSize,
  scope,
  providers,
  initialFilters,
  canManage,
  currencies,
  sourceSuccessAt,
  unlistedCosts,
  loadedAt,
}: {
  /** When the server read the rows (ms): what "ended" and "left the source" compare with. */
  loadedAt: number;
  /**
   * Your cost rows whose key is not on the list: shown in their own card, with the same
   * actions. The first page, and the filters (`key`) it was read with.
   */
  unlistedCosts: UnlistedCosts;
  rows: ModelPriceListRow[];
  hasMore: boolean;
  nextCursor: string | null;
  /** Rows per page: the server-rendered page and every "Load more" use the same size. */
  pageSize: number;
  scope: ModelPriceScope;
  /** Providers in the list; empty hides the provider filter. */
  providers: string[];
  /** `filter=` from the URL (urlFilters). */
  initialFilters?: { field: string; op: string; value: string }[];
  canManage: boolean;
  currencies: string[];
  /** The last successful sync; a model unseen well before it has left the source. */
  sourceSuccessAt: string | null;
}) {
  const [open, setOpen] = React.useState<Open>(null);
  const urlParams = useSearchParams();
  // The list's search and filters: from the address on load, then as the list reports them
  // (it writes the address with `replaceState`, which `useSearchParams` does not follow).
  const [listQuery, setListQuery] = React.useState(() => ({
    q: urlParams.get("q") ?? "",
    filters: urlParams.getAll("filter"),
  }));
  const onQueryChange = React.useCallback(
    (q: { search?: string; filters: { field: string; op: string; value: string }[] }) =>
      setListQuery({
        q: q.search ?? "",
        filters: q.filters.map((f) => `${f.field}:${f.op}:${f.value}`),
      }),
    [],
  );
  const narrowed =
    scope.hasCost || scope.used || !!listQuery.q.trim() || listQuery.filters.length > 0;
  const close = (o: boolean) => (o ? null : setOpen(null));
  const now = loadedAt;
  const ref = sourceSuccessAt ? Date.parse(sourceSuccessAt) : now;
  // The zone cost times are entered in (see `InstantInput`), so a list and its form agree.
  const tz = useDisplayTz();

  const fetchPage = React.useMemo(
    () =>
      makeListSource<ModelPriceListRow>("model_prices", undefined, {
        pageSize,
        params: {
          business: scope.business,
          has_cost: scope.hasCost ? "on" : undefined,
          used: scope.used ? "on" : undefined,
        },
      }),
    [pageSize, scope.business, scope.hasCost, scope.used],
  );

  const columns = React.useMemo<ColumnDef<ModelPriceListRow>[]>(
    () => [
      {
        accessorKey: "provider",
        header: "Provider",
        enableSorting: false,
        cell: ({ row }) => (
          <Capped className={PROVIDER_CAP} text={providerName(row.original.provider)} />
        ),
      },
      {
        accessorKey: "model",
        header: "Model",
        enableSorting: false,
        // The one column that gives way: a long model id shortens, the rest keep their width.
        meta: { grow: true },
        cell: ({ row }) => {
          const r = row.original;
          const gone = r.last_seen_at != null && ref - Date.parse(r.last_seen_at) > STALE_MS;
          return (
            <div className={MODEL_MIN}>
              <div className={MODEL_FILL}>
                <MiddleEllipsis value={r.model} className="text-sm" />
              </div>
              {gone ? (
                <div className={cn(MODEL_FILL, "text-xs whitespace-normal text-muted-foreground")}>
                  Not in the source since {fmtDate(r.last_seen_at, tz)}
                </div>
              ) : r.model_name && r.model_name !== r.model ? (
                <div className={cn(MODEL_FILL, "truncate text-xs text-muted-foreground")}>
                  {r.model_name}
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "token_type",
        header: "Price type",
        enableSorting: false,
        accessorFn: (r) => priceTypeLabel(r),
        cell: ({ row }) => <TypeCell r={row.original} className={TYPE_CAP} />,
      },
      {
        id: "list_price",
        header: "List price",
        enableSorting: false,
        meta: { align: "right" },
        accessorFn: (r) =>
          formatListPrice(r.unit_amount_decimal, r.currency, r.quantity_divisor, r.unit ?? "token"),
        // The start is a second line here: as a column of its own the list was too wide.
        cell: ({ row }) => {
          const r = row.original;
          const p = listPriceParts(
            r.unit_amount_decimal,
            r.currency,
            r.quantity_divisor,
            r.unit ?? "token",
          );
          return (
            <>
              {p ? <PriceText p={p} className={PRICE_ALIGN} /> : <div>—</div>}
              {r.effective_from ? (
                <TimeLine label="Starts" iso={r.effective_from} tz={tz} />
              ) : (
                <div className="text-xs text-muted-foreground">Before we tracked it</div>
              )}
            </>
          );
        },
      },
      {
        id: "cost",
        header: "Your cost",
        enableSorting: false,
        meta: { align: "right" },
        accessorFn: (r) =>
          r.cost
            ? formatListPrice(
                r.cost.unit_amount_decimal,
                r.cost.currency,
                r.cost.quantity_divisor,
                r.cost.unit ?? "token",
              )
            : "",
        cell: ({ row }) => {
          const c = row.original.cost;
          const p = c
            ? listPriceParts(
                c.unit_amount_decimal,
                c.currency,
                c.quantity_divisor,
                c.unit ?? "token",
              )
            : null;
          if (!c || !p) return <span className="text-muted-foreground">—</span>;
          return (
            <>
              <PriceText p={p} className={PRICE_ALIGN} />
              {c.effective_to ? <TimeLine label="Ends" iso={c.effective_to} tz={tz} /> : null}
            </>
          );
        },
      },
    ],
    [ref, tz],
  );

  const filterFields = React.useMemo<ListFilterField<ModelPriceListRow>[]>(
    () => [
      ...(providers.length
        ? [
            {
              id: "provider",
              label: "Provider",
              type: "select" as const,
              options: providers.map((p) => ({ value: p, label: providerName(p) })),
              serverOps: ["is" as const],
            },
          ]
        : []),
      {
        id: "unit",
        label: "Unit",
        type: "select" as const,
        options: PRICE_UNITS.map((u) => ({ value: u.value, label: u.label })),
        serverOps: ["is" as const],
      },
    ],
    [providers],
  );

  /** The ⋯ menu of a list row, or of a cost row that has no list row. */
  const keyMenu = React.useCallback(
    (key: ModelKey, endable: ModelCostOverride | null) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${key.model}, ${priceTypeLabel(key)}, ${priceUnitLabel(key.unit)}`}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canManage ? (
            <DropdownMenuItem onSelect={() => setOpen({ kind: "set", key })}>
              Set your cost
            </DropdownMenuItem>
          ) : null}
          {canManage && endable ? (
            <DropdownMenuItem onSelect={() => setOpen({ kind: "end", cost: endable })}>
              End your cost
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => setOpen({ kind: "history", key })}>
            View history
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
    [canManage],
  );

  const rowMenu = React.useCallback(
    (r: ModelPriceListRow) =>
      keyMenu(
        {
          provider: r.provider,
          model: r.model,
          token_type: r.token_type,
          unit: r.unit ?? "token",
          quality: r.quality ?? null,
          resolution: r.resolution ?? null,
        },
        r.cost && !r.cost.effective_to ? r.cost : null,
      ),
    [keyMenu],
  );

  return (
    <>
      <UnlistedCostsCard
        initial={unlistedCosts}
        want={unlistedCostFilters(listQuery.q, listQuery.filters)}
        now={now}
        tz={tz}
        keyMenu={keyMenu}
      />
      <ListPage
        entity={{ singular: "Price", plural: "Prices" }}
        columns={columns}
        data={rows}
        server={{ total: null, hasMore, nextCursor, fetchPage }}
        filterFields={filterFields}
        initialFilters={initialFilters}
        onQueryChange={onQueryChange}
        topBarExtras={
          <>
            <ScopeToggle param="has_cost" on={scope.hasCost} label="With your cost only" />
            <ScopeToggle param="used" on={scope.used} label="Used in the last 35 days" />
          </>
        }
        createSlot={
          canManage ? (
            <Button size="sm" onClick={() => setOpen({ kind: "set", key: null })}>
              Set your cost
            </Button>
          ) : undefined
        }
        searchPlaceholder="Search by model name"
        columnChooser={false}
        sortOptions={[]}
        defaultSort={null}
        rowMenu={rowMenu}
        emptyState={
          narrowed ? (
            <EmptyState
              title="No prices match"
              description="Change the filters, or clear the search."
            />
          ) : (
            <EmptyState
              title="The price list shows here after the first sync"
              description={`We check the public price list every hour.${canManage ? " You can set your own cost for a model now." : ""}`}
            />
          )
        }
      />

      {open?.kind === "set" ? (
        <SetCostDialog open onOpenChange={close} modelKey={open.key} currencies={currencies} />
      ) : null}
      {open?.kind === "end" ? <EndCostDialog open onOpenChange={close} cost={open.cost} /> : null}
      {open?.kind === "history" ? (
        <PriceHistorySheet open onOpenChange={close} modelKey={open.key} canManage={canManage} />
      ) : null}
    </>
  );
}
