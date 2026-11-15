"use client";

import * as React from "react";
import { Check, ChevronDown, ChevronRight, Minus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { money } from "@/lib/format";
import {
  byCadence,
  periodLabel,
  periodOf,
  periodSuffix,
  priceCadence,
  priceLabel,
} from "@/lib/coupon-scope";
import { cn } from "@/lib/utils";
import type { Price, ProductGroup } from "@/lib/api";
import type { BillingPeriod, Product } from "@/lib/api/coupons";

export type ItemKind = "plan" | "addon" | "charge";
export type ConstraintType = "all" | "specific" | "none";

export interface ItemConstraintState {
  item_kind: ItemKind;
  constraint_type: ConstraintType;
  /** Whole products: every price they have, including prices created later. */
  product_ids: string[];
  /** Single prices (one currency and period of a product). */
  price_ids: string[];
  /** API-only limit; the form shows it and can remove it, but does not set it. */
  billing_periods: BillingPeriod[];
}

const KIND_PLURAL: Record<ItemKind, string> = {
  plan: "Plans",
  addon: "Add-ons",
  charge: "One-time products",
};
// Literal labels (not templates): the dashboard map reads them for the assistant.
const SCOPE_OPTIONS: Record<ItemKind, Array<{ value: ConstraintType; label: string }>> = {
  plan: [
    { value: "none", label: "No plans" },
    { value: "all", label: "All plans" },
    { value: "specific", label: "Specific plans" },
  ],
  addon: [
    { value: "none", label: "No add-ons" },
    { value: "all", label: "All add-ons" },
    { value: "specific", label: "Specific add-ons" },
  ],
  charge: [
    { value: "none", label: "No one-time products" },
    { value: "all", label: "All one-time products" },
    { value: "specific", label: "Specific one-time products" },
  ],
};
const PICK_LABEL: Record<ItemKind, { label: string }> = {
  plan: { label: "Select plans or prices" },
  addon: { label: "Select add-ons or prices" },
  charge: { label: "Select one-time products or prices" },
};
/** "USD yearly" — the short form for chips. */
const shortCadence = (p: Price) => {
  const per = periodOf(p);
  return `${p.currency.toUpperCase()} ${per ? periodLabel(per).toLowerCase() : "one-time"}`;
};

type Update = (
  wholeChanges: ReadonlyArray<readonly [string, boolean]>,
  priceChanges?: ReadonlyArray<readonly [string, string, boolean]>,
) => void;

/** Every word of the query appears in the text. */
const matches = (text: string, words: string[]) => {
  const t = text.toLowerCase();
  return words.every((w) => t.includes(w));
};

/** The look of a checkbox, for a row inside a list (the row itself is the control). */
function Tick({ state }: { state: boolean | "indeterminate" }) {
  return (
    <span
      aria-hidden
      className={cn(
        // 4px, like `ui/checkbox`: on a 16px box the 8px control radius reads as a disc.
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
        state ? "border-solid bg-solid text-solid-foreground" : "border-input bg-card",
      )}
    >
      {state === true ? (
        <Check className="size-3 text-solid-foreground" />
      ) : state === "indeterminate" ? (
        <Minus className="size-3 text-solid-foreground" />
      ) : null}
    </span>
  );
}

/**
 * One item kind of an `each_specified_item` coupon. "Specific" is a searchable multi-select:
 * products grouped by product group, each one expanding to its prices. A product row takes
 * the whole product (`product_ids`, new prices too); a price row takes one price
 * (`price_ids`). Stateless: the form owns the value.
 */
export function ItemScopeRow({
  constraint: c,
  onChange,
  products,
  prices,
  groups,
}: {
  constraint: ItemConstraintState;
  onChange: (patch: Partial<ItemConstraintState>) => void;
  /** Every product of this kind. */
  products: Product[];
  prices: Price[];
  groups: ProductGroup[];
}) {
  const kind = c.item_kind;
  const plural = KIND_PLURAL[kind];
  const lower = plural.toLowerCase();
  const one = kind === "charge" ? "one-time product" : kind;

  const productIds = React.useMemo(() => new Set(products.map((p) => p.id)), [products]);
  const pricesByProduct = React.useMemo(() => {
    const m = new Map<string, Price[]>();
    for (const pr of prices) {
      if (pr.active === false || !productIds.has(pr.product)) continue;
      m.set(pr.product, [...(m.get(pr.product) ?? []), pr]);
    }
    for (const list of m.values()) list.sort(byCadence);
    return m;
  }, [prices, productIds]);

  const wholeSet = new Set(c.product_ids);
  const priceSet = new Set(c.price_ids);
  const stateOf = (id: string): boolean | "indeterminate" =>
    wholeSet.has(id)
      ? true
      : (pricesByProduct.get(id) ?? []).some((x) => priceSet.has(x.id))
        ? "indeterminate"
        : false;

  /**
   * One change to the selection, in one `onChange` (two calls would each start from the
   * same stale value). Whole products first: a whole product covers every price, so its
   * single prices are dropped. A whole product that loses one price keeps the others.
   */
  const update: Update = (wholeChanges, priceChanges = []) => {
    const whole = new Set(c.product_ids);
    const single = new Set(c.price_ids);
    for (const [id, on] of wholeChanges) {
      for (const pr of pricesByProduct.get(id) ?? []) single.delete(pr.id);
      if (on) whole.add(id);
      else whole.delete(id);
    }
    for (const [productId, priceId, on] of priceChanges) {
      if (whole.has(productId)) {
        if (on) continue;
        whole.delete(productId);
        for (const pr of pricesByProduct.get(productId) ?? []) single.add(pr.id);
      }
      if (on) single.add(priceId);
      else single.delete(priceId);
    }
    onChange({ product_ids: [...whole], price_ids: [...single] });
  };

  // Stored price ids no listed product shows (archived, or from another catalog).
  const shownPriceIds = new Set([...pricesByProduct.values()].flat().map((p) => p.id));
  const orphanPrices = c.price_ids.filter((id) => !shownPriceIds.has(id));

  return (
    <div className="flex flex-col gap-3 border-b pb-4 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{plural}</span>
        <SelectField
          value={c.constraint_type}
          onValueChange={(x) =>
            onChange({ constraint_type: x as ConstraintType, product_ids: [], price_ids: [] })
          }
          ariaLabel={`${plural} this coupon applies to`}
          className="w-56"
          options={SCOPE_OPTIONS[kind]}
        />
      </div>

      {c.constraint_type === "all" ? (
        <p className="text-sm text-muted-foreground">
          Every {one}
          {periodSuffix(c.billing_periods)}, including {one}s you create later.
        </p>
      ) : null}

      {c.constraint_type === "specific" ? (
        products.length === 0 ? (
          <p className="text-sm text-muted-foreground">There are no {lower} yet.</p>
        ) : (
          <ItemMultiSelect
            plural={plural}
            pickLabel={PICK_LABEL[kind].label}
            one={one}
            products={products}
            groups={groups}
            pricesByProduct={pricesByProduct}
            wholeSet={wholeSet}
            priceSet={priceSet}
            stateOf={stateOf}
            update={update}
          />
        )
      ) : null}

      {c.constraint_type !== "none" && c.billing_periods.length ? (
        <p className="text-sm text-muted-foreground">
          Only {c.billing_periods.map((p) => periodLabel(p).toLowerCase()).join(" or ")} prices get
          the discount. This limit was set through the API.{" "}
          <button
            type="button"
            onClick={() => onChange({ billing_periods: [] })}
            className="text-primary hover:underline"
          >
            Remove the limit
          </button>
        </p>
      ) : null}

      {c.constraint_type === "specific" && orphanPrices.length ? (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
          <span className="text-muted-foreground">
            The coupon also applies to {orphanPrices.length === 1 ? "this price" : "these prices"}:
          </span>
          {orphanPrices.map((id) => (
            <span key={id} className="rounded-md bg-muted px-1.5 py-0.5 text-xs">
              {priceLabel(id, prices, products)}
            </span>
          ))}
          <button
            type="button"
            onClick={() =>
              onChange({ price_ids: c.price_ids.filter((id) => !orphanPrices.includes(id)) })
            }
            className="text-xs text-primary hover:underline"
          >
            Remove {orphanPrices.length === 1 ? "price" : "prices"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ItemMultiSelect({
  plural,
  pickLabel,
  one,
  products,
  groups,
  pricesByProduct,
  wholeSet,
  priceSet,
  stateOf,
  update,
}: {
  plural: string;
  pickLabel: string;
  one: string;
  products: Product[];
  groups: ProductGroup[];
  pricesByProduct: Map<string, Price[]>;
  wholeSet: Set<string>;
  priceSet: Set<string>;
  stateOf: (id: string) => boolean | "indeterminate";
  update: Update;
}) {
  const lower = plural.toLowerCase();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [expanded, setExpanded] = React.useState<Set<string>>(
    () =>
      new Set(
        products
          .filter((p) => (pricesByProduct.get(p.id) ?? []).some((x) => priceSet.has(x.id)))
          .map((p) => p.id),
      ),
  );
  const toggleExpanded = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const groupOf = (p: Product) =>
    p.product_group && groupName.has(p.product_group) ? p.product_group : "";

  // Archived products stay listed only while selected, so a stored scope is never hidden.
  const listed = products.filter(
    (p) =>
      p.active !== false ||
      wholeSet.has(p.id) ||
      (pricesByProduct.get(p.id) ?? []).some((x) => priceSet.has(x.id)),
  );

  // Search: a product that matches shows with all its prices; otherwise only its prices
  // that match ("inr yearly") show, under the product.
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = listed.flatMap((p) => {
    const base = [p.name, p.code, p.id, groupName.get(groupOf(p))].filter(Boolean).join(" ");
    const all = pricesByProduct.get(p.id) ?? [];
    if (!words.length || matches(base, words)) return [{ product: p, prices: all, whole: true }];
    const hit = all.filter((pr) => matches(`${base} ${priceCadence(pr)}`, words));
    return hit.length ? [{ product: p, prices: hit, whole: false }] : [];
  });
  const buckets = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = groupOf(r.product);
    buckets.set(k, [...(buckets.get(k) ?? []), r]);
  }
  const ordered = [...buckets.entries()].sort(([a], [b]) =>
    !a ? 1 : !b ? -1 : (groupName.get(a) ?? a).localeCompare(groupName.get(b) ?? b),
  );

  const selectResults = () =>
    update(
      rows.filter((r) => r.whole).map((r) => [r.product.id, true] as const),
      rows
        .filter((r) => !r.whole)
        .flatMap((r) => r.prices.map((pr) => [r.product.id, pr.id, true] as const)),
    );

  const nWhole = wholeSet.size;
  const nPrices = priceSet.size;
  const summary = [
    nWhole ? `${nWhole} ${nWhole === 1 ? one : `${one}s`}` : null,
    nPrices ? `${nPrices} ${nPrices === 1 ? "price" : "prices"}` : null,
  ]
    .filter(Boolean)
    .join(" and ");

  // One chip per product that has a selection.
  const chips = products.flatMap((p) => {
    const state = stateOf(p.id);
    if (!state) return [];
    const picked = (pricesByProduct.get(p.id) ?? []).filter((x) => priceSet.has(x.id));
    return [
      {
        id: p.id,
        label:
          state === true
            ? `${p.name} · All prices`
            : `${p.name} · ${picked.map(shortCadence).join(", ")}`,
        clear: () =>
          state === true
            ? update([[p.id, false]])
            : update(
                [],
                picked.map((x) => [p.id, x.id, false] as const),
              ),
      },
    ];
  });

  return (
    <div className="flex flex-col gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          aria-label={pickLabel}
          className={cn(
            "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-left text-sm shadow-xs outline-none",
            "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30 hover:dark:bg-input/50",
            !summary && "text-muted-foreground",
          )}
        >
          <span className="truncate">{summary ? `${summary} selected` : pickLabel}</span>
          <ChevronDown className="size-4 shrink-0 opacity-50" aria-hidden />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-72 p-0">
          <Command shouldFilter={false}>
            <CommandInput
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder={`Search ${lower}, currencies or periods`}
            />
            <CommandList className="max-h-80">
              <CommandEmpty>No {lower} or prices match.</CommandEmpty>
              {words.length && rows.length ? (
                <CommandGroup>
                  <CommandItem value="__results__" onSelect={selectResults}>
                    <Check className="text-primary" aria-hidden />
                    <span className="text-primary">Select all results</span>
                  </CommandItem>
                </CommandGroup>
              ) : null}
              {ordered.map(([key, items]) => (
                <CommandGroup key={key || "_"} heading={groupName.get(key) ?? "No product group"}>
                  {items.map(({ product: p, prices: shownPrices }) => {
                    const state = stateOf(p.id);
                    const all = pricesByProduct.get(p.id) ?? [];
                    const isOpen = words.length > 0 || expanded.has(p.id);
                    const picked = all.filter((x) => priceSet.has(x.id)).length;
                    return (
                      <React.Fragment key={p.id}>
                        <CommandItem
                          value={`p:${p.id}`}
                          onSelect={() => update([[p.id, state !== true]])}
                          className="pr-1"
                        >
                          <Tick state={state} />
                          <span className="flex-1 truncate">
                            {p.active === false ? `${p.name} (archived)` : p.name}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {state === true
                              ? "All prices"
                              : picked
                                ? `${picked} of ${all.length}`
                                : all.length
                                  ? `${all.length} ${all.length === 1 ? "price" : "prices"}`
                                  : "No prices"}
                          </span>
                          {all.length && !words.length ? (
                            <button
                              type="button"
                              aria-label={`${isOpen ? "Hide" : "Show"} prices of ${p.name}`}
                              aria-expanded={isOpen}
                              onPointerDown={(e) => e.preventDefault()}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleExpanded(p.id);
                              }}
                              className="flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-muted"
                            >
                              <ChevronRight
                                className={cn("size-4 transition-transform", isOpen && "rotate-90")}
                              />
                            </button>
                          ) : null}
                        </CommandItem>
                        {isOpen
                          ? shownPrices.map((pr) => {
                              const on = state === true || priceSet.has(pr.id);
                              return (
                                <CommandItem
                                  key={pr.id}
                                  value={`r:${pr.id}`}
                                  onSelect={() => update([], [[p.id, pr.id, !on]])}
                                  className="pl-8"
                                >
                                  <Tick state={on} />
                                  <span className="flex-1 truncate">{priceCadence(pr)}</span>
                                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                    {pr.amount_minor != null
                                      ? money(pr.amount_minor, pr.currency)
                                      : "Metered"}
                                  </span>
                                </CommandItem>
                              );
                            })
                          : null}
                      </React.Fragment>
                    );
                  })}
                </CommandGroup>
              ))}
            </CommandList>
            <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
              <span className="text-xs text-muted-foreground">
                {summary ? `${summary} selected` : "Nothing is selected"}
              </span>
              <Button type="button" size="xs" onClick={() => setOpen(false)}>
                Done
              </Button>
            </div>
          </Command>
        </PopoverContent>
      </Popover>

      {chips.length ? (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <span
              key={chip.id}
              className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/50 py-0.5 pr-0.5 pl-2 text-xs"
            >
              <span className="truncate">{chip.label}</span>
              <button
                type="button"
                aria-label={`Remove ${chip.label}`}
                onClick={chip.clear}
                className="flex size-5 shrink-0 items-center justify-center rounded-md hover:bg-muted"
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() =>
              update(
                [...wholeSet].map((id) => [id, false] as const),
                products.flatMap((p) =>
                  (pricesByProduct.get(p.id) ?? [])
                    .filter((x) => priceSet.has(x.id))
                    .map((x) => [p.id, x.id, false] as const),
                ),
              )
            }
            className="px-1 text-xs text-primary hover:underline"
          >
            Clear selection
          </button>
        </div>
      ) : null}
    </div>
  );
}
