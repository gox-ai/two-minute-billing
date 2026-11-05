"use client";

import * as React from "react";
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
import { makeListSource } from "@/lib/list-source";
import { formatListPrice, tokenTypeLabel } from "@/lib/model-prices";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { tzLabel } from "@/lib/tz";
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
}: {
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
  const close = (o: boolean) => (o ? null : setOpen(null));
  const [now] = React.useState(() => Date.now());
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
      { accessorKey: "provider", header: "Provider", enableSorting: false },
      {
        accessorKey: "model",
        header: "Model",
        enableSorting: false,
        cell: ({ row }) => {
          const r = row.original;
          const gone = r.last_seen_at != null && ref - Date.parse(r.last_seen_at) > STALE_MS;
          return (
            <>
              <div className="font-mono text-sm">{r.model}</div>
              {gone ? (
                <div className="text-xs text-muted-foreground">
                  Not in the source since {fmtDate(r.last_seen_at, tz)}
                </div>
              ) : r.model_name && r.model_name !== r.model ? (
                <div className="text-xs text-muted-foreground">{r.model_name}</div>
              ) : null}
            </>
          );
        },
      },
      {
        id: "token_type",
        header: "Token type",
        enableSorting: false,
        accessorFn: (r) => tokenTypeLabel(r.token_type),
      },
      {
        id: "list_price",
        header: "List price",
        enableSorting: false,
        meta: { align: "right" },
        accessorFn: (r) => formatListPrice(r.unit_amount_decimal, r.currency, r.quantity_divisor),
      },
      {
        id: "cost",
        header: "Your cost",
        enableSorting: false,
        meta: { align: "right" },
        accessorFn: (r) =>
          r.cost
            ? formatListPrice(r.cost.unit_amount_decimal, r.cost.currency, r.cost.quantity_divisor)
            : "",
        cell: ({ row }) => {
          const c = row.original.cost;
          if (!c) return <span className="text-muted-foreground">—</span>;
          return (
            <>
              {formatListPrice(c.unit_amount_decimal, c.currency, c.quantity_divisor)}
              {c.effective_to ? (
                <div className="text-xs text-muted-foreground">
                  Ends {fmtDateTime(c.effective_to, tz)} {tzLabel(tz)}
                </div>
              ) : null}
            </>
          );
        },
      },
      {
        id: "currency",
        header: "Currency",
        enableSorting: false,
        accessorFn: (r) => r.cost?.currency ?? r.currency,
      },
      {
        id: "effective_from",
        header: `Starts (${tzLabel(tz)})`,
        enableSorting: false,
        accessorFn: (r) =>
          r.effective_from ? fmtDateTime(r.effective_from, tz) : "Before we tracked it",
      },
    ],
    [ref, tz],
  );

  const filterFields = React.useMemo<ListFilterField<ModelPriceListRow>[]>(
    () =>
      providers.length
        ? [
            {
              id: "provider",
              label: "Provider",
              type: "select",
              options: providers.map((p) => ({ value: p, label: p })),
              serverOps: ["is"],
            },
          ]
        : [],
    [providers],
  );

  const rowMenu = React.useCallback(
    (r: ModelPriceListRow) => {
      const key: ModelKey = { provider: r.provider, model: r.model, token_type: r.token_type };
      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${r.model} ${r.token_type}`}
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
            {canManage && r.cost && !r.cost.effective_to ? (
              <DropdownMenuItem onSelect={() => setOpen({ kind: "end", cost: r.cost! })}>
                End your cost
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => setOpen({ kind: "history", key })}>
              View history
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    },
    [canManage],
  );

  return (
    <>
      <ListPage
        entity={{ singular: "Price", plural: "Prices" }}
        columns={columns}
        data={rows}
        server={{ total: null, hasMore, nextCursor, fetchPage }}
        filterFields={filterFields}
        initialFilters={initialFilters}
        topBarExtras={
          <>
            <ScopeToggle param="has_cost" on={scope.hasCost} label="With your cost only" />
            <ScopeToggle param="used" on={scope.used} label="Used in the last 35 days" />
          </>
        }
        createSlot={
          canManage ? (
            <Button size="sm" onClick={() => setOpen({ kind: "set", key: null })}>
              Set cost for another model
            </Button>
          ) : undefined
        }
        searchPlaceholder="Search for a model…"
        columnChooser={false}
        sortOptions={[]}
        defaultSort={null}
        rowMenu={rowMenu}
        emptyState={
          <EmptyState
            title="No prices match"
            description="Change the filters, or clear the search."
          />
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
