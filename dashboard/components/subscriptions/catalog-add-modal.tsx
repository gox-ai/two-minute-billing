"use client";

import * as React from "react";
import { ChevronLeft, Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { money } from "@/lib/format";
import type { Price, Product } from "@/lib/api";

/**
 * A two-step "add a catalog item" flow, as one button:
 *   1. search the PRODUCTS of one kind (plan / addon / charge)
 *   2. configure the pick — currency, then billing frequency — which resolves the
 *      actual PRICE that gets attached.
 *
 * Shared by the create and change takeovers. The change form used to use a
 * one-step price list (`CatalogItemModal`) while create used this flow, so the same
 * action looked like two different features depending on which page you were on.
 *
 * All catalog POLICY stays with the caller: it passes the candidate products and,
 * per product, the prices that are legal to attach (currency lock, cadence fit,
 * plan applicability). This component only picks among what it is given — which is
 * why the currency step disappears when there is nothing to choose (on a change,
 * the subscription's currency is already fixed).
 *
 * ── TWO MODES ───────────────────────────────────────────────────────────────────
 * UNCONTROLLED (omit `open`) — the component renders its own "+ Add …" link and owns
 * the flow. This is the ADD path, unchanged.
 *
 * CONTROLLED (pass `open` + `onOpenChange`) — no trigger is rendered and the caller
 * decides when the flow is up. This is what the CHANGE paths use (plan `Change Plan` /
 * `Change Frequency`, add-on `Edit`): they used to swap the row's item cell for a flat
 * unsorted Radix `Select` of every price — 72 options on the plan row, with the
 * trigger clipping the price mid-value — while the add path two rows below used this
 * searchable modal for the same job, so the more dangerous operation had the worse
 * picker. One mechanism now.
 *
 * `startAt` opens straight on step 2 for a product the caller already knows (a
 * frequency change is "same product, other cadence" — step 1 would be a one-row
 * search), with the current price's currency + cadence preselected so the dialog
 * previews where the line stands before it is moved. The Back arrow still reaches the
 * catalog, so `Change Frequency` remains a superset of itself.
 */
export function CatalogAddModal({
  label,
  products,
  pricesFor,
  productById,
  onAdd,
  searchPlaceholder,
  effectiveAmountMinor,
  open,
  onOpenChange,
  confirmLabel,
  startAt,
}: {
  /** Link text and dialog title — "Add Plan" / "Add Recurring Addon" / "Add Charge". */
  label: string;
  /** Candidate products, already filtered to the right kind + applicability. */
  products: Product[];
  /** The prices of `product` that may legally be attached, already filtered. */
  pricesFor: (productId: string) => Price[];
  productById: Map<string, Product>;
  onAdd: (priceId: string) => void;
  searchPlaceholder?: string;
  /**
   * The amount this price will ACTUALLY be billed at, in minor units — the caller's own
   * resolver, so the dialog and the line it creates cannot disagree.
   *
   * Without it the dialog priced straight off `price.amount_minor`, which for a
   * differential add-on is the CATALOG list price — and a differential's list price is
   * legitimately 0. So the frequency picker offered "1 month · INR ₹0.00" for the
   * connections add-on and then the line it added showed ₹752.00. A price preview that
   * lies is worse than no preview.
   * Optional: callers with no differentials in play can omit it and keep list pricing.
   */
  effectiveAmountMinor?: (price: Price) => number | null;
  /** Present ⇒ CONTROLLED: no trigger link, the caller owns when the flow is open. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Primary button — "Add" (default) for an add, "Change" for a price change. */
  confirmLabel?: string;
  /** Skip the search and configure this product directly (see the note above). */
  startAt?: { product: Product; priceId?: string };
}) {
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [product, setProduct] = React.useState<Product | null>(null);
  const [currency, setCurrency] = React.useState("");
  const [interval, setInterval] = React.useState("");
  const controlled = open !== undefined;

  const candidates = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
    );
  }, [products, query]);

  const productPrices = product ? pricesFor(product.id) : [];
  const currencies = [...new Set(productPrices.map((p) => p.currency))];
  const intervalKey = (p: Price) => `${p.interval_count ?? 1}:${p.interval ?? "one_time"}`;
  const intervals = [
    ...new Map(
      productPrices
        .filter((p) => !currency || p.currency === currency)
        .map((p) => [intervalKey(p), p]),
    ).values(),
  ];
  const resolved = productPrices.find(
    (p) => (!currency || p.currency === currency) && (!interval || intervalKey(p) === interval),
  );

  /**
   * `currentPriceId` — where the line already stands. Its currency and cadence are
   * preselected so a change dialog opens showing the line's own price rather than an
   * empty "Choose", which is the difference between "move this line" and "pick from
   * scratch". Absent (the add path) the old rule stands: preselect only what there is
   * no choice about, because a select with one option is not a decision — the currency
   * step disappears entirely on a fixed-currency page.
   */
  const openConfig = (next: Product, currentPriceId?: string) => {
    const nextPrices = pricesFor(next.id);
    const nextCurrencies = [...new Set(nextPrices.map((p) => p.currency))];
    const current = currentPriceId ? nextPrices.find((p) => p.id === currentPriceId) : undefined;
    const only = current?.currency ?? (nextCurrencies.length === 1 ? nextCurrencies[0] : "");
    const nextIntervals = [
      ...new Set(nextPrices.filter((p) => !only || p.currency === only).map((p) => intervalKey(p))),
    ];
    setProduct(next);
    setCurrency(only);
    setInterval(
      current ? intervalKey(current) : nextIntervals.length === 1 ? nextIntervals[0] : "",
    );
    setPickerOpen(false);
    setQuery("");
  };

  const reset = () => {
    setProduct(null);
    setCurrency("");
    setInterval("");
  };
  /** Leaving the flow: drop step-2 state, and in controlled mode tell the caller. */
  const close = () => {
    reset();
    if (controlled) onOpenChange?.(false);
  };

  const startProductId = startAt?.product.id;
  const startPriceId = startAt?.priceId;
  // Controlled mode: follow the caller's `open` edge. Keyed on the START IDS rather
  // than the `startAt` object, which is a fresh literal on every parent render — as a
  // dependency it would re-open step 2 on top of a Back-to-catalog the operator just
  // pressed, on every keystroke elsewhere in the form.
  React.useEffect(() => {
    if (!controlled) return;
    if (!open) {
      setPickerOpen(false);
      reset();
      return;
    }
    if (startAt) openConfig(startAt.product, startAt.priceId);
    else {
      setQuery("");
      setPickerOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlled, open, startProductId, startPriceId]);

  return (
    <>
      {controlled ? null : (
        <button
          type="button"
          onClick={() => {
            setQuery("");
            setPickerOpen(true);
          }}
          className="flex items-center gap-1.5 transition-colors hover:text-primary/80"
        >
          <Plus className="size-4" /> {label}
        </button>
      )}

      {/* Step 1 — search the catalog */}
      <Dialog
        open={pickerOpen}
        onOpenChange={(next) => {
          setPickerOpen(next);
          // Dismissed from step 1 (Esc / overlay) without choosing a product: the whole
          // flow is over, so a controlled caller has to hear about it or its own `open`
          // stays true and the dialog can never be reopened.
          if (!next && !product) close();
        }}
      >
        <DialogContent className="gap-0 p-0">
          <DialogHeader className="border-b p-4">
            <DialogTitle>{label}</DialogTitle>
          </DialogHeader>
          <div className="border-b p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder ?? "Search the catalog…"}
                className="pl-8"
                aria-label={searchPlaceholder ?? "Search the catalog"}
              />
            </div>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {candidates.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">No matching catalog items.</p>
            ) : (
              candidates.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => openConfig(p)}
                  className="flex w-full items-center justify-between gap-3 border-b px-4 py-3 text-left text-sm transition-colors last:border-0 hover:bg-muted/50"
                >
                  <span className="truncate font-medium">{p.id}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{p.name}</span>
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Step 2 — configure the pick */}
      <Dialog open={product !== null} onOpenChange={(next) => !next && close()}>
        <DialogContent className="gap-0 p-0">
          <DialogHeader className="border-b p-4">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-7 p-0"
                aria-label="Back to the catalog"
                // `reset()`, not `close()`: stepping back is not leaving the flow, and
                // a controlled caller must not be told the dialog closed.
                onClick={() => {
                  reset();
                  setPickerOpen(true);
                }}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <DialogTitle>Configure &apos;{product?.id}&apos;</DialogTitle>
            </div>
            <DialogDescription>
              {currencies.length > 1
                ? "Select the currency and billing frequency for this item."
                : "Select the billing frequency for this item."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 p-6">
            {/* Only a real choice is offered: on a change the subscription's currency
                is already fixed, so this step would be a one-option select. */}
            {currencies.length > 1 ? (
              <div className="space-y-1.5">
                <span className="text-sm font-medium">Currency</span>
                <SelectField
                  value={currency}
                  onValueChange={(value) => {
                    setCurrency(value);
                    setInterval("");
                  }}
                  ariaLabel="Currency"
                  placeholder="Select"
                  options={currencies.map((c) => ({ value: c, label: c }))}
                />
              </div>
            ) : null}
            <div className="space-y-1.5">
              <span className="text-sm font-medium">Billing frequency</span>
              <SelectField
                value={interval}
                onValueChange={setInterval}
                ariaLabel="Billing frequency"
                placeholder="Select"
                disabled={!currency}
                options={intervals.map((p) => ({
                  value: intervalKey(p),
                  label: (() => {
                    const shown = effectiveAmountMinor?.(p) ?? p.amount_minor ?? 0;
                    const cadence = p.interval
                      ? `${p.interval_count ?? 1} ${p.interval}${(p.interval_count ?? 1) === 1 ? "" : "s"}`
                      : "One-time";
                    return `${cadence} · ${p.currency} ${money(shown, p.currency)}`;
                  })(),
                }))}
              />
            </div>
            {product && productPrices.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {productById.get(product.id)?.name ?? product.id} has no price that you can add
                here.
              </p>
            ) : null}
          </div>
          <div className="flex justify-end gap-2 border-t p-4">
            <Button type="button" variant="outline" onClick={close}>
              Close
            </Button>
            <Button
              type="button"
              disabled={!resolved || !interval}
              onClick={() => {
                if (!resolved) return;
                onAdd(resolved.id);
                close();
              }}
            >
              {confirmLabel ?? "Add"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
