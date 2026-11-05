"use client";

import * as React from "react";
import { Plus, Search } from "lucide-react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { money } from "@/lib/format";
import type { Price, Product } from "@/lib/api";

/**
 * The "search the catalog" picker — the control behind the `Add Recurring Addon` /
 * `Add Charge` links. The Add Charge takeover has NO ad-hoc amount field: a charge
 * must already exist as a charge-kind catalog item, and you search for it here.
 *
 * Extracted from `subscription-change-form.tsx` (where it was a private
 * `AddonSelectModal`) so the subscription detail page can offer the same picker
 * instead of only free-text entry. `searchPlaceholder` is a prop because the label
 * changes per context ("Search Charges" vs addons).
 */
export function CatalogItemModal({
  title,
  options,
  productById,
  onSelect,
  searchPlaceholder = "Search…",
}: {
  title: string;
  options: Price[];
  productById: Map<string, Product>;
  onSelect: (priceId: string) => void;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");

  const filtered = React.useMemo(() => {
    if (!search.trim()) return options;
    const q = search.toLowerCase();
    return options.filter((p) => {
      const prod = productById.get(p.product);
      return (
        p.id.toLowerCase().includes(q) ||
        p.product.toLowerCase().includes(q) ||
        prod?.name.toLowerCase().includes(q)
      );
    });
  }, [options, productById, search]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 transition-colors hover:text-primary/80"
      >
        <Plus className="size-4" /> {title}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* `size="sm"` (28rem) rather than a bare `max-w-md`, which the base `sm:max-w-lg`
            outranked — so this narrows the dialog to what it always asked for. */}
        <DialogContent size="sm" className="overflow-hidden p-0">
          <DialogHeader className="border-b px-6 pt-6 pb-4">
            <DialogTitle className="text-xl font-bold">{title}</DialogTitle>
          </DialogHeader>
          <div className="border-b p-4">
            <div className="relative">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={searchPlaceholder}
                className="pl-9"
              />
            </div>
          </div>
          <div className="max-h-72 divide-y overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No items match the search
              </div>
            ) : (
              filtered.map((p) => {
                const prod = productById.get(p.product);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      onSelect(p.id);
                      setOpen(false);
                      setSearch("");
                    }}
                    className="flex w-full items-center justify-between p-3.5 text-left text-sm transition-colors hover:bg-muted/50"
                  >
                    <span className="font-mono text-xs text-foreground">{p.id}</span>
                    <span className="text-xs text-muted-foreground">
                      {prod?.name ?? p.product} ({p.currency}{" "}
                      {money(p.amount_minor ?? 0, p.currency)})
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
